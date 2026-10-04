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
