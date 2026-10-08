/**
 * What Pedro points at in the Vista ("Señalar"), turned into a request an agent can act on
 * without screenshots: each pin carries his comment plus how to find the element in the code.
 *
 * - From a card's Vista, the pins go to that card like any message (from To Review it goes
 *   back to Doing), and each one becomes a checkpoint.
 * - From the project's Vista (the base branch), they go to the "rama de retoques": a card that
 *   skips preparation and goes straight to Doing. While it's open (Doing / To Review), more pins
 *   go to it and the project's Vista shows its branch; merging it closes it.
 */
import { COLUMN_LABELS, type Card, type VistaPin } from "../shared/types.js";
import * as db from "./db.js";
import { emitCard, emitCheckpoints, emitMessage } from "./events.js";
import { openTouchup } from "./vista.js";
import * as wf from "./workflow.js";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Well-formed pins with something to say (comment or element), with every field bounded. */
export function cleanPins(v: unknown): VistaPin[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p) => p && typeof p === "object")
    .map((p) => ({
      comment: typeof p.comment === "string" ? p.comment.trim().slice(0, 2000) : "",
      page: str(p.page, 300),
      tag: str(p.tag, 400),
      text: str(p.text, 160),
      selector: str(p.selector, 400),
      size: str(p.size, 20),
      components: (Array.isArray(p.components) ? p.components : []).map((c: unknown) => str(c, 60)).filter(Boolean).slice(0, 5),
      source: str(p.source, 300),
      siblings: str(p.siblings, 300),
      styles: str(p.styles, 400),
    }))
    .filter((p) => p.comment || p.tag)
    .slice(0, 30);
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** What the pinned element is, in a few words: «Guardar» (button). */
export function pinLabel(p: VistaPin): string {
  const tag = p.tag.match(/^<([\w-]+)/)?.[1] ?? "elemento";
  return p.text ? `«${p.text.length > 40 ? `${p.text.slice(0, 39)}…` : p.text}» (${tag})` : tag;
}

/** The pins as the message Pedro sees in Actividad and the agent receives. */
export function pinsMarkdown(pins: VistaPin[], note = ""): string {
  const pages = [...new Set(pins.map((p) => p.page).filter(Boolean))];
  const onePage = pages.length === 1 ? pages[0] : null;
  const head = `🎯 **${pins.length === 1 ? "1 cambio señalado" : `${pins.length} cambios señalados`} en la Vista**${onePage ? ` · ${code(onePage)}` : ""}`;
  const blocks = pins.map((p, i) => {
    const lines = [`**${i + 1}. ${p.comment || "(sin comentario)"}**`];
    lines.push(`- Elemento: ${code(p.tag)}${p.text ? ` «${p.text}»` : ""}${p.size ? ` · ${p.size} px` : ""}${!onePage && p.page ? ` · en ${code(p.page)}` : ""}`);
    if (p.components.length || p.source) {
      lines.push(`- Código: ${[p.components.length ? `componente ${p.components.map(code).join(" ← ")}` : "", p.source ? code(p.source) : ""].filter(Boolean).join(" · ")}`);
    }
    if (p.siblings) lines.push(`- Junto a: ${p.siblings}`);
    if (p.styles) lines.push(`- Estilo ahora: ${p.styles}`);
    if (p.selector) lines.push(`- Selector: ${code(p.selector)}`);
    return lines.join("\n");
  });
  return [
    head,
    ...blocks,
    note.trim() ? `**En general:** ${note.trim()}` : "",
    "_Pedro los señaló en la app funcionando. Busca cada elemento por su texto, clases, componente o fichero; las líneas con «~» son aproximadas._",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** One checkpoint per pin, in Pedro's words. */
function pinCheckpoint(p: VistaPin): string {
  const what = p.comment || "Revisar";
  const text = `${what} — ${pinLabel(p)}`;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function addCheckpoints(card: Card, pins: VistaPin[]) {
  for (const p of pins) db.addCheckpoint(card.id, pinCheckpoint(p), "user");
  emitCheckpoints(card.project_id, card.id);
}

/** Pins from a card's Vista: a message to its agent (from To Review, back to Doing). */
export function sendPinsToCard(cardId: string, pins: VistaPin[], note = ""): Card {
  const card = db.getCard(cardId);
  if (!card) throw new Error("Tarjeta no encontrada");
  if (!pins.length) throw new Error("No hay nada señalado");
  if (card.column !== "doing" && card.column !== "review") {
    throw new Error(`La tarjeta está en ${COLUMN_LABELS[card.column]}: los cambios señalados se mandan a tarjetas en Doing o To Review.`);
  }
  addCheckpoints(card, pins);
  wf.sendMessage(card.id, pinsMarkdown(pins, note));
  return db.getCard(card.id)!;
}

/** Pins from the project's Vista: to the open "rama de retoques", or a new one. */
export function sendPinsToProject(projectId: string, pins: VistaPin[], note = ""): Card {
  const project = db.getProject(projectId);
  if (!project) throw new Error("Proyecto no encontrado");
  if (!pins.length) throw new Error("No hay nada señalado");
  const open = openTouchup(projectId);
  if (open) return sendPinsToCard(open.id, pins, note);

  const first = pins[0].comment || pinLabel(pins[0]);
  const title = `Retoques: ${first.length > 60 ? `${first.slice(0, 59)}…` : first}${pins.length > 1 ? ` (+${pins.length - 1})` : ""}`;
  let card = db.createCard({ project_id: projectId, title, spec: pinsMarkdown(pins, note), column: "plan" });
  card = db.updateCard(card.id, { touchup: true, model: project.model_ui ?? null });
  emitCard(card);
  addCheckpoints(card, pins);
  emitMessage(projectId, db.addMessage(card.id, "system", "🎯 Rama de retoques: lo que señales en la Vista del proyecto viene aquí hasta que la mergees."));
  return wf.moveCard(card.id, "doing", Number.MAX_SAFE_INTEGER, "automático: retoques señalados en la Vista");
}
