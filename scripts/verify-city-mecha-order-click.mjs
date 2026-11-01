#!/usr/bin/env node
// Synthetic browser fixture; this verifies interaction semantics, not native hardware.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;

// Playwright's isVisible() does not detect clipping by a scrollport. This is
// a geometric check only; it does not substitute for visual or a11y review.
async function assertUnclipped(locator, message) {
  const geometry = await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left + parent.clientLeft);
        right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top + parent.clientTop);
        bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
      }
    }
    return { rect: rect.toJSON(), clip: { left, top, right, bottom }, visible: rect.width > 0 && rect.height > 0 &&
      rect.left >= left - 1 && rect.top >= top - 1 && rect.right <= right + 1 && rect.bottom <= bottom + 1 };
  });
  assert.ok(geometry.visible, `${message}: ${JSON.stringify(geometry)}`);
}

// Only sequential Tab navigation counts here; directly calling focus() on the
// destination would not show that a keyboard user can reach it.
async function tabTo(page, destination, message) {
  for (let i = 0; i < 100; i++) {
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => !!document.activeElement?.isConnected), `${message}: focus was detached`);
    if (await destination.evaluate((el) => document.activeElement === el)) return;
  }
  assert.fail(`${message}: not reached within 100 Tab presses`);
}
if (screenshots) await mkdir(screenshots, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
} catch (error) {
  throw new Error("[PREFLIGHT] synthetic Chromium could not launch; no interaction assertions ran", { cause: error });
}
try {
  for (const lang of process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"]) {
    const zh = lang === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, hasTouch: true, locale: zh ? "zh-CN" : "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/src/engine/CityEngine.ts*", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const needle = "if (this.documentHidden) return;";
      assert.ok(body.includes(needle), "[FIXTURE] engine render throttle point changed");
      await route.fulfill({ response, body: body.replace(needle, "if (this.documentHidden || window.__pauseFixtureDraw) return;") });
    });
    await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.ok(body.includes(needle), "[FIXTURE] controller instrumentation point changed");
      body = `import { createMatch as fixtureMatch, bossPrepare as prepareFixture, living as fixtureLiving } from "/src/game/mecha/rules.ts";\n` + body;
      const statusNeedle = 'const [remoteStatus, setRemoteStatus] = useState("idle");';
      assert.ok(body.includes(statusNeedle), "[FIXTURE] remote-status instrumentation point changed");
      body = body.replace(statusNeedle, statusNeedle + " window.__setFixtureRemoteStatus = setRemoteStatus;");
      body = body.replace(needle, `const fixture = fixtureMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 },
        raiders: [{ id: "raider-w", pos: { x: 4, y: 4 } }, { id: "raider-e", pos: { x: 6, y: 4 } }],
        mechs: [{ id: "Assault", pos: { x: 5, y: 2 } }, { id: "Gunner", pos: { x: 2, y: 8 } }, { id: "Support", pos: { x: 6, y: 2 } }] });
        prepareFixture(fixture);
        // Keep the three fixed intents but vacate their shared cell; it is reachable by Assault.
        fixture.mechs.find((m) => m.id === "Assault").pos = { x: 5, y: 3 };
        controllerRef.current = createMechaController({ animate: true, locale, site, match: fixture,
          planner: (state) => ({ revision: state.revision, items: fixtureLiving(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) }) });
        window.__orderController = controllerRef.current;`);
      await route.fulfill({ response, body });
    });
    await page.route("**/src/game/CityMechaWorld.tsx*", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const needle = "    const onDown = (event) => {";
      assert.ok(body.includes(needle), "[FIXTURE] world instrumentation point changed");
      const probe = `    window.__orderWorld = {
        project: (x, y) => { const p = cellWorld(site, { x, y }); camera.updateMatrixWorld();
          const v = new THREE.Vector3(p.x, p.y + 0.35, p.z).project(camera); const r = canvas.getBoundingClientRect();
          return { x: r.left + (v.x + 1) * r.width / 2, y: r.top + (1 - v.y) * r.height / 2 }; },
        pick: (x, y) => { const r = canvas.getBoundingClientRect(); pointer.set((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
          raycaster.setFromCamera(pointer, camera); root.updateMatrixWorld(true); return raycaster.intersectObjects(picks, false)[0]?.object.userData.cell ?? null; }
      };\n`;
      await route.fulfill({ response, body: body.replace(needle, probe + needle) });
    });
    await page.addInitScript((locale) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; const frame = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => setTimeout(() => frame(cb), 70); }, zh ? "zh-Hans" : "en");
    try {
      await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
      await page.locator(".city-loading").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
      await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics" }).click();
      await page.locator(".mecha-pack li > button").first().click();
      await page.waitForFunction(() => {
        const s = window.__orderController?.getState();
        return s?.selected === "Assault" && s.reach.some((c) => c.x === 5 && c.y === 2) && s.preview.ok && s.preview.enemyOrder.filter((e) => e.cells.some((c) => c.x === 5 && c.y === 2)).length === 3;
      });
    } catch (error) {
      throw new Error(`[PREFLIGHT/FIXTURE] ${lang}: synthetic city or three-threat setup unavailable; interaction assertions did not run`, { cause: error });
    }
    await page.setViewportSize({ width: 640, height: 480 });
    const summary = page.locator(".mecha-turn-summary");
    const expandedHeight = await summary.evaluate((el) => el.getBoundingClientRect().height);
    await page.getByRole("button", { name: zh ? "精简面板" : "Compact panel" }).click();
    await page.waitForFunction((height) => { const el = document.querySelector(".mecha-turn-summary"); return el?.classList.contains("is-compact") && el.getBoundingClientRect().height <= height - 20; }, expandedHeight);
    const compact = await summary.evaluate((el) => ({ height: el.getBoundingClientRect().height, scroll: el.scrollHeight, client: el.clientHeight }));
    assert.ok(expandedHeight - compact.height >= 20 && compact.height <= 130 && compact.scroll > compact.client,
      `${lang}: compact summary must free space while retaining scroll content: ${JSON.stringify({ expandedHeight, compact })}`);
    console.log(`${lang}: 640x480 summary height ${expandedHeight} → ${compact.height}px`);
    const healthGeometry = await summary.evaluate((el) => { const box = el.getBoundingClientRect(), line = el.querySelector(":scope > .mecha-compact-risk").getBoundingClientRect(), heading = el.querySelector(".mecha-summary-heading").getBoundingClientRect(); return { box: box.toJSON(), line: line.toJSON(), heading: heading.toJSON() }; });
    if (screenshots) await page.screenshot({ path: join(screenshots, `compact-${lang}-640x480.png`) });
    assert.ok(healthGeometry.line.top >= healthGeometry.box.top && healthGeometry.line.bottom <= healthGeometry.box.bottom, `${lang}: initial compact health line must not be cut off: ${JSON.stringify(healthGeometry)}`);
    console.log(`${lang}: compact scroll / remote lock`);
    await summary.focus(); await page.keyboard.press("End");
    assert.ok(await summary.evaluate((el) => el.scrollTop > 0), `${lang}: compact panel must remain keyboard-scrollable`);
    // A simulated host status transition must not leave the remote-lock warning
    // hidden at the previous compact scroll offset. No relay connection is made.
    await page.evaluate(() => window.__setFixtureRemoteStatus("starting"));
    await page.waitForFunction(() => document.querySelector(".mecha-turn-summary [role=status]") && document.querySelector(".mecha-turn-summary").scrollTop === 0);
    assert.equal(await summary.evaluate((el) => el.classList.contains("is-compact")), false);
    assert.equal(await page.getByRole("button", { name: zh ? "展开面板" : "Expand panel" }).count(), 0);
    const warningVisible = await summary.evaluate((el) => { const box = el.getBoundingClientRect(), line = el.querySelector("[role=status]").getBoundingClientRect(); return line.top >= box.top && line.bottom <= box.bottom; });
    assert.ok(warningVisible, `${lang}: remote-lock warning must be visible on status transition`);
    await page.evaluate(() => window.__setFixtureRemoteStatus("idle"));
    await page.waitForFunction(() => !document.querySelector(".mecha-turn-summary [role=status]"));
    await summary.focus(); await page.keyboard.press("Home");
    await page.getByRole("button", { name: zh ? "展开面板" : "Expand panel" }).click();
    assert.ok(await summary.evaluate((el) => el.getBoundingClientRect().height) > compact.height);
    console.log(`${lang}: remote lock checked; test board clicks`);
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.getByRole("button", { name: zh ? "战术视角" : "Tactical view" }).click();
    const order = page.getByRole("button", { name: zh ? "结算顺序" : "Attack order", exact: true });
    const move = async (input, open) => {
      await page.getByRole("button", { name: zh ? "查看战场" : "View field" }).click();
      const p = await page.evaluate(() => window.__orderWorld.project(5, 2));
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, p), "CANVAS");
      assert.deepEqual(await page.evaluate(({ x, y }) => window.__orderWorld.pick(x, y), p), { x: 5, y: 2 });
      if (input === "touch") await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y);
      await page.waitForFunction(() => { const p = window.__orderController.getState().draft.Assault.moveTo; return p?.x === 5 && p.y === 2; }, null, { timeout: 10_000 });
      assert.equal(await page.evaluate(() => window.__orderController.getState().selectedEnemy), null, `${lang}: ${input}, order ${open} selected a threat instead of moving`);
      await page.evaluate(() => window.__orderController.undoMove());
      await page.waitForFunction(() => window.__orderController.getState().draft.Assault.moveTo === null);
    };
    console.log(`${lang}: board-click fixture ready`);
    await move("mouse", false);
    await order.click();
    assert.equal(await order.getAttribute("aria-expanded"), "true", `${lang}: order control must expose its expanded state`);
    const orderRegion = page.getByRole("region", { name: zh ? "结算顺序" : "Attack order", exact: true });
    const modeExplanation = summary.getByText(zh
      ? "列表编号表示预测的敌方顺序；棋盘不保证显示编号。选择敌人可查看威胁，仍可在棋盘规划移动或选目标。"
      : "List numbers show the predicted enemy order; numbers are not guaranteed on the board. Select an enemy to inspect its threat; the board remains available for movement and targeting.", { exact: true });
    assert.equal(await order.getAttribute("aria-describedby"), "mecha-order-help");
    assert.equal(await orderRegion.count(), 1);
    await modeExplanation.scrollIntoViewIfNeeded();
    await assertUnclipped(modeExplanation, `${lang}: visible order wording must distinguish list inspection from board planning`);
    console.log(`${lang}: order disclosure and explanation checked`);
    await move("mouse", true);
    await move("touch", true);
    const sourceButtons = page.locator(".mecha-order ol button");
    assert.equal(await sourceButtons.count(), 3);
    await sourceButtons.nth(0).focus();
    await page.keyboard.press("Enter");
    assert.equal(await sourceButtons.nth(0).getAttribute("aria-pressed"), "true");
    await sourceButtons.nth(1).tap();
    assert.equal(await sourceButtons.nth(1).getAttribute("aria-pressed"), "true");
    assert.equal(await sourceButtons.nth(0).getAttribute("aria-pressed"), "false");
    // Start playback in a small, deliberately scrolled compact panel. The
    // post-turn recap should not be stranded at an old threat scroll position.
    console.log(`${lang}: threat-source selection checked; test recap`);
    // Board-picking assertions are complete; stop fixture rendering while testing
    // DOM-only recap and keyboard paths to avoid saturating SwiftShader.
    await page.evaluate(() => { window.__pauseFixtureDraw = true; });
    await page.setViewportSize({ width: 640, height: 480 });
    await page.getByRole("button", { name: zh ? "精简面板" : "Compact panel" }).click();
    await summary.focus();
    await page.keyboard.press("End");
    assert.ok(await summary.evaluate((el) => el.scrollTop > 0), `${lang}: fixture must begin with a scrolled compact threat panel`);
    // Submit a real accepted turn into the shared threatened cell. Replay must
    // stay hidden during presentation, then use the actual event/health log.
    await page.evaluate(() => {
      const c = window.__orderController;
      c.setSelectedEnemy(null);
      c.setMove("Assault", { x: 5, y: 2 });
      for (const id of ["Assault", "Gunner", "Support"]) c.setAction(id, { kind: "skip" });
      c.submit();
      if (c.getState().holdConfirmation) c.confirmHold();
    });
    await page.waitForFunction(() => window.__orderController.getState().performance !== null);
    assert.equal(await page.locator(".mecha-last-result").count(), 0, "never reveal resolved result during playback");
    await page.getByRole("button", { name: zh ? "跳过演出" : "Skip animation" }).click();
    // Contract for the forthcoming compact recap: a named region, distinct
    // from the current forecast, visible without scrolling the old threat
    // panel after playback, and containing an actual short summary.
    const recap = page.getByRole("region", { name: zh ? "上一回合摘要" : "Previous turn summary", exact: true });
    await recap.waitFor({ state: "visible", timeout: 10_000 });
    await assertUnclipped(recap, `${lang}: previous-turn summary must be discoverable after skipping a scrolled compact panel`);
    assert.ok((await recap.innerText()).trim().length > 0, `${lang}: recap must contain summary text, not just an empty named region`);
    const overlaps = await recap.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [...document.querySelectorAll(".mecha-submit, .mecha-selected-actions, .mecha-panel > .mecha-settings summary")].filter((other) => {
        const b = other.getBoundingClientRect(), style = getComputedStyle(other);
        return b.width && b.height && style.visibility !== "hidden" && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
      }).map((other) => other.className || other.textContent);
    });
    assert.deepEqual(overlaps, [], `${lang}: recap must not cover actionable panels`);
    const settingsCoverSubmit = await page.evaluate(() => {
      const submit = document.querySelector(".mecha-submit")?.getBoundingClientRect();
      if (!submit) return ["missing submit panel"];
      return [...document.querySelectorAll(".mecha-panel .mecha-settings > summary, .mecha-panel .mecha-options-menu > summary")].filter((el) => {
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement && !parent.open && parent !== el.parentElement) return false;
          const style = getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden") return false;
        }
        const box = el.getBoundingClientRect();
        return box.width && box.height && box.left < submit.right && box.right > submit.left && box.top < submit.bottom && box.bottom > submit.top;
      }).map((el) => el.textContent.trim());
    });
    assert.deepEqual(settingsCoverSubmit, [], `${lang}: settings must not cover the current submit panel`);
    if (screenshots) {
      // Resume only for the screenshot so the City canvas catches up to the
      // resolved state; pause again for the DOM-only keyboard assertions.
      await page.evaluate(() => { window.__pauseFixtureDraw = false; });
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(screenshots, `recap-${lang}-640x480.png`) });
      await page.evaluate(() => { window.__pauseFixtureDraw = true; });
    }
    const result = page.locator(".mecha-last-result details");
    const logToggle = result.locator("summary");
    assert.equal((await logToggle.innerText()).trim(), zh ? "上一回合结果" : "Previous turn result");
    // Native summary is keyboard-operable; Chromium does not expose it as
    // a getByRole("button") in every Playwright version.
    console.log(`${lang}: recap visible and not overlapping controls`);
    await summary.focus();
    await tabTo(page, logToggle, `${lang}: full-log disclosure`);
    await assertUnclipped(logToggle, `${lang}: keyboard focus must bring the log disclosure into view`);
    await page.keyboard.press("Enter");
    assert.equal(await result.evaluate((el) => el.open), true, `${lang}: Enter must open the full log`);
    assert.equal(await logToggle.evaluate((el) => document.activeElement === el), true, `${lang}: opening the log must retain focus on its disclosure`);
    await page.keyboard.press("Enter");
    assert.equal(await result.evaluate((el) => el.open), false, `${lang}: Enter must also close the log`);
    console.log(`${lang}: keyboard log disclosure checked`);
    // Preserve the original mouse/disclosure and exact log/health assertions.
    await result.locator("summary").click();
    // The complete log is taller than the small-window rail. The region must
    // itself be keyboard scrollable, without losing access to its disclosure.
    await recap.focus();
    const scrollBefore = await recap.evaluate((el) => ({ top: el.scrollTop, client: el.clientHeight, full: el.scrollHeight }));
    assert.ok(scrollBefore.full > scrollBefore.client, `${lang}: fixture must exercise a scrollable complete log`);
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.querySelector(".mecha-last-result")?.scrollTop > 0, null, { timeout: 3000 });
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.querySelector(".mecha-last-result")?.scrollTop === 0, null, { timeout: 3000 });
    await assertUnclipped(logToggle, `${lang}: log disclosure must be reachable after scrolling back`);
    const evidence = await page.evaluate(() => {
      const s = window.__orderController.getState();
      return { log: s.lastLog, health: s.combat.healthTimeline };
    });
    assert.ok(evidence.log.some((e) => e.type === "move") && evidence.log.some((e) => e.type === "enemy"));
    assert.equal(evidence.health.ok, true);
    assert.ok(evidence.health.steps.length > 0, "fixture must produce real health changes");
    const lists = result.locator("ol");
    assert.equal(await lists.nth(0).locator("li").count(), evidence.log.length);
    assert.equal(await lists.nth(1).locator("li").count(), evidence.health.steps.length);
    for (const [index, step] of evidence.health.steps.entries()) {
      assert.ok((await lists.nth(1).locator("li").nth(index).innerText()).includes(`${step.effect.before} → ${step.effect.after}`));
    }
    // Restart while focus is in the soon-to-be-removed disclosure. Test both
    // stale DOM/focus and that keyboard navigation can reach a surviving tool.
    await logToggle.focus();
    await page.evaluate(() => window.__orderController.restart());
    await result.waitFor({ state: "detached" });
    assert.equal(await recap.count(), 0, `${lang}: restart must remove the previous-turn summary`);
    assert.ok(await page.evaluate(() => !!document.activeElement?.isConnected), `${lang}: restart left focus on a detached node`);
    await tabTo(page, page.getByRole("button", { name: zh ? "战术视角" : "Tactical view", exact: true }), `${lang}: navigation after restart`);
    console.log(`${lang}: skipped-animation recap matches actual log and ordered HP effects; restart clears it`);
    console.log(`${lang}: compact/scrolled recap discoverability, keyboard disclosure and post-reset focus, explicit order wording checked`);
    assert.deepEqual(errors, []);
    console.log(`${lang}: 640x480 compact panel/keyboard scroll; threatened cell plans movement with order closed/open (mouse and emulated touch); keyboard and touch threat-source selection passed`);
    await context.close();
  }
} finally { await browser.close(); }
console.log("Synthetic Chromium fixture; no native or physical-input acceptance implied.");
