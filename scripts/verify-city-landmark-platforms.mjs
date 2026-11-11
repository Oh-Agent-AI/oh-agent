#!/usr/bin/env node
// 地标岛能开上去（2026-10-22，用户：「机场岛的桥梁也有和海上歌剧院一样的问题」）：
// 海上歌剧院的堤道是路网里的真桥面，但岛端没有可落的路面——桥面停在半空、尽头一道横栏；机场的堤道只是装饰网格，
// 驾驶面里根本没有它。现在两座岛都是可行驶的地标平台（surface/landmarkPlatforms），堤道落到平台上：
//   (a) 每座城都有歌剧院岛平台与机场平台，机场堤道作为桥段在路网里（layout.airport.causeway）；
//   (b) 落在平台上的桥头全部 aligned 且与平台同区域连通；全城不再有 no-ground（断头）的桥端；
//   (c) 试驾（修复工具同一内核，双向）：机场堤道全部开得上岛；歌剧院堤道的失败只允许在岸端
//       （生成器自己的斜接 / 陡桥头，体检照报），平台端一律通。
// 只读合成城市，不读用户日志。用法：node scripts/verify-city-landmark-platforms.mjs [seed/tier[m],…]
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

globalThis.window ??= globalThis;
const kit = await loadCity({ "engine/cityLayout.ts": ["layoutCity"], "cityModel.ts": ["buildCityModel"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/surface/compileSurface.ts": ["compileCitySurface", "landingConnectivity"], "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"], "engine/surface/landmarkPlatforms.ts": ["landmarkPlatforms"], "planRepair/testDrive.ts": ["testDrive"] });
const GENERATED_AT = Date.UTC(2026, 9, 7, 12, 0, 0);
const city = (seed, tier, miami) => {
  let r = 12345; const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
  const rows = Array.from({ length: tier * 400 - 20 }, (_, i) => {
    const total = Math.round(2000 + rnd() ** 3 * 4_000_000); const start = GENERATED_AT - Math.round(rnd() * 28 * 86_400_000);
    return { session_ref: `session:${i}`, harness: ["codex", "claude-code", "dsh"][i % 3], first_event_at: new Date(start).toISOString(),
      last_event_at: new Date(start + Math.round(rnd() * 3_600_000)).toISOString(), event_count: 10, model_ids: ["claude-sonnet-5"],
      tokens: { uncached_input_tokens: Math.round(total * 0.2), cache_read_tokens: Math.round(total * 0.5), cache_write_tokens: Math.round(total * 0.1), output_tokens: Math.round(total * 0.2), total },
      peak_tokens: Math.round(total * 0.3), cost_minor: { amount_minor: Math.round(total / 1000), currency: "USD", basis: "api_equivalent" },
      cost_status: { state: "estimated", reason: "", has_unresolved: false } };
  });
  const model = kit.buildCityModel({ rows, findings: [], windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: rows.length, truncated: false, generatedAt: GENERATED_AT });
  return kit.layoutCity(model, null, seed, miami ? kit.MIAMI_COASTAL : null);
};
const standard = [1, 7, 42, 2026, 65537].flatMap((seed) => [1, 2, 3].map((tier) => [seed, tier, false]));
const plans = process.argv[2]
  ? process.argv[2].split(",").map((t) => { const m = /^(\d+)\/(\d+)(m?)$/.exec(t); return [Number(m[1]), Number(m[2]), m[3] === "m"]; })
  : [...standard, [1703294958, 2, true], [1703310796, 2, true], [1703334553, 5, true]];
const totals = { cities: 0, opera: 0, operaPassed: 0, airport: 0, airportPassed: 0, platformLandings: 0 };
const shoreSideFailures = [];
for (const [seed, tier, miami] of plans) {
  const tag = `${seed}/${tier}${miami ? "m" : ""}`;
  const layout = city(seed, tier, miami); totals.cities++;
  const platforms = kit.landmarkPlatforms(layout);
  assert.ok(platforms.some((p) => p.id.includes("sail-opera")), `${tag}: the sea opera islet is a drivable platform`);
  assert.ok(layout.airport?.causeway && platforms.some((p) => p.id === "platform:airport"), `${tag}: the airport island is a platform reached by a causeway`);
  const c = kit.compileCitySurface(layout); const surface = { ...c.surface, revision: tag };
  const regions = kit.buildSurfaceRegions(surface, kit.buildSurfaceIndex(surface));
  const conn = kit.landingConnectivity(c, regions).filter((x) => x.landing.structureId.startsWith("bridge:"));
  assert.deepEqual(conn.filter((x) => x.landing.status === "no-ground").map((x) => x.landing.structureId), [], `${tag}: no bridge ends in mid-air any more`);
  for (const x of conn) {
    const platform = platforms.find((p) => p.contains(x.landing.x, x.landing.z));
    if (!platform) continue;
    totals.platformLandings++;
    assert.equal(x.landing.status, "aligned", `${tag} ${x.landing.structureId}: the deck lands flush on ${platform.id}`);
    assert.ok(x.connected, `${tag} ${x.landing.structureId}: deck and ${platform.id} are one drivable region (${x.reason})`);
    const deckId = x.landing.structureId.replace(/^bridge:/, "").replace(/:\d{3}$/, "");
    const deck = layout.roadEdges.find((e) => e.id === deckId);
    const drive = kit.testDrive(layout, deckId);
    const isAirport = platform.id === "platform:airport";
    if (isAirport) totals.airport++; else totals.opera++;
    if (drive?.verdict === "passed") { if (isAirport) totals.airportPassed++; else totals.operaPassed++; continue; }
    assert.ok(!isAirport, `${tag}: the airport causeway is drivable both ways (${drive?.forward.reason} / ${drive?.back.reason})`);
    // 歌剧院：只允许在岸端失败（生成器的斜接 / 陡桥头），平台端那一半必须通。
    const shore = platform.contains(deck.points[0].x, deck.points[0].z) ? deck.points[1] : deck.points[0];
    const len = Math.hypot(deck.points[1].x - deck.points[0].x, deck.points[1].z - deck.points[0].z);
    for (const leg of [drive.forward, drive.back]) if (leg.result !== "ok" && leg.at) {
      const fromShore = Math.hypot(leg.at.x - shore.x, leg.at.z - shore.z);
      assert.ok(fromShore < len / 2, `${tag} ${deckId}: an opera causeway may only fail at its shore end (${leg.reason} ${fromShore.toFixed(1)} from shore of ${len.toFixed(0)})`);
    }
    shoreSideFailures.push(`${tag}`);
  }
}
// 底线（2026-10-22 实测：18 城里机场 18/18、歌剧院 16/18；没过的两座是 7/2 的斜接岸端与 1703310796/2 的陡岸端）。
assert.equal(totals.airportPassed, totals.airport, "every airport causeway is drivable");
assert.ok(totals.operaPassed >= totals.opera - 2, `opera causeways regressed: ${totals.operaPassed}/${totals.opera}`);
console.log(`City landmark platforms: ${totals.cities} cities — opera islet and airport island are drivable platforms; ${totals.platformLandings} platform landings flush and connected, no mid-air bridge ends; test drive: airport ${totals.airportPassed}/${totals.airport}, opera ${totals.operaPassed}/${totals.opera} (shore-side generator bridgeheads: ${shoreSideFailures.join(", ") || "none"}).`);
