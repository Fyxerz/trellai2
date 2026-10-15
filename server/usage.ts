/** What each agent run spent, added up per card and per project (see db.agent_usage). */
import { usageTotal, type Usage } from "../shared/types.js";
import * as db from "./db.js";
import type { EngineResult } from "./engine.js";
import { emitUsage } from "./events.js";

const KEYS = ["input", "output", "cache_read", "cache_write", "cost_usd"] as const;

/**
 * Save one run's spend and return it (null if it reported nothing). Claude reports a resumed
 * session's running totals, earlier runs included: only what this run added is counted.
 */
export function recordUsage(o: {
  projectId: string;
  cardId: string | null;
  kind: db.UsageKind;
  model: string | null;
  /** the stored session the run resumed */
  resume: string | null | undefined;
  result: Pick<EngineResult, "usage" | "sessionId">;
}): Usage | null {
  const reported = o.result.usage;
  if (!reported) return null;
  let u = reported.totals;
  const prev = reported.cumulative && o.resume ? db.sessionTotals(o.resume) : null;
  // a transcript without saved totals starts again from zero: then the whole report is this run's
  if (prev && KEYS.every((k) => u[k] >= prev[k])) u = Object.fromEntries(KEYS.map((k) => [k, u[k] - prev[k]])) as unknown as Usage;
  if (!usageTotal(u) && !u.cost_usd) return null;
  db.addUsage({
    ...u,
    project_id: o.projectId,
    card_id: o.cardId,
    kind: o.kind,
    model: o.model,
    session_id: o.result.sessionId,
    totals: reported.cumulative ? reported.totals : null,
  });
  emitUsage(o.projectId);
  return u;
}
