import { projectName } from "./preferences";
import { Activity, FolderGit2, GitBranch, Plus, Trash2 } from "lucide-react";
import { confirmDeleteProject } from "./Confirm";
import { useEffect, useRef } from "react";
import { COLUMNS, COLUMN_LABELS, type Project } from "../../shared/types";
import { api } from "./api";
import { modelLabel, useEngines } from "./models";
import { useProjectSummaries, type ProjectSummary } from "./Sidebar";
import { Button, COLUMN_HEX, COLUMN_ICON, Kbd, ProjectAvatar, Spinner, timeAgo } from "./ui";

/** Overview: one card per project with where everything stands. */
export function Home({
  projects,
  cursor,
  onOpen,
  onNew,
  onRemoved,
}: {
  projects: Project[];
  cursor: number;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRemoved: () => void;
}) {
  const summaries = useProjectSummaries(true);
  const totals = Object.values(summaries).reduce(
    (a, s) => ({ running: a.running + s.running, waiting: a.waiting + s.waiting, review: a.review + s.review }),
    { running: 0, waiting: 0, review: 0 },
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] px-6 pt-4 pb-10">
        <div className="mb-6 flex flex-wrap items-end gap-4">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-zinc-50">Proyectos</h1>
            <p className="mt-1 text-[13px] text-zinc-500">
              {projects.length} {projects.length === 1 ? "proyecto" : "proyectos"}
              {totals.running > 0 && <span className="text-amber-300"> · {totals.running} agentes trabajando</span>}
              {totals.waiting > 0 && <span className="text-violet-300"> · {totals.waiting} esperando tu respuesta</span>}
              {totals.review > 0 && <span className="text-emerald-300"> · {totals.review} por revisar</span>}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-zinc-500">
            <span className="hidden items-center gap-1 sm:flex">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd> moverse · <Kbd>↵</Kbd> abrir
            </span>
            <Button variant="primary" onClick={onNew}>
              <Plus className="h-4 w-4" /> Nuevo proyecto
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-4">
          {projects.map((p, i) => (
            <ProjectCard key={p.id} project={p} s={summaries[p.id]} cursor={i === cursor} onOpen={() => onOpen(p.id)} onRemoved={onRemoved} />
          ))}
          <button
            onClick={onNew}
            className="flex min-h-[230px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-ui-ink/[0.08] text-[13px] text-zinc-500 transition hover:border-ui-ink/[0.16] hover:bg-ui-ink/[0.02] hover:text-zinc-300"
          >
            <Plus className="h-5 w-5" />
            Añadir proyecto
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectCard({
  project: p,
  s,
  cursor,
  onOpen,
  onRemoved,
}: {
  project: Project;
  s?: ProjectSummary;
  cursor: boolean;
  onOpen: () => void;
  onRemoved: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (cursor) ref.current?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const total = s?.total ?? 0;
  const live = COLUMNS.filter((c) => c !== "merged").reduce((n, c) => n + (s?.columns[c] ?? 0), 0);

  return (
    <div
      ref={ref}
      onClick={onOpen}
      style={{ boxShadow: "var(--shadow-card)" }}
      className={`group relative flex min-h-[230px] cursor-pointer flex-col rounded-2xl border bg-zinc-900/80 p-4 transition-all duration-150 hover:-translate-y-0.5 hover:bg-zinc-900 ${
        cursor ? "border-indigo-400/70 ring-2 ring-indigo-400/20" : "border-ui-ink/[0.06] hover:border-ui-ink/[0.12]"
      }`}
    >
      {/* header */}
      <div className="flex items-start gap-3">
        <ProjectAvatar id={p.id} name={projectName(p.name)} size={34} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold tracking-tight text-zinc-50">{projectName(p.name)}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-zinc-500">
            <span className="flex min-w-0 items-center gap-1 font-mono" title={p.repo_path}>
              <FolderGit2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{p.repo_path ? projectName(p.repo_path) : "—"}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1 font-mono">
              <GitBranch className="h-3 w-3" />
              {p.base_branch}
            </span>
          </div>
        </div>
        <button
          onClick={async (e) => {
            e.stopPropagation();
            if (!(await confirmDeleteProject(p))) return;
            await api(`/api/projects/${p.id}`, undefined, "DELETE");
            onRemoved();
          }}
          className="rounded-md p-1.5 text-zinc-500 opacity-0 transition group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-300"
          title="Quitar de Trellai"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* pipeline bar */}
      <div className="mt-4">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-ui-ink/[0.05]">
          {total > 0 &&
            COLUMNS.map((c) =>
              s?.columns[c] ? (
                <div
                  key={c}
                  title={`${COLUMN_LABELS[c]}: ${s.columns[c]}`}
                  style={{ width: `${(s.columns[c] / total) * 100}%`, background: COLUMN_HEX[c] }}
                  className="h-full border-r border-zinc-900 last:border-r-0"
                />
              ) : null,
            )}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {total === 0 && <span className="text-[11px] text-zinc-600">Sin tarjetas todavía</span>}
          {COLUMNS.map((c) => {
            const n = s?.columns[c] ?? 0;
            if (!n) return null;
            const Icon = COLUMN_ICON[c];
            return (
              <span key={c} className="tabular flex items-center gap-1 text-[11px] text-zinc-400" title={COLUMN_LABELS[c]}>
                <Icon className="h-3 w-3" style={{ color: COLUMN_HEX[c] }} />
                {n}
                <span className="text-zinc-600">{COLUMN_LABELS[c]}</span>
              </span>
            );
          })}
        </div>
      </div>

      {/* live state */}
      <div className="mt-4 flex-1 space-y-1">
        {(s?.active ?? []).map((a) => (
          <div key={a.id} className="flex min-w-0 items-center gap-2 text-[12.5px]">
            {a.status === "running" ? (
              <Spinner className="h-3 w-3 shrink-0 text-amber-300" />
            ) : (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: a.status === "waiting" ? "#a78bfa" : a.status === "error" ? "#f87171" : COLUMN_HEX[a.column] }}
              />
            )}
            <span className="min-w-0 flex-1 truncate text-zinc-300">{a.title}</span>
            <span className={`shrink-0 text-[11px] ${a.status === "waiting" ? "text-violet-300" : a.status === "error" ? "text-red-300" : "text-zinc-600"}`}>
              {a.status === "waiting" ? "te necesita" : a.status === "error" ? "error" : a.status === "running" ? COLUMN_LABELS[a.column] : "por revisar"}
            </span>
          </div>
        ))}
        {s && s.active.length === 0 && live > 0 && <div className="text-[12px] text-zinc-600">Todo en calma.</div>}
      </div>

      {/* footer */}
      <div className="mt-4 flex items-center gap-2 border-t border-ui-ink/[0.05] pt-3 text-[11px] text-zinc-500">
        <Activity className="h-3 w-3" />
        {s?.last_activity ? (timeAgo(s.last_activity) === "ahora" ? "Activo ahora mismo" : `Última actividad hace ${timeAgo(s.last_activity)}`) : "Sin actividad"}
        <span className="ml-auto flex items-center gap-1.5">
          <ModelChip spec={p.model_dev} title="Modelo de desarrollo" />
          {p.model_ui && p.model_ui !== p.model_dev && <ModelChip spec={p.model_ui} title="Modelo para interfaz" />}
        </span>
      </div>
    </div>
  );
}

function ModelChip({ spec, title }: { spec: string; title: string }) {
  useEngines(); // shows the exact version ("Opus 5.5") once known
  const gpt = spec.startsWith("codex");
  return (
    <span
      title={`${title}: ${modelLabel(spec)}`}
      className={`rounded-md px-1.5 text-[10px] leading-4 font-semibold ${gpt ? "bg-emerald-400/10 text-emerald-300" : "bg-orange-400/10 text-orange-300"}`}
    >
      {gpt ? "GPT" : modelLabel(spec, true)}
    </span>
  );
}
