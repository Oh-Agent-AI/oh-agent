import { type NarrativeDiagnosticV1, type NarrativeResult } from "../contracts/diagnostics";
import type { StoryEdgeV2, StoryGraphV1 } from "./types";
declare const compareText: (left: string, right: string) => number;
/**
 * 结构非法图的显式错误（RFC V3-12：检测器故障必须明确 error，不得报告 passed）。
 * 算法入口在图结构非法时抛出本错误；需要结构化诊断的消费方先调用 validateStoryGraphV1。
 */
export declare class StoryGraphStructureErrorV1 extends Error {
    readonly diagnostics: readonly NarrativeDiagnosticV1[];
    constructor(diagnostics: readonly NarrativeDiagnosticV1[]);
}
/**
 * 结构校验：收集全部诊断（不做 fail-fast），顺序与输入数组顺序一致（确定性）。
 * 覆盖：节点/边条目形状、重复节点 id、重复边 id、悬空 from/to、自环、start 缺失。
 * 合法时 ok=true 并回传同一图引用；失败时 ok=false 且 diagnostics 至少一条
 * （V3-12：失败绝不返回空成功报告）。
 */
export declare function validateStoryGraphV1(graph: StoryGraphV1): NarrativeResult<StoryGraphV1>;
/** 算法入口共用的结构守卫：非法即抛 StoryGraphStructureErrorV1，绝不静默继续。 */
export declare function requireStoryGraphV1(graph: StoryGraphV1): NarrativeResult<StoryGraphV1>;
/** 已验证图上的邻接视图：出边按 id 再按 to 排序（确定性遍历顺序）。 */
export interface StoryGraphAdjacencyV1 {
    readonly nodeIds: readonly string[];
    readonly outgoingEdges: ReadonlyMap<string, readonly StoryEdgeV2[]>;
    readonly outgoingTargets: ReadonlyMap<string, readonly string[]>;
    readonly undirectedNeighbors: ReadonlyMap<string, readonly string[]>;
}
/** 由已验证图构建确定性邻接索引（排序、目标去重）。 */
export declare function buildStoryGraphAdjacencyV1(graph: StoryGraphV1): StoryGraphAdjacencyV1;
export { compareText };
