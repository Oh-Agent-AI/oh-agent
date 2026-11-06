#!/usr/bin/env node
// 主干环岛切边后不再共享原环心：新增弧段必须满足最终净距，拒绝时零副作用。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { runJunctionRing, emptyNetwork, addNetworkEdge, crowdedArterials, acuteJunctions, buildJunctionRings } = await loadCity({
  "engine/planner/connect.ts": ["runJunctionRing"],
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge"],
  "engine/planner/constraints.ts": ["crowdedArterials", "acuteJunctions"],
  "engine/planner/junctionRings.ts": ["buildJunctionRings"],
});
const makeWorld = (arterial = true) => {
  const network = emptyNetwork();
  for (const p of [{ x: 100, z: 0 }, { x: 0, z: 100 }, { x: -100, z: 0 }, { x: 0, z: -100 }])
    addNetworkEdge(network, { x: 0, z: 0 }, p, arterial);
  return { network, reservations: () => [] };
};
const snapshot = (w) => JSON.stringify([w.network.version, [...w.network.nodes], [...w.network.edges]]);
const view = (w) => ({ roadEdges: [...w.network.edges.values()], roadNodes: [...w.network.nodes.values()] });
const build = (w, radii, arterial = true) => runJunctionRing(w, { id: "0:0", x: 0, z: 0 },
  [...w.network.edges.values()], { radii, arcStepDeg: 30, ringArterial: arterial, maxSegments: 18 }, () => null);
{
  const w = makeWorld(), before = snapshot(w);
  assert.equal(crowdedArterials.measure(view(w)).length, 0);
  const result = build(w, [10]);
  assert.equal(result.ok, false, "opposite arterial arc chords in a small ring violate the real clearance rule");
  assert.match(result.detail, /crowded arterial/);
  assert.equal(snapshot(w), before, "declined construction must preserve nodes, edges and revision");
}
{
  const w = makeWorld(), other = makeWorld();
  const result = build(w, [10, 18]);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.radius, 18, "unsafe radius must fall through to the next safe candidate");
  assert.equal(crowdedArterials.measure(view(w)).length, 0);
  assert.equal(acuteJunctions.measure(view(w)).length, 0);
  assert.equal(w.network.nodes.has("0:0"), false);
  for (const id of ["100:0", "0:100", "-100:0", "0:-100"]) assert.ok(w.network.nodes.has(id));
  assert.deepEqual(build(other, [10, 18]), result);
  assert.equal(snapshot(other), snapshot(w), "construction is deterministic");
}
{
  const w = makeWorld(false);
  assert.ok(build(w, [10], false).ok, "local rings retain their declared class and remain available");
  assert.ok([...w.network.edges.values()].every((edge) => edge.kind === "local" && edge.width === 5));
}
{
  const network = emptyNetwork();
  for (const p of [{ x: 100, z: 0 }, { x: -50, z: 86.6 }, { x: -50, z: -86.6 }])
    addNetworkEdge(network, { x: 0, z: 0 }, p, false);
  assert.ok(build({ network, reservations: () => [] }, [10], false).ok, "ordinary local three-way junctions can form a ring too");
}
{
  const network = emptyNetwork(), center = { x: 0, z: 0 };
  const far = [{ x: 100, z: 0 }, { x: -50, z: 86.6 }, { x: -50, z: -86.6 }];
  for (const p of far) addNetworkEdge(network, center, p, false);
  const world = { network, reservations: () => [], inRiver: () => false,
    geo: { height: () => 1.2, buildable: () => true, terrain: { slope: () => 0 } } };
  const paths = [[far[0], center, far[1]]];
  const options = { network, world, core: { x: -1000, z: -1000 }, random: () => 0, routes: [paths], pinned: new Set(["0:0"]) };
  assert.equal(buildJunctionRings(options).rings.length, 0, "a pinned owner junction cannot be replaced");
  const report = buildJunctionRings({ ...options, pinned: new Set() });
  assert.equal(report.rings.length, 1, "ordinary three-way local intersections participate in sparse selection");
  assert.equal(report.rings[0].kind, "minor");
  for (let i = 1; i < paths[0].length; i += 1) {
    const id = paths[0].slice(i - 1, i + 1).map(p => `${p.x}:${p.z}`).sort().join("/");
    assert.ok(network.edges.has(id), "rewritten traffic routes follow real ring edges");
  }
}
console.log("City junction rings: arterial clearance, safe radius fallback, rollback, determinism and local ring preservation passed.");
