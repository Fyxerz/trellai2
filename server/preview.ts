/**
 * "Ver esta rama": put a card's branch in the project's MAIN checkout, so whatever dev
 * server Pedro has running there (vite, next…) hot-reloads into that branch — no restart.
 *
 * The branch is checked out *detached* (it's already checked out in the card's worktree,
 * and git doesn't allow the same branch twice). While previewing, Trellai follows the
 * agent's new commits automatically. "Volver" returns to the branch you were on.
 * Uncommitted edits are stashed on the way in and restored on the way back.
 */
import type { Card } from "../shared/types.js";
import * as db from "./db.js";
import { emitPreview } from "./events.js";
import * as git from "./git.js";

export interface PreviewState {
  cardId: string;
  /** branch (or sha) to go back to */
  prev: string;
  /** sha currently checked out */
  sha: string | null;
  /** stash holding the uncommitted edits Pedro had before previewing (restored on "Volver") */
  stash: string | null;
}

export function getPreview(projectId: string): PreviewState | null {
  const r = db.db
    .prepare("SELECT preview_card_id AS c, preview_prev AS p, preview_sha AS s, preview_stash AS st FROM projects WHERE id = ?")
    .get(projectId) as { c: string | null; p: string | null; s: string | null; st: string | null } | undefined;
  return r?.c && r.p ? { cardId: r.c, prev: r.p, sha: r.s, stash: r.st } : null;
}

function save(projectId: string, s: PreviewState | null) {
  db.db
    .prepare("UPDATE projects SET preview_card_id = ?, preview_prev = ?, preview_sha = ?, preview_stash = ? WHERE id = ?")
    .run(s?.cardId ?? null, s?.prev ?? null, s?.sha ?? null, s?.stash ?? null, projectId);
  emitPreview(projectId, s?.cardId ?? null);
}

/** Uncommitted files that will be stashed: tracked edits + untracked files in the way. */
function fileList(repo: string, untracked: string[] = []) {
  const all = [...git.trackedDirty(repo).map(git.porcelainPath), ...untracked];
  return all.slice(0, 4).join(", ") + (all.length > 4 ? ` y ${all.length - 4} más` : "");
}

/** What happened to Pedro's uncommitted edits, to show him. */
export interface PreviewResult {
  ok: true;
  message?: string;
}

/**
 * Uncommitted edits in the main checkout (yours, or another Claude working there) no longer
 * block "Ver esta rama": they're stashed, and put back when you return to your branch.
 */
export function startPreview(card: Card): PreviewResult {
  const project = db.getProject(card.project_id);
  if (!project) throw new Error("Proyecto no encontrado");
  if (!card.branch) throw new Error("Esta tarjeta todavía no tiene rama.");
  const repo = project.repo_path;
  const current = getPreview(project.id);
  // Untracked files the card's branch also has would stop the checkout: they go in the stash too.
  const clashes = git.untrackedClashes(repo, card.branch);
  const files = fileList(repo, clashes);
  // Already previewing another card: edits made meanwhile were made on that card's branch.
  const stash = current
    ? git.stashSave(repo, `trellai: cambios hechos mientras veías otra tarjeta`, clashes)
    : git.stashSave(repo, `trellai: tus cambios antes de ver "${card.title}"`, clashes);

  // Include the agent's latest edits when nobody is mid-edit.
  if (card.worktree && card.status !== "running") {
    try {
      git.commitAll(card.worktree, `${card.title} (wip)`);
    } catch {
      /* nothing to commit */
    }
  }
  const prev = current?.prev ?? git.headRef(repo);
  try {
    git.checkoutDetached(repo, card.branch);
  } catch (e) {
    // Leave things as they were.
    if (stash) git.stashRestore(repo, stash);
    throw new Error(`No pude cambiar a la rama: ${(e as Error).message.replace(/^git [^:]*: /, "")}`);
  }
  save(project.id, { cardId: card.id, prev, sha: git.shaOf(repo, "HEAD"), stash: current ? current.stash : stash });
  if (!stash) return { ok: true };
  return {
    ok: true,
    message: current
      ? `Había cambios sin commitear sobre la otra tarjeta (${files}). Los he guardado en un stash ("cambios hechos mientras veías otra tarjeta"); recupéralos con git stash pop si los quieres.`
      : `Tenías cambios sin commitear (${files}). Los he guardado aparte y vuelven solos cuando pulses "Volver a ${prev}".`,
  };
}

export function stopPreview(projectId: string): PreviewResult {
  const s = getPreview(projectId);
  if (!s) return { ok: true };
  const project = db.getProject(projectId)!;
  const repo = project.repo_path;
  const notes: string[] = [];
  // Edits made while previewing were made on the card's branch: keep them aside, don't drop them.
  const clashes = git.untrackedClashes(repo, s.prev);
  const files = fileList(repo, clashes);
  const title = db.getCard(s.cardId)?.title ?? "otra tarjeta";
  if (git.stashSave(repo, `trellai: cambios hechos mientras veías "${title}"`, clashes)) {
    notes.push(`Los cambios hechos mientras veías la rama (${files}) están en un stash ("cambios hechos mientras veías…"); recupéralos con git stash pop si los quieres.`);
  }
  git.checkoutRef(repo, s.prev);
  save(projectId, null);
  if (s.stash) {
    try {
      git.stashRestore(repo, s.stash);
      notes.unshift("He vuelto a poner los cambios sin commitear que tenías.");
    } catch {
      notes.unshift(
        `No pude volver a poner tus cambios sin commitear sin conflictos: siguen a salvo en el stash "tus cambios antes de ver…" (git stash list / git stash pop).`,
      );
    }
  }
  return notes.length ? { ok: true, message: notes.join(" ") } : { ok: true };
}

/** Called after Trellai commits on a card's branch: if it's being previewed, move the checkout forward. */
export function followPreview(card: Card) {
  const s = getPreview(card.project_id);
  if (!s || s.cardId !== card.id || !card.branch) return;
  const project = db.getProject(card.project_id)!;
  const sha = git.shaOf(project.repo_path, card.branch);
  if (!sha || sha === s.sha) return;
  if (git.trackedDirty(project.repo_path).length) return; // never clobber local edits
  try {
    git.checkoutDetached(project.repo_path, card.branch);
    save(project.id, { ...s, sha });
  } catch (e) {
    console.error("[preview] follow failed:", e);
  }
}

/** Before something needs the main checkout back (merge, Directo, deleting the card). */
export function releasePreview(projectId: string, onlyCardId?: string): boolean {
  const s = getPreview(projectId);
  if (!s || (onlyCardId && s.cardId !== onlyCardId)) return false;
  stopPreview(projectId);
  return true;
}
