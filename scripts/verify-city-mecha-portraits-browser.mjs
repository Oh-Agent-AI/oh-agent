#!/usr/bin/env node
// Synthetic fixture only. Checks existing concept-art bytes render and degrade
// honestly; head bars and lower-left portrait placement are checked separately from gameplay.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5198";
const output = process.env.MECHA_SCREENSHOTS_DIR;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: process.env.MECHA_BROWSER_ANGLE === "metal" ? ["--use-angle=metal"] : ["--enable-unsafe-swiftshader"] });
const results = [];
try {
  for (const locale of ["zh-Hans", "en"]) for (const [width, height] of [[640, 480], [800, 600], [1100, 700]]) {
    const context = await browser.newContext({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const lang = locale === "en" ? "en" : "zh";
    const text = (zh, en) => lang === "en" ? en : zh;
    const button = (zh, en) => page.getByRole("button", { name: text(zh, en), exact: true });
    try {
      await page.addInitScript((locale) => {
        localStorage.setItem("city.seed", "4196523069");
        window.__AV_PLUGIN_LOCALE__ = locale;
        const frame = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window);
        const pending = new Map(); let sequence = 0;
        window.requestAnimationFrame = (callback) => {
          const id = ++sequence;
          const timer = setTimeout(() => { const handle = frame((time) => { pending.delete(id); callback(time); }); pending.set(id, { handle }); }, 100);
          pending.set(id, { timer }); return id;
        };
        window.cancelAnimationFrame = (id) => { const entry = pending.get(id); if (entry?.timer !== undefined) clearTimeout(entry.timer); if (entry?.handle !== undefined) cancel(entry.handle); pending.delete(id); };
      }, locale);
      const response = await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 90_000 });
      assert.ok(response?.ok());
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 90_000 });
      const enter = async () => { await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click(); await page.locator(".mecha-turn-summary").waitFor({ timeout: 90_000 }); };
      await enter();
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll(".mecha-plan-card__avatar img, .mecha-selected-portrait img")];
        return images.length === 4 && images.every((img) => img.complete && img.naturalWidth === 256 && img.naturalHeight === 256);
      }, null, { timeout: 90_000 });
      await page.waitForTimeout(700);
      const roster = await page.locator(".mecha-plan-card__avatar [data-portrait-key]").evaluateAll((els) => els.map((el) => ({ id: el.dataset.unitId, key: el.dataset.portraitKey, hidden: el.getAttribute("aria-hidden") })));
      assert.deepEqual(roster.map(({ id, key }) => [id, key]), [["Assault", "assault"], ["Gunner", "gunner"], ["Support", "support"]]);
      assert.ok(roster.every((r) => r.hidden === "true"), "decorative art must not duplicate button names");
      assert.equal(await page.locator(".mecha-world-unit-badge, .mecha-world-unit-leader").count(), 0, "no identity cards or connectors on the board");
      const world = await page.locator(".mecha-world-healthbar").evaluateAll((els) => els.map((el) => ({ id: el.dataset.unitId, hidden: el.hidden, hp: Number(el.getAttribute("aria-valuenow")), max: Number(el.getAttribute("aria-valuemax")), fill: parseFloat(el.firstElementChild.style.width), width: el.getBoundingClientRect().width, children: el.children.length })));
      assert.equal(world.length, 6);
      assert.ok(world.every((unit) => !unit.hidden), "all six bars visible in default synthetic planning view");
      const expected = { Assault: 14, Gunner: 11, Support: 12, boss: 40, "raider-w": 8, "raider-e": 8 };
      for (const unit of world) { assert.equal(unit.max, expected[unit.id], unit.id); assert.equal(unit.fill, unit.hp / unit.max * 100); assert.ok(unit.width <= 42); assert.equal(unit.children, 1); }
      assert.equal(await page.locator(".mecha-world-healthbar img").count(), 0);
      const portrait = page.locator(".mecha-selected-portrait");
      assert.equal(await portrait.getAttribute("data-unit-id"), "Assault");
      const portraitBox = await portrait.boundingBox(); assert.ok(portraitBox.width >= 80 && portraitBox.height >= 80);
      assert.ok(portraitBox.x < width / 2 && portraitBox.y > height / 2, "large portrait belongs at lower left");
      for (const [nameZh, nameEn, id] of [["射手", "Gunner", "Gunner"], ["支援", "Support", "Support"], ["突击", "Assault", "Assault"]]) {
        await page.locator(".mecha-plan-card__select").filter({ hasText: text(nameZh, nameEn) }).click();
        assert.equal(await portrait.getAttribute("data-unit-id"), id);
        await portrait.locator("img").waitFor();
        await page.waitForFunction((unitId) => document.querySelector(`.mecha-world-healthbar[data-unit-id="${unitId}"]`)?.classList.contains("is-selected"), id);
        assert.equal(await page.locator(`.mecha-world-healthbar[data-unit-id='${id}']`).getAttribute("class"), "mecha-world-healthbar is-selected");
      }
      assert.equal(await page.locator(".mecha-tactical-legend").evaluate((el) => el.open), false);
      for (const card of await page.locator(".mecha-plan-card__plan").all()) {
        assert.equal(await card.evaluate((el) => el.open), false);
        await card.locator("summary").click();
        assert.ok((await card.locator(".mecha-plan-card__detail").innerText()).length > 0);
        await card.locator("summary").click();
      }
      const occlusions = await page.evaluate(() => {
        const selectors = [".mecha-battle-bar", ".mecha-tactical-legend", ".mecha-team-planning", ".mecha-turn-summary", ".mecha-selected-actions"];
        const blockers = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).filter((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().height);
        return [...document.querySelectorAll(".mecha-world-healthbar")].filter((el) => !el.hidden).flatMap((el) => {
          const a = el.getBoundingClientRect();
          const blocked = blockers.filter((other) => { const b = other.getBoundingClientRect(); return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top); }).map((other) => other.className);
          return blocked.length ? [{ id: el.dataset.unitId, blocked }] : [];
        });
      });
      assert.deepEqual(occlusions, [], "default head bars must not be covered by HUD");
      if (output) await page.screenshot({ path: join(output, `portraits-planning-${lang}-${width}x${height}.png`) });
      const threat = page.locator("details.mecha-threat-details");
      await threat.locator("summary").click();
      await page.waitForFunction(() => [...document.querySelectorAll(".mecha-threat-sources img")].length === 3 && [...document.querySelectorAll(".mecha-threat-sources img")].every((img) => img.complete && img.naturalWidth === 256));
      const threatKeys = await page.locator(".mecha-threat-sources [data-portrait-key]").evaluateAll((els) => els.map((el) => el.dataset.portraitKey));
      assert.deepEqual(threatKeys, ["boss", "raider", "raider"]);
      await threat.locator("summary").click();
      // Exercise the real component's error handler; do not replace artwork with
      // another known role when a load fails. This is not a transport failure test.
      const firstAvatar = page.locator(".mecha-plan-card__avatar [data-unit-id='Assault']");
      await firstAvatar.locator("img").dispatchEvent("error");
      await page.waitForFunction(() => document.querySelector(".mecha-plan-card__avatar [data-unit-id='Assault']")?.dataset.portraitState === "unavailable");
      assert.equal(await firstAvatar.locator("img").count(), 0);
      assert.equal((await firstAvatar.innerText()).trim(), "⚔");
      const selectedImg = page.locator(".mecha-selected-portrait img");
      await selectedImg.dispatchEvent("error");
      assert.equal(await page.locator(".mecha-selected-portrait").getAttribute("data-portrait-state"), "unavailable");
      assert.equal(await selectedImg.count(), 0);
      // Remount checks the ordinary successful path recovers without stale badges.
      await page.locator(".mecha-battle-menu > summary").click();
      await button("退出战斗", "Exit battle").click();
      await page.locator(".mecha-overlay").waitFor({ state: "hidden" });
      assert.equal(await page.locator(".mecha-world-healthbar").count(), 0);
      await enter();
      await page.waitForFunction(() => [...document.querySelectorAll(".mecha-plan-card__avatar img, .mecha-selected-portrait img")].length === 4 && [...document.querySelectorAll(".mecha-plan-card__avatar img, .mecha-selected-portrait img")].every((img) => img.complete && img.naturalWidth === 256 && !img.hidden));
      assert.equal(await page.locator(".mecha-world-healthbar").count(), 6);
      assert.deepEqual(errors, []);
      results.push({ lang, width, height, status: "passed", occlusions });
      console.log(`PASS portraits ${lang} ${width}x${height}; visual occlusions=${occlusions.length}`);
    } catch (error) {
      results.push({ lang, width, height, status: "failed", error: error.message });
      console.error(`FAIL portraits ${lang} ${width}x${height}: ${error.stack}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
if (output) await writeFile(join(output, "portraits-browser-results.json"), JSON.stringify({ date: new Date().toLocaleDateString("en-CA"), executedAt: new Date().toISOString(), syntheticSeed: "4196523069", browser: "headless Chromium", deviceScaleFactor: 1, results, limitations: "Head-bar structure, real rule maxima, lower-left concept-art portrait, compact disclosures and lifecycle; no native/Tauri/real-session/network/performance tests. Occlusions are measured separately." }, null, 2));
if (results.some((r) => r.status !== "passed")) process.exitCode = 1;
