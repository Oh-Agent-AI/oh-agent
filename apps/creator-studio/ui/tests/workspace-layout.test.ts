import test from "node:test";
import assert from "node:assert/strict";
import {
  clampWorkspaceWidths, defaultWorkspaceWidths, parseWorkspaceLayout, parseWorkspaceWidths, readWorkspaceLayout, rememberWorkspaceLayout,
  WORKSPACE_MIN_AGENT, WORKSPACE_MIN_PREVIEW, WORKSPACE_MIN_SESSIONS, WORKSPACE_SPLITTER,
} from "../src/features/workspace/workspaceLayout.ts";

const availableOf = (total: number) => total - 2 * WORKSPACE_SPLITTER;

test("默认比例 16/34 在宽窗口成立，预览吃掉剩余宽度", () => {
  const total = 1600;
  const widths = defaultWorkspaceWidths(total);
  assert.equal(widths.sessions, Math.round(availableOf(total) * 0.16));
  assert.equal(widths.agent, Math.round(availableOf(total) * 0.34));
  assert.ok(availableOf(total) - widths.sessions - widths.agent >= WORKSPACE_MIN_PREVIEW);
});

test("夹取保证三栏最小宽，拖一栏不会把另一栏顶出最小宽", () => {
  const total = 1440;
  const available = availableOf(total);
  assert.equal(clampWorkspaceWidths({ sessions: 5000, agent: 360 }, total).sessions,
    available - WORKSPACE_MIN_AGENT - WORKSPACE_MIN_PREVIEW);
  const squeezed = clampWorkspaceWidths({ sessions: 10, agent: 10 }, total);
  assert.equal(squeezed.sessions, WORKSPACE_MIN_SESSIONS);
  assert.equal(squeezed.agent, WORKSPACE_MIN_AGENT);
  const widened = clampWorkspaceWidths({ sessions: 400, agent: 9999 }, total);
  assert.equal(widened.sessions, 400);
  assert.equal(widened.agent, available - 400 - WORKSPACE_MIN_PREVIEW);
  // 合法值只做整像素取整，不被抖动。
  assert.deepEqual(clampWorkspaceWidths({ sessions: 300.4, agent: 500.6 }, total), { sessions: 300, agent: 501 });
});

test("窄到装不下三栏最小宽时按比例压缩，而不是溢出或负宽", () => {
  const total = 700;
  const widths = defaultWorkspaceWidths(total);
  assert.ok(widths.sessions >= 120 && widths.agent >= 200);
  assert.ok(widths.sessions + widths.agent < availableOf(total));
  assert.deepEqual(clampWorkspaceWidths({ sessions: 300, agent: 500 }, total), widths);
});

test("布局记忆只接受合法数字，并按 Project 分开存", () => {
  const values = new Map<string, string>();
  const previous = globalThis.window;
  Object.assign(globalThis, { window: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } } });
  try {
    assert.deepEqual(parseWorkspaceWidths({ sessions: 300, agent: 500 }), { sessions: 300, agent: 500 });
    assert.equal(parseWorkspaceWidths({ sessions: "300", agent: 500 }), null);
    assert.equal(parseWorkspaceWidths({ sessions: 300 }), null);
    assert.equal(parseWorkspaceWidths(null), null);
    assert.equal(parseWorkspaceWidths({ sessions: 50, agent: 500 }), null);
    assert.equal(parseWorkspaceWidths({ sessions: Number.NaN, agent: 500 }), null);
    rememberWorkspaceLayout("project-a", { widths: { sessions: 301.4, agent: 502.6 }, focus: "preview" });
    rememberWorkspaceLayout("project-b", { widths: { sessions: 333, agent: 444 }, focus: "balanced" });
    assert.deepEqual(readWorkspaceLayout("project-a"), { widths: { sessions: 301, agent: 503 }, focus: "preview" });
    assert.deepEqual(readWorkspaceLayout("project-b"), { widths: { sessions: 333, agent: 444 }, focus: "balanced" });
    assert.equal(readWorkspaceLayout("project-c"), null);
    // 坏的本地 JSON 当"没存过"，不能让一次手滑写坏就永远打不开工作区。
    values.set("oh-agent.studio.workspace-layout.v1:broken", "{oops");
    assert.equal(readWorkspaceLayout("broken"), null);
    // 空 key（还没选 Project）不读不写。
    rememberWorkspaceLayout("", { widths: { sessions: 300, agent: 500 }, focus: "preview" });
    assert.equal(readWorkspaceLayout(""), null);
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.assign(globalThis, { window: previous });
  }
});

test("旧布局记录没有 focus 字段时退回 balanced，不被一次升级作废", () => {
  assert.deepEqual(parseWorkspaceLayout({ sessions: 300, agent: 500 }),
    { widths: { sessions: 300, agent: 500 }, focus: "balanced" });
  assert.deepEqual(parseWorkspaceLayout({ sessions: 300, agent: 500, focus: "preview" }),
    { widths: { sessions: 300, agent: 500 }, focus: "preview" });
  // 未知模式值一律当 balanced：宁可回到三栏，也不要卡在一个不存在的模式里。
  assert.equal(parseWorkspaceLayout({ sessions: 300, agent: 500, focus: "fullscreen" })?.focus, "balanced");
  assert.equal(parseWorkspaceLayout({ sessions: 300, agent: 500, focus: 7 })?.focus, "balanced");
  assert.equal(parseWorkspaceLayout({ agent: 500 }), null);
});
