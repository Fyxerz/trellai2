import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { nanoid } from "nanoid";

/**
 * Images Pedro attaches to chat messages. They live next to the database (not in the worktree, so they
 * never get committed) and are referenced in the message as markdown: ![imagen](/api/chat-images/<name>).
 */
const DIR = join(dirname(resolve(process.env.TRELLAI_DB ?? "data/trellai.db")), "chat-images");
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const NAME = /^[\w-]+\.(png|jpg|gif|webp)$/;
const LINK = /!\[[^\]]*\]\(\/api\/chat-images\/([\w-]+\.(?:png|jpg|gif|webp))\)/g;

/** Saves a data URL and returns the URL it's served at. */
export function saveChatImage(dataUrl: string): string {
  const m = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error("Formato de imagen no soportado (PNG, JPEG, GIF o WebP)");
  const data = Buffer.from(m[2], "base64");
  if (data.length > MAX_BYTES) throw new Error("La imagen pesa más de 10 MB");
  const name = `${nanoid(12)}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, name), data);
  return `/api/chat-images/${name}`;
}

export function readChatImage(name: string): { data: Buffer; type: string } | null {
  if (!NAME.test(name)) return null;
  try {
    return { data: readFileSync(join(DIR, name)), type: TYPES[name.split(".").pop()!] };
  } catch {
    return null;
  }
}

/** The message as the agent should see it: image links become absolute paths it can open. */
export function forAgent(text: string): string {
  let found = false;
  const out = text.replace(LINK, (_, name: string) => {
    found = true;
    return `[image: ${join(DIR, name)}]`;
  });
  return found ? `${out}\n\n(Pedro attached images — open each path with your file-reading tool to see it.)` : out;
}
