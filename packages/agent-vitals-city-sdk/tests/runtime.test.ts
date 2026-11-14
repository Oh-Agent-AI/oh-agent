import test from "node:test";
import assert from "node:assert/strict";
import { compileRules, createRun, runHeadless } from "../src/runtime";
import { parseMiniGamePackJson, validateMiniGamePack } from "../src/content";
import { validateCityLayoutScope, validateCityLayoutSnapshot, validateCityLayoutSnapshotV2, validateCitySkinPack, validateMount } from "../src/validate";
import type { CityGameMountV1, CityLayoutV1, MiniGamePackV1 } from "../src/types";

const layout: CityLayoutV1 = { schemaVersion: 1, id: "fixture", coordinateSystem: "city-local-m-v1", anchors: [
  { id: "start", kind: "spawn", capabilities: ["drive"], geometryRef: "g:start" },
  { id: "cp-1", kind: "zone", capabilities: ["drive"], geometryRef: "g:1" },
  { id: "cp-2", kind: "zone", capabilities: ["drive"], geometryRef: "g:2" },
], links: [
  { id: "link-start-1", fromAnchorId: "start", toAnchorId: "cp-1", capabilities: ["drive"] },
  { id: "link-1-2", fromAnchorId: "cp-1", toAnchorId: "cp-2", capabilities: ["drive"] },
] };
const game: MiniGamePackV1 = {
  schemaVersion: 1, id: "checkpoint-race", rulesVersion: 1,
  slots: { points: { kind: "zone", min: 2, max: 8, requires: ["drive"] } },
  rules: { counters: { next: { initial: 0, max: 2 } }, nodes: [
    { id: "advance", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
    { id: "finish", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eq", counter: "next", value: 2 }], actions: [{ op: "run.finish", outcome: "success" }] },
  ] },
};

test("validates and freezes host-captured City layout snapshots", () => {
  const result = validateCityLayoutSnapshot({ schemaVersion: 1, worldRevision: "world-r7", seed: 7, layout });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.worldRevision, "world-r7");
    assert.equal(Object.isFrozen(result.value), true);
    assert.equal(Object.isFrozen(result.value.layout.anchors), true);
    assert.equal(Object.isFrozen(result.value.layout.links), true);
  }
  assert.equal(validateCityLayoutSnapshot({ schemaVersion: 1, worldRevision: "", seed: 7, layout }).ok, false);
  assert.equal(validateCityLayoutSnapshot({ schemaVersion: 1, worldRevision: "r", seed: -1, layout }).ok, false);
});
test("multi-City layout scope rejects cross-City and stale bindings even with matching world revisions", () => {
  const snapshot = { schemaVersion: 2, cityId: "city-desert", cityRevision: 3, worldRevision: "world-r7", seed: 7, layout };
  const city = { cityId: "city-desert", revision: 3, seed: 7 };
  const result = validateCityLayoutScope(snapshot, city);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(Object.isFrozen(result.value.layout.anchors), true);
  assert.equal(validateCityLayoutScope(snapshot, { ...city, cityId: "city-miami" }).ok, false);
  assert.equal(validateCityLayoutScope(snapshot, { ...city, revision: 4 }).ok, false);
  assert.equal(validateCityLayoutScope(snapshot, { ...city, seed: 8 }).ok, false);
  assert.equal(validateCityLayoutSnapshotV2({ ...snapshot, cityId: "../miami" }).ok, false);
  assert.equal(validateCityLayoutSnapshotV2({ ...snapshot, extra: true }).ok, false);
  assert.equal(validateCityLayoutSnapshotV2({ schemaVersion: 1, worldRevision: "world-r7", seed: 7, layout }).ok, false);
});
const mount: CityGameMountV1 = { schemaVersion: 1, mountId: "race-1", layout: { kind: "city-layout", id: layout.id, version: "1", digest: "fixture" }, game: { kind: "city-minigame", id: game.id, version: "1", digest: "fixture" }, entryAnchorId: "start", bindings: { points: ["cp-1", "cp-2"] }, parameterOverrides: {} };

test("validates a mounted game against stable layout anchors", () => {
  assert.equal(validateMount({ layout, game, mount }).ok, true);
  const invalid = validateMount({ layout, game, mount: { ...mount, bindings: { points: ["missing"] } } });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.ok(invalid.diagnostics.some(item => item.code === "anchor_not_found"));
  assert.equal(validateMount({ layout, game, mount: null }).ok, false);
  assert.equal(validateMount(null as never).ok, false);
  assert.equal(validateMount({ layout, game, mount: { ...mount, hostMethod: "readFile" } }).ok, false);
  const mutableMount = { ...mount, bindings: { ...mount.bindings, points: [...mount.bindings.points!] } };
  const resolved = validateMount({ layout, game, mount: mutableMount });
  assert.equal(resolved.ok, true);
  mutableMount.bindings.points[0] = "missing";
  if (resolved.ok) assert.equal(resolved.value.mount.bindings.points?.[0], "cp-1");
});

test("mount validation rejects drive anchors disconnected from the entry when topology is present", () => {
  const connectedLayout: CityLayoutV1 = { ...layout, links: [
    { id: "link-start-1", fromAnchorId: "start", toAnchorId: "cp-1", capabilities: ["drive"] },
  ] };
  const result = validateMount({ layout: connectedLayout, game, mount });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.diagnostics.some(item => item.code === "anchor_unreachable" && item.objectId === "cp-2"));
  const malformed = validateMount({ layout: { ...connectedLayout, links: [{ id: "bad-link", fromAnchorId: "missing", toAnchorId: "cp-1", capabilities: ["drive"] }] }, game, mount });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.ok(malformed.diagnostics.some(item => item.code === "layout_link_anchor_not_found"));
});

test("runs checkpoint race deterministically and rejects out-of-order checkpoints", () => {
  const compiled = compileRules(game);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const run = createRun({ rules: compiled.value, mount, seed: 1 });
  assert.equal(run.step(0).ok, true);
  const skipped = run.step(1, [{ type: "zone.entered", tick: 1, slot: "points", index: 1 }]);
  assert.equal(skipped.ok, true);
  assert.equal(run.snapshot().counters.next, 0);
  run.step(2, [{ type: "zone.entered", tick: 2, slot: "points", index: 0 }]);
  const finish = run.step(3, [{ type: "zone.entered", tick: 3, slot: "points", index: 1 }]);
  assert.equal(finish.ok, true);
  assert.equal(run.snapshot().outcome, "success");
});

test("enforces consecutive ticks and stops idempotently", () => {
  const compiled = compileRules(game);
  assert.ok(compiled.ok);
  if (!compiled.ok) return;
  const run = createRun({ rules: compiled.value, mount, seed: 2 });
  const gap = run.step(1);
  assert.equal(gap.ok, false);
  run.stop(); run.stop();
  assert.equal(run.step(0).ok, false);
});

test("produces repeatable headless evidence and reports expectation failures", () => {
  const input = { layout, game, mount, seed: 42, trace: [
    { tick: 0 },
    { tick: 1, inputs: [{ type: "zone.entered" as const, tick: 1, slot: "points", index: 0 }] },
    { tick: 2, inputs: [{ type: "zone.entered" as const, tick: 2, slot: "points", index: 1 }] },
  ], expected: { outcome: "success" as const, counters: { next: 2 } } };
  const first = runHeadless(input);
  const second = runHeadless(input);
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.value.passed, true);
  const failed = runHeadless({ ...input, expected: { outcome: "failure" as const } });
  assert.equal(failed.ok, true);
  if (failed.ok) {
    assert.equal(failed.value.passed, false);
    assert.equal(failed.value.failures[0]?.code, "playtest_expectation_failed");
  }
  assert.equal(runHeadless({ ...input, trace: [] }).ok, false);
});

test("rolls back a failed rule step so snapshots never expose partial actions", () => {
  const invalidAtRuntime = { ...game, rules: { counters: { full: { initial: 0, max: 0 } }, nodes: [
    { id: "overflow", on: { type: "run.started" as const }, actions: [{ op: "counter.add" as const, counter: "full", amount: 1 }] },
  ] } };
  const compiled = compileRules(invalidAtRuntime);
  assert.ok(compiled.ok);
  if (!compiled.ok) return;
  const run = createRun({ rules: compiled.value, mount, seed: 1 });
  assert.equal(run.step(0).ok, false);
  assert.deepEqual(run.snapshot(), { tick: -1, counters: { full: 0 }, outcome: null, hints: [] });
  assert.equal(run.step(0).ok, false);
});

test("stops actions immediately after a terminal rule action", () => {
  const terminalPack = { ...game, rules: { counters: { afterFinish: { initial: 0, max: 1 } }, nodes: [
    { id: "finish-first", on: { type: "run.started" as const }, actions: [
      { op: "run.finish" as const, outcome: "success" as const },
      { op: "counter.add" as const, counter: "afterFinish", amount: 1 },
    ] },
  ] } };
  const compiled = compileRules(terminalPack);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const run = createRun({ rules: compiled.value, mount, seed: 1 });
  const stepped = run.step(0);
  assert.equal(stepped.ok, true);
  assert.equal(run.snapshot().outcome, "success");
  assert.equal(run.snapshot().counters.afterFinish, 0);
});

test("parses data-only content and rejects executable or unsupported operations", () => {
  assert.equal(parseMiniGamePackJson(JSON.stringify(game)).ok, true);
  assert.equal(parseMiniGamePackJson("{").ok, false);
  const executable = { ...game, script: "fetch('https://example.invalid')" };
  assert.equal(validateMiniGamePack(executable).ok, false);
  const unsupported = structuredClone(game) as MiniGamePackV1;
  (unsupported.rules.nodes[0]!.actions as unknown[]).push({ op: "host.call", method: "readFile" });
  const compiled = compileRules(unsupported);
  assert.equal(compiled.ok, false);
  if (!compiled.ok) assert.ok(compiled.diagnostics.some(item => item.code === "rule_operation_unsupported"));
});

test("does not freeze caller-owned nested timer parameter input", () => {
  const source = { schemaVersion: 1, id: "timer-copy", rulesVersion: 1, slots: {}, integerParameters: { duration: { min: 1, max: 10, default: 3 } }, rules: {
    counters: {}, nodes: [{ id: "timer", on: { type: "run.started" }, actions: [{ op: "timer.start", timerId: "clock", durationTicks: { parameter: "duration" } }] }],
  } };
  const result = validateMiniGamePack(source);
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(source.rules.nodes[0]!.actions[0]!.durationTicks), false);
});

test("validates data-only City skins against registered visuals and geography", () => {
  const source = { schemaVersion: 1, id: "desert-evening", renderContract: "city-render-v1", compatibleGeographies: ["arid-dunes-v1"], visuals: { themeId: "desert" } };
  const validated = validateCitySkinPack(source);
  assert.equal(validated.ok, true);
  assert.equal(Object.isFrozen(source), false);
  if (validated.ok) assert.equal(Object.isFrozen(validated.value.compatibleGeographies), true);
  assert.equal(validateCitySkinPack({ ...source, physics: { friction: 0 } }).ok, false);
  assert.equal(validateCitySkinPack({ ...source, compatibleGeographies: ["coastal-islands-v1", "coastal-islands-v1"] }).ok, false);
});

test("caps per-step inputs and retained hints", () => {
  const hintPack: MiniGamePackV1 = { ...game, rules: { counters: {}, nodes: [
    { id: "hints", on: { type: "run.started" }, actions: Array.from({ length: 16 }, (_, i) => ({ op: "hud.hint" as const, text: `hint-${i}` })) },
  ] } };
  const compiled = compileRules(hintPack);
  assert.ok(compiled.ok);
  if (!compiled.ok) return;
  const run = createRun({ rules: compiled.value, mount, seed: 0 });
  assert.equal(run.step(0).ok, true);
  assert.equal(run.snapshot().hints.length, 16);
  const excessiveInputs = Array.from({ length: 65 }, () => ({ type: "zone.entered" as const, tick: 1, slot: "points", index: 0 }));
  const result = run.step(1, excessiveInputs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "rule_budget_exceeded");
});
