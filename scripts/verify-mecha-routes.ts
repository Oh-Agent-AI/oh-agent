import assert from "node:assert/strict";
import test from "node:test";
import { createMatch, moveBudget, pathDistance, pathRoute, type Cell } from "../apps/agent-city/ui/src/game/mecha/rules.ts";
import { stepCost } from "../apps/agent-city/ui/src/game/mecha/board.ts";
import { buildPresentationRoutes } from "../apps/agent-city/ui/src/game/mecha/presentationRoutes.ts";

function fixture() {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 8, y: 0 }, mechs: [
    { id: "Assault", pos: { x: 1, y: 5 } }, { id: "Gunner", pos: { x: 2, y: 5 } }, { id: "Support", pos: { x: 9, y: 9 } },
  ] });
  state.terrain[5]![3] = "water";
  state.terrain[4]![3] = "mountain";
  state.terrain[6]![2] = "road";
  state.obstacles.push({ x: 2, y: 4 });
  return state;
}
function routeCost(state: ReturnType<typeof fixture>, cells: Cell[]) {
  // Cross-check the actual edges, including terrain and elevation costs.
  let cost = 0;
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i-1]!, b = cells[i]!;
    assert.equal(Math.abs(a.x-b.x)+Math.abs(a.y-b.y), 1, "route uses adjacent cells");
    const step = stepCost(state, a, b, "Assault");
    assert.notEqual(step, null); cost += step!;
    assert.notEqual(state.terrain[b.y]![b.x], "water");
    assert.ok(!state.obstacles.some((o) => o.x === b.x && o.y === b.y));
  }
  return cost;
}

test("presentation routes match rule distances across the whole board", () => {
  const state = fixture(), from = { x: 1, y: 5 };
  for (let y=0; y<10; y++) for (let x=0; x<10; x++) {
    const to = { x, y };
    const distance = pathDistance(state, from, to, "Assault", { alliesPass: true });
    const route = pathRoute(state, from, to, "Assault", { alliesPass: true });
    assert.equal(route?.cost ?? null, distance, `distance at ${x},${y}`);
    if (!route) continue;
    assert.deepEqual(route.cells[0], from); assert.deepEqual(route.cells.at(-1), to);
    assert.equal(routeCost(state, route.cells), route.cost);
    assert.deepEqual(pathRoute(state, from, to, "Assault", { alliesPass: true }), route, "tie-breaking is deterministic");
  }
});

test("route explicitly respects ally-passing policy and cannot cross blocked terrain", () => {
  const state = fixture(), from = { x: 1, y: 5 };
  assert.equal(pathRoute(state, from, { x: 2, y: 5 }, "Assault"), null);
  assert.equal(pathRoute(state, from, { x: 2, y: 5 }, "Assault", { alliesPass: true })?.cost, 2);
  assert.equal(pathRoute(state, from, { x: 3, y: 5 }, "Assault", { alliesPass: true }), null);
  const to = { x: 4, y: 5 }, route = pathRoute(state, from, to, "Assault", { alliesPass: true });
  assert.ok(route); assert.ok(route.cells.length > 4, "water forces a detour"); assert.equal(routeCost(state, route.cells), route.cost);
});

test("turn presentation refuses fabricated routes and preserves accepted moves", () => {
  const state = fixture();
  const route = buildPresentationRoutes(state, [{ type: "move", mechId: "Assault", from: { x: 1, y: 5 }, to: { x: 2, y: 5 } }]);
  assert.equal(route.ok, true);
  if (route.ok) { assert.equal(route.routes[0]!.cost, 2); assert.ok(route.routes[0]!.cost <= moveBudget("Assault")); }
  assert.equal(buildPresentationRoutes(state, [{ type: "move", mechId: "Assault", from: { x: 0, y: 0 }, to: { x: 2, y: 5 } }]).ok, false);
  assert.equal(buildPresentationRoutes(state, [{ type: "move", mechId: "Assault", from: { x: 1, y: 5 }, to: { x: 3, y: 5 } }]).ok, false);
});
