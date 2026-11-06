import type { DailySummary } from "../../lib/tauri";

export function todayCacheHitRatio(daily: DailySummary | null): number | null {
  if (!daily || daily.freshness === "unavailable" || daily.freshness === "unknown") return null;
  let cacheRead = 0;
  let input = 0;
  for (const harness of Object.values(daily.tokens_by_harness)) {
    cacheRead += harness.cache_read;
    input += harness.uncached_input + harness.cache_read + harness.cache_write;
  }
  return input > 0 ? cacheRead / input : null;
}
