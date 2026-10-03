import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { nanoid } from "nanoid";
import type {
  Card,
  CardStatus,
  Column,
  Message,
  MessageRole,
  Note,
  Project,
  Question,
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
CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_card ON messages(card_id);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
`);

const now = () => new Date().toISOString();

// ---------- projects ----------

export function listProjects(): Project[] {
  return db.prepare("SELECT * FROM projects ORDER BY created_at").all() as Project[];
}

export function getProject(id: string): Project | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
}

export function createProject(p: { name: string; repo_path: string; base_branch: string }): Project {
  const project: Project = { id: nanoid(10), created_at: now(), ...p };
  db.prepare(
    "INSERT INTO projects (id, name, repo_path, base_branch, created_at) VALUES (@id, @name, @repo_path, @base_branch, @created_at)",
  ).run(project);
  return project;
}

export function deleteProject(id: string) {
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

// ---------- cards ----------

type CardRow = Omit<Card, "files"> & { files: string; pending_input: string };

function toCard(row: CardRow | undefined): Card | undefined {
  if (!row) return undefined;
  const { pending_input: _p, files, ...rest } = row;
  return { ...rest, files: safeJson(files, []) };
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
    .prepare('SELECT * FROM cards WHERE project_id = ? ORDER BY "column", position')
    .all(projectId) as CardRow[];
  return rows.map((r) => toCard(r)!);
}

export function cardsInColumn(projectId: string, column: Column): Card[] {
  const rows = db
    .prepare('SELECT * FROM cards WHERE project_id = ? AND "column" = ? ORDER BY position')
    .all(projectId, column) as CardRow[];
  return rows.map((r) => toCard(r)!);
}

export function getCard(id: string): Card | undefined {
  return toCard(db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | undefined);
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
  files?: string[];
}

export function updateCard(id: string, patch: CardPatch): Card {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length) {
    const sets = entries.map(([k]) => `"${k}" = @${k}`).join(", ");
    const params: Record<string, unknown> = { id, updated_at: now() };
    for (const [k, v] of entries) params[k] = k === "files" ? JSON.stringify(v) : v;
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
    .prepare("INSERT INTO messages (card_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    .run(cardId, role, content, created_at);
  return { id: Number(r.lastInsertRowid), card_id: cardId, role, content, created_at };
}

export function listMessages(cardId: string): Message[] {
  return db.prepare("SELECT * FROM messages WHERE card_id = ? ORDER BY id").all(cardId) as Message[];
}

// ---------- questions ----------

type QuestionRow = Omit<Question, "options"> & { options: string };

export function addQuestion(cardId: string, question: string, options: string[]) {
  db.prepare("INSERT INTO questions (card_id, question, options, created_at) VALUES (?, ?, ?, ?)").run(
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

export function addNote(projectId: string, cardId: string | null, content: string): Note {
  const r = db
    .prepare("INSERT INTO notes (project_id, card_id, content, created_at) VALUES (?, ?, ?, ?)")
    .run(projectId, cardId, content, now());
  return db.prepare(`${NOTE_SELECT} WHERE n.id = ?`).get(r.lastInsertRowid) as Note;
}

export function listNotes(projectId: string, limit = 200): Note[] {
  return (
    db.prepare(`${NOTE_SELECT} WHERE n.project_id = ? ORDER BY n.id DESC LIMIT ?`).all(projectId, limit) as Note[]
  ).reverse();
}

/** Notes from *other* cards newer than `afterId`. */
export function notesSince(projectId: string, cardId: string, afterId: number): Note[] {
  return db
    .prepare(
      `${NOTE_SELECT} WHERE n.project_id = ? AND n.id > ? AND (n.card_id IS NULL OR n.card_id != ?) ORDER BY n.id`,
    )
    .all(projectId, afterId, cardId) as Note[];
}

export function lastNoteId(projectId: string): number {
  const r = db.prepare("SELECT MAX(id) AS m FROM notes WHERE project_id = ?").get(projectId) as { m: number | null };
  return r.m ?? 0;
}
