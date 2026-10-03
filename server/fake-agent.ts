/**
 * A scripted stand-in for Claude, enabled with TRELLAI_FAKE_AGENT=1.
 * Lets you exercise the whole board flow (questions, auto-moves, worktrees,
 * notes, rebase and merge) without spending tokens.
 *
 * Spec conventions:
 *   contains "?"       → preparation asks a question first
 *   contains "shared"  → writes to SHARED.md (to provoke merge conflicts)
 */
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOptions, makeToolkit } from "./agents.js";
import { slugify } from "./git.js";

interface FakeOpts extends RunOptions {
  kit: ReturnType<typeof makeToolkit>;
  log: (role: "assistant" | "tool" | "system", content: string) => void;
  signal: AbortSignal;
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, Number(process.env.TRELLAI_FAKE_DELAY ?? ms));
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("aborted"));
    });
  });

export async function runFakeAgent(o: FakeOpts): Promise<string> {
  const sessionId = o.resume ?? `fake-${o.card.id}`;
  const slug = slugify(o.card.title);

  if (o.kind === "prep") {
    o.log("tool", "Glob · **/*");
    await delay(400, o.signal);
    if (o.card.spec.includes("?") && !o.resume) {
      o.log("assistant", "Tengo una duda antes de empezar.");
      o.kit.askQuestions([{ question: "¿Qué enfoque prefieres?", options: ["Simple", "Completo"] }]);
      return sessionId;
    }
    o.log("assistant", "La spec está clara. Paso a desarrollo.");
    o.kit.markReady(`1. Crear \`features/${slug}.md\`\n2. Verificar`, [`features/${slug}.md`]);
    return sessionId;
  }

  // dev
  o.log("tool", "read_notes");
  o.log("system", o.kit.readNotes());
  await delay(600, o.signal);

  if (/REBASE/.test(o.prompt)) {
    o.log("tool", "Bash · git rebase");
    rebaseResolvingConflicts(o.cwd, o.prompt.match(/onto "([^"]+)"/)?.[1] ?? "main");
  } else {
    mkdirSync(join(o.cwd, "features"), { recursive: true });
    writeFileSync(join(o.cwd, "features", `${slug}.md`), `# ${o.card.title}\n\n${o.card.spec}\n`);
    o.log("tool", `Write · features/${slug}.md`);
    if (o.card.spec.includes("shared")) {
      appendFileSync(join(o.cwd, "SHARED.md"), `- ${o.card.title}\n`);
      o.log("tool", "Edit · SHARED.md");
      o.kit.postNote(`He tocado SHARED.md (${o.card.title})`);
    }
  }
  await delay(600, o.signal);
  o.kit.reportDone(`Hecho: ${o.card.title}`);
  o.log("assistant", `Hecho: ${o.card.title}`);
  return sessionId;
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
      const text = execSync(`cat SHARED.md`, { cwd }).toString();
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
