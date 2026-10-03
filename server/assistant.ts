/**
 * Project assistant: you talk (or dictate) loosely, it explores the repo and turns
 * that into well-described cards — or updates the ones that already exist.
 */
import { z } from "zod";
import { prettyModel } from "../shared/models.js";
import { COLUMN_LABELS, type Column } from "../shared/types.js";
import * as db from "./db.js";
import { emitAssistantMessage, emitAssistantStatus, emitCard, emitCheckpoints } from "./events.js";
import * as git from "./git.js";
import * as remote from "./remote.js";
import { getPreview, releasePreview } from "./preview.js";
import { modelLabel, runEngine, type ToolSpec } from "./engine.js";

type Mode = db.AssistantMode;
const running = new Map<string, AbortController>();
const key = (projectId: string, mode: Mode) => `${projectId}:${mode}`;
/** Exact model last announced in each conversation. */
const lastModel = new Map<string, string>();

export function assistantRunning(projectId: string, mode: Mode) {
  return running.has(key(projectId, mode));
}

export function stopAssistant(projectId: string, mode: Mode) {
  running.get(key(projectId, mode))?.abort();
}

const DIRECT_PROMPT = `You are an AI coding agent inside Trellai, a kanban board where Pedro hands features to Claude agents.
This is the DIRECT chat: Pedro asks for small things that don't deserve a card — tweak a config, rename or move
files, fix a typo or a small bug, update a dependency, add a script, answer a question about the code, etc.

- You work directly in the project's MAIN checkout (your cwd). Other agents work on their own branches in
  .trellai/worktrees/ — never touch that folder.
- Do exactly what was asked, keep the change small and focused, and verify it (run tests/typecheck if relevant).
- Don't switch branches, don't push, don't rewrite history. Trellai commits your changes automatically when you
  finish (only the files you changed), using Pedro's request as the message.
- If the request is really a feature (several parts, design decisions, lots of files), say so and offer to create a
  card instead — you have \`create_cards\` for that (and \`list_cards\`/\`update_card\`).

Reply in Spanish, briefly: what you changed (files) and anything Pedro should know.`;

const PROMPT = `You are the project assistant inside Trellai, a kanban board where Pedro hands features to Claude agents.
Pedro talks to you loosely — often dictated by voice, messy, several ideas mixed together. Your job is to turn that
into well-described CARDS on the board, so they can be referenced and worked on later.

You have READ-ONLY access to the repository: explore it (Read, Grep, Glob, read-only Bash) so specs point at the real
code (actual files, components, tables, endpoints). Never edit files.

How to write cards:
- Break big ideas into cards that are independent enough to be built IN PARALLEL by separate agents, each in its own
  branch. Avoid two cards touching the same files when you can; if one depends on another, say so in the spec.
- Title: short, in Spanish, starting with a verb ("Añadir reparto de propinas por camarero").
- Spec (Spanish markdown) with these sections when they apply:
  **Qué** (what Pedro wants, in his terms) · **Por qué** · **Comportamiento** (concrete behaviour, edge cases) ·
  **Notas técnicas** (real files/places in the repo, approach) · **Fuera de alcance**.
- Checkpoints: 3–8 short, concrete, verifiable steps.
- Column: "backlog" by default. Use "plan" only if Pedro says it's ready to be worked on.
- Area: "ui" if the card is mainly interface/visual/styling work, "logic" for algorithms, data or backend.

Before creating cards:
- Call \`list_cards\` to see what already exists. If Pedro is talking about an existing card, UPDATE it
  (\`update_card\`) instead of creating a duplicate.
- If the idea is very ambiguous, or you'd create more than 6 cards, first propose the breakdown in a short list and ask
  Pedro to confirm. Otherwise just create them.

Reply to Pedro in Spanish, briefly: what you created or changed and anything you assumed. Don't repeat the full specs.`;

function cardSummary(projectId: string) {
  const cards = db.listCards(projectId);
  if (!cards.length) return "The board is empty.";
  return cards
    .map(
      (c) =>
        `- id ${c.id} · [${COLUMN_LABELS[c.column]}] ${c.title}${c.checkpoints_total ? ` (${c.checkpoints_done}/${c.checkpoints_total} checkpoints)` : ""}`,
    )
    .join("\n");
}

export function makeAssistantToolkit(projectId: string, mode: Mode = "plan") {
  const say = (content: string, cardId: string | null = null) =>
    emitAssistantMessage(db.addAssistantMessage(projectId, mode, "system", content, cardId));

  return {
    listCards: () => cardSummary(projectId),
    getCard(id: string) {
      const c = db.getCard(id);
      if (!c || c.project_id !== projectId) return `No card with id ${id}.`;
      const cps = db.listCheckpoints(id).map((k) => `- [${k.done ? "x" : " "}] ${k.text}`).join("\n");
      return `# ${c.title}\nColumn: ${COLUMN_LABELS[c.column]}\n\n## Spec\n${c.spec || "(empty)"}\n\n## Checkpoints\n${cps || "(none)"}`;
    },
    createCards(
      cards: { title: string; spec: string; checkpoints?: string[]; column?: "backlog" | "plan"; area?: "ui" | "logic" }[],
    ) {
      const created: string[] = [];
      const uiModel = db.getProject(projectId)?.model_ui;
      for (const c of cards) {
        let card = db.createCard({ project_id: projectId, title: c.title.trim(), spec: c.spec ?? "", column: c.column ?? "backlog" });
        if (c.area === "ui" && uiModel) card = db.updateCard(card.id, { model: uiModel });
        for (const t of c.checkpoints ?? []) if (t.trim()) db.addCheckpoint(card.id, t.trim(), "agent");
        emitCard(card.id);
        say(`🗂 Creada en ${COLUMN_LABELS[card.column as Column]}: ${card.title}${card.model ? ` · ${modelLabel(card.model)}` : ""}`, card.id);
        created.push(`${card.id}: ${card.title}`);
      }
      return `Created ${created.length} card(s):\n${created.join("\n")}`;
    },
    updateCard(id: string, patch: { title?: string; spec?: string; add_checkpoints?: string[] }) {
      const c = db.getCard(id);
      if (!c || c.project_id !== projectId) return `No card with id ${id}.`;
      const updated = db.updateCard(id, { title: patch.title?.trim() || undefined, spec: patch.spec });
      for (const t of patch.add_checkpoints ?? []) if (t.trim()) db.addCheckpoint(id, t.trim(), "agent");
      emitCheckpoints(projectId, id);
      emitCard(updated);
      say(`✏️ Actualizada: ${updated.title}`, id);
      return `Card ${id} updated.`;
    },
  };
}

function assistantTools(kit: ReturnType<typeof makeAssistantToolkit>): ToolSpec[] {
  return [
    { name: "list_cards", description: "List every card on this project's board (id, column, title).", shape: {}, run: () => kit.listCards() },
    { name: "get_card", description: "Read one card's full spec and checkpoints.", shape: { id: z.string() }, run: ({ id }) => kit.getCard(id) },
    {
      name: "create_cards",
      description: "Create one or more cards on the board.",
      shape: {
        cards: z
          .array(
            z.object({
              title: z.string().describe("Short Spanish title starting with a verb"),
              spec: z.string().describe("Spanish markdown spec (Qué / Por qué / Comportamiento / Notas técnicas / Fuera de alcance)"),
              checkpoints: z.array(z.string()).describe("3-8 short verifiable steps in Spanish"),
              column: z.enum(["backlog", "plan"]).optional().describe("backlog by default"),
              area: z
                .enum(["ui", "logic"])
                .optional()
                .describe("ui = mainly interface/visual/styling work; logic = algorithms, data, backend. Used to pick the model."),
            }),
          )
          .min(1),
      },
      run: ({ cards }) => kit.createCards(cards),
    },
    {
      name: "update_card",
      description: "Update an existing card: rename it, replace its spec, or add checkpoints.",
      shape: {
        id: z.string(),
        title: z.string().optional(),
        spec: z.string().optional().describe("Full new spec (replaces the old one)"),
        add_checkpoints: z.array(z.string()).optional(),
      },
      run: ({ id, ...patch }) => kit.updateCard(id, patch),
    },
  ];
}

/** Send Pedro's message to the assistant. Queued if it's already busy. */
export function sendToAssistant(projectId: string, text: string, mode: Mode = "plan") {
  const project = db.getProject(projectId);
  if (!project) throw new Error("Proyecto no encontrado");
  if (!project.repo_path) throw new Error(`"${project.name}" no está vinculado en este ordenador: elige su carpeta o clónalo desde el tablero.`);
  emitAssistantMessage(db.addAssistantMessage(projectId, mode, "user", text));
  if (running.has(key(projectId, mode))) {
    db.pushAssistantPending(projectId, mode, text);
    return;
  }
  run(projectId, mode, text).catch((err) => {
    console.error("[assistant]", err);
    emitAssistantMessage(db.addAssistantMessage(projectId, mode, "system", `⛔ ${err.message ?? err}`));
  });
}

/** The chat so far, for a fresh session (e.g. on another computer, where the old one doesn't exist). */
function earlierConversation(projectId: string, mode: Mode): string {
  const msgs = db.listAssistantMessages(projectId, mode).filter((m) => m.role === "user" || m.role === "assistant").slice(-13, -1);
  if (!msgs.length) return "";
  const lines = msgs.map((m) => `${m.role === "user" ? "Pedro" : "You"}: ${m.content.replace(/\s+/g, " ").slice(0, 400)}`);
  return `Earlier in this conversation (previous session):\n${lines.join("\n")}`;
}

function commitMessage(request: string) {
  const raw = request.split("\n").find((l) => l.trim())?.trim() ?? "Cambio directo";
  const first = raw.charAt(0).toUpperCase() + raw.slice(1);
  return first.length > 72 ? first.slice(0, 69) + "…" : first;
}

async function run(projectId: string, mode: Mode, text: string): Promise<void> {
  const project = db.getProject(projectId)!;
  const abort = new AbortController();
  running.set(key(projectId, mode), abort);
  emitAssistantStatus(projectId, mode, true);
  const kit = makeAssistantToolkit(projectId, mode);
  const log = (role: "assistant" | "tool" | "system", content: string) =>
    emitAssistantMessage(db.addAssistantMessage(projectId, mode, role, content));
  // Direct mode works on the main checkout: if it's showing a card's branch, go back first.
  if (mode === "do" && getPreview(projectId)) {
    try {
      releasePreview(projectId);
      log("system", "👁 Tu repo estaba mostrando la rama de una tarjeta; lo devuelvo a su rama antes de trabajar.");
    } catch (err) {
      log("system", `⛔ ${(err as Error).message}`);
      running.delete(key(projectId, mode));
      emitAssistantStatus(projectId, mode, false);
      return;
    }
  }
  // Start from what's on GitHub: you may have pushed from another computer.
  const branch = git.currentBranch(project.repo_path);
  const syncTarget = mode === "do" && branch !== "HEAD" ? branch : project.base_branch;
  const synced = await remote.syncBranch(project.repo_path, syncTarget, { maxAgeMs: mode === "do" ? 0 : 60_000 });
  if (synced.pulled) log("system", `⬇️ ${syncTarget} actualizado desde ${remote.remoteLabel(project.repo_path)} (${synced.pulled} commit(s) nuevos).`);
  else if (!synced.ok && synced.message && mode === "do") log("system", `⚠️ ${synced.message}`);

  // Direct mode: remember what was already dirty so only this request's changes get committed.
  const before = mode === "do" ? git.dirtySnapshot(project.repo_path) : null;

  try {
    if (process.env.TRELLAI_FAKE_AGENT) {
      await (mode === "plan" ? fakeAssistant(text, kit, log) : fakeDirect(project.repo_path, text, log));
    } else {
      const resume = db.getAssistantSession(projectId, mode);
      const board = `Current board:\n${cardSummary(projectId)}`;
      const res = await runEngine({
        model: mode === "plan" ? project.model_plan : project.model_do,
        cwd: project.repo_path,
        instructions: mode === "plan" ? PROMPT : DIRECT_PROMPT,
        prompt: !resume
          ? [mode === "plan" ? board : "", earlierConversation(projectId, mode), `Pedro says:\n${text}`].filter(Boolean).join("\n\n")
          : text,
        resume,
        contextIfFresh: mode === "plan" ? board : undefined,
        access: mode === "plan" ? "read" : "write",
        tools: assistantTools(kit),
        signal: abort.signal,
        onText: (t) => log("assistant", t),
        onTool: (t) => log("tool", t),
        onModel: (model) => {
          if (lastModel.get(key(projectId, mode)) === model) return;
          lastModel.set(key(projectId, mode), model);
          log("system", `🤖 ${prettyModel(model)} · \`${model.replace(/^codex:/, "")}\``);
        },
      });
      if (res.sessionId) db.setAssistantSession(projectId, mode, res.sessionId);
      if (res.error) log("system", `⛔ ${res.error}`);
    }
  } catch (err) {
    if (!abort.signal.aborted) throw err;
    log("system", "Detenido.");
  } finally {
    if (before) {
      try {
        const sha = git.commitChangedSince(project.repo_path, before, commitMessage(text));
        if (sha) {
          log("system", `📌 Commit \`${sha.slice(0, 7)}\` en ${branch} · ${commitMessage(text)}`);
          // Push like a merge would: on the base branch, or a branch that already lives on the remote.
          if (synced.remote && !synced.offline && (branch === project.base_branch || (await remote.hasRemoteBranch(project.repo_path, branch)))) {
            const p = await remote.pushBranch(project.repo_path, branch);
            log("system", p.ok ? `⬆️ Push de ${branch} a ${remote.remoteLabel(project.repo_path)}.` : `⚠️ ${p.message}`);
          }
        }
      } catch (err) {
        log("system", `⚠️ No se pudo hacer commit: ${(err as Error).message}`);
      }
    }
    running.delete(key(projectId, mode));
    emitAssistantStatus(projectId, mode, false);
  }

  const pending = db.takeAssistantPending(projectId, mode);
  if (pending.length && !abort.signal.aborted) return run(projectId, mode, pending.join("\n\n"));
}

async function fakeDirect(repo: string, text: string, log: (role: "assistant" | "tool" | "system", content: string) => void) {
  const { appendFileSync } = await import("node:fs");
  await new Promise((r) => setTimeout(r, Number(process.env.TRELLAI_FAKE_DELAY ?? 300)));
  appendFileSync(`${repo}/DIRECT.md`, `- ${text}\n`);
  log("tool", "Edit · DIRECT.md");
  log("assistant", "Hecho: he añadido la línea a `DIRECT.md`.");
}

/** Scripted stand-in: each "- line" in the message becomes a card. */
async function fakeAssistant(
  text: string,
  kit: ReturnType<typeof makeAssistantToolkit>,
  log: (role: "assistant" | "tool" | "system", content: string) => void,
) {
  log("tool", "Glob · **/*");
  await new Promise((r) => setTimeout(r, Number(process.env.TRELLAI_FAKE_DELAY ?? 300)));
  const items = text
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter((l, i, all) => l && (all.length === 1 || /^\s*[-*]/.test(text.split("\n")[i])));
  kit.createCards(
    (items.length ? items : [text.trim()]).map((t) => ({
      title: t.charAt(0).toUpperCase() + t.slice(1),
      spec: `**Qué**\n\n${t}`,
      checkpoints: ["Implementar", "Probar"],
    })),
  );
  log("assistant", `He creado ${items.length || 1} tarjeta(s) en Backlog.`);
}
