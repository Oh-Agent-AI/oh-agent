import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { extractRoadFaces } = await loadCity({ "engine/planner/roadFaces.ts": ["extractRoadFaces"] });
const point = (x, z) => ({ x, z });
const edge = (id, a, b, more = {}) => ({ id, from: `${a.x}:${a.z}`, to: `${b.x}:${b.z}`, width: 8, kind: "local", points: [a, b], ...more });
const square = (prefix, x = 0, z = 0, size = 10) => {
  const p = [point(x, z), point(x + size, z), point(x + size, z + size), point(x, z + size)];
  return p.map((a, i) => edge(`${prefix}${i}`, a, p[(i + 1) % 4]));
};
const check = (roads) => { const before = JSON.stringify(roads), result = extractRoadFaces(roads);
  assert.equal(JSON.stringify(roads), before); assert.deepEqual(extractRoadFaces([...roads].reverse()), result); return result; };
assert.equal(check(square("s")).faces[0].area, 100);
assert.equal(check([...square("s"), edge("dangling", point(0, 0), point(2, 2))]).faces[0].area, 100);
assert.equal(check([...square("a"), ...square("b", 30)]).faces.length, 2);
assert.deepEqual(check([...square("a"), ...square("b", 30), edge("cut-connector", point(10, 0), point(30, 0))]).faces.map((f) => f.area), [100, 100]);
assert.equal(check([...square("s"), { ...square("s")[0], id: "duplicate" }]).faces.length, 1);
const split = [edge("bottom1", point(0, 0), point(5, 0)), edge("bottom2", point(5, 0), point(10, 0)), ...square("s").slice(1),
  edge("top1", point(0, 10), point(5, 10)), edge("top2", point(5, 10), point(10, 10)), edge("divide", point(5, 0), point(5, 10))];
// Remove old top edge: the accepted T nodes really split both boundary hosts.
split.splice(3, 1);
assert.deepEqual(check(split).faces.map((f) => f.area).sort(), [50, 50]);
const crossed = [...split.filter((e) => e.id !== "divide"), edge("v1", point(5, 0), point(5, 5)), edge("v2", point(5, 5), point(5, 10)),
  edge("left1", point(0, 0), point(0, 5)), edge("left2", point(0, 5), point(0, 10)), edge("right1", point(10, 0), point(10, 5)), edge("right2", point(10, 5), point(10, 10)),
  edge("h1", point(0, 5), point(5, 5)), edge("h2", point(5, 5), point(10, 5))].filter((e) => !["s1", "s3"].includes(e.id));
assert.deepEqual(check(crossed).faces.map((f) => f.area), [25, 25, 25, 25]);
const crossing = [...square("s"), edge("unsplit", point(-2, 5), point(12, 5))];
assert.equal(check(crossing).faces.length, 0); assert.ok(check(crossing).issues.length);
assert.equal(check([...square("s"), { ...crossing.at(-1), bridge: true }]).faces.length, 1);
assert.equal(check(square("s").map((e, i) => i === 0 ? { ...e, structure: "deck" } : e)).faces.length, 0);
const curved = square("c"); curved[0].points = [point(0, 0), point(5, -2), point(10, 0)];
const duplicateCurve = { ...curved[0], id: "curve-copy", from: curved[0].to, to: curved[0].from, points: [...curved[0].points].reverse() };
assert.equal(check([...curved, duplicateCurve]).faces[0].area, 110);
const nested = check([...square("outer", 0, 0, 20), ...square("inner", 5, 5, 5)]);
assert.deepEqual(nested.faces.map((f) => f.area).sort((a, b) => a - b), [25, 375]);
assert.equal(nested.faces.find((f) => f.area === 375).holes.length, 1);
const unjoined = square("u"); unjoined[1].from = "different-id-same-position";
assert.ok(check(unjoined).issues.length);
const stale = square("stale"); stale[1].points[0] = point(11, 0);
assert.ok(check(stale).issues.some((issue) => issue.startsWith("inconsistent-node:")));
console.log("City road faces: accepted T/cross topology, disconnected/nested rings, hanging branches, duplicates, curved polylines, deck/bridge exclusion, deterministic read-only extraction passed.");
