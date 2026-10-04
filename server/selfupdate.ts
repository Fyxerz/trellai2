/**
 * Trellai working on itself: when the branch in Trellai's own checkout changes ("Ver esta rama",
 * "Volver", a merge, a git checkout by hand…), pick up the new code without a manual restart.
 *
 * - UI changes: rebuild into the dist folder not being served, switch to it, and tell the
 *   browsers to reload. Nothing is interrupted.
 * - Server changes: under Maitre, exit with the code Maitre gave us (MAITRE_RESTART_CODE) and it
 *   starts Trellai again — but only once no agent or assistant is running, so nothing gets
 *   "Interrumpido al reiniciar el servidor". Without Maitre, the UI just says to restart by hand.
 *
 * Only in production (`npm start`); with `npm run dev`, vite and `tsx watch` already do this.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { runningCount } from "./agents.js";
import { assistantCount } from "./assistant.js";
import * as db from "./db.js";
import { emitAll } from "./events.js";
import { MACHINE } from "./machine.js";

/** Set by Maitre: exiting with it makes Maitre start us again. */
const RESTART_CODE = Number(process.env.MAITRE_RESTART_CODE) || null;
const POLL_MS = 1500;
const IDLE_MS = 5000;
const run = promisify(execFile);
const ROOT = process.cwd();

const WEB = [/^web\//, /^shared\//, /^vite\.config\.ts$/, /^package(-lock)?\.json$/];
const SERVER = [/^server\//, /^shared\//, /^package(-lock)?\.json$/];

const built = (dir: string) => (existsSync(`${dir}/index.html`) ? statSync(`${dir}/index.html`).mtimeMs : 0);
/** After a restart, keep serving the newest build (it may be the alternate folder). */
let dist = built("dist.alt") > built("dist") ? "dist.alt" : "dist";
let buildId = String(built(dist) || "dev");
let restartPending = false;

/** The folder the UI is served from (switches after each rebuild). */
export const distDir = () => dist;

export function buildInfo() {
  return { id: buildId, restartPending, autoRestart: RESTART_CODE !== null };
}

const git = async (args: string[]) => (await run("git", args, { cwd: ROOT, windowsHide: true })).stdout.trim();

async function rebuild() {
  const next = dist === "dist" ? "dist.alt" : "dist";
  console.log(`[trellai] Recompilando la interfaz…`);
  try {
    await run(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--outDir", `../${next}`, "--emptyOutDir"], {
      cwd: ROOT,
      windowsHide: true,
    });
  } catch (e) {
    console.error("[trellai] La interfaz no compila; sigo sirviendo la anterior.", (e as { stderr?: string }).stderr ?? e);
    return;
  }
  dist = next;
  buildId = String(built(dist));
  emitAll({ type: "build", id: buildId });
}

/** Nothing that a restart would cut: the cards it would mark "Interrumpido", agents, assistants. */
function busyNow() {
  const { n } = db.db
    .prepare("SELECT COUNT(*) AS n FROM cards WHERE status = 'running' AND (machine IS NULL OR machine = ?)")
    .get(MACHINE) as { n: number };
  return n > 0 || runningCount() > 0 || assistantCount() > 0;
}

/** Idle for a while, not just between two steps of the same card. */
let idleSince: number | null = null;
function idle() {
  if (busyNow()) idleSince = null;
  else idleSince ??= Date.now();
  return idleSince !== null && Date.now() - idleSince >= IDLE_MS;
}

export function startSelfUpdate() {
  if (process.env.NODE_ENV !== "production" || !existsSync(".git")) return;
  let head: string | null = null;
  let seen: string | null = null; // HEAD on the previous poll: act once it has settled
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = await git(["rev-parse", "HEAD"]);
      if (head === null) head = now;
      else if (now !== head && now === seen) {
        const files = (await git(["diff", "--name-only", head, now])).split("\n").filter(Boolean);
        console.log(`[trellai] El repo de Trellai ha cambiado (${head.slice(0, 7)} → ${now.slice(0, 7)}).`);
        head = now;
        if (files.some((f) => SERVER.some((r) => r.test(f)))) {
          restartPending = true;
          if (!RESTART_CODE) console.log("[trellai] Hay cambios del servidor: reinicia Trellai para cargarlos.");
          else if (busyNow()) console.log("[trellai] Hay cambios del servidor: reinicio cuando terminen los agentes.");
          emitAll({ type: "build", id: buildId });
        }
        if (files.some((f) => WEB.some((r) => r.test(f)))) await rebuild();
      }
      seen = now;
      if (restartPending && RESTART_CODE && idle()) {
        console.log("[trellai] Reiniciando para cargar el código nuevo del servidor…");
        process.exit(RESTART_CODE);
      }
    } catch {
      /* mid-checkout or not a repo right now: try again next time */
    } finally {
      busy = false;
    }
  };
  setInterval(tick, POLL_MS).unref();
  void tick();
}
