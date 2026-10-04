/**
 * Board background image: Codex explores the project's repo, works out what it's about and
 * draws a landscape background with its image tool, saved to `<repo>/.trellai/background.png`.
 * The file stays on this computer (`.trellai/` is excluded from git and from sync).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BgStatus } from "../shared/types.js";
import * as db from "./db.js";
import { codexStatus, runEngine } from "./engine.js";
import { emitBackground } from "./events.js";
import { ensureExcluded } from "./git.js";

const EXTS = ["png", "jpg", "jpeg", "webp"];
const bgDir = (repo: string) => join(repo, ".trellai");
export const bgTarget = (repo: string) => join(bgDir(repo), "background.png");

/** The project's background image on this computer, if any. */
export function backgroundFile(repo: string): string | null {
  for (const ext of EXTS) {
    const f = join(bgDir(repo), `background.${ext}`);
    if (existsSync(f) && statSync(f).size > 0) return f;
  }
  return null;
}

/** Content type from the file's first bytes (the model may save a JPEG as .png). */
export function imageMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "application/octet-stream";
}

const jobs = new Map<string, BgStatus & { abort?: AbortController }>();

export function backgroundStatus(projectId: string): BgStatus {
  const j = jobs.get(projectId);
  return { running: j?.running ?? false, error: j?.error ?? null, activity: j?.activity ?? null };
}

function set(projectId: string, patch: Partial<BgStatus> & { abort?: AbortController }) {
  jobs.set(projectId, { ...backgroundStatus(projectId), abort: jobs.get(projectId)?.abort, ...patch });
  emitBackground(projectId, backgroundStatus(projectId));
}

export function stopBackground(projectId: string) {
  const j = jobs.get(projectId);
  if (j?.running) {
    j.abort?.abort();
    set(projectId, { running: false, activity: null, error: "Cancelado." });
  }
}

const INSTRUCTIONS = `You are making a background image for a kanban board about this software project.
Never modify, create or delete any file in the repository except the one image file you are asked to write.`;

const prompt = (target: string) => `1. Explore this repository freely (README, docs, code, assets, package metadata…) and work out what the project is about: its domain, purpose, audience and mood.
2. Use your image generation tool to create ONE background image inspired by it:
   - landscape, about 16:9 (e.g. 1920×1080 or 1536×864)
   - subtle and atmospheric — it sits behind the columns of a kanban board, so avoid busy detail and strong contrast in the middle
   - NO text, letters, numbers, logos or UI in the image
   - evocative of the project's theme (an illustration, abstract scene or texture), so the board is easy to tell apart from other projects
3. Save the final image at exactly this path (create the folder if needed; copy it there if your tool saved it somewhere else):
   ${target}
4. Answer with one short sentence (in Spanish) describing the image.`;

/** Newest image Codex left in its own folder since `since` (in case it didn't copy it to the target). */
function codexGenerated(since: number): string | null {
  const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "generated_images");
  let best: { f: string; t: number } | null = null;
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (e.isFile() && EXTS.some((x) => e.name.toLowerCase().endsWith(`.${x}`))) {
        const t = statSync(f).mtimeMs;
        if (t >= since && (!best || t > best.t)) best = { f, t };
      }
    }
  };
  walk(root, 0);
  return (best as { f: string } | null)?.f ?? null;
}

/** Starts generating in the background; progress and the end arrive as "background" events. */
export async function generateBackground(projectId: string): Promise<BgStatus> {
  const project = db.getProject(projectId);
  if (!project) throw new Error("Proyecto no encontrado");
  if (!project.repo_path || !existsSync(project.repo_path)) throw new Error("El proyecto no tiene el repo en este ordenador.");
  if (jobs.get(projectId)?.running) return backgroundStatus(projectId);
  const codex = await codexStatus();
  if (!codex.installed)
    throw new Error("Para generar la imagen hace falta Codex: instálalo con `npm i -g @openai/codex` y haz `codex login`.");

  const repo = project.repo_path;
  const abort = new AbortController();
  set(projectId, { running: true, error: null, activity: "Explorando el repo…", abort });
  void (async () => {
    const started = Date.now() - 1000;
    const target = bgTarget(repo);
    try {
      try {
        ensureExcluded(repo);
      } catch {
        /* not a git repo: nothing to exclude */
      }
      mkdirSync(bgDir(repo), { recursive: true });
      // keep the old image until a new one arrives; but don't mistake it for the new one
      const old = backgroundFile(repo);
      const oldTime = old ? statSync(old).mtimeMs : 0;
      const res = await runEngine({
        model: "codex",
        cwd: repo,
        instructions: INSTRUCTIONS,
        prompt: prompt(target),
        access: "write",
        tools: [],
        signal: abort.signal,
        onText: () => {},
        onTool: (s) => jobs.get(projectId)?.running && set(projectId, { activity: s }),
      });
      if (abort.signal.aborted) return;
      let fresh = existsSync(target) && statSync(target).mtimeMs > oldTime && statSync(target).size > 0;
      if (!fresh) {
        const made = codexGenerated(started);
        if (made) {
          copyFileSync(made, target);
          fresh = true;
        }
      }
      if (!fresh) {
        const why = res.error ? ` (${res.error})` : "";
        throw new Error(`Codex no generó la imagen; comprueba que tu versión/login de Codex soporta imágenes${why}.`);
      }
      // a previous image with another extension would shadow nothing (png wins), but tidy up
      for (const ext of EXTS.filter((x) => x !== "png")) rmSync(join(bgDir(repo), `background.${ext}`), { force: true });
      const mime = imageMime(readFileSync(target).subarray(0, 12));
      if (mime === "application/octet-stream") throw new Error("Codex guardó un archivo que no es una imagen.");
      db.updateProject(projectId, { bg_image: String(Date.now()), bg_mode: "image" });
      set(projectId, { running: false, activity: null, error: null });
    } catch (err) {
      if (!abort.signal.aborted) set(projectId, { running: false, activity: null, error: (err as Error).message });
    }
  })();
  return backgroundStatus(projectId);
}
