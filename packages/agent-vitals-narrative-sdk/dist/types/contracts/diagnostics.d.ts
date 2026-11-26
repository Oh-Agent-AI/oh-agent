/**
 * Narrative SDK 验证错误契约（RFC OH_AGENT_CITY_SDK_V3_INTEGRATION §4.3 / 验收 V3-12）。
 *
 * 图检测器失败时必须显式报告错误，绝不允许以空诊断的"成功报告"掩盖失败：
 * `ok: false` 永远伴随至少一条 diagnostics；`validator_error` 与 `passed`
 * 是两个严格可区分的状态，消费方不得把失败当作通过。
 *
 * 结果形状对齐 @oh-agent/city-sdk 的 `Result<T>` / `DiagnosticV1`
 * （city-sdk/src/types.ts），便于宿主侧统一消费；本包不 import city-sdk，
 * 集成 PR 才替换占位类型。
 */
export interface NarrativeDiagnosticV1 {
    readonly code: string;
    readonly severity: "error" | "warning";
    readonly path: string;
    readonly message: string;
}
export type NarrativeResult<T> = {
    readonly ok: true;
    readonly value: T;
    readonly diagnostics: readonly NarrativeDiagnosticV1[];
} | {
    readonly ok: false;
    readonly diagnostics: readonly NarrativeDiagnosticV1[];
};
/** 图检测结论状态：`passed` 与 `validator_error` 严格互斥（V3-12）。 */
export declare const STORY_GRAPH_CHECK_STATUSES_V1: readonly ["passed", "validator_error"];
export type StoryGraphCheckStatusV1 = (typeof STORY_GRAPH_CHECK_STATUSES_V1)[number];
/** 把结构化验证结果映射为检测状态；失败（含空诊断防线）只能是 validator_error。 */
export declare function storyGraphCheckStatusV1(result: NarrativeResult<unknown>): StoryGraphCheckStatusV1;
/** 内部构造器：统一 severity=error 的诊断形状。 */
export declare function narrativeErrorV1(code: string, path: string, message: string): NarrativeDiagnosticV1;
/** 失败结果的唯一构造入口：保证失败永不携带空诊断（V3-12 的代码级防线）。 */
export declare function narrativeFailureV1(diagnostics: readonly NarrativeDiagnosticV1[]): NarrativeResult<never>;
