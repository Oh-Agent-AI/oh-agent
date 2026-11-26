import type { StoryGraphV1 } from "./types";
/**
 * Tarjan 强连通分量（迭代实现，避免深图递归栈溢出）。
 * 每个分量内部按节点 id 升序排序；分量之间按各自最小成员升序排序；
 * 因此结果与输入数组顺序无关（纯集合划分 + 规范排序）。
 * 图结构非法时抛 StoryGraphStructureErrorV1。
 */
export declare function stronglyConnectedComponents(graph: StoryGraphV1): readonly (readonly string[])[];
