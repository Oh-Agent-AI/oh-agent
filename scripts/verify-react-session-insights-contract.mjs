#!/usr/bin/env node
// 会话消耗诊断的桌面契约（SESSION_TRACE_DIAGNOSTICS_SPEC r6 §6、§8、§10）。
//
// 三层：
// 1. 桥（lib/sessionInsights.ts）：mock 形状能解析；越界/未知词表/超长摘录被拒绝，
//    而不是静默渲染。mock 形状出处见 public/tauri-mock.js 的 `mockInsights`。
// 2. 几何（features/sessions/insightsGeometry.ts）：比例尺错了图照样画得出来，所以
//    直接断言不变量——诊断区间永不因窗口消失、窗口包含焦点、柱位单调且在绘图区内、
//    长空闲缝隙只出现在窗口内。
// 3. 文案（SessionInsights.tsx 的 diagText）：事实与原因分开；不出现「多付/可节省/浪费」；
//    诊断不带金额。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const uiRequire = createRequire(path.join(ui, "package.json"));
const { buildSync } = uiRequire("esbuild");

// 真实诊断也要过文案检查（在第 3 节加载组件后才有 diagText，这里先登记，最后统一检）。
const pendingCopyChecks = [];
function view_copy_check(d) { pendingCopyChecks.push(d); }

function load(entry, globals = {}) {
  const built = buildSync({
    entryPoints: [path.join(ui, entry)], bundle: true, format: "cjs", platform: "node", target: "node20", write: false, logLevel: "silent",
    loader: { ".css": "empty" }, external: ["react", "react/jsx-runtime", "react-dom"],
  });
  const sandbox = { module: { exports: {} }, exports: {}, require: uiRequire, console: { error() {}, warn() {}, log() {} }, Intl, Date, Math, Number, Object, Array, JSON, String, Promise, setTimeout, clearTimeout, window: {}, ...globals };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: entry });
  return sandbox.module.exports;
}

function loadMock() {
  const sandbox = { console: { error() {}, warn() {}, log() {} }, Intl, Date, Math, Promise, setTimeout, clearTimeout, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(ui, "public/tauri-mock.js"), "utf8"), sandbox, { filename: "tauri-mock.js" });
  return sandbox.window.__TAURI__.core.invoke;
}

// ── 1. 桥 ──
const mockInvoke = loadMock();
const calls = [];
const invoke = async (command, args) => { calls.push({ command, args }); return mockInvoke(command, args); };
const bridge = load("react/src/lib/sessionInsights.ts", { window: { __TAURI__: { core: { invoke } } } });

const insights = await bridge.readSessionInsights("sr_browser_mock_01");
assert.equal(calls.at(-1).command, "session_trace");
assert.equal(calls.at(-1).args.output, "insights");
assert.equal(insights.axis.unit, "turn");
assert.equal(insights.axis.steps.length, 40);
assert.equal(insights.diagnostics[0].kind, "repeated_failure");
assert.equal(insights.diagnostics[0].cause, "evidence");
assert.equal(insights.session.nominal_cost.amounts[0].currency, "USD");
assert.equal(insights.quality.legacy_fingerprints, 0, "缺省 quality 按 0 处理");
await assert.rejects(() => bridge.readSessionInsights("../etc/passwd"), /session_ref 不安全/);

const evidence = await bridge.readSessionTraceEvidence("sr_browser_mock_01", 18, 20);
assert.equal(calls.at(-1).command, "session_trace_evidence", "证据走本地命令，不走 MCP 的 session_trace");
assert.equal(evidence.failures.length, 3);
assert.match(evidence.failures[0].error_excerpt, /Cannot find module/);
await assert.rejects(() => bridge.readSessionTraceEvidence("sr_browser_mock_01", 5, 2), /证据区间不安全/);

const base = await mockInvoke("session_trace", { output: "insights" });
const mutate = (fn) => { const copy = JSON.parse(JSON.stringify(base)); fn(copy.data); return copy; };
assert.throws(() => bridge.parseSessionInsights(mutate(d => { d.diagnostics[0].steps.to = 999; })), /诊断区间越界/);
assert.throws(() => bridge.parseSessionInsights(mutate(d => { d.diagnostics[0].kind = "wasted_money"; })), /词表/);
assert.throws(() => bridge.parseSessionInsights(mutate(d => { d.axis.steps[3].index = 9; })), /回合序号不连续/);
assert.throws(() => bridge.parseSessionInsights(mutate(d => { d.axis.steps[0].hit_rate = 1.5; })), /比例不安全/);
assert.throws(() => bridge.parseSessionInsights(mutate(d => { d.safety.rules[0].rule = "rm -rf /"; })), /规则码不安全/);
assert.throws(() => bridge.parseSessionInsights({ error: { code: "internal_error" } }), /暂不可用/);
const evBase = await mockInvoke("session_trace_evidence", { from: 18, to: 20 });
const longExcerpt = JSON.parse(JSON.stringify(evBase)); longExcerpt.data.failures[0].error_excerpt = "x".repeat(5000);
assert.throws(() => bridge.parseSessionTraceEvidence(longExcerpt), /摘录不安全/);
// 真实形状金样（Rust 测试 insights_golden_fixture_matches_the_rust_output 产出）：前端解析器必须
// 接受真实输出——此前只测手写 mock，mock 总带 ended_at_ms，真实输出省略它时一半会话被拒。
const golden = JSON.parse(readFileSync(path.join(repo, "fixtures/session_insights/insights_envelope.json"), "utf8"));
const real = bridge.parseSessionInsights(golden);
assert.equal(real.axis.leading_step, true);
assert.ok(real.axis.steps.some(s => s.ended_at_ms === null), "缺 ended_at_ms 的步被接受为 null");
assert.deepEqual([...new Set(real.diagnostics.map(d => d.kind))].sort(), ["high_uncached_input", "input_growth", "repeated_failure"], "金样覆盖三类诊断");
assert.ok(real.session.nominal_cost && real.axis.steps.some(s => s.nominal_cost), "金样带名义成本");
assert.ok(real.axis.steps.some(s => s.outcome === "cancelled") && real.axis.steps.some(s => s.notes.length), "金样带回合结果与说明");
for (const d of real.diagnostics) view_copy_check(d);
const perCall = bridge.parseSessionInsights(JSON.parse(readFileSync(path.join(repo, "fixtures/session_insights/insights_envelope_per_call.json"), "utf8")));
assert.equal(perCall.axis.fallback, "few_turn_starts");
assert.equal(perCall.lanes.tools.state, "unavailable");
assert.equal(perCall.lanes.tools.reason, "no_data_in_session");
assert.equal(perCall.session.nominal_cost_reason, "no_pricing_snapshot", "无价格快照时说明原因");
const long = await bridge.readSessionInsights("sr_browser_mock_02");
assert.equal(long.axis.steps.length, 420, "长会话样本");
assert.ok(long.axis.steps.some(s => s.ended_at_ms === null));
const safetyOnly = await bridge.readSessionTraceEvidence("sr_browser_mock_01", 1, 420, false);
assert.equal(calls.at(-1).args.includeCalls, false, "安全视图不搬逐次调用");
assert.equal(safetyOnly.calls.length, 0);
await assert.rejects(() => bridge.readSessionTraceEvidence("sr_browser_mock_01", 1, 9000), /证据区间过大/);
console.log("Session insights bridge: OK (real golden + mock parse, evidence via local command, malformed rejected)");

// ── 2. 几何 ──
const geo = load("react/src/features/sessions/insightsGeometry.ts");
const mkSteps = (n, idleAt = new Map()) => Array.from({ length: n }, (_, i) => ({ index: i + 1, idle_before_ms: idleAt.get(i + 1) ?? 60_000 }));
for (const total of [5, 40, 420, 2447]) {
  const plotW = 700;
  const maxV = geo.maxVisibleSteps(plotW);
  for (const [from, to] of [[1, 1], [Math.ceil(total / 2), Math.ceil(total / 2) + 2], [total, total], [1, total]]) {
    const view = geo.chartWindow(total, maxV, null, Math.min(from, total), Math.min(to, total));
    assert.ok(view[0] >= 1 && view[1] <= Math.max(total, 1) && view[0] <= view[1], `window in bounds ${view}`);
    if (to - from + 1 <= maxV) assert.ok(view[0] <= from && Math.min(to, total) <= view[1], `window ${view} contains focus ${from}-${to} (total ${total})`);
    const steps = mkSteps(total, new Map([[3, 47 * 60_000], [Math.ceil(total / 2) + 1, 90 * 60_000]]));
    const layout = geo.layoutSteps(steps, view, 52, plotW);
    assert.equal(layout.slots.length, view[1] - view[0] + 1, "每个窗口内的步都有柱位（不抽稀）");
    for (let k = 1; k < layout.slots.length; k += 1) assert.ok(layout.slots[k].x > layout.slots[k - 1].x, "柱位单调");
    const last = layout.slots.at(-1);
    assert.ok(last.x + last.w <= 52 + plotW + 1e-6, "柱位不越出绘图区");
    for (const gap of layout.gaps) assert.ok(gap.beforeIndex > view[0] && gap.beforeIndex <= view[1], "缝隙只在窗口内");
    // 诊断区间永不消失：窗口内给位置，窗口外给方向。
    for (const range of [{ from: 1, to: 2 }, { from: total, to: total }, { from: Math.max(1, total - 3), to: total }]) {
      const band = geo.bandFor(range, view, layout);
      if (band.kind === "visible") assert.ok(band.w > 0);
      else assert.ok(band.side === "left" || band.side === "right");
      const intersects = range.to >= view[0] && range.from <= view[1];
      assert.equal(band.kind === "visible", intersects, `band visibility for ${JSON.stringify(range)} in ${view}`);
    }
  }
}
// 缩略图设定的窗口在没有新导航动作时保持（此前每次渲染都被拽回当前诊断）。
const maxV = geo.maxVisibleSteps(700);
const userView = [300, 299 + maxV];
assert.deepEqual([...geo.resolveWindow(440, maxV, { view: userView, navKey: "7" }, "7", 18, 20, userView)], userView, "没有新导航：保留用户窗口");
const moved = geo.resolveWindow(440, maxV, { view: userView, navKey: "7" }, "8", 18, 20, userView);
assert.ok(moved[0] <= 18 && 20 <= moved[1], "新导航到视野外的焦点：窗口移过去");
// 回归（确认轮）：点一下已在视野内的柱子不得让整图重新居中。
const clickVisible = geo.resolveWindow(440, maxV, { view: userView, navKey: "7" }, "8", 310, 310, userView);
assert.deepEqual([...clickVisible], userView, "焦点已在视野内：窗口不动");
// 诊断底带：每条都有行；同一行（最后一行溢出除外）不重叠。
const ranges = Array.from({ length: 43 }, (_, i) => ({ from: 1 + (i * 7) % 400, to: 3 + (i * 7) % 400 }));
const rows = geo.packBands(ranges, 6);
assert.equal(rows.length, 43, "43 条诊断都有带");
assert.ok(rows.every(r => r >= 0 && r < 6));
for (let r = 0; r < 5; r += 1) {
  const inRow = ranges.filter((_, i) => rows[i] === r).sort((a, b) => a.from - b.from);
  for (let k = 1; k < inRow.length; k += 1) assert.ok(inRow[k].from > inRow[k - 1].to, `row ${r} overlaps`);
}
// 窗口外的诊断分组：并集恒等于全体（不丢），且窗口内/外的判定与 bandFor 一致
// （真机 444 回合的会话有 20+ 条窗口外诊断，原先全挤在同一个位置——2026-09-29）。
{
  const view = [50, 90];
  const layout = geo.layoutSteps(Array.from({ length: 444 }, (_, i) => ({ index: i + 1, idle_before_ms: null })), view, 52, 600);
  const ranges = [{ from: 1, to: 5 }, { from: 200, to: 205 }, { from: 60, to: 65 }, { from: 300, to: 301 }, { from: 350, to: 355 }];
  const bands = ranges.map(r => geo.bandFor(r, view, layout));
  const g = geo.groupBandVisibility(bands);
  const all = [...g.visible, ...g.offLeft, ...g.offRight].sort((a, b) => a - b);
  assert.deepEqual(all, [0, 1, 2, 3, 4], "并集覆盖全部诊断，不丢一条");
  assert.deepEqual([...g.visible], [2], "只有回合 60–65 与窗口 50–90 相交");
  assert.deepEqual([...g.offLeft], [0], "回合 1–5 在窗口左侧外");
  assert.deepEqual([...g.offRight], [1, 3, 4], "回合 200+ 都在窗口右侧外");
}
assert.equal(geo.niceCeil(640_000), 800_000);
// 空闲缝隙标签不互相压字（真机反馈：114 回合的会话有 7 处长空闲，原先每处都画
// 完整文字，挨得近的几处叠成一团读不出来）。图标不抽稀，只有文字按间距取舍。
{
  const dense = [100, 122, 144, 166, 500, 522];
  const shown = geo.placeGapLabels(dense);
  assert.equal(shown.length, dense.length, "每个缝隙都有取舍结果，不抽稀");
  assert.deepEqual(shown, [true, false, false, true, true, false], "只有间距足够时才显示文字");
  const wide = [0, 200, 400];
  assert.deepEqual(geo.placeGapLabels(wide), [true, true, true], "间距充足时全部显示");
}
assert.equal(geo.niceCeil(1), 1);
assert.ok(geo.tickStep(3) * 3 >= 34, "刻度间隔至少 34px");
const mini = geo.miniColumns([{ input: 10, miss: 9 }, { input: 5, miss: 0 }], 1);
assert.deepEqual(JSON.parse(JSON.stringify(mini)), [{ x: 0, value: 10, warn: true }], "缩略图取列内最大值");
console.log("Session insights geometry: OK (windows contain focus, bands never dropped, slots in bounds)");

// ── 3. 文案 ──
// 文案随应用语言解析：测试固定中文（localStorage 偏好），英文另有下方断言。
const zhStorage = { getItem: () => "zh-Hans", setItem() {} };
const view = load("react/src/features/sessions/SessionInsights.tsx", { self: {}, localStorage: zhStorage });
const viewEn = load("react/src/features/sessions/SessionInsights.tsx", { self: {}, localStorage: { getItem: () => "en", setItem() {} } });
const unit = "回合";
const i18nSource = readFileSync(path.join(ui, "react/src/lib/i18n.ts"), "utf8");
for (const d of insights.diagnostics) {
  const t = view.diagText(d, unit);
  const text = `${t.title}${t.fact}${t.why}`;
  assert.doesNotMatch(text, /多付|可节省|浪费|省下|\$|¥/, `诊断文案不得暗示浪费或给金额：${text}`);
  if (d.cause === "unknown") assert.equal(t.chip[1], "原因未明");
  if (d.cause === "evidence") assert.equal(t.chip[1], "有错误摘要");
}
for (const d of pendingCopyChecks) {
  const t = view.diagText(d, unit);
  assert.doesNotMatch(`${t.title}${t.fact}${t.why}`, /多付|可节省|浪费|省下|\$|¥|NaN|undefined/, `真实诊断文案：${t.title}`);
}
const growth = view.diagText(insights.diagnostics.find(d => d.kind === "input_growth"), unit);
assert.match(growth.title, /增长 3\.2 倍/, "输入增长的标题是测得的事实");
assert.match(growth.why, /尚不能确定/, "原因单列并说明不确定");
const source = readFileSync(path.join(ui, "react/src/features/sessions/SessionInsights.tsx"), "utf8");
assert.ok(!source.includes("estimated_amount"), "诊断不读金额（r6 移除 estimated_amount）");
assert.ok(!source.includes("比全部命中多"), "不写「比全部命中多约 $X」");
assert.ok(source.includes("ins.localOnly") && i18nSource.includes("仅在本机显示，不进入导出和 MCP") && i18nSource.includes("never included in exports or MCP"), "摘录旁固定标注本机专属（中英）");
assert.ok(source.includes("f.invocation_key ?? `ts:"), "没有分组键的失败不得按工具名并成「相同调用」");
assert.equal(view.fmtTokens(1_832_000), "183 万");
assert.equal(viewEn.fmtTokens(1_832_000), "1.83M", "英文用 K/M/B，不出现「万」");
for (const d of insights.diagnostics) {
  const t = viewEn.diagText(d, "turn");
  assert.doesNotMatch(`${t.title}${t.fact}${t.why}${t.chip[1]}`, /[\u4e00-\u9fff]|NaN|undefined/, `英文诊断文案不得含中文：${t.title}`);
}
// WASTE S1（修订 spec §4.1）：失败区间成本暴露——只对这个明确标注的字段放开金额，
// 断言口径标签、降级与免责声明同屏可见；diagText 的金额禁令（上方 186/192）不变。
assert.ok(source.includes("ins.expInput") && i18nSource.includes("涉及回合输入"), "exposure block labels affected-turn input");
assert.ok(source.includes("ins.expEstimate") && i18nSource.includes("相关回合名义成本估算"), "exposure amount carries the nominal-estimate label");
assert.ok(source.includes("insights-disclaimer"), "exposure disclaimer rendered in-place");
assert.ok(source.includes("ins.noSnapshot") && source.includes("ins.noPriceCard") && i18nSource.includes("这段时间还没有价目快照") && i18nSource.includes("这些模型没有价卡"), "no-amount degradation reasons rendered");
assert.ok(source.includes("unpriced_tokens"), "unpriced tokens surfaced on partial coverage");
const bridgeSource = readFileSync(path.join(ui, "react/src/lib/sessionInsights.ts"), "utf8");
assert.ok(bridgeSource.includes("failure_exposure"), "bridge parses failure_exposure");
assert.ok(bridgeSource.includes("相关回合含正常工作；不是浪费、可节省额或实付账单"), "bridge pins the disclaimer constant");
const exposureDiag = real.diagnostics.find(d => d.kind === "repeated_failure"); // golden 路径（mock 不含 exposure）
assert.ok(exposureDiag && exposureDiag.failure_exposure, "golden repeated_failure carries failure_exposure through the bridge");
assert.ok(exposureDiag.failure_exposure.coverage === "full" && exposureDiag.failure_exposure.nominal_amounts.length > 0, "golden exercises the fully-priced path (Rust-computed values)");
const mockExposure = insights.diagnostics.find(d => d.kind === "repeated_failure");
assert.ok(mockExposure?.failure_exposure?.coverage === "partial" && mockExposure.failure_exposure.unpriced_tokens > 0, "mock exercises the partial+unpriced path");
assert.ok(!source.includes("estimated_amount"), "诊断不读金额（r6 移除 estimated_amount）——保持");
// i18n 后 fmtMoney 文案键化：金额断言改为键在场 + JPY 刻度护栏（不依赖运行语言）。
assert.ok(source.includes("sessionInsights.partialPrice") || source.includes("（部分调用无价卡"), "partial-coverage money label present (i18n key or zh fallback)");
assert.match(view.fmtMoney({ amounts: [{ amount_minor: 100, currency: "JPY" }], coverage: "complete" }), /JPY 100 minor units|最小单位/, "unknown currency scale must not be silently divided by 100");console.log("Session insights copy: OK (fact/cause split, no waste or money wording in diagnostics)");
