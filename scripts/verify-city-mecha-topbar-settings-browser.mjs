#!/usr/bin/env node
// Synthetic City + injected remote host. No native IPC or real relay requests.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completeLocalDeployment } from "./mecha-deployment-browser-helpers.mjs";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
if (output) await mkdir(output, { recursive: true });
const sizes = [[640, 480], [800, 600], [1100, 700], [390, 844]];
const browser = await chromium.launch({ headless: true, args: [process.env.MECHA_BROWSER_ANGLE === "metal" ? "--use-angle=metal" : "--enable-unsafe-swiftshader"] });
const results = [];
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: lang === "zh" ? "zh-CN" : "en-US" });
    const page = await context.newPage(); page.setDefaultTimeout(90000);
    const errors = []; let remoteSeams = 0;
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(lang => {
      localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en";
      window.__settingsHostCalls = [];
      window.__settingsFakeHost = async (_command, { request }) => {
        window.__settingsHostCalls.push(request.method);
        const result = request.method === "mecha.remote.start-v3" ? { remoteUrl: "https://fake.invalid/match", matchId: "settings-test" }
          : request.method === "mecha.remote.pending" ? { pending: [] }
          : request.method === "mecha.remote.stop" ? { ok: true } : null;
        if (!result) throw new Error(`unexpected synthetic request: ${request.method}`);
        return { version: 1, requestId: request.requestId, ok: true, result };
      };
      // This is a geometry/interaction test, not a real-time animation test.
      const frame = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window);
      const pending = new Map(); let next = 0;
      window.requestAnimationFrame = callback => {
        const id = ++next;
        const timer = setTimeout(() => { const handle = frame(time => { pending.delete(id); callback(time); }); pending.set(id, { handle }); }, 100);
        pending.set(id, { timer }); return id;
      };
      window.cancelAnimationFrame = id => { const task = pending.get(id); if (task?.timer) clearTimeout(task.timer); if (task?.handle) cancel(task.handle); pending.delete(id); };
    }, lang);
    await page.route("**/src/game/mecha/RemoteMechaControls.tsx*", async route => {
      const response = await route.fetch(), body = await response.text();
      const needle = 'import { invokeHost } from "/src/host.ts";';
      assert.equal(body.split(needle).length, 2, "remote host injection seam"); remoteSeams++;
      await route.fulfill({ response, body: body.replace(needle, "const invokeHost = window.__settingsFakeHost;") });
    });
    const text = (zh, en) => lang === "zh" ? zh : en;
    const button = (zh, en) => page.getByRole("button", { name: text(zh, en), exact: true });
    const fieldEntry = page.locator('[data-mecha-settings-trigger="battlefield"]');
    const remoteEntry = page.locator('[data-mecha-settings-trigger="remote"]');
    const field = page.locator("#mecha-battlefield-settings"), remote = page.locator("#mecha-remote-settings");
    const relay = remote.locator('input[type="url"]');
    const boxCheck = async locator => {
      const geometry = await locator.evaluate(el => {
        const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 16));
        return { rect: [r.left, r.top, r.right, r.bottom], inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
          hit: el.contains(hit), clipped: el.scrollWidth > el.clientWidth + 1 };
      });
      assert.ok(geometry.inViewport && geometry.hit && !geometry.clipped, JSON.stringify(geometry));
    };
    try {
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.locator(".city-loading").waitFor({ state: "hidden" });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await completeLocalDeployment(page);
      await page.waitForFunction(() => { const unit = document.querySelector(".mecha-pack .mecha-plan-card__select"); return unit && !unit.disabled; });
      assert.equal(remoteSeams, 1);
      const draft = await page.locator(".mecha-pack").innerText();
      for (const [width, height] of sizes) {
        console.log(`START ${lang} ${width}x${height}`);
        await page.setViewportSize({ width, height }); await page.waitForTimeout(250);
        assert.equal(await page.locator(".mecha-options-menu").count(), 0, "old nested entry is removed");
        await boxCheck(fieldEntry); await boxCheck(remoteEntry);
        assert.equal(await page.locator(".mecha-settings-popover:visible").count(), 0);
        const round = page.locator(".mecha-objective-round"), toggle = page.locator(".mecha-summary-toggle");
        assert.equal(await round.count(), 1, "round belongs only to objective header");
        assert.equal(await page.locator(".mecha-team-planning .mecha-planning-round, .mecha-team-planning .mecha-objective-round").count(), 0);
        assert.match(await round.innerText(), lang === "zh" ? /回合\s*1\/15/ : /Turn\s*1\/15/);
        await boxCheck(round); await boxCheck(toggle);
        const header = await toggle.evaluate(el => {
          const title = el.querySelector(".mecha-objective-heading"), round = el.parentElement.querySelector(".mecha-objective-round");
          const textBox = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect(); };
          const a = textBox(title), b = textBox(round), r = el.getBoundingClientRect(), style = getComputedStyle(el);
          const roundStyle = getComputedStyle(round), titleStyle = getComputedStyle(title);
          return { aligned: Math.abs(a.bottom - b.bottom) <= 4, separated: b.right < a.left,
            mainHeading: round.tagName === "H3" && parseFloat(roundStyle.fontSize) >= 20 && parseFloat(roundStyle.fontSize) >= parseFloat(titleStyle.fontSize) + 6 && Number(roundStyle.fontWeight) >= 700 && roundStyle.color !== titleStyle.color,
            height: r.height, border: style.borderTopWidth, background: style.backgroundColor, text: el.textContent };
        });
        assert.ok(header.mainHeading && header.aligned && header.separated && header.height <= 32 && header.border === "0px" && header.background === "rgba(0, 0, 0, 0)", JSON.stringify(header));
        assert.ok(!header.text.includes("＋"), "large plus is removed");
        await toggle.click(); assert.equal(await toggle.getAttribute("aria-expanded"), "true");
        await page.keyboard.press("Enter"); assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        await toggle.blur();
        if (output) await page.screenshot({ path: join(output, `topbar-${lang}-${width}x${height}.png`) });
        await fieldEntry.click(); await boxCheck(field);
        assert.equal(await fieldEntry.getAttribute("aria-expanded"), "true");
        assert.equal(await remote.isVisible(), false);
        assert.equal(await field.locator("select").count(), 4, "mission, battlefield, script and doctrine controls retained");
        assert.equal(await field.locator("[data-mission-mode]").count(), 1, "local mission selector is reachable");
        const body = field.locator(".mecha-settings-body");
        await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
        await boxCheck(field.locator(".mecha-ruleset"));
        await body.evaluate(el => { el.scrollTop = 0; });
        if (output) await page.screenshot({ path: join(output, `battlefield-${lang}-${width}x${height}.png`) });
        await remoteEntry.click(); await boxCheck(remote);
        assert.equal(await field.isVisible(), false); assert.equal(await fieldEntry.getAttribute("aria-expanded"), "false");
        assert.equal(await remoteEntry.getAttribute("aria-expanded"), "true");
        assert.equal(await remote.locator("details, summary").count(), 0, "remote content has no second disclosure");
        await relay.fill("https://fake.invalid");
        if (output) await page.screenshot({ path: join(output, `remote-${lang}-${width}x${height}.png`) });
        await remote.getByRole("button", { name: text("关闭设置", "Close settings") }).click();
        assert.equal(await remote.isVisible(), false);
        assert.ok(await remoteEntry.evaluate(el => el === document.activeElement), "close restores opener focus");
        await remoteEntry.click(); assert.equal(await relay.inputValue(), "https://fake.invalid", "closing does not remount the remote form");
        await relay.blur(); await page.keyboard.press("Escape");
        assert.equal(await remote.isVisible(), false);
        assert.equal(await page.locator(".mecha-overlay.has-match").count(), 1, "Escape must not exit the match");
        await fieldEntry.click(); await button("重置视角", "Reset view").click();
        assert.equal(await field.isVisible(), false, "clicking outside dismisses settings");
        await remoteEntry.click(); await remoteEntry.click();
        assert.equal(await remote.isVisible(), false, "same entry toggles closed");
        assert.deepEqual(await page.evaluate(() => window.__settingsHostCalls), [], "opening settings never starts networking");
        assert.equal(await page.locator(".mecha-pack").innerText(), draft, "settings visibility must not change the draft");
        results.push({ lang, width, height, pass: true }); console.log(`PASS ${lang} ${width}x${height}`);
      }
      // A synthetic active remote match must survive hiding/switching its panel,
      // and the stop control must remain accessible outside the hidden panel.
      await page.setViewportSize({ width: 1100, height: 700 });
      await remoteEntry.click();
      await remote.getByRole("button", { name: text("开启并生成链接", "Start and create link"), exact: true }).click();
      await remote.locator("textarea").waitFor();
      assert.equal(await remote.locator("textarea").inputValue(), "https://fake.invalid/match");
      await remote.getByRole("button", { name: text("关闭设置", "Close settings") }).click();
      const stop = page.locator(".mecha-remote-stop"); await stop.waitFor(); await boxCheck(stop);
      await fieldEntry.click(); assert.equal(await field.locator("select").first().isDisabled(), true, "remote lock persists while settings are hidden");
      await remoteEntry.click(); assert.equal(await remote.locator("textarea").inputValue(), "https://fake.invalid/match", "remote link survives switching panels");
      assert.equal(await page.evaluate(() => window.__settingsHostCalls.filter(method => method === "mecha.remote.start-v3").length), 1);
      assert.equal(await page.evaluate(() => window.__settingsHostCalls.includes("mecha.remote.stop")), false);
      await stop.click();
      await page.waitForFunction(() => !document.querySelector(".mecha-plan-card__select").disabled);
      assert.equal(await stop.count(), 0); assert.equal(await page.locator(".mecha-overlay.has-match").count(), 1);
      assert.deepEqual(errors, []); console.log(`PASS ${lang}: hidden-panel remote lifecycle and persistent stop (injected host, no relay)`);
    } catch (error) {
      console.error(`FAIL ${lang}: ${error.stack}`); results.push({ lang, pass: false, error: error.message });
      if (output) await page.screenshot({ path: join(output, `failure-${lang}.png`) }).catch(() => {});
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
if (output) await writeFile(join(output, "results.json"), JSON.stringify({ timestamp: new Date().toISOString(), results, scope: "synthetic headless Chromium geometry and injected remote host; no native device, real relay or accessibility certification" }, null, 2) + "\n");
if (results.some(result => !result.pass)) process.exitCode = 1;
