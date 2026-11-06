#!/usr/bin/env node
// Incremental 3D append: later session pages add buildings into the existing CityParts
// without remounting instanced meshes. Counts remounts vs appends across 500→4000 pages
// and times per-page append against a CityParts remount (static-city cache hit).
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { loadCity } from "./city-kit/index.mjs";
import { installCanvasShim } from "./city-kit/scene-hash.mjs";
import { sceneRows, GENERATED_AT } from "./city-kit/scene-parts.mjs";

installCanvasShim();
globalThis.window ??= globalThis;
globalThis.devicePixelRatio ??= 1;

const { buildCityModel, layoutCity, CityParts, occupantsCanAppend, MIAMI_COASTAL } = await loadCity({
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/cityParts.ts": ["CityParts", "occupantsCanAppend"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});

const SEED = 1927;
const WINDOW = { windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", truncated: false, generatedAt: GENERATED_AT };

function modelFor(count, planned) {
  return buildCityModel({ rows: sceneRows(count), findings: [], ...WINDOW, totalSessions: planned });
}

function assertStable(before, after, ids) {
  for (const id of ids) {
    const prev = before.byId[id], next = after.byId[id];
    assert.ok(prev, `missing previous occupancy for ${id}`);
    assert.ok(next, `lost occupancy for ${id}`);
    assert.equal(next.shaftPrimary, prev.shaftPrimary, `${id} shaftPrimary moved`);
    assert.equal(next.shaftUpper, prev.shaftUpper, `${id} shaftUpper moved`);
    assert.equal(next.podium, prev.podium, `${id} podium moved`);
    assert.equal(next.roof, prev.roof, `${id} roof moved`);
    assert.equal(next.facade, prev.facade, `${id} facade changed`);
    assert.equal(next.x, prev.x, `${id} parcel x moved`);
    assert.equal(next.z, prev.z, `${id} parcel z moved`);
  }
}

function pageCity(planned, pageSize) {
  CityParts.resetMountCounters();
  const first = modelFor(pageSize, planned);
  const tLayout0 = performance.now();
  let layout = layoutCity(first, null, SEED, MIAMI_COASTAL);
  const layoutMs = performance.now() - tLayout0;
  const tMount = performance.now();
  const parts = new CityParts(first, layout, null);
  parts.snapToTargets();
  const mountMs = performance.now() - tMount;
  const firstIds = first.buildings.filter((building) => layout.districts.some((district) => district.slots.has(building.id))).map((building) => building.id);
  const pick = firstIds[0] ?? null;
  if (pick) parts.setSelected(pick);
  const hover = firstIds[1] ?? pick;
  if (hover) parts.setHovered(hover);
  const groupUuid = parts.group.uuid;
  const snapshot0 = parts.occupancySnapshot();
  assert.equal(CityParts.constructCount, 1);
  assert.equal(CityParts.appendCount, 0);

  const pages = [];
  let model = first;
  for (let count = pageSize * 2; count <= planned; count += pageSize) {
    const next = modelFor(count, planned);
    const tLayout = performance.now();
    const nextLayout = layoutCity(next, layout, SEED, MIAMI_COASTAL);
    const layoutPageMs = performance.now() - tLayout;
    assert.equal(nextLayout.scaleTier, layout.scaleTier, "paging must not change island tier");
    assert.ok(occupantsCanAppend(model, next, layout, nextLayout), `page ${count} must be appendable`);
    assert.ok(parts.canAppend(next, nextLayout));
    const before = parts.occupancySnapshot();
    const tAppend = performance.now();
    const added = parts.appendOccupants(next, nextLayout);
    const appendMs = performance.now() - tAppend;
    parts.snapToTargets();
    const after = parts.occupancySnapshot();
    assert.equal(parts.group.uuid, groupUuid, "CityParts.group must not be replaced");
    assert.deepEqual(after.shaftUuids, snapshot0.shaftUuids, "shaft InstancedMesh identity must be kept");
    assertStable(before, after, Object.keys(before.byId));
    assert.ok(added > 0, `page ${count} should create new buildings`);
    assert.equal(after.runtimeCount, before.runtimeCount + added);
    if (pick) assert.equal(parts.selectedId, pick, "selection must survive append");
    if (hover) assert.equal(parts.hoveredId, hover, "hover must survive append");
    pages.push({ count, added, appendMs: Math.round(appendMs), layoutMs: Math.round(layoutPageMs) });
    model = next;
    layout = nextLayout;
  }
  assert.equal(CityParts.constructCount, 1, "paging must not remount CityParts");
  assert.equal(CityParts.appendCount, pages.length);

  const dropped = buildCityModel({
    rows: sceneRows(Math.max(pageSize, planned - pageSize)), findings: [], ...WINDOW, totalSessions: planned,
  });
  const droppedLayout = layoutCity(dropped, layout, SEED, MIAMI_COASTAL);
  assert.equal(occupantsCanAppend(model, dropped, layout, droppedLayout), false, "dropping occupants must remount");

  return { parts, layout, model, firstIds, snapshot0, pages, mountMs: Math.round(mountMs), layoutMs: Math.round(layoutMs) };
}

// Tight capacity: first page allocates to 40, later page must grow buffers in place.
{
  CityParts.resetMountCounters();
  const first = modelFor(40, 40);
  let layout = layoutCity(first, null, SEED, MIAMI_COASTAL);
  const parts = new CityParts(first, layout, null);
  const before = parts.occupancySnapshot();
  const next = modelFor(80, 80);
  const nextLayout = layoutCity(next, layout, SEED, MIAMI_COASTAL);
  assert.ok(parts.canAppend(next, nextLayout));
  const added = parts.appendOccupants(next, nextLayout);
  const after = parts.occupancySnapshot();
  assert.ok(added > 0);
  assert.deepEqual(after.shaftUuids, before.shaftUuids);
  assertStable(before, after, Object.keys(before.byId));
  assert.equal(CityParts.constructCount, 1);
  assert.equal(CityParts.appendCount, 1);
  console.log(`grow-in-place 40→80: added=${added} construct=${CityParts.constructCount} append=${CityParts.appendCount}`);
}

const paging = pageCity(4000, 500);

const remountModel = modelFor(1000, 4000);
const remountLayout = layoutCity(remountModel, paging.layout, SEED, MIAMI_COASTAL);
const tRemount = performance.now();
const remounted = new CityParts(remountModel, remountLayout, paging.parts.displaySnapshot());
remounted.snapToTargets();
const remountMs = performance.now() - tRemount;
assert.equal(CityParts.constructCount, 2, "revision/remount path still constructs a new CityParts");
assert.notEqual(remounted.group.uuid, paging.parts.group.uuid, "remount replaces the scene group");

const firstAppend = paging.pages[0];
console.log(JSON.stringify({
  planned: 4000,
  pageSize: 500,
  firstLayoutMs: paging.layoutMs,
  firstMountMs: paging.mountMs,
  pages: paging.pages,
  constructCount: 1,
  appendCount: paging.pages.length,
  finalRuntimes: paging.parts.occupancySnapshot().runtimeCount,
  remount1000Ms: Math.round(remountMs),
  append500to1000Ms: firstAppend?.appendMs ?? null,
  appendVsRemount: firstAppend ? Number((firstAppend.appendMs / remountMs).toFixed(3)) : null,
}, null, 2));
assert.ok(firstAppend, "500→4000 must produce at least one append page");
assert.ok(firstAppend.appendMs < remountMs, `append (${firstAppend.appendMs}ms) should be cheaper than remount (${Math.round(remountMs)}ms)`);
console.log("verify-react-city-append: ok");
