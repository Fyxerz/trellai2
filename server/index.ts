import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isColumn, type ServerEvent } from "../shared/types.js";
import * as db from "./db.js";
import { emitCard, emitCardDeleted, emitNote, subscribe } from "./events.js";
import * as git from "./git.js";
import * as wf from "./workflow.js";

const app = new Hono();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 400);
});

const expandHome = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

// ---------- projects ----------

app.get("/api/projects", (c) => c.json(db.listProjects()));

app.post("/api/projects", async (c) => {
  const body = await c.req.json<{ name?: string; repo_path?: string; base_branch?: string }>();
  const path = expandHome(String(body.repo_path ?? "").trim());
  if (!git.isRepo(path)) return c.json({ error: `No es un repositorio git: ${path}` }, 400);
  const repo = git.topLevel(path);
  const base = body.base_branch?.trim() || git.currentBranch(repo);
  const name = body.name?.trim() || repo.split("/").pop()!;
  return c.json(db.createProject({ name, repo_path: repo, base_branch: base }));
});

app.delete("/api/projects/:id", async (c) => {
  for (const card of db.listCards(c.req.param("id"))) await wf.removeCard(card.id);
  db.deleteProject(c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/projects/:id/cards", (c) => c.json(db.listCards(c.req.param("id"))));
app.get("/api/projects/:id/notes", (c) => c.json(db.listNotes(c.req.param("id"))));

app.post("/api/projects/:id/notes", async (c) => {
  const { content } = await c.req.json<{ content: string }>();
  const note = db.addNote(c.req.param("id"), null, `Pedro: ${content}`);
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

app.patch("/api/cards/:id", async (c) => {
  const body = await c.req.json<{ title?: string; spec?: string; plan?: string }>();
  const card = db.updateCard(c.req.param("id"), {
    title: body.title?.trim() || undefined,
    spec: body.spec,
    plan: body.plan,
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

app.get("/api/cards/:id/messages", (c) => c.json(db.listMessages(c.req.param("id"))));
app.get("/api/cards/:id/questions", (c) => c.json(db.listQuestions(c.req.param("id"))));

app.post("/api/cards/:id/message", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  if (!text?.trim()) return c.json({ error: "Mensaje vacío" }, 400);
  wf.sendMessage(c.req.param("id"), text.trim());
  return c.json({ ok: true });
});

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

app.get("/api/cards/:id/diff", (c) => {
  const card = db.getCard(c.req.param("id"));
  const project = card && db.getProject(card.project_id);
  if (!card || !project || !card.worktree || !existsSync(card.worktree)) return c.json({ diff: "", files: [] });
  return c.json({
    diff: git.diffVsBase(card.worktree, project.base_branch),
    files: git.changedFiles(card.worktree, project.base_branch),
  });
});

// ---------- static UI (production) ----------

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

wf.recoverAfterRestart();

const port = Number(process.env.PORT ?? 4317);
const hostname = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Trellai → http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`);
  if (process.env.TRELLAI_FAKE_AGENT) console.log("(modo agente simulado)");
});
