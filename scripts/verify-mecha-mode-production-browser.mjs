#!/usr/bin/env node
// Smoke-test the production release picker and both supported mode routes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5188";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  for (const choice of ["sequential"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("city.seed", "4196523069");
      window.__CITY_ISOLATION_FIXTURE__ = true;
      window.__AV_PLUGIN_LOCALE__ = "zh-Hans";
    });
    await page.goto(`${base}/?mechaV15=1`, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 180000 });
    await page.getByRole("button", { name: "城市设置", exact: true }).click();
    await page.getByRole("button", { name: "机甲战棋", exact: true }).click();
    const picker = page.getByRole("button", { name: "机甲战棋 1.5 · 本地 PvE", exact: true });
    await picker.waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-mecha-v15=""]').count(), 0, "production query must not bypass the release picker");
    await page.screenshot({ path: `/tmp/mecha-m2-production-${choice}-picker.png` });
    assert.equal(await page.getByRole("button", { name: "经典模式 · 1.4", exact: true }).count(), 0, "classic is no longer offered");
    await page.getByRole("button", { name: "机甲战棋 1.5 · 本地 PvE", exact: true }).click();
    const mode = page.locator('[data-hud-mode="sequential"]');
    await mode.waitFor({ timeout: 120000 });
    assert.equal(await mode.getAttribute("data-hud-phase"), "deployment");
    assert.equal(await mode.getAttribute("data-mecha-v15"), "");
    await page.screenshot({ path: `/tmp/mecha-m2-production-${choice}-selected.png` });
    assert.deepEqual(errors, [], `${choice} production route page errors`);
    console.log(`PASS production ${choice}: release picker, selected route, no page errors`);
    await context.close();
  }
} finally {
  await browser.close();
}
