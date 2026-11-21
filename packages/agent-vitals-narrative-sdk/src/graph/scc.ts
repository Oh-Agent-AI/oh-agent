import { buildStoryGraphAdjacencyV1, compareText } from "./validate";
import type { StoryGraphV1 } from "./types";

/**
 * Tarjan 强连通分量（迭代实现，避免深图递归栈溢出）。
 * 每个分量内部按节点 id 升序排序；分量之间按各自最小成员升序排序；
 * 因此结果与输入数组顺序无关（纯集合划分 + 规范排序）。
 * 图结构非法时抛 StoryGraphStructureErrorV1。
 */
export function stronglyConnectedComponents(graph: StoryGraphV1): readonly (readonly string[])[] {
  const adjacency = buildStoryGraphAdjacencyV1(graph);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let nextIndex = 0;

  for (const root of adjacency.nodeIds) {
    if (index.has(root)) continue;
    index.set(root, nextIndex);
    low.set(root, nextIndex);
    nextIndex += 1;
    stack.push(root);
    onStack.add(root);
    const frames: Array<{ readonly node: string; cursor: number }> = [{ node: root, cursor: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const neighbors = adjacency.outgoingTargets.get(frame.node) ?? [];
      if (frame.cursor < neighbors.length) {
        const next = neighbors[frame.cursor]!;
        frame.cursor += 1;
        if (!index.has(next)) {
          index.set(next, nextIndex);
          low.set(next, nextIndex);
          nextIndex += 1;
          stack.push(next);
          onStack.add(next);
          frames.push({ node: next, cursor: 0 });
        } else if (onStack.has(next)) {
          const candidate = index.get(next)!;
          if (candidate < low.get(frame.node)!) low.set(frame.node, candidate);
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        const childLow = low.get(frame.node)!;
        if (childLow < low.get(parent.node)!) low.set(parent.node, childLow);
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        components.push(component.sort(compareText));
      }
    }
  }
  components.sort((left, right) => compareText(left[0]!, right[0]!));
  return components;
}
