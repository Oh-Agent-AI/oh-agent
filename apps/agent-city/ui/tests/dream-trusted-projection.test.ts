import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { prepareDreamSnapshotForPublication, validateDreamCandidate } from "../src/remote/city/dreamTrustedProjection.ts";
import { parseDreamCitySnapshot } from "../src/remote/city/dreamSnapshotContract.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../desktop/src-tauri/tests/fixtures/${name}`, import.meta.url), "utf8"));

function completeCandidate() {
  const data = Object.assign({}, fixture("dream-city-geometry-synthetic.json"), fixture("dream-city-road-graph-synthetic.json"),
    fixture("dream-city-parcels-synthetic.json"), fixture("dream-city-facilities-synthetic.json"), fixture("dream-city-coast-synthetic.json"),
    { districts: fixture("dream-city-districts-synthetic.json") });
  const visual = fixture("dream-city-visual-synthetic.json");
  const model = fixture("dream-city-anonymous-model-synthetic.json");
  return {
    schema: "dream-city-snapshot:v2", revision: 1,
    snapshot: { model, layout: { schema: "remote-city-layout:v1", revision: 1, generatorVersion: 1, seed: 74031,
      backdrop: "off", camera: { position: [100, 120, 80], target: [0, 0, 0], up: [0, 1, 0], fov: 50 }, data } },
    display: visual.display, palettes: visual.palettes, heroBuildingId: visual.heroBuildingId,
  };
}

function aliases(value: unknown, ids = new Set<string>()): Set<string> {
  if (typeof value === "string" && /^(?:district|building|entity|hotel:entity|oceandrive:entity)-/.test(value)) ids.add(value);
  else if (Array.isArray(value)) value.forEach(item => aliases(item, ids));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => {
    if (/^(?:district|building|entity|hotel:entity|oceandrive:entity)-/.test(key)) ids.add(key);
    aliases(item, ids);
  });
  return ids;
}

test("trusted TypeScript projector validates the complete shared Rust fixture", () => {
  const candidate = completeCandidate();
  assert.doesNotThrow(() => validateDreamCandidate(candidate));
});

test("trusted projector rejects private fields and dangling references at nested levels", () => {
  const cases = [
    (value: any) => { value.snapshot.layout.data.private = "secret"; },
    (value: any) => { value.snapshot.layout.data.districts[0].slots.__remoteMap[0][1].private = "secret"; },
    (value: any) => { value.snapshot.layout.data.roadEdges[0].to = "entity-999999"; },
    (value: any) => { value.snapshot.layout.data.gardens[0].blockId = "entity-999999"; },
    (value: any) => { value.snapshot.model.rows.push({ id: "building-0001", title: "private" }); },
    (value: any) => { value.display.buildings[0].cost = 5; },
    (value: any) => { value.display.buildings[0].title = "Session sk-abcdefghij0123456789"; },
  ];
  for (const mutate of cases) {
    const invalid = structuredClone(completeCandidate()); mutate(invalid);
    assert.throws(() => validateDreamCandidate(invalid));
  }
});

test("publication projection rekeys every entity and reference per publication and gzip round-trips", async () => {
  const source = completeCandidate();
  source.snapshot.layout.data.parkTrees = [{ x: 12.3456789, z: -34.5678912, y: 2.345678, seed: 0.123456789 }];
  const original = structuredClone(source);
  const first = await prepareDreamSnapshotForPublication(source);
  const second = await prepareDreamSnapshotForPublication(source);
  assert.match(first.envelope.schema, /^dream-city-gzip:v1$/);
  assert.ok(first.envelope.plainBytes > 0 && first.envelope.plainBytes <= 4 * 1024 * 1024);
  assert.ok(new TextEncoder().encode(JSON.stringify(first.envelope)).byteLength <= 230 * 1024);
  const plain = gunzipSync(Buffer.from(first.envelope.data, "base64"));
  assert.equal(plain.byteLength, first.envelope.plainBytes);
  const decoded = parseDreamCitySnapshot(plain);
  validateDreamCandidate(decoded);
  const sourceIds = aliases(source), firstIds = aliases(first.candidate), secondIds = aliases(second.candidate);
  assert.ok(sourceIds.size > 0);
  assert.equal([...firstIds].some(id => sourceIds.has(id)), false);
  assert.equal([...secondIds].some(id => sourceIds.has(id)), false);
  assert.equal([...firstIds].some(id => secondIds.has(id)), false);
  assert.ok([...firstIds].every(id => /^[a-z:]+-\d{8}$/.test(id)), "published entity aliases use compact random decimal IDs");
  assert.match(first.candidate.snapshot.layout.data.coastalConfigKey, /^dream-publication-[a-f0-9]{32}$/,
    "publication cache key remains 128-bit");
  const data = first.candidate.snapshot.layout.data as any;
  assert.deepEqual(data.parkTrees[0], { x: 12.35, z: -34.57, y: 2.35, seed: 0.123457 },
    "static tree decorations keep centimeter placement and six-digit deterministic variation");
  const pointValues: number[] = [];
  const collectPoints = (value: any, parentKey = "") => {
    if (Array.isArray(value)) value.forEach(item => collectPoints(item, parentKey));
    else if (value && typeof value === "object") {
      if (parentKey !== "outward" && Object.keys(value).length === 2 && Object.hasOwn(value, "x") && Object.hasOwn(value, "z")) pointValues.push(value.x, value.z);
      else Object.entries(value).forEach(([key, item]) => collectPoints(item, key));
    }
  };
  collectPoints(data);
  assert.ok(pointValues.every(value => Math.abs(value * 1_000 - Math.round(value * 1_000)) < 1e-5), "published geometry points retain millimeter precision");
  const nodeIds = new Set(data.roadNodes.map((node: any) => node.id));
  assert.ok(data.roadEdges.every((edge: any) => nodeIds.has(edge.from) && nodeIds.has(edge.to)));
  const building = first.candidate.snapshot.model.buildings[0].id;
  assert.equal(first.candidate.heroBuildingId, building);
  assert.equal(first.candidate.display.buildings[0].id, building);
  assert.notEqual(first.candidate.snapshot.layout.data.coastalConfigKey, second.candidate.snapshot.layout.data.coastalConfigKey);
  assert.deepEqual(source, original, "projection must not mutate the caller's object");
});
