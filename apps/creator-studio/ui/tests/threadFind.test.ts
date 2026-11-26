import test from "node:test";
import assert from "node:assert/strict";
import { findApplyQuery, findCounter, findInitialState, findMove, highlightRanges } from "../src/features/agent/threadFind.ts";

test("highlightRanges splits case-insensitively into hit and plain segments", () => {
  const segments = highlightRanges("把出租车移到桥上，桥上要有路灯", "桥上");
  assert.deepEqual(segments, [
    { text: "把出租车移到", hit: false },
    { text: "桥上", hit: true },
    { text: "，", hit: false },
    { text: "桥上", hit: true },
    { text: "要有路灯", hit: false },
  ]);
  // 大小写不敏感。
  assert.equal(highlightRanges("Review the City", "city").filter(segment => segment.hit).length, 1);
  // 空查询返回整段无命中。
  assert.deepEqual(highlightRanges("任意文本", ""), [{ text: "任意文本", hit: false }]);
});

const rows = [
  { rowId: "turn-t1", text: "把出租车移到桥上" },
  { rowId: "settle-s1", text: "执行中 · 重建布局" },
  { rowId: "turn-t2", text: "重建布局后保存" },
];

test("findApplyQuery collects hits in row order and clamps the index", () => {
  const state = findApplyQuery(findInitialState(), "重建", rows);
  assert.equal(state.hits.length, 2);
  assert.deepEqual(state.hits.map(hit => hit.rowId), ["settle-s1", "turn-t2"]);
  assert.equal(state.index, 0);
  // 索引超出新命中数时收拢到末位。
  const narrowed = findApplyQuery({ query: "重建", hits: state.hits, index: 5 }, "重建", rows);
  assert.equal(narrowed.index, 1);
  // 空查询重置。
  assert.deepEqual(findApplyQuery(state, "", rows), { query: "", hits: [], index: -1 });
  assert.equal(findApplyQuery(findInitialState(), "不存在", rows).index, -1);
});

test("findMove wraps around and is a no-op without hits", () => {
  const state = findApplyQuery(findInitialState(), "重建", rows);
  assert.equal(findMove(state, 1).index, 1);
  // 回绕。
  assert.equal(findMove(findMove(state, 1), 1).index, 0);
  assert.equal(findMove(state, -1).index, 1);
  assert.deepEqual(findMove(findInitialState(), 1), findInitialState());
});

test("findCounter speaks user language: empty, x/y, or honest no-results", () => {
  assert.equal(findCounter(findInitialState()), "");
  assert.equal(findCounter(findApplyQuery(findInitialState(), "重建", rows)), "1/2");
  assert.equal(findCounter(findApplyQuery(findInitialState(), "不存在", rows)), "无结果");
});
