/**
 * Share the board between your computers through a Postgres database (Supabase).
 *
 * Each computer keeps working on its own SQLite file (fast, works offline) and runs
 * agents with its own subscriptions. SQLite triggers record every change in
 * `sync_outbox`; every couple of seconds we push those rows to one generic table in
 * Postgres (`trellai.rows`) and pull what the other computers wrote.
 *
 * - Rows are whole records (JSON). Last write wins — fine for one person.
 * - Some columns are per-computer and never leave it: the repo path, worktrees, agent
 *   session ids, queued input, "Ver esta rama" state.
 * - `rev` is a global counter assigned under an advisory lock, so a pull cursor never
 *   skips a row that commits late.
 *
 * Off unless TRELLAI_DATABASE_URL is set.
 */
import postgres from "postgres";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Card } from "../shared/types.js";
import * as db from "./db.js";
import { emitSync } from "./events.js";
import * as git from "./git.js";
import { MACHINE } from "./machine.js";

const URL = process.env.TRELLAI_DATABASE_URL?.trim() || "";
const INTERVAL = Number(process.env.TRELLAI_SYNC_MS ?? 2000);
const LOCK_ID = 7_741_100;

/** Columns that stay on this computer. */
const LOCAL: Record<string, string[]> = {
  projects: [
    "repo_path",
    "preview_card_id",
    "preview_prev",
    "preview_sha",
    "assistant_session_id",
    "assistant_pending",
    "direct_session_id",
    "direct_pending",
  ],
  cards: ["worktree", "session_id", "prep_session_id", "pending_input"],
};
const TABLES = ["projects", "cards", ...db.UID_TABLES] as const;
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
`);
if (!sqlite.prepare("SELECT 1 FROM sync_flag").get()) sqlite.exec("INSERT INTO sync_flag VALUES (0)");
sqlite.exec("UPDATE sync_flag SET applying = 0");

const getState = (k: string) => (sqlite.prepare("SELECT v FROM sync_state WHERE k = ?").get(k) as { v: string } | undefined)?.v;
const setState = (k: string, v: string) => sqlite.prepare("INSERT OR REPLACE INTO sync_state (k, v) VALUES (?, ?)").run(k, v);

const columnsOf = (t: string) => (sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
/** Columns that travel between computers. */
const sharedCols = (t: string) => columnsOf(t).filter((c) => !(LOCAL[t] ?? []).includes(c) && !(isUidTable(t) && c === "id"));

/** (Re)create the change-capture triggers — after migrations, so new columns are included. */
function installTriggers() {
  for (const t of TABLES) {
    const k = keyCol(t);
    const cols = sharedCols(t)
      .map((c) => `"${c}"`)
      .join(", ");
    const when = "WHEN (SELECT applying FROM sync_flag) = 0";
    sqlite.exec(`
      DROP TRIGGER IF EXISTS sync_${t}_ins; DROP TRIGGER IF EXISTS sync_${t}_upd; DROP TRIGGER IF EXISTS sync_${t}_del;
      CREATE TRIGGER sync_${t}_ins AFTER INSERT ON ${t} ${when} BEGIN INSERT INTO sync_outbox (tbl, key) VALUES ('${t}', NEW.${k}); END;
      CREATE TRIGGER sync_${t}_upd AFTER UPDATE OF ${cols} ON ${t} ${when} BEGIN INSERT INTO sync_outbox (tbl, key) VALUES ('${t}', NEW.${k}); END;
      CREATE TRIGGER sync_${t}_del AFTER DELETE ON ${t} ${when} BEGIN INSERT INTO sync_outbox (tbl, key) VALUES ('${t}', OLD.${k}); END;
    `);
  }
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
// Status
// ---------------------------------------------------------------------------

export interface SyncStatus {
  enabled: boolean;
  machine: string;
  ok: boolean;
  error: string | null;
  last_sync: string | null;
  pending: number;
}
const status: SyncStatus = { enabled: !!URL, machine: MACHINE, ok: false, error: null, last_sync: null, pending: 0 };
export function syncStatus(): SyncStatus {
  status.pending = (sqlite.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n;
  return { ...status };
}

// ---------------------------------------------------------------------------
// Push / pull
// ---------------------------------------------------------------------------

let sql: postgres.Sql | null = null;

function connect() {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(URL);
  const explicitSsl = /[?&]sslmode=/.test(URL);
  return postgres(URL, {
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

async function push(s: postgres.Sql): Promise<number> {
  const batch = sqlite.prepare("SELECT seq, tbl, key FROM sync_outbox ORDER BY seq LIMIT 500").all() as {
    seq: number;
    tbl: string;
    key: string;
  }[];
  if (!batch.length) return 0;
  const latest = new Map<string, { tbl: string; key: string }>();
  for (const r of batch) {
    latest.delete(`${r.tbl}\0${r.key}`);
    latest.set(`${r.tbl}\0${r.key}`, r);
  }
  const rows = [...latest.values()].map(({ tbl, key }) => {
    const row = readRow(tbl, key);
    return { tbl, key, data: row ? serialize(tbl, row) : null, deleted: !row, origin: MACHINE };
  });
  await s.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`
      INSERT INTO trellai.rows ${tx(rows, "tbl", "key", "data", "deleted", "origin")}
      ON CONFLICT (tbl, key) DO UPDATE SET
        data = EXCLUDED.data, deleted = EXCLUDED.deleted, origin = EXCLUDED.origin,
        rev = nextval('trellai.rev_seq'), updated_at = now()`;
  });
  sqlite.prepare("DELETE FROM sync_outbox WHERE seq <= ?").run(batch[batch.length - 1].seq);
  return rows.length;
}

interface RemoteRow {
  tbl: string;
  key: string;
  data: string | null;
  deleted: boolean;
  origin: string;
  rev: string;
}

async function pull(s: postgres.Sql): Promise<number> {
  let total = 0;
  for (;;) {
    const cursor = getState("cursor") ?? "0";
    const rows = await s<RemoteRow[]>`
      SELECT tbl, key, data, deleted, origin, rev FROM trellai.rows
      WHERE rev > ${cursor} ORDER BY rev LIMIT 1000`;
    if (!rows.length) return total + retryDeferred();
    total += apply(rows);
    setState("cursor", String(rows[rows.length - 1].rev));
    if (rows.length < 1000) return total + retryDeferred();
  }
}

/** Children that arrived before their card: try again now. Give up after a day. */
function retryDeferred(): number {
  const rows = sqlite.prepare("SELECT row FROM sync_deferred").all() as { row: string }[];
  if (!rows.length) return 0;
  sqlite.prepare("DELETE FROM sync_deferred WHERE since < ?").run(new Date(Date.now() - 86_400_000).toISOString());
  return apply(rows.map((r) => JSON.parse(r.row) as RemoteRow), true);
}

const ORDER: Record<string, number> = { projects: 0, cards: 1 };

/** Find the repo on this computer for a project created on another one. */
function guessRepo(hint: unknown, remoteUrl: unknown): string {
  if (process.env.TRELLAI_GUESS_REPOS === "0") return "";
  const cands = new Set<string>();
  if (typeof hint === "string" && hint) {
    cands.add(hint);
    cands.add(hint.replace(/^\/(Users|home)\/[^/]+/, homedir()));
    cands.add(join(homedir(), "code", basename(hint)));
  }
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

function apply(rows: RemoteRow[], retrying = false): number {
  // Parents first, so a card's messages never land before the card.
  rows = [...rows].sort((a, b) => (ORDER[a.tbl] ?? 2) - (ORDER[b.tbl] ?? 2));
  const projectsTouched = new Set<string>();
  const after: (() => void)[] = [];
  let applied = 0;
  const pendingKeys = new Set(
    (sqlite.prepare("SELECT DISTINCT tbl, key FROM sync_outbox").all() as { tbl: string; key: string }[]).map((r) => `${r.tbl}\0${r.key}`),
  );

  const tx = sqlite.transaction(() => {
    sqlite.exec("UPDATE sync_flag SET applying = 1");
    try {
      for (const r of rows) {
        if (r.origin === MACHINE) continue; // our own write coming back
        if (!(TABLES as readonly string[]).includes(r.tbl)) continue;
        if (pendingKeys.has(`${r.tbl}\0${r.key}`)) continue; // we have a newer local change on its way up
        try {
          if (applyOne(r, projectsTouched, after)) applied++;
          sqlite.prepare("DELETE FROM sync_deferred WHERE tbl = ? AND key = ?").run(r.tbl, r.key);
        } catch (err) {
          const msg = (err as Error).message;
          if (/FOREIGN KEY/i.test(msg)) {
            sqlite
              .prepare("INSERT OR IGNORE INTO sync_deferred (tbl, key, row, since) VALUES (?, ?, ?, ?)")
              .run(r.tbl, r.key, JSON.stringify(r), new Date().toISOString());
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

function applyOne(r: RemoteRow, touched: Set<string>, after: (() => void)[]): boolean {
  const t = r.tbl as Table;
  const k = keyCol(t);
  const existing = readRow(t, r.key);
  const projectOf = (row: Record<string, unknown> | undefined) =>
    t === "projects" ? (row?.id as string) : (row?.project_id as string) ?? (row?.card_id ? db.getCard(row.card_id as string)?.project_id : undefined);

  if (r.deleted || !r.data) {
    if (!existing) return false;
    const pid = projectOf(existing);
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
  const allowed = new Set(sharedCols(t));
  const cols = Object.keys(data).filter((c) => allowed.has(c) && c !== k);
  const values = cols.map((c) => data[c] ?? null);
  const before = t === "cards" ? db.getCard(r.key) : undefined;

  if (existing) {
    if (cols.length) {
      sqlite.prepare(`UPDATE ${t} SET ${cols.map((c) => `"${c}" = ?`).join(", ")} WHERE ${k} = ?`).run(...values, r.key);
    }
  } else {
    const extra: Record<string, unknown> = {};
    if (t === "projects") extra.repo_path = guessRepo(data.repo_hint, data.remote_url);
    const allCols = [k, ...cols, ...Object.keys(extra)];
    const allVals = [r.key, ...values, ...Object.values(extra)];
    sqlite
      .prepare(`INSERT INTO ${t} (${allCols.map((c) => `"${c}"`).join(", ")}) VALUES (${allCols.map(() => "?").join(", ")})`)
      .run(...allVals);
  }

  const row = readRow(t, r.key);
  const pid = projectOf(row);
  if (pid) touched.add(pid);
  if (t === "cards") {
    const now = db.getCard(r.key);
    after.push(() => hooks.card?.(before, now));
  }
  if (t === "messages" && !existing && row) {
    const m = { card_id: row.card_id as string, role: row.role as string, content: row.content as string };
    after.push(() => hooks.message?.(m));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let busy = false;
let kick = false;

async function tick() {
  if (busy) {
    kick = true;
    return;
  }
  busy = true;
  try {
    sql ??= connect();
    const urlHash = createHash("sha256").update(URL).digest("hex").slice(0, 16);
    if (getState("migrated") !== urlHash) {
      await migrateRemote(sql);
      setState("migrated", urlHash);
    }
    await push(sql);
    await pull(sql);
    if (getState("seeded") !== "1") {
      // First time on this computer: send everything we have (after taking what's there).
      const tx = sqlite.transaction(() => {
        for (const t of TABLES) sqlite.exec(`INSERT INTO sync_outbox (tbl, key) SELECT '${t}', ${keyCol(t)} FROM ${t}`);
        setState("seeded", "1");
      });
      tx();
      await push(sql);
    }
    while ((sqlite.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n > 0) {
      if (!(await push(sql))) break;
    }
    if (!status.ok) console.log(`[sync] conectado como "${MACHINE}"`);
    status.ok = true;
    status.error = null;
    status.last_sync = new Date().toISOString();
  } catch (err) {
    const msg = (err as Error).message;
    if (status.error !== msg) console.warn("[sync]", msg);
    status.ok = false;
    status.error = msg;
    // A dead connection is rebuilt on the next tick.
    const old = sql;
    sql = null;
    old?.end({ timeout: 1 }).catch(() => {});
  } finally {
    busy = false;
    if (kick) {
      kick = false;
      setImmediate(tick);
    }
  }
}

export function startSync() {
  if (!URL) return;
  installTriggers();
  tick();
  timer = setInterval(tick, INTERVAL);
}

/** Sync right now (e.g. before handing a card to another computer). */
export function syncNow(): Promise<void> {
  if (!URL) return Promise.resolve();
  return tick();
}

export async function stopSync() {
  if (timer) clearInterval(timer);
  await sql?.end({ timeout: 2 });
}

export const syncEnabled = () => !!URL;
