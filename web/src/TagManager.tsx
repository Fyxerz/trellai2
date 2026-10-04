import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { GripVertical, Plus, Trash2, X } from "lucide-react";
import { TAG_COLORS, TAG_PALETTE, type Tag } from "../../shared/types";
import { api } from "./api";
import { confirmDialog } from "./Confirm";
import { ModelPicker } from "./models";
import { reportError } from "./notifications";
import { setTagHover, tagLanded } from "./tagDrag";

/** The board card under the pointer (cards carry data-card-id / data-card-tags). */
function cardAt(x: number, y: number) {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-card-id]");
  return el ? { id: el.dataset.cardId!, tags: (el.dataset.cardTags || "").split(",").filter(Boolean) } : null;
}

/** Inline block to manage a project's tags: name, color (from a grid), the model cards with that tag use, and (on the board) drag a tag onto a card. */
export function TagManager({
  projectId,
  tags,
  draggable = false,
  className = "",
  onClose,
}: {
  projectId: string;
  tags: Tag[];
  draggable?: boolean;
  className?: string;
  /** when set, a click outside the block (but not on [data-tags-toggle]) closes it */
  onClose?: () => void;
}) {
  const [picking, setPicking] = useState<string | null>(null);
  const [addingModel, setAddingModel] = useState<string | null>(null);
  const [name, setName] = useState("");
  /** the tag being dragged onto a card, and where the pointer is */
  const [drag, setDrag] = useState<{ tag: Tag; x: number; y: number; over: boolean } | null>(null);
  const dragging = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onClose) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Element;
      if (dragging.current || root.current?.contains(t) || t.closest?.("[data-tags-toggle], [data-modal]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  const url = `/api/projects/${projectId}/tags`;

  /** Press on a tag row (not on its fields) and move: a block follows the pointer; drop it on a board card to tag it. */
  const startDrag = (e: ReactPointerEvent, t: Tag) => {
    if (e.button !== 0 || (e.target as Element).closest("input, select, textarea")) return;
    const x0 = e.clientX, y0 = e.clientY;
    let active = false;
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        active = dragging.current = true;
        setPicking(null);
        (document.activeElement as HTMLElement | null)?.blur();
        window.getSelection()?.removeAllRanges();
        document.body.style.cursor = "grabbing";
      }
      ev.preventDefault();
      const card = cardAt(ev.clientX, ev.clientY);
      setTagHover(card && !card.tags.includes(t.id) ? { tag: t, cardId: card.id } : null);
      setDrag({ tag: t, x: ev.clientX, y: ev.clientY, over: !!card });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!active) return;
      document.body.style.cursor = "";
      setDrag(null);
      setTagHover(null);
      // the click that ends a drag must not open the card underneath
      const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => {
        window.removeEventListener("click", swallow, { capture: true });
        dragging.current = false;
      }, 0);
      const card = ev.type === "pointerup" ? cardAt(ev.clientX, ev.clientY) : null;
      if (!card) return;
      tagLanded(t, card.id);
      if (!card.tags.includes(t.id))
        api(`/api/cards/${card.id}`, { tags: [...card.tags, t.id] }, "PATCH").catch((err) => reportError((err as Error).message));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const run = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      reportError((e as Error).message);
    }
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
    await run(api(url, { name: v, color: TAG_COLORS[tags.length % TAG_COLORS.length], model: null }));
  };

  return (
    <div
      ref={root}
      className={`flex flex-col gap-2 ${className}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && picking) {
          e.stopPropagation();
          setPicking(null);
        }
      }}
    >
      <p className="text-xs text-zinc-500">
        {draggable && "Arrastra una etiqueta sobre una tarjeta para ponérsela. "}
        Una tarjeta usa el modelo de la primera etiqueta que se le puso con modelo; si ninguna tiene, el del proyecto (salvo que la tarjeta elija el suyo).
      </p>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(19rem,100%),1fr))] gap-1.5">
        {tags.map((t) => (
          <li
            key={t.id}
            onPointerDown={draggable ? (e) => startDrag(e, t) : undefined}
            className={`rounded-xl bg-zinc-950/60 p-1.5 ring-1 ring-ui-ink/[0.05] transition ${draggable ? "cursor-grab" : ""} ${drag?.tag.id === t.id ? "opacity-40" : ""}`}
            title={draggable ? "Arrastra a una tarjeta para ponerle la etiqueta" : undefined}
          >
            <div className="tag-editor-row flex items-center gap-1.5">
              {draggable && (
                <GripVertical className="-mr-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden />
              )}
              <button
                onClick={() => setPicking(picking === t.id ? null : t.id)}
                className="h-5 w-5 shrink-0 rounded-md ring-1 ring-black/20 transition hover:scale-105"
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
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  else if (e.key === "Escape") {
                    e.stopPropagation();
                    (e.target as HTMLInputElement).value = t.name;
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                aria-label={`Nombre de ${t.name}`}
                className="ui-field ui-control min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-0.5 text-sm text-zinc-100 outline-none ring-ui-ink/[0.08] hover:ring-1 focus:ring-1 focus:ring-indigo-500/60"
              />
              {t.model || addingModel === t.id ? (
                <>
                  <ModelPicker
                    value={t.model ?? null}
                    inheritLabel="Sin modelo"
                    title="Modelo con el que se desarrollan las tarjetas con esta etiqueta"
                    onChange={(model) => {
                      setAddingModel(null);
                      void patch(t, { model });
                    }}
                    className="model-picker w-40 shrink-0 max-w-full"
                  />
                  <button
                    onClick={() => {
                      setAddingModel(null);
                      if (t.model) void patch(t, { model: null });
                    }}
                    className="rounded p-1 text-zinc-600 transition hover:bg-ui-ink/5 hover:text-zinc-200"
                    title="Quitar el modelo de esta etiqueta"
                    aria-label={`Quitar modelo de ${t.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setAddingModel(t.id)}
                  className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-500 ring-1 ring-ui-ink/[0.08] transition hover:bg-ui-ink/5 hover:text-zinc-200"
                  title="Asignar un modelo a esta etiqueta"
                >
                  <Plus className="h-3 w-3" /> Modelo
                </button>
              )}
              <button
                onClick={() => remove(t)}
                className="rounded p-1 text-zinc-600 transition hover:bg-red-500/10 hover:text-danger"
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
        {!tags.length && <li className="px-2 py-1 text-sm text-zinc-500">Aún no hay etiquetas.</li>}
      </ul>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        className="tag-editor-row flex max-w-sm items-center gap-2"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              if (name) setName("");
              else e.currentTarget.blur();
            }
          }}
          placeholder="Nueva etiqueta…"
          aria-label="Nombre de la nueva etiqueta"
          maxLength={40}
          className="ui-field ui-control min-w-0 flex-1 rounded-lg bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none ring-1 ring-ui-ink/[0.06] placeholder:text-zinc-600 focus:ring-indigo-500/60"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-accent ring-1 ring-indigo-500/30 hover:bg-indigo-500/10 disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" /> Crear
        </button>
      </form>
      {drag &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[70] flex items-center gap-2 rounded-xl bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-100 ring-1 transition-transform duration-150"
            style={{
              left: drag.x,
              top: drag.y,
              transform: `translate(-30%, -50%) rotate(${drag.over ? 0 : -3}deg) scale(${drag.over ? 0.9 : 1})`,
              boxShadow: `var(--shadow-pop), 0 0 0 1px ${drag.tag.color}55`,
              ["--tw-ring-color" as string]: `${drag.tag.color}66`,
            }}
          >
            <span className="h-3 w-3 rounded-full" style={{ background: drag.tag.color }} />
            {drag.tag.name}
            {drag.over && <span className="text-[11px] font-normal text-zinc-400">soltar para poner</span>}
          </div>,
          document.body,
        )}
    </div>
  );
}
