#!/usr/bin/env node
// Skill 体检 tab 验收（docs/v1.0.0/WORKBENCH_SKILL_HEALTH_TAB_SPEC.md §11）。
//
// 与 verify-workbench-kpi-decide.mjs 同一模式：静态断言打在真实文件上，
// 行为断言跑在 vm 执行的真实 workbench.js 上。差异在 fixture 的来源 ——
// **规格 §5.1「形状来源纪律」**：载荷不是手写的期望形状，而是每次验证时
// 用真实 CLI（`agent-vitals doctor --harness <h> --json - --with-report
// --no-snapshot`，跑在本目录 build_fixture.py 展开的 HOME 语料上）现场
// 捕获。语料 → 断言对照见 fixtures/skills-tab/build_fixture.py 文件头。
//
// 退出码契约由 Rust 侧 store.rs::doctor_exit_error 的单测钉住（0/1 都不是
// 错误；2 起带 stderr 首行进错误 notice），这里通过 invoke reject 模拟
// exit 2 的前端行为。

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
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
const css = readFileSync(`${root}/apps/desktop/src-tauri/ui/workbench.css`, "utf8");

// ── §11.1 结构守卫（静态断言） ────────────────────────────────────────────
console.log("# §11.1 结构守卫（真实文件）");
ok(html.includes('data-tab="skills"'), "tab 条含 data-tab=\"skills\"");
for (const id of ["sk-harness-cards", "sk-act-now", "sk-security", "sk-conflicts", "sk-usage", "sk-not-assessed"]) {
  ok(html.includes(`id="${id}"`), `#tab-skills 含分区 ${id}`);
}
{
  // 页头合计区（#sk-totals）的模板文本不得含六个词（REQ-SK-01 的字面守卫）。
  const totalsStart = html.indexOf('id="sk-totals"');
  ok(totalsStart >= 0, "#sk-totals 存在");
  const seg = html.slice(totalsStart, html.indexOf("</div>", totalsStart));
  for (const word of ["预算", "Tier1", "tokens", "冲突", "重叠", "僵尸"]) {
    ok(!seg.includes(word), `#sk-totals 模板不含「${word}」`);
  }
}
{
  // Skill 分区里不存在任何 禁用/删除 按钮（SKILL.md §5 第一条）。
  const skStart = html.indexOf('id="tab-skills"');
  // 分区顺序会随 tab 演进变化（测试 tab 现排在 Skill 与 设置 之间）——
  // 边界取 Skill 分区之后的下一个 section，而不是硬编码 tab-sources。
  const skEnd = html.indexOf('section id="tab-', skStart + 1);
  const seg = html.slice(skStart, skEnd);
  for (const word of ["禁用", "删除", "disable", "delete"]) {
    ok(!seg.toLowerCase().includes(word), `Skill 分区不含「${word}」按钮/字样`);
  }
}
ok(css.includes(".sk-cards") && css.includes(".sk-budget-fill"),
  "CSS 带执行环境卡与预算条样式");
// 托盘入口：tab_for_menu_id 把 skill_health 映射到 skills tab（lib.rs 单测同款）。
ok(wb.includes('activeTab === "skills"'), "loadActiveTab 认识 skills tab（懒加载分支）");
ok(wb.includes("首次进不自动扫") || wb.includes("不自动跑"),
  "首进 tab 不自动扫描（spec §7：codex app-server 拉起是秒级开销）");
ok(wb.includes('diff.status === "partial"') && wb.includes("结果不完整") && wb.includes("不能据此判断没有变化"),
  "快照 diff 的 partial/truncated 结果显式提示不可据此判断没有变化");

// ── 真实 CLI 捕获 fixture（spec §5.1 形状来源纪律）────────────────────────
console.log("# fixture：真实 CLI 输出捕获");
const tmpHome = mkdtempSync(path.join("/tmp", "skfx-"));
execFileSync("python3", [`${root}/fixtures/skills-tab/build_fixture.py`, "--into", tmpHome, "--clean"],
  { stdio: "pipe" });

function resolveCli() {
  if (process.env.AGENT_VITALS_BIN) return [process.env.AGENT_VITALS_BIN];
  const candidate = path.join(root, "target", "release", "agent-vitals");
  try {
    execFileSync(candidate, ["--version"], { stdio: "pipe" });
    return [candidate];
  } catch {
    return ["python3", `${root}/scripts/scan.py`];
  }
}
const cli = resolveCli();
function doctorPayload(harness) {
  const out = execFileSync(cli[0], [...cli.slice(1), "doctor", "--harness", harness,
    "--json", "-", "--with-report", "--no-snapshot"], {
    cwd: tmpHome,
    env: { ...process.env, HOME: tmpHome, SLASH_COMMAND_TOOL_CHAR_BUDGET: "15000",
      AGENT_VITALS_DISABLE_CODEX_RUNTIME: "1", AGENT_VITALS_DISABLE_OPENCLAW_RUNTIME: "1",
      AGENT_VITALS_DISABLE_WORKBUDDY_BUILTINS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
  return JSON.parse(out);
}
let payloadAll;
let payloadClaude;
try {
  payloadAll = doctorPayload("all");
  payloadClaude = doctorPayload("claude-code");
} finally {
  // 语料只在这两个载荷里用；留到脚本结束再删，便于失败时现场排查。
}
const metaNote = `fixture 实现来源: ${path.relative(root, cli[0])} · HOME=${tmpHome}`;
ok(payloadAll.report && payloadAll.diagnostics, "doctor --with-report 载荷带 diagnostics + report（" + metaNote + "）");
ok(payloadAll.report.harness_summaries["dsh"], "harness_summaries 带 dsh 家族（P0-3）");
ok(payloadAll.report.harness_summaries["claude-code"].description_budget_detail.available === true,
  "claude-code 带逐执行环境预算明细（P0-3 description_budget_detail）");

// ── vm 执行真实 workbench.js ─────────────────────────────────────────────
function makeElement(tag) {
  const classes = new Set();
  const children = [];
  let _text = "";
  return {
    tag: tag || "div",
    // 浏览器语义：textContent 赋值会**替换整个子树**。渲染器每轮先
    // `el.textContent = ""` 清空再重画 —— stub 必须同样清空 children，
    // 否则跨多轮渲染的断言读到的都是累积的旧 DOM。
    get textContent() { return _text; },
    set textContent(v) { _text = String(v); children.length = 0; },
    hidden: false, style: {}, dataset: {},
    title: "", className: "", options: [], children,
    append(...nodes) { children.push(...nodes); },
    appendChild(node) { children.push(node); },
    setAttribute() {},
    addEventListener() {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => (force === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : force ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
      [Symbol.iterator]: function* () { for (const c of classes) yield c; },
    },
  };
}
const elements = {};
const el = (id) => (elements[id] ??= makeElement());
const createdTags = [];
const sandbox = {
  sessionStorage: new Map(),
  window: {
    __TAURI__: {
      core: { invoke: async (cmd, args) => {
        if (cmd === "skills_doctor_report") {
          const next = sandbox.__nextDoctor;
          if (next && next.reject) throw next.reject;
          return next && next.payload;
        }
        if (cmd === "skills_scan_settings") return sandbox.__skillsSettings || { self_root: "", budget: null };
        if (cmd === "read_overview") return sandbox.__overview;
        if (cmd === "data_status") return { status: "unavailable", reason: "fixture" };
        return null;
      } },
      event: { listen: async () => () => {} },
    },
    addEventListener: () => {},
  },
  document: {
    addEventListener: () => {},
    createElement: (tag) => { createdTags.push(tag); return makeElement(tag); },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    getElementById: (id) => el(id),
  },
};
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);
vm.runInContext(wb, sandbox);

// textContent 只在叶子上有值；聚合读取要沿 children 走一遍。
const textOf = (node) => (node == null ? "" : String(node.textContent ?? "")
  + (node.children || []).map(textOf).join(""));
const domText = (id) => textOf(elements[id]);
const countButtons = (node) => (node == null ? 0 : (node.tag === "button" ? 1 : 0)
  + (node.children || []).map(countButtons).reduce((a, b) => a + b, 0));

// 执行环境选择器的 options（模拟 HTML 里的七个 option），用于灰显断言。
el("sk-harness").options = ["all", "claude-code", "codex", "openclaw", "hermes", "workbuddy", "dsh"]
  .map((v) => ({ value: v, textContent: v, disabled: false }));

console.log("# §11.2 全部视图（renderSkillHealth(payloadAll, 'all')）");
sandbox.renderSkillHealth(payloadAll, "all");
{
  const cards = elements["sk-harness-cards"].children;
  ok(cards.length >= 3, `渲染多张执行环境摘要卡（got ${cards.length}）`);
  const claudeCard = cards.find((c) => textOf(c).includes("Claude Code"));
  ok(claudeCard && textOf(claudeCard).includes("15,000") && textOf(claudeCard).includes("字符"),
    "claude-code 卡画预算条（分母 15,000 来自 description_budget_detail）");
  ok(claudeCard && textOf(claudeCard).includes("可配置估算"),
    "预算条标注分母来源（可配置估算）");
  const dshCard = cards.find((c) => textOf(c).includes("DeepSeek Harness"));
  ok(dshCard && textOf(dshCard).includes("SV004") && !textOf(dshCard).includes("sk-budget-fill"),
    "dsh 卡不画预算条且文案含 SV004（逐条截断提示）");
  ok(dshCard && textOf(dshCard).includes("该执行环境没有描述预算"), "dsh 卡写明无预算，不冒充 0");
  ok(claudeCard && textOf(claudeCard).includes("运行时核实 —"),
    "runtime_verified 为 null 渲染为「—」而非 0");
  const codexCard = cards.find((c) => textOf(c).includes("Codex"));
  ok(codexCard && textOf(codexCard).includes("未检测到"),
    "未检测到的执行环境在卡片里注明「未检测到」，不隐藏");
}
{
  // 页头安全合计 = 安全分区行数（§6.3，vm 钉住）。
  const totals = sandbox.skillHealthTotals(payloadAll);
  const rows = elements["sk-security-list"].children;
  ok(totals.securityRowCount === rows.length,
    `页头安全合计（${totals.securityRowCount}）= 安全分区行数（${rows.length}）`);
  const totalsText = domText("sk-totals");
  ok(totalsText.includes("已扫描") && totalsText.includes("安全") && totalsText.includes("结构"),
    "页头合计只出白名单四类（got: " + totalsText.slice(0, 80) + "…）");
  for (const word of ["预算", "Tier1", "tokens", "冲突", "重叠", "僵尸"]) {
    ok(!totalsText.includes(word), `页头合计渲染不含「${word}」`);
  }
}
{
  // 共享根（~/.agents/skills）同 path 命中：去重一行、两枚执行环境芯片（§3.2/§11.2）。
  const rows = elements["sk-security-list"].children.filter((r) => textOf(r).includes("shared-hit"));
  ok(rows.length === 1, `同 path 安全命中只渲染一行（got ${rows.length}）`);
  if (rows.length === 1) {
    ok(textOf(rows[0]).includes("DeepSeek Harness") && textOf(rows[0]).includes("OpenClaw"),
      "该行挂 dsh + OpenClaw 两枚执行环境芯片");
  }
  // cited 命中：标「疑似引用语境」，不降级不隐藏。
  const cited = elements["sk-security-list"].children.filter((r) => textOf(r).includes("疑似引用语境"));
  ok(cited.length >= 1, "cited 命中标「疑似引用语境」且照常渲染");
}
{
  // DOM 不存在跨执行环境预算相加：给 codex 造第二份预算明细（形状 = P0-3 真实输出），
  // 断言两个分母之和、两个 used 之和都不出现在 DOM 任何地方。
  const hs = payloadAll.report.harness_summaries;
  hs["codex"].skills_on_disk = 9;
  hs["codex"].description_budget_detail = {
    available: true, source: "official-estimate", budget_chars: 8000,
    used_chars: 1690, pct_used: 21.1, counted_skills: 9,
  };
  const claudeBudget = hs["claude-code"].description_budget_detail.budget_chars;
  const sumAll = String(claudeBudget + 8000);
  const sumAllFmt = (claudeBudget + 8000).toLocaleString("en-US");
  sandbox.renderSkillHealth(payloadAll, "all");
  const wholePage = ["sk-harness-cards", "sk-totals", "sk-act-now-list", "sk-security-list",
    "sk-conflicts-list", "sk-usage-list", "sk-not-assessed-list"].map(domText).join(" ");
  ok(!wholePage.includes(sumAll) && !wholePage.includes(sumAllFmt),
    `DOM 不存在两执行环境预算分母之和（${sumAll}）`);
  ok(wholePage.includes("8,000") && wholePage.includes("15,000"),
    "两份预算明细各自出现（并列，不是相加）");
  delete hs["codex"].description_budget_detail;
  hs["codex"].skills_on_disk = 0;
  sandbox.renderSkillHealth(payloadAll, "all");
}
{
  // caveats / not_assessed 逐条进 DOM（§5.4/§6.6）。
  ok(domText("sk-act-now-list").includes("! Heuristic rules"),
    "SV5xx 的 caveat 以 ! 前缀逐条渲染");
  ok(domText("sk-not-assessed-list").includes("SV402") && domText("sk-not-assessed-list").includes("OVERLAP_CONFIRMED"),
    "not_assessed 逐条原样渲染（码 + 名 + 原因）");
  // 2026-09-19 真机截图回归：占位显隐与行数同向 —— 有发现的分区不得挂着
  // 「没有…」占位，为空的分区必须显示占位。
  ok(elements["sk-act-now-empty"].hidden === true,
    "立即处理有发现 → 空态文案隐藏（不与 SV 行同屏）");
  ok(elements["sk-security-empty"].hidden === true,
    "安全与结构有发现 → 空态文案隐藏");
  ok(domText("sk-usage-list").includes("占位显隐") === false
    && elements["sk-usage-empty"] != null,
    "使用证据分区存在");
  // SV401 / SV5xx 行动列 = 需你判断，无按钮（§8）。
  ok(domText("sk-act-now-list").includes("SV401") && domText("sk-act-now-list").includes("需你判断"),
    "SV401 行动列固定「需你判断」");
  ok(domText("sk-act-now-list").includes("SV502") && domText("sk-act-now-list").includes("需你判断"),
    "SV502 行动列固定「需你判断」");
  ok(countButtons(elements["sk-act-now-list"]) === 0, "发现行里没有任何按钮");
  ok(createdTags.every((t) => t !== "button"), "渲染器从不创建 button（无一键禁用/删除）");
}

console.log("# §11.2 单执行环境视图（REQ-SK-04）");
sandbox.renderSkillHealth(payloadClaude, "claude-code");
{
  ok(elements["sk-totals"].hidden === true, "单执行环境视图页头合计行隐藏");
  const cards = elements["sk-harness-cards"].children;
  ok(cards.length === 1, `单执行环境视图只渲染该执行环境的卡（got ${cards.length}）`);
  const repro = domText("sk-repro");
  ok(repro.includes("--harness claude-code") && repro.includes(payloadClaude.run),
    "复现命令含 --harness <h> 与 run 标记");
  ok(elements["sk-act-now-empty"].hidden === true,
    "单执行环境视图同样不挂空态占位");
  // 使用证据（§6.5）：claude-code 有触发数据 —— 僵尸 / too-new 分列。
  const usage = domText("sk-usage-list");
  ok(usage.includes("Claude Code"), "使用证据按执行环境分组");
  ok(usage.includes("零触发"), "使用证据列零触发（SV201 证据）");
  ok(usage.includes("太新不判") && usage.includes("满 14 天可判定"),
    "too-new 带「N 天后可判定」，不落进僵尸");
  // fixture 语料刚创建（安装年龄取 ctime，造不出 14 天前），所以零触发全部
  // 落 too-new、不落僵尸 —— 断言贴真实输出的形状，不手写期望（spec §5.1）。
  ok(usage.includes("零触发 0"), "僵尸计数来自证据（语料太新 → 0 只说明没到闸）");
  ok(usage.includes("休眠 3"), "休眠计数来自证据（三个用过的 skill 上次使用都在 30 天前）");
}

console.log("# §7 状态：exit 2 → 错误 notice（不冒充「没有发现」）");
{
  sandbox.__nextDoctor = { reject: { error: { code: "cancelled", message: "agent-vitals doctor failed (exit 2): bad config" } } };
  await sandbox.loadSkillsDoctor(true);
  const errText = domText("sk-error");
  ok(elements["sk-error"].hidden === false, "错误 notice 可见");
  ok(errText.includes("exit 2") && errText.includes("bad config"),
    "错误 notice 原样带 stderr 首行");
  sandbox.__nextDoctor = { payload: payloadAll };
  await sandbox.loadSkillsDoctor(true);
  ok(elements["sk-error"].hidden === true && elements["sk-harness-cards"].children.length >= 3,
    "成功取数后正常渲染（错误 notice 收起）");
}

rmSync(tmpHome, { recursive: true, force: true });
console.log(failed === 0 ? "\n全部通过" : `\n${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
