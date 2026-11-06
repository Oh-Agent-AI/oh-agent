#!/usr/bin/env node
// Start City Vite first, then: node scripts/verify-city-driving-browser.mjs http://127.0.0.1:5179
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5179";
const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--use-angle=metal"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL("/driving.html", base).href);
  const stage = page.locator("#stage");
  const paused = (value) => page.waitForFunction((expected) => document.querySelector("#stage").dataset.paused === expected, String(value));
  const read = async () => stage.evaluate((element) => ({ ...element.dataset }));
  await paused(true); await page.click("#pause"); await paused(false);
  await page.keyboard.down("w"); await page.waitForTimeout(1200); await page.keyboard.up("w");
  let state = await read(); assert.ok(Number(state.x) > -21); assert.ok(Number(state.speed) > 0);
  await page.keyboard.down("d"); await page.keyboard.down("w"); await page.waitForTimeout(450);
  await page.keyboard.up("w"); await page.keyboard.up("d");
  assert.ok(Number((await read()).z) > 0.01, "D steers toward +Z");
  await page.click("#pause"); await paused(true);
  const frozen = await read(); await page.waitForTimeout(200);
  assert.equal((await read()).x, frozen.x);
  await page.click("#pause"); await paused(false);
  await page.keyboard.press("r"); await page.waitForTimeout(150);
  assert.equal(Number((await read()).x), -22);
  await page.keyboard.down("s"); await page.waitForTimeout(600); await page.keyboard.up("s");
  assert.ok(Number((await read()).speed) < 0);
  // Clicking another control loses canvas focus; old keys must never resume.
  await page.locator("#reset").focus(); await paused(true);
  await page.keyboard.down("w"); await page.waitForTimeout(150); await page.keyboard.up("w");
  const blurred = await read(); await page.waitForTimeout(150); assert.equal((await read()).x, blurred.x);
  await page.click("#pause"); await paused(false); await page.keyboard.press("r");
  await page.keyboard.down("w");
  await page.waitForFunction(() => Number(document.querySelector("#stage").dataset.x) > -21);
  await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await paused(true);
  await page.keyboard.up("w"); await page.click("#pause"); await paused(false);
  await page.keyboard.press("Escape"); await paused(true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log("Driving browser verified: forward, turn, reverse, reset, button/Escape pause, blur clears keys, control focus isolation, narrow layout, no page errors.");
} finally { await browser.close(); }
