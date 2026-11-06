// Synthetic session models for display-layout matrices (same shape as verify-city-game-world).
// No real session data, host bridge or network.
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);
const tokens = (total) => ({ uncached_input_tokens: total, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total });
const row = (ref, harness, index, total) => {
  const first = NOW - DAY * 29 + index * 3_600_000;
  return { session_ref: ref, harness, first_event_at: new Date(first).toISOString(), last_event_at: new Date(first + 7_200_000).toISOString(),
    event_count: 10, model_ids: ["gpt-test"], tokens: tokens(total), peak_tokens: total, cost_minor: null,
    cost_status: { state: "unavailable", reason: "test", has_unresolved: false } };
};
const HARNESSES = ["harness:zcode", "harness:claude"];
export function sessionModel(buildCityModel, count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) rows.push(row(`s:${index}`, HARNESSES[index % HARNESSES.length], index, 50_000 + (index % 37) * 900_000));
  return buildCityModel({ rows, findings: [], windowStartMs: NOW - DAY * 30, windowEndMs: NOW, windowLabel: "30d",
    totalSessions: count, truncated: false, generatedAt: NOW });
}
