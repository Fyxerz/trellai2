/**
 * Codex engine with a simulated `codex`: images go attached with `-i`, and a crash without stderr still explains itself.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "trellai-codex-"));
const argsFile = join(dir, "args.json");
process.env.TRELLAI_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
process.env.CODEX_HOME = join(dir, "codex-home");
process.env.FAKE_CODEX_ARGS = argsFile;
process.env.FAKE_CODEX_DELAY = "0";

let engine: typeof import("../server/engine");
const img = join(dir, "1-pantalla.png");
writeFileSync(img, "png");

beforeAll(async () => {
  engine = await import("../server/engine");
});

const run = (prompt: string, extra: Partial<import("../server/engine").EngineRun> = {}) => {
  const texts: string[] = [];
  return engine
    .runEngine({
      model: "codex",
      cwd: dir,
      instructions: "Be brief.",
      prompt,
      access: "read",
      tools: [],
      signal: new AbortController().signal,
      onText: (t) => texts.push(t),
      onTool: () => {},
      ...extra,
    })
    .then((res) => ({ ...res, texts, args: JSON.parse(readFileSync(argsFile, "utf8")) as string[] }));
};

describe("codex engine", () => {
  it("attaches the images with -i and keeps the prompt intact after --", async () => {
    const res = await run("Mira la imagen", { images: [img, join(dir, "no-existe.png")] });
    expect(res.error).toBeUndefined();
    expect(res.sessionId).toBe("codex:fake-thread");
    const { args } = res;
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
    expect(args[args.indexOf("-i") + 1]).toBe(img);
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toMatch(/^<instructions>\nBe brief\.\n<\/instructions>\n\nMira la imagen$/);
  });

  it("attaches them when resuming too", async () => {
    const { args } = await run("Y esta otra", { images: [img], resume: "codex:abc" });
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args[args.indexOf("-i") + 1]).toBe(img);
    expect(args.slice(-3)).toEqual(["--", "abc", "Y esta otra"]);
  });

  it("sends no -i without images", async () => {
    const { args } = await run("Hola");
    expect(args).not.toContain("-i");
    expect(args.at(-1)).toContain("Hola");
  });

  it("explains a crash with nothing on stderr", async () => {
    const res = await run("DIE_SILENTLY");
    expect(res.error).toBe("codex terminó con código 15: Error: no se pudo abrir la imagen");
  });

  it("falls back to a readable reason", () => {
    expect(engine.codexExitError(15, null, "", [])).toMatch(/^codex terminó con código 15: Codex se cerró sin decir por qué; .*terminó/);
    expect(engine.codexExitError(1, null, "", [], "unsupported image")).toBe("codex terminó con código 1: unsupported image");
    expect(engine.codexExitError(1, null, "boom\n", ["ignored"])).toBe("codex terminó con código 1: boom");
  });
});

describe("codex logout", () => {
  it("runs `codex logout` and reports success", async () => {
    expect(await engine.logout("codex")).toEqual({ ok: true });
  });
});
