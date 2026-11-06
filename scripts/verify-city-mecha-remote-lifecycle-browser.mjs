#!/usr/bin/env node
// Real RemoteMechaControls with an injected in-page host. No host IPC or relay.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { completeLocalDeployment } from "./mecha-deployment-browser-helpers.mjs";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:52971";
const zh = process.argv.includes("--zh");
const viewFail = process.argv.includes("--view-fail");
const browser = await chromium.launch({ headless: true, args: [process.env.MECHA_BROWSER_ANGLE === "metal" ? "--use-angle=metal" : "--enable-unsafe-swiftshader"] });
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
    const failNeedle = 'const [viewFailed, setViewFailed] = useState(null);';
    assert.ok(body.includes(failNeedle));
    await route.fulfill({ response, body: body.replace(needle, `${needle}\n window.__lifecycleController = controller;`).replace(failNeedle, `${failNeedle}\n window.__failMechaView = setViewFailed;`) });
  });
  await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await page.locator(".city-loading").waitFor({ state: "hidden" });
  console.log("city loaded");
  await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
  await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
  console.log("battle opened");
  const settings = page.locator("#mecha-remote-settings");
  const remoteEntry = page.locator('[data-mecha-settings-trigger="remote"]');
  await remoteEntry.click();
  const relay = settings.locator('input[type="url"]');
  await relay.fill("https://fake.invalid");
  const start = settings.locator("button").filter({ hasText: zh ? "开启并生成链接" : "Start and create link" });
  // The local, unconfirmed deployment draft is not sent to the remote authority.
  assert.equal(await page.locator(".mecha-overlay").getAttribute("data-phase"), "deployment");
  assert.equal(await start.isDisabled(), false);
  assert.match(await settings.innerText(), zh ? /本地未确认的部署草稿不会同步/ : /unconfirmed local draft is not transferred/);
  await remoteEntry.click();
  const list = page.locator(".mecha-deploy-list");
  if (await list.getAttribute("open") === null) await list.locator("summary").click();
  const cell = await page.locator("#mecha-deploy-choice option").evaluateAll(rows => rows.map(row => row.value).find(Boolean));
  assert.ok(cell);
  await page.locator("#mecha-deploy-choice").selectOption(cell);
  await page.getByRole("button", { name: /^(放置机甲|Place mech)$/ }).click();
  assert.equal(await page.evaluate(() => window.__lifecycleController.getState().deployment.placements.length), 1);
  await remoteEntry.click();
  await start.click();
  await page.waitForFunction(() => window.__remoteCalls.some(call => call.request.method === "mecha.remote.start-v3"));
  const deploymentStart = await page.evaluate(() => structuredClone(window.__remoteCalls.find(call => call.request.method === "mecha.remote.start-v3").request.payload.state));
  assert.equal(deploymentStart.phase, "deployment");
  assert.ok(deploymentStart.deployment);
  assert.equal("placements" in deploymentStart.deployment, false);
  assert.equal("draft" in deploymentStart, false);
  assert.equal(await page.locator(".mecha-deploy-roster .mecha-plan-card__select").first().isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle", includeHidden: true }).isDisabled(), true);
  await page.evaluate(() => window.__resolveRemote("mecha.remote.start-v3", "ok", { remoteUrl: "https://fake.invalid/match", matchId: "fake" }));
  await page.getByRole("button", { name: zh ? "停止远程" : "Stop remote", exact: true }).click();
  await page.evaluate(() => window.__resolveRemote("mecha.remote.stop", "ok", { ok: true }));
  await page.locator('.mecha-overlay[data-phase="deployment"]').waitFor();
  await page.waitForFunction(() => window.__lifecycleController.getState().deployment.placements.length === 0);
  if (await settings.isVisible()) await remoteEntry.click();
  console.log("v3 deployment start, local draft isolation and restart verified");
  await completeLocalDeployment(page);
  // Direct top-bar switches close the other panel without remounting it.
  const battlefield = page.locator('[data-mecha-settings-trigger="battlefield"]');
  await battlefield.click();
  const fieldSettings = page.locator("#mecha-battlefield-settings");
  const auto = fieldSettings.getByRole("button", { name: zh ? "自动对战" : "Auto battle", exact: true });
  await auto.click();
  assert.equal(await start.isDisabled(), true, "must not start while auto play is running");
  await fieldSettings.getByRole("button", { name: zh ? "停止自动" : "Stop auto", exact: true }).click();
  await remoteEntry.click();
  console.log("starting remote");
  await start.click();
  await page.waitForFunction(() => window.__remoteCalls.some((call) => call.request.method === "mecha.remote.start-v3"));
  console.log("host request pending");
  const projected = await page.evaluate(() => ({
    sent: structuredClone(window.__remoteCalls.find(call => call.request.method === "mecha.remote.start-v3").request.payload.state),
    authority: structuredClone(window.__lifecycleController.getState().match),
  }));
  assert.equal(projected.sent.phase, "player_plan");
  console.log(`terrain safety in synthetic start: ${projected.sent.assaultTerrainSafety ? "present" : "absent"}`);
  assert.deepEqual(projected.sent.assaultTerrainSafety, projected.authority.assaultTerrainSafety, "remote snapshot must preserve authoritative terrain safety");
  assert.equal("deployment" in projected.sent, false, "completed deployment data must not leak into a combat snapshot");
  assert.equal("draft" in projected.sent, false, "local draft must not be sent with remote start");
  if (projected.sent.assaultTerrainSafety) {
    assert.deepEqual(Object.keys(projected.sent.assaultTerrainSafety).sort(), ["unsafeCells", "unsafeEdges"]);
    for (const cell of projected.sent.assaultTerrainSafety.unsafeCells) assert.deepEqual(Object.keys(cell).sort(), ["x", "y"]);
    for (const edge of projected.sent.assaultTerrainSafety.unsafeEdges) {
      assert.deepEqual(Object.keys(edge).sort(), ["from", "to"]);
      for (const cell of [edge.from, edge.to]) assert.deepEqual(Object.keys(cell).sort(), ["x", "y"]);
    }
  }
  const state = () => page.evaluate(() => ({ turn: window.__lifecycleController.getState().match.turn, draft: structuredClone(window.__lifecycleController.getState().draft) }));
  const before = await state();
  const status = page.locator(".mecha-turn-summary > .mecha-resource[role=status]");
  assert.match(await status.innerText(), zh ? /正在启动/ : /Starting remote/);
  assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle", includeHidden: true }).isDisabled(), true);
  assert.equal(await page.locator(".mecha-plan-card__select").first().isDisabled(), true);
  await relay.blur();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1000);
  assert.deepEqual(await state(), before, "pending start must not advance or change draft");
  assert.equal(await status.count(), 1, "Escape must not close battle during start");
  assert.equal(await settings.isVisible(), false, "Escape closes only the settings panel");
  console.log("start lock verified");
  await page.evaluate(() => window.__resolveRemote("mecha.remote.start-v3", "ok", { remoteUrl: "https://fake.invalid/match", matchId: "fake" }));
  if (viewFail) {
    await page.evaluate(() => window.__failMechaView("mode"));
    await page.getByRole("alert").filter({ hasText: zh ? "三维视角被其他模式占用" : "3D view" }).waitFor();
    assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle", includeHidden: true }).isDisabled(), true);
    await page.locator(".mecha-city-gate .mecha-remote-settings > summary").click();
    const recover = page.getByRole("button", { name: zh ? "停止远程并恢复本地" : "Stop remote and restore local play" });
    await recover.click();
    await page.evaluate(() => window.__resolveRemote("mecha.remote.stop", "ok", { ok: true }));
    await page.waitForFunction(() => !document.querySelector('.mecha-city-gate button:disabled'));
    assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle", includeHidden: true }).isDisabled(), false);
    assert.deepEqual(errors, []);
    console.log("View loss recovery with synthetic host passed.");
  } else {
  await page.getByRole("button", { name: zh ? "停止远程" : "Stop remote", exact: true }).click();
  assert.match(await status.innerText(), zh ? /正在停止/ : /Stopping remote/);
  await page.evaluate(() => window.__resolveRemote("mecha.remote.stop", "reject"));
  await page.getByRole("button", { name: zh ? "停止远程并恢复本地" : "Stop remote and restore local play" }).waitFor();
  assert.match(await status.innerText(), zh ? /无法确认/ : /unknown/i);
  assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle", includeHidden: true }).isDisabled(), true);
  const retry = page.getByRole("button", { name: zh ? "停止远程并恢复本地" : "Stop remote and restore local play" });
  console.log("stop failure verified");
  await retry.click();
  await page.evaluate(() => window.__resolveRemote("mecha.remote.stop", "ok", {}));
  await retry.waitFor();
  assert.match(await status.innerText(), zh ? /无法确认/ : /unknown/i, "malformed stop must remain locked");
  await retry.click();
  await page.evaluate(() => window.__resolveRemote("mecha.remote.stop", "ok", { ok: true }));
  await page.locator('.mecha-overlay[data-phase="deployment"]').waitFor();
  if (!await settings.isVisible()) await remoteEntry.click();
  await start.waitFor();
  assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle", includeHidden: true }).isDisabled(), false);
  assert.equal(await start.isDisabled(), false, "stopping remote restarts local deployment and permits a new remote deployment");
  await remoteEntry.click();
  await completeLocalDeployment(page);
  await remoteEntry.click();
  await start.click();
  await page.waitForFunction(() => window.__remoteCalls.some((call) => call.request.method === "mecha.remote.start-v3"));
  await page.evaluate(() => window.__resolveRemote("mecha.remote.start-v3", "reject"));
  await retry.waitFor();
  assert.match(await status.innerText(), zh ? /无法确认/ : /unknown/i, "lost start reply must not unlock");
  await retry.click();
  await page.evaluate(() => window.__resolveRemote("mecha.remote.stop", "ok", { ok: true }));
  if (!await settings.isVisible()) await remoteEntry.click();
  await start.waitFor();
  assert.equal(await page.getByRole("button", { name: zh ? "退出战斗" : "Exit battle", includeHidden: true }).isDisabled(), false);
  assert.deepEqual(errors, []);
  console.log(`${zh ? "zh" : "en"}: real controls with synthetic host: pending, exit lock, success, stop failure/malformed reply, lost start reply and confirmed recovery passed. No relay.`);
  }
} finally { await browser.close(); }
