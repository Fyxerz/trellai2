/** Workflow transitions must wait until the card's editor has persisted its draft. */
const flushers = new Map<string, () => Promise<void>>();
export function registerDraft(id: string, flush: () => Promise<void>) {
  flushers.set(id, flush);
  return () => { if (flushers.get(id) === flush) flushers.delete(id); };
}
export async function flushDraft(id: string) {
  const flush = flushers.get(id);
  if (!flush) return false;
  await flush();
  return true;
}
