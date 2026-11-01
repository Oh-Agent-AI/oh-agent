#!/usr/bin/env node
// Synthetic fixture and headless Chromium only. Start this worktree's City Vite
// server first and pass its URL. Interception adds a test-only failure switch to
// the display preview; the authoritative validation path is not intercepted.
// This is not native, physical-input, network, performance or user acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const locale of ["en", "zh"]) {
    const zh = locale === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let interceptions = 0;
    await page.route("**/src/game/mecha/controller.ts*", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const needle = "const previewTurn = init.preview ?? previewPlan;";
      assert.equal(source.split(needle).length, 2, "test injection must match exactly once");
      const body = source.replace(needle, `const previewTurn = (...args) => {
        if (globalThis.__testMechaPreviewFailure) throw new Error("synthetic display preview failure");
        return (init.preview ?? previewPlan)(...args);
      };`);
      interceptions++;
      await route.fulfill({ response, body });
    });
    // Observe the real Three marker visibility via test-only Vite injection.
    // This records scene state, not whether pixels are visible or unobscured.
    await page.route("**/src/game/CityMechaWorld.tsx*", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const needle = "bar.marker.visible = Boolean(live) && current.focusedBuilding === building.id;";
      assert.equal(source.split(needle).length, 2, "marker observation must match exactly once");
      const body = source.replace(needle, `${needle}
        globalThis.__testBuildingMarkers ??= {};
        globalThis.__testBuildingMarkerUpdates ??= {};
        globalThis.__testBuildingMarkers[building.id] = bar.marker.visible;
        globalThis.__testBuildingMarkerUpdates[building.id] = (globalThis.__testBuildingMarkerUpdates[building.id] ?? 0) + 1;`);
      await route.fulfill({ response, body });
    });
    await page.addInitScript((lang) => {
      localStorage.setItem("city.seed", "4196523069");
      window.__AV_PLUGIN_LOCALE__ = lang;
      // Keep software-rendered animation from saturating the headless test host.
      const frame = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map(); let sequence = 0;
      window.requestAnimationFrame = (callback) => {
        const id = ++sequence;
        const timer = setTimeout(() => { const handle = frame((time) => { pending.delete(id); callback(time); }); pending.set(id, { handle }); }, 100);
        pending.set(id, { timer });
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        const entry = pending.get(id);
        if (entry?.timer !== undefined) clearTimeout(entry.timer);
        if (entry?.handle !== undefined) cancel(entry.handle);
        pending.delete(id);
      };
    }, zh ? "zh-Hans" : "en");
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 240_000 });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics" }).click();
    await page.locator(".mecha-turn-summary").waitFor();
    assert.equal(interceptions, 1);

    const summary = page.locator(".mecha-turn-summary");
    const order = page.locator(".mecha-order");
    const forecast = page.locator("details.mecha-resource");
    const status = page.locator(".mecha-preview-after[role=status]");
    const unavailable = zh ? /预览暂不可用，风险未知/ : /Prediction is temporarily unavailable/;
    const fallback = zh ? /当前敌意不是草稿预测/ : /Current threats are not a prediction of this draft/;
    await page.getByRole("button", { name: zh ? "结算顺序" : "Attack order", exact: true }).click();
    assert.equal(await forecast.count(), 1, "fixture must initially expose a building prediction");
    assert.ok(await page.locator(".mecha-threat-sources button").count() > 0, "fixture must initially have predicted threats");
    assert.ok(await order.locator("ol li").count() > 0, "fixture must initially have predicted order");
    await forecast.locator("summary").click();
    const firstBuilding = forecast.locator("li > button").first();
    const buildingId = (await firstBuilding.innerText()).match(/^(.+?) \(/)?.[1];
    assert.ok(buildingId, "fixture must have an identifiable building");
    await firstBuilding.click();
    assert.equal(await firstBuilding.getAttribute("aria-pressed"), "true");
    await page.waitForFunction((id) => globalThis.__testBuildingMarkers?.[id] === true, buildingId);
    await page.getByText(zh ? "战场设置与规则" : "Battlefield settings and rules", { exact: true }).click();
    const doctrine = page.locator(".mecha-toolbar label").filter({ hasText: zh ? /^打法/ : /^Doctrine/ }).locator("select");
    const initialDoctrine = await doctrine.inputValue();
    const otherDoctrine = initialDoctrine === "tunnel" ? "peel" : "tunnel";
    await doctrine.selectOption(otherDoctrine);
    assert.equal(await forecast.evaluate((node) => node.open), true, "ordinary successful preview changes keep details open");
    assert.equal(await firstBuilding.getAttribute("aria-pressed"), "true", "ordinary preview changes preserve the user's selection");
    await page.waitForFunction((id) => globalThis.__testBuildingMarkers?.[id] === true, buildingId);
    await page.evaluate(() => { globalThis.__testMechaPreviewFailure = true; });
    await doctrine.selectOption(initialDoctrine); // invalidate the successful draft's preview cache
    await status.waitFor();
    assert.match(await status.innerText(), unavailable);
    assert.match(await status.innerText(), fallback);
    assert.equal(await forecast.count(), 0, "failed prediction must remove old building details and values");
    await page.waitForFunction((id) => globalThis.__testBuildingMarkers?.[id] === false, buildingId);
    assert.equal(await page.locator(".mecha-threat-sources").count(), 0, "failed prediction must remove predicted threats");
    assert.equal(await order.locator("ol li").count(), 0, "failed prediction must remove predicted order");
    assert.equal(await page.locator(".mecha-hit").count(), 0, "failed prediction must remove predicted hit badges");
    const buildingFallback = await summary.locator("p.mecha-resource").first().innerText();
    assert.doesNotMatch(buildingFallback, /→|预计|Predicted/, "current building HP must not masquerade as a prediction");
    await page.evaluate(() => { globalThis.__testMechaPreviewFailure = false; });
    await doctrine.selectOption(otherDoctrine);
    await forecast.waitFor();
    assert.equal(await status.count(), 0, "failure status must disappear when prediction recovers");
    assert.equal(await forecast.evaluate((node) => node.open), false, "recovered forecast must start closed");
    const updates = await page.evaluate((id) => globalThis.__testBuildingMarkerUpdates[id], buildingId);
    await page.waitForFunction(({id, count}) => globalThis.__testBuildingMarkerUpdates?.[id] > count, { id: buildingId, count: updates });
    assert.equal(await page.evaluate((id) => globalThis.__testBuildingMarkers[id], buildingId), false, "a closed recovered forecast must not resurrect its old rooftop marker");
    await forecast.locator("summary").click();
    assert.equal(await forecast.locator("li > button").first().getAttribute("aria-pressed"), "false", "recovered details must not retain an invisible selection");
    await forecast.locator("summary").click();
    assert.ok(await page.locator(".mecha-threat-sources button").count() > 0);
    assert.ok(await order.locator("ol li").count() > 0);
    console.log(`${locale}: successful forecast -> injected failure -> recovery; building forecast, threat sources, enemy order, hit badges and fallback labeling passed`);

    // Use the same documented deterministic second-turn scenario as the
    // existing battle test. Reset after the doctrine experiment so the opening
    // Hold plan, and therefore its risk-confirmation path, is predictable.
    await page.getByRole("button", { name: zh ? "新开一局" : "New match", exact: true }).click();
    await page.getByText(zh ? "战场设置与规则" : "Battlefield settings and rules", { exact: true }).click();
    await forecast.locator("summary").click();
    await forecast.locator("li > button").first().click();
    await page.waitForFunction((id) => globalThis.__testBuildingMarkers?.[id] === true, buildingId);
    await page.locator(".mecha-submit-primary").click();
    await page.getByRole("button", { name: zh ? "继续提交" : "Submit anyway", exact: true }).click();
    const skip = page.getByRole("button", { name: zh ? "跳过演出" : "Skip animation", exact: true });
    await skip.waitFor();
    assert.equal(await forecast.count(), 0, "playback hides the forecast details");
    await page.waitForFunction((id) => globalThis.__testBuildingMarkers?.[id] === false, buildingId);
    await skip.click();
    await page.waitForFunction(() => document.querySelector(".mecha-resource")?.textContent?.includes("68/80"), null, { timeout: 240_000 });
    await forecast.waitFor();
    assert.equal(await forecast.evaluate((node) => node.open), false, "forecast should be closed after playback");
    const playbackUpdates = await page.evaluate((id) => globalThis.__testBuildingMarkerUpdates[id], buildingId);
    await page.waitForFunction(({id, count}) => globalThis.__testBuildingMarkerUpdates?.[id] > count, { id: buildingId, count: playbackUpdates });
    assert.equal(await page.evaluate((id) => globalThis.__testBuildingMarkers[id], buildingId), false, "playback must not restore a marker for a closed forecast");
    await forecast.locator("summary").click();
    assert.equal(await forecast.locator("li > button").first().getAttribute("aria-pressed"), "false");
    await forecast.locator("summary").click();
    console.log(`${locale}: selected rooftop marker cleared through playback and next turn`);
    await page.locator(".mecha-pack li > button").first().click();
    await page.locator(".mecha-move-list summary").click();
    const move = page.locator(".mecha-move-list select");
    const applyMove = page.getByRole("button", { name: zh ? "应用移动" : "Apply move", exact: true });
    const melee = page.locator(".mecha-selected-actions > .mecha-actions > button").filter({ hasText: zh ? /^近战$/ : /^Melee$/ });
    const boss = page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: zh ? "大怪" : "Boss" }).first();
    const candidate = page.locator(".mecha-candidate-result");
    const chooseBoss = async () => {
      await move.selectOption("3,2");
      await applyMove.click();
      await melee.click();
      await boss.click();
      await candidate.waitFor();
    };
    await chooseBoss();
    const draft = await page.locator(".mecha-pack").innerText();
    assert.match(await candidate.innerText(), zh ? /直接伤害 2/ : /Direct damage 2/);
    assert.match(await candidate.innerText(), zh ? /整包结束目标 HP 36/ : /Target HP after the whole turn 36/);
    await page.evaluate(() => { globalThis.__testMechaPreviewFailure = true; });
    await page.getByRole("button", { name: zh ? "撤回移动" : "Undo move", exact: true }).click();
    assert.equal(await candidate.count(), 0, "draft change must clear the old candidate");
    await chooseBoss();
    assert.match(await candidate.innerText(), unavailable);
    assert.doesNotMatch(await candidate.innerText(), zh ? /直接伤害|整包结束目标 HP|→/ : /Direct damage|Target HP after the whole turn|→/, "failed candidate must not retain any previous result");
    assert.equal(await page.locator(".mecha-pack").innerText(), draft, "previewing a candidate must not commit an action");
    await page.evaluate(() => { globalThis.__testMechaPreviewFailure = false; });
    await page.getByRole("button", { name: zh ? "撤回移动" : "Undo move", exact: true }).click();
    assert.equal(await candidate.count(), 0);
    await chooseBoss();
    assert.match(await candidate.innerText(), zh ? /直接伤害 2/ : /Direct damage 2/);
    assert.match(await candidate.innerText(), zh ? /整包结束目标 HP 36/ : /Target HP after the whole turn 36/);
    assert.equal(await page.locator(".mecha-pack").innerText(), draft);
    assert.deepEqual(errors, []);
    console.log(`${locale}: successful candidate -> injected failure -> recovery; stale candidate data cleared without committing action`);
    await context.close();
  }
} finally {
  await browser.close();
}
