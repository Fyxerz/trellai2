/**
 * The board's brain: what happens when a card enters a column, and what
 * happens when an agent finishes a run.
 *
 *   backlog → plan → preparation → doing → review → merged
 *                     (agent asks     (agents in    (you)    (git merge)
 *                      or auto-moves)  parallel)
 */
import type { Card, Column } from "../shared/types.js";
import * as db from "./db.js";
import { emitCard, emitMessage, emitNote } from "./events.js";
import * as git from "./git.js";
import { isRunning, runAgent, stopAgent, type AgentKind, type RunResult } from "./agents.js";

const MAX_REBASE_ATTEMPTS = 2;
const rebaseAttempts = new Map<string, number>();

function set(id: string, patch: db.CardPatch): Card {
  const card = db.updateCard(id, patch);
  emitCard(card);
  return card;
}

function log(card: Card, role: "system" | "user", content: string) {
  emitMessage(card.project_id, db.addMessage(card.id, role, content));
}

function projectOf(card: Card) {
  const p = db.getProject(card.project_id);
  if (!p) throw new Error("Proyecto no encontrado");
  return p;
}

function emitColumn(projectId: string, column: Column) {
  for (const c of db.cardsInColumn(projectId, column)) emitCard(c);
}

function bg(p: Promise<unknown>, card: Card) {
  p.catch((err) => {
    console.error(`[trellai] ${card.title}:`, err);
    set(card.id, { status: "error", status_text: String(err?.message ?? err) });
  });
}

// ---------------------------------------------------------------------------
// Moving cards
// ---------------------------------------------------------------------------

export function moveCard(cardId: string, column: Column, index = Number.MAX_SAFE_INTEGER): Card {
  const before = db.getCard(cardId);
  if (!before) throw new Error("Tarjeta no encontrada");
  const card = db.placeCard(cardId, column, index);
  emitColumn(card.project_id, column);
  if (before.column !== column) {
    emitColumn(card.project_id, before.column);
    bg(onEnter(card, before.column), card);
  }
  return card;
}

async function onEnter(card: Card, from: Column) {
  switch (card.column) {
    case "backlog":
    case "plan":
      if (isRunning(card.id)) stopAgent(card.id);
      set(card.id, { status: "idle", status_text: "" });
      return;
    case "preparation":
      if (isRunning(card.id)) stopAgent(card.id);
      await waitUntilStopped(card.id);
      return startPrep(card, card.prep_session_id ? `Pedro moved the card back to PREPARATION. Current spec:\n\n${card.spec}` : undefined);
    case "doing":
      if (from === "preparation" && isRunning(card.id)) {
        stopAgent(card.id);
        await waitUntilStopped(card.id);
      }
      if (isRunning(card.id)) return;
      return startDev(card, card.session_id
        ? `Pedro moved this card back to DOING (from ${from}). Read the notes, check your work is complete, fix anything pending and call report_done.`
        : undefined);
    case "review":
      if (isRunning(card.id)) {
        stopAgent(card.id);
        await waitUntilStopped(card.id);
      }
      if (card.worktree) git.commitAll(card.worktree, `${card.title} (wip)`);
      set(card.id, { status: "idle", status_text: "Pendiente de revisión" });
      return;
    case "merged":
      return merge(card);
  }
}

async function waitUntilStopped(cardId: string) {
  for (let i = 0; i < 100 && isRunning(cardId); i++) await new Promise((r) => setTimeout(r, 100));
}

// ---------------------------------------------------------------------------
// Running agents
// ---------------------------------------------------------------------------

async function launch(card: Card, kind: AgentKind, prompt: string, resume: string | null): Promise<void> {
  const project = projectOf(card);
  const cwd = kind === "dev" ? card.worktree! : project.repo_path;
  card = set(card.id, { status: "running", status_text: kind === "prep" ? "Preparando…" : "Trabajando…" });

  const res = await runAgent({ card, kind, prompt, cwd, repo: project.repo_path, resume });

  const now = db.getCard(card.id);
  if (!now) return; // deleted meanwhile
  if (res.sessionId) set(card.id, kind === "prep" ? { prep_session_id: res.sessionId } : { session_id: res.sessionId });
  if (res.aborted) {
    if (now.status === "running") set(card.id, { status: "idle", status_text: "Detenido" });
    return;
  }
  if (!res.ok) {
    set(card.id, { status: "error", status_text: res.error ?? "Error del agente" });
    return;
  }
  // You may have moved the card while the agent was finishing.
  const expected: Column = kind === "prep" ? "preparation" : "doing";
  if (now.column !== expected) {
    set(card.id, { status: "idle", status_text: "" });
    return;
  }

  const pending = db.takePendingInput(card.id);
  if (pending.length) {
    const resumeId = kind === "prep" ? db.getCard(card.id)!.prep_session_id : db.getCard(card.id)!.session_id;
    return launch(db.getCard(card.id)!, kind, `Message from Pedro:\n\n${pending.join("\n\n")}`, resumeId);
  }

  return kind === "prep" ? afterPrep(db.getCard(card.id)!, res) : afterDev(db.getCard(card.id)!, res);
}

function startPrep(card: Card, message?: string) {
  const prompt =
    message ??
    `# Card: ${card.title}\n\n## Spec (written by Pedro)\n\n${card.spec || "(empty — infer from the title)"}`;
  return launch(card, "prep", prompt, message ? card.prep_session_id : null);
}

async function afterPrep(card: Card, res: RunResult): Promise<void> {
  if (res.signals.ready) {
    set(card.id, { plan: res.signals.ready.plan, files: res.signals.ready.files, status: "idle", status_text: "" });
    log(card, "system", "✅ Spec clara — pasa a Doing automáticamente.");
    moveCard(card.id, "doing");
    return;
  }
  if (res.signals.asked || db.openQuestions(card.id).length) {
    set(card.id, { status: "waiting", status_text: "Tiene preguntas para ti" });
    return;
  }
  set(card.id, { status: "waiting", status_text: "Te ha respondido — contesta en el chat" });
}

function otherAgentsContext(card: Card): string {
  const others = db.cardsInColumn(card.project_id, "doing").filter((c) => c.id !== card.id);
  if (!others.length) return "None — you're the only agent right now.";
  return others
    .map((c) => `- "${c.title}" (branch ${c.branch ?? "?"}; expected files: ${c.files.join(", ") || "unknown"})`)
    .join("\n");
}

/** Warn both agents (via the shared channel) when their predicted/actual files overlap. */
function announceOverlaps(card: Card) {
  const project = projectOf(card);
  const mine = new Set(card.files);
  for (const other of db.cardsInColumn(card.project_id, "doing")) {
    if (other.id === card.id) continue;
    let theirs = other.files;
    if (other.worktree) {
      try {
        theirs = [...new Set([...theirs, ...git.changedFiles(other.worktree, project.base_branch)])];
      } catch {
        /* ignore */
      }
    }
    const overlap = theirs.filter((f) => mine.has(f));
    if (overlap.length) {
      const note = db.addNote(
        card.project_id,
        null,
        `⚠️ "${card.title}" y "${other.title}" pueden tocar los mismos ficheros: ${overlap.join(", ")}. Coordinaos con post_note.`,
      );
      emitNote(note);
    }
  }
}

async function startDev(card: Card, message?: string): Promise<void> {
  const project = projectOf(card);
  if (!card.worktree || !card.branch) {
    const wt = git.createWorktree(project.repo_path, project.base_branch, card.id, card.title);
    card = set(card.id, { worktree: wt.path, branch: wt.branch });
    log(card, "system", `🌿 Worktree creado en la rama \`${wt.branch}\``);
  }
  announceOverlaps(card);

  if (message && card.session_id) return launch(card, "dev", message, card.session_id);

  const answered = db.listQuestions(card.id).filter((q) => q.answer !== null);
  const prompt = [
    `# Card: ${card.title}`,
    `## Spec (written by Pedro)\n\n${card.spec || "(empty — infer from the title)"}`,
    card.plan ? `## Plan (from preparation)\n\n${card.plan}` : "",
    answered.length ? `## Pedro's answers\n\n${answered.map((q) => `- ${q.question} → ${q.answer}`).join("\n")}` : "",
    `## Other agents working in parallel right now\n\n${otherAgentsContext(card)}`,
    message ? `## Note\n\n${message}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return launch(card, "dev", prompt, null);
}

async function afterDev(card: Card, res: RunResult): Promise<void> {
  const project = projectOf(card);
  if (res.signals.asked || db.openQuestions(card.id).length) {
    set(card.id, { status: "waiting", status_text: "Tiene preguntas para ti" });
    return;
  }

  git.commitAll(card.worktree!, card.title);
  const rebase = git.rebaseOnto(card.worktree!, project.base_branch);
  if (!rebase.ok) {
    const n = (rebaseAttempts.get(card.id) ?? 0) + 1;
    rebaseAttempts.set(card.id, n);
    if (n > MAX_REBASE_ATTEMPTS) {
      set(card.id, { status: "error", status_text: `Conflictos con ${project.base_branch} sin resolver` });
      return;
    }
    log(card, "system", `🔀 Conflictos al rebasar sobre ${project.base_branch}. Le pido al agente que los resuelva.`);
    return launch(card, "dev", rebasePrompt(project.base_branch), card.session_id);
  }
  rebaseAttempts.delete(card.id);

  const summary = res.signals.done ?? "Listo para revisar";
  log(card, "system", `🟢 ${summary}`);
  set(card.id, { status: "idle", status_text: summary.split("\n")[0].slice(0, 120) });
  moveCard(card.id, "review");
}

function rebasePrompt(base: string) {
  return `REBASE needed: your branch conflicts with the latest "${base}" (other agents' work was merged). Rebase onto "${base}" yourself (\`git rebase ${base}\`), resolve every conflict so BOTH your feature and the merged work keep working, \`git add\` and \`git rebase --continue\` until done, run the tests, then call report_done.`;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

async function merge(card: Card) {
  const project = projectOf(card);
  if (isRunning(card.id)) {
    stopAgent(card.id);
    await waitUntilStopped(card.id);
  }
  if (!card.branch || !card.worktree) {
    set(card.id, { status: "idle", status_text: "Sin rama — nada que mergear" });
    return;
  }
  git.commitAll(card.worktree, card.title);
  const r = git.mergeIntoBase(project.repo_path, project.base_branch, card.branch, `Merge "${card.title}" (trellai)`);
  if (r.ok) {
    git.removeWorktree(project.repo_path, card.worktree, card.branch);
    log(card, "system", `✅ Mergeada en ${project.base_branch} (${r.sha.slice(0, 7)})`);
    set(card.id, { status: "idle", status_text: `Merge ${r.sha.slice(0, 7)}`, worktree: null, branch: null });
    return;
  }
  if (r.reason === "conflict") {
    log(card, "system", `🔀 Conflicto al mergear en ${project.base_branch}. Vuelve a Doing para que el agente lo resuelva.`);
    const c = db.placeCard(card.id, "doing", Number.MAX_SAFE_INTEGER);
    emitColumn(c.project_id, "doing");
    emitColumn(c.project_id, "merged");
    return launch(c, "dev", rebasePrompt(project.base_branch), c.session_id);
  }
  // checkout / dirty: put it back in review and tell Pedro why.
  const c = db.placeCard(card.id, "review", Number.MAX_SAFE_INTEGER);
  emitColumn(c.project_id, "review");
  emitColumn(c.project_id, "merged");
  log(c, "system", `⛔ No se pudo mergear: ${r.error}`);
  set(c.id, { status: "error", status_text: r.error });
}

// ---------------------------------------------------------------------------
// Human input
// ---------------------------------------------------------------------------

export function sendMessage(cardId: string, text: string) {
  const card = db.getCard(cardId);
  if (!card) throw new Error("Tarjeta no encontrada");
  log(card, "user", text);

  if (isRunning(card.id)) {
    db.pushPendingInput(card.id, text);
    log(card, "system", "Se lo paso al agente en cuanto termine el paso actual.");
    return;
  }
  switch (card.column) {
    case "preparation":
      bg(launch(card, "prep", `Message from Pedro:\n\n${text}`, card.prep_session_id), card);
      return;
    case "doing":
      bg(card.session_id ? launch(card, "dev", `Message from Pedro:\n\n${text}`, card.session_id) : startDev(card, text), card);
      return;
    case "review": {
      // Requesting changes sends the card back to Doing.
      const c = db.placeCard(card.id, "doing", Number.MAX_SAFE_INTEGER);
      emitColumn(c.project_id, "doing");
      emitColumn(c.project_id, "review");
      log(c, "system", "↩️ Cambios pedidos — vuelve a Doing.");
      bg(startDev(c, `Pedro reviewed your work and requests changes:\n\n${text}\n\nApply them, then call report_done.`), c);
      return;
    }
    default:
      // backlog / plan / merged: it's just a comment.
      return;
  }
}

export function answerQuestions(cardId: string, answers: Record<string, string>) {
  const card = db.getCard(cardId);
  if (!card) throw new Error("Tarjeta no encontrada");
  const qs = db.listQuestions(cardId);
  for (const [id, answer] of Object.entries(answers)) {
    if (answer?.trim()) db.answerQuestion(cardId, Number(id), answer.trim());
  }
  const fresh = db.listQuestions(cardId);
  const justAnswered = fresh.filter((q) => q.answer && answers[q.id] && qs.find((o) => o.id === q.id)?.answer === null);
  if (justAnswered.length) log(card, "user", justAnswered.map((q) => `**${q.question}** → ${q.answer}`).join("\n"));
  if (db.openQuestions(cardId).length) return;

  const text = `Pedro's answers:\n${justAnswered.map((q) => `- ${q.question} → ${q.answer}`).join("\n")}`;
  if (card.column === "preparation") bg(launch(card, "prep", text, card.prep_session_id), card);
  else if (card.column === "doing") bg(launch(card, "dev", text, card.session_id), card);
}

export function stop(cardId: string) {
  stopAgent(cardId);
}

export function retry(cardId: string) {
  const card = db.getCard(cardId);
  if (!card) throw new Error("Tarjeta no encontrada");
  if (isRunning(card.id)) return;
  rebaseAttempts.delete(card.id);
  bg(onEnter(card, card.column), card);
}

export async function removeCard(cardId: string) {
  const card = db.getCard(cardId);
  if (!card) return;
  if (isRunning(card.id)) {
    stopAgent(card.id);
    await waitUntilStopped(card.id);
  }
  if (card.worktree || card.branch) {
    const project = db.getProject(card.project_id);
    if (project) git.removeWorktree(project.repo_path, card.worktree, card.branch);
  }
  db.deleteCard(card.id);
}

/** After a restart nothing is actually running anymore. */
export function recoverAfterRestart() {
  db.db
    .prepare(
      `UPDATE cards SET status = 'error', status_text = 'Interrumpido al reiniciar el servidor — pulsa Reintentar' WHERE status = 'running'`,
    )
    .run();
}
