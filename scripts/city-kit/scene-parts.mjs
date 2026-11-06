// Build a real CityParts scene in Node (same shim and synthetic rows as verify-city-scene-baseline).
import { loadCity } from "./index.mjs";
import { installCanvasShim } from "./scene-hash.mjs";
installCanvasShim();
globalThis.window ??= globalThis;
globalThis.devicePixelRatio ??= 1;
const HARNESSES = ["codex", "claude-code", "dsh", "harness:zcode"];
export const GENERATED_AT = Date.UTC(2026, 9, 7, 12, 0, 0);
export function sceneRows(count) {
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return Array.from({ length: count }, (_, i) => {
    const total = Math.round(2000 + rnd() ** 3 * 4_000_000);
    const start = GENERATED_AT - Math.round(rnd() * 28 * 86_400_000);
    const end = i % 17 === 0 ? GENERATED_AT - 60_000 : start + Math.round(rnd() * 3_600_000);
    return { session_ref: `session:${i}`, harness: HARNESSES[i % HARNESSES.length], first_event_at: new Date(start).toISOString(), last_event_at: new Date(end).toISOString(),
      event_count: 10 + (i % 50), model_ids: [i % 3 ? "claude-sonnet-5" : "gpt-5"],
      tokens: { uncached_input_tokens: Math.round(total * 0.2), cache_read_tokens: Math.round(total * 0.5), cache_write_tokens: Math.round(total * 0.1), output_tokens: Math.round(total * 0.2), total },
      peak_tokens: Math.round(total * 0.3), cost_minor: { amount_minor: Math.round(total / 1000), currency: "USD", basis: "api_equivalent" },
      cost_status: { state: "estimated", reason: "", has_unresolved: false } };
  });
}
export async function sceneKit(extra = {}) {
  return loadCity({ "pkg:three": ["* as THREE"], "cityModel.ts": ["buildCityModel"], "engine/cityLayout.ts": ["layoutCity"], "engine/cityParts.ts": ["CityParts"], "engine/citySeaside.ts": ["MIAMI_COASTAL"], ...extra });
}
export function buildParts(kit, count, seed) {
  const model = kit.buildCityModel({ rows: sceneRows(count), findings: [], windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: count, truncated: false, generatedAt: GENERATED_AT });
  const layout = kit.layoutCity(model, null, seed, kit.MIAMI_COASTAL);
  const parts = new kit.CityParts(model, layout, null);
  parts.snapToTargets?.(true);
  return { model, layout, parts };
}
