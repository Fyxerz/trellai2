/**
 * The Vista: the app of the base branch / a card running inside Trellai behind the "Señalar"
 * proxy, and pins turning into requests (the "rama de retoques").
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Card, Checkpoint, VistaPin, VistaStatus } from "../shared/types";

const dir = mkdtempSync(join(tmpdir(), "trellai-vista-"));
process.env.TRELLAI_DB = join(dir, "unit.db");

const PORT = 4900 + Math.floor(Math.random() * 500);
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
const repo = join(dir, "repo");
let projectId: string;

async function api<T = any>(path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
  const r = await fetch(URL + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error);
  return json as T;
}

async function until<T>(get: () => Promise<T>, pred: (v: T) => boolean, ms = 60000): Promise<T> {
  const t0 = Date.now();
  let v = await get();
  while (!pred(v)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${JSON.stringify(v).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 150));
    v = await get();
  }
  return v;
}

const card = async (id: string) => (await api<Card[]>(`/api/projects/${projectId}/cards`)).find((c) => c.id === id)!;
const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" }).trim();
const answers = (port: number) =>
  new Promise<boolean>((done) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => (s.destroy(), done(true)));
    s.on("error", () => done(false));
  });

/** Upgrade through the proxy and get an echo back from the app's websocket. */
function wsEcho(port: number): Promise<string> {
  return new Promise((done, fail) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
    let buf = "";
    let sent = false;
    s.on("data", (d) => {
      buf += d.toString();
      if (!sent && buf.includes("\r\n\r\n")) {
        sent = true;
        buf = buf.slice(buf.indexOf("\r\n\r\n") + 4);
        s.write("hola");
      }
      if (sent && buf.includes("hola")) {
        s.destroy();
        done(buf);
      }
    });
    s.on("error", fail);
    setTimeout(() => fail(new Error("sin eco")), 5000);
  });
}

const APP = `
const http = require("http");
const port = Number(process.env.PORT);
const srv = http.createServer((req, res) => {
  if (req.url === "/env") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ TRELLAI_DB: process.env.TRELLAI_DB ?? null, NODE_ENV: process.env.NODE_ENV ?? null, PORT: process.env.PORT, BROWSER: process.env.BROWSER }));
  }
  if (req.url === "/go") {
    res.writeHead(302, { location: "http://localhost:" + port + "/destino" });
    return res.end();
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" });
  res.end('<!doctype html><html><head><title>App</title></head><body><button class="primary">Guardar</button></body></html>');
});
srv.on("upgrade", (req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
  socket.pipe(socket);
});
srv.listen(port, "127.0.0.1", () => console.log("App lista en http://localhost:" + port + "/"));
`;

beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  sh("git init -q -b main && git config user.email t@t && git config user.name t");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "app", scripts: { dev: "node app.js" }, dependencies: { "left-pad": "1.3.0" } }));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ name: "app", lockfileVersion: 3, packages: {} }));
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "app.js"), APP);
  sh("git add -A && git commit -qm init");
  // "Installed" in the main checkout: the worktrees link to it.
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(repo, "node_modules", "left-pad", "font.woff2"), "wOF2-fuente");

  server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, PORT: String(PORT), TRELLAI_DB: join(dir, "t.db"), TRELLAI_FAKE_AGENT: "1", TRELLAI_FAKE_DELAY: "60" },
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
  projectId = (await api("/api/projects", { repo_path: repo })).id;
}, 30000);

afterAll(() => {
  server?.kill();
});

describe("pieces", () => {
  it("detects the command, the install and what the dependencies are", async () => {
    const v = await import("../server/vista");
    expect(v.detectCommand(repo)).toBe("npm run dev");
    expect(v.detectCommand(dir)).toBeNull();
    expect(v.installCommand(repo)).toBe("npm ci --no-audit --no-fund");
    expect(v.depsFingerprint(repo)).toMatch(/^package-lock\.json:/);
    expect(v.withPort("node servidor.js --puerto {port}", 5123)).toBe("node servidor.js --puerto 5123");
  });

  it("injects the script once, before </head>, whatever the charset", async () => {
    const v = await import("../server/vista");
    const html = Buffer.from("<html><HEAD><title>é</title></HEAD><body></body></html>", "latin1");
    const out = v.injectScript(html).toString("latin1");
    expect(out).toBe('<html><HEAD><title>é</title><script src="/__trellai/picker.js" defer></script></HEAD><body></body></html>');
    expect(v.injectScript(Buffer.from(out, "latin1")).toString("latin1")).toBe(out);
    expect(v.injectScript(Buffer.from("hola")).toString()).toBe('hola<script src="/__trellai/picker.js" defer></script>');
  });

  it("keeps Trellai's own settings out of the app's environment", async () => {
    const v = await import("../server/vista");
    process.env.TRELLAI_DATABASE_URL = "postgres://secreto";
    process.env.MAITRE_RESTART_CODE = "75";
    const env = v.childEnv(1234);
    delete process.env.TRELLAI_DATABASE_URL;
    delete process.env.MAITRE_RESTART_CODE;
    expect(env.PORT).toBe("1234");
    expect(env.BROWSER).toBe("none");
    expect(env.TRELLAI_DATABASE_URL).toBeUndefined();
    expect(env.TRELLAI_DB).toBeUndefined();
    expect(env.MAITRE_RESTART_CODE).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
  });

  it("turns pins into a request the agent can act on", async () => {
    const p = await import("../server/vista-pins");
    const pins = p.cleanPins([
      { comment: "  Que vaya a la derecha de Cancelar ", page: "/tarjetas", tag: '<button class="primary">', text: "Guardar", selector: "footer > button.primary", size: "96×32", components: ["SaveButton", "CardPanel", 7], source: "/src/CardPanel.tsx:~412", siblings: "en fila: Cancelar · »Guardar«", styles: "padding 6px 12px" },
      { comment: "", tag: "" },
      "basura",
    ]);
    expect(pins).toHaveLength(1);
    expect(pins[0].comment).toBe("Que vaya a la derecha de Cancelar");
    expect(pins[0].components).toEqual(["SaveButton", "CardPanel"]);
    const md = p.pinsMarkdown(pins, "todo más compacto");
    expect(md).toContain("1 cambio señalado en la Vista");
    expect(md).toContain("**1. Que vaya a la derecha de Cancelar**");
    expect(md).toContain("`<button class=\"primary\">` «Guardar» · 96×32 px");
    expect(md).toContain("componente `SaveButton` ← `CardPanel` · `/src/CardPanel.tsx:~412`");
    expect(md).toContain("Junto a: en fila: Cancelar · »Guardar«");
    expect(md).toContain("**En general:** todo más compacto");
    expect(p.pinLabel(pins[0])).toBe("«Guardar» (button)");
  });
});

describe("the base branch's Vista", () => {
  let port: number;

  it("starts the app from its own worktree, behind the proxy", async () => {
    const first = await api<VistaStatus>(`/api/projects/${projectId}/vista`);
    expect(first).toMatchObject({ cardId: null, branch: "main", state: "stopped", command: "npm run dev" });
    await api(`/api/projects/${projectId}/vista/start`, {});
    const ready = await until(() => api<VistaStatus>(`/api/projects/${projectId}/vista`), (s) => s.state === "ready" || s.state === "error");
    expect(ready.state, ready.log.join("\n")).toBe("ready");
    port = ready.port!;
    // node_modules is the main checkout's, linked (same lockfile): nothing installed.
    expect(lstatSync(join(repo, ".trellai", "worktrees", "_vista", "node_modules")).isSymbolicLink()).toBe(true);
    expect(ready.log.join("\n")).not.toMatch(/npm ci/);
  }, 90000);

  it("serves the app with the Señalar script, embeddable", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    const html = await r.text();
    expect(html).toContain('<script src="/__trellai/picker.js" defer></script></head>');
    expect(html).toContain("Guardar");
    expect(r.headers.get("x-frame-options")).toBeNull();
    const js = await (await fetch(`http://127.0.0.1:${port}/__trellai/picker.js`)).text();
    expect(js).toContain("trellai-vista");
    const env = await (await fetch(`http://127.0.0.1:${port}/env`)).json();
    expect(env).toMatchObject({ TRELLAI_DB: null, NODE_ENV: null, BROWSER: "none" });
    expect(Number(env.PORT)).toBeGreaterThan(0);
    const go = await fetch(`http://127.0.0.1:${port}/go`, { redirect: "manual" });
    expect(go.headers.get("location")).toBe(`http://127.0.0.1:${port}/destino`);
    expect(await wsEcho(port)).toContain("hola");
  });

  it("serves fonts from the linked node_modules, which vite would refuse (outside the worktree)", async () => {
    const real = realpathSync(join(repo, "node_modules")).replace(/\\/g, "/").replace(/^\//, "");
    const font = await fetch(`http://127.0.0.1:${port}/@fs/${real}/left-pad/font.woff2`);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(await font.text()).toBe("wOF2-fuente");
    // Anything else under /@fs/ is the app's business.
    const other = await fetch(`http://127.0.0.1:${port}/@fs/${real}/left-pad/index.js`);
    expect(other.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("stops, and starts again", async () => {
    const stopped = await api<VistaStatus>(`/api/projects/${projectId}/vista/stop`, {});
    expect(stopped.state).toBe("stopped");
    expect(await answers(port)).toBe(false);
    await api(`/api/projects/${projectId}/vista/start`, {});
    const ready = await until(() => api<VistaStatus>(`/api/projects/${projectId}/vista`), (s) => s.state === "ready" || s.state === "error");
    expect(ready.state, ready.log.join("\n")).toBe("ready");
    port = ready.port!;
  }, 90000);
});

describe("Señalar from the project's Vista: the rama de retoques", () => {
  const pin = (comment: string): VistaPin => ({
    comment,
    page: "/",
    tag: '<button class="primary">',
    text: "Guardar",
    selector: "button.primary",
    size: "80×30",
    components: [],
    source: "",
    siblings: "",
    styles: "",
  });
  let touchup: Card;
  let port: number;

  it("creates the card straight in Doing, one checkpoint per pin", async () => {
    touchup = await api<Card>(`/api/projects/${projectId}/vista/pins`, { pins: [pin("Más grande")], note: "" });
    expect(touchup).toMatchObject({ touchup: true, column: "doing" });
    expect(touchup.title).toBe("Retoques: Más grande");
    expect(touchup.spec).toContain("**1. Más grande**");
    const cps = await api<Checkpoint[]>(`/api/cards/${touchup.id}/checkpoints`);
    expect(cps.map((c) => c.text)).toEqual(["Más grande — «Guardar» (button)"]);
    touchup = await until(() => card(touchup.id), (c) => c.column === "review", 20000);
  }, 30000);

  it("the project's Vista now shows its branch, and more pins go to it", async () => {
    const s = await api<VistaStatus>(`/api/projects/${projectId}/vista`);
    expect(s).toMatchObject({ cardId: touchup.id, branch: touchup.branch });
    await api(`/api/projects/${projectId}/vista/start`, {});
    const ready = await until(() => api<VistaStatus>(`/api/projects/${projectId}/vista`), (v) => v.state === "ready" || v.state === "error");
    expect(ready.state, ready.log.join("\n")).toBe("ready");
    expect(lstatSync(join(touchup.worktree!, "node_modules")).isSymbolicLink()).toBe(true);
    port = ready.port!;

    const again = await api<Card>(`/api/projects/${projectId}/vista/pins`, { pins: [pin("Otro color")] });
    expect(again.id).toBe(touchup.id);
    expect((await api<Checkpoint[]>(`/api/cards/${touchup.id}/checkpoints`)).length).toBe(2);
    await until(() => card(touchup.id), (c) => c.column === "review" && c.status !== "running", 20000);
  }, 90000);

  it("merging closes it: its app stops, the shared node_modules survives, the Vista goes back to main", async () => {
    await api(`/api/cards/${touchup.id}/move`, { column: "merged" });
    const merged = await until(() => card(touchup.id), (c) => c.column === "merged" && c.status !== "running" && !c.worktree, 20000);
    expect(merged.status_text).toMatch(/^Merge /);
    expect(existsSync(touchup.worktree!)).toBe(false);
    expect(existsSync(join(repo, "node_modules", "left-pad", "index.js"))).toBe(true);
    expect(await answers(port)).toBe(false);
    const s = await api<VistaStatus>(`/api/projects/${projectId}/vista`);
    expect(s).toMatchObject({ cardId: null, branch: "main" });
  }, 30000);
});

describe("a card's Vista", () => {
  it("needs the card's branch on this computer", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "Sin rama" });
    await expect(api(`/api/cards/${c.id}/vista`)).rejects.toThrow(/todavía no tiene rama/);
  });

  it("refuses pins for a card that isn't being worked on", async () => {
    const c = await api<Card>("/api/cards", { project_id: projectId, title: "En backlog" });
    await expect(api(`/api/cards/${c.id}/vista/pins`, { pins: [{ comment: "x", tag: "<a>" }] })).rejects.toThrow(/Doing o To Review/);
  });
});

describe("Trellai goes away", () => {
  it("its apps don't outlive it", async () => {
    const s = await until(() => api<VistaStatus>(`/api/projects/${projectId}/vista/start`, {}), (v) => v.state === "ready" || v.state === "error");
    expect(s.state, s.log.join("\n")).toBe("ready");
    const appPort = Number((await (await fetch(`http://127.0.0.1:${s.port}/env`)).json()).PORT);
    expect(await answers(appPort)).toBe(true);
    server.kill("SIGKILL"); // no chance to clean up: the runner has to notice
    await until(async () => answers(appPort), (up) => !up, 15000);
  }, 60000);
});
