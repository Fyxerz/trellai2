import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Models are written "engine" or "engine:model":
 *   claude, claude:opus, claude:sonnet, claude:haiku  → Claude (your Claude Code login)
 *   codex, codex:<model>                              → GPT via OpenAI Codex CLI (your ChatGPT login)
 */
export const PRESETS: { value: string; label: string; group: "Claude" | "GPT (Codex)" }[] = [
  { value: "claude", label: "Claude (por defecto)", group: "Claude" },
  { value: "claude:opus", label: "Claude Opus", group: "Claude" },
  { value: "claude:sonnet", label: "Claude Sonnet", group: "Claude" },
  { value: "claude:haiku", label: "Claude Haiku", group: "Claude" },
  { value: "codex", label: "GPT (por defecto de Codex)", group: "GPT (Codex)" },
];

export function modelLabel(spec: string | null | undefined, short = false): string {
  const s = spec || "claude";
  const [engine, ...rest] = s.split(":");
  const model = rest.join(":");
  if (engine === "codex") return model ? (short ? "GPT" : `GPT · ${model}`) : short ? "GPT" : "GPT (Codex)";
  if (!model) return "Claude";
  const name = model[0].toUpperCase() + model.slice(1);
  return short ? name : `Claude ${name}`;
}

let enginesCache: Promise<{ codex: { installed: boolean; version?: string } }> | null = null;

export function useEngines() {
  const [codex, setCodex] = useState<{ installed: boolean; version?: string } | null>(null);
  useEffect(() => {
    enginesCache ??= api<{ codex: { installed: boolean; version?: string } }>("/api/engines");
    enginesCache.then((r) => setCodex(r.codex)).catch(() => setCodex({ installed: false }));
  }, []);
  return { codex };
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
  const { codex } = useEngines();
  const noCodex = codex && !codex.installed;
  const custom = value && !PRESETS.some((p) => p.value === value) ? value : null;

  return (
    <select
      value={value ?? ""}
      title={title ?? (noCodex ? "Para usar GPT instala Codex: npm i -g @openai/codex y luego codex login" : undefined)}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "__other") {
          const name = prompt("Nombre del modelo de OpenAI (tal cual lo acepta `codex -m`):", "")?.trim();
          if (name) onChange(`codex:${name}`);
          return;
        }
        onChange(v === "" ? null : v);
      }}
      className={`rounded-md bg-zinc-900 px-2 py-1 text-xs text-zinc-200 ring-1 ring-zinc-700 outline-none focus:ring-indigo-600 ${className}`}
    >
      {inheritLabel && <option value="">{inheritLabel}</option>}
      <optgroup label="Claude">
        {PRESETS.filter((p) => p.group === "Claude").map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </optgroup>
      <optgroup label={noCodex ? "GPT (Codex no instalado)" : "GPT (Codex)"}>
        {PRESETS.filter((p) => p.group === "GPT (Codex)").map((p) => (
          <option key={p.value} value={p.value} disabled={!!noCodex}>
            {p.label}
          </option>
        ))}
        {custom && <option value={custom}>{modelLabel(custom)}</option>}
        <option value="__other" disabled={!!noCodex}>
          Otro modelo GPT…
        </option>
      </optgroup>
    </select>
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
  return (
    <div data-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg space-y-4 rounded-2xl bg-zinc-900 p-5 ring-1 ring-white/[0.08] shadow-[var(--shadow-pop)]">
        <div className="flex items-center">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Modelos · {project.name}</h2>
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
                className="w-52"
              />
            </div>
          ))}
        </div>
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
