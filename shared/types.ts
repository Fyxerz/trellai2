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
  /** Default models per role ("claude", "claude:opus", "codex", "codex:<model>") */
  model_prep: string;
  model_dev: string;
  model_plan: string;
  model_do: string;
  /** Model for cards the assistant marks as interface/visual work (null = same as model_dev) */
  model_ui: string | null;
  /** Card whose branch is currently checked out in the main repo ("Ver esta rama") */
  preview_card_id: string | null;
  /** git remote (to find/clone the repo on another computer) */
  remote_url: string | null;
  /** tags you can put on this project's cards */
  tags: Tag[];
  created_at: string;
}

export interface Tag {
  id: string;
  name: string;
  /** hex color */
  color: string;
}

export const TAG_COLORS = ["#f87171", "#fb923c", "#facc15", "#4ade80", "#2dd4bf", "#60a5fa", "#a78bfa", "#f472b6", "#a1a1aa"];

export type ModelRole = "model_prep" | "model_dev" | "model_plan" | "model_do" | "model_ui";

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
  /** What the card's agent is touching right now (only while in Doing; cleared when it leaves) */
  claims: Claim[];
  /** Model override for this card (null = project default) */
  model: string | null;
  /** Exact model of the agent's latest run, e.g. "claude-opus-5-5" or "codex:gpt-5-codex" */
  agent_model: string | null;
  /** computer that runs this card's agent / holds its worktree (null = none yet) */
  machine: string | null;
  /** another computer asked `machine` to stop the agent */
  stop_req?: string | null;
  /** ids of the project's tags on this card */
  tags: string[];
  checkpoints_total: number;
  checkpoints_done: number;
  created_at: string;
  updated_at: string;
}

export interface Checkpoint {
  id: number;
  card_id: string;
  text: string;
  done: boolean;
  position: number;
  /** who created it */
  source: "user" | "agent";
  created_at: string;
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

/** A file an agent in Doing is working on. */
export interface Claim {
  file: string;
  /** function / component / endpoint it changes ("" = not said) */
  area: string;
  /** what for ("" = not said) */
  purpose: string;
  /** changed lines in the agent's version, computed by Trellai from git ("" = untouched so far, "nuevo" = new file) */
  lines: string;
  /** plan: predicted in Preparation · agent: declared with claim_files · auto: seen in its git diff */
  source: "plan" | "agent" | "auto";
}

export interface Note {
  id: number;
  project_id: string;
  /** author card (null = Pedro or Trellai) */
  card_id: string | null;
  card_title: string | null;
  content: string;
  /** files it's about: only agents working on one of them get it ([] = everyone) */
  files: string[];
  /** cards it's addressed to ([] = every agent) */
  targets: string[];
  /** no longer shown to agents: its card left Doing, or it was archived by hand */
  archived: boolean;
  created_at: string;
}

/** A message in the project assistant conversation. */
export interface AssistantMessage {
  id: number;
  project_id: string;
  /** "plan": turns ideas into cards · "do": small direct changes in the repo */
  mode: "plan" | "do";
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  /** set when the message refers to a card the assistant created/updated */
  card_id: string | null;
  created_at: string;
}

/** A rectangle on an image, in relative coordinates (0–1), with Pedro's comment. */
export interface Annotation {
  x: number;
  y: number;
  w: number;
  h: number;
  comment: string;
}

/** An image attached to a card (the bytes are served by /api/attachments/:id/image). */
export interface Attachment {
  id: number;
  uid: string;
  card_id: string;
  name: string;
  mime: string;
  annotations: Annotation[];
  /** there is a copy with the numbered boxes drawn on it (?annotated=1) */
  has_annotated: boolean;
  created_at: string;
}

export type ServerEvent =
  | { type: "card"; card: Card }
  | { type: "card_deleted"; id: string }
  | { type: "message"; message: Message }
  | { type: "questions"; cardId: string }
  | { type: "checkpoints"; cardId: string }
  | { type: "attachments"; cardId: string }
  | { type: "note"; note: Note }
  | { type: "assistant_message"; message: AssistantMessage }
  | { type: "assistant_status"; mode: "plan" | "do"; running: boolean }
  | { type: "preview"; cardId: string | null }
  | { type: "tags"; tags: Tag[] }
  /** another computer changed things: reload the board */
  | { type: "sync" }
  /** Trellai's own code changed (branch switch): a new UI build, or a restart pending */
  | { type: "build"; id: string };

/** "listNotes() — filtrar por ficheros · líneas 40-60" */
export function describeClaim(c: Claim): string {
  const what = [c.area, c.purpose].filter(Boolean).join(" — ") || (c.source === "plan" ? "previsto" : "sin detallar");
  const where = c.lines === "nuevo" ? "fichero nuevo" : c.lines === "borrado" ? "lo borra" : c.lines ? `líneas ${c.lines}` : "";
  return [what, where].filter(Boolean).join(" · ");
}

export function isColumn(v: unknown): v is Column {
  return typeof v === "string" && (COLUMNS as readonly string[]).includes(v);
}
