import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, LogIn } from "lucide-react";
import type { GitHubLoginFlow, GitHubStatus } from "../../shared/types";
import { api } from "./api";
import { Button, Spinner } from "./ui";

const POLL_MS = 2000;
const TIMEOUT_MS = 10 * 60_000;

/**
 * «Conectar GitHub»: runs `gh auth login --web` on the server (which opens the browser) and shows
 * the one-time code to paste there, polling /api/github/status until it finishes.
 * `compact`: a small pill (for the header) whose code panel floats below it — the parent must be `relative`.
 */
export function GitHubConnect({ onConnected, compact = false }: { onConnected?: () => void; compact?: boolean }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [flow, setFlow] = useState<GitHubLoginFlow | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);
  const connected = useRef(onConnected);
  connected.current = onConnected;

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const poll = () => {
    stop();
    setPhase("waiting");
    const until = Date.now() + TIMEOUT_MS;
    let inFlight = false;
    timer.current = setInterval(async () => {
      if (inFlight) return;
      if (Date.now() > until) {
        stop();
        setPhase("idle");
        setError("Se agotó el tiempo esperando a GitHub. Vuelve a intentarlo.");
        return;
      }
      inFlight = true;
      let s: GitHubStatus;
      try {
        s = await api<GitHubStatus>("/api/github/status");
      } catch {
        return; // server busy or restarting: try again on the next tick
      } finally {
        inFlight = false;
      }
      if (!alive.current) return;
      if (s.loginFlow?.running) {
        setFlow(s.loginFlow);
        return;
      }
      stop();
      if (s.loggedIn) {
        setPhase("done");
        setTimeout(() => alive.current && connected.current?.(), 1200);
      } else {
        setPhase("idle");
        setError(s.loginFlow?.error || "No se completó la conexión con GitHub. Vuelve a intentarlo.");
      }
    }, POLL_MS);
  };

  useEffect(() => {
    alive.current = true;
    api<GitHubStatus>("/api/github/status")
      .then((s) => {
        if (!alive.current) return;
        setAvailable(s.available);
        // a login started elsewhere (another tab, another button) is still going: pick it up
        if (s.loginFlow?.running) {
          setFlow(s.loginFlow);
          poll();
        }
      })
      .catch(() => alive.current && setAvailable(true));
    return () => {
      alive.current = false;
      stop();
    };
  }, []);

  const start = async () => {
    setError(null);
    setCopied(false);
    setFlow(null);
    setPhase("starting");
    try {
      const f = await api<GitHubLoginFlow>("/api/github/login", {});
      if (!alive.current) return;
      if (f.error) {
        setPhase("idle");
        return setError(f.error);
      }
      setFlow(f);
      poll();
    } catch (e) {
      if (!alive.current) return;
      setPhase("idle");
      setError((e as Error).message || "No pude empezar la conexión con GitHub.");
    }
  };

  const copy = async () => {
    if (!flow?.code) return;
    try {
      await navigator.clipboard.writeText(flow.code);
      setCopied(true);
      setTimeout(() => alive.current && setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the code is selectable */
    }
  };

  if (available === false)
    return (
      <span className={compact ? "ml-1 text-[11px] text-zinc-500" : "text-sm text-zinc-400"}>
        No tienes <span className="font-mono">gh</span> instalado.{" "}
        <a href="https://cli.github.com" target="_blank" rel="noreferrer" className="text-accent hover:underline">
          Instálalo desde cli.github.com
        </a>
      </span>
    );

  if (phase === "done")
    return (
      <span className={`flex items-center gap-1 text-emerald-400 ${compact ? "ml-1 text-[11px]" : "text-sm"}`}>
        <Check className={compact ? "h-3 w-3" : "h-4 w-4"} /> Conectado
      </span>
    );

  const busy = phase !== "idle";
  const button = compact ? (
    <button
      type="button"
      onClick={start}
      disabled={busy || available === null}
      title="Inicia sesión en GitHub (gh auth login) para poder sincronizar por HTTPS"
      className="ml-1 flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-300 ring-1 ring-amber-500/30 transition hover:bg-amber-500/20 disabled:opacity-60"
    >
      {busy ? <Spinner className="h-3 w-3" /> : <LogIn className="h-3 w-3" />}
      {busy ? "Conectando…" : "Conectar GitHub"}
    </button>
  ) : (
    <Button size="sm" onClick={start} disabled={busy || available === null}>
      {busy ? <Spinner className="h-3.5 w-3.5" /> : <LogIn className="h-3.5 w-3.5" />}
      {busy ? "Conectando…" : "Conectar GitHub"}
    </Button>
  );

  const panel = (phase === "waiting" || error) && (
    <div
      className={`space-y-2 text-[12px] text-zinc-400 ${
        compact ? "absolute top-full left-0 z-40 mt-1.5 w-72 rounded-xl bg-zinc-900 p-3 font-sans shadow-[var(--shadow-pop)] ring-1 ring-ui-ink/[0.1]" : "mt-2"
      }`}
    >
      {phase === "waiting" && (
        <>
          {flow?.code ? (
            <>
              <div>Pega este código en GitHub:</div>
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-zinc-950 px-3 py-1.5 font-mono text-lg font-semibold tracking-widest text-zinc-50 ring-1 ring-zinc-800 select-all">
                  {flow.code}
                </span>
                <Button size="sm" variant="ghost" onClick={copy} title="Copiar el código">
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copiado" : "Copiar"}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Spinner className="h-3 w-3" /> Pidiendo el código a GitHub…
            </div>
          )}
          <div className="flex items-center gap-2 text-zinc-500">
            <a
              href={flow?.url || "https://github.com/login/device"}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              <ExternalLink className="h-3 w-3" /> Abrir GitHub
            </a>
            <span>· esperando a que autorices…</span>
          </div>
        </>
      )}
      {error && <div className="text-danger">{error}</div>}
    </div>
  );

  return compact ? (
    <>
      {button}
      {panel}
    </>
  ) : (
    <div>
      {button}
      {panel}
    </div>
  );
}
