/** 攻坚和守楼必须走出不同的一步。同一宽度，焦点不同。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bossTunnelPlan, doctrineFocus, evaluatePlan, peelPlan } from "../apps/agent-city/ui/src/game/mecha/ai.ts";
import { doctrineFocusLine, gameText, stepBudgetLine } from "../apps/agent-city/ui/src/game/gameCopy.ts";
import { bossPrepare, createMatch, living, livingStakeBuildings, stakeBuildings, validateAndApplyPlan, type Cell, type TerrainKind } from "../apps/agent-city/ui/src/game/mecha/rules.ts";

function manh(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

test("holding the buildings steps toward the raider, boss-first steps toward the boss", () => {
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "siege",
    covers: [],
    buildings: [{ id: "block", cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }] }],
    raiders: [
      { id: "raider-w", pos: { x: 1, y: 1 } },
      { id: "raider-e", pos: { x: 8, y: 8 } },
    ],
    mechs: [
      { id: "Assault", pos: { x: 4, y: 4 } },
      { id: "Gunner", pos: { x: 4, y: 5 } },
      { id: "Support", pos: { x: 5, y: 4 } },
    ],
    boss: { x: 6, y: 6 },
  });
  bossPrepare(state);
  const tunnel = bossTunnelPlan(state);
  const peel = peelPlan(state);
  const towardRaider = { x: 1, y: 1 };
  const assaultTunnel = tunnel.items.find((item) => item.mechId === "Assault");
  const assaultPeel = peel.items.find((item) => item.mechId === "Assault");
  assert.ok(assaultTunnel);
  assert.ok(assaultPeel);
  const tunnelDest = assaultTunnel.moveTo ?? { x: 4, y: 4 };
  const peelDest = assaultPeel.moveTo ?? { x: 4, y: 4 };
  assert.ok(manh(peelDest, towardRaider) < manh(tunnelDest, towardRaider));
  assert.notEqual(JSON.stringify(tunnel.items), JSON.stringify(peel.items));
});

test("the step line names the cost and the budget in both languages", () => {
  assert.equal(stepBudgetLine(8, 8, "zh-Hans"), "这一步 8 半步，预算 8");
  assert.equal(stepBudgetLine(0, 6, "zh-Hans"), "这一步 0 半步，预算 6");
  assert.equal(stepBudgetLine(8, 8, "en"), "8 of 8 half-steps");
  assert.equal(stepBudgetLine(null, 6, "en"), "— of 6 half-steps");
});

test("a road around a mountain wall is closer in half-steps than the manhattan cell", () => {
  const terrain: TerrainKind[][] = [];
  for (let y = 0; y < 10; y += 1) {
    terrain.push([]);
    for (let x = 0; x < 10; x += 1) {
      const wall = x >= 4 && x <= 7 && y !== 1;
      terrain[y]!.push(y === 1 ? "road" : wall ? "mountain" : "land");
    }
  }
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "siege",
    covers: [],
    terrain,
    buildings: [{ id: "block", cells: [{ x: 8, y: 3 }] }],
    raiders: [{ id: "raider-w", pos: { x: 8, y: 4 } }],
    mechs: [
      { id: "Assault", pos: { x: 1, y: 4 } },
      { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 1, y: 9 } },
    ],
    boss: { x: 0, y: 6 },
  });
  state.phase = "player_plan";
  const peel = peelPlan(state);
  const assault = peel.items.find((item) => item.mechId === "Assault");
  assert.ok(assault?.moveTo);
  assert.equal(assault.moveTo.y, 1, `expected the road row, got ${assault.moveTo.x},${assault.moveTo.y}`);
  // Frozen before the explanation change, including terrain-aware path costs.
  assert.deepEqual(peel.items, [
    { mechId: "Assault", moveTo: { x: 4, y: 1 }, action: { kind: "skip" } },
    { mechId: "Gunner", moveTo: { x: 1, y: 8 }, action: { kind: "pierce" } },
    { mechId: "Support", moveTo: { x: 2, y: 7 }, action: { kind: "melee" } },
  ]);
  const score = evaluatePlan(state, peel, "peel");
  assert.ok(score.ok); assert.equal(score.score, 344);
  const tunnel = bossTunnelPlan(state);
  assert.deepEqual(tunnel.items, [
    { mechId: "Assault", moveTo: { x: 2, y: 6 }, action: { kind: "charge" } },
    { mechId: "Gunner", moveTo: { x: 0, y: 8 }, action: { kind: "pierce" } },
    { mechId: "Support", moveTo: { x: 2, y: 7 }, action: { kind: "melee" } },
  ]);
  const tunnelScore = evaluatePlan(state, tunnel, "tunnel");
  assert.ok(tunnelScore.ok); assert.equal(tunnelScore.score, 363);

});

test("the focus line names the boss or the raider and the building", () => {
  assert.equal(doctrineFocusLine("tunnel", "Boss", null, "en"), "Boss first is aimed at the boss.");
  assert.equal(doctrineFocusLine("tunnel", "大怪", null, "zh-Hans"), "攻坚盯着大怪。");
  assert.equal(doctrineFocusLine("peel", "West raider", "1,1", "en"), "Hold the buildings is aimed at West raider, beside the building at 1,1.");
  assert.equal(doctrineFocusLine("peel", "小怪西", "1,1", "zh-Hans"), "守楼盯着小怪西，楼在 1,1。");
});

test("an alley loss is the street building, and peel aims at the raider beside it", () => {
  const terrain: TerrainKind[][] = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as TerrainKind));
  terrain[1]![2] = "road";
  const base = {
    preset: "covers_sparse_mid" as const,
    script: "siege" as const,
    covers: [],
    terrain,
    buildings: [
      { id: "street", cells: [{ x: 2, y: 2 }] },
      { id: "yard", cells: [{ x: 8, y: 8 }] },
    ],
    raiders: [
      { id: "raider-w", pos: { x: 5, y: 5 } },
      { id: "raider-e", pos: { x: 8, y: 7 } },
    ],
    mechs: [
      { id: "Assault" as const, pos: { x: 0, y: 9 } },
      { id: "Gunner" as const, pos: { x: 1, y: 9 } },
      { id: "Support" as const, pos: { x: 2, y: 9 } },
    ],
    boss: { x: 0, y: 6 },
  };
  const alley = createMatch({ ...base, stake: "frontage" });
  const inland = createMatch({ ...base, stake: "all" });
  assert.equal(doctrineFocus(alley, "peel").id, "raider-w");
  assert.equal(doctrineFocus(inland, "peel").id, "raider-e");
  assert.deepEqual(doctrineFocus(alley, "peel").building, { x: 2, y: 2 });
  alley.phase = "player_plan";
  const yard = alley.buildings.find((building) => building.id === "yard");
  assert.ok(yard);
  yard.hp = 0;
  const skipped = validateAndApplyPlan(alley, {
    revision: alley.revision,
    items: living(alley).map((mech) => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" as const } })),
  });
  assert.equal("ok" in skipped, true);
  assert.equal(alley.outcome, null);
  const street = alley.buildings.find((building) => building.id === "street");
  assert.ok(street);
  street.hp = 0;
  alley.phase = "player_plan";
  const lost = validateAndApplyPlan(alley, {
    revision: alley.revision,
    items: living(alley).map((mech) => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" as const } })),
  });
  assert.equal("ok" in lost, true);
  assert.equal(alley.outcome, "defeat_buildings");
  assert.equal(alley.buildings.find((building) => building.id === "yard")?.hp, 0);
});

function flatLand(): TerrainKind[][] {
  return Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as TerrainKind));
}

function stakeMatch(stake: "all" | "frontage", terrain: TerrainKind[][], buildings: Array<{ id: string; cells: Cell[] }>) {
  return createMatch({
    preset: "covers_sparse_mid",
    script: "siege",
    covers: [],
    terrain,
    buildings,
    raiders: [],
    mechs: [
      { id: "Assault", pos: { x: 0, y: 9 } },
      { id: "Gunner", pos: { x: 1, y: 9 } },
      { id: "Support", pos: { x: 2, y: 9 } },
    ],
    boss: { x: 0, y: 6 },
    stake,
  });
}

function resolveHold(state: ReturnType<typeof stakeMatch>) {
  state.phase = "player_plan";
  const result = validateAndApplyPlan(state, {
    revision: state.revision,
    items: living(state).map((mech) => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" as const } })),
  });
  assert.equal("ok" in result, true, "an all-skip hold must be a legal pack");
  return state;
}

test("frontage stakes only orthogonally street-facing buildings; a diagonal road is not frontage", () => {
  const terrain = flatLand();
  terrain[1]![2] = "road"; // 街道楼 (2,2) 的正交临街面
  terrain[8]![8] = "road"; // (7,7) 的斜角，不算临街
  const buildings = [
    { id: "street", cells: [{ x: 2, y: 2 }] },
    { id: "yard", cells: [{ x: 7, y: 7 }] },
  ];
  const alley = stakeMatch("frontage", terrain, buildings);
  assert.deepEqual(stakeBuildings(alley).map((building) => building.id), ["street"]);
  assert.deepEqual(livingStakeBuildings(alley).map((building) => building.id), ["street"]);
  const all = stakeMatch("all", terrain, buildings);
  assert.deepEqual(stakeBuildings(all).map((building) => building.id).sort(), ["street", "yard"]);
});

test("frontage defeat follows the staked pool: a dead off-street yard does not lose", () => {
  const terrain = flatLand();
  terrain[1]![2] = "road";
  const state = stakeMatch("frontage", terrain, [
    { id: "street", cells: [{ x: 2, y: 2 }] },
    { id: "yard", cells: [{ x: 7, y: 7 }] },
  ]);
  const yard = state.buildings.find((building) => building.id === "yard");
  assert.ok(yard);
  yard.hp = 0;
  resolveHold(state);
  assert.equal(state.outcome, null, "an off-street building is not a defeat condition");
  const street = state.buildings.find((building) => building.id === "street");
  assert.ok(street);
  street.hp = 0;
  resolveHold(state);
  assert.equal(state.outcome, "defeat_buildings");
  // HUD 读的是同一个 outcome 与同一组文案键；英文不能回落到 "Translation unavailable"。
  assert.equal(gameText("楼被拆光", "en"), "Buildings lost");
});

test("with no street frontage, every building falls back into the staked pool", () => {
  const terrain = flatLand();
  const state = stakeMatch("frontage", terrain, [
    { id: "a", cells: [{ x: 2, y: 2 }] },
    { id: "b", cells: [{ x: 7, y: 7 }] },
  ]);
  assert.deepEqual(stakeBuildings(state).map((building) => building.id), ["a", "b"]);
  const a = state.buildings.find((building) => building.id === "a");
  const firstB = state.buildings.find((building) => building.id === "b");
  assert.ok(a && firstB);
  a.hp = 0;
  resolveHold(state);
  assert.equal(state.outcome, null, "one fallen building is not enough while the fallback pool still stands");
  // validateAndApplyPlan 用 Object.assign 换掉 buildings 数组，旧引用会指向换装前的对象。
  const b = state.buildings.find((building) => building.id === "b");
  assert.ok(b);
  b.hp = 0;
  resolveHold(state);
  assert.equal(state.outcome, "defeat_buildings");
});

test("a boss-down building loss keeps defeat_buildings and the HUD's boss-down sentence", () => {
  const terrain = flatLand();
  terrain[1]![2] = "road";
  const state = stakeMatch("frontage", terrain, [
    { id: "street", cells: [{ x: 2, y: 2 }] },
    { id: "yard", cells: [{ x: 7, y: 7 }] },
  ]);
  state.boss.hp = 0;
  state.raiders = [{ id: "raider-w", pos: { x: 8, y: 8 }, hp: 8, intent: null }];
  const street = state.buildings.find((building) => building.id === "street");
  assert.ok(street);
  street.hp = 0;
  resolveHold(state);
  assert.equal(state.outcome, "defeat_buildings", "a surviving raider keeps victory from masking the building loss");
  assert.equal(gameText("大怪已倒，楼先没了", "en"), "The boss is down, and the buildings fell first.");
  assert.equal(gameText("大怪已倒，楼先没了", "zh-Hans"), "大怪已倒，楼先没了");
});

// Search results captured before adding the score breakdown: changing the
// explanation must not change candidate pruning, arithmetic order or ties.
test("score explanations preserve real search results and weighted terms", async () => {
  const { evaluatePlan, squadPlan } = await import("../apps/agent-city/ui/src/game/mecha/ai.ts");
  const state = createMatch({
    preset: "covers_sparse_mid", script: "siege", covers: [],
    buildings: [{ id: "block", cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }] }],
    raiders: [{ id: "raider-w", pos: { x: 1, y: 1 } }, { id: "raider-e", pos: { x: 8, y: 8 } }],
    mechs: [{ id: "Assault", pos: { x: 4, y: 4 } }, { id: "Gunner", pos: { x: 4, y: 5 } }, { id: "Support", pos: { x: 5, y: 4 } }],
    boss: { x: 6, y: 6 },
  });
  bossPrepare(state);
  const before = structuredClone(state);
  const expectations = [
    { id: "tunnel" as const, plan: squadPlan(state), items: [
      { mechId: "Assault", moveTo: { x: 3, y: 6 }, action: { kind: "charge" } },
      { mechId: "Gunner", moveTo: { x: 5, y: 5 }, action: { kind: "pierce" } },
      { mechId: "Support", moveTo: { x: 6, y: 6 }, action: { kind: "melee" } },
    ], score: 357, factors: { boss: 200, raiders: 0, mechs: 99, position: -6, buildings: 64, outcome: 0 } },
    { id: "peel" as const, plan: peelPlan(state), items: [
      { mechId: "Assault", moveTo: { x: 2, y: 5 }, action: { kind: "charge" } },
      { mechId: "Gunner", moveTo: { x: 3, y: 4 }, action: { kind: "pierce" } },
      { mechId: "Support", moveTo: null, action: { kind: "shoot" } },
    ], score: 552, factors: { boss: 8, raiders: 192, mechs: 111, position: -15, buildings: 256, outcome: 0 } },
  ];
  for (const expected of expectations) {
    const originalPlan = structuredClone(expected.plan);
    assert.deepEqual(expected.plan.items, expected.items);
    assert.deepEqual(evaluatePlan(state, expected.plan, expected.id), { ok: true, score: expected.score, factors: expected.factors });
    assert.deepEqual(evaluatePlan(state, expected.plan, expected.id), evaluatePlan(state, expected.plan, expected.id));
    assert.equal(Object.values(expected.factors).reduce((sum, n) => sum + n, 0), expected.score);
    assert.deepEqual(expected.plan, originalPlan, "evaluation does not mutate its input plan");
  }
  assert.deepEqual(state, before, "search and evaluation do not mutate the source match");
});

test("evaluation rejects invalid packs, distinguishes nonfinite values, and restores the event sink", async () => {
  const { evaluatePlan } = await import("../apps/agent-city/ui/src/game/mecha/ai.ts");
  const { emit, swapEventSink } = await import("../apps/agent-city/ui/src/game/mecha/board.ts");
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 3 }, mechs: [
    { id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 4, y: 7 } }, { id: "Support", pos: { x: 8, y: 9 } },
  ] });
  bossPrepare(state);
  const plan = bossTunnelPlan(state);
  assert.deepEqual(plan.items, [
    { mechId: "Assault", moveTo: { x: 4, y: 2 }, action: { kind: "charge" } },
    { mechId: "Gunner", moveTo: { x: 4, y: 5 }, action: { kind: "pierce" } },
    { mechId: "Support", moveTo: { x: 5, y: 9 }, action: { kind: "skip" } },
  ]);
  const { items: _, ...missing } = plan;
  void _;
  const outer: import("../apps/agent-city/ui/src/game/mecha/rules.ts").TurnEvent[] = [];
  const old = swapEventSink(outer);
  try {
    assert.deepEqual(evaluatePlan(state, plan, "tunnel"), { ok: true, score: 235, factors: { boss: 140, raiders: 0, mechs: 105, position: -10, buildings: 0, outcome: 0 } });
    assert.deepEqual(evaluatePlan(state, { ...plan, revision: plan.revision + 1 }, "tunnel"), { ok: false, reason: "rejected" });
    assert.deepEqual(evaluatePlan(state, { ...plan, items: [] }, "peel"), { ok: false, reason: "rejected" });
    assert.deepEqual(evaluatePlan(state, missing as typeof plan, "tunnel"), { ok: false, reason: "unavailable" });
    const nonfinite = structuredClone(state);
    const brokenBuilding = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", buildings: [{ id: "broken", cells: [{ x: 0, y: 0 }] }] }).buildings[0]!;
    brokenBuilding.hp = Number.NaN; nonfinite.buildings.push(brokenBuilding);
    assert.deepEqual(evaluatePlan(nonfinite, plan, "tunnel"), { ok: false, reason: "nonfinite" });
    assert.deepEqual(outer, [], "simulation never leaks events into an outer turn");
    const marker = { type: "outcome" as const, outcome: "victory" as const };
    emit(marker);
    assert.deepEqual(outer, [marker], "the previous sink remains active even after errors");
  } finally { swapEventSink(old); }
});


test("a terminal victory exposes the actual outcome adjustment, not a fabricated enemy phase", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 3 }, mechs: [
    { id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 4, y: 7 } }, { id: "Support", pos: { x: 8, y: 9 } },
  ] });
  state.boss.hp = 1; bossPrepare(state);
  const tunnel = evaluatePlan(state, bossTunnelPlan(state), "tunnel");
  const peel = evaluatePlan(state, peelPlan(state), "peel");
  assert.deepEqual(tunnel, { ok: true, score: 5901, factors: { boss: 800, raiders: 0, mechs: 111, position: -10, buildings: 0, outcome: 5000 } });
  assert.deepEqual(peel, { ok: true, score: 5423, factors: { boss: 320, raiders: 0, mechs: 111, position: -8, buildings: 0, outcome: 5000 } });
});
