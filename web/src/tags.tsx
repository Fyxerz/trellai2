import { useEffect, useRef, useState } from "react";
import { Check, Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { TAG_COLORS, type Card, type Tag } from "../../shared/types";
import { api, type Board } from "./api";
import { confirmDialog } from "./Confirm";
import { reportError } from "./notifications";

/** The project's tags, live (local changes, other tabs and other computers). */
export function useProjectTags(projectId: string | null | undefined, board: Board) {
  const [tags, setTags] = useState<Tag[]>([]);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const load = () => api<Tag[]>(`/api/projects/${projectId}/tags`).then((t) => alive && setTags(t)).catch(() => {});
    load();
    const off = board.on((e) => {
      if (e.type === "tags") setTags(e.tags);
      else if (e.type === "sync") load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [projectId]);
  return tags;
}

export function TagChip({ tag, className = "" }: { tag: Tag; className?: string }) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-md px-1.5 text-[10.5px] leading-[18px] font-medium ${className}`}
      style={{ background: `${tag.color}22`, color: tag.color }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tag.color }} />
      <span className="truncate">{tag.name}</span>
    </span>
  );
}

/** The card's tags, in the project's order. */
export function cardTags(card: Card, tags: Tag[]) {
  return tags.filter((t) => card.tags?.includes(t.id));
}

/** Tags on the card + a popover to add/remove them and to create, recolor or delete project tags. */
export function TagPicker({ card, tags }: { card: Card; tags: Tag[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const on = cardTags(card, tags);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const setCardTags = (ids: string[]) => api(`/api/cards/${card.id}`, { tags: ids }, "PATCH").catch((e) => reportError(e.message));
  const toggle = (t: Tag) => setCardTags(card.tags.includes(t.id) ? card.tags.filter((id) => id !== t.id) : [...card.tags, t.id]);
  const create = async () => {
    const name = query.trim();
    if (!name) return;
    try {
      const tag = await api<Tag>(`/api/projects/${card.project_id}/tags`, { name });
      setQuery("");
      await setCardTags([...card.tags, tag.id]);
    } catch (e) {
      reportError((e as Error).message);
    }
  };
  const recolor = (t: Tag) =>
    api(`/api/projects/${card.project_id}/tags/${t.id}`, { color: TAG_COLORS[(TAG_COLORS.indexOf(t.color) + 1) % TAG_COLORS.length] }, "PATCH").catch((e) =>
      reportError(e.message),
    );
  const remove = async (t: Tag) => {
    const ok = await confirmDialog({ title: `¿Borrar la etiqueta "${t.name}"?`, body: "Se quitará de todas las tarjetas del proyecto.", confirmLabel: "Borrar", danger: true });
    if (!ok) return;
    api(`/api/projects/${card.project_id}/tags/${t.id}`, undefined, "DELETE").catch((e) => reportError(e.message));
  };

  const q = query.trim().toLowerCase();
  const shown = tags.filter((t) => t.name.toLowerCase().includes(q));
  const exact = tags.some((t) => t.name.toLowerCase() === q);

  return (
    <div ref={root} className="relative mt-2 flex flex-wrap items-center gap-1.5">
      {on.map((t) => (
        <TagChip key={t.id} tag={t} />
      ))}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-1.5 text-[11px] leading-[20px] text-zinc-500 ring-1 ring-ui-ink/[0.08] transition hover:bg-ui-ink/[0.05] hover:text-zinc-200"
        title="Etiquetas"
        aria-expanded={open}
      >
        {on.length ? <Plus className="h-3 w-3" /> : <TagIcon className="h-3 w-3" />}
        {on.length ? "" : "Etiquetas"}
      </button>
      {open && (
        <div
          className="absolute top-full left-0 z-30 mt-1.5 w-64 rounded-xl bg-zinc-900 p-1.5 shadow-[var(--shadow-pop)] ring-1 ring-ui-ink/[0.1]"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              e.stopPropagation();
              if (!exact && q) void create();
              else if (shown.length === 1) void toggle(shown[0]);
            }}
            placeholder="Buscar o crear etiqueta…"
            aria-label="Buscar o crear etiqueta"
            className="mb-1 w-full rounded-lg bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none ring-1 ring-ui-ink/[0.06] placeholder:text-zinc-600 focus:ring-indigo-500/60"
          />
          <ul className="max-h-60 overflow-y-auto">
            {shown.map((t) => (
              <li key={t.id} className="group/tag flex items-center gap-1 rounded-lg hover:bg-ui-ink/[0.05]">
                <button
                  onClick={() => recolor(t)}
                  className="ml-1.5 h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-black/20"
                  style={{ background: t.color }}
                  title="Cambiar color"
                  aria-label={`Cambiar color de ${t.name}`}
                />
                <button onClick={() => toggle(t)} className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left text-sm text-zinc-200">
                  <span className="truncate">{t.name}</span>
                  {card.tags.includes(t.id) && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-indigo-300" />}
                </button>
                <button
                  onClick={() => remove(t)}
                  className="mr-1 rounded p-1 text-zinc-600 opacity-0 transition group-hover/tag:opacity-100 hover:text-red-300"
                  title="Borrar etiqueta del proyecto"
                  aria-label={`Borrar etiqueta ${t.name}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
            {!tags.length && !q && <li className="px-2.5 py-2 text-xs text-zinc-500">Aún no hay etiquetas. Escribe un nombre y pulsa Enter.</li>}
          </ul>
          {q && !exact && (
            <button onClick={create} className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-indigo-300 hover:bg-indigo-500/10">
              <Plus className="h-3.5 w-3.5" /> Crear «{query.trim()}»
            </button>
          )}
        </div>
      )}
    </div>
  );
}
