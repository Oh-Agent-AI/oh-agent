#!/usr/bin/env node
// Real placement controls and canvas picks in an independent synthetic Chromium.
// Test-only probes are injected into fetched dev modules, never production globals.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completeLocalDeployment } from "./mecha-deployment-browser-helpers.mjs";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const out = process.env.MECHA_SCREENSHOTS_DIR ?? "artifacts/mecha-clarity-p0/deployment/browser";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
const results = [];
const cases = [["zh", 1768, 748], ["en", 1100, 700], ["zh", 390, 844], ["en", 390, 844], ["zh", 640, 480], ["en", 640, 480]];
const selectedCases = process.env.MECHA_DEPLOYMENT_CASES?.split(",") ?? [];
const replace = (s, needle, body) => { assert.equal(s.split(needle).length, 2, `probe seam: ${needle}`); return s.replace(needle, body); };
try {
  for (const [lang, width, height] of cases) {
    if (selectedCases.length && !selectedCases.includes(`${lang}:${width}x${height}`)) continue;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage(); page.setDefaultTimeout(60000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript(lang => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en"; }, lang);
    await page.route("**/src/game/mecha/controller.ts*", async route => {
      const response = await route.fetch(); let source = await response.text();
      source = replace(source, "rebuild();\n  return controller;", "globalThis.__deploymentController = controller; rebuild();\n  return controller;");
      await route.fulfill({ response, body: source });
    });
    await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
      const response = await route.fetch(); let source = await response.text();
      source = replace(source, "const raycaster = new THREE.Raycaster();", "globalThis.__deploymentWorld = { camera, engine, site, cellWorld, figures, markers, reachMarks, intentArrows, view: () => viewRef.current }; const raycaster = new THREE.Raycaster();");
      await route.fulfill({ response, body: source });
    });
    const button = (zh, en) => page.getByRole("button", { name: lang === "zh" ? zh : en, exact: true });
    const shot = name => page.screenshot({ path: join(out, `${name}-${lang}-${width}.png`) });
    const assertReachable = async (locator, label) => {
      await locator.scrollIntoViewIfNeeded();
      // Wait beyond the layout's delayed settle; immediate visibility can hide a rebound.
      await page.waitForTimeout(400);
      const geometry = await locator.evaluate(el => {
        const rect = el.getBoundingClientRect();
        let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        for (let p = el.parentElement; p; p = p.parentElement) {
          const r = p.getBoundingClientRect(), style = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            clip.left = Math.max(clip.left, r.left + p.clientLeft);
            clip.right = Math.min(clip.right, r.left + p.clientLeft + p.clientWidth);
          }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            clip.top = Math.max(clip.top, r.top + p.clientTop);
            clip.bottom = Math.min(clip.bottom, r.top + p.clientTop + p.clientHeight);
          }
        }
        const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        return { rect: [rect.left, rect.top, rect.right, rect.bottom], clip,
          whole: rect.left >= clip.left - 1 && rect.top >= clip.top - 1 && rect.right <= clip.right + 1 && rect.bottom <= clip.bottom + 1,
          hit: hit === el || el.contains(hit) };
      });
      assert.ok(geometry.whole && geometry.hit, `${label} cannot be reached after settling: ${JSON.stringify(geometry)}`);
    };
    const read = () => page.evaluate(() => {
      const s = globalThis.__deploymentController.getState(), p = globalThis.__deploymentWorld;
      return { phase: s.match.phase, revision: s.match.revision, placements: s.deployment?.placements ?? null, canConfirm: s.deployment?.canConfirm,
        error: s.deployment?.error, cells: s.deployment?.cells ?? [], resetUsed: s.resetTurnUsed, intents: s.match.boss.intent, raiders: s.match.raiders.map(r => r.intent),
        figures: p.view().figures, visible: Object.fromEntries(Object.entries(p.figures).map(([id,m]) => [id,m.visible])),
        reachCount: p.reachMarks.count, arrows: p.intentArrows.filter(a => a.arrow.visible).length };
    });
    try {
      await page.goto(`${base}/?fixtureSessions=30`, { waitUntil: "domcontentloaded", timeout: 240000 });
      await page.locator(".city-loading").waitFor({ state: "hidden" });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await page.waitForFunction(() => globalThis.__deploymentWorld && globalThis.__deploymentController);
      await button("确认部署", "Confirm deployment").waitFor();
      await page.waitForFunction(() => Object.values(globalThis.__deploymentWorld.figures).every(m => !m.visible));
      const initial = await read(); assert.equal(initial.phase, "deployment"); assert.equal(initial.revision, 0);
      assert.equal(initial.intents, null); assert.ok(initial.raiders.every(i => i === null)); assert.deepEqual(initial.figures, []); assert.ok(initial.reachCount >= 3);
      assert.equal(initial.arrows, 0); assert.ok(await button("确认部署", "Confirm deployment").isDisabled());
      assert.equal(await page.locator(".mecha-forecast-status").count(), 0);
      assert.equal(await page.locator(".mecha-threat-details").count(), 0);
      assert.equal(await page.getByRole("button", { name: lang === "zh" ? "结束回合" : "End turn", exact: true }).count(), 0);
      await page.locator(".mecha-tactical-legend > summary").click();
      assert.equal(await page.locator('[data-legend-item="declared"]').count(), 0);
      assert.match(await page.locator('.mecha-tactical-legend [data-legend-item="movement"]').innerText(), /部署区|Deployment zone/);
      await page.locator(".mecha-tactical-legend > summary").click(); await shot("initial");
      if (width <= 600) {
        const boxes = await page.locator(".mecha-team-planning, .mecha-deploy-actions").evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; }));
        assert.ok(boxes[0].bottom + 4 <= boxes[1].top, "mobile deployment action rail must not cover the roster");
      }
      const placement = async (i, cell) => {
        await page.locator(".mecha-deploy-roster .mecha-plan-card__select").nth(i).click();
        const selected = page.locator(".mecha-deploy-roster .mecha-plan-card.is-current");
        assert.equal(await selected.count(), 1, "exactly one deployment card is highlighted");
        assert.equal(await selected.getAttribute("data-mech-id"), ["Assault", "Gunner", "Support"][i]);
        assert.equal(await selected.locator("button").getAttribute("aria-pressed"), "true");
        const selectedStyle = await selected.evaluate(n => ({ border: getComputedStyle(n).borderTopColor, background: getComputedStyle(n).backgroundColor }));
        const idleStyle = await page.locator(".mecha-deploy-roster .mecha-plan-card:not(.is-current)").first().evaluate(n => ({ border: getComputedStyle(n).borderTopColor, background: getComputedStyle(n).backgroundColor }));
        assert.notEqual(selectedStyle.border, idleStyle.border, "selection has a distinct visible frame");
        assert.notEqual(selectedStyle.background, idleStyle.background, "selection has a distinct visible background");
        if ((await page.locator(".mecha-deploy-list").getAttribute("open")) === null) await page.locator(".mecha-deploy-list > summary").click();
        const select = page.locator("#mecha-deploy-choice");
        const place = button("放置机甲", "Place mech");
        if (i === 0) {
          await assertReachable(select, "deployment select");
          await select.focus();
          await select.selectOption(cell);
          await page.keyboard.press("Tab");
          assert.equal(await place.evaluate(el => document.activeElement === el), true, "Tab from deployment select focuses place button");
          await assertReachable(place, "deployment button after keyboard focus");
          await shot("list-controls");
        }
        await select.selectOption(cell);
        await place.click();
      };
      const cells = initial.cells.slice(0, 3).map(c => `${c.x},${c.y}`);
      await placement(0, cells[0]); await placement(1, cells[1]);
      await placement(2, cells[0]); assert.match((await read()).error, /同一格|share/);
      assert.equal((await read()).placements.length, 2);
      await placement(0, cells[1]);
      assert.equal((await read()).placements[0].pos.x, Number(cells[1].split(",")[0]));
      await button("撤销放置", "Undo placement").click();
      assert.equal((await read()).placements[0].pos.x, Number(cells[0].split(",")[0]));
      await button("重置部署", "Reset deployment").click(); assert.equal((await read()).placements.length, 0);
      await button("撤销放置", "Undo placement").click(); assert.equal((await read()).placements.length, 2);
      assert.equal((await read()).resetUsed, false);
      if (width > 800) {
        // Two real canvas picks: invalid empty forward cell, then a legal rear cell.
        const pick = async cell => {
          await button("查看战场", "View field").click();
          const at = await page.evaluate(cell => {
            const p = globalThis.__deploymentWorld, pos = p.cellWorld(p.site, cell), v = p.figures.Assault.position.clone();
            v.set(pos.x, pos.y + .6, pos.z).project(p.camera);
            const r = p.engine.domCanvas.getBoundingClientRect(); return { x:r.left+(v.x+1)*r.width/2, y:r.top+(1-v.y)*r.height/2 };
          }, cell);
          await page.mouse.click(at.x, at.y); await page.mouse.move(width-4, height-4);
          await button("查看战场", "View field").waitFor();
        };
        const invalid = await page.evaluate(() => {
          const s = globalThis.__deploymentController.getState().match;
          const blocked = new Set([...s.buildings.flatMap(b=>b.cells), ...s.obstacles, ...s.raiders.map(r=>r.pos)].map(c=>`${c.x},${c.y}`));
          for(let y=4;y>=2;y--) for(let x=0;x<10;x++) if(!blocked.has(`${x},${y}`) && !(x>=s.boss.anchor.x&&x<s.boss.anchor.x+2&&y>=s.boss.anchor.y&&y<s.boss.anchor.y+2)) return {x,y};
        });
        await page.locator(".mecha-deploy-roster .mecha-plan-card__select").nth(2).click();
        await pick(invalid); assert.match((await read()).error, /部署区|zone/);
        const [x,y] = cells[2].split(",").map(Number); await pick({x,y});
        await page.waitForFunction(() => {
          const text = document.querySelector(".mecha-cell-inspector")?.textContent ?? "";
          return text.includes("Support") || text.includes("支援");
        });
      } else await placement(2, cells[2]);
      await page.waitForFunction(() => globalThis.__deploymentWorld.view().figures.length === 3);
      const ready = await read(); assert.equal(ready.canConfirm, true); assert.equal(ready.intents, null); assert.equal(ready.revision, 0);
      await shot("ready"); await button("确认部署", "Confirm deployment").click();
      await page.locator('[data-phase="player_plan"]').waitFor();
      const active = await read(); assert.equal(active.revision, 1); assert.ok(active.intents); assert.equal(active.resetUsed, false);
      assert.equal(await page.locator(".mecha-deploy-roster").count(), 0); assert.ok(await button("结束回合", "End turn").isVisible());
      await shot("first-turn");
      // Verify normal turn authority and animation are still reachable after deployment.
      await button("结束回合", "End turn").click();
      const risk = button("继续提交", "Submit anyway"); if (await risk.isVisible()) await risk.click();
      await page.waitForFunction(() => globalThis.__deploymentController.getState().match.turn === 2);
      const skip = button("跳过演出", "Skip animation"); if (await skip.isVisible()) await skip.click();
      await page.locator('[data-mecha-settings-trigger="battlefield"]').click();
      await button("新开一局", "New match").click();
      await page.locator('[data-phase="deployment"]').waitFor();
      assert.equal((await read()).placements.length, 0); assert.equal((await read()).intents, null);
      await button("关闭设置", "Close settings").click();
      // Shared helper must use the same real UI for future battle regressions.
      await completeLocalDeployment(page);
      assert.deepEqual(errors, []);
      results.push({ lang, width, status:"passed", initial, ready, firstTurn:active, normalTurn:2, restart:true });
      console.log(`PASS deployment ${lang} ${width}: initialization, placement/swap/undo/reset, illegal feedback, confirmation, turn, restart`);
    } catch (e) { await shot("failure").catch(()=>{}); results.push({lang,width,status:"failed",error:String(e),errors}); throw e; }
    finally { await context.close(); }
  }
} finally { await browser.close(); await writeFile(join(out,"results.json"),JSON.stringify(results,null,2)+"\n"); }
