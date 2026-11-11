import { buildCityModel } from './src/cityModel.ts';
import { layoutCity } from './src/engine/cityLayout.ts';
import { MIAMI_COASTAL } from './src/engine/citySeaside.ts';
import { terrainSurfaceHeight } from './src/engine/surface/terrainSampling.ts';
import { groundRoadClearance } from './src/engine/surface/roadClearance.ts';
import { ROAD_SURFACE_LIFT } from './src/engine/surface/groundRoadCompiler.ts';
import { anchorsFromCity, siteFightShapes, cellWorld } from './src/game/mecha/citySite.ts';

const now = Date.UTC(2026, 9, 7), day = 86400000;
const rows = Array.from({length: 80}, (_, i) => ({
  session_ref: `s:${i}`, harness: i % 2 ? 'harness:claude' : 'harness:zcode', title: null, title_source: null,
  first_event_at: new Date(now - day * 20 + i * 3600000).toISOString(), last_event_at: new Date(now - day * 20 + (i + 2) * 3600000).toISOString(), event_count: 10, model_ids: [],
  tokens: {uncached_input_tokens: 50000 + i * 900000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total: 50000 + i * 900000}, peak_tokens: 50000 + i * 900000,
  cost_minor: null, cost_status: {state: 'unavailable' as const, reason: 'test', has_unresolved: false},
}));
const model = buildCityModel({rows, findings: [], windowStartMs: now - 30 * day, windowEndMs: now, windowLabel: '30d', totalSessions: rows.length, truncated: false, generatedAt: now});
for (const seed of Array.from({length: 100}, (_, index) => index + 1)) {
  const layout = layoutCity(model, null, seed, MIAMI_COASTAL, 'off');
  const catalog = siteFightShapes(layout.terrain, anchorsFromCity(layout, model), layout.roadEdges);
  for (const [shape, site] of Object.entries(catalog)) {
    if (shape !== 'ridge' || !site) continue;
    const terrain = (x: number, z: number) => terrainSurfaceHeight(layout, x, z);
    const height = (x: number, z: number) => terrain(x, z) + (groundRoadClearance(layout.roadEdges, x, z, 0) < 0 ? ROAD_SURFACE_LIFT : 0);
    let centerError = 0, interpolationError = 0, planeError = 0, roadSamples = 0, samples = 0, grade = 0;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      if (!['land', 'road'].includes(site.terrain[y]![x]!)) continue;
      if (site.blocked.some(p => p.x === x && p.y === y) || site.buildings.some(b => b.cells.some(p => p.x === x && p.y === y))) continue;
      const a = cellWorld(site, {x, y});
      centerError = Math.max(centerError, Math.abs(height(a.x, a.z) - a.y));
      for (const [nx, ny] of [[x+1,y], [x,y+1]]) {
        if (nx! >= 10 || ny! >= 10 || !['land','road'].includes(site.terrain[ny!]![nx!]!)) continue;
        if (site.blocked.some(p => p.x === nx && p.y === ny) || site.buildings.some(b => b.cells.some(p => p.x === nx && p.y === ny))) continue;
        const b = cellWorld(site, {x: nx!, y: ny!});
        for (let i = 0; i <= 10; i++) {
          const t = i / 10, px = a.x + (b.x-a.x)*t, pz = a.z + (b.z-a.z)*t;
          const base = height(px,pz), radius = 2;
          const dx = (height(px+radius,pz)-height(px-radius,pz))/(2*radius), dz = (height(px,pz+radius)-height(px,pz-radius))/(2*radius);
          grade = Math.max(grade, Math.hypot(dx,dz));
          interpolationError = Math.max(interpolationError, Math.abs(base-(a.y+(b.y-a.y)*t)));
          for (const ox of [-2,0,2]) for (const oz of [-2,0,2]) planeError = Math.max(planeError, Math.abs(height(px+ox,pz+oz) - (base+dx*ox+dz*oz)));
          if (groundRoadClearance(layout.roadEdges, px, pz, 0) < 0) roadSamples++;
          samples++;
        }
      }
    }
    console.log(JSON.stringify({seed,shape,samples,roadSamples,centerError,interpolationError,planeError,maxGrade:grade,units:'world units; road approximated using carriageway clearance'}));
  }
}
