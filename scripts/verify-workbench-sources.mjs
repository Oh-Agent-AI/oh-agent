#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, "utf8");
const js = read("apps/desktop/src-tauri/ui/workbench.js");
const html = read("apps/desktop/src-tauri/ui/workbench.html");
const lib = read("apps/desktop/src-tauri/src/lib.rs");
const runtime = read("crates/agent-vitals-mcp/src/mcp/mod.rs");
let failed = 0;
const ok = (condition, message) => {
  if (condition) console.log("  ok  " + message);
  else { failed += 1; console.error("FAIL  " + message); }
};

console.log("# 独立数据源状态契约");
ok(/fn data_source_status\(\)/.test(lib), "桌面后端提供独立命令");
ok(/generate_handler!\[[\s\S]*data_source_status,/.test(lib), "独立命令注册到 IPC");
ok(/generate_handler!\[[\s\S]*sync_request_status,/.test(lib), "同步请求状态命令注册到 IPC");
ok(js.includes('invoke("data_source_status")'), "数据源页消费独立命令");
ok(!/sessions_list[\s\S]{0,160}source_statuses/.test(js), "不再从会话搜索读取源状态");
ok(runtime.includes("crate::ingest_service::FACT_HARNESSES"), "契约由已接线执行环境注册表驱动");
for (const field of ["source_id", "authorization", "connection_state", "scan",
  "log", "import_scope", "failed_scope", "recovery_action"]) {
  ok(runtime.includes(`\"${field}\"`), `契约包含 ${field}`);
}
ok(js.includes("for (const source of ordered)"), "前端按返回集合渲染而非硬编码执行环境");
ok(js.includes("recoverSource(button, key") && js.includes('invoke("trigger_sync")'),
  "未检测与失败状态都有恢复动作");
ok(js.includes('invoke("sync_request_status", { requestId })'), "恢复动作按请求ID等待完成");
ok(!/id="ov-billing-review"[^>]*aria-expanded/.test(html),
  "套餐确认入口不暴露为 AX 折叠控件，保留普通按钮点击语义");
ok(/id="ov-billing-review"[^>]*>明确计费方式<\/button>/.test(html) &&
  /id="ov-billing-review-panel"[^>]*role="region"[^>]*aria-labelledby="ov-billing-review-title"/.test(html),
  "套餐确认入口使用普通按钮并保留展开区域标题语义");
ok(js.includes("if (control) control.disabled = true;") && js.includes("if (control) control.disabled = false;"),
  "已保存声明锁定三步选择，避免切换为仍不确定造成状态漂移");
ok(lib.includes("match worker_db.billing_recalculation_run") && lib.includes("Ok(true) => return") &&
  !/billing_recalculation_run\([\s\S]{0,180}\.is_ok\(\)/.test(lib),
  "重算 worker 只把 changed=true 当作成功，不吞掉 false/错误回执");
ok(lib.includes("fn billing_recalculation_jobs()") &&
  /billing_recalculation_job_status,[\s\S]*billing_recalculation_jobs,/.test(lib) &&
  // 总览重构后 jobs 走 OVERVIEW_REQUESTS 的合并拉取（command 字段动态 invoke），
  // 不再是页面里一处字面量 invoke("billing_recalculation_jobs")。
  js.includes('command: "billing_recalculation_jobs"') && js.includes("重算待重试"),
  "工作台重启后读取待处理重算并提供可见重试入口");

console.log("# 真实前端渲染与恢复链路");
const elements = {};
function makeEl(id) {
  const classes = new Set();
  const attrs = {};
  let textValue = "";
  let htmlValue = "";
  const node = {
    id, children: [], dataset: {}, hidden: false, disabled: false, title: "",
    classList: { add: (...names) => names.forEach(name => classes.add(name)), contains: name => classes.has(name),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : !!force; on ? classes.add(name) : classes.delete(name); return on; } },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    focus() { this.focused = true; },
    addEventListener() {}, remove() { this.removed = true; }, scrollIntoView() {},
    click() { if (typeof this.onclick === "function") return this.onclick(); },
    // renderSourceRow 用 setAttribute("aria-expanded", …) 记录展开态——真实按钮
    // 有这个方法，makeEl 之前没实现，切到行式结构后第一次跑就在这里炸。
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return attrs[name] ?? null; },
    removeAttribute(name) { delete attrs[name]; },
  };
  Object.defineProperties(node, {
    textContent: { get: () => textValue, set: value => { textValue = String(value); htmlValue = ""; node.children = []; } },
    innerHTML: { get: () => htmlValue, set: value => { htmlValue = String(value); textValue = ""; node.children = []; } },
  });
  return node;
}
for (const id of ["src-loading", "src-banner", "src-cards", "src-foot", "src-sync"]) {
  elements[id] = makeEl(id);
}
let statusFailure = false;
let triggered = 0;
let statusReads = 0;
let completionPolls = 0;
let neverComplete = false;
let lastPollArgs = null;
const sourceDto = {
  status: "ok",
  sources: [
    { source_id: "harness:claude-code", harness: "claude-code", connection_state: "not_detected",
      scan: { source_count: 0 }, log: {}, import_scope: { facts: 0, sessions: 0 }, failed_scope: { sources: 0 },
      recovery_action: { kind: "scan_and_connect", label: "扫描并接入" } },
    { source_id: "harness:codex", harness: "codex", connection_state: "connected",
      scan: { source_count: 2 }, log: { last_event_at_ms: 1 }, import_scope: { facts: 4, sessions: 2 }, failed_scope: { sources: 0 },
      recovery_action: { kind: "sync", label: "立即同步" } },
    { source_id: "harness:dsh", harness: "dsh", connection_state: "needs_attention",
      scan: { source_count: 1 }, log: {}, import_scope: { facts: 0, sessions: 0 },
      failed_scope: { sources: 1, error_codes: ["permission"] }, recovery_action: { kind: "retry_sync", label: "重新同步" } },
  ],
};
// workbench.js 在加载时解构 `const { invoke } = window.__TAURI__.core`，之后换
// `sandbox.__TAURI__.core.invoke` 不起作用；计费段用这个钩子注入自己的 fixture。
let billingOverride = null;
const invoke = async (command, args) => {
  if (billingOverride) {
    const overridden = await billingOverride(command, args);
    if (overridden !== undefined) return overridden;
  }
  if (command === "data_source_status") {
    statusReads += 1;
    return statusFailure ? { status: "unavailable", reason: "schema mismatch", sources: [] } : sourceDto;
  }
  if (command === "custom_source_roots") return { status: "ok", sources: [] };
  if (command === "source_read_locations") return { status: "ok", locations: {} };
  if (command === "sync_pause_state") return { status: "ok", paused: false };
  if (command === "read_overview") return { sync: { ok: true, at: "same-second" } };
  if (command === "trigger_sync") { triggered += 1; return "sync-test-1"; }
  if (command === "sync_request_status") {
    completionPolls += 1;
    lastPollArgs = args;
    return { request_id: "sync-test-1", completed: !neverComplete && completionPolls >= 2 };
  }
  return null;
};
const sandbox = {
  console,
  document: {
    getElementById: id => (elements[id] ||= makeEl(id)),
    createElement: tag => makeEl(tag),
    createTextNode: text => ({ textContent: String(text), children: [] }),
    querySelectorAll: () => [],
    addEventListener() {},
  },
  __TAURI__: { core: { invoke }, event: { listen: async () => () => {} } },
  setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {};
sandbox.TimelineGeometry = { buildTimeline: () => "" };
vm.createContext(sandbox);
vm.runInContext(js, sandbox, { filename: "workbench.js" });

await sandbox.loadSources(true);
// 行式列表（设置页规格 §4.1.1）：row.children = [head, detail]；
// head.children = [dot, name, state, meta, caret]。失败来源排最前
// （renderSources 的 ordered 排序），其余保持契约返回顺序。
const rows = elements["src-cards"].children;
ok(rows.length === 3, "真实 renderSources 渲染三条数据源行");
const names = rows.map(row => row.children[0].children[1].textContent);
ok(names.join("|") === "DeepSeek Harness|Claude Code|Codex", "失败来源排最前，其余顺序来自契约");
const dshDetail = rows[0].children[1];
ok(dshDetail.children.some(child => child.title === "permission"), "原始 error code 只在展开区 title，不上摘要文字");
ok(dshDetail.children.some(child => child.textContent.includes("没有读取权限")), "reason code 映射为人话（规格 §5.6）");
ok(dshDetail.children.some(child => child.textContent.includes("不是新鲜数据")), "失败来源明确不宣称数据新鲜");
ok(elements["src-banner"].hidden === false && elements["src-banner"].textContent.includes("DeepSeek Harness") && elements["src-banner"].textContent.includes("其他来源已继续同步"),
  "部分失败横幅点名失败执行环境并说明其他来源继续同步");
// 恢复动作现在住在展开区 .src-row-detail-actions 里（规格 §4.1.1），不再是
// 卡片的直接子节点；按钮文字仍是契约 recovery_action.label 原样透传。
const actionButtons = rows.flatMap(row =>
  row.children[1].children.filter(c => c.className === "src-row-detail-actions").flatMap(a => a.children));
const firstAction = actionButtons.find(child => child.textContent === "扫描并接入");
await firstAction.onclick();
ok(triggered === 1 && completionPolls === 2, "恢复动作至少观察一次未完成再等到本请求完成");
ok(statusReads === 2, "本请求完成前不重读、完成后只重读一次独立状态");
ok(lastPollArgs && lastPollArgs.requestId === "sync-test-1", "轮询携带本次同步请求ID");
neverComplete = true;
const readsBeforeTimeout = statusReads;
await firstAction.onclick();
ok(completionPolls === 12 && statusReads === readsBeforeTimeout,
  "超时前轮询十次且不提前重读数据源状态");
ok(elements["src-banner"].hidden === false && elements["src-banner"].textContent.includes("仍在后台运行"),
  "同步超时显示明确错误而不宣称成功");
statusFailure = true;
await sandbox.loadSources(true);
ok(elements["src-banner"].hidden === false && elements["src-banner"].textContent.includes("schema mismatch"),
  "契约失败显示错误横幅而非零数据");

console.log("# 计费确认主链（docs/v1.0.0/BETA_1_BILLING_CONFIRMATION_CHAIN_SPEC.md §7.2，v1.2「明确计费方式」）");
for (const id of ["ov-billing-prompt", "ov-billing-review-panel", "ov-billing-review",
  "ov-billing-review-close", "ov-billing-prompt-copy", "ov-billing-review-list",
  "ov-billing-later", "ov-billing-save", "ov-billing-cancel",
  "ov-billing-relationship-effect", "ov-billing-start", "ov-billing-end", "ov-billing-open-ended", "ov-billing-scope-text",
  "ov-billing-declaration-panel", "ov-billing-declaration-context", "ov-billing-preview", "ov-billing-missing",
  "ov-billing-batch-row", "ov-billing-batch", "ov-billing-batch-text",
  "ov-billing-provider-row", "ov-billing-provider", "ov-billing-route-row", "ov-billing-route",
  "ov-billing-mode-row", "ov-billing-mode", "ov-billing-subscription-fields", "ov-billing-subscription-name",
  "ov-billing-backdrop", "ov-billing-close", "ov-billing-declaration-stats", "ov-billing-batch-models", "ov-billing-batch-models-toggle", "ov-billing-dates-row",
  "ov-billing-subscription-amount", "ov-billing-subscription-currency", "ov-billing-amount-unknown",
  "ov-billing-recalculation-panel", "ov-billing-recalculation-list",
  "settings-billing-candidates", "settings-billing-candidates-copy", "settings-billing-candidates-open"]) {
  elements[id] ||= makeEl(id);
}
// V1：孤儿端点、两步「应用」按钮、候选直通 accept、直接选 relationship 的旧下拉都不得再出现。
ok(!js.includes("billing_declaration_impact_preview") && !html.includes("billing_declaration_impact_preview"),
  "修订级预览孤儿端点已从前端删除（B5）");
ok(!js.includes("ov-billing-apply") && !html.includes("ov-billing-apply"),
  "保存与重算不再是两次点击（G6）");
ok(!/decision:\s*"accept"|resolve\("accept"\)|"是我的套餐"/.test(js),
  "候选没有绕过预览与声明的 accept 直通（G1）");
ok(!html.includes('id="ov-billing-relationship"') && html.includes('id="ov-billing-route"') && html.includes('id="ov-billing-mode"'),
  "relationship_kind 由「服务商 → 路由 → 计费方式」三步推导，不再直接选（v1.2 §5.3a）");
ok(html.includes('id="ov-billing-review">明确计费方式</button>') && !/编辑/.test(html.slice(html.indexOf('id="ov-billing-prompt"'), html.indexOf('id="ov-billing-prompt"') + 800)),
  "入口主按钮用任务语言「明确计费方式」，不含「编辑」（REQ-020）");
ok(!/billing_candidate_impact_preview[\s\S]{0,400}windowStartMs/.test(js),
  "预览不再由前端传统计月窗口（G2）");
ok(js.includes("calendarLoadedMonth = null;") && js.includes("sessState.loaded = false;") && js.includes("findState.loaded = false;")
  && /async function refreshAfterBillingChange[\s\S]{0,600}loadActiveTab\(\)/.test(js),
  "重算完成后作废用量/会话/待处理缓存并重拉当前页，而不是只刷新总览（用户路径第 6 步）");

const storage = {};
sandbox.localStorage = { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } };
sandbox.sessionStorage = sandbox.localStorage;
const month = sandbox.statisticsMonth();
const monthStart = month + "-01";
const today = new Date().toISOString().slice(0, 10);
const groupsReport = { status: "ok", month, groups: [
  { group_id: "codex|openai|gpt-5.6-sol|session-native|metered_estimate|" + month, harness: "codex", provider_id: "openai",
    model_id: "gpt-5.6-sol", evidence_basis: "session-native", pricing_basis: "metered_estimate", tokens: 1_650_000,
    first_event_at_ms: 1, last_event_at_ms: 2, session_count: 7, effective_start: month, effective_end: month,
    estimated_amounts: [{ amount_minor: 1892, currency: "USD", basis: "metered_estimate" }], unpriced_tokens: 0, unresolved_reason: null },
  { group_id: "claude-code|minimax|MiniMax-M2.5|missing|metered_estimate|" + month, harness: "claude-code", provider_id: "minimax",
    model_id: "MiniMax-M2.5", evidence_basis: "missing", pricing_basis: "metered_estimate", tokens: 980_000,
    first_event_at_ms: 1, last_event_at_ms: 2, session_count: 4, effective_start: month, effective_end: month,
    estimated_amounts: [{ amount_minor: 760, currency: "CNY", basis: "metered_estimate" }], unpriced_tokens: 0, unresolved_reason: null },
  // 与 sol 同执行环境、同 provider、同证据、同计价依据、同日期 → 同一批量键。
  { group_id: "codex|openai|gpt-5.6-luna|session-native|metered_estimate|" + month, harness: "codex", provider_id: "openai",
    model_id: "gpt-5.6-luna", evidence_basis: "session-native", pricing_basis: "metered_estimate", tokens: 120_000,
    first_event_at_ms: 1, last_event_at_ms: 2, session_count: 1, effective_start: month, effective_end: month,
    estimated_amounts: [{ amount_minor: 96, currency: "USD", basis: "metered_estimate" }], unpriced_tokens: 0, unresolved_reason: null },
  // 服务商未知的组：弹窗必须先问服务商。
  { group_id: "claude-code|<unknown>|glm-5|missing|metered_estimate|" + month, harness: "claude-code", provider_id: "<unknown>",
    model_id: "glm-5", evidence_basis: "missing", pricing_basis: "metered_estimate", tokens: 640_000,
    first_event_at_ms: 1, last_event_at_ms: 2, session_count: 3, effective_start: month, effective_end: month,
    estimated_amounts: [], unpriced_tokens: 640_000, unresolved_reason: "billing-route-unknown" },
  { group_id: "codex|openai|gpt-mystery|missing|unavailable|" + month, harness: "codex", provider_id: "openai",
    model_id: "gpt-mystery", evidence_basis: "missing", pricing_basis: "unavailable", tokens: 18_000,
    first_event_at_ms: 1, last_event_at_ms: 2, session_count: 1, effective_start: month, effective_end: month,
    estimated_amounts: [], unpriced_tokens: 18_000, unresolved_reason: "no compatible price card" },
] };
const candidatesReport = { status: "ok", candidates: [{ candidate_id: "candidate-test", harness: "codex", provider_id: "openai",
  amount_minor: 2000, currency: "USD", billing_period_start: "2026-06-01", status: "pending" }] };
await sandbox.renderBillingConfirmation(groupsReport, candidatesReport);
ok(elements["ov-billing-prompt"].hidden === false, "待确认组存在时显示入口提示");
const promptCopy = elements["ov-billing-prompt-copy"].textContent;
ok(/发现 5 组/.test(promptCopy), "提示按组计数");
ok(promptCopy.includes("19.88") && promptCopy.includes("7.60") && !promptCopy.includes("27.48"),
  "提示金额分币列出，USD 与 CNY 永不相加");
ok(promptCopy.includes("确认后可区分订阅覆盖和额外按量费用") && promptCopy.includes("已按官方价估算"),
  "提示同时说清受影响用量、当前默认处理与确认收益（AC26）");
ok(elements["ov-billing-review-panel"].hidden === true, "初始状态保持确认面板收起");
await elements["ov-billing-review"].onclick();
const reviewRows = elements["ov-billing-review-list"].children;
ok(elements["ov-billing-review-panel"].hidden === false && reviewRows.length === 5,
  "点击明确计费方式展开面板并按组渲染五行");
ok(reviewRows[0].children[0].textContent.includes("gpt-5.6-sol") && reviewRows[4].children[0].textContent.includes("无价卡"),
  "V3：金额最大的组在前，无价卡的组排最后");
ok(reviewRows[0].children[0].children.some((child) => child.textContent.includes("来自旧版本套餐记录")),
  "旧资产候选作为证据行挂在同执行环境同 provider 的组下");
const rowButtons = reviewRows.map((row) => row.children[1].children.map((b) => b.textContent));
ok(rowButtons.every((labels) => labels.length === 1 && labels[0] === "明确计费方式"),
  "每组只有一个主操作「明确计费方式」");

// 弹窗：路由已知（session-native）→ 只问计费方式；同类组默认批量。
const billingCalls = [];
const previewFixture = (args) => ({ status: "ok", harness: args.harness, provider_id: args.providerId,
  relationship_kind: args.relationshipKind, effective_start: args.effectiveStart, effective_end: args.effectiveEnd,
  scopes: args.scopes, changes_amounts: args.relationshipKind === "official_subscription",
  moved: { fact_count: 24, session_count: 8, tokens: 1_770_000, unpriced_tokens: 0,
    amounts: args.relationshipKind === "official_subscription" ? [{ amount_minor: 1988, currency: "USD", basis: "metered_estimate" }] : [],
    estimated_amounts: [{ amount_minor: 1988, currency: "USD", basis: "metered_estimate" }] },
  kept: { tokens: 18_000, unpriced_tokens: 18_000, amounts: [] },
  pending: { fact_count: 2, tokens: 900, reasons: ["route-evidence-conflict"] },
  first_event_ts_ms: 1, last_event_ts_ms: 2 });
billingOverride = async (command, args) => {
  billingCalls.push({ command, args });
  if (command === "billing_candidate_impact_preview") return previewFixture(args);
  if (command === "save_billing_declaration_revision") {
    return { status: "saved", revision_id: args.revisionId, declaration_id: args.declarationId, changed: true,
      // 2026-09-16 起所有关系都入队重算：非订阅写 user_declared（金额不变），
      // 待确认组认它——确认经中转/按量/组织后行要关掉（真机缺口：关不掉）。
      job: { job_id: "billing-" + args.revisionId, status: "queued", changed: true } };
  }
  if (command === "billing_recalculation_job_status") return { status: "succeeded", job_id: args.jobId };
  if (command === "revoke_billing_declaration") return { status: "revoked" };
  if (command === "save_price_route") return { status: "saved" };
  return undefined;
};
sandbox.renderOverview = async () => { billingCalls.push({ command: "<renderOverview>" }); };
await reviewRows[0].children[1].children[0].onclick();
ok(elements["ov-billing-declaration-panel"].hidden === false && elements["ov-billing-provider-row"].hidden === true
  && elements["ov-billing-route-row"].hidden === true && elements["ov-billing-mode-row"].hidden === false,
  "路由证据已是官方（session-native）时只问计费方式，不问服务商与路由（缺什么问什么）");
ok(elements["ov-billing-batch-row"].hidden === false && elements["ov-billing-batch"].checked === true
  && /将同时处理 2 个模型、8 个会话、1\.8M tokens/.test(elements["ov-billing-batch-text"].textContent),
  "默认勾选同执行环境、同未知原因、同日期的同类组并汇总模型/会话/tokens");
ok(elements["ov-billing-batch-models"].hidden === true && elements["ov-billing-batch-models-toggle"].textContent === "查看这 2 个模型",
  "模型清单默认折叠，只留一个展开入口");
elements["ov-billing-batch-models-toggle"].onclick();
ok(elements["ov-billing-batch-models"].hidden === false && elements["ov-billing-batch-models"].children.length === 2
  && elements["ov-billing-batch-models"].children.map((c) => c.textContent).join("|").includes("gpt-5.6-sol")
  && elements["ov-billing-batch-models"].children.map((c) => c.textContent).join("|").includes("gpt-5.6-luna")
  && elements["ov-billing-batch-models-toggle"].textContent === "收起模型清单",
  "展开后列出将一起处理的模型（含 token 规模），可再收起");
ok(elements["ov-billing-backdrop"].hidden === false && elements["ov-billing-declaration-stats"].textContent.includes("1.6M tokens · 7 个会话"),
  "弹窗打开时显示真实遮罩层，头部规模信息单独一行");
ok(elements["ov-billing-scope-text"].textContent.includes("2 个模型（gpt-5.6-sol 等）") && elements["ov-billing-scope-text"].textContent.includes(monthStart === today ? today : monthStart + " – " + today), // 每月 1 号起止同一天，界面只写一个日期（billingRangeText）
  "作用范围一句话列出模型数与起止日期");
ok(elements["ov-billing-mode"].value === "" && elements["ov-billing-subscription-fields"].hidden === true,
  "没有账户证据时不预选计费方式（规格 §4「无证据 → 不预选」），订阅字段也不出现");
await elements["ov-billing-save"].onclick();
ok(elements["ov-billing-preview"].textContent.includes("请选择计费方式") && !billingCalls.some((c) => c.command === "billing_candidate_impact_preview"),
  "未选计费方式时前端直接拒绝，不发预览请求");
elements["ov-billing-mode"].value = "subscription";
elements["ov-billing-mode"].onchange();
ok(elements["ov-billing-subscription-fields"].hidden === false && elements["ov-billing-relationship-effect"].textContent.includes("移出按量估算"),
  "选择官方订阅后展示套餐名/月费/币种字段与结果说明");
ok(elements["ov-billing-subscription-amount"].value === "20.00" && elements["ov-billing-subscription-currency"].value === "USD",
  "有旧资产候选时预填其套餐金额/币种供核对");
elements["ov-billing-subscription-amount"].value = "";
// 订阅：用户想的是「哪天订的、每月扣多少」——只填订阅日期，适用范围由程序给
// （订阅日起、**持续有效**），起止日期行不出现（自动归因规格 §4 第 5 步 / §5.2）。
ok(elements["ov-billing-dates-row"].hidden === true && elements["ov-billing-subscription-anchor"].value === monthStart
  && elements["ov-billing-subscription-anchor"].max === today
  && elements["ov-billing-start"].value === monthStart && elements["ov-billing-end"].value === ""
  && elements["ov-billing-open-ended"].checked === true,
  "订阅时不问起止：订阅日期默认组首日、上限今天，结束日留空＝持续有效");
ok(elements["ov-billing-subscription-anchor-text"].textContent.includes("每月 1 日扣款") && elements["ov-billing-subscription-anchor-text"].textContent.includes(monthStart + " 起（持续有效）"),
  "订阅日期旁写明扣款日与程序给出的适用范围（持续有效，不写「到今天为止」）");
elements["ov-billing-subscription-anchor"].value = "2999-01-01";
elements["ov-billing-subscription-anchor"].onchange();
await elements["ov-billing-save"].onclick();
ok(elements["ov-billing-preview"].textContent.includes("订阅日期不能晚于今天") && !billingCalls.some((c) => c.command === "billing_candidate_impact_preview"),
  "订阅日期晚于今天时前端直接拒绝，不发预览请求（G3）");
elements["ov-billing-subscription-anchor"].value = monthStart;
elements["ov-billing-subscription-anchor"].onchange();
await elements["ov-billing-save"].onclick();
ok(elements["ov-billing-preview"].textContent.includes("月费") && !billingCalls.some((c) => c.command === "billing_candidate_impact_preview"),
  "官方订阅未填月费也未勾选「金额暂不清楚」时不发预览");
elements["ov-billing-amount-unknown"].checked = true;
await elements["ov-billing-save"].onclick();
const previewCall = billingCalls.find((c) => c.command === "billing_candidate_impact_preview");
ok(previewCall && previewCall.args.effectiveStart === monthStart && previewCall.args.effectiveEnd === null && previewCall.args.relationshipKind === "official_subscription"
  && previewCall.args.scopes.length === 0 && !("windowStartMs" in previewCall.args),
  "预览参数 = 保存参数（执行环境/provider/关系/起止日期），不传统计月窗口（G2）；持续有效默认计费方级作用域、不写模型清单快照");
ok(elements["ov-billing-scope-row"].hidden === false && elements["ov-billing-scope-models"].checked === false
  && elements["ov-billing-scope-models-text"].textContent.includes("仅限这 2 个模型"),
  "「仅限这些模型」行可见、持续有效时默认不勾（新模型沿用声明）");
const previewText = elements["ov-billing-preview"].textContent;
ok(previewText.includes("预计从按量估算中移出") && previewText.includes("19.88") && previewText.includes("保持估算 18K")
  && previewText.includes("仍待确认 900") && previewText.includes("路由证据冲突"),
  "V2：预览展示移出 / 保持 / 仍待确认三组数字与分币金额（§5.5）");
ok(elements["ov-billing-save"].textContent === "确认并保存声明" && !billingCalls.some((c) => c.command === "save_billing_declaration_revision"),
  "预览后按钮变为「确认并保存声明」，尚未写入");
await elements["ov-billing-save"].onclick();
const saveCall = billingCalls.find((c) => c.command === "save_billing_declaration_revision");
ok(saveCall && saveCall.args.effectiveStart === monthStart && saveCall.args.effectiveEnd === null && saveCall.args.relationshipKind === "official_subscription"
  && saveCall.args.sourceCandidateId === "candidate-test" && saveCall.args.scopes.length === 0 && saveCall.args.amountMinor === null && saveCall.args.currency === null,
  "保存参数与预览一致（订阅持久有效，结束日发 null）；「金额暂不清楚」写空金额而不补挂牌价（AC09）");
ok(saveCall.args.evidenceRef.startsWith("legacy-import-candidate:") && !saveCall.args.evidenceRef.includes("auto:"),
  "手动确认的组不冒充程序判定（evidence_ref 无 auto:）");
ok(!billingCalls.some((c) => c.command === "enqueue_billing_recalculation"),
  "前端不再单独入队：入队由保存命令完成（G6）");
ok(billingCalls.some((c) => c.command === "billing_recalculation_job_status") && billingCalls.some((c) => c.command === "<renderOverview>"),
  "保存后轮询重算回执并刷新总览");
ok(vm.runInContext("sessState.loaded === false && findState.loaded === false && calendarLoadedMonth === null", sandbox),
  "重算完成后用量/会话/待处理缓存已作废（用户路径第 6 步）");
const receipt = elements["ov-billing-preview"];
ok(receipt.textContent.includes("声明已保存") && receipt.textContent.includes("重算已完成") && receipt.children.some((b) => b.textContent === "撤销"),
  "回执原位显示修订、范围与重算状态，并提供撤销");
await receipt.children.find((b) => b.textContent === "撤销").onclick();
ok(billingCalls.some((c) => c.command === "revoke_billing_declaration" && c.args.supersedesRevisionId === saveCall.args.revisionId),
  "撤销追加修订并 supersede 当前修订，不删历史");

// 服务商未知：先选服务商，再问路由，再问计费方式；保存同时写型号归属。
billingCalls.length = 0;
await reviewRows[3].children[1].children[0].onclick();
ok(elements["ov-billing-provider-row"].hidden === false && elements["ov-billing-route-row"].hidden === false
  && elements["ov-billing-missing"].textContent.includes("服务商、路由、计费方式"),
  "服务商未知的组：弹窗先问服务商，并列出缺失项");
elements["ov-billing-amount-unknown"].checked = false;
await elements["ov-billing-save"].onclick();
ok(elements["ov-billing-preview"].textContent.includes("先选择这批用量的服务商") && billingCalls.length === 0,
  "未选服务商时不发预览");
elements["ov-billing-provider"].value = "zhipu-glm";
elements["ov-billing-route"].value = "official";
elements["ov-billing-mode"].value = "api";
elements["ov-billing-mode"].onchange();
ok(elements["ov-billing-subscription-fields"].hidden === true && elements["ov-billing-relationship-effect"].textContent.includes("按官方价卡估算并计入按量费用"),
  "选官方 API 时不展示订阅字段，并说明按量估算计入按量费用（2026-09-16 三级口径，不再是「金额不变」）");
ok(elements["ov-billing-settlement-row"].hidden === false && elements["ov-billing-settlement-currency"].value === "CNY",
  "按量关系显示「结算币种」，zhipu-glm 默认 CNY");
await elements["ov-billing-save"].onclick();
const glmPreview = billingCalls.find((c) => c.command === "billing_candidate_impact_preview");
ok(glmPreview && glmPreview.args.providerId === "zhipu-glm" && glmPreview.args.relationshipKind === "official_api"
  && glmPreview.args.scopes.some((s) => s.scope_kind === "provider" && s.scope_value === "unresolved")
  && glmPreview.args.scopes.some((s) => s.scope_kind === "model" && s.scope_value === "glm-5"),
  "预览带用户选的服务商与 provider=unresolved 作用域（只命中 NULL-provider 事实）");
await elements["ov-billing-save"].onclick();
const routeCall = billingCalls.find((c) => c.command === "save_price_route");
ok(routeCall && routeCall.args.input.model_prefix === "glm-5" && routeCall.args.input.provider_id === "zhipu-glm" && routeCall.args.input.mode === "metered",
  "保存时同时写型号归属（下一轮同步归到该服务商）");
ok(billingCalls.some((c) => c.command === "billing_recalculation_job_status") && billingCalls.some((c) => c.command === "<renderOverview>"),
  "官方 API 也入队重算（写 user_declared 关掉待确认组；金额不变），完成后刷新各面");

// 仍不确定：两次点击只记录 30 天降级，不写声明、不写归属，组留在待处理。
billingCalls.length = 0;
await reviewRows[1].children[1].children[0].onclick();
ok(elements["ov-billing-route-row"].hidden === false, "路由证据缺失（missing）时问路由");
elements["ov-billing-route"].value = "unknown";
elements["ov-billing-route"].onchange();
ok(elements["ov-billing-mode-row"].hidden === true && elements["ov-billing-subscription-fields"].hidden === true,
  "选仍不确定后不再问计费方式");
await elements["ov-billing-save"].onclick();
ok(elements["ov-billing-preview"].textContent.includes("留在待处理列表，未创建计费声明") && elements["ov-billing-save"].textContent === "保持待确认并返回",
  "仍不确定：先展示影响，不创建声明（AC28）");
await elements["ov-billing-save"].onclick();
ok(!billingCalls.some((c) => ["save_billing_declaration_revision", "save_price_route"].includes(c.command)) && storage["agent-vitals-billing-review-deferred-at-ms"],
  "V4：仍不确定第二次点击只记录 30 天降级，无 save / 归属写入");
ok(elements["ov-billing-declaration-panel"].hidden === true && elements["ov-billing-backdrop"].hidden === true,
  "返回后弹窗与遮罩一起收起");
await reviewRows[0].children[1].children[0].onclick();
ok(elements["ov-billing-declaration-panel"].hidden === false && elements["ov-billing-backdrop"].hidden === false, "再次打开弹窗与遮罩");
elements["ov-billing-backdrop"].onclick();
ok(elements["ov-billing-declaration-panel"].hidden === true && elements["ov-billing-backdrop"].hidden === true,
  "点击半透明遮罩关闭弹窗");
billingOverride = null;

ok(js.includes("if (billingReviewOpen) renderRows();"),
  "异步读取完成后会补绘已提前展开的确认面板");
await sandbox.renderBillingRecalculationJobs({ status: "ok", jobs: [{
  job_id: "job-retry-test", declaration_id: "decl-test", revision_id: "rev-test",
  status: "failed", error_code: "interrupted", error_detail: "SqliteFailure(Error { code: Busy })",
}] });
const jobRow = elements["ov-billing-recalculation-list"].children[0];
ok(elements["ov-billing-recalculation-panel"].hidden === false &&
  jobRow.children[1].children[0].textContent === "重试重算" &&
  jobRow.children[0].textContent.includes("上次退出时中断") && !jobRow.children[0].textContent.includes("SqliteFailure"),
  "重算失败状态显示旧结果可用、error_code 人话与重试按钮，原始错误串不上卡面（§5.10）");

// ---- 三态确认列表（自动归因规格 §5.1；形状出处：
// crates/agent-vitals-billing/src/billing/billing_preview.rs::auto_verdict / clusters_of）----
// 后端带 `clusters` 时：程序判定 → 一键确认；差一问 → 选项在行内；需补充 → 弹窗。
// 模型折进 models[]，旧的逐模型行只在没有 clusters 的旧后端上出现。
const clusterModel = (model_id, tokens, session_count, group_id, amounts) => ({ model_id, tokens, session_count, group_id, estimated_amounts: amounts });
const clusterReport = { status: "ok", month, groups: [], clusters: [
  { cluster_id: "c-needs", harness: "claude-code", billing_party: null, model_vendor: null, provider_id: "<unknown>",
    evidence_basis: "missing", pricing_basis: "unavailable", effective_start: month, effective_end: month,
    auto_verdict: { model_vendor: null, gateway_named: false, route_state: "unknown", route_basis: "missing", billing_party: null,
      billing_mode: null, relationship_kind: null, plan: null, state: "needs_input", question: null, basis: [] },
    models: [clusterModel("mystery-9", 18_000, 1, "g-mystery", [])], group_ids: ["g-mystery"], tokens: 18_000, session_count: 1,
    unpriced_tokens: 18_000, estimated_amounts: [] },
  { cluster_id: "c-det", harness: "claude-code", billing_party: "anthropic", model_vendor: "anthropic", provider_id: "anthropic",
    evidence_basis: "session-native", pricing_basis: "route-observed", effective_start: month, effective_end: month,
    auto_verdict: { model_vendor: "anthropic", gateway_named: false, route_state: "official", route_basis: "session-native",
      billing_party: "anthropic", billing_mode: "subscription", relationship_kind: "official_subscription",
      plan: { label: "Claude Pro", channel: null, anchor_date: "2026-08-20", source: "~/.claude.json oauthAccount" },
      state: "determined", question: null, basis: ["route.session-native", "account.Claude Pro"] },
    models: [clusterModel("claude-opus-5", 3_000_000, 20, "g-opus", [{ amount_minor: 30000, currency: "USD", basis: "metered_estimate" }]),
      clusterModel("claude-sonnet-5", 1_700_000, 12, "g-sonnet", [{ amount_minor: 5000, currency: "USD", basis: "metered_estimate" }])],
    group_ids: ["g-opus", "g-sonnet"], tokens: 4_700_000, session_count: 32, unpriced_tokens: 0,
    estimated_amounts: [{ amount_minor: 35000, currency: "USD", basis: "metered_estimate" }] },
  { cluster_id: "c-route", harness: "claude-code", billing_party: "zhipu-glm", model_vendor: "zhipu-glm", provider_id: "<unknown>",
    evidence_basis: "inferred", pricing_basis: "metered_estimate", effective_start: month, effective_end: month,
    auto_verdict: { model_vendor: "zhipu-glm", gateway_named: false, route_state: "vendor_shape", route_basis: "inferred",
      billing_party: "zhipu-glm", billing_mode: "metered", relationship_kind: null, plan: null,
      state: "one_question", question: "route", basis: ["response_id.vendor_shape"] },
    models: [clusterModel("glm-5.3-flash", 640_000, 3, "g-glm", [])], group_ids: ["g-glm"], tokens: 640_000, session_count: 3,
    unpriced_tokens: 640_000, estimated_amounts: [] },
  { cluster_id: "c-mode", harness: "codex", billing_party: "openai", model_vendor: "openai", provider_id: "openai",
    evidence_basis: "session-native", pricing_basis: "metered_estimate", effective_start: month, effective_end: month,
    auto_verdict: { model_vendor: "openai", gateway_named: false, route_state: "provider_reported", route_basis: "session-native",
      billing_party: "openai", billing_mode: null, relationship_kind: null, plan: null,
      state: "one_question", question: "billing_mode", basis: ["harness.provider_reported"] },
    models: [clusterModel("gpt-5.6-sol", 1_650_000, 7, "g-sol", [{ amount_minor: 1892, currency: "USD", basis: "metered_estimate" }])],
    group_ids: ["g-sol"], tokens: 1_650_000, session_count: 7, unpriced_tokens: 0,
    estimated_amounts: [{ amount_minor: 1892, currency: "USD", basis: "metered_estimate" }] },
] };
// 后端同时返回逐模型 groups（旧消费方）与 clusters；带 clusters 时前端按簇渲染、按簇计数。
clusterReport.groups = clusterReport.clusters.flatMap((c) => c.models.map((m) => ({
  group_id: m.group_id, harness: c.harness, provider_id: c.provider_id, model_id: m.model_id, evidence_basis: c.evidence_basis,
  pricing_basis: c.pricing_basis, tokens: m.tokens, session_count: m.session_count, effective_start: c.effective_start,
  effective_end: c.effective_end, estimated_amounts: m.estimated_amounts, unpriced_tokens: 0, unresolved_reason: null,
  first_event_at_ms: 1, last_event_at_ms: 2, auto_verdict: c.auto_verdict })));
// 后端 clusters_of 已把 determined 排前；前端按后端顺序渲染，不自行重排（这里故意把 needs_input 放首位来证明这一点）。
billingOverride = async (command, args) => {
  billingCalls.push({ command, args });
  if (command === "billing_candidate_impact_preview") return previewFixture(args);
  if (command === "save_billing_declaration_revision") {
    return { status: "saved", revision_id: args.revisionId, declaration_id: args.declarationId, changed: true,
      job: { job_id: "billing-" + args.revisionId, status: "queued", changed: true } };
  }
  if (command === "billing_recalculation_job_status") return { status: "succeeded", job_id: args.jobId };
  return undefined;
};
billingCalls.length = 0;
await sandbox.renderBillingConfirmation(clusterReport, { status: "ok", candidates: [] });
if (elements["ov-billing-review-panel"].hidden) await elements["ov-billing-review"].onclick();
const clusterRows = elements["ov-billing-review-list"].children;
ok(clusterRows.length === 4, "带 clusters 时按簇渲染四行，模型折进簇内而不是逐模型一行");
ok(/发现 4 组/.test(elements["ov-billing-prompt-copy"].textContent), "入口提示按簇计数（5 个模型折成 4 件事）");
const rowText = (i) => clusterRows[i].children[0].textContent;
const rowBasis = (i) => clusterRows[i].children[0].children.map((c) => c.textContent).join("|");
const rowButtons2 = (i) => clusterRows[i].children[1].children.map((b) => b.textContent);
ok(rowText(1).includes("anthropic") && rowText(1).includes("Claude Pro 订阅 · 每月 20 日续费") && rowText(1).includes("2 个模型（claude-opus-5、claude-sonnet-5）")
  && rowBasis(1).includes("程序判定，依据：请求 ID 为官方格式 · 账户套餐 Claude Pro"),
  "程序判定行：写明计费方、套餐、续费日、折叠的模型数与判定依据");
ok(rowButtons2(1).join("|") === "确认订阅并填写月费|不对，我来改", "程序判定行只剩一键确认与「不对，我来改」");
ok(rowButtons2(2).join("|") === "zhipu-glm 官方端点|中转 / 第三方" && rowBasis(2).includes("已知：响应 ID 与厂商形状一致"),
  "差一问（路由）：问题的两个选项直接放在行内");
ok(rowButtons2(3).join("|") === "订阅|按量 API|组织承担" && rowText(3).includes("执行环境自报官方"),
  "差一问（计费方式）：三个选项直接放在行内");
ok(rowButtons2(0).join("|") === "明确计费方式" && rowText(0).includes("服务商未知") && rowBasis(0).includes("缺少证据"),
  "需补充：仍是一个「明确计费方式」入口");

// 一键确认：弹窗不再问服务商与路由，计费方式预选订阅，套餐名预填，依据写在说明里。
await clusterRows[1].children[1].children[0].onclick();
ok(elements["ov-billing-declaration-panel"].hidden === false && elements["ov-billing-provider-row"].hidden === true
  && elements["ov-billing-route-row"].hidden === true && elements["ov-billing-mode-row"].hidden === false
  && elements["ov-billing-mode"].value === "subscription" && elements["ov-billing-subscription-fields"].hidden === false,
  "程序判定 → 确认：只剩订阅确认，服务商/路由步骤不出现");
ok(elements["ov-billing-subscription-name"].value === "Claude Pro"
  && elements["ov-billing-missing"].textContent.includes("程序已判定：服务商 anthropic · 官方路由 · Claude Pro（每月 20 日续费，订阅自 2026-08-20）"),
  "套餐名预填，说明栏写明程序判定内容与依据");
ok(elements["ov-billing-batch-row"].hidden === false && /将同时处理 2 个模型、32 个会话、4\.7M tokens/.test(elements["ov-billing-batch-text"].textContent),
  "簇内多个模型默认作为一批处理");
ok(elements["ov-billing-dates-row"].hidden === true && elements["ov-billing-subscription-anchor"].value === "2026-08-20"
  && elements["ov-billing-start"].value === "2026-08-20" && elements["ov-billing-end"].value === ""
  && elements["ov-billing-open-ended"].checked === true
  && elements["ov-billing-subscription-anchor-text"].textContent.includes("每月 20 日扣款"),
  "订阅日期预填账户证据的订阅开始日（早于本月也行），适用范围从该日起且持续有效");
elements["ov-billing-subscription-amount"].value = "20";
elements["ov-billing-subscription-currency"].value = "USD";
billingCalls.length = 0;
await elements["ov-billing-save"].onclick();
await elements["ov-billing-save"].onclick();
const autoSave = billingCalls.find((c) => c.command === "save_billing_declaration_revision");
ok(autoSave && autoSave.args.evidenceRef === "auto:route.session-native+account.Claude Pro;confirmation-group:g-opus,g-sonnet"
  && autoSave.args.effectiveStart === "2026-08-20" && autoSave.args.effectiveEnd === null
  && autoSave.args.providerId === "anthropic" && autoSave.args.relationshipKind === "official_subscription"
  && autoSave.args.subscriptionName === "Claude Pro" && autoSave.args.amountMinor === 2000 && autoSave.args.currency === "USD"
  && autoSave.args.scopes.length === 0,
  "一键确认写声明：evidence_ref=auto:<依据>，范围 = 订阅日起（持续有效）；套餐/月费；计费方级作用域（无模型快照、无 provider:unresolved）");
elements["ov-billing-close"].onclick();
// 「不对，我来改」：所有步骤重新放出来。
await clusterRows[1].children[1].children[1].onclick();
ok(elements["ov-billing-provider-row"].hidden === false && elements["ov-billing-route-row"].hidden === false,
  "「不对，我来改」把服务商与路由步骤重新放出来");
elements["ov-billing-close"].onclick();
// 差一问（路由）→ 官方端点：服务商/路由/计费方式按答案预填（provider 步骤仍在——声明 scope 必须带 provider:unresolved 才能命中 provider_id 为空的事实）。
await clusterRows[2].children[1].children[0].onclick();
ok(elements["ov-billing-provider"].value === "zhipu-glm" && elements["ov-billing-route"].value === "official" && elements["ov-billing-mode"].value === "api",
  "回答「官方端点」后表单按答案预填：服务商 zhipu-glm、官方路由、按量 API");
elements["ov-billing-close"].onclick();
await clusterRows[2].children[1].children[1].onclick();
ok(elements["ov-billing-route"].value === "third_party" && elements["ov-billing-mode-row"].hidden === true,
  "回答「中转 / 第三方」后路由预填第三方，计费方式步骤不再出现");
elements["ov-billing-close"].onclick();
// 差一问（计费方式）→ 按量 API：服务商/路由已知不再问。
await clusterRows[3].children[1].children[1].onclick();
ok(elements["ov-billing-provider-row"].hidden === true && elements["ov-billing-route-row"].hidden === true
  && elements["ov-billing-mode"].value === "api" && elements["ov-billing-subscription-fields"].hidden === true,
  "回答「按量 API」后只剩确认，订阅字段不出现");
elements["ov-billing-close"].onclick();

// 验收审查 iteration 3 的修复（#1/#2/#5/#6）：
// #1 冲突证据单列：不归因、不给一键订阅。
billingCalls.length = 0;
const conflictReport = { status: "ok", month, clusters: [{
  cluster_id: "c-conflict", harness: "codex", billing_party: null, model_vendor: "openai", provider_id: "openai",
  evidence_basis: "conflict", pricing_basis: "metered_estimate", effective_start: month, effective_end: month,
  auto_verdict: { model_vendor: "openai", gateway_named: false, route_state: "conflict", route_basis: "conflict",
    billing_party: null, billing_mode: null, relationship_kind: null, plan: null,
    state: "needs_input", question: null, basis: ["route.conflict"] },
  models: [clusterModel("gpt-5.6-sol", 1000, 1, "g-conflict", [])], group_ids: ["g-conflict"],
  tokens: 1000, session_count: 1, unpriced_tokens: 0, estimated_amounts: [] }], groups: [
  { group_id: "g-conflict", harness: "codex", provider_id: "openai", model_id: "gpt-5.6-sol", evidence_basis: "conflict",
    pricing_basis: "metered_estimate", tokens: 1000, session_count: 1, effective_start: month, effective_end: month,
    estimated_amounts: [], unpriced_tokens: 0, unresolved_reason: null, first_event_at_ms: 1, last_event_at_ms: 2 }] };
await sandbox.renderBillingConfirmation(conflictReport, { status: "ok", candidates: [] });
if (elements["ov-billing-review-panel"].hidden) await elements["ov-billing-review"].onclick();
const conflictRow = elements["ov-billing-review-list"].children[0];
ok(conflictRow.children[0].textContent.includes("路由证据冲突") && conflictRow.children[1].children.length === 1
  && conflictRow.children[1].children[0].textContent === "明确计费方式",
  "#1：证据冲突的行既不归因也不给一键订阅，只留「明确计费方式」");
ok(conflictRow.children[0].children.map((c) => c.textContent).join("|").includes("执行环境自报与会话路由证据冲突"),
  "#1：冲突行的依据写清是执行环境自报与会话路由证据打架");

// #2 + #6：钉在有用量组上的旧资产候选跟着折进簇行，且不吞掉 auto: 依据链。
billingCalls.length = 0;
const candidateReport = JSON.parse(JSON.stringify(clusterReport));
await sandbox.renderBillingConfirmation(candidateReport, { status: "ok", candidates: [{ candidate_id: "cand-cluster",
  harness: "claude-code", provider_id: "anthropic", amount_minor: 2000, currency: "USD",
  billing_period_start: "2026-06-01", status: "pending" }] });
const detRow = elements["ov-billing-review-list"].children[1];
const candLine = detRow.children[0].children.find((c) => c.textContent.includes("来自旧版本套餐记录"));
ok(candLine && candLine.children.some((b) => b.textContent === "这不是我的套餐"),
  "#2：候选的证据行与「这不是我的套餐」跟着折进簇行，不再被逐模型行一起跳过");
const clusterRows2 = elements["ov-billing-review-list"].children;
ok(clusterRows2.length === 4, "#2：候选不再额外占一行");
await candLine.children.find((b) => b.textContent === "这不是我的套餐").onclick();
ok(billingCalls.some((c) => c.command === "resolve_billing_import_candidate" && c.args.decision === "dismiss"),
  "#2：簇行里的「这不是我的套餐」真的写入忽略决定");
// #5：离开订阅时撤销程序写进去的锚点。
await clusterRows2[1].children[1].children[0].onclick();
ok(elements["ov-billing-start"].value === "2026-08-20" && elements["ov-billing-dates-row"].hidden === true,
  "#5：订阅态把 anchor 写进起始日（2026-08-20）");
elements["ov-billing-mode"].value = "api";
elements["ov-billing-mode"].onchange();
ok(elements["ov-billing-dates-row"].hidden === false && elements["ov-billing-start"].value === monthStart
  && elements["ov-billing-end"].value === today,
  "#5：切到按量 API 时起始日撤回组自己的首日，锚点不会写进按量声明");
// 订阅态会把「持续有效」勾上（订阅是持续关系），离开订阅必须一并撤回——否则按量声明的
// 结束日被静默留空，等于用户没选就得到一条开放期声明（2026-09-16 加订阅分支时守卫抓到）。
ok(elements["ov-billing-open-ended"].checked === false && elements["ov-billing-end"].value !== ""
  && elements["ov-billing-end"].disabled === false,
  "#5：离开订阅时「持续有效」一并撤回，按量声明不会静默变成开放期");
billingCalls.length = 0;
await elements["ov-billing-save"].onclick();
await elements["ov-billing-save"].onclick();
const refCall = billingCalls.find((c) => c.command === "save_billing_declaration_revision");

ok(refCall && refCall.args.evidenceRef === "auto:route.session-native+account.Claude Pro;legacy-import-candidate:cand-cluster",
  "#6：程序判定 + 旧候选同时存在时，auto: 依据链与候选 id 都保留");
elements["ov-billing-close"].onclick();

// 2026-09-16 真机：anthropic 订阅早已声明（候选 accepted），新会话又进了待确认；弹窗把同一张
// accepted 候选当 sourceCandidateId 一起保存 → `UNIQUE constraint failed:
// billing_declarations.source_candidate_id`。accepted 候选不得再挂到组上，只作
// 「已作为计费声明的依据」独立行。
billingCalls.length = 0;
const acceptedReport = JSON.parse(JSON.stringify(clusterReport));
await sandbox.renderBillingConfirmation(acceptedReport, { status: "ok", candidates: [{ candidate_id: "cand-accepted",
  harness: "claude-code", provider_id: "anthropic", amount_minor: 2000, currency: "USD",
  billing_period_start: "2026-06-01", status: "accepted" }] });
if (elements["ov-billing-review-panel"].hidden) await elements["ov-billing-review"].onclick();
const acceptedRows = elements["ov-billing-review-list"].children;
ok(!acceptedRows[1].children[0].children.some((c) => c.textContent.includes("来自旧版本套餐记录")),
  "accepted 候选不再折进有用量的簇行");
ok(!Array.from(acceptedRows).some((row) => row.children[0] && row.children[0].textContent.includes("cand-accepted"))
  && acceptedRows.length === 4,
  "accepted 候选不再在「待明确」里占行（它是某条有效声明的依据，由声明行带出）");
await acceptedRows[1].children[1].children[0].onclick();
// 没有候选预填月费，订阅表单要么填金额要么勾「金额暂不清楚」才放行保存。
elements["ov-billing-subscription-amount"].value = "20";
elements["ov-billing-subscription-currency"].value = "USD";
await elements["ov-billing-save"].onclick();
await elements["ov-billing-save"].onclick();
const acceptedSave = billingCalls.find((c) => c.command === "save_billing_declaration_revision");
ok(acceptedSave && acceptedSave.args.sourceCandidateId === null
  && !String(acceptedSave.args.evidenceRef).includes("cand-accepted"),
  "从簇行保存的声明不带 accepted 候选的 id（否则 UNIQUE(source_candidate_id) 必炸）");
elements["ov-billing-close"].onclick();

// A12 端点/配置证据：claude-code 的日志不记端点，配置记（ANTHROPIC_BASE_URL）。基址不是
// 该厂商官方端点时，行面写清"配置指向哪"，并把 L3 的那一问变成一次确认（形状出处：
// billing_preview.rs::auto_verdict 的 relay_config 分支 + relay_label_of）。
billingCalls.length = 0;
const relayReport = { status: "ok", month, clusters: [{
  cluster_id: "c-relay", harness: "claude-code", billing_party: "shengsuanyun.com", model_vendor: "deepseek",
  provider_id: "<unknown>", evidence_basis: "inferred", pricing_basis: "metered_estimate",
  effective_start: month, effective_end: month,
  auto_verdict: { model_vendor: "deepseek", gateway_named: false, route_state: "relay_config", route_basis: "inferred",
    billing_party: "shengsuanyun.com", config_endpoint: "router.shengsuanyun.com",
    config_source: "~/.claude/settings.json env", billing_mode: "metered",
    relationship_kind: null, plan: null, state: "one_question", question: "route", basis: ["config.endpoint"] },
  models: [clusterModel("deepseek-v4-flash", 856_000_000, 35, "g-relay", [])], group_ids: ["g-relay"],
  tokens: 856_000_000, session_count: 35, unpriced_tokens: 856_000_000, estimated_amounts: [] }],
  groups: [{ group_id: "g-relay", harness: "claude-code", provider_id: "<unknown>", model_id: "deepseek-v4-flash",
    evidence_basis: "inferred", pricing_basis: "metered_estimate", tokens: 856_000_000, session_count: 35,
    effective_start: month, effective_end: month, estimated_amounts: [], unpriced_tokens: 856_000_000,
    unresolved_reason: "billing-route-unknown", first_event_at_ms: 1, last_event_at_ms: 2 }] };
await sandbox.renderBillingConfirmation(relayReport, { status: "ok", candidates: [] });
if (elements["ov-billing-review-panel"].hidden) await elements["ov-billing-review"].onclick();
const relayRow = elements["ov-billing-review-list"].children[0];
ok(relayRow.children[0].textContent.includes("配置 ~/.claude/settings.json env → router.shengsuanyun.com")
  && relayRow.children[1].children.map((b) => b.textContent).join("|") === "deepseek 官方端点（不对，走的是官方）|确认经中转（shengsuanyun.com）",
  "A12：配置指向中转时行面写清端点，主操作变成一次确认而不是开放提问");
await relayRow.children[1].children[1].onclick();
ok(elements["ov-billing-provider"].value === "shengsuanyun.com" && elements["ov-billing-route"].value === "third_party"
  && elements["ov-billing-subscription-fields"].hidden === true,
  "A12：确认经中转时预填中转名与第三方路由，且不按订阅展开");
ok(elements["ov-billing-missing"].textContent.includes("待补充：服务商、路由、计费方式"),
  "A12：config-current 只是证据，仍要求用户确认（不冒充已判定）");
await elements["ov-billing-save"].onclick();
const relayPreview = billingCalls.find((c) => c.command === "billing_candidate_impact_preview");
ok(relayPreview && relayPreview.args.relationshipKind === "third_party"
  && relayPreview.args.scopes.some((s) => s.scope_kind === "provider" && s.scope_value === "unresolved"),
  "A12：第三方关系仍带 provider:unresolved 作用域（这批事实的 provider_id 是 NULL）");
// 结算币种跟计费方走：shengsuanyun.com 是国内中转 → 默认 CNY；保存时作为 currency 传、无月费。
ok(elements["ov-billing-settlement-currency"].value === "CNY", "中转 shengsuanyun.com 的结算币种默认 CNY");
await elements["ov-billing-save"].onclick();
const relaySave = billingCalls.find((c) => c.command === "save_billing_declaration_revision");
ok(relaySave && relaySave.args.currency === null && relaySave.args.amountMinor === null
  && relaySave.args.scopes.some((s) => s.scope_kind === "settlement" && s.scope_value === "CNY"),
  "第三方声明保存时带结算币种（scope settlement=CNY；月费与币种列保持成对为空）");
elements["ov-billing-close"].onclick();

// 验收审查 iteration 7 #3：配置里多个端点时判定器**不点名**，UI 也不许拿"第一个端点"顶上
// ——按钮文案只说"中转 / 第三方"，点开不预填任何人（否则一键确认会写下没人判过的字符串）。
billingCalls.length = 0;
const ambiguousReport = { status: "ok", month, clusters: [{
  cluster_id: "c-multi", harness: "workbuddy", billing_party: null, model_vendor: "deepseek", provider_id: "<unknown>",
  evidence_basis: "inferred", pricing_basis: "metered_estimate", effective_start: month, effective_end: month,
  auto_verdict: { model_vendor: "deepseek", gateway_named: false, route_state: "relay_config", route_basis: "inferred",
    billing_party: null, config_endpoint: "alpha-relay.example", config_source: "~/.workbuddy/models.json",
    billing_mode: "metered", relationship_kind: null, plan: null, state: "one_question", question: "route",
    basis: ["config.endpoint.multiple"] },
  models: [clusterModel("deepseek-v4-flash", 1000, 1, "g-multi", [])], group_ids: ["g-multi"],
  tokens: 1000, session_count: 1, unpriced_tokens: 1000, estimated_amounts: [] }],
  groups: [{ group_id: "g-multi", harness: "workbuddy", provider_id: "<unknown>", model_id: "deepseek-v4-flash",
    evidence_basis: "inferred", pricing_basis: "metered_estimate", tokens: 1000, session_count: 1,
    effective_start: month, effective_end: month, estimated_amounts: [], unpriced_tokens: 1000,
    unresolved_reason: "billing-route-unknown", first_event_at_ms: 1, last_event_at_ms: 2 }] };
await sandbox.renderBillingConfirmation(ambiguousReport, { status: "ok", candidates: [] });
if (elements["ov-billing-review-panel"].hidden) await elements["ov-billing-review"].onclick();
const multiRow = elements["ov-billing-review-list"].children[0];
ok(multiRow.children[1].children[1].textContent === "中转 / 第三方"
  && multiRow.children[0].textContent.includes("配置 ~/.workbuddy/models.json → alpha-relay.example"),
  "#3：多个端点时按钮不点名、行面只说配置文件与端点（不替判定器挑一个）");
await multiRow.children[1].children[1].onclick();
ok(elements["ov-billing-provider"].value === "",
  "#3：不预填「第一个端点」——判定器没点名的字符串不许进声明");
elements["ov-billing-close"].onclick();

// 复验 iteration 4 的回归守卫：**没有账户锚点**的组切到按量后，手改的结束日期不能被
// 后续 restep 抹掉。旧实现按「值相等」判撤回，而这类组的 anchor 只是组首日的副本，
// 于是每次 restep 都把结束日期打回默认（复验者在真实 workbench.js 上复现过）。
billingCalls.length = 0;
const noAnchorReport = { status: "ok", month, clusters: [{
  cluster_id: "c-noanchor", harness: "claude-code", billing_party: "anthropic", model_vendor: "anthropic",
  provider_id: "anthropic", evidence_basis: "session-native", pricing_basis: "route-observed",
  effective_start: month, effective_end: month,
  auto_verdict: { model_vendor: "anthropic", gateway_named: false, route_state: "official", route_basis: "session-native",
    billing_party: "anthropic", billing_mode: null, relationship_kind: null, plan: null,
    state: "one_question", question: "billing_mode", basis: ["route.session-native"] },
  models: [clusterModel("claude-opus-5", 1000, 1, "g-noanchor", [])], group_ids: ["g-noanchor"],
  tokens: 1000, session_count: 1, unpriced_tokens: 0, estimated_amounts: [] }],
  groups: [{ group_id: "g-noanchor", harness: "claude-code", provider_id: "anthropic", model_id: "claude-opus-5",
    evidence_basis: "session-native", pricing_basis: "route-observed", tokens: 1000, session_count: 1,
    effective_start: month, effective_end: month, estimated_amounts: [], unpriced_tokens: 0,
    unresolved_reason: null, first_event_at_ms: 1, last_event_at_ms: 2, auto_verdict: null }] };
await sandbox.renderBillingConfirmation(noAnchorReport, { status: "ok", candidates: [] });
if (elements["ov-billing-review-panel"].hidden) await elements["ov-billing-review"].onclick();
await elements["ov-billing-review-list"].children[0].children[1].children[0].onclick();
elements["ov-billing-mode"].value = "api";
elements["ov-billing-mode"].onchange();
ok(elements["ov-billing-dates-row"].hidden === false && elements["ov-billing-start"].value === monthStart,
  "无锚点组切到按量后仍可用起止日期（起始日 = 组首日）");
// 起止是**一对**约束：只封顶结束，选择器就能拼出"永远不成立"的区间（起始晚于今天 →
// 在结束 ≤ 今天的前提下无法满足结束 ≥ 起始；结束早于起始 → 保存时才报错）。
ok(elements["ov-billing-start"].max === today && elements["ov-billing-end"].max === today
  && elements["ov-billing-end"].min === elements["ov-billing-start"].value,
  "起始与结束都封顶今天，结束以起始为下界（选择器里拼不出非法区间）");
elements["ov-billing-end"].value = "2026-09-10";
elements["ov-billing-end"].onchange();
elements["ov-billing-start"].value = "2026-09-15";
elements["ov-billing-start"].onchange();
ok(elements["ov-billing-end"].min === "2026-09-15" && elements["ov-billing-end"].value === "2026-09-15",
  "起始改到结束之后：结束被抬到起始、下界同步，不留下已非法的区间");
elements["ov-billing-start"].value = monthStart;
elements["ov-billing-start"].onchange();
elements["ov-billing-end"].value = "2026-09-10";
elements["ov-billing-end"].onchange();
elements["ov-billing-batch"].onchange();
ok(elements["ov-billing-end"].value === "2026-09-10" && elements["ov-billing-start"].value === monthStart,
  "手改的结束日期经 restep 后仍在：撤回只针对程序写入的账户锚点（复验 iteration 4 #1）");

// 结束是**选填**的：「持续有效」勾选框是不设结束日期的**唯一**入口——原生
// `<input type="date">` 根本没有"未设置"这个状态（点开日历弹窗选不出空，清空只能全选
// 删除），用户看到「选填」却做不到（2026-09-16 真机复验）。勾选后字段必须为空且禁用，
// 且经 restep 不能被填回一个日期。
ok(elements["ov-billing-end"].value !== "" && elements["ov-billing-open-ended"].checked === false
  && elements["ov-billing-end"].disabled === false,
  "默认不勾「持续有效」：结束日期有值可改（保持有界）");
elements["ov-billing-open-ended"].checked = true;
elements["ov-billing-open-ended"].onchange();
ok(elements["ov-billing-end"].value === "" && elements["ov-billing-end"].disabled === true
  && elements["ov-billing-scope-text"].textContent.includes("持续有效"),
  "勾「持续有效」＝不设结束日期：字段清空并禁用，作用范围照实说「持续有效」");
elements["ov-billing-start"].value = "2026-08-20";
elements["ov-billing-start"].onchange();
elements["ov-billing-batch"].onchange();
ok(elements["ov-billing-end"].value === "" && elements["ov-billing-open-ended"].checked === true,
  "勾选经起始改动与 restep 后仍在（持续有效不会被填回一个日期）");
billingCalls.length = 0;
await elements["ov-billing-save"].onclick();
const openPreview = billingCalls.find((c) => c.command === "billing_candidate_impact_preview");
ok(openPreview && openPreview.args.effectiveEnd === null,
  "持续有效的影响预览发 effectiveEnd=null（预览范围 = 写入范围）");
await elements["ov-billing-save"].onclick();
const openCall = billingCalls.find((c) => c.command === "save_billing_declaration_revision");
ok(openCall && openCall.args.effectiveEnd === null && openCall.args.effectiveStart === "2026-08-20",
  "持续有效保存写 null 而不是空串：声明开放到未来");
elements["ov-billing-close"].onclick();
billingOverride = null;

// B13 修改订阅：当前计费声明面板上，订阅声明可以追加 supersede 修订（改价/退订），
// 不再要求"撤销后重新确认"。断言四件事：入口只在订阅声明上出现；修订沿用原
// declaration_id 并 supersede 当前修订；**作用域原样带回**（丢了会把声明范围悄悄放宽
// 成该服务商全部模型）；退订＝取消「持续有效」+ 结束日，effectiveStart 沿用原起点。
billingOverride = async (command, args) => {
  billingCalls.push({ command, args });
  if (command === "save_billing_declaration_revision") {
    return { status: "saved", revision_id: args.revisionId, declaration_id: args.declarationId,
      changed: true, job: { job_id: "billing-" + args.revisionId, status: "queued", changed: true } };
  }
  return undefined;
};
await sandbox.renderBillingDeclarations({ status: "ok", declarations: [
  { declaration_id: "decl-mini", harness: "claude-code", provider_id: "minimax",
    relationship_kind: "official_subscription", subscription_name: "MiniMax",
    amount_minor: 4400, currency: "CNY", effective_start: "2026-06-01", effective_end: null,
    source_candidate_id: null, current_revision_id: "rev-mini-1",
    scopes: [{ scope_kind: "model", scope_value: "MiniMax-M3" }, { scope_kind: "model", scope_value: "MiniMax-M2.7" }] },
  { declaration_id: "decl-api", harness: "claude-code", provider_id: "anthropic",
    relationship_kind: "official_api", subscription_name: null,
    amount_minor: null, currency: null, effective_start: "2026-06-01", effective_end: null,
    source_candidate_id: null, current_revision_id: "rev-api-1", scopes: [] },
] });
const declRows = elements["ov-billing-declarations-list"].children;
const miniActions = declRows[0].children[1];
const apiActions = declRows[1].children[1];
ok(miniActions.children.some((b) => b.textContent === "修改订阅")
  && !apiActions.children.some((b) => b.textContent === "修改订阅"),
  "「修改订阅」只出现在订阅声明上（按量/组织/中转没有可改的金额面）");
billingCalls.length = 0;
await miniActions.children.find((b) => b.textContent === "修改订阅").onclick();
const amendForm = declRows[0].children[2];
ok(amendForm && amendForm.children.length === 3, "点「修改订阅」展开内联修订表单");
const amendFields = amendForm.children[1].children;   // [套餐名, 月费, 币种, 金额暂不清楚, 结束日, 持续有效]
amendFields[1].children[1].value = "49";              // 月费 44 → 49
const openEndedBox = amendFields[5].children[0];
openEndedBox.checked = false;                         // 取消「持续有效」＝退订
openEndedBox.onchange();
amendFields[4].children[1].value = "2026-09-10";      // 结束日
const amendSave = amendForm.children[2].children[0];
await amendSave.onclick();
const amendCall = billingCalls.find((c) => c.command === "save_billing_declaration_revision");
ok(amendCall && amendCall.args.declarationId === "decl-mini"
  && amendCall.args.supersedesRevisionId === "rev-mini-1",
  "修订沿用原 declaration_id 并 supersede 当前修订（不是撤销重申）");
ok(amendCall && amendCall.args.effectiveStart === "2026-06-01" && amendCall.args.effectiveEnd === "2026-09-10",
  "改价/退订修订沿用原起点（覆盖不断档），结束日按表单");
ok(amendCall && amendCall.args.amountMinor === 4900 && amendCall.args.scopes.length === 2
  && amendCall.args.scopes.every((s) => s.scope_kind === "model"),
  "新金额与**原样带回的作用域**一起保存（不放宽成全部模型）");
ok(billingCalls.some((c) => c.command === "<renderOverview>"),
  "保存修订后刷新总览（月费当月生效）");
billingOverride = null;

console.log(failed ? `\n${failed} FAIL` : "\n全部通过。");
process.exit(failed ? 1 : 0);
