#!/usr/bin/env node
// Opt-in development UI against synthetic fixture data. No production globals.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { chromium } = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5187";
const species = [
  ["spore_leaper", "spore_leap"], ["flux_lancer", "ring_pierce"], ["porous_shaper", "corrode_cell"],
  ["prism_warden", "prism_guard"], ["swarm_mantle", "split_swarm"], ["phase_stalker", "phase_swap"],
  ["gravity_core", "gravity_well"], ["neural_weaver", "neural_link"],
];
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage(); page.setDefaultTimeout(90000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.routeWebSocket("**/*", ws => ws.close());
  await page.addInitScript(() => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = "en"; });
  await page.route("**/src/game/SequentialMechaMatch.tsx*", async route => {
    const response = await route.fetch(); const source = await response.text();
    const seam = "const state = useSyncExternalStore(controller.subscribe, controller.getState);";
    assert.equal(source.split(seam).length, 2, "controller test seam");
    await route.fulfill({ response, body: source.replace(seam, `${seam} globalThis.__v15PracticeController = controller;`) });
  });
  for (const [id, skill] of species) {
    if (page.url().startsWith(base)) {
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => new Promise(resolve => {
        const request = indexedDB.deleteDatabase("agent-city-mecha-sequential-checkpoint");
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      }));
    }
    errors.length = 0;
    await page.goto(`${base}/?fixtureSessions=30&mechaV15=1&mechaMonster=${id}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "City settings", exact: true }).click();
    await page.getByRole("button", { name: "Mecha tactics", exact: true }).click();
    const root = page.locator("[data-mecha-v15]"); await root.waitFor();
    await page.waitForFunction(id => globalThis.__v15PracticeController.getState().match.monsterContent?.speciesId === id, id);
    await root.locator(".mecha-deploy-list > summary").click();
    const select = page.locator("#mecha-deploy-choice");
    const cells = await select.locator("option").evaluateAll(options => options.map(option => option.value).filter(Boolean));
    assert.ok(cells.length >= 3, `${id}: deployment locations`);
    for (let index = 0; index < 3; index++) {
      await root.locator(".mecha-deploy-roster button").nth(index).click();
      await select.selectOption(cells[index]);
      await page.getByRole("button", { name: "Place mech", exact: true }).click();
    }
    await page.getByRole("button", { name: "Confirm deployment", exact: true }).click();
    await page.waitForFunction(([id, skill]) => {
      const state = globalThis.__v15PracticeController.getState().match;
      return state.phase === "player_plan" && state.monsterContent?.speciesId === id && state.boss.intent?.skillId === skill;
    }, [id, skill]);
    await page.screenshot({ path: `/tmp/mecha-v15-practice-${id}.png` });
    assert.deepEqual(errors, [], `${id}: browser errors`);
    console.log(`${id}: v1.5 practice launched, deployed and declared ${skill}`);
  }
  await context.close();
} finally {
  await browser.close();
}
