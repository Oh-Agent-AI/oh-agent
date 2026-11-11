import assert from "node:assert/strict";
import test from "node:test";
import { createMatch } from "../src/game/mecha/rules.ts";
import {
  advanceSwarmBattle, cancelVoidSwarmBattle, createSwarmBattle, prepareSwarmBattle,
  reconcileSwarmBattle, reprojectSwarmBattle, resolveSwarmBattle, type SwarmBattle, type SwarmBattleResult,
} from "./mecha-swarm-host-fixture.ts";
import { enemiesRemain, occupant, type Cell } from "../src/game/mecha/board.ts";

const c = (x: number, y: number) => ({ x, y });
function battle(): SwarmBattle {
  return createSwarmBattle(createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [],
    boss: c(4, 4), raiders: [], mechs: [
      { id: "Assault", pos: c(0, 9) }, { id: "Gunner", pos: c(1, 9) }, { id: "Support", pos: c(2, 9) },
    ] }));
}
function ok(result: SwarmBattleResult) {
  assert.equal(result.status, "resolved", JSON.stringify(result.status === "void" ? result.reason : ""));
  if (result.status !== "resolved") throw new Error(result.reason);
  return result;
}
function prepare(b: SwarmBattle) { return ok(prepareSwarmBattle(b)).battle; }
function commit(b: SwarmBattle) { return ok(resolveSwarmBattle(b, reprojectSwarmBattle(b))); }
function slot(b: SwarmBattle, cell: Cell) {
  const p = reprojectSwarmBattle(b);
  if (p.status !== "reprojected" || p.skillId !== "split_swarm") throw new Error(JSON.stringify(p));
  return p.slots.find(s => s.cell.x === cell.x && s.cell.y === cell.y)!;
}

test("bound host projection is deterministic, immutable and matches resolved births", () => {
  const initial = battle(), before = structuredClone(initial), prepared = prepare(initial);
  assert.deepEqual(initial, before);
  assert.deepEqual(prepared.pending?.intent.request.candidates, [c(4, 3), c(5, 3), c(3, 4), c(6, 4), c(3, 5), c(6, 5), c(4, 6), c(5, 6)]);
  const projected = reprojectSwarmBattle(prepared), result = commit(prepared);
  assert.deepEqual(commit(structuredClone(prepared)), result);
  assert.deepEqual(commit(JSON.parse(JSON.stringify(prepared))), result);
  if (projected.status !== "reprojected" || projected.skillId !== "split_swarm") throw new Error("no projection");
  assert.deepEqual(result.events.filter(e => e.type === "raider_spawn").map(e => e.unit),
    projected.slots.flatMap(s => s.unit ? [{ id: s.unit.id, pos: s.unit.cell, hp: s.unit.hp }] : []));
  assert.deepEqual(result.battle.match.raiders.map(r => [r.id, r.hp, r.intent, r.summon]), [
    ["swarm:0", 2, null, { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 3 }],
    ["swarm:1", 2, null, { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 3 }],
  ]);
  assert.equal(occupant(result.battle.match, c(4, 3)), "raider");
  assert.equal(result.battle.nextSpawnId, 2);
  assert.deepEqual(result.battle.resolvedActions, ["split:1"]);
  assert.equal((prepareSwarmBattle(result.battle) as any).reason, "already_resolved");
});

test("reprojects fixed cells after movement, terrain, reservations and boss displacement", () => {
  const p = prepare(battle()), old = reprojectSwarmBattle(p), changed = structuredClone(p);
  changed.match.mechs[0]!.pos = c(4, 3);
  changed.match.terrain[3]![5] = "water";
  changed.match.covers.push(c(3, 4));
  changed.match.deployment = { zone: [c(6, 4)], reservedCells: [c(3, 5)] };
  changed.match.boss.anchor = c(4, 5);
  const projection = reprojectSwarmBattle(changed);
  assert.equal((resolveSwarmBattle(changed, old) as any).reason, "stale_projection");
  assert.equal(slot(changed, c(4, 3)).reason, "out_of_range");
  assert.equal(slot(changed, c(5, 3)).reason, "out_of_range");
  assert.equal(slot(changed, c(3, 4)).reason, "out_of_range");
  assert.equal(slot(changed, c(6, 4)).reason, "out_of_range");
  assert.equal(slot(changed, c(3, 5)).reason, "blocked");
  assert.equal(slot(changed, c(4, 6)).reason, "occupied");
  assert.deepEqual(resolveSwarmBattle(changed, projection), resolveSwarmBattle(structuredClone(changed), structuredClone(projection)));
  assert.deepEqual(changed.pending, p.pending);
});

test("rejects a single-cell corridor cut and preserves the explicit skip reason", () => {
  const b = battle();
  b.match.terrain = Array.from({ length: 10 }, () => Array(10).fill("water"));
  for (let x = 0; x < 10; x++) b.match.terrain[3]![x] = "land";
  for (const p of [c(4,4), c(5,4), c(4,5), c(5,5)]) b.match.terrain[p.y]![p.x] = "land";
  b.match.mechs[0]!.pos = c(0, 3); b.match.mechs[1]!.pos = c(1, 3); b.match.mechs[2]!.pos = c(2, 3);
  const p = prepare(b), projection = reprojectSwarmBattle(p);
  assert.equal(slot(p, c(4, 3)).reason, "protected_path");
  assert.equal(slot(p, c(5, 3)).reason, "protected_path");
  const result = ok(resolveSwarmBattle(p, projection));
  assert.ok(result.events.some(e => e.type === "summon_skipped" && e.reason === "protected_path"));
  assert.equal(result.battle.match.raiders.length, 0);
});

test("two individually legal births cannot jointly cut an existing route", () => {
  const b = battle();
  for (let y = 0; y < 10; y++) if (y !== 3 && y !== 6) b.match.terrain[y]![4] = "water";
  b.match.deployment = { zone: [], reservedCells: [c(5,3), c(3,4), c(6,4), c(3,5), c(6,5), c(5,6)] };
  b.match.mechs[0]!.pos = c(0, 3); b.match.mechs[1]!.pos = c(1, 3); b.match.mechs[2]!.pos = c(2, 3);
  const p = prepare(b);
  assert.equal(slot(p, c(4, 3)).reason, null);
  assert.equal(slot(p, c(4, 6)).reason, "protected_path");
  const result = commit(p);
  assert.deepEqual(result.battle.match.raiders.map(r => r.pos), [c(4, 3)]);
});

test("cap, death, parent death and expiry keep monotonic IDs and victory honest", () => {
  let b = commit(prepare(battle())).battle;
  b = ok(advanceSwarmBattle(b)).battle;
  b = commit(prepare(b)).battle;
  assert.equal(b.match.raiders.length, 4);
  assert.equal(b.nextSpawnId, 4);
  b.match.boss.hp = 0; b.match.raiders[0]!.hp = 0;
  assert.equal(enemiesRemain(b.match), true);
  assert.equal((advanceSwarmBattle(b) as any).reason, "reconciliation_required");
  const clean = ok(reconcileSwarmBattle(b));
  assert.deepEqual(clean.events, [{ type: "raider_remove", unit: { id: "swarm:0", pos: c(4,3), hp: 0 }, reason: "death" }]);
  assert.equal(clean.battle.match.outcome, null);
  const expired = ok(advanceSwarmBattle(clean.battle));
  assert.deepEqual(expired.events.filter(e => e.type === "raider_remove").map(e => [e.unit.id, e.reason]), [["swarm:1", "expired"]]);
  assert.equal(expired.battle.match.raiders.length, 2);
  const end = ok(advanceSwarmBattle(expired.battle));
  assert.deepEqual(end.events.map(e => e.type), ["raider_remove", "raider_remove", "outcome"]);
  assert.equal(end.battle.match.outcome, "victory");
  assert.equal(end.battle.match.phase, "finished");
  assert.equal((advanceSwarmBattle(end.battle) as any).reason, "finished");
});

test("dead caster cancels bound action; tampered content and duplicate action fail closed", () => {
  let b = commit(prepare(battle())).battle;
  b = ok(advanceSwarmBattle(b)).battle;
  const p = prepare(b), changed = structuredClone(p);
  changed.match.boss.hp = 0;
  assert.deepEqual(reprojectSwarmBattle(changed), { status: "void", reason: "actor_dead" });
  const canceled = ok(cancelVoidSwarmBattle(changed)).battle;
  assert.equal(canceled.pending, null);
  assert.deepEqual(canceled.resolvedActions, ["split:1", "split:2"]);
  assert.equal((prepareSwarmBattle(canceled) as any).reason, "already_resolved");
  assert.equal(canceled.match.raiders.length, 2);
  const bad = structuredClone(p);
  if (bad.pending?.intent.request.skillId !== "split_swarm") throw new Error("not split");
  bad.pending.intent.request.hp = 999;
  assert.deepEqual(reprojectSwarmBattle(bad), { status: "void", reason: "invalid_state" });
  assert.equal((resolveSwarmBattle(bad) as any).reason, "invalid_state");
  assert.equal((cancelVoidSwarmBattle(p) as any).reason, "intent_not_cancelable");
});

test("the synthetic adapter cannot wrap the authoritative L5 match or admit namespace collisions", () => {
  const authoritative = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash",
    monsterContent: { speciesId: "swarm_mantle", contentVersion: 1 } });
  assert.throws(() => createSwarmBattle(authoritative), /swarm_adapter_unavailable/);
  const b = battle(); b.match.raiders.push({ id: "swarm:0", hp: 2, pos: c(1, 1), intent: null });
  assert.throws(() => createSwarmBattle(b.match), /swarm_adapter_unavailable/);
});

test("projection equality is structural but remains sensitive to order and extra fields", () => {
  const p = prepare(battle()), projection = reprojectSwarmBattle(p);
  assert.equal(projection.status, "reprojected");
  if (projection.status !== "reprojected" || projection.skillId !== "split_swarm") throw new Error("no projection");
  const reordered = { slots: projection.slots.map(s => ({ unit: s.unit, reason: s.reason, cell: s.cell })),
    skillId: projection.skillId, status: projection.status } as typeof projection;
  assert.equal(resolveSwarmBattle(p, reordered).status, "resolved");
  assert.equal((resolveSwarmBattle(p, { ...projection, slots: [...projection.slots].reverse() }) as any).reason, "stale_projection");
  assert.equal((resolveSwarmBattle(p, { ...projection, extra: true } as typeof projection) as any).reason, "stale_projection");
});

test("death wins over same-boundary expiry; removed IDs are never reused", () => {
  let b = commit(prepare(battle())).battle;
  b = ok(advanceSwarmBattle(b)).battle;
  b = commit(prepare(b)).battle;
  b.match.raiders[0]!.hp = 0;
  b.match.turn = 3; // Health effect and boundary are both due before reconciliation.
  const cleaned = ok(reconcileSwarmBattle(b));
  assert.deepEqual(cleaned.events.filter(e => e.type === "raider_remove").map(e => [e.unit.id, e.reason]),
    [["swarm:0", "death"], ["swarm:1", "expired"]]);
  b = commit(prepare(cleaned.battle)).battle;
  assert.deepEqual(b.match.raiders.map(r => r.id), ["swarm:2", "swarm:3", "swarm:4", "swarm:5"]);
  assert.equal(b.nextSpawnId, 6);
});

test("lifecycle cleanup uses normal non-mission outcome precedence", () => {
  const b = commit(prepare(battle())).battle;
  for (const m of b.match.mechs) m.hp = 0;
  const wipe = ok(reconcileSwarmBattle(b));
  assert.equal(wipe.battle.match.outcome, "defeat_wipe");
  assert.deepEqual(wipe.events, [{ type: "outcome", outcome: "defeat_wipe" }]);
  b.match.boss.hp = 0;
  for (const r of b.match.raiders) r.hp = 0;
  const simultaneous = ok(reconcileSwarmBattle(b));
  assert.deepEqual(simultaneous.events.map(e => e.type), ["raider_remove", "raider_remove", "outcome"]);
  assert.equal(simultaneous.battle.match.outcome, "victory");
});

test("existing combat refresh can finish before swarm cleanup, so the adapter is not a turn hook", async () => {
  const { refresh } = await import("../src/game/mecha/combat.ts");
  const b = commit(prepare(battle())).battle;
  b.match.boss.hp = 0;
  for (const r of b.match.raiders) r.hp = 0;
  refresh(b.match);
  assert.equal(b.match.outcome, "victory");
  assert.equal(b.match.raiders.length, 2);
  assert.equal((reconcileSwarmBattle(b) as any).reason, "finished");
});

test("dead or expired children must be reconciled before preparation or resolution", () => {
  let b = commit(prepare(battle())).battle;
  b = ok(advanceSwarmBattle(b)).battle;
  b.match.raiders[0]!.hp = 0;
  assert.equal((prepareSwarmBattle(b) as any).reason, "reconciliation_required");
  b.match.raiders[0]!.hp = 2;
  const pending = prepare(b);
  pending.match.raiders[0]!.hp = 0;
  assert.deepEqual(reprojectSwarmBattle(pending), { status: "void", reason: "reconciliation_required" });
  assert.equal((resolveSwarmBattle(pending) as any).reason, "reconciliation_required");
  const cleaned = ok(reconcileSwarmBattle(pending)).battle;
  assert.equal(reprojectSwarmBattle(cleaned).status, "reprojected");
});

test("protected paths account for Assault-only unsafe edges", () => {
  const b = battle();
  b.match.terrain = Array.from({ length: 10 }, () => Array(10).fill("water"));
  for (let x = 0; x < 10; x++) b.match.terrain[3]![x] = "land";
  for (const p of [c(3,2), c(4,2), c(5,2), c(5,3), c(4,4), c(5,4), c(4,5), c(5,5)]) b.match.terrain[p.y]![p.x] = "land";
  b.match.mechs[0]!.pos = c(0, 3); b.match.mechs[1]!.pos = c(1, 3); b.match.mechs[2]!.pos = c(2, 3);
  b.match.assaultTerrainSafety = { unsafeCells: [], unsafeEdges: [{ from: c(3,3), to: c(3,2) }] };
  const p = prepare(b);
  assert.equal(slot(p, c(4, 3)).reason, "protected_path");
});

test("spawn legality covers terrain, structures including rubble, safety, deployment and living occupancy", () => {
  const b = battle(), s = b.match;
  s.terrain[3]![4] = "water"; s.terrain[3]![5] = "mountain";
  s.obstacles.push(c(3,4)); s.covers.push(c(6,4));
  s.buildings.push({ id: "rubble", cells: [c(3,5)], hp: 0, maxHp: 16 });
  s.deployment = { zone: [], reservedCells: [c(6,5)] };
  s.assaultTerrainSafety = { unsafeCells: [c(4,6)], unsafeEdges: [] };
  s.mechs[0]!.pos = c(5,6);
  const p = prepare(b), result = commit(p);
  assert.deepEqual(result.events.map(e => e.type === "summon_skipped" ? e.reason : e.type),
    ["blocked", "blocked", "blocked", "blocked", "blocked", "blocked", "blocked", "occupied"]);
  assert.equal(result.battle.match.raiders.length, 0);
});
