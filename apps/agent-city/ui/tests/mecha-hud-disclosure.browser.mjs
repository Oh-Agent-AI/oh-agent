#!/usr/bin/env node
// Synthetic HUD regression. Start this worktree's UI Vite server on port 5178.
// Intercepts only fixture setup/preview: blank opening draft and a switchable
// preview fault. It does not test native Tauri, actual touch, or board picking.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const locale of ["zh-Hans", "en"]) {
    const zh = locale === "zh-Hans";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let patched = 0;
    await page.route("**/src/game/mecha/controller.ts*", async (route) => {
      const response = await route.fetch();
      let source = await response.text();
      const draft = "let draft = openingDraft(match);";
      const preview = "const previewTurn = init.preview ?? previewPlan;";
      assert.equal(source.split(draft).length, 2);
      assert.equal(source.split(preview).length, 2);
      source = source.replace(draft, "let draft = blankDraft(match);");
      source = source.replace(preview, `const previewTurn = (...args) => {
        if (globalThis.__hudPreviewFailure) throw new Error("synthetic preview failure");
        return (init.preview ?? previewPlan)(...args);
      };`);
      patched++;
      await route.fulfill({ response, body: source });
    });
    await page.addInitScript((language) => {
      localStorage.setItem("city.seed", "4196523069");
      window.__AV_PLUGIN_LOCALE__ = language;
      const frame = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map(); let sequence = 0;
      window.requestAnimationFrame = (callback) => {
        const id = ++sequence;
        const timer = setTimeout(() => { const handle = frame((time) => { pending.delete(id); callback(time); }); pending.set(id, { handle }); }, 100);
        pending.set(id, { timer }); return id;
      };
      window.cancelAnimationFrame = (id) => { const entry = pending.get(id); if (entry?.timer !== undefined) clearTimeout(entry.timer); if (entry?.handle !== undefined) cancel(entry.handle); pending.delete(id); };
    }, locale);
    const button = (zhName, enName) => page.getByRole("button", { name: zh ? zhName : enName, exact: true });
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 90_000 });
    assert.equal(patched, 1);
    await button("城市设置", "City settings").click();
    await button("机甲战棋", "Mecha tactics").click();
    await page.locator(".mecha-turn-summary").waitFor();
    await page.setViewportSize({ width: 640, height: 480 });
    await page.waitForTimeout(500);
    const summary = page.locator(".mecha-turn-summary");
    const quick = page.locator(".mecha-panel > .mecha-quick-resource");
    const risk = page.locator("details.mecha-risk-details");
    const threats = page.locator("details.mecha-threat-details");
    assert.equal(await summary.evaluate((e) => e.classList.contains("is-compact")), true);
    assert.match(await quick.innerText(), zh ? /假设待机/ : /Assumed/);
    assert.equal(await quick.isVisible(), true);
    const assertQuickUnclipped = async (label) => {
      const clipped = await quick.evaluate((el) => {
        const root = el.getBoundingClientRect();
        const issues = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const r of range.getClientRects()) {
            if (r.left < root.left - 0.5 || r.right > root.right + 0.5 || r.top < root.top - 0.5 || r.bottom > root.bottom + 0.5 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) issues.push({ text: node.textContent, rect: r.toJSON(), root: root.toJSON() });
            const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
            if (!hit || !el.contains(hit)) issues.push({ text: node.textContent, blockedBy: hit?.className, rect: r.toJSON() });
          }
        }
        return issues;
      });
      assert.deepEqual(clipped, [], `${locale} 640x480 ${label}: quick resource clipped or covered`);
    };
    await assertQuickUnclipped("assumed hold");
    if (process.env.MECHA_HUD_QUICK_ONLY === "1") {
      await page.evaluate(() => { globalThis.__hudPreviewFailure = true; });
      await button("待机", "Hold").click();
      await summary.locator(".mecha-forecast-status[role=status]").waitFor();
      assert.match(await quick.innerText(), zh ? /风险未知/ : /Risk unknown/);
      assert.doesNotMatch(await quick.innerText(), zh ? /→|预计/ : /→|Predicted/);
      await assertQuickUnclipped("prediction failure");
      assert.equal(errors.length, 0, errors.join("\n"));
      console.log(`PASS ${locale} 640x480: assumed hold and unknown quick summary fully visible and unobscured`);
      await context.close();
      continue;
    }
    assert.match(await summary.locator(".mecha-forecast-status").innerText(), zh ? /假设待机/ : /Assumed/);
    assert.equal(await risk.evaluate((e) => e.open), false);
    assert.equal(await threats.evaluate((e) => e.open), false);
    const threatSummary = threats.locator("summary");
    await threatSummary.scrollIntoViewIfNeeded(); await threatSummary.focus(); await page.keyboard.press("Enter");
    assert.equal(await threats.evaluate((e) => e.open), true);
    assert.match(await threats.innerText(), zh ? /当前宣告威胁[\s\S]*草稿试算威胁/ : /Declared threats[\s\S]*Projected threats for this plan/);
    const source = threats.locator(".mecha-threat-sources button").first();
    assert.ok(await source.count() > 0, "synthetic fixture must have a projected source");
    await source.scrollIntoViewIfNeeded(); await source.focus(); await page.keyboard.press("Enter");
    assert.equal(await source.getAttribute("aria-pressed"), "true");
    await threatSummary.scrollIntoViewIfNeeded(); await threatSummary.click();
    const order = button("结算顺序", "Attack order");
    await order.scrollIntoViewIfNeeded(); await order.click();
    assert.match(await page.locator(".mecha-order").innerText(), zh ? /草稿试算，不是当前宣告/ : /draft projection, not the current declaration/);
    assert.match(await page.locator(".mecha-order-help").innerText(), zh ? /棋盘不保证显示编号/ : /not guaranteed on the board/);
    await order.scrollIntoViewIfNeeded(); await order.click();
    await page.evaluate(() => { globalThis.__hudPreviewFailure = true; });
    await button("待机", "Hold").click();
    const status = summary.locator(".mecha-forecast-status[role=status]");
    await status.waitFor();
    assert.match(await quick.innerText(), zh ? /风险未知/ : /Risk unknown/);
    await assertQuickUnclipped("prediction failure");
    assert.doesNotMatch(await quick.innerText(), zh ? /→|预计/ : /→|Predicted/);
    assert.match(await status.innerText(), zh ? /风险未知/ : /unavailable/i);
    assert.equal(await risk.count(), 0);
    await threatSummary.scrollIntoViewIfNeeded(); await threatSummary.click();
    assert.match(await threats.innerText(), zh ? /草稿试算未知.*当前宣告/ : /Draft projection unknown.*declared threats/);
    assert.match(await threats.locator(".mecha-threat-sources").getAttribute("aria-label"), zh ? /当前宣告/ : /Declared/);
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(`PASS ${locale} 640x480: assumed hold, disclosures, keyboard source selection, order copy and unknown fallback`);
    await context.close();
  }
} finally { await browser.close(); }
