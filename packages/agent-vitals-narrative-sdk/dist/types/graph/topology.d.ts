import type { StoryGraphV1 } from "./types";
/**
 * 死胡同节点：没有任何出边的节点（AVG Maker 迁移清单 `deadEndDetector` 的
 * 纯图部分，RFC §4.3）。输出升序排序；图结构非法时抛 StoryGraphStructureErrorV1。
 */
export declare function deadEnds(graph: StoryGraphV1): readonly string[];
/**
 * 孤岛：弱连通分量中不包含任何"从 graph.start 有向可达节点"的分量。
 * 语义说明（RFC §4.2）：判定在分量级别——分量内只要有一个节点可达即非孤岛；
 * 节点级不可达集可直接用 reachability(graph, graph.start) 的补集观察。
 * 每个分量内部升序排序，分量之间按最小成员升序排序；结构非法时抛错。
 */
export declare function islands(graph: StoryGraphV1): readonly (readonly string[])[];
