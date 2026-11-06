#!/usr/bin/env node
// React bridge contract test for Overview/Usage summary DTOs.
// It executes the same browser facade used by visual development and bundles
// the real TypeScript bridge, so this test exercises parser rejection rather
// than merely checking fixture JSON.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const overviewPage = readFileSync(path.join(ui, "react/src/features/overview/OverviewPage.tsx"), "utf8");
const decisionArea = readFileSync(path.join(ui, "react/src/features/overview/DecisionArea.tsx"), "utf8");
const appPage = readFileSync(path.join(ui, "react/src/app/App.tsx"), "utf8");
assert.doesNotMatch(overviewPage, /overview\.(today_spend|month_spend)/, "cost cards must use authority daily/monthly summaries, not legacy DSH overview fields");
assert.doesNotMatch(overviewPage, /className="hero-panel"|把运行状态变成可理解的证据/, "overview should lead with useful metrics instead of a decorative hero card");
assert.doesNotMatch(appPage, /Workbench React migration/i, "migration placeholder title must not appear in the product UI");

// R2（OVERVIEW_DRILLDOWN spec §4.3/§7.2）：内嵌发现条的契约——存在性、
// 两态诚实降级、「去看会话」路径只给可过滤执行环境且有会话证据的项（决策 #3）。
assert.match(overviewPage, /function OverviewFindingsStrip/, "overview must render the inline findings strip");
assert.match(overviewPage, /message\("overview\.findingsUnavailable"\)/, "findings strip must state unavailability honestly in the selected language");
assert.match(overviewPage, /message\("overview\.findingsEmpty"\)/, "findings strip must have an honest localized empty state");
assert.match(overviewPage, /item\.sessions_count > 0 && item\.harness !== "generic" && item\.harness !== "all"/, "evidence link only for filterable harnesses with session evidence");
assert.match(overviewPage, /readFindings\(null\)/, "strip reads the existing safe findings projection (no new payload path)");
assert.match(overviewPage, /sessionsDateHref|sessionsHarnessHref/, "drill-down links go through the whitelisted nav helper");

// OVERVIEW_TREND_RANGE_SPEC v2.0 §2/§3：三档趋势面板（取代 v1.1 的「只有今日 24 列」）——
// 存在性、共享组件、三档、深链、诚实降级与 r6（面板无金额）。
const trendChartSource = readFileSync(path.join(ui, "react/src/components/UsageTrendChart.tsx"), "utf8");
const trendBucketsSource = readFileSync(path.join(ui, "react/src/features/usage/trendBuckets.ts"), "utf8");
assert.match(overviewPage, /function TrendPanel/, "overview must render the trend panel");
assert.match(overviewPage, /<UsageTrendChart /, "overview renders the shared trend chart, not its own bars");
assert.doesNotMatch(overviewPage, /overview-trend-bar|overview-trend-col/, "no second hand-written bar renderer in the overview");
assert.match(overviewPage, /readUsageHourly\(today\)/, "day range reuses the usage page's hourly distribution command");
assert.match(overviewPage, /TREND_RANGES: TrendRange\[\] = \["day", "week", "month"\]/, "three ranges: day / week / month");
assert.match(overviewPage, /readUsageCalendar\(extraMonth\)/, "a week spanning two months reads the earlier month's calendar");
assert.match(overviewPage, /details\.failure_hours/, "day range marks failures from failure_hours");
assert.match(overviewPage, /details\.failure_days/, "week/month ranges mark failures from failure_days");
assert.match(overviewPage, /trend\.rangeTitle\./, "range heading is localized per range");
assert.match(overviewPage, /overview\.trendHourlyUnavailable/, "hourly fetch failure must degrade honestly");
assert.match(overviewPage, /overview\.trendEmpty/, "trend panel must have an honest empty state");
assert.match(overviewPage, /sessionsDateHref\(/, "bucket drill-downs go through the whitelisted nav helper");
assert.match(overviewPage, /try \{[^}]*localStorage/, "remembered range is wrapped in try/catch (storage can throw)");
assert.match(trendChartSource, /trend\.failureUnavailable/, "chart must state failure-marker unavailability honestly");
assert.match(trendChartSource, /bucket\.failures == null|failures == null/, "null failures is 'unavailable', never a fabricated zero");
assert.match(trendChartSource, /trend-bar-unavailable/, "unavailable buckets are hatched, not drawn as zero");
assert.doesNotMatch(readFileSync(path.join(ui, "react/src/styles.css"), "utf8").match(/\.trend-bar, \.trend-bar-empty \{[^}]*\}/)?.[0] ?? "", /max-width:\s*\d+px/, "no hard-coded px bar cap (it shrank the chart into the middle of the card)");
assert.match(trendBucketsSource, /Date\.UTC/, "calendar math is UTC-calendar only, never local-time Date");
assert.doesNotMatch(trendBucketsSource, /getDate\(\)|getDay\(\)|getMonth\(\)|new Date\(\)/, "no local-timezone Date accessors in bucket assembly");
const usagePageSource = readFileSync(path.join(ui, "react/src/features/usage/UsagePage.tsx"), "utf8");
const stylesSource = readFileSync(path.join(ui, "react/src/styles.css"), "utf8");
assert.match(usagePageSource, /<UsageTrendChart /, "usage page's hourly detail reuses the shared trend chart");
assert.doesNotMatch(usagePageSource, /usage-hour-grid|usage-hour-bar/, "usage page must not keep a second hand-written hourly bar renderer");
assert.doesNotMatch(stylesSource, /^\.usage-hour(-grid|-bar)?\b/m, "the duplicated usage-hour CSS is gone (single trend renderer)");
assert.match(stylesSource, /^\.overview-trend \{ display: block;/m, "regression: .info-panel is a flex row; without display:block on .overview-trend the heading and chart sit side by side and the chart collapses to ~244px (measured 2026-10-01)");
const overviewTrendCode = overviewPage.slice(overviewPage.indexOf("function TrendPanel"), overviewPage.indexOf("function OverviewFindingsStrip")) + trendChartSource + trendBucketsSource;
assert.doesNotMatch(overviewTrendCode, /formatMajorMoney|moneyDetail|cost/, "trend panel is token+failure only (r6: no amounts)");
const i18nSource = readFileSync(path.join(ui, "react/src/lib/i18n.ts"), "utf8");
for (const key of ["overview.trendEmpty", "overview.trendNote", "overview.trendHourlyUnavailable", "trend.rangeLabel", "trend.range.day", "trend.range.week", "trend.range.month", "trend.rangeTitle.day", "trend.rangeTitle.week", "trend.rangeTitle.month", "trend.failureLegend", "trend.failureUnavailable", "trend.noFailures", "trend.tokens", "trend.noUsage", "trend.future", "trend.unavailable", "trend.failuresInBucket", "trend.bucketAria", "trend.bucketAriaOpen", "trend.weekNote", "trend.monthNote"]) {
  assert.equal((i18nSource.match(new RegExp(`"${key}"`, "g")) ?? []).length, 2, `trend i18n key ${key} must exist in both languages`);
}
assert.doesNotMatch(appPage, /工作台预览/, "production navigation must not call itself a preview");
assert.match(appPage, /<h1 className="visually-hidden">\{pageName\(navigation\.find\(\(item\) => item\.id === page\)\)\}<\/h1>/, "compact overview still needs an accessible page heading");
assert.match(appPage, /item\?\.name \?\? message\(item\?\.label \?\? "nav\.overview", language\)/, "built-in headings must remain localized while plugins supply their own names");
const uiRequire = createRequire(path.join(ui, "package.json"));
const { buildSync } = uiRequire("esbuild");

function loadMock() {
  const sandbox = {
    console: { error() {}, warn() {}, log() {} },
    Intl, Date, Math, Promise, setTimeout, clearTimeout,
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(ui, "public/tauri-mock.js"), "utf8"), sandbox, { filename: "tauri-mock.js" });
  return sandbox.window.__TAURI__.core.invoke;
}

function loadBridge(invoke) {
  const built = buildSync({
    entryPoints: [path.join(ui, "react/src/lib/tauri.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    write: false,
    logLevel: "silent",
  });
  const sandbox = {
    module: { exports: {} }, exports: {}, require: uiRequire,
    console: { error() {}, warn() {}, log() {} },
    Intl, Date, Math, Promise, setTimeout, clearTimeout,
    window: { __TAURI__: { core: { invoke } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: "tauri-bridge.bundle.cjs" });
  return { bridge: sandbox.module.exports, window: sandbox.window };
}

function loadCacheHitMetric() {
  const built = buildSync({
    entryPoints: [path.join(ui, "react/src/features/overview/cacheHit.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    write: false,
    logLevel: "silent",
  });
  const sandbox = { module: { exports: {} }, exports: {}, require: uiRequire, Object };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: "overview-cache-hit.bundle.cjs" });
  return sandbox.module.exports.todayCacheHitRatio;
}

function loadSpendCards(language = "en") {
  const built = buildSync({
    entryPoints: [path.join(ui, "react/src/features/overview/spendCards.ts")],
    bundle: true, format: "cjs", platform: "node", target: "node20", write: false, logLevel: "silent",
  });
  const sandbox = { module: { exports: {} }, exports: {}, require: uiRequire, Date, Object, Intl, process, localStorage: { getItem: () => language } };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: "overview-spend-cards.bundle.cjs" });
  return sandbox.module.exports;
}

function currentWindow() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return { month: `${year}-${month}`, date: `${year}-${month}-${day}` };
}

function assertTokenPartition(summary) {
  for (const row of Object.values(summary.tokens_by_harness)) {
    assert.equal(row.total, row.uncached_input + row.cache_read + row.cache_write + row.output);
    assert.ok(row.cache_hit_ratio === null || (row.cache_hit_ratio >= 0 && row.cache_hit_ratio <= 1));
  }
}

function assertMoneyPartition(summary) {
  const aggregate = {};
  for (const amounts of Object.values(summary.spend_by_basis)) {
    for (const [currency, amount] of Object.entries(amounts)) aggregate[currency] = (aggregate[currency] ?? 0) + amount;
  }
  const currencies = new Set([...Object.keys(summary.actual_spend), ...Object.keys(aggregate)]);
  for (const currency of currencies) {
    const total = summary.actual_spend[currency] ?? 0;
    const sum = aggregate[currency] ?? 0;
    const tolerance = Math.max(1e-9, Math.max(Math.abs(total), Math.abs(sum)) * 1e-12);
    assert.ok(Math.abs(total - sum) <= tolerance, currency);
  }
}

const fixtureInvoke = loadMock();
const loaded = loadBridge(fixtureInvoke);
const { bridge, window } = loaded;
const { month, date } = currentWindow();

const monthly = await bridge.readUsageSourceSummary(month);
const daily = await bridge.readDailySummary(date);
const calendar = await bridge.readUsageCalendar(month);
assert.equal(monthly.month, month);
assert.equal(daily.date, date);
assert.equal(calendar.month, month);
const detailsSnapshot = await bridge.readOverviewDetails();
assert.equal(detailsSnapshot.month, month);
assert.equal(detailsSnapshot.date, date);
assert.equal(detailsSnapshot.authority_revision, 42);
assert.equal(detailsSnapshot.is_consistent, true);
assert.equal(detailsSnapshot.errors.length, 0);
// failure_hours：mock 给 09 时 3 条失败 → 正整数解析（§4）。
assert.equal(detailsSnapshot.failure_hours["9"], 3);
assert.equal(detailsSnapshot.failure_hours["14"], 1);
assert.ok(Object.keys(detailsSnapshot.failure_hours).every((hour) => /^(?:[0-9]|1[0-9]|2[0-3])$/.test(hour)), "failure_hours keys are 0-23");
assertTokenPartition(monthly);
assertTokenPartition(daily);
assertMoneyPartition(monthly);
assertMoneyPartition(daily);
const todayCacheHitRatio = loadCacheHitMetric();
const expectedInput = Object.values(daily.tokens_by_harness).reduce((sum, harness) => sum + harness.uncached_input + harness.cache_read + harness.cache_write, 0);
const expectedRead = Object.values(daily.tokens_by_harness).reduce((sum, harness) => sum + harness.cache_read, 0);
assert.equal(todayCacheHitRatio(daily), expectedInput > 0 ? expectedRead / expectedInput : null);
assert.equal(todayCacheHitRatio({ ...daily, tokens_by_harness: { a: { total: 110, uncached_input: 10, cache_read: 90, cache_write: 0, output: 10 }, b: { total: 1010, uncached_input: 900, cache_read: 100, cache_write: 0, output: 10 } } }), 190 / 1100);
assert.equal(todayCacheHitRatio({ ...daily, tokens_by_harness: { a: { total: 10, uncached_input: 0, cache_read: 0, cache_write: 0, output: 10 } } }), null);
assert.equal(todayCacheHitRatio({ ...daily, freshness: "unavailable" }), null);
const { todaySpendCard, monthSpendCard } = loadSpendCards();
const pricedMonth = { ...monthly, month: "2026-09", freshness: "fresh", actual_spend: { CNY: 182.55, USD: 40 }, spend_by_basis: { fixed_subscription: { CNY: 162, USD: 40 }, harness_billed: { CNY: 20.55 } }, metered_view: { CNY: { amount: 100, actual: 20.55, declared_estimate: 79.45, default_estimate: 0, label: "mixed" } } };
const pricedDay = { ...daily, date: "2026-09-24", freshness: "fresh", actual_spend: {}, metered_view: { CNY: { amount: 80, actual: 0, declared_estimate: 80, default_estimate: 0, label: "estimate" } } };
assert.match(monthSpendCard(pricedMonth).value, /CNY\s*182\.55/);
assert.match(monthSpendCard(pricedMonth).detail, /USD\s*40\.00/);
assert.match(todaySpendCard(pricedDay, pricedMonth).value, /CNY\s*5\.40/);
assert.match(todaySpendCard(pricedDay, pricedMonth).detail, /USD\s*1\.33/);
assert.match(todaySpendCard(pricedDay, pricedMonth).detail, /not a charge made today/);
assert.match(todaySpendCard(pricedDay, pricedMonth).detail, /Metered estimates are not included/);
assert.equal(todaySpendCard(pricedDay, { ...pricedMonth, month: "2026-08" }).value, "—", "wrong month must not allocate subscriptions");
assert.equal(todaySpendCard({ ...pricedDay, freshness: "unavailable" }, pricedMonth).value, "—", "unavailable daily summary must not fabricate a daily amount");
assert.match(todaySpendCard({ ...pricedDay, actual_spend: { CNY: 2 } }, pricedMonth).value, /CNY\s*7\.40/, "known daily metered charges add to the subscription allocation");
const chineseSpendCard = loadSpendCards("zh-Hans").monthSpendCard(pricedMonth);
assert.equal(chineseSpendCard.value, monthSpendCard(pricedMonth).value, "language changes text, not monetary facts");
assert.match(chineseSpendCard.detail, /已记录费用与已声明订阅/);
// 验收发现的阻断缺陷：OverviewPage 首屏 overview 为 null 时提前返回，hook 写在 return 之后会让
// 前后两次渲染的 hook 数量不同，React 报错、整页空白。守卫：该函数里提前返回之后不得再调用任何 hook。
{
  const src = readFileSync(path.join(ui, "react/src/features/overview/OverviewPage.tsx"), "utf8");
  const start = src.indexOf("export function OverviewPage(");
  const earlyReturn = src.indexOf("if (!overview) return", start);
  assert.ok(start >= 0 && earlyReturn > start, "OverviewPage early return not found");
  const afterReturn = src.slice(earlyReturn + 1);
  const lateHooks = afterReturn.match(/\buse[A-Z][A-Za-z]*\(/g) ?? [];
  assert.deepEqual(lateHooks, [], `hooks called after the early return in OverviewPage: ${lateHooks.join(", ")}`);
}
// 汇率 V2：折算只在「每个币种都折得了」时才改主值；原币种明细永远保留；出处写进说明。
const { applyConversion } = loadSpendCards();
const fxBase = monthSpendCard(pricedMonth);
assert.deepEqual(JSON.parse(JSON.stringify(fxBase.amounts)), { CNY: 182.55, USD: 40 }, "card exposes the per-currency amounts it was built from");
const fxItem = (currency, amount, converted, source, date) => ({ currency, amount, converted, rate: converted / amount, rate_source: source, rate_date: date });
const fxResult = { target: "USD", total: 67.2, approximate: true, items: [fxItem("CNY", 182.55, 27.2, "bundled_snapshot", "2026-09-30"), fxItem("USD", 40, 40, "identity", null)], unavailable: [] };
const fxShown = applyConversion(fxBase, fxResult);
assert.match(fxShown.value, /^≈ USD\s*67\.20$/, "converted headline carries ≈ and the reporting currency");
assert.match(fxShown.detail, /CNY\s*182\.55/, "original CNY amount stays visible");
assert.match(fxShown.detail, /USD\s*40\.00/, "original USD amount stays visible");
assert.match(fxShown.detail, /reference rates \(ECB, 2026-09-30\)/, "the rate source and date are disclosed");
assert.equal(applyConversion(fxBase, null), fxBase, "no conversion available → unchanged");
assert.equal(applyConversion(fxBase, { ...fxResult, unavailable: [{ currency: "XXX", amount: 1 }] }), fxBase, "any unconvertible currency → no half-converted headline");
assert.equal(applyConversion(fxBase, { ...fxResult, items: [fxItem("CNY", 182.55, 182.55, "identity", null)], total: 182.55 }), fxBase, "already in the reporting currency → unchanged");
assert.match(applyConversion(fxBase, { ...fxResult, items: [fxItem("CNY", 182.55, 27.2, "user_assumption", null), fxItem("USD", 40, 40, "identity", null)] }).detail, /your manual rate/, "manual rates are labelled as the user's assumption");
// 验收发现的缺陷：折算结果必须与卡片当前的金额一一对应，否则不折算。
const stale = { ...fxResult, items: [fxItem("CNY", 100, 14.9, "bundled_snapshot", "2026-09-30"), fxItem("USD", 40, 40, "identity", null)] };
assert.equal(applyConversion(fxBase, stale), fxBase, "a stale result for different CNY amounts must not be paired with the card's current amounts");
assert.equal(applyConversion(fxBase, { ...fxResult, items: [fxResult.items[0]] }), fxBase, "an item set missing a currency (no 'unavailable' entry) is not a full conversion");
assert.equal(applyConversion(fxBase, { ...fxResult, items: [...fxResult.items, fxItem("EUR", 1, 1.1, "bundled_snapshot", "2026-09-30")] }), fxBase, "extra currencies the card does not have are not accepted");
assert.equal(applyConversion(fxBase, { ...fxResult, items: [fxItem("CNY", 182.55, NaN, "bundled_snapshot", "2026-09-30"), fxResult.items[1]] }), fxBase, "NaN item values are never rendered");
assert.equal(applyConversion(fxBase, { ...fxResult, total: -3 }), fxBase, "a negative total is never rendered");
// 第二轮验收：重复币种 / 原型属性名
assert.equal(applyConversion(fxBase, { ...fxResult, items: [fxItem("CNY", 182.55, 27.2, "bundled_snapshot", "2026-09-30"), fxItem("CNY", 182.55, 27.2, "bundled_snapshot", "2026-09-30")] }), fxBase, "duplicate currencies must not stand in for a missing one");
const protoCard = { ...fxBase, amounts: { EUR: 1 } };
assert.equal(applyConversion(protoCard, { ...fxResult, items: [fxItem("constructor", 1, 0.1, "bundled_snapshot", "2026-09-30")], total: 0.1 }), protoCard, "an item named like an Object.prototype member is not a currency the card has");
assert.equal(applyConversion(fxBase, { ...fxResult, items: [fxItem("CNY", 182.55, 27.2, "bundled_snapshot", "2026-09-30"), fxItem("USD", 40, 40, "identity", null)], total: Infinity }), fxBase, "an infinite total is never rendered");
for (const day of calendar.days) assert.equal(day.total_tokens, day.dsh_tokens + day.claude_tokens + day.codex_tokens);

const originalInvoke = fixtureInvoke;
const withOverride = (override) => { window.__TAURI__.core.invoke = override; };
const restore = () => { window.__TAURI__.core.invoke = originalInvoke; };

let value;
withOverride(async (command, args) => {
  value = await originalInvoke(command, args);
  if (command === "data_monthly_summary") {
    value = structuredClone(value);
    value.actual_spend_by_basis.metered_actual.CNY = "not-a-number";
  }
  return value;
});
await assert.rejects(() => bridge.readUsageSourceSummary(month), /金额不安全/);
restore();

withOverride(async (command, args) => {
  value = await originalInvoke(command, args);
  if (command === "data_monthly_summary") {
    value = structuredClone(value);
    value.total_actual_spend.CNY += 1;
  }
  return value;
});
await assert.rejects(() => bridge.readUsageSourceSummary(month), /basis 不守恒/);
restore();

withOverride(async (command, args) => {
  value = await originalInvoke(command, args);
  if (command === "data_daily_summary") {
    value = structuredClone(value);
    delete value.tokens_by_harness.codex.output;
  }
  return value;
});
await assert.rejects(() => bridge.readDailySummary(date), /字段|数值|token/);
restore();

withOverride(async (command, args) => {
  value = await originalInvoke(command, args);
  if (command === "data_monthly_summary") {
    value = structuredClone(value);
    value.tokens_by_harness.codex.cache_hit_ratio = 2;
  }
  return value;
});
await assert.rejects(() => bridge.readUsageSourceSummary(month), /cache hit ratio/);
restore();

withOverride(async (command, args) => {
  value = await originalInvoke(command, args);
  if (command === "data_monthly_summary") {
    value = structuredClone(value);
    value.coverage.measured_fields = value.coverage.total_fields + 1;
  }
  return value;
});
await assert.rejects(() => bridge.readUsageSourceSummary(month), /coverage/);
restore();

withOverride(async (command, args) => {
  value = await originalInvoke(command, args);
  if (command === "data_monthly_summary") {
    value = structuredClone(value);
    value.month = "1900-01";
  }
  return value;
});
await assert.rejects(() => bridge.readUsageSourceSummary(month), /错误月份|月份/);
restore();

withOverride(async (command, args) => {
  const result = await originalInvoke(command, args);
  if (command !== "read_overview_details_snapshot") return result;
  return { ...result, is_consistent: false, errors: ["revision changed during query"] };
});
const inconsistent = await bridge.readOverviewDetails();
assert.equal(inconsistent.is_consistent, false);
assert.equal(inconsistent.authority_revision, 42);
assert.match(inconsistent.errors[0], /This local operation is unavailable/, "an English locale must not leak the Chinese fallback");
restore();

withOverride(async (command, args) => {
  const result = await originalInvoke(command, args);
  return command === "read_overview_details_snapshot" ? { ...result, month: "1900-01" } : result;
});
await assert.rejects(() => bridge.readOverviewDetails(), /窗口与请求不一致/);
restore();

withOverride(async (command, args) => {
  const result = await originalInvoke(command, args);
  if (command !== "read_overview_details_snapshot") return result;
  return { ...result, failure_hours: { date: "bad", hours: { "24": 1, "9": -2 } } };
});
const trendDegraded = await bridge.readOverviewDetails();
assert.equal(trendDegraded.failure_hours, null, "malformed failure_hours (hour 24 / negative) must degrade to null without killing the token panels");
assert.equal(trendDegraded.calendar.month, month, "token/calendar panels survive failure_hours degradation");
restore();

withOverride(async (command, args) => {
  const result = await originalInvoke(command, args);
  if (command !== "read_overview_details_snapshot") return result;
  return { ...result, failure_hours: { date: date, hours: { "9": 1.5 } } };
});
const trendFractional = await bridge.readOverviewDetails();
assert.equal(trendFractional.failure_hours, null, "non-integer failure counts must degrade to null (contract produces integers only)");
restore();

withOverride(async (command, args) => {
  const result = await originalInvoke(command, args);
  if (command !== "read_overview_details_snapshot") return result;
  return { ...result, failure_hours: { date: "1999-01-01", hours: { "9": 1 } } };
});
const trendWrongDate = await bridge.readOverviewDetails();
assert.equal(trendWrongDate.failure_hours, null, "failure_hours for a different day must degrade to null, never mark the wrong day's chart");
restore();

withOverride(async (command, args) => {
  const result = await originalInvoke(command, args);
  if (command !== "read_overview_details_snapshot") return result;
  return { ...result, failure_hours: null };
});
const trendNullBackend = await bridge.readOverviewDetails();
assert.equal(trendNullBackend.failure_hours, null, "backend null (library unavailable) passes through as null");
restore();

withOverride(async (command, args) => {
  const result = await originalInvoke(command, args);
  if (command !== "read_overview_details_snapshot") return result;
  return { ...result, failure_days: { from: "2026-01-01", to: date, days: { "2026-09-15": 3, [date]: 1 } } };
});
const failureDaysOk = await bridge.readOverviewDetails();
assert.deepEqual({ ...failureDaysOk.failure_days }, { "2026-09-15": 3, [date]: 1 }, "well-formed failure_days passes through");
restore();

for (const [label, bad] of [
  ["malformed day key", { from: "x", to: date, days: { "2026-9-1": 1 } }],
  ["zero count", { from: "x", to: date, days: { [date]: 0 } }],
  ["fractional count", { from: "x", to: date, days: { [date]: 1.5 } }],
  ["wrong window end", { from: "x", to: "1999-01-01", days: { "1999-01-01": 1 } }],
  ["array days", { from: "x", to: date, days: [] }],
]) {
  withOverride(async (command, args) => {
    const result = await originalInvoke(command, args);
    if (command !== "read_overview_details_snapshot") return result;
    return { ...result, failure_days: bad };
  });
  const degraded = await bridge.readOverviewDetails();
  assert.equal(degraded.failure_days, null, `${label}: failure_days must degrade to null (never a fabricated zero), token panels survive`);
  assert.equal(degraded.calendar.month, month, `${label}: calendar survives failure_days degradation`);
  restore();
}

withOverride(async (command, args) => {
  const result = await originalInvoke(command, args);
  if (command !== "read_overview_details_snapshot") return result;
  return { ...result, failure_days: null };
});
assert.equal((await bridge.readOverviewDetails()).failure_days, null, "backend null failure_days passes through as null");
restore();

console.log("React Overview/Usage contract: OK (revision-consistent snapshot, mock DTOs, malformed rejection, honest degradation)");

// 决策区（DECISION_AREA_REACT_PORT spec R4）：移植组件的存在性、措辞闭集与诚实红线。
assert.match(decisionArea, /值回月费/, "payback chip wording present");
assert.match(decisionArea, /没用够（只值回月费的/, "underused warning wording present");
assert.match(decisionArea, /数字异常/, "anomaly guard wording present");
assert.match(decisionArea, /读不到套餐额度/, "codex unreadable fallback present");
assert.match(decisionArea, /尚未设置套餐或账单/, "unset-fee empty state present");
assert.match(decisionArea, /api_equivalent/, "dual track reads the nominal API equivalent basis");
assert.match(decisionArea, /名义 API 等价（参考）/, "nominal equivalent labeled as reference");
assert.match(decisionArea, /非付款验证/, "declared-fee caveat present");
// 剥注释（块+行）：红线针对代码与文案本身，不针对讨论红线的注释。
const decisionAreaCode = decisionArea.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((line) => line.split("//")[0]).join("\n");
assert.doesNotMatch(decisionAreaCode, /可节省|省下|亏了/, "no savings/loss claims in decision area");
assert.doesNotMatch(decisionAreaCode, /(claude|Claude)[\s\S]{0,120}used_percent/, "claude branch must never touch used_percent (§8.3.2 never-a-percentage)");
assert.match(decisionArea, /永无「剩余 N%」|永无百分比|永不显示百分比/, "never-a-percentage red line documented in source");
assert.match(decisionArea, /Date\.now\(\) - observed <= 24 \* 60 \* 60 \* 1000/, "codex 24h staleness guard ported");
assert.match(overviewPage, /<DecisionArea monthly=/, "overview mounts the decision area");
assert.match(decisionArea, /窗口状态未知（近期无撞窗记录）/, "claude no-snapshot state shown honestly, not as unreadable");
assert.match(decisionArea, /claudeNoSnapshot/, "no-snapshot wording key present");
assert.match(decisionArea, /snapshotAt/, "snapshot timestamp surfaced");
assert.match(decisionArea, /href="#settings-billing"/, "unset-fee guidance targets the billing anchor");
assert.match(decisionArea, /paybackRows/, "provider+currency merge implemented (groupByProvider semantics)");
assert.match(decisionArea, /groupByProvider 语义|provider\+currency 合并/, "merge semantics documented");

// 负向自测（spec §7.3）：--self-test 时对内存副本注入两类违规，断言必须各自变红。
if (process.argv.includes("--self-test")) {
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "");
  const mutations = [
    ["banned savings wording", (src) => src.replace('<b className="danger">', '<b data-x="可节省" className="danger">', 1), /可节省|省下|亏了/],
    ["claude branch touches used_percent", (src) => src.replace("function QuotaWindowCard() {", "const claudeBadUsedPercent = codex ? codex.used_percent : null;\nfunction QuotaWindowCard() {", 1), /(claude|Claude)[\s\S]{0,120}used_percent/],
  ];
  for (const [name, mutate, probe] of mutations) {
    const mutated = stripComments(mutate(decisionArea));
    if (!probe.test(mutated)) { console.error(`self-test FAILED: injection '${name}' did not trip the tripwire`); process.exit(1); }
  }
  console.log("decision-area negative self-tests: OK (both injections trip)");
}
