import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SWARM_HARD_CAP, LINK_HARD_CAP, NEURAL_LINK_BREAK_CONDITIONS, advanceSwarmRound, linkedAttackBonus,
  prepareSwarmLink, reconcileSwarmLink, reprojectSwarmLink, resolveSwarmLink,
  type SwarmLinkState, type SplitRequest, type LinkRequest, type SwarmIntent,
} from "../apps/agent-city/ui/src/game/mecha/skillSwarmLink.ts";

const p = (x: number, y: number) => ({ x, y });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function state(): SwarmLinkState {
  return { version: 1, width: 10, height: 10, round: 1, finished: false, blocked: [],
    units: [
      { id: "boss", side: "enemy", cell: p(3, 3), width: 2, height: 2, hp: 10 },
      { id: "ally", side: "enemy", cell: p(6, 3), width: 1, height: 1, hp: 4 },
      { id: "player", side: "player", cell: p(8, 8), width: 1, height: 1, hp: 4 },
    ], links: [], nextSpawnId: 0, nextLinkId: 0, resolvedActions: [] };
}
function split(actionId = "split-1"): SplitRequest {
  return { skillId: "split_swarm", actionId, actorId: "boss", speciesId: "swarm_child", candidates: [p(2, 3), p(2, 4), p(2, 5)],
    maxSpawn: 2, summonCap: 3, spawnRange: 3, hp: 2, lifetime: 2 };
}
function link(actionId = "link-1"): LinkRequest {
  return { skillId: "neural_link", actionId, actorId: "boss", targetId: "ally", range: 2, attackBonus: 2, lifetime: 2 };
}
function prepared(s: SwarmLinkState, r: SplitRequest | LinkRequest): SwarmIntent {
  const result = prepareSwarmLink(s, r);
  assert.equal(result.status, "planned", JSON.stringify(result));
  if (result.status !== "planned") throw new Error("not planned");
  return result.intent;
}
function committed(s: SwarmLinkState, intent: SwarmIntent): Extract<ReturnType<typeof resolveSwarmLink>, {status: "resolved"}> {
  const result = resolveSwarmLink(s, intent);
  assert.equal(result.status, "resolved", JSON.stringify(result));
  if (result.status !== "resolved") throw new Error("not resolved");
  return result;
}
function reconciled(s: SwarmLinkState): Extract<ReturnType<typeof reconcileSwarmLink>, {status: "resolved"}> {
  const result = reconcileSwarmLink(s);
  assert.equal(result.status, "resolved", JSON.stringify(result));
  if (result.status !== "resolved") throw new Error("not reconciled");
  return result;
}
function advanced(s: SwarmLinkState): Extract<ReturnType<typeof advanceSwarmRound>, {status: "resolved"}> {
  const result = advanceSwarmRound(s);
  assert.equal(result.status, "resolved", JSON.stringify(result));
  if (result.status !== "resolved") throw new Error("not advanced");
  return result;
}

test("ordered fixed candidates produce real 1x1 units, slots, stable ids and events", () => {
  const s = state(), request = split(), original = clone(s), intent = prepared(s, request);
  request.candidates[0]!.x = 9; // intent owns its bindings
  const preview = reprojectSwarmLink(s, intent);
  assert.deepEqual(preview, { status: "reprojected", skillId: "split_swarm", slots: [
    { cell: p(2, 3), reason: null, unit: { id: "swarm:0", side: "enemy", cell: p(2, 3), width: 1, height: 1, hp: 2,
      summon: { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 3 } } },
    { cell: p(2, 4), reason: null, unit: { id: "swarm:1", side: "enemy", cell: p(2, 4), width: 1, height: 1, hp: 2,
      summon: { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 3 } } },
    { cell: p(2, 5), reason: "spawn_limit", unit: null },
  ] });
  const result = resolveSwarmLink(s, intent, clone(preview));
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.deepEqual(result.events.map(e => e.type), ["summon_spawned", "summon_spawned", "summon_skipped"]);
  assert.deepEqual(result.state.units.slice(-2).map(u => [u.id, u.side, u.cell, u.width, u.height, u.hp, u.summon]), [
    ["swarm:0", "enemy", p(2, 3), 1, 1, 2, { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 3 }],
    ["swarm:1", "enemy", p(2, 4), 1, 1, 2, { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 3 }],
  ]);
  assert.deepEqual(s, original);
  assert.deepEqual(resolveSwarmLink(result.state, intent).status, "void");
  assert.equal((resolveSwarmLink(result.state, intent) as any).reason, "already_resolved");
});

test("JSON round trip and replay produce identical states, ids, projections and events", () => {
  const s = state(), intent = prepared(s, split());
  assert.deepEqual(reprojectSwarmLink(clone(s), clone(intent)), reprojectSwarmLink(s, intent));
  const first = committed(s, intent), replay = committed(clone(s), clone(intent));
  assert.deepEqual(replay, first);
  const next = clone(first.state); next.units.find(u => u.id === "swarm:0")!.hp = 0;
  const cleared = reconciled(next);
  const request = { ...split("split-2"), candidates: [p(2, 3)], maxSpawn: 1 };
  const result = committed(clone(cleared.state), clone(prepared(cleared.state, request)));
  assert.equal(result.state.units.at(-1)!.id, "swarm:2");
  assert.equal(result.state.nextSpawnId, 3);
});

test("birth rechecks bounds, range, blocked/reserved cells, footprint occupancy and caps in order", () => {
  const s = state(); s.blocked = [p(2, 3)];
  const r = { ...split(), candidates: [p(-1, 2), p(0, 0), p(2, 3), p(4, 4), p(6, 3), p(2, 4), p(2, 5)], maxSpawn: 2, summonCap: 1 };
  const result = committed(s, prepared(s, r));
  assert.deepEqual(result.events.map(e => e.type === "summon_skipped" ? e.reason : e.type),
    ["out_of_bounds", "out_of_range", "blocked", "occupied", "occupied", "summon_spawned", "summon_cap"]);
  assert.equal(result.state.units.filter(u => u.summon).length, 1);
});

test("reprojection does not replace blocked cells, and stale preview cannot commit", () => {
  const s = state(), intent = prepared(s, split()), preview = reprojectSwarmLink(s, intent);
  s.units.push({ id: "interceptor", side: "player", cell: p(2, 3), width: 1, height: 1, hp: 1 });
  assert.equal((resolveSwarmLink(s, intent, preview) as any).reason, "stale_projection");
  const projection = reprojectSwarmLink(s, intent);
  assert.equal(projection.status, "reprojected");
  if (projection.status !== "reprojected" || projection.skillId !== "split_swarm") return;
  assert.deepEqual(projection.slots.map(x => x.reason), ["occupied", null, null]);
  const result = committed(s, intent);
  assert.deepEqual(result.state.units.filter(u => u.summon).map(u => u.cell), [p(2, 4), p(2, 5)]);
});

test("spawn safety: duplicate cells, invalid params, killed caster, collision and hard caps", () => {
  const s = state();
  assert.equal((prepareSwarmLink(s, { ...split(), candidates: [p(1, 1), p(1, 1)] }) as any).reason, "invalid_request");
  for (const r of [{ ...split(), lifetime: 0 }, { ...split(), summonCap: SWARM_HARD_CAP + 1 }, { ...split(), hp: NaN }, { ...split(), spawnRange: -1 }])
    assert.equal(prepareSwarmLink(s, r).status, "void");
  const intent = prepared(s, split()); s.units[0]!.hp = 0;
  assert.equal((resolveSwarmLink(s, intent) as any).reason, "actor_dead");
  const collision = state(); collision.units.push({ id: "swarm:0", side: "enemy", cell: p(9, 9), width: 1, height: 1, hp: 0 });
  const result = committed(collision, prepared(collision, split()));
  assert.ok(result.events.every(e => e.type === "summon_skipped" && e.reason === "id_collision"));
  assert.equal(result.state.nextSpawnId, 0);
});

test("hard live cap applies across all parents; freeing a slot preserves sequence", () => {
  const s = state();
  for (let i = 0; i < SWARM_HARD_CAP; i++) s.units.push({ id: `child-${i}`, side: "enemy", cell: p(i % 10, i < 10 ? 0 : 1), width: 1, height: 1, hp: 1,
    summon: { parentId: "other", speciesId: "swarm_child", expiresAtRound: 8 } });
  const r = { ...split(), candidates: [p(2, 3)], summonCap: SWARM_HARD_CAP };
  const full = committed(s, prepared(s, r));
  assert.deepEqual(full.events, [{ type: "summon_skipped", cell: p(2, 3), reason: "summon_cap" }]);
  s.units.find(u => u.id === "child-0")!.hp = 0;
  assert.equal((prepareSwarmLink(s, r) as any).reason, "reconciliation_required");
  const clean = reconciled(s);
  assert.deepEqual(clean.events, [{ type: "summon_removed", unitId: "child-0", reason: "death" }]);
  assert.equal(committed(clean.state, prepared(clean.state, r)).state.units.at(-1)!.id, "swarm:0");
});

test("lifetime has exact round boundaries, death event precedence, and no id reuse", () => {
  let s = committed(state(), prepared(state(), split())).state;
  s = advanced(s).state; assert.equal(s.round, 2); assert.equal(s.units.filter(u => u.summon).length, 2);
  s.units.find(u => u.id === "swarm:0")!.hp = 0;
  const expired = advanced(s);
  assert.deepEqual(expired.events, [
    { type: "summon_removed", unitId: "swarm:0", reason: "death" },
    { type: "summon_removed", unitId: "swarm:1", reason: "expired" },
  ]);
  assert.equal(expired.state.units.filter(u => u.summon).length, 0);
  assert.equal(advanced(expired.state).events.length, 0);
});

test("link binds a living ally and applies a concrete non-stacking attack bonus", () => {
  const s = state(), intent = prepared(s, link()), projection = reprojectSwarmLink(s, intent);
  assert.deepEqual(projection, { status: "reprojected", skillId: "neural_link", linkId: "neural-link:0", sourceId: "boss", targetId: "ally", range: 2, attackBonus: 2, expiresAtRound: 3,
    breakConditions: ["source_dead", "target_dead", "side_changed", "expired", "out_of_range"] });
  const result = committed(s, intent);
  assert.deepEqual(result.events, [{ type: "link_created", link: { id: "neural-link:0", sourceId: "boss", targetId: "ally", range: 2, attackBonus: 2, expiresAtRound: 3 } }]);
  assert.equal(linkedAttackBonus(result.state, "ally"), 2);
  assert.equal(linkedAttackBonus(result.state, "boss"), 0);
  assert.equal((prepareSwarmLink(result.state, link("other")) as any).reason, "target_already_linked");
  assert.equal((prepareSwarmLink(s, { ...link(), targetId: "player", range: 20 }) as any).reason, "not_allied");
  assert.equal((prepareSwarmLink(s, { ...link(), targetId: "boss" }) as any).reason, "invalid_request");
});

test("bound link target follows movement but never switches; break on distance, death or side", () => {
  for (const change of [
    { apply: (s: SwarmLinkState) => { s.units[1]!.cell = p(9, 3); }, reason: "out_of_range" },
    { apply: (s: SwarmLinkState) => { s.units[0]!.hp = 0; }, reason: "source_dead" },
    { apply: (s: SwarmLinkState) => { s.units[1]!.hp = 0; }, reason: "target_dead" },
    { apply: (s: SwarmLinkState) => { s.units[1]!.side = "player"; }, reason: "side_changed" },
    { apply: (s: SwarmLinkState) => { s.units = s.units.filter(u => u.id !== "ally"); }, reason: "target_dead" },
  ]) {
    const base = state(), result = committed(base, prepared(base, link())); change.apply(result.state);
    assert.equal(linkedAttackBonus(result.state, "ally"), 0, change.reason);
    const broken = reconciled(result.state);
    assert.deepEqual(broken.events, [{ type: "link_broken", linkId: "neural-link:0", reason: change.reason }]);
    assert.deepEqual(reconciled(broken.state).events, []);
  }
  const s = state(), intent = prepared(s, link()); s.units[1]!.cell = p(7, 3);
  assert.equal((reprojectSwarmLink(s, intent) as any).reason, "out_of_range");
  s.units[1]!.hp = 0;
  assert.equal((reprojectSwarmLink(s, intent) as any).reason, "target_dead");
});

test("link expiry and summon expiry break dependent links once, in event order", () => {
  let s = state();
  s = committed(s, prepared(s, { ...split(), candidates: [p(2, 3)], maxSpawn: 1, lifetime: 1 })).state;
  s = committed(s, prepared(s, { ...link(), actionId: "to-child", targetId: "swarm:0", lifetime: 3 })).state;
  const after = advanced(s);
  assert.deepEqual(after.events, [
    { type: "summon_removed", unitId: "swarm:0", reason: "expired" },
    { type: "link_broken", linkId: "neural-link:0", reason: "target_dead" },
  ]);
  let s2 = state(); s2 = committed(s2, prepared(s2, link())).state;
  s2 = advanced(s2).state; assert.equal(linkedAttackBonus(s2, "ally"), 2);
  const expiry = advanced(s2);
  assert.deepEqual(expiry.events, [{ type: "link_broken", linkId: "neural-link:0", reason: "expired" }]);
});

test("link cap and id collision fail explicitly without modifying state", () => {
  const s = state();
  for (let i = 0; i < LINK_HARD_CAP; i++) {
    const target = `target-${i}`;
    s.units.push({ id: target, side: "enemy", cell: p(i % 10, i < 10 ? 0 : 1), width: 1, height: 1, hp: 1 });
    s.links.push({ id: `other:${i}`, sourceId: "boss", targetId: target, range: 20, attackBonus: 1, expiresAtRound: 5 });
  }
  assert.equal((prepareSwarmLink(s, link()) as any).reason, "link_cap");
  s.links.pop(); s.links[0]!.id = "neural-link:0";
  assert.equal((prepareSwarmLink(s, link()) as any).reason, "id_collision");
});

test("terminal, stale round, malformed snapshots and id exhaustion fail closed", () => {
  const s = state(), intent = prepared(s, split()); s.finished = true;
  assert.equal((resolveSwarmLink(s, intent) as any).reason, "finished");
  assert.equal((advanceSwarmRound(s) as any).reason, "finished");
  assert.equal((reconcileSwarmLink(s) as any).reason, "finished");
  assert.equal(linkedAttackBonus(s, "ally"), 0);
  const moved = advanced(state()).state;
  assert.equal((resolveSwarmLink(moved, intent) as any).reason, "stale_round");
  const invalid = state(); invalid.units.push({ ...invalid.units[0]! });
  assert.equal((reprojectSwarmLink(invalid, intent) as any).reason, "invalid_state");
  const exhausted = state(); exhausted.nextSpawnId = 1000000000;
  const r = committed(exhausted, prepared(exhausted, split()));
  assert.ok(r.events.every(e => e.type === "summon_skipped" && e.reason === "id_exhausted"));
  exhausted.nextLinkId = 1000000000;
  assert.equal((prepareSwarmLink(exhausted, link()) as any).reason, "id_exhausted");
});

test("projection comparison accepts JSON key reorder but rejects forged effects", () => {
  const s = state(), intent = prepared(s, link()), projection = reprojectSwarmLink(s, intent);
  assert.equal(projection.status, "reprojected");
  const reordered = JSON.parse(JSON.stringify(projection, Object.keys(projection).reverse()));
  assert.equal(resolveSwarmLink(s, intent, reordered).status, "resolved");
  reordered.attackBonus = 10;
  assert.equal((resolveSwarmLink(s, intent, reordered) as any).reason, "stale_projection");
});


test("stale preview protects generated spawn and link identity", () => {
  const s = state(), intent = prepared(s, split()), preview = reprojectSwarmLink(s, intent);
  s.nextSpawnId = 10;
  assert.equal((resolveSwarmLink(s, intent, preview) as any).reason, "stale_projection");
  const l = state(), li = prepared(l, link()), lp = reprojectSwarmLink(l, li);
  l.nextLinkId = 7;
  assert.equal((resolveSwarmLink(l, li, lp) as any).reason, "stale_projection");
});


test("new state, events and input are isolated from later host mutation", () => {
  const s = state(), original = clone(s), result = committed(s, prepared(s, split()));
  result.state.units[0]!.cell.x = 0;
  result.state.units.at(-1)!.summon!.speciesId = "changed";
  result.state.blocked.push(p(0, 0));
  assert.deepEqual(s, original);
  const spawn = result.events.find(e => e.type === "summon_spawned");
  assert.equal(spawn?.type === "summon_spawned" && spawn.unit.summon!.speciesId, "swarm_child");
  const cleaned = reconciled(s); cleaned.state.units[0]!.cell.x = 0;
  assert.deepEqual(s, original);
});

test("unit capacity cannot produce an invalid snapshot", () => {
  const s = state();
  for (let i = s.units.length; i < 1024; i++) s.units.push({ id: `dead-${i}`, side: "enemy", cell: p(0, 0), width: 1, height: 1, hp: 0 });
  const result = committed(s, prepared(s, split()));
  assert.ok(result.events.every(e => e.type === "summon_skipped" && e.reason === "unit_limit"));
  assert.equal(reconcileSwarmLink(result.state).status, "resolved");
});

test("link ids advance across break and serialized recovery, without resurrecting the old effect", () => {
  let s = state();
  s = committed(s, prepared(s, link())).state;
  s.units[1]!.cell = p(9, 3);
  s = clone(reconciled(s).state);
  s.units[1]!.cell = p(6, 3);
  const result = committed(s, clone(prepared(s, link("link-2"))));
  assert.equal(result.state.links[0]!.id, "neural-link:1");
  assert.equal(linkedAttackBonus(result.state, "ally"), 2);
  assert.deepEqual(committed(clone(s), prepared(clone(s), link("link-2"))), result);
});

test("malformed summon metadata fails closed, and expired nodes cannot confer bonuses", () => {
  const bad = state(); (bad.units[0] as any).summon = null;
  assert.equal((prepareSwarmLink(bad, split()) as any).reason, "invalid_state");
  let s = state();
  s = committed(s, prepared(s, { ...split(), candidates: [p(2, 3)], maxSpawn: 1, lifetime: 1 })).state;
  s = committed(s, prepared(s, { ...link(), actionId: "to-child", targetId: "swarm:0", lifetime: 3 })).state;
  // Even if a host forgets its boundary reconciliation, a stale snapshot has no effect.
  s.round++;
  assert.equal(linkedAttackBonus(s, "swarm:0"), 0);
  assert.equal((prepareSwarmLink(s, link("new")) as any).reason, "reconciliation_required");
});

test("sparse inputs fail closed before prepare, reprojection, resolution or reconciliation", () => {
  const s = state();
  const sparseCandidates = { ...split(), candidates: new Array(1) } as SplitRequest;
  assert.deepEqual(prepareSwarmLink(s, sparseCandidates), { status: "void", reason: "invalid_request" });
  const intent = prepared(s, split());
  (intent.request as SplitRequest).candidates = new Array(1);
  assert.deepEqual(reprojectSwarmLink(s, intent), { status: "void", reason: "invalid_intent" });
  assert.deepEqual(resolveSwarmLink(s, intent), { status: "void", reason: "invalid_intent", state: s, events: [] });

  for (const field of ["blocked", "resolvedActions", "units", "links"] as const) {
    const invalid = state();
    (invalid as any)[field] = new Array(1);
    const validIntent = prepared(s, link());
    assert.deepEqual(reprojectSwarmLink(invalid, validIntent), { status: "void", reason: "invalid_state" }, field);
    assert.deepEqual(reconcileSwarmLink(invalid), { status: "void", reason: "invalid_state", state: invalid, events: [] }, field);
    assert.equal(linkedAttackBonus(invalid, "ally"), 0, field);
  }
});

test("two rectangular footprints link at the closest Manhattan-cell boundary", () => {
  const s = state();
  s.units[1]!.cell = p(6, 5); s.units[1]!.width = 2; s.units[1]!.height = 2;
  assert.equal((prepareSwarmLink(s, { ...link(), range: 2 }) as any).reason, "out_of_range");
  const result = committed(s, prepared(s, { ...link(), range: 3 }));
  assert.equal(linkedAttackBonus(result.state, "ally"), 2);
  result.state.units[1]!.cell = p(7, 5);
  assert.equal(linkedAttackBonus(result.state, "ally"), 0);
  assert.deepEqual(reconciled(result.state).events, [{ type: "link_broken", linkId: "neural-link:0", reason: "out_of_range" }]);
});

test("removing an expired summoned source breaks its dependent links once, including after recovery", () => {
  let s = state();
  s = committed(s, prepared(s, { ...split(), candidates: [p(2, 3)], maxSpawn: 1, lifetime: 1 })).state;
  s = committed(s, prepared(s, { ...link(), actionId: "child-link", actorId: "swarm:0", targetId: "boss", lifetime: 4 })).state;
  assert.equal(linkedAttackBonus(s, "boss"), 2);
  const result = advanced(clone(s));
  assert.deepEqual(result.events, [
    { type: "summon_removed", unitId: "swarm:0", reason: "expired" },
    { type: "link_broken", linkId: "neural-link:0", reason: "source_dead" },
  ]);
  assert.equal(linkedAttackBonus(result.state, "boss"), 0);
  assert.deepEqual(reconciled(clone(result.state)).events, []);
  assert.deepEqual(advanced(clone(s)), result);
});

test("link chains stay flat and never recursively multiply or stack the attack bonus", () => {
  let s = state();
  s.units.push({ id: "second-ally", side: "enemy", cell: p(7, 3), width: 1, height: 1, hp: 2 });
  s = committed(s, prepared(s, link())).state;
  s = committed(s, prepared(s, { ...link("chain"), actorId: "ally", targetId: "second-ally", attackBonus: 3 })).state;
  s = committed(s, prepared(s, { ...link("cycle"), actorId: "second-ally", targetId: "boss", range: 3, attackBonus: 4 })).state;
  assert.equal(linkedAttackBonus(s, "ally"), 2);
  assert.equal(linkedAttackBonus(s, "second-ally"), 3);
  assert.equal(linkedAttackBonus(s, "boss"), 4);
  s.units.find(u => u.id === "ally")!.hp = 0;
  assert.deepEqual(reconciled(s).events, [
    { type: "link_broken", linkId: "neural-link:0", reason: "target_dead" },
    { type: "link_broken", linkId: "neural-link:1", reason: "source_dead" },
  ]);
  assert.equal(linkedAttackBonus(s, "boss"), 4);
});

test("round and action-history safety limits reject atomically", () => {
  const s = state(); s.round = 1000000;
  const before = clone(s);
  assert.deepEqual(advanceSwarmRound(s), { status: "void", reason: "round_limit", state: s, events: [] });
  assert.deepEqual(s, before);
  s.resolvedActions = Array.from({ length: 256 }, (_, i) => `old-${i}`);
  assert.deepEqual(prepareSwarmLink(s, split()), { status: "void", reason: "action_limit" });
  assert.equal((prepareSwarmLink(s, split("old-0")) as any).reason, "already_resolved");
});

test("link preview explicitly declares fixed break conditions and protects them from mutation", () => {
  const s = state(), intent = prepared(s, link()), preview = reprojectSwarmLink(s, intent);
  assert.equal(preview.status, "reprojected");
  if (preview.status !== "reprojected" || preview.skillId !== "neural_link") throw new Error("not a link preview");
  assert.deepEqual(preview.breakConditions, NEURAL_LINK_BREAK_CONDITIONS);
  assert.deepEqual(reprojectSwarmLink(clone(s), clone(intent)), preview);
  preview.breakConditions.pop();
  assert.equal((resolveSwarmLink(s, intent, preview) as any).reason, "stale_projection");
  const fresh = reprojectSwarmLink(s, intent);
  assert.equal(fresh.status, "reprojected");
  if (fresh.status !== "reprojected" || fresh.skillId !== "neural_link") throw new Error("not a link preview");
  assert.deepEqual(fresh.breakConditions, NEURAL_LINK_BREAK_CONDITIONS);
  assert.equal(resolveSwarmLink(s, intent, fresh).status, "resolved");
});

test("simultaneous link break conditions have stable declared precedence", () => {
  const original = state(), withLink = committed(original, prepared(original, link())).state;
  const cases: Array<{ changes: (s: SwarmLinkState) => void; reason: string }> = [
    { changes: s => { s.units[0]!.hp = 0; s.units[1]!.hp = 0; }, reason: "source_dead" },
    { changes: s => { s.units[1]!.hp = 0; s.units[1]!.side = "player"; }, reason: "target_dead" },
    { changes: s => { s.units[1]!.side = "player"; s.round = 3; s.units[1]!.cell = p(9, 3); }, reason: "side_changed" },
    { changes: s => { s.round = 3; s.units[1]!.cell = p(9, 3); }, reason: "expired" },
  ];
  for (const { changes, reason } of cases) {
    const s = clone(withLink); changes(s);
    assert.equal(linkedAttackBonus(s, "ally"), 0);
    assert.deepEqual(reconciled(s).events, [{ type: "link_broken", linkId: "neural-link:0", reason }]);
  }
});
