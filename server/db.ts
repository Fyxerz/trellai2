import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { nanoid } from "nanoid";
import type {
  Annotation,
  AssistantMessage,
  Attachment,
  Card,
  Checkpoint,
  Claim,
  CardStatus,
  Column,
  Message,
  MessageRole,
  ModelRole,
  Member,
  Note,
  Person,
  Project,
  Question,
  Tag,
} from "../shared/types.js";

export const DB_PATH = resolve(process.env.TRELLAI_DB ?? "data/trellai.db");
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
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  annotated TEXT,
  annotations TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_card ON attachments(card_id);
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
db.exec(`UPDATE cards SET status = 'ready' WHERE status = 'waiting' AND status_text LIKE 'Lista —%'`);
db.exec(`UPDATE cards SET merged_at = updated_at WHERE "column" = 'merged' AND merged_at IS NULL`);
/** JSON Claim[]: what the card's agent is touching while in Doing. */
addColumn("cards", "claims", "claims TEXT NOT NULL DEFAULT '[]'");
/** Card this one was split from in Preparation (the mother closes when all its sub-cards are merged). */
addColumn("cards", "parent_id", "parent_id TEXT");
/** JSON string[]: files a note is about, and cards it's addressed to ([] = everyone). */
addColumn("notes", "files", "files TEXT NOT NULL DEFAULT '[]'");
addColumn("notes", "targets", "targets TEXT NOT NULL DEFAULT '[]'");
addColumn("notes", "archived", "archived INTEGER NOT NULL DEFAULT 0");
/** Your requests on a card: where its branch was when you sent them, to rewind there (↶). */
addColumn("messages", "head_sha", "head_sha TEXT");
addColumn("messages", "head_ahead", "head_ahead INTEGER");
addColumn("messages", "column_before", "column_before TEXT");
/** 1 = undone by a rewind. */
addColumn("messages", "undone", "undone INTEGER NOT NULL DEFAULT 0");
/** Board background: 'none' | 'color' | 'image'; its color; and when the image was generated (per computer). */
addColumn("projects", "bg_mode", "bg_mode TEXT NOT NULL DEFAULT 'none'");
addColumn("projects", "bg_color", "bg_color TEXT");
addColumn("projects", "bg_image", "bg_image TEXT");
/** 1 = a card that finishes preparation moves to Doing by itself (off by default). */
addColumn("projects", "auto_doing", "auto_doing INTEGER NOT NULL DEFAULT 0");

/** Who wrote it (Person.id): the card's creator, and whoever's Trellai wrote a message or note. */
for (const t of ["cards", "messages", "notes"]) addColumn(t, "author", "author TEXT");

db.exec(`
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  machines TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  left_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_project ON members(project_id);
-- this computer's own settings (never synced)
CREATE TABLE IF NOT EXISTS local_kv (k TEXT PRIMARY KEY, v TEXT);
`);

/** Tables whose rows use a local INTEGER id; `uid` identifies them across computers. */
export const UID_TABLES = ["messages", "questions", "notes", "checkpoints", "assistant_messages", "attachments"] as const;
for (const t of UID_TABLES) {
  addColumn(t, "uid", "uid TEXT");
  db.exec(`UPDATE ${t} SET uid = lower(hex(randomblob(8))) WHERE uid IS NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${t}_uid ON ${t}(uid)`);
}
const uid = () => nanoid(14);

const now = () => new Date().toISOString();

// ---------- projects ----------

type ProjectRow = Omit<Project, "tags" | "auto_doing"> & { tags: string; auto_doing: number };

function toProject(row: ProjectRow | undefined): Project | undefined {
  return row && { ...row, tags: safeJson<Tag[]>(row.tags, []), auto_doing: !!row.auto_doing };
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
export function ensureTag(projectId: string, name: string, color: string, model: string | null = null): Tag {
  const tags = getProject(projectId)!.tags;
  const found = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  const tag: Tag = { id: nanoid(8), name, color, model };
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
  patch: Partial<Pick<Project, "name" | "base_branch" | "repo_path" | "remote_url" | ModelRole | "bg_mode" | "bg_color" | "bg_image" | "auto_doing">>,
): Project {
  const allowed = ["name", "base_branch", "repo_path", "remote_url", "model_prep", "model_dev", "model_plan", "model_do", "model_ui", "bg_mode", "bg_color", "bg_image", "auto_doing"];
  const entries = Object.entries(patch)
    .filter(([k, v]) => allowed.includes(k) && v !== undefined)
    .map(([k, v]) => [k, k === "auto_doing" ? (v ? 1 : 0) : v] as const);
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

export function createCard(c: { project_id: string; title: string; spec?: string; column?: Column; parent_id?: string | null }): Card {
  const column = c.column ?? "backlog";
  const max = db
    .prepare('SELECT MAX(position) AS m FROM cards WHERE project_id = ? AND "column" = ?')
    .get(c.project_id, column) as { m: number | null };
  const id = nanoid(10);
  db.prepare(
    `INSERT INTO cards (id, project_id, title, spec, "column", position, parent_id, author, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, c.project_id, c.title, c.spec ?? "", column, (max.m ?? -1) + 1, c.parent_id ?? null, meId(), now(), now());
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
  parent_id?: string | null;
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

/** Sub-cards split from this card. */
export function childCards(parentId: string): Card[] {
  return (db.prepare(`${CARD_SELECT} WHERE c.parent_id = ? ORDER BY c.created_at, c.rowid`).all(parentId) as CardRow[]).map((r) => toCard(r)!);
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

export function clearPendingInput(id: string) {
  db.prepare("UPDATE cards SET pending_input = '[]' WHERE id = ?").run(id);
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
  const author = meId();
  const r = db
    .prepare("INSERT INTO messages (uid, card_id, role, content, author, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(uid(), cardId, role, content, author, created_at);
  return { id: Number(r.lastInsertRowid), card_id: cardId, role, content, created_at, head_sha: null, head_ahead: null, column_before: null, undone: false, author };
}

type MessageRow = Omit<Message, "undone"> & { undone: number; uid: string };
const toMessage = ({ uid: _u, ...r }: MessageRow): Message => ({ ...r, undone: !!r.undone });

export function listMessages(cardId: string): Message[] {
  return (db.prepare("SELECT * FROM messages WHERE card_id = ? ORDER BY created_at, id").all(cardId) as MessageRow[]).map(toMessage);
}

export function getMessage(id: number): Message | undefined {
  const r = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
  return r && toMessage(r);
}

/** Where the card's branch was when this message was sent (see `rewindTo`). */
export function setMessageHead(id: number, head: { sha: string; ahead: number; column: Column }): Message {
  db.prepare("UPDATE messages SET head_sha = ?, head_ahead = ?, column_before = ? WHERE id = ?").run(head.sha, head.ahead, head.column, id);
  return getMessage(id)!;
}

/** Mark this message and everything after it on the card as undone; returns the ones that changed. */
export function markUndoneFrom(cardId: string, from: Message): Message[] {
  const ids = (
    db
      .prepare("SELECT id FROM messages WHERE card_id = ? AND undone = 0 AND (created_at > ? OR (created_at = ? AND id >= ?))")
      .all(cardId, from.created_at, from.created_at, from.id) as { id: number }[]
  ).map((r) => r.id);
  const stmt = db.prepare("UPDATE messages SET undone = 1 WHERE id = ?");
  db.transaction(() => ids.forEach((id) => stmt.run(id)))();
  return ids.map((id) => getMessage(id)!);
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
    .prepare("INSERT INTO notes (uid, project_id, card_id, content, files, targets, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(uid(), projectId, cardId, content, JSON.stringify(files), JSON.stringify(targets), meId(), now());
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

// ---------- attachments (images on a card; base64 so they travel with the sync) ----------

const ATTACHMENT_COLS = "id, uid, card_id, name, mime, annotations, annotated IS NOT NULL AS has_annotated, created_at";
type AttachmentRow = Omit<Attachment, "annotations" | "has_annotated"> & { annotations: string; has_annotated: number };
const toAttachment = (r: AttachmentRow): Attachment => ({ ...r, annotations: safeJson(r.annotations, []), has_annotated: !!r.has_annotated });

export function listAttachments(cardId: string): Attachment[] {
  return (
    db.prepare(`SELECT ${ATTACHMENT_COLS} FROM attachments WHERE card_id = ? ORDER BY created_at, id`).all(cardId) as AttachmentRow[]
  ).map(toAttachment);
}

export function getAttachment(id: number): Attachment | undefined {
  const r = db.prepare(`SELECT ${ATTACHMENT_COLS} FROM attachments WHERE id = ?`).get(id) as AttachmentRow | undefined;
  return r && toAttachment(r);
}

/** By uid: the same image on every computer (chat messages link to it this way). */
export function getAttachmentByUid(uid: string): Attachment | undefined {
  const r = db.prepare(`SELECT ${ATTACHMENT_COLS} FROM attachments WHERE uid = ?`).get(uid) as AttachmentRow | undefined;
  return r && toAttachment(r);
}

/** The image bytes (base64), or the copy with the boxes drawn on it. */
export function attachmentData(id: number, annotated = false): string | null {
  const r = db.prepare("SELECT data, annotated FROM attachments WHERE id = ?").get(id) as { data: string; annotated: string | null } | undefined;
  return r ? (annotated ? r.annotated : r.data) : null;
}

export function addAttachment(
  cardId: string,
  a: { name: string; mime: string; data: string; annotated?: string | null; annotations?: Annotation[] },
): Attachment {
  const r = db
    .prepare("INSERT INTO attachments (uid, card_id, name, mime, data, annotated, annotations, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(uid(), cardId, a.name, a.mime, a.data, a.annotated ?? null, JSON.stringify(a.annotations ?? []), now());
  return getAttachment(Number(r.lastInsertRowid))!;
}

/** `annotated: null` drops the drawn copy (e.g. no boxes left). */
export function updateAttachment(id: number, patch: { annotations?: Annotation[]; annotated?: string | null; name?: string }): Attachment | undefined {
  if (patch.annotations !== undefined) db.prepare("UPDATE attachments SET annotations = ? WHERE id = ?").run(JSON.stringify(patch.annotations), id);
  if (patch.annotated !== undefined) db.prepare("UPDATE attachments SET annotated = ? WHERE id = ?").run(patch.annotated, id);
  if (patch.name !== undefined) db.prepare("UPDATE attachments SET name = ? WHERE id = ?").run(patch.name, id);
  return getAttachment(id);
}

export function deleteAttachment(id: number) {
  db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
}

/** Copy a card's images to another card (duplicating a card). */
export function copyAttachments(fromCardId: string, toCardId: string) {
  const rows = db.prepare("SELECT name, mime, data, annotated, annotations FROM attachments WHERE card_id = ? ORDER BY created_at, id").all(fromCardId) as {
    name: string;
    mime: string;
    data: string;
    annotated: string | null;
    annotations: string;
  }[];
  for (const r of rows) addAttachment(toCardId, { ...r, annotations: safeJson(r.annotations, []) });
}

// ---------- people (who uses Trellai) and project members ----------

export function localGet(k: string): string | undefined {
  return (db.prepare("SELECT v FROM local_kv WHERE k = ?").get(k) as { v: string } | undefined)?.v;
}
export function localSet(k: string, v: string | null) {
  if (v === null) db.prepare("DELETE FROM local_kv WHERE k = ?").run(k);
  else db.prepare("INSERT OR REPLACE INTO local_kv (k, v) VALUES (?, ?)").run(k, v);
}

type PersonRow = Omit<Person, "machines"> & { machines: string };
const toPerson = (r: PersonRow): Person => ({ ...r, machines: safeJson(r.machines, []) });

export function listPeople(): Person[] {
  return (db.prepare("SELECT * FROM people ORDER BY name").all() as PersonRow[]).map(toPerson);
}

export function getPerson(id: string): Person | undefined {
  const r = db.prepare("SELECT * FROM people WHERE id = ?").get(id) as PersonRow | undefined;
  return r && toPerson(r);
}

/** The person using this computer (set the first time Trellai opens; null until then). */
export function meId(): string | null {
  return localGet("me") ?? null;
}
export function me(): Person | undefined {
  const id = meId();
  return id ? getPerson(id) : undefined;
}

/** Create or update this computer's person (`adopt`: "I'm this person already", from another computer). */
export function setMe(p: { name: string; color: string; adopt?: string }, machine: string): Person {
  const id = (p.adopt && getPerson(p.adopt) ? p.adopt : meId()) ?? nanoid(10);
  const existing = getPerson(id);
  const machines = [...new Set([...(existing?.machines ?? []), machine])];
  db.prepare("INSERT OR REPLACE INTO people (id, name, color, machines, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    p.name,
    p.color,
    JSON.stringify(machines),
    now(),
  );
  localSet("me", id);
  return getPerson(id)!;
}

/** Make sure this computer is listed under its person (e.g. after TRELLAI_MACHINE changes). */
export function registerMachine(machine: string) {
  const p = me();
  if (p && !p.machines.includes(machine))
    db.prepare("UPDATE people SET machines = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...p.machines, machine]), now(), p.id);
}

/** Whose computer is it (by Card.machine). */
export function personOnMachine(machine: string | null): Person | undefined {
  return machine ? listPeople().find((p) => p.machines.includes(machine)) : undefined;
}

export function listMembers(projectId: string): Member[] {
  return db.prepare("SELECT * FROM members WHERE project_id = ? ORDER BY joined_at").all(projectId) as Member[];
}

/** (Re)join: `left_at` back to null. */
export function joinProject(projectId: string, personId: string): Member {
  const id = `${projectId}:${personId}`;
  const existing = db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Member | undefined;
  if (!existing) db.prepare("INSERT INTO members (id, project_id, person_id, joined_at) VALUES (?, ?, ?, ?)").run(id, projectId, personId, now());
  else if (existing.left_at) db.prepare("UPDATE members SET left_at = NULL, joined_at = ? WHERE id = ?").run(now(), id);
  return db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Member;
}

export function leaveProject(projectId: string, personId: string) {
  db.prepare("UPDATE members SET left_at = ? WHERE id = ? AND left_at IS NULL").run(now(), `${projectId}:${personId}`);
}
