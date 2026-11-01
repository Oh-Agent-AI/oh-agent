#!/usr/bin/env node
// Uses only the standalone synthetic three-session City fixture, not native data.
// Start the independent UI dev server first; pass its URL as argv[2].
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: "en-US" });
  page.setDefaultTimeout(240_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("city.seed", "74031"));
  await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await page.locator(".city-loading").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "City settings" }).click();
  const dialog = page.getByRole("dialog", { name: "City settings" });
  await dialog.locator("#city-seed").fill("4196523069");
  await page.evaluate(() => {
    window.__seedTicks = 0;
    window.__seedTickTimer = setInterval(() => { window.__seedTicks++; }, 100);
  });
  await dialog.getByRole("button", { name: "Apply seed" }).click();
  await page.waitForFunction(() => localStorage.getItem("city.seed") === "4196523069", null, { timeout: 240_000 });
  await dialog.getByRole("button", { name: "Mecha tactics" }).waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog[open][aria-label="City settings"]');
    return [...(dialog?.querySelectorAll("button") ?? [])].some((button) => button.textContent === "Mecha tactics" && !button.disabled);
  }, null, { timeout: 240_000 });
  const ticks = await page.evaluate(() => { clearInterval(window.__seedTickTimer); return window.__seedTicks; });
  assert.ok(ticks >= 2, `the page must continue ticking while changing seed (ticks=${ticks})`);
  await dialog.getByRole("button", { name: "Mecha tactics" }).click();
  await page.locator(".mecha-turn-summary").waitFor();
  assert.deepEqual(errors, []);
  console.log(`City seed browser: synthetic initial seed 74031 -> 4196523069, ${ticks} event-loop ticks, battle entry passed. Not a native or physical-input acceptance test.`);
} finally { await browser.close(); }
