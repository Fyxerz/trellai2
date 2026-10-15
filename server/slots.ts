/**
 * Agent slots: at most `max_agents` card agents (preparation, development, conflicts) run at once per
 * project on this computer. The rest wait «En cola» in arrival order and start by themselves when one
 * finishes. When an engine says the account hit its session / usage limit, nobody else on that engine
 * is launched until the limit resets (when it said when) or Pedro presses Reintentar.
 */
import { DEFAULT_MAX_AGENTS } from "../shared/types.js";
import * as db from "./db.js";
import type { Engine } from "./engine.js";

interface Waiter {
  cardId: string;
  projectId: string;
  engine: Engine;
  onWait: (text: string, why: "full" | "limit") => void;
  /** last text shown, to only call onWait when it changes */
  shown: string;
  start: (ok: boolean) => void;
}

/** project → cards whose agent holds a slot */
const active = new Map<string, Set<string>>();
let line: Waiter[] = [];
const pauses = new Map<Engine, { until: number | null; timer?: NodeJS.Timeout }>();

export function maxAgents(projectId: string): number {
  const n = db.getProject(projectId)?.max_agents;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_AGENTS;
}

const ENGINE_NAME: Record<Engine, string> = { claude: "Claude", codex: "Codex" };
export const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

function show(w: Waiter) {
  const p = pauses.get(w.engine);
  const text = p
    ? `En cola — límite de ${ENGINE_NAME[w.engine]} alcanzado (${p.until ? `sigue sola a las ${hhmm(p.until)}` : "pulsa Reintentar para seguir"})`
    : `En cola (posición ${line.filter((x) => x.projectId === w.projectId).indexOf(w) + 1})`;
  if (text === w.shown) return;
  w.shown = text;
  w.onWait(text, p ? "limit" : "full");
}

function refresh() {
  for (const w of line) show(w);
}

/** Start whoever fits in the project's free slots, in order (a paused engine's cards stay in line). */
export function pump(projectId: string) {
  const slots = active.get(projectId) ?? new Set<string>();
  active.set(projectId, slots);
  const max = maxAgents(projectId);
  for (const w of line.filter((x) => x.projectId === projectId)) {
    if (slots.size >= max) break;
    if (pauses.has(w.engine)) continue;
    line = line.filter((x) => x !== w);
    slots.add(w.cardId);
    w.start(true);
  }
  refresh();
}

/**
 * Wait for a slot; `first` waits at the head of the line (work that was already under way). Resolves
 * true when the agent may start (call release() when it ends), false if `signal` aborts first.
 */
export function acquire(o: {
  cardId: string;
  projectId: string;
  engine: Engine;
  signal: AbortSignal;
  first?: boolean;
  onWait: Waiter["onWait"];
}): Promise<boolean> {
  if (o.signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      if (!line.includes(w)) return;
      line = line.filter((x) => x !== w);
      w.start(false);
      refresh();
    };
    const w: Waiter = {
      cardId: o.cardId,
      projectId: o.projectId,
      engine: o.engine,
      onWait: o.onWait,
      shown: "",
      start: (ok) => {
        o.signal.removeEventListener("abort", onAbort);
        resolve(ok);
      },
    };
    o.signal.addEventListener("abort", onAbort);
    if (o.first) line.unshift(w);
    else line.push(w);
    pump(o.projectId);
  });
}

export function release(projectId: string, cardId: string) {
  active.get(projectId)?.delete(cardId);
  pump(projectId);
}

export function isQueued(cardId: string): boolean {
  return line.some((w) => w.cardId === cardId);
}

/** Cards waiting in this project's line. */
export function queued(projectId: string): number {
  return line.filter((w) => w.projectId === projectId).length;
}

export function pausedUntil(engine: Engine): { until: number | null } | null {
  const p = pauses.get(engine);
  return p ? { until: p.until } : null;
}

/** The engine hit the account's limit: launch nobody else on it until `resetsAt` (ms; null = until resume()). */
export function pause(engine: Engine, resetsAt: number | null) {
  clearTimeout(pauses.get(engine)?.timer);
  const until = resetsAt && resetsAt > Date.now() ? resetsAt : null;
  // a minute of margin: the limit resets on the server's clock
  const timer = until ? setTimeout(() => resume(engine), Math.min(until - Date.now() + 60_000, 2 ** 31 - 1)) : undefined;
  timer?.unref?.();
  pauses.set(engine, { until, timer });
  refresh();
}

/** Launch again (Reintentar, the reset time came, or an agent on that engine just worked). */
export function resume(engine?: Engine) {
  for (const e of engine ? [engine] : ([...pauses.keys()] as Engine[])) {
    clearTimeout(pauses.get(e)?.timer);
    pauses.delete(e);
  }
  for (const projectId of new Set(line.map((w) => w.projectId))) pump(projectId);
}
