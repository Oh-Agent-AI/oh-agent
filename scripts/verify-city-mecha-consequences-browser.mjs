#!/usr/bin/env node
// Synthetic, already-started combat fixture; targets are chosen through real HUD.
// Controller seam only supplies rule state; world seam exposes read-only meshes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
if (output) await mkdir(output, { recursive: true });
const [width, height] = (process.env.MECHA_CONSEQUENCE_SIZE ?? "1100x700").split("x").map(Number);
assert.ok(width > 0 && height > 0, "invalid viewport");
const scenarios = process.env.MECHA_CONSEQUENCE_SCENARIOS?.split(",") ?? ["moved", "blocked", "repair", "repair-threat", "repair-stale"];
assert.ok(scenarios.every(scenario => ["moved", "blocked", "repair", "repair-threat", "repair-stale"].includes(scenario)), "invalid scenario");
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
const results = [];
const replaceOnce = (source, needle, replacement) => {
  assert.equal(source.split(needle).length, 2, `missing seam: ${needle}`);
  return source.replace(needle, replacement);
};
try {
  for (const scenario of scenarios) for (const lang of ["zh", "en"]) {
    console.log(`START ${scenario} ${lang}`);
    const page = await browser.newPage({ viewport:{ width, height }, deviceScaleFactor:1 });
    page.setDefaultTimeout(45000);
    const errors = []; let seams = 0;
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.addInitScript(({ scenario, lang }) => {
        window.__CONSEQUENCE_FIXTURE__ = scenario;
        localStorage.setItem("city.seed", "4196523069");
        window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en";
      }, { scenario, lang });
      await page.route("**/src/game/mecha/controller.ts*", async route => {
        const response = await route.fetch(); let source = await response.text();
        source = replaceOnce(source, "const planner = init.planner ?? planForDoctrine;", `
          if (init.site) {
            const fixture = globalThis.__CONSEQUENCE_FIXTURE__;
            init.site.terrain = Array.from({length:10}, () => Array(10).fill("land"));
            init.site.heights = Array.from({length:10}, () => Array(10).fill(0));
            const mechs = (fixture === "repair-threat" || fixture === "repair-stale")
              ? [{id:"Assault",pos:{x:0,y:9}},{id:"Gunner",pos:{x:3,y:4}},{id:"Support",pos:{x:2,y:5}}]
              : fixture === "repair"
              ? [{id:"Assault",pos:{x:0,y:9}},{id:"Gunner",pos:{x:6,y:7}},{id:"Support",pos:{x:6,y:8}}]
              : [{id:"Assault",pos:{x:3,y:4}},{id:"Gunner",pos:fixture === "blocked" ? {x:6,y:3} : {x:0,y:9}},{id:"Support",pos:{x:8,y:9}}];
            init.match = createMatch({preset:"covers_sparse_mid",script:"stationary_smash",terrain:init.site.terrain,heights:init.site.heights,covers:[],obstacles:[],buildings:[],boss:{x:4,y:3},mechs});
            if (fixture === "repair") init.match.mechs.find(m => m.id === "Gunner").hp = 10;
            if (fixture === "repair-threat" || fixture === "repair-stale") init.match.mechs.find(m => m.id === "Gunner").hp = 2;
            if (fixture === "blocked") init.match.mechs.find(m => m.id === "Gunner").hp = 1;
            bossPrepare(init.match);
            init.planner = state => ({revision:state.revision,items:living(state).map(m => ({mechId:m.id,moveTo:null,action:{kind:"skip"}}))});
          }
          const planner = init.planner ?? planForDoctrine;`);
        source = replaceOnce(source, 'const candidateView = candidate ? { ...candidate, preview: derivePreview(candidate.target) } : null;', `
          const candidateView = candidate ? { ...candidate, preview: derivePreview(candidate.target) } : null;
          if (globalThis.__CONSEQUENCE_FIXTURE__ === "repair-stale" && candidateView) candidateView.preview = { ...candidateView.preview, draftVersion: candidateView.preview.draftVersion + 1 };`);
        seams++; await route.fulfill({response,body:source});
      });
      await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
        const response = await route.fetch(); let source = await response.text();
        source = replaceOnce(source, "const raycaster = new THREE.Raycaster();", `
          globalThis.__consequenceProbe = {THREE,engine,camera,site,cellWorld,previewFrame,shoveLanding,shoveArrow,collisionCross,shoveMat,collisionMat};
          const raycaster = new THREE.Raycaster();`);
        seams++; await route.fulfill({response,body:source});
      });
      const button = (zh,en) => page.getByRole("button", {name:lang === "zh" ? zh : en,exact:true});
      await page.goto(new URL("/?fixtureSessions=30",base).href,{waitUntil:"domcontentloaded",timeout:90000});
      await page.locator(".city-loading").waitFor({state:"hidden",timeout:90000});
      await button("城市设置","City settings").click(); await button("机甲战棋","Mecha tactics").click();
      await page.locator('.mecha-overlay[data-phase="player_plan"]').waitFor({timeout:90000});
      await page.waitForFunction(() => !!globalThis.__consequenceProbe, null, {timeout:90000});
      assert.equal(seams,2);
      const isRepair = scenario === "repair" || scenario === "repair-threat" || scenario === "repair-stale";
      if (isRepair) await page.locator(".mecha-pack .mecha-plan-card__select").nth(2).click();
      await page.locator(`.mecha-action-cards [data-mecha-action="${isRepair ? "repair" : "melee"}"]`).click();
      const target = page.locator(".mecha-target-preview .mecha-actions button").filter({hasText:isRepair ? (lang === "zh" ? "射手" : "Gunner") : (lang === "zh" ? "大怪" : "Boss")}).first();
      const candidate = page.locator(".mecha-candidate-result");
      if (scenario === "moved") {
        // Exercise actual canvas pointer hover, not the target button (which
        // only creates a pinned selection on click).
        const at = await page.evaluate(() => {
          const p = globalThis.__consequenceProbe, pos = p.cellWorld(p.site, {x:4,y:3});
          const v = new p.THREE.Vector3(pos.x,pos.y+.6,pos.z).project(p.camera), r = p.engine.domCanvas.getBoundingClientRect();
          return {x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2};
        });
        await page.mouse.move(at.x,at.y);
        await page.locator('.mecha-candidate-panel[data-candidate-source="hover"]').waitFor({state:"attached"});
        assert.equal(await candidate.isVisible(), !(width <= 600 && height >= 420), "hover result is hidden only in the phone command rail");
        assert.equal(await page.locator(".mecha-selected-actions").isVisible(), true, "hover must not hide target controls");
      }
      await target.click();
      await candidate.waitFor({state:"visible"});
      assert.equal(await candidate.getAttribute("data-candidate-source"), "selection");
      const text = await candidate.innerText();
      if (scenario === "repair-stale") {
        assert.match(text, lang === "zh" ? /目标试算不可用，棋盘预测未知/ : /Target preview unavailable/);
        assert.equal(await candidate.locator(".mecha-consequences").count(), 0, "stale candidate must not show old numbers");
        assert.deepEqual(errors, []);
        if (output) await page.screenshot({path:join(output,`${scenario}-${lang}.png`)});
        results.push({scenario,lang,status:"passed",text}); console.log(`PASS ${scenario} ${lang}`);
        continue;
      }
      if (width <= 600 && height >= 420) {
        const overlap = await candidate.evaluate(el => {
          const a = el.getBoundingClientRect();
          return [".mecha-team-planning", ".mecha-turn-summary", ".mecha-battle-bar"].filter(selector => {
            const node = document.querySelector(selector), b = node.getBoundingClientRect();
            return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
          });
        });
        assert.deepEqual(overlap, [], "candidate must not cover roster, objective or top bar");
        assert.equal(await page.locator(".mecha-selected-actions").isVisible(), false, "candidate owns the phone command rail");
      }
      assert.match(text,lang === "zh" ? /本次行动后目标 HP/ : /Target HP after this action/);
      assert.match(text,lang === "zh" ? /整包结束目标 HP/ : /Target HP after the whole turn/);
      await candidate.getByRole("button",{name:lang === "zh" ? "确认选择" : "Confirm target",exact:true}).waitFor({state:"visible"});
      if (isRepair) {
        if (scenario === "repair") {
          assert.match(text,lang === "zh" ? /实际修理 \+1/ : /Actual repair \+1/);
          assert.match(text,/10 → 11/);
          assert.match(text,lang === "zh" ? /敌方阶段未损失 HP/ : /no HP loss in enemy phase/);
        } else {
          assert.match(text,lang === "zh" ? /实际修理 \+4/ : /Actual repair \+4/);
          assert.match(text,lang === "zh" ? /敌方阶段后存活 · HP 6 → 1/ : /survives enemy phase · HP 6 → 1/);
          assert.match(text,lang === "zh" ? /当前草稿 · 敌方阶段被击毁 · HP 2 → 0/ : /Current draft · destroyed in enemy phase · HP 2 → 0/);
        }
        assert.match(text,lang === "zh" ? /修理占用本机甲本回合行动/ : /Repair uses this mech's action/);
        await page.waitForFunction(() => globalThis.__consequenceProbe.previewFrame.visible);
        const meshes = await page.evaluate(() => ({landing:__consequenceProbe.shoveLanding.visible, arrow:__consequenceProbe.shoveArrow.visible,cross:__consequenceProbe.collisionCross.some(m => m.visible)}));
        assert.deepEqual(meshes,{landing:false,arrow:false,cross:false});
      } else {
        assert.match(text,lang === "zh" ? /直接伤害 2/ : /Direct damage 2/);
        assert.match(text,scenario === "blocked" ? (lang === "zh" ? /推挤受阻 · 留在原位/ : /Push blocked · stays in place/) : (lang === "zh" ? /推挤落点/ : /Push landing/));
        if (scenario === "blocked") assert.match(text,lang === "zh" ? /碰撞击毁/ : /Collision destroyed/);
        await page.waitForFunction(({ blocked }) => {
          const p = globalThis.__consequenceProbe;
          return p.shoveLanding.visible && p.shoveArrow.visible === !blocked && p.collisionCross.every(m => m.visible === blocked);
        },{blocked:scenario === "blocked"});
        const marks = await page.evaluate(() => {
          const p = globalThis.__consequenceProbe;
          return { landing:p.shoveLanding.visible, arrow:p.shoveArrow.visible, cross:p.collisionCross.map(m=>m.visible), color:p.shoveLanding.material.color.getHexString(), scale:p.shoveLanding.scale.x,
            frame:[p.previewFrame.position.x,p.previewFrame.position.z], end:[p.shoveLanding.position.x,p.shoveLanding.position.z] };
        });
        assert.equal(marks.scale,2, "boss landing shows full footprint");
        assert.equal(marks.color,scenario === "blocked" ? "ff7668" : "fff5b4");
        assert.equal(JSON.stringify(marks.frame) === JSON.stringify(marks.end),scenario === "blocked", "blocked stays at origin, moving has distinct landing");
        await button("战场设置","Battlefield").click();
        const legend = page.locator('#mecha-battlefield-settings [data-legend-item="shove"]'); await legend.waitFor();
        assert.match(await legend.innerText(),scenario === "blocked" ? (lang === "zh" ? /红色叉号/ : /Red cross/) : (lang === "zh" ? /落点框/ : /brackets/));
        await button("战场设置","Battlefield").click();
      }
      if (isRepair) {
        const repairRows = candidate.locator("[data-repair-forecast] > p, [data-repair-forecast] > small");
        for (let i = 0; i < await repairRows.count(); i++) {
          const row = repairRows.nth(i);
          await row.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
          const visible = await row.evaluate(el => {
            const a = el.getBoundingClientRect(), b = el.closest(".mecha-candidate-panel").getBoundingClientRect();
            return a.top >= Math.max(0,b.top) - 1 && a.bottom <= Math.min(innerHeight,b.bottom) + 1 && a.left >= Math.max(0,b.left) - 1 && a.right <= Math.min(innerWidth,b.right) + 1;
          });
          assert.ok(visible, `repair forecast row ${i} must remain reachable`);
        }
      }
      // The longer collision report may scroll. Both its forecast and the
      // confirmation controls must remain fully reachable, not just present.
      const auditVisibleLines = async () => {
        if (width > 600 || height < 420) return;
        const partial = await candidate.evaluate(panel => {
          const bounds = panel.getBoundingClientRect(), top = bounds.top + panel.clientTop, bottom = top + panel.clientHeight;
          const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT), cut = [];
          while (walker.nextNode()) {
            const node = walker.currentNode, parent = node.parentElement;
            if (!node.textContent.trim() || parent.closest('[aria-hidden="true"], .mecha-sr-only')) continue;
            let closed = false;
            for (let el = parent; el && el !== panel; el = el.parentElement) {
              if (el instanceof HTMLDetailsElement && !el.open && !el.querySelector(":scope > summary")?.contains(node)) { closed = true; break; }
            }
            if (closed) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            for (const rect of range.getClientRects()) if (rect.width && rect.height && rect.bottom > top + 0.5 && rect.top < bottom - 0.5 && (rect.top < top - 1 || rect.bottom > bottom + 1)) cut.push(node.textContent.trim());
          }
          return cut;
        });
        assert.deepEqual(partial, [], "phone result must settle between whole text lines");
      };
      await page.waitForTimeout(250);
      await auditVisibleLines();
      const turn = candidate.locator(".mecha-consequences__turn > p").first();
      await turn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250); // allow the HUD's scroll-edge settling
      const geometry = await turn.evaluate(el => {
        const panel = el.closest(".mecha-candidate-panel"), a = el.getBoundingClientRect(), b = panel.getBoundingClientRect();
        return { visible: a.top >= Math.max(0,b.top) - 1 && a.bottom <= Math.min(innerHeight,b.bottom) + 1 && a.left >= Math.max(0,b.left) - 1 && a.right <= Math.min(innerWidth,b.right) + 1 };
      });
      assert.ok(geometry.visible, "whole-turn HP row must be reachable in the panel");
      await auditVisibleLines();
      const comparisonEnd = candidate.locator(".mecha-consequences__comparison > p").last();
      await comparisonEnd.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const endVisible = await comparisonEnd.evaluate(el => {
        const panel = el.closest(".mecha-candidate-panel"), a = el.getBoundingClientRect(), b = panel.getBoundingClientRect();
        return a.top >= Math.max(0,b.top) - 1 && a.bottom <= Math.min(innerHeight,b.bottom) + 1;
      });
      assert.ok(endVisible, "forecast comparison must be reachable in the panel");
      await auditVisibleLines();
      if (output && scenario === "blocked") await page.screenshot({path:join(output,`${scenario}-${lang}-forecast.png`)});
      const confirm = candidate.getByRole("button",{name:lang === "zh" ? "确认选择" : "Confirm target",exact:true});
      await confirm.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      assert.ok(await confirm.isVisible(), "confirmation must remain visible");
      await auditVisibleLines();
      assert.deepEqual(errors,[]);
      if (output) await page.screenshot({path:join(output,`${scenario}-${lang}.png`)});
      if (width <= 600 && height >= 420) {
        // Keyboard focus can move between both controls without being clipped.
        const cancel = candidate.getByRole("button",{name:lang === "zh" ? "取消选目标" : "Cancel targeting",exact:true});
        await confirm.focus(); await page.keyboard.press("Tab");
        assert.ok(await cancel.evaluate(el => document.activeElement === el), "cancel must follow confirm in keyboard order");
        const focusedVisible = await cancel.evaluate(el => {
          const r = el.getBoundingClientRect(), p = el.closest(".mecha-candidate-panel").getBoundingClientRect();
          return r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom && r.top >= 0 && r.bottom <= innerHeight;
        });
        assert.ok(focusedVisible, "focused control must not be clipped");
        // Exercise both exits; the command deck must return after the result.
        await (lang === "zh" ? cancel : confirm).click();
        await candidate.waitFor({state:"hidden"});
        assert.equal(await page.locator(".mecha-selected-actions").isVisible(), true, "action deck must return after closing target result");
      }
      results.push({scenario,lang,status:"passed",text}); console.log(`PASS ${scenario} ${lang}`);
    } catch(error) {
      if (output) await page.screenshot({path:join(output,`failure-${scenario}-${lang}.png`)}).catch(()=>{});
      results.push({scenario,lang,status:"failed",error:error.stack,errors}); console.error(`FAIL ${scenario} ${lang}`,error); process.exitCode = 1;
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  if (output) await writeFile(join(output,"results.json"),JSON.stringify(results,null,2));
}
