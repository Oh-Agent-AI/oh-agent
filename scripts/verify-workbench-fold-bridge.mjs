#!/usr/bin/env node
// 断言工作台 fold 事件桥的可测纯部分（src-tauri/ui/workbench.js 的 makePullMerger
// 合并状态机）与两处事件名一致性（lib.rs ↔ workbench.js）。
//
// 为什么是 node + vm：合并状态机是浏览器里的纯逻辑，但「双拉不报错、只有多花
// 一次 IPC/重渲染」正是这类 bug 的命门（先例 scripts/verify-timeline-geometry.mjs：
// 错图不抛异常，必须能对真实实现下断言）。workbench.js 是 `<script src>` 浏览器
// 脚本、没有 module 导出；用 vm 在桩全局里执行**真实文件**，再从上下文里取
// makePullMerger 断言——不是照抄一份逻辑去测（repo 里「测拷贝不算测」是铁律，
// golden 差分同一套）。DOM 集成（真实 listen → 重拉 → 渲染）在无 GUI 环境没法
// 自动验证，只能 `cargo tauri dev` 手动冒烟（见「工作台前端验证」memory）。

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log("  ok  " + msg);
  else { failed++; console.error("FAIL  " + msg); }
};

// ── 单一 UI 事件出口（EVENT_BUS spec §1.3 / 验收 #5）──
// 2026-09-21 迭代 1 起，`usage-fold-updated` 与 `sync-status-updated` 双通道
// 收编为 `app-event`：lib.rs 只 emit 这一个通道（类型在 payload.type），webview
// 只 listen 这一个入口。
const lib = readFileSync(`${root}/apps/desktop/src-tauri/src/lib.rs`, "utf8");
const wb = readFileSync(`${root}/apps/desktop/src-tauri/ui/workbench.js`, "utf8");
const EVENT = "app-event";
console.log("# 单一 UI 事件出口");
ok(lib.includes(`const APP_EVENT: &str = "app-event";`), "lib.rs 定义 APP_EVENT 常量");
ok(wb.includes(`listen("app-event"`), "workbench.js 只订阅 app-event（listen 参数）");
ok(!wb.includes(`listen("usage-fold-updated"`) && !wb.includes(`listen("sync-status-updated"`),
  "旧双通道的 listen 已全部移除");
ok(!/["']usage-fold-updated["']/.test(lib.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")),
  "旧通道字符串在 lib.rs 代码中不再出现（注释里的历史说明不计）");
ok(wb.includes(`type === "Invalidated"`) && wb.includes(`type === "SyncStatusChanged"`),
  "webview 按类型分发（Invalidated / SyncStatusChanged）");
// REFRESH_STORM R1（背压 spec §6 纪律落到出货 UI）：Trust 瞬态信号是传感面信号，
// 不是数据失效——不触发页面级刷新；trust 活跃轮的失效由 revision 前进覆盖。
ok(!wb.includes(`type === "TrustMonitorEvent"`) && !wb.includes(`type === "TrustMonitorInvalidated"`),
  "Trust 瞬态信号不再出现在页面级刷新触发集");
ok(wb.includes(`type === "SyncStatusChanged") {
      refreshActiveTab(true);`),
  "SyncStatusChanged 无 revision 语义：force 语义保底一拉");
// R1 锁存原语：迟到的同 revision 事件出队不补拉；渲染异常不泄漏 running；
// 欠认领（只认领本轮开启时已通知的 revision）。
ok(wb.includes("release() {"), "makePullMerger 提供 release()（迟到事件出队，防 running 泄漏）");
ok(wb.includes("renderedRevision = Math.max(renderedRevision, revAtStart);"),
  "锁存欠认领：只认领本轮开启时已通知的 revision（在飞期间新到的留给尾随轮）");
ok(wb.includes("重拉渲染失败"), "渲染异常被捕获（异常路径仍走到 done()/release()，刷新不死锁）");
// RUNTIME_INVALIDATION spec §4.3/§4.4：领域事件不再逐条透传到 webview；展示层只收
// 合并后的失效信号。FoldCompleted 已退役。
ok(!wb.includes(`type === "FoldCompleted"`) && !wb.includes(`type === "FactsIngested"`),
  "webview 不再按 FoldCompleted / FactsIngested 刷新（领域事件不透传）");
ok(!lib.includes(`"FoldCompleted"`), "lib.rs 不再发 FoldCompleted");
ok(lib.includes("fn drain_event_bus"), "桌面事件消费入口 drain_event_bus 存在");
ok(lib.includes('CoalescingConsumer::new("desktop-ui", ConsumerInterest::presentation()'),
  "desktop-ui 以合并型 + Presentation 角色注册（结构上拿不到载荷）");
ok(lib.includes("fn publish_invalidation") && lib.includes("publish_if_advanced"),
  "Invalidated 经 publish_if_advanced 发射（revision 严格前进才发）");
ok(/timed\("drain_event_bus", \|\| drain_event_bus\(app\)\);[\s\S]{0,200}timed\("publish_invalidation", \|\| \{[\s\S]{0,150}publish_invalidation\(app, harnesses_for_invalidation\)/.test(lib),
  "sync_tick 尾部调用 drain_event_bus 后做 revision 电平检查（P3 timed 包装形态）");

// 手动同步轮询的标志：声明 + 置位 + 复位齐全，防止「漏复位把之后的事件全吞掉」。
ok((wb.match(/manualSyncPolling/g) || []).length >= 4,
  "manualSyncPolling 声明/置位/复位/读取各就位（共 " + (wb.match(/manualSyncPolling/g) || []).length + " 处）");
ok(wb.includes("manualSyncPolling = true;"), "按钮 handler 置位 manualSyncPolling");
ok(wb.includes("manualSyncPolling = false;"), "按钮 handler 复位 manualSyncPolling（finally）");

// ── vm 里执行真实 workbench.js，取合并状态机 ──
// 顶层只需 window.__TAURI__（invoke/listen）、window.addEventListener、
// document.addEventListener（DOMContentLoaded）——init 不触发，其余 DOM 都不碰。
const sandbox = {
  window: {
    __TAURI__: {
      core: { invoke: async () => ({}) },
      event: { listen: async () => () => {} },
    },
    addEventListener: () => {},
  },
  document: { addEventListener: () => {} },
  console,
  Date,
  setTimeout,
  clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(wb, sandbox, { filename: "workbench.js" });
const makePullMerger = sandbox.makePullMerger;
ok(typeof makePullMerger === "function",
  "vm 执行真实 workbench.js → makePullMerger 可取（可测纯部分在真实文件里）");
ok(typeof sandbox.refreshActiveTab === "function", "refreshActiveTab 已定义（事件桥重拉入口）");
ok(typeof sandbox.subscribeFoldEvent === "function", "subscribeFoldEvent 已定义（订阅入口）");

console.log("# 概览重拉合并状态机（makePullMerger）");

// 基础：首触发开拉；在途触发只排队；无排队时 done 释放。
const m = makePullMerger();
ok(m.fire() === true, "首次触发 → 开拉（fire 返回 true）");
ok(m.fire() === false, "在途再触发 → 只标排队（fire 返回 false）");
ok(m.fire() === false, "在途第三次触发 → 仍只标排队");
ok(m.done() === true, "轮完且有排队 → 补拉一轮（done 返回 true，保持 running）");
ok(m.fire() === false, "补拉期间又来触发 → 排队");
ok(m.done() === true, "补拉轮完仍有排队 → 再补一轮");
ok(m.done() === false, "无排队 → 释放（done 返回 false）");
ok(m.fire() === true, "释放后再触发 → 开新一轮");

// 突发：N 次触发（事件/手点同刻到达）→ 在途轮 + 至多 1 轮补拉，绝不并发双拉。
const b = makePullMerger();
let rounds = 0;
const trigger = () => { if (b.fire()) rounds++; };
trigger();                                // round 1
for (let i = 0; i < 10; i++) trigger();   // 10 次突发触发全部折叠
ok(rounds === 1, "10 次突发触发 → 只开 1 轮（其余折叠成排队，rounds=" + rounds + "）");
ok(b.done() === true, "轮完 → 补拉 1 轮");
rounds++;                                 // 补拉轮
for (let i = 0; i < 5; i++) trigger();    // 补拉轮内又有 5 次触发
ok(rounds === 2, "补拉轮内再 5 次触发 → 仍只多 1 轮补拉（rounds=" + rounds + "）");
while (b.done()) { rounds++; }
ok(rounds === 3, "全部排空 → 恰好第 3 轮后释放（rounds=" + rounds + "）");
ok(b.done() === false, "释放后 done → false（running 已复位）");

if (failed) { console.error("\n" + failed + " 项断言失败"); process.exit(1); }
console.log("\n通过。");
