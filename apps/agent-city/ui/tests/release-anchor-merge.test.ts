import test from "node:test";
import assert from "node:assert/strict";
import { mergeReleaseAnchors, RELEASE_ZONE_DEFAULT_RADIUS_METERS } from "../src/game/activity/releaseLayout";

// 实机视图：只有路网锚点与节点几何（节点**没有**触发半径——这正是空域门复用节点后
// 玩不了的原因）。
const liveView = () => ({
  layout: { schemaVersion: 1, id: "layout-1", coordinateSystem: "city-local-m-v1", anchors: [
    { id: "road-spawn:a", kind: "spawn", capabilities: ["drive"], geometryRef: "city-road-node:a" },
    { id: "road-checkpoint:e", kind: "zone", capabilities: ["drive"], geometryRef: "city-road-edge:e:midpoint" },
  ], links: [] },
  geometry: new Map([
    ["city-road-node:a", { positionMeters: { x: 10, y: 0, z: 20 } }],
    ["city-road-edge:e:midpoint", { positionMeters: { x: 30, y: 0, z: 20 }, activationRadiusMeters: 6 }],
  ]),
  roadSegments: [], preferredStartMeters: { x: 0, z: 0 }, seed: 42, worldRevision: "world-1",
} as any);

// 冻结快照：Creator 往同一 worldRevision 上加了空域门（复用路网节点，无半径）。
const snapshot = () => ({
  schemaVersion: 2, cityId: "city-1", cityRevision: 1, worldRevision: "world-1", seed: 42,
  layout: { schemaVersion: 1, id: "layout-1", coordinateSystem: "city-local-m-v1",
    // 空域门必须能从入口沿 link 到达（validateMount 的可达性检查）。
    anchors: [
      { id: "spawn-air", kind: "spawn", capabilities: ["fly"], geometryRef: "city-road-node:a" },
      { id: "air-gate:0", kind: "zone", capabilities: ["fly"], geometryRef: "city-road-node:a" },
      { id: "air-gate:1", kind: "zone", capabilities: ["fly"], geometryRef: "city-road-edge:e:midpoint" },
    ],
    links: [
      { id: "air-link-spawn-gate0", fromAnchorId: "spawn-air", toAnchorId: "air-gate:0", capabilities: ["fly"] },
      { id: "air-link-spawn-gate1", fromAnchorId: "spawn-air", toAnchorId: "air-gate:1", capabilities: ["fly"] },
      // 端点不在合并集合里的 link 不能并（会造出悬空 link）。
      { id: "air-link-ghost", fromAnchorId: "spawn-air", toAnchorId: "air-gate:ghost", capabilities: ["fly"] },
    ] },
} as any);

test("published anchors are merged into a live-City view copy, never mutating it", () => {
  const view = liveView();
  const before = view.layout.anchors.length;
  const merged = mergeReleaseAnchors(view, snapshot());
  assert.equal(merged.ok, true);
  if (!merged.ok) return;
  assert.equal(view.layout.anchors.length, before, "the live view must stay untouched");
  assert.deepEqual(merged.addedAnchorIds, ["spawn-air", "air-gate:0", "air-gate:1"]);
  const linkIds = merged.view.layout.links.map(link => link.id);
  assert.ok(linkIds.includes("air-link-spawn-gate0") && linkIds.includes("air-link-spawn-gate1"), "reachability links must be merged");
  assert.ok(!linkIds.includes("air-link-ghost"), "links with unknown endpoints must not be merged");
  assert.ok(merged.view.layout.anchors.some(anchor => anchor.id === "air-gate:0" && anchor.capabilities.includes("fly")));
});

test("a zone anchor whose City geometry has no trigger radius gets the documented default", () => {
  const merged = mergeReleaseAnchors(liveView(), snapshot());
  assert.equal(merged.ok, true);
  if (!merged.ok) return;
  // 门复用路网节点 → 节点没有半径 → 补默认触发球；路段中点本来就有实测半径，不动。
  assert.deepEqual(merged.defaultedRadiusRefs, ["city-road-node:a"]);
  assert.equal(merged.view.geometry.get("city-road-node:a")?.activationRadiusMeters, RELEASE_ZONE_DEFAULT_RADIUS_METERS);
  assert.equal(merged.view.geometry.get("city-road-edge:e:midpoint")?.activationRadiusMeters, 6);
});

test("a published anchor with no matching City geometry is refused whole", () => {
  const drifted = snapshot();
  drifted.layout.anchors.push({ id: "air-gate:2", kind: "zone", capabilities: ["fly"], geometryRef: "city-road-node:gone" });
  const merged = mergeReleaseAnchors(liveView(), drifted);
  assert.equal(merged.ok, false);
  if (merged.ok) return;
  assert.equal(merged.diagnostics[0]?.code, "release_anchor_geometry_unavailable");
  assert.equal(merged.diagnostics[0]?.objectId, "air-gate:2");
});

test("the same anchor id with a different geometryRef is a conflict, not a silent override", () => {
  const conflicting = snapshot();
  conflicting.layout.anchors[0] = { ...conflicting.layout.anchors[0], id: "road-spawn:a", geometryRef: "city-road-node:other" };
  const merged = mergeReleaseAnchors(liveView(), conflicting);
  assert.equal(merged.ok, false);
  if (merged.ok) return;
  assert.equal(merged.diagnostics[0]?.code, "release_anchor_conflict");
});

test("a release without a frozen layout leaves the view untouched", () => {
  const view = liveView();
  const merged = mergeReleaseAnchors(view, null);
  assert.equal(merged.ok, true);
  if (!merged.ok) return;
  assert.equal(merged.view, view);
  assert.deepEqual(merged.addedAnchorIds, []);
});

test("an airspace gate that only exists in the snapshot geometry is merged, radius and all", () => {
  // Creator 自己布的空域门（creator-air:*）不在 City 路网里：实机几何没有它，
  // 只有快照 v3 的 geometry 知道位置与半径。合并后必须能直接拿来做计划。
  const withAir = snapshot();
  withAir.layout.anchors.push({ id: "gate-air:1", kind: "zone", capabilities: ["fly"], geometryRef: "creator-air:gate-air:1" });
  withAir.layout.links.push({ id: "air-link-to-air", fromAnchorId: "spawn-air", toAnchorId: "gate-air:1", capabilities: ["fly"] });
  withAir.geometry = [
    { geometryRef: "creator-air:gate-air:1", positionMeters: { x: 0, y: 80, z: 120 }, activationRadiusMeters: 18 },
  ];
  const merged = mergeReleaseAnchors(liveView(), withAir);
  assert.equal(merged.ok, true);
  if (!merged.ok) return;
  assert.ok(merged.addedAnchorIds.includes("gate-air:1"));
  assert.deepEqual(merged.view.geometry.get("creator-air:gate-air:1"), { positionMeters: { x: 0, y: 80, z: 120 }, activationRadiusMeters: 18 });
  // 有实测半径 → 不需要默认值。
  assert.deepEqual(merged.defaultedRadiusRefs, ["city-road-node:a"]);
});

test("an anchor with neither live nor snapshot geometry is still refused", () => {
  const ghost = snapshot();
  ghost.layout.anchors.push({ id: "air-gate:ghost", kind: "zone", capabilities: ["fly"], geometryRef: "creator-air:ghost" });
  ghost.layout.links.push({ id: "air-link-ghost2", fromAnchorId: "spawn-air", toAnchorId: "air-gate:ghost", capabilities: ["fly"] });
  const merged = mergeReleaseAnchors(liveView(), ghost);
  assert.equal(merged.ok, false);
  if (merged.ok) return;
  assert.equal(merged.diagnostics[0]?.code, "release_anchor_geometry_unavailable");
  assert.equal(merged.diagnostics[0]?.objectId, "air-gate:ghost");
});
