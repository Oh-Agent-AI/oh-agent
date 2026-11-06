import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { extractRoadFaces, generateRoadBlocks, validateParcelFrontage } = await loadCity({
  "engine/planner/roadFaces.ts": ["extractRoadFaces"], "engine/planner/roadBlocks.ts": ["generateRoadBlocks"],
  "engine/planner/parcelFrontage.ts": ["validateParcelFrontage"],
});
const points = [{ x: 0, z: 0 }, { x: 80, z: 0 }, { x: 80, z: 80 }, { x: 0, z: 80 }];
const roads = points.map((a, i) => ({ id: `r${i}`, from: `${a.x}:${a.z}`, to: `${points[(i + 1) % 4].x}:${points[(i + 1) % 4].z}`, points: [a, points[(i + 1) % 4]], width: 8, kind: "local" }));
const generated = generateRoadBlocks({ faces: extractRoadFaces(roads), roads, primaryAnchorNodeId: "0:0", networkVersion: 3,
  districtFor: () => "d", zoneFor: () => "residential", buildable: () => true, sites: [], highways: [], maxCandidates: 100 });
const map = new Map(roads.map(edge => [edge.id, edge])), block = generated.blocks[0];
for (const proof of generated.access) {
  const parcel = block.parcels.find(p => p.id === proof.parcelId), before = JSON.stringify({ proof, parcel, block, roads });
  assert.ok(validateParcelFrontage(proof, parcel, block, map, 3, "0:0").ok);
  assert.equal(JSON.stringify({ proof, parcel, block, roads }), before);
  for (const change of [{ roadPoint: { x: 1000, z: 1000 } }, { shoulderPoint: { x: 1000, z: 1000 } }, { frontagePoint: { x: 1000, z: 1000 } },
    { networkVersion: 2 }, { hostSegmentIndex: 0.5 }, { hostSegmentIndex: -1 }, { scope: "unsupported" }, { sourceFaceId: "wrong" },
    { frontagePoint: { x: NaN, z: 0 } }, { primaryNodePath: [] }, { primaryEdgePath: ["missing"] }]) {
    assert.equal(validateParcelFrontage({ ...proof, ...change }, parcel, block, map, 3, "0:0").ok, false);
  }
  assert.equal(validateParcelFrontage(proof, { ...parcel, x: parcel.x + 1 }, block, map, 3, "0:0").ok, false);
  assert.equal(validateParcelFrontage(proof, parcel, block, map, 4, "0:0").ok, false);
  const badHosts = new Map(map); badHosts.set(proof.hostEdgeId, { ...map.get(proof.hostEdgeId), bridge: true });
  assert.equal(validateParcelFrontage(proof, parcel, block, badHosts, 3, "0:0").ok, false);
}
assert.equal(validateParcelFrontage(undefined, block.parcels[0], block, map, 3, "0:0").ok, false);
console.log("City parcel frontage: all opposite-side generated proofs, actual segment/normal/shoulder/frontage, current geometry/version, malformed identity/path and immutable validation passed.");
