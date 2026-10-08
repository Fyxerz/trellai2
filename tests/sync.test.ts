/**
 * Two computers sharing one board through Postgres, and one GitHub-like remote.
 * Needs a Postgres to talk to: TRELLAI_TEST_PG=postgres://user@127.0.0.1:5432/postgres npm test
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Card, Project } from "../shared/types";

const PG = process.env.TRELLAI_TEST_PG;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf8" }).trim();

interface Machine {
  name: string;
  url: string;
  proc: ChildProcess;
}

async function start(name: string, dir: string, dbUrl: string, delay: number): Promise<Machine> {
  const port = 4900 + Math.floor(Math.random() * 900);
  const proc = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      TRELLAI_DB: join(dir, `${name}.db`),
      TRELLAI_FAKE_AGENT: "1",
      TRELLAI_FAKE_DELAY: String(delay),
      TRELLAI_MACHINE: name,
      TRELLAI_DATABASE_URL: dbUrl,
      TRELLAI_SYNC_MS: "250",
      TRELLAI_NO_DOTENV: "1",
      TRELLAI_GUESS_REPOS: "0", // both "computers" share this disk
    },
    stdio: "pipe",
  });
  proc.stderr?.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url + "/api/projects");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { name, url, proc };
}

async function api<T = any>(m: Machine, path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
  const r = await fetch(m.url + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error);
  return json as T;
}

async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 10000): Promise<T> {
  const t0 = Date.now();
  let v = await fn();
  while (!pred(v)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout; last value: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 100));
    v = await fn();
  }
  return v;
}

describe.skipIf(!PG)("two computers", { timeout: 40000 }, () => {
  let A: Machine, B: Machine;
  let dir: string, origin: string, repoA: string, repoB: string, other: string;
  let projectId: string;
  let dbName: string;
  const cardOn = (m: Machine, id: string) => async () =>
    (await api<Card[]>(m, `/api/projects/${projectId}/cards`)).find((c) => c.id === id);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "trellai-sync-"));
    origin = join(dir, "origin.git");
    repoA = join(dir, "a", "repo");
    repoB = join(dir, "b", "repo");
    other = join(dir, "other");
    sh(`git init -q --bare -b main ${origin}`, dir);
    sh(`git clone -q ${origin} ${repoA}`, dir);
    sh(`git config user.email t@t && git config user.name t`, repoA);
    writeFileSync(join(repoA, "README.md"), "# hola\n");
    sh("git add -A && git commit -qm init && git push -q origin main", repoA);

    dbName = `trellai_test_${Date.now()}`;
    const admin = postgres(PG!, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const dbUrl = PG!.replace(/\/[^/]*$/, `/${dbName}`);
    A = await start("mac-casa", dir, dbUrl, 400);
    B = await start("mac-oficina", dir, dbUrl, 60);
  }, 30000);

  afterAll(async () => {
    A?.proc.kill();
    B?.proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    const admin = postgres(PG!, { onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end();
  });

  it("a project made on one computer shows up on the other, which clones it", async () => {
    const p = await api<Project>(A, "/api/projects", { repo_path: repoA });
    projectId = p.id;
    expect(p.remote_url).toBe(origin);
    const onB = await until(() => api<Project[]>(B, "/api/projects"), (ps) => ps.some((x) => x.id === projectId));
    expect(onB.find((x) => x.id === projectId)!.repo_path).toBe(""); // not on this computer yet
    const linked = await api<Project>(B, `/api/projects/${projectId}/clone`, { dest: repoB });
    expect(linked.repo_path).toBe(repoB);
    expect(existsSync(join(repoB, "README.md"))).toBe(true);
    // the repo path stays local
    expect((await api<Project[]>(A, "/api/projects")).find((x) => x.id === projectId)!.repo_path).toBe(repoA);
    expect((await api<any>(B, "/api/sync")).ok).toBe(true);
  });

  it("work done on A is visible on B and its branch is pushed", async () => {
    const c = await api<Card>(A, "/api/cards", { project_id: projectId, title: "Pantalla de inicio", spec: "x", column: "plan" });
    await api(A, `/api/cards/${c.id}/checkpoints`, { text: "Hacer la pantalla" });
    await api(A, `/api/cards/${c.id}/move`, { column: "doing" });
    const done = await until(cardOn(B, c.id), (x) => x?.column === "review" && x.status === "idle", 15000);
    expect(done!.machine).toBe("mac-casa");
    expect(done!.checkpoints_done).toBe(done!.checkpoints_total);
    const msgs = await api<any[]>(B, `/api/cards/${c.id}/messages`);
    expect(msgs.some((m) => m.content.startsWith("📌 Commit"))).toBe(true);
    await until(async () => sh("git branch --list 'trellai/*'", origin), (b) => b.includes(done!.branch!));
    // B can see the diff without a worktree
    const diff = await api<any>(B, `/api/cards/${c.id}/diff`);
    expect(diff.files).toContain("features/pantalla-de-inicio.md");
  });

  it("B merges A's card: pulls first, pushes after, A cleans up", async () => {
    // Someone pushed to main from a third place in the meantime.
    sh(`git clone -q ${origin} ${other}`, dir);
    sh(`git config user.email t@t && git config user.name t && echo x > OTHER.md && git add -A && git commit -qm "desde otro sitio" && git push -q origin main`, other);

    const c = (await api<Card[]>(B, `/api/projects/${projectId}/cards`)).find((x) => x.column === "review")!;
    const worktreeA = (await cardOn(A, c.id)())!.worktree!;
    expect(existsSync(worktreeA)).toBe(true);
    await api(B, `/api/cards/${c.id}/move`, { column: "merged" });
    const merged = await until(cardOn(B, c.id), (x) => x?.status_text.startsWith("Merge ") ?? false, 15000);
    expect(merged!.status).toBe("idle");
    const log = sh("git log --format=%s main", origin);
    expect(log).toContain('Merge "Pantalla de inicio" (trellai)');
    expect(log).toContain("desde otro sitio");
    expect(sh("git ls-tree -r --name-only main", origin)).toContain("features/pantalla-de-inicio.md");
    await until(async () => sh("git branch --list 'trellai/*'", origin), (b) => b === "");
    // A sees it merged and drops its worktree
    await until(cardOn(A, c.id), (x) => x?.column === "merged");
    await until(async () => existsSync(worktreeA), (e) => !e);
  });

  it("A starts from what's on GitHub (pull before work)", async () => {
    const c = await api<Card>(A, "/api/cards", { project_id: projectId, title: "Ajustes", spec: "x", column: "plan" });
    await api(A, `/api/cards/${c.id}/move`, { column: "doing" });
    const r = await until(cardOn(A, c.id), (x) => x?.column === "review" && x.status === "idle", 15000);
    const files = sh(`git ls-tree -r --name-only ${r!.branch}`, repoA);
    expect(files).toContain("OTHER.md"); // brought in from origin before branching
    expect(files).toContain("features/pantalla-de-inicio.md"); // B's merge
    expect(sh("git log -1 --format=%s main", repoA)).toContain("Merge");
  });

  it("B can stop A's agent and take the card over", async () => {
    const c = await api<Card>(A, "/api/cards", { project_id: projectId, title: "Perfil", spec: "x", column: "plan" });
    for (const t of ["Uno", "Dos", "Tres", "Cuatro"]) await api(A, `/api/cards/${c.id}/checkpoints`, { text: t });
    await api(A, `/api/cards/${c.id}/move`, { column: "doing" });
    await until(cardOn(B, c.id), (x) => x?.status === "running" && x.machine === "mac-casa" && !!x.branch);
    // moving it from B while A works is refused
    await expect(api(B, `/api/cards/${c.id}/move`, { column: "plan" })).rejects.toThrow(/mac-casa/);
    await api(B, `/api/cards/${c.id}/stop`, {});
    await until(cardOn(B, c.id), (x) => x?.status === "idle" && x.status_text === "Detenido");
    await api(B, `/api/cards/${c.id}/retry`, {});
    const done = await until(cardOn(A, c.id), (x) => x?.column === "review" && x.status === "idle" && x.machine === "mac-oficina", 15000);
    const msgs = await api<any[]>(A, `/api/cards/${c.id}/messages`);
    expect(msgs.some((m) => m.content.includes("Sigo con esta tarjeta en mac-oficina"))).toBe(true);
    // B's worktree has A's commits
    expect(sh(`git log --format=%s ${done!.branch}`, repoB)).toContain("Perfil (wip)"); // what A had when it stopped
  });

  it("deleting a card on one computer removes it everywhere", async () => {
    const c = (await api<Card[]>(A, `/api/projects/${projectId}/cards`)).find((x) => x.title === "Ajustes")!;
    const wt = (await cardOn(A, c.id)())!.worktree!;
    expect(existsSync(wt)).toBe(true);
    await api(B, `/api/cards/${c.id}`, undefined, "DELETE");
    await until(cardOn(A, c.id), (x) => !x);
    await until(async () => existsSync(wt), (e) => !e);
    await until(async () => sh("git branch --list 'trellai/ajustes*'", origin), (b) => b === "");
  });
});

describe.skipIf(!PG)("moving TRELLAI_DATABASE_URL to another database", { timeout: 40000 }, () => {
  let dir: string, repo: string;
  const dbs = [`trellai_old_${Date.now()}`, `trellai_new_${Date.now()}`];
  const urlOf = (name: string) => PG!.replace(/\/[^/]*$/, `/${name}`);
  let M: Machine | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "trellai-move-"));
    const origin = join(dir, "origin.git");
    repo = join(dir, "repo");
    sh(`git init -q --bare -b main ${origin}`, dir);
    sh(`git clone -q ${origin} ${repo}`, dir);
    sh(`git config user.email t@t && git config user.name t`, repo);
    writeFileSync(join(repo, "README.md"), "# hola\n");
    sh("git add -A && git commit -qm init && git push -q origin main", repo);
    const admin = postgres(PG!, { onnotice: () => {} });
    for (const d of dbs) await admin.unsafe(`CREATE DATABASE ${d}`);
    await admin.end();
  }, 30000);

  afterAll(async () => {
    M?.proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    const admin = postgres(PG!, { onnotice: () => {} });
    for (const d of dbs) await admin.unsafe(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
    await admin.end();
  });

  it("uploads the whole board to the new database, not just new changes", async () => {
    M = await start("mac-casa", dir, urlOf(dbs[0]), 60);
    const p = await api<Project>(M, "/api/projects", { repo_path: repo });
    const c = await api<Card>(M, "/api/cards", { project_id: p.id, title: "Vieja", spec: "x", column: "plan" });
    await until(() => api<any>(M!, "/api/sync"), (s) => s.ok && s.pending === 0);
    M.proc.kill();
    await new Promise((r) => setTimeout(r, 300));

    M = await start("mac-casa", dir, urlOf(dbs[1]), 60);
    const fresh = postgres(urlOf(dbs[1]), { onnotice: () => {} });
    try {
      const keys = await until(
        async () => {
          try {
            return (await fresh.unsafe(`SELECT tbl, key FROM trellai.rows`)).map((r) => `${r.tbl}:${r.key}`);
          } catch {
            return [] as string[]; // schema not created yet
          }
        },
        (k) => k.includes(`projects:${p.id}`) && k.includes(`cards:${c.id}`),
      );
      expect(keys).toContain(`cards:${c.id}`);
      // and it keeps pulling from the new one (its cursor started over)
      await fresh.unsafe(
        `INSERT INTO trellai.rows (tbl, key, data, origin, project) SELECT 'cards', 'otra', replace(replace(data, '${c.id}', 'otra'), 'Vieja', 'Desde fuera'), 'otro~1', project FROM trellai.rows WHERE tbl = 'cards' AND key = '${c.id}'`,
      );
      await until(() => api<Card[]>(M!, `/api/projects/${p.id}/cards`), (cs) => cs.some((x) => x.title === "Desde fuera"));
    } finally {
      await fresh.end();
    }
  });
});
