import { useMessageDraft, useChatScroll } from "./chat";
import { readPreference, writePreference } from "./preferences";
import { registerDraft } from "./drafts";
import { cardTags, TagPicker, useProjectTags } from "./tags";
import { reportError } from "./notifications";
import { useEffect, useMemo, useRef, useState } from "react";
import { MachineChip } from "./SyncUI";
import { Avatar, Byline, usePeople } from "./People";
import { COLUMN_LABELS, type Card, type Checkpoint, type Column, type Message, type Project, type Question, type Tag } from "../../shared/types";
import { ModelPicker, modelLabel } from "./models";
import { AddImageButton, SpecImages, useChatImages } from "./ImageEditor";
import { prettyModel } from "../../shared/models";
import { confirmDeleteCard, confirmDialog, togglePreview } from "./Confirm";
import {
  ArrowRight,
  Bot,
  CornerLeftUp,
  Eye,
  EyeOff,
  FileDiff,
  Maximize2,
  Minimize2,
  FileText,
  GitMerge,
  Hammer,
  MessagesSquare,
  Network,
  RotateCcw,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { api, useCardDetail, type Board } from "./api";
import { Button, ChatHint, chatKeyDown, COLUMN_HEX, COLUMN_ICON, Markdown, runningLabel, Spinner, StatusBadge } from "./ui";

type Tab = "spec" | "activity" | "diff";

export function CardPanel({
  card,
  board,
  project,
  onClose,
  onOpen,
}: {
  card: Card;
  board: Board;
  project?: Project;
  onClose: () => void;
  /** open another card (its mother or one of its sub-cards) */
  onOpen?: (id: string) => void;
}) {
  const previewing = project?.preview_card_id === card.id;
  const { messages, questions, checkpoints, setCheckpoints } = useCardDetail(board, card.id);
  const tags = useProjectTags(card.project_id, board);
  const open = questions.filter((q) => q.answer === null);
  // Cards still being planned open on their spec; the rest on the activity feed.
  const defaultTab: Tab = card.column === "plan" ? "spec" : "activity";
  const [tab, setTab] = useState<Tab>(defaultTab);
  useEffect(() => setTab(defaultTab), [card.id]);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(() => Math.max(400, Math.min(900, Number(readPreference("panel-width", "540")) || 540)));
  const resize = useRef<{ x: number; width: number } | null>(null);

  // Keyboard shortcuts while a card is open (global ones live in App).
  useEffect(() => {
    const focus = (sel: string) => setTimeout(() => document.querySelector<HTMLElement>(sel)?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.defaultPrevented || e.isComposing || e.repeat || e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, button, a") || t.isContentEditable) return;
      if (document.querySelector("[data-modal]")) return;
      const k = e.key;
      if (k === "1") setTab("spec");
      else if (k === "2") setTab("activity");
      else if (k === "3") setTab("diff");
      else if (k === "e") {
        e.preventDefault();
        setTab("spec");
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

  const move = (column: Column) => api(`/api/cards/${card.id}/move`, { column }).catch((e) => reportError(e.message));

  return (
    <aside aria-label="Detalle de tarjeta" style={{ "--panel-width": `${width}px` } as React.CSSProperties} className={`work-panel overlay ${expanded ? "expanded" : ""} flex h-full shrink-0 flex-col border-l border-ui-ink/[0.06] bg-panel`}>
      {!expanded && <div role="separator" aria-label="Ancho del panel" aria-orientation="vertical" aria-valuemin={400} aria-valuemax={900} aria-valuenow={width} tabIndex={0} className="panel-resizer" onKeyDown={e => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); const next = Math.max(400, Math.min(900, width + (e.key === "ArrowLeft" ? 40 : -40))); setWidth(next); writePreference("panel-width", String(next)); }
      }} onPointerDown={e => { resize.current = { x: e.clientX, width }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (resize.current) setWidth(Math.max(400, Math.min(900, resize.current.width + resize.current.x - e.clientX))); }} onPointerUp={e => { resize.current = null; writePreference("panel-width", String(width)); e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { resize.current = null; }} /> }
      <header className="border-b border-ui-ink/[0.06] px-6 pt-4 pb-4">
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <ColumnChip column={card.column} />
          <StatusBadge card={card} />
          <MachineChip machine={card.machine} />
          {card.author && <CreatedBy id={card.author} />}
          {card.agent_model && (
            <span
              className="flex items-center gap-1 rounded-md bg-ui-ink/[0.05] px-1.5 py-0.5 text-[11px] text-zinc-300"
              title={`${card.status === "running" ? "Modelo que está usando el agente" : "Modelo de la última ejecución del agente"}: ${card.agent_model}`}
            >
              <Bot className="h-3 w-3" /> {prettyModel(card.agent_model)}
            </span>
          )}
          <ModelPicker
            className="ml-auto"
            value={card.model}
            inheritLabel={inheritedModelLabel(card, tags, project)}
            title="Modelo que usa el agente de esta tarjeta (preparación y desarrollo). Se aplica en el siguiente paso del agente."
            onChange={(model) => api(`/api/cards/${card.id}`, { model }, "PATCH")}
          />
          <button
            onClick={async () => {
              if (await confirmDeleteCard(card)) api(`/api/cards/${card.id}`, undefined, "DELETE").then(onClose).catch(e => reportError(e.message));
            }}
            className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-red-500/10 hover:text-danger"
            title="Eliminar tarjeta"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button aria-label={expanded ? "Reducir panel" : "Ampliar panel"} title={expanded ? "Reducir panel" : "Ampliar para leer"} onClick={() => setExpanded(!expanded)} className="rounded-lg p-2 text-zinc-400 hover:bg-ui-ink/5">{expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button>
          <button aria-label="Cerrar tarjeta" onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-ui-ink/[0.06] hover:text-zinc-200" title="Cerrar (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>
        <TitleInput card={card} />
        <TagPicker card={card} tags={tags} />
        {card.status_text && card.status !== "running" && (
          <p className={`mt-1 text-[12.5px] ${card.status === "error" ? "text-danger" : "text-zinc-400"}`}>{card.status_text}</p>
        )}
        <Family card={card} board={board} onOpen={onOpen} />
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
          {card.column === "preparation" && card.status !== "running" && (
            <Button variant={card.status === "ready" ? "primary" : undefined} onClick={() => move("doing")}>
              <Hammer className="h-3.5 w-3.5" /> Pasar a Doing
            </Button>
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
              className={previewing ? "!bg-teal-400/15 !text-success !ring-teal-300/30" : ""}
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

      <nav role="tablist" aria-label="Contenido de tarjeta" className="ui-tabs panel-tabs border-b border-ui-ink/[0.06] px-5">
        {(["spec", "activity", "diff"] as Tab[]).map((t, i) => {
          const Icon = { spec: FileText, activity: MessagesSquare, diff: FileDiff }[t];
          return (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`ui-tab -mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-sm transition ${
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
        {tab === "spec" && <SpecTab card={card} board={board} questions={questions} />}
        {tab === "activity" && <Activity card={card} messages={messages} />}
        {tab === "diff" && <DiffTab card={card} />}
      </div>
    </aside>
  );
}

function TitleInput({ card }: { card: Card }) {
  const [v, setV] = useState(card.title);
  const [error, setError] = useState("");
  const cancel = useRef(false);
  useEffect(() => setV(card.title), [card.id, card.title]);
  const save = async () => {
    if (cancel.current) { cancel.current = false; return; }
    if (!v.trim()) { setV(card.title); return; }
    if (v.trim() === card.title) return;
    try { await api(`/api/cards/${card.id}`, { title: v.trim() }, "PATCH"); setError(""); }
    catch (e) { setError((e as Error).message); }
  };
  return <>
    <textarea aria-label="Título de tarjeta" rows={2} value={v} onChange={e => setV(e.target.value.replace(/\n/g, " "))} onBlur={save} onKeyDown={e => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
      if (e.key === "Escape") { e.stopPropagation(); cancel.current = true; setV(card.title); setError(""); e.currentTarget.blur(); }
    }} className="ui-field mt-3 w-full resize-none rounded-lg bg-transparent text-xl leading-snug font-semibold tracking-tight text-zinc-50" />
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </>;
}

function SpecTab({ card, board, questions }: { card: Card; board: Board; questions: Question[] }) {
  const key = `spec-draft:${card.id}`;
  const initialDraft = readPreference(key, card.spec);
  const [spec, setSpec] = useState(initialDraft);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">(initialDraft === card.spec ? "saved" : "saving");
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<string | null>(initialDraft === card.spec ? null : initialDraft);
  const inflight = useRef<Promise<void> | null>(null);
  const flush = (): Promise<void> => {
    clearTimeout(timer.current);
    if (inflight.current) return inflight.current;
    if (pending.current === null) return Promise.resolve();
    setSaveState("saving"); setError("");
    const work = async () => {
      while (pending.current !== null) {
        const value = pending.current;
        await api(`/api/cards/${card.id}`, { spec: value }, "PATCH");
        if (pending.current === value) pending.current = null;
      }
      try { localStorage.removeItem(`trellai:${key}`); } catch { /* optional */ }
      setSaveState("saved");
    };
    inflight.current = work().catch(e => { setSaveState("error"); setError((e as Error).message); throw e; }).finally(() => { inflight.current = null; });
    return inflight.current;
  };
  const latestFlush = useRef(flush); latestFlush.current = flush;
  useEffect(() => {
    const unregister = registerDraft(card.id, () => latestFlush.current());
    if (pending.current !== null) timer.current = setTimeout(() => void latestFlush.current().catch(() => {}), 600);
    return () => {
      clearTimeout(timer.current);
      // Keep a failed flusher available so a workflow transition cannot bypass it.
      void latestFlush.current().then(unregister).catch(e => reportError(`No se guardó la especificación. El borrador está conservado. ${(e as Error).message}`));
    };
  }, [card.id]);
  const save = (value: string) => {
    pending.current = value;
    writePreference(key, value);
    setSaveState("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void latestFlush.current().catch(() => {}), 600);
  };
  const answered = questions.filter((q) => q.answer !== null);

  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="ui-section-title">Especificación</h3>
        <span className="text-[11px] text-zinc-600">{{ saved: "Guardado", saving: "Guardando…", error: "Error al guardar" }[saveState]}</span>
      </div>
      {error && <div role="alert" className="ui-alert mb-3">{error} <button className="ml-2 underline" onClick={() => void flush().catch(() => {})}>Reintentar</button></div>}
      <textarea
        aria-label="Especificación"
        onBlur={() => void flush().catch(() => {})}
        onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void flush().catch(() => {}); } }}
        data-kb="spec"
        value={spec}
        onChange={(e) => {
          setSpec(e.target.value);
          save(e.target.value);
        }}
        placeholder={"Describe la feature como quieras: qué quieres, por qué, cómo debería comportarse, casos raros…\n\nMarkdown soportado."}
        className="ui-field ui-control min-h-[50vh] w-full resize-y rounded-lg bg-zinc-900 p-3 font-mono text-sm leading-relaxed text-zinc-200 ring-1 ring-zinc-800 outline-none focus:ring-indigo-600"
      />
      {card.column !== "backlog" && card.column !== "plan" && (
        <p className="mt-2 text-[11px] text-zinc-500">Si cambias la spec con un agente trabajando, díselo también en Actividad.</p>
      )}
      <SpecImages card={card} board={board} />

      {card.plan && (
        <>
          <h3 className="mt-6 mb-2 ui-section-title">Notas de preparación</h3>
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
          <h3 className="mt-6 mb-2 ui-section-title">Decisiones</h3>
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

/** Claude's questions one at a time: answer, it moves to the next; all are sent at the end. */
function Questions({ card, questions }: { card: Card; questions: Question[] }) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [step, setStep] = useState(0);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ids = questions.map((q) => q.id).join(",");
  useEffect(() => setStep(0), [ids]); // a new batch of questions starts at the first one
  const i = Math.min(step, questions.length - 1);
  const q = questions[i];
  const last = i === questions.length - 1;
  const answered = (k: number) => !!answers[questions[k]?.id]?.trim();
  const ready = questions.every((_, k) => answered(k));
  const typed = q && !q.options.includes(answers[q.id] ?? "") ? (answers[q.id] ?? "") : "";
  // Moving between questions puts the cursor in the answer box (not on first render: Esc should still close the card).
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) input.current?.focus({ preventScroll: true });
    moved.current = true;
  }, [i]);
  if (!q) return null;

  const send = async () => {
    if (!ready || sending) return;
    setSending(true);
    await api(`/api/cards/${card.id}/answers`, { answers }).catch((e) => reportError(e.message));
    setSending(false);
    setAnswers({});
    setStep(0);
  };
  // After answering: the next unanswered question, or stay on the last one to send.
  const advance = (next: Record<number, string>) => {
    const rest = questions.findIndex((x, k) => k > i && !next[x.id]?.trim());
    const any = questions.findIndex((x) => !next[x.id]?.trim());
    setStep(rest >= 0 ? rest : any >= 0 ? any : questions.length - 1);
  };
  const choose = (o: string) => {
    const next = { ...answers, [q.id]: o };
    setAnswers(next);
    if (!last) setTimeout(() => advance(next), 150); // let the choice show for a moment
  };

  return (
    <div className="border-b border-violet-500/30 bg-violet-500/[0.07] px-5 py-4">
      <div className="mb-3 flex items-center gap-3">
        <h3 className="text-sm font-semibold text-waiting">
          {questions.length === 1 ? "Claude tiene una pregunta" : `Pregunta ${i + 1} de ${questions.length}`}
        </h3>
        {questions.length > 1 && (
          <div className="ml-auto flex items-center gap-1.5" role="tablist" aria-label="Preguntas">
            {questions.map((x, k) => (
              <button
                key={x.id}
                role="tab"
                aria-selected={k === i}
                aria-label={`Pregunta ${k + 1}${answered(k) ? " (respondida)" : ""}`}
                title={x.question}
                onClick={() => setStep(k)}
                className={`h-2 rounded-full transition-all ${k === i ? "w-5 bg-violet-300" : answered(k) ? "w-2 bg-violet-400/70" : "w-2 bg-zinc-600 hover:bg-zinc-500"}`}
              />
            ))}
          </div>
        )}
      </div>

      <p className="mb-3 text-[15px] leading-relaxed text-zinc-100">{q.question}</p>
      {q.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {q.options.map((o) => (
            <button
              key={o}
              onClick={() => choose(o)}
              className={`rounded-md px-2.5 py-1 text-sm ring-1 transition ${answers[q.id] === o ? "bg-violet-500 text-white ring-violet-400" : "bg-zinc-900 text-zinc-300 ring-zinc-700 hover:ring-violet-500"}`}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <input
        ref={input}
        value={typed}
        onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing || !answers[q.id]?.trim()) return;
          e.preventDefault();
          if (last || ready) void send();
          else advance(answers);
        }}
        placeholder={q.options.length ? "…o escribe tu respuesta" : "Escribe tu respuesta"}
        aria-label={`Respuesta a: ${q.question}`}
        className="ui-field ui-control mt-2 w-full rounded-md bg-zinc-900 px-2.5 py-1.5 text-sm ring-1 ring-zinc-700 outline-none focus:ring-violet-500"
      />

      <div className="mt-4 flex items-center gap-2">
        {i > 0 && (
          <Button onClick={() => setStep(i - 1)} className="!py-1">
            ← Anterior
          </Button>
        )}
        {!last && (
          <Button onClick={() => setStep(i + 1)} disabled={!answered(i)} className="!py-1">
            Siguiente →
          </Button>
        )}
        {(last || ready) && (
          <Button variant="primary" className="ml-auto !bg-violet-500 hover:!bg-violet-400 !text-white" disabled={!ready || sending} onClick={send}>
            {sending ? "Enviando…" : ready ? "Responder y continuar" : `Faltan ${questions.filter((_, k) => !answered(k)).length}`}
          </Button>
        )}
      </div>
    </div>
  );
}

function Activity({ card, messages }: { card: Card; messages: Message[] }) {
  const { text, setText, current } = useMessageDraft(`chat-draft:${card.id}`);
  const scroll = useChatScroll(messages.length);
  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const images = useChatImages(card);

  const placeholder: Record<Column, string> = {
    backlog: "Comentario…",
    plan: "Comentario…",
    preparation: "Escribe al agente de preparación…",
    doing: card.status === "running" ? "Se lo paso al agente en cuanto termine el paso actual…" : "Escribe al agente…",
    review: "Pide cambios (la tarjeta vuelve a Doing)…",
    merged: "Comentario…",
  };

  const send = async () => {
    const t = current.current.trim();
    if ((!t && !images.ids.length) || images.uploading || busy.current) return;
    busy.current = true; setSending(true);
    const submitted = current.current;
    try { await api(`/api/cards/${card.id}/message`, { text: t, attachments: images.ids }); if (current.current === submitted) setText(""); images.clear(); }
    catch (e) { reportError((e as Error).message); }
    finally { busy.current = false; setSending(false); }
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scroll.container} onScroll={scroll.onScroll} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <p className="pt-8 text-center text-sm text-zinc-500">
            {card.column === "plan" || card.column === "backlog"
              ? "Cuando la pases a Preparation, aquí verás lo que hace Claude."
              : "Sin actividad todavía."}
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.undone && m.role !== "user" ? "opacity-40" : undefined} title={m.undone && m.role !== "user" ? "Deshecho al retroceder" : undefined}>
            <MessageRow m={m} card={card} />
          </div>
        ))}
        {card.status === "running" && (
          <div className="flex items-center gap-2 pt-1 text-xs text-warning/80">
            <Spinner /> {runningLabel(card).toLowerCase()}…
          </div>
        )}
        <div ref={scroll.end} />
      </div>
      {scroll.unread && <button onClick={scroll.jump} className="self-center rounded-full bg-indigo-500/10 px-3 py-1 text-xs text-accent">Nuevos mensajes ↓</button>}
      <div className="border-t border-zinc-800 p-3" onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()} onDrop={images.onDrop}>
        {images.strip}
        <div className="flex items-end gap-2">
          <textarea
            aria-label="Mensaje al agente"
            data-kb="chat"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => chatKeyDown(e, send, setText)}
            onPaste={images.onPaste}
            rows={2}
            placeholder={placeholder[card.column]}
            className="ui-field ui-control flex-1 resize-none rounded-lg bg-zinc-900 px-3 py-2 text-sm ring-1 ring-zinc-800 outline-none focus:ring-indigo-600"
          />
          <AddImageButton onFiles={(f) => void images.add(f)} />
          <Button variant={card.column === "review" ? "primary" : "default"} onClick={send} disabled={(!text.trim() && !images.ids.length) || images.uploading || sending}>
            {card.column === "review" ? "Pedir cambios" : "Enviar"}
          </Button>
        </div>
        <p className="mt-1 text-xs text-zinc-500"><ChatHint /></p>
      </div>
    </div>
  );
}

/** ↶ on one of your requests: says what gets thrown away, then rewinds the card's branch. */
async function rewind(card: Card, m: Message) {
  try {
    const { commits, dirty } = await api<{ commits: string[]; dirty: boolean }>(`/api/cards/${card.id}/messages/${m.id}/rewind`);
    const list = commits.slice(0, 8).map((s) => `• ${s}`).join("\n");
    const body = [
      commits.length ? `Se borran ${commits.length} commit(s) de la rama:\n${list}${commits.length > 8 ? "\n…" : ""}` : "No hay commits después de este mensaje.",
      dirty ? "También se descartan los cambios sin commitear del worktree." : "",
      card.status === "running" ? "El agente se detiene." : "",
      m.column_before && m.column_before !== card.column ? `La tarjeta vuelve a ${COLUMN_LABELS[m.column_before]}.` : "",
    ].filter(Boolean).join("\n\n");
    if (!(await confirmDialog({ title: "¿Retroceder a antes de este mensaje?", body, confirmLabel: "Retroceder", danger: commits.length > 0 || dirty }))) return;
    await api(`/api/cards/${card.id}/messages/${m.id}/rewind`, {});
  } catch (e) {
    reportError((e as Error).message);
  }
}

/** "creada por Ana" in the card header (only once there's more than one person). */
function CreatedBy({ id }: { id: string }) {
  const { byId, people } = usePeople();
  if (people.length < 2 || !byId[id]) return null;
  return <span className="whitespace-nowrap text-[11px] text-zinc-500" title={`Creada por ${byId[id].name}`}>creada por <Byline id={id} /></span>;
}

/** Who sent a request, next to their bubble (only once there's more than one person). */
function MessageAuthor({ id }: { id: string | null }) {
  const { people } = usePeople();
  if (!id || people.length < 2) return null;
  return <Avatar id={id} size={20} className="mt-1" />;
}

function MessageRow({ m, card }: { m: Message; card: Card }) {
  if (m.role === "tool")
    return (
      <div className="flex min-w-0 items-center gap-1.5 pl-1 font-mono text-[11px] text-zinc-500" title={m.content}>
        <Terminal className="h-3 w-3 shrink-0 text-zinc-600" />
        <span className="truncate">{m.content}</span>
      </div>
    );
  if (m.role === "system")
    return (
      <div className="border-l-2 border-ui-ink/[0.08] py-0.5 pl-2.5 text-[12px] break-words whitespace-pre-wrap text-zinc-400">
        <InlineCode text={m.content} />
      </div>
    );
  if (m.role === "user")
    return (
      <div className={`group flex items-start justify-end gap-1.5 ${m.undone ? "opacity-50" : ""}`}>
        {m.head_sha && !m.undone && card.column !== "merged" && (
          <button
            onClick={() => rewind(card, m)}
            title="Retroceder: volver la rama a como estaba antes de este mensaje"
            aria-label="Retroceder a antes de este mensaje"
            className="ui-reveal mt-1.5 rounded p-1 text-zinc-500 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-200 focus:opacity-100"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="ui-message max-w-[90%] rounded-2xl rounded-br-md bg-indigo-500/15 px-3.5 py-2 text-sm text-zinc-100 ring-1 ring-indigo-400/20">
          <Markdown>{m.content}</Markdown>
          {m.undone && <div className="mt-1 text-[11px] text-zinc-400">↶ deshecho</div>}
        </div>
        <MessageAuthor id={m.author} />
      </div>
    );
  return (
    <div className="ui-message rounded-lg px-1 py-1 text-zinc-200">
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
  if (!data) return <div role="status" className="flex items-center gap-2 p-6 text-sm text-zinc-400"><Spinner /> Cargando cambios?</div>;
  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <div className="mb-3 flex items-center gap-2 text-xs text-zinc-400">
        {files.length} fichero(s)
        <button onClick={load} className="ml-auto text-accent hover:underline">Refrescar</button>
      </div>
      {files.length === 0 && <p className="ui-empty">Sin cambios todavía.</p>}
      {files.map((f) => (
        <details key={f.name} className="mb-3 overflow-hidden rounded-lg ring-1 ring-zinc-800">
          <summary className="cursor-pointer bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-300">
            {f.name}
            <span className="ml-2 text-success">+{f.add}</span> <span className="text-danger">−{f.del}</span>
          </summary>
          <pre className="overflow-x-auto bg-zinc-950 py-1 font-mono text-[13px] leading-relaxed">
            {f.lines.map((l, i) => (
              <div
                key={i}
                className={
                  l.startsWith("+")
                    ? "bg-emerald-500/10 px-3 text-success"
                    : l.startsWith("-")
                      ? "bg-red-500/10 px-3 text-danger"
                      : l.startsWith("@@")
                        ? "px-3 text-accent/70"
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
  const adding = useRef(false);
  const [error, setError] = useState("");
  const done = items.filter((c) => c.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  const toggle = (c: Checkpoint) => {
    setItems(items.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)));
    api(`/api/checkpoints/${c.id}`, { done: !c.done }, "PATCH").catch(e => { setItems(items); reportError(e.message); });
  };
  const add = async () => {
    const t = text.trim();
    if (!t || adding.current) return;
    adding.current = true; setError("");
    try { await api(`/api/cards/${card.id}/checkpoints`, { text: t }); setText(""); }
    catch (e) { setError((e as Error).message); }
    finally { adding.current = false; }
  };

  return (
    <section className="border-b border-zinc-800 px-5 py-3">
      <button onClick={() => setCollapsed(!collapsed)} className="flex w-full items-center gap-2 text-left">
        <h3 className="ui-section-title">Checkpoints</h3>
        {items.length > 0 && (
          <>
            <span className="text-xs text-zinc-500">
              {done}/{items.length}
            </span>
            <div className="ui-progress flex-1">
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
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!e.repeat) add();
              }
            }}
            aria-label="Añadir checkpoint"
            data-kb="checkpoint"
            placeholder={items.length ? "+ Añadir checkpoint…" : "+ Añade los pasos que quieres ver hechos (Enter). Claude también añadirá los suyos."}
            className="ui-field ui-control mt-1 w-full rounded-md bg-transparent px-2 py-1.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 hover:bg-zinc-900 focus:bg-zinc-900 focus:ring-1 focus:ring-zinc-700"
          />
          {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
        </>
      )}
    </section>
  );
}

function CheckpointRow({ c, onToggle }: { c: Checkpoint; onToggle: () => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(c.text);
  useEffect(() => setV(c.text), [c.text]);
  const busy = useRef(false);
  const canceled = useRef(false);
  const save = async () => {
    if (canceled.current) { canceled.current = false; return; }
    if (busy.current) return;
    if (!v.trim() || v.trim() === c.text) { setV(c.text); setEditing(false); return; }
    busy.current = true;
    try { await api(`/api/checkpoints/${c.id}`, { text: v.trim() }, "PATCH"); setEditing(false); }
    catch (e) { reportError((e as Error).message); }
    finally { busy.current = false; }
  };
  return (
    <li className="checkpoint-row group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-900">
      <input type="checkbox" checked={c.done} onChange={onToggle} className="ui-field mt-[3px] h-3.5 w-3.5 shrink-0 cursor-pointer accent-emerald-500" />
      {editing ? (
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); save(); }
            if (e.key === "Escape") {
              e.stopPropagation();
              canceled.current = true;
              setV(c.text);
              setEditing(false);
            }
          }}
          className="ui-field flex-1 bg-transparent text-sm text-zinc-100 outline-none"
        />
      ) : (
        <button onClick={() => { canceled.current = false; setEditing(true); }} className={`flex-1 cursor-text text-left text-sm leading-snug ${c.done ? "text-zinc-500 line-through" : "text-zinc-200"}`}>
          <InlineCode text={c.text} />
        </button>
      )}
      {c.source === "agent" && (
        <span className="mt-0.5 shrink-0 rounded bg-violet-500/10 px-1.5 text-[10px] text-waiting/80" title="Añadido por Claude">
          Claude
        </span>
      )}
      <button
        onClick={() => api(`/api/checkpoints/${c.id}`, undefined, "DELETE").catch(e => reportError(e.message))}
        className="ui-reveal shrink-0 text-xs text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-danger"
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

/** The card preparation split this one from, or the sub-cards it was split into. */
function Family({ card, board, onOpen }: { card: Card; board: Board; onOpen?: (id: string) => void }) {
  const mother = card.parent_id ? board.cards[card.parent_id] : undefined;
  const kids = Object.values(board.cards)
    .filter((c) => c.parent_id === card.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (!mother && !kids.length) return null;
  const link = "truncate text-left text-zinc-200 underline-offset-2 hover:text-sky-300 hover:underline";
  if (mother)
    return (
      <p className="mt-2 flex min-w-0 items-center gap-1.5 text-[12.5px] text-zinc-400">
        <CornerLeftUp className="h-3.5 w-3.5 shrink-0 text-sky-300" /> Sub-tarjeta de
        <button className={link} onClick={() => onOpen?.(mother.id)} title="Abrir la tarjeta madre">
          {mother.title}
        </button>
      </p>
    );
  const merged = kids.filter((k) => k.column === "merged").length;
  return (
    <div className="mt-3 rounded-lg bg-ui-ink/[0.03] px-3 py-2 ring-1 ring-ui-ink/[0.06]">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-zinc-300">
        <Network className="h-3.5 w-3.5 text-sky-300" /> Sub-tarjetas
        <span className={`tabular ml-auto text-[11px] ${merged === kids.length ? "text-success" : "text-zinc-500"}`}>
          {merged}/{kids.length} mergeadas
        </span>
      </div>
      <ul className="space-y-1">
        {kids.map((k) => (
          <li key={k.id} className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <ColumnChip column={k.column} />
            <button className={`${link} min-w-0 flex-1 ${k.column === "merged" ? "line-through decoration-zinc-600" : ""}`} onClick={() => onOpen?.(k.id)}>
              {k.title}
            </button>
            {k.status !== "idle" && <StatusBadge card={k} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ColumnChip({ column }: { column: Column }) {
  const Icon = COLUMN_ICON[column];
  return (
    <span className="flex items-center gap-1.5 rounded-md bg-ui-ink/[0.04] px-2 py-1 text-[11.5px] font-medium text-zinc-300 ring-1 ring-ui-ink/[0.06]">
      <Icon className="h-3.5 w-3.5" style={{ color: COLUMN_HEX[column] }} />
      {COLUMN_LABELS[column]}
    </span>
  );
}

/** What the card's dev agent uses when the card has no model of its own: the first tag added to it that has a model, else the project's. */
function inheritedModelLabel(card: Card, tags: Tag[], project: Project | null | undefined) {
  const tag = cardTags(card, tags).find((t) => t.model);
  return tag ? `Modelo de la etiqueta «${tag.name}», la primera con modelo (${modelLabel(tag.model)})` : `Modelo del proyecto (${modelLabel(project?.model_dev)})`;
}
