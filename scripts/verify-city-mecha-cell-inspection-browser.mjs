#!/usr/bin/env node
// Synthetic fixture only. Vite interception supplies test terrain and read-only
// projections; all picks go through the real canvas pointer handlers/raycasters.
// No production test hooks, native data, relay or host IPC are used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
if (output) await mkdir(output, { recursive: true });
const sizes = process.env.MECHA_HUD_SIZE ? [process.env.MECHA_HUD_SIZE.split("x").map(Number)] : [[640, 480], [800, 600], [1100, 700]];
const languages = process.env.MECHA_HUD_LANG ? [process.env.MECHA_HUD_LANG] : ["zh", "en"];
const browser = await chromium.launch({ headless: true, args: [process.env.MECHA_BROWSER_ANGLE === "metal" ? "--use-angle=metal" : "--enable-unsafe-swiftshader"] });
const results = [];
const replaceOnce = (source, needle, replacement) => { assert.equal(source.split(needle).length, 2, `harness seam changed: ${needle}`); return source.replace(needle, replacement); };
try {
  for (const lang of languages) for (const [width, height] of sizes) {
    const context = await browser.newContext({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, hasTouch: true, locale: lang === "zh" ? "zh-CN" : "en-US" });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; let seams = 0;
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/src/game/mecha/controller.ts*", async route => {
      const response = await route.fetch(); let source = await response.text();
      source = replaceOnce(source, 'const planner = init.planner ?? planForDoctrine;', `
        if (init.site) {
          init.site.terrain = Array.from({length:10}, () => Array(10).fill("land"));
          init.site.terrain[5][1] = "water"; init.site.terrain[6][1] = "mountain"; init.site.terrain[7][1] = "road";
          init.match = createMatch({ preset:"covers_sparse_mid", script:"stationary_smash", terrain:init.site.terrain, heights:init.site.heights,
            covers:[{x:2,y:2}], obstacles:[{x:2,y:3}], buildings:[{id:"fixture-building", cells:[{x:6,y:6}], hp:16}],
            boss:{x:4,y:3}, raiders:[{id:"raider-w",pos:{x:8,y:7},hp:1}],
            mechs:[{id:"Assault",pos:{x:3,y:4}},{id:"Gunner",pos:{x:2,y:6}},{id:"Support",pos:{x:8,y:8}}] });
          bossPrepare(init.match);
          init.match.raiders[0].pos = {x:8,y:7};
          init.match.raiders[0].intent = {skillId:"smash",status:"planned",local:[{x:0,y:1}],projected:[{x:8,y:8}],cdSweep:0};
          init.preview = (...args) => { if (globalThis.__inspectionFailure) throw new Error("synthetic forecast failure"); return previewPlan(...args); };
          init.planner = state => ({ revision:state.revision, items:living(state).map(m => ({mechId:m.id,moveTo:null,action:{kind:"skip"}})) });
        }
        const planner = init.planner ?? planForDoctrine;`);
      source = replaceOnce(source, 'return controller;', 'globalThis.__inspectionController = controller; return controller;');
      seams++; await route.fulfill({ response, body: source });
    });
    await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
      const response = await route.fetch(); let source = await response.text();
      source = replaceOnce(source, 'const raycaster = new THREE.Raycaster();', `
        globalThis.__inspectionProject = ({cell, unitId, raise = .4}) => {
          root.updateMatrixWorld(true);
          let at;
          if (unitId) {
            const mesh = unitId === "boss" ? boss : figures[unitId] ?? (unitId === "raider-w" ? raiderWest : raiderEast);
            at = mesh.position.clone(); at.y += raise;
          } else { const world = cellWorld(site, cell); at = new THREE.Vector3(world.x, world.y + raise, world.z); }
          at.project(camera); const r = canvas.getBoundingClientRect();
          return { x:r.left+(at.x+1)*r.width/2, y:r.top+(1-at.y)*r.height/2 };
        };
        const raycaster = new THREE.Raycaster();`);
      seams++; await route.fulfill({ response, body: source });
    });
    const name = (zh, en) => lang === "zh" ? zh : en;
    const button = (zh, en) => page.getByRole("button", { name: name(zh, en), exact: true });
    const inspector = page.locator(".mecha-cell-inspector");
    const routeLayer = page.locator(".mecha-world-unit-labels");
    const read = async () => page.evaluate(() => {
      const s = globalThis.__inspectionController.getState();
      return { selected:s.selected, selectedEnemy:s.selectedEnemy, draft:s.draft, match:s.match, projected:s.projectedThreats, targeting:s.targeting };
    });
    const pick = async ({ cell, unitId, raise, touch = false }) => {
      // Field focus exposes tiles hidden by HUD; the actual pick restores it.
      await button("查看战场", "View field").click();
      const at = await page.evaluate(input => globalThis.__inspectionProject(input), { cell, unitId, raise });
      assert.ok(at.x >= 0 && at.x < width && at.y >= 0 && at.y < height, `offscreen projection ${JSON.stringify(at)}`);
      if (touch) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(180);
      assert.equal(await page.locator(".mecha-overlay").getAttribute("data-map-focus"), null, "canvas pick restores HUD");
      assert.equal(await inspector.count(), 1, "one clicked-cell inspector");
    };
    const geometry = async () => {
      const g = await inspector.evaluate(el => {
        const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left+10,r.top+10);
        const portrait = document.querySelector(".mecha-selected-portrait").getBoundingClientRect();
        return { rect:[r.left,r.top,r.right,r.bottom], inViewport:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,
          hit:el.contains(h), overlapsPortrait:r.left<portrait.right&&r.right>portrait.left&&r.top<portrait.bottom&&r.bottom>portrait.top };
      });
      assert.ok(g.inViewport && g.hit && !g.overlapsPortrait, JSON.stringify(g));
    };
    try {
      console.log(`START ${lang} ${width}x${height}`);
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil:"domcontentloaded", timeout:90000 });
      await page.locator(".city-loading").waitFor({ state:"hidden", timeout:90000 });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await page.locator(".mecha-turn-summary").waitFor(); await page.waitForFunction(() => Boolean(globalThis.__inspectionProject));
      assert.equal(seams, 2, "test injection seam count");
      await page.setViewportSize({ width, height }); await page.waitForTimeout(400);
      for (const [cell, expected] of [[{x:1,y:4}, "land"], [{x:1,y:5}, "water"], [{x:1,y:6}, "mountain"], [{x:1,y:7}, "road"], [{x:6,y:6}, "building"], [{x:2,y:2}, "cover"], [{x:2,y:3}, "obstacle"]]) {
        await pick({ cell });
        assert.equal(await inspector.getAttribute("data-cell"), `${cell.x},${cell.y}`);
        const t = await inspector.innerText();
        if (expected === "water") {
          await inspector.locator("summary").click();
          assert.match(await inspector.innerText(), lang === "zh" ? /射击可穿过.*并非落水死亡/s : /shots pass through.*not drowning/s);
          if (output) await page.screenshot({ path:join(output,`water-${lang}-${width}x${height}.png`) });
        } else if (expected === "building") assert.match(t,/HP 16\/16/);
        assert.equal(await inspector.getAttribute("data-inspected-unit"), null);
        await geometry();
      }
      // Friendly and enemy models are hit above the tile, not through a label.
      for (const unitId of ["Assault", "Gunner", "Support", "boss", "raider-w"]) {
        await pick({ unitId, raise:8 });
        assert.equal(await inspector.getAttribute("data-inspected-unit"), unitId, "elevated model pick maps to its rules unit");
        assert.match(await inspector.innerText(), /HP/); await geometry();
        if (unitId === "boss") {
          assert.ok(Number(await routeLayer.getAttribute("data-inspection-routes")) > 0);
          assert.equal(await routeLayer.getAttribute("data-inspection-route-kind"), "attack");
          if (output) await page.screenshot({ path:join(output,`boss-${lang}-${width}x${height}.png`) });
        }
      }
      // Synthetic setup commands, followed by real canvas picks; command UI is
      // separately covered by the existing reference-HUD matrix.
      await page.evaluate(() => globalThis.__inspectionController.setAction("Support",{kind:"melee",target:"raider-w"}));
      await pick({ unitId:"raider-w",raise:8 });
      const killed = await read(); assert.equal(killed.projected.byActor["raider-w"], undefined);
      assert.equal(killed.selectedEnemy,"raider-w");
      assert.equal(await routeLayer.getAttribute("data-inspection-route-kind"),"attack","current declaration survives draft-predicted death");
      await page.evaluate(() => globalThis.__inspectionController.setMove("Assault",{x:3,y:5}));
      await page.waitForTimeout(300);
      await pick({unitId:"Assault",raise:8});
      assert.equal(await routeLayer.getAttribute("data-inspection-route-kind"),"move");
      assert.match(await inspector.innerText(), lang === "zh" ? /尚未执行/ : /not executed/);
      await page.evaluate(() => { globalThis.__inspectionFailure = true; globalThis.__inspectionController.setMove("Gunner", {x:2,y:5}); });
      await pick({ unitId:"boss", raise:8 });
      assert.equal((await read()).projected, null, "failed forecast is unknown, not empty/safe");
      assert.equal(await routeLayer.getAttribute("data-inspection-route-kind"), "attack", "declaration remains visible when forecast fails");
      await page.evaluate(() => { globalThis.__inspectionFailure = false; globalThis.__inspectionController.setMove("Gunner", null); });
      // Real touch picking must preview, not commit an attack. Inspection and
      // trial results share one lower-right scroll rail.
      await page.evaluate(() => { const c=globalThis.__inspectionController; c.selectMech("Assault"); c.setTargeting("melee"); });
      const beforeTarget = await read();
      await pick({ unitId:"boss",raise:8,touch:true });
      assert.equal(await page.locator(".mecha-candidate-panel > .mecha-cell-inspector").count(),1);
      assert.deepEqual((await read()).draft,beforeTarget.draft,"touch target inspection must not commit the action");
      await geometry();
      for (const control of await page.locator(".mecha-candidate-actions button").all()) {
        const g = await control.evaluate(el => { const r=el.getBoundingClientRect(), p=el.closest(".mecha-candidate-panel").getBoundingClientRect(), hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2); return {visible:r.width>0&&r.height>0&&r.top>=p.top&&r.bottom<=p.bottom,hit:el.contains(hit)}; });
        assert.ok(g.visible&&g.hit,"target confirmation/cancellation must be immediately usable, not hidden by inspection");
      }
      if (output) await page.screenshot({path:join(output,`touch-target-${lang}-${width}x${height}.png`)});
      // Scroll to the actual cancel control; no direct controller cancellation.
      const cancel = page.locator(".mecha-candidate-actions").getByRole("button", {name:name("取消选目标", "Cancel targeting"),exact:true});
      await cancel.scrollIntoViewIfNeeded(); await cancel.click();
      assert.deepEqual((await read()).draft,beforeTarget.draft);
      assert.equal(await page.locator(".mecha-panel > .mecha-cell-inspector").count(),1);
      // A camera drag must neither pick a cell nor alter the draft.
      const before = await read(); const inspectedBefore = await inspector.getAttribute("data-cell");
      await button("查看战场", "View field").click();
      await page.mouse.move(width/2,height/2); await page.mouse.down(); await page.mouse.move(width/2+35,height/2+8,{steps:5}); await page.mouse.up();
      assert.equal(await page.locator(".mecha-overlay").getAttribute("data-map-focus"),"true");
      assert.deepEqual((await read()).draft,before.draft);
      await button("恢复面板", "Show HUD").click();
      assert.equal(await inspector.getAttribute("data-cell"),inspectedBefore);
      await button("关闭属性", "Close information").click(); await page.mouse.move(1,1); await page.waitForTimeout(150);
      assert.equal(await inspector.count(),0); assert.equal(await routeLayer.getAttribute("data-inspection-routes"),"0");
      // Inspect a friendly draft before restarting: clearing just the cell
      // leaves its remembered unit ID following the new match's mech.
      await pick({ unitId:"Assault", raise:8 });
      assert.equal(await inspector.getAttribute("data-inspected-unit"),"Assault");
      await page.evaluate(() => globalThis.__inspectionController.restart()); await page.mouse.move(1,1); await page.waitForTimeout(200);
      assert.equal(await inspector.count(),0,"restart clears friendly unit inspection");
      assert.equal(await routeLayer.getAttribute("data-inspection-routes"),"0","restart clears old friendly routes");
      await pick({ unitId:"boss", raise:8 });
      await page.evaluate(() => globalThis.__inspectionController.restart()); await page.mouse.move(1,1); await page.waitForTimeout(200);
      assert.equal(await inspector.count(),0,"restart clears enemy inspection");
      assert.equal(await routeLayer.getAttribute("data-inspection-routes"),"0","restart clears old attack routes");
      assert.deepEqual(errors,[]);
      console.log(`PASS ${lang} ${width}x${height}: terrain, objects, elevated models, declaration vs forecast, friendly path, unknown forecast, touch targeting, drag isolation, close/restart`);
      results.push({lang,width,height,pass:true});
    } catch (error) {
      results.push({lang,width,height,pass:false,error:error.stack, pageErrors:errors});
      console.error(`FAIL ${lang} ${width}x${height}: ${error.stack}`);
      if (output) await page.screenshot({path:join(output,`failure-${lang}-${width}x${height}.png`)}).catch(()=>{});
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
if (output) await writeFile(join(output,"browser-results.json"),JSON.stringify(results,null,2));
console.log(JSON.stringify(results.map(({error,...result})=>result),null,2));
console.log("Scope: synthetic headless canvas picks and DOM geometry. Not native/physical input, real match networking, a11y or pixel-perfect acceptance.");
if (results.some(r=>!r.pass)) process.exitCode=1;
