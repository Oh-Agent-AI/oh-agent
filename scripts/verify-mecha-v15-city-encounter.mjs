#!/usr/bin/env node
// Exercise a real City encounter in the opt-in synthetic browser fixture.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5187";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(60000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = "zh-Hans"; });
  await page.route("**/src/game/MechaBoard.tsx*", async route => {
    const response = await route.fetch(), source = await response.text();
    const seam = "const v15Site = v15Requested ? encounter?.site ?? SHAPES.map((shape) => catalog[shape.id]).find(Boolean) : null;";
    assert.equal(source.split(seam).length, 2);
    await route.fulfill({ response, body: source.replace(seam, `${seam} globalThis.__encounterTest = { encounter, v15Site };`) });
  });
  await page.goto(`${base}/?fixtureSessions=30&mechaV15=1`, { waitUntil: "domcontentloaded", timeout: 240000 });
  await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 180000 });
  await page.getByRole("tab", { name: "怪兽" }).click();
  const points = page.getByRole("group", { name: "定位遭遇点" }).getByRole("button");
  await points.first().waitFor(); assert.ok(await points.count() > 1);
  for (let i = 0; i < await points.count(); i++) await points.nth(i).click();
  const point = points.first(), label = await point.textContent(); await point.click();
  const marker = page.getByRole("button", { name: `${label}，进入机甲战棋` }); await marker.waitFor({ state: "visible" }); await marker.click();
  await page.locator("[data-mecha-v15]").waitFor();
  const sites = await page.evaluate(() => ({ selected: globalThis.__encounterTest.encounter.site, actual: globalThis.__encounterTest.v15Site }));
  assert.deepEqual(sites.actual, sites.selected, "the clicked encounter supplies the battle site");
  await page.locator(".mecha-deploy-list > summary").click();
  const select = page.locator("#mecha-deploy-choice");
  await page.waitForFunction(() => { const e = document.querySelector('#mecha-deploy-choice'); return e && !e.disabled && e.options.length > 3; });
  const cells = await select.locator("option").evaluateAll(options => options.map(option => option.value).filter(Boolean).slice(0, 3));
  for (const [index, cell] of cells.entries()) {
    await page.locator(".mecha-deploy-roster button").nth(index).click();
    await select.selectOption(cell); await page.getByRole("button", { name: "放置机甲", exact: true }).click();
  }
  await page.getByRole("button", { name: "确认部署", exact: true }).click();
  await page.locator(".mecha-turn-summary [role=status]").waitFor();
  await page.goto(`${base}/?fixtureSessions=30&mechaV15=1&mechaStatus=prism_warden`, { waitUntil: "domcontentloaded", timeout: 240000 });
  await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 180000 });
  await page.getByRole("tab", { name: "怪兽" }).click();
  const again = page.getByRole("group", { name: "定位遭遇点" }).getByRole("button").first();
  await again.waitFor(); const againLabel = await again.textContent(); await again.click();
  const againMarker = page.getByRole("button", { name: `${againLabel}，进入机甲战棋` }); await againMarker.waitFor({ state: "visible" }); await againMarker.click();
  await page.getByText("状态挑战不能使用城市遭遇点", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-mecha-v15]").count(), 0, "status monster must not replace the city's visible monster");
  assert.deepEqual(errors, []);
  console.log("PASS v1.5 City encounter: selected site preserved, deployment confirmed, incompatible status request rejected");
} finally { await browser.close(); }
