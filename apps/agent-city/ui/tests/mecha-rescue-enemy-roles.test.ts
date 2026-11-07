import assert from "node:assert/strict";
import test from "node:test";
import { MECH_IDS, rescueReachable, type ArenaPlan, type MatchState } from "../src/game/mecha/board.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { declaredAttack } from "../src/game/mecha/cellInspection.ts";
import { declaredEnemyIntents, declaredIntentSegments } from "../src/game/mecha/enemyIntentPresentation.ts";
import { remoteStateFromSite } from "../src/game/mecha/contracts/arena.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { applyDeployPlan, bossPrepare, collectTelegraphs, createMatch, playTurn, previewPlan } from "../src/game/mecha/rules.ts";

const buildings = [
  { id: "home1", cells: [{ x: 1, y: 5 }] },
  { id: "home2", cells: [{ x: 7, y: 5 }] },
  { id: "home3", cells: [{ x: 4, y: 3 }] },
];
const mechs = [
  { id: "Assault" as const, pos: { x: 8, y: 8 } },
  { id: "Gunner" as const, pos: { x: 7, y: 8 } },
  { id: "Support" as const, pos: { x: 6, y: 8 } },
];
const raiders = [{ id: "r-a", pos: { x: 1, y: 3 } }, { id: "r-b", pos: { x: 8, y: 3 } }];
const opts = { preset: "covers_sparse_mid" as const, script: "siege" as const, covers: [], boss: { x: 4, y: 0 }, buildings, raiders, mechs };
const skips = (state: MatchState): ArenaPlan => ({ revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) });
const site: CityMechaSite = {
  originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: buildings.map(b => ({ ...b, x: 0, z: 0, yaw: 0, ground: 0, height: 1 })),
  blocked: [], mechs, boss: opts.boss, raiders, spawnSpread: 0,
};
const options = { preset: opts.preset, script: opts.script, stake: "all" as const, mission: "rescue:v1" as const };

function preparedPair() {
  const mixed = createMatch({ ...opts, mission: "rescue:v1" });
  const siegeOnly = structuredClone(mixed);
  siegeOnly.raiders[1]!.role = "siege";
  bossPrepare(mixed); bossPrepare(siegeOnly);
  return { mixed, siegeOnly };
}

test("same map and stats: interceptor pursues a mech instead of the siege building", () => {
  const { mixed, siegeOnly } = preparedPair();
  assert.deepEqual(mixed.raiders.map(r => r.role), ["siege", "interceptor"]);
  assert.deepEqual(mixed.raiders.map(r => r.hp), siegeOnly.raiders.map(r => r.hp));
  assert.deepEqual(mixed.raiders[0]!.pos, siegeOnly.raiders[0]!.pos);
  assert.deepEqual(mixed.raiders[1]!.pos, { x: 8, y: 7 });
  assert.deepEqual(siegeOnly.raiders[1]!.pos, { x: 7, y: 4 });
  assert.deepEqual(mixed.raiders[1]!.intent?.projected, [{ x: 7, y: 8 }]);
  assert.deepEqual(siegeOnly.raiders[1]!.intent?.projected, [{ x: 7, y: 5 }]);
  assert.equal(mixed.raiders[1]!.intent?.skillId, "smash");
  assert.equal(siegeOnly.raiders[1]!.intent?.skillId, "smash");
  assert.deepEqual(preparedPair(), { mixed, siegeOnly });
  const shuffled = createMatch({ ...opts, mission: "rescue:v1", raiders: [...raiders].reverse() });
  assert.deepEqual(Object.fromEntries(shuffled.raiders.map(r => [r.id, r.role])), { "r-b": "interceptor", "r-a": "siege" });
});

test("declared attack cells are the displayed targets and match preview and execution", () => {
  for (const state of Object.values(preparedPair())) {
    const interceptor = state.raiders[1]!;
    const attack = declaredAttack(state, interceptor.id)!;
    assert.deepEqual(attack.targets, interceptor.intent!.projected);
    assert.deepEqual(collectTelegraphs(state).byActor[interceptor.id], attack.targets);
    assert.deepEqual(declaredEnemyIntents(state).find(a => a.actor === interceptor.id), attack);
    assert.deepEqual(declaredIntentSegments(attack).map(s => s.to), attack.targets);
    const before = structuredClone(state);
    const preview = previewPlan(state, skips(state));
    const result = playTurn(state, skips(state));
    assert.ok(preview.ok && result.ok);
    assert.deepEqual(preview.log, result.log);
    assert.deepEqual(preview.stages, result.presentationStages);
    const event = result.log.find(e => e.type === "enemy" && e.actor === interceptor.id);
    assert.ok(event && event.type === "enemy");
    assert.deepEqual(event.cells, attack.targets);
    assert.deepEqual(preview.telegraphByActor[interceptor.id], event.cells);
    assert.deepEqual(state, before);
  }
  const { mixed, siegeOnly } = preparedPair();
  const first = playTurn(mixed, skips(mixed)), second = playTurn(siegeOnly, skips(siegeOnly));
  assert.ok(first.ok && second.ok);
  assert.ok(first.state.mechs.find(m => m.id === "Gunner")!.hp < second.state.mechs.find(m => m.id === "Gunner")!.hp);
  assert.ok(first.state.buildings.find(b => b.id === "home2")!.hp > second.state.buildings.find(b => b.id === "home2")!.hp);
});

test("a declared cell is not a tracking attack when the target moves", () => {
  const { mixed } = preparedPair();
  const plan = skips(mixed);
  plan.items.find(item => item.mechId === "Gunner")!.moveTo = { x: 7, y: 9 };
  const preview = previewPlan(mixed, plan), result = playTurn(mixed, plan);
  assert.ok(preview.ok && result.ok);
  assert.deepEqual(preview.log, result.log);
  const event = result.log.find(e => e.type === "enemy" && e.actor === "r-b");
  assert.ok(event && event.type === "enemy");
  assert.deepEqual(event.cells, [{ x: 7, y: 8 }]);
  assert.equal(event.damage, 0);
});

test("legacy state never gains roles and ignores an injected role without a rescue mission", () => {
  const plain = createMatch(opts), injected = structuredClone(plain);
  assert.ok(plain.raiders.every(r => !Object.hasOwn(r, "role")));
  injected.raiders[1]!.role = "interceptor";
  bossPrepare(plain); bossPrepare(injected);
  delete injected.raiders[1]!.role;
  assert.deepEqual(injected, plain);
  assert.deepEqual(remoteStateFromSite(site, plain), remoteStateFromSite(site, injected));
  assert.ok(remoteStateFromSite(site, plain).raiders.every(r => !Object.hasOwn(r, "role")));
  assert.throws(() => remoteStateFromSite(site, preparedPair().mixed), /remote_match_unsupported/);
});

test("rescue deployment checks the real mixed-enemy opening, not only the original placement", () => {
  const state = createMatch({ ...opts, deployment: true, mission: "rescue:v1" });
  const placements = (xs: number[]) => MECH_IDS.map((mechId, i) => ({ mechId, pos: { x: xs[i]!, y: 8 } }));
  const good = applyDeployPlan(state, { revision: state.revision, placements: placements([0, 1, 2]) });
  assert.ok(good.ok);
  assert.ok(rescueReachable(good.state, state.mission!.target));
  assert.deepEqual(good.state.raiders.map(r => r.role), ["siege", "interceptor"]);
  const rejected = applyDeployPlan(state, { revision: state.revision, placements: placements([5, 6, 7]) });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.fault.code, "rescue_unreachable");
  const opening = structuredClone(state);
  for (const p of placements([5, 6, 7])) opening.mechs.find(m => m.id === p.mechId)!.pos = p.pos;
  opening.phase = "enemy_prepare"; bossPrepare(opening);
  assert.equal(rescueReachable(opening, state.mission!.target), false);
});

test("easy rescue remains a single siege raider; hard rescue assigns stable mixed roles", () => {
  const easy = createMatch({ ...opts, difficulty: "easy", mission: "rescue:v1" });
  assert.deepEqual(easy.raiders.map(r => r.role), ["siege"]);
  const hard = createMatch({ ...opts, difficulty: "hard", mission: "rescue:v1" });
  assert.equal(hard.raiders.length, 4);
  const roster = [...hard.raiders].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  assert.deepEqual(roster.map(r => r.role), ["siege", "interceptor", "siege", "interceptor"]);
  assert.deepEqual(hard, createMatch({ ...opts, difficulty: "hard", mission: "rescue:v1" }));
});
