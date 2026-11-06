// Synthetic, deterministic output from the actual TypeScript session and projection.
import { remoteArenaFromSite, remoteStateFromSite } from "../src/game/mecha/contracts/arena.ts";
import { MECHA_NET_PROTOCOL, type MatchEvent, type SubmitDeploymentCommand } from "../src/game/mecha/contracts/match.ts";
import { createMatch, MECH_IDS, type MatchState } from "../src/game/mecha/rules.ts";
import { MatchSession, pveRules } from "../src/game/mecha/session/MatchSession.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";

export function deploymentGatewayFixture() {
  const site: CityMechaSite = {
    originX: 0, originZ: 0, yaw: 0, cellW: 8, cellD: 8,
    terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
    heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)), buildings: [], blocked: [],
    mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
    boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
  };
  const arena = remoteArenaFromSite(site, { arenaId: "city-flat", sourceRevision: "flat-1" });
  const state = remoteStateFromSite(site, createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", deployment: true }));
  const options = { matchId: "m1", mode: "pve" as const, arena, state, rules: pveRules,
    players: [{ playerId: "owner", side: "A" as const, role: "host" as const }] };
  const session = new MatchSession(options);
  const command: SubmitDeploymentCommand = { type: "deployment.submit", protocol: MECHA_NET_PROTOCOL, matchId: "m1", playerId: "owner", commandId: "d1", baseRevision: 0,
    plan: { revision: 0, placements: MECH_IDS.map((mechId, i) => ({ mechId, pos: { x: i * 3, y: 8 } })) } };
  const events: MatchEvent<MatchState>[] = [];
  session.subscribe(event => events.push(event));
  const before = session.snapshot("owner");
  const invalid = session.submitDeployment("owner", { ...command, plan: { ...command.plan, placements: command.plan.placements.slice(0, 2) } });
  const deployed = session.submitDeployment("owner", command);
  if (!before.ok || invalid.ok || !deployed.ok || events.length !== 1) throw new Error("invalid synthetic deployment fixture");
  const closed = new MatchSession(options).close("owner");
  if (!closed.ok) throw new Error("invalid synthetic close fixture");
  const response = (requestId: string, result: unknown) => ({ protocol: MECHA_NET_PROTOCOL, type: "response", requestId, result });
  return { arena, state, command, messages: [response("before", before), response("invalid", invalid), response("deployed", deployed),
    { protocol: MECHA_NET_PROTOCOL, type: "event", event: events[0] }, response("closed", closed)] };
}
