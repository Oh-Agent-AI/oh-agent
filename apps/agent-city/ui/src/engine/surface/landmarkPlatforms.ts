/**
 * 可行驶的地标平台（2026-10-22）：海上帆形歌剧院的填海小岛、机场岛的填海平台。纯 CPU，无 THREE。
 *
 * 两处原本都是「看得见的桥，车开不上去」：歌剧院的堤道是路网里的真桥面，但岛端没有可落的路面，桥面停在
 * 半空并在尽头加了一道横栏；机场的堤道只是装饰网格，驾驶面里根本没有它。平台登记在这里，三处读同一份：
 * - 桥面落地（structureCompiler.bridgeDeckProfile）：桥端在平台里 → 桥面落到平台顶面，不再加尽头横栏；
 * - 驾驶面（compileSurface）：平台顶面编成一块可行驶路面，桥面与它同层接通；
 * - 渲染 / 碰撞：平台本身是模型的一部分（sailOpera 的 island 圆台、cityAirport 的填海平台），岛上建筑走地标碰撞。
 */
import { DetMath as Math } from "../detMath"; // 跨引擎确定性：见 detMath.ts
import type { CityLayout, Vec2 } from "../cityLayout";
import { AIRPORT_PLATFORM } from "../airportPlan";

/** 平台顶面之上的路面抬升（同普通路面 ROAD_SURFACE_LIFT：防 z-fighting，也让车轮落在看得见的顶面上）。 */
export const PLATFORM_SURFACE_LIFT = 0.04;
/** 歌剧院小岛：sailOpera.ts 的 island 圆台顶面半径 = radius + 2，顶面 y = 0.3（与岸滩齐平）。 */
const OPERA_TOP = 0.3;
const OPERA_RIM = 2;
/** 可行驶边界比平台边缘往里收这么多（车轮不压到圆台倒角 / 护岸上）。 */
const EDGE_INSET = 1;

export type LandmarkPlatform = Readonly<{
  id: string;
  /** 路面高度（平台顶面 + 抬升）。 */
  y: number;
  /** 可行驶区域的外轮廓（逆时针，XZ）。 */
  outline: readonly Vec2[];
  contains: (x: number, z: number) => boolean;
}>;

export type PlatformLayout = Partial<Pick<CityLayout, "landmarks" | "airport">>;

const cache = new WeakMap<object, LandmarkPlatform[]>();
const EMPTY: LandmarkPlatform[] = [];

/** 布局里的全部可行驶地标平台（按地标数组 / 机场规划对象缓存）。 */
export function landmarkPlatforms(layout: PlatformLayout): readonly LandmarkPlatform[] {
  const key = (layout.landmarks ?? layout.airport ?? null) as object | null;
  if (!key) return EMPTY;
  const hit = cache.get(key);
  if (hit && (layout.airport ?? null) === (hit as unknown as { airport?: unknown }).airport) return hit;
  const out: LandmarkPlatform[] = [];
  for (const landmark of layout.landmarks ?? []) {
    // 只有海上岛变体（有 shore：堤道从岸点来）才有填海平台；岸上的歌剧院站在地面上，没有平台可落。
    if (landmark.kind !== "sail-opera" || !landmark.shore) continue;
    const r = landmark.radius + OPERA_RIM - EDGE_INSET;
    const outline = Array.from({ length: 40 }, (_, i) => { const a = (i / 40) * Math.PI * 2; return { x: landmark.x + Math.cos(a) * r, z: landmark.z + Math.sin(a) * r }; });
    out.push(Object.freeze({ id: `platform:${landmark.id ?? "sail-opera"}`, y: OPERA_TOP + PLATFORM_SURFACE_LIFT, outline: Object.freeze(outline),
      contains: (x: number, z: number) => Math.hypot(x - landmark.x, z - landmark.z) <= r }));
  }
  const airport = layout.airport;
  if (airport) {
    // 本地 x 沿海岸（长边）、本地 z = 离岸方向（cityAirport：island.rotation.y = yaw）。
    const hl = AIRPORT_PLATFORM.length / 2 - EDGE_INSET, hw = AIRPORT_PLATFORM.width / 2 - EDGE_INSET;
    const ox = airport.outward.x, oz = airport.outward.z; const tx = oz, tz = -ox; // 沿岸方向
    const at = (lx: number, lz: number) => ({ x: airport.centre.x + tx * lx + ox * lz, z: airport.centre.z + tz * lx + oz * lz });
    const outline = [at(-hl, -hw), at(hl, -hw), at(hl, hw), at(-hl, hw)];
    const area = outline.reduce((n, p, i) => { const q = outline[(i + 1) % 4]; return n + p.x * q.z - q.x * p.z; }, 0);
    out.push(Object.freeze({ id: "platform:airport", y: AIRPORT_PLATFORM.top + PLATFORM_SURFACE_LIFT, outline: Object.freeze(area < 0 ? outline.reverse() : outline),
      contains: (x: number, z: number) => {
        const dx = x - airport.centre.x, dz = z - airport.centre.z;
        return Math.abs(dx * tx + dz * tz) <= hl && Math.abs(dx * ox + dz * oz) <= hw;
      } }));
  }
  (out as unknown as { airport?: unknown }).airport = layout.airport ?? null;
  cache.set(key, out);
  return out;
}

/** (x, z) 在某个地标平台上时返回那里的路面高度，否则 null。 */
export function platformSurfaceAt(layout: PlatformLayout, x: number, z: number): number | null {
  for (const platform of landmarkPlatforms(layout)) if (platform.contains(x, z)) return platform.y;
  return null;
}

/** (x, z) 所在的地标平台（没有则 null）。 */
export function platformAt(layout: PlatformLayout, x: number, z: number): LandmarkPlatform | null {
  for (const platform of landmarkPlatforms(layout)) if (platform.contains(x, z)) return platform;
  return null;
}
