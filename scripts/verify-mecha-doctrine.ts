/** 攻坚和守楼必须走出不同的一步。同一宽度，焦点不同。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bossTunnelPlan, peelPlan } from "../apps/agent-city/ui/src/game/mecha/ai.ts";
import { bossPrepare, createMatch, type Cell } from "../apps/agent-city/ui/src/game/mecha/rules.ts";

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
