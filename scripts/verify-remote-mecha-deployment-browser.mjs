#!/usr/bin/env node
// Synthetic component + 3D scene only. No production gateway, relay, or real devices.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = "artifacts/mecha-clarity-p0/remote-deployment-synthetic-2026-11-03";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  for (const [lang, width, height, loss] of [["zh", 1100, 700, "lost-before"], ["en", 390, 844, "lost-after"], ["en", 390, 844, "unavailable"], ["zh", 1100, 700, "changed"], ["en", 390, 844, "forbidden"]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${base}/tests/fixtures/remote-deployment.html?lang=${lang}`);
    const name = (zh, en) => lang === "zh" ? zh : en;
    const btn = (zh, en) => page.getByRole("button", { name: name(zh, en), exact: true });
    const legal = page.locator(".remote-row button.deployable");
    await legal.first().waitFor();
    assert.ok(await legal.count() >= 3);
    const initial = await page.evaluate(() => ({ visible: window.deploymentFixture.visible(), markers: window.deploymentFixture.markers(), state: window.deploymentFixture.state() }));
    assert.equal(initial.visible.Assault, false); assert.equal(initial.visible.Gunner, false); assert.equal(initial.visible.Support, false);
    assert.ok(initial.markers >= 3); assert.equal(initial.state.phase, "deployment");
    await page.locator(".remote-row button:not(.deployable)").first().click();
    await page.getByRole("alert").waitFor();
    await legal.nth(0).click();
    await page.getByRole("button", { name: lang === "zh" ? /射手/ : /Gunner/ }).click();
    await legal.nth(1).click();
    await page.getByRole("button", { name: lang === "zh" ? /支援/ : /Support/ }).click();
    await legal.nth(2).click();
    assert.equal(await page.getByRole("status").first().textContent().then(t => t.includes("3/3")), true);
    assert.equal((await page.evaluate(() => window.deploymentFixture.visible())).Support, true);
    assert.deepEqual(await page.evaluate(() => window.deploymentFixture.state()), initial.state);
    // Swap two placed units, then undo, without touching authoritative state.
    const firstBefore = await legal.nth(0).getAttribute("aria-label");
    await legal.nth(0).click();
    assert.notEqual(await legal.nth(0).getAttribute("aria-label"), firstBefore);
    await btn("撤销", "Undo").click();
    assert.equal(await legal.nth(0).getAttribute("aria-label"), firstBefore);
    await page.evaluate(() => window.deploymentFixture.online(false));
    await page.waitForFunction(() => document.querySelector(".remote-row button.deployable")?.disabled === true);
    await page.evaluate(() => window.deploymentFixture.online(true));
    await page.waitForFunction(() => document.querySelector(".remote-row button.deployable")?.disabled === false);
    assert.match(await page.getByRole("status").first().textContent(), /3\/3/);
    const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
    assert.ok(geometry.document <= geometry.viewport, `horizontal page overflow: ${JSON.stringify(geometry)}`);
    await page.evaluate(() => window.deploymentFixture.refresh());
    await page.waitForTimeout(100);
    assert.match(await page.getByRole("status").first().textContent(), /3\/3/);
    // A corrected authoritative board at the same revision invalidates an unlocked draft.
    await page.evaluate(() => window.deploymentFixture.correct());
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("0/3"));
    await page.getByRole("button", { name: lang === "zh" ? /突击/ : /Assault/ }).click();
    await legal.nth(0).click();
    await page.getByRole("button", { name: lang === "zh" ? /射手/ : /Gunner/ }).click();
    await legal.nth(1).click();
    await page.getByRole("button", { name: lang === "zh" ? /支援/ : /Support/ }).click();
    await legal.nth(2).click();
    await btn("撤销", "Undo").click();
    assert.match(await page.getByRole("status").first().textContent(), /2\/3/);
    await legal.nth(2).click();
    await page.screenshot({ path: join(output, `${lang}-${width}.png`), fullPage: true });
    await page.evaluate(loss => window.deploymentFixture.behavior(loss === "changed" ? "lost-before" : loss), loss);
    await btn("确认部署", "Confirm deployment").click();
    if (loss === "changed") {
      await btn("重试确认", "Retry confirmation").waitFor();
      await page.evaluate(() => window.deploymentFixture.correct());
      await page.getByText("同版本战场已变化", { exact: false }).waitFor();
      assert.equal(await btn("重试确认", "Retry confirmation").isDisabled(), true);
      assert.equal(await legal.first().isDisabled(), true);
      // A return to the old revision content must not erase the observed anomaly.
      await page.evaluate(() => window.deploymentFixture.restore());
      await page.waitForTimeout(100);
      assert.equal(await btn("重试确认", "Retry confirmation").isDisabled(), true);
      assert.equal((await page.evaluate(() => window.deploymentFixture.calls)).length, 1);
      assert.deepEqual(errors, []);
      console.log(`PASS ${lang} ${width}x${height} ${loss} (sticky lock)`);
      await context.close();
      continue;
    } else if (loss === "forbidden") {
      await page.getByRole("alert").filter({ hasText: "forbidden" }).waitFor();
      assert.equal(await legal.first().isDisabled(), false);
      await btn("确认部署", "Confirm deployment").click();
      await page.getByTestId("battle-phase").waitFor();
      const calls = await page.evaluate(() => window.deploymentFixture.calls);
      assert.equal(calls.length, 2); assert.notEqual(calls[0].commandId, calls[1].commandId);
    } else if (loss === "lost-before" || loss === "unavailable") {
      await btn("重试确认", "Retry confirmation").waitFor();
      assert.equal(await legal.first().isDisabled(), true);
      assert.match(await page.getByRole("status").first().textContent(), /3\/3/);
      if (loss === "unavailable") {
        // A definite rejection of a retry cannot cancel the earlier uncertain request.
        await page.evaluate(() => window.deploymentFixture.behavior("forbidden"));
        await btn("重试确认", "Retry confirmation").click();
        await page.waitForFunction(() => window.deploymentFixture.calls.length === 2 && !document.querySelector(".remote-submit")?.disabled);
        await page.getByRole("alert").filter({ hasText: "Confirmation is uncertain" }).waitFor();
        assert.equal(await legal.first().isDisabled(), true);
        assert.equal((await page.evaluate(() => window.deploymentFixture.calls)).length, 2);
      }
      await btn("重试确认", "Retry confirmation").click();
      await page.getByTestId("battle-phase").waitFor();
      const calls = await page.evaluate(() => window.deploymentFixture.calls);
      assert.equal(calls.length, loss === "unavailable" ? 3 : 2);
      assert.ok(calls.every(call => JSON.stringify(call) === JSON.stringify(calls[0])));
    } else {
      await page.getByTestId("battle-phase").waitFor();
      assert.equal((await page.evaluate(() => window.deploymentFixture.calls)).length, 1);
    }
    assert.match(await page.getByTestId("battle-phase").textContent(), /player_plan rev 1/);
    assert.deepEqual(errors, []);
    console.log(`PASS ${lang} ${width}x${height} ${loss}`);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await context.newPage();
  await guest.goto(`${base}/tests/fixtures/remote-deployment.html?lang=en&role=guest`);
  await guest.getByText("Only the host can deploy.").waitFor();
  assert.equal(await guest.locator(".remote-row button.deployable").first().isDisabled(), true);
  assert.equal(await guest.getByRole("button", { name: "Confirm deployment" }).isDisabled(), true);
  await context.close();
  console.log("PASS guest authorization UI");
} finally { await browser.close(); }
