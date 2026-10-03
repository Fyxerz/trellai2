export const COLUMNS = [
  "backlog",
  "plan",
  "preparation",
  "doing",
  "review",
  "merged",
] as const;

export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
  backlog: "Backlog",
  plan: "Plan",
  preparation: "Preparation",
  doing: "Doing",
  review: "To Review",
  merged: "Merged",
};

/**
 * idle     – nothing happening
 * running  – an agent is working on the card
 * waiting  – the agent needs something from you (questions / a reply)
 * error    – something failed; see status_text
 */
export type CardStatus = "idle" | "running" | "waiting" | "error";

export interface Project {
  id: string;
  name: string;
  repo_path: string;
  base_branch: string;
  created_at: string;
}

export interface Card {
  id: string;
  project_id: string;
  title: string;
  spec: string;
  plan: string;
  column: Column;
  position: number;
  status: CardStatus;
  status_text: string;
  branch: string | null;
  worktree: string | null;
  /** dev session (runs in the worktree) */
  session_id: string | null;
  /** preparation session (runs in the main checkout) */
  prep_session_id: string | null;
  files: string[];
  created_at: string;
  updated_at: string;
}

export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface Message {
  id: number;
  card_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
}

export interface Question {
  id: number;
  card_id: string;
  question: string;
  options: string[];
  answer: string | null;
  created_at: string;
}

export interface Note {
  id: number;
  project_id: string;
  card_id: string | null;
  card_title: string | null;
  content: string;
  created_at: string;
}

export type ServerEvent =
  | { type: "card"; card: Card }
  | { type: "card_deleted"; id: string }
  | { type: "message"; message: Message }
  | { type: "questions"; cardId: string }
  | { type: "note"; note: Note };

export function isColumn(v: unknown): v is Column {
  return typeof v === "string" && (COLUMNS as readonly string[]).includes(v);
}
