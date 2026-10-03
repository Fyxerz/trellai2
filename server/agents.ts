import { createSdkMcpServer, query, tool, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Card } from "../shared/types.js";
import * as db from "./db.js";
import { emitMessage, emitNote, emitQuestions } from "./events.js";
import { runFakeAgent } from "./fake-agent.js";

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
- Otherwise call \`mark_ready\` with a short technical plan (steps, files to touch, how to verify) and the list
  of files you expect to touch. The card will then move to DOING automatically.

Always write to Pedro in Spanish. Be brief.`;

const DEV_PROMPT = `You are working inside Trellai, a kanban board where a human (Pedro) hands features to Claude agents.
This card is in the DOING column. You are ONE OF SEVERAL agents working IN PARALLEL on the same repository;
each agent has its own git worktree and branch. Your current working directory is your worktree — only work there.

How to work:
1. Call \`read_notes\` first to see what the other agents are doing.
2. Implement the feature following the spec and plan. Run the project's tests / typecheck / lint if it has them.
3. You don't need to commit — Trellai commits and rebases your branch when you finish.
4. Coordination: whenever you change something other agents may depend on or collide with (shared files,
   DB schema, public APIs, shared components, new helpers, config, dependencies), call \`post_note\` with a short,
   concrete message. Notes from other agents are injected into your context automatically — take them into account.
5. Only if you are truly blocked by a decision that only Pedro can make, call \`ask_questions\` and end your turn.
6. When finished, call \`report_done\` with a short summary in Spanish of what you did and how to test it.

Write to Pedro in Spanish. Be brief.`;

// ---------------------------------------------------------------------------
// Tool handlers (shared by the real SDK agent and the fake one)
// ---------------------------------------------------------------------------

export function makeToolkit(card: Card, signals: Signals) {
  const log = (role: "system" | "assistant", content: string) =>
    emitMessage(card.project_id, db.addMessage(card.id, role, content));

  return {
    askQuestions(questions: { question: string; options: string[] }[]) {
      for (const q of questions) db.addQuestion(card.id, q.question, q.options ?? []);
      signals.asked = true;
      emitQuestions(card.project_id, card.id);
      log("system", `❓ ${questions.length} pregunta(s) para ti`);
      return "Questions delivered to Pedro. End your turn now; you'll be resumed with the answers.";
    },
    markReady(plan: string, files: string[]) {
      signals.ready = { plan, files };
      return "Card marked as ready. It will move to DOING. End your turn now.";
    },
    postNote(message: string) {
      const note = db.addNote(card.project_id, card.id, message);
      emitNote(note);
      log("system", `📣 Nota: ${message}`);
      return "Note posted to the other agents.";
    },
    readNotes() {
      const notes = db.listNotes(card.project_id, 50).filter((n) => n.card_id !== card.id);
      if (!notes.length) return "No notes from other agents yet.";
      return notes.map((n) => `[${n.card_title ?? "Trellai"}] ${n.content}`).join("\n");
    },
    reportDone(summary: string) {
      signals.done = summary;
      return "Done reported. End your turn now.";
    },
  };
}

function buildMcpServer(kind: AgentKind, kit: ReturnType<typeof makeToolkit>) {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const questionsSchema = {
    questions: z
      .array(
        z.object({
          question: z.string().describe("The question, in Spanish"),
          options: z.array(z.string()).describe("2-4 short answer options, in Spanish"),
        }),
      )
      .min(1)
      .max(4),
  };
  const ask = tool(
    "ask_questions",
    "Ask Pedro one or more clarifying questions. After calling this, end your turn.",
    questionsSchema,
    async ({ questions }) => text(kit.askQuestions(questions)),
  );

  const tools =
    kind === "prep"
      ? [
          ask,
          tool(
            "mark_ready",
            "Mark the card as ready for development, with the technical plan.",
            {
              plan: z.string().describe("Short technical plan in Spanish (markdown)"),
              files: z.array(z.string()).describe("Files you expect to create or modify"),
            },
            async ({ plan, files }) => text(kit.markReady(plan, files)),
          ),
        ]
      : [
          ask,
          tool(
            "post_note",
            "Post a short note to the other agents working in parallel on this repo.",
            { message: z.string() },
            async ({ message }) => text(kit.postNote(message)),
          ),
          tool("read_notes", "Read the recent notes posted by other agents.", {}, async () => text(kit.readNotes())),
          tool(
            "report_done",
            "Report that the feature is implemented.",
            { summary: z.string().describe("Short summary in Spanish: what changed and how to test it") },
            async ({ summary }) => text(kit.reportDone(summary)),
          ),
        ];

  return createSdkMcpServer({ name: "trellai", version: "2.0.0", tools });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const short = name.replace(/^mcp__trellai__/, "");
  const arg =
    input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.description ?? input.url ?? "";
  const s = String(arg).replace(/\s+/g, " ");
  return s ? `${short} · ${s.length > 140 ? s.slice(0, 140) + "…" : s}` : short;
}

const SILENT_TOOLS = new Set(["ask_questions", "mark_ready", "post_note", "report_done"]);

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

    // Inject notes from other agents after every tool call.
    let lastSeen = db.lastNoteId(card.project_id);
    const noteHook: HookCallback = async () => {
      const fresh = db.notesSince(card.project_id, card.id, lastSeen);
      if (!fresh.length) return {};
      lastSeen = fresh[fresh.length - 1].id;
      const body = fresh.map((n) => `- [${n.card_title ?? "Trellai"}] ${n.content}`).join("\n");
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `New notes from the other agents working in parallel:\n${body}`,
        },
      };
    };

    let sessionId: string | null = opts.resume ?? null;
    let error: string | undefined;

    const q = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        resume: opts.resume ?? undefined,
        abortController: abort,
        model: process.env.TRELLAI_MODEL || undefined,
        systemPrompt: { type: "preset", preset: "claude_code", append: kind === "prep" ? PREP_PROMPT : DEV_PROMPT },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        disallowedTools:
          kind === "prep"
            ? ["Edit", "Write", "NotebookEdit", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]
            : ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"],
        mcpServers: { trellai: buildMcpServer(kind, kit) },
        hooks: kind === "dev" ? { PostToolUse: [{ hooks: [noteHook] }] } : undefined,
        projectConfigRoot: opts.cwd !== opts.repo ? opts.repo : undefined,
      },
    });

    for await (const m of q as AsyncIterable<SDKMessage>) {
      if ("session_id" in m && m.session_id) sessionId = m.session_id;
      if (m.type === "assistant" && !m.parent_tool_use_id) {
        for (const block of m.message.content) {
          if (block.type === "text" && block.text.trim()) log("assistant", block.text.trim());
          if (block.type === "tool_use") {
            const name = block.name.replace(/^mcp__trellai__/, "");
            if (!SILENT_TOOLS.has(name)) log("tool", summarizeToolUse(block.name, block.input as Record<string, unknown>));
          }
        }
      } else if (m.type === "result") {
        if (m.subtype !== "success") {
          error = ("errors" in m && Array.isArray(m.errors) && m.errors.join("; ")) || m.subtype;
        }
      }
    }

    return { ok: !error, aborted: abort.signal.aborted, error, sessionId, signals };
  } catch (err) {
    const aborted = abort.signal.aborted;
    return {
      ok: false,
      aborted,
      error: aborted ? "Detenido" : (err as Error).message,
      sessionId: opts.resume ?? null,
      signals,
    };
  } finally {
    running.delete(card.id);
  }
}
