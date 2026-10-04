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
interface Engines {
  claude: { models: ClaudeModel[] };
  codex: { installed: boolean; version?: string; defaultModel?: string | null };
}

/** spec ("claude", "claude:opus", "codex") → exact version name ("Opus 5.5"), once /api/engines answers. */
const versions = new Map<string, string>();
let enginesCache: Promise<Engines> | null = null;
const loadEngines = () =>
  (enginesCache ??= api<Engines>("/api/engines").then((e) => {
    for (const m of e.claude?.models ?? []) {
      const name = m.resolved ? prettyModel(m.resolved) : m.label;
      versions.set(m.value === "default" ? "claude" : `claude:${m.value}`, name);
    }
    if (e.codex?.defaultModel) versions.set("codex", prettyModel(`codex:${e.codex.defaultModel}`));
    return e;
  }));

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
    loadEngines()
      .then(setEngines)
      .catch(() => setEngines({ claude: { models: [] }, codex: { installed: false } }));
  }, []);
  return { codex: engines?.codex ?? null, claude: engines?.claude.models ?? null };
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
  const { codex, claude } = useEngines();
  const noCodex = codex && !codex.installed;
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
        title={title ?? (noCodex ? "Para usar GPT instala Codex: npm i -g @openai/codex y luego codex login" : undefined)}
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
        <optgroup label="Claude">
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
        <optgroup label={noCodex ? "GPT (Codex no instalado)" : "GPT (Codex)"}>
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
  const { codex } = useEngines();
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
        {project.tags.length > 0 && (
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <div>
              <div className="text-sm text-zinc-200">Modelos por etiqueta</div>
              <div className="text-[11px] text-zinc-500">
                Para desarrollar, una tarjeta con esta etiqueta usa este modelo (salvo que la tarjeta elija el suyo). Con varias, manda la primera de esta lista.
              </div>
            </div>
            {project.tags.map((t) => (
              <div key={t.id} className="flex items-center gap-3">
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-zinc-200">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: t.color }} />
                  <span className="truncate">{t.name}</span>
                </span>
                <ModelPicker
                  value={t.model ?? null}
                  inheritLabel="Sin modelo (usa el del proyecto)"
                  onChange={(v) => api(`/api/projects/${project.id}/tags/${t.id}`, { model: v }, "PATCH").then(onSaved)}
                  className="w-72"
                />
              </div>
            ))}
          </div>
        )}
        <div className="rounded-lg bg-zinc-950 p-3 text-xs text-zinc-400 ring-1 ring-zinc-800">
          {codex?.installed ? (
            <>GPT disponible vía Codex ({codex.version}). Usa tu sesión de <code className="text-zinc-300">codex login</code>.</>
          ) : (
            <>
              Para usar GPT instala Codex en tu Mac: <code className="text-zinc-300">npm i -g @openai/codex</code> y después{" "}
              <code className="text-zinc-300">codex login</code> (con tu cuenta de ChatGPT). Luego reinicia Trellai.
            </>
          )}
        </div>
      </div>
    </div>
  );
}
