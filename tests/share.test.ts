/**
 * Two people sharing one project with an invitation code; their other projects stay private.
 * Needs a Postgres to talk to: TRELLAI_TEST_PG=postgres://user@127.0.0.1:5432/postgres npm test
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Card, Note, Person, Project, Sharing } from "../shared/types";

const PG = process.env.TRELLAI_TEST_PG;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf8" }).trim();

interface Machine {
  name: string;
  url: string;
  proc: ChildProcess;
}

async function start(name: string, dir: string, dbUrl: string | null): Promise<Machine> {
  const port = 4900 + Math.floor(Math.random() * 900);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    TRELLAI_DB: join(dir, `${name}.db`),
    TRELLAI_FAKE_AGENT: "1",
    TRELLAI_MACHINE: name,
    TRELLAI_SYNC_MS: "250",
    TRELLAI_NO_DOTENV: "1",
    TRELLAI_GUESS_REPOS: "0",
    TRELLAI_AUTOSHARE_ANY: "1", // local bare repos count as private GitHub ones
  };
  delete env.TRELLAI_DATABASE_URL;
  if (dbUrl) env.TRELLAI_DATABASE_URL = dbUrl;
  const proc = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { env, stdio: "pipe" });
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

function repo(dir: string, name: string): { origin: string; path: string } {
  const origin = join(dir, `${name}.git`);
  const path = join(dir, name);
  sh(`git init -q --bare -b main ${origin}`, dir);
  sh(`git clone -q ${origin} ${path}`, dir);
  sh(`git config user.email t@t && git config user.name t`, path);
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  sh("git add -A && git commit -qm init && git push -q origin main", path);
  return { origin, path };
}

describe.skipIf(!PG)("sharing a project with someone else", { timeout: 60000 }, () => {
  let pedro: Machine, ana: Machine;
  let dbName: string, dbUrl: string, dir: string;
  let shared: Project, mine: Project, hers: Project;
  let pedroId: string, anaId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "trellai-share-"));
    dbName = `trellai_share_${Date.now()}`;
    const admin = postgres(PG!, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    dbUrl = PG!.replace(/\/[^/]*$/, `/${dbName}`);
    pedro = await start("portatil-pedro", dir, dbUrl); // his computers share dbUrl
    ana = await start("portatil-ana", dir, null); // no database of her own

    pedroId = (await api<Person>(pedro, "/api/me", { name: "Pedro", color: "#60a5fa" })).id;
    anaId = (await api<Person>(ana, "/api/me", { name: "Ana", color: "#f472b6" })).id;
    shared = await api<Project>(pedro, "/api/projects", { repo_path: repo(dir, "juntos").path });
    mine = await api<Project>(pedro, "/api/projects", { repo_path: repo(dir, "privado").path });
    hers = await api<Project>(ana, "/api/projects", { repo_path: repo(dir, "suyo").path });
  }, 30000);

  afterAll(async () => {
    pedro?.proc.kill();
    ana?.proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    const admin = postgres(PG!, { onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end();
  });

  it("an invitation brings only that project, with its cards", async () => {
    const before = await api<Card>(pedro, "/api/cards", { project_id: shared.id, title: "Ya estaba", column: "backlog" });
    await api<Card>(pedro, "/api/cards", { project_id: mine.id, title: "Secreto", column: "backlog" });
    const { code } = await api<{ code: string }>(pedro, `/api/projects/${shared.id}/invite`, {});
    expect(code.startsWith("trellai1.")).toBe(true);

    const joined = await api<Project>(ana, "/api/shares", { code });
    expect(joined.id).toBe(shared.id);
    const anaProjects = await api<Project[]>(ana, "/api/projects");
    expect(anaProjects.map((p) => p.id).sort()).toEqual([shared.id, hers.id].sort());
    const cards = await until(() => api<Card[]>(ana, `/api/projects/${shared.id}/cards`), (cs) => cs.length > 0);
    expect(cards.find((c) => c.id === before.id)?.author).toBe(pedroId);
    expect(await api<Card[]>(ana, `/api/projects/${mine.id}/cards`)).toEqual([]);
  });

  it("each side sees who wrote what", async () => {
    const c = await api<Card>(ana, "/api/cards", { project_id: shared.id, title: "De Ana", column: "backlog" });
    const onPedro = await until(
      () => api<Card[]>(pedro, `/api/projects/${shared.id}/cards`),
      (cs) => cs.some((x) => x.id === c.id),
    );
    expect(onPedro.find((x) => x.id === c.id)!.author).toBe(anaId);
    const people = await until(
      () => api<{ people: Person[] }>(pedro, "/api/people"),
      (r) => r.people.some((p) => p.id === anaId),
    );
    expect(people.people.find((p) => p.id === anaId)!.machines).toContain("portatil-ana");

    await api(pedro, `/api/projects/${shared.id}/notes`, { content: "toco el login" });
    const notes = await until(
      () => api<Note[]>(ana, `/api/projects/${shared.id}/notes`),
      (ns) => ns.some((n) => n.content.includes("toco el login")),
    );
    expect(notes.find((n) => n.content.includes("toco el login"))!.author).toBe(pedroId);

    const sharing = await api<Sharing>(pedro, `/api/projects/${shared.id}/sharing`);
    expect(sharing.members.filter((m) => !m.left_at).map((m) => m.person_id).sort()).toEqual([pedroId, anaId].sort());
  });

  it("Ana's own projects never reach the shared database", async () => {
    await api<Card>(ana, "/api/cards", { project_id: hers.id, title: "Lo mío", column: "backlog" });
    await new Promise((r) => setTimeout(r, 1000));
    const s = postgres(dbUrl, { onnotice: () => {}, ssl: false, prepare: false });
    try {
      const leaked = await s`SELECT tbl, key FROM trellai.rows WHERE project = ${hers.id} OR data LIKE ${"%Lo mío%"}`;
      expect(leaked.length).toBe(0);
    } finally {
      await s.end();
    }
    expect((await api<Project[]>(pedro, "/api/projects")).some((p) => p.id === hers.id)).toBe(false);
  });

  it("opening a repo someone shares joins its board, with your cards", async () => {
    const auto = repo(dir, "auto");
    const p = await api<Project>(pedro, "/api/projects", { repo_path: auto.path });
    // Pedro's Trellai published the invitation in the repo by itself
    await until(async () => sh(`git ls-remote ${auto.origin} refs/trellai/board`, dir), (out) => out.length > 0);
    const anaClone = join(dir, "auto-ana");
    sh(`git clone -q ${auto.origin} ${anaClone}`, dir);
    // Ana already had her own board for it… no: she adds it now, with nothing to paste
    const onAna = await api<Project>(ana, "/api/projects", { repo_path: anaClone });
    expect(onAna.id).toBe(p.id);
    expect(resolve(onAna.repo_path)).toBe(resolve(anaClone));
    const c = await api<Card>(ana, "/api/cards", { project_id: p.id, title: "Desde Ana sin código", column: "backlog" });
    await until(() => api<Card[]>(pedro, `/api/projects/${p.id}/cards`), (cs) => cs.some((x) => x.id === c.id));
  });

  it("a board you had for the repo is merged into the shared one", async () => {
    const r = repo(dir, "mezcla");
    const anaClone = join(dir, "mezcla-ana");
    sh(`git clone -q ${r.origin} ${anaClone}`, dir);
    // Ana's own board first (nobody shares it yet; she has no database to publish it)
    const hersBefore = await api<Project>(ana, "/api/projects", { repo_path: anaClone });
    const old = await api<Card>(ana, "/api/cards", { project_id: hersBefore.id, title: "Mi tarjeta de antes", column: "backlog" });
    await api<Card>(ana, `/api/cards/${old.id}/checkpoints`, { text: "Paso uno" });
    // Pedro adds it: published
    const p = await api<Project>(pedro, "/api/projects", { repo_path: r.path });
    await until(async () => sh(`git ls-remote ${r.origin} refs/trellai/board`, dir), (out) => out.length > 0);
    // Ana re-links her folder (what the periodic check does by itself)
    const merged = await api<Project>(ana, `/api/projects/${hersBefore.id}/link`, { repo_path: anaClone });
    expect(merged.id).toBe(p.id);
    expect((await api<Project[]>(ana, "/api/projects")).some((x) => x.id === hersBefore.id)).toBe(false);
    const onPedro = await until(
      () => api<Card[]>(pedro, `/api/projects/${p.id}/cards`),
      (cs) => cs.some((x) => x.id === old.id && x.checkpoints_total === 1),
    );
    expect(onPedro.find((x) => x.id === old.id)!.author).toBe(anaId);
  });

  it("taking Ana out stops the sync on her side", async () => {
    await api(pedro, `/api/projects/${shared.id}/members/${anaId}/remove`, {});
    await until(() => api<{ shares: { project_id: string }[] }>(ana, "/api/sync"), (s) => !s.shares.some((x) => x.project_id === shared.id));
    const after = await api<Card>(pedro, "/api/cards", { project_id: shared.id, title: "Después", column: "backlog" });
    await new Promise((r) => setTimeout(r, 1000));
    expect((await api<Card[]>(ana, `/api/projects/${shared.id}/cards`)).some((c) => c.id === after.id)).toBe(false);
  });
});
