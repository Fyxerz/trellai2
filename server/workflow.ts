/**
 * The board's brain: what happens when a card enters a column, and what
 * happens when an agent finishes a run.
 *
 *   backlog → plan → preparation → doing → review → merged
 *                     (agent asks     (agents in    (you)    (git merge)
 *                      or auto-moves)  parallel)
 */
import { existsSync } from "node:fs";
import { COLUMN_LABELS, describeClaim, type Card, type Column, type Project } from "../shared/types.js";
import { attachmentsBlock, messageImageMarkdown, removeAttachmentFiles, withMessageImages } from "./attachments.js";
import * as claims from "./claims.js";
import * as db from "./db.js";
import { emitCard, emitMessage } from "./events.js";
import * as git from "./git.js";
import { isRunning, runAgent, stopAgent, type AgentKind, type RunResult } from "./agents.js";
import { assistantRunning } from "./assistant.js";
import { followPreview, getPreview, releasePreview } from "./preview.js";
import { MACHINE } from "./machine.js";
import * as remote from "./remote.js";
import { outsideLocks, repoLock } from "./lock.js";
import { onSync } from "./sync.js";

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
  if (!p.repo_path) throw new Error(`"${p.name}" no está vinculado en este ordenador: elige su carpeta o clónalo desde el tablero.`);
  return p;
}

/** The agent for this card is running on another computer right now. */
export function runningElsewhere(card: Card): boolean {
  return card.status === "running" && !!card.machine && card.machine !== MACHINE;
}

/** Bring the base branch up to date with the remote before starting something. */
async function pullBase(card: Card, project: Project) {
  const r = await remote.syncBranch(project.repo_path, project.base_branch);
  if (!r.remote) return r;
  if (r.pulled) log(card, "system", `⬇️ ${project.base_branch} actualizado desde ${remote.remoteLabel(project.repo_path)} (${r.pulled} commit(s) nuevos).`);
  else if (!r.ok && r.message) log(card, "system", `⚠️ ${r.message}`);
  return r;
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

/** Every column change leaves a line in the card's activity: from, to and why. */
function logMove(card: Card, from: Column, to: Column, why: string) {
  log(card, "system", `↪ ${COLUMN_LABELS[from]} → ${COLUMN_LABELS[to]} · ${why}`);
}

/** `why`: who or what moved it (default: you, from the board). */
export function moveCard(cardId: string, column: Column, index = Number.MAX_SAFE_INTEGER, why = `movida por ti en ${MACHINE}`): Card {
  const before = db.getCard(cardId);
  if (!before) throw new Error("Tarjeta no encontrada");
  if (before.column !== column && runningElsewhere(before)) {
    throw new Error(`Un agente está trabajando en esta tarjeta en ${before.machine}. Páralo primero.`);
  }
  const card = db.placeCard(cardId, column, index);
  emitColumn(card.project_id, column);
  if (before.column !== column) {
    logMove(card, before.column, column, why);
    if (before.column === "doing") claims.sweep(card.project_id);
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
      if (card.worktree && existsSync(card.worktree)) {
        git.commitAll(card.worktree, `${card.title} (wip)`);
        if (card.branch) await remote.pushCardBranch(card.worktree, card.branch);
      }
      followPreview(card);
      // Keep the agent's summary (set just before the auto-move); otherwise nothing to say.
      set(card.id, { status: "idle", status_text: from === "doing" && card.status_text !== "Trabajando…" ? card.status_text : "" });
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

interface LaunchOpts {
  /** Column the card must still be in when the agent finishes (default: its phase's column). */
  column?: Column;
  statusText?: string;
  /** What to do when it finishes, instead of the phase's usual next step. */
  after?: (card: Card, res: RunResult) => Promise<void>;
}

async function launch(card: Card, kind: AgentKind, prompt: string, resume: string | null, opts: LaunchOpts = {}): Promise<void> {
  const project = projectOf(card);
  // Picking up a card another computer worked on: its agent sessions don't exist here.
  if (card.machine && card.machine !== MACHINE) resume = null;
  if (kind === "dev") card = await ensureWorktree(card);
  else if (!resume) await pullBase(card, project);
  if (!resume && !prompt.startsWith("# Card:")) {
    prompt = `${kind === "prep" ? prepBrief(card) : devBrief(card)}\n\n${recentActivity(card)}## Now\n\n${prompt}`;
  }
  const cwd = kind === "dev" ? card.worktree! : project.repo_path;
  card = set(card.id, {
    status: "running",
    status_text: opts.statusText ?? (kind === "prep" ? "Preparando…" : "Trabajando…"),
    machine: MACHINE,
    stop_req: null,
  });

  const res = await runAgent({ card, kind, prompt, cwd, repo: project.repo_path, resume });

  const now = db.getCard(card.id);
  if (!now) return; // deleted meanwhile
  if (kind === "dev") claims.refreshClaims(now); // lines as the agent left them
  if (res.sessionId) set(card.id, kind === "prep" ? { prep_session_id: res.sessionId } : { session_id: res.sessionId });
  if (res.aborted) {
    // Leave the work where another computer can pick it up.
    if (kind === "dev" && now.worktree && now.branch && existsSync(now.worktree)) {
      try {
        git.commitAll(now.worktree, `${now.title} (wip)`);
        await remote.pushCardBranch(now.worktree, now.branch);
      } catch (err) {
        console.warn("[trellai] wip commit:", (err as Error).message);
      }
    }
    if (now.status === "running") set(card.id, { status: "idle", status_text: "Detenido" });
    return;
  }
  if (!res.ok) {
    set(card.id, { status: "error", status_text: res.error ?? "Error del agente" });
    return;
  }
  // You may have moved the card while the agent was finishing.
  const expected: Column = opts.column ?? (kind === "prep" ? "preparation" : "doing");
  if (now.column !== expected) {
    set(card.id, { status: "idle", status_text: "" });
    return;
  }

  const pending = db.takePendingInput(card.id);
  if (pending.length) {
    const resumeId = kind === "prep" ? db.getCard(card.id)!.prep_session_id : db.getCard(card.id)!.session_id;
    return launch(db.getCard(card.id)!, kind, `Message from Pedro:\n\n${pending.join("\n\n")}`, resumeId, opts);
  }

  if (opts.after) return opts.after(db.getCard(card.id)!, res);
  return kind === "prep" ? afterPrep(db.getCard(card.id)!, res) : afterDev(db.getCard(card.id)!, res);
}

function checkpointsBlock(card: Card, withIds: boolean): string {
  const cps = db.listCheckpoints(card.id);
  if (!cps.length) return "";
  const lines = cps.map((c) => `- [${c.done ? "x" : " "}] ${withIds ? `(id ${c.id}) ` : ""}${c.text}${c.source === "user" ? " — by Pedro" : ""}`);
  return `## Checkpoints\n\n${lines.join("\n")}`;
}

function prepBrief(card: Card) {
  return [
    `# Card: ${card.title}`,
    `## Spec (written by Pedro)\n\n${card.spec || "(empty — infer from the title)"}`,
    attachmentsBlock(card, projectOf(card).repo_path),
    checkpointsBlock(card, false),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Last messages of the card, for an agent starting without the previous session. */
function recentActivity(card: Card): string {
  const msgs = db.listMessages(card.id).filter((m) => m.role !== "tool").slice(-12);
  if (!msgs.length) return "";
  const who = { user: "Pedro", assistant: "Agent", system: "Trellai", tool: "Tool" } as const;
  const lines = msgs.map((m) => `- ${who[m.role]}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`);
  return `## Recent activity on this card (a previous agent session, maybe on another computer — check \`git log\` for its work)\n\n${lines.join("\n")}\n\n`;
}

function startPrep(card: Card, message?: string) {
  return launch(card, "prep", message ?? prepBrief(card), message ? card.prep_session_id : null);
}

async function afterPrep(card: Card, res: RunResult): Promise<void> {
  if (res.signals.ready) {
    set(card.id, { plan: res.signals.ready.plan, files: res.signals.ready.files, status: "idle", status_text: "" });
    log(card, "system", "✅ Spec clara — pasa a Doing automáticamente.");
    moveCard(card.id, "doing", Number.MAX_SAFE_INTEGER, "automático: la preparación ha terminado");
    return;
  }
  if (res.signals.asked || db.openQuestions(card.id).length) {
    set(card.id, { status: "waiting", status_text: "Tiene preguntas para ti" });
    return;
  }
  set(card.id, { status: "waiting", status_text: "Te ha respondido — contesta en el chat" });
}

/**
 * The card's worktree on THIS computer: created from an up-to-date base branch, or — if the
 * card already has a branch from another computer — checked out from the remote.
 */
async function ensureWorktree(card: Card): Promise<Card> {
  const project = projectOf(card);
  const elsewhere = !!card.machine && card.machine !== MACHINE;
  if (card.worktree && existsSync(card.worktree) && !elsewhere) return card;
  if (card.worktree) {
    // stale: from an earlier turn on this computer, before another one took over
    git.removeWorktree(project.repo_path, card.worktree, card.branch);
    card = set(card.id, { worktree: null });
  }
  if (card.branch) {
    await remote.flushBranch(card.branch);
    const f = await remote.fetchCardBranch(project.repo_path, card.branch);
    if (!f.ok) throw new Error(f.message);
    const wt = git.createWorktree(project.repo_path, project.base_branch, card.id, card.title, card.branch);
    card = set(card.id, { worktree: wt.path, machine: MACHINE, session_id: null });
    log(card, "system", `💻 Sigo con esta tarjeta en ${MACHINE} (rama \`${card.branch}\`).`);
    return card;
  }
  await pullBase(card, project);
  const wt = git.createWorktree(project.repo_path, project.base_branch, card.id, card.title);
  card = set(card.id, { worktree: wt.path, branch: wt.branch, machine: MACHINE });
  log(card, "system", `🌿 Worktree creado en la rama \`${wt.branch}\``);
  return card;
}

async function startDev(card: Card, message?: string): Promise<void> {
  card = await ensureWorktree(card);
  card = claims.startClaims(card);

  if (message && card.session_id) return launch(card, "dev", message, card.session_id);
  const prompt = [devBrief(card), message ? `## Note\n\n${message}` : ""].filter(Boolean).join("\n\n");
  return launch(card, "dev", prompt, null);
}

function devBrief(card: Card): string {
  const answered = db.listQuestions(card.id).filter((q) => q.answer !== null);
  return [
    `# Card: ${card.title}`,
    `## Spec (written by Pedro)\n\n${card.spec || "(empty — infer from the title)"}`,
    attachmentsBlock(card, projectOf(card).repo_path),
    checkpointsBlock(card, true),
    card.plan ? `## Notes from preparation\n\n${card.plan}` : "",
    answered.length ? `## Pedro's answers\n\n${answered.map((q) => `- ${q.question} → ${q.answer}`).join("\n")}` : "",
    `## What the other agents working in parallel are touching right now\n\n${claims.othersWork(card)}`,
    card.claims.length ? `## Files claimed for you so far\n\n${card.claims.map((c) => `- ${c.file}: ${describeClaim(c)}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function afterDev(card: Card, res: RunResult): Promise<void> {
  const project = projectOf(card);
  if (res.signals.asked || db.openQuestions(card.id).length) {
    set(card.id, { status: "waiting", status_text: "Tiene preguntas para ti" });
    return;
  }

  git.commitAll(card.worktree!, git.commitsAhead(card.worktree!, project.base_branch) ? `${card.title}: cambios finales` : card.title);
  await pullBase(card, project); // rebase onto what's on GitHub, not just what's here
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
  if (card.branch) await remote.pushCardBranch(card.worktree!, card.branch);
  followPreview(db.getCard(card.id)!);

  const pendingCps = db.listCheckpoints(card.id).filter((c) => !c.done);
  if (pendingCps.length) log(card, "system", `⚠️ Quedan ${pendingCps.length} checkpoint(s) sin marcar.`);
  const summary = res.signals.done ?? "Listo para revisar";
  log(card, "system", `🟢 ${summary}`);
  set(card.id, { status: "idle", status_text: summary.split("\n")[0].slice(0, 120) });
  moveCard(card.id, "review", Number.MAX_SAFE_INTEGER, "automático: el agente ha terminado");
}

function rebasePrompt(base: string) {
  return `REBASE needed: your branch conflicts with the latest "${base}" (other agents' work was merged). Rebase onto "${base}" yourself (\`git rebase ${base}\`), resolve every conflict so BOTH your feature and the merged work keep working, \`git add\` and \`git rebase --continue\` until done, run the tests, then call report_done.`;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** The merge couldn't happen: back to To Review with the reason. */
function bounceToReview(card: Card, msg: string) {
  const c = db.placeCard(card.id, "review", Number.MAX_SAFE_INTEGER);
  emitColumn(c.project_id, "review");
  emitColumn(c.project_id, "merged");
  logMove(c, "merged", "review", "automático: no se pudo mergear");
  log(c, "system", `⛔ No se pudo mergear: ${msg}`);
  set(c.id, { status: "error", status_text: msg });
}

const mergeFixAttempts = new Map<string, number>();

function mergeConflictPrompt(base: string) {
  return `MERGE CONFLICT — REBASE needed: Pedro asked to merge this card, but your branch conflicts with the latest "${base}" (other work was merged meanwhile). Rebase onto "${base}" now (\`git rebase ${base}\`), resolve every conflict so BOTH your feature and the merged work keep working, \`git add\` and \`git rebase --continue\` until done, run the tests, then call report_done. Don't change anything else: Trellai merges your branch as soon as you finish.`;
}

/**
 * The card's branch conflicts with the base branch while merging: its agent rebases and
 * resolves the conflict in the card's worktree (never in your checkout), then the merge
 * runs again by itself. The card stays in Merged all along.
 */
async function resolveMergeConflict(card: Card, project: Project): Promise<void> {
  const base = project.base_branch;
  const n = (mergeFixAttempts.get(card.id) ?? 0) + 1;
  mergeFixAttempts.set(card.id, n);
  if (n > MAX_REBASE_ATTEMPTS) {
    mergeFixAttempts.delete(card.id);
    return bounceToReview(card, `Conflictos con ${base} sin resolver tras ${MAX_REBASE_ATTEMPTS} intentos`);
  }
  log(card, "system", `🔀 Conflicto al mergear en ${base}. El agente lo resuelve ahora y el merge sigue solo en cuanto termine.`);
  return launch(card, "dev", mergeConflictPrompt(base), card.session_id, {
    column: "merged",
    statusText: "Resolviendo conflicto para mergear…",
    after: async (c) => {
      if (db.openQuestions(c.id).length) {
        // Needs Pedro: carry on like any card in Doing (answer, then review and merge again).
        const moved = db.placeCard(c.id, "doing", Number.MAX_SAFE_INTEGER);
        emitColumn(moved.project_id, "doing");
        emitColumn(moved.project_id, "merged");
        logMove(moved, "merged", "doing", "automático: el agente necesita preguntarte algo para resolver el conflicto");
        set(c.id, { status: "waiting", status_text: "Tiene preguntas para ti (conflicto al mergear)" });
        return;
      }
      git.commitAll(c.worktree!, `${c.title}: conflicto con ${base} resuelto`);
      // No-op when the agent already rebased; if it didn't manage to, try again.
      if (!git.rebaseOnto(c.worktree!, base).ok) return resolveMergeConflict(db.getCard(c.id)!, project);
      if (c.branch) await remote.pushCardBranch(c.worktree!, c.branch);
      log(c, "system", "✅ Conflicto resuelto — sigo con el merge.");
      return merge(db.getCard(c.id)!);
    },
  });
}

async function merge(card: Card) {
  const project = projectOf(card);
  const repo = project.repo_path;
  if (isRunning(card.id)) {
    stopAgent(card.id);
    await waitUntilStopped(card.id);
  }
  if (!card.branch) {
    set(card.id, { status: "idle", status_text: "Sin rama — nada que mergear" });
    return;
  }
  const bounce = (msg: string) => bounceToReview(card, msg);
  if (assistantRunning(card.project_id, "do")) return bounce("El chat Directo está cambiando el repo; vuelve a mergear cuando termine.");
  if (getPreview(project.id)) {
    try {
      releasePreview(project.id);
      log(card, "system", "👁 Tu repo estaba mostrando una rama de Trellai; lo devuelvo a su rama para mergear.");
    } catch (err) {
      return bounce((err as Error).message);
    }
  }
  set(card.id, { status: "running", status_text: "Mergeando…", machine: MACHINE });
  return repoLock(repo, () => mergeLocked(card, project, bounce));
}

/**
 * Uncommitted edits in the main checkout (yours, or another Claude working there) don't block
 * the merge: they're stashed for the pull + merge and put back afterwards.
 */
async function mergeLocked(card: Card, project: Project, bounce: (msg: string) => void) {
  const repo = project.repo_path;
  if (!card.branch) return;
  const dirty = git.trackedDirty(repo).map(git.porcelainPath);
  const stash = git.stashSave(repo, `trellai: tus cambios mientras se mergeaba "${card.title}"`);
  if (stash) log(card, "system", `📦 Aparto tus cambios sin commitear (${dirty.slice(0, 4).join(", ")}${dirty.length > 4 ? "…" : ""}) para mergear; los vuelvo a poner al terminar.`);
  try {
    await mergeClean(card, project, bounce);
  } finally {
    if (stash) {
      try {
        git.stashRestore(repo, stash);
        log(card, "system", "📦 Tus cambios sin commitear vuelven a estar en tu repo.");
      } catch {
        log(card, "system", `⚠️ Tus cambios sin commitear chocan con lo mergeado: siguen a salvo en el stash "tus cambios mientras se mergeaba…" (git stash list / git stash pop).`);
      }
    }
  }
}

async function mergeClean(card: Card, project: Project, bounce: (msg: string) => void) {
  const repo = project.repo_path;
  if (!card.branch) return;

  // 1. Start from what's on GitHub (you may have pushed from another computer).
  const s = await remote.syncBranch(repo, project.base_branch);
  if (s.pulled) log(card, "system", `⬇️ ${project.base_branch} actualizado desde ${remote.remoteLabel(repo)} (${s.pulled} commit(s) nuevos).`);
  if (!s.ok && !s.offline) return bounce(s.message ?? "No pude actualizar la rama base");
  if (s.offline) log(card, "system", `⚠️ ${s.message} — mergeo en local; haz push cuando vuelva la conexión.`);

  // 2. The card's latest work: here, or pushed by the computer that ran it.
  const local = !!card.worktree && existsSync(card.worktree) && (!card.machine || card.machine === MACHINE);
  if (local) git.commitAll(card.worktree!, card.title);
  else {
    const f = await remote.fetchCardBranch(repo, card.branch);
    if (!f.ok) return bounce(f.message!);
  }

  // 3. Merge, 4. push.
  // Untracked files the card also adds would stop the merge: park them, then try to put them back.
  const clashes = git.untrackedClashes(repo, card.branch);
  const parked = git.stashSave(repo, `trellai: tus ficheros sin commitear que "${card.title}" también trae`, clashes);
  if (parked) log(card, "system", `📦 Aparto ${clashes.join(", ")}: no están en git y la tarjeta también los trae.`);
  const r = git.mergeIntoBase(repo, project.base_branch, card.branch, `Merge "${card.title}" (trellai)`);
  if (parked) {
    try {
      git.stashRestore(repo, parked, { fromClean: false });
      log(card, "system", `📦 ${clashes.join(", ")}: tu versión vuelve a estar en tu repo.`);
    } catch {
      log(card, "system", `⚠️ ${clashes.join(", ")}: ahora lo trae ${project.base_branch}, así que dejo tu versión sin commitear en el stash "tus ficheros sin commitear que…" (git stash list / git stash show -p).`);
    }
  }
  if (r.ok) {
    mergeFixAttempts.delete(card.id);
    git.removeWorktree(repo, local ? card.worktree : null, card.branch);
    remote.deleteRemoteBranch(repo, card.branch);
    log(card, "system", `✅ Mergeada en ${project.base_branch} (${r.sha.slice(0, 7)})`);
    const p = s.remote && !s.offline ? await remote.pushBranch(repo, project.base_branch) : null;
    if (p?.ok) log(card, "system", `⬆️ Push de ${project.base_branch} a ${remote.remoteLabel(repo)}.`);
    else if (p) log(card, "system", `⚠️ ${p.message}`);
    set(card.id, {
      status: p && !p.ok ? "error" : "idle",
      status_text: p && !p.ok ? `Mergeada (${r.sha.slice(0, 7)}) pero sin push: ${p.message}` : `Merge ${r.sha.slice(0, 7)}`,
      worktree: null,
      branch: null,
    });
    return;
  }
  if (r.reason === "conflict") {
    // The card stays in Merged: its agent resolves the conflict and the merge carries on by itself.
    // Runs for minutes: start it outside the repo lock.
    outsideLocks(() => bg(resolveMergeConflict(db.getCard(card.id)!, project), card));
    return;
  }
  bounce(r.error);
}

// ---------------------------------------------------------------------------
// Human input
// ---------------------------------------------------------------------------

export function sendMessage(cardId: string, said: string, attachmentIds: number[] = []) {
  const card = db.getCard(cardId);
  if (!card) throw new Error("Tarjeta no encontrada");
  // Images go in the message as Markdown (Pedro sees them in the chat); the agent gets their files too.
  const images = attachmentIds.map((id) => db.getAttachment(id)).filter((a) => !!a).map(messageImageMarkdown);
  const shown = [said, images.join("\n")].filter(Boolean).join("\n\n");
  log(card, "user", shown);
  const text = withMessageImages(card, projectOf(card).repo_path, shown);

  if (runningElsewhere(card)) {
    // The owner sees this message through the sync and hands it to its agent.
    log(card, "system", `Se lo paso al agente de ${card.machine} en cuanto termine el paso actual.`);
    return;
  }
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
      logMove(c, "review", "doing", "has pedido cambios");
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
  const card = db.getCard(cardId);
  if (card && runningElsewhere(card)) {
    set(card.id, { stop_req: card.machine });
    log(card, "system", `⏹ Pido a ${card.machine} que pare el agente.`);
    return;
  }
  stopAgent(cardId);
}

export function retry(cardId: string) {
  const card = db.getCard(cardId);
  if (!card) throw new Error("Tarjeta no encontrada");
  if (isRunning(card.id)) return;
  if (runningElsewhere(card)) throw new Error(`Está trabajando en ${card.machine}.`);
  rebaseAttempts.delete(card.id);
  mergeFixAttempts.delete(card.id);
  bg(onEnter(card, card.column), card);
}

export async function removeCard(cardId: string) {
  const card = db.getCard(cardId);
  if (!card) return;
  if (isRunning(card.id)) {
    stopAgent(card.id);
    await waitUntilStopped(card.id);
  }
  try {
    releasePreview(card.project_id, card.id);
  } catch {
    /* repo has local edits: leave it where it is */
  }
  if (runningElsewhere(card)) stop(card.id);
  const project = db.getProject(card.project_id);
  if ((card.worktree || card.branch) && project?.repo_path) {
    git.removeWorktree(project.repo_path, card.worktree, card.branch);
    if (card.branch) remote.deleteRemoteBranch(project.repo_path, card.branch);
  }
  if (project?.repo_path) removeAttachmentFiles(project.repo_path, card.id);
  claims.sweep(card.project_id, card.id); // before its notes lose their author
  db.deleteCard(card.id);
}

/** After a restart nothing is actually running anymore. */
export function recoverAfterRestart() {
  db.db
    .prepare(
      `UPDATE cards SET status = 'error', status_text = 'Interrumpido al reiniciar el servidor — pulsa Reintentar'
       WHERE status = 'running' AND (machine IS NULL OR machine = ?)`,
    )
    .run(MACHINE);
}

// ---------------------------------------------------------------------------
// Reacting to other computers (board sync)
// ---------------------------------------------------------------------------

onSync({
  card(before, after) {
    // Someone else took the card, merged it or deleted it: drop our now-stale worktree.
    if (before?.worktree && !isRunning(before.id)) {
      const gone = !after || after.column === "merged" || !after.branch || (!!after.machine && after.machine !== MACHINE);
      const project = db.getProject(before.project_id);
      if (gone && project?.repo_path) {
        try {
          releasePreview(project.id, before.id);
        } catch {
          /* local edits: leave the checkout alone */
        }
        try {
          if (!existsSync(before.worktree) || !git.hasChanges(before.worktree)) {
            git.removeWorktree(project.repo_path, before.worktree, before.branch);
            if (after) db.updateCard(after.id, { worktree: null });
          }
        } catch (err) {
          console.warn("[sync] cleanup:", (err as Error).message);
        }
      }
    }
    if (before?.column === "doing" && after?.column !== "doing") claims.sweep(before.project_id);
    if (!after) return;
    // Another computer pressed "Parar" on our agent.
    if (after.stop_req === MACHINE) {
      if (isRunning(after.id)) stopAgent(after.id);
      set(after.id, { stop_req: null });
    }
    // Previewing a card that's being worked on elsewhere: follow its pushed commits.
    const pv = getPreview(after.project_id);
    if (pv?.cardId === after.id && after.branch && after.machine !== MACHINE) {
      const project = db.getProject(after.project_id);
      if (project?.repo_path) {
        remote.fetchCardBranch(project.repo_path, after.branch).then(() => followPreview(db.getCard(after.id)!), () => {});
      }
    }
  },
  message(m) {
    // Pedro wrote from another computer to an agent running here.
    const card = db.getCard(m.card_id);
    if (m.role === "user" && card && isRunning(m.card_id)) db.pushPendingInput(m.card_id, withMessageImages(card, projectOf(card).repo_path, m.content));
  },
  projectDeleting(projectId) {
    const project = db.getProject(projectId);
    if (!project?.repo_path) return;
    for (const c of db.listCards(projectId)) {
      if (isRunning(c.id)) stopAgent(c.id);
      if (c.worktree) git.removeWorktree(project.repo_path, c.worktree, c.branch);
    }
  },
});
