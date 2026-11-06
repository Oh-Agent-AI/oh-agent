// 编辑器性能基准（CITY_MAP_EDITOR_ROADMAP_SPEC.md P0-1 的验收口径；不登记 manifest——一次跑完要 2 分钟，生成 4000 楼的城市 ~64s）。
// 用法：node scripts/bench-plan-editor.mjs；SIZES=4000 只跑最大档：不同规模城市下编辑器各操作的耗时。
import { loadCity } from "./city-kit/index.mjs";
globalThis.window ??= globalThis;
const k = await loadCity({
  "engine/planPatch.ts": ["applyPlanPatch", "emptyPlanPatch", "appendRoadOp", "validateBuildingMove"],
  "engine/planRoadRules.ts": ["validateRoadAdd", "validateEdgeDrop", "validateNodeMove", "snapPoint", "nearestEdgeAt"],
  "engine/planBulldozer.ts": ["bulldozeForRoads"],
  "engine/planSites.ts": ["listSites", "pickSite"],
  "engine/planAudit.ts": ["auditLayout"],
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});
const H = ["codex", "claude-code", "dsh", "harness:zcode"]; const T = Date.UTC(2026, 9, 7, 12);
const rows = (n) => { let s = 12345; const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return Array.from({ length: n }, (_, i) => { const total = Math.round(2000 + r() ** 3 * 4e6); const start = T - Math.round(r() * 360 * 864e5);
    return { session_ref: `session:${i}`, harness: H[i % 4], first_event_at: new Date(start).toISOString(), last_event_at: new Date(start + 36e5).toISOString(), event_count: 10, model_ids: ["m"],
      tokens: { uncached_input_tokens: total * 0.2, cache_read_tokens: total * 0.5, cache_write_tokens: total * 0.1, output_tokens: total * 0.2, total }, peak_tokens: 0, cost_minor: null, cost_status: { state: "estimated", reason: "", has_unresolved: false } }; }); };
const time = (f, n = 1) => { const t = performance.now(); let v; for (let i = 0; i < n; i++) v = f(); return [(performance.now() - t) / n, v]; };
for (const n of (process.env.SIZES ?? "380,1600,4000").split(",").map(Number)) {
  const model = k.buildCityModel({ rows: rows(n), findings: [], windowStartMs: T - 366 * 864e5, windowEndMs: T, windowLabel: "366d", totalSessions: n, truncated: false, generatedAt: T });
  const [gen, layout] = time(() => k.layoutCity(model, null, undefined, k.MIAMI_COASTAL));
  const [relayout] = time(() => k.layoutCity(model, layout, undefined, k.MIAMI_COASTAL));
  const slots = layout.districts.flatMap((d) => [...d.slots.values()]);
  const c = slots[Math.floor(slots.length / 2)];
  const a = { x: c.x - 60, z: c.z }, b = { x: c.x + 60, z: c.z };
  const [validateAdd, verdict] = time(() => k.validateRoadAdd(layout, model, a, b, 5), 5);
  const [snap] = time(() => k.snapPoint(layout, c.x, c.z), 20);
  const [edgeAt] = time(() => k.nearestEdgeAt(layout, c.x, c.z), 20);
  const edge = layout.roadEdges.find((e) => !e.bridge);
  const [drop] = time(() => k.validateEdgeDrop(layout, model, edge.id), 3);
  const node = layout.roadNodes[Math.floor(layout.roadNodes.length / 2)];
  const [nodeMove] = time(() => k.validateNodeMove(layout, model, node.id, { x: node.x + 8, z: node.z }), 3);
  const patch = k.appendRoadOp(k.emptyPlanPatch(layout.seed, layout.scaleTier), { t: "add", from: a, to: b, width: 5 }, 1);
  const [apply] = time(() => k.applyPlanPatch(layout, patch), 3);
  const [dozer] = time(() => k.bulldozeForRoads(layout, model, layout, patch));
  const ray = { origin: { x: c.x, y: 200, z: c.z + 100 }, direction: { x: 0, y: -0.89, z: -0.45 } };
  const [pick] = time(() => k.pickSite(layout, ray), 10);
  const parcels = layout.blocks.flatMap((bl) => bl.parcels).slice(0, 40);
  const [cand] = time(() => parcels.forEach((p) => k.validateBuildingMove(layout, model, patch, model.buildings[0].id, p.id)));
  const [audit] = time(() => k.auditLayout(layout, model));
  // 编辑后体检重跑（面板开着时每次编辑都跑）：路段坡度按路段对象缓存，第二次起只算新路段。
  const [auditWarm] = time(() => k.auditLayout(layout, model));
  const r = (x) => (x < 10 ? x.toFixed(1) : Math.round(x));
  console.log(JSON.stringify({ buildings: n, tier: layout.scaleTier, edges: layout.roadEdges.length, nodes: layout.roadNodes.length, parcels: layout.blocks.reduce((s, bl) => s + bl.parcels.length, 0), sites: k.listSites(layout).length,
    ms: { generate: r(gen), relayoutCached: r(relayout), validateAdd: r(validateAdd), snap: r(snap), edgeAt: r(edgeAt), validateDrop: r(drop), validateNodeMove: r(nodeMove), applyPatch: r(apply), bulldozer: r(dozer), pickSite: r(pick), candidates40: r(cand), audit: r(audit), auditWarm: r(auditWarm) }, addWarnings: verdict.warnings }));
}
