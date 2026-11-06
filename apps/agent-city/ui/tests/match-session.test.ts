import assert from "node:assert/strict";
import test from "node:test";
import { remoteArenaFromSite, remoteStateFromSite, pveMatchFromArena } from "../src/game/mecha/contracts/arena.ts";
import { MECHA_NET_PROTOCOL, parseSubmitPlan, type SubmitPlanCommand } from "../src/game/mecha/contracts/match.ts";
import { LocalMatchClient } from "../src/game/mecha/client/LocalMatchClient.ts";
import { MatchSession } from "../src/game/mecha/session/MatchSession.ts";
import { pveRules } from "../src/game/mecha/session/MatchSession.ts";
import { living } from "../src/game/mecha/rules.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";

const terrain = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const));
const heights = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0));
const site: CityMechaSite = {
  originX: 10, originZ: 20, yaw: 0, cellW: 8, cellD: 8, terrain, heights,
  buildings: [{ id: "ca_private_source", cells: [{ x: 4, y: 4 }], x: 42, z: 52, yaw: 0, ground: 0, height: 12 }],
  blocked: [], mechs: [{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 5, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }],
  boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
};

function setup() {
  const arena = remoteArenaFromSite(site, { arenaId: "arena-1", sourceRevision: "city-fingerprint-1" });
  const state = pveMatchFromArena(arena, { script: "stationary_smash" });
  const session = new MatchSession({
    matchId: "match-1", mode: "pve", state, arena, rules: pveRules,
    players: [{ playerId: "owner", side: "A", role: "host" }],
  });
  return { arena, state, session };
}

function command(session: MatchSession, commandId = "command-1"): SubmitPlanCommand {
  const snapshot = session.snapshot("owner");
  assert.ok(snapshot.ok);
  return {
    type: "plan.submit", protocol: MECHA_NET_PROTOCOL, matchId: "match-1", playerId: "owner", commandId,
    baseRevision: snapshot.value.revision,
    plan: { revision: snapshot.value.revision, items: living(snapshot.value.state).map((mech) => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" as const } })) },
  };
}

test("arena projection contains only game fields and uses match-scoped entity ids", () => {
  const { arena, state } = setup();
  assert.equal(arena.schema, "mecha-arena:v1");
  assert.equal(arena.buildings[0]!.id, "building-0000");
  assert.equal(state.buildings[0]!.id, "building-0000");
  assert.equal(JSON.stringify(arena).includes("ca_private_source"), false);
  assert.equal(JSON.stringify(arena).includes("title"), false);
  assert.deepEqual(state.mechs.map((mech) => ({ id: mech.id, pos: mech.pos })), site.mechs);
});

test("current local state uses the same anonymous building ids", () => {
  const { arena, state } = setup();
  const local = structuredClone(state);
  local.buildings[0]!.id = site.buildings[0]!.id;
  Object.assign(local, { privateField: "private_marker" });
  Object.assign(local.buildings[0]!, { privateField: "private_marker" });
  Object.assign(local.mechs[0]!.pos, { privateField: "private_marker" });
  const projected = remoteStateFromSite(site, local);
  assert.equal(projected.buildings[0]!.id, arena.buildings[0]!.id);
  assert.equal(JSON.stringify(projected).includes("ca_private_source"), false);
  assert.equal(JSON.stringify(projected).includes("private_marker"), false);
  assert.equal(local.buildings[0]!.id, "ca_private_source");
  assert.deepEqual({ ...projected.buildings[0], id: local.buildings[0]!.id }, { id: local.buildings[0]!.id, cells: local.buildings[0]!.cells, hp: local.buildings[0]!.hp, maxHp: local.buildings[0]!.maxHp });
});

test("accepted turn publishes a complete snapshot and animation stages", () => {
  const { session } = setup();
  let published = 0;
  session.subscribe((event) => { if (event.type === "turn.resolved") published += 1; });
  const before = session.snapshot("owner");
  const result = session.submitPlan("owner", command(session));
  assert.ok(result.ok);
  assert.ok(result.value.revision > before.value!.revision);
  assert.ok(result.value.presentationStages);
  assert.equal(result.value.state.revision, result.value.revision);
  assert.equal(published, 1);
});

test("command retry returns the first result without advancing twice", () => {
  const { session } = setup();
  const input = command(session);
  const first = session.submitPlan("owner", input);
  const revision = first.ok ? first.value.revision : -1;
  const retry = session.submitPlan("owner", structuredClone(input));
  assert.deepEqual(retry, first);
  assert.equal(session.snapshot("owner").value!.revision, revision);
  const changed = { ...input, plan: { ...input.plan, items: input.plan.items.slice(1) } };
  assert.deepEqual(session.submitPlan("owner", changed), { ok: false, error: { code: "duplicate_command" } });
});

test("stale, foreign and out-of-turn commands cannot mutate state", () => {
  const { session } = setup();
  const input = command(session);
  assert.deepEqual(session.submitPlan("intruder", input), { ok: false, error: { code: "forbidden" } });
  assert.deepEqual(session.submitPlan("owner", { ...input, baseRevision: 99 }), { ok: false, error: { code: "stale_revision" } });
  const before = session.snapshot("owner").value!;
  const rejected = session.submitPlan("owner", { ...input, plan: { ...input.plan, items: [] } });
  assert.equal(rejected.ok, false);
  assert.deepEqual(session.snapshot("owner").value!, before);
});

test("snapshot is a resync copy and close is host-only and idempotent", () => {
  const { session } = setup();
  const first = session.snapshot("owner");
  assert.ok(first.ok);
  first.value.state.turn = 999;
  assert.notEqual(session.snapshot("owner").value!.state.turn, 999);
  const closed = session.close("owner");
  assert.ok(closed.ok);
  assert.equal(closed.value.status, "closed");
  assert.equal(session.close("owner").value!.status, "closed");
  assert.deepEqual(session.submitPlan("owner", command(session)), { ok: false, error: { code: "room_closed" } });
});

test("network parser rejects malformed plans and incompatible protocol", () => {
  const { session } = setup();
  const input = command(session);
  assert.equal(parseSubmitPlan(input).ok, true);
  assert.deepEqual(parseSubmitPlan({ ...input, protocol: "mecha-net:v0" }), { ok: false, error: { code: "ruleset_mismatch" } });
  assert.deepEqual(parseSubmitPlan({ ...input, plan: { ...input.plan, items: [{ mechId: "Assault", moveTo: { x: -1, y: 2 }, action: { kind: "skip" } }] } }), { ok: false, error: { code: "invalid_message" } });
  assert.deepEqual(parseSubmitPlan({ ...input, plan: { ...input.plan, items: [{ mechId: "Assault", moveTo: null, action: { kind: "shoot", target: 42 } }] } }), { ok: false, error: { code: "invalid_message" } });
});

test("local client exposes the same asynchronous boundary as a remote client", async () => {
  const { session } = setup();
  const client = new LocalMatchClient(session, "owner");
  assert.equal((await client.snapshot("missing")).ok, false);
  const result = await client.submitPlan(command(session));
  assert.equal(result.ok, true);
  assert.equal((await client.snapshot("match-1")).value!.revision, result.value!.revision);
  assert.equal((await client.close("match-1")).value!.status, "closed");
});
