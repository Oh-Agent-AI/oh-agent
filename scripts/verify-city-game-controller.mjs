#!/usr/bin/env node
// 游戏模式状态机守卫（CITY_GAME_MODE_IMPLEMENTATION_PLAN §5）：
// 合法转换产生事件；非法命令是无事件的合并操作；暂停记录来源；退出幂等；
// 宿主互斥（航拍/导出/忙碌）拒绝进入并给出可识别原因；每 runId 只结算一次。
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const code = buildSync({ entryPoints: [new URL("../apps/agent-city/ui/src/game/GameModeController.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, console });
const { GameModeController } = mod.exports;

const HOST_OK = { cityReady: true, cinemaActive: false, filmActive: false, busy: false };
const types = (events) => events.map((event) => event.type).join(",");

// ── 进入互斥（§5 表）──
{
  const c = new GameModeController();
  assert.equal(c.enter({ mode: "practice" }, { ...HOST_OK, cityReady: false }).refusal, "not-ready");
  assert.equal(c.enter({ mode: "practice" }, { ...HOST_OK, cinemaActive: true }).refusal, "cinema-active");
  assert.equal(c.enter({ mode: "practice" }, { ...HOST_OK, filmActive: true }).refusal, "film-active");
  assert.equal(c.enter({ mode: "practice" }, { ...HOST_OK, busy: true }).refusal, "busy");
  const ok = c.enter({ mode: "practice" }, HOST_OK);
  assert.ok(ok.ok && types(ok.events) === "entered");
  // 重复进入：合并为无操作，不创建第二实例。
  assert.equal(c.enter({ mode: "race" }, HOST_OK).refusal, "already-in-game");
  assert.equal(c.snapshot.phase, "preparing");
}

// ── 练习链路：preparing → practice；暂停来源与恢复 ──
{
  const c = new GameModeController();
  c.enter({ mode: "practice" }, HOST_OK);
  assert.equal(types(c.prepareDone()), "prepared");
  assert.equal(c.snapshot.phase, "practice");
  assert.ok(c.simulating);
  const paused = c.pause("focus-lost");
  assert.equal(types(paused), "paused");
  assert.equal(c.snapshot.paused.reason, "focus-lost");
  assert.equal(c.snapshot.paused.origin, "practice");
  assert.ok(!c.simulating, "暂停后模拟冻结");
  assert.equal(c.pause("focus-lost").length, 0, "同来源重复暂停为无操作");
  const rePaused = c.pause("menu");
  assert.equal(rePaused[0].reason, "menu", "暂停覆盖只更新来源");
  assert.equal(c.snapshot.paused.origin, "practice");
  assert.equal(types(c.resume()), "resumed");
  assert.ok(c.simulating);
  assert.equal(c.resume().length, 0, "未暂停时 resume 无操作");
}

// ── 挑战链路：countdown → racing → result，同 runId 只结算一次 ──
{
  const c = new GameModeController();
  const runId0 = c.snapshot.runId;
  c.enter({ mode: "race" }, HOST_OK);
  assert.equal(types(c.prepareDone()), "prepared,countdown-started");
  assert.equal(c.snapshot.phase, "countdown");
  // 倒计时期间暂停：不推进。
  c.pause("user");
  assert.equal(c.countdownDone().length, 0, "暂停时倒计时不得结束");
  c.resume();
  assert.equal(types(c.countdownDone()), "race-started");
  assert.equal(c.snapshot.phase, "racing");
  assert.equal(types(c.raceFinished()), "race-finished");
  assert.equal(c.snapshot.phase, "result");
  assert.equal(c.raceFinished().length, 0, "终态只结算一次");
  assert.equal(c.snapshot.runId, runId0 + 1);
  // 结果面板重试：新 runId，重新走倒计时（复用原路线是调用方职责）。
  const events = c.restart();
  assert.equal(types(events), "restarted,prepared,countdown-started");
  assert.equal(c.snapshot.runId, runId0 + 2);
  assert.equal(c.snapshot.phase, "countdown");
}

// ── 暂停中 restart 与错误面板 ──
{
  const c = new GameModeController();
  c.enter({ mode: "race" }, HOST_OK);
  c.prepareDone();
  c.countdownDone();
  c.pause("user");
  assert.equal(types(c.restart()), "restarted,prepared,countdown-started", "暂停面板可重新开始");
  // 准备失败 → 错误面板 → 重试准备 / 退出。
  const failed = c.fail("layout unavailable");
  assert.equal(types(failed), "failed");
  assert.equal(c.snapshot.error.origin, "countdown");
  assert.equal(c.resume().length, 0, "错误面板中 resume 无操作");
  assert.equal(c.restart().length, 0, "错误面板不提供 restart（走 retryPrepare）");
  assert.equal(types(c.retryPrepare()), "retry-prepare");
  assert.equal(c.snapshot.phase, "preparing");
  // 运行中失败：冻结并保留 origin。
  c.prepareDone();
  c.countdownDone();
  c.fail("context lost");
  assert.equal(c.snapshot.error.origin, "racing");
  assert.ok(!c.simulating);
  // 幂等 fail。
  assert.equal(c.fail("again").length, 0);
}

// ── 退出事务：任意在局状态 → exiting → data；幂等；不重复保存 ──
{
  const c = new GameModeController();
  assert.equal(c.exit().length, 0, "data 阶段退出为无操作");
  c.enter({ mode: "practice" }, HOST_OK);
  c.prepareDone();
  c.pause("lag");
  assert.equal(types(c.exit()), "exit-began");
  assert.equal(c.snapshot.phase, "exiting");
  assert.equal(c.exit().length, 0, "退出中重复退出为无操作");
  assert.equal(c.enter({ mode: "practice" }, HOST_OK).refusal, "already-in-game", "exiting 尚未回到 data");
  assert.equal(c.exitSettled().length, 1);
  assert.equal(c.snapshot.phase, "data");
  assert.equal(c.snapshot.selection, null);
  assert.equal(c.exitSettled().length, 0, "settled 幂等");
  // 结算后的 result 退出同样幂等一次。
  const c2 = new GameModeController();
  c2.enter({ mode: "race" }, HOST_OK);
  c2.prepareDone(); c2.countdownDone(); c2.raceFinished();
  assert.equal(types(c2.exit()), "exit-began");
  assert.equal(c2.exitSettled().length, 1);
}

// ── data 阶段的非法命令全部无事件 ──
{
  const c = new GameModeController();
  for (const events of [c.prepareDone(), c.countdownDone(), c.raceFinished(), c.pause("user"), c.resume(), c.restart(), c.fail("x"), c.retryPrepare(), c.exitSettled()]) {
    assert.equal(events.length, 0);
  }
  assert.ok(!c.inGame && !c.simulating);
}

console.log("verify-city-game-controller: ok");
