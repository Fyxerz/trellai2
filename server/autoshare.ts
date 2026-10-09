/**
 * Share the board with whoever has the same GitHub repo, without codes.
 *
 * The invitation lives in the repo itself, in a hidden ref (`refs/trellai/board`: a commit with
 * one file, `invite`). It isn't cloned, fetched or shown on GitHub by default, and only people
 * with access to the repo can read it — so it's only published for private repos.
 *
 * - Your Trellai (with a database to share through) publishes it the first time it sees one of
 *   your private GitHub projects without it.
 * - Someone else's Trellai, on a project with that same repo, finds it and joins: their own
 *   board for the repo is merged into the shared one.
 */
import { execFile } from "node:child_process";
import type { Project } from "../shared/types.js";
import * as db from "./db.js";
import { withGitHubAuth } from "./remote.js";
import { cachedInvite, createInvite, decodeInvite, joinWithCode, leftShare, repoSlug, shareOf, staleInvite, syncStatus } from "./sync.js";

const REF = "refs/trellai/board";
const OFF = process.env.TRELLAI_AUTOSHARE === "0";
/** Tests: treat any remote as a private GitHub repo. */
const ANY_REMOTE = process.env.TRELLAI_AUTOSHARE_ANY === "1";
const EVERY = 10 * 60_000;

const env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15" }),
};

function git(cwd: string, args: string[], input?: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = execFile(
      "git",
      ["-c", "user.name=Trellai", "-c", "user.email=trellai@localhost", ...args],
      { cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || (error?.message ?? "")).trim() }),
    );
    if (input !== undefined) {
      p.stdin?.write(input);
      p.stdin?.end();
    }
  });
}

/** The invitation published in the repo's origin, if any. */
async function readRemote(repo: string): Promise<string | null> {
  const ls = await withGitHubAuth(repo, () => git(repo, ["ls-remote", "origin", REF]));
  if (!ls.ok || !ls.out) return null;
  const f = await git(repo, ["fetch", "--quiet", "--no-tags", "origin", `+${REF}:${REF}`]);
  if (!f.ok) return null;
  const show = await git(repo, ["show", `${REF}:invite`]);
  return show.ok ? show.out.trim() : null;
}

/** Publish an invitation; false if someone else got there first (or it can't be pushed). */
async function publish(repo: string, code: string, replace = false): Promise<boolean> {
  const blob = await git(repo, ["hash-object", "-w", "--stdin"], code + "\n");
  if (!blob.ok) return false;
  const tree = await git(repo, ["mktree"], `100644 blob ${blob.out}\tinvite\n`);
  if (!tree.ok) return false;
  const commit = await git(repo, ["commit-tree", tree.out, "-m", "Trellai: tablero compartido"]);
  if (!commit.ok) return false;
  // never forced (unless it's our own, outdated one): the first one to publish wins, the others join it
  const push = await withGitHubAuth(repo, () => git(repo, ["push", "--quiet", "origin", `${replace ? "+" : ""}${commit.out}:${REF}`]));
  if (push.ok) await git(repo, ["update-ref", REF, commit.out]);
  return push.ok;
}

/** Take the invitation out of the repo (sharing turned off). */
export async function unpublish(project: Project) {
  const repo = project.repo_path;
  if (!repo) return;
  const code = await readRemote(repo);
  if (code && decodeInvite(code)?.project === project.id) await withGitHubAuth(repo, () => git(repo, ["push", "--quiet", "origin", `:${REF}`]));
}

const publicCache = new Map<string, boolean | null>();
/** true = public GitHub repo, false = private, null = not GitHub / can't tell. */
async function isPublic(remote: string): Promise<boolean | null> {
  if (ANY_REMOTE) return false;
  const slug = repoSlug(remote);
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) return null;
  if (publicCache.has(slug)) return publicCache.get(slug)!;
  let v: boolean | null = null;
  try {
    // Without credentials GitHub only shows public repos: 404 for one we can push to = private.
    const r = await fetch(`https://api.github.com/repos/${slug}`, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "trellai" } });
    if (r.status === 404) v = false;
    else if (r.ok) v = !(((await r.json()) as { private?: boolean }).private ?? false);
  } catch {
    /* offline */
  }
  if (v !== null) publicCache.set(slug, v);
  return v;
}

/** Turned off by hand for this project. */
export const autoOff = (projectId: string) => db.localGet(`autoshare-off:${projectId}`) === "1";

export interface AutoShareState {
  /** published in the repo (or joined through it) */
  on: boolean;
  /** why it isn't ("" = it is, or it's about to be) */
  reason: string;
}
const state = new Map<string, AutoShareState>();
export const autoShareState = (projectId: string): AutoShareState =>
  state.get(projectId) ?? { on: false, reason: OFF ? "Desactivado en este ordenador (TRELLAI_AUTOSHARE=0)." : "Comprobando el repo…" };

const running = new Map<string, Promise<Project | undefined>>();

/**
 * Look at one project: join the board published in its repo, or publish ours.
 * Returns the project to show (the shared one, if this one was merged into it).
 */
export function check(projectId: string): Promise<Project | undefined> {
  const busy = running.get(projectId);
  if (busy) return busy;
  const p = checkOnce(projectId).finally(() => running.delete(projectId));
  running.set(projectId, p);
  return p;
}

async function checkOnce(projectId: string): Promise<Project | undefined> {
  const project = db.getProject(projectId);
  if (!project) return undefined;
  const set = (on: boolean, reason = "") => state.set(projectId, { on, reason });
  if (OFF) return project;
  if (!project.repo_path || !project.remote_url) return set(false, "El proyecto necesita un repo de GitHub en este ordenador."), project;
  if (!db.me()) return set(false, "Pon antes tu nombre (arriba a la derecha)."), project;
  if (autoOff(projectId)) return set(false, "Lo has desactivado para este proyecto."), project;
  try {
    const code = await readRemote(project.repo_path);
    const inv = code ? decodeInvite(code) : null;
    if (inv && inv.project !== projectId) {
      // Someone shares this repo's board: join it (once; not again if you left).
      if (leftShare(inv.project)) return set(false, "Saliste del tablero compartido de este repo."), project;
      const joined = await joinWithCode(code!, { mergeFrom: projectId });
      console.log(`[autoshare] ${project.name}: unido al tablero de ${inv.by}`);
      state.delete(projectId);
      state.set(joined.id, { on: true, reason: "" });
      return joined;
    }
    // Ours, made by us with a database we no longer use (TRELLAI_DATABASE_URL changed): publish it again.
    const outdated = !!inv && inv.by === db.me()!.name && staleInvite(code!);
    if (inv && !outdated) return set(true), project; // ours, already published
    if (leftShare(projectId)) return set(false, "Dejaste de compartirlo."), project;
    const sync = syncStatus();
    if (!sync.enabled && !shareOf(projectId)) return set(false, "Hace falta una base de datos para compartir (TRELLAI_DATABASE_URL)."), project;
    const pub = await isPublic(project.remote_url);
    if (pub !== false) return set(false, pub ? "El repo es público: el tablero no se publica en él. Usa el enlace." : "Solo se publica en repos privados de GitHub."), project;
    const invite = cachedInvite(projectId) ?? (await createInvite(projectId));
    if (await publish(project.repo_path, invite, outdated)) {
      console.log(`[autoshare] ${project.name}: tablero publicado en el repo`);
      return set(true), project;
    }
    // Someone published at the same time: join theirs next time round.
    return set(false, "No pude publicarlo en el repo (¿sin permiso de escritura?)."), project;
  } catch (err) {
    set(false, (err as Error).message);
    return db.getProject(projectId);
  }
}

/** Check every project now and then (new projects are checked when added). */
export function startAutoShare() {
  if (OFF) return;
  const all = async () => {
    for (const p of db.listProjects()) await check(p.id).catch(() => {});
  };
  setTimeout(all, 5000);
  setInterval(all, EVERY);
}
