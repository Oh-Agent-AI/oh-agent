#!/usr/bin/env node
import { completeLocalDeployment } from "./mecha-deployment-browser-helpers.mjs";
// Independent synthetic browser; probes are injected into fetched dev modules,
// never production globals. Actual roster/list/canvas controls change the draft.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const output = process.env.MECHA_SCREENSHOTS_DIR;
const reproduce = process.env.MECHA_DRAFT_REPRODUCE_SNAP === "1";
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
const results = [];
const replaceOnce = (source, needle, replacement) => {
  assert.equal(source.split(needle).length, 2, `unique test seam: ${needle}`);
  return source.replace(needle, replacement);
};
try {
  for (const [lang, reducedMotion] of reproduce ? [["zh", "no-preference"]] : [["zh", "no-preference"], ["en", "no-preference"], ["zh", "reduce"]]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, reducedMotion });
    const page = await context.newPage(); page.setDefaultTimeout(90000);
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await page.addInitScript(lang => {
      localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en";
    }, lang);
    await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
      const response = await route.fetch(); let source = await response.text();
      if (reproduce) {
        source = replaceOnce(source,
          "const moving = (mesh.position.x - spot.x) ** 2 + (mesh.position.z - spot.z) ** 2 > 0.01;",
          "const moving = !connected && mesh.position.distanceToSquared(spot) > 0.01;");
        source = replaceOnce(source, "slide(mesh, spot, reduce);\n          animate(mesh, figure.id", "slide(mesh, spot, reduce || connected);\n          animate(mesh, figure.id");
      }
      source = replaceOnce(source, "let lastFrame = globalThis.performance.now();", `
        globalThis.__draftProbe = { THREE, engine, camera, site, cellWorld, figures, boss, raiderWest, raiderEast, picks, raycaster, animators, getMechaGlbAsset,
          view: () => viewRef.current, pausedRef, frames: [] };
        let lastFrame = globalThis.performance.now();`);
      source = replaceOnce(source, "const bossMoving = boss.position.distanceToSquared(bossFeet) > 0.01;", `
        if (globalThis.__draftProbe.record) {
          const p = globalThis.__draftProbe;
          p.frames.push({ t: now, performing, paused: pausedRef.current, units: current.figures.map(f => {
            const mesh = figures[f.id], target = cellWorld(site, f), a = animators.get(mesh).animator;
            let pose = 2166136261;
            mesh.traverse(o => { if (o !== mesh) for (const v of [...o.position.toArray(), ...o.quaternion.toArray()]) pose = Math.imul(pose ^ Math.round(v * 1e5), 16777619); });
            return { id: f.id, cell: [f.x, f.y], position: mesh.position.toArray(), target: [target.x, target.y, target.z],
              remaining: Math.hypot(mesh.position.x - target.x, mesh.position.z - target.z), action: a.action, elapsed: a.elapsed,
              pose: pose >>> 0 };
          }) });
          if (p.frames.length > 400) p.frames.shift();
        }
        const bossMoving = boss.position.distanceToSquared(bossFeet) > 0.01;`);
      await route.fulfill({ response, body: source });
    });
    const button = (zh, en) => page.getByRole("button", { name: lang === "zh" ? zh : en, exact: true });
    const finishMove = async (id, setup, label) => {
      await page.waitForFunction(({ id, cell }) => {
        const p = globalThis.__draftProbe;
        return p.frames.some(f => f.units.some(u => u.id === id && u.cell.join() === cell.join() && u.remaining < .01 && u.action === "idle"));
      }, { id, cell: setup.cell });
      const frames = await page.evaluate(({ id, cell }) => {
        const p = globalThis.__draftProbe; p.record = false;
        return p.frames.filter(f => !f.performing).flatMap(f => {
          const u = f.units.find(u => u.id === id && u.cell.join() === cell.join()); return u ? [{ ...u, t: f.t }] : [];
        });
      }, { id, cell: setup.cell });
      assert.ok(frames.length, `${label}: captured changed-target frame`);
      const distance = Math.hypot(setup.start[0] - setup.target[0], setup.start[2] - setup.target[2]);
      if (reducedMotion === "reduce") {
        assert.ok(frames[0].remaining < 1e-6, `${label}: accessibility snaps every mech equally`);
        assert.equal(new Set(frames.map(f => f.pose)).size, 1, `${label}: reduced-motion freezes the GLB pose`);
      } else {
        const ratio = frames[0].remaining / distance;
        assert.ok(ratio > .7 && ratio < .85, `${label}: first frame must slide, not teleport (remaining ratio ${ratio})`);
        const walking = frames.filter(f => f.action === "move" && f.remaining > .1);
        assert.ok(walking.length >= 3, `${label}: several real intermediate walking frames`);
        assert.ok(new Set(walking.map(f => f.pose)).size >= 3, `${label}: actual GLB joint/node poses advance`);
        for (let i = 1; i < frames.length; i++) assert.ok(frames[i].remaining <= frames[i - 1].remaining + 1e-6, `${label}: approaches destination`);
      }
      assert.equal(frames.at(-1).action, "idle"); assert.ok(frames.at(-1).remaining < .01);
      results.push({ lang, reducedMotion, id, label, status: "passed", setup, frames });
      console.log(`PASS draft ${lang}/${reducedMotion} ${label}: ${frames.length} frames, first remaining ${frames[0].remaining.toFixed(3)}, last ${frames.at(-1).action}`);
    };
    const arm = async (id, cell) => page.evaluate(({ id, cell }) => {
      const p = globalThis.__draftProbe, target = p.cellWorld(p.site, { x: cell[0], y: cell[1] });
      p.frames = []; p.record = true;
      return { cell, start: p.figures[id].position.toArray(), target: [target.x, target.y, target.z] };
    }, { id, cell });
    try {
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 120000 });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await page.locator(".mecha-turn-summary").waitFor(); await completeLocalDeployment(page);
      await page.waitForFunction(() => {
        const p = globalThis.__draftProbe;
        return p && Object.entries(p.figures).every(([id, m]) => p.getMechaGlbAsset(m)?.manifest.clips.move);
      });
      assert.equal(await page.evaluate(() => { const p = globalThis.__draftProbe; return p.getMechaGlbAsset(p.figures.Assault).manifest.id; }), "assault-connected-candidate");
      await page.waitForTimeout(700);
      for (const [index, id] of ["Assault", "Gunner", "Support"].entries()) {
        await page.locator(".mecha-plan-card__select").nth(index).click();
        await page.waitForFunction(id => globalThis.__draftProbe.view().figures.some(f => f.id === id && f.selected), id);
        await page.locator(".mecha-move-list > summary").click();
        const option = await page.evaluate(id => {
          const p = globalThis.__draftProbe, mesh = p.figures[id];
          return p.view().reach.map(c => ({ c, d: Math.hypot(p.cellWorld(p.site, c).x - mesh.position.x, p.cellWorld(p.site, c).z - mesh.position.z) }))
            .filter(o => o.d > 16 && o.d < 80).sort((a, b) => b.d - a.d)[0]?.c;
        }, id);
        assert.ok(option, `${id}: legal nontrivial list destination`);
        await page.locator("#mecha-move-choice").selectOption(`${option.x},${option.y}`);
        const setup = await arm(id, [option.x, option.y]);
        await button("应用移动", "Apply move").click();
        await finishMove(id, setup, `${id}-list`);
        await page.locator(".mecha-move-list > summary").click();
        // Also cover the user's actual mouse-on-board input, not just an API or list.
        await button("查看战场", "View field").click();
        const pick = await page.evaluate(id => {
          const p = globalThis.__draftProbe, rect = p.engine.domCanvas.getBoundingClientRect(), mesh = p.figures[id];
          p.figures.Assault.parent.updateMatrixWorld(true);
          for (const cell of p.view().reach) {
            const at = p.cellWorld(p.site, cell);
            const d = Math.hypot(at.x - mesh.position.x, at.z - mesh.position.z);
            if (d < 16 || d >= 80) continue;
            if (p.view().figures.some(f => f.id !== id && f.alive && f.x === cell.x && f.y === cell.y)) continue;
            const ndc = new p.THREE.Vector3(at.x, at.y + .35, at.z).project(p.camera);
            if (Math.abs(ndc.x) > .9 || Math.abs(ndc.y) > .9) continue;
            const pointer = new p.THREE.Vector2(ndc.x, ndc.y); p.raycaster.setFromCamera(pointer, p.camera);
            const tile = p.raycaster.intersectObjects(p.picks, false)[0];
            if (!tile || tile.object.userData.cell.x !== cell.x || tile.object.userData.cell.y !== cell.y) continue;
            const unitRay = new p.THREE.Raycaster(); unitRay.setFromCamera(pointer, p.camera);
            // Match production picking: figure roots do not carry userData.role.
            // Do not mistake a model-covered tile for an empty move destination.
            const units = [...Object.values(p.figures), p.boss, p.raiderWest, p.raiderEast];
            if (unitRay.intersectObjects(units, true).some(h => {
              for (let o = h.object; o; o = o.parent) if (!o.visible) return false;
              return h.distance <= tile.distance;
            })) continue;
            return { cell: [cell.x, cell.y], x: rect.left + (ndc.x + 1) * rect.width / 2, y: rect.top + (1 - ndc.y) * rect.height / 2 };
          }
          return null;
        }, id);
        assert.ok(pick, `${id}: visible legal board destination`);
        const boardSetup = await arm(id, pick.cell);
        await page.mouse.click(pick.x, pick.y); await page.mouse.move(1095, 695);
        await finishMove(id, boardSetup, `${id}-canvas`);
      }
      // Real reset returns all drafts/figures to their original turn positions.
      const beforeReset = await page.evaluate(() => { const p = globalThis.__draftProbe; p.frames = []; p.record = true; return p.view().figures.map(f => ({ id: f.id, cell: [f.x, f.y] })); });
      await button("重置本回合", "Reset turn").click();
      await page.waitForFunction(() => document.querySelector(".mecha-reset-turn")?.disabled);
      await page.waitForTimeout(900);
      const reset = await page.evaluate(() => { const p = globalThis.__draftProbe; p.record = false; return p.frames.at(-1).units; });
      assert.ok(reset.every(u => u.action === "idle" && u.remaining < .01), "reset settles all three mechs to idle");
      results.push({ lang, reducedMotion, label: "reset", status: "passed", beforeReset, reset });
      assert.deepEqual(errors, []);
      if (output) await page.screenshot({ path: join(output, `draft-${lang}-${reducedMotion}.png`) });
      await page.locator(".mecha-battle-menu > summary").click(); await button("退出战斗", "Exit battle").click();
    } catch (error) {
      if (output) await page.screenshot({ path: join(output, `failure-${lang}-${reducedMotion}.png`) }).catch(() => {});
      results.push({ lang, reducedMotion, status: "failed", error: error.stack, errors }); console.error(error); process.exitCode = 1;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
if (output) await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
