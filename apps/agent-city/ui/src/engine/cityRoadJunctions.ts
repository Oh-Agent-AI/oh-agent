/**
 * 路口渲染几何（纯函数，渲染层专属；RoadEdge/RoadNode 数据模型与规划路网零改动）。
 * 规格：docs/CITY_ROAD_JUNCTION_RENDER_SPEC.md。
 *
 * 为什么不是「在节点画一个圆盘」：旧做法（cityTextures 的路口圆盘，半径 = 最宽路半宽）只能把
 * 两条矩形路面的缝补上，转角仍是直角——路缘石（roadSystem）还要在每个端点固定退 5.5，于是路口
 * 读成「两条带子叠在一起、四角缺块」。城建游戏（Cities: Skylines）的路口观感来自三件事：
 *   1. 相邻两臂之间的路缘转角是圆弧，半径随较宽那条路的等级走（真实路缘半径按道路等级取值）；
 *   2. 宽路的铺装与标线直穿路口，窄路在宽路边缘处收口并画停车/让行线；
 *   3. 同一条路换宽度的地方有渐变段，而不是台阶。
 * 本模块只算几何（切点、圆心、停止线位置、渐变梯形），贴图与路缘两个消费方各自取用同一份结果——
 * 这样路面圆角与路缘圆弧按构造一致，不会出现「路面是圆角、路缘还直插进路口」的两套口径。
 */
import { roadClassSpec } from "./roadStandard";
import type { RoadEdge, Vec2 } from "./cityLayout";

/** 人行道带宽取道路标准表（每侧 1.8 世界单位 = 3.6 m）；路口、路面填充共用。 */
export const SIDEWALK_BAND = roadClassSpec("local").sidewalk;
/** 圆角不得超过所在臂长的 40%（臂长 = 直路链长，见 JunctionArm.length）：两端都做圆角时最多吃掉 80%，中间总留一段直路。 */
export const CORNER_EDGE_SHARE = 0.4;
/** 夹角 ≥ 177° 视为直行（两条边线平行或背离），这一侧不需要圆角。 */
export const STRAIGHT_GAP = Math.PI - 0.05;
/** 度为 2 的换宽节点：转角 ≤ 60° 都按「渐变段」画（梯形底边对齐宽路的平头端）。最初只认 25° 以内的近直行，
 *  折角处换宽（真机：悬索桥头 12 → 5）就只剩一个窄路宽的补缝圆盘，宽路的平头两角支出窄路之外。 */
const TAPER_MAX_BEND = Math.PI / 3;

/** 路缘转角半径：r = 1.1 × 路宽 → 支路(5) 5.5 / 次干(8) 8.8 / 主干(12) 13.2。
 *  真实城市里路缘半径按道路等级取（居住区 5–6 m、次干 8–10 m、主干 12–15 m），
 *  这里用较宽一臂的宽度驱动——小路接大路时，转弯车辆按大路的速度与车型转弯。 */
export function curbRadiusFor(width: number): number {
  return 1.1 * width;
}

/** 桥面（bridge / structure "deck"）与滨水大道（purpose "waterfront"）保持既有画法：
 *  不参与圆角、不画停止线、标线沿用旧的 6 / 6.5 内缩。 */
export function isDeckEdge(edge: RoadEdge): boolean {
  return Boolean(edge.bridge) || edge.structure === "deck";
}
export function isLegacyArm(edge: RoadEdge): boolean {
  return isDeckEdge(edge) || edge.purpose === "waterfront";
}

export type JunctionArm = {
  edge: RoadEdge;
  /** 从节点指向该路另一端的单位向量（与 channelizedTPlan / acuteJunctions 同一测角方向）。 */
  dir: Vec2;
  angle: number;
  half: number;
  /** 可用直路长度：沿本臂穿过度 2、同宽、近共线（转角 < 12°）的续接边一直走到下一个真路口/拐点为止。
   *  40% 约束按它算——生成器把一条直路切成 10–15 长的短边（度 2 节点），按单条边算圆角会被压没。 */
  length: number;
  /** 圆角可占用臂长的比例（见 cornerShareOf）。 */
  cornerShare: number;
  /** 上面那条直路的逐边分解（从路口往外），路缘退让超出第一条边时顺延到后续边。 */
  chain: Array<{ edge: RoadEdge; near: string; start: number; length: number }>;
  legacy: boolean;
  /** 逆时针侧（+n，n = (−dir.z, dir.x)）圆角在本臂上的切点距离；null = 这一侧没有圆角。 */
  ccwTrim: number | null;
  /** 顺时针侧（−n）圆角切点距离；null 同上。 */
  cwTrim: number | null;
  /** 逆/顺时针相邻臂与夹角（这一侧没有圆角时，路缘退让按邻臂决定）。度 2 时两侧是同一条邻臂。 */
  ccwNeighbor: JunctionArm | null; ccwGap: number;
  cwNeighbor: JunctionArm | null; cwGap: number;
  /** 等级：宽度 = 节点最大宽度的臂为主路（直穿），更窄的为次路（收口 + 停止线）。 */
  role: "plain" | "major" | "minor";
  /** 次路：停止/让行线中心到节点的距离（宽路边缘外 0.35）；其余为 null。 */
  stopAt: number | null;
};

export type JunctionCorner = {
  /** 圆心（世界坐标）与半径——路面边线圆弧半径 r，路缘中心线在 r−0.25，人行道内沿在 r−1.2。 */
  center: Vec2;
  radius: number;
  /** 两个切点（路面边线上），从 a 臂到 b 臂（逆时针相邻）。 */
  a: Vec2; b: Vec2;
  /** 切点各自所在臂上离节点的距离。 */
  ta: number; tb: number;
  /** 圆弧从 a 切点到 b 切点的起始角与带符号扫角（|sweep| = π − 夹角）。 */
  startAngle: number; sweep: number;
  /** 圆角铺装用的颜色等级：取两臂里较窄那条的 kind（转弯车道属于窄路）。 */
  kind: RoadEdge["kind"];
  armA: number; armB: number;
  /** 人行道转角用：切点沿法向再外推 SIDEWALK_BAND。 */
  outerA: Vec2; outerB: Vec2;
};

export type JunctionTaper = {
  /** 宽、窄两臂（窄臂 dir 方向即渐变延伸方向）。 */
  wide: JunctionArm; narrow: JunctionArm;
  /** 渐变段长度（≈ 2 × 宽度差，受窄臂 40% 臂长约束）。 */
  length: number;
};

export type RoadJunction = {
  id: string; x: number; z: number;
  arms: JunctionArm[];
  corners: JunctionCorner[];
  /** 节点处最宽臂的宽度与 kind（路口中心填充用）。 */
  maxWidth: number; maxKind: RoadEdge["kind"];
  /** 有等级差（≥3 臂且宽度不全相等）。等宽路口 = 普通路口，不画停止线。 */
  hierarchical: boolean;
  /** 节点上挂着桥面：桥头，不画停止线（桥面永远不画停止线）。 */
  touchesDeck: boolean;
  taper: JunctionTaper | null;
};

const cross = (a: Vec2, b: Vec2) => a.x * b.z - a.z * b.x;

/** 两条有向直线 p = P + t·d、q = Q + u·e 的交点参数 (t, u)；近平行返回 null。 */
function intersect(P: Vec2, d: Vec2, Q: Vec2, e: Vec2): { t: number; u: number } | null {
  const det = cross(d, e);
  if (Math.abs(det) < 1e-9) return null;
  const w = { x: Q.x - P.x, z: Q.z - P.z };
  return { t: cross(w, e) / det, u: cross(w, d) / det };
}

/** 一对逆时针相邻臂之间的圆角。a 在 +na 侧、b 在 −nb 侧（都指向楔形内部）。
 *  切点距离对半径 r 是仿射的（t = t0 + t1·r），所以 40% 边长约束可以直接反解出允许的最大半径，
 *  不用迭代收缩。 */
function cornerBetween(node: Vec2, a: JunctionArm, b: JunctionArm, gap: number, radius: number): Omit<JunctionCorner, "kind" | "armA" | "armB"> | null {
  if (gap <= 1e-3 || gap >= STRAIGHT_GAP) return null;
  const na = { x: -a.dir.z, z: a.dir.x };
  const nb = { x: b.dir.z, z: -b.dir.x };
  const solve = (r: number) => intersect(
    { x: na.x * (a.half + r), z: na.z * (a.half + r) }, a.dir,
    { x: nb.x * (b.half + r), z: nb.z * (b.half + r) }, b.dir,
  );
  const s0 = solve(0); const s1 = solve(1);
  if (!s0 || !s1) return null;
  const ta1 = s1.t - s0.t; const tb1 = s1.u - s0.u;
  let r = radius;
  const limA = a.cornerShare * a.length; const limB = b.cornerShare * b.length;
  if (ta1 > 1e-9) r = Math.min(r, (limA - s0.t) / ta1);
  if (tb1 > 1e-9) r = Math.min(r, (limB - s0.u) / tb1);
  if (!(r >= 0.5)) return null;
  const ta = s0.t + ta1 * r; const tb = s0.u + tb1 * r;
  // 切点落在节点背后 = 两条边线在节点后方相交（接近直行的不等宽对）：窄路的边线整段藏在宽路路面里，
  // 这一侧没有可见的转角，硬画圆弧会把路缘画进宽路中央。
  if (ta < 0 || tb < 0) return null;
  const center = { x: node.x + na.x * (a.half + r) + a.dir.x * ta, z: node.z + na.z * (a.half + r) + a.dir.z * ta };
  const pa = { x: node.x + na.x * a.half + a.dir.x * ta, z: node.z + na.z * a.half + a.dir.z * ta };
  const pb = { x: node.x + nb.x * b.half + b.dir.x * tb, z: node.z + nb.z * b.half + b.dir.z * tb };
  const startAngle = Math.atan2(pa.z - center.z, pa.x - center.x);
  let sweep = Math.atan2(pb.z - center.z, pb.x - center.x) - startAngle;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep <= -Math.PI) sweep += Math.PI * 2;
  return {
    center, radius: r, a: pa, b: pb, ta, tb, startAngle, sweep,
    outerA: { x: pa.x + na.x * SIDEWALK_BAND, z: pa.z + na.z * SIDEWALK_BAND },
    outerB: { x: pb.x + nb.x * SIDEWALK_BAND, z: pb.z + nb.z * SIDEWALK_BAND },
  };
}

/** 圆弧采样（含两端切点），每段 ≤ 12°；offset 为相对路面边线向圆心内收的距离（路缘 0.25 / 人行道 1.2）。 */
export function cornerArc(corner: JunctionCorner, offset = 0, maxStep = Math.PI / 15): Vec2[] {
  const radius = Math.max(0, corner.radius - offset);
  const steps = Math.max(2, Math.ceil(Math.abs(corner.sweep) / maxStep));
  return Array.from({ length: steps + 1 }, (_, k) => {
    const angle = corner.startAngle + (corner.sweep * k) / steps;
    return { x: corner.center.x + Math.cos(angle) * radius, z: corner.center.z + Math.sin(angle) * radius };
  });
}

/** 共线续接的最大转角与最长走查距离（再长对 40% 约束已无意义）。 */
const CHAIN_MAX_TURN = (12 * Math.PI) / 180;
const CHAIN_MAX_LENGTH = 80;

/** 从路口沿 first 往外走直路：只穿过度 2 节点、同宽、非桥/滨水、近共线的续接边。
 *  多点折线边只算第一段且不再续接（圆角不能跨过折点）。 */
function straightChain(incident: Map<string, RoadEdge[]>, first: RoadEdge, start: string, firstStep: number): JunctionArm["chain"] {
  const chain: JunctionArm["chain"] = [{ edge: first, near: start, start: 0, length: firstStep }];
  let edge = first; let near = start; let total = firstStep;
  const seen = new Set([first.id]);
  while (edge.points.length === 2 && total < CHAIN_MAX_LENGTH) {
    const far = edge.from === near ? edge.to : edge.from;
    const list = incident.get(far) ?? [];
    if (list.length !== 2) break;
    const next = list[0] === edge ? list[1] : list[0];
    if (seen.has(next.id) || next.width !== edge.width || isLegacyArm(next) || next.points.length !== 2) break;
    const a = edge.from === near ? edge.points : [...edge.points].reverse();
    const b = next.from === far ? next.points : [...next.points].reverse();
    const turn = Math.abs(Math.atan2(cross({ x: a[1].x - a[0].x, z: a[1].z - a[0].z }, { x: b[1].x - b[0].x, z: b[1].z - b[0].z }),
      (a[1].x - a[0].x) * (b[1].x - b[0].x) + (a[1].z - a[0].z) * (b[1].z - b[0].z)));
    if (turn > CHAIN_MAX_TURN) break;
    const length = Math.hypot(b[1].x - b[0].x, b[1].z - b[0].z);
    chain.push({ edge: next, near: far, start: total, length });
    seen.add(next.id); total += length; edge = next; near = far;
  }
  return chain;
}

/** 直路链远端节点的度（链最后一条边离开路口那一端）。 */
function farDegree(incident: Map<string, RoadEdge[]>, chain: JunctionArm["chain"]): number {
  const last = chain[chain.length - 1];
  const far = last.edge.from === last.near ? last.edge.to : last.edge.from;
  return (incident.get(far) ?? []).length;
}

/** 圆角可占用臂长的比例：两端都是路口（或尽端）各 40%；路口 → 度 2 拐点的短臂，路口端 70%、拐点端 30%（两端合计仍 ≤ 100%）。
 *  对称的 40% 在规划层掰出来的 10–14 长「狗腿」臂上做不出路口圆角：90° 口要切点 ≥ 主路半宽 6 才有圆弧，40%·10 = 4，
 *  转角只剩直角（真机截图）；拐点那头的内侧圆角本来就小，让出份额给路口端。 */
function cornerShareOf(degreeHere: number, degreeFar: number): number {
  if (degreeHere >= 3 && degreeFar === 2) return 0.7;
  if (degreeHere === 2 && degreeFar >= 3) return 0.3;
  return CORNER_EDGE_SHARE;
}

/** 全图路口计划：度 ≥ 2 的地面节点逐个出圆角、等级与渐变段。结果按节点 id 排序（确定性）。 */
export function roadJunctionPlan(edges: readonly RoadEdge[]): RoadJunction[] {
  const incident = new Map<string, RoadEdge[]>();
  for (const edge of edges) for (const id of [edge.from, edge.to]) {
    const list = incident.get(id) ?? []; list.push(edge); incident.set(id, list);
  }
  const result: RoadJunction[] = [];
  for (const [id, list] of incident) {
    if (list.length < 2) continue;
    const first = list[0];
    const node = first.from === id ? first.points[0] : first.points[first.points.length - 1];
    const arms: JunctionArm[] = [];
    for (const edge of list) {
      const pts = edge.from === id ? edge.points : [...edge.points].reverse();
      if (pts.length < 2) continue;
      const dx = pts[1].x - node.x; const dz = pts[1].z - node.z;
      const step = Math.hypot(dx, dz);
      if (step < 1e-6) continue;
      const chain = straightChain(incident, edge, id, step);
      arms.push({
        edge, dir: { x: dx / step, z: dz / step }, angle: Math.atan2(dz, dx), half: edge.width / 2,
        length: chain.reduce((sum, link) => sum + link.length, 0), chain, legacy: isLegacyArm(edge),
        cornerShare: cornerShareOf(list.length, farDegree(incident, chain)),
        ccwTrim: null, cwTrim: null, ccwNeighbor: null, ccwGap: 0, cwNeighbor: null, cwGap: 0, role: "plain", stopAt: null,
      });
    }
    if (arms.length < 2) continue;
    // 同角度时按边 id 定序：输入边顺序不同也得到同一份结果。
    arms.sort((p, q) => p.angle - q.angle || (p.edge.id < q.edge.id ? -1 : p.edge.id > q.edge.id ? 1 : 0));
    const touchesDeck = arms.some((arm) => isDeckEdge(arm.edge));
    const ground = arms.filter((arm) => !isDeckEdge(arm.edge));
    const maxWidth = Math.max(...arms.map((arm) => arm.edge.width));
    const maxKind = arms.find((arm) => arm.edge.width === maxWidth)!.edge.kind;
    const corners: JunctionCorner[] = [];
    for (let k = 0; k < arms.length; k += 1) {
      const a = arms[k]; const b = arms[(k + 1) % arms.length];
      const gap = k + 1 < arms.length ? b.angle - a.angle : b.angle + Math.PI * 2 - a.angle;
      a.ccwNeighbor = b; a.ccwGap = gap; b.cwNeighbor = a; b.cwGap = gap;
      if (a.legacy || b.legacy) continue;
      const corner = cornerBetween(node, a, b, gap, curbRadiusFor(Math.max(a.edge.width, b.edge.width)));
      if (!corner) continue;
      a.ccwTrim = corner.ta; b.cwTrim = corner.tb;
      const kind = a.edge.width <= b.edge.width ? a.edge.kind : b.edge.kind;
      corners.push({ ...corner, kind, armA: k, armB: (k + 1) % arms.length });
    }
    // 等级：≥3 条地面臂、宽度不全相等。度 2 的换宽是渐变段，不是「小路让大路」。
    const groundWidths = new Set(ground.map((arm) => arm.edge.width));
    const hierarchical = ground.length >= 3 && groundWidths.size > 1;
    if (hierarchical) {
      const majorWidth = Math.max(...ground.map((arm) => arm.edge.width));
      const majors = ground.filter((arm) => arm.edge.width === majorWidth);
      for (const arm of ground) {
        if (arm.edge.width === majorWidth) { arm.role = "major"; continue; }
        arm.role = "minor";
        if (arm.legacy || touchesDeck) continue;
        // 停止线 = 次路整幅（不只是中线）都走出宽路路面的位置：s·|sin θ| = 宽路半宽 + 次路半宽·|cos θ|。
        // 只按中线算（h/|sin|）在斜交口会让停止线 / 斑马线的一角落进主路路面、被主路盖掉（真机 50° T 口实测）。
        // 取最近的那条主臂；主臂与次路近平行（|sin| < 0.2，T 的「另一侧」）时那条主臂不构成收口边。
        let stop = Infinity;
        for (const major of majors) {
          const sin = Math.abs(cross(major.dir, arm.dir));
          const cos = Math.abs(major.dir.x * arm.dir.x + major.dir.z * arm.dir.z);
          if (sin >= 0.2) stop = Math.min(stop, (major.half + arm.half * cos) / sin);
        }
        if (!Number.isFinite(stop)) stop = majorWidth / 2;
        stop += 0.35;
        // 停止线不能跑出次路直路链的 40%（短路上会画到路中段、甚至下一个路口去）。
        if (stop <= CORNER_EDGE_SHARE * arm.length) arm.stopAt = stop;
      }
    } else for (const arm of ground) arm.role = "plain";
    let taper: JunctionTaper | null = null;
    if (arms.length === 2 && !touchesDeck && !arms.some((arm) => arm.legacy) && arms[0].edge.width !== arms[1].edge.width) {
      const bend = Math.abs(Math.PI - Math.abs(arms[1].angle - arms[0].angle));
      if (bend <= TAPER_MAX_BEND) {
        const [narrow, wide] = arms[0].edge.width < arms[1].edge.width ? [arms[0], arms[1]] : [arms[1], arms[0]];
        const length = Math.min(2 * (wide.edge.width - narrow.edge.width), CORNER_EDGE_SHARE * narrow.length);
        if (length > 0.5) taper = { wide, narrow, length };
      }
    }
    result.push({ id, x: node.x, z: node.z, arms, corners, maxWidth, maxKind, hierarchical, touchesDeck, taper });
  }
  return result.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

/** 渐变段轮廓（贴图 / 路面网格 / 路缘共用）：[宽侧左, 窄侧左, 窄侧右, 宽侧右]，extra = 向外加宽（人行道 1.2 等）。
 *  底边对齐宽路的平头端（宽路方向的法线），顶边对齐窄路（窄路方向的法线）——直行时两者重合，与旧梯形一致；
 *  折角处这样才不会在宽路平头的两角漏出楔形缺口。 */
export function taperOutline(junction: RoadJunction, extra: number): Vec2[] {
  const { wide, narrow, length } = junction.taper!;
  const w = { x: -wide.dir.x, z: -wide.dir.z }; // 沿宽路驶向节点的方向
  const nW = { x: -w.z, z: w.x }; const d = narrow.dir; const nN = { x: -d.z, z: d.x };
  const hw = wide.half + extra; const hn = narrow.half + extra;
  return [
    { x: junction.x + nW.x * hw, z: junction.z + nW.z * hw },
    { x: junction.x + d.x * length + nN.x * hn, z: junction.z + d.z * length + nN.z * hn },
    { x: junction.x + d.x * length - nN.x * hn, z: junction.z + d.z * length - nN.z * hn },
    { x: junction.x - nW.x * hw, z: junction.z - nW.z * hw },
  ];
}

/** 按节点 / （边, 节点）查路口与臂：roadSystem 的路缘与 cityTextures 的标线都经由它取同一份几何，避免两边各算一遍。 */
export function junctionIndex(plan: readonly RoadJunction[]) {
  const byNode = new Map(plan.map((junction) => [junction.id, junction]));
  const armOf = (edge: RoadEdge, node: string) => byNode.get(node)?.arms.find((arm) => arm.edge === edge || arm.edge.id === edge.id);
  return { byNode, armOf };
}

/** 路缘线（臂 arm 的 sideAtNode 侧、离路面边线 0.25）要从节点走多远才离开路口里其它臂的路面带与路口中心圆盘。
 *  没有圆角的一侧（桥头/滨水旁、圆角做不出来的短边/锐角）用它兜底：旧的固定 5.5 只在「短于 14 的边不画路缘」
 *  时才安全——一旦短边也画路缘，5.5 处的支路路缘就落在 12 宽主路的路面中间（真机：十字口路面上的白色折线）。 */
export function curbClearance(junction: RoadJunction, arm: JunctionArm, sideAtNode: number): number {
  const n = { x: -arm.dir.z * sideAtNode, z: arm.dir.x * sideAtNode };
  const o = { x: n.x * (arm.half + 0.25), z: n.z * (arm.half + 0.25) };
  const d = arm.dir;
  let clear = 0;
  /** a + b·t ∈ [lo, hi] 的 t 区间。 */
  const range = (a: number, b: number, lo: number, hi: number): [number, number] | null => {
    if (Math.abs(b) < 1e-9) return a >= lo && a <= hi ? [-Infinity, Infinity] : null;
    const t1 = (lo - a) / b; const t2 = (hi - a) / b;
    return [Math.min(t1, t2), Math.max(t1, t2)];
  };
  for (const other of junction.arms) {
    if (other === arm) continue;
    const along = range(o.x * other.dir.x + o.z * other.dir.z, d.x * other.dir.x + d.z * other.dir.z, 0, other.length);
    const across = range(cross(other.dir, o), cross(other.dir, d), -other.half, other.half);
    if (!along || !across) continue;
    const lo = Math.max(along[0], across[0]); const hi = Math.min(along[1], across[1]);
    if (hi > lo && hi > 0 && Number.isFinite(hi)) clear = Math.max(clear, hi);
  }
  if (junction.arms.length >= 3) {
    const R = junction.maxWidth / 2;
    const od = o.x * d.x + o.z * d.z; const disc = od * od - (o.x * o.x + o.z * o.z) + R * R;
    if (disc > 0) clear = Math.max(clear, -od + Math.sqrt(disc));
  }
  return clear;
}

/** 路面带索引：地面路（非桥面）每条边一条矩形路面带，网格分桶。
 *  路缘（以及任何贴着路面边线走的装饰）最后一道闸：把一段线减去它穿过的所有「别的路」的路面带，只保留路面外的部分。
 *  为什么节点级的退让不够：生成器会留下 3–4 长的短边，路口的影响范围越过了下一个节点——旧代码靠「< 14 的边不画路缘」
 *  把这类情况整段藏起来；短边也画路缘之后，只看本节点各臂的退让会让隔一个节点的路缘落进宽路路面（真机实测）。 */
export function pavementIndex(edges: readonly RoadEdge[], cell = 40) {
  type Strip = { edge: RoadEdge; a: Vec2; u: Vec2; length: number; half: number };
  type Disc = { node: string; c: Vec2; radius: number; edges: Set<string> };
  const grid = new Map<string, Strip[]>();
  // 节点圆盘：贴图里路段用圆角线连接（lineJoin round）+ 路口中心圆盘，折点外侧那块楔形是路面，
  // 但不在任何一条边的矩形里——穿过这里的线（无节点相交的路、短边旁的路缘）只按矩形剪会把端点留在路面上。
  const discs: Disc[] = [];
  {
    const at = new Map<string, Disc>();
    for (const edge of edges) {
      if (isDeckEdge(edge)) continue;
      for (const [id, point] of [[edge.from, edge.points[0]], [edge.to, edge.points[edge.points.length - 1]]] as const) {
        const disc = at.get(id) ?? { node: id, c: point, radius: 0, edges: new Set<string>() };
        disc.radius = Math.max(disc.radius, edge.width / 2); disc.edges.add(edge.id); at.set(id, disc);
      }
    }
    for (const disc of at.values()) if (disc.edges.size >= 2) discs.push(disc);
  }
  const discGrid = new Map<string, Disc[]>();
  for (const disc of discs) {
    const key = `${Math.floor(disc.c.x / cell)}:${Math.floor(disc.c.z / cell)}`;
    const list = discGrid.get(key) ?? []; list.push(disc); discGrid.set(key, list);
  }
  for (const edge of edges) {
    if (isDeckEdge(edge)) continue;
    for (let k = 1; k < edge.points.length; k += 1) {
      const a = edge.points[k - 1]; const b = edge.points[k];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const strip: Strip = { edge, a, u: { x: (b.x - a.x) / length, z: (b.z - a.z) / length }, length, half: edge.width / 2 };
      const pad = edge.width;
      for (let gx = Math.floor((Math.min(a.x, b.x) - pad) / cell); gx <= Math.floor((Math.max(a.x, b.x) + pad) / cell); gx += 1)
        for (let gz = Math.floor((Math.min(a.z, b.z) - pad) / cell); gz <= Math.floor((Math.max(a.z, b.z) + pad) / cell); gz += 1) {
          const key = `${gx}:${gz}`; const list = grid.get(key) ?? []; list.push(strip); grid.set(key, list);
        }
    }
  }
  /** p→q 线段减去路面带（除 own 之外；容差 0.05 免得与路面边线相切的路缘被误剪）后剩下的参数区间 [t0, t1] ⊂ [0, 1]。 */
  const outside = (p: Vec2, q: Vec2, own?: RoadEdge): Array<[number, number]> => {
    const seen = new Set<Strip>(); const cuts: Array<[number, number]> = [];
    const d = { x: q.x - p.x, z: q.z - p.z };
    for (let gx = Math.floor(Math.min(p.x, q.x) / cell); gx <= Math.floor(Math.max(p.x, q.x) / cell); gx += 1)
      for (let gz = Math.floor(Math.min(p.z, q.z) / cell); gz <= Math.floor(Math.max(p.z, q.z) / cell); gz += 1)
        for (const strip of grid.get(`${gx}:${gz}`) ?? []) {
          if (seen.has(strip) || strip.edge === own || (own && strip.edge.id === own.id)) continue;
          seen.add(strip);
          const w = { x: p.x - strip.a.x, z: p.z - strip.a.z };
          let lo = 0; let hi = 1;
          // along ∈ (0.05, length − 0.05)，|across| < half − 0.05
          for (const [c0, c1, min, max] of [
            [w.x * strip.u.x + w.z * strip.u.z, d.x * strip.u.x + d.z * strip.u.z, 0.05, strip.length - 0.05],
            [cross(strip.u, w), cross(strip.u, d), -(strip.half - 0.05), strip.half - 0.05],
          ] as const) {
            if (Math.abs(c1) < 1e-12) { if (c0 <= min || c0 >= max) { lo = 1; hi = 0; } continue; }
            const t1 = (min - c0) / c1; const t2 = (max - c0) / c1;
            lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
          }
          if (hi > lo) cuts.push([lo, hi]);
        }
    const dd = d.x * d.x + d.z * d.z;
    if (dd > 1e-12) for (let gx = Math.floor(Math.min(p.x, q.x) / cell) - 1; gx <= Math.floor(Math.max(p.x, q.x) / cell) + 1; gx += 1)
      for (let gz = Math.floor(Math.min(p.z, q.z) / cell) - 1; gz <= Math.floor(Math.max(p.z, q.z) / cell) + 1; gz += 1)
        for (const disc of discGrid.get(`${gx}:${gz}`) ?? []) {
          // 自己那条路的端点圆盘不剪（路缘本来就沿着它的边线走，相切处会被误剪成碎段）。
          if (own && disc.edges.has(own.id)) continue;
          const r = disc.radius - 0.05;
          const w = { x: p.x - disc.c.x, z: p.z - disc.c.z };
          const b = (w.x * d.x + w.z * d.z) / dd; const c = (w.x * w.x + w.z * w.z - r * r) / dd;
          const disc2 = b * b - c;
          if (disc2 <= 0) continue;
          const root = Math.sqrt(disc2);
          const lo = Math.max(0, -b - root); const hi = Math.min(1, -b + root);
          if (hi > lo) cuts.push([lo, hi]);
        }
    cuts.sort((x, y) => x[0] - y[0]);
    const keep: Array<[number, number]> = []; let from = 0;
    for (const [lo, hi] of cuts) { if (lo > from) keep.push([from, lo]); from = Math.max(from, hi); }
    if (from < 1) keep.push([from, 1]);
    return keep;
  };
  /** 点是否落在任一地面路的路面上（矩形带或节点圆盘，容差同 outside）。 */
  const covers = (p: Vec2): boolean => {
    const key = `${Math.floor(p.x / cell)}:${Math.floor(p.z / cell)}`;
    for (const strip of grid.get(key) ?? []) {
      const w = { x: p.x - strip.a.x, z: p.z - strip.a.z };
      const along = w.x * strip.u.x + w.z * strip.u.z;
      if (along > 0.05 && along < strip.length - 0.05 && Math.abs(cross(strip.u, w)) < strip.half - 0.05) return true;
    }
    for (let gx = Math.floor(p.x / cell) - 1; gx <= Math.floor(p.x / cell) + 1; gx += 1)
      for (let gz = Math.floor(p.z / cell) - 1; gz <= Math.floor(p.z / cell) + 1; gz += 1)
        for (const disc of discGrid.get(`${gx}:${gz}`) ?? []) if (Math.hypot(p.x - disc.c.x, p.z - disc.c.z) < disc.radius - 0.05) return true;
    return false;
  };
  return { outside, covers };
}

/** 短桩最长长度与续接最大转角（渲染层宽度协调用）。 */
const STUB_MAX_LENGTH = 16;
/** 续接转角上限 90°：度 2 节点没有分岔，桩与续接路就是同一条路。真机里的桩是规划层为了以更好的角度接主路
 *  掰出来的「狗腿」（实测 34°、57°），最初按 25° 的共线门槛一个都没认出来。 */
const STUB_MAX_TURN = Math.PI / 2;
const harmonizedCache = new WeakMap<readonly RoadEdge[], RoadEdge[]>();

/** 渲染用路网：把生成器留下的「窄短桩」按它接续的宽路宽度来画（数据不改，返回替换过宽度/等级的新边对象）。
 *  短桩 = 长 ≤ 16 的地面边，一端是度 2 节点（转角 ≤ 90°）接一条更宽的路，另一端是路口（度 ≥ 3）或同样接更宽的路。
 *  为什么要做：生成器在宽路接主路的最后一截常留下 10–14 长、折一个角的 5 宽边（8 宽路 → 5 宽桩 → 12 宽主路），
 *  照数据画就是路口前一块浅色窄路面 + 渐变、短到做不出路缘圆角——真机截图「道路衔接的地方很奇怪」。
 *  真正的收窄（窄路继续往外延伸）不在此列：另一端必须是路口或更宽的路；桥头路口也不在此列。所有画路的消费方（贴图、路面网格、路缘、
 *  渠化、回车圈、行道树、路灯）都取这一份，保持一致。结果按输入数组缓存。 */
export function renderRoadEdges(edges: readonly RoadEdge[]): RoadEdge[] {
  const cached = harmonizedCache.get(edges);
  if (cached) return cached;
  let current = edges.slice();
  for (let pass = 0; pass < 3; pass += 1) {
    const incident = new Map<string, RoadEdge[]>();
    for (const edge of current) for (const id of [edge.from, edge.to]) {
      const list = incident.get(id) ?? []; list.push(edge); incident.set(id, list);
    }
    const direction = (edge: RoadEdge, from: string) => {
      const pts = edge.from === from ? edge.points : [...edge.points].reverse();
      const a = pts[0]; const b = pts[1]; const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    };
    /** 从 node 离开 edge 之后近共线接上的更宽地面路（没有则 null）。 */
    const widerContinuation = (edge: RoadEdge, node: string): RoadEdge | null => {
      const list = incident.get(node) ?? [];
      if (list.length !== 2) return null;
      const next = list[0] === edge ? list[1] : list[0];
      if (isLegacyArm(next) || next.width <= edge.width || next.points.length < 2) return null;
      const arriving = direction(edge, node); // 从 node 指回 edge 内部
      const leaving = direction(next, node);
      const turn = Math.acos(Math.max(-1, Math.min(1, -(arriving.x * leaving.x + arriving.z * leaving.z))));
      return turn <= STUB_MAX_TURN ? next : null;
    };
    let changed = false;
    current = current.map((edge) => {
      if (isLegacyArm(edge) || edge.points.length < 2) return edge;
      let length = 0;
      for (let k = 1; k < edge.points.length; k += 1) length += Math.hypot(edge.points[k].x - edge.points[k - 1].x, edge.points[k].z - edge.points[k - 1].z);
      if (length > STUB_MAX_LENGTH) return edge;
      const ends = [edge.from, edge.to].map((node) => ({ node, degree: (incident.get(node) ?? []).length, wider: widerContinuation(edge, node) }));
      const anchor = ends.filter((end) => end.wider).sort((p, q) => q.wider!.width - p.wider!.width)[0];
      if (!anchor) return edge;
      const other = ends.find((end) => end !== anchor)!;
      // 桥头不动：路口端挂着桥面时，桥面宽度另有来历（造型 / 主塔间距），把桩加宽到接续路的宽度会在桥头铺出一块比桥面还宽的沥青（真机悬索桥头）。
      const atDeck = (incident.get(other.node) ?? []).some(isDeckEdge);
      if (atDeck || !(other.degree >= 3 || other.wider)) return edge;
      changed = true;
      return { ...edge, width: anchor.wider!.width, kind: anchor.wider!.kind };
    });
    if (!changed) break;
  }
  harmonizedCache.set(edges, current);
  return current;
}
