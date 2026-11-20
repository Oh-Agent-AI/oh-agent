/**
 * Story Graph 类型（RFC OH_AGENT_CITY_SDK_V3_INTEGRATION §4.2 StoryEdgeV2）。
 *
 * 包定位（RFC §2）：narrative-sdk 是纯算法 + 创作者契约，可引用 City/Game 类型、
 * 绝不被 City/Game 反向依赖。S-5 第一部分保持零 npm 运行时依赖，因此
 * `scope` / `preconditions` / `effects` 先用下方最小占位类型；集成 PR 中整体替换：
 *   - ScopeRef      -> city-sdk StateScopeV1（RFC §3.5.1 判别联合，Shared Contracts 拥有）
 *   - ConditionRef  -> city-sdk ConditionV2（有限 AST：all/any/not、eq/gte、at-place…）
 *   - effects 元素   -> city-sdk GameEffectV2（白名单 effect）
 * 占位类型不得参与任何条件求值；ConditionV2 求值器属于 ADR-01 之后的宿主工作。
 */
/** 占位：集成时换 city-sdk `StateScopeV1`（RFC §3.5.1 判别联合）。 */
export type ScopeRef = string;
/** 占位：集成时换 city-sdk `ConditionV2` / `GameEffectV2`。本包只携带、不求值。 */
export type ConditionRef = Readonly<Record<string, unknown>>;
/** Story 图节点。`kind` 的创作者词汇表随 S-5 后续部分的 creator contract 定稿。 */
export interface StoryNodeV1 {
    readonly id: string;
    readonly kind: string;
    readonly title?: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}
/** Story 图有向边（RFC §4.2 字段集；scope/preconditions/effects 为占位类型）。 */
export interface StoryEdgeV2 {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly preconditions: ConditionRef;
    readonly effects: readonly ConditionRef[];
    readonly eventDependencies: readonly string[];
    readonly scope: ScopeRef;
}
/** Story 图容器。`start` 是结构分析（islands）的入口节点身份。 */
export interface StoryGraphV1 {
    readonly start: string;
    readonly nodes: readonly StoryNodeV1[];
    readonly edges: readonly StoryEdgeV2[];
}
/** 条件可达的注入谓词：调用方决定一条边是否可通行；本包不求值 ConditionV2。 */
export type StoryEdgePredicateV1 = (edge: StoryEdgeV2) => boolean;
