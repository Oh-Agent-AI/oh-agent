import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { SITE_SPECS, specByKind, resolvePlanarAccess, planarAccessAtYaw, planarAccessPose, stationDoorFacesRoad, stationStadiumSetback, scoreTerms, frontStationsAndStadiums,
  buildPublicSites, stationEntranceLocal, stationHallLocal, THREE } = await loadCity({
  "engine/planner/sitespec.ts": ["SITE_SPECS", "specByKind"],
  "engine/models/siteAccess.ts": ["resolvePlanarAccess", "planarAccessAtYaw", "planarAccessPose"],
  "engine/planner/constraints.ts": ["stationDoorFacesRoad", "stationStadiumSetback"],
  "engine/planner/score.ts": ["scoreTerms"],
  "engine/planner/repairs.ts": ["frontStationsAndStadiums"],
  "engine/systems/civicSystem.ts": ["buildPublicSites"],
  "engine/models/publicSiteGeometry.ts": ["stationEntranceLocal", "stationHallLocal"],
  "pkg:three": ["* as THREE"],
});
const planFor = (site, points, gate) => ({ publicSites: [site], landmarks: [], blocks: [], core: { x: 0, z: 0 }, islandRadius: 400,
  scaleTier: 1, coast: [], coastRoadRunEnds: [], roadNodes: gate ? [{ id: "gate", ...gate }] : [],
  roadEdges: [{ id: "road", from: "a", to: "b", width: 8, bridge: false, points }], terrain: { height: () => 1.2 }, river: null });
for (const kind of ["station", "stadium"]) {
  const spec = specByKind(kind), resolved = resolvePlanarAccess(spec.planarAccess, spec.radius);
  assert.ok(resolved.ok);
  const site = { id: kind, kind, radius: spec.radius, x: 0, z: 0, yaw: 0 };
  const pose = planarAccessPose(resolved.access, site, { x: 0, z: -1 }, spec.radius + 8);
  site.yaw = pose.yaw;
  site.access = { nodeId: "gate", entranceId: resolved.access.entranceId, entranceEvidence: pose.door ? "model-position" : "plot-proxy",
    ...(pose.door ? { doorX: pose.door.x, doorZ: pose.door.z } : {}) };
  const plan = planFor(site, [{ x: -100, z: -80 }, { x: 100, z: -80 }], pose.gate);
  assert.equal(stationDoorFacesRoad.measure(plan).length, 0);
  assert.equal(scoreTerms(plan).doorAlignment, 1);
  const bad = { ...site, yaw: site.yaw + Math.PI };
  assert.equal(stationDoorFacesRoad.measure({ ...plan, publicSites: [bad] }).length, 1);
  assert.ok(scoreTerms({ ...plan, publicSites: [bad] }).doorAlignment < 0.01);
  const lied = { ...site, access: { ...site.access, entranceEvidence: pose.door ? "plot-proxy" : "model-position" } };
  assert.equal(stationDoorFacesRoad.measure({ ...plan, publicSites: [lied] }).length, 1);
  assert.equal(scoreTerms({ ...plan, publicSites: [lied] }).doorAlignment, 0);
  // Registration data alone supports a renamed ordinary capability; no planner branch is added.
  const alias = `${kind}-alias`;
  SITE_SPECS.push({ ...spec, kind: alias });
  try {
    const renamed = { ...site, kind: alias };
    assert.deepEqual(stationDoorFacesRoad.measure({ ...plan, publicSites: [renamed] }), stationDoorFacesRoad.measure(plan));
    assert.equal(scoreTerms({ ...plan, publicSites: [renamed] }).doorAlignment, scoreTerms(plan).doorAlignment);
    assert.equal(stationStadiumSetback.measure({ ...plan, publicSites: [renamed] }).length, stationStadiumSetback.measure(plan).length);
  } finally { SITE_SPECS.pop(); }
  const orientation = planarAccessAtYaw(resolved.access, site, site.yaw);
  assert.ok(orientation.outward.z < -0.99999);
}
// Bent road closest point is on an intermediate segment, not the endpoint chord.
const station = { id: "station", kind: "station", radius: 46, x: 0, z: 0, yaw: Math.PI };
const bent = planFor(station, [{ x: -100, z: 100 }, { x: -100, z: -60 }, { x: 100, z: -60 }, { x: 100, z: 100 }]);
assert.ok(scoreTerms(bent).doorAlignment > 0.99999);
assert.equal(stationDoorFacesRoad.measure(bent).length, 0);
const unknown = { ...station, kind: "unsupported", access: { nodeId: "gate", entranceId: "main", entranceEvidence: "model-position" } };
assert.equal(stationDoorFacesRoad.measure(planFor(unknown, bent.roadEdges[0].points, { x: 0, z: -60 })).length, 1);
assert.equal(scoreTerms(planFor(unknown, bent.roadEdges[0].points, { x: 0, z: -60 })).doorAlignment, 0);
// Offshore access is a different declared contract, never a land-owner escape hatch.
const offshore = { ...unknown, kind: "sail-opera", shore: { x: 0, z: -60 },
  access: { ...unknown.access, capability: "island-causeway" } };
assert.equal(stationDoorFacesRoad.measure(planFor(offshore, bent.roadEdges[0].points, offshore.shore)).length, 0);
const mislabeledLand = { ...unknown, access: { ...unknown.access, capability: "island-causeway" } };
assert.equal(stationDoorFacesRoad.measure(planFor(mislabeledLand, bent.roadEdges[0].points, { x: 0, z: -60 })).length, 1);
const undeclaredOffshore = { ...offshore, access: { ...offshore.access, capability: undefined } };
assert.equal(stationDoorFacesRoad.measure(planFor(undeclaredOffshore, bent.roadEdges[0].points, offshore.shore)).length, 1);
// Declaration defaults never authorize moving an already bound owner or a fixed instance.
const fixedSpec = { ...specByKind("station"), kind: "fixed-alias", mobility: "fixed" };
SITE_SPECS.push(fixedSpec);
try {
  const protectedSites = [{ ...station, access: { nodeId: "gate" } }, { ...station, kind: "fixed-alias" }, { ...station, kind: "unsupported" }];
  const before = JSON.stringify(protectedSites);
  const ctx = { publicSites: protectedSites, landmarks: [], blocks: [], ringRuns: [], height: () => 1.2, inRiver: () => false,
    network: { nodes: new Map(), edges: new Map([["road", bent.roadEdges[0]]]) } };
  assert.equal(frontStationsAndStadiums(ctx), 0);
  assert.equal(JSON.stringify(protectedSites), before);
} finally { SITE_SPECS.pop(); }
// Independent renderer evidence: inspect actual instanced hall/glazing matrices,
// not just the declaration and planner agreeing with each other's normal.
for (const radius of [20, 32, 46]) for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.73]) {
  const owner = { id: "station-geometry", kind: "station", x: 13, z: -17, radius, yaw };
  const host = { layout: { publicSites: [owner], terrain: { height: () => 1.2 } }, group: new THREE.Group(), disposables: [], nightLights: null,
    matrix: new THREE.Matrix4(), quaternion: new THREE.Quaternion(), euler: new THREE.Euler(),
    scaleVector: new THREE.Vector3(), positionVector: new THREE.Vector3(), color: new THREE.Color() };
  buildPublicSites(host);
  const boxes = host.group.getObjectByName("city-public-sites-boxes"), rows = [];
  for (let i = 0; i < boxes.count; i += 1) {
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
    boxes.getMatrixAt(i, matrix); matrix.decompose(position, quaternion, scale); rows.push({ matrix, position, scale });
  }
  const close = (a, b) => Math.abs(a - b) < 1e-4;
  const hall = rows.find(row => close(row.scale.y, 11) && close(row.scale.z, 7) && close(row.scale.x, radius * 1.3));
  assert.ok(hall, "the real renderer must contain the existing 11-high, 7-deep station hall");
  const localDoor = stationEntranceLocal(radius), access = resolvePlanarAccess(specByKind("station").planarAccess, radius);
  assert.ok(access.ok);
  const orientation = planarAccessAtYaw(access.access, owner, yaw);
  const door = new THREE.Vector3(orientation.door.x, 3.2, orientation.door.z);
  const window = rows.find(row => close(row.scale.y, 6.5) && close(row.scale.z, 0.15) &&
    Math.hypot(row.position.x - door.x, row.position.z - door.z) < 1e-4);
  assert.ok(window, "actual entrance glazing, rather than a centre proxy, must occupy the declared door position");
  assert.equal(localDoor.z, stationHallLocal(radius).centre.z + 3.55);
  const inverseHall = hall.matrix.clone().invert(), doorInHall = door.clone().applyMatrix4(inverseHall);
  assert.ok(doorInHall.z > 0.5, "door lies outside the actual hall's positive-z wall, even though its plot-local z is negative");
  const front = new THREE.Vector3(0, 0, 1).transformDirection(hall.matrix);
  const outward = new THREE.Vector3(orientation.outward.x, 0, orientation.outward.z);
  assert.ok(front.dot(outward) > 0.99999, "declared outward must match the actual rendered hall facade normal");
  for (const length of [0.1, 0.3, 1, 3, 7, 20]) {
    const q = door.clone().addScaledVector(outward, length).applyMatrix4(inverseHall);
    assert.ok(q.z > 0.5, "outward approach ray must not pass through station hall");
  }
  const wrongNormal = front.clone().negate();
  const wrongPoint = door.clone().addScaledVector(wrongNormal, 1).applyMatrix4(inverseHall);
  assert.ok(Math.abs(wrongPoint.x) < 0.5 && Math.abs(wrongPoint.z) < 0.5,
    "independent counterexample: legacy negative-z normal enters the real station hall");
  host.disposables.forEach(disposable => disposable.dispose());
}
console.log("City access capabilities: shared normals, model-position/proxy evidence, alias registration, bent polyline, unsupported binding and actual station hall/glazing outward geometry passed. This does not prove complete model foundation or vehicle access.");
