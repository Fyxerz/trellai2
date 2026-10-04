/**
 * Images attached to a card. They live in the DB (base64, so they travel with the sync);
 * before an agent starts we write them to `<repo>/.trellai/attachments/<cardId>/` so it
 * can open them with Read, and list them — with Pedro's marked regions — in its prompt.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Write the card's images where the agent can read them and return the prompt section
 * ("" when the card has none). Rewrites the folder each time, so deleted images go away.
 */
export function attachmentsBlock(card: Card, repo: string): string {
  const list = db.listAttachments(card.id);
  if (!repo) return "";
  const dir = attachmentsDir(repo, card.id);
  rmSync(dir, { recursive: true, force: true });
  if (!list.length) return "";
  try {
    git.ensureExcluded(repo);
  } catch {
    /* not a repo (tests) — the folder is still fine */
  }
  mkdirSync(dir, { recursive: true });

  const parts = list.map((a, i) => {
    const ext = IMAGE_MIMES[a.mime] ?? "png";
    const base = `${i + 1}-${slug(a.name)}`;
    const file = join(dir, `${base}.${ext}`);
    writeFileSync(file, Buffer.from(db.attachmentData(a.id) ?? "", "base64"));
    const lines = [`### Imagen ${i + 1}: ${a.name}`, `- Original: \`${file}\``];
    const drawn = a.has_annotated ? db.attachmentData(a.id, true) : null;
    if (drawn) {
      const marked = join(dir, `${base}.anotada.${ext}`);
      writeFileSync(marked, Buffer.from(drawn, "base64"));
      lines.push(`- With Pedro's regions drawn as numbered boxes: \`${marked}\``);
    }
    if (a.annotations.length) {
      lines.push("- Regions Pedro marked (position and size relative to the image: x, y from the top-left corner):");
      a.annotations.forEach((r, n) =>
        lines.push(`  ${n + 1}. x ${pct(r.x)}, y ${pct(r.y)}, ${pct(r.w)} × ${pct(r.h)} — ${r.comment.trim() || "(sin comentario)"}`),
      );
    }
    return lines.join("\n");
  });
  return [
    "## Imágenes (adjuntadas por Pedro)",
    "Open each one with the Read tool before starting — they show what Pedro means (usually the part of the interface to change). Don't add these files to the repo.",
    ...parts,
  ].join("\n\n");
}

export function removeAttachmentFiles(repo: string, cardId: string) {
  const dir = attachmentsDir(repo, cardId);
  if (repo && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
