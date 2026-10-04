import { X } from "lucide-react";
import { useMessageDraft, useChatScroll } from "./chat";
import { reportError } from "./notifications";
import { useEffect, useRef, useState } from "react";
import type { AssistantMessage, Project } from "../../shared/types";
import { ModelPicker } from "./models";
import { confirmDialog } from "./Confirm";
import { api, type Board } from "./api";
import { Button, ChatHint, chatKeyDown, Markdown, Spinner } from "./ui";

export type AssistantMode = AssistantMessage["mode"];

function useAssistant(board: Board, projectId: string, mode: AssistantMode) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ messages: AssistantMessage[]; running: boolean }>(`/api/projects/${projectId}/assistant?mode=${mode}`).then((r) => {
        if (!alive) return;
        setMessages(r.messages);
        setRunning(r.running);
      });
    load();
    const off = board.on((e) => {
      if (e.type === "assistant_message" && e.message.project_id === projectId && e.message.mode === mode)
        setMessages((prev) => (prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message]));
      if (e.type === "assistant_status" && e.mode === mode) setRunning(e.running);
      if (e.type === "sync") load(); // written from another computer
    });
    return () => {
      alive = false;
      off();
    };
  }, [projectId, mode]);
  return { messages, setMessages, running };
}

/** Browser speech-to-text (Chrome/Safari/Edge). Firefox doesn't have it: use macOS dictation there. */
function useDictation(onText: (text: string) => void) {
  const SR = (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: any }).webkitSpeechRecognition;
  const [listening, setListening] = useState(false);
  const rec = useRef<any>(null);

  const start = (base: string) => {
    if (!SR) return;
    const r = new SR();
    r.lang = "es-ES";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (ev: any) => {
      let said = "";
      for (let i = 0; i < ev.results.length; i++) said += ev.results[i][0].transcript;
      onText((base ? base.trimEnd() + " " : "") + said.trim());
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    r.start();
    rec.current = r;
    setListening(true);
  };
  const stop = () => {
    rec.current?.stop();
    setListening(false);
  };
  return { supported: !!SR, listening, start, stop };
}

const COPY: Record<AssistantMode, { title: string; sub: string; placeholder: string; reset: string }> = {
  plan: {
    title: "Tarjetas",
    sub: "Cuéntale ideas como te salgan; las convierte en tarjetas bien descritas.",
    placeholder: "Cuéntale qué quieres…",
    reset: "¿Empezar una conversación nueva? Las tarjetas creadas se quedan.",
  },
  do: {
    title: "Directo",
    sub: "Cosas pequeñas sin tarjeta: lo hace en el repo y hace commit.",
    placeholder: "Pídele algo pequeño…",
    reset: "¿Empezar una conversación nueva? Los commits hechos se quedan.",
  },
};

export function AssistantPanel({
  projectId,
  board,
  onOpenCard,
  mode,
  setMode,
  project,
  onProjectChange,
  onClose,
}: {
  projectId: string;
  board: Board;
  onOpenCard: (id: string) => void;
  mode: AssistantMode;
  setMode: (m: AssistantMode) => void;
  project?: Project;
  onProjectChange: () => void;
  onClose: () => void;
}) {
  const roleKey = mode === "plan" ? "model_plan" : "model_do";
  return (
    <aside className="work-panel flex h-full w-[min(480px,100vw)] shrink-0 flex-col border-l border-ui-ink/[0.06] bg-panel shadow-[-24px_0_48px_-24px_rgb(0_0_0/0.6)]">
      <div className="ui-tabs flex-wrap border-b border-ui-ink/10 px-3 pt-2">
        {(["plan", "do"] as AssistantMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`ui-tab -mb-px border-b-2 px-3 py-1.5 text-sm ${mode === m ? "border-indigo-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
          >
            {COPY[m].title}
            <kbd className="ml-1.5 font-mono text-[10px] text-zinc-600">{m === "plan" ? "t" : "d"}</kbd>
          </button>
        ))}
        {project && (
          <ModelPicker
            className="mb-1 ml-auto min-w-0 max-w-full self-center"
            value={project[roleKey]}
            title="Modelo de esta pestaña (para este proyecto)"
            onChange={async (v) => {
              await api(`/api/projects/${projectId}`, { [roleKey]: v ?? "claude" }, "PATCH");
              onProjectChange();
            }}
          />
        )}
        <button onClick={onClose} aria-label="Cerrar asistente" className="mb-1 rounded-lg p-2 text-zinc-400 hover:bg-ui-ink/5"><X className="h-4 w-4" /></button>
      </div>
      <Chat key={mode} projectId={projectId} board={board} onOpenCard={onOpenCard} mode={mode} />
    </aside>
  );
}

function Chat({ projectId, board, onOpenCard, mode }: { projectId: string; board: Board; onOpenCard: (id: string) => void; mode: AssistantMode }) {
  const { messages, setMessages, running } = useAssistant(board, projectId, mode);
  const copy = COPY[mode];
  const { text, setText, current } = useMessageDraft(`assistant-draft:${projectId}:${mode}`);
  const scroll = useChatScroll(messages.length);
  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const dictation = useDictation(setText);


  const send = async () => {
    const t = current.current.trim();
    if (!t || busy.current) return;
    if (dictation.listening) dictation.stop();
    busy.current = true; setSending(true);
    const submitted = current.current;
    try { await api(`/api/projects/${projectId}/assistant`, { text: t, mode }); if (current.current === submitted) setText(""); }
    catch (e) { reportError((e as Error).message); }
    finally { busy.current = false; setSending(false); }
  };

  return (
    <>
      <div className="flex items-start gap-2 border-b border-zinc-800 px-4 py-2.5">
        <p className="text-xs text-zinc-500">{copy.sub}</p>
        {messages.length > 0 && (
          <button
            onClick={async () => {
              if (!(await confirmDialog({ title: "¿Nueva conversación?", body: copy.reset.replace(/^¿[^?]*\?\s*/, ""), confirmLabel: "Empezar de nuevo" })))
                return;
              await api(`/api/projects/${projectId}/assistant?mode=${mode}`, undefined, "DELETE");
              setMessages([]);
            }}
            className="ml-auto shrink-0 text-xs text-zinc-500 hover:text-zinc-200"
          >
            Nueva conversación
          </button>
        )}
      </div>

      <div ref={scroll.container} onScroll={scroll.onScroll} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.length === 0 && mode === "do" && (
          <div className="space-y-2 pt-6 text-sm text-zinc-500">
            <p>Para lo que no merece una tarjeta. Por ejemplo:</p>
            <ul className="space-y-1.5">
              {[
                "Cambia el puerto por defecto a 3001 en la config",
                "Mueve los SVG de /public a /public/icons y arregla los imports",
                "¿Dónde se calcula el IVA?",
                "Actualiza React a la última versión",
              ].map((x) => (
                <li key={x} className="rounded-lg bg-zinc-900 px-3 py-2 text-zinc-400 italic">"{x}"</li>
              ))}
            </ul>
            <p>Trabaja directamente en tu repo (rama actual) y al terminar hace commit solo de lo que ha tocado. Si lo que pides es grande, te propondrá crear una tarjeta.</p>
          </div>
        )}
        {messages.length === 0 && mode === "plan" && (
          <div className="space-y-2 pt-6 text-sm text-zinc-500">
            <p>Por ejemplo:</p>
            <p className="rounded-lg bg-zinc-900 p-3 text-zinc-400 italic">
              "Quiero que los camareros puedan dividir la cuenta por comensal, y también que el cierre de caja saque un
              PDF con el arqueo. Ah, y lo del modo oscuro que te dije, que respete el del sistema."
            </p>
            <p>Mira el código, separa las ideas en tarjetas independientes (para que los agentes puedan hacerlas en paralelo) y les pone spec y checkpoints. Si hablas de una tarjeta que ya existe, la actualiza.</p>
          </div>
        )}
        {messages.map((m) => (
          <Row key={m.id} m={m} onOpenCard={onOpenCard} />
        ))}
        {running && (
          <div className="flex items-center gap-2 text-xs text-warning/80">
            <Spinner /> {mode === "do" ? "trabajando…" : "pensando…"}
            <button onClick={() => api(`/api/projects/${projectId}/assistant/stop?mode=${mode}`, {})} className="ml-2 text-zinc-500 hover:text-zinc-200">
              parar
            </button>
          </div>
        )}
        <div ref={scroll.end} />
      </div>

      {scroll.unread && <button onClick={scroll.jump} className="self-center rounded-full bg-indigo-500/10 px-3 py-1 text-xs text-accent">Nuevos mensajes ↓</button>}
      <div className="border-t border-zinc-800 p-3">
        <div className={`flex items-end gap-2 rounded-lg bg-zinc-900 p-1.5 ring-1 ${dictation.listening ? "ring-red-500/60" : "ring-zinc-800 focus-within:ring-indigo-600"}`}>
          <textarea
            aria-label="Mensaje al asistente"
            data-kb="assistant"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => chatKeyDown(e, send, setText)}
            rows={3}
            placeholder={running ? "Se lo paso en cuanto termine…" : copy.placeholder}
            className="ui-field max-h-60 min-h-[3.5rem] flex-1 resize-y bg-transparent px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          <div className="flex flex-col gap-1">
            {dictation.supported && (
              <button
                onClick={() => (dictation.listening ? dictation.stop() : dictation.start(text))}
                className={`rounded-md px-2 py-1.5 text-sm ${dictation.listening ? "bg-red-500/20 text-danger" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"}`}
                title={dictation.listening ? "Parar dictado" : "Dictar"}
              >
                {dictation.listening ? "■" : "🎙"}
              </button>
            )}
            <Button aria-label="Enviar mensaje" variant="primary" onClick={send} disabled={!text.trim() || sending} className="!px-2.5 !py-1.5">
              ↑
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          <ChatHint /> ·{" "}
          {dictation.supported ? "🎙 para dictar" : "puedes usar el dictado del sistema"}
        </p>
      </div>
    </>
  );
}

function Row({ m, onOpenCard }: { m: AssistantMessage; onOpenCard: (id: string) => void }) {
  if (m.role === "user")
    return (
      <div className="flex justify-end">
        <div className="ui-message max-w-[90%] rounded-2xl rounded-br-md bg-indigo-500/15 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-100 ring-1 ring-indigo-500/20">{m.content}</div>
      </div>
    );
  if (m.role === "tool")
    return (
      <div className="truncate pl-1 font-mono text-[11px] text-zinc-500" title={m.content}>
        <span className="text-zinc-600">›</span> {m.content}
      </div>
    );
  if (m.role === "system" && m.card_id)
    return (
      <button
        onClick={() => onOpenCard(m.card_id!)}
        className="block w-full rounded-md bg-violet-500/10 px-3 py-1.5 text-left text-xs text-waiting ring-1 ring-violet-500/20 hover:bg-violet-500/15"
      >
        {m.content} <span className="text-waiting/70">→ abrir</span>
      </button>
    );
  if (m.role === "system") return <div className="rounded-md bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400">{m.content}</div>;
  return (
    <div className="ui-message px-1 text-zinc-200">
      <Markdown>{m.content}</Markdown>
    </div>
  );
}
