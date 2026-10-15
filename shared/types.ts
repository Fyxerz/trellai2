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
 * ready    – prepared and waiting to be moved to Doing (nothing needed from you)
 * queued   – its agent waits for a free slot (the project's max_agents); starts by itself
 * error    – something failed; see status_text
 */
export type CardStatus = "idle" | "running" | "waiting" | "ready" | "queued" | "error";

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
  /** Board background */
  bg_mode: BgMode;
  /** hex color (bg_mode "color", and fallback when the image is missing) */
  bg_color: string | null;
  /** when this computer last generated `.trellai/background.*` (ms, as text; cache-buster) — null = no image */
  bg_image: string | null;
  /** When preparation finishes, move the card to Doing by itself (otherwise it waits in Preparation) */
  auto_doing: boolean;
  /** Command that starts the app for the Vista (null = detected from package.json: `npm run dev`…) */
  preview_command: string | null;
  /** Card agents (preparation, development, conflicts) running at once on each computer; the rest wait «En cola» */
  max_agents: number;
  created_at: string;
}

export const DEFAULT_MAX_AGENTS = 3;

/** Tokens an agent used (cache reads are what it re-reads of its own conversation on every call). */
export interface Usage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** estimate at API prices (US$); 0 when the engine doesn't say (Codex) */
  cost_usd: number;
}

export const usageTotal = (u: Pick<Usage, "input" | "output" | "cache_read" | "cache_write">) => u.input + u.output + u.cache_read + u.cache_write;

/** GET /api/projects/:id/usage: what this project's agents spent (on this computer). */
export interface ProjectUsage {
  total: Usage;
  /** card agents (preparation, development, conflicts) */
  cards: Usage;
  /** project assistant (Tarjetas and Directo chats) */
  assistant: Usage;
  /** last 24 h */
  today: Usage;
  runs: number;
}

/** "1,2M", "980k", "512" */
export function formatTokens(n: number): string {
  const fmt = (x: number, unit: string) => `${(Math.round(x * 10) / 10).toLocaleString("es-ES", { maximumFractionDigits: x < 10 ? 1 : 0 })}${unit}`;
  if (n >= 1e9) return fmt(n / 1e9, "B");
  if (n >= 1e6) return fmt(n / 1e6, "M");
  if (n >= 1e3) return fmt(n / 1e3, "k");
  return String(Math.round(n));
}

/** "1,2M tokens (980k de caché) · ≈ 3,21 US$" */
export function describeUsage(u: Usage): string {
  const cache = u.cache_read ? ` (${formatTokens(u.cache_read)} de caché)` : "";
  const cost = u.cost_usd >= 0.005 ? ` · ≈ ${u.cost_usd.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} US$` : "";
  return `${formatTokens(usageTotal(u))} tokens${cache}${cost}`;
}

export type BgMode = "none" | "color" | "image";

/** Background image generation for a project (runs on this computer). */
export interface BgStatus {
  running: boolean;
  error: string | null;
  /** what the model is doing right now */
  activity: string | null;
}

/** A repo of your GitHub account, as listed by the `gh` CLI ("Clonar de GitHub"). */
export interface GitHubRepo {
  /** "owner/name" */
  name: string;
  description: string | null;
  private: boolean;
  updated_at: string;
  /** URL to clone with, following `gh config get git_protocol` (ssh or https) */
  clone_url: string;
}

/** GET /api/github/repos: whether `gh` is installed, logged in, and your repos. */
export interface GitHubRepos {
  available: boolean;
  loggedIn: boolean;
  repos: GitHubRepo[];
  error?: string;
}

/** Whether `gh` is installed and logged in (GET /api/github/status). */
export interface GitHubStatus {
  available: boolean;
  loggedIn: boolean;
  login: string | null;
  /** The «Conectar GitHub» flow (`gh auth login --web`), if one was started. */
  loginFlow?: GitHubLoginFlow;
}

/** POST /api/github/login, and `loginFlow` in GET /api/github/status. */
export interface GitHubLoginFlow {
  running: boolean;
  /** one-time code to paste at `url` */
  code?: string;
  url?: string;
  error?: string;
}

/** What the UI can offer when syncing with a remote fails: «Usar HTTPS» or «Conectar GitHub». */
export type SyncFix = "https" | "github-login";

/** A background "clone from GitHub" (GET /api/clone-jobs/:id). */
export interface CloneJob {
  stage: "cloning" | "creating" | "done" | "error";
  /** 0–100 while cloning (git's "Receiving objects" / "Resolving deltas"). */
  percent?: number;
  /** What git is doing right now, or the error. */
  message?: string;
  project?: Project;
}

export interface Tag {
  id: string;
  name: string;
  /** hex color */
  color: string;
  /** model the dev agent uses on cards with this tag (unless the card picks its own); absent = none */
  model?: string | null;
}

/** Colors offered in the tag manager's grid (TAG_COLORS are used, in order, for new tags). */
export const TAG_PALETTE = [
  "#f87171", "#fb923c", "#fbbf24", "#facc15", "#a3e635", "#4ade80", "#34d399", "#2dd4bf",
  "#22d3ee", "#38bdf8", "#60a5fa", "#818cf8", "#a78bfa", "#c084fc", "#e879f9", "#f472b6",
  "#fb7185", "#dc2626", "#ea580c", "#16a34a", "#0d9488", "#2563eb", "#7c3aed", "#a1a1aa",
];

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
  /** when it entered Merged (null outside Merged) */
  merged_at: string | null;
  /** card it was split from in Preparation (null = not a sub-card) */
  parent_id: string | null;
  /** person who created it (Person.id; null = before people existed) */
  author: string | null;
  /** the project's "rama de retoques": small changes pointed at in the Vista of the base branch */
  touchup: boolean;
  /** tokens its agents used, every run added up (on this computer), and how many of them were cache reads */
  tokens: number;
  tokens_cache: number;
  /** estimate at API prices (US$) */
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

/**
 * The Vista: the app running from a card's worktree (or from the base branch) inside Trellai.
 * GET /api/cards/:id/vista and /api/projects/:id/vista.
 */
export interface VistaStatus {
  /** what is shown: a card's branch, or the base branch (`cardId` null) */
  cardId: string | null;
  /** branch name, for the header */
  branch: string;
  /**
   * stopped   – not running (opening the Vista starts it)
   * waiting   – the card's worktree isn't ready yet (its agent is about to create it)
   * installing – installing the project's dependencies in the worktree
   * starting  – the app's dev server is starting
   * ready     – open it at `port`
   * error     – see `message` and `log`
   */
  state: "stopped" | "waiting" | "installing" | "starting" | "ready" | "error";
  /** port of Trellai's proxy in front of the app (same host as Trellai) */
  port: number | null;
  /** command that runs (or would run) the app */
  command: string | null;
  /** why it's waiting, or what went wrong */
  message: string | null;
  /** last lines the server printed */
  log: string[];
}

/** An element Pedro pointed at in the Vista, with what he wants changed. */
export interface VistaPin {
  comment: string;
  /** page where it was picked ("/tarjetas?x=1") */
  page: string;
  /** opening tag as it is in the page: <button class="primary" type="submit"> */
  tag: string;
  /** its visible text */
  text: string;
  /** a CSS selector that finds it */
  selector: string;
  /** "96×32" (CSS px) */
  size: string;
  /** components around it, innermost first (React, Vue, Svelte in development) */
  components: string[];
  /** its source file (and line) when the framework exposes it in development */
  source: string;
  /** what's next to it: "Cancelar · »Guardar« · ⋯" */
  siblings: string;
  /** the styles that matter: "padding 6px 12px · font 13px/600 · fondo #4f46e5" */
  styles: string;
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
  /** your requests on a card with a branch: its HEAD (and commits ahead of base) when you sent it */
  head_sha: string | null;
  head_ahead: number | null;
  /** column the card was in when you sent it (where ↶ takes it back) */
  column_before: Column | null;
  /** undone by a rewind (↶) */
  undone: boolean;
  /** person whose Trellai wrote it (Person.id; null = before people existed) */
  author: string | null;
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
  /** person who wrote it, or whose agent did (Person.id; null = before people existed) */
  author: string | null;
  created_at: string;
}

/** Someone using Trellai (one per person, shared by their computers). */
export interface Person {
  id: string;
  name: string;
  /** hex color of their avatar */
  color: string;
  /** computers they use (Card.machine values) */
  machines: string[];
  updated_at: string;
}

/** Someone who shares a project (joined with an invitation code, or created it). */
export interface Member {
  id: string;
  project_id: string;
  person_id: string;
  joined_at: string;
  /** they left, or were removed (null = still in) */
  left_at: string | null;
}

/** GET /api/projects/:id/sharing */
export interface Sharing {
  members: Member[];
  /** this computer reaches the project through an invitation (its own database), not TRELLAI_DATABASE_URL */
  share: { id: string; host: string } | null;
  /** TRELLAI_DATABASE_URL is set here (an invitation can reuse it) */
  ownDb: boolean;
  /** why an invitation can't be made ("" = it can) */
  problem: string;
  /** shared automatically with whoever has the repo (the invitation is published in it) */
  auto: { enabled: boolean; on: boolean; reason: string };
}

export const AVATAR_COLORS = ["#f87171", "#fb923c", "#facc15", "#4ade80", "#2dd4bf", "#38bdf8", "#818cf8", "#c084fc", "#f472b6", "#a1a1aa"];

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

/** An image Pedro attached to a message to the project assistant. */
export interface AssistantImage {
  id: number;
  uid: string;
  project_id: string;
  mode: "plan" | "do";
  name: string;
  mime: string;
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
  /** background image generation started/progressed/finished */
  | { type: "background"; status: BgStatus }
  /** another computer changed things: reload the board */
  | { type: "sync" }
  /** the base branch was pulled automatically: refresh ahead/behind */
  | { type: "git" }
  /** an agent finished a run and its tokens were added up: refresh the project's total */
  | { type: "usage" }
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
