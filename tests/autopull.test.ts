/**
 * Automatic pull: a teammate pushes to the shared remote and our base branch catches up by
 * itself — but only as a fast-forward, never over uncommitted changes or unpushed commits.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../shared/types";

const PORT = 5850 + Math.floor(Math.random() * 100);
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let origin: string;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(URL + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return (await r.json()) as T;
}

async function until(fn: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
}

function clone(name: string) {
  const path = join(dir, name);
  sh(`git clone -q "${origin}" "${path}"`, dir);
  sh("git config user.email t@t && git config user.name t", path);
  return path;
}

/** The teammate: commits a file and pushes it. */
function push(teammate: string, file: string) {
  writeFileSync(join(teammate, file), file + "\n");
  sh(`git add -A && git commit -qm ${file} && git push -q origin main`, teammate);
  return sh("git rev-parse HEAD", teammate);
}

const head = (repo: string, ref = "main") => sh(`git rev-parse ${ref}`, repo);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "trellai-autopull-"));
  const src = join(dir, "src");
  sh(`git init -q -b main "${src}"`, dir);
  sh("git config user.email t@t && git config user.name t", src);
  writeFileSync(join(src, "README.md"), "# hola\n");
  sh("git add -A && git commit -qm init", src);
  origin = join(dir, "origin.git");
  sh(`git clone -q --bare "${src}" "${origin}"`, dir);

  server = spawn("npx", ["tsx", "server/index.ts"], {
    env: { ...process.env, PORT: String(PORT), TRELLAI_DB: join(dir, "t.db"), TRELLAI_FAKE_AGENT: "1", TRELLAI_GUESS_REPOS: "0", TRELLAI_AUTOPULL_MS: "300" },
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  server.stderr?.on("data", (d) => process.stderr.write(d));
  for (let i = 0; i < 150; i++) {
    try {
      await fetch(URL + "/api/projects");
      break;
    } catch {
      await sleep(100);
    }
  }
}, 30000);

afterAll(() => {
  try {
    // /T can fail on a git child that just finished: the server itself is gone anyway
    if (process.platform === "win32" && server?.pid) execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
    else server?.kill();
  } catch {}
});

describe("automatic pull", { timeout: 30000 }, () => {
  it("our main fast-forwards by itself when a teammate pushes, and the header stops showing ↓", async () => {
    const mine = clone("mine");
    const teammate = clone("teammate");
    const p = await call<Project>("/api/projects", { repo_path: mine });
    const sha = push(teammate, "a.txt");
    expect(await until(() => head(mine) === sha)).toBe(true);
    const st = await call(`/api/projects/${p.id}/git`);
    expect(st.behind).toBe(0);
  });

  it("also when main is not checked out (the ref moves)", async () => {
    const mine = clone("mine2");
    const teammate = clone("teammate2");
    sh("git checkout -q -b otra", mine);
    await call<Project>("/api/projects", { repo_path: mine, base_branch: "main" });
    const sha = push(teammate, "b.txt");
    expect(await until(() => head(mine) === sha)).toBe(true);
    expect(sh("git branch --show-current", mine)).toBe("otra");
  });

  it("does nothing with uncommitted changes, nor with local commits not pushed", async () => {
    const dirty = clone("dirty");
    const ahead = clone("ahead");
    const teammate = clone("teammate3");
    writeFileSync(join(dirty, "README.md"), "# editado\n");
    writeFileSync(join(ahead, "local.txt"), "local\n");
    sh("git add -A && git commit -qm local", ahead);
    const dirtyHead = head(dirty);
    const aheadHead = head(ahead);
    const pd = await call<Project>("/api/projects", { repo_path: dirty });
    const pa = await call<Project>("/api/projects", { repo_path: ahead });
    push(teammate, "c.txt");
    await sleep(2500);
    expect(head(dirty)).toBe(dirtyHead);
    expect(head(ahead)).toBe(aheadHead);
    expect(sh("git status --porcelain", dirty)).toContain("README.md");
    expect((await call(`/api/projects/${pd.id}/git`)).behind).toBeGreaterThan(0);
    expect((await call(`/api/projects/${pa.id}/git`)).behind).toBeGreaterThan(0);
  });

  it("a remote that can't be reached is not an error: it just doesn't pull", async () => {
    const lost = clone("lost");
    sh(`git remote set-url origin "${join(dir, "no-existe.git")}"`, lost);
    const before = head(lost);
    const p = await call<Project>("/api/projects", { repo_path: lost });
    expect(p.id).toBeTruthy();
    await sleep(1500);
    expect(head(lost)).toBe(before);
    const projects = await call<Project[]>("/api/projects");
    expect(projects.some((x) => x.id === p.id)).toBe(true);
  });
});
