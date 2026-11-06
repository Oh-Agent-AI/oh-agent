import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { measureLayoutCapacity } = await loadCity({ "engine/planner/layoutCapacity.ts": ["measureLayoutCapacity"] });
const input = { parcelIds: ["a", "b", "c", "d"], usedParcelIds: ["a", "b"], sessionIds: ["s"], assignments: [["s", "a"]], aggregatedSessionCount: 0 };
const snapshot = JSON.stringify(input), report = measureLayoutCapacity(input);
assert.equal(JSON.stringify(input), snapshot);
assert.equal(report.status, "accounted");
assert.deepEqual(report.reservedParcelIds, ["b"]);
assert.equal(report.availableForSessions, 3); assert.equal(report.freeAddresses, 2);
assert.equal(report.totalAddresses, report.reservedAddresses + report.assignedSessions + report.freeAddresses);
assert.equal(measureLayoutCapacity({ ...input, sessionIds: ["s", "t"] }).status, "incomplete");
const overflow = measureLayoutCapacity({ ...input, sessionIds: ["s", "t"], aggregatedSessionCount: 1 });
assert.equal(overflow.status, "accounted"); assert.equal(overflow.aggregatedSessions, 1);
assert.deepEqual(overflow.unassignedSessionIds, ["t"]);
for (const change of [{ parcelIds: ["a", "a"] }, { sessionIds: ["s", "s"] },
  { assignments: [["s", "missing"]] }, { assignments: [["s", "a"], ["s", "a"]] },
  { usedParcelIds: ["b"] }, { usedParcelIds: ["a", "missing"] }, { aggregatedSessionCount: -1 },
  { aggregatedSessionCount: 1 }, { aggregatedSessionCount: NaN }]) assert.equal(measureLayoutCapacity({ ...input, ...change }).status, "invalid");
assert.deepEqual(measureLayoutCapacity({ ...input, parcelIds: [...input.parcelIds].reverse(), usedParcelIds: [...input.usedParcelIds].reverse() }), report);
console.log("City layout capacity: post-reservation address denominator, ownership, unrepresented overflow, invalid references and immutable deterministic accounting passed; not a physical/service certificate.");
