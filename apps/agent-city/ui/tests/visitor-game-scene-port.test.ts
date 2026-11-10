import assert from "node:assert/strict";
import test from "node:test";
import { VisitorGameScenePort, type VisitorGameSceneCallbacks } from "../src/remote/city/VisitorGameScenePort.ts";
import type { GameSelection } from "../src/game/runtime/GameScenePort.ts";

const selection: GameSelection = { vehicle: "car", activity: "free" };

function makeCallbacks(overrides: Partial<VisitorGameSceneCallbacks<{ city: string }, string>> = {}) {
  const calls = { capture: 0, released: 0, restored: 0, attached: 0, detached: 0, frames: 0 };
  let epoch = 4;
  let alive = true;
  const callbacks: VisitorGameSceneCallbacks<{ city: string }, string> = {
    epoch: () => epoch,
    isAlive: () => alive,
    capture: async () => {
      calls.capture++;
      return { status: "ready", capture: {
        revision: "visitor-snapshot-1", snapshot: { city: "synthetic" }, isCurrent: () => alive,
        release: () => { calls.released++; },
      } };
    },
    captureReturnState: () => ({ camera: "visitor-camera" }),
    restoreReturnState: () => { calls.restored++; },
    setFrameHook: (_token, hook) => { if (hook) calls.frames++; },
    attach: (_token, objects) => { calls.attached += objects.length; },
    detach: (_token, objects) => { calls.detached += objects.length; },
    setCamera: () => {},
    setAmbientCarsVisible: () => {},
    onReleased: () => { calls.released++; },
    ...overrides,
  };
  return { calls, callbacks, setEpoch: (value: number) => { epoch = value; }, setAlive: (value: boolean) => { alive = value; } };
}

test("visitor scene reserves synchronously and reports a concurrent acquire as busy", async () => {
  let finishCapture!: (value: Awaited<ReturnType<VisitorGameSceneCallbacks<unknown, unknown>["capture"]>>) => void;
  const fixture = makeCallbacks();
  const captureImmediately = fixture.callbacks.capture;
  let captures = 0;
  const callbacks = { ...fixture.callbacks, capture: () => ++captures === 1 ? new Promise(resolve => { finishCapture = resolve; }) : captureImmediately(selection, new AbortController().signal) };
  const port = new VisitorGameScenePort(callbacks);
  const first = port.acquireResult(selection, 1, new AbortController().signal);
  const second = await port.acquireResult(selection, 2, new AbortController().signal);
  assert.equal(second.status, "busy");
  finishCapture({ status: "ready", capture: { revision: "r1", snapshot: { city: "synthetic" }, isCurrent: () => true, release() {} } });
  const ready = await first;
  assert.equal(ready.status, "ready");
  if (ready.status === "ready") ready.lease.release();
});

test("aborting capture releases the reservation and releases a late snapshot", async () => {
  let finishCapture!: (value: Awaited<ReturnType<VisitorGameSceneCallbacks<unknown, unknown>["capture"]>>) => void;
  const fixture = makeCallbacks();
  const captureImmediately = fixture.callbacks.capture;
  let captures = 0;
  const calls = fixture.calls;
  const callbacks = { ...fixture.callbacks, capture: () => ++captures === 1 ? new Promise(resolve => { finishCapture = resolve; }) : captureImmediately(selection, new AbortController().signal) };
  const port = new VisitorGameScenePort(callbacks);
  const abort = new AbortController();
  const resultPromise = port.acquireResult(selection, 3, abort.signal);
  abort.abort();
  const result = await resultPromise;
  assert.deepEqual(result, { status: "cancelled", reason: "cancelled" });
  const releasedBeforeLateCapture = calls.released;
  finishCapture({ status: "ready", capture: { revision: "late", snapshot: { city: "synthetic" }, isCurrent: () => true, release: () => { calls.released++; } } });
  await Promise.resolve();
  assert.equal(calls.released, releasedBeforeLateCapture + 1);
  const next = await port.acquireResult(selection, 4, new AbortController().signal);
  assert.equal(next.status, "ready");
  if (next.status === "ready") {
    assert.equal(calls.released, releasedBeforeLateCapture + 1); // The stale capture was disposed exactly once.
    next.lease.release();
  }
});

test("release is idempotent and cleans only the visitor scene lease", async () => {
  const { calls, callbacks } = makeCallbacks();
  const port = new VisitorGameScenePort(callbacks);
  const result = await port.acquireResult(selection, 5, new AbortController().signal);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  const lease = result.lease;
  lease.attach(["car", "marker"]);
  lease.setFrameHook(() => {});
  lease.release();
  lease.release();
  assert.equal(lease.isCurrent(), false);
  assert.equal(calls.attached, 2);
  assert.equal(calls.detached, 2);
  assert.equal(calls.frames, 1);
  assert.equal(calls.restored, 1);
  assert.equal(calls.released, 2); // capture pin and visitor lease callback
});

test("lease rejects stale renderer epochs and invalidated visitors", async () => {
  const fixture = makeCallbacks();
  const port = new VisitorGameScenePort(fixture.callbacks);
  const result = await port.acquireResult(selection, 6, new AbortController().signal);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  fixture.setEpoch(5);
  assert.equal(result.lease.isCurrent(), false);
  assert.throws(() => result.lease.attach(["stale"]), /stale-game-scene/);
  result.lease.release();

  fixture.setAlive(false);
  const unavailable = await port.acquireResult(selection, 7, new AbortController().signal);
  assert.deepEqual(unavailable, { status: "unavailable", reason: "host-disposed" });
});
