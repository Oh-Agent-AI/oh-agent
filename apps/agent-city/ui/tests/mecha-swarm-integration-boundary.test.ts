import assert from "node:assert/strict";
import test from "node:test";
import { createMatch } from "../src/game/mecha/rules.ts";
import { presentationSnapshot, type PresentationStages } from "../src/game/mecha/board.ts";
import { buildPresentationChanges } from "../src/game/mecha/presentationChanges.ts";
import {
  advanceSwarmRound, prepareSwarmLink, reconcileSwarmLink, reprojectSwarmLink, resolveSwarmLink,
  type SplitRequest, type SwarmLinkState,
} from "../src/game/mecha/skillSwarmLink.ts";

const cell = (x: number, y: number) => ({ x, y });
function world(): SwarmLinkState {
  return { version: 1, width: 10, height: 10, round: 1, finished: false, blocked: [], links: [],
    nextSpawnId: 0, nextLinkId: 0, resolvedActions: [], units: [
      { id: "boss", side: "enemy", cell: cell(4, 4), width: 2, height: 2, hp: 10 },
      { id: "player", side: "player", cell: cell(9, 9), width: 1, height: 1, hp: 5 },
    ] };
}
function request(actionId: string): SplitRequest {
  return { skillId: "split_swarm", actionId, actorId: "boss", speciesId: "swarm_child",
    candidates: [cell(3, 4), cell(3, 5), cell(4, 6)], maxSpawn: 3, summonCap: 2, spawnRange: 2, hp: 2, lifetime: 2 };
}
function planned(state: SwarmLinkState, req: SplitRequest) {
  const result = prepareSwarmLink(state, req);
  assert.equal(result.status, "planned");
  if (result.status !== "planned") throw new Error("expected planned intent");
  return result.intent;
}
function committed(state: SwarmLinkState, intent: ReturnType<typeof planned>) {
  const result = resolveSwarmLink(state, intent, reprojectSwarmLink(state, intent));
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") throw new Error("expected resolution");
  return result;
}

// These tests exercise the isolated primitive, not the local battle's previewPlan/playTurn.
test("pure split reprojects bound births after occupancy changes and resolves the same projection deterministically", () => {
  const initial = world(), req = request("round-1"), original = structuredClone(initial);
  const intent = planned(initial, req), oldPreview = reprojectSwarmLink(initial, intent);
  const changed = structuredClone(initial);
  changed.units[1]!.cell = cell(3, 4);
  const projection = reprojectSwarmLink(changed, intent);
  assert.equal(projection.status, "reprojected");
  if (projection.status !== "reprojected" || projection.skillId !== "split_swarm") throw new Error("expected split");
  assert.deepEqual(projection.slots.map(s => s.reason), ["occupied", null, null]);
  assert.equal(resolveSwarmLink(changed, intent, oldPreview).status, "void");
  const actual = resolveSwarmLink(changed, intent, projection);
  assert.equal(actual.status, "resolved");
  if (actual.status !== "resolved") throw new Error("expected resolution");
  assert.deepEqual(actual.events.filter(e => e.type === "summon_spawned").map(e => e.unit),
    projection.slots.flatMap(s => s.unit ? [s.unit] : []));
  assert.deepEqual(resolveSwarmLink(structuredClone(changed), structuredClone(intent), structuredClone(projection)), actual);
  assert.deepEqual(initial, original);
  const dead = structuredClone(changed); dead.units[0]!.hp = 0;
  assert.deepEqual(reprojectSwarmLink(dead, intent), { status: "void", reason: "actor_dead" });
});

test("pure split enforces the live cap after reconciliation and expires at the round boundary", () => {
  const first = committed(world(), planned(world(), request("round-1")));
  assert.deepEqual(first.events.map(e => e.type === "summon_skipped" ? e.reason : e.type),
    ["summon_spawned", "summon_spawned", "summon_cap"]);
  const one = advanceSwarmRound(first.state);
  assert.equal(one.status, "resolved");
  if (one.status !== "resolved") throw new Error("expected advance");
  assert.equal(one.state.units.filter(u => u.summon).length, 2);
  one.state.units.find(u => u.id === "swarm:0")!.hp = 0;
  assert.deepEqual(prepareSwarmLink(one.state, request("round-2")), { status: "void", reason: "reconciliation_required" });
  const cleaned = reconcileSwarmLink(one.state);
  assert.equal(cleaned.status, "resolved");
  if (cleaned.status !== "resolved") throw new Error("expected reconciliation");
  assert.deepEqual(cleaned.events, [{ type: "summon_removed", unitId: "swarm:0", reason: "death" }]);
  const second = committed(cleaned.state, planned(cleaned.state, request("round-2")));
  assert.equal(second.state.units.find(u => u.id === "swarm:2")?.summon?.expiresAtRound, 4);
  const two = advanceSwarmRound(second.state);
  assert.equal(two.status, "resolved");
  if (two.status !== "resolved") throw new Error("expected advance");
  assert.deepEqual(two.events, [{ type: "summon_removed", unitId: "swarm:1", reason: "expired" }]);
  assert.equal(two.state.units.find(u => u.id === "swarm:2")?.hp, 2);
  const three = advanceSwarmRound(two.state);
  assert.equal(three.status, "resolved");
  if (three.status !== "resolved") throw new Error("expected advance");
  assert.deepEqual(three.events, [{ type: "summon_removed", unitId: "swarm:2", reason: "expired" }]);
});

test("pure per-cell legality does not protect a connected host corridor", () => {
  const s = world(); s.width = 5; s.height = 3;
  s.blocked = Array.from({ length: 5 }, (_, x) => [cell(x, 0), cell(x, 2)]).flat();
  s.units = [
    { id: "boss", side: "enemy", cell: cell(0, 1), width: 1, height: 1, hp: 10 },
    { id: "player", side: "player", cell: cell(4, 1), width: 1, height: 1, hp: 5 },
  ];
  const intent = planned(s, { ...request("corridor"), candidates: [cell(2, 1)], maxSpawn: 1 });
  const result = committed(s, intent);
  assert.equal(result.events[0]?.type, "summon_spawned");
  // Every route in this one-cell corridor crosses the generated unit. The host
  // must enforce its own connectivity policy; the primitive cannot do so.
  assert.ok(result.state.units.some(u => u.summon && u.cell.x === 2 && u.cell.y === 1));
});

test("presentation validation rejects unexplained births and removals", () => {
  const snapshot = presentationSnapshot(createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", raiders: [] }));
  const born = structuredClone(snapshot);
  born.raiders.push({ id: "swarm:0", pos: cell(3, 4), hp: 2 });
  const stages = (start: typeof snapshot, end: typeof snapshot): PresentationStages => ({
    before: structuredClone(start), afterMovement: structuredClone(start), afterPlayer: structuredClone(start),
    afterEnemy: structuredClone(end), afterPrepare: structuredClone(end),
  });
  assert.deepEqual(buildPresentationChanges(stages(snapshot, born), []),
    { ok: false, reason: "changes do not reconcile with post-enemy snapshot" });
  assert.deepEqual(buildPresentationChanges(stages(born, snapshot), []),
    { ok: false, reason: "changes do not reconcile with post-enemy snapshot" });
});
