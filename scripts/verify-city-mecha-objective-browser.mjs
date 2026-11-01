#!/usr/bin/env node
// Synthetic local-match HUD regression; do not use against production data.
// Start THIS checkout's City Vite server, then run:
//   cd apps/agent-city/ui && npm run dev -- --port 5178 --strictPort
//   node scripts/verify-city-mecha-objective-browser.mjs http://127.0.0.1:5178
// Requires the existing Playwright dependency in apps/desktop/ui-dev and its
// Chromium (install with npx playwright install chromium in that directory).
// Optional: MECHA_OBJECTIVE_LANG=zh|en, MECHA_OBJECTIVE_SIZE=640x480|1100x700,
// MECHA_SCREENSHOTS_DIR=/absolute/path. A filtered run is not a matrix pass.
// The fixture intercepts Vite source in memory; it never writes product code.
// It suppresses automatic animation completion so assertions cannot miss the
// playback window; the real Skip animation control still ends presentation.
// Geometry/hit tests are not OCR, physical input, native/Tauri or a11y certification.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:5178";
const langs = process.env.MECHA_OBJECTIVE_LANG ? [process.env.MECHA_OBJECTIVE_LANG] : ["zh", "en"];
const allSizes = [[640, 480], [1100, 700]];
const sizes = process.env.MECHA_OBJECTIVE_SIZE ? allSizes.filter(([w, h]) => `${w}x${h}` === process.env.MECHA_OBJECTIVE_SIZE) : allSizes;
if (langs.some((v) => !["zh", "en"].includes(v)) || !sizes.length) throw new Error("Invalid MECHA_OBJECTIVE_LANG or MECHA_OBJECTIVE_SIZE");
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");

// Audit every non-whitespace text character against the viewport and all
// clipping ancestors, then hit-test its center. Unlike a box-only test, this
// catches clipped last lines and sibling controls laid on top of the copy. It
// does not detect a pointer-events:none overlay or establish legibility.
async function auditText(locator, label) {
  assert.equal(await locator.count(), 1, `${label}: expected exactly one element`);
  const result = await locator.evaluate((root) => {
    const failures = [];
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (!parent || !node.textContent.trim()) continue;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) continue;
      for (let i = 0; i < node.length; i++) {
        if (/\s/.test(node.textContent[i])) continue;
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        if (!r.width || !r.height) { failures.push(`empty glyph ${node.textContent[i]}`); continue; }
        count++;
        let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
        for (let p = parent; p; p = p.parentElement) {
          const s = getComputedStyle(p), b = p.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left, b.left + p.clientLeft); right = Math.min(right, b.left + p.clientLeft + p.clientWidth); }
          if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, b.top + p.clientTop); bottom = Math.min(bottom, b.top + p.clientTop + p.clientHeight); }
        }
        if (r.left < left - 1 || r.right > right + 1 || r.top < top - 1 || r.bottom > bottom + 1) failures.push(`clipped ${node.textContent[i]} at ${Math.round(r.left)},${Math.round(r.top)}`);
        else {
          const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          if (!hit || !(hit === parent || parent.contains(hit))) failures.push(`covered ${node.textContent[i]} by ${hit?.tagName}.${hit?.className}`);
        }
        if (failures.length >= 8) return { count, failures };
      }
    }
    return { count, failures };
  });
  assert.ok(result.count > 0 && !result.failures.length, `${label}: ${JSON.stringify(result)}`);
}

async function fullyUsable(locator, label) {
  assert.equal(await locator.count(), 1, `${label}: expected exactly one control`);
  const result = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let l = 0, t = 0, right = innerWidth, bottom = innerHeight;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p), b = p.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { l = Math.max(l, b.left + p.clientLeft); right = Math.min(right, b.left + p.clientLeft + p.clientWidth); }
      if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { t = Math.max(t, b.top + p.clientTop); bottom = Math.min(bottom, b.top + p.clientTop + p.clientHeight); }
    }
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return { ok: r.width > 0 && r.height > 0 && r.left >= l - 1 && r.right <= right + 1 && r.top >= t - 1 && r.bottom <= bottom + 1 && !!hit && (hit === el || el.contains(hit)), rect: r.toJSON(), hit: hit?.outerHTML.slice(0, 150) };
  });
  assert.ok(result.ok, `${label}: ${JSON.stringify(result)}`);
}

// Starting from an explicitly focused scroll region, tab normally to the target.
// Check focus immediately after each key, not after a state transition which may
// legitimately move it. Never demand that focus stays on a removed/replaced node.
async function tabTo(page, start, target, label) {
  await start.focus();
  for (let i = 0; i < 100; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  assert.fail(`${label}: not reachable within 100 Tab presses`);
}

const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
const failures = [];
try {
  for (const lang of langs) for (const [width, height] of sizes) {
    const zh = lang === "zh", label = `${lang} ${width}x${height}`;
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US", deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [], injections = { board: 0, preview: 0, error: null };
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
      try {
        const response = await route.fetch(); let body = await response.text();
        const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
        assert.equal(body.split(needle).length, 2, "controller fixture seam must match exactly once");
        // route.fetch() normally returns Vite's transformed JSX (jsxDEV
        // props), not the original TSX. Accept either form, but never patch
        // silently if the server or instrumentation point has changed.
        const completions = [
          ["onPerformanceComplete: finishPerformance", "onPerformanceComplete: () => {}"],
          ["onPerformanceComplete={finishPerformance}", "onPerformanceComplete={() => {}}"],
        ];
        const matches = completions.filter(([needle]) => body.split(needle).length === 2);
        assert.equal(matches.length, 1, "animation completion fixture seam must match exactly once (Vite JSX or TSX)");
        body = body.replace(matches[0][0], matches[0][1]);
        body = 'import { createMatch as objectiveMatch, bossPrepare as objectivePrepare } from "/src/game/mecha/rules.ts";\n' + body;
        body = body.replace(needle, `const fixture = objectiveMatch({preset:"covers_sparse_mid", script:"cadence_ssw", covers:[],
          buildings:[{id:"objective-building", cells:[{x:4,y:2}], hp:10}], boss:{x:4,y:0},
          raiders:[{id:"raider-w",pos:{x:4,y:4}},{id:"raider-e",pos:{x:6,y:4}}],
          mechs:[{id:"Assault",pos:{x:5,y:2}},{id:"Gunner",pos:{x:2,y:8}},{id:"Support",pos:{x:7,y:2}}]});
          fixture.boss.cadence = 2; objectivePrepare(fixture);
          fixture.mechs.find((m) => m.id === "Assault").pos = {x:6,y:3};
          controllerRef.current = createMechaController({animate:true, locale, site, match:fixture,
            planner:(state) => ({revision:state.revision,items:[]})});
          globalThis.__objectiveController = controllerRef.current;`);
        injections.board++;
        await route.fulfill({ response, body });
      } catch (e) { injections.error = e.message; await route.abort(); }
    });
    await page.route("**/src/game/mecha/controller.ts*", async (route) => {
      try {
        const response = await route.fetch(); const source = await response.text();
        const needle = "const previewTurn = init.preview ?? previewPlan;";
        assert.equal(source.split(needle).length, 2, "display preview seam must match exactly once");
        const body = source.replace(needle, `const previewTurn = (...args) => {
          if (globalThis.__objectivePreviewFailure) throw new Error("synthetic display prediction failure");
          return (init.preview ?? previewPlan)(...args);
        };`);
        injections.preview++;
        await route.fulfill({ response, body });
      } catch (e) { injections.error = e.message; await route.abort(); }
    });
    await page.addInitScript((locale) => {
      localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale;
      const frame = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map(); let sequence = 0;
      window.requestAnimationFrame = (callback) => {
        const id = ++sequence;
        const timer = setTimeout(() => { const handle = frame((time) => { pending.delete(id); callback(time); }); pending.set(id, { handle }); }, 100);
        pending.set(id, { timer }); return id;
      };
      window.cancelAnimationFrame = (id) => { const entry = pending.get(id); if (entry?.timer !== undefined) clearTimeout(entry.timer); if (entry?.handle !== undefined) cancel(entry.handle); pending.delete(id); };
    }, zh ? "zh-Hans" : "en");
    const text = (z, e) => zh ? z : e;
    const button = (z, e) => page.getByRole("button", { name: text(z, e), exact: true });
    try {
      const response = await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 180_000 });
      assert.ok(response?.ok(), `server returned ${response?.status()}`);
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 180_000 });
      assert.deepEqual(injections, { board: 1, preview: 1, error: null }, "fixture interception failed: use this checkout's City Vite server");
      await button("城市设置", "City settings").click();
      await button("机甲战棋", "Mecha tactics").click();
      const summary = page.locator(".mecha-turn-summary");
      await summary.waitFor();
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(400);
      const card = page.locator(".mecha-objective-card"), heading = card.locator(".mecha-objective-heading"), goal = card.locator(".mecha-objective-goal"), forecast = card.locator(".mecha-objective-forecast");
      assert.equal(await summary.evaluate((el) => el.classList.contains("is-compact")), true, "battle must start in compact mode");
      for (const [loc, name] of [[heading, "heading"], [goal, "goal"], [forecast, "forecast"]]) await auditText(loc, `${label} compact ${name}`);
      const round = page.locator(".mecha-battle-bar > div:first-child span:visible, .mecha-mobile-round:visible").first();
      assert.match(await round.innerText(), zh ? /回合\s*1\s*\/\s*15/ : /Turn\s*1\s*\/\s*15/i);
      await auditText(round, `${label} initial round`);
      assert.match(await heading.innerText(), zh ? /本局目标/ : /objective/i);
      const goalText = await goal.innerText();
      assert.match(goalText, zh ? /(消灭|歼灭|击败|清除).*(所有|全部|全体|敌人|敌方)/ : /(?:eliminate|defeat|destroy|clear|kill).*\b(?:all|every)\b.*\b(?:enem(?:y|ies)|foes?)\b/i, "goal must require eliminating all enemies");
      assert.match(goalText, zh ? /(保住|保护|守住|保卫).*(至少|一栋|一座|1).*(楼|建筑)|(至少|一栋|一座|1).*(楼|建筑).*(保住|保护|守住|存活)/ : /(?:protect|keep|save|defend|surviv).*\b(?:at least|one|1)\b.*\b(?:building|structure)/i, "staked buildings must be protected");
      const state = await page.evaluate(() => {
        const s = globalThis.__objectiveController.getState();
        return { preview: s.preview, turn: s.match.turn };
      });
      assert.equal(state.turn, 1);
      assert.equal(state.preview.ok, true, "fixture must have a valid prediction");
      assert.ok(state.preview.assumed.length > 0, "fixture must exercise unplanned actions");
      const buildings = state.preview.buildings.filter((b) => b.staked);
      assert.ok(buildings.length > 0, "fixture must have a defended building");
      const loss = buildings.reduce((sum, b) => sum + b.startHp - b.endHp, 0);
      assert.ok(loss > 0, `fixture must produce a nonzero net loss, got ${loss}`);
      const forecastText = await forecast.innerText();
      assert.match(forecastText, zh ? /建筑|守楼/ : /building/i, "forecast must identify buildings");
      assert.match(forecastText, zh ? /本回合|草稿|本次/ : /turn|draft|plan|est\./i, "forecast must describe this draft or turn");
      assert.match(forecastText, zh ? /损失|受损|减少/ : /loss|damage|lost/i, "must identify building loss");
      assert.match(forecastText, new RegExp(`(?:^|[^\\d])[-−]?${loss}(?:[^\\d]|$)`), `forecast must reflect net loss ${loss}`);
      assert.match(forecastText, zh ? /假设.{0,12}待机|待机.{0,12}假设|未规划.{0,20}待机/ : /assum(?:e|ed|ption)[\s\S]{0,60}(?:wait|hold)|unplanned[\s\S]{0,60}(?:wait|hold)/i, "unplanned actions must be identified as an assumption");
      if (screenshots) await page.screenshot({ path: join(screenshots, `objective-${lang}-${width}x${height}.png`) });

      const expand = button("展开面板", "Expand panel");
      await fullyUsable(expand, `${label} expand`);
      await tabTo(page, summary, expand, "expand control");
      await page.keyboard.press("Enter");
      const compact = button("精简面板", "Compact panel");
      await compact.waitFor();
      assert.equal(await compact.getAttribute("aria-expanded"), "true");
      // Scroll into view before each control; expanding a narrow rail may
      // legitimately scroll it or move focus as React updates the panel.
      const threats = summary.locator("details.mecha-threat-details");
      const threatToggle = threats.locator("summary");
      await tabTo(page, summary, threatToggle, "threat disclosure");
      await threatToggle.scrollIntoViewIfNeeded(); await fullyUsable(threatToggle, "threat disclosure");
      await page.keyboard.press("Enter");
      assert.equal(await threats.evaluate((el) => el.open), true);
      const declaration = threats.locator("p").filter({ hasText: zh ? /当前宣告/ : /(?:boss )?(?:declaration|declared)/i }).first();
      assert.equal(await declaration.count(), 1, "expanded panel must expose current enemy declaration");
      await declaration.scrollIntoViewIfNeeded(); await auditText(declaration, `${label} declaration`);
      await threatToggle.click();
      const risk = summary.locator("details.mecha-risk-details");
      const riskToggle = risk.locator("summary");
      await tabTo(page, summary, riskToggle, "risk disclosure");
      await riskToggle.scrollIntoViewIfNeeded(); await fullyUsable(riskToggle, "risk disclosure");
      await page.keyboard.press("Enter");
      assert.equal(await risk.evaluate((el) => el.open), true);
      assert.match(await risk.innerText(), zh ? /守楼|建筑/ : /building/i);
      assert.match(await risk.innerText(), new RegExp(`(?:^|[^\\d])${loss}(?:[^\\d]|$)`));
      const riskLine = risk.locator("p").first();
      await riskLine.scrollIntoViewIfNeeded(); await auditText(riskLine, `${label} detailed risk`);
      // Close before keyboard traversal to avoid forcing an unrelated scroll position.
      await riskToggle.click();
      const orderToggle = button("结算顺序", "Attack order");
      await tabTo(page, summary, orderToggle, "order toggle");
      await orderToggle.scrollIntoViewIfNeeded(); await fullyUsable(orderToggle, "order toggle");
      await page.keyboard.press("Enter");
      assert.equal(await orderToggle.getAttribute("aria-expanded"), "true");
      const order = summary.locator(".mecha-order"), enemies = order.locator("ol li button");
      assert.ok(await enemies.count() >= 2, "fixture must show multiple enemy order entries");
      const enemy = enemies.first();
      await tabTo(page, summary, enemy, "enemy order entry");
      await enemy.scrollIntoViewIfNeeded(); await fullyUsable(enemy, "enemy order entry");
      const beforePressed = await enemy.getAttribute("aria-pressed");
      await page.keyboard.press("Enter");
      await page.waitForFunction((previous) => document.querySelector(".mecha-order ol li button")?.getAttribute("aria-pressed") !== previous, beforePressed);

      // Inject a display-only prediction failure and change the draft, invalidating
      // the cache. The authority state confirms the fault before UI assertions.
      await page.evaluate(() => { globalThis.__objectivePreviewFailure = true; globalThis.__objectiveController.setMove("Assault", {x:5,y:2}); });
      await page.waitForFunction(() => globalThis.__objectiveController.getState().preview.status === "unavailable");
      await compact.click();
      await page.waitForFunction(() => /未知|不可用|unknown|unavailable/i.test(document.querySelector(".mecha-objective-forecast")?.textContent ?? ""));
      const unknown = await forecast.innerText();
      assert.match(unknown, zh ? /未知|不可用|无法预测/ : /unknown|unavailable|cannot (?:predict|forecast)/i, "failed prediction must be visibly unknown");
      assert.doesNotMatch(unknown, zh ? /(?:损失|受损|减少)\s*[:：]?\s*[-−+]?0\b/ : /(?:loss|damage|lost)\s*[:：]?\s*[-−+]?0\b/i, "unknown must not be represented as zero loss");
      assert.doesNotMatch(unknown, /(?:^|[^\d])0(?:[^\d]|$)|\d+\s*→\s*\d+/, "unknown must not be zero or retain a numeric prediction");
      await auditText(forecast, `${label} unknown forecast`);
      await page.evaluate(() => { globalThis.__objectivePreviewFailure = false; globalThis.__objectiveController.undoMove(); });
      await page.waitForFunction(() => globalThis.__objectiveController.getState().preview.ok);
      await page.waitForFunction((value) => document.querySelector(".mecha-objective-forecast")?.textContent.includes(String(value)), loss);
      assert.match(await forecast.innerText(), new RegExp(`(?:^|[^\\d])[-−]?${loss}(?:[^\\d]|$)`), "prediction must recover");

      // Set the three holds through the UI, then submit/confirm through the UI.
      for (let i = 0; i < 3; i++) {
        await page.locator(".mecha-pack li > button").nth(i).click();
        await page.locator(".mecha-selected-actions").getByRole("button", { name: text("待机", "Hold"), exact: true }).click();
      }
      const submit = page.locator(".mecha-submit-primary");
      await submit.scrollIntoViewIfNeeded(); await fullyUsable(submit, "submit turn");
      await submit.click();
      const confirm = button("继续提交", "Submit anyway");
      await confirm.waitFor({ state: "visible" });
      await confirm.click();
      await page.waitForFunction(() => globalThis.__objectiveController.getState().performance !== null);
      // No next-turn or resolved-turn prediction may be presented during playback.
      // Never require focus to remain on the submit button after the transition.
      const skip = button("跳过演出", "Skip animation");
      await skip.waitFor({ state: "visible" });
      const playingForecast = await forecast.innerText();
      assert.doesNotMatch(playingForecast, /\d/, "playback must not show a numeric forecast");
      assert.ok(!playingForecast.trim() || /演出|播放|animation|playback|presentation/i.test(playingForecast), "playback must not present a stale outcome prediction");
      assert.equal(await page.locator(".mecha-order ol li").count(), 0, "playback must not show a predicted enemy order");
      assert.equal(await page.locator("details.mecha-risk-details").count(), 0, "playback must not show draft risk details");
      await fullyUsable(skip, "skip animation"); await skip.click();
      await page.waitForFunction(() => !globalThis.__objectiveController.getState().performance);
      const after = await page.evaluate(() => ({ turn: globalThis.__objectiveController.getState().match.turn, outcome: globalThis.__objectiveController.getState().match.outcome }));
      assert.equal(after.outcome, null, "fixture unexpectedly ended the match");
      assert.equal(after.turn, 2, "submitting a turn must advance the round");
      await page.waitForFunction(() => Array.from(document.querySelectorAll(".mecha-battle-bar > div:first-child span, .mecha-mobile-round")).some((el) => /(?:回合|Turn)\s*2\s*\/\s*15/i.test(el.textContent ?? "")));
      await round.scrollIntoViewIfNeeded();
      assert.match(await round.innerText(), zh ? /回合\s*2\s*\/\s*15/ : /Turn\s*2\s*\/\s*15/i);
      await auditText(round, `${label} next round`);
      assert.deepEqual(errors, [], "uncaught page errors");
      console.log(`PASS ${label}: compact objective/forecast, assumptions, expanded details, keyboard order, unknown, playback and round transition`);
    } catch (e) {
      failures.push(`${label}: ${e.stack ?? e.message}`);
      console.error(`FAIL ${label}: ${e.message}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
if (failures.length) { console.error(`\n${failures.length} matrix case(s) failed:\n${failures.join("\n\n")}`); process.exitCode = 1; }
else console.log("All selected cases passed. Headless synthetic fixture only; filtered runs are not a full matrix pass.");
