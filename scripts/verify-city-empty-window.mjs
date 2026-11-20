// 空会话 / 空时间范围仍要排出并挂上可浏览的基础城市。
// 合成行只用于对照「有会话」路径，不代表任何一次真实运行。
// 2026-11-20：status "empty" 曾把画布藏掉、跳过首帧、相机一直禁用。没有 WebGL 错误码。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCity } from "./city-kit/index.mjs";
import { installCanvasShim } from "./city-kit/scene-hash.mjs";

installCanvasShim();
globalThis.window ??= globalThis;
globalThis.devicePixelRatio ??= 1;

const { buildCityModel, layoutCity, CityParts, MIAMI_COASTAL, cityScenePresentation } = await loadCity({
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/cityParts.ts": ["CityParts"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "cityScenePresentation.ts": ["cityScenePresentation"],
});

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = fs.readFileSync(path.join(repo, "apps/agent-city/ui/src/CityApp.tsx"), "utf8");
const viewport = fs.readFileSync(path.join(repo, "apps/agent-city/ui/src/viewport/CityViewport.tsx"), "utf8");
assert.match(app, /cityScenePresentation\(/);
assert.match(app, /visibility: presentation\.hideCanvas \? "hidden" : "visible"/);
assert.doesNotMatch(app, /projection\.status === "empty"/);
assert.match(viewport, /cityScenePresentation\(/);
assert.match(viewport, /presentation\.caption === "empty-note" \? "city-scene-note"/);
assert.doesNotMatch(viewport, /projection\?\.status === "empty"/);

const base = { boot: false, dataLoaded: true, sceneUnavailable: false, gameActive: false };
const waiting = cityScenePresentation({ ...base, status: "empty", firstModelFrame: false });
assert.equal(waiting.hideCanvas, false);
assert.equal(waiting.awaitFirstFrame, true);
assert.equal(waiting.sceneReady, false);
assert.equal(waiting.caption, null);

const emptyReady = cityScenePresentation({ ...base, status: "empty", firstModelFrame: true });
assert.equal(emptyReady.hideCanvas, false);
assert.equal(emptyReady.awaitFirstFrame, false);
assert.equal(emptyReady.sceneReady, true, "empty window unlocks the camera after the base world frames");
assert.equal(emptyReady.caption, "empty-note");

const filtered = cityScenePresentation({ ...base, status: "empty", firstModelFrame: true });
assert.deepEqual(filtered, emptyReady, "a time range with no sessions is the same empty window");

const withSessions = cityScenePresentation({ ...base, status: "ready", firstModelFrame: true });
assert.equal(withSessions.hideCanvas, false);
assert.equal(withSessions.sceneReady, true);
assert.equal(withSessions.caption, null, "a window that has sessions does not wear the empty note");

const layoutFailure = cityScenePresentation({ ...base, status: "empty", firstModelFrame: false, sceneUnavailable: true });
assert.equal(layoutFailure.hideCanvas, true);
assert.equal(layoutFailure.awaitFirstFrame, false);
assert.equal(layoutFailure.sceneReady, false);
assert.equal(layoutFailure.caption, "failure", "a real layout/WebGL failure stays a failure, even if the window is also empty");

const dataDown = cityScenePresentation({ ...base, status: "unavailable", firstModelFrame: false });
assert.equal(dataDown.hideCanvas, true);
assert.equal(dataDown.caption, "data-unavailable");
assert.equal(dataDown.sceneReady, false);

const generatedAt = Date.UTC(2026, 10, 20, 12);
function modelFor(count, windowLabel) {
  const rows = Array.from({ length: count }, (_, index) => ({
    session_ref: `synthetic-session:${windowLabel}:${index}`,
    harness: "codex",
    first_event_at: new Date(generatedAt - (index + 1) * 60_000).toISOString(),
    last_event_at: new Date(generatedAt - index * 60_000).toISOString(),
    event_count: 4,
    model_ids: ["synthetic-model"],
    tokens: { uncached_input_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 20, total: 120 },
    peak_tokens: 80,
    cost_minor: null,
    cost_status: { state: "unavailable", reason: "synthetic", has_unresolved: true },
  }));
  return buildCityModel({
    rows, findings: [], windowStartMs: generatedAt - 7 * 86_400_000, windowEndMs: generatedAt,
    windowLabel, totalSessions: count, truncated: false, generatedAt,
  });
}

function named(parts, prefix) {
  const found = [];
  parts.group.traverse((object) => {
    if (object.name && object.name.startsWith(prefix)) found.push(object);
  });
  return found;
}

function mount(model, label) {
  // 新鲜安装的背景楼档位是 off。基础世界不能靠背景楼冒充会话。
  const layout = layoutCity(model, null, 1927, MIAMI_COASTAL, "off");
  assert.equal(layout.scaleTier, 1, `${label}: zero or few sessions stay on tier 1`);
  assert.ok(layout.roadEdges.length > 0, `${label}: the island keeps a road network`);
  for (const edge of ["left", "right", "north", "south"]) assert.ok(Number.isFinite(layout.urbanBounds[edge]), `${label}: camera bounds`);
  const parts = new CityParts(model, layout, null);
  try {
    const roads = named(parts, "city-road-surface");
    assert.ok(roads.length > 0, `${label}: road surface is mounted`);
    const vertices = roads.reduce((sum, mesh) => sum + (mesh.geometry?.attributes?.position?.count ?? 0), 0);
    assert.ok(vertices > 100, `${label}: road mesh has geometry, not an empty placeholder`);
    const structures = [
      ...named(parts, "city-landmark-"),
      ...named(parts, "city-public-sites"),
      ...named(parts, "city-civic-"),
    ];
    assert.ok(structures.length > 0, `${label}: mounted non-session structures (landmarks, public sites or civics)`);
    return { layout, occupancy: parts.occupancySnapshot().runtimeCount };
  } finally {
    parts.dispose();
  }
}

for (const windowLabel of ["home-without-sessions", "range-without-sessions"]) {
  const model = modelFor(0, windowLabel);
  assert.equal(model.buildings.length, 0);
  assert.equal(model.districts.length, 0);
  assert.equal(model.stats.totalSessions, 0);
  assert.equal(model.stats.tokensTotal, 0);
  const mounted = mount(model, windowLabel);
  assert.equal(mounted.occupancy, 0, `${windowLabel}: no session building was mounted`);
  assert.equal(mounted.layout.contextBuildings.length, 0, `${windowLabel}: backdrop off does not invent context towers`);
}

const live = modelFor(3, "range-with-sessions");
assert.equal(live.buildings.length, 3);
assert.equal(live.stats.totalSessions, 3);
assert.equal(live.stats.tokensTotal, 360);
const mountedLive = mount(live, "range-with-sessions");
assert.equal(mountedLive.occupancy, 3, "session buildings still mount when the window has sessions");
const placed = mountedLive.layout.districts.reduce((sum, district) => sum + district.slots.size, 0);
assert.equal(placed, 3);

console.log("City empty window: base world stays mounted for zero sessions and for an empty time range; session cities still place their buildings.");
