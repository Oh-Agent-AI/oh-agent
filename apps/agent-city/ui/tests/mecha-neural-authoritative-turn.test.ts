import assert from "node:assert/strict";
import test from "node:test";
import { assertMonsterState, neuralBonus, type ArenaPlan, type MatchState } from "../src/game/mecha/board.ts";
import { incomingDamage, refresh, reproject, tryTranslateBoss } from "../src/game/mecha/combat.ts";
import { bossExecute } from "../src/game/mecha/enemy.ts";
import { applyEnemyPlan, bossPrepare, scriptedEnemyPlanner, prepareEnemy } from "../src/game/mecha/enemy/planner.ts";
import { createMatch, playTurn, previewPlan } from "../src/game/mecha/rules.ts";

const c = (x: number, y: number) => ({ x, y });
function initial(raiders = [{ id: "a", pos: c(3,4) }, { id: "b", pos: c(6,4) }]): MatchState {
  return createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: c(4,4), raiders,
    mechs: [{ id: "Assault", pos: c(2,4) }, { id: "Gunner", pos: c(0,9) }, { id: "Support", pos: c(1,9) }],
    monsterContent: { speciesId: "neural_weaver", contentVersion: 1 } });
}
function hold(s: MatchState): ArenaPlan { return { revision: s.revision, items: s.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) }; }
function prepared(): MatchState { const s = initial(); bossPrepare(s); return s; }
function turn(s: MatchState) { const r = playTurn(s, hold(s)); assert.equal(r.ok, true, JSON.stringify(r)); if (!r.ok) throw new Error("bad turn"); return r; }

test("real turn prepares a fixed ordinary raider, projects bonus and matches preview, execution and serialized continuation", () => {
  const s = prepared(), before = structuredClone(s);
  assert.equal(s.boss.intent?.skillId, "neural_link");
  assert.equal(s.neural?.pending?.request.skillId, "neural_link");
  const req = s.neural!.pending!.request; if (req.skillId !== "neural_link") throw Error();
  assert.equal(req.targetId, "raider:a");
  const node = s.raiders.find(r => r.id === "a")!;
  assert.ok(node.intent!.projected.some(p => p.x === 2 && p.y === 4), JSON.stringify(node));
  const incoming = incomingDamage(s, "Assault", c(2,4));
  const preview = previewPlan(s, hold(s)); assert.equal(preview.ok, true); if (!preview.ok) throw Error();
  assert.equal(preview.monsterProjection?.swarmProjection?.status, "reprojected");
  const result = turn(s);
  assert.deepEqual(s, before);
  assert.deepEqual(turn(JSON.parse(JSON.stringify(s))), result);
  assert.deepEqual(preview.log, result.log);
  const hit = result.log.find(e => e.type === "enemy" && e.actor === "a");
  assert.ok(hit && hit.type === "enemy"); assert.equal(hit.damage, 3);
  assert.equal(preview.hitsAfter.Assault, incoming);
  assert.equal(incoming, 4);
  assert.ok(result.state.neural!.journal.some(e => e.type === "link_created" && e.link.targetId === "raider:a"));
});

test("no eligible node is an explicit harmless void, while legacy raiders remain unchanged", () => {
  const s = initial([]); bossPrepare(s); assert.equal(s.boss.intent?.status, "void");
  assert.equal(s.neural?.pending, null); assert.deepEqual(turn(s).state.neural?.journal, []);
  const legacy = initial(); delete legacy.neural; delete legacy.monsterContent; bossPrepare(legacy);
  assert.equal(legacy.boss.intent?.skillId, "smash"); assert.equal("neural" in turn(legacy).state, false);
});

test("tampered binding and ledger are rejected without mutation; custom plan cannot retarget", () => {
  const s = prepared(), forged = structuredClone(s);
  const req = forged.boss.intent!.swarm!.request; if (req.skillId !== "neural_link") throw Error(); req.targetId = "raider:b";
  const before = structuredClone(forged); assert.throws(() => playTurn(forged, hold(forged)), /unsupported_neural_state/); assert.deepEqual(forged, before);
  const planState = initial(), plan = scriptedEnemyPlanner.plan(planState), saved = structuredClone(planState);
  const request = plan.boss.intent!.swarm!.request; if (request.skillId !== "neural_link") throw Error(); request.targetId = "raider:b";
  assert.equal(applyEnemyPlan(planState, plan), false); assert.deepEqual(planState, saved);
  const accessor = prepared(); let reads = 0;
  Object.defineProperty(accessor.neural!, "pending", { enumerable: true, get() { reads++; return null; } });
  assert.throws(() => assertMonsterState(accessor), /unsupported_neural_state/); assert.equal(reads, 0);
});

test("pending node death voids the original declaration rather than selecting another", () => {
  const s = prepared(), req = s.neural!.pending!.request; if (req.skillId !== "neural_link") throw Error();
  s.raiders.find(r => `raider:${r.id}` === req.targetId)!.hp = 0; refresh(s); reproject(s);
  assert.equal(s.boss.intent!.swarmProjection?.status, "void");
  bossExecute(s);
  assert.ok(s.neural!.journal.some(e => e.type === "link_void" && e.targetId === req.targetId && e.reason === "target_dead"));
  assert.equal(s.neural!.nextLinkId, 0);
});

test("active links reconcile displacement, death, expiry and terminal without further bonus", () => {
  for (const cause of ["move", "target", "source", "expired", "finished"] as const) {
    const s = prepared(); bossExecute(s);
    assert.equal(s.neural!.links.length, 1, cause);
    const link = s.neural!.links[0]!, target = s.raiders.find(r => `raider:${r.id}` === link.targetId)!;
    if (cause === "move") { s.boss.anchor = c(7,7); refresh(s); }
    if (cause === "target") { target.hp = 0; refresh(s); }
    if (cause === "source") { s.boss.hp = 0; refresh(s); }
    if (cause === "expired") { s.turn = link.expiresAtRound; refresh(s); }
    if (cause === "finished") { s.outcome = "defeat_timeout"; refresh(s); }
    assert.equal(s.neural!.links.length, 0, cause); assert.equal(neuralBonus(s, target.id), 0);
    const expected = { move: "out_of_range", target: "target_dead", source: "source_dead", expired: "expired", finished: "finished" }[cause];
    assert.ok(s.neural!.journal.some(e => e.type === "link_broken" && e.reason === expected), JSON.stringify(s.neural));
    assertMonsterState(s);
  }
});

test("actual player kill invalidates pending target, preview and turn agree, and next round is a new declaration", () => {
  const s = prepared(); s.raiders.find(r => r.id === "a")!.hp = 4;
  const plan = hold(s); plan.items[0]!.action = { kind: "melee", target: "a" };
  const preview = previewPlan(s, plan), result = playTurn(s, plan);
  assert.ok(preview.ok && result.ok); if (!preview.ok || !result.ok) throw Error();
  assert.deepEqual(preview.log, result.log);
  assert.deepEqual(preview.monsterProjection?.swarmProjection, { status: "void", reason: "target_dead" });
  assert.equal(result.state.neural!.journal[0]?.type, "link_void");
  assert.deepEqual(result.state.neural!.journal[0], { type: "link_void", round: 1, actionId: "neural:1", targetId: "raider:a", reason: "target_dead" });
  assert.equal(result.state.neural!.nextLinkId, 0);
  const next = result.state.neural!.pending!.request; assert.equal(next.skillId === "neural_link" && next.targetId, "raider:b");
});

test("actual boss displacement breaks an active link at the first out-of-range endpoint", () => {
  const s = prepared(); bossExecute(s); assert.equal(s.neural!.links.length, 1);
  assert.equal(tryTranslateBoss(s, c(1,0)), true); assert.equal(s.neural!.links.length, 1);
  assert.equal(tryTranslateBoss(s, c(1,0)), true); assert.equal(s.neural!.links.length, 1);
  assert.equal(tryTranslateBoss(s, c(1,0)), true); assert.equal(s.neural!.links.length, 0);
  assert.equal(s.neural!.journal.at(-1)?.type, "link_broken");
  assert.equal((s.neural!.journal.at(-1) as any).reason, "out_of_range");
});

test("enemy planner reproduces link reconciliation when its actual raider movement leaves range", () => {
  const s = prepared(); bossExecute(s);
  s.mechs[0]!.pos = c(0,0); s.mechs[1]!.pos = c(0,1); s.mechs[2]!.pos = c(1,0);
  const plan = scriptedEnemyPlanner.plan(s), original = structuredClone(s);
  assert.equal(applyEnemyPlan(s, plan), true);
  assert.equal(s.neural!.links.length, 0, JSON.stringify({ original: original.raiders, after: s.raiders }));
  assert.ok(s.neural!.journal.some(e => e.type === "link_broken" && e.reason === "out_of_range"));
  assertMonsterState(s);
});

test("timeout at round boundary clears a newly resolved link and records the terminal reason", () => {
  const s = initial(); s.turn = 15; bossPrepare(s);
  const result = turn(s).state;
  assert.equal(result.turn, 16); assert.equal(result.outcome, "defeat_timeout");
  assert.deepEqual(result.neural!.links, []); assert.equal(result.neural!.pending, null);
  assert.deepEqual(result.neural!.journal.map(e => e.type), ["link_created", "link_broken"]);
  assert.equal((result.neural!.journal[1] as any).reason, "finished"); assertMonsterState(result);
});

test("malformed projection, stale links, invalid geometry and accessor planner are rejected before mutation", () => {
  const p = prepared(); if (p.boss.intent!.swarmProjection?.status !== "reprojected") throw Error();
  p.boss.intent!.swarmProjection.attackBonus = 10;
  assert.throws(() => previewPlan(p, hold(p)), /unsupported_neural_state/);
  const s = prepared(); bossExecute(s); s.raiders.find(r => r.id === "a")!.hp = 0;
  assert.throws(() => bossPrepare(s), /unsupported_neural_state/);
  assert.throws(() => initial([{ id: "duplicate", pos: c(2,2) }, { id: "duplicate", pos: c(3,2) }]), /unsupported_neural_state/);
  assert.throws(() => initial([{ id: "overlap", pos: c(4,4) }]), /unsupported_neural_state/);
  const state = initial(), plan = scriptedEnemyPlanner.plan(state), before = structuredClone(state); let reads = 0;
  Object.defineProperty(plan, "revision", { enumerable: true, get() { reads++; return 0; } });
  assert.equal(applyEnemyPlan(state, plan), false); assert.equal(reads, 0); assert.deepEqual(state, before);
});

test("L8 planner operates on an isolated copy and untrusted intent descriptors are not invoked", () => {
  const state = initial(), before = structuredClone(state);
  const planner = { policy: "scripted:v1" as const, plan(copy: MatchState) {
    copy.boss.hp = 1;
    return scriptedEnemyPlanner.plan(copy);
  } };
  const expected = structuredClone(before); bossPrepare(expected);
  prepareEnemy(state, planner);
  assert.deepEqual(state, expected); assert.equal(state.boss.hp, before.boss.hp);
  for (const key of ["skillId", "status", "local", "projected", "swarm"] as const) {
    const p = prepared(); let reads = 0;
    Object.defineProperty(p.boss.intent!, key, { enumerable: true, configurable: true, get() { reads++; return undefined; } });
    assert.throws(() => assertMonsterState(p), /unsupported_neural_state/); assert.equal(reads, 0, key);
  }
});

test("the linked raider also gains the flat pre-defense bonus against buildings", () => {
  const s = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: c(4,4),
    raiders: [{ id: "a", pos: c(3,4) }], buildings: [{ id: "building", cells: [c(2,4)], hp: 10 }],
    mechs: [{ id: "Assault", pos: c(0,9) }, { id: "Gunner", pos: c(1,9) }, { id: "Support", pos: c(2,9) }],
    monsterContent: { speciesId: "neural_weaver", contentVersion: 1 } });
  bossPrepare(s); const p = previewPlan(s, hold(s)), r = turn(s); assert.ok(p.ok); if (!p.ok) throw Error();
  assert.deepEqual(p.log, r.log); assert.equal(p.buildings[0]!.endHp, 5);
  const hit = r.log.find(e => e.type === "enemy" && e.actor === "a");
  assert.ok(hit && hit.type === "enemy"); assert.equal(hit.damage, 5);
});

test("real multiple turns expire links, assign monotonic IDs, and serialize deterministically", () => {
  let a = prepared(), b = JSON.parse(JSON.stringify(a)) as MatchState;
  for (let i = 0; i < 3; i++) {
    const r = turn(a), copy = turn(b); assert.deepEqual(copy, r);
    a = r.state; b = JSON.parse(JSON.stringify(copy.state));
  }
  assert.ok(a.neural!.journal.some(e => e.type === "link_broken" && e.linkId === "neural-link:0" && e.reason === "expired"));
  assert.ok(a.neural!.journal.some(e => e.type === "link_created" && e.link.id === "neural-link:1"));
  assert.ok(a.neural!.journal.some(e => e.type === "link_created" && e.link.id === "neural-link:2"));
  assertMonsterState(a);
});

test("player killing the source breaks existing links and voids this round's pending link", () => {
  let s = turn(prepared()).state;
  assert.equal(s.neural!.links.length, 1); assert.ok(s.neural!.pending);
  s.mechs.find(m => m.id === "Assault")!.pos = c(3,5); s.boss.hp = 2;
  const plan = hold(s); plan.items.find(i => i.mechId === "Assault")!.action = { kind: "melee", target: "boss" };
  const preview = previewPlan(s, plan), r = playTurn(s, plan); assert.ok(preview.ok && r.ok); if (!preview.ok || !r.ok) throw Error();
  assert.deepEqual(preview.log, r.log);
  assert.equal(r.state.boss.hp, 0); assert.equal(r.state.neural!.pending, null); assert.deepEqual(r.state.neural!.links, []);
  assert.ok(r.state.neural!.journal.some(e => e.type === "link_broken" && e.reason === "source_dead"));
  assert.ok(r.state.neural!.journal.some(e => e.type === "link_void" && e.reason === "actor_dead"));
  assertMonsterState(r.state);
});
