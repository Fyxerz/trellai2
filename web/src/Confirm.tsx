import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "./ui";

/**
 * In-app confirmation dialog.
 *   if (await confirmDialog({ title: "¿Eliminar?", body: "…", danger: true })) …
 * Enter confirms, Esc cancels.
 */
interface Request {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** only an OK button */
  notice?: boolean;
  resolve: (ok: boolean) => void;
}

let current: Request | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function confirmDialog(opts: Omit<Request, "resolve">): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { ...opts, resolve };
    emit();
  });
}

function close(ok: boolean) {
  const req = current;
  current = null;
  emit();
  req?.resolve(ok);
}

export function ConfirmHost() {
  const req = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!req) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close(e.key === "Enter");
      }
    };
    window.addEventListener("keydown", onKey, true); // capture: before the app's shortcuts
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req]);

  if (!req) return null;
  return (
    <div data-modal className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={() => close(false)}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-zinc-900 p-5 shadow-[var(--shadow-pop)] ring-1 ring-white/[0.08]"
      >
        <div className="flex items-start gap-3">
          {req.danger && (
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500/12 text-red-300 ring-1 ring-red-400/20">
              <TriangleAlert className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-zinc-50">{req.title}</h2>
            {req.body && <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-line text-zinc-400">{req.body}</p>}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {!req.notice && (
            <Button variant="ghost" onClick={() => close(false)}>
              Cancelar <span className="ml-1 font-mono text-[10px] text-zinc-500">esc</span>
            </Button>
          )}
          <button
            ref={okRef}
            onClick={() => close(true)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-white transition ${
              req.danger ? "bg-red-500/90 hover:bg-red-500" : "bg-indigo-500 hover:bg-indigo-400"
            }`}
          >
            {req.confirmLabel ?? "Confirmar"} <span className="font-mono text-[10px] text-white/60">↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shared copy for deleting things. */
export function confirmDeleteCard(card: { title: string; branch: string | null }) {
  return confirmDialog({
    title: "¿Eliminar tarjeta?",
    body: `"${card.title}"${card.branch ? "\nTambién se borran su worktree y su rama (lo que no esté mergeado se pierde)." : ""}`,
    confirmLabel: "Eliminar",
    danger: true,
  });
}

export function confirmDeleteProject(project: { name: string }) {
  return confirmDialog({
    title: `¿Quitar "${project.name}" de Trellai?`,
    body: "Se borran sus tarjetas y las ramas trellai/* que no se hayan mergeado.\nTu repo y su historial no se tocan.",
    confirmLabel: "Quitar proyecto",
    danger: true,
  });
}

export function notice(title: string, body?: string) {
  return confirmDialog({ title, body, notice: true, confirmLabel: "Entendido", danger: true });
}

/** Toggle "Ver esta rama" for a card, showing any git problem in a dialog. */
export async function togglePreview(card: { id: string; project_id: string; title: string }, active: boolean) {
  const { api } = await import("./api");
  try {
    if (active) await api(`/api/projects/${card.project_id}/preview/stop`, {});
    else await api(`/api/cards/${card.id}/preview`, {});
  } catch (e) {
    await notice(active ? "No pude volver a tu rama" : "No pude cambiar a la rama", (e as Error).message);
  }
}
