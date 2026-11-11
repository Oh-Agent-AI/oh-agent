#!/usr/bin/env node
// Synthetic city; real settings/controller/WebGL, with deployment disabled in the fixture.
// Start Vite at 127.0.0.1:5179 before running; external network is blocked.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5179";
const species = [
  ["spore_leaper", "spore_leap"], ["flux_lancer", "ring_pierce"], ["porous_shaper", "corrode_cell"],
  ["prism_warden", "prism_guard"], ["swarm_mantle", "split_swarm"],
  ["phase_stalker", "phase_swap"], ["gravity_core", "gravity_well"], ["neural_weaver", "neural_link"],
];
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.setDefaultTimeout(90000);
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!request.url().startsWith(base)) external.push(request.url()); });
  await page.route("**/*", route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.routeWebSocket("**/*", ws => ws.close());
  await page.addInitScript(() => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = "en"; });
  await page.route("**/src/game/MechaBoard.tsx*", async route => {
    const response = await route.fetch(); let body = await response.text();
    const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
    assert.equal(body.split(needle).length, 2, "fixture controller seam");
    body = body.replace(needle, needle.replace("animate: true, locale", "animate: true, deployment: false, locale") + '\nwindow.__practiceMatrixController = controllerRef.current;');
    await route.fulfill({ response, body });
  });
  await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator(".city-loading").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "City settings", exact: true }).click();
  await page.getByRole("button", { name: "Mecha tactics", exact: true }).click();
  await page.waitForFunction(() => window.__practiceMatrixController?.getState().match.phase === "player_plan");
  for (const [id, skill] of species) {
    await page.locator('[data-mecha-settings-trigger="battlefield"]').click();
    const settings = page.locator("#mecha-battlefield-settings");
    await settings.waitFor({ state: "visible" });
    const practice = settings.locator("[data-monster-practice]");
    if (await practice.getAttribute("open") === null) await practice.locator("summary").click();
    await settings.locator("[data-monster-practice-select]").selectOption(id);
    assert.equal(await settings.locator("[data-monster-practice-start]").isEnabled(), true, id);
    await settings.locator("[data-monster-practice-start]").click();
    await settings.locator("[data-monster-practice-confirm]").click();
    await page.waitForFunction(([id, skill]) => {
      const s = window.__practiceMatrixController.getState();
      return s.match.monsterContent?.speciesId === id && s.match.boss.intent?.skillId === skill;
    }, [id, skill]);
    await settings.getByRole("button", { name: "Close settings" }).click();
    const turn = await page.evaluate(() => {
      const c = window.__practiceMatrixController, before = c.getState().match;
      for (const mech of before.mechs.filter(m => m.hp > 0)) c.setAction(mech.id, { kind: "skip" });
      const preview = c.getState().preview;
      c.submit(); if (c.getState().holdConfirmation) c.confirmHold();
      return { ready: preview?.ok, expected: preview?.log, actual: c.getState().lastLog,
        prior: before.revision, revision: c.getState().match.revision,
        species: c.getState().match.monsterContent?.speciesId, performance: c.getState().performance?.events };
    });
    assert.equal(turn.ready, true, `${id}: preview`);
    assert.equal(turn.species, id);
    assert.ok(turn.revision > turn.prior, `${id}: turn advanced`);
    assert.deepEqual(turn.actual, turn.expected, `${id}: preview and actual logs`);
    assert.ok(turn.actual.length > 0 && turn.performance?.length > 0, `${id}: real events and performance`);
    // The matrix checks the actual queue, not playback timing on software WebGL.
    // Use the real UI control so the next case does not depend on GPU speed.
    await page.getByRole("button", { name: "Skip animation", exact: true }).click();
    await page.waitForFunction(() => !window.__practiceMatrixController.getState().performance);
    console.log(`${id}: practice selection, declaration, turn, preview parity and queued events passed`);
  }
  // Finish the final (L8) practice through the real controller and verify the
  // result dialog's automatic IndexedDB save and replay entry point.
  const completed = await page.evaluate(() => {
    const c = window.__practiceMatrixController;
    for (let turn = 0; turn < 30 && !c.getState().match.outcome; turn++) {
      const before = c.getState().match;
      for (const mech of before.mechs.filter(m => m.hp > 0)) c.setAction(mech.id, { kind: "skip" });
      c.submit(); if (c.getState().holdConfirmation) c.confirmHold();
      if (c.getState().performance) c.finishPerformance();
      if (c.getState().match === before) return { error: c.getState().notice ?? "turn did not advance" };
    }
    return { outcome: c.getState().match.outcome, species: c.getState().match.monsterContent?.speciesId };
  });
  assert.equal(completed.species, "neural_weaver");
  assert.ok(completed.outcome, JSON.stringify(completed));
  const result = page.locator("[data-mecha-result-dialog]");
  await result.waitFor({ state: "visible" });
  await result.getByText("This battle replay was saved locally automatically.").waitFor();
  const saved = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open("agent-city-mecha-replays", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise((resolve, reject) => { const r = db.transaction("replays").objectStore("replays").getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); } finally { db.close(); }
  });
  assert.ok(saved.length > 0, "L8 replay stored in IndexedDB");
  await result.locator("[data-result-replay]").click();
  await page.waitForFunction(() => window.__practiceMatrixController.getState().replay !== null);
  console.log("neural_weaver: completed practice, automatic save and replay entry passed");
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await page.close();
} finally { await browser.close(); }
