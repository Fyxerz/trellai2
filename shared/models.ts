/**
 * Readable name for an exact model id:
 *   "claude-opus-5-5" → "Opus 5.5" · "claude-haiku-4-5-20251001" → "Haiku 4.5" · "claude-sonnet-5" → "Sonnet 5"
 *   "codex:gpt-5-codex" → "GPT · gpt-5-codex"
 */
export function prettyModel(id: string | null | undefined): string {
  if (!id) return "";
  if (id.startsWith("codex:")) {
    const m = id.slice(6);
    return m === "default" ? "GPT (por defecto de Codex)" : `GPT · ${m}`;
  }
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}${m[4] ? " (1M)" : ""}`;
}
