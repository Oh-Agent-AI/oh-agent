import assert from 'node:assert/strict';
import {loadCity} from './city-kit/index.mjs';
const {layoutCity}=await loadCity({'engine/cityLayout.ts':['layoutCity']});
for(const count of [12,280,700]) {
 const harnesses=['codex','claude-code','harness:zcode'];
 const buildings=Array.from({length:count},(_,i)=>({id:`session:${i}`,districtId:harnesses[i%3],height:8,footprint:7.2,startedAt:i*1000}));
 const model={buildings,districts:harnesses.map(id=>({id,label:id,sessionCount:buildings.filter(b=>b.districtId===id).length,anomaly:null}))};
 const layout=layoutCity(model);
 const occupied=new Set(layout.districts.flatMap(d=>[...d.slots.values()].map(p=>p.blockId)));
 for(const d of model.districts) for(const kind of ['hospital','school']) {
  const service=layout.civics.find(c=>c.id===`civic:${d.id}:${kind}`);
  assert(service,`${count}: ${d.id} missing ${kind}`);
  assert.equal(service.districtId,d.id);assert(!occupied.has(service.parcelId));
 }
 assert.equal(new Set(layout.civics.map(c=>c.parcelId)).size,layout.civics.length);
 console.log(`${count}: district hospitals/schools present, independent parcels`);
}
