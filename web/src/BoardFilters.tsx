import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Tags, Users } from "lucide-react";
import { type Tag } from "../../shared/types";
import { Avatar, usePeople } from "./People";

type Option = { id: string; label: string; icon: ReactNode };

/** Compact button that opens a checkbox list. `value` = chosen ids (empty = no filter). */
function MultiFilter({ label, icon, options, value, onChange }: { label: string; icon: ReactNode; options: Option[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  const active = value.length > 0;
  return (
    <div ref={ref} className="relative">
      <button
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm ring-1 transition ${active ? "bg-indigo-500/10 text-accent ring-indigo-400/30" : "text-zinc-400 ring-ui-ink/10 hover:bg-ui-ink/5 hover:text-zinc-200"}`}
      >
        {icon}
        {label}
        {active && <span className="rounded-full bg-indigo-500/20 px-1.5 text-[11px] leading-4 font-semibold">{value.length}</span>}
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>
      {open && (
        <div role="menu" className="absolute top-full left-0 z-50 mt-1 max-h-72 w-56 overflow-y-auto rounded-xl bg-panel p-1 shadow-[var(--shadow-pop)] ring-1 ring-ui-ink/[0.1]">
          {options.map((o) => {
            const on = value.includes(o.id);
            return (
              <button key={o.id} role="menuitemcheckbox" aria-checked={on} onClick={() => toggle(o.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-300 hover:bg-ui-ink/5">
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "border-indigo-400 bg-indigo-500 text-white" : "border-ui-ink/20"}`}>{on && <Check className="h-3 w-3" />}</span>
                {o.icon}
                <span className="min-w-0 truncate">{o.label}</span>
              </button>
            );
          })}
          {active && (
            <button onClick={() => onChange([])} className="mt-1 w-full rounded-lg border-t border-ui-ink/10 px-2 py-1.5 text-left text-xs text-zinc-500 hover:bg-ui-ink/5">
              Quitar filtro
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** "Personas" (only with more than one person) and "Etiquetas" (only if the project has tags) filters for the board bar. */
export function BoardFilters({ tags, people: chosenPeople, setPeople, tagIds, setTagIds }: { tags: Tag[]; people: string[]; setPeople: (v: string[]) => void; tagIds: string[]; setTagIds: (v: string[]) => void }) {
  const { people } = usePeople();
  return (
    <>
      {people.length > 1 && (
        <MultiFilter
          label="Por persona"
          icon={<Users className="h-4 w-4" />}
          value={chosenPeople}
          onChange={setPeople}
          options={people.map((p) => ({ id: p.id, label: p.name, icon: <Avatar person={p} size={18} /> }))}
        />
      )}
      {tags.length > 0 && (
        <MultiFilter
          label="Por etiqueta"
          icon={<Tags className="h-4 w-4" />}
          value={tagIds}
          onChange={setTagIds}
          options={tags.map((t) => ({ id: t.id, label: t.name, icon: <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color }} /> }))}
        />
      )}
    </>
  );
}
