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
export function ensureExcluded(repo: string) {
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

/**
 * Changed line ranges per file on the branch (committed + uncommitted) vs base, numbered as in
 * the branch's version. Untracked files map to "new", deleted ones to "deleted".
 */
export function changedLines(cwd: string, base: string): Map<string, [number, number][] | "new" | "deleted"> {
  const mb = git(cwd, ["merge-base", base, "HEAD"], { allowFail: true }) || base;
  const out = new Map<string, [number, number][] | "new" | "deleted">();
  const diff = git(cwd, ["-c", "core.quotepath=off", "diff", "-U0", "--no-color", "--no-ext-diff", mb], { allowFail: true });
  const unquote = (p: string) => p.replace(/^"(.*)"$/, "$1");
  let file: string | null = null;
  let oldFile: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) oldFile = line === "--- /dev/null" ? null : unquote(line.slice(4)).replace(/^a\//, "");
    else if (line.startsWith("+++ ")) {
      if (line === "+++ /dev/null") {
        if (oldFile) out.set(oldFile, "deleted");
        file = null;
      } else {
        file = unquote(line.slice(4)).replace(/^b\//, "");
        if (!out.has(file)) out.set(file, []);
      }
    } else if (file && line.startsWith("@@")) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const start = Math.max(1, Number(m[1]));
      const count = m[2] === undefined ? 1 : Number(m[2]);
      (out.get(file) as [number, number][]).push([start, start + Math.max(count, 1) - 1]);
    }
  }
  for (const f of git(cwd, ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard"], { allowFail: true }).split("\n")) {
    if (f) out.set(f, "new");
  }
  return out;
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

/**
 * Untracked files in the checkout that `ref` tracks: checking out or merging `ref` would refuse
 * to overwrite them (e.g. another Claude created the same file in your folder).
 */
export function untrackedClashes(repo: string, ref: string): string[] {
  const untracked = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"], { allowFail: true }).split("\0").filter(Boolean);
  if (!untracked.length) return [];
  const inRef = new Set(git(repo, ["ls-tree", "-r", "--name-only", "-z", ref], { allowFail: true }).split("\0"));
  return untracked.filter((f) => inRef.has(f));
}

/**
 * Put tracked local edits — plus these untracked files, if any — in a stash.
 * Returns its commit sha (null when there was nothing to save).
 */
export function stashSave(repo: string, message: string, untracked: string[] = []): string | null {
  const tracked = trackedDirty(repo).length > 0;
  if (!tracked && !untracked.length) return null;
  if (!untracked.length) git(repo, ["stash", "push", "-m", message]);
  else {
    const changed = tracked ? git(repo, ["diff", "HEAD", "--name-only", "-z"]).split("\0").filter(Boolean) : [];
    git(repo, ["--literal-pathspecs", "stash", "push", "--include-untracked", "-m", message, "--", ...changed, ...untracked]);
  }
  return git(repo, ["rev-parse", "stash@{0}"]);
}

/**
 * Re-apply the stash with this sha and drop it. On a conflict the stash is kept and this throws
 * so the caller can tell Pedro. With `fromClean` (the tree was clean before) a failed apply is
 * undone with a reset; otherwise nothing is reset, so other restored edits stay.
 */
export function stashRestore(repo: string, sha: string, { fromClean = true }: { fromClean?: boolean } = {}) {
  try {
    git(repo, ["stash", "apply", "--index", sha]);
  } catch (first) {
    if (!fromClean) throw first;
    git(repo, ["reset", "--hard", "-q"], { allowFail: true });
    try {
      git(repo, ["stash", "apply", sha]); // staged state couldn't be restored: plain apply
    } catch (err) {
      git(repo, ["reset", "--hard", "-q"], { allowFail: true });
      throw err;
    }
  }
  const i = git(repo, ["stash", "list", "--format=%H"], { allowFail: true }).split("\n").indexOf(sha);
  if (i >= 0) git(repo, ["stash", "drop", "-q", `stash@{${i}}`], { allowFail: true });
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

export interface BranchInfo {
  name: string;
  /** exists in this computer (refs/heads) */
  local: boolean;
  /** exists on the remote (refs/remotes/<remote>) */
  remote: boolean;
  /** local vs its copy on the remote */
  ahead: number;
  behind: number;
  /** all its commits are already in the base branch */
  merged: boolean;
  /** the main checkout is on it */
  current: boolean;
  /** checked out in a worktree (a card's agent) */
  worktree: string | null;
  sha: string;
  subject: string;
  date: string;
}

/** Every branch, local and on the remote, merged by name. Nothing is fetched here. */
export function listBranches(repo: string, base: string): { head: string; detached: boolean; remote: string | null; branches: BranchInfo[] } {
  const remotes = git(repo, ["remote"], { allowFail: true }).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
  const head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
  const detached = head === "HEAD";
  const worktrees = new Map<string, string>();
  let wtPath = "";
  for (const l of git(repo, ["worktree", "list", "--porcelain"], { allowFail: true }).split("\n")) {
    if (l.startsWith("worktree ")) wtPath = l.slice(9);
    else if (l.startsWith("branch refs/heads/") && resolve(wtPath) !== resolve(repo)) worktrees.set(l.slice(18), wtPath);
  }
  const merged = new Set(git(repo, ["for-each-ref", "--merged", base, "--format=%(refname)", "refs/heads", "refs/remotes"], { allowFail: true }).split("\n"));

  const byName = new Map<string, BranchInfo>();
  const refs = git(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(objectname:short)%00%(committerdate:iso-strict)%00%(subject)", "refs/heads", ...(remote ? [`refs/remotes/${remote}`] : [])], { allowFail: true });
  for (const line of refs.split("\n").filter(Boolean)) {
    const [ref, sha, date, subject] = line.split("\0");
    const isLocal = ref.startsWith("refs/heads/");
    const name = isLocal ? ref.slice(11) : ref.slice(`refs/remotes/${remote}/`.length);
    if (!isLocal && name === "HEAD") continue;
    const b = byName.get(name) ?? { name, local: false, remote: false, ahead: 0, behind: 0, merged: true, current: false, worktree: worktrees.get(name) ?? null, sha, subject, date };
    if (isLocal) Object.assign(b, { local: true, sha, subject, date, current: !detached && name === head });
    else b.remote = true;
    b.merged &&= merged.has(ref);
    byName.set(name, b);
  }
  for (const b of byName.values()) {
    if (!b.local || !b.remote) continue;
    const [ahead, behind] = git(repo, ["rev-list", "--left-right", "--count", `refs/heads/${b.name}...refs/remotes/${remote}/${b.name}`], { allowFail: true }).split(/\s+/).map(Number);
    b.ahead = ahead || 0;
    b.behind = behind || 0;
  }
  return { head: detached ? git(repo, ["rev-parse", "--short", "HEAD"], { allowFail: true }) : head, detached, remote, branches: [...byName.values()] };
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

/** `ancestor` is reachable from `ref` (or is it). */
export function isAncestor(cwd: string, ancestor: string, ref = "HEAD"): boolean {
  return gitOk(cwd, ["merge-base", "--is-ancestor", ancestor, ref]);
}

/** Subjects of the commits in `from..to`, newest first. */
export function commitSubjects(cwd: string, from: string, to = "HEAD"): string[] {
  return git(cwd, ["log", "--format=%s", `${from}..${to}`], { allowFail: true }).split("\n").filter(Boolean);
}

/** Put the worktree exactly at `ref`: drops later commits, uncommitted edits and untracked (non-ignored) files. */
export function resetHard(cwd: string, ref: string) {
  git(cwd, ["reset", "--hard", "-q", ref]);
  git(cwd, ["clean", "-fdq"]);
}
