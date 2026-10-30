/** 攻坚和守楼必须走出不同的一步。同一宽度，焦点不同。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bossTunnelPlan, doctrineFocus, peelPlan } from "../apps/agent-city/ui/src/game/mecha/ai.ts";
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
