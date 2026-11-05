import test from "node:test";
import assert from "node:assert/strict";
import {
  createCorrodeState, prepareCorrode, reprojectCorrode, resolveCorrode, endCorrodeTurn,
} from "../apps/agent-city/ui/src/game/mecha/skillCorrode.ts";
import type { CorrodeCell, CorrodeIntent, CorrodeRequest, CorrodeState, CorrodeUnit, CorrodeWorld } from "../apps/agent-city/ui/src/game/mecha/skillCorrode.ts";

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const board = () => createCorrodeState(8, 8, 1);
const world = (round = 1): CorrodeWorld => ({ round, blocked: [], casterAlive: true, finished: false });
const request = (target: CorrodeCell = { x: 2, y: 3 }, durationTurns = 3): CorrodeRequest => ({
  sourceId: "boss", target, durationTurns,
});
const unit = (id: string, cell: CorrodeCell, hp = 3): CorrodeUnit => ({ id, cell, hp });
function create(state = board(), w = world(), r = request()) {
  return resolveCorrode(state, w, prepareCorrode(state, w, r));
}

test("prepare, reproject and resolve bind a cell and duration without changing inputs", () => {
  const state = board(), w = world(), r = request({ x: 7, y: 7 }, 2);
  const before = copy({ state, w, r });
  const planned = prepareCorrode(state, w, r);
  assert.deepEqual(planned, {
    skillId: "corrode_cell", version: 1, sourceId: "boss", target: { x: 7, y: 7 },
    durationTurns: 2, preparedRound: 1, status: "planned", projected: { x: 7, y: 7 }, reason: null,
  });
  const moved = reprojectCorrode(state, w, planned);
  assert.equal(moved.status, "reprojected");
  assert.deepEqual(moved.target, planned.target);
  assert.deepEqual(moved.projected, planned.target);
  const actual = resolveCorrode(state, w, moved);
  assert.deepEqual(actual.state.fields, [{ id: "corrode:1:7:7", sourceId: "boss", cell: { x: 7, y: 7 }, createdRound: 1, expiresAfterRound: 2 }]);
  assert.deepEqual(actual.events, [{ type: "corrode_created", field: actual.state.fields[0] }]);
  assert.deepEqual({ state, w, r }, before);
  actual.events[0]!.type === "corrode_created" && (actual.events[0].field.cell.x = 0);
  assert.equal(actual.state.fields[0]!.cell.x, 7, "event and authority ledger must not alias");
  assert.deepEqual(planned.target, { x: 7, y: 7 });
});

test("duration counts creation round; only occupied living units trigger; no stacking", () => {
  let state = create().state;
  const occupants = [unit("z", { x: 2, y: 3 }), unit("a", { x: 2, y: 3 }), unit("dead", { x: 2, y: 3 }, 0), unit("outside", { x: 3, y: 3 })];
  const initial = copy(state);
  const duplicate = create(state, world(), request({ x: 2, y: 3 }, 1));
  assert.equal(duplicate.intent.reason, "already_corroded");
  assert.equal(duplicate.events[0]!.type, "corrode_void");
  assert.deepEqual(duplicate.state, state);
  const first = endCorrodeTurn(state, world(1), occupants);
  assert.deepEqual(first.events, [
    { type: "corrode_trigger", fieldId: "corrode:1:2:3", unitId: "a", damage: 1 },
    { type: "corrode_trigger", fieldId: "corrode:1:2:3", unitId: "z", damage: 1 },
  ]);
  assert.deepEqual(state, initial);
  state = first.state;
  // Occupants moving away are not tracked: the bound cell remains the target.
  const second = endCorrodeTurn(state, world(2), [unit("a", { x: 3, y: 3 })]);
  assert.deepEqual(second.events, []);
  const third = endCorrodeTurn(second.state, world(3), [unit("new", { x: 2, y: 3 })]);
  assert.deepEqual(third.events, [
    { type: "corrode_trigger", fieldId: "corrode:1:2:3", unitId: "new", damage: 1 },
    { type: "corrode_expired", fieldId: "corrode:1:2:3", reason: "duration" },
  ]);
  assert.deepEqual(third.state.fields, []);
  assert.equal(third.state.nextRound, 4);
  assert.deepEqual(endCorrodeTurn(third.state, world(4), occupants).events, []);
  assert.throws(() => endCorrodeTurn(first.state, world(1), occupants), /invalid_corrode_input/);
  assert.throws(() => endCorrodeTurn(first.state, world(3), occupants), /invalid_corrode_input/);
});

test("a one-turn field triggers and expires at the first end-of-round", () => {
  const active = create(board(), world(), request({ x: 0, y: 0 }, 1));
  const end = endCorrodeTurn(active.state, world(), [unit("m", { x: 0, y: 0 })]);
  assert.deepEqual(end.events.map((e) => e.type), ["corrode_trigger", "corrode_expired"]);
  assert.deepEqual(end.state.fields, []);
});

test("out-of-bounds, blockage, caster death and staleness produce explicit voids without retargeting", () => {
  const s = board(), w = world(), planned = prepareCorrode(s, w, request());
  const blocked = { ...w, blocked: [{ x: 2, y: 3 }] };
  const projected = reprojectCorrode(s, blocked, planned);
  assert.deepEqual({ status: projected.status, reason: projected.reason, target: projected.target, projected: projected.projected },
    { status: "void", reason: "blocked", target: { x: 2, y: 3 }, projected: null });
  // A void is sticky even if the obstruction subsequently moves away.
  assert.equal(reprojectCorrode(s, w, projected).reason, "blocked");
  assert.deepEqual(resolveCorrode(s, blocked, planned).events, [
    { type: "corrode_void", sourceId: "boss", target: { x: 2, y: 3 }, reason: "blocked" },
  ]);
  assert.equal(prepareCorrode(s, w, request({ x: -1, y: 0 })).reason, "outside_board");
  assert.equal(prepareCorrode(s, w, request({ x: 8, y: 7 })).reason, "outside_board");
  assert.equal(reprojectCorrode(s, { ...w, casterAlive: false }, planned).reason, "caster_dead");
  const next = endCorrodeTurn(s, w, []).state;
  assert.equal(resolveCorrode(next, world(2), planned).intent.reason, "stale");
  assert.deepEqual(s, board());
});

test("terminal outcome prevents new fields and clears old ones, while caster death alone does not", () => {
  const s = create().state, w = world(), planned = prepareCorrode(board(), w, request());
  const dead = { ...w, casterAlive: false };
  assert.equal(resolveCorrode(board(), dead, planned).intent.reason, "caster_dead");
  assert.equal(endCorrodeTurn(s, dead, [unit("m", { x: 2, y: 3 })]).events[0]!.type, "corrode_trigger");
  const finished = { ...w, finished: true, casterAlive: false };
  assert.equal(resolveCorrode(board(), finished, planned).intent.reason, "finished");
  const cleared = endCorrodeTurn(s, finished, [unit("m", { x: 2, y: 3 })]);
  assert.deepEqual(cleared.events, [{ type: "corrode_expired", fieldId: "corrode:1:2:3", reason: "finished" }]);
  assert.deepEqual(cleared.state.fields, []);
  assert.deepEqual(endCorrodeTurn(cleared.state, finished, []).events, []);
  assert.equal(cleared.state.nextRound, 1);
});

test("multiple fields and units resolve in fixed spatial then ID order independent of input order", () => {
  let s = board();
  for (const c of [{ x: 4, y: 5 }, { x: 2, y: 1 }, { x: 0, y: 1 }]) s = create(s, world(), request(c, 1)).state;
  const units = [unit("z", { x: 0, y: 1 }), unit("b", { x: 2, y: 1 }), unit("a", { x: 0, y: 1 }), unit("x", { x: 4, y: 5 })];
  const a = endCorrodeTurn(s, world(), units);
  const shuffled = { ...s, fields: [...s.fields].reverse() };
  assert.deepEqual(a, endCorrodeTurn(shuffled, world(), [...units].reverse()));
  assert.deepEqual(a.events.map((e) => e.type === "corrode_trigger" ? e.unitId : e.fieldId),
    ["a", "z", "corrode:1:0:1", "b", "corrode:1:2:1", "x", "corrode:1:4:5"]);
});

test("field count is bounded; a full ledger voids rather than replacing another target", () => {
  let s = board();
  // Use 9x8 to leave a legal but uncorroded cell after filling the 64 slots.
  s = createCorrodeState(9, 8, 1);
  for (let i = 0; i < 64; i += 1) s = create(s, world(), request({ x: i % 8, y: Math.floor(i / 8) }, 5)).state;
  const result = create(s, world(), request({ x: 8, y: 7 }, 5));
  assert.equal(result.intent.reason, "capacity");
  assert.deepEqual(result.state, s);
  assert.equal(s.fields.length, 64);
});

test("serialized clones reproduce every intermediate intent, result and expiration", () => {
  let a = board(), b = copy(a);
  for (let round = 1; round <= 5; round += 1) {
    const w = world(round), r = request({ x: round % 3, y: 2 }, 2);
    const ia = prepareCorrode(a, w, r), ib = prepareCorrode(b, copy(w), copy(r));
    assert.deepEqual(ia, ib);
    assert.deepEqual(reprojectCorrode(a, w, ia), reprojectCorrode(b, copy(w), copy(ib)));
    const ra = resolveCorrode(a, w, ia), rb = resolveCorrode(b, copy(w), copy(ib));
    assert.deepEqual(ra, rb);
    const units = [unit("one", { x: round % 3, y: 2 })];
    const ea = endCorrodeTurn(ra.state, w, units), eb = endCorrodeTurn(copy(rb.state), copy(w), copy(units));
    assert.deepEqual(ea, eb);
    a = ea.state; b = copy(eb.state);
  }
});

test("strict validation rejects malformed, unknown, accessor and non-JSON-compatible data atomically", () => {
  const s = board(), w = world(), r = request(), intent = prepareCorrode(s, w, r);
  const snapshots = copy({ s, w, r, intent });
  let getterCalls = 0;
  const accessor = Object.defineProperty({ ...r }, "durationTurns", { enumerable: true, get() { getterCalls += 1; return 2; } });
  const hidden = Object.defineProperty({ ...r }, "extra", { value: true });
  const inherited = Object.assign(Object.create({ injected: true }), r);
  const symbolic = { ...r, [Symbol("extra")]: true };
  for (const bad of [null, [], { ...r, durationTurns: 0 }, { ...r, durationTurns: 6 }, { ...r, durationTurns: 1.5 },
    { ...r, durationTurns: NaN }, { ...r, sourceId: "" }, { ...r, target: { x: -0, y: 1 } },
    { ...r, target: { x: Infinity, y: 1 } }, { ...r, extra: true }, accessor, hidden, inherited, symbolic]) {
    assert.throws(() => prepareCorrode(s, w, bad as never), /invalid_corrode_input/);
  }
  const sparse = Array(1);
  const arrayExtra = Object.assign([], { extra: true });
  for (const bad of [
    { ...w, extra: 1 }, { ...w, round: 2 }, { ...w, casterAlive: 1 }, { ...w, blocked: sparse },
    { ...w, blocked: arrayExtra }, { ...w, blocked: [{ x: 1, y: 1 }, { x: 1, y: 1 }] },
    { ...w, blocked: [{ x: 8, y: 0 }] },
  ]) assert.throws(() => reprojectCorrode(s, bad as never, intent), /invalid_corrode_input/);
  for (const bad of [
    { ...s, version: 2 }, { ...s, fields: [{ id: "forged", sourceId: "boss", cell: { x: 1, y: 1 }, createdRound: 1, expiresAfterRound: 1 }] },
    { ...s, fields: [{ id: "corrode:1:1:1", sourceId: "boss", cell: { x: 1, y: 1 }, createdRound: 1, expiresAfterRound: 6 }] },
  ]) assert.throws(() => resolveCorrode(bad as never, w, intent), /invalid_corrode_input/);
  for (const bad of [
    { ...intent, version: 2 }, { ...intent, skillId: "other" }, { ...intent, extra: 1 },
    { ...intent, projected: { x: 0, y: 0 } }, { ...intent, status: "void", reason: "mystery", projected: null },
    { ...intent, status: "void", reason: null, projected: null },
  ]) assert.throws(() => resolveCorrode(s, w, bad as CorrodeIntent), /invalid_corrode_input/);
  for (const units of [
    [unit("a", { x: 1, y: 1 }), unit("a", { x: 2, y: 2 })], [unit("a", { x: 9, y: 0 })],
    [unit("a", { x: 1, y: 1 }, -1)], [{ ...unit("a", { x: 1, y: 1 }), extra: 1 }],
  ]) assert.throws(() => endCorrodeTurn(s, w, units as CorrodeUnit[]), /invalid_corrode_input/);
  assert.throws(() => createCorrodeState(0, 8, 1), /invalid_corrode_input/);
  assert.throws(() => createCorrodeState(8, 65, 1), /invalid_corrode_input/);
  assert.throws(() => createCorrodeState(8, 8, Number.MAX_SAFE_INTEGER), /invalid_corrode_input/);
  assert.equal(getterCalls, 0);
  assert.deepEqual({ s, w, r, intent }, snapshots);
});

test("last supported round expires normally and its successor is terminal-only", () => {
  const last = 1_000_000, s = createCorrodeState(8, 8, last), w = world(last);
  assert.throws(() => prepareCorrode(s, w, request({ x: 1, y: 1 }, 2)), /invalid_corrode_input/);
  const active = create(s, w, request({ x: 1, y: 1 }, 1));
  const end = endCorrodeTurn(active.state, w, [unit("m", { x: 1, y: 1 })]);
  assert.deepEqual(end.events.map((e) => e.type), ["corrode_trigger", "corrode_expired"]);
  assert.equal(end.state.nextRound, last + 1);
  assert.throws(() => endCorrodeTurn(end.state, world(last + 1), []), /invalid_corrode_input/);
  assert.deepEqual(endCorrodeTurn(end.state, { ...world(last + 1), finished: true }, []).events, []);
  assert.throws(() => createCorrodeState(8, 8, last + 1), /invalid_corrode_input/);
});

test("a host can stop applying damage requests on a terminal result and clear remaining fields", () => {
  const w = world();
  let s = create(board(), w, request({ x: 1, y: 1 }, 3)).state;
  s = create(s, w, request({ x: 2, y: 1 }, 3)).state;
  const end = endCorrodeTurn(s, w, [unit("first", { x: 1, y: 1 }, 1), unit("second", { x: 2, y: 1 }, 1)]);
  const applied: string[] = [];
  let finished = false;
  for (const event of end.events) {
    if (event.type !== "corrode_trigger" || finished) continue;
    applied.push(event.unitId);
    finished = true; // Stand-in for the host's actual outcome evaluation.
  }
  assert.deepEqual(applied, ["first"]);
  const cleanup = endCorrodeTurn(end.state, { ...world(2), finished }, []);
  assert.deepEqual(cleanup.state.fields, []);
  assert.deepEqual(cleanup.events.map((event) => event.type), ["corrode_expired", "corrode_expired"]);
});
