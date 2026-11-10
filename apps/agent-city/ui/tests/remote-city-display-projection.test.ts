import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { selectVisualHero, type CityModel } from "../src/cityModel.ts";
import { layoutCity } from "../src/engine/cityLayout.ts";
import { MIAMI_COASTAL } from "../src/engine/citySeaside.ts";
import { captureCityVisualHero, captureCityVisualPalettes, createCityDisplayProjector, createCitySnapshotProjector, hydrateRemoteCityLayout } from "../src/remote/city/cityDisplayProjection.ts";
import { paletteFor } from "../src/engine/cityTextures.ts";
import { decodeDreamSnapshot, encodeDreamSnapshot } from "../src/remote/city/dreamSnapshotCodec.ts";
import { createDreamSnapshotCandidate } from "../src/remote/city/dreamSnapshotCandidate.ts";
import { parseDreamCitySnapshot } from "../src/remote/city/dreamSnapshotContract.ts";
import { prepareRemoteCityDisplay, validateRemoteCityDisplay } from "../src/remote/city/trustedRemoteCityDisplay.ts";

function fixture(): CityModel {
  return {
    districts: [{ id: "private-district", label: "Codex", sessionCount: 1, tokensTotal: 42, activeCount: 1, anomaly: null }],
    buildings: [{ id: "private-session-id", assetRef: "private-asset", districtId: "private-district", archetype: "tower", facade: 1, seed: 0.5, tokensTotal: 42, height: 8, footprint: 3, startedAt: 100, endedAt: null, active: true, builtFraction: 0.5, busyness: 0.2, aggregated: false, extraCount: 0 }],
    rows: new Map([["private-session-id", { title: "My session", title_source: "codex_thread_name", session_ref: "private-session-id", model_ids: ["private-model"], cost_minor: { amount_minor: 1 } } as never]]),
    generatedAt: 0, windowStartMs: 0, windowEndMs: 1, windowLabel: "private-window", stats: { renderedSessions: 1, aggregatedSessions: 0, totalSessions: 1, tokensTotal: 42, activeCount: 1, truncated: false },
  };
}
const site = {
  originX: 0, originZ: 0, yaw: 0, cellW: 1, cellD: 1,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land")),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: [], blocked: [], mechs: [{ id: "Assault", pos: { x: 0, y: 8 } }, { id: "Gunner", pos: { x: 1, y: 8 } }, { id: "Support", pos: { x: 2, y: 8 } }],
  boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
} as never;

const camera = {
  position: [100, 120, 80], target: [0, 0, 0], up: [0, 1, 0], fov: 50,
  controls: { minDistance: 1, maxDistance: 1000, enablePan: true, zoomToCursor: false, orbitLockedId: null },
} as const;

const model = fixture();
const layout = layoutCity(model, null, 74031, MIAMI_COASTAL, "off");
const project = createCityDisplayProjector(74031, site, layout, "off", camera as never);

test("city display projection includes approved labels and excludes local identifiers and extra data", () => {
  const result = project(model);
  assert.equal(result.model.rows[0].title, "My session");
  assert.equal(result.model.buildings[0].tokensTotal, 42);
  assert.equal(result.model.buildings[0].districtId, result.model.districts[0].id);
  for (const forbidden of ["private-session-id", "private-asset", "private-district", "private-model", "private-window", "cost_minor"]) assert.equal(JSON.stringify(result).includes(forbidden), false, forbidden);
  assert.equal(result.model.buildings[0].startedAt, 1, "original timestamp is replaced with an ordinal");
});

test("trusted City display adapter rejects tampering and assigns opaque aliases", () => {
  const display = minimalRemoteDisplay();
  const prepared = prepareRemoteCityDisplay(display);
  validateRemoteCityDisplay(prepared);
  assert.match(prepared.model.districts[0].id, /^district-[a-f0-9]{32}$/);
  assert.equal(prepared.layout.data.districts[0].id, prepared.model.districts[0].id);
  assert.notEqual(prepared.model.districts[0].id, prepareRemoteCityDisplay(display).model.districts[0].id, "each handoff receives fresh aliases");
  assert.throws(() => validateRemoteCityDisplay({ ...prepared, secret: "must-not-cross-boundary" }), /remote_projection_invalid/);
  assert.throws(() => validateRemoteCityDisplay({ ...prepared, model: { ...prepared.model, buildingIds: ["raw-session-id"] } }), /remote_projection_invalid/);
});

test("trusted City display adapter reports the projection size limit explicitly", () => {
  const display = minimalRemoteDisplay();
  display.layout.data.roadNodes = Array.from({ length: 50_000 }, () => null);
  assert.throws(() => validateRemoteCityDisplay(display), /remote_city_too_large/);
  assert.throws(() => prepareRemoteCityDisplay(display), /remote_city_too_large/);
});

function minimalRemoteDisplay() {
  const keys = ["scaleTier", "biome", "core", "islandRadius", "seed", "districts", "blocks", "roadNodes", "roadEdges", "activityKey", "coastRoads", "culDeSacEnds", "junctionRings", "highwayRamps", "districtLandmarks", "terrain", "extent", "coast", "river", "publicSites", "parkTrees", "urbanBounds", "bridges", "boatLanes", "boundsRadius", "decorMountains", "districtAnchors", "highways", "massing", "civics", "landmarks", "seaside", "airport", "coastalConfigKey", "coastalConfig", "contextBuildings", "gardens", "boatLoops", "seaMountains"];
  const data: Record<string, unknown> = Object.fromEntries(keys.map(key => [key, null]));
  Object.assign(data, {
    scaleTier: 1, biome: "tropical", core: { x: 0, z: 0 }, islandRadius: 100, seed: 7,
    districts: [{ id: "district-0001", label: "Test district", center: { x: 0, z: 0 }, radius: 1,
      terrain: { __remoteTerrain: { center: { x: 0, z: 0 }, radius: 100, hasRiver: false } }, slots: { __remoteMap: [] }, grounds: { __remoteMap: [] },
      carPaths: [], river: null, riverHalfWidth: 0, trees: [], plaza: { x: 0, y: 0, z: 0 }, anomaly: null, sessionCount: 0, landValue: { __remoteMap: [] }, roads: [] }],
    blocks: [], roadNodes: [], roadEdges: [], activityKey: "remote-layout-7-1",
    terrain: { __remoteTerrain: { center: { x: 0, z: 0 }, radius: 100, hasRiver: false } }, extent: 100,
  });
  return {
    schema: "remote-city-display:v2", seed: 7,
    model: { districts: [{ id: "district-0001", label: "Test district", sessionCount: 0, tokensTotal: 0, activeCount: 0, anomaly: null }], buildings: [],
      stats: { renderedSessions: 0, aggregatedSessions: 0, totalSessions: 0, tokensTotal: 0, activeCount: 0, truncated: false }, rows: [] },
    layout: { schema: "remote-city-layout:v1", revision: 1, generatorVersion: 1, seed: 7, backdrop: "off",
      camera: { position: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0], fov: 50 }, data },
  };
}

test("shared city snapshot does not require a mecha arena and matches the handoff projection", () => {
  const snapshot = createCitySnapshotProjector(74031, layout, "off", camera as never)(model);
  const handoff = project(model);
  assert.deepEqual(snapshot.layout, handoff.layout);
  assert.deepEqual(snapshot.model, handoff.model);
  assert.equal("site" in snapshot, false);
  assert.throws(() => createCitySnapshotProjector(74032, layout, "off", camera as never), /remote_city_seed_mismatch/);
});

test("dream palettes are independent of local harness identity", () => {
  const source = { ...model, districts: [{ ...model.districts[0], id: "codex" }],
    buildings: model.buildings.map(building => ({ ...building, districtId: "codex" })) };
  const sourceLayout = layoutCity(source, null, 74031, MIAMI_COASTAL, "off");
  const snapshot = createCitySnapshotProjector(74031, sourceLayout, "off", camera as never)(source);
  const palettes = captureCityVisualPalettes(source, snapshot);
  assert.notEqual(snapshot.model.districts[0].id, "codex");
  assert.deepEqual(palettes[0].palette, paletteFor("dream-anonymous"));
  assert.equal(palettes[0].landmarkHeight, 36);
  assert.equal(palettes[0].flagShare, 1);
  assert.notDeepEqual(palettes[0].palette, paletteFor("codex"), "Dream must not reveal the harness palette");
});

test("Dream flag shares and landmark heights do not encode district activity", () => {
  const source = { ...model, districts: [
    { ...model.districts[0], id: "codex", sessionCount: 3 },
    { ...model.districts[0], id: "dsh", sessionCount: 1 },
  ] };
  const projected = { ...project(model), model: { ...project(model).model, districts: [
    { ...project(model).model.districts[0], id: "district-0001", sessionCount: 0 },
    { ...project(model).model.districts[0], id: "district-0002", sessionCount: 0 },
  ] } };
  const visuals = captureCityVisualPalettes(source, projected);
  assert.deepEqual(visuals.map(item => item.flagShare), [0.5, 0.5]);
  assert.deepEqual(visuals.map(item => item.landmarkHeight), [36, 36]);
});

test("Dream hero crown follows a deterministic placed location, not usage or time", () => {
  const base = model.buildings[0];
  const source = { ...model, buildings: [
    { ...base, id: "z-first", startedAt: 100, tokensTotal: 200 },
    { ...base, id: "a-second", startedAt: 100, tokensTotal: 200 },
    { ...base, id: "unplaced", startedAt: 101, tokensTotal: 900 },
  ] };
  const slot = layout.districts[0].slots.get(base.id)!;
  const scene = { ...layout, districts: layout.districts.map(district => ({
    ...district, slots: new Map([["z-first", slot], ["a-second", slot]]),
  })) };
  const snapshot = createCitySnapshotProjector(74031, scene, "off", camera as never)(source);
  const heroId = captureCityVisualHero(source, scene, snapshot);
  assert.equal(heroId, snapshot.model.buildings[1].id, "the placed tie resolves from its opaque spatial order");
  const reordered = { ...source, buildings: source.buildings.map((building, index) => ({ ...building, startedAt: 10_000 - index * 1_000, tokensTotal: index * 900 })) };
  const reorderedSnapshot = createCitySnapshotProjector(74031, scene, "off", camera as never)(reordered);
  assert.equal(captureCityVisualHero(reordered, scene, reorderedSnapshot), heroId, "usage and timestamps cannot move the Dream crown");
  assert.equal(selectVisualHero(source.buildings)?.id, "unplaced", "unmodified local models still use their highest token total");
});

test("local dream candidate keeps renderer model anonymous and adds bounded display projection", () => {
  const candidate = createDreamSnapshotCandidate(model, layout, "off", camera as never);
  assert.ok(candidate.revision > 0);
  assert.equal(candidate.snapshot.layout.revision, candidate.revision, "local capture revision must agree across the candidate contract");
  if (process.env.DREAM_CANDIDATE_SAMPLE) writeFileSync(process.env.DREAM_CANDIDATE_SAMPLE, JSON.stringify(candidate));
  const coastKeys = ["coastalConfigKey", "coastalConfig", "seaside", "publicSites", "landmarks", "roadNodes"];
  const coastFixture = JSON.parse(readFileSync(new URL("../../../desktop/src-tauri/tests/fixtures/dream-city-coast-synthetic.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.fromEntries(coastKeys.map(key => [key, candidate.snapshot.layout.data[key]])), coastFixture);
  const geometry = ["scaleTier", "biome", "core", "islandRadius", "seed", "terrain", "extent", "coast", "river", "parkTrees", "urbanBounds", "bridges", "boatLanes", "boundsRadius", "decorMountains", "districtAnchors", "highways", "coastRoads", "culDeSacEnds", "junctionRings", "highwayRamps", "boatLoops", "seaMountains"];
  const geometryFixture = JSON.parse(readFileSync(new URL("../../../desktop/src-tauri/tests/fixtures/dream-city-geometry-synthetic.json", import.meta.url), "utf8"));
  delete geometryFixture.activityKey;
  assert.deepEqual(Object.fromEntries(geometry.map(key => [key, candidate.snapshot.layout.data[key]])), geometryFixture);
  assert.match(candidate.snapshot.layout.data.activityKey, /^dream-publication-[a-f0-9]{32}$/);
  assert.equal(candidate.snapshot.layout.data.activityKey.includes(String(candidate.snapshot.layout.data.seed)), false,
    "Dream cache identity must not disclose the source seed");
  const secondCandidate = createDreamSnapshotCandidate(model, layout, "off", camera as never);
  assert.notEqual(secondCandidate.snapshot.layout.data.activityKey, candidate.snapshot.layout.data.activityKey,
    "each candidate receives a publication-local cache identity");
  assert.deepEqual(secondCandidate.snapshot.layout.data.coast, candidate.snapshot.layout.data.coast,
    "changing the cache identity does not alter generated city geometry");
  const data = candidate.snapshot.layout.data;
  const facilities = Object.fromEntries(["massing", "civics", "contextBuildings", "gardens", "districtLandmarks"].map(key => [key, data[key]]));
  const facilityFixture = JSON.parse(readFileSync(new URL("../../../desktop/src-tauri/tests/fixtures/dream-city-facilities-synthetic.json", import.meta.url), "utf8"));
  assert.deepEqual(facilities, facilityFixture);
  const shared = JSON.parse(readFileSync(new URL("../../../desktop/src-tauri/tests/fixtures/dream-city-anonymous-model-synthetic.json", import.meta.url), "utf8"));
  assert.deepEqual(candidate.snapshot.model, shared, "the browser projection must match the Rust validator fixture");
  const parsed = parseDreamCitySnapshot(new TextEncoder().encode(JSON.stringify(candidate)));
  assert.equal(parsed.snapshot.model.districts[0].label, "城区 1");
  assert.equal(parsed.snapshot.model.districts[0].tokensTotal, 0);
  assert.equal(parsed.snapshot.model.districts[0].sessionCount, 0);
  assert.equal(parsed.snapshot.model.buildings[0].tokensTotal, 0);
  assert.equal(parsed.snapshot.model.buildings[0].active, false);
  assert.equal(parsed.snapshot.model.buildings[0].builtFraction, 1);
  assert.equal(parsed.snapshot.model.buildings[0].startedAt, 1);
  assert.equal(parsed.snapshot.model.buildings[0].height, model.buildings[0].height);
  assert.equal(parsed.snapshot.model.rows.length, 0);
  assert.equal(candidate.snapshot.model.rows.length, 0);
  assert.equal(candidate.display.schema, "agent-city-display:v1");
  assert.deepEqual(candidate.display.city, { sessionCount: 1, activeCount: 1, tokensTotal: 42, truncated: false });
  assert.equal(candidate.display.buildings[0].title, "My session");
  assert.equal(candidate.display.buildings[0].titleSource, "codex_thread_name");
  assert.equal(candidate.display.buildings[0].tokensTotal, 42);
  assert.equal(candidate.display.buildings[0].id, candidate.snapshot.model.buildings[0].id);
  assert.equal(candidate.display.districts[0].tokensTotal, 42);
  assert.equal(candidate.heroBuildingId, candidate.snapshot.model.buildings[0].id);
  assert.deepEqual(candidate.palettes, captureCityVisualPalettes(model, project(model)));
  assert.equal(JSON.stringify(candidate.snapshot.model).includes("My session"), false);
  const remoteDistrict = (candidate.snapshot.layout.data.districts as Array<{ label: string; sessionCount: number }>)[0];
  assert.equal(remoteDistrict.label, "城区 1");
  assert.equal(remoteDistrict.sessionCount, 0);
  assert.equal(model.buildings[0].tokensTotal, 42, "candidate creation must not mutate the desktop model");
  assert.equal(layout.districts[0].sessionCount, 1, "candidate creation must not mutate the applied desktop layout");
});

test("visitor contract accepts publication-local opaque entity aliases", () => {
  const candidate = structuredClone(createDreamSnapshotCandidate(model, layout, "off", camera as never));
  const aliasPattern = /^(?:district|building)-\d{4,8}$/;
  const ids = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string" && aliasPattern.test(value)) ids.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => { if (aliasPattern.test(key)) ids.add(key); collect(item); });
  };
  collect(candidate);
  const aliases = new Map([...ids].map((id, index) => [id, `${id.slice(0, id.indexOf("-") + 1)}${(index + 1).toString(16).padStart(32, "0")}`]));
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") return aliases.get(value) ?? value;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [aliases.get(key) ?? key, replace(item)]));
    return value;
  };
  const opaque = replace(candidate);
  const parsed = parseDreamCitySnapshot(new TextEncoder().encode(JSON.stringify(opaque)));
  assert.match(parsed.snapshot.model.districts[0].id, /^district-[a-f0-9]{32}$/);
  assert.match(parsed.snapshot.model.buildings[0].id, /^building-[a-f0-9]{32}$/);
  assert.equal(parsed.snapshot.model.buildings[0].districtId, parsed.snapshot.model.districts[0].id);
});

test("candidate strips usage and timestamps from background geometry", () => {
  const extra = { ...layout,
    massing: [{ districtId: "private-district", x: 1, z: 2, y: 0, count: 733, tokens: 987654321, height: 12 }],
    contextBuildings: [{ id: "background-private", x: 3, z: 4, y: 0, yaw: 0, width: 5, depth: 6, height: 7, seed: 0.5, zone: "residential" as const, appearAt: 1700000000000 }],
    civics: [{ id: "civic-private", districtId: "private-district", parcelId: "parcel-private", kind: "school" as const, x: 5, z: 6, y: 0, yaw: 0, width: 5, depth: 6, unlockAt: 700 }],
  };
  const candidate = createDreamSnapshotCandidate(model, extra, "off", camera as never);
  const mass = (candidate.snapshot.layout.data.massing as Array<{ count: number; tokens: number; height: number }>)[0];
  assert.deepEqual([mass.count, mass.tokens, mass.height], [0, 0, 12]);
  assert.equal((candidate.snapshot.layout.data.contextBuildings as Array<{ appearAt: number }>)[0].appearAt, 0);
  assert.equal((candidate.snapshot.layout.data.civics as Array<{ unlockAt: number }>)[0].unlockAt, 0);
  assert.equal(extra.massing[0].tokens, 987654321, "scrubbing must not mutate the desktop layout");
});

test("city layout does not expose district findings", () => {
  const withFinding = {
    ...layout,
    districts: layout.districts.map(district => ({ ...district, anomaly: { severity: "critical" as const, count: 7 } })),
  };
  const result = createCitySnapshotProjector(74031, withFinding, "off", camera as never)(model);
  assert.equal(result.model.districts[0].anomaly, null);
  assert.equal(hydrateRemoteCityLayout(result.layout).districts[0].anomaly, null);
});

test("snapshot statistics only include approved display fields", () => {
  const extendedModel = {
    ...model,
    stats: { ...model.stats, privateExtra: "private-statistic" },
  };
  const result = project(extendedModel);
  assert.equal(JSON.stringify(result).includes("private-statistic"), false);
  assert.deepEqual(Object.keys(result.model.stats).sort(), [
    "activeCount", "aggregatedSessions", "renderedSessions", "tokensTotal", "totalSessions", "truncated",
  ]);
});

test("airport causeway and road graph use the same local aliases", () => {
  const originalNode = layout.roadNodes[0];
  assert.ok(originalNode);
  const withAirport = {
    ...layout,
    airport: {
      shore: { x: 0, z: 0 }, centre: { x: 100, z: 100 }, yaw: 0, outward: { x: 0, z: 1 },
      causeway: { from: { x: originalNode.x, z: originalNode.z }, fromNode: originalNode.id, to: { x: 100, z: 100 } },
    },
  };
  const result = createCitySnapshotProjector(74031, withAirport, "off", camera as never)(model);
  const restored = hydrateRemoteCityLayout(result.layout);
  const fromNode = restored.airport?.causeway?.fromNode;
  assert.ok(fromNode);
  assert.notEqual(fromNode, originalNode.id);
  assert.ok(restored.roadNodes.some(node => node.id === fromNode));
});

test("merged parcel references are anonymous and remain consistent", () => {
  const district = layout.districts[0];
  const slot = district.slots.get("private-session-id")!;
  const modified = { ...layout, districts: layout.districts.map(item => item.id === district.id
    ? { ...item, slots: new Map([["private-session-id", { ...slot, mergedWith: "private-parcel-merge" }]]) } : item) };
  const result = createCitySnapshotProjector(74031, modified, "off", camera as never)(model);
  assert.equal(JSON.stringify(result).includes("private-parcel-merge"), false);
  const restored = hydrateRemoteCityLayout(result.layout);
  const merge = restored.districts[0].slots.get(result.model.buildings[0].id)?.mergedWith;
  assert.match(merge ?? "", /^entity-\d{6}$/);
});

test("synthetic projected road graph keeps its endpoint references", t => {
  const { data } = project(model).layout;
  const nodes = data.roadNodes as Array<{ id: string }>;
  const edges = data.roadEdges as Array<{ from: string; to: string }>;
  const ids = new Set(nodes.map(node => node.id));
  const missing = edges.filter(edge => !ids.has(edge.from) || !ids.has(edge.to));
  assert.equal(missing.length, 0, `road graph contains ${missing.length} dangling edges`);
  t.diagnostic(`airport: ${layout.airport ? (layout.airport.causeway ? "connected" : "island only") : "absent"}`);
  const shared = JSON.parse(readFileSync(new URL("../../../desktop/src-tauri/tests/fixtures/dream-city-road-graph-synthetic.json", import.meta.url), "utf8"));
  assert.deepEqual({ roadNodes: nodes, roadEdges: edges, airport: data.airport }, shared, "the Rust validator must use the same synthetic graph and airport");
});

test("synthetic parcels match the Rust validation fixture", () => {
  const { data } = project(model).layout;
  const districtFixture = JSON.parse(readFileSync(new URL("../../../desktop/src-tauri/tests/fixtures/dream-city-districts-synthetic.json", import.meta.url), "utf8"));
  assert.deepEqual(createDreamSnapshotCandidate(model, layout, "off", camera as never).snapshot.layout.data.districts, districtFixture);
  const districts = (data.districts as Array<{ id: string; slots: unknown }>).map(item => ({ id: item.id, slots: item.slots }));
  const fixture = JSON.parse(readFileSync(new URL("../../../desktop/src-tauri/tests/fixtures/dream-city-parcels-synthetic.json", import.meta.url), "utf8"));
  assert.deepEqual({ blocks: data.blocks, districts }, fixture);
});

test("projected layout restores desktop building slots, roads and initial camera", t => {
  const result = project(model);
  const encoded = Buffer.from(JSON.stringify(result), "utf8");
  const compressed = gzipSync(encoded);
  t.diagnostic(`serialized city display: ${encoded.length} bytes, gzip: ${compressed.length} bytes`);
  assert.deepEqual(gunzipSync(compressed), encoded, "compression experiment must preserve every source byte");
  const restored = hydrateRemoteCityLayout(JSON.parse(JSON.stringify(result.layout)));
  const originalDistrict = layout.districts[0];
  const remoteDistrict = restored.districts[0];
  const original = originalDistrict.slots.get("private-session-id");
  const remote = remoteDistrict.slots.get(result.model.buildings[0].id);
  assert.ok(original);
  assert.ok(remote);
  assert.deepEqual([remote.x, remote.z, remote.yaw, remote.width, remote.depth], [original.x, original.z, original.yaw, original.width, original.depth]);
  assert.deepEqual(restored.roadEdges.map(edge => edge.points), layout.roadEdges.map(edge => edge.points));
  assert.deepEqual(result.layout.camera.position, camera.position);
  assert.deepEqual(result.layout.camera.target, camera.target);
  assert.equal(result.layout.camera.fov, camera.fov);
  for (const point of [original, ...layout.roadEdges.slice(0, 3).flatMap(edge => edge.points)]) {
    assert.ok(Math.abs(restored.terrain.height(point.x, point.z) - layout.terrain.height(point.x, point.z)) < 1e-8);
  }
});

test("synthetic city snapshot fits the bounded compressed message and restores its layout", async t => {
  const snapshot = createCitySnapshotProjector(74031, layout, "off", camera as never)(model);
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const envelope = await encodeDreamSnapshot(bytes);
  const fullMessage = { protocol: "app-remote:v1", appId: "city", sessionId: "s".repeat(80), capability: "city-dream:v1", type: "response", requestId: "r".repeat(80), result: { ok: true, snapshot: envelope } };
  const messageSize = new TextEncoder().encode(JSON.stringify(fullMessage)).length;
  t.diagnostic(`plain snapshot: ${bytes.length} bytes; complete compressed response: ${messageSize} bytes`);
  assert.ok(messageSize <= 256 * 1024, "complete message must fit the relay's current limit");
  const decoded = await decodeDreamSnapshot(envelope);
  assert.deepEqual(decoded, bytes);
  const restored = hydrateRemoteCityLayout(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)).layout);
  assert.deepEqual(restored.roadEdges.map(edge => edge.points), layout.roadEdges.map(edge => edge.points));
});
