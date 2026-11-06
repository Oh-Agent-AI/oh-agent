#!/usr/bin/env node
// Real displayed layouts + accepted repair replay -> host snapshot identity and invalidation.
// Synthetic sessions only; no harness data or native user state.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { sessionModel } from "./city-kit/session-models.mjs";
const kit = await loadCity({
  "cityModel.ts": ["buildCityModel"], "engine/cityLayout.ts": ["layoutCity"],
  "engine/planPatch.ts": ["applyPlanPatch", "emptyPlanPatch", "edgeLocked"],
  "engine/surface/citySurfacePort.ts": ["CitySurfacePort"],
  "engine/surface/groundRoadCompiler.ts": ["compileGroundRoadSurface"],
});
const seeds = process.argv.includes("--matrix") ? [1,7,42,2026,65537] : [1];
let layouts = 0, repairs = 0;
for (const sessions of [0,90,500]) for (const seed of seeds) {
  const layout = kit.layoutCity(sessionModel(kit.buildCityModel,sessions),null,seed,null,"auto");
  // Short stubs can be rendered at the adjacent wider road's width even after an accepted
  // restyle. Use a real >30-unit ribbon here so this case exercises a changed visible surface.
  const length = (e) => e.points.slice(1).reduce((n,p,i)=>n+Math.hypot(p.x-e.points[i].x,p.z-e.points[i].z),0);
  const edge = layout.roadEdges.filter((e)=>!kit.edgeLocked(e)&&length(e)>30).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)[0];
  assert.ok(edge, `${sessions}/${seed}: editable road required`);
  const port = new kit.CitySurfacePort();
  const source = { layout, ground:kit.compileGroundRoadSurface(layout) };
  const original = await port.capture(source); assert.equal(original.status,"ready");
  let previous=original;
  for (const op of [{t:"restyle",edge:edge.id,width:edge.width===5?8:5},{t:"drop",edge:edge.id}]) {
    const patch = kit.emptyPlanPatch(layout.seed,layout.scaleTier); patch.roadOps=[op];
    const repaired=kit.applyPlanPatch(layout,patch);
    assert.deepEqual(repaired.stale,[], `${sessions}/${seed}/${op.t}: repair accepted`);
    assert.notEqual(repaired.layout.activityKey,layout.activityKey,"static geometry cache must not reuse the old road source");
    const current=await port.capture({layout:repaired.layout,ground:kit.compileGroundRoadSurface(repaired.layout)});
    assert.equal(current.status,"ready"); assert.notEqual(current.revision,original.revision);
    assert.notEqual(current.worldRevision,original.worldRevision);
    assert.equal(previous.readWorld(),null,"repair immediately invalidates previous source handles");
    assert.equal(current.readWorld().surface.revision,current.revision);
    if(op.t==="drop") assert.ok(current.readWorld().surface.patches.every((p)=>p.source.kind!=="road"||!JSON.parse(p.source.id).includes(edge.id)),"deleted road cannot survive in the captured geometry");
    previous=current; repairs++;
  }
  const restored=await port.capture(source);assert.equal(restored.worldRevision,original.worldRevision);
  assert.equal(original.readWorld(),null,"restoring identical content must not resurrect an earlier host lease");
  port.invalidate();assert.equal(restored.readWorld(),null);
  layouts++;
  console.log(`Surface repairs: ${sessions} synthetic sessions / seed ${seed}: restyle, delete, restore, old handles invalidated.`);
}
console.log(`Surface repairs: ${layouts} display layouts / ${repairs} accepted road repairs passed. Native rendering and building/landmark colliders remain separate checks.`);
