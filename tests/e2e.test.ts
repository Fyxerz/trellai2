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

  server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
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

describe("new folder from the folder browser", () => {
  it("creates an empty folder and turns it into a project", async () => {
    const parent = mkdtempSync(join(tmpdir(), "trellai-mkdir-"));
    const { path } = await api<{ path: string }>("/api/fs/mkdir", { parent, name: "mi-app" });
    expect(path).toBe(join(parent, "mi-app"));
    expect(existsSync(path)).toBe(true);
    await expect(api("/api/fs/mkdir", { parent, name: "mi-app" })).rejects.toThrow(/Ya existe/);
    for (const bad of ["", "  ", "a/b", "a\\b", "..", "que?", "fin."]) {
      await expect(api("/api/fs/mkdir", { parent, name: bad })).rejects.toThrow();
    }
    expect(existsSync(join(parent, "a"))).toBe(false);
    const p = await api<any>("/api/projects", { repo_path: path, name: "mi-app", init: true });
    expect(p.name).toBe("mi-app");
    expect(p.base_branch).toBe("main");
    expect(sh("git log --format=%s", path)).toBe("Initial commit");
    expect(await api<Card[]>(`/api/projects/${p.id}/cards`)).toEqual([]);
  });
});

describe("board flow", () => {
  it("by default a prepared card waits in preparation until moved to doing", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Perfil", spec: "Página de perfil", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "preparation" });
    const ready = await waitFor(c.id, (x) => x.status === "ready");
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

  it("medium card: preparation plans parts for parallel subagents", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Informe", spec: "parallel", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "preparation" });
    const done = await waitFor(c.id, (x) => x.column === "review");
    expect(done.plan).toContain("## Reparto en paralelo");
    expect(done.plan).toContain("**Backend**");
    expect(done.parent_id).toBeNull();
  });

  it("big card: split into sub-cards that run at once, mother closes when all are merged", async () => {
    const m = await api<Card>("/api/cards", { project_id: projectId, title: "Tienda", spec: "split en dos", column: "plan" });
    await api(`/api/cards/${m.id}/move`, { column: "preparation" });
    const mother = await waitFor(m.id, (x) => x.status === "ready");
    expect(mother.column).toBe("preparation");
    expect(mother.status_text).toMatch(/2 sub-tarjetas/);
    const kids = (await api<Card[]>(`/api/projects/${projectId}/cards`)).filter((x) => x.parent_id === m.id);
    expect(kids.map((k) => k.title).sort()).toEqual(["Tienda A", "Tienda B"]);
    // auto_doing is on: both go to Doing by themselves and end in review
    const done = await Promise.all(kids.map((k) => waitFor(k.id, (x) => x.column === "review" && x.status === "idle", 15000)));
    for (const k of done) {
      expect(k.plan).toContain("Sub-tarjetas hermanas");
      expect(k.checkpoints_total).toBe(1);
    }
    expect(done[0].plan).toContain(done[1].title);
    // the mother runs no agent, even when moved to Doing by hand
    await api(`/api/cards/${m.id}/move`, { column: "doing" });
    await new Promise((r) => setTimeout(r, 300));
    expect(await card(m.id)).toMatchObject({ column: "doing", status: "ready", branch: null });

    await api(`/api/cards/${kids[0].id}/move`, { column: "merged" });
    await waitFor(kids[0].id, (x) => x.status_text.startsWith("Merge "));
    expect((await card(m.id)).column).toBe("doing");
    await api(`/api/cards/${kids[1].id}/move`, { column: "merged" });
    await waitFor(kids[1].id, (x) => x.status_text.startsWith("Merge "));
    await waitFor(m.id, (x) => x.column === "merged" && x.status === "idle");
  }, 30000);

  it("without the automatic move, sub-cards wait in preparation", async () => {
    await api(`/api/projects/${projectId}`, { auto_doing: false }, "PATCH");
    try {
      const m = await api<Card>("/api/cards", { project_id: projectId, title: "Panel", spec: "split", column: "plan" });
      await api(`/api/cards/${m.id}/move`, { column: "preparation" });
      await waitFor(m.id, (x) => x.status === "ready");
      const kids = (await api<Card[]>(`/api/projects/${projectId}/cards`)).filter((x) => x.parent_id === m.id);
      expect(kids).toHaveLength(2);
      expect(kids.every((k) => k.column === "preparation" && k.status === "ready")).toBe(true);
    } finally {
      await api(`/api/projects/${projectId}`, { auto_doing: true }, "PATCH");
    }
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
    const aMerged = await waitFor(a.id, (x) => x.column === "merged" && x.status_text.startsWith("Merge "));
    expect(aMerged.merged_at).toBeTruthy();

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

  it("deletes branches from the menu: protected ones, unmerged, worktrees, remote and per-branch errors", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Rama en curso", spec: "x", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "doing" });
    const active = await waitFor(c.id, (x) => x.column === "review" && x.status === "idle");
    const tmp = mkdtempSync(join(tmpdir(), "trellai-ramas-"));
    const origin = join(tmp, "origin.git");
    sh(`git init -q --bare ${JSON.stringify(origin)}`, tmp);
    sh(`git remote add origin ${JSON.stringify(origin)}`);
    sh("git push -q origin main~1:refs/heads/remota-mergeada");
    sh("git branch vieja-mergeada main~1");
    const wtMerged = join(tmp, "wt-mergeada");
    sh(`git worktree add -q -b con-worktree ${JSON.stringify(wtMerged)} main`);
    const wtLoose = join(tmp, "wt-suelta");
    sh(`git worktree add -q -b sin-mergear ${JSON.stringify(wtLoose)} main`);
    for (const n of [1, 2]) sh(`git commit -q --allow-empty -m suelta${n}`, wtLoose);
    writeFileSync(join(wtLoose, "SUCIO.md"), "sin commitear\n");
    try {
      const list = await api<any>(`/api/projects/${projectId}/branches`);
      const by = (n: string) => list.branches.find((b: any) => b.name === n);
      expect(by("main").locked).toMatch(/rama base/);
      expect(by(active.branch!).locked).toMatch(/en curso/);
      expect(by("remota-mergeada")).toMatchObject({ local: false, remote: true, merged: true, locked: null });
      expect(by("con-worktree")).toMatchObject({ merged: true, worktree: expect.any(String), dirty: false });
      expect(by("sin-mergear")).toMatchObject({ merged: false, unmerged: 2, dirty: true });

      await expect(api(`/api/projects/${projectId}/branches/delete`, { name: "main", force: true })).rejects.toThrow(/rama base/);
      await expect(api(`/api/projects/${projectId}/branches/delete`, { name: active.branch, force: true })).rejects.toThrow(/en curso/);
      await expect(api(`/api/projects/${projectId}/branches/delete`, { name: "sin-mergear" })).rejects.toThrow(/2 commit/);

      // GitHub unreachable: the remote one fails, the local ones are deleted anyway
      sh(`git remote set-url origin ${JSON.stringify(join(tmp, "no-existe.git"))}`);
      const r1 = await api<any>(`/api/projects/${projectId}/branches/cleanup`, {});
      const res = (n: string) => r1.results.find((x: any) => x.name === n);
      expect(res("vieja-mergeada")).toMatchObject({ ok: true });
      expect(res("con-worktree")).toMatchObject({ ok: true });
      expect(res("remota-mergeada")).toMatchObject({ ok: false, error: expect.stringMatching(/No pude borrarla/) });
      expect(res("sin-mergear")).toBeUndefined();
      expect(res("main")).toBeUndefined();
      expect(existsSync(wtMerged)).toBe(false);
      expect(sh("git branch --list vieja-mergeada con-worktree")).toBe("");

      sh(`git remote set-url origin ${JSON.stringify(origin)}`);
      const r2 = await api<any>(`/api/projects/${projectId}/branches/cleanup`, { names: ["remota-mergeada"] });
      expect(r2.results).toEqual([{ name: "remota-mergeada", ok: true }]);
      expect(sh("git ls-remote --heads origin")).not.toContain("remota-mergeada");

      expect(await api(`/api/projects/${projectId}/branches/delete`, { name: "sin-mergear", force: true })).toMatchObject({ ok: true });
      expect(existsSync(wtLoose)).toBe(false);
      const after = await api<any>(`/api/projects/${projectId}/branches`);
      const left = after.branches.map((b: any) => b.name);
      expect(left).toEqual(expect.arrayContaining(["main", active.branch]));
      for (const n of ["vieja-mergeada", "con-worktree", "remota-mergeada", "sin-mergear"]) expect(left).not.toContain(n);
    } finally {
      sh("git remote remove origin");
    }
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

describe("what agents spend and how many run at once", () => {
  it("each run adds up what it spent: on the card, a line in its activity, and the project's total", async () => {
    const before = await api<any>(`/api/projects/${projectId}/usage`);
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Gasto", spec: "x", column: "plan" });
    await api(`/api/cards/${c.id}/move`, { column: "doing" });
    const done = await waitFor(c.id, (x) => x.column === "review" && x.status === "idle");
    // the simulated agent reports 1200 in + 300 out + 8000 cache read + 500 cache write
    expect(done.tokens).toBe(10000);
    expect(done.tokens_cache).toBe(8000);
    const msgs = await api<any[]>(`/api/cards/${c.id}/messages`);
    expect(msgs.filter((m) => m.role === "system" && m.content === "💸 10k tokens (8k de caché) · ≈ 0,02 US$")).toHaveLength(1);
    const after = await api<any>(`/api/projects/${projectId}/usage`);
    expect(after.runs).toBe(before.runs + 1);
    expect(after.cards.cache_read - before.cards.cache_read).toBe(8000);
  });

  it("max_agents is validated", async () => {
    await expect(api(`/api/projects/${projectId}`, { max_agents: 0 }, "PATCH")).rejects.toThrow(/entre 1 y 20/);
    await expect(api(`/api/projects/${projectId}`, { max_agents: "3" }, "PATCH")).rejects.toThrow(/entre 1 y 20/);
    expect((await api<any>(`/api/projects/${projectId}`, { max_agents: 3 }, "PATCH")).max_agents).toBe(3);
  });

  it("with 3 agents at work the 4th waits «En cola» and starts by itself when one finishes", async () => {
    const make = (title: string, spec: string) => api<Card>("/api/cards", { project_id: projectId, title, spec, column: "plan" });
    const busy = await Promise.all(["Cola 1", "Cola 2", "Cola 3"].map((t) => make(t, "slow")));
    const fourth = await make("Cola 4", "x");
    for (const c of busy) await api(`/api/cards/${c.id}/move`, { column: "doing" });
    for (const c of busy) await waitFor(c.id, (x) => x.status === "running");
    await api(`/api/cards/${fourth.id}/move`, { column: "doing" });
    const waiting = await waitFor(fourth.id, (x) => x.status === "queued");
    expect(waiting.status_text).toBe("En cola (posición 1)");
    // a message while it waits goes in with its first run
    await api(`/api/cards/${fourth.id}/message`, { text: "Hazlo azul" });
    await Promise.all([...busy, fourth].map((c) => waitFor(c.id, (x) => x.column === "review" && x.status === "idle", 15000)));
    const msgs = (await api<any[]>(`/api/cards/${fourth.id}/messages`)).map((m) => m.content);
    expect(msgs.some((m) => m.startsWith("⏳ En cola: ya hay 3 agentes"))).toBe(true);
    expect(msgs).toContain("Se lo paso al agente en cuanto arranque (está en cola).");
    expect(msgs).toContain("▶ Hay hueco: arranca el agente.");
    expect(msgs.filter((m) => m.startsWith("💸"))).toHaveLength(1); // one run, message included
  }, 30000);

  it("only Doing counts: with 3 at work a 4th in Doing waits, a card in Preparation starts and queues once in Doing", async () => {
    const make = (title: string, spec: string) => api<Card>("/api/cards", { project_id: projectId, title, spec, column: "plan" });
    const busy = await Promise.all(["Hueco 1", "Hueco 2", "Hueco 3"].map((t) => make(t, "slow")));
    const fourth = await make("Hueco 4", "x");
    const prep = await make("Hueco prep", "x");
    for (const c of busy) await api(`/api/cards/${c.id}/move`, { column: "doing" });
    for (const c of busy) await waitFor(c.id, (x) => x.status === "running");
    await api(`/api/cards/${fourth.id}/move`, { column: "doing" });
    expect((await waitFor(fourth.id, (x) => x.status === "queued")).status_text).toBe("En cola (posición 1)");

    await api(`/api/projects/${projectId}`, { auto_doing: true }, "PATCH");
    await api(`/api/cards/${prep.id}/move`, { column: "preparation" });
    // prepared while the three still work, then in Doing it waits its turn behind the 4th
    const inDoing = await waitFor(prep.id, (x) => x.column === "doing" && x.status === "queued");
    expect(inDoing.status_text).toBe("En cola (posición 2)");
    for (const c of busy) expect((await card(c.id)).status).toBe("running");
    const msgs = (await api<any[]>(`/api/cards/${prep.id}/messages`)).map((m) => m.content);
    const ready = msgs.findIndex((m) => m.startsWith("✅ Spec clara"));
    expect(ready).toBeGreaterThan(-1);
    expect(msgs.findIndex((m) => m.startsWith("⏳ En cola"))).toBeGreaterThan(ready); // it only waited once in Doing

    await Promise.all([...busy, fourth, prep].map((c) => waitFor(c.id, (x) => x.column === "review" && x.status === "idle", 15000)));
  }, 30000);

  it("hitting the session limit stops launching the line until Reintentar, then both carry on", async () => {
    const a = await api<Card>("/api/cards", { project_id: projectId, title: "Límite A", spec: "limit", column: "plan" });
    await api(`/api/cards/${a.id}/move`, { column: "doing" });
    const paused = await waitFor(a.id, (x) => x.status === "queued");
    expect(paused.status_text).toBe("En cola — límite de Claude alcanzado (pulsa Reintentar para seguir)");
    const aMsgs = (await api<any[]>(`/api/cards/${a.id}/messages`)).map((m) => m.content);
    expect(aMsgs.some((m) => m.startsWith("⏸ Límite de uso alcanzado: «You've hit your session limit"))).toBe(true);

    const b = await api<Card>("/api/cards", { project_id: projectId, title: "Límite B", spec: "x", column: "plan" });
    await api(`/api/cards/${b.id}/move`, { column: "doing" });
    await waitFor(b.id, (x) => x.status === "queued");
    await new Promise((r) => setTimeout(r, 400));
    expect((await card(b.id)).status).toBe("queued"); // nobody is launched meanwhile

    await api(`/api/cards/${b.id}/retry`, {});
    await waitFor(a.id, (x) => x.column === "review" && x.status === "idle", 10000);
    await waitFor(b.id, (x) => x.column === "review" && x.status === "idle", 10000);
  }, 30000);
});
