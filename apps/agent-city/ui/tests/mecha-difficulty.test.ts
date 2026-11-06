import assert from "node:assert/strict";
import { test } from "node:test";
import { planForDoctrine } from "../src/game/mecha/ai.ts";
import { siteMechaWindow, type SiteAnchor } from "../src/game/mecha/citySite.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { inspectCell } from "../src/game/mecha/cellInspection.ts";
import { ENEMY_STATS, bossDamageTo, bossExecute, bossPrepare, buildingDamage, createMatch, enemyStatsOf, incomingDamage, living, playTurn, raiderDamageTo, spawnsAreOpenGround, type ArenaPlan, type DifficultyId, type MatchState } from "../src/game/mecha/rules.ts";
import { unitMaxHp } from "../src/game/mecha/unitHealth.ts";

function match(difficulty?: DifficultyId) {
  return createMatch({
    preset: "covers_sparse_mid",
    script: "siege",
    difficulty,
    covers: [],
    boss: { x: 4, y: 4 },
    mechs: [
      { id: "Assault", pos: { x: 5, y: 3 } },
      { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 9, y: 9 } },
    ],
  });
}

test("default matches use normal stats while difficulties persist their raider counts", () => {
  const baseline = match();
  assert.equal(baseline.difficulty, undefined);
  assert.deepEqual(enemyStatsOf(baseline), ENEMY_STATS.normal);
  assert.equal(baseline.boss.hp, 40);
  assert.equal(enemyStatsOf(baseline).bossAtk, 6, "default remains compatible with pre-difficulty battles");
  assert.deepEqual(baseline.raiders.map((raider) => raider.hp), [8, 8]);

  const easy = match("easy");
  const hard = match("hard");
  assert.equal(easy.difficulty, "easy");
  assert.equal(easy.boss.hp, 36);
  assert.deepEqual(easy.raiders.map((raider) => raider.hp), [8]);
  assert.equal(hard.difficulty, "hard");
  assert.equal(hard.boss.hp, 48);
  assert.deepEqual(hard.raiders.map((raider) => raider.hp), [8, 8, 8, 8]);
});

test("enemy attacks and forecasts use the difficulty stored on the match", async () => {
  for (const difficulty of ["easy", "normal", "hard"] as const) {
    const state = match(difficulty);
    const stats = enemyStatsOf(state);
    const before = state.mechs[0]!.hp;
    bossPrepare(state);
    const turn = state.revision;
    const plan = { revision: turn, items: living(state).map((mech) => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" as const } })) };
    const clone = structuredClone(state);
    const { validateAndApplyPlan } = await import("../src/game/mecha/rules.ts");
    assert.ok("ok" in validateAndApplyPlan(clone, plan));
    bossExecute(clone);
    assert.equal(before - clone.mechs[0]!.hp, stats.bossAtk - 2);
    assert.equal(bossDamageTo("Assault", state), stats.bossAtk - 2);
    assert.equal(raiderDamageTo("Assault", state), Math.max(1, stats.raiderAtk - 2));
    assert.equal(buildingDamage(state), stats.bossAtk);
  }
});

test("health and inspection expose scaled enemy stats, including remote raider ids", () => {
  const state = match("hard");
  state.raiders[0]!.id = "raider-0";
  assert.equal(unitMaxHp("boss", state), 48);
  assert.equal(unitMaxHp("raider-e", state), 8);
  assert.equal(unitMaxHp("raider-0", state), 8);
  const boss = inspectCell(state, { x: 4, y: 4 }, {}, "boss");
  assert.equal(boss?.unit?.maxHp, 48);
  assert.equal(boss?.unit?.atk, 7);
  const raider = inspectCell(state, { x: 1, y: 4 }, {}, "raider-0");
  assert.equal(raider?.unit?.maxHp, 8);
  assert.equal(raider?.unit?.atk, 4);
});

const difficulties: DifficultyId[] = ["easy", "normal", "hard"];

function hold(state: MatchState): ArenaPlan {
  return { revision: state.revision, items: living(state).map(mech => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" } })) };
}

function resolveHold(state: MatchState) {
  const before = structuredClone(state);
  const result = playTurn(state, hold(state));
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.fault));
  assert.deepEqual(state, before, "comparison must not mutate the starting position");
  return result;
}

function singleRaider(difficulty: DifficultyId, target: "mech" | "building"): MatchState {
  const state = createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", difficulty, covers: [],
    ...(target === "mech" ? {
      boss: { x: 7, y: 0 }, buildings: [], raiders: [{ id: "r", pos: { x: 2, y: 6 } }],
      mechs: [{ id: "Assault" as const, pos: { x: 2, y: 7 } }, { id: "Gunner" as const, pos: { x: 0, y: 9 } }, { id: "Support" as const, pos: { x: 9, y: 9 } }],
    } : {
      boss: { x: 7, y: 6 }, buildings: [{ id: "b", cells: [{ x: 2, y: 1 }] }], raiders: [{ id: "r", pos: { x: 2, y: 2 } }],
      mechs: [{ id: "Assault" as const, pos: { x: 0, y: 9 } }, { id: "Gunner" as const, pos: { x: 2, y: 9 } }, { id: "Support" as const, pos: { x: 4, y: 9 } }],
    }),
  });
  bossPrepare(state);
  return state;
}

test("same raider hit: the minimum-one damage floor makes easy and normal equal against Assault", () => {
  const losses = difficulties.map(difficulty => {
    const state = singleRaider(difficulty, "mech");
    assert.deepEqual(state.raiders[0]!.intent?.projected, [{ x: 2, y: 7 }]);
    const forecast = incomingDamage(state, "Assault", { x: 2, y: 7 });
    const result = resolveHold(state);
    const loss = state.mechs[0]!.hp - result.state.mechs[0]!.hp;
    assert.equal(loss, forecast);
    assert.equal(result.state.difficulty, difficulty);
    return loss;
  });
  assert.deepEqual(losses, [1, 1, 2]);
});

test("same raider hit to a building scales 2/3/4 and matches resolved enemy events", () => {
  const losses = difficulties.map(difficulty => {
    const state = singleRaider(difficulty, "building");
    assert.deepEqual(state.raiders[0]!.intent?.projected, [{ x: 2, y: 1 }]);
    const result = resolveHold(state);
    const loss = state.buildings[0]!.hp - result.state.buildings[0]!.hp;
    const hit = result.log.find(event => event.type === "enemy" && event.actor === "r");
    assert.ok(hit && hit.type === "enemy");
    assert.equal(hit.damage, loss);
    return loss;
  });
  assert.deepEqual(losses, [2, 3, 4]);
});

test("same attack against the boss does not scale player damage, while boss durability does", () => {
  const pairs = difficulties.map(difficulty => {
    const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", difficulty, covers: [], buildings: [], raiders: [], boss: { x: 4, y: 4 }, mechs: [
      { id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } },
    ] });
    bossPrepare(state);
    const plan = hold(state);
    plan.items[0]!.action = { kind: "melee" };
    const result = playTurn(state, plan);
    assert.ok(result.ok);
    return [state.boss.hp, state.boss.hp - result.state.boss.hp];
  });
  assert.deepEqual(pairs, [[36, 2], [40, 2], [48, 2]]);
});

function fixedCity() {
  const anchor = (id: string, x: number, z: number): SiteAnchor => ({ id, x, z, halfX: 3, halfZ: 3, ground: 4, height: 8 });
  const site = siteMechaWindow({ height: () => 4 }, [anchor("west", 40, 40), anchor("mid", 52, 40), anchor("north", 40, 52)]);
  assert.ok(site);
  return site;
}


test("explicit normal preserves this city's legacy default setup apart from difficulty metadata", () => {
  const site = fixedCity();
  const legacy = matchFromSite(site, { preset: "covers_sparse_mid", script: "siege" });
  const explicit = matchFromSite(site, { preset: "covers_sparse_mid", script: "siege", difficulty: "normal" });
  assert.equal(explicit.difficulty, "normal");
  const { difficulty: _difficulty, ...withoutDifficulty } = explicit;
  assert.deepEqual(withoutDifficulty, legacy);
});

test("difficulty raider-count configuration applies to siege, not other scripts", () => {
  const states = difficulties.map(difficulty => createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", difficulty, covers: [], buildings: [],
    raiders: [{ id: "r", pos: { x: 1, y: 4 } }],
  }));
  assert.deepEqual(states.map(state => state.raiders.length), [1, 1, 1]);
  assert.deepEqual(states.map(state => state.boss.hp), [36, 40, 48]);
});

function cityHoldTrace(difficulty: DifficultyId) {
  const state = matchFromSite(fixedCity(), { preset: "covers_sparse_mid", script: "siege", difficulty });
  assert.equal(spawnsAreOpenGround(state), true);
  const roster = state.raiders.map(raider => ({ id: raider.id, pos: raider.pos, hp: raider.hp }));
  bossPrepare(state);
  let current = state;
  const turns = [];
  for (let i = 0; i < 6 && !current.outcome; i++) {
    current = resolveHold(current).state;
    turns.push({ turn: current.turn, outcome: current.outcome, boss: current.boss.hp, mechs: current.mechs.map(mech => mech.hp), buildings: current.buildings.map(building => building.hp) });
  }
  return { roster, turns };
}

test("same generated city and six hold turns yield repeatable, difficulty-specific pressure", () => {
  const expected = {
    easy: { roster: ["raider-w"], mechs: [14, 11, 12], buildings: [6, 4, 0], outcome: null, turn: 7 },
    normal: { roster: ["raider-w", "raider-e"], mechs: [14, 11, 10], buildings: [0, 0, 0], outcome: "defeat_buildings", turn: 6 },
    hard: { roster: ["raider-w", "raider-e", "raider-extra-2", "raider-extra-3"], mechs: [14, 0, 0], buildings: [0, 0, 0], outcome: "defeat_buildings", turn: 6 },
  };
  for (const difficulty of difficulties) {
    const first = cityHoldTrace(difficulty);
    assert.deepEqual(cityHoldTrace(difficulty), first);
    assert.deepEqual(first.roster.map(raider => raider.id), expected[difficulty].roster);
    assert.ok(first.roster.every(raider => raider.hp === 8));
    const last = first.turns.at(-1)!;
    assert.deepEqual(last.mechs, expected[difficulty].mechs);
    assert.deepEqual(last.buildings, expected[difficulty].buildings);
    assert.equal(last.outcome, expected[difficulty].outcome);
    assert.equal(last.turn, expected[difficulty].turn);
  }
  // Different rosters change targeting, so individual buildings need not be monotonically worse.
  assert.ok(cityHoldTrace("easy").turns[0]!.buildings[1]! < cityHoldTrace("normal").turns[0]!.buildings[1]!);
});

test("explicit empty siege roster currently remains empty even when hard requests four raiders", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "siege", difficulty: "hard", covers: [], buildings: [], raiders: [] });
  assert.deepEqual(state.raiders, []);
  bossPrepare(state);
  assert.deepEqual(state.raiders, []);
});

test("a siege board with no open extra spawn cells currently keeps a smaller hard roster", () => {
  const allowed = new Set(["4,0", "5,0", "4,1", "5,1", "2,9", "5,9", "8,9", "1,4"]);
  const obstacles = Array.from({ length: 100 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10) }))
    .filter(cell => !allowed.has(`${cell.x},${cell.y}`));
  const state = createMatch({ preset: "covers_sparse_mid", script: "siege", difficulty: "hard", covers: [], buildings: [], obstacles, raiders: [{ id: "only", pos: { x: 1, y: 4 } }] });
  assert.equal(spawnsAreOpenGround(state), true);
  assert.deepEqual(state.raiders.map(raider => raider.id), ["only"]);
});

test("an explicitly supplied extra-style id currently collides with generated hard-raider ids", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "siege", difficulty: "hard", covers: [], buildings: [], raiders: [
    { id: "raider-extra-2", pos: { x: 1, y: 4 } }, { id: "r", pos: { x: 8, y: 4 } },
  ] });
  assert.deepEqual(state.raiders.map(raider => raider.id), ["raider-extra-2", "r", "raider-extra-2", "raider-extra-3"]);
  assert.equal(spawnsAreOpenGround(state), true, "spatial validation alone does not detect duplicate identities");
});

test("fixed city completes deterministically under both existing AI doctrines at every difficulty", () => {
  const expected = {
    tunnel: {
      easy: { rounds: 7, mechs: [14, 11, 12], buildings: [16, 14, 9] },
      normal: { rounds: 9, mechs: [14, 11, 4], buildings: [16, 10, 0] },
      hard: { rounds: 9, mechs: [10, 3, 7], buildings: [12, 12, 0] },
    },
    peel: {
      easy: { rounds: 6, mechs: [14, 11, 12], buildings: [6, 14, 11] },
      normal: { rounds: 8, mechs: [12, 7, 6], buildings: [16, 16, 4] },
      hard: { rounds: 9, mechs: [10, 11, 8], buildings: [8, 16, 0] },
    },
  };
  for (const doctrine of ["tunnel", "peel"] as const) for (const difficulty of difficulties) {
    let state = matchFromSite(fixedCity(), { preset: "covers_sparse_mid", script: "siege", difficulty });
    bossPrepare(state);
    let rounds = 0;
    while (!state.outcome && rounds < 15) {
      const result = playTurn(state, planForDoctrine(state, doctrine));
      assert.ok(result.ok, `${doctrine}/${difficulty} rejected a recommended plan`);
      state = result.state;
      rounds += 1;
    }
    assert.equal(state.outcome, "victory", `${doctrine}/${difficulty}`);
    assert.equal(rounds, expected[doctrine][difficulty].rounds);
    assert.deepEqual(state.mechs.map(mech => mech.hp), expected[doctrine][difficulty].mechs);
    assert.deepEqual(state.buildings.map(building => building.hp), expected[doctrine][difficulty].buildings);
  }
});
