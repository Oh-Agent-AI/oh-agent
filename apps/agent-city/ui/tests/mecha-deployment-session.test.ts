import assert from "node:assert/strict";
import test from "node:test";
import { remoteArenaFromSite, remoteStateFromSite } from "../src/game/mecha/contracts/arena.ts";
import { MECHA_NET_PROTOCOL, parseSubmitDeployment, type SubmitDeploymentCommand, type SubmitPlanCommand } from "../src/game/mecha/contracts/match.ts";
import { MatchSession, pveRules } from "../src/game/mecha/session/MatchSession.ts";
import { createMatch, MECH_IDS, type MatchState } from "../src/game/mecha/rules.ts";
import { assaultTerrainBlocked } from "../src/game/mecha/board.ts";
import { RemoteMatchSynchronizer } from "../src/game/mecha/client/RemoteMatchSynchronizer.ts";
import { createPvpMatch, pvpRules } from "../src/game/mecha/rules/pvp.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";

const terrain = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const));
const heights = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0));
const site: CityMechaSite = {
  originX: 0, originZ: 0, yaw: 0, cellW: 8, cellD: 8, terrain, heights, buildings: [], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
};
function setup() {
  const arena = remoteArenaFromSite(site, { arenaId: "city-flat", sourceRevision: "flat-1" });
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", deployment: true });
  const session = new MatchSession({ matchId: "m1", mode: "pve", arena, state, rules: pveRules,
    players: [{ playerId: "owner", side: "A", role: "host" }] });
  const command: SubmitDeploymentCommand = { type: "deployment.submit", protocol: MECHA_NET_PROTOCOL, matchId: "m1", playerId: "owner", commandId: "d1", baseRevision: 0,
    plan: { revision: 0, placements: MECH_IDS.map((mechId, i) => ({ mechId, pos: { x: i * 3, y: 8 } })) } };
  return { session, state, command };
}
function snapshot(session: MatchSession<MatchState>) { const s = session.snapshot("owner"); assert.ok(s.ok); return s.value; }

test("projected authority preserves zone, exclusions and sampled safety without controller drafts or private fields", () => {
  const { state } = setup();
  state.assaultTerrainSafety = { unsafeCells: [{ x: 1, y: 8 }], unsafeEdges: [{ from: { x: 0, y: 8 }, to: { x: 1, y: 8 } }] };
  Object.assign(state.deployment!.zone[0]!, { privateField: "secret" });
  Object.assign(state.assaultTerrainSafety.unsafeEdges[0]!.from, { privateField: "secret" });
  Object.assign(state, { draftPlacements: [{ secret: "secret" }] });
  const projected = remoteStateFromSite(site, state);
  assert.deepEqual(projected.deployment!.zone[0], { x: 0, y: 8 });
  assert.deepEqual(projected.assaultTerrainSafety, { unsafeCells: [{ x: 1, y: 8 }], unsafeEdges: [{ from: { x: 0, y: 8 }, to: { x: 1, y: 8 } }] });
  assert.equal(JSON.stringify(projected).includes("secret"), false);
  state.phase = "player_plan";
  const running = remoteStateFromSite(site, state);
  assert.equal(running.deployment, undefined);
  assert.deepEqual(running.assaultTerrainSafety, projected.assaultTerrainSafety);
  assert.equal(assaultTerrainBlocked(running, { x: 0, y: 8 }, { x: 1, y: 8 }), true);
  assert.equal(assaultTerrainBlocked(running, { x: 1, y: 8 }, { x: 0, y: 8 }), true);
  assert.equal(assaultTerrainBlocked(running, { x: 2, y: 8 }, { x: 3, y: 8 }), false);
});

test("authority rejects stale, foreign and illegal deployment commands without changing the snapshot", () => {
  const { session, command } = setup(), before = snapshot(session);
  assert.equal(session.submitDeployment("guest", command).error!.code, "forbidden");
  assert.equal(session.submitDeployment("owner", { ...command, matchId: "other" }).error!.code, "forbidden");
  assert.equal(session.submitDeployment("owner", { ...command, baseRevision: 1, plan: { ...command.plan, revision: 1 } }).error!.code, "stale_revision");
  const incomplete = { ...command, plan: { ...command.plan, placements: command.plan.placements.slice(0, 2) } };
  assert.deepEqual(session.submitDeployment("owner", incomplete), { ok: false, error: { code: "invalid_deployment", fault: { code: "incomplete" } } });
  const duplicate = structuredClone(command); duplicate.plan.placements[1]!.pos = duplicate.plan.placements[0]!.pos;
  assert.equal(session.submitDeployment("owner", duplicate).error!.fault!.code, "duplicate_cell");
  assert.deepEqual(snapshot(session), before);
  assert.equal(before.state.phase, "deployment"); assert.equal(before.state.boss.intent, null);
});

test("accepted deployment publishes once and retries remain idempotent after a turn", () => {
  const { session, state, command } = setup(); const published: unknown[] = [];
  session.subscribe(event => published.push(event));
  const first = session.submitDeployment("owner", command);
  assert.ok(first.ok); assert.equal(first.value.revision, 1); assert.equal(first.value.state.phase, "player_plan");
  assert.deepEqual(first.value.state.mechs.map(m => m.pos), command.plan.placements.map(p => p.pos));
  const expected = pveRules.deploy!(state, command.plan); assert.ok(expected.ok); assert.deepEqual(first.value.state, expected.state);
  assert.equal(published.length, 1); assert.equal((published[0] as { type: string }).type, "match.replaced");
  assert.deepEqual(session.submitDeployment("owner", structuredClone(command)), first);
  assert.equal(published.length, 1);
  const changed = structuredClone(command); changed.plan.placements[0]!.pos.x = 1;
  assert.equal(session.submitDeployment("owner", changed).error!.code, "duplicate_command");
  const cross: SubmitPlanCommand = { type: "plan.submit", protocol: MECHA_NET_PROTOCOL, matchId: "m1", playerId: "owner", commandId: "d1", baseRevision: 1, plan: { revision: 1, items: [] } };
  assert.equal(session.submitPlan("owner", cross).error!.code, "duplicate_command");
  const turn = { ...cross, commandId: "turn1", plan: { revision: 1, items: MECH_IDS.map(mechId => ({ mechId, moveTo: null, action: { kind: "skip" as const } })) } };
  assert.ok(session.submitPlan("owner", turn).ok);
  const afterTurn = snapshot(session);
  assert.ok(afterTurn.revision > first.value.revision);
  assert.deepEqual(session.submitDeployment("owner", command), first);
  assert.deepEqual(snapshot(session), afterTurn);
});

test("deployment parser rejects unknown nested fields, oversized arrays and invalid coordinates", () => {
  const { command } = setup(); assert.equal(parseSubmitDeployment(command).ok, true);
  for (const mutate of [
    (v: any) => { v.secret = "private"; }, (v: any) => { v.plan.secret = "private"; },
    (v: any) => { v.plan.placements[0].secret = "private"; }, (v: any) => { v.plan.placements[0].pos.secret = "private"; },
    (v: any) => { v.plan.placements[0].pos.x = 1.5; }, (v: any) => { v.plan.placements[0].pos.y = 10; },
    (v: any) => { v.plan.placements.push(v.plan.placements[0]); }, (v: any) => { v.plan.revision = 1; },
  ]) {
    const invalid = structuredClone(command); mutate(invalid);
    assert.equal(parseSubmitDeployment(invalid).ok, false);
  }
});

test("deployment is unavailable to PvP and closed matches", () => {
  const { session, command } = setup(); session.close("owner");
  assert.equal(session.submitDeployment("owner", command).error!.code, "room_closed");
  const { command: pvpCommand } = setup();
  const arena = remoteArenaFromSite(site, { arenaId: "city-flat", sourceRevision: "flat-1" });
  const pvp = new MatchSession({ matchId: "m1", mode: "pvp", arena: { ...arena, ruleset: pvpRules.ruleset }, state: createPvpMatch(arena), rules: pvpRules,
    players: [{ playerId: "owner", side: "A", role: "host" }] });
  const before = pvp.snapshot("owner");
  assert.equal(pvp.submitDeployment("owner", pvpCommand).error!.code, "unavailable");
  assert.deepEqual(pvp.snapshot("owner"), before);
});


test("deployment rejects adapter failures or incorrect revision without leaking mutations into authority", () => {
  const { state, command } = setup();
  const arena = remoteArenaFromSite(site, { arenaId: "city-flat", sourceRevision: "flat-1" });
  for (const succeed of [false, true]) {
    const rules = { ...pveRules, deploy: (candidate: MatchState) => {
      candidate.mechs[0]!.hp = -999;
      if (succeed) return { ok: true as const, state: candidate, log: [] };
      return { ok: false as const, fault: { code: "phase" as const } };
    } };
    const session = new MatchSession({ matchId: "m1", mode: "pve", arena, state, rules,
      players: [{ playerId: "owner", side: "A", role: "host" }] });
    const before = snapshot(session), result = session.submitDeployment("owner", command);
    assert.equal(result.ok, false);
    assert.equal(result.error!.code, succeed ? "unavailable" : "invalid_deployment");
    assert.deepEqual(snapshot(session), before);
  }
});

test("deployment authority restores through synchronizer snapshots when the broadcast is missed", async () => {
  const { session, command } = setup();
  const seen: MatchState[] = [];
  const sync = new RemoteMatchSynchronizer("m1", async () => session.snapshot("owner"), {
    snapshot: next => { if (next.state.ruleset === "mecha-v1.4") seen.push(next.state); },
    turn: () => {}, syncing: () => {}, error: message => { throw Error(message); },
  });
  sync.connection(true); await sync.resync();
  assert.equal(seen.at(-1)!.phase, "deployment");
  assert.deepEqual(seen.at(-1)!.deployment, snapshot(session).state.deployment);
  sync.connection(false);
  const result = session.submitDeployment("owner", command); assert.ok(result.ok);
  // Simulate a lost event: recover only from the authoritative session snapshot.
  sync.connection(true); await sync.resync();
  assert.equal(seen.at(-1)!.phase, "player_plan");
  assert.equal(seen.at(-1)!.revision, result.value.revision);
  assert.deepEqual(seen.at(-1)!.mechs.map(m => m.pos), command.plan.placements.map(p => p.pos));
  assert.equal(sync.canInteract(), true); sync.dispose();
});
