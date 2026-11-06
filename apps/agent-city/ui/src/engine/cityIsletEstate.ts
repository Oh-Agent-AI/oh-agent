/**
 * 豪宅岛布局（Vice City 的 Starfish Island 母题，原创几何）：纯函数，局部坐标（原点 = 小岛中心，+z = 北，朝堤道）。
 *
 * 母题：跨湾堤道贴着岛的北缘穿过；岛主体是一条椭圆内部环路，一段短支路接上堤道；住宅一圈分布在环路外侧、
 * 面朝水面，能临水的带私家码头；堤道北侧与岸线之间是一座大宅；其余地面撒棕榈。
 *
 * 布局期（cityLayout.isletEstateLandmarks）用它摆住宅，渲染期（render/landmarks/isletGrounds）用它画环路、支路
 * 和棕榈——两边调用同一个函数、同样的输入，棕榈不会长进房子或路面里。
 *
 * 岸线噪声 ±18%（geography.isletClearance）：一切放置都压在 0.8R 以内；码头按噪声上限 1.18R 估到岸距离，宁长勿短。
 */
import { m, REAL } from "./worldScale";
import { DetMath as Math } from "./detMath";

/** 堤道中线相对小岛中心的北偏（占半径）。geography 按它把小岛中心放在堤道以南。 */
export const ISLET_CAUSEWAY_OFFSET = 0.45;

export type IsletHouse = { x: number; z: number; yaw: number; scale: number; reach: number; grand: boolean };
export type IsletEstate = {
  loop: { cx: number; cz: number; ax: number; az: number; width: number };
  spur: { x: number; z0: number; z1: number; width: number };
  houses: IsletHouse[];
  palms: Array<{ x: number; z: number; height: number; turn: number }>;
};

/** 住宅台地半尺寸（islet-mansion 台地 34×26，乘 scale）。 */
// 住宅台地 34 × 26 m（REAL.mansion，islet-mansion 模型按米建、渲染时整体乘 METER_MODEL_SCALE）。
const HOUSE_HALF_W = m(REAL.mansion.plotWidth) / 2; const HOUSE_HALF_D = m(REAL.mansion.plotDepth) / 2;

function hash(seed: number, salt: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad); h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return ((h ^ (h >>> 15)) >>> 0) / 0x1_0000_0000;
}

export function isletEstate(radius: number, seed: number): IsletEstate {
  const r = radius;
  const inner = r * 0.8;
  const causewayZ = r * ISLET_CAUSEWAY_OFFSET;
  // 住宅缩放 ≥0.85（主楼 ≥18.7 × 10.2 m）：曾夹在 0.45–0.7（10 × 6 m，对着 1.75 的人是个小棚）。
  // 先定住宅尺寸、再按岛大小算环路：环路半轴 = 住宅外沿还落在岸线噪声下限（0.8R）内所允许的最大值（夹在 0.5R 与 0.2R 之间），
  // 岛小环就小、住宅还是满尺寸——曾固定环路 0.5R，半径 < 95 的岛一栋住宅都放不下（CITY_SCALE_AUDIT 方案 A）。
  const scale = r >= 100 ? 1 : 0.85;
  const halfW = HOUSE_HALF_W * scale; const halfD = HOUSE_HALF_D * scale;
  const loopWidth = m(REAL.estateLoopRoad);
  const along = loopWidth / 2 + 3 + halfD; // 住宅中心离环路中线（台地后沿离路边 3）
  /** 给定环路半轴 ax，沿环路外侧每 30° 一个候选放住宅（台地四角都在岸线噪声下限内、离堤道 ≥ 10、彼此不重叠）。 */
  const ringHouses = (ax: number): IsletHouse[] => {
    const out: IsletHouse[] = [];
    const lp = { cx: 0, cz: -r * 0.08, ax, az: ax * 0.72 };
    for (let k = 0; k < 12; k += 1) {
      const a = (k / 12) * Math.PI * 2 + Math.PI / 12;
      const ex = lp.cx + lp.ax * Math.cos(a); const ez = lp.cz + lp.az * Math.sin(a);
      const nx = Math.cos(a) / lp.ax; const nz = Math.sin(a) / lp.az; const nl = Math.hypot(nx, nz);
      const ux = nx / nl; const uz = nz / nl;
      const x = ex + ux * along; const z = ez + uz * along;
      const yaw = Math.atan2(ux, uz);
      const corners = [[-halfW, -halfD], [halfW, -halfD], [-halfW, halfD], [halfW, halfD]].map(([lx, lz]) => (
        { x: x + lx * Math.cos(yaw) + lz * Math.sin(yaw), z: z - lx * Math.sin(yaw) + lz * Math.cos(yaw) }));
      if (!corners.every((c) => Math.hypot(c.x, c.z) < inner && c.z < causewayZ - 10)) continue;
      if (out.some((h) => Math.hypot(h.x - x, h.z - z) < (halfW + h.scale * HOUSE_HALF_W) * 1.05)) continue;
      // 码头按名义岸线估到岸距离（噪声 ±18%：偏小一侧码头多伸出一截，偏大一侧码头端头仍在岸外 4 以上）。
      out.push({ x, z, yaw, scale, reach: Math.max(0, r * 1.05 - Math.hypot(x, z)), grand: false });
    }
    return out;
  };
  // 环路半轴取「能放下最多住宅」的那个（并列取大的）：岛小环就小，住宅保持满尺寸，不靠缩住宅凑数。
  let ax = r * 0.5; let houses: IsletHouse[] = ringHouses(ax);
  for (let candidate = r * 0.5 - 2; candidate >= r * 0.2; candidate -= 2) {
    const trial = ringHouses(candidate);
    if (trial.length > houses.length) { ax = candidate; houses = trial; }
  }
  const loop = { cx: 0, cz: -r * 0.08, ax, az: ax * 0.72, width: loopWidth };
  const spur = { x: 0, z0: loop.cz + loop.az, z1: causewayZ, width: m(REAL.estateSpurRoad) };

  // ── 北侧大宅：堤道与北岸之间的条带够深就放一栋正常尺寸、面朝北；不够深就缩到 0.75 ──
  for (const grandScale of [1.1, 1, 0.85]) {
    const gz = causewayZ + 6 + 3 + HOUSE_HALF_D * grandScale;
    const corner = Math.hypot(HOUSE_HALF_W * grandScale, gz + HOUSE_HALF_D * grandScale);
    if (corner < inner) { houses.push({ x: 0, z: gz, yaw: 0, scale: grandScale, reach: Math.max(0, r * 1.05 - gz), grand: true }); break; }
  }

  // ── 棕榈：9 单位网格抖动撒点，避开环路带、支路、堤道带、住宅台地（含 3 的余量） ──
  const palms: IsletEstate["palms"] = [];
  const onLoop = (x: number, z: number) => {
    const t = Math.hypot((x - loop.cx) / loop.ax, (z - loop.cz) / loop.az);
    return Math.abs(t - 1) * Math.min(loop.ax, loop.az) < loop.width / 2 + 2.5;
  };
  const onHouse = (x: number, z: number) => houses.some((h) => {
    const dx = x - h.x; const dz = z - h.z;
    const lx = dx * Math.cos(h.yaw) - dz * Math.sin(h.yaw); const lz = dx * Math.sin(h.yaw) + dz * Math.cos(h.yaw);
    return Math.abs(lx) < HOUSE_HALF_W * h.scale + 3 && Math.abs(lz) < HOUSE_HALF_D * h.scale + 3;
  });
  let n = 0;
  for (let gx = -r; gx <= r; gx += 9) for (let gz = -r; gz <= r; gz += 9) {
    n += 1;
    const x = gx + (hash(seed, n * 2) - 0.5) * 6; const z = gz + (hash(seed, n * 2 + 1) - 0.5) * 6;
    if (Math.hypot(x, z) > r * 0.74) continue;
    if (Math.abs(z - causewayZ) < 9) continue;
    if (Math.abs(x - spur.x) < spur.width / 2 + 2 && z > spur.z0 - 2 && z < spur.z1) continue;
    if (onLoop(x, z) || onHouse(x, z)) continue;
    if (hash(seed, n + 9001) < 0.35) continue; // 留空：不铺成均匀的树阵
    palms.push({ x, z, height: m(REAL.palm.min + hash(seed, n + 7001) * (REAL.palm.max - REAL.palm.min)), turn: hash(seed, n + 5001) * Math.PI * 2 });
  }
  return { loop, spur, houses, palms };
}

/** 「点在路带上」：roadZ = 穿岛道路中线的局部 z；fromX = 道路从哪个 x 起（Prawn 的路从岛心往东，Leaf 横贯全岛）。 */
const onRoadBand = (x: number, z: number, roadZ: number, fromX: number, margin: number) => Math.abs(z - roadZ) < margin && x > fromX;

function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax; const dz = bz - az; const l = dx * dx + dz * dz;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l)) : 0;
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

export type IsletGolf = {
  fairways: Array<{ ax: number; az: number; bx: number; bz: number; width: number }>;
  greens: Array<{ x: number; z: number; radius: number }>;
  bunkers: Array<{ x: number; z: number; rx: number; rz: number }>;
  clubhouse: { x: number; z: number; yaw: number } | null;
  trees: Array<{ x: number; z: number; size: number; palm: boolean }>;
};

/**
 * Leaf Links 母题（高尔夫俱乐部岛，原创几何）：跨湾堤道横贯岛的北部（roadZ），以南是几条东西向球道（交替方向，
 * 果岭在一端、旁边一两个沙坑），堤道以北够宽再放一条短球道；会所贴路南侧；其余撒阔叶树与少量棕榈。
 */
export function isletGolf(radius: number, seed: number, roadZ: number): IsletGolf {
  const r = radius; const usable = r * 0.72; const band = 11;
  const fairways: IsletGolf["fairways"] = []; const greens: IsletGolf["greens"] = []; const bunkers: IsletGolf["bunkers"] = [];
  const rows: number[] = [];
  for (let z = roadZ - band - 12; z > -usable + 8; z -= 22) rows.push(z);
  if (roadZ + band + 14 < usable - 8) rows.push(roadZ + band + 14);
  rows.forEach((z, i) => {
    const ext = Math.sqrt(Math.max(0, usable * usable - z * z)) - 6;
    if (ext < 18) return;
    const dir = i % 2 === 0 ? 1 : -1;
    const ax = -dir * ext; const bx = dir * ext;
    fairways.push({ ax, az: z, bx, bz: z, width: m(30) }); // 球道宽 30 m
    greens.push({ x: bx - dir * 2, z, radius: m(10) });     // 果岭半径 10 m
    bunkers.push({ x: bx - dir * 9, z: z + (hash(seed, i * 3) < 0.5 ? 5 : -5), rx: 2.6, rz: 1.6 });
    if (hash(seed, i * 3 + 1) < 0.6) bunkers.push({ x: ax * 0.2, z: z + (hash(seed, i * 3 + 2) < 0.5 ? 5.5 : -5.5), rx: 3.2, rz: 1.4 });
  });
  const clubZ = roadZ - band - 3;
  const clubhouse = Math.hypot(r * 0.25 + 8, clubZ - 6) < usable && fairways.length ? { x: -r * 0.25, z: clubZ, yaw: Math.PI } : null;
  const trees: IsletGolf["trees"] = [];
  let n = 0;
  for (let gx = -r; gx <= r; gx += 7) for (let gz = -r; gz <= r; gz += 7) {
    n += 1;
    const x = gx + (hash(seed, 9000 + n) - 0.5) * 5; const z = gz + (hash(seed, 9500 + n) - 0.5) * 5;
    if (Math.hypot(x, z) > r * 0.76 || Math.abs(z - roadZ) < band - 2) continue;
    if (fairways.some((f) => segmentDistance(x, z, f.ax, f.az, f.bx, f.bz) < f.width / 2 + 3)) continue;
    if (greens.some((g) => Math.hypot(x - g.x, z - g.z) < g.radius + 3)) continue;
    if (clubhouse && Math.abs(x - clubhouse.x) < 12 && Math.abs(z - clubhouse.z) < 9) continue;
    if (hash(seed, 9900 + n) < 0.45) continue;
    trees.push({ x, z, size: 2.2 + hash(seed, 9700 + n) * 1.6, palm: hash(seed, 9300 + n) < 0.25 });
  }
  return { fairways, greens, bunkers, clubhouse, trees };
}

export type IsletStudio = {
  stages: Array<{ x: number; z: number; w: number; d: number; h: number }>;
  lot: { x: number; z: number; w: number; d: number } | null;
  tower: { x: number; z: number; h: number } | null;
  palms: Array<{ x: number; z: number; height: number; turn: number }>;
};

/**
 * Prawn Island 母题（影视制片厂岛，原创几何）：几座拱顶摄影棚 + 停车场 + 水塔，连岛短桥的引道从岛心往东。
 * 尺寸随岛缩放（f = r/45，夹在 0.6–1.2）；放不下的件就不放。
 */
export function isletStudio(radius: number, seed: number): IsletStudio {
  const r = radius; const usable = r * 0.74; const f = Math.max(0.6, Math.min(1.2, r / 45));
  const fits = (x: number, z: number, hw: number, hd: number) =>
    [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]].every(([dx, dz]) => Math.hypot(x + dx, z + dz) < usable && !onRoadBand(x + dx, z + dz, 0, -4, 8));
  const stages: IsletStudio["stages"] = [];
  const w = 11 * f; const d = 20 * f; const h = 7 * f;
  for (const [x, z] of [[-0.42 * r, -0.3 * r], [-0.42 * r, 0.3 * r], [0.05 * r, -0.42 * r], [0.05 * r, 0.42 * r]]) {
    if (!fits(x, z, w / 2 + 1, d / 2 + 1) || stages.some((s) => Math.abs(s.x - x) < w + 3 && Math.abs(s.z - z) < d + 3)) continue;
    stages.push({ x, z, w, d, h });
  }
  const lotW = 16 * f; const lotD = 10 * f; const lx = 0.4 * r; const lz = 0.35 * r;
  const lot = fits(lx, lz, lotW / 2, lotD / 2) && !stages.some((s) => Math.abs(s.x - lx) < (s.w + lotW) / 2 + 2 && Math.abs(s.z - lz) < (s.d + lotD) / 2 + 2)
    ? { x: lx, z: lz, w: lotW, d: lotD } : null;
  const tx = 0.38 * r; const tz = -0.32 * r;
  const tower = fits(tx, tz, 3, 3) && !stages.some((s) => Math.abs(s.x - tx) < s.w / 2 + 4 && Math.abs(s.z - tz) < s.d / 2 + 4) ? { x: tx, z: tz, h: 11 * f } : null;
  const palms: IsletStudio["palms"] = [];
  for (let k = 0; k < 14; k += 1) {
    const a = (k / 14) * Math.PI * 2; const rr = usable * (0.82 + hash(seed, k) * 0.12);
    const x = Math.cos(a) * rr; const z = Math.sin(a) * rr;
    if (onRoadBand(x, z, 0, -4, 8)) continue;
    palms.push({ x, z, height: m(REAL.palm.min + hash(seed, 40 + k) * 4), turn: hash(seed, 80 + k) * Math.PI * 2 });
  }
  return { stages, lot, tower, palms };
}
