/**
 * Talking to GitHub (or whatever `origin` is).
 *
 * - Before starting work (preparing, opening a worktree, Directo, merging) we fetch and
 *   fast-forward the base branch, so agents start from what's on GitHub — you may have
 *   pushed from another computer.
 * - After a merge (and after Directo commits) the base branch is pushed.
 * - Card branches are pushed as agents commit, so another computer can pick a card up.
 *
 * Repos without a remote just skip all of this. Git never prompts (GIT_TERMINAL_PROMPT=0):
 * it uses the credentials you already have (ssh keys, credential helper, gh).
 */
import { execFile, spawn } from "node:child_process";
import * as git from "./git.js";
import { repoLock } from "./lock.js";

const PUSH_BRANCHES = process.env.TRELLAI_PUSH_BRANCHES !== "0";

const env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15" }),
};

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function run(cwd: string, args: string[], timeout = 60_000): Promise<GitResult> {
  return new Promise((resolve) =>
    execFile(
      "git",
      ["-c", "user.name=Trellai", "-c", "user.email=trellai@localhost", ...args],
      { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || (error?.message ?? "")).trim() }),
    ),
  );
}

const firstLine = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/^(fatal|error|hint|remote):\s*/i, "").trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" — ") || "error desconocido";

/** "origin" if it exists, else the first remote, else null. */
export async function remoteOf(repo: string): Promise<string | null> {
  const r = await run(repo, ["remote"]);
  const names = r.out.split("\n").filter(Boolean);
  return names.includes("origin") ? "origin" : (names[0] ?? null);
}

export async function remoteUrl(repo: string): Promise<string | null> {
  const remote = await remoteOf(repo);
  if (!remote) return null;
  const r = await run(repo, ["remote", "get-url", remote]);
  return r.ok ? r.out : null;
}

export const sameRemote = git.sameRemoteSync;

export interface SyncResult {
  /** there is a remote at all */
  remote: boolean;
  /** fetch worked and the branch is now up to date (or there was nothing to do) */
  ok: boolean;
  /** commits brought in from the remote */
  pulled: number;
  /** local commits not on the remote (after syncing) */
  ahead: number;
  /** remote commits we could not bring in */
  behind: number;
  /** could not reach the remote (no network, auth…) */
  offline?: boolean;
  /** human-readable problem, in Spanish */
  message?: string;
}

const lastFetch = new Map<string, number>();

/** git fetch, at most once every `maxAgeMs` per repo. */
export async function fetchRemote(repo: string, maxAgeMs = 0): Promise<{ ok: boolean; remote: string | null; message?: string }> {
  const remote = await remoteOf(repo);
  if (!remote) return { ok: true, remote: null };
  const last = lastFetch.get(repo) ?? 0;
  if (maxAgeMs && Date.now() - last < maxAgeMs) return { ok: true, remote };
  const r = await run(repo, ["fetch", "--prune", remote], 45_000);
  if (!r.ok) return { ok: false, remote, message: `No pude conectar con ${remote}: ${firstLine(r.err)}` };
  lastFetch.set(repo, Date.now());
  return { ok: true, remote };
}

async function counts(repo: string, branch: string, remote: string) {
  const r = await run(repo, ["rev-list", "--left-right", "--count", `${branch}...${remote}/${branch}`]);
  if (!r.ok) return null; // branch missing on one side
  const [ahead, behind] = r.out.split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

const refExists = async (repo: string, ref: string) => (await run(repo, ["rev-parse", "--verify", "--quiet", ref])).ok;

/**
 * Bring `branch` (normally the base branch) up to date with the remote.
 * Never loses work: if it can't fast-forward or rebase cleanly it leaves things as they are
 * and explains why.
 */
export function syncBranch(repo: string, branch: string, opts: { maxAgeMs?: number } = {}): Promise<SyncResult> {
  return repoLock(repo, () => syncBranchUnlocked(repo, branch, opts));
}

async function syncBranchUnlocked(repo: string, branch: string, opts: { maxAgeMs?: number }): Promise<SyncResult> {
  const f = await fetchRemote(repo, opts.maxAgeMs);
  if (!f.remote) return { remote: false, ok: true, pulled: 0, ahead: 0, behind: 0 };
  if (!f.ok) return { remote: true, ok: false, offline: true, pulled: 0, ahead: 0, behind: 0, message: f.message };
  const remote = f.remote;
  if (!(await refExists(repo, `refs/remotes/${remote}/${branch}`))) {
    // Nothing on the remote yet (new repo): nothing to pull.
    const local = await refExists(repo, `refs/heads/${branch}`);
    return { remote: true, ok: true, pulled: 0, ahead: local ? 1 : 0, behind: 0 };
  }
  const c = await counts(repo, branch, remote);
  if (!c) return { remote: true, ok: true, pulled: 0, ahead: 0, behind: 0 };
  if (c.behind === 0) return { remote: true, ok: true, pulled: 0, ahead: c.ahead, behind: 0 };

  const checkedOut = git.currentBranch(repo) === branch;
  if (checkedOut) {
    const dirty = git.trackedDirty(repo);
    if (dirty.length) {
      return {
        remote: true, ok: false, pulled: 0, ...c,
        message: `Hay ${c.behind} commit(s) nuevos en ${remote}/${branch}, pero tienes cambios sin commitear en tu repo; no lo actualizo.`,
      };
    }
    const r = c.ahead === 0
      ? await run(repo, ["merge", "--ff-only", `${remote}/${branch}`])
      : await run(repo, ["rebase", `${remote}/${branch}`]);
    if (!r.ok) {
      if (c.ahead) await run(repo, ["rebase", "--abort"]);
      return {
        remote: true, ok: false, pulled: 0, ...c,
        message: `Tu ${branch} y el de ${remote} se han separado y no se pueden juntar solos: ${firstLine(r.err)}`,
      };
    }
    return { remote: true, ok: true, pulled: c.behind, ahead: c.ahead, behind: 0 };
  }

  // Not checked out in the main repo: move the ref directly (only fast-forwards).
  if (c.ahead > 0) {
    return {
      remote: true, ok: false, pulled: 0, ...c,
      message: `Tu ${branch} local tiene ${c.ahead} commit(s) que no están en ${remote} y le faltan ${c.behind}. Cámbiate a ${branch} y haz pull.`,
    };
  }
  const oldSha = git.shaOf(repo, `refs/heads/${branch}`);
  const newSha = git.shaOf(repo, `refs/remotes/${remote}/${branch}`);
  const r = await run(repo, ["update-ref", `refs/heads/${branch}`, newSha!, oldSha!]);
  if (!r.ok) return { remote: true, ok: false, pulled: 0, ...c, message: firstLine(r.err) };
  return { remote: true, ok: true, pulled: c.behind, ahead: 0, behind: 0 };
}

/** Push `branch` to the remote. If rejected because the remote moved, sync and try once more. */
export function pushBranch(repo: string, branch: string): Promise<{ ok: boolean; remote: boolean; message?: string }> {
  return repoLock(repo, () => pushBranchUnlocked(repo, branch));
}

async function pushBranchUnlocked(repo: string, branch: string): Promise<{ ok: boolean; remote: boolean; message?: string }> {
  const remote = await remoteOf(repo);
  if (!remote) return { ok: true, remote: false };
  let r = await run(repo, ["push", "-u", remote, branch], 60_000);
  if (!r.ok && /rejected|non-fast-forward|fetch first/i.test(r.err)) {
    const s = await syncBranch(repo, branch);
    if (!s.ok) return { ok: false, remote: true, message: s.message };
    r = await run(repo, ["push", "-u", remote, branch], 60_000);
  }
  return r.ok ? { ok: true, remote: true } : { ok: false, remote: true, message: `No pude hacer push: ${firstLine(r.err)}` };
}

// ---- card branches (background, best effort) ----

const queues = new Map<string, Promise<unknown>>();

/** Serialise pushes per branch so they never overlap. */
function enqueue(key: string, job: () => Promise<unknown>) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job).catch(() => {});
  queues.set(key, next);
  next.then(() => queues.get(key) === next && queues.delete(key));
  return next;
}

/** Push a card branch (force-with-lease: rebases rewrite it). Fire and forget. */
export function pushCardBranch(cwd: string, branch: string): Promise<unknown> {
  if (!PUSH_BRANCHES) return Promise.resolve();
  return enqueue(branch, async () => {
    const remote = await remoteOf(cwd);
    if (!remote) return;
    const r = await run(cwd, ["push", "--force-with-lease", "-u", remote, `${branch}:${branch}`], 60_000);
    if (!r.ok) console.warn(`[remote] push ${branch}: ${firstLine(r.err)}`);
  });
}

export function deleteRemoteBranch(repo: string, branch: string) {
  if (!PUSH_BRANCHES) return;
  enqueue(branch, async () => {
    const remote = await remoteOf(repo);
    if (!remote) return;
    if (!(await refExists(repo, `refs/remotes/${remote}/${branch}`))) return;
    await run(repo, ["push", remote, "--delete", branch], 30_000);
  });
}

/** Wait for queued pushes of a branch (used before another computer takes the card). */
export function flushBranch(branch: string) {
  return queues.get(branch) ?? Promise.resolve();
}

/** Make sure a card branch that lives on the remote exists locally (and is current). */
export async function fetchCardBranch(repo: string, branch: string): Promise<{ ok: boolean; message?: string }> {
  const remote = await remoteOf(repo);
  if (!remote) {
    return (await refExists(repo, `refs/heads/${branch}`))
      ? { ok: true }
      : { ok: false, message: `La rama ${branch} no está en este ordenador y el repo no tiene remoto.` };
  }
  const r = await run(repo, ["fetch", remote, `+${branch}:refs/heads/${branch}`], 45_000);
  if (r.ok) return { ok: true };
  if (await refExists(repo, `refs/heads/${branch}`)) return { ok: true }; // checked out here already, or offline
  return { ok: false, message: `No encuentro la rama ${branch} en ${remote}: ${firstLine(r.err)}` };
}

/** Ahead/behind of the base branch vs the remote, for the header. Fetches at most once a minute. */
export async function baseStatus(repo: string, base: string) {
  const f = await fetchRemote(repo, 60_000);
  if (!f.remote) return { remote: null as string | null, ok: true, ahead: 0, behind: 0 };
  const c = await counts(repo, base, f.remote);
  return { remote: f.remote, ok: f.ok, message: f.message, ahead: c?.ahead ?? 0, behind: c?.behind ?? 0 };
}

export interface CloneProgress {
  /** "Recibiendo objetos", "Resolviendo deltas"… */
  phase: string;
  /** 0–100 over the whole clone (receiving is 0–90, resolving deltas 90–100). */
  percent: number;
}

const PHASES: Record<string, [string, number, number]> = {
  "Counting objects": ["Contando objetos", 0, 0],
  "Compressing objects": ["Comprimiendo objetos", 0, 0],
  "Receiving objects": ["Recibiendo objetos", 0, 90],
  "Resolving deltas": ["Resolviendo deltas", 90, 10],
};

/** One line of `git clone --progress` → progress, or null for lines we don't follow. */
export function parseCloneProgress(line: string): CloneProgress | null {
  const m = line.match(/(Counting objects|Compressing objects|Receiving objects|Resolving deltas):\s+(\d+)%/);
  if (!m) return null;
  const [phase, from, span] = PHASES[m[1]];
  return { phase, percent: Math.round(from + (span * Number(m[2])) / 100) };
}

export async function cloneRepo(url: string, dest: string, onProgress?: (p: CloneProgress) => void): Promise<{ ok: boolean; message?: string }> {
  if (!onProgress) {
    const r = await run(process.cwd(), ["clone", url, dest], 10 * 60_000);
    return r.ok ? { ok: true } : { ok: false, message: `No pude clonar: ${firstLine(r.err)}` };
  }
  // --progress: git writes "Receiving objects:  42% (…)\r" to stderr even without a terminal.
  return new Promise((resolve) => {
    const child = spawn("git", ["clone", "--progress", url, dest], { cwd: process.cwd(), env, windowsHide: true });
    let err = "";
    let rest = "";
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.stderr.on("data", (d: Buffer) => {
      const parts = (rest + d.toString()).split(/[\r\n]/);
      rest = parts.pop() ?? "";
      for (const line of parts) {
        const p = parseCloneProgress(line);
        if (p) onProgress(p);
        else if (line.trim()) err += line + "\n";
      }
    });
    const done = (ok: boolean, why = "") => {
      clearTimeout(timer);
      resolve(ok ? { ok: true } : { ok: false, message: `No pude clonar: ${firstLine(err + rest + why)}` });
    };
    child.on("error", (e) => done(false, e.message));
    child.on("close", (code) => done(code === 0, code === null ? "se tardó demasiado" : ""));
  });
}

/** "GitHub" when the remote is on github.com, else the remote's name. */
export function remoteLabel(repo: string): string {
  const url = git.remoteUrlSync(repo) ?? "";
  return /github\.com/i.test(url) ? "GitHub" : /gitlab/i.test(url) ? "GitLab" : "origin";
}

export async function hasRemoteBranch(repo: string, branch: string): Promise<boolean> {
  const remote = await remoteOf(repo);
  return !!remote && (await refExists(repo, `refs/remotes/${remote}/${branch}`));
}
