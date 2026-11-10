import test from "node:test";
import assert from "node:assert/strict";
import { acquireRemoteGameplay } from "../src/remote/remoteGameplayHost.ts";

function fakeLease(onRelease = () => {}) {
  return { release: onRelease } as never;
}

test("remote gameplay uses the host lease and returns it to the adapter", async () => {
  const lease = fakeLease();
  let received: unknown;
  const host = { acquireResult: async (_selection: unknown, runId: number) => {
    received = runId;
    return { status: "ready" as const, lease };
  } };
  assert.equal(await acquireRemoteGameplay(host, { vehicle: "car", activity: "free" }, 12, new AbortController().signal), lease);
  assert.equal(received, 12);
});

test("busy host refuses remote gameplay without manufacturing another lease", async () => {
  const host = { acquireResult: async () => ({ status: "busy" as const, reason: "host-busy" }) };
  await assert.rejects(acquireRemoteGameplay(host, { vehicle: "plane", activity: "practice" }, 1, new AbortController().signal), /remote_scene_host-busy/);
});

test("cancellation after lease acquisition releases the host lease", async () => {
  const abort = new AbortController();
  let releaseCount = 0;
  const lease = fakeLease(() => { releaseCount += 1; });
  const host = { acquireResult: async () => {
    abort.abort();
    return { status: "ready" as const, lease };
  } };
  await assert.rejects(acquireRemoteGameplay(host, { vehicle: "car", activity: "free" }, 2, abort.signal), /remote_game_cancelled/);
  assert.equal(releaseCount, 1);
});
