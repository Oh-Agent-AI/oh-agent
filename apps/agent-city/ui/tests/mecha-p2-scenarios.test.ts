import assert from "node:assert/strict";
import { test } from "node:test";
import { planForDoctrine } from "../src/game/mecha/ai.ts";
import { LOT } from "../src/engine/worldScale.ts";
import { CELL_LOTS, cellWorld, siteFightShapes, siteMechaWindow, type FightCatalog, type SiteAnchor } from "../src/game/mecha/citySite.ts";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { applyDeployPlan, validateDeployPlan } from "../src/game/mecha/deployment.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { P2_SCENARIOS, resolveP2Scenario } from "../src/game/mecha/p2Scenarios.ts";
import { ENEMY_STATS, living, playTurn, spawnsAreOpenGround, type DifficultyId } from "../src/game/mecha/rules.ts";

// Explicitly synthetic inputs, passed through the same city window search used by
// the product. They demonstrate the path, not the existence of any user's site.
const anchor = (id: string, x: number, z: number): SiteAnchor => ({ id, x, z, halfX: 3, halfZ: 3, ground: 4, height: 8 });
function terrainCatalog(): FightCatalog {
  return siteFightShapes({ height: (_x, z) => z < 4 ? -1 : 4, slope: (x, z) => x < 4 && z > 200 ? 1 : 0 }, [
    anchor("in-a", 400, 400), anchor("in-b", 412, 400), anchor("in-c", 404, 412),
    anchor("shore-a", 10, 24), anchor("shore-b", 22, 24), anchor("shore-c", 14, 36),
    anchor("ridge-a", 10, 240), anchor("ridge-b", 22, 240), anchor("ridge-c", 14, 252),
  ]);
}
function alleyCatalog(): FightCatalog {
  const w = CELL_LOTS * LOT.width, d = CELL_LOTS * LOT.depth;
  const anchors: SiteAnchor[] = [];
  for (const col of [0, 2, 4, 6]) {
    anchors.push(anchor(`n${col}`, col * w, 0), anchor(`s${col}`, col * w, 2 * d));
  }
  const bare = siteMechaWindow({ height: () => 4 }, anchors);
  assert.ok(bare);
  const idAt = (x: number, y: number) => bare.buildings.find(b => b.cells.some(c => c.x === x && c.y === y))?.id ?? null;
  const canyon: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) {
    const north = y > 0 ? idAt(x, y - 1) : null, south = y < 9 ? idAt(x, y + 1) : null;
    const west = x > 0 ? idAt(x - 1, y) : null, east = x < 9 ? idAt(x + 1, y) : null;
    if ((north && south && north !== south) || (west && east && west !== east)) canyon.push({ x, y });
  }
  assert.ok(canyon.length >= 4);
  const roads = canyon.slice(0, 4).map((cell, index) => {
    const at = cellWorld(bare, cell);
    return { id: `lane-${index}`, from: `a${index}`, to: `b${index}`, width: 12, kind: "arterial" as const, points: [{ x: at.x - 40, z: at.z }, { x: at.x + 40, z: at.z }] };
  });
  return siteFightShapes({ height: () => 4 }, anchors, roads);
}

const terrain = terrainCatalog();
const alley = alleyCatalog();
const catalog: FightCatalog = { flat: terrain.flat, shore: terrain.shore, ridge: terrain.ridge, alley: alley.alley };
const empty: FightCatalog = { flat: null, shore: null, ridge: null, alley: null };

test("every curated combination uses a selected real-window result and plays a legal turn", () => {
  assert.equal(new Set(P2_SCENARIOS.map(s => s.id)).size, P2_SCENARIOS.length);
  assert.equal(P2_SCENARIOS.length, 4);
  const before = structuredClone(catalog);
  for (const scenario of P2_SCENARIOS) {
    assert.ok(catalog[scenario.shape], `${scenario.id}: fixture must really exist`);
    const result = resolveP2Scenario(catalog, scenario.id);
    assert.ok(result.ok, `${scenario.id}: ${result.ok ? "" : result.reason}`);
    assert.equal(result.site, catalog[scenario.shape]);
    assert.deepEqual(result.match, matchFromSite(result.site, { preset: scenario.preset, script: scenario.script, stake: scenario.stake, deployment: true }));
    assert.equal(result.match.phase, "deployment");
    assert.equal(result.match.script, scenario.script);
    assert.equal(result.match.stake, scenario.shape === "alley" ? "frontage" : "all");
    assert.deepEqual(result.match.covers, [], "cover preset does not invent city geometry");
    assert.deepEqual(result.match.terrain, result.site.terrain);
    assert.deepEqual(result.match.obstacles, result.site.blocked);
    assert.equal(result.match.raiders.length, scenario.script === "siege" ? 2 : 0);
    assert.ok(spawnsAreOpenGround(result.match));
    assert.ok(validateDeployPlan(result.match, result.suggestedDeployment).ok);
    const deployed = applyDeployPlan(result.match, result.suggestedDeployment);
    assert.ok(deployed.ok);
    assert.equal(deployed.state.phase, "player_plan");
    assert.ok(deployed.state.boss.intent);
    const turn = playTurn(deployed.state, { revision: deployed.state.revision, items: living(deployed.state).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) });
    assert.ok(turn.ok, `${scenario.id}: ${turn.ok ? "" : JSON.stringify(turn.fault)}`);
    assert.ok(turn.state.turn > deployed.state.turn || turn.state.outcome);
    assert.deepEqual(resolveP2Scenario(catalog, scenario.id), result);
  }
  assert.deepEqual(catalog, before, "resolution and play do not mutate city data");
});

test("difficulty uses the existing rules' health and siege roster, without replacing city terrain", () => {
  for (const difficulty of ["easy", "normal", "hard"] as DifficultyId[]) {
    for (const scenario of P2_SCENARIOS) {
      const result = resolveP2Scenario(catalog, scenario.id, difficulty);
      assert.ok(result.ok, `${scenario.id} ${difficulty}: ${result.ok ? "" : result.reason}`);
      assert.equal(result.match.difficulty, difficulty);
      assert.equal(result.match.boss.hp, ENEMY_STATS[difficulty].bossHp);
      assert.equal(result.match.raiders.length, scenario.script === "siege" ? ENEMY_STATS[difficulty].raiderCount : 0);
      assert.deepEqual(result.match.terrain, result.site.terrain);
      assert.ok(validateDeployPlan(result.match, result.suggestedDeployment).ok);
    }
  }
});

test("missing, unsafe or malformed sites and unknown parameters fail closed", () => {
  for (const scenario of P2_SCENARIOS) assert.deepEqual(resolveP2Scenario(empty, scenario.id), { ok: false, reason: "site_unavailable" });
  assert.deepEqual(resolveP2Scenario(catalog, "missing"), { ok: false, reason: "unknown_scenario" });
  assert.deepEqual(resolveP2Scenario(catalog, "flat-raid", "unknown" as DifficultyId), { ok: false, reason: "invalid_difficulty" });
  const sparse = structuredClone(catalog.flat!);
  delete sparse.heights[0]![0];
  assert.deepEqual(resolveP2Scenario({ ...catalog, flat: sparse }, "flat-raid"), { ok: false, reason: "invalid_site" });
  const flat = structuredClone(catalog.flat!);
  flat.heights[0]!.pop();
  assert.deepEqual(resolveP2Scenario({ ...catalog, flat }, "flat-raid"), { ok: false, reason: "invalid_site" });
  const blocked = structuredClone(catalog.flat!);
  blocked.blocked.push({ ...blocked.mechs[0]!.pos });
  assert.deepEqual(resolveP2Scenario({ ...catalog, flat: blocked }, "flat-raid"), { ok: false, reason: "invalid_spawns" });
  const unsafe = structuredClone(catalog.flat!);
  unsafe.assaultTerrainSafety = { unsafeCells: [unsafe.mechs[0]!.pos], unsafeEdges: [] };
  assert.deepEqual(resolveP2Scenario({ ...catalog, flat: unsafe }, "flat-raid"), { ok: false, reason: "invalid_spawns" });
  const noRaiders = structuredClone(catalog.shore!);
  noRaiders.raiders = [];
  assert.deepEqual(resolveP2Scenario({ ...catalog, shore: noRaiders }, "shore-siege"), { ok: false, reason: "incomplete_enemy_roster" });
  const duplicateExtra = structuredClone(catalog.shore!);
  duplicateExtra.raiders[0]!.id = "raider-extra-2";
  assert.deepEqual(resolveP2Scenario({ ...catalog, shore: duplicateExtra }, "shore-siege", "hard"), { ok: false, reason: "invalid_enemy_roster" });
  const bossId = structuredClone(catalog.shore!);
  bossId.raiders[0]!.id = "boss";
  assert.deepEqual(resolveP2Scenario({ ...catalog, shore: bossId }, "shore-siege"), { ok: false, reason: "invalid_enemy_roster" });
});

test("existing local controller can restart a default-difficulty selection atomically", () => {
  const controller = createMechaController({ site: catalog.flat, deployment: true });
  for (const scenario of P2_SCENARIOS) {
    const result = resolveP2Scenario(catalog, scenario.id);
    assert.ok(result.ok);
    assert.equal(controller.restart({ site: result.site, preset: scenario.preset, script: scenario.script, stake: scenario.stake, mission: null }), true);
    assert.deepEqual(controller.getState().match, result.match);
    for (const placement of result.suggestedDeployment.placements) controller.placeMech(placement.mechId, placement.pos);
    assert.equal(controller.getState().deployment?.canConfirm, true);
    controller.confirmDeployment();
    assert.equal(controller.getState().match.phase, "player_plan");
  }
});


test("each generated scenario completes through accepted existing AI turns", () => {
  for (const scenario of P2_SCENARIOS) {
    const result = resolveP2Scenario(catalog, scenario.id);
    assert.ok(result.ok);
    const opening = applyDeployPlan(result.match, result.suggestedDeployment);
    assert.ok(opening.ok);
    let state = opening.state;
    assert.equal(state.boss.cadence, 1, scenario.id);
    for (let round = 0; round < 15 && !state.outcome; round += 1) {
      const turn = playTurn(state, planForDoctrine(state, "tunnel"));
      assert.ok(turn.ok, `${scenario.id} round ${round + 1}: ${turn.ok ? "" : JSON.stringify(turn.fault)}`);
      state = turn.state;
    }
    assert.ok(state.outcome, `${scenario.id} did not reach an outcome`);
    assert.equal(state.phase, "finished");
  }
});
