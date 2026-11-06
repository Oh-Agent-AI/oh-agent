import type { BuildingModel, Part } from "../model";
import { declarePhysical } from "../physical";

const STONE = "#ece5d6";
const TRIM = "#d6ccb7";
const BRONZE = "#8a7a52";

/**
 * 地标「arch」：声明式 BuildingModel（批 1）。几何与旧 drawArch 逐位一致（golden/city-landmark-baseline.json 钉住）。
 * 凯旋门（细化）：基座 → 两侧墩身（每面一对附柱）→ 半圆拱券开口 → 檐口 → 顶楼 → 顶部雕像组。全部为通用古典语汇，不参照具体建筑。
 * 拱券内壁 = 开口半圆柱（cylinder.open + arc，双面）；拱圈线脚 = 半环（torus.arc）。
 */
export const archModel: BuildingModel = {
  id: "arch",
  group: "地标",
  semantics: "decor",
  title: "凯旋拱门",
  body: "立在主干道旁的纪念拱门。由岛屿种子挑选，不代表会话。",
  sitingKey: "landmark:arch",
  /** 物理声明（批 A）：占地 = 两墩并集，|x|<8 的开口是路面（凸包会把它误判成实体，spec §9 反例）。
   *  cap 只影响高度（h = min(cap,26)），XY 外廓与 cap 无关；基座 plinth [9×12]@±12.5 是地面接触面。 */
  physical: declarePhysical({
    modelId: "arch",
    modelRevision: "A1",
    footprint: { parts: [
      { shape: "rect", center: { x: -12.5, z: 0 }, width: 9, depth: 12 },
      { shape: "rect", center: { x: 12.5, z: 0 }, width: 9, depth: 12 },
    ] },
    /** 上层悬挑：拱券实体/檐口/顶楼横跨开口上方（x 至 ±16.3、z 至 ±5.3）——按设计悬在路面之上，不是地面障碍。 */
    overhang: { parts: [{ shape: "rect", center: { x: 0, z: 0 }, width: 33, depth: 11 }] },
    foundation: { kind: "ground", support: { parts: [
      { shape: "rect", center: { x: -12.5, z: 0 }, width: 9, depth: 12 },
      { shape: "rect", center: { x: 12.5, z: 0 }, width: 9, depth: 12 },
    ] }, maxRelief: 1.5, maxGap: 0.2, maxEmbed: 0.8, baseOffset: 0 },
    entrances: [
      { id: "north-passage", local: { x: 0, z: 6 }, outward: { x: 0, z: 1 }, width: 16, mode: "vehicle", required: true,
        approach: { parts: [{ shape: "rect", center: { x: 0, z: 12 }, width: 16, depth: 12 }] } },
      { id: "south-passage", local: { x: 0, z: -6 }, outward: { x: 0, z: -1 }, width: 16, mode: "vehicle", required: true,
        approach: { parts: [{ shape: "rect", center: { x: 0, z: -12 }, width: 16, depth: 12 }] } },
    ],
    notes: "两墩之间（|x|<8）是路面：并集空洞是契约核心反例；拱上构件（拱券/檐口）为上层悬挑。",
  }),
  geometry: ({ sizing }) => {
    const h = Math.min(sizing?.cap ?? 70, 26);
    const W = 31; const D = 9; const pierW = 7.5; const openW = W - pierW * 2; const springY = h * 0.55; // 开口 16：骑在 12 宽主干道上
    const parts: Part[] = [];
    // 基座只在两墩下：开口里是路面，不能被基座盖住。
    for (const side of [-1, 1]) parts.push({ kind: "box", at: [side * (openW / 2 + pierW / 2 + 0.75), 0, 0], size: [pierW + 1.5, 1.6, D + 3], role: "trim", color: TRIM });
    for (const side of [-1, 1]) {
      const cx = side * (openW / 2 + pierW / 2);
      parts.push({ kind: "box", at: [cx, 1.6, 0], size: [pierW, h, D], role: "wall", color: STONE }); // 墩身
      for (const face of [-1, 1]) for (const k of [-1, 1]) { // 每面一对附柱
        parts.push({ kind: "cylinder", at: [cx + k * 2.4, 2.8, face * (D / 2 + 0.35)], size: [1.2, h - 2.4, 1.2], radiusTop: 0.55, segments: 10, role: "trim", color: TRIM });
        parts.push({ kind: "box", at: [cx + k * 2.4, 1.6, face * (D / 2 + 0.35)], size: [1.6, 0.8, 1.2], role: "trim", color: TRIM });
      }
      parts.push({ kind: "box", at: [cx, springY + 3, D / 2 + 0.25], size: [3.4, 4.2, 0.4], anchor: "center", role: "trim", color: BRONZE }); // 浮雕板
    }
    // 拱券：开口上方实体 + 半圆柱面内壁（双面）。
    parts.push({ kind: "box", at: [0, 1.6 + springY + openW / 2, 0], size: [openW, h - springY - openW / 2, D], role: "wall", color: STONE });
    parts.push({ kind: "cylinder", id: "vault", at: [0, 1.6 + springY, 0], size: [openW, D, openW], open: true, arc: [Math.PI / 2, Math.PI], segments: 24, bake: { x: Math.PI / 2 }, anchor: "center", side: "double", role: "wall", color: "#e2dac8" });
    parts.push({ kind: "torus", at: [0, 1.6 + springY, D / 2 + 0.05], radius: openW / 2 + 0.3, tube: 0.35, arc: Math.PI, segments: [6, 24], role: "trim", color: TRIM }); // 拱圈线脚
    parts.push({ kind: "box", at: [0, h + 1.6, 0], size: [W + 1.6, 1.1, D + 1.6], role: "trim", color: TRIM }); // 檐口
    parts.push({ kind: "box", at: [0, h + 2.7, 0], size: [W - 2, 5, D - 1], role: "wall", color: STONE }); // 顶楼
    parts.push({ kind: "box", at: [0, h + 5.2, (D - 1) / 2 + 0.2], size: [W - 6, 2.2, 0.3], anchor: "center", role: "trim", color: BRONZE }); // 题铭板（无文字）
    parts.push({ kind: "box", at: [0, h + 7.7, 0], size: [W - 1, 0.7, D], role: "trim", color: TRIM });
    parts.push({ kind: "box", at: [0, h + 8.4, 0], size: [5, 2.2, 3], role: "trim", color: BRONZE }); // 顶部雕像组（抽象体块）
    parts.push({ kind: "cone", at: [0, h + 10.6, 0], size: [2.2, 3.4, 2.2], segments: 6, role: "trim", color: BRONZE });
    return parts;
  },
  lifecycle: {},
  picking: { decorId: "decor:landmark:arch", category: "致敬地标 · 装饰", describe: "由岛屿种子挑选的城市地标。不代表任何会话，不随数据变化。" },
};
