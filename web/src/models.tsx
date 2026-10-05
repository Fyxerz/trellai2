import { projectName, useDialogFocus } from "./preferences";
import { Component, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { Check, ChevronDown, Cpu, Image as ImageIcon, Loader2, RefreshCw, Share2, Sparkles, Workflow, X } from "lucide-react";
import { SharingSettings } from "./People";
import { TAG_PALETTE, type BgMode, type BgStatus, type Project } from "../../shared/types";
import { reportError } from "./notifications";
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
/** A GPT model of your ChatGPT account (from Codex's model list). */
interface CodexModel {
  slug: string;
  label: string;
  efforts: Effort[];
  defaultEffort: Effort | null;
}
interface LoginState {
  running: boolean;
  error?: string;
}
interface Engines {
  claude: { models: ClaudeModel[]; loggedIn?: boolean; login?: LoginState };
  codex: { installed: boolean; loggedIn?: boolean; version?: string; defaultModel?: string | null; models?: CodexModel[]; login?: LoginState };
}

/** spec ("claude", "claude:opus", "codex", "codex:gpt-6-luna") → exact version name ("Opus 5.5", "GPT-6-Luna"), once /api/engines answers. */
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
    for (const m of e.codex?.models ?? []) versions.set(`codex:${m.slug}`, m.label);
    const def = e.codex?.defaultModel;
    if (def) versions.set("codex", versions.get(`codex:${def}`) ?? prettyModel(`codex:${def}`));
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
    if (model) return exact ?? prettyModel(`codex:${model}`);
    return short ? (exact ?? "GPT") : exact ? `${exact} (por defecto de Codex)` : "GPT (Codex)";
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

interface PickerOption {
  /** null = inherit; "__other" = type a GPT model by hand */
  value: string | null;
  label: string;
  title?: string;
  disabled?: boolean;
}

/** Compact model button; opens a dropdown with the models (Claude / GPT) and the effort. */
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
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const open = !!pos;

  const noCodex = codex && !codex.installed;
  const codexOff = codex?.installed && codex.loggedIn === false;
  const gptModels = codex?.models ?? [];
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
  const known = [...claudeOptions.map((o) => o.value), "codex", ...gptModels.map((m) => `codex:${m.slug}`)];
  const custom = spec && !known.includes(spec) ? spec : null;
  const efforts = (s: string): Effort[] => {
    if (s.startsWith("codex")) {
      const slug = s.slice(6) || codex?.defaultModel;
      const m = gptModels.find((x) => x.slug === slug);
      return m?.efforts.length ? m.efforts : CODEX_EFFORTS;
    }
    const m = claude?.find((x) => (x.value === "default" ? "claude" : `claude:${x.value}`) === s);
    // not listed (yet): offer them all, the SDK lowers what the model can't do
    return m?.efforts ?? [...EFFORTS];
  };
  const levels = value ? efforts(spec) : [];

  const groups: { label?: string; options: PickerOption[] }[] = [];
  if (inheritLabel) groups.push({ options: [{ value: null, label: inheritLabel }] });
  groups.push({ label: claudeLoggedIn === false ? "Claude (no conectado)" : "Claude", options: claudeOptions.filter((o) => !o.pinned) });
  if (claudeOptions.some((o) => o.pinned)) groups.push({ label: "Claude · versiones fijas", options: claudeOptions.filter((o) => o.pinned) });
  const gptDefault = versions.get("codex");
  groups.push({
    label: noCodex ? "GPT (Codex no instalado)" : codexOff ? "GPT (Codex no conectado)" : "GPT",
    options: [
      { value: "codex", label: gptDefault ? `Por defecto · ${gptDefault}` : "Por defecto de Codex", disabled: !!noCodex },
      ...gptModels.map((m) => ({ value: `codex:${m.slug}`, label: m.label, title: m.slug, disabled: !!noCodex })),
      ...(custom ? [{ value: custom, label: modelLabel(custom, true), title: custom }] : []),
      { value: "__other", label: "Otro modelo GPT…", disabled: !!noCodex },
    ],
  });

  const place = () => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 256;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    setPos(
      below >= 280 || below >= above
        ? { left, width, top: r.bottom + 4, maxHeight: below }
        : { left, width, bottom: window.innerHeight - r.top + 4, maxHeight: above },
    );
  };
  const close = (focusButton = true) => {
    setPos(null);
    if (focusButton) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    (pop?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ?? pop?.querySelector<HTMLElement>('[role="option"]'))?.focus();
    // Esc closes only the dropdown, not the card / dialog it lives in.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !buttonRef.current?.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!popRef.current?.contains(e.target as Node)) place();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  /** Keeps the effort if the new model has it. */
  const keepEffort = (s: string) => withEffort(s, effort && efforts(s).includes(effort) ? effort : null);
  const pick = (o: PickerOption) => {
    if (o.disabled) return;
    close();
    if (o.value === "__other") {
      const name = prompt("Nombre del modelo de OpenAI (tal cual lo acepta `codex -m`):", "")?.trim();
      if (name) onChange(keepEffort(`codex:${name}`));
      return;
    }
    onChange(o.value ? keepEffort(o.value) : null);
  };
  const pickEffort = (e: Effort | null) => {
    close();
    onChange(withEffort(spec, e));
  };
  const onListKey = (e: React.KeyboardEvent) => {
    const items = Array.from(popRef.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };

  const hint =
    title ??
    (noCodex
      ? "Para usar GPT instala la app de Codex de OpenAI y conéctala con tu cuenta de ChatGPT en Modelos del proyecto"
      : claudeLoggedIn === false || codexOff
        ? "Hay motores sin conectar: conéctalos en Modelos del proyecto"
        : undefined);
  const current = value ? modelLabel(value, true) : (inheritLabel ?? "Modelo");
  const full = value ? modelLabel(value) : current;
  // Inside the card panel / dialog, so clicks in the dropdown count as clicks inside it.
  const host = open ? (buttonRef.current?.closest<HTMLElement>('[aria-label="Detalle de tarjeta"], [role="dialog"]') ?? document.body) : null;

  return (
    <span className={`model-picker flex min-w-0 items-center ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        title={hint ? `${hint}\n${full}` : full}
        aria-label={`Modelo: ${full}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : place())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            place();
          }
        }}
        className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-zinc-900 py-0.5 pl-2 pr-1 text-xs ring-1 outline-none transition hover:bg-ui-ink/5 focus-visible:ring-indigo-500 ${open ? "ring-indigo-500/70" : "ring-zinc-700"} ${value ? "text-zinc-200" : "text-zinc-400"}`}
      >
        <span className="truncate">{current}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-zinc-500 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {host &&
        createPortal(
          <div
            ref={popRef}
            style={{ position: "fixed", ...pos }}
            onBlur={(e) => {
              const to = e.relatedTarget as Node | null;
              if (to && !popRef.current?.contains(to) && !buttonRef.current?.contains(to)) close(false);
            }}
            className="z-[70] flex flex-col overflow-hidden rounded-lg bg-zinc-900 text-xs ring-1 ring-ui-ink/10 shadow-[var(--shadow-pop)]"
          >
            <div id={listId} role="listbox" aria-label="Modelo" onKeyDown={onListKey} className="min-h-0 flex-1 overflow-y-auto py-1">
              {groups.map((g, gi) => (
                <div key={gi} role="group" aria-label={g.label} className={gi ? "mt-1 border-t border-ui-ink/[0.06] pt-1" : ""}>
                  {g.label && <div className="px-2.5 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">{g.label}</div>}
                  {g.options.map((o) => {
                    const selected = o.value === (value ? spec : null);
                    return (
                      <div
                        key={o.value ?? "__inherit"}
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected}
                        aria-disabled={o.disabled || undefined}
                        title={o.title || undefined}
                        onClick={() => pick(o)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            pick(o);
                          }
                        }}
                        className={`mx-1 flex items-center gap-2 rounded-md px-1.5 py-1 outline-none ${o.disabled ? "cursor-default opacity-40" : "cursor-pointer hover:bg-ui-ink/5 focus:bg-ui-ink/[0.07]"} ${selected ? "text-indigo-300" : "text-zinc-200"}`}
                      >
                        <Check className={`h-3 w-3 shrink-0 ${selected ? "" : "invisible"}`} />
                        <span className="truncate">{o.label}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {levels.length > 0 && (
              <div className="shrink-0 border-t border-ui-ink/[0.08] p-2">
                <div
                  className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500"
                  title="Cuánto piensa el modelo antes de responder. Más esfuerzo = mejor en tareas difíciles, pero más lento y gasta más."
                >
                  Esfuerzo
                </div>
                <div role="radiogroup" aria-label="Esfuerzo del modelo" className="flex flex-wrap gap-1">
                  {[null, ...levels].map((l) => (
                    <button
                      key={l ?? "default"}
                      type="button"
                      role="radio"
                      aria-checked={effort === l}
                      onClick={() => pickEffort(l)}
                      className={`rounded px-1.5 py-0.5 text-[11px] transition ${effort === l ? "bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-400/40" : "text-zinc-400 ring-1 ring-ui-ink/10 hover:bg-ui-ink/5 hover:text-zinc-200"}`}
                    >
                      {l ? EFFORT_LABELS[l] : "Por defecto"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>,
          host,
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
  project: Project;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { codex } = useEngines();
  const [tab, setTab] = useState<SettingsTab>(() => {
    try {
      const t = localStorage.getItem(SETTINGS_TAB);
      if (SETTINGS_TABS.some((x) => x.id === t)) return t as SettingsTab;
    } catch {
      /* optional storage */
    }
    return "models";
  });
  const pick = (t: SettingsTab) => {
    setTab(t);
    try {
      localStorage.setItem(SETTINGS_TAB, t);
    } catch {
      /* optional storage */
    }
  };
  const dialogRef = useDialogFocus();
  return (
    <div data-modal className="ui-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Ajustes del proyecto" onClick={(e) => e.stopPropagation()} className="ui-dialog flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-zinc-900 ring-1 ring-ui-ink/[0.08] shadow-[var(--shadow-pop)]">
        <div className="flex items-center border-b border-ui-ink/[0.08] px-5 py-3.5">
          <h2 className="text-base font-semibold text-zinc-100">Ajustes · {projectName(project.name)}</h2>
          <button onClick={onClose} aria-label="Cerrar" className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav role="tablist" aria-label="Secciones de ajustes" aria-orientation="vertical" className="ui-tabs flex shrink-0 gap-1 border-ui-ink/[0.08] p-2 max-sm:border-b sm:w-48 sm:flex-col sm:border-r">
            {SETTINGS_TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                id={`settings-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`settings-panel-${t.id}`}
                onClick={() => pick(t.id)}
                onKeyDown={(e) => {
                  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
                  e.preventDefault();
                  const i = SETTINGS_TABS.findIndex((x) => x.id === tab);
                  const next = SETTINGS_TABS[(i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : SETTINGS_TABS.length - 1)) % SETTINGS_TABS.length];
                  pick(next.id);
                  document.getElementById(`settings-tab-${next.id}`)?.focus();
                }}
                tabIndex={tab === t.id ? 0 : -1}
                className={`ui-tab flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${tab === t.id ? "bg-indigo-500/10 text-accent ring-1 ring-indigo-400/30" : "text-zinc-400 hover:bg-ui-ink/5 hover:text-zinc-200"}`}
              >
                <t.icon className="h-4 w-4 shrink-0" />
                {t.label}
              </button>
            ))}
          </nav>
          <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} className="min-w-0 flex-1 overflow-y-auto p-5">
            <PanelGuard key={tab}>
            {tab === "models" ? (
              <ModelSettings project={project} onSaved={onSaved} />
            ) : tab === "flow" ? (
              <FlowSettings project={project} onSaved={onSaved} />
            ) : tab === "sharing" ? (
              <SharingSettings project={project} />
            ) : (
              <BackgroundSettings project={project} codexReady={codex ? codex.installed && codex.loggedIn !== false : null} onSaved={onSaved} />
            )}
            </PanelGuard>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A section that fails to draw shows why, instead of taking the whole app down with it (blank grey screen). */
class PanelGuard extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-lg bg-red-400/10 px-3 py-2.5 text-[12.5px] text-danger">
        Esta sección no se pudo mostrar: {this.state.error.message}
        <div className="mt-1 text-[11.5px] text-zinc-400">Si acabas de actualizar Trellai, reinícialo para que el servidor esté al día.</div>
      </div>
    );
  }
}

type SettingsTab = "models" | "flow" | "background" | "sharing";
const SETTINGS_TAB = "trellai:settings-tab";
const SETTINGS_TABS: { id: SettingsTab; label: string; icon: typeof Cpu }[] = [
  { id: "models", label: "Modelos", icon: Cpu },
  { id: "flow", label: "Flujo", icon: Workflow },
  { id: "background", label: "Fondo del tablero", icon: ImageIcon },
  { id: "sharing", label: "Compartir", icon: Share2 },
];

function ModelSettings({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const save = async (key: string, value: string | null) => {
    await api(`/api/projects/${project.id}`, { [key]: value }, "PATCH");
    onSaved();
  };
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">Modelos</h3>
        <p className="text-[11px] text-zinc-500">Por defecto para este proyecto. Cada tarjeta puede elegir el suyo.</p>
      </div>
        <div className="space-y-3">
          {ROLES.map((r) => (
            <div key={r.key} className="model-row flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-zinc-200">{r.label}</div>
                <div className="text-[11px] text-zinc-500">{r.hint}</div>
              </div>
              <ModelPicker
                value={(project[r.key] as string | null) ?? null}
                inheritLabel={r.key === "model_ui" ? "Igual que desarrollo" : undefined}
                onChange={(v) => save(r.key, v ?? (r.key === "model_ui" ? null : "claude"))}
                className="model-picker w-72 max-w-full"
              />
            </div>
          ))}
        </div>
        <EngineStatus />
    </div>
  );
}

/** How cards move between columns on their own. */
function FlowSettings({ project, onSaved }: { project: Project; onSaved: () => void }) {
  // Shown at once; the server's answer (and the projects reload) confirms it.
  const [on, setOn] = useState(!!project.auto_doing);
  useEffect(() => setOn(!!project.auto_doing), [project.auto_doing]);
  const toggle = () => {
    const next = !on;
    setOn(next);
    api<Project>(`/api/projects/${project.id}`, { auto_doing: next }, "PATCH")
      .then(onSaved)
      .catch((e) => {
        setOn(!next);
        reportError((e as Error).message);
      });
  };
  return (
    <section className="space-y-4" aria-label="Flujo">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">Flujo</h3>
        <p className="text-[11px] text-zinc-500">Cómo avanzan las tarjetas por sí solas.</p>
      </div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div id="auto-doing-label" className="text-sm text-zinc-200">
            Pasar a Doing automáticamente al terminar la preparación
          </div>
          <div className="text-[11px] text-zinc-500">
            {on
              ? "Cuando la preparación termina, la tarjeta pasa sola a Doing y empieza el desarrollo."
              : "Cuando la preparación termina, la tarjeta se queda en Preparation con los checkpoints escritos. Muévela a Doing cuando quieras."}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={on}
          aria-labelledby="auto-doing-label"
          onClick={toggle}
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${on ? "bg-indigo-600" : "bg-zinc-700"}`}
        >
          <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
        </button>
      </div>
    </section>
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
  const error = (engine: "claude" | "codex") => errors[engine] && <div className="text-[11px] text-danger">{errors[engine]}</div>;
  const codexOn = codex ? codex.installed && codex.loggedIn !== false : null;
  if (staleServer)
    return (
      <div className="rounded-lg bg-zinc-950 p-3 text-xs text-warning ring-1 ring-zinc-800">
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

/** URL of the project's generated background (versioned, so a new one isn't cached). */
export const backgroundUrl = (p: Project) => `/api/projects/${p.id}/background?v=${encodeURIComponent(p.bg_image ?? "")}`;

const BG_MODES: { value: BgMode; label: string }[] = [
  { value: "none", label: "Ninguno" },
  { value: "color", label: "Color" },
  { value: "image", label: "Imagen" },
];

/** "Fondo del tablero": none, a color, or an image Codex draws from what the repo is about. */
function BackgroundSettings({ project, codexReady, onSaved }: { project: Project; codexReady: boolean | null; onSaved: () => void }) {
  const [status, setStatus] = useState<BgStatus>({ running: false, error: null, activity: null });
  // Shown at once; the server's answer (and the projects reload) confirms it.
  const [local, setLocal] = useState<{ bg_mode: BgMode; bg_color: string | null }>({ bg_mode: project.bg_mode ?? "none", bg_color: project.bg_color ?? null });
  useEffect(() => setLocal({ bg_mode: project.bg_mode ?? "none", bg_color: project.bg_color ?? null }), [project.bg_mode, project.bg_color]);
  /** The running server predates this feature (Trellai restarts by itself once no agent is working). */
  const [outdated, setOutdated] = useState(false);
  const url = `/api/projects/${project.id}/background`;
  const save = (patch: Partial<Pick<Project, "bg_mode" | "bg_color">>) => {
    setLocal((l) => ({ ...l, ...patch }));
    api<Project>(`/api/projects/${project.id}`, patch, "PATCH")
      .then((p) => {
        if (p.bg_mode === undefined) setOutdated(true);
        onSaved();
      })
      .catch((e) => reportError(e.message));
  };

  // Generation runs on the server; follow it while it lasts.
  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    let wasRunning = false;
    const poll = () =>
      api<BgStatus>(`${url}/status`)
        .then((s) => {
          if (stop) return;
          if (wasRunning && !s.running) onSaved(); // new image (or error): refresh the project
          wasRunning = s.running;
          setStatus(s);
          t = setTimeout(poll, s.running ? 1500 : 4000);
        })
        .catch((e) => {
          if (stop) return;
          if (/Respuesta inesperada/.test((e as Error).message)) setOutdated(true);
          t = setTimeout(poll, 4000);
        });
    poll();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [project.id]);

  const generate = () => {
    setStatus({ running: true, error: null, activity: "Empezando…" });
    api<BgStatus>(`${url}/generate`, {})
      .then(setStatus)
      .catch((e) => setStatus({ running: false, error: (e as Error).message, activity: null }));
  };
  const cancel = () => api<BgStatus>(`${url}/stop`, {}).then(setStatus).catch(() => {});
  const color = local.bg_color ?? "#2563eb";
  const btn = "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-zinc-300 ring-1 ring-ui-ink/10 transition hover:bg-ui-ink/5 disabled:opacity-50";

  return (
    <section className="space-y-3" aria-label="Fondo del tablero">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">Fondo del tablero</h3>
        <p className="text-[11px] text-zinc-500">Para distinguir los proyectos de un vistazo.</p>
      </div>
      {outdated && (
        <p role="alert" className="rounded-lg bg-amber-400/10 p-3 text-xs text-warning ring-1 ring-amber-400/30">
          El servidor de Trellai que está corriendo aún no tiene esta función, así que no se guarda. Se reinicia solo cuando ningún agente está trabajando
          (o reinícialo desde Maitre); después vuelve a elegir el fondo.
        </p>
      )}
      <div role="radiogroup" aria-label="Tipo de fondo" className="flex gap-1">
        {BG_MODES.map((m) => (
          <button
            key={m.value}
            role="radio"
            aria-checked={local.bg_mode === m.value}
            onClick={() =>
              local.bg_mode !== m.value && save(m.value === "color" && !local.bg_color ? { bg_mode: m.value, bg_color: color } : { bg_mode: m.value })
            }
            className={`rounded-lg px-3 py-1.5 text-sm transition ${local.bg_mode === m.value ? "bg-indigo-500/10 text-accent ring-1 ring-indigo-400/30" : "text-zinc-400 hover:bg-ui-ink/5"}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {local.bg_mode === "color" && (
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Color de fondo">
          {TAG_PALETTE.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={color.toLowerCase() === c}
              aria-label={c}
              onClick={() => save({ bg_color: c })}
              className={`h-6 w-6 rounded-md transition hover:scale-110 ${color.toLowerCase() === c ? "ring-2 ring-zinc-100 ring-offset-2 ring-offset-zinc-900" : "ring-1 ring-black/20"}`}
              style={{ background: c }}
            />
          ))}
          <label className="ml-1 flex items-center gap-1.5 text-xs text-zinc-400" title="Elegir otro color">
            <input type="color" value={color} onChange={(e) => save({ bg_color: e.target.value })} className="ui-field h-6 w-8 cursor-pointer rounded bg-transparent" />
            Otro
          </label>
        </div>
      )}

      {local.bg_mode === "image" && (
        <div className="space-y-2">
          <div className="flex items-start gap-3">
            <div className="aspect-video w-40 shrink-0 overflow-hidden rounded-lg bg-zinc-950 ring-1 ring-zinc-800">
              {project.bg_image ? (
                <img src={backgroundUrl(project)} alt="Imagen de fondo actual" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center p-2 text-center text-[11px] text-zinc-500">Sin imagen en este ordenador</div>
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-[11px] text-zinc-500">
                Codex explora el repo, deduce de qué va el proyecto y dibuja un fondo con su herramienta de imágenes (tarda unos minutos). Se guarda solo en
                este ordenador, en <code className="text-zinc-400">.trellai/</code>.
              </p>
              {status.running ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-300" title={status.activity ?? ""}>
                    {status.activity ?? "Generando…"}
                  </span>
                  <button onClick={cancel} className={btn}>
                    <X className="h-3.5 w-3.5" /> Cancelar
                  </button>
                </div>
              ) : (
                <button onClick={generate} disabled={codexReady === false} className={btn} title={codexReady === false ? "Hace falta Codex conectado" : undefined}>
                  {project.bg_image ? <RefreshCw className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {project.bg_image ? "Regenerar" : "Generar imagen"}
                </button>
              )}
            </div>
          </div>
          {codexReady === false && (
            <p className="text-xs text-warning">
              Hace falta Codex conectado a tu cuenta de ChatGPT: instálalo y conéctalo en la pestaña «Modelos».
            </p>
          )}
          {status.error && !status.running && (
            <p role="alert" className="text-xs text-danger">
              {status.error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
