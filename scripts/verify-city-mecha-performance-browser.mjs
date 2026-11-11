#!/usr/bin/env node
// Local synthetic high-threat performance baseline, not physical-input or user testing.
// Start Vite first; use a headed Chrome on the intended desktop and inspect GPU details.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.argv[3] ?? "/tmp/mecha-performance-browser.json";
const browser = await chromium.launch({ headless: false, executablePath: process.env.MECHA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
    assert.ok(body.includes(needle), "controller instrumentation point changed");
    body = `import { createMatch as fixtureMatch, bossPrepare as prepareFixture, living as fixtureLiving } from "/src/game/mecha/rules.ts";\n` + body;
    body = body.replace(needle, `const fixture = fixtureMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [],
      buildings: Array.from({ length: 10 }, (_, x) => ({ id: 'fixture-building-' + x, cells: [{ x, y: 8 }] })), boss: { x: 4, y: 0 },
      raiders: [{ id: "raider-w", pos: { x: 4, y: 4 } }, { id: "raider-e", pos: { x: 6, y: 4 } }],
      mechs: [{ id: "Assault", pos: { x: 5, y: 2 } }, { id: "Gunner", pos: { x: 6, y: 3 } }, { id: "Support", pos: { x: 6, y: 2 } }] });
      prepareFixture(fixture);
      controllerRef.current = createMechaController({ animate: true, locale, site, match: fixture,
        planner: (state) => ({ revision: state.revision, items: fixtureLiving(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) }) });`);
    await route.fulfill({ response, body });
  });
  await page.addInitScript(() => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = "en"; });
  await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await page.locator(".city-loading").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "City settings" }).click();
  await page.getByRole("button", { name: "Mecha tactics" }).click();
  const sources = page.locator(".mecha-threat-sources button");
  await sources.first().waitFor();
  assert.equal(await sources.count(), 3);
  const sourceText = await sources.allTextContents();
  for (const coordinate of ["5,2", "4,8", "6,8"]) assert.equal(sourceText.filter((text) => text.includes(coordinate)).length, 1);
  await page.locator(".mecha-pack li > button").nth(2).click();
  await page.locator(".mecha-selected-actions > .mecha-actions > button").filter({ hasText: /^Repair$/ }).click();
  const targets = page.locator(".mecha-target-preview .mecha-actions > button");
  await targets.first().waitFor();
  assert.equal(await targets.count(), 2);
  assert.match(await targets.nth(0).innerText(), /Assault/);
  assert.match(await targets.nth(1).innerText(), /Gunner/);
  // Let initial asset loads and the scene settle; don't warm the candidate cache.
  await page.waitForTimeout(5000);
  const report = await page.evaluate(async () => {
    if (document.visibilityState !== "visible") throw new Error("headed browser is not visible");
    const canvas = document.querySelector("canvas");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    const gpu = debug ? { vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) } : null;
    const supportsLongTasks = PerformanceObserver.supportedEntryTypes.includes("longtask");
    const longTasks = [];
    const observer = supportsLongTasks ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })))) : null;
    observer?.observe({ type: "longtask", buffered: false });
    let running = true;
    let previous = null;
    const frameGaps = [];
    const frame = (now) => { if (previous !== null) frameGaps.push(now - previous); previous = now; if (running) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const label = i % 2 ? "Gunner" : "Assault";
      const button = [...document.querySelectorAll(".mecha-target-preview .mecha-actions > button")].find((item) => item.textContent.includes(label));
      if (!button) throw new Error(`missing ${label} target`);
      const start = performance.now();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { mo.disconnect(); reject(new Error(`result timeout for ${label}`)); }, 5000);
        const mo = new MutationObserver(() => {
          if (document.querySelector(".mecha-candidate-result strong")?.textContent?.includes(label)) {
            clearTimeout(timeout); mo.disconnect(); resolve();
          }
        });
        mo.observe(document.querySelector(".mecha-target-preview"), { subtree: true, childList: true, characterData: true });
        button.click();
      });
      // The second animation frame is a conservative paint opportunity, not a physical-input latency.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      samples.push({ target: label, ms: performance.now() - start });
    }
    running = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    observer?.disconnect();
    const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b);
    return { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, visibility: document.visibilityState,
      gpu, supportsLongTasks, samples, p50: (sorted[9] + sorted[10]) / 2, p95: sorted[18], maxFrameGap: Math.max(...frameGaps), longTasks };
  });
  assert.equal(report.samples.length, 20);
  assert.deepEqual(errors, []);
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${output}. Programmatic selection with a headed browser: not physical input, Tauri, or user acceptance.`);
  await context.close();
} finally { await browser.close(); }
