import { DetMath as Math } from "./detMath"; // 跨引擎确定性：见 detMath.ts
// 档位叶子工具（CITY_PLANNER_REFACTOR_SPEC R1）：逐字搬自 cityPlan.ts。

/** 每档对应的目标地块数（SPEC §4.2：400 会话一档 × 1.35 余量给公共用地、花园、配套与道路损耗）。 */
// 档位：每档 400 栋，按会话数逐档扩张大陆，最多 10 档 = 4000 栋（一年的会话）。
// 曾一度改成「1 档就预留 2000 栋」：会话少时整座岛空旷得像荒地（真机截图反馈），
// 所以初始面积回到原版的 400 栋一档，随数据逐步长大。
export const SESSIONS_PER_TIER = 400;
export const MAX_TIER = 10;
export function scaleTierFor(sessions: number): number {
  return Math.max(1, Math.min(MAX_TIER, Math.ceil(sessions / SESSIONS_PER_TIER)));
}
export const targetParcels = (tier: number) => Math.ceil(SESSIONS_PER_TIER * tier * 1.35);
