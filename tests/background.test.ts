/**
 * Board background: the PATCH settings, and generating the image with a simulated Codex.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BgStatus, Project } from "../shared/types";

const PORT = 4900 + Math.floor(Math.random() * 500);
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dir: string;
let repo: string;
let projectId: string;

async function req<T = any>(path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<{ status: number; json: T }> {
  const r = await fetch(URL + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json()) as T };
}
const project = async () => (await req<Project[]>("/api/projects")).json.find((p) => p.id === projectId)!;

async function waitIdle(ms = 8000): Promise<BgStatus> {
  const t0 = Date.now();
  for (;;) {
    const s = (await req<BgStatus>(`/api/projects/${projectId}/background/status`)).json;
    if (!s.running) return s;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "trellai-bg-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  execSync("git init -q -b main && git config user.email t@t && git config user.name t", { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# Un juego de barcos\n");
  execSync("git add -A && git commit -qm init", { cwd: repo });

  server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      TRELLAI_DB: join(dir, "t.db"),
      TRELLAI_FAKE_AGENT: "1",
      TRELLAI_CODEX_BIN: resolve("tests/fixtures/fake-codex.mjs"),
      CODEX_HOME: join(dir, "codex-home"),
    },
    stdio: "pipe",
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
  projectId = (await req("/api/projects", { repo_path: repo })).json.id;
}, 30000);

afterAll(() => {
  server?.kill();
});

describe("background settings (PATCH)", () => {
  it("starts with no background", async () => {
    const p = await project();
    expect(p).toMatchObject({ bg_mode: "none", bg_color: null, bg_image: null });
  });

  it("saves mode and color, and validates them", async () => {
    const ok = await req<Project>(`/api/projects/${projectId}`, { bg_mode: "color", bg_color: "#2563eb" }, "PATCH");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ bg_mode: "color", bg_color: "#2563eb" });
    expect((await req(`/api/projects/${projectId}`, { bg_mode: "video" }, "PATCH")).status).toBe(400);
    expect((await req(`/api/projects/${projectId}`, { bg_color: "blue" }, "PATCH")).status).toBe(400);
    // bg_image is only set by the generator
    const p = (await req<Project>(`/api/projects/${projectId}`, { bg_image: "123" }, "PATCH")).json;
    expect(p.bg_image).toBeNull();
    expect((await req(`/api/projects/${projectId}/background`)).status).toBe(404);
  });
});

describe("background generation (simulated Codex)", () => {
  it("runs Codex in the repo, saves the image and serves it", async () => {
    const start = await req<BgStatus>(`/api/projects/${projectId}/background/generate`, {});
    expect(start.status).toBe(200);
    expect(start.json.running).toBe(true);
    const end = await waitIdle();
    expect(end.error).toBeNull();
    expect(existsSync(join(repo, ".trellai", "background.png"))).toBe(true);
    const p = await project();
    expect(p.bg_mode).toBe("image");
    expect(p.bg_image).toMatch(/^\d+$/);
    const img = await fetch(`${URL}/api/projects/${projectId}/background?v=${p.bg_image}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    // the image is not committed: .trellai/ is excluded from git
    expect(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" }).trim()).toBe("");
  });

  it("regenerating gives a new version", async () => {
    const before = (await project()).bg_image;
    await new Promise((r) => setTimeout(r, 20));
    await req(`/api/projects/${projectId}/background/generate`, {});
    expect((await waitIdle()).error).toBeNull();
    expect((await project()).bg_image).not.toBe(before);
  });

  it("reports a clear error when Codex makes no image", async () => {
    rmSync(join(repo, ".trellai", "background.png"));
    writeFileSync(join(repo, "NO_IMAGE"), "");
    await req(`/api/projects/${projectId}/background/generate`, {});
    const end = await waitIdle();
    expect(end.error).toMatch(/Codex no generó la imagen/);
    rmSync(join(repo, "NO_IMAGE"));
  });

  it("can be cancelled", async () => {
    await req(`/api/projects/${projectId}/background/generate`, {});
    const s = (await req<BgStatus>(`/api/projects/${projectId}/background/stop`, {})).json;
    expect(s.running).toBe(false);
    expect(s.error).toBe("Cancelado.");
  });
});
