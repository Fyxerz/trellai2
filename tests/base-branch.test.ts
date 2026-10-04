/**
 * Choosing a project's base branch: the default when adding a repo (never `HEAD`),
 * GET /api/branches for "Nuevo proyecto" and changing it later with PATCH /api/projects/:id.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../shared/types";

const PORT = 4550 + Math.floor(Math.random() * 400);
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;

async function call<T = any>(path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<{ status: number; json: T }> {
  const r = await fetch(URL + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json()) as T };
}

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf8" }).trim();

/** A repo with one commit on `branch` and, if given, an origin with extra branches. */
function repo(name: string, branch = "main") {
  const path = join(dir, name);
  mkdirSync(path);
  sh(`git init -q -b ${branch} && git config user.email t@t && git config user.name t`, path);
  writeFileSync(join(path, "README.md"), "# hola\n");
  sh("git add -A && git commit -qm init", path);
  return path;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "trellai-base-"));
  server = spawn("npx", ["tsx", "server/index.ts"], {
    env: { ...process.env, PORT: String(PORT), TRELLAI_DB: join(dir, "t.db"), TRELLAI_FAKE_AGENT: "1", TRELLAI_GUESS_REPOS: "0" },
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
  if (process.platform === "win32" && server?.pid) execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
  else server?.kill();
});

describe("base branch", () => {
  it("a repo with no branch checked out (detached HEAD) never gets HEAD as base", async () => {
    const path = repo("detached");
    sh("git checkout -q --detach HEAD", path);
    const { status, json } = await call<Project>("/api/projects", { repo_path: path });
    expect(status).toBe(200);
    expect(json.base_branch).toBe("main");
  });

  it("prefers the remote's default branch and lists local + remote branches", async () => {
    const src = repo("src", "trunk");
    sh("git branch solo-remota", src);
    const origin = join(dir, "origin.git");
    sh(`git clone -q --bare "${src}" "${origin}"`, dir);
    const path = join(dir, "clon");
    sh(`git clone -q "${origin}" "${path}"`, dir);
    sh("git checkout -q -b otra", path);
    const { json } = await call(`/api/branches?path=${encodeURIComponent(path)}`);
    expect(json.suggested).toBe("trunk");
    expect(json.local).toEqual(expect.arrayContaining(["trunk", "otra"]));
    expect(json.remote).toContain("solo-remota");
    expect(json.remote).not.toContain("HEAD");

    const p = (await call<Project>("/api/projects", { repo_path: path })).json;
    expect(p.base_branch).toBe("trunk");

    // a branch that only exists on the remote: the local one is created, tracking it
    const r = await call<Project>(`/api/projects/${p.id}`, { base_branch: "solo-remota" }, "PATCH");
    expect(r.status).toBe(200);
    expect(r.json.base_branch).toBe("solo-remota");
    expect(sh("git rev-parse --abbrev-ref solo-remota@{upstream}", path)).toBe("origin/solo-remota");
    expect((await call(`/api/projects/${p.id}/branches`)).json.baseMissing).toBe(false);
  });

  it("refuses HEAD or a branch that doesn't exist, on add and on PATCH", async () => {
    const path = repo("plain");
    expect((await call("/api/projects", { repo_path: path, base_branch: "HEAD" })).status).toBe(400);
    expect((await call("/api/projects", { repo_path: path, base_branch: "nope" })).status).toBe(400);
    const p = (await call<Project>("/api/projects", { repo_path: path })).json;
    const bad = await call(`/api/projects/${p.id}`, { base_branch: "no-existe" }, "PATCH");
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/no existe/);
    expect((await call(`/api/projects/${p.id}`, { base_branch: "HEAD" }, "PATCH")).status).toBe(400);
    const after = (await call<Project[]>("/api/projects")).json.find((x) => x.id === p.id)!;
    expect(after.base_branch).toBe("main");
  });

  it("warns in the branch menu when the base is gone", async () => {
    const path = repo("gone");
    sh("git branch vieja", path);
    const p = (await call<Project>("/api/projects", { repo_path: path, base_branch: "vieja" })).json;
    sh("git branch -D vieja", path);
    expect((await call(`/api/projects/${p.id}/branches`)).json.baseMissing).toBe(true);
  });
});
