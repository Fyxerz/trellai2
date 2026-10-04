import { projectName, useDialogFocus } from "./preferences";
import { useEffect, useState } from "react";
import { api } from "./api";
import { CODEX_EFFORTS, EFFORT_LABELS, EFFORTS, prettyModel, splitEffort, withEffort, type Effort } from "../../shared/models";

/**
 * Models are written "engine" or "engine:model":
 *   claude, claude:opus, claude:sonnet, claude:claude-opus-4-8…  → Claude (your Claude Code login)
 *   codex, codex:<model>                                          → GPT via OpenAI Codex CLI (your ChatGPT login)
 * Aliases (opus, sonnet…) always run the latest version; the pickers show which one that is today.
 * An effort can follow: "claude:opus@high" (no "@" = the model's default effort).
 */
export const PRESETS: { value: string; label: string; group: "Claude" | "GPT (Codex)" }[] = [
  { value: "claude", label: "Claude (por defecto)", group: "Claude" },
  { value: "claude:opus", label: "Claude Opus", group: "Claude" },
  { value: "claude:sonnet", label: "Claude Sonnet", group: "Claude" },
  { value: "claude:haiku", label: "Claude Haiku", group: "Claude" },
  { value: "codex", label: "GPT (por defecto de Codex)", group: "GPT (Codex)" },
];

interface ClaudeModel {
  value: string;
  resolved: string | null;
  label: string;
  description: string;
  efforts?: Effort[];
}
interface LoginState {
  running: boolean;
  error?: string;
}
interface Engines {
  claude: { models: ClaudeModel[]; loggedIn?: boolean; login?: LoginState };
  codex: { installed: boolean; loggedIn?: boolean; version?: string; defaultModel?: string | null; login?: LoginState };
}

/** spec ("claude", "claude:opus", "codex") → exact version name ("Opus 5.5"), once /api/engines answers. */
const versions = new Map<string, string>();
let enginesCache: Promise<Engines> | null = null;
/** Every mounted useEngines(), so a fresh /api/engines (after a login) reaches all pickers. */
const engineListeners = new Set<(e: Engines) => void>();
const loadEngines = () =>
  (enginesCache ??= api<Engines>("/api/engines").then((e) => {
    versions.clear();
    for (const m of e.claude?.models ?? []) {
      const name = m.resolved ? prettyModel(m.resolved) : m.label;
      versions.set(m.value === "default" ? "claude" : `claude:${m.value}`, name);
    }
    if (e.codex?.defaultModel) versions.set("codex", prettyModel(`codex:${e.codex.defaultModel}`));
    return e;
  }));

/** Asks the server again (e.g. while waiting for a login) and updates every useEngines(). */
async function refreshEngines(): Promise<Engines> {
  enginesCache = null;
  const e = await loadEngines();
  engineListeners.forEach((l) => l(e));
  return e;
}

export function modelLabel(full: string | null | undefined, short = false): string {
  const { spec, effort } = splitEffort(full);
  const name = baseLabel(spec, short);
  return effort ? `${name} · ${EFFORT_LABELS[effort]}` : name;
}

function baseLabel(spec: string, short: boolean): string {
  const s = spec || "claude";
  const [engine, ...rest] = s.split(":");
  const model = rest.join(":");
  const exact = versions.get(s);
  if (engine === "codex") {
    if (model) return short ? "GPT" : `GPT · ${model}`;
    return short ? "GPT" : exact ? `${exact} (por defecto de Codex)` : "GPT (Codex)";
  }
  if (exact) return short || model ? exact : `Claude por defecto · ${exact}`;
  if (!model) return "Claude";
  const name = model.startsWith("claude-") ? prettyModel(model) : model[0].toUpperCase() + model.slice(1);
  return short ? name : `Claude ${name}`;
}

/** Engines + exact model versions (re-renders the caller when they arrive). */
export function useEngines() {
  const [engines, setEngines] = useState<Engines | null>(null);
  useEffect(() => {
    engineListeners.add(setEngines);
    loadEngines()
      .then(setEngines)
      .catch(() => setEngines({ claude: { models: [] }, codex: { installed: false } }));
    return () => void engineListeners.delete(setEngines);
  }, []);
  return {
    codex: engines?.codex ?? null,
    claude: engines?.claude.models ?? null,
    /** false = no Claude session; null while unknown */
    claudeLoggedIn: engines ? engines.claude.loggedIn !== false : null,
    /** the running server predates connection status (Trellai has to be restarted) */
    staleServer: !!engines && "installed" in engines.claude && !("loggedIn" in engines.claude),
  };
}

export function ModelPicker({
  value,
  onChange,
  inheritLabel,
  className = "",
  title,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  /** When set, offers an "inherit" option (value null) with this label. */
  inheritLabel?: string;
  className?: string;
  title?: string;
}) {
  const { codex, claude, claudeLoggedIn } = useEngines();
  const noCodex = codex && !codex.installed;
  const codexOff = codex?.installed && codex.loggedIn === false;
  // Aliases first (they follow the latest version), then pinned versions.
  const claudeOptions = claude?.length
    ? claude.map((m) => ({
        value: m.value === "default" ? "claude" : `claude:${m.value}`,
        label: m.value === "default" ? `Por defecto · ${modelLabel("claude", true)}` : modelLabel(`claude:${m.value}`, true),
        title: `${m.description}${m.resolved ? ` · ${m.resolved}` : ""}`,
        pinned: m.value.startsWith("claude-"),
      }))
    : PRESETS.filter((p) => p.group === "Claude").map((p) => ({ ...p, title: "", pinned: false }));
  const { spec, effort } = splitEffort(value);
  const known = [...claudeOptions.map((o) => o.value), "codex"];
  const custom = spec && !known.includes(spec) ? spec : null;
  const efforts = (s: string): Effort[] => {
    if (s.startsWith("codex")) return CODEX_EFFORTS;
    const m = claude?.find((x) => (x.value === "default" ? "claude" : `claude:${x.value}`) === s);
    // not listed (yet): offer them all, the SDK lowers what the model can't do
    return m?.efforts ?? [...EFFORTS];
  };
  const choose = (s: string | null, e: Effort | null) => {
    if (!s) return onChange(null);
    onChange(withEffort(s, e && efforts(s).includes(e) ? e : null));
  };
  const select = "rounded-md bg-zinc-900 px-2 py-1 text-xs text-zinc-200 ring-1 ring-zinc-700 outline-none focus:ring-indigo-600";
  const levels = value ? efforts(spec) : [];

  return (
    <span className={`flex items-center gap-1 ${className}`}>
      <select
        value={value ? spec : ""}
        title={
          title ??
          (noCodex
            ? "Para usar GPT instala la app de Codex de OpenAI y conéctala con tu cuenta de ChatGPT en Modelos del proyecto"
            : claudeLoggedIn === false || codexOff
              ? "Hay motores sin conectar: conéctalos en Modelos del proyecto"
              : undefined)
        }
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__other") {
            const name = prompt("Nombre del modelo de OpenAI (tal cual lo acepta `codex -m`):", "")?.trim();
            if (name) choose(`codex:${name}`, effort);
            return;
          }
          choose(v === "" ? null : v, effort);
        }}
        className={`${select} min-w-0 flex-1`}
      >
        {inheritLabel && <option value="">{inheritLabel}</option>}
        <optgroup label={claudeLoggedIn === false ? "Claude (no conectado)" : "Claude"}>
          {claudeOptions
            .filter((o) => !o.pinned)
            .map((o) => (
              <option key={o.value} value={o.value} title={o.title}>
                {o.label}
              </option>
            ))}
        </optgroup>
        {claudeOptions.some((o) => o.pinned) && (
          <optgroup label="Claude · versiones fijas">
            {claudeOptions
              .filter((o) => o.pinned)
              .map((o) => (
                <option key={o.value} value={o.value} title={o.title}>
                  {o.label}
                </option>
              ))}
          </optgroup>
        )}
        <optgroup label={noCodex ? "GPT (Codex no instalado)" : codexOff ? "GPT (Codex no conectado)" : "GPT (Codex)"}>
          <option value="codex" disabled={!!noCodex}>
            {modelLabel("codex")}
          </option>
          {custom && <option value={custom}>{modelLabel(custom)}</option>}
          <option value="__other" disabled={!!noCodex}>
            Otro modelo GPT…
          </option>
        </optgroup>
      </select>
      {levels.length > 0 && (
        <select
          value={effort ?? ""}
          title="Esfuerzo: cuánto piensa el modelo antes de responder. Más esfuerzo = mejor en tareas difíciles, pero más lento y gasta más."
          aria-label="Esfuerzo del modelo"
          onChange={(e) => choose(spec, (e.target.value || null) as Effort | null)}
          className={`${select} w-[7.5rem] shrink-0`}
        >
          <option value="">Esfuerzo por defecto</option>
          {levels.map((l) => (
            <option key={l} value={l}>
              Esfuerzo {EFFORT_LABELS[l].toLowerCase()}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

const ROLES: { key: "model_prep" | "model_dev" | "model_ui" | "model_plan" | "model_do"; label: string; hint: string }[] = [
  { key: "model_dev", label: "Desarrollo (Doing)", hint: "El que programa cada tarjeta." },
  { key: "model_ui", label: "Tarjetas de interfaz", hint: "Si el Asistente marca una tarjeta como de interfaz/estética, se le asigna este modelo." },
  { key: "model_prep", label: "Preparación", hint: "Lee la spec, pregunta y escribe los checkpoints." },
  { key: "model_plan", label: "Asistente · Tarjetas", hint: "Convierte tus ideas en tarjetas." },
  { key: "model_do", label: "Asistente · Directo", hint: "Cambios pequeños sin tarjeta." },
];

export function ProjectSettings({
  project,
  onClose,
  onSaved,
}: {
  project: import("../../shared/types").Project;
  onClose: () => void;
  onSaved: () => void;
}) {
  const save = async (key: string, value: string | null) => {
    await api(`/api/projects/${project.id}`, { [key]: value }, "PATCH");
    onSaved();
  };
  const dialogRef = useDialogFocus();
  return (
    <div data-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Modelos del proyecto" onClick={(e) => e.stopPropagation()} className="w-full max-w-lg space-y-4 rounded-2xl bg-zinc-900 p-5 ring-1 ring-ui-ink/[0.08] shadow-[var(--shadow-pop)]">
        <div className="flex items-center">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Modelos · {projectName(project.name)}</h2>
            <p className="text-xs text-zinc-500">Por defecto para este proyecto. Cada tarjeta puede elegir el suyo.</p>
          </div>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
        <div className="space-y-3">
          {ROLES.map((r) => (
            <div key={r.key} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-zinc-200">{r.label}</div>
                <div className="text-[11px] text-zinc-500">{r.hint}</div>
              </div>
              <ModelPicker
                value={(project[r.key] as string | null) ?? null}
                inheritLabel={r.key === "model_ui" ? "Igual que desarrollo" : undefined}
                onChange={(v) => save(r.key, v ?? (r.key === "model_ui" ? null : "claude"))}
                className="w-72"
              />
            </div>
          ))}
        </div>
        <EngineStatus />
      </div>
    </div>
  );
}

/** Is each engine connected? Offers a button that opens its login page in the browser. */
function EngineStatus() {
  const { codex, claudeLoggedIn, staleServer } = useEngines();
  const [waiting, setWaiting] = useState<Record<"claude" | "codex", boolean>>({ claude: false, codex: false });
  const [errors, setErrors] = useState<Record<"claude" | "codex", string | null>>({ claude: null, codex: null });

  const connect = async (engine: "claude" | "codex") => {
    setErrors((e) => ({ ...e, [engine]: null }));
    setWaiting((w) => ({ ...w, [engine]: true }));
    const fail = (msg: string) => {
      setErrors((e) => ({ ...e, [engine]: msg }));
      setWaiting((w) => ({ ...w, [engine]: false }));
    };
    try {
      await api(`/api/engines/${engine}/login`, {}, "POST");
    } catch (err) {
      return fail((err as Error).message || "No se pudo abrir el login.");
    }
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2500));
      let e: Engines;
      try {
        e = await refreshEngines();
      } catch {
        continue;
      }
      const state = engine === "claude" ? e.claude : e.codex;
      if (state.loggedIn) return setWaiting((w) => ({ ...w, [engine]: false }));
      if (!state.login?.running) return fail(state.login?.error || "El login no se completó. Vuelve a intentarlo.");
    }
    fail("Se agotó el tiempo esperando el login. Vuelve a intentarlo.");
  };

  const button = (engine: "claude" | "codex", label: string) => (
    <button
      onClick={() => connect(engine)}
      disabled={waiting[engine]}
      className="ml-auto shrink-0 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
    >
      {waiting[engine] ? "Esperando…" : label}
    </button>
  );
  const dot = (on: boolean | null) => <span className={`h-2 w-2 shrink-0 rounded-full ${on === null ? "bg-zinc-600" : on ? "bg-emerald-500" : "bg-amber-500"}`} />;
  const waitingHint = <div className="text-[11px] text-zinc-500">Se ha abierto el navegador: inicia sesión allí y vuelve aquí.</div>;
  const error = (engine: "claude" | "codex") => errors[engine] && <div className="text-[11px] text-red-400">{errors[engine]}</div>;
  const codexOn = codex ? codex.installed && codex.loggedIn !== false : null;
  if (staleServer)
    return (
      <div className="rounded-lg bg-zinc-950 p-3 text-xs text-amber-300 ring-1 ring-zinc-800">
        Trellai se ha actualizado pero el servidor sigue con la versión anterior. Reinicia Trellai para ver si Claude y GPT están conectados.
      </div>
    );

  return (
    <div className="space-y-3 rounded-lg bg-zinc-950 p-3 text-xs text-zinc-400 ring-1 ring-zinc-800">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          {dot(claudeLoggedIn)}
          <span className="text-zinc-200">Claude</span>
          <span>{claudeLoggedIn === null ? "Comprobando…" : claudeLoggedIn ? "Conectado" : "No conectado"}</span>
          {claudeLoggedIn === false && button("claude", "Conectar Claude")}
        </div>
        {waiting.claude && waitingHint}
        {error("claude")}
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          {dot(codexOn)}
          <span className="text-zinc-200">GPT · cuenta de ChatGPT</span>
          <span>
            {!codex ? "Comprobando…" : !codex.installed ? "No instalado" : codex.loggedIn === false ? "No conectado" : `Conectado · ${codex.version}`}
          </span>
          {codex?.installed && codex.loggedIn === false && button("codex", "Conectar GPT")}
        </div>
        {codex && !codex.installed && (
          <div className="text-[11px] text-zinc-500">
            Para usar GPT hace falta la app de Codex de OpenAI (o <code className="text-zinc-300">npm i -g @openai/codex</code>). Después
            podrás conectarla aquí con tu cuenta de ChatGPT.
          </div>
        )}
        {waiting.codex && waitingHint}
        {error("codex")}
      </div>
    </div>
  );
}
