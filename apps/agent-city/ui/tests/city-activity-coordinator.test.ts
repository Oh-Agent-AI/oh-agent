import test from "node:test";
import assert from "node:assert/strict";
import { CityActivityCoordinator } from "../src/game/activity/CityActivityCoordinator.ts";

test("activity admission is synchronous and denies competing preparation", () => {
  const host = new CityActivityCoordinator();
  const flight = host.tryAcquire("flight");
  assert.equal(flight.ok, true);
  if (!flight.ok) return;
  assert.equal(flight.lease.runId, 1);
  assert.equal(host.snapshot?.phase, "preparing");
  const driving = host.tryAcquire("driving");
  assert.equal(driving.ok, false);
  if (!driving.ok) assert.equal(driving.active.activityId, "flight");
  assert.equal(flight.lease.activate(), true);
  assert.equal(host.snapshot?.phase, "running");
});

test("release is idempotent and a stale lease cannot release a later owner", () => {
  const host = new CityActivityCoordinator();
  const first = host.tryAcquire("driving");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  first.lease.release();
  first.lease.release();
  const second = host.tryAcquire("mecha");
  assert.equal(second.ok, true);
  if (!second.ok) return;
  first.lease.release();
  assert.equal(host.snapshot?.activityId, "mecha");
  assert.equal(first.lease.activate(), false);
  second.lease.release();
  assert.equal(host.snapshot, null);
});

test("subscribers observe lifecycle changes and unsubscribe cleanly", () => {
  const host = new CityActivityCoordinator();
  const phases: Array<string | null> = [];
  const unsubscribe = host.subscribe(snapshot => phases.push(snapshot?.phase ?? null));
  const admission = host.tryAcquire("flight");
  assert.equal(admission.ok, true);
  if (!admission.ok) return;
  admission.lease.activate();
  admission.lease.release();
  unsubscribe();
  host.tryAcquire("driving");
  assert.deepEqual(phases, [null, "preparing", "running", null]);
});
