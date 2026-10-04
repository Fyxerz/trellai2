import { useSyncExternalStore } from "react";
import { X, TriangleAlert, Info } from "lucide-react";

let message: { text: string; id: number; kind: "error" | "info" } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());
function show(text: string, kind: "error" | "info") {
  clearTimeout(timer);
  message = { text, id: Date.now(), kind };
  // Info goes away on its own; errors stay until closed.
  if (kind === "info") timer = setTimeout(() => { message = null; emit(); }, 9000);
  emit();
}
export function reportError(text: string) { show(text, "error"); }
export function reportInfo(text: string) { show(text, "info"); }
export function Notifications() {
  const current = useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => message);
  if (!current) return null;
  const info = current.kind === "info";
  const Icon = info ? Info : TriangleAlert;
  return <div role={info ? "status" : "alert"} className={`fixed bottom-5 left-1/2 z-[70] flex w-[min(480px,90vw)] -translate-x-1/2 items-start gap-3 rounded-xl border ${info ? "border-teal-300/30" : "border-red-400/30"} bg-panel p-4 shadow-[var(--shadow-pop)]`}><Icon className={`mt-0.5 h-5 w-5 shrink-0 ${info ? "text-teal-300" : "text-red-300"}`} /><p className="min-w-0 flex-1 text-sm text-zinc-100">{current.text}</p><button aria-label="Cerrar aviso" className="rounded p-1 text-zinc-400" onClick={() => { clearTimeout(timer); message = null; emit(); }}><X className="h-4 w-4" /></button></div>;
}
