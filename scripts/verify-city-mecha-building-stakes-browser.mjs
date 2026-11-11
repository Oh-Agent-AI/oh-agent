#!/usr/bin/env node
// Synthetic frontage match built from two real site building IDs. Start this
// worktree's Vite server first. Headless, programmatic checks are not native,
// physical-input, visual marker or target-user acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const locale of ["en", "zh"]) {
    const zh = locale === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US", deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let injected = 0;
    await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.equal(body.split(needle).length, 2, "fixture injection must match exactly once");
      body = 'import { createMatch as fixtureMatch, bossPrepare as fixturePrepare, living as fixtureLiving, previewPlan as fixturePreview } from "/src/game/mecha/rules.ts";\n' + body;
      body = body.replace(needle, `
        const neighbours = (building) => building.cells.flatMap(({x,y}) => [{x:x-1,y},{x:x+1,y},{x,y:y-1},{x,y:y+1}]).filter(({x,y}) => x >= 0 && x < 10 && y >= 0 && y < 10);
        const key = ({x,y}) => x + ',' + y;
        let chosen = null;
        for (const front of site.buildings) {
          for (const back of site.buildings) {
            if (front.id === back.id) continue;
            const occupied = new Set([...front.cells, ...back.cells].map(key));
            const backNeighbours = new Set(neighbours(back).map(key));
            const road = neighbours(front).find((cell) => !occupied.has(key(cell)) && !backNeighbours.has(key(cell)));
            if (road) { chosen = {front, back, road}; break; }
          }
          if (chosen) break;
        }
        if (!chosen) throw new Error('synthetic mixed-stake fixture needs two suitable site buildings');
        const terrain = Array.from({length: 10}, () => Array(10).fill('land'));
        terrain[chosen.road.y][chosen.road.x] = 'road';
        const fixture = fixtureMatch({ preset:'covers_sparse_mid', script:'stationary_smash', covers:[], terrain,
          buildings:[chosen.front, chosen.back].map(({id,cells}) => ({id,cells})), raiders:[], mechs:site.mechs, boss:site.boss, stake:'frontage' });
        fixture.buildings[0].hp = 6;
        fixture.buildings[1].hp = 2;
        fixturePrepare(fixture);
        const planner = (state) => ({revision:state.revision, items:fixtureLiving(state).map((m) => ({mechId:m.id, moveTo:null, action:{kind:'skip'}}))});
        const expected = fixturePreview(fixture, planner(fixture));
        if (!expected.ok || expected.buildings.length !== 2 || !expected.buildings[0].staked || expected.buildings[1].staked) throw new Error('synthetic mixed-stake fixture is not valid');
        globalThis.__testBuildingPrediction = expected.buildings;
        controllerRef.current = createMechaController({animate:true, locale, site, match:fixture, planner});
      `);
      injected += 1;
      await route.fulfill({ response, body });
    });
    await page.addInitScript((lang) => {
      localStorage.setItem("city.seed", "4196523069");
      window.__AV_PLUGIN_LOCALE__ = lang;
      const frame = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map(); let sequence = 0;
      window.requestAnimationFrame = (callback) => {
        const id = ++sequence;
        const timer = setTimeout(() => { const handle = frame((time) => { pending.delete(id); callback(time); }); pending.set(id, { handle }); }, 100);
        pending.set(id, { timer }); return id;
      };
      window.cancelAnimationFrame = (id) => {
        const entry = pending.get(id);
        if (entry?.timer !== undefined) clearTimeout(entry.timer);
        if (entry?.handle !== undefined) cancel(entry.handle);
        pending.delete(id);
      };
    }, zh ? "zh-Hans" : "en");
    await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 240_000 });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics" }).click();
    const details = page.locator("details.mecha-resource");
    await details.waitFor();
    assert.equal(injected, 1);
    const [front, back] = await page.evaluate(() => globalThis.__testBuildingPrediction);
    assert.equal(front.staked, true);
    assert.equal(back.staked, false);
    for (const [width, height] of [[1100, 700], [1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      const summary = details.locator("summary");
      const text = await summary.innerText();
      assert.ok(text.includes(`${front.startHp}/${front.maxHp}`), `${locale}: current total must exclude non-staked HP`);
      assert.ok(text.includes(`${front.endHp}/${front.maxHp}`), `${locale}: predicted total must exclude non-staked HP`);
      await summary.scrollIntoViewIfNeeded();
      if (!await details.evaluate((node) => node.open)) { await summary.focus(); await page.keyboard.press("Enter"); }
      const buttons = details.locator("li > button");
      assert.equal(await buttons.count(), 2, `${locale}: details must include both defended and non-defended buildings`);
      const defended = buttons.filter({ hasText: front.id });
      const nondefended = buttons.filter({ hasText: back.id });
      assert.equal(await defended.count(), 1);
      assert.equal(await nondefended.count(), 1);
      assert.match(await defended.innerText(), zh ? /防守建筑/ : /Defended building/);
      assert.match(await nondefended.innerText(), zh ? /非防守建筑.*不计入败北/ : /Non-defended building.*does not count toward defeat/);
      for (const [button, expected] of [[defended, front], [nondefended, back]]) {
        const line = await button.innerText();
        assert.ok(line.includes(`${expected.startHp} → ${expected.endHp}/${expected.maxHp}`), `${locale}: each building must show its own HP`);
        assert.ok(line.includes(expected.cells.map(({x, y}) => `${x},${y}`).join("、")), `${locale}: each building must show its cells`);
        await button.scrollIntoViewIfNeeded();
        await button.focus();
        await page.keyboard.press("Enter");
        assert.equal(await button.getAttribute("aria-pressed"), "true", "selecting an entry exposes focused state");
      }
      if (screenshots) await page.screenshot({ path: join(screenshots, `${locale}-${width}x${height}.png`) });
      await summary.scrollIntoViewIfNeeded();
      await summary.focus(); await page.keyboard.press("Enter");
      assert.equal(await details.evaluate((node) => node.open), false);
      console.log(`${locale} ${width}x${height}: stake-scoped totals, both building details, HP, cells and keyboard selection passed`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser.close();
}
