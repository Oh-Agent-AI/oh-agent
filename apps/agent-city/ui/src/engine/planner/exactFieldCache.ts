/** Exact memoization for immutable, world-local scalar fields. No rounding/interpolation. */
export const EXACT_FIELD_CACHE_CONFIG = { version: 1, maxEntriesPerField: 2048 };

export function exactFieldCache<T extends number | boolean>(evaluate: (x: number, z: number) => T,
  limit = EXACT_FIELD_CACHE_CONFIG.maxEntriesPerField) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("invalid exact field cache limit");
  const entries = new Map<string, T>();
  const evictionOrder: string[] = [];
  let nextEviction = 0;
  let hits = 0, misses = 0;
  const scalarKey = (value: number) => Object.is(value, -0) ? "-0" : String(value);
  return {
    query(x: number, z: number): T {
      // Preserve exceptional/nonfinite semantics and do not grow the cache for invalid input.
      if (!limit || !Number.isFinite(x) || !Number.isFinite(z)) { misses += 1; return evaluate(x, z); }
      const key = `${scalarKey(x)}:${scalarKey(z)}`, stored = entries.get(key);
      if (stored !== undefined) { hits += 1; return stored; }
      misses += 1;
      const value = evaluate(x, z); // Throwing evaluations are never cached.
      if (entries.size === limit) entries.delete(evictionOrder[nextEviction]);
      entries.set(key, value);
      evictionOrder[nextEviction] = key;
      nextEviction = (nextEviction + 1) % limit;
      return value;
    },
    snapshot: () => ({ entries: entries.size, hits, misses, limit }),
  };
}
