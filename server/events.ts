import { EventEmitter } from "node:events";
import type { Card, Message, Note, ServerEvent } from "../shared/types.js";
import { getCard } from "./db.js";

/** Per-project event bus feeding the SSE stream. */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function subscribe(projectId: string, fn: (e: ServerEvent) => void) {
  bus.on(projectId, fn);
  return () => bus.off(projectId, fn);
}

function emit(projectId: string, e: ServerEvent) {
  bus.emit(projectId, e);
}

export function emitCard(card: Card | string) {
  const c = typeof card === "string" ? getCard(card) : card;
  if (c) emit(c.project_id, { type: "card", card: c });
}

export function emitCardDeleted(projectId: string, id: string) {
  emit(projectId, { type: "card_deleted", id });
}

export function emitMessage(projectId: string, message: Message) {
  emit(projectId, { type: "message", message });
}

export function emitQuestions(projectId: string, cardId: string) {
  emit(projectId, { type: "questions", cardId });
}

export function emitNote(note: Note) {
  emit(note.project_id, { type: "note", note });
}
