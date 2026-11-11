import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareCoreMigration, reprojectCoreMigration, resolveCoreMigration,
  type MigrationRequest, type MigrationState,
} from "../src/game/mecha/skillCoreMigration.ts";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const initial = (): MigrationState => ({
  version: 1, round: 1, active: true, actorId: "many_core", hp: 20, maxHp: 20,
  phaseId: "phase_1", currentCoreId: "core_a", skills: ["guard"], migrations: [],
  cores: [
    { id: "core_a", cell: { x: 0, y: 0 }, alive: true },
    { id: "core_b", cell: { x: 1, y: 0 }, alive: true },
    { id: "core_c", cell: { x: 0, y: 1 }, alive: true },
  ],
});
const request = (migrationId: string, threshold: number, targetCoreId: string, nextPhaseId: string, nextSkills: string[]): MigrationRequest => ({
  skillId: "core_migration", migrationId, threshold, targetCoreId, nextPhaseId, nextSkills,
});
function planned(state: MigrationState, req: MigrationRequest) {
  const plan = prepareCoreMigration(state, req);
  assert.equal(plan.status, "planned");
  if (plan.status !== "planned") throw new Error(plan.reason);
  return plan;
}
function projected(state: MigrationState, plan: ReturnType<typeof planned>) {
  const result = reprojectCoreMigration(state, plan.binding, plan.intent);
  assert.equal(result.status, "reprojected");
  if (result.status !== "reprojected") throw new Error(result.reason);
  return result;
}

test("serialized multi-phase snapshots reproduce plans, projections, state, events and one-shot history", () => {
  function run(restored: boolean) {
    let state = initial();
    const log: unknown[] = [];
    for (const [req, hp] of [
      [request("move_1", 10, "core_b", "phase_2", ["pierce", "guard"]), 10],
      [request("move_2", 5, "core_c", "phase_3", ["sweep"]), 4],
    ] as Array<[MigrationRequest, number]>) {
      if (restored) state = clone(state);
      let plan = planned(state, req);
      if (restored) plan = clone(plan);
      state = { ...state, hp };
      const before = clone(state);
      let view = projected(state, plan);
      // Preview is repeatable and cannot consume the one-shot transition.
      assert.deepEqual(projected(state, plan), view);
      assert.deepEqual(state, before);
      if (restored) view = clone(view);
      const result = resolveCoreMigration(state, plan.binding, plan.intent, view);
      assert.equal(result.status, "resolved");
      if (result.status !== "resolved") throw new Error(result.reason);
      assert.deepEqual(clone({ plan, view, result }), { plan, view, result });
      assert.deepEqual(state, before);
      assert.deepEqual(result.events.map(event => event.type), ["core_migrated", "phase_changed", "skills_changed"]);
      assert.deepEqual(reprojectCoreMigration(result.state, plan.binding, plan.intent), { status: "void", reason: "already_resolved" });
      log.push({ plan, view, result });
      state = { ...result.state, round: result.state.round + 1 };
    }
    assert.equal(state.currentCoreId, "core_c");
    assert.equal(state.phaseId, "phase_3");
    assert.deepEqual(state.skills, ["sweep"]);
    assert.deepEqual(state.migrations, [
      { id: "move_1", phaseId: "phase_1" }, { id: "move_2", phaseId: "phase_2" },
    ]);
    return { state, log };
  }
  assert.deepEqual(run(true), run(false));
});

test("a migrated-from phase cannot be re-entered, even if history changes after projection", () => {
  const s = initial();
  s.phaseId = "phase_2";
  s.currentCoreId = "core_b";
  s.migrations = [{ id: "old", phaseId: "phase_1" }];
  const r = request("new", 10, "core_c", "phase_1", ["sweep"]);
  assert.deepEqual(prepareCoreMigration(s, r), { status: "void", reason: "target_phase_already_migrated" });
  const plan = planned(s, { ...r, nextPhaseId: "phase_3" });
  s.hp = 10;
  const view = projected(s, plan);
  // Simulate authoritative history changing after the original declaration.
  s.migrations.push({ id: "other", phaseId: "phase_3" });
  const before = clone(s);
  assert.deepEqual(reprojectCoreMigration(s, plan.binding, plan.intent), { status: "void", reason: "target_phase_already_migrated" });
  assert.deepEqual(resolveCoreMigration(s, plan.binding, plan.intent, view), { status: "void", reason: "target_phase_already_migrated" });
  assert.deepEqual(s, before);
});

test("two competing declarations cannot both consume the same source phase", () => {
  const s = initial();
  const first = planned(s, request("first", 10, "core_b", "phase_2", ["pierce"]));
  const second = planned(s, request("second", 10, "core_c", "phase_3", ["sweep"]));
  s.hp = 10;
  const firstView = projected(s, first), secondView = projected(s, second);
  const committed = resolveCoreMigration(s, first.binding, first.intent, firstView);
  assert.equal(committed.status, "resolved");
  if (committed.status !== "resolved") throw new Error(committed.reason);
  assert.deepEqual(resolveCoreMigration(committed.state, second.binding, second.intent, secondView),
    { status: "void", reason: "phase_already_migrated" });
  assert.equal(committed.state.currentCoreId, "core_b");
  assert.deepEqual(committed.state.migrations, [{ id: "first", phaseId: "phase_1" }]);
});

test("every valid absolute threshold and target deterministically binds only the declared effects", () => {
  for (let threshold = 1; threshold < 20; threshold++) {
    for (const target of ["core_b", "core_c"]) {
      const s = initial(), before = clone(s);
      const plan = planned(s, request(`m_${threshold}_${target}`, threshold, target, "phase_2", ["new_skill"]));
      assert.deepEqual(s, before);
      for (const hp of [threshold, 1]) {
        const damaged = { ...s, hp };
        const original = clone(damaged), view = projected(damaged, plan);
        const result = resolveCoreMigration(damaged, plan.binding, plan.intent, view);
        assert.equal(result.status, "resolved");
        if (result.status !== "resolved") throw new Error(result.reason);
        assert.deepEqual(damaged, original);
        assert.deepEqual(result.state, { ...original, currentCoreId: target, phaseId: "phase_2", skills: ["new_skill"],
          migrations: [{ id: plan.binding.migrationId, phaseId: "phase_1" }] });
        assert.deepEqual(result, resolveCoreMigration(clone(damaged), clone(plan.binding), clone(plan.intent), clone(view)));
      }
      const notReached = { ...s, hp: threshold + 1 };
      assert.deepEqual(reprojectCoreMigration(notReached, plan.binding, plan.intent), { status: "void", reason: "threshold_not_reached" });
      assert.deepEqual(reprojectCoreMigration({ ...s, hp: 0 }, plan.binding, plan.intent), { status: "void", reason: "actor_unavailable" });
    }
  }
});
