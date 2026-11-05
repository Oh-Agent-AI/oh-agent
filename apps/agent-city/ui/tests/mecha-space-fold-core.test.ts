import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SPACE_FOLD_MAX_CELLS, SPACE_FOLD_MAX_HISTORY, SPACE_FOLD_MAX_UNITS,
  prepareSpaceFoldCore, prepareSpaceFoldRecoveryCore, reprojectSpaceFoldCore, resolveSpaceFoldCore,
} from "../src/game/mecha/skillSpaceFold.ts";
import type { SpaceFoldRequest, SpaceFoldState } from "../src/game/mecha/skillPhaseField.ts";

const pt = (x: number, y: number) => ({ x, y });
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { Object.freeze(v); for (const value of Object.values(v)) freeze(value); }
  return v;
}
function world(): SpaceFoldState {
  return { version: 1, width: 10, height: 8, round: 3, active: true, phaseId: "p1", actorId: "boss", blocked: [],
    units: [
      { id: "boss", cell: pt(0, 0), width: 2, height: 2, hp: 10 },
      { id: "a", cell: pt(4, 2), width: 1, height: 1, hp: 5 },
      { id: "b", cell: pt(5, 2), width: 1, height: 1, hp: 4 },
      { id: "safe", cell: pt(8, 6), width: 1, height: 1, hp: 3 },
    ], resolvedFoldIds: [] };
}
function request(): SpaceFoldRequest {
  return { skillId: "space_fold", actionId: "f1", mapping: [
    { from: pt(6, 2), to: pt(4, 2) }, { from: pt(5, 2), to: pt(6, 2) }, { from: pt(4, 2), to: pt(5, 2) },
  ] };
}
function plan(state = world(), req = request()) {
  const p = prepareSpaceFoldCore(state, req); assert.equal(p.status, "planned", JSON.stringify(p));
  if (p.status !== "planned") throw Error(); return p;
}
function project(state: SpaceFoldState, p: ReturnType<typeof plan>) {
  const result = reprojectSpaceFoldCore(state, p.binding, p.intent);
  assert.equal(result.status, "reprojected", JSON.stringify(result));
  if (result.status !== "reprojected") throw Error(); return result;
}
function reason(result: { status: string; reason?: string }): string | undefined {
  assert.equal(result.status, "void", JSON.stringify(result)); return result.reason;
}

test("L10 declares canonical mapping and independent bindings, with deterministic atomic events", () => {
  const state = freeze(world()), req = freeze(request()), p = plan(state, req);
  assert.deepEqual(p.binding, p.intent); assert.notEqual(p.binding, p.intent);
  assert.notEqual(p.binding.mapping, p.intent.mapping); assert.notEqual(p.binding.moves[0]!.from, p.intent.moves[0]!.from);
  assert.deepEqual(p.binding.mapping.map(x => x.from), [pt(4, 2), pt(5, 2), pt(6, 2)]);
  assert.deepEqual(p.binding.moves.map(x => x.unitId), ["a", "b"]);
  const other = copy(state); other.units.reverse();
  assert.deepEqual(plan(other, { ...copy(req), mapping: [...req.mapping].reverse() }), p);
  const preview = freeze(project(state, p)); freeze(p);
  const actual = resolveSpaceFoldCore(state, p.binding, p.intent, preview);
  assert.deepEqual(actual, resolveSpaceFoldCore(copy(state), copy(p.binding), copy(p.intent), copy(preview)));
  assert.equal(actual.status, "resolved"); if (actual.status !== "resolved") throw Error();
  assert.deepEqual(actual.events.map(x => x.type), ["space_fold_applied", "space_fold_move", "space_fold_move"]);
  assert.deepEqual(actual.state.units.map(u => u.cell), [pt(0, 0), pt(5, 2), pt(6, 2), pt(8, 6)]);
  assert.deepEqual(actual.state.resolvedFoldIds, ["f1"]);
  assert.deepEqual(copy(actual), actual); assert.deepEqual(copy(p), p); assert.deepEqual(copy(preview), preview);
  assert.equal(reason(resolveSpaceFoldCore(actual.state, p.binding, p.intent, preview)), "already_resolved");
});

test("L10 refuses modified intents, including changed mapping, identities, order or footprint", () => {
  const state = world(), p = plan(state), preview = project(state, p);
  const cases: Array<(x: typeof p.intent) => void> = [
    x => { x.actionId = "other"; }, x => { x.actorCell.x++; }, x => { x.phaseId = "other"; },
    x => { [x.mapping[0]!.to, x.mapping[1]!.to] = [x.mapping[1]!.to, x.mapping[0]!.to]; },
    x => { x.moves[0]!.unitId = "safe"; }, x => { x.moves.reverse(); }, x => { x.moves[0]!.width = 2; },
    x => { x.moves.pop(); },
  ];
  for (const change of cases) {
    const altered = copy(p.intent); change(altered);
    assert.equal(reason(reprojectSpaceFoldCore(state, p.binding, altered)), "intent_changed");
    assert.equal(reason(resolveSpaceFoldCore(state, p.binding, altered, preview)), "intent_changed");
  }
  const altered = copy(p.intent); altered.mapping[0]!.from.x = 9;
  assert.notDeepEqual(altered, p.binding);
});

test("L10 voids changed occupancy, actor, phase and terminal state without retargeting", () => {
  const cases: Array<[string, (s: SpaceFoldState) => void, string]> = [
    ["target moves", s => { s.units[1]!.cell = pt(4, 3); }, "target_changed"],
    ["target dies", s => { s.units[1]!.hp = 0; }, "target_changed"],
    ["replacement", s => { s.units[1]!.id = "new"; }, "target_changed"],
    ["extra", s => { s.units[3]!.cell = pt(6, 2); }, "target_changed"],
    ["actor moves", s => { s.units[0]!.cell = pt(1, 0); }, "actor_changed"],
    ["actor dies", s => { s.units[0]!.hp = 0; }, "actor_unavailable"],
    ["round", s => { s.round++; }, "round_changed"], ["phase", s => { s.phaseId = "p2"; }, "phase_changed"],
    ["terminal", s => { s.active = false; }, "inactive"],
    ["blocked", s => { s.blocked.push(pt(6, 2)); }, "blocked_destination"],
  ];
  for (const [name, change, expected] of cases) {
    const state = world(), p = plan(state), projection = project(state, p); change(state);
    const before = copy(state);
    assert.equal(reason(reprojectSpaceFoldCore(state, p.binding, p.intent)), expected, name);
    assert.equal(reason(resolveSpaceFoldCore(state, p.binding, p.intent, projection)), expected, name);
    assert.deepEqual(state, before, name);
  }
});

test("L10 requires an unchanged projection; unrelated HP and position changes remain valid", () => {
  const state = world(), p = plan(state), before = project(state, p);
  state.units[1]!.hp--; state.units[3]!.cell = pt(8, 7);
  assert.deepEqual(project(state, p), before);
  const bad = copy(before); bad.moves[0]!.to.x++;
  assert.equal(reason(resolveSpaceFoldCore(state, p.binding, p.intent, bad)), "stale_projection");
  assert.equal(reason(resolveSpaceFoldCore(state, p.binding, p.intent, null as never)), "stale_projection");
  const out = resolveSpaceFoldCore(state, p.binding, p.intent, before);
  assert.equal(out.status, "resolved"); if (out.status === "resolved") {
    assert.equal(out.state.units[1]!.hp, 4); assert.deepEqual(out.state.units[3]!.cell, pt(8, 7));
  }
});

test("L10 rejects malformed/non-JSON values before returning serializable data", () => {
  const state = world(), req = request(), p = plan(), projection = project(state, p);
  const badStates: unknown[] = [null, { ...state, hidden: undefined }, { ...state, units: [undefined] },
    { ...state, round: NaN }, { ...state, width: Infinity }, { ...state, round: -0 },
    { ...state, units: [{ ...state.units[0], extra: 1n }] }, { ...state, resolvedFoldIds: ["a", "a"] },
    { ...state, blocked: Array(1) }, { ...state, blocked: [Object.create({ x: 1, y: 1 })] }];
  const getter = { ...state }; Object.defineProperty(getter, "round", { enumerable: true, get() { throw Error("getter"); } }); badStates.push(getter);
  for (const invalid of badStates) assert.equal(reason(prepareSpaceFoldCore(invalid as SpaceFoldState, req)), "invalid_state");
  for (const invalid of [null, { ...req, mapping: [null, null] }, { ...req, extra: () => {} }, { ...req, actionId: "" }])
    assert.equal(reason(prepareSpaceFoldCore(state, invalid as SpaceFoldRequest)), "invalid_request");
  for (const invalid of [null, { ...p.binding, mapping: [null] }, { ...p.binding, extra: undefined }])
    assert.equal(reason(reprojectSpaceFoldCore(state, invalid as typeof p.binding, p.intent)), "invalid_binding");
  for (const invalid of [null, { ...p.intent, moves: [null] }, { ...p.intent, actorCell: { x: -0, y: 0 } }])
    assert.equal(reason(reprojectSpaceFoldCore(state, p.binding, invalid as typeof p.intent)), "invalid_intent");
  for (const invalid of [{ ...projection, extra: undefined }, { ...projection, moves: [null] }, { ...projection, mapping: Array(2) }])
    assert.equal(reason(resolveSpaceFoldCore(state, p.binding, p.intent, invalid as typeof projection)), "stale_projection");
});

test("L10 bounds mappings, unit counts, history and whole 2x2 footprints", () => {
  const state = world(), req = request();
  assert.equal(reason(prepareSpaceFoldCore(state, { ...req, mapping: Array.from({ length: SPACE_FOLD_MAX_CELLS + 1 }, (_, i) => ({ from: pt(i % 10, Math.floor(i / 10)), to: pt(i % 10, Math.floor(i / 10)) })) })), "invalid_request");
  const large = copy(state); large.units = Array.from({ length: SPACE_FOLD_MAX_UNITS + 1 }, (_, i) => ({ id: `u${i}`, cell: pt(0, 0), width: 1, height: 1, hp: 0 }));
  assert.equal(reason(prepareSpaceFoldCore(large, req)), "invalid_state");
  const full = copy(state); full.resolvedFoldIds = Array.from({ length: SPACE_FOLD_MAX_HISTORY }, (_, i) => `f${i + 2}`);
  assert.equal(reason(prepareSpaceFoldCore(full, req)), "history_full");
  const partial = { ...req, mapping: [{ from: pt(0, 0), to: pt(4, 4) }, { from: pt(4, 4), to: pt(0, 0) }] };
  assert.equal(reason(prepareSpaceFoldCore(state, partial)), "partial_footprint");
  const nonPermutation = { ...req, mapping: [{ from: pt(4, 2), to: pt(5, 2) }, { from: pt(5, 2), to: pt(7, 2) }] };
  assert.equal(reason(prepareSpaceFoldCore(state, nonPermutation)), "invalid_mapping");
});

test("L10 recovery binds the exact inverse participants and resolves without preparing again", () => {
  const state = world(), p = plan(state), preview = project(state, p);
  const applied = resolveSpaceFoldCore(state, p.binding, p.intent, preview);
  assert.equal(applied.status, "resolved"); if (applied.status !== "resolved") throw Error();
  const next = copy(applied.state); next.units[1]!.hp = 2;
  const inverse = prepareSpaceFoldRecoveryCore(freeze(next), freeze(p.binding), "f2");
  assert.equal(inverse.status, "planned"); if (inverse.status !== "planned") throw Error();
  assert.deepEqual(inverse.intent.moves.map(m => m.unitId), ["a", "b"]);
  const inversePreview = project(next, inverse);
  const result = resolveSpaceFoldCore(next, inverse.binding, inverse.intent, inversePreview);
  assert.equal(result.status, "resolved"); if (result.status !== "resolved") throw Error();
  assert.deepEqual(result.state.units.map(u => u.cell), state.units.map(u => u.cell));
  assert.equal(result.state.units[1]!.hp, 2); assert.deepEqual(result.state.resolvedFoldIds, ["f1", "f2"]);
  assert.equal(reason(prepareSpaceFoldRecoveryCore(result.state, p.binding, "f2")), "already_resolved");
  const escaped = copy(next); escaped.units[1]!.cell = pt(4, 3);
  assert.equal(reason(prepareSpaceFoldRecoveryCore(escaped, p.binding, "f3")), "occupancy_changed");
  assert.equal(reason(resolveSpaceFoldCore(escaped, inverse.binding, inverse.intent, inversePreview)), "target_changed");
  assert.equal(reason(prepareSpaceFoldRecoveryCore(state, p.binding, "f2")), "source_not_resolved");
  assert.equal(reason(prepareSpaceFoldRecoveryCore(next, p.binding, "f1")), "invalid_recovery_id");
  const later = copy(next); later.round++;
  assert.equal(reason(prepareSpaceFoldRecoveryCore(later, p.binding, "f3")), "round_changed");
});

test("L10 deterministic closed permutations preserve units across recovery and JSON round trips", () => {
  function permutations(values: number[]): number[][] {
    return values.length ? values.flatMap((v, i) => permutations(values.filter((_, n) => n !== i)).map(rest => [v, ...rest])) : [[]];
  }
  const cells = [pt(4, 2), pt(5, 2), pt(6, 2), pt(7, 2)];
  for (const permutation of permutations([0, 1, 2, 3])) {
    const state = freeze(world());
    const p = plan(state, { skillId: "space_fold", actionId: "f1", mapping: cells.map((from, n) => ({ from, to: cells[permutation[n]!]! })) });
    const applied = resolveSpaceFoldCore(state, p.binding, p.intent, project(state, p));
    assert.equal(applied.status, "resolved", `${permutation}`); if (applied.status !== "resolved") throw Error();
    const inverse = prepareSpaceFoldRecoveryCore(copy(applied.state), copy(p.binding), "f2");
    assert.equal(inverse.status, "planned", `${permutation}`); if (inverse.status !== "planned") throw Error();
    const out = resolveSpaceFoldCore(copy(applied.state), copy(inverse.binding), copy(inverse.intent), copy(project(applied.state, inverse)));
    assert.equal(out.status, "resolved", `${permutation}`); if (out.status !== "resolved") throw Error();
    assert.deepEqual(out.state.units, state.units, `${permutation}`);
    assert.deepEqual(copy(out), out);
  }
});

test("L10 moves and recovers the whole actor footprint, preserving alias isolation", () => {
  const state = freeze(world()), mapping: SpaceFoldRequest["mapping"] = [];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    mapping.push({ from: pt(x, y), to: pt(x + 2, y + 4) }, { from: pt(x + 2, y + 4), to: pt(x, y) });
  }
  const p = plan(state, { skillId: "space_fold", actionId: "bossfold", mapping });
  assert.deepEqual(p.intent.moves, [{ unitId: "boss", from: pt(0, 0), to: pt(2, 4), width: 2, height: 2 }]);
  const out = resolveSpaceFoldCore(state, p.binding, p.intent, project(state, p));
  assert.equal(out.status, "resolved"); if (out.status !== "resolved") throw Error();
  const inverse = prepareSpaceFoldRecoveryCore(out.state, p.binding, "undo");
  assert.equal(inverse.status, "planned"); if (inverse.status !== "planned") throw Error();
  assert.deepEqual(inverse.intent.actorCell, pt(2, 4));
  const restored = resolveSpaceFoldCore(out.state, inverse.binding, inverse.intent, project(out.state, inverse));
  assert.equal(restored.status, "resolved"); if (restored.status !== "resolved") throw Error();
  assert.deepEqual(restored.state.units, state.units);
  const snapshot = copy(restored.state);
  if (restored.events[0]!.type === "space_fold_applied") restored.events[0]!.mapping[0]!.from.x = 100;
  assert.deepEqual(restored.state, snapshot); assert.deepEqual(state.units[0]!.cell, pt(0, 0));
});

test("L10 rejects corrupt inverse source geometry even when its action ID exists", () => {
  const state = world(), p = plan(state), applied = resolveSpaceFoldCore(state, p.binding, p.intent, project(state, p));
  assert.equal(applied.status, "resolved"); if (applied.status !== "resolved") throw Error();
  const cases: Array<(b: typeof p.binding) => void> = [
    b => { b.mapping.reverse(); }, b => { b.mapping[0]!.to = pt(9, 7); },
    b => { b.moves[0]!.to = pt(9, 7); }, b => { b.moves.reverse(); },
    b => { b.moves[1]!.unitId = b.moves[0]!.unitId; }, b => { b.moves[0]!.width = 2; },
  ];
  for (const change of cases) {
    const corrupt = copy(p.binding); change(corrupt);
    assert.equal(reason(prepareSpaceFoldRecoveryCore(applied.state, corrupt, "undo")), "invalid_binding");
  }
});

test("L10 accepts the exact mapping/history limits without losing empty declarations", () => {
  const state = world();
  state.resolvedFoldIds = Array.from({ length: SPACE_FOLD_MAX_HISTORY - 1 }, (_, i) => `old${i}`);
  const mapping = Array.from({ length: SPACE_FOLD_MAX_CELLS }, (_, n) => ({ from: pt(n % 8, Math.floor(n / 8)), to: pt(n % 8, Math.floor(n / 8)) }));
  const p = plan(state, { skillId: "space_fold", actionId: "last", mapping });
  const out = resolveSpaceFoldCore(state, p.binding, p.intent, project(state, p));
  assert.equal(out.status, "resolved"); if (out.status !== "resolved") throw Error();
  assert.equal(out.state.resolvedFoldIds.length, SPACE_FOLD_MAX_HISTORY);
  assert.deepEqual(out.events.map(e => e.type), ["space_fold_applied"]);
  assert.equal(reason(prepareSpaceFoldRecoveryCore(out.state, p.binding, "undo")), "history_full");
});
