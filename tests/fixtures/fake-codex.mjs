// A stand-in for `codex` (TRELLAI_CODEX_BIN): writes a tiny PNG where the prompt asks,
// unless the repo has a NO_IMAGE file (simulates a Codex without image generation).
// FAKE_CODEX_ARGS=<file> records its arguments there; a prompt with DIE_SILENTLY exits 15 with nothing on stderr.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (process.env.FAKE_CODEX_ARGS) writeFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify(args));
const cwd = args.includes("-C") ? args[args.indexOf("-C") + 1] : process.cwd();
const prompt = args[args.length - 1];
if (prompt.includes("DIE_SILENTLY")) {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
  console.log("Error: no se pudo abrir la imagen");
  process.exit(15);
}
const target = prompt.match(/exactly this path[^\n]*\n\s*(.+)/)?.[1].trim();
const out = (e) => console.log(JSON.stringify(e));
out({ type: "thread.started", thread_id: "fake-thread" });
out({ type: "item.completed", item: { type: "command_execution", command: "cat README.md" } });
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CODEX_DELAY ?? 300)));
if (target && !existsSync(join(cwd, "NO_IMAGE"))) {
  mkdirSync(dirname(target), { recursive: true });
  // 1×1 PNG
  writeFileSync(target, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  out({ type: "item.completed", item: { type: "agent_message", text: "Un fondo azul." } });
} else {
  out({ type: "item.completed", item: { type: "agent_message", text: "No tengo herramienta de imágenes." } });
}
