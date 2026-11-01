#!/usr/bin/env node
// Synthetic City fixture; start Vite first and pass its URL. Headless viewport
// and programmatic pointer checks are not native or physical-input acceptance.
// Throttle requestAnimationFrame in this test to reduce SwiftShader saturation;
// this test makes no frame rate or real-time performance claims.
// Optional MECHA_VIEWPORT=WIDTHxHEIGHT[,WIDTHxHEIGHT...] and MECHA_DPR exercise additional
// synthetic configurations; neither emulates OS or browser page zoom.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
const dpr = Number(process.env.MECHA_DPR ?? 1);
assert.ok(Number.isFinite(dpr) && dpr > 0, "MECHA_DPR must be a positive number");
const viewports = process.env.MECHA_VIEWPORT?.split(",").map((value) => value.match(/^(\d+)x(\d+)$/));
assert.ok(!viewports || viewports.every(Boolean), "MECHA_VIEWPORT must be WIDTHxHEIGHT[,WIDTHxHEIGHT...]");
const sizes = viewports ? viewports.map((viewport) => [Number(viewport[1]), Number(viewport[2])]) : [[1100, 700], [1440, 900], [390, 844]];
assert.ok(sizes.every(([width, height]) => width > 0 && height > 0), "viewport dimensions must be positive");
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const locale of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["en", "zh"]) {
    const zh = locale === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US", deviceScaleFactor: dpr });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((lang) => {
      localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang;
      const nativeFrame = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map(); let sequence = 0;
      window.requestAnimationFrame = (callback) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          const frame = nativeFrame((time) => { pending.delete(id); callback(time); });
          pending.set(id, { frame });
        }, 100);
        pending.set(id, { timer });
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        const entry = pending.get(id);
        if (entry?.timer !== undefined) clearTimeout(entry.timer);
        if (entry?.frame !== undefined) nativeCancel(entry.frame);
        pending.delete(id);
      };
    }, zh ? "zh-Hans" : "en");
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 240_000 });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics" }).click();
    await page.locator(".mecha-turn-summary").waitFor({ timeout: 240_000 });
    assert.equal(await page.evaluate(() => devicePixelRatio), dpr, "browser DPR differs from requested test scale");
    const assertCards = async (width, height, label) => {
      // ResizeObserver and the browser need time to settle after resize and draft changes.
      await page.waitForTimeout(350);
      const state = await page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect().toJSON();
        const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const pack = box(document.querySelector(".mecha-pack"));
        const action = box(document.querySelector(".mecha-selected-actions"));
        const summary = box(document.querySelector(".mecha-turn-summary"));
        const submit = box(document.querySelector(".mecha-submit"));
        const cards = [...document.querySelectorAll(".mecha-pack li")].map((card) => {
          const text = card.querySelector(".mecha-card-action"), r = box(text), parent = box(card);
          return { text: text.textContent, clipped: text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1 || r.left < parent.left - 1 || r.right > parent.right + 1 || r.top < parent.top - 1 || r.bottom > parent.bottom + 1, rect: r, parent };
        });
        return { cards, pack, action, summary, submit, actionOverlap: intersects(pack, action), submitOverlap: intersects(pack, submit), summaryActionOverlap: intersects(summary, action), summarySubmitOverlap: intersects(summary, submit) };
      });
      assert.ok(state.cards.length > 0 && state.cards.every((card) => !card.clipped), `${locale} ${width}x${height} ${label}: card text clipped: ${JSON.stringify(state)}`);
      assert.equal(state.actionOverlap, false, `${locale} ${width}x${height} ${label}: action panel covers cards: ${JSON.stringify(state)}`);
      assert.equal(state.submitOverlap, false, `${locale} ${width}x${height} ${label}: submit panel covers cards: ${JSON.stringify(state)}`);
      assert.equal(state.summaryActionOverlap, false, `${locale} ${width}x${height} ${label}: action panel covers summary: ${JSON.stringify(state)}`);
      assert.equal(state.summarySubmitOverlap, false, `${locale} ${width}x${height} ${label}: submit panel covers summary: ${JSON.stringify(state)}`);
      for (const button of await page.locator(".mecha-pack li > button").all()) {
        const result = await button.evaluate((el) => {
          const r = el.getBoundingClientRect(), hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          return !el.disabled && !!hit && (hit === el || el.contains(hit));
        });
        assert.ok(result, `${locale} ${width}x${height} ${label}: mech selection blocked`);
      }
    };
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await assertCards(width, height, "opening draft");
      console.log(`${locale} ${width}x${height}: checking battlefield settings`);
      const field = page.getByText(zh ? "战场设置与规则" : "Battlefield settings and rules", { exact: true });
      const remote = page.getByText(zh ? "手机远程战棋" : "Remote mecha tactics", { exact: true });
      const submit = page.locator(".mecha-submit-primary").first();
      const inspect = async (label, locator) => {
        const result = await locator.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, hit: hit?.outerHTML.slice(0, 180), reachable: !!hit && (hit === el || el.contains(hit)) };
        });
        assert.ok(result.reachable, `${locale} ${width}x${height} ${label} blocked: ${JSON.stringify(result)}`);
      };
      const assertBattleControlsClear = async (label) => {
        const overlaps = await page.evaluate(() => {
          const blockers = [document.querySelector(".mecha-turn-summary"), document.querySelector(".mecha-panel > .mecha-settings[open]")].filter(Boolean);
          const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          return Array.from(document.querySelectorAll(".mecha-battle-controls button"), (button) => ({
            text: button.textContent, rect: button.getBoundingClientRect().toJSON(),
            blockers: blockers.filter((el) => intersects(button.getBoundingClientRect(), el.getBoundingClientRect())).map((el) => ({ class: el.className, rect: el.getBoundingClientRect().toJSON() })),
          })).filter((item) => item.blockers.length);
        });
        assert.deepEqual(overlaps, [], `${locale} ${width}x${height} ${label}: battle controls covered`);
      };
      await assertBattleControlsClear("settings closed");
      for (const entry of [field, remote]) {
        const overlap = await entry.evaluate((el) => {
          const a = el.getBoundingClientRect(), b = document.querySelector(".mecha-turn-summary").getBoundingClientRect();
          return { overlaps: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top, entry: a.toJSON(), turn: b.toJSON() };
        });
        assert.equal(overlap.overlaps, false, `${locale} ${width}x${height} collapsed settings entry covers turn summary: ${JSON.stringify(overlap)}`);
      }
      await field.click();
      await assertBattleControlsClear("battlefield settings open");
      assert.equal(await remote.isVisible(), false, "collapsed remote entry must not remain visually or keyboard focusable behind open settings");
      assert.equal(await remote.evaluate((el) => { el.focus(); return document.activeElement === el; }), false, "hidden remote entry must not accept focus");
      const assertSummaryClear = async (entry, label) => {
        const overlap = await entry.evaluate((summary) => {
          const sheet = summary.closest("details").getBoundingClientRect();
          const turn = document.querySelector(".mecha-turn-summary").getBoundingClientRect();
          return { overlaps: sheet.left < turn.right && sheet.right > turn.left && sheet.top < turn.bottom && sheet.bottom > turn.top, sheet: sheet.toJSON(), turn: turn.toJSON() };
        });
        assert.equal(overlap.overlaps, false, `${locale} ${width}x${height} ${label} covers turn summary: ${JSON.stringify(overlap)}`);
      };
      await assertSummaryClear(field, "battlefield settings");
      const siblingOverlap = await field.evaluate((summary) => {
        const sheet = summary.closest("details"), other = document.querySelector(".mecha-remote-settings > summary");
        const a = sheet.getBoundingClientRect(), b = other.getBoundingClientRect();
        const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right), top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
        if (left >= right || top >= bottom) return { overlaps: false, reachable: true };
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return { overlaps: true, reachable: !!hit && (hit === sheet || sheet.contains(hit)), hit: hit?.outerHTML.slice(0, 180) };
      });
      assert.ok(siblingOverlap.reachable, `${locale} ${width}x${height} remote tab covers open battlefield settings: ${JSON.stringify(siblingOverlap)}`);
      await inspect("submit while battlefield settings expanded", submit);
      await submit.click({ timeout: 10_000 });
      const cancel = page.getByRole("button", { name: zh ? "返回修改" : "Return to editing", exact: true });
      await cancel.waitFor();
      await inspect("return while confirmation and settings expanded", cancel);
      await cancel.click({ timeout: 10_000 });
      const newMatch = page.getByRole("button", { name: zh ? "新开一局" : "New match", exact: true });
      await newMatch.scrollIntoViewIfNeeded();
      await inspect("settings controls", newMatch);
      // The settings scroll container, action container and turn summary may
      // scroll independently; never scroll the whole page to avoid an overlap.
      console.log(`${locale} ${width}x${height}: checking unit selection`);
      const packButton = page.locator(".mecha-pack li > button").first();
      await inspect("unit selection with settings expanded", packButton);
      await packButton.click();
      console.log(`${locale} ${width}x${height}: unit selected`);
      console.log(`${locale} ${width}x${height}: checking resources and order`);
      const resource = page.locator("details.mecha-resource > summary");
      await resource.scrollIntoViewIfNeeded();
      await inspect("resource details with settings expanded", resource);
      await resource.click();
      const building = page.locator("details.mecha-resource li button").first();
      await building.scrollIntoViewIfNeeded();
      await inspect("building resource with settings expanded", building);
      await resource.scrollIntoViewIfNeeded();
      await resource.click();
      const order = page.getByRole("button", { name: zh ? "结算顺序" : "Attack order", exact: true });
      await order.scrollIntoViewIfNeeded();
      await inspect("attack order with settings expanded", order);
      await order.click();
      const orderRegion = page.locator(".mecha-order[role=region]");
      assert.equal(await orderRegion.count(), 1);
      const orderButton = orderRegion.locator("button").first();
      await orderButton.scrollIntoViewIfNeeded();
      await inspect("attack order entry with settings expanded", orderButton);
      await order.scrollIntoViewIfNeeded();
      await order.click();
      await field.scrollIntoViewIfNeeded();
      await inspect("close battlefield settings after scrolling", field);
      if (screenshots) await page.screenshot({ path: join(screenshots, `settings-${locale}-${width}x${height}-dpr${dpr}.png`) });
      await field.click();
      console.log(`${locale} ${width}x${height}: checking remote settings`);
      await remote.click();
      await assertBattleControlsClear("remote settings open");
      assert.equal(await field.isVisible(), false, "collapsed battlefield entry must not remain visually or keyboard focusable behind open settings");
      assert.equal(await field.evaluate((el) => { el.focus(); return document.activeElement === el; }), false, "hidden battlefield entry must not accept focus");
      await assertSummaryClear(remote, "remote settings");
      await inspect("submit while remote settings expanded", submit);
      const relay = page.getByLabel(zh ? "中继 HTTPS 地址" : "Relay HTTPS URL");
      await relay.scrollIntoViewIfNeeded();
      await inspect("remote input", relay);
      await remote.scrollIntoViewIfNeeded();
      await remote.click();
      console.log(`${locale} ${width}x${height}: settings, submit, confirmation, unit selection, resources, order and remote controls reachable`);
    }
    // The initial Assault has no legal melee target. Resolve the documented
    // first Hold turn and move it into range before testing target cancellation.
    await page.locator(".mecha-submit-primary").first().click();
    await page.getByRole("button", { name: zh ? "继续提交" : "Submit anyway", exact: true }).click();
    const skip = page.getByRole("button", { name: zh ? "跳过演出" : "Skip animation", exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.waitForFunction(() => document.querySelector(".mecha-resource")?.textContent?.includes("68/80"), null, { timeout: 240_000 });
    await page.locator(".mecha-pack li > button").first().click();
    await page.locator(".mecha-move-list summary").click();
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      const moveOverlap = await page.evaluate(() => {
        const action = document.querySelector(".mecha-selected-actions").getBoundingClientRect();
        const turn = document.querySelector(".mecha-turn-summary").getBoundingClientRect();
        return { overlaps: action.left < turn.right && action.right > turn.left && action.top < turn.bottom && action.bottom > turn.top, action: action.toJSON(), turn: turn.toJSON() };
      });
      assert.equal(moveOverlap.overlaps, false, `${locale} ${width}x${height} expanded move list covers turn summary: ${JSON.stringify(moveOverlap)}`);
      const resource = page.locator("details.mecha-resource > summary");
      await resource.scrollIntoViewIfNeeded();
      await resource.click({ timeout: 10_000 });
      const building = page.locator("details.mecha-resource li button").first();
      await building.scrollIntoViewIfNeeded();
      const hit = await building.evaluate((el) => {
        const r = el.getBoundingClientRect(), top = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return !!top && (top === el || el.contains(top));
      });
      assert.ok(hit, `${locale} ${width}x${height} expanded move list blocks building resource`);
      await resource.scrollIntoViewIfNeeded();
      await resource.click({ timeout: 10_000 });
      const moveChoice = page.locator(".mecha-move-list select");
      await moveChoice.scrollIntoViewIfNeeded();
      const moveHit = await moveChoice.evaluate((el) => {
        const r = el.getBoundingClientRect(), top = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return !el.disabled && !!top && (top === el || el.contains(top));
      });
      assert.ok(moveHit, `${locale} ${width}x${height} move choice is blocked or disabled`);
      if (screenshots) await page.screenshot({ path: join(screenshots, `settings-move-${locale}-${width}x${height}-dpr${dpr}.png`) });
    }
    await page.locator(".mecha-move-list select").selectOption("3,2");
    await page.getByRole("button", { name: zh ? "应用移动" : "Apply move", exact: true }).click();
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      const field = page.getByText(zh ? "战场设置与规则" : "Battlefield settings and rules", { exact: true });
      await field.click();
      const melee = page.locator(".mecha-selected-actions > .mecha-actions > button").filter({ hasText: zh ? /^近战$/ : /^Melee$/ });
      await melee.scrollIntoViewIfNeeded();
      await melee.click({ timeout: 10_000 });
      const cancelTarget = page.locator(".mecha-target-cancel");
      await cancelTarget.scrollIntoViewIfNeeded();
      const targetHit = await cancelTarget.evaluate((el) => {
        const rect = el.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { reachable: !!hit && (hit === el || el.contains(hit)), hit: hit?.outerHTML.slice(0, 180), rect: rect.toJSON() };
      });
      assert.ok(targetHit.reachable, `${locale} ${width}x${height} target cancel blocked: ${JSON.stringify(targetHit)}`);
      await cancelTarget.click({ timeout: 10_000 });
      assert.equal(await cancelTarget.count(), 0);
      const before = await page.locator(".mecha-pack").innerText();
      await melee.scrollIntoViewIfNeeded();
      await melee.click();
      const boss = page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: zh ? "大怪" : "Boss" }).first();
      await boss.scrollIntoViewIfNeeded();
      await boss.click({ timeout: 10_000 });
      const result = page.locator(".mecha-candidate-result");
      await result.waitFor();
      const panelOverlap = await result.evaluate((el) => {
        const action = el.closest(".mecha-selected-actions").getBoundingClientRect();
        const turn = document.querySelector(".mecha-turn-summary").getBoundingClientRect();
        return { overlaps: action.left < turn.right && action.right > turn.left && action.top < turn.bottom && action.bottom > turn.top, action: action.toJSON(), turn: turn.toJSON() };
      });
      assert.equal(panelOverlap.overlaps, false, `${locale} ${width}x${height} candidate covers turn summary: ${JSON.stringify(panelOverlap)}`);
      const resource = page.locator("details.mecha-resource > summary");
      await resource.scrollIntoViewIfNeeded();
      await resource.click({ timeout: 10_000 });
      const building = page.locator("details.mecha-resource li button").first();
      await building.scrollIntoViewIfNeeded();
      const resourceHit = await building.evaluate((el) => {
        const r = el.getBoundingClientRect(), hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return { reachable: !!hit && (hit === el || el.contains(hit)), hit: hit?.outerHTML.slice(0, 180), rect: r.toJSON() };
      });
      assert.ok(resourceHit.reachable, `${locale} ${width}x${height} candidate obscures resource: ${JSON.stringify(resourceHit)}`);
      await resource.scrollIntoViewIfNeeded();
      await resource.click({ timeout: 10_000 });
      const resultButtons = result.locator(".mecha-candidate-actions button");
      assert.equal(await resultButtons.count(), 2);
      for (const button of await resultButtons.all()) {
        await button.scrollIntoViewIfNeeded();
        const hit = await button.evaluate((el) => {
          const rect = el.getBoundingClientRect(), top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return { reachable: !!top && (top === el || el.contains(top)), hit: top?.outerHTML.slice(0, 180), rect: rect.toJSON() };
        });
        assert.ok(hit.reachable, `${locale} ${width}x${height} candidate action blocked: ${JSON.stringify(hit)}`);
      }
      if (screenshots) await page.screenshot({ path: join(screenshots, `settings-candidate-${locale}-${width}x${height}-dpr${dpr}.png`) });
      await result.getByRole("button", { name: zh ? "取消选目标" : "Cancel targeting", exact: true }).click({ timeout: 10_000 });
      assert.equal(await result.count(), 0);
      assert.equal(await page.locator(".mecha-pack").innerText(), before, "candidate cancellation must preserve the draft");
      await field.click();
      console.log(`${locale} ${width}x${height}: targeting, result confirmation and cancellation reachable with settings open`);
    }
    const melee = page.locator(".mecha-selected-actions > .mecha-actions > button").filter({ hasText: zh ? /^近战$/ : /^Melee$/ });
    await melee.scrollIntoViewIfNeeded();
    await melee.click();
    const boss = page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: zh ? "大怪" : "Boss" }).first();
    await boss.scrollIntoViewIfNeeded();
    await boss.click();
    const confirm = page.getByRole("button", { name: zh ? "确认选择" : "Confirm target", exact: true });
    await confirm.scrollIntoViewIfNeeded();
    await confirm.click();
    assert.match(await page.locator(".mecha-pack li").first().innerText(), zh ? /近战.*大怪/s : /Melee.*Boss/s);
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await assertCards(width, height, "planned targeted action");
      if (screenshots) await page.screenshot({ path: join(screenshots, `settings-planned-${locale}-${width}x${height}-dpr${dpr}.png`) });
    }
    // Stress the layout/observer with longer text and an incoming-hit row. This
    // is a DOM-only synthetic layout case, not an engine/gameplay assertion.
    await page.locator(".mecha-pack li").first().evaluate((card, lang) => {
      const text = card.querySelector(".mecha-card-action");
      text.dataset.testOriginal = text.textContent;
      text.textContent = lang === "zh" ? "近战 小怪西 小怪东" : "Melee West raider East raider";
      const hit = document.createElement("span");
      hit.className = "mecha-hit";
      hit.dataset.testHit = "true";
      hit.textContent = lang === "zh" ? "受击 10" : "Hit 10";
      card.append(hit);
    }, locale);
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await assertCards(width, height, "synthetic long action and hit");
      if (screenshots) await page.screenshot({ path: join(screenshots, `settings-card-stress-${locale}-${width}x${height}-dpr${dpr}.png`) });
    }
    await page.locator(".mecha-pack li").first().evaluate((card) => {
      const text = card.querySelector(".mecha-card-action");
      text.textContent = text.dataset.testOriginal;
      delete text.dataset.testOriginal;
      card.querySelector('[data-test-hit="true"]').remove();
    });
    await assertCards(...sizes.at(-1), "restored plan");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Synthetic responsive settings layout passed with throttled animation frames; not native, performance or physical-input acceptance.");
} finally { await browser.close(); }
