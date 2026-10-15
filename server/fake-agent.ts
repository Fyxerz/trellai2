/**
 * A scripted stand-in for Claude, enabled with TRELLAI_FAKE_AGENT=1.
 * Lets you exercise the whole board flow (questions, auto-moves, worktrees,
 * notes, rebase and merge) without spending tokens.
 *
 * Spec conventions:
 *   contains "?"       → preparation asks a question first
 *   contains "shared"  → writes to SHARED.md (to provoke merge conflicts)
 *   contains "split"   → preparation splits the card into two sub-cards
 *   contains "parallel"→ preparation plans two parts for parallel subagents
 *   contains "slow"    → development takes 1.5 s longer (to see the queue)
 *   contains "limit"   → the first development run hits the session limit
 */
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOptions, makeToolkit } from "./agents.js";
import type { EngineResult } from "./engine.js";
import { slugify } from "./git.js";

interface FakeOpts extends RunOptions {
  kit: ReturnType<typeof makeToolkit>;
  log: (role: "assistant" | "tool" | "system", content: string) => void;
  signal: AbortSignal;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("aborted"));
    });
  });
const delay = (ms: number, signal: AbortSignal) => sleep(Number(process.env.TRELLAI_FAKE_DELAY ?? ms), signal);

/** What every simulated run reports having spent. */
const FAKE_USAGE = { input: 1200, output: 300, cache_read: 8000, cache_write: 500, cost_usd: 0.02 };
/** Cards whose simulated agent already hit the session limit once. */
const limited = new Set<string>();

export async function runFakeAgent(o: FakeOpts): Promise<EngineResult> {
  const sessionId = o.resume ?? `fake-${o.card.id}`;
  const done = (): EngineResult => ({ sessionId, usage: { totals: FAKE_USAGE, cumulative: false } });
  const slug = slugify(o.card.title);

  if (o.kind === "prep") {
    o.log("tool", "Glob · **/*");
    await delay(400, o.signal);
    if (o.card.spec.includes("?") && !o.resume) {
      o.log("assistant", "Tengo una duda antes de empezar.");
      o.kit.askQuestions([{ question: "¿Qué enfoque prefieres?", options: ["Simple", "Completo"] }]);
      return done();
    }
    if (o.card.spec.includes("split")) {
      o.log("assistant", "Son dos features independientes: la divido en sub-tarjetas.");
      o.kit.splitCard(
        ["A", "B"].map((part) => ({
          title: `${o.card.title} ${part}`,
          spec: `Parte ${part}`,
          checkpoints: [`Parte ${part} hecha`],
          files: [`features/${slug}-${part.toLowerCase()}.md`],
        })),
        "Cada parte en su fichero.",
      );
      return done();
    }
    o.log("assistant", "La spec está clara. Paso a desarrollo.");
    const parallel = o.card.spec.includes("parallel")
      ? [
          { name: "Backend", scope: "la API", files: ["server/api.ts"] },
          { name: "Interfaz", scope: "la pantalla", files: ["web/screen.tsx"] },
        ]
      : [];
    o.kit.markReady("", [`features/${slug}.md`], [`Crear features/${slug}.md`, "Verificar que existe"], parallel);
    return done();
  }

  // dev
  o.log("tool", "read_notes");
  o.log("system", o.kit.readNotes());
  await delay(600, o.signal);
  if (o.card.spec.includes("slow")) await sleep(1500, o.signal);
  if (o.card.spec.includes("limit") && !limited.has(o.card.id)) {
    limited.add(o.card.id);
    const error = "You've hit your session limit · resets 3pm (Europe/Madrid)";
    return { sessionId, error, limit: { message: error, resetsAt: null }, usage: { totals: FAKE_USAGE, cumulative: false } };
  }

  if (/REBASE/.test(o.prompt)) {
    o.log("tool", "Bash · git rebase");
    rebaseResolvingConflicts(o.cwd, o.prompt.match(/onto "([^"]+)"/)?.[1] ?? "main");
  } else {
    const shared = o.card.spec.includes("shared");
    o.log("system", o.kit.claimFiles([
      { file: `features/${slug}.md`, area: "documento", purpose: o.card.title },
      ...(shared ? [{ file: "SHARED.md", area: "lista", purpose: `añadir "${o.card.title}"` }] : []),
    ]));
    mkdirSync(join(o.cwd, "features"), { recursive: true });
    writeFileSync(join(o.cwd, "features", `${slug}.md`), `# ${o.card.title}\n\n${o.card.spec}\n`);
    o.log("tool", `Write · features/${slug}.md`);
    // Requested changes leave their own trace (and commit).
    const change = o.prompt.match(/requests changes:\n\n([^\n]+)/)?.[1];
    if (change) {
      writeFileSync(join(o.cwd, "features", `${slugify(change)}.md`), `${change}\n`);
      o.log("tool", `Write · features/${slugify(change)}.md`);
    }
    if (shared) {
      appendFileSync(join(o.cwd, "SHARED.md"), `- ${o.card.title}\n`);
      o.log("tool", "Edit · SHARED.md");
      o.kit.postNote(`He tocado SHARED.md (${o.card.title})`, ["SHARED.md"]);
    }
  }
  await delay(600, o.signal);
  for (const line of o.kit.listCheckpoints().split("\n")) {
    const id = line.match(/\(id (\d+)\)/)?.[1];
    if (id) o.kit.checkCheckpoint(Number(id));
  }
  o.kit.reportDone(`Hecho: ${o.card.title}`);
  o.log("assistant", `Hecho: ${o.card.title}`);
  return done();
}

function rebaseResolvingConflicts(cwd: string, base: string) {
  const run = (cmd: string) =>
    execSync(cmd, {
      cwd,
      stdio: "pipe",
      env: { ...process.env, GIT_EDITOR: "true", GIT_AUTHOR_NAME: "fake", GIT_AUTHOR_EMAIL: "f@x", GIT_COMMITTER_NAME: "fake", GIT_COMMITTER_EMAIL: "f@x" },
    }).toString();
  try {
    run(`git rebase ${base}`);
    return;
  } catch {
    // keep both sides of SHARED.md conflicts
  }
  for (let i = 0; i < 20; i++) {
    const file = join(cwd, "SHARED.md");
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      writeFileSync(file, text.split("\n").filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join("\n"));
    }
    run("git add -A");
    try {
      run("git rebase --continue");
      return;
    } catch {
      /* next conflicting commit */
    }
  }
}
