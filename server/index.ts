import "./env.js";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { COLUMNS, isColumn, TAG_COLORS, type ServerEvent } from "../shared/types.js";
import { sweepAll } from "./claims.js";
import * as db from "./db.js";
import { emitCard, emitCardDeleted, emitCheckpoints, emitMessage, emitNote, emitTags, subscribe } from "./events.js";
import * as git from "./git.js";
import * as wf from "./workflow.js";
import { claudeModels, codexDefaultModel, codexStatus, mcpCallTool, mcpListTools } from "./engine.js";
import { startPreview, stopPreview } from "./preview.js";
import { MACHINE } from "./machine.js";
import * as remote from "./remote.js";
import { startSync, syncStatus } from "./sync.js";
import { assistantRunning, sendToAssistant, stopAssistant } from "./assistant.js";
import { buildInfo, distDir, startSelfUpdate } from "./selfupdate.js";
import { readChatImage, saveChatImage } from "./chatImages.js";

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

app.post("/api/projects", async (c) => {
  const body = await c.req.json<{ name?: string; repo_path?: string; base_branch?: string; init?: boolean }>();
  const path = expandHome(String(body.repo_path ?? "").trim());
  if (!existsSync(path) || !statSync(path).isDirectory()) return c.json({ error: `No existe la carpeta: ${path}` }, 400);
  if (!git.isRepo(path)) {
    if (!body.init) return c.json({ error: `No es un repositorio git: ${path}`, notRepo: true }, 400);
    git.initRepo(path);
  }
  const repo = git.topLevel(path);
  if (!git.hasCommits(repo)) return c.json({ error: "El repo no tiene ningún commit todavía. Haz un primer commit." }, 400);
  const remoteUrl = git.remoteUrlSync(repo);
  // Already on the board from another computer? Then this is just where it lives here.
  const twin = db.listProjects().find((p) => !p.repo_path && git.sameRemoteSync(p.remote_url, remoteUrl));
  if (twin) return c.json(db.updateProject(twin.id, { repo_path: repo }));
  const base = body.base_branch?.trim() || git.currentBranch(repo);
  const name = basename(body.name?.trim() || repo);
  return c.json(db.createProject({ name, repo_path: repo, base_branch: base, remote_url: remoteUrl }));
});

// ---------- other computers / GitHub ----------

app.get("/api/sync", (c) => c.json(syncStatus()));

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
  return c.json(db.updateProject(project.id, { repo_path: repo, remote_url: project.remote_url ?? url }));
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

/** Base branch vs the remote, for the header (fetches at most once a minute). */
app.get("/api/projects/:id/git", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project?.repo_path) return c.json({ remote: null, ahead: 0, behind: 0, ok: true });
  return c.json(await remote.baseStatus(project.repo_path, project.base_branch));
});

/** All branches (local + remote) for the header's branch list, with the card each one belongs to. */
app.get("/api/projects/:id/branches", async (c) => {
  const project = db.getProject(c.req.param("id"));
  if (!project?.repo_path) return c.json({ error: "Este proyecto no está en este ordenador" }, 400);
  const f = await remote.fetchRemote(project.repo_path, 60_000);
  const list = git.listBranches(project.repo_path, project.base_branch);
  const cards = new Map(db.listCards(project.id).filter((k) => k.branch).map((k) => [k.branch!, k]));
  return c.json({
    ...list,
    base: project.base_branch,
    remoteLabel: list.remote ? remote.remoteLabel(project.repo_path) : null,
    fetch: { ok: f.ok, message: f.message },
    branches: list.branches.map((b) => {
      const k = cards.get(b.name);
      return { ...b, card: k ? { id: k.id, title: k.title, column: k.column } : null };
    }),
  });
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

app.patch("/api/projects/:id", async (c) => {
  const body = await c.req.json<Record<string, string | null>>();
  if (!db.getProject(c.req.param("id"))) return c.json({ error: "Proyecto no encontrado" }, 404);
  return c.json(db.updateProject(c.req.param("id"), body));
});

// ---------- engines / models ----------

app.get("/api/engines", async (c) => {
  const [models, codex] = await Promise.all([claudeModels().catch(() => []), codexStatus()]);
  return c.json({ claude: { installed: true, models }, codex: { ...codex, defaultModel: codexDefaultModel() } });
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
        .filter((x) => x.status === "running" || x.status === "waiting" || x.status === "error" || x.column === "review")
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
  const note = db.addNote(c.req.param("id"), null, `Pedro: ${content}`, { files: (files ?? []).map((f) => f.trim()).filter(Boolean) });
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
  const { text, images } = await c.req.json<{ text: string; images?: string[] }>();
  let links: string[];
  try {
    links = (Array.isArray(images) ? images.slice(0, 10) : []).map((img) => `![imagen](${saveChatImage(img)})`);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const full = [text?.trim(), ...links].filter(Boolean).join("\n\n");
  if (!full) return c.json({ error: "Mensaje vacío" }, 400);
  wf.sendMessage(c.req.param("id"), full);
  return c.json({ ok: true });
});

app.get("/api/chat-images/:name", (c) => {
  const img = readChatImage(c.req.param("name"));
  if (!img) return c.json({ error: "Imagen no encontrada" }, 404);
  return c.body(new Uint8Array(img.data), 200, { "Content-Type": img.type, "Cache-Control": "public, max-age=31536000, immutable" });
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
startSync();
startSelfUpdate();

const port = Number(process.env.PORT ?? 4317);
const hostname = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Trellai → http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`);
  if (process.env.TRELLAI_FAKE_AGENT) console.log("(modo agente simulado)");
  else claudeModels().catch(() => {}); // exact versions for the model pickers
});
