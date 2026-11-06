#!/usr/bin/env node
// 尽端回车圈守卫（路网形态批 §5-3，docs/CITY_PLANNER_V2_FINDINGS.md §5）：合法尽端
// （EndpointRole cul-de-sac）有语义、几何上却路戛然而止——渲染层用回车圆盘补形。
// 本守卫用固定合成数据 → layoutCity → new CityParts，断言场景与规划产物一致：
//   (a) 两档合起来 layout.culDeSacEnds 非空（装饰输入没整体丢失）；单档允许为空，但只能是「最终路网里
//       本来就没有合法尽端」——见 (e)。曾写「迈阿密配置下每档必有：滨海大道计划断点」，是错的：两档
//       23 个滨海样本全有效、从无大道断点，回车点全是 cul-de-sac(coast)（路在近水处终止），随岛形而定。
//       68cd5be1（用地间距改按精确占地）后 380 档岛重解成另一形状（R 495→482、边 535→449），
//       原 (-91.21, 470.33) 的近水尽端节点不复存在，规划层 classifyEndpoints 就不再产出回车点——
//       不是 cityLayout 的 liveDegree 过滤误删（plan.culDeSacEnds 本身已为空）。1600 档仍有 2 个。
//   (b) 每个回车点恰好对应一个 bulb 圆盘实例与一个路缘描边实例（数量一致、位置一致、一一对应）；
//   (c) 圆盘半径落在 6–9（与路宽协调），y 跟随地形中心取样（max(0, height)+0.02），描边在盘面上方（防 z-fighting）；
//   (d) layout.culDeSacEnds 的每个点在最终路网（生长剪枝后）里仍是度 1 非桥路端——
//       计划层分类 + 布局层过滤两道口径不得漂移；
//   (e) 对最终路网（layout）重跑 diagnoseNetwork，其 cul-de-sac 端点集合 == layout.culDeSacEnds——
//       「规划没产出」与「被过滤误删」由此可分：误删时最终路网里仍有合法尽端、场景却没画回车圈。
//   node scripts/verify-city-culdesac-bulbs.mjs
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { installCanvasShim } from "./city-kit/scene-hash.mjs";

installCanvasShim();
globalThis.window ??= globalThis;
globalThis.devicePixelRatio ??= 1;

const { THREE, buildCityModel, layoutCity, CityParts, MIAMI_COASTAL, diagnoseNetwork, terrainSurfaceHeight, CUL_DE_SAC_TOP_LIFT } = await loadCity({
  "pkg:three": ["* as THREE"],
  "engine/surface/terrainSampling.ts": ["terrainSurfaceHeight"],
  "engine/surface/structureCompiler.ts": ["CUL_DE_SAC_TOP_LIFT"],
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/cityParts.ts": ["CityParts"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/intent.ts": ["diagnoseNetwork"],
});

const HARNESSES = ["codex", "claude-code", "dsh", "harness:zcode"];
const GENERATED_AT = Date.UTC(2026, 9, 7, 12, 0, 0);
function rows(count) {
  // 与 verify-city-scene-baseline.mjs 同一套固定伪随机：同一 count 恒同数据。
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return Array.from({ length: count }, (_, i) => {
    const total = Math.round(2000 + rnd() ** 3 * 4_000_000);
    const start = GENERATED_AT - Math.round(rnd() * 28 * 86_400_000);
    const end = i % 17 === 0 ? GENERATED_AT - 60_000 : start + Math.round(rnd() * 3_600_000);
    return {
      session_ref: `session:${i}`, harness: HARNESSES[i % HARNESSES.length],
      first_event_at: new Date(start).toISOString(), last_event_at: new Date(end).toISOString(),
      event_count: 10 + (i % 50), model_ids: [i % 3 ? "claude-sonnet-5" : "gpt-5"],
      tokens: { uncached_input_tokens: Math.round(total * 0.2), cache_read_tokens: Math.round(total * 0.5), cache_write_tokens: Math.round(total * 0.1), output_tokens: Math.round(total * 0.2), total },
      peak_tokens: Math.round(total * 0.3),
      cost_minor: { amount_minor: Math.round(total / 1000), currency: "USD", basis: "api_equivalent" },
      cost_status: { state: "estimated", reason: "", has_unresolved: false },
    };
  });
}

/** 收集场景图里指定名字的 InstancedMesh 实例（位置 + 半径缩放）。 */
function instances(parts, name) {
  const found = [];
  parts.group.traverse((node) => {
    if (!(node instanceof THREE.InstancedMesh) || node.name !== name) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let index = 0; index < node.count; index += 1) {
      node.getMatrixAt(index, matrix);
      matrix.decompose(position, quaternion, scale);
      found.push({ x: position.x, y: position.y, z: position.z, radius: scale.x });
    }
  });
  return found;
}

const summary = [];
let totalEnds = 0;
for (const count of [380, 1600]) {
  const model = buildCityModel({ rows: rows(count), findings: [], windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: count, truncated: false, generatedAt: GENERATED_AT });
  const layout = layoutCity(model, null, undefined, MIAMI_COASTAL);
  const ends = layout.culDeSacEnds ?? [];
  totalEnds += ends.length;
  // (e) 最终路网的合法尽端 == 回车点：两边都按坐标键比，顺序无关。
  const key = (p) => `${p.x}:${p.z}`;
  const legal = (diagnoseNetwork(layout)?.endpoints ?? []).filter((end) => end.role.kind === "cul-de-sac").map((end) => key(end.at)).sort();
  assert.deepEqual([...ends.map(key)].sort(), legal, `${count} sessions: layout.culDeSacEnds [${ends.map(key).join(", ")}] != cul-de-sac endpoints of the final network [${legal.join(", ")}] — a legal dead end was dropped (or a stale one kept)`);
  // (d) 布局层口径：每个回车点在生长剪枝后的路网里仍是度 1 非桥路端。
  const degree = new Map();
  for (const edge of layout.roadEdges) if (!edge.bridge) for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const end of ends) assert.equal(degree.get(`${end.x}:${end.z}`), 1, `${count} sessions: cul-de-sac end (${end.x}, ${end.z}) is not a degree-1 non-bridge road end of the final network`);
  const parts = new CityParts(model, layout, null);
  const discs = instances(parts, "city-culdesac-bulb-disc");
  const rims = instances(parts, "city-culdesac-bulb-rim");
  if (ends.length > 0) assert.ok(discs.length > 0 && rims.length > 0, `${count} sessions: bulb batches missing from the scene`);
  // (b) 数量一致 + 位置一一对应（双向：无多余实例、无落单端点）。
  assert.equal(discs.length, ends.length, `${count} sessions: disc instances ${discs.length} != culDeSacEnds ${ends.length}`);
  assert.equal(rims.length, ends.length, `${count} sessions: rim instances ${rims.length} != culDeSacEnds ${ends.length}`);
  const EPSILON = 1e-3;
  const taken = new Set();
  for (const end of ends) {
    const hit = discs.filter((disc) => Math.abs(disc.x - end.x) < EPSILON && Math.abs(disc.z - end.z) < EPSILON);
    assert.equal(hit.length, 1, `${count} sessions: expected exactly one bulb disc at (${end.x}, ${end.z}), found ${hit.length}`);
    const rim = rims.filter((candidate) => Math.abs(candidate.x - end.x) < EPSILON && Math.abs(candidate.z - end.z) < EPSILON);
    assert.equal(rim.length, 1, `${count} sessions: expected exactly one bulb rim at (${end.x}, ${end.z}), found ${rim.length}`);
    // (c) 半径与路宽协调、高度贴地形取样、描边在盘面上。
    assert.ok(hit[0].radius >= 6 - EPSILON && hit[0].radius <= 9 + EPSILON, `${count} sessions: bulb radius ${hit[0].radius} at (${end.x}, ${end.z}) outside 6–9`);
    // 盘面顶 = 路面顶（三角化地形 + 0.04）+ CUL_DE_SAC_TOP_LIFT；盘体底在顶下 0.12。曾按 terrain.height 真值 + 0.14 取顶，
    // 比路面高 ≈0.10，卡在驾驶面别名容差上，七城 10/25 个回车圈与宿主路不连通（2026-10-20）。
    const top = terrainSurfaceHeight(layout, end.x, end.z) + 0.04 + CUL_DE_SAC_TOP_LIFT;
    assert.ok(Math.abs(hit[0].y + 0.12 - top) < 1e-3, `${count} sessions: bulb disc top ${hit[0].y + 0.12} is not ${CUL_DE_SAC_TOP_LIFT} above the road top (expected ${top.toFixed(3)}) at (${end.x}, ${end.z})`);
    assert.ok(rim[0].y - hit[0].y > 0.1 && rim[0].y - hit[0].y < 0.2, `${count} sessions: bulb rim must hover just above the disc (got ${rim[0].y - hit[0].y})`);
    taken.add(`${end.x}:${end.z}`);
  }
  assert.equal(taken.size, ends.length, `${count} sessions: duplicate cul-de-sac ends in the layout`);
  summary.push(`${count} sessions → ${ends.length} bulbs`);
  parts.dispose?.();
}
// (a) 两档合起来必须有回车点：全空说明装饰输入整体丢了（或固定数据不再覆盖这条路径，该换档）。
assert.ok(totalEnds > 0, "layout.culDeSacEnds is empty for every fixture — cul-de-sac decoration lost its input");
console.log(`City cul-de-sac bulbs: ${summary.join(", ")} — every culDeSacEnd has exactly one terrain-following disc + rim instance, radii 6–9, all still degree-1 road ends, and they equal the final network's cul-de-sac endpoints.`);
