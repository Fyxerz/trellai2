/** How hard the model thinks. Written after the model as "@level": "claude:opus@high", "codex@low". */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const EFFORT_LABELS: Record<Effort, string> = { low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Muy alto", max: "Máximo" };
/** What `codex exec` accepts as model_reasoning_effort for every model. */
export const CODEX_EFFORTS: Effort[] = ["low", "medium", "high"];

const isEffort = (s: string): s is Effort => (EFFORTS as readonly string[]).includes(s);

/** "claude:opus@high" → { spec: "claude:opus", effort: "high" } (no "@" → effort null). */
export function splitEffort(spec: string | null | undefined): { spec: string; effort: Effort | null } {
  const s = spec ?? "";
  const i = s.lastIndexOf("@");
  const effort = i >= 0 ? s.slice(i + 1) : "";
  return i >= 0 && isEffort(effort) ? { spec: s.slice(0, i), effort } : { spec: s, effort: null };
}

export function withEffort(spec: string, effort: Effort | null): string {
  return effort ? `${spec}@${effort}` : spec;
}

/**
 * Readable name for an exact model id:
 *   "claude-opus-5-5" → "Opus 5.5" · "claude-haiku-4-5-20251001" → "Haiku 4.5" · "claude-sonnet-5" → "Sonnet 5"
 *   "codex:gpt-5-codex" → "GPT · gpt-5-codex" · "claude-opus-5-5@high" → "Opus 5.5 · Alto"
 */
export function prettyModel(full: string | null | undefined): string {
  const { spec: id, effort } = splitEffort(full);
  if (!id) return "";
  const name = prettyId(id);
  return effort ? `${name} · ${EFFORT_LABELS[effort]}` : name;
}

function prettyId(id: string): string {
  if (id.startsWith("codex:")) {
    const m = id.slice(6);
    return m === "default" ? "GPT (por defecto de Codex)" : `GPT · ${m}`;
  }
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}${m[4] ? " (1M)" : ""}`;
}
