import assert from "node:assert/strict";
import test from "node:test";
import { performanceDelta, ReplayHoldClock } from "../src/game/mecha/replayPlayback.ts";

test("replay speed scales presentation only and preserves pause and reduced motion", () => {
  assert.equal(performanceDelta(0.08, false, false, 0.5), 0.04);
  assert.equal(performanceDelta(0.08, false, false, 1), 0.08);
  assert.equal(performanceDelta(0.08, false, false, 2), 0.16);
  assert.equal(performanceDelta(0.08, true, false, 2), 0);
  assert.equal(performanceDelta(0.08, true, true, 2), 0);
  assert.equal(performanceDelta(0.08, false, true, 0.5), Infinity);
  assert.equal(performanceDelta(NaN, false, false, 2), 0);
  assert.equal(performanceDelta(-1, false, false, 2), 0);
});

test("empty-round hold retains elapsed presentation time across pause, hidden and speed changes", () => {
  const clock = new ReplayHoldClock();
  assert.equal(clock.start(1000, 1), 2000);
  assert.equal(clock.stop(1500), 1500);
  assert.equal(clock.stop(5000), 1500, "time while paused or hidden does not count");
  assert.equal(clock.start(5000, 2), 750);
  assert.equal(clock.stop(5250), 1000);
  assert.equal(clock.start(7000, 0.5), 2000);
  assert.equal(clock.stop(9000), 0);
  assert.equal(clock.start(10000, 2), 0);
  assert.equal(clock.stop(10001), 0);
});

test("an early timer or nonmonotonic host clock cannot consume an empty hold twice", () => {
  const clock = new ReplayHoldClock();
  assert.equal(clock.start(1000, 2), 1000);
  assert.equal(clock.stop(999), 2000);
  assert.equal(clock.start(1000, 2), 1000);
  assert.equal(clock.stop(1500), 1000);
  assert.equal(clock.start(1500, 2), 500);
  assert.equal(clock.stop(2000), 0);
});
