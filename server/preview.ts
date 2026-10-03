/**
 * "Ver esta rama": put a card's branch in the project's MAIN checkout, so whatever dev
 * server Pedro has running there (vite, next…) hot-reloads into that branch — no restart.
 *
 * The branch is checked out *detached* (it's already checked out in the card's worktree,
 * and git doesn't allow the same branch twice). While previewing, Trellai follows the
 * agent's new commits automatically. "Volver" returns to the branch you were on.
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
}

export function getPreview(projectId: string): PreviewState | null {
  const r = db.db.prepare("SELECT preview_card_id AS c, preview_prev AS p, preview_sha AS s FROM projects WHERE id = ?").get(projectId) as
    | { c: string | null; p: string | null; s: string | null }
    | undefined;
  return r?.c && r.p ? { cardId: r.c, prev: r.p, sha: r.s } : null;
}

function save(projectId: string, s: PreviewState | null) {
  db.db
    .prepare("UPDATE projects SET preview_card_id = ?, preview_prev = ?, preview_sha = ? WHERE id = ?")
    .run(s?.cardId ?? null, s?.prev ?? null, s?.sha ?? null, projectId);
  emitPreview(projectId, s?.cardId ?? null);
}

function dirtyError(repo: string) {
  const dirty = git.trackedDirty(repo);
  if (!dirty.length) return null;
  const files = dirty.slice(0, 4).map(git.porcelainPath).join(", ");
  return `Tienes cambios sin commitear en tu repo (${files}${dirty.length > 4 ? "…" : ""}). Haz commit o stash y vuelve a probar.`;
}

export function startPreview(card: Card) {
  const project = db.getProject(card.project_id);
  if (!project) throw new Error("Proyecto no encontrado");
  if (!card.branch) throw new Error("Esta tarjeta todavía no tiene rama.");
  const repo = project.repo_path;
  const err = dirtyError(repo);
  if (err) throw new Error(err);

  // Include the agent's latest edits when nobody is mid-edit.
  if (card.worktree && card.status !== "running") {
    try {
      git.commitAll(card.worktree, `${card.title} (wip)`);
    } catch {
      /* nothing to commit */
    }
  }
  const current = getPreview(project.id);
  const prev = current?.prev ?? git.headRef(repo);
  try {
    git.checkoutDetached(repo, card.branch);
  } catch (e) {
    throw new Error(`No pude cambiar a la rama: ${(e as Error).message.replace(/^git [^:]*: /, "")}`);
  }
  save(project.id, { cardId: card.id, prev, sha: git.shaOf(repo, "HEAD") });
}

export function stopPreview(projectId: string): { ok: true } {
  const s = getPreview(projectId);
  if (!s) return { ok: true };
  const project = db.getProject(projectId)!;
  const err = dirtyError(project.repo_path);
  if (err) throw new Error(err);
  git.checkoutRef(project.repo_path, s.prev);
  save(projectId, null);
  return { ok: true };
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
