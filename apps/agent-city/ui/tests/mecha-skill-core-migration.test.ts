import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_MIGRATION_MAX_CORES, CORE_MIGRATION_MAX_HISTORY, CORE_MIGRATION_MAX_SKILLS,
  prepareCoreMigration, reprojectCoreMigration, resolveCoreMigration,
  type MigrationIntent, type MigrationProjection, type MigrationRequest, type MigrationState,
} from "../src/game/mecha/skillCoreMigration.ts";

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const freeze = (v: any): void => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v); for (const child of Object.values(v)) freeze(child);
  }
};
const state = (): MigrationState => ({ version: 1, round: 4, active: true, actorId: "boss", hp: 20, maxHp: 20,
  phaseId: "phase1", currentCoreId: "alpha", cores: [
    { id: "alpha", cell: { x: 2, y: 2 }, alive: true },
    { id: "beta", cell: { x: 3, y: 2 }, alive: true },
    { id: "gamma", cell: { x: 2, y: 3 }, alive: true },
  ], skills: ["smash", "guard"], migrations: [] });
const request = (): MigrationRequest => ({ skillId: "core_migration", migrationId: "move1", threshold: 10,
  targetCoreId: "beta", nextPhaseId: "phase2", nextSkills: ["pierce", "sweep"] });
function plan(s = state(), r = request()) {
  const result = prepareCoreMigration(s, r); assert.equal(result.status, "planned");
  if (result.status !== "planned") throw Error(result.reason);
  return result;
}
function projection(s: MigrationState, p: ReturnType<typeof plan>): MigrationProjection {
  const result = reprojectCoreMigration(s, p.binding, p.intent); assert.equal(result.status, "reprojected");
  if (result.status !== "reprojected") throw Error(result.reason);
  return result;
}
function reason(result: { status: string; reason?: string }): string | undefined { return result.reason; }

test("declared threshold migrates only the bound core and emits the ordered atomic changes", () => {
  const s = state(), r = request(), p = plan(s, r);
  assert.deepEqual(p.intent, { version: 1, skillId: "core_migration", round: 4, actorId: "boss", phaseId: "phase1",
    sourceCoreId: "alpha", sourceCoreCell: { x: 2, y: 2 }, targetCoreId: "beta", targetCoreCell: { x: 3, y: 2 },
    migrationId: "move1", threshold: 10, maxHp: 20, declaredHp: 20, previousSkills: ["smash", "guard"],
    nextPhaseId: "phase2", nextSkills: ["pierce", "sweep"] });
  s.hp = 10;
  const out = resolveCoreMigration(s, p.binding, p.intent, projection(s, p));
  assert.equal(out.status, "resolved"); if (out.status !== "resolved") throw Error();
  assert.deepEqual(out.state, { ...s, phaseId: "phase2", currentCoreId: "beta", skills: ["pierce", "sweep"],
    migrations: [{ id: "move1", phaseId: "phase1" }] });
  assert.deepEqual(out.events, [
    { type: "core_migrated", migrationId: "move1", fromCoreId: "alpha", toCoreId: "beta" },
    { type: "phase_changed", migrationId: "move1", fromPhaseId: "phase1", toPhaseId: "phase2" },
    { type: "skills_changed", migrationId: "move1", previousSkills: ["smash", "guard"], nextSkills: ["pierce", "sweep"] },
  ]);
  assert.equal(s.currentCoreId, "alpha"); assert.deepEqual(s.migrations, []);
  assert.equal(reason(reprojectCoreMigration(out.state, p.binding, p.intent)), "already_resolved");
  assert.equal(reason(resolveCoreMigration(out.state, p.binding, p.intent, projection(s, p))), "already_resolved");
});

test("threshold is absolute: declare above it; equal or below triggers, but death never triggers", () => {
  for (const hp of [20, 11]) {
    const s = state(), p = plan(s); s.hp = hp;
    assert.equal(reason(reprojectCoreMigration(s, p.binding, p.intent)), "threshold_not_reached");
  }
  for (const hp of [10, 9, 1]) {
    const s = state(), p = plan(s); s.hp = hp;
    assert.equal(resolveCoreMigration(s, p.binding, p.intent, projection(s, p)).status, "resolved");
  }
  const dead = state(), p = plan(dead); dead.hp = 0;
  assert.equal(reason(reprojectCoreMigration(dead, p.binding, p.intent)), "actor_unavailable");
  for (const hp of [10, 9]) { const s = state(); s.hp = hp;
    assert.equal(reason(prepareCoreMigration(s, request())), "threshold_already_reached"); }
  const later = state(), late = plan(later); later.round++; later.hp = 10;
  assert.equal(reason(reprojectCoreMigration(later, late.binding, late.intent)), "round_changed");
});

test("changed, removed, replaced, or dead target never causes retargeting", () => {
  const changes: Array<[string, (s: MigrationState) => void, string]> = [
    ["moved", s => { s.cores[1]!.cell = { x: 3, y: 3 }; }, "target_changed"],
    ["dead", s => { s.cores[1]!.alive = false; }, "target_unavailable"],
    ["removed", s => { s.cores.splice(1, 1); }, "target_unavailable"],
    ["replaced at same cell", s => { s.cores[1]!.id = "replacement"; }, "target_unavailable"],
    ["swapped locations", s => { [s.cores[1]!.cell, s.cores[2]!.cell] = [s.cores[2]!.cell, s.cores[1]!.cell]; }, "target_changed"],
  ];
  for (const [name, change, expected] of changes) {
    const s = state(), p = plan(s); s.hp = 10; const oldProjection = projection(s, p); change(s);
    const before = copy(s), result = resolveCoreMigration(s, p.binding, p.intent, oldProjection);
    assert.deepEqual(result, { status: "void", reason: expected }, name); assert.deepEqual(s, before, name);
  }
});

test("round, phase, actor, source, skills, max HP and active status invalidate the declaration", () => {
  const changes: Array<[(s: MigrationState) => void, string]> = [
    [s => { s.round++; }, "round_changed"], [s => { s.phaseId = "other"; }, "phase_changed"],
    [s => { s.currentCoreId = "gamma"; }, "phase_changed"], [s => { s.skills.reverse(); }, "phase_changed"],
    [s => { s.maxHp++; }, "phase_changed"], [s => { s.actorId = "other"; }, "actor_unavailable"],
    [s => { s.hp = 0; }, "actor_unavailable"], [s => { s.active = false; }, "inactive"],
    [s => { s.cores[0]!.alive = false; }, "source_unavailable"],
    [s => { s.cores[0]!.cell = { x: 1, y: 1 }; }, "source_changed"],
  ];
  for (const [change, expected] of changes) {
    const s = state(), p = plan(s); s.hp = 10; const oldProjection = projection(s, p); change(s);
    assert.equal(reason(reprojectCoreMigration(s, p.binding, p.intent)), expected);
    assert.deepEqual(resolveCoreMigration(s, p.binding, p.intent, oldProjection), { status: "void", reason: expected });
  }
});

test("IDs and source phases are one-shot, including after a later return to the same phase", () => {
  const s = state(), p = plan(s); s.hp = 10;
  const out = resolveCoreMigration(s, p.binding, p.intent, projection(s, p));
  if (out.status !== "resolved") throw Error();
  const next = out.state; next.round++;
  const r = { ...request(), threshold: 5, targetCoreId: "alpha", nextPhaseId: "phase3" };
  assert.equal(reason(prepareCoreMigration(next, r)), "already_resolved");
  const p2 = plan(next, { ...r, migrationId: "move2" }); next.hp = 5;
  const out2 = resolveCoreMigration(next, p2.binding, p2.intent, projection(next, p2));
  assert.equal(out2.status, "resolved"); if (out2.status !== "resolved") throw Error();
  out2.state.round++; out2.state.phaseId = "phase1"; out2.state.hp = 5;
  assert.equal(reason(prepareCoreMigration(out2.state, { ...r, migrationId: "move3", threshold: 2, targetCoreId: "beta" })), "phase_already_migrated");
  assert.deepEqual(out2.state.migrations, [{ id: "move1", phaseId: "phase1" }, { id: "move2", phaseId: "phase2" }]);
});

test("malformed state, request, intent, lengths, IDs and round fail closed", () => {
  const badStates: Array<(s: MigrationState) => void> = [
    s => { s.version = 2 as any; }, s => { s.round = -1; }, s => { s.round = -0; }, s => { s.round = 1.5; },
    s => { s.round = 1_000_001; }, s => { s.hp = Infinity; }, s => { s.hp = 21; },
    s => { s.actorId = "invalid id"; }, s => { s.actorId = "x".repeat(129); },
    s => { s.cores[1]!.id = "alpha"; }, s => { s.cores[1]!.cell = copy(s.cores[0]!.cell); },
    s => { s.cores[1]!.cell.x = 128; }, s => { s.cores[1]!.alive = 1 as any; },
    s => { s.currentCoreId = "missing"; }, s => { s.cores = []; },
    s => { s.cores = Array(CORE_MIGRATION_MAX_CORES + 1).fill(s.cores[0]); },
    s => { s.skills = []; }, s => { s.skills = ["a", "a"]; }, s => { s.skills = Array(1) as string[]; },
    s => { Object.setPrototypeOf(s.skills, { toJSON: () => ["different"] }); },
    s => { Object.defineProperty(s, "hp", { enumerable: true, get: () => 20 }); },
    s => { s.skills = Array.from({ length: CORE_MIGRATION_MAX_SKILLS + 1 }, (_, n) => `s${n}`); },
    s => { s.migrations = [{ id: "a", phaseId: "p" }, { id: "a", phaseId: "q" }]; },
    s => { s.migrations = [{ id: "a", phaseId: "p" }, { id: "b", phaseId: "p" }]; },
    s => { (s as any).extra = undefined; }, s => { (s.cores[0] as any).extra = 1; },
  ];
  for (const change of badStates) { const s = state(); change(s); assert.equal(reason(prepareCoreMigration(s, request())), "invalid_state"); }
  const s = state(); s.migrations = Array.from({ length: CORE_MIGRATION_MAX_HISTORY }, (_, n) => ({ id: `m${n}`, phaseId: `p${n}` }));
  assert.equal(reason(prepareCoreMigration(s, request())), "history_full");
  s.migrations.push({ id: "more", phaseId: "more" }); assert.equal(reason(prepareCoreMigration(s, request())), "invalid_state");
  const badRequests: any[] = [null, { ...request(), threshold: 0 }, { ...request(), threshold: 20 },
    { ...request(), threshold: NaN }, { ...request(), threshold: 1.5 }, { ...request(), nextPhaseId: "phase1" },
    { ...request(), nextSkills: [] }, { ...request(), nextSkills: ["a", "a"] },
    { ...request(), nextSkills: Array(1) }, { ...request(), migrationId: "!" }, { ...request(), extra: null }];
  for (const r of badRequests) assert.equal(reason(prepareCoreMigration(state(), r)), "invalid_request");
  assert.equal(reason(prepareCoreMigration(state(), { ...request(), targetCoreId: "alpha" })), "target_unavailable");
  const normal = state(), p = plan(normal); normal.hp = 10;
  for (const bad of [null, { ...p.intent, version: 2 }, { ...p.intent, round: 1.1 },
    { ...p.intent, sourceCoreCell: null }, { ...p.intent, nextSkills: ["a", "a"] }, { ...p.intent, extra: null }]) {
    assert.equal(reason(reprojectCoreMigration(normal, p.binding, bad as any)), "invalid_intent");
  }
});

test("tampering with any valid bound intent field or with the projection is rejected", () => {
  const s = state(), p = plan(s); s.hp = 9; const view = projection(s, p);
  const alterations: Array<(i: MigrationIntent) => void> = [
    i => { i.round++; }, i => { i.actorId = "other"; }, i => { i.phaseId = "other"; },
    i => { i.sourceCoreId = "other"; }, i => { i.sourceCoreCell.x--; },
    i => { i.targetCoreId = "gamma"; }, i => { i.targetCoreCell.y++; },
    i => { i.migrationId = "other"; }, i => { i.threshold = 11; }, i => { i.maxHp++; },
    i => { i.declaredHp--; }, i => { i.previousSkills.reverse(); },
    i => { i.nextPhaseId = "other"; }, i => { i.nextSkills[0] = "other"; },
  ];
  for (const alter of alterations) {
    const changed = copy(p.intent); alter(changed);
    assert.equal(reason(reprojectCoreMigration(s, p.binding, changed)), "intent_changed");
    assert.equal(reason(resolveCoreMigration(s, p.binding, changed, view)), "intent_changed");
  }
  const badProjections: any[] = [null, { ...view, hp: 10 }, { ...view, extra: true },
    { ...view, intent: { ...view.intent, threshold: 11 } }, { ...view, status: "void" }];
  for (const bad of badProjections) assert.equal(reason(resolveCoreMigration(s, p.binding, p.intent, bad)), "stale_projection");
  s.hp = 8; assert.equal(reason(resolveCoreMigration(s, p.binding, p.intent, view)), "stale_projection");
  assert.equal(reason(reprojectCoreMigration(s, null as any, p.intent)), "invalid_binding");
  const changedBinding = copy(p.binding); changedBinding.nextSkills[0] = "other";
  assert.equal(reason(reprojectCoreMigration(s, changedBinding, p.intent)), "intent_changed");
});

test("JSON round trips, deterministic output, frozen inputs, and no output aliases", () => {
  const s = state(), r = request(); freeze(s); freeze(r);
  const p = plan(s, r); freeze(p);
  const damaged = { ...s, hp: 10 }; freeze(damaged);
  const view = projection(damaged, p); freeze(view);
  const original = JSON.stringify({ s, r, p, damaged, view });
  const result = resolveCoreMigration(damaged, p.binding, p.intent, view);
  assert.equal(result.status, "resolved"); if (result.status !== "resolved") throw Error();
  for (let n = 0; n < 5; n++) {
    assert.deepEqual(prepareCoreMigration(copy(s), copy(r)), p);
    assert.deepEqual(reprojectCoreMigration(copy(damaged), copy(p.binding), copy(p.intent)), view);
    assert.deepEqual(resolveCoreMigration(copy(damaged), copy(p.binding), copy(p.intent), copy(view)), result);
  }
  result.state.cores[0]!.cell.x = 99; result.state.skills[0] = "changed";
  assert.deepEqual(result.events[2], { type: "skills_changed", migrationId: "move1",
    previousSkills: ["smash", "guard"], nextSkills: ["pierce", "sweep"] });
  result.state.migrations[0]!.id = "changed";
  const skillsEvent = result.events[2]!; if (skillsEvent.type !== "skills_changed") throw Error();
  skillsEvent.nextSkills[0] = "changed"; skillsEvent.previousSkills[0] = "changed";
  assert.equal(JSON.stringify({ s, r, p, damaged, view }), original);
  const fresh = plan(state()); fresh.intent.nextSkills[0] = "changed";
  assert.deepEqual(fresh.binding.nextSkills, ["pierce", "sweep"]);
  const freshView = projection(damaged, p); freshView.intent.nextSkills[0] = "changed";
  assert.deepEqual(p.binding.nextSkills, ["pierce", "sweep"]);
});


test("inclusive safety bounds accept finite JSON inputs and a final history entry", () => {
  const s = state(); s.round = 1_000_000; s.hp = 1_000_000; s.maxHp = 1_000_000;
  s.cores = Array.from({ length: CORE_MIGRATION_MAX_CORES }, (_, n) => ({
    id: n === 0 ? "alpha" : n === 1 ? "beta" : `core${n}`, cell: { x: n, y: 127 }, alive: true,
  }));
  s.skills = Array.from({ length: CORE_MIGRATION_MAX_SKILLS }, (_, n) => `skill${n}`);
  s.migrations = Array.from({ length: CORE_MIGRATION_MAX_HISTORY - 1 }, (_, n) => ({ id: `m${n}`, phaseId: `p${n}` }));
  const r = { ...request(), migrationId: "x".repeat(128), threshold: 999_999,
    nextSkills: Array.from({ length: CORE_MIGRATION_MAX_SKILLS }, (_, n) => `next${n}`) };
  const p = plan(s, r); s.hp = 999_999;
  const result = resolveCoreMigration(s, p.binding, p.intent, projection(s, p));
  assert.equal(result.status, "resolved"); if (result.status !== "resolved") throw Error();
  assert.equal(result.state.migrations.length, CORE_MIGRATION_MAX_HISTORY);
  assert.equal(reason(prepareCoreMigration(result.state, { ...request(), migrationId: "last", threshold: 1, targetCoreId: "alpha", nextPhaseId: "phase3" })), "history_full");
  assert.deepEqual(copy(result), result);
});
