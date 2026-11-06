/**
 * 选址指派循环骨架（CITY_NETWORK_FIRST_CODE_DESIGN §5 / 迁移批次 6a-3）。
 *
 * 对 access.ts 的候选执行「hard 全过 → soft 加权 → 确定性排序 → 取第一」：
 *   - hard：siteCandidateHardReject（复用现有谓词，见 sitespec.HardCheckId 文档）——任何不过即出局，
 *     软分永远不能让非法候选复活（设计 §5A-9 硬约束与软偏好分离）；
 *   - soft：可配置权重表（ASSIGN_WEIGHTS），已实现的偏好项与 score.ts 的同名项同向；
 *     未实现的偏好项权重为 0（行为变更批接线 yaw 语义时再启用 face-road / coast-parallel-face 等）；
 *   - 排序：软分降序，平分按候选 id 升序（稳定次级键，设计 §6.3 固定 tie-break）；
 *   - 顺序：specs 按 priority 升序、同 priority 按 kind 字典序——与 place() 的调用序一致；
 *     接受的用地追加进 world.placed，后续 kind 的间距判据立即可见（同今天的顺序放置语义）。
 *
 * 原迁移批只提供骨架；当前 station/stadium 的联合指派已在生产调用 assignSite 的额外接受闸门。
 * runAssignment 仍是批量候选接口，不代表所有模型入口、占地与基础已接线。
 * 守卫（verify-city-sitespec.mjs 的 6a-3 段）证明：同输入两次运行同输出、hard 闸门拒绝已知
 * 违例候选、无候选时的显式失败原因。
 */
import { DetMath as Math } from "../detMath";
import type { SiteSpec, SoftPreferenceId } from "./sitespec";
import { nominalAnchorPoint } from "./sitespec";
import { candidatesFor, siteCandidateHardReject, type SiteCandidate, type SiteCandidateWorld } from "./access";
import { polylineDistance } from "./footprint";

/** soft 偏好权重（0 = 未实现/不参与；改权重 = 改指派契约，需在提交信息写明）。 */
export type AssignWeights = Record<SoftPreferenceId, number>;

export const ASSIGN_WEIGHTS: AssignWeights = {
  "near-nominal-anchor": 1.0,   // 名义位置承载结构（score.siteDrift 同向）
  "frontage-offset-r+12": 0.8,  // 贴路一侧的目标偏移（临街遍公式）
  "hug-coast-0.7r": 0.8,        // 贴岸目标（score.shoreHug 同向）
  "spread-from-others": 0.5,    // 两两散布（score.landmarkSpread 同向）
  "face-road": 0,               // 未实现：接线 yaw 语义时启用
  "coast-parallel-face": 0,     // 未实现：同上
  "hillside-setting": 0,        // 未实现：pagoda 的山脊带偏好
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 单个 soft 偏好在候选处的值 ∈ [0,1]（越大越好）；未实现的项返回 0.5（中性，权重为 0 不影响）。 */
function preferenceValue(world: SiteCandidateWorld, spec: SiteSpec, candidate: SiteCandidate, preference: SoftPreferenceId): number {
  const at = { x: candidate.x, z: candidate.z };
  switch (preference) {
    case "near-nominal-anchor": {
      const anchor = nominalAnchorPoint(spec, world);
      return clamp01(1 - Math.hypot(at.x - anchor.x, at.z - anchor.z) / (world.R * 0.6));
    }
    case "frontage-offset-r+12": {
      const road = polylineDistance(world.trunkRuns, at);
      return clamp01(1 - Math.abs(road - (spec.radius + 12)) / (spec.radius + 12));
    }
    case "hug-coast-0.7r": {
      const target = (spec.shoreTargetRadiusFactor ?? 0.7) * spec.radius;
      return clamp01(1 - Math.abs(world.coastDistance(at.x, at.z) - target) / (spec.radius * 0.7));
    }
    case "spread-from-others": {
      if (!world.placed.length) return 1;
      let min = Infinity;
      for (const o of world.placed) min = Math.min(min, Math.hypot(o.x - at.x, o.z - at.z));
      return clamp01(min / (world.R * 0.5));
    }
    default:
      return 0.5; // face-road / coast-parallel-face / hillside-setting：行为变更批接线 yaw 语义
  }
}

/** 候选软分 = Σ weightᵢ · preferenceᵢ（hard 已全过的候选之间才比较；设计 §6 软分不豁免硬约束）。 */
export function softScore(world: SiteCandidateWorld, spec: SiteSpec, candidate: SiteCandidate, weights: AssignWeights = ASSIGN_WEIGHTS): number {
  let sum = 0;
  for (const preference of spec.soft) sum += weights[preference] * preferenceValue(world, spec, candidate, preference);
  return sum;
}

export type SiteAssignment = {
  kind: string;
  /** 选中的候选（null = 无合法候选：hard 全拒或生成器为空——显式失败，不回落名义坐标，设计 §5B）。 */
  chosen: SiteCandidate | null;
  /** 候选总数 / hard 拒绝数；chosen 为 null 时的首个拒绝原因样本（诊断）。 */
  candidates: number;
  rejected: number;
  rejectionReasons?: Array<{ reason: string; count: number }>;
  reason?: string;
};

/** 单类指派：生成 → hard 过滤 → soft 排序（降序，id 升序 tie-break）→ 取第一。纯函数（不改 world）。 */
export function assignSite(world: SiteCandidateWorld, spec: SiteSpec, current: { x: number; z: number }, weights: AssignWeights = ASSIGN_WEIGHTS, acceptCandidate?: (candidate: SiteCandidate) => string | null): SiteAssignment {
  const candidates = candidatesFor(world, spec, current);
  let rejected = 0; let firstReject: string | undefined;
  const rejectionCounts = new Map<string, number>();
  const reject = (reason: string) => { rejected += 1; rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1); firstReject ??= reason; };
  const rejectionSummary = () => acceptCandidate ? [...rejectionCounts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([reason, count]) => ({ reason, count })) : undefined;
  const ordered = candidates.map((candidate) => ({ candidate, score: softScore(world, spec, candidate, weights) }))
    .sort((a, b) => b.score - a.score || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0));
  // 按既定软分顺序试联合硬闸门，首个合法候选即全局最高偏好者，无需保存后续网络草稿。
  for (const { candidate } of ordered) {
    const hardReject = siteCandidateHardReject(world, spec, candidate);
    if (hardReject) { reject(hardReject); continue; }
    const bad = acceptCandidate?.(candidate) ?? null;
    if (bad === null) return { kind: spec.kind, chosen: candidate, candidates: candidates.length, rejected, ...(rejectionSummary() ? { rejectionReasons: rejectionSummary() } : {}) };
    reject(bad);
  }
  return { kind: spec.kind, chosen: null, candidates: candidates.length, rejected, ...(rejectionSummary() ? { rejectionReasons: rejectionSummary() } : {}), reason: firstReject ?? "all joint candidates refused" };
}

/**
 * 指派循环骨架：按 priority（升序）→ kind（字典序）逐类指派；接受的用地追加进 world.placed
 * （顺序放置语义，同 place()）。返回逐类结果（顺序 = 处理序，稳定）。
 * 挪用 world（追加 placed）之外无副作用；同输入两次运行同输出（守卫证明）。
 */
export function runAssignment(world: SiteCandidateWorld, specs: readonly SiteSpec[], weights: AssignWeights = ASSIGN_WEIGHTS): SiteAssignment[] {
  const ordered = [...specs].sort((a, b) => a.priority - b.priority || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const out: SiteAssignment[] = [];
  for (const spec of ordered) {
    // current = 名义锚点（行为变更批的先验意图；今天的管线用 place() 的名义位置 + 挪动遍，同源）。
    const current = nominalAnchorPoint(spec, world);
    const assignment = assignSite(world, spec, current, weights);
    out.push(assignment);
    if (assignment.chosen) world.placed.push({ x: assignment.chosen.x, z: assignment.chosen.z, radius: spec.radius });
  }
  return out;
}
