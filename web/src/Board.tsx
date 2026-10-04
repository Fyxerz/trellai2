import { flushDraft } from "./drafts";
import { reportError } from "./notifications";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { MachineChip } from "./SyncUI";
import { useSync } from "./api";
import { useEffect, useRef, useState } from "react";
import { COLUMNS, COLUMN_LABELS, type Card, type Column, type Tag } from "../../shared/types";
import { api, type Board as BoardState } from "./api";
import { ArrowRight, Eye, GitBranch, GitMerge, ListChecks, Play, Plus, Trash2 } from "lucide-react";
import { cardTags, TagChip, useProjectTags } from "./tags";
import { confirmDeleteCard } from "./Confirm";
import { Button, COLUMN_HEX, COLUMN_ICON, StatusBadge } from "./ui";
import { modelLabel, useEngines } from "./models";
import { prettyModel } from "../../shared/models";

const HINTS: Record<Column, string> = {
  backlog: "Ideas sueltas",
  plan: "Escribe tú la spec",
  preparation: "Claude pregunta o la pasa sola",
  doing: "Agentes en paralelo",
  review: "Revisa el diff",
  merged: "En la rama base",
};

/** Window events: which sidebar project a dragged card is over, and which one just received a copy. */
export const CARD_DROP_TARGET = "trellai:card-drop-target";
export const CARD_COPIED = "trellai:card-copied";

/** The card's next step, for the quick button on the card (same as the main button in its panel). */
const NEXT: Partial<Record<Column, { to: Column; label: string; Icon: typeof Play }>> = {
  backlog: { to: "plan", label: "Pasar a Plan", Icon: ArrowRight },
  plan: { to: "preparation", label: "Preparar", Icon: Play },
  review: { to: "merged", label: "Mergear", Icon: GitMerge },
};

/** Columns where you can create cards (the rest are driven by the workflow). */
export const CAN_ADD = new Set<Column>(["backlog", "plan"]);

export function columnCards(cards: Record<string, Card>, col: Column): Card[] {
  return Object.values(cards)
    .filter((c) => c.column === col)
    .sort((a, b) => a.position - b.position);
}

/** Move a card locally right away, then tell the server (which may start/stop agents). */
export async function moveCard(board: BoardState, id: string, to: Column, index: number) {
  try { await flushDraft(id); } catch (e) { reportError((e as Error).message); return; }
  board.setCards((prev) => {
    if (!prev[id]) return prev;
    const next = { ...prev };
    const from = next[id].column;
    const moved = { ...next[id], column: to };
    const dest = Object.values(next)
      .filter((c) => c.column === to && c.id !== id)
      .sort((a, b) => a.position - b.position);
    dest.splice(Math.max(0, Math.min(index, dest.length)), 0, moved);
    dest.forEach((c, i) => (next[c.id] = { ...c, position: i }));
    if (from !== to)
      Object.values(next)
        .filter((c) => c.column === from)
        .sort((a, b) => a.position - b.position)
        .forEach((c, i) => (next[c.id] = { ...c, position: i }));
    return next;
  });
  api(`/api/cards/${id}/move`, { column: to, index }).catch(async (e) => {
    reportError(e.message);
    const moved = board.cards[id];
    if (moved) {
      const cards = await api<Card[]>(`/api/projects/${moved.project_id}/cards`).catch(() => null);
      if (cards) board.setCards(Object.fromEntries(cards.map(c => [c.id, c])));
    }
  });
}

export function Board({
  projectId,
  board,
  onOpen,
  selectedId,
  adding,
  setAdding,
  cursor,
  focused,
  onCursor,
  previewCardId,
}: {
  previewCardId?: string | null;
  projectId: string;
  board: BoardState;
  onOpen: (id: string) => void;
  selectedId: string | null;
  adding: Column | null;
  setAdding: (c: Column | null) => void;
  /** keyboard cursor */
  cursor: { col: Column; id: string | null };
  focused: boolean;
  onCursor: (col: Column, id: string | null) => void;
}) {
  const byColumn = (col: Column) => columnCards(board.cards, col);
  const tags = useProjectTags(projectId, board);
  useEngines(); // re-render once the exact model versions are known

  // Dropping a card on another project in the sidebar copies it there.
  const dropTarget = useRef<string | null>(null);
  const stopTracking = useRef<() => void>(() => {});
  const setDropTarget = (id: string | null) => {
    if (dropTarget.current === id) return;
    dropTarget.current = id;
    window.dispatchEvent(new CustomEvent(CARD_DROP_TARGET, { detail: id }));
  };
  const onDragStart = () => {
    const onMove = (e: PointerEvent) => {
      const hit = document.elementsFromPoint(e.clientX, e.clientY).map((el) => el.closest<HTMLElement>("[data-drop-project]")).find(Boolean);
      const id = hit?.dataset.dropProject ?? null;
      setDropTarget(id && id !== projectId ? id : null);
    };
    window.addEventListener("pointermove", onMove, true);
    stopTracking.current = () => window.removeEventListener("pointermove", onMove, true);
  };
  useEffect(() => () => stopTracking.current(), []);

  const onDragEnd = (r: DropResult) => {
    stopTracking.current();
    const target = dropTarget.current;
    setDropTarget(null);
    if (target) {
      api(`/api/cards/${r.draggableId}/copy`, { project_id: target })
        .then(() => window.dispatchEvent(new CustomEvent(CARD_COPIED, { detail: target })))
        .catch((e) => reportError(e.message));
      return;
    }
    if (!r.destination) return;
    const to = r.destination.droppableId as Column;
    const from = r.source.droppableId as Column;
    if (to === from && r.destination.index === r.source.index) return;

    moveCard(board, r.draggableId, to, r.destination.index);
    onCursor(to, r.draggableId);
  };

  return (
    <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex h-full items-start gap-2.5 overflow-x-auto px-4 pt-1 pb-5">
        {COLUMNS.map((col) => {
          const cards = byColumn(col);
          const canAdd = CAN_ADD.has(col);
          const Icon = COLUMN_ICON[col];
          const active = focused && cursor.col === col;
          return (
            <section
              key={col}
              onDoubleClick={(e) => {
                if (!canAdd || (e.target as HTMLElement).closest("[data-card], input, textarea, button")) return;
                onCursor(col, null);
                setAdding(col);
              }}
              className={`surface flex max-h-full flex-col rounded-2xl transition-colors ${col === "merged" ? "min-w-[180px] flex-[0.75]" : "min-w-[240px] flex-1"} ${active ? "border-ui-ink/[0.11]" : ""}`}
            >
              <header className="group/h flex cursor-default items-center gap-2 px-3.5 pt-3 pb-2.5" title={HINTS[col]}>
                <Icon className="h-[15px] w-[15px]" style={{ color: COLUMN_HEX[col] }} strokeWidth={2.2} />
                <h2 className={`text-sm font-semibold tracking-tight ${active ? "text-zinc-100" : "text-zinc-200"}`}>{COLUMN_LABELS[col]}</h2>
                <span className="tabular rounded-full bg-ui-ink/[0.06] px-1.5 text-[11px] leading-[18px] text-zinc-400">{cards.length}</span>
                <span className="ml-auto truncate text-[11px] text-zinc-500 opacity-0 transition-opacity group-hover/h:opacity-100">{HINTS[col]}</span>
                {canAdd && (
                  <button
                    onClick={() => {
                      onCursor(col, null);
                      setAdding(col);
                    }}
                    className="-mr-1 rounded-md p-1 text-zinc-500 hover:bg-ui-ink/[0.06] hover:text-zinc-200"
                    title="Nueva tarjeta (n)"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </header>
              <Droppable droppableId={col}>
                {(p, snap) => (
                  <div
                    ref={p.innerRef}
                    {...p.droppableProps}
                    className={`group relative flex min-h-12 flex-col gap-2 overflow-y-auto rounded-b-2xl px-2 pb-12 transition-colors ${snap.isDraggingOver ? "bg-indigo-500/10" : ""} ${canAdd ? "cursor-cell" : ""}`}
                  >
                    {cards.map((card, i) => (
                      <Draggable key={card.id} draggableId={card.id} index={i}>
                        {(dp, ds) => (
                          <div ref={dp.innerRef} {...dp.draggableProps} {...dp.dragHandleProps} data-card className="cursor-pointer">
                            <CardItem
                              card={card}
                              dragging={ds.isDragging}
                              selected={card.id === selectedId}
                              cursor={focused && cursor.id === card.id}
                              previewing={previewCardId === card.id}
                              tags={cardTags(card, tags)}
                              onAdvance={(to) => {
                                moveCard(board, card.id, to, Number.MAX_SAFE_INTEGER);
                                onCursor(to, card.id);
                              }}
                              onClick={() => {
                                onCursor(col, card.id);
                                onOpen(card.id);
                              }}
                            />
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {p.placeholder}
                    {canAdd && adding !== col && <button onClick={() => { onCursor(col, null); setAdding(col); }} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-ui-ink/5 hover:text-zinc-100"><Plus className="h-4 w-4" /> Añadir tarjeta</button>}
                    {adding === col && <NewCardInput projectId={projectId} column={col} onDone={() => setAdding(null)} />}
                    {cards.length === 0 && adding !== col && !snap.isDraggingOver && (
                      <div className="pointer-events-none mx-1 mt-0.5 rounded-xl border border-dashed border-ui-ink/[0.06] px-3 py-4 text-center text-[11px] text-zinc-600">
                        {canAdd ? "Doble clic para añadir" : EMPTY[col]}
                      </div>
                    )}
                    {canAdd && cards.length > 0 && adding !== col && !snap.isDraggingOver && (
                      <span className="pointer-events-none absolute bottom-3 left-3.5 text-[11px] text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100">
                        Doble clic para añadir
                      </span>
                    )}
                  </div>
                )}
              </Droppable>
            </section>
          );
        })}
      </div>
    </DragDropContext>
  );
}

const EMPTY: Record<Column, string> = {
  backlog: "",
  plan: "",
  preparation: "Suelta aquí una tarjeta de Plan",
  doing: "Nadie trabajando ahora",
  review: "Nada pendiente de revisar",
  merged: "Aún no hay nada mergeado",
};

function CardItem({
  card,
  dragging,
  selected,
  cursor,
  previewing,
  tags,
  onAdvance,
  onClick,
}: {
  card: Card;
  dragging: boolean;
  selected: boolean;
  cursor: boolean;
  previewing: boolean;
  tags: Tag[];
  onAdvance: (to: Column) => void;
  onClick: () => void;
}) {
  const next = card.status === "running" ? undefined : NEXT[card.column];
  // While an agent works on it: the exact model it runs. Otherwise the card's own choice, if any.
  const agentShown = !!card.agent_model && ["preparation", "doing", "review"].includes(card.column);
  const modelChip = agentShown
    ? { label: prettyModel(card.agent_model), title: `Modelo del agente: ${card.agent_model}`, codex: card.agent_model!.startsWith("codex") }
    : card.model
      ? { label: modelLabel(card.model, true), title: `Modelo elegido: ${modelLabel(card.model)}`, codex: card.model.startsWith("codex") }
      : null;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (cursor) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cursor]);
  const merged = card.column === "merged";
  const accent = card.status === "waiting" ? "#a78bfa" : card.status === "error" ? "#f87171" : null;
  const done = card.checkpoints_total > 0 && card.checkpoints_done === card.checkpoints_total;
  const showBranch = card.branch && (card.column === "doing" || card.column === "review");
  const sync = useSync();
  const elsewhere = !merged && !!card.machine && !!sync?.enabled && card.machine !== sync.machine && ["preparation", "doing", "review"].includes(card.column);

  return (
    <div
      ref={ref}
      onClick={onClick}
      style={{ boxShadow: dragging ? "var(--shadow-pop)" : "var(--shadow-card)" }}
      className={[
        "group/card relative overflow-hidden rounded-[var(--radius-card)] border bg-zinc-900 px-3 py-2.5 transition-all duration-150",
        card.status === "running" ? "working" : "",
        cursor
          ? "border-indigo-400/70 ring-2 ring-indigo-400/25"
          : selected
            ? "border-indigo-400/40"
            : "border-ui-ink/[0.06] hover:-translate-y-px hover:border-ui-ink/[0.12] hover:bg-zinc-800",
        dragging ? "rotate-[1.5deg]" : "",
        merged ? "opacity-55 hover:opacity-90" : "",
      ].join(" ")}
    >
      {accent && <span className="absolute inset-y-2 left-0 w-[2px] rounded-full" style={{ background: accent }} />}
      <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
        {next && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAdvance(next.to);
            }}
            className="invisible flex items-center gap-1 rounded-md bg-indigo-500 px-1.5 py-1 text-[11px] leading-none font-medium text-white opacity-0 shadow-sm transition group-hover/card:visible group-hover/card:opacity-100 hover:bg-indigo-400"
            title={next.label}
          >
            <next.Icon className="h-3 w-3" /> {next.label}
          </button>
        )}
        <button
          onClick={async (e) => {
            e.stopPropagation();
            if (await confirmDeleteCard(card)) api(`/api/cards/${card.id}`, undefined, "DELETE").catch((err) => reportError(err.message));
          }}
          className="rounded-md bg-zinc-900/90 p-1 text-zinc-500 opacity-0 ring-1 ring-ui-ink/[0.06] transition group-hover/card:opacity-100 focus-visible:opacity-100 hover:bg-red-500/15 hover:text-red-300"
          title="Eliminar tarjeta (x)"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {tags.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {tags.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
        </div>
      )}
      <div className="flex items-start gap-2">
        <div className={`min-w-0 flex-1 text-sm leading-snug font-medium ${merged ? "text-zinc-400 line-through decoration-zinc-600" : "text-zinc-100"}`}>
          {card.title}
        </div>
        {previewing && (
          <span className="mt-0.5 flex shrink-0 items-center gap-1 rounded-md bg-teal-400/12 px-1.5 text-[10px] leading-[16px] font-semibold text-teal-200" title="Esta rama está puesta en tu repo">
            <Eye className="h-3 w-3" /> en tu repo
          </span>
        )}
        {modelChip && !merged && (
          <span
            className={`mt-0.5 shrink-0 rounded-md px-1.5 text-[10px] leading-[16px] font-semibold ${modelChip.codex ? "bg-emerald-400/10 text-emerald-300" : "bg-orange-400/10 text-orange-300"}`}
            title={modelChip.title}
          >
            {modelChip.label}
          </span>
        )}
      </div>
      {card.spec && !merged && <div className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-500">{specPreview(card.spec)}</div>}

      {(card.status !== "idle" || (card.status_text && !merged) || elsewhere) && (
        <div className="mt-2 flex min-w-0 items-center gap-2">
          <StatusBadge card={card} />
          {elsewhere && <MachineChip machine={card.machine} className="shrink-0" />}
          {card.status_text && card.status !== "running" && (
            <span className={`truncate text-[11px] ${card.status === "error" ? "text-red-300/80" : "text-zinc-500"}`}>{card.status_text}</span>
          )}
        </div>
      )}

      {(card.checkpoints_total > 0 || showBranch) && !merged && (
        <div className="mt-2.5 flex items-center gap-2.5">
          {card.checkpoints_total > 0 && (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-ui-ink/[0.06]">
                <div
                  className={`h-full rounded-full transition-all ${done ? "bg-emerald-400" : "bg-indigo-400"}`}
                  style={{ width: `${(card.checkpoints_done / card.checkpoints_total) * 100}%` }}
                />
              </div>
              <span className={`tabular flex items-center gap-1 text-[10.5px] ${done ? "text-emerald-300" : "text-zinc-500"}`}>
                <ListChecks className="h-3 w-3" />
                {card.checkpoints_done}/{card.checkpoints_total}
              </span>
            </div>
          )}
          {showBranch && (
            <span className={`flex min-w-0 items-center gap-1 font-mono text-[10px] text-zinc-600 ${card.checkpoints_total > 0 ? "max-w-[45%]" : ""}`} title={card.branch!}>
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="truncate">{card.branch!.replace(/^trellai\//, "")}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Explicit creation: leaving the input never creates a card or discards its draft. */
function NewCardInput({ projectId, column, onDone }: { projectId: string; column: Column; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const create = async () => {
    const t = title.trim();
    if (!t || busy.current) return;
    busy.current = true; setSaving(true); setError("");
    try { await api<Card>("/api/cards", { project_id: projectId, title: t, column }); setTitle(""); }
    catch (e) { setError((e as Error).message); }
    finally { busy.current = false; setSaving(false); requestAnimationFrame(() => input.current?.focus()); }
  };
  return <div className="rounded-xl border border-indigo-400/50 bg-zinc-900 p-2">
    <input ref={input} aria-label="Título de la nueva tarjeta" autoFocus value={title} readOnly={saving} onChange={e => setTitle(e.target.value)} onKeyDown={e => {
      if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); if (!e.repeat) void create(); }
      if (e.key === "Escape") { e.stopPropagation(); if (!saving) onDone(); }
    }} placeholder="Título de la tarjeta…" className="w-full rounded-lg bg-transparent px-2 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500" />
    {error && <p role="alert" className="px-2 py-1 text-xs text-red-300">{error}</p>}
    <div className="mt-1 flex items-center justify-end gap-2"><Button size="sm" onClick={onDone} disabled={saving}>Cancelar</Button><Button size="sm" variant="primary" onClick={create} disabled={!title.trim() || saving}>{saving ? "Creando…" : "Añadir ↵"}</Button></div>
  </div>;
}

/** First lines of the spec without markdown headings or symbols. */
function specPreview(spec: string) {
  return spec
    .split("\n")
    .filter((l) => !/^\s*(\*\*[^*]+\*\*:?|#+\s.*)\s*$/.test(l))
    .join(" ")
    .replace(/[#*`>]/g, "")
    .replace(/^\s*-\s+/g, "")
    .trim();
}
