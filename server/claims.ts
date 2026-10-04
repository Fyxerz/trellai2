/**
 * Who is touching what, so agents only hear about what concerns them.
 *
 * Each card in Doing keeps a list of claims: file + area (function, component…) + purpose, said
 * by its agent with `claim_files` or predicted in Preparation, plus the changed lines, which
 * Trellai reads from the card's git diff (files changed without a claim get one automatically).
 *
 * - An agent only gets channel notes about files it has claimed, notes addressed to it, and
 *   general ones (no files).
 * - Overlaps are announced only to the two cards involved.
 * - When a card leaves Doing its claims are cleared and its notes archived (agents stop seeing
 *   them; the board keeps them as history).
 */
import { existsSync } from "node:fs";
import { describeClaim, type Card, type Claim, type Note } from "../shared/types.js";
import * as db from "./db.js";
import { emitCard, emitNote } from "./events.js";
import * as git from "./git.js";

/** How often a running agent's git diff is re-read (it's also re-read on every checkpoint). */
const REFRESH_MS = Number(process.env.TRELLAI_CLAIMS_MS ?? 20_000);

const normPath = (f: string) => f.trim().replace(/\\/g, "/").replace(/^\.\//, "");

/** "12-30, 88, 120-140": nearby ranges merged, at most 6. */
export function formatLines(r: [number, number][] | "new" | "deleted"): string {
  if (r === "new") return "nuevo";
  if (r === "deleted") return "borrado";
  const merged: [number, number][] = [];
  for (const [s, e] of [...r].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 3) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const parts = merged.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`));
  return parts.length > 6 ? `${parts.slice(0, 6).join(", ")}…` : parts.join(", ");
}

function save(card: Card, claims: Claim[]): Card {
  if (JSON.stringify(card.claims) === JSON.stringify(claims)) return card;
  const added = claims.some((c) => !card.claims.some((o) => o.file === c.file));
  const now = db.updateCard(card.id, { claims });
  emitCard(now);
  if (added) announceOverlaps(now);
  return now;
}

/** Entering Doing: start from the files Preparation predicted, then what git already shows. */
export function startClaims(card: Card): Card {
  if (!card.claims.length && card.files.length) {
    card = save(
      card,
      [...new Set(card.files.map(normPath))].map((file) => ({ file, area: "", purpose: "", lines: "", source: "plan" as const })),
    );
  }
  card = refreshClaims(card);
  announceOverlaps(card);
  return card;
}

/** Re-read the card's git diff: update each claim's lines and claim files changed without saying so. */
export function refreshClaims(card: Card): Card {
  if (card.column !== "doing" || !card.worktree || !existsSync(card.worktree)) return card;
  const project = db.getProject(card.project_id);
  if (!project) return card;
  let changed: ReturnType<typeof git.changedLines>;
  try {
    changed = git.changedLines(card.worktree, project.base_branch);
  } catch {
    return card;
  }
  const claims = card.claims.map((c) => ({ ...c, lines: changed.has(c.file) ? formatLines(changed.get(c.file)!) : "" }));
  for (const [file, r] of changed) {
    if (!claims.some((c) => c.file === file)) claims.push({ file, area: "", purpose: "", lines: formatLines(r), source: "auto" });
  }
  return save(card, claims);
}

/** `claim_files`: the agent says what it's going to touch. Returns what others hold on those files. */
export function claimFiles(cardId: string, input: { file: string; area?: string; purpose?: string }[]): string {
  let card = db.getCard(cardId);
  if (!card) return "Card not found.";
  if (card.column !== "doing") return "Claims only apply while the card is in Doing.";
  const claims = [...card.claims];
  for (const i of input) {
    const file = normPath(i.file);
    if (!file) continue;
    const c: Claim = { file, area: i.area?.trim() ?? "", purpose: i.purpose?.trim() ?? "", lines: "", source: "agent" };
    const at = claims.findIndex((x) => x.file === file);
    if (at >= 0) claims[at] = { ...c, lines: claims[at].lines };
    else claims.push(c);
  }
  card = refreshClaims(save(card, claims));
  const files = new Set(input.map((i) => normPath(i.file)));
  const clashes = othersOn(card).filter((o) => files.has(o.claim.file));
  if (!clashes.length) return `Claimed. No other agent is on ${[...files].join(", ")}.`;
  return [
    "Claimed. Other agents are also on some of these files — coordinate with post_note (pass `files`):",
    ...clashes.map((o) => `- ${o.claim.file}: "${o.card.title}" (${describeClaim(o.claim)})`),
  ].join("\n");
}

/** `release_files`: drop claims the agent no longer needs. Files it already changed stay claimed until it leaves Doing. */
export function releaseFiles(cardId: string, files: string[]): string {
  let card = db.getCard(cardId);
  if (!card) return "Card not found.";
  card = refreshClaims(card);
  const wanted = new Set(files.map(normPath));
  const kept = card.claims.filter((c) => wanted.has(c.file) && c.lines);
  save(card, card.claims.filter((c) => !wanted.has(c.file) || c.lines));
  const released = [...wanted].filter((f) => !kept.some((k) => k.file === f));
  return [
    released.length ? `Released: ${released.join(", ")}.` : "",
    kept.length
      ? `Still claimed (you changed them on your branch, so they stay claimed until the card leaves Doing): ${kept.map((k) => k.file).join(", ")}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function othersOn(card: Card): { card: Card; claim: Claim }[] {
  return db
    .cardsInColumn(card.project_id, "doing")
    .filter((o) => o.id !== card.id)
    .flatMap((o) => o.claims.map((claim) => ({ card: o, claim })));
}

/** Warn the two cards involved (only them) when they claim the same file. Each file is announced once per pair. */
function announceOverlaps(card: Card) {
  const mine = new Map(card.claims.map((c) => [c.file, c]));
  if (!mine.size || card.column !== "doing") return;
  const live = db.liveNotes(card.project_id);
  const announced = (other: string, file: string) =>
    live.some((n) => !n.card_id && n.targets.includes(card.id) && n.targets.includes(other) && n.files.includes(file));
  for (const other of db.cardsInColumn(card.project_id, "doing")) {
    if (other.id === card.id) continue;
    const fresh = other.claims.filter((c) => mine.has(c.file) && !announced(other.id, c.file));
    if (!fresh.length) continue;
    const lines = fresh.map((c) => `- ${c.file} → "${card.title}": ${describeClaim(mine.get(c.file)!)} · "${other.title}": ${describeClaim(c)}`);
    const note = db.addNote(
      card.project_id,
      null,
      `⚠️ "${card.title}" y "${other.title}" tocan los mismos ficheros:\n${lines.join("\n")}\nCoordinaos con post_note.`,
      { files: fresh.map((c) => c.file), targets: [card.id, other.id] },
    );
    emitNote(note);
  }
}

/** Live notes this card's agent should see: about its files, addressed to it, or general. */
export function notesFor(card: Card): Note[] {
  const mine = new Set(card.claims.map((c) => c.file));
  const doing = new Set(db.cardsInColumn(card.project_id, "doing").map((c) => c.id));
  return db
    .liveNotes(card.project_id)
    .filter(
      (n) =>
        n.card_id !== card.id &&
        (!n.card_id || doing.has(n.card_id)) &&
        (n.targets.length ? n.targets.includes(card.id) : !n.files.length || n.files.some((f) => mine.has(f))),
    );
}

export function formatNote(n: Note): string {
  return `- [${n.card_title ?? "Trellai"}]${n.files.length ? ` (${n.files.join(", ")})` : ""} ${n.content}`;
}

/** What the other agents in Doing are touching right now, for an agent's context. */
export function othersWork(card: Card): string {
  const others = db.cardsInColumn(card.project_id, "doing").filter((c) => c.id !== card.id);
  if (!others.length) return "None — you're the only agent right now.";
  const mine = new Set(card.claims.map((c) => c.file));
  return others
    .map((o) => {
      const claims = o.claims.length
        ? o.claims.map((c) => `  - ${c.file}: ${describeClaim(c)}${mine.has(c.file) ? " ⚠️ you're on it too" : ""}`).join("\n")
        : "  - (no files claimed yet)";
      return `- "${o.title}" (branch ${o.branch ?? "?"})\n${claims}`;
    })
    .join("\n");
}

/** Feeds new relevant notes into a running agent; re-reads its git diff every REFRESH_MS. */
export function notePoller(cardId: string) {
  const seen = new Set<number>();
  let refreshed = Date.now();
  return {
    /** Mark notes as already shown (read_notes). */
    seen: (notes: Note[]) => notes.forEach((n) => seen.add(n.id)),
    poll(): string | null {
      let card = db.getCard(cardId);
      if (!card) return null;
      if (Date.now() - refreshed > REFRESH_MS) {
        refreshed = Date.now();
        card = refreshClaims(card);
      }
      const fresh = notesFor(card).filter((n) => !seen.has(n.id));
      if (!fresh.length) return null;
      fresh.forEach((n) => seen.add(n.id));
      return `New notes from the channel about your work:\n${fresh.map(formatNote).join("\n")}`;
    },
  };
}

/**
 * Archive what no longer applies and clear claims of cards out of Doing. Idempotent: run it when a
 * card leaves Doing, before deleting a card (`leaving`), and at startup.
 */
export function sweep(projectId: string, leaving?: string) {
  const doing = new Set(db.cardsInColumn(projectId, "doing").map((c) => c.id));
  if (leaving) doing.delete(leaving);
  for (const c of db.listCards(projectId)) {
    if (c.claims.length && !doing.has(c.id)) emitCard(db.updateCard(c.id, { claims: [] }));
  }
  const stale = db.liveNotes(projectId).filter((n) =>
    n.card_id
      ? !doing.has(n.card_id) // its card finished (or went back)
      : n.targets.length
        ? !n.targets.every((t) => doing.has(t)) // e.g. an overlap warning: one of the two finished
        : !doing.size, // Pedro's / Trellai's general notes: until nobody is working
  );
  if (!stale.length) return;
  db.archiveNotes(stale.map((n) => n.id));
  for (const n of stale) emitNote(db.getNote(n.id)!);
}

export function sweepAll() {
  for (const p of db.listProjects()) sweep(p.id);
}
