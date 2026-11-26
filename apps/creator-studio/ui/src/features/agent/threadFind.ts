/**
 * 会话时间线查找（T3 find-in-thread 的简化移植）：搜索范围是行模型的
 * 可见文本（回合请求、settle 行）；命中以段级标记渲染在回合行内，导航
 * 负责滚动定位。aria-live 计数由渲染层以 role="status" 承载。
 */
export type FindSegment = Readonly<{ text: string; hit: boolean }>;

/** 大小写不敏感的左到右非重叠切分；空查询返回整段无命中。 */
export function highlightRanges(text: string, query: string): readonly FindSegment[] {
  if (!query) return Object.freeze([Object.freeze({ text, hit: false })]);
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return Object.freeze([Object.freeze({ text, hit: false })]);
  const segments: FindSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) { segments.push(Object.freeze({ text: text.slice(cursor), hit: false })); break; }
    if (index > cursor) segments.push(Object.freeze({ text: text.slice(cursor, index), hit: false }));
    segments.push(Object.freeze({ text: text.slice(index, index + needle.length), hit: true }));
    cursor = index + needle.length;
  }
  return Object.freeze(segments);
}

export type TimelineHit = Readonly<{ rowId: string; position: number }>;
export type FindState = Readonly<{ query: string; hits: readonly TimelineHit[]; index: number }>;

export function findInitialState(): FindState {
  return Object.freeze({ query: "", hits: Object.freeze([]), index: -1 });
}

export type FindableRow = Readonly<{ rowId: string; text: string }>;

/** 以新查询重建命中（保持行序）；索引收拢到合法范围，空查询清空。 */
export function findApplyQuery(state: FindState, query: string, rows: readonly FindableRow[]): FindState {
  if (!query) return findInitialState();
  const hits: TimelineHit[] = [];
  for (const row of rows) {
    const haystack = row.text.toLowerCase();
    const needle = query.toLowerCase();
    if (!needle) continue;
    let position = haystack.indexOf(needle);
    while (position >= 0) {
      hits.push(Object.freeze({ rowId: row.rowId, position }));
      position = haystack.indexOf(needle, position + needle.length);
    }
  }
  const index = hits.length === 0 ? -1 : Math.min(state.index < 0 ? 0 : state.index, hits.length - 1);
  return Object.freeze({ query, hits: Object.freeze(hits), index });
}

/** 下一个/上一个命中；循环回绕，无命中时原样返回。 */
export function findMove(state: FindState, direction: 1 | -1): FindState {
  if (state.hits.length === 0) return state;
  const index = (state.index + direction + state.hits.length) % state.hits.length;
  return Object.freeze({ ...state, index });
}

/** 计数文案：无查询为空串；有查询无命中为「无结果」。 */
export function findCounter(state: FindState): string {
  if (!state.query) return "";
  if (state.hits.length === 0) return "无结果";
  return `${state.index + 1}/${state.hits.length}`;
}
