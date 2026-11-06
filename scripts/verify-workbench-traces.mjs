#!/usr/bin/env node
// v0.10.0 Traces 渲染壳的可测纯部分验证（模式同 verify-workbench-fold-bridge.mjs：
// vm 桩全局执行**真实** workbench.js——测拷贝不算测）。
//
// 断言三件事：
// 1. 事件/命令名两处一致：lib.rs 的 `session_trace` command ↔ workbench.js 的
//    invoke 参数；HTML 的 tab id ↔ JS 的 DOM id（错一个字母渲染壳就是哑的）。
// 2. 用**真实 CLI DTO**（release 二进制对入库 fixture 跑 trace --timeline-series
//    的输出）过真实 buildTimeline——渲染壳消费的形状就是 IPC 会给的形状。
// 3. 会话详情调用 loadDetailTrace，缺少引用、空样本、错误和过期响应均有覆盖。
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log("  ok  " + msg);
  else { failed++; console.error("FAIL  " + msg); }
};

const lib = readFileSync(`${root}/apps/desktop/src-tauri/src/lib.rs`, "utf8");
const html = readFileSync(`${root}/apps/desktop/src-tauri/ui/workbench.html`, "utf8");
const wb = readFileSync(`${root}/apps/desktop/src-tauri/ui/workbench.js`, "utf8");

console.log("# 事件/命令名两处一致");
ok(/fn session_trace\(/.test(lib), "lib.rs 定义 session_trace command");
ok(/invoke_handler[\s\S]*session_trace,/.test(lib), "session_trace 注册进 generate_handler");
ok(wb.includes('invoke("session_trace"'), "workbench.js invoke session_trace");
ok(html.includes('id="sess-detail-view"') && html.includes('id="sess-detail-body"'), "HTML 保留会话详情");
ok(wb.includes('target.id = "sess-detail-trace"'), "详情创建轨迹容器");
ok(wb.includes("loadDetailTrace(data.session_ref)"), "详情加载轨迹");
ok(!html.includes('data-tab="traces"'), "轨迹不占主导航");
ok(html.includes("timeline.js"), "工作台加载共享 timeline.js（几何唯一份）");
ok(!/function\s+buildGeometry|function\s+buildTimeline/.test(wb), "workbench.js 不含第二份几何实现");

// ── 真实 DTO 过真实几何 ──
console.log("# 真实 CLI DTO × 真实 buildTimeline");
const bin = `${root}/target/release/agent-vitals`;
const fixture = `${root}/fixtures/dsh/session.jsonl.zstd`;
const spec = JSON.parse(execFileSync(bin, [
  "trace", fixture, "--harness", "dsh", "--machine-namespace", "ns-ui",
  "--timeline-series",
], { encoding: "utf8" }));
ok(spec.points.length > 0 && spec.events.length > 0, `DTO 可用（points=${spec.points.length} events=${spec.events.length}）`);

// vm 桩全局：最小 DOM 桩 + __TAURI__ invoke 桩（返回真实 CLI DTO），执行真实
// workbench.js，再调用当前详情的轨迹加载函数。
const listeners = {};
const docReady = [];   // DOMContentLoaded 回调——workbench.js 的元素绑定都在这里注册
const elements = {};
function makeEl(id) {
  let nodeId = id;
  let textValue = "";
  let htmlValue = "";
  const node = {
    value: "", dataset: {}, children: [],
    appendChild(child) { this.children.push(child); return child; },
    remove() { this.removed = true; },
    hidden: false, disabled: false,
    addEventListener(ev, fn) { (listeners[`${nodeId}:${ev}`] ||= []).push(fn); },
    keydown: null,
  };
  Object.defineProperties(node, {
    id: {
      get: () => nodeId,
      set: (value) => { nodeId = String(value); elements[nodeId] = node; },
    },
    textContent: {
      get: () => textValue,
      set: (value) => { textValue = String(value); htmlValue = ""; node.children = []; },
    },
    innerHTML: {
      get: () => htmlValue,
      set: (value) => { htmlValue = String(value); textValue = ""; node.children = []; },
    },
  });
  return node;
}
for (const id of ["sess-detail-body", "sess-detail-loading"]) {
  elements[id] = makeEl(id);
}
let responseMode = "normal";
const calls = [];
const sandbox = {
  window: {},
  document: {
    // 自动造宽容元素：workbench.js 的 init() 摸的是整个真实页面，逐个补桩
    // 是打地鼠——任意 id 都给一个可绑事件/可读写的元素，让真实 init 全程跑。
    getElementById: (id) => (elements[id] ||= makeEl(id)),
    createElement: (tag) => makeEl(tag),
    addEventListener: (ev, fn) => { if (ev === "DOMContentLoaded") docReady.push(fn); },
    querySelectorAll: () => [],
  },
  console,
  invoke: async (cmd, args) => {
    // 桩 = 真实二进制（同 store.rs 的 spawn 语义）：形状即 IPC 形状。
    // 只对 session_trace 走真二进制——init() 的其他 IPC（peek_focus_target 等）
    // 返回 null，与本验证无关。
    if (cmd !== "session_trace") return null;
    calls.push(args);
    if (responseMode === "reject") throw new Error("transport down");
    if (responseMode === "error") return { error: { code: "unavailable", message: "fixture unavailable" } };
    if (responseMode === "empty") return { data: { points: [] } };
    if (responseMode === "stale") elements["sess-detail-trace"].dataset.sessionRef = "sr_newer";
    try {
      // --timeline-series 是布尔 flag 不吃值，"--json FILE" 才吃——照真实 CLI
      // 面拼参数，不发明（这里吃过的亏：多塞一个 "-" 直接 clap 报错）。
      // 这里的 fixture 只用来验证 timeline geometry；UI 调用本身必须携带
      // opaque sessionRef，真实 IPC 再在受控执行环境目录反查源文件。
      if (!args.sessionRef) throw new Error("missing sessionRef");
      const cliArgs = ["trace", fixture, "--harness", "dsh", "--machine-namespace", "ns-ui"];
      if (args.output === "graph") cliArgs.push("--json", "-");
      else cliArgs.push("--timeline-series");
      const out = execFileSync(bin, cliArgs, { encoding: "utf8" });
      return { data: JSON.parse(out) };
    } catch (e) {
      console.error("  [stub] invoke 失败:", e.status, e.stderr?.slice(0, 200), e.stdout?.slice(0, 200));
      throw e;
    }
  },
  setTimeout, clearTimeout,
};
sandbox.addEventListener = () => {};   // window.addEventListener（focus 重拉钩子）
sandbox.__TAURI__ = {
  core: { invoke: sandbox.invoke },
  event: { listen: async () => () => {} },   // workbench.js 顶层解构 event.listen——给空订阅
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// 真实 timeline.js 先进沙箱（UMD：无 module → root.TimelineGeometry，root=self/
// this → 沙箱全局）——workbench.js 消费的 window.TimelineGeometry 必须是**真实
// 几何**，不是桩。
vm.runInContext(readFileSync(`${root}/apps/desktop/src-tauri/ui/timeline.js`, "utf8"),
  sandbox, { filename: "timeline.js" });
ok(typeof sandbox.TimelineGeometry?.buildTimeline === "function", "真实 timeline.js 在沙箱内加载出 buildTimeline");
vm.runInContext(wb, sandbox, { filename: "workbench.js" });

// 从真实详情 envelope 入口执行：验证容器创建和异步加载确实连通，而不只是
// 直接调用一个恰好存在的孤立函数。
const ref = "sr_fixture_only_for_ui_contract";
sandbox.renderDetailEnvelope({
  schema_version: "1", data_version: "1", coverage: {}, authority_revision: {},
  data: {
    session_ref: ref, harness: "dsh", event_count: 1, model_ids: ["fixture"],
    tokens: { total: 1 }, timeline: [], billing_breakdown: [], has_more: false,
  },
});
await new Promise(resolve => setTimeout(resolve, 0));
const target = elements["sess-detail-trace"];
const outputs = calls.map(c => c.output).sort();
ok(target && target.dataset.sessionRef === ref, "详情入口创建带安全引用的轨迹容器");
ok(calls.length === 2 && calls.every(c => c.sessionRef === ref && !("path" in c)), "详情入口仅携带安全引用请求轨迹");
ok(JSON.stringify(outputs) === JSON.stringify(["graph", "timeline_series"]), "详情分别请求series和graph输出");
ok(target.innerHTML.includes("<svg"), "真实DTO渲染SVG");
ok(target.children.some(c => c.textContent.includes("节点") && c.textContent.includes("缺状态")), "呈现覆盖计数");
const before = calls.length;
await sandbox.loadDetailTrace("");
ok(calls.length === before && target.textContent.includes("会话引用"), "缺少引用不发IPC");
responseMode = "error";
await sandbox.loadDetailTrace(ref);
ok(target.textContent.includes("fixture unavailable"), "后端错误显示原因");
responseMode = "empty";
await sandbox.loadDetailTrace(ref);
ok(target.textContent.includes("没有可绘制") && target.textContent.includes("事实时间线"), "无样本保留事实说明");
responseMode = "reject";
target.dataset.sessionRef = ref;
await sandbox.loadDetailTrace(ref);
ok(target.textContent.includes("轨迹加载失败") && target.textContent.includes("transport down"), "IPC拒绝显示传输错误");
responseMode = "stale";
target.dataset.sessionRef = ref;
target.textContent = "newer session";
await sandbox.loadDetailTrace(ref);
ok(target.textContent === "newer session" && target.innerHTML === "" && target.children.length === 0,
  "过期结果不以文本、SVG或子节点覆盖新会话");
console.log(failed ? "\n" + failed + " FAIL" : "\n全部通过。");
process.exit(failed ? 1 : 0);
