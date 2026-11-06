#!/usr/bin/env node
// Synthetic local City fixture. Uses real deployment and the current separate
// top-bar settings panels. No relay is started and no native/device or full
// accessibility acceptance is implied. MECHA_VIEWPORT and MECHA_LANG can
// select a subset; MECHA_SCREENSHOTS_DIR captures the corresponding views.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { completeLocalDeployment } from "./mecha-deployment-browser-helpers.mjs";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
const dpr = Number(process.env.MECHA_DPR ?? 1);
const requestedSizes = process.env.MECHA_VIEWPORT?.split(",").map(value => value.match(/^(\d+)x(\d+)$/));
assert.ok(Number.isFinite(dpr) && dpr > 0, "MECHA_DPR must be positive");
assert.ok(!requestedSizes || requestedSizes.every(Boolean), "MECHA_VIEWPORT must be WIDTHxHEIGHT[,WIDTHxHEIGHT...]");
const sizes = requestedSizes ? requestedSizes.map(match => [Number(match[1]), Number(match[2])]) : [[1100, 700], [1440, 900], [640, 480], [390, 844]];
assert.ok(sizes.every(([width, height]) => width > 0 && height > 0));
const langs = process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["en", "zh"];
assert.ok(langs.every(lang => ["en", "zh"].includes(lang)));
if (output) await mkdir(output, { recursive: true });

// Check the whole element against the viewport and every clipping ancestor;
// a real center hit-test detects overlays, not just DOM visibility.
async function assertUsable(locator, label) {
  assert.equal(await locator.count(), 1, `${label}: expected exactly one element`);
  const state = await locator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    let clippedBy = null;
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if ((/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.left < box.left - 1 || rect.right > box.right + 1)) ||
          (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1))) {
        clippedBy = parent.className || parent.tagName; break;
      }
    }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { rect: rect.toJSON(), clippedBy, hit: !!hit && (hit === el || el.contains(hit)), hitTag: hit?.outerHTML.slice(0, 150),
      viewport: rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
      displayed: getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility === "visible" };
  });
  assert.ok(state.displayed && state.viewport && !state.clippedBy && state.hit, `${label}: ${JSON.stringify(state)}`);
}

const browser = await chromium.launch({ headless: true, args: [process.env.MECHA_BROWSER_ANGLE === "metal" ? "--use-angle=metal" : "--enable-unsafe-swiftshader"] });
try {
  for (const lang of langs) {
    const zh = lang === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US", deviceScaleFactor: dpr });
    const page = await context.newPage(); page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(locale => {
      localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale;
      const frame = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window);
      const pending = new Map(); let sequence = 0;
      window.requestAnimationFrame = callback => {
        const id = ++sequence;
        const timer = setTimeout(() => { const handle = frame(time => { pending.delete(id); callback(time); }); pending.set(id, { handle }); }, 100);
        pending.set(id, { timer }); return id;
      };
      window.cancelAnimationFrame = id => { const task = pending.get(id); if (task?.timer !== undefined) clearTimeout(task.timer); if (task?.handle !== undefined) cancel(task.handle); pending.delete(id); };
    }, zh ? "zh-Hans" : "en");
    const button = (z, e) => page.getByRole("button", { name: zh ? z : e, exact: true });
    const fieldEntry = page.locator('[data-mecha-settings-trigger="battlefield"]');
    const remoteEntry = page.locator('[data-mecha-settings-trigger="remote"]');
    const field = page.locator("#mecha-battlefield-settings"), remote = page.locator("#mecha-remote-settings");
    try {
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 240_000 });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await completeLocalDeployment(page);
      const pack = page.locator(".mecha-pack");
      const draft = await pack.innerText();
      assert.equal(await page.evaluate(() => devicePixelRatio), dpr);
      for (const [width, height] of sizes) {
        const label = `${lang} ${width}x${height}`;
        console.log(`START ${label}`);
        await page.setViewportSize({ width, height }); await page.waitForTimeout(400);
        assert.equal(await page.locator(".mecha-options-menu").count(), 0, `${label}: old nested menu should be absent`);
        await assertUsable(fieldEntry, `${label} battlefield entry`); await assertUsable(remoteEntry, `${label} remote entry`);
        await assertUsable(page.locator(".mecha-submit-primary"), `${label} submit`);
        const cards = pack.locator("li.mecha-plan-card"); assert.equal(await cards.count(), 3);
        for (const card of await cards.all()) {
          const select = card.locator(".mecha-plan-card__select");
          await select.scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
          await assertUsable(select, `${label} roster select`);
          const text = card.locator(".mecha-plan-card__status"); await text.scrollIntoViewIfNeeded();
          const overflow = await text.evaluate(el => ({ horizontal: el.scrollWidth > el.clientWidth + 1, vertical: el.scrollHeight > el.clientHeight + 1 }));
          assert.deepEqual(overflow, { horizontal: false, vertical: false }, `${label} roster status clipped`);
        }
        await fieldEntry.click();
        assert.equal(await fieldEntry.getAttribute("aria-expanded"), "true"); assert.equal(await remote.isVisible(), false);
        await assertUsable(field.locator(".mecha-settings-close"), `${label} battlefield close`);
        assert.equal(await field.locator("select").count(), 3, `${label} battlefield/script/doctrine controls`);
        const body = field.locator(".mecha-settings-body");
        const select = field.locator("select").first(); await select.scrollIntoViewIfNeeded(); await assertUsable(select, `${label} battlefield select`);
        await select.focus(); assert.ok(await select.evaluate(el => document.activeElement === el), `${label} battlefield select focus`);
        const teamBefore = await pack.evaluate(el => el.scrollTop);
        const rules = field.locator(".mecha-ruleset"); await rules.scrollIntoViewIfNeeded(); await assertUsable(rules, `${label} rules after scrolling`);
        assert.equal(await pack.evaluate(el => el.scrollTop), teamBefore, `${label} settings scrolling must not scroll roster`);
        if (output) await page.screenshot({ path: join(output, `settings-field-${lang}-${width}x${height}-dpr${dpr}.png`) });
        await remoteEntry.click();
        assert.equal(await field.isVisible(), false); assert.equal(await fieldEntry.getAttribute("aria-expanded"), "false");
        assert.equal(await remoteEntry.getAttribute("aria-expanded"), "true");
        await assertUsable(remote.locator(".mecha-settings-close"), `${label} remote close`);
        const relay = remote.locator('input[type="url"]'); await relay.scrollIntoViewIfNeeded(); await assertUsable(relay, `${label} relay input`);
        await relay.fill("https://fake.invalid");
        if (output) await page.screenshot({ path: join(output, `settings-remote-${lang}-${width}x${height}-dpr${dpr}.png`) });
        await remote.locator(".mecha-settings-close").click();
        assert.equal(await remote.isVisible(), false); assert.ok(await remoteEntry.evaluate(el => document.activeElement === el), `${label} close restores opener focus`);
        await remoteEntry.click(); assert.equal(await relay.inputValue(), "https://fake.invalid", `${label} remote form survives hiding`);
        await relay.focus(); await page.keyboard.press("Escape");
        assert.equal(await remote.isVisible(), true, `${label} Escape in an input must not dismiss the form`);
        assert.equal(await page.locator('.mecha-overlay[data-phase="player_plan"]').count(), 1, `${label} input Escape must not exit battle`);
        await remote.locator(".mecha-settings-close").focus(); await page.keyboard.press("Escape");
        assert.equal(await remote.isVisible(), false); assert.equal(await page.locator('.mecha-overlay[data-phase="player_plan"]').count(), 1, `${label} Escape must not exit battle`);
        await fieldEntry.click();
        const resetView = button("重置视角", "Reset view"); await assertUsable(resetView, `${label} outside control`); await resetView.click();
        assert.equal(await field.isVisible(), false, `${label} outside click dismisses settings`);
        assert.equal(await pack.innerText(), draft, `${label} opening and closing settings must preserve draft`);
        await assertUsable(page.locator(".mecha-submit-primary"), `${label} submit after dismissal`);
        // DOM-only layout stress, not a gameplay assertion: exercise the current
        // roster structure with long status text and an incoming-hit label.
        const stressed = cards.first();
        await stressed.evaluate((card, isZh) => {
          const summary = card.querySelector(".mecha-plan-card__plan > summary");
          summary.dataset.testOriginal = summary.innerHTML;
          summary.querySelector(".mecha-plan-card__status").textContent = isZh ? "全队建议 预计行动落空" : "Team suggestion forecast fizzles";
          let risk = summary.querySelector(":scope > .mecha-plan-card__risk");
          if (!risk) { risk = document.createElement("span"); risk.className = "mecha-plan-card__risk"; summary.append(risk); }
          risk.textContent = isZh ? "受击 10" : "Hit 10";
        }, zh);
        try {
          const status = stressed.locator(".mecha-plan-card__status");
          await status.scrollIntoViewIfNeeded(); await page.waitForTimeout(350);
          await assertUsable(status, `${label} long roster status`);
          const stress = await stressed.evaluate(card => {
            const summary = card.querySelector(".mecha-plan-card__plan > summary"), outer = card.getBoundingClientRect();
            return [...summary.querySelectorAll(".mecha-plan-card__status, :scope > .mecha-plan-card__risk")].map(el => {
              const rect = el.getBoundingClientRect();
              return { text: el.textContent, clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 || rect.left < outer.left - 1 || rect.right > outer.right + 1 || rect.top < outer.top - 1 || rect.bottom > outer.bottom + 1 };
            });
          });
          assert.equal(stress.length, 2); assert.ok(stress.every(item => !item.clipped), `${label} long status or hit clipped: ${JSON.stringify(stress)}`);
          await assertUsable(page.locator(".mecha-submit-primary"), `${label} submit with long roster text`);
          if (output) await page.screenshot({ path: join(output, `settings-roster-stress-${lang}-${width}x${height}-dpr${dpr}.png`) });
        } finally {
          await stressed.evaluate(card => { const summary = card.querySelector(".mecha-plan-card__plan > summary"); summary.innerHTML = summary.dataset.testOriginal; delete summary.dataset.testOriginal; });
        }
        console.log(`PASS ${label}: settings, independent scroll, focus, dismissal and roster`);
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log("Synthetic settings layout passed; no native/device, accessibility, real relay or performance acceptance.");
} finally { await browser.close(); }
