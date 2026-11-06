import assert from "node:assert/strict";
import test from "node:test";
import { cheb, eq, footprint, livingRaiders, occupant, terrainAt, type Cell, type MatchState } from "../src/game/mecha/board.ts";
import { legalActions, shotTargetDiagnostics, shotTargets } from "../src/game/mecha/combat.ts";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { createMatch, living, type ArenaPlan } from "../src/game/mecha/rules.ts";

function fixture(): MatchState {
  return createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [],
    boss: { x: 7, y: 0 }, raiders: [{ id: "raider-w", pos: { x: 0, y: 3 } }, { id: "raider-e", pos: { x: 3, y: 5 } }],
    mechs: [{ id: "Assault", pos: { x: 8, y: 8 } }, { id: "Gunner", pos: { x: 0, y: 6 } }, { id: "Support", pos: { x: 1, y: 5 } }] });
}
const at = { x: 0, y: 6 };
const check = (s: MatchState, id: string, ignore = 0) => shotTargetDiagnostics(s, at, 4, ignore).find(t => t.id === id)!.check;

test("diagnoses living targets and the actual 2x2 boss aim", () => {
  const s = fixture();
  assert.deepEqual(check(s, "raider-w"), { status: "available" });
  assert.deepEqual(check(s, "raider-e"), { status: "not_aligned" });
  assert.deepEqual(check(s, "boss"), { status: "not_aligned" });
  s.raiders[0].hp = 0;
  s.boss.anchor = { x: 0, y: 1 };
  assert.deepEqual(check(s, "boss"), { status: "available" }); // nearest footprint cell (0,2), not anchor
  s.boss.anchor = { x: 0, y: 6 };
  assert.deepEqual(check(s, "boss"), { status: "same_cell" });
  s.boss.anchor = { x: 0, y: 0 };
  assert.deepEqual(check(s, "boss"), { status: "out_of_range" });
  s.raiders[0].hp = 0;
  assert.ok(!shotTargetDiagnostics(s, at, 4, 0).some(t => t.id === "raider-w"));
  s.boss.hp = 0; s.raiders[1].hp = 0;
  assert.deepEqual(shotTargetDiagnostics(s, at, 4, 0), []);
});

test("mountain, obstacles, cover, rubble, buildings and units use real line-of-fire rules", () => {
  for (const kind of ["mountain", "obstacle", "cover", "building", "rubble", "unit"] as const) {
    const s = fixture(), pos = { x: 0, y: 4 };
    if (kind === "mountain") s.terrain[4][0] = "mountain";
    if (kind === "obstacle") s.obstacles.push(pos);
    if (kind === "cover") s.covers.push(pos);
    if (kind === "building" || kind === "rubble") s.buildings.push({ id: "b", cells: [pos], hp: kind === "building" ? 5 : 0, maxHp: 5 });
    if (kind === "unit") s.mechs.find(m => m.id === "Support")!.pos = pos;
    const status = kind === "mountain" ? "blocked_terrain" : kind === "obstacle" ? "blocked_obstacle" : kind === "unit" ? "blocked_unit" : "blocked_cover";
    assert.deepEqual(check(s, "raider-w"), { status, cell: pos }, kind);
    assert.equal(check(s, "raider-w", 1).status, ["cover", "building", "rubble"].includes(kind) ? "available" : status, kind);
  }
  const s = fixture(); s.covers.push({ x: 0, y: 4 }, { x: 0, y: 5 });
  assert.deepEqual(check(s, "raider-w", 1), { status: "blocked_cover", cell: { x: 0, y: 4 } });
  s.raiders[0].pos = { x: 0, y: 6 };
  assert.deepEqual(shotTargetDiagnostics(s, { x: 0, y: 3 }, 4, 1).find(t => t.id === "raider-w")!.check, { status: "blocked_cover", cell: { x: 0, y: 5 } });
  s.raiders[0].pos = { x: 0, y: 3 };
  s.covers = []; s.terrain[4][0] = "water"; s.heights[4][0] = 20;
  assert.equal(check(s, "raider-w").status, "available", "water and height do not currently block shooting");
});

// Independent pre-change target predicate protects gameplay compatibility.
function legacyTargets(s: MatchState, from: Cell, range: number, ignore: number): string[] {
  const can = (to: Cell) => {
    const d = cheb(from, to);
    if (d < 1 || d > range || (from.x !== to.x && from.y !== to.y)) return false;
    const cells: Cell[] = [];
    if (from.x === to.x) for (let y = Math.min(from.y, to.y) + 1; y < Math.max(from.y, to.y); y++) cells.push({ x: from.x, y });
    else for (let x = Math.min(from.x, to.x) + 1; x < Math.max(from.x, to.x); x++) cells.push({ x, y: from.y });
    let covers = 0;
    for (const c of cells) {
      if (terrainAt(s, c) === "mountain") return false;
      const occ = occupant(s, c);
      if (occ === "obstacle") return false;
      if (occ === "cover" || occ === "building" || occ === "rubble") { if (++covers > ignore) return false; }
      else if (occ !== "empty" && !eq(c, to)) return false;
    }
    return true;
  };
  const ids: string[] = [];
  if (s.boss.hp > 0) {
    const aligned = footprint(s.boss.anchor).filter(c => c.x === from.x || c.y === from.y);
    aligned.sort((a, b) => cheb(from, a) - cheb(from, b));
    if (aligned[0] && can(aligned[0])) ids.push("boss");
  }
  for (const r of livingRaiders(s)) if (can(r.pos)) ids.push(r.id);
  return ids;
}

test("diagnostics preserve old target legality over seeded boards and footprint positions", () => {
  let seed = 91351;
  const rand = (n: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  for (let i = 0; i < 240; i++) {
    const s = fixture(); s.boss.anchor = { x: rand(9), y: rand(9) };
    for (const r of s.raiders) { r.pos = { x: rand(10), y: rand(10) }; r.hp = rand(5) ? 4 : 0; }
    for (let k = 0; k < 12; k++) {
      const c = { x: rand(10), y: rand(10) }, kind = rand(4);
      if (kind === 0) s.covers.push(c); else if (kind === 1) s.obstacles.push(c); else if (kind === 2) s.terrain[c.y][c.x] = "mountain"; else s.buildings.push({ id: `b${k}`, cells: [c], hp: rand(2) * 4, maxHp: 4 });
    }
    for (const from of [{ x: rand(10), y: rand(10) }, ...footprint(s.boss.anchor)]) for (const range of [0, 1, 3, 4, 9]) for (const ignore of [0, 1]) {
      const expected = legacyTargets(s, from, range, ignore);
      assert.deepEqual(shotTargets(s, from, range, ignore), expected, `board ${i}, from ${JSON.stringify(from)}, range ${range}, ignore ${ignore}`);
      assert.deepEqual(shotTargetDiagnostics(s, from, range, ignore).filter(t => t.check.status === "available").map(t => t.id), expected);
    }
  }
});

test("controller follows all draft moves and expires explanations; cooldown remains separate", () => {
  const s = fixture(); s.phase = "player_plan";
  const hold = (state: MatchState): ArenaPlan => ({ revision: state.revision, items: living(state).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) });
  const c = createMechaController({ match: s, planner: hold }); c.selectMech("Gunner");
  assert.ok(legalActions(s, "Gunner").some(a => a.kind === "shoot"));
  assert.ok(!c.getState().unavailableActions.some(a => a.kind === "shoot"));
  c.setMove("Support", { x: 0, y: 5 });
  const unavailable = c.getState().unavailableActions.find(a => a.kind === "shoot")!;
  assert.equal(unavailable.reason, "no_target");
  assert.deepEqual(unavailable.shotTargets?.find(t => t.id === "raider-w")?.check, { status: "blocked_unit", cell: { x: 0, y: 5 } });
  c.undoMove();
  assert.ok(!c.getState().unavailableActions.some(a => a.kind === "shoot"));
  const cooling = fixture(); cooling.mechs.find(m => m.id === "Gunner")!.cd = 1; cooling.phase = "player_plan";
  const d = createMechaController({ match: cooling, planner: hold }); d.selectMech("Gunner");
  assert.deepEqual(d.getState().unavailableActions.find(a => a.kind === "pierce"), { kind: "pierce", reason: "cooldown" });
});
