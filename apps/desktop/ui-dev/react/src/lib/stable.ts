/**
 * 后台刷新的「不抖」原则：新数据与旧数据内容相同就沿用旧引用。
 * React 对同一引用的 setState 直接跳过渲染，DOM 不动；只有数据真的变了才更新对应的 DOM。
 * 之前每次事件触发的刷新都会换上新对象（哪怕内容一样）并翻转 loading，整页重渲染、
 * 插入又移除提示块，页面因此反复抖动、跳位。
 */
export function stable<T>(previous: T | null | undefined, next: T): T {
  try {
    if (previous != null && JSON.stringify(previous) === JSON.stringify(next)) return previous;
  } catch { /* 不可序列化就按新值处理 */ }
  return next;
}

/** 手动触发（onClick 会把事件对象当参数传进来）与后台触发的区分：只有严格 `true` 才算后台。 */
export const isBackground = (flag: unknown): boolean => flag === true;
