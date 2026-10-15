/**
 * What agents spend and how many run at once: tokens added up per run (a resumed Claude session reports its
 * earlier runs too), the line of agents waiting for a slot, and the pause when the usage limit is hit.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "trellai-usage-"));
process.env.TRELLAI_DB = join(dir, "t.db");

let db: typeof import("../server/db");
let usage: typeof import("../server/usage");
let engine: typeof import("../server/engine");
let slots: typeof import("../server/slots");
let projectId: string;
let cardId: string;

beforeAll(async () => {
  db = await import("../server/db");
  usage = await import("../server/usage");
  engine = await import("../server/engine");
  slots = await import("../server/slots");
  projectId = db.createProject({ name: "p", repo_path: dir, base_branch: "main" }).id;
  cardId = db.createCard({ project_id: projectId, title: "Gasto", column: "doing" }).id;
});

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("usage", () => {
  it("a resumed Claude session only counts what the new run added", () => {
    const record = (resume: string | null, totals: import("../shared/types").Usage) =>
      usage.recordUsage({ projectId, cardId, kind: "dev", model: "claude-opus-5-5", resume, result: { sessionId: "s1", usage: { totals, cumulative: true } } });
    const first = { input: 100, output: 50, cache_read: 1000, cache_write: 200, cost_usd: 0.5 };
    expect(record(null, first)).toEqual(first);
    const second = record("s1", { input: 150, output: 80, cache_read: 3000, cache_write: 300, cost_usd: 0.9 })!;
    expect(second).toMatchObject({ input: 50, output: 30, cache_read: 2000, cache_write: 100 });
    expect(second.cost_usd).toBeCloseTo(0.4);
    const card = db.getCard(cardId)!;
    expect(card.tokens).toBe(150 + 80 + 3000 + 300);
    expect(card.tokens_cache).toBe(3000);
    // a transcript that didn't keep its totals starts again from zero: the whole report is new
    expect(record("s1", { input: 10, output: 5, cache_read: 20, cache_write: 0, cost_usd: 0.01 })).toMatchObject({ input: 10, cache_read: 20 });
    // nothing reported, nothing recorded
    expect(usage.recordUsage({ projectId, cardId, kind: "dev", model: null, resume: null, result: { sessionId: null } })).toBeNull();
  });

  it("the project's total includes the assistant and deleted cards", () => {
    usage.recordUsage({
      projectId,
      cardId: null,
      kind: "plan",
      model: "claude",
      resume: null,
      result: { sessionId: "a1", usage: { totals: { input: 1, output: 1, cache_read: 0, cache_write: 0, cost_usd: 0 }, cumulative: false } },
    });
    db.deleteCard(cardId);
    const u = db.projectUsage(projectId);
    expect(u.runs).toBe(4);
    expect(u.assistant).toMatchObject({ input: 1, output: 1 });
    expect(u.cards.cache_read).toBe(3020);
    expect(u.total.input).toBe(161);
    expect(u.today.input).toBe(161);
  });

  it("knows a usage limit, and when it resets", () => {
    const now = new Date(2026, 9, 15, 10, 0).getTime();
    expect(engine.isLimitError("You've hit your session limit · resets 3pm (Europe/Madrid)")).toBe(true);
    expect(engine.isLimitError("Claude AI usage limit reached|1760000000")).toBe(true);
    expect(engine.isLimitError("spawn claude ENOENT")).toBe(false);
    expect(engine.parseResetTime("You've hit your session limit · resets 3pm (Europe/Madrid)", now)).toBe(new Date(2026, 9, 15, 15, 0).getTime());
    expect(engine.parseResetTime("resets at 9:30am", now)).toBe(new Date(2026, 9, 16, 9, 30).getTime()); // tomorrow
    expect(engine.parseResetTime("Claude AI usage limit reached|1760000000", now)).toBe(1_760_000_000_000);
    expect(engine.parseResetTime("límite sin hora", now)).toBeNull();
  });
});

describe("agent slots", () => {
  it("first come first served per project; `first` jumps the line; a pause holds the engine until resumed", async () => {
    db.updateProject(projectId, { max_agents: 1 });
    const texts: Record<string, string> = {};
    const started: string[] = [];
    const wait = (id: string, signal = new AbortController().signal, first = false) =>
      slots
        .acquire({ cardId: id, projectId, engine: "claude", signal, first, onWait: (t) => (texts[id] = t) })
        .then((ok) => void started.push(`${id}:${ok}`));

    await wait("a");
    const stopC = new AbortController();
    const b = wait("b");
    const c = wait("c", stopC.signal);
    const d = wait("d", undefined, true); // e.g. a conflict of a card that was already running
    expect(started).toEqual(["a:true"]);
    expect(texts).toEqual({ b: "En cola (posición 2)", c: "En cola (posición 3)", d: "En cola (posición 1)" });
    expect(slots.queued(projectId)).toBe(3);

    stopC.abort(); // Parar while it waits
    await c;
    expect(started).toEqual(["a:true", "c:false"]);
    expect(texts.b).toBe("En cola (posición 2)");

    slots.release(projectId, "a");
    await d;
    expect(started.at(-1)).toBe("d:true");
    expect(texts.b).toBe("En cola (posición 1)");

    slots.pause("claude", null);
    expect(texts.b).toBe("En cola — límite de Claude alcanzado (pulsa Reintentar para seguir)");
    slots.release(projectId, "d");
    await tick();
    expect(started.at(-1)).toBe("d:true"); // b still waits

    slots.resume();
    await b;
    expect(started.at(-1)).toBe("b:true");
    slots.release(projectId, "b");
    expect(slots.queued(projectId)).toBe(0);
  });

  it("raising the limit lets more in at once", async () => {
    db.updateProject(projectId, { max_agents: 1 });
    const signal = new AbortController().signal;
    const onWait = () => {};
    await slots.acquire({ cardId: "x", projectId, engine: "claude", signal, onWait });
    let yStarted = false;
    const y = slots.acquire({ cardId: "y", projectId, engine: "claude", signal, onWait }).then(() => (yStarted = true));
    await tick();
    expect(yStarted).toBe(false);
    db.updateProject(projectId, { max_agents: 2 });
    slots.pump(projectId);
    await y;
    expect(yStarted).toBe(true);
    slots.release(projectId, "x");
    slots.release(projectId, "y");
  });
});
