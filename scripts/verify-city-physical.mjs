#!/usr/bin/env node
// 模型物理声明守卫（CITY_MODEL_PHYSICAL_INVARIANTS_SPEC §6 批 A）：
// 1) 工厂自洽：合法声明通过；非法输入逐项拒绝（NaN/非正尺寸/非凸或绕序矛盾/未规范化 outward/部件超限/重复入口 id…）
// 2) 深只读与确定性：嵌套修改抛错；两次构造深度相等；CW 输入被规范化为 CCW
// 3) 注册纪律：BUILDING_MODELS 每个模型要么携带 physical、要么登记 PHYSICAL_PENDING，不同时；待声明条数只减不增（批 A = 3）
// 4) 声明↔几何比对（spec §4，构建期）：编译产物经 onPart（§4.5 唯一变换通道）取逐件包络——
//    触地件 XY 四边形 ⊆ footprint ∪ foundation.support（精确边覆盖判定，无采样）；
//    上层悬挑件 XY ⊆ footprint ∪ 运动包络投影 + 悬挑余量；旋转件 8 角点对轴线径距 ⊆ 某 envelope，
//    且每个 envelope 至少被一个输入的几何接近用满（防空声明）；
//    footprint 面积 ≤ K × 触地件 XY 面积和（防过量声明粗筛，K 记录在容差表）
// 5) 必测反例（spec §7/§9）：横跨拱门开口的四边形被并集正确拒绝、被凸包等价矩形误接受——并集判定不得用凸包替代
// 批 A 边界（显式）：不检查地形/道路/邻接关系（场景守卫职责）；sail-opera 岸型（siting.shore）留批 D，本守卫只测陆侧输入；
// instanced 件的包络未实现，遇到即失败（不静默跳过）。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { installCanvasShim } from "./city-kit/scene-hash.mjs";

installCanvasShim();
const { THREE, BUILDING_MODELS, PHYSICAL_PENDING, declarePhysical, quadInFootprint, pointInRegion, regionArea, footprintAreaSum, MAX_FOOTPRINT_PARTS, MAX_CONVEX_VERTICES, compileBuilding, createMaterialFactory } = await loadCity({
  "pkg:three": ["* as THREE"],
  "engine/models/registry.ts": ["BUILDING_MODELS", "PHYSICAL_PENDING"],
  "engine/models/physical.ts": ["declarePhysical", "quadInFootprint", "pointInRegion", "regionArea", "footprintAreaSum", "MAX_FOOTPRINT_PARTS", "MAX_CONVEX_VERTICES"],
  "engine/render/buildingCompiler.ts": ["compileBuilding"],
  "engine/render/landmarkMaterials.ts": ["createMaterialFactory"],
});

/** 容差表（spec §3.2「容差按尺度标定、版本化」）：v1 首批标定，调整必须改版本号并在提交说明记录依据。 */
const TOL = {
  v: 1,
  groundTouchY: 0.5,       // 触地判定的 y 阈值（批 A 高度二分；完整高度段包络是后续批）
  overhangMargin: 2.0,     // 上层悬挑允许超出 footprint 的余量
  areaRatio: 1.6,          // footprint 面积 / 触地件面积和 的上限（粗筛，非证明）
  motionReachSlack: 2.0,   // envelope 「被用满」判定的接近阈值
};
const quadMargin = (w, d) => Math.max(0.02 * Math.max(w, d), 0.1); // 包含判定的按尺度余量（2% 或 0.1 下限）
const BATCH_A_DECLARED = ["arch", "sail-opera", "ferris-wheel"];

// ———— 1/2. 工厂自洽 + 深只读 + 确定性（负例矩阵） ————
const goodRaw = () => ({
  modelId: "test-hall", modelRevision: "A1",
  footprint: { parts: [
    { shape: "rect", center: { x: 0, z: 0 }, width: 20, depth: 10 },
    { shape: "circle", center: { x: 14, z: 0 }, radius: 3 },
    { shape: "convex", vertices: [{ x: -14, z: -3 }, { x: -10, z: -3 }, { x: -10, z: 3 }, { x: -14, z: 3 }] },
  ] },
  foundation: { kind: "ground", support: { parts: [{ shape: "rect", center: { x: 0, z: 0 }, width: 20, depth: 10 }] }, maxRelief: 1, maxGap: 0.2, maxEmbed: 0.5, baseOffset: 0 },
  entrances: [
    { id: "main", local: { x: 0, z: 5 }, outward: { x: 0, z: 1 }, width: 8, mode: "pedestrian", required: true, approach: { parts: [{ shape: "rect", center: { x: 0, z: 10 }, width: 8, depth: 10 }] } },
  ],
  motion: [{ kind: "spin", axis: "z", center: [14, 8, 0], outerRadius: 4, halfDepth: 1 }],
});
const good = declarePhysical(goodRaw());
assert.deepEqual(declarePhysical(goodRaw()), good, "factory deterministic: same input → deep-equal output");
assert.equal(good.schemaVersion, 1);
assert.throws(() => { good.footprint.parts[0].width = 99; }, TypeError, "frozen deep: nested rect immutable");
assert.throws(() => { good.entrances.push(1); }, TypeError, "frozen deep: entrance array immutable");
// CW 绕序输入被规范化为 CCW，且包含判定工作
const cw = declarePhysical({ ...goodRaw(), footprint: { parts: [{ shape: "convex", vertices: [{ x: 0, z: 0 }, { x: 0, z: 4 }, { x: 4, z: 4 }, { x: 4, z: 0 }] }] } });
let area = 0; const v = cw.footprint.parts[0].vertices;
for (let i = 0; i < v.length; i += 1) { const a = v[i]; const b = v[(i + 1) % v.length]; area += a.x * b.z - b.x * a.z; }
assert(area > 0, "convex winding normalized to CCW (positive signed area)");
assert(pointInRegion({ x: 2, z: 2 }, cw.footprint.parts[0]) && !pointInRegion({ x: 5, z: 2 }, cw.footprint.parts[0]), "pointInRegion works on normalized polygon");

let rejected = 0;
const rejects = (label, mutate) => {
  const raw = goodRaw(); mutate(raw);
  assert.throws(() => declarePhysical(raw), Error, label);
  rejected += 1;
};
rejects("radius NaN", (r) => { r.footprint.parts[1].radius = NaN; });
rejects("width ≤ 0", (r) => { r.footprint.parts[0].width = 0; });
rejects("depth infinite", (r) => { r.footprint.parts[0].depth = Infinity; });
rejects("polygon non-convex (arrow)", (r) => { r.footprint.parts[2].vertices = [{ x: 0, z: 0 }, { x: 4, z: 2 }, { x: 0, z: 4 }, { x: 2, z: 2 }]; });
rejects("polygon too many vertices", (r) => { r.footprint.parts[2].vertices = Array.from({ length: MAX_CONVEX_VERTICES + 1 }, (_, i) => ({ x: Math.cos((i / (MAX_CONVEX_VERTICES + 1)) * Math.PI * 2) * 5, z: Math.sin((i / (MAX_CONVEX_VERTICES + 1)) * Math.PI * 2) * 5 })); });
rejects("footprint too many parts", (r) => { r.footprint.parts = Array.from({ length: MAX_FOOTPRINT_PARTS + 1 }, (_, i) => ({ shape: "rect", center: { x: i, z: 0 }, width: 1, depth: 1 })); });
rejects("outward not normalized", (r) => { r.entrances[0].outward = { x: 2, z: 0 }; });
rejects("outward zero", (r) => { r.entrances[0].outward = { x: 0, z: 0 }; });
rejects("entrance width ≤ 0", (r) => { r.entrances[0].width = -1; });
rejects("duplicate entrance id", (r) => { r.entrances = [r.entrances[0], { ...r.entrances[0] }]; });
rejects("approach empty", (r) => { r.entrances[0].approach = { parts: [] }; });
rejects("modelId uppercase", (r) => { r.modelId = "BadId"; });
rejects("modelRevision empty", (r) => { r.modelRevision = ""; });
rejects("ground maxRelief negative", (r) => { r.foundation.maxRelief = -0.1; });
rejects("piles without supports", (r) => { r.foundation = { kind: "piles", supports: [], maxLegLength: 5, allowedMedium: "water" }; });
rejects("floating requiredDepth ≤ 0", (r) => { r.foundation = { kind: "floating", waterlineOffset: 0, requiredDepth: 0 }; });
rejects("motion outerRadius ≤ 0", (r) => { r.motion[0].outerRadius = 0; });
rejects("motion bad axis", (r) => { r.motion[0].axis = "w"; });
rejects("motion bad kind", (r) => { r.motion[0].kind = "wobble"; });
console.log(`City physical: factory self-consistency — ${rejected} negative cases rejected, deep-freeze and CCW normalization verified.`);

// ———— 3. 注册纪律（禁止静默，spec §4.6） ————
for (const model of BUILDING_MODELS) {
  const declared = model.physical !== undefined; const pending = model.id in PHYSICAL_PENDING;
  assert(declared !== pending, `${model.id}: must be exactly one of physical / PHYSICAL_PENDING`);
  if (declared) assert.equal(model.physical.modelId, model.id, `${model.id}: declaration modelId matches`);
}
assert.deepEqual(BUILDING_MODELS.filter((m) => m.physical).map((m) => m.id).sort(), [...BATCH_A_DECLARED].sort(), "batch A declared set");
for (const reason of Object.values(PHYSICAL_PENDING)) assert(reason.length >= 10, "pending entries give a reason");
assert(Object.keys(PHYSICAL_PENDING).length <= 3, `PHYSICAL_PENDING only shrinks (batch A = 3, got ${Object.keys(PHYSICAL_PENDING).length})`);

// ———— 4. 声明↔几何比对（经编译器唯一通道，spec §4/§4.5） ————
const INPUTS = [{ seed: 1 }, { seed: 7, radius: 30, sizing: { cap: 70, neon: 0 } }, { seed: 7, radius: 30, sizing: { cap: 70, neon: 1 } }, { seed: 9, radius: 30, sizing: { cap: 40, neon: 1 } }];
const quadOf = (box) => [
  { x: box.min.x, z: box.min.z }, { x: box.max.x, z: box.min.z },
  { x: box.max.x, z: box.max.z }, { x: box.min.x, z: box.max.z },
];
/** spin 包络在地面平面（局部 x/z）的投影 = 矩形（轴向 z：径向平面 (x,y) 投到 x、轴向给 z；其余轴对称）。 */
const motionGroundRect = (e) => {
  const [cx, , cz] = e.center;
  if (e.axis === "z") return { shape: "rect", center: { x: cx, z: cz }, width: e.outerRadius * 2, depth: e.halfDepth * 2 };
  if (e.axis === "x") return { shape: "rect", center: { x: cx, z: cz }, width: e.halfDepth * 2, depth: e.outerRadius * 2 };
  return { shape: "rect", center: { x: cx, z: cz }, width: e.outerRadius * 2, depth: e.outerRadius * 2 };
};
const inMotionEnvelope = (point, e, tol) => {
  const [cx, cy, cz] = e.center; const [x, y, z] = point;
  if (e.axis === "z") return Math.hypot(x - cx, y - cy) <= e.outerRadius + tol && Math.abs(z - cz) <= e.halfDepth + tol;
  if (e.axis === "x") return Math.hypot(y - cy, z - cz) <= e.outerRadius + tol && Math.abs(x - cx) <= e.halfDepth + tol;
  return Math.hypot(x - cx, z - cz) <= e.outerRadius + tol && Math.abs(y - cy) <= e.halfDepth + tol;
};

let checkedParts = 0; let groundParts = 0;
for (const model of BUILDING_MODELS) {
  if (!model.physical) continue;
  const decl = model.physical;
  const where = (msg) => `${model.id}: ${msg}`;
  const spinGroups = new Set((model.lifecycle.spin ?? []).flatMap((s) => s.parts));
  const envelopes = decl.motion ?? [];
  const reachMax = new Map(envelopes.map((_, i) => [i, 0])); // 每个 envelope 被几何用到的最大径距（防空声明）
  for (const input of INPUTS) {
    assert(input.siting === undefined, where("batch A tests land-variant inputs only (shore variant is batch D)"));
    const compileOnce = () => {
      const group = new THREE.Group(); const disposables = []; const placed = [];
      compileBuilding(model.geometry(input), {
        group, material: createMaterialFactory((m) => disposables.push(m)), disposables,
        onPart: (part, object) => placed.push({ part, object }),
      }, input);
      group.updateMatrixWorld(true);
      return { group, placed, dispose: () => disposables.forEach((d) => d.dispose()) };
    };
    const first = compileOnce(); const second = compileOnce();
    // 两次编译是两份独立 plan（geometry() 各自新对象），按件序对齐做确定性对比
    assert.equal(first.placed.length, second.placed.length, where("compile places the same part count"));
    const boxes = first.placed.map(({ object }) => new THREE.Box3().setFromObject(object));
    second.placed.forEach(({ object }, i) => {
      const a = boxes[i]; const b = new THREE.Box3().setFromObject(object);
      assert(Math.abs(a.min.x - b.min.x) + Math.abs(a.min.y - b.min.y) + Math.abs(a.min.z - b.min.z)
        + Math.abs(a.max.x - b.max.x) + Math.abs(a.max.y - b.max.y) + Math.abs(a.max.z - b.max.z) < 1e-9, where(`compile deterministic for part #${i}`));
    });
    let groundArea = 0;
    first.placed.forEach(({ part, object }, partIndex) => {
      if (part.kind === "group") return;
      assert(part.kind !== "instanced", where("instanced part envelope not implemented in batch A (fails loudly, never silently skipped)"));
      if (part.role === "beam") return; // 批 A 审核结论：beam 非实体（spec §4.3，光束不扩大占地）
      const box = boxes[partIndex];
      const quad = quadOf(box); const w = box.max.x - box.min.x; const d = box.max.z - box.min.z;
      const label = `${part.id ?? part.kind}@y[${box.min.y.toFixed(1)},${box.max.y.toFixed(1)}]`;
      checkedParts += 1;
      const spinning = part.parent !== undefined && spinGroups.has(part.parent);
      if (spinning) {
        assert(box.min.y > TOL.groundTouchY, where(`${label}: spinning part must not touch the ground`));
        // 绕轴旋转不改变顶点的径距与轴向坐标 → 按顶点验包络是精确判定；
        // AABB 角点对圆环等件是空角（过保守），不用。
        const pos = object.geometry.attributes.position; const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i += 1) {
          v.fromBufferAttribute(pos, i).applyMatrix4(object.matrixWorld);
          const point = [v.x, v.y, v.z];
          let contained = false;
          for (const [ei, e] of envelopes.entries()) {
            if (!inMotionEnvelope(point, e, quadMargin(w, d))) continue;
            contained = true; // 记账所有包含它的 envelope（some 短路会让小 envelope 永远显示未用满）
            const [cx, cy, cz] = e.center;
            const radial = e.axis === "z" ? Math.hypot(v.x - cx, v.y - cy) : e.axis === "x" ? Math.hypot(v.y - cy, v.z - cz) : Math.hypot(v.x - cx, v.z - cz);
            reachMax.set(ei, Math.max(reachMax.get(ei), radial));
          }
          assert(contained, where(`${label}: spinning vertex ${point.map((n) => n.toFixed(1)).join(",")} outside every motion envelope`));
        }
        return;
      }
      if (box.min.y <= TOL.groundTouchY) {
        groundParts += 1;
        groundArea += w * d;
        assert(quadInFootprint(quad, decl.footprint, quadMargin(w, d)), where(`${label}: ground-touching part escapes footprint`));
        assert(decl.foundation.kind === "ground" && quadInFootprint(quad, decl.foundation.support, quadMargin(w, d)), where(`${label}: ground-touching part escapes foundation.support`));
      } else {
        // 上层悬挑：不能无条件当地面障碍（spec §3.1），允许 overhang ∪ footprint ∪ 运动包络投影 + 悬挑余量
        const allowed = { parts: [...decl.footprint.parts, ...(decl.overhang?.parts ?? []), ...envelopes.map(motionGroundRect)] };
        assert(quadInFootprint(quad, allowed, TOL.overhangMargin), where(`${label}: overhang escapes overhang ∪ footprint ∪ motion projections + margin`));
      }
    });
    first.dispose(); second.dispose();
    assert(footprintAreaSum(decl.footprint) <= TOL.areaRatio * Math.max(groundArea, 1), where(`footprint area ${footprintAreaSum(decl.footprint).toFixed(0)} exceeds ${TOL.areaRatio}× ground part area ${groundArea.toFixed(0)} (gross over-declaration)`));
  }
  for (const [i, e] of envelopes.entries()) {
    assert(reachMax.get(i) >= e.outerRadius - TOL.motionReachSlack, where(`motion envelope ${i} (R=${e.outerRadius}) is vacuous: geometry only reaches ${reachMax.get(i).toFixed(1)}`));
  }
}

// ———— 5. 必测反例（spec §7「并集空隙」/§9 凸包行） ————
const archDecl = BUILDING_MODELS.find((m) => m.id === "arch").physical;
const spanning = [{ x: -10, z: -5 }, { x: 10, z: -5 }, { x: 10, z: 5 }, { x: -10, z: 5 }];
assert(!quadInFootprint(spanning, archDecl.footprint), "counterexample: a quad spanning the roadway gap MUST be rejected by the union");
assert(quadInFootprint(spanning, { parts: [{ shape: "rect", center: { x: 0, z: 0 }, width: 34, depth: 12 }] }), "counterexample: the convex-hull-equivalent rect WOULD accept it — documents why hull may not replace the union");
assert(quadInFootprint([{ x: -16, z: -5 }, { x: -9, z: -5 }, { x: -9, z: 5 }, { x: -16, z: 5 }], archDecl.footprint), "a quad inside one pier passes");
assert(!quadInFootprint([{ x: -8.5, z: -5 }, { x: -4, z: -5 }, { x: -4, z: 5 }, { x: -8.5, z: 5 }], archDecl.footprint, 0.2), "a quad poking into the gap is rejected even with margin");

console.log(`City physical: ${BATCH_A_DECLARED.length} declarations (arch/sail-opera/ferris-wheel) × ${INPUTS.length} inputs — ${checkedParts} solid parts checked (${groundParts} ground-touching), envelope↔geometry containment exact (edge coverage, no sampling); ${Object.keys(PHYSICAL_PENDING).length} models pending with reasons; union-vs-hull counterexamples pinned. Tolerance v${TOL.v}.`);
