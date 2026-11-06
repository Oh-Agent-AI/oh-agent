#!/usr/bin/env node
// Production feature allocation, including renderer envelope and session ownership.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { layoutCity, inspectBlockPlacement, civicEnvelopeSize, GARDEN_MINIMUM_SIZE,
  DISTRICT_LANDMARK_ENVELOPE } = await loadCity({
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/planner/blockPlacement.ts": ["inspectBlockPlacement"],
  "engine/models/layoutPlacementGeometry.ts": ["civicEnvelopeSize", "GARDEN_MINIMUM_SIZE", "DISTRICT_LANDMARK_ENVELOPE"],
});
const makeModel = (count) => {
  const buildings = Array.from({ length: count }, (_, i) => ({ id: `session:${i}`, districtId: `district:${i % 4}`,
    height: 10 + i % 16, footprint: 7.2, startedAt: i * 1000 }));
  return { buildings, districts: [0, 1, 2, 3].map((i) => ({ id: `district:${i}`, label: `district:${i}`,
    sessionCount: buildings.filter((b) => b.districtId === `district:${i}`).length, anomaly: null })) };
};
function verify(layout, input) {
  const addresses = layout.districts.flatMap((district) => [...district.slots]);
  assert.equal(addresses.length, input.buildings.length);
  assert.equal(layout.sessionCapacity.status, "accounted");
  assert.equal(layout.sessionCapacity.requiredSessions, input.buildings.length);
  assert.equal(layout.sessionCapacity.assignedSessions, addresses.length);
  assert.equal(layout.sessionCapacity.unrepresentedSessions, 0);
  assert.equal(layout.sessionCapacity.totalAddresses, layout.sessionCapacity.reservedAddresses + layout.sessionCapacity.assignedSessions + layout.sessionCapacity.freeAddresses);
  const occupied = addresses.map(([, parcel]) => ({ x: parcel.x, z: parcel.z, radius: Math.hypot(parcel.width, parcel.depth) / 2 }));
  const environment = { roads: layout.roadEdges, sites: [...layout.publicSites, ...layout.landmarks.filter((s) => s.radius), ...occupied],
    highways: layout.highways, buildable: layout.terrain.buildable, terrainSampleBudget: 500000 };
  const blocks = new Map(layout.blocks.map((block) => [block.id, block]));
  const check = (block, footprint, label) => {
    assert.ok(block, `${label}: owning real face remains present`);
    const evidence = inspectBlockPlacement({ ...environment, block, footprint });
    assert.equal(evidence.ok, true, `${label}: ${evidence.reason}`);
  };
  for (const garden of layout.gardens) {
    assert.ok(garden.width >= GARDEN_MINIMUM_SIZE.width && garden.depth >= GARDEN_MINIMUM_SIZE.depth);
    check(blocks.get(garden.blockId), garden, garden.id);
  }
  for (const civic of layout.civics) check(blocks.get(civic.parcelId), { ...civic, ...civicEnvelopeSize(civic.kind, civic.width, civic.depth) }, civic.id);
  for (const landmark of layout.districtLandmarks) {
    const block = layout.blocks.find((block) => block.parcels.some((parcel) => parcel.id === landmark.parcelId));
    check(block, { ...landmark, ...DISTRICT_LANDMARK_ENVELOPE }, `district landmark ${landmark.districtId}`);
    assert.ok(addresses.every(([, parcel]) => parcel.blockId !== block.id), "17m skirt cannot consume another session address");
  }
  // 配套按城区规划（d4479f2a）：每个非空城区必有医院+学校，额外配套按本区 floor(会话数/45) 增长，总数到 max(30, 2·城区数) 为止。
  // 旧式 max(2, min(30, floor(全城会话/45))) 是全城口径，那次提交同步了 verify-city-district-services 却漏了这里（500 会话：16 ≠ 11）。
  const served = input.districts.filter((district) => district.sessionCount > 0);
  let expectedCivics = served.length * 2;
  for (const district of served) for (let i = 0; i < Math.floor(district.sessionCount / 45) && expectedCivics < Math.max(30, served.length * 2); i++) expectedCivics++;
  assert.equal(layout.placementReport.filter((entry) => entry.class === "garden").length, 4);
  assert.equal(layout.placementReport.filter((entry) => entry.class === "district-landmark").length, 4);
  assert.equal(layout.placementReport.filter((entry) => entry.class === "civic").length, expectedCivics);
  assert.equal(new Set(layout.placementReport.map((entry) => entry.id)).size, layout.placementReport.length);
  assert.deepEqual(layout.placementReport.filter((entry) => entry.status !== "placed"), []);
  assert.ok(layout.civics.length >= 10, "keep the existing civic coverage threshold");
  assert.ok(layout.placementBudget.spent <= layout.placementBudget.limit);
  assert.equal(layout.placementBudget.spent + layout.placementBudget.remaining, layout.placementBudget.limit);
  console.log(`Production layout placement: ${input.buildings.length} sessions, gardens=${layout.gardens.length}, district landmarks=${layout.districtLandmarks.length}, civics=${layout.civics.length}, shared terrain samples=${layout.placementBudget.spent}/${layout.placementBudget.limit}.`);
}
const firstInput = makeModel(500), first = layoutCity(firstInput); verify(first, firstInput);
const nextInput = makeModel(780), next = layoutCity(nextInput, first); verify(next, nextInput);
const current = new Map(next.districts.flatMap((district) => [...district.slots]));
for (const district of first.districts) for (const [id, parcel] of district.slots) {
  const retained = current.get(id);
  assert.ok(retained, `${id}: session address must remain present`);
  for (const field of ["id", "blockId", "x", "z", "yaw", "width", "depth"]) assert.equal(retained[field], parcel[field], `${id}: unchanged-world growth preserves actual address geometry`);
}
for (const civic of first.civics) {
  const retained = next.civics.find((entry) => entry.id === civic.id);
  assert.ok(retained, `${civic.id}: existing legal civic cannot silently disappear`);
  for (const field of ["districtId", "parcelId", "x", "z", "yaw", "width", "depth"]) assert.equal(retained[field], civic[field], `${civic.id}: preserve the actual prior pose/size, not only its block id`);
}
console.log("City layout placement: true faces, actual renderer proxies, all feature obligations, reserved session addresses and exact valid prior civic poses passed.");
