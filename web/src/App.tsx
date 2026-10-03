import { useEffect, useRef, useState } from "react";
import type { Project } from "../../shared/types";
import { api, useBoard, useProjects, type Board as BoardState } from "./api";
import { Board } from "./Board";
import { CardPanel } from "./CardPanel";
import { Button, timeAgo } from "./ui";

const LAST_PROJECT = "trellai:project";

export default function App() {
  const { projects, reload } = useProjects();
  const [projectId, setProjectId] = useState<string | null>(() => localStorage.getItem(LAST_PROJECT));
  const [showNew, setShowNew] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const board = useBoard(projectId);

  useEffect(() => {
    if (!projects) return;
    if (!projects.length) setShowNew(true);
    else if (!projects.some((p) => p.id === projectId)) setProjectId(projects[0].id);
  }, [projects]);
  useEffect(() => {
    if (projectId) localStorage.setItem(LAST_PROJECT, projectId);
    setSelected(null);
  }, [projectId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const project = projects?.find((p) => p.id === projectId);
  const card = selected ? board.cards[selected] : undefined;
  const cards = Object.values(board.cards);
  const running = cards.filter((c) => c.status === "running").length;
  const waiting = cards.filter((c) => c.status === "waiting").length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="font-semibold tracking-tight text-zinc-100">Trellai</span>
        </div>
        {projects && projects.length > 0 && (
          <select
            value={projectId ?? ""}
            onChange={(e) => (e.target.value === "__new" ? setShowNew(true) : setProjectId(e.target.value))}
            className="rounded-md bg-zinc-900 px-2 py-1.5 text-sm ring-1 ring-zinc-800 outline-none"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="__new">+ Nuevo proyecto…</option>
          </select>
        )}
        {project && (
          <span className="hidden truncate font-mono text-xs text-zinc-500 md:inline">
            {project.repo_path} · {project.base_branch}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs">
          {running > 0 && <span className="text-amber-300">{running} agente{running > 1 ? "s" : ""} trabajando</span>}
          {waiting > 0 && <span className="text-violet-300">{waiting} esperando respuesta</span>}
          <span className={`h-2 w-2 rounded-full ${board.connected ? "bg-emerald-400" : "bg-red-500"}`} title={board.connected ? "Conectado" : "Desconectado"} />
          {project && (
            <Button variant={showNotes ? "default" : "ghost"} onClick={() => setShowNotes(!showNotes)}>
              Canal de agentes{board.notes.length ? ` · ${board.notes.length}` : ""}
            </Button>
          )}
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {projectId && project ? (
            <Board projectId={projectId} board={board} onOpen={setSelected} selectedId={selected} />
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-500">Crea un proyecto para empezar.</div>
          )}
        </div>
        {card && <CardPanel key={card.id} card={card} board={board} onClose={() => setSelected(null)} />}
        {showNotes && projectId && !card && <NotesPanel projectId={projectId} board={board} onOpen={setSelected} />}
      </main>

      {showNew && (
        <NewProject
          canClose={!!projects?.length}
          onClose={() => setShowNew(false)}
          onCreated={(p) => {
            setShowNew(false);
            reload();
            setProjectId(p.id);
          }}
        />
      )}
    </div>
  );
}

function NotesPanel({ projectId, board, onOpen }: { projectId: string; board: BoardState; onOpen: (id: string) => void }) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [board.notes.length]);
  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-100">Canal de agentes</h2>
        <p className="text-xs text-zinc-500">Lo que se cuentan entre ellos mientras trabajan en paralelo.</p>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {board.notes.length === 0 && <p className="text-sm text-zinc-500">Todavía nada.</p>}
        {board.notes.map((n) => (
          <div key={n.id} className="text-sm">
            <div className="mb-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
              {n.card_id ? (
                <button onClick={() => onOpen(n.card_id!)} className="font-medium text-zinc-300 hover:underline">
                  {n.card_title}
                </button>
              ) : (
                <span className="font-medium text-zinc-400">Trellai</span>
              )}
              <span>{timeAgo(n.created_at)}</span>
            </div>
            <div className="text-zinc-300">{n.content}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="border-t border-zinc-800 p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          await api(`/api/projects/${projectId}/notes`, { content: text });
          setText("");
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Avisa a todos los agentes…"
          className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm ring-1 ring-zinc-800 outline-none focus:ring-sky-600"
        />
      </form>
    </aside>
  );
}

function NewProject({ onClose, onCreated, canClose }: { onClose: () => void; onCreated: (p: Project) => void; canClose: boolean }) {
  const [repo, setRepo] = useState("~/code/");
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => canClose && onClose()}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            onCreated(await api<Project>("/api/projects", { repo_path: repo, name, base_branch: base }));
          } catch (err) {
            setError((err as Error).message);
          }
        }}
        className="w-full max-w-md space-y-3 rounded-xl bg-zinc-900 p-5 ring-1 ring-zinc-800"
      >
        <h2 className="text-base font-semibold text-zinc-100">Nuevo proyecto</h2>
        <label className="block text-xs text-zinc-400">
          Ruta del repo git
          <input autoFocus value={repo} onChange={(e) => setRepo(e.target.value)} className="mt-1 w-full rounded-md bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 ring-1 ring-zinc-700 outline-none focus:ring-sky-500" />
        </label>
        <div className="flex gap-3">
          <label className="block flex-1 text-xs text-zinc-400">
            Nombre <span className="text-zinc-600">(opcional)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-md bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-700 outline-none focus:ring-sky-500" />
          </label>
          <label className="block w-36 text-xs text-zinc-400">
            Rama base <span className="text-zinc-600">(actual)</span>
            <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="main" className="mt-1 w-full rounded-md bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 ring-1 ring-zinc-700 outline-none focus:ring-sky-500" />
          </label>
        </div>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          {canClose && (
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
          )}
          <Button variant="primary" type="submit">
            Crear
          </Button>
        </div>
      </form>
    </div>
  );
}

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 32 32">
      <rect x="3" y="5" width="7" height="22" rx="2" fill="#60a5fa" />
      <rect x="12.5" y="5" width="7" height="14" rx="2" fill="#a78bfa" />
      <rect x="22" y="5" width="7" height="18" rx="2" fill="#34d399" />
    </svg>
  );
}
