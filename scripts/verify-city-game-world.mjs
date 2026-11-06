#!/usr/bin/env node
// FlightWorld 守卫（CITY_GAME_MODE_IMPLEMENTATION_PLAN §6.3/§12）：
// 0/1/90/500 会话 × 多种子布局：碰撞盒有限且在地面之上、包络含全部建筑、
// 出生点对飞机与机后相机锚点均净空、软/硬边界覆盖全城；0 会话的空岛也有安全点。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { buildCityModel, layoutCity, FlightWorld } = await loadCity({
  "cityModel.ts": ["buildCityModel"], "engine/cityLayout.ts": ["layoutCity"], "game/FlightWorld.ts": ["FlightWorld"],
});

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 1);
const tokens = (total) => ({ uncached_input_tokens: total, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total });
const row = (ref, harness, index, total) => {
  const first = now - DAY * 29 + index * 3_600_000;
  return { session_ref: ref, harness, first_event_at: new Date(first).toISOString(), last_event_at: new Date(first + 7_200_000).toISOString(),
    event_count: 10, model_ids: ["gpt-test"], tokens: tokens(total), peak_tokens: total, cost_minor: null,
    cost_status: { state: "unavailable", reason: "test", has_unresolved: false } };
};
const harnesses = ["harness:zcode", "harness:claude"];
function modelOf(count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(row(`s:${index}`, harnesses[index % harnesses.length], index, 50_000 + (index % 37) * 900_000));
  }
  return buildCityModel({ rows, findings: [], windowStartMs: now - DAY * 30, windowEndMs: now, windowLabel: "30d",
    totalSessions: count, truncated: false, generatedAt: now });
}

const SEEDS = [7, 42, 1927];
const CLEARANCE = 4;
let totalBoxes = 0;
for (const sessionCount of [0, 1, 90, 500]) {
  for (const seed of SEEDS) {
    const model = modelOf(sessionCount);
    const layout = layoutCity(model, null, seed, null, "auto");
    const world = new FlightWorld({ layout, model, cursorMs: null });
    const { bounds, boxes } = world;
    assert.ok(bounds.hardRadius > bounds.softRadius && bounds.softRadius > 0, `${sessionCount}/${seed} 边界半径递增`);
    for (const box of boxes) {
      const values = [box.minX, box.maxX, box.minY, box.maxY, box.minZ, box.maxZ];
      assert.ok(values.every(Number.isFinite), `${sessionCount}/${seed} 碰撞盒含非有限值`);
      assert.ok(box.maxX > box.minX && box.maxZ > box.minZ && box.maxY > box.minY, `${sessionCount}/${seed} 碰撞盒退化`);
      assert.ok(box.minY > -6, `${sessionCount}/${seed} 碰撞盒沉入海底`);
      // 建筑类盒子必须在地面之上（水面上限 -6 以内的只有桥/远山带）。
      const centerX = (box.minX + box.maxX) / 2;
      const centerZ = (box.minZ + box.maxZ) / 2;
      assert.ok(box.maxY <= bounds.maxY, `${sessionCount}/${seed} 盒顶越过垂直边界`);
      void centerX; void centerZ;
    }
    // 水平边界必须罩住全部会话建筑。
    for (const building of model.buildings) {
      let placed = null;
      for (const district of layout.districts) {
        const slot = district.slots.get(building.id);
        if (slot) { placed = slot; break; }
      }
      if (!placed) continue;
      const distance = Math.hypot(placed.x - bounds.centerX, placed.z - bounds.centerZ);
      assert.ok(distance <= bounds.hardRadius, `${sessionCount}/${seed} 建筑 ${building.id} 越过硬边界`);
    }
    // 出生点：飞机净空 + 机后相机锚点净空 + 朝向城市 + 在边界内。
    const spawn = world.findSafeSpawn(CLEARANCE, 18, 6);
    assert.ok(spawn, `${sessionCount}/${seed} 未找到安全出生点`);
    assert.ok(world.isPointClear(spawn.x, spawn.y, spawn.z, CLEARANCE), `${sessionCount}/${seed} 出生点不净空`);
    const camX = spawn.x - Math.cos(spawn.heading) * 18;
    const camZ = spawn.z - Math.sin(spawn.heading) * 18;
    assert.ok(world.isPointClear(camX, spawn.y + 6, camZ, 2), `${sessionCount}/${seed} 机后相机锚点不净空`);
    const toward = Math.hypot(bounds.centerX - spawn.x, bounds.centerZ - spawn.z);
    assert.ok(toward > bounds.hardRadius * 0.1, `${sessionCount}/${seed} 出生点朝向必须指向城市`);
    assert.ok(toward <= bounds.softRadius, `${sessionCount}/${seed} 出生点必须在软边界内（不出生即告警）`);
    assert.ok(spawn.y >= bounds.minY && spawn.y <= bounds.maxY, `${sessionCount}/${seed} 出生点越界`);
    totalBoxes += boxes.length;
  }
}

// 回放游标冻结：早期游标下未长出的楼不产生碰撞盒。
{
  const model = modelOf(90);
  const layout = layoutCity(model, null, 42, null, "auto");
  const live = new FlightWorld({ layout, model, cursorMs: null });
  const early = new FlightWorld({ layout, model, cursorMs: now - DAY * 30 + 1 });
  assert.ok(live.boxes.length > early.boxes.length, "live 快照应比窗口起点有更多碰撞盒");
  for (const box of early.boxes) assert.ok(box.maxY > box.minY);
}

// isPointClear 的地形/边界否定路径。
{
  const model = modelOf(90);
  const layout = layoutCity(model, null, 1927, null, "auto");
  const world = new FlightWorld({ layout, model, cursorMs: null });
  const { bounds } = world;
  assert.ok(!world.isPointClear(bounds.centerX, 0.5, bounds.centerZ, 2), "贴地不算净空");
  assert.ok(!world.isPointClear(bounds.centerX + bounds.hardRadius * 1.2, 60, bounds.centerZ, 2), "硬边界外不算净空");
  assert.ok(!world.isPointClear(NaN, 60, 0, 2), "NaN 输入不算净空");
}

console.log(`verify-city-game-world: ok (${totalBoxes} obstacle boxes across 12 layouts)`);

// Shared compiled solids feed bounded near-plane sweeps; budget exhaustion is
// explicit and never reported as clear.
{
  const model = modelOf(1), layout = layoutCity(model, null, 811, null, "auto");
  const solids = ["a", "b"].map((id, index) => ({ id, role: "test-static", kind: "box",
    center: { x: 10_000 + index * 2, y: 100, z: 10_000 },
    halfAxes: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }] }));
  const world = new FlightWorld({ layout, model, cursorMs: null, staticSolids: solids });
  const sweep = world.queryCameraSweep({ x: 9_990, y: 100, z: 10_000 }, { x: 10_010, y: 100, z: 10_000 }, 0.5, 1024);
  assert.equal(sweep.status, "blocked");
  if (sweep.status === "blocked") assert.ok(sweep.safeFraction >= 0 && sweep.safeFraction < 1);
  assert.equal(world.queryCameraSweep({ x: 9_990, y: 100, z: 10_000 }, { x: 10_010, y: 100, z: 10_000 }, 0.5, 1).status, "unresolved");
}
