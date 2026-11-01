import assert from "node:assert/strict";
import test from "node:test";
import { RemoteMatchSynchronizer } from "../src/game/mecha/client/RemoteMatchSynchronizer.ts";
import { ActiveTimeClock } from "../src/game/mecha/presentation/ActiveTimeClock.ts";
import { RemotePresentationCoordinator } from "../src/game/mecha/presentation/RemotePresentationCoordinator.ts";
import type { BattleScenePort, RemoteBattleState } from "../src/game/mecha/presentation/BattleScenePort.ts";
import { MECHA_NET_PROTOCOL, type MatchResult, type MatchSnapshot, type TurnResolved } from "../src/game/mecha/contracts/match.ts";
import { bossPrepare, createMatch, playTurn, type MatchState } from "../src/game/mecha/rules.ts";
import { PVP_RULESET, createPvpMatch, playPvpTurn } from "../src/game/mecha/rules/pvp.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const first = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash" });
bossPrepare(first);
function turnFrom(state: MatchState, id: string): TurnResolved<RemoteBattleState> {
  const plan = { revision: state.revision, items: state.mechs.filter((m) => m.hp > 0).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
  const result = playTurn(state, plan);
  if (!result.ok) throw new Error(result.fault.reason);
  return { type: "turn.resolved", protocol: MECHA_NET_PROTOCOL, matchId: "match", playerId: "owner", commandId: id, revision: result.state.revision, ...result };
}
const t1 = turnFrom(first, "t1");
const t2 = turnFrom(t1.state as MatchState, "t2");
function snap(state: RemoteBattleState): MatchSnapshot<RemoteBattleState> {
  return { protocol: MECHA_NET_PROTOCOL, matchId: "match", mode: "pve", ruleset: state.ruleset, status: "active", revision: state.revision, state, players: [], arena: {} as never };
}
function harness() {
  const requests: ReturnType<typeof deferred<MatchResult<MatchSnapshot<RemoteBattleState>>>>[] = [];
  const snapshots: Array<{ value: MatchSnapshot<RemoteBattleState>; recovered: boolean }> = [];
  const turns: number[] = [], syncing: boolean[] = [], errors: string[] = [];
  const sync = new RemoteMatchSynchronizer("match", () => {
    const request = deferred<MatchResult<MatchSnapshot<RemoteBattleState>>>(); requests.push(request); return request.promise;
  }, { snapshot: (value, recovered) => snapshots.push({ value, recovered }), turn: (turn) => turns.push(turn.revision), syncing: (value) => syncing.push(value), error: (value) => errors.push(value) });
  sync.connection(true);
  return { sync, requests, snapshots, turns, syncing, errors };
}

test("initial snapshot buffers early event and deduplicates response/event", async () => {
  const h = harness(); const request = h.sync.resync();
  h.sync.turn(t1);
  assert.equal(h.sync.canInteract(), false);
  h.requests[0].resolve({ ok: true, value: snap(first) }); await request;
  assert.deepEqual(h.turns, [t1.revision]);
  assert.equal(h.sync.canInteract(), true);
  h.sync.turn(t1); assert.equal(h.turns.length, 1);
  assert.equal(t1.revision - first.revision, 3, "PvE revision is not a turn counter");
});

test("initial connecting notification does not invalidate the snapshot request", async () => {
  const h = harness(); h.sync.connection(false);
  const start = h.sync.resync(); h.sync.connection(false); h.sync.connection(true);
  h.requests[0].resolve({ ok: true, value: snap(first) }); await start;
  assert.equal(h.sync.canInteract(), true);
  assert.equal(h.snapshots.length, 1);
});

test("PvP accepts one revision per turn and detects larger gaps", async () => {
  const arena = { terrain: first.terrain, heights: first.heights, blocked: [], buildings: [] } as never;
  const initial = createPvpMatch(arena);
  const nextTurn = (state: typeof initial, id: string): TurnResolved<RemoteBattleState> => {
    const plan = { revision: state.revision, items: state.units.filter((u) => u.side === state.activeSide && u.hp > 0).map((u) => ({ mechId: u.kind, moveTo: null, action: { kind: "skip" as const } })) };
    const result = playPvpTurn(state, plan); if (!result.ok) throw new Error(result.fault.reason);
    return { type: "turn.resolved", protocol: MECHA_NET_PROTOCOL, matchId: "match", playerId: "owner", commandId: id, revision: result.state.revision, ...result };
  };
  const one = nextTurn(initial, "1"), two = nextTurn(one.state as typeof initial, "2");
  const pvpSnap = { ...snap(initial), mode: "pvp" as const, ruleset: PVP_RULESET };
  const h = harness(); const start = h.sync.resync();
  h.requests[0].resolve({ ok: true, value: pvpSnap }); await start;
  h.sync.turn(one); assert.deepEqual(h.turns, [1]);
  const three = nextTurn(two.state as typeof initial, "3");
  h.sync.turn(three); assert.equal(h.sync.canInteract(), false); assert.equal(h.requests.length, 2);
});

test("gap requests snapshot, reports lost history and ignores late duplicate", async () => {
  const h = harness(); const start = h.sync.resync();
  h.requests[0].resolve({ ok: true, value: snap(first) }); await start;
  h.sync.turn(t2);
  assert.equal(h.requests.length, 2); assert.equal(h.sync.canInteract(), false);
  h.requests[1].resolve({ ok: true, value: snap(t2.state) }); await tick();
  assert.equal(h.snapshots.at(-1)?.recovered, true);
  assert.deepEqual(h.turns, []); assert.equal(h.sync.canInteract(), true);
  h.sync.turn(t1); assert.deepEqual(h.turns, []);
});

test("incomplete resync stays locked until explicit retry", async () => {
  const h = harness(); const start = h.sync.resync();
  h.requests[0].resolve({ ok: true, value: snap(first) }); await start;
  h.sync.turn(t2);
  h.requests[1].resolve({ ok: true, value: snap(first) }); await tick();
  assert.equal(h.sync.canInteract(), false); assert.equal(h.errors.at(-1), "sync_incomplete");
  const retry = h.sync.resync(); h.requests[2].resolve({ ok: true, value: snap(t2.state) }); await retry;
  assert.equal(h.sync.canInteract(), true);
});

test("reconnect replacement supersedes stale in-flight snapshot and close is final", async () => {
  const h = harness(); const old = h.sync.resync();
  h.sync.connection(false); h.sync.connection(true);
  h.sync.event({ type: "match.replaced", snapshot: snap(t1.state) });
  h.requests[0].resolve({ ok: true, value: snap(first) }); await old;
  assert.equal(h.snapshots.at(-1)?.value.revision, t1.revision);
  h.sync.event({ type: "match.closed", matchId: "match", revision: t1.revision });
  h.sync.event({ type: "match.replaced", snapshot: snap(t2.state) });
  assert.equal(h.snapshots.at(-1)?.value.status, "closed");
  assert.equal(h.sync.canInteract(), false);
});

test("events queued during snapshot are applied in revision order", async () => {
  const h = harness(); const start = h.sync.resync();
  h.sync.turn(t2); h.sync.turn(t1);
  h.requests[0].resolve({ ok: true, value: snap(first) }); await start;
  assert.deepEqual(h.turns, [t1.revision, t2.revision]);
});

test("disposed synchronizer ignores a pending response", async () => {
  const h = harness(); const start = h.sync.resync(); h.sync.dispose();
  h.requests[0].resolve({ ok: true, value: snap(first) }); await start;
  assert.equal(h.snapshots.length, 0);
});

function sceneHarness() {
  const applied: number[] = [], played: number[] = [], waits: ReturnType<typeof deferred<void>>[] = [], locks: boolean[] = [];
  const scene: BattleScenePort = {
    applySnapshot: (s) => applied.push(s.revision),
    playTurn: (t) => { played.push(t.revision); const wait = deferred<void>(); waits.push(wait); return wait.promise; },
    setPaused: () => {}, dispose: () => {},
  };
  const presentation = new RemotePresentationCoordinator((locked) => locks.push(locked));
  presentation.snapshot(snap(first)); presentation.attach(scene);
  return { scene, presentation, applied, played, waits, locks };
}

test("same-revision snapshot does not interrupt turn; subsequent turns play serially", async () => {
  const h = sceneHarness();
  h.presentation.turn(t1, snap(t1.state)); h.presentation.snapshot(snap(t1.state));
  h.presentation.turn(t2, snap(t2.state));
  assert.deepEqual(h.applied, [first.revision]); assert.deepEqual(h.played, [t1.revision]);
  assert.equal(h.presentation.isPlaying(), true);
  h.waits[0].resolve(); await tick(); assert.deepEqual(h.played, [t1.revision, t2.revision]);
  h.waits[1].resolve(); await tick(); assert.equal(h.presentation.isPlaying(), false);
});

test("same-revision corrections replace a playing scene, but metadata-only changes do not", async () => {
  const h = sceneHarness(); h.presentation.turn(t1, snap(t1.state));
  const metadata = { ...snap(t1.state), players: [{ playerId: "guest", side: "B" as const, role: "guest" as const }] };
  h.presentation.snapshot(metadata);
  assert.equal(h.presentation.isPlaying(), true);
  assert.deepEqual(h.applied, [first.revision]);
  const corrected = structuredClone(metadata);
  if (!("mechs" in corrected.state)) throw new Error("expected PvE state");
  corrected.state.mechs[0].hp -= 1;
  h.presentation.snapshot(corrected);
  assert.equal(h.presentation.isPlaying(), false);
  assert.deepEqual(h.applied, [first.revision, t1.revision]);
  h.waits[0].resolve(); await tick();
  assert.equal(h.presentation.isPlaying(), false);
  const newArena = { ...corrected, arena: { ...corrected.arena, seed: "corrected" } } as typeof corrected;
  h.presentation.snapshot(newArena);
  assert.deepEqual(h.applied, [first.revision, t1.revision, t1.revision]);
});

test("same-revision state correction is reported as a recovery", async () => {
  const h = harness(); const start = h.sync.resync();
  h.requests[0].resolve({ ok: true, value: snap(first) }); await start;
  const corrected = structuredClone(first); corrected.mechs[0].hp -= 1;
  h.sync.event({ type: "match.replaced", snapshot: snap(corrected) });
  assert.equal(h.snapshots.at(-1)?.recovered, true);
  assert.equal(h.sync.canInteract(), true);
});

test("replacement cancels old queue without stale completion unlocking new playback", async () => {
  const h = sceneHarness(); h.presentation.turn(t1, snap(t1.state));
  h.presentation.snapshot(snap(t2.state));
  h.presentation.turn(t2, snap(t2.state));
  h.waits[0].resolve(); await tick(); assert.equal(h.presentation.isPlaying(), true);
  assert.deepEqual(h.applied, [first.revision, t2.revision]);
  h.waits[1].resolve(); await tick(); assert.equal(h.presentation.isPlaying(), false);
});

test("late scene attachment starts at latest state without replaying obsolete turn", () => {
  const h = sceneHarness(); h.presentation.detach(h.scene);
  h.presentation.turn(t1, snap(t1.state)); h.presentation.attach(h.scene);
  assert.deepEqual(h.applied, [first.revision, t1.revision]); assert.deepEqual(h.played, []);
});


test("presentation clock excludes hidden time and tolerates repeated pause notifications", () => {
  let now = 100;
  const clock = new ActiveTimeClock(() => now);
  assert.equal(clock.time(), 100);
  now = 140; clock.setPaused(true); clock.setPaused(true);
  now = 1140; assert.equal(clock.time(), 140);
  clock.setPaused(false); clock.setPaused(false);
  now = 1240; assert.equal(clock.time(), 240);
});
