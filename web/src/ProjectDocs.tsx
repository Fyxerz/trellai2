import { useEffect, useState } from "react";
import { BookOpen, X } from "lucide-react";
import { api } from "./api";
import { useDialogFocus } from "./preferences";
import { Markdown } from "./ui";

type Doc = { name: string; content: string; truncated: boolean };

const LABEL: Record<string, string> = { "readme.md": "Descripción" };

/** Read-only modal with the repo's README, AGENTS.md and CLAUDE.md, one tab per file that exists. */
export function ProjectDocs({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const dialogRef = useDialogFocus();
  useEffect(() => {
    setDocs(null);
    setError(null);
    setTab(0);
    api<Doc[]>(`/api/projects/${projectId}/docs`).then(setDocs).catch((e) => setError((e as Error).message));
  }, [projectId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const doc = docs?.[tab];
  return (
    <div data-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Documentos del proyecto"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[85vh] w-full max-w-3xl flex-col gap-3 rounded-2xl bg-zinc-900 p-5 ring-1 ring-ui-ink/[0.08] shadow-[var(--shadow-pop)]"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">Documentos del proyecto</h2>
            <p className="text-xs text-zinc-500">Descripción e instrucciones para agentes, tal como están en la raíz del repositorio. Solo lectura.</p>
          </div>
          <button onClick={onClose} aria-label="Cerrar" className="ml-auto rounded-lg p-1.5 text-zinc-500 hover:bg-ui-ink/5 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        {docs && docs.length > 1 && (
          <div role="tablist" className="flex gap-1 border-b border-ui-ink/[0.08]">
            {docs.map((d, i) => (
              <button
                key={d.name}
                role="tab"
                aria-selected={i === tab}
                onClick={() => setTab(i)}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition ${i === tab ? "border-zinc-200 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
              >
                {LABEL[d.name.toLowerCase()] ?? d.name}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {error ? (
            <p className="text-sm text-red-400">{error}</p>
          ) : !docs ? (
            <p className="text-sm text-zinc-500">Cargando…</p>
          ) : !doc ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-zinc-500">
              <BookOpen className="h-8 w-8 opacity-50" />
              <p className="text-sm text-zinc-300">Este repositorio no tiene README.md, AGENTS.md ni CLAUDE.md en la raíz.</p>
              <p className="max-w-md text-xs">Cuando añadas alguno de esos archivos aparecerá aquí.</p>
            </div>
          ) : (
            <>
              {docs.length === 1 && <p className="mb-2 font-mono text-xs text-zinc-500">{doc.name}</p>}
              <Markdown>{doc.content}</Markdown>
              {doc.truncated && <p className="mt-3 text-xs text-zinc-500">El archivo es muy grande; solo se muestra el principio.</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
