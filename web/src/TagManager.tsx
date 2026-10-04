import { useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { TAG_COLORS, TAG_PALETTE, type Tag } from "../../shared/types";
import { api } from "./api";
import { confirmDialog } from "./Confirm";
import { ModelPicker } from "./models";
import { reportError } from "./notifications";
import { useDialogFocus } from "./preferences";

/** Modal to manage a project's tags: name, color (from a grid) and the model cards with that tag use. */
export function TagManager({ projectId, onClose, onChanged }: { projectId: string; onClose: () => void; onChanged?: () => void }) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [picking, setPicking] = useState<string | null>(null);
  const [name, setName] = useState("");
  const dialogRef = useDialogFocus();
  const url = `/api/projects/${projectId}/tags`;
  const load = () => api<Tag[]>(url).then(setTags).catch(() => {});
  useEffect(() => void load(), [projectId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (picking) setPicking(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, picking]);

  const run = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      reportError((e as Error).message);
    }
    await load();
    onChanged?.();
  };
  const patch = (t: Tag, body: Partial<Tag>) =>
    run(
      api<Tag | null>(`${url}/${t.id}`, body, "PATCH").then((saved) => {
        // A server that predates tag models answers without `model`: the UI was updated but the server wasn't restarted yet.
        if ("model" in body && saved && (saved.model ?? null) !== (body.model ?? null)) {
          throw new Error("El servidor aún no tiene esta versión y no ha guardado el modelo. Se reinicia solo cuando no haya agentes trabajando; vuelve a probar entonces.");
        }
      }),
    );
  const rename = (t: Tag, value: string) => {
    const v = value.trim();
    if (v && v !== t.name) void patch(t, { name: v });
  };
  const remove = async (t: Tag) => {
    const ok = await confirmDialog({ title: `¿Borrar la etiqueta "${t.name}"?`, body: "Se quitará de todas las tarjetas del proyecto.", confirmLabel: "Borrar", danger: true });
    if (ok) void run(api(`${url}/${t.id}`, undefined, "DELETE"));
  };
  const create = async () => {
    const v = name.trim();
    if (!v) return;
    setName("");
    await run(api(url, { name: v, color: TAG_COLORS[tags.length % TAG_COLORS.length] }));
  };

  return (
    <div data-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Gestionar etiquetas"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-xl flex-col gap-4 rounded-2xl bg-zinc-900 p-5 ring-1 ring-ui-ink/[0.08] shadow-[var(--shadow-pop)]"
      >
        <div className="flex items-start">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Etiquetas</h2>
            <p className="text-xs text-zinc-500">
              Color y modelo de cada etiqueta. Al desarrollar, una tarjeta usa el modelo de su primera etiqueta con modelo (en este orden), salvo que la tarjeta elija el suyo.
            </p>
          </div>
          <button onClick={onClose} aria-label="Cerrar" className="ml-auto rounded-lg p-1.5 text-zinc-500 hover:bg-ui-ink/5 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <ul className="-mx-1 space-y-1 overflow-y-auto px-1">
          {tags.map((t) => (
            <li key={t.id} className="rounded-xl bg-zinc-950/60 p-2 ring-1 ring-ui-ink/[0.05]">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPicking(picking === t.id ? null : t.id)}
                  className="h-6 w-6 shrink-0 rounded-md ring-1 ring-black/20 transition hover:scale-105"
                  style={{ background: t.color }}
                  title="Cambiar color"
                  aria-label={`Cambiar color de ${t.name}`}
                  aria-expanded={picking === t.id}
                />
                <input
                  key={t.name}
                  defaultValue={t.name}
                  maxLength={40}
                  onBlur={(e) => rename(t, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  aria-label={`Nombre de ${t.name}`}
                  className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-sm text-zinc-100 outline-none ring-ui-ink/[0.08] hover:ring-1 focus:ring-1 focus:ring-indigo-500/60"
                />
                <ModelPicker
                  value={t.model ?? null}
                  inheritLabel="Sin modelo (usa el del proyecto)"
                  title="Modelo con el que se desarrollan las tarjetas con esta etiqueta"
                  onChange={(model) => patch(t, { model })}
                  className="w-64 shrink-0"
                />
                <button
                  onClick={() => remove(t)}
                  className="rounded p-1.5 text-zinc-600 transition hover:bg-red-500/10 hover:text-red-300"
                  title="Borrar etiqueta"
                  aria-label={`Borrar etiqueta ${t.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {picking === t.id && (
                <div className="mt-2 grid grid-cols-12 gap-1.5 px-1 pb-1" role="radiogroup" aria-label={`Color de ${t.name}`}>
                  {TAG_PALETTE.map((c) => (
                    <button
                      key={c}
                      role="radio"
                      aria-checked={t.color.toLowerCase() === c}
                      aria-label={c}
                      onClick={() => {
                        setPicking(null);
                        if (t.color.toLowerCase() !== c) void patch(t, { color: c });
                      }}
                      className={`aspect-square rounded-md transition hover:scale-110 ${t.color.toLowerCase() === c ? "ring-2 ring-zinc-100 ring-offset-2 ring-offset-zinc-950" : "ring-1 ring-black/20"}`}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              )}
            </li>
          ))}
          {!tags.length && <li className="px-2 py-3 text-sm text-zinc-500">Aún no hay etiquetas.</li>}
        </ul>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          className="flex items-center gap-2"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nueva etiqueta…"
            aria-label="Nombre de la nueva etiqueta"
            maxLength={40}
            className="min-w-0 flex-1 rounded-lg bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none ring-1 ring-ui-ink/[0.06] placeholder:text-zinc-600 focus:ring-indigo-500/60"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-indigo-300 ring-1 ring-indigo-500/30 hover:bg-indigo-500/10 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" /> Crear
          </button>
        </form>
      </div>
    </div>
  );
}
