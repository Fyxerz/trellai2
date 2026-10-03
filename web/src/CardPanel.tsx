import { useEffect, useMemo, useRef, useState } from "react";
import { MachineChip } from "./SyncUI";
import { COLUMN_LABELS, type Card, type Checkpoint, type Column, type Message, type Project, type Question } from "../../shared/types";
import { ModelPicker, modelLabel } from "./models";
import { confirmDeleteCard, togglePreview } from "./Confirm";
import {
  ArrowRight,
  Eye,
  EyeOff,
  FileDiff,
  FileText,
  GitMerge,
  Hammer,
  MessagesSquare,
  RotateCcw,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { api, useCardDetail, type Board } from "./api";
import { Button, chatKeyDown, COLUMN_HEX, COLUMN_ICON, Markdown, Spinner, StatusBadge } from "./ui";

type Tab = "spec" | "activity" | "diff";

export function CardPanel({ card, board, project, onClose }: { card: Card; board: Board; project?: Project; onClose: () => void }) {
  const previewing = project?.preview_card_id === card.id;
  const { messages, questions, checkpoints, setCheckpoints } = useCardDetail(board, card.id);
  const open = questions.filter((q) => q.answer === null);
  const defaultTab: Tab = card.column === "backlog" || card.column === "plan" ? "spec" : "activity";
  const [tab, setTab] = useState<Tab>(defaultTab);
  useEffect(() => setTab(defaultTab), [card.id]);
  const [editSignal, setEditSignal] = useState(0);

  // Keyboard shortcuts while a card is open (global ones live in App).
  useEffect(() => {
    const focus = (sel: string) => setTimeout(() => document.querySelector<HTMLElement>(sel)?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (document.querySelector("[data-modal]")) return;
      const k = e.key;
      if (k === "1") setTab("spec");
      else if (k === "2") setTab("activity");
      else if (k === "3") setTab("diff");
      else if (k === "e") {
        e.preventDefault();
        setTab("spec");
        setEditSignal((n) => n + 1);
        focus('[data-kb="spec"]');
      } else if (k === "c") {
        e.preventDefault();
        focus('[data-kb="checkpoint"]');
      } else if (k === "i") {
        e.preventDefault();
        setTab("activity");
        focus('[data-kb="chat"]');
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const move = (column: Column) => api(`/api/cards/${card.id}/move`, { column }).catch((e) => alert(e.message));

  return (
    <aside className="flex h-full w-[min(640px,100vw)] shrink-0 flex-col border-l border-white/[0.06] bg-[#0f1014] shadow-[-24px_0_48px_-24px_rgb(0_0_0/0.6)]">
      <header className="border-b border-white/[0.06] px-6 pt-4 pb-4">
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <ColumnChip column={card.column} />
          <StatusBadge card={card} />
          <MachineChip machine={card.machine} />
          <ModelPicker
            className="ml-auto"
            value={card.model}
            inheritLabel={`Modelo del proyecto (${modelLabel(project?.model_dev)})`}
            title="Modelo que usa el agente de esta tarjeta (preparación y desarrollo). Se aplica en el siguiente paso del agente."
            onChange={(model) => api(`/api/cards/${card.id}`, { model }, "PATCH")}
          />
          <button
            onClick={async () => {
              if (await confirmDeleteCard(card)) api(`/api/cards/${card.id}`, undefined, "DELETE").then(onClose);
            }}
            className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-red-500/10 hover:text-red-300"
            title="Eliminar tarjeta"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200" title="Cerrar (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>
        <TitleInput card={card} />
        {card.status_text && card.status !== "running" && (
          <p className={`mt-1 text-[12.5px] ${card.status === "error" ? "text-red-300" : "text-zinc-400"}`}>{card.status_text}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 empty:hidden">
          {card.column === "backlog" && (
            <Button onClick={() => move("plan")}>
              Pasar a Plan <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
          {card.column === "plan" && (
            <>
              <Button variant="primary" onClick={() => move("preparation")}>
                <Sparkles className="h-3.5 w-3.5" /> Preparar
              </Button>
              <Button onClick={() => move("doing")} title="Sin preparación: directo al agente">
                <Hammer className="h-3.5 w-3.5" /> Directo a Doing
              </Button>
            </>
          )}
          {card.column === "review" && (
            <Button variant="primary" onClick={() => move("merged")}>
              <GitMerge className="h-3.5 w-3.5" /> Mergear
            </Button>
          )}
          {card.branch && card.column !== "merged" && (
            <Button
              onClick={() => togglePreview(card, previewing)}
              title={previewing ? "Devolver tu repo a su rama (v)" : "Poner esta rama en tu repo para verla con tu servidor de desarrollo (v)"}
              className={previewing ? "!bg-teal-400/15 !text-teal-200 !ring-teal-300/30" : ""}
            >
              {previewing ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {previewing ? "Dejar de ver" : "Ver esta rama"}
            </Button>
          )}
          {card.status === "running" && (
            <Button onClick={() => api(`/api/cards/${card.id}/stop`, {})}>
              <Square className="h-3 w-3" /> Parar
            </Button>
          )}
          {(card.status === "error" || (card.status === "idle" && card.status_text === "Detenido")) && (
            <Button onClick={() => api(`/api/cards/${card.id}/retry`, {})}>
              <RotateCcw className="h-3.5 w-3.5" /> Reintentar
            </Button>
          )}

        </div>
      </header>

      {open.length > 0 && <Questions card={card} questions={open} />}

      <Checkpoints card={card} items={checkpoints} setItems={setCheckpoints} />

      <nav className="flex gap-1 border-b border-white/[0.06] px-5">
        {(["spec", "activity", "diff"] as Tab[]).map((t, i) => {
          const Icon = { spec: FileText, activity: MessagesSquare, diff: FileDiff }[t];
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-[13px] transition ${
                tab === t ? "border-indigo-400 text-zinc-50" : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {{ spec: "Spec", activity: "Actividad", diff: "Diff" }[t]}
              {t === "activity" && messages.length > 0 && <span className="tabular text-[11px] text-zinc-500">{messages.length}</span>}
              <span className="ml-0.5 font-mono text-[10px] text-zinc-600">{i + 1}</span>
            </button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1">
        {tab === "spec" && <SpecTab card={card} questions={questions} editSignal={editSignal} />}
        {tab === "activity" && <Activity card={card} messages={messages} />}
        {tab === "diff" && <DiffTab card={card} />}
      </div>
    </aside>
  );
}

function TitleInput({ card }: { card: Card }) {
  const [v, setV] = useState(card.title);
  useEffect(() => setV(card.title), [card.id, card.title]);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() && v !== card.title && api(`/api/cards/${card.id}`, { title: v }, "PATCH")}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="mt-2.5 w-full bg-transparent text-[20px] leading-tight font-semibold tracking-tight text-zinc-50 outline-none"
    />
  );
}

function SpecTab({ card, questions, editSignal }: { card: Card; questions: Question[]; editSignal: number }) {
  const [spec, setSpec] = useState(card.spec);
  const [editing, setEditing] = useState(!card.spec);
  useEffect(() => {
    if (editSignal) setEditing(true);
  }, [editSignal]);
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setSpec(card.spec);
    setEditing(!card.spec);
  }, [card.id]);

  const save = (value: string) => {
    clearTimeout(timer.current);
    setSaved(false);
    timer.current = setTimeout(async () => {
      await api(`/api/cards/${card.id}`, { spec: value }, "PATCH");
      setSaved(true);
    }, 600);
  };
  const answered = questions.filter((q) => q.answer !== null);

  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Especificación</h3>
        <span className="text-[11px] text-zinc-600">{saved ? "guardado" : "guardando…"}</span>
        <button onClick={() => setEditing(!editing)} className="ml-auto text-xs text-indigo-400 hover:underline">
          {editing ? "Vista previa" : "Editar"}
        </button>
      </div>
      {editing ? (
        <textarea
          data-kb="spec"
          value={spec}
          onChange={(e) => {
            setSpec(e.target.value);
            save(e.target.value);
          }}
          placeholder={"Describe la feature como quieras: qué quieres, por qué, cómo debería comportarse, casos raros…\n\nMarkdown soportado."}
          className="min-h-[50vh] w-full resize-y rounded-lg bg-zinc-900 p-3 font-mono text-[13px] leading-relaxed text-zinc-200 ring-1 ring-zinc-800 outline-none focus:ring-indigo-600"
        />
      ) : (
        <div className="rounded-lg bg-zinc-900/50 p-3 ring-1 ring-zinc-800">
          {spec ? <Markdown>{spec}</Markdown> : <p className="text-sm text-zinc-500">Sin spec.</p>}
        </div>
      )}
      {card.column !== "backlog" && card.column !== "plan" && (
        <p className="mt-2 text-[11px] text-zinc-500">Si cambias la spec con un agente trabajando, díselo también en Actividad.</p>
      )}

      {card.plan && (
        <>
          <h3 className="mt-6 mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Notas de preparación</h3>
          <div className="rounded-lg bg-violet-500/5 p-3 ring-1 ring-violet-500/20">
            <Markdown>{card.plan}</Markdown>
          </div>
        </>
      )}
      {card.files.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {card.files.map((f) => (
            <span key={f} className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">{f}</span>
          ))}
        </div>
      )}
      {answered.length > 0 && (
        <>
          <h3 className="mt-6 mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Decisiones</h3>
          <ul className="space-y-1.5 text-sm">
            {answered.map((q) => (
              <li key={q.id}>
                <span className="text-zinc-400">{q.question}</span> → <span className="text-zinc-100">{q.answer}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Questions({ card, questions }: { card: Card; questions: Question[] }) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  const ready = questions.every((q) => answers[q.id]?.trim());
  return (
    <div className="border-b border-violet-500/30 bg-violet-500/[0.07] px-5 py-4">
      <h3 className="mb-3 text-sm font-semibold text-violet-200">Claude tiene {questions.length === 1 ? "una pregunta" : `${questions.length} preguntas`}</h3>
      <div className="space-y-4">
        {questions.map((q) => (
          <div key={q.id}>
            <p className="mb-2 text-sm text-zinc-100">{q.question}</p>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => (
                <button
                  key={o}
                  onClick={() => setAnswers({ ...answers, [q.id]: o })}
                  className={`rounded-md px-2.5 py-1 text-sm ring-1 transition ${answers[q.id] === o ? "bg-violet-500 text-white ring-violet-400" : "bg-zinc-900 text-zinc-300 ring-zinc-700 hover:ring-violet-500"}`}
                >
                  {o}
                </button>
              ))}
            </div>
            <input
              value={q.options.includes(answers[q.id] ?? "") ? "" : (answers[q.id] ?? "")}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              placeholder="…o escribe tu respuesta"
              className="mt-2 w-full rounded-md bg-zinc-900 px-2.5 py-1.5 text-sm ring-1 ring-zinc-700 outline-none focus:ring-violet-500"
            />
          </div>
        ))}
      </div>
      <Button
        variant="primary"
        className="mt-4 !bg-violet-500 hover:!bg-violet-400 !text-white"
        disabled={!ready || sending}
        onClick={async () => {
          setSending(true);
          await api(`/api/cards/${card.id}/answers`, { answers }).catch((e) => alert(e.message));
          setSending(false);
          setAnswers({});
        }}
      >
        Responder y continuar
      </Button>
    </div>
  );
}

function Activity({ card, messages }: { card: Card; messages: Message[] }) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages.length, card.id]);

  const placeholder: Record<Column, string> = {
    backlog: "Comentario…",
    plan: "Comentario…",
    preparation: "Escribe al agente de preparación…",
    doing: card.status === "running" ? "Se lo paso al agente en cuanto termine el paso actual…" : "Escribe al agente…",
    review: "Pide cambios (la tarjeta vuelve a Doing)…",
    merged: "Comentario…",
  };

  const send = async () => {
    if (!text.trim()) return;
    const t = text;
    setText("");
    await api(`/api/cards/${card.id}/message`, { text: t }).catch((e) => {
      alert(e.message);
      setText(t);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <p className="pt-8 text-center text-sm text-zinc-500">
            {card.column === "plan" || card.column === "backlog"
              ? "Cuando la pases a Preparation, aquí verás lo que hace Claude."
              : "Sin actividad todavía."}
          </p>
        )}
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}
        {card.status === "running" && (
          <div className="flex items-center gap-2 pt-1 text-xs text-amber-300/80">
            <Spinner /> trabajando…
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="border-t border-zinc-800 p-3">
        <div className="flex items-end gap-2">
          <textarea
            data-kb="chat"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => chatKeyDown(e, send, setText)}
            rows={2}
            placeholder={placeholder[card.column]}
            className="flex-1 resize-none rounded-lg bg-zinc-900 px-3 py-2 text-sm ring-1 ring-zinc-800 outline-none focus:ring-indigo-600"
          />
          <Button variant={card.column === "review" ? "primary" : "default"} onClick={send} disabled={!text.trim()}>
            {card.column === "review" ? "Pedir cambios" : "Enviar"}
          </Button>
        </div>
        <p className="mt-1 text-[10px] text-zinc-600">Enter envía · ⌘Enter nueva línea</p>
      </div>
    </div>
  );
}

function MessageRow({ m }: { m: Message }) {
  if (m.role === "tool")
    return (
      <div className="flex min-w-0 items-center gap-1.5 pl-1 font-mono text-[11px] text-zinc-500" title={m.content}>
        <Terminal className="h-3 w-3 shrink-0 text-zinc-600" />
        <span className="truncate">{m.content}</span>
      </div>
    );
  if (m.role === "system")
    return (
      <div className="flex items-start gap-2 border-l-2 border-white/[0.08] py-0.5 pl-2.5 text-[12px] whitespace-pre-wrap text-zinc-400">
        <InlineCode text={m.content} />
      </div>
    );
  if (m.role === "user")
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-500/15 px-3.5 py-2 text-sm text-indigo-50 ring-1 ring-indigo-400/20">
          <Markdown>{m.content}</Markdown>
        </div>
      </div>
    );
  return (
    <div className="rounded-lg px-1 py-1 text-zinc-200">
      <Markdown>{m.content}</Markdown>
    </div>
  );
}

function DiffTab({ card }: { card: Card }) {
  const [data, setData] = useState<{ diff: string; files: string[] } | null>(null);
  const load = () => api<{ diff: string; files: string[] }>(`/api/cards/${card.id}/diff`).then(setData);
  useEffect(() => {
    setData(null);
    load();
  }, [card.id, card.status, card.column]);

  const files = useMemo(() => parseDiff(data?.diff ?? ""), [data]);

  if (!card.worktree)
    return <p className="p-6 text-sm text-zinc-500">{card.column === "merged" ? "Ya está mergeada." : "Todavía no hay rama de trabajo."}</p>;
  if (!data) return <div className="p-6 text-zinc-500"><Spinner /></div>;
  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <div className="mb-3 flex items-center gap-2 text-xs text-zinc-400">
        {files.length} fichero(s)
        <button onClick={load} className="ml-auto text-indigo-400 hover:underline">Refrescar</button>
      </div>
      {files.length === 0 && <p className="text-sm text-zinc-500">Sin cambios todavía.</p>}
      {files.map((f) => (
        <details key={f.name} open={files.length <= 8} className="mb-3 overflow-hidden rounded-lg ring-1 ring-zinc-800">
          <summary className="cursor-pointer bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-300">
            {f.name}
            <span className="ml-2 text-emerald-400">+{f.add}</span> <span className="text-red-400">−{f.del}</span>
          </summary>
          <pre className="overflow-x-auto bg-zinc-950 py-1 font-mono text-[11.5px] leading-[1.45]">
            {f.lines.map((l, i) => (
              <div
                key={i}
                className={
                  l.startsWith("+")
                    ? "bg-emerald-500/10 px-3 text-emerald-200"
                    : l.startsWith("-")
                      ? "bg-red-500/10 px-3 text-red-200"
                      : l.startsWith("@@")
                        ? "px-3 text-indigo-400/70"
                        : "px-3 text-zinc-400"
                }
              >
                {l || " "}
              </div>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
}

function parseDiff(diff: string) {
  const out: { name: string; lines: string[]; add: number; del: number }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      cur = { name: line.split(" b/").pop() ?? line, lines: [], add: 0, del: 0 };
      out.push(cur);
    } else if (cur) {
      if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
      cur.lines.push(line);
      if (line.startsWith("+")) cur.add++;
      else if (line.startsWith("-")) cur.del++;
    }
  }
  return out;
}

function Checkpoints({ card, items, setItems }: { card: Card; items: Checkpoint[]; setItems: (c: Checkpoint[]) => void }) {
  const [text, setText] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const done = items.filter((c) => c.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  const toggle = (c: Checkpoint) => {
    setItems(items.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)));
    api(`/api/checkpoints/${c.id}`, { done: !c.done }, "PATCH");
  };
  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    await api(`/api/cards/${card.id}/checkpoints`, { text: t });
  };

  return (
    <section className="border-b border-zinc-800 px-5 py-3">
      <button onClick={() => setCollapsed(!collapsed)} className="flex w-full items-center gap-2 text-left">
        <h3 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Checkpoints</h3>
        {items.length > 0 && (
          <>
            <span className="text-xs text-zinc-500">
              {done}/{items.length}
            </span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
              <div className={`h-full rounded-full transition-all ${pct === 100 ? "bg-emerald-400" : "bg-indigo-400"}`} style={{ width: `${pct}%` }} />
            </div>
          </>
        )}
        <span className="ml-auto text-xs text-zinc-600">{collapsed ? "▸" : "▾"}</span>
      </button>

      {!collapsed && (
        <>
          <ul className="mt-2 max-h-[34vh] space-y-0.5 overflow-y-auto">
            {items.map((c) => (
              <CheckpointRow key={c.id} c={c} onToggle={() => toggle(c)} />
            ))}
          </ul>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            data-kb="checkpoint"
            placeholder={items.length ? "+ Añadir checkpoint…" : "+ Añade los pasos que quieres ver hechos (Enter). Claude también añadirá los suyos."}
            className="mt-1 w-full rounded-md bg-transparent px-2 py-1.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 hover:bg-zinc-900 focus:bg-zinc-900 focus:ring-1 focus:ring-zinc-700"
          />
        </>
      )}
    </section>
  );
}

function CheckpointRow({ c, onToggle }: { c: Checkpoint; onToggle: () => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(c.text);
  useEffect(() => setV(c.text), [c.text]);
  const save = () => {
    setEditing(false);
    if (v.trim() && v.trim() !== c.text) api(`/api/checkpoints/${c.id}`, { text: v.trim() }, "PATCH");
    else setV(c.text);
  };
  return (
    <li className="group flex items-start gap-2 rounded-md px-2 py-1 hover:bg-zinc-900">
      <input type="checkbox" checked={c.done} onChange={onToggle} className="mt-[3px] h-3.5 w-3.5 shrink-0 cursor-pointer accent-emerald-500" />
      {editing ? (
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              e.stopPropagation();
              setV(c.text);
              setEditing(false);
            }
          }}
          className="flex-1 bg-transparent text-sm text-zinc-100 outline-none"
        />
      ) : (
        <span onClick={() => setEditing(true)} className={`flex-1 cursor-text text-sm leading-snug ${c.done ? "text-zinc-500 line-through" : "text-zinc-200"}`}>
          <InlineCode text={c.text} />
        </span>
      )}
      {c.source === "agent" && (
        <span className="mt-0.5 shrink-0 rounded bg-violet-500/10 px-1.5 text-[10px] text-violet-300/80" title="Añadido por Claude">
          Claude
        </span>
      )}
      <button
        onClick={() => api(`/api/checkpoints/${c.id}`, undefined, "DELETE")}
        className="shrink-0 text-xs text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-300"
        title="Eliminar"
      >
        ✕
      </button>
    </li>
  );
}

/** Render `code` spans inside short one-line texts (checkpoints). */
function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i} className="rounded bg-zinc-800 px-1 py-px font-mono text-[0.85em]">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function ColumnChip({ column }: { column: Column }) {
  const Icon = COLUMN_ICON[column];
  return (
    <span className="flex items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-1 text-[11.5px] font-medium text-zinc-300 ring-1 ring-white/[0.06]">
      <Icon className="h-3.5 w-3.5" style={{ color: COLUMN_HEX[column] }} />
      {COLUMN_LABELS[column]}
    </span>
  );
}
