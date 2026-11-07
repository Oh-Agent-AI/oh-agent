import test from "node:test";
import assert from "node:assert/strict";
import type { SequentialSnapshot } from "../src/game/mecha/contracts/sequentialTransport.ts";
import { stopRemoteAfterRecovery } from "../src/game/mecha/sequentialRemoteStop.ts";

const snapshot = { protocol: "mecha-net:v2", matchId: "m1", ruleset: "mecha-v1.5", revision: 2, initial: {}, placements: [], commands: [] } as SequentialSnapshot;

test("stopping remote refuses to unlock desktop when phone snapshot cannot be recovered", async () => {
  let stopped = 0, restored = 0;
  await assert.rejects(stopRemoteAfterRecovery(async () => null, async () => { stopped++; }, () => { restored++; }), /remote_snapshot_unavailable/);
  assert.equal(stopped, 0);
  assert.equal(restored, 0);
});

test("stopping remote keeps desktop locked when host stop fails", async () => {
  let restored = 0;
  await assert.rejects(stopRemoteAfterRecovery(async () => snapshot, async () => { throw new Error("host_offline"); }, () => { restored++; }), /host_offline/);
  assert.equal(restored, 0);
});

test("desktop state restores only after snapshot recovery and host stop succeed", async () => {
  const calls: string[] = [];
  await stopRemoteAfterRecovery(async () => { calls.push("recover"); return snapshot; }, async () => { calls.push("stop"); }, value => {
    assert.equal(value, snapshot);
    calls.push("restore");
  });
  assert.deepEqual(calls, ["recover", "stop", "restore"]);
});
