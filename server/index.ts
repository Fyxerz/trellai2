import "./env.js";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { AVATAR_COLORS, COLUMNS, isColumn, TAG_COLORS, type CloneJob, type Project, type ServerEvent, type Sharing } from "../shared/types.js";
import { sweepAll } from "./claims.js";
import * as db from "./db.js";
import { cleanAnnotations, parseImage } from "./attachments.js";
import { emitAttachments, emitCard, emitCardDeleted, emitCheckpoints, emitGit, emitMessage, emitNote, emitTags, subscribe } from "./events.js";
import * as git from "./git.js";
import * as wf from "./workflow.js";
import { claudeLoggedIn, claudeModels, codexDefaultModel, codexModels, codexStatus, loginState, mcpCallTool, mcpListTools, startLogin } from "./engine.js";
import { startPreview, stopPreview } from "./preview.js";
import { MACHINE } from "./machine.js";
import * as remote from "./remote.js";
import { repoLock } from "./lock.js";
import * as github from "./github.js";
import * as autoshare from "./autoshare.js";
import { cachedInvite, createInvite, inviteProblem, joinWithCode, removeMember, shareOf, startSync, stopSharing, syncStatus } from "./sync.js";
import { assistantRunning, sendToAssistant, stopAssistant } from "./assistant.js";
import { buildInfo, distDir, startSelfUpdate } from "./selfupdate.js";
import { startAutoPull } from "./autopull.js";
import { backgroundFile, backgroundStatus, generateBackground, imageMime, stopBackground } from "./background.js";

const app = new Hono();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 400);
});

const expandHome = (p: string) => resolve(p.replace(/^~(?=$|[\\/])/, homedir()));

// ---------- folder browser ----------

app.get("/api/fs", (c) => {
  const path = expandHome(c.req.query("path") || "~");
  const showHidden = c.req.query("hidden") === "1";
  if (!existsSync(path) || !statSync(path).isDirectory()) return c.json({ error: `No existe: ${path}` }, 400);
  let entries: { name: string; path: string; isRepo: boolean }[] = [];
  try {
    entries = readdirSync(path, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && (showHidden || !d.name.startsWith(".")))
      .map((d) => join(path, d.name))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      })
      .map((p) => ({ name: basename(p), path: p, isRepo: existsSync(join(p, ".git")) }))
      .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
  } catch (err) {
    return c.json({ error: `Sin permiso para leer ${path}` }, 400);
  }
  const isRepo = existsSync(join(path, ".git"));
  return c.json({
    path,
    parent: path === parse(path).root ? null : dirname(path),
    home: homedir(),
    isRepo,
    branch: isRepo ? safe(() => git.currentBranch(path)) : null,
    entries,
    nativePicker: process.platform === "darwin",
  });
});

const safe = <T,>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/** macOS: open the native Finder "choose folder" dialog. */
app.post("/api/fs/pick", async (c) => {
  if (process.platform !== "darwin") return c.json({ error: "Solo disponible en macOS" }, 400);
  const path = await new Promise<string | null>((res) =>
    execFile(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Elige el repositorio para Trellai")'],
      { timeout: 5 * 60_000 },
      (err, out) => res(err ? null : out.trim().replace(/\/$/, "") || null),
    ),
  );
  return c.json({ path });
});

// ---------- projects ----------

app.get("/api/projects", (c) => c.json(db.listProjects()));

/** Add the repo at `path` to the board (shared by "Carpeta local" and "Clonar de GitHub"). */
function addProject(path: string, opts: { name?: string; base_branch?: string; init?: boolean } = {}): { project: Project } | { error: string; notRepo?: boolean } {
  if (!existsSync(path) || !statSync(path).isDirectory()) return { error: `No existe la carpeta: ${path}` };
  if (!git.isRepo(path)) {
    if (!opts.init) return { error: `No es un repositorio git: ${path}`, notRepo: true };
    git.initRepo(path);
  }
  const repo = git.topLevel(path);
  if (!git.hasCommits(repo)) return { error: "El repo no tiene ningún commit todavía. Haz un primer commit." };
  const remoteUrl = git.remoteUrlSync(repo);
  // Already on the board from another computer? Then this is just where it lives here.
  const twin = db.listProjects().find((p) => !p.repo_path && git.sameRemoteSync(p.remote_url, remoteUrl));
  if (twin) return { project: db.updateProject(twin.id, { repo_path: repo })! };
  const base = opts.base_branch?.trim() || git.defaultBranch(repo);
  if (!base) return { error: "No encuentro ninguna rama en el repo para usar como base." };
  const problem = git.baseBranchProblem(repo, base);
  if (problem) return { error: problem };
  try {
    git.ensureLocalBranch(repo, base);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const name = basename(opts.name?.trim() || repo);
  return { project: db.createProject({ name, repo_path: repo, base_branch: base, remote_url: remoteUrl }) };
}

/** Branches of a folder that isn't a project yet (for "Nuevo proyecto"), plus the one to preselect. */
app.get("/api/branches", (c) => {
  const path = expandHome(String(c.req.query("path") ?? "").trim());
  if (!path || !git.isRepo(path)) return c.json({ local: [], remote: [], suggested: null });
  const repo = git.topLevel(path);
  return c.json({ ...git.branchNames(repo), suggested: git.defaultBranch(repo) });
});

app.post("/api/projects", async (c) => {
  const body = await c.req.json<{ name?: string; repo_path?: string; base_branch?: string; init?: boolean }>();
  const r = addProject(expandHome(String(body.repo_path ?? "").trim()), body);
  return "error" in r ? c.json(r, 400) : c.json(await sharedBoard(r.project));
});

/**
 * Someone already shares this repo's board? Then the new project joins it (your cards go there).
 * Waits a few seconds at most; after that it goes on in the background.
 */
async function sharedBoard(project: Project): Promise<Project> {
  const timeout = new Promise<undefined>((r) => setTimeout(r, 10_000));
  return (await Promise.race([autoshare.check(project.id), timeout])) ?? db.getProject(project.id) ?? project;
}

/** Your GitHub repos through the `gh` CLI (+ whether it's installed / logged in). */
app.get("/api/github/repos", async (c) => c.json(await github.listRepos()));

/** Where clones go by default: the folder most of your projects live in (else ~/code). */
function cloneDir(): string {
  const count = new Map<string, number>();
  for (const p of db.listProjects()) {
    if (!p.repo_path || !existsSync(p.repo_path)) continue;
    const parent = dirname(resolve(p.repo_path));
    count.set(parent, (count.get(parent) ?? 0) + 1);
  }
  const best = [...count].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : expandHome("~/code");
}

app.get("/api/clone-dir", (c) => c.json({ dir: cloneDir(), sep: process.platform === "win32" ? "\\" : "/" }));

/** Clone a repo (default: <cloneDir>/<name>) and add it to the board. A folder already holding that repo is reused. */
app.post("/api/projects/clone", async (c) => {
  const body = await c.req.json<{ url?: string; dest?: string; name?: string; base_branch?: string }>();
  let url = String(body.url ?? "").trim();
  if (!url) return c.json({ error: "Pega la URL del repo." }, 400);
  // "owner/name" → GitHub
  if (/^[\w.-]+\/[\w.-]+$/.test(url) && !existsSync(expandHome(url))) url = `https://github.com/${url}.git`;
  const dirName = github.repoDirName(url);
  if (!dirName) return c.json({ error: `No entiendo esa URL: ${url}` }, 400);
  const dest = expandHome(body.dest?.trim() || join(cloneDir(), dirName));
  const opts = { name: body.name?.trim() || dirName, base_branch: body.base_branch };
  if (existsSync(dest)) {
    if (git.isRepo(dest) && git.sameRemoteSync(git.remoteUrlSync(dest), url)) {
      // Already cloned there: reuse it (and its project, if it's on the board already).
      const repo = git.topLevel(dest);
      const existing = db.listProjects().find((p) => p.repo_path && resolve(p.repo_path) === resolve(repo));
      if (existing) return c.json(existing);
      const r = addProject(repo, opts);
      return "error" in r ? c.json(r, 400) : c.json(r.project);
    }
    const empty = statSync(dest).isDirectory() && readdirSync(dest).length === 0;
    if (!empty) {
      const other = git.isRepo(dest) ? git.remoteUrlSync(dest) : null;
      return c.json({ error: `Ya existe ${dest} y ${other ? `es otro repo (${other})` : "no es una copia de este repo"}. Elige otra carpeta de destino.` }, 400);
    }
  }
  if (cloningInto.has(resolve(dest))) return c.json({ error: `Ya se está clonando algo en ${dest}.` }, 400);
  // The clone itself runs in the background: the client follows it with GET /api/clone-jobs/:id.
  const jobId = `clone-${Date.now().toString(36)}-${++cloneSeq}`;
  const job: CloneJob = { stage: "cloning", percent: 0, message: "Conectando…" };
  cloneJobs.set(jobId, job);
  cloningInto.add(resolve(dest));
  (async () => {
    const cloned = await remote.cloneRepo(url, dest, (p) => Object.assign(job, { percent: p.percent, message: p.phase }));
    if (!cloned.ok) return Object.assign(job, { stage: "error", message: cloned.message });
    Object.assign(job, { stage: "creating", percent: 100, message: undefined });
    const r = addProject(dest, opts);
    if ("error" in r) Object.assign(job, { stage: "error", message: r.error });
    else Object.assign(job, { stage: "done", project: await sharedBoard(r.project) });
  })()
    .catch((e) => Object.assign(job, { stage: "error", message: String(e?.message ?? e) }))
    .finally(() => {
      cloningInto.delete(resolve(dest));
      setTimeout(() => cloneJobs.delete(jobId), 60 * 60_000);
    });
  return c.json({ jobId });
});

/** Background clones (in memory: they're gone if the server restarts). */
const cloneJobs = new Map<string, CloneJob>();
const cloningInto = new Set<string>();
let cloneSeq = 0;

app.get("/api/clone-jobs/:id", (c) => {
  const job = cloneJobs.get(c.req.param("id"));
  return job ? c.json(job) : c.json({ error: "Ese clonado ya no existe (¿se reinició Trellai?)." }, 404);
});

// ---------- other computers / GitHub ----------

app.get("/api/sync", (c) => c.json(syncStatus()));

// ---------- people and sharing projects with them ----------

/** Everyone this Trellai knows (yours and the people you share projects with) + who you are here. */
app.get("/api/people", (c) => c.json({ me: db.meId(), machine: MACHINE, people: db.listPeople() }));

/** Your name and avatar color (`adopt`: you're already this person on another computer). */
app.post("/api/me", async (c) => {
  const body = await c.req.json<{ name?: string; color?: string; adopt?: string }>();
  const adopted = body.adopt ? db.getPerson(body.adopt) : undefined;
  const name = (body.name ?? adopted?.name ?? "").trim().slice(0, 40);
  if (!name) return c.json({ error: "Escribe tu nombre." }, 400);
  const color = /^#[0-9a-f]{6}$/i.test(body.color ?? "") ? body.color! : (adopted?.color ?? AVATAR_COLORS[0]);
  const me = db.setMe({ name, color, adopt: adopted?.id }, MACHINE);
  // now there's someone to share as
  for (const p of db.listProjects()) autoshare.check(p.id).catch(() => {});
  return c.json(me);
});

app.get("/api/projects/:id/sharing", (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Proyecto no encontrado" }, 404);
  const sharing: Sharing = {
    members: db.listMembers(project.id),
    share: shareOf(project.id),
    ownDb: syncStatus().enabled,
    problem: inviteProblem(project),
    auto: { ...autoshare.autoShareState(project.id), enabled: !autoshare.autoOff(project.id) },
  };
  return c.json(sharing);
});

/** The project's invitation (made the first time it's asked for). */
app.get("/api/projects/:id/invite", async (c) => {
  const cached = cachedInvite(c.req.param("id"));
  if (cached) return c.json({ code: cached });
  try {
    return c.json({ code: await createInvite(c.req.param("id")) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Share automatically with whoever has the repo (on by default). */
app.post("/api/projects/:id/autoshare", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Proyecto no encontrado" }, 404);
  const { on } = await c.req.json<{ on: boolean }>();
  db.localSet(`autoshare-off:${project.id}`, on ? null : "1");
  if (on) await autoshare.check(project.id);
  else await autoshare.unpublish(project);
  return c.json({ ...autoshare.autoShareState(project.id), enabled: on });
});

/** Invitation code for a project (`db`: a Postgres URL other than TRELLAI_DATABASE_URL). */
app.post("/api/projects/:id/invite", async (c) => {
  const body = await c.req.json<{ db?: string }>().catch(() => ({}) as { db?: string });
  try {
    return c.json({ code: await createInvite(c.req.param("id"), body.db) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Paste an invitation code: the project shows up here and syncs from now on. */
app.post("/api/shares", async (c) => {
  const { code } = await c.req.json<{ code?: string }>();
  try {
    return c.json(await joinWithCode(String(code ?? "")));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post("/api/projects/:id/members/:person/remove", async (c) => {
  await removeMember(c.req.param("id"), c.req.param("person"));
  return c.json({ ok: true });
});

app.post("/api/projects/:id/unshare", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (project) await autoshare.unpublish(project).catch(() => {});
  await stopSharing(c.req.param("id"));
  return c.json({ ok: true });
});

/** Link a project that came from another computer to a folder on this one. */
app.post("/api/projects/:id/link", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Proyecto no encontrado" }, 404);
  const { repo_path } = await c.req.json<{ repo_path: string }>();
  const path = expandHome(String(repo_path ?? "").trim());
  if (!git.isRepo(path)) return c.json({ error: `No es un repositorio git: ${path}` }, 400);
  const repo = git.topLevel(path);
  const url = git.remoteUrlSync(repo);
  if (project.remote_url && url && !git.sameRemoteSync(project.remote_url, url)) {
    return c.json({ error: `Esa carpeta apunta a ${url}, pero el proyecto es ${project.remote_url}.` }, 400);
  }
  return c.json(await sharedBoard(db.updateProject(project.id, { repo_path: repo, remote_url: project.remote_url ?? url })));
});

/** Clone a project that came from another computer (default: ~/code/<name>). */
app.post("/api/projects/:id/clone", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Proyecto no encontrado" }, 404);
  if (!project.remote_url) return c.json({ error: "Este proyecto no tiene remoto: elige su carpeta a mano." }, 400);
  const body = await c.req.json<{ dest?: string }>().catch(() => ({}) as { dest?: string });
  const name = project.remote_url.replace(/\.git$/, "").split(/[/:]/).pop() || project.name;
  const dest = expandHome(body.dest?.trim() || join("~/code", name));
  if (existsSync(dest)) {
    if (git.isRepo(dest) && git.sameRemoteSync(git.remoteUrlSync(dest), project.remote_url)) {
      return c.json(db.updateProject(project.id, { repo_path: git.topLevel(dest) }));
    }
    return c.json({ error: `Ya existe ${dest} y no es este repo. Elige la carpeta a mano.` }, 400);
  }
  const r = await remote.cloneRepo(project.remote_url, dest);
  if (!r.ok) return c.json({ error: r.message }, 400);
  return c.json(db.updateProject(project.id, { repo_path: dest }));
});

const PROJECT_DOCS = ["README.md", "AGENTS.md", "CLAUDE.md"];
const DOC_MAX_BYTES = 200_000;

/** The repo's README / AGENTS.md / CLAUDE.md (root only, any casing), for the read-only "Documentos del proyecto" modal. */
app.get("/api/projects/:id/docs", (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project?.repo_path || !existsSync(project.repo_path)) return c.json({ error: "Este proyecto no está en este ordenador" }, 400);
  const root = resolve(project.repo_path);
  const entries = readdirSync(root);
  const docs: { name: string; content: string; truncated: boolean }[] = [];
  for (const wanted of PROJECT_DOCS) {
    const name = entries.find((e) => e.toLowerCase() === wanted.toLowerCase());
    if (!name) continue;
    const path = join(root, name);
    try {
      const st = statSync(path); // follows symlinks: skip directories and anything that leaves the repo
      if (!st.isFile() || !realpathSync(path).startsWith(realpathSync(root) + sep)) continue;
      const buf = readFileSync(path);
      docs.push({ name, content: buf.subarray(0, DOC_MAX_BYTES).toString("utf8"), truncated: buf.length > DOC_MAX_BYTES });
    } catch {}
  }
  return c.json(docs);
});

/** Base branch vs the remote, for the header (fetches at most once a minute). */
app.get("/api/projects/:id/git", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project?.repo_path) return c.json({ remote: null, ahead: 0, behind: 0, ok: true });
  const st = await remote.baseStatus(project.repo_path, project.base_branch);
  if (!st.behind) return c.json(st);
  // a new merge on the remote: pull it right away
  const r = await remote.syncBranch(project.repo_path, project.base_branch).catch(() => null);
  if (!r?.pulled) return c.json(st);
  emitGit(project.id);
  return c.json(await remote.baseStatus(project.repo_path, project.base_branch));
});

const ACTIVE_COLUMNS = new Set(["plan", "preparation", "doing", "review"]);

/** Every branch with its card and, when it can't be deleted from the menu, why. */
function branchRows(project: Project) {
  const list = git.listBranches(project.repo_path!, project.base_branch);
  const cards = new Map(db.listCards(project.id).filter((k) => k.branch).map((k) => [k.branch!, k]));
  return {
    ...list,
    branches: list.branches.map((b) => {
      const k = cards.get(b.name);
      const locked =
        b.name === project.base_branch
          ? "Es la rama base."
          : b.current
            ? "Estás en esta rama: cámbiate a otra primero."
            : k && ACTIVE_COLUMNS.has(k.column)
              ? `Es de la tarjeta «${k.title}», que está en curso: se quita descartando la tarjeta.`
              : null;
      return { ...b, card: k ? { id: k.id, title: k.title, column: k.column } : null, locked };
    }),
  };
}
type BranchRowInfo = ReturnType<typeof branchRows>["branches"][number];

/** Delete one branch (local, worktree and remote). Errors come back in the result, never thrown. */
async function deleteBranch(project: Project, b: BranchRowInfo, force: boolean) {
  const repo = project.repo_path!;
  if (b.locked) return { name: b.name, ok: false, error: b.locked };
  if (!b.merged && !force)
    return { name: b.name, ok: false, error: `Tiene ${b.unmerged} commit(s) que no están en ${project.base_branch}; se perderían.` };
  if (b.dirty && !force) return { name: b.name, ok: false, error: `Su carpeta de trabajo (${b.worktree}) tiene cambios sin commitear.` };
  const errors: string[] = [];
  if (b.local || b.worktree) {
    try {
      await repoLock(repo, async () => git.deleteLocalBranch(repo, b.name, { worktree: b.worktree, force }));
    } catch (err) {
      errors.push((err as Error).message.replace(/^git [^:]*: /, ""));
    }
  }
  if (b.remote && !errors.length) {
    const r = await remote.deleteRemoteBranchNow(repo, b.name);
    if (!r.ok) errors.push(r.message!);
  }
  return errors.length ? { name: b.name, ok: false, error: errors.join(" — ") } : { name: b.name, ok: true };
}

/** All branches (local + remote) for the header's branch list, with the card each one belongs to. */
app.get("/api/projects/:id/branches", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project?.repo_path) return c.json({ error: "Este proyecto no está en este ordenador" }, 400);
  const f = await remote.fetchRemote(project.repo_path, 60_000);
  const list = branchRows(project);
  const where = project.base_branch === "HEAD" ? null : git.branchWhere(project.repo_path, project.base_branch);
  return c.json({
    ...list,
    base: project.base_branch,
    baseMissing: !where || (!where.local && !where.remote),
    remoteLabel: list.remote ? remote.remoteLabel(project.repo_path) : null,
    fetch: { ok: f.ok, message: f.message, fix: f.fix },
  });
});

/** Delete one branch from the menu. `force` = the user accepted losing unmerged commits / uncommitted changes. */
app.post("/api/projects/:id/branches/delete", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project?.repo_path) return c.json({ error: "Este proyecto no está en este ordenador" }, 400);
  const { name, force } = await c.req.json<{ name: string; force?: boolean }>();
  const b = branchRows(project).branches.find((x) => x.name === name);
  if (!b) return c.json({ error: `No existe la rama ${name}` }, 404);
  const r = await deleteBranch(project, b, !!force);
  return r.ok ? c.json(r) : c.json(r, b.locked ? 400 : 409);
});

/** Delete every branch already in the base branch (recomputed here; `names`, if given, narrows it to what the user saw). */
app.post("/api/projects/:id/branches/cleanup", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project?.repo_path) return c.json({ error: "Este proyecto no está en este ordenador" }, 400);
  const { names } = await c.req.json<{ names?: string[] }>().catch(() => ({ names: undefined }));
  const todo = branchRows(project).branches.filter((b) => b.merged && !b.locked && (!names || names.includes(b.name)));
  const results = [];
  for (const b of todo) results.push(await deleteBranch(project, b, false));
  return c.json({ results });
});

app.post("/api/projects/:id/pull", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project?.repo_path) return c.json({ error: "Proyecto no vinculado" }, 400);
  const r = await remote.syncBranch(project.repo_path, project.base_branch);
  if (!r.ok) return c.json({ error: r.message ?? "No se pudo actualizar" }, 400);
  if (r.ahead) {
    const p = await remote.pushBranch(project.repo_path, project.base_branch);
    if (!p.ok) return c.json({ error: p.message }, 400);
  }
  return c.json(r);
});

/** Whether `gh` is installed / logged in, for the "Crear repo en GitHub" dialog. */
app.get("/api/github/status", async (c) => c.json(await github.status()));

/** Create a GitHub repo for a project whose local repo has no remote, push the base branch and link it. */
app.post("/api/projects/:id/github", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Proyecto no encontrado" }, 404);
  if (!project.repo_path || !git.isRepo(project.repo_path)) return c.json({ error: "Este proyecto no está en este ordenador" }, 400);
  const repo = project.repo_path;
  if (git.remoteUrlSync(repo)) return c.json({ error: `Este repo ya tiene remoto: ${git.remoteUrlSync(repo)}` }, 400);
  if (!git.hasCommits(repo) || !git.shaOf(repo, `refs/heads/${project.base_branch}`))
    return c.json({ error: `La rama ${project.base_branch} no tiene ningún commit todavía. Haz un primer commit antes de subirla a GitHub.` }, 400);
  const body = await c.req.json<{ name?: string; description?: string; private?: boolean }>().catch(() => ({}) as { name?: string; description?: string; private?: boolean });
  const created = await repoLock(repo, () => github.createRepo(repo, { name: body.name ?? "", description: body.description, private: body.private !== false }));
  if (!created.ok) return c.json({ error: created.error, code: created.code }, 400);
  // createRepo already switched origin to HTTPS if SSH doesn't work here
  const updated = db.updateProject(project.id, { remote_url: git.remoteUrlSync(repo) });
  const pushed = await remote.pushBranch(repo, project.base_branch);
  // branches of cards already in progress go up now instead of on their next commit
  for (const card of db.listCards(project.id)) {
    if (card.branch && card.worktree && ACTIVE_COLUMNS.has(card.column) && existsSync(card.worktree)) remote.pushCardBranch(card.worktree, card.branch);
  }
  return c.json({ url: created.url, project: updated, pushError: pushed.ok ? undefined : pushed.message });
});

/** «Usar HTTPS»: origin is git@github.com:… but SSH isn't set up here → switch to HTTPS with gh's login. */
app.post("/api/projects/:id/use-https", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project?.repo_path) return c.json({ error: "Este proyecto no está en este ordenador" }, 400);
  const repo = project.repo_path;
  const r = await repoLock(repo, () => remote.useHttps(repo));
  const updated = r.url ? db.updateProject(project.id, { remote_url: r.url }) : project;
  if (!r.ok) return c.json({ error: r.message }, 400);
  // what couldn't go up before goes up now
  await remote.pushBranch(repo, project.base_branch);
  for (const card of db.listCards(project.id)) {
    if (card.branch && card.worktree && ACTIVE_COLUMNS.has(card.column) && existsSync(card.worktree)) remote.pushCardBranch(card.worktree, card.branch);
  }
  return c.json({ project: updated });
});

app.patch("/api/projects/:id", async (c) => {
  const body = await c.req.json<Record<string, string | null>>();
  const project = db.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Proyecto no encontrado" }, 404);
  if (body.base_branch !== undefined && body.base_branch !== project.base_branch) {
    const base = String(body.base_branch ?? "").trim();
    if (!project.repo_path) return c.json({ error: "Este proyecto no está en este ordenador: no puedo comprobar sus ramas." }, 400);
    const problem = git.baseBranchProblem(project.repo_path, base);
    if (problem) return c.json({ error: problem }, 400);
    try {
      await repoLock(project.repo_path, async () => git.ensureLocalBranch(project.repo_path!, base));
    } catch (err) {
      return c.json({ error: (err as Error).message.replace(/^git [^:]*: /, "") }, 400);
    }
    body.base_branch = base;
  }
  if (body.auto_doing !== undefined && typeof body.auto_doing !== "boolean") return c.json({ error: "auto_doing debe ser true o false" }, 400);
  if (body.bg_mode !== undefined && !["none", "color", "image"].includes(body.bg_mode as string))
    return c.json({ error: "Fondo no válido (none, color o image)" }, 400);
  if (body.bg_color != null && !/^#[0-9a-f]{6}$/i.test(body.bg_color)) return c.json({ error: "Color no válido (#rrggbb)" }, 400);
  delete body.bg_image; // only set by the generator
  return c.json(db.updateProject(c.req.param("id"), body));
});

// ---------- board background ----------

/** The generated image (this computer's `.trellai/background.*`). Use ?v=<bg_image> to bust the cache. */
app.get("/api/projects/:id/background", (c) => {
  const p = db.getProject(c.req.param("id"));
  const file = p?.repo_path ? backgroundFile(p.repo_path) : null;
  if (!file) return c.json({ error: "Este proyecto no tiene imagen de fondo en este ordenador" }, 404);
  const buf = readFileSync(file);
  return c.body(buf, 200, { "content-type": imageMime(buf), "cache-control": "private, max-age=31536000, immutable" });
});
app.get("/api/projects/:id/background/status", (c) => c.json(backgroundStatus(c.req.param("id"))));
/** Starts Codex (in the background); progress and the end arrive as "background" events. */
app.post("/api/projects/:id/background/generate", async (c) => c.json(await generateBackground(c.req.param("id"))));
app.post("/api/projects/:id/background/stop", (c) => {
  stopBackground(c.req.param("id"));
  return c.json(backgroundStatus(c.req.param("id")));
});

// ---------- engines / models ----------

app.get("/api/engines", async (c) => {
  const [models, codex, claudeIn] = await Promise.all([claudeModels().catch(() => []), codexStatus(), claudeLoggedIn()]);
  return c.json({
    claude: { installed: true, loggedIn: claudeIn, models, login: loginState("claude") },
    codex: { ...codex, defaultModel: codexDefaultModel(), models: codexModels(), login: loginState("codex") },
  });
});

// Opens the engine's login page in the browser (the CLI waits for the callback); the UI polls /api/engines.
app.post("/api/engines/:engine/login", (c) => {
  const engine = c.req.param("engine");
  if (engine !== "claude" && engine !== "codex") return c.json({ error: "Motor desconocido" }, 400);
  return c.json(startLogin(engine));
});

// Codex reaches Trellai's tools through server/mcp-bridge.mjs, which calls these.
app.get("/api/internal/mcp/:token/tools", (c) => {
  const tools = mcpListTools(c.req.param("token"));
  return tools ? c.json(tools) : c.json({ error: "unknown run" }, 404);
});

app.post("/api/internal/mcp/:token/call", async (c) => {
  const { name, arguments: args } = await c.req.json<{ name: string; arguments: unknown }>();
  try {
    const text = mcpCallTool(c.req.param("token"), name, args);
    return text === null ? c.json({ error: `unknown tool ${name}` }, 404) : c.json({ text });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get("/api/projects/summary", (c) => {
  // Everything the projects overview and the sidebar need, per project.
  const lastMsg = db.db
    .prepare(`SELECT c.project_id AS id, MAX(m.created_at) AS at FROM messages m JOIN cards c ON c.id = m.card_id GROUP BY c.project_id`)
    .all() as { id: string; at: string }[];
  const lastAssistant = db.db
    .prepare(`SELECT project_id AS id, MAX(created_at) AS at FROM assistant_messages GROUP BY project_id`)
    .all() as { id: string; at: string }[];
  const latest = (id: string, ...xs: (string | undefined)[]) => xs.filter(Boolean).sort().at(-1) ?? null;
  return c.json(
    db.listProjects().map((p) => {
      const cards = db.listCards(p.id);
      const columns = Object.fromEntries(COLUMNS.map((col) => [col, cards.filter((x) => x.column === col).length]));
      const active = cards
        .filter((x) => x.status === "running" || x.status === "waiting" || x.status === "ready" || x.status === "error" || x.column === "review")
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 4)
        .map((x) => ({ id: x.id, title: x.title, column: x.column, status: x.status }));
      return {
        id: p.id,
        total: cards.length,
        columns,
        running: cards.filter((x) => x.status === "running").length,
        waiting: cards.filter((x) => x.status === "waiting").length,
        errors: cards.filter((x) => x.status === "error").length,
        review: columns.review,
        active,
        last_activity: latest(
          p.id,
          p.created_at,
          cards.map((x) => x.updated_at).sort().at(-1),
          lastMsg.find((x) => x.id === p.id)?.at,
          lastAssistant.find((x) => x.id === p.id)?.at,
        ),
      };
    }),
  );
});


app.delete("/api/projects/:id", async (c) => {
  for (const card of db.listCards(c.req.param("id"))) await wf.removeCard(card.id);
  db.deleteProject(c.req.param("id"));
  return c.json({ ok: true });
});

// ---------- project assistant (mode: plan = cards, do = direct changes) ----------

const modeOf = (m: string | undefined): "plan" | "do" => (m === "do" ? "do" : "plan");

app.get("/api/projects/:id/assistant", (c) => {
  const mode = modeOf(c.req.query("mode"));
  return c.json({
    messages: db.listAssistantMessages(c.req.param("id"), mode),
    running: assistantRunning(c.req.param("id"), mode),
  });
});

app.post("/api/projects/:id/assistant", async (c) => {
  const { text, mode } = await c.req.json<{ text: string; mode?: string }>();
  if (!text?.trim()) return c.json({ error: "Mensaje vacío" }, 400);
  sendToAssistant(c.req.param("id"), text.trim(), modeOf(mode));
  return c.json({ ok: true });
});

app.post("/api/projects/:id/assistant/stop", (c) => {
  stopAssistant(c.req.param("id"), modeOf(c.req.query("mode")));
  return c.json({ ok: true });
});

app.delete("/api/projects/:id/assistant", (c) => {
  const mode = modeOf(c.req.query("mode"));
  stopAssistant(c.req.param("id"), mode);
  db.clearAssistant(c.req.param("id"), mode);
  return c.json({ ok: true });
});

app.get("/api/projects/:id/cards", (c) => c.json(db.listCards(c.req.param("id"))));
app.get("/api/projects/:id/notes", (c) => c.json(db.listNotes(c.req.param("id"))));

app.post("/api/projects/:id/notes", async (c) => {
  const { content, files } = await c.req.json<{ content: string; files?: string[] }>();
  const note = db.addNote(c.req.param("id"), null, `${db.me()?.name ?? "Pedro"}: ${content}`, { files: (files ?? []).map((f) => f.trim()).filter(Boolean) });
  emitNote(note);
  return c.json(note);
});

/** Stop showing a note to the agents (it stays in the channel's history). */
app.post("/api/notes/:id/archive", (c) => {
  const id = Number(c.req.param("id"));
  db.archiveNotes([id]);
  const note = db.getNote(id);
  if (!note) return c.json({ error: "Nota no encontrada" }, 404);
  emitNote(note);
  return c.json(note);
});

app.get("/api/projects/:id/events", (c) => {
  const projectId = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const queue: ServerEvent[] = [];
    let wake: (() => void) | null = null;
    const unsub = subscribe(projectId, (e) => {
      queue.push(e);
      wake?.();
    });
    stream.onAbort(() => {
      unsub();
      wake?.();
    });
    await stream.writeSSE({ event: "ready", data: "{}" });
    while (!stream.aborted) {
      while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 15000); // heartbeat
      });
      wake = null;
      if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
    }
    unsub();
  });
});

// ---------- tags ----------

const tagBody = (b: { name?: string; color?: string; model?: unknown }) => ({
  name: b.name?.trim().slice(0, 40) || undefined,
  color: b.color && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : undefined,
  // undefined = leave as is; "" / null = no model
  model: b.model === undefined ? undefined : typeof b.model === "string" ? b.model.trim() || null : null,
});

app.get("/api/projects/:id/tags", (c) => c.json(db.getProject(c.req.param("id"))?.tags ?? []));

app.post("/api/projects/:id/tags", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Proyecto no encontrado" }, 404);
  const { name, color, model } = tagBody(await c.req.json());
  if (!name) return c.json({ error: "Falta el nombre de la etiqueta" }, 400);
  if (project.tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) return c.json({ error: `Ya existe la etiqueta "${name}"` }, 400);
  const tag = db.ensureTag(project.id, name, color ?? TAG_COLORS[project.tags.length % TAG_COLORS.length], model ?? null);
  emitTags(project.id, db.getProject(project.id)!.tags);
  return c.json(tag);
});

app.patch("/api/projects/:id/tags/:tagId", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Proyecto no encontrado" }, 404);
  const patch = tagBody(await c.req.json());
  const id = c.req.param("tagId");
  if (patch.name && project.tags.some((t) => t.id !== id && t.name.toLowerCase() === patch.name!.toLowerCase())) {
    return c.json({ error: `Ya existe la etiqueta "${patch.name}"` }, 400);
  }
  const tags = db.setProjectTags(project.id, project.tags.map((t) => (t.id === id ? { ...t, name: patch.name ?? t.name, color: patch.color ?? t.color, model: patch.model === undefined ? (t.model ?? null) : patch.model } : t)));
  emitTags(project.id, tags);
  return c.json(tags.find((t) => t.id === id) ?? null);
});

/** Delete a tag from the project and take it off every card. */
app.delete("/api/projects/:id/tags/:tagId", (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Proyecto no encontrado" }, 404);
  const id = c.req.param("tagId");
  for (const card of db.listCards(project.id).filter((k) => k.tags.includes(id))) {
    emitCard(db.updateCard(card.id, { tags: card.tags.filter((t) => t !== id) }));
  }
  emitTags(project.id, db.setProjectTags(project.id, project.tags.filter((t) => t.id !== id)));
  return c.json({ ok: true });
});

// ---------- cards ----------

app.post("/api/cards", async (c) => {
  const body = await c.req.json<{ project_id: string; title: string; spec?: string; column?: string }>();
  if (!db.getProject(body.project_id)) return c.json({ error: "Proyecto no encontrado" }, 404);
  if (!body.title?.trim()) return c.json({ error: "Falta el título" }, 400);
  const column = isColumn(body.column) && (body.column === "backlog" || body.column === "plan") ? body.column : "backlog";
  const card = db.createCard({ project_id: body.project_id, title: body.title.trim(), spec: body.spec ?? "", column });
  emitCard(card);
  return c.json(card);
});

/** Copy a card (title, spec, checkpoints and tags) into another project's backlog. */
app.post("/api/cards/:id/copy", async (c) => {
  const source = db.getCard(c.req.param("id"));
  if (!source) return c.json({ error: "Tarjeta no encontrada" }, 404);
  const { project_id } = await c.req.json<{ project_id: string }>();
  if (!db.getProject(project_id)) return c.json({ error: "Proyecto no encontrado" }, 404);
  let card = db.createCard({ project_id, title: source.title, spec: source.spec, column: "backlog" });
  for (const cp of db.listCheckpoints(source.id)) db.addCheckpoint(card.id, cp.text, cp.source);
  db.copyAttachments(source.id, card.id);
  // Tags belong to a project: reuse the target's tag with the same name, or create it.
  const sourceTags = db.getProject(source.project_id)?.tags ?? [];
  const tags = source.tags.map((id) => sourceTags.find((t) => t.id === id)).filter((t) => !!t);
  if (tags.length) {
    card = db.updateCard(card.id, { tags: tags.map((t) => db.ensureTag(project_id, t.name, t.color, t.model ?? null).id) });
    emitTags(project_id, db.getProject(project_id)!.tags);
  }
  const from = db.getProject(source.project_id)!;
  const to = db.getProject(project_id)!;
  emitMessage(source.project_id, db.addMessage(source.id, "system", `📋 Copiada al proyecto ${basename(to.name)} (Backlog)`));
  emitMessage(project_id, db.addMessage(card.id, "system", `📋 Copia de "${source.title}" del proyecto ${basename(from.name)}`));
  emitCard(card);
  emitCheckpoints(card.project_id, card.id);
  return c.json(card);
});

app.patch("/api/cards/:id", async (c) => {
  const body = await c.req.json<{ title?: string; spec?: string; plan?: string; model?: string | null; tags?: string[] }>();
  const before = db.getCard(c.req.param("id"));
  if (!before) return c.json({ error: "Tarjeta no encontrada" }, 404);
  const known = new Set(db.getProject(before.project_id)?.tags.map((t) => t.id));
  const card = db.updateCard(before.id, {
    title: body.title?.trim() || undefined,
    spec: body.spec,
    plan: body.plan,
    model: body.model === undefined ? undefined : body.model || null,
    tags: Array.isArray(body.tags) ? [...new Set(body.tags)].filter((id) => known.has(id)) : undefined,
  });
  emitCard(card);
  return c.json(card);
});

app.delete("/api/cards/:id", async (c) => {
  const card = db.getCard(c.req.param("id"));
  if (!card) return c.json({ ok: true });
  await wf.removeCard(card.id);
  emitCardDeleted(card.project_id, card.id);
  return c.json({ ok: true });
});

app.post("/api/cards/:id/move", async (c) => {
  const { column, index } = await c.req.json<{ column: string; index?: number }>();
  if (!isColumn(column)) return c.json({ error: "Columna inválida" }, 400);
  return c.json(wf.moveCard(c.req.param("id"), column, index ?? Number.MAX_SAFE_INTEGER));
});

// ---------- checkpoints ----------

app.get("/api/cards/:id/checkpoints", (c) => c.json(db.listCheckpoints(c.req.param("id"))));

app.post("/api/cards/:id/checkpoints", async (c) => {
  const card = db.getCard(c.req.param("id"));
  if (!card) return c.json({ error: "Tarjeta no encontrada" }, 404);
  const { text } = await c.req.json<{ text: string }>();
  if (!text?.trim()) return c.json({ error: "Texto vacío" }, 400);
  const cp = db.addCheckpoint(card.id, text.trim(), "user");
  emitCheckpoints(card.project_id, card.id);
  return c.json(cp);
});

app.patch("/api/checkpoints/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ text?: string; done?: boolean; index?: number }>();
  const before = db.getCheckpoint(id);
  if (!before) return c.json({ error: "No existe" }, 404);
  const cp = db.updateCheckpoint(id, { text: body.text?.trim() || undefined, done: body.done });
  if (typeof body.index === "number") db.moveCheckpoint(id, body.index);
  const card = db.getCard(before.card_id)!;
  emitCheckpoints(card.project_id, card.id);
  return c.json(cp);
});

app.delete("/api/checkpoints/:id", (c) => {
  const cp = db.getCheckpoint(Number(c.req.param("id")));
  if (cp) {
    db.deleteCheckpoint(cp.id);
    const card = db.getCard(cp.card_id)!;
    emitCheckpoints(card.project_id, card.id);
  }
  return c.json({ ok: true });
});

// ---------- images on a card ----------

app.get("/api/cards/:id/attachments", (c) => c.json(db.listAttachments(c.req.param("id"))));

/** Body: { name, data: base64 or data URL, mime?, annotations?, annotated? } */
app.post("/api/cards/:id/attachments", async (c) => {
  const card = db.getCard(c.req.param("id"));
  if (!card) return c.json({ error: "Tarjeta no encontrada" }, 404);
  const body = await c.req.json<{ name?: string; data?: string; mime?: string; annotations?: unknown; annotated?: string }>();
  const img = parseImage(body.data, body.mime);
  const annotated = body.annotated ? parseImage(body.annotated, img.mime).data : null;
  const name = body.name?.trim().slice(0, 120) || "imagen";
  const att = db.addAttachment(card.id, { name, ...img, annotated, annotations: cleanAnnotations(body.annotations) });
  emitAttachments(card.project_id, card.id);
  return c.json(att);
});

/** :id is the local id, or the uid (same on every computer). */
app.get("/api/attachments/:id/image", (c) => {
  const key = c.req.param("id");
  const att = /^\d+$/.test(key) ? db.getAttachment(Number(key)) : db.getAttachmentByUid(key);
  const annotated = c.req.query("annotated") === "1";
  const data = att && db.attachmentData(att.id, annotated);
  if (!att || !data) return c.json({ error: "Imagen no encontrada" }, 404);
  // The original never changes; the drawn copy is redone whenever the boxes change.
  const cache = annotated ? "no-store" : "private, max-age=31536000, immutable";
  return c.body(Buffer.from(data, "base64"), 200, { "content-type": att.mime, "cache-control": cache });
});

/** Body: { annotations?, annotated?: base64 | null (copy with the boxes drawn), name? } */
app.patch("/api/attachments/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const before = db.getAttachment(id);
  if (!before) return c.json({ error: "Imagen no encontrada" }, 404);
  const body = await c.req.json<{ annotations?: unknown; annotated?: string | null; name?: string }>();
  const att = db.updateAttachment(id, {
    annotations: body.annotations === undefined ? undefined : cleanAnnotations(body.annotations),
    annotated: body.annotated === undefined ? undefined : body.annotated ? parseImage(body.annotated, before.mime).data : null,
    name: body.name?.trim().slice(0, 120) || undefined,
  });
  const card = db.getCard(before.card_id);
  if (card) emitAttachments(card.project_id, card.id);
  return c.json(att);
});

app.delete("/api/attachments/:id", (c) => {
  const att = db.getAttachment(Number(c.req.param("id")));
  if (att) {
    db.deleteAttachment(att.id);
    const card = db.getCard(att.card_id);
    if (card) emitAttachments(card.project_id, card.id);
  }
  return c.json({ ok: true });
});

// ---------- "Ver esta rama" ----------

app.post("/api/cards/:id/preview", async (c) => {
  const card = db.getCard(c.req.param("id"));
  if (!card) return c.json({ error: "Tarjeta no encontrada" }, 404);
  const project = db.getProject(card.project_id);
  // Worked on by another computer: bring its pushed branch here first.
  if (project?.repo_path && card.branch && (!card.worktree || (card.machine && card.machine !== MACHINE))) {
    const f = await remote.fetchCardBranch(project.repo_path, card.branch);
    if (!f.ok) return c.json({ error: f.message }, 400);
  }
  return c.json(startPreview(card));
});

app.post("/api/projects/:id/preview/stop", (c) => c.json(stopPreview(c.req.param("id"))));

app.get("/api/cards/:id/messages", (c) => c.json(db.listMessages(c.req.param("id"))));
app.get("/api/cards/:id/questions", (c) => c.json(db.listQuestions(c.req.param("id"))));

app.post("/api/cards/:id/message", async (c) => {
  const { text, attachments } = await c.req.json<{ text: string; attachments?: number[] }>();
  const ids = (Array.isArray(attachments) ? attachments : []).map(Number).filter((id) => db.getAttachment(id)?.card_id === c.req.param("id"));
  if (!text?.trim() && !ids.length) return c.json({ error: "Mensaje vacío" }, 400);
  wf.sendMessage(c.req.param("id"), text?.trim() ?? "", ids);
  return c.json({ ok: true });
});

/** ↶ on one of your requests: what it would throw away (GET) and doing it (POST). */
app.get("/api/cards/:id/messages/:mid/rewind", (c) => c.json(wf.rewindPreview(c.req.param("id"), Number(c.req.param("mid")))));
app.post("/api/cards/:id/messages/:mid/rewind", async (c) => c.json(await wf.rewindTo(c.req.param("id"), Number(c.req.param("mid")))));

app.post("/api/cards/:id/answers", async (c) => {
  const { answers } = await c.req.json<{ answers: Record<string, string> }>();
  wf.answerQuestions(c.req.param("id"), answers ?? {});
  return c.json({ ok: true });
});

app.post("/api/cards/:id/stop", (c) => {
  wf.stop(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/cards/:id/retry", (c) => {
  wf.retry(c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/cards/:id/diff", async (c) => {
  const card = db.getCard(c.req.param("id"));
  const project = card && db.getProject(card.project_id);
  if (!card || !project?.repo_path) return c.json({ diff: "", files: [] });
  if (!card.worktree || !existsSync(card.worktree)) {
    // Card running on another computer: show what it has pushed so far.
    if (!card.branch) return c.json({ diff: "", files: [] });
    await remote.fetchCardBranch(project.repo_path, card.branch);
    return c.json(git.diffBranch(project.repo_path, project.base_branch, card.branch));
  }
  return c.json({
    diff: git.diffVsBase(card.worktree, project.base_branch),
    files: git.changedFiles(card.worktree, project.base_branch),
  });
});

// ---------- static UI (production) ----------

app.get("/api/build", (c) => c.json(buildInfo()));

if (process.env.NODE_ENV === "production") {
  // The folder changes when the UI is rebuilt after a branch switch (selfupdate.ts).
  const statics = new Map<string, ReturnType<typeof serveStatic>[]>();
  const handlers = () => {
    const dir = distDir();
    if (!statics.has(dir)) statics.set(dir, [serveStatic({ root: `./${dir}` }), serveStatic({ path: `./${dir}/index.html` })]);
    return statics.get(dir)!;
  };
  app.use("/*", (c, next) => handlers()[0](c, next));
  app.get("*", (c, next) => handlers()[1](c, next));
}

wf.recoverAfterRestart();
sweepAll(); // claims/notes left over from cards that are no longer in Doing
// Projects added before remotes were tracked: remember their remote (to find them on other computers).
for (const p of db.listProjects()) {
  if (p.repo_path && !p.remote_url) {
    const url = safe(() => git.remoteUrlSync(p.repo_path));
    if (url) db.updateProject(p.id, { remote_url: url });
  }
}
db.registerMachine(MACHINE);
startSync();
autoshare.startAutoShare();
startSelfUpdate();
startAutoPull();

const port = Number(process.env.PORT ?? 4317);
const hostname = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Trellai → http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`);
  if (process.env.TRELLAI_FAKE_AGENT) console.log("(modo agente simulado)");
  else claudeModels().catch(() => {}); // exact versions for the model pickers
});
