/** 攻坚和守楼必须走出不同的一步。同一宽度，焦点不同。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bossTunnelPlan, peelPlan } from "../apps/agent-city/ui/src/game/mecha/ai.ts";
import { stepBudgetLine } from "../apps/agent-city/ui/src/game/gameCopy.ts";
import { bossPrepare, createMatch, type Cell, type TerrainKind } from "../apps/agent-city/ui/src/game/mecha/rules.ts";

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
