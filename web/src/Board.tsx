import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { useState } from "react";
import { COLUMNS, COLUMN_LABELS, type Card, type Column } from "../../shared/types";
import { api, type Board as BoardState } from "./api";
import { COLUMN_ACCENT, StatusBadge } from "./ui";

const HINTS: Record<Column, string> = {
  backlog: "Ideas sueltas",
  plan: "Escribe tú la spec",
  preparation: "Claude pregunta o la pasa sola",
  doing: "Agentes en paralelo",
  review: "Revisa el diff",
  merged: "En la rama base",
};

export function Board({
  projectId,
  board,
  onOpen,
  selectedId,
}: {
  projectId: string;
  board: BoardState;
  onOpen: (id: string) => void;
  selectedId: string | null;
}) {
  const byColumn = (col: Column) =>
    Object.values(board.cards)
      .filter((c) => c.column === col)
      .sort((a, b) => a.position - b.position);

  const onDragEnd = (r: DropResult) => {
    if (!r.destination) return;
    const to = r.destination.droppableId as Column;
    const from = r.source.droppableId as Column;
    if (to === from && r.destination.index === r.source.index) return;

    // optimistic reorder
    board.setCards((prev) => {
      const next = { ...prev };
      const moved = { ...next[r.draggableId], column: to };
      const dest = Object.values(next)
        .filter((c) => c.column === to && c.id !== moved.id)
        .sort((a, b) => a.position - b.position);
      dest.splice(r.destination!.index, 0, moved);
      dest.forEach((c, i) => (next[c.id] = { ...c, position: i }));
      return next;
    });
    api(`/api/cards/${r.draggableId}/move`, { column: to, index: r.destination.index }).catch((e) => alert(e.message));
  };

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className="flex h-full gap-3 overflow-x-auto px-4 pb-4">
        {COLUMNS.map((col) => {
          const cards = byColumn(col);
          return (
            <section key={col} className="flex min-w-[250px] flex-1 flex-col rounded-xl bg-zinc-900/60 ring-1 ring-zinc-800/80">
              <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                <span className={`h-2 w-2 rounded-full ${COLUMN_ACCENT[col]}`} />
                <h2 className="text-sm font-semibold text-zinc-100">{COLUMN_LABELS[col]}</h2>
                <span className="text-xs text-zinc-500">{cards.length}</span>
                <span className="ml-auto truncate text-[11px] text-zinc-500">{HINTS[col]}</span>
              </header>
              <Droppable droppableId={col}>
                {(p, snap) => (
                  <div
                    ref={p.innerRef}
                    {...p.droppableProps}
                    className={`flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 transition-colors ${snap.isDraggingOver ? "bg-zinc-800/40" : ""}`}
                  >
                    {cards.map((card, i) => (
                      <Draggable key={card.id} draggableId={card.id} index={i}>
                        {(dp, ds) => (
                          <div ref={dp.innerRef} {...dp.draggableProps} {...dp.dragHandleProps}>
                            <CardItem card={card} dragging={ds.isDragging} selected={card.id === selectedId} onClick={() => onOpen(card.id)} />
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {p.placeholder}
                  </div>
                )}
              </Droppable>
              {(col === "backlog" || col === "plan") && <AddCard projectId={projectId} column={col} onCreated={onOpen} />}
            </section>
          );
        })}
      </div>
    </DragDropContext>
  );
}

function CardItem({ card, dragging, selected, onClick }: { card: Card; dragging: boolean; selected: boolean; onClick: () => void }) {
  const ring =
    card.status === "waiting"
      ? "ring-violet-500/60"
      : card.status === "error"
        ? "ring-red-500/50"
        : card.status === "running"
          ? "ring-amber-500/40"
          : selected
            ? "ring-sky-500/60"
            : "ring-zinc-800";
  return (
    <div
      onClick={onClick}
      className={`group cursor-pointer rounded-lg bg-zinc-900 px-3 py-2.5 ring-1 transition hover:bg-zinc-800/70 ${ring} ${dragging ? "rotate-1 shadow-2xl shadow-black/50" : ""} ${card.column === "merged" ? "opacity-60" : ""}`}
    >
      <div className="text-sm font-medium leading-snug text-zinc-100">{card.title}</div>
      {card.spec && card.column !== "merged" && (
        <div className="mt-1 line-clamp-2 text-xs text-zinc-500">{card.spec.replace(/[#*`>-]/g, "").trim()}</div>
      )}
      <div className="mt-2 flex items-center gap-2 empty:hidden">
        <StatusBadge card={card} />
        {card.status_text && card.status !== "running" && (
          <span className={`truncate text-[11px] ${card.status === "error" ? "text-red-300/80" : "text-zinc-500"}`}>{card.status_text}</span>
        )}
      </div>
      {card.branch && card.column !== "merged" && (
        <div className="mt-1.5 truncate font-mono text-[10px] text-zinc-600">{card.branch}</div>
      )}
    </div>
  );
}

function AddCard({ projectId, column, onCreated }: { projectId: string; column: Column; onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const submit = async () => {
    if (!title.trim()) return setOpen(false);
    const card = await api<Card>("/api/cards", { project_id: projectId, title, column });
    setTitle("");
    setOpen(false);
    if (column === "plan") onCreated(card.id);
  };
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="mx-2 mb-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300">
        + Añadir tarjeta
      </button>
    );
  return (
    <div className="mx-2 mb-2">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
        onBlur={submit}
        placeholder="Título…"
        className="w-full rounded-md bg-zinc-950 px-2.5 py-2 text-sm ring-1 ring-zinc-700 outline-none focus:ring-sky-500"
      />
    </div>
  );
}
