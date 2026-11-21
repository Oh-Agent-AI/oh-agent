/**
 * Narrative Engine contracts（OH_AGENT_NARRATIVE_ENGINE_SPEC §4）。
 *
 * 五个 DTO 是宿主/求值器/Agent 三方的唯一接口。所有字段 readonly（构造后不可变）；
 * 字节预算与 spec 一致（graph ≤256 KiB、canon ≤64 KiB、payload ≤16 KiB）。
 * 求值器只消费 Snapshot，只产出 Decision——不存在可变共享状态。
 */
/** 已授权的 Story 作用域（宿主从 story_runs 表派生，不采信调用方自报）。 */
export interface NarrativeScopeV1 {
    readonly playerId: string;
    readonly cityId: string;
    readonly storyId: string;
    readonly storyRunId: string;
}
/** 求值快照：宿主在授权 + 读取事实后构造，冻结后传给求值器。 */
export interface NarrativeSnapshotV1 {
    readonly scope: NarrativeScopeV1;
    /** 安装发布的内容摘要（不可变 Release 绑定）。 */
    readonly contentDigest: string;
    /** Story 状态版本（CAS 用；版本变 → 旧裁决拒绝提交）。 */
    readonly stateVersion: string;
    /** 当前剧情游标（当前所在节点 id）。 */
    readonly cursor: string;
    /** 已提交事件 id（按 Run 作用域过滤，由宿主从 story_events 读取）。 */
    readonly committedEvents: readonly string[];
    /** 布尔标记（本 Run 的 story_states 事实）。 */
    readonly flags: Readonly<Record<string, boolean>>;
    /** 有界计数器（本 Run 的 story_states 事实；key → 非负整数值）。 */
    readonly counters: Readonly<Record<string, number>>;
    /** 参与判断的时钟 tick 或世界版本（确定性绑定）。 */
    readonly clockTick: number;
}
/** 可执行条件联合类型。未知 `op` 由求值器 fail-closed 拒绝。 */
export type NarrativeConditionV1 = {
    readonly op: "flag";
    readonly key: string;
    readonly expected: boolean;
} | {
    readonly op: "counter.gte";
    readonly key: string;
    readonly value: number;
} | {
    readonly op: "counter.lte";
    readonly key: string;
    readonly value: number;
} | {
    readonly op: "event.exists";
    readonly eventId: string;
} | {
    readonly op: "all";
    readonly of: readonly NarrativeConditionV1[];
};
/** 可执行效果联合类型。未知 `op` 由求值器 fail-closed 拒绝。 */
export type NarrativeEffectV1 = {
    readonly op: "flag.set";
    readonly key: string;
    readonly value: boolean;
} | {
    readonly op: "counter.add";
    readonly key: string;
    readonly value: number;
} | {
    readonly op: "event.append";
    readonly eventId: string;
    readonly ruleId: string;
} | {
    readonly op: "cursor.advance";
    readonly to: string;
};
/** Agent 提交的受限提案（回合 ID + 幂等操作 ID + 选定剧情边 + 可选对白）。 */
export interface ActorProposalV1 {
    readonly turnId: string;
    readonly operationId: string;
    /** 选定的剧情边（Agent 在 eligibleBeats 菜单中选中的目标边）。 */
    readonly edgeId: string;
    /** 有界对白（可呈现内容；≤4 KiB）。 */
    readonly dialogue?: string;
}
/** 求值裁决：通过或拒绝，绑定快照版本。 */
export interface NarrativeDecisionV1 {
    readonly accepted: boolean;
    readonly diagnostics: readonly string[];
    /** 求值所用快照的 stateVersion（提交时 CAS 校验）。 */
    readonly evaluatedAtVersion: string;
    /** 通过时：要执行的效果列表（宿主在事务内落盘）。 */
    readonly effects: readonly NarrativeEffectV1[];
    /** 通过时：新游标（当前边的 to 节点）。 */
    readonly newCursor: string;
}
/** 提交回执：宿主在短事务内落盘后返回。 */
export interface NarrativeCommitReceiptV1 {
    readonly operationId: string;
    readonly committedEventIds: readonly string[];
    readonly newStateVersion: string;
    readonly turnStatus: "confirmed" | "already_confirmed" | "rejected";
}
export declare const NARRATIVE_GRAPH_MAX_BYTES: number;
export declare const NARRATIVE_CANON_MAX_BYTES: number;
export declare const NARRATIVE_DIALOGUE_MAX_BYTES: number;
export declare const NARRATIVE_MAX_CONDITIONS = 8;
export declare const NARRATIVE_MAX_EFFECTS = 4;
