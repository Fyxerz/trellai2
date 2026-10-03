/**
 * End-to-end flow against a real git repo, with the scripted fake agent.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Card, Question } from "../shared/types";

const PORT = 4400 + Math.floor(Math.random() * 500);
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let repo: string;
let projectId: string;

async function api<T = any>(path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
  const r = await fetch(URL + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error);
  return json as T;
}

async function card(id: string): Promise<Card> {
  const cards = await api<Card[]>(`/api/projects/${projectId}/cards`);
  return cards.find((c) => c.id === id)!;
}

async function waitFor(id: string, pred: (c: Card) => boolean, ms = 8000): Promise<Card> {
  const t0 = Date.now();
  let c = await card(id);
  while (!pred(c)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${JSON.stringify({ column: c.column, status: c.status, text: c.status_text })}`);
    await new Promise((r) => setTimeout(r, 50));
    c = await card(id);
  }
  return c;
}

const sh = (cmd: string, cwd = repo) => execSync(cmd, { cwd, encoding: "utf8" }).trim();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "trellai-e2e-"));
  repo = join(dir, "repo");
  sh(`mkdir -p ${repo} && cd ${repo} && git init -q -b main && git config user.email t@t && git config user.name t`, dir);
  writeFileSync(join(repo, "SHARED.md"), "# Shared\n");
  sh("git add -A && git commit -qm init");

  server = spawn("npx", ["tsx", "server/index.ts"], {
    env: { ...process.env, PORT: String(PORT), TRELLAI_DB: join(dir, "t.db"), TRELLAI_FAKE_AGENT: "1", TRELLAI_FAKE_DELAY: "60" },
    stdio: "pipe",
  });
  server.stderr?.on("data", (d) => process.stderr.write(d));
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(URL + "/api/projects");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  projectId = (await api("/api/projects", { repo_path: repo })).id;
}, 20000);

afterAll(() => {
  server?.kill();
});

describe("board flow", () => {
  it("clear spec: preparation → doing → review automatically", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Login con email", spec: "Añadir login", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "preparation" });
    const done = await waitFor(c.id, (x) => x.column === "review" && x.status === "idle");
    expect(done.plan).toContain("features/");
    expect(done.branch).toMatch(/^trellai\//);
    expect(existsSync(join(done.worktree!, "features", "login-con-email.md"))).toBe(true);
    const { diff } = await api(`/api/cards/${c.id}/diff`);
    expect(diff).toContain("Añadir login");
  });

  it("ambiguous spec: asks, waits, resumes with the answer", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Exportar", spec: "¿CSV o Excel?", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "preparation" });
    await waitFor(c.id, (x) => x.status === "waiting");
    const qs = await api<Question[]>(`/api/cards/${c.id}/questions`);
    expect(qs).toHaveLength(1);
    await api(`/api/cards/${c.id}/answers`, { answers: { [qs[0].id]: "Simple" } });
    await waitFor(c.id, (x) => x.column === "review");
  });

  it("parallel agents, notes, merge, and conflict resolution", async () => {
    const a = await api<Card>("/api/cards", { project_id: projectId, title: "Feature A", spec: "toca shared", column: "plan" });
    const b = await api<Card>("/api/cards", { project_id: projectId, title: "Feature B", spec: "toca shared", column: "plan" });
    await api(`/api/cards/${a.id}/move`, { column: "doing" });
    await api(`/api/cards/${b.id}/move`, { column: "doing" });
    // both running at the same time
    await waitFor(a.id, (x) => x.status === "running" || x.column === "review");
    await waitFor(a.id, (x) => x.column === "review");
    await waitFor(b.id, (x) => x.column === "review");

    const notes = await api<any[]>(`/api/projects/${projectId}/notes`);
    expect(notes.some((n) => n.content.includes("SHARED.md"))).toBe(true);

    await api(`/api/cards/${a.id}/move`, { column: "merged" });
    await waitFor(a.id, (x) => x.column === "merged" && x.status_text.startsWith("Merge"));

    // B now conflicts with main → goes back to doing, agent rebases, back to review
    await api(`/api/cards/${b.id}/move`, { column: "merged" });
    await waitFor(b.id, (x) => x.column === "review" || x.status_text.startsWith("Merge"), 10000);
    const bNow = await card(b.id);
    if (bNow.column === "review") {
      await api(`/api/cards/${b.id}/move`, { column: "merged" });
    }
    const merged = await waitFor(b.id, (x) => x.column === "merged" && x.status_text.startsWith("Merge"));
    expect(merged.worktree).toBeNull();
    const bMsgs = await api<any[]>(`/api/cards/${b.id}/messages`);
    expect(bMsgs.some((m) => m.content.includes("Conflicto"))).toBe(true);

    const shared = readFileSync(join(repo, "SHARED.md"), "utf8");
    expect(shared).toContain("Feature A");
    expect(shared).toContain("Feature B");
    expect(sh("git branch --list 'trellai/feature-*'")).toBe("");
  }, 30000);

  it("review feedback sends the card back to doing", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Ajuste", spec: "x", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "doing" });
    await waitFor(c.id, (x) => x.column === "review");
    await api(`/api/cards/${c.id}/message`, { text: "Cambia el título" });
    await waitFor(c.id, (x) => x.column === "doing");
    await waitFor(c.id, (x) => x.column === "review");
    const msgs = await api<any[]>(`/api/cards/${c.id}/messages`);
    expect(msgs.some((m) => m.role === "user" && m.content === "Cambia el título")).toBe(true);
  });
});
