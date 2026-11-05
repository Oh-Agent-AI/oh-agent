import assert from "node:assert/strict";
import test from "node:test";
import { createMatch, bossPrepare, playTurn } from "../src/game/mecha/rules.ts";
import { raiderDamageTo } from "../src/game/mecha/combat.ts";
import { NEURAL_LINK_BREAK_CONDITIONS, linkedAttackBonus, reconcileSwarmLink, type SwarmLinkState } from "../src/game/mecha/skillSwarmLink.ts";
import { advanceNeuralBattle, attackNeuralBattle, cancelNeuralBattle, createNeuralBattle, finishNeuralBattle,
  prepareNeuralBattle, projectNeuralBattle, inspectNeuralBattle, reconcileNeuralBattle, resolveNeuralBattle, type NeuralBattle, type NeuralResult } from "./mecha-neural-host-fixture.ts";

const c = (x: number, y: number) => ({ x, y });
function battle(): NeuralBattle {
  return createNeuralBattle(createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: c(4, 4),
    raiders: [{ id: "z", pos: c(6, 5) }, { id: "a", pos: c(3, 4) }],
    mechs: [{ id: "Assault", pos: c(0, 9) }, { id: "Gunner", pos: c(1, 9) }, { id: "Support", pos: c(2, 9) }] }));
}
function ok(r: NeuralResult) {
  if (r.status !== "resolved") assert.fail(r.reason);
  return r;
}
function reason(r: NeuralResult, expected: string) {
  assert.equal(r.status, "void"); if (r.status === "void") { assert.equal(r.reason, expected); assert.deepEqual(r.events, []); }
}
function prepare(b: NeuralBattle) { return ok(prepareNeuralBattle(b)).battle; }
function link(b: NeuralBattle) { const p = prepare(b); return ok(resolveNeuralBattle(p, projectNeuralBattle(p))); }

// The fixture explicitly models a hypothetical host; none of these are playTurn L8 tests.
test("declaration binds deterministic ordinary node, full contract, and immutable state", () => {
  const b = battle(), before = structuredClone(b), p = ok(prepareNeuralBattle(b));
  assert.deepEqual(b, before);
  assert.equal(p.events[0]?.type, "neural_declared");
  const d = p.battle.pending!;
  assert.deepEqual(d.declaredEndpoints, { source: c(4, 4), target: c(3, 4) });
  assert.deepEqual(d.intent, { version: 1, round: 1, request: { skillId: "neural_link", actionId: "neural:1", actorId: "boss", targetId: "raider:a", range: 3, attackBonus: 2, lifetime: 2 } });
  assert.deepEqual(d.declared, { status: "reprojected", skillId: "neural_link", linkId: "neural-link:0", sourceId: "boss", targetId: "raider:a", range: 3, attackBonus: 2, expiresAtRound: 3, breakConditions: [...NEURAL_LINK_BREAK_CONDITIONS] });
  const reordered = battle(); reordered.match.raiders.reverse();
  assert.deepEqual(prepare(reordered).pending, d);
  const created = ok(resolveNeuralBattle(p.battle, projectNeuralBattle(p.battle)));
  assert.deepEqual(created.events, [{ type: "link_created", link: { id: "neural-link:0", sourceId: "boss", targetId: "raider:a", range: 3, attackBonus: 2, expiresAtRound: 3 } }]);
  assert.deepEqual(created.battle.resolvedActions, ["neural:1"]); assert.equal(created.battle.nextLinkId, 1);
  reason(prepareNeuralBattle(created.battle), "already_resolved");
  reason(resolveNeuralBattle(created.battle), "no_intent");
  assert.deepEqual(created, ok(resolveNeuralBattle(JSON.parse(JSON.stringify(p.battle)), JSON.parse(JSON.stringify(d.declared)))));
});

test("reprojection never retargets; vanished or displaced nodes require an explicit consumed void", () => {
  for (const change of ["dead", "missing", "far"] as const) {
    const b = prepare(battle()), declared = structuredClone(b.pending!.declared), changed = structuredClone(b);
    if (change === "missing") changed.match.raiders = changed.match.raiders.filter(r => r.id !== "a");
    else if (change === "dead") changed.match.raiders.find(r => r.id === "a")!.hp = 0;
    else changed.match.raiders.find(r => r.id === "a")!.pos = c(0, 0);
    const why = change === "far" ? "out_of_range" : "target_dead";
    assert.deepEqual(projectNeuralBattle(changed), { status: "void", reason: why });
    reason(resolveNeuralBattle(changed, declared), why);
    const cancelled = ok(cancelNeuralBattle(changed));
    assert.deepEqual(cancelled.events, [{ type: "neural_void", actionId: "neural:1", targetId: "raider:a", reason: why }]);
    reason(prepareNeuralBattle(cancelled.battle), "already_resolved");
  }
  const b = prepare(battle()); b.match.boss.hp = 0;
  assert.deepEqual(projectNeuralBattle(b), { status: "void", reason: "actor_dead" });
  assert.equal(ok(cancelNeuralBattle(b)).events[0]?.type, "neural_void");
});

test("legal movements retain bound node; stale projection cannot commit", () => {
  const p = prepare(battle()), changed = structuredClone(p), old = projectNeuralBattle(p);
  changed.match.raiders.find(r => r.id === "a")!.pos = c(2, 4); // footprint distance 2
  const projected = projectNeuralBattle(changed);
  assert.deepEqual(projected, old); // primitive projection contains no positions
  assert.deepEqual(inspectNeuralBattle(changed), { declared: { source: c(4,4), target: c(3,4) }, current: { source: c(4,4), target: c(2,4) }, projection: old });
  assert.equal(ok(resolveNeuralBattle(changed, projected)).battle.links[0]!.targetId, "raider:a");
  changed.nextLinkId = 1;
  reason(resolveNeuralBattle(changed, old), "stale_projection");
  const actual = ok(resolveNeuralBattle(changed, projectNeuralBattle(changed)));
  assert.equal(actual.battle.links[0]!.id, "neural-link:1");
  assert.deepEqual(changed.pending, p.pending);
});

test("bonus is flat once before defense, exclusively for linked raider; preview does not mutate", () => {
  const b = link(battle()).battle, original = structuredClone(b);
  const preview = ok(attackNeuralBattle(b, "a", "Assault"));
  const base = raiderDamageTo("Assault", b.match);
  assert.deepEqual(preview.events, [{ type: "synthetic_attack", actorId: "raider:a", target: "Assault", baseAttack: 3, bonus: 2, damage: base + 2 }]);
  assert.equal(preview.battle.match.mechs[0]!.hp, b.match.mechs[0]!.hp - base - 2);
  assert.deepEqual(b, original); assert.deepEqual(ok(attackNeuralBattle(b, "a", "Assault")), preview);
  assert.deepEqual(ok(attackNeuralBattle(b, "z", "Assault")).events, [{ type: "synthetic_attack", actorId: "raider:z", target: "Assault", baseAttack: 3, bonus: 0, damage: base }]);
});

test("death, removal, distance, and expiry reconcile before further effects", () => {
  for (const which of ["source_dead", "target_dead", "target_missing", "out_of_range"] as const) {
    const b = link(battle()).battle;
    if (which === "source_dead") b.match.boss.hp = 0;
    if (which === "target_dead") b.match.raiders.find(r => r.id === "a")!.hp = 0;
    if (which === "target_missing") b.match.raiders = b.match.raiders.filter(r => r.id !== "a");
    if (which === "out_of_range") b.match.raiders.find(r => r.id === "a")!.pos = c(0, 0);
    reason(attackNeuralBattle(b, "z", "Assault"), "reconciliation_required");
    reason(prepareNeuralBattle(b), "reconciliation_required");
    const cleaned = ok(reconcileNeuralBattle(b));
    assert.deepEqual(cleaned.events, [{ type: "link_broken", linkId: "neural-link:0", reason: which === "target_missing" ? "target_dead" : which }]);
    assert.deepEqual(cleaned.battle.links, []);
    assert.equal((ok(attackNeuralBattle(cleaned.battle, "z", "Assault")).events[0] as any).bonus, 0);
    assert.deepEqual(ok(reconcileNeuralBattle(cleaned.battle)).events, []);
  }
  let b = link(battle()).battle;
  b = ok(advanceNeuralBattle(b)).battle;
  assert.equal(b.match.turn, 2); assert.equal(b.links.length, 1);
  const end = ok(advanceNeuralBattle(b));
  assert.deepEqual(end.events, [{ type: "link_broken", linkId: "neural-link:0", reason: "expired" }]);
  assert.equal(end.battle.match.turn, 3);
  const relinked = link(end.battle);
  assert.equal(relinked.battle.links[0]!.id, "neural-link:1");
});

test("footprint range boundary and pending action block round advance", () => {
  const b = battle();
  b.match.raiders.find(r => r.id === "a")!.pos = c(8, 5); // nearest boss footprint cell (5,5): distance 3
  b.match.raiders.find(r => r.id === "z")!.pos = c(0, 0);
  const p = prepare(b);
  reason(advanceNeuralBattle(p), "pending_intent");
  reason(cancelNeuralBattle(p), "intent_not_cancelable");
  assert.equal(ok(resolveNeuralBattle(p)).battle.links[0]!.targetId, "raider:a");
  const outside = structuredClone(p); outside.match.raiders.find(r => r.id === "a")!.pos = c(9, 5);
  assert.deepEqual(projectNeuralBattle(outside), { status: "void", reason: "out_of_range" });
  assert.equal(ok(cancelNeuralBattle(outside)).battle.pending, null);
});

test("separate links have independent bonuses and break only their own target", () => {
  let b = link(battle()).battle;
  b = ok(advanceNeuralBattle(b)).battle;
  const second = link(b); b = second.battle;
  assert.deepEqual(b.links.map(l => [l.id, l.targetId, l.expiresAtRound]), [
    ["neural-link:0", "raider:a", 3], ["neural-link:1", "raider:z", 4],
  ]);
  for (const id of ["a", "z"]) {
    const event = ok(attackNeuralBattle(b, id, "Assault")).events[0];
    assert.equal(event?.type, "synthetic_attack");
    if (event?.type === "synthetic_attack") assert.equal(event.bonus, 2);
  }
  const dead = structuredClone(b); dead.match.raiders.find(r => r.id === "a")!.hp = 0;
  const cleaned = ok(reconcileNeuralBattle(dead));
  assert.deepEqual(cleaned.events, [{ type: "link_broken", linkId: "neural-link:0", reason: "target_dead" }]);
  assert.deepEqual(cleaned.battle.links.map(l => l.targetId), ["raider:z"]);
  const remainingAttack = ok(attackNeuralBattle(cleaned.battle, "z", "Assault")).events[0];
  assert.equal(remainingAttack?.type, "synthetic_attack");
  if (remainingAttack?.type === "synthetic_attack") assert.equal(remainingAttack.bonus, 2);
  const nextRound = ok(advanceNeuralBattle(b));
  assert.deepEqual(nextRound.events, [{ type: "link_broken", linkId: "neural-link:0", reason: "expired" }]);
  assert.deepEqual(nextRound.battle.links.map(l => l.targetId), ["raider:z"]);
});

test("an older broken link reconciles before another pending declaration can resolve", () => {
  let b = link(battle()).battle;
  b = ok(advanceNeuralBattle(b)).battle;
  b = prepare(b);
  assert.equal(b.pending?.intent.request.skillId, "neural_link");
  if (b.pending?.intent.request.skillId !== "neural_link") throw new Error("bad intent");
  assert.equal(b.pending.intent.request.targetId, "raider:z");
  const projection = projectNeuralBattle(b);
  b.match.raiders.find(r => r.id === "a")!.hp = 0;
  assert.deepEqual(projectNeuralBattle(b), { status: "void", reason: "reconciliation_required" });
  reason(resolveNeuralBattle(b, projection), "reconciliation_required");
  const cleaned = ok(reconcileNeuralBattle(b));
  assert.deepEqual(cleaned.events, [{ type: "link_broken", linkId: "neural-link:0", reason: "target_dead" }]);
  assert.equal(cleaned.battle.pending?.intent.request.skillId, "neural_link");
  const committed = ok(resolveNeuralBattle(cleaned.battle, projectNeuralBattle(cleaned.battle)));
  assert.deepEqual(committed.battle.links.map(l => l.targetId), ["raider:z"]);
});

test("primitive side change and simultaneous break reasons have deterministic precedence", () => {
  const s: SwarmLinkState = { version: 1, width: 10, height: 10, round: 2, finished: false, blocked: [], nextSpawnId: 0, nextLinkId: 1, resolvedActions: [],
    units: [{ id: "boss", side: "enemy", cell: c(4,4), width: 2, height: 2, hp: 1 }, { id: "raider:a", side: "player", cell: c(0,0), width: 1, height: 1, hp: 1 }],
    links: [{ id: "neural-link:0", sourceId: "boss", targetId: "raider:a", range: 3, attackBonus: 2, expiresAtRound: 2 }] };
  assert.equal(linkedAttackBonus(s, "raider:a"), 0);
  const result = reconcileSwarmLink(s); assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.deepEqual(result.events, [{ type: "link_broken", linkId: "neural-link:0", reason: "side_changed" }]);
  s.units[0]!.hp = 0; s.units[1]!.hp = 0;
  const deaths = reconcileSwarmLink(s); assert.equal(deaths.status, "resolved");
  if (deaths.status === "resolved") assert.deepEqual(deaths.events, [{ type: "link_broken", linkId: "neural-link:0", reason: "source_dead" }]);
});

test("finish reconciles first, emits host cleanup once, and rejects further effects", () => {
  const first = link(battle()).battle, ended = ok(finishNeuralBattle(first, "defeat_wipe"));
  assert.deepEqual(ended.events, [{ type: "link_broken", linkId: "neural-link:0", reason: "finished" }, { type: "outcome", outcome: "defeat_wipe" }]);
  reason(attackNeuralBattle(ended.battle, "a", "Assault"), "finished"); reason(finishNeuralBattle(ended.battle, "victory"), "finished");
  const dead = structuredClone(first); dead.match.boss.hp = 0;
  assert.deepEqual(ok(finishNeuralBattle(dead, "victory")).events, [{ type: "link_broken", linkId: "neural-link:0", reason: "source_dead" }, { type: "outcome", outcome: "victory" }]);
  const pending = prepare(battle());
  assert.deepEqual(ok(finishNeuralBattle(pending, "victory")).events, [{ type: "neural_void", actionId: "neural:1", targetId: "raider:a", reason: "finished" }, { type: "outcome", outcome: "victory" }]);
});

test("no eligible node degrades without consuming or changing ordinary combat", () => {
  const b = battle(); b.match.raiders = [];
  const initial = structuredClone(b); reason(prepareNeuralBattle(b), "no_eligible_node"); assert.deepEqual(b, initial);
  const far = battle(); far.match.raiders.forEach((r, i) => { r.pos = c(i, 0); });
  reason(prepareNeuralBattle(far), "no_eligible_node");
  const original = structuredClone(b.match); bossPrepare(original);
  const copied = structuredClone(initial.match); bossPrepare(copied);
  const plan = { revision: original.revision, items: original.mechs.map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
  assert.deepEqual(playTurn(original, plan), playTurn(copied, plan));
  const authoritative = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", monsterContent: { speciesId: "neural_weaver", contentVersion: 1 } });
  assert.throws(() => createNeuralBattle(authoritative), /neural_fixture_unavailable/);
  // A forged or partially stripped state must not bypass the fixture boundary.
  delete authoritative.monsterContent;
  assert.throws(() => createNeuralBattle(authoritative), /neural_fixture_unavailable/);
});

test("synthetic JSON snapshot continuation and command replay produce identical states and ordered events", () => {
  const start = battle(), p = prepare(start), saved = JSON.parse(JSON.stringify(p)) as NeuralBattle;
  function continuation(b: NeuralBattle) {
    const events = [];
    let r = ok(resolveNeuralBattle(b, projectNeuralBattle(b))); events.push(...r.events); b = r.battle;
    r = ok(attackNeuralBattle(b, "a", "Gunner")); events.push(...r.events); b = r.battle;
    b.match.raiders.find(x => x.id === "a")!.pos = c(0, 0);
    r = ok(reconcileNeuralBattle(b)); events.push(...r.events); b = r.battle;
    r = ok(advanceNeuralBattle(b)); events.push(...r.events); b = r.battle;
    r = ok(prepareNeuralBattle(b)); events.push(...r.events); b = r.battle;
    r = ok(resolveNeuralBattle(b, projectNeuralBattle(b))); events.push(...r.events); b = r.battle;
    return { b, events };
  }
  const run = continuation(p);
  assert.deepEqual(continuation(saved), run);
  assert.deepEqual(continuation(prepare(structuredClone(start))), run);
  assert.deepEqual(run.events.map(e => e.type), ["link_created", "synthetic_attack", "link_broken", "neural_declared", "link_created"]);
  assert.equal(run.b.links[0]!.id, "neural-link:1"); assert.equal(run.b.links[0]!.targetId, "raider:z");
});

test("fixture rejects incompatible match forms and tampered provisional parameters", () => {
  const b = battle(), withSummon = structuredClone(b.match);
  withSummon.raiders[0]!.summon = { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 3 };
  assert.throws(() => createNeuralBattle(withSummon), /neural_fixture_unavailable/);
  const p = prepare(b); if (p.pending?.intent.request.skillId !== "neural_link") throw new Error("bad intent");
  p.pending.intent.request.attackBonus = 10;
  reason(resolveNeuralBattle(p), "invalid_state");
});
