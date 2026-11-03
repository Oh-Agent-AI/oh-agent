#!/usr/bin/env node
// Deterministic synthetic City fixture only. Start apps/agent-city/ui's Vite server first:
//   npm run dev -- --port 5178
//   node scripts/verify-city-mecha-battle-browser.mjs http://127.0.0.1:5178
// Requires the Playwright dependency installed under apps/desktop/ui-dev.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, locale: "en-US" });
  page.setDefaultTimeout(240_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("city.seed", "4196523069"));
  await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await page.locator(".city-loading").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "City settings" }).click();
  const enter = page.getByRole("button", { name: "Mecha tactics" });
  await enter.scrollIntoViewIfNeeded();
  await enter.click();
  await page.locator(".mecha-turn-summary").waitFor();

  // The order list and threat controls must expose the same actors and share focus.
  const orderToggle = page.getByRole("button", { name: "Attack order", exact: true });
  await orderToggle.focus();
  await page.keyboard.press("Enter");
  const orderButtons = page.locator(".mecha-order ol button");
  const threatButtons = page.locator(".mecha-threat-sources button");
  assert.deepEqual(await orderButtons.allTextContents(), await threatButtons.allTextContents());
  assert.ok(await orderButtons.count() > 0, "fixture must contain predicted enemy attacks");
  await orderButtons.first().focus();
  await page.keyboard.press("Enter");
  assert.equal(await orderButtons.first().getAttribute("aria-pressed"), "true");
  assert.equal(await threatButtons.first().getAttribute("aria-pressed"), "true");
  await orderToggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".mecha-order").count(), 0);

  const submit = page.locator(".mecha-submit-primary");
  await submit.click();
  assert.match(await page.locator(".mecha-hold-confirm").innerText(), /Predicted building loss 12/);
  await page.getByRole("button", { name: "Return to editing" }).click();
  assert.equal(await page.locator(".mecha-hold-confirm").count(), 0);
  await submit.click();
  await page.getByRole("button", { name: "Submit anyway" }).click();
  const skip = page.getByRole("button", { name: "Skip animation" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.waitForFunction(() => document.querySelector(".mecha-building-current")?.textContent?.includes("68/80"), null, { timeout: 240_000 });

  await page.locator(".mecha-move-list summary").click();
  await page.locator(".mecha-pack li > button").first().click();
  // Playwright's headless macOS native select does not reliably process arrow
  // keys, even in an isolated select; this is not a physical-keyboard check.
  await page.locator(".mecha-move-list select").selectOption("3,2");
  await page.getByRole("button", { name: "Apply move" }).focus();
  await page.keyboard.press("Enter");
  await page.locator(".mecha-selected-actions > .mecha-actions > button").filter({ hasText: /^Melee$/ }).click();
  const before = await page.locator(".mecha-pack").innerText();
  await page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: "Boss" }).click();
  const candidate = await page.locator(".mecha-candidate-result").innerText();
  for (const text of ["Direct damage 2", "Boss HP 40 → 38", "Boss HP 38 → 36", "West raider HP 8 → 6", "Target HP after the whole turn 36"]) assert.ok(candidate.includes(text), `missing candidate result: ${text}`);
  assert.equal(await page.locator(".mecha-pack").innerText(), before, "selection preview must not change draft");
  const layout = await page.evaluate(() => {
    const summary = document.querySelector(".mecha-turn-summary").getBoundingClientRect();
    const panel = document.querySelector(".mecha-selected-actions").getBoundingClientRect();
    const result = document.querySelector(".mecha-candidate-result").getBoundingClientRect();
    return { summaryBottom: summary.bottom, panelTop: panel.top, panelBottom: panel.bottom, resultBottom: result.bottom };
  });
  assert.ok(layout.summaryBottom <= layout.panelTop, `HUD panels overlap: ${JSON.stringify(layout)}`);
  assert.ok(layout.resultBottom <= layout.panelBottom, `candidate confirmation clipped: ${JSON.stringify(layout)}`);
  await page.getByRole("button", { name: "Confirm target" }).focus();
  await page.keyboard.press("Enter");
  assert.match(await page.locator(".mecha-pack li").first().innerText(), /Melee Boss/);

  // Pausing must lock planning without losing the confirmed draft.
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByText("Battlefield settings and rules", { exact: true }).click();
  const doctrine = page.locator(".mecha-toolbar label").filter({ hasText: /^Doctrine/ }).locator("select");
  const pausedDraft = await page.locator(".mecha-pack").innerText();
  assert.equal(await doctrine.isDisabled(), true, "doctrine must be locked during pause");
  assert.equal(await page.locator(".mecha-submit-primary").isDisabled(), true);
  assert.equal(await page.locator(".mecha-selected-actions > .mecha-actions > button").filter({ hasText: /^Melee$/ }).isDisabled(), true);
  assert.match(await page.locator(".mecha-pack li").first().innerText(), /Melee Boss/);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  assert.equal(await doctrine.isEnabled(), true, "doctrine must be available after resume");
  assert.equal(await page.locator(".mecha-pack").innerText(), pausedDraft, "pause/resume must preserve the draft");
  assert.match(await page.locator(".mecha-pack li").first().innerText(), /Melee Boss/);
  await page.getByRole("button", { name: "Exit battle", exact: true }).click();
  assert.equal(await page.locator(".mecha-overlay").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Mecha browser: synthetic hold-risk/cancel/submit, order/threat focus, keyboard activation of move and confirmation, target preview, pause/resume/exit, and 1100×700 panel separation passed. Not native, real-device, performance or user acceptance.");
} finally {
  await browser.close();
}
