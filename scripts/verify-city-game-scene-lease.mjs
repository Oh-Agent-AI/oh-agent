#!/usr/bin/env node
// Host scene lease transactions: preparation is exclusive, cancellation releases
// late snapshots, and an old runtime cannot clear a replacement lease's writes.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { HostGameScenePort, GameRuntime } = await loadCity({ "game/runtime/HostGameScenePort.ts": ["HostGameScenePort"], "game/runtime/GameRuntime.ts": ["GameRuntime"] });

const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function hostFixture() {
  const state = { epoch: 1, alive: true, hook: null, attached: new Set(), camera: "return", ambient: true,
    restores: 0, capturesReleased: 0, owners: 0, failOwnership: false, failAttachAfterFirst: false, failDetach: false };
  const port = new HostGameScenePort({
    epoch: () => state.epoch, isAlive: () => state.alive, canAcquire: () => true,
    capture: async (_selection, signal) => {
      if (state.capture) return state.capture(signal);
      return { status: "ready", capture: { revision: `world:${state.epoch}`, snapshot: {}, isCurrent: () => state.alive, verifyCurrent: () => state.alive,
        release: () => { state.capturesReleased++; } } };
    },
    captureReturnState: () => ({ camera: state.camera, ambient: state.ambient }),
    takeOwnership: () => { if (state.failOwnership) return false; state.owners++; state.camera = "game"; return true; },
    restoreReturnState: (_token, returned) => { state.restores++; state.camera = returned.camera; state.ambient = returned.ambient; },
    setFrameHook: (_token, hook) => { state.hook = hook; },
    attach: (_token, objects) => {
      objects.forEach((object, index) => { if (state.failAttachAfterFirst && index === 1) throw new Error("attach-failed"); state.attached.add(object); });
    },
    detach: (_token, objects) => { if (state.failDetach) throw new Error("detach-failed"); objects.forEach((object) => state.attached.delete(object)); },
    setCamera: (_token, pose) => { state.camera = pose; },
    setAmbientCarsVisible: (_token, visible) => { state.ambient = visible; },
  });
  return { port, state };
}
const selection = { vehicle: "plane", activity: "practice" };

// Typed admission distinguishes expected contention/cancellation/unavailability
// and never leaves a reservation behind after a capture failure.
{
  const { port, state } = hostFixture();
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await port.acquireResult(selection, 0, aborted.signal)).status, "cancelled");
  state.alive = false;
  assert.equal((await port.acquireResult(selection, 1, new AbortController().signal)).status, "unavailable");
  state.alive = true;
  state.capture = async () => ({ status: "unavailable", reason: "static-solids-over-budget" });
  const failed = await port.acquireResult(selection, 2, new AbortController().signal);
  assert.equal(failed.status, "unavailable");
  assert.equal(state.owners, 0); assert.equal(state.restores, 0);
  state.capture = async () => { throw new Error("x".repeat(500)); };
  const unexpected = await port.acquireResult(selection, 3, new AbortController().signal);
  assert.equal(unexpected.status, "unavailable");
  assert.ok(unexpected.reason.length <= 120, "unexpected capture reasons are bounded");
  state.capture = null;
  const next = await port.acquireResult(selection, 4, new AbortController().signal);
  assert.equal(next.status, "ready", "failed capture frees the exclusive slot");
  if (next.status === "ready") next.lease.release();
}

// Partial host attachment is rolled back before the lease can escape.
{
  const { port, state } = hostFixture();
  const lease = await port.acquire(selection, 0, new AbortController().signal);
  state.failAttachAfterFirst = true;
  state.failDetach = true;
  assert.throws(() => lease.attach(["first-object", "second-object"]), /attach-failed/);
  assert.deepEqual([...state.attached], ["first-object"], "failed rollback retains only partially attached owned objects");
  state.failDetach = false;
  lease.release();
  assert.deepEqual([...state.attached], []);
}

// A pending preparation reserves the single slot before capture resolves.
{
  const { port, state } = hostFixture(), pending = defer();
  state.capture = () => pending.promise;
  const abort = new AbortController();
  const first = port.acquireResult(selection, 1, abort.signal);
  assert.equal((await port.acquireResult({ vehicle: "car", activity: "free" }, 2, new AbortController().signal)).status, "busy");
  await assert.rejects(port.acquire({ vehicle: "car", activity: "free" }, 2, new AbortController().signal), /scene-already-leased/);
  abort.abort(); state.capture = null;
  const second = await port.acquireResult({ vehicle: "car", activity: "free" }, 2, new AbortController().signal);
  assert.equal(second.status, "ready");
  pending.resolve({ status: "ready", capture: { revision: "late", snapshot: {}, isCurrent: () => true, release: () => { state.capturesReleased++; } } });
  assert.equal((await first).status, "cancelled");
  if (second.status === "ready") second.lease.release();
  assert.equal(state.capturesReleased, 2, "both late and current static pins release");
  assert.equal(state.restores, 1, "cancelled preparing lease does not restore over the next lease");
}

// A released lease's delayed cleanup cannot clear the next runtime's hook, camera,
// attachments or return state, even when the runtimes are different instances.
{
  const { port, state } = hostFixture();
  const old = await port.acquire(selection, 3, new AbortController().signal);
  let oldFrames = 0; old.attach(["old-object"]); old.setFrameHook(() => { oldFrames++; });
  const cachedOldHook = state.hook; old.release();
  const current = await port.acquire({ vehicle: "car", activity: "free" }, 4, new AbortController().signal);
  const hook = () => {};
  current.setFrameHook(hook); current.attach(["new-object", "overlay-owned-by-host"]); current.detach(["new-object", "someone-elses-overlay"]);
  current.attach(["new-object"]);
  const currentHook = state.hook;
  old.setFrameHook(null); old.detach(["old-object"]); cachedOldHook(1 / 60); assert.equal(oldFrames, 0);
  assert.throws(() => old.setCamera({ position: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], fov: 42 }), /stale-game-scene/); old.release();
  assert.equal(state.hook, currentHook); assert.deepEqual([...state.attached].sort(), ["new-object", "overlay-owned-by-host"].sort());
  assert.throws(() => current.setCamera({ position: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 42 }), /invalid-camera-pose/);
  assert.throws(() => current.setCamera({ position: [0, 0, 0], target: [0, 0, -1], up: [0, 0, 1], fov: 42 }), /invalid-camera-pose/);
  assert.notDeepEqual(state.camera, "return");
  current.release();
  assert.equal(state.hook, null); assert.deepEqual([...state.attached], []); assert.equal(state.camera, "return");
}

// Snapshot/ownership failure rolls back the reservation and source pin.
{
  const { port, state } = hostFixture(); state.failOwnership = true;
  await assert.rejects(port.acquire(selection, 5, new AbortController().signal), /host-ownership-refused/);
  assert.equal(state.capturesReleased, 1); assert.equal(state.restores, 0);
  state.failOwnership = false;
  const next = await port.acquire(selection, 6, new AbortController().signal); next.release();
}

// Epoch changes invalidate a lease; a stale release is harmless and the content pin is freed.
{
  const { port, state } = hostFixture();
  const lease = await port.acquire(selection, 7, new AbortController().signal);
  state.epoch++;
  assert.equal(lease.isCurrent(), false);
  assert.throws(() => lease.attach(["stale"]), /stale-game-scene/);
  lease.release();
  assert.equal(state.capturesReleased, 1); assert.equal(state.attached.size, 0);
}

// A real old GameRuntime cleanup from one runtime instance cannot clear a lease
// already installed by a second runtime instance.
{
  const { port, state } = hostFixture();
  const adapter = (revision) => ({ revision, isCurrent: () => true, prepare() {}, fixedStep() {}, present() {}, settle() {}, reset() {}, dispose() {} });
  const firstLease = await port.acquire(selection, 8, new AbortController().signal);
  const firstRuntime = new GameRuntime();
  assert.equal(firstRuntime.enterSync(firstLease, adapter(firstLease.revision)), true);
  firstRuntime.exit();
  const secondLease = await port.acquire({ vehicle: "car", activity: "free" }, 9, new AbortController().signal);
  const secondRuntime = new GameRuntime();
  assert.equal(await secondRuntime.enter(secondLease, adapter(secondLease.revision)), true);
  const secondHook = state.hook;
  firstLease.setFrameHook(null); firstLease.release();
  assert.equal(state.hook, secondHook);
  secondRuntime.exit();
}

console.log("city game scene lease: ok");
