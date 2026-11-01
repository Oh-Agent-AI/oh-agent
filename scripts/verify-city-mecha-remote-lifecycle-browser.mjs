#!/usr/bin/env node
// Real RemoteMechaControls with an injected in-page host. No host IPC or relay.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:52971";
const zh = process.argv.includes("--zh");
const viewFail = process.argv.includes("--view-fail");
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
  page.setDefaultTimeout(120_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ zh }) => {
    localStorage.setItem("city.seed", "4196523069");
    window.__AV_PLUGIN_LOCALE__ = zh ? "zh-Hans" : "en";
    window.__remoteCalls = [];
    window.__fakeRemoteHost = (_command, { request }) => {
      if (request.method === "mecha.remote.pending") return Promise.resolve({ version: 1, requestId: request.requestId, ok: true, result: { pending: [] } });
      return new Promise((resolve, reject) => window.__remoteCalls.push({ request, resolve, reject }));
    };
    window.__resolveRemote = (method, kind, result) => {
      const index = window.__remoteCalls.findIndex((call) => call.request.method === method);
      if (index < 0) throw new Error(`no pending ${method}`);
      const call = window.__remoteCalls.splice(index, 1)[0];
      if (kind === "reject") call.reject(new Error("simulated_lost_reply"));
      else call.resolve({ version: 1, requestId: call.request.requestId, ok: true, result });
    };
  }, { zh });
  await page.route("**/src/game/mecha/RemoteMechaControls.tsx*", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const needle = 'import { invokeHost } from "/src/host.ts";';
    assert.ok(body.includes(needle));
    await route.fulfill({ response, body: body.replace(needle, 'const invokeHost = window.__fakeRemoteHost;') });
  });
  await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const needle = "const controller = controllerRef.current;";
    assert.ok(body.includes(needle));
    const failNeedle = "const [viewFailed, setViewFailed] = useState(false);";
    assert.ok(body.includes(failNeedle));
    await route.fulfill({ response, body: body.replace(needle, `${needle}\n window.__lifecycleController = controller;`).replace(failNeedle, `${failNeedle}\n window.__failMechaView = setViewFailed;`) });
  });
  await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await page.locator(".city-loading").waitFor({ state: "hidden" });
  console.log("city loaded");
  await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
  await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics" }).click();
  console.log("battle opened");
  const settings = page.locator("details.mecha-settings").filter({ hasText: zh ? "手机远程战棋" : "Remote mecha tactics" });
  await settings.locator("summary").click();
  const relay = settings.locator('input[type="url"]');
  await relay.fill("https://fake.invalid");
  const start = settings.locator("button").filter({ hasText: zh ? "开启并生成链接" : "Start and create link" });
  // Only one settings sheet is visible at a time; close it before switching.
  await settings.locator("summary").click();
  const battlefield = page.locator("details.mecha-settings > summary").filter({ hasText: zh ? "战场设置与规则" : "Battlefield settings and rules" });
  await battlefield.click();
  const auto = page.getByRole("button", { name: zh ? "自动对战" : "Auto battle", exact: true });
  await auto.click();
  assert.equal(await start.isDisabled(), true, "must not start while auto play is running");
  await page.getByRole("button", { name: zh ? "停止自动" : "Stop auto", exact: true }).click();
  await battlefield.click();
  await settings.locator("summary").click();
  console.log("starting remote");
  await start.click();
  await page.waitForFunction(() => window.__remoteCalls.some((call) => call.request.method === "mecha.remote.start"));
  console.log("host request pending");
  const state = () => page.evaluate(() => ({ turn: window.__lifecycleController.getState().match.turn, draft: structuredClone(window.__lifecycleController.getState().draft) }));
  const before = await state();
  const status = page.locator(".mecha-turn-summary [role=status]");
  assert.match(await status.innerText(), zh ? /正在启动/ : /Starting remote/);
  assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle" }).isDisabled(), true);
  assert.equal(await page.locator(".mecha-pack li > button").first().isDisabled(), true);
  await relay.blur();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1000);
  assert.deepEqual(await state(), before, "pending start must not advance or change draft");
  assert.equal(await status.count(), 1, "Escape must not close during start");
  console.log("start lock verified");
  await page.evaluate(() => window.__resolveRemote("mecha.remote.start", "ok", { remoteUrl: "https://fake.invalid/match", matchId: "fake" }));
  if (viewFail) {
    await page.evaluate(() => window.__failMechaView(true));
    await page.getByRole("alert").filter({ hasText: zh ? "三维视角被其他模式占用" : "3D view" }).waitFor();
    assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle" }).isDisabled(), true);
    await settings.locator("summary").click();
    const recover = settings.getByRole("button", { name: zh ? "停止远程并恢复本地" : "Stop remote and restore local play" });
    await recover.click();
    await page.evaluate(() => window.__resolveRemote("mecha.remote.stop", "ok", { ok: true }));
    await page.waitForFunction(() => !document.querySelector('.mecha-city-gate button:disabled'));
    assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle" }).isDisabled(), false);
    assert.deepEqual(errors, []);
    console.log("View loss recovery with synthetic host passed.");
  } else {
  await settings.getByRole("button", { name: zh ? "停止远程" : "Stop remote", exact: true }).click();
  assert.match(await status.innerText(), zh ? /正在停止/ : /Stopping remote/);
  await page.evaluate(() => window.__resolveRemote("mecha.remote.stop", "reject"));
  await settings.getByRole("button", { name: zh ? "停止远程并恢复本地" : "Stop remote and restore local play" }).waitFor();
  assert.match(await status.innerText(), zh ? /无法确认/ : /unknown/i);
  assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle" }).isDisabled(), true);
  const retry = settings.getByRole("button", { name: zh ? "停止远程并恢复本地" : "Stop remote and restore local play" });
  console.log("stop failure verified");
  await retry.click();
  await page.evaluate(() => window.__resolveRemote("mecha.remote.stop", "ok", {}));
  await retry.waitFor();
  assert.match(await status.innerText(), zh ? /无法确认/ : /unknown/i, "malformed stop must remain locked");
  await retry.click();
  await page.evaluate(() => window.__resolveRemote("mecha.remote.stop", "ok", { ok: true }));
  await start.waitFor();
  assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle" }).isDisabled(), false);
  await start.click();
  await page.waitForFunction(() => window.__remoteCalls.some((call) => call.request.method === "mecha.remote.start"));
  await page.evaluate(() => window.__resolveRemote("mecha.remote.start", "reject"));
  await retry.waitFor();
  assert.match(await status.innerText(), zh ? /无法确认/ : /unknown/i, "lost start reply must not unlock");
  await retry.click();
  await page.evaluate(() => window.__resolveRemote("mecha.remote.stop", "ok", { ok: true }));
  await start.waitFor();
  assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle" }).isDisabled(), false);
  assert.deepEqual(errors, []);
  console.log(`${zh ? "zh" : "en"}: real controls with synthetic host: pending, exit lock, success, stop failure/malformed reply, lost start reply and confirmed recovery passed. No relay.`);
  }
} finally { await browser.close(); }
