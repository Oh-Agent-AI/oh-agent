// Regenerate with node --experimental-strip-types --import scripts/mecha-ts-register.mjs
// apps/desktop/src-tauri/tests/remote_gateway_projection_fixture.mjs > ...fixture.json
import { remoteArenaFromSite, remoteStateFromSite } from '../../../agent-city/ui/src/game/mecha/contracts/arena.ts';
import { matchFromSite } from '../../../agent-city/ui/src/game/mecha/matchFromSite.ts';
import { bossPrepare } from '../../../agent-city/ui/src/game/mecha/rules.ts';
import { MatchSession, pveRules } from '../../../agent-city/ui/src/game/mecha/session/MatchSession.ts';
import { createPvpMatch, pvpRules } from '../../../agent-city/ui/src/game/mecha/rules/pvp.ts';

const site = {
  originX: 10, originZ: 20, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array(10).fill('land')),
  heights: Array.from({ length: 10 }, () => Array(10).fill(0)),
  buildings: [{ id: 'local-private-building', cells: [{ x: 4, y: 4 }], x: 42, z: 52, yaw: 0, ground: 0, height: 12 }],
  blocked: [{ x: 3, y: 4 }],
  mechs: [{ id: 'Assault', pos: { x: 2, y: 9 } }, { id: 'Gunner', pos: { x: 5, y: 9 } }, { id: 'Support', pos: { x: 8, y: 9 } }],
  boss: { x: 4, y: 0 }, raiders: [{ id: 'local-raider', pos: { x: 1, y: 3 } }], spawnSpread: 0,
};
const arena = remoteArenaFromSite(site, { arenaId: 'city-flat', sourceRevision: 'flat-0' });
const localState = matchFromSite(site, { preset: 'covers_sparse_mid', script: 'siege' });
bossPrepare(localState);
const state = remoteStateFromSite(site, localState);
const owner = { playerId: 'owner', side: 'A', role: 'host' };
const guest = { playerId: 'guest', side: 'B', role: 'guest' };
const pve = new MatchSession({ matchId: 'm1', mode: 'pve', arena, state, players: [owner], rules: pveRules });
const pvp = new MatchSession({ matchId: 'm1', mode: 'pvp', arena: { ...arena, ruleset: pvpRules.ruleset }, state: createPvpMatch(arena), players: [owner, guest], rules: pvpRules });
const message = (result) => ({ protocol: 'mecha-net:v1', type: 'response', requestId: 'r1', result });
const events = [];
const commands = [];
for (const session of [pve, pvp]) {
  session.subscribe((event) => events.push({ protocol: 'mecha-net:v1', type: 'event', event }));
  events.push(message(session.snapshot('owner')));
  const current = session.snapshot('owner').value;
  const mechs = current.mode === 'pve' ? current.state.mechs : current.state.units.filter((unit) => unit.side === 'A');
  const plan = { revision: current.revision, items: mechs.map((mech) => ({ mechId: mech.kind ?? mech.id, moveTo: null, action: { kind: 'skip' } })) };
  const command = { protocol: 'mecha-net:v1', type: 'plan.submit', matchId: 'm1', playerId: 'owner', commandId: 'cmd1', baseRevision: current.revision, plan };
  commands.push(command);
  const turn = session.submitPlan('owner', command);
  if (!turn.ok) throw new Error(JSON.stringify(turn));
  events.push(message(turn));
  events.push(message(session.snapshot('owner')));
}
const guestBefore = pvp.snapshot('guest').value;
const guestCommand = { protocol: 'mecha-net:v1', type: 'plan.submit', matchId: 'm1', playerId: 'guest', commandId: 'guest1', baseRevision: guestBefore.revision,
  plan: { revision: guestBefore.revision, items: guestBefore.state.units.filter((unit) => unit.side === 'B').map((unit) => ({
    mechId: unit.kind, moveTo: unit.kind === 'Assault' ? { x: 2, y: 1 } : null, action: { kind: 'skip' },
  })) } };
commands.push(guestCommand);
const guestTurn = pvp.submitPlan('guest', guestCommand);
if (!guestTurn.ok) throw new Error(JSON.stringify(guestTurn));
events.push(message(guestTurn));
events.push({ protocol: 'mecha-net:v1', type: 'event', event: { type: 'match.replaced', snapshot: pvp.snapshot('owner').value } });
events.push(message(pvp.concede('guest')));
events.push(message(pvp.close('owner')));
events.push(message(pvp.snapshot('unknown')));
// Exercise a real PvP attack and its presentation/log shape as well as skips.
const attackState = createPvpMatch(arena);
attackState.units.find((unit) => unit.id === 'A:Assault').pos = { x: 2, y: 4 };
attackState.units.find((unit) => unit.id === 'B:Assault').pos = { x: 2, y: 3 };
const attackSession = new MatchSession({ matchId: 'm1', mode: 'pvp', arena: { ...arena, ruleset: pvpRules.ruleset }, state: attackState, players: [owner, guest], rules: pvpRules });
attackSession.subscribe((event) => events.push({ protocol: 'mecha-net:v1', type: 'event', event }));
const attackCommand = { protocol: 'mecha-net:v1', type: 'plan.submit', matchId: 'm1', playerId: 'owner', commandId: 'attack1', baseRevision: 0,
  plan: { revision: 0, items: [
    { mechId: 'Assault', moveTo: null, action: { kind: 'melee', target: 'B:Assault' } },
    { mechId: 'Gunner', moveTo: null, action: { kind: 'skip' } },
    { mechId: 'Support', moveTo: null, action: { kind: 'skip' } },
  ] } };
commands.push(attackCommand);
const attack = attackSession.submitPlan('owner', attackCommand);
if (!attack.ok) throw new Error(JSON.stringify(attack));
events.push(message(attack));
console.log(JSON.stringify({ arena, state, commands, messages: events }));
