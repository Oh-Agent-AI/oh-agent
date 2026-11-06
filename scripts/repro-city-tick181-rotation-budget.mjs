#!/usr/bin/env node
// Synthetic reproduction for a rotational CCD query that exceeded the remaining
// per-motion budget at tick 181. Both the default and --require-resolved invocation
// now require resolution within the original remaining budget, retaining contact.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCity } from "./city-kit/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "fixtures/city-driving/tick181-rotation-budget.json"), "utf8"));
const { sweepBody } = await loadCity({ "game/driving/DrivingCollision.ts": ["sweepBody"] });

const complete = sweepBody([fixture.solid], fixture.from, fixture.to, fixture.dimensions);
const remaining = sweepBody([fixture.solid], fixture.from, fixture.to, fixture.dimensions,
  { maxTests: fixture.remainingTestsAtFailure });
console.log(`${fixture.routeId} tick ${fixture.tick} (${fixture.scene})`);
console.log(`full budget: ${complete.status}:${complete.reason}, ${complete.tests} tests`);
console.log(`remaining ${fixture.remainingTestsAtFailure}: ${remaining.status}:${remaining.reason}, ${remaining.tests} tests`);

assert.equal(complete.status, "contact", "full-budget query must retain the collision witness");
assert.equal(complete.contact?.solidId, fixture.solid.id);
assert.equal(complete.contact?.kind, "rotation");

assert.equal(remaining.status, "contact", "optimized solver must resolve within the original remaining budget");
assert.equal(remaining.contact.solidId, complete.contact.solidId);
assert(remaining.tests <= fixture.remainingTestsAtFailure);
assert(remaining.contact.timeUpper - remaining.contact.time <= 1e-7);
