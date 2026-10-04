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
  it("by default a prepared card waits in preparation until moved to doing", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Perfil", spec: "Página de perfil", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "preparation" });
    const ready = await waitFor(c.id, (x) => x.status === "waiting");
    expect(ready.column).toBe("preparation");
    expect((await api<any[]>(`/api/cards/${c.id}/checkpoints`)).length).toBeGreaterThan(0);
    await api(`/api/cards/${c.id}/move`, { column: "doing" });
    await waitFor(c.id, (x) => x.column === "review" && x.status === "idle");
    // the rest of the flow tests run with the automatic move on
    const p = await api<any>(`/api/projects/${projectId}`, { auto_doing: true }, "PATCH");
    expect(p.auto_doing).toBe(true);
  });

  it("clear spec: preparation → doing → review automatically", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Login con email", spec: "Añadir login", column: "plan" });
    await api(`/api/cards/${c.id}/checkpoints`, { text: "Pantalla de login" });
    await api(`/api/cards/${c.id}/move`, { column: "preparation" });
    const done = await waitFor(c.id, (x) => x.column === "review" && x.status === "idle");
    const cps = await api<any[]>(`/api/cards/${c.id}/checkpoints`);
    expect(cps.map((x) => x.source)).toEqual(["user", "agent", "agent"]);
    expect(cps.every((x) => x.done)).toBe(true);
    expect(done.checkpoints_total).toBe(3);
    expect(done.checkpoints_done).toBe(3);
    // each checked checkpoint with changes becomes its own commit
    const log = sh(`git log --format=%s main..${done.branch}`, done.worktree!);
    expect(log.split("\n")).toContain("Pantalla de login");
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
    await waitFor(a.id, (x) => x.column === "merged" && x.status_text.startsWith("Merge "));

    // B now conflicts with main → goes back to doing, agent rebases, back to review
    await api(`/api/cards/${b.id}/move`, { column: "merged" });
    await waitFor(b.id, (x) => x.column === "review" || x.status_text.startsWith("Merge "), 10000);
    const bNow = await card(b.id);
    if (bNow.column === "review") {
      await api(`/api/cards/${b.id}/move`, { column: "merged" });
    }
    const merged = await waitFor(b.id, (x) => x.column === "merged" && x.status_text.startsWith("Merge "));
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

  it("↶ rewinds the branch to before a requested change", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Retroceso", spec: "x", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "doing" });
    const first = await waitFor(c.id, (x) => x.column === "review" && x.status === "idle");
    const before = sh("git rev-parse HEAD", first.worktree!);

    await api(`/api/cards/${c.id}/message`, { text: "Añade un botón" });
    await waitFor(c.id, (x) => x.column === "doing");
    const after = await waitFor(c.id, (x) => x.column === "review" && x.status === "idle");
    expect(sh("git rev-parse HEAD", after.worktree!)).not.toBe(before);
    expect(existsSync(join(after.worktree!, "features", "anade-un-boton.md"))).toBe(true);

    const request = (await api<any[]>(`/api/cards/${c.id}/messages`)).find((m) => m.role === "user" && m.content === "Añade un botón");
    expect(request).toMatchObject({ head_sha: before, column_before: "review", undone: false });
    const preview = await api(`/api/cards/${c.id}/messages/${request.id}/rewind`);
    expect(preview.commits.length).toBeGreaterThan(0);

    writeFileSync(join(after.worktree!, "basura.txt"), "sin commitear\n");
    const r = await api(`/api/cards/${c.id}/messages/${request.id}/rewind`, {});
    expect(r.commits).toBe(preview.commits.length);

    const back = await card(c.id);
    expect(back).toMatchObject({ column: "review", status: "idle", session_id: null });
    expect(sh("git rev-parse HEAD", back.worktree!)).toBe(before);
    expect(sh("git status --porcelain", back.worktree!)).toBe("");
    expect(existsSync(join(back.worktree!, "features", "anade-un-boton.md"))).toBe(false);
    const msgs = await api<any[]>(`/api/cards/${c.id}/messages`);
    expect(msgs.find((m) => m.id === request.id).undone).toBe(true);
    expect(msgs.filter((m) => m.created_at > request.created_at && !m.undone).some((m) => m.content.startsWith("↶ Retrocedido"))).toBe(true);
    await expect(api(`/api/cards/${c.id}/messages/${request.id}/rewind`, {})).rejects.toThrow(/deshecho/);
  });

  it("assistant turns a message into cards", async () => {
    await api(`/api/projects/${projectId}/assistant`, { text: "Ideas:\n- dividir la cuenta\n- cierre de caja en PDF" });
    const t0 = Date.now();
    let r: any;
    do {
      await new Promise((res) => setTimeout(res, 100));
      r = await api(`/api/projects/${projectId}/assistant`);
    } while ((r.running || !r.messages.some((m: any) => m.role === "assistant")) && Date.now() - t0 < 8000);
    const chips = r.messages.filter((m: any) => m.card_id);
    expect(chips).toHaveLength(2);
    const cards = await api<Card[]>(`/api/projects/${projectId}/cards`);
    const created = cards.filter((c) => chips.some((m: any) => m.card_id === c.id));
    expect(created.map((c) => c.title).sort()).toEqual(["Cierre de caja en PDF", "Dividir la cuenta"]);
    expect(created.every((c) => c.column === "backlog" && c.checkpoints_total === 2)).toBe(true);
  });

  it("direct chat changes the repo and commits only its own changes", async () => {
    writeFileSync(join(repo, "MINE.md"), "trabajo sin commitear de Pedro\n");
    await api(`/api/projects/${projectId}/assistant`, { text: "Añade una línea a DIRECT.md", mode: "do" });
    const t0 = Date.now();
    let r: any;
    do {
      await new Promise((res) => setTimeout(res, 100));
      r = await api(`/api/projects/${projectId}/assistant?mode=do`);
    } while ((r.running || !r.messages.some((m: any) => m.content.startsWith("📌"))) && Date.now() - t0 < 8000);
    expect(r.messages.some((m: any) => m.content.startsWith("📌 Commit"))).toBe(true);
    expect(sh("git log -1 --format=%s")).toBe("Añade una línea a DIRECT.md");
    expect(sh("git show --name-only --format= HEAD")).toBe("DIRECT.md");
    expect(sh("git status --porcelain")).toContain("MINE.md"); // Pedro's own work untouched
    // the plan conversation is separate
    const plan = await api<any>(`/api/projects/${projectId}/assistant?mode=plan`);
    expect(plan.messages.some((m: any) => m.content.includes("DIRECT.md"))).toBe(false);
  });

  it("'Ver esta rama' puts the card's branch in the main checkout and back", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Vista previa", spec: "x", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "doing" });
    const done = await waitFor(c.id, (x) => x.column === "review" && x.status === "idle");
    const before = sh("git rev-parse --abbrev-ref HEAD");
    await api(`/api/cards/${c.id}/preview`, {});
    expect(sh("git rev-parse HEAD")).toBe(sh(`git rev-parse ${done.branch}`));
    expect(existsSync(join(repo, "features", "vista-previa.md"))).toBe(true);
    const projects = await api<any[]>("/api/projects");
    expect(projects.find((p) => p.id === projectId).preview_card_id).toBe(c.id);
    // merging while previewing returns the repo to its branch first
    await api(`/api/cards/${c.id}/move`, { column: "merged" });
    await waitFor(c.id, (x) => x.column === "merged" && x.status_text.startsWith("Merge "));
    expect(sh("git rev-parse --abbrev-ref HEAD")).toBe(before);
    expect((await api<any[]>("/api/projects")).find((p) => p.id === projectId).preview_card_id).toBeNull();
  });

  it("lists every branch with its card, the current one and what's merged", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Rama listada", spec: "x", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "doing" });
    const done = await waitFor(c.id, (x) => x.column === "review" && x.status === "idle");
    sh("git branch suelta-vieja main~1");
    const r = await api<any>(`/api/projects/${projectId}/branches`);
    const by = (n: string) => r.branches.find((b: any) => b.name === n);
    expect(r.base).toBe("main");
    expect(r.remote).toBeNull();
    expect(by("main")).toMatchObject({ local: true, current: true });
    expect(by(done.branch!)).toMatchObject({ local: true, current: false, merged: false, card: { id: c.id, title: "Rama listada", column: "review" } });
    expect(by(done.branch!).worktree).toBeTruthy();
    expect(by("suelta-vieja")).toMatchObject({ merged: true, card: null });
    sh("git branch -D suelta-vieja");
  });
});

describe("images on a card", () => {
  // 1×1 transparent PNG
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  it("upload, list, serve, annotate, copy and delete", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Con imagen", spec: "x" });
    await expect(api(`/api/cards/${c.id}/attachments`, { name: "a.bmp", data: "data:image/bmp;base64,AAAA" })).rejects.toThrow(/Formato/);
    const a = await api<any>(`/api/cards/${c.id}/attachments`, { name: "pantalla.png", data: `data:image/png;base64,${PNG}` });
    expect(a).toMatchObject({ card_id: c.id, name: "pantalla.png", mime: "image/png", annotations: [], has_annotated: false });
    expect(a.data).toBeUndefined(); // lists stay light
    expect(await api<any[]>(`/api/cards/${c.id}/attachments`)).toHaveLength(1);

    const img = await fetch(`${URL}/api/attachments/${a.id}/image`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer()).toString("base64")).toBe(PNG);

    const annotations = [{ x: 0.1, y: 0.2, w: 0.5, h: 2, comment: "Este botón más grande" }, { x: 0, y: 0, w: 0, h: 0, comment: "vacía" }];
    const upd = await api<any>(`/api/attachments/${a.id}`, { annotations, annotated: `data:image/png;base64,${PNG}` }, "PATCH");
    expect(upd.annotations).toEqual([{ x: 0.1, y: 0.2, w: 0.5, h: 0.8, comment: "Este botón más grande" }]);
    expect(upd.has_annotated).toBe(true);
    expect((await fetch(`${URL}/api/attachments/${a.id}/image?annotated=1`)).status).toBe(200);

    const copy = await api<Card>(`/api/cards/${c.id}/copy`, { project_id: projectId });
    const copied = await api<any[]>(`/api/cards/${copy.id}/attachments`);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ name: "pantalla.png", has_annotated: true, annotations: upd.annotations });

    await api(`/api/attachments/${a.id}`, undefined, "DELETE");
    expect(await api<any[]>(`/api/cards/${c.id}/attachments`)).toHaveLength(0);
    // deleting the card takes its images with it
    await api(`/api/cards/${copy.id}`, undefined, "DELETE");
    expect((await fetch(`${URL}/api/attachments/${copied[0].id}/image`)).status).toBe(404);
  });

  it("writes the images where the agent can read them", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Imagen al agente", spec: "x", column: "plan" });
    const a = await api<any>(`/api/cards/${c.id}/attachments`, { name: "Mi captura.png", data: `data:image/png;base64,${PNG}` });
    await api(`/api/attachments/${a.id}`, { annotations: [{ x: 0, y: 0, w: 0.5, h: 0.5, comment: "aquí" }], annotated: `data:image/png;base64,${PNG}` }, "PATCH");
    await api(`/api/cards/${c.id}/move`, { column: "preparation" });
    await waitFor(c.id, (x) => x.column === "review");
    const dir = join(repo, ".trellai", "attachments", c.id);
    expect(readFileSync(join(dir, "1-mi-captura.png")).toString("base64")).toBe(PNG);
    expect(existsSync(join(dir, "1-mi-captura.anotada.png"))).toBe(true);
    expect(sh("git status --porcelain")).not.toContain("attachments");
  });

  it("asking for changes with only an image", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Cambio con imagen", spec: "x", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "doing" });
    await waitFor(c.id, (x) => x.column === "review" && x.status === "idle");
    await expect(api(`/api/cards/${c.id}/message`, { text: " " })).rejects.toThrow(/vacío/);
    const a = await api<any>(`/api/cards/${c.id}/attachments`, { name: "fallo.png", data: `data:image/png;base64,${PNG}` });
    await api(`/api/cards/${c.id}/message`, { text: "", attachments: [a.id] });
    await waitFor(c.id, (x) => x.column === "review" && x.status === "idle");
    const msgs = await api<any[]>(`/api/cards/${c.id}/messages`);
    expect(msgs.some((m) => m.role === "user" && m.content === `![fallo.png](/api/attachments/${a.uid}/image)`)).toBe(true);
    expect((await fetch(`${URL}/api/attachments/${a.uid}/image`)).headers.get("content-type")).toBe("image/png");
  });
});
