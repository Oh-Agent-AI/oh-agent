// 工作台主窗口前端：三页 总览 / Token 日历 / 会话（列表+详情）。
// 纯 HTML/CSS/JS，开发时由 Vite 提供 HMR —— `withGlobalTauri: true` 让全局 `window.__TAURI__`
// 可用。数据只来自后端命令（read_overview / read_calendar_month /
// read_hourly_distribution / sessions_list / sessions_read），任何金额/覆盖率都不在本文件计算——core 算好、这里格式化展示
// （CLAUDE.md 的 cost 教训：前端不许长第二份定价）。
"use strict";

const { invoke } = window.__TAURI__.core;
// 事件桥（fold 完成事件，见下方「事件桥」一节）从同一套全局 API 取 listen。
const { listen } = window.__TAURI__.event;
const notificationApi = window.__TAURI__.notification;

// 系统预算提醒只允许跳回预算页；通知正文不承载路径、原始日志或敏感金额。
async function subscribeBudgetNotificationActions() {
  if (!notificationApi || !notificationApi.onAction) return;
  try {
    await notificationApi.registerActionTypes([{
      id: "budget-alert",
      actions: [{ id: "open-budget", title: "查看预算" }],
    }]);
    await notificationApi.onAction((notification) => {
      if (notification && notification.actionTypeId === "budget-alert") {
        invoke("focus_budget_from_notification").catch((e) => {
          console.warn("[workbench] 预算提醒跳转失败", e);
        });
      }
    });
  } catch (e) {
    console.warn("[workbench] 系统预算提醒 action 不可用", e);
  }
}

// ---------- 格式化（与弹窗 main.js / 托盘 lib.rs 同 spec，不许各报各的格式） ----------

// 金额 → ¥600 / ¥774.7 / ¥6.73（≥100 一位小数、否则两位、去尾零）。
function fmtMoney(x) {
  const s = x >= 100 ? x.toFixed(1) : x.toFixed(2);
  return "¥" + s.replace(/0+$/, "").replace(/\.$/, "");
}

// 会话成本是 cost_usd（标 USD，与 payload 的 CNY 各标各的，v1 不换算）。
function fmtUSD(x) {
  if (x == null || Number.isNaN(x)) return "—";
  return "$" + x.toFixed(2);
}

// v0.9.1 起 cost 列输入是 `cost_minor: {amount_minor, currency} | null`（spec §0.1：
// 金额一律 i64 minor units 整数，存储层无浮点）。null → "—"（不冒充 ¥0.00）；
// 命中 → currency 走 USD/CNY 各自显示，amount_minor / 100 得元，浮点只在这一步
// 出 renderer——存储与 IPC 全程整数。
function fmtCostMinor(cm) {
  if (cm == null) return "—";
  const minor = cm.amount_minor;
  const cur = cm.currency;
  if (typeof minor !== "number" || !cur) return "—";
  const yuan = minor / 100;
  if (cur === "USD") return fmtUSD(yuan);
  if (cur === "CNY") return fmtMoney(yuan);
  // 未知币种：显示币种代码 + 元值（避免被 fmtUSD/fmtMoney 之一误标）
  return cur + " " + yuan.toFixed(2);
}

// 成本为空时必须把原因展示出来：订阅 token 不是逐 token 账单，缺价卡/价卡
// 快照也不等于免费。cost_status 来自 SQL authority 的统一会话投影。
function fmtCostStatus(status) {
  if (!status) return "成本不可用 · 未知原因";
  const labels = {
    subscription: "订阅用量 · 无逐 token 账单",
    unpriced: "未计价 · 无原厂价格卡",
    unavailable: "成本不可用",
    estimated: "按量估算",
  };
  const reasons = {
    "no-usage-facts": "没有用量事实",
    "no-pricing-snapshot": "没有覆盖事件时间的价格快照",
    "no-price-card": "没有匹配的原厂价格卡",
    "multiple-provider-costs-require-breakdown": "多个 provider，需分桶查看",
    "subscription-token-usage-is-not-a-per-token-bill": "订阅 token 不产生逐 token 账单",
    "cost-query-failed": "成本查询失败",
  };
  const state = labels[status.state] || "成本不可用";
  const reason = reasons[status.reason] || status.reason || "未知原因";
  return state + " · " + reason;
}

function fmtSessionCost(session) {
  if (session && session.cost_minor != null) {
    return fmtCostMinor(session.cost_minor) + (session.cost_minor.basis === "metered_estimate" ? " · 估算" : "");
  }
  return fmtCostStatus(session && session.cost_status);
}

// token 缩写：≥1M "1.4M"、≥1K "8.2K"（<10K 一位小数）、<1K 原样 —— 镜像 lib.rs::fmt_tokens。
function fmtTokens(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) {
    const k = n / 1e3;
    return (k < 10 ? k.toFixed(1) : Math.round(k).toString()) + "K";
  }
  return String(n);
}

function fmtPct(x) {
  return Math.round(x * 100) + "%";
}

// 统计时区今天 → "YYYY-MM-DD"；供应商价格策略时区不由这个 UI 日期 helper 推断。
function systemTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// 统计窗口使用后端持久化的用户选择；系统时区只作为配置不可读时的安全回退。
let configuredStatisticsTimezone = systemTimezone();

async function loadStatisticsTimezonePreference() {
  try {
    const config = await invoke("statistics_timezone_config");
    if (config && config.status === "ok") {
      const timezone = String(config.timezone || config.system_timezone || "").trim();
      if (timezone) {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
        configuredStatisticsTimezone = timezone;
      }
    }
  } catch (e) {
    console.warn("[workbench] 统计时区读取失败，使用系统时区", e);
  }
}

function statisticsTimezoneName() {
  return configuredStatisticsTimezone;
}

function formatStatisticsDateTime(value, options) {
  if (value == null || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: statisticsTimezoneName(),
    ...options,
  }).format(date);
}

function systemToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: statisticsTimezoneName(), year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function statisticsToday() {
  return systemToday();
}

function statisticsMonth() {
  return statisticsToday().slice(0, 7);
}

function shiftStatisticsDate(days) {
  const d = new Date(statisticsToday() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- 错误规范化（永不假空） ----------

// 后端命令错误形状：`{error:{code,message}}`（store.rs 的类型化错误码）。Tauri v2
// 的 invoke 对命令 Err(Value) 会把该 Value 作为 rejection 原因；这里防御性地归一
// 成 {code, message}——再包裹一层也认得出来。
function normErr(e) {
  const obj = (e && typeof e === "object") ? e : {};
  const inner = (obj.error && typeof obj.error === "object") ? obj.error : obj;
  return {
    code: inner.code || "unknown",
    message: inner.message || (typeof e === "string" ? e : String(e)),
  };
}

// 类型化错误码 → 人话（never fake empty：报错就明说错，不摆空列表/¥0）。
const ERR_TEXT = {
  "source-unavailable": "数据源不可用",
  "not-found": "会话不存在",
  "stale-revision": "列表已更新，请重新加载",
  "schema-mismatch": "数据版本不兼容",
  permission: "无权限访问",
  database_missing: "权威数据库尚未建立",
  database_unreadable: "权威数据库无法读取",
  schema_too_new: "权威数据库需要更新版本",
  schema_migration_required: "权威数据库需要迁移",
};

// 计费声明/候选的业务拒绝是 sqlite 层带英文原因串回来的（`authority sqlite: Invalid
// parameter name: …`），按原因串翻成人话；没命中的照原样给，不吞。
const BILLING_ERR_TEXT = [
  ["already used by another live declaration", "这张旧套餐记录已经是另一条有效计费声明的依据；要改就先在「当前计费声明」里撤销那条"],
  ["revoke that declaration instead of reopening", "这张旧套餐记录是一条有效计费声明的依据，不能单独重新打开；请撤销那条声明"],
];
function errText(e) {
  const n = normErr(e);
  if (ERR_TEXT[n.code]) return ERR_TEXT[n.code];
  const msg = n.message || "";
  const hit = BILLING_ERR_TEXT.find(([needle]) => msg.includes(needle));
  return hit ? hit[1] : (msg || "未知错误");
}

function showBanner(id, e, showReload) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = false;
  el.textContent = errText(e);
  if (showReload && (normErr(e).code === "stale-revision")) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.style.marginLeft = "8px";
    btn.textContent = "重载";
    btn.onclick = () => { el.hidden = true; loadSessions(true); };
    el.appendChild(btn);
  }
}

// ---------- 事件桥：权威库失效 → 立即重拉当前 tab（Rust 侧 emit，见 lib.rs） ----------
// Rust `sync_tick` 尾部在权威 revision **严格前进**时 emit `app-event`
// （payload.type = Invalidated、负载 `{type, revision, harnesses}`；RUNTIME_INVALIDATION
// spec §4.4，取代了旧 FoldCompleted 的 200ms 时间去抖）。这里订阅单一出口，收到后
// 重拉当前 tab 的概览数据，让工作台在托盘/外部手动同步完成的那一刻就刷新，而不是
// 等下一个 5 分钟 tick 或窗口聚焦。领域事件（FactsIngested 等）不再逐条透传到
// webview——展示层只收合并后的失效信号，每 tick 至多一条。
//
// **这不是实时通道的替代，是加速带**：事件丢时（webview 未就绪、emit 早于
// listen 到达）由 5 分钟 tick / 「立即同步」按钮轮询 / 窗口聚焦兜底——丢一两个
// 事件不会让工作台停在旧数据上超过一个同步周期（lib.rs 的 emit 注释写了同一句
// 话，两个方向都要记这个取舍）。

let manualSyncPolling = false; // 「立即同步」按钮的轮询回退在跑（按钮 handler 置位）

// 概览重拉的合并状态机（纯函数，可单测——scripts/verify-workbench-fold-bridge.mjs
// 从真实文件里取它断言，不是照抄一份逻辑去测）。
// 语义：同一时刻至多一轮重拉在途；在途期间的新触发只标记「稍后再拉一次」，
// 在途那轮回来后自动补一轮。事件与手点/聚焦同刻到达时，合并器把 N 次触发
// 折叠成 ≤2 轮重拉（1 轮在途 + 至多 1 轮补拉），不会并发双拉。
function makePullMerger() {
  let running = false;
  let queued = false;
  return {
    // 触发一次重拉。返回 true = 由本次触发开始了一轮（调用方去拉数据）；
    // false = 已在在途，标 queued 由在途那轮回来补。
    fire() {
      if (running) { queued = true; return false; }
      running = true;
      queued = false;
      return true;
    },
    // 一轮拉完。返回 true = 有排队触发，调用方应再拉一轮（保持 running）；
    // false = 无排队，释放 running。
    done() {
      if (queued) { queued = false; return true; }
      running = false;
      return false;
    },
    // 释放在途位而不补拉：排队触发已被 revision 锁存覆盖时出队用（R1）。
    release() {
      running = false;
      queued = false;
    },
  };
}

const wbPull = makePullMerger();

// R1 per-revision 锁存（REFRESH_STORM spec §4.1）：事件只对「尚未渲染的 revision」
// 触发重拉。renderedRevision = 已渲染的权威 revision；pendingRevision = 已通知未
// 渲染的最大值；forceRefresh = 无 revision 语义的信号（SyncStatusChanged/显式动作）
// 请求至少一拉。锁存拦「同 revision 重复」，wbPull 拦「在飞重复」，两者正交。
let renderedRevision = -1;
let pendingRevision = -1;
let forceRefresh = false;

// 只读测试钩子（R1 手测/风暴注入用）：devtools 断言锁存单调性与拉取轮数
// （pulls = 实际开始的拉取轮数，即 §7.4-6 要断言的「总拉取次数」）。
let pullRounds = 0;
window.__wbRefresh = {
  get renderedRevision() { return renderedRevision; },
  get pendingRevision() { return pendingRevision; },
  get pulls() { return pullRounds; },
};

// 合并的「重拉当前 tab」入口：事件桥与手点都走这里。只刷两个便宜页
// （overview/calendar）：sessions/findings/sources 是懒加载的重活（spawn 二进制、
// 几十秒），fold 事件不该把用户正在看的分页/筛选搅掉——与聚焦刷新同一口径。
// 普通 tab 切换由 loadActiveTab() 负责首进加载；日历同一月份命中缓存，事件桥
// 和显式刷新仍会直接走到这里。
// force=true（切 tab/刷新按钮/窗口聚焦/价卡更新等显式动作）保证至少一拉，
// 不受 revision 锁存影响；事件驱动路径（无参调用）只对未渲染 revision 拉取。
async function refreshActiveTab(force) {
  if (force === true) forceRefresh = true;
  if (!wbPull.fire()) return;
  pullRounds += 1;
  for (;;) {
    // 消费在 await 之前完成：本轮只认领它开启时已通知的 revision 与 force 请求，
    // 期间新到的留给尾随轮。欠认领安全（宁可多一次尾随拉取），不越权认领
    // 读取窗口开启之后才到达的 revision，也不吞在飞期间的 force。
    const revAtStart = pendingRevision;
    const forceNow = forceRefresh;
    forceRefresh = false;
    const shouldPull = forceNow || revAtStart > renderedRevision;
    const refreshable = activeTab === "overview" || activeTab === "calendar";
    if (shouldPull && refreshable) {
      try {
        if (activeTab === "overview") await renderOverview();
        else await renderCalendar();
        // 仅成功渲染才认领（Math.max 欠认领）；异常保持锁存原值，下一事件重试。
        renderedRevision = Math.max(renderedRevision, revAtStart);
      } catch (e) {
        console.warn("[workbench] 重拉渲染失败，保持锁存待下一事件重试", e);
      }
    }
    // done() 只知「期间又有触发」，不知「该触发是否已被本轮覆盖」——被锁存
    // 覆盖的迟到事件直接释放出队，不再补拉。try/catch 保证异常路径也走到这里，
    // running 永不泄漏（渲染一次 reject 不能永久卡死刷新）。
    if (!wbPull.done()) break;
    if (!forceRefresh && pendingRevision <= renderedRevision) { wbPull.release(); break; }
  }
}

function subscribeFoldEvent() {
  // 单一 UI 事件出口（EVENT_BUS spec §1.3）：后端只剩 `app-event` 一个通道，
  // 类型在 payload.type 里判别。Invalidated 是权威库失效信号（revision 前进才发，
  // 每 tick ≤ 1 条）；SyncStatusChanged 是变了才发的同步状态。Trust 两类是传感面
  // 的瞬态信号，不是数据失效（REFRESH_STORM spec R1 / 背压 spec §6：交给按类型
  // 过滤的局部消费者）——它们不触发页面级重拉；trust 活跃轮有新观察时写事务
  // 推进 revision，Invalidated 自然会来，数据新鲜度不丢。
  listen("app-event", (event) => {
    const payload = event && event.payload;
    const type = payload && payload.type;
    // 手动轮询在跑时，事件是同一轮同步的第二个完成信号——按钮自己的 poll
    // 已经（或将）在重拉，跳过避免双拉（负载不携带手动/自动来源，靠按钮
    // handler 置位的 manualSyncPolling 区分，不靠猜）。
    if (manualSyncPolling) return;
    if (type === "SyncStatusChanged") {
      refreshActiveTab(true);
      return;
    }
    if (type === "Invalidated") {
      const revision = Number(payload.revision);
      if (Number.isFinite(revision) && revision >= 0) {
        if (revision <= renderedRevision) return; // 已渲染，锁存吞掉
        pendingRevision = Math.max(pendingRevision, revision);
        refreshActiveTab();
      } else {
        // revision 缺失/非法：fail-open，保底一拉（不污染锁存值）。
        refreshActiveTab(true);
      }
    }
  }).catch((e) => {
    console.warn("[workbench] app-event 订阅失败（5 分钟 tick / 手动同步兜底）", e);
  });
}

// SyncStatusChanged 已并入 subscribeFoldEvent 的 app-event 分发（单一出口）；
// 本函数保留为空操作是为了 init 调用点与订阅注释的可读性——真正的类型语义
// 在上面那一个 listen 里。
function subscribeSyncStatusEvent() {}

// 菜单信息行导航（双通路，与 spec §7 深链同构——§7 描述的就是这套持久目标 +
// 事件通知机制）：
//   - `focus-tab` 事件是快路径（窗口已可见时菜单一戳就跳）；
//   - `peek_nav_target` 持久目标是慢路径——窗口未建/未可见时 emit 是空操作，目标留到
//     下次 init/focus 时 pull。**事件只是通知，pull 是最终仲裁**：监听器不读 e.payload，
//     统一从 state 读目标，apply 后 clear 是单点，事件与焦点 pull 不会各 apply 一遍。
async function pullNavTarget() {
  try {
    const tab = await invoke("peek_nav_target");
    if (tab) {
      switchTab(tab);
      await invoke("clear_nav_target");
    }
  } catch (e) {
    console.warn("[workbench] peek_nav_target 失败（菜单导航不可用）", e);
  }
}

function subscribeNavEvent() {
  // 终身订阅，不调 unlisten（与 subscribeFoldEvent 同款）。
  listen("focus-tab", () => {
    pullNavTarget();
  }).catch((e) => {
    console.warn("[workbench] focus-tab 订阅失败（持久目标 pull 兜底）", e);
  });
}

// 会话深链导航（spec §7.2，与信息行导航同一套双通路）：`focus-target` 事件是
// 快路径，`peek_focus_target` 持久目标是慢路径（窗口未建/未可见时 emit 丢掉的
// 点击留到 init/focus/visibilitychange 时命中）。拿到 `SessionDetail` → 切会话
// tab + showSession（最小对象，复用 openSessionFromFinding 范式——摘要卡缺字段
// 显示「—」，完整数字由 sessions_read 的 envelope 分区填）；拿到 `SessionList`
// → 切 tab + 设 harness 过滤 + 重置分页 + 重新加载（v1 菜单不发射它，消费路径先
// 落地，等「查看全部会话」回归）。apply 后 clear 是单点；apply 失败也 clear
// （错误横幅已向用户说明，不无限重试，菜单再点会覆盖新目标）。
async function pullFocusTarget() {
  let t;
  try {
    t = await invoke("peek_focus_target");
  } catch (e) {
    console.warn("[workbench] peek_focus_target 失败（会话深链不可用）", e);
    return;
  }
  if (!t) return;
  try {
    if (t.type === "sessionDetail" && t.session_ref) {
      switchTab("sessions");
      // showSession 摘要即时渲染，envelope 异步补齐——导航已生效即可 clear，
      // 不等 sessions_read（冷 cache 30s+，等它会让深链目标滞留整轮）。
      showSession({
        session_ref: t.session_ref,
        title: null,
        model: null,
        harness: t.harness_kind || null,
      });
    } else if (t.type === "sessionList") {
      sessFilter = t.harness_kind || "all";
      updateFilterChips();
      // loadSessions(true) 同步置 loaded，切 tab 的懒加载不会再叠一次请求。
      loadSessions(true);
      switchTab("sessions");
    }
    await invoke("clear_focus_target");
  } catch (e) {
    await invoke("clear_focus_target");
    console.warn("[workbench] 深链目标应用失败（已 clear，菜单再点会覆盖新目标）", e);
  }
}

function subscribeFocusTargetEvent() {
  // 终身订阅，不调 unlisten（与 subscribeNavEvent 同款）。
  listen("focus-target", () => {
    pullFocusTarget();
  }).catch((e) => {
    console.warn("[workbench] focus-target 订阅失败（持久目标 pull 兜底）", e);
  });
}

// ---------- tab 切换 ----------

let activeTab = "overview";
let calMonth = statisticsMonth();
// 用量（日历）页按月份缓存首屏结果。切换 tab 不应重复发起同一月份的两次
// 查询；事件桥、刷新按钮和月份选择仍会直接调用 renderCalendar() 主动更新。
let calendarLoadedMonth = null;
let calSelectedDate = null; // 当日按小时面板选中的日期（null = 今天）
let calData = null;
let calMetric = "tokens"; // 日历主数：tokens 或按来源口径的成本
let sessState = { items: [], nextCursor: null, total: null, loaded: false, error: false };
// 会话列表 harness 过滤（spec §7.3）："all" | "dsh" | "codex"。过滤变化重置分页
// （游标语义是「全量翻页」，带旧过滤的游标续拉会混页）；深链 SessionList 目标
// 也写这里。
let sessFilter = "all";
let sessStatusFilter = "all";
// Findings/数据源页同款懒加载：CLI 汇总较重（sessions_findings / sessions_list 都
// spawn 二进制），首进一次、之后「重载」按钮刷新——与 sessions 页同一套理由。
let findState = { loaded: false, error: false, data: null, sev: "all", rule: "all", expanded: {}, nextCursor: null, loadingMore: false };
let srcState = { loaded: false, error: false, sources: null, sync: null, paused: false };

function switchTab(name) {
  // Menu state uses canonical React route IDs. Keep the legacy shell adapter so
  // tray navigation remains functional until this shell is retired.
  const focusBudgetSection = name === "settings#settings-budget";
  if (focusBudgetSection) name = "settings";
  if (name === "usage") name = "calendar";
  else if (name === "settings") name = "sources";
  activeTab = name;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll(".tabpane").forEach((p) => {
    p.classList.toggle("active", p.id === "tab-" + name);
  });
  // Return the loading promise so deep links can wait for the target tab's
  // async render before calculating its scroll position.
  const load = loadActiveTab();
  if (focusBudgetSection) {
    void load.then(() => window.requestAnimationFrame(() => {
      document.getElementById("settings-budget")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }
  return load;
}

async function loadActiveTab() {
  // 总览/日历的所有入口（切 tab、刷新按钮、窗口 focus、fold 事件）必须共用
  // wbPull：否则连续点刷新或频繁切回窗口仍会绕开事件桥的合并器，重叠查询同一
  // 份 SQL 数据。sessions/findings/sources 保留各自的懒加载语义，不进这里。
  if (activeTab === "overview") {
    await refreshActiveTab(true);
  }
  else if (activeTab === "calendar") {
    if (calendarLoadedMonth !== calMonth) await refreshActiveTab(true);
  }
  // 会话页懒加载：首进一次，之后只在「重载列表 / 加载更多」时拉。切 tab 不重拉
  // 也不追加——反复 overview↔sessions 切着看，分页游标不能被一次切换吞掉一页。
  else if (activeTab === "sessions") { if (!sessState.loaded) loadSessions(); }
  // Findings / 数据源同款懒加载（CLI 汇总较重，见 state 注释）。
  else if (activeTab === "findings") { if (!findState.loaded) loadFindings(); }
  // 「测试」tab 懒加载：路线列表是轻命令；报告区按 run 状态渲染。
  else if (activeTab === "test") { loadTestTab(); }
  // Skill 体检懒加载：首进只显示「尚未扫描」引导，不自动跑（spec §7 ——
  // 扫描可能拉起 codex app-server，秒级开销不该在切 tab 时白付）。
  else if (activeTab === "skills") { if (!skState.loaded && !skState.scanning && !skState.error) showSkillsIntro(); }
  else if (activeTab === "sources") {
    // 设置 tab 里 read_overview 有三个消费方（预算静默态 / 数据源同步行 /
    // 版本诊断的 sync 字段）。以前前两处各拉一次 = 每进一次设置页多跑一遍
    // （每遍约 120-360ms）。这里统一拉一次再分发；失败降级成 null，各消费方
    // 各自兜底，不影响其余设置读取。
    const settingsOverview = await invoke("read_overview").catch(() => null);
    await Promise.allSettled([
      loadSettingsData(settingsOverview),
      ...(!srcState.loaded ? [loadSources(false, settingsOverview)] : []),
    ]);
  }
}

// 聚焦刷新：与弹窗同款 —— 窗口每次重新获得焦点都重拉（hide 不是 close，数据要新鲜）。
// 会话页例外：CLI 列表较重，首进加载一次、之后用「重载列表」按钮；焦点只刷新
// 总览与日历两个便宜页。
window.addEventListener("focus", () => {
  // 菜单导航慢路径：窗口重新获得焦点时 pull 持久目标（窗口未可见时 emit 丢掉的
  // 那次点击在这里命中）。信息行与会话深链各一个 slot，都先 pull 再刷新——避免
  // pull 切 tab 后又按旧 activeTab 刷新。
  pullNavTarget();
  pullFocusTarget();
  refreshActiveTab(true);
});

// 可见性恢复（隐藏/显示、切走再切回）也是「窗口变得可见」——`show()` 后 focus
// 事件不一定跟着来（focus_session 的 show 早于 webview 完成可见），
// visibilitychange(visible) 兜底这条路径（spec §7.2 的 pull 触发点之一）。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    pullNavTarget();
    pullFocusTarget();
  }
});

// ---------- 总览 ----------

// ---------- 总览 KPI helpers（v0.9 Stage D）----------
// 币种符号：by_provider 条目带 currency（Stage C），写符号不再是编造；
// null = 条目未声明单币，裸数字 + 「口径未声明」，不冒充任何币。
function curSymbol(cur) { return cur === "CNY" ? "\u00a5" : cur === "USD" ? "$" : ""; }
function fmtCur(amount, cur) {
  const v = (Math.round(amount * 100) / 100).toFixed(2);
  return curSymbol(cur) + v + (cur ? "" : "（币种未声明）");
}
const PROVIDER_LABEL = {
  anthropic: "Anthropic", minimax: "MiniMax", "zhipu-glm": "智谱 GLM",
  openai: "OpenAI", deepseek: "DeepSeek", "deepseek-official": "DeepSeek 官方", shengsuanyun: "胜算云",
  unknown: "未知提供方", unattributed: "未归属",
  // authority_query.rs codex_by_hour_provider_model：provider_id 为 NULL 的
  // Codex 事实以 "<unknown>" 为键（summary.rs 测试钉住 "codex/<unknown>"）。
  // 没这条映射时费用明细直接把尖括号原样上屏（2026-09-15 真机截图）。
  "<unknown>": "未知提供方",
};
// 名义成本 = by_provider 各条目的官方标价折算之和（分币）——FixedSubscription
// 是月费不是标价折算，排除。
function nominalFromByProvider(byProvider) {
  const out = {}; // currency -> sum
  for (const [key, h] of Object.entries(byProvider || {})) {
    const cur = h.currency || "";
    for (const [basis, amt] of Object.entries(h.amounts_by_basis || {})) {
      if (basis === "fixed_subscription") continue;
      out[cur] = (out[cur] || 0) + amt;
    }
  }
  return out;
}
function fmtCurMap(m) {
  // 币序统一：CNY 优先（中文语境 + 主要支出是 ¥），USD 次之，其余币种按
  // 键序殿后——审查 #5：此前名义按插入序、实际按 Rust BTreeMap 序、日历头
  // 写死序，同一屏三种 $/¥ 排列。
  const rank = (c) => (c === "CNY" ? 0 : c === "USD" ? 1 : 2);
  return Object.entries(m || {}).filter(([, v]) => v > 0)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : 1))
    .map(([c, v]) => fmtCur(v, c || null));
}
// 速览层混币折算（PM 决策 2026-09-07）：把 {CNY, USD, …} 金额 map 按
// `assets/pricing.json::fx_estimate` 的汇率（`Overview.fx = {usd_cny, as_of}`）
// 并成一个 `≈¥` 数——**是估算标签不是口径**。只用于名义 / 单位成本（速览层）；
// 实际支出 / 预算 / 双轨账 / 本月结论行永远分币不相加（那些是账单级口径）。
// 返回 null → 调用方退回分币旧行为，触发条件：无汇率 · map 为空 · 只有 CNY 一种
//（无需折算，不凭空长 `≈`）· 出现认不出的币种（宁可分币也不编一个折算数）。
function fxMerge(curMap, fx) {
  const rate = fx && Number(fx.usd_cny);
  if (!rate || !(rate > 0)) return null;
  const entries = Object.entries(curMap || {}).filter(([, v]) => v > 0);
  if (!entries.length) return null;
  if (entries.every(([c]) => c === "CNY")) return null; // 单币无需折算
  let cny = 0;
  for (const [c, v] of entries) {
    if (c === "CNY") cny += v;
    else if (c === "USD") cny += v * rate;
    else return null; // 认不出的币 → 分币，不折
  }
  return { cny, parts: fmtCurMap(curMap), rate, asOf: fx.as_of || null };
}
// `≈¥X`（折算总额）。原始分币走调用方的 hover title。
function fmtFxApprox(m) { return "≈" + fmtCur(m.cny, "CNY"); }
// 折算口径的人话副行片段：「混币按 ≈7.15 折算（2026-09）」。
function fxNote(m) {
  return "混币按 ≈" + m.rate + " 折算" + (m.asOf ? "（" + m.asOf + "）" : "");
}
function tokensSum(tokensByHarness) {
  let unc = 0, read = 0, write = 0, out = 0, total = 0;
  for (const t of Object.values(tokensByHarness || {})) {
    unc += t.uncached_input || 0; read += t.cache_read || 0;
    write += t.cache_write || 0; out += t.output || 0; total += t.total || 0;
  }
  const denom = unc + read + write;
  return { total, hit: denom > 0 ? read / denom : null };
}

// 跳到设置页某个分区（设置 tab 的内部名仍是 "sources"）。
async function openSettingsSection(sectionId, focusId) {
  await switchTab("sources");
  // loadSettingsData() fills several sections asynchronously. Wait one frame
  // for the DOM/layout pass before measuring the target; otherwise a deep link
  // can land above the eventual content and leave the user in a large blank
  // area. The workbench itself is the scroll container (body is locked).
  await new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(resolve);
    else setTimeout(resolve, 0);
  });
  const section = document.getElementById(sectionId);
  const pane = document.querySelector(".wb-main");
  if (section && pane) {
    const top = section.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 12;
    const targetTop = Math.max(0, top);
    if (typeof pane.scrollTo === "function") pane.scrollTo({ top: targetTop, behavior: "smooth" });
    else pane.scrollTop = targetTop;
  } else if (section && section.scrollIntoView) {
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const focus = focusId && document.getElementById(focusId);
  if (focus && focus.focus && !focus.hidden) focus.focus({ preventScroll: true });
}

// 可信度两条状态行（IA 复核 §3.2）：「路由与缺价」和「价格覆盖」是两个轴，
// 不合成一个百分比。行的颜色只由 data_status.health 派生——此前把 unpriced
// 算成「100% 可计价」并上绿色强调色，同屏 health=warn 横幅还在说"金额可能为
// 估算"，专门传达可信的卡在说反话。
function trustRowLevel(health, hasIssue) {
  if (health === "critical") return "danger";
  if (hasIssue || (health && health !== "ok")) return "warn";
  return "ok";
}
// 全 ok → .compact（位置不变，只是不抢视线）。
function placeTrustRows(allOk) {
  const ul = document.getElementById("ov-trust-rows");
  if (ul && ul.classList && typeof ul.classList.toggle === "function") ul.classList.toggle("compact", allOk);
}
// 套餐提示当前的可见状态与影响 tokens（renderBillingConfirmation 写入）——
// 归属缺口与待确认套餐同源时，⚠ 行不再自带按钮，指向唯一主动作。
// var 而非 let：verify-workbench-kpi-decide.mjs 在 vm 里从 sandbox 直接改它，
// 顶层 let 不会挂到 vm 全局上。
var billingPromptState = { visible: false, pendingTokens: 0 };
function renderTrustRows(status, monthly) {
  const route = document.getElementById("ov-trust-route");
  const price = document.getElementById("ov-trust-price");
  if (!route || !price) return;
  const finish = () => placeTrustRows(
    String(route.className).includes("notice ok") && String(price.className).includes("notice ok"));
  const setRow = (li, level, text, action) => {
    li.className = "notice " + level;
    const textEl = li.querySelector(".notice-text");
    if (textEl) textEl.textContent = text;
    const btn = li.querySelector(".notice-actions button");
    if (!btn) return;
    btn.hidden = !action;
    if (action) { btn.textContent = action.label; btn.onclick = action.onClick; }
  };
  const toDiagnostics = { label: "查看详情", onClick: () => openSettingsSection("settings-about", "ov-diagnostic-status") };
  const toPricing = { label: "查看价格表", onClick: () => openSettingsSection("settings-data", "ov-pricing-catalog-status") };
  // 未归属服务商的用量就是「明确计费方式」弹窗里「服务商未知」的那些组：按钮直接
  // 打开该面板（设置 › 计费与套餐），诊断页留给真正的技术故障。提示被「稍后」压住时
  // `ov-billing-review` 仍在 DOM 里，click() 照样展开面板。
  const toClarify = { label: "去明确", onClick: async () => {
    const review = document.getElementById("ov-billing-review");
    if (review && review.click) review.click();
    await openSettingsSection("settings-billing", "ov-billing-review-title");
  } };
  price.hidden = false;
  if (!status || status.status !== "ok") {
    setRow(route, "danger", "读不到数据状态，无法确认这些数字是否完整", toDiagnostics);
    price.hidden = true;
    finish();
    return;
  }
  const d = status.data || {};
  const health = d.health || "ok";
  const total = monthly ? tokensSum(monthly.tokens_by_harness).total : null;
  // 这两行渲染在「本月已处理 …」下面，待确认面板也只处理当月——所以主数字用
  // **本月**口径（`*_tokens_month`，与 total_tokens_month 同跨度），全库累计只作
  // 历史脚注。此前主数字是全库累计：用户把当月全部归因完了提示照样亮着，因为
  // 8 月的中转用量落在声明起始日之前、WorkBuddy 又按设计永远 provider 未知——
  // 一条在 UI 里永远关不掉的警告（2026-09-16 反馈）。旧载荷没有 *_month 字段时退回
  // 全库口径（文案也随之写「全库累计」，不冒充本月）。
  const hasMonth = d.unresolved_tokens_month !== undefined;
  const unresolvedAll = Math.max(0, Number(d.unresolved_tokens || 0));
  const unpricedAll = Math.max(0, Number(d.unpriced_tokens || 0));
  const unresolved = hasMonth ? Math.max(0, Number(d.unresolved_tokens_month || 0)) : unresolvedAll;
  const unpriced = hasMonth ? Math.max(0, Number(d.unpriced_tokens_month || 0)) : unpricedAll;
  const scopeWord = hasMonth ? "本月有 " : "全库累计有 ";
  // 占比分母与分子同跨度（2026-09-14 教训：跨度不同相除，百分比没有意义）。
  const allTimeTotal = Math.max(0, Number((hasMonth ? d.total_tokens_month : d.total_tokens) || 0));
  const historyUnresolved = hasMonth ? Math.max(0, unresolvedAll - unresolved) : 0;
  const historyNote = historyUnresolved > 0
    ? "（另有历史月份 " + fmtTokens(historyUnresolved) + " tokens 未归因——重新声明时把起始日期提前到那个月即可覆盖）" : "";
  // 路由与缺价：未定 provider 的 token 让按量金额只能是下界。
  if (unresolved > 0) {
    // 同源判定：套餐提示可见且其影响范围盖住了这批 token → 同一件事，一个按钮。
    const sameSource = billingPromptState.visible && billingPromptState.pendingTokens >= unresolved;
    setRow(route, trustRowLevel(health, true),
      scopeWord + fmtTokens(unresolved) + " tokens 还不知道是哪家服务商的，按量费用可能少算" +
        (sameSource ? "——在下方「明确计费方式」里补上服务商即可" : "") + historyNote,
      sameSource ? null : toClarify);
  } else if (historyUnresolved > 0) {
    setRow(route, "ok", "本月用量都已归到对应服务商" + historyNote, null);
  } else if (health !== "ok") {
    setRow(route, trustRowLevel(health, false), "数据检查发现问题（" + health + "），数字可能不完整", toDiagnostics);
  } else {
    setRow(route, "ok", "所有用量都已归到对应服务商", null);
  }
  // 价格覆盖：名义成本能解释多少已观测用量（下钻到价格目录）。
  const pricingStale = !!(d.pricing && d.pricing.stale);
  if (total === null) {
    setRow(price, "warn", "本月用量暂不可读，无法核对价格完整性" +
      (unpriced > 0 ? "；" + scopeWord + fmtTokens(unpriced) + " tokens 缺少价格" : "") +
      (pricingStale ? "；价格表已过期" : ""), toPricing);
  } else if (!(total > 0)) {
    setRow(price, "ok", "本月还没有用量，暂无需核对价格", null);
  } else if (unpriced > 0) {
    // 分母取同跨度的总量；缺这个字段（旧载荷）时**不给百分比**，而不是退回
    // 拿别的跨度去算——那正是 2026-09-14 那个 bug 的形状。
    const missing = allTimeTotal > 0 ? Math.max(0, Math.min(1, unpriced / allTimeTotal)) : null;
    renderPriceMissingList(Array.isArray(d.unpriced_models_month) ? d.unpriced_models_month : []);
  // 归因 ≠ 价卡：归因回答"谁收钱"，价卡回答"每 M token 多少钱"。无价卡的 token 里
    // 只有**按量**的那部分会让「按量费用」少算；套餐内的（智谱订阅里的 glm-*）钱已在
    // 月费里，缺卡只让「按官方价折算」参考数偏低——两种后果不能用同一句警告
    // （2026-09-16：用户归因全做完了仍被"没有价格"吓到，以为归因没生效）。
    const meteredField = hasMonth ? d.unpriced_metered_tokens_month : d.unpriced_metered_tokens;
    const metered = meteredField === undefined ? unpriced : Math.max(0, Number(meteredField || 0));
    if (metered > 0) {
      const meteredShare = allTimeTotal > 0 ? Math.max(0, Math.min(1, metered / allTimeTotal)) : null;
      setRow(price, trustRowLevel(health, true),
        scopeWord + fmtTokens(metered) + " tokens 按量用量的模型没有价格，按量费用少算了" +
          (meteredShare === null ? "这部分" : "约 " + fmtPct(meteredShare)) +
          (unpriced > metered ? "；另有 " + fmtTokens(unpriced - metered) + " tokens 在套餐内、只影响折算参考" : "") +
          (pricingStale ? "；价格表也已过期" : ""),
        toPricing);
    } else {
      setRow(price, "ok",
        scopeWord + fmtTokens(unpriced) + " tokens 在套餐内、模型没有价卡：按量费用和月费不受影响，只是「按官方价折算」参考数" +
          (missing === null ? "偏低" : "偏低约 " + fmtPct(missing)) +
          (pricingStale ? "；价格表已过期" : "") + "。补一张卡即可校正",
        toPricing);
    }
  } else if (pricingStale) {
    setRow(price, trustRowLevel(health, true), "所有模型都有价格，但价格表已过期，按官方价折算的金额可能偏旧", toPricing);
  } else {
    setRow(price, "ok", "所有模型都有价格，按官方价折算没有漏算", toPricing);
  }
  // 两条都 ✓ 且都没有话要说 → 合成一句，用户不需要读两行。有脚注的 ok 行（历史
  // 月份未归因 / 套餐内缺卡）保留各自那句——合成会把脚注吞掉。
  const bothOk = String(route.className).includes("notice ok") && String(price.className).includes("notice ok")
    && historyUnresolved === 0 && !(unpriced > 0);
  if (bothOk) {
    setRow(route, "ok", "数据完整：所有用量都已归到服务商，所有模型都有价格", toPricing);
    price.hidden = true;
  }
  finish();
}

// 首行来源状态：「3 个来源正常，1 个需检查」（规格 §4 第 87 行，详细卡在设置→数据源）。
// 只按 data_source_status 的连接状态计数；未探测到的来源单列为尚未接入。
function sourcesBrief(report) {
  const el = document.getElementById("ov-sources-brief");
  if (!el) return;
  if (!report || report.status !== "ok" || !Array.isArray(report.sources)) {
    el.textContent = "来源状态不可用";
    const a = document.getElementById("ov-sources-brief-action");
    if (a) a.hidden = true;
    return;
  }
  let okCount = 0, check = 0, notDetected = 0;
  for (const row of report.sources) {
    switch (row.connection_state) {
      case "connected": okCount += 1; break;
      case "needs_attention":
      case "paused":
      case "excluded": check += 1; break;
      case "not_detected": notDetected += 1; break;
      default: check += 1; break; // 未知状态不能冒充正常。
    }
  }
  const action = document.getElementById("ov-sources-brief-action");
  if (action) {
    action.hidden = !(check > 0);
    action.onclick = () => openSettingsSection("settings-sources");
  }
  if (okCount + check + notDetected === 0) { el.textContent = "尚未连接数据来源"; return; }
  const parts = [];
  if (okCount + check > 0) parts.push(okCount + " 个来源正常");
  if (check) parts.push(check + " 个需检查");
  if (notDetected) parts.push(notDetected + " 个尚未接入");
  el.textContent = parts.join("，");
}

// 卡片入口（第三档 CTA）：导航，不是待办。绑定一次。
function bindOverviewLinks() {
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.bound === "1") return;
    el.dataset.bound = "1";
    el.onclick = fn;
  };
  const toCalendar = (selectToday) => {
    calMonth = statisticsMonth();
    calSelectedDate = selectToday ? statisticsToday() : null;
    switchTab("calendar");
  };
  bind("ov-link-spend", () => {
    const target = document.getElementById("ov-dual-title");
    if (target && target.scrollIntoView) target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  bind("ov-link-today", () => toCalendar(true));
  bind("ov-link-usage", () => toCalendar(false));
  bind("ov-link-days", () => toCalendar(false));
  bind("ov-link-budget", () => openSettingsSection("settings-budget", "ov-budget-monthly-amount"));
  bind("ov-link-set-budget", () => openSettingsSection("settings-budget", "ov-budget-monthly-amount"));
  bind("ov-link-plans", () => openSettingsSection("settings-billing"));
  bind("ov-link-billing", () => openSettingsSection("settings-billing"));
  // 三卡里的「尚未设置套餐或账单」（setAmount 打 data-go）：委托到卡片容器，
  // 每次重渲染不用重绑；Enter/Space 与点击同义（它是 role=button）。
  const kpiRow = document.getElementById("ov-kpi-row");
  if (kpiRow && kpiRow.dataset && kpiRow.dataset.goBound !== "1" && typeof kpiRow.addEventListener === "function") {
    kpiRow.dataset.goBound = "1";
    const go = (ev) => {
      const t = ev.target && ev.target.closest ? ev.target.closest("[data-go]") : null;
      if (t) { ev.preventDefault(); openSettingsSection(t.getAttribute("data-go")); }
    };
    kpiRow.addEventListener("click", go);
    kpiRow.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") go(ev); });
  }
}

// B1-M1.1: command/section contract (spec §4). Raw DTOs stay at this boundary;
// renderers receive validated values or null, with normalized errors kept separately.
const overviewRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const overviewNumber = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const overviewAmounts = (v) => overviewRecord(v) && Object.values(v).every(overviewNumber);
function overviewSummaryValid(v) {
  return overviewRecord(v) && overviewRecord(v.tokens_by_harness)
    && Object.values(v.tokens_by_harness).every((t) => overviewRecord(t)
      && ["total", "uncached_input", "cache_read", "cache_write", "output"].every((k) => overviewNumber(t[k])))
    && overviewRecord(v.by_provider) && overviewRecord(v.by_harness)
    && Object.values(v.by_provider).every((p) => overviewRecord(p) && overviewAmounts(p.amounts_by_basis)
      && (p.currency === null || typeof p.currency === "string"))
    && Object.values(v.by_harness).every(overviewRecord)
    && overviewAmounts(v.total_actual_spend) && overviewRecord(v.actual_spend_by_basis)
    && Object.values(v.actual_spend_by_basis).every(overviewAmounts);
}
const overviewList = (key, fields) => (v) => overviewRecord(v) && v.status === "ok" && Array.isArray(v[key])
  && v[key].every((item) => overviewRecord(item) && fields.every((field) => typeof item[field] === "string"));
const OVERVIEW_REQUESTS = Object.freeze([
  { key: "overview", command: "read_overview", sections: ["sync", "budget", "fx"],
    valid: (v) => overviewRecord(v) && overviewRecord(v.sync) && typeof v.sync.ok === "boolean"
      && typeof v.sync.at === "string" },
  { key: "monthly", command: "data_monthly_summary", sections: ["spend", "usage", "breakdown", "decide"],
    args: (w) => ({ month: w.month }), valid: overviewSummaryValid },
  { key: "daily", command: "data_daily_summary", sections: ["today"],
    args: (w) => ({ date: w.date }), valid: overviewSummaryValid },
  { key: "calendar", command: "read_calendar_month", sections: ["recent-days"],
    args: (w) => ({ month: w.month }), valid: (v) => overviewRecord(v) && overviewRecord(v.days)
      && Object.entries(v.days).every(([date, d]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date.startsWith(v.month + "-")
        && overviewRecord(d) && overviewNumber(d.total_tokens)
        && ["dsh_cost_cny", "claude_cost_cny", "claude_cost_usd", "codex_cost_usd"].every((k) => d[k] == null || overviewNumber(d[k]))) },
  { key: "sources", command: "data_source_status", sections: ["sources"], valid: overviewList("sources", ["harness", "connection_state"]) },
  { key: "quality", command: "data_status", sections: ["trust"],
    valid: (v) => overviewRecord(v) && v.status === "ok" && overviewRecord(v.data)
      && typeof v.data.health === "string" && overviewNumber(v.data.unresolved_tokens)
      && overviewNumber(v.data.unpriced_tokens) && overviewRecord(v.data.pricing)
      && typeof v.data.pricing.stale === "boolean" },
  { key: "claudeQuota", command: "data_claude_quota", sections: ["decide"],
    // 形状出处：runtime::summary::claude_quota_status —— {state:"unknown",observed_at,windows_recent}
    // 或 {state:"exhausted",window,resets_at,observed_at,windows_recent}。**没有百分比字段**，
    // 因为数据里不存在正向余量（42/42 条 quotaLimits 全是 rejected）。
    valid: (v) => v === null || (overviewRecord(v) && (
      v.state === "unknown"
      || (v.state === "exhausted" && typeof v.window === "string" && overviewNumber(v.resets_at)))) },
  { key: "quota", command: "data_codex_quota", sections: ["decide"],
    valid: (v) => v === null || (overviewRecord(v) && typeof v.plan_type === "string"
      && (v.limits == null || (overviewRecord(v.limits) && Object.values(v.limits).every((w) => overviewRecord(w)
        && (w.used_percent == null || overviewNumber(w.used_percent))
        && (w.resets_at == null || overviewNumber(w.resets_at)))))
      && typeof v.observed_at === "string") },
  { key: "candidates", command: "billing_import_candidates", sections: ["billing"], valid: (v) => overviewList("candidates", ["candidate_id", "harness", "provider_id", "status", "currency", "billing_period_start"])(v)
      && v.candidates.every((c) => overviewNumber(c.amount_minor) && (c.impact == null ||
        (overviewRecord(c.impact) && (c.impact.status !== "ok" ||
          ["total_tokens", "fact_count", "session_count"].every((k) => overviewNumber(c.impact[k])))))) },
  // 形状出处：runtime::billing_preview::confirmation_groups（组行由
  // summary::unresolved_billing_groups_in 序列化，estimated_amounts/unpriced_tokens 由
  // confirmation_groups 补）。金额行 {amount_minor, currency, basis} 永不跨币相加。
  { key: "billingGroups", command: "billing_confirmation_groups", sections: ["billing"],
    args: (w) => ({ month: w.month }),
    valid: (v) => overviewList("groups", ["group_id", "harness", "provider_id", "model_id", "evidence_basis", "effective_start", "effective_end"])(v)
      && v.groups.every((g) => overviewNumber(g.tokens) && overviewNumber(g.session_count)
        && Array.isArray(g.estimated_amounts) && g.estimated_amounts.every((a) => overviewRecord(a)
          && typeof a.currency === "string" && Number.isFinite(a.amount_minor))) },
  // Provider-level declarations no longer carry a harness (Rust billing_declarations_value).
  // A missing current revision is nullable evidence, not a malformed whole overview;
  // renderBillingDeclarations refuses revision-dependent mutations in that case.
  { key: "declarations", command: "billing_declarations", sections: ["billing"],
    valid: (v) => overviewList("declarations", ["declaration_id", "provider_id", "relationship_kind", "effective_start"])(v)
      && v.declarations.every((d) => (d.current_revision_id === null || typeof d.current_revision_id === "string")
        && Array.isArray(d.scopes) && d.scopes.every((sc) => overviewRecord(sc)
          && typeof sc.scope_kind === "string" && typeof sc.scope_value === "string")) },
  { key: "jobs", command: "billing_recalculation_jobs", sections: ["billing"], valid: overviewList("jobs", ["job_id", "status"]) },
]);

async function loadOverviewData() {
  await loadStatisticsTimezonePreference();
  // Capture once, including if midnight occurs while independent IPC calls settle.
  const date = statisticsToday();
  const window = { date, month: date.slice(0, 7) };
  const results = await Promise.allSettled(OVERVIEW_REQUESTS.map(async (request) => {
    const value = await invoke(request.command, request.args ? request.args(window) : undefined);
    if (value && value.status === "unavailable") {
      throw { code: value.code || "source-unavailable", message: value.reason || "数据源不可用", recovery_action: value.recovery_action };
    }
    const matchesWindow = request.key === "daily" ? value && value.date === window.date
      : ["monthly", "calendar"].includes(request.key) ? value && value.month === window.month : true;
    if (!matchesWindow || !request.valid(value)) throw { code: "schema-mismatch", message: request.command + " DTO 不兼容" };
    return value;
  }));
  const data = {}, errors = {};
  results.forEach((result, index) => {
    const key = OVERVIEW_REQUESTS[index].key;
    data[key] = result.status === "fulfilled" ? result.value : null;
    if (result.status === "rejected") {
      errors[key] = normErr(result.reason);
      const action = result.reason && result.reason.recovery_action;
      if (overviewRecord(action) && typeof action.kind === "string") errors[key].recovery_action = action;
    }
  });
  return { window, data, errors };
}

// Settings-only reads start when the Settings (sources) tab is entered.
// 已有账单：只读展示（规格 §4.2、§7 D3）。录入表单与 CSV 导入是 Beta 延期
// 能力，DOM 保留但不显示；这里不再调用 renderHarnessBills（它绑定的是隐藏表单）。
// 左栏导航高亮：滚动到哪个分区，对应导航项加 .current（规格 §3.1）。锚点跳转
// 本身用原生 <a href="#id">，这里只负责高亮，不拦截点击。
let settingsNavBound = false;
function bindSettingsNav() {
  if (settingsNavBound) return;
  // document.querySelector 在真实浏览器里总有；guard 只是为了不让这个纯装饰性的
  // 高亮功能在缺 DOM API 的执行环境（测试沙箱、未来非浏览器渲染）里把整个
  // loadSettingsData() 拖下水——同步抛出会让上面六个设置读取一个都不跑
  // （Promise.allSettled 接的是 loadSettingsData() 这一个 promise，不是内部
  // 每条 invoke，函数体前段抛出会让整个 await 链路提前失败）。
  if (typeof document.querySelector !== "function") return;
  const nav = document.querySelector(".settings-nav");
  const sections = document.querySelectorAll(".settings-section[id]");
  if (!nav || !sections.length || typeof IntersectionObserver !== "function") return;
  settingsNavBound = true;
  const linkFor = (id) => nav.querySelector('a[href="#' + id + '"]');
  const setCurrent = (id) => {
    nav.querySelectorAll("a").forEach((a) => a.classList.remove("current"));
    const link = linkFor(id);
    if (link) link.classList.add("current");
  };
  if (sections[0]) setCurrent(sections[0].id);
  const scrollRoot = document.querySelector(".wb-main");
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible[0]) setCurrent(visible[0].target.id);
  }, { root: scrollRoot || null, rootMargin: "-10% 0px -70% 0px" });
  sections.forEach((section) => observer.observe(section));
}

async function renderBillsReadOnly(period) {
  const section = document.getElementById("settings-bills");
  const list = document.getElementById("settings-bills-list");
  if (!section || !list) return;
  try {
    const report = await invoke("harness_bills_for_period", { billingPeriod: period });
    const bills = report && report.status === "ok" ? (report.bills || []) : [];
    section.hidden = !bills.length;
    list.textContent = "";
    for (const bill of bills) {
      const row = document.createElement("div");
      row.className = "billing-review-row";
      row.textContent = (HARNESS_DISPLAY[bill.harness] || bill.harness) + " · " + bill.provider_id + " · " +
        (bill.billing_basis || "") + " · " + fmtCur(Number(bill.amount_minor || 0) / 100, bill.currency);
      list.appendChild(row);
    }
  } catch (_) { section.hidden = true; }
}

// 用户本地价目覆盖（`state/pricing-overrides.json`）：**归属声明** + **补价卡**。
// 待处理里那两类任务会把服务商/型号预填进来——预填靠这两个模块级变量传，
// 不需要跨页传参机制。
let pendingPriceCard = null;
let pendingPriceRoute = null;

// 「声明型号归属」。与补价卡是两件事且有先后：归属没定 → 归不了账；归属定了但没
// 价卡 → 另一条任务。所以这两块并排放在价格目录下面。
async function renderPriceRouteSettings() {
  const model = document.getElementById("ov-price-route-model");
  const provider = document.getElementById("ov-price-route-provider");
  const mode = document.getElementById("ov-price-route-mode");
  const save = document.getElementById("ov-price-route-save");
  const status = document.getElementById("ov-price-route-status");
  const list = document.getElementById("ov-price-route-list");
  if (!model || !provider || !mode || !save || !status || !list) return;

  const loadRoutes = async () => {
    list.textContent = "";
    let routes = {};
    try {
      const result = await invoke("price_routes");
      routes = (result && result.routes) || {};
    } catch (_) { /* 读不到就不列，不影响填新的 */ }
    for (const [prefix, route] of Object.entries(routes)) {
      const row = document.createElement("div");
      row.className = "src-custom-row";
      const text = document.createElement("div");
      text.className = "src-custom-path";
      text.textContent = prefix + " → " + ((route || {}).provider || "?") +
        "（" + ((route || {}).mode === "subscription" ? "订阅" : "按量") + "）";
      const remove = document.createElement("button");
      remove.className = "btn secondary";
      remove.type = "button";
      remove.textContent = "撤销声明";
      remove.onclick = async () => {
        remove.disabled = true;
        try {
          await invoke("delete_price_route", { modelPrefix: prefix });
          status.hidden = false;
          status.textContent = "已撤销 " + prefix + " 的归属声明。";
          await loadRoutes();
        } catch (e) {
          remove.disabled = false;
          status.hidden = false;
          status.textContent = "撤销失败：" + errText(e);
        }
      };
      row.append(text, remove);
      list.appendChild(row);
    }
  };
  await loadRoutes();

  if (pendingPriceRoute) {
    model.value = pendingPriceRoute.model || "";
    provider.value = pendingPriceRoute.provider || "";
    status.hidden = false;
    status.textContent = "已预填待声明归属的型号，确认服务商后保存。";
    pendingPriceRoute = null;
  }

  if (save.dataset.bound === "1") return;
  save.dataset.bound = "1";
  save.onclick = async () => {
    status.hidden = false;
    if (!model.value.trim() || !provider.value.trim()) {
      status.textContent = "型号与服务商都要填。";
      return;
    }
    save.disabled = true;
    try {
      await invoke("save_price_route", { input: {
        model_prefix: model.value.trim(), provider_id: provider.value.trim(), mode: mode.value,
      } });
      status.textContent = "已声明；下一轮同步后这批用量会归到该服务商。";
      await loadRoutes();
      // 归属变化会改变未计价集合 → 同步一轮，让那条任务自动结算/前进到缺价卡。
      await invoke("trigger_sync").catch(() => {});
    } catch (e) {
      status.textContent = "声明失败：" + errText(e);
    } finally {
      save.disabled = false;
    }
  };
}

// 设置 › 价格目录 的「本月缺价卡的型号」清单（形状出处：runtime/src/mcp/data_status.rs
// `unpriced_models_month`：{harness, provider, model, tokens, covered}）。每行「补这张卡」
// 把服务商/型号预填进补卡表单并把光标放到第一个价格格；provider 为空（目录也认不出
// 归属）时先引导去「声明归属」。
function renderPriceMissingList(rows) {
  const wrap = document.getElementById("ov-price-missing");
  const list = document.getElementById("ov-price-missing-list");
  if (!wrap || !list) return;
  list.textContent = "";
  wrap.hidden = !rows.length;
  if (!rows.length) return;
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "src-custom-row";
    const text = document.createElement("div");
    text.className = "src-custom-path";
    const providerLabel = r.provider ? (PROVIDER_LABEL[r.provider] || r.provider) : "服务商未知";
    text.textContent = r.model + " · 补到 " + providerLabel + " 的卡 · 本月 " + fmtTokens(Number(r.tokens || 0)) + " tokens · " +
      (r.covered ? "在套餐内（只影响折算参考）" : "按量（影响按量费用）") + " · 经 " + (HARNESS_DISPLAY[r.harness] || r.harness);
    const fill = document.createElement("button");
    fill.className = "btn secondary";
    fill.type = "button";
    fill.textContent = r.provider ? "补这张卡" : "先声明归属";
    fill.onclick = () => {
      if (!r.provider) {
        const routeModel = document.getElementById("ov-price-route-model");
        if (routeModel) { routeModel.value = r.model; routeModel.focus && routeModel.focus(); }
        return;
      }
      const provider = document.getElementById("ov-price-card-provider");
      const model = document.getElementById("ov-price-card-model");
      const status = document.getElementById("ov-price-card-status");
      if (provider) provider.value = r.provider;
      if (model) model.value = r.model;
      if (status) { status.hidden = false; status.textContent = "已预填 " + providerLabel + " · " + r.model + "，填入六个价格（元/百万 token，不分峰谷就两格填同一个数）后保存。"; }
      const first = document.getElementById("ov-price-uncached-off");
      if (first && first.focus) first.focus();
    };
    row.append(text, fill);
    list.appendChild(row);
  }
}

async function renderPriceOverrideSettings() {
  const provider = document.getElementById("ov-price-card-provider");
  const model = document.getElementById("ov-price-card-model");
  const save = document.getElementById("ov-price-card-save");
  const status = document.getElementById("ov-price-card-status");
  const list = document.getElementById("ov-price-card-list");
  if (!provider || !model || !save || !status || !list) return;

  const loadCards = async () => {
    list.textContent = "";
    let cards = {};
    try {
      const result = await invoke("price_cards");
      cards = (result && result.cards) || {};
    } catch (_) { /* 读不到就不列，不影响填新卡 */ }
    for (const [providerId, models] of Object.entries(cards)) {
      for (const modelId of Object.keys(models || {})) {
        const row = document.createElement("div");
        row.className = "src-custom-row";
        const text = document.createElement("div");
        text.className = "src-custom-path";
        text.textContent = providerId + " · " + modelId;
        const remove = document.createElement("button");
        remove.className = "btn secondary";
        remove.type = "button";
        remove.textContent = "删掉这张卡";
        remove.onclick = async () => {
          remove.disabled = true;
          try {
            await invoke("delete_price_card", { providerId, modelId });
            status.hidden = false;
            status.textContent = "已删除 " + modelId + " 的价卡；相关用量回到未计价。";
            await loadCards();
          } catch (e) {
            remove.disabled = false;
            status.hidden = false;
            status.textContent = "删除失败：" + errText(e);
          }
        };
        row.append(text, remove);
        list.appendChild(row);
      }
    }
  };
  await loadCards();

  // 任务跳过来时预填（这样用户不用手抄型号）。
  if (pendingPriceCard) {
    provider.value = pendingPriceCard.provider || "";
    model.value = pendingPriceCard.model || "";
    status.hidden = false;
    status.textContent = "已预填待补卡的服务商与型号，填入价格后保存。";
    pendingPriceCard = null;
  }

  if (save.dataset.bound === "1") return;
  save.dataset.bound = "1";
  const official = document.getElementById("ov-price-card-official");
  if (official) official.onclick = async () => {
    status.hidden = false;
    if (!provider.value.trim() || !model.value.trim()) { status.textContent = "先填服务商与型号，再预填。"; return; }
    official.disabled = true;
    try {
      const r = await invoke("official_price_card", { providerId: provider.value.trim(), modelId: model.value.trim() });
      if (!r || !r.found) {
        status.textContent = "目录里没有这个型号的官方卡" + (r && r.reason ? "（" + r.reason + "）" : "") + "，只能手填或让 Agent 经 MCP 查价。";
        return;
      }
      const put = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
      put("ov-price-uncached-off", r.rates.input_uncached.off_peak); put("ov-price-uncached-peak", r.rates.input_uncached.peak);
      put("ov-price-cached-off", r.rates.input_cached.off_peak); put("ov-price-cached-peak", r.rates.input_cached.peak);
      put("ov-price-output-off", r.rates.output.off_peak); put("ov-price-output-peak", r.rates.output.peak);
      status.textContent = "已按 " + (PROVIDER_LABEL[r.provider] || r.provider) + " 的 CNY 官方卡（" + r.card_key + "）预填；" +
        "这是原厂标价，不是 " + provider.value.trim() + " 的实际价——可直接保存，也可改成实际价再存。";
    } catch (e) {
      status.textContent = "预填失败：" + errText(e);
    } finally {
      official.disabled = false;
    }
  };
  save.onclick = async () => {
    const readDim = (offId, peakId) => {
      const offRaw = document.getElementById(offId).value;
      const peakRaw = document.getElementById(peakId).value;
      // `Number("")` 是 0，不是 NaN——留空的格子曾经会被当成"填了 0"悄悄通过下面的
      // 非负校验，而不是被拦下来当半张卡拒绝。先判空串，别把"没填"读成"填了 0"。
      if (String(offRaw).trim() === "" || String(peakRaw).trim() === "") return null;
      const off = Number(offRaw);
      const peak = Number(peakRaw);
      if (!Number.isFinite(off) || off < 0 || !Number.isFinite(peak) || peak < 0) return null;
      return { off_peak: off, peak };
    };
    const dims = {
      input_uncached: readDim("ov-price-uncached-off", "ov-price-uncached-peak"),
      input_cached: readDim("ov-price-cached-off", "ov-price-cached-peak"),
      output: readDim("ov-price-output-off", "ov-price-output-peak"),
    };
    // 第四维可选：两格都空 → 不设这一档；填了任意一格就必须两格齐全，半档同样拒绝——
    // 与三个必填维同一条"半张卡不接受"纪律。
    const cwOffRaw = document.getElementById("ov-price-cachewrite-off").value.trim();
    const cwPeakRaw = document.getElementById("ov-price-cachewrite-peak").value.trim();
    const cacheWriteGiven = cwOffRaw !== "" || cwPeakRaw !== "";
    const cacheWrite = cacheWriteGiven ? readDim("ov-price-cachewrite-off", "ov-price-cachewrite-peak") : undefined;
    status.hidden = false;
    if (!provider.value.trim() || !model.value.trim()) {
      status.textContent = "服务商与型号都要填。";
      return;
    }
    if (Object.values(dims).some((d) => d === null)) {
      status.textContent = "六个价格都要填非负数字（半张卡会让计价按缺档算错钱，所以拒绝保存）。";
      return;
    }
    if (cacheWriteGiven && cacheWrite === null) {
      status.textContent = "缓存写入两格要么都填非负数字，要么都留空（半档同样会让计价按缺档算错钱）。";
      return;
    }
    save.disabled = true;
    try {
      await invoke("save_price_card", { input: {
        provider_id: provider.value.trim(), model_id: model.value.trim(),
        input_uncached: dims.input_uncached, input_cached: dims.input_cached, output: dims.output,
        ...(cacheWrite ? { cache_write: cacheWrite } : {}),
      } });
      status.textContent = "已保存；相关用量的折算与预算比例会按新价卡重算。";
      await loadCards();
      // 补卡会改变未计价集合 → 同步一轮，让那条约待处理任务自动结算。
      await invoke("trigger_sync").catch(() => {});
    } catch (e) {
      status.textContent = "保存失败：" + errText(e);
    } finally {
      save.disabled = false;
    }
  };
}

// Claude Pro 额度窗口提醒的开关。**默认关**，且读不出开关也按关处理
// （fail-closed：提醒类能力不因为"读不到设置"就假定用户同意过）。打开的那一刻
// 才申请系统通知权限（REQ-039），与保存预算时申请权限是同一套规矩。
async function renderQuotaReminderSettings() {
  const toggle = document.getElementById("ov-quota-reminder-toggle");
  const status = document.getElementById("ov-quota-reminder-status");
  if (!toggle) return;
  try {
    const config = await invoke("quota_reminder_config");
    toggle.checked = !!(config && config.enabled);
  } catch (_) {
    toggle.checked = false;
  }
  if (toggle.dataset.bound === "1") return;
  toggle.dataset.bound = "1";
  toggle.onchange = async () => {
    toggle.disabled = true;
    try {
      const saved = await invoke("save_quota_reminder_config", { enabled: toggle.checked });
      const permission = saved && saved.notification_permission;
      status.hidden = false;
      status.textContent = toggle.checked
        ? "已开启" + (permission && permission !== "Granted"
            ? "；系统通知未授权，可在系统设置中开启。" : "，窗口耗尽时会提醒一次。")
        : "已关闭额度窗口提醒。";
    } catch (e) {
      toggle.checked = !toggle.checked;
      status.hidden = false;
      status.textContent = "保存失败：" + errText(e);
    } finally {
      toggle.disabled = false;
    }
  };
}

async function loadSettingsData(preloadedOverview) {
  bindSettingsNav();
  bindDiagnosticExport();
  bindUpdateCheck();
  bindTrustedReleasesPage();
  await Promise.allSettled([
    renderBillsReadOnly(statisticsMonth()), renderRetentionSettings(),
    renderStatisticsTimezoneSettings(), renderPricingCatalogSettings(),
    renderAboutDiagnostics(), renderBudgetSettings(preloadedOverview),
    renderQuotaReminderSettings(), renderPriceOverrideSettings(), renderPriceRouteSettings(),
    renderMcpSettings(),
  ]);
}

// 设置 › MCP：三段接入配置（Claude Code / Codex / 通用 JSON）+ 三条可复制的
// prompt + 工具清单。CLI 路径来自 `mcp_setup_info`（与托盘同步同一份 resolve），
// 找不到 CLI 就明说，不给一条不存在的路径。复制走 navigator.clipboard，不可用时
// 退回选中文本（用户 ⌘C）。
function mcpConfigTexts(cliPath) {
  const bin = cliPath || "/path/to/agent-vitals";
  const shellBin = bin.includes(" ") ? JSON.stringify(bin) : bin;
  return {
    claude: "claude mcp add oh-agent -- " + shellBin + " data-mcp serve --allow-local-writes",
    codex: "[mcp_servers.oh-agent]\ncommand = " + JSON.stringify(bin) + "\nargs = [\"data-mcp\", \"serve\", \"--allow-local-writes\"]",
    json: JSON.stringify({ mcpServers: { "oh-agent": { command: bin, args: ["data-mcp", "serve", "--allow-local-writes"] } } }, null, 2),
  };
}
async function copyTextFrom(el) {
  const text = el ? el.textContent : "";
  try {
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch (_) { /* 退回选中 */ }
  try {
    const range = document.createRange(); range.selectNodeContents(el);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  } catch (_) { /* 无 DOM 选区 API */ }
  return false;
}
async function renderMcpSettings() {
  const status = document.getElementById("ov-mcp-status");
  if (!status) return;
  let info = null;
  try { info = await invoke("mcp_setup_info"); } catch (e) { status.textContent = "读取 MCP 信息失败：" + errText(e); }
  const cliPath = info && info.cli_path ? String(info.cli_path) : null;
  status.textContent = cliPath
    ? "本机 CLI：" + cliPath + (info.cli_version ? "（" + info.cli_version + "）" : "") + " · 数据目录：" + (info.data_home || "")
    : "未找到 agent-vitals CLI（托盘同步也会失败）——先安装 CLI 或把它放进 PATH，下面的命令里的路径需要你自己替换。";
  const texts = mcpConfigTexts(cliPath);
  const put = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  put("ov-mcp-claude", texts.claude); put("ov-mcp-codex", texts.codex); put("ov-mcp-json", texts.json);
  const tools = document.getElementById("ov-mcp-tools");
  if (tools) {
    tools.textContent = "";
    for (const t of (info && Array.isArray(info.tools) ? info.tools : [])) {
      const li = document.createElement("li");
      const code = document.createElement("code"); code.textContent = t.name;
      li.append(code, document.createTextNode(" — " + String(t.description || "").split(". ")[0]));
      tools.appendChild(li);
    }
  }
  const skillStatus = document.getElementById("ov-mcp-skill-status");
  const copyAll = document.getElementById("ov-mcp-copy-all");
  if (copyAll && copyAll.dataset.bound !== "1") {
    copyAll.dataset.bound = "1";
    copyAll.onclick = async () => {
      copyAll.disabled = true;
      try {
        const text = await invoke("mcp_skill_text");
        let ok = false;
        try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch (_) { /* fall through */ }
        if (skillStatus) { skillStatus.hidden = false; skillStatus.textContent = ok ? "已复制整份说明（约 " + Math.round(text.length / 100) / 10 + "K 字），直接贴给你的 Agent。" : "剪贴板不可用，请改用「下载 SKILL.md」。"; }
      } catch (e) {
        if (skillStatus) { skillStatus.hidden = false; skillStatus.textContent = "生成失败：" + errText(e); }
      } finally { copyAll.disabled = false; }
    };
  }
  const download = document.getElementById("ov-mcp-download-skill");
  if (download && download.dataset.bound !== "1") {
    download.dataset.bound = "1";
    download.onclick = async () => {
      download.disabled = true;
      try {
        const r = await invoke("export_mcp_skill");
        if (skillStatus) {
          skillStatus.hidden = false;
          skillStatus.textContent = r && r.status === "saved"
            ? "已保存 " + (r.file_name || "SKILL.md") + "。放进 ~/.claude/skills/agent-vitals-mcp/ 即安装。"
            : "已取消。";
        }
      } catch (e) {
        if (skillStatus) { skillStatus.hidden = false; skillStatus.textContent = "保存失败：" + errText(e); }
      } finally { download.disabled = false; }
    };
  }
  const panel = document.getElementById("ov-mcp-panel");
  if (panel && panel.dataset.bound !== "1" && panel.querySelectorAll) {
    panel.dataset.bound = "1";
    for (const btn of panel.querySelectorAll("button[data-copy]")) {
      btn.onclick = async () => {
        const ok = await copyTextFrom(document.getElementById(btn.dataset.copy));
        const original = btn.textContent;
        btn.textContent = ok ? "已复制" : "已选中，按 ⌘C";
        setTimeout(() => { btn.textContent = original; }, 1500);
      };
    }
  }
}

async function renderOverview() {
  bindOverviewLinks();
  const { data, errors, window: overviewWindow } = await loadOverviewData();
  const { daily, monthly, calendar: cal, overview: ov } = data;
  const unavailable = (key) => ({ status: "unavailable", ...errors[key], reason: errText(errors[key]) });
  const quality = data.quality || unavailable("quality");
  renderQualityStatus(quality);
  sourcesBrief(data.sources);
  renderBillingConfirmation(data.billingGroups || unavailable("billingGroups"),
    data.candidates || unavailable("candidates"));
  renderTrustRows(quality, monthly);
  renderBillingDeclarations(data.declarations || unavailable("declarations"));
  renderBillingRecalculationJobs(data.jobs || unavailable("jobs"));
  renderOverviewDays(cal);
  renderSpendCards(daily, monthly, ov && ov.fx, overviewWindow);
  bindSummaryExport(monthly);
  renderDualTrack(monthly);
  renderDecideCard(monthly, data.quota, data.claudeQuota);
  const overview = ov || { sync: { ok: false, stage: "unavailable", message: "暂无法读取同步状态" } };
  syncDot(overview.sync);
  renderFirstRunState(overview.sync);
  renderNoRecordsState(overview.sync, data.sources);

  // 预算 —— 读后端权威（level/ratio/snooze/reasons），不重算百分比。口径 =
  // 「订阅月费按天摊派 + 跨执行环境按量费用（三级口径）」（2026-09-17 产品定向，
  // 取代 09-07 的「按量实付」单口径；见 budget.rs::budget_profiles_status_sql_at）。
  // `source` 两态都是权威：
  // "alert" = 旧 alert.json 快照（带 generated_at，可能过期）；"sql" = SQL
  // 权威库**实时算**（无快照时刻 → generated_at null，结构上不会过期，新鲜度
  // 归下方「上次同步」行）。Phase 4.3 托盘已切 "sql"，工作台这里此前漏改，
  // 一直落进「等预算数据」兜底（screenshot 事故）。"missing" 才是真降级。
  //
  // 设置页规格 §8 D1：设置页的「预算（订阅 + 按量）」表单写的是 budget_profiles.estimate
  // （分币），这里原来只读旧 budget_config——两条链路没打通，设置页存的预算
  // 总览卡片看不到。改成优先读 estimate profile，没配置再回落旧链路，
  // 与托盘 lib.rs::budget_status_text_at、系统通知
  // budget_alerts.rs::maybe_notify 同一回落顺序。
  const legacyBudget = overview.budget || { source: "missing" };
  const profileRows = overview.budget_profiles && overview.budget_profiles.status === "ok" &&
    Array.isArray(overview.budget_profiles.profiles) ? overview.budget_profiles.profiles : [];
  const estimateProfile = profileRows.find((p) => p && p.profile_id === "estimate");
  const b = (estimateProfile && adaptEstimateProfileToBudget(estimateProfile, legacyBudget)) || legacyBudget;
  const budgetValid = overviewRecord(b) && ["sql", "alert"].includes(b.source)
    && ["no_budget", "ok", "warn", "over", "snoozed", "disabled"].includes(b.level) && (b.level === "no_budget" ||
      (overviewNumber(b.monthly_cny) && b.monthly_cny > 0 && overviewNumber(b.month_cost) && overviewNumber(b.month_ratio)))
    && (b.effective_daily_budget == null || overviewNumber(b.effective_daily_budget))
    && (b.reasons == null || (Array.isArray(b.reasons) && b.reasons.every((r) => typeof r === "string")));
  const budgetLive = b.source === "sql"; // 实时算：无 generated_at 不代表「没产出」
  const fill = document.getElementById("ov-budget-fill");
  const budgetSub = document.getElementById("ov-budget-sub");
  const budgetAmt = document.getElementById("ov-budget-amount");
  const budgetCard = document.getElementById("ov-budget-card");
  budgetSub.title = "";
  const denom = b.monthly_cny;
  // 规格 §4 第 80 行：预算「仅配置后出现摘要卡；未配置不显示 0%」。可见性由
  // 这里决定（仅 no_budget 隐藏；不可读显示降级说明），不得再用 CSS 无条件藏卡
  // ——那样 JS 写了读数、用户却看不到，且 vm 测试对 display:none 免疫。
  const budgetConfigured = (b.source === "alert" || b.source === "sql") && b.level && b.level !== "no_budget";
  if (budgetCard) budgetCard.hidden = budgetValid && b.level === "no_budget";
  const setBudgetLink = document.getElementById("ov-link-set-budget");
  if (setBudgetLink) setBudgetLink.hidden = budgetConfigured;
  // 新鲜度先算好——预算卡片自己也要用，不能只靠页面最下面那行 note。真实事故
  // （2026-09-01）：alert.json 停在 8 月最后一次 oneline（两天前），总览把它的
  // 292% 超支当"本月"现状展示，旁边的"本月"卡片同一时刻已经因为按当月过滤
  // 显示 ¥0——两个数字自相矛盾却都没有任何过期标记，用户没法从卡片本身判断
  // "这是不是真的"。5 分钟阈值与 `stale_from`（`lib.rs`，托盘文案用的同一个
  // 判据）保持一致，不新发明一套。
  let stale = false;
  let freshHHMM = "";
  if (budgetValid && b.generated_at && Number.isFinite(Date.parse(b.generated_at))) {
    const t = new Date(b.generated_at);
    freshHHMM = formatStatisticsDateTime(t, { hour: "2-digit", minute: "2-digit", hour12: false });
    stale = Date.now() - t.getTime() > 5 * 60 * 1000;
  }
  // 「预算已配置，但本月没有可计入的按量实付」是一件事，跟「读不到」是两件事。
  // 后端此时给的是 `monthly_cny: 1.0` + `month_cost: null` + `month_ratio: null`
  // （口径 = 跨执行环境按量实付，没确认计费方式前就是没有实付），旧代码把它塞进
  // 通用兜底，显示「预算状态暂不可读，请刷新重试」——用户会去点刷新，而它永远
  // 刷不出来。这与「本月支出」那两栏是同一件事，措辞也对齐（REQ-043）。
  const budgetConfiguredButNoSpend = overviewRecord(b) && ["sql", "alert"].includes(b.source)
    && b.level && b.level !== "no_budget"
    && overviewNumber(b.monthly_cny) && b.monthly_cny > 0
    && b.month_cost == null && b.month_ratio == null;
  if (budgetConfiguredButNoSpend) {
    fill.style.width = "0%";
    fill.className = "fill";
    budgetAmt.textContent = "—";
    budgetSub.textContent = "预算 " + fmtMoney(b.monthly_cny) + "/月 · 本月还没有可计入的按量实付";
    budgetSub.title = "";
  } else if (!budgetValid || (b.source !== "alert" && b.source !== "sql") || !b.level) {
    fill.style.width = "0%";
    fill.className = "fill";
    budgetAmt.textContent = "—";
    budgetSub.textContent = "预算状态暂不可读，请刷新重试";
  } else if (b.level === "no_budget") {
    fill.style.width = "0%";
    fill.className = "fill";
    budgetAmt.textContent = "—";
    budgetSub.textContent = "尚未设置预算 · 成本统计不受影响";
  } else {
    const ratio = Math.min(1, b.month_ratio);
    const daily =
      b.effective_daily_budget != null ? " · 日预算 " + fmtMoney(b.effective_daily_budget) : "";
    fill.style.width = fmtPct(ratio);
    const levelCls =
      b.level === "over" ? " danger" : b.level === "warn" ? " warn" : "";
    fill.className = "fill" + levelCls;
    // 大字 = 已用 / 预算（钱），副行 = 百分比 + 日预算 + 剩余天数；不把 68% 说两遍。
    budgetAmt.textContent = fmtMoney(b.month_cost) + " / " + fmtMoney(denom);
    const todayKeyB = overviewWindow.date;
    const daysInMonth = new Date(Number(todayKeyB.slice(0, 4)), Number(todayKeyB.slice(5, 7)), 0).getDate();
    const daysLeft = Math.max(0, daysInMonth - Number(todayKeyB.slice(8)));
    const tail = daily + " · 本月剩 " + daysLeft + " 天";
    // 拆分（订阅摊派 + 按量）在每个已配置态都要出现，不只 ok 态：2026-09-17 截图
    // 事故——超支态只写「已超预算 ¥958.5」，标题又叫「按量费用」，用户把
    // ¥1458.5 读成纯按量，其实里面 ¥253.9 是订阅月费摊派。
    const breakdown = b.month_cost_breakdown ? " · " + b.month_cost_breakdown : "";
    if (b.level === "over") {
      budgetSub.textContent = "已超预算 " + fmtMoney(Math.max(0, (b.month_cost) - denom)) + breakdown + tail;
    } else if (b.level === "snoozed") {
      budgetSub.textContent = "提醒已静默" + (b.snoozed_until ? "至 " + b.snoozed_until : "") + tail;
    } else if (b.level === "disabled") {
      budgetSub.textContent = "预算提醒已关闭" + tail;
    } else if (b.hasUnresolved) {
      // profile 口径的 incomplete：ratio_bp 本来就是 null（月额分母算不出可信
      // 百分比），month_ratio 在适配器里兜底成 0——这里绝不能显示「至少已用
      // 0%」，那是在编造精度。改用金额下界，与 settings 页
      // budgetProfileStatusText 同一措辞（"至少已用 X 元，仍有未覆盖用量"）。
      budgetSub.textContent = "至少已用 " + fmtMoney(b.month_cost) + "，仍有未覆盖用量" + breakdown + tail;
    } else {
      budgetSub.textContent = "已用 " + fmtPct(b.month_ratio) + breakdown + tail;
    }
    // 过期时把警告直接贴在数字旁边，不指望用户往下翻到页尾的 note 才看到——
    // 这条数字本身可能是几天前的旧账（比如日历月翻了页但当天还没有新会话
    // 触发过重新评估），过期提示必须跟数字长在一起。
    if (stale) {
      budgetSub.textContent = "⚠ 数据截至 " + freshHHMM + "，可能不是最新 · " + budgetSub.textContent;
    }
    budgetSub.title = (b.reasons || []).join("\n");
  }

  // 新鲜度 + 同步状态 + 立即同步（与弹窗同一套 poll-at-change 回路）。
  let freshness = "";
  if (budgetValid && b.generated_at && Number.isFinite(Date.parse(b.generated_at))) {
    freshness = stale ? "⚠ 数据过期（更新于 " + freshHHMM + "）" : "数据更新于 " + freshHHMM;
  } else if (budgetLive) {
    // 实时算无快照时刻——新鲜度由下方「上次同步」行统一承载（facts 同步是
    // 另一条回路），这里不说「尚未产出」（会误读成坏了）。
    freshness = "预算按最新数据实时计算";
  } else {
    freshness = "预算数据尚未生成";
  }
  const sync = overview.sync || { ok: false, stage: "never", message: "尚未同步" };
  const syncStatus = document.getElementById("ov-sync-status");
  const syncNow = document.getElementById("ov-sync-now");
  if (sync.stage === "paused") {
    syncStatus.textContent = "自动同步已暂停（到数据源页恢复）";
    syncStatus.title = sync.message || "恢复前不会读取新的本地日志";
    syncNow.hidden = true;
  } else if (sync.ok) {
    // sync.at 形状出处：overview.rs SyncStatus::ok → local_timestamp_text
    // "YYYY-MM-DD HH:MM:SS"（统计时区本地时间），slice(11,16) 即本地 HH:MM。
    syncStatus.textContent = sync.at ? "已更新 " + sync.at.slice(11, 16) : "已同步";
    syncStatus.title = sync.message + (sync.at ? "（" + sync.at + "）" : "");
    syncNow.hidden = true;
  } else if (sync.stage === "never") {
    syncStatus.textContent = "尚未同步（点右侧立即同步）";
    syncNow.hidden = false;
  } else {
    syncStatus.textContent = "⚠ 上次同步失败：" + (sync.message || "未知原因");
    syncStatus.title = sync.message;
    syncNow.hidden = false;
  }
  syncNow.disabled = false;
  bindOverviewSync(sync, syncNow, syncStatus);

  // 数据根简写放设置→关于（规格 §4 第 95 行），不再经 note 漏回首屏。
  document.getElementById("ov-note").textContent = freshness + " · " + (overview.estimate_note || "");

  // 「数据源」面板已并入费用明细（renderDualTrack 每行带 by_harness 新鲜度）；
  // 详细数据源卡在设置→数据源。
}

// Keep the existing 10 × 1s manual-sync poll and event-bridge suppression.
function bindOverviewSync(sync, syncNow, syncStatus) {
  syncNow.onclick = async () => {
    syncNow.disabled = true;
    syncStatus.textContent = "同步中…";
    const before = sync.at || "";
    // 事件桥与手点同刻完成：手动 poll 自己会重拉，事件到达时跳过（见
    // subscribeFoldEvent）。用 finally 保证任何出口（成功/失败/return）都复位，
    // 漏复位会让之后的事件全被误吞。
    manualSyncPolling = true;
    try {
      await invoke("trigger_sync");
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const o = await invoke("read_overview");
        if (o.sync && (o.sync.at || "") !== before) {
          renderOverview();
          return;
        }
      }
      renderOverview();
    } catch (e2) {
      syncStatus.textContent = "同步请求失败：" + errText(e2);
      syncNow.disabled = false;
    } finally {
      manualSyncPolling = false;
    }
  };
}

function bindDiagnosticExport() {
  const button = document.getElementById("ov-diagnostic-export");
  const status = document.getElementById("ov-diagnostic-status");
  if (!button || !status || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  button.onclick = async () => {
    button.disabled = true;
    status.hidden = false;
    status.textContent = "正在准备脱敏诊断包…不会上传本地数据。";
    try {
      const result = await invoke("export_diagnostic_package");
      status.textContent = result && result.status === "cancelled"
        ? "已取消保存。"
        : "诊断包已保存到你选择的位置；是否提交由你决定。";
    } catch (e) {
      status.textContent = "保存诊断包失败：" + errText(e);
    } finally {
      button.disabled = false;
    }
  };
}

const TRUSTED_RELEASES_ROOT = "https://github.com/Oh-Agent-AI/oh-agent/releases";
const APP_RELEASE_TAG = /^app-v[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
let lastUpdateReleaseUrl = null;

function trustedReleaseOpenUrl(url) {
  if (typeof url !== "string") return null;
  if (url === TRUSTED_RELEASES_ROOT) return url;
  const prefix = TRUSTED_RELEASES_ROOT + "/tag/";
  if (!url.startsWith(prefix)) return null;
  const tag = url.slice(prefix.length);
  if (!APP_RELEASE_TAG.test(tag)) return null;
  return url;
}

function bindTrustedReleasesPage() {
  const button = document.getElementById("ov-releases-open");
  if (!button || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  button.onclick = async () => {
    button.disabled = true;
    try {
      const url = trustedReleaseOpenUrl(lastUpdateReleaseUrl);
      await invoke("open_trusted_releases_page", url ? { url } : {});
    } catch (e) {
      const target = document.getElementById("ov-diagnostic-status");
      if (target) { target.hidden = false; target.textContent = "打开发布页失败：" + errText(e); }
    } finally { button.disabled = false; }
  };
}

function bindUpdateCheck() {
  const button = document.getElementById("ov-update-check");
  const status = document.getElementById("ov-diagnostic-status");
  if (!button || !status || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  button.onclick = async () => {
    button.disabled = true;
    status.hidden = false;
    status.textContent = "正在检查可信发布页…不会上传本地数据。";
    lastUpdateReleaseUrl = null;
    try {
      const result = await invoke("check_for_updates");
      lastUpdateReleaseUrl = result && result.update_available
        ? trustedReleaseOpenUrl(result.release_url)
        : null;
      status.textContent = result && result.latest_tag
        ? (result.update_available
          ? "有新版本 " + result.latest_tag + "（当前包 " + (result.current_version || "—") + "）；请从可信发布页下载，不会自动安装。"
          : "当前包 " + (result.current_version || "—") + " · 最新发布 " + result.latest_tag + "；请从可信发布页确认安装。")
        : (result && result.reason === "on_latest_stable"
          ? "当前已是最新正式版。"
          : (result && result.status === "unavailable" ? "版本检查暂不可用，稍后再试。" : "未找到可用的 app-v 发布。"));
    } catch (e) {
      status.textContent = "检查新版本失败：" + errText(e);
    } finally { button.disabled = false; }
  };
}

async function renderAboutDiagnostics() {
  const target = document.getElementById("ov-about-versions");
  if (!target || target.dataset.loaded === "1") return;
  // 常显版本表（规格 §4.5、B11）：App/CLI/数据库 schema/价格目录四行，不折叠。
  const row = (dt, dd) => {
    const t = document.createElement("dt"); t.textContent = dt;
    const d = document.createElement("dd"); d.textContent = dd;
    return [t, d];
  };
  try {
    const d = await invoke("about_diagnostics");
    const pricing = d && d.pricing
      ? (d.pricing.version + " · 捕获于 " + formatStatisticsDateTime(d.pricing.captured_at_ms))
      : "暂无价格快照";
    const sync = d && d.sync ? ((d.sync.ok ? "正常" : "需检查") + " · " + (d.sync.message || "")) : "暂无同步回执";
    target.textContent = "";
    target.append(
      ...row("App", d.app_version || "—"),
      ...row("CLI", d.cli_version || "未找到"),
      ...row("Engine", d.engine_version || "—"),
      ...row("架构", d.architecture || "—"),
      ...row("Authority schema", d.authority_schema || "—"),
      ...row("统计时区", d.statistics_timezone || "—"),
      ...row("价格目录", pricing),
      ...row("同步", sync),
    );
    target.dataset.loaded = "1";
  } catch (e) {
    target.textContent = "";
    target.append(...row("状态", "版本诊断读取失败：" + errText(e)));
  }
}

function renderFirstRunState(sync) {
  const panel = document.getElementById("ov-first-run");
  const sources = document.getElementById("ov-first-run-sources");
  const pause = document.getElementById("ov-first-run-pause");
  if (!panel || !sources || !pause) return;
  panel.hidden = !sync || sync.stage !== "never";
  if (!sources.dataset) sources.dataset = {};
  if (sources.dataset.bound === "1") return;
  sources.dataset.bound = "1";
  sources.onclick = () => switchTab("sources");
  pause.onclick = async () => {
    pause.disabled = true;
    try {
      await invoke("set_sync_paused", { paused: true });
      await renderOverview();
    } catch (e) {
      pause.disabled = false;
      console.warn("暂停解析失败", e);
    }
  };
}

function renderNoRecordsState(sync, report) {
  const panel = document.getElementById("ov-no-records");
  const sourcesButton = document.getElementById("ov-no-records-sources");
  const sampleButton = document.getElementById("ov-no-records-sample");
  const sample = document.getElementById("ov-no-records-sample-content");
  if (!panel || !sourcesButton || !sampleButton || !sample) return;
  panel.hidden = true;
  if (!sync || !sync.ok || sync.stage === "never" || sync.stage === "paused") return;
  // Failed source reads are not evidence of an empty database.
  if (!report || report.status !== "ok") return;
  const sources = report.sources;
  panel.hidden = sources.some((source) => {
    const scan = source.scan || {};
    const imported = source.import_scope || {};
    return Number(scan.source_count || 0) > 0 || Number(imported.sessions || 0) > 0;
  });
  if (sourcesButton.dataset.bound === "1") return;
  sourcesButton.dataset.bound = "1";
  sourcesButton.onclick = () => switchTab("sources");
  sampleButton.onclick = () => {
    sample.hidden = !sample.hidden;
    sample.textContent = sample.hidden
      ? ""
      : "演示样例（不会写入你的数据）：今天 126K tokens · 名义成本 ≈¥4.20 · 数据源：示例。";
    sampleButton.textContent = sample.hidden ? "查看样例" : "收起样例";
  };
}

function renderQualityStatus(status) {
  const banner = document.getElementById("ov-quality-banner");
  if (!banner) return;
  banner.hidden = true;
  banner.textContent = "";
  banner.className = "notice danger";
  if (!status || status.status !== "ok") {
    banner.hidden = false;
    const code = status && status.code;
    banner.appendChild(document.createTextNode(
      "⚠ " + (ERR_TEXT[code] || "权威数据状态不可用") + "：" +
      ((status && status.reason) || "未知原因")
    ));
    const action = status && status.recovery_action;
    if (action && action.kind) {
      const button = document.createElement("button");
      button.className = "btn secondary";
      button.type = "button";
      button.textContent = action.label || "查看恢复选项";
      button.style.marginLeft = "8px";
      button.onclick = async () => {
        if (action.kind === "export_diagnostics") {
          button.disabled = true;
          try {
            await invoke("export_diagnostic_package");
            button.textContent = "诊断包已保存";
          } catch (e) {
            button.textContent = "保存失败：" + errText(e);
            button.disabled = false;
          }
        } else if (action.kind === "restore_backup") {
          if (!window.confirm("选择一个已验证的权威数据库备份并恢复？\n\n当前数据库会先保留为 .pre-restore 备份；不会删除执行环境原始日志。")) return;
          button.disabled = true;
          try {
            const restored = await invoke("restore_authority_backup");
            button.textContent = restored && restored.status === "cancelled"
              ? "已取消选择备份"
              : "备份已恢复，正在重新加载…";
            if (restored && restored.status === "restored") {
              window.setTimeout(() => window.location.reload(), 250);
            }
          } catch (e) {
            button.textContent = "恢复失败：" + errText(e);
            button.disabled = false;
          }
        } else if (action.kind === "upgrade_app") {
          button.textContent = "请安装新版本后重试";
        } else {
          switchTab("sources");
        }
      };
      banner.appendChild(button);
    }
    return;
  }
  // 路由/缺价/价格快照的 warn 级信息由两条可信度状态行承载（renderTrustRows），
  // 不再在这里重复成横幅——同一事实说两遍是 IA 复核抓到的问题。横幅只留
  // critical：权威库 integrity 失败，恢复 = rm + data-migrate，必须最显眼。
  const d = status.data || {};
  if (d.health !== "critical") return;
  banner.hidden = false;
  banner.textContent = "⚠ 权威数据健康状态 critical：金额与用量可能不完整，请到设置→关于与诊断查看恢复选项。";
}

function billingCandidateAmount(candidate) {
  const amount = Number(candidate.amount_minor || 0) / 100;
  if (candidate.currency === "CNY") return fmtMoney(amount) + "/月";
  return amount.toFixed(2) + " " + (candidate.currency || "") + "/月";
}

function budgetProfileLevelText(level) {
  return {
    ok: "正常",
    warn: "接近预算",
    exceeded: "已超预算",
    incomplete: "部分覆盖",
    no_data: "无数据",
    disabled: "未启用",
  }[level] || String(level || "未知状态");
}

// 设置页规格 §8 D1：总览预算卡改读 budget_profiles.estimate（用户在设置页保存的
// 新预算），空时回落旧 budget_config 链路（ov.budget）——与托盘
// （lib.rs::budget_status_text_at）、系统通知（budget_alerts.rs::maybe_notify）
// 同一回落顺序，否则设置页存的预算总览看不到（两条链路各算各的）。
//
// 把 profile 字段翻成总览预算卡已有的 legacy 形状（level/month_ratio/…），
// 不新建一套渲染分支：
//   exceeded → over；warn/incomplete → warn（incomplete 的"部分覆盖"细节走
//   hasUnresolved 标记单独接文案，不占用 level，因为 level 还要驱动进度条颜色
//   且下游校验只认 no_budget/ok/warn/over/snoozed/disabled 这几个值）；
//   ok/no_data → ok（no_data 就是"这个月还没花钱"，不是"数据缺失"）。
// 全局静默（budget_snoozes 表）覆盖 profile 自己不感知的 snoozed 态——
// profile 状态本身不检查 snooze，只有旧 alert 链路检查，所以要从 legacy 借
// snoozed_until 来判断，否则设置页点"本周期静默提醒"后总览卡片不会变。
function adaptEstimateProfileToBudget(profile, legacy) {
  const monthlyCny = profile.monthly_minor != null ? Number(profile.monthly_minor) / 100 : null;
  if (!(monthlyCny > 0)) return null; // 月额缺失或非正数：当作未配置，回落 legacy
  const snoozedUntil = legacy && legacy.snoozed_until;
  const snoozedActive = !!snoozedUntil && Number.isFinite(Date.parse(snoozedUntil)) && Date.parse(snoozedUntil) > Date.now();
  const level = snoozedActive ? "snoozed"
    : profile.level === "exceeded" ? "over"
    : (profile.level === "warn" || profile.level === "incomplete") ? "warn"
    : "ok";
  // 已用 = 按量（三级口径）+ 订阅月费按天摊派（2026-09-17：预算消耗要反映订阅+按量
  // 的总体，否则只有订阅的用户永远看到 ¥0）。旧载荷没有 total_spent_minor 时退回 spent。
  const metered = Number(profile.metered_spent_minor ?? profile.spent_minor ?? 0) / 100;
  const amortized = Number(profile.subscription_amortized_minor || 0) / 100;
  const total = profile.total_spent_minor != null ? Number(profile.total_spent_minor) / 100 : metered;
  // 副行只放两项金额（卡片一行放不下摊派细节），摊派规则进 tooltip（reasons）。
  const parts = [];
  const reasons = [];
  if (amortized > 0) {
    const fx = profile.subscription_fx_applied ? "≈" : "";
    parts.push("订阅摊派 " + fx + fmtMoney(amortized));
    reasons.push("订阅月费 " + fx + fmtMoney(Number(profile.subscription_minor || 0) / 100) + "/月，按已过 " +
      Number(profile.subscription_days_elapsed || 0) + "/" + Number(profile.days_in_month || 0) + " 天摊派" +
      (profile.subscription_fx_applied ? "（异币月费按参考汇率折算）" : ""));
  }
  // 按量恒带 ≈：estimate profile 的按量是三级口径（账单 > 归因估算 > 默认估算），
  // 归因估算在计费方无价卡时退回原厂官方价（`fair-market-fallback`，保留报价币种），
  // 与真实账单可差数倍（2026-09-17 真机：胜算云估 ¥1204.6、实付 ¥316）。
  if (metered > 0 || amortized === 0) parts.push("按量 ≈" + fmtMoney(metered));
  if (profile.has_unresolved) reasons.push("存在未定价或异币金额，已用金额只是当前预算币种的下界");
  return {
    source: "sql", // 与旧版 "sql" 态同义：都是无快照时刻的实时 SQL 计算。
    level,
    month_cost: total,
    month_cost_breakdown: parts.join(" + "),
    monthly_cny: monthlyCny,
    month_ratio: profile.ratio_bp != null ? Number(profile.ratio_bp) / 10000 : 0,
    effective_daily_budget: profile.daily_minor != null ? Number(profile.daily_minor) / 100 : null,
    generated_at: null,
    snoozed_until: snoozedActive ? snoozedUntil : null,
    reasons: reasons.length ? reasons : null,
    hasUnresolved: !!profile.has_unresolved,
  };
}

// `*_minor` 是最小货币单位（分 / cent），与 budget.rs `budget_profile_spent_minor`
// 同口径。此前直接 String() 拼进文案，设置页显示「已用 864 CNY」而总览同一
// 数字是 ¥8.64——差 100 倍（2026-09-15 浏览器巡检发现）。
function fmtMinor(minor, currency) {
  if (minor == null) return "—";
  return fmtCur(minor / 100, currency || null);
}

function budgetProfileStatusText(profile) {
  if (!profile || !profile.level) return "尚未配置此预算口径";
  const currency = profile.currency || "";
  const monthlyLevel = budgetProfileLevelText(profile.level);
  // 已用 = total_spent_minor（订阅摊派 + 按量），与总览卡、托盘同口径——此前读
  // 纯按量的 spent_minor，设置页与总览同一预算显示两个不同的「已用」。旧载荷
  // 没有 total 时退回 spent。有订阅摊派时括号里给拆分。
  const monthlySpent = profile.total_spent_minor ?? profile.spent_minor;
  const amortized = Number(profile.subscription_amortized_minor || 0);
  const monthlyBreakdown = amortized > 0
    ? "（订阅摊派 " + fmtMinor(amortized, currency) + " + 按量 " +
      fmtMinor(profile.metered_spent_minor ?? profile.spent_minor ?? 0, currency) + "）"
    : "";
  // no_data / disabled 是事实状态，不得用 spent_minor 的默认 0 伪装成
  // “已用 0”。incomplete 可以展示已知下界，但要明确仍有未覆盖用量。
  let monthly = "本月：" + monthlyLevel;
  if (profile.level === "incomplete") {
    monthly += " · 至少已用 " + fmtMinor(monthlySpent, currency) + monthlyBreakdown + "，仍有未覆盖用量";
  } else if (!["no_data", "disabled"].includes(profile.level)) {
    monthly += " · 已用 " + fmtMinor(monthlySpent, currency) + monthlyBreakdown;
  }
  if (!profile.daily_level || profile.daily_level === "disabled") return monthly;
  const dailyLevel = budgetProfileLevelText(profile.daily_level);
  const dailySpent = profile.daily_total_minor ?? profile.daily_spent_minor;
  let daily = "；今日：" + dailyLevel;
  if (profile.daily_level === "incomplete") {
    daily += " · 至少已用 " + fmtMinor(dailySpent, currency) + "，仍有未覆盖用量";
  } else if (profile.daily_level !== "no_data") {
    daily += " · 已用 " + fmtMinor(dailySpent, currency);
  }
  return monthly + daily;
}

let billingDeclarationTarget = null;
let billingDeclarationState = null;
let billingReviewOpen = false;

async function renderBudgetSettings(preloadedOverview) {
  const currencySelect = document.getElementById("ov-budget-currency");
  const monthly = document.getElementById("ov-budget-monthly-amount");
  const daily = document.getElementById("ov-budget-daily-amount");
  const save = document.getElementById("ov-budget-save");
  const status = document.getElementById("ov-budget-settings-status");
  const legacy = document.getElementById("ov-budget-legacy");
  const legacyText = document.getElementById("ov-budget-legacy-text");
  const live = document.getElementById("ov-budget-live");
  const snoozeText = document.getElementById("ov-budget-snooze-text");
  const snoozeDay = document.getElementById("ov-budget-snooze-day");
  const snoozeClear = document.getElementById("ov-budget-snooze-clear");
  const confirmedBox = document.getElementById("ov-budget-confirmed");
  const confirmedText = document.getElementById("ov-budget-confirmed-text");
  if (!currencySelect || !monthly || !daily || !save || !status || !legacy || !live ||
      !snoozeDay || !snoozeClear || !confirmedBox) return;

  const updateSymbols = () => {
    const symbol = currencySelect.value === "USD" ? "$" : "¥";
    document.querySelectorAll(".ov-budget-symbol").forEach((el) => { el.textContent = symbol; });
  };
  currencySelect.onchange = updateSymbols;

  let estimateProfile = null;
  try {
    // read_overview 只用来读「本周期静默」这一个字段（它挂在旧 alert 链路上）。
    // 设置 tab 进入时已经拉过一次并传进来，没有就退回自己拉——两次 read_overview
    // 是同一份数据，重复拉纯粹是浪费（每次约 120-360ms）。
    const [config, profileStatus, ov] = await Promise.all([
      invoke("budget_config"),
      invoke("budget_profiles_status", { month: statisticsMonth() }),
      preloadedOverview !== undefined
        ? Promise.resolve(preloadedOverview)
        : invoke("read_overview").catch(() => null),
    ]);
    const profiles = profileStatus && profileStatus.status === "ok" ? (profileStatus.profiles || []) : [];
    estimateProfile = profiles.find((p) => p.profile_id === "estimate") || null;
    // 旧版 config.toml/兼容表预算：只读提示，不再提供编辑入口（规格 §4.3.3）；
    // 保存下面的表单后以新预算（estimate profile）为准，不自动转换口径。
    // **显示条件是"这行预算仍在生效"（有正数月额且没有 estimate profile），
    // 不是 origin === "legacy_import"**：origin 只是来源标注（缺失 = 历史版本
    // 没记录，budget.rs 注释要求"显示未知而非猜测"——是措辞未知，不是整条藏掉）。
    // 真机（2026-09-15）：budget_config 里 09-09 seed 的 ¥1/月没有 origin 文件，
    // 总览卡照用它显示「预算 ¥1/月」，设置页却一片空白，两处互相矛盾。
    const legacyMonthly = config && config.status === "ok" ? Number(config.monthly_cny_minor || 0) / 100 : 0;
    if (legacyMonthly > 0 && !estimateProfile) {
      legacy.hidden = false;
      const origin = config.origin === "legacy_import" ? "旧版预算"
        : config.origin === "user" ? "早期版本保存的预算"
        : "来源未记录的预算";
      legacyText.textContent = "检测到" + origin + " " + fmtMoney(legacyMonthly) +
        "/月。它仍在生效（总览预算卡读的就是它）；保存下面的预算后将以新预算为准。";
    } else {
      legacy.hidden = true;
    }
    if (estimateProfile) {
      currencySelect.value = estimateProfile.currency || "CNY";
      monthly.value = estimateProfile.monthly_minor != null ? (Number(estimateProfile.monthly_minor) / 100).toFixed(2) : "";
      daily.value = estimateProfile.daily_minor != null ? (Number(estimateProfile.daily_minor) / 100).toFixed(2) : "";
    }
    updateSymbols();
    live.hidden = !(estimateProfile && estimateProfile.level);
    if (estimateProfile && estimateProfile.level) live.textContent = budgetProfileStatusText(estimateProfile);
    const confirmedProfile = profiles.find((p) => p.profile_id === "confirmed" && p.monthly_minor != null);
    confirmedBox.hidden = !confirmedProfile;
    if (confirmedProfile && confirmedText) confirmedText.textContent = budgetProfileStatusText(confirmedProfile);
    // 静默状态目前只挂在旧 alert 链路（`read_overview().budget.snoozed_until`）；
    // 一个静默同时压住 profile 通知和旧版通知（budget_alerts.rs 的读取顺序）。
    const snoozedUntil = ov && ov.budget && ov.budget.snoozed_until;
    const snoozedActive = !!snoozedUntil && Date.parse(snoozedUntil) > Date.now();
    snoozeDay.hidden = snoozedActive;
    snoozeClear.hidden = !snoozedActive;
    snoozeText.textContent = snoozedActive
      ? "本周期提醒已静默至 " + formatStatisticsDateTime(new Date(snoozedUntil), { month: "2-digit", day: "2-digit" }) + "。"
      : "";
  } catch (_) { /* 预算读取失败不遮蔽总览；表单保持空态可直接填写 */ }

  if (save.dataset.bound === "1") return;
  save.dataset.bound = "1";
  const refreshAfterBudgetAction = async (message) => {
    status.hidden = false;
    status.textContent = message;
    await renderBudgetSettings();
    await renderOverview();
  };
  snoozeDay.onclick = async () => {
    snoozeDay.disabled = true;
    try {
      await invoke("snooze_budget_current_period");
      await refreshAfterBudgetAction("提醒已静默至本周期结束；用量与成本统计仍会继续更新。");
    } catch (e) {
      status.hidden = false;
      status.textContent = "静默失败：" + errText(e);
    } finally {
      snoozeDay.disabled = false;
    }
  };
  snoozeClear.onclick = async () => {
    snoozeClear.disabled = true;
    try {
      await invoke("clear_budget_snooze");
      await refreshAfterBudgetAction("提醒已恢复。");
    } catch (e) {
      status.hidden = false;
      status.textContent = "恢复失败：" + errText(e);
    } finally {
      snoozeClear.disabled = false;
    }
  };
  save.onclick = async () => {
    const m = Math.round(Number(monthly.value) * 100);
    const dailyText = daily.value.trim();
    const d = dailyText === "" ? null : Math.round(Number(dailyText) * 100);
    status.hidden = false;
    if (!Number.isSafeInteger(m) || m <= 0 || (d !== null && (!Number.isSafeInteger(d) || d <= 0))) {
      status.textContent = "请填写正数月预算；日预算可留空。";
      return;
    }
    save.disabled = true;
    try {
      const saved = await invoke("save_budget_profile", { input: {
        profile_id: "estimate", currency: currencySelect.value, monthly_minor: m,
        daily_minor: d, warning_ratio_bp: 8000,
      } });
      const permission = saved && saved.notification_permission;
      status.textContent = "已保存 " + formatStatisticsDateTime(new Date(), { hour: "2-digit", minute: "2-digit" }) + "。" +
        (permission && permission !== "Granted" ? "系统通知未授权，可在系统设置中开启。" : "");
      await renderOverview();
    } catch (e) {
      status.textContent = "保存失败：" + errText(e);
    } finally {
      save.disabled = false;
    }
  };
}


function statisticsMidnightMs(year, monthIndex, day) {
  const civilMs = Date.UTC(year, monthIndex, day);
  let guess = civilMs;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: statisticsTimezoneName(),
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  // Solve UTC = local civil midnight - offset(UTC). Re-evaluate the offset so
  // a midnight crossing a DST boundary uses the offset valid at that instant.
  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
    const projectedMs = Date.UTC(
      Number(values.year), Number(values.month) - 1, Number(values.day),
      Number(values.hour), Number(values.minute), Number(values.second),
    );
    const next = civilMs - (projectedMs - guess);
    if (next === guess) return next;
    guess = next;
  }
  return guess;
}

function billingMonthWindow(month) {
  const parts = String(month || "").split("-").map(Number);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const start = statisticsMidnightMs(parts[0], parts[1] - 1, 1);
  const end = statisticsMidnightMs(parts[1] === 12 ? parts[0] + 1 : parts[0], parts[1] === 12 ? 0 : parts[1], 1);
  return { start, end };
}

function parseBillingCsvLine(line) {
  const cells = [], re = /(?:^|,)("(?:[^"]|"")*"|[^,]*)/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    const cell = match[1] || "";
    cells.push(cell.startsWith('"') && cell.endsWith('"')
      ? cell.slice(1, -1).replace(/""/g, '"') : cell.trim());
  }
  return cells;
}

function parseBillingCsv(text) {
  const required = ["harness", "provider_id", "billing_period", "billing_basis", "amount_minor", "currency", "evidence_ref"];
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length || JSON.stringify(parseBillingCsvLine(lines[0])) !== JSON.stringify(required)) {
    return { rows: [], errors: ["第1行表头不匹配，必须使用模板字段"] };
  }
  const rows = [], errors = [], seen = new Set();
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseBillingCsvLine(lines[i]);
    if (cells.length !== required.length) { errors.push("第" + (i + 1) + "行字段数错误"); continue; }
    const [harness, provider_id, billing_period, billing_basis, amountText, currency, evidence_ref] = cells;
    const amount_minor = Number(amountText);
    const key = [harness, provider_id, billing_period, billing_basis, evidence_ref].join("\u0000");
    if (!harness || !provider_id || !/^\d{4}-(0[1-9]|1[0-2])$/.test(billing_period) ||
        !["fixed_subscription", "harness_billed", "metered_actual", "metered_estimate", "api_equivalent"].includes(billing_basis) ||
        !Number.isSafeInteger(amount_minor) || amount_minor < 0 || !/^[A-Z]{3}$/.test(currency) || !evidence_ref) {
      errors.push("第" + (i + 1) + "行字段值无效");
    } else if (seen.has(key)) {
      errors.push("第" + (i + 1) + "行与 CSV 内已有记录重复");
    } else {
      seen.add(key);
      rows.push({ harness, provider_id, billing_period, billing_basis, amount_minor, currency, evidence_ref });
    }
  }
  return { rows, errors };
}

// 与 authority::harness_bill_put 的唯一键保持同构：重复导入同一行必须是更正/幂等，
// 不能因为导入时间不同而生成另一条账单身份。
function billingCsvBillId(row) {
  return "csv-" + [row.harness, row.provider_id, row.billing_period,
    row.billing_basis, row.evidence_ref].map(encodeURIComponent).join(":");
}

const BILLING_REVIEW_DEFER_KEY = "agent-vitals-billing-review-deferred-at-ms";
const BILLING_REVIEW_DEFER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function deferBillingReviewPrompt() {
  const value = String(Date.now());
  try { localStorage.setItem(BILLING_REVIEW_DEFER_KEY, value); } catch (_) { /* best effort */ }
  try { sessionStorage.setItem(BILLING_REVIEW_DEFER_KEY, value); } catch (_) { /* best effort */ }
}

// 五选一关系各自对数字的真实影响（计费主链规格 §5.3 表）。Beta 只有官方订阅会
// 改变金额；其余三种只记录关系或承担者，UI 必须照实说，不能让「组织承担」看起来
// 像省了钱。
const BILLING_RELATIONSHIP_EFFECT = Object.freeze({
  official_subscription: "命中的用量将移出按量估算，进入「订阅覆盖」；填写的月费即按此声明计入「订阅月费」与实际支出（自报口径），之后录到真实账单时以账单为准校准。",
  official_api: "命中的用量按官方价卡估算并计入按量费用（估算，带 ≈）；录入账单后以账单为准。",
  third_party: "命中的用量归到这家计费方名下、按它的价卡估算（价卡没收录的模型按原厂标价折算成结算币种，带 ≈）；录入账单后以账单为准。",

  organization: "只改变费用承担者标签；金额与估算状态不变，不等于免费。",
  unknown: "保持按量估算与不确定标记；进入待处理，30 天内不再抢占首屏。",
});

// 关系种类 → 列表里的短标签（弹窗里的长解释见 BILLING_RELATIONSHIP_EFFECT）。
const BILLING_RELATIONSHIP_LABEL = Object.freeze({
  official_subscription: "官方订阅",
  official_api: "官方 API（按量）",
  third_party: "经中转 / 第三方（按量）",
  organization: "组织承担",
  unknown: "未定",
});

// 重算任务 error_code → 用户文案（规格 §5.10）。原始 SQLite 错误串不上卡面。
const BILLING_JOB_ERROR_COPY = Object.freeze({
  worker_busy: "另一次重算正在进行",
  interrupted: "上次退出时中断",
  worker_failed: "重算未能完成",
  preview_failed: "重算未能完成",
  fact_match_failed: "重算未能完成",
  attribution_kind_failed: "重算未能完成",
  transaction_start_failed: "重算未能完成",
  transaction_failed: "重算未能完成",
});

function billingJobErrorText(job) {
  if (!job) return "";
  const copy = BILLING_JOB_ERROR_COPY[job.error_code];
  return copy || (job.error_code ? "重算未能完成（" + job.error_code + "）" : "重算未能完成");
}

function billingAmountsText(amounts) {
  const rows = Array.isArray(amounts) ? amounts.filter((a) => a && a.currency) : [];
  if (!rows.length) return "";
  return rows.map((a) => fmtMinor(a.amount_minor, a.currency)).join(" / ");
}

const BILLING_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function monthStartDate(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month + "-01" : month;
}

function monthEndDate(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).toISOString().slice(0, 10);
}

function minBillingDate(left, right) {
  return left < right ? left : right;
}

// 声明适用区间的统一文案。结束为空＝持续有效（选填，见 `syncBillingDateBounds`）。
// **不能直接拼 `"–" + end`**：`null` 会拼成字面量 "null" 出现在界面上；旧的分组行
// 用 `end !== start` 做判断，对 null 恒真，正好踩中这条。
function billingRangeText(start, end) {
  const from = String(start == null ? "" : start);
  const to = String(end == null ? "" : end);
  if (!from) return to ? to : "";
  if (!to) return from + " 起（持续有效）";
  return to === from ? from : from + " – " + to;
}

// 路由证据里这几种已经说明「走的是官方路由」，不必再问用户；其余（missing /
// inferred / conflict / config-current / env-current）才需要用户明确。
const BILLING_ROUTE_KNOWN_OFFICIAL = new Set([
  "explicit-official-route", "session-native",
]);

// 「缺什么问什么」的判定（计费主链规格 v1.2 §5.3a）。三个布尔决定弹窗展示哪几步。
function billingMissing(target) {
  const provider = !target.provider_id || target.provider_id === "<unknown>";
  const route = !BILLING_ROUTE_KNOWN_OFFICIAL.has(target.evidence_basis || "missing");
  return { provider, route, mode: true };
}

// 批量键：执行环境、服务商、未知原因（证据 + 计价依据）、适用日期相同的组一起处理。
function billingBatchKey(row) {
  return [row.harness, row.provider_id || "<unknown>", row.evidence_basis || "missing",
    row.pricing_basis || "unavailable", row.effective_start || "", row.effective_end || ""].join("|");
}

// 从三步选择推导 relationship_kind；`unknown` 不是声明，只做展示与降级。
function billingRelationshipFromSteps(missing, routeValue, modeValue) {
  const route = missing.route ? routeValue : "official";
  // 路由先说话：中转/仍不确定这两条路根本不需要计费方式（选项行此时是隐藏的）。
  if (route === "unknown") return "unknown";
  if (route === "third_party") return "third_party";
  // 官方路由下没选计费方式就是没回答——不能悄悄落成「官方订阅」
  // （规格 §4「无证据 → 不预选」）。
  if (!String(modeValue || "").trim()) return "";
  if (modeValue === "api") return "official_api";
  if (modeValue === "organization") return "organization";
  return "official_subscription";
}

// 打开「明确计费方式」弹窗。`target` 是一个待确认组（`billing_confirmation_groups`
// 的一行）；`rows` 是面板里的全部行，用来找可批量处理的同类组。只有旧资产候选、
// 当月无用量时，调用方把候选包装成组形状（`model_id` 为空，旧候选的月份在表单
// 中展开为该月首日/末日）。声明边界按北京时间日期。
function openBillingDeclaration(target, rows, preset) {
  const panel = document.getElementById("ov-billing-declaration-panel");
  const context = document.getElementById("ov-billing-declaration-context");
  const missingText = document.getElementById("ov-billing-missing");
  const preview = document.getElementById("ov-billing-preview");
  const start = document.getElementById("ov-billing-start");
  const end = document.getElementById("ov-billing-end");
  const scope = document.getElementById("ov-billing-scope-text");
  const batchRow = document.getElementById("ov-billing-batch-row");
  const batch = document.getElementById("ov-billing-batch");
  const batchText = document.getElementById("ov-billing-batch-text");
  const providerRow = document.getElementById("ov-billing-provider-row");
  const provider = document.getElementById("ov-billing-provider");
  const routeRow = document.getElementById("ov-billing-route-row");
  const route = document.getElementById("ov-billing-route");
  const modeRow = document.getElementById("ov-billing-mode-row");
  const mode = document.getElementById("ov-billing-mode");
  if (!panel || !context || !preview || !start || !end || !route || !mode) return;
  preset = preset || {};
  // 程序判定的预置（自动归因规格 §5.1）：已知的步骤不再问，只预填并展示依据；
  // 「不对，我来改」把所有步骤重新放出来。
  const missing = billingMissing(target);
  if (!preset.override) {
    if (preset.providerKnown) missing.provider = false;
    if (preset.routeKnown) missing.route = false;
  } else {
    missing.provider = true; missing.route = true;
  }
  const key = billingBatchKey(target);
  const peers = (Array.isArray(rows) ? rows : []).filter((row) => row !== target && !row.resolvedCandidate
    && Number(row.tokens || 0) > 0 && row.model_id && billingBatchKey(row) === key);
  // 程序判定且用户没有推翻时，声明的 evidence_ref 记 `auto:<依据>`（规格 §5.3 阶段 1：
  // 判定是程序的，写入是用户一次确认的，可追溯）。
  const autoBasis = preset.verdict && !preset.override && Array.isArray(preset.verdict.basis) && preset.verdict.basis.length
    ? preset.verdict.basis.slice() : null;
  billingDeclarationTarget = { ...target, missing, peers, batchKey: key, autoBasis };
  billingDeclarationState = null;
  for (const id of ["ov-billing-provider", "ov-billing-route", "ov-billing-mode", "ov-billing-batch",
    "ov-billing-subscription-name", "ov-billing-subscription-amount", "ov-billing-subscription-currency",
    "ov-billing-amount-unknown", "ov-billing-start", "ov-billing-end", "ov-billing-subscription-anchor"]) {
    const control = document.getElementById(id);
    if (control) control.disabled = false;
  }
  if (provider) provider.value = preset.provider && missing.provider ? preset.provider : "";
  route.value = preset.route || "official";
  const presetMode = preset.verdict && preset.verdict.billing_mode;
  mode.value = preset.mode || (presetMode === "metered" ? "api" : presetMode === "subscription" ? "subscription" : "");
  // 订阅字段：有旧资产候选就预填它的套餐金额/币种，让用户核对而不是重填。
  const subscriptionName = document.getElementById("ov-billing-subscription-name");
  const subscriptionAmount = document.getElementById("ov-billing-subscription-amount");
  const subscriptionCurrency = document.getElementById("ov-billing-subscription-currency");
  const amountUnknown = document.getElementById("ov-billing-amount-unknown");
  if (subscriptionName) subscriptionName.value = preset.plan && preset.plan.label ? preset.plan.label : "";
  if (amountUnknown) amountUnknown.checked = false;
  if (subscriptionAmount) subscriptionAmount.value = target.candidate && Number.isFinite(Number(target.candidate.amount_minor))
    ? (Number(target.candidate.amount_minor) / 100).toFixed(2) : "";
  if (subscriptionCurrency && target.candidate && target.candidate.currency) subscriptionCurrency.value = target.candidate.currency;
  if (providerRow) providerRow.hidden = !missing.provider;
  if (routeRow) routeRow.hidden = !missing.route;
  if (batchRow && batch && batchText) {
    batchRow.hidden = peers.length === 0;
    batch.checked = peers.length > 0;
    const all = [target, ...peers];
    batchText.textContent = "将同时处理 " + all.length + " 个模型、" +
      all.reduce((sum, row) => sum + Number(row.session_count || 0), 0) + " 个会话、" +
      fmtTokens(all.reduce((sum, row) => sum + Number(row.tokens || 0), 0)) +
      " tokens（同一执行环境、同一未知原因、同一适用日期）";
  }
  const asks = [];
  if (missing.provider) asks.push("服务商");
  if (missing.route) asks.push("路由");
  asks.push("计费方式");
  if (missingText) {
    const verdict = preset.verdict;
    const known = [];
    if (verdict && !missing.provider && verdict.billing_party) known.push("服务商 " + verdict.billing_party);
    if (verdict && !missing.route) known.push(verdict.route_state === "official" ? "官方路由" : "执行环境自报官方路由");
    if (verdict && verdict.plan && verdict.plan.label) {
      known.push(verdict.plan.label + (verdict.plan.anchor_date ? "（每月 " + Number(verdict.plan.anchor_date.slice(8, 10)) + " 日续费，订阅自 " + verdict.plan.anchor_date + "）" : ""));
    }
    missingText.textContent = (known.length ? "程序已判定：" + known.join(" · ") + "。" : "") +
      (asks.length ? "待补充：" + asks.join("、") + "。" : "") +
      "只需确认或补齐，不要求一次填完整表单；这一步只明确计费关系，不证明已付款。";
  }
  const batchModels = document.getElementById("ov-billing-batch-models");
  const batchToggle = document.getElementById("ov-billing-batch-models-toggle");
  if (batchModels) {
    batchModels.textContent = "";
    batchModels.hidden = true;
    if (batchToggle) {
      const total = peers.length + 1;
      const label = (open) => (open ? "收起模型清单" : "查看这 " + total + " 个模型");
      batchToggle.textContent = label(false);
      batchToggle.setAttribute("aria-expanded", "false");
      batchToggle.onclick = () => {
        batchModels.hidden = !batchModels.hidden;
        batchToggle.textContent = label(!batchModels.hidden);
        batchToggle.setAttribute("aria-expanded", batchModels.hidden ? "false" : "true");
      };
    }
    for (const row of [target, ...peers]) {
      const chip = document.createElement("span");
      chip.className = "bd-model" + (row === target ? " is-target" : "");
      chip.textContent = (row.model_id || "全部模型") + " · " + fmtTokens(Number(row.tokens || 0));
      chip.title = Number(row.session_count || 0) + " 个会话";
      batchModels.appendChild(chip);
    }
  }
  const currentMonth = statisticsMonth();
  start.value = monthStartDate(target.effective_start || currentMonth);
  const today = new Date().toISOString().slice(0, 10);
  end.value = target.effective_end
    ? (BILLING_DATE_RE.test(target.effective_end) ? target.effective_end : monthEndDate(target.effective_end))
    : minBillingDate(monthEndDate(currentMonth), today);
  end.value = minBillingDate(end.value, today);
  // 起止两条约束必须**成对**给，否则选择器能拼出一个永远不成立的区间：
  //   · 起始晚于今天 → 在「结束 ≤ 今天」的前提下永远无法满足「结束 ≥ 起始」（服务端两条
  //     一起校验，必然拒绝）；
  //   · 结束早于起始 → 只有保存时才报错，选择器里看不出来。
  // 所以起始也封顶到今天，结束以起始为下界（`syncBillingDateBounds` 在改动时重算）。
  // 结束是**选填**的：上面几行只是给个默认值，「持续有效」勾选框才是"不设结束日期"的
  // 入口（原生 date 控件清不出空，见 `syncBillingOpenEnded`）。
  start.max = today;
  end.max = today;
  end.min = start.value;
  const openEnded = document.getElementById("ov-billing-open-ended");
  if (openEnded) {
    // 组自己带结束日（`unresolved_billing_groups_in` 恒给统计月）→ 默认不勾、保持有界；
    // 只有真的没有结束日的组才默认勾上。
    openEnded.checked = !target.effective_end;
    openEnded.disabled = false;
    syncBillingOpenEnded();
  }
  syncBillingScopeModels();
  // 组自己的默认起止（切换计费方式时用来撤销程序写进去的订阅锚点，见
  // `syncBillingDeclarationSteps`）。
  billingDeclarationTarget.defaultStart = start.value;
  billingDeclarationTarget.defaultEnd = end.value;
  // 订阅锚点：账户证据里的订阅开始日（subscriptionCreatedAt）优先，否则组的首日；
  // 用户想的是"哪天订的、每月扣多少"，不是起止日期（规格 §4 第 5 步）。
  const anchor = document.getElementById("ov-billing-subscription-anchor");
  if (anchor) {
    const planAnchor = preset.plan && BILLING_DATE_RE.test(String(preset.plan.anchor_date || "")) ? preset.plan.anchor_date : null;
    anchor.value = minBillingDate(planAnchor || start.value, today);
    anchor.max = today;
    // 只有账户证据给出来的锚点才算「程序写进去的」——没有锚点时 anchor 只是组的首日，
    // 用它做值比较会在每次 restep 时误撤回用户手改的结束日期（验收审查 iteration 4 #1）。
    billingDeclarationTarget.anchorDate = planAnchor;
    billingDeclarationTarget.anchorApplied = false;
  }
  const amountText = billingAmountsText(target.estimated_amounts);
  context.textContent = target.harness + " · " + (missing.provider ? "服务商未知" : target.provider_id) +
    (target.model_id ? " · " + target.model_id : " · 全部模型");
  const stats = document.getElementById("ov-billing-declaration-stats");
  if (stats) {
    stats.textContent = fmtTokens(Number(target.tokens || 0)) + " tokens · " +
      Number(target.session_count || 0) + " 个会话 · " + billingEvidenceLabel(target.evidence_basis) +
      (amountText ? " · 当前按量估算 " + amountText : (Number(target.tokens || 0) > 0 ? " · 无价卡，仅计 token" : "")) +
      (target.candidate ? " · 旧版本套餐记录：" + target.candidate.provider_id + " " +
        billingCandidateAmount(target.candidate) + " 自 " + target.candidate.billing_period_start + " 起" : "");
  }
  syncBillingScopeText();
  preview.hidden = true;
  preview.textContent = "";
  const save = document.getElementById("ov-billing-save");
  save.disabled = false;
  save.textContent = "预览影响";
  syncBillingDeclarationSteps();
  const backdrop = document.getElementById("ov-billing-backdrop");
  if (backdrop) backdrop.hidden = false;
  panel.hidden = false;
  panel.scrollIntoView({ block: "nearest" });
}

function closeBillingDeclaration() {
  const panel = document.getElementById("ov-billing-declaration-panel");
  const backdrop = document.getElementById("ov-billing-backdrop");
  if (panel) panel.hidden = true;
  if (backdrop) backdrop.hidden = true;
}

// 起止是一对约束：起始封顶今天（声明不能从未来开始），结束以起始为下界。任何一处改动
// 都重算一次，选择器里就不会出现"看起来能选、其实永远不合法"的区间。
//
// 「结束选填」不靠把这个框清空实现——原生 `<input type="date">` 根本没有"未设置"这个
// 状态：点开日历弹窗选不出空，清空只能全选删除，用户看到「选填」却做不到（2026-09-16
// 真机复验）。入口是旁边的「持续有效」勾选框，见 `syncBillingOpenEnded`。
function syncBillingDateBounds() {
  const start = document.getElementById("ov-billing-start");
  const end = document.getElementById("ov-billing-end");
  if (!start || !end) return;
  const today = new Date().toISOString().slice(0, 10);
  start.max = today;
  end.max = today;
  end.min = start.value || "";
  // 起始被改到结束之后：把结束抬到起始，别留下一个已经非法的区间。结束为空（＝持续
  // 有效）时不参与——否则勾了「持续有效」再改起始，就会把字段填回去、把勾选架空。
  if (start.value && end.value && end.value < start.value) end.value = start.value;
}

// 「持续有效」是结束日期的**唯一**可发现入口，也是这个字段唯一说得清"没设结束"的形态。
// 勾选 → 结束日期为空且禁用（保存时发 null，作用范围句写「持续有效」）；取消勾选 →
// 恢复当天（或组自己的默认结束日）并重新同步成对约束。切换计费方式时必须能撤销它，
// 见 `syncBillingDeclarationSteps` 的订阅分支。
function syncBillingOpenEnded() {
  const box = document.getElementById("ov-billing-open-ended");
  const end = document.getElementById("ov-billing-end");
  const target = billingDeclarationTarget;
  if (!box || !end) return;
  if (box.checked) {
    end.value = "";
    end.disabled = true;
    return;
  }
  end.disabled = false;
  if (!end.value) {
    const today = new Date().toISOString().slice(0, 10);
    const fallback = (target && target.defaultEnd) || monthEndDate(statisticsMonth());
    end.value = minBillingDate(fallback, today);
    syncBillingDateBounds();
  }
}

// 作用范围一句话跟着批量勾选与日期变：执行环境 · N 个模型（首个 等）· 起–止（北京时间）。
function syncBillingScopeText() {
  const target = billingDeclarationTarget;
  const scope = document.getElementById("ov-billing-scope-text");
  if (!target || !scope) return;
  const start = document.getElementById("ov-billing-start");
  const end = document.getElementById("ov-billing-end");
  const rows = billingSelectedRows();
  const models = rows.map((row) => row.model_id).filter(Boolean);
  const modelText = !target.model_id ? "全部模型"
    : models.length === 1 ? models[0]
    : models.length + " 个模型（" + models[0] + " 等）";
  // 不设结束日（勾了「持续有效」）时这里必须跟着说出来——否则那个「?」会被读成
  // "还没填完"，用户就会去填一个自己并不知道的日期。
  const rangeText = billingRangeText((start && start.value) || "", (end && end.value) || "");
  scope.textContent = "作用范围：" + target.harness + " · " +
    (target.missing.provider ? "待选服务商" : target.provider_id) + " · " + modelText + " · " +
    (rangeText || "?") + "（北京时间日期）。";
}

// 当前弹窗里选中的模型集合（批量勾选时 = 目标组 + 同类组）。
function billingSelectedRows() {
  const target = billingDeclarationTarget;
  if (!target) return [];
  const batch = document.getElementById("ov-billing-batch");
  const useBatch = batch && batch.checked && !document.getElementById("ov-billing-batch-row").hidden;
  return useBatch ? [target, ...(target.peers || [])] : [target];
}

function billingDeclarationScopes() {
  const target = billingDeclarationTarget;
  if (!target) return [];
  const scopes = [];
  const providerUnresolved = !!(target.missing && target.missing.provider);
  if (providerUnresolved) scopes.push({ scope_kind: "provider", scope_value: "unresolved" });
  // 模型作用域：默认按计费方级匹配，之后同计费方的新模型名自动沿用（声明是持续生效的规则，不是模型
  // 清单快照），所以只在用户明确勾了「仅限这些模型」时写——**服务商未知的组除外**：那类声明匹配的是
  // 「服务商为空」的事实，声明本身不再绑执行环境，不带模型就成了对所有执行环境、所有未知服务商用量的兜底，
  // 会把别的中转 / 别的执行环境的用量一并吞掉。模型是这类答复唯一的收窄依据，必须写。
  const modelsOnly = document.getElementById("ov-billing-scope-models");
  if ((modelsOnly && modelsOnly.checked) || providerUnresolved) {
    for (const row of billingSelectedRows()) {
      if (row.model_id && row.model_id !== "<unknown>") scopes.push({ scope_kind: "model", scope_value: row.model_id });
    }
  }
  // 结算币种（按量/中转/组织承担）：挂在作用域表上的声明属性，不是匹配条件
  // （数据层 `valid_scope` 认 `settlement`）。月费与币种成对的 CHECK 不允许只填币种，
  // 所以不走 currency 列。
  const kind = billingCurrentRelationship();
  const settlement = document.getElementById("ov-billing-settlement-currency");
  if (kind !== "official_subscription" && kind !== "unknown" && settlement && settlement.value) {
    scopes.push({ scope_kind: "settlement", scope_value: settlement.value });
  }
  return scopes;
}

// 「仅限这些模型」行：有具名模型时才显示；默认 = 有界声明勾上（历史修正只盖看到的
// 模型）、持续有效不勾（新模型沿用）。`syncBillingOpenEnded` 每次切换时重设默认。
function syncBillingScopeModels() {
  const row = document.getElementById("ov-billing-scope-row");
  const box = document.getElementById("ov-billing-scope-models");
  const text = document.getElementById("ov-billing-scope-models-text");
  const openEnded = document.getElementById("ov-billing-open-ended");
  if (!row || !box || !text) return;
  const models = billingSelectedRows().map((r) => r.model_id).filter((m) => m && m !== "<unknown>");
  const unique = Array.from(new Set(models));
  row.hidden = unique.length === 0;
  if (!unique.length) { box.checked = false; return; }
  box.checked = !(openEnded && openEnded.checked);
  text.textContent = "仅限这 " + unique.length + " 个模型（不勾：该计费方之后出现的新模型也沿用这条声明）";
}

function billingCurrentRelationship() {
  const target = billingDeclarationTarget;
  if (!target) return "official_subscription";
  return billingRelationshipFromSteps(target.missing,
    document.getElementById("ov-billing-route").value, document.getElementById("ov-billing-mode").value);
}

function billingDeclaredProvider() {
  const target = billingDeclarationTarget;
  if (!target) return "";
  if (!target.missing.provider) return target.provider_id;
  const input = document.getElementById("ov-billing-provider");
  return String((input && input.value) || "").trim();
}

// 按三步的当前值显示/隐藏后续步骤与结果说明。
function syncBillingDeclarationSteps() {
  const target = billingDeclarationTarget;
  if (!target) return;
  const route = document.getElementById("ov-billing-route");
  const modeRow = document.getElementById("ov-billing-mode-row");
  const effect = document.getElementById("ov-billing-relationship-effect");
  const subscription = document.getElementById("ov-billing-subscription-fields");
  const routeValue = target.missing.route ? route.value : "official";
  if (modeRow) modeRow.hidden = routeValue !== "official";
  const kind = billingCurrentRelationship();
  if (effect) effect.textContent = BILLING_RELATIONSHIP_EFFECT[kind] || "";
  if (subscription) subscription.hidden = kind !== "official_subscription";
  // 结算币种：只对非订阅关系问；默认按计费方猜（目录已知币种 → 用它；.com/.cn 之类
  // 国内域名 → CNY；其余 → CNY）。用户改过就不再覆盖（`settlementTouched`）。
  const settlementRow = document.getElementById("ov-billing-settlement-row");
  const settlement = document.getElementById("ov-billing-settlement-currency");
  if (settlementRow) settlementRow.hidden = kind === "official_subscription" || kind === "unknown";
  if (settlement && !target.settlementTouched) {
    const providerInput = document.getElementById("ov-billing-provider");
    const providerId = (target.missing && target.missing.provider && providerInput ? providerInput.value : target.provider_id) || "";
    settlement.value = billingDefaultSettlementCurrency(providerId);
  }
  // 订阅：适用范围由程序给——从订阅日起、持续有效——不问起止；按量/组织/中转才有起止。
  const datesRow = document.getElementById("ov-billing-dates-row");
  const anchor = document.getElementById("ov-billing-subscription-anchor");
  const anchorText = document.getElementById("ov-billing-subscription-anchor-text");
  const start = document.getElementById("ov-billing-start");
  const end = document.getElementById("ov-billing-end");
  if (datesRow) datesRow.hidden = kind === "official_subscription";
  if (kind === "official_subscription" && anchor && start && end) {
    const value = String(anchor.value || "").trim();
    if (BILLING_DATE_RE.test(value)) {
      start.value = value;
      // 订阅是**持续关系**：范围由程序给（订阅日起），结束日留空＝持续有效。
      // **不能写 today**——那会让声明在月底"到期"：下个月月费凭空归零（订阅费是按月
      // 付的，概况「订阅月费」直接读它），覆盖也停在上次重算的时刻。2026-09-16 真机：
      // 声明了 anthropic 20 USD/月，次月概况的订阅月费消失。
      const openEndedBox = document.getElementById("ov-billing-open-ended");
      if (openEndedBox) openEndedBox.checked = true;
      syncBillingScopeModels();
      syncBillingOpenEnded();
      if (typeof syncBillingDateBounds === "function") syncBillingDateBounds();
      // 「程序写进去的订阅范围」这个事实要记下来：切到按量/组织/中转时按它撤回。
      // 判据是「程序写过」而不是当前值——按量路径上用户自己勾的「持续有效」不能被
      // 这里抹掉（同 `anchorApplied` 的教训，验收审查 iteration 4 #1）。
      target.subscriptionRangeApplied = true;
      target.anchorApplied = Boolean(target.anchorDate && value === target.anchorDate);
      if (anchorText) anchorText.textContent = "每月 " + Number(value.slice(8, 10)) + " 日扣款 · 适用 " + value + " 起（持续有效）；不用填起止，程序按订阅期归因与计费。";
    } else if (anchorText) {
      anchorText.textContent = "填订阅开始（首次扣款）日期，程序按它算适用范围。";
    }
  } else if ((target.subscriptionRangeApplied || target.anchorApplied) && start && end) {
    // 离开订阅（切到按量/组织/中转）：撤回**程序**写进去的订阅起止与「持续有效」。
    // 判据是「程序写过」这个事实，不是值相等——值相等对没有锚点的组恒成立，会在每次
    // restep 时抹掉用户手改的结束日期（验收审查 iteration 4 #1）；锚点本身不撤回，
    // 真机锚点 2025-07-20 就会变成按量声明的 effective_start（同一份审查 iteration 3 #5）。
    // 不撤回「持续有效」更糟：用户点了「订阅」再切「按量 API」，日期行重新出现、结束日
    // 是空的——那是程序刚填的，不是用户选的，等于静默造出一条开放期的按量声明
    // （2026-09-16 守卫抓到：`end` 空且勾选框仍勾着）。
    // 有意保留的行为：用户亲手改过订阅日期后切到按量，起始日保留用户的值（不再撤回到
    // 组首日）——「只撤回程序写的」是对这条路径的唯一解释，且该字段当时可见、可改。
    if (target.defaultStart) start.value = target.defaultStart;
    if (target.defaultEnd) end.value = target.defaultEnd;
    const openEndedBox = document.getElementById("ov-billing-open-ended");
    if (openEndedBox) openEndedBox.checked = false;
    syncBillingScopeModels();
    end.disabled = false;
    target.subscriptionRangeApplied = false;
    target.anchorApplied = false;
  }
  // 只给可见步骤编号：服务商未知时是 1 2 3 4 5，路由已知时是 1 2 3。
  let step = 0;
  for (const id of ["ov-billing-provider-row", "ov-billing-route-row", "ov-billing-mode-row",
    "ov-billing-settlement-row", "ov-billing-subscription-fields", "ov-billing-dates-row"]) {
    const row = document.getElementById(id);
    if (!row) continue;
    const badge = row.querySelector && row.querySelector(".bd-step");
    if (row.hidden) { if (badge) badge.textContent = ""; continue; }
    step += 1;
    if (badge) badge.textContent = String(step);
  }
  syncBillingScopeText();
}

// 计费方 → 默认结算币种。目录里有的用目录（PROVIDER_SETTLEMENT）；带国内域名的
// 中转（`.com`/`.cn` 结尾的胜算云之类）→ CNY；其余 CNY。这只是表单默认值，保存的
// 是用户看到并可改的那一项。
const PROVIDER_SETTLEMENT = Object.freeze({
  anthropic: "USD", openai: "USD", "deepseek-official": "CNY", shengsuanyun: "CNY",
  minimax: "CNY", "zhipu-glm": "CNY", moonshot: "CNY",
});
function billingDefaultSettlementCurrency(providerId) {
  const id = String(providerId || "").trim().toLowerCase().replace(/^(www|api|router|gateway)\./, "").replace(/\.(com\.cn|com|cn|ai|io|net|org)$/, "");
  return PROVIDER_SETTLEMENT[id] || "CNY";
}

function billingSubscriptionInput() {
  const unknown = document.getElementById("ov-billing-amount-unknown");
  const amount = document.getElementById("ov-billing-subscription-amount");
  const currency = document.getElementById("ov-billing-subscription-currency");
  const name = document.getElementById("ov-billing-subscription-name");
  const subscriptionName = String((name && name.value) || "").trim() || null;
  if (unknown && unknown.checked) return { subscriptionName, amountMinor: null, currency: null };
  const raw = String((amount && amount.value) || "").trim();
  if (!raw) return { error: "请填写月费，或勾选「金额暂不清楚」。" };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return { error: "月费必须是不小于 0 的数字。" };
  return { subscriptionName, amountMinor: Math.round(value * 100), currency: (currency && currency.value) || "CNY" };
}

function billingPreviewText(impact, relationshipKind) {
  const moved = impact.moved || {}, kept = impact.kept || {}, pending = impact.pending || {};
  const movedAmount = billingAmountsText(moved.amounts);
  let text = relationshipKind === "official_subscription"
    ? "预计从按量估算中移出 " + fmtTokens(Number(moved.tokens || 0)) + " tokens · " +
      Number(moved.session_count || 0) + " 个会话" + (movedAmount ? " · " + movedAmount : "") +
      (Number(moved.unpriced_tokens || 0) > 0 ? "（其中 " + fmtTokens(Number(moved.unpriced_tokens)) + " tokens 无价卡，只计 token）" : "")
    : "此选项不改变金额：命中 " + fmtTokens(Number(moved.tokens || 0)) + " tokens · " +
      Number(moved.session_count || 0) + " 个会话仍按量估算" +
      (billingAmountsText(moved.estimated_amounts) ? "（" + billingAmountsText(moved.estimated_amounts) + "）" : "");
  text += "；保持估算 " + fmtTokens(Number(kept.tokens || 0)) + " tokens" +
    (billingAmountsText(kept.amounts) ? "（" + billingAmountsText(kept.amounts) + "）" : "");
  if (Number(pending.tokens || 0) > 0) {
    text += "；仍待确认 " + fmtTokens(Number(pending.tokens)) + " tokens（路由证据冲突，不会被声明吞掉）";
  }
  const models = (impact.scopes || []).filter((s) => s.scope_kind === "model").map((s) => s.scope_value);
  text += "。范围：" + impact.harness + " · " + impact.provider_id +
    (models.length > 3 ? " · " + models.length + " 个模型" : (models.length ? " · " + models.join("、") : "")) +
    " · " + billingRangeText(impact.effective_start, impact.effective_end) + "。";
  return text;
}

function bindBillingDeclarationPanel() {
  const save = document.getElementById("ov-billing-save");
  const cancel = document.getElementById("ov-billing-cancel");
  const start = document.getElementById("ov-billing-start");
  const end = document.getElementById("ov-billing-end");
  if (!save || save.dataset.bound === "1") return;
  save.dataset.bound = "1";
  cancel.onclick = closeBillingDeclaration;
  const close = document.getElementById("ov-billing-close");
  if (close) close.onclick = closeBillingDeclaration;
  // 点击半透明遮罩关闭；Esc 同。保存中途关闭不影响已入队的重算——任务留在「重算状态」。
  const backdrop = document.getElementById("ov-billing-backdrop");
  if (backdrop) backdrop.onclick = closeBillingDeclaration;
  if (typeof document.addEventListener === "function") {
    document.addEventListener("keydown", (event) => {
      const panel = document.getElementById("ov-billing-declaration-panel");
      if (event.key === "Escape" && panel && !panel.hidden) closeBillingDeclaration();
    });
  }
  const resetPreview = () => {
    if (billingDeclarationState && billingDeclarationState.phase === "saved") return;
    billingDeclarationState = null;
    save.textContent = "预览影响";
    const preview = document.getElementById("ov-billing-preview");
    preview.hidden = true;
    preview.textContent = "";
  };
  const restep = () => { syncBillingDeclarationSteps(); resetPreview(); };
  for (const id of ["ov-billing-provider", "ov-billing-route", "ov-billing-mode", "ov-billing-batch",
    "ov-billing-subscription-name", "ov-billing-subscription-amount", "ov-billing-subscription-currency",
    "ov-billing-amount-unknown"]) {
    const control = document.getElementById(id);
    if (control) control.onchange = restep;
  }
  if (start) start.onchange = () => { syncBillingDateBounds(); syncBillingScopeText(); resetPreview(); };
  if (end) end.onchange = () => { syncBillingScopeText(); resetPreview(); };
  const openEnded = document.getElementById("ov-billing-open-ended");
  if (openEnded) openEnded.onchange = () => { syncBillingOpenEnded(); syncBillingScopeModels(); syncBillingScopeText(); resetPreview(); };
  const settlementSel = document.getElementById("ov-billing-settlement-currency");
  if (settlementSel) settlementSel.onchange = () => { if (billingDeclarationTarget) billingDeclarationTarget.settlementTouched = true; resetPreview(); };
  const anchor = document.getElementById("ov-billing-subscription-anchor");
  if (anchor) anchor.onchange = restep;
  save.onclick = async () => {
    const target = billingDeclarationTarget;
    if (!target) return;
    const preview = document.getElementById("ov-billing-preview");
    const relationshipKind = billingCurrentRelationship();
    const providerId = billingDeclaredProvider();
    const today = new Date().toISOString().slice(0, 10);
    const fail = (message) => { preview.hidden = false; preview.textContent = message; };
    if (target.missing.provider && !providerId) {
      return fail("请先选择这批用量的服务商。");
    }
    if (relationshipKind === "official_subscription") {
      const anchorValue = String((anchor && anchor.value) || "").trim();
      if (!BILLING_DATE_RE.test(anchorValue)) return fail("订阅日期格式应为 YYYY-MM-DD。");
      if (anchorValue > today) return fail("订阅日期不能晚于今天（北京时间）。");
      syncBillingDeclarationSteps();
    }
    const effectiveStart = String(start.value || "").trim();
    // 结束是选填的：走「持续有效」勾选框（`syncBillingOpenEnded` 会把字段清空并禁用），
    // 所以空值在这里是合法状态，不是"格式错误"，也不能拿去做字符串比较——`"" < start`
    // 恒真，会把不设结束日误判成"结束早于起始"而拒绝保存。
    const effectiveEnd = String(end.value || "").trim();
    if (!BILLING_DATE_RE.test(effectiveStart)) {
      return fail("起始日期格式应为 YYYY-MM-DD。");
    }
    if (effectiveEnd && !BILLING_DATE_RE.test(effectiveEnd)) {
      return fail("结束日期格式应为 YYYY-MM-DD；不设结束日期请勾「持续有效」。");
    }
    if (effectiveEnd && effectiveEnd < effectiveStart) {
      return fail("结束日期不能早于起始日期。");
    }
    if (effectiveEnd && effectiveEnd > today) {
      return fail("结束日期不能晚于今天（北京时间）。");
    }
    if (!relationshipKind) {
      return fail("请选择计费方式：官方订阅 / 官方 API（按量）/ 组织承担。");
    }
    const subscription = relationshipKind === "official_subscription" ? billingSubscriptionInput() : { subscriptionName: null, amountMinor: null, currency: null };
    if (subscription.error) return fail(subscription.error);
    save.disabled = true;
    try {
      const scopes = billingDeclarationScopes();
      if (scopes.some((sc) => sc.scope_kind === "provider") &&
          !scopes.some((sc) => ["model", "route", "account", "session"].includes(sc.scope_kind))) {
        return fail("这组用量的服务商未知、也没有可识别的模型，无法限定声明范围（否则会变成对所有用量的兜底）。请先确认具体模型后再声明。");
      }
      // 「仍不确定」不是一条计费声明：它必须继续保留组和按量估算，不改变
      // provider 与金额，不能显示为已解决。先展示影响，第二次点击只记录 30 天
      // 的提醒降级，组留在待处理列表里（AC28）。
      if (relationshipKind === "unknown" &&
          (!billingDeclarationState || billingDeclarationState.phase !== "unknown_preview")) {
        const impact = await invoke("billing_candidate_impact_preview", {
          providerId: providerId || target.provider_id, relationshipKind,
          effectiveStart, effectiveEnd: effectiveEnd || null, scopes,
        });
        preview.hidden = false;
        if (impact.status !== "ok") {
          preview.textContent = "影响预览暂不可用，这组用量继续待确认：" + (impact.reason || "请稍后重试");
          save.disabled = false;
          return;
        }
        billingDeclarationState = { phase: "unknown_preview", impact };
        preview.textContent = "仍保持按量估算：" + fmtTokens(Number(impact.moved.tokens || 0)) +
          " tokens · " + Number(impact.moved.fact_count || 0) + " 条事实 · " +
          Number(impact.moved.session_count || 0) + " 个会话；这组用量继续待确认，留在待处理列表，未创建计费声明。";
        save.textContent = "保持待确认并返回";
        save.disabled = false;
        return;
      }
      if (relationshipKind === "unknown" && billingDeclarationState?.phase === "unknown_preview") {
        deferBillingReviewPrompt();
        billingReviewOpen = false;
        billingDeclarationTarget = null;
        billingDeclarationState = null;
        closeBillingDeclaration();
        await renderOverview();
        return;
      }
      if (!billingDeclarationState || billingDeclarationState.phase !== "preview") {
        const impact = await invoke("billing_candidate_impact_preview", {
          providerId, relationshipKind, effectiveStart, effectiveEnd: effectiveEnd || null, scopes,
        });
        preview.hidden = false;
        if (impact.status !== "ok") {
          preview.textContent = "影响预览暂不可用，尚未保存声明：" + (impact.reason || "请稍后重试");
          save.disabled = false;
          return;
        }
        billingDeclarationState = { phase: "preview", impact, relationshipKind, effectiveStart, effectiveEnd };
        preview.textContent = "保存前影响预览：" + billingPreviewText(impact, relationshipKind) + "确认后才会保存声明并重新归因。";
        save.textContent = "确认并保存声明";
        save.disabled = false;
        return;
      }

      // 预览之后的确认，一次用户动作 = 保存版本化修订 →（官方订阅时）入队重新归因
      // 与重算 → 回执原位展示 → 重算完成后刷新总览/用量/会话/待处理。此前「保存」与
      // 「应用」是两次点击，只保存不应用会留下声明已存在、数字未变的半状态（规格 G6）。
      const impact = billingDeclarationState.impact;
      const suffix = Date.now().toString(36);
      const declarationId = "decl-" + suffix;
      const revisionId = "rev-" + suffix;
      const candidate = target.candidate || null;
      const selected = billingSelectedRows();
      const saved = await invoke("save_billing_declaration_revision", {
        revisionId, declarationId, supersedesRevisionId: null,
        providerId, relationshipKind,
        subscriptionName: subscription.subscriptionName,
        // 月费只来自表单：勾了「金额暂不清楚」就写空，不拿旧候选的金额偷偷补上
        // （候选金额已在打开弹窗时预填，用户看得见、改得了）。
        amountMinor: subscription.amountMinor,
        currency: subscription.currency,
        effectiveStart, effectiveEnd: effectiveEnd || null,
        sourceCandidateId: candidate ? candidate.candidate_id : null,
        evidenceRef: (target.autoBasis ? "auto:" + target.autoBasis.join("+") + ";" : "") +
          (candidate ? "legacy-import-candidate:" + candidate.candidate_id
            : "confirmation-group:" + selected.map((row) => row.group_id || "").join(",")),
        scopes,
      });
      billingDeclarationState = { phase: "saved", declarationId, revisionId, impact, relationshipKind };
      for (const id of ["ov-billing-provider", "ov-billing-route", "ov-billing-mode", "ov-billing-batch",
        "ov-billing-subscription-name", "ov-billing-subscription-amount", "ov-billing-subscription-currency",
        "ov-billing-amount-unknown"]) {
        const control = document.getElementById(id);
        if (control) control.disabled = true;
      }
      start.disabled = true;
      end.disabled = true;
      if (anchor) anchor.disabled = true;
      save.textContent = "已保存";
      preview.hidden = false;
      preview.textContent = "声明已保存（修订 " + revisionId + "）：" + billingPreviewText(impact, relationshipKind);
      // 服务商由用户补上：同时写型号归属，下一轮同步把这批用量归到该服务商名下
      // （既有 price_overrides 路由层；失败不回滚声明，回执如实带出）。
      if (target.missing.provider && relationshipKind !== "third_party") {
        const routeMode = relationshipKind === "official_subscription" ? "subscription" : "metered";
        const failures = [];
        for (const row of selected) {
          if (!row.model_id || row.model_id === "<unknown>") continue;
          try {
            await invoke("save_price_route", { input: { model_prefix: row.model_id, provider_id: providerId, mode: routeMode } });
          } catch (e) { failures.push(row.model_id + "：" + errText(e)); }
        }
        preview.textContent += failures.length
          ? " 型号归属未能全部写入（" + failures.join("；") + "）。"
          : " 已记录 " + selected.length + " 个型号归属 " + providerId + "，下一轮同步生效。";
      }
      const job = saved && saved.job;
      if (job && job.status === "enqueue_failed") {
        preview.textContent += " 重算未入队：" + (job.error || "未知原因") + "。";
        appendBillingRetryButton(preview, job.job_id, { enqueue: { declarationId, revisionId } });
      } else if (job && job.job_id) {
        await followBillingRecalculation(preview, job.job_id);
      } else {
        preview.textContent += " 此关系不改变金额，无需重算。";
        await refreshAfterBillingChange();
      }
      appendBillingRevokeButton(preview, declarationId, revisionId);
    } catch (e) {
      save.disabled = false;
      preview.hidden = false;
      preview.textContent = "保存失败：" + errText(e);
    }
  };
}

// 归因/重算变化后的刷新（用户路径第 6 步）：总览立刻重绘；用量（按月缓存）、会话、
// 待处理三个懒加载页的缓存作废，当前正开着的那个页立即重拉，其余页下次进入时重拉。
// 这不是「刷新页面」——数据来源仍是同一个权威库，只是让每个面读到同一结果版本。
async function refreshAfterBillingChange() {
  calendarLoadedMonth = null;
  sessState.loaded = false;
  findState.loaded = false;
  await renderOverview();
  if (activeTab === "calendar" || activeTab === "sessions" || activeTab === "findings") {
    await loadActiveTab();
  }
}

// 轮询重算回执：250ms × 20 次；超时不宣称完成，任务留在「重算状态」列表里可回看。
async function followBillingRecalculation(preview, jobId) {
  preview.textContent += " 正在重新归因并重算费用…";
  let finalStatus = null, lastJob = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    lastJob = await invoke("billing_recalculation_job_status", { jobId });
    finalStatus = lastJob.status;
    if (["succeeded", "failed", "cancelled"].includes(finalStatus)) break;
  }
  if (finalStatus === "succeeded") {
    preview.textContent += " 重算已完成，总览、用量、会话与待处理已按新归因刷新。";
    await refreshAfterBillingChange();
  } else if (finalStatus === "failed" || finalStatus === "cancelled") {
    preview.textContent += " " + billingJobErrorText(lastJob) + "，旧结果仍可读。";
    appendBillingRetryButton(preview, jobId, null);
  } else {
    preview.textContent += " 仍在后台处理中（" + jobId + "），完成前各页继续显示上一版本；可在「重算状态」查看进度。";
  }
}

function appendBillingRetryButton(preview, jobId, options) {
  const retry = document.createElement("button");
  retry.className = "btn secondary";
  retry.textContent = options && options.enqueue ? "重试入队" : "重试重算";
  retry.onclick = async () => {
    retry.disabled = true;
    try {
      if (options && options.enqueue) {
        await invoke("enqueue_billing_recalculation", {
          jobId, declarationId: options.enqueue.declarationId, revisionId: options.enqueue.revisionId,
        });
      } else {
        await invoke("retry_billing_recalculation", { jobId });
      }
      preview.textContent = "已重新入队，正在后台重算：" + jobId + "。";
      await followBillingRecalculation(preview, jobId);
    } catch (e) {
      retry.disabled = false;
      preview.textContent += " · 重试失败：" + errText(e);
    }
  };
  preview.appendChild(document.createTextNode(" "));
  preview.appendChild(retry);
}

function appendBillingRevokeButton(preview, declarationId, revisionId) {
  const revoke = document.createElement("button");
  revoke.className = "chip-link";
  revoke.textContent = "撤销";
  revoke.onclick = async () => {
    revoke.disabled = true;
    try {
      await invoke("revoke_billing_declaration", {
        revisionId: "rev-revoke-" + Date.now().toString(36),
        declarationId, supersedesRevisionId: revisionId,
      });
      billingDeclarationTarget = null;
      billingDeclarationState = null;
      closeBillingDeclaration();
      await refreshAfterBillingChange();
    } catch (e) {
      revoke.disabled = false;
      preview.textContent += " · 撤销失败：" + errText(e);
    }
  };
  preview.appendChild(document.createTextNode(" "));
  preview.appendChild(revoke);
}
async function renderRetentionSettings() {
  const input = document.getElementById("ov-retention-months");
  const save = document.getElementById("ov-retention-save");
  const status = document.getElementById("ov-retention-status");
  if (!input || !save || !status) return;
  const show = (text) => { status.hidden = false; status.textContent = text; };
  try {
    const config = await invoke("retention_config");
    if (!config || config.status !== "ok") throw new Error((config && config.reason) || "保留期设置不可用");
    input.min = String(config.minimum_months);
    input.max = String(config.maximum_months);
    input.value = String(config.months);
    status.hidden = true;
    save.onclick = async () => {
      const months = Number(input.value);
      if (!Number.isInteger(months) || months < Number(input.min) || months > Number(input.max)) {
        show("请输入 " + input.min + "–" + input.max + " 之间的整数月数。");
        status.focus();
        return;
      }
      save.disabled = true;
      try {
        await invoke("save_retention_config", { input: { months } });
        show("已保存：下次本机维护将保留最近 " + months + " 个自然月；不会删除执行环境原始日志。");
      } catch (e) {
        show("保存失败：" + errText(e));
        status.focus();
      } finally {
        save.disabled = false;
      }
    };
  } catch (e) {
    show("保留期设置不可用：" + errText(e));
    input.disabled = true;
    save.disabled = true;
  }
}

// 常用时区 + "跟随系统" + "其他…"（规格 §4.4：不要求普通用户手输 IANA 名称）。
const COMMON_STATISTICS_TIMEZONES = [
  "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Singapore",
  "America/Los_Angeles", "America/New_York", "Europe/London", "Europe/Berlin", "UTC",
];

async function renderStatisticsTimezoneSettings() {
  const select = document.getElementById("ov-statistics-timezone-select");
  const customLabel = document.getElementById("ov-statistics-timezone-custom");
  const input = document.getElementById("ov-statistics-timezone");
  const save = document.getElementById("ov-timezone-save");
  const status = document.getElementById("ov-timezone-status");
  if (!select || !customLabel || !input || !save || !status) return;
  const show = (text) => { status.hidden = false; status.textContent = text; };
  let systemTz = "UTC";
  const buildOptions = (current) => {
    select.textContent = "";
    const opts = [["__system__", "跟随系统（" + systemTz + "）"]];
    for (const tz of COMMON_STATISTICS_TIMEZONES) opts.push([tz, tz]);
    opts.push(["__custom__", "其他…"]);
    for (const [value, label] of opts) {
      const opt = document.createElement("option");
      opt.value = value; opt.textContent = label;
      select.appendChild(opt);
    }
    const known = COMMON_STATISTICS_TIMEZONES.includes(current);
    if (current === systemTz) select.value = "__system__";
    else if (known) select.value = current;
    else select.value = "__custom__";
    customLabel.hidden = select.value !== "__custom__";
    input.value = current;
  };
  select.onchange = () => {
    customLabel.hidden = select.value !== "__custom__";
    if (select.value !== "__custom__") input.value = select.value === "__system__" ? systemTz : select.value;
  };
  try {
    const config = await invoke("statistics_timezone_config");
    if (!config || config.status !== "ok") throw new Error((config && config.reason) || "统计时区设置不可用");
    systemTz = String(config.system_timezone || systemTz);
    configuredStatisticsTimezone = String(config.timezone || config.system_timezone || configuredStatisticsTimezone).trim();
    buildOptions(configuredStatisticsTimezone);
    status.hidden = true;
    save.onclick = async () => {
      const timezone = (select.value === "__system__" ? systemTz : select.value === "__custom__" ? input.value.trim() : select.value);
      if (!timezone) {
        show("请输入 IANA 时区名称，例如 Asia/Shanghai。");
        status.focus();
        return;
      }
      save.disabled = true;
      try {
        await invoke("save_statistics_timezone_config", { timezone });
        configuredStatisticsTimezone = timezone;
        calMonth = statisticsMonth();
        show("已保存统计时区；正在刷新今天、本月和日历统计。");
        await loadActiveTab();
      } catch (e) {
        show("保存失败：" + errText(e));
        status.focus();
      } finally {
        save.disabled = false;
      }
    };
  } catch (e) {
    show("统计时区设置不可用：" + errText(e));
    select.disabled = true;
    input.disabled = true;
    save.disabled = true;
  }
}

async function renderPricingCatalogSettings() {
  const button = document.getElementById("ov-pricing-catalog-update");
  const status = document.getElementById("ov-pricing-catalog-status");
  const network = document.getElementById("ov-pricing-catalog-network");
  if (!button || !status || !network || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  const render = (value) => {
    if (!value) { status.textContent = "尚未检查"; return; }
    const state = value.state || value.status || "unknown";
    const version = value.source_version ? " · 版本 " + value.source_version : "";
    const models = value.model_count == null ? "" : " · 覆盖 " + value.model_count + " 个模型";
    const reason = value.failure_reason ? " · 原因：" + value.failure_reason : "";
    const succeeded = state === "ok" || state === "updated" || value.status === "updated";
    status.textContent = (succeeded ? "已成功检查公共目录" : state === "never_checked" ? "尚未检查" : "上次检查未采用新目录") + version + models + reason;
  };
  const initialStatus = await (async () => {
    try { return await invoke("public_pricing_catalog_status"); }
    catch (e) { status.textContent = "价格目录状态不可用：" + errText(e); return null; }
  })();
  if (initialStatus) {
    network.checked = initialStatus.network_enabled === true;
    render(initialStatus);
  }
  network.onchange = async () => {
    network.disabled = true;
    try {
      await invoke("save_public_pricing_catalog_policy", { networkEnabled: network.checked });
      status.textContent = network.checked ? "已允许联网检查；不会上传本地数据。" : "已关闭联网检查；继续使用本地价卡。";
    } catch (e) {
      network.checked = !network.checked;
      status.textContent = "保存联网偏好失败：" + errText(e);
    } finally { network.disabled = false; }
  };
  button.onclick = async () => {
    if (!network.checked) { status.textContent = "请先明确允许访问公共价格服务。"; return; }
    button.disabled = true;
    status.textContent = "正在检查公共价格目录…不会上传本地数据。";
    try {
      render(await invoke("update_public_pricing_catalog"));
      await refreshActiveTab(true);
    } catch (e) {
      try { render(await invoke("public_pricing_catalog_status")); } catch (_) {}
      status.textContent += "（" + errText(e) + "）";
    } finally { button.disabled = false; }
  };
}

function csvCell(value) {
  let text = value == null ? "" : String(value);
  // provider/model 等虽来自权威 DTO，仍可能源自外部日志；CSV 被表格软件打开时，
  // 公式前缀不能获得执行机会。前导单引号是显示层转义，不改变导出的原始语义。
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

// 当前视图导出刻意只消费已经渲染的月度权威 DTO；不查询会话详情，不重算价格，
// 也不把本地路径、账户或原始日志写进临时文件。金额保留原币与 basis，不跨币相加。
function summaryExportCsv(monthly) {
  const header = ["record_kind", "window", "harness", "provider", "tokens", "basis", "currency",
    "amount", "amount_status", "evidence_basis", "pricing_method", "freshness",
    "last_observed_at", "coverage_measured_fields", "coverage_total_fields",
    "coverage_denominator_version", "summary_contract"];
  const rows = [header];
  if (!monthly || !monthly.month) return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const coverage = monthly.coverage || {};
  const common = (recordKind, harness, provider, tokens, basis, currency, amount, amountStatus, source) => [
    recordKind, monthly.month, harness || "", provider || "", tokens == null ? "" : tokens,
    basis || "", currency || "", amount == null ? "" : amount, amountStatus || "",
    source.evidence_basis || "", source.pricing_method || "", (source.freshness || {}).state || "",
    (source.freshness || {}).last_observed_at || monthly.last_observed_at || "",
    coverage.measured_fields == null ? "" : coverage.measured_fields,
    coverage.total_fields == null ? "" : coverage.total_fields,
    coverage.denominator_version == null ? "" : coverage.denominator_version,
    "monthly_summary/v1",
  ];
  for (const [harness, tokens] of Object.entries(monthly.tokens_by_harness || {})) {
    const tokenTotal = tokens && tokens.total;
    rows.push(common("harness_tokens", harness, "", tokenTotal, "", "", "", "observed", (monthly.by_harness || {})[harness] || {}));
  }
  for (const [harnessProvider, source] of Object.entries(monthly.by_provider || {})) {
    const divider = harnessProvider.indexOf("/");
    const harness = divider >= 0 ? harnessProvider.slice(0, divider) : harnessProvider;
    const provider = divider >= 0 ? harnessProvider.slice(divider + 1) : "";
    const amounts = source.amounts_by_basis || {};
    for (const [basis, amount] of Object.entries(amounts)) {
      rows.push(common("provider_amount", harness, provider, "", basis, source.currency || "", amount, "available", source));
    }
    if (source.has_unresolved) {
      rows.push(common("provider_amount", harness, provider, "", "", source.currency || "", "", "unresolved", source));
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function bindSummaryExport(monthly) {
  const preview = document.getElementById("ov-export-preview");
  const download = document.getElementById("ov-export-download");
  const content = document.getElementById("ov-export-preview-content");
  if (!preview || !download || !content) return;
  preview.onclick = () => {
    const csv = summaryExportCsv(monthly);
    const [header, ...records] = csv.split("\r\n");
    content.hidden = false;
    content.textContent = "字段：" + header.replaceAll('"', "") + "。将导出 " + records.length +
      " 行当前月摘要；金额保留原币与口径，未定项金额为空且标记 unresolved。";
    download.hidden = false;
  };
  download.onclick = () => {
    const csv = summaryExportCsv(monthly);
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "agent-vitals-" + (monthly && monthly.month ? monthly.month : "summary") + ".csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
}

function renderBillingDeclarations(report) {
  const panel = document.getElementById("ov-billing-declarations-panel");
  const list = document.getElementById("ov-billing-declarations-list");
  if (!panel || !list) return;
  if (!report || report.status !== "ok") {
    panel.hidden = false;
    list.textContent = "待确认状态暂不可读，请刷新重试";
    return;
  }
  const declarations = report && report.status === "ok" ? (report.declarations || []) : [];
  panel.hidden = !declarations.length;
  list.textContent = "";
  for (const declaration of declarations) {
    const row = document.createElement("div");
    row.className = "billing-review-row";
    const detail = document.createElement("div");
    const label = BILLING_RELATIONSHIP_LABEL[declaration.relationship_kind] || declaration.relationship_kind;
    const settlementScope = (declaration.scopes || []).find((sc) => sc.scope_kind === "settlement");
    const fee = declaration.amount_minor != null && declaration.currency
      ? " · " + fmtMinor(Number(declaration.amount_minor), declaration.currency) + "/月"
      : settlementScope ? " · 按 " + settlementScope.scope_value + " 结算" : "";
    detail.textContent = declaration.provider_id + " · " + label +
      (declaration.subscription_name ? " · " + declaration.subscription_name : "") + fee +
      " · " + billingRangeText(declaration.effective_start, declaration.effective_end);
    // 声明的依据一并带出：从旧版本套餐记录确认来的，标一行灰字；候选本身不再单独成行
    // （accepted 候选 = 这条声明的依据，撤销声明即释放，没有独立的「重新打开」）。
    if (declaration.source_candidate_id) {
      const basis = document.createElement("div");
      basis.className = "muted";
      basis.textContent = "依据：旧版本套餐记录（撤销声明即释放该记录）";
      detail.appendChild(basis);
    }
    const actions = document.createElement("div");
    actions.className = "billing-review-actions";
    const revoke = document.createElement("button");
    revoke.className = "btn secondary";
    revoke.textContent = "撤销计费声明";
    revoke.onclick = async () => {
      if (!declaration.current_revision_id) {
        detail.textContent += " · 无法确定当前修订，请勿继续操作。";
        return;
      }
      revoke.disabled = true;
      try {
        await invoke("revoke_billing_declaration", {
          revisionId: "rev-revoke-" + Date.now().toString(36),
          declarationId: declaration.declaration_id,
          supersedesRevisionId: declaration.current_revision_id,
        });
        billingDeclarationTarget = null;
        billingDeclarationState = null;
        const declarationPanel = document.getElementById("ov-billing-declaration-panel");
        if (declarationPanel) declarationPanel.hidden = true;
        await renderOverview();
      } catch (e) {
        revoke.disabled = false;
        detail.textContent += " · 撤销失败：" + errText(e);
      }
    };
    actions.appendChild(revoke);
    // B13 修改订阅：追加 supersede 修订（改价/退订），不再要求"撤销后重新确认"。
    // 只给订阅关系——按量/组织/中转的声明没有可改的金额面。
    if (declaration.relationship_kind === "official_subscription" && declaration.current_revision_id) {
      const amend = document.createElement("button");
      amend.className = "btn secondary";
      amend.textContent = "修改订阅";
      amend.onclick = () => renderBillingAmendment(row, declaration, amend);
      actions.appendChild(amend);
    }
    row.append(detail, actions);
    list.appendChild(row);
  }
}

// 修改订阅（B13）：追加一条 supersede 修订，不是撤销重申。两条语义都在月费摊派侧
// 由修订链按月解析（summary.rs::declared_fee_for_month）：改价从**当月**起、不重写
// 历史；退订＝取消「持续有效」并填结束日，过去的月照摊。作用域原样带回（DTO 带
// 当前修订的 scopes）——丢了作用域，修订会把声明范围悄悄放宽成该服务商全部模型。
function renderBillingAmendment(row, declaration, amendButton) {
  const closeForm = () => {
    if (row.__amendForm) { row.__amendForm.remove(); row.__amendForm = null; }
    amendButton.textContent = "修改订阅";
  };
  if (row.__amendForm) { closeForm(); return; }
  amendButton.textContent = "收起修改";
  const today = new Date().toISOString().slice(0, 10);
  const form = document.createElement("div");
  form.className = "billing-amend-form block";
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "新价格自本月起生效（历史月份不变）；要结束订阅请取消「持续有效」并填结束日——那会保留过去的月费、只停未来的。";
  form.appendChild(hint);

  const fields = document.createElement("div");
  fields.className = "bd-inline";
  const field = (labelText, control) => {
    const label = document.createElement("label");
    label.className = "bd-field";
    const span = document.createElement("span");
    span.textContent = labelText;
    label.append(span, control);
    return label;
  };
  const name = document.createElement("input");
  name.type = "text"; name.placeholder = "套餐名（可选）";
  name.value = declaration.subscription_name || "";
  const amount = document.createElement("input");
  amount.type = "number"; amount.step = "0.01"; amount.min = "0"; amount.placeholder = "月费";
  const hasAmount = declaration.amount_minor != null;
  amount.value = hasAmount ? String(Number(declaration.amount_minor) / 100) : "";
  const currency = document.createElement("select");
  for (const code of ["CNY", "USD"]) {
    const option = document.createElement("option");
    option.value = code; option.textContent = code;
    currency.appendChild(option);
  }
  currency.value = declaration.currency || "CNY";
  const amountUnknown = document.createElement("input");
  amountUnknown.type = "checkbox";
  amountUnknown.checked = !hasAmount;
  const syncAmount = () => { amount.disabled = amountUnknown.checked; currency.disabled = amountUnknown.checked; };
  amountUnknown.onchange = syncAmount;
  syncAmount();
  const openEnded = document.createElement("input");
  openEnded.type = "checkbox";
  openEnded.checked = !declaration.effective_end;
  const end = document.createElement("input");
  end.type = "date"; end.max = today;
  end.value = declaration.effective_end || "";
  const syncEnd = () => { end.disabled = openEnded.checked; };
  openEnded.onchange = syncEnd;
  syncEnd();
  const check = (labelText, control) => {
    const label = document.createElement("label");
    label.className = "bd-check";
    const span = document.createElement("span");
    span.textContent = labelText;
    label.append(control, span);
    return label;
  };
  fields.append(
    field("套餐名", name),
    field("月费", amount),
    field("币种", currency),
    check("金额暂不清楚", amountUnknown),
    field("结束日", end),
    check("持续有效", openEnded),
  );
  form.appendChild(fields);

  const actions = document.createElement("div");
  actions.className = "billing-review-actions";
  const status = document.createElement("span");
  status.className = "muted";
  const save = document.createElement("button");
  save.className = "btn primary";
  save.textContent = "保存修订";
  const cancel = document.createElement("button");
  cancel.className = "chip-link";
  cancel.textContent = "取消";
  cancel.onclick = closeForm;
  save.onclick = async () => {
    const fail = (message) => { status.textContent = message; save.disabled = false; };
    if (!amountUnknown.checked) {
      const value = Number(amount.value);
      if (!Number.isFinite(value) || value < 0 || !String(amount.value).trim()) {
        return fail("月费必须是不小于 0 的数字，或勾选「金额暂不清楚」。");
      }
    }
    const effectiveEnd = openEnded.checked ? null : String(end.value || "").trim();
    if (!openEnded.checked) {
      if (!BILLING_DATE_RE.test(effectiveEnd)) return fail("结束日期格式应为 YYYY-MM-DD，或勾「持续有效」。");
      if (effectiveEnd < declaration.effective_start) return fail("结束日期不能早于声明的起始日。");
      if (effectiveEnd > today) return fail("结束日期不能晚于今天（北京时间）。");
    }
    save.disabled = true;
    try {
      const suffix = Date.now().toString(36);
      await invoke("save_billing_declaration_revision", {
        revisionId: "rev-amend-" + suffix,
        declarationId: declaration.declaration_id,
        supersedesRevisionId: declaration.current_revision_id,
        providerId: declaration.provider_id,
        relationshipKind: "official_subscription",
        subscriptionName: String(name.value || "").trim() || null,
        amountMinor: amountUnknown.checked ? null : Math.round(Number(amount.value) * 100),
        currency: amountUnknown.checked ? null : currency.value,
        // 修订沿用原起点（覆盖不断档）；新价格自本月起，由修订链按月取价。
        effectiveStart: declaration.effective_start,
        effectiveEnd,
        sourceCandidateId: declaration.source_candidate_id || null,
        evidenceRef: "amend:" + declaration.current_revision_id,
        scopes: (declaration.scopes || []).map((scope) => ({
          scope_kind: scope.scope_kind, scope_value: scope.scope_value,
        })),
      });
      status.textContent = "修订已保存；月费与覆盖按新修订继续。";
      await renderOverview();
      closeForm();
    } catch (e) {
      fail("保存失败：" + errText(e));
    }
  };
  actions.append(save, cancel, status);
  form.appendChild(actions);
  row.appendChild(form);
  row.__amendForm = form;
}

// 「明确计费方式」入口与面板（计费主链规格 §5.1/§5.2）。主体是**待确认组**
// （`billing_confirmation_groups`：执行环境 × provider × 模型 × 路由证据，带分币估算、
// 按金额降序）；旧资产迁移候选只是组的一种证据来源，附在同执行环境同 provider 的组
// 下面；当月没有用量的候选单独成行。此前面板只从候选出发，没有旧资产的用户永远
// 看不到待确认组（G5），而「是我的套餐」主按钮只翻候选状态、不归因（G1）。
function billingEvidenceLabel(basis) {
  return {
    "explicit-official-route": "明确官方路由",
    "session-native": "会话内证据",
    "account-time-bound": "账户期证据",
    "config-time-bound": "配置期证据",
    "config-current": "当前配置",
    "env-current": "当前环境变量",
    inferred: "推断",
    missing: "无路由证据",
    conflict: "证据冲突",
  }[basis] || basis || "无路由证据";
}

function billingCandidateAsGroup(candidate) {
  const month = String(candidate.billing_period_start || "").slice(0, 7);
  return {
    group_id: "candidate:" + candidate.candidate_id, harness: candidate.harness,
    provider_id: candidate.provider_id, model_id: null, evidence_basis: "missing",
    tokens: 0, session_count: 0, estimated_amounts: [],
    effective_start: monthStartDate(/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : statisticsMonth()),
    effective_end: monthEndDate(statisticsMonth()), candidate,
  };
}

function renderBillingConfirmation(groupsReport, candidatesReport) {
  const prompt = document.getElementById("ov-billing-prompt");
  const panel = document.getElementById("ov-billing-review-panel");
  const reviewButton = document.getElementById("ov-billing-review");
  const closeButton = document.getElementById("ov-billing-review-close");
  const copy = document.getElementById("ov-billing-prompt-copy");
  const list = document.getElementById("ov-billing-review-list");
  const settingsEntry = document.getElementById("settings-billing-candidates");
  const settingsCopy = document.getElementById("settings-billing-candidates-copy");
  const settingsOpen = document.getElementById("settings-billing-candidates-open");
  if (!prompt || !panel || !reviewButton || !closeButton || !copy || !list) return;
  bindBillingDeclarationPanel();
  // A transient authority read failure must not close a panel the user is
  // already reviewing or erase its last rendered rows. The next successful
  // refresh will reconcile the list; only explicit `ok` empty results mean
  // there is nothing left to confirm.
  const groupsOk = groupsReport && groupsReport.status === "ok";
  const candidatesOk = candidatesReport && candidatesReport.status === "ok";
  if (!groupsOk && !candidatesOk) {
    prompt.hidden = false;
    copy.textContent = "待确认状态暂不可读，请刷新重试";
    billingPromptState = { visible: false, pendingTokens: 0 };
    if (settingsEntry) settingsEntry.hidden = false;
    if (settingsCopy) settingsCopy.textContent = copy.textContent;
    return;
  }
  const groups = groupsOk && Array.isArray(groupsReport.groups) ? groupsReport.groups : [];
  // 三态行（自动归因规格 §5.1）：后端 `clusters` = 执行环境 × 计费方/厂商 × 路由状态 ×
  // 判定状态；模型折进 models[]。程序已判定 → 一键「确认」（弹窗只剩订阅确认）；
  // 差一问 → 问题的选项直接放行内；需补充 → 进弹窗。没有 clusters（旧后端）时
  // 退回逐模型行。
  const clusters = groupsOk && Array.isArray(groupsReport.clusters) ? groupsReport.clusters : null;
  const candidates = candidatesOk && Array.isArray(candidatesReport.candidates) ? candidatesReport.candidates : [];
  const pendingCandidates = candidates.filter((c) => c.status === "pending");
  // **待核对**的候选挂到同执行环境同 provider 的第一组；挂不上的当月无用量，单独成行。
  // 已被某条有效声明采用（accepted）的候选**不能再挂到组上**：组的弹窗会把
  // `candidate_id` 当 `sourceCandidateId` 一起保存，而一张旧套餐记录只能归一条有效
  // 声明——2026-09-16 真机：anthropic 订阅早已声明，新会话进了待确认，弹窗又带上
  // 同一张 accepted 候选 → `UNIQUE constraint failed:
  // billing_declarations.source_candidate_id`。accepted 候选只走下面的
  // `resolvedCandidate` 行（「已作为计费声明的依据 · 重新打开」）。
  const rows = groups.map((group) => ({ ...group, candidate: null }));
  const orphanCandidates = [];
  for (const candidate of candidates) {
    // accepted 候选不是待办也不是历史行：它是某条有效声明的依据，由「当前计费声明」
    // 那一行自己带出（DTO 的 source_candidate_id / amount），这里不再占位。
    if (candidate.status === "accepted") continue;
    const owner = candidate.status === "pending"
      ? rows.find((row) => row.harness === candidate.harness && row.provider_id === candidate.provider_id && !row.candidate)
      : null;
    if (owner) owner.candidate = candidate;
    else orphanCandidates.push(candidate);
  }
  for (const candidate of orphanCandidates) {
    if (candidate.status === "pending") rows.push(billingCandidateAsGroup(candidate));
    else rows.push({ ...billingCandidateAsGroup(candidate), resolvedCandidate: true });
  }
  const pendingRows = rows.filter((row) => !row.resolvedCandidate);
  const pendingTokens = groups.reduce((sum, group) => sum + Number(group.tokens || 0), 0);
  const pendingSessions = groups.reduce((sum, group) => sum + Number(group.session_count || 0), 0);
  const amountSlots = {};
  for (const group of groups) {
    for (const amount of (group.estimated_amounts || [])) {
      if (!amount || !amount.currency) continue;
      amountSlots[amount.currency] = (amountSlots[amount.currency] || 0) + Number(amount.amount_minor || 0);
    }
  }
  const amountText = Object.entries(amountSlots).map(([currency, minor]) => fmtMinor(minor, currency)).join(" / ");

  let deferredAt = 0;
  try { deferredAt = Number(localStorage.getItem(BILLING_REVIEW_DEFER_KEY) || 0); } catch (_) { /* best effort */ }
  if (!deferredAt) {
    try { deferredAt = Number(sessionStorage.getItem(BILLING_REVIEW_DEFER_KEY) || 0); } catch (_) { /* best effort */ }
  }
  const deferred = Number.isFinite(deferredAt) && deferredAt > 0 &&
    Date.now() - deferredAt < BILLING_REVIEW_DEFER_WINDOW_MS;
  if (deferredAt > 0 && !deferred) {
    try { localStorage.removeItem(BILLING_REVIEW_DEFER_KEY); } catch (_) { /* best effort */ }
    try { sessionStorage.removeItem(BILLING_REVIEW_DEFER_KEY); } catch (_) { /* best effort */ }
  }
  // 有 clusters 时按簇计数（一簇 = 用户要回答的一件事），候选专属行照旧各算一件。
  const pendingCount = clusters ? clusters.length + pendingRows.filter((row) => !row.model_id).length : pendingRows.length;
  // “稍后”只压住首屏提醒；设置里的入口始终可主动找回（AC28）。
  prompt.hidden = pendingCount === 0 || deferred;
  billingPromptState = { visible: !prompt.hidden && pendingCount > 0, pendingTokens };
  if (settingsEntry) settingsEntry.hidden = !rows.length;
  // 标题/按钮跟着待办数走：没有待办时（只剩已忽略的记录）不能再顶着「待确认」的
  // 标题和实心主按钮——那是 2026-09-16 用户看到的「横幅说待确认、正文说已核对」矛盾。
  const settingsTitle = document.getElementById("settings-billing-candidates-title");
  const settingsNotice = document.getElementById("settings-billing-candidates-notice");
  if (settingsTitle) settingsTitle.textContent = pendingCount ? "有计费方式待确认" : "计费方式已明确";
  if (settingsNotice && settingsNotice.classList) settingsNotice.classList.toggle("todo", pendingCount > 0);
  if (settingsOpen) {
    settingsOpen.textContent = pendingCount ? "查看并处理" : "查看记录";
    if (settingsOpen.classList) {
      settingsOpen.classList.toggle("primary", pendingCount > 0);
      settingsOpen.classList.toggle("secondary", pendingCount === 0);
    }
  }
  panel.hidden = !billingReviewOpen;
  list.textContent = "";
  if (!rows.length) {
    billingReviewOpen = false;
    panel.hidden = true;
    return;
  }
  // 三件事必须同时说清：受影响用量、当前默认处理、确认后的收益（REQ-019/AC26）。
  copy.textContent = pendingCount
    ? "发现 " + pendingCount + " 组用量的计费方式待确认，涉及本月约 " + fmtTokens(pendingTokens) +
      " tokens、" + pendingSessions + " 个会话" + (amountText ? "，当前已按官方价估算约 " + amountText : "，当前已按官方价估算") +
      (pendingCandidates.length ? "；另有 " + pendingCandidates.length + " 条旧版本套餐记录待核对" : "") +
      "。确认后可区分订阅覆盖和额外按量费用。"
    : "计费方式都已明确；已声明的月费按自报口径计入订阅月费，按量用量按价卡估算。";
  if (!groupsOk || !candidatesOk) copy.textContent += "（部分待确认状态暂不可读，请刷新重试）";
  if (settingsCopy) settingsCopy.textContent = copy.textContent;
  if (settingsOpen && settingsOpen.dataset.bound !== "1") {
    settingsOpen.dataset.bound = "1";
    settingsOpen.onclick = () => reviewButton.click();
  }

  document.getElementById("ov-billing-later").onclick = () => {
    deferBillingReviewPrompt();
    billingReviewOpen = false;
    panel.hidden = true;
    prompt.hidden = true;
  };
  // 钉在某个组上的旧资产候选（`renderBillingConfirmation` 挂的 `row.candidate`）：簇把逐模型
  // 行折掉了，候选的证据行与「这不是我的套餐」必须跟着折进簇行——否则提示里说"另有 N 条旧版本
  // 套餐记录待核对"，页面上却无处可点（验收审查 iteration 3 #2）。
  const rowByGroupId = new Map(rows.filter((row) => row.group_id).map((row) => [row.group_id, row]));
  const clusterRowsOf = (cluster) => (cluster.models || []).map((m) => ({
    group_id: m.group_id, harness: cluster.harness,
    provider_id: cluster.provider_id || "<unknown>", model_id: m.model_id,
    evidence_basis: cluster.evidence_basis, pricing_basis: cluster.pricing_basis,
    tokens: m.tokens, session_count: m.session_count, estimated_amounts: m.estimated_amounts || [],
    effective_start: cluster.effective_start, effective_end: cluster.effective_end,
    // 候选跟着原组走：簇行折叠后 target 若丢掉 `candidate`，弹窗既预填不了旧套餐金额，
    // 声明也记不上 `source_candidate_id`（验收审查 iteration 3 #6 的根因）。
    candidate: (rowByGroupId.get(m.group_id) || {}).candidate || null,
    auto_verdict: cluster.auto_verdict,
  }));
  const clusterCandidatesOf = (cluster) => (cluster.group_ids || [])
    .map((id) => rowByGroupId.get(id))
    .filter((row) => row && row.candidate && row.candidate.status === "pending")
    .map((row) => row.candidate);
  const basisText = (verdict) => (verdict.basis || []).map((b) => ({
    "route.session-native": "请求 ID 为官方格式", "route.explicit-official-route": "明确官方路由",
    "route.account-time-bound": "账户期证据", "route.config-time-bound": "配置期证据",
    "harness.provider_reported": "执行环境自报服务商", "model.gateway_named": "网关式模型命名",
    "response_id.vendor_shape": "响应 ID 与厂商形状一致", "account.api_key": "账户使用 API key",
    "route.conflict": "执行环境自报与会话路由证据冲突", "config.endpoint": "配置里的端点", "config.gateway_named": "模型映射带厂商前缀（中转约定）",
    "config.endpoint.multiple": "配置里列了多个端点（其中至少一个是中转）",
    "config.endpoint.ambiguous": "配置里官方端点与中转同时存在（不确定这批走的是哪一个）",
    "config.endpoint.mixed": "这行里的模型各自配了不同端点（不替它们挑一个）",
    "config.endpoint.conflict": "⚠ 但这批用量是官方形状，而配置指向中转——两者需你核对",
    // cc-switch 时间线（config-time-bound）：见下方 timelineText 的逐条说明。
    "config.timeline": "候选含 cc-switch 里配置过的中转",
    "config.timeline.excluded": "已剔除这批用量之后才建立的中转",
    "config.timeline.partial": "有中转建立于这批用量中途（前半段不可能经它）",
  }[b] || (b.startsWith("account.") ? "账户套餐 " + b.slice(8) : b))).join(" · ");
  // 时间线逐条：只讲"排除"与"中途建立"——`possible` 不是证据，不说。2026-09-17 事故：
  // 胜算云 09-11 深夜才在 cc-switch 里建立，09-09 的 395 次 gpt-5.6-sol 被当前配置建议
  // 成了胜算云；这一行就是让用户在确认前看到"这批里有 443 条 / 134M tokens 早于它"。
  const timelineText = (verdict) => (verdict.config_timeline || []).filter((t) => t && (t.relation === "excluded" || t.relation === "partial")).map((t) => {
    const who = (t.relay_label || t.endpoint_host) + (t.label ? "（cc-switch：" + t.label + "）" : "");
    const when = t.created_at_ms ? formatStatisticsDateTime(new Date(t.created_at_ms), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "未知时间";
    if (t.relation === "excluded") return who + " 建立于 " + when + "，晚于这批用量——已排除";
    const before = t.tokens_before != null ? "，其中 " + Number(t.facts_before || 0) + " 条 / " + fmtTokens(Number(t.tokens_before)) + " tokens 早于它、不可能经它" : "";
    return who + " 建立于 " + when + "，在这批用量中途" + before + "——确认时请把生效日期设在 " + when.slice(0, 5) + " 之后";
  });
  const renderClusterRow = (cluster) => {
    const verdict = cluster.auto_verdict || {};
    const rows = clusterRowsOf(cluster);
    const target = rows[0];
    if (!target) return null;
    const item = document.createElement("div");
    item.className = "billing-review-row";
    const detail = document.createElement("div");
    const actions = document.createElement("div");
    actions.className = "billing-review-actions";
    const party = verdict.billing_party || null;
    const vendor = verdict.model_vendor || null;
    const who = party ? party : (vendor ? "计费方待定（模型厂商 " + vendor + "）" : "服务商未知");
    const routeText = { official: "官方路由", provider_reported: "执行环境自报官方", gateway: "经中转", relay_config: "经中转", vendor_shape: "厂商端点或中转", conflict: "路由证据冲突", unknown: "路由未知" }[verdict.route_state] || "路由未知";
    const amount = billingAmountsText(cluster.estimated_amounts);
    const models = (cluster.models || []).map((m) => m.model_id).filter(Boolean);
    let head = cluster.harness + " · " + who + " · " + routeText;
    if (verdict.route_state === "relay_config" && verdict.config_endpoint) {
      // 说清是**哪个文件**给出来的端点——曾经写死 "ANTHROPIC_BASE_URL"，codex/dsh/pi
      // 的行会因此说假话（验收审查 iteration 7 #3）。
      head += "（配置 " + (verdict.config_source || "端点") + " → " + verdict.config_endpoint + "）";
    } else if (verdict.config_endpoint) {
      head += "（配置 " + (verdict.config_source || "端点") + " → " + verdict.config_endpoint + "，与" + routeText + "需你核对）";
    }
    if (verdict.state === "determined" && verdict.plan && verdict.plan.label) {
      head += " · " + verdict.plan.label + " 订阅" +
        (verdict.plan.anchor_date ? " · 每月 " + Number(verdict.plan.anchor_date.slice(8, 10)) + " 日续费" : "");
    } else if (verdict.state === "determined" && verdict.relationship_kind === "official_api") {
      head += " · 官方 API 按量";
    }
    head += " · " + models.length + " 个模型" + (models.length ? "（" + models.slice(0, 2).join("、") + (models.length > 2 ? " 等" : "") + "）" : "") +
      " · " + Number(cluster.session_count || 0) + " 个会话 · " + fmtTokens(Number(cluster.tokens || 0)) + " tokens" +
      (amount ? " · 按量估算 " + amount : (Number(cluster.unpriced_tokens || 0) > 0 ? " · 无价卡，仅计 token" : ""));
    detail.textContent = head;
    const basis = document.createElement("div");
    basis.className = "muted";
    basis.textContent = (verdict.state === "determined" ? "程序判定，依据：" : verdict.state === "one_question" ? "已知：" : "缺少证据：")
      + (basisText(verdict) || "无");
    detail.appendChild(basis);
    for (const line of timelineText(verdict)) {
      const note = document.createElement("div");
      note.className = "muted";
      note.textContent = "⏱ " + line;
      detail.appendChild(note);
    }
    for (const candidate of clusterCandidatesOf(cluster)) {
      const evidence = document.createElement("div");
      evidence.className = "muted";
      evidence.textContent = "来自旧版本套餐记录：" + candidate.provider_id + " " +
        billingCandidateAmount(candidate) + " 自 " + candidate.billing_period_start + " 起";
      const dismiss = document.createElement("button");
      dismiss.className = "chip-link";
      dismiss.textContent = "这不是我的套餐";
      dismiss.onclick = async () => {
        dismiss.disabled = true;
        try {
          await invoke("resolve_billing_import_candidate", { candidateId: candidate.candidate_id, decision: "dismiss" });
          await renderOverview();
        } catch (e) {
          dismiss.disabled = false;
          evidence.textContent += " · 操作失败：" + errText(e);
        }
      };
      evidence.append(document.createTextNode(" "), dismiss);
      detail.appendChild(evidence);
    }
    const open = (preset) => openBillingDeclaration(target, rows, preset);
    if (verdict.state === "determined") {
      const confirm = document.createElement("button");
      confirm.className = "btn secondary";
      confirm.textContent = verdict.relationship_kind === "official_subscription" ? "确认订阅并填写月费" : "确认";
      confirm.onclick = () => open({ verdict, routeKnown: true, providerKnown: true,
        mode: verdict.relationship_kind === "official_subscription" ? "subscription" : verdict.relationship_kind === "official_api" ? "api" : "organization",
        plan: verdict.plan });
      const wrong = document.createElement("button");
      wrong.className = "chip-link";
      wrong.textContent = "不对，我来改";
      wrong.onclick = () => open({ verdict, override: true });
      actions.append(confirm, wrong);
    } else if (verdict.state === "one_question" && verdict.question === "route") {
      const official = document.createElement("button");
      official.className = "btn secondary";
      official.textContent = (vendor ? vendor + " " : "") + "官方端点" +
        (verdict.route_state === "relay_config" ? "（不对，走的是官方）" : "");
      official.onclick = () => open({ verdict, provider: vendor, route: "official", mode: "api" });
      const relay = document.createElement("button");
      relay.className = "btn secondary";
      // 只认判定器**敢点名**的计费方。配置里有多个端点时 `billing_party` 是空的——
      // 那时不能用 `config_endpoint` 顶上（那是"第一个"端点，不是判定结果），
      // 否则用户一键确认就把一串没人判过的字符串写进声明（验收审查 iteration 7 #3）。
      const relayName = verdict.route_state === "relay_config" ? (verdict.billing_party || "") : "";
      relay.textContent = relayName ? "确认经中转（" + relayName + "）" : "中转 / 第三方";
      relay.onclick = () => open({ verdict, provider: relayName || "", route: "third_party" });
      actions.append(official, relay);
    } else if (verdict.state === "one_question") {
      for (const [label, mode] of [["订阅", "subscription"], ["按量 API", "api"], ["组织承担", "organization"]]) {
        const b = document.createElement("button");
        b.className = "btn secondary";
        b.textContent = label;
        b.onclick = () => open({ verdict, routeKnown: true, providerKnown: true, mode });
        actions.appendChild(b);
      }
    } else {
      const confirm = document.createElement("button");
      confirm.className = "btn secondary";
      confirm.textContent = "明确计费方式";
      confirm.onclick = () => open({ verdict, provider: vendor });
      actions.appendChild(confirm);
    }
    item.append(detail, actions);
    return item;
  };
  const renderRows = () => {
    list.textContent = "";
    if (clusters) {
      for (const cluster of clusters) {
        const item = renderClusterRow(cluster);
        if (item) list.appendChild(item);
      }
    }
    for (const row of rows) {
      // clusters 已经覆盖了有用量的组；这里只剩候选专属行（当月无用量的旧套餐记录）。
      if (clusters && !row.resolvedCandidate && !(row.candidate && Number(row.tokens || 0) === 0)) continue;
      const item = document.createElement("div");
      item.className = "billing-review-row";
      const detail = document.createElement("div");
      const actions = document.createElement("div");
      actions.className = "billing-review-actions";
      if (row.resolvedCandidate) {
        detail.textContent = row.candidate.provider_id + " · " + billingCandidateAmount(row.candidate) +
          "（" + row.harness + "）· 已忽略：这不是你的套餐。";
        const undo = document.createElement("button");
        undo.className = "chip-link";
        undo.textContent = "重新打开";
        undo.onclick = async () => {
          undo.disabled = true;
          try {
            await invoke("resolve_billing_import_candidate", { candidateId: row.candidate.candidate_id, decision: "reopen" });
            await renderOverview();
          } catch (e) {
            undo.disabled = false;
            detail.textContent += " · 操作失败：" + errText(e);
          }
        };
        actions.appendChild(undo);
        item.append(detail, actions);
        list.appendChild(item);
        continue;
      }
      const rowAmount = billingAmountsText(row.estimated_amounts);
      detail.textContent = row.harness + " · " + row.provider_id + (row.model_id ? " · " + row.model_id : "") +
        " · " + billingEvidenceLabel(row.evidence_basis) +
        " · " + billingRangeText(row.effective_start, row.effective_end) +
        " · " + Number(row.session_count || 0) + " 个会话 · " + fmtTokens(Number(row.tokens || 0)) + " tokens · " +
        (rowAmount ? "按量估算 " + rowAmount : (Number(row.tokens || 0) > 0 ? "无价卡，仅计 token" : "本月无用量"));
      if (row.candidate) {
        const evidence = document.createElement("div");
        evidence.className = "muted";
        evidence.textContent = "来自旧版本套餐记录：" + row.candidate.provider_id + " " +
          billingCandidateAmount(row.candidate) + " 自 " + row.candidate.billing_period_start + " 起";
        if (row.candidate.status === "pending") {
          const dismiss = document.createElement("button");
          dismiss.className = "chip-link";
          dismiss.textContent = "这不是我的套餐";
          dismiss.onclick = async () => {
            dismiss.disabled = true;
            try {
              await invoke("resolve_billing_import_candidate", { candidateId: row.candidate.candidate_id, decision: "dismiss" });
              await renderOverview();
            } catch (e) {
              dismiss.disabled = false;
              evidence.textContent += " · 操作失败：" + errText(e);
            }
          };
          evidence.appendChild(document.createTextNode(" "));
          evidence.appendChild(dismiss);
        }
        detail.appendChild(evidence);
      }
      // 每组只有一个主操作；页面唯一的实心主按钮是上方的待办提示，这里用次级。
      const confirm = document.createElement("button");
      confirm.className = "btn secondary";
      confirm.textContent = "明确计费方式";
      confirm.onclick = () => openBillingDeclaration(row, rows);
      actions.appendChild(confirm);
      item.append(detail, actions);
      list.appendChild(item);
    }
  };
  document.getElementById("ov-billing-review").onclick = () => {
    billingReviewOpen = true;
    panel.hidden = false;
    switchTab("sources");
    renderRows();
  };
  // The bootstrap listener can open the panel before the async reads finish.
  // Re-run the now-bound renderer so that this race cannot leave an apparently
  // open but empty review panel.
  if (billingReviewOpen) renderRows();
  closeButton.onclick = () => {
    billingReviewOpen = false;
    panel.hidden = true;
    reviewButton.focus();
  };
}

function renderBillingRecalculationJobs(report) {
  const panel = document.getElementById("ov-billing-recalculation-panel");
  const list = document.getElementById("ov-billing-recalculation-list");
  if (!panel || !list) return;
  if (!report || report.status !== "ok") {
    panel.hidden = false;
    list.textContent = "待确认状态暂不可读，请刷新重试";
    return;
  }
  const jobs = report && report.status === "ok" && Array.isArray(report.jobs) ? report.jobs : [];
  panel.hidden = !jobs.length;
  list.textContent = "";
  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = "billing-review-row";
    const detail = document.createElement("div");
    const statusText = job.status === "failed" || job.status === "cancelled"
      ? "重算待重试"
      : job.status === "running" ? "重算处理中" : "重算排队中";
    detail.textContent = statusText + " · 旧版本结果仍可用 · " + job.job_id;
    // 原始 error_detail（SQLite 错误串）不上卡面，只映射 error_code 文案（规格 §5.10）。
    if (job.status === "failed" || job.status === "cancelled") detail.textContent += " · " + billingJobErrorText(job);
    const actions = document.createElement("div");
    actions.className = "billing-review-actions";
    if (job.status === "failed" || job.status === "cancelled") {
      const retry = document.createElement("button");
      retry.className = "btn secondary";
      retry.textContent = "重试重算";
      retry.onclick = async () => {
        retry.disabled = true;
        try {
          await invoke("retry_billing_recalculation", { jobId: job.job_id });
          await renderOverview();
        } catch (e) {
          retry.disabled = false;
          detail.textContent += " · 重试失败：" + errText(e);
        }
      };
      actions.appendChild(retry);
    }
    row.append(detail, actions);
    list.appendChild(row);
  }
}

async function renderHarnessBills(period) {
  const existing = document.getElementById("ov-bill-existing");
  const status = document.getElementById("ov-bill-status");
  const save = document.getElementById("ov-bill-save");
  if (!existing || !status || !save) return;
  const showBills = (report) => {
    existing.textContent = "";
    const bills = report && report.status === "ok" ? (report.bills || []) : [];
    if (!bills.length) return;
    const title = document.createElement("div");
    title.className = "muted";
    title.textContent = "当前账期账单记录：";
    existing.appendChild(title);
    for (const bill of bills) {
      const row = document.createElement("div");
      row.className = "billing-review-row";
      const detail = document.createElement("div");
      detail.textContent = bill.harness + " · " + bill.provider_id + " · " +
        bill.billing_basis + " · " + bill.amount_minor + " " + bill.currency;
      const remove = document.createElement("button");
      remove.className = "btn secondary";
      remove.textContent = "删除记录";
      remove.onclick = async () => {
        remove.disabled = true;
        try {
          await invoke("delete_harness_bill", { billId: bill.bill_id });
          const refreshed = await invoke("harness_bills_for_period", {
            billingPeriod: document.getElementById("ov-bill-period").value.trim(),
          });
          showBills(refreshed);
        } catch (e) {
          remove.disabled = false;
          status.hidden = false;
          status.textContent = "删除失败：" + errText(e);
        }
      };
      row.append(detail, remove);
      existing.appendChild(row);
    }
  };
  document.getElementById("ov-bill-period").value = period;
  if (save.dataset.bound === "1") {
    try {
      showBills(await invoke("harness_bills_for_period", { billingPeriod: period }));
    } catch (_) { /* 账单是增强入口，不遮蔽总览 */ }
    return;
  }
  save.dataset.bound = "1";
  save.onclick = async () => {
    save.disabled = true;
    status.hidden = false;
    try {
      const harness = document.getElementById("ov-bill-harness").value.trim();
      const provider = document.getElementById("ov-bill-provider").value.trim();
      const billingPeriod = document.getElementById("ov-bill-period").value.trim();
      const amount = Number(document.getElementById("ov-bill-amount").value);
      const currency = document.getElementById("ov-bill-currency").value.trim();
      const evidence = document.getElementById("ov-bill-evidence").value.trim();
      if (!harness || !provider || !/^\d{4}-(0[1-9]|1[0-2])$/.test(billingPeriod) ||
          !Number.isSafeInteger(amount) || amount < 0 || !currency || !evidence) {
        throw new Error("请填写执行环境、服务商、有效账期、非负整数金额、币种和来源说明");
      }
      await invoke("save_harness_bill", {
        billId: "bill-" + Date.now().toString(36), harness, providerId: provider,
        billingPeriod, billingBasis: document.getElementById("ov-bill-basis").value,
        amountMinor: amount, currency, evidenceRef: evidence,
      });
      status.textContent = "账单已保存；它与订阅合同分开，不会改变已观测 tokens。";
      const report = await invoke("harness_bills_for_period", { billingPeriod });
      showBills(report);
    } catch (e) {
      status.textContent = "保存失败：" + errText(e);
    } finally {
      save.disabled = false;
    }
  };
  let csvRows = [];
  const csvPreview = document.getElementById("ov-bill-csv-preview");
  const csvImport = document.getElementById("ov-bill-csv-import");
  const csvStatus = document.getElementById("ov-bill-csv-status");
  csvPreview.onclick = () => {
    const parsed = parseBillingCsv(document.getElementById("ov-bill-csv").value);
    csvRows = parsed.rows;
    csvStatus.hidden = false;
    csvStatus.textContent = "可导入 " + csvRows.length + " 行" +
      (parsed.errors.length ? "；拒绝 " + parsed.errors.length + " 行：" + parsed.errors.join("；") : "，未发现错误。");
    csvImport.disabled = !csvRows.length || parsed.errors.length > 0;
  };
  csvImport.onclick = async () => {
    csvImport.disabled = true;
    try {
      await invoke("save_harness_bills", { rows: csvRows.map((row, i) => ({
        bill_id: billingCsvBillId(row),
        harness: row.harness, provider_id: row.provider_id, billing_period: row.billing_period,
        billing_basis: row.billing_basis, amount_minor: row.amount_minor,
        currency: row.currency, evidence_ref: row.evidence_ref,
      })) });
      csvStatus.hidden = false;
      csvStatus.textContent = "已导入 " + csvRows.length + " 行账单记录。";
      const report = await invoke("harness_bills_for_period", { billingPeriod: period });
      showBills(report);
    } catch (e) {
      csvImport.disabled = false;
      csvStatus.hidden = false;
      csvStatus.textContent = "导入中断：已成功写入前置行；请根据预览修正后重试。" + errText(e);
    }
  };
  try {
    const report = await invoke("harness_bills_for_period", { billingPeriod: period });
    showBills(report);
  } catch (_) { /* 账单是增强入口，不遮蔽总览 */ }
}

// 「本月逐日」panel：read_calendar_month（逐日三执行环境 token + 分币耗费）。
// 旧 read_month 的 DSH-only 日轴在 DSH 零用量月份只剩全零行，与总览页的
// 跨执行环境叙事自相矛盾——v0.9.1 Phase 4 已退役该命令。costs 每段带执行环境前缀。
function renderOverviewDays(cal) {
  const list = document.getElementById("ov-days-list");
  const empty = document.getElementById("ov-days-empty");
  if (!list) return;
  list.textContent = "";
  const days = (cal && cal.days) || {};
  const rows = Object.entries(days)
    .filter(([, d]) => (d.total_tokens || 0) > 0)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1));
  if (!rows.length) {
    empty.hidden = false;
    empty.textContent = cal ? "本月还没有可展示的日记录" : "最近几天暂不可读，请刷新重试";
    return;
  }
  empty.hidden = true;
  for (const [date, d] of rows) {
    const costs = [];
    if ((d.dsh_cost_cny || 0) > 0) costs.push(HARNESS_DISPLAY.dsh + " " + fmtCur(d.dsh_cost_cny, "CNY"));
    if ((d.claude_cost_cny || 0) > 0) costs.push(HARNESS_DISPLAY["claude-code"] + " " + fmtCur(d.claude_cost_cny, "CNY"));
    if ((d.claude_cost_usd || 0) > 0) costs.push(HARNESS_DISPLAY["claude-code"] + " " + fmtCur(d.claude_cost_usd, "USD"));
    if ((d.codex_cost_usd || 0) > 0) costs.push(HARNESS_DISPLAY.codex + " " + fmtCur(d.codex_cost_usd, "USD"));
    const li = document.createElement("li");
    li.innerHTML = `<span class="day-date">${date}</span>` +
      `<span class="day-tokens">${fmtTokens(d.total_tokens)} tokens</span>` +
      (costs.length ? `<span class="day-cost">${costs.join(" · ")}</span>` : "");
    list.appendChild(li);
  }
}

// ---------- Stage D KPI 行 / 双轨账 / 决策卡 ----------

// ---------- 总览第一行三卡 + 本月用量行 ----------
// 金额纪律：按量实付 / 订阅月费读 DTO 的 `actual_spend_by_basis`（拆栏在
// domain：data_contract.rs::actual_spend_by_basis，各栏之和恒等于
// total_actual_spend），分币并列、永不跨币相加、永不折算（PM 决策 2026-09-07：
// fx 只进名义）。名义 = nominalFromByProvider（官方标价折算，诊断脚注）。
// 无数据一律「无数据」，绝不渲染 0；「无数据」不吃强调色。
function spendByBasis(dto, basis) {
  return ((dto && dto.actual_spend_by_basis) || {})[basis] || {};
}
// 按量实付 = metered_actual + harness_billed：两档都是真实账单口径（执行环境账单不能
// 重标为模型 API 成本，但同样回答"要付多少"），按币合并。
function meteredSpend(dto) {
  const out = {};
  for (const basis of ["metered_actual", "harness_billed"]) {
    for (const [c, v] of Object.entries(spendByBasis(dto, basis))) out[c] = (out[c] || 0) + v;
  }
  return out;
}
// 「按量费用」行的三级口径（domain `metered_view`，2026-09-16 产品定向）：
// 账单 > 归因估算 > 默认估算，同 provider 内取代、跨币分栏。取舍在 domain，这里
// 只把每个币种的 {amount, label} 格式化成文案：实付 → 原样；估算 → `≈¥216.57 估算`；
// 混合 → `≈¥668.57 含估算`。返回 {parts, title, unattributed, allActual}。
function meteredViewText(dto) {
  const view = (dto && dto.metered_view) || {};
  const rank = (c) => (c === "CNY" ? 0 : c === "USD" ? 1 : 2);
  const entries = Object.entries(view).filter(([, v]) => v && v.amount > 0)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : 1));
  const parts = [];
  const details = [];
  const unattributed = new Set();
  let allActual = entries.length > 0;
  for (const [c, v] of entries) {
    const money = fmtCur(v.amount, c || null);
    if (v.label === "actual") parts.push(money);
    else if (v.label === "mixed") { parts.push("≈" + money + " 含估算"); allActual = false; }
    else { parts.push("≈" + money + " 估算"); allActual = false; }
    const d = [];
    if (v.actual > 0) d.push("账单 " + fmtCur(v.actual, c || null));
    if (v.declared_estimate > 0) d.push("已归因估算 " + fmtCur(v.declared_estimate, c || null));
    if (v.default_estimate > 0) d.push("未归因估算 " + fmtCur(v.default_estimate, c || null));
    details.push(d.join(" · "));
    for (const p of (v.unattributed_providers || [])) unattributed.add(p);
  }
  return { parts, title: details.join("；"), unattributed: Array.from(unattributed), allActual };
}
// 「尚未设置套餐或账单」不是金额，是下一步指引：弱化成灰色小字并可点击跳到
// 设置 › 计费与套餐（此前与金额同字重同色，比 ¥17015 还抢眼——2026-09-15 反馈）。
// textContent 保持原文（REQ-043 的断言按文案钉），只加类名 + data-go。
const SETUP_HINT = "尚未设置套餐或账单";
function setAmount(id, text, title) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.title = title || ""; // 分币展开挂 hover；未传 → 清掉上一轮的
  const setup = text === SETUP_HINT;
  el.classList.toggle("muted-amt", text === "无数据" || text === "今日用量都在套餐内" || setup);
  el.classList.toggle("setup-link", setup);
  if (typeof el.setAttribute !== "function") return;
  if (setup) {
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("data-go", "settings-billing");
    el.title = "去「计费与套餐」声明套餐或录入账单";
  } else if (typeof el.removeAttribute === "function") {
    el.removeAttribute("role");
    el.removeAttribute("tabindex");
    el.removeAttribute("data-go");
  }
}
// 名义：混币且有汇率 → 速览层并成 `≈¥`（原始分币进 hover）；否则分币并列。
// cache_write 档位假设必须可见（1hr/5min 差额占名义总额 5.2%，会话日志不记录
// 实际 TTL——假设不是观测），挂在名义的 hover 与卡片副行。
const NOMINAL_BASIS_NOTE = "@官方标价 · cache_write 按 1hr 计";
function renderNominalInto(id, nominal, fx) {
  const parts = fmtCurMap(nominal);
  const merged = fxMerge(nominal, fx);
  if (merged) {
    setAmount(id, fmtFxApprox(merged), NOMINAL_BASIS_NOTE + " · 原始分币 " + merged.parts.join(" + ") + " · " + fxNote(merged));
  } else {
    setAmount(id, parts.length ? parts.join(" + ") : "无数据", parts.length ? NOMINAL_BASIS_NOTE : "");
  }
  return merged;
}
function renderSpendCards(daily, monthly, fx, window = { date: statisticsToday() }) {
  // 本月支出：口径分栏。
  // 按量行：三级口径视图（旧 DTO 没有 metered_view 时退回账单口径）。
  const mView = monthly && monthly.metered_view ? meteredViewText(monthly) : { parts: fmtCurMap(meteredSpend(monthly)), title: "", unattributed: [], allActual: true };
  const mMetered = mView.parts;
  const mSubscription = fmtCurMap(spendByBasis(monthly, "fixed_subscription"));
  const monthTokens = monthly ? tokensSum(monthly.tokens_by_harness).total : 0;
  // REQ-043：**未录入套餐/付款**时要写「尚未设置套餐或账单」，不能写「无数据」。
  // 「无数据」会被读成「读取失败 / 数据缺失」，而真相是「你还没声明计费方式，
  // 所以没有实付口径可算」——真实困惑案例（2026-09-14）：用户看到本月支出两栏
  // 都是「无数据」，以为读不到数据，其实只有名义成本可算。两栏的来源不同：
  // 按量费用 = 账单（`harness_bills` → metered_actual/harness_billed），订阅月费 =
  // 价目表的 `catalog_2026_09.subscriptions` **加上**用户在「明确计费方式」里声明的
  // 月费（`billing_declarations`，summary.rs::apply_declared_subscription_fees）。
  // 三种空态必须分开：
  //   读不到 DTO        → 无数据
  //   本月有用量但未声明 → 尚未设置套餐或账单（指引下一步）
  //   本月没有用量      → 无数据（此时"没声明"不是原因）
  const noDeclaredSpend = !mMetered.length && !mSubscription.length;
  const spendAbsent = !monthly
    ? "无数据"
    : (noDeclaredSpend && monthTokens > 0) ? "尚未设置套餐或账单" : "无数据";
  setAmount("ov-m-metered", mMetered.length ? mMetered.join(" + ") : spendAbsent,
    mMetered.length ? mView.title + (mView.allActual ? "" : " · 估算按价卡折算，录入账单后以账单为准") : "");
  setAmount("ov-m-subscription", mSubscription.length ? mSubscription.join(" + ") : spendAbsent);
  const mNominal = monthly ? nominalFromByProvider(monthly.by_provider) : {};
  renderNominalInto("ov-m-nominal", mNominal, fx);
  const spendSub = document.getElementById("ov-m-spend-sub");
  if (spendSub) {
    spendSub.textContent = !monthly
      ? "本月数据不可用"
      : (mMetered.length || mSubscription.length)
        ? (mView.unattributed.length
          ? "按量费用含 " + mView.unattributed.length + " 个未归因来源的估算；不同币种不相加"
          : mView.allActual
            ? "按量费用与订阅月费分开计；不同币种不相加"
            : "按量费用按归因的价卡估算，录入账单可校准；不同币种不相加")
        : monthTokens > 0
          ? "按官方价折算只是估算；确认套餐或账单后才会出现实付金额"
          : "本月还没有用量记录";
  }
  // 今日消耗：tokens 主数 + 今日按量实付；名义只作脚注（IA 复核 §7）。
  const tk = tokensSum(daily && daily.tokens_by_harness);
  setAmount("ov-t-tokens", daily && tk.total > 0 ? fmtTokens(tk.total) + " tokens" : "无数据");
  const tSub = document.getElementById("ov-t-tokens-sub");
  if (tSub) tSub.textContent = daily && tk.total > 0 ? "今天处理的 token 数（含缓存读写）" : daily ? "今天还没有用量记录" : "今日数据暂不可读，请刷新重试";
  const tView = daily && daily.metered_view ? meteredViewText(daily) : { parts: fmtCurMap(meteredSpend(daily)), title: "", unattributed: [], allActual: true };
  const tMetered = tView.parts;
  // 与本月同一套空态区分（REQ-043）：「无数据」只在读不到 DTO 或今天没用量时用。
  const todayTokens = daily ? tokensSum(daily.tokens_by_harness).total : 0;
  // 今天有用量但按量视图为空：要么没声明（提示去设置），要么**全在套餐内**——
  // 后者不是"尚未设置"，是"今天没花按量的钱"（2026-09-17：订阅覆盖后今日卡仍写
  // 「尚未设置套餐或账单」，用户以为归因失效）。套餐内的判据 = 月 DTO 有订阅月费。
  const hasSubscription = !!monthly && fmtCurMap(spendByBasis(monthly, "fixed_subscription")).length > 0;
  const tAbsent = (!daily || todayTokens === 0) ? "无数据" : hasSubscription ? "今日用量都在套餐内" : "尚未设置套餐或账单";
  // 日粒度永远是估算：账单按月，不摊到天。
  setAmount("ov-t-metered", tMetered.length ? tMetered.join(" + ") : tAbsent,
    tMetered.length ? tView.title + " · 按价卡估算；账单按月校准，不摊到天" : "");
  renderNominalInto("ov-t-nominal", daily ? nominalFromByProvider(daily.by_provider) : {}, fx);
  // 本月用量行：规格 §4 的「已观测 tokens」与「名义成本」——首屏可见，不占卡。
  const mtk = tokensSum(monthly && monthly.tokens_by_harness);
  const dayOfMonth = Number(window.date.slice(8)) || 1;
  setAmount("ov-m-tokens", monthly && mtk.total > 0 ? fmtTokens(mtk.total) + " tokens" : "无数据");
  const mtkSub = document.getElementById("ov-m-tokens-sub");
  if (mtkSub) {
    const perHarness = Object.entries(monthly && monthly.tokens_by_harness || {})
      .filter(([, t]) => t && t.total > 0)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([harness, t]) => (HARNESS_DISPLAY[harness] || harness) + " " + fmtTokens(t.total));
    mtkSub.textContent = monthly && mtk.total > 0
      ? "日均 " + fmtTokens(Math.round(mtk.total / dayOfMonth)) + "（含缓存读写）"
        + (perHarness.length ? " · " + perHarness.join(" · ") : "")
      : monthly ? "本月还没有用量记录" : "本月用量暂不可读，请刷新重试";
  }
}

// 费用明细（本月）：原「双轨账」+「数据源」合成一张表。**服务商是主键**（用户
// 付钱的对象），执行环境是副属性「经 X」——同一服务商经多个工具使用时合成一行
// （同币种相加；币种不同则分行，不跨币相加），执行环境并列成 chip，新鲜度取最差。
// 分组：订阅（固定月费）/ 按量（按用量付费）/ 无法归类。订阅利用率倍数 =
// 标价折算 ÷ 月费，>50× 是「请核对套餐」的自检告警而非套利（§6.7 护栏）；
// unresolved 条目只说「部分用量无法估价」，不当 0。evidence_basis /
// pricing_method / unresolved_reason 这些 reason code 只进 hover——规格 §4
// 第 84 行：禁止在卡面展示 raw reason code。工具视角在「用量」页数据源面板。
const DUAL_LABEL = {
  fixed_subscription: "订阅月费",
  api_equivalent: "用量按标价折算",
  metered_actual: "按量实付",
  metered_estimate: "按量估算",
  metered_declared: "按量估算（已归因）",
  harness_billed: "执行环境账单",
};
const FRESH_RANK = { unavailable: 0, fresh: 1, partial: 2, stale: 3 };
function groupByProvider(byProvider, byHarness) {
  const groups = new Map(); // provider|currency -> row
  for (const [key, h] of Object.entries(byProvider)) {
    const [harness, provider = harness] = key.split("/");
    const bases = h.amounts_by_basis || {};
    if (!Object.keys(bases).length && !h.has_unresolved) continue;
    const currency = h.currency || "";
    const id = provider + "|" + currency;
    const fs = ((byHarness[harness] || {}).freshness) || {};
    let row = groups.get(id);
    if (!row) {
      row = { provider, currency, harnesses: [], amounts: {}, has_unresolved: false,
        pricing_methods: new Set(), evidence: new Set(), reasons: new Set(),
        freshness: { state: "unavailable", at: "" } };
      groups.set(id, row);
    }
    row.harnesses.push(harness);
    for (const [b, v] of Object.entries(bases)) row.amounts[b] = (row.amounts[b] || 0) + v;
    row.has_unresolved = row.has_unresolved || !!h.has_unresolved;
    if (h.pricing_method) row.pricing_methods.add(h.pricing_method);
    if (h.evidence_basis) row.evidence.add(h.evidence_basis);
    if (h.unresolved_reason) row.reasons.add(h.unresolved_reason);
    if ((FRESH_RANK[fs.state] || 0) > (FRESH_RANK[row.freshness.state] || 0) ||
        (fs.state === row.freshness.state && (fs.last_observed_at || "") > row.freshness.at)) {
      row.freshness = { state: fs.state || "unavailable", at: fs.last_observed_at || "" };
    }
  }
  return [...groups.values()];
}
function renderDualTrack(monthly) {
  const list = document.getElementById("ov-dual-list");
  const empty = document.getElementById("ov-dual-empty");
  list.textContent = "";
  const byProvider = (monthly && monthly.by_provider) || {};
  const byHarness = (monthly && monthly.by_harness) || {};
  const rows = groupByProvider(byProvider, byHarness);
  if (!rows.length) {
    empty.hidden = false;
    empty.textContent = monthly ? "本月还没有可拆分的支出记录" : "本月支出明细暂不可读，请刷新重试";
    return;
  }
  empty.hidden = true;
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
  const li = (cls, html, title) => {
    const el = document.createElement("li");
    if (cls) el.className = cls;
    el.innerHTML = html;
    if (title) el.title = title;
    list.appendChild(el);
  };
  if (list.dataset && list.dataset.goBound !== "1" && typeof list.addEventListener === "function") {
    list.dataset.goBound = "1";
    const go = (ev) => {
      const t = ev.target && ev.target.closest ? ev.target.closest("[data-go]") : null;
      if (t) openSettingsSection(t.dataset.go);
    };
    list.addEventListener("click", go);
    list.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(ev); } });
  }
  const nameOf = (r) => escapeHtml(PROVIDER_LABEL[r.provider] || r.provider);
  const viaOf = (r) => `<span class="via muted">经 ${r.harnesses.map((h) => escapeHtml(HARNESS_DISPLAY[h] || h)).join("、")}</span>`;
  // hover 里放 reason code：证据来源 / 计价方式 / 未定价原因。
  const hoverOf = (r) => [
    r.evidence.size ? "证据来源 " + [...r.evidence].join(", ") : "",
    r.pricing_methods.size ? "计价方式 " + [...r.pricing_methods].join(", ") : "",
    r.reasons.size ? "未定价原因 " + [...r.reasons].join(", ") : "",
  ].filter(Boolean).join("\n");
  const freshOf = (r) => {
    const at = (r.freshness.at || "").slice(5, 10);
    switch (r.freshness.state) {
      case "fresh": return `<span class="fresh">最新${at ? " " + at : ""}</span>`;
      case "stale": return `<span class="fresh stale"><span class="chip-link" data-go="settings-sources" role="button" tabindex="0">⚠ 数据过期${at ? " · 最后更新 " + at : ""} ›</span></span>`;
      case "partial": return `<span class="fresh stale"><span class="chip-link" data-go="settings-sources" role="button" tabindex="0">数据不完整${at ? " · 最后更新 " + at : ""} ›</span></span>`;
      default: return "";
    }
  };
  const subEntries = [], metered = [], unresolved = [];
  for (const r of rows) {
    const bases = Object.keys(r.amounts);
    if (bases.includes("fixed_subscription") || bases.includes("api_equivalent")) subEntries.push(r);
    else if (bases.some((b) => b.startsWith("metered") || b === "harness_billed")) metered.push(r);
    else unresolved.push(r);
  }
  const unresolvedChip = '<span class="chip hostbilled">部分用量无法估价</span>';
  const rowHtml = (r, chips) =>
    `<span class="src-name">${nameOf(r)}</span><span class="basis">${chips.join(" ")} ${viaOf(r)}</span>${freshOf(r)}`;
  if (subEntries.length) li("", `<span class="dual-track">订阅（固定月费）</span>`);
  for (const r of subEntries) {
    const fee = r.amounts.fixed_subscription || 0;
    const listEq = r.amounts.api_equivalent || 0;
    const chips = [];
    if (fee > 0) chips.push(`<span class="chip subscription">${DUAL_LABEL.fixed_subscription} ${fmtCur(fee, r.currency || null)}</span>`);
    if (listEq > 0) chips.push(`<span class="chip diagnostic">${DUAL_LABEL.api_equivalent} ${fmtCur(listEq, r.currency || null)}（参考）</span>`);
    if (r.has_unresolved) {
      chips.push(unresolvedChip);
    } else if (fee === 0 && listEq > 0) {
      chips.push('<span class="chip chip-link" data-go="settings-billing" role="button" tabindex="0">未填写月费，去填写 ›</span>');
    } else if (fee > 0 && listEq > 0) {
      const mult = listEq / fee;
      chips.push(mult > 50
        ? `<span class="chip diagnostic">⚠ 数字异常（折算为月费的 ${mult.toFixed(0)} 倍），请核对套餐</span>`
        : mult < 0.5
          ? `<span class="chip estimate">⚠ 没用够（只值回月费的 ${mult.toFixed(2)}×）</span>`
          : `<span class="chip measured">值回月费 ${mult.toFixed(1)}×</span>`);
    }
    li("", rowHtml(r, chips), hoverOf(r));
  }
  if (metered.length) li("", `<span class="dual-track">按量（按用量付费）</span>`);
  for (const r of metered) {
    const chips = Object.entries(r.amounts).map(([b, v]) => {
      let label = DUAL_LABEL[b] || b;
      if (b === "metered_estimate") {
        label = r.pricing_methods.has("fair-market") ? "按公允价估算"
          : r.pricing_methods.has("fair-market-fallback") ? "按官方价估算" : "按量估算（上界）";
      } else if (b === "metered_declared") {
        // 已归因：按该计费方自己的价卡算写「按其价卡估算」；价卡没收录这些模型时
        // 退回了官方标价（可能连币种都是官方的），必须写明，否则用户看到中转按
        // 美元估算会以为填错了币种（2026-09-16）。
        label = r.pricing_methods.has("fair-market-fallback")
            ? "已归因 · 价卡未收录，按官方标价估算" : "已归因 · 按其价卡估算";
      }
      const cls = b === "metered_actual" || b === "harness_billed" ? "measured" : "estimate";
      return `<span class="chip ${cls}">${label} ${fmtCur(v, r.currency || null)}${cls === "estimate" ? "（参考）" : ""}</span>`;
    });
    if (r.has_unresolved) chips.push(unresolvedChip);
    li("", rowHtml(r, chips), hoverOf(r));
  }
  if (unresolved.length) li("", `<span class="dual-track">无法归类</span>`);
  for (const r of unresolved) {
    li("", rowHtml(r, [r.has_unresolved ? unresolvedChip : '<span class="chip">无数据</span>']), hoverOf(r));
  }
}

// 决策卡「现在该用谁」：四态建议行 + 各订阅窗口/利用率为一行。Codex 是唯一
// 正向余量源（data_codex_quota 的 plan 快照）；Claude Pro 余量不可得（quotaLimits
// 只有拒绝快照，不得反推假百分比）；GLM/MiniMax 无配额证据源 → 只显示利用率。
function renderDecideCard(monthly, quota, claudeQuotaState) {
  const body = document.getElementById("ov-decide-body");
  const byProvider = (monthly && monthly.by_provider) || {};
  body.textContent = "";
  const rows = [];
  // Codex 窗口条（真 meter）
  let codexState = null;
  // plan 快照的真实形状是 limits.primary（fold plan_from_rate_limits 产物），
  // 不是顶层 primary——审查 #1：旧读法恒 undefined，决策卡整条失效。
  const codexWin = quota && quota.limits && quota.limits.primary;
  // 无可用配额证据时保留中性说明，不把未知配额当作零成本。
  const card = document.getElementById("ov-decide-card");
  const observed = quota && Date.parse(quota.observed_at);
  // A snapshot older than 24h, from the future, or past reset cannot describe current headroom.
  const hasQuota = !!(codexWin && overviewNumber(codexWin.used_percent) && codexWin.used_percent <= 100
    && Number.isFinite(observed) && observed <= Date.now() && Date.now() - observed <= 24 * 60 * 60 * 1000
    && overviewNumber(codexWin.resets_at) && codexWin.resets_at * 1000 > Date.now());
  if (card) card.hidden = false;
  const observedEl = document.getElementById("ov-decide-observed");
  if (observedEl) {
    observedEl.textContent = hasQuota && quota.observed_at
      ? "快照 " + formatStatisticsDateTime(new Date(quota.observed_at), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      : "";
  }
  if (hasQuota) {
    const used = codexWin.used_percent;
    const remain = Math.max(0, 100 - used);
    const resetsAt = codexWin.resets_at
      ? formatStatisticsDateTime(codexWin.resets_at * 1000, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      : "未知";
    codexState = remain;
    rows.push(`<li><span class="src-name">Codex（${quota.plan_type || "订阅"}）</span>
      <span class="basis"><span class="meter"><span class="meter-fill ${remain < 15 ? "danger" : ""}" style="width:${remain}%"></span></span>
      <span class="fresh ${remain < 15 ? "stale" : ""}">剩余 ${remain.toFixed(0)}% · ${resetsAt} 重置</span></span></li>`);
  } else {
    rows.push(`<li><span class="src-name">Codex</span><span class="basis"><span class="chip">读不到套餐额度</span></span></li>`);
  }
  // Claude Pro：三态（spec §8.3.2）。**这里没有百分比这回事**——Claude Code 只在
  // 被拒绝的那一刻记一条 quotaLimits（真机 42/42 全是 status:"rejected"，无
  // used_percent），所以永远拿不到正向余量。能显示的是另外两样：
  //   exhausted → 「5 小时窗口已耗尽 · 02:20 重置」（有 resetsAt 为证）
  //   unknown   → 「窗口状态未知 · 近 7 天撞窗 N 次」
  // 显示条件：有 Anthropic 计费条目（在用），或状态已是 exhausted（有直接证据）。
  const anthropic = byProvider["claude-code/anthropic"];
  const claudeQuota = claudeQuotaState || {};
  const claudeExhausted = claudeQuota.state === "exhausted";
  // 建议行的附加段：列表里已渲染的 Claude / 订阅线路状态，此前不参与结论——
  // 截图（2026-09-15）里 Claude Pro 近 7 天撞窗 5 次，建议行却只说「Codex 额度
  // 较低」。**只在有证据时追加**：没有 Claude 证据时文案与旧版逐字相同，
  // 也绝不说 Claude「可用」（没有正向读数，沉默有两种解释）。
  const adviceExtras = [];
  if (anthropic || claudeExhausted) {
    if (claudeExhausted) {
      const until = formatStatisticsDateTime(claudeQuota.resets_at * 1000, {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
      // 标签由后端随 DTO 给（决策卡 / 待处理 / 通知共用一个词表），前端不再维护
      // 第二份映射。**回退必须按 window 推**，不能写死"5 小时窗口"——那样周窗
      // 会被标成 5 小时尺度（差 33 倍），而 DTO 缺字段恰恰是最需要如实的时候。
      const winLabel = claudeQuota.window_label
        || (claudeQuota.window === "seven_day" ? "7 天窗口" : "5 小时窗口");
      rows.push(`<li><span class="src-name">Claude Pro</span>
        <span class="basis"><span class="chip estimate">${winLabel}已耗尽</span>
        <span class="fresh stale nowrap">${until} 重置</span></span></li>`);
      adviceExtras.push(`Claude Pro ${winLabel}已耗尽，${until} 重置`);
    } else {
      const hits = Number(claudeQuota.windows_recent || 0);
      // 「未知」不等于"什么都不知道"：上次限流记录的重置时刻是已知的（走到这个
      // 分支时它必然已经过去）。说清"上次那个窗口什么时候恢复的"，比只丢一句
      // 「窗口状态未知」有用得多——用户问的正是这个（2026-09-14 反馈）。
      const lastReset = claudeQuota.last_resets_at
        ? formatStatisticsDateTime(claudeQuota.last_resets_at * 1000,
            { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        : null;
      const lastText = lastReset ? " · 上次限流已于 " + lastReset + " 重置" : "";
      const hitsText = hits > 0 ? " · 近 7 天撞窗 " + hits + " 次" : "";
      rows.push(`<li><span class="src-name">Claude Pro</span>
        <span class="basis"><span class="chip" title="Claude Code 只在被限流时记录一条事件，从不记录剩余额度；没有正向读数就不推算百分比，也不会从「没有新记录」反推「可用」">窗口状态未知${lastText}${hitsText}</span></span></li>`);
      if (hits > 0) adviceExtras.push(`Claude Pro 近 7 天撞窗 ${hits} 次，窗口状态未知`);
    }
  }
  // GLM / MiniMax：无配额证据源，只显示利用率（双轨账里已有，这里给决策提示）
  for (const key of ["claude-code/zhipu-glm", "claude-code/minimax"]) {
    const h = byProvider[key];
    if (!h) continue;
    const label = PROVIDER_LABEL[key.split("/")[1]] || key;
    const fee = (h.amounts_by_basis || {}).fixed_subscription || 0;
    const eq = (h.amounts_by_basis || {}).api_equivalent || 0;
    if (fee > 0 && eq > 0) {
      const mult = eq / fee;
      const low = mult < 0.5;
      rows.push(`<li><span class="src-name">${label}</span>
        <span class="basis"><span class="chip ${low ? "estimate" : "measured"}">${low ? "⚠ 没用够" : "值回月费"} ${mult.toFixed(1)}×</span>
        <span class="fresh nowrap">月费 ${fmtCur(fee, h.currency)} · 用量按标价折算 ${fmtCur(eq, h.currency)}</span></span></li>`);
      if (low) adviceExtras.push(`${label} 月费只用出 ${mult.toFixed(1)}×`);
    }
  }
  body.innerHTML = `<ul class="src-list">${rows.join("")}</ul>`;
  // 建议行（四态状态机）+ 有证据的附加段
  const codexLow = codexState != null && codexState < 15;
  const extras = adviceExtras.length ? "，" + adviceExtras.join("，") : "";
  let advice;
  if (codexLow) {
    advice = "Codex 额度较低" + extras + "；请在用量或设置中确认可用线路";
  } else if (codexState != null && codexState <= 100) {
    advice = `Codex 额度还剩 ${codexState.toFixed(0)}%，可继续使用` + (extras ? "；" + adviceExtras.join("，") : "");
  } else {
    advice = "暂无法给出建议：配额证据不可用或已过期" + (extras ? "；" + adviceExtras.join("，") : "");
  }
  const adviceEl = document.createElement("div");
  adviceEl.className = "decide-advice";
  adviceEl.textContent = "💡 " + advice;
  body.appendChild(adviceEl);
  if (card && card.classList) card.classList.toggle("warn", codexLow || claudeExhausted);
}

function syncDot(sync) {
  const dot = document.getElementById("wb-sync-dot");
  if (!sync) return;
  dot.className = "sync-dot" + (sync.ok ? " ok" : sync.stage === "never" ? "" : " fail");
  dot.title = sync.message || (sync.ok ? "同步正常" : "同步状态未知");
}

// v0.9 Stage 0.6 共用渲染器：把 data_monthly_summary 的 DTO 渲染成
// 「数据源」panel。**核心纪律**（spec §0.1）：
// - unavailable 执行环境固定显示「无数据」，**绝不渲染 0.00**（空执行环境 amount
//   字段是空 map 不是 0，0.00 会让用户把"没测到"误读成"测到 0 元"——
//   .sum() 产 -0.0 的负零事件就是这条纪律踩出来的，DTO 已修到正零），
// - 金额一律带 basis 标签：metered_actual→「实测」、metered_estimate→「估算」、
//   api_equivalent→「套餐等价·诊断」、fixed_subscription→「订阅」、
//   harness_billed→「执行环境账单」，不允许裸数字；
// - **不带货币符号**——DTO 刻意不带 currency：claude 的 CNY 估与 USD 诊
//   断混在同一 map，前端写 "¥549" 就是编造币种。
// - staleness 必须挂在执行环境行右侧（与数字同排），不许只藏到下方 note：
//   用户从卡片本身就能判断"是不是真的"，这是 2026-09-01 alert stale
//   事故里 month.json 与 alert.json 自相矛盾的同款教训。
const BASIS_LABEL = {
  metered_actual: { label: "实测", cls: "measured" },
  metered_estimate: { label: "估算", cls: "estimate" },
  metered_declared: { label: "估算·已归因", cls: "estimate" },
  api_equivalent: { label: "套餐等价·诊断", cls: "diagnostic" },
  fixed_subscription: { label: "订阅", cls: "subscription" },
  harness_billed: { label: "执行环境账单", cls: "hostbilled" },
};
// id 顺序：DTO 给的 BTreeMap 键序就是事实序（白盒契约：白盒降级是从这点
// 开始的——以后 summary 给排序时删这里）。
const HARNESS_DISPLAY = {
  "zcode": "ZCode",
  "dsh": "DeepSeek Harness",
  "claude-code": "Claude Code",
  "codex": "Codex",
  "workbuddy": "WorkBuddy",
};

function freshnessText(state, lastObservedAt) {
  const at = (lastObservedAt || "").slice(0, 10);
  switch (state) {
    case "fresh": return at ? "新鲜 · 观测 " + at : "新鲜";
    case "stale": return "⚠ 过期 · 最后观测 " + at;
    case "partial": return "部分覆盖 · 最后观测 " + at;
    case "unavailable":
    default: return "无数据";
  }
}

function pricingMethodText(method) {
  return {
    "provider-card": "原厂价格卡",
    "fair-market": "官方价参考估算",
    "fair-market-fallback": "当前价参考估算",
  }[method] || null;
}

function pricingReasonText(reason) {
  return {
    "missing-provider-route-evidence": "付费路由待确认",
    "billing-route-unknown": "付费方式待确认",
    "provider-specific-card-unavailable": "缺少对应服务商价卡",
    "missing-or-unpriced-route-evidence": "来源或价格仍待确认",
    "no-price-card": "没有匹配的原厂价格卡",
    "no-pricing-snapshot": "历史缺少事件时间的价格快照",
  }[reason] || null;
}

const MIXED_CURRENCY = "__mixed__";

// 跨执行环境面板的金额必须分币。`by_harness` 条目可能混币（claude-code 下 anthropic
// USD + minimax CNY），契约里 currency=None 就是"未声明单币"（data_contract.rs
// HarnessAmount::currency）；此前渲染 `v.toFixed(2)` 裸数字，把 $20+¥49 显示成
// 「订阅 69.00」——正是 CLAUDE.md 说的"同桶跨币相加就是编造"（2026-09-15 巡检）。
// 权威归属在 by_provider（键 "harness/provider"，条目级单币）：按执行环境前缀收集，
// 只在同币种内相加；没有 provider 归属时才回退到 by_harness，且混币时不给数字。
// 返回 [{basis, currency, amount}]，basis 顺序沿用 by_harness 的 BTreeMap 键序。
function harnessAmountsByCurrency(harnessId, harnessRow, byProvider) {
  const out = [];
  const seen = new Set();
  const push = (basis, currency, amount) => {
    const key = basis + "\u0000" + currency;
    if (seen.has(key)) {
      const hit = out.find((e) => e.basis === basis && e.currency === currency);
      hit.amount += amount;
    } else {
      seen.add(key);
      out.push({ basis, currency, amount });
    }
  };
  const providerRows = Object.entries(byProvider || {})
    .filter(([key]) => key.startsWith(harnessId + "/"))
    .map(([, r]) => r);
  const basisOrder = Object.keys(harnessRow.amounts_by_basis || {});
  if (providerRows.length > 0) {
    for (const r of providerRows) {
      if (!r.currency) continue;
      for (const [basis, amount] of Object.entries(r.amounts_by_basis || {})) push(basis, r.currency, amount);
    }
    out.sort((a, b) => basisOrder.indexOf(a.basis) - basisOrder.indexOf(b.basis));
    return out;
  }
  for (const [basis, amount] of Object.entries(harnessRow.amounts_by_basis || {})) {
    push(basis, harnessRow.currency || MIXED_CURRENCY, amount);
  }
  return out;
}

function renderSourcesPanel(dto, prefix) {
  const list = document.getElementById(prefix + "-list");
  const empty = document.getElementById(prefix + "-empty");
  const meta = document.getElementById(prefix + "-meta");
  list.innerHTML = "";
  meta.innerHTML = "";

  const byHarness = dto.by_harness || {};
  const keys = Object.keys(byHarness);
  const allUnavailable = keys.every(
    (k) => !byHarness[k].freshness || byHarness[k].freshness.state === "unavailable"
  );

  if (allUnavailable && (dto.excluded_harnesses || []).length > 0
      && Object.keys(byHarness).length === 0) {
    empty.hidden = false;
    empty.textContent = "本月无跨执行环境数据";
  } else {
    empty.hidden = true;
    for (const id of keys) {
      const row = byHarness[id];
      const li = document.createElement("li");
      const fs = (row.freshness || {}).state || "unavailable";
      const unavailable = fs === "unavailable";
      li.className = unavailable ? "no-data" : "";

      const name = document.createElement("span");
      name.className = "harness";
      name.textContent = HARNESS_DISPLAY[id] || id;
      li.appendChild(name);

      const basisEl = document.createElement("span");
      basisEl.className = "basis";
      if (unavailable) {
        // 不产 basis chip——chip 会让用户以为"这里有金额"，更糟的是
        // 把 empty map 渲染成「0.00 实测」（spec §0.1 反面教材）。
        const span = document.createElement("span");
        span.className = "chip";
        span.textContent = "无数据";
        basisEl.appendChild(span);
      } else {
        const entries = harnessAmountsByCurrency(id, row, dto.by_provider);
        if (entries.length === 0) {
          // 有观测日但全 unknown（claude 全 unknown 日等）：不算 unavailable，
          // 也不产金额——chip 标「无可计金额」+ has_unresolved=true 时再加
          // 红 tag「含未定价 tokens」。
          const span = document.createElement("span");
          span.className = "chip";
          span.textContent = "无可计金额";
          basisEl.appendChild(span);
        } else {
          for (const { basis, currency, amount } of entries) {
            const meta2 = BASIS_LABEL[basis];
            if (!meta2) continue;
            const chip = document.createElement("span");
            chip.className = "chip " + meta2.cls;
            if (currency === MIXED_CURRENCY) {
              chip.textContent = meta2.label + " 币种未声明，见费用明细";
              chip.title = "该执行环境条目未声明单一币种（通常是多家服务商 $ 与 ¥ 混在一起），跨币相加没有意义；总览「费用明细」按服务商分币列出";
            } else {
              chip.textContent = meta2.label + " " + fmtCur(amount, currency);
            }
            basisEl.appendChild(chip);
          }
        }
        if (row.has_unresolved) {
          const t = document.createElement("span");
          t.className = "unresolved-tag";
          t.textContent = "含未定价 tokens";
          t.title = "看见了 token 但价目表认不出模型——部分用量暂无法估价，不计 0 也不算没测";
          basisEl.appendChild(t);
        }
      }
      li.appendChild(basisEl);

      const pricing = pricingMethodText(row.pricing_method);
      const reason = pricingReasonText(row.unresolved_reason);
      if (pricing || reason || row.has_unresolved) {
        const explain = document.createElement("span");
        explain.className = "pricing-explain";
        explain.textContent = pricing || "价格暂不可用";
        if (reason) explain.textContent += " · " + reason;
        explain.title = [row.pricing_method, row.unresolved_reason].filter(Boolean).join(" · ");
        li.appendChild(explain);
      }

      const fr = document.createElement("span");
      fr.className = "fresh " + fs;
      fr.textContent = freshnessText(fs, (row.freshness || {}).last_observed_at);
      li.appendChild(fr);

      list.appendChild(li);
    }
  }

  // coverage + excluded + summable。summable 行是诚实窗口外的最后一道：
  // 即便所有执行环境都显示「无数据」，summable 也必须是 0 + 备注，而不是消失。
  const cov = dto.coverage || { measured_fields: 0, total_fields: 0, denominator_version: 1 };
  const covLine = document.createElement("div");
  covLine.textContent = "数据覆盖 " + cov.measured_fields + "/" + cov.total_fields +
"";
  meta.appendChild(covLine);

  const excluded = dto.excluded_harnesses || [];
  const excLine = document.createElement("div");
  if (excluded.length === 0) {
    excLine.textContent = "范围外：（无）";
  } else {
    excLine.textContent = "范围外：" + excluded.map((h) => HARNESS_DISPLAY[h] || h).join("、");
  }
  meta.appendChild(excLine);

  // summable 行：unavailable 时改显「无数据」红字 + 备注，绝不显 0.00。
  const summable = dto.total_summable;
  const anyData = keys.some((k) => (byHarness[k].freshness || {}).state !== "unavailable");
  const sumLine = document.createElement("div");
  sumLine.className = "summable" + (anyData ? "" : " no-data");
  if (anyData && summable > 0) {
    sumLine.textContent = "账单级实付 " + fmtCur(summable, "CNY");
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = "估算与套餐等价值不计入账单";
    sumLine.appendChild(note);
  } else if (anyData) {
    // 审查 UX#4：DSH stale（非 unavailable）但 summable 恒 0 时渲染大号
    // "0.00" 浅色盒，与头部 ¥580+$1497 同屏对撞，读起来像"钱没了"。降级
    // 为行内灰字说明白"为什么是 0"。
    sumLine.className = "summable-zero";
    sumLine.textContent = "账单级实付：无（当月各家均为估算/套餐等价口径，或数据过期，未出账单）";
  } else {
    sumLine.textContent = "账单级实付：无数据";
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = "全部执行环境 unavailable；spec §0.1 不得渲染为 ¥0 或看似完整的总额";
    sumLine.appendChild(note);
  }
  meta.appendChild(sumLine);
}

function renderSourcesPanelFailure(message, prefix) {
  const list = document.getElementById(prefix + "-list");
  const empty = document.getElementById(prefix + "-empty");
  const meta = document.getElementById(prefix + "-meta");
  list.innerHTML = "";
  meta.innerHTML = "";
  empty.hidden = false;
  empty.textContent = "跨执行环境源状态读取失败：" + message;
}

// ---------- Token 日历 ----------

function calendarCostText(row) {
  if (!row) return "";
  const parts = [];
  const cny = (row.dsh_cost_cny || 0) + (row.claude_cost_cny || 0);
  const usd = (row.claude_cost_usd || 0) + (row.codex_cost_usd || 0);
  if (cny > 0) parts.push(fmtCur(cny, "CNY"));
  if (usd > 0) parts.push(fmtCur(usd, "USD"));
  return parts.join(" + ");
}

async function renderCalendar() {
  const grid = document.getElementById("cal-grid");
  const empty = document.getElementById("cal-empty");
  const total = document.getElementById("cal-total");
  const monthInput = document.getElementById("cal-month");
  monthInput.value = calMonth;

  // v0.9 Stage D：日历数据源切逐日跨执行环境（read_calendar_month）——此前只画
  // DSH 日轴，DSH 零用量月份让 claude/codex 的真实用量在日历上完全不可见
  // （2026-09 实测：57 亿 token 的月份显示一片空白）。旧 read_month 命令
  // v0.9.1 Phase 4 已退役。
  let resp;
  try {
    resp = await invoke("read_calendar_month", { month: calMonth });
  } catch (e) {
    empty.hidden = false;
    empty.textContent = "读取失败：" + errText(e);
    grid.innerHTML = "";
    total.textContent = "";
    calendarLoadedMonth = null;
    return;
  }
  calData = resp;
  calendarLoadedMonth = calMonth;
  grid.innerHTML = "";

  // 数据源 panel（v0.9 Stage 0.6 日历页月份级诚实状态）：并发拉
  // data_monthly_summary，失败不拖垮方格（spec §0.1：日轴与跨执行环境源各自
  // 诚实渲染，不互相替代）。方格走 read_month 的 DSH 日轴数据，月级源
  // 状态走 data_monthly_summary——方格与月级源可能分别有/无数据，不许混为一谈。
  let calSourcesDto = null;
  try {
    calSourcesDto = await invoke("data_monthly_summary", { month: calMonth });
  } catch (eCal) {
    renderSourcesPanelFailure(errText(eCal), "cal-sources");
    calSourcesDto = null;
  }
  // cal-total 加新鲜度标注——stale 必须挂在金额旁边，不许只藏到下方 note。
  const calTotalEl = total;
  let calSuffix = "";
  if (calSourcesDto && calSourcesDto.freshness) {
    const fs = calSourcesDto.freshness.state;
    const at = (calSourcesDto.freshness.last_observed_at || "").slice(0, 10);
    if (fs === "fresh") {
      calSuffix = "（新鲜）";
    } else if (fs === "stale") {
      calSuffix = "（数据停在 " + at + "）";
    } else if (fs === "partial") {
      calSuffix = "（部分覆盖）";
    }
    // unavailable 状态：标题不显示金额（spec §0.1 不渲染 0.00）——交由
    // 下方 sources panel 的渲染函数统一处理，这里只覆盖"金额存在"分支。
  }

  // 逐日 map + 月合计（token 跨执行环境可加；钱分币并列，口径各异不合并）。
  const calDays = resp.days || {};
  const byDate = calDays;
  let monthTokens = 0;
  const monthCosts = {};
  let hasData = false;
  for (const row of Object.values(calDays)) {
    if ((row.total_tokens || 0) > 0) hasData = true;
    monthTokens += row.total_tokens || 0;
    for (const k of ["dsh_cost_cny", "claude_cost_cny"]) monthCosts.CNY = (monthCosts.CNY || 0) + (row[k] || 0);
    for (const k of ["claude_cost_usd", "codex_cost_usd"]) monthCosts.USD = (monthCosts.USD || 0) + (row[k] || 0);
  }
  if (!hasData) {
    empty.hidden = false;
    empty.textContent = "该月暂无数据";
    total.textContent = calSourcesDto && calSourcesDto.freshness.state !== "unavailable"
      ? "" : calSuffix;
    if (calSourcesDto) renderSourcesPanel(calSourcesDto, "cal-sources");
    document.getElementById("cal-note").textContent =
      "三执行环境该月都没有 token 入账（历史月数据按各自归档；当月无数据 = 还没折进账）。";
    return;
  }
  empty.hidden = true;
  const monthCostText = [
    monthCosts.CNY > 0 ? fmtCur(monthCosts.CNY, "CNY") : "",
    monthCosts.USD > 0 ? fmtCur(monthCosts.USD, "USD") : "",
  ].filter(Boolean).join(" + ");
  total.textContent = calMetric === "cost"
    ? (monthCostText ? monthCostText + " · 成本（按来源口径）" : "成本不可用")
    : fmtTokens(monthTokens) + " tokens";
  if (calSuffix) total.textContent += " " + calSuffix;

  const dows = ["日", "一", "二", "三", "四", "五", "六"];
  for (const d of dows) {
    const h = document.createElement("div");
    h.className = "cal-dow";
    h.textContent = d;
    grid.appendChild(h);
  }

  const [y, m] = calMonth.split("-").map(Number);
  // 这些是“日期字符串”的民历运算，不是时间戳投影。使用 UTC 仅作为
  // 无时区的日期容器，避免浏览器本地时区在西区/东区把首日星期或月末
  // 推到前后一天；统计数据本身仍按 statisticsTimezoneName() 查询。
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = statisticsToday();
  // DSH 的最后观测日（月级，来自 data_monthly_summary.by_harness.dsh）——过期时
  // 格子 tooltip 说明 ¥ 段缺席的含义（审查 UX#7）。
  const dshRow = calSourcesDto && calSourcesDto.by_harness && calSourcesDto.by_harness.dsh;
  const dshStale = dshRow && dshRow.freshness.state === "stale"
    ? (dshRow.freshness.last_observed_at || "").slice(0, 10) : null;

  for (let i = 0; i < lead; i++) {
    const c = document.createElement("div");
    c.className = "cal-cell blank";
    grid.appendChild(c);
  }
  for (let d = 1; d <= dim; d++) {
    const date = calMonth + "-" + String(d).padStart(2, "0");
    const cell = document.createElement("div");
    cell.className = "cal-cell";
    const row = byDate[date];
    const dayTokens = row ? (row.total_tokens || 0) : 0;
    if (dayTokens > 0) {
      cell.classList.add("has-data");
      // 副行：该日耗费，每段带执行环境短前缀（审查 UX#6——三段无执行环境的钱串只能
      // 靠页脚图例反推，全 USD 时连顺序锚都没有）。口径各异不相加。
      const day = document.createElement("div");
      day.className = "d";
      day.textContent = String(d);
      const amt = document.createElement("div");
      amt.className = "amt";
      const costText = calendarCostText(row);
      amt.textContent = calMetric === "cost"
        ? (costText || "成本不可用")
        : fmtTokens(dayTokens);
      cell.appendChild(day);
      cell.appendChild(amt);
      if (calMetric === "cost") {
        const token = document.createElement("div");
        token.className = "cost";
        token.textContent = fmtTokens(dayTokens) + " tokens";
        cell.appendChild(token);
      }
      // 副行按显示指标走：Tokens 模式列各执行环境的 token（有用量的执行环境都在，哪怕钱是
      // 0——此前只列有钱的执行环境，订阅覆盖的日子整行空白，看起来像"没有执行环境"，
      // 2026-09-17 反馈）；成本模式列各执行环境的钱，用量在套餐内的写「套餐内」。
      const harnessTokens = [];
      if ((row.dsh_tokens || 0) > 0) harnessTokens.push("DSH " + fmtTokens(row.dsh_tokens));
      if ((row.claude_tokens || 0) > 0) harnessTokens.push("CC " + fmtTokens(row.claude_tokens));
      if ((row.codex_tokens || 0) > 0) harnessTokens.push("CX " + fmtTokens(row.codex_tokens));
      const costOrPlan = [];
      if ((row.dsh_tokens || 0) > 0) costOrPlan.push((row.dsh_cost_cny || 0) > 0 ? "DSH " + fmtCur(row.dsh_cost_cny, "CNY") : "DSH 套餐内");
      if ((row.claude_tokens || 0) > 0) {
        const parts = [];
        if ((row.claude_cost_cny || 0) > 0) parts.push(fmtCur(row.claude_cost_cny, "CNY"));
        if ((row.claude_cost_usd || 0) > 0) parts.push(fmtCur(row.claude_cost_usd, "USD"));
        costOrPlan.push("CC " + (parts.length ? parts.join(" + ") : "套餐内"));
      }
      if ((row.codex_tokens || 0) > 0) costOrPlan.push((row.codex_cost_usd || 0) > 0 ? "CX " + fmtCur(row.codex_cost_usd, "USD") : "CX 套餐内");
      const subParts = calMetric === "cost" ? costOrPlan : harnessTokens;
      if (subParts.length) {
        const cost = document.createElement("div");
        cost.className = "cost";
        cost.textContent = subParts.join(calMetric === "cost" ? " + " : " · ");
        cell.appendChild(cost);
      }
      // tooltip：token 与耗费都按执行环境逐行（审查 UX#6：耗费行此前是同一串
      // 无执行环境的 costs）；DSH 过期期间显式说明 ¥ 段缺席 = 未测到（UX#7）。
      cell.title =
        "DSH " + fmtTokens(row.dsh_tokens || 0) + "（" + fmtCur(row.dsh_cost_cny, "CNY") + "）" +
        "\nClaude " + fmtTokens(row.claude_tokens || 0) + "（" +
        [fmtCur(row.claude_cost_cny, "CNY"), fmtCur(row.claude_cost_usd, "USD")].join(" + ") + "）" +
        "\nCodex " + fmtTokens(row.codex_tokens || 0) + "（" + fmtCur(row.codex_cost_usd, "USD") + "）" +
        "\n耗费口径：DSH 实测 / Claude relay 估算 / Codex 等价标价，不相加" +
        (dshStale ? "\n⚠ DSH 数据过期（最后观测 " + dshStale + "）：¥ 段缺席 = 未测到，非零支出" : "");
    } else {
      const day = document.createElement("div");
      day.className = "d";
      day.textContent = String(d);
      cell.appendChild(day);
    }
    if (date === today) cell.classList.add("today");
    // 审查 UX#8：未来日与"没测到"同款渲染，用户无法区分"还没发生"和
    // "发生过但没测到"——未来日降透明度，不参与无数据解读。
    if (date > today) cell.classList.add("future");
    // 当日按小时面板的入口：点任意非未来日 → 下方面板切到该日
    // （未来日没有"按小时"可看，不响应）。
    if (date <= today) {
      cell.classList.add("clickable");
      const selectDate = () => {
        calSelectedDate = date;
        grid.querySelectorAll(".cal-cell.selected").forEach((el) => el.classList.remove("selected"));
        cell.classList.add("selected");
        renderHourly(date);
      };
      cell.setAttribute("role", "button");
      cell.tabIndex = 0;
      cell.setAttribute("aria-label", date + "，查看按小时用量");
      cell.onclick = selectDate;
      cell.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectDate();
        }
      };
      if (date === (calSelectedDate || today)) cell.classList.add("selected");
    }
    grid.appendChild(cell);
  }
  document.getElementById("cal-note").textContent = calMetric === "cost"
    ? "方格主行 = 该日成本，按来源分别显示 CNY/USD；无成本证据显示“成本不可用”，不等于 ¥0。副行 = token 总量。点任意过去日 → 下方面板看该日按小时分布。"
    : "方格主行 = 该日三执行环境 token 总量（DSH + Claude Code + Codex）；副行 = 该日耗费，分执行环境分币并列（DSH 实测 / Claude relay 估算 / Codex 等价标价，口径各异不相加）。点任意过去日 → 下方面板看该日按小时分布。";

  // 月份级跨执行环境概览：放在方格之后、note 之前。
  if (calSourcesDto) renderSourcesPanel(calSourcesDto, "cal-sources");

  // 当日按小时（旧 calendar.html 小时格组件的工作台接入）——默认选中今天。
  renderHourly(calSelectedDate || today);
}

// 当日按小时分布。数据来源（read_hourly_distribution 的 harnesses_available 值即
// 来源，逐执行环境如实渲染）：三执行环境统一走权威库 "sql-facts"，该日无已 ingest
// 事实则为 null。「来源标注让部分覆盖可见」：小时只含已 ingest 会话，
// 值偏小不是 bug 是覆盖面——标注写进面板 note。
async function renderHourly(date) {
  const grid = document.getElementById("hourly-grid");
  const note = document.getElementById("hourly-note");
  const titleDate = document.getElementById("hourly-date");
  if (!grid) return; // calendar tab 未建（防御；HTML 里有就该在）
  titleDate.textContent = date + (date === statisticsToday() ? "（今天）" : "");
  grid.innerHTML = "";
  let resp;
  try {
    resp = await invoke("read_hourly_distribution", { date });
  } catch (e) {
    note.textContent = "读取失败：" + errText(e);
    return;
  }
  const hours = resp.hours || [];
  const src = resp.harnesses_available || {};
  const HARNESSES = [
    ["dsh_tokens", "DSH", "hour-dsh"],
    ["claude_tokens", "CC", "hour-claude"],
    ["codex_tokens", "CX", "hour-codex"],
  ];
  let maxTotal = 0;
  const totals = hours.map((h) =>
    HARNESSES.reduce((s, [k]) => s + (h[k] || 0), 0)
  );
  for (const v of totals) if (v > maxTotal) maxTotal = v;
  hours.forEach((h, i) => {
    const cell = document.createElement("div");
    const total = totals[i];
    cell.className = "hour-cell" + (total === 0 ? " empty" : "") +
      (total > 0 && total === maxTotal ? " peak" : "");
    const hh = String(h.hour).padStart(2, "0");
    if (total === 0) {
      // 全执行环境该小时都没有测量——空格（虚线），不是 0。
      cell.title = hh + ":00–" + hh + ":59 " + statisticsTimezoneName() + " · 该小时三执行环境都没有已测用量";
    } else {
      const bar = document.createElement("div");
      bar.className = "hour-bar";
      // 分段条：各执行环境一段（高度占比 = 该执行环境 / 全日峰值），从下往上堆。
      // 分段高是**各自占总峰值的比**，不是互相归一——一眼能比跨执行环境量级。
      for (const [k, name, cls] of HARNESSES) {
        const v = h[k] || 0;
        if (v <= 0) continue;
        const seg = document.createElement("div");
        seg.className = "hour-seg " + cls;
        seg.style.height = Math.max(3, Math.round((v / maxTotal) * 52)) + "px";
        bar.appendChild(seg);
      }
      cell.appendChild(bar);
      const lab = document.createElement("div");
      lab.className = "hour-label";
      lab.textContent = hh;
      cell.appendChild(lab);
      const lines = HARNESSES
        .map(([k, name]) => [name, h[k]])
        .filter(([, v]) => v != null && v > 0)
        .map(([name, v]) => name + " " + fmtTokens(v));
      cell.title = hh + ":00–" + hh + ":59 " + statisticsTimezoneName() + "\n" + lines.join("\n");
    }
    grid.appendChild(cell);
  });
  // harnesses_available 的值：Phase 3.5 Tier B 起三执行环境统一 "sql-facts"（权威库
  // 小时重放）或 null（该日没有已 ingest 的事实）——summary.rs hourly_distribution
  // 的 source() 闭包 + lib.rs `read_hourly_distribution_matches_calendar_codex_day`
  // 钉死。此前这里还在匹配已退役的 "today-json"/"facts-index"，Codex 写死
  // 「全量折算（fold）」：真机上 DSH/Claude 永远标「无小时数据」，与方格里明明
  // 有的柱子自相矛盾（2026-09-15 巡检）。按值如实渲染，不再认死字符串。
  const harnessNote = (label, value, missingHint) => value
    ? `${label}：已入库事实的小时重放（${value}；只含已 ingest 会话，可能偏小）`
    : `${label}：无小时数据（${missingHint}）`;
  const srcNote = [
    harnessNote("Codex", src.codex, "该日没有已 ingest 的 Codex 会话"),
    harnessNote("DSH", src.dsh, "该日会话未 ingest"),
    harnessNote("Claude", src.claude, "该日会话未 ingest"),
  ];
  note.textContent = srcNote.join(" · ") + "。空格 = 该小时没有已测用量（不是 0）。";
}

function shiftMonth(delta) {
  const [y, m] = calMonth.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + delta, 1));
  calMonth = t.getUTCFullYear() + "-" + String(t.getUTCMonth() + 1).padStart(2, "0");
  renderCalendar();
}

// ---------- 会话（列表 + 详情） ----------

// 同一时刻至多一个 page fetch。首页 fetch、用户「更多」、后台预取三者共用同一
// 条 `fetchSessionsPage` 追加路径；没有这层守卫，「更多」与预取并发读同一个
// nextCursor 会双双拉同一页 → 重复追加。
let sessFetching = false;
// reset/reload 时 ++，作废在途预取：加载中途被重置，旧预取的本页不得续写新状态。
let sessPrefetchGen = 0;
let sessPrefetchActive = false;

async function loadSessions(reset) {
  if (reset) {
    sessState = { items: [], nextCursor: null, total: null, loaded: true, error: false };
    sessPrefetchGen++; // 作废在途预取（下一段 await 回来时 gen 对不上，整页丢弃）
    document.getElementById("sess-banner").hidden = true;
  }
  sessState.loaded = true;

  // `sessions_list` spawn 二进制、首次（冷 cache）要几十秒才回——真机实测过
  // 631MB/115 个会话文件冷启动 30+ 秒（2026-09 起：store 构建并行 + app 启动
  // 后台预热 + IPC 走 spawn_blocking，等待被压到秒级且不再冻 UI，这条兜底保留）。
  // 这段等待期间之前完全没有任何视觉反馈（tab 面板就是空的），跟窗口真的假死
  // 在观感上没有区别，这是用户报告"点 tab 卡到假死"的直接原因之一，不只是 IPC
  // 本身慢。加一条"加载中…"，至少让等待是可见、可解释的等待，不是看起来卡死
  // 的等待。
  const loadingEl = document.getElementById("sess-loading");
  loadingEl.hidden = false;
  await fetchSessionsPage(sessPrefetchGen);
  loadingEl.hidden = true;
  // 首页渲染完立刻后台续拉剩余页（「分批出来」）：续页走 cache 命中快路径
  // （~0.1s/页），每页到就重渲染，用户首屏先见第 1 页、数据随后自动补完，不用
  // 手动点「更多」等后续。
  if (sessState.nextCursor) prefetchRemainingPages();
}

/// 拉一页并追加到 `sessState`。守卫 `sessFetching` 防双跑双追；`gen` 是预取代，
/// 中途 reset 后对不上 → 整页丢弃（不续写新状态）。
async function fetchSessionsPage(gen) {
  if (sessFetching) return false;
  sessFetching = true;
  try {
    const args = { pageSize: 50 };
    // 月份窗口（修「上个月会话看不到」）：picker 选了 YYYY-MM 时透传给 IPC，
    // store.rs list_args 优先 month（更粗、用户主动选择）走 --month 路径。
    // picker 为空 → 不传 month → IPC 用 day 兜底为今天（旧契约）。
    // day 字段目前没用（保留 IPC 入参面，未来若加 day picker 再启用）。
    const windowMode = document.getElementById("sess-window").value;
    const monthVal = document.getElementById("sess-month").value;
    if (windowMode === "today") {
      args.day = statisticsToday();
    } else if (windowMode === "7d") {
      args.date_from = shiftStatisticsDate(-6);
      args.date_to = statisticsToday();
    } else if (windowMode === "custom") {
      const from = document.getElementById("sess-from").value;
      const to = document.getElementById("sess-to").value;
      if (!from || !to) throw new Error("请选择完整的自定义日期范围");
      args.date_from = from;
      args.date_to = to;
    } else if (monthVal) {
      args.month = monthVal;
    }
    const modelVal = document.getElementById("sess-model").value.trim();
    if (modelVal) args.model = modelVal;
    const providerVal = document.getElementById("sess-provider").value.trim();
    if (providerVal) args.provider = providerVal;
    // harness 过滤（spec §7.3）：此命令的 Tauri 参数保持 Rust 的 snake_case 名称；
    // 传 camelCase 会被当作缺省 None，导致列表静默退回全执行环境。过滤变化时调用方
    // 负责重置分页。
    if (sessFilter !== "all") args.harness_kind = sessFilter;
    // cursor：v0.9.1 起是 mcp::sessions_search 的不透明串（`<total>:<key_len>:<key>`），
    // 直接透传，不需要 JSON.stringify（旧 r2a_store cursor 是 JSON 对象，
    // 那是 jsonl 重放路径里存的 filter_hash/store_revision，已退役）。
    if (sessState.nextCursor) args.cursor = sessState.nextCursor;
    const resp = await invoke("sessions_list", args);
    // envelope shape（v0.9.1）：`resp.data.sessions[]` + `resp.data.next_cursor` +
    // `resp.data.has_more` + `resp.data.window_total_tokens`。
    // 旧 r2a list DTO 把分页嵌在 `resp.page.{items,next_cursor,total}` —— 那个
    // wrapper 已退役，读错层会恒显「暂无会话」的假空（真机实证的缺陷）。
    const data = resp.data || {};
    if (gen != null && gen !== sessPrefetchGen) return false; // 中途被 reset → 丢本页
    sessState.items = sessState.items.concat(data.sessions || []);
    sessState.nextCursor = data.next_cursor || null;
    // 会话数与 token 总量是不同指标。此前错误地把 window_total_tokens 直接
    // 写进会话计数，导致 UI 显示「23 亿个会话」。
    sessState.total = data.window_session_count != null
      ? data.window_session_count
      : sessState.items.length;
    sessState.error = false;
    renderSessions();
    return true;
  } catch (e) {
    if (gen != null && gen !== sessPrefetchGen) return false;
    sessState.error = true;
    // 报错不摆「暂无会话」的假空——错误横幅就是错误横幅，跟空态二选一。
    showBanner("sess-banner", e, true);
    renderSessions();
    return false;
  } finally {
    sessFetching = false;
  }
}

/// 首页之后的静默续拉：一条直循环拉完剩余页（58 会话 → 第 2 页只有 8 条）。
/// `sessPrefetchActive` 防多个入口叠出第二条预取链。
async function prefetchRemainingPages() {
  if (sessPrefetchActive) return;
  sessPrefetchActive = true;
  const gen = ++sessPrefetchGen;
  try {
    while (sessState.nextCursor && sessPrefetchGen === gen) {
      if (!(await fetchSessionsPage(gen))) return;
    }
  } finally {
    sessPrefetchActive = false;
  }
}

/// 过滤 chips 的选中态（spec §7.3）：active 的 chip 即当前 sessFilter。深链
/// SessionList 与用户点击都写 sessFilter 后调这里，渲染只有一个入口。
function updateFilterChips() {
  document.querySelectorAll("#sess-filter .chip").forEach((c) => {
    c.classList.toggle("active", c.dataset.harness === sessFilter);
  });
}

function renderSessions() {
  const body = document.getElementById("sess-body");
  const count = document.getElementById("sess-count");
  const empty = document.getElementById("sess-empty");
  const more = document.getElementById("sess-more");
  body.innerHTML = "";

  // 月份上下文加到计数后缀，让用户清楚看到「这个数是哪个月」（避免把 2026-08
  // 的 50 条误读成「今天居然跑了 50 条」）。picker 为空 → 显示「今日」。
  const monthEl = document.getElementById("sess-month");
  const windowEl = document.getElementById("sess-window");
  const mode = windowEl ? windowEl.value : "month";
  const suffix = mode === "today" ? "今日"
    : mode === "7d" ? "最近 7 天"
    : mode === "custom"
      ? ((document.getElementById("sess-from").value || "?") + ".." +
         (document.getElementById("sess-to").value || "?"))
      : (monthEl && monthEl.value ? monthEl.value : "本月");
  const statusItems = sessStatusFilter === "all" ? sessState.items
    : sessState.items.filter((s) => s.cost_status && s.cost_status.state === sessStatusFilter);
  count.textContent = sessState.total != null
    ? suffix + " 共 " + (sessStatusFilter === "all"
      ? statusItems.length + " 个会话"
      : statusItems.length + " 个匹配会话（原始 " + sessState.total + "）") + " · 点任意行看报告"
    : "";
  empty.textContent = statusItems.length === 0 && sessState.items.length > 0 ? "没有符合该计费状态的会话" : "暂无会话";
  if (statusItems.length === 0) {
    // error 时隐藏空态：横幅已经说明了数据源问题，不要再摆「暂无会话」冒充真空。
    empty.hidden = sessState.error;
    more.hidden = true;
    return;
  }
  empty.hidden = true;
  for (const s of statusItems) {
    const tr = document.createElement("tr");
    const titleCell = document.createElement("td");
    titleCell.textContent = titleText(s);
    // 行尾 chevron：把「这行能点」写进视觉，不用悬停才发现（原来没有任何提示）。
    const chev = el("span", "row-chevron");
    chev.textContent = "›";
    titleCell.appendChild(chev);
    tr.appendChild(titleCell);
    // v0.9.1 envelope 字段映射（mcp::sessions_search）：
    //   harness_kind       → harness                       （旧 r2a DTO）
    //   model (str)     → model_ids[0] || "—"         （Vec<String>；多模型取首个
    //                                                显示，详情 envelope.data
    //                                                .model_ids[] 里有完整清单）
    //   date_span.first → first_event_at             （RFC3339 Beijing）
    //   date_span.last  → last_event_at              （同）
    //   tokens_total    → tokens.total               （4 buckets 求和已落 envelope）
    //   cost_usd (f64)  → cost_minor.amount_minor/100 （i64 minor / 100；新路径是
    //                                                usage_facts × pricing_snapshots
    //                                                JOIN 的 metered_estimate，
    //                                                §6.7 跨币相加自动 null——
    //                                                此时 cost 列诚实地「—」，
    //                                                不拿 ¥0.00 冒充没花钱）
    //   findings_total  → null                       （不在权威库 envelope 里；
    //                                                findings 跨会话汇总从 findings
    //                                                tab 看，单会话 finding 数等 M4
    //                                                workflow_events 工具落地后回填）
    tr.appendChild(td(s.harness || "—"));
    tr.appendChild(td((Array.isArray(s.model_ids) && s.model_ids.length) ? s.model_ids[0] : "—"));
    const span = (s.first_event_at && s.last_event_at)
      ? s.first_event_at.slice(0, 10) + (s.first_event_at !== s.last_event_at ? " … " + s.last_event_at.slice(0, 10) : "")
      : (s.first_event_at ? s.first_event_at.slice(0, 10) : null);
    tr.appendChild(td(span || "—"));
    const tokensTotal = (s.tokens && typeof s.tokens.total === "number") ? s.tokens.total : null;
    tr.appendChild(tdNum(fmtTokens(tokensTotal)));
    // cost_minor 形状: {amount_minor: i64, currency: "USD"|"CNY"} | null
    // 旧 fmtUSD 收 float|null —— 加小 helper 把 amount_minor 转显示串；
    // null → "—"，命中 → "$1.23" / "¥1.23"（按 currency 走；与 fmtUSD/fmtMoney 同款）。
    tr.appendChild(tdNum(fmtSessionCost(s)));
    tr.appendChild(tdNum("—"));
    tr.addEventListener("click", () => showSession(s));
    body.appendChild(tr);
  }
  more.hidden = !sessState.nextCursor;
}

function td(text) {
  const t = document.createElement("td");
  t.textContent = text;
  return t;
}

function tdNum(text) {
  const t = td(text);
  t.className = "num";
  return t;
}

function titleText(s) {
  if (s.title) return s.title;
  // 无标题（Codex 标题命中 87% 不是 100%）→ 用 session_ref 兜底，诚实不臆造标题。
  // 旧 r2a DTO 用 `s.session_key.native_id`（原始会话 id）；v0.9.1 起 list 行只剩
  // HMAC `session_ref`，把 native_session_id 屏蔽到 IPC 边界外（spec §0.3 PII）。
  // session_ref 是 `sr_<32hex>`，截后 8 位当显示够用，整串也短到不会撑坏列宽。
  if (s.session_ref) return s.session_ref.length > 12
    ? "…" + s.session_ref.slice(-8)
    : s.session_ref;
  return "（无标题）";
}

async function showSession(s) {
  document.getElementById("sess-list-view").hidden = true;
  document.getElementById("sess-detail-view").hidden = false;
  document.getElementById("sess-detail-banner").hidden = true;
  renderDetailSummary(s);
  try {
    // v0.9.1 IPC：session_ref 是 HMAC 不透明串（来自 list 行 data.sessions[].session_ref），
    // 不是 native session_key（spec §0.3 PII：原生 session_key 不再穿过 IPC）。
    const env = await invoke("sessions_read", { sessionRef: s.session_ref });
    renderDetailEnvelope(env);
  } catch (e) {
    // 详情错误不挂「重载」按钮——那个按钮重载的是列表，跟详情无关；用户自己
    // 返回列表即可重进。
    showBanner("sess-detail-banner", e, false);
  }
}

function renderDetailSummary(s) {
  const body = document.getElementById("sess-detail-body");
  body.innerHTML = "";
  const cards = el("div", "detail-cards");
  cards.appendChild(detailCard("标题", titleText(s)));
  // v0.9.1 list 行只有 harness + model_ids[]，单模型取首个，多模型在详情 envelope
  // .data.model_ids[] 里有完整清单。
  cards.appendChild(detailCard("模型",
    (Array.isArray(s.model_ids) && s.model_ids.length) ? s.model_ids.join(", ") : "—"));
  // date_span → first_event_at / last_event_at（RFC3339 Beijing）
  cards.appendChild(detailCard("执行环境 / 日期",
    (s.harness || "—") + " · " + (s.first_event_at ? s.first_event_at.slice(0, 10) : "—")));
  // cost 列：list 行只有 cost_minor（i64 minor / 100），格式化交给 fmtCostMinor。
  // 命中时按 currency 标 USD/CNY；null → "—"（不拿 ¥0.00 冒充没花钱）。
  // envelope 到手后 refreshDetailCards 用真实 session 数据把卡片补上（envelope
  // .data.tokens.total 完整；envelope .data.cost_minor 同样 currency-aware）。
  const costCard = detailCard("估算成本", fmtSessionCost(s), "sess-card-cost");
  costCard.querySelector(".label").id = "sess-card-cost-label";
  cards.appendChild(costCard);
  const tokensTotal = (s.tokens && typeof s.tokens.total === "number") ? s.tokens.total : null;
  cards.appendChild(detailCard("Tokens", fmtTokens(tokensTotal), "sess-card-tokens"));
  // 单会话 finding 数：v0.9.1 envelope 不携带（旧 r2a 预计算，SQL 权威库没有
  // workflow 事件维度）。list 行此列恒为 "—"，详情 envelope 同款。Findings tab
  // 跨会话汇总仍可用（仍走 r2a_store，PR #2.3a 任务 #19 待 M4 workflow_events
  // 工具落地后整段迁 mcp::dispatch）。
  cards.appendChild(detailCard("Findings", "—", "sess-card-findings"));
  body.appendChild(cards);

  const loading = el("div", "detail-section");
  loading.id = "sess-detail-loading";
  const lt = el("div", "detail-section-title");
  lt.textContent = "完整审计报告";
  loading.appendChild(lt);
  const p = el("div", "muted");
  p.textContent = "读取中…";
  loading.appendChild(p);
  body.appendChild(loading);
}

function detailCard(label, value, valueId) {
  const card = el("div", "detail-card");
  const l = el("div", "label");
  l.textContent = label;
  const v = el("div", "value");
  v.textContent = value;
  if (valueId) v.id = valueId;
  card.appendChild(l);
  card.appendChild(v);
  return card;
}

// KPI 卡的数字来自列表行摘要，冷字段本来就可能缺（上面 renderDetailSummary 的
// 注释）。envelope 到手后用真实 session 数据把卡片补上——避免"正下方的完整报告
// 已经有真实数字，卡片却写着三个破折号"这种自相矛盾（真机截图能看到这问题）。
//
// **v0.9.1 envelope 字段**：旧 r2a `session.cost_report` / `session.audit.findings`
// / `session.cost.total` / `session.requests[]` / `session.findings[]` 全部已退役
// ——那些字段来自 jsonl 重放，权威库 mcp::session_detail envelope 不含它们。
// 新 envelope 只给：
//   data.tokens.total        (4 buckets 求和已落 envelope)
//   data.cost_minor          (i64 minor / 100; currency-aware)
//   data.event_count / data.model_ids
// Findings 单会话数等 M4 `workflow_events` 工具落地后回填（任务 #19）。
function refreshDetailCards(session) {
  const costEl = document.getElementById("sess-card-cost");
  const tokensEl = document.getElementById("sess-card-tokens");
  const findingsEl = document.getElementById("sess-card-findings");
  if (!costEl || !tokensEl || !findingsEl) return;

  // tokens：envelope 已落 4 buckets 求和
  if (session.tokens && typeof session.tokens.total === "number") {
    tokensEl.textContent = fmtTokens(session.tokens.total);
  }
  // cost：cost_minor.currency 决定显示成 USD 还是 CNY（不只是数值单位）
  if (session.cost_minor != null) {
    const label = document.getElementById("sess-card-cost-label");
    if (label) {
      label.textContent = session.cost_minor.currency === "USD" ? "估算成本(USD)" : "估算成本(CNY)";
    }
    costEl.textContent = fmtCostMinor(session.cost_minor);
  } else {
    const label = document.getElementById("sess-card-cost-label");
    if (label) label.textContent = "成本状态";
    costEl.textContent = fmtCostStatus(session.cost_status);
  }
  // findings：单会话 finding 数不在权威库 envelope 里——M4 之前保持 "—"
  // （renderDetailSummary 已把卡片初始写成 "—"）
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// ---------- 单会话报告分区渲染 ----------
//
// 之前这里把整份 envelope `JSON.stringify` 成一个 <pre>——一个 DSH 会话实测
// 286KB，用户点进去看到的是一堵文本墙，等于没有报告。现在按执行环境拆分成分区：
// 两份执行环境的 session payload 形状几乎不相交（DSH：cost/context/waste/compaction/
// duration/subagents/rule_outcomes/*_coverage；Codex：audit/cost_report/coverage/
// quota_trajectory/permission_transitions/turn_ends/effort/notes/…），所以
// renderCodexSections / renderDshSections 各自认自己的键，认不到就整段不渲染，
// 不拿空壳冒充「无数据」。raw JSON 降级成 <details> 默认折叠，留在最底供排查。

function detailSection(title) {
  const sec = el("div", "detail-section");
  const t = el("div", "detail-section-title");
  t.textContent = title;
  sec.appendChild(t);
  return sec;
}

// 一行「标签 + 比例条 + 值」：成本/上下文构成/工具耗时这类要看占比而不只是读数字
// 的维度用它，不用为每个维度单造一种结构。frac 是调用方算好的 0..1 比例；frac 为
// null 时不画条，只退化成右对齐的值——分母不明时不编一条假比例（同 kvRow 挨着
// null-vs-0 的纪律）。
function barRow(label, value, frac, title) {
  const row = el("div", "bar-row");
  const l = el("span", "bar-label");
  l.textContent = label;
  if (title) l.title = title;
  row.appendChild(l);
  const track = el("span", "bar-track");
  if (frac != null) {
    const fill = el("span", "bar-fill");
    fill.style.width = Math.max(0, Math.min(1, frac)) * 100 + "%";
    track.appendChild(fill);
  }
  row.appendChild(track);
  const v = el("span", "bar-value");
  v.textContent = value;
  row.appendChild(v);
  return row;
}

// ---------- 交互式会话时间线（DSH） ----------
//
// dsh-client TimelinePanel 的全功能对齐（用户反馈「折线图功能不完整」）。数据准备
// 镜像 dsh-client timeline.ts 的 DSH 适配（valueOf/modelSwitchEvents/事件定位），
// 渲染壳镜像 TimelinePanel.tsx 的交互集。几何（比例尺/缺口/聚合/事件定位合并）一律
// 来自共享 timeline.js 的 buildGeometry——这里**不做**任何比例尺/计价数学：token 求和
// 公式在 core request_metrics 钉死，逐请求费用由信封 cost_series（Part A）透出，
// 浏览器只读不重算。定位/取值逻辑是展示层第二份（dsh-client 一份、这里一份），属
// 既有「每前端一份 data-prep」格局，不构成 CLAUDE.md 的「第四份拷贝」（计算无第二份）。

// h 多给 8px（190→198）：eventY 标记底缘（±5 → 177）与 turn 刻度文字顶缘原本只
// 隔 ~2px，事件聚堆时圆点和 T65/T80 标签视觉上顶在一起（真实截图可见）。.tl-chart
// 是 height:auto，viewBox 变高就是真实的额外间隔。
const TL_GEO = { w: 1000, h: 198, curveTop: 10, curveBottom: 150, eventY: 172, x0: 6, x1: 994 };
// 「慢」事件阈值：工具调用 ≥60s 才算慢（D9 语义的固定阈值；dsh-client 那边由用户在
// DurationSection 设阈值，工作台固定一个，不额外给设置项）。
const TL_SLOW_MS = 60 * 1000;
const TL_SVGNS = "http://www.w3.org/2000/svg";
const TL_KIND_LABELS = { risk: "风险", waste: "浪费", compaction: "压缩", model: "切换", subagent: "子代理", skill: "skill", slow: "慢" };
const TL_KIND_ORDER = ["risk", "waste", "compaction", "model", "subagent", "skill", "slow"];

// 每行在当前纵轴下的值。null = 这一行没测到（不是 0）——镜像 dsh-client valueOf。
//  - context：provider 实测的该次请求上下文占用（原始值，缺值断开）。
//  - tokens：该次请求消耗的 token 总量（delta，几何层再累加成累计曲线）。
//  - cost：已经是累计值（信封 cost_series 算好），几何层 'carry' 直接透传。
function tlValueOf(mode, r, cum) {
  if (mode === "context") return r.context_tokens != null ? Number(r.context_tokens) : null;
  if (mode === "cost") return cum != null ? cum : null;
  const parts = [r.uncached_input_tokens, r.output_tokens, r.cache_read_tokens];
  if (parts.every((v) => v == null)) return null;
  return parts.reduce((s, v) => s + (v || 0), 0);
}

// 模型切换点：相邻两行 model 不同即为一次切换（镜像 dsh-client modelSwitchEvents）。
function tlModelSwitchEvents(reqs) {
  const out = [];
  for (let i = 1; i < reqs.length; i++) {
    if (reqs[i].model && reqs[i].model !== reqs[i - 1].model) {
      out.push({ kind: "model", seq: reqs[i].seq, turn: reqs[i].turn, label: reqs[i].model });
    }
  }
  return out;
}

// 把事件定位到横轴上某个 request 的 seq（points 的 ordinal 就是 r.seq）：
//   1. seq 精确命中某请求 → 该请求的 seq；
//   2. seq 落在两个请求之间 → 「进行中的请求」（最后一个 seq ≤ ev.seq），语义同
//      dsh-client 的 indexForSeq——事件发生在那次请求进行当中，标在该请求上不算猜；
//   3. 无 seq → 该 turn 的第一个请求（indexForTurn）。
// 全落空 → null，调用方诚实跳过（定位不到不画在猜的位置上）。
function tlOrdinalFor(seq, turn, reqs) {
  if (seq != null) {
    for (let i = reqs.length - 1; i >= 0; i--) {
      const s = reqs[i].seq;
      if (s != null && s <= seq) return s;
    }
  }
  if (turn != null) {
    for (const r of reqs) if (r.turn === turn && r.seq != null) return r.seq;
  }
  return null;
}

// 第 idx 行在它所属 turn 里是第几次请求 / 该 turn 共几次（镜像 dsh-client
// requestOrdinal，信息面板的「turn · request n/m · req{seq}」）。turn 空 → null。
function tlRequestOrdinal(reqs, idx) {
  const turn = reqs[idx] && reqs[idx].turn;
  if (turn == null) return null;
  let n = 0, m = 0;
  for (let i = 0; i < reqs.length; i++) {
    if (reqs[i].turn !== turn) continue;
    m++;
    if (i <= idx) n++;
  }
  return { n, m };
}

// DSH 单会话时间线的数据准备：points（三档纵轴的 values 一次算好）+ 事件（7 种）。
// 返回 null = 没有可画数据（调用方不渲染这一节）。全部输入来自 core 发射器：
// request_metrics（tokens/context）、cost_series（逐请求累计费用）、findings/waste/
// compaction/subagents/skill/duration（事件源）。
function dshTimelineData(session) {
  const reqs = Array.isArray(session.requests) ? session.requests : null;
  if (!reqs || reqs.length === 0) return null;

  // cost_series（Part A 信封键）：{series:[{request_seq,cumulative}], priced, total}，
  // 与 requests 同序（request_seq 即 1..n 行号）；每个请求都有累计条目——未计价
  // （is_peak null / 未知模型）那笔保持上一笔的累计值，几何层 'carry' 沿用不再加。
  const costSeries = session.cost_series && Array.isArray(session.cost_series.series)
    ? session.cost_series.series : [];
  const cumByReqSeq = new Map();
  for (const s of costSeries) if (s && s.request_seq != null) cumByReqSeq.set(s.request_seq, s.cumulative);
  const hasCost = costSeries.length > 0;

  const points = reqs.map((r, i) => ({
    ordinal: r.seq != null ? r.seq : i,
    task_id: r.turn != null ? r.turn : null,
    values: {
      context: tlValueOf("context", r, null),
      tokens: tlValueOf("tokens", r, null),
      cost: tlValueOf("cost", r, cumByReqSeq.get(i + 1) ?? null),
    },
  }));

  const hasContext = reqs.some((r) => r.context_tokens != null);
  const hasTokens = reqs.some((r) =>
    r.uncached_input_tokens != null || r.output_tokens != null || r.cache_read_tokens != null);

  // 事件定位（7 种）。targetId 指向 findingsSection 里对应 finding 行的 DOM id，
  // 点击/回车可跳转——与 dsh-client 的 onFocus 同义；没有对应行的种 targetId 为
  // null，点击是空操作（仍可 hover/焦点读取）。
  const events = [];
  const pushEv = (kind, seq, turn, label, severity, targetId, skillMode) => {
    const ord = tlOrdinalFor(seq, turn, reqs);
    if (ord == null) return;
    events.push({ kind, ordinal: ord, turn: turn != null ? turn : null, label, severity, targetId, skillMode });
  };

  (Array.isArray(session.findings) ? session.findings : [])
    .forEach((f, i) => pushEv("risk", f.seq, f.turn,
      (f.rule || "?") + " " + (f.evidence || ""), f.severity || "info", "tl-finding-" + i, null));

  (Array.isArray(session.waste) ? session.waste : [])
    .forEach((w) => pushEv("waste", w.seq, w.turn,
      (w.rule || "?") + " " + fmtTokens(w.waste_tokens) + " token", w.severity || "info", null, null));

  if (session.compaction) {
    (Array.isArray(session.compaction.compactions) ? session.compaction.compactions : [])
      .forEach((c) => pushEv("compaction", c.start_seq, c.turn, "压缩", null, null, null));
    (Array.isArray(session.compaction.prunes) ? session.compaction.prunes : [])
      .forEach((p) => pushEv("compaction", p.seq, p.turn,
        "剪枝 " + fmtTokens(p.shadowed_token_count) + " token", null, null, null));
  }

  (Array.isArray(session.subagents) ? session.subagents : [])
    .forEach((a) => pushEv("subagent", a.seq, a.turn,
      "子代理 " + (a.description || a.agent_id || "—"), null, null, null));

  (Array.isArray(session.skill) ? session.skill : []).forEach((sk) => {
    // skill 行带 request_seq（core 回填的 1..n 行号）→ 直接精确到那个请求，最可靠；
    // 旧会话没有该字段才退回 seq/turn 定位。
    let ord = null;
    if (sk.request_seq != null) {
      const r = reqs[sk.request_seq - 1];
      if (r && r.seq != null) ord = r.seq;
    }
    if (ord == null) ord = tlOrdinalFor(sk.seq, sk.turn, reqs);
    if (ord == null) return;
    events.push({
      kind: "skill", ordinal: ord, turn: sk.turn != null ? sk.turn : null,
      label: "skill " + (sk.name || "?"), targetId: null,
      skillMode: sk.trigger_mode === "explicit" ? "explicit" : "model_selected",
    });
  });

  // slow ← duration.tool_calls 里 ≥TL_SLOW_MS 的慢调用（十字形状，D9 语义）。
  const calls = session.duration && Array.isArray(session.duration.tool_calls)
    ? session.duration.tool_calls : [];
  for (const c of calls) {
    if (c.duration_ms == null || c.duration_ms < TL_SLOW_MS) continue;
    pushEv("slow", c.seq, c.turn,
      (c.tool_name || "?") + " " + (c.duration_ms / 1000).toFixed(1) + "s", null, null, null);
  }

  for (const m of tlModelSwitchEvents(reqs)) pushEv("model", m.seq, m.turn, m.label, null, null, null);

  const modes = [];
  if (hasTokens) modes.push({ id: "tokens", label: "Token", cumulative: true });
  if (hasContext) modes.push({ id: "context", label: "上下文", cumulative: false });
  if (hasCost) modes.push({ id: "cost", label: "费用", cumulative: "carry" });
  // 三档全空（requests 在但哪档都没测到）→ 没有可画的纵轴，整节不渲染，不拿
  // 空壳冒充「无数据」。
  if (modes.length === 0) return null;

  return {
    points, events, reqs, modes,
    costMeta: hasCost && session.cost_series
      ? { priced: session.cost_series.priced != null ? session.cost_series.priced : 0,
          total: session.cost_series.total != null ? session.cost_series.total : reqs.length }
      : null,
  };
}

// —— SVG 构造小助手（事件形状/轴标签） ——

function tlSvgEl(tag) { return document.createElementNS(TL_SVGNS, tag); }

function tlSvgText(svg, cls, x, y, text) {
  const t = tlSvgEl("text");
  t.setAttribute("class", cls);
  t.setAttribute("x", x);
  t.setAttribute("y", y);
  t.textContent = text;
  svg.appendChild(t);
  return t;
}

// 7 种事件形状（镜像 TimelinePanel 的 EVENT_STYLE）：
//   compaction 方块（7×7 圆角） / model 薄 tick（1.5×10） / subagent 三角 /
//   skill 菱形（explicit）或圆（model_selected） / slow 十字 / 其余圆点。
// 颜色靠 CSS 类（.tl-ev-<kind>[.tl-sev-<severity>] 设 color，形状 fill/stroke
// 用 currentColor）——图例开关的颜色与图表标记同源。
function tlAppendShape(m, ev, g) {
  const x = ev.x, y = g.eventY;
  if (ev.kind === "compaction") {
    const r = tlSvgEl("rect");
    r.setAttribute("x", x - 3.5); r.setAttribute("y", y - 3.5);
    r.setAttribute("width", 7); r.setAttribute("height", 7);
    r.setAttribute("rx", 1);
    m.appendChild(r);
  } else if (ev.kind === "model") {
    const r = tlSvgEl("rect");
    r.setAttribute("x", x - 0.75); r.setAttribute("y", y - 5);
    r.setAttribute("width", 1.5); r.setAttribute("height", 10);
    m.appendChild(r);
  } else if (ev.kind === "subagent") {
    const p = tlSvgEl("path");
    p.setAttribute("d", "M" + x + " " + (y - 5) + "l4.5 8h-9z");
    m.appendChild(p);
  } else if (ev.kind === "skill") {
    if (ev.skillMode === "explicit") {
      const p = tlSvgEl("path");
      p.setAttribute("d", "M" + x + " " + (y - 5) + "l4.5 5l-4.5 5l-4.5-5z");
      m.appendChild(p);
    } else {
      const c = tlSvgEl("circle");
      c.setAttribute("cx", x); c.setAttribute("cy", y);
      c.setAttribute("r", ev.count > 1 ? 5 : 4);
      m.appendChild(c);
    }
  } else if (ev.kind === "slow") {
    for (const [dx, dy, w, h] of [[-4, -1, 8, 2], [-1, -4, 2, 8]]) {
      const r = tlSvgEl("rect");
      r.setAttribute("x", x + dx); r.setAttribute("y", y + dy);
      r.setAttribute("width", w); r.setAttribute("height", h);
      m.appendChild(r);
    }
  } else {
    const c = tlSvgEl("circle");
    c.setAttribute("cx", x); c.setAttribute("cy", y);
    c.setAttribute("r", ev.count > 1 ? 5 : 4);
    m.appendChild(c);
  }
  for (const child of m.children) child.setAttribute("class", "tl-ev-shape");
}

// 交互渲染壳（镜像 TimelinePanel.tsx）：模式切换 / 图例开关 / 悬停+钉住游标 /
// 键盘漫游 / 常驻信息面板（role=status）/ 脚注 / 小屏折叠摘要。状态闭包内：
// 改 mode/hidden → 重算几何重画 SVG；游标/activeEvent → 只更新游标层与信息面板。
function renderInteractiveTimeline(data) {
  const { points, events, reqs, modes, costMeta } = data;
  const state = {
    mode: modes.length ? modes[0].id : "tokens",
    hidden: {}, hover: null, pinned: null, activeEv: null, roving: 0, expanded: false,
  };
  const modeMeta = {};
  for (const m of modes) modeMeta[m.id] = m;

  // —— 结构 ——
  const shell = el("div", "tl-shell");

  const summary = el("div", "tl-summary");
  const summaryLine = el("span", "tl-summary-line");
  const expandBtn = el("button", "tl-expand");
  expandBtn.type = "button";
  expandBtn.setAttribute("aria-expanded", "false");
  const evList = el("div", "tl-summary-list");
  const targetable = events.filter((e) => e.targetId !== null);
  if (targetable.length) {
    const hd = el("div", "tl-summary-list-head");
    hd.textContent = "事件列表（点击跳转 findings）";
    evList.appendChild(hd);
    for (const e of targetable) {
      const btn = el("button", "tl-summary-list-item");
      btn.type = "button";
      btn.textContent = e.label + (e.count > 1 ? " ×" + e.count : "") + (e.turn != null ? " · T" + e.turn : "");
      btn.addEventListener("click", () => focusFinding(e.targetId));
      evList.appendChild(btn);
    }
  }
  summary.appendChild(summaryLine);
  summary.appendChild(expandBtn);
  summary.appendChild(evList);
  shell.appendChild(summary);

  const head = el("div", "tl-head");
  const sub = el("div", "tl-sub");
  sub.textContent = "纵轴切换 · 事件标记在任意纵轴下保持同一位置";
  head.appendChild(sub);
  const modesEl = el("div", "tl-modes");
  modesEl.setAttribute("role", "group");
  for (const m of modes) {
    const b = el("button", "tl-mode-btn");
    b.type = "button";
    b.textContent = m.label;
    b.setAttribute("aria-pressed", state.mode === m.id ? "true" : "false");
    b.addEventListener("click", () => {
      if (state.mode === m.id) return;
      state.mode = m.id;
      for (const bb of modesEl.querySelectorAll(".tl-mode-btn")) {
        bb.setAttribute("aria-pressed", bb === b ? "true" : "false");
      }
      renderChart();
    });
    modesEl.appendChild(b);
  }
  head.appendChild(modesEl);
  shell.appendChild(head);

  const legend = el("div", "tl-legend");
  const curveItem = el("span", "tl-legend-item");
  curveItem.appendChild(el("i", "tl-legend-swatch tl-legend-curve"));
  curveItem.appendChild(document.createTextNode("曲线"));
  legend.appendChild(curveItem);
  const legendBtns = {};
  for (const k of TL_KIND_ORDER) {
    if (!events.some((e) => e.kind === k)) continue;
    const btn = el("button", "tl-legend-btn");
    btn.type = "button";
    btn.dataset.kind = k;
    btn.appendChild(el("i", "tl-legend-swatch tl-ev-" + k));
    btn.appendChild(document.createTextNode(TL_KIND_LABELS[k]));
    btn.setAttribute("aria-pressed", "true");
    legend.appendChild(btn);
    legendBtns[k] = btn;
  }
  shell.appendChild(legend);

  const chartWrap = el("div", "tl-chartwrap");
  shell.appendChild(chartWrap);

  const info = el("div", "tl-info");
  info.setAttribute("role", "status");
  shell.appendChild(info);

  const foot = el("div", "tl-foot");
  shell.appendChild(foot);

  // —— 几何与渲染状态 ——
  let tl = null;
  let cursorG = null, cursorLine = null, cursorDot = null;
  let markers = [];

  function visibleEvents() { return events.filter((e) => !state.hidden[e.kind]); }

  function build(mode) {
    const meta = modeMeta[mode] || { label: mode, cumulative: false };
    const spec = {
      points,
      events: visibleEvents(),
      series: [{ name: mode, label: meta.label, cumulative: meta.cumulative }],
      geometry: TL_GEO,
    };
    // context 模式：context_window 作为显式纵轴上限（曲线画「占了多少窗口」不是
    // 数据峰值，同 TimelinePanel）；全缺不传，几何退回数据最大值并置 yMaxIsData，
    // 脚注如实说「无窗口上限」。
    if (mode === "context") {
      const maxWin = reqs.reduce((a, r) => Math.max(a, r.context_window || 0), 0);
      if (maxWin > 0) spec.yMax = maxWin;
    }
    return window.TimelineGeometry.buildGeometry(spec, { maxBuckets: 220 });
  }

  function cursorAt() {
    const i = state.pinned != null ? state.pinned : state.hover;
    if (i == null || !tl || i < 0 || i >= tl.points.length) return null;
    return tl.points[i];
  }

  function refreshCursorInfo() {
    const cur = cursorAt();
    if (cursorG) {
      if (cur) {
        cursorG.style.display = "";
        const g = tl.geometry;
        cursorLine.setAttribute("x1", cur.x); cursorLine.setAttribute("x2", cur.x);
        cursorLine.setAttribute("y1", g.curveTop); cursorLine.setAttribute("y2", g.eventY + 8);
        if (state.pinned !== null) cursorLine.removeAttribute("stroke-dasharray");
        else cursorLine.setAttribute("stroke-dasharray", "3 3");
        cursorDot.setAttribute("cx", cur.x); cursorDot.setAttribute("cy", cur.y);
        cursorDot.setAttribute("r", state.pinned !== null ? "4.5" : "3.5");
      } else {
        cursorG.style.display = "none";
      }
    }
    updateInfo();
    updateFoot();
    updateSummary();
  }

  function updateInfo() {
    const parts = [];
    if (state.activeEv != null && tl && state.activeEv < tl.events.length) {
      // 事件优先（游标信息退后）——同 TimelinePanel 的优先级。图例隐藏的种不再
      // 出现在 tl.events 里，activeEv 在 renderChart 里已重置。
      const ev = tl.events[state.activeEv];
      parts.push(ev.label + (ev.count > 1 ? " ×" + ev.count : ""));
      if (ev.severity) parts.push(ev.severity);
      const pIdx = window.TimelineGeometry.nearestPoint(tl.points, ev.x);
      const rowIdx = pIdx >= 0 ? tl.points[pIdx].idx : null;
      const ord = rowIdx != null ? tlRequestOrdinal(reqs, rowIdx) : null;
      if (ord && ev.turn != null) {
        parts.push("T" + ev.turn + " · request " + ord.n + "/" + ord.m +
          (reqs[rowIdx] && reqs[rowIdx].seq != null ? " · req" + reqs[rowIdx].seq : ""));
      } else if (ev.turn != null) {
        parts.push("T" + ev.turn);
      }
      if (ev.targetId !== null) parts.push("回车跳转 findings");
    } else {
      const cur = cursorAt();
      const rowIdx = cur ? cur.idx : null;
      if (rowIdx != null && reqs[rowIdx]) {
        const r = reqs[rowIdx];
        const ord = tlRequestOrdinal(reqs, rowIdx);
        if (ord && r.turn != null) {
          parts.push("T" + r.turn + " · request " + ord.n + "/" + ord.m +
            (r.seq != null ? " · req" + r.seq : ""));
        } else {
          parts.push("req" + r.request_seq + (r.seq != null ? " · seq" + r.seq : ""));
        }
        const v = tl && tl.cols[0] ? tl.cols[0].values[cur.idx] : null;
        if (v != null) {
          if (state.mode === "cost") parts.push(fmtMoney(v));
          else {
            parts.push(fmtTokens(v) +
              (state.mode === "context" && r.context_window ? " / " + fmtTokens(r.context_window) : ""));
          }
        }
        if (r.model) parts.push(String(r.model).split("/").pop());
        const k = cur.hi - cur.lo;
        if (k > 1) parts.push(k + " 个请求合并");
        const here = tl.events.filter((e) => Math.abs(e.x - cur.x) < 3);
        if (here.length > 0) {
          parts.push("事件 " + here.map((e) => e.label + (e.count > 1 ? " ×" + e.count : "")).join("、"));
        }
        if (state.pinned !== null) parts.push("已固定");
      }
    }
    info.classList.toggle("tl-info-pinned", state.pinned !== null);
    info.textContent = parts.length > 0
      ? parts.join(" · ")
      : "悬停 / 点击 / ←→ 查看请求；Tab 漫游事件标记";
  }

  function updateFoot() {
    foot.innerHTML = "";
    if (!tl) return;
    const parts = [];
    parts.push(tl.buckets < tl.total
      ? tl.total + " 个请求聚合为 " + tl.buckets + " 桶"
      : tl.total + " 个请求");
    if (tl.measured < tl.total) parts.push((tl.total - tl.measured) + " 行未测到");
    if (tl.gaps > 0) parts.push("曲线 " + tl.gaps + " 处断开");
    if (state.mode === "context" && tl.yMaxIsData) parts.push("无上下文窗口上限，按数据峰值缩放");
    if (state.mode === "cost" && costMeta && costMeta.priced < costMeta.total) {
      parts.push((costMeta.total - costMeta.priced) + " 笔未计价（缺时间戳），累计为下限");
    }
    for (const p of parts) {
      const s = el("span", "tl-foot-item");
      s.textContent = p;
      foot.appendChild(s);
    }
  }

  function updateSummary() {
    if (!tl) { summaryLine.textContent = ""; expandBtn.textContent = "展开时间线"; return; }
    const peak = state.mode === "cost" ? fmtMoney(tl.yMax) : fmtTokens(tl.yMax);
    const anomalies = events.filter((e) => e.kind === "risk").length;
    summaryLine.textContent = tl.total + " 个请求 · 峰值 " + peak + " · " + anomalies + " 条风险";
    expandBtn.textContent = state.expanded ? "收起时间线" : "展开时间线";
    expandBtn.setAttribute("aria-expanded", state.expanded ? "true" : "false");
    shell.classList.toggle("tl-expanded", state.expanded);
  }

  function focusFinding(id) {
    const target = document.getElementById(id);
    if (!target) return;
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    target.classList.add("tl-finding-flash");
    setTimeout(() => target.classList.remove("tl-finding-flash"), 1800);
  }

  function onPointer(evt) {
    if (state.pinned !== null || !tl) return;
    const g = tl.geometry;
    const box = evt.currentTarget.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const vx = ((evt.clientX - box.left) / box.width) * g.w;
    const i = window.TimelineGeometry.nearestPoint(tl.points, vx);
    if (i >= 0) { state.hover = i; refreshCursorInfo(); }
  }

  function moveCursor(delta) {
    if (!tl) return;
    const last = tl.points.length - 1;
    const base = state.pinned != null ? state.pinned : (state.hover != null ? state.hover : 0);
    const next = Math.max(0, Math.min(last, base + delta));
    state.pinned = next;
    state.hover = next;
    refreshCursorInfo();
  }

  function moveEventFocus(next) {
    if (!tl || tl.events.length === 0) return;
    const clamped = Math.max(0, Math.min(tl.events.length - 1, next));
    state.roving = clamped;
    for (let i = 0; i < markers.length; i++) {
      markers[i].setAttribute("tabindex", i === clamped ? "0" : "-1");
    }
    const ev = tl.events[clamped];
    const pIdx = window.TimelineGeometry.nearestPoint(tl.points, ev.x);
    if (pIdx >= 0) { state.pinned = pIdx; state.hover = pIdx; }
    setActiveEv(clamped);
    if (markers[clamped] && typeof markers[clamped].focus === "function") markers[clamped].focus();
    if (ev.targetId !== null) focusFinding(ev.targetId);
  }

  function setActiveEv(i) {
    state.activeEv = i;
    refreshCursorInfo();
  }

  function renderChart() {
    tl = build(state.mode);
    markers = [];
    chartWrap.innerHTML = "";
    if (tl === null) {
      const na = el("div", "tl-empty");
      na.textContent = "该纵轴没有可画的数据";
      chartWrap.appendChild(na);
      cursorG = cursorLine = cursorDot = null;
      state.activeEv = null;
      refreshCursorInfo();
      return;
    }
    const g = tl.geometry;
    const yFor = (v) => g.curveBottom - (v / tl.yMax) * (g.curveBottom - g.curveTop);

    const svg = tlSvgEl("svg");
    svg.setAttribute("class", "tl-chart");
    svg.setAttribute("viewBox", "0 0 " + g.w + " " + g.h);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("tabindex", "0");
    svg.setAttribute("aria-label", "会话时间线（" + (modeMeta[state.mode] ? modeMeta[state.mode].label : state.mode) + " 纵轴）");

    // 网格线画在量程的 0/50%/100%，不是字面值 0/0.5/1——后者在 tokens/cost 模式
    // （yMax 上亿）下 (1/yMax)≈0，三条线全塌到底部基线上，顶标 yMax 也跟着被放
    // 到 yFor(1)≈基线旁：真实截图里「138.7M」挤在底部「0」边上就是这个。context
    // 模式（值本身是 0..1 比例、yMax≈1）碰巧两套算出同一位置，所以 bug 只在后
    // 两种模式暴露。
    for (const frac of [0, 0.5, 1]) {
      const y = yFor(frac * tl.yMax);
      const line = tlSvgEl("line");
      line.setAttribute("class", "tl-grid");
      line.setAttribute("x1", g.x0); line.setAttribute("x2", g.x1);
      line.setAttribute("y1", y); line.setAttribute("y2", y);
      svg.appendChild(line);
    }
    // 顶标放顶网格线正下方（同 dsh-native-v2 原型「128K」对顶格线的摆法）；曲线
    // 左端起点低，左上角内侧不会被线压住。
    tlSvgText(svg, "tl-axis", g.x0, g.curveTop + 9,
      state.mode === "cost" ? fmtMoney(tl.yMax) : fmtTokens(tl.yMax));
    tlSvgText(svg, "tl-axis", g.x0, g.curveBottom + 11, "0");

    if (tl.area) {
      const area = tlSvgEl("path");
      area.setAttribute("class", "tl-area");
      area.setAttribute("d", tl.area);
      svg.appendChild(area);
    }
    const path = tlSvgEl("path");
    path.setAttribute("class", "tl-line");
    path.setAttribute("d", tl.path);
    svg.appendChild(path);

    const cg = tlSvgEl("g");
    cg.setAttribute("class", "tl-cursor");
    cg.setAttribute("aria-hidden", "true");
    cursorG = cg;
    cursorLine = tlSvgEl("line");
    cursorDot = tlSvgEl("circle");
    cg.appendChild(cursorLine);
    cg.appendChild(cursorDot);
    svg.appendChild(cg);

    state.roving = Math.min(state.roving, tl.events.length - 1);
    state.activeEv = null;
    for (let i = 0; i < tl.events.length; i++) {
      const ev = tl.events[i];
      const m = tlSvgEl("g");
      const sevCls = ev.severity && ev.kind === "risk" ? " tl-sev-" + ev.severity : "";
      m.setAttribute("class", "tl-ev tl-ev-" + ev.kind + sevCls);
      m.setAttribute("data-kind", ev.kind);
      m.setAttribute("tabindex", i === state.roving ? "0" : "-1");
      m.setAttribute("aria-label",
        ev.label + (ev.count > 1 ? " ×" + ev.count : "") + (ev.turn != null ? " · T" + ev.turn : ""));
      const clickable = ev.targetId !== null;
      if (clickable) m.setAttribute("role", "button");
      const title = tlSvgEl("title");
      title.textContent = m.getAttribute("aria-label");
      m.appendChild(title);
      tlAppendShape(m, ev, g);
      m.addEventListener("focus", () => setActiveEv(i));
      m.addEventListener("mouseenter", () => setActiveEv(i));
      m.addEventListener("mouseleave", () => { if (state.activeEv === i) setActiveEv(null); });
      m.addEventListener("blur", () => { if (state.activeEv === i) setActiveEv(null); });
      m.addEventListener("click", (evt) => {
        evt.stopPropagation();
        setActiveEv(i);
        if (clickable) focusFinding(ev.targetId);
      });
      m.addEventListener("keydown", (evt) => {
        if (evt.key === "ArrowRight") { evt.preventDefault(); evt.stopPropagation(); moveEventFocus(i + 1); }
        else if (evt.key === "ArrowLeft") { evt.preventDefault(); evt.stopPropagation(); moveEventFocus(i - 1); }
        else if (evt.key === "Home") { evt.preventDefault(); evt.stopPropagation(); moveEventFocus(0); }
        else if (evt.key === "End") { evt.preventDefault(); evt.stopPropagation(); moveEventFocus(tl.events.length - 1); }
        else if ((evt.key === "Enter" || evt.key === " ") && clickable) {
          evt.preventDefault(); evt.stopPropagation(); setActiveEv(i); focusFinding(ev.targetId);
        } else if (evt.key === "Escape") {
          evt.stopPropagation(); state.pinned = null; state.hover = null; setActiveEv(null);
        }
      });
      markers.push(m);
      svg.appendChild(m);
    }

    for (const tk of tl.turnTicks) tlSvgText(svg, "tl-axis", tk.x, g.h - 1, tk.label);

    svg.addEventListener("mousemove", onPointer);
    svg.addEventListener("mouseleave", () => {
      if (state.pinned == null) { state.hover = null; refreshCursorInfo(); }
    });
    svg.addEventListener("click", (evt) => {
      const box = svg.getBoundingClientRect();
      if (!box || box.width === 0) return;
      const i = window.TimelineGeometry.nearestPoint(tl.points, ((evt.clientX - box.left) / box.width) * g.w);
      if (i >= 0) {
        state.pinned = state.pinned === i ? null : i;
        state.hover = i;
        refreshCursorInfo();
      }
    });
    svg.addEventListener("keydown", (evt) => {
      if (evt.key === "ArrowRight") { evt.preventDefault(); moveCursor(1); }
      else if (evt.key === "ArrowLeft") { evt.preventDefault(); moveCursor(-1); }
      else if (evt.key === "Home") { evt.preventDefault(); state.pinned = 0; state.hover = 0; refreshCursorInfo(); }
      else if (evt.key === "End") { evt.preventDefault(); const l = tl.points.length - 1; state.pinned = l; state.hover = l; refreshCursorInfo(); }
      else if (evt.key === "Escape") { state.pinned = null; state.hover = null; refreshCursorInfo(); }
    });

    chartWrap.appendChild(svg);
    // 测试钩子：jsdom 验证读它（不进任何决策路径）。
    if (window.__wbTimeline) window.__wbTimeline.lastGeo = tl;
    refreshCursorInfo();
  }

  expandBtn.addEventListener("click", () => {
    state.expanded = !state.expanded;
    updateSummary();
  });

  // 测试钩子：jsdom 验证读它（不进任何决策路径）。
  if (!window.__wbTimeline) window.__wbTimeline = {};
  window.__wbTimeline.data = data;

  renderChart();
  return shell;
}

// DSH 分支入口：数据准备 + 渲染壳。timeline.js 没加载 → 不渲染这一节，不是报错。
function dshTimelineSection(session) {
  if (!window.TimelineGeometry || !window.TimelineGeometry.buildGeometry) return null;
  const data = dshTimelineData(session);
  if (!data) return null;
  const sec = detailSection("会话时间线");
  sec.appendChild(renderInteractiveTimeline(data));
  return sec;
}

// 会话时间线：把执行环境 envelope 里的用量序列 + 事件投影到通用几何
// （src-tauri/ui/timeline.js 的 TimelineGeometry.buildTimeline，spec §4 契约）。
// 纯数据准备 + 渲染壳——比例尺/缺口/事件保真都在 timeline.js 的纯函数里，这里只
// 负责把 DSH `requests` / Codex `cost_report.hours` 映射成 points/events。
function timelineSection(session, harness) {
  // DSH 走上面的交互式渲染壳（3 纵轴/7 事件/游标/键盘，用户反馈「功能不完整」的
  // 对象）；Codex 信封没有逐请求 context/cost，升级对它是无中生有，保持静态图。
  if (harness === "dsh") return dshTimelineSection(session);

  const geo = window.TimelineGeometry && window.TimelineGeometry.buildTimeline;
  if (!geo) return null; // timeline.js 没加载 → 不渲染这一节，不是报错

  let points = null, events = [], series = null, title = "会话时间线";
  // Codex：逐小时 token 桶（cost_report.hours 已是统计时区的逐小时 delta）。
  const hours = session.cost_report && Array.isArray(session.cost_report.hours) ? session.cost_report.hours : null;
  if (!hours || hours.length === 0) return null;
  points = hours.map((h, i) => ({ ordinal: i, values: { tokens: h.tokens } }));
  series = [{ name: "tokens", label: "token", cumulative: false }];
  title = "逐小时 token 用量（" + hours.length + " 小时）";
  // 事件叠加：Codex 的 findings 带 seq（事件空间、千级）+ severity/evidence，但
  // 没有时间；turn_timeline 的 source_order 与 finding.seq 同号，且 hour 是执行环境侧
  // 用核心 codex_hour_of 折好的**统计时区小时桶键**（与 cost_report.hours 同一把尺，
  // 浏览器不算第二遍时区转换）。这里只做两次字典查表：finding.seq →
  // turn_timeline.source_order → hour → 桶下标。seq 不在 turn_timeline 里
  //（该事件不是 5 类生命周期之一）→ 无 hour → 诚实跳过，不画在猜的位置上
  //（几何层 orphan 跳过同款）。
  const hourToOrd = {};
  for (let i = 0; i < hours.length; i++) hourToOrd[hours[i].hour] = i;
  const tt = Array.isArray(session.turn_timeline) ? session.turn_timeline : [];
  const seqToHour = {};
  for (const e of tt) if (e.hour != null && !(e.source_order in seqToHour)) seqToHour[e.source_order] = e.hour;
  const codexFindings = session.audit && Array.isArray(session.audit.findings) ? session.audit.findings : [];
  for (const f of codexFindings) {
    const h = f.seq != null ? seqToHour[f.seq] : null;
    if (h == null || !(h in hourToOrd)) continue;
    events.push({
      ordinal: hourToOrd[h],
      kind: f.rule || "risk",
      label: (f.rule || "?") + " " + (f.evidence || ""),
      severity: f.severity || "info",
    });
  }

  const svg = geo({ points, events, series, width: 800, height: 130, pad: 26 });
  const sec = detailSection(title);
  const wrap = el("div");
  wrap.innerHTML = svg;
  sec.appendChild(wrap);
  return sec;
}

// 一行「标签 + 值」：标签走 muted，值靠右 tabular-nums。用于成本/上下文这类
// 数字键值，不用为每个小维度单造一种结构。
function kvRow(label, value, title) {
  const row = el("div", "kv-row");
  const l = el("span", "kv-label");
  l.textContent = label;
  row.appendChild(l);
  const v = el("span", "kv-value");
  v.textContent = value;
  if (title) v.title = title;
  row.appendChild(v);
  return row;
}

function sevBadge(severity) {
  const b = el("span", "sev " + (severity || "info"));
  b.textContent = severity || "info";
  return b;
}

// findings 在两个执行环境里位置不同、形状略异，但都是 {rule,severity,evidence,…}。
// 取 evidence 当展示文本（Codex 无 where/title），rule 当标签，其余进 title 悬停。
function findingsSection(session) {
  const codexAudit = session.audit && Array.isArray(session.audit.findings) ? session.audit.findings : null;
  const findings = Array.isArray(session.findings) ? session.findings : codexAudit;
  if (!findings || findings.length === 0) return null;
  const sec = detailSection("findings（" + findings.length + "）");
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const row = el("div", "detail-finding");
    // 交互时间线的 risk 事件带同款 id（tl-finding-<i>），点击/回车跳转过来。
    row.id = "tl-finding-" + i;
    row.appendChild(sevBadge(f.severity));
    const txt = el("span");
    txt.textContent = (f.rule || "—") + "　" + (f.evidence || "");
    txt.title = f.tool_name ? "tool: " + f.tool_name : "";
    row.appendChild(txt);
    sec.appendChild(row);
  }
  return sec;
}

// ---------- DSH 分区 ----------

function dshCostSection(s) {
  if (!s.cost || !s.cost.per_model) return null;
  const sec = detailSection("成本明细（CNY，估算值）");
  sec.appendChild(kvRow("合计", fmtMoney(s.cost.total || 0)));
  if (s.cost.peak_total) sec.appendChild(kvRow("高峰", fmtMoney(s.cost.peak_total)));
  const total = s.cost.total || 0;
  for (const [model, m] of Object.entries(s.cost.per_model)) {
    const label = m.short_name || model;
    const sub = m.provider ? " · " + m.provider : "";
    // 占比条相对合计——多模型混跑时一眼看出钱花在哪个模型上，不用逐行读数字比较。
    const frac = total > 0 && m.total != null ? m.total / total : null;
    sec.appendChild(barRow(label + sub, fmtMoney(m.total || 0), frac, model));
  }
  return sec;
}

function dshContextSection(s) {
  if (!s.context) return null;
  const c = s.context;
  const sec = detailSection("上下文构成");
  const parts = [["system", c.system_tokens], ["tools", c.tools_tokens], ["catalog", c.catalog_tokens]];
  const sum = parts.reduce((a, [, v]) => a + (v || 0), 0);
  for (const [label, v] of parts) {
    const frac = sum > 0 && v != null ? v / sum : null;
    const suffix = label === "catalog" ? "（" + (c.catalog_entries || 0) + " 条目）" : "";
    sec.appendChild(barRow(label, fmtTokens(v) + suffix, frac));
  }
  if (Array.isArray(c.catalog_names) && c.catalog_names.length) {
    // 每个 skill 目录条目各占多少 token——这个仓库的核心命题，别埋在 JSON 里。
    // 条形相对本会话里最大的那个条目（不是相对 catalog 合计），这样即使 catalog
    // 只占 system/tools 里的一小份，条目之间谁大谁小依然一目了然。
    const sorted = c.catalog_names.slice().sort((a, b) => (b.tokens || 0) - (a.tokens || 0));
    const max = sorted[0].tokens || 0;
    const TOP_N = 8;
    const sub = el("div", "detail-subsection");
    for (const n of sorted.slice(0, TOP_N)) {
      const frac = max > 0 && n.tokens != null ? n.tokens / max : null;
      sub.appendChild(barRow(n.name || "—", fmtTokens(n.tokens), frac));
    }
    sec.appendChild(sub);
    const rest = sorted.slice(TOP_N);
    if (rest.length) {
      const det = el("details", "detail-collapsible");
      const summary = el("summary");
      summary.textContent = "其余 " + rest.length + " 条目";
      det.appendChild(summary);
      for (const n of rest) det.appendChild(kvRow(n.name || "—", fmtTokens(n.tokens)));
      sec.appendChild(det);
    }
  }
  return sec;
}

function dshWasteSection(s) {
  if (!Array.isArray(s.waste) || s.waste.length === 0) return null;
  const sec = detailSection("浪费（" + s.waste.length + "）");
  for (const w of s.waste) {
    const row = el("div", "detail-finding");
    row.appendChild(sevBadge(w.severity));
    const txt = el("span");
    txt.textContent = (w.rule || "—") + "　" + fmtTokens(w.waste_tokens) + " token";
    if (w.suggestion) txt.title = w.suggestion;
    row.appendChild(txt);
    sec.appendChild(row);
  }
  return sec;
}

function dshCompactionSection(s) {
  if (!s.compaction) return null;
  const comps = Array.isArray(s.compaction.compactions) ? s.compaction.compactions : [];
  const prunes = Array.isArray(s.compaction.prunes) ? s.compaction.prunes : [];
  if (comps.length === 0 && prunes.length === 0) return null;
  const sec = detailSection("压缩 / 剪枝");
  sec.appendChild(kvRow("压缩", comps.length + " 次"));
  sec.appendChild(kvRow("剪枝", prunes.length + " 次（共 " +
    fmtTokens(prunes.reduce((a, p) => a + (p.shadowed_token_count || 0), 0)) + " shadowed）"));
  return sec;
}

function dshDurationSection(s) {
  const calls = s.duration && Array.isArray(s.duration.tool_calls) ? s.duration.tool_calls : null;
  if (!calls || calls.length === 0) return null;
  // 273 次调用不逐条列——按工具聚合，按总耗时降序取 Top 10，一眼看出时间都烧在哪。
  const byTool = {};
  for (const c of calls) {
    const n = c.tool_name || "?";
    const d = c.duration_ms || 0;
    const e = byTool[n] || (byTool[n] = { count: 0, sum: 0, max: 0 });
    e.count++; e.sum += d; if (d > e.max) e.max = d;
  }
  const top = Object.entries(byTool)
    .map(([n, e]) => ({ n, ...e, avg: e.sum / e.count }))
    .sort((a, b) => b.sum - a.sum)
    .slice(0, 10);
  const sec = detailSection("工具耗时（Top " + top.length + "，共 " + calls.length + " 次调用）");
  const maxSum = top.length ? top[0].sum : 0;
  for (const t of top) {
    // 条形相对 Top 1 的总耗时——哪个工具吃掉大部分时间一眼可见，不用逐行比数字。
    const frac = maxSum > 0 ? t.sum / maxSum : null;
    sec.appendChild(barRow(
      t.n + "（" + t.count + " 次，峰值 " + Math.round(t.max) + "ms）",
      (t.sum / 1000).toFixed(1) + "s",
      frac
    ));
  }
  return sec;
}

function dshSubagentsSection(s) {
  if (!Array.isArray(s.subagents) || s.subagents.length === 0) return null;
  const sec = detailSection("子代理（" + s.subagents.length + "）");
  for (const a of s.subagents) {
    sec.appendChild(kvRow("T" + (a.turn != null ? a.turn : "?") + " " + (a.description || a.agent_id || "—"), ""));
  }
  return sec;
}

// 规则三态 / 覆盖率是"这份数据可不可信"的排查信息，不是"发生了什么"的主叙事——
// 一次会话可以有十几条 SV 规则、六项覆盖率，逐行 kv-row 摆出来会跟成本/时间线抢
// 同样的视觉权重。做成默认折叠的 <details>（summary 借 .detail-section-title 的
// 样式，看起来还是一个章节标题，只是可以收起），展开后用 chip 网格代替逐行文字。
function dshRuleOutcomesSection(s) {
  if (!s.rule_outcomes) return null;
  const entries = Object.entries(s.rule_outcomes);
  // findings / measured_zero / unavailable 三种结局，一次会话里每条 SV 规则落在哪
  // 一格——诚实的三态不折叠成「没发现」，chip 颜色只分这三档，不编第四种。
  const findingsCount = entries.filter(([, o]) => o && o.status === "findings").length;
  const det = el("details", "detail-section detail-collapsible");
  const summary = el("summary", "detail-section-title");
  summary.textContent = "规则三态（" + entries.length + " 条规则 · " + findingsCount + " 条有 finding）";
  det.appendChild(summary);
  const wrap = el("div", "chips");
  for (const [rule, o] of entries) {
    const status = o && o.status ? o.status : "?";
    const suffix = status === "findings" && o.count ? "（" + o.count + "）" : "";
    const cls = status === "findings" ? "status-findings" : status === "measured_zero" ? "status-zero" : "status-unavailable";
    const chip = el("span", "chip " + cls);
    chip.textContent = rule + suffix;
    chip.title = status;
    wrap.appendChild(chip);
  }
  det.appendChild(wrap);
  return det;
}

function dshCoverageSection(s) {
  const fields = ["usage_coverage", "duration_coverage", "skill_coverage",
    "subagents_coverage", "compaction_coverage", "waste_coverage"];
  const present = fields.filter((k) => s[k]);
  if (present.length === 0) return null;
  const det = el("details", "detail-section detail-collapsible");
  const summary = el("summary", "detail-section-title");
  summary.textContent = "覆盖率（" + present.length + " 项）";
  det.appendChild(summary);
  const wrap = el("div", "chips");
  for (const k of present) {
    const c = s[k];
    const v = c.status || "?";
    const extra = c.count != null ? " · " + c.count : (c.sample_count != null ? " · " + c.sample_count : "");
    const chip = el("span", "chip");
    chip.textContent = k.replace("_coverage", "") + "：" + v + extra;
    wrap.appendChild(chip);
  }
  det.appendChild(wrap);
  return det;
}

function renderDshSections(body, s) {
  const sections = [
    timelineSection(s, "dsh"),
    dshCostSection(s),
    dshContextSection(s),
    dshWasteSection(s),
    dshCompactionSection(s),
    dshDurationSection(s),
    dshSubagentsSection(s),
    dshRuleOutcomesSection(s),
    dshCoverageSection(s),
  ];
  for (const sec of sections) if (sec) body.appendChild(sec);
}

// ---------- Codex 分区 ----------

function codexAuditSection(s) {
  const sum = s.audit && s.audit.summary;
  if (!sum) return null;
  const sec = detailSection("审计摘要");
  sec.appendChild(kvRow("findings", (sum.findings_total != null ? sum.findings_total : "—") +
    "（critical " + (sum.critical || 0) + " / warning " + (sum.warning || 0) + " / info " + (sum.info || 0) + "）"));
  if (sum.rules_unavailable) sec.appendChild(kvRow("规则不可用", sum.rules_unavailable + " 条"));
  return sec;
}

function codexCostSection(s) {
  if (!s.cost_report) return null;
  const r = s.cost_report;
  const sec = detailSection("成本报告（USD）");
  sec.appendChild(kvRow("合计", fmtUSD(r.total_cost_usd)));
  const tk = r.total_tokens || {};
  sec.appendChild(kvRow("tokens", fmtTokens(
    (tk.uncached_input_tokens || 0) + (tk.cached_input_tokens || 0) + (tk.output_tokens || 0))));
  if (r.per_model) {
    // 与 dshCostSection 同款占比条（相对合计），多模型混跑时钱花在谁身上一眼可见。
    const total = r.total_cost_usd;
    for (const [model, m] of Object.entries(r.per_model)) {
      const frac = total != null && total > 0 && m.cost_usd != null ? m.cost_usd / total : null;
      sec.appendChild(barRow(m.short_name || model, fmtUSD(m.cost_usd), frac, model));
    }
  }
  return sec;
}

function codexCoverageSection(s) {
  if (!s.coverage || typeof s.coverage !== "object") return null;
  const sec = detailSection("信号覆盖率");
  for (const [sig, c] of Object.entries(s.coverage)) {
    const avail = c.available ? "" : "（不可用）";
    sec.appendChild(kvRow(sig, (c.measured || 0) + " measured" + avail));
  }
  return sec;
}

function codexQuotaSection(s) {
  if (!s.quota_trajectory) return null;
  const q = s.quota_trajectory;
  const sec = detailSection("配额轨迹");
  if (q.first) sec.appendChild(kvRow("开始", q.first.used_percent + "%"));
  if (q.last) sec.appendChild(kvRow("结束", q.last.used_percent + "%"));
  if (q.reason) sec.appendChild(kvRow("说明", q.reason));
  return sec;
}

function codexPermissionSection(s) {
  if (!s.permission_transitions) return null;
  const p = s.permission_transitions;
  const sec = detailSection("权限切换");
  sec.appendChild(kvRow("危险 turn", (p.dangerous_turns || 0) + " 个"));
  const tr = Array.isArray(p.transitions) ? p.transitions : [];
  // 只列权限真正变化过的（effective_profile 有值）与 sandbox=full-access 的，其余
  // 是 on-request/workspace-write 的常态，列出来是噪声。
  const notable = tr.filter((t) => t.sandbox === "danger-full-access" || t.approval === "never" || t.effective_profile);
  for (const t of notable.slice(0, 12)) {
    sec.appendChild(kvRow(
      "sandbox " + (t.sandbox || "?") + " · approval " + (t.approval || "?"),
      t.effective_profile ? "→ " + t.effective_profile : ""
    ));
  }
  return sec;
}

function codexTurnEndsSection(s) {
  if (!s.turn_ends) return null;
  const t = s.turn_ends;
  const sec = detailSection("Turn 结局");
  sec.appendChild(kvRow("合计", t.total + "（clean " + t.clean + " / error " + t.error + " / incomplete " + t.incomplete + "）"));
  return sec;
}

function codexMetaSection(s) {
  const sec = detailSection("会话元数据");
  if (s.cli_version) sec.appendChild(kvRow("cli", s.cli_version));
  if (s.history_mode) sec.appendChild(kvRow("模式", s.history_mode));
  if (s.context_window) sec.appendChild(kvRow("上下文窗口", fmtTokens(s.context_window)));
  if (s.effort) {
    sec.appendChild(kvRow("推理力度", (s.effort.reasoning_effort || s.effort.effective || "—") +
      (s.effort.reasoning_summary ? " · " + s.effort.reasoning_summary : "")));
  }
  if (Array.isArray(s.workspace_roots) && s.workspace_roots.length) {
    for (const w of s.workspace_roots) sec.appendChild(kvRow("工作区", w));
  }
  if (Array.isArray(s.files) && s.files.length) {
    for (const f of s.files.slice(0, 3)) sec.appendChild(kvRow("文件", f));
  }
  if (Array.isArray(s.notes) && s.notes.length) {
    for (const n of s.notes) {
      const row = el("div", "detail-meta");
      row.textContent = "· " + n;
      sec.appendChild(row);
    }
  }
  return sec;
}

function renderCodexSections(body, s) {
  const sections = [
    timelineSection(s, "codex"),
    codexAuditSection(s),
    codexCostSection(s),
    codexCoverageSection(s),
    codexQuotaSection(s),
    codexPermissionSection(s),
    codexTurnEndsSection(s),
    codexMetaSection(s),
  ];
  for (const sec of sections) if (sec) body.appendChild(sec);
}

function rawSection(env) {
  const det = el("details", "detail-raw-wrap");
  const sum = el("summary");
  sum.textContent = "原始 JSON（" + Math.round(JSON.stringify(env).length / 1024) + " KB，排查用）";
  det.appendChild(sum);
  const pre = el("pre", "detail-raw");
  pre.textContent = JSON.stringify(env, null, 2);
  det.appendChild(pre);
  return det;
}

function renderDetailEnvelope(env) {
  const body = document.getElementById("sess-detail-body");
  const loading = document.getElementById("sess-detail-loading");
  if (loading) loading.remove();

  // v0.9.1 envelope shape（mcp::session_detail）：
  //   {schema_version, data_version, authority_state, authority_revision,
  //    generated_at, timezone, coverage, freshness, warnings,
  //    data: {session_ref, harness, first_event_at, last_event_at, event_count,
  //           model_ids[], identity_kind, tokens{4 buckets + total},
  //           cost_minor, timeline[{event_at, model_id, observation_kind,
  //           peak, fact_id, tokens}], has_more, next_cursor, note}}
  //
  // 旧 r2a envelope `env.session.{cost, requests, findings, audit, ...}` 已退役
  // ——那些字段是 jsonl 重放路径里的 DSH/Codex 专属 envelope sections，
  // 不在权威库 envelope 里。本函数把 envelope 直接渲染：summary + timeline 表 +
  // 元数据，不再调 renderCodexSections/renderDshSections/findingsSection
  // （那些函数读 OLD shape 字段，全 undefined 会渲染成空壳）。
  const data = env.data || {};

  // envelope 到手先把顶部 KPI 卡补真（list 行可能 model_ids[0]/cost_minor 是
  // 缺场值，envelope.data 是权威源——以它为准）
  refreshDetailCards(data);

  // summary panel：harness / event_count / model_ids / 时间范围 / token 4 桶 / cost_minor
  body.appendChild(renderDetailSummaryPanel(data));
  body.appendChild(renderBillingBreakdown(data.billing_breakdown));

  // timeline table：按 event_at 排序的事实流（每条 fact 一行）
  const tl = Array.isArray(data.timeline) ? data.timeline : [];
  body.appendChild(renderDetailTracePlaceholder(data.session_ref));
  loadDetailTrace(data.session_ref);
  body.appendChild(renderDetailTimelineTable(tl, data.has_more));

  // 元数据：schema / data version / authority_revision（权威库 commit 标记）/
  // generated_at / authority_state —— 排查用信息，不是「这次会话发生了什么」。
  body.appendChild(renderDetailMeta(env, data));

  body.appendChild(rawSection(env));
}

function renderBillingBreakdown(buckets) {
  const sec = detailSection("计费归因与估算依据");
  const rows = Array.isArray(buckets) ? buckets : [];
  if (rows.length === 0) {
    const p = el("div", "muted");
    p.textContent = "没有可审计的计费桶；不会把它显示为零成本。";
    sec.appendChild(p);
    return sec;
  }
  const table = el("table", "detail-timeline");
  const head = el("thead");
  const headRow = el("tr");
  for (const label of ["Provider / 模型", "计费口径", "价格来源", "估算成本", "状态"]) {
    const th = el("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  for (const b of rows) {
    const tr = el("tr");
    tr.appendChild(td((b.provider_raw || b.provider_id || "<unknown>") + " · " + (b.model_id || "<unknown>")));
    tr.appendChild(td((b.billing_mode || "unknown") + " · " + (b.pricing_basis || "unavailable")));
    tr.appendChild(td((b.pricing_source || "无可用价格") + (b.pricing_version ? " · " + b.pricing_version.slice(0, 12) : "")));
    tr.appendChild(tdNum(b.cost_minor ? fmtCostMinor(b.cost_minor) + " · 估算" : "—"));
    const status = b.billing_mode === "subscription"
      ? (b.unresolved_reason || "订阅 token 不按量计费")
      : (b.has_unresolved ? (b.unresolved_reason || "归因未决") : "可审计");
    tr.appendChild(td(status));
    body.appendChild(tr);
  }
  table.appendChild(body);
  sec.appendChild(table);
  return sec;
}

function renderDetailTracePlaceholder(sessionRef) {
  const sec = detailSection("会话轨迹图");
  const target = el("div", "detail-trace");
  target.id = "sess-detail-trace";
  target.dataset.sessionRef = sessionRef || "";
  target.textContent = "轨迹加载中…";
  sec.appendChild(target);
  return sec;
}

async function loadDetailTrace(sessionRef) {
  const target = document.getElementById("sess-detail-trace");
  if (!target || !sessionRef) {
    if (target) target.textContent = "轨迹不可用：缺少安全会话引用。";
    return;
  }
  try {
    const [seriesEnv, graphEnv] = await Promise.all([
      invoke("session_trace", { sessionRef, output: "timeline_series" }),
      invoke("session_trace", { sessionRef, output: "graph" }),
    ]);
    if (target.dataset.sessionRef !== sessionRef) return;
    if (seriesEnv && seriesEnv.error) {
      target.textContent = "轨迹不可用：" + (seriesEnv.error.message || seriesEnv.error.code);
      return;
    }
    const series = (seriesEnv && seriesEnv.data) || {};
    if (!Array.isArray(series.points) || series.points.length === 0) {
      target.textContent = "该会话没有可绘制的 turn 样本；事实时间线仍在下方保留。";
      return;
    }
    target.innerHTML = window.TimelineGeometry.buildTimeline(series);
    const graph = graphEnv && !graphEnv.error ? graphEnv.data : null;
    const meta = el("div", "detail-meta");
    meta.textContent = graph ? detailTraceCoverageText(graph) : "轨迹覆盖率不可用";
    if (series.unplaced_events) {
      meta.textContent += " · " + series.unplaced_events + " 个事件没有可定位的 turn";
    }
    target.appendChild(meta);
  } catch (e) {
    if (target.dataset.sessionRef === sessionRef) {
      target.textContent = "轨迹加载失败：" + errText(e);
    }
  }
}

function detailTraceCoverageText(graph) {
  const c = graph.coverage || {};
  return "节点 " + (c.total_nodes ?? "—") + " · 边 " + (c.total_edges ?? "—") +
    " · 缺父 " + (c.missing_parent ?? "—") + " · 缺时 " + (c.missing_time ?? "—") +
    " · 缺状态 " + (c.missing_status ?? "—") + " · 废弃分支 " + (c.unmetered_nodes ?? "—");
}

// v0.9.1 详情视图降级 banner：旧 r2a envelope 的 DSH/Codex 专属分区不在权威库
// envelope 里。保留 banner 直到 M4 workflow_events 工具落地后由代码删这条
// appendChild 自动消失。
function downgradeBanner() {
  const sec = el("div", "detail-section");
  const t = el("div", "detail-section-title");
  t.textContent = "详情视图（v0.9.1 降级）";
  const body = el("div", "muted");
  body.textContent = "会话详情从 SQL 权威库 envelope 渲染（harness / tokens 4 桶 / cost_minor / 时间线 fact 流）。" +
    "旧 r2a envelope 的 DSH/Codex 专属分区（cost_report / audit.findings / requests / findings[] / " +
    "context / waste / compaction / duration / subagents / rule_outcomes 等）" +
    "等 M4 workflow_events MCP 工具落地后回填（PR #2.3a task #19）。" +
    "Findings 跨会话汇总请切「Findings」tab。";
  sec.appendChild(t);
  sec.appendChild(body);
  return sec;
}

// 详情 summary panel：4 桶 tokens + cost_minor（权威）+ 模型列表 + 时间范围。
// 是 envelope.data 的真实形状，不是 list 行的冷字段。
function renderDetailSummaryPanel(d) {
  const sec = el("div", "detail-section");
  const t = el("div", "detail-section-title");
  t.textContent = "会话概览（权威库 envelope）";
  sec.appendChild(t);
  const tk = d.tokens || {};
  const lines = [];
  lines.push("harness · " + (d.harness || "—"));
  lines.push("events · " + (d.event_count != null ? d.event_count : "—"));
  lines.push("models · " + (Array.isArray(d.model_ids) && d.model_ids.length ? d.model_ids.join(", ") : "—"));
  lines.push("时间 · " + (d.first_event_at || "—") + " … " + (d.last_event_at || "—"));
  lines.push("uncached_input · " + fmtTokens(tk.uncached_input_tokens));
  lines.push("cache_read · " + fmtTokens(tk.cache_read_tokens));
  lines.push("cache_write · " + fmtTokens(tk.cache_write_tokens));
  lines.push("output · " + fmtTokens(tk.output_tokens));
  lines.push("total · " + fmtTokens(tk.total));
  lines.push("cost · " + fmtSessionCost(d));
  const p = el("div", "detail-meta");
  p.textContent = lines.join(" · ");
  sec.appendChild(p);
  return sec;
}

// 详情 timeline table：envelope.data.timeline[] 每条事实一行。
// 字段（mcp::session_detail 写入）：
//   event_at (RFC3339 Beijing), model_id, identity_kind, observation_kind,
//   peak (0/1), fact_id, tokens{uncached_input/cache_read/cache_write/output/total}
//
// 列精简：时间 / 模型 / observation / peak / total（5 列够用，detail 总宽度
// 1100~1200px，再多列把表格挤窄反不如折叠面板）。model_ids 标"-"代表无
// 模型 id（如纯 message-only 事件）；peak=1 标 ⭐ 强调。
function renderDetailTimelineTable(timeline, hasMore) {
  const sec = el("div", "detail-section");
  const t = el("div", "detail-section-title");
  t.textContent = "时间线（" + timeline.length + " 条事实" + (hasMore ? " · 已截断" : "") + "）";
  sec.appendChild(t);
  if (timeline.length === 0) {
    const p = el("div", "muted");
    p.textContent = "（无事实数据）";
    sec.appendChild(p);
    return sec;
  }
  const table = el("table", "detail-timeline");
  const thead = el("thead");
  const trh = el("tr");
  for (const h of ["时间", "模型", "observation", "peak", "total"]) {
    const th = el("th");
    th.textContent = h;
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const f of timeline) {
    const tr = el("tr");
    tr.appendChild(td((f.event_at || "").slice(11, 19) || "—"));
    tr.appendChild(td(f.model_id || "—"));
    tr.appendChild(td(f.observation_kind || "—"));
    const peakTd = el("td");
    peakTd.textContent = f.peak === 1 ? "⭐" : "·";
    tr.appendChild(peakTd);
    const tk = f.tokens || {};
    tr.appendChild(tdNum(fmtTokens(tk.total)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  sec.appendChild(table);
  return sec;
}

function renderDetailMeta(env, data) {
  const sec = detailSection("版本元数据（权威库 envelope）");
  const mm = el("div", "detail-meta");
  // authority_revision.committed_at / max_observed_at 是 DB 固定字段（PR #2.4
  // S5 守：与 MCP/CLI 字节相等），不在调用时刻变 —— 直接读，不归一化。
  const rev = env.authority_revision || {};
  mm.textContent = [
    "schema " + (env.schema_version || "—"),
    "data " + (env.data_version || "—"),
    "authority " + (env.authority_state || "—"),
    "committed " + (rev.committed_at || "—"),
    "max_observed " + (rev.max_observed_at || "—"),
    "生成于 " + (env.generated_at || "—"),
    "session_ref " + (data.session_ref || "—"),
  ].join(" · ");
  sec.appendChild(mm);
  return sec;
}

// ---------- Issues（跨会话汇总；保留旧 findings IPC 兼容层） ----------

// finding.time 是 epoch ms（DSH 有、Codex 恒 null）。null → —，诚实不臆造。
function fmtFindingTime(ms) {
  if (ms == null) return "—";
  return formatStatisticsDateTime(ms, {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// 会话标签：title 优先，否则 native_id 兜底（Codex 标题命中非 100%，DSH 仅 17/59
// 有 workspace.json 标题）。不进 source_profile——那串太长，明细只够放标签。
function findingSessionLabel(f) {
  if (f.title) return f.title;
  if (typeof f.session_key === "string") return f.session_key;
  const id = f.session_key && f.session_key.native_id;
  return id ? String(id) : "（无标题）";
}

async function loadFindings(reset, refresh) {
  if (reset) {
    findState = { loaded: true, error: false, data: null, sev: "all", rule: "all", expanded: {}, nextCursor: null, loadingMore: false };
    document.getElementById("find-banner").hidden = true;
  }
  findState.loaded = true;
  // §1.6 性能预算：默认读侧纯 authority（已同步库的毫秒级查询）；只有「重载」
  // 按钮（refresh=true）才让后端跑 evaluator 刷新（CLI spawn，冷 cache 扫会话
  // 日志）。加载文案随之区分，重路径的等待明说，别让快路径背慢文案。
  const loadingEl = document.getElementById("find-loading");
  loadingEl.textContent = refresh
    ? "重新汇总中…要扫描会话日志，冷缓存时可能需要几十秒"
    : "加载中…读取本地汇总";
  loadingEl.hidden = false;
  try {
    // 新鲜度条与汇总并发取（spec §5.4）：它只读 authority 的两格数，失败不吞汇总。
    const [data, fresh] = await Promise.all([
      invoke("sessions_issues", { pageSize: 50, cursor: null, refresh: !!refresh }),
      invoke("findings_freshness").catch(() => null),
    ]);
    renderFreshness(fresh);
    // ②对比面首次懒加载（§1.6：纯 authority 读，不阻塞首屏渲染）。
    if (!matrixState.data) loadDecisionMatrix();
    findState.data = data;
    findState.nextCursor = data && data.next_cursor || null;
    findState.error = false;
    renderFindings();
  } catch (e) {
    // 报错不摆空卡/零汇总——横幅明说（source-unavailable → 「数据源不可用」）。
    findState.error = true;
    showBanner("find-banner", e, false);
    renderFindings();
  } finally {
    loadingEl.hidden = true;
  }
}

async function loadMoreFindings() {
  if (!findState.nextCursor || findState.loadingMore || !findState.data) return;
  findState.loadingMore = true;
  const button = document.getElementById("find-more");
  button.disabled = true;
  button.textContent = "加载中…";
  try {
    const data = await invoke("sessions_issues", { pageSize: 50, cursor: findState.nextCursor });
    const current = Array.isArray(findState.data.issues) ? findState.data.issues : [];
    const incoming = data && Array.isArray(data.issues) ? data.issues : [];
    findState.data = { ...findState.data, ...data, issues: current.concat(incoming) };
    findState.nextCursor = data && data.next_cursor || null;
    renderFindings();
  } catch (e) {
    showBanner("find-banner", e, false);
  } finally {
    findState.loadingMore = false;
    button.disabled = false;
    button.textContent = "加载更多";
    button.hidden = !findState.nextCursor;
  }
}

function renderFindings() {
  const banner = document.getElementById("find-banner");
  const empty = document.getElementById("find-empty");
  const foot = document.getElementById("find-foot");
  // 清掉上一次的筛选选择（重载即回到全量视图）。
  if (findState.error || !findState.data) {
    document.getElementById("find-total").textContent = "—";
    document.getElementById("find-critical").textContent = "—";
    document.getElementById("find-warning").textContent = "—";
    document.getElementById("find-info").textContent = "—";
    document.getElementById("find-summary").textContent = "";
    document.getElementById("find-chips").innerHTML = "";
    document.getElementById("find-rules-body").innerHTML = "";
    document.getElementById("find-rules-empty").hidden = findState.error;
    document.getElementById("find-body").innerHTML = "";
    document.getElementById("find-note").textContent = "";
    foot.textContent = "";
    document.getElementById("find-more").hidden = true;
    empty.hidden = true;
    renderTodoList([]);
    return;
  }
  banner.hidden = true;
  const t = findState.data.totals || {};
  const rows = issueRows();
  const total = t.issues != null ? t.issues : (t.findings || rows.length);

  document.getElementById("find-total").textContent = String(total);
  document.getElementById("find-total-sub").textContent =
    (t.sessions_total != null ? t.sessions_total : "?") + " 会话中 " +
    (t.sessions != null ? t.sessions : "?") + " 有发现";
  document.getElementById("find-critical").textContent = String(t.critical || 0);
  document.getElementById("find-warning").textContent = String(t.warning || 0);
  document.getElementById("find-info").textContent = String(t.info || 0);
  document.getElementById("find-summary").textContent =
    "共 " + total + " 条发现 · 规则 " + (findState.data.rules || []).length + " 条" +
    (findState.data.generated_at ? " · 生成于 " + findState.data.generated_at.slice(0, 16).replace("T", " ") : "");

  // 源贡献 chips：按 harness_kind 数明细，Claude Code/DSH/Codex 各几条。
  const chips = document.getElementById("find-chips");
  chips.innerHTML = "";
  const bySrc = {};
  for (const f of rows) {
    const k = f.harness_kind || "?";
    bySrc[k] = (bySrc[k] || 0) + 1;
  }
  for (const k of ["claude-code", "dsh", "codex"]) {
    if (bySrc[k] == null) continue;
    // 类名映射必须三分支：claude-code 落进 codex 分支会被染成 codex 色。
    const cls = k === "dsh" ? " dsh" : k === "claude-code" ? " claude-code" : " codex";
    const c = el("span", "chip" + cls);
    c.textContent = k + " · " + bySrc[k];
    chips.appendChild(c);
  }

  // 待办区（spec §3.1）：无脑可解决的项；SV6xx 永不进（isTodoGroup 挡）。
  renderTodoList(rows);
  const evidenceSummary = document.getElementById("find-evidence-summary");
  if (evidenceSummary) {
    evidenceSummary.textContent = "证据明细 · 规则命中 " + rows.length
      + " 条（行为事实与只读证据，点开筛选/逐条处理）";
  }

  // 规则表。
  const rules = findState.data.rules || issueRules(rows);
  const rulesBody = document.getElementById("find-rules-body");
  const rulesEmpty = document.getElementById("find-rules-empty");
  rulesBody.innerHTML = "";
  rulesEmpty.hidden = rules.length > 0;
  for (const r of rules) {
    const tr = document.createElement("tr");
    tr.appendChild(td(r.rule || "—"));
    const sev = document.createElement("td");
    const badge = el("span", "sev " + (r.severity || "info"));
    badge.textContent = r.severity || "info";
    sev.appendChild(badge);
    tr.appendChild(sev);
    tr.appendChild(td(r.category || "—"));
    tr.appendChild(tdNum(String(r.hits != null ? r.hits : "—")));
    tr.appendChild(tdNum(String(r.sessions != null ? r.sessions : "—")));
    rulesBody.appendChild(tr);
  }

  // 规则筛选下拉：一次填好（重载时重建），选完只重画明细。
  const ruleSel = document.getElementById("find-rule");
  const prevRule = ruleSel.value || "all";
  ruleSel.innerHTML = '<option value="all">全部规则</option>';
  for (const r of rules) {
    const opt = document.createElement("option");
    opt.value = r.rule;
    opt.textContent = r.rule;
    ruleSel.appendChild(opt);
  }
  if (prevRule !== "all" && ruleSel.querySelector('option[value="' + prevRule + '"]')) {
    ruleSel.value = prevRule;
  } else {
    ruleSel.value = "all";
  }
  if (findState.rule !== ruleSel.value) findState.rule = ruleSel.value;
  // 重载后 findState.sev 回 "all"，但下拉可能还停在用户上次的选择——双向对齐，
  // 否则显示与筛选行为打架（表按 all 筛、下拉亮着 warning）。
  const sevSel = document.getElementById("find-sev");
  if (sevSel.value !== findState.sev) sevSel.value = findState.sev;

  renderFindingsDetail();
  foot.textContent = findState.nextCursor
    ? "已加载 " + rows.length + " / " + total + " 条，可继续加载。"
    : "共 " + rows.length + " 条已加载。";
  document.getElementById("find-more").hidden = !findState.nextCursor;
}

// 只重画明细表：筛选下拉 change 时调，不碰卡片/规则表。
function renderFindingsDetail() {
  const rows = issueRows();
  const sev = findState.sev;
  const rule = findState.rule;
  const filtered = rows.filter((f) =>
    (sev === "all" || (f.severity || "other") === sev) &&
    (rule === "all" || (f.rule || "") === rule)
  );
  const shown = filtered.slice(0, 500);

  const body = document.getElementById("find-body");
  const empty = document.getElementById("find-empty");
  const note = document.getElementById("find-note");
  body.innerHTML = "";
  empty.hidden = shown.length > 0;
  note.textContent =
    "筛选出 " + filtered.length + " 条" +
    (filtered.length > shown.length ? "，仅显示前 " + shown.length : "");

  const frag = document.createDocumentFragment();
  for (const f of shown) {
    const tr = document.createElement("tr");
    tr.appendChild(td(fmtFindingTime(f.time)));
    const objectCell = document.createElement("td");
    const object = document.createElement("div");
    object.textContent = f.object || "—";
    objectCell.appendChild(object);
    const scope = document.createElement("div");
    scope.className = "issue-subline";
    scope.textContent = issueScopeLabel(f);
    objectCell.appendChild(scope);
    const basis = document.createElement("div");
    basis.className = "issue-subline";
    basis.textContent = issueBasisLabel(f);
    objectCell.appendChild(basis);
    tr.appendChild(objectCell);
    const sevCell = document.createElement("td");
    const badge = el("span", "sev " + (f.severity || "info"));
    badge.textContent = f.severity || "info";
    sevCell.appendChild(badge);
    tr.appendChild(sevCell);
    tr.appendChild(td(f.rule || "—"));
    tr.appendChild(tdNum(String(f.count != null ? f.count : "—")));
    const statusCell = document.createElement("td");
    statusCell.appendChild(document.createTextNode(statusRollupLabel(f.status_rollup)));
    const actionHint = document.createElement("div");
    actionHint.className = "issue-subline issue-action-hint";
    actionHint.textContent = issueActionLabel(f);
    statusCell.appendChild(actionHint);
    tr.appendChild(statusCell);
    const action = document.createElement("td");
    const expand = el("button", "btn secondary");
    expand.type = "button";
    expand.textContent = findState.expanded[f.group_id] ? "收起" : "展开";
    expand.addEventListener("click", () => toggleIssueGroup(f, tr));
    action.appendChild(expand);
    tr.appendChild(action);
    frag.appendChild(tr);
    if (findState.expanded[f.group_id]) {
      const detail = document.createElement("tr");
      detail.dataset.issueGroup = f.group_id || "";
      const cell = document.createElement("td");
      cell.colSpan = 8;
      cell.className = "muted";
      cell.textContent = "正在读取原始命中…";
      detail.appendChild(cell);
      frag.appendChild(detail);
      loadIssueGroupInstances(f, detail);
    }
  }
  body.appendChild(frag);
}

function issueScopeLabel(group) {
  const sessions = group.sessions_count != null ? group.sessions_count : group.sessions;
  const count = group.count != null ? group.count : group.hits;
  const parts = [];
  if (group.harness) parts.push(group.harness);
  if (group.bucket) parts.push(String(group.bucket));
  if (sessions != null) parts.push(String(sessions) + " 个会话");
  if (count != null) parts.push(String(count) + " 条命中");
  return "影响范围：" + (parts.length ? parts.join(" · ") : "范围待确认");
}

function issueBasisLabel(group) {
  const evidence = group.evidence_class || group.evidence || group.category;
  const actionability = Number(group.actionability);
  const confidence = Number.isFinite(actionability)
    ? (actionability >= 0.8 ? "较充分" : actionability >= 0.6 ? "有限" : "较弱")
    : "待确认";
  return "依据：" + (evidence || "已保留原始证据") + " · 置信限制：" + confidence +
    (group.impact == null ? " · 金额影响未量化" : "");
}

function issueActionLabel(group) {
  const remedy = group.remedy && group.remedy.remedy_id;
  if (group.source_kind === "billing_candidate" || group.source_kind === "billing_group") return "建议：明确计费方式";
  if (group.source_kind === "usage_growth") return "建议：查看对应会话";
  if (group.source_kind === "source_failure") return "建议：查看数据源并重试";
  // 价格覆盖：这条任务的可执行动作是"给这个模型补一张价卡"，不是"查看数据状态"。
  if (group.rule === "PRICE_COVERAGE") return "建议：补价卡或确认模型名";
  if (group.rule === "ROUTE_UNCONFIRMED") return "建议：明确计费方式";
  if (group.rule === "QUOTA_WINDOW") return "建议：等窗口重置或先换一条线路";
  const labels = {
    "inspect-tool-error": "建议：查看工具错误并重试",
    "inspect-retry-policy": "建议：检查重试策略",
    "reduce-context-window": "建议：检查上下文范围",
    "inspect-usage-change": "建议：查看对应会话",
    "review-budget-or-snooze": "建议：查看预算或静默提醒",
    // SV601–SV610 专属 remedy 文案（WORKBENCH_FINDINGS_TAB_SPEC §5.1；ID 来自
    // agent-vitals-data issues.rs::remedy_for 的十个新 match arm）。
    "review-destructive-shell": "建议：复核破坏性命令",
    "review-privilege-shell": "建议：复核提权命令",
    "review-remote-exec": "建议：复核远程执行命令",
    "review-sensitive-path": "建议：复核敏感路径写入",
    "narrow-write-scope": "建议：把写入收窄到工作区内",
    "review-external-fetch": "建议：复核外部地址拉取",
    "reduce-limit-pressure": "建议：降低撞限流压力",
    "inspect-timeout-tool": "建议：查看超时的工具",
    "review-approval-choice": "建议：复核审批选择",
    "tighten-sandbox-mode": "建议：收紧沙箱权限",
    "review-workspace-scope": "建议：复核工作区读取范围",
    "review-repository-history-scope": "建议：复核仓库历史是否进入快照",
    "review-secondary-session-reporting": "建议：复核会话二次上报设置",
    "review-tool-payload-egress": "建议：复核工具载荷二次上报设置",
    "review-consent-control-mismatch": "建议：复核同意开关与实际行为",
    "review-background-audit-surface": "建议：复核后台组件与审计面",
    "review-pending-retry-retention": "建议：复核待处理快照与重试策略",
    "review-remote-egress-control": "建议：复核远程下发的上报控制",
    "review-object-storage-egress": "建议：复核对象存储直传链路",
    "review-declared-exclusions": "建议：复核厂商声明的排除范围",
    "diagnostic-only": "建议：查看数据状态",
  };
  return labels[remedy] || "建议：查看详情";
}

function statusRollupLabel(rollup) {
  if (!rollup) return "—";
  const labels = [["open", "待处理"], ["later", "稍后"], ["acknowledged", "已确认"], ["resolved", "已解决"], ["not_applicable", "不适用"]];
  return labels.filter(([key]) => Number(rollup[key] || 0) > 0)
    .map(([key, label]) => label + " " + rollup[key]).join(" · ") || "—";
}

function issueActionsForStatus(status) {
  status = issueStatusCanonical(status);
  const actions = {
    open: [["later", "稍后"], ["acknowledged", "已确认"], ["resolved", "已解决"], ["not_applicable", "不适用"]],
    later: [["open", "恢复待处理"], ["acknowledged", "已确认"], ["resolved", "已解决"], ["not_applicable", "不适用"]],
    acknowledged: [["open", "恢复待处理"], ["later", "稍后"], ["resolved", "已解决"], ["not_applicable", "不适用"]],
    resolved: [["open", "恢复待处理"]],
    not_applicable: [["open", "恢复待处理"]],
  };
  return actions[status] || actions.open;
}

function issueStatusCanonical(status) {
  return {
    pending: "open",
    closed: "resolved",
    wontfix: "not_applicable",
  }[status] || status || "open";
}

function issueStatusLabel(status) {
  return {
    open: "待处理",
    later: "稍后",
    acknowledged: "已确认",
    resolved: "已解决",
    not_applicable: "不适用",
  }[issueStatusCanonical(status)] || "未知状态";
}

function issueSourceLabel(sourceKind, rule) {
  // rule 比 source_kind 细：data_quality 底下还有"价格覆盖""额度窗口"这些
  // 用户看得懂的具体类别，直接用 source_kind 会把它们统统压成"数据质量"。
  const byRule = {
    PRICE_COVERAGE: "价格覆盖",
    ROUTE_UNCONFIRMED: "路由待确认",
    QUOTA_WINDOW: "额度窗口",
  };
  if (rule && byRule[rule]) return byRule[rule];
  return {
    billing_candidate: "待确认套餐",
    source_failure: "数据源失败",
    data_quality: "数据质量",
    usage_growth: "异常用量增长",
  }[sourceKind] || "来源问题";
}

async function toggleIssueGroup(group) {
  if (!group.group_id) return;
  findState.expanded[group.group_id] = !findState.expanded[group.group_id];
  renderFindingsDetail();
}

async function loadIssueGroupInstances(group, detailRow, cursor, append) {
  try {
    if (group.rule === "ROUTE_UNCONFIRMED") {
      // 「归不了账」也是可就地解决的一件事：跳设置页声明型号归属。声明后状态会
      // 前进到"缺价卡"（那是另一条任务），而不是一步到位——链路如实分两步。
      const cell = detailRow.firstElementChild;
      const sample = group.sample_evidence && group.sample_evidence[0] || {};
      cell.textContent = "归属未确认：" + (sample.model_id || "未知型号") +
        " · 影响 " + String(group.count || 0) + " 条用量。声明它属于哪个服务商后，这批用量才能计入金额。";
      const openForm = el("button", "btn secondary");
      openForm.type = "button";
      openForm.textContent = "声明归属";
      openForm.addEventListener("click", () => {
        pendingPriceRoute = { model: sample.model_id || "", provider: "" };
        openSettingsSection("settings-data", "ov-price-route-model");
      });
      cell.appendChild(document.createTextNode(" "));
      cell.appendChild(openForm);
      return;
    }
    if (group.rule === "PRICE_COVERAGE") {
      // 「缺价卡」是可就地解决的一件事：跳设置页并把服务商/型号预填好，
      // 用户只需要填价格。不预填的话他得手抄一个带命名空间的型号名（很容易抄错）。
      const cell = detailRow.firstElementChild;
      const sample = group.sample_evidence && group.sample_evidence[0] || {};
      cell.textContent = "缺少价卡：" + (sample.model_id || "未知型号") +
        " · 影响 " + String(group.count || 0) + " 条用量。补一张卡后这些用量就能按你填的价折算。";
      const openForm = el("button", "btn secondary");
      openForm.type = "button";
      openForm.textContent = "补充价卡";
      openForm.addEventListener("click", () => {
        pendingPriceCard = { provider: sample.provider_id || "", model: sample.model_id || "" };
        openSettingsSection("settings-data", "ov-price-card-model");
      });
      cell.appendChild(document.createTextNode(" "));
      cell.appendChild(openForm);
      return;
    }
    if (group.source_kind === "budget") {
      const sample = group.sample_evidence && group.sample_evidence[0] || {};
      const cell = detailRow.firstElementChild;
      cell.textContent = "预算状态：" + (sample.level || "—") +
        " · 比例 " + (sample.ratio_bp != null ? sample.ratio_bp + "bp" : "—") +
        " · 该项仅支持到预算设置/静默入口处理，不能作为原始 Issue 关闭。";
      const openSettings = el("button", "btn secondary");
      openSettings.type = "button";
      openSettings.textContent = "打开预算设置";
      openSettings.addEventListener("click", () => {
        openSettingsSection("settings-budget", "ov-budget-monthly-amount");
      });
      cell.appendChild(document.createTextNode(" "));
      cell.appendChild(openSettings);
      return;
    }
    if (group.source_kind && group.source_kind !== "behavior") {
      const cell = detailRow.firstElementChild;
      const sample = group.sample_evidence && group.sample_evidence[0] || {};
      const sourceLabel = issueSourceLabel(group.source_kind, group.rule);
      const evidence = sample.error_code || sample.code || sample.provider_id || sample.detail?.harness || "已保留摘要";
      cell.textContent = sourceLabel + "：" + evidence + " · " + String(group.count || 0) +
        " 条来源证据。该组是只读投影，不能按行为 Issue 关闭。";
      const action = el("button", "btn secondary");
      action.type = "button";
      if (group.source_kind === "billing_candidate" || group.source_kind === "billing_group") {
        action.textContent = "明确计费方式";
        action.addEventListener("click", () => {
          switchTab("overview");
          const review = document.getElementById("ov-billing-review");
          if (review && review.click) review.click();
        });
      } else {
        action.textContent = group.source_kind === "usage_growth" ? "查看会话" : "查看数据源";
        action.addEventListener("click", () => {
          switchTab(group.source_kind === "usage_growth" ? "sessions" : "sources");
        });
      }
      cell.appendChild(document.createTextNode(" "));
      cell.appendChild(action);
      return;
    }
    const data = await invoke("issue_group_instances", { groupId: group.group_id, pageSize: 50, cursor: cursor || null });
    const cell = detailRow.firstElementChild;
    if (!append) cell.textContent = "";
    const list = data && Array.isArray(data.instances) ? data.instances : [];
    if (list.length === 0 && !append) { cell.textContent = "暂无可展开的原始命中"; return; }
    // 行为证据（SV6xx / source_kind=behavior）只读（spec §8）：给不可"解决"的
    // 事实配状态迁移按钮，等于承认这区是工单摆设——只保留"详情"查证入口。
    const readOnlyEvidence = String(group.rule || "").startsWith("SV6")
      || group.source_kind === "behavior";
    if (readOnlyEvidence && !append) {
      const note = document.createElement("div");
      note.className = "issue-subline muted";
      note.textContent = "行为证据 · 只读：命中是「发生了什么」的事实，没有待办语义（spec §8）；决策面在上方对比表。";
      cell.appendChild(note);
    }
    for (const instance of list) {
      const line = document.createElement("div");
      line.className = "issue-instance-line";
      const text = document.createElement("span");
      text.textContent = (instance.evidence || "—") + " · " + issueStatusLabel(instance.status);
      line.appendChild(text);
      const detailButton = el("button", "btn secondary");
      detailButton.type = "button";
      detailButton.textContent = "详情";
      detailButton.addEventListener("click", () => showIssueInstanceDetail(instance.issue_id, line, instance));
      line.appendChild(detailButton);
      if (/^SV70[1-9]$|^SV710$/.test(String(group.rule || ""))) {
        const suppressButton = el("button", "btn secondary");
        suppressButton.type = "button";
        suppressButton.textContent = "忽略此规则";
        suppressButton.title = "按规则抑制后续系统通知；Finding 仍保留在历史证据中";
        suppressButton.addEventListener("click", async () => {
          if (!window.confirm("忽略 " + group.rule + " 的后续通知？历史 Finding 不会删除。")) return;
          suppressButton.disabled = true;
          try {
            await invoke("trust_suppression_create", {
              issueType: group.rule,
              instanceFingerprint: null,
              reason: "workbench user suppression",
            });
            showFindReceipt("已忽略 " + group.rule + " 的后续通知；历史证据仍保留。");
            await loadFindings(true, false);
          } catch (error) {
            showBanner("find-banner", error, false);
            suppressButton.disabled = false;
          }
        });
        line.appendChild(suppressButton);
      }
      if (!readOnlyEvidence) {
        const currentStatus = issueStatusCanonical(instance.status);
        for (const [status, label] of issueActionsForStatus(currentStatus)) {
          const button = el("button", "btn secondary");
          button.type = "button";
          button.textContent = label;
          button.addEventListener("click", () => transitionIssueFromUi(instance.issue_id, status));
          line.appendChild(button);
        }
      }
      cell.appendChild(line);
    }
    const more = cell.querySelector("button[data-issue-more]");
    if (more) more.remove();
    if (data && data.next_cursor) {
      const moreButton = el("button", "btn secondary");
      moreButton.type = "button";
      moreButton.dataset.issueMore = "1";
      moreButton.textContent = "加载更多（剩余 " + Math.max(0, Number(data.total_instances || 0) - (Number(cursor || 0) + list.length)) + "）";
      moreButton.addEventListener("click", () => loadIssueGroupInstances(group, detailRow, data.next_cursor, true));
      cell.appendChild(moreButton);
    }
  } catch (e) {
    detailRow.firstElementChild.textContent = "原始命中读取失败：" + (e.message || e);
  }
}

async function showIssueInstanceDetail(issueId, line, seed) {
  const old = line.querySelector(".issue-instance-detail");
  if (old) { old.remove(); return; }
  const detail = document.createElement("div");
  detail.className = "issue-instance-detail muted";
  const renderDetail = (issue) => {
    const metadata = issue && issue.metadata && typeof issue.metadata === "object"
      ? issue.metadata : {};
    detail.textContent = "详情：" + JSON.stringify({
      issue_id: issue && issue.issue_id || issueId,
      harness_kind: issue && issue.harness_kind || seed && seed.harness_kind || null,
      rule: issue && issue.rule || seed && seed.rule || null,
      status: issueStatusLabel(issue && issue.status || seed && seed.status || null),
      evidence: issue && issue.evidence || seed && seed.evidence || null,
      opened_at_ms: issue && issue.opened_at_ms || seed && seed.opened_at_ms || null,
      metadata,
      trust_timeline: issue && Array.isArray(issue.trust_timeline) ? issue.trust_timeline : null,
    });
  };
  renderDetail(seed);
  line.appendChild(detail);
  try {
    const data = await invoke("issue_instance_read", { issueId });
    const issue = data && data.issue;
    if (issue) renderDetail(issue);
    else detail.textContent += " · 权威详情不存在";
  } catch (e) {
    detail.textContent += " · 权威详情读取失败：" + (e.message || e);
  }
}

// 开放命中总数：各组 status_rollup.open 之和。状态迁移的「待处理 N → M」
// 以它为口径 —— 组数不因单个实例迁移而变，实例数才是用户心里的「还剩几件」。
function openHitCount() {
  let open = 0;
  for (const g of issueRows()) {
    open += Number((g.status_rollup || {}).open || 0);
  }
  return open;
}

function showFindReceipt(text) {
  const receipt = document.getElementById("find-receipt");
  if (!receipt) return;
  receipt.textContent = text;
  receipt.hidden = false;
  clearTimeout(showFindReceipt._t);
  showFindReceipt._t = setTimeout(() => { receipt.hidden = true; }, 6000);
}

// ── ② 模型 × Harness 对比（spec §3.2/§4，P2）────────────────────────────
// 决策证据面：金额按币种/口径分列、永不相加（§1.5）；浪费率仅 DSH 有证据、
// 未接入恒「—」（§4.2，不用 0 冒充）；harness_behavior 是执行环境级聚合（§4.7）。
const matrixState = { data: null, expanded: {}, error: null };

async function loadDecisionMatrix() {
  try {
    const data = await invoke("decision_matrix", {});
    matrixState.data = data && Array.isArray(data.rows) ? data : null;
    matrixState.error = null;
    // 预算待办的归因块等这份数据——重画一次待办区把归因补上。
    if (findState.data) renderTodoList(issueRows());
  } catch (e) {
    // 失败与真空数据必须可区分（验收条件 4）：错误明说，不冒充「没有组合」。
    matrixState.error = e && (e.message || e) || "未知错误";
    matrixState.data = null;
    // 失败当下就把预算卡的「加载中…」换成「归因不可用」，不让错误承诺挂着。
    if (findState.data) renderTodoList(issueRows());
  }
  renderMatrix();
}

function matrixMoney(amount) {
  const symbol = amount.currency === "USD" ? "$" : amount.currency === "CNY" ? "¥" : (amount.currency || "") + " ";
  const value = (Number(amount.amount_minor || 0) / 100).toFixed(2);
  return (amount.basis === "metered_estimate" ? "≈" : "") + symbol + value;
}

function matrixTokens(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(v);
}

/// 单位会话成本（同一币种内才可比）：minor ÷ 会话数；无价或零会话 → -1
/// （排序垫底用，展示层另走「—」）。
function matrixPerSessionMinor(row, currency) {
  const amount = (row.amounts || []).find((a) => a.currency === currency);
  const sessions = Number(row.sessions || 0);
  if (!amount || !sessions) return -1;
  return Number(amount.amount_minor || 0) / sessions;
}

/// §4.6 排序：未计价行恒最前（成本未知比已知贵更值得先看）；订阅行不参与
/// （月费 ÷ 会话数无决策意义）；可排序行币种唯一才按单位会话成本降序，
/// 多币种混合时禁用排序并说明——禁止汇率折算排序（FX 只允许 metered_view
/// 的 ≈ 显示，既有纪律）。
function sortMatrixRows(rows) {
  const unpriced = [], sortable = [], subscriptionOnly = [];
  for (const row of rows) {
    if ((row.amounts || []).length > 0) sortable.push(row);
    else if (row.has_subscription) subscriptionOnly.push(row);
    else unpriced.push(row);
  }
  const byTokens = (a, b) => (Number((b.tokens || {}).total || 0)) - (Number((a.tokens || {}).total || 0));
  const currencies = new Set(sortable.flatMap((r) => (r.amounts || []).map((a) => a.currency)));
  let note = "";
  let metricSorted = false;
  if (currencies.size > 1) {
    note = "排序暂不可用：待排序行混合 " + [...currencies].join(" / ") + " 币种（不做汇率折算排序，spec §4.6）——中转用量统一为申报口径后启用。";
    sortable.sort(byTokens);
  } else if (currencies.size === 1) {
    const cur = [...currencies][0];
    sortable.sort((a, b) => matrixPerSessionMinor(b, cur) - matrixPerSessionMinor(a, cur));
    metricSorted = true;
  }
  unpriced.sort(byTokens);
  subscriptionOnly.sort(byTokens);
  return { order: unpriced.concat(sortable, subscriptionOnly), note, metricSorted, unpricedCount: unpriced.length };
}

function matrixRowKey(row) {
  return row.harness + "/" + row.model_id + "/" + row.provider_id;
}

/// 从②对比面的贡献会话下钻到会话详情（§6.7「查看轨迹」入口）：showSession
/// 走 sessions_read 的 sr_ 不透明引用，原生会话 id 不出现在前端。
function openSessionFromMatrix(sess, row) {
  if (!sess || !sess.session_ref) return;
  switchTab("sessions");
  showSession({
    session_ref: sess.session_ref,
    title: null,
    model: row.model_id || null,
    harness_kind: row.harness || null,
  });
}

// ── ⓪ 本月发现（spec §3.0）：把 dig_findings 的结构化结论组装成中文卡。
/// 后端只出数（kind + 数字），句子在这里拼——与 remedy_for→labels 同一条
/// 「后端出数、前端出话」纪律。
function digMoney(minor, currency) {
  const symbol = currency === "USD" ? "$" : currency === "CNY" ? "¥" : (currency || "") + " ";
  return symbol + (Number(minor || 0) / 100).toFixed(2);
}

function digCardText(c) {
  if (c.kind === "cost_outlier") {
    const o = c.outlier || {}, k = c.control || {};
    return {
      title: "最贵的组合贵在缓存纪律，不在单价",
      why: (o.model_id || "?") + " 单会话 ≈" + digMoney(o.per_session_minor, c.currency)
        + "，是同币种 " + (k.model_id || "?") + "（≈" + digMoney(k.per_session_minor, c.currency) + "）的 " + c.ratio_vs_control + " 倍；"
        + "主因缓存命中 " + Math.round((o.cache_hit_ratio || 0) * 100) + "%。切换后命中 "
        + Math.round((k.cache_hit_ratio || 0) * 100) + "% 的组合已被验证是替代方案。",
      gain: "该线月省 ≈" + digMoney(c.saving_minor, c.currency) + "（−" + c.saving_pct + "%）",
      action: { label: "定位到行", run: () => digDrillToRow((o.harness || "") + "/" + (o.model_id || "") + "/" + (o.provider_id || "")) },
    };
  }
  if (c.kind === "marathon") {
    return {
      title: "一个 " + c.span_hours + " 小时的马拉松会话吃掉 " + matrixTokens(c.tokens_total) + " token",
      why: "工具失败 " + (c.failures || 0) + " 次仍在跑（" + (c.combo || {}).harness + " · " + (c.combo || {}).model_id
        + "）。当前没有单会话熔断（发现 tab 待拍板 #2），一个会话可以无限烧。",
      gain: "拆任务 + 单会话熔断",
      action: { label: "查看会话", run: () => openSessionFromMatrix({ session_ref: c.session_ref }, { harness: (c.combo || {}).harness, model_id: (c.combo || {}).model_id }) },
    };
  }
  if (c.kind === "currency_split") {
    const detail = Object.entries(c.by_currency || {})
      .map(([cur, v]) => cur + " " + v.combos + " 组合/" + matrixTokens(v.tokens) + " token")
      .join("；");
    return {
      title: "计价失真让排序整个瘫痪",
      why: "可计价组合的币种不唯一（" + detail + "）——跨币种不可比，②的成本排序因此禁用。把中转用量统一为申报口径后解锁。",
      gain: "解锁全表排序",
      action: { label: "去明确计费方式", run: () => {
        switchTab("overview");
        const review = document.getElementById("ov-billing-review");
        if (review && review.click) review.click();
      } },
    };
  }
  return null;
}

function digDrillToRow(key) {
  const safe = String(key).replace(/["\\]/g, "");
  const tr = document.querySelector('tr[data-matrix-key="' + safe + '"]');
  if (!tr) return;
  // 强制展开（不是 toggle）：已展开的行点「定位到行」不能把它收起（对齐原型）。
  matrixState.expanded[key] = true;
  renderMatrix();
  const trAfter = document.querySelector('tr[data-matrix-key="' + safe + '"]');
  const target = trAfter || tr;
  if (target.scrollIntoView) target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.style.transition = "box-shadow .4s";
  target.style.boxShadow = "inset 0 0 0 2px var(--warn)";
  setTimeout(() => { target.style.boxShadow = ""; }, 2200);
}

function renderDig() {
  const list = document.getElementById("find-dig-list");
  const emptyEl = document.getElementById("find-dig-empty");
  if (!list || !emptyEl) return;
  list.textContent = "";
  if (matrixState.error) {
    emptyEl.hidden = false;
    emptyEl.textContent = "本月发现读取失败：" + matrixState.error + "（点上方「重载」可重试）";
    return;
  }
  if (!matrixState.data) {
    // 加载中 ≠ 没有异常（评审 2026-09-19：把「未加载」陈述成「无异常」是假空态）。
    emptyEl.hidden = false;
    emptyEl.textContent = "本月发现生成中…";
    return;
  }
  const summary = (matrixState.data.findings_summary) || [];
  emptyEl.hidden = summary.length > 0;
  emptyEl.textContent = "本月没有触发结论规则的异常。";
  for (const c of summary) {
    const text = digCardText(c);
    if (!text) continue;
    const row = el("div", "issue-todo-row");
    const head = el("div", "issue-todo-head");
    const title = el("strong", null);
    title.textContent = text.title;
    head.append(title);
    row.append(head);
    const why = el("div", "issue-subline muted");
    why.textContent = text.why;
    row.append(why);
    const actions = el("div", "issue-todo-actions");
    const gain = el("span", "issue-subline");
    gain.style.color = "var(--success)";
    gain.textContent = text.gain;
    actions.append(gain);
    const btn = el("button", "btn primary");
    btn.type = "button";
    btn.textContent = text.action.label;
    btn.addEventListener("click", text.action.run);
    actions.append(btn);
    row.append(actions);
    list.append(row);
  }
}

function toggleMatrixRow(key, ev) {
  if (ev && ev.target.closest("a,button")) return;
  matrixState.expanded[key] = !matrixState.expanded[key];
  renderMatrix();
}

function renderMatrix() {
  const body = document.getElementById("find-matrix-body");
  const emptyEl = document.getElementById("find-matrix-empty");
  const sortEl = document.getElementById("find-matrix-sort");
  if (!body) return;
  // ⓪结论区随本函数一起刷新（放在空行早退之前——加载中/空数据也要更新⓪文案）。
  renderDig();
  body.textContent = "";
  const rows = (matrixState.data && matrixState.data.rows) || [];
  if (matrixState.error) {
    emptyEl.hidden = false;
    emptyEl.textContent = "对比面读取失败：" + matrixState.error + "（点上方「重载」可重试）";
    sortEl.textContent = "";
    return;
  }
  if (!rows.length) {
    emptyEl.hidden = false;
    emptyEl.textContent = "本月没有可对比的组合（需要有用量事实）。";
    sortEl.textContent = "";
    return;
  }
  emptyEl.hidden = true;
  const sorted = sortMatrixRows(rows);
  const bits = [];
  if (sorted.metricSorted) bits.push("排序：浪费调整后单位会话成本（近似 · 仅排序提示，不进账单面）");
  if (sorted.note) bits.push(sorted.note);
  if (sorted.unpricedCount) bits.push("成本未知的 " + sorted.unpricedCount + " 行恒排最前");
  sortEl.textContent = bits.join(" · ");

  const frag = document.createDocumentFragment();
  // ⓪结论的异常旗（与 dig_findings 同判据的展示层）：outlier 行挂成本旗，
  // 低命中行挂命中旗（hit < 0.5 与后端规则一致）。
  const costOutlierKey = (() => {
    const c = ((matrixState.data || {}).findings_summary || []).find((x) => x.kind === "cost_outlier");
    return c && c.outlier ? c.outlier.harness + "/" + c.outlier.model_id + "/" + c.outlier.provider_id : null;
  })();
  for (const row of sorted.order) {
    const key = matrixRowKey(row);
    const tr = document.createElement("tr");
    tr.className = "matrix-row";
    tr.dataset.matrixKey = key;
    tr.addEventListener("click", (ev) => toggleMatrixRow(key, ev));

    const comboCell = document.createElement("td");
    const harness = document.createElement("div");
    harness.textContent = row.harness + " · " + row.model_id;
    comboCell.appendChild(harness);
    const tags = document.createElement("div");
    tags.className = "issue-subline";
    const tagBits = [row.provider_id];
    for (const a of row.amounts || []) {
      if (a.basis === "metered_estimate") tagBits.push("估算");
      else if (a.basis) tagBits.push(a.basis);
    }
    if (row.cost_provider_unresolved) tagBits.push("计价归因未定");
    if (row.has_subscription) tagBits.push("套餐内");
    if (!(row.amounts || []).length && !row.has_subscription) tagBits.push("未计价");
    tags.textContent = tagBits.join(" · ");
    comboCell.appendChild(tags);
    if (costOutlierKey && key === costOutlierKey) {
      const flag = document.createElement("span");
      flag.className = "flag cost";
      flag.textContent = "单会话成本异常";
      comboCell.appendChild(flag);
    }
    if (row.cache_hit_ratio != null && row.cache_hit_ratio < 0.5) {
      const flag = document.createElement("span");
      flag.className = "flag hit";
      flag.textContent = "命中 " + Math.round(row.cache_hit_ratio * 100) + "%";
      comboCell.appendChild(flag);
    }
    tr.appendChild(comboCell);

    const num = (text) => {
      const td = document.createElement("td");
      td.className = "num";
      td.textContent = text;
      return td;
    };
    tr.appendChild(num(String(row.sessions || 0)));
    tr.appendChild(num(matrixTokens((row.tokens || {}).total)));

    const costTd = num((row.amounts || []).map(matrixMoney).join(" · ") || "—");
    tr.appendChild(costTd);

    // 单会话：同一币种内才算；无价/订阅/混合 → 「—」（§4.6 订阅行不参与）。
    const perCur = new Set((row.amounts || []).map((a) => a.currency));
    let perCell = "—";
    if (perCur.size === 1 && !row.has_subscription) {
      const cur = [...perCur][0];
      const minor = matrixPerSessionMinor(row, cur);
      if (minor >= 0) perCell = (row.amounts[0].basis === "metered_estimate" ? "≈" : "") +
        (cur === "USD" ? "$" : "¥") + (minor / 100).toFixed(2);
    }
    tr.appendChild(num(perCell));

    const ratio = row.cache_hit_ratio;
    tr.appendChild(num(ratio == null ? "—" : Math.round(ratio * 100) + "%"));
    tr.appendChild(num("—")); // 浪费率：仅 DSH，未接入（§4.2），不用 0 冒充
    // 撞限流（§4.5）：SV607/608 执行环境级命中 + 每会话均值；无命中 → 「—」。
    const pressure = row.limit_pressure;
    tr.appendChild(num(pressure
      ? String(pressure.hits) + " 次" + (pressure.per_session != null ? " · ≈" + pressure.per_session + "/会话" : "")
      : "—"));
    frag.appendChild(tr);

    if (matrixState.expanded[key]) {
      const detail = document.createElement("tr");
      detail.className = "matrix-detail-row";
      const cell = document.createElement("td");
      cell.colSpan = 7;
      const buckets = document.createElement("div");
      buckets.className = "issue-subline";
      const t = row.tokens || {};
      buckets.textContent = "四桶：未缓存输入 " + matrixTokens(t.uncached_input) +
        " · 缓存读 " + matrixTokens(t.cache_read) + " · 缓存写 " + matrixTokens(t.cache_write) +
        " · 输出 " + matrixTokens(t.output);
      cell.appendChild(buckets);
      const behavior = row.harness_behavior || {};
      if (Object.keys(behavior).length) {
        const b = document.createElement("div");
        b.className = "issue-subline";
        b.textContent = "执行环境级证据（spec §4.7，不按模型归组）：" +
          Object.entries(behavior).map(([rule, count]) => rule + " × " + count).join(" · ");
        cell.appendChild(b);
      }
      for (const sess of row.top_sessions || []) {
        const line = document.createElement("div");
        line.className = "issue-subline";
        const hours = ((sess.span_last_ms - sess.span_first_ms) / 3600000).toFixed(1);
        line.textContent = "贡献会话 " + String(sess.session_ref || "").slice(0, 14) + "… · 跨度 " + hours + "h（事件跨度近似）· " + matrixTokens(sess.tokens_total) + " token" + (sess.failures > 0 ? " · 失败 " + sess.failures : "");
        cell.appendChild(line);
        cell.appendChild(document.createTextNode(" "));
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn sm";
        btn.textContent = "查看轨迹";
        btn.addEventListener("click", () => openSessionFromMatrix(sess, row));
        cell.appendChild(btn);
      }
      const notes = document.createElement("div");
      notes.className = "issue-subline";
      notes.textContent = ((matrixState.data && matrixState.data.notes) || []).join("；");
      cell.appendChild(notes);
      detail.appendChild(cell);
      frag.appendChild(detail);
    }
  }
  body.appendChild(frag);
}

async function transitionIssueFromUi(issueId, toStatus) {
  // 迁移前后各读一次 rollup 计数（spec §5.6）：反馈给「已处理 1 项 · 待处理
  // 命中 N → M」。M 不变时如实说明（同组还有开放命中），不假装减了。
  const before = openHitCount();
  try {
    await invoke("issue_transition", { issueId, toStatus, reason: "workbench user action" });
    await loadFindings(true);
    const after = openHitCount();
    showFindReceipt("已处理 1 项 · 待处理命中 " + before + " → " + after
      + (after !== before ? "" : "（该组仍有开放命中）"));
  } catch (e) {
    showBanner("find-banner", e, false);
  }
}

// ---------- 发现 tab P1：待办/证据两分区（WORKBENCH_FINDINGS_TAB_SPEC §3.1/§3.3）----------
//
// 待办准入门槛（spec §1 判断标准 2）：动作明确、表单预填完成、点击后有可见
// 结果、可撤销 —— 四条全满足才进。做不到的不伪装成任务。SV6xx 行为命中是
// 「发生了什么」的事实陈述，永不进待办区（§3.1），它们住在证据区。

const TODO_SOURCE_KINDS = new Set(["billing_candidate", "billing_group", "source_failure", "budget"]);
const TODO_RULES = new Set(["PRICE_COVERAGE", "ROUTE_UNCONFIRMED"]);

function isTodoGroup(group) {
  if (String(group.rule || "").startsWith("SV6")) return false;
  return TODO_SOURCE_KINDS.has(group.source_kind) || TODO_RULES.has(group.rule);
}

// 待办行主按钮：与证据区展开分支同一套预填动作（动作逻辑唯一，不抄第二份）。
// 预填目标：设置页的价格表单 / 归属声明表单 / 预算设置 / 总览的计费确认面板。
function todoMainAction(group) {
  const sample = group.sample_evidence && group.sample_evidence[0] || {};
  if (group.rule === "ROUTE_UNCONFIRMED") {
    return { label: "声明归属", run: () => {
      pendingPriceRoute = { model: sample.model_id || "", provider: "" };
      openSettingsSection("settings-data", "ov-price-route-model");
    } };
  }
  if (group.rule === "PRICE_COVERAGE") {
    return { label: "补充价卡", run: () => {
      pendingPriceCard = { provider: sample.provider_id || "", model: sample.model_id || "" };
      openSettingsSection("settings-data", "ov-price-card-model");
    } };
  }
  if (group.source_kind === "budget") {
    return { label: "看超在哪", run: () => {
      const matrix = document.getElementById("find-matrix");
      if (matrix && matrix.scrollIntoView) matrix.scrollIntoView({ behavior: "smooth", block: "start" });
    } };
  }
  if (group.source_kind === "billing_candidate" || group.source_kind === "billing_group") {
    return { label: "明确计费方式", run: () => {
      switchTab("overview");
      const review = document.getElementById("ov-billing-review");
      if (review && review.click) review.click();
    } };
  }
  return { label: "查看数据源", run: () => switchTab("sources") };
}

// 一句话 = 发生了什么 + 影响多少。主语取样本证据里最能认出这组事的字段。
function todoTitle(group) {
  const sample = group.sample_evidence && group.sample_evidence[0] || {};
  if (group.rule === "PRICE_COVERAGE") return "缺少价卡：" + (sample.model_id || "未知型号");
  if (group.rule === "ROUTE_UNCONFIRMED") return "归属未确认：" + (sample.model_id || "未知型号");
  if (group.source_kind === "budget") {
    const level = sample.level === "exceeded" ? "已超" : "告警";
    return "预算" + level + "：" + (sample.month || group.bucket || "当月");
  }
  if (group.source_kind === "source_failure") {
    return "数据源读取失败：" + (sample.error_code || sample.code || "未知错误");
  }
  if (group.source_kind === "billing_candidate" || group.source_kind === "billing_group") {
    return "计费方式待明确" + (sample.provider_id ? "：" + sample.provider_id : "");
  }
  return group.rule || "待办";
}

/// 预算待办的归因块（用户反馈 2026-09-19：卡片只给"设置预算范围"，没回答
/// "为什么超"）。数据全部来自已加载的②对比面：同币种（预算是 CNY）金额行
/// 按 amount 降序取前三，各带一句特征（缓存命中低 / 马拉松会话）；USD 行
/// 如实标注"未折算、未计入"（多币种不相加）。②未加载时显示等待文案。
function budgetAttribution(group) {
  const box = el("div", "issue-subline muted");
  const sample = group.sample_evidence && group.sample_evidence[0] || {};
  const meteredMinor = Number(sample.metered_cny_minor != null ? sample.metered_cny_minor : NaN);
  const rows = (matrixState.data && matrixState.data.rows) || [];
  const cnyRows = rows.filter((r) => (r.amounts || []).some((a) => a.currency === "CNY"));
  const hasUsd = rows.some((r) => (r.amounts || []).some((a) => a.currency === "USD"));
  if (!matrixState.data) {
    if (!matrixState.error) box.textContent = "超支归因加载中（对比面数据就绪后自动补上）…";
    else box.textContent = "超支归因不可用：对比面读取失败（" + matrixState.error + "）";
    return box;
  }
  if (!cnyRows.length) {
    box.textContent = "超支归因：本月没有已计价的 CNY 组合" + (hasUsd ? "（另有 USD 估算行，未折算不计入）" : "") + "。";
    return box;
  }
  const sumMinor = cnyRows.reduce((acc, r) => acc + Number((r.amounts.find((a) => a.currency === "CNY") || {}).amount_minor || 0), 0);
  const top = cnyRows.slice().sort((a, b) =>
    Number((b.amounts.find((x) => x.currency === "CNY") || {}).amount_minor || 0)
    - Number((a.amounts.find((x) => x.currency === "CNY") || {}).amount_minor || 0)).slice(0, 3);
  const head = document.createElement("div");
  head.textContent = "钱主要去了哪（按量已计价部分"
    + (Number.isFinite(meteredMinor) ? " ¥" + (meteredMinor / 100).toFixed(2) : "")
    + " 的去向，同币种，前三）：";
  box.appendChild(head);
  for (const row of top) {
    const amount = row.amounts.find((a) => a.currency === "CNY") || {};
    const share = sumMinor > 0 ? Math.round(Number(amount.amount_minor || 0) / sumMinor * 100) : 0;
    const traits = [];
    if (row.cache_hit_ratio != null && row.cache_hit_ratio < 0.5) traits.push("缓存命中 " + Math.round(row.cache_hit_ratio * 100) + "%");
    const marathon = (row.top_sessions || []).find((sess) => (sess.span_last_ms - sess.span_first_ms) > 24 * 3600000);
    if (marathon) traits.push("含 " + ((marathon.span_last_ms - marathon.span_first_ms) / 3600000).toFixed(1) + "h 马拉松会话");
    const line = document.createElement("div");
    line.textContent = "· " + row.harness + " · " + row.model_id + " — ≈¥" + (Number(amount.amount_minor || 0) / 100).toFixed(2)
      + "（占 " + share + "%）" + (traits.length ? " · " + traits.join(" · ") : "");
    box.appendChild(line);
  }
  if (hasUsd) {
    const note = document.createElement("div");
    note.textContent = "另有 USD 估算行未折算、未计入本归因（多币种不相加；统一申报口径后并入）。";
    box.appendChild(note);
  }
  return box;
}

function renderTodoList(rows) {
  const list = document.getElementById("find-todo-list");
  const emptyEl = document.getElementById("find-todo-empty");
  if (!list || !emptyEl) return;
  list.textContent = "";
  const sevRank = { critical: 0, warning: 1, info: 2 };
  const todos = rows.filter(isTodoGroup).sort((a, b) =>
    ((sevRank[a.severity] != null ? sevRank[a.severity] : 3)
      - (sevRank[b.severity] != null ? sevRank[b.severity] : 3))
    || (Number(b.count || 0) - Number(a.count || 0)));
  emptyEl.hidden = todos.length > 0;
  for (const group of todos) {
    const row = el("div", "issue-todo-row");
    const head = el("div", "issue-todo-head");
    const title = el("strong", null);
    title.textContent = todoTitle(group);
    head.append(title);
    const scope = el("div", "issue-subline muted");
    scope.textContent = issueScopeLabel(group) + " · " + issueActionLabel(group);
    head.append(scope);
    row.append(head);
    if (group.source_kind === "budget") {
      const attr = budgetAttribution(group);
      if (attr) row.append(attr);
    }
    const actions = el("div", "issue-todo-actions");
    const main = todoMainAction(group);
    const mainBtn = el("button", "btn primary");
    mainBtn.type = "button";
    mainBtn.textContent = main.label;
    mainBtn.addEventListener("click", main.run);
    actions.append(mainBtn);
    if (group.source_kind === "budget") {
      const settingsBtn = el("button", "btn sm");
      settingsBtn.type = "button";
      settingsBtn.textContent = "预算设置";
      settingsBtn.addEventListener("click", () => openSettingsSection("settings-budget", "ov-budget-monthly-amount"));
      actions.append(settingsBtn);
    }
    const moreBtn = el("button", "btn secondary");
    moreBtn.type = "button";
    moreBtn.textContent = "明细与状态";
    moreBtn.addEventListener("click", () => toggleTodoInstances(group, row));
    actions.append(moreBtn);
    row.append(actions);
    const holder = el("div", "issue-todo-instances");
    holder.hidden = true;
    holder.append(el("div", "muted"));
    row.append(holder);
    list.append(row);
  }
}

// 待办行的「明细与状态」：复用证据区的实例展开（loadIssueGroupInstances 吃
// detailRow.firstElementChild 契约，这里给同样结构）。状态迁移按钮在实例行上，
// 迁移后的计数反馈由 transitionIssueFromUi 统一负责（spec §5.6 纯前端）。
function toggleTodoInstances(group, row) {
  const holder = row.querySelector(".issue-todo-instances");
  const button = row.querySelector(".issue-todo-actions button:nth-child(2)");
  if (!holder || !button) return;
  if (holder.hidden) {
    holder.hidden = false;
    holder.firstElementChild.textContent = "正在读取原始命中…";
    button.textContent = "收起";
    loadIssueGroupInstances(group, holder);
  } else {
    holder.hidden = true;
    button.textContent = "明细与状态";
  }
}

// 新鲜度条（spec §4.8/§6.5）：数字截止时刻 + stale 执行环境名单。数据面 =
// findings_freshness（runtime data_freshness_report，与 MCP envelope 同源）。
/// §4.8 时间显示：当日只给 HH:MM；跨日必须带日期（"9月18日 23:43"）——同步
/// 若是三天前的，光写 23:43 会让用户以为是今天。解析失败退回原串，不猜。
function freshnessClock(raw) {
  if (!raw) return "未知";
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return String(raw);
  const hm = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
  const now = new Date();
  if (t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate()) {
    return hm;
  }
  return (t.getMonth() + 1) + "月" + t.getDate() + "日 " + hm;
}

function renderFreshness(fresh) {
  const bar = document.getElementById("find-freshness");
  if (!bar) return;
  bar.hidden = false;
  if (!fresh || fresh.status !== "ok") {
    bar.textContent = "新鲜度未知：数据状态读取失败。";
    return;
  }
  const f = fresh.freshness || {};
  const parts = [];
  if (f.last_successful_sync_at) parts.push("数字截至 " + freshnessClock(f.last_successful_sync_at));
  const stale = Array.isArray(f.stale_harnesses) ? f.stale_harnesses : [];
  if (stale.length) parts.push("超过 24h 未更新：" + stale.join("、"));
  bar.textContent = parts.length ? "新鲜度 · " + parts.join(" · ") : "新鲜度 · 数据完整";
}

function issueRows() {
  if (!findState.data) return [];
  return Array.isArray(findState.data.issues) ? findState.data.issues : (findState.data.findings || []);
}

function issueRules(rows) {
  const byRule = {};
  for (const row of rows) {
    const key = row.rule || row.issue_type || "unknown";
    const cur = byRule[key] || { rule: key, severity: row.severity || "info", hits: 0, sessions: 0 };
    cur.hits += 1;
    byRule[key] = cur;
  }
  return Object.values(byRule);
}

// 从 Issues 明细跳转到该会话详情：切到会话 tab 的详情视图，用 issue 里能
// 拿到的字段（session_key/title/model/harness_kind）拼一个最小 list item 交给
// showSession。成本/token/findings 三个 summary 卡片会诚实地显示「—」（finding
// 不含这些），完整数字在下方报告分区里。
function openSessionFromFinding(f) {
  if (!f.session_key) return;
  switchTab("sessions");
  showSession({
    session_key: f.session_key,
    title: f.title || null,
    model: f.model || null,
    harness_kind: f.harness_kind || (f.session_key.harness_kind) || null,
  });
}

// ---------- 数据源状态 ----------

async function loadSources(reset, preloadedOverview) {
  if (reset) {
    srcState = { loaded: true, error: false, sources: null, sync: null, paused: false, customRoots: [], locations: {} };
    document.getElementById("src-banner").hidden = true;
  }
  srcState.loaded = true;
  const loadingEl = document.getElementById("src-loading");
  loadingEl.hidden = false;
  // 两个数据源独立拉：一个失败不吞另一个（partial 照样渲染，横幅明说缺哪个）。
  let err = null;
  try {
    const [r, custom, locations] = await Promise.all([invoke("data_source_status"), invoke("custom_source_roots"), invoke("source_read_locations")]);
    if (!r || r.status !== "ok") throw new Error((r && r.reason) || "数据源状态不可用");
    srcState.sources = Array.isArray(r.sources) ? r.sources : [];
    if (!custom || custom.status !== "ok") throw new Error((custom && custom.reason) || "自定义目录配置不可用");
    srcState.customRoots = Array.isArray(custom.sources) ? custom.sources : [];
    if (!locations || locations.status !== "ok") throw new Error((locations && locations.reason) || "读取位置不可用");
    srcState.locations = locations.locations || {};
  } catch (e) { err = e; }
  try {
    // preloadedOverview：设置 tab 已经为预算卡拉过一次 read_overview，
    // 这里复用同一份结果，不再重复拉（每次 read_overview 约 120-360ms）。
    const ov = preloadedOverview !== undefined ? preloadedOverview : await invoke("read_overview");
    srcState.sync = (ov && ov.sync) || null;
  } catch (e) { if (!err) err = e; }
  try {
    const control = await invoke("sync_pause_state");
    srcState.paused = control && control.status === "ok" ? control.paused === true : false;
  } catch (e) { if (!err) err = e; }
  loadingEl.hidden = true;
  if (err) { srcState.error = true; showBanner("src-banner", err, false); }
  else { srcState.error = false; }
  renderSources();
}

// 数据源读取失败的原因码 → 人话（规格 §5.6）。摘要行只显示映射后的文字，
// 原始 code 只出现在展开区的 title（供排障，不算"卡面暴露内部词表"）。
const SOURCE_ERROR_TEXT = {
  permission_denied: "没有读取权限",
  permission: "没有读取权限",
  file_missing: "找不到日志文件",
  all_files_failed: "所有日志文件都读取失败",
  db_error: "本地数据库出错",
  migration_failed: "本地数据库需要迁移",
};
function sourceErrorText(code) {
  return SOURCE_ERROR_TEXT[code] || "读取失败";
}

function renderSources() {
  const syncEl = document.getElementById("src-sync");
  const sync = srcState.sync;
  const pauseToggle = document.getElementById("src-pause-toggle");
  pauseToggle.textContent = srcState.paused ? "恢复自动同步" : "暂停自动同步";
  pauseToggle.onclick = async () => {
    pauseToggle.disabled = true;
    try {
      await invoke("set_sync_paused", { paused: !srcState.paused });
      if (!srcState.paused) await invoke("trigger_sync");
      await loadSources(true);
    } catch (e) {
      showBanner("src-banner", e, false);
    } finally {
      pauseToggle.disabled = false;
    }
  };
  if (sync) {
    if (srcState.paused) {
      syncEl.textContent = "自动同步已暂停；已有导入记录仍可查看。";
      syncEl.title = "恢复同步后才会再次读取本地日志";
    } else if (sync.ok) {
      syncEl.textContent = "上次同步：成功" + (sync.at ? " " + sync.at.slice(11, 16) : "");
      syncEl.title = sync.message || "";
    } else if (sync.stage === "never") {
      syncEl.textContent = "尚未同步";
      syncEl.title = "";
    } else {
      syncEl.textContent = "⚠ 上次同步失败：" + (sync.message || "未知原因");
      syncEl.title = sync.message || "";
    }
  } else {
    syncEl.textContent = "同步状态未知";
  }

  const cards = document.getElementById("src-cards");
  renderCustomSourceRoots();
  cards.innerHTML = "";
  if (srcState.error && !srcState.sources) return;
  const sources = Array.isArray(srcState.sources) ? srcState.sources : [];
  // 有失败来源的排到最前（规格 §4.1.2），其余保持契约返回顺序。
  const ordered = [...sources].sort((a, b) => {
    const af = a.connection_state === "needs_attention" || Number((a.failed_scope || {}).sources || 0) > 0;
    const bf = b.connection_state === "needs_attention" || Number((b.failed_scope || {}).sources || 0) > 0;
    return af === bf ? 0 : af ? -1 : 1;
  });
  for (const source of ordered) cards.appendChild(renderSourceRow(source));
  const failedSources = sources.filter((source) =>
    source.connection_state === "needs_attention" ||
    Number((source.failed_scope || {}).sources || 0) > 0
  );
  if (failedSources.length > 0) {
    const details = failedSources.map((source) => HARNESS_DISPLAY[source.harness] || source.harness || "未知来源").join("、");
    showBanner(
      "src-banner",
      "部分来源读取失败：" + details + "。其他来源已继续同步；请在对应行展开后重新同步。",
      false,
    );
  }
}

function renderCustomSourceRoots() {
  const harness = document.getElementById("src-custom-harness");
  const root = document.getElementById("src-custom-root");
  const choose = document.getElementById("src-custom-choose");
  const add = document.getElementById("src-custom-add");
  const list = document.getElementById("src-custom-list");
  const status = document.getElementById("src-custom-status");
  if (!harness || !root || !choose || !add || !list || !status) return;
  const show = (text) => { status.hidden = false; status.textContent = text; };
  choose.onclick = async () => {
    choose.disabled = true;
    try {
      const selected = await invoke("pick_custom_source_root");
      if (selected) {
        root.value = selected;
        add.disabled = false;
        status.hidden = true;
      }
    } catch (e) { show("无法打开目录选择：" + errText(e)); status.focus(); }
    finally { choose.disabled = false; }
  };
  add.onclick = async () => {
    if (!root.value) return;
    add.disabled = true;
    try {
      const saved = await invoke("add_custom_source_root", { input: { harness: harness.value, root: root.value } });
      show(saved.changed ? "已添加目录，正在启动同步。" : "该目录已在读取范围内，正在重新同步。");
      await invoke("trigger_sync");
      await loadSources(true);
    } catch (e) { show("添加失败：" + errText(e)); status.focus(); }
    finally { add.disabled = !root.value; }
  };
  list.textContent = "";
  for (const source of srcState.customRoots || []) {
    const row = document.createElement("div");
    row.className = "src-custom-row";
    const text = document.createElement("div");
    text.className = "src-custom-path";
    text.textContent = (HARNESS_DISPLAY[source.harness] || source.harness) + " · " + source.root;
    const remove = document.createElement("button");
    remove.className = "btn secondary";
    remove.textContent = "移除读取位置";
    remove.title = "移除不删除已导入数据";
    remove.onclick = async () => {
      remove.disabled = true;
      try {
        await invoke("remove_custom_source_root", { input: { harness: source.harness, root: source.root } });
        show("已移除读取位置；已导入数据仍保留。");
        await loadSources(true);
      } catch (e) { remove.disabled = false; show("移除失败：" + errText(e)); status.focus(); }
    };
    row.append(text, remove);
    list.appendChild(row);
  }
}

// 状态词表：connection_state → (词, 修饰符)。paused/excluded 用 muted，不用
// warn 黄——暂停/排除是用户主动选择，不是需要关注的问题（规格 §4.1）。
const SRC_STATE_TEXT = {
  connected: ["已连接", "ok"],
  needs_attention: ["需要处理", "danger"],
  paused: ["已暂停", "muted"],
  excluded: ["已停止读取", "muted"],
  not_detected: ["未检测到", "muted"],
};

function renderSourceRow(src) {
  const key = src.harness || src.source_id || "unknown";
  const row = el("div", "src-row");
  row.dataset.harness = key;
  const status = src.connection_state || "unknown";
  const [stateText, stateModifier] = SRC_STATE_TEXT[status] || ["状态未知", "muted"];
  const failed = (src.failed_scope && src.failed_scope.sources) || 0;
  const scope = src.import_scope || {};

  const head = el("button", "src-row-head");
  head.type = "button";
  head.setAttribute("aria-expanded", "false");
  const dot = el("span", "src-dot " + (failed > 0 ? "danger" : stateModifier));
  dot.textContent = "●";
  dot.setAttribute("aria-hidden", "true");
  const name = el("span", "src-row-name");
  name.textContent = HARNESS_DISPLAY[key] || key;
  if (key === "workbuddy") {
    const experimental = el("span", "chip");
    experimental.textContent = "实验支持";
    experimental.style.marginLeft = "6px";
    name.appendChild(experimental);
  }
  const state = el("span", "src-row-state " + (failed > 0 ? "danger" : stateModifier));
  state.textContent = failed > 0 ? "需要处理" : stateText;
  const meta = el("span", "src-row-meta");
  const sessionsText = (scope.sessions ?? 0) > 0 || status !== "not_detected"
    ? Number(scope.sessions || 0) + " 个会话"
    : "尚未导入";
  const lastEventText = fmtSourceTime(src.log && src.log.last_event_at_ms);
  meta.textContent = sessionsText + " · 最近记录 " + lastEventText + (failed > 0 ? " · 读取失败" : "");
  const caret = el("span", "src-row-caret");
  caret.textContent = "▾";
  caret.setAttribute("aria-hidden", "true");
  head.append(dot, name, state, meta, caret);

  const detail = el("div", "src-row-detail");
  detail.hidden = true;
  const location = srcState.locations && srcState.locations[key];
  if (location) {
    const loc = el("div");
    const short = String(location).replace(/^\/Users\/[^/]+/, "~");
    loc.textContent = "读取位置：" + short + " ";
    const showFull = el("button", "chip-link");
    showFull.type = "button";
    showFull.textContent = "显示完整路径";
    showFull.onclick = () => { loc.firstChild.textContent = "读取位置：" + String(location) + " "; showFull.remove(); };
    loc.appendChild(showFull);
    detail.appendChild(loc);
  }
  const range = el("div");
  const first = scope.first_event_at_ms ? fmtSourceTime(scope.first_event_at_ms) : null;
  const last = scope.last_event_at_ms ? fmtSourceTime(scope.last_event_at_ms) : null;
  range.textContent = "导入范围：" + (scope.facts ?? 0) + " 条记录" +
    (first && last ? "（" + first + " – " + last + "）" : "");
  detail.appendChild(range);
  const scan = el("div");
  scan.textContent = "扫描：" + ((src.scan && src.scan.source_count) ?? 0) + " 个文件" +
    (src.scan && src.scan.last_scanned_at_ms ? " · 上次扫描 " + fmtSourceTime(src.scan.last_scanned_at_ms) : "");
  detail.appendChild(scan);
  if (failed > 0) {
    const codes = (src.failed_scope && src.failed_scope.error_codes) || [];
    const text = codes.length ? codes.map(sourceErrorText).join("、") : "读取失败";
    const failRow = el("div", "degraded-row");
    failRow.title = codes.join(", ");
    failRow.textContent = failed + " 个文件读取失败 · " + text + "；本来源本轮不是新鲜数据。";
    detail.appendChild(failRow);
  }
  const action = src.recovery_action || {};
  const actions = el("div", "src-row-detail-actions");
  if (action.label) {
    const button = el("button", "chip-link");
    button.type = "button";
    button.textContent = action.label;
    // 块体箭头函数不会隐式返回 recoverSource 的 promise（旧版单表达式箭头会）——
    // 补 return，否则 onclick() 调用方（真机点击无所谓，但测试和任何未来的
    // await button.onclick() 都会拿到 undefined，观察不到轮询过程就提前判定完成）。
    button.onclick = (event) => { event && event.stopPropagation(); return recoverSource(button, key, action.kind); };
    actions.appendChild(button);
  }
  if (status !== "excluded") {
    const exclude = el("button", "chip-link");
    exclude.type = "button";
    exclude.textContent = "停止读取此来源";
    exclude.title = "停止后续读取，已导入数据保持不变";
    exclude.onclick = async (event) => {
      event && event.stopPropagation();
      exclude.disabled = true;
      try {
        await invoke("set_source_harness_excluded", { input: { harness: key, excluded: true } });
        await loadSources(true);
      } catch (e) {
        exclude.disabled = false;
        showBanner("src-banner", "无法停止读取：" + errText(e), false);
      }
    };
    actions.appendChild(exclude);
  }
  const clear = el("button", "chip-link danger");
  clear.type = "button";
  clear.textContent = "删除已导入数据…";
  clear.title = "只删除本 App 中该来源的已导入数据；不会删除工具原始日志";
  clear.onclick = async (event) => {
    event && event.stopPropagation();
    const name = HARNESS_DISPLAY[key] || key;
    if (!window.confirm("删除\u201c" + name + "\u201d已导入到本 App 的数据？\n\n将删除 " + (scope.facts ?? 0) + " 条记录、" + (scope.sessions ?? 0) +
        " 个会话；不会删除该工具的原始日志。该来源会同时停止读取，恢复读取后才会重新导入。")) return;
    clear.disabled = true;
    try {
      const result = await invoke("delete_imported_source_data", { harness: key });
      showBanner("src-banner", "已删除 " + result.facts + " 条记录、" + result.sessions + " 个会话；原始日志未修改。", true);
      await loadSources(true);
    } catch (e) {
      clear.disabled = false;
      showBanner("src-banner", "删除失败：" + errText(e), false);
    }
  };
  actions.appendChild(clear);
  detail.appendChild(actions);

  head.onclick = () => {
    const open = detail.hidden;
    detail.hidden = !open;
    row.dataset.open = open ? "1" : "0";
    head.setAttribute("aria-expanded", open ? "true" : "false");
  };
  row.append(head, detail);
  return row;
}

function fmtSourceTime(ms) {
  if (typeof ms !== "number") return "暂无";
  return formatStatisticsDateTime(ms, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

async function recoverSource(button, harness, actionKind) {
  const syncEl = document.getElementById("src-sync");
  button.disabled = true;
  syncEl.textContent = (HARNESS_DISPLAY[harness] || harness) + "：正在扫描…";
  try {
    if (actionKind === "resume_sync") {
      await invoke("set_sync_paused", { paused: false });
    }
    if (actionKind === "include_source") {
      await invoke("set_source_harness_excluded", { input: { harness, excluded: false } });
    }
    const requestId = await invoke("trigger_sync");
    if (!requestId) throw new Error("同步请求未返回追踪编号");
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const state = await invoke("sync_request_status", { requestId });
      if (state && state.completed === true) {
        await loadSources(true);
        return;
      }
    }
    throw new Error("同步仍在后台运行，请稍后点重载查看结果");
  } catch (e) {
    showBanner("src-banner", e, false);
  } finally {
    button.disabled = false;
  }
}

async function loadTrustMonitorConfig() {
  const toggle = document.getElementById("find-trust-monitor-toggle");
  const interval = document.getElementById("find-trust-monitor-interval");
  const notify = document.getElementById("find-trust-monitor-notify");
  const status = document.getElementById("find-trust-monitor-status");
  if (!toggle || !interval || !notify || !status) return;
  try {
    const config = await invoke("trust_monitor_config");
    const enabled = !!(config && config.enabled);
    toggle.checked = enabled;
    notify.checked = !!(config && config.notifications_enabled);
    notify.disabled = !enabled;
    if (config && Number.isFinite(Number(config.interval_seconds))) {
      interval.value = String(config.interval_seconds);
    }
    status.hidden = false;
    status.textContent = config && config.status === "ok"
      ? (enabled
        ? "实时监测已开启 · " + (config.capability === "unavailable" ? "传感器不可用" : "仅本机脱敏元数据")
        : "实时监测未开启")
      : "实时监测状态不可用（默认关闭）";
  } catch (_) {
    toggle.checked = false;
    notify.checked = false;
    notify.disabled = true;
    status.hidden = false;
    status.textContent = "实时监测状态不可用（默认关闭）";
  }
  if (toggle.dataset.bound === "1") return;
  toggle.dataset.bound = "1";
  const save = async () => {
    const enabled = toggle.checked;
    const notificationsEnabled = notify.checked;
    toggle.disabled = true;
    interval.disabled = true;
    notify.disabled = true;
    try {
      const saved = await invoke("save_trust_monitor_config", {
        enabled,
        intervalSeconds: Number(interval.value),
        notificationsEnabled,
      });
      notify.checked = !!(saved && saved.notifications_enabled);
      notify.disabled = !enabled;
      status.hidden = false;
      status.textContent = enabled
        ? "实时监测已开启 · 仅本机脱敏元数据" + (notify.checked ? " · 新行为链将按冷却窗口通知" : "")
        : "实时监测未开启";
    } catch (error) {
      toggle.checked = !enabled;
      status.hidden = false;
      status.textContent = "保存失败：" + errText(error);
      notify.disabled = !toggle.checked;
    } finally {
      toggle.disabled = false;
      interval.disabled = false;
      notify.disabled = !toggle.checked;
    }
  };
  toggle.addEventListener("change", save);
  interval.addEventListener("change", save);
  notify.addEventListener("change", save);
}

// ---------- 初始化 ----------

async function init() {
  // 先拿到后端实际统计时区，再初始化默认的今天、本月和会话月份，避免
  // 用户自定义时区在首屏被浏览器系统时区覆盖。
  await loadStatisticsTimezonePreference();
  calMonth = statisticsMonth();
  subscribeBudgetNotificationActions();
  // fold 完成事件桥：先订阅再首屏渲染，缩小「事件早于 listen」的丢窗口
  // （丢的那几个由 5 分钟 tick / 手动同步兜底，见事件桥一节注释）。
  subscribeFoldEvent();
  subscribeSyncStatusEvent();
  // 菜单导航事件桥同款：先订阅；冷启动（webview 先加载、focus-tab emit 早于 listen）
  // 的那次点击由 init 末尾的 pullNavTarget() 命中，subscribeNavEvent 只管窗口已建后。
  subscribeNavEvent();
  // 会话深链事件桥同款：先订阅；冷启动丢的那次由 init 末尾的 pullFocusTarget()
  // 命中（subscribeFocusTargetEvent 只管窗口已建后）。
  subscribeFocusTargetEvent();
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  });
  // 计费提示由总览异步刷新填充。先在 DOM 初始化阶段挂一个只负责展开的
  // 稳定监听器，避免候选读取完成与用户点击恰好交错时只看到“可确认”提示、
  // 却无法打开面板；候选行和声明动作仍由 renderBillingConfirmation 绑定。
  const billingReviewButton = document.getElementById("ov-billing-review");
  const billingReviewPanel = document.getElementById("ov-billing-review-panel");
  if (billingReviewButton && billingReviewPanel && billingReviewButton.dataset.fallbackBound !== "1") {
    billingReviewButton.dataset.fallbackBound = "1";
    billingReviewButton.addEventListener("click", () => {
      billingReviewOpen = true;
      billingReviewPanel.hidden = false;
      switchTab("sources");
    });
  }
  document.getElementById("wb-refresh").addEventListener("click", loadActiveTab);
  // FR-11 同款纪律（见 dsh-client audit/actions.ts）：复制类操作不得静默失败——
  // 按钮文字直接说明成功/失败，不摆一个点了没反应的按钮。
  document.getElementById("wb-screenshot").addEventListener("click", async () => {
    const btn = document.getElementById("wb-screenshot");
    const original = btn.textContent;
    btn.disabled = true;
    try {
      await invoke("capture_workbench_screenshot");
      btn.textContent = "已复制";
    } catch (e) {
      btn.textContent = "失败";
      console.error(e);
    }
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1500);
  });
  document.getElementById("cal-prev").addEventListener("click", () => shiftMonth(-1));
  document.getElementById("cal-next").addEventListener("click", () => shiftMonth(1));
  document.getElementById("cal-metric").addEventListener("change", (ev) => {
    calMetric = ev.target.value === "cost" ? "cost" : "tokens";
    renderCalendar();
  });
  document.getElementById("cal-month").addEventListener("change", (ev) => {
    if (ev.target.value) { calMonth = ev.target.value; renderCalendar(); }
  });
  // harness 过滤 chips（spec §7.3）：过滤变化 → 重置分页 + 重新加载（游标语义是
  // 全量翻页，带旧过滤的游标续拉会混页）。
  document.querySelectorAll("#sess-filter .chip").forEach((c) => {
    c.addEventListener("click", () => {
      if (c.dataset.harness === sessFilter) return;
      sessFilter = c.dataset.harness;
      updateFilterChips();
      loadSessions(true);
    });
  });
  document.getElementById("sess-more").addEventListener("click", () => loadSessions(false));
  document.getElementById("sess-reload").addEventListener("click", () => loadSessions(true));
  // 月份 picker（修「点会话 tab 只看到今天」bug）：change 事件重置分页 +
  // 重载（cursor 是 per-window 的，跨月 cursor 无意义——store.rs list_args 不
  // 检查 cursor 与 month 是否匹配，混传会让用户以为在翻页实则乱跳）。
  // picker 默认值 = 当前统计时区月份，保持「开 tab 立刻看到数据」的体感；
  // 用户主动清空 picker → IPC 收 month=undefined → store.rs 兜底为 --day 今天。
  const sessMonthEl = document.getElementById("sess-month");
  sessMonthEl.value = statisticsMonth();
  sessMonthEl.addEventListener("change", () => loadSessions(true));
  const sessWindowEl = document.getElementById("sess-window");
  const sessFromEl = document.getElementById("sess-from");
  const sessToEl = document.getElementById("sess-to");
  const syncSessionWindowControls = () => {
    const custom = sessWindowEl.value === "custom";
    sessFromEl.hidden = !custom;
    sessToEl.hidden = !custom;
    sessMonthEl.hidden = sessWindowEl.value !== "month";
  };
  sessWindowEl.addEventListener("change", () => { syncSessionWindowControls(); loadSessions(true); });
  sessFromEl.addEventListener("change", () => loadSessions(true));
  sessToEl.addEventListener("change", () => loadSessions(true));
  syncSessionWindowControls();
  const sessModelEl = document.getElementById("sess-model");
  sessModelEl.addEventListener("change", () => loadSessions(true));
  const sessProviderEl = document.getElementById("sess-provider");
  sessProviderEl.addEventListener("change", () => loadSessions(true));
  const sessStatusEl = document.getElementById("sess-status");
  sessStatusEl.addEventListener("change", () => {
    sessStatusFilter = sessStatusEl.value;
    renderSessions();
  });
  document.getElementById("sess-back").addEventListener("click", () => {
    document.getElementById("sess-detail-view").hidden = true;
    document.getElementById("sess-list-view").hidden = false;
  });
  // 重载 = 唯一显式触发重路径（evaluator 刷新）的入口（spec §1.6）。Trust
  // Profile 可能由 MCP 在窗口打开后暂存；同一次重载必须重新读取控制面，不能让
  // 用户看到陈旧的「没有待批准」而误以为导入失败。
  document.getElementById("find-reload").addEventListener("click", async () => {
    await Promise.all([loadFindings(true, true), loadTrustMonitorConfig(), loadTrustProfileProposals()]);
  });
  async function loadTrustProfileProposals() {
    const list = document.getElementById("find-trust-profile-proposals");
    const approvedList = document.getElementById("find-trust-profile-approved");
    const suppressionList = document.getElementById("find-trust-suppressions");
    const status = document.getElementById("find-trust-profile-status");
    try {
      const envelope = await invoke("trust_profile_proposal_status");
      const data = envelope && envelope.data ? envelope.data : envelope;
      const pending = Array.isArray(data && data.pending) ? data.pending : [];
      const approved = Array.isArray(data && data.approved) ? data.approved : [];
      list.replaceChildren();
      approvedList.replaceChildren();
      suppressionList.replaceChildren();
      list.hidden = pending.length === 0;
      approvedList.hidden = approved.length === 0;
      status.hidden = false;
      status.textContent = pending.length
        ? "有 " + pending.length + " 个 Agent Profile 待你批准；Agent 不能自行启用。"
        : "没有待批准的 Agent Profile。";
      pending.forEach((profile) => {
        const sourceScope = profile.source_scope_preview;
        const trustScope = profile.trust_scope_preview;
        const safeRootClasses = ["home_relative", "home_directory", "absolute_home_path"];
        const canApprove = profile.state === "pending" && /^[0-9a-f]{16}$/.test(String(profile.manifest_hash || ""))
          && sourceScope && trustScope && sourceScope.roots_count > 0 && trustScope.roots_count > 0
          && !sourceScope.covers_full_filesystem && !sourceScope.may_leave_home_directory
          && Array.isArray(sourceScope.root_classes) && sourceScope.root_classes.every((value) => safeRootClasses.includes(value))
          && trustScope.home_relative_only === true;
        const scopeText = sourceScope && trustScope
          ? "日志根 " + sourceScope.roots_count + "（" + (sourceScope.root_classes || []).join("、") + "），匹配模式 " + (profile.discovery_include_count || 0)
            + "；Trust 根 " + trustScope.roots_count + "（" + (trustScope.root_classes || []).join("、") + "），词项/扩展名 " + (profile.artifact_terms_count || 0) + "/" + (profile.extensions_count || 0)
          : "授权范围无法安全预览";
        const row = document.createElement("li");
        row.className = "notice";
        const label = document.createElement("span");
        label.className = "notice-text";
        label.textContent = (profile.display_name || profile.slug || "未知 Profile") + "（" + (profile.slug || "?") + "） · " + scopeText + " · 清单 " + (profile.manifest_hash || "不可用");
        const actions = document.createElement("span");
        actions.className = "notice-actions";
        const approve = document.createElement("button");
        approve.className = "btn secondary";
        approve.textContent = "批准并启用";
        approve.disabled = !canApprove;
        approve.title = canApprove ? "批准前将再次确认脱敏范围摘要" : "范围无法安全预览或超出用户目录，不能在此批准";
        approve.addEventListener("click", async () => {
          if (!canApprove || !window.confirm("批准并启用 " + (profile.display_name || profile.slug) + "？\n\n" + scopeText + "\n\n只显示路径类别，不显示本机路径；该动作将按清单哈希 " + profile.manifest_hash + " 再次校验。匹配词仅显示数量，范围摘要不代表实际读取文件清单。")) return;
          approve.disabled = true;
          try { await invoke("trust_profile_approve", { slug: profile.slug, manifestHash: profile.manifest_hash }); await loadTrustProfileProposals(); }
          catch (error) { showBanner("find-banner", error, false); approve.disabled = false; }
        });
        const reject = document.createElement("button");
        reject.className = "btn secondary";
        reject.textContent = "拒绝";
        reject.addEventListener("click", async () => {
          if (!window.confirm("拒绝 " + (profile.display_name || profile.slug) + "？该操作绑定清单哈希 " + (profile.manifest_hash || "不可用") + "，仅移除待批准提案。")) return;
          reject.disabled = true;
          try { await invoke("trust_profile_reject", { slug: profile.slug, manifestHash: profile.manifest_hash }); await loadTrustProfileProposals(); }
          catch (error) { showBanner("find-banner", error, false); reject.disabled = false; }
        });
        actions.append(approve, reject);
        row.append(label, actions);
        list.append(row);
      });
      approved.forEach((profile) => {
        const row = document.createElement("li");
        row.className = "notice";
        const label = document.createElement("span");
        label.className = "notice-text";
        const sourceScope = profile.source_scope_preview;
        const trustScope = profile.trust_scope_preview;
        const scopeText = sourceScope && trustScope
          ? "日志根 " + sourceScope.roots_count + "（" + (sourceScope.root_classes || []).join("、") + "），Trust 根 " + trustScope.roots_count + "（" + (trustScope.root_classes || []).join("、") + "）"
          : "范围摘要暂不可用";
        label.textContent = (profile.display_name || profile.slug || "未知 Profile") + "（已启用） · " + scopeText + " · 清单 " + (profile.manifest_hash || "不可用");
        const revoke = document.createElement("button");
        revoke.className = "btn secondary";
        revoke.textContent = "撤销";
        revoke.addEventListener("click", async () => {
          if (!window.confirm("撤销 " + (profile.display_name || profile.slug) + "？清单哈希 " + (profile.manifest_hash || "不可用") + "。撤销会停用 Profile，但不会删除已生成的本机证据。")) return;
          revoke.disabled = true;
          try { await invoke("trust_profile_revoke", { slug: profile.slug, manifestHash: profile.manifest_hash }); await loadTrustProfileProposals(); }
          catch (error) { showBanner("find-banner", error, false); revoke.disabled = false; }
        });
        row.append(label, revoke);
        approvedList.append(row);
      });
      try {
        const suppressionData = await invoke("trust_suppression_list");
        const suppressions = Array.isArray(suppressionData && suppressionData.suppressions)
          ? suppressionData.suppressions.filter((item) => item && !item.revoked_at_ms) : [];
        suppressionList.hidden = suppressions.length === 0;
        suppressions.forEach((item) => {
          const row = document.createElement("li");
          row.className = "notice";
          const label = document.createElement("span");
          label.className = "notice-text";
          label.textContent = (item.issue_type || "Trust Finding") + "（已忽略后续通知）";
          const revoke = document.createElement("button");
          revoke.className = "btn secondary";
          revoke.textContent = "撤销忽略";
          revoke.addEventListener("click", async () => {
            revoke.disabled = true;
            try { await invoke("trust_suppression_revoke", { suppressionId: item.suppression_id }); await loadTrustProfileProposals(); }
            catch (error) { showBanner("find-banner", error, false); revoke.disabled = false; }
          });
          row.append(label, revoke);
          suppressionList.append(row);
        });
      } catch (_) {
        suppressionList.hidden = true;
      }
    } catch (error) {
      status.hidden = false;
      status.textContent = "Profile 待审状态暂不可用。";
    }
  }
  document.getElementById("find-trust-coverage").addEventListener("click", async () => {
    const button = document.getElementById("find-trust-coverage");
    const status = document.getElementById("find-trust-coverage-status");
    button.disabled = true;
    button.textContent = "检查中…";
    try {
      const result = await invoke("trust_discover");
      const rows = result && Array.isArray(result.candidates) ? result.candidates : [];
      const installed = rows.filter((row) => row && row.detected);
      const gaps = installed.filter((row) => row.coverage_state === "detected_unprofiled");
      status.textContent = gaps.length
        ? "发现 " + installed.length + " 个本地 Agent，其中 " + gaps.length + " 个尚无历史审计 Profile；这是覆盖缺口，不是风险结论。"
        : "发现 " + installed.length + " 个本地 Agent，均有历史审计 Profile；这不等同于实时网络监测。";
      status.hidden = false;
      // 覆盖检查是用户最常在 Agent 暂存 Profile 后点击的动作；顺带刷新待审行，
      // 使本机 MCP 控制面的变更无需重启窗口才可见。
      await loadTrustProfileProposals();
    } catch (error) {
      showBanner("find-banner", error, false);
    } finally {
      button.disabled = false;
      button.textContent = "覆盖检查";
    }
  });
  document.getElementById("find-trust-runtime").addEventListener("click", async () => {
    const button = document.getElementById("find-trust-runtime");
    const status = document.getElementById("find-trust-coverage-status");
    button.disabled = true;
    button.textContent = "采集中…";
    try {
      const result = await invoke("trust_runtime_snapshot");
      const candidates = Number(result && result.candidate_processes || 0);
      const observations = Number(result && result.observations || 0);
      const capability = result && result.capability || "unavailable";
      status.textContent = observations
        ? "进程快照发现 " + candidates + " 个待复核行为链，已记录 " + observations + " 条脱敏证据；这只表示尝试链路，不证明已传输。"
        : "进程快照未发现待复核行为链（" + capability + "）。这不是持续监控，也不等同于不存在其他网络行为。";
      status.hidden = false;
      if (observations) await loadFindings(true, false);
    } catch (error) {
      showBanner("find-banner", error, false);
    } finally {
      button.disabled = false;
      button.textContent = "进程快照";
    }
  });
  function renderTrustAuditEvidence(reports) {
    const card = document.getElementById("find-trust-audit-card");
    const overview = document.getElementById("find-trust-audit-overview");
    const evidenceList = document.getElementById("find-trust-evidence-list");
    const verdict = document.getElementById("find-trust-audit-verdict");
    if (!card || !overview || !evidenceList || !verdict) return;
    card.hidden = false;
    overview.replaceChildren();
    evidenceList.replaceChildren();
    const safeReports = reports.filter((report) => report && typeof report === "object");
    const allEvidence = safeReports.flatMap((report) => Array.isArray(report.evidence)
      ? report.evidence.map((item) => ({ ...item, harness: report.harness || "执行环境" })) : []);
    const findingCount = safeReports.reduce((sum, report) => sum + Number(report.findings_upserted || 0), 0);
    verdict.textContent = findingCount ? findingCount + " 个风险 Finding" : "未形成风险结论";
    verdict.className = "trust-verdict " + (findingCount ? "trust-verdict-danger" : "trust-verdict-neutral");
    const overviewItems = [
      ["扫描执行环境", String(safeReports.length)],
      ["结构化证据", String(allEvidence.length)],
      ["打包/快照", String(allEvidence.filter((item) => item.kind === "package").length)],
      ["出网尝试", String(allEvidence.filter((item) => item.stage === "egress_attempted" || item.stage === "egress_transmitted").length)],
    ];
    overviewItems.forEach(([label, value]) => {
      const item = document.createElement("div");
      item.className = "trust-audit-stat";
      const number = document.createElement("strong");
      number.textContent = value;
      const caption = document.createElement("span");
      caption.textContent = label;
      item.append(number, caption);
      overview.append(item);
    });
    if (!allEvidence.length) {
      const empty = document.createElement("div");
      empty.className = "trust-evidence-empty";
      empty.textContent = "本次没有可展示的本机证据。";
      evidenceList.append(empty);
      return;
    }
    const labels = {
      package: "打包/快照", remote_ack: "客户端状态", retry: "重试", credential: "上传准备",
      connection: "连接", outbound_bytes: "出网字节", file_scope: "文件范围",
    };
    const levelLabels = { E1: "E1 本地结构", E2: "E2 上传准备", E3: "E3 网络尝试", E4: "E4 已传输", E5: "E5 已验证接收" };
    allEvidence.sort((left, right) => Number(left.observed_at_ms || 0) - Number(right.observed_at_ms || 0));
    allEvidence.forEach((item) => {
      const row = document.createElement("article");
      row.className = "trust-evidence-row";
      const marker = document.createElement("div");
      marker.className = "trust-evidence-marker";
      marker.setAttribute("aria-hidden", "true");
      const body = document.createElement("div");
      body.className = "trust-evidence-body";
      const title = document.createElement("div");
      title.className = "trust-evidence-title";
      const harness = document.createElement("strong");
      harness.textContent = item.harness;
      const kind = document.createElement("span");
      kind.textContent = labels[item.kind] || item.kind || "结构化证据";
      title.append(harness, kind);
      const meta = document.createElement("div");
      meta.className = "trust-evidence-meta";
      const time = Number(item.observed_at_ms);
      const timeLabel = Number.isFinite(time) && time > 0 ? new Date(time).toLocaleString() : "时间不可用";
      meta.textContent = timeLabel + " · " + (levelLabels[item.evidence_level] || item.evidence_level || "证据等级未知")
        + " · 来源 " + (item.evidence_origin || "unknown_legacy");
      const facts = document.createElement("div");
      facts.className = "trust-evidence-facts";
      const factValues = [];
      if (Array.isArray(item.scope_classes) && item.scope_classes.length) factValues.push("范围：" + item.scope_classes.join("、"));
      if (Number.isFinite(Number(item.file_count))) factValues.push("文件 " + item.file_count + " 个");
      if (Number.isFinite(Number(item.byte_count))) factValues.push("大小 " + formatBytes(Number(item.byte_count)));
      if (item.native_event_ref) factValues.push("引用 " + item.native_event_ref);
      facts.textContent = factValues.join(" · ") || "未提供额外范围信息";
      body.append(title, meta, facts);
      row.append(marker, body);
      evidenceList.append(row);
    });
  }
  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return "未知大小";
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
    if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB";
    return (value / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  }
  document.getElementById("find-trust-audit").addEventListener("click", async () => {
    const button = document.getElementById("find-trust-audit");
    const status = document.getElementById("find-trust-audit-status");
    button.disabled = true;
    button.textContent = "扫描中…";
    try {
      const result = await invoke("trust_audit", { harness: "all" });
      const reports = Array.isArray(result && result.reports) ? result.reports : [];
      renderTrustAuditEvidence(reports);
      const summary = reports.map((report) => {
        const stages = report && report.stage_counts || {};
        const kinds = report && report.observation_kind_counts || {};
        const parts = [];
        if (Number(kinds.package || 0)) parts.push(Number(kinds.package) + " 份打包清单");
        if (Number(stages.remote_accepted || 0)) parts.push(Number(stages.remote_accepted) + " 条客户端记录的接受状态");
        if (Number(kinds.retry || 0)) parts.push(Number(kinds.retry) + " 条重试状态");
        if (!parts.length) parts.push(Number(report && report.discovered || 0) + " 条本地证据");
        return (report && report.harness || "执行环境") + "：" + parts.join("、")
          + "；" + (Number(report && report.findings_upserted || 0)
            ? "已更新 " + Number(report.findings_upserted) + " 个风险 Finding"
            : "未生成可判定风险 Finding");
      });
      status.hidden = false;
      status.textContent = summary.length
        ? "历史审计完成 · " + summary.join("；") + "。未生成 Finding 不等于未发生行为，只表示现有本机证据未满足某条风险规则。"
        : "历史审计完成，但没有可报告的执行环境结果。";
      await loadFindings(true, false);
    } catch (error) {
      showBanner("find-banner", error, false);
    } finally {
      button.disabled = false;
      button.textContent = "本地审计";
    }
  });
  await loadTrustMonitorConfig();
  await loadTrustProfileProposals();
  document.getElementById("find-more").addEventListener("click", loadMoreFindings);
  document.getElementById("find-sev").addEventListener("change", (ev) => {
    findState.sev = ev.target.value;
    renderFindingsDetail();
  });
  document.getElementById("find-rule").addEventListener("change", (ev) => {
    findState.rule = ev.target.value;
    renderFindingsDetail();
  });
  // 日历默认月跟随统计时区今天；本月输入框受 input[type=month] 约束天然合法。
  if (!calMonth) calMonth = statisticsMonth();
  initSkillsTab();
  renderOverview();
  // 启动 pull：冷启动时（webview 先加载、focus-tab/focus-target emit 早于 listen）
  // 菜单点击的目标在这里命中。apply 后 clear，此后 focus/事件两条路都不会重复应用。
  pullNavTarget();
  pullFocusTarget();
}


// ---------- Skill 体检（docs/v1.0.0/WORKBENCH_SKILL_HEALTH_TAB_SPEC.md）----------
//
// 纪律：tab 不重新测量、不重新判定 —— 每一个数字、每一条 SV 发现都从
// `agent-vitals doctor --json - --with-report --no-snapshot` 的载荷里取
// （spec §1 判断标准 1「同源」）。前端只做格式化与执行环境归属（归属也只用
// 载荷里已有的字段：冲突条目自带 harness、重叠对自带 domain、安全命中按
// path 回查 report.skills，不自造键）。
//
// 「并列不合并」（spec §0/§3.5）：页头只出四类白名单合计（REQ-SK-03）；
// 预算、Tier1、冲突、重叠、僵尸永不出跨执行环境单一数字。每执行环境各用各的
// 预算分母，没有分母的执行环境不画预算条。

const SK_HARNESS_ORDER = ["claude-code", "codex", "openclaw", "hermes", "workbuddy", "dsh"];
const SK_HARNESS_DISPLAY = {
  "claude-code": "Claude Code",
  "codex": "Codex",
  "openclaw": "OpenClaw",
  "hermes": "Hermes",
  "workbuddy": "WorkBuddy",
  "dsh": "DeepSeek Harness",
};
// SV 码 → 中文短名（SKILL.md §2 码表 / references/guide.zh-CN.md）。
// 码永远与人话并列出现，不单独出现裸码（spec §8）。
const SK_CODE_ZH = {
  SV001: "描述预算告警",
  SV002: "描述预算溢出",
  SV004: "逐条描述截断",
  SV101: "被更新副本遮蔽",
  SV102: "冗余副本",
  SV103: "有意覆盖",
  SV105: "frontmatter 无效",
  SV201: "零触发",
  SV202: "休眠",
  SV301: "单次触发成本高",
  SV303: "昂贵且未用",
  SV401: "重叠候选",
  SV501: "提示注入模式",
  SV502: "管道到 shell",
  SV503: "base64 执行",
  SV504: "裸 IP 拉取",
  SV505: "硬编码密钥",
  SV506: "读取凭据环境变量",
  SV507: "混淆执行",
  SV508: "加密压缩包",
  SV901: "能力不可用",
  SV902: "skill 不可读",
};
// 程序只做词法筛选，语义判断永远是人的工作（SKILL.md §3）：这些码的行动列
// 固定「需你判断」，不给一键操作（spec §3.6/§6.2/§8）。
const SK_NEED_JUDGEMENT = "需你判断 · 在终端跑 explain <name>，或让 Agent 跑 /agent-vitals";
function skNeedsJudgement(code) {
  return code === "SV401" || code.startsWith("SV5");
}
// 执行环境无预算时的固定文案（spec §5.4）：不画条，dsh 追加逐条截断提示。
const SK_NO_BUDGET_TEXT = "该执行环境没有描述预算";
// 预算分母来源标签（与 README 兼容性表同词，spec §6.1）。
const SK_BUDGET_SOURCE_TEXT = {
  "configurable": "可配置估算",
  "official-estimate": "官方 2% 估算",
};

// Skill 体检状态：首进不自动扫（spec §7 —— codex app-server 拉起是秒级开销，
// 首屏空转不如让用户点「开始扫描」）。harness 变化会按新 harness 重新取数
// （REQ-SK-04：单执行环境视图 = doctor --harness <h> 的可视化，取数必须带 --harness）。
let skState = { loaded: false, error: false, data: null, scanning: false, harness: "all" };

function skFmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function skEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function skHarnessChip(harness) {
  const chip = skEl("span", "chip", SK_HARNESS_DISPLAY[harness] || harness);
  chip.dataset.harness = harness;
  return chip;
}

// 每条诊断执行环境归属：只用载荷已有字段。冲突条目自带 harness；重叠对自带
// domain（= conflict_domain）；其余按 path / name 回查 report.skills。
// 查不到的码（预算、能力缺失这类聚合项）返回空数组 —— 芯片区留空，
// 绝不猜一个执行环境写上去。
function skDiagHarnesses(d, index) {
  const code = d.code;
  const ev = d.evidence || {};
  const harnesses = [];
  const push = (h) => { if (h && !harnesses.includes(h)) harnesses.push(h); };
  if (code === "SV101" || code === "SV102" || code === "SV103") {
    (ev.conflicts || []).forEach((c) => push(c.harness));
  } else if (code === "SV401") {
    (ev.pairs || []).forEach((p) => push(p.domain));
  } else if (code.startsWith("SV5")) {
    (ev.hits || []).forEach((h) => skHarnessesFor(index, h.path, h.skill).forEach(push));
  } else if (code === "SV105" || code === "SV902" || code === "SV201" || code === "SV303") {
    (ev.skills || []).forEach((s) => skHarnessesFor(index, s.path, s.name).forEach(push));
  } else if (code === "SV202") {
    (ev.skills || []).forEach((s) => skHarnessesFor(index, null, s.name).forEach(push));
  } else if (code === "SV301") {
    (ev.skills || []).forEach((s) => skHarnessesFor(index, s.path, s.name).forEach(push));
  }
  return harnesses;
}

// path → 执行环境数组（多值）：`~/.agents/skills` 是 dsh 与 openclaw 的共享根，
// 同一个目录会以两个 harness_family 各出现一条 —— 真机实测形状。安全命中按
// (path, rule, line) 去重后挂**两枚**执行环境芯片（spec §3.2 文件类跨执行环境去重）。
function skIndexByPathAndName(report) {
  const byPath = {};
  const byName = {};
  const add = (m, k, v) => {
    if (!k) return;
    (m[k] = m[k] || []).push(v);
  };
  (report && report.skills || []).forEach((s) => {
    const fam = s.harness_family || s.harness;
    add(byPath, s.path, fam);
    if (s.name && !(s.name in byName)) byName[s.name] = fam;
  });
  Object.keys(byPath).forEach((k) => {
    byPath[k] = Array.from(new Set(byPath[k]));
  });
  return { byPath, byName };
}

// 一条证据（带 path 或 name）的执行环境归属数组。path 多执行环境时全部列出。
function skHarnessesFor(index, path, name) {
  if (path && index.byPath[path]) return index.byPath[path];
  const byName = name ? index.byName[name] : null;
  return byName ? [byName] : [];
}

// 安全/结构发现行的收集：安全按 (path, rule, line) 去重（REQ-SK-03 第 3 条
// 的去重键；同一 SKILL.md 装在两个执行环境只有一条），结构取 SV105/SV902 的
// 每个 path。cited 只改排序（同严重度内沉底）+ 挂「疑似引用语境」标签，
// 不降级、不隐藏（CLAUDE.md「Security heuristics sort, they never acquit」）。
function skSecurityRows(payload) {
  const index = skIndexByPathAndName(payload.report);
  const sevRank = { critical: 0, high: 1, medium: 2, low: 3, none: 9 };
  const rows = [];
  const seen = {};
  (payload.diagnostics || []).forEach((d) => {
    if (!d.code.startsWith("SV5")) return;
    ((d.evidence || {}).hits || []).forEach((h) => {
      const key = [h.path, h.rule, h.line].join("\u0000");
      if (seen[key]) return;
      seen[key] = true;
      rows.push({
        kind: "security",
        path: h.path, rule: h.rule, line: h.line,
        severity: h.severity, cited: !!h.cited,
        harnesses: skHarnessesFor(index, h.path, h.skill),
        rank: sevRank[h.severity] != null ? sevRank[h.severity] : 9,
      });
    });
  });
  // cited 的命中排同严重度末尾：先按严重度，再按 cited，再按路径稳定。
  rows.sort((a, b) => a.rank - b.rank || (a.cited - b.cited)
    || String(a.path).localeCompare(String(b.path)));
  return rows;
}

function skStructureRows(payload) {
  const index = skIndexByPathAndName(payload.report);
  const rows = [];
  const seen = {};
  (payload.diagnostics || []).forEach((d) => {
    if (d.code !== "SV105" && d.code !== "SV902") return;
    ((d.evidence || {}).skills || []).forEach((s) => {
      const key = s.path || s.name;
      if (seen[key]) return;
      seen[key] = true;
      rows.push({
        kind: "structure",
        code: d.code,
        path: key,
        harnesses: skHarnessesFor(index, s.path, s.name),
      });
    });
  });
  return rows;
}

// 页头白名单合计（REQ-SK-03 穷举，新增合计项要先改规格再改这里）：
// 1) 已扫描 / 未检测到的执行环境数；2) 去重 skill 目录数（规范化 path）；
// 3) 安全发现按严重度（含 cited 计数）；4) 结构问题数。
// 纯函数：vm 测试拿它与安全分区行数比对（§11.2「页头安全合计 = 行数」）。
function skillHealthTotals(payload) {
  const hs = (payload.report && payload.report.harness_summaries) || {};
  const scanned = [], missing = [];
  SK_HARNESS_ORDER.forEach((h) => {
    ((hs[h] || {}).skills_on_disk > 0 ? scanned : missing).push(h);
  });
  const dirs = {};
  ((payload.report && payload.report.skills) || []).forEach((s) => {
    const p = String(s.path || s.name || "");
    dirs[p.replace(/\/+$/, "")] = true;
  });
  const rows = skSecurityRows(payload);
  const structure = skStructureRows(payload);
  const sevRank = { critical: 0, high: 1, medium: 2, low: 3, none: 9 };
  const worst = rows.reduce((acc, r) => Math.min(acc, r.rank), 9);
  const severityText = worst === 0 ? "critical"
    : worst === 1 || worst === 2 ? "warning" : "none";
  return {
    scannedHarnesses: scanned,
    missingHarnesses: missing,
    dirCount: Object.keys(dirs).length,
    securityRowCount: rows.length,
    securityCited: rows.filter((r) => r.cited).length,
    securitySeverity: severityText,
    securitySeverityRank: worst,
    structureCount: structure.length,
  };
}

function skSeverityChip(sev) {
  const cls = sev === "critical" || sev === "high" ? "sev critical"
    : sev === "warning" || sev === "medium" ? "sev warning" : "sev";
  return skEl("span", cls, sev);
}

// 一条诊断行：码 + 人话 + 执行环境芯片 / 影响 / 行动 / caveat（spec §6.2）。
// caveat 逐条原样渲染、不折叠不改写（§5.4）。
function skDiagRow(d, harnesses, extraEvidence) {
  const row = skEl("div", "sk-row");
  const head = skEl("div", "sk-row-head");
  const code = skEl("span", "sk-code " + d.severity, d.code);
  head.append(code);
  head.append(skEl("span", "sk-row-impact", SK_CODE_ZH[d.code] || d.name || ""));
  (harnesses || []).forEach((h) => head.append(skHarnessChip(h)));
  row.append(head);
  if (d.impact) row.append(skEl("div", "sk-row-line", d.impact));
  const action = skEl("div", "sk-row-line");
  if (skNeedsJudgement(d.code)) {
    action.append(skEl("span", "sk-judgement", "→ " + SK_NEED_JUDGEMENT));
  } else if (d.recommendation) {
    action.textContent = "→ 行动：" + d.recommendation;
  }
  row.append(action);
  if (extraEvidence) row.append(extraEvidence);
  (d.caveats || []).forEach((c) => {
    row.append(skEl("div", "sk-row-caveat", "! " + c));
  });
  return row;
}

// hasRows=true → 隐藏「没有…」占位。参数按行数语义命名（此前按 isEmpty 传入
// 却当 hasRows 用，四个分区的占位显隐整体反了 —— 2026-09-19 真机截图回归）。
function skEmptyToggle(id, hasRows) {
  const el = document.getElementById(id);
  if (el) el.hidden = !!hasRows;
}

// 主渲染入口。payload = skills_doctor_report 的返回（doctor --json 载荷 +
// desktop_meta）；harnessFilter = "all" | 执行环境 id。纯 DOM 组装，不取数、不计算
// 载荷之外的任何量。
function renderSkillHealth(payload, harnessFilter) {
  const meta = payload.desktop_meta || {};
  const report = payload.report || {};
  const index = skIndexByPathAndName(report);

  // ── 页头：扫描时间 · run · 过期标记；复现命令（含 --harness 与 run）─────
  const scanMeta = document.getElementById("sk-scan-meta");
  scanMeta.textContent = "";
  if (meta.generated_at_ms) {
    const dt = new Date(meta.generated_at_ms);
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    const ageH = (Date.now() - meta.generated_at_ms) / 3600000;
    scanMeta.textContent = "扫描于 " + hh + ":" + mm
      + (payload.run ? " · run " + payload.run : "")
      + (ageH > 24 ? " · 可能过期" : "");
  }
  const repro = document.getElementById("sk-repro");
  repro.textContent = "在终端复现：agent-vitals doctor --harness "
    + (harnessFilter || "all") + (payload.run ? "（run " + payload.run + "）" : "");

  // ── 执行环境选择器灰显：未检测到的执行环境注明「未检测到」，不隐藏（§4.2）──
  const harnessSel = document.getElementById("sk-harness");
  const totals = skillHealthTotals(payload);
  Array.from(harnessSel.options).forEach((opt) => {
    if (opt.value === "all") return;
    const missing = totals.missingHarnesses.includes(opt.value);
    opt.disabled = missing;
    opt.textContent = (SK_HARNESS_DISPLAY[opt.value] || opt.value)
      + (missing ? "（未检测到）" : "");
  });

  // ── 页头合计（REQ-SK-03 白名单四类；单执行环境视图整行隐藏，REQ-SK-04）──
  const totalsEl = document.getElementById("sk-totals");
  totalsEl.textContent = "";
  totalsEl.hidden = harnessFilter !== "all";
  if (harnessFilter === "all") {
    const parts = [];
    parts.push("已扫描 " + totals.scannedHarnesses.length + " 个执行环境"
      + (totals.missingHarnesses.length
        ? "（" + totals.missingHarnesses.map((h) => SK_HARNESS_DISPLAY[h] || h).join("、") + " 未检测到）"
        : ""));
    parts.push(totals.dirCount + " 个 skill 目录");
    if (totals.securityRowCount > 0) {
      parts.push("安全 " + totals.securityRowCount + " 条（含引用语境 "
        + totals.securityCited + "）");
    } else {
      parts.push("安全 0 条");
    }
    parts.push("结构 " + totals.structureCount);
    totalsEl.textContent = parts.join(" · ");
  }

  // ── 1. 执行环境摘要卡行（§6.1）────────────────────────────────────
  // 单执行环境视图（REQ-SK-04）只渲染该执行环境的卡 —— 其余执行环境不在本次扫描里，
  // 给它们画「无发现」就是编数。
  const cards = document.getElementById("sk-harness-cards");
  cards.textContent = "";
  SK_HARNESS_ORDER.forEach((h) => {
    if (harnessFilter !== "all" && h !== harnessFilter) return;
    const hs = (report.harness_summaries || {})[h];
    if (!hs) return;
    const detected = (hs.skills_on_disk || 0) > 0;
    const card = skEl("div", "sk-card");
    const head = skEl("div", "sk-card-head");
    head.append(skEl("span", "sk-card-title", SK_HARNESS_DISPLAY[h] || h));
    if (!detected) {
      head.append(skEl("span", "chip", "未检测到"));
      card.append(head);
      card.append(skEl("div", "sk-card-line muted", "扫描器找过了：本机没有 " + (SK_HARNESS_DISPLAY[h] || h) + " 的 skills 目录。"));
      cards.append(card);
      return;
    }
    card.append(head);
    // 预算条：分母来自该执行环境自己的 description_budget_detail；没有预算的
    // 执行环境不画条，写明原因（§5.4），dsh 追加逐条截断提示。
    const det = hs.description_budget_detail || {};
    if (det.available && det.budget_chars) {
      const pct = det.pct_used == null ? 0 : det.pct_used;
      const bar = skEl("div", "sk-budget-bar");
      const fill = skEl("div", "sk-budget-fill"
        + (pct >= 100 ? " over" : pct >= 85 ? " warn" : ""));
      fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
      bar.append(fill);
      const line = skEl("div", "sk-card-line");
      line.append(bar);
      line.append(skEl("span", "sk-card-line",
        skFmtNum(det.used_chars) + " / " + skFmtNum(det.budget_chars)
        + " 字符（" + pct + "%）"));
      line.append(skEl("span", "muted",
        "分母：" + (SK_BUDGET_SOURCE_TEXT[det.source] || det.source)));
      card.append(line);
    } else {
      const line = skEl("div", "sk-card-line muted",
        SK_NO_BUDGET_TEXT + (h === "dsh" ? "（逐条截断见 SV004）" : ""));
      card.append(line);
    }
    // 计数行：运行时核实为 null → 「—」（不冒充 0，§5.4）。
    const counts = skEl("div", "sk-card-line");
    counts.append(skEl("span", "sk-card-line",
      "已加载 " + (hs.unique_discoverable_skills || 0)
      + " · 磁盘 " + (hs.skills_on_disk || 0)));
    if (hs.runtime_verified_loaded_skills != null) {
      counts.append(skEl("span", "sk-card-line",
        " · 运行时核实 " + hs.runtime_verified_loaded_skills));
    } else {
      counts.append(skEl("span", "sk-card-line muted", " · 运行时核实 —"));
    }
    card.append(counts);
    // 该执行环境的 warning/critical 计数（§6.1 卡底 ⚠/✕，点击 = 切到该执行环境）。
    // 全部视图：按诊断的执行环境归属计数；单执行环境视图：载荷里全部诊断都属于
    // 该执行环境（扫描就是 --harness <h>）。
    let warn = 0, crit = 0;
    (payload.diagnostics || []).forEach((d) => {
      const mine = harnessFilter === "all" ? skDiagHarnesses(d, index).includes(h) : true;
      if (!mine) return;
      if (d.severity === "critical") crit += 1;
      else if (d.severity === "warning") warn += 1;
    });
    const sevLine = skEl("div", "sk-card-line");
    if (crit) sevLine.append(skEl("span", "sk-code critical", "✕ " + crit));
    if (warn) sevLine.append(skEl("span", "sk-code warning", (crit ? " · " : "") + "⚠ " + warn));
    if (!crit && !warn) sevLine.append(skEl("span", "muted", "无 critical / warning"));
    sevLine.dataset.harness = h;
    card.append(sevLine);
    cards.append(card);
  });

  // ── 2. 立即处理（critical + warning，CLI 已按 severity → 码排序）─────
  const actList = document.getElementById("sk-act-now-list");
  actList.textContent = "";
  const actDiags = (payload.diagnostics || []).filter((d) => d.severity === "critical" || d.severity === "warning");
  skEmptyToggle("sk-act-now-empty", actDiags.length > 0);
  actDiags.forEach((d) => {
    actList.append(skDiagRow(d, skDiagHarnesses(d, index)));
  });

  // ── 3. 安全与结构（§6.3）：行 = 去重发现；页头合计 = 行数 ────────────
  const secList = document.getElementById("sk-security-list");
  secList.textContent = "";
  const secRows = skSecurityRows(payload);
  const structRows = skStructureRows(payload);
  skEmptyToggle("sk-security-empty", secRows.length > 0 || structRows.length > 0);
  secRows.forEach((r) => {
    const row = skEl("div", "sk-row");
    const head = skEl("div", "sk-row-head");
    head.append(skSeverityChip(r.severity));
    head.append(skEl("span", "sk-row-impact", r.rule));
    if (r.cited) head.append(skEl("span", "tag", "疑似引用语境（仅排序，不免检）"));
    r.harnesses.forEach((h) => head.append(skHarnessChip(h)));
    row.append(head);
    row.append(skEl("div", "sk-row-line", r.path + (r.line ? ":" + r.line : "")));
    secList.append(row);
  });
  structRows.forEach((r) => {
    const row = skEl("div", "sk-row");
    const head = skEl("div", "sk-row-head");
    head.append(skEl("span", "sk-code warning", r.code));
    head.append(skEl("span", "sk-row-impact", SK_CODE_ZH[r.code] || "结构问题"));
    r.harnesses.forEach((h) => head.append(skHarnessChip(h)));
    row.append(head);
    row.append(skEl("div", "sk-row-line", r.path));
    secList.append(row);
  });

  // ── 4. 冲突与重叠（§6.4）：按执行环境分组，同执行环境内才成对 ────────────────
  const confList = document.getElementById("sk-conflicts-list");
  confList.textContent = "";
  const confByHarness = {};
  const confDiags = (payload.diagnostics || [])
    .filter((d) => ["SV101", "SV102", "SV103"].includes(d.code));
  confDiags.forEach((d) => {
    ((d.evidence || {}).conflicts || []).forEach((c) => {
      const h = c.harness || "unknown";
      (confByHarness[h] = confByHarness[h] || []).push({ kind: "conflict", c });
    });
  });
  (payload.diagnostics || []).forEach((d) => {
    if (d.code !== "SV401") return;
    ((d.evidence || {}).pairs || []).forEach((p) => {
      const h = p.domain || "unknown";
      (confByHarness[h] = confByHarness[h] || []).push({ kind: "pair", p });
    });
  });
  const confHarnesses = Object.keys(confByHarness);
  skEmptyToggle("sk-conflicts-empty", confHarnesses.length > 0);
  confHarnesses.forEach((h) => {
    confList.append(skEl("div", "sk-group-title", SK_HARNESS_DISPLAY[h] || h));
    confByHarness[h].forEach((item) => {
      if (item.kind === "conflict") {
        const c = item.c;
        const line = skEl("div", "sk-row-line sk-pair");
        const strong = skEl("strong", null, c.name + " 生效");
        line.append(strong);
        line.append(skEl("span", null, " ← " + (c.effective || {}).level + " · " + ((c.effective || {}).path || "")));
        (c.shadowed || []).forEach((sh) => {
          line.append(skEl("span", "muted", "；被遮蔽 " + sh.level + " · " + sh.path));
        });
        confList.append(line);
      } else {
        const p = item.p;
        const line = skEl("div", "sk-row-line sk-pair");
        line.textContent = p.a + " ↔ " + p.b
          + "（共享词：" + (p.shared || []).join("、") + " · Jaccard " + p.jaccard + "）";
        line.append(skEl("span", "sk-judgement", " 需你判断"));
        confList.append(line);
      }
    });
  });

  // ── 5. 使用证据（§6.5）：只对提供触发数据的执行环境列三列 ────────────────
  const usageList = document.getElementById("sk-usage-list");
  usageList.textContent = "";
  const trigBlock = report.trigger_data || {};
  const hsAll = report.harness_summaries || {};
  const triggerHarnesses = SK_HARNESS_ORDER.filter((h) => (
    (hsAll[h] || {}).skills_on_disk > 0 && (hsAll[h] || {}).trigger_data === "available"));
  skEmptyToggle("sk-usage-empty", triggerHarnesses.length > 0);
  triggerHarnesses.forEach((h) => {
    const group = skEl("div", "sk-group-title", SK_HARNESS_DISPLAY[h] || h);
    usageList.append(group);
    // 触发证据只在单执行环境扫描时进入载荷（全部视图的顶层 trigger_data 恒
    // 不可用 —— 那是「没采」，不是「没人用」，绝不冒充 0 条僵尸）。
    const isThisPayload = (payload.harness_selection === h);
    if (!isThisPayload) {
      usageList.append(skEl("div", "sk-row-line muted",
        "触发证据按执行环境扫描时才采集（全部视图不提供，不冒充 0）—— 选中该执行环境重新扫描可见。"));
      return;
    }
    const zombieDiag = (payload.diagnostics || []).find((d) => d.code === "SV201");
    const dormantDiag = (payload.diagnostics || []).find((d) => d.code === "SV202");
    const gate = (trigBlock || {}).zombie_min_age_days;
    const zombies = ((zombieDiag || {}).evidence || {}).skills || [];
    const tooNew = (trigBlock || {}).too_new_to_judge || [];
    const line = skEl("div", "sk-row-line");
    line.append(skEl("span", null, "零触发 " + zombies.length
      + " · 休眠 " + (((dormantDiag || {}).evidence || {}).count || 0)));
    if (tooNew.length) {
      // too-new 必须带「N 天后可判定」，不得落进僵尸（§6.5）。
      line.append(skEl("span", "muted", " · 太新不判 " + tooNew.length
        + (gate ? "（满 " + gate + " 天可判定）" : "")));
    }
    usageList.append(line);
  });
  if (triggerHarnesses.length === 0) {
    usageList.append(skEl("div", "sk-row-line muted", "此扫描没有可用的触发数据执行环境。"));
  }

  // ── 6. 本次未评估（§6.6）：原样列出，不得省略 ────────────────────────
  const naList = document.getElementById("sk-not-assessed-list");
  naList.textContent = "";
  (payload.not_assessed || []).forEach((n) => {
    const row = skEl("div", "sk-row-line");
    row.append(skEl("span", "sk-code info", n.code));
    row.append(skEl("span", null, " " + (SK_CODE_ZH[n.code] || n.name)));
    row.append(skEl("span", "muted", " —— " + n.reason));
    naList.append(row);
  });
}

// 扫描状态的 UI 切换（spec §7）。
function setSkillsScanningUI(scanning, hasData) {
  document.getElementById("sk-scanning").hidden = !scanning;
  document.getElementById("sk-rescan").hidden = scanning || !hasData;
  document.getElementById("sk-cancel").hidden = !scanning;
  document.getElementById("sk-start").disabled = scanning;
  if (hasData) {
    document.getElementById("sk-empty").hidden = true;
    document.getElementById("sk-snapshot").hidden = scanning;
    document.getElementById("sk-compare").hidden = scanning;
    document.getElementById("sk-export").hidden = scanning;
  }
}

function showSkillsError(message) {
  const el = document.getElementById("sk-error");
  el.textContent = "扫描失败：" + message;
  el.hidden = false;
}

// 取数 + 渲染。force=true（重新扫描按钮）绕过进程内缓存。
async function loadSkillsDoctor(force) {
  if (skState.scanning) return;
  skState.scanning = true;
  skState.error = false;
  document.getElementById("sk-error").hidden = true;
  setSkillsScanningUI(true, skState.loaded);
  try {
    const payload = await invoke("skills_doctor_report", {
      harness: skState.harness,
      force: !!force,
      selfRoot: skState.selfRoot || null,
      budget: skState.budget || null,
    });
    skState.data = payload;
    skState.loaded = true;
    skState.scanning = false;
    setSkillsScanningUI(false, true);
    renderSkillHealth(payload, skState.harness);
  } catch (e) {
    skState.scanning = false;
    skState.error = true;
    setSkillsScanningUI(false, skState.loaded);
    const msg = e && e.error && e.error.message ? e.error.message : String(e);
    showSkillsError(msg);
  }
}

// 与上次快照对比（spec §6.6 / §11.3 闭环）。diff 段只列新增项；「没有基线」
// 是前置条件缺失，原样报出来，不冒充「没有变化」。
async function compareSkillsSnapshot() {
  const box = document.getElementById("sk-diff-result");
  box.textContent = "";
  try {
    const diff = await invoke("skills_diff_latest");
    const wrap = skEl("div", "panel");
    wrap.append(skEl("div", "panel-title", "与上次快照的变化（只列新增）"));
    const added = diff.added_skills || [];
    const newSec = diff.new_security_findings || [];
    const newly = diff.newly_judgeable || [];
    const dropped = Number(diff.dropped_rows || 0);
    if (diff.status === "partial" || diff.truncated || dropped > 0) {
      wrap.append(skEl("div", "sk-row-line warning",
        "结果不完整：已丢弃 " + dropped + " 条或达到显示上限，不能据此判断没有变化。"));
    }
    if (!added.length && !newSec.length && !newly.length) {
      wrap.append(skEl("div", "sk-row-line muted", diff.status === "partial"
        ? "本次结果不完整，未显示新增项不等于没有变化。"
        : "相对上次快照没有新增的 skill 或安全命中（这不等于没有变化——其它维度见终端 diff）。"));
    }
    if (added.length) {
      wrap.append(skEl("div", "sk-group-title", "新增 skill " + added.length));
      added.forEach((a) => {
        const name = typeof a === "string" ? a : (a.name || JSON.stringify(a));
        wrap.append(skEl("div", "sk-row-line", "＋ " + name));
      });
    }
    if (newSec.length) {
      wrap.append(skEl("div", "sk-group-title", "新增安全命中 " + newSec.length));
      newSec.forEach((s) => wrap.append(skEl("div", "sk-row-line", "＋ " + (typeof s === "string" ? s : JSON.stringify(s)))));
    }
    if (newly.length) {
      wrap.append(skEl("div", "sk-group-title", "跨过年龄闸、首次可判定 " + newly.length));
    }
    box.append(wrap);
  } catch (e) {
    const msg = e && e.error && e.error.message ? e.error.message : String(e);
    const wrap = skEl("div", "panel");
    wrap.append(skEl("div", "panel-title", "与上次快照对比"));
    wrap.append(skEl("div", "sk-row-line muted", "没有可比的基线：" + msg
      + "（没有基线 ≠ 没有变化——先「存为快照」，改动后再扫一次即可比较）"));
    box.append(wrap);
  }
}

// 设置页「统计与数据」的两项（self-root / 预算覆盖）：读后端设置落到
// skState 并回填输入框；selfRoot 透传 --self-root；budget 为空 = CLI 默认
// （tab 不自造阈值，覆盖只是高级透传，spec §9）。
async function loadSkillsSettings() {
  const s = await invoke("skills_scan_settings").catch(() => null);
  skState.selfRoot = (s && s.self_root) || "";
  skState.budget = (s && s.budget) || null;
  const selfEl = document.getElementById("sk-self-root");
  const budgetEl = document.getElementById("sk-budget-override");
  if (selfEl) selfEl.value = skState.selfRoot;
  if (budgetEl) budgetEl.value = skState.budget || "";
}

// 设置页两项的保存按钮：写后端 → 回执 → 若已扫过则提示重新扫描（参数变了
// 缓存键也变，下次扫描自动生效，不静默重扫）。
function wireSkillsSettings() {
  const saveBtn = document.getElementById("sk-settings-save");
  if (!saveBtn) return;
  saveBtn.addEventListener("click", async () => {
    const status = document.getElementById("sk-settings-status");
    const selfRoot = (document.getElementById("sk-self-root") || {}).value || "";
    const budgetRaw = (document.getElementById("sk-budget-override") || {}).value || "";
    const budget = budgetRaw ? Number(budgetRaw) : null;
    try {
      await invoke("save_skills_scan_settings", {
        selfRoot: selfRoot.trim(),
        budget: budget != null && Number.isFinite(budget) ? Math.trunc(budget) : null,
      });
      skState.selfRoot = selfRoot.trim();
      skState.budget = budget != null && Number.isFinite(budget) ? Math.trunc(budget) : null;
      if (status) {
        status.textContent = "已保存" + (skState.loaded ? " · 重新扫描后生效" : "");
        status.hidden = false;
      }
    } catch (e) {
      if (status) {
        status.textContent = "保存失败：" + (e && e.error && e.error.message ? e.error.message : String(e));
        status.hidden = false;
      }
    }
  });
}

// 事件绑定（init 时调用一次；元素都在 DOMContentLoaded 之后存在）。
// tab 首进、尚未扫描：显示「开始扫描」引导，不自动跑（spec §7）。
function showSkillsIntro() {
  document.getElementById("sk-empty").hidden = false;
  document.getElementById("sk-rescan").hidden = true;
  document.getElementById("sk-snapshot").hidden = true;
  document.getElementById("sk-compare").hidden = true;
  document.getElementById("sk-export").hidden = true;
  document.getElementById("sk-scanning").hidden = true;
}

function initSkillsTab() {
  wireSkillsSettings();
  loadSkillsSettings();
  document.getElementById("sk-start").addEventListener("click", () => loadSkillsDoctor(true));
  document.getElementById("sk-rescan").addEventListener("click", () => loadSkillsDoctor(true));
  document.getElementById("sk-cancel").addEventListener("click", async () => {
    await invoke("skills_scan_cancel").catch(() => null);
  });
  document.getElementById("sk-harness").addEventListener("change", (ev) => {
    skState.harness = ev.target.value || "all";
    if (skState.loaded || skState.data) loadSkillsDoctor();
  });
  document.getElementById("sk-snapshot").addEventListener("click", async () => {
    const btn = document.getElementById("sk-snapshot");
    btn.disabled = true;
    try {
      await invoke("skills_snapshot_save");
      const receipt = document.getElementById("sk-receipt");
      receipt.textContent = "已存 · 下次扫描会显示变化";
      receipt.hidden = false;
    } catch (e) {
      showSkillsError("存快照失败：" + (e && e.error && e.error.message ? e.error.message : String(e)));
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById("sk-compare").addEventListener("click", compareSkillsSnapshot);
  document.getElementById("sk-export").addEventListener("click", async () => {
    const pick = await invoke("skills_export_pick_path").catch(() => null);
    if (!pick || pick.status !== "picked") return;
    try {
      await invoke("skills_export_redacted", { path: pick.path, selfRoot: skState.selfRoot || null });
      const receipt = document.getElementById("sk-receipt");
      receipt.textContent = "已导出（脱敏）：" + pick.path + "（不会自动上传）";
      receipt.hidden = false;
    } catch (e) {
      showSkillsError("导出失败：" + (e && e.error && e.error.message ? e.error.message : String(e)));
    }
  });
}

document.addEventListener("DOMContentLoaded", init);


// ── 「测试」tab v2（2026-09-20 转向）─────────────────────────────────────
// 默认面 = 被动路线质量报告（执行环境 × 实际模型族，来自已入库 usage_facts 的
// 硬证据——模型串是协议响应原样，anthropic 官方不可能返回 deepseek/glm），
// 不发任何探针请求。主动 L0 探针收进「高级」折叠区：隔离在 cc-switch 型
// 机器上不成立（settings.json env 压制进程注入，spec §0 addendum）。
// 渲染全部 DOM 构建 + textContent（安全纪律，复审 F1）：模型串/摘要字段
// 来自执行环境日志与中转协议响应——正是本 tab 要防的对手，绝不 innerHTML
// 插值（CSP 为 null 的 webview 里注入即可 invoke 任意 IPC）。

const testState = { routes: [], ticket: null, polling: null };

async function loadTestTab() {
  loadQualityReport();
  loadCurrentRouteHint();
  // 高级区路线表每次进入都刷新（轻命令；consent 经 CLI 授予后不能停留在旧态）。
  const loaded = await invoke("probe_routes_list").catch(() => null);
  testState.routes = Array.isArray(loaded) ? loaded : [];
  renderTestRoutes();
  if (loaded === null) {
    showTestNotice("danger", "路线读取失败", "agent-vitals CLI 不可用？重进本页重试。");
  }
}

// ---------- 主动测试：当前路线（默认对象，spec §0 v1.2） ----------

async function loadCurrentRouteHint() {
  const hint = await invoke("probe_current_hint").catch(() => null);
  const label = document.getElementById("test-current-hint");
  const modelInput = document.getElementById("test-current-model");
  if (!hint) {
    label.textContent = "当前路线：读取失败（CLI 不可用？）";
    return;
  }
  const harness = (hint.base_url || "").replace(/^https?:\/\//, "").split("/")[0];
  label.textContent = `当前路线：${harness || "官方直连（无自定义端点）"}${hint.model ? ` · 默认模型 ${hint.model}` : ""}`;
  if (hint.model && !modelInput.value) modelInput.value = hint.model;
}

let currentTestArmed = false;

async function startCurrentTest() {
  const button = document.getElementById("test-current-btn");
  const statusBox = document.getElementById("test-current-status");
  // 两击布防：第一次点换成确认态（5 秒内有效）——测试花真金白银，知情后才发。
  if (!currentTestArmed) {
    currentTestArmed = true;
    button.textContent = "确认发起（1 条真实请求，按当前路线计费）";
    setTimeout(() => {
      currentTestArmed = false;
      button.textContent = "发起测试";
    }, 5000);
    return;
  }
  currentTestArmed = false;
  button.textContent = "发起测试";
  button.disabled = true;
  statusBox.hidden = false;
  const model = document.getElementById("test-current-model").value.trim() || null;
  const start = await invoke("probe_run_start", {
    routeA: "current", routeB: null, model, repeats: 1, maxProbes: 1,
  }).catch((error) => {
    statusBox.hidden = true;
    button.disabled = false;
    showTestNotice("danger", "启动失败", typeof error === "string" ? error : JSON.stringify(error));
    return null;
  });
  if (!start) return;
  testState.ticket = start.ticket;
  if (testState.polling) clearInterval(testState.polling);
  testState.polling = setInterval(async () => {
    const result = await invoke("probe_run_result", { ticket: testState.ticket }).catch(() => null);
    if (!result || result.state === "running") return;
    clearInterval(testState.polling);
    testState.polling = null;
    statusBox.hidden = true;
    button.disabled = false;
    if (result.state === "error") {
      showTestNotice("danger", "测试失败", result.message || "未知错误");
      return;
    }
    renderTestReport(result.report);
  }, 3000);
}

// ---------- 被动路线质量（默认面） ----------

const QUALITY_FAMILY_LABELS = {
  anthropic: "Claude 系",
  openai: "GPT 系",
  deepseek: "DeepSeek",
  glm: "GLM",
  minimax: "MiniMax",
  gemini: "Gemini",
  qwen: "Qwen",
  synthetic: "API 错误",
  unknown: "未识别",
};

function formatTokens(value) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatDays(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString();
}

async function loadQualityReport() {
  const days = Number(document.getElementById("test-quality-days").value) || 90;
  const loading = document.getElementById("test-quality-loading");
  const banner = document.getElementById("test-quality-banner");
  loading.hidden = false;
  banner.hidden = true;
  const report = await invoke("routes_quality", { days }).catch((error) => {
    loading.hidden = true;
    banner.replaceChildren(`路线质量汇总失败：${typeof error === "string" ? error : JSON.stringify(error)}`);
    banner.hidden = false;
    return null;
  });
  loading.hidden = true;
  if (!report) return;
  renderQualityReport(report, days);
}

function renderQualityReport(report, days) {
  const harnessesBox = document.getElementById("test-quality-harnesses");
  const summaryEl = document.getElementById("test-quality-summary");
  const foot = document.getElementById("test-quality-foot");
  harnessesBox.replaceChildren();
  const harnesses = Array.isArray(report.harnesses) ? report.harnesses : [];
  for (const harness of harnesses) {
    harnessesBox.append(buildHarnessQualityPanel(harness, days));
  }
  summaryEl.textContent = harnesses.length === 0
    ? "窗口内没有用量事实——先等一次同步"
    : `${harnesses.length} 个执行环境 · 按协议响应里的实际模型判定`;
  foot.replaceChildren("判定依据：模型串来自执行环境协议响应原样（非推断）。「非官方模型」= 该执行环境官方渠道不可能给出的模型族；「API 错误」= 请求失败时执行环境写入的本地占位（<synthetic>）。");
}

function buildHarnessQualityPanel(harness, days) {
  const panel = document.createElement("div");
  panel.className = "panel";
  const title = document.createElement("div");
  title.className = "panel-title";
  const titleText = document.createElement("span");
  titleText.textContent = `${harness.harness} · 近 ${days} 天 · ${harness.totals ? harness.totals.requests : 0} 请求 / ${harness.totals ? harness.totals.sessions : 0} 会话`;
  title.append(titleText);

  const families = Array.isArray(harness.families) ? harness.families : [];
  const nonNative = families.filter((f) => f.flag === "non_native");
  const apiErrors = families.find((f) => f.flag === "api_error");
  const nonNativeShare = nonNative.reduce((sum, f) => sum + (f.request_share || 0), 0);

  // 用户语言的结论行（notice 级别与总览通知同一套语义）。
  const notice = document.createElement("div");
  if (!harness.has_baseline) {
    notice.className = "notice";
    notice.append(buildNoticeText("该执行环境未登记官方模型基准", "只按模型族展示分布，不做「非官方」判定"));
  } else if (nonNative.length > 0) {
    const level = nonNativeShare >= 20 ? "danger" : "warn";
    notice.className = `notice ${level}`;
    const names = nonNative.map((f) => QUALITY_FAMILY_LABELS[f.family] || f.family).join(" / ");
    notice.append(buildNoticeText(
      `${nonNativeShare.toFixed(1)}% 的请求实际运行在非官方模型上（${names}）`,
      "依据：这些模型族不可能来自该执行环境的官方渠道——响应模型串是协议原样",
    ));
  } else {
    notice.className = "notice ok";
    notice.append(buildNoticeText("全部请求运行在官方模型族内", "身份面未见注水；行为面（降 effort 等）不在此覆盖"));
  }
  if (apiErrors && apiErrors.requests > 0) {
    const errorNotice = document.createElement("div");
    errorNotice.className = "notice warn";
    errorNotice.append(buildNoticeText(
      `${apiErrors.requests} 次请求失败（API 错误，涉及 ${apiErrors.sessions} 个会话）`,
      "执行环境在请求被拒/断流时写入的本地占位——常见为网关 402/断网",
    ));
    panel.append(title, notice, errorNotice);
  } else {
    panel.append(title, notice);
  }

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "sess-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["模型族", "判定", "请求占比", "请求", "会话", "tokens", "最近活跃", "实际模型"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  const body = document.createElement("tbody");
  const flagLabels = { native: "官方族", non_native: "非官方", api_error: "API 错误", no_baseline: "无基准" };
  for (const family of families) {
    const row = document.createElement("tr");
    const models = Array.isArray(family.models) ? family.models : [];
    const modelNames = models
      .slice()
      .sort((a, b) => (b.requests || 0) - (a.requests || 0))
      .slice(0, 3)
      .map((m) => m.model)
      .join("、");
    for (const value of [
      QUALITY_FAMILY_LABELS[family.family] || family.family,
      flagLabels[family.flag] || family.flag,
      `${family.request_share}%`,
      family.requests,
      family.sessions,
      formatTokens(family.tokens_total || 0),
      formatDays(family.last_event_ms),
      modelNames,
    ]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      row.appendChild(td);
    }
    body.appendChild(row);
  }
  table.append(head, body);
  wrap.append(table);
  panel.append(wrap);
  return panel;
}

function buildNoticeText(titleText, subText) {
  const text = document.createElement("div");
  text.className = "notice-text";
  const strong = document.createElement("strong");
  strong.textContent = titleText;
  const sub = document.createElement("div");
  sub.className = "notice-sub";
  sub.textContent = subText || "";
  text.append(strong, sub);
  return text;
}

function renderTestRoutes() {
  const selectA = document.getElementById("test-route-a");
  const selectB = document.getElementById("test-route-b");
  const hint = document.getElementById("test-hint");
  if (!selectA || !selectB) return;
  const optionFor = (route) => {
    const option = document.createElement("option");
    option.value = route.route_id;
    option.textContent = `${route.label} · ${route.model_requested}${route.consent_granted_at_ms ? "" : "（未授权）"}`;
    return option;
  };
  const emptyA = document.createElement("option");
  emptyA.value = "";
  emptyA.textContent = "（暂无路线）";
  const emptyB = document.createElement("option");
  emptyB.value = "";
  emptyB.textContent = "（单路体检）";
  selectA.replaceChildren(emptyA);
  selectB.replaceChildren(emptyB);
  for (const route of testState.routes) {
    selectA.append(optionFor(route));
    selectB.append(optionFor(route));
  }
  if (testState.routes.length > 0) selectA.value = testState.routes[0].route_id;
  updateTestRunButton();
  const unconsented = testState.routes.filter((route) => !route.consent_granted_at_ms);
  hint.textContent = testState.routes.length === 0
    ? "还没有路线档案：扫描 cc-switch 一键注册 —— agent-vitals probe routes-add --from-cc-switch（官方直连另用 --label 官方直连 --model claude-sonnet-5）"
    : unconsented.length > 0
      ? `未授权路线不能发起测试：agent-vitals probe consent --route-id ${unconsented[0].route_id}`
      : "L0 单次约 10–60 秒、一条 1 轮 echo 请求（订阅内成本≈0）。";
}

function updateTestRunButton() {
  const button = document.getElementById("test-run-btn");
  if (!button) return;
  const route = testState.routes.find((r) => r.route_id === document.getElementById("test-route-a").value);
  // 没有路线 / 选中路线未授权 / 正在跑：三种状态都不给点，出错走横幅，不用 alert。
  button.disabled = !route || !route.consent_granted_at_ms || testState.polling !== null;
}

function showTestNotice(level, title, sub) {
  const el = document.getElementById("test-banner");
  if (!el) return;
  const icon = document.createElement("span");
  icon.className = "notice-icon";
  icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("div");
  text.className = "notice-text";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const subDiv = document.createElement("div");
  subDiv.className = "notice-sub";
  subDiv.textContent = sub || "";
  text.append(strong, subDiv);
  el.replaceChildren(icon, text);
  el.className = "notice " + level;
  el.hidden = false;
}

async function startTestRun() {
  const routeA = document.getElementById("test-route-a").value;
  if (!routeA) return;
  const routeB = document.getElementById("test-route-b").value || null;
  const repeats = Number(document.getElementById("test-repeats").value) || 1;
  const maxProbes = Math.max(repeats * (routeB ? 2 : 1), 1);
  const statusBox = document.getElementById("test-run-status");
  const button = document.getElementById("test-run-btn");
  button.disabled = true;
  statusBox.hidden = false;
  const start = await invoke("probe_run_start", { routeA, routeB, repeats, maxProbes }).catch((error) => {
    statusBox.hidden = true;
    updateTestRunButton();
    showTestNotice("danger", "启动失败", typeof error === "string" ? error : JSON.stringify(error));
    return null;
  });
  if (!start) return;
  testState.ticket = start.ticket;
  if (testState.polling) clearInterval(testState.polling);
  testState.polling = setInterval(async () => {
    const result = await invoke("probe_run_result", { ticket: testState.ticket }).catch(() => null);
    if (!result || result.state === "running") return;
    clearInterval(testState.polling);
    testState.polling = null;
    statusBox.hidden = true;
    updateTestRunButton();
    if (result.state === "error") {
      showTestNotice("danger", "探针失败", result.message || "未知错误");
      return;
    }
    renderTestReport(result.report);
  }, 3000);
}

function renderTestReport(report) {
  const panel = document.getElementById("test-report-panel");
  if (!panel || !report || !report.run) return;
  // 判定 → notice 级别：确认不符红边 / 疑似·混杂琥珀边 / 无信号灰字 /
  // 证据不足中性框——与总览通知同一套语义，用户不必重新学。
  const verdictLabels = {
    confirmed_mismatch: ["danger", "确认不符", "协议级硬证据：resolved 与 requested 不符"],
    suspected_degradation: ["warn", "疑似降级", "行为统计显著，但缺身份证据"],
    no_signal: ["ok", "无信号", "身份一致；不排除行为面注水（需 L1）"],
    underpowered: ["", "证据不足", "重复次数不够，不足以下结论"],
    inconclusive_confounded: ["warn", "混杂未排除", "网络/时段/缓存差异未定"],
  };
  const [level, title, note] = verdictLabels[report.verdict ? report.verdict.verdict : "underpowered"] || ["", "—", ""];
  // 有探针没拿到真实响应（如中转 402 被 claude 吞成合成错误）时，no_signal 的
  // 「身份一致」文案会误导——追加提示把视线引到明细表的 outcome 列。
  const anyFailed = (report.results || []).some((r) => r.outcome !== "pass");
  const noteWithFailures = anyFailed ? `${note}（有探针未成功，见明细表 outcome）` : note;
  const notice = document.createElement("div");
  notice.className = "notice " + level;
  const icon = document.createElement("span");
  icon.className = "notice-icon";
  icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("div");
  text.className = "notice-text";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const sub = document.createElement("div");
  sub.className = "notice-sub";
  sub.textContent = noteWithFailures;
  text.append(strong, sub);
  notice.append(icon, text);
  document.getElementById("test-report-verdict").replaceChildren(notice);

  const body = document.getElementById("test-report-body");
  const routeLabel = (id) => {
    if (id === "current-claude-code") return "当前配置";
    const route = testState.routes.find((r) => r.route_id === id);
    return route ? route.label : id;
  };
  body.replaceChildren();
  for (const result of report.results || []) {
    const row = document.createElement("tr");
    for (const value of [
      routeLabel(result.route_id), result.repeat_idx, result.outcome,
      result.requested_model, result.resolved_model ?? "—",
      `${result.uncached_input_tokens ?? "—"}/${result.cache_read_tokens ?? "—"}/${result.cache_write_tokens ?? "—"}/${result.output_tokens ?? "—"}`,
    ]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      row.appendChild(td);
    }
    body.appendChild(row);
  }

  document.getElementById("test-report-meta").textContent =
    `规则 ${report.verdict ? report.verdict.rule_version : "—"} · run ${report.run.run_id}`;
  const foot = document.getElementById("test-report-foot");
  const code = document.createElement("code");
  code.textContent = `agent-vitals probe report --run-id ${report.run.run_id}`;
  foot.replaceChildren("完整证据链：", code);
  panel.hidden = false;
}

// 绑定与 init 同款挂 DOMContentLoaded（顶层直绑会让 KPI 校验脚本的 DOM
// stub 在模块求值期就撞 addEventListener——repo 的 vm 校验路径依赖这一约定）。
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("test-run-btn").addEventListener("click", startTestRun);
  document.getElementById("test-route-a").addEventListener("change", updateTestRunButton);
  document.getElementById("test-current-btn").addEventListener("click", startCurrentTest);
  document.getElementById("test-quality-reload").addEventListener("click", () => loadQualityReport());
  document.getElementById("test-quality-days").addEventListener("change", () => loadQualityReport());
});
