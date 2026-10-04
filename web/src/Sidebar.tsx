import { projectName, MOD } from "./preferences";
import { LayoutGrid, Plus, Trash2 } from "lucide-react";
import { confirmDeleteProject } from "./Confirm";
import { useEffect, useRef, useState } from "react";
import type { CardStatus, Column, Project } from "../../shared/types";
import { api } from "./api";
import { CARD_COPIED, CARD_DROP_TARGET } from "./Board";
import { Kbd, ProjectAvatar } from "./ui";

export interface ProjectSummary {
  id: string;
  total: number;
  columns: Record<Column, number>;
  running: number;
  waiting: number;
  errors: number;
  review: number;
  active: { id: string; title: string; column: Column; status: CardStatus }[];
  last_activity: string | null;
}

/** Counters for every project, refreshed every few seconds. */
export function useProjectSummaries(enabled = true) {
  const [map, setMap] = useState<Record<string, ProjectSummary>>({});
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      api<ProjectSummary[]>("/api/projects/summary")
        .then((rows) => alive && setMap(Object.fromEntries(rows.map((r) => [r.id, r]))))
        .catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return map;
}

export function Sidebar({
  projects,
  currentId,
  home,
  focused,
  cursor,
  onPick,
  onHome,
  onNew,
  onRemoved,
}: {
  projects: Project[];
  currentId: string | null;
  /** the projects overview is showing */
  home: boolean;
  /** keyboard focus is in the sidebar */
  focused: boolean;
  cursor: number;
  onPick: (id: string) => void;
  onHome: () => void;
  onNew: () => void;
  onRemoved: () => void;
}) {
  const summaries = useProjectSummaries(true);
  const listRef = useRef<HTMLUListElement>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onTarget = (e: Event) => setDropTarget((e as CustomEvent<string | null>).detail);
    const onCopied = (e: Event) => {
      setCopied((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(null), 2000);
    };
    window.addEventListener(CARD_DROP_TARGET, onTarget);
    window.addEventListener(CARD_COPIED, onCopied);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CARD_DROP_TARGET, onTarget);
      window.removeEventListener(CARD_COPIED, onCopied);
    };
  }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, focused]);

  return (
    <nav className="app-sidebar flex h-full w-[248px] shrink-0 flex-col border-r border-ui-ink/[0.06] bg-panel">
      <div className="px-2 pt-1">
        <button
          onClick={onHome}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition ${
            home ? "bg-ui-ink/[0.07] text-zinc-50" : "text-zinc-400 hover:bg-ui-ink/[0.04] hover:text-zinc-200"
          }`}
        >
          <LayoutGrid className="h-4 w-4" />
          <span className="flex-1">Todos los proyectos</span>
          <Kbd>p</Kbd>
        </button>
      </div>
      <div className="flex items-center px-4 pt-4 pb-1.5">
        <span className="ui-section-title">Proyectos</span>
        <span className="ml-auto flex items-center gap-1 text-zinc-600">
          <Kbd>{MOD}</Kbd>
          <Kbd>B</Kbd>
        </span>
      </div>
      <ul ref={listRef} className="flex-1 space-y-px overflow-y-auto px-2">
        {projects.map((p, i) => {
          const s = summaries[p.id];
          const active = p.id === currentId && !home;
          const hasCursor = focused && i === cursor;
          return (
            <li key={p.id} data-idx={i} data-drop-project={p.id} className="sidebar-row group/row relative">
              <button
                onClick={() => onPick(p.id)}
                className={`group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                  active ? "bg-ui-ink/[0.07] text-zinc-50" : "text-zinc-400 hover:bg-ui-ink/[0.04] hover:text-zinc-200"
                } ${hasCursor ? "ring-1 ring-indigo-400/70" : ""} ${dropTarget === p.id ? "bg-indigo-500/15 text-zinc-50 ring-2 ring-indigo-400" : ""}`}
              >
                <ProjectAvatar id={p.id} name={projectName(p.name)} size={20} />
                <span className="min-w-0 flex-1 truncate">{projectName(p.name)}</span>
                <span className="flex items-center gap-1">
                  {dropTarget === p.id ? (
                    <span className="text-[10.5px] font-medium text-accent">Soltar para copiar</span>
                  ) : copied === p.id ? (
                    <span className="text-[10.5px] font-medium text-success">Copiada ✓</span>
                  ) : null}
                  {s?.running ? (
                    <span className="tabular flex items-center gap-1 text-[10.5px] text-warning" title="Agentes trabajando">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                      {s.running}
                    </span>
                  ) : null}
                  {s?.waiting ? (
                    <span className="tabular rounded-full bg-violet-400/15 px-1.5 text-[10.5px] leading-4 text-waiting" title="Esperando tu respuesta">
                      {s.waiting}
                    </span>
                  ) : null}
                  {s?.review ? (
                    <span className="tabular rounded-full bg-emerald-400/12 px-1.5 text-[10.5px] leading-4 text-success" title="Para revisar">
                      {s.review}
                    </span>
                  ) : null}
                  {s?.errors ? <span className="h-1.5 w-1.5 rounded-full bg-red-400" title="Con errores" /> : null}
                  {!s?.running && !s?.waiting && !s?.review && !s?.errors && i < 9 && (
                    <span className="ui-reveal font-mono text-[10px] text-zinc-600 opacity-0 group-hover:opacity-100">{i + 1}</span>
                  )}
                </span>
              </button>
              <button
                onClick={async () => {
                  if (!(await confirmDeleteProject(p))) return;
                  await api(`/api/projects/${p.id}`, undefined, "DELETE");
                  onRemoved();
                }}
                className="ui-reveal absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md bg-zinc-900 p-1 text-zinc-500 opacity-0 ring-1 ring-ui-ink/[0.06] transition group-hover/row:opacity-100 hover:bg-red-500/15 hover:text-danger"
                title="Quitar de Trellai"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
      <button
        onClick={onNew}
        className="m-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-500 transition hover:bg-ui-ink/[0.04] hover:text-zinc-200"
      >
        <Plus className="h-4 w-4" /> Nuevo proyecto
      </button>
    </nav>
  );
}
