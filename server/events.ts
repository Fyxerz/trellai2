import { EventEmitter } from "node:events";
import type { AssistantMessage, Card, Message, Note, ServerEvent, Tag } from "../shared/types.js";
import { getCard } from "./db.js";

/** Per-project event bus feeding the SSE stream. */
const bus = new EventEmitter();
bus.setMaxListeners(0);
const ALL = Symbol("all");

export function subscribe(projectId: string, fn: (e: ServerEvent) => void) {
  bus.on(projectId, fn);
  bus.on(ALL, fn);
  return () => {
    bus.off(projectId, fn);
    bus.off(ALL, fn);
  };
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

export function emitCheckpoints(projectId: string, cardId: string) {
  emit(projectId, { type: "checkpoints", cardId });
  emitCard(cardId); // counters on the card
}

export function emitAttachments(projectId: string, cardId: string) {
  emit(projectId, { type: "attachments", cardId });
}

export function emitAssistantMessage(message: AssistantMessage) {
  emit(message.project_id, { type: "assistant_message", message });
}

export function emitAssistantStatus(projectId: string, mode: AssistantMessage["mode"], running: boolean) {
  emit(projectId, { type: "assistant_status", mode, running });
}

export function emitPreview(projectId: string, cardId: string | null) {
  emit(projectId, { type: "preview", cardId });
}

export function emitTags(projectId: string, tags: Tag[]) {
  emit(projectId, { type: "tags", tags });
}

export function emitSync(projectId: string) {
  emit(projectId, { type: "sync" });
}

/** For every open board, whatever the project. */
export function emitAll(e: ServerEvent) {
  bus.emit(ALL, e);
}
