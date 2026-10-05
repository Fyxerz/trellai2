/**
 * Several people on one board: when someone merges on GitHub, bring the base branch of every
 * project on this computer up to date by itself, about once a minute.
 *
 * Only safe fast-forwards: nothing local to lose. With uncommitted changes in the checkout, local
 * commits not pushed yet, a merge/rebase halfway, or a branch being previewed, it does nothing and
 * the header keeps showing ↓ with the manual button. Network problems are silent (the header
 * already shows them).
 *
 * Trellai on itself: a fast-forward of its checked-out branch moves HEAD, and selfupdate.ts picks
 * up the new code from there.
 */
import { existsSync } from "node:fs";
import * as db from "./db.js";
import { emitGit } from "./events.js";
import * as git from "./git.js";
import { getPreview } from "./preview.js";
import { syncBranch } from "./remote.js";

/** 0 turns it off. */
const EVERY_MS = Number(process.env.TRELLAI_AUTOPULL_MS ?? 60_000);

export async function autoPullOnce() {
  for (const p of db.listProjects()) {
    if (!p.repo_path || !existsSync(p.repo_path) || !git.isRepo(p.repo_path)) continue;
    if (getPreview(p.id)) continue; // "Ver esta rama" has the checkout (and maybe your edits stashed)
    try {
      // fetch at most once per round; the header's baseStatus shares the same throttle
      const r = await syncBranch(p.repo_path, p.base_branch, { ffOnly: true, maxAgeMs: EVERY_MS / 2 });
      if (r.pulled > 0) {
        console.log(`[autopull] ${p.name}: ${r.pulled} commit(s) nuevos en ${p.base_branch}`);
        emitGit(p.id);
      }
    } catch {
      /* try again next round */
    }
  }
}

export function startAutoPull() {
  if (!EVERY_MS) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await autoPullOnce();
    } finally {
      busy = false;
    }
  };
  setInterval(tick, EVERY_MS).unref();
  setTimeout(tick, Math.min(EVERY_MS, 10_000)).unref();
}
