import type { StoryEdgePredicateV1, StoryGraphV1 } from "./types";
/**
 * 从 start 出发的有向 BFS 可达集（含 start 自身）。
 * 输出按节点 id 升序排序；输入不可变；图结构非法或 start 未知时抛
 * StoryGraphStructureErrorV1（V3-12：结构故障显式报错，绝不静默返回看似成功的结果）。
 */
export declare function reachability(graph: StoryGraphV1, start: string): readonly string[];
/**
 * 条件可达（RFC §4.2 检查 1）：有图边 ≠ 条件可达。
 * `canTraverse` 由调用方注入，逐条边判定是否可通行；本包不求值 ConditionV2
 * （那是 ADR-01 之后的宿主工作）。输出确定性排序；结构非法时抛
 * StoryGraphStructureErrorV1。
 */
export declare function conditionalReachability(graph: StoryGraphV1, start: string, canTraverse: StoryEdgePredicateV1): readonly string[];
