/**
 * Runs a project's dev server for the Vista (vista.ts): `node vista-runner.mjs <trellai pid> <command>`.
 *
 * It sits between Trellai and the command so the app never outlives Trellai: if Trellai goes away
 * without stopping it (killed, crashed), the runner notices within a couple of seconds and kills
 * the command with everything it started.
 *
 * The command's output goes through us to Trellai. When Trellai dies that pipe breaks: we swallow
 * it, so `npm` doesn't exit on its own first and leave the app orphaned outside the tree we kill.
 */
import { execFileSync, spawn } from "node:child_process";

const [parentPid, command] = process.argv.slice(2);
const win = process.platform === "win32";

// Same process group as us (Trellai kills the group on unix; taskkill /T takes the tree on Windows).
const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

for (const out of [process.stdout, process.stderr]) out.on("error", () => {});
const forward = (from, to) =>
  from.on("data", (d) => {
    try {
      to.write(d);
    } catch {
      /* Trellai is gone: the watchdog below stops everything */
    }
  });
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

function killAll() {
  try {
    if (win) execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-process.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  process.exit(0);
}

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (err) => {
  console.error(`No pude ejecutar «${command}»: ${err.message}`);
  process.exit(1);
});

setInterval(() => {
  try {
    process.kill(Number(parentPid), 0);
  } catch {
    killAll();
  }
}, 2000).unref();
