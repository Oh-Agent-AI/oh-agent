import test from "node:test";
import assert from "node:assert/strict";
import { createMatch, bossPrepare, playTurn, MECH_IDS, type MatchState } from "../src/game/mecha/rules.ts";
import { applyDeployPlan, validateDeployPlan, deployableCells, type DeployPlan } from "../src/game/mecha/deployment.ts";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { initialPveMatch } from "../src/game/mecha/session/MatchSession.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { pveRules } from "../src/game/mecha/rules/pve.ts";
import { presentBattleLegend } from "../src/game/mecha/legendPresentation.ts";

const fresh = () => createMatch({ preset: "covers_sparse_mid", script: "siege", deployment: true });
const plan = (s: MatchState): DeployPlan => ({ revision: s.revision, placements: MECH_IDS.map((mechId, x) => ({ mechId, pos: { x: x * 3, y: 8 } })) });
function expectFault(s: MatchState, p: DeployPlan, code: string) {
  const before = structuredClone(s), packet = structuredClone(p);
  const result = applyDeployPlan(s, p);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.code, code);
  assert.deepEqual(s, before); assert.deepEqual(p, packet);
}

test("deployment initializes without enemy intentions and cannot advance by ordinary plans", () => {
  const s = fresh(), before = structuredClone(s);
  bossPrepare(s);
  assert.deepEqual(s, before);
  assert.equal(s.boss.intent, null);
  assert.ok(s.raiders.every(r => !r.intent));
  assert.equal(pveRules.activeSide(s), null);
  assert.equal(playTurn(s, { revision: 0, items: [] }).ok, false);
  assert.deepEqual(s, before);
});

test("deployment commits atomically, advances revision once, and prepares from chosen positions", () => {
  const s = fresh(), packet = plan(s), before = structuredClone(s);
  const result = pveRules.deploy!(s, packet);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(s, before);
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.turn, 1);
  assert.equal(result.state.phase, "player_plan");
  assert.deepEqual(result.state.mechs.map(m => m.pos), packet.placements.map(p => p.pos));
  const expected = structuredClone(before);
  expected.mechs.forEach(m => { m.pos = { ...packet.placements.find(p => p.mechId === m.id)!.pos }; });
  expected.phase = "enemy_prepare"; bossPrepare(expected);
  delete expected.deployment;
  assert.equal(Object.hasOwn(result.state, "deployment"), false);
  assert.deepEqual(result.state, expected);
  expectFault(result.state, packet, "phase");
  packet.placements[0].pos.x = 9;
  assert.equal(result.state.mechs[0].pos.x, 0);
});

test("incomplete, stale, duplicate mech and duplicate cells are rejected", () => {
  const s = fresh(), p = plan(s);
  expectFault(s, { ...p, revision: -1 }, "revision");
  expectFault(s, { ...p, placements: p.placements.slice(0, 2) }, "incomplete");
  expectFault(s, { ...p, placements: [p.placements[0], p.placements[0], p.placements[2]] }, "duplicate_mech");
  expectFault(s, { ...p, placements: p.placements.map(q => ({ ...q, pos: p.placements[0].pos })) }, "duplicate_cell");
});

test("deployment rejects off-board, fractional and non-zone coordinates", () => {
  for (const [pos, fault] of [[{ x: -1, y: 8 }, "invalid_cell"], [{ x: 0.5, y: 8 }, "invalid_cell"], [{ x: 0, y: 7 }, "outside_zone"]] as const) {
    const s = fresh(), p = plan(s); p.placements[0].pos = { ...pos }; expectFault(s, p, fault);
  }
});

test("water, mountain and sampled unsafe land cannot be deployed on", () => {
  for (const terrain of ["water", "mountain"] as const) {
    const s = fresh(); s.terrain[8][0] = terrain; expectFault(s, plan(s), "terrain");
  }
  const s = fresh(); s.assaultTerrainSafety = { unsafeCells: [{ x: 0, y: 8 }], unsafeEdges: [] };
  expectFault(s, plan(s), "unsafe");
  assert.ok(!deployableCells(s).some(c => c.x === 0 && c.y === 8));
});

test("building, cover, obstacle, boss, raider and reserved reinforcement cells are excluded", () => {
  const at = { x: 0, y: 8 };
  for (const block of ["building", "cover", "obstacle", "boss", "raider", "reserved"]) {
    const s = fresh();
    if (block === "building") s.buildings.push({ id: "rear", cells: [at], hp: 10, maxHp: 10 });
    if (block === "cover") s.covers.push(at);
    if (block === "obstacle") s.obstacles.push(at);
    if (block === "boss") s.boss.anchor = at;
    if (block === "raider") s.raiders.push({ id: "rear", pos: at, hp: 8, intent: null });
    if (block === "reserved") s.deployment!.reservedCells.push(at);
    expectFault(s, plan(s), block === "reserved" ? "reserved" : "occupied");
  }
});

test("undersized deployment zone does not silently expand or start play", () => {
  const s = fresh(); s.deployment!.zone = [{ x: 0, y: 8 }, { x: 1, y: 8 }];
  expectFault(s, plan(s), "insufficient_space");
  const c = createMechaController({ match: s });
  assert.equal(c.getState().deployment?.canConfirm, false);
  assert.match(c.getState().deployment!.error!, /没有足够/);
});

test("controller placement stays a draft, swaps placed units, and undo/reset do not spend turn reset", () => {
  const s = fresh(), c = createMechaController({ match: s });
  c.placeMech("Assault", { x: 0, y: 8 }); c.placeMech("Gunner", { x: 3, y: 8 });
  const prior = c.getState().deployment!.placements;
  c.placeMech("Assault", { x: 3, y: 8 });
  assert.deepEqual(c.getState().deployment!.placements.map(p => p.pos), [{ x: 3, y: 8 }, { x: 0, y: 8 }]);
  c.undoDeployment(); assert.deepEqual(c.getState().deployment!.placements, prior);
  c.resetDeployment(); assert.deepEqual(c.getState().deployment!.placements, []);
  c.undoDeployment(); assert.deepEqual(c.getState().deployment!.placements, prior);
  assert.equal(c.getState().resetTurnUsed, false);
  assert.equal(c.getState().match, s);
  assert.equal(s.boss.intent, null);
});

test("unplaced units cannot displace another mech, invalid clicks retain the draft and report why", () => {
  const c = createMechaController({ match: fresh() });
  c.placeMech("Assault", { x: 0, y: 8 });
  const prior = c.getState().deployment!.placements;
  c.placeMech("Gunner", { x: 0, y: 8 });
  assert.deepEqual(c.getState().deployment!.placements, prior);
  assert.match(c.getState().deployment!.error!, /同一格/);
  c.clickCell(0, 0);
  assert.deepEqual(c.getState().deployment!.placements, prior);
  assert.match(c.getState().deployment!.error!, /部署区/);
});

test("deployment blocks auto, doctrine, ordinary actions, submit and normal undo/reset", () => {
  let calls = 0;
  const c = createMechaController({ match: fresh(), planner: () => { calls++; throw Error("planner cannot run in deployment"); } });
  c.startAuto(); c.tick(); c.applyDoctrine(); c.setMove("Assault", { x: 0, y: 8 }); c.setAction("Assault", { kind: "skip" }); c.submit(); c.resetTurn(); c.undoMove();
  assert.equal(calls, 0); assert.equal(c.getState().auto, false);
  assert.equal(c.getState().match.phase, "deployment"); assert.deepEqual(c.getState().deployment!.placements, []);
  assert.equal(c.getState().resetTurnUsed, false);
  assert.deepEqual(c.getState().actions, []); assert.deepEqual(c.getState().reach, []);
});

test("all three placements enable confirmation, create the first plan, and restart returns to deployment", () => {
  const c = createMechaController({ deployment: true });
  c.confirmDeployment(); assert.equal(c.getState().match.phase, "deployment");
  for (const p of plan(c.getState().match).placements) c.placeMech(p.mechId, p.pos);
  assert.equal(c.getState().deployment?.canConfirm, true);
  c.confirmDeployment();
  assert.equal(c.getState().match.phase, "player_plan"); assert.equal(c.getState().deployment, null);
  assert.equal(c.getState().interactive, true); assert.equal(c.getState().match.revision, 1);
  assert.equal(c.getState().openingSuggestion, true);
  c.confirmDeployment(); assert.equal(c.getState().match.revision, 1);
  c.restart(); assert.equal(c.getState().match.phase, "deployment"); assert.equal(c.getState().deployment!.placements.length, 0);
});

test("saved deployment snapshots restore without prematurely preparing enemies", () => {
  const s = JSON.parse(JSON.stringify(fresh()));
  const c = createMechaController({ match: s });
  assert.equal(c.getState().match.phase, "deployment");
  assert.equal(c.getState().match.boss.intent, null);
  assert.equal(validateDeployPlan(s, plan(s)).ok, true);
  assert.deepEqual(c.getState().deployment!.placements, []);
});

test("paused deployment is locked; resume does not clear its placements", () => {
  const c = createMechaController({ match: fresh() });
  c.placeMech("Assault", { x: 0, y: 8 }); c.pause(); c.placeMech("Gunner", { x: 3, y: 8 }); c.confirmDeployment();
  assert.equal(c.getState().deployment!.placements.length, 1); c.resume();
  assert.equal(c.getState().deployment!.interactive, true);
});

test("deployment legend shows only deployment cues, not unknown prediction or enemy warnings", () => {
  const legend = presentBattleLegend({ deployment: true, reach: [{ x: 0, y: 8 }], move: null, declaredTelegraph: [], projectedTelegraph: null }, "en");
  assert.deepEqual(legend.threats, []); assert.equal(legend.actions.length, 1); assert.equal(legend.actions[0].label, "Deployment zone");
});


test("a failed opening planner cannot strand an accepted deployment", () => {
  const c = createMechaController({ match: fresh(), planner: () => { throw Error("planner unavailable"); } });
  for (const p of plan(c.getState().match).placements) c.placeMech(p.mechId, p.pos);
  assert.doesNotThrow(() => c.confirmDeployment());
  const state = c.getState();
  assert.equal(state.match.phase, "player_plan"); assert.equal(state.match.revision, 1);
  assert.equal(state.deployment, null); assert.equal(state.interactive, true);
  assert.equal(state.openingSuggestion, false);
  assert.match(state.notice!, /部署已确认/);
});

test("deployment rejection is translated using the current locale", () => {
  const c = createMechaController({ match: fresh() });
  c.placeMech("Assault", { x: 0, y: 1 });
  assert.match(c.getState().deployment!.error!, /部署区/);
  c.setLocale("en"); assert.match(c.getState().deployment!.error!, /Outside the deployment zone/);
});


test("the city entry defaults to deployment and restarts into the same declared zone", () => {
  const seed = fresh();
  const site: CityMechaSite = {
    originX: 10, originZ: 20, yaw: 0, cellW: 8, cellD: 8,
    terrain: seed.terrain, heights: seed.heights!, buildings: [], blocked: [],
    mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: i === 0 ? 7 : 9 } })),
    boss: seed.boss.anchor, raiders: [], spawnSpread: 0,
  };
  const c = createMechaController({ site });
  const opening = c.getState().match;
  assert.equal(opening.phase, "deployment"); assert.equal(opening.boss.intent, null);
  assert.equal(opening.deployment!.zone.length, 30);
  assert.ok(opening.deployment!.zone.every(cell => cell.y >= 7));
  c.placeMech("Assault", { x: 0, y: 7 }); c.restart();
  assert.equal(c.getState().match.phase, "deployment");
  assert.deepEqual(c.getState().match.deployment, opening.deployment);
  assert.deepEqual(c.getState().deployment!.placements, []);
});

test("session initialization preserves a serialized deployment phase and revision", () => {
  const state = fresh();
  const initialized = initialPveMatch(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(initialized, state); assert.notEqual(initialized, state);
  assert.equal(initialized.phase, "deployment"); assert.equal(initialized.revision, 0);
  assert.equal(initialized.boss.intent, null);
});


test("deployment and planning project actual positions separately from movement markers", async () => {
  const { projectMechPositions, projectPlannedMoves } = await import("../src/game/mecha/presentation/mechPositions.ts");
  const c = createMechaController({ match: fresh() });
  const packet = plan(c.getState().match);
  assert.deepEqual(projectMechPositions(c.getState().match), [], "deployment placeholders are never actual actors");
  assert.deepEqual(projectMechPositions(c.getState().match, []), []);
  for (const p of packet.placements) c.placeMech(p.mechId, p.pos);
  const placed = projectMechPositions(c.getState().match, c.getState().deployment!.placements);
  c.confirmDeployment();
  const s = c.getState(), before = structuredClone(s.match);
  assert.equal(s.openingSuggestion, true, "suggestions remain available without moving actual actors");
  assert.deepEqual(projectMechPositions(s.match).map(m => m.pos), placed.map(m => m.pos));
  const moves = projectPlannedMoves(s.match, s.draft);
  assert.ok(moves.length > 0, "exercise a real suggested move, not an all-hold fixture");
  for (const move of moves) {
    assert.deepEqual(move.from, s.match.mechs.find(m => m.id === move.id)!.pos);
    assert.deepEqual(move.to, s.draft[move.id].moveTo);
    assert.notDeepEqual(move.from, move.to);
  }
  const selected = s.selected;
  c.setMove(selected, null);
  assert.deepEqual(projectMechPositions(c.getState().match).map(m => m.pos), placed.map(m => m.pos));
  assert.deepEqual(s.match, before, "projection and draft edits cannot mutate the authoritative board");
  assert.deepEqual(projectPlannedMoves(s.match, {}), []);
  assert.deepEqual(projectPlannedMoves({ ...s.match, phase: "deployment" }, s.draft), []);
  const projected = projectMechPositions(s.match);
  projected[0].pos.x = -1;
  assert.deepEqual(s.match, before, "projected positions do not alias authoritative coordinates");
});


test("submitted deployment opening plays from committed cells and settles to the authority result", async () => {
  const { projectMechPositions, projectPlannedMoves } = await import("../src/game/mecha/presentation/mechPositions.ts");
  const c = createMechaController({ match: fresh(), animate: true });
  for (const p of plan(c.getState().match).placements) c.placeMech(p.mechId, p.pos);
  c.confirmDeployment();
  const deployed = c.getState().match.mechs.map(m => ({ ...m.pos }));
  assert.ok(projectPlannedMoves(c.getState().match, c.getState().draft).length);
  c.submit();
  const playing = c.getState();
  assert.ok(playing.performance, "a submitted move has an actual playback");
  assert.deepEqual(projectMechPositions(playing.performance!.before).map(m => m.pos), deployed);
  assert.notDeepEqual(playing.match.mechs.map(m => m.pos), deployed, "the authority executes the submitted plan");
  const settled = structuredClone(playing.match);
  c.finishPerformance();
  assert.equal(c.getState().performance, null);
  assert.deepEqual(c.getState().match, settled);
  assert.deepEqual(projectPlannedMoves(c.getState().match, c.getState().draft), []);
});
