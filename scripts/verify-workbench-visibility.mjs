// 总览「可见性守卫」（docs/v1.0.0/BETA_1_OVERVIEW_IA_REVIEW.md §6 I5）。
//
// 根因：verify-workbench-kpi-decide.mjs 用 node:vm + 假 document 跑真实 workbench.js，
// 断言的是 textContent，对 CSS `display:none` 完全免疫——预算卡的诚实性断言一直
// 打印 ok，而用户根本看不到那张卡（workbench.css 曾有
// `.month-band .secondary-metric{display:none}`）。这条守卫跑**真实 DOM**：
// 无头 Chrome 打开 vite serve 的 workbench.html（tauri-mock.js 提供数据），
// 对渲染器写过的每个必须可见的 id 断言它真的在布局里。
//
// 运行前提：vite 在 127.0.0.1:4178（`npm run dev -- --port 4178`，apps/desktop/ui-dev）
// + 本机有 Chrome。任一缺失 → 打印 skipped 并以 0 退出（CI 没装 Chrome 时不假红）。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const URL_ = process.env.WB_URL || "http://127.0.0.1:4178/workbench.html";
const CHROME = process.env.CHROME_BIN ||
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    .find((p) => existsSync(p));

async function reachable(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
if (!CHROME || !(await reachable(URL_))) {
  console.log(`skipped: ${!CHROME ? "no Chrome" : "vite not reachable at " + URL_}`);
  process.exit(0);
}

// 无头 Chrome 只能 --dump-dom；可见性用两层判定：
//  1. DOM 面：元素存在、自身与祖先都没有 hidden 属性、不在未 open 的 <details> 里；
//  2. CSS 面：workbench.css 里不存在命中这些 id / 其静态 class 的 `display: none` 规则
//     （静态解析，反向堵住「JS 写了、CSS 藏了」）。
const dom = execFileSync(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=6000", "--dump-dom", URL_,
], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok  " : "FAIL  ") + msg); if (!cond) failed += 1; };

// 最小 DOM 解析：只关心 id、hidden、<details open>、class。用栈重放标签。
function analyze(html) {
  const info = new Map(); // id -> { hiddenChain, inClosedDetails, classes }
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  const voids = new Set(["br","hr","img","input","meta","link","source","track","wbr","area","base","col","embed","param"]);
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, attrs, selfClose] = m;
    if (close) { for (let i = stack.length - 1; i >= 0; i--) { if (stack[i].tag === tag) { stack.length = i; break; } } continue; }
    const id = (attrs.match(/\sid="([^"]+)"/) || [])[1];
    const hidden = /\shidden(?:=|\s|$)/.test(attrs);
    const isDetails = tag === "details";
    const open = /\sopen(?:=|\s|$)/.test(attrs);
    const classes = ((attrs.match(/\sclass="([^"]*)"/) || [])[1] || "").split(/\s+/).filter(Boolean);
    const node = { tag, hidden, closedDetails: isDetails && !open };
    const chainHidden = hidden || stack.some((n) => n.hidden);
    const inClosed = stack.some((n) => n.closedDetails);
    if (id) info.set(id, { chainHidden, inClosed, classes });
    if (!voids.has(tag) && !selfClose) stack.push(node);
  }
  return info;
}
const info = analyze(dom.slice(dom.indexOf('id="tab-overview"')));

// 必须可见清单（mock 数据下）。新增首屏 KPI 时同步登记。
const MUST_VISIBLE = [
  "ov-sync-status", "ov-sources-brief",
  "ov-decide-card", "ov-decide-body",
  "ov-trust-rows", "ov-trust-route", "ov-trust-price",
  "ov-billing-prompt",
  "ov-kpi-row", "ov-m-metered", "ov-m-subscription", "ov-m-nominal",
  "ov-t-tokens", "ov-t-metered", "ov-t-nominal",
  "ov-budget-card", "ov-budget-amount", "ov-budget-sub",
  "ov-usage-strip", "ov-m-tokens",
  "ov-dual-list", "ov-days-list",
];
console.log("# DOM 面：元素存在且不在 hidden / 未展开 details 之下");
for (const id of MUST_VISIBLE) {
  const n = info.get(id);
  ok(!!n, `#${id} 存在`);
  if (!n) continue;
  ok(!n.chainHidden, `#${id} 自身与祖先无 hidden`);
  ok(!n.inClosed, `#${id} 不在未展开的 <details> 里`);
}

console.log("# 顺序与文案（mock：health=warn, unresolved=18K, budget=warn）");
const ov = dom.slice(dom.indexOf('id="tab-overview"'), dom.indexOf('id="tab-calendar"'));
// 只看用户可见文本：去掉 HTML 注释与标签（属性里的 title hover 是 reason code 的合法落点）。
const ovText = ov.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ");
const order = ["ov-kpi-row", "ov-decide-card", "ov-usage-strip", "ov-trust-rows", "ov-billing-prompt", "ov-dual-list", "ov-days-list"].map((id) => ov.indexOf('id="' + id + '"'));
ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), "首屏顺序：三卡 → 现在该用谁 → 本月用量 → 可信度 → 套餐提示 → 费用明细 → 最近几天（不再折叠）");
ok(/id="ov-trust-route"[^>]*class="notice warn"|class="notice warn"[^>]*id="ov-trust-route"/.test(ov), "路由行 class = warn（颜色来自 health）");
ok(!/id="ov-trust-rows"[^>]*compact/.test(ov), "有非 ok 行时可信度不收敛为 compact");
ok(ovText.includes("明确计费方式") && ovText.includes("计费方式待确认"), "同源 18K：⚠ 行指向唯一的计费方式待办");
ok((ov.match(/<button(?![^>]*\shidden)[^>]*class="(?=[^"]*\bbtn\b)(?=[^"]*\bprimary\b)[^"]*"/g) || []).length === 1, "全页只有一个可见的实心主按钮（确认套餐信息）");
// 第三档 CTA：每张卡 / 模块一个安静的入口（预算已配置 → 调整预算；未配置 → 用量行的 设置预算）。
for (const id of ["ov-link-spend", "ov-link-today", "ov-link-budget", "ov-link-plans", "ov-link-usage", "ov-link-billing", "ov-link-days"]) {
  ok(!!info.get(id) && !info.get(id).chainHidden, `卡片入口 #${id} 可见`);
}
ok(info.get("ov-link-set-budget")?.chainHidden === true, "预算已配置时「设置预算」入口隐藏（与预算卡互斥）");
ok(ovText.includes("未填写月费，去填写"), "费用明细里「未填写月费」带去填写入口");
ok(!dom.includes("可计价"), "「N% 可计价」写法已从页面消失");
ok(!/本月实付[^<]*含订阅月费/.test(dom), "「本月实付 …（含订阅月费 …）」跨币句式已消失");
ok(!/未定 provider|路由与缺价|未计价 token|仅撞窗史|已付费产能|套餐等价|metered-bill|official-price-card|fair-market/.test(ovText),
  "总览可见文本不出现内部词表 / raw reason code");
ok(/OpenAI[^\n]*经 Codex/.test(ovText) && /DeepSeek[^\n]*经 DeepSeek Harness/.test(ovText), "费用明细行名 = 服务商，执行环境为「经 X」副属性");
// 预算分子与本月按量实付是同一个数（跨执行环境按量实付 CNY）——两卡不得打架。
const metered = (ov.match(/id="ov-m-metered"[^>]*>([^<]*)</) || [])[1] || "";
const budgetAmt = (ov.match(/id="ov-budget-amount"[^>]*>([^<]*)</) || [])[1] || "";
ok(metered && budgetAmt.startsWith(metered + " /"), `预算已用 == 本月按量实付（${budgetAmt} vs ${metered}）`);

console.log("# CSS 面：不存在命中必须可见元素的 display:none 规则");
const css = readFileSync(new URL("../apps/desktop/src-tauri/ui/workbench.css", import.meta.url), "utf8");
const displayNoneSelectors = [];
for (const m2 of css.matchAll(/([^{}]+)\{[^{}]*display\s*:\s*none[^{}]*\}/g)) {
  displayNoneSelectors.push(m2[1].trim().replace(/\s+/g, " "));
}
const staticClasses = new Set(["stat","spend-card","today-card","budget","cards","month-band","usage-strip","trust-rows","trust-row","panel","decide","notice","notice-list","overview-topline","overview-scope"]);
for (const sel of displayNoneSelectors) {
  const hitsId = MUST_VISIBLE.some((id) => sel.includes("#" + id));
  const hitsClass = [...staticClasses].some((c) => new RegExp("\\." + c + "(?![\\w-])").test(sel) && !sel.includes(":empty") && !sel.includes("[hidden]"));
  ok(!hitsId && !hitsClass, `display:none 规则「${sel}」不命中首屏必须可见的 id/class`);
}

if (failed) { console.error("\n" + failed + " 项断言失败"); process.exit(1); }
console.log("\n通过。");
