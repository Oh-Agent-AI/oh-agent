#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadCity } from "./city-kit/index.mjs";
import { groundSurfaceFixtures, groundGeometryDigest } from "./city-kit/ground-surface-fixtures.mjs";
const { extractMeshBoundaries, SurfaceStore, canonicalSurfaceBytes, compileGroundRoadSurface, buildGroundSurfaceSnapshot } = await loadCity({
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "engine/surface/SurfaceStore.ts": ["SurfaceStore", "canonicalSurfaceBytes"],
  "engine/surface/groundRoadCompiler.ts": ["compileGroundRoadSurface"],
  "engine/surface/buildGroundSnapshot.ts": ["buildGroundSurfaceSnapshot"],
});
const hash = async (bytes) => createHash("sha256").update(bytes).digest("hex");
const positions = new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2]);
const indices = new Uint32Array([0, 2, 1, 0, 3, 2]);
const square = extractMeshBoundaries(positions, indices);
assert.equal(square.status, "complete"); assert.equal(square.loops.length, 1); assert.equal(square.loops[0].hole, false);
assert.ok(square.loops[0].segments.every((s) => s === "closed"), "closed mesh boundaries are not inferred drivable portals");
const weld = extractMeshBoundaries(new Float32Array([0,0,0, 2,0,2, 2,0,0, 0,0,0, 0,0,2, 2,0,2]), new Uint32Array([0,1,2,3,4,5]));
assert.equal(weld.status, "complete"); assert.equal(weld.loops.length, 1); assert.equal(weld.loops[0].vertices.length, 4);
const ringPositions = new Float32Array([-2,0,-2, 2,0,-2, 2,0,2, -2,0,2, -1,0,-1, 1,0,-1, 1,0,1, -1,0,1]);
const ringIndices = [];
for (let i=0;i<4;i++) { const j=(i+1)%4; ringIndices.push(i,j+4,j, i,i+4,j+4); }
const ring = extractMeshBoundaries(ringPositions,new Uint32Array(ringIndices));
assert.equal(ring.status,"complete"); assert.equal(ring.loops.length,2); assert.equal(ring.loops.filter((l)=>l.hole).length,1);
assert.equal(extractMeshBoundaries(positions,new Uint32Array([0,2,1,0,2,1])).reason,"non-manifold");
assert.equal(extractMeshBoundaries(positions,new Uint32Array([0,1,2])).reason,"degenerate");
assert.equal(extractMeshBoundaries(positions,new Uint32Array([0,0,1])).reason,"degenerate");
assert.equal(extractMeshBoundaries(positions,new Uint32Array([0,99,1])).reason,"invalid-mesh");
const nonFinite = positions.slice(); nonFinite[0]=NaN;
assert.equal(extractMeshBoundaries(nonFinite,indices).reason,"invalid-mesh");
assert.equal(extractMeshBoundaries(positions,indices,{maxTriangles:1,maxBoundaryEdges:10,maxIntersectionTests:100}).reason,"budget");
assert.equal(extractMeshBoundaries(positions,indices,{maxTriangles:10,maxBoundaryEdges:3,maxIntersectionTests:100}).reason,"budget");
assert.equal(extractMeshBoundaries(positions,indices,{maxTriangles:10,maxBoundaryEdges:10,maxIntersectionTests:1}).reason,"budget");
// Two upward disconnected triangles overlap in XZ; they must not become two legal loops.
const overlap = new Float32Array([0,0,0, 3,0,0, 0,0,3, 1,0,-1, 4,0,2, 1,0,2]);
assert.equal(extractMeshBoundaries(overlap,new Uint32Array([0,2,1,3,5,4])).reason,"intersection");
// A long conforming strip has >700k disjoint boundary pairs. The default 200k
// budget must apply to sweep candidates, without increasing the budget or
// treating budget exhaustion as a manifold mesh. Exercise both sweep axes.
for(const swap of [false,true]) {
  const p=[],idx=[],count=600;
  for(let i=0;i<=count;i++)for(const x of [0,2])p.push(swap?i:x,0,swap?x:i);
  for(let i=0;i<count;i++) {
    const a=i*2,b=a+1,c=a+2,d=a+3;
    idx.push(...(swap?[a,b,c,b,d,c]:[a,c,b,b,c,d]));
  }
  const v=new Float32Array(p),tri=new Uint32Array(idx),boundary=extractMeshBoundaries(v,tri);
  assert.equal(boundary.status,"complete");assert.equal(boundary.loops.length,1);
  assert.equal(boundary.loops[0].vertices.length,2*(count+1));
  assert.equal(extractMeshBoundaries(new Float32Array([...p,1000000,0,1000000]),tri).status,"complete","unused vertices cannot skew the boundary sweep axis");
  assert.equal(extractMeshBoundaries(v,tri,{maxTriangles:100000,maxBoundaryEdges:4000,maxIntersectionTests:10}).reason,"budget");
}
let snapshot;
for (const [name,layout] of groundSurfaceFixtures()) {
  const compiled=compileGroundRoadSurface(layout);const digest=groundGeometryDigest(compiled.layers);
  const result=buildGroundSurfaceSnapshot(compiled);
  assert.equal(groundGeometryDigest(compiled.layers),digest,"snapshot builder cannot mutate renderer buffers");
  assert.equal(result.report.geometricallyEligibleLength,0);assert.equal(result.portals.length,0);
  assert.ok(result.report.issues.some((i)=>i.reason==="unsupported"));
  if(name==="straight")snapshot=result;
}
assert.ok(snapshot);
const store=new SurfaceStore(hash);
const original=structuredClone(snapshot);
const published=await store.publish(snapshot);assert.equal(published.status,"published");
assert.match(published.revision,/^surface-v1:sha256:[a-f0-9]{64}$/);
assert.equal((await new SurfaceStore().publish(original)).revision, published.revision, "local Web Crypto and Node SHA256 agree");
snapshot.patches[0].vertices[0]+=5;
const owned=store.read(published.revision);assert.equal(owned.patches[0].vertices[0],original.patches[0].vertices[0]);
owned.patches[0].vertices[0]+=7;assert.equal(store.read(published.revision).patches[0].vertices[0],original.patches[0].vertices[0]);
assert.equal(store.read("wrong-revision"),null);
const same=await store.publish({...original,revision:"caller-cannot-set-revision",patches:[...original.patches].reverse()});
assert.equal(same.revision,published.revision,"patch input order and caller revision do not affect content identity");
const materialOnly=structuredClone(original);materialOnly.renderBatches[0].materialKey="different-color";
assert.equal((await store.publish(materialOnly)).revision,published.revision,"presentation-only material change preserves geometry identity");
const changed=structuredClone(original);changed.patches[0].vertices[0]+=0.1;
assert.notEqual((await store.publish(changed)).revision,published.revision);
assert.equal(store.read(published.revision),null,"old handles cannot silently read new geometry");
const boundaryChanged=structuredClone(original);boundaryChanged.patches[0].boundaryLoops[0].segments[0]="curb";
assert.notEqual(await hash(canonicalSurfaceBytes(boundaryChanged)),await hash(canonicalSurfaceBytes(original)));
await assert.rejects(new SurfaceStore(hash,1).publish(original),/surface-store-budget/);
const invalid=structuredClone(original);invalid.patches[0].indices[0]=999999;
await assert.rejects(store.publish(invalid),/invalid-surface-index/);
const invalidPortal=structuredClone(original);invalidPortal.portals=[{id:"p",fromPatch:original.patches[0].id,toPatch:original.patches[1].id,fromBoundary:{loop:99,firstSegment:0,segmentCount:1},toBoundary:{loop:0,firstSegment:0,segmentCount:1},clearance:3,maxHeightMismatch:0.1,permittedDirection:"both",validated:false}];
await assert.rejects(store.publish(invalidPortal),/invalid-portal-span/);
let resolveCaptured;
const captured = new SurfaceStore((bytes) => new Promise((resolve) => { resolveCaptured = async () => resolve(await hash(bytes)); }));
const mutable = structuredClone(original); const capturing = captured.publish(mutable);
mutable.patches[0].vertices[0] += 100;
await resolveCaptured(); assert.equal((await capturing).revision, published.revision, "snapshot is captured before awaiting hash");
let resolveSlow;let calls=0;
const concurrent=new SurfaceStore((bytes)=>++calls===1?new Promise((resolve)=>{resolveSlow=async()=>resolve(await hash(bytes));}):hash(bytes));
const slow=concurrent.publish(original);const fast=await concurrent.publish(changed);await resolveSlow();
assert.equal((await slow).status,"stale");assert.equal(concurrent.revision,fast.revision);
let resolveCleared;
const cleared=new SurfaceStore((bytes)=>new Promise((resolve)=>{resolveCleared=async()=>resolve(await hash(bytes));}));
const pending=cleared.publish(original);cleared.clear();await resolveCleared();assert.equal((await pending).status,"stale");assert.equal(cleared.revision,null);
console.log("Surface store: manifold loops/holes, exact welding, invalid/intersecting meshes, budgets, SHA256 content identity, defensive copies, stale read/publication and clear-during-hash passed.");
if (process.argv.includes("--cities")) {
  const { cachedPlan } = await import("./city-kit/index.mjs");
  const { createCityPlan } = await loadCity({ "engine/cityPlan.ts": ["createCityPlan"] });
  for (const seed of [1, 7, 42, 2026, 65537]) for (const tier of [1, 2, 3]) {
    const plan = cachedPlan(createCityPlan, seed, tier);
    const compiled = compileGroundRoadSurface(plan);
    const before = groundGeometryDigest(compiled.layers);
    const snapshot = buildGroundSurfaceSnapshot(compiled);
    assert.equal(groundGeometryDigest(compiled.layers), before);
    assert.equal(snapshot.portals.length, 0); assert.equal(snapshot.report.geometricallyEligibleLength, 0);
    const publication = await new SurfaceStore(hash).publish(snapshot);
    assert.equal(publication.status, "published");
    const unresolved = snapshot.report.issues.filter((issue) => issue.reason !== "unsupported");
    console.log(`Surface snapshot: seed ${seed}, tier ${tier}, ${snapshot.patches.length} patches, ${unresolved.length} unresolved piece boundaries, ${publication.encodedBytes} encoded bytes; no portals certified.`);
  }
}
