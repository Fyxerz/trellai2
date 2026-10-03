import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { MachineChip } from "./SyncUI";
import { useSync } from "./api";
import { useEffect, useRef, useState } from "react";
import { COLUMNS, COLUMN_LABELS, type Card, type Column } from "../../shared/types";
import { api, type Board as BoardState } from "./api";
import { Eye, GitBranch, ListChecks, Plus, Trash2 } from "lucide-react";
import { confirmDeleteCard } from "./Confirm";
import { COLUMN_HEX, COLUMN_ICON, StatusBadge } from "./ui";
import { modelLabel } from "./models";

const HINTS: Record<Column, string> = {
  backlog: "Ideas sueltas",
  plan: "Escribe tú la spec",
  preparation: "Claude pregunta o la pasa sola",
  doing: "Agentes en paralelo",
  review: "Revisa el diff",
  merged: "En la rama base",
};

/** Columns where you can create cards (the rest are driven by the workflow). */
export const CAN_ADD = new Set<Column>(["backlog", "plan"]);

export function columnCards(cards: Record<string, Card>, col: Column): Card[] {
  return Object.values(cards)
    .filter((c) => c.column === col)
    .sort((a, b) => a.position - b.position);
}

/** Move a card locally right away, then tell the server (which may start/stop agents). */
export function moveCard(board: BoardState, id: string, to: Column, index: number) {
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
  api(`/api/cards/${id}/move`, { column: to, index }).catch((e) => alert(e.message));
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

  const onDragEnd = (r: DropResult) => {
    if (!r.destination) return;
    const to = r.destination.droppableId as Column;
    const from = r.source.droppableId as Column;
    if (to === from && r.destination.index === r.source.index) return;

    moveCard(board, r.draggableId, to, r.destination.index);
    onCursor(to, r.draggableId);
  };

  return (
    <DragDropContext onDragEnd={onDragEnd}>
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
              className={`surface flex max-h-full flex-col rounded-2xl transition-colors ${col === "merged" ? "min-w-[180px] flex-[0.75]" : "min-w-[214px] flex-1"} ${active ? "border-white/[0.11]" : ""}`}
            >
              <header className="group/h flex cursor-default items-center gap-2 px-3.5 pt-3 pb-2.5" title={HINTS[col]}>
                <Icon className="h-[15px] w-[15px]" style={{ color: COLUMN_HEX[col] }} strokeWidth={2.2} />
                <h2 className={`text-[13px] font-semibold tracking-tight ${active ? "text-white" : "text-zinc-200"}`}>{COLUMN_LABELS[col]}</h2>
                <span className="tabular rounded-full bg-white/[0.06] px-1.5 text-[11px] leading-[18px] text-zinc-400">{cards.length}</span>
                <span className="ml-auto truncate text-[11px] text-zinc-500 opacity-0 transition-opacity group-hover/h:opacity-100">{HINTS[col]}</span>
                {canAdd && (
                  <button
                    onClick={() => {
                      onCursor(col, null);
                      setAdding(col);
                    }}
                    className="-mr-1 rounded-md p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
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
                    className={`group relative flex min-h-12 flex-col gap-2 overflow-y-auto rounded-b-2xl px-2 pb-12 transition-colors ${snap.isDraggingOver ? "bg-white/[0.025]" : ""} ${canAdd ? "cursor-cell" : ""}`}
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
                    {adding === col && <NewCardInput projectId={projectId} column={col} onDone={() => setAdding(null)} />}
                    {cards.length === 0 && adding !== col && !snap.isDraggingOver && (
                      <div className="pointer-events-none mx-1 mt-0.5 rounded-xl border border-dashed border-white/[0.06] px-3 py-4 text-center text-[11px] text-zinc-600">
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
  onClick,
}: {
  card: Card;
  dragging: boolean;
  selected: boolean;
  cursor: boolean;
  previewing: boolean;
  onClick: () => void;
}) {
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
        "group relative overflow-hidden rounded-[var(--radius-card)] border bg-zinc-900 px-3 py-2.5 transition-all duration-150",
        card.status === "running" ? "working" : "",
        cursor
          ? "border-indigo-400/70 ring-2 ring-indigo-400/25"
          : selected
            ? "border-indigo-400/40"
            : "border-white/[0.06] hover:-translate-y-px hover:border-white/[0.12] hover:bg-[#191b20]",
        dragging ? "rotate-[1.5deg]" : "",
        merged ? "opacity-55 hover:opacity-90" : "",
      ].join(" ")}
    >
      {accent && <span className="absolute inset-y-2 left-0 w-[2px] rounded-full" style={{ background: accent }} />}
      <button
        onClick={async (e) => {
          e.stopPropagation();
          if (await confirmDeleteCard(card)) api(`/api/cards/${card.id}`, undefined, "DELETE").catch((err) => alert(err.message));
        }}
        className="absolute top-1.5 right-1.5 z-10 rounded-md bg-zinc-900/90 p-1 text-zinc-500 opacity-0 ring-1 ring-white/[0.06] transition group-hover:opacity-100 hover:bg-red-500/15 hover:text-red-300"
        title="Eliminar tarjeta (x)"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <div className="flex items-start gap-2">
        <div className={`min-w-0 flex-1 text-[13.5px] leading-snug font-medium ${merged ? "text-zinc-400 line-through decoration-zinc-600" : "text-zinc-100"}`}>
          {card.title}
        </div>
        {previewing && (
          <span className="mt-0.5 flex shrink-0 items-center gap-1 rounded-md bg-teal-400/12 px-1.5 text-[10px] leading-[16px] font-semibold text-teal-200" title="Esta rama está puesta en tu repo">
            <Eye className="h-3 w-3" /> en tu repo
          </span>
        )}
        {card.model && !merged && (
          <span
            className={`mt-0.5 shrink-0 rounded-md px-1.5 text-[10px] leading-[16px] font-semibold ${card.model.startsWith("codex") ? "bg-emerald-400/10 text-emerald-300" : "bg-orange-400/10 text-orange-300"}`}
            title={modelLabel(card.model)}
          >
            {modelLabel(card.model, true)}
          </span>
        )}
      </div>
      {card.spec && !merged && <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-zinc-500">{specPreview(card.spec)}</div>}

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
              <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/[0.06]">
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

/** Inline title input. Enter creates and keeps it open for the next one; Esc or clicking away closes it. */
function NewCardInput({ projectId, column, onDone }: { projectId: string; column: Column; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const create = async () => {
    const t = title.trim();
    if (!t) return false;
    setTitle("");
    await api<Card>("/api/cards", { project_id: projectId, title: t, column }).catch((e) => alert(e.message));
    return true;
  };
  return (
    <input
      autoFocus
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          create().then((ok) => !ok && onDone());
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone();
        }
      }}
      onBlur={() => create().then(onDone)}
      placeholder="Título de la tarjeta…"
      className="w-full rounded-[var(--radius-card)] border border-indigo-400/50 bg-zinc-900 px-3 py-2.5 text-[13.5px] text-zinc-100 shadow-[0_0_0_3px_rgb(129_140_248/0.12)] outline-none placeholder:text-zinc-600"
    />
  );
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
