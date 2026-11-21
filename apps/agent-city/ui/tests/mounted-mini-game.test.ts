import test from "node:test";
import assert from "node:assert/strict";
import { createMountedMiniGamePlan, MountedMiniGameControllerV1 } from "../src/game/activity/mountedMiniGame";
import { createCreatorMiniGamePlan, CreatorMiniGameRuntimeControllerV1 } from "../src/game/activity/creatorMiniGame";
import type { CityLayoutSdkViewV1 } from "../src/engine/sdk/cityLayoutAdapter";

const game = { schemaVersion: 1, id: "creator.collect-one", rulesVersion: 1, slots: { targets: { kind: "zone", min: 1, max: 2, requires: ["drive"] } }, rules: {
  counters: { found: { initial: 0, max: 1 } }, nodes: [
    { id: "collect", on: { type: "zone.entered", slot: "targets" }, actions: [{ op: "counter.add", counter: "found", amount: 1 }, { op: "run.finish", outcome: "success" }] },
  ],
} };
const view: CityLayoutSdkViewV1 = {
  layout: { schemaVersion: 1, id: "fixture", coordinateSystem: "city-local-m-v1", anchors: [
    { id: "spawn", kind: "spawn", capabilities: ["drive"], geometryRef: "g:spawn" },
    { id: "target", kind: "zone", capabilities: ["drive"], geometryRef: "g:target" },
    { id: "road-end", kind: "spawn", capabilities: ["drive"], geometryRef: "g:road-end" },
  ], links: [
    { id: "link-a", fromAnchorId: "spawn", toAnchorId: "target", capabilities: ["drive"] },
    { id: "link-b", fromAnchorId: "target", toAnchorId: "road-end", capabilities: ["drive"] },
  ] },
  geometry: new Map([
    ["g:spawn", { positionMeters: { x: 0, y: 0, z: 0 } }],
    ["g:target", { positionMeters: { x: 10, y: 0, z: 0 }, activationRadiusMeters: 1 }],
    ["g:road-end", { positionMeters: { x: 20, y: 0, z: 0 } }],
  ]), roadSegments: [{ id: "road-1", fromAnchorId: "spawn", toAnchorId: "road-end", checkpointAnchorId: "target", lengthMeters: 20 }], preferredStartMeters: { x: 0, z: 0 }, seed: 7, worldRevision: "r1",
};
const mount = { schemaVersion: 1 as const, mountId: "mounted-run", layout: { kind: "city-layout" as const, id: "fixture", version: "1", digest: "r1" }, game: { kind: "city-minigame" as const, id: "creator.collect-one", version: "1", digest: "local-test" }, entryAnchorId: "spawn", bindings: { targets: ["target"] }, parameterOverrides: {} };

test("loads a creator JSON mini-game and runs it through the shared fixed-step trigger host", () => {
  const plan = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(game), mount, gameRef: mount.game, seed: 7 });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  let latest = null;
  const controller = new MountedMiniGameControllerV1(plan.value, snapshot => { latest = snapshot; });
  controller.fixedStep({ x: 8, y: 0, z: 0 });
  controller.fixedStep({ x: 10, y: 0, z: 0 });
  assert.equal(latest?.status, "success");
  assert.equal(latest?.state.counters.found, 1);
});

test("rejects executable packages and undeclared mount anchors before starting", () => {
  const executable = createMountedMiniGamePlan({ view, packageJson: JSON.stringify({ ...game, script: "return fetch('/secret')" }), mount, gameRef: mount.game, seed: 7 });
  assert.equal(executable.ok, false);
  const missingAnchor = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(game), mount: { ...mount, bindings: { targets: ["missing"] } }, gameRef: mount.game, seed: 7 });
  assert.equal(missingAnchor.ok, false);
  if (!missingAnchor.ok) assert.ok(missingAnchor.diagnostics.some(item => item.code === "anchor_not_found"));
});

test("accepts a valid optional slot with no bound zones", () => {
  const optional = { ...game, slots: { targets: { kind: "zone", min: 0, max: 2, requires: ["drive"] } }, rules: { counters: {}, nodes: [] } };
  const result = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(optional), mount: { ...mount, bindings: {} }, gameRef: mount.game, seed: 7 });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.zones.targets, []);
});

test("rejects a resolved package reference that does not match the mounted game digest", () => {
  const result = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(game), mount, gameRef: { ...mount.game, digest: "sha256:wrong" }, seed: 7 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.diagnostics.some(item => item.code === "content_ref_mismatch"));
});

test("rejects drive anchors that exist but are disconnected from the mounted entry", () => {
  const disconnectedView: CityLayoutSdkViewV1 = {
    ...view,
    layout: { ...view.layout, anchors: [...view.layout.anchors, { id: "isolated-target", kind: "zone", capabilities: ["drive"], geometryRef: "g:isolated" }] },
    geometry: new Map([...view.geometry, ["g:isolated", { positionMeters: { x: 100, y: 0, z: 0 }, activationRadiusMeters: 1 }]]),
  };
  const result = createMountedMiniGamePlan({ view: disconnectedView, packageJson: JSON.stringify(game), mount: { ...mount, bindings: { targets: ["isolated-target"] } }, gameRef: mount.game, seed: 7 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.diagnostics.some(item => item.code === "anchor_unreachable" && item.path === "mount.bindings.targets" && item.objectId === "isolated-target"));
});

test("rejects game entries without trusted City geometry", () => {
  const incompleteView: CityLayoutSdkViewV1 = { ...view, geometry: new Map([...view.geometry].filter(([ref]) => ref !== "g:spawn")) };
  const result = createMountedMiniGamePlan({ view: incompleteView, packageJson: JSON.stringify(game), mount, gameRef: mount.game, seed: 7 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "entry_geometry_unavailable");
});

test("runs a published drive mini-game through the City driving controller adapter", () => {
  const experience = { releaseId: "release-1", title: "One Target", game, mount };
  const plan = createCreatorMiniGamePlan(view, experience);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  let latest = null;
  const controller = new CreatorMiniGameRuntimeControllerV1(plan.value, snapshot => { latest = snapshot; });
  controller.fixedStep({ x: 4, y: 0, z: 0 });
  controller.fixedStep({ x: 5, y: 0, z: 0 });
  assert.equal(latest?.status, "success");
  assert.equal(latest?.completed, 1);
  assert.equal(latest?.total, 1);
  controller.dispose();
});

test("City driving adapter refuses published games requiring walking or non-zone triggers", () => {
  const walkOnly = { ...game, slots: { targets: { kind: "zone", min: 1, max: 2, requires: ["walk"] } } };
  const result = createCreatorMiniGamePlan(view, { releaseId: "release-1", title: "Walk", game: walkOnly, mount });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "creator_game_capability_unsupported");
});

// 飞行小游戏（2026-11-15 飞行管线）：同一套规则执行器，只把「进入/槽位需要哪种能力」
// 换成 fly；锚点在空域（y>0）。driving 的 drive 语义不变。
const airGame = { ...game, slots: { gates: { kind: "zone", min: 1, max: 2, requires: ["fly"] } }, rules: {
  counters: { passed: { initial: 0, max: 2 } }, nodes: [
    { id: "gate", on: { type: "zone.entered", slot: "gates" }, actions: [{ op: "counter.add", counter: "passed", amount: 1 }] },
  ],
} };
const airView: CityLayoutSdkViewV1 = {
  layout: { schemaVersion: 1, id: "fixture-air", coordinateSystem: "city-local-m-v1", anchors: [
    { id: "spawn-air", kind: "spawn", capabilities: ["fly"], geometryRef: "g:spawn-air" },
    { id: "gate-1", kind: "zone", capabilities: ["fly"], geometryRef: "g:gate-1" },
  ], links: [{ id: "air-link", fromAnchorId: "spawn-air", toAnchorId: "gate-1", capabilities: ["fly"] }] },
  geometry: new Map([
    ["g:spawn-air", { positionMeters: { x: 0, y: 40, z: 0 } }],
    ["g:gate-1", { positionMeters: { x: 80, y: 55, z: 0 }, activationRadiusMeters: 6 }],
  ]), roadSegments: [], preferredStartMeters: { x: 0, z: 0 }, seed: 7, worldRevision: "r1",
};
const airMount = { ...mount, mountId: "mounted-air", layout: { ...mount.layout, id: "fixture-air" }, game: { ...mount.game, id: airGame.id },
  entryAnchorId: "spawn-air", bindings: { gates: ["gate-1"] } };

test("flight mini-games plan against fly anchors and trigger on the aircraft's 3D position", () => {
  const plan = createMountedMiniGamePlan({ view: airView, packageJson: JSON.stringify(airGame), mount: airMount as any, gameRef: airMount.game as any, seed: 7, capability: "fly" });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.value.zones.gates.map(({ volume: _volume, ...zone }) => zone), [{ x: 80, y: 55, z: 0, radius: 6 }]);
  assert.equal(plan.value.zones.gates[0]?.volume?.geometry.kind, "sphere");
  let latest = null;
  const controller = new MountedMiniGameControllerV1(plan.value, snapshot => { latest = snapshot; });
  // 地面上掠过同一个 x/z 不算进闸：高度必须也进触发球。
  controller.fixedStep({ x: 80, y: 5, z: 0 });
  assert.equal(latest?.state.counters.passed ?? 0, 0);
  controller.fixedStep({ x: 80, y: 54, z: 0 });
  assert.equal(latest?.state.counters.passed, 1);
});

test("oriented flight gates score only when the aircraft crosses the ring aperture", () => {
  const orientedView: CityLayoutSdkViewV1 = {
    ...airView,
    geometry: new Map([...airView.geometry, ["g:gate-1", {
      positionMeters: { x: 80, y: 55, z: 0 }, activationRadiusMeters: 6, facingRadians: 0,
    }]]),
  };
  const plan = createMountedMiniGamePlan({ view: orientedView, packageJson: JSON.stringify(airGame), mount: airMount as any,
    gameRef: airMount.game as any, seed: 7, capability: "fly" });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const volume = plan.value.zones.gates[0]?.volume;
  assert.equal(volume?.id, "volume:gate-1");
  assert.equal(volume?.geometry.kind, "ring");
  let latest = null;
  const controller = new MountedMiniGameControllerV1(plan.value, snapshot => { latest = snapshot; });
  controller.fixedStep({ x: 80, y: 55, z: -10 });
  controller.fixedStep({ x: 80, y: 55, z: 10 });
  assert.equal(latest?.state.counters.passed, 1);
  const replay = new MountedMiniGameControllerV1(plan.value, () => {});
  replay.fixedStep({ x: 80, y: 55, z: -10 });
  replay.fixedStep({ x: 80, y: 55, z: 10 });
  assert.deepEqual(replay.snapshot.state, controller.snapshot.state);
  const rimController = new MountedMiniGameControllerV1(plan.value, () => {});
  rimController.fixedStep({ x: 80, y: 61.5, z: -10 });
  rimController.fixedStep({ x: 80, y: 61.5, z: 10 });
  assert.equal(rimController.snapshot.state.counters.passed ?? 0, 0);
});

test("a fly mini-game refuses an entry anchor that does not declare fly", () => {
  // 槽位本身合法（gate-1 有 fly），只有入口是 drive-only 的出生点 → 必须停在入口能力这一关，
  // 而不是让飞机从一个「不是为自己准备的」出生点起飞。
  const mixedView: CityLayoutSdkViewV1 = { ...airView, layout: { ...airView.layout, id: "fixture-mixed", anchors: [
    { id: "spawn-air", kind: "spawn", capabilities: ["fly"], geometryRef: "g:spawn-air" },
    { id: "spawn-ground", kind: "spawn", capabilities: ["drive"], geometryRef: "g:spawn-air" },
    { id: "gate-1", kind: "zone", capabilities: ["fly"], geometryRef: "g:gate-1" },
  ], links: [
    { id: "l-air", fromAnchorId: "spawn-air", toAnchorId: "gate-1", capabilities: ["fly"] },
  ] } };
  const plan = createMountedMiniGamePlan({ view: mixedView, packageJson: JSON.stringify(airGame),
    mount: { ...airMount, layout: { ...airMount.layout, id: "fixture-mixed" }, entryAnchorId: "spawn-ground" } as any,
    gameRef: airMount.game as any, seed: 7, capability: "fly" });
  assert.equal(plan.ok, false);
  // 两道闸：SDK 的 validateMount 先按游戏槽位能力拒绝（entry_capability_missing），
  // 规划层的 entry_capability_unsupported 是第二道（槽位能力与入口不一致时兜底）。
  if (!plan.ok) assert.ok(["entry_capability_missing", "entry_capability_unsupported"].includes(plan.diagnostics[0]?.code ?? ""),
    `unexpected diagnostic: ${plan.diagnostics[0]?.code}`);
});

test("creator plan keeps driving slots on drive and flight slots on fly", () => {
  const experience = (gamePack: typeof airGame, experienceMount: any) => ({ releaseId: "release-1", title: "飞行检查点",
    game: gamePack, mount: experienceMount, entryPositionWorld: { x: 0, z: 0 } } as any);
  const fly = createCreatorMiniGamePlan(airView, experience(airGame, airMount), { capability: "fly" });
  assert.equal(fly.ok, true);
  const driveOnFly = createCreatorMiniGamePlan(airView, experience(airGame, airMount));
  assert.equal(driveOnFly.ok, false);
  if (!driveOnFly.ok) assert.equal(driveOnFly.diagnostics[0]?.code, "creator_game_capability_unsupported");
});

// —— V3 S-6b 宿主复算轨迹（evidence.trace）——
// 与桌面 rule_replay.rs::tests / creator_playtest.rs::tests 逐字段对照：条目恒为
// {kind, slot, eventIndex, atTick} 四键（camelCase）；eventIndex 是槽位绑定内的 zone 序号
// （0 起，runtime.ts 的 counter.eqEventIndex 用它与计数器值比对——不是「第几次事件」，
// 宿主 trace_fits_bindings 也按 bindings[slot].len() 越界校验同一语义）；atTick 由
// runner 按步追加，天然非降序（宿主 parse_trace 的硬性要求）。
const raceGame = { schemaVersion: 1, id: "creator.checkpoint-race", rulesVersion: 1,
  slots: { points: { kind: "zone", min: 3, max: 8, requires: ["drive"] } },
  integerParameters: { timeLimitTicks: { min: 60, max: 36000, default: 2700 }, gateTarget: { min: 3, max: 8, default: 3 } },
  rules: {
    counters: { next: { initial: 0, max: { parameter: "gateTarget" } } },
    nodes: [
      { id: "start-timer", on: { type: "run.started" }, actions: [{ op: "timer.start", timerId: "timeout", durationTicks: { parameter: "timeLimitTicks" } }] },
      { id: "advance", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
      { id: "finish", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eq", counter: "next", value: { parameter: "gateTarget" } }], actions: [{ op: "run.finish", outcome: "success" }] },
      { id: "timeout", on: { type: "timer.expired", timerId: "timeout" }, actions: [{ op: "run.finish", outcome: "failure" }] },
    ],
  } };
const raceView: CityLayoutSdkViewV1 = {
  layout: { schemaVersion: 1, id: "fixture-race", coordinateSystem: "city-local-m-v1", anchors: [
    { id: "race-spawn", kind: "spawn", capabilities: ["drive"], geometryRef: "g:race-spawn" },
    { id: "gate-0", kind: "zone", capabilities: ["drive"], geometryRef: "g:gate-0" },
    { id: "gate-1", kind: "zone", capabilities: ["drive"], geometryRef: "g:gate-1" },
    { id: "gate-2", kind: "zone", capabilities: ["drive"], geometryRef: "g:gate-2" },
  ], links: [
    { id: "race-link-0", fromAnchorId: "race-spawn", toAnchorId: "gate-0", capabilities: ["drive"] },
    { id: "race-link-1", fromAnchorId: "gate-0", toAnchorId: "gate-1", capabilities: ["drive"] },
    { id: "race-link-2", fromAnchorId: "gate-1", toAnchorId: "gate-2", capabilities: ["drive"] },
  ] },
  geometry: new Map([
    ["g:race-spawn", { positionMeters: { x: 0, y: 0, z: 0 } }],
    ["g:gate-0", { positionMeters: { x: 10, y: 0, z: 0 }, activationRadiusMeters: 1 }],
    ["g:gate-1", { positionMeters: { x: 20, y: 0, z: 0 }, activationRadiusMeters: 1 }],
    ["g:gate-2", { positionMeters: { x: 30, y: 0, z: 0 }, activationRadiusMeters: 1 }],
  ]), roadSegments: [], preferredStartMeters: { x: 0, z: 0 }, seed: 7, worldRevision: "r1",
};
const raceMount = { schemaVersion: 1 as const, mountId: "mounted-race", layout: { kind: "city-layout" as const, id: "fixture-race", version: "1", digest: "r1" },
  game: { kind: "city-minigame" as const, id: "creator.checkpoint-race", version: "1", digest: "local-test" },
  entryAnchorId: "race-spawn", bindings: { points: ["gate-0", "gate-1", "gate-2"] }, parameterOverrides: {} };

function raceController(): MountedMiniGameControllerV1 {
  const plan = createMountedMiniGamePlan({ view: raceView, packageJson: JSON.stringify(raceGame), mount: raceMount, gameRef: raceMount.game, seed: 7 });
  if (!plan.ok) throw new Error(plan.diagnostics[0]?.code ?? "race-plan-invalid");
  return new MountedMiniGameControllerV1(plan.value, () => {});
}

test("consumed zone.entered events form a trace matching the host replay wire shape", () => {
  // 对照宿主 creator_playtest.rs::verified_when_three_gates_trace_matches_client_report
  // （gate_trace 助手的字面量形状）与 rule_replay.rs::three_gates_in_order_finish_success：
  // 三门顺序通过 → success + next=3，轨迹逐条等于宿主复算期望的投影。
  const controller = raceController();
  for (const position of [0, 10, 12, 20, 22, 30]) controller.fixedStep({ x: position, y: 0, z: 0 });
  assert.equal(controller.snapshot.status, "success");
  assert.equal(controller.snapshot.state.counters.next, 3);
  assert.equal(controller.snapshot.state.tick, 5);
  assert.deepEqual(controller.trace, [
    { kind: "zone.entered", slot: "points", eventIndex: 0, atTick: 1 },
    { kind: "zone.entered", slot: "points", eventIndex: 1, atTick: 3 },
    { kind: "zone.entered", slot: "points", eventIndex: 2, atTick: 5 },
  ]);
  const ticks = controller.trace.map(entry => entry.atTick);
  assert.deepEqual([...ticks].sort((a, b) => a - b), ticks);
});

test("trace records each gate's binding index, so out-of-order entries keep eqEventIndex semantics", () => {
  // 对照宿主 rule_replay.rs::out_of_order_gate_does_not_advance_until_its_index_matches：
  // 乱序门（eventIndex 与计数器不匹配）不推进计数器；index 归位后继续推进并定格 success。
  const controller = raceController();
  for (const position of [15, 30, 28, 20, 18, 10, 12, 20, 22, 30]) controller.fixedStep({ x: position, y: 0, z: 0 });
  assert.equal(controller.snapshot.status, "success");
  assert.equal(controller.snapshot.state.counters.next, 3);
  assert.deepEqual(controller.trace, [
    { kind: "zone.entered", slot: "points", eventIndex: 1, atTick: 1 },
    { kind: "zone.entered", slot: "points", eventIndex: 2, atTick: 1 },
    { kind: "zone.entered", slot: "points", eventIndex: 1, atTick: 3 },
    { kind: "zone.entered", slot: "points", eventIndex: 0, atTick: 5 },
    { kind: "zone.entered", slot: "points", eventIndex: 1, atTick: 7 },
    { kind: "zone.entered", slot: "points", eventIndex: 2, atTick: 9 },
  ]);
});

const timeoutGame = { schemaVersion: 1, id: "creator.timeout-walk", rulesVersion: 1,
  slots: { gates: { kind: "zone", min: 0, max: 2, requires: ["drive"] } },
  rules: {
    counters: { found: { initial: 0, max: 4 } },
    nodes: [
      { id: "start-timer", on: { type: "run.started" }, actions: [{ op: "timer.start", timerId: "timeout", durationTicks: 10 }] },
      { id: "collect", on: { type: "zone.entered", slot: "gates" }, actions: [{ op: "counter.add", counter: "found", amount: 1 }] },
      { id: "timeout", on: { type: "timer.expired", timerId: "timeout" }, actions: [{ op: "run.finish", outcome: "failure" }] },
    ],
  } };
const timeoutMount = { ...mount, mountId: "mounted-timeout", game: { ...mount.game, id: "creator.timeout-walk" }, entryAnchorId: "spawn", bindings: { gates: ["target"] } };

test("a timeout failure keeps the trace at the consumed prefix the host can replay", () => {
  // 对照宿主 rule_replay.rs::partial_gates_then_timeout_fail_with_matching_counters /
  // creator_playtest.rs::verified_when_timeout_failure_matches_partial_trace：轨迹耗尽后
  // 剩余计时器触发 failure，客户端 outcome/counters 与轨迹复算逐项一致。
  const plan = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(timeoutGame), mount: timeoutMount, gameRef: timeoutMount.game, seed: 7 });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const controller = new MountedMiniGameControllerV1(plan.value, () => {});
  controller.fixedStep({ x: 0, y: 0, z: 0 });
  controller.fixedStep({ x: 10, y: 0, z: 0 });
  for (let index = 0; index < 9; index += 1) controller.fixedStep({ x: 12, y: 0, z: 0 });
  assert.equal(controller.snapshot.status, "failure");
  assert.equal(controller.snapshot.state.tick, 10);
  assert.equal(controller.snapshot.state.counters.found, 1);
  assert.deepEqual(controller.trace, [{ kind: "zone.entered", slot: "gates", eventIndex: 0, atTick: 1 }]);
});

const endlessGame = { schemaVersion: 1, id: "creator.endless-walk", rulesVersion: 1,
  slots: { gates: { kind: "zone", min: 0, max: 2, requires: ["drive"] } },
  rules: { counters: { found: { initial: 0, max: 1000 } }, nodes: [
    { id: "collect", on: { type: "zone.entered", slot: "gates" }, actions: [{ op: "counter.add", counter: "found", amount: 1 }] } ] } };
const endlessMount = { ...mount, mountId: "mounted-endless", game: { ...mount.game, id: "creator.endless-walk" }, entryAnchorId: "spawn", bindings: { gates: ["target"] } };

function endlessController(): MountedMiniGameControllerV1 {
  const plan = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(endlessGame), mount: endlessMount, gameRef: endlessMount.game, seed: 7 });
  if (!plan.ok) throw new Error(plan.diagnostics[0]?.code ?? "endless-plan-invalid");
  const controller = new MountedMiniGameControllerV1(plan.value, () => {});
  controller.fixedStep({ x: 0, y: 0, z: 0 });
  return controller;
}

test("trace stays bounded at 64 entries, dropping the oldest when the run keeps going", () => {
  // FIFO 丢最旧（与宿主 ≤64 对齐）：计数器仍如实反映全部 70 次进入，而被截掉的窗口外
  // 事件让宿主复算无法重放出截断前的状态——这类终局宿主会如实记 hostDisagreement
  // （审计语义，见 mountedMiniGame.ts 的记录层注释），测试断言的是记录层的窗口语义本身。
  const controller = endlessController();
  for (let index = 0; index < 70; index += 1) { controller.fixedStep({ x: 10, y: 0, z: 0 }); controller.fixedStep({ x: 13, y: 0, z: 0 }); }
  assert.equal(controller.snapshot.state.counters.found, 70);
  assert.equal(controller.trace.length, 64);
  const ticks = controller.trace.map(entry => entry.atTick);
  assert.equal(ticks[0], 13);
  assert.equal(ticks[ticks.length - 1], 139);
  assert.deepEqual([...ticks].sort((a, b) => a - b), ticks);
  assert.ok(controller.trace.every(entry => entry.eventIndex === 0 && entry.slot === "gates" && entry.kind === "zone.entered"));
});

test("visualEvidence carries trace as the optional 13th key and omits it when no events were consumed", () => {
  // 键集与宿主 creator_playtest.rs::validate_playtest_evidence 的 12/13 键白名单逐项对照；
  // 无事件 → 12 键现状不变。轨迹内容与 runner 终态（counters/outcome/tick）一致。
  const plan = createCreatorMiniGamePlan(raceView, { releaseId: "release-race", title: "Race", game: raceGame, mount: raceMount });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const controller = new CreatorMiniGameRuntimeControllerV1(plan.value, () => {});
  const empty = controller.visualEvidence("release-race", 1, "digest");
  assert.deepEqual(Object.keys(empty).sort(), ["counters", "game", "outcome", "projectRevision", "reasonCode", "releaseId",
    "runtimeVersion", "schemaVersion", "seed", "snapshotDigest", "tick", "worldRevision"]);
  assert.equal("trace" in empty, false);
  // Creator 控制器收世界单位（1 单位 = 2 米，worldScale.ts）：0/5/6/10/11/15 单位 = 0/10/12/20/22/30 米。
  for (const position of [0, 5, 6, 10, 11, 15]) controller.fixedStep({ x: position, y: 0, z: 0 });
  const evidence = controller.visualEvidence("release-race", 1, "digest");
  assert.deepEqual(Object.keys(evidence).sort(), ["counters", "game", "outcome", "projectRevision", "reasonCode", "releaseId",
    "runtimeVersion", "schemaVersion", "seed", "snapshotDigest", "tick", "trace", "worldRevision"]);
  assert.deepEqual(evidence.trace, [
    { kind: "zone.entered", slot: "points", eventIndex: 0, atTick: 1 },
    { kind: "zone.entered", slot: "points", eventIndex: 1, atTick: 3 },
    { kind: "zone.entered", slot: "points", eventIndex: 2, atTick: 5 },
  ]);
  assert.ok(evidence.trace!.length > 0 && evidence.trace!.length <= 64);
  assert.ok(evidence.trace!.every(entry => Object.keys(entry).sort().join(",") === "atTick,eventIndex,kind,slot"
    && entry.kind === "zone.entered" && entry.slot === "points"));
  assert.equal(evidence.outcome, "success");
  assert.deepEqual(evidence.counters, { next: 3 });
  assert.equal(evidence.tick, 5);
});

const LONG_SLOT = `z${"s".repeat(127)}`;
const longSlotGame = { schemaVersion: 1, id: "creator.long-slot", rulesVersion: 1,
  slots: { [LONG_SLOT]: { kind: "zone", min: 0, max: 2, requires: ["drive"] } },
  rules: { counters: { found: { initial: 0, max: 1000 } }, nodes: [
    { id: "collect", on: { type: "zone.entered", slot: LONG_SLOT }, actions: [{ op: "counter.add", counter: "found", amount: 1 }] } ] } };
const longSlotMount = { ...mount, mountId: "mounted-long-slot", game: { ...mount.game, id: "creator.long-slot" }, entryAnchorId: "spawn", bindings: { [LONG_SLOT]: ["target"] } };

test("an over-budget trace degrades honestly: oldest entries drop before the whole key is omitted", () => {
  // 字节护栏（creatorMiniGame.ts）：宿主整份证据预算 8 KiB，这里按 7 KiB 收口——
  // 长槽位名 × 满窗口会超限，先丢最旧条目（余下仍非降序），仍超限才整体省略 trace。
  const plan = createCreatorMiniGamePlan(view, { releaseId: "release-long", title: "Long", game: longSlotGame, mount: longSlotMount });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const controller = new CreatorMiniGameRuntimeControllerV1(plan.value, () => {});
  controller.fixedStep({ x: 0, y: 0, z: 0 });
  // 世界单位 5 / 6.5 = 10 / 13 米：每次折返触发一次 zone.entered（view 的 target 在 10 米、半径 1）。
  for (let index = 0; index < 70; index += 1) { controller.fixedStep({ x: 5, y: 0, z: 0 }); controller.fixedStep({ x: 6.5, y: 0, z: 0 }); }
  const evidence = controller.visualEvidence("release-long", 1, "digest");
  assert.ok(JSON.stringify(evidence).length <= 7 * 1024);
  assert.ok(evidence.trace && evidence.trace.length > 0 && evidence.trace.length < 64);
  // 仅 FIFO 时窗口首条是 tick 13（70 条丢前 6）；字节护栏再丢最旧 → 首条必晚于 13，
  // 这行断言排除「护栏没生效、只靠 FIFO 碰巧 <64」的 vacuous 通过。
  assert.ok(evidence.trace![0]!.atTick > 13);
  const ticks = evidence.trace!.map(entry => entry.atTick);
  assert.deepEqual([...ticks].sort((a, b) => a - b), ticks);
  assert.ok(evidence.trace!.every(entry => entry.slot === LONG_SLOT && Object.keys(entry).length === 4));
});
