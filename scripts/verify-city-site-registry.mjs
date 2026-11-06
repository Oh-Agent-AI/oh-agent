import assert from "node:assert/strict";
import fs from "node:fs";
import { citySrc, loadCity } from "./city-kit/index.mjs";
const { SITE_CLASSES, siteClassOf, siteClassesForInstance, classifyLayoutSites, civicMinimumSize,
  GARDEN_MINIMUM_SIZE, DISTRICT_LANDMARK_ENVELOPE, describeDecor, CIVIC_LABELS, decorKindForName, decorDistrictId,
  siteClassesForMesh, decorAt, THREE } = await loadCity({
  "pkg:three": ["* as THREE"],
  "engine/systems/uiOverlays.ts": ["decorAt"],
  "engine/cityDecor.ts": ["describeDecor", "decorKindForName", "decorDistrictId"],
  "engine/models/registry.ts": ["CIVIC_LABELS"],
  "engine/models/siteClasses.ts": ["SITE_CLASSES", "siteClassOf", "siteClassesForInstance", "classifyLayoutSites", "siteClassesForMesh"],
  "engine/models/layoutPlacementGeometry.ts": ["civicMinimumSize", "GARDEN_MINIMUM_SIZE", "DISTRICT_LANDMARK_ENVELOPE"],
});
const catalogSource = fs.readFileSync(new URL("../apps/agent-city/ui/src/cityCatalog.ts", import.meta.url), "utf8");
const catalog = [...catalogSource.matchAll(/\{ id: "([^"]+)", group: "[^"]+", image: \w+, title: "([^"]+)", kind: "([^"]+)"/g)]
  .map(([, id, title, kind]) => ({ id, title, kind }));
assert.equal(catalog.length, 31, "catalog extraction must cover the actual declared table");
assert.equal(new Set(SITE_CLASSES.map(item => item.id)).size, SITE_CLASSES.length);
for (const item of SITE_CLASSES) {
  assert(item.pendingCapabilities.length > 0, "metadata cannot certify undeclared instance geometry");
  if (item.catalogId === null) assert(item.noCatalogReason.length >= 10);
  else {
    const entry = catalog.find(row => row.id === item.catalogId); assert(entry, item.id);
    if (item.family !== "data") assert.equal(item.title, entry.title, item.id);
  }
  assert.equal(siteClassOf(`decor:${item.id}#instance:with:colons`), item);
}
for (const entry of catalog) assert.equal(SITE_CLASSES.filter(item => item.catalogId === entry.id || item.additionalCatalogIds?.includes(entry.id)).length, 1, entry.id);
assert.equal(siteClassOf("decor:site:station").id, "public:station");
assert.equal(siteClassOf("decor:civic:school").id, "civic:school");
assert.equal(siteClassOf("decor:unknown"), null);
assert.equal(siteClassOf("decor:landmark:unknown"), null);
const layout = { civics: ["school", "mall", "hospital"].map(kind => ({ kind })), gardens: [{}], districtLandmarks: [{}], contextBuildings: [{}],
  landmarks: SITE_CLASSES.filter(item => item.family === "landmark").map(item => ({ kind: item.id.slice("landmark:".length) })),
  publicSites: ["civic", "station", "stadium", "park", "tower", "harbor"].map(kind => ({ kind })) };
for (const row of classifyLayoutSites(layout)) assert.equal(row.classes.length, 1, JSON.stringify(row));
assert.equal(siteClassesForInstance("publicSites", { kind: "future-kind" }).length, 0);
for (const kind of ["school", "mall", "hospital"]) assert.deepEqual(siteClassOf(`civic:${kind}`).placement.minimumSize(), civicMinimumSize(kind));
assert.deepEqual(siteClassOf("garden").placement.minimumSize(), GARDEN_MINIMUM_SIZE);
assert.deepEqual(siteClassOf("district-landmark").placement.minimumSize(), DISTRICT_LANDMARK_ENVELOPE);
assert.equal(siteClassOf("district-landmark").placement.mode, "face-reserve");
for (const kind of ["school", "mall", "hospital"]) {
  const declaration = siteClassOf(`civic:${kind}`);
  assert.equal(CIVIC_LABELS[kind], declaration.title);
  assert.equal(describeDecor(`decor:civic:${kind}`).title, declaration.title);
}
for (const kind of ["station", "stadium", "park", "tower", "harbor"]) assert.equal(describeDecor(`decor:site:${kind}`).title, siteClassOf(`public:${kind}`).title);
for (const [legacy, classId] of [["backdrop", "context"], ["garden", "garden"], ["massing", "scenery:massing"], ["seaside", "scenery:seaside"], ["volcano", "scenery:volcano"]])
  assert.equal(describeDecor(`decor:${legacy}`).title, siteClassOf(classId).title);
assert.equal(describeDecor("decor:site:civic").title, "市政设施", "legacy municipal overview is not a named instance");
assert.equal(describeDecor("decor:site:unknown").title, "市政设施");
assert.equal(describeDecor("decor:civic:unknown").title, "城市配套");
assert.equal(describeDecor("decor:unknown"), null);
for (const item of SITE_CLASSES) for (const pattern of item.meshNames) {
  const name = pattern.endsWith("*") ? pattern.slice(0, -1) + "fixture" : pattern;
  const matches = siteClassesForMesh(name);
  assert(matches.length > 0, name);
  assert.equal(new Set(matches.map(item => item.family)).size, 1, "merged mesh names may only share one family");
  assert.equal(new Set(matches.map(item => item.meshRoutes?.[name] ?? item.decorKind)).size, 1, "merged mesh route must be unambiguous");
  assert.equal(decorKindForName(name), item.meshRoutes?.[name] ?? item.decorKind);
}
assert.equal(decorKindForName("city-landmark-twisting-deco-tower"), "landmark:twisting-deco-tower");
assert.equal(siteClassesForMesh("city-landmark-twisting-deco-tower")[0].id, "landmark:twist-tower");
assert.equal(siteClassOf("decor:landmark:twisting-deco-tower").id, "landmark:twist-tower");
assert.equal(siteClassOf("decor:backdrop").id, "context");
assert.equal(siteClassOf("decor:civic"), null, "a merged family is not an exact class");
assert.equal(describeDecor("decor:landmark:twisting-deco-tower").title, "扭转装饰艺术塔");
assert.equal(decorKindForName("city-landmark-district:harness:zcode"), "district-landmark");
assert.equal(decorKindForName("city-landmark-unknown"), null);
assert.equal(decorKindForName("city-session-hotel"), null);
for (const id of ["decor:landmark:district:harness:zcode", "decor:district-landmark#district-landmark:harness:zcode"]) {
  assert.equal(decorDistrictId(id), "harness:zcode");
  assert.equal(siteClassOf(id).id, "district-landmark");
  assert.equal(describeDecor(id).title, siteClassOf("district-landmark").title);
  assert.equal(describeDecor(id).category, "城区地标 · 随规模出现");
}
assert.equal(decorDistrictId("decor:landmark:district:"), null);
assert.equal(decorDistrictId("decor:civic:school#civic:42"), null);
assert.deepEqual(describeDecor("decor:civic:school#civic:42"), describeDecor("decor:civic:school"));
const mesh = new THREE.Mesh(); mesh.name = "city-civic-boxes";
const host = { layout: { civics: [{ id: "civic:42", kind: "school" }], districtLandmarks: [{ districtId: "harness:zcode" }] },
  civicMeshes: [mesh], civicPieces: [{ civic: 0, mesh: 0, index: 4 }] };
assert.equal(decorAt(host, mesh, 4), "decor:civic:school#civic:42");
assert.equal(decorAt(host, mesh, 5), "decor:civic");
assert.equal(decorAt({ ...host, civicPieces: [...host.civicPieces, ...host.civicPieces] }, mesh, 4), "decor:civic");
const districtGroup = new THREE.Group(); districtGroup.name = "city-landmark-district:harness:zcode";
const child = new THREE.Mesh(); districtGroup.add(child);
assert.equal(decorAt(host, child), "decor:district-landmark#district-landmark:harness:zcode");
assert.equal(decorAt({ ...host, layout: { ...host.layout, districtLandmarks: [] } }, child), "decor:district-landmark");
assert.equal(decorAt({ ...host, layout: { ...host.layout, districtLandmarks: [...host.layout.districtLandmarks, ...host.layout.districtLandmarks] } }, child), "decor:district-landmark");
mesh.geometry.dispose(); child.geometry.dispose(); mesh.material.dispose(); child.material.dispose();
const source = fs.readFileSync(`${citySrc}/engine/models/siteClasses.ts`, "utf8");
assert(!/from\s+["'][^"']*(?:planRepair|planSites|planSitePolicy|three)[^"']*["']/.test(source), "pure generator declarations only");
assert(!/(?:width|depth):\s*\d/.test(source), "placement dimensions must derive from renderer declarations");
console.log("City site registry: metadata/catalog/titles, declared minimums, merged-family routes, exact civic/district mesh identities and legacy district selection passed; instance geometry/pick-height/full-scene/editor coverage remain pending.");
