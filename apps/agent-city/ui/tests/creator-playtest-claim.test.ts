import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { canonicalJson } from "@oh-agent/city-sdk";

const game = { schemaVersion: 1, id: "creator.collect-one", rulesVersion: 1, integerParameters: {}, slots: { targets: { kind: "zone", min: 1, max: 2, requires: ["drive"] } }, rules: { counters: {}, nodes: [] } };
const digest = `sha256:${createHash("sha256").update(canonicalJson(game)).digest("hex")}`;
const view = { layout: { schemaVersion: 1, id: "fixture", coordinateSystem: "city-local-m-v1", anchors: [
  { id: "spawn", kind: "spawn", capabilities: ["drive"], geometryRef: "g:spawn" },
  { id: "target", kind: "zone", capabilities: ["drive"], geometryRef: "g:target" },
], links: [{ id: "link", fromAnchorId: "spawn", toAnchorId: "target", capabilities: ["drive"] }] },
  geometry: new Map([["g:spawn", { positionMeters: { x: 0, y: 0, z: 0 } }], ["g:target", { positionMeters: { x: 10, y: 0, z: 0 } }]]),
  roadSegments: [], preferredStartMeters: { x: 0, z: 0 }, seed: 7, worldRevision: "r1" };
const handoff = { runId: "run-1", projectId: "project-1", revision: 1, releaseId: "release-1", snapshotDigest: `sha256:${"a".repeat(64)}`, game,
  mounts: [{ schemaVersion: 1, mountId: "mount-1", layout: { kind: "city-layout", id: "fixture", version: "1", digest: "r1" },
    game: { kind: "city-minigame", id: game.id, version: "1", digest }, entryAnchorId: "spawn", bindings: { targets: ["target"] }, parameterOverrides: {} }],
  scene: { schemaVersion: 1, objects: [] }, assets: { schemaVersion: 1, entries: [] }, assetRefs: [] };

test("claim validates the complete release and preserves its scene package", async () => {
  const methods: string[] = [];
  const payloads: unknown[] = [];
  const fakeWindow: any = { __AV_PLUGIN_INSTANCE__: "city-1", __TAURI__: { core: { invoke: async (_command: string, args: any) => {
    methods.push(args.request.method);
    payloads.push(args.request.payload);
    return { version: 1, requestId: args.request.requestId, ok: true, result: handoff };
  } } } };
  fakeWindow.parent = fakeWindow;
  (globalThis as any).window = fakeWindow;
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  const { claimCreatorPlaytest } = await import("../src/game/activity/loadCreatorExperiences");
  const result = await claimCreatorPlaytest(view as any, "run-1");
  assert.equal(result?.experiences.length, 1);
  assert.deepEqual(result?.experiences[0].scenePackage?.scene, handoff.scene);
  assert.deepEqual(result?.experiences[0].scenePackage?.assetRefs, []);
  assert.deepEqual(methods, ["city.creator.playtest.claim"]);
  assert.deepEqual(payloads, [{ runId: "run-1" }]);
});

// 飞行 release 的入口锚点可能是 fly-only（阶段 2 的锚点声明），且 release 冻结了
// 用户的载具 profile：试玩必须飞这一台，而不是默认飞机。
const flightVehicle = { schemaVersion: 1, id: "vehicle-flight-release", label: "Released flier", modelAssetId: null, flightModel: "fixed-wing",
  physics: { massKg: 600, wingAreaM2: 12, thrustN: 9000, maxSpeedMps: 110, dragCoefficient: 0.3, turnRateRps: 1.1, climbRateMps: 20, sinkRateMps: 12 },
  bounds: { halfLengthM: 4, halfWidthM: 5, halfHeightM: 1.5 }, camera: { followDistanceM: 30, heightOffsetM: 13, fovDeg: 55 } };
const flightGame = { schemaVersion: 1, id: "creator.flight-checkpoint", rulesVersion: 1, integerParameters: {},
  slots: { gates: { kind: "zone", min: 1, max: 2, requires: ["fly"] } }, rules: { counters: {}, nodes: [] } };
const flightDigest = `sha256:${createHash("sha256").update(canonicalJson(flightGame)).digest("hex")}`;
const flightView = { layout: { schemaVersion: 1, id: "fixture", coordinateSystem: "city-local-m-v1", anchors: [
  { id: "spawn-air", kind: "spawn", capabilities: ["fly"], geometryRef: "g:spawn-air" },
  { id: "gate-a", kind: "zone", capabilities: ["fly"], geometryRef: "g:gate-a" },
], links: [{ id: "link", fromAnchorId: "spawn-air", toAnchorId: "gate-a", capabilities: ["fly"] }] },
  geometry: new Map([["g:spawn-air", { positionMeters: { x: 0, y: 40, z: 0 } }], ["g:gate-a", { positionMeters: { x: 60, y: 40, z: 0 } }]]),
  roadSegments: [], preferredStartMeters: { x: 0, z: 0 }, seed: 7, worldRevision: "r1" };
const flightHandoff = (vehicle: unknown) => ({ runId: "run-flight", projectId: "project-1", revision: 1, releaseId: "release-flight",
  snapshotDigest: `sha256:${"b".repeat(64)}`, gameType: "flight", vehicle, game: flightGame,
  mounts: [{ schemaVersion: 1, mountId: "mount-flight", layout: { kind: "city-layout", id: "fixture", version: "1", digest: "r1" },
    game: { kind: "city-minigame", id: flightGame.id, version: "1", digest: flightDigest }, entryAnchorId: "spawn-air",
    bindings: { gates: ["gate-a"] }, parameterOverrides: {} }],
  scene: { schemaVersion: 1, objects: [] }, assets: { schemaVersion: 1, entries: [] }, assetRefs: [] });

function installHost(result: unknown, calls: { method: string; payload: any }[]) {
  const fakeWindow: any = { __AV_PLUGIN_INSTANCE__: "city-1", __TAURI__: { core: { invoke: async (_command: string, args: any) => {
    calls.push({ method: args.request.method, payload: args.request.payload });
    return { version: 1, requestId: args.request.requestId, ok: true, result };
  } } } };
  fakeWindow.parent = fakeWindow;
  (globalThis as any).window = fakeWindow;
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

test("a flight release hands its frozen vehicle to the City runtime and accepts a fly-only spawn", async () => {
  const calls: { method: string; payload: any }[] = [];
  installHost(flightHandoff(flightVehicle), calls);
  const { claimCreatorPlaytest } = await import("../src/game/activity/loadCreatorExperiences");
  const result = await claimCreatorPlaytest(flightView as any, "run-flight");
  assert.equal(result?.gameType, "flight");
  assert.equal(result?.vehicle?.id, "vehicle-flight-release");
  assert.equal(result?.vehicle?.physics.maxSpeedMps, 110);
  assert.equal(result?.experiences.length, 1);
  assert.equal(result?.experiences[0].mount.entryAnchorId, "spawn-air");
  assert.deepEqual(calls.map(call => call.method), ["city.creator.playtest.claim"]);
});

test("an invalid frozen vehicle fails the playtest instead of silently flying the default plane", async () => {
  const calls: { method: string; payload: any }[] = [];
  const broken = { ...flightVehicle, physics: { ...flightVehicle.physics, massKg: "heavy" } };
  installHost(flightHandoff(broken), calls);
  const { claimCreatorPlaytest } = await import("../src/game/activity/loadCreatorExperiences");
  await assert.rejects(() => claimCreatorPlaytest(flightView as any, "run-flight"), /creator_release_vehicle_invalid/);
  const finish = calls.find(call => call.method === "city.creator.playtest.finish");
  assert.ok(finish, "the run must be closed, not left occupying the playtest slot");
  assert.equal(finish!.payload.status, "failed");
  assert.equal(finish!.payload.failureCode, "creator_release_vehicle_invalid");
});

test("a legacy flight release without a vehicle still plays with the default plane", async () => {
  const calls: { method: string; payload: any }[] = [];
  installHost(flightHandoff(null), calls);
  const { claimCreatorPlaytest } = await import("../src/game/activity/loadCreatorExperiences");
  const result = await claimCreatorPlaytest(flightView as any, "run-flight");
  assert.equal(result?.gameType, "flight");
  assert.equal(result?.vehicle, undefined);
  assert.equal(result?.experiences.length, 1);
});

test("driving claims still require a drive-capable entry anchor", async () => {
  const calls: { method: string; payload: any }[] = [];
  // 驾驶 release 绑到 fly-only 出生点必须被拒绝（driving 行为不变：能力要求仍是 drive）。
  const driveGame = { ...game };
  const driveDigest = `sha256:${createHash("sha256").update(canonicalJson(driveGame)).digest("hex")}`;
  installHost({ ...flightHandoff(null), gameType: "driving", game: driveGame,
    mounts: [{ schemaVersion: 1, mountId: "mount-flight", layout: { kind: "city-layout", id: "fixture", version: "1", digest: "r1" },
      game: { kind: "city-minigame", id: driveGame.id, version: "1", digest: driveDigest }, entryAnchorId: "spawn-air",
      bindings: { targets: ["gate-a"] }, parameterOverrides: {} }] }, calls);
  const { claimCreatorPlaytest } = await import("../src/game/activity/loadCreatorExperiences");
  await assert.rejects(() => claimCreatorPlaytest(flightView as any, "run-flight"), /creator_playtest_release_incompatible/);
  const finish = calls.find(call => call.method === "city.creator.playtest.finish");
  assert.equal(finish!.payload.status, "failed");
  // SDK 的 mount 校验先一步拒绝（槽位要求 drive、锚点只有 fly），早于入口几何检查。
  assert.equal(finish!.payload.failureCode, "anchor_capability_missing");
});

// 发布锚点并回实机视图：`air-gate:*` 只在冻结快照里，实机视图由路网生成、看不到它。
// 不并进来，validateMount 会以 anchor_not_found 拒绝整份发布物（flight 试玩根本没开始）。
const releaseAnchorsGame = { schemaVersion: 1, id: "creator.flight-checkpoint", rulesVersion: 1, integerParameters: {},
  slots: { gates: { kind: "zone", min: 1, max: 2, requires: ["fly"] } }, rules: { counters: {}, nodes: [] } };
const releaseAnchorsDigest = `sha256:${createHash("sha256").update(canonicalJson(releaseAnchorsGame)).digest("hex")}`;
const frozenLayout = (geometryRef: string) => ({ schemaVersion: 2, cityId: "fixture", cityRevision: 1, worldRevision: "r1", seed: 7,
  layout: { schemaVersion: 1, id: "fixture", coordinateSystem: "city-local-m-v1", anchors: [
    { id: "spawn-air", kind: "spawn", capabilities: ["fly"], geometryRef: "g:spawn-air" },
    { id: "air-gate:0", kind: "zone", capabilities: ["fly"], geometryRef },
  ], // 空域门必须能从入口沿 link 到达（validateMount 的 anchor_unreachable），
     // 与 creator_city_anchor_upsert 现在自动补的星形 link 一致。
  links: [{ id: "air-link-spawn-to-gate", fromAnchorId: "spawn-air", toAnchorId: "air-gate:0", capabilities: ["fly"] }] } });
const releaseAnchorsHandoff = (layout: unknown) => ({ runId: "run-air", projectId: "project-1", revision: 1, releaseId: "release-air",
  snapshotDigest: `sha256:${"e".repeat(64)}`, gameType: "flight", vehicle: null, layout, game: releaseAnchorsGame,
  mounts: [{ schemaVersion: 1, mountId: "mount-air", layout: { kind: "city-layout", id: "fixture", version: "1", digest: "r1" },
    game: { kind: "city-minigame", id: releaseAnchorsGame.id, version: "1", digest: releaseAnchorsDigest },
    entryAnchorId: "spawn-air", bindings: { gates: ["air-gate:0"] }, parameterOverrides: {} }],
  scene: { schemaVersion: 1, objects: [] }, assets: { schemaVersion: 1, entries: [] }, assetRefs: [] });
const airView = { ...view, geometry: new Map([...view.geometry,
  ["g:spawn-air", { positionMeters: { x: 0, y: 40, z: 0 } }],
  ["g:gate", { positionMeters: { x: 0, y: 40, z: 400 } }]]) } as any;

test("a published air gate that only exists in the frozen layout is merged before validation", async () => {
  const calls: { method: string; payload: any }[] = [];
  installHost(releaseAnchorsHandoff(frozenLayout("g:gate")), calls);
  const { claimCreatorPlaytest } = await import("../src/game/activity/loadCreatorExperiences");
  const result = await claimCreatorPlaytest(airView, "run-air");
  assert.equal(result?.gameType, "flight");
  assert.equal(result?.experiences.length, 1, JSON.stringify(calls.map(call => call.method)));
  assert.equal(result?.experiences[0].mount.entryAnchorId, "spawn-air");
  // handoff 必须带上合并后的视图：建计划/开局用它，用实机视图会 anchor_not_found。
  assert.ok(result?.view, "handoff must carry the merged view");
  assert.ok(result.view!.layout.anchors.some(anchor => anchor.id === "air-gate:0"), "merged view must contain the published air gate");
  assert.ok(result.view!.geometry.has("g:gate"), "merged view must resolve the air gate geometry");
});

test("a published anchor whose City geometry is gone fails the run instead of guessing", async () => {
  const calls: { method: string; payload: any }[] = [];
  installHost(releaseAnchorsHandoff(frozenLayout("g:missing")), calls);
  const { claimCreatorPlaytest } = await import("../src/game/activity/loadCreatorExperiences");
  await assert.rejects(() => claimCreatorPlaytest(airView, "run-air"), /release_anchor_geometry_unavailable/);
  const finish = calls.find(call => call.method === "city.creator.playtest.finish");
  assert.equal(finish!.payload.status, "failed");
  assert.equal(finish!.payload.failureCode, "release_anchor_geometry_unavailable");
});
