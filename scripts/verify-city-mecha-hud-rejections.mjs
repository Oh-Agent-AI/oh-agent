#!/usr/bin/env node
// Unmodified demo projection and UI: no source interception or controller fixture.
// Headless Chromium geometry is not physical-device or screen-reader acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178", screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
const failures = [];
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const zh = lang === "zh";
    const context = await browser.newContext({ viewport: { width: 640, height: 480 }, hasTouch: true, locale: zh ? "zh-CN" : "en-US" });
    const page = await context.newPage(); page.setDefaultTimeout(90_000);
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.addInitScript((locale) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
      await page.goto(new URL("/?demo=1", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 240_000 });
      await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
      await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics" }).click();
      await page.locator(".mecha-pack li > button").nth(1).click();
      await page.locator('.mecha-selected-actions button[data-mecha-action="pierce"]').click();
      await page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: zh ? "大怪" : "Boss" }).click();
      const candidate = page.locator(".mecha-candidate-result"), list = page.locator(".mecha-target-rejections"), rows = list.locator("li");
      assert.equal(await rows.count(), 2, `${lang}: demo must provide two actual unavailable targets`);
      const texts = await rows.allInnerTexts();
      for (const text of texts) assert.match(text, zh ? /不可选.*草稿预览无效.*射手/ : /Unavailable.*Plan prediction invalid.*Gunner/i, `${lang}: full unavailable reason must remain in DOM`);
      const metrics = await list.evaluate((el) => {
        const parent = el.closest(".mecha-selected-actions"), candidate = parent.querySelector(".mecha-candidate-result");
        return { font: parseFloat(getComputedStyle(el).fontSize), candidateFont: parseFloat(getComputedStyle(candidate).fontSize),
          lineHeight: parseFloat(getComputedStyle(el).lineHeight), width: el.clientWidth, scrollWidth: el.scrollWidth,
          rows: [...el.children].map((row) => ({ height: row.getBoundingClientRect().height, width: row.clientWidth, scrollWidth: row.scrollWidth, font: parseFloat(getComputedStyle(row).fontSize) })) };
      });
      assert.ok(metrics.font >= 12 && metrics.font <= metrics.candidateFont && metrics.lineHeight >= metrics.font * 1.35,
        `${lang}: reasons should be readable and not larger than candidate details: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.scrollWidth <= metrics.width + 1 && metrics.rows.every((r) => r.scrollWidth <= r.width + 1 && r.font >= 12 && r.font <= metrics.candidateFont),
        `${lang}: long reasons must wrap without horizontal overflow: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.rows.some((row) => row.height > metrics.lineHeight * 1.5), `${lang}: fixture must exercise wrapped reasons`);
      // Both ends of each actual reason remain reachable in the same scrolling panel.
      for (let i = 0; i < await rows.count(); i++) {
        const row = rows.nth(i);
        for (const edge of ["start", "end"]) {
          await row.evaluate((el, block) => el.scrollIntoView({ block, inline: "nearest" }), edge);
          await page.waitForTimeout(350);
          const bounds = await row.evaluate((el, end) => {
            const text = el.firstChild, range = document.createRange(), i = end ? text.length - 1 : 0;
            range.setStart(text, i); range.setEnd(text, i + 1);
            const r = range.getBoundingClientRect(), panel = el.closest(".mecha-selected-actions"), p = panel.getBoundingClientRect();
            return { rect: r.toJSON(), left: p.left + panel.clientLeft, right: p.left + panel.clientLeft + panel.clientWidth,
              top: p.top + panel.clientTop, bottom: p.top + panel.clientTop + panel.clientHeight };
          }, edge === "end");
          if (!(bounds.rect.left >= bounds.left - 1 && bounds.rect.right <= bounds.right + 1 && bounds.rect.top >= bounds.top - 1 && bounds.rect.bottom <= bounds.bottom + 1)) {
            const movement = await row.evaluate((el, delta) => { const panel = el.closest(".mecha-selected-actions"), before = panel.scrollTop;
              panel.scrollTop += delta; return { before, requested: delta, after: panel.scrollTop, max: panel.scrollHeight - panel.clientHeight }; }, (bounds.rect.top < bounds.top - 1 ? -Math.max(24, bounds.top - bounds.rect.top + 12) : Math.max(24, bounds.rect.bottom - bounds.bottom + 12)));
            await page.waitForTimeout(350);
            const retry = await row.evaluate((el, end) => {
              const text = el.firstChild, range = document.createRange(), i = end ? text.length - 1 : 0;
              range.setStart(text, i); range.setEnd(text, i + 1);
              const r = range.getBoundingClientRect(), panel = el.closest(".mecha-selected-actions"), p = panel.getBoundingClientRect();
              return { rect: r.toJSON(), left: p.left + panel.clientLeft, right: p.left + panel.clientLeft + panel.clientWidth,
                top: p.top + panel.clientTop, bottom: p.top + panel.clientTop + panel.clientHeight, scrollTop: panel.scrollTop };
            }, edge === "end");
            const complete = retry.rect.left >= retry.left - 1 && retry.rect.right <= retry.right + 1 && retry.rect.top >= retry.top - 1 && retry.rect.bottom <= retry.bottom + 1;
            const failure = `${lang}: unavailable reason ${i + 1} ${edge} clipped after scrollIntoView settles; further scroll ${complete ? "reveals" : "does not reveal"} it: ${JSON.stringify({ bounds, movement, retry })}`;
            console.error(failure); failures.push(failure);
          }
        }
      }
      // Audit every wrapped line, not just the text node's endpoints.
      for (let i = 0; i < await rows.count(); i++) {
        const row = rows.nth(i);
        const lineCount = await row.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects().length; });
        for (let line = 0; line < lineCount; line++) {
          await row.evaluate((el, n) => {
            const range = document.createRange(); range.selectNodeContents(el);
            const r = range.getClientRects()[n], panel = el.closest(".mecha-selected-actions");
            panel.scrollTop += r.top - (panel.getBoundingClientRect().top + panel.clientTop) - 4;
          }, line);
          await page.waitForTimeout(350);
          const geometry = await row.evaluate((el, n) => {
            const range = document.createRange(); range.selectNodeContents(el);
            const r = range.getClientRects()[n], panel = el.closest(".mecha-selected-actions"), p = panel.getBoundingClientRect();
            return { line: r.toJSON(), top: p.top + panel.clientTop, bottom: p.top + panel.clientTop + panel.clientHeight,
              left: p.left + panel.clientLeft, right: p.left + panel.clientLeft + panel.clientWidth };
          }, line);
          assert.ok(geometry.line.top >= geometry.top - 1 && geometry.line.bottom <= geometry.bottom + 1 &&
            geometry.line.left >= geometry.left - 1 && geometry.line.right <= geometry.right + 1,
            `${lang}: rejection ${i + 1} line ${line + 1} must be readable after scroll settles: ${JSON.stringify(geometry)}`);
        }
      }
      if (screenshots) await page.screenshot({ path: join(screenshots, `demo-rejections-${lang}-640x480.png`) });
      // Navigate back to the candidate rather than losing the current decision.
      await candidate.locator(".mecha-candidate-actions button").first().scrollIntoViewIfNeeded();
      assert.equal(await candidate.locator(".mecha-candidate-actions button").count(), 2);
      assert.deepEqual(errors, []);
      console.log(`${lang}: unmodified demo Gunner/Pierce/Boss, font/wrapping and individual-line audit completed (see any recorded scrollIntoView failures): ${JSON.stringify(metrics)}`);
    } catch (error) { failures.push(`${lang}: ${error.stack}`); console.error(failures.at(-1)); }
    finally { await context.close(); }
  }
} finally { await browser.close(); }
assert.deepEqual(failures, [], "demo rejection HUD checks failed");
console.log("Unmodified synthetic demo; Chromium only, not native, physical-input or screen-reader acceptance.");
