import test from "node:test";
import assert from "node:assert/strict";
import { createMatch } from "../src/game/mecha/rules.ts";
import {
  commitSpaceFoldHost, prepareSpaceFoldHost, previewSpaceFoldHost,
  projectSpaceFoldHost, reprojectSpaceFoldHost, type FoldHostState,
} from "../src/game/mecha/skillSpaceFoldHostAdapter.ts";
import type { FoldPair, SpaceFoldIntent } from "../src/game/mecha/skillPhaseField.ts";

const pt = (x: number, y: number) => ({ x, y });
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const mapping: FoldPair[] = [
  { from: pt(4, 2), to: pt(5, 2) },
  { from: pt(5, 2), to: pt(6, 2) },
  { from: pt(6, 2), to: pt(4, 2) },
];
function fixture(): FoldHostState {
  return { version: 1, ledger: { version: 1, pending: null, committed: [] }, match: createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], boss: pt(0, 0),
    mechs: [{ id: "Assault", pos: pt(4, 2) }, { id: "Gunner", pos: pt(5, 2) }, { id: "Support", pos: pt(8, 8) }],
    raiders: [{ id: "r1", pos: pt(6, 2) }],
  }) };
}
function prepared(state = fixture(), pairs = mapping) {
  const p = prepareSpaceFoldHost(state, "fold1", copy(pairs));
  assert.equal(p.status, "prepared", JSON.stringify(p));
  if (p.status !== "prepared") throw Error();
  return p;
}
function resolving() {
  const p = prepared(); p.state.match.phase = "resolving_boss"; p.state.match.revision = 2;
  return p;
}
function preview(state: FoldHostState, intent: SpaceFoldIntent) {
  const p = previewSpaceFoldHost(state, intent);
  assert.equal(p.status, "preview", JSON.stringify(p));
  if (p.status !== "preview") throw Error();
  return p;
}
function reason(result: { status: string; reason?: string }) {
  assert.equal(result.status, "void", JSON.stringify(result)); return result.reason;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); Object.values(value).forEach(deepFreeze);
  }
  return value;
}

test("host facts are deterministic and project every protected board category", () => {
  const s = fixture();
  s.match.covers.push(pt(2, 2)); s.match.obstacles.push(pt(2, 3));
  s.match.terrain[3]![3] = "water"; s.match.terrain[3]![4] = "mountain";
  s.match.buildings.push({ id: "standing", cells: [pt(2, 4)], hp: 2, maxHp: 3 }, { id: "rubble", cells: [pt(3, 4)], hp: 0, maxHp: 3 });
  s.match.deployment = { zone: [pt(7, 7)], reservedCells: [pt(4, 4)] };
  s.match.assaultTerrainSafety = { unsafeCells: [pt(5, 4)], unsafeEdges: [{ from: pt(6, 4), to: pt(7, 4) }] };
  const facts = projectSpaceFoldHost(s); assert.equal(facts.status, "projected"); if (facts.status !== "projected") throw Error();
  assert.deepEqual(facts.world.blocked, [pt(2, 2), pt(2, 3), pt(3, 3), pt(4, 3), pt(2, 4), pt(3, 4), pt(4, 4), pt(5, 4), pt(6, 4), pt(7, 4)]);
  assert.deepEqual(facts.world.units.map(u => u.id), ["boss", "mech:Assault", "mech:Gunner", "mech:Support", "raider:r1"]);
  const reordered = copy(s); reordered.match.mechs.reverse(); reordered.match.buildings.reverse();
  assert.deepEqual(projectSpaceFoldHost(reordered), facts);
  assert.deepEqual(copy(facts), facts);
});

test("prepare, reproject, preview and atomic candidate commit retain fixed targets and all unrelated fields", () => {
  const source = deepFreeze(fixture()), before = copy(source);
  const p = prepared(source, [...mapping].reverse()); assert.deepEqual(source, before);
  assert.notEqual(p.intent, p.state.ledger.pending!.binding);
  assert.notEqual(p.intent.mapping, p.state.ledger.pending!.binding.mapping);
  p.state.match.phase = "player_plan"; p.state.match.revision++;
  assert.equal(reprojectSpaceFoldHost(p.state, p.intent).status, "reprojected");
  p.state.match.phase = "resolving_boss"; p.state.match.revision++;
  const input = deepFreeze(p.state), inputCopy = copy(input), intent = deepFreeze(p.intent);
  const v = preview(input, intent), out = commitSpaceFoldHost(input, intent, v.ticket);
  assert.equal(out.status, "committed", JSON.stringify(out)); if (out.status !== "committed") throw Error();
  assert.deepEqual(input, inputCopy); assert.deepEqual(out.state, v.state); assert.deepEqual(out.events, v.events);
  assert.deepEqual(out.state.match.mechs.map(m => m.pos), [pt(5, 2), pt(6, 2), pt(8, 8)]);
  assert.deepEqual(out.state.match.raiders[0]!.pos, pt(4, 2));
  assert.equal(out.state.match.revision, 3); assert.equal(out.state.ledger.pending, null);
  assert.deepEqual(out.state.ledger.committed, [{ actionId: "fold1", events: out.events }]);
  const originalMatch = copy(input.match), changedMatch = copy(out.state.match);
  originalMatch.revision++; originalMatch.mechs[0]!.pos = pt(5, 2); originalMatch.mechs[1]!.pos = pt(6, 2); originalMatch.raiders[0]!.pos = pt(4, 2);
  assert.deepEqual(changedMatch, originalMatch); assert.deepEqual(copy(out), out);
  out.events.pop(); assert.equal(out.state.ledger.committed[0]!.events.length, 4);
});

test("host revalidates both stored and externally supplied declarations without reselection", () => {
  const p = resolving();
  const changes: Array<(v: SpaceFoldIntent) => void> = [
    v => { v.actionId = "other"; }, v => { v.moves[0]!.unitId = "mech:Support"; },
    v => { v.moves.reverse(); }, v => { v.mapping[0]!.to = pt(4, 2); },
    v => { v.actorCell = pt(2, 0); },
  ];
  for (const change of changes) {
    const bad = copy(p.intent); change(bad);
    assert.equal(reason(reprojectSpaceFoldHost(p.state, bad)), "intent_changed");
    assert.equal(reason(previewSpaceFoldHost(p.state, bad)), "intent_changed");
    const altered = copy(p.state); altered.ledger.pending!.intent = bad;
    assert.equal(reason(reprojectSpaceFoldHost(altered, p.intent)), "intent_changed");
  }
  const altered = copy(p.state); altered.ledger.pending!.binding.actionId = "other";
  assert.equal(reason(reprojectSpaceFoldHost(altered, p.intent)), "intent_changed");
});

test("changed participants, turn, terminal status or protected cells void instead of choosing new targets", () => {
  const cases: Array<[string, (s: FoldHostState) => void, string]> = [
    ["moved", s => { s.match.mechs[0]!.pos = pt(4, 3); }, "target_changed"],
    ["died", s => { s.match.mechs[0]!.hp = 0; }, "target_changed"],
    ["actor moved", s => { s.match.boss.anchor = pt(0, 1); }, "actor_changed"],
    ["turn", s => { s.match.turn++; }, "round_changed"],
    ["ended", s => { s.match.phase = "finished"; }, "inactive_match"],
    ["protected destination", s => { s.match.covers.push(pt(4, 2)); }, "unsafe_occupancy"],
  ];
  for (const [name, change, expected] of cases) {
    const p = resolving(), s = copy(p.state); change(s); const before = copy(s);
    assert.equal(reason(previewSpaceFoldHost(s, p.intent)), expected, name); assert.deepEqual(s, before, name);
  }
});

test("tickets reject races even without a revision increment and never mutate inputs", () => {
  const p = resolving(), v = preview(p.state, p.intent);
  const cases: Array<(s: FoldHostState) => void> = [
    s => { s.match.revision++; }, s => { s.match.mechs[2]!.hp--; },
    s => { s.match.phase = "player_plan"; }, s => { s.match.mechs[2]!.pos = pt(8, 7); },
    s => { s.ledger.pending!.intent.actionId = "tampered"; },
  ];
  for (const change of cases) {
    const s = copy(p.state); change(s); const before = copy(s);
    assert.equal(reason(commitSpaceFoldHost(s, p.intent, v.ticket)), "stale_ticket"); assert.deepEqual(s, before);
  }
  assert.equal(reason(commitSpaceFoldHost(p.state, p.intent, { ...v.ticket, snapshot: "{}" })), "stale_ticket");
  assert.equal(reason(commitSpaceFoldHost(p.state, p.intent, { ...v.ticket, revision: -0 })), "stale_ticket");
  const reordered = JSON.parse(JSON.stringify(p.state, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value)) as FoldHostState;
  assert.equal(commitSpaceFoldHost(reordered, p.intent, v.ticket).status, "committed");
});

test("phase, pending, history and revision limits fail closed", () => {
  const s = fixture(); s.match.phase = "player_plan"; assert.equal(reason(prepareSpaceFoldHost(s, "f", mapping)), "wrong_phase");
  const p = prepared(); assert.equal(reason(prepareSpaceFoldHost(p.state, "f", mapping)), "pending_intent");
  assert.equal(reason(previewSpaceFoldHost(p.state, p.intent)), "wrong_phase");
  p.state.match.phase = "resolving_boss"; p.state.match.revision = 999999999;
  assert.equal(reason(previewSpaceFoldHost(p.state, p.intent)), "revision_exhausted");
  const q = resolving(), v = preview(q.state, q.intent), committed = commitSpaceFoldHost(q.state, q.intent, v.ticket);
  assert.equal(committed.status, "committed"); if (committed.status !== "committed") throw Error();
  assert.equal(reason(commitSpaceFoldHost(committed.state, q.intent, v.ticket)), "stale_ticket");
  const next = copy(committed.state); next.match.phase = "enemy_prepare"; next.match.revision++;
  assert.equal(reason(prepareSpaceFoldHost(next, "fold1", mapping)), "already_resolved");
  const full = fixture();
  full.ledger.committed = Array.from({ length: 256 }, (_, i) => ({ actionId: `f${i}`, events: [{ type: "space_fold_applied" as const, actionId: `f${i}`, mapping: copy(mapping) }] }));
  assert.equal(projectSpaceFoldHost(full).status, "projected");
  assert.equal(reason(prepareSpaceFoldHost(full, "new", mapping)), "history_full");
});

test("boss 2x2 translation is whole-footprint and committed in the same batch", () => {
  const pairs: FoldPair[] = [];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    pairs.push({ from: pt(x, y), to: pt(x + 2, y) }, { from: pt(x + 2, y), to: pt(x, y) });
  }
  const s = fixture();
  assert.equal(reason(prepareSpaceFoldHost(s, "partial", pairs.slice(0, 2))), "partial_footprint");
  const p = prepared(s, pairs); p.state.match.phase = "resolving_boss"; p.state.match.revision++;
  const v = preview(p.state, p.intent), out = commitSpaceFoldHost(p.state, p.intent, v.ticket);
  assert.equal(out.status, "committed", JSON.stringify(out)); if (out.status !== "committed") throw Error();
  assert.deepEqual(out.state.match.boss.anchor, pt(2, 0));
  assert.deepEqual(out.events.map(e => e.type), ["space_fold_applied", "space_fold_move"]);
});

test("facts reject unsupported match mechanics and inconsistent board facts", () => {
  const cases: Array<(s: FoldHostState) => void> = [
    s => { (s.match as any).monsterContent = { speciesId: "field_sovereign", contentVersion: 1 }; },
    s => { s.match.mission = { kind: "rescue:v1", target: pt(3, 3) }; },
    s => { (s.match as any).corrode = {}; }, s => { (s.match as any).neural = {}; },
    s => { (s.match as any).swarm = {}; }, s => { (s.match.boss as any).shield = { kind: "prism_guard", hits: 1 }; },
    s => { (s.match.raiders[0] as any).role = "siege"; }, s => { (s.match.raiders[0] as any).intent = {}; },
    s => { s.match.mechs[1]!.pos = pt(4, 2); }, s => { s.match.covers.push(pt(4, 2)); },
    s => { s.match.boss.anchor = pt(9, 9); }, s => { s.match.mechs[0]!.hp = -1; },
    s => { (s.match.mechs[0] as any).cd = "bad"; }, s => { (s.match.mechs[0] as any).skillUsed = 1; },
    s => { (s.match.boss as any).cadence = -1; }, s => { (s.match as any).preset = "unknown"; },
    s => { s.match.terrain[0]![0] = "lava" as never; }, s => { s.match.heights[0]![0] = NaN; },
    s => { s.match.buildings.push({ id: "x", cells: [pt(2, 2)], hp: 1, maxHp: 1 }, { id: "x", cells: [pt(2, 3)], hp: 1, maxHp: 1 }); },
    s => { s.match.phase = "finished"; }, s => { s.match.boss.hp = 0; },
    s => { (s.match as any).newRule = true; },
  ];
  for (const [index, change] of cases.entries()) { const s = fixture(); change(s); assert.equal(projectSpaceFoldHost(s).status, "void", String(index)); }
});

test("adapter rejects lossy JSON, malformed ledger and unsafe geometry", () => {
  const cases: Array<(s: FoldHostState) => void> = [
    s => { (s.match as any).extra = undefined; },
    s => { Object.defineProperty(s.match, "covers", { get() { throw Error("must not execute"); }, enumerable: true }); },
    s => { (s.match as any).cycle = s; }, s => { s.match.covers = Array(1); },
    s => { s.match.mechs[0]!.pos.x = -0; },
    s => { (s.ledger as any).committed = [{ actionId: "x", events: [] }]; },
    s => { (s.ledger as any).pending = { binding: {}, intent: {}, extra: true }; },
    s => { s.match.assaultTerrainSafety = { unsafeCells: [], unsafeEdges: [{ from: pt(100, 0), to: pt(1, 1) }] }; },
  ];
  for (const [index, change] of cases.entries()) { const s = fixture(); change(s); assert.equal(projectSpaceFoldHost(s).status, "void", String(index)); }
});

test("unit namespaces prevent collisions and no valid state is selected on a protected destination", () => {
  const s = fixture(); s.match.raiders[0]!.id = "boss";
  const f = projectSpaceFoldHost(s); assert.equal(f.status, "projected");
  if (f.status === "projected") assert.ok(f.world.units.some(u => u.id === "raider:boss"));
  const pairs = [{ from: pt(4, 2), to: pt(3, 2) }, { from: pt(3, 2), to: pt(4, 2) }];
  s.match.terrain[2]![3] = "water";
  assert.equal(reason(prepareSpaceFoldHost(s, "blocked", pairs)), "blocked_destination");
});

test("a replacement participant is rejected even when the original destination remains occupied", () => {
  const p = resolving(), s = copy(p.state);
  s.match.raiders[0]!.pos = pt(7, 2); s.match.mechs[2]!.pos = pt(6, 2);
  assert.equal(reason(reprojectSpaceFoldHost(s, p.intent)), "target_changed");
  assert.equal(reason(previewSpaceFoldHost(s, p.intent)), "target_changed");
});

test("maximum bounded event journal remains projectable; malformed order and duplicates do not", () => {
  const cells = Array.from({ length: 64 }, (_, i) => pt(i % 10, Math.floor(i / 10)));
  const pairs = cells.map((from, i) => ({ from, to: cells[(i + 1) % cells.length]! }));
  const s = fixture();
  s.ledger.committed = Array.from({ length: 256 }, (_, i) => {
    const actionId = `max${i}`;
    return { actionId, events: [
      { type: "space_fold_applied" as const, actionId, mapping: copy(pairs) },
      ...pairs.map((p, n) => ({ type: "space_fold_move" as const, actionId, unitId: `u${n}`, from: copy(p.from), to: copy(p.to) })),
    ] };
  });
  assert.equal(projectSpaceFoldHost(s).status, "projected");
  assert.equal(reason(prepareSpaceFoldHost(s, "new", mapping)), "history_full");
  s.ledger.committed[1]!.actionId = s.ledger.committed[0]!.actionId;
  assert.equal(reason(projectSpaceFoldHost(s)), "invalid_adapter_state");
  const bad = fixture(), actionId = "bad";
  bad.ledger.committed.push({ actionId, events: [
    { type: "space_fold_applied", actionId, mapping: copy(mapping) },
    { type: "space_fold_move", actionId, unitId: "mech:Gunner", from: pt(5, 2), to: pt(6, 2) },
    { type: "space_fold_move", actionId, unitId: "mech:Assault", from: pt(4, 2), to: pt(5, 2) },
  ] });
  assert.equal(reason(projectSpaceFoldHost(bad)), "invalid_adapter_state");
});
