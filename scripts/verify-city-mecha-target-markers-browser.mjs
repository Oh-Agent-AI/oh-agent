#!/usr/bin/env node
// Integration regression: real City -> MechaBoard -> CityMechaWorld, synthetic
// match/site, not the isolated renderer fixture. Start THIS worktree's City UI
// Vite server, then: node scripts/verify-city-mecha-target-markers-browser.mjs http://127.0.0.1:5178
// The response-only Vite instrumentation creates a deterministic rules fixture,
// injects a display-preview failure, and observes (but does not set) HUD views
// and Three.js marker objects. It never changes checked-in application code.
// The free/shifts fixture follows verify-mecha-controller.ts's two-shove test;
// collision adds an obstacle in the destination footprint. Assertions require
// actual simulator events, not fabricated prediction results. The synthetic flat
// site is overlaid on the City engine and is not a real generated urban site.
// No pixel/screenshot, occlusion, 3D picking, actual-device, Tauri, native,
// networking, performance, accessibility, or production-build coverage. Vite
// transformation seams are intentional: changed seams are harness failures.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

let chromium;
try {
  ({ chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright"));
} catch (error) {
  console.error(`HARNESS: cannot load Playwright from apps/desktop/ui-dev: ${error.message}`);
  process.exit(2);
}
const base = process.argv[2] ?? "http://127.0.0.1:5178";
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"], timeout: 30_000 });
} catch (error) {
  console.error(`HARNESS: Chromium launch failed: ${error.message}`);
  process.exit(2);
}
let appFailures = 0, harnessFailures = 0, inconclusive = 0;
const failures = [];
function replaceOnce(source, needle, replacement, label) {
  if (source.split(needle).length !== 2) throw new Error(`${label}: instrumentation seam must occur exactly once`);
  return source.replace(needle, replacement);
}

try {
  for (const scenario of ["free-and-prior", "collision"]) {
    console.log(`\nSTART ${scenario}: synthetic City / English 1100x700`);
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: "en-US", deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [], instrumentationErrors = [], intercepted = { board: 0, controller: 0, world: 0 };
    page.on("pageerror", (error) => errors.push(error.message));
    const intercept = async (url, name, transform) => page.route(url, async (route) => {
      try {
        const response = await route.fetch({ timeout: 30_000 });
        if (!response.ok()) throw new Error(`${name} returned HTTP ${response.status()}`);
        const body = transform(await response.text());
        intercepted[name]++;
        await route.fulfill({ response, body });
      } catch (error) {
        instrumentationErrors.push(`${name}: ${error.message}`);
        await route.abort();
      }
    });
    await intercept("**/src/game/MechaBoard.tsx*", "board", (source) => {
      source = replaceOnce(source, 'const site = catalog[shapeId] ?? null;', `const originalSite = catalog[shapeId] ?? null;
        const fixtureSites = globalThis.__targetMarkerSites ??= new WeakMap();
        let site = originalSite ? fixtureSites.get(originalSite) : null;
        if (originalSite && !site) {
          site = { ...originalSite,
            heights: Array.from({length: 10}, () => Array(10).fill(0)),
            terrain: Array.from({length: 10}, () => Array(10).fill("land")),
            buildings: [], blocked: globalThis.__targetMarkerScenario === "collision" ? [{x:6,y:4}] : []
          };
          fixtureSites.set(originalSite, site);
        }`, "MechaBoard synthetic site");
      return replaceOnce(source, 'if (!controller || !s || !state || !site) {', `
        globalThis.__targetMarkerBoard = { snapshot: s, view: cityView,
          result: s?.candidate?.preview.ok && selected ? candidateResult(s.candidate.preview, selected, s.candidate.target) : null };
        if (!controller || !s || !state || !site) {`, "MechaBoard view observation");
    });
    await intercept("**/src/game/mecha/controller.ts*", "controller", (source) => {
      source = replaceOnce(source, 'const planner = init.planner ?? planForDoctrine;', `const planner = (state) => ({ revision: state.revision,
        items: living(state).map((m) => ({ mechId: m.id, moveTo: null, action: {kind:"skip"} })) });`, "hold planner");
      source = replaceOnce(source, 'const previewTurn = init.preview ?? previewPlan;', `const previewTurn = (...args) => {
        if (globalThis.__targetMarkerFailure) throw new Error("synthetic display prediction failure");
        return (init.preview ?? previewPlan)(...args);
      };`, "failure switch");
      return replaceOnce(source, 'let match = init.match ?? freshMatch(preset, script, site, stake);', `
        let match = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [],
          terrain: site.terrain, heights: site.heights, obstacles: site.blocked, buildings: [], raiders: [],
          boss: {x:4,y:4}, mechs: [{id:"Assault",pos:{x:3,y:4}}, {id:"Gunner",pos:{x:0,y:9}}, {id:"Support",pos:{x:4,y:3}}] });
        bossPrepare(match);`, "synthetic rules match");
    });
    await intercept("**/src/game/CityMechaWorld.tsx*", "world", (source) => replaceOnce(source,
      'for (const figure of current.figures) {\n        const mesh = figures[figure.id];', `
      globalThis.__targetMarkerWorld = {
        targetPreview: current.targetPreview ?? null, boss: current.boss, rootVisible: root.visible,
        frame: { visible: previewFrame.visible, materialVisible: previewFrame.material.visible,
          position: previewFrame.position.toArray(), scale: previewFrame.scale.toArray() },
        arrow: { visible: shoveArrow.visible, materialVisible: shoveArrow.material.visible,
          position: shoveArrow.position.toArray(), rotation: shoveArrow.rotation.y, scale: shoveArrow.scale.toArray() },
        outline: { visible: shoveOutline.visible, materialVisible: shoveOutline.material.visible },
        bossFeet: footprintFeet(site, current.boss).toArray(),
        shoveFrom: current.targetPreview?.shove ? footprintFeet(site, current.targetPreview.shove.from).toArray() : null,
        shoveTo: current.targetPreview?.shove ? footprintFeet(site, current.targetPreview.shove.to).toArray() : null
      };
      for (const figure of current.figures) {
        const mesh = figures[figure.id];`, "3D frame observation"));
    await page.addInitScript((fixture) => {
      localStorage.setItem("city.seed", "4196523069");
      globalThis.__AV_PLUGIN_LOCALE__ = "en";
      globalThis.__targetMarkerScenario = fixture;
      globalThis.__targetMarkerFailure = false;
      // Throttle software rendering, following other City browser regressions.
      const frame = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map(); let sequence = 0;
      window.requestAnimationFrame = (callback) => {
        const id = ++sequence;
        const timer = setTimeout(() => { const handle = frame((time) => { pending.delete(id); callback(time); }); pending.set(id, {handle}); }, 100);
        pending.set(id, {timer}); return id;
      };
      window.cancelAnimationFrame = (id) => { const entry = pending.get(id); if (entry?.timer !== undefined) clearTimeout(entry.timer); if (entry?.handle !== undefined) cancel(entry.handle); pending.delete(id); };
    }, scenario);

    let stage = "preflight";
    const step = async (name, fn) => { stage = name; console.log(`START ${scenario}: ${name}`); await fn(); console.log(`PASS ${scenario}: ${name}`); };
    const actions = page.locator(".mecha-selected-actions > .mecha-actions");
    const candidate = page.locator(".mecha-candidate-result");
    const melee = actions.getByRole("button", { name: "Melee", exact: true });
    const boss = page.locator(".mecha-target-preview .mecha-actions button").filter({ hasText: "Boss" }).first();
    const choose = async () => { await melee.click(); await boss.click(); await candidate.waitFor(); };
    const cancel = async () => { await candidate.getByRole("button", { name: "Cancel targeting", exact: true }).click(); await candidate.waitFor({ state: "detached" }); };
    const confirm = async () => { await candidate.getByRole("button", { name: "Confirm target", exact: true }).click(); await candidate.waitFor({ state: "detached" }); };
    // Wait for a real world frame corresponding to the latest React view. A
    // mismatch is inconclusive (slow rendering or broken propagation), not pass.
    const readSynchronized = async () => {
      await page.waitForFunction(() => {
        const b = globalThis.__targetMarkerBoard, w = globalThis.__targetMarkerWorld;
        return b && w && JSON.stringify(b.view.targetPreview ?? null) === JSON.stringify(w.targetPreview);
      }, null, { timeout: 30_000 });
      return page.evaluate(() => {
        const { snapshot: s, view, result } = globalThis.__targetMarkerBoard;
        return { selected: s.selected, targeting: s.targeting, draft: s.draft, match: s.match,
          candidate: s.candidate, preview: s.preview, view, result, world: globalThis.__targetMarkerWorld };
      });
    };
    const assertClear = (data) => {
      assert.equal(data.view.targetPreview, undefined, "HUD must clear targetPreview");
      assert.equal(data.world.frame.visible, false, "3D frame must clear");
      assert.equal(data.world.arrow.visible, false, "3D arrow must clear");
      assert.equal(data.world.outline.visible, false, "3D arrow outline must clear");
    };
    const assertFrame = (data) => {
      const { view, world } = data;
      assert.deepEqual(view.targetPreview.target, {x:4,y:4});
      assert.equal(world.rootVisible, true);
      assert.equal(world.frame.visible, true);
      assert.equal(world.frame.materialVisible, true);
      assert.deepEqual(world.frame.scale, [2, 1, 2], "boss frame covers its real 2x2 footprint");
      for (const axis of [0, 2]) assert.ok(Math.abs(world.frame.position[axis] - world.bossFeet[axis]) < 1e-5, "frame anchored to displayed boss");
    };
    const assertArrow = (data) => {
      const { world } = data, arrow = world.arrow;
      assert.equal(arrow.visible, true); assert.equal(arrow.materialVisible, true);
      assert.equal(world.outline.visible, true); assert.equal(world.outline.materialVisible, true);
      for (const axis of [0, 2]) assert.ok(Math.abs(arrow.position[axis] - world.shoveFrom[axis]) < 1e-5, "arrow starts at actual shove origin");
      assert.ok(Math.abs(Math.cos(arrow.rotation) * arrow.scale[0] - (world.shoveTo[0] - world.shoveFrom[0])) < 1e-5);
      assert.ok(Math.abs(-Math.sin(arrow.rotation) * arrow.scale[0] - (world.shoveTo[2] - world.shoveFrom[2])) < 1e-5);
    };
    const assertReadyCandidate = (data, id) => {
      assert.equal(data.selected, id); assert.equal(data.candidate?.target, "boss");
      assert.equal(data.candidate?.source, "selection"); assert.equal(data.candidate?.preview.ok, true);
      assert.equal(data.result?.action?.mechId, id); assert.equal(data.result.action.action, "melee");
      assert.equal(data.result.action.target, "boss"); assert.ok(!data.result.action.fizzled);
    };
    try {
      await step("preflight and enter battle", async () => {
        const response = await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 90_000 });
        if (!response?.ok()) throw new Error(`City server returned ${response?.status()}`);
        await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 90_000 });
        await page.getByRole("button", { name: "City settings", exact: true }).click();
        await page.getByRole("button", { name: "Mecha tactics", exact: true }).click();
        await page.locator(".mecha-turn-summary").waitFor();
        if (instrumentationErrors.length || Object.values(intercepted).some((n) => n !== 1)) throw new Error(`instrumentation: ${JSON.stringify({ intercepted, instrumentationErrors })}`);
        const d = await readSynchronized();
        assert.deepEqual(d.match.boss.anchor, {x:4,y:4});
        assert.deepEqual(d.match.obstacles, scenario === "collision" ? [{x:6,y:4}] : []);
        assert.equal(d.preview.ok, true); assertClear(d);
      });
      await step("select real candidate and inspect simulator + 3D markers", async () => {
        const before = await readSynchronized();
        await choose();
        const d = await readSynchronized(); assertReadyCandidate(d, "Assault");
        assert.deepEqual(d.draft, before.draft, "selection is not confirmation");
        assertFrame(d);
        assert.equal(d.result.shoves.length, 1, "the selected action must actually shove");
        const shove = d.result.shoves[0];
        assert.equal(shove.event.unit, "boss"); assert.deepEqual(shove.from, {x:4,y:4});
        if (scenario === "collision") {
          assert.equal(shove.event.hit, "wall", "real collision event required, not a synthetic arrow input");
          assert.deepEqual(shove.to, shove.from); assert.equal(d.view.targetPreview.shove, undefined);
          assert.equal(d.world.arrow.visible, false); assert.equal(d.world.outline.visible, false);
        } else {
          assert.equal(shove.event.hit, undefined); assert.deepEqual(shove.to, {x:5,y:4});
          assert.deepEqual(d.view.targetPreview.shove, {from:shove.from, to:shove.to}); assertArrow(d);
        }
      });
      await step("cancel clears frame and arrow without changing draft", async () => {
        const before = await readSynchronized(); await cancel(); const after = await readSynchronized();
        assert.equal(after.candidate, null); assert.deepEqual(after.draft, before.draft); assertClear(after);
      });
      await step("confirm commits selected draft and clears markers", async () => {
        await choose(); const before = await readSynchronized(); assertFrame(before);
        await confirm(); const after = await readSynchronized();
        assert.equal(after.candidate, null); assertClear(after);
        assert.deepEqual(after.draft.Assault.action, {kind:"melee", target:"boss"});
        assert.deepEqual(after.draft.Gunner, before.draft.Gunner); assert.deepEqual(after.draft.Support, before.draft.Support);
        assert.deepEqual(after.match, before.match, "confirm must not settle the turn");
      });
      if (scenario === "free-and-prior") {
        await step("prior real shove: current target framed but later-origin arrow withheld", async () => {
          await page.locator(".mecha-pack li > button").filter({hasText:"Support"}).click();
          await choose(); const d = await readSynchronized(); assertReadyCandidate(d, "Support"); assertFrame(d);
          const first = d.candidate.preview.log.filter((event) => event.type === "shove" && event.unit === "boss");
          assert.equal(first.length, 2, "whole-turn preview must contain both actual shoves");
          assert.ok(first.every((event) => !event.hit));
          assert.equal(d.result.shoves.length, 1);
          assert.deepEqual(d.result.shoves[0].from, {x:5,y:4}); assert.deepEqual(d.result.shoves[0].to, {x:6,y:4});
          assert.equal(d.view.targetPreview.shove, undefined, "do not imply that the later shove starts at the displayed boss");
          assert.equal(d.world.arrow.visible, false); assert.equal(d.world.outline.visible, false);
        });
        await step("prediction failure removes prior markers and does not create stale markers", async () => {
          // Reopen the actual first shove, ensuring a frame AND arrow are live.
          // Hold changes the committed draft and invalidates preview caches;
          // only display prediction fails, not independent action validation.
          await cancel();
          await page.locator(".mecha-pack li > button").filter({hasText:"Assault"}).click();
          await choose(); let d = await readSynchronized(); assertFrame(d); assertArrow(d);
          await page.evaluate(() => { globalThis.__targetMarkerFailure = true; });
          await actions.getByRole("button", {name:"Hold", exact:true}).click();
          d = await readSynchronized();
          assert.equal(d.preview.ok, false); assert.equal(d.preview.status, "unavailable"); assertClear(d);
          await page.locator(".mecha-pack li > button").filter({hasText:"Support"}).click();
          await choose(); d = await readSynchronized();
          assert.equal(d.candidate?.preview.ok, false); assert.equal(d.candidate.preview.status, "unavailable");
          assert.match(await candidate.innerText(), /Prediction is temporarily unavailable/i);
          assertClear(d); const draft = d.draft;
          await cancel(); d = await readSynchronized(); assert.equal(d.candidate, null); assert.deepEqual(d.draft, draft); assertClear(d);
        });
        await step("restore real prediction and marker after failure", async () => {
          await page.evaluate(() => { globalThis.__targetMarkerFailure = false; });
          await page.locator(".mecha-pack li > button").filter({hasText:"Assault"}).click();
          await choose(); const d = await readSynchronized(); assertReadyCandidate(d, "Assault"); assertFrame(d);
          assert.deepEqual(d.result.shoves[0]?.from, {x:4,y:4}); assert.deepEqual(d.result.shoves[0]?.to, {x:5,y:4});
          assertArrow(d); await cancel(); assertClear(await readSynchronized());
        });
      }
    } catch (error) {
      const message = `${scenario} / ${stage}: ${error.message}`;
      failures.push(message);
      if (instrumentationErrors.length || stage === "preflight") { harnessFailures++; console.error(`HARNESS/INCONCLUSIVE ${message}`); }
      else if (error.name === "AssertionError") { appFailures++; console.error(`FAIL APP ${message}`); }
      else { inconclusive++; console.error(`INCONCLUSIVE ${message}`); }
      console.error(`SKIP ${scenario}: remaining dependent stages`);
    } finally {
      if (errors.length) {
        if (instrumentationErrors.length) console.error(`HARNESS ${scenario}: page errors following interception failure: ${errors.join("; ")}`);
        else { appFailures++; console.error(`FAIL APP ${scenario}: uncaught page errors: ${errors.join("; ")}`); }
      }
      await context.close();
    }
  }
} finally { await browser.close(); }
console.log(`\nResults: ${appFailures} app failure(s), ${harnessFailures} harness/preflight failure(s), ${inconclusive} inconclusive stage(s).`);
console.log("Scope: synthetic match/site; real MechaBoard and CityMechaWorld marker objects, not pixels/occlusion or 3D picking. Vite instrumentation is test-only; no native/device/accessibility/performance acceptance.");
if (harnessFailures || inconclusive) process.exitCode = 2;
else if (appFailures) process.exitCode = 1;
