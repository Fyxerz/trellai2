import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { chatKeyDown } from "../web/src/ui";
import { api } from "../web/src/api";
import { registerDraft } from "../web/src/drafts";
import { projectName, readPreference } from "../web/src/preferences";

afterEach(() => vi.unstubAllGlobals());

function key(overrides: Record<string, unknown> = {}) {
  return { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
    nativeEvent: { isComposing: false }, preventDefault: vi.fn(), ...overrides } as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

describe("chat keyboard", () => {
  it("sends with Enter and preserves Shift+Enter for multiline messages", () => {
    const send = vi.fn(), enter = key(), newline = key({ shiftKey: true });
    chatKeyDown(enter, send); chatKeyDown(newline, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(newline.preventDefault).not.toHaveBeenCalled();
  });

  it("honors Ctrl/Cmd+Enter mode and keeps unmodified Enter as a newline", () => {
    vi.stubGlobal("localStorage", { getItem: () => "mod" });
    const send = vi.fn(), enter = key();
    chatKeyDown(enter, send);
    expect(send).not.toHaveBeenCalled();
    expect(enter.preventDefault).not.toHaveBeenCalled();
    chatKeyDown(key({ ctrlKey: true }), send); chatKeyDown(key({ metaKey: true }), send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not send during composition or repeat Enter, and suppresses repeat newlines", () => {
    const send = vi.fn(), repeat = key({ repeat: true });
    chatKeyDown(key({ nativeEvent: { isComposing: true } }), send);
    chatKeyDown(repeat, send);
    expect(send).not.toHaveBeenCalled();
    expect(repeat.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("persisting before workflow actions", () => {
  it.each(["move", "copy"])("waits for the specification before %s", async action => {
    let finish!: () => void;
    const saved = new Promise<void>(resolve => { finish = resolve; });
    const unregister = registerDraft("draft-card", () => saved);
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const request = api(`/api/cards/draft-card/${action}`, { column: "preparation" });
      await Promise.resolve();
      expect(fetcher).not.toHaveBeenCalled();
      finish(); await request;
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { unregister(); }
  });

  it("blocks a transition if saving fails, preserving the draft", async () => {
    const unregister = registerDraft("failed-card", async () => { throw new Error("Sin conexión"); });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    try {
      await expect(api("/api/cards/failed-card/move", { column: "doing" })).rejects.toThrow("Sin conexión");
      expect(fetcher).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it("recovers an empty local spec after reload before starting an agent", async () => {
    const removeItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => "", removeItem });
    const fetcher = vi.fn().mockImplementation(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    await api("/api/cards/reloaded-card/move", { column: "preparation" });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(["/api/cards/reloaded-card", "/api/cards/reloaded-card/move"]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ spec: "" });
    expect(removeItem).toHaveBeenCalledWith("trellai:spec-draft:reloaded-card");
  });
});

describe("preferences and project names", () => {
  it("preserves an explicitly empty draft instead of restoring the server value", () => {
    vi.stubGlobal("localStorage", { getItem: () => "" });
    expect(readPreference("spec-draft:card", "old spec")).toBe("");
  });
  it("extracts folder names with either Windows or Unix separators", () => {
    expect(projectName("C:\\Users\\pedro\\code\\trellai2")).toBe("trellai2");
    expect(projectName("/Users/pedro/code/trellai2/")).toBe("trellai2");
    expect(projectName("Mi proyecto")).toBe("Mi proyecto");
  });
});

describe("previewed card pinned on top", async () => {
  const { columnCards, storedIndex } = await import("../web/src/Board");
  const mk = (id: string, position: number) => ({ id, column: "doing", position }) as unknown as import("../shared/types").Card;
  const cards = Object.fromEntries([mk("a", 0), mk("b", 1), mk("p", 2), mk("c", 3)].map((c) => [c.id, c]));
  const ids = (l: { id: string }[]) => l.map((c) => c.id).join("");

  it("shows the previewed card first and the rest in stored order", () => {
    expect(ids(columnCards(cards, "doing", "p"))).toBe("pabc");
    expect(ids(columnCards(cards, "doing"))).toBe("abpc");
  });

  it("maps screen indexes to stored ones around the pinned card", () => {
    // screen without "c": p a b → drop c at screen 1 (before a) → stored before a
    expect(storedIndex(cards, "doing", "p", "c", 1)).toBe(0);
    expect(storedIndex(cards, "doing", "p", "c", 0)).toBe(0);
    // screen without "a": p b c → between b and c (index 2) → before c in b p c
    expect(storedIndex(cards, "doing", "p", "a", 2)).toBe(2);
    // at the end (index 3) → stored at the end
    expect(storedIndex(cards, "doing", "p", "a", 3)).toBe(3);
  });
});

describe("merging cards on top of merged", async () => {
  const { columnCards, mergedDays, storedIndex, MERGING } = await import("../web/src/Board");
  const mk = (id: string, day: number, status = "idle") =>
    ({ id, column: "merged", position: 0, status, merged_at: `2026-10-0${day}T12:00:00`, updated_at: "" }) as unknown as import("../shared/types").Card;
  const cards = Object.fromEntries([mk("a", 4), mk("b", 3), mk("m", 2, "running"), mk("c", 2), mk("n", 1, "running")].map((c) => [c.id, c]));
  const ids = (l: { id: string }[]) => l.map((c) => c.id).join("");

  it("shows every card being merged first, then the rest newest first", () => {
    expect(ids(columnCards(cards, "merged"))).toBe("mnabc");
    expect(mergedDays(columnCards(cards, "merged")).map((g) => g.day === MERGING ? `*${ids(g.cards)}` : ids(g.cards)).join(" ")).toBe("*mn a b c");
    // once the merge is over the card is back in its usual place
    expect(ids(columnCards({ ...cards, m: { ...cards.m, status: "idle" } }, "merged"))).toBe("nabmc");
  });

  it("drops next to the same neighbour", () => {
    // screen without "c": m n a b → before a (index 2)
    expect(storedIndex(cards, "merged", null, "c", 2)).toBe(2);
    expect(storedIndex(cards, "merged", null, "c", 4)).toBe(4);
  });
});
