#!/usr/bin/env node
// 断言总览 KPI 行 / 双轨账 / 决策卡渲染器（src-tauri/ui/workbench.js，v0.9
// Stage D）的可测纯部分——与 scripts/verify-workbench-fold-bridge.mjs 同一
// 模式：node + vm 执行**真实文件**，不是照抄一份逻辑去测。
//
// 断言的诚实性规则（每条背后都是本会话实测过的坑）：
// 1. 无数据渲染「无数据」，绝不渲染 0（spec §0.1；DSH 0-token 月事故同款）。
// 2. 名义成本排除 fixed_subscription（月费不是标价折算——混进名义就重复计钱）。
// 3. 订阅利用率 >50× → 「归属待核」告警而非「值 N 倍」（anthropic 380× 实测：
//    倍数异常是声明错误的自检信号）。
// 4. cache_write 档位假设必须出现在名义副行（1hr/5min 差 5.2%，假设不是观测）。
// 5. 决策卡：Claude Pro 恒「窗口余量不可得」（quotaLimits 只有拒绝快照，不得
//    反推假百分比）；Codex <15% 提示确认可用线路，不指名推荐。

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log("  ok  " + msg);
  else { failed++; console.error("FAIL  " + msg); }
};

const wb = readFileSync(`${root}/apps/desktop/src-tauri/ui/workbench.js`, "utf8");
const html = readFileSync(`${root}/apps/desktop/src-tauri/ui/workbench.html`, "utf8");

// 静态断言：关键诚实性文案在真实文件里
console.log("# 静态断言（真实文件内容）");
ok(wb.includes("cache_write 按 1hr 计"), "名义副行带 cache_write 档位假设标注");
ok(wb.includes("请核对套餐"), ">50× 的「数字异常，请核对套餐」告警文案存在（归属待核的人话版）");
// （审查 #9：此处原是恒真断言 `X===false || X`，给假绿——名义排除订阅月费的
// 行为已由下方 renderKpiRow 的 $1180 断言真实覆盖，恒真行删除。）

// 预算卡：后端 Phase 4.3 起返回 source:"sql"（SQL 权威库实时算），前端此前只
// 认 "alert" → 一直落进「等预算数据」兜底（screenshot 事故）。现两态都是权威。
ok(wb.includes('b.source !== "alert" && b.source !== "sql"'),
  "预算卡兜底判定同时排除 alert 与 sql（sql 是权威不是缺场）");
ok(wb.includes("budgetLive"), "source:\"sql\" 走「实时算」新鲜度文案，不说「尚未产出」");
// 预算口径 = 订阅月费按天摊派 + 跨执行环境按量费用（2026-09-17 产品定向，取代 09-07 的
// 「按量实付」单口径）。截图事故：后端 total_spent_minor 早已含订阅摊派，标题却还叫
// 「预算（按量费用）」、tooltip 写「不含订阅月费」，用户把 ¥1458.5 读成纯按量。
ok(html.includes("预算（订阅 + 按量）") && !html.includes("预算（按量费用）") && !html.includes("不含订阅月费")
  && !html.includes("订阅月费不计入") && !html.includes("仅 DSH 实测"),
  "预算卡与设置页标注「订阅 + 按量」口径，不再写按量-only 或「仅 DSH 实测」");
ok(wb.includes('"已超预算 " + fmtMoney(Math.max(0, (b.month_cost) - denom)) + breakdown + tail'),
  "超支态副行带订阅摊派 + 按量拆分（不只 ok 态）");
// cc-switch 时间线（config-time-bound，2026-09-17）：判定器把「这批用量之后才建立的中转」
// 剔除并标 `config.timeline.*` 依据，行面必须能把它翻译成人话，并把 partial 的切点
// （facts_before / tokens_before）说出来——否则用户看不到"443 条早于胜算云建立"就点了确认。
for (const key of ["config.timeline", "config.timeline.excluded", "config.timeline.partial"]) {
  ok(wb.includes('"' + key + '":'), "basisText 认识 " + key);
}
ok(wb.includes("const timelineText = (verdict) =>") && wb.includes("tokens_before") && wb.includes("已排除"),
  "确认列表逐条渲染 excluded / partial 的时间线说明（含切点 tokens_before）");
// 组件自设 display 后必须补 [hidden] 规则，否则压过 UA 的 display:none（label[hidden]
// 事故的重演：2026-09-15 .btn 加 inline-flex 后「加载更多」「截图」「立即同步」全部
// 在 hidden 态下显形）。
{
  const css = readFileSync(`${root}/apps/desktop/src-tauri/ui/workbench.css`, "utf8");
  for (const sel of [".btn[hidden]", ".chip[hidden]", ".sev[hidden]", ".form-row label[hidden]"]) {
    ok(css.includes(sel), `CSS 保留 ${sel} { display:none } 守卫`);
  }
  ok(/\.chip,\s*\n\.sev,\s*\n\.tag,\s*\n\.unresolved-tag \{/.test(css), "chip / sev / tag / unresolved-tag 共用一个基类（标签规范）");
  ok(css.includes(".btn.primary {") && html.includes('class="btn primary" id="ov-billing-review"'),
    "主按钮是 .btn.primary 显式类，不再靠 .notice.todo 作用域选择器");
  ok(!/#(fff4cc|fde6ec|e8ecf3|ece6f5|d7a5e8)\b/.test(css), "标签不再硬编码浅色 hex（走 --tone + color-mix）");
}
ok(html.includes("保存脱敏诊断包") && html.includes("不会自动上传"),
  "帮助区提供用户主动保存的脱敏诊断包且明确不自动上传");
ok(wb.includes('invoke("export_diagnostic_package")'),
  "脱敏诊断包由后端命令生成，不在前端拼接或上传");
ok(wb.includes('args.harness_kind = sessFilter') && !wb.includes('args.harnessKind = sessFilter'),
  "会话执行环境筛选透传 snake_case 参数，避免静默退回全执行环境");
ok(wb.includes('document.getElementById("sess-model")') && wb.includes('args.model = modelVal'),
  "会话模型筛选透传到权威查询，避免只做前端假筛选");
ok(wb.includes('document.getElementById("sess-provider")') && wb.includes('args.provider = providerVal'),
  "会话 provider 筛选透传到权威查询，避免只做前端假筛选");
ok(wb.includes('args.date_from = shiftStatisticsDate(-6)') && wb.includes('args.date_to = statisticsToday()'),
  "会话最近 7 天窗口使用统一北京日期范围");
ok(wb.includes('args.date_from = from') && wb.includes('args.date_to = to'),
  "会话自定义日期范围透传到权威查询");
ok(wb.includes('s.cost_status && s.cost_status.state === sessStatusFilter'),
  "会话计费状态筛选只使用权威 cost_status.state，不以金额空值猜测");
ok(wb.includes('"no-price-card": "没有匹配的原厂价格卡"'),
  "完全无价卡状态翻译为明确的原厂价格卡缺失");
ok(wb.includes('"no-pricing-snapshot": "历史缺少事件时间的价格快照"'),
  "历史缺价状态明确说明没有事件时间价格快照");
ok(wb.includes('pricing || reason || row.has_unresolved'),
  "无价卡且没有金额时仍显示价格不可用说明，不隐藏失败态");
ok(wb.includes('openSettings.textContent = "打开预算设置"') && wb.includes('openSettingsSection("settings-budget", "ov-budget-monthly-amount")'),
  "预算阈值组提供打开预算设置入口（跳设置页预算分区，不是总览）");
ok(wb.includes('action.textContent = "明确计费方式"') && wb.includes('"查看数据源"') && wb.includes('"查看会话"'),
  "来源投影组提供对应处理入口，不把来源证据误报为无原始命中");

// ── vm 执行真实文件 ──
function makeElement() {
  const classes = new Set();
  const children = [];
  return { textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {}, children,
    append(...nodes) { children.push(...nodes); },
    className: "", title: "", appendChild(node) { children.push(node); }, setAttribute() {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => (force === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : force ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
      // classList 有 for..of 迭代器，workbench.js 用 [...el.classList] 遍历。
      [Symbol.iterator]: function* () { for (const c of classes) yield c; },
    },
  };
}
const elements = {};
const el = (id) => (elements[id] ??= makeElement());
const sessionStorage = new Map();
sessionStorage.getItem = (key) => sessionStorage.get(key) ?? null;
sessionStorage.setItem = (key, value) => sessionStorage.set(key, String(value));
const priceCardCalls = [];
const sandbox = {
  sessionStorage,
  window: {
    __TAURI__: {
      core: { invoke: async (cmd, args) => {
        if (cmd === "data_codex_quota") return sandbox.__quota;
        if (cmd === "read_overview") return sandbox.__overview;
        if (cmd === "data_status") return { status: "unavailable", reason: "fixture" };
        if (cmd === "price_cards") return { cards: {} };
        if (cmd === "save_price_card") { priceCardCalls.push(args); return { status: "saved" }; }
        if (cmd === "trigger_sync") return null;
        return null;
      } },
      event: { listen: async () => () => {} },
    },
    addEventListener: () => {},
  },
  document: {
    addEventListener: () => {},
    createElement: () => makeElement(),
    createTextNode: (text) => ({ textContent: String(text) }),
    getElementById: (id) => el(id),
  },
};
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);
vm.runInContext(wb, sandbox);
sandbox.__quota = null;

console.log("# 双预算状态文案");
ok(typeof sandbox.budgetProfileStatusText === "function",
  "真实 workbench.js 暴露双预算状态文案纯函数");
ok(sandbox.budgetProfileStatusText({
  level: "no_data", spent_minor: 0, currency: "CNY",
}) === "本月：无数据",
  "no_data 不渲染为已用 0");
// spent_minor 是分：120 分 = $1.20 / ¥1.20。旧断言钉住的是「已用 120 CNY」——
// 把分当元显示（设置页 864 CNY vs 总览 ¥8.64，2026-09-15 巡检）。
ok(sandbox.budgetProfileStatusText({
  level: "incomplete", spent_minor: 120, currency: "USD",
  daily_level: "no_data", daily_spent_minor: 0,
}) === "本月：部分覆盖 · 至少已用 $1.20，仍有未覆盖用量；今日：无数据",
  "incomplete 显示已知下界并保留未覆盖说明（分→元）");
ok(sandbox.budgetProfileStatusText({
  level: "ok", spent_minor: 864, currency: "CNY", daily_level: "disabled",
}) === "本月：正常 · 已用 ¥8.64",
  "正常状态显示权威已用金额，spent_minor 经 fmtCur 换算为元");
ok(sandbox.budgetProfileStatusText({
  level: "ok", spent_minor: 864, currency: "CNY", daily_level: "ok", daily_spent_minor: 321,
}) === "本月：正常 · 已用 ¥8.64；今日：正常 · 已用 ¥3.21",
  "日预算行同样按分换算");
// 有订阅摊派时读 total_spent_minor（与总览卡/托盘同口径）并给拆分——形状出处：
// crates/agent-vitals-runtime/src/budget.rs::budget_profiles_status_sql_at 的 json! 行。
ok(sandbox.budgetProfileStatusText({
  level: "exceeded", currency: "CNY", spent_minor: 120460, metered_spent_minor: 120460,
  subscription_amortized_minor: 25386, total_spent_minor: 145846,
  daily_level: "ok", daily_spent_minor: 0, daily_subscription_minor: 1493, daily_total_minor: 1493,
}) === "本月：已超预算 · 已用 ¥1458.46（订阅摊派 ¥253.86 + 按量 ¥1204.60）；今日：正常 · 已用 ¥14.93",
  "设置页已用 = 订阅摊派 + 按量（total_spent_minor），并列出拆分；今日同样读 daily_total_minor");
ok(typeof sandbox.adaptEstimateProfileToBudget === "function", "暴露 estimate profile 适配器");
{
  const b = sandbox.adaptEstimateProfileToBudget({
    level: "exceeded", currency: "CNY", monthly_minor: 50000, ratio_bp: 29169,
    spent_minor: 120460, metered_spent_minor: 120460, subscription_minor: 44800,
    subscription_amortized_minor: 25386, subscription_days_elapsed: 17, days_in_month: 30,
    subscription_fx_applied: true, total_spent_minor: 145846,
  }, null);
  ok(b && b.level === "over" && Math.abs(b.month_cost - 1458.46) < 1e-9,
    "总览卡 month_cost = 订阅摊派 + 按量");
  ok(b && b.month_cost_breakdown === "订阅摊派 ≈¥253.9 + 按量 ≈¥1204.6",
    "总览卡副行拆分：订阅摊派（异币标 ≈）+ 按量");
  ok(b && Array.isArray(b.reasons) && b.reasons[0].includes("按已过 17/30 天摊派"),
    "摊派规则进 tooltip（reasons）而非副行");
}
console.log("# 跨执行环境面板金额分币（harnessAmountsByCurrency）");
{
  // 形状出处：tauri-mock.js data_monthly_summary 的 by_harness / by_provider
  // （domain data_contract.rs HarnessAmount::currency：by_harness 混币条目 currency=None）。
  const byProvider = {
    "claude-code/anthropic": { currency: "USD", amounts_by_basis: { fixed_subscription: 20 } },
    "claude-code/minimax": { currency: "CNY", amounts_by_basis: { fixed_subscription: 49, api_equivalent: 56.2 } },
    "codex/openai": { currency: "USD", amounts_by_basis: { api_equivalent: 14.82 } },
  };
  const claude = sandbox.harnessAmountsByCurrency("claude-code",
    { amounts_by_basis: { fixed_subscription: 69, api_equivalent: 56.2 } }, byProvider);
  ok(JSON.stringify(claude) === JSON.stringify([
    { basis: "fixed_subscription", currency: "USD", amount: 20 },
    { basis: "fixed_subscription", currency: "CNY", amount: 49 },
    { basis: "api_equivalent", currency: "CNY", amount: 56.2 },
  ]), "混币执行环境按 (basis, currency) 分开，绝不出现 $20+¥49=69（got " + JSON.stringify(claude) + "）");
  const codex = sandbox.harnessAmountsByCurrency("codex", { amounts_by_basis: { api_equivalent: 14.82 } }, byProvider);
  ok(JSON.stringify(codex) === JSON.stringify([{ basis: "api_equivalent", currency: "USD", amount: 14.82 }]),
    "单币执行环境带上币种（此前渲染裸 14.82 无 $）");
  const legacyMixed = sandbox.harnessAmountsByCurrency("claude-code", { amounts_by_basis: { fixed_subscription: 69 } }, {});
  ok(legacyMixed.length === 1 && legacyMixed[0].currency === "__mixed__",
    "无 by_provider 且 by_harness 未声明币种 → 标记为未声明，不给数字");
  const legacySingle = sandbox.harnessAmountsByCurrency("dsh", { currency: "CNY", amounts_by_basis: { metered_actual: 8.64 } }, {});
  ok(JSON.stringify(legacySingle) === JSON.stringify([{ basis: "metered_actual", currency: "CNY", amount: 8.64 }]),
    "无 by_provider 但 by_harness 声明了单币 → 照用");
}
ok(JSON.stringify(sandbox.issueActionsForStatus("later")) === JSON.stringify([
  ["open", "恢复待处理"], ["acknowledged", "已确认"], ["resolved", "已解决"], ["not_applicable", "不适用"],
]), "稍后状态仍可直接推进到确认/解决/不适用");
ok(JSON.stringify(sandbox.issueActionsForStatus("acknowledged")) === JSON.stringify([
  ["open", "恢复待处理"], ["later", "稍后"], ["resolved", "已解决"], ["not_applicable", "不适用"],
]), "已确认状态仍可直接推进到稍后/解决/不适用");
ok(sandbox.issueStatusCanonical("closed") === "resolved" &&
  sandbox.issueStatusCanonical("wontfix") === "not_applicable" &&
  sandbox.issueStatusLabel("closed") === "已解决",
  "旧状态别名在界面统一显示为规范中文五态");

const num = (id) => elements[id]?.textContent ?? "";
const sub = (id) => elements[id + "-sub"]?.textContent ?? "";
const ttl = (id) => elements[id]?.title ?? "";
console.log("# renderSpendCards（总览第一行三卡 + 本月用量行）");
// 合成 DTO：形状 = 真实冻结 DTO（data_contract.rs MonthlySummary::to_json /
// DailySummary::to_json；actual_spend_by_basis 是 domain 拆栏，各栏之和 =
// total_actual_spend）。
const daily = {
  by_provider: {
    "claude-code/anthropic": { amounts_by_basis: { api_equivalent: 1000 }, currency: "USD", has_unresolved: false },
    "claude-code/deepseek-official": { amounts_by_basis: { metered_estimate: 300 }, currency: "CNY", has_unresolved: false },
    "dsh/deepseek-official": { amounts_by_basis: { metered_actual: 18 }, currency: "CNY", has_unresolved: false },
    "codex/openai": { amounts_by_basis: { api_equivalent: 180 }, currency: "USD", has_unresolved: false },
  },
  total_actual_spend: { CNY: 18 },
  actual_spend_by_basis: { metered_actual: { CNY: 18 } },
  tokens_by_harness: {
    "claude-code": { total: 1_000_000_000, uncached_input: 4_000_000, cache_read: 990_000_000, cache_write: 6_000_000, output: 0, cache_hit_ratio: 0.99 },
    codex: { total: 500_000_000, uncached_input: 100_000_000, cache_read: 400_000_000, cache_write: 0, output: 0, cache_hit_ratio: 0.8 },
  },
};
const monthlyDto = {
  by_provider: {
    "claude-code/anthropic": { amounts_by_basis: { fixed_subscription: 20, api_equivalent: 1278 }, currency: "USD", has_unresolved: false },
    "claude-code/zhipu-glm": { amounts_by_basis: { fixed_subscription: 118 }, currency: "CNY", has_unresolved: true },
    "dsh/deepseek-official": { amounts_by_basis: { metered_actual: 232 }, currency: "CNY", has_unresolved: false },
    "workbuddy/tencent": { amounts_by_basis: { harness_billed: 10 }, currency: "CNY", has_unresolved: false },
  },
  total_actual_spend: { CNY: 360, USD: 20 },
  actual_spend_by_basis: {
    fixed_subscription: { CNY: 118, USD: 20 },
    harness_billed: { CNY: 10 },
    metered_actual: { CNY: 232 },
  },
  tokens_by_harness: {
    "claude-code": { total: 3_000_000_000, uncached_input: 12_000_000, cache_read: 2_970_000_000, cache_write: 18_000_000, output: 0 },
  },
};
sandbox.renderSpendCards(daily, monthlyDto);
ok(num("ov-t-tokens") === "1.50B tokens", `今日 tokens 四桶跨执行环境合计、带单位（got ${num("ov-t-tokens")}）`);
ok(num("ov-t-metered") === "¥18.00", `今日按量实付 = actual_spend_by_basis.metered_actual 分币（got ${num("ov-t-metered")}）`);
ok(/^¥[\d.]+ \+ \$[\d.]+$/.test(num("ov-t-nominal")),
  `名义分栏统一币序 CNY 优先（UX#5，got ${num("ov-t-nominal")}）`);
// USD 栏 = api_equivalent 1000 + 180；¥318 = metered_estimate 300 + metered_actual 18。
ok(num("ov-t-nominal").includes("$1180.00") && num("ov-t-nominal").includes("¥318.00"),
  `名义分栏正确（got ${num("ov-t-nominal")}）`);
// 本月支出：按量实付 = metered_actual + harness_billed（同币合并）；订阅月费分币并列；
// 两行永不相加、永不折算——"含订阅月费"句式已删（IA 复核 §3.4/§4.4-1）。
ok(num("ov-m-metered") === "¥242.00", `本月按量实付 = metered_actual 232 + harness_billed 10（got ${num("ov-m-metered")}）`);
ok(num("ov-m-subscription") === "¥118.00 + $20.00", `订阅月费分币并列（got ${num("ov-m-subscription")}）`);
ok(!num("ov-m-metered").includes("$") && !num("ov-m-subscription").includes("≈"),
  "实付/月费不折算、不跨币相加");
ok(num("ov-m-nominal").includes("$1278.00") && num("ov-m-nominal").includes("¥242.00"),
  `本月名义排除订阅月费（got ${num("ov-m-nominal")}）`);
ok(!num("ov-m-nominal").includes("118.00") && !num("ov-m-nominal").includes("20.00"),
  "订阅月费没有混进名义");
ok(num("ov-m-tokens") === "3.00B tokens", `本月用量行 tokens（got ${num("ov-m-tokens")}）`);
ok(sub("ov-m-tokens").includes("日均"), `本月用量行附日均（got "${sub("ov-m-tokens")}"）`);

console.log("# renderSpendCards · 按量三级口径（metered_view：账单 > 归因估算 > 默认估算，2026-09-16）");
// 形状出处：data_contract.rs MonthlySummary::to_json → "metered_view"（metered_view_json）：
// {币种: {amount, actual, declared_estimate, default_estimate, label, unattributed_providers}}。
const tierMonthly = { ...monthlyDto, metered_view: {
  CNY: { amount: 668.57, actual: 452, declared_estimate: 0, default_estimate: 216.57, label: "mixed",
    unattributed_providers: ["claude-code/deepseek-official"] },
  USD: { amount: 132.67, actual: 0, declared_estimate: 132.67, default_estimate: 0, label: "estimate", unattributed_providers: [] },
} };
const tierDaily = { ...daily, metered_view: {
  CNY: { amount: 41.77, actual: 0, declared_estimate: 41.77, default_estimate: 0, label: "estimate", unattributed_providers: [] },
} };
sandbox.renderSpendCards(tierDaily, tierMonthly);
ok(num("ov-m-metered") === "≈¥668.57 含估算 + ≈$132.67 估算",
  `本月按量行按 metered_view 分币显示、估算带标签、混合写「含估算」（got ${num("ov-m-metered")}）`);
ok(num("ov-m-spend-sub").includes("1 个未归因来源"), `副行点名未归因来源数（got "${num("ov-m-spend-sub")}"）`);
ok(num("ov-t-metered") === "≈¥41.77 估算", `今日按量行永远是估算（账单按月不摊天；got ${num("ov-t-metered")}）`);
const tierActual = { ...monthlyDto, metered_view: { CNY: { amount: 242, actual: 242, declared_estimate: 0, default_estimate: 0, label: "actual", unattributed_providers: [] } } };
sandbox.renderSpendCards(daily, tierActual);
ok(num("ov-m-metered") === "¥242.00", `全部来自账单时不带估算标签（got ${num("ov-m-metered")}）`);
sandbox.renderSpendCards(daily, monthlyDto);

console.log("# renderSpendCards · 速览层混币折算（Overview.fx，PM 决策 2026-09-07）");
// 名义/单位成本：有汇率 + 混币 → 并成一个 ≈¥（原始分币进 hover）。
// 今日名义 = {USD 1180, CNY 318}；7.15 → cny = 318 + 1180×7.15 = 8755。
// FX 形状出处：apps/desktop/src-tauri/src/overview.rs::fx_estimate → {usd_cny, as_of}
const FX = { usd_cny: 7.15, as_of: "2026-09" };
sandbox.renderSpendCards(daily, monthlyDto, FX);
ok(num("ov-t-nominal") === "≈¥8755.00",
  `名义混币按 7.15 折算成一个 ≈¥（got ${num("ov-t-nominal")}）`);
ok(ttl("ov-t-nominal").includes("¥318.00") && ttl("ov-t-nominal").includes("$1180.00"),
  `名义 hover 保留原始分币（got "${ttl("ov-t-nominal")}"）`);
ok(ttl("ov-t-nominal").includes("7.15") && ttl("ov-t-nominal").includes("2026-09"),
  `名义 hover 标注折算汇率 + as_of（got "${ttl("ov-t-nominal")}"）`);
// 实付/月费永远分币——fx 不进实付（PM 决策）。
ok(num("ov-m-metered") === "¥242.00" && num("ov-m-subscription") === "¥118.00 + $20.00",
  `实付与月费不折算、保持分币（got ${num("ov-m-metered")} / ${num("ov-m-subscription")}）`);
ok(num("ov-t-metered") === "¥18.00", "今日实付不折算");
ok(num("ov-m-nominal") === "≈¥9379.70" && ttl("ov-m-nominal").includes("$1278.00"),
  `本月「按官方价折算」混币折算成 ≈¥，原始分币进 hover（got ${num("ov-m-nominal")}）`);

// 降级①：无汇率（价表旧版 / fx:null）→ 退回分币旧行为，不加 ≈。
sandbox.renderSpendCards(daily, monthlyDto, null);
ok(/^¥[\d.]+ \+ \$[\d.]+$/.test(num("ov-t-nominal")) && !num("ov-t-nominal").includes("≈"),
  `无汇率退回分币并列（got ${num("ov-t-nominal")}）`);
ok(ttl("ov-t-nominal") === "@官方标价 · cache_write 按 1hr 计", `无折算时 hover 只留档位假设，不留上一轮折算（got "${ttl("ov-t-nominal")}"）`);

// 降级②：单币（只有 CNY）+ 有汇率 → 不折算、不加 ≈（不凭空长符号）。
const cnyOnly = {
  by_provider: { "dsh/deepseek-official": { amounts_by_basis: { metered_actual: 5 }, currency: "CNY", has_unresolved: false } },
  total_actual_spend: { CNY: 5 },
  actual_spend_by_basis: { metered_actual: { CNY: 5 } },
  tokens_by_harness: { dsh: { total: 1_000_000, uncached_input: 1_000_000, cache_read: 0, cache_write: 0, output: 0 } },
};
sandbox.renderSpendCards(cnyOnly, cnyOnly, FX);
ok(num("ov-t-nominal") === "¥5.00", `单币 CNY + 有汇率 → 不折算不加 ≈（got ${num("ov-t-nominal")}）`);
ok(num("ov-m-subscription") === "无数据", "无订阅条目 → 「无数据」，不渲染 0");

// 无数据 → 「无数据」绝不 0
sandbox.renderSpendCards(null, null);
ok(num("ov-t-tokens") === "无数据" && num("ov-t-metered") === "无数据" && num("ov-m-metered") === "无数据",
  "无 DTO 时全部金额渲染「无数据」");
const emptyDto = { by_provider: {}, total_actual_spend: {}, actual_spend_by_basis: {}, tokens_by_harness: {} };
sandbox.renderSpendCards(emptyDto, emptyDto);
ok(num("ov-t-nominal") === "无数据" && num("ov-m-nominal") === "无数据",
  "全空执行环境渲染「无数据」，不渲染 0（DSH 0-token 月同款纪律）");

// REQ-043：未录入套餐/付款时，「已确认支出」必须写「尚未设置套餐或账单」，不能写
// 「无数据」——「无数据」会被读成读取失败/缺失，而真相是还没声明计费方式。
// 真实困惑案例（2026-09-14）：本月支出两栏都是「无数据」，用户以为读不到数据。
console.log("# REQ-043 · 有用量但未声明计费方式");
const usageNoDeclaration = {
  by_provider: { "claude-code/anthropic": { amounts_by_basis: { api_equivalent: 100 }, currency: "USD", has_unresolved: false } },
  total_actual_spend: {}, actual_spend_by_basis: {},
  tokens_by_harness: { "claude-code": { total: 5_000_000, uncached_input: 1_000_000, cache_read: 4_000_000, cache_write: 0, output: 0 } },
};
sandbox.renderSpendCards(usageNoDeclaration, usageNoDeclaration, FX);
ok(num("ov-m-metered") === "尚未设置套餐或账单" && num("ov-m-subscription") === "尚未设置套餐或账单",
  `未录入套餐/账单时两栏都写「尚未设置套餐或账单」（got ${num("ov-m-metered")} / ${num("ov-m-subscription")}）`);
ok(num("ov-m-spend-sub").includes("确认套餐或账单后"),
  `副行说明为空的原因并给出下一步（got ${num("ov-m-spend-sub")}）`);
ok(num("ov-m-nominal") !== "无数据" && num("ov-m-nominal") !== "尚未设置套餐或账单",
  "同一份数据里名义成本仍然有值——空的是「实付口径」，不是「本月没数据」");
// 这条是指引不是金额：必须弱化（muted-amt + setup-link）并可点击跳设置（2026-09-15 反馈）。
ok(el("ov-m-metered").classList.contains("setup-link") && el("ov-m-metered").classList.contains("muted-amt"),
  "「尚未设置套餐或账单」弱化成灰色指引链接，不与金额同权重");
ok(el("ov-m-metered").title.includes("计费与套餐"), "hover 说明点击去处（计费与套餐）");
ok(wb.includes('el.setAttribute("data-go", "settings-billing")') && wb.includes('kpiRow.addEventListener("click", go)'),
  "点击经 #ov-kpi-row 委托跳到 settings-billing");
// 反向：本月没有用量时不能推给"还没声明"（没用量就是没用量）。
const noUsage = { by_provider: {}, total_actual_spend: {}, actual_spend_by_basis: {},
  tokens_by_harness: { dsh: { total: 0, uncached_input: 0, cache_read: 0, cache_write: 0, output: 0 } } };
sandbox.renderSpendCards(noUsage, noUsage, FX);
ok(num("ov-m-metered") === "无数据", "本月零用量时不写「尚未设置套餐或账单」（没用量就是没用量）");
ok(!el("ov-m-metered").classList.contains("setup-link"), "回到「无数据」时指引链接类名被清掉（不残留可点击态）");

// Captured window and confirmed spend: estimates never enter either day's actual line.
const confirmed = { ...daily, actual_spend_by_basis: {
  metered_actual: { CNY: 18 }, harness_billed: { CNY: 7, USD: 2 },
  metered_estimate: { CNY: 999 }, api_equivalent: { USD: 888 }, fixed_subscription: { USD: 20 },
} };
sandbox.renderSpendCards(confirmed, monthlyDto, null, { date: "2026-09-10", month: "2026-09" });
ok(num("ov-t-metered") === "¥25.00 + $2.00", "今日实付合并 harness_billed + metered_actual，排除订阅和估算");
ok(sub("ov-m-tokens").includes("300.0M"), "日均使用捕获窗口的第 10 天");
sandbox.renderSpendCards(null, monthlyDto);
ok(num("ov-m-metered") === "¥242.00" && sub("ov-t-tokens").includes("暂不可读"), "今日失败不影响月支出");
sandbox.renderSpendCards(daily, null);
ok(num("ov-t-metered") === "¥18.00" && sub("ov-m-tokens").includes("暂不可读"), "月汇总失败不影响今日");

console.log("# renderTrustRows（可信度两条状态行，颜色来自 health 不来自百分比）");
function trustRow(id) {
  const li = elements[id] ?? (elements[id] = makeElement());
  const text = elements[id + "-text"] ?? (elements[id + "-text"] = makeElement());
  const action = elements[id + "-action"] ?? (elements[id + "-action"] = makeElement());
  li.querySelector = (sel) => (sel === ".notice-text" ? text : sel === ".notice-actions button" ? action : null);
  return li;
}
const routeRow = trustRow("ov-trust-route");
const priceRow = trustRow("ov-trust-price");
const warnStatus = { status: "ok", data: { health: "warn", unresolved_tokens: 18000, unpriced_tokens: 0, pricing: { stale: false } } };
sandbox.renderTrustRows(warnStatus, monthlyDto);
ok(routeRow.className === "notice warn", `unresolved>0 + health=warn → 路由行 warn（got ${routeRow.className}）`);
ok(elements["ov-trust-route-text"].textContent.includes("18K") && elements["ov-trust-route-text"].textContent.includes("哪家服务商"),
  `路由行用人话点名未归属的 token 量（got "${elements["ov-trust-route-text"].textContent}"）`);
ok(priceRow.className === "notice ok" && elements["ov-trust-price-text"].textContent.includes("没有漏算"),
  `价格齐全是 ok 行、按后果说（got ${priceRow.className} "${elements["ov-trust-price-text"].textContent}"）`);
ok(!elements["ov-trust-price-text"].textContent.includes("可计价") && !elements["ov-trust-price-text"].textContent.includes("覆盖"),
  "「N% 可计价」「价格覆盖」等内部词已消失");
ok(!/未定 provider|路由|未计价/.test(elements["ov-trust-route-text"].textContent + elements["ov-trust-price-text"].textContent),
  "可信度行不含 provider / 路由 / 未计价 等内部词");
const cleanStatus = { status: "ok", data: { health: "ok", unresolved_tokens: 0, unpriced_tokens: 0, pricing: { stale: false } } };
sandbox.renderTrustRows(cleanStatus, monthlyDto);
ok(routeRow.className === "notice ok" && priceRow.hidden === true && elements["ov-trust-route-text"].textContent.startsWith("数据完整"),
  "干净状态合成一句「数据完整」，第二行隐藏");
// 占比必须**同跨度**：unpriced 是全库累计，所以分母是 total_tokens（全库），
// 不是 monthlyDto 的本月总量。此前 fixture 只给本月总量 → 测的正是那个错比率
// （1.09B ÷ 9.60B 的同类）。现在两条都钉：同跨度算出 10%，且**明确不拿本月总量当分母**。
const unpricedStatus = { status: "ok", data: { health: "ok", unresolved_tokens: 0,
  unpriced_tokens: 300_000_000, total_tokens: 3_000_000_000, pricing: { stale: true } } };
sandbox.renderTrustRows(unpricedStatus, monthlyDto);
ok(priceRow.hidden === false && priceRow.className === "notice warn" && elements["ov-trust-price-text"].textContent.includes("少算了约 10%"),
  `unpriced 300M/全库 3B → 少算约 10% warn（got ${elements["ov-trust-price-text"].textContent}）`);
ok(elements["ov-trust-price-text"].textContent.includes("全库累计"),
  "口径写明「全库累计」，不在「本月已处理」底下冒充月度数");

ok(elements["ov-trust-price-text"].textContent.includes("价格表也已过期"), "价格表过期并入价格行");
// 2026-09-16：新载荷带 *_tokens_month → 主数字用本月口径（待确认面板只处理当月，
// 用户能消掉的只有本月），全库多出来的那部分作历史脚注、指出"把声明起始日提前"。
// 形状出处：runtime/src/mcp/data_status.rs collect_report_at_depth →
// unresolved_tokens_month / unpriced_tokens_month / total_tokens_month。
const monthStatus = { status: "ok", data: { health: "warn", pricing: { stale: false },
  unresolved_tokens: 1_550_000_000, unpriced_tokens: 1_190_000_000, total_tokens: 18_000_000_000,
  unresolved_tokens_month: 0, unpriced_tokens_month: 200_000_000, unpriced_metered_tokens_month: 0,
  total_tokens_month: 10_000_000_000, month: "2026-09" } };
sandbox.billingPromptState = { visible: false, pendingTokens: 0 };
sandbox.renderTrustRows(monthStatus, monthlyDto);
ok(routeRow.className === "notice ok" && elements["ov-trust-route-text"].textContent.startsWith("本月用量都已归到对应服务商")
  && elements["ov-trust-route-text"].textContent.includes("历史月份 1.55B") && elements["ov-trust-route-text"].textContent.includes("起始日期提前"),
  `本月归因完毕 → ok 行，历史未归因只作脚注并给出做法（got "${elements["ov-trust-route-text"].textContent}"）`);
ok(priceRow.className === "notice ok" && elements["ov-trust-price-text"].textContent.startsWith("本月有 200")
  && elements["ov-trust-price-text"].textContent.includes("套餐内") && elements["ov-trust-price-text"].textContent.includes("偏低约 2%"),
  `全部在套餐内的缺价 → ok 行、只说折算参考偏低（got "${elements["ov-trust-price-text"].textContent}"）`);
const meteredGap = { ...monthStatus, data: { ...monthStatus.data, unpriced_metered_tokens_month: 50_000_000 } };
sandbox.renderTrustRows(meteredGap, monthlyDto);
ok(priceRow.className === "notice warn" && elements["ov-trust-price-text"].textContent.startsWith("本月有 50.0M tokens 按量用量")
  && elements["ov-trust-price-text"].textContent.includes("另有 150.0M tokens 在套餐内"),
  `按量用量缺价才 warn，并分开说套餐内的部分（got "${elements["ov-trust-price-text"].textContent}"）`);
const monthWarn = { ...monthStatus, data: { ...monthStatus.data, unresolved_tokens_month: 18_000 } };
sandbox.renderTrustRows(monthWarn, monthlyDto);
ok(elements["ov-trust-route-text"].textContent.startsWith("本月有 18K") && elements["ov-trust-route-action"].hidden === false,
  `本月仍有未归因 → warn 行 + 「去明确」（got "${elements["ov-trust-route-text"].textContent}"）`);
// 2026-09-17：「查看价格表」落地要有事可做——status 带 unpriced_models_month 时，设置页
// 「价格目录」列出缺卡型号，每行「补这张卡」把服务商/型号预填进补卡表单。
el("ov-price-missing"); el("ov-price-missing-list"); el("ov-price-card-provider"); el("ov-price-card-model");
el("ov-price-card-status"); el("ov-price-uncached-off");
const missingRows = [];
elements["ov-price-missing-list"].appendChild = (row) => missingRows.push(row);
sandbox.renderTrustRows({ ...meteredGap, data: { ...meteredGap.data, unpriced_models_month: [
  { harness: "codex", provider: "shengsuanyun", model: "gpt-6-astra", tokens: 24_500_000, covered: false },
  { harness: "claude-code", provider: "zhipu-glm", model: "glm-5.3-flash", tokens: 371_900_000, covered: true },
] } }, monthlyDto);
ok(elements["ov-price-missing"].hidden === false && missingRows.length === 2,
  `价格目录列出本月缺卡型号（got ${missingRows.length} 行）`);
const fillBtn = missingRows[0].children ? missingRows[0].children[1] : null;
ok(!!fillBtn && fillBtn.textContent === "补这张卡", "每行带「补这张卡」");
if (fillBtn) fillBtn.onclick();
ok(elements["ov-price-card-provider"].value === "shengsuanyun" && elements["ov-price-card-model"].value === "gpt-6-astra"
  && elements["ov-price-card-status"].textContent.includes("已预填"),
  `「补这张卡」预填服务商与型号（got ${elements["ov-price-card-provider"].value} / ${elements["ov-price-card-model"].value}）`);
console.log("# 补卡表单 · 第四维 cache_write 可选（2026-09-17 交付缺口回归）");
{
  // sanitize_card / claude.rs 早已接受可选第四维，但表单此前只读三维——这里驱动真实
  // save.onclick，钉住 cache_write 能从 UI 一路送到 invoke("save_price_card") 的 payload。
  await sandbox.renderPriceOverrideSettings();
  const set = (id, v) => { el(id).value = v; };
  set("ov-price-card-provider", "shengsuanyun"); set("ov-price-card-model", "gpt-5.6-sol");
  set("ov-price-uncached-off", "29.31"); set("ov-price-uncached-peak", "29.31");
  set("ov-price-cached-off", "2.343"); set("ov-price-cached-peak", "2.343");
  set("ov-price-output-off", "140.885"); set("ov-price-output-peak", "140.885");
  set("ov-price-cachewrite-off", ""); set("ov-price-cachewrite-peak", "");
  priceCardCalls.length = 0;
  await el("ov-price-card-save").onclick();
  ok(priceCardCalls.length === 1 && !("cache_write" in priceCardCalls[0].input),
    `两格留空 → payload 不带 cache_write（got ${JSON.stringify(priceCardCalls[0])}）`);

  set("ov-price-cachewrite-off", "29.31"); set("ov-price-cachewrite-peak", "29.31");
  priceCardCalls.length = 0;
  await el("ov-price-card-save").onclick();
  ok(priceCardCalls.length === 1 && JSON.stringify(priceCardCalls[0].input.cache_write) === JSON.stringify({ off_peak: 29.31, peak: 29.31 }),
    `两格都填 → payload 带 cache_write（got ${JSON.stringify(priceCardCalls[0])}）`);

  set("ov-price-cachewrite-off", "29.31"); set("ov-price-cachewrite-peak", "");
  priceCardCalls.length = 0;
  await el("ov-price-card-save").onclick();
  ok(priceCardCalls.length === 0 && el("ov-price-card-status").textContent.includes("缓存写入两格要么都填"),
    `只填一格 → 拒绝保存并说明原因（got "${el("ov-price-card-status").textContent}"）`);
}
sandbox.renderTrustRows(unpricedStatus, monthlyDto);
// 切掉 total_tokens（旧载荷）→ **不给百分比**，而不是退回用本月总量当分母。
const legacyShape = { status: "ok", data: { health: "ok", unresolved_tokens: 0,
  unpriced_tokens: 300_000_000, pricing: { stale: false } } };
sandbox.renderTrustRows(legacyShape, monthlyDto);
ok(priceRow.hidden === false && !elements["ov-trust-price-text"].textContent.includes("%"),
  `缺同跨度分母时不给百分比（got ${elements["ov-trust-price-text"].textContent}）`);
// 同源合并：套餐提示可见且影响 tokens 盖住 unresolved → ⚠ 行无按钮、指向套餐提示。
sandbox.billingPromptState = { visible: true, pendingTokens: 18000 };
sandbox.renderTrustRows(warnStatus, monthlyDto);
ok(elements["ov-trust-route-text"].textContent.includes("在下方「明确计费方式」里补上服务商即可") && elements["ov-trust-route-action"].hidden === true,
  "同源 18K：⚠ 行指向套餐提示，不自带第二个按钮（一件事一个动作）");
sandbox.billingPromptState = { visible: false, pendingTokens: 18000 };
sandbox.renderTrustRows(warnStatus, monthlyDto);
ok(elements["ov-trust-route-action"].hidden === false && elements["ov-trust-route-action"].textContent === "去明确",
  "套餐提示被「稍后」压住后，⚠ 行恢复自己的按钮，且直接通向「明确计费方式」而不是诊断页");
sandbox.renderTrustRows({ status: "unavailable", reason: "x" }, monthlyDto);
ok(routeRow.className === "notice danger" && priceRow.hidden === true, "数据状态不可用 → danger 一行，不冒充 ok");

sandbox.renderTrustRows(cleanStatus, null);
ok(priceRow.hidden === false && elements["ov-trust-price-text"].textContent.includes("暂不可读"),
  "月汇总不可用不冒充本月零用量或价格完整");

console.log("# renderDualTrack");
const monthly = {
  by_provider: {
    "claude-code/anthropic": { amounts_by_basis: { fixed_subscription: 20, api_equivalent: 1278 }, currency: "USD", has_unresolved: false },
    "claude-code/minimax": { amounts_by_basis: { fixed_subscription: 114, api_equivalent: 127.8 }, currency: "CNY", has_unresolved: false },
    "claude-code/deepseek-official": { amounts_by_basis: { metered_estimate: 452.87 }, currency: "CNY", has_unresolved: false },
    "claude-code/zhipu-glm": { amounts_by_basis: { fixed_subscription: 118 }, currency: "CNY", has_unresolved: true },
    "dsh/deepseek-official": { amounts_by_basis: {}, currency: "CNY", has_unresolved: false },
  },
  total_actual_spend: { CNY: 232, USD: 20 },
};
elements["ov-dual-list"] = { textContent: "", innerHTML: "", hidden: true, appendChild(child) { this._kids ??= []; this._kids.push(child); }, className: "" };
elements["ov-dual-empty"] = { hidden: false };
sandbox.renderDualTrack(monthly);
const dualHtml = (elements["ov-dual-list"]._kids || []).map((k) => k.innerHTML).join("\n");
ok(dualHtml.includes("数字异常") && dualHtml.includes("请核对套餐"), "anthropic 63.9× → 「数字异常，请核对套餐」告警（>50× 护栏，人话）");
ok(dualHtml.includes("值回月费 1.1×"), "minimax 1.12× 显示「值回月费 1.1×」");
// glm（有月费、无标价折算、unresolved）在订阅组里必须显示 unresolved chip
// ——曾因分类进 subEntries 后丢提示，看起来"一切正常"。
ok(dualHtml.includes("部分用量无法估价"), "glm 的 unresolved chip（不得显示 ¥0 或假装正常）");
ok(dualHtml.includes("按量估算（上界）") && dualHtml.includes("（参考）"), "deepseek 的 metered_estimate 标「估算 · 参考」");
ok(dualHtml.includes("$20.00") && dualHtml.includes("¥114.00"), "月费带币种符号（条目级 currency）");
ok(!/metered-bill|official-price-card|fair-market|missing-provider/.test(dualHtml), "费用明细卡面不出现 raw reason code（规格 §4 第 84 行）");
ok(dualHtml.includes(">Anthropic<") && dualHtml.includes("经 Claude Code") && !dualHtml.includes(">anthropic<"),
  "行名 = 服务商（付钱对象，人类名称），执行环境降为「经 X」副属性");
// 同一服务商经多个工具 → 合成一行（同币种相加），执行环境并列；币种不同不相加、分行。
const merged = {
  by_provider: {
    "codex/openai": { amounts_by_basis: { api_equivalent: 10 }, currency: "USD", has_unresolved: false },
    "claude-code/openai": { amounts_by_basis: { api_equivalent: 5, fixed_subscription: 20 }, currency: "USD", has_unresolved: false },
    "dsh/openai": { amounts_by_basis: { metered_actual: 7 }, currency: "CNY", has_unresolved: false },
  },
  by_harness: { codex: { freshness: { state: "fresh", last_observed_at: "2026-09-13" } }, "claude-code": { freshness: { state: "partial", last_observed_at: "2026-09-12" } }, dsh: { freshness: { state: "fresh", last_observed_at: "2026-09-13" } } },
};
elements["ov-dual-list"]._kids = [];
sandbox.renderDualTrack(merged);
const mergedHtml = (elements["ov-dual-list"]._kids || []).map((k) => k.innerHTML).join("\n");
ok(mergedHtml.includes("$15.00") && mergedHtml.includes("经 Codex、Claude Code"), `同服务商同币种合成一行、执行环境并列（got ${mergedHtml.includes("$15.00")}）`);
ok(mergedHtml.includes("¥7.00") && !mergedHtml.includes("$22.00") && !mergedHtml.includes("¥22.00"), "币种不同分行，不跨币相加");
ok(mergedHtml.includes("数据不完整"), "合并行新鲜度取最差（partial 压过 fresh）");

console.log("# renderDecideCard（async，等 promise 排空）");
elements["ov-decide-body"] = { textContent: "", innerHTML: "", appendChild(child) { this._kids ??= []; this._kids.push(child); } };
// stub 形状 = fold plan_from_rate_limits 的真实产物（limits.primary 在下）——
// 审查 #1：旧 stub 按渲染器的错误期望（顶层 primary）构造，互相印证假绿。
sandbox.__quota = { plan_type: "plus", has_credits: false,
  limits: { primary: { used_percent: 92, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 7200 } },
  observed_at: new Date(Date.now() - 60000).toISOString() };
sandbox.renderDecideCard(monthly, sandbox.__quota);
let decideHtml = elements["ov-decide-body"].innerHTML + (elements["ov-decide-body"]._kids || []).map((k) => k.textContent).join("");
ok(decideHtml.includes("剩余 8%"), `Codex 窗口条给剩余%（got 截断）`);
const lowQuotaAdvice = elements["ov-decide-body"]._kids.find((k) => k.className === "decide-advice").textContent;
ok(lowQuotaAdvice === "💡 Codex 额度较低；请在用量或设置中确认可用线路", "Codex 剩 8% → 提示确认可用线路");
ok(!/Claude|GLM|切到/i.test(lowQuotaAdvice), "低额度建议不指名推荐未经证实的替代线路");
// Claude Pro：三态（spec §8.3.2）。旧断言钉的是硬编码占位「无法读取剩余额度」——
// 那句已被真实的窗口状态取代（读 quotaLimits 的 resetsAt）。**唯一不可退让的是
// "不得出现百分比"**：Claude 的本地日志里没有正向读数，任何 % 都是编的。
ok(decideHtml.includes("窗口状态未知"), `无窗口证据时 Claude 行诚实地停在「窗口状态未知」（got 截断）`);
ok(!/Claude Pro[\s\S]{0,200}%/.test(decideHtml), "Claude 行不得出现任何百分比（数据里没有正向读数）");

// exhausted：被限流且重置时刻未到 → 显示窗口类型 + 重置时刻。
elements["ov-decide-body"] = { textContent: "", innerHTML: "", appendChild(child) { this._kids ??= []; this._kids.push(child); } };
const resetAt = Math.floor(Date.now() / 1000) + 7200;
sandbox.renderDecideCard(monthly, sandbox.__quota, {
  state: "exhausted", window: "five_hour", resets_at: resetAt, windows_recent: 2,
});
const exhaustedHtml = elements["ov-decide-body"].innerHTML;
ok(exhaustedHtml.includes("5 小时窗口已耗尽"), `exhausted 显示窗口类型（got 截断）`);
ok(exhaustedHtml.includes("重置"), "exhausted 必须给出重置时刻——这是它唯一有证据的内容");
ok(!/%/.test(exhaustedHtml.split("Claude Pro")[1] || ""), "exhausted 行也不得出现百分比");
// 建议行必须把列表里已渲染的 Claude 证据带进结论（2026-09-15 截图：撞窗 5 次
// 却只说「Codex 额度较低」）。Codex 8% + Claude 耗尽 → 两条都进建议行。
{
  const adv = elements["ov-decide-body"]._kids.find((k) => k.className === "decide-advice").textContent;
  ok(/^💡 Codex 额度较低，Claude Pro 5 小时窗口已耗尽，.+重置；请在用量或设置中确认可用线路$/.test(adv),
    "Codex 低 + Claude 耗尽 → 建议行同时点出两者（got " + adv + "）");
  ok(!/可用(?!线路)/.test(adv), "仍不得把任何一条线路说成「可用」");
}

// 七天窗要如实标出尺度差异（5 小时 vs 7 天差 33 倍，标错等于误导）。
elements["ov-decide-body"] = { textContent: "", innerHTML: "", appendChild(child) { this._kids ??= []; this._kids.push(child); } };
sandbox.renderDecideCard(monthly, sandbox.__quota, {
  state: "exhausted", window: "seven_day", resets_at: resetAt, windows_recent: 1,
});
ok(elements["ov-decide-body"].innerHTML.includes("7 天窗口已耗尽"), "周窗不得标成 5 小时窗口");

// 撞窗次数只在 unknown 态作为可显示内容出现（exhausted 态已有更硬的证据）。
elements["ov-decide-body"] = { textContent: "", innerHTML: "", appendChild(child) { this._kids ??= []; this._kids.push(child); } };
sandbox.renderDecideCard(monthly, sandbox.__quota,
  { state: "unknown", windows_recent: 3, last_resets_at: Math.floor(Date.now() / 1000) - 3600 });
ok(elements["ov-decide-body"].innerHTML.includes("近 7 天撞窗 3 次"), "unknown 态给出撞窗次数（spec §8.3.2）");
// 「未知」不等于"什么都不知道"：上次那条限流的重置时刻是已知的，必须说出来，
// 否则用户只看到"窗口状态未知"（2026-09-14 反馈：我们不是知道什么时候可用吗）。
ok(elements["ov-decide-body"].innerHTML.includes("上次限流已于"),
  "unknown 态说出上一次窗口何时重置，而不是只留一句「未知」");
ok(!/窗口状态未知[^"]*可用/.test(elements["ov-decide-body"].innerHTML.replace(/title="[^"]*"/g, "")),
  "不得从「没有新记录」反推「可用」（沉默有两种解释）");
{
  const adv = elements["ov-decide-body"]._kids.find((k) => k.className === "decide-advice").textContent;
  ok(adv.includes("Claude Pro 近 7 天撞窗 3 次，窗口状态未知"),
    "unknown 态且有撞窗记录 → 撞窗次数进建议行（got " + adv + "）");
}

sandbox.__quota = { plan_type: "plus", has_credits: false,
  limits: { primary: { used_percent: 40, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 7200 } },
  observed_at: new Date(Date.now() - 60000).toISOString() };
elements["ov-decide-body"] = { textContent: "", innerHTML: "", appendChild(child) { this._kids ??= []; this._kids.push(child); } };
sandbox.renderDecideCard(monthly, sandbox.__quota);
decideHtml = elements["ov-decide-body"].innerHTML + (elements["ov-decide-body"]._kids || []).map((k) => k.textContent).join("");
ok(decideHtml.includes("可继续使用"), "Codex 剩 60% → 健康态");

console.log("# renderOverview · 未设置预算");
sandbox.__overview = {
  budget: { source: "sql", level: "no_budget", month_cost: 42,
    monthly_cny: null, month_ratio: null, effective_daily_budget: null,
    reasons: ["budget_not_configured"] },
  budget_monthly_cny: null, sync: { ok: true, at: "", message: "ok" },
  days: [], fx: null, estimate_note: "fixture", data_home: "<fixture>",
};
await sandbox.renderOverview();
ok(num("ov-budget-amount") === "—", "未设置预算不显示0%或默认比例");
ok(num("ov-budget-sub").includes("尚未设置预算") && num("ov-budget-sub").includes("成本统计不受影响"),
  "未设置预算明确提示且不隐藏成本统计能力");
ok(!num("ov-budget-sub").includes("600") && !num("ov-budget-sub").includes("30"),
  "首次安装不泄漏模板默认预算");

console.log("# 预算卡 · 已配置但本月没有可计入的按量实付");
// 后端真实形状（2026-09-14 实测 `budget show --json`）：月预算有、month_cost 与
// month_ratio 都是 null。旧代码把它塞进通用兜底说成「暂不可读，请刷新重试」——
// 那会让用户去点刷新，而它永远刷不出来（口径是"按量实付"，没确认计费方式前
// 就是没有实付，刷新改变不了）。
sandbox.__overview = {
  budget: { source: "sql", level: "ok", month_cost: null, month_ratio: null,
    monthly_cny: 1, effective_daily_budget: 1, reasons: ["stale legacy reason"] },
  budget_monthly_cny: 1, sync: { ok: true, at: "", message: "ok" },
  days: [], fx: null, estimate_note: "fixture", data_home: "<fixture>",
};
await sandbox.renderOverview();
ok(elements["ov-budget-card"].hidden === false, "预算已配置 → 卡片必须显示（不能因为算不出比例就藏卡）");
ok(num("ov-budget-sub").includes("还没有可计入的按量实付"),
  `说明为什么没有进度（got ${num("ov-budget-sub")}）`);
ok(!num("ov-budget-sub").includes("刷新重试"),
  "不得说成「暂不可读，请刷新重试」（刷不出来的东西不该让用户去刷）");
ok(num("ov-budget-sub").includes("¥1"), "把已配置的月预算如实带出来");

console.log("# renderOverview · 预算卡优先读 budget_profiles.estimate（设置页规格 §8 D1）");
// 旧 legacy 预算（¥600/月，已超支）与设置页新存的 estimate profile（¥200/月，
// 已用 ¥120，未超支）同时存在——卡片必须显示 profile 的数字，不是 legacy 的，
// 否则设置页保存的预算在总览上白存了。
sandbox.__overview = {
  budget: { source: "sql", level: "over", month_cost: 900, monthly_cny: 600,
    month_ratio: 1.5, effective_daily_budget: 20, reasons: ["legacy_should_not_show"] },
  budget_profiles: { status: "ok", month: "2026-09", profiles: [
    { profile_id: "estimate", currency: "CNY", monthly_minor: 20000, daily_minor: null,
      warning_ratio_bp: 8000, spent_minor: 12000, ratio_bp: 6000, level: "ok", has_unresolved: false },
  ] },
  budget_monthly_cny: 600, sync: { ok: true, at: "", message: "ok" },
  days: [], fx: null, estimate_note: "fixture", data_home: "<fixture>",
};
await sandbox.renderOverview();
ok(num("ov-budget-amount") === "¥120 / ¥200", `profile 数字覆盖 legacy（got ${num("ov-budget-amount")}）`);
ok(!num("ov-budget-sub").includes("legacy_should_not_show"), "不残留 legacy reasons");
ok(num("ov-budget-sub").includes("60%"), "百分比来自 profile 的 ratio_bp（60%），不是 legacy 的 150%");

console.log("# renderOverview · 预算已用 = 按量三级口径 + 订阅月费按天摊派（2026-09-17）");
// 形状出处：runtime/src/budget.rs budget_profiles_status_sql_at → metered_spent_minor /
// subscription_amortized_minor / total_spent_minor / subscription_days_elapsed / days_in_month。
sandbox.__overview = {
  ...sandbox.__overview,
  budget_profiles: { status: "ok", month: "2026-09", profiles: [
    { profile_id: "estimate", currency: "CNY", monthly_minor: 50000, daily_minor: null, warning_ratio_bp: 8000,
      spent_minor: 12000, metered_spent_minor: 12000, subscription_minor: 44800, subscription_amortized_minor: 25387,
      subscription_days_elapsed: 17, days_in_month: 30, subscription_fx_applied: true, total_spent_minor: 37387,
      ratio_bp: 7477, level: "ok", has_unresolved: false },
  ] },
};
await sandbox.renderOverview();
ok(num("ov-budget-amount") === "¥373.9 / ¥500", `大字 = 按量 + 订阅摊派（got ${num("ov-budget-amount")}）`);
// 副行只放两项金额；摊派规则（月费 × 已过天数 / 当月天数）进 tooltip，卡片一行放不下。
ok(num("ov-budget-sub").includes("订阅摊派 ≈¥253.9") && num("ov-budget-sub").includes("按量 ≈¥120"),
  `副行拆开订阅摊派（折算标 ≈）与按量（got ${num("ov-budget-sub")}）`);
ok(sandbox.document.getElementById("ov-budget-sub").title.includes("按已过 17/30 天摊派"),
  `摊派规则在副行 tooltip（got ${sandbox.document.getElementById("ov-budget-sub").title}）`);
// 只有订阅、没有按量：不再是 ¥0。
sandbox.__overview = {
  ...sandbox.__overview,
  budget_profiles: { status: "ok", month: "2026-09", profiles: [
    { profile_id: "estimate", currency: "CNY", monthly_minor: 50000, daily_minor: null, warning_ratio_bp: 8000,
      spent_minor: 0, metered_spent_minor: 0, subscription_minor: 16200, subscription_amortized_minor: 9180,
      subscription_days_elapsed: 17, days_in_month: 30, subscription_fx_applied: false, total_spent_minor: 9180,
      ratio_bp: 1836, level: "ok", has_unresolved: false },
  ] },
};
await sandbox.renderOverview();
ok(num("ov-budget-amount") === "¥91.8 / ¥500" && num("ov-budget-sub").includes("订阅摊派 ¥91.8") && !num("ov-budget-sub").includes("按量"),
  `只有订阅时预算卡反映订阅摊派而不是 ¥0（got ${num("ov-budget-amount")} · ${num("ov-budget-sub")}）`);

console.log("# renderOverview · profile has_unresolved → 「至少已用…仍有未覆盖用量」");
sandbox.__overview = {
  ...sandbox.__overview,
  budget_profiles: { status: "ok", month: "2026-09", profiles: [
    { profile_id: "estimate", currency: "CNY", monthly_minor: 20000, daily_minor: null,
      warning_ratio_bp: 8000, spent_minor: 8000, ratio_bp: null, level: "incomplete", has_unresolved: true },
  ] },
};
await sandbox.renderOverview();
ok(num("ov-budget-sub").includes("至少已用 ¥80") && num("ov-budget-sub").includes("仍有未覆盖用量") &&
  !num("ov-budget-sub").includes("0%"),
  `incomplete profile 用金额下界而非编造百分比（ratio_bp 本是 null）（got ${num("ov-budget-sub")}）`);

console.log("# renderOverview · 全局静默覆盖 profile 自身的 level（profile 不感知 snooze）");
sandbox.__overview = {
  budget: { source: "sql", level: "ok", month_cost: 0, monthly_cny: 600,
    month_ratio: 0, effective_daily_budget: null, reasons: null,
    snoozed_until: new Date(Date.now() + 86400000).toISOString() },
  budget_profiles: { status: "ok", month: "2026-09", profiles: [
    { profile_id: "estimate", currency: "CNY", monthly_minor: 20000, daily_minor: null,
      warning_ratio_bp: 8000, spent_minor: 25000, ratio_bp: 12500, level: "exceeded", has_unresolved: false },
  ] },
  budget_monthly_cny: 600, sync: { ok: true, at: "", message: "ok" },
  days: [], fx: null, estimate_note: "fixture", data_home: "<fixture>",
};
await sandbox.renderOverview();
ok(num("ov-budget-sub").includes("提醒已静默"),
  `设置页「本周期静默提醒」写的全局 snooze 让总览卡片跟着变，不因换成 profile 数据源而失效（got ${num("ov-budget-sub")}）`);

console.log("# renderOverview · estimate profile 月额缺失时回落 legacy（不当作已配置）");
sandbox.__overview = {
  budget: { source: "sql", level: "no_budget", month_cost: 0, monthly_cny: null,
    month_ratio: null, effective_daily_budget: null, reasons: null },
  budget_profiles: { status: "ok", month: "2026-09", profiles: [
    { profile_id: "confirmed", currency: "CNY", monthly_minor: 50000, daily_minor: null,
      warning_ratio_bp: 8000, spent_minor: 0, ratio_bp: null, level: "no_data", has_unresolved: false },
  ] },
  budget_monthly_cny: null, sync: { ok: true, at: "", message: "ok" },
  days: [], fx: null, estimate_note: "fixture", data_home: "<fixture>",
};
await sandbox.renderOverview();
ok(num("ov-budget-amount") === "—" && num("ov-budget-sub").includes("尚未设置预算"),
  "没有 estimate（只有 confirmed）时不误用其他 profile，正确回落未配置态");

if (failed) { console.error("\n" + failed + " 项断言失败"); process.exit(1); }
console.log("\n通过。");
