/** Shared rule-level assertions for monster skill tests. These helpers do not certify UI or remote support. */
import assert from "node:assert/strict";
import { presentationSnapshot } from "../src/game/mecha/board.ts";
import { MECH_IDS, bossPrepare, createMatch, living, playTurn, previewPlan, stakeBuildings, type ArenaPlan, type BossScriptId, type MatchState, type TurnEvent } from "../src/game/mecha/rules.ts";

type TurnFunctions = { preview: typeof previewPlan; play: typeof playTurn };

export function monsterSkillFixture(script: BossScriptId = "stationary_smash"): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script, covers: [], boss: { x: 4, y: 0 }, mechs: [
    { id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 7, y: 8 } }, { id: "Support", pos: { x: 8, y: 9 } },
  ] });
  bossPrepare(state);
  return state;
}

export function holdPlan(state: MatchState): ArenaPlan {
  return { revision: state.revision, items: living(state).map((mech) => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" } })) };
}

/** A complete plan is required: preview fills missing orders, whereas playTurn rejects them.
 * Preview exposes projections, not a full MatchState; compare every exposed projection with execution. */
export function assertPreviewMatchesTurn(state: MatchState, plan: ArenaPlan, overrides: Partial<TurnFunctions> = {}) {
  const before = structuredClone(state), originalPlan = structuredClone(plan);
  const preview = (overrides.preview ?? previewPlan)(state, plan);
  assert.deepEqual(state, before, "preview mutated the input");
  assert.deepEqual(plan, originalPlan, "preview mutated the command");
  const actual = (overrides.play ?? playTurn)(state, plan);
  assert.deepEqual(state, before, "execution mutated the input");
  assert.deepEqual(plan, originalPlan, "execution mutated the command");
  assert.ok(preview.ok, preview.ok ? undefined : JSON.stringify(preview.fault));
  assert.ok(actual.ok, actual.ok ? undefined : JSON.stringify(actual.fault));
  assert.deepEqual(preview.assumed, [], "fixture must include every living mech");
  assert.deepEqual(preview.log, actual.log, "preview and execution event order differs");
  assert.ok(preview.stages, "preview presentation must be available");
  assert.ok(actual.presentationStages, "execution presentation must be available");
  assert.deepEqual(preview.stages, actual.presentationStages, "preview and execution presentation differs");
  assert.deepEqual(preview.stages.before, presentationSnapshot(before), "presentation start differs from input state");
  assert.deepEqual(preview.stages.afterPrepare, presentationSnapshot(actual.state), "presentation end differs from execution state");
  assert.equal(preview.outcome, actual.state.outcome, "preview outcome differs from execution state");
  const hits = Object.fromEntries(MECH_IDS.map((id) => {
    const start = actual.presentationStages!.afterPlayer.mechs.find((mech) => mech.id === id)?.hp ?? 0;
    const end = actual.presentationStages!.afterEnemy.mechs.find((mech) => mech.id === id)?.hp ?? 0;
    return [id, Math.max(0, start - end)];
  }));
  assert.deepEqual(preview.hitsAfter, hits, "preview damage differs from execution stages");
  const staked = new Set(stakeBuildings(before).map((building) => building.id));
  const buildings = before.buildings.map((building) => ({
    id: building.id, cells: building.cells, staked: staked.has(building.id), startHp: building.hp,
    afterPlayerHp: actual.presentationStages!.afterPlayer.buildings.find((item) => item.id === building.id)?.hp,
    endHp: actual.state.buildings.find((item) => item.id === building.id)?.hp, maxHp: building.maxHp,
  }));
  assert.deepEqual(preview.buildings, buildings, "preview buildings differ from execution state");
  const enemyOrder = actual.log.filter((event): event is Extract<TurnEvent, { type: "enemy" }> => event.type === "enemy");
  assert.deepEqual(preview.enemyOrder, enemyOrder, "preview enemy order differs from execution events");
  const byActor: typeof preview.telegraphByActor = {}, cells: typeof preview.telegraphAfter = [];
  const seen = new Set<string>();
  for (const event of enemyOrder) {
    byActor[event.actor] = event.cells;
    for (const cell of event.cells) {
      const key = `${cell.x},${cell.y}`;
      if (!seen.has(key)) { seen.add(key); cells.push(cell); }
    }
  }
  assert.deepEqual(preview.telegraphByActor, byActor, "preview actor telegraphs differ from execution events");
  assert.deepEqual(preview.telegraphAfter, cells, "preview telegraphs differ from execution events");
  return actual;
}

/** Both APIs must reject this plan; missing orders alone are deliberately filled by preview. */
export function assertPlanRejectedAtomically(state: MatchState, plan: ArenaPlan, overrides: Partial<TurnFunctions> = {}): void {
  const before = structuredClone(state), originalPlan = structuredClone(plan);
  const preview = (overrides.preview ?? previewPlan)(state, plan);
  assert.deepEqual(state, before, "rejected preview mutated the input");
  assert.deepEqual(plan, originalPlan, "rejected preview mutated the command");
  const actual = (overrides.play ?? playTurn)(state, plan);
  assert.deepEqual(state, before, "rejected execution mutated the input");
  assert.deepEqual(plan, originalPlan, "rejected execution mutated the command");
  assert.equal(preview.ok, false);
  assert.equal(actual.ok, false);
  assert.deepEqual(Object.keys(preview).sort(), ["fault", "ok"], "rejected preview must not return effects");
  assert.deepEqual(Object.keys(actual).sort(), ["fault", "ok"], "rejected execution must not return effects");
  assert.deepEqual(preview, actual, "rejection faults differ");
}

/** Compare the full event stream, including event order and payloads, not just event counts. */
export function assertEvents(actual: TurnEvent[], expected: TurnEvent[]): void {
  assert.deepEqual(actual, expected);
}

/** Reapply serialized initial state and full commands; compare every intermediate state and event. */
export function assertSerializedReplay(initial: MatchState, plans: ArenaPlan[], play: typeof playTurn = playTurn): void {
  assert.ok(plans.length > 0, "replay requires at least one command");
  const initialBefore = structuredClone(initial), plansBefore = structuredClone(plans);
  let original = structuredClone(initial);
  let restored = JSON.parse(JSON.stringify(initial)) as MatchState;
  const restoredPlans = JSON.parse(JSON.stringify(plans)) as ArenaPlan[];
  for (let i = 0; i < plans.length; i += 1) {
    const originalBefore = structuredClone(original), restoredBefore = structuredClone(restored);
    const restoredPlanBefore = structuredClone(restoredPlans[i]!);
    const a = play(original, plans[i]!);
    assert.deepEqual(original, originalBefore, `original replay input mutated at turn ${i + 1}`);
    assert.deepEqual(plans, plansBefore, `original replay commands mutated at turn ${i + 1}`);
    const b = play(restored, restoredPlans[i]!);
    assert.deepEqual(restored, restoredBefore, `serialized replay input mutated at turn ${i + 1}`);
    assert.deepEqual(restoredPlans[i], restoredPlanBefore, `serialized replay command mutated at turn ${i + 1}`);
    assert.ok(a.ok, a.ok ? undefined : JSON.stringify(a.fault));
    assert.ok(b.ok, b.ok ? undefined : JSON.stringify(b.fault));
    assert.deepEqual(b, a, `serialized replay diverged at turn ${i + 1}`);
    original = a.state;
    restored = b.state;
  }
  assert.deepEqual(initial, initialBefore, "replay mutated the initial state");
  assert.deepEqual(plans, plansBefore, "replay mutated the commands");
}
