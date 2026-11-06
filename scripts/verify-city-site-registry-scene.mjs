// Synthetic data only. Actual production scene/instances; no golden refresh,
// browser, physical envelope, placement success or editor readiness claim.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { installCanvasShim } from "./city-kit/scene-hash.mjs";
installCanvasShim(); globalThis.window ??= globalThis; globalThis.devicePixelRatio ??= 1;
const { buildCityModel, layoutCity, CityParts, MIAMI_COASTAL, classifyLayoutSites, siteClassesForMesh,
  decorKindForName, decorDistrictId, describeDecor } = await loadCity({
  "cityModel.ts": ["buildCityModel"], "engine/cityLayout.ts": ["layoutCity"], "engine/cityParts.ts": ["CityParts"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"], "engine/models/siteClasses.ts": ["classifyLayoutSites", "siteClassesForMesh"],
  "engine/cityDecor.ts": ["decorKindForName", "decorDistrictId", "describeDecor"],
});
// Independently retain pre-B2 routing (52faeefe), not the new registry's rules.
function legacyRoute(name) {
  if (name.startsWith("city-landmark-")) return `landmark:${name.slice("city-landmark-".length)}`;
  if (name.startsWith("city-civic-")) return "civic";
  if (name.startsWith("city-public-sites-")) return "site";
  if (name.startsWith("city-garden-")) return "garden";
  if (["city-vice-context-facades", "city-vice-context-rooftops"].includes(name)) return "backdrop";
  if (name === "city-massing") return "massing";
  if (["city-lifeguard-towers", "city-yachts", "city-beach-furniture", "city-beach-people", "city-volleyball-courts", "city-promenade-props", "city-marina"].includes(name)) return "seaside";
  if (name === "city-sea-volcano") return "volcano";
  return null;
}
const generatedAt = Date.UTC(2026, 9, 7, 12), harnesses = ["codex", "claude-code", "dsh", "harness:zcode"];
function modelFor(count) {
  const rows = Array.from({ length: count }, (_, index) => ({ session_ref: `session:${index}`, harness: harnesses[index % harnesses.length],
    first_event_at: new Date(generatedAt - (index + 1) * 60000).toISOString(), last_event_at: new Date(generatedAt - index * 60000).toISOString(),
    event_count: 10, model_ids: ["gpt-5"], tokens: { uncached_input_tokens: 2000, cache_read_tokens: 5000,
      cache_write_tokens: 1000, output_tokens: 2000, total: 10000 }, peak_tokens: 3000,
    cost_minor: { amount_minor: 10, currency: "USD", basis: "api_equivalent" }, cost_status: { state: "estimated", reason: "", has_unresolved: false } }));
  return buildCityModel({ rows, findings: [], windowStartMs: generatedAt - 30 * 86400000, windowEndMs: generatedAt,
    windowLabel: "30d", totalSessions: count, truncated: false, generatedAt });
}
for (const count of [380, 1600]) {
  const model = modelFor(count), layout = layoutCity(model, null, 1927, MIAMI_COASTAL, "full");
  const identities = new Set(), rows = classifyLayoutSites(layout), counts = {};
  for (const row of rows) {
    assert.equal(row.classes.length, 1, `${count}/${row.array}/${JSON.stringify(row.raw)}`);
    const id = row.array === "districtLandmarks" ? `district-landmark:${row.raw.districtId}` : row.raw.id;
    assert.equal(typeof id, "string"); assert(id.length); assert(!identities.has(id), `duplicate layout identity: ${id}`); identities.add(id);
    counts[row.array] = (counts[row.array] ?? 0) + 1;
  }
  for (const array of ["civics", "gardens", "districtLandmarks", "contextBuildings", "landmarks", "publicSites"]) assert(counts[array] > 0, `${array} must not be vacuous`);
  const parts = new CityParts(model, layout, null);
  try {
    for (const night of [0, 1]) {
      parts.setNightGlow(night); parts.applySelfLit(0.24);
      const legacyMeshes = [], currentMeshes = [], routes = new Map();
      parts.group.traverse(mesh => {
        if (!mesh.isMesh || !mesh.visible) return;
        let previous = null, current = null;
        for (let node = mesh; node; node = node.parent) {
          previous ??= legacyRoute(node.name); current ??= decorKindForName(node.name);
          if (decorKindForName(node.name)) {
            const matches = siteClassesForMesh(node.name);
            assert.equal(new Set(matches.map(item => item.family)).size, 1, node.name);
          }
        }
        if (previous) legacyMeshes.push(mesh);
        if (current) { currentMeshes.push(mesh); routes.set(mesh, current); }
        if (previous?.startsWith("landmark:district:")) assert.equal(current, "district-landmark");
        else assert.equal(current, previous, `unexpected real mesh route change: ${mesh.name}`);
      });
      assert(currentMeshes.length > 0); assert.deepEqual(currentMeshes, legacyMeshes);
      assert.deepEqual(parts.decorTargets, currentMeshes);
      let civicPieces = 0, districts = 0, playableCars = 0;
      for (const piece of parts.civicPieces) {
        const civic = layout.civics[piece.civic]; assert(civic);
        const id = parts.decorAt(parts.civicMeshes[piece.mesh], piece.index);
        assert.equal(id, `decor:civic:${civic.kind}#${civic.id}`); assert.equal(describeDecor(id).title, describeDecor(`decor:civic:${civic.kind}`).title);
        civicPieces++;
      }
      for (const [mesh, route] of routes) if (route === "district-landmark") {
        const id = parts.decorAt(mesh);
        // 地标停车场里那辆可开的车（2026-10-22）点出来是「开这辆」（play:car:<区>），不是地标说明；它也必须属于一个真实城区。
        const district = id.startsWith("play:car:") ? id.slice("play:car:".length) : decorDistrictId(id);
        if (id.startsWith("play:car:")) playableCars++;
        assert(layout.districtLandmarks.some(item => item.districtId === district)); districts++;
      }
      assert(civicPieces > 0 && districts > 0);
      assert(playableCars > 0, "every landmark lot parks a drivable car that picks as play:car:<district>");
      // 机坪上的飞机（机场岛存在时）：点它的任何一个网格都是 play:plane，不是「机场岛」说明。
      let planeMeshes = 0;
      parts.group.getObjectByName("city-playable-plane")?.traverse((node) => { if (node.isMesh && node.visible) { assert.equal(parts.decorAt(node), "play:plane"); planeMeshes++; } });
      if (parts.group.getObjectByName("city-landmark-airport")) assert(planeMeshes > 0, "the airport parks a flyable plane");
      // 机坪上的三台机甲：点任何一块网格都是 play:mecha，不是「机场岛」说明。
      let mechaMeshes = 0;
      parts.group.getObjectByName("city-playable-mecha")?.traverse((node) => { if (node.isMesh && node.visible) { assert.equal(parts.decorAt(node), "play:mecha"); mechaMeshes++; } });
      if (parts.group.getObjectByName("city-landmark-airport")) assert(mechaMeshes > 0, "the airport parks a mecha squad");
      console.log(JSON.stringify({ count, night, classifiedInstances: identities.size, counts, pickableMeshes: currentMeshes.length, civicPieces, districtMeshes: districts, playableCars, mechaMeshes,
        scope: "actual scene classification/identity; model footprint/height and browser/editor validation pending" }));
    }
  } finally { parts.dispose(); }
}
console.log("City site registry scenes: 380/1600 full-backdrop × day/night instance classification, unchanged pickable mesh set and civic/district identity passed.");

// Retire filler hotels, not the real sessions using seaside parcels.
{
  const model=modelFor(280);
  const auto=layoutCity(model,null,74031,MIAMI_COASTAL,"auto");
  const off=layoutCity(model,null,74031,MIAMI_COASTAL,"off");
  const addresses=layout=>layout.districts.flatMap(d=>[...d.slots.entries()].map(([id,slot])=>[id,slot.id,slot.x,slot.z])).sort((a,b)=>a[0].localeCompare(b[0]));
  assert.deepEqual(addresses(auto),addresses(off),"background settings never remove or relocate sessions");
  const coastal=auto.districts.flatMap(d=>[...d.slots.entries()]).filter(([,slot])=>/^(hotel:|oceandrive:)/.test(slot.blockId));
  assert(coastal.length>0,"fixture must include actual coastal sessions");
  for(const layout of [auto,off]){
    const parts=new CityParts(model,layout,null);
    try{
      parts.group.traverse(mesh=>assert(!mesh.name.startsWith("city-ocean-drive-"),"no retired decorative row in any background mode"));
      for(const [id] of coastal){
        assert(parts.anchorFor(id),"coastal sessions retain their identity/anchor");
        assert(parts.shaftIdByInstance.some(map=>[...map.values()].includes(id)),"coastal sessions remain selectable data buildings");
      }
    }finally{parts.dispose();}
  }
  console.log(`Retired Ocean Drive filler: absent in auto/off; ${coastal.length} coastal sessions retain addresses, anchors and picking.`);
}
