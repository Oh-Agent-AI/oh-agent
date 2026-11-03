#!/usr/bin/env node
// Local-only integration: real Wrangler relay + RemoteMatchClient + RemoteSessionHost.
// The small bridge below stands in for the Tauri/Rust gateway; it is NOT a security test of it.
// Start the relay with a temporary persistence directory, then run:
// node --experimental-strip-types --import ./scripts/mecha-ts-register.mjs scripts/verify-mecha-local-relay.mjs http://127.0.0.1:52972
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { RemoteMatchClient } from '../apps/agent-city/ui/src/game/mecha/client/RemoteMatchClient.ts';
import { RemoteMatchSynchronizer } from '../apps/agent-city/ui/src/game/mecha/client/RemoteMatchSynchronizer.ts';
import { startRemoteSessionHost } from '../apps/agent-city/ui/src/remote/RemoteSessionHost.ts';
import { deploymentGatewayFixture } from '../apps/agent-city/ui/tests/remote-deployment-gateway-fixture.ts';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:52972');
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Only an explicitly local HTTP relay may be used.');
const secret = () => randomBytes(32).toString('hex');
const room = secret();
const matchId = 'm1';
const ownerToken = secret();
const sessionToken = secret();
const capability = { id: 'mecha:v3', methods: ['match.snapshot', 'deployment.submit', 'plan.submit', 'match.concede-v2', 'match.close'], events: ['match.replaced', 'turn.resolved', 'match.closed'] };
const scope = { protocol: 'app-remote:v1', appId: 'city', sessionId: matchId, capability: capability.id };
const endpoint = op => new URL(`/v1/rooms/${room}/${op}`, base).href;
const wsUrl = ticket => endpoint('ws').replace(/^http:/, 'ws:') + `?ticket=${encodeURIComponent(ticket)}`;
const post = async (op, body, token = ownerToken) => {
  const response = await fetch(endpoint(op), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.ok, true, `${op}: ${response.status} ${JSON.stringify(result)}`);
  return result;
};
const until = async (predicate, label, timeout = 12000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Timed out: ${label}`);
};
const readySocket = async url => {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket failed')); }, { once: true });
  });
  return socket;
};
let host;
let client;
let ownerSocket;
let synchronizer;
let registered = false;
try {
  await post('register', { protocol: scope.protocol, appId: scope.appId, sessionId: matchId, capability, ownerToken });
  registered = true;
  const hostTicket = await post('access', { action: 'pair', role: 'host' });
  const owner = await post('access', { action: 'pair', role: 'owner' });
  host = await readySocket(wsUrl(hostTicket.ticket));

  // Invoke the actual hidden-session host with a synthetic window/Tauri bridge.
  const replies = [];
  let dropDeploymentResponse = false;
  let dropConcedeResponse = false;
  const window = new EventTarget();
  window.__AV_MECHA_SESSION_TOKEN__ = sessionToken;
  window.__TAURI__ = { core: { invoke: async (_command, { reply }) => {
    replies.push(reply);
    if (reply.type !== 'message') return;
    const message = reply.message;
    if (dropDeploymentResponse && message.type === 'response' && message.result?.ok && message.result?.value?.revision === 1) {
      dropDeploymentResponse = false;
      ownerSocket.close(4001, 'synthetic_lost_reply');
      return; // Simulate a reply lost after authority committed the deployment.
    }
    if (dropConcedeResponse && message.type === 'response' && message.result?.ok && message.result?.value?.commandId === 'safe-concede') {
      dropConcedeResponse = false;
      return; // Simulate a successful command whose response was lost.
    }
    host.send(JSON.stringify({ ...message, ...scope }));
  } } };
  globalThis.window = window;
  startRemoteSessionHost();
  const fixture = deploymentGatewayFixture();
  const dispatch = request => window.dispatchEvent(new CustomEvent('__AV_MECHA_REMOTE_REQUEST__', { detail: { token: sessionToken, request } }));
  dispatch({ protocol: 'mecha-net:v1', type: 'request', requestId: 'create-session', method: 'match.create', payload: { config: {
    matchId, mode: 'pve', arena: fixture.arena, state: fixture.state,
    players: [{ playerId: 'owner', side: 'A', role: 'host' }],
  } } });
  await until(() => replies.some(reply => reply.type === 'created'), 'session created');
  let holdPlan = false;
  let heldPlan;
  let holdConcede = false;
  let heldConcede;
  const handleHostMessage = event => {
    const message = JSON.parse(event.data);
    if (message.type !== 'request') return;
    assert.deepEqual(message.peer, { role: 'owner', playerId: 'owner' });
    if (holdPlan && message.method === 'plan.submit') { heldPlan = message; holdPlan = false; return; }
    if (holdConcede && message.method === 'match.concede-v2') { heldConcede = message; holdConcede = false; return; }
    dispatch({ protocol: 'mecha-net:v1', type: 'request', requestId: message.requestId, method: message.method, payload: message.payload });
  };
  host.addEventListener('message', handleHostMessage);

  const events = [];
  const statuses = [];
  client = new RemoteMatchClient({ url: wsUrl(owner.ticket), playerId: 'owner', capability: 'mecha:v3', timeoutMs: 4000,
    reconnect: { url: endpoint('access'), deviceId: owner.deviceId, token: owner.reconnectToken },
    socketFactory: url => (ownerSocket = new WebSocket(url)),
  });
  client.subscribe(event => events.push(event));
  client.onStatus(status => statuses.push(status));
  const before = await client.snapshot(matchId);
  assert.equal(before.ok, true);
  assert.equal(before.value.state.phase, 'deployment');
  assert.equal(before.value.revision, 0);
  const incomplete = await client.submitDeployment({ ...fixture.command, commandId: 'incomplete', plan: { ...fixture.command.plan, placements: fixture.command.plan.placements.slice(0, 2) } });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.error.code, 'invalid_deployment');
  assert.equal(incomplete.error.fault.code, 'incomplete');
  assert.equal((await client.snapshot(matchId)).value.revision, 0);

  dropDeploymentResponse = true;
  await assert.rejects(client.submitDeployment(fixture.command), /host_offline/);
  await until(() => events.some(event => event.type === 'match.replaced' && event.snapshot.revision === 1), 'deployment event or reconnect snapshot');
  await until(() => statuses.filter(status => status === 'online').length >= 2, 'client reconnected and re-paired');
  const after = await client.snapshot(matchId);
  assert.equal(after.ok, true);
  assert.equal(after.value.state.phase, 'player_plan');
  assert.equal(after.value.revision, 1);
  const repeated = await client.submitDeployment(fixture.command);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.value.revision, 1);
  assert.deepEqual(repeated.value.state, after.value.state);
  const conflict = await client.submitDeployment({ ...fixture.command, plan: { ...fixture.command.plan, placements: [...fixture.command.plan.placements].reverse() } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'duplicate_command');
  assert.equal((await client.snapshot(matchId)).value.revision, 1);
  // Only the host disconnects. The owner's relay socket remains open, so the
  // synchronizer (not the client's socket reconnect path) must recover.
  const syncErrors = [];
  synchronizer = new RemoteMatchSynchronizer(matchId, () => client.snapshot(matchId), {
    snapshot: () => {}, turn: () => {}, syncing: () => {}, error: code => syncErrors.push(code),
  });
  synchronizer.connection(true);
  const stopSyncEvents = client.subscribe(event => synchronizer.event(event));
  await synchronizer.resync();
  assert.equal(synchronizer.canInteract(), true);
  const ownerBefore = ownerSocket;
  const closedHost = new Promise(resolve => host.addEventListener('close', resolve, { once: true }));
  host.close(1000, 'synthetic_host_offline');
  await closedHost;
  await synchronizer.resync();
  assert.equal(syncErrors.at(-1), 'host_offline');
  assert.equal(synchronizer.canInteract(), false);
  assert.equal(ownerSocket, ownerBefore);
  assert.equal(ownerSocket.readyState, WebSocket.OPEN);
  const newTicket = await post('access', { action: 'pair', role: 'host' });
  host = await readySocket(wsUrl(newTicket.ticket));
  host.addEventListener('message', handleHostMessage);
  await until(() => synchronizer.canInteract(), 'automatic host recovery');
  assert.equal(ownerSocket, ownerBefore);
  stopSyncEvents();

  // Let a snapshot overtake a PvE command, then replace the session with PvP
  // before delivering the delayed command to the actual session host.
  const delayed = { protocol: 'mecha-net:v1', type: 'plan.submit', matchId, playerId: 'owner', commandId: 'late-pve', baseRevision: after.value.revision,
    plan: { revision: after.value.revision, items: ['Assault', 'Gunner', 'Support'].map(mechId => ({ mechId, moveTo: null, action: { kind: 'skip' } })) } };
  holdPlan = true;
  const delayedResult = client.submitPlan(delayed);
  await until(() => heldPlan, 'held plan');
  assert.equal((await client.snapshot(matchId)).value.revision, after.value.revision);
  dispatch({ protocol: 'mecha-net:v1', type: 'request', requestId: 'join-session', method: 'match.join', payload: { matchId, playerId: 'guest' } });
  await until(() => replies.some(reply => reply.type === 'joined' && reply.ok), 'PvP replacement');
  const replaced = await client.snapshot(matchId);
  assert.equal(replaced.value.mode, 'pvp');
  assert.equal(replaced.value.revision, after.value.revision + 1);
  dispatch({ protocol: 'mecha-net:v1', type: 'request', requestId: heldPlan.requestId, method: heldPlan.method, payload: heldPlan.payload });
  const rejected = await delayedResult;
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'stale_revision');
  assert.deepEqual((await client.snapshot(matchId)).value.state, replaced.value.state);
  const staleConcede = { type: 'match.concede-v2', protocol: 'mecha-net:v1', matchId, playerId: 'owner', commandId: 'late-concede', baseRevision: replaced.value.revision };
  holdConcede = true;
  const staleConcedeResult = client.submitConcede(staleConcede, replaced.value.ruleset);
  await until(() => heldConcede, 'held concession');
  const next = { ...delayed, commandId: 'pvp-plan', baseRevision: replaced.value.revision, plan: { ...delayed.plan, revision: replaced.value.revision } };
  const accepted = await client.submitPlan(next);
  assert.equal(accepted.ok, true); assert.equal(accepted.value.revision, replaced.value.revision + 1);
  assert.deepEqual(await client.submitPlan(next), accepted);
  dispatch({ protocol: 'mecha-net:v1', type: 'request', requestId: heldConcede.requestId, method: heldConcede.method, payload: heldConcede.payload });
  assert.equal((await staleConcedeResult).error.code, 'stale_revision');
  const concede = { ...staleConcede, commandId: 'safe-concede', baseRevision: accepted.value.revision };
  dropConcedeResponse = true;
  await assert.rejects(client.submitConcede(concede, replaced.value.ruleset), /host_offline/);
  const retry = await client.submitConcede(concede, replaced.value.ruleset);
  assert.equal(retry.ok, true);
  assert.equal(retry.value.revision, concede.baseRevision + 1);
  assert.equal(events.filter(event => event.type === 'turn.resolved' && event.result.commandId === 'safe-concede').length, 1);
  assert.equal((await client.snapshot(matchId)).value.status, 'finished');
  console.log('PASS local v3 relay: deployment, lost replies, host recovery, delayed plan/concession rejection and idempotent concession retry. Synthetic Tauri bridge; no physical device or production relay.');
} finally {
  synchronizer?.dispose();
  client?.dispose();
  host?.close(1000, 'test_finished');
  if (registered) await post('close', {}).catch(() => {});
  delete globalThis.window;
}
