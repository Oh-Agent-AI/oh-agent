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

// claim → 建计划 → 跑一局的闭环：这是真机失败的下一步（claim 合并了视图，但建计划用
// 实机视图 → anchor_not_found）。这里用「只在快照里」的空域门验证整条链路。
test("a released air gate flows from the merged view into a runnable plan and a passed run", async () => {
  const { createCreatorMiniGamePlan } = await import("../src/game/activity/creatorMiniGame");
  const { MountedMiniGameControllerV1 } = await import("../src/game/activity/mountedMiniGame");
  const game = { schemaVersion: 1, id: "creator.flight-checkpoint", rulesVersion: 1,
    slots: { gates: { kind: "zone", min: 1, max: 3, requires: ["fly"] } },
    rules: { counters: { next: { initial: 0, max: 3 } }, nodes: [
      { id: "pass", on: { type: "zone.entered", slot: "gates" }, actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
      { id: "finish", on: { type: "zone.entered", slot: "gates" }, when: [{ op: "counter.eq", counter: "next", value: 3 }], actions: [{ op: "run.finish", outcome: "success" }] },
    ] } };
  const frozen = snapshot();
  frozen.layout.anchors.push(
    { id: "spawn-air:n", kind: "spawn", capabilities: ["fly"], geometryRef: "creator-air:spawn" },
    { id: "air-gate:n1", kind: "zone", capabilities: ["fly"], geometryRef: "creator-air:g1" },
    { id: "air-gate:n2", kind: "zone", capabilities: ["fly"], geometryRef: "creator-air:g2" },
    { id: "air-gate:n3", kind: "zone", capabilities: ["fly"], geometryRef: "creator-air:g3" });
  frozen.layout.links.push(
    { id: "l1", fromAnchorId: "spawn-air:n", toAnchorId: "air-gate:n1", capabilities: ["fly"] },
    { id: "l2", fromAnchorId: "spawn-air:n", toAnchorId: "air-gate:n2", capabilities: ["fly"] },
    { id: "l3", fromAnchorId: "spawn-air:n", toAnchorId: "air-gate:n3", capabilities: ["fly"] });
  frozen.geometry = [
    { geometryRef: "creator-air:spawn", positionMeters: { x: 0, y: 40, z: 0 } },
    { geometryRef: "creator-air:g1", positionMeters: { x: 150, y: 40, z: 0 }, activationRadiusMeters: 20, facingRadians: Math.PI / 2 },
    { geometryRef: "creator-air:g2", positionMeters: { x: 300, y: 40, z: 0 }, activationRadiusMeters: 20, facingRadians: Math.PI / 2 },
    { geometryRef: "creator-air:g3", positionMeters: { x: 450, y: 40, z: 0 }, activationRadiusMeters: 20, facingRadians: Math.PI / 2 },
  ];
  const merged = mergeReleaseAnchors(liveView(), frozen);
  assert.equal(merged.ok, true);
  if (!merged.ok) return;
  const experience = { releaseId: "release-air", title: "Air", game,
    mount: { schemaVersion: 1, mountId: "mount-air", layout: { kind: "city-layout", id: "layout-1", version: "1", digest: "world-1" },
      game: { kind: "city-minigame", id: game.id, version: "1", digest: "sha256:" + "a".repeat(64) },
      entryAnchorId: "spawn-air:n", bindings: { gates: ["air-gate:n1", "air-gate:n2", "air-gate:n3"] }, parameterOverrides: {} },
    entryPositionWorld: { x: 0, z: 0 } } as any;
  const plan = createCreatorMiniGamePlan(merged.view, experience, { capability: "fly" });
  assert.equal(plan.ok, true, plan.ok ? "" : JSON.stringify(plan.diagnostics));
  if (!plan.ok) return;
  let latest: any = null;
  const controller = new MountedMiniGameControllerV1(plan.value, snapshot => { latest = snapshot; });
  // 沿 +X 直线飞过两道门（40 m 高度、半径 20）。
  for (const x of [0, 75, 150, 225, 300, 375, 450]) controller.fixedStep({ x, y: 40, z: 0 });
  assert.equal(latest?.state.outcome, "success");
  assert.equal(latest?.state.counters.next, 3);
});
