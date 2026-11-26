import test from "node:test";
import assert from "node:assert/strict";
import { distanceFromBottom, followModeAfterScroll, pillShouldShow, PILL_SHOW_DISTANCE } from "../src/features/agent/useTimelineFollow.ts";

const scroller = (height: number, top: number, client: number) => ({ scrollHeight: height, scrollTop: top, clientHeight: client } as unknown as HTMLElement);

test("follow releases on upward scroll and re-attaches near the bottom", () => {
  // 向上滚（scrollTop 变小且 >0）→ 释放跟随。
  assert.equal(followModeAfterScroll("following", scroller(1_000, 400, 300), 500), "released");
  // 在顶部继续向上滚不算释放（没有内容可滚）。
  assert.equal(followModeAfterScroll("following", scroller(1_000, 0, 300), 10), "following");
  // 向下滚不释放已跟随状态。
  assert.equal(followModeAfterScroll("following", scroller(1_000, 200, 300), 100), "following");
  // 已释放后向下滚但未贴底 → 保持释放。
  assert.equal(followModeAfterScroll("released", scroller(1_000, 200, 300), 400), "released");
  // 距底 ≤32px 无条件重新跟随。
  assert.equal(followModeAfterScroll("released", scroller(1_000, 670, 300), 400), "following");
  // 1px 抖动不误判为向上。
  assert.equal(followModeAfterScroll("following", scroller(1_000, 399, 300), 400), "following");
});

test("jump pill shows only when released and far from the bottom", () => {
  const el = scroller(1_000, 100, 300);
  assert.equal(distanceFromBottom(el), 600);
  assert.equal(pillShouldShow("released", el), true);
  assert.equal(pillShouldShow("following", el), false);
  assert.equal(pillShouldShow("released", scroller(1_000, 100 + 600 - PILL_SHOW_DISTANCE, 300)), false);
  assert.equal(pillShouldShow("released", null), false);
});
