/**
 * Claims and the agents' channel: who touches what, who hears what, and the cleanup when a card leaves Doing.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "trellai-claims-"));
process.env.TRELLAI_DB = join(dir, "t.db");
const repo = join(dir, "repo");
const sh = (cmd: string, cwd = repo) => execSync(cmd, { cwd, encoding: "utf8" }).trim();

let db: typeof import("../server/db");
let claims: typeof import("../server/claims");
let git: typeof import("../server/git");
let projectId: string;
let a: string;
let b: string;

beforeAll(async () => {
  db = await import("../server/db");
  claims = await import("../server/claims");
  git = await import("../server/git");
  sh(`mkdir -p ${repo} && cd ${repo} && git init -q -b main && git config user.email t@t && git config user.name t`, dir);
  writeFileSync(join(repo, "a.ts"), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  sh("git add -A && git commit -qm init");
  projectId = db.createProject({ name: "p", repo_path: repo, base_branch: "main" }).id;
  for (const title of ["Card A", "Card B"]) {
    const c = db.createCard({ project_id: projectId, title, column: "doing" });
    const wt = git.createWorktree(repo, "main", c.id, title);
    db.updateCard(c.id, { worktree: wt.path, branch: wt.branch });
    if (title === "Card A") a = c.id;
    else b = c.id;
  }
});

describe("claims", () => {
  it("claiming a file another agent holds warns only those two", () => {
    expect(claims.claimFiles(a, [{ file: "./a.ts", area: "foo()", purpose: "renombrar" }])).toMatch(/No other agent/);
    const out = claims.claimFiles(b, [{ file: "a.ts", area: "bar()", purpose: "añadir parámetro" }]);
    expect(out).toContain('"Card A" (foo() — renombrar)');
    const warn = db.liveNotes(projectId).filter((n) => n.content.startsWith("⚠️"));
    expect(warn).toHaveLength(1);
    expect(warn[0].targets.sort()).toEqual([a, b].sort());
    expect(warn[0].files).toEqual(["a.ts"]);
    // claiming again doesn't repeat the warning
    claims.claimFiles(b, [{ file: "a.ts", area: "bar()", purpose: "otra cosa" }]);
    expect(db.liveNotes(projectId).filter((n) => n.content.startsWith("⚠️"))).toHaveLength(1);
  });

  it("reads the changed lines from git and claims files changed without saying so", () => {
    const wa = db.getCard(a)!.worktree!;
    const lines = execSync("git show HEAD:a.ts", { cwd: wa, encoding: "utf8" }).split("\n");
    lines[2] = "changed 3";
    lines[3] = "changed 4";
    lines[14] = "changed 15";
    writeFileSync(join(wa, "a.ts"), lines.join("\n"));
    writeFileSync(join(wa, "new.ts"), "x\n");
    const card = claims.refreshClaims(db.getCard(a)!);
    expect(card.claims.find((c) => c.file === "a.ts")!.lines).toBe("3-4, 15");
    expect(card.claims.find((c) => c.file === "new.ts")).toMatchObject({ source: "auto", lines: "nuevo" });
  });

  it("each agent only gets notes about its files, addressed to it, or general", () => {
    db.addNote(projectId, a, "cambio la firma de foo()", { files: ["a.ts"] });
    db.addNote(projectId, a, "toco z.ts", { files: ["z.ts"] });
    db.addNote(projectId, null, "Pedro: no toquéis la config");
    const forB = claims.notesFor(db.getCard(b)!).map((n) => n.content);
    expect(forB).toContain("cambio la firma de foo()");
    expect(forB).toContain("Pedro: no toquéis la config");
    expect(forB.some((c) => c.startsWith("⚠️"))).toBe(true);
    expect(forB).not.toContain("toco z.ts");
    // nobody hears its own notes
    expect(claims.notesFor(db.getCard(a)!).map((n) => n.content)).not.toContain("cambio la firma de foo()");
  });

  it("the poller delivers each note once", () => {
    const p = claims.notePoller(b);
    expect(p.poll()).toContain("cambio la firma de foo()");
    expect(p.poll()).toBeNull();
    db.addNote(projectId, a, "otra sobre a.ts", { files: ["a.ts"] });
    expect(p.poll()).toContain("otra sobre a.ts");
  });

  it("releasing keeps the files already changed", () => {
    claims.claimFiles(a, [{ file: "unused.ts", purpose: "por si acaso" }]);
    const out = claims.releaseFiles(a, ["unused.ts", "a.ts"]);
    expect(out).toContain("Released: unused.ts");
    expect(out).toContain("Still claimed");
    expect(db.getCard(a)!.claims.map((c) => c.file).sort()).toEqual(["a.ts", "new.ts"]);
  });

  it("leaving Doing clears its claims and archives its notes; general notes go when nobody is working", () => {
    db.placeCard(a, "review", 0);
    claims.sweep(projectId);
    expect(db.getCard(a)!.claims).toEqual([]);
    const live = db.liveNotes(projectId).map((n) => n.content);
    expect(live.some((c) => c.includes("foo()"))).toBe(false); // A's notes, and the A/B warning
    expect(live).toEqual(["Pedro: no toquéis la config"]);
    expect(db.listNotes(projectId).some((n) => n.archived && n.content === "toco z.ts")).toBe(true); // kept as history
    expect(db.getCard(b)!.claims.length).toBeGreaterThan(0);

    db.placeCard(b, "review", 0);
    claims.sweep(projectId);
    expect(db.liveNotes(projectId)).toEqual([]);
  });
});

describe("what an agent hears about the others (it's re-read on every call, so it stays short)", () => {
  let mine: string;
  const doing = (title: string, files: string[], status?: import("../shared/types").CardStatus) => {
    const c = db.createCard({ project_id: projectId, title, column: "doing" });
    db.updateCard(c.id, { claims: files.map((file) => ({ file, area: "algo()", purpose: "cambiarlo", lines: "", source: "agent" as const })), status });
    return c.id;
  };
  beforeAll(() => {
    mine = doing("Mía", ["a.ts"]);
    doing("Comparte", ["a.ts", "b.ts"]);
    doing("Otra", ["z.ts"]);
    doing("Rota", ["a.ts"], "error");
    doing("Sin nada", []);
  });

  it("details only the cards on my files; the rest is one line; cards in error or idle without files are left out", () => {
    const out = claims.othersWork(db.getCard(mine)!);
    expect(out).toContain('- "Comparte"');
    expect(out).toContain("a.ts: algo() — cambiarlo ⚠️ you're on it too");
    expect(out).not.toContain("b.ts");
    expect(out).not.toContain("Otra");
    expect(out).not.toContain("Rota");
    expect(out).not.toContain("Sin nada");
    expect(out).toContain("- 1 other card in Doing doesn't touch your files.");
  });

  it("with no files of its own yet: just who is on which files", () => {
    const out = claims.othersWork(db.getCard(doing("Nueva", []))!);
    expect(out.split("\n")).toEqual(['- "Mía": a.ts', '- "Comparte": a.ts, b.ts', '- "Otra": z.ts']);
  });

  it("claim_files leaves the cards in error out too", () => {
    const out = claims.claimFiles(mine, [{ file: "a.ts", area: "foo()" }]);
    expect(out).toContain('"Comparte"');
    expect(out).not.toContain("Rota");
  });

  it("injected notes are cut short, capped per injection and never repeated", () => {
    const p = claims.notePoller(mine);
    p.poll(); // what was there already
    db.addNote(projectId, null, `Pedro: ${"x".repeat(2000)}`);
    const one = p.poll()!;
    expect(one.length).toBeLessThan(600);
    expect(one).toContain("read_notes has them in full");
    db.addNote(projectId, null, `Pedro: ${"x".repeat(2000)}`); // the same text again
    expect(p.poll()).toBeNull();
    for (let i = 0; i < 20; i++) db.addNote(projectId, null, `nota ${i} ${"y".repeat(380)}`);
    const many = p.poll()!;
    expect(many.length).toBeLessThan(3600);
    expect(many).toMatch(/- 1\d more new notes: use read_notes to see them in full\./);
    expect(p.poll()).toBeNull();
  });
});
