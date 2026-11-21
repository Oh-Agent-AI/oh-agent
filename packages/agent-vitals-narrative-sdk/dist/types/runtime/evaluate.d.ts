/**
 * 纯 TS 求值器（OH_AGENT_NARRATIVE_ENGINE_SPEC §4 可执行子集）。
 *
 * 相同快照 + 规则版本 + 提案 → 相同裁决（确定性）。
 * 不依赖宿主 / DB / 网络 / 时钟；所有事实由 Snapshot 显式提供。
 * 未识别条件 / 效果 / 伪造事实 fail-closed。
 */
import type { ActorProposalV1, NarrativeDecisionV1, NarrativeSnapshotV1 } from "../contracts/engine";
import type { StoryGraphV1 } from "../graph/types";
/**
 * 核心求值入口：Agent 提交一条提案，宿主在当前快照下裁决。
 *
 * 判定顺序：
 * 1. 快照游标必须等于提案边的 from 节点（Agent 不能跳节点）。
 * 2. 边必须在图中存在（防伪造 edgeId）。
 * 3. 前置条件全部满足。
 * 4. 效果子集合法。
 *
 * 任何一步不满足 → accepted:false + 诊断。全部满足 → accepted:true + 效果列表。
 */
export declare function evaluateProposal(graph: StoryGraphV1, snapshot: NarrativeSnapshotV1, proposal: ActorProposalV1): NarrativeDecisionV1;
/** 对给定图的指定节点计算 eligibleBeats 菜单（替代旧版硬编码邀请规则）。 */
export declare function eligibleEdges(graph: StoryGraphV1, snapshot: NarrativeSnapshotV1): {
    edgeId: string;
    to: string;
}[];
