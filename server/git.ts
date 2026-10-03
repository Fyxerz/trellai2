import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err) {
    if (opts.allowFail) return "";
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error(`git ${args.join(" ")}: ${(e.stderr || e.stdout || e.message).trim()}`);
  }
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isRepo(path: string): boolean {
  return existsSync(path) && gitOk(path, ["rev-parse", "--is-inside-work-tree"]);
}

export function topLevel(path: string): string {
  return git(path, ["rev-parse", "--show-toplevel"]);
}

export function currentBranch(repo: string): string {
  return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "card"
  );
}

/** Keep `.trellai/` out of the user's repo without touching tracked files. */
function ensureExcluded(repo: string) {
  const gitDir = resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]));
  const exclude = join(gitDir, "info", "exclude");
  mkdirSync(join(gitDir, "info"), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!current.split("\n").includes(".trellai/")) {
    appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}.trellai/\n`);
  }
}

export function createWorktree(repo: string, base: string, cardId: string, title: string, existingBranch?: string) {
  ensureExcluded(repo);
  const slug = existingBranch ? existingBranch.replace(/^trellai\//, "").replace(/[^\w.-]+/g, "-") : `${slugify(title)}-${cardId.slice(0, 4).toLowerCase()}`;
  const branch = existingBranch ?? `trellai/${slug}`;
  const path = join(repo, ".trellai", "worktrees", slug);
  if (existsSync(path)) return { branch, path };
  mkdirSync(join(repo, ".trellai", "worktrees"), { recursive: true });
  const branchExists = gitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  git(repo, branchExists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, base]);
  return { branch, path };
}

export function removeWorktree(repo: string, path: string | null, branch: string | null) {
  if (path && existsSync(path)) git(repo, ["worktree", "remove", "--force", path], { allowFail: true });
  git(repo, ["worktree", "prune"], { allowFail: true });
  if (branch) git(repo, ["branch", "-D", branch], { allowFail: true });
}

export function hasChanges(cwd: string): boolean {
  return git(cwd, ["status", "--porcelain"]).length > 0;
}

/** Commit everything in the worktree. Returns the new sha or null if nothing to commit. */
export function commitAll(cwd: string, message: string): string | null {
  if (!hasChanges(cwd)) return null;
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.name=Trellai", "-c", "user.email=trellai@localhost", "commit", "-m", message, "--no-verify"]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Rebase the worktree branch on top of base. On conflict it aborts and returns ok=false. */
export function rebaseOnto(cwd: string, base: string): { ok: boolean; error?: string } {
  try {
    git(cwd, ["-c", "user.name=Trellai", "-c", "user.email=trellai@localhost", "rebase", base]);
    return { ok: true };
  } catch (err) {
    git(cwd, ["rebase", "--abort"], { allowFail: true });
    return { ok: false, error: (err as Error).message };
  }
}

/** Files touched on the branch (committed + uncommitted) relative to base. */
export function changedFiles(cwd: string, base: string): string[] {
  const mb = git(cwd, ["merge-base", base, "HEAD"], { allowFail: true }) || base;
  const committed = git(cwd, ["diff", "--name-only", mb, "HEAD"], { allowFail: true });
  const status = git(cwd, ["status", "--porcelain"], { allowFail: true })
    .split("\n")
    .filter(Boolean)
    .map((l) => porcelainPath(l));
  return [...new Set([...committed.split("\n").filter(Boolean), ...status])];
}

/** Full diff of the card's work vs base, including uncommitted and untracked files. */
export function diffVsBase(cwd: string, base: string): string {
  const mb = git(cwd, ["merge-base", base, "HEAD"], { allowFail: true }) || base;
  // intent-to-add so untracked files show up in the diff
  git(cwd, ["add", "-N", "."], { allowFail: true });
  return git(cwd, ["diff", "--no-color", mb], { allowFail: true });
}

export function commitsAhead(cwd: string, base: string): number {
  const n = git(cwd, ["rev-list", "--count", `${base}..HEAD`], { allowFail: true });
  return Number(n) || 0;
}

/**
 * Merge `branch` into `base` in the main checkout.
 * Requires the main checkout to be on `base` with no tracked changes.
 */
export function mergeIntoBase(repo: string, base: string, branch: string, message: string) {
  const head = currentBranch(repo);
  if (head !== base) {
    return { ok: false as const, reason: "checkout" as const, error: `El repo está en la rama "${head}", no en "${base}".` };
  }
  const dirty = git(repo, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    return { ok: false as const, reason: "dirty" as const, error: `Hay cambios sin commitear en ${repo}.` };
  }
  try {
    git(repo, ["-c", "user.name=Trellai", "-c", "user.email=trellai@localhost", "merge", "--no-ff", "-m", message, branch]);
    return { ok: true as const, sha: git(repo, ["rev-parse", "HEAD"]) };
  } catch (err) {
    git(repo, ["merge", "--abort"], { allowFail: true });
    return { ok: false as const, reason: "conflict" as const, error: (err as Error).message };
  }
}

/** Turn a plain folder into a repo with one commit (worktrees need a commit to branch from). */
export function initRepo(path: string) {
  git(path, ["init", "-b", "main"]);
  git(path, ["add", "-A"]);
  git(path, ["-c", "user.name=Trellai", "-c", "user.email=trellai@localhost", "commit", "--allow-empty", "-m", "Initial commit"]);
}

export function hasCommits(repo: string): boolean {
  return gitOk(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
}

/** Uncommitted paths and a content hash for each, to tell later which ones changed. */
export function dirtySnapshot(repo: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = git(repo, ["status", "--porcelain", "-uall"], { allowFail: true }).split("\n").filter(Boolean);
  for (const l of lines) {
    const path = porcelainPath(l);
    const hash = git(repo, ["hash-object", "--", path], { allowFail: true }) || "deleted";
    out.set(path, hash);
  }
  return out;
}

/**
 * Commit only what changed since `before` (so your own uncommitted work is left alone).
 * Returns the sha, or null when there was nothing new.
 */
export function commitChangedSince(repo: string, before: Map<string, string>, message: string): string | null {
  const after = dirtySnapshot(repo);
  const paths = [...after.entries()].filter(([p, h]) => before.get(p) !== h).map(([p]) => p);
  if (!paths.length) return null;
  git(repo, ["add", "-A", "--", ...paths]);
  git(repo, ["-c", "user.name=Trellai", "-c", "user.email=trellai@localhost", "commit", "-m", message, "--no-verify", "--", ...paths]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** Tracked changes in a checkout (untracked files don't block a checkout unless they collide). */
export function trackedDirty(repo: string): string[] {
  return git(repo, ["status", "--porcelain", "--untracked-files=no"], { allowFail: true }).split("\n").filter(Boolean);
}

/** Where HEAD points: a branch name, or a sha when detached. */
export function headRef(repo: string): string {
  const b = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return b === "HEAD" ? git(repo, ["rev-parse", "HEAD"]) : b;
}

/** Put the main checkout at `ref` (detached, so a branch used by a worktree is fine). */
export function checkoutDetached(repo: string, ref: string) {
  git(repo, ["checkout", "--detach", ref]);
}

export function checkoutRef(repo: string, ref: string) {
  git(repo, ["checkout", ref]);
}

export function shaOf(repo: string, ref: string): string | null {
  return git(repo, ["rev-parse", "--verify", "--quiet", ref], { allowFail: true }) || null;
}

/** Path from a `git status --porcelain` line (robust to the leading space being trimmed). */
export function porcelainPath(line: string): string {
  return line.replace(/^\s*[ MADRCU?!]{1,2}\s+/, "").split(" -> ").pop()!.replace(/^"|"$/g, "");
}

export function remoteUrlSync(repo: string): string | null {
  const names = git(repo, ["remote"], { allowFail: true }).split("\n").filter(Boolean);
  const r = names.includes("origin") ? "origin" : names[0];
  return r ? git(repo, ["remote", "get-url", r], { allowFail: true }) || null : null;
}

/** git@github.com:a/b.git and https://github.com/a/b are the same remote. */
export function sameRemoteSync(a: string | null, b: string | null): boolean {
  const norm = (u: string) =>
    u
      .trim()
      .replace(/^[a-z+]+:\/\//, "")
      .replace(/^[^@/]+@/, "")
      .replace(":", "/")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

/** Diff of a branch vs base without a worktree (a card running on another computer). */
export function diffBranch(repo: string, base: string, branch: string): { diff: string; files: string[] } {
  if (!shaOf(repo, `refs/heads/${branch}`)) return { diff: "", files: [] };
  const mb = git(repo, ["merge-base", base, branch], { allowFail: true }) || base;
  return {
    diff: git(repo, ["diff", "--no-color", mb, branch], { allowFail: true }),
    files: git(repo, ["diff", "--name-only", mb, branch], { allowFail: true }).split("\n").filter(Boolean),
  };
}
