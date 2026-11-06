#!/usr/bin/env node
// Synthetic City only. Real GLB / real battle player, rule-derived route; no native IPC or relay.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
if (output) await mkdir(output, { recursive:true });
const browser = await chromium.launch({headless:true, args:["--use-angle=metal"]});
const results = [];
const replaceOnce = (source, needle, value) => { assert.equal(source.split(needle).length, 2, `seam: ${needle}`); return source.replace(needle,value); };
try {
  for (const lang of ["zh", "en"]) {
    const context = await browser.newContext({viewport:{width:1100,height:700}, deviceScaleFactor:1});
    const page = await context.newPage(); page.setDefaultTimeout(90000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if(m.type() === "error") errors.push(m.text()); });
    await page.addInitScript(lang => {localStorage.setItem("city.seed","4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en";}, lang);
    await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
      const response = await route.fetch(); let source = await response.text();
      source = replaceOnce(source, "let lastFrame = globalThis.performance.now();", `
        globalThis.__assaultBattleProbe = { actors, root, site, resolveCell, getMechaGlbAsset, createAssaultBattlePlayer, createAssaultBattleHeight };
        let lastFrame = globalThis.performance.now();`);
      source = replaceOnce(source, "const current = viewRef.current;\n      syncOrderMarkers", "if (globalThis.__assaultBattleManual) return;\n      const current = viewRef.current;\n      syncOrderMarkers");
      const assignments = source.match(/player = preview\d*\.player;/g);
      assert.equal(assignments?.length, 1, "one production battle player assignment");
      source = replaceOnce(source, assignments[0], `${assignments[0]} globalThis.__assaultCommittedPlayback = { events: playing.events, completed: false };`);
      source = replaceOnce(source, "const onComplete = () => onPerformanceCompleteRef.current();", "const onComplete = () => { if (globalThis.__assaultCommittedPlayback) globalThis.__assaultCommittedPlayback.completed = true; onPerformanceCompleteRef.current(); };");
      await route.fulfill({response,body:source});
    });
    const button = (zh,en) => page.getByRole("button",{name:lang === "zh" ? zh : en,exact:true});
    try {
      await page.goto(new URL("/?fixtureSessions=30",base).href,{waitUntil:"domcontentloaded",timeout:120000});
      await page.locator(".city-loading").waitFor({state:"hidden",timeout:120000});
      await button("城市设置","City settings").click(); await button("机甲战棋","Mecha tactics").click();
      await page.locator(".mecha-turn-summary").waitFor();
      await page.waitForFunction(() => globalThis.__assaultBattleProbe?.getMechaGlbAsset(globalThis.__assaultBattleProbe.actors.Assault)?.manifest.id === "assault-connected-candidate");
      await button("查看战场","View field").click();
      const setup = await page.evaluate(async () => {
        const p = globalThis.__assaultBattleProbe;
        const { matchFromSite } = await import("/src/game/mecha/matchFromSite.ts");
        const { movementPath } = await import("/src/game/mecha/rules.ts");
        const match = matchFromSite(p.site,{preset:"covers_sparse_mid",script:"siege"});
        const start = match.mechs.find(m => m.id === "Assault").pos;
        let path;
        const turns = r => r.some((c,i) => i>1 && (c.x-r[i-1].x !== r[i-1].x-r[i-2].x || c.y-r[i-1].y !== r[i-1].y-r[i-2].y));
        for (let y=0;y<10;y++) for(let x=0;x<10;x++) {
          const candidate = movementPath(match,start,{x,y},"Assault");
          if(candidate && candidate.length >= 3 && candidate.length <= 5 && (!path || turns(candidate) && !turns(path) || turns(candidate) === turns(path) && candidate.length > path.length)) path = candidate;
        }
        if(!path) throw new Error("fixture requires a multi-cell legal route");
        globalThis.__assaultBattleManual = true;
        p.actors.Assault.position.copy(p.resolveCell(path[0],"Assault"));
        let completed=0, failedGroundQueries=0;
        const height = p.createAssaultBattleHeight(() => { failedGroundQueries++; throw new Error("synthetic stale detailed ground"); });
        const run = p.createAssaultBattlePlayer(p.actors,[{kind:"move",actor:"Assault",path,duration:9}],p.resolveCell,p.root,() => completed++,height);
        const points = path.map(c => p.resolveCell(c,"Assault").toArray());
        const total = Math.max(.24,Math.min(1.2,path.slice(1).reduce((n,c,i)=> n+Math.hypot(c.x-path[i].x,c.y-path[i].y),0)*.2));
        globalThis.__assaultBattleRun = { ...run, path, points, total, elapsed:0, completions:()=>completed, failedGroundQueries:()=>failedGroundQueries };
        return {path,points,total,turns:turns(path),asset:p.getMechaGlbAsset(p.actors.Assault).manifest.id};
      });
      assert.ok(setup.turns,"must exercise a route corner");
      const samples = [];
      for (const t of [0,.05,setup.total*.25,setup.total*.5,setup.total*.75,setup.total+.001]) {
        samples.push(await page.evaluate(t => {
          const p=globalThis.__assaultBattleProbe,r=globalThis.__assaultBattleRun;
          r.player.update(t-r.elapsed); r.elapsed=t;
          const bones=[];p.actors.Assault.traverse(o=>{if(o.isBone)bones.push(...o.quaternion.toArray());});
          return {t,position:p.actors.Assault.position.toArray(),rotation:p.actors.Assault.rotation.toArray().slice(0,3),bones,completed:r.completions(),fallbackQueries:r.failedGroundQueries()};
        }, t));
        await page.waitForTimeout(80);
        if(output) await page.screenshot({path:join(output,`assault-${lang}-${Math.round(t*1000)}ms.png`)});
      }
      const cumulative=[0];for(let i=1;i<setup.points.length;i++)cumulative.push(cumulative[i-1]+Math.hypot(setup.points[i][0]-setup.points[i-1][0],setup.points[i][2]-setup.points[i-1][2]));
      for(const sample of samples){
        const distance=Math.min(1,sample.t/setup.total)*cumulative.at(-1);let segment=0;
        while(segment<setup.points.length-2 && distance>=cumulative[segment+1])segment++;
        const alpha=(distance-cumulative[segment])/(cumulative[segment+1]-cumulative[segment]);
        const expected=setup.points[segment].map((n,i)=>n+(setup.points[segment+1][i]-n)*alpha);
        assert.ok(sample.position.every((n,i)=>Math.abs(n-expected[i])<1e-5),`route mismatch ${JSON.stringify(sample.position)} vs ${expected}`);
        assert.equal(sample.rotation[0],0);assert.equal(sample.rotation[2],0);
      }
      assert.notDeepEqual(samples[1].position,samples[0].position,"no stationary turning stage");
      assert.notDeepEqual(samples[1].bones,samples[2].bones,"real GLB walk clip must change pose");
      assert.equal(samples.at(-1).completed,1);assert.ok(samples.at(-1).fallbackQueries>0);
      const cleanup=await page.evaluate(()=>{const r=globalThis.__assaultBattleRun,p=globalThis.__assaultBattleProbe;const before=p.root.children.length;r.player.dispose();r.release();r.release();globalThis.__assaultBattleManual=false;return{before,after:p.root.children.length};});
      assert.equal(cleanup.before-cleanup.after,2,"effects disposed");
      // Exercise the actual planner -> accepted round -> World factory as well.
      await button("恢复面板","Show HUD").click();
      await page.locator(".mecha-pack li > button").first().click();
      await page.locator(".mecha-move-list > summary").click();
      const destination = `${setup.path.at(-1).x},${setup.path.at(-1).y}`;
      await page.locator(".mecha-move-list select").selectOption(destination);
      await button("应用移动","Apply move").click();
      await page.locator(".mecha-submit-primary").click();
      if (await page.locator(".mecha-hold-confirm").isVisible()) await button("继续提交","Submit anyway").click();
      await page.waitForFunction(() => globalThis.__assaultCommittedPlayback?.events.some(e => e.actor === "Assault" && e.kind === "move"));
      const committed = await page.evaluate(() => globalThis.__assaultCommittedPlayback.events);
      const acceptedMove = committed.find(e => e.actor === "Assault" && e.kind === "move");
      assert.equal(`${acceptedMove.path.at(-1).x},${acceptedMove.path.at(-1).y}`, destination);
      await page.waitForFunction(() => globalThis.__assaultCommittedPlayback?.completed);
      await page.waitForFunction(() => /2\/15/.test(document.querySelector(".mecha-objective-round")?.textContent ?? ""));
      if (output) await page.screenshot({path:join(output,`committed-round-${lang}.png`)});
      await page.locator(".mecha-battle-menu > summary").click();
      await button("退出战斗","Exit battle").click();await page.locator(".mecha-overlay").waitFor({state:"hidden"});
      assert.deepEqual(errors,[]);
      results.push({lang,status:"passed",setup,samples,cleanup,committed});console.log(`PASS Assault ${lang}: ${setup.path.length-1} route segments / ${setup.total.toFixed(2)}s, live GLB, corner, stale-ground fallback, committed round 1->2, cleanup and exit`);
    } catch(error){results.push({lang,status:"failed",error:error.stack,errors});console.error(error);process.exitCode=1;if(output)await page.screenshot({path:join(output,`failure-${lang}.png`)}).catch(()=>{});}
    finally{await context.close();}
  }
} finally {await browser.close();if(output)await writeFile(join(output,"results.json"),JSON.stringify(results,null,2));}
