import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  PHASE_FIELD_MAX_MAPPING, prepareCoreMigration, reprojectCoreMigration, resolveCoreMigration,
  prepareSpaceFold, reprojectSpaceFold, resolveSpaceFold,
  type CoreMigrationIntent, type CoreMigrationRequest, type CoreMigrationState,
  type SpaceFoldIntent, type SpaceFoldRequest, type SpaceFoldState, type FoldPair,
} from "../apps/agent-city/ui/src/game/mecha/skillPhaseField.ts";

const pt = (x: number, y: number) => ({ x, y });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const v of Object.values(value)) freeze(v); }
  return value;
}
function world(): SpaceFoldState {
  return { version: 1, width: 10, height: 8, round: 3, active: true, phaseId: "phase1", actorId: "boss", blocked: [],
    units: [
      { id: "boss", cell: pt(0, 0), width: 2, height: 2, hp: 20 },
      { id: "a", cell: pt(4, 2), width: 1, height: 1, hp: 5 },
      { id: "b", cell: pt(5, 2), width: 1, height: 1, hp: 5 },
      { id: "safe", cell: pt(8, 6), width: 1, height: 1, hp: 5 },
    ], resolvedFoldIds: [] };
}
function cores(): CoreMigrationState {
  const { resolvedFoldIds: _, ...base } = world();
  return { ...base, maxHp: 20, currentCoreId: "alpha", cores: [
    { id: "alpha", cell: pt(0, 0), alive: true }, { id: "beta", cell: pt(1, 1), alive: true },
  ], skills: ["old_skill"], migratedIds: [] };
}
const coreReq = (): CoreMigrationRequest => ({ skillId: "core_migration", migrationId: "m1", threshold: 10, targetCoreId: "beta", nextPhaseId: "phase2", nextSkills: ["ring_pierce", "smash"] });
const foldReq = (): SpaceFoldRequest => ({ skillId: "space_fold", actionId: "f1", mapping: [
  { from: pt(5, 2), to: pt(4, 2) }, { from: pt(4, 2), to: pt(5, 2) },
] });
function coreIntent(s = cores(), r = coreReq()): CoreMigrationIntent {
  const p = prepareCoreMigration(s, r); assert.equal(p.status, "planned", JSON.stringify(p));
  if (p.status !== "planned") throw Error(); return p.intent;
}
function foldIntent(s = world(), r = foldReq()): SpaceFoldIntent {
  const p = prepareSpaceFold(s, r); assert.equal(p.status, "planned", JSON.stringify(p));
  if (p.status !== "planned") throw Error(); return p.intent;
}
const reason = (p: { status: string; reason?: string }) => { assert.equal(p.status, "void"); return p.reason; };

test("L9 declares threshold, fixed cores and skill set before crossing, including exact boundary", () => {
  const s = cores(), r = coreReq(), i = coreIntent(s, r);
  assert.deepEqual(i, { version: 1, skillId: "core_migration", round: 3, actorId: "boss", actorCell: pt(0, 0), phaseId: "phase1",
    sourceCoreId: "alpha", sourceCoreCell: pt(0, 0), targetCoreId: "beta", targetCoreCell: pt(1, 1), migrationId: "m1",
    threshold: 10, maxHp: 20, previousSkills: ["old_skill"], nextPhaseId: "phase2", nextSkills: ["ring_pierce", "smash"] });
  assert.equal(reason(reprojectCoreMigration(s, i)), "threshold_not_reached");
  assert.equal(reason(resolveCoreMigration(s, i)), "threshold_not_reached");
  s.units[0]!.hp = 11; assert.equal(reason(reprojectCoreMigration(s, i)), "threshold_not_reached");
  s.units[0]!.hp = 10;
  const preview = reprojectCoreMigration(s, i);
  assert.deepEqual(preview, { status: "reprojected", fromCoreId: "alpha", toCoreId: "beta", fromPhaseId: "phase1", toPhaseId: "phase2", nextSkills: ["ring_pierce", "smash"] });
  const result = resolveCoreMigration(s, i, copy(preview)); assert.equal(result.status, "resolved");
  if (result.status !== "resolved") throw Error();
  assert.deepEqual(result.events, [{ type: "core_migrated", migrationId: "m1", fromCoreId: "alpha", toCoreId: "beta", fromPhaseId: "phase1", toPhaseId: "phase2", skills: ["ring_pierce", "smash"] }]);
  assert.equal(result.state.currentCoreId, "beta"); assert.equal(result.state.phaseId, "phase2");
  assert.deepEqual(result.state.skills, r.nextSkills); assert.deepEqual(result.state.migratedIds, ["m1"]);
  assert.equal(s.phaseId, "phase1"); assert.deepEqual(s.migratedIds, []);
  assert.equal(reason(resolveCoreMigration(result.state, i)), "already_resolved");
  assert.equal(reason(prepareCoreMigration(result.state, r)), "already_resolved");
});

test("L9 voids death, expiry, changed binding/phase and stale preview without migrating", () => {
  const cases: Array<[string, (s: CoreMigrationState) => void, string]> = [
    ["actor died", s => { s.units[0]!.hp = 0; }, "actor_unavailable"],
    ["inactive/outcome", s => { s.active = false; }, "inactive"],
    ["round", s => { s.round++; }, "round_changed"],
    ["phase", s => { s.phaseId = "phase2"; }, "phase_changed"],
    ["current core", s => { s.currentCoreId = "beta"; }, "phase_changed"],
    ["skill set", s => { s.skills = ["other"]; }, "phase_changed"],
    ["max hp", s => { s.maxHp = 21; }, "phase_changed"],
    ["source dead", s => { s.cores[0]!.alive = false; }, "source_unavailable"],
    ["target dead", s => { s.cores[1]!.alive = false; }, "target_unavailable"],
    ["target moved", s => { s.cores[1]!.cell = pt(1, 0); }, "target_changed"],
    ["actor moved", s => { s.units[0]!.cell = pt(1, 1); s.cores[0]!.cell = pt(1, 1); s.cores[1]!.cell = pt(2, 2); }, "actor_changed"],
  ];
  for (const [name, change, expected] of cases) {
    const s = cores(), i = coreIntent(s); s.units[0]!.hp = 9; change(s); const before = copy(s);
    const result = resolveCoreMigration(s, i); assert.equal(reason(result), expected, name); assert.deepEqual(result.events, [], name); assert.deepEqual(s, before, name);
  }
  const s = cores(), i = coreIntent(s); s.units[0]!.hp = 9;
  const p = reprojectCoreMigration(s, i); assert.equal(p.status, "reprojected");
  if (p.status !== "reprojected") throw Error();
  assert.equal(reason(resolveCoreMigration(s, i, { ...p, toCoreId: "alpha" })), "stale_projection");
  assert.equal(reason(resolveCoreMigration(s, i, null as any)), "stale_projection");
});

test("L9 rejects late/illegal declarations, duplicate IDs, dead target, malformed JSON", () => {
  const s = cores();
  for (const bad of [
    { ...coreReq(), threshold: 0 }, { ...coreReq(), threshold: 20 }, { ...coreReq(), threshold: NaN },
    { ...coreReq(), nextPhaseId: "phase1" }, { ...coreReq(), nextSkills: [] },
    { ...coreReq(), nextSkills: ["a", "a"] }, { ...coreReq(), nextSkills: ["eval()"] },
    { ...coreReq(), nextSkills: Array(1) as string[] },
    { ...coreReq(), targetCoreId: "alpha" }, { ...coreReq(), migrationId: "" },
  ]) assert.equal(prepareCoreMigration(s, bad).status, "void");
  s.units[0]!.hp = 10; assert.equal(reason(prepareCoreMigration(s, coreReq())), "threshold_already_reached");
  s.units[0]!.hp = 20; s.cores[1]!.alive = false; assert.equal(reason(prepareCoreMigration(s, coreReq())), "target_unavailable");
  s.cores[1]!.alive = true; const i = coreIntent(s); s.units[0]!.hp = 9;
  for (const bad of [null, { ...i, version: 2 }, { ...i, nextSkills: null }, { ...i, targetCoreCell: null }, { ...i, threshold: 1.2 }])
    assert.equal(reason(reprojectCoreMigration(s, bad as any)), "invalid_intent");
  s.cores[1]!.cell = pt(9, 7); assert.equal(reason(reprojectCoreMigration(s, i)), "invalid_state");
});

test("L10 canonical mapping, simultaneous swap, stable ordered events and no undeclared changes", () => {
  const s = world(), r = foldReq(), i = foldIntent(s, r);
  assert.deepEqual(i.mapping, [{ from: pt(4, 2), to: pt(5, 2) }, { from: pt(5, 2), to: pt(4, 2) }]);
  assert.deepEqual(i.moves, [
    { unitId: "a", from: pt(4, 2), to: pt(5, 2), width: 1, height: 1 },
    { unitId: "b", from: pt(5, 2), to: pt(4, 2), width: 1, height: 1 },
  ]);
  const reversed = copy(s); reversed.units.reverse();
  assert.deepEqual(foldIntent(reversed, { ...r, mapping: [...r.mapping].reverse() }), i);
  const preview = reprojectSpaceFold(s, i), actual = resolveSpaceFold(s, i, copy(preview));
  assert.equal(actual.status, "resolved"); if (actual.status !== "resolved") throw Error();
  assert.deepEqual(actual.events, [
    { type: "space_fold_applied", actionId: "f1", mapping: i.mapping },
    { type: "space_fold_move", actionId: "f1", unitId: "a", from: pt(4, 2), to: pt(5, 2) },
    { type: "space_fold_move", actionId: "f1", unitId: "b", from: pt(5, 2), to: pt(4, 2) },
  ]);
  assert.deepEqual(actual.state.units.map(u => [u.id, u.cell]), [["boss", pt(0, 0)], ["a", pt(5, 2)], ["b", pt(4, 2)], ["safe", pt(8, 6)]]);
  assert.deepEqual(actual.state.resolvedFoldIds, ["f1"]);
  assert.equal(reason(resolveSpaceFold(actual.state, i)), "already_resolved");
});

test("L10 preserves 2x2 footprints, rejects partial, rotated and blocked mappings", () => {
  const s = world(); s.units = [s.units[0]!, { id: "large", cell: pt(4, 2), width: 2, height: 2, hp: 5 }];
  const mapping: FoldPair[] = [];
  for (let y = 2; y <= 3; y++) for (let x = 4; x <= 5; x++) {
    mapping.push({ from: pt(x, y), to: pt(x + 3, y) }, { from: pt(x + 3, y), to: pt(x, y) });
  }
  const r: SpaceFoldRequest = { skillId: "space_fold", actionId: "large", mapping };
  const i = foldIntent(s, r);
  assert.deepEqual(i.moves, [{ unitId: "large", from: pt(4, 2), to: pt(7, 2), width: 2, height: 2 }]);
  const result = resolveSpaceFold(s, i); assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.deepEqual(result.state.units[1]!.cell, pt(7, 2));
  assert.equal(reason(prepareSpaceFold(s, { ...r, mapping: [{ from: pt(4, 2), to: pt(7, 2) }, { from: pt(7, 2), to: pt(4, 2) }] })), "partial_footprint");
  const rotated = copy(r); [rotated.mapping[0]!.to, rotated.mapping[2]!.to] = [rotated.mapping[2]!.to, rotated.mapping[0]!.to];
  assert.equal(reason(prepareSpaceFold(s, rotated)), "distorted_footprint");
  s.blocked.push(pt(8, 3)); assert.equal(reason(reprojectSpaceFold(s, i)), "blocked_destination");
  assert.equal(reason(resolveSpaceFold(s, i)), "blocked_destination");
});

test("L10 refuses retargeting or changed membership even if declared cells stay identical", () => {
  const cases: Array<[string, (s: SpaceFoldState) => void, string]> = [
    ["target escaped", s => { s.units[1]!.cell = pt(4, 3); }, "target_changed"],
    ["target died", s => { s.units[1]!.hp = 0; }, "target_changed"],
    ["target replaced", s => { s.units[1]!.id = "replacement"; }, "target_changed"],
    ["new target", s => { s.units[1]!.cell = pt(4, 3); s.units[3]!.cell = pt(4, 2); }, "target_changed"],
    ["actor moved", s => { s.units[0]!.cell = pt(1, 0); }, "actor_changed"],
    ["actor died", s => { s.units[0]!.hp = 0; }, "actor_unavailable"],
    ["phase", s => { s.phaseId = "phase2"; }, "phase_changed"],
    ["round", s => { s.round++; }, "round_changed"],
    ["terminal or deployment", s => { s.active = false; }, "inactive"],
  ];
  for (const [name, change, expected] of cases) {
    const s = world(), i = foldIntent(s); change(s); const before = copy(s), out = resolveSpaceFold(s, i);
    assert.equal(reason(out), expected, name); assert.deepEqual(out.events, [], name); assert.deepEqual(s, before, name);
  }
});

test("L10 rejects non-permutations, duplicates, bounds, stale and malformed projections", () => {
  const s = world(), r = foldReq(), i = foldIntent(s, r);
  for (const mapping of [
    [], [{ from: pt(1, 1), to: pt(1, 1) }],
    [{ from: pt(1, 1), to: pt(2, 1) }, { from: pt(1, 1), to: pt(1, 1) }],
    [{ from: pt(1, 1), to: pt(2, 1) }, { from: pt(2, 1), to: pt(2, 1) }],
    [{ from: pt(1, 1), to: pt(2, 1) }, { from: pt(2, 1), to: pt(3, 1) }],
    [{ from: pt(9, 7), to: pt(10, 7) }, { from: pt(10, 7), to: pt(9, 7) }],
    [{ from: pt(1, 1), to: pt(1.5, 1) }, { from: pt(1.5, 1), to: pt(1, 1) }],
    Array.from({ length: PHASE_FIELD_MAX_MAPPING + 1 }, (_, n) => ({ from: pt(n % 10, Math.floor(n / 10)), to: pt(n % 10, Math.floor(n / 10)) })),
  ]) assert.equal(reason(prepareSpaceFold(s, { ...r, mapping })), "invalid_mapping");
  for (const invalid of [null, { ...i, version: 2 }, { ...i, moves: null }, { ...i, mapping: [...i.mapping].reverse() }, { ...i, moves: [{ ...i.moves[0], from: null }] }])
    assert.equal(reason(reprojectSpaceFold(s, invalid as any)), "invalid_intent");
  const p = reprojectSpaceFold(s, i); assert.equal(p.status, "reprojected"); if (p.status !== "reprojected") throw Error();
  const altered = copy(p); altered.moves[0]!.to.x++;
  assert.equal(reason(resolveSpaceFold(s, i, altered)), "stale_projection");
  assert.equal(reason(resolveSpaceFold(s, i, { ...p, mapping: [null] } as any)), "stale_projection");
  assert.equal(reason(resolveSpaceFold(s, i, null as any)), "stale_projection");
});

test("both rules are pure, deterministic, serializable and returned successful data does not alias input", () => {
  const c = cores(), cr = coreReq(), ci = coreIntent(c, cr); c.units[0]!.hp = 9;
  const f = world(), fr = foldReq(), fi = foldIntent(f, fr);
  const before = JSON.stringify({ c, cr, ci, f, fr, fi });
  freeze(c); freeze(cr); freeze(ci); freeze(f); freeze(fr); freeze(fi);
  const cp = reprojectCoreMigration(c, ci), fp = reprojectSpaceFold(f, fi);
  const ca = resolveCoreMigration(c, ci, cp), fa = resolveSpaceFold(f, fi, fp);
  for (let n = 0; n < 3; n++) {
    assert.deepEqual(reprojectCoreMigration(copy(c), copy(ci)), cp);
    assert.deepEqual(resolveCoreMigration(copy(c), copy(ci), copy(cp)), ca);
    assert.deepEqual(reprojectSpaceFold(copy(f), copy(fi)), fp);
    assert.deepEqual(resolveSpaceFold(copy(f), copy(fi), copy(fp)), fa);
    assert.deepEqual(prepareSpaceFold(f, fr), { status: "planned", intent: fi });
  }
  assert.equal(JSON.stringify({ c, cr, ci, f, fr, fi }), before);
  if (ca.status !== "resolved" || fa.status !== "resolved") throw Error();
  ca.state.cores[0]!.cell.x = 99; ca.state.units[0]!.cell.x = 99; ca.events[0]!.skills[0] = "changed";
  fa.state.units[0]!.cell.x = 99;
  const foldEvent = fa.events[0]!; assert.equal(foldEvent.type, "space_fold_applied");
  if (foldEvent.type === "space_fold_applied") foldEvent.mapping[0]!.from.x = 99;
  assert.equal(JSON.stringify({ c, cr, ci, f, fr, fi }), before);
});

test("world validation fails closed on overlap, blocked occupancy, duplicates, limits and malformed values", () => {
  for (const change of [
    (s: SpaceFoldState) => { s.units[1]!.cell = pt(0, 0); },
    (s: SpaceFoldState) => { s.blocked.push(pt(4, 2)); },
    (s: SpaceFoldState) => { s.units[1]!.id = "boss"; },
    (s: SpaceFoldState) => { s.units[1]!.cell.x = -1; },
    (s: SpaceFoldState) => { s.units[0]!.width = 3 as any; },
    (s: SpaceFoldState) => { s.units[0]!.hp = Infinity; },
    (s: SpaceFoldState) => { s.blocked = [null as any]; },
    (s: SpaceFoldState) => { s.resolvedFoldIds = ["f1", "f1"]; },
  ]) { const s = world(); change(s); assert.equal(reason(prepareSpaceFold(s, foldReq())), "invalid_state"); }
  const s = world(); s.resolvedFoldIds = Array.from({ length: 256 }, (_, n) => `f${n + 10}`);
  assert.equal(reason(prepareSpaceFold(s, foldReq())), "history_full");
});

test("L9 supports separately declared later transitions but never reuses a migration ID", () => {
  const s = cores(), first = coreIntent(s); s.units[0]!.hp = 9;
  const a = resolveCoreMigration(s, first); assert.equal(a.status, "resolved"); if (a.status !== "resolved") throw Error();
  a.state.round++;
  const request: CoreMigrationRequest = { skillId: "core_migration", migrationId: "m2", threshold: 4,
    targetCoreId: "alpha", nextPhaseId: "phase3", nextSkills: ["new_skill"] };
  assert.equal(reason(prepareCoreMigration(a.state, { ...request, migrationId: "m1" })), "already_resolved");
  const second = coreIntent(a.state, request);
  assert.equal(reason(reprojectCoreMigration(a.state, second)), "threshold_not_reached");
  a.state.units[0]!.hp = 4;
  const b = resolveCoreMigration(a.state, second); assert.equal(b.status, "resolved");
  if (b.status === "resolved") {
    assert.equal(b.state.currentCoreId, "alpha"); assert.equal(b.state.phaseId, "phase3");
    assert.deepEqual(b.state.migratedIds, ["m1", "m2"]); assert.deepEqual(b.state.skills, ["new_skill"]);
    assert.equal(reason(resolveCoreMigration(b.state, second)), "already_resolved");
  }
});

test("L10 empty affected area is still declared and recorded, without invented movement", () => {
  const s = world(), r: SpaceFoldRequest = { skillId: "space_fold", actionId: "empty", mapping: [
    { from: pt(7, 5), to: pt(8, 5) }, { from: pt(8, 5), to: pt(7, 5) },
  ] };
  const i = foldIntent(s, r); assert.deepEqual(i.moves, []);
  const out = resolveSpaceFold(s, i); assert.equal(out.status, "resolved");
  if (out.status === "resolved") {
    assert.deepEqual(out.events, [{ type: "space_fold_applied", actionId: "empty", mapping: i.mapping }]);
    assert.deepEqual(out.state.units, s.units); assert.deepEqual(out.state.resolvedFoldIds, ["empty"]);
  }
  s.units[3]!.cell = pt(7, 5);
  assert.equal(reason(reprojectSpaceFold(s, i)), "target_changed");
});

test("L10 accepts the bounded mapping limit and voids over-limit input", () => {
  const s = world();
  const mapping = Array.from({ length: PHASE_FIELD_MAX_MAPPING }, (_, n) => {
    const p = pt(n % 8, Math.floor(n / 8)); return { from: p, to: pt(p.x, p.y) };
  });
  const r: SpaceFoldRequest = { skillId: "space_fold", actionId: "limit", mapping };
  const intent = foldIntent(s, r), out = resolveSpaceFold(s, intent); assert.equal(out.status, "resolved");
  if (out.status === "resolved") {
    assert.deepEqual(out.state.units, s.units);
    assert.equal(out.events.length, 1); assert.equal(out.events[0]!.type, "space_fold_applied");
  }
  assert.equal(reason(prepareSpaceFold(s, { ...r, mapping: [...mapping, { from: pt(8, 7), to: pt(8, 7) }] })), "invalid_mapping");
});
