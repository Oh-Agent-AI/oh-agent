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
const layoutFailures = [];
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
      body = body.replace(needle, `const fixture = fixtureMatch({ preset: "covers_sparse_mid", script: "cadence_ssw", covers: [], buildings: [{ id: "fixture-building", cells: [{ x: 4, y: 2 }] }], boss: { x: 4, y: 0 },
        raiders: [{ id: "raider-w", pos: { x: 4, y: 4 } }, { id: "raider-e", pos: { x: 6, y: 4 } }],
        mechs: [{ id: "Assault", pos: { x: 5, y: 2 } }, { id: "Gunner", pos: { x: 2, y: 8 } }, { id: "Support", pos: { x: 7, y: 2 } }] });
        // A real sweep hits the building and the shared threatened cell.
        fixture.boss.cadence = 2;
        prepareFixture(fixture);
        // Keep the three fixed intents but vacate their shared cell; it is reachable by Assault.
        fixture.mechs.find((m) => m.id === "Assault").pos = { x: 6, y: 3 };
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
          raycaster.setFromCamera(pointer, camera); root.updateMatrixWorld(true);
          const tile = raycaster.intersectObjects(picks, false)[0]; const unit = unitUnderPointer();
          return { tile: tile?.object.userData.cell ?? null, unit: unit?.id ?? null,
            resolved: unit && (!tile || unit.distance <= tile.distance) ? unit.cell : tile?.object.userData.cell ?? null }; }
      };\n`;
      await route.fulfill({ response, body: body.replace(needle, probe + needle) });
    });
    await page.addInitScript((locale) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; const frame = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => setTimeout(() => frame(cb), 70); }, zh ? "zh-Hans" : "en");
    try {
      await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
      await page.locator(".city-loading").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
      await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
      await page.locator(".mecha-pack li > button").first().click();
      await page.waitForFunction(() => {
        const s = window.__orderController?.getState();
        return s?.selected === "Assault" && s.match.raiders.every((r) => !s.match.mechs.some((m) => m.pos.x === r.pos.x && m.pos.y === r.pos.y)) && s.reach.some((c) => c.x === 5 && c.y === 2) && s.preview.ok && s.preview.enemyOrder.filter((e) => e.cells.some((c) => c.x === 5 && c.y === 2)).length === 3;
      });
    } catch (error) {
      throw new Error(`[PREFLIGHT/FIXTURE] ${lang}: synthetic city or three-threat setup unavailable; interaction assertions did not run`, { cause: error });
    }
    // Only the later board-picking path needs continuous canvas rendering.
    await page.evaluate(() => { window.__pauseFixtureDraw = true; });
    await page.setViewportSize({ width: 640, height: 480 });
    const summary = page.locator(".mecha-turn-summary");
    const expand = page.getByRole("button", { name: zh ? "展开面板" : "Expand panel", exact: true });
    const compactButton = page.getByRole("button", { name: zh ? "精简面板" : "Compact panel", exact: true });
    const resource = summary.locator(".mecha-objective-card > .mecha-quick-resource");
    const risk = summary.locator("details.mecha-risk-details");
    // The objective card now contains the resource display inside the same
    // scrollport. Expanding must preserve that information and the rail bounds.
    assert.equal(await summary.evaluate((el) => el.classList.contains("is-compact")), true, `${lang}: summary starts compact`);
    assert.equal(await expand.getAttribute("aria-expanded"), "false");
    assert.equal(await summary.locator(".mecha-extra-summary").count(), 0);
    assert.equal(await risk.evaluate((el) => el.open), false, `${lang}: risk details start closed`);
    const expectedResource = await page.evaluate(() => {
      const state = window.__orderController.getState();
      const buildings = state.preview.buildings.filter((b) => b.staked);
      const actual = state.match.buildings.filter((b) => buildings.some((preview) => preview.id === b.id));
      return { count: buildings.length, current: actual.reduce((n, b) => n + b.hp, 0),
        max: actual.reduce((n, b) => n + b.maxHp, 0), predicted: buildings.reduce((n, b) => n + b.endHp, 0) };
    });
    assert.ok(expectedResource.count > 0 && expectedResource.max > 0 && expectedResource.predicted < expectedResource.current,
      `${lang}: fixture must predict real staked-building damage: ${JSON.stringify(expectedResource)}`);
    const resourceText = await resource.innerText();
    assert.equal((await resource.locator("strong").innerText()).trim(), `${expectedResource.current}/${expectedResource.max}`, `${lang}: current resource must match fixture`);
    const prediction = resource.locator("span").filter({ hasText: zh ? "预计" : "Predicted" });
    assert.equal(await prediction.count(), 1);
    assert.ok((await prediction.innerText()).includes(`${expectedResource.predicted}/${expectedResource.max}`), `${lang}: predicted resource must match fixture: ${resourceText}`);
    assert.match(resourceText, zh ? /防守建筑.*预计/s : /Defended building.*Predicted/is);
    await assertUnclipped(resource, `${lang}: current/predicted resources must be visible without scrolling`);
    await assertUnclipped(expand, `${lang}: compact expand control must be visible`);
    const layout = async () => summary.evaluate((el) => {
      const rect = el.getBoundingClientRect(), resource = el.querySelector(".mecha-objective-card > .mecha-quick-resource").getBoundingClientRect();
      const pack = document.querySelector(".mecha-pack").getBoundingClientRect(), submit = document.querySelector(".mecha-submit").getBoundingClientRect();
      const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return { height: rect.height, width: rect.width, scroll: el.scrollHeight, client: el.clientHeight,
        resourceOverlapsPack: overlap(resource, pack), resourceInsideSummary: el.querySelector(".mecha-objective-card > .mecha-quick-resource") !== null, summaryOverlapsSubmit: overlap(rect, submit) };
    });
    const assertRail = (metrics, mode) => {
      assert.ok(metrics.height >= 44 && metrics.height <= 480 * 0.38 + 1 && metrics.width <= 640 * 0.33,
        `${lang}: ${mode} rail must remain bounded at 640x480: ${JSON.stringify(metrics)}`);
      assert.ok(!metrics.resourceOverlapsPack && metrics.resourceInsideSummary && !metrics.summaryOverlapsSubmit,
        `${lang}: ${mode} resource must remain in the summary and not overlap roster or submit: ${JSON.stringify(metrics)}`);
    };
    const compact = await layout();
    assertRail(compact, "compact");
    await assertUnclipped(summary, `${lang}: compact rail must fit inside the viewport`);
    assert.ok(compact.scroll > compact.client, `${lang}: compact rail must retain scrollable controls: ${JSON.stringify(compact)}`);
    if (screenshots) await page.screenshot({ path: join(screenshots, `compact-${lang}-640x480.png`) });
    await risk.locator("summary").click();
    assert.equal(expectedResource.count, 1, `${lang}: comparison fixture requires one defended building`);
    const riskText = await risk.locator("li > button").filter({ hasText: "fixture-building" }).innerText();
    assert.ok(riskText.includes(`${expectedResource.current} → ${expectedResource.predicted}/${expectedResource.max}`),
      `${lang}: expanded risk details must agree with the resource card: ${riskText}`);
    await risk.locator("summary").click();
    await summary.focus(); await page.keyboard.press("End");
    assert.ok(await summary.evaluate((el) => el.scrollTop > 0), `${lang}: compact panel must remain keyboard-scrollable`);
    // A simulated host status transition must not leave the remote-lock warning
    // hidden at the previous compact scroll offset. No relay connection is made.
    await expand.focus();
    // Focus may reveal the button; put the scrollport back at its old offset
    // without changing focus so this checks both transition invariants.
    await summary.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    assert.ok(await summary.evaluate((el) => el.scrollTop > 0), `${lang}: remote transition starts from a scrolled rail`);
    await page.evaluate(() => window.__setFixtureRemoteStatus("starting"));
    await page.waitForFunction(() => document.querySelector(".mecha-turn-summary > p.mecha-resource[role=status]") && document.querySelector(".mecha-turn-summary").scrollTop === 0);
    assert.equal(await summary.evaluate((el) => el.classList.contains("is-compact")), false);
    const remoteToggle = summary.locator(".mecha-summary-toggle");
    assert.equal(await remoteToggle.getAttribute("aria-expanded"), "true");
    assert.equal(await remoteToggle.getAttribute("aria-disabled"), "true");
    assert.equal(await remoteToggle.getAttribute("aria-describedby"), "mecha-remote-lock-status");
    assert.equal(await remoteToggle.evaluate((el) => el === document.activeElement), true, `${lang}: transition must preserve focused disclosure`);
    await page.keyboard.press("Enter");
    assert.equal(await summary.evaluate((el) => el.classList.contains("is-compact")), false, `${lang}: remote disclosure is unavailable`);
    const warning = summary.locator(":scope > p.mecha-resource[role=status]");
    await assertUnclipped(warning, `${lang}: remote-lock warning must be visible on status transition`);
    await page.evaluate(() => window.__setFixtureRemoteStatus("idle"));
    await page.waitForFunction(() => !document.querySelector(".mecha-turn-summary > p.mecha-resource[role=status]"));
    assert.equal(await summary.evaluate((el) => el.classList.contains("is-compact")), true, `${lang}: idle restores compact preference`);
    await expand.click();
    assert.equal(await summary.evaluate((el) => el.classList.contains("is-compact")), false);
    assert.equal(await compactButton.getAttribute("aria-expanded"), "true");
    assert.equal(await summary.locator(".mecha-extra-summary").count(), 1, `${lang}: expanded mode adds tactical context`);
    const expanded = await layout();
    assertRail(expanded, "expanded");
    await assertUnclipped(summary, `${lang}: expanded rail must fit inside the viewport`);
    await assertUnclipped(compactButton, `${lang}: expanded collapse control must be visible`);
    assert.ok(expanded.scroll > compact.scroll && expanded.scroll > expanded.client,
      `${lang}: expanded rail must retain its extra content in the scrollport: ${JSON.stringify({ compact, expanded })}`);
    await assertUnclipped(resource, `${lang}: resources remain visible in expanded mode`);
    await summary.focus(); await page.keyboard.press("End");
    assert.ok(await summary.evaluate((el) => el.scrollTop > 0), `${lang}: expanded panel must remain keyboard-scrollable`);
    if (screenshots) {
      await summary.evaluate((el) => { el.scrollTop = 0; });
      await page.screenshot({ path: join(screenshots, `expanded-${lang}-640x480.png`) });
    }
    // A paragraph may itself exceed the scrollport; check both ends rather
    // than requiring all of it to fit onscreen simultaneously.
    const extraParagraphs = summary.locator(".mecha-extra-summary > p");
    assert.ok(await extraParagraphs.count() >= 3, `${lang}: expanded tactical context must not be empty`);
    // Each paragraph needs the full rail, not a flex column narrow enough to
    // break ordinary words. Long unbreakable strings may still wrap anywhere.
    const textLayout = await summary.locator(".mecha-extra-summary").evaluate((el) => {
      const box = el.getBoundingClientRect();
      const paragraphs = Array.from(el.querySelectorAll(":scope > p"));
      const rects = paragraphs.map((p) => p.getBoundingClientRect());
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let word = null;
      while (walker.nextNode() && !word) {
        const text = walker.currentNode.textContent, match = /\bBoss\b/.exec(text);
        if (!match) continue;
        const lines = [];
        for (let i = 0; i < match[0].length; i++) {
          const r = document.createRange(); r.setStart(walker.currentNode, match.index + i); r.setEnd(walker.currentNode, match.index + i + 1);
          lines.push(r.getBoundingClientRect().top);
        }
        word = lines;
      }
      return { display: getComputedStyle(el).display, width: box.width, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        paragraphs: paragraphs.map((p, i) => ({ width: rects[i].width, top: rects[i].top, bottom: rects[i].bottom,
          fontSize: parseFloat(getComputedStyle(p).fontSize), scrollWidth: p.scrollWidth, clientWidth: p.clientWidth })), word };
    });
    assert.equal(textLayout.display, "block", `${lang}: tactical context paragraphs must stack: ${JSON.stringify(textLayout)}`);
    assert.ok(textLayout.scrollWidth <= textLayout.clientWidth + 1, `${lang}: context must not overflow horizontally: ${JSON.stringify(textLayout)}`);
    for (let i = 0; i < textLayout.paragraphs.length; i++) {
      const p = textLayout.paragraphs[i];
      assert.ok(p.width >= textLayout.width - 1 && p.fontSize >= 12 && p.scrollWidth <= p.clientWidth + 1 &&
        (!i || p.top >= textLayout.paragraphs[i - 1].bottom - 1), `${lang}: readable full-width context paragraph ${i + 1}: ${JSON.stringify(textLayout)}`);
    }
    if (!zh) {
      assert.ok(textLayout.word?.length === 4, `${lang}: fixture must contain the short word Boss`);
      assert.ok(Math.max(...textLayout.word) - Math.min(...textLayout.word) < 1,
        `${lang}: ordinary word Boss must not split across lines: ${JSON.stringify(textLayout)}`);
    }
    for (let i = 0; i < await extraParagraphs.count(); i++) {
      const paragraph = extraParagraphs.nth(i);
      assert.ok((await paragraph.innerText()).trim().length > 0, `${lang}: expanded context paragraph ${i + 1} must contain text`);
      for (const edge of ["start", "end"]) {
        await paragraph.evaluate((el, block) => el.scrollIntoView({ block, inline: "nearest" }), edge);
        await page.waitForTimeout(350); // Allow the rail's scroll-settle alignment to run.
        if (screenshots && i === 0 && edge === "start") await page.screenshot({ path: join(screenshots, `expanded-context-${lang}-640x480.png`) });
        const bounds = await paragraph.evaluate((el, end) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const nodes = []; while (walker.nextNode()) if (walker.currentNode.textContent.trim()) nodes.push(walker.currentNode);
          const node = end ? nodes.at(-1) : nodes[0];
          const text = node.textContent, index = end ? text.trimEnd().length - 1 : text.search(/\S/);
          const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
          const rect = range.getBoundingClientRect(), paragraph = el.getBoundingClientRect(), rail = el.closest(".mecha-turn-summary");
          const box = rail.getBoundingClientRect();
          return { text: rect.toJSON(), paragraphWidth: paragraph.width, paragraphHeight: paragraph.height,
            clipLeft: box.left + rail.clientLeft, clipRight: box.left + rail.clientLeft + rail.clientWidth,
            clipTop: box.top + rail.clientTop, clipBottom: box.top + rail.clientTop + rail.clientHeight };
        }, edge === "end");
        if (!(bounds.text.left >= bounds.clipLeft - 1 && bounds.text.right <= bounds.clipRight + 1 &&
          bounds.text.top >= bounds.clipTop - 1 && bounds.text.bottom <= bounds.clipBottom + 1)) {
          const failure = `${lang}: expanded paragraph ${i + 1} ${edge} text must be reachable: ${JSON.stringify(bounds)}`;
          console.error(failure);
          layoutFailures.push(failure);
        }
      }
    }
    // The order explanation must also reflow in the narrow rail. Its long
    // English text can exceed the scrollport, so verify both ends are reachable.
    const smallOrder = page.getByRole("button", { name: zh ? "结算顺序" : "Attack order", exact: true });
    await smallOrder.click();
    assert.equal(await smallOrder.getAttribute("aria-expanded"), "true");
    assert.equal(await smallOrder.getAttribute("aria-describedby"), "mecha-order-help");
    const smallHelp = summary.locator("#mecha-order-help");
    assert.ok((await smallHelp.innerText()).includes(zh ? "棋盘" : "board remains available"), `${lang}: planning explanation must be present`);
    const helpLayout = await smallHelp.evaluate((el) => ({ width: el.getBoundingClientRect().width,
      parentWidth: el.parentElement.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth,
      display: getComputedStyle(el.parentElement).display }));
    assert.ok(helpLayout.display === "block" && helpLayout.width >= helpLayout.parentWidth - 1 && helpLayout.scroll <= helpLayout.client + 1,
      `${lang}: order explanation must reflow across its rail: ${JSON.stringify(helpLayout)}`);
    let orderRailBox;
    for (const edge of ["start", "end"]) {
      await smallHelp.evaluate((el, block) => el.scrollIntoView({ block, inline: "nearest" }), edge);
      await page.waitForTimeout(350);
      const visible = await smallHelp.evaluate((el, end) => {
        const text = el.firstChild, range = document.createRange(), i = end ? text.length - 1 : 0;
        range.setStart(text, i); range.setEnd(text, i + 1);
        const r = range.getBoundingClientRect(), rail = el.closest(".mecha-turn-summary"), box = rail.getBoundingClientRect();
        return { rect: r.toJSON(), left: box.left + rail.clientLeft, right: box.left + rail.clientLeft + rail.clientWidth,
          top: box.top + rail.clientTop, bottom: box.top + rail.clientTop + rail.clientHeight };
      }, edge === "end");
      const railBox = { top: visible.top, bottom: visible.bottom };
      if (orderRailBox) {
        assert.ok(Math.abs(railBox.top - orderRailBox.top) <= 1 && Math.abs(railBox.bottom - orderRailBox.bottom) <= 1,
          `${lang}: scrolling the order explanation must not resize or move the rail: ${JSON.stringify({ orderRailBox, railBox })}`);
      } else orderRailBox = railBox;
      if (!(visible.rect.left >= visible.left - 1 && visible.rect.right <= visible.right + 1 &&
        visible.rect.top >= visible.top - 1 && visible.rect.bottom <= visible.bottom + 1)) {
        const movement = await smallHelp.evaluate((el, delta) => { const panel = el.closest(".mecha-turn-summary"), before = panel.scrollTop;
          panel.scrollTop += delta; return { before, requested: delta, after: panel.scrollTop, max: panel.scrollHeight - panel.clientHeight }; }, (visible.rect.top < visible.top - 1 ? -Math.max(24, visible.top - visible.rect.top + 12) : Math.max(24, visible.rect.bottom - visible.bottom + 12)));
        await page.waitForTimeout(350);
        const retry = await smallHelp.evaluate((el, end) => {
          const text = el.firstChild, range = document.createRange(), i = end ? text.length - 1 : 0;
          range.setStart(text, i); range.setEnd(text, i + 1);
          const r = range.getBoundingClientRect(), panel = el.closest(".mecha-turn-summary"), p = panel.getBoundingClientRect();
          return { rect: r.toJSON(), left: p.left + panel.clientLeft, right: p.left + panel.clientLeft + panel.clientWidth,
            top: p.top + panel.clientTop, bottom: p.top + panel.clientTop + panel.clientHeight, scrollTop: panel.scrollTop };
        }, edge === "end");
        const complete = retry.rect.left >= retry.left - 1 && retry.rect.right <= retry.right + 1 && retry.rect.top >= retry.top - 1 && retry.rect.bottom <= retry.bottom + 1;
        const failure = `${lang}: order explanation ${edge} clipped after scrollIntoView settles; further scroll ${complete ? "reveals" : "does not reveal"} it: ${JSON.stringify({ visible, movement, retry })}`;
        console.error(failure); layoutFailures.push(failure);
      }
    }
    await smallOrder.click();
    assert.equal(await summary.locator("#mecha-order-help").count(), 0, `${lang}: closed order explanation must leave the accessibility tree`);
    await compactButton.click();
    assert.equal(await summary.evaluate((el) => el.classList.contains("is-compact")), true, `${lang}: collapse restores compact mode`);
    assert.equal(await summary.locator(".mecha-extra-summary").count(), 0);
    await expand.click();
    console.log(`${lang}: 640x480 compact ${compact.height}px (content ${compact.scroll}px), expanded ${expanded.height}px (content ${expanded.scroll}px); resource ${resourceText.replace(/\s+/g, " ")}`);
    console.log(`${lang}: remote lock checked; test board clicks`);
    await page.evaluate(() => { window.__pauseFixtureDraw = false; });
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.getByRole("button", { name: zh ? "重置视角" : "Reset view" }).click();
    const order = page.getByRole("button", { name: zh ? "结算顺序" : "Attack order", exact: true });
    const move = async (input, open) => {
      await page.getByRole("button", { name: zh ? "查看战场" : "View field" }).click();
      // Elevated unit meshes can occlude a tile's projected centre. Find a
      // visible point that production picking actually resolves to this tile,
      // instead of asserting against the old tile-only raycast.
      const p = await page.evaluate(() => {
        const center = window.__orderWorld.project(5, 2);
        for (let radius = 0; radius <= 40; radius += 4) for (let dx = -radius; dx <= radius; dx += 4) for (let dy = -radius; dy <= radius; dy += 4) {
          const x = center.x + dx, y = center.y + dy;
          if (document.elementFromPoint(x, y)?.tagName !== "CANVAS") continue;
          const hit = window.__orderWorld.pick(x, y);
          if (hit.resolved?.x === 5 && hit.resolved.y === 2 && !hit.unit) return { x, y, hit };
        }
        return null;
      });
      assert.ok(p, `${lang}: a visible point must resolve to the threatened tile`);
      if (input === "touch") await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y);
      try {
        await page.waitForFunction(() => { const p = window.__orderController.getState().draft.Assault.moveTo; return p?.x === 5 && p.y === 2; }, null, { timeout: 10_000 });
      } catch (cause) {
        const state = await page.evaluate(() => { const s = window.__orderController.getState(); return { selected: s.selected, draft: s.draft.Assault, fault: s.fault, notice: s.notice, phase: s.match.phase, targeting: s.targeting, inspected: document.querySelector(".mecha-cell-inspector")?.getAttribute("data-cell") }; });
        throw new Error(`${lang}: ${input} tile click did not plan movement; point ${JSON.stringify(p)}, state ${JSON.stringify(state)}`, { cause });
      }
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
    // The compact recap is a named region, distinct
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
    await tabTo(page, page.getByRole("button", { name: zh ? "重置视角" : "Reset view", exact: true }), `${lang}: navigation after restart`);
    console.log(`${lang}: skipped-animation recap matches actual log and ordered HP effects; restart clears it`);
    console.log(`${lang}: compact/scrolled recap discoverability, keyboard disclosure and post-reset focus, explicit order wording checked`);
    assert.deepEqual(errors, []);
    console.log(`${lang}: 640x480 compact panel/keyboard scroll; threatened cell plans movement with order closed/open (mouse and emulated touch); keyboard and touch threat-source selection passed`);
    await context.close();
  }
} finally { await browser.close(); }
assert.deepEqual(layoutFailures, [], "expanded context and order explanation must remain readable after scrolling");
console.log("Synthetic Chromium fixture; no native or physical-input acceptance implied.");
