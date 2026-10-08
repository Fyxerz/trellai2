/**
 * The Vista: the app of a card's branch — or of the base branch — running inside Trellai, so
 * Pedro sees each change without his own dev server and points at elements ("Señalar") instead
 * of sending screenshots.
 *
 * - Each target runs its own dev server from its own worktree: the card's, or `_vista` (the base
 *   branch, detached) — or the open "rama de retoques" card instead, once there is one. It's
 *   started with the project's command (`npm run dev` by default) and PORT set to a free port.
 *   node_modules is linked to the main checkout's when the dependencies are the same; otherwise
 *   it's installed in the worktree.
 * - In front of it, a small proxy on its own port injects the "Señalar" script (vista-picker.js)
 *   into the app's pages and lets websockets (hot reload) through.
 * - Servers start when the Vista opens and stop after a while unused, when their worktree is
 *   deleted, or with Trellai (vista-runner.mjs kills them if Trellai dies).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import type { Card, Project, VistaStatus } from "../shared/types.js";
import * as db from "./db.js";
import * as git from "./git.js";
import { repoLock } from "./lock.js";
import { MACHINE } from "./machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "vista-runner.mjs");
const PICKER = join(HERE, "vista-picker.js");
/** Same interface as Trellai itself, so the Vista opens wherever Trellai does. */
const BIND = process.env.HOST ?? "127.0.0.1";
const IDLE_MS = Number(process.env.TRELLAI_VISTA_IDLE_MS ?? 20 * 60_000);
const START_TIMEOUT_MS = 180_000;
/** An answer that isn't a web page is taken after this long without a better one (API-only apps). */
const NON_HTML_GRACE_MS = 10_000;
const LOG_LINES = 300;
const win = process.platform === "win32";
export const MAIN_WORKTREE = "_vista";

type State = VistaStatus["state"];

interface Server {
  cwd: string;
  command: string | null;
  state: State;
  message: string | null;
  log: string[];
  /** half-received line of each output stream */
  partial: { out: string; err: string };
  proc: ChildProcess | null;
  /** where the app answers, once found */
  app: URL | null;
  /** local URLs the app printed: where to look for it */
  printed: string[];
  /** real folder of the main checkout's node_modules, when the worktree links to it */
  shared: string | null;
  proxy: http.Server;
  proxyPort: Promise<number>;
  lastUsed: number;
  /** bumped on every stop: the steps of an older start give up */
  run: number;
}

const servers = new Map<string, Server>();
const keyOf = (cwd: string) => (win ? resolve(cwd).toLowerCase() : resolve(cwd));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// What to run
// ---------------------------------------------------------------------------

export function packageManager(cwd: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

/** `npm run dev` (or start / serve) from package.json; null when there's nothing to run. */
export function detectCommand(cwd: string): string | null {
  let scripts: Record<string, unknown>;
  try {
    scripts = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return null;
  }
  const name = ["dev", "start", "serve"].find((s) => typeof scripts[s] === "string");
  return name ? `${packageManager(cwd)} run ${name}` : null;
}

/** `{port}` in the command is the app's port, for apps that take it as an argument (`--puerto {port}`). */
export const withPort = (command: string, port: number) => command.replaceAll("{port}", String(port));

const commandFor = (project: Project, cwd: string | null) => project.preview_command?.trim() || (cwd ? detectCommand(cwd) : null);

/** The app's environment: Trellai's own settings (its database, port, production mode…) stay out. */
export function childEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(TRELLAI_|MAITRE)|^(NODE_ENV|HOST|PORT)$/i.test(k)) env[k] = v;
  return { ...env, PORT: String(port), BROWSER: "none", FORCE_COLOR: "0", NO_COLOR: "1", TRELLAI_VISTA: "1" };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const STAMP = ".trellai-deps";

/** What the installed dependencies depend on: the lockfile, or the package.json lists without one. */
export function depsFingerprint(dir: string): string | null {
  const hash = (b: Buffer | string) => createHash("sha1").update(b).digest("hex");
  for (const f of LOCKFILES) if (existsSync(join(dir, f))) return `${f}:${hash(readFileSync(join(dir, f)))}`;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return `package.json:${hash(JSON.stringify([pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]))}`;
  } catch {
    return null;
  }
}

function hasDeps(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some((d) => d && Object.keys(d).length);
  } catch {
    return false;
  }
}

/** Installs exactly what the lockfile says, without touching the worktree's tracked files. */
export function installCommand(cwd: string): string {
  switch (packageManager(cwd)) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "bun":
      return "bun install --frozen-lockfile";
    default:
      return existsSync(join(cwd, "package-lock.json")) || existsSync(join(cwd, "npm-shrinkwrap.json"))
        ? "npm ci --no-audit --no-fund"
        : "npm install --no-package-lock --no-audit --no-fund";
  }
}

/**
 * node_modules for the worktree: a link to the main checkout's when the dependencies are the
 * same (instant), or a real install in the worktree when they differ. Resolves false when
 * stopped meanwhile; throws if the install fails.
 */
async function prepareDeps(s: Server, repo: string, run: number): Promise<boolean> {
  if (!hasDeps(s.cwd)) return true;
  const nm = join(s.cwd, "node_modules");
  const shared = join(repo, "node_modules");
  const mine = depsFingerprint(s.cwd);
  const same = keyOf(s.cwd) !== keyOf(repo) && existsSync(shared) && mine === depsFingerprint(repo);
  let link = false;
  let exists = false;
  try {
    link = lstatSync(nm).isSymbolicLink();
    exists = true;
  } catch {
    /* none yet */
  }
  if (link && same && existsSync(nm)) return true;
  if (link) {
    rmSync(nm);
    exists = false;
    say(s, "Las dependencias de esta rama son distintas de las del repo principal: las instalo en su worktree.");
  }
  if (exists) {
    // Installed before, by us (stamp) or by the agent: reinstall only when we know they changed.
    let stamp: string | null = null;
    try {
      stamp = readFileSync(join(nm, STAMP), "utf8");
    } catch {
      /* not ours */
    }
    if (!stamp || stamp === mine) return true;
  } else if (same && git.isIgnored(s.cwd, "node_modules/")) {
    symlinkSync(shared, nm, win ? "junction" : "dir");
    say(s, "Uso las dependencias del repo principal (mismo lockfile).");
    return true;
  }
  const install = installCommand(s.cwd);
  s.state = "installing";
  say(s, `$ ${install}`);
  const proc = launch(s, install, childEnv(0));
  s.proc = proc;
  const code = await new Promise<number | null>((done) => proc.on("exit", (c) => done(c)));
  if (s.proc === proc) s.proc = null;
  if (s.run !== run) return false;
  if (code !== 0) throw new Error(`«${install}» ha fallado (código ${code ?? "?"}): mira el registro.`);
  try {
    if (mine) writeFileSync(join(nm, STAMP), mine);
  } catch {
    /* no node_modules (nothing to install) */
  }
  return true;
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

function launch(s: Server, command: string, env: NodeJS.ProcessEnv): ChildProcess {
  const proc = spawn(process.execPath, [RUNNER, String(process.pid), command], {
    cwd: s.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // Unix: its own process group, to stop everything it starts. Windows: out of Node's job object,
    // which would kill the runner (but not the app it started) the moment Trellai dies, before
    // its watchdog can stop the whole tree.
    detached: true,
  });
  proc.stdout?.on("data", (d: Buffer) => output(s, "out", d));
  proc.stderr?.on("data", (d: Buffer) => output(s, "err", d));
  proc.on("error", (err) => say(s, `No pude arrancarlo: ${err.message}`));
  return proc;
}

function killTree(proc: ChildProcess | null) {
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (win) execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-proc.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+/gi;

/** Each line the app prints goes to the log; local URLs in it are where it may be answering. */
function output(s: Server, stream: "out" | "err", chunk: Buffer) {
  const text = s.partial[stream] + chunk.toString("utf8").replace(ANSI, "");
  const lines = text.split(/\r\n|\n|\r/);
  s.partial[stream] = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    s.log.push(line.slice(0, 500));
    for (const [m] of line.matchAll(LOCAL_URL)) {
      const url = m.replace(/\/\/(0\.0\.0\.0|\[::\])/, "//localhost").toLowerCase();
      if (!s.printed.includes(url)) s.printed.push(url);
    }
  }
  if (s.log.length > LOG_LINES) s.log.splice(0, s.log.length - LOG_LINES);
}

function say(s: Server, line: string) {
  s.log.push(`[trellai] ${line}`);
  if (s.log.length > LOG_LINES) s.log.splice(0, s.log.length - LOG_LINES);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => done(port));
    });
  });
}

/** Does something answer at `origin`, and is it a web page? */
function probe(origin: string): Promise<"html" | "other" | null> {
  return new Promise((done) => {
    const req = http.get(`${origin}/`, { timeout: 2500, headers: { accept: "text/html,*/*" } }, (res) => {
      res.resume();
      done(String(res.headers["content-type"] ?? "").includes("text/html") ? "html" : "other");
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(null));
  });
}

/**
 * Where the app is answering: the first URL it printed (or PORT) that serves a web page. A dev
 * setup may print several (e.g. its API and vite); an app with no page at all is taken anyway
 * after a few seconds.
 */
async function findApp(s: Server, port: number, run: number, proc: ChildProcess): Promise<URL | null> {
  const t0 = Date.now();
  let firstOther = 0;
  while (s.run === run && proc.exitCode === null && Date.now() - t0 < START_TIMEOUT_MS) {
    let other: string | null = null;
    for (const origin of [...s.printed, `http://localhost:${port}`]) {
      const r = await probe(origin);
      if (r === "html") return new URL(origin);
      if (r === "other") other ??= origin;
    }
    if (other) {
      firstOther ||= Date.now();
      if (Date.now() - firstOther > NON_HTML_GRACE_MS) return new URL(other);
    }
    await sleep(400);
  }
  return null;
}

async function boot(s: Server, project: Project, run: number) {
  try {
    if (!s.command) {
      throw new Error("No sé cómo arrancar este proyecto: su package.json no tiene script dev ni start. Pon el comando en Ajustes de proyecto → Vista.");
    }
    if (!(await prepareDeps(s, project.repo_path, run)) || s.run !== run) return;
    s.shared = null;
    try {
      if (lstatSync(join(s.cwd, "node_modules")).isSymbolicLink()) s.shared = realpathSync(join(s.cwd, "node_modules"));
    } catch {
      /* no node_modules */
    }
    const port = await freePort();
    s.state = "starting";
    const command = withPort(s.command, port);
    say(s, `$ ${command}   (PORT=${port}, en ${s.cwd})`);
    const proc = launch(s, command, childEnv(port));
    s.proc = proc;
    proc.on("exit", (code) => {
      if (s.proc !== proc) return;
      s.proc = null;
      s.app = null;
      if (s.run !== run) return;
      s.state = "error";
      s.message = `La app se ha parado${code !== null ? ` (código ${code})` : ""}: mira el registro y pulsa Reiniciar.`;
    });
    const app = await findApp(s, port, run, proc);
    if (s.run !== run || s.proc !== proc) return;
    if (!app) throw new Error(`La app no responde tras ${START_TIMEOUT_MS / 1000} s: mira el registro.`);
    s.app = app;
    s.state = "ready";
    s.message = null;
    say(s, `Lista en ${app.origin}`);
  } catch (err) {
    if (s.run !== run) return;
    killTree(s.proc);
    s.proc = null;
    s.state = "error";
    s.message = (err as Error).message;
    say(s, s.message);
  }
}

// ---------------------------------------------------------------------------
// Proxy: the app with the "Señalar" script, embeddable in Trellai
// ---------------------------------------------------------------------------

const SCRIPT_PATH = "/__trellai/picker.js";
const SCRIPT_TAG = Buffer.from(`<script src="${SCRIPT_PATH}" defer></script>`);

/** The page with our script, before </head> (or </body>, or at the end). Works on the bytes: any charset. */
export function injectScript(html: Buffer): Buffer {
  const lower = html.toString("latin1").toLowerCase();
  if (lower.includes(SCRIPT_PATH)) return html;
  let at = lower.indexOf("</head>");
  if (at < 0) at = lower.indexOf("</body>");
  if (at < 0) at = html.length;
  return Buffer.concat([html.subarray(0, at), SCRIPT_TAG, html.subarray(at)]);
}

function decode(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(body);
    case "deflate":
      return zlib.inflateSync(body);
    case "br":
      return zlib.brotliDecompressSync(body);
    default:
      return body;
  }
}

function waitingPage(s: Server): string {
  const text = s.state === "error" ? (s.message ?? "La app se ha parado") : s.state === "installing" ? "Instalando dependencias…" : "Arrancando la app…";
  const esc = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1"><title>${esc}</title><body style="margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif;color:#888;background:#fafafa">${esc}</body>`;
}

/** The app answers on its own origin; pages, redirects and websockets must stay on the proxy's. */
function appOrigins(app: URL): string[] {
  const port = app.port ? `:${app.port}` : "";
  return [`${app.protocol}//localhost${port}`, `${app.protocol}//127.0.0.1${port}`, `${app.protocol}//[::1]${port}`];
}

function forwardHeaders(raw: string[], app: URL): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i];
    const lk = k.toLowerCase();
    let v = raw[i + 1];
    if (lk === "host") v = app.host;
    else if (lk === "accept-encoding") v = "identity";
    else if (lk === "origin") v = app.origin;
    else if (lk === "referer") v = v.replace(/^https?:\/\/[^/]+/i, app.origin);
    out.push([k, v]);
  }
  return out;
}

const ASSET_TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

/**
 * A font or image in the linked node_modules, asked for by its real path (`/@fs/C:/…`). Vite only
 * serves files inside the worktree and the link's real folder is outside it, so we serve those.
 */
function sharedAsset(s: Server, url: string): { file: string; type: string } | null {
  if (!s.shared || !url.startsWith("/@fs/")) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.slice("/@fs".length).split("?")[0]);
  } catch {
    return null;
  }
  const type = ASSET_TYPES[extname(path).toLowerCase()];
  if (!type) return null;
  try {
    const file = realpathSync(resolve(win && /^\/[a-z]:/i.test(path) ? path.slice(1) : path));
    const rel = relative(s.shared, file);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !statSync(file).isFile()) return null;
    return { file, type };
  } catch {
    return null;
  }
}

function handle(s: Server, req: http.IncomingMessage, res: http.ServerResponse) {
  s.lastUsed = Date.now();
  const asset = req.method === "GET" && req.url ? sharedAsset(s, req.url) : null;
  if (asset) {
    res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" });
    res.end(readFileSync(asset.file));
    return;
  }
  if (req.url?.split("?")[0] === SCRIPT_PATH) {
    let js = "";
    try {
      js = readFileSync(PICKER, "utf8");
    } catch (err) {
      js = `console.warn("Trellai: ${(err as Error).message.replace(/["\\]/g, "")}")`;
    }
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(js);
    return;
  }
  const app = s.app;
  if (!app || s.state !== "ready") {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(waitingPage(s));
    return;
  }
  const headers = forwardHeaders(req.rawHeaders, app);
  const up = http.request(
    { hostname: app.hostname.replace(/^\[|\]$/g, ""), port: app.port, method: req.method, path: req.url, headers: headers as unknown as http.OutgoingHttpHeaders },
    (r) => {
      const h: http.OutgoingHttpHeaders = { ...r.headers };
      // Embeddable in Trellai, and our script allowed.
      delete h["x-frame-options"];
      delete h["content-security-policy"];
      delete h["content-security-policy-report-only"];
      const host = req.headers.host;
      if (typeof h.location === "string" && host) {
        for (const o of appOrigins(app)) if (h.location.startsWith(o)) h.location = `http://${host}${h.location.slice(o.length)}`;
      }
      const html = String(r.headers["content-type"] ?? "").includes("text/html");
      if (!html || req.method === "HEAD" || r.statusCode === 304 || r.statusCode === 204) {
        res.writeHead(r.statusCode ?? 502, h);
        r.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      r.on("data", (d: Buffer) => chunks.push(d));
      r.on("end", () => {
        let body: Buffer = Buffer.concat(chunks);
        try {
          body = injectScript(decode(body, r.headers["content-encoding"]));
          delete h["content-encoding"];
        } catch {
          /* couldn't decode it: send it as it came */
        }
        delete h["transfer-encoding"];
        h["content-length"] = String(body.length);
        res.writeHead(r.statusCode ?? 200, h);
        res.end(body);
      });
      r.on("error", () => res.destroy());
    },
  );
  up.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`La app no responde: ${err.message}`);
  });
  req.pipe(up);
}

/** Websockets (vite's hot reload…) go straight through to the app. */
function upgrade(s: Server, req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  const app = s.app;
  if (!app) return socket.destroy();
  const up = net.connect({ host: app.hostname.replace(/^\[|\]$/g, ""), port: Number(app.port) || 80 });
  up.on("connect", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...forwardHeaders(req.rawHeaders, app).map(([k, v]) => `${k}: ${v}`)];
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
}

function createServer(cwd: string, command: string | null): Server {
  const proxy = http.createServer((req, res) => handle(s, req, res));
  const s: Server = {
    cwd,
    command,
    state: "stopped",
    message: null,
    log: [],
    partial: { out: "", err: "" },
    proc: null,
    app: null,
    printed: [],
    shared: null,
    proxy,
    proxyPort: new Promise((done, fail) => {
      proxy.once("error", fail);
      proxy.listen(0, BIND, () => done((proxy.address() as net.AddressInfo).port));
    }),
    lastUsed: Date.now(),
    run: 0,
  };
  proxy.on("upgrade", (req, socket, head) => upgrade(s, req, socket, head));
  s.proxyPort.catch(() => {});
  return s;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function start(s: Server, project: Project, command: string | null) {
  s.run++;
  s.command = command;
  s.state = "starting";
  s.message = null;
  s.app = null;
  s.printed = [];
  void boot(s, project, s.run);
}

function stop(s: Server) {
  s.run++;
  killTree(s.proc);
  s.proc = null;
  s.app = null;
  s.state = "stopped";
}

function dispose(key: string) {
  const s = servers.get(key);
  if (!s) return;
  stop(s);
  s.proxy.close();
  s.proxy.closeAllConnections();
  servers.delete(key);
}

/** Its worktree is about to be deleted. */
git.onRemoveWorktree((path) => dispose(keyOf(path)));

// Unused for a while: stop it (opening the Vista starts it again).
setInterval(() => {
  for (const [key, s] of servers) {
    if (Date.now() - s.lastUsed > IDLE_MS) {
      say(s, "Parada por no usarse.");
      dispose(key);
    }
  }
}, 60_000).unref();

process.on("exit", () => {
  for (const s of servers.values()) killTree(s.proc);
});

// ---------------------------------------------------------------------------
// Targets: a card's worktree, or the base branch
// ---------------------------------------------------------------------------

interface Target {
  project: Project;
  cardId: string | null;
  branch: string;
  /** null while there's nothing to run yet (see `waiting`) */
  cwd: string | null;
  waiting?: string;
}

/** The project's open "rama de retoques": what the base branch's Vista shows once there is one. */
export function openTouchup(projectId: string): Card | undefined {
  return db.listCards(projectId).find((c) => c.touchup && (c.column === "doing" || c.column === "review"));
}

function projectOf(projectId: string): Project {
  const project = db.getProject(projectId);
  if (!project) throw new Error("Proyecto no encontrado");
  if (!project.repo_path || !existsSync(project.repo_path)) throw new Error("Este proyecto no está en este ordenador.");
  return project;
}

function cardTarget(card: Card): Target {
  const project = projectOf(card.project_id);
  const base: Omit<Target, "cwd"> = { project, cardId: card.id, branch: card.branch ?? project.base_branch };
  if (card.machine && card.machine !== MACHINE) throw new Error(`Esta tarjeta se trabaja en ${card.machine}: su Vista se abre allí.`);
  if (card.worktree && existsSync(card.worktree)) return { ...base, cwd: card.worktree };
  if (card.column === "doing" && card.status === "error") throw new Error(`La tarjeta no ha podido preparar su rama: ${card.status_text}`);
  if (card.column === "doing") return { ...base, cwd: null, waiting: "Preparando la rama de la tarjeta…" };
  if (card.column === "merged") throw new Error("Esta tarjeta ya está mergeada: su cambio se ve en la Vista del proyecto.");
  throw new Error("Esta tarjeta todavía no tiene rama: se crea al pasar a Doing.");
}

const mainPath = (project: Project) => join(project.repo_path, ".trellai", "worktrees", MAIN_WORKTREE);
const lastFollow = new Map<string, number>();

/** `_vista` at the base branch: created the first time, then moved to the newest base commit when idle. */
async function mainTarget(project: Project, create: boolean): Promise<Target> {
  const cwd = mainPath(project);
  const target: Target = { project, cardId: null, branch: project.base_branch, cwd };
  if (!existsSync(cwd)) {
    if (!create) return target;
    await repoLock(project.repo_path, async () => {
      if (!existsSync(cwd)) git.addDetachedWorktree(project.repo_path, cwd, project.base_branch);
    });
    return target;
  }
  // Follow what's merged into the base branch (hot reload shows it); at most every few seconds.
  if (Date.now() - (lastFollow.get(cwd) ?? 0) > 4000) {
    lastFollow.set(cwd, Date.now());
    try {
      const want = git.shaOf(project.repo_path, `refs/heads/${project.base_branch}`);
      if (want && want !== git.shaOf(cwd, "HEAD") && !git.trackedDirty(cwd).length) git.checkoutDetached(cwd, want);
    } catch (err) {
      console.warn("[vista] no pude poner al día", cwd, (err as Error).message);
    }
  }
  return target;
}

async function resolveTarget(scope: { cardId: string } | { projectId: string }, create: boolean): Promise<Target> {
  if ("cardId" in scope) {
    const card = db.getCard(scope.cardId);
    if (!card) throw new Error("Tarjeta no encontrada");
    return cardTarget(card);
  }
  // The open rama de retoques, unless another computer is working on it (its branch isn't here).
  const touchup = openTouchup(scope.projectId);
  if (touchup && (!touchup.machine || touchup.machine === MACHINE)) return cardTarget(touchup);
  return mainTarget(projectOf(scope.projectId), create);
}

function statusOf(t: Target, s: Server | undefined, port: number | null): VistaStatus {
  return {
    cardId: t.cardId,
    branch: t.branch,
    state: t.waiting ? "waiting" : (s?.state ?? "stopped"),
    port,
    command: s?.command ?? commandFor(t.project, t.cwd && existsSync(t.cwd) ? t.cwd : t.project.repo_path),
    message: t.waiting ?? s?.message ?? null,
    log: s?.log.slice(-120) ?? [],
  };
}

export type VistaAction = "status" | "start" | "restart" | "stop";

/**
 * GET status (also keeps it alive while the Vista is open), or start / restart / stop it.
 * `start` does nothing if it's already running or failed (restart retries).
 */
export async function vista(scope: { cardId: string } | { projectId: string }, action: VistaAction = "status"): Promise<VistaStatus> {
  const t = await resolveTarget(scope, action === "start" || action === "restart");
  if (!t.cwd) return statusOf(t, undefined, null);
  const key = keyOf(t.cwd);
  let s = servers.get(key);
  if (action === "stop") {
    dispose(key);
    return statusOf(t, undefined, null);
  }
  if (!s && action === "status") return statusOf(t, undefined, null);
  if (!s) servers.set(key, (s = createServer(t.cwd, commandFor(t.project, t.cwd))));
  s.lastUsed = Date.now();
  if (action === "restart" || (action === "start" && s.state === "stopped")) {
    stop(s);
    start(s, t.project, commandFor(t.project, t.cwd));
  }
  return statusOf(t, s, await s.proxyPort);
}

/** The project goes away: its base-branch worktree too. */
export function removeMainWorktree(project: Project) {
  if (project.repo_path && existsSync(mainPath(project))) git.removeWorktree(project.repo_path, mainPath(project), null);
}
