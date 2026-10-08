import { Button } from "./ui";
import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * In-app confirmation dialog.
 *   if (await confirmDialog({ title: "¿Eliminar?", body: "…", danger: true })) …
 * Enter activates the focused button, which starts on the confirm button (Tab to Cancelar).
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!req) return;
    const previous = document.activeElement as HTMLElement | null;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close(false);
      } else if (e.key === "Enter") {
        // Native button activation respects Cancelar as well as Confirmar.
        e.stopPropagation();
        if (e.repeat || e.isComposing) e.preventDefault();
      } else if (e.key === "Tab") {
        const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button") || []);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", onKey, true); // capture: before the app's shortcuts
    return () => { window.removeEventListener("keydown", onKey, true); if (previous?.isConnected) previous.focus(); };
  }, [req]);

  if (!req) return null;
  return (
    <div data-modal className="ui-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={() => close(false)}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
        className="ui-dialog w-full max-w-sm rounded-2xl bg-zinc-900 p-5 shadow-[var(--shadow-pop)] ring-1 ring-ui-ink/[0.08]"
      >
        <div className="flex items-start gap-3">
          {req.danger && (
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500/12 text-danger ring-1 ring-red-400/20">
              <TriangleAlert className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0">
            <h2 id="confirm-title" className="text-[15px] font-semibold text-zinc-50">{req.title}</h2>
            {req.body && <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-line text-zinc-400">{req.body}</p>}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {!req.notice && (
            <Button ref={cancelRef} variant="ghost" onClick={() => close(false)}>
              Cancelar <span className="ml-1 font-mono text-[10px] text-zinc-500">esc</span>
            </Button>
          )}
          <Button
            ref={okRef}
            onClick={() => close(true)}
            variant={req.danger ? "danger" : "primary"}
            // a mouse-opened dialog gets no :focus-visible, so mark the default button explicitly
            className={req.danger ? "focus:bg-red-500/10 focus:ring-red-400/60" : ""}
          >
            {req.confirmLabel ?? "Confirmar"} <span className="font-mono text-[10px] opacity-70">↵</span>
          </Button>
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
  const { reportInfo } = await import("./notifications");
  try {
    const r = active
      ? await api<{ message?: string }>(`/api/projects/${card.project_id}/preview/stop`, {})
      : await api<{ message?: string }>(`/api/cards/${card.id}/preview`, {});
    if (r.message) reportInfo(r.message);
  } catch (e) {
    await notice(active ? "No pude volver a tu rama" : "No pude cambiar a la rama", (e as Error).message);
  }
}
