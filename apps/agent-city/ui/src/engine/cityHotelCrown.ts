/**
 * 海滨会话酒店·屋顶白格栅鳍片冠（backlog L-1，P0）。
 *
 * 后现代迈阿密度假酒店的「roof fin / brise-soleil」：一排垂直于楼长轴的白色薄板
 * 等距排在屋顶，是整条海滨天际线最有辨识度的轮廓断点。本模块只产出冠的**纯函数
 * 几何方案**（每片一块 Box 的局部位姿尺寸），不建材质、不建网格——材质与实例化
 * 批次由主线程统一持有（与 cityParts.applyConstruction 的 roofProfiles 同一套模式）。
 *
 * 坐标系：楼底面中心为原点（x/z 与 applyConstruction 的楼中心同系，x = 楼长轴），
 * y 自地面起算。主线程按 slot.yaw 把局部 (x,z) 旋进世界（与 deco 分支同一套旋转），
 * rotY 追加在 yaw 之上——鳍片天然垂直于长轴，故恒为 0。
 *
 * 确定性：无 Math.random / Date，全部随机经内部 FNV-1a（与 cityModel.hashSeed 同
 * 算法同常量）。不直接 import hashSeed 是因为本模块按契约只准 import three；对
 * seed 先加盐再哈希，是为了与 building.seed 的既有用途（archetype/facade/roofKind
 * 都直接拿 seed 阈值）解相关——否则「有无冠」会和楼型/立面系统性地绑在一起。
 */

import * as THREE from "three";

/** 鳍片数的硬上限：实例网格 capacity 按它预留（槽位数 × HOTEL_CROWN_MAX_FINS）。 */
export const HOTEL_CROWN_MAX_FINS = 9;

/** 一块冠件：薄 Box 的局部中心位姿与全尺寸（sx/sy/sz 为 Box 三轴全长，非半长）。 */
export type CrownPiece = { x: number; y: number; z: number; sx: number; sy: number; sz: number; rotY: number };

/** FNV-1a + splitmix32 终值混淆 → [0,1)。与 cityModel.hashSeed 同算法起步：仓内一切
 *  「随机」都必须可复现，而纯函数契约禁止本模块带 three 之外的 import，故就地内联。
 *  终值混淆是必须的：FNV 对只差末字符的短串（seed=1..8 这类循环下标）输出会挤在
 *  很窄的区间里，验收网格的 null 率会失真；接一道 splitmix 终值打散后，整数下标与
 *  真实调用方传入的 [0,1) 浮点 seed（building.seed = hashSeed(session_ref)）都均匀。 */
function crownRand(seed: number, salt: string): number {
  let hash = 0x811c9dc5;
  const text = `${salt}:${seed}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  return ((hash ^ (hash >>> 15)) >>> 0) / 0x1_0000_0000;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * 海滨酒店冠方案。返回 null = 平顶无冠（约 30–40% 的 seed，避免整排同冠；
 * 另含矮楼规则）。同输入恒同输出。
 *
 * 参数化规则（世界单位）：
 * - 冠只给楼高 ≥ 12 的酒店：8–11 的是装饰艺术低层酒店（facadeFor 的海滨规则），
 *   格栅冠会压过楼体本身；≥12 后冠不缩、随高度从 3 长到 5（缩放而非阉割）。
 * - 鳍片数随楼宽：round(slotWidth/3.2) 夹在 5..9——楼宽 19.5–28.6 时得 6..9 片，
 *   片距 2.9–3.3，读成均匀「梳齿」而不是栅栏。
 * - 鳍片：厚 0.3–0.5、高 3–5（均随楼高归一增长），横向跨楼进深的 82%（比楼体
 *   0.9×slotDepth 略内收，避免外挑）；沿长轴占槽宽的 84%、两端各留 8% 空白——
 *   参考类型学里冠从不顶满山墙，轮廓才有「戴冠」而非「加栅栏」的读感。
 * - stripY：冠底霓虹带的 y（楼高 +0.55），带子恰好穿在鳍片下三分之一处，
 *   夜里从鳍片缝隙透光——brise-soleil 的标志性夜景。
 */
export function hotelCrownPlan(
  slotWidth: number,
  slotDepth: number,
  buildingHeight: number,
  seed: number,
): { fins: CrownPiece[]; stripY: number } | null {
  // 脏数据防御：非正数的槽位/楼高画不出任何合法冠。
  if (!(slotWidth > 0) || !(slotDepth > 0) || !(buildingHeight > 0)) return null;
  // 矮楼不给冠：低层装饰艺术酒店有自己的水平饰带语言，再叠格栅梳齿会互相打架。
  // 矮楼门限放宽到 6：装饰艺术酒店多为低层（曾 <12 不给冠，海滨几乎一顶冠都没有）。
  if (buildingHeight < 6) return null;
  // seed 门控：≈35% 平顶。阈值 0.35 落在契约的 30–40% 与 backlog「60–80% 加冠」交集内。
  if (crownRand(seed, "hotel-crown-gate") < 0.35) return null;

  // 楼高归一（8–75 的会话楼高楼截断到 12–75 的冠适应段）：矮楼冠 3 高、高楼冠 5 高。
  const heightNorm = clamp((buildingHeight - 12) / 63, 0, 1);
  const finHeight = 3 + heightNorm * 2;
  const finThickness = 0.3 + heightNorm * 0.2;
  // 横向跨进深 82%：楼体进深是 0.9×slotDepth，鳍片再收一点，两面都不外挑。
  const finSpan = slotDepth * 0.82;
  const finCount = clamp(Math.round(slotWidth / 3.2), 5, HOTEL_CROWN_MAX_FINS);
  // 沿长轴的鳍片中心带：占槽宽 84%，等距铺满。
  const spread = slotWidth * 0.84;
  const pitch = finCount > 1 ? spread / (finCount - 1) : 0;
  // y 用 Box 中心放置：鳍片底埋进屋顶板 0.12（封顶时屋顶板顶面 ≈ 楼高 −0.01），
  // 接缝藏在实体里，冠和楼读成一体而不是浮在楼上的零件。
  const finY = buildingHeight + finHeight / 2 - 0.12;

  const fins: CrownPiece[] = [];
  for (let index = 0; index < finCount; index += 1) {
    fins.push({
      x: -spread / 2 + index * pitch,
      y: finY,
      z: 0,
      sx: finThickness,
      sy: finHeight,
      sz: finSpan,
      // 实例网格只有 yaw 旋转、无俯仰；鳍片本来就垂直于长轴，无需额外转。
      rotY: 0,
    });
  }
  // 冠底霓虹带：略高于鳍片底、穿在鳍片下三分之一；带子厚度/深度都刻意与鳍片
  // 错开（主线程画 ~0.28 薄板），共面会闪 z-fighting。
  const stripY = buildingHeight + 0.55;
  return { fins, stripY };
}
