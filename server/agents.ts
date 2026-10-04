import { z } from "zod";
import { prettyModel } from "../shared/models.js";
import type { Card } from "../shared/types.js";
import * as claims from "./claims.js";
import * as db from "./db.js";
import { emitCard, emitCheckpoints, emitMessage, emitNote, emitQuestions } from "./events.js";
import { runFakeAgent } from "./fake-agent.js";
import { commitAll } from "./git.js";
import { followPreview } from "./preview.js";
import { pushCardBranch } from "./remote.js";
import { runEngine, type ToolSpec } from "./engine.js";

export type AgentKind = "prep" | "dev";

/** Things the agent told us through its tools during a run. */
export interface Signals {
  asked: boolean;
  ready?: { plan: string; files: string[] };
  done?: string;
}

export interface RunOptions {
  card: Card;
  kind: AgentKind;
  prompt: string;
  cwd: string;
  /** Main checkout; used as config root when running inside a worktree. */
  repo: string;
  resume?: string | null;
}

export interface RunResult {
  ok: boolean;
  aborted: boolean;
  error?: string;
  sessionId: string | null;
  signals: Signals;
}

const running = new Map<string, AbortController>();

export function isRunning(cardId: string) {
  return running.has(cardId);
}

export function stopAgent(cardId: string) {
  running.get(cardId)?.abort();
}

export function runningCount() {
  return running.size;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const PREP_PROMPT = `You are working inside Trellai, a kanban board where a human (Pedro) hands features to Claude agents.
This card is in the PREPARATION column. Pedro already wrote the spec in the PLAN column.

Your job: read the spec, explore the repository (READ-ONLY — never edit files), and decide whether the feature
can be implemented without important ambiguity.

- If something is missing that would materially change the implementation, call \`ask_questions\` with 1–4
  concrete questions, each with 2–4 short options, then END YOUR TURN. Do not ask about things you can decide
  yourself with good judgement — Pedro wants you to be autonomous.
- Otherwise call \`mark_ready\` with:
  - \`checkpoints\`: the work broken into 3–10 short, concrete, verifiable steps (Spanish, one line each, e.g.
    "Añadir columna \`tips\` a la tabla \`orders\`", "Test del cálculo de propinas"). This is what Pedro reads to see
    at a glance what will be done, so make them scannable. If the card already has checkpoints (Pedro's), they are
    kept — send only the ones you want to ADD.
  - \`plan\`: optional short notes for the developer agent (decisions, gotchas) — don't repeat the checkpoints.
  - \`files\`: the files you expect to touch.
  The card will then move to DOING automatically.

Always write to Pedro in Spanish. Be brief.`;

const DEV_PROMPT = `You are working inside Trellai, a kanban board where a human (Pedro) hands features to Claude agents.
This card is in the DOING column. You are ONE OF SEVERAL agents working IN PARALLEL on the same repository;
each agent has its own git worktree and branch. Your current working directory is your worktree — only work there.

How to work:
1. Your first message lists what the other agents are touching right now. Before editing a file, call
   \`claim_files\` with the file, the area (function / component / endpoint) and what for — one call can claim
   several files, and calling it again for a file updates it. It tells you if another agent is on the same file.
   Trellai fills in the changed lines from your git diff, and claims any file you change without claiming it.
   If you claimed a file you ended up not needing, \`release_files\` it. Everything is released automatically
   when the card leaves Doing.
2. Implement the feature following the spec and plan. Run the project's tests / typecheck / lint if it has them.
3. Commits: every time you call \`check_checkpoint\`, Trellai commits ALL current changes in your worktree with the
   checkpoint text as the message, so finish a checkpoint's work before checking it. Any remaining changes are
   committed when you finish, and the branch is rebased for you. Don't rewrite history.
4. Coordination: whenever you change something other agents may depend on or collide with (shared files,
   DB schema, public APIs, shared components, new helpers, config, dependencies), call \`post_note\` with a short,
   concrete message, passing \`files\` when it's about specific files (only agents on those files get it; leave it
   empty for things that affect everyone, like a schema or a new dependency). Notes that concern you — about your
   files, addressed to you, or general — are injected into your context automatically; take them into account.
   \`read_notes\` shows them again together with what each agent is touching.
5. Only if you are truly blocked by a decision that only Pedro can make, call \`ask_questions\` and end your turn.
6. The card has CHECKPOINTS (listed with their ids in your first message; \`list_checkpoints\` shows them again).
   Each time you finish one, call \`check_checkpoint\` with its id so Pedro sees progress live. If you discover
   necessary extra work, add it with \`add_checkpoint\`. All checkpoints should be done before you finish.
7. When finished, call \`report_done\` with a short summary in Spanish of what you did and how to test it.

Write to Pedro in Spanish. Be brief.`;

// ---------------------------------------------------------------------------
// Tool handlers (shared by the real SDK agent and the fake one)
// ---------------------------------------------------------------------------

export function makeToolkit(card: Card, signals: Signals) {
  const log = (role: "system" | "assistant", content: string) =>
    emitMessage(card.project_id, db.addMessage(card.id, role, content));
  const notes = claims.notePoller(card.id);

  return {
    /** New channel notes that concern this card, for injection after each tool call. */
    pollNotes: () => notes.poll(),
    askQuestions(questions: { question: string; options: string[] }[]) {
      for (const q of questions) db.addQuestion(card.id, q.question, q.options ?? []);
      signals.asked = true;
      emitQuestions(card.project_id, card.id);
      log("system", `❓ ${questions.length} pregunta(s) para ti`);
      return "Questions delivered to Pedro. End your turn now; you'll be resumed with the answers.";
    },
    markReady(plan: string, files: string[], checkpoints: string[] = []) {
      const existing = new Set(db.listCheckpoints(card.id).map((c) => c.text.trim().toLowerCase()));
      for (const t of checkpoints) {
        const clean = t.trim();
        if (clean && !existing.has(clean.toLowerCase())) db.addCheckpoint(card.id, clean, "agent");
      }
      if (checkpoints.length) emitCheckpoints(card.project_id, card.id);
      signals.ready = { plan, files };
      return "Card marked as ready. It will move to DOING. End your turn now.";
    },
    postNote(message: string, files: string[] = []) {
      const note = db.addNote(card.project_id, card.id, message, { files: files.map((f) => f.trim()).filter(Boolean) });
      emitNote(note);
      log("system", `📣 Nota${note.files.length ? ` (${note.files.join(", ")})` : ""}: ${message}`);
      return note.files.length ? `Note posted to the agents working on ${note.files.join(", ")}.` : "Note posted to all the other agents.";
    },
    readNotes() {
      const me = db.getCard(card.id) ?? card;
      const relevant = claims.notesFor(me);
      notes.seen(relevant);
      return [
        `## What the other agents are touching\n\n${claims.othersWork(me)}`,
        `## Notes that concern you\n\n${relevant.length ? relevant.map(claims.formatNote).join("\n") : "None."}`,
      ].join("\n\n");
    },
    claimFiles: (input: { file: string; area?: string; purpose?: string }[]) => claims.claimFiles(card.id, input),
    releaseFiles: (files: string[]) => claims.releaseFiles(card.id, files),
    checkCheckpoint(id: number, done = true) {
      const cp = db.getCheckpoint(id);
      if (!cp || cp.card_id !== card.id) return `No checkpoint with id ${id} on this card.`;
      db.updateCheckpoint(id, { done });
      emitCheckpoints(card.project_id, card.id);
      if (done && !cp.done) {
        log("system", `☑ ${cp.text}`);
        // Every finished checkpoint becomes its own commit on the card's branch.
        const wt = db.getCard(card.id)?.worktree;
        if (wt) {
          try {
            const sha = commitAll(wt, cp.text);
            if (sha) {
              claims.refreshClaims(db.getCard(card.id)!);
              log("system", `📌 Commit \`${sha.slice(0, 7)}\` · ${cp.text}`);
              followPreview(db.getCard(card.id)!);
              const branch = db.getCard(card.id)?.branch;
              if (branch) pushCardBranch(wt, branch);
            }
          } catch (err) {
            console.error("[trellai] commit on checkpoint failed:", err);
          }
        }
      }
      return `Checkpoint ${id} marked as ${done ? "done" : "not done"}. Trellai committed your current changes with the checkpoint text as message.`;
    },
    addCheckpoint(text: string) {
      const cp = db.addCheckpoint(card.id, text.trim(), "agent");
      emitCheckpoints(card.project_id, card.id);
      return `Checkpoint added with id ${cp.id}.`;
    },
    listCheckpoints() {
      const cps = db.listCheckpoints(card.id);
      if (!cps.length) return "This card has no checkpoints.";
      return cps.map((c) => `[${c.done ? "x" : " "}] (id ${c.id}) ${c.text}`).join("\n");
    },
    reportDone(summary: string) {
      signals.done = summary;
      return "Done reported. End your turn now.";
    },
  };
}

export function cardTools(kind: AgentKind, kit: ReturnType<typeof makeToolkit>): ToolSpec[] {
  const ask: ToolSpec = {
    name: "ask_questions",
    description: "Ask Pedro one or more clarifying questions. After calling this, end your turn.",
    shape: {
      questions: z
        .array(
          z.object({
            question: z.string().describe("The question, in Spanish"),
            options: z.array(z.string()).describe("2-4 short answer options, in Spanish"),
          }),
        )
        .min(1)
        .max(4),
    },
    run: ({ questions }) => kit.askQuestions(questions),
  };
  if (kind === "prep")
    return [
      ask,
      {
        name: "mark_ready",
        description: "Mark the card as ready for development, with its checkpoints.",
        shape: {
          checkpoints: z
            .array(z.string())
            .describe("3-10 short, concrete, verifiable steps in Spanish (only ones not already on the card)"),
          plan: z.string().describe("Optional short notes for the developer agent, in Spanish (markdown)"),
          files: z.array(z.string()).describe("Files you expect to create or modify"),
        },
        run: ({ plan, files, checkpoints }) => kit.markReady(plan, files, checkpoints),
      },
    ];
  return [
    ask,
    {
      name: "claim_files",
      description:
        "Say which files you are about to change, where and what for, so other agents know. Tells you if another agent is on the same file.",
      shape: {
        claims: z
          .array(
            z.object({
              file: z.string().describe("Path relative to the repo root"),
              area: z.string().optional().describe("Function / component / endpoint / section you change"),
              purpose: z.string().optional().describe("What for, in a few words (Spanish)"),
            }),
          )
          .min(1),
      },
      run: ({ claims }) => kit.claimFiles(claims),
    },
    {
      name: "release_files",
      description: "Release files you claimed but no longer need (files you already changed stay claimed until the card leaves Doing).",
      shape: { files: z.array(z.string()).min(1) },
      run: ({ files }) => kit.releaseFiles(files),
    },
    {
      name: "post_note",
      description:
        "Post a short note to the other agents working in parallel on this repo. Pass `files` when it's about specific files: only agents on them get it.",
      shape: {
        message: z.string(),
        files: z.array(z.string()).optional().describe("Files the note is about (empty = it concerns every agent)"),
      },
      run: ({ message, files }) => kit.postNote(message, files ?? []),
    },
    {
      name: "read_notes",
      description: "What the other agents are touching right now, and the channel notes that concern you.",
      shape: {},
      run: () => kit.readNotes(),
    },
    {
      name: "check_checkpoint",
      description: "Mark one of the card's checkpoints as done (or undone with done=false). Commits your current changes.",
      shape: { id: z.number(), done: z.boolean().optional() },
      run: ({ id, done }) => kit.checkCheckpoint(id, done ?? true),
    },
    {
      name: "add_checkpoint",
      description: "Add a checkpoint for necessary extra work you discovered.",
      shape: { text: z.string().describe("Short step, in Spanish") },
      run: ({ text }) => kit.addCheckpoint(text),
    },
    { name: "list_checkpoints", description: "List the card's checkpoints with ids and status.", shape: {}, run: () => kit.listCheckpoints() },
    {
      name: "report_done",
      description: "Report that the feature is implemented.",
      shape: { summary: z.string().describe("Short summary in Spanish: what changed and how to test it") },
      run: ({ summary }) => kit.reportDone(summary),
    },
  ];
}

/** The model a card's agent uses: the card's own choice, else (dev only) its first tagged model, else the project's default for that phase. */
export function cardModel(card: Card, kind: AgentKind): string {
  const p = db.getProject(card.project_id);
  return card.model || (kind === "dev" ? tagModel(card) : null) || (kind === "prep" ? p?.model_prep : p?.model_dev) || "claude";
}

/** Model of the card's first tag (in the project's tag order) that has one. */
export function tagModel(card: Card): string | null {
  return db.getProject(card.project_id)?.tags.find((t) => t.model && card.tags.includes(t.id))?.model ?? null;
}

/** Everything an agent needs when it can't resume the previous session (e.g. the model changed). */
function cardContext(card: Card, kind: AgentKind) {
  const cps = db.listCheckpoints(card.id).map((c) => `- [${c.done ? "x" : " "}] (id ${c.id}) ${c.text}`).join("\n");
  return [
    `# Card: ${card.title}`,
    `## Spec (written by Pedro)\n\n${card.spec || "(empty)"}`,
    cps ? `## Checkpoints\n\n${cps}` : "",
    card.plan ? `## Notes from preparation\n\n${card.plan}` : "",
    kind === "dev"
      ? "Earlier work on this card was done by a different model. Check `git log` and `git status` in your worktree to see where it stands, then continue."
      : "Earlier preparation of this card was done by a different model.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Phase + exact model last announced in each card's activity. */
const lastModel = new Map<string, string>();

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { card, kind } = opts;
  if (running.has(card.id)) throw new Error("Agent already running for this card");

  const abort = new AbortController();
  running.set(card.id, abort);
  const signals: Signals = { asked: false };
  const kit = makeToolkit(card, signals);
  const log = (role: "assistant" | "tool" | "system", content: string) =>
    emitMessage(card.project_id, db.addMessage(card.id, role, content));

  try {
    if (process.env.TRELLAI_FAKE_AGENT) {
      const sessionId = await runFakeAgent({ ...opts, kit, log, signal: abort.signal });
      return { ok: true, aborted: abort.signal.aborted, sessionId, signals };
    }

    const res = await runEngine({
      model: cardModel(card, kind),
      cwd: opts.cwd,
      configRoot: opts.repo,
      instructions: kind === "prep" ? PREP_PROMPT : DEV_PROMPT,
      prompt: opts.prompt,
      resume: opts.resume,
      contextIfFresh: cardContext(card, kind),
      access: kind === "prep" ? "read" : "write",
      tools: cardTools(kind, kit),
      pollNotes: kind === "dev" ? kit.pollNotes : undefined,
      signal: abort.signal,
      onText: (t) => log("assistant", t),
      onTool: (t) => log("tool", t),
      onModel: (model) => {
        const seen = `${kind}|${model}`;
        if (lastModel.get(card.id) !== seen) {
          lastModel.set(card.id, seen);
          log("system", `🤖 ${kind === "prep" ? "Preparación" : "Desarrollo"} con ${prettyModel(model)} · \`${model.replace(/^codex:/, "")}\``);
        }
        if (db.getCard(card.id)?.agent_model !== model) emitCard(db.updateCard(card.id, { agent_model: model }));
      },
    });
    return { ok: !res.error, aborted: abort.signal.aborted, error: res.error, sessionId: res.sessionId, signals };
  } catch (err) {
    const aborted = abort.signal.aborted;
    return { ok: false, aborted, error: aborted ? "Detenido" : (err as Error).message, sessionId: opts.resume ?? null, signals };
  } finally {
    running.delete(card.id);
  }
}
