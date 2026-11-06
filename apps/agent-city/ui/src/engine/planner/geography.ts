/**
 * 地理阶段（CITY_PLANNER_V2_SPEC §5.1 / 步 2a）：岛形、河、山脊、地形判定——从 buildPlan 逐字迁出。
 *
 * 纯函数：只依赖 (seed, R, shape)，无 three、无上游可变状态；random 是无状态键控哈希
 * （hashSeed(seed:key)），迁移不改变任何随机调用序——行为保持由 plan/场景基线哈希证明。
 * 后续阶段（skeleton/sites/network）只读本产物：coast/height/riverX 等闭包即 Geography 的字段。
 */
import { DetMath as Math } from "../detMath";
import { hashSeed } from "../../cityModel";
import { fbm, smoothstep } from "../cityNoise";
import type { TerrainField, Vec2 } from "../cityLayout";
import type { Shape } from "../cityPlan";
import { exactFieldCache } from "./exactFieldCache";
import { spendPlanningUnit } from "./operationBudget";
import { ISLET_CAUSEWAY_OFFSET } from "../cityIsletEstate";

export type Geography = {
  R: number;
  coast: Vec2[];
  bbox: { minX: number; maxX: number; minZ: number; maxZ: number };
  hasRiver: boolean;
  river: Vec2[];
  riverShift: number;
  riverX: (z: number) => number;
  riverWidth: (z: number) => number;
  coastDistance: (x: number, z: number) => number;
  landClearance: (x: number, z: number) => number;
  hillAngle: number;
  hillDir: Vec2;
  hillLine: number;
  hillProj: (x: number, z: number) => number;
  height: (x: number, z: number) => number;
  buildable: (x: number, z: number) => boolean;
  terrain: TerrainField;
  /** 主干道一次最多跨多宽的水面。窄河 140；开湾时按湾的最大全宽放开，否则没有一条主干道能过湾、东岛成孤岛。 */
  maxWaterSpan: number;
  /** 湾内小岛。规划层只把岛上那段桥间地面路当陆地（inRiver 在岛上为假），岛不可建、不分地块。 */
  islets: Array<Vec2 & { radius: number; kind: "starfish" | "leaf-links" | "prawn"; /** 贴哪一岸（短桥接这一岸）：1 = 东岛，-1 = 西岛大陆。 */ side?: 1 | -1 }>;
  /** 到最近小岛岸线的带符号距离（岛内为正）；无岛恒为 -Infinity。 */
  isletClearance: (x: number, z: number) => number;
  /** 内水岸线（开湾时 = 海湾两岸 + 湾内岛轮廓；否则空）。路端离它 ≤ WATER_STOP_MARGIN 算合法的近水终止——
   *  外海岸（coast）与河道中线（river）认不到湾岸：湾半宽 100+，停在湾岸的主干道端头曾全被判成违规断头。 */
  waterEdges: Vec2[][];
};

/** 中央海湾参数（来自 CoastalConfig.bayHalfWidth / bayShift）；null = 原来的窄河。 */
export type BayOptions = { halfWidth: number; shift: number };

export function buildGeography(seed: number, R: number, seedShape: Shape, opts: { memoize?: boolean; bay?: BayOptions | null } = {}): Geography {
  const bay = opts.bay && opts.bay.halfWidth > 0 ? opts.bay : null;
  // 开湾时岛形定向：长轴固定南北（spin 0、x 向压扁），不挖随机海湾，二次谐波减半。
  // 随机旋转/拉伸/挖湾下，湾东侧有时只剩几十个地块的碎片或被掐断成孤岛（4 种子 × 3 档实测：
  // 海滩落东岛 1/4、一个种子无跨湾桥）。保留 3/5 次谐波，海岸仍各不相同。
  const shape: Shape = bay
    ? { ...seedShape, spin: 0, stretch: 0.8 + (seedShape.stretch - 0.78) * 0.2, bays: [],
        harmonics: seedShape.harmonics.map((h) => (h.k === 2 ? { ...h, a: h.a * 0.5 } : h)) }
    : seedShape;
  // Each radius attempt owns its caches. Only the original exact scalar result
  // is reused, and eviction affects cost rather than planning decisions.
  const field = <T extends number | boolean>(evaluate: (x: number, z: number) => T) => {
    const query = opts.memoize === true ? exactFieldCache(evaluate).query : evaluate;
    return (x: number, z: number): T => { spendPlanningUnit("terrain:field-query", "terrainSample"); return query(x, z); };
  };
  const stretch = shape.stretch; // Field closures must not depend on mutable caller-owned scalars.
  const random = (key: string) => hashSeed(`${seed}:${key}`);
  const phase = random("river") * 3;

  // ── L1 岛形 ──
  const islandRadius = (theta: number) => {
    let r = 1;
    for (const h of shape.harmonics) r += h.a * Math.cos(h.k * theta + h.p);
    for (const bay of shape.bays) {
      const d = Math.atan2(Math.sin(theta - bay.at), Math.cos(theta - bay.at));
      r -= bay.depth * Math.exp(-(d * d) / (bay.width * bay.width));
    }
    r += fbm(Math.cos(theta) * 2.2, Math.sin(theta) * 2.2, seed + 17, 3) * 0.07;
    return Math.max(0.45, r);
  };
  const coast: Vec2[] = Array.from({ length: 96 }, (_, i) => {
    const theta = (i / 96) * Math.PI * 2;
    const r = islandRadius(theta) * R;
    const lx = Math.cos(theta) * r * shape.stretch;
    const lz = Math.sin(theta) * r / shape.stretch;
    return { x: lx * Math.cos(shape.spin) - lz * Math.sin(shape.spin), z: lx * Math.sin(shape.spin) + lz * Math.cos(shape.spin) };
  });
  const bbox = coast.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x), minZ: Math.min(b.minZ, p.z), maxZ: Math.max(b.maxZ, p.z) }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });

  // ── 河：82% 有河，大致南北向穿岛（街网沿河弯曲，桥跨在第 0 列空隙上）。
  // 横向偏移不超过岛半宽的 25%，弯曲幅度与东西镜像随种子；无河时河宽恒负、不切地。
  // 开湾（Vice City 式）：湾恒在，中线东偏让东岛成一条窄长的海滩城、西岛是宽的大陆；湾岸只缓弯
  // （窄河的蜿蜒幅度放到湾上会把东岛某段掐断）。湾宽沿 z 缓慢起伏，读起来像海湾而不是运河。
  const hasRiver = bay ? true : random("hasRiver") < 0.82;
  const halfWidth = (bbox.maxX - bbox.minX) / 2;
  const riverShift = bay
    ? (bbox.minX + bbox.maxX) / 2 + bay.shift * halfWidth
    : (bbox.minX + bbox.maxX) / 2 + (random("riverShift") - 0.5) * halfWidth * 0.5;
  const riverAmp = (bay ? 0.02 : 0.04 + random("riverAmp") * 0.07) * R * (random("riverMirror") < 0.5 ? -1 : 1);
  // 河中心/河宽只依赖 z，却含 3 次确定性 sin/cos + smoothstep；一次高度/入河/坡度求值会以同一个 z（坡度还有 z±1）
  // 反复调用它们。单槽记忆（上一次的 z → 结果）是纯函数的精确复用：命中返回的就是同一表达式上次算出的同一个数，
  // 未命中走原式，逐位相同；每个 buildGeography 各持一份闭包，互不共享。
  const riverXRaw = (z: number) => hasRiver ? riverShift + riverAmp * Math.sin(z * 0.006 + phase) + 0.03 * R * Math.sin(z * 0.014) : riverShift;
  // 湾宽按岛的东西半宽算，不按 R：岛形开湾时被压扁，按 R 算的湾把东岛吃到只剩 ~40 宽（seed 1703318715/2 档实测）。
  const bayHalf = bay ? bay.halfWidth * halfWidth : 0;
  const riverWidthRaw = (z: number) => bay
    ? bayHalf * (1 + 0.22 * Math.cos(z * 0.0045 + phase))
    : hasRiver ? 16 + 4 * Math.cos(z * 0.012) + smoothstep(bbox.minZ + (bbox.maxZ - bbox.minZ) * 0.55, bbox.maxZ, z) * 34 : -1e6;
  let riverXZ = NaN; let riverXV = 0;
  const riverX = (z: number) => { if (z !== riverXZ) { riverXV = riverXRaw(z); riverXZ = z; } return riverXV; };
  let riverWidthZ = NaN; let riverWidthV = 0;
  const riverWidth = (z: number) => { if (z !== riverWidthZ) { riverWidthV = riverWidthRaw(z); riverWidthZ = z; } return riverWidthV; };
  const river = hasRiver ? Array.from({ length: 121 }, (_, i) => { const z = bbox.minZ - 60 + i * ((bbox.maxZ - bbox.minZ + 120) / 120); return { x: riverX(z), z }; }) : [];
  // 离岸距离：岛本就是极坐标函数，变回局部坐标比较「该方位的海岸半径 − 点的半径」即可 O(1) 求得。
  // 曾逐点对 96 段海岸算多边形距离，单岛被调用数十万次（profile 里占 85%）。
  // 乘 min(stretch, 1/stretch)·0.92 取保守下界：只会低估离岸距离，街区不会因近似落进海里。
  const radiusTable = Array.from({ length: 721 }, (_, i) => islandRadius((i / 720) * Math.PI * 2) * R);
  const shrink = Math.min(shape.stretch, 1 / shape.stretch) * 0.92;
  const cosSpin = Math.cos(shape.spin); const sinSpin = Math.sin(shape.spin);
  // 走廊采样对同一点先后调 height（→landClearance→coastDistance）和 inRiver（→coastDistance），
  // 单槽记忆（上一次的 x,z → 结果）让第二次直接命中；纯函数的精确复用，未命中走原式，逐位相同。
  let coastX = NaN; let coastZ = NaN; let coastV = 0;
  const coastDistanceRaw = (x: number, z: number) => {
    const lx = x * cosSpin + z * sinSpin;
    const lz = -x * sinSpin + z * cosSpin;
    const ux = lx / stretch; const uz = lz * stretch;
    let theta = Math.atan2(uz, ux); if (theta < 0) theta += Math.PI * 2;
    const f = (theta / (Math.PI * 2)) * 720; const i = Math.floor(f);
    const edge = radiusTable[i] + (radiusTable[Math.min(720, i + 1)] - radiusTable[i]) * (f - i);
    return (edge - Math.hypot(ux, uz)) * shrink;
  };
  const coastDistance = field((x: number, z: number) => {
    if (x !== coastX || z !== coastZ) { coastV = coastDistanceRaw(x, z); coastX = x; coastZ = z; }
    return coastV;
  });
  const landClearance = field((x: number, z: number) => Math.min(coastDistance(x, z), Math.abs(x - riverX(z)) - riverWidth(z)));

  // ── 山脊：方位随种子，占岛在该方向上最外侧的一带。
  // 开湾时山只留在西岛（大陆）的外侧：东岛是窄海滩城，山压上去就没地方盖城了。
  const hillAngle = bay ? Math.PI + (random("hillAngle") - 0.5) * 1.2 : random("hillAngle") * Math.PI * 2;
  const hillDir = { x: Math.cos(hillAngle), z: Math.sin(hillAngle) };
  const reach = Math.max(...coast.map((p) => p.x * hillDir.x + p.z * hillDir.z));
  const hillLine = reach * 0.6;
  const hillProj = (x: number, z: number) => x * hillDir.x + z * hillDir.z;
  // 湾心小岛（参考 Vice City 的 Starfish/Prawn Island）：开湾时在湾中线、东岛南北跨度的正中隆起一座圆岛，
  // 中间那条堤道（buildCauseways k=2，同一 z）从岛上跨过。只改地形高度：规划层仍按湾（inRiver）处理，
  // 不铺路、不分地块——岛上放什么另议，先让构图成立。
  const eastZ = bay ? coast.filter((p) => p.x > riverXRaw(p.z) + riverWidthRaw(p.z)).map((p) => p.z) : [];
  // 三座湾内岛（照 Vice City 区划：Starfish 居中、Leaf Links 在北段贴东岛、Prawn 更北靠东岛）。
  // z 用堤道同一套四等分（buildCauseways：k 号堤道在 zMin + k·spacing）：
  //  · starfish：中心在 2 号堤道以南 ISLET_CAUSEWAY_OFFSET·R——堤道贴着岛的北缘过，岛主体留给环路与住宅；
  //  · leaf-links：3 号堤道从它南部穿过（偏 0.2R），中心贴东岸、留 40 的水道，再由短桥接东岛；
  //  · prawn：3 号堤道以北 0.7 个间距，贴东岸留 30 的水道，单独一座短桥接东岛。
  // 西侧水道至少留 60（湾窄时缩小半径；缩到放不下就不放），岛整体必须在海岸以内。
  const islets: Geography["islets"] = [];
  if (eastZ.length >= 3) {
    const zMin = Math.min(...eastZ); const spacing = (Math.max(...eastZ) - zMin) / 4;
    const starfishR = bayHalf * 0.55;
    const sz = zMin + 2 * spacing - ISLET_CAUSEWAY_OFFSET * starfishR;
    islets.push({ x: riverXRaw(sz), z: sz, radius: starfishR, kind: "starfish" });
    // 南北半轴 = 拉伸 × (1 + 噪声幅度 0.26) × r（与 isletClearance 同参数）。
    const halfLength = (kind: "leaf-links" | "prawn", r: number) => (kind === "leaf-links" ? 1.4 : 1.35) * 1.26 * r;
    const hugEast = (kind: "leaf-links" | "prawn", nominal: number, zAt: (r: number) => number, eastChannel: number, side: 1 | -1 = 1) => {
      const z0 = zAt(nominal);
      const r = Math.min(nominal, (2 * riverWidthRaw(z0) - eastChannel - 60) / 2);
      if (r < 22) return;
      const z = zAt(r); const x = riverXRaw(z) + side * (riverWidthRaw(z) - r - eastChannel);
      if (coastDistanceRaw(x, z) < halfLength(kind, r) + 15) return;
      islets.push({ x, z, radius: r, kind, side });
    };
    hugEast("leaf-links", bayHalf * 0.5, (r) => zMin + 3 * spacing - 0.2 * r, 40);
    // Prawn 紧挨 Leaf Links 北端往北排（留 30 的水面）：按固定比例放时，常越过东岛北端出海、或撞上拉长后的 Leaf Links
    // （6 种子 × 3 档只出现 4/18）。没有 Leaf Links 时退到 3.3 个间距处。
    const leaf = islets.find((i) => i.kind === "leaf-links");
    hugEast("prawn", bayHalf * 0.32, (r) => leaf ? leaf.z + halfLength("leaf-links", leaf.radius) + halfLength("prawn", r) + 30 : zMin + 3.3 * spacing, 30);
    // 东岛北头太窄（出海）放不下时，改贴西岸（大陆）放在 3 号堤道以北、短桥接大陆——原版 Prawn 本就在 Downtown 北侧一带。
    // 曾试退到 Starfish 以南：两者与 1 号堤道之间的间距常不够，Prawn 会压在堤道线上（6 种子 × 3 档仍只 9/18）。
    if (!islets.some((i) => i.kind === "prawn")) {
      const z3 = zMin + 3 * spacing;
      hugEast("prawn", bayHalf * 0.32, (r) => z3 + halfLength("prawn", r) + 30, 30, -1);
    }
  }
  const isletClearance = (x: number, z: number) => {
    let best = -Infinity;
    // 轮廓按方位加噪（±18%），不是正圆：正圆读起来像占位圆盘。
    // Leaf Links / Prawn 不做成圆（用户要求）：沿南北拉长、岸线起伏更大；Starfish 照原版保持近圆。
    // 拉长只放大 z 向（radius 是短半轴），所以岛内一切按半径 r 圆盘放置的布局仍落在岛上。
    for (const islet of islets) {
      const stretch = islet.kind === "leaf-links" ? 1.4 : islet.kind === "prawn" ? 1.35 : 1;
      const amp = islet.kind === "starfish" ? 0.18 : 0.26;
      const dz = (z - islet.z) / stretch;
      const d = Math.hypot(x - islet.x, dz);
      const a = Math.atan2(dz, x - islet.x);
      const r = islet.radius * (1 + amp * fbm(Math.cos(a) * (stretch > 1 ? 2.3 : 1.6), Math.sin(a) * (stretch > 1 ? 2.3 : 1.6), seed + 233 + islets.indexOf(islet) * 17, 3));
      best = Math.max(best, r - d);
    }
    return best;
  };
  const height = field((x: number, z: number) => {
    const shore = landClearance(x, z);
    const inland = islets.length && shore < 0 ? Math.max(shore, isletClearance(x, z)) : shore;
    if (inland < 0) return -0.65 - Math.min(5, -inland * 0.25);
    const hillWeight = smoothstep(hillLine - 10, hillLine + reach * 0.3, hillProj(x, z));
    // 平地权重严格为零时，噪声不影响高度；路网验证会反复采样这些点。
    const hills = hillWeight === 0 ? 0 : hillWeight * (30 + 65 * fbm(x * 0.012, z * 0.013, seed, 4));
    return smoothstep(0, 10, inland) * (1.2 + hills);
  });
  // 离山脚留 12：山体高度从 hillLine−10 开始起坡，地块要落在 1.2 的平地上。
  const buildable = field((x: number, z: number) => landClearance(x, z) > 12 && hillProj(x, z) < hillLine - 12);
  const terrain: TerrainField = {
    height, slope: field((x, z) => Math.hypot(height(x + 1, z) - height(x - 1, z), height(x, z + 1) - height(x, z - 1)) / 2),
    buildable, center: { x: 0, z: 0 }, radius: R * 1.3, coastRadius: () => R, hasRiver,
  };

  const waterEdges: Vec2[][] = [];
  if (bay && river.length) {
    for (const side of [-1, 1]) waterEdges.push(river.map((p) => ({ x: riverX(p.z) + side * riverWidth(p.z), z: p.z })));
    for (const islet of islets) {
      // 轮廓：每个方位二分出 isletClearance = 0 的半径（岸线带噪声，不能直接用名义半径）
      const ring: Vec2[] = [];
      for (let k = 0; k <= 48; k += 1) {
        const a = (k / 48) * Math.PI * 2; const ux = Math.cos(a); const uz = Math.sin(a);
        let lo = 0; let hi = islet.radius * 2.2;
        for (let it = 0; it < 18; it += 1) { const mid = (lo + hi) / 2; if (isletClearance(islet.x + ux * mid, islet.z + uz * mid) > 0) lo = mid; else hi = mid; }
        ring.push({ x: islet.x + ux * lo, z: islet.z + uz * lo });
      }
      waterEdges.push(ring);
    }
    // 可见外海岸：保守离岸距离（coastDistanceRaw，低估）的零线才是地形上看得见的岸；名义轮廓（coast）在它外面，
    // 开湾的定向岛形下差到 40+，停在可见岸边的主干道端头离名义轮廓 > 40，被判违规断头（seed 1703294958/2 档实测 41/47）。
    // 只从岛中心沿射线二分，取最外一处零点即可（岛形是星形的极坐标函数）。
    const visible: Vec2[] = [];
    const cx = (bbox.minX + bbox.maxX) / 2; const cz = (bbox.minZ + bbox.maxZ) / 2;
    for (let k = 0; k <= 96; k += 1) {
      const a = (k / 96) * Math.PI * 2; const ux = Math.cos(a); const uz = Math.sin(a);
      let lo = 0; let hi = R * 2;
      for (let it = 0; it < 20; it += 1) { const mid = (lo + hi) / 2; if (coastDistanceRaw(cx + ux * mid, cz + uz * mid) > 0) lo = mid; else hi = mid; }
      visible.push({ x: cx + ux * lo, z: cz + uz * lo });
    }
    waterEdges.push(visible);
  }
  // 斜穿的主干道跨距比湾的全宽长，留 1.6 倍余量 + 对岸退界。
  const maxWaterSpan = bay ? Math.max(140, Math.ceil(bayHalf * 1.22 * 2 * 1.6 + 60)) : 140;
  return { R, coast, bbox, hasRiver, river, riverShift, riverX, riverWidth, coastDistance, landClearance, hillAngle, hillDir, hillLine, hillProj, height, buildable, terrain, maxWaterSpan, islets, isletClearance, waterEdges };
}
