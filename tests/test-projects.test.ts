/**
 * Test servers never reach the real shared board, and the test projects that once leaked onto it go away.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

describe("test projects", () => {
  // A board whose database is not a temp file, like the real one.
  const dir = resolve("node_modules/.cache/trellai-test-projects");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.TRELLAI_DB = join(dir, "board.db");
  afterAll(async () => {
    (await import("../server/db")).db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the servers the tests start don't inherit the shared database", () => {
    expect(process.env.TRELLAI_DATABASE_URL).toBeUndefined();
    expect(process.env.TRELLAI_NO_DOTENV).toBe("1");
  });

  it("drops the projects made in the temp dir by tests, and only those", async () => {
    const db = await import("../server/db");
    const real = db.createProject({ name: "real", repo_path: "C:/Users/pedro/Documents/code/real", base_branch: "main" });
    const realCard = db.createCard({ project_id: real.id, title: "de verdad" });
    const leaked = db.createProject({ name: "mine", repo_path: join(tmpdir(), "trellai-autopull-abc123", "mine"), base_branch: "main" });
    const leakedCard = db.createCard({ project_id: leaked.id, title: "prueba" });
    const other = db.createProject({ name: "clon", repo_path: "C:/Users/otra/AppData/Local/Temp/trellai-clone-XyZ/repo", base_branch: "main" });
    const mine = db.createProject({ name: "tmp", repo_path: join(tmpdir(), "my-own-project"), base_branch: "main" });

    const sync = await import("../server/sync");
    expect(sync.isTestRepo(join(tmpdir(), "trellai-e2e-q1w2e3", "repo"))).toBe(true);
    expect(sync.isTestRepo("/private/var/folders/x/T/trellai-bg-abc/repo")).toBe(true);
    expect(sync.isTestRepo("C:/Users/pedro/Documents/code/trellai2")).toBe(false);
    sync.startSync();

    const ids = db.listProjects().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([real.id, mine.id]));
    expect(ids).not.toContain(leaked.id);
    expect(ids).not.toContain(other.id);
    expect(db.getCard(realCard.id)).toBeTruthy();
    expect(db.getCard(leakedCard.id)).toBeUndefined();
  });
});
