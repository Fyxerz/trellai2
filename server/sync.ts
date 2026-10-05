/**
 * Share the board through Postgres databases (Supabase): between your computers, and
 * single projects with other people.
 *
 * Each computer keeps working on its own SQLite file (fast, works offline) and runs
 * agents with its own subscriptions. SQLite triggers record every change in
 * `sync_outbox`; every couple of seconds we push those rows to one generic table in
 * Postgres (`trellai.rows`) and pull what the other computers wrote.
 *
 * Connections:
 * - "own": TRELLAI_DATABASE_URL — your computers. Everything travels.
 * - one per invitation (`sync_shares`): someone else's database (or yours, given to
 *   someone). Only the rows of that project travel, plus the people who share it.
 *
 * - Rows are whole records (JSON). Last write wins.
 * - Some columns are per-computer and never leave it: the repo path, worktrees, agent
 *   session ids, queued input, "Ver esta rama" state.
 * - `rev` is a global counter assigned under an advisory lock, so a pull cursor never
 *   skips a row that commits late.
 * - Rows that came in through one connection are not relayed to the others: paste an
 *   invitation on each computer that should see the project.
 */
import postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Card, Project } from "../shared/types.js";
import * as db from "./db.js";
import { emitSync } from "./events.js";
import * as git from "./git.js";
import { MACHINE } from "./machine.js";

const URL = process.env.TRELLAI_DATABASE_URL?.trim() || "";
const INTERVAL = Number(process.env.TRELLAI_SYNC_MS ?? 2000);
const LOCK_ID = 7_741_100;
/** Bumped when the remote schema changes, so every database is migrated again. */
const SCHEMA = 2;

/** Columns that stay on this computer. */
const LOCAL: Record<string, string[]> = {
  projects: [
    "repo_path",
    "preview_card_id",
    "preview_prev",
    "preview_sha",
    "preview_stash",
    "assistant_session_id",
    "assistant_pending",
    "direct_session_id",
    "direct_pending",
    "bg_image", // the image file lives in this computer's .trellai/
  ],
  cards: ["worktree", "session_id", "prep_session_id", "pending_input"],
};
const TABLES = ["projects", "people", "cards", "members", ...db.UID_TABLES] as const;
type Table = (typeof TABLES)[number];
const isUidTable = (t: string) => (db.UID_TABLES as readonly string[]).includes(t);
const keyCol = (t: string) => (isUidTable(t) ? "uid" : "id");

const sqlite = db.db;
sqlite.exec(`
CREATE TABLE IF NOT EXISTS sync_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sync_flag (applying INTEGER NOT NULL);
-- rows whose parent (card/project) hasn't arrived yet
CREATE TABLE IF NOT EXISTS sync_deferred (tbl TEXT NOT NULL, key TEXT NOT NULL, row TEXT NOT NULL, since TEXT NOT NULL, PRIMARY KEY (tbl, key));
-- invitations pasted (or made with a database other than TRELLAI_DATABASE_URL) on this computer
CREATE TABLE IF NOT EXISTS sync_shares (id TEXT PRIMARY KEY, url TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL);
`);
const addCol = (t: string, c: string, ddl: string) => {
  if (!(sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c)) sqlite.exec(`ALTER TABLE ${t} ADD COLUMN ${ddl}`);
};
/** The row's project when it changed (a deleted row can't be looked up anymore). */
addCol("sync_outbox", "project", "project TEXT");
/** Which connection a deferred row came from. */
addCol("sync_deferred", "conn", "conn TEXT NOT NULL DEFAULT 'own'");
if (!sqlite.prepare("SELECT 1 FROM sync_flag").get()) sqlite.exec("INSERT INTO sync_flag VALUES (0)");
sqlite.exec("UPDATE sync_flag SET applying = 0");

const getState = (k: string) => (sqlite.prepare("SELECT v FROM sync_state WHERE k = ?").get(k) as { v: string } | undefined)?.v;
const setState = (k: string, v: string) => sqlite.prepare("INSERT OR REPLACE INTO sync_state (k, v) VALUES (?, ?)").run(k, v);

/** Who wrote a row, in `trellai.rows.origin`: unique even if two people's computers share a name. */
const ORIGIN = (() => {
  let id = getState("install_id");
  if (!id) setState("install_id", (id = randomBytes(4).toString("hex")));
  return `${MACHINE}~${id}`;
})();
/** Before ORIGIN existed rows were tagged with the bare machine name. */
const isMine = (origin: string) => origin === ORIGIN || origin === MACHINE;

const columnsOf = (t: string) => (sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
/** Columns that travel between computers. */
const sharedCols = (t: string) => columnsOf(t).filter((c) => !(LOCAL[t] ?? []).includes(c) && !(isUidTable(t) && c === "id"));

/** SQL for a row's project inside a trigger (`R` = NEW or OLD). */
function projectExpr(t: string, R: string): string {
  if (t === "projects") return `${R}.id`;
  const cols = columnsOf(t);
  if (cols.includes("project_id")) return `${R}.project_id`;
  if (cols.includes("card_id")) return `(SELECT project_id FROM cards WHERE id = ${R}.card_id)`;
  return "NULL";
}

/** (Re)create the change-capture triggers — after migrations, so new columns are included. */
function installTriggers() {
  for (const t of TABLES) {
    const k = keyCol(t);
    const cols = sharedCols(t)
      .map((c) => `"${c}"`)
      .join(", ");
    const when = "WHEN (SELECT applying FROM sync_flag) = 0";
    const ins = (R: string) => `INSERT INTO sync_outbox (tbl, key, project) VALUES ('${t}', ${R}.${k}, ${projectExpr(t, R)});`;
    sqlite.exec(`
      DROP TRIGGER IF EXISTS sync_${t}_ins; DROP TRIGGER IF EXISTS sync_${t}_upd; DROP TRIGGER IF EXISTS sync_${t}_del;
      CREATE TRIGGER sync_${t}_ins AFTER INSERT ON ${t} ${when} BEGIN ${ins("NEW")} END;
      CREATE TRIGGER sync_${t}_upd AFTER UPDATE OF ${cols} ON ${t} ${when} BEGIN ${ins("NEW")} END;
      CREATE TRIGGER sync_${t}_del AFTER DELETE ON ${t} ${when} BEGIN ${ins("OLD")} END;
    `);
  }
}
let triggersOn = false;

/** The project a local row belongs to (people belong to none). */
function projectOfRow(t: string, key: string, row: Record<string, unknown> | undefined): string | undefined {
  if (t === "projects") return key;
  if (!row) return undefined;
  if (row.project_id) return row.project_id as string;
  if (row.card_id) return db.getCard(row.card_id as string)?.project_id;
  return undefined;
}

// ---------------------------------------------------------------------------
// Hooks: the workflow reacts to what other computers did
// ---------------------------------------------------------------------------

export interface SyncHooks {
  /** a card changed (or was deleted) on another computer */
  card?: (before: Card | undefined, after: Card | undefined) => void;
  /** a project is about to be deleted because another computer deleted it */
  projectDeleting?: (projectId: string) => void;
  /** a message was written on another computer */
  message?: (m: { card_id: string; role: string; content: string }) => void;
}
const hooks: SyncHooks = {};
export function onSync(h: SyncHooks) {
  Object.assign(hooks, h);
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

interface ConnStatus {
  ok: boolean;
  error: string | null;
  last_sync: string | null;
}

interface Conn extends ConnStatus {
  /** "own" or the share's id */
  id: string;
  url: string;
  /** only this project travels (null = everything) */
  project: string | null;
  sql: postgres.Sql | null;
  busy: Promise<void> | null;
  kick: boolean;
}

const conns = new Map<string, Conn>();
const newConn = (id: string, url: string, project: string | null): Conn => ({
  id,
  url,
  project,
  sql: null,
  busy: null,
  kick: false,
  ok: false,
  error: null,
  last_sync: null,
});
if (URL) conns.set("own", newConn("own", URL, null));

/** State keys: the own connection keeps the names it always had. */
const sk = (c: Conn, k: string) => (c.id === "own" ? k : `share:${c.id}:${k}`);
const pushedSeq = (c: Conn) => Number(getState(sk(c, "pushed")) ?? 0);

interface ShareRow {
  id: string;
  url: string;
  project_id: string;
  created_at: string;
}
const listShares = () => sqlite.prepare("SELECT * FROM sync_shares ORDER BY created_at").all() as ShareRow[];

/** "db.xxx.supabase.co" — for showing where a project is shared, never the password. */
export function hostOf(url: string): string {
  return url.match(/@([^/:?]+)/)?.[1] ?? url.replace(/^[a-z]+:\/\//, "").split(/[/?]/)[0];
}

export interface SyncStatus extends ConnStatus {
  /** TRELLAI_DATABASE_URL is set (your computers share the board) */
  enabled: boolean;
  /** any connection at all (own or invitations) */
  active: boolean;
  machine: string;
  pending: number;
  shares: ({ id: string; project_id: string; host: string } & ConnStatus)[];
}
export function syncStatus(): SyncStatus {
  const own = conns.get("own");
  const pending = own ? (sqlite.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE seq > ?").get(pushedSeq(own)) as { n: number }).n : 0;
  return {
    enabled: !!own,
    active: conns.size > 0,
    machine: MACHINE,
    ok: own?.ok ?? false,
    error: own?.error ?? null,
    last_sync: own?.last_sync ?? null,
    pending,
    shares: [...conns.values()]
      .filter((c) => c.project)
      .map((c) => ({ id: c.id, project_id: c.project!, host: hostOf(c.url), ok: c.ok, error: c.error, last_sync: c.last_sync })),
  };
}

// ---------------------------------------------------------------------------
// Push / pull
// ---------------------------------------------------------------------------

function connect(url: string) {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  const explicitSsl = /[?&]sslmode=/.test(url);
  return postgres(url, {
    max: 2,
    idle_timeout: 30,
    connect_timeout: 15,
    prepare: false, // works through Supabase's pooler too
    onnotice: () => {},
    ...(explicitSsl ? {} : { ssl: local ? false : "require" }),
  });
}

async function migrateRemote(s: postgres.Sql) {
  await s.unsafe(`
    CREATE SCHEMA IF NOT EXISTS trellai;
    CREATE SEQUENCE IF NOT EXISTS trellai.rev_seq;
    CREATE TABLE IF NOT EXISTS trellai.rows (
      tbl text NOT NULL,
      key text NOT NULL,
      data text,
      deleted boolean NOT NULL DEFAULT false,
      origin text NOT NULL,
      rev bigint NOT NULL DEFAULT nextval('trellai.rev_seq'),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tbl, key)
    );
    CREATE INDEX IF NOT EXISTS rows_rev_idx ON trellai.rows (rev);
    ALTER TABLE trellai.rows ADD COLUMN IF NOT EXISTS project text;
    CREATE INDEX IF NOT EXISTS rows_project_idx ON trellai.rows (project, rev);
    ALTER TABLE trellai.rows ENABLE ROW LEVEL SECURITY;
  `);
}

function readRow(t: string, key: string): Record<string, unknown> | undefined {
  return sqlite.prepare(`SELECT * FROM ${t} WHERE ${keyCol(t)} = ?`).get(key) as Record<string, unknown> | undefined;
}

function serialize(t: string, row: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const c of sharedCols(t)) out[c] = row[c];
  if (t === "projects") out.repo_hint = row.repo_path; // helps the other computer find the repo
  return JSON.stringify(out);
}

/** People who share `projectId` (and so may travel through its invitation). */
function memberIds(projectId: string): Set<string> {
  return new Set(db.listMembers(projectId).map((m) => m.person_id));
}

interface Outgoing {
  tbl: string;
  key: string;
  data: string | null;
  deleted: boolean;
  origin: string;
  project: string | null;
}

/** Write rows to a connection. Through an invitation, only its project's rows go. */
async function write(c: Conn, items: { tbl: string; key: string; project?: string | null }[]): Promise<number> {
  const s = c.sql!;
  const members = c.project ? memberIds(c.project) : null;
  const me = db.meId();
  const rows: Outgoing[] = [];
  /** deleted rows whose project we can no longer tell: only if the remote row is the share's */
  const orphans: { tbl: string; key: string }[] = [];
  for (const { tbl, key, project } of items) {
    const row = readRow(tbl, key);
    const pid = project ?? projectOfRow(tbl, key, row) ?? null;
    if (c.project) {
      if (tbl === "people") {
        if (key !== me && !members!.has(key)) continue;
      } else if (!pid) {
        if (!row) orphans.push({ tbl, key });
        continue;
      } else if (pid !== c.project) continue;
    }
    rows.push({ tbl, key, data: row ? serialize(tbl, row) : null, deleted: !row, origin: ORIGIN, project: tbl === "people" ? null : pid });
  }
  if (!rows.length && !orphans.length) return 0;
  await s.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    for (let i = 0; i < rows.length; i += 100) {
      await tx`
        INSERT INTO trellai.rows ${tx(rows.slice(i, i + 100), "tbl", "key", "data", "deleted", "origin", "project")}
        ON CONFLICT (tbl, key) DO UPDATE SET
          data = EXCLUDED.data, deleted = EXCLUDED.deleted, origin = EXCLUDED.origin,
          project = COALESCE(EXCLUDED.project, trellai.rows.project),
          rev = nextval('trellai.rev_seq'), updated_at = now()`;
    }
    for (const o of orphans) {
      await tx`
        UPDATE trellai.rows SET data = NULL, deleted = true, origin = ${ORIGIN}, rev = nextval('trellai.rev_seq'), updated_at = now()
        WHERE tbl = ${o.tbl} AND key = ${o.key} AND project = ${c.project} AND NOT deleted`;
    }
  });
  return rows.length + orphans.length;
}

/** Drop outbox rows every connection has pushed. */
function trimOutbox() {
  if (!conns.size) return;
  const min = Math.min(...[...conns.values()].map(pushedSeq));
  sqlite.prepare("DELETE FROM sync_outbox WHERE seq <= ?").run(min);
}

async function push(c: Conn): Promise<number> {
  const from = pushedSeq(c);
  const batch = sqlite.prepare("SELECT seq, tbl, key, project FROM sync_outbox WHERE seq > ? ORDER BY seq LIMIT 500").all(from) as {
    seq: number;
    tbl: string;
    key: string;
    project: string | null;
  }[];
  if (!batch.length) return 0;
  const latest = new Map<string, { tbl: string; key: string; project: string | null }>();
  for (const r of batch) {
    const id = `${r.tbl}\0${r.key}`;
    const project = r.project ?? latest.get(id)?.project ?? null;
    latest.delete(id);
    latest.set(id, { tbl: r.tbl, key: r.key, project });
  }
  await write(c, [...latest.values()]);
  setState(sk(c, "pushed"), String(batch[batch.length - 1].seq));
  trimOutbox();
  return batch.length;
}

/** Every row of a project (an invitation's first push, or before inviting through your own database). */
function projectItems(projectId: string): { tbl: string; key: string; project: string }[] {
  const out: { tbl: string; key: string; project: string }[] = [{ tbl: "projects", key: projectId, project: projectId }];
  const cards = (sqlite.prepare("SELECT id FROM cards WHERE project_id = ?").all(projectId) as { id: string }[]).map((r) => r.id);
  out.push(...cards.map((key) => ({ tbl: "cards", key, project: projectId })));
  for (const t of ["members", ...db.UID_TABLES]) {
    const k = keyCol(t);
    const cols = columnsOf(t);
    const keys = cols.includes("project_id")
      ? (sqlite.prepare(`SELECT ${k} AS k FROM ${t} WHERE project_id = ?`).all(projectId) as { k: string }[])
      : (sqlite.prepare(`SELECT ${k} AS k FROM ${t} WHERE card_id IN (SELECT id FROM cards WHERE project_id = ?)`).all(projectId) as { k: string }[]);
    out.push(...keys.map((r) => ({ tbl: t, key: r.k, project: projectId })));
  }
  return out;
}

function peopleItems(projectId: string | null): { tbl: string; key: string }[] {
  const ids = projectId ? [...memberIds(projectId), db.meId()].filter((x): x is string => !!x) : db.listPeople().map((p) => p.id);
  return [...new Set(ids)].filter((id) => db.getPerson(id)).map((key) => ({ tbl: "people", key }));
}

interface RemoteRow {
  tbl: string;
  key: string;
  data: string | null;
  deleted: boolean;
  origin: string;
  rev: string;
}

async function pull(c: Conn): Promise<number> {
  const s = c.sql!;
  let total = 0;
  for (;;) {
    const cursor = getState(sk(c, "cursor")) ?? "0";
    const rows = c.project
      ? await s<RemoteRow[]>`
          SELECT tbl, key, data, deleted, origin, rev FROM trellai.rows
          WHERE rev > ${cursor} AND (project = ${c.project} OR (tbl = 'people' AND key IN (
            SELECT (data::json)->>'person_id' FROM trellai.rows WHERE tbl = 'members' AND project = ${c.project} AND data IS NOT NULL)))
          ORDER BY rev LIMIT 1000`
      : await s<RemoteRow[]>`
          SELECT tbl, key, data, deleted, origin, rev FROM trellai.rows
          WHERE rev > ${cursor} ORDER BY rev LIMIT 1000`;
    if (!rows.length) return total + retryDeferred(c);
    total += apply(c, rows);
    setState(sk(c, "cursor"), String(rows[rows.length - 1].rev));
    if (rows.length < 1000) return total + retryDeferred(c);
  }
}

/** Children that arrived before their card: try again now. Give up after a day. */
function retryDeferred(c: Conn): number {
  const rows = sqlite.prepare("SELECT row FROM sync_deferred WHERE conn = ?").all(c.id) as { row: string }[];
  if (!rows.length) return 0;
  sqlite.prepare("DELETE FROM sync_deferred WHERE since < ?").run(new Date(Date.now() - 86_400_000).toISOString());
  return apply(
    c,
    rows.map((r) => JSON.parse(r.row) as RemoteRow),
    true,
  );
}

const ORDER: Record<string, number> = { projects: 0, people: 0, cards: 1, members: 1 };

/** Find the repo on this computer for a project created on another one (or by someone else). */
function guessRepo(hint: unknown, remoteUrl: unknown): string {
  if (process.env.TRELLAI_GUESS_REPOS === "0") return "";
  // Already on the board with the same remote (e.g. your own project for that GitHub repo).
  if (remoteUrl) {
    const twin = db.listProjects().find((p) => p.repo_path && existsSync(p.repo_path) && git.sameRemoteSync(p.remote_url, String(remoteUrl)));
    if (twin) return twin.repo_path;
  }
  const cands = new Set<string>();
  if (typeof hint === "string" && hint) {
    cands.add(hint);
    cands.add(hint.replace(/^\/(Users|home)\/[^/]+/, homedir()));
    cands.add(join(homedir(), "code", basename(hint)));
  }
  if (remoteUrl) cands.add(join(homedir(), "code", String(remoteUrl).replace(/\.git$/, "").split(/[/:]/).pop()!));
  for (const c of cands) {
    try {
      if (!existsSync(c) || !git.isRepo(c)) continue;
      if (remoteUrl && !git.sameRemoteSync(git.remoteUrlSync(c), String(remoteUrl))) continue;
      return git.topLevel(c);
    } catch {
      /* try next */
    }
  }
  return "";
}

function apply(c: Conn, rows: RemoteRow[], retrying = false): number {
  // Parents first, so a card's messages never land before the card.
  rows = [...rows].sort((a, b) => (ORDER[a.tbl] ?? 2) - (ORDER[b.tbl] ?? 2));
  const projectsTouched = new Set<string>();
  const after: (() => void)[] = [];
  let applied = 0;
  const pendingKeys = new Set(
    (sqlite.prepare("SELECT DISTINCT tbl, key FROM sync_outbox WHERE seq > ?").all(pushedSeq(c)) as { tbl: string; key: string }[]).map(
      (r) => `${r.tbl}\0${r.key}`,
    ),
  );

  const tx = sqlite.transaction(() => {
    sqlite.exec("UPDATE sync_flag SET applying = 1");
    try {
      for (const r of rows) {
        if (isMine(r.origin)) continue; // our own write coming back
        if (!(TABLES as readonly string[]).includes(r.tbl)) continue;
        if (pendingKeys.has(`${r.tbl}\0${r.key}`)) continue; // we have a newer local change on its way up
        try {
          if (applyOne(c, r, projectsTouched, after)) applied++;
          sqlite.prepare("DELETE FROM sync_deferred WHERE tbl = ? AND key = ?").run(r.tbl, r.key);
        } catch (err) {
          const msg = (err as Error).message;
          if (/FOREIGN KEY/i.test(msg)) {
            sqlite
              .prepare("INSERT OR IGNORE INTO sync_deferred (tbl, key, row, since, conn) VALUES (?, ?, ?, ?, ?)")
              .run(r.tbl, r.key, JSON.stringify(r), new Date().toISOString(), c.id);
            if (!retrying) sqlite.prepare("UPDATE sync_deferred SET row = ? WHERE tbl = ? AND key = ?").run(JSON.stringify(r), r.tbl, r.key);
          } else console.warn(`[sync] skip ${r.tbl}/${r.key}: ${msg}`);
        }
      }
    } finally {
      sqlite.exec("UPDATE sync_flag SET applying = 0");
    }
  });
  tx();
  for (const fn of after) {
    try {
      fn();
    } catch (err) {
      console.error("[sync] hook:", err);
    }
  }
  for (const p of projectsTouched) emitSync(p);
  return applied;
}

function applyOne(c: Conn, r: RemoteRow, touched: Set<string>, after: (() => void)[]): boolean {
  const t = r.tbl as Table;
  const k = keyCol(t);
  const existing = readRow(t, r.key);
  // Through an invitation only its project (and its people) may change here.
  const outside = (pid: string | undefined) => !!c.project && t !== "people" && pid !== undefined && pid !== c.project;
  if (outside(projectOfRow(t, r.key, existing))) return false;

  if (r.deleted || !r.data) {
    if (!existing) return false;
    const pid = projectOfRow(t, r.key, existing);
    if (t === "cards") {
      const before = db.getCard(r.key);
      sqlite.prepare("DELETE FROM cards WHERE id = ?").run(r.key);
      after.push(() => hooks.card?.(before, undefined));
    } else if (t === "projects") {
      hooks.projectDeleting?.(r.key);
      sqlite.prepare("DELETE FROM projects WHERE id = ?").run(r.key);
    } else {
      sqlite.prepare(`DELETE FROM ${t} WHERE ${k} = ?`).run(r.key);
    }
    if (pid) touched.add(pid);
    return true;
  }

  const data = JSON.parse(r.data) as Record<string, unknown>;
  if (outside(projectOfRow(t, r.key, data))) return false;
  const allowed = new Set(sharedCols(t));
  const cols = Object.keys(data).filter((col) => allowed.has(col) && col !== k);
  const values = cols.map((col) => data[col] ?? null);
  const before = t === "cards" ? db.getCard(r.key) : undefined;

  if (existing) {
    if (cols.length) {
      sqlite.prepare(`UPDATE ${t} SET ${cols.map((col) => `"${col}" = ?`).join(", ")} WHERE ${k} = ?`).run(...values, r.key);
    }
  } else {
    const extra: Record<string, unknown> = {};
    if (t === "projects") extra.repo_path = guessRepo(data.repo_hint, data.remote_url);
    const allCols = [k, ...cols, ...Object.keys(extra)];
    const allVals = [r.key, ...values, ...Object.values(extra)];
    sqlite
      .prepare(`INSERT INTO ${t} (${allCols.map((col) => `"${col}"`).join(", ")}) VALUES (${allCols.map(() => "?").join(", ")})`)
      .run(...allVals);
  }

  const row = readRow(t, r.key);
  const pid = projectOfRow(t, r.key, row);
  if (pid) touched.add(pid);
  if (t === "people") for (const p of db.listProjects()) touched.add(p.id); // names/colors on every board
  if (t === "cards") {
    const now = db.getCard(r.key);
    after.push(() => hooks.card?.(before, now));
  }
  if (t === "messages" && !existing && row) {
    const m = { card_id: row.card_id as string, role: row.role as string, content: row.content as string };
    after.push(() => hooks.message?.(m));
  }
  // Someone took us out of this shared project: stop syncing it.
  if (t === "members" && c.project && row?.person_id === db.meId() && row?.left_at) {
    const id = c.id;
    after.push(() => setImmediate(() => dropShare(id)));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

async function runTick(c: Conn) {
  try {
    c.sql ??= connect(c.url);
    const urlHash = `${createHash("sha256").update(c.url).digest("hex").slice(0, 16)}:${SCHEMA}`;
    if (getState(sk(c, "migrated")) !== urlHash) {
      await migrateRemote(c.sql);
      setState(sk(c, "migrated"), urlHash);
    }
    await push(c);
    await pull(c);
    if (getState(sk(c, "seeded")) !== "1") {
      // First time: send what we have (after taking what's there).
      const items = c.project ? [...projectItems(c.project), ...peopleItems(c.project)] : TABLES.flatMap((t) => allKeys(t));
      for (let i = 0; i < items.length; i += 500) await write(c, items.slice(i, i + 500));
      setState(sk(c, "seeded"), "1");
    }
    while ((sqlite.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE seq > ?").get(pushedSeq(c)) as { n: number }).n > 0) {
      if (!(await push(c))) break;
    }
    if (!c.ok) console.log(c.project ? `[sync] invitación ${hostOf(c.url)} conectada` : `[sync] conectado como "${MACHINE}"`);
    c.ok = true;
    c.error = null;
    c.last_sync = new Date().toISOString();
  } catch (err) {
    const msg = (err as Error).message;
    if (c.error !== msg) console.warn(`[sync${c.project ? ` ${hostOf(c.url)}` : ""}]`, msg);
    c.ok = false;
    c.error = msg;
    // A dead connection is rebuilt on the next tick.
    const old = c.sql;
    c.sql = null;
    old?.end({ timeout: 1 }).catch(() => {});
  }
}

const allKeys = (t: string) =>
  (sqlite.prepare(`SELECT ${keyCol(t)} AS k FROM ${t}`).all() as { k: string }[]).map((r) => ({ tbl: t, key: r.k }));

function tickConn(c: Conn): Promise<void> {
  if (c.busy) {
    c.kick = true;
    return c.busy;
  }
  c.busy = runTick(c).finally(() => {
    c.busy = null;
    if (c.kick && conns.get(c.id) === c) {
      c.kick = false;
      setImmediate(() => tickConn(c));
    }
  });
  return c.busy;
}

async function tick() {
  await Promise.all([...conns.values()].map(tickConn));
}

function ensureRunning() {
  if (!conns.size) return;
  if (!triggersOn) {
    installTriggers();
    triggersOn = true;
  }
  if (!timer) timer = setInterval(tick, INTERVAL);
}

export function startSync() {
  for (const s of listShares()) if (s.url !== URL) conns.set(s.id, newConn(s.id, s.url, s.project_id));
  if (!conns.size) return;
  ensureRunning();
  tick();
}

/** Sync right now (e.g. before handing a card to another computer). */
export function syncNow(): Promise<void> {
  return tick();
}

export async function stopSync() {
  if (timer) clearInterval(timer);
  timer = null;
  await Promise.all([...conns.values()].map((c) => c.sql?.end({ timeout: 2 })));
}

export const syncEnabled = () => conns.size > 0;

// ---------------------------------------------------------------------------
// Sharing a project with other people
// ---------------------------------------------------------------------------

const CODE_PREFIX = "trellai1.";

interface Invite {
  /** Postgres URL */
  db: string;
  /** project id (the same on every computer) */
  project: string;
  /** "owner/name" (GitHub) or the remote URL */
  repo: string;
  name: string;
  /** who made it */
  by: string;
}

/** "git@github.com:o/r.git" → "o/r"; other remotes stay as they are. */
export function repoSlug(remote: string): string {
  const m = remote.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : remote.trim();
}

export function encodeInvite(i: Invite): string {
  return CODE_PREFIX + Buffer.from(JSON.stringify(i)).toString("base64url");
}

export function decodeInvite(code: string): Invite | null {
  const raw = code.trim().replace(/\s+/g, "");
  if (!raw.startsWith(CODE_PREFIX)) return null;
  try {
    const i = JSON.parse(Buffer.from(raw.slice(CODE_PREFIX.length), "base64url").toString("utf8")) as Invite;
    return typeof i.db === "string" && typeof i.project === "string" ? i : null;
  } catch {
    return null;
  }
}

const sameDb = (a: string, b: string) => !!a && !!b && a.trim() === b.trim();

/** Why this project can't be shared from here ("" = it can). */
export function inviteProblem(project: Project): string {
  if (!project.remote_url) return "El proyecto necesita un remoto (GitHub) para que la otra persona tenga el mismo repo.";
  if (!db.me()) return "Pon antes tu nombre (arriba a la derecha).";
  return "";
}

/** Add an invitation connection and sync it once. */
async function addShare(url: string, projectId: string): Promise<Conn> {
  const existing = listShares().find((s) => sameDb(s.url, url) && s.project_id === projectId);
  const id = existing?.id ?? randomBytes(6).toString("hex");
  if (!existing) {
    // Joining someone else's project: what's here of it came from them, don't send it back.
    if (!db.getProject(projectId)) setState(`share:${id}:seeded`, "1");
    sqlite.prepare("INSERT INTO sync_shares (id, url, project_id, created_at) VALUES (?, ?, ?, ?)").run(id, url.trim(), projectId, new Date().toISOString());
    // Only what changes from now on goes through the outbox; the project itself goes in the first push.
    const max = (sqlite.prepare("SELECT MAX(seq) AS m FROM sync_outbox").get() as { m: number | null }).m ?? 0;
    setState(`share:${id}:pushed`, String(max));
  }
  let c = conns.get(id);
  if (!c) conns.set(id, (c = newConn(id, url.trim(), projectId)));
  ensureRunning();
  await tickConn(c);
  return c;
}

/** Stop syncing an invitation (the project stays here as it is). */
export function dropShare(id: string) {
  const c = conns.get(id);
  conns.delete(id);
  c?.sql?.end({ timeout: 1 }).catch(() => {});
  sqlite.prepare("DELETE FROM sync_shares WHERE id = ?").run(id);
  sqlite.prepare("DELETE FROM sync_state WHERE k LIKE ?").run(`share:${id}:%`);
  sqlite.prepare("DELETE FROM sync_deferred WHERE conn = ?").run(id);
  trimOutbox();
  if (c?.project) emitSync(c.project);
}

/** The invitation connection this computer uses for a project, if any. */
export function shareOf(projectId: string): { id: string; host: string } | null {
  const c = [...conns.values()].find((x) => x.project === projectId);
  return c ? { id: c.id, host: hostOf(c.url) } : null;
}

/**
 * Make an invitation code for a project. `dbUrl` = another database than TRELLAI_DATABASE_URL
 * (this computer then syncs the project through it too).
 */
export async function createInvite(projectId: string, dbUrl?: string): Promise<string> {
  const project = db.getProject(projectId);
  if (!project) throw new Error("Proyecto no encontrado");
  const problem = inviteProblem(project);
  if (problem) throw new Error(problem);
  const me = db.me()!;
  const existing = shareOf(projectId);
  const url = dbUrl?.trim() || (existing ? conns.get(existing.id)!.url : URL);
  if (!url) throw new Error("Hace falta una base de datos Postgres (Supabase) para compartir: pega su URL.");
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("Eso no parece una URL de Postgres (postgres://…).");
  db.joinProject(projectId, me.id);
  if (sameDb(url, URL)) {
    // Rows written before invitations existed don't say their project: send the project again.
    const own = conns.get("own")!;
    await tickConn(own);
    if (!own.ok) throw new Error(`No conecto con la base de datos: ${own.error}`);
    own.sql ??= connect(own.url);
    await write(own, [...projectItems(projectId), ...peopleItems(null)]);
  } else {
    const c = await addShare(url, projectId);
    if (!c.ok) {
      if (!existing) dropShare(c.id);
      throw new Error(`No conecto con esa base de datos: ${c.error}`);
    }
  }
  return encodeInvite({ db: url, project: projectId, repo: repoSlug(project.remote_url!), name: basename(project.name), by: me.name });
}

/** Paste an invitation: sync that project from now on. Returns it once it's here. */
export async function joinWithCode(code: string): Promise<Project> {
  const inv = decodeInvite(code);
  if (!inv) throw new Error("Ese código no es una invitación de Trellai (empieza por «trellai1.»).");
  const me = db.me();
  if (!me) throw new Error("Pon antes tu nombre (arriba a la derecha).");
  if (sameDb(inv.db, URL)) {
    // Your own database: you have it already.
    await tickConn(conns.get("own")!);
  } else {
    const fresh = !shareOf(inv.project);
    const c = await addShare(inv.db, inv.project);
    if (!c.ok || !db.getProject(inv.project)) {
      if (fresh) dropShare(c.id);
      throw new Error(c.ok ? "En esa base de datos ya no está el proyecto de la invitación (¿lo borraron?)." : `No conecto con la base de datos de la invitación: ${c.error}`);
    }
  }
  const project = db.getProject(inv.project);
  if (!project) throw new Error("No encuentro el proyecto de la invitación.");
  db.joinProject(project.id, me.id);
  // so our name and color travel with the member row
  sqlite.prepare("UPDATE people SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), me.id);
  await syncNow();
  return db.getProject(project.id)!;
}

/** Take someone out of a shared project (yourself = leave: this computer stops syncing it). */
export async function removeMember(projectId: string, personId: string) {
  db.leaveProject(projectId, personId);
  await syncNow();
  if (personId === db.meId()) {
    const s = shareOf(projectId);
    if (s) dropShare(s.id);
  }
  emitSync(projectId);
}

/** Everyone out (including you): the project goes back to being only yours. */
export async function stopSharing(projectId: string) {
  for (const m of db.listMembers(projectId)) if (!m.left_at) db.leaveProject(projectId, m.person_id);
  await syncNow();
  const s = shareOf(projectId);
  if (s) dropShare(s.id);
  emitSync(projectId);
}
