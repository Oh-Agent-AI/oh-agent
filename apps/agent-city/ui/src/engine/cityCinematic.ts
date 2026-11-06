/**
 * 无人机航拍：从布局与模型推导一条电影镜头路径（纯函数、确定性——同一座城永远同一条片子）。
 *
 * 镜头语言（约 32s）：
 *   1. 远海推近（establishing）：高空从海上压向海岸，城市在脚下展开。
 *   2. 贴河低飞（river run）：沿河道低空穿城，两岸楼群从身边掠过。
 *   3. 环绕地标（hero orbit）：绕全城最高的楼半圈，仰拍。
 *   4. 掠过城区（district pass）：依次掠过各执行环境城区。
 *   5. 拉升收尾（pull-out）：边后退边上升，落到全城天际线全景。
 * 生长同步：镜头前 70% 把时间游标从窗口起点推到终点——城市在镜头里从空地长到现在。
 */

import * as THREE from "three";
import type { CityModel } from "../cityModel";
import type { CityLayout } from "./cityLayout";

export type CinematicCard = { atSec: number; untilSec: number; kind: "title" | "district" | "finale"; text: string; detail?: string };

export type CinematicPlan = {
  durationSec: number;
  /** 播放秒数 → 相机位置 / 注视点。 */
  position: (seconds: number) => THREE.Vector3;
  target: (seconds: number) => THREE.Vector3;
  /** 播放秒数 → 时间游标（ms）：生长回放与镜头同步。 */
  cursor: (seconds: number) => number;
  cards: CinematicCard[];
  /** 各关键帧的播放秒数与离地高度（诊断/节奏守卫用）。 */
  keyTimes: Array<{ seconds: number; altitude: number }>;
};

type Key = { pos: [number, number, number]; look: [number, number, number]; card?: number };

/** 只用 ease 过的单调参数去采样曲线：段与段之间速度连续，不出现「停顿—猛冲」。 */
function smootherstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export type CinematicCut = "full" | "short";

/** cut="short"：只飞最高楼附近约 125° 的一段弧线（开场推近 → 绕向最高楼 → 拉升），适合分享的 30–45 秒版。 */
/** 短版片长上限：分享片 30–45 秒，最长不超过 ~52 秒（守卫 18–55）。 */
const SHORT_MAX_SECONDS = 52;
// 2000 栋的 1 档大岛航线更长：再给两档更窄的弧，短片仍压在 52s 内。
const SHORT_SWEEPS = [1.4, 1.2, 1.0, 0.85, 0.7, 0.55];

export function planCinematic(layout: CityLayout, model: CityModel, heights: Map<string, { x: number; z: number; height: number; ground: number }>, options: { cut?: CinematicCut } = {}): CinematicPlan {
  if (options.cut !== "short") return planRoute(layout, model, heights, options, Math.PI * 2);
  // 短版：弧线里落进一个城区停靠点会让航线绕远（seed 42 港口贴岸后布局微移，短片从 40s 涨到 60s）。
  // 不靠压缩时间（会把视觉速度推过 0.7 rad/s），而是收窄弧线重排，直到片长落进上限。
  let plan = planRoute(layout, model, heights, options, SHORT_SWEEPS[0]);
  for (let index = 1; index < SHORT_SWEEPS.length && plan.durationSec > SHORT_MAX_SECONDS; index += 1) {
    plan = planRoute(layout, model, heights, options, SHORT_SWEEPS[index]);
  }
  return plan;
}

function planRoute(layout: CityLayout, model: CityModel, heights: Map<string, { x: number; z: number; height: number; ground: number }>, options: { cut?: CinematicCut }, shortSweep: number): CinematicPlan {
  const { left, right, north, south } = layout.urbanBounds;
  const cx = (left + right) / 2;
  const cz = (north + south) / 2;
  const span = Math.max(right - left, south - north);
  const groundAt = (x: number, z: number) => Math.max(0, layout.terrain.height(x, z));

  // 主角：全城最高的楼（没有楼时退回城市中心）。G1 航线不再单独环绕它，绕岛时自然经过。
  let hero = { x: cx, z: cz, height: 30, ground: groundAt(cx, cz) };
  for (const anchor of heights.values()) if (anchor.height > hero.height) hero = anchor;

  const keys: Key[] = [];
  const push = (pos: [number, number, number], look: [number, number, number], card?: number) => keys.push({ pos, look, card });

  // ── 航线（G1 种子地形版）：海上推近 → 绕城市核心一圈（经过每个城区时拉近、降低）→ 拉升全景。
  // 曾是「贴河低飞 → 环绕最高楼 → 逐个飞城区」一串任意顺序的控制点：换成种子地形后城区常在
  // 死胡同半岛上，路线在机位上折返（seed 7 / 42 反复出现，单点修补停不下来）。绕岛一圈时方位角
  // 单调递增，结构上不可能掉头；最高楼与最长的桥作为「特写停靠点」落在绕行路线上（见 features）。
  const center = layout.core ?? { x: cx, z: cz };
  const ranked = [...layout.districts]
    .map((d) => ({ layout: d, data: model.districts.find((m) => m.id === d.id) }))
    .filter((d) => d.data && d.layout.slots.size > 0)
    .sort((a, b) => (b.data!.tokensTotal - a.data!.tokensTotal));
  // 用该区楼的实际质心：district.center 是规划圆心，楼按执行环境锚点落位，二者可能隔着半座城。
  const centroid = (district: (typeof ranked)[number]) => {
    const slots = [...district.layout.slots.values()];
    return { x: slots.reduce((sum, slot) => sum + slot.x, 0) / slots.length, z: slots.reduce((sum, slot) => sum + slot.z, 0) / slots.length };
  };
  const stops = ranked.slice(0, 4).map((district) => {
    const c = centroid(district);
    return { district, c, angle: Math.atan2(c.z - center.z, c.x - center.x), distance: Math.hypot(c.x - center.x, c.z - center.z) };
  }).sort((a, b) => a.angle - b.angle);
  const ordered = stops.map((stop) => stop.district);
  // 起点方位：第一个城区之前 0.6 rad（从它前方的海上飞进来），然后逆时针一圈。
  const heroAngle = Math.atan2(hero.z - center.z, hero.x - center.x);
  const short = options.cut === "short" && hero.height > 30;
  const sweepSpan = short ? shortSweep : Math.PI * 2;
  const lead = short ? 0.4 : 1; // 开场推近 / 收尾拉升的距离系数：短版压缩
  const phi0 = short ? heroAngle - 0.9 : stops.length ? stops[0].angle - 0.6 : 0;
  const unwrap = (angle: number) => { let a = angle; while (a < phi0) a += Math.PI * 2; while (a >= phi0 + Math.PI * 2) a -= Math.PI * 2; return a; };
  const stopAngles = stops.map((stop) => unwrap(stop.angle));
  const angularGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const cruiseRadius = Math.max(140, ...stops.map((stop) => stop.distance + 60));
  /** 方位 φ 处的半径/高度/注视点：离城区越近越贴近它（半径收到城区外缘 +60、高度降到 62）。 */
  // 特写停靠点（G4 补回「环绕最高楼」「贴河低飞」两段）：同样落在绕行的方位角上，经过时相机靠近、降低并对准目标——
  // 方位角仍单调递增，所以不会折返。最高楼：相机退到楼外 90、高度取楼高 85%、看向楼身 60% 处；
  // 最长的桥（过河处）：贴近桥面 45 高、看向桥中点。
  type Feature = { angle: number; radius: number; height: number; look: { x: number; y: number; z: number } };
  const features: Feature[] = [];
  if (hero.height > 30) {
    features.push({ angle: Math.atan2(hero.z - center.z, hero.x - center.x), radius: Math.hypot(hero.x - center.x, hero.z - center.z) + 90, height: Math.max(40, hero.height * 0.85), look: { x: hero.x, y: hero.ground + hero.height * 0.6, z: hero.z } });
  }
  // C-3 三层景深（backlog）：海滨段中点外 25 的低空（24），前景棕榈步道 → 中景低层海滨带 → 远景城中塔群（注视全城之最）。
  const seaside = layout.seaside && !layout.seaside.degraded ? layout.seaside.samples.filter((s) => s.valid) : [];
  if (seaside.length > 4) {
    const s = seaside[Math.floor(seaside.length / 2)];
    features.push({ angle: Math.atan2(s.waterline.z - center.z, s.waterline.x - center.x), radius: Math.hypot(s.waterline.x - center.x, s.waterline.z - center.z) + 25, height: 24,
      look: { x: hero.x, y: hero.ground + Math.max(12, hero.height * 0.5), z: hero.z } });
  }
  const longestBridge = [...(layout.bridges ?? [])].sort((a, b) => b.length - a.length)[0];
  if (longestBridge) {
    const mid = { x: (longestBridge.from.x + longestBridge.to.x) / 2, z: (longestBridge.from.z + longestBridge.to.z) / 2 };
    features.push({ angle: Math.atan2(mid.z - center.z, mid.x - center.x), radius: Math.hypot(mid.x - center.x, mid.z - center.z) + 70, height: 45, look: { x: mid.x, y: 6, z: mid.z } });
  }
  const near = (phi: number) => {
    let weight = 0; let radius = 0; let look = { x: center.x, z: center.z }; let lookWeight = 0;
    stops.forEach((stop) => {
      const w = Math.exp(-((angularGap(phi, stop.angle) / 0.38) ** 2));
      weight += w; radius += w * (stop.distance + 60);
      if (w > lookWeight) { lookWeight = w; look = stop.c; }
    });
    const pull = Math.min(1, weight);
    const base = {
      radius: cruiseRadius * (1 - pull) + (weight > 0 ? radius / weight : cruiseRadius) * pull,
      height: 120 - 58 * pull,
      look: { x: center.x + (look.x - center.x) * lookWeight, y: 8, z: center.z + (look.z - center.z) * lookWeight },
    };
    for (const feature of features) {
      const w = Math.exp(-((angularGap(phi, feature.angle) / 0.3) ** 2));
      if (w < 0.01) continue;
      base.radius += (feature.radius - base.radius) * w;
      base.height += (feature.height - base.height) * w;
      base.look = { x: base.look.x + (feature.look.x - base.look.x) * w, y: base.look.y + (feature.look.y - base.look.y) * w, z: base.look.z + (feature.look.z - base.look.z) * w };
    }
    return base;
  };
  const orbitPoint = (phi: number) => {
    const n = near(phi);
    const x = center.x + Math.cos(phi) * n.radius;
    const z = center.z + Math.sin(phi) * n.radius;
    // 高度参考取周围 70 范围的地形均值（再不低于脚下地形）：海岸山崖处地形在 10 单位内从 0 升到几十，
    // 直接用脚下高度镜头会跟着跳（seed 42：单帧速度突变）。
    let sum = 0;
    for (let k = 0; k < 12; k += 1) { const a2 = (k / 12) * Math.PI * 2; sum += groundAt(x + Math.cos(a2) * 70, z + Math.sin(a2) * 70); }
    const reference = Math.max(groundAt(x, z), (sum / 12 + groundAt(x, z)) / 2);
    return { pos: [x, reference + n.height, z] as [number, number, number], look: [n.look.x, n.look.y, n.look.z] as [number, number, number] };
  };

  // 1. 远海推近：沿起点方位从海上高空压向城市。
  const dir0 = { x: Math.cos(phi0), z: Math.sin(phi0) };
  push([center.x + dir0.x * (cruiseRadius + span * 0.75 * lead), span * 0.42, center.z + dir0.z * (cruiseRadius + span * 0.75 * lead)], [center.x, 0, center.z]);
  push([center.x + dir0.x * (cruiseRadius + span * 0.3 * lead), span * 0.2, center.z + dir0.z * (cruiseRadius + span * 0.3 * lead)], [center.x, 0, center.z]);

  // 2. 绕岛一圈：每 18° 一个控制点；离城区方位最近的那个控制点挂字卡。
  const STEP = Math.PI / 10;
  const cardAt = new Map<number, number>();
  // 两个城区方位很近时会落到同一个控制点：后来的顺延到下一个空控制点（每个执行环境都要有自己的字卡）。
  stopAngles.forEach((angle, index) => {
    if (angle - phi0 > sweepSpan) return; // 短版只覆盖弧线内的城区
    let slot = Math.round((angle - phi0) / STEP);
    while (cardAt.has(slot) && slot < Math.round(sweepSpan / STEP)) slot += 1;
    cardAt.set(slot, index);
  });
  const steps = Math.round(sweepSpan / STEP);
  for (let i = 0; i <= steps; i += 1) {
    const point = orbitPoint(phi0 + i * STEP);
    push(point.pos, point.look, cardAt.get(i));
  }

  // 3. 拉升收尾：沿终点方位后退并升到全景。
  const phi1 = phi0 + sweepSpan;
  const dir1 = { x: Math.cos(phi1 + 0.3), z: Math.sin(phi1 + 0.3) };
  push([center.x + dir1.x * (cruiseRadius + span * 0.35 * lead), span * 0.42, center.z + dir1.z * (cruiseRadius + span * 0.35 * lead)], [center.x, 0, center.z]);
  push([center.x + dir1.x * (cruiseRadius + span * 0.7 * lead), span * 0.62, center.z + dir1.z * (cruiseRadius + span * 0.7 * lead)], [center.x, 10, center.z]);

  // 几何兜底：路线由布局推导，换地形总可能出现掉头。水平航向转弯超过 115° 时：
  // 不带字卡的过渡帧直接删掉；带字卡的城区机位沿转弯外侧角平分线外推（每次 30，最多 10 次），
  // 字卡与镜头都保留、路线改为绕弯（种子地形下相邻城区常要掉头，seed 7 / 42 曾在机位上折返）。
  const turnAt = (index: number) => {
    const [ax, , az] = keys[index - 1].pos;
    const [bx, , bz] = keys[index].pos;
    const [cx2, , cz2] = keys[index + 1].pos;
    const inX = bx - ax, inZ = bz - az, outX = cx2 - bx, outZ = cz2 - bz;
    const inLen = Math.hypot(inX, inZ); const outLen = Math.hypot(outX, outZ);
    if (inLen * outLen < 1e-6) return { turn: Math.PI, din: { x: 0, z: 0 }, dout: { x: 0, z: 0 } };
    const din = { x: inX / inLen, z: inZ / inLen }; const dout = { x: outX / outLen, z: outZ / outLen };
    return { turn: Math.acos(Math.max(-1, Math.min(1, din.x * dout.x + din.z * dout.z))), din, dout };
  };
  const LIMIT = (115 * Math.PI) / 180;
  for (let changed = true, guard = 0; changed && guard < 200; guard += 1) {
    changed = false;
    for (let index = 1; index < keys.length - 1; index += 1) {
      const { turn, din, dout } = turnAt(index);
      if (turn <= LIMIT) continue;
      // 短版的城区字卡只是「弧线恰好扫过」的附带镜头，不值得为它外推几百单位绕一大圈
      // （seed 42：外推 750 把 40 秒的短片拖到 60 秒）——直接删掉；完整版仍要求每个城区都有镜头，照旧外推。
      if (keys[index].card === undefined || short) { keys.splice(index, 1); changed = true; break; }
      let side = { x: din.x - dout.x, z: din.z - dout.z };
      const len = Math.hypot(side.x, side.z);
      // 近乎掉头（>150°，如死胡同半岛上的城区）时角平分线落在航线上、外推无效：改为垂直来向侧推，
      // 让路线在城区旁兜一个弯再出来；侧推距离放宽到 750。
      const reversal = turn > (150 * Math.PI) / 180;
      side = reversal || len < 0.3 ? { x: -din.z, z: din.x } : { x: side.x / len, z: side.z / len };
      let pushed = 0;
      for (let step = 0; step < (reversal ? 25 : 10) && turnAt(index).turn > LIMIT; step += 1) {
        keys[index].pos[0] += side.x * 30;
        keys[index].pos[2] += side.z * 30;
        pushed += 1;
      }
      // 外推达到 180（6 步，约一个控制点间距）就是在绕圈：该点多半是「环绕一圈的最后一个点」，后面紧跟径向外飞的收尾拉升，
      // 回折本身来自这个点太靠里（seed 7：外推 750 横穿市中心，片长 135 s → 202 s）。字卡并到前一个无字卡的控制点，
      // 删掉这个点——镜头仍在，路线不再为它兜圈。前一点已有字卡则保留原来的外推。
      if (pushed >= 6 && keys[index - 1].card === undefined) {
        keys[index - 1].card = keys[index].card;
        keys.splice(index, 1);
        changed = true;
        break;
      }
      if (turnAt(index).turn > LIMIT) continue; // 推不开就接受这一处（守卫会报出来）
      changed = true;
      break;
    }
  }

  const positionCurve = new THREE.CatmullRomCurve3(keys.map((k) => new THREE.Vector3(...k.pos)), false, "centripetal", 0.5);
  const targetCurve = new THREE.CatmullRomCurve3(keys.map((k) => new THREE.Vector3(...k.look)), false, "centripetal", 0.5);

  // ── 速度剖面：按弧长匀速、且速度 ∝ 离地高度 ──
  // 曾按关键帧序号均分时间：相距远的两帧（跨城区转场）挤在同样时长里，速度瞬间暴增、画面猛晃。
  // 真实航拍保持的是「画面里的视觉速度」，即 速度/离地高度 ≈ 常数：低飞慢、高飞快。
  // 时间表按「弧长」均匀建立（不是曲线参数 t）：CatmullRom 的 t 按控制点序号均分，关键帧密的地方
  // t 与距离严重不成比例，按 t 建表再插值会在那里出现单帧的速度骤降骤升（画面一顿）。
  const SAMPLES = 1600;
  // Dense arc-length sampling keeps short, tightly curved district exits from
  // introducing a speed discontinuity when mapping distance back to the curve.
  positionCurve.arcLengthDivisions = 16000;
  const totalLength = positionCurve.getLength() || 1;
  const altitudeAtU = (u: number) => {
    const point = positionCurve.getPointAt(Math.min(1, Math.max(0, u)));
    return Math.max(12, point.y - groundAt(point.x, point.z));
  };
  // 短版略快（0.61 rad/s）：分享片 30–45 秒；留出跨种子地形与采样误差余量，低于守卫的 0.7 上限。
  const OMEGA = Number((globalThis as { __CITY_CINE_OMEGA__?: number }).__CITY_CINE_OMEGA__ ?? (short ? 0.61 : 0.55));
  const MIN_SPEED = 9; // 单位/秒：起落之外最慢也在动
  const MAX_SPEED = 120; // 高空全景也不允许飞得比这快
  const RAMP_SECONDS = 3; // 起飞/降落各自的加减速时长（按距离折算）
  const segment = totalLength / SAMPLES;
  const raw = new Float64Array(SAMPLES);
  for (let index = 0; index < SAMPLES; index += 1) raw[index] = Math.min(MAX_SPEED, Math.max(MIN_SPEED, OMEGA * altitudeAtU((index + 0.5) / SAMPLES)));
  // 速度平滑：约 ±80 单位的滑动平均，两遍；地形起伏/海岸线会让离地高度跳变，速度不能跟着跳。
  const window = Math.max(2, Math.round(80 / segment));
  // 先做窗口最小值（腐蚀）：一段低空（掠过山脊/楼顶）之前就开始减速，平滑后不会把高速带进低空段。
  let smoothed = new Float64Array(SAMPLES);
  for (let index = 0; index < SAMPLES; index += 1) {
    let lowest = Infinity;
    for (let j = Math.max(0, index - window); j <= Math.min(SAMPLES - 1, index + window); j += 1) lowest = Math.min(lowest, raw[j]);
    smoothed[index] = lowest;
  }
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Float64Array(SAMPLES);
    for (let index = 0; index < SAMPLES; index += 1) {
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, index - window); j <= Math.min(SAMPLES - 1, index + window); j += 1) { sum += smoothed[j]; n += 1; }
      next[index] = sum / n;
    }
    smoothed = next;
  }
  const rampDistance = (smoothed[0] + smoothed[SAMPLES - 1]) * 0.5 * RAMP_SECONDS;
  const speedAt = (index: number) => {
    const travelled = index * segment;
    const left = totalLength - (index + 1) * segment;
    const ramp = Math.min(1, 0.12 + 0.88 * smootherstep(travelled / rampDistance), 0.12 + 0.88 * smootherstep(left / rampDistance));
    return smoothed[index] * ramp;
  };
  // times[i] = 飞完前 i 段（距离 i·segment）所用秒数。
  const times = new Float64Array(SAMPLES + 1);
  for (let index = 0; index < SAMPLES; index += 1) times[index + 1] = times[index] + segment / speedAt(index);
  const durationSec = times[SAMPLES];
  /** 秒数 → 弧长比例 u（二分查时间表 + 段内线性插值；段内匀速所以线性是精确的）。 */
  const arcU = (seconds: number) => {
    if (seconds <= 0) return 0;
    if (seconds >= durationSec) return 1;
    let lo = 0;
    let hi = SAMPLES;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= seconds) lo = mid;
      else hi = mid;
    }
    return (lo + (seconds - times[lo]) / (times[hi] - times[lo] || 1)) / SAMPLES;
  };
  /** 关键帧 i 位于曲线参数 t = i/(n-1)；换成弧长比例再查时间表。 */
  const cumulative = positionCurve.getLengths();
  const keySeconds = (index: number) => {
    const t = index / Math.max(1, keys.length - 1);
    const u = cumulative[Math.round(t * positionCurve.arcLengthDivisions)] / totalLength;
    const f = u * SAMPLES;
    const lo = Math.min(SAMPLES - 1, Math.floor(f));
    return times[lo] + (times[lo + 1] - times[lo]) * (f - lo);
  };
  const altitudeAt = (t: number) => {
    const point = positionCurve.getPoint(t);
    return Math.max(12, point.y - groundAt(point.x, point.z));
  };

  const start = model.windowStartMs;
  const end = model.windowEndMs;
  const growthSeconds = durationSec * 0.7;

  const cards: CinematicCard[] = [
    { atSec: 0.6, untilSec: 5.2, kind: "title", text: model.windowLabel, detail: `${model.stats.totalSessions}` },
  ];
  keys.forEach((key, index) => {
    if (key.card === undefined) return;
    const district = ordered[key.card];
    const at = keySeconds(index);
    // 字卡以机位为中心：提前 2s 出现（镜头正在降近），飞过后再留 2.2s。
    cards.push({ atSec: at - 2, untilSec: at + 2.2, kind: "district", text: district.data!.label, detail: `${district.data!.sessionCount}` });
  });
  cards.push({ atSec: durationSec - 5, untilSec: durationSec + 60, kind: "finale", text: "", detail: "" });

  return {
    durationSec,
    position: (seconds) => positionCurve.getPointAt(arcU(seconds)),
    // 注视点与位置用同一个曲线参数 t（由弧长换算），关键帧上二者严格对应。
    target: (seconds) => targetCurve.getPoint(positionCurve.getUtoTmapping(arcU(seconds), 0)),
    cursor: (seconds) => start + (end - start) * smootherstep(seconds / growthSeconds),
    cards,
    keyTimes: keys.map((_, index) => ({ seconds: keySeconds(index), altitude: altitudeAt(index / Math.max(1, keys.length - 1)) })),
  };
}
