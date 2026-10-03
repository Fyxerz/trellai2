import { useEffect, useRef, useState } from "react";
import type { Card, Message, Note, Project, Question, ServerEvent } from "../../shared/types";

export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch(path, {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((json as { error?: string }).error ?? r.statusText);
  return json as T;
}

export function useProjects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const reload = () => api<Project[]>("/api/projects").then(setProjects);
  useEffect(() => {
    reload();
  }, []);
  return { projects, reload };
}

type Listener = (e: ServerEvent) => void;

/** Live board state for a project, kept in sync over SSE. */
export function useBoard(projectId: string | null) {
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [notes, setNotes] = useState<Note[]>([]);
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    if (!projectId) return;
    let closed = false;
    let es: EventSource | null = null;

    const load = async () => {
      const [cs, ns] = await Promise.all([
        api<Card[]>(`/api/projects/${projectId}/cards`),
        api<Note[]>(`/api/projects/${projectId}/notes`),
      ]);
      if (closed) return;
      setCards(Object.fromEntries(cs.map((c) => [c.id, c])));
      setNotes(ns);
    };

    const connect = () => {
      es = new EventSource(`/api/projects/${projectId}/events`);
      es.addEventListener("ready", () => {
        setConnected(true);
        load(); // resync after (re)connect
      });
      es.onmessage = (ev) => {
        const e = JSON.parse(ev.data) as ServerEvent;
        if (e.type === "card") setCards((prev) => ({ ...prev, [e.card.id]: e.card }));
        else if (e.type === "card_deleted")
          setCards((prev) => {
            const next = { ...prev };
            delete next[e.id];
            return next;
          });
        else if (e.type === "note") setNotes((prev) => [...prev, e.note]);
        listeners.current.forEach((fn) => fn(e));
      };
      es.onerror = () => setConnected(false);
    };

    setCards({});
    setNotes([]);
    connect();
    return () => {
      closed = true;
      es?.close();
    };
  }, [projectId]);

  const on = (fn: Listener) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  };

  /** Optimistic local update (server echo will confirm). */
  const patchLocal = (id: string, patch: Partial<Card>) =>
    setCards((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));

  return { cards, notes, connected, on, patchLocal, setCards };
}

export type Board = ReturnType<typeof useBoard>;

/** Messages + questions for the open card, live. */
export function useCardDetail(board: Board, cardId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);

  useEffect(() => {
    if (!cardId) return;
    let alive = true;
    const loadQ = () => api<Question[]>(`/api/cards/${cardId}/questions`).then((q) => alive && setQuestions(q));
    api<Message[]>(`/api/cards/${cardId}/messages`).then((m) => alive && setMessages(m));
    loadQ();
    const off = board.on((e) => {
      if (e.type === "message" && e.message.card_id === cardId)
        setMessages((prev) => (prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message]));
      if (e.type === "questions" && e.cardId === cardId) loadQ();
      if (e.type === "card" && e.card.id === cardId) loadQ();
    });
    return () => {
      alive = false;
      off();
    };
  }, [cardId]);

  return { messages, questions };
}
