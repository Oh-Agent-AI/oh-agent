#!/usr/bin/env node
import { completeLocalDeployment } from "./mecha-deployment-browser-helpers.mjs";
// Reference-inspired regression, not a pixel comparison. Start THIS worktree's
// apps/agent-city/ui Vite server first, then run:
//   node scripts/verify-city-mecha-reference-hud-browser.mjs http://127.0.0.1:5178
// Optional MECHA_HUD_LANG=zh|en and MECHA_HUD_SIZE=640x480|800x600|1100x700
// select a subset for diagnosis (the default runs the full matrix). Optional
// MECHA_SCREENSHOTS_DIR saves screenshots. Playwright is resolved from
// apps/desktop/ui-dev. All sessions/data are synthetic; interception injects a
// display-prediction failure only, not the authoritative submit validation.
// Movement and targeting use the list controls; 3D board picking/visibility is
// not verified. This is headless Chromium, not native/Tauri, physical input, accessibility,
// art-direction, real-data, performance, networking or user acceptance testing.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

let chromium;
try {
  ({ chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright"));
} catch (error) {
  console.error(`HARNESS: cannot load Playwright from apps/desktop/ui-dev: ${error.message}`);
  process.exit(2);
}
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const failures = [];
const harnessFailures = [];
const inconclusive = [];
const allSizes = [[640, 480], [800, 600], [1100, 700]];
const langs = process.env.MECHA_HUD_LANG ? [process.env.MECHA_HUD_LANG] : ["zh", "en"];
const sizes = process.env.MECHA_HUD_SIZE ? allSizes.filter(([w, h]) => `${w}x${h}` === process.env.MECHA_HUD_SIZE) : allSizes;
if (langs.some((lang) => !["zh", "en"].includes(lang)) || !sizes.length) {
  console.error("HARNESS: invalid MECHA_HUD_LANG or MECHA_HUD_SIZE");
  process.exit(2);
}
console.log(`Matrix: ${langs.join(",")} / ${sizes.map(([w, h]) => `${w}x${h}`).join(",")} (serial; a subset is not a full pass)`);
let browser;
try {
  browser = await chromium.launch({ headless: true, args: process.env.MECHA_BROWSER_ANGLE === "metal" ? ["--use-angle=metal"] : ["--enable-unsafe-swiftshader"] });
} catch (error) {
  console.error(`HARNESS: Chromium launch failed: ${error.message}`);
  process.exit(2);
}

// Check full bounding box, overflow clipping and center hit-test. For data text,
// another descendant is acceptable; this is a geometric proxy, not visual OCR.
async function geometry(locator) {
  assert.equal(await locator.count(), 1, "expected exactly one element");
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    let clippedBy = null;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p), r = p.getBoundingClientRect();
      if ((/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.left < r.left - 1 || rect.right > r.right + 1)) ||
          (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.top < r.top - 1 || rect.bottom > r.bottom + 1))) {
        clippedBy = p.className || p.tagName; break;
      }
    }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { box, clippedBy, hit: Boolean(hit && (hit === el || el.contains(hit))), hitTag: hit?.outerHTML.slice(0, 140),
      inViewport: rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
      displayed: getComputedStyle(el).visibility === "visible" && getComputedStyle(el).display !== "none" };
  });
}
async function usable(locator) {
  const g = await geometry(locator);
  assert.ok(g.displayed && g.inViewport && !g.clippedBy && g.hit, JSON.stringify(g));
}
async function overlap(a, b) {
  const x = (await geometry(a)).box, y = (await geometry(b)).box;
  return x.left < y.right - 1 && x.right > y.left + 1 && x.top < y.bottom - 1 && x.bottom > y.top + 1;
}

// Text geometry, not OCR: at the current resting scroll position no *visible*
// line fragment may be cut by an overflow edge. Fully hidden lines are OK only
// if every fragment can be revealed in the existing scroller. We restore the
// original scroll position; we never alter CSS or hide text to make it pass.
async function auditDetailLines(locator, scrollerSelector) {
  assert.equal(await locator.count(), 1, "expected one open detail region");
  const audit = await locator.evaluate((root, selector) => {
    const scroller = root.closest(selector);
    if (!scroller) return { error: `missing scroll ancestor ${selector}` };
    const saved = scroller.scrollTop;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [], hidden = [];
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (!node.textContent.trim() || parent.closest('[aria-hidden="true"], .mecha-sr-only')) continue;
      // Chromium may report rectangles for unpainted content of a closed
      // details element. Audit those lines only after the user opens it.
      let closed = false;
      for (let el = parent; el && el !== root; el = el.parentElement) {
        if (el instanceof HTMLDetailsElement && !el.open && !el.querySelector(":scope > summary")?.contains(node)) { closed = true; break; }
      }
      if (closed) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if (getComputedStyle(parent).visibility !== "visible" || getComputedStyle(parent).display === "none" || !range.getClientRects().length) {
        hidden.push(node.textContent.trim().slice(0, 100));
      } else nodes.push({ node, range });
    }
    const fragments = [];
    for (const { node, range } of nodes) for (let i = 0; i < range.getClientRects().length; i++) fragments.push({ node, range, i });
    const clip = (node, rect) => {
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
      for (let el = node.parentElement; el; el = el.parentElement) {
        const style = getComputedStyle(el), r = el.getBoundingClientRect();
        // The padding box, not the border box, is the overflow clip edge.
        const l = r.left + el.clientLeft, t = r.top + el.clientTop;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, l); right = Math.min(right, l + el.clientWidth); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, t); bottom = Math.min(bottom, t + el.clientHeight); }
      }
      const visible = rect.right > left + 1 && rect.left < right - 1 && rect.bottom > top + 1 && rect.top < bottom - 1;
      const whole = rect.left >= left - 1 && rect.right <= right + 1 && rect.top >= top - 1 && rect.bottom <= bottom + 1;
      return { visible, whole, rect: [rect.left, rect.top, rect.right, rect.bottom].map((n) => Math.round(n * 10) / 10), clip: [left, top, right, bottom].map((n) => Math.round(n * 10) / 10) };
    };
    const partial = [], unreachable = [];
    for (const f of fragments) {
      const r = f.range.getClientRects()[f.i]; if (!r || r.width <= 0 || r.height <= 0) continue;
      const c = clip(f.node, r);
      if (c.visible && !c.whole) partial.push({ text: f.node.textContent.trim().slice(0, 100), ...c });
    }
    for (const f of fragments) {
      let r = f.range.getClientRects()[f.i]; if (!r || r.width <= 0 || r.height <= 0) continue;
      const viewport = scroller.getBoundingClientRect();
      scroller.scrollTop += r.top - (viewport.top + scroller.clientTop + 2);
      r = f.range.getClientRects()[f.i];
      const c = clip(f.node, r);
      if (!c.whole) unreachable.push({ text: f.node.textContent.trim().slice(0, 100), ...c });
    }
    scroller.scrollTop = saved;
    return { count: fragments.length, hidden: hidden.slice(0, 8), partial: partial.slice(0, 8), unreachable: unreachable.slice(0, 8) };
  }, scrollerSelector);
  assert.ok(!audit.error, audit.error);
  assert.ok(audit.count > 0, "no rendered detail text was measured");
  assert.ok(!audit.hidden.length && !audit.partial.length && !audit.unreachable.length,
    `detail text hidden, partially clipped at rest, or not fully revealable: ${JSON.stringify(audit)}`);
}


// Exercise the settled state, not only the initial render. Restore the scroll
// position so the normal control-reachability checks can continue afterwards.
async function auditAfterScrollAndResize(page, locator, selector) {
  const scroller = page.locator(selector);
  const initialScrollTop = await scroller.evaluate((el) => el.scrollTop);
  await scroller.evaluate((el) => { el.scrollTop = Math.min(45, el.scrollHeight - el.clientHeight); });
  await page.waitForTimeout(400);
  await auditDetailLines(locator, selector);
  await page.setViewportSize({width: 700, height: 500});
  await page.waitForTimeout(400);
  await auditDetailLines(locator, selector);
  await page.setViewportSize({width: 640, height: 480});
  await page.waitForTimeout(400);
  await auditDetailLines(locator, selector);
  await scroller.evaluate((el, initial) => { el.scrollTop = initial; }, initialScrollTop);
  await page.waitForTimeout(400);
}

try {
  for (const lang of langs) for (const [width, height] of sizes) {
    const zh = lang === "zh", label = `${lang} ${width}x${height}`;
    const context = await browser.newContext({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, locale: zh ? "zh-CN" : "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    console.log(`START ${label}: loading synthetic City fixture`);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    let injectionCount = 0, injectionError = null;
    await page.route("**/src/game/mecha/controller.ts*", async (route) => {
      try {
        const response = await route.fetch();
        const source = await response.text();
        const needle = "const previewTurn = init.preview ?? previewPlan;";
        if (source.split(needle).length !== 2) throw new Error("preview injection point must match exactly once (Vite source or harness changed)");
        injectionCount++;
        await route.fulfill({ response, body: source.replace(needle, `
        // Read-only synthetic fixture positions: preserve this regression's
        // deterministic first-turn damage/targeting while placing via real UI.
        globalThis.__referenceHudDeployCells = init.site?.mechs.map(m => ({ ...m.pos }));
        const previewTurn = (...args) => {
          if (globalThis.__referenceHudPreviewFailure) throw new Error("synthetic display preview failure");
          return (init.preview ?? previewPlan)(...args);
        };`) });
      } catch (error) { injectionError = error.message; await route.abort(); }
    });
    await page.addInitScript((locale) => {
      localStorage.setItem("city.seed", "4196523069");
      window.__AV_PLUGIN_LOCALE__ = locale;
      // Bound software rendering work on shared/headless hosts, as in the other tests.
      const frame = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map(); let sequence = 0;
      window.requestAnimationFrame = (callback) => {
        const id = ++sequence;
        const timer = setTimeout(() => { const handle = frame((time) => { pending.delete(id); callback(time); }); pending.set(id, { handle }); }, 100);
        pending.set(id, { timer }); return id;
      };
      window.cancelAnimationFrame = (id) => { const entry = pending.get(id); if (entry?.timer !== undefined) clearTimeout(entry.timer); if (entry?.handle !== undefined) cancel(entry.handle); pending.delete(id); };
    }, zh ? "zh-Hans" : "en");
    const check = async (name, fn) => {
      console.log(`START ${label}: ${name}`);
      const before = failures.length + inconclusive.length;
      try {
        await fn();
        // A nested check reports its own result; don't print a misleading PASS
        // for the enclosing stage, but continue if its behavioral flow completed.
        const nestedFailure = failures.length + inconclusive.length > before;
        console.log(`${nestedFailure ? "DONE (nested checks failed or inconclusive)" : "PASS"} ${label}: ${name}`);
        return true;
      } catch (error) {
        if (error.name === "AssertionError") {
          const msg = `APP ${label}: ${name}: ${error.message}`; failures.push(msg); console.error(`FAIL ${msg}`);
        } else {
          // A timeout or a detached locator can be load/HMR contention, a test
          // problem, or an app defect; do not claim a diagnosis without evidence.
          const msg = `${label}: ${name}: ${error.message}`; inconclusive.push(msg); console.error(`INCONCLUSIVE ${msg}`);
        }
        return false;
      }
    };
    const text = (z, e) => zh ? z : e;
    const button = (z, e) => page.getByRole("button", { name: text(z, e), exact: true });
    // Use the actual toolbar controls; this does not exercise 3D board picking.
    const auditMapFocus = async () => {
      const root = page.locator(".mecha-overlay.is-reference-hud");
      const pack = page.locator(".mecha-pack"), candidate = page.locator(".mecha-candidate-panel");
      const draft = await pack.innerText();
      const candidateText = await candidate.count() ? await candidate.innerText() : null;
      const bars = page.locator(".mecha-world-healthbar:not([hidden])");
      const visibleIds = await bars.evaluateAll((els) => els.map((el) => el.dataset.unitId).sort());
      assert.equal(visibleIds.length, 6, "fixture starts with six visible head bars");
      await button("查看战场", "View field").click();
      try {
        assert.equal(await root.getAttribute("data-map-focus"), "true");
        const visiblePanels = await page.locator(".mecha-panel > *").evaluateAll((els) => els
          .filter((el) => getComputedStyle(el).display !== "none").map((el) => el.className));
        assert.deepEqual(visiblePanels, [], "field focus must hide every local HUD panel, including candidate results");
        assert.deepEqual(await bars.evaluateAll((els) => els.map((el) => el.dataset.unitId).sort()), visibleIds);
        for (const bar of await bars.all()) {
          const g = await geometry(bar);
          assert.ok(g.displayed && g.inViewport && !g.clippedBy, "field focus must retain the projected head bars");
        }
        await usable(button("恢复面板", "Show HUD"));
        // CSS-only probe of the stop-session exception, not a remote match.
        await root.evaluate((el) => el.setAttribute("data-remote-active", "true"));
        try {
          assert.deepEqual(await page.locator(".mecha-panel > *").evaluateAll((els) => els
            .filter((el) => getComputedStyle(el).display !== "none").map((el) => el.className)), ["mecha-team-planning"],
          "remote styling must retain only the submit/stop rail in field focus");
        } finally {
          await root.evaluate((el) => el.removeAttribute("data-remote-active"));
        }
      } finally {
        // A regression must not leave the remaining cases in map-focus mode.
        await button("恢复面板", "Show HUD").click();
      }
      assert.equal(await root.getAttribute("data-map-focus"), null);
      assert.equal(await pack.innerText(), draft, "field focus must not change the draft");
      await usable(page.locator(".mecha-submit-primary"));
      await usable(page.locator(".mecha-selected-portrait"));
      for (const card of await page.locator(".mecha-action-cards button").all()) await usable(card);
      if (candidateText !== null) {
        assert.equal(await candidate.innerText(), candidateText, "field focus must not change the selected target or prediction");
        for (const control of await candidate.locator(".mecha-candidate-actions button").all()) await usable(control);
      }
    };
    try {
      // A wrong server, missing dependency, or changed injection is a harness failure,
      // not a verdict on the redesign. Preflight is deliberately outside app checks.
      let response;
      try {
        response = await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 90_000 });
        assert.ok(response?.ok(), `server returned ${response?.status()}`);
        await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 90_000 });
        if (injectionError || injectionCount !== 1) throw new Error(injectionError ?? `preview interception count ${injectionCount}, expected 1; use the City Vite server`);
      } catch (error) { throw new Error(`HARNESS preflight: ${injectionError ?? error.message}`); }
      const entered = await check("enter synthetic battle", async () => {
        await button("城市设置", "City settings").click();
        await button("机甲战棋", "Mecha tactics").click();
        await page.locator(".mecha-turn-summary").waitFor(); const preferred = await page.evaluate(() => globalThis.__referenceHudDeployCells);
        const deployed = await completeLocalDeployment(page, preferred);
        assert.deepEqual(deployed, preferred.map(c => `${c.x},${c.y}`), "HUD fixture must deploy at its original legal cells through the UI");
        // Deployment leaves the last placed unit selected. This regression's
        // three-action deck contract is for Assault, so select it through UI.
        await page.locator(".mecha-pack .mecha-plan-card__select").filter({ hasText: text("突击", "Assault") }).click();
      });
      if (!entered) continue;
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(500);
      if (screenshots) {
        await page.screenshot({ path: join(screenshots, `planning-${lang}-${width}x${height}.png`) });
        await page.locator(".mecha-team-planning").screenshot({ path: join(screenshots, `team-planning-${lang}-${width}x${height}.png`) });
      }
      const summary = page.locator(".mecha-turn-summary"), pack = page.locator(".mecha-pack");
      const actions = page.locator(".mecha-selected-actions"), submit = page.locator(".mecha-submit-primary");
      const forecast = page.locator("details.mecha-resource > summary");
      const turn = page.locator(".mecha-objective-card .mecha-objective-round").first();
      await check("reference: turn and building forecast immediately readable", async () => {
        assert.match(await turn.innerText(), zh ? /回合\s*1\s*\/\s*15/ : /Turn\s*1\s*\/\s*15/);
        await usable(turn);
        // Building status belongs to the objective card and is readable
        // without opening the detailed per-building forecast.
        const quick = page.locator(".mecha-objective-card > .mecha-quick-resource");
        assert.match(await quick.innerText(), zh ? /80\s*\/\s*80.*预计.*68\s*\/\s*80/s : /80\s*\/\s*80.*Predicted.*68\s*\/\s*80/s);
        await usable(quick);
        assert.match(await forecast.innerText(), zh ? /风险详情/ : /Risk details/);
      });
      await check("information ownership: team, objective, command and inspection", async () => {
        const team = page.locator(".mecha-team-planning");
        assert.equal(await team.locator(".mecha-submit").count(), 1);
        assert.equal(await team.locator(".mecha-objective-round, .mecha-planning-round").count(), 0);
        assert.equal(await team.locator(".mecha-pack").count(), 1);
        assert.equal(await team.getByRole("button", { name: zh ? "重置本回合" : "Reset turn", exact: true }).count(), 1);
        assert.equal(await actions.getByRole("button", { name: zh ? "重置本回合" : "Reset turn", exact: true }).count(), 0);
        assert.equal(await actions.getByRole("button", { name: zh ? "撤回移动" : "Undo move", exact: true }).count(), 1);
        assert.equal(await page.locator(".mecha-quick-resource").count(), 1, "no duplicate building strip");
        assert.equal(await summary.locator(".mecha-objective-card > .mecha-quick-resource").count(), 1);
        assert.equal(await page.locator(".mecha-battle-bar .mecha-objective-round, .mecha-mobile-round").count(), 0);
        assert.doesNotMatch(await page.locator(".mecha-battle-bar").innerText(), zh ? /回合\s*\d+\// : /Turn\s*\d+\//i);
        assert.match(await actions.locator("h3").innerText(), zh ? /操作机甲/ : /Operating mech/);
        await usable(team.locator("h3"));
        await usable(team.locator(".mecha-planning-controls"));
        const outer = (await geometry(team)).box, roster = (await geometry(pack)).box;
        assert.ok(roster.left >= outer.left && roster.right <= outer.right && roster.bottom <= outer.bottom, "roster stays in team region");
      });
      await check("visual hierarchy: single roster frame and consistent control geometry", async () => {
        // Confirming deployment replaces the panel beneath the pointer. Read
        // resting styles here, not an incidental hover on a newly-mounted card.
        await page.mouse.move(width - 4, height - 4);
        await page.waitForFunction(() => [...document.querySelectorAll(".mecha-pack .mecha-plan-card__select")].every(n => !n.matches(":hover") && getComputedStyle(n).backgroundColor === "rgba(0, 0, 0, 0)"), null, { timeout: 5000 });
        // Computed-style contracts catch cascade regressions; they are not a
        // substitute for screenshot review or an accessibility audit.
        const styles = await pack.evaluate((el) => {
          const read = (node) => {
            const s = getComputedStyle(node);
            return { border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth], radius: s.borderRadius,
              background: s.backgroundColor, shadow: s.boxShadow, size: s.fontSize, weight: s.fontWeight, numeric: s.fontVariantNumeric };
          };
          return [...el.querySelectorAll("li.mecha-plan-card")].map((card) => ({
            frame: read(card), button: read(card.querySelector(".mecha-plan-card__select")),
            name: read(card.querySelector(".mecha-plan-card__identity strong")), hp: read(card.querySelector(".mecha-plan-card__identity > span")),
            status: read(card.querySelector(".mecha-plan-card__status")),
            chevronColumn: getComputedStyle(card.querySelector("summary"), "::after").gridColumnStart,
          }));
        });
        assert.equal(styles.length, 3);
        for (const [index, style] of styles.entries()) {
          assert.deepEqual(style.frame.border, ["1px", "1px", "1px", "1px"], `card ${index} uses one frame`);
          assert.equal(style.frame.radius, "4px");
          assert.deepEqual(style.button.border, ["0px", "0px", "0px", "0px"], "identity button has no nested frame");
          assert.equal(style.button.background, "rgba(0, 0, 0, 0)"); assert.equal(style.button.shadow, "none");
          assert.equal(style.name.size, "12px"); assert.equal(style.name.weight, "600");
          assert.equal(style.hp.size, "11px"); assert.equal(style.hp.weight, "400"); assert.match(style.hp.numeric, /tabular-nums/);
          assert.equal(style.status.size, "11px"); assert.equal(style.status.weight, "500");
          assert.equal(style.chevronColumn, "3", "chevron stays in its own column with or without risk");
        }
        const buttons = await page.locator(".mecha-planning-controls > button").evaluateAll((nodes) => nodes.map((node) => {
          const s = getComputedStyle(node); return { radius: s.borderRadius, background: s.backgroundColor };
        }));
        assert.equal(buttons.length, 2); assert.ok(buttons.every((s) => s.radius === "4px"));
        assert.notEqual(buttons[0].background, buttons[1].background, "primary submit remains distinct from reset");
        const deck = await actions.locator(".mecha-action-card").evaluateAll((nodes) => nodes.map((node) => {
          const s = getComputedStyle(node); return { selected: node.classList.contains("is-selected"), radius: s.borderRadius,
            border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth], padding: s.padding };
        }));
        assert.equal(deck.length, 3); assert.equal(deck.filter((s) => s.selected).length, 1);
        for (const style of deck) {
          assert.equal(style.radius, "4px"); assert.deepEqual(style.border, ["1px", "1px", "1px", "1px"]);
          assert.equal(style.padding, deck[0].padding, "selection changes emphasis, not button geometry");
        }
      });
      await check("three mech status controls and submit are reachable", async () => {
        assert.equal(await pack.locator("li > button").count(), 3);
        for (const card of await pack.locator("li.mecha-plan-card").all()) await usable(card);
        for (const item of await pack.locator("li > button").all()) { assert.match(await item.innerText(), /\d+\s*HP/); await item.scrollIntoViewIfNeeded(); await usable(item); }
        assert.equal(await submit.isEnabled(), true); await usable(submit);
      });
      await check("battle bar controls are fully visible and hit-testable", async () => {
        const controls = page.locator(".mecha-battle-controls > button");
        assert.equal(await controls.count(), 5, "planning fixture has field, reset-view, order and two separate settings controls");
        assert.equal(await page.locator('.mecha-battle-controls > button[data-mecha-settings-trigger="battlefield"]').count(), 1);
        assert.equal(await page.locator('.mecha-battle-controls > button[data-mecha-settings-trigger="remote"]').count(), 1);
        for (const control of await controls.all()) { assert.equal(await control.isEnabled(), true); await usable(control); }
        const menu = page.locator(".mecha-battle-menu > summary");
        await usable(menu); await menu.click();
        await usable(button("退出战斗", "Exit battle"));
        await menu.click();
      });
      await check("planning: field focus hides HUD and restores unchanged draft", auditMapFocus);
      await check("critical planning panels do not overlap", async () => {
        for (const [a, b, name] of [[summary, actions, "summary/actions"], [summary, pack, "summary/roster"], [actions, pack, "actions/roster"], [actions, page.locator(".mecha-submit"), "actions/submit"]]) {
          assert.equal(await overlap(a, b), false, `${name} overlap`);
        }
      });
      await check("forecast, threats and order can be reached", async () => {
        await forecast.scrollIntoViewIfNeeded(); await usable(forecast);
        await forecast.click();
        assert.equal(await page.locator("details.mecha-resource").evaluate((el) => el.open), true);
        await check("building details: no half-lines and all text reachable", async () => {
          await auditDetailLines(page.locator("details.mecha-resource"), ".mecha-turn-summary");
          if (width === 640 && height === 480) await auditAfterScrollAndResize(page, page.locator("details.mecha-resource"), ".mecha-turn-summary");
        });
        const building = page.locator("details.mecha-resource li > button").first();
        await building.scrollIntoViewIfNeeded(); await usable(building);
        await forecast.scrollIntoViewIfNeeded(); await forecast.click();
        const order = button("结算顺序", "Attack order");
        await order.scrollIntoViewIfNeeded(); await usable(order); await order.click();
        await check("attack order: no half-lines and all text reachable", async () => {
          await auditDetailLines(page.locator(".mecha-order"), ".mecha-turn-summary");
        });
        const orderItems = page.locator(".mecha-order ol button"), threats = page.locator(".mecha-threat-sources button");
        assert.ok(await orderItems.count() > 0); assert.deepEqual(await orderItems.allTextContents(), await threats.allTextContents());
        await orderItems.first().scrollIntoViewIfNeeded(); await usable(orderItems.first()); await orderItems.first().click();
        assert.equal(await orderItems.first().getAttribute("aria-pressed"), "true");
        await order.scrollIntoViewIfNeeded(); await order.click();
      });
      // Advance the stock deterministic fixture to a turn where move (3,2) and
      // melee Boss are legal, using real UI actions, not direct controller calls.
      const advanced = await check("submit-risk cancel and confirm, advance fixture", async () => {
        const draftBefore = await pack.innerText();
        const roundBefore = await page.locator(".mecha-objective-round").innerText();
        const reset = button("重置本回合", "Reset turn");
        const resetEnabled = await reset.isEnabled();
        await submit.click();
        await check("hold confirmation: grouped risk, equal decision buttons and secondary reset", async () => {
          const confirmation = page.locator(".mecha-hold-confirm");
          const risk = confirmation.locator(".mecha-hold-confirm__risk");
          const actions = confirmation.locator(".mecha-hold-confirm__actions > button");
          assert.equal(await actions.count(), 2);
          await usable(risk);
          const a = (await geometry(actions.nth(0))).box, b = (await geometry(actions.nth(1))).box;
          assert.ok(Math.abs(a.top - b.top) < 1 && Math.abs(a.height - b.height) < 1 && Math.abs(a.width - b.width) < 1, "confirmation decisions must share a row and size");
          assert.ok(a.height >= (width <= 600 || height < 420 ? 44 : 32), "minimum decision target height");
          for (const action of [actions.nth(0), actions.nth(1)]) {
            await usable(action);
            assert.equal(await overlap(risk, action), false, "risk text must not mix with decision controls");
          }
          await usable(reset);
          const resetBox = (await geometry(reset)).box;
          assert.ok(resetBox.top >= a.bottom && resetBox.width < (await geometry(confirmation)).box.width - 8, "reset must be a separate, non-stretched secondary action");
          assert.equal(await risk.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, "risk copy must wrap within the narrow roster");
          assert.equal(await overlap(confirmation, pack), false, "confirmation must not overlap the roster");
          assert.equal(await actions.nth(1).getAttribute("aria-describedby"), "mecha-hold-risk");
          if (screenshots) await page.screenshot({ path: join(screenshots, `hold-confirm-${lang}-${width}x${height}.png`) });
        });
        await button("返回修改", "Return to editing").click();
        assert.equal(await page.locator(".mecha-hold-confirm").count(), 0);
        assert.equal(await pack.innerText(), draftBefore, "cancel must preserve the team draft");
        assert.equal(await page.locator(".mecha-objective-round").innerText(), roundBefore, "cancel must not advance the turn");
        assert.equal(await reset.isEnabled(), resetEnabled, "cancel must not spend the reset opportunity");
        await submit.click(); await button("继续提交", "Submit anyway").click();
        assert.equal(await page.locator(".mecha-hold-confirm").count(), 0);
        const skip = button("跳过演出", "Skip animation");
        if (await skip.isVisible().catch(() => false)) await skip.click();
        await page.waitForFunction(() => document.querySelector(".mecha-building-current")?.textContent?.includes("68/80"), null, { timeout: 90_000 });
      });
      if (!advanced) { console.log(`SKIP ${label}: move/target/failure depend on fixture advancement`); continue; }
      const moved = await check("plan a move via reachable controls", async () => {
        await pack.locator("li > button").first().click();
        await page.locator(".mecha-move-list summary").click();
        const select = page.locator(".mecha-move-list select");
        await select.scrollIntoViewIfNeeded();
        // The delayed line-settling logic must not undo native scrolling.
        await page.waitForTimeout(400); await usable(select);
        await select.selectOption("3,2");
        const apply = button("应用移动", "Apply move");
        await select.focus(); await page.keyboard.press("Tab");
        assert.equal(await apply.evaluate(el => document.activeElement === el), true, "Tab from the move selector reaches Apply");
        await page.waitForTimeout(400); await usable(apply);
        if (screenshots) await page.screenshot({ path: join(screenshots, `move-controls-${lang}-${width}x${height}.png`) });
        await apply.click();
        assert.equal(await button("撤回移动", "Undo move").isEnabled(), true);
      });
      if (!moved) { console.log(`SKIP ${label}: target/failure depend on movement`); continue; }
      const melee = actions.getByRole("button", { name: zh ? "近战" : "Melee", exact: true });
      const boss = page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: zh ? "大怪" : "Boss" }).first();
      const candidate = page.locator(".mecha-candidate-result");
      const selectTarget = async () => { await melee.click(); await boss.click(); await candidate.waitFor(); };
      const candidateReady = await check("target prediction and cancel preserve draft", async () => {
        const draft = await pack.innerText();
        await selectTarget();
        assert.match(await candidate.innerText(), zh ? /直接伤害 2/ : /Direct damage 2/);
        assert.match(await candidate.innerText(), zh ? /整包结束目标 HP 36/ : /Target HP after the whole turn 36/);
        assert.equal(await pack.innerText(), draft);
        await check("target details: no half-lines and all text reachable", async () => {
          await auditDetailLines(candidate, ".mecha-candidate-panel");
          const buildings = candidate.locator(".mecha-consequences__turn details");
          if (await buildings.count()) {
            const summary = buildings.locator(":scope > summary");
            await summary.scrollIntoViewIfNeeded(); await summary.click();
            await page.waitForTimeout(250);
            assert.equal(await buildings.evaluate(el => el.open), true);
            await auditDetailLines(candidate, ".mecha-candidate-panel");
            await summary.scrollIntoViewIfNeeded(); await summary.click();
            await candidate.evaluate(el => { el.scrollTop = 0; });
            await page.waitForTimeout(250);
          }
        });
        if (screenshots) await page.screenshot({ path: join(screenshots, `target-${lang}-${width}x${height}.png`) });
        await check("reference: target confirm/cancel immediately visible and unobscured", async () => {
          for (const control of await candidate.locator(".mecha-candidate-actions button").all()) await usable(control);
          assert.equal(await candidate.locator(".mecha-candidate-actions button").count(), 2);
          await usable(page.locator(".mecha-selected-portrait"));
          for (const card of await page.locator(".mecha-action-cards button").all()) await usable(card);
          assert.equal(await overlap(candidate, actions), false, "target result must not cover the portrait/deck");
          assert.equal(await overlap(candidate, summary), false, "target result must not cover objective");
          await usable(page.locator(".mecha-objective-forecast"));
          for (const bar of await page.locator(".mecha-world-healthbar:not([hidden])").all()) {
            assert.equal(await overlap(candidate, bar), false, `target result covers ${await bar.getAttribute("data-unit-id")} head bar`);
          }
        });
        await check("targeting: field focus hides independent results and restores target/deck", auditMapFocus);
        if (width === 640 && height === 480) await check("target details after scroll and resize", async () => {
          await auditAfterScrollAndResize(page, candidate, ".mecha-candidate-panel");
        });
        const cancel = candidate.getByRole("button", { name: text("取消选目标", "Cancel targeting"), exact: true });
        await cancel.scrollIntoViewIfNeeded(); await usable(cancel); await cancel.focus(); await page.keyboard.press("Enter");
        assert.equal(await candidate.count(), 0); assert.equal(await pack.innerText(), draft);
        await check("keyboard cancel restores a visible actionable focus", async () => {
          const focused = page.locator(":focus");
          assert.equal(await focused.count(), 1);
          assert.ok(await focused.evaluate((el) => el instanceof HTMLButtonElement && el.isConnected && !!el.closest(".mecha-overlay") && !el.disabled), "focus must return to an enabled battle action, not body or detached result");
          await usable(focused);
        });
      });
      if (!candidateReady) { console.log(`SKIP ${label}: confirmation/failure depend on target prediction`); continue; }
      await check("confirm target commits only the selected draft", async () => {
        await selectTarget();
        const confirm = candidate.getByRole("button", { name: text("确认选择", "Confirm target"), exact: true });
        await confirm.scrollIntoViewIfNeeded(); await usable(confirm); await confirm.focus(); await page.keyboard.press("Enter");
        assert.equal(await candidate.count(), 0);
        await check("keyboard confirm restores a visible actionable focus", async () => {
          const focused = page.locator(":focus");
          assert.equal(await focused.count(), 1);
          assert.ok(await focused.evaluate((el) => el instanceof HTMLButtonElement && el.isConnected && !!el.closest(".mecha-overlay") && !el.disabled), "focus must return to an enabled battle action, not body or detached result");
          await usable(focused);
        });
      });
      await check("compact roster discloses committed action and target", async () => {
        const plan = pack.locator(".mecha-plan-card__plan").first();
        await plan.locator("summary").click();
        assert.match(await plan.locator(".mecha-plan-card__detail").innerText(), zh ? /近战.*大怪/ : /Melee.*Boss/);
        await plan.locator("summary").click();
      });
      await check("prediction failure clears stale numbers, then recovers", async () => {
        await page.evaluate(() => { globalThis.__referenceHudPreviewFailure = true; });
        await button("撤回移动", "Undo move").click(); // invalidates successful preview
        const failureStatus = page.locator(".mecha-preview-after[role=status]");
        await failureStatus.waitFor();
        assert.match(await failureStatus.innerText(), zh ? /预览暂不可用，风险未知.*当前敌意不是草稿预测/s : /Prediction is temporarily unavailable.*Current threats are not a prediction of this draft/s);
        const quick = page.locator(".mecha-objective-card > .mecha-quick-resource");
        assert.match(await page.locator(".mecha-objective-forecast").innerText(), zh ? /预测未知/ : /(?:forecast|prediction) unknown/i);
        await usable(page.locator(".mecha-objective-forecast"));
        assert.doesNotMatch(await quick.innerText(), zh ? /→|预计/ : /→|Predicted/);
        await usable(quick);
        assert.equal(await page.locator("details.mecha-resource").count(), 0, "old building prediction must be removed");
        assert.equal(await page.locator(".mecha-threat-sources").getAttribute("aria-label"), zh ? "当前宣告威胁来源" : "Declared threat sources", "failure list must be labeled as declarations, not stale predictions");
        assert.equal(await page.locator(".mecha-order ol li").count(), 0, "old predicted order must be removed");
        assert.equal(await page.locator(".mecha-hit").count(), 0, "old predicted hit badges must be removed");
        await page.locator(".mecha-move-list select").selectOption("3,2");
        await button("应用移动", "Apply move").click();
        const draft = await pack.innerText();
        await selectTarget();
        assert.match(await candidate.innerText(), zh ? /预览暂不可用，风险未知/ : /Prediction is temporarily unavailable; risk is unknown/);
        // The heading uses an arrow for actor → target identity; only a
        // numeric transition would be a stale predicted result here.
        assert.doesNotMatch(await candidate.innerText(), zh ? /直接伤害|整包结束目标 HP|\d+\s*→\s*\d+/ : /Direct damage|Target HP after the whole turn|\d+\s*→\s*\d+/);
        assert.equal(await pack.innerText(), draft);
        await check("unavailable target details: no half-lines and all text reachable", async () => {
          await auditDetailLines(candidate, ".mecha-candidate-panel");
          if (width === 640 && height === 480) await auditAfterScrollAndResize(page, candidate, ".mecha-candidate-panel");
        });
        await candidate.getByRole("button", { name: text("取消选目标", "Cancel targeting"), exact: true }).click();
        assert.equal(await candidate.count(), 0, "cancel must clear the failed result");
        assert.equal(await pack.innerText(), draft, "failed preview/cancel must not change draft");
        await page.evaluate(() => { globalThis.__referenceHudPreviewFailure = false; });
        await button("撤回移动", "Undo move").click();
        await page.locator(".mecha-move-list select").selectOption("3,2");
        await button("应用移动", "Apply move").click();
        await selectTarget();
        assert.match(await candidate.innerText(), zh ? /直接伤害 2/ : /Direct damage 2/);
        assert.equal(await failureStatus.count(), 0, "failure status must disappear after recovery");
        assert.equal(await page.locator("details.mecha-resource").count(), 1, "building prediction must recover");
      });
      if (screenshots) await page.screenshot({ path: join(screenshots, `reference-hud-${lang}-${width}x${height}.png`) });
    } catch (error) {
      const message = `${label}: ${error.message}`; harnessFailures.push(message); console.error(`HARNESS ${message}`);
    } finally {
      if (pageErrors.length) { const message = `APP ${label}: uncaught page errors: ${pageErrors.join("; ")}`; failures.push(message); console.error(`FAIL ${message}`); }
      await context.close();
    }
  }
} finally { await browser.close(); }
console.log(`\nResults: ${failures.length} app assertion(s), ${inconclusive.length} inconclusive check(s), ${harnessFailures.length} harness failure(s). Skipped dependent checks are not passes.`);
console.log("Limitations: synthetic fixture and headless browser only; list controls only, no 3D board picking/visibility check; line-range and hit-test geometry do not establish font legibility or pixel-perfect appearance; no native/device/accessibility/network acceptance. Update selectors and injection deliberately if the redesign changes its DOM or preview seam.");
if (harnessFailures.length || inconclusive.length) process.exitCode = 2;
else if (failures.length) process.exitCode = 1;
