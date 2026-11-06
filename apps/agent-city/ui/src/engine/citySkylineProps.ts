/**
 * 城市尺度符号（backlog L-2）：屋顶立牌与路边双柱广告牌的纯函数造型模块。
 *
 * 为什么是纯函数：选址/概率筛选/实例化都由主线程（cityParts 的 instancedMesh 批次）负责，
 * 这里只回答「给定屋顶/地块，这组牌长什么样」——同输入恒定输出，可在无浏览器环境下用
 * esbuild 切片 + 断言脚本验收（沿用 verify-react-city-infrastructure.mjs 的做法）。
 *
 * 坐标与件约定（与 cityParts 的 compose 完全对齐）：
 *  - engine 里的 BOX 是 `BoxGeometry(1,1,1).translate(0, 0.5, 0)`（底面锚定），
 *    compose(x, y, z, yaw, sx, sy, sz) 的 y 是件的底面。因此 PropPiece.y = 底面 y，
 *    (x, z) = 底面中心，件体占据 [y, y + sy]。
 *  - rotY 只绕 y 轴（compose 的欧拉只有 y 分量，任何俯仰/侧倾都无法表达，
 *    所以 backlog 里「略前倾 5°」在当前实例化模式下不实现——所有件 yaw-only）。
 *  - 材质由主线程统一建：posts/panel 走哑光件，frame/stripes 是夜间霓虹/实例色的载体，
 *    所以拆成独立数组，方便各挂一个 InstancedMesh。
 *
 * 合规边界（CITY_LANDMARK_BACKLOG §1 + CITY_VICE_THEME_SPEC §1.2）：
 *  - 面板装饰只有 seed 生成的 2–3 条抽象色条（竖/横），无任何文字、图形字符或品牌联想；
 *    参考截图只用于类型学研究（双柱大牌的尺寸节奏），几何为自有参数化构造。
 */

import * as THREE from "three";

/** 单个造型件：底面锚定的盒子（语义同 cityParts 的 compose），rotY 仅绕 y 轴。 */
export type PropPiece = { x: number; y: number; z: number; sx: number; sy: number; sz: number; rotY: number };

/** 屋顶立牌：双柱 + 面板 + 周圈霓虹描边（4 件）+ 抽象色条（2–3 件）。 */
export type RooftopSignPlan = { posts: PropPiece[]; panel: PropPiece; frame: PropPiece[]; stripes: PropPiece[] };

/** 路边双柱牌：柱/面板（pieces）+ 周圈霓虹描边 + 抽象色条。 */
export type RoadsideSignPlan = { pieces: PropPiece[]; frame: PropPiece[]; stripes: PropPiece[] };

/** 屋顶立牌的关键尺寸（世界单位）：
 *  面板 6×3（高宽比 2:1，参考双柱大牌的通用节奏）、面板底离屋顶面 2.5（越过女儿墙
 *  与屋顶杂物的视线高度，从街面才能读到整块板）、描边厚 0.2/深 0.38（比面板 0.3 深，
 *  正反两面都露出发光圈）。整组外廓 6.4×0.38，占 ≥7.6 宽屋顶的面积 < 3%。 */
const ROOF_PANEL_W = 6;
const ROOF_PANEL_H = 3;
const ROOF_PANEL_T = 0.3;
const ROOF_CLEAR = 2.5;
const ROOF_FRAME_T = 0.2;
const ROOF_FRAME_D = 0.38;
/** 屋顶自查余量：描边外廓(6.4) + 每侧 0.6 的呼吸边。长边不足就不出牌（返回 null）。 */
const ROOF_FIT_LONG = ROOF_PANEL_W + 2 * ROOF_FRAME_T + 1.2;
/** 横向最小净深：描边深 0.38 + 余量，防止把牌立在极窄的条形屋顶上。 */
const ROOF_FIT_CROSS = 2.4;

/** 路边双柱牌的关键尺寸：
 *  面板 8×4、底边离地 8–10（越过行道树冠 ~8m 才在主干道视角成立，参考街道尺度的牌面节奏）、
 *  双柱落地间距 5.4（内收 2.6×2，柱在面板两端内侧，是双柱大牌的标准柱距）、
 *  柱底精确落在 groundY（起伏地形上从路面起算）。 */
const ROAD_PANEL_W = 8;
const ROAD_PANEL_H = 4;
const ROAD_PANEL_T = 0.35;
const ROAD_FRAME_T = 0.22;
const ROAD_FRAME_D = 0.46;
const ROAD_POST_SPACING = 5.4;

/**
 * 子种子：把 (seed, salt) 雪崩成互不相关的 [0,1) 随机数。
 * 调用方传入的 seed 是 hashSeed（cityModel.ts）的 [0,1) 浮点；一个 seed 要同时决定
 * 出牌概率/朝向/色条等多项独立决策，直接复用同一个数会让这些决策全部相关。
 * 先把 seed 折成 24bit 整数再走 murmur 风格雪崩——用取模而不是位截断，
 * 是为了整数 seed（自检脚本里的 1..8）不会被折成同一个 0。
 */
function sub(seed: number, salt: number): number {
  let h = (Math.floor(seed * 0x100_0000) % 0x7fff_ffff) >>> 0;
  h = (h ^ Math.imul(salt + 1, 0x9e37_79b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85eb_ca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2_ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x1_0000_0000;
}

/** 周圈霓虹描边：四条细盒拼一圈，单独成组，夜间挂自发光材质、白天当普通描边。
 *  框体比面板深（depth > 面板厚），正反两面都露出一圈亮边；上下框各咬住面板
 *  边缘 0.3t，避免共面闪烁；左右框端头内嵌 0.02 让框与面板端面互穿而非共面。 */
function frameRing(width: number, height: number, t: number, depth: number, baseY: number, z: number, yaw: number): PropPiece[] {
  return [
    { x: 0, y: baseY - t * 0.3, z, sx: width + 2 * t, sy: t, sz: depth, rotY: yaw },
    { x: 0, y: baseY + height - t * 0.7, z, sx: width + 2 * t, sy: t, sz: depth, rotY: yaw },
    { x: -(width / 2 + t / 2 - 0.02), y: baseY - t * 0.3, z, sx: t, sy: height + 0.6 * t, sz: depth, rotY: yaw },
    { x: width / 2 + t / 2 - 0.02, y: baseY - t * 0.3, z, sx: t, sy: height + 0.6 * t, sz: depth, rotY: yaw },
  ];
}

/** 抽象色条：2–3 条竖向或横向色带，等距分布保证互不重叠；厚度略大于面板，
 *  两面各凸出，正反立面读到的构图一致（面板从两侧看都成立）。 */
function stripeBelt(width: number, height: number, baseY: number, z: number, yaw: number, seed: number, saltBase: number, thickness: number): PropPiece[] {
  const vertical = sub(seed, saltBase) < 0.6;
  const count = sub(seed, saltBase + 1) < 0.45 ? 3 : 2;
  const stripes: PropPiece[] = [];
  for (let index = 0; index < count; index += 1) {
    const wobble = sub(seed, saltBase + 2 + index);
    if (vertical) {
      // 竖条：第 i 条的中心在 (i+1)/(n+1) 等分位，宽 0.5–0.85，高留 0.5–1.1 的上下边距。
      const h = height - 0.5 - wobble * 0.6;
      stripes.push({ x: -width / 2 + (width * (index + 1)) / (count + 1), y: baseY + (height - h) / 2, z, sx: 0.5 + wobble * 0.35, sy: h, sz: thickness, rotY: yaw });
    } else {
      // 横条：中心在等分位，厚 0.45–0.75，宽收进面板 0.6–1.8，避免顶到描边。
      const w = width - 0.6 - wobble * 1.2;
      const h = 0.45 + wobble * 0.3;
      stripes.push({ x: 0, y: baseY + (height * (index + 1)) / (count + 1) - h / 2, z, sx: w, sy: h, sz: thickness, rotY: yaw });
    }
  }
  return stripes;
}

/**
 * 屋顶立牌（商业楼顶的尺度符号）。
 *
 * 局部原点 = 屋顶中心（x, z 与楼中心同系，主线程再按 slot.yaw 旋转 + 楼心平移）；
 * y 从地面起算，roofY 是屋顶面（可站人的顶面）y；面板长轴 = 局部 +X，牌立在
 * 屋顶较长的一边上（长轴贴屋顶长轴，保证放得下且从主干道方向可见）。
 *
 * 是否出牌由 seed 在函数内判定：目标 ~20% 的商业楼有牌，调用方只筛楼、不判概率。
 * 同输入恒定输出；整组不超屋顶缘（长边 < 7.6 或净深 < 2.4 时返回 null）。
 */
export function rooftopSignPlan(roofWidth: number, roofDepth: number, roofY: number, seed: number): RooftopSignPlan | null {
  if (!Number.isFinite(roofWidth) || !Number.isFinite(roofDepth) || !Number.isFinite(roofY)) return null;
  if (roofWidth < ROOF_FIT_LONG && roofDepth < ROOF_FIT_LONG) return null;
  if (Math.min(roofWidth, roofDepth) < ROOF_FIT_CROSS) return null;
  // 出牌概率 ~20%：数量上限守卫要求「有上下限」，函数内判定让调用方只做分区/楼高筛选。
  // 出牌率 20% → 45%：候选已改为区内地价前列的楼（cityParts），不再只限 commercial 专区。
  if (sub(seed, 0) >= 0.45) return null;

  // 牌的长轴贴屋顶的长边：面板宽 6 沿 roofWidth 时 yaw=0，沿 roofDepth 时 yaw=π/2。
  const yaw = roofWidth >= roofDepth ? 0 : Math.PI / 2;

  const panelBase = roofY + ROOF_CLEAR;
  const panel: PropPiece = { x: 0, y: panelBase, z: 0, sx: ROOF_PANEL_W, sy: ROOF_PANEL_H, sz: ROOF_PANEL_T, rotY: yaw };
  // 双柱：0.3×0.26 细柱立在面板两端内侧（±1.9），从屋顶面起、上端伸进面板厚度内
  // 被面板遮住——柱顶与面板之间不出现可见缝，柱身只在面板以下暴露（大牌的经典读法）。
  const posts: PropPiece[] = [-1.9, 1.9].map((px) => ({ x: px, y: roofY, z: 0, sx: 0.3, sy: ROOF_CLEAR + 1.9, sz: 0.26, rotY: yaw }));
  const frame = frameRing(ROOF_PANEL_W, ROOF_PANEL_H, ROOF_FRAME_T, ROOF_FRAME_D, panelBase, 0, yaw);
  const stripes = stripeBelt(ROOF_PANEL_W, ROOF_PANEL_H, panelBase, 0, yaw, seed, 10, ROOF_PANEL_T + 0.08);
  return { posts, panel, frame, stripes };
}

/**
 * 路边双柱广告牌（主干道商业段的招牌，是否放置由调用方决定，本函数恒返回 plan）。
 *
 * 局部原点 = 牌位落地点（主线程用 roadEdges + SegmentIndex 选好的净空点）；
 * 【面板朝向约定】面板法线 = 局部 +Z：面板是 8(x)×4(y)×0.35(z) 的盒，法线沿局部 z 轴，
 * 参数 yaw 就是「局部 +Z（牌面朝向车流的一面）」的世界朝向。所有件 rotY = yaw，
 * 主线程按 cityParts 同款旋转放置：world = origin + (lx·cos yaw + lz·sin yaw, y, -lx·sin yaw + lz·cos yaw)。
 * 色条两面凸出，背面（-Z）构图与正面一致，双向车流都读到完整牌面。
 */
export function roadsideSignPlan(yaw: number, groundY: number, seed: number): RoadsideSignPlan {
  // 底边离地 8–10：由 seed 在区间内取值；clamp 是防御——上游 seed 再怪也收在可读高度带。
  const h0 = THREE.MathUtils.clamp(8 + sub(seed, 20) * 2, 8, 10);
  const panelBase = groundY + h0;
  const panel: PropPiece = { x: 0, y: panelBase, z: 0, sx: ROAD_PANEL_W, sy: ROAD_PANEL_H, sz: ROAD_PANEL_T, rotY: yaw };
  // 双柱：0.45×0.34，落地间距 5.4，柱底精确落在 groundY（贴住路面）；上段藏进面板厚度内，
  // 只在面板以下暴露成两根落地柱。
  const half = ROAD_POST_SPACING / 2;
  const posts: PropPiece[] = [-half, half].map((px) => ({ x: px, y: groundY, z: 0, sx: 0.45, sy: h0 + 2, sz: 0.34, rotY: yaw }));
  const frame = frameRing(ROAD_PANEL_W, ROAD_PANEL_H, ROAD_FRAME_T, ROAD_FRAME_D, panelBase, 0, yaw);
  const stripes = stripeBelt(ROAD_PANEL_W, ROAD_PANEL_H, panelBase, 0, yaw, seed, 30, ROAD_PANEL_T + 0.08);
  return { pieces: [...posts, panel], frame, stripes };
}
