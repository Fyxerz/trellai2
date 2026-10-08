import { useEffect, useRef, useState } from "react";
import { Monitor, Moon, Settings2, Sun, X } from "lucide-react";

export const MOD = /Mac|iPhone|iPad/.test(typeof navigator === "undefined" ? "" : navigator.platform) ? "⌘" : "Ctrl";
export function projectName(name: string) { return name.split(/[\\/]/).filter(Boolean).pop() || name; }
export function readPreference(key: string, fallback: string) {
  try { return localStorage.getItem(`trellai:${key}`) ?? fallback; } catch { return fallback; }
}
export function writePreference(key: string, value: string) {
  try { localStorage.setItem(`trellai:${key}`, value); } catch { /* optional storage */ }
}
export function applyAppearance() {
  const theme = readPreference("theme", "system");
  document.documentElement.dataset.theme = theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
  document.documentElement.dataset.density = readPreference("density", "comfortable");
}

/** Keep keyboard focus within a dialog and return it to its opener. */
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const elements = () => Array.from(root?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || []).filter(el => el.getClientRects().length);
    elements()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const all = elements(), first = all[0], last = all[all.length - 1];
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || !root?.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !root?.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, []);
  return ref;
}

export function Appearance() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", applyAppearance);
    window.addEventListener("storage", applyAppearance);
    return () => { media.removeEventListener("change", applyAppearance); window.removeEventListener("storage", applyAppearance); };
  }, []);
  return <>
    <button className="inline-flex h-7 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs text-zinc-300 ring-1 ring-ui-ink/10 transition hover:bg-ui-ink/[0.06] hover:text-zinc-100" title="Ajustes globales: tema, densidad y teclado" aria-haspopup="dialog" onClick={() => setOpen(true)}><Settings2 className="h-4 w-4" />Ajustes globales</button>
    {open && <AppearanceDialog onClose={() => setOpen(false)} />}
  </>;
}

function AppearanceDialog({ onClose }: { onClose: () => void }) {
  const ref = useDialogFocus();
  const [theme, setTheme] = useState(readPreference("theme", "system"));
  const [density, setDensity] = useState(readPreference("density", "comfortable"));
  const [send, setSend] = useState(readPreference("send", "enter"));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return <div data-modal className="ui-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="appearance-title" className="ui-dialog w-full max-w-md space-y-6 rounded-2xl bg-zinc-900 p-6 shadow-[var(--shadow-pop)]" onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between"><h2 id="appearance-title" className="text-lg font-semibold">Ajustes globales</h2><button aria-label="Cerrar ajustes" onClick={onClose} className="rounded-lg p-2 hover:bg-ui-ink/5"><X className="h-4 w-4" /></button></div>
      <fieldset><legend className="mb-2 text-sm font-medium">Tema</legend><div className="grid grid-cols-3 gap-2">{([["light", "Claro", Sun], ["dark", "Oscuro", Moon], ["system", "Sistema", Monitor]] as const).map(([value, label, Icon]) => <button key={value as string} aria-pressed={theme === value} onClick={() => { setTheme(value as string); writePreference("theme", value as string); applyAppearance(); }} className={`flex flex-col items-center gap-2 rounded-xl border p-3 text-sm ${theme === value ? "border-indigo-400 bg-indigo-500/10 text-accent" : "border-ui-ink/10 text-zinc-400"}`}><Icon className="h-5 w-5" />{label as string}</button>)}</div></fieldset>
      <label className="block text-sm font-medium">Densidad<select className="ui-field ui-control mt-2 w-full rounded-lg border border-ui-ink/10 bg-zinc-950 p-2" value={density} onChange={e => { setDensity(e.target.value); writePreference("density", e.target.value); applyAppearance(); }}><option value="comfortable">Cómoda</option><option value="compact">Compacta</option></select></label>
      <label className="block text-sm font-medium">Enviar mensajes<select className="ui-field ui-control mt-2 w-full rounded-lg border border-ui-ink/10 bg-zinc-950 p-2" value={send} onChange={e => { setSend(e.target.value); writePreference("send", e.target.value); window.dispatchEvent(new Event("trellai:preferences")); }}><option value="enter">Enter envía · Shift+Enter nueva línea</option><option value="mod">{MOD}+Enter envía · Enter nueva línea</option></select></label>
      <p className="text-xs text-zinc-400">Los cambios se aplican al momento y se recuerdan en este navegador.</p>
    </div>
  </div>;
}
