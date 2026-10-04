import { useEffect, useSyncExternalStore } from "react";
import { CircleCheck, Download, TriangleAlert, X } from "lucide-react";
import type { CloneJob, Project } from "../../shared/types";
import { api } from "./api";
import { Button, Spinner } from "./ui";

/**
 * Background clones ("Nuevo proyecto → Clonar de GitHub"): the dialog closes at once and each
 * clone shows here, bottom right, while you keep using the app. Polls the server every second.
 */
interface Toast {
  id: string;
  label: string;
  job: CloneJob;
}

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const update = (id: string, job: CloneJob) => {
  toasts = toasts.map((t) => (t.id === id ? { ...t, job } : t));
  emit();
};
const dismiss = (id: string) => {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
};

/** Called once a clone finished and its project exists (App reloads the project list). */
let onFinished: (p: Project) => void = () => {};

/** Follow a clone the server started (POST /api/projects/clone → { jobId }). */
export function trackClone(id: string, label: string) {
  toasts = [...toasts, { id, label, job: { stage: "cloning", percent: 0, message: "Conectando…" } }];
  emit();
  let misses = 0;
  const poll = async () => {
    if (!toasts.some((t) => t.id === id)) return;
    let job: CloneJob;
    try {
      job = await api<CloneJob>(`/api/clone-jobs/${id}`);
      misses = 0;
    } catch (e) {
      // A blip (server restarting) is retried; a job the server no longer knows is an error.
      if (++misses < 5 && !/ya no existe/.test((e as Error).message)) return void setTimeout(poll, 1000);
      job = { stage: "error", message: (e as Error).message };
    }
    update(id, job);
    if (job.stage === "done") {
      if (job.project) onFinished(job.project);
      setTimeout(() => dismiss(id), 10_000);
    } else if (job.stage !== "error") setTimeout(poll, 1000);
  };
  setTimeout(poll, 500);
}

export function CloneToasts({ onOpen, onFinished: finished }: { onOpen: (p: Project) => void; onFinished: (p: Project) => void }) {
  const list = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => toasts,
  );
  useEffect(() => {
    onFinished = finished;
  }, [finished]);
  if (!list.length) return null;
  return (
    <div className="fixed right-5 bottom-5 z-[65] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {list.map((t) => (
        <CloneToast key={t.id} toast={t} onOpen={onOpen} />
      ))}
    </div>
  );
}

function CloneToast({ toast: { id, label, job }, onOpen }: { toast: Toast; onOpen: (p: Project) => void }) {
  const failed = job.stage === "error";
  const done = job.stage === "done";
  const Icon = failed ? TriangleAlert : done ? CircleCheck : Download;
  const title = failed ? `No se pudo clonar ${label}` : done ? `Listo: ${job.project?.name ?? label}` : job.stage === "creating" ? `Creando el proyecto ${label}…` : `Clonando ${label}…`;
  return (
    <div
      role={failed ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-xl border bg-panel p-3.5 shadow-[var(--shadow-pop)] ${failed ? "border-red-400/40" : done ? "border-teal-300/30" : "border-zinc-700"}`}
    >
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${failed ? "text-red-300" : done ? "text-teal-300" : "text-indigo-300"}`} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="truncate text-sm font-medium text-zinc-100" title={title}>
          {title}
        </p>
        {job.stage === "cloning" && (
          <>
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.percent ?? 0}>
              <div className="h-full rounded-full bg-indigo-400 transition-[width] duration-500" style={{ width: `${job.percent ?? 0}%` }} />
            </div>
            <p className="flex justify-between gap-2 text-xs text-zinc-400">
              <span className="truncate">{job.message}</span>
              <span className="shrink-0 tabular-nums">{job.percent ?? 0}%</span>
            </p>
          </>
        )}
        {job.stage === "creating" && (
          <p className="flex items-center gap-2 text-xs text-zinc-400">
            <Spinner className="h-3 w-3" /> Añadiéndolo al tablero…
          </p>
        )}
        {failed && <p className="text-xs break-words text-red-200">{job.message}</p>}
        {done && job.project && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              dismiss(id);
              onOpen(job.project!);
            }}
          >
            Abrir proyecto
          </Button>
        )}
      </div>
      {(failed || done) && (
        <button aria-label="Cerrar aviso" className="rounded p-1 text-zinc-400 hover:text-zinc-100" onClick={() => dismiss(id)}>
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
