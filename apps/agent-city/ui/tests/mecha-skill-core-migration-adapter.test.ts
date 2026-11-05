import { commitCoreMigrationHostState } from "../src/game/mecha/coreMigrationHostState.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  captureL9MatchSnapshot, prepareL9Migration, projectL9Migration, proposeL9Migration, commitL9Migration,
  type L9AtomicHost, type L9HostSnapshot, type L9Projection, type L9Proposal, type L9Transition,
} from "../src/game/mecha/skillCoreMigrationAdapter.ts";
import { createMatch } from "../src/game/mecha/rules.ts";
import type { MigrationIntent } from "../src/game/mecha/skillCoreMigration.ts";

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const c = (x: number, y: number) => ({ x, y });
const snapshot = (): L9HostSnapshot => ({
  version: 1, matchId: "match_1", revision: 3, turn: 4, phase: "enemy_prepare", outcome: null,
  boss: { anchor: c(4, 4), hp: 20, maxHp: 20 },
  board: { terrain: Array.from({ length: 10 }, () => Array(10).fill("land")), covers: [], obstacles: [], buildings: [],
    mechs: [{ id: "Assault", pos: c(0, 0), hp: 5 }], raiders: [{ id: "raider_1", pos: c(9, 9), hp: 8 }] },
  ledger: { version: 1, phaseId: "phase_1", currentCoreId: "a", skills: ["guard"], migrations: [], pending: null,
    cores: [{ id: "a", offset: c(0, 0), alive: true }, { id: "b", offset: c(1, 0), alive: true },
      { id: "c", offset: c(0, 1), alive: true }] },
});
const transition = (): L9Transition => ({ phaseId: "phase_1", targetCoreId: "b", nextPhaseId: "phase_2", threshold: 10, nextSkills: ["pierce", "sweep"] });
function prepared(s = snapshot()) {
  const result = prepareL9Migration(s, transition(), "migration_1");
  assert.equal(result.status, "planned");
  if (result.status !== "planned") throw new Error(result.reason);
  s.ledger.pending = result.pending;
  s.phase = "resolving_boss"; s.boss.hp = 10; s.revision++;
  return { s, intent: result.intent };
}
function projection(s: L9HostSnapshot, intent: MigrationIntent): L9Projection {
  const result = projectL9Migration(s, intent);
  assert.equal(result.status, "reprojected");
  if (result.status !== "reprojected") throw new Error(result.reason);
  return result;
}
function proposal(s: L9HostSnapshot, intent: MigrationIntent, expected: L9Projection): L9Proposal {
  const result = proposeL9Migration(s, intent, expected);
  assert.equal(result.status, "proposed");
  if (result.status !== "proposed") throw new Error(result.reason);
  return result.proposal;
}

test("host facts project a fixed 2x2 core binding and only the declared ledger changes", () => {
  const original = snapshot(), before = copy(original);
  const plan = prepareL9Migration(original, transition(), "migration_1");
  assert.equal(plan.status, "planned"); if (plan.status !== "planned") throw Error();
  assert.deepEqual(original, before);
  assert.deepEqual(plan.pending.anchor, c(4, 4));
  assert.deepEqual(plan.intent.sourceCoreCell, c(4, 4));
  assert.deepEqual(plan.intent.targetCoreCell, c(5, 4));
  const s = copy(original); s.ledger.pending = copy(plan.pending); s.phase = "resolving_boss"; s.boss.hp = 10; s.revision++;
  const view = projection(s, plan.intent), p = proposal(s, plan.intent, view);
  assert.deepEqual(view.footprint, [c(4, 4), c(5, 4), c(4, 5), c(5, 5)]);
  assert.deepEqual(p.nextLedger, { ...s.ledger, phaseId: "phase_2", currentCoreId: "b", skills: ["pierce", "sweep"],
    migrations: [{ id: "migration_1", phaseId: "phase_1" }], pending: null });
  assert.deepEqual(p.events.map(e => e.type), ["core_migrated", "phase_changed", "skills_changed"]);
  assert.equal(p.expectedRevision, 4); assert.equal(p.nextRevision, 5);
  assert.deepEqual(copy({ plan, view, p }), { plan, view, p });
  assert.deepEqual(s.board, original.board); assert.deepEqual(s.boss, { ...original.boss, hp: 10 });
  p.nextLedger.cores[0]!.offset.x = 1;
  assert.deepEqual(s.ledger.cores[0]!.offset, c(0, 0));
  plan.intent.nextSkills[0] = "other";
  assert.deepEqual(plan.pending.binding.nextSkills, ["pierce", "sweep"]);
});

test("board rejects water, cover, obstacles, buildings and living occupants under any boss cell", () => {
  const changes: Array<(s: L9HostSnapshot) => void> = [
    s => { s.board.terrain[4]![5] = "water"; }, s => { s.board.covers.push(c(4, 4)); },
    s => { s.board.obstacles.push(c(5, 5)); }, s => { s.board.buildings.push({ id: "rubble", cells: [c(4, 5)] }); },
    s => { s.board.mechs[0]!.pos = c(4, 4); }, s => { s.board.raiders[0]!.pos = c(5, 4); },
  ];
  for (const change of changes) {
    const s = snapshot(); change(s);
    assert.deepEqual(prepareL9Migration(s, transition(), "id"), { status: "void", reason: "invalid_boss_footprint" });
    const p = prepared(); change(p.s); const before = copy(p.s);
    assert.deepEqual(projectL9Migration(p.s, p.intent), { status: "void", reason: "invalid_boss_footprint" });
    assert.deepEqual(p.s, before);
  }
  const allowed = snapshot(); allowed.board.terrain[4]![4] = "mountain";
  allowed.board.mechs[0]!.pos = c(4, 4); allowed.board.mechs[0]!.hp = 0;
  assert.equal(prepareL9Migration(allowed, transition(), "id").status, "planned");
  const edge = snapshot(); edge.boss.anchor = c(8, 8); edge.board.raiders[0]!.pos = c(7, 7);
  assert.equal(prepareL9Migration(edge, transition(), "id").status, "planned");
  edge.boss.anchor = c(9, 8);
  assert.deepEqual(prepareL9Migration(edge, transition(), "id"), { status: "void", reason: "invalid_snapshot" });
});

test("binding, match, anchor, target and actor changes fail closed without retargeting", () => {
  const changes: Array<[string, (s: L9HostSnapshot, i: MigrationIntent) => void, string]> = [
    ["public target", (_s, i) => { i.targetCoreId = "c"; }, "intent_changed"],
    ["public skills", (_s, i) => { i.nextSkills[0] = "other"; }, "intent_changed"],
    ["match", s => { s.matchId = "another"; }, "match_changed"],
    ["anchor", s => { s.boss.anchor = c(5, 5); }, "boss_moved"],
    ["dead core", s => { s.ledger.cores[1]!.alive = false; }, "target_unavailable"],
    ["removed core", s => { s.ledger.cores.splice(1, 1); }, "target_unavailable"],
    ["replacement", s => { s.ledger.cores[1]!.id = "replacement"; }, "target_unavailable"],
    ["moved core", s => { s.ledger.cores[1]!.offset = c(1, 1); }, "target_changed"],
    ["dead actor", s => { s.boss.hp = 0; }, "actor_unavailable"],
    ["round", s => { s.turn++; }, "round_changed"],
    ["outcome", s => { s.outcome = "defeat_buildings"; }, "inactive"],
  ];
  for (const [name, change, reason] of changes) {
    const { s, intent } = prepared(), view = projection(s, intent); change(s, intent); const before = copy(s);
    assert.deepEqual(projectL9Migration(s, intent), { status: "void", reason }, name);
    assert.deepEqual(proposeL9Migration(s, intent, view), { status: "void", reason }, name);
    assert.deepEqual(s, before, name);
  }
});

test("prepare and resolution enforce phase, threshold, pending and stale projection", () => {
  const early = snapshot(); early.phase = "deployment";
  assert.deepEqual(prepareL9Migration(early, transition(), "id"), { status: "void", reason: "inactive" });
  early.phase = "player_plan";
  assert.deepEqual(prepareL9Migration(early, transition(), "id"), { status: "void", reason: "wrong_phase" });
  early.phase = "enemy_prepare"; early.boss.hp = 10;
  assert.deepEqual(prepareL9Migration(early, transition(), "id"), { status: "void", reason: "threshold_already_reached" });
  const { s, intent } = prepared(), view = projection(s, intent);
  const repeat = copy(s); repeat.phase = "enemy_prepare";
  assert.deepEqual(prepareL9Migration(repeat, transition(), "id2"), { status: "void", reason: "pending_exists" });
  const invalid = copy(s); invalid.ledger.pending = null;
  assert.deepEqual(projectL9Migration(invalid, intent), { status: "void", reason: "missing_binding" });
  const notReached = copy(s); notReached.boss.hp = 11;
  assert.deepEqual(projectL9Migration(notReached, intent), { status: "void", reason: "threshold_not_reached" });
  const wrongPhase = copy(s); wrongPhase.phase = "player_plan";
  assert.deepEqual(proposeL9Migration(wrongPhase, intent, projection(wrongPhase, intent)), { status: "void", reason: "wrong_phase" });
  for (const edit of [
    (v: L9Projection) => { v.revision++; }, (v: L9Projection) => { v.footprint[0]!.x++; },
    (v: L9Projection) => { v.migration.hp--; }, (v: L9Projection) => { (v as any).extra = 1; },
  ]) {
    const stale = copy(view); edit(stale);
    assert.deepEqual(proposeL9Migration(s, intent, stale), { status: "void", reason: "stale_projection" });
  }
  const exhausted = copy(s); exhausted.revision = 1_000_000;
  assert.deepEqual(proposeL9Migration(exhausted, intent, projection(exhausted, intent)), { status: "void", reason: "revision_exhausted" });
});

test("untrusted malformed data fails before getters, cloning or mutation", () => {
  const bad = snapshot(); let calls = 0;
  Object.defineProperty(bad.boss, "hp", { enumerable: true, get() { calls++; return 20; } });
  assert.deepEqual(prepareL9Migration(bad, transition(), "id"), { status: "void", reason: "invalid_snapshot" });
  assert.equal(calls, 0);
  const sparse = snapshot(); sparse.board.terrain[0] = Array(10);
  assert.deepEqual(prepareL9Migration(sparse, transition(), "id"), { status: "void", reason: "invalid_snapshot" });
  const prototype = snapshot(); Object.setPrototypeOf(prototype.board.covers, { toJSON: () => [] });
  assert.deepEqual(prepareL9Migration(prototype, transition(), "id"), { status: "void", reason: "invalid_snapshot" });
  const off = snapshot(); off.ledger.cores[1]!.offset = c(2, 0);
  assert.deepEqual(prepareL9Migration(off, transition(), "id"), { status: "void", reason: "invalid_snapshot" });
  const { s, intent } = prepared(), view = projection(s, intent);
  const malformed = copy(intent); (malformed as any).nextSkills = ["pierce", undefined];
  assert.deepEqual(projectL9Migration(s, malformed), { status: "void", reason: "invalid_intent" });
  const v = copy(view); Object.defineProperty(v, "revision", { enumerable: true, get() { calls++; return 4; } });
  assert.deepEqual(proposeL9Migration(s, intent, v), { status: "void", reason: "stale_projection" });
  assert.equal(calls, 0);
});

test("one CAS applies ledger and events together; conflicts never emit or retry", () => {
  const { s, intent } = prepared(), view = projection(s, intent), before = copy(s);
  let current = copy(s), journal: unknown[] = [], calls = 0;
  const host: L9AtomicHost = {
    read: () => copy(current),
    compareAndCommit: p => {
      calls++;
      if (current.matchId !== p.matchId || current.revision !== p.expectedRevision ||
          JSON.stringify(current.ledger.pending) !== JSON.stringify(p.expectedPending)) return false;
      current = { ...current, revision: p.nextRevision, ledger: copy(p.nextLedger) };
      journal = [...journal, ...copy(p.events)];
      return true;
    },
  };
  const result = commitL9Migration(host, intent, view);
  assert.equal(result.status, "committed"); assert.equal(calls, 1);
  assert.equal(current.ledger.currentCoreId, "b"); assert.equal(current.ledger.pending, null);
  assert.equal(current.revision, 5); assert.equal(journal.length, 3);
  assert.deepEqual(commitL9Migration(host, intent, view), { status: "void", reason: "missing_binding" });
  assert.equal(calls, 1); assert.equal(journal.length, 3); assert.deepEqual(s, before);
  current = copy(s); journal = []; calls = 0;
  const race: L9AtomicHost = { read: () => copy(current), compareAndCommit: p => {
    calls++; current.revision++; // concurrent unrelated commit, before atomic comparison
    if (current.revision !== p.expectedRevision) return false;
    throw new Error("must not write");
  } };
  assert.deepEqual(commitL9Migration(race, intent, view), { status: "void", reason: "commit_conflict" });
  assert.equal(calls, 1); assert.deepEqual(journal, []); assert.deepEqual(current.ledger, before.ledger);
});


test("captures selected facts from a real MatchState without sharing mutable objects", () => {
  const match = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [c(1, 1)],
    obstacles: [c(2, 2)], buildings: [{ id: "house", cells: [c(3, 3)], hp: 0 }],
    raiders: [{ id: "raider_1", pos: c(8, 8), hp: 7 }], boss: c(4, 4),
    mechs: [{ id: "Assault", pos: c(0, 9) }, { id: "Gunner", pos: c(1, 9) }, { id: "Support", pos: c(2, 9) }] });
  match.terrain[0]![0] = "water";
  const ledger = snapshot().ledger;
  const result = captureL9MatchSnapshot(match, "match_real", 40, ledger);
  assert.equal(result.status, "captured"); if (result.status !== "captured") throw Error(result.reason);
  const s = result.snapshot;
  assert.deepEqual(s.board, { terrain: match.terrain, covers: [c(1, 1)], obstacles: [c(2, 2)],
    buildings: [{ id: "house", cells: [c(3, 3)] }],
    mechs: match.mechs.map(({ id, pos, hp }) => ({ id, pos, hp })),
    raiders: [{ id: "raider_1", pos: c(8, 8), hp: 7 }] });
  assert.deepEqual(s.boss, { anchor: c(4, 4), hp: 40, maxHp: 40 });
  assert.equal(s.revision, match.revision); assert.equal(s.turn, match.turn); assert.equal(s.phase, match.phase);
  assert.equal(prepareL9Migration(s, { ...transition(), threshold: 20 }, "real_1").status, "planned");
  match.terrain[0]![0] = "land"; match.boss.anchor.x = 1; match.mechs[0]!.pos.x = 5; ledger.cores[0]!.offset.x = 1;
  assert.equal(s.board.terrain[0]![0], "water"); assert.deepEqual(s.boss.anchor, c(4, 4));
  assert.deepEqual(s.board.mechs[0]!.pos, c(0, 9)); assert.deepEqual(s.ledger.cores[0]!.offset, c(0, 0));
  assert.deepEqual(copy(s), s);
});

test("capture refuses missing or accessor-backed selected facts, including nested arrays", () => {
  const make = () => createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [],
    buildings: [{ id: "house", cells: [c(0, 0)] }], boss: c(4, 4) });
  let calls = 0;
  const cases = [
    (s: ReturnType<typeof make>) => { delete (s as any).obstacles; },
    (s: ReturnType<typeof make>) => { Object.defineProperty(s, "terrain", { enumerable: true, get() { calls++; return []; } }); },
    (s: ReturnType<typeof make>) => { Object.defineProperty(s.boss, "hp", { enumerable: true, get() { calls++; return 40; } }); },
    (s: ReturnType<typeof make>) => { Object.defineProperty(s.buildings[0]!, "cells", { enumerable: true, get() { calls++; return []; } }); },
    (s: ReturnType<typeof make>) => { Object.defineProperty(s.mechs, "0", { enumerable: true, get() { calls++; return {}; } }); },
    (s: ReturnType<typeof make>) => { Object.defineProperty(s.mechs[0]!.pos, "x", { enumerable: true, get() { calls++; return 1; } }); },
  ];
  for (const edit of cases) {
    const s = make(); edit(s);
    assert.deepEqual(captureL9MatchSnapshot(s, "match_real", 40, snapshot().ledger), { status: "void", reason: "invalid_snapshot" });
  }
  assert.equal(calls, 0);
  const s = make(); s.terrain[0]![0] = "bog" as any;
  assert.deepEqual(captureL9MatchSnapshot(s, "match_real", 40, snapshot().ledger), { status: "void", reason: "invalid_snapshot" });
});

test("atomic host rejects changed pending binding even when the revision is unchanged", () => {
  const { s, intent } = prepared(), view = projection(s, intent);
  let current = copy(s), calls = 0, journal: unknown[] = [];
  const host: L9AtomicHost = {
    read: () => copy(current),
    compareAndCommit: p => {
      calls++;
      current.ledger.pending!.binding.migrationId = "other"; // simulate a broken external writer
      if (current.matchId !== p.matchId || current.revision !== p.expectedRevision ||
          JSON.stringify(current.ledger.pending) !== JSON.stringify(p.expectedPending)) return false;
      current = { ...current, revision: p.nextRevision, ledger: copy(p.nextLedger) };
      journal = [...journal, ...copy(p.events)]; return true;
    },
  };
  assert.deepEqual(commitL9Migration(host, intent, view), { status: "void", reason: "commit_conflict" });
  assert.equal(calls, 1); assert.equal(current.revision, s.revision); assert.deepEqual(journal, []);
  assert.equal(current.ledger.currentCoreId, s.ledger.currentCoreId);
});


test("MatchState capture follows the declared binding through JSON restore and changed board facts", () => {
  const match = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [],
    obstacles: [], buildings: [], raiders: [], boss: c(4, 4) });
  let ledger = snapshot().ledger;
  const capture = () => {
    const result = captureL9MatchSnapshot(match, "match_real", 40, ledger);
    assert.equal(result.status, "captured"); if (result.status !== "captured") throw Error(result.reason);
    return result.snapshot;
  };
  const plan = prepareL9Migration(capture(), { ...transition(), threshold: 20 }, "real_lifecycle");
  assert.equal(plan.status, "planned"); if (plan.status !== "planned") throw Error(plan.reason);
  ledger.pending = copy(plan.pending); match.revision++; // simulated atomic host preparation
  match.phase = "resolving_boss"; match.boss.hp = 20; match.revision++;
  let state = copy(capture()), intent = copy(plan.intent);
  const view = projection(state, intent);
  const p = proposal(state, intent, copy(view));
  assert.equal(p.nextLedger.currentCoreId, "b");
  assert.deepEqual(p.events.map(e => e.type), ["core_migrated", "phase_changed", "skills_changed"]);
  match.obstacles.push(c(5, 4)); match.revision++;
  state = capture();
  assert.deepEqual(projectL9Migration(state, intent), { status: "void", reason: "invalid_boss_footprint" });
  assert.deepEqual(proposeL9Migration(state, intent, view), { status: "void", reason: "invalid_boss_footprint" });
  match.obstacles = []; match.revision++;
  state = capture();
  assert.deepEqual(proposeL9Migration(state, intent, view), { status: "void", reason: "stale_projection" });
  ledger.cores[1]!.alive = false; match.revision++;
  assert.deepEqual(projectL9Migration(capture(), intent), { status: "void", reason: "target_unavailable" });
});


test("durable host applies ledger and events atomically and rejects stale proposals", () => {
  const { s, intent } = prepared(), view = projection(s, intent);
  const proposed = proposeL9Migration(s, intent, view);
  assert.equal(proposed.status, "proposed");
  if (proposed.status !== "proposed") throw new Error(proposed.reason);
  const current = { version: { matchId: s.matchId, revision: s.revision }, ledger: copy(s.ledger), events: [] };
  const before = copy(current);
  const result = commitCoreMigrationHostState(current, proposed.proposal);
  assert.ok(result);
  assert.equal(result.ledger.currentCoreId, "b");
  assert.equal(result.events.length, 3);
  assert.equal(result.version.revision, s.revision + 1);
  assert.deepEqual(current, before);
  assert.equal(commitCoreMigrationHostState(result, proposed.proposal), null);
  const changed = copy(current); changed.ledger.pending!.binding.migrationId = "changed";
  assert.equal(commitCoreMigrationHostState(changed, proposed.proposal), null);
});
