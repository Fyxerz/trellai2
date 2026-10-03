import { useEffect, useMemo, useRef, useState } from "react";
import { COLUMN_LABELS, type Card, type Column, type Message, type Question } from "../../shared/types";
import { api, useCardDetail, type Board } from "./api";
import { Button, COLUMN_ACCENT, Markdown, Spinner, StatusBadge } from "./ui";

type Tab = "spec" | "activity" | "diff";

export function CardPanel({ card, board, onClose }: { card: Card; board: Board; onClose: () => void }) {
  const { messages, questions } = useCardDetail(board, card.id);
  const open = questions.filter((q) => q.answer === null);
  const defaultTab: Tab = card.column === "backlog" || card.column === "plan" ? "spec" : "activity";
  const [tab, setTab] = useState<Tab>(defaultTab);
  useEffect(() => setTab(defaultTab), [card.id]);

  const move = (column: Column) => api(`/api/cards/${card.id}/move`, { column }).catch((e) => alert(e.message));

  return (
    <aside className="flex h-full w-[min(620px,100vw)] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
      <header className="border-b border-zinc-800 px-5 pt-4 pb-3">
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span className={`h-2 w-2 rounded-full ${COLUMN_ACCENT[card.column]}`} />
          {COLUMN_LABELS[card.column]}
          <StatusBadge card={card} />
          <button onClick={onClose} className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Cerrar (Esc)">
            ✕
          </button>
        </div>
        <TitleInput card={card} />
        {card.status_text && card.status !== "running" && (
          <p className={`mt-1 text-xs ${card.status === "error" ? "text-red-300" : "text-zinc-400"}`}>{card.status_text}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {card.column === "backlog" && <Button onClick={() => move("plan")}>Pasar a Plan →</Button>}
          {card.column === "plan" && (
            <>
              <Button variant="primary" onClick={() => move("preparation")}>Pasar a Preparation →</Button>
              <Button onClick={() => move("doing")} title="Sin preparación: directo al agente">Directo a Doing</Button>
            </>
          )}
          {card.column === "review" && (
            <Button variant="primary" onClick={() => move("merged")}>Mergear ✓</Button>
          )}
          {card.status === "running" && <Button onClick={() => api(`/api/cards/${card.id}/stop`, {})}>■ Parar</Button>}
          {(card.status === "error" || (card.status === "idle" && card.status_text === "Detenido")) && (
            <Button onClick={() => api(`/api/cards/${card.id}/retry`, {})}>↻ Reintentar</Button>
          )}
          <Button
            variant="danger"
            className="ml-auto"
            onClick={() => {
              if (confirm(`¿Eliminar "${card.title}"?${card.branch ? " Se borrarán también su worktree y su rama." : ""}`)) {
                api(`/api/cards/${card.id}`, undefined, "DELETE").then(onClose);
              }
            }}
          >
            Eliminar
          </Button>
        </div>
      </header>

      {open.length > 0 && <Questions card={card} questions={open} />}

      <nav className="flex gap-1 border-b border-zinc-800 px-4">
        {(["spec", "activity", "diff"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? "border-sky-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
          >
            {{ spec: "Spec", activity: `Actividad${messages.length ? ` · ${messages.length}` : ""}`, diff: "Diff" }[t]}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1">
        {tab === "spec" && <SpecTab card={card} questions={questions} />}
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
      className="mt-2 w-full bg-transparent text-lg font-semibold text-zinc-50 outline-none"
    />
  );
}

function SpecTab({ card, questions }: { card: Card; questions: Question[] }) {
  const [spec, setSpec] = useState(card.spec);
  const [editing, setEditing] = useState(card.column === "plan" || card.column === "backlog" || !card.spec);
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setSpec(card.spec);
    setEditing(card.column === "plan" || card.column === "backlog" || !card.spec);
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
        <button onClick={() => setEditing(!editing)} className="ml-auto text-xs text-sky-400 hover:underline">
          {editing ? "Vista previa" : "Editar"}
        </button>
      </div>
      {editing ? (
        <textarea
          value={spec}
          onChange={(e) => {
            setSpec(e.target.value);
            save(e.target.value);
          }}
          placeholder={"Describe la feature como quieras: qué quieres, por qué, cómo debería comportarse, casos raros…\n\nMarkdown soportado."}
          className="min-h-[50vh] w-full resize-y rounded-lg bg-zinc-900 p-3 font-mono text-[13px] leading-relaxed text-zinc-200 ring-1 ring-zinc-800 outline-none focus:ring-sky-600"
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
          <h3 className="mt-6 mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Plan técnico (Preparation)</h3>
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
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
            rows={2}
            placeholder={placeholder[card.column]}
            className="flex-1 resize-none rounded-lg bg-zinc-900 px-3 py-2 text-sm ring-1 ring-zinc-800 outline-none focus:ring-sky-600"
          />
          <Button variant={card.column === "review" ? "primary" : "default"} onClick={send} disabled={!text.trim()}>
            {card.column === "review" ? "Pedir cambios" : "Enviar"}
          </Button>
        </div>
        <p className="mt-1 text-[10px] text-zinc-600">⌘ + Enter para enviar</p>
      </div>
    </div>
  );
}

function MessageRow({ m }: { m: Message }) {
  if (m.role === "tool")
    return (
      <div className="truncate pl-1 font-mono text-[11px] text-zinc-500" title={m.content}>
        <span className="text-zinc-600">›</span> {m.content}
      </div>
    );
  if (m.role === "system")
    return <div className="rounded-md bg-zinc-900/60 px-3 py-1.5 text-xs whitespace-pre-wrap text-zinc-400">{m.content}</div>;
  if (m.role === "user")
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-sky-500/15 px-3 py-2 text-sm text-sky-50 ring-1 ring-sky-500/20">
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
        <button onClick={load} className="ml-auto text-sky-400 hover:underline">Refrescar</button>
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
                        ? "px-3 text-sky-400/70"
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
