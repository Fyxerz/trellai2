/**
 * "Nuevo proyecto → Clonar de GitHub": POST /api/projects/clone against a local bare "GitHub",
 * and GET /api/github/repos without the `gh` CLI.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CloneJob, GitHubRepos, Project } from "../shared/types";
import { parseRepos, repoDirName } from "../server/github";
import { parseCloneProgress } from "../server/remote";

const PORT = 4950 + Math.floor(Math.random() * 400);
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let origin: string;

async function call<T = any>(path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const r = await fetch(URL + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json()) as T };
}

/** POST /api/projects/clone and, when it starts a background clone, poll the job until it ends. */
async function clone(body: unknown): Promise<{ status: number; json: any; job?: CloneJob; stages: string[] }> {
  const r = await call("/api/projects/clone", body);
  if (r.status !== 200 || !r.json.jobId) return { ...r, stages: [] };
  const stages: string[] = [];
  for (let i = 0; i < 300; i++) {
    const { json: job } = await call<CloneJob>(`/api/clone-jobs/${r.json.jobId}`);
    if (stages.at(-1) !== job.stage) stages.push(job.stage);
    if (job.stage === "done" || job.stage === "error") return { ...r, job, stages };
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("clone job never finished");
}

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf8" }).trim();
const same = (a: string, b: string) => resolve(realpathSync(a)).toLowerCase() === resolve(realpathSync(b)).toLowerCase();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "trellai-clone-"));
  const src = join(dir, "src");
  mkdirSync(src);
  sh("git init -q -b main && git config user.email t@t && git config user.name t", src);
  writeFileSync(join(src, "README.md"), "# hola\n");
  sh("git add -A && git commit -qm init", src);
  origin = join(dir, "hola.git");
  sh(`git clone -q --bare "${src}" "${origin}"`, dir);
  for (const other of ["adios", "tercero"]) sh(`git clone -q --bare "${src}" "${join(dir, other + ".git")}"`, dir);

  server = spawn("npx", ["tsx", "server/index.ts"], {
    env: { ...process.env, PORT: String(PORT), TRELLAI_DB: join(dir, "t.db"), TRELLAI_FAKE_AGENT: "1", TRELLAI_GH: join(dir, "no-such-gh") },
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  server.stderr?.on("data", (d) => process.stderr.write(d));
  for (let i = 0; i < 150; i++) {
    try {
      await fetch(URL + "/api/projects");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}, 30000);

afterAll(() => {
  // on Windows the server runs under a shell: kill the whole tree
  if (process.platform === "win32" && server?.pid) execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
  else server?.kill();
});

describe("clone from GitHub", () => {
  it("clones a URL into the chosen folder and creates the project", async () => {
    const dest = join(dir, "clones", "hola");
    const { status, json, job, stages } = await clone({ url: origin, dest });
    expect(status).toBe(200);
    expect(json.jobId).toBeTruthy();
    expect(stages.at(-1)).toBe("done");
    const p = job!.project!;
    expect(p.name).toBe("hola");
    expect(p.base_branch).toBe("main");
    expect(same(p.repo_path, dest)).toBe(true);
    expect(existsSync(join(dest, "README.md"))).toBe(true);
    expect(p.remote_url).toBe(origin);
  });

  it("reuses a folder that already holds the same repo", async () => {
    const dest = join(dir, "clones", "hola");
    const before = (await call<Project[]>("/api/projects")).json.length;
    // answered at once with the project, no background job
    const { status, json: p } = await call<Project>("/api/projects/clone", { url: origin, dest });
    expect(status).toBe(200);
    expect(same(p.repo_path, dest)).toBe(true);
    expect((await call<Project[]>("/api/projects")).json.length).toBe(before);
  });

  it("refuses a folder that holds something else", async () => {
    const dest = join(dir, "src");
    const { status, json } = await call("/api/projects/clone", { url: origin, dest });
    expect(status).toBe(400);
    expect(json.error).toMatch(/Ya existe/);
  });

  it("clones into an existing empty folder", async () => {
    const dest = join(dir, "empty");
    mkdirSync(dest);
    const { status, job } = await clone({ url: origin, dest, name: "Otro nombre" });
    expect(status).toBe(200);
    const p = job!.project!;
    expect(p.name).toBe("Otro nombre");
    expect(existsSync(join(dest, "README.md"))).toBe(true);
  });

  it("explains failures", async () => {
    expect((await call("/api/projects/clone", { url: "" })).json.error).toMatch(/URL/);
    // git itself failing shows up in the job, not in the POST
    const bad = await clone({ url: join(dir, "nope.git"), dest: join(dir, "clones", "nope") });
    expect(bad.status).toBe(200);
    expect(bad.job?.stage).toBe("error");
    expect(bad.job?.message).toMatch(/No pude clonar/);
    expect((await call("/api/clone-jobs/nope")).status).toBe(404);
  });

  it("reads git's progress lines", () => {
    expect(parseCloneProgress("Receiving objects:  50% (5/10), 1.2 MiB | 3 MiB/s")).toEqual({ phase: "Recibiendo objetos", percent: 45 });
    expect(parseCloneProgress("Resolving deltas: 100% (3/3), done.")).toEqual({ phase: "Resolviendo deltas", percent: 100 });
    expect(parseCloneProgress("Cloning into 'x'...")).toBeNull();
  });
});

describe("default clone folder", () => {
  it("is where most of your projects live, and clones go there without a dest", async () => {
    // projects so far: clones/hola and empty → one more in clones/ makes it the favourite
    expect((await clone({ url: join(dir, "adios.git"), dest: join(dir, "clones", "adios") })).job?.stage).toBe("done");
    const { json } = await call<{ dir: string; sep: string }>("/api/clone-dir");
    expect(same(json.dir, join(dir, "clones"))).toBe(true);
    const { job } = await clone({ url: join(dir, "tercero.git") });
    const p = job!.project!;
    expect(same(p.repo_path, join(dir, "clones", "tercero"))).toBe(true);
  });
});

describe("GitHub repos list", () => {
  it("says gh is missing instead of failing", async () => {
    const { status, json } = await call<GitHubRepos>("/api/github/repos");
    expect(status).toBe(200);
    expect(json).toMatchObject({ available: false, loggedIn: false, repos: [] });
  });

  it("parses gh output, honouring git_protocol", () => {
    const out = [
      JSON.stringify({ full_name: "me/old", description: null, private: false, updated_at: "2026-01-01T00:00:00Z", ssh_url: "git@github.com:me/old.git", clone_url: "https://github.com/me/old.git" }),
      JSON.stringify({ full_name: "org/new", description: "Nuevo", private: true, updated_at: "2026-09-01T00:00:00Z", ssh_url: "git@github.com:org/new.git", clone_url: "https://github.com/org/new.git" }),
      JSON.stringify({ full_name: "me/old", updated_at: "2026-01-01T00:00:00Z" }),
      "not json",
      "",
    ].join("\n");
    const https = parseRepos(out, "https");
    expect(https.map((r) => r.name)).toEqual(["org/new", "me/old"]);
    expect(https[0]).toEqual({ name: "org/new", description: "Nuevo", private: true, updated_at: "2026-09-01T00:00:00Z", clone_url: "https://github.com/org/new.git" });
    expect(parseRepos(out, "ssh")[1].clone_url).toBe("git@github.com:me/old.git");
  });

  it("derives the folder name from the URL", () => {
    expect(repoDirName("https://github.com/me/trellai.git")).toBe("trellai");
    expect(repoDirName("git@github.com:me/trellai.git")).toBe("trellai");
    expect(repoDirName("https://github.com/me/trellai/")).toBe("trellai");
  });
});
