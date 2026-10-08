import { AppWindow, ExternalLink, GitMerge, MousePointerClick, RefreshCw, RotateCcw, ScrollText, Send, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Card, Project, VistaPin, VistaStatus } from "../../shared/types";
import { api, type Board } from "./api";
import { useDictation } from "./Assistant";
import { reportError, reportInfo } from "./notifications";
import { Button, chatKeyDown, Kbd, Spinner } from "./ui";

/**
 * The Vista: the app of a card's branch (or of the base branch / the "rama de retoques")
 * running inside Trellai, with "Señalar" — point at elements and say what to change, instead
 * of sending screenshots. The page talks to the script Trellai injects into the app
 * (server/vista-picker.js) through postMessage.
 */

const SOURCE = "trellai-vista";

/** A pinned element: what the picker described, plus Pedro's comment. */
type Pin = VistaPin & { id: string };

const WIDTHS = [
  { id: "full", label: "Ancho total", px: null },
  { id: "tablet", label: "Tableta · 834", px: 834 },
  { id: "mobile", label: "Móvil · 390", px: 390 },
] as const;

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* optional storage */
  }
}

function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/** Polls the Vista's status while it's open (that also keeps the app running) and starts it once per target. */
function useVistaStatus(base: string) {
  const [status, setStatus] = useState<VistaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(new Set<string>());
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        let s = await api<VistaStatus>(base);
        const key = `${s.cardId ?? "main"}:${s.branch}`;
        if (s.state === "stopped" && !started.current.has(key)) {
          started.current.add(key);
          s = await api<VistaStatus>(`${base}/start`, {});
        }
        if (alive) {
          setStatus(s);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
      if (alive) timer = setTimeout(tick, 1500);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [base]);
  return { status, setStatus, error };
}

const STATE_LABEL: Record<VistaStatus["state"], string> = {
  stopped: "Parada",
  waiting: "Esperando la rama…",
  installing: "Instalando dependencias…",
  starting: "Arrancando…",
  ready: "Lista",
  error: "Error",
};

export function Vista({
  project,
  cardId,
  board,
  onClose,
  onOpenCard,
}: {
  project: Project;
  /** a card's Vista; null = the project's (base branch, or its open rama de retoques) */
  cardId: string | null;
  board: Board;
  onClose: () => void;
  onOpenCard: (id: string) => void;
}) {
  const base = cardId ? `/api/cards/${cardId}/vista` : `/api/projects/${project.id}/vista`;
  const scope = cardId ? `card:${cardId}` : `project:${project.id}`;
  const { status, setStatus, error } = useVistaStatus(base);
  const target: Card | undefined = status?.cardId ? board.cards[status.cardId] : undefined;

  const frame = useRef<HTMLIFrameElement>(null);
  const host = location.hostname.includes(":") ? `[${location.hostname}]` : location.hostname;
  const origin = status?.port ? `${location.protocol}//${host}:${status.port}` : null;
  const [page, setPage] = useState(() => load<string>(`trellai:vista-page:${scope}`, "/"));
  const [src, setSrc] = useState<string | null>(null);
  // A new target (or the first status) loads the page we were on.
  useEffect(() => {
    if (origin) setSrc(`${origin}${page.startsWith("/") ? page : `/${page}`}`);
  }, [origin]);
  const [address, setAddress] = useState(page);
  useEffect(() => setAddress(page), [page]);

  const [pins, setPins] = useState<Pin[]>(() => load<Pin[]>(`trellai:vista-pins:${scope}`, []));
  useEffect(() => save(`trellai:vista-pins:${scope}`, pins), [pins, scope]);
  const [note, setNote] = useState(() => load<string>(`trellai:vista-note:${scope}`, ""));
  useEffect(() => save(`trellai:vista-note:${scope}`, note), [note, scope]);
  const [picking, setPicking] = useState(false);
  const [sending, setSending] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [width, setWidth] = useState<(typeof WIDTHS)[number]["id"]>(() => load(`trellai:vista-width`, "full"));
  useEffect(() => save("trellai:vista-width", width), [width]);
  const focusPin = useRef<string | null>(null);
  const dictation = useDictation(setNote);

  const post = (msg: Record<string, unknown>) => {
    if (origin) frame.current?.contentWindow?.postMessage({ ...msg, source: SOURCE }, origin);
  };
  const pinsForPage = (list: Pin[]) => list.map((p, i) => ({ id: p.id, n: i + 1, selector: p.selector, page: p.page }));

  // Keep the app's overlay in sync: pick mode and the numbered pins.
  useEffect(() => post({ type: "pick", on: picking }), [picking, origin]);
  useEffect(() => post({ type: "pins", pins: pinsForPage(pins) }), [pins, origin]);

  const state = useRef({ picking, pins });
  state.current = { picking, pins };
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!origin || e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      const m = e.data as { source?: string; type?: string; url?: string; id?: string; pin?: VistaPin; keep?: boolean; on?: boolean };
      if (m?.source !== SOURCE) return;
      if (m.type === "hello") {
        if (typeof m.url === "string") {
          setPage(m.url);
          save(`trellai:vista-page:${scope}`, m.url);
        }
        post({ type: "pick", on: state.current.picking });
        post({ type: "pins", pins: pinsForPage(state.current.pins) });
      } else if (m.type === "picked" && m.pin && m.id) {
        const pin: Pin = { ...m.pin, comment: "", id: m.id };
        focusPin.current = m.id;
        setPins((list) => [...list, pin]);
        setPicking(!!m.keep);
      } else if (m.type === "picking") setPicking(!!m.on);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, scope]);

  // Focus the comment of the element just picked.
  useEffect(() => {
    if (!focusPin.current) return;
    document.querySelector<HTMLTextAreaElement>(`[data-pin="${focusPin.current}"]`)?.focus();
    focusPin.current = null;
  }, [pins]);

  const reload = () => post({ type: "reload" });
  const restart = async () => {
    try {
      setStatus(await api<VistaStatus>(`${base}/restart`, {}));
    } catch (e) {
      reportError((e as Error).message);
    }
  };
  const go = (path: string) => {
    if (!origin) return;
    const p = path.trim().startsWith("/") ? path.trim() : `/${path.trim()}`;
    setPage(p);
    save(`trellai:vista-page:${scope}`, p);
    setSrc(`${origin}${p}`);
  };

  const ready = pins.length > 0 && (!!note.trim() || pins.every((p) => p.comment.trim()));
  const send = async () => {
    if (!ready || sending) return;
    if (dictation.listening) dictation.stop();
    setSending(true);
    try {
      const card = await api<Card>(`${base}/pins`, { pins: pins.map(({ id: _id, ...p }) => p), note });
      setPins([]);
      setNote("");
      setPicking(false);
      reportInfo(`Enviado a «${card.title}»`);
    } catch (e) {
      reportError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  // Keys: s señalar, r recargar, Esc stops picking / closes.
  const keys = useRef({ onClose, reload });
  keys.current = { onClose, reload };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (typing(e)) (e.target as HTMLElement).blur();
        else if (state.current.picking) setPicking(false);
        else keys.current.onClose();
        return;
      }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.key === "s") {
        e.preventDefault();
        setPicking((p) => !p);
      } else if (e.key === "r") {
        e.preventDefault();
        keys.current.reload();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const s = status?.state;
  const busy = s === "starting" || s === "installing" || s === "waiting";
  useEffect(() => {
    if (s === "error") setShowLog(true);
  }, [s]);
  const frameWidth = WIDTHS.find((w) => w.id === width)?.px;
  const where = !cardId && !target
    ? "Se crea una rama de retoques que va directa a Doing; lo que señales después se suma a ella hasta que la mergees."
    : target?.column === "review"
      ? `Se lo mando a «${target.title}»: vuelve a Doing con estos cambios.`
      : target
        ? `Se lo mando al agente de «${target.title}».`
        : "";

  return (
    <div data-modal role="dialog" aria-modal="true" aria-label="Vista" className="fixed inset-0 z-50 flex flex-col bg-panel">
      <header className="flex items-center gap-2 border-b border-ui-ink/[0.08] px-3 py-2">
        <AppWindow className="h-4 w-4 text-zinc-400" />
        <span className="text-sm font-semibold text-zinc-100">Vista</span>
        <span className="max-w-[13rem] shrink-0 truncate rounded-md bg-ui-ink/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-zinc-300" title={`Rama que se está viendo: ${status?.branch ?? project.base_branch}`}>
          {status?.branch ?? project.base_branch}
        </span>
        {target && (
          <button onClick={() => onOpenCard(target.id)} className="max-w-[14rem] min-w-0 truncate text-[12.5px] text-zinc-300 hover:underline" title={`Abrir la tarjeta «${target.title}»`}>
            {target.title}
          </button>
        )}
        {target?.status === "running" && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-amber-400/10 px-2 py-0.5 text-[11.5px] text-warning" title="El agente está aplicando los cambios; la vista se recarga sola">
            <Spinner /> Cambiando…
          </span>
        )}
        <span
          className={`flex shrink-0 items-center gap-1.5 text-[11.5px] ${s === "error" ? "text-danger" : s === "ready" ? "text-success" : "text-zinc-400"}`}
          title={status?.command ? `Comando: ${status.command}` : undefined}
        >
          {busy ? <Spinner /> : <span className={`h-1.5 w-1.5 rounded-full ${s === "ready" ? "bg-emerald-400" : s === "error" ? "bg-red-500" : "bg-zinc-500"}`} />}
          {s ? STATE_LABEL[s] : "Cargando…"}
        </span>

        <form
          className="mx-1 flex min-w-28 flex-1 items-center rounded-lg bg-ui-ink/[0.04] px-2 ring-1 ring-ui-ink/[0.08] focus-within:ring-indigo-400"
          onSubmit={(e) => {
            e.preventDefault();
            go(address);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <span className="font-mono text-[11px] text-zinc-500">{origin ? origin.replace(/^https?:\/\//, "") : ""}</span>
          <input
            aria-label="Página de la app"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="ui-field h-7 min-w-0 flex-1 bg-transparent font-mono text-[12px] text-zinc-200 outline-none"
          />
        </form>

        <select
          aria-label="Ancho de la vista"
          value={width}
          onChange={(e) => setWidth(e.target.value as typeof width)}
          className="h-8 shrink-0 rounded-lg bg-ui-ink/[0.04] px-2 text-xs text-zinc-300 ring-1 ring-ui-ink/[0.08]"
        >
          {WIDTHS.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          className="shrink-0"
          variant={picking ? "primary" : "default"}
          aria-pressed={picking}
          disabled={s !== "ready"}
          onClick={() => setPicking(!picking)}
          title="Señala un elemento de la app para decir qué cambiar (s). Mayús+clic para señalar varios seguidos."
        >
          <MousePointerClick className="h-3.5 w-3.5" /> Señalar <Kbd>s</Kbd>
        </Button>
        <IconButton title="Recargar la página (r)" onClick={reload} disabled={s !== "ready"}>
          <RefreshCw className="h-4 w-4" />
        </IconButton>
        <IconButton title="Reiniciar el servidor de la app" onClick={restart}>
          <RotateCcw className="h-4 w-4" />
        </IconButton>
        <IconButton title={showLog ? "Ocultar el registro del servidor" : "Ver el registro del servidor"} onClick={() => setShowLog(!showLog)} active={showLog}>
          <ScrollText className="h-4 w-4" />
        </IconButton>
        <IconButton title="Abrir en una pestaña (sin Señalar)" onClick={() => origin && window.open(`${origin}${page}`, "_blank")} disabled={!origin}>
          <ExternalLink className="h-4 w-4" />
        </IconButton>
        {target?.column === "review" && target.status !== "running" && (
          <Button
            size="sm"
            variant="primary"
            className="shrink-0"
            onClick={() => api(`/api/cards/${target.id}/move`, { column: "merged" }).catch((e) => reportError((e as Error).message))}
            title={`Mergear «${target.title}» en ${project.base_branch}`}
          >
            <GitMerge className="h-3.5 w-3.5" /> Mergear
          </Button>
        )}
        <IconButton title="Cerrar (Esc)" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col bg-zinc-950/40">
          <div className="relative min-h-0 flex-1 overflow-auto">
            {src && (
              <iframe
                ref={frame}
                key={origin}
                src={src}
                title="App"
                className="mx-auto block h-full border-0 bg-white"
                style={{ width: frameWidth ? `${frameWidth}px` : "100%" }}
              />
            )}
            {(error || (s && s !== "ready")) && (
              <div className="absolute inset-0 flex items-center justify-center bg-panel/90 p-6">
                <div className="max-w-lg text-center">
                  {busy && <Spinner className="mx-auto mb-3 h-5 w-5 text-zinc-400" />}
                  <p className={`text-sm ${s === "error" || error ? "text-danger" : "text-zinc-300"}`}>
                    {error ?? status?.message ?? (s ? STATE_LABEL[s] : "")}
                  </p>
                  {status?.command && <p className="mt-1 font-mono text-[11px] text-zinc-500">{status.command}</p>}
                  {(s === "error" || s === "stopped") && (
                    <Button className="mt-3" size="sm" onClick={restart}>
                      <RotateCcw className="h-3.5 w-3.5" /> {s === "error" ? "Reintentar" : "Arrancar"}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          {showLog && <Log lines={status?.log ?? []} />}
        </div>

        <aside aria-label="Señalado" className="flex w-80 shrink-0 flex-col border-l border-ui-ink/[0.08]">
          <div className="flex items-center gap-2 px-4 pt-3 pb-2">
            <h3 className="text-sm font-semibold text-zinc-100">Señalado</h3>
            {pins.length > 0 && <span className="tabular text-xs text-zinc-500">{pins.length}</span>}
            {pins.length > 0 && (
              <button onClick={() => setPins([])} className="ml-auto text-[11.5px] text-zinc-500 hover:text-zinc-300">
                Quitar todo
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
            {!pins.length && (
              <div className="mt-6 px-2 text-center text-[12.5px] text-zinc-500">
                <MousePointerClick className="mx-auto mb-2 h-6 w-6 opacity-50" />
                Pulsa <Kbd>s</Kbd> o <b className="font-medium text-zinc-300">Señalar</b> y haz clic en lo que quieras cambiar. Escribe qué cambiar y envíalo: el agente recibe el elemento exacto (texto, componente, fichero, estilos), no una captura.
              </div>
            )}
            {pins.map((p, i) => (
              <div key={p.id} className="rounded-xl bg-ui-ink/[0.03] p-2.5 ring-1 ring-ui-ink/[0.06]">
                <div className="flex items-start gap-2">
                  <button
                    onClick={() => post({ type: "focus", id: p.id })}
                    title="Verlo en la app"
                    className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white"
                  >
                    {i + 1}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-zinc-200" title={p.tag}>
                      {p.text ? `«${p.text}»` : <span className="font-mono">{p.tag.match(/^<[\w-]+/)?.[0]}&gt;</span>}
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-zinc-500" title={[p.components.join(" ← "), p.source, p.page].filter(Boolean).join(" · ")}>
                      {[p.components[0], p.source || p.selector].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <button
                    aria-label={`Quitar el ${i + 1}`}
                    onClick={() => setPins((list) => list.filter((x) => x.id !== p.id))}
                    className="rounded p-1 text-zinc-500 hover:bg-ui-ink/[0.06] hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <textarea
                  data-pin={p.id}
                  aria-label={`Qué cambiar en el ${i + 1}`}
                  value={p.comment}
                  rows={2}
                  onChange={(e) => {
                    const comment = e.target.value;
                    setPins((list) => list.map((x) => (x.id === p.id ? { ...x, comment } : x)));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder="¿Qué cambio aquí? (p. ej. «a la derecha de Cancelar, algo más grande»)"
                  className="ui-field mt-2 w-full resize-y rounded-lg bg-transparent px-2 py-1.5 text-[12.5px] text-zinc-100 ring-1 ring-ui-ink/[0.08] outline-none placeholder:text-zinc-600 focus:ring-indigo-400"
                />
              </div>
            ))}
          </div>
          <div className="border-t border-ui-ink/[0.08] p-3">
            <div className={`flex items-end gap-1.5 rounded-lg p-1 ring-1 ${dictation.listening ? "ring-red-500/60" : "ring-ui-ink/[0.08] focus-within:ring-indigo-400"}`}>
              <textarea
                aria-label="Comentario general"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => chatKeyDown(e, send)}
                rows={2}
                placeholder={pins.length ? "Algo general (opcional)…" : "Señala algo primero"}
                className="ui-field max-h-40 min-h-[2.5rem] flex-1 resize-y bg-transparent px-1.5 py-1 text-[12.5px] text-zinc-100 outline-none placeholder:text-zinc-600"
              />
              {dictation.supported && (
                <button
                  onClick={() => (dictation.listening ? dictation.stop() : dictation.start(note))}
                  className={`rounded-md px-2 py-1.5 text-sm ${dictation.listening ? "bg-red-500/20 text-danger" : "text-zinc-400 hover:bg-ui-ink/[0.06] hover:text-zinc-200"}`}
                  title={dictation.listening ? "Parar dictado" : "Dictar"}
                >
                  {dictation.listening ? "■" : "🎙"}
                </button>
              )}
            </div>
            {where && <p className="mt-2 text-[11px] leading-snug text-zinc-500">{where}</p>}
            {pins.length > 0 && !ready && <p className="mt-1 text-[11px] text-warning">Escribe qué cambiar en cada elemento (o un comentario general).</p>}
            <Button variant="primary" className="mt-2 w-full" disabled={!ready || sending} onClick={send}>
              {sending ? <Spinner /> : <Send className="h-3.5 w-3.5" />}
              Enviar {pins.length > 1 ? `${pins.length} cambios` : pins.length === 1 ? "el cambio" : ""}
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Log({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, lines[lines.length - 1]]);
  return (
    <pre
      ref={ref}
      aria-label="Registro del servidor"
      className="max-h-[40%] min-h-24 overflow-auto border-t border-ui-ink/[0.08] bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-400"
    >
      {lines.length ? lines.join("\n") : "(sin salida todavía)"}
    </pre>
  );
}

function IconButton({ title, onClick, children, disabled, active }: { title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`shrink-0 rounded-lg p-1.5 transition disabled:opacity-40 ${active ? "bg-ui-ink/[0.08] text-zinc-100" : "text-zinc-400 hover:bg-ui-ink/[0.06] hover:text-zinc-100"}`}
    >
      {children}
    </button>
  );
}
