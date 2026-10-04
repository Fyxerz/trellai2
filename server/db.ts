import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { nanoid } from "nanoid";
import type {
  AssistantMessage,
  Card,
  Checkpoint,
  Claim,
  CardStatus,
  Column,
  Message,
  MessageRole,
  ModelRole,
  Note,
  Project,
  Question,
  Tag,
} from "../shared/types.js";

const DB_PATH = resolve(process.env.TRELLAI_DB ?? "data/trellai.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '',
  "column" TEXT NOT NULL DEFAULT 'backlog',
  position REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle',
  status_text TEXT NOT NULL DEFAULT '',
  branch TEXT,
  worktree TEXT,
  session_id TEXT,
  prep_session_id TEXT,
  files TEXT NOT NULL DEFAULT '[]',
  pending_input TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  answer TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  card_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_project ON assistant_messages(project_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_card ON checkpoints(card_id);
CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_card ON messages(card_id);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
`);

// Columns added after the first release.
function addColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn("projects", "assistant_session_id", "assistant_session_id TEXT");
addColumn("projects", "assistant_pending", "assistant_pending TEXT NOT NULL DEFAULT '[]'");
addColumn("projects", "direct_session_id", "direct_session_id TEXT");
addColumn("projects", "direct_pending", "direct_pending TEXT NOT NULL DEFAULT '[]'");
addColumn("assistant_messages", "mode", "mode TEXT NOT NULL DEFAULT 'plan'");
for (const role of ["model_prep", "model_dev", "model_plan", "model_do"])
  addColumn("projects", role, `${role} TEXT NOT NULL DEFAULT 'claude'`);
addColumn("projects", "model_ui", "model_ui TEXT");
addColumn("cards", "model", "model TEXT");
addColumn("projects", "preview_card_id", "preview_card_id TEXT");
addColumn("projects", "preview_prev", "preview_prev TEXT");
addColumn("projects", "preview_sha", "preview_sha TEXT");
/** Stash with Pedro's uncommitted edits while "Ver esta rama" is on. */
addColumn("projects", "preview_stash", "preview_stash TEXT");
addColumn("projects", "remote_url", "remote_url TEXT");
/** Which computer runs this card's agent and holds its worktree. */
addColumn("cards", "machine", "machine TEXT");
/** Another computer asked the owner to stop the agent (value: the owner's name). */
addColumn("cards", "stop_req", "stop_req TEXT");
/** JSON: the project's tags (Tag[]) and each card's tag ids (string[]). */
addColumn("projects", "tags", "tags TEXT NOT NULL DEFAULT '[]'");
addColumn("cards", "tags", "tags TEXT NOT NULL DEFAULT '[]'");
/** Exact model id of the card agent's latest run. */
addColumn("cards", "agent_model", "agent_model TEXT");
/** When the card entered Merged (the board groups that column by day). */
addColumn("cards", "merged_at", "merged_at TEXT");
db.exec(`UPDATE cards SET merged_at = updated_at WHERE "column" = 'merged' AND merged_at IS NULL`);
/** JSON Claim[]: what the card's agent is touching while in Doing. */
addColumn("cards", "claims", "claims TEXT NOT NULL DEFAULT '[]'");
/** JSON string[]: files a note is about, and cards it's addressed to ([] = everyone). */
addColumn("notes", "files", "files TEXT NOT NULL DEFAULT '[]'");
addColumn("notes", "targets", "targets TEXT NOT NULL DEFAULT '[]'");
addColumn("notes", "archived", "archived INTEGER NOT NULL DEFAULT 0");

/** Tables whose rows use a local INTEGER id; `uid` identifies them across computers. */
export const UID_TABLES = ["messages", "questions", "notes", "checkpoints", "assistant_messages"] as const;
for (const t of UID_TABLES) {
  addColumn(t, "uid", "uid TEXT");
  db.exec(`UPDATE ${t} SET uid = lower(hex(randomblob(8))) WHERE uid IS NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${t}_uid ON ${t}(uid)`);
}
const uid = () => nanoid(14);

const now = () => new Date().toISOString();

// ---------- projects ----------

type ProjectRow = Omit<Project, "tags"> & { tags: string };

function toProject(row: ProjectRow | undefined): Project | undefined {
  return row && { ...row, tags: safeJson<Tag[]>(row.tags, []) };
}

export function listProjects(): Project[] {
  return (db.prepare("SELECT * FROM projects ORDER BY created_at").all() as ProjectRow[]).map((r) => toProject(r)!);
}

export function getProject(id: string): Project | undefined {
  return toProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined);
}

export function setProjectTags(id: string, tags: Tag[]): Tag[] {
  db.prepare("UPDATE projects SET tags = ? WHERE id = ?").run(JSON.stringify(tags), id);
  return tags;
}

/** The project's tag with this name (case-insensitive), created if missing. */
export function ensureTag(projectId: string, name: string, color: string): Tag {
  const tags = getProject(projectId)!.tags;
  const found = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  const tag = { id: nanoid(8), name, color };
  setProjectTags(projectId, [...tags, tag]);
  return tag;
}

export function createProject(p: { name: string; repo_path: string; base_branch: string; remote_url?: string | null }): Project {
  const id = nanoid(10);
  db.prepare(
    "INSERT INTO projects (id, name, repo_path, base_branch, remote_url, created_at) VALUES (@id, @name, @repo_path, @base_branch, @remote_url, @created_at)",
  ).run({ id, created_at: now(), remote_url: null, ...p });
  return getProject(id)!;
}

export function updateProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "base_branch" | "repo_path" | "remote_url" | ModelRole>>,
): Project {
  const allowed = ["name", "base_branch", "repo_path", "remote_url", "model_prep", "model_dev", "model_plan", "model_do", "model_ui"];
  const entries = Object.entries(patch).filter(([k, v]) => allowed.includes(k) && v !== undefined);
  if (entries.length) {
    const sets = entries.map(([k]) => `${k} = @${k}`).join(", ");
    db.prepare(`UPDATE projects SET ${sets} WHERE id = @id`).run({ id, ...Object.fromEntries(entries) });
  }
  return getProject(id)!;
}

export function deleteProject(id: string) {
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

// ---------- cards ----------

type CardRow = Omit<Card, "files" | "tags" | "claims"> & { files: string; tags: string; claims: string; pending_input: string };

/** Card columns plus checkpoint counters. */
const CARD_SELECT = `SELECT c.*,
  (SELECT COUNT(*) FROM checkpoints k WHERE k.card_id = c.id) AS checkpoints_total,
  (SELECT COUNT(*) FROM checkpoints k WHERE k.card_id = c.id AND k.done = 1) AS checkpoints_done
  FROM cards c`;

function toCard(row: CardRow | undefined): Card | undefined {
  if (!row) return undefined;
  const { pending_input: _p, files, tags, claims, ...rest } = row;
  return { ...rest, files: safeJson(files, []), tags: safeJson(tags, []), claims: safeJson(claims, []) };
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function listCards(projectId: string): Card[] {
  const rows = db
    .prepare(`${CARD_SELECT} WHERE c.project_id = ? ORDER BY c."column", c.position`)
    .all(projectId) as CardRow[];
  return rows.map((r) => toCard(r)!);
}

export function cardsInColumn(projectId: string, column: Column): Card[] {
  const rows = db
    .prepare(`${CARD_SELECT} WHERE c.project_id = ? AND c."column" = ? ORDER BY c.position`)
    .all(projectId, column) as CardRow[];
  return rows.map((r) => toCard(r)!);
}

export function getCard(id: string): Card | undefined {
  return toCard(db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(id) as CardRow | undefined);
}

export function createCard(c: { project_id: string; title: string; spec?: string; column?: Column }): Card {
  const column = c.column ?? "backlog";
  const max = db
    .prepare('SELECT MAX(position) AS m FROM cards WHERE project_id = ? AND "column" = ?')
    .get(c.project_id, column) as { m: number | null };
  const id = nanoid(10);
  db.prepare(
    `INSERT INTO cards (id, project_id, title, spec, "column", position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, c.project_id, c.title, c.spec ?? "", column, (max.m ?? -1) + 1, now(), now());
  return getCard(id)!;
}

export interface CardPatch {
  title?: string;
  spec?: string;
  plan?: string;
  column?: Column;
  position?: number;
  status?: CardStatus;
  status_text?: string;
  branch?: string | null;
  worktree?: string | null;
  session_id?: string | null;
  prep_session_id?: string | null;
  model?: string | null;
  files?: string[];
  machine?: string | null;
  stop_req?: string | null;
  tags?: string[];
  claims?: Claim[];
  agent_model?: string | null;
}

export function updateCard(id: string, patch: CardPatch): Card {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length) {
    const sets = entries.map(([k]) => `"${k}" = @${k}`).join(", ");
    const params: Record<string, unknown> = { id, updated_at: now() };
    for (const [k, v] of entries) params[k] = k === "files" || k === "tags" || k === "claims" ? JSON.stringify(v) : v;
    db.prepare(`UPDATE cards SET ${sets}, updated_at = @updated_at WHERE id = @id`).run(params);
  }
  return getCard(id)!;
}

export function deleteCard(id: string) {
  db.prepare("DELETE FROM cards WHERE id = ?").run(id);
}

/** Put `cardId` at `index` within `column`, renumbering that column densely. */
export function placeCard(cardId: string, column: Column, index: number): Card {
  const card = getCard(cardId)!;
  const tx = db.transaction(() => {
    const others = cardsInColumn(card.project_id, column).filter((c) => c.id !== cardId);
    const i = Math.max(0, Math.min(Math.trunc(index), others.length));
    const ordered = [...others.slice(0, i), card, ...others.slice(i)];
    const stmt = db.prepare('UPDATE cards SET "column" = ?, position = ?, updated_at = ? WHERE id = ?');
    ordered.forEach((c, pos) => stmt.run(column, pos, c.id === cardId ? now() : c.updated_at, c.id));
    if (card.column !== column)
      db.prepare("UPDATE cards SET merged_at = ? WHERE id = ?").run(column === "merged" ? now() : null, cardId);
  });
  tx();
  return getCard(cardId)!;
}

export function pushPendingInput(id: string, text: string) {
  const row = db.prepare("SELECT pending_input FROM cards WHERE id = ?").get(id) as { pending_input: string };
  const list = safeJson<string[]>(row.pending_input, []);
  list.push(text);
  db.prepare("UPDATE cards SET pending_input = ? WHERE id = ?").run(JSON.stringify(list), id);
}

export function takePendingInput(id: string): string[] {
  const row = db.prepare("SELECT pending_input FROM cards WHERE id = ?").get(id) as
    | { pending_input: string }
    | undefined;
  if (!row) return [];
  db.prepare("UPDATE cards SET pending_input = '[]' WHERE id = ?").run(id);
  return safeJson<string[]>(row.pending_input, []);
}

// ---------- messages ----------

export function addMessage(cardId: string, role: MessageRole, content: string): Message {
  const created_at = now();
  const r = db
    .prepare("INSERT INTO messages (uid, card_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(uid(), cardId, role, content, created_at);
  return { id: Number(r.lastInsertRowid), card_id: cardId, role, content, created_at };
}

export function listMessages(cardId: string): Message[] {
  return db.prepare("SELECT * FROM messages WHERE card_id = ? ORDER BY created_at, id").all(cardId) as Message[];
}

// ---------- questions ----------

type QuestionRow = Omit<Question, "options"> & { options: string };

export function addQuestion(cardId: string, question: string, options: string[]) {
  db.prepare("INSERT INTO questions (uid, card_id, question, options, created_at) VALUES (?, ?, ?, ?, ?)").run(
    uid(),
    cardId,
    question,
    JSON.stringify(options),
    now(),
  );
}

export function listQuestions(cardId: string): Question[] {
  const rows = db.prepare("SELECT * FROM questions WHERE card_id = ? ORDER BY id").all(cardId) as QuestionRow[];
  return rows.map((r) => ({ ...r, options: safeJson(r.options, []) }));
}

export function openQuestions(cardId: string): Question[] {
  return listQuestions(cardId).filter((q) => q.answer === null);
}

export function answerQuestion(cardId: string, questionId: number, answer: string) {
  db.prepare("UPDATE questions SET answer = ? WHERE id = ? AND card_id = ?").run(answer, questionId, cardId);
}

// ---------- notes (shared channel between agents) ----------

const NOTE_SELECT = `SELECT n.*, c.title AS card_title FROM notes n LEFT JOIN cards c ON c.id = n.card_id`;
type NoteRow = Omit<Note, "files" | "targets" | "archived"> & { files: string; targets: string; archived: number };
const toNote = (r: NoteRow): Note => ({ ...r, files: safeJson(r.files, []), targets: safeJson(r.targets, []), archived: !!r.archived });

export function addNote(
  projectId: string,
  cardId: string | null,
  content: string,
  { files = [], targets = [] }: { files?: string[]; targets?: string[] } = {},
): Note {
  const r = db
    .prepare("INSERT INTO notes (uid, project_id, card_id, content, files, targets, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(uid(), projectId, cardId, content, JSON.stringify(files), JSON.stringify(targets), now());
  return getNote(Number(r.lastInsertRowid))!;
}

export function getNote(id: number): Note | undefined {
  const r = db.prepare(`${NOTE_SELECT} WHERE n.id = ?`).get(id) as NoteRow | undefined;
  return r && toNote(r);
}

export function listNotes(projectId: string, limit = 200): Note[] {
  return (
    db.prepare(`${NOTE_SELECT} WHERE n.project_id = ? ORDER BY n.id DESC LIMIT ?`).all(projectId, limit) as NoteRow[]
  )
    .reverse()
    .map(toNote);
}

/** Notes agents still see. */
export function liveNotes(projectId: string): Note[] {
  return (db.prepare(`${NOTE_SELECT} WHERE n.project_id = ? AND n.archived = 0 ORDER BY n.id`).all(projectId) as NoteRow[]).map(toNote);
}

export function archiveNotes(ids: number[]) {
  const stmt = db.prepare("UPDATE notes SET archived = 1 WHERE id = ? AND archived = 0");
  db.transaction(() => ids.forEach((id) => stmt.run(id)))();
}

// ---------- checkpoints ----------

type CheckpointRow = Omit<Checkpoint, "done"> & { done: number };
const toCheckpoint = (r: CheckpointRow): Checkpoint => ({ ...r, done: !!r.done });

export function listCheckpoints(cardId: string): Checkpoint[] {
  return (
    db.prepare("SELECT * FROM checkpoints WHERE card_id = ? ORDER BY position, id").all(cardId) as CheckpointRow[]
  ).map(toCheckpoint);
}

export function getCheckpoint(id: number): Checkpoint | undefined {
  const r = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as CheckpointRow | undefined;
  return r && toCheckpoint(r);
}

export function addCheckpoint(cardId: string, text: string, source: "user" | "agent" = "user"): Checkpoint {
  const max = db.prepare("SELECT MAX(position) AS m FROM checkpoints WHERE card_id = ?").get(cardId) as { m: number | null };
  const r = db
    .prepare("INSERT INTO checkpoints (uid, card_id, text, position, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(uid(), cardId, text, (max.m ?? -1) + 1, source, now());
  return getCheckpoint(Number(r.lastInsertRowid))!;
}

export function updateCheckpoint(id: number, patch: { text?: string; done?: boolean }): Checkpoint | undefined {
  if (patch.text !== undefined) db.prepare("UPDATE checkpoints SET text = ? WHERE id = ?").run(patch.text, id);
  if (patch.done !== undefined) db.prepare("UPDATE checkpoints SET done = ? WHERE id = ?").run(patch.done ? 1 : 0, id);
  return getCheckpoint(id);
}

export function deleteCheckpoint(id: number) {
  db.prepare("DELETE FROM checkpoints WHERE id = ?").run(id);
}

export function moveCheckpoint(id: number, index: number) {
  const cp = getCheckpoint(id);
  if (!cp) return;
  const others = listCheckpoints(cp.card_id).filter((c) => c.id !== id);
  const i = Math.max(0, Math.min(index, others.length));
  const ordered = [...others.slice(0, i), cp, ...others.slice(i)];
  const stmt = db.prepare("UPDATE checkpoints SET position = ? WHERE id = ?");
  db.transaction(() => ordered.forEach((c, pos) => stmt.run(pos, c.id)))();
}

// ---------- project assistant ----------
// Two conversations per project: "plan" (turns ideas into cards) and "do" (small direct changes).

export type AssistantMode = AssistantMessage["mode"];
const SESSION_COL = { plan: "assistant_session_id", do: "direct_session_id" } as const;
const PENDING_COL = { plan: "assistant_pending", do: "direct_pending" } as const;

export function addAssistantMessage(
  projectId: string,
  mode: AssistantMode,
  role: AssistantMessage["role"],
  content: string,
  cardId: string | null = null,
): AssistantMessage {
  const r = db
    .prepare("INSERT INTO assistant_messages (uid, project_id, mode, role, content, card_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(uid(), projectId, mode, role, content, cardId, now());
  return db.prepare("SELECT * FROM assistant_messages WHERE id = ?").get(r.lastInsertRowid) as AssistantMessage;
}

export function listAssistantMessages(projectId: string, mode: AssistantMode): AssistantMessage[] {
  return db
    .prepare("SELECT * FROM assistant_messages WHERE project_id = ? AND mode = ? ORDER BY created_at, id")
    .all(projectId, mode) as AssistantMessage[];
}

export function clearAssistant(projectId: string, mode: AssistantMode) {
  db.prepare("DELETE FROM assistant_messages WHERE project_id = ? AND mode = ?").run(projectId, mode);
  db.prepare(`UPDATE projects SET ${SESSION_COL[mode]} = NULL, ${PENDING_COL[mode]} = '[]' WHERE id = ?`).run(projectId);
}

export function getAssistantSession(projectId: string, mode: AssistantMode): string | null {
  const r = db.prepare(`SELECT ${SESSION_COL[mode]} AS s FROM projects WHERE id = ?`).get(projectId) as { s: string | null } | undefined;
  return r?.s ?? null;
}

export function setAssistantSession(projectId: string, mode: AssistantMode, sessionId: string | null) {
  db.prepare(`UPDATE projects SET ${SESSION_COL[mode]} = ? WHERE id = ?`).run(sessionId, projectId);
}

export function pushAssistantPending(projectId: string, mode: AssistantMode, text: string) {
  const r = db.prepare(`SELECT ${PENDING_COL[mode]} AS p FROM projects WHERE id = ?`).get(projectId) as { p: string };
  const list = safeJson<string[]>(r.p, []);
  list.push(text);
  db.prepare(`UPDATE projects SET ${PENDING_COL[mode]} = ? WHERE id = ?`).run(JSON.stringify(list), projectId);
}

export function takeAssistantPending(projectId: string, mode: AssistantMode): string[] {
  const r = db.prepare(`SELECT ${PENDING_COL[mode]} AS p FROM projects WHERE id = ?`).get(projectId) as { p: string } | undefined;
  if (!r) return [];
  db.prepare(`UPDATE projects SET ${PENDING_COL[mode]} = '[]' WHERE id = ?`).run(projectId);
  return safeJson<string[]>(r.p, []);
}
