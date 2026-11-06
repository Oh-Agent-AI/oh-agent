#!/usr/bin/env node
// Synthetic browser HUD regression. Start this worktree's Vite server first.
// The longer labels are DOM-only layout probes, not new translated game copy.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });

const browser = await chromium.launch({ headless: true, args: [process.env.MECHA_BROWSER_ANGLE === "metal" ? "--use-angle=metal" : "--enable-unsafe-swiftshader"] });
try {
  for (const locale of ["en", "zh-Hans"]) {
    const zh = locale === "zh-Hans";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US", hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Make the observed Smash state deterministic without editing the source.
    let patched = 0;
    await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const needle = 'preset: "covers_sparse_mid", script: "siege", stake:';
      assert.equal(body.split(needle).length, 2, "fixture controller setup changed");
      patched++;
      await route.fulfill({ response, body: body.replace(needle, 'preset: "covers_sparse_mid", script: "stationary_smash", stake:') });
    });
    await page.addInitScript((language) => {
      localStorage.setItem("city.seed", "4196523069");
      window.__AV_PLUGIN_LOCALE__ = language;
      const frame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => setTimeout(() => frame(callback), 70);
    }, locale);
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 120_000 });
    assert.equal(patched, 1);
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings", exact: true }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
    const summary = page.locator(".mecha-turn-summary");
    const heading = summary.locator(".mecha-objective-card");
    const expand = page.getByRole("button", { name: zh ? "展开面板" : "Expand panel", exact: true });
    await summary.waitFor();
    assert.equal(await summary.evaluate((e) => e.classList.contains("is-compact")), true);
    assert.equal((await heading.locator(".mecha-objective-heading").innerText()).trim(), zh ? "本局目标" : "Objective");
    assert.match((await heading.locator(".mecha-objective-goal").innerText()).trim(), zh ? /消灭所有敌人/ : /Defeat all enemies/);

    // Character ranges detect intra-word breaks even when element boxes overlap
    // or split text appears visually plausible. Full-word wrapping is allowed.
    const inspect = () => heading.evaluate((el) => {
      const summary = el.closest(".mecha-turn-summary");
      const button = el.querySelector("button");
      const box = (node) => node.getBoundingClientRect().toJSON();
      const textInfo = (node) => {
        const text = node.firstChild;
        const words = [];
        for (const match of text.textContent.matchAll(/[A-Za-z]+/g)) {
          const lines = [];
          for (let i = match.index; i < match.index + match[0].length; i++) {
            const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1);
            lines.push(Math.round(range.getBoundingClientRect().top));
          }
          words.push({ word: match[0], lines: [...new Set(lines)] });
        }
        return { text: text.textContent, rect: box(node), words };
      };
      const round = el.querySelector("h3.mecha-objective-round"), roundStyle = getComputedStyle(round);
      // DOM-only two-digit turn probe; never changes the match/controller state.
      const originalRound = round.textContent;
      round.textContent = originalRound.replace(/1\/15$/, "15/15");
      const lastRound = box(round), lastRoundButton = box(button);
      round.textContent = originalRound;
      return { lastRound, lastRoundButton, round: box(round), roundSize: parseFloat(roundStyle.fontSize), roundWeight: Number(roundStyle.fontWeight),
        label: textInfo(el.querySelector(".mecha-objective-heading")), intent: textInfo(el.querySelector(".mecha-objective-goal")),
        heading: box(el), button: box(button), summary: box(summary), scrollWidth: summary.scrollWidth, clientWidth: summary.clientWidth,
        scrollHeight: summary.scrollHeight, clientHeight: summary.clientHeight };
    });
    const within = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    const overlap = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    for (const [width, height] of [[640, 480], [610, 480], [760, 600], [600, 480], [1100, 700]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(300);
      await summary.evaluate((el) => { el.scrollTop = 0; });
      const m = await inspect();
      const label = `${locale} ${width}x${height}`;
      assert.ok(m.roundSize >= 20 && m.roundWeight >= 700 && within(m.round, m.summary) && !overlap(m.round, m.button), `${label}: main round heading hierarchy or fit: ${JSON.stringify(m)}`);
      assert.ok(within(m.lastRound, m.summary) && within(m.lastRoundButton, m.summary) && !overlap(m.lastRound, m.lastRoundButton), `${label}: two-digit round clips or overlaps: ${JSON.stringify(m)}`);
      assert.ok(m.label.words.every((w) => w.lines.length === 1) && m.intent.words.every((w) => w.lines.length === 1), `${label}: short words split: ${JSON.stringify(m)}`);
      assert.ok(within(m.label.rect, m.summary) && within(m.intent.rect, m.summary) && within(m.button, m.summary), `${label}: heading clipped: ${JSON.stringify(m)}`);
      assert.ok(within(m.label.rect, m.button) && !overlap(m.button, m.intent.rect), `${label}: title must remain inside its control and goal below it: ${JSON.stringify(m)}`);
      assert.ok(m.button.width >= 44 && m.button.height >= 28, `${label}: title expand target below 44×28px: ${JSON.stringify(m.button)}`);
      assert.ok(m.scrollWidth <= m.clientWidth + 1, `${label}: horizontal overflow: ${JSON.stringify(m)}`);
      if (width === 640) {
        assert.ok(m.summary.width <= width * 0.33 && m.summary.height <= height * 0.29 + 1, `${label}: rail covers too much board: ${JSON.stringify(m.summary)}`);
        const others = await page.locator(".mecha-panel").evaluate((panel) => {
          const box = (selector) => panel.querySelector(selector).getBoundingClientRect().toJSON();
          return { resource: box(":scope > .mecha-turn-summary .mecha-objective-card > .mecha-quick-resource"), pack: box(":scope > .mecha-team-planning > .mecha-pack"), submit: box(":scope > .mecha-team-planning > .mecha-submit") };
        });
        assert.ok(within(others.resource, m.summary) && !overlap(m.summary, others.pack) && !overlap(m.summary, others.submit), `${label}: rail overlaps other HUD: ${JSON.stringify(others)}`);
        if (screenshots) await page.screenshot({ path: join(screenshots, `compact-heading-${locale}-640x480.png`) });
      }
      console.log(`${label}: short heading, target, clipping and overflow passed`);
    }

    await page.setViewportSize({ width: 640, height: 480 });
    await page.waitForTimeout(300);
    assert.equal(await expand.getAttribute("aria-expanded"), "false");
    // Use keyboard activation and retain the semantic name and state.
    await summary.focus();
    await page.keyboard.press("Tab");
    assert.equal(await expand.evaluate((el) => document.activeElement === el), true, `${locale}: expand not reachable from summary by Tab`);
    assert.notEqual(await expand.evaluate((el) => getComputedStyle(el).outlineStyle), "none", `${locale}: keyboard focus indicator missing`);
    await page.keyboard.press("Enter");
    const compact = page.getByRole("button", { name: zh ? "精简面板" : "Compact panel", exact: true });
    assert.equal(await compact.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Enter");
    assert.equal(await expand.getAttribute("aria-expanded"), "false");
    await summary.focus();
    await page.keyboard.press("End");
    assert.ok(await summary.evaluate((el) => el.scrollTop > 0), `${locale}: rail not keyboard-scrollable`);
    await page.keyboard.press("Home");

    if (!zh) {
      // One long word that fits the available text column must not split; a
      // longer unbreakable token must wrap instead of escaping the rail.
      for (const [text, expectWhole] of [["Predicted Powerful Smash", true], ["SupercalifragilisticexpialidociousSupercalifragilisticexpialidocious", false]]) {
        await heading.locator(".mecha-objective-goal").evaluate((el, value) => { el.textContent = value; }, text);
        const m = await inspect();
        assert.ok(m.scrollWidth <= m.clientWidth + 1, `long label horizontal overflow: ${JSON.stringify(m)}`);
        assert.ok(m.intent.rect.left >= m.summary.left - 1 && m.intent.rect.right <= m.summary.right + 1, `long label outside rail: ${JSON.stringify(m)}`);
        assert.ok(!overlap(m.button, m.intent.rect) && within(m.button, m.summary), `long label blocks expand: ${JSON.stringify(m)}`);
        assert.equal(m.intent.words.every((w) => w.lines.length === 1), expectWhole, `long label wrapping: ${JSON.stringify(m)}`);
        if (!expectWhole) {
          if (screenshots) await page.screenshot({ path: join(screenshots, "compact-heading-en-long-640x480.png") });
          await summary.focus();
          const lastCharacterVisible = () => heading.locator(".mecha-objective-goal").evaluate((el) => {
            const node = el.firstChild, range = document.createRange(), rail = el.closest(".mecha-turn-summary");
            range.setStart(node, node.length - 1); range.setEnd(node, node.length);
            const r = range.getBoundingClientRect(), clip = rail.getBoundingClientRect();
            return r.left >= clip.left && r.right <= clip.right && r.top >= clip.top + rail.clientTop && r.bottom <= clip.top + rail.clientTop + rail.clientHeight;
          });
          for (let i = 0; i < 12 && !(await lastCharacterVisible()); i++) await page.keyboard.press("ArrowDown");
          assert.ok(await lastCharacterVisible(), "long label's end must be reachable by keyboard scrolling");
          await page.keyboard.press("Home");
          assert.equal(await summary.evaluate((el) => el.scrollTop), 0, "Home returns to expand control");
        }
      }
      console.log("en 640x480: long labels, emergency wrapping and keyboard access passed");
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally { await browser.close(); }
console.log("Synthetic Chromium only; no native WebView or physical touch acceptance implied.");
