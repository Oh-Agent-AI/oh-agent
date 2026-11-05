import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  prepareSpaceFold, reprojectSpaceFold, type SpaceFoldIntent, type SpaceFoldRequest, type SpaceFoldState,
} from "../apps/agent-city/ui/src/game/mecha/skillPhaseField.ts";
import {
  prepareFoldRecovery, resolveFoldRecovery, resolveFoldWithRecovery, type FoldRecoveryReceipt,
} from "../apps/agent-city/ui/src/game/mecha/skillSpaceFoldRecovery.ts";

const pt = (x: number, y: number) => ({ x, y });
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { Object.freeze(v); for (const child of Object.values(v)) freeze(child); }
  return v;
}
function world(): SpaceFoldState {
  return { version: 1, width: 10, height: 8, round: 3, active: true, phaseId: "phase1", actorId: "boss", blocked: [],
    units: [
      { id: "boss", cell: pt(0, 0), width: 2, height: 2, hp: 20 },
      { id: "a", cell: pt(4, 2), width: 1, height: 1, hp: 5 },
      { id: "b", cell: pt(5, 2), width: 1, height: 1, hp: 4 },
      { id: "c", cell: pt(6, 2), width: 1, height: 1, hp: 3 },
      { id: "safe", cell: pt(8, 6), width: 1, height: 1, hp: 2 },
    ], resolvedFoldIds: [] };
}
function request(): SpaceFoldRequest {
  return { skillId: "space_fold", actionId: "fold", mapping: [
    { from: pt(6, 2), to: pt(4, 2) }, { from: pt(4, 2), to: pt(5, 2) }, { from: pt(5, 2), to: pt(6, 2) },
  ] };
}
function planned(state: SpaceFoldState, req = request()): SpaceFoldIntent {
  const p = prepareSpaceFold(state, req); assert.equal(p.status, "planned", JSON.stringify(p));
  if (p.status !== "planned") throw Error(); return p.intent;
}
function applied() {
  const state = world(), intent = planned(state);
  const out = resolveFoldWithRecovery(state, intent, "unfold");
  assert.equal(out.status, "resolved", JSON.stringify(out));
  if (out.status !== "resolved") throw Error();
  return { original: state, intent, ...out };
}
function reason(value: { status: string; reason?: string }): string | undefined {
  assert.equal(value.status, "void", JSON.stringify(value)); return value.reason;
}

test("L10 inverse declares the complete three-cycle and restores positions, not HP or unrelated state", () => {
  const { original, state, receipt } = applied();
  const saved = copy(receipt); freeze(state); freeze(receipt);
  const plan = prepareFoldRecovery(state, receipt); assert.equal(plan.status, "planned");
  if (plan.status !== "planned") throw Error();
  assert.deepEqual(plan.intent.mapping, [
    { from: pt(4, 2), to: pt(6, 2) }, { from: pt(5, 2), to: pt(4, 2) }, { from: pt(6, 2), to: pt(5, 2) },
  ]);
  assert.deepEqual(plan.intent.moves.map(m => m.unitId), ["c", "a", "b"]);
  const changed = copy(state); changed.units[1]!.hp = 1; changed.units[4]!.cell = pt(8, 7);
  const projection = reprojectSpaceFold(changed, plan.intent);
  const preview = resolveFoldRecovery(changed, receipt, plan.intent, projection);
  const actual = resolveFoldRecovery(copy(changed), copy(receipt), copy(plan.intent), copy(projection));
  assert.deepEqual(actual, preview); assert.equal(actual.status, "resolved");
  if (actual.status !== "resolved") throw Error();
  assert.deepEqual(actual.state.units.slice(0, 4).map(u => u.cell), original.units.slice(0, 4).map(u => u.cell));
  assert.equal(actual.state.units[1]!.hp, 1); assert.deepEqual(actual.state.units[4]!.cell, pt(8, 7));
  assert.deepEqual(actual.state.resolvedFoldIds, ["fold", "unfold"]);
  assert.deepEqual(actual.events.map(e => e.type), ["space_fold_applied", "space_fold_move", "space_fold_move", "space_fold_move"]);
  assert.equal(reason(prepareFoldRecovery(actual.state, receipt)), "already_resolved");
  assert.deepEqual(receipt, saved);
});

test("L10 rejects changed occupancy rather than silently recovering different entities", () => {
  const cases: Array<[string, (s: SpaceFoldState) => void, string]> = [
    ["participant leaves", s => { s.units[1]!.cell = pt(7, 2); }, "occupancy_changed"],
    ["participant dies", s => { s.units[1]!.hp = 0; }, "occupancy_changed"],
    ["participant replaced", s => { s.units[1]!.id = "replacement"; }, "occupancy_changed"],
    ["extra entrant", s => { s.units[1]!.hp = 0; s.units[4]!.cell = pt(5, 2); }, "occupancy_changed"],
    ["blocked destination", s => { s.units[2]!.hp = 0; s.blocked.push(pt(6, 2)); }, "blocked_destination"],
    ["terminal", s => { s.active = false; }, "inactive"],
    ["round", s => { s.round++; }, "round_changed"],
    ["phase", s => { s.phaseId = "phase2"; }, "phase_changed"],
    ["boss dies", s => { s.units[0]!.hp = 0; }, "actor_unavailable"],
    ["source missing", s => { s.resolvedFoldIds = []; }, "source_not_resolved"],
  ];
  for (const [name, change, expected] of cases) {
    const { state, receipt } = applied(); change(state); const before = copy(state);
    assert.equal(reason(prepareFoldRecovery(state, receipt)), expected, name);
    assert.deepEqual(state, before, name);
  }
});

test("L10 uses the originally declared recovery plan and rejects stale projection", () => {
  const { state, receipt } = applied(), plan = prepareFoldRecovery(state, receipt);
  assert.equal(plan.status, "planned"); if (plan.status !== "planned") throw Error();
  const projection = reprojectSpaceFold(state, plan.intent);
  assert.equal(projection.status, "reprojected"); if (projection.status !== "reprojected") throw Error();
  const stale = copy(plan.intent); stale.mapping.reverse();
  assert.equal(reason(resolveFoldRecovery(state, receipt, stale)), "stale_recovery_intent");
  const stalePreview = copy(projection); stalePreview.moves[0]!.to.x++;
  assert.equal(reason(resolveFoldRecovery(state, receipt, plan.intent, stalePreview)), "stale_projection");
  const next = copy(state); next.units[1]!.cell = pt(7, 2);
  const out = resolveFoldRecovery(next, receipt, plan.intent, projection);
  assert.equal(reason(out), "occupancy_changed"); assert.deepEqual(out.events, []); assert.deepEqual(out.state, next);
});

test("L10 handles empty mappings once and rejects reused recovery action IDs", () => {
  const state = world(), req: SpaceFoldRequest = { skillId: "space_fold", actionId: "empty", mapping: [
    { from: pt(7, 4), to: pt(8, 4) }, { from: pt(8, 4), to: pt(7, 4) },
  ] };
  const intent = planned(state, req);
  for (const id of ["", "empty", "bad id", "a".repeat(129)])
    assert.equal(reason(resolveFoldWithRecovery(state, intent, id)), "invalid_recovery_id");
  state.resolvedFoldIds.push("used");
  const duplicate = resolveFoldWithRecovery(state, intent, "used");
  assert.equal(reason(duplicate), "recovery_id_used"); assert.deepEqual(duplicate.state, state); assert.deepEqual(duplicate.events, []);
  const out = resolveFoldWithRecovery(state, intent, "empty_reverse");
  assert.equal(out.status, "resolved"); if (out.status !== "resolved") throw Error();
  const p = prepareFoldRecovery(out.state, out.receipt); assert.equal(p.status, "planned"); if (p.status !== "planned") throw Error();
  assert.deepEqual(p.intent.moves, []);
  const recovered = resolveFoldRecovery(out.state, out.receipt, p.intent);
  assert.equal(recovered.status, "resolved"); if (recovered.status !== "resolved") throw Error();
  assert.deepEqual(recovered.events.map(e => e.type), ["space_fold_applied"]);
  assert.equal(reason(prepareFoldRecovery(recovered.state, out.receipt)), "already_resolved");
});

test("L10 validates malformed receipts and isolates serialized data from inputs and events", () => {
  const { state, receipt, intent, original } = applied();
  const bad: unknown[] = [null, {}, { ...receipt, version: 2 }, { ...receipt, sourceActionId: "unfold" },
    { ...receipt, mapping: [null] }, { ...receipt, mapping: [receipt.mapping[0], receipt.mapping[0]] },
    { ...receipt, moves: [null] }, { ...receipt, moves: [{ ...receipt.moves[0], to: pt(9, 7) }] },
    { ...receipt, moves: [receipt.moves[0], receipt.moves[0]] }, { ...receipt, round: NaN }];
  for (const value of bad) assert.equal(reason(prepareFoldRecovery(state, value as FoldRecoveryReceipt)), "invalid_receipt");
  const replayed = prepareFoldRecovery(copy(state), copy(receipt));
  assert.deepEqual(replayed, prepareFoldRecovery(state, receipt));
  const second = resolveFoldWithRecovery(copy(original), copy(intent), "unfold");
  assert.equal(second.status, "resolved"); if (second.status !== "resolved") throw Error();
  const snapshot = copy(second.receipt);
  intent.mapping[0]!.from.x = 99; second.events[0]!.type === "space_fold_applied" && (second.events[0]!.mapping[0]!.from.x = 98);
  assert.deepEqual(second.receipt, snapshot);
});

test("L10 reverses a whole 2x2 boss footprint and never partially restores it", () => {
  const original = world(), mapping: SpaceFoldRequest["mapping"] = [];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    mapping.push({ from: pt(x, y), to: pt(x + 2, y + 4) });
    mapping.push({ from: pt(x + 2, y + 4), to: pt(x, y) });
  }
  const intent = planned(original, { skillId: "space_fold", actionId: "boss_fold", mapping });
  const result = resolveFoldWithRecovery(original, intent, "boss_unfold");
  assert.equal(result.status, "resolved"); if (result.status !== "resolved") throw Error();
  assert.deepEqual(result.state.units[0]!.cell, pt(2, 4));
  const plan = prepareFoldRecovery(result.state, result.receipt);
  assert.equal(plan.status, "planned"); if (plan.status !== "planned") throw Error();
  assert.deepEqual(plan.intent.moves, [{ unitId: "boss", from: pt(2, 4), to: pt(0, 0), width: 2, height: 2 }]);
  const out = resolveFoldRecovery(result.state, result.receipt, plan.intent);
  assert.equal(out.status, "resolved"); if (out.status !== "resolved") throw Error();
  assert.deepEqual(out.state.units, original.units);
  const partial = copy(result.state); partial.units[0]!.cell = pt(3, 4);
  assert.equal(reason(prepareFoldRecovery(partial, result.receipt)), "partial_footprint");
});

test("L10 restores every four-cell permutation deterministically, including an empty cell", () => {
  function permutations(values: number[]): number[][] {
    if (!values.length) return [[]];
    return values.flatMap((value, i) => permutations(values.filter((_, n) => n !== i)).map(rest => [value, ...rest]));
  }
  const cells = [pt(4, 2), pt(5, 2), pt(6, 2), pt(7, 2)];
  for (const permutation of permutations([0, 1, 2, 3])) {
    const state = freeze(world());
    const req: SpaceFoldRequest = { skillId: "space_fold", actionId: "fold", mapping: cells.map((from, index) => ({ from, to: cells[permutation[index]!]! })) };
    const initial = freeze(planned(state, req));
    const applied = resolveFoldWithRecovery(state, initial, "unfold");
    assert.equal(applied.status, "resolved", `${permutation}`); if (applied.status !== "resolved") throw Error();
    const plan = prepareFoldRecovery(freeze(applied.state), freeze(applied.receipt));
    assert.equal(plan.status, "planned", `${permutation}`); if (plan.status !== "planned") throw Error();
    const out = resolveFoldRecovery(applied.state, applied.receipt, plan.intent);
    assert.equal(out.status, "resolved", `${permutation}`); if (out.status !== "resolved") throw Error();
    assert.deepEqual(out.state.units, state.units, `${permutation}`);
    assert.deepEqual(prepareFoldRecovery(copy(applied.state), copy(applied.receipt)), plan, `${permutation}`);
  }
});
