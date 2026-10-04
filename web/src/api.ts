import { useEffect, useRef, useState } from "react";
import { flushDraft } from "./drafts";
import type { Card, Checkpoint, Message, Note, Project, Question, ServerEvent } from "../../shared/types";

export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const transition = path.match(/^\/api\/cards\/([^/]+)\/(?:move|copy)$/);
  if (transition && !(await flushDraft(transition[1]))) {
    // Recover a draft after a reload, even if the editor has not been opened yet.
    const key = `trellai:spec-draft:${transition[1]}`;
    let draft: string | null = null;
    try { draft = localStorage.getItem(key); } catch { /* optional storage */ }
    if (draft !== null) {
      await api(`/api/cards/${transition[1]}`, { spec: draft }, "PATCH");
      try { if (localStorage.getItem(key) === draft) localStorage.removeItem(key); } catch { /* optional storage */ }
    }
  }
  const r = await fetch(path, {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!(r.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error(`Respuesta inesperada del servidor en ${path} (${r.status}). ¿Has reiniciado el servidor tras actualizar?`);
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((json as { error?: string }).error ?? r.statusText);
  return json as T;
}

export interface BuildInfo {
  id: string;
  /** Trellai's server code changed (branch switch) and isn't loaded yet */
  restartPending: boolean;
  /** Maitre restarts it by itself once no agent is running */
  autoRestart: boolean;
}

/** The UI build this page was loaded with: a different one on the server (branch switch) → reload. */
let loadedBuild: string | null = null;
export async function checkBuild() {
  const b = await api<BuildInfo>("/api/build").catch(() => null);
  if (!b) return null;
  if (loadedBuild === null) loadedBuild = b.id;
  else if (b.id !== loadedBuild) location.reload();
  return b;
}

export function useProjects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const reload = () => api<Project[]>("/api/projects").then(setProjects).catch(() => {});
  useEffect(() => {
    reload();
    // projects added/renamed on another computer
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, []);
  return { projects, reload };
}

export interface SyncStatus {
  enabled: boolean;
  machine: string;
  ok: boolean;
  error: string | null;
  last_sync: string | null;
  pending: number;
}

/** Board sync status + this computer's name (shared by every component). */
let syncCache: SyncStatus | null = null;
const syncSubs = new Set<(s: SyncStatus) => void>();
let syncTimer: ReturnType<typeof setInterval> | null = null;
const loadSync = () =>
  api<SyncStatus>("/api/sync")
    .then((s) => {
      syncCache = s;
      syncSubs.forEach((fn) => fn(s));
    })
    .catch(() => {});

export function useSync(): SyncStatus | null {
  const [s, setS] = useState(syncCache);
  useEffect(() => {
    syncSubs.add(setS);
    if (!syncTimer) {
      loadSync();
      syncTimer = setInterval(loadSync, 5000);
    }
    return () => void syncSubs.delete(setS);
  }, []);
  return s;
}

type Listener = (e: ServerEvent) => void;

/** Live board state for a project, kept in sync over SSE. */
export function useBoard(projectId: string | null) {
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [notes, setNotes] = useState<Note[]>([]);
  const [connected, setConnected] = useState(false);
  const [build, setBuild] = useState<BuildInfo | null>(null);
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

    const checkUpdate = () => checkBuild().then((b) => !closed && b && setBuild(b));
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      es = new EventSource(`/api/projects/${projectId}/events`);
      es.addEventListener("ready", () => {
        setConnected(true);
        load(); // resync after (re)connect
        checkUpdate(); // the server may have restarted with new code
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
        else if (e.type === "note")
          // new, or archived
          setNotes((prev) => (prev.some((n) => n.id === e.note.id) ? prev.map((n) => (n.id === e.note.id ? e.note : n)) : [...prev, e.note]));
        else if (e.type === "sync") {
          // another computer changed this project: reload (debounced)
          if (reloadTimer) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(load, 250);
        } else if (e.type === "build") checkUpdate();
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

  return { cards, notes, connected, build, on, patchLocal, setCards };
}

export type Board = ReturnType<typeof useBoard>;

/** Messages + questions for the open card, live. */
export function useCardDetail(board: Board, cardId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);

  useEffect(() => {
    if (!cardId) return;
    let alive = true;
    const loadQ = () => api<Question[]>(`/api/cards/${cardId}/questions`).then((q) => alive && setQuestions(q));
    const loadM = () => api<Message[]>(`/api/cards/${cardId}/messages`).then((m) => alive && setMessages(m));
    loadM();
    loadQ();
    const loadC = () => api<Checkpoint[]>(`/api/cards/${cardId}/checkpoints`).then((c) => alive && setCheckpoints(c));
    loadC();
    const off = board.on((e) => {
      if (e.type === "message" && e.message.card_id === cardId)
        setMessages((prev) => (prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message]));
      if (e.type === "questions" && e.cardId === cardId) loadQ();
      if (e.type === "checkpoints" && e.cardId === cardId) loadC();
      if (e.type === "card" && e.card.id === cardId) loadQ();
      if (e.type === "sync") {
        loadM();
        loadQ();
        loadC();
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [cardId]);

  return { messages, questions, checkpoints, setCheckpoints };
}
