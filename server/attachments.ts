/**
 * Images attached to a card. They live in the DB (base64, so they travel with the sync);
 * before an agent starts we write them to `<repo>/.trellai/attachments/<cardId>/` so it
 * can open them with Read (Codex gets them attached instead, see `forCodex`), and list them —
 * with Pedro's marked regions — in its prompt.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Annotation, Card } from "../shared/types.js";
import * as db from "./db.js";
import * as git from "./git.js";

export const IMAGE_MIMES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
/** Base64 length cap (~9 MB of image): the client resizes before uploading, so this is only a safety net. */
export const MAX_BASE64 = 12_000_000;

/** Accepts plain base64 or a data URL. Throws a message for Pedro if it isn't a usable image. */
export function parseImage(data: unknown, mime?: unknown): { mime: string; data: string } {
  if (typeof data !== "string" || !data) throw new Error("Falta la imagen");
  const m = data.match(/^data:([^;,]+);base64,(.*)$/s);
  const type = String(m ? m[1] : mime ?? "").toLowerCase();
  const b64 = (m ? m[2] : data).replace(/\s+/g, "");
  if (!IMAGE_MIMES[type]) throw new Error(`Formato no soportado (${type || "desconocido"}): usa PNG, JPEG, WebP o GIF`);
  if (b64.length > MAX_BASE64) throw new Error("La imagen es demasiado grande");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("La imagen no es base64 válido");
  return { mime: type, data: b64 };
}

/** Keeps only well-formed rectangles, clamped to the image. */
export function cleanAnnotations(v: unknown): Annotation[] {
  if (!Array.isArray(v)) return [];
  const clamp = (n: unknown) => Math.min(1, Math.max(0, Number(n) || 0));
  return v
    .filter((a) => a && typeof a === "object")
    .map((a) => {
      const x = clamp(a.x);
      const y = clamp(a.y);
      return { x, y, w: Math.min(clamp(a.w), 1 - x), h: Math.min(clamp(a.h), 1 - y), comment: String(a.comment ?? "").slice(0, 2000) };
    })
    .filter((a) => a.w > 0 && a.h > 0);
}

export const attachmentsDir = (repo: string, cardId: string) => join(repo, ".trellai", "attachments", cardId);

const slug = (name: string) => git.slugify(name.replace(/\.[a-z0-9]+$/i, "")) || "imagen";
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Writes a file only if it's missing or different, so an agent reading it right now isn't disturbed. */
function writeIfChanged(file: string, data: Buffer) {
  try {
    if (readFileSync(file).equals(data)) return;
  } catch {
    /* missing */
  }
  writeFileSync(file, data);
}

/**
 * Write the card's images where the agent can read them; one prompt entry per image. Only
 * missing or changed files are written and leftovers removed (another agent of the card may be reading them).
 */
function writeAll(card: Card, repo: string): { id: number; text: string }[] {
  const list = db.listAttachments(card.id);
  if (!repo) return [];
  const dir = attachmentsDir(repo, card.id);
  if (!list.length) {
    rmSync(dir, { recursive: true, force: true });
    return [];
  }
  try {
    git.ensureExcluded(repo);
  } catch {
    /* not a repo (tests) — the folder is still fine */
  }
  mkdirSync(dir, { recursive: true });
  const keep = new Set<string>();

  const parts = list.map((a, i) => {
    const ext = IMAGE_MIMES[a.mime] ?? "png";
    const base = `${i + 1}-${slug(a.name)}`;
    const file = join(dir, `${base}.${ext}`);
    writeIfChanged(file, Buffer.from(db.attachmentData(a.id) ?? "", "base64"));
    keep.add(`${base}.${ext}`);
    const lines = [`### Imagen ${i + 1}: ${a.name}`, `- Original: \`${file}\``];
    const drawn = a.has_annotated ? db.attachmentData(a.id, true) : null;
    if (drawn) {
      const marked = join(dir, `${base}.anotada.${ext}`);
      writeIfChanged(marked, Buffer.from(drawn, "base64"));
      keep.add(`${base}.anotada.${ext}`);
      lines.push(`- With Pedro's regions drawn as numbered boxes: \`${marked}\``);
    }
    if (a.annotations.length) {
      lines.push("- Regions Pedro marked (position and size relative to the image: x, y from the top-left corner):");
      a.annotations.forEach((r, n) =>
        lines.push(`  ${n + 1}. x ${pct(r.x)}, y ${pct(r.y)}, ${pct(r.w)} × ${pct(r.h)} — ${r.comment.trim() || "(sin comentario)"}`),
      );
    }
    return { id: a.id, text: lines.join("\n") };
  });
  for (const f of readdirSync(dir)) if (!keep.has(f)) rmSync(join(dir, f), { recursive: true, force: true });
  return parts;
}

// How the agent is told to look at the images. Claude opens them with Read; Codex has no Read tool,
// so `forCodex` swaps these sentences and attaches the files to the message itself (`codex exec -i`).
const READ_ALL =
  "Open each one with the Read tool before starting — they show what Pedro means (usually the part of the interface to change). Don't add these files to the repo.";
const READ_MESSAGE = "Images attached to this message — open them with the Read tool:";
const CODEX_ALL =
  "They are attached to this message (the files listed below are the same images) — look at them before starting: they show what Pedro means (usually the part of the interface to change). Don't add these files to the repo.";
const CODEX_MESSAGE = "Images attached to this message (they come with it; the files listed below are the same images):";

/** The prompt section with all the card's images ("" when it has none). */
export function attachmentsBlock(card: Card, repo: string): string {
  const parts = writeAll(card, repo);
  if (!parts.length) return "";
  return [
    "## Imágenes (adjuntadas por Pedro)",
    READ_ALL,
    ...parts.map((p) => p.text),
  ].join("\n\n");
}

/** The images Pedro attached to one chat message, for the text the agent receives ("" when none). */
export function messageImagesBlock(card: Card, repo: string, ids: number[]): string {
  const parts = writeAll(card, repo).filter((p) => ids.includes(p.id));
  if (!parts.length) return "";
  return [
    READ_MESSAGE,
    ...parts.map((p) => p.text),
  ].join("\n\n");
}

export function removeAttachmentFiles(repo: string, cardId: string) {
  const dir = attachmentsDir(repo, cardId);
  if (repo && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Chat messages show their images as Markdown links to `/api/attachments/<uid>/image`. */
export const messageImageMarkdown = (a: { name: string; uid: string }) => `![${a.name.replace(/[[\]]/g, "")}](/api/attachments/${a.uid}/image)`;

/** What the agent gets for a chat message: the text plus where to read the images it links to. */
export function withMessageImages(card: Card, repo: string, content: string): string {
  const uids = [...content.matchAll(/\(\/api\/attachments\/([\w-]+)\/image\)/g)].map((m) => m[1]);
  const ids = uids.map((u) => db.getAttachmentByUid(u)?.id).filter((id): id is number => id !== undefined);
  const block = ids.length ? messageImagesBlock(card, repo, ids) : "";
  return block ? `${content}\n\n${block}` : content;
}

/**
 * A prompt for Codex: the card's image files it mentions (to attach with `codex exec -i`), and the text
 * without the "open them with Read" instructions. Prompts without images come back unchanged.
 */
export function forCodex(prompt: string, repo: string, cardId: string): { prompt: string; images: string[] } {
  const dir = repo ? attachmentsDir(repo, cardId) : "";
  let files: string[] = [];
  try {
    files = dir ? readdirSync(dir).map((f) => join(dir, f)) : [];
  } catch {
    /* no images */
  }
  const images = files.filter((f) => prompt.includes(`\`${f}\``));
  if (!images.length) return { prompt, images };
  return { prompt: prompt.replaceAll(READ_ALL, CODEX_ALL).replaceAll(READ_MESSAGE, CODEX_MESSAGE), images };
}
