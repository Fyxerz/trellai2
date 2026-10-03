import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One git operation at a time per repo (two cards finishing together must not race on
 * index.lock). Re-entrant: code already holding the lock can call helpers that take it.
 */
const held = new AsyncLocalStorage<Set<string>>();
const tails = new Map<string, Promise<void>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const cur = held.getStore();
  if (cur?.has(key)) return fn();
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  await prev;
  try {
    return await held.run(new Set([...(cur ?? []), key]), fn);
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

export const repoLock = <T>(repo: string, fn: () => Promise<T>) => withLock(`repo:${repo}`, fn);

/** Run `fn` as if no lock were held (for work started from inside a lock that outlives it). */
export const outsideLocks = <T>(fn: () => T): T => held.exit(fn);
