#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { DrivingEventLog } = await loadCity({ "game/runtime/DrivingEventLog.ts": ["DrivingEventLog"] });
const log = new DrivingEventLog(2, 1000);
const event = (atMs, reason = "wall", obstacleIds = ["solid:1"]) => ({ atMs, kind: "contact", x: 1, y: 2, z: 3, reason, obstacleIds });
assert.ok(log.record(event(0)));
assert.equal(log.record(event(500)), null, "same fault is debounced during repeated contact ticks");
assert.ok(log.record(event(1001)), "same fault is recorded again after the debounce window");
assert.ok(log.record(event(1100, "pier", ["solid:2"])), "changed cause/obstacle is a new diagnostic event");
assert.equal(log.snapshot().length, 2, "the ring buffer retains only its configured bound");
assert.deepEqual(log.snapshot().map((item) => item.obstacleIds), [["solid:1"], ["solid:2"]]);
assert.equal(log.record({ ...event(1200), x: Infinity }), null, "invalid pose data is rejected");
log.clear(); assert.deepEqual(log.snapshot(), []);
console.log("Driving event log: local-only, debounced, validated and bounded.");
