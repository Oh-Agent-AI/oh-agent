import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const { chromium } = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url))("playwright");
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MechaMonsterPractice } from '/src/game/MechaMonsterPractice.tsx';
import { MechaCorrodeSummary, MechaMonsterIntent } from '/src/game/MechaMonsterIntent.tsx';
window.calls = []; window.sideEffects = [];
for (const method of ['setItem', 'removeItem', 'clear']) {
  const original = Storage.prototype[method];
  Storage.prototype[method] = function (...args) { window.sideEffects.push('storage:' + method); return original.apply(this, args); };
}
window.fetch = () => { window.sideEffects.push('fetch'); throw new Error('unexpected fetch'); };
navigator.sendBeacon = () => { window.sideEffects.push('beacon'); return false; };
function Fixture() {
  const [active, setActive] = useState(undefined);
  const [locale, setLocale] = useState('zh-Hans');
  window.setLocale = setLocale;
  return React.createElement(MechaMonsterPractice, { locale, activeSpecies: active, disabled: false, notice: null,
    onStart: id => { window.calls.push(['start', id]); setActive(id); },
    onReset: () => window.calls.push(['reset', active]),
    onExit: () => { window.calls.push(['exit', active]); setActive(undefined); }
  });
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
const intentRoot = createRoot(document.getElementById('intent-root'));
window.showIntent = props => intentRoot.render(React.createElement(React.Fragment, null, React.createElement(MechaCorrodeSummary, props), React.createElement(MechaMonsterIntent, props)));
`;
let server, browser, base, cache;
before(async () => {
  cache = await mkdtemp(path.join(os.tmpdir(), "mecha-ui-test-"));
  server = await createServer({ root, configFile: false, cacheDir: cache, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "monster-practice-fixture",
    resolveId(id) { if (id === "virtual:monster-practice-fixture") return "\0virtual:monster-practice-fixture"; },
    load(id) { if (id === "\0virtual:monster-practice-fixture") return fixture; },
    configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== "/__monster-practice__") return next(); res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><div id="root"></div><div id="intent-root"></div><script type="module" src="/@id/virtual:monster-practice-fixture"></script>'); }); },
  }] });
  await server.listen();
  const address = server.httpServer.address();
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); if (cache) await rm(cache, { recursive: true, force: true }); });

test("catalog, explicit confirmation, unavailable species and controls are local-only", async () => {
  const page = await browser.newPage();
  await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.routeWebSocket("**/*", ws => ws.close());
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!request.url().startsWith(base)) external.push(request.url()); });
  try {
    await page.goto(`${base}/__monster-practice__`);
    await page.locator("[data-monster-practice] summary").click();
    const select = page.locator("[data-monster-practice-select]");
    assert.equal(await select.locator("option").count(), 10);
    for (const id of ["spore_leaper", "flux_lancer", "porous_shaper", "prism_warden", "swarm_mantle", "phase_stalker", "gravity_core", "neural_weaver"]) {
      await select.selectOption(id);
      assert.equal(await page.locator("[data-monster-practice-info]").getAttribute("data-species-id"), id);
      assert.ok(await page.locator("[data-monster-practice-level]").innerText());
      assert.ok(await page.locator("[data-monster-practice-skill]").innerText());
      assert.ok(await page.locator("[data-monster-practice-counter]").innerText());
      assert.equal(await page.locator("[data-monster-practice-start]").isEnabled(), true);
    }
    for (const id of ["many_core", "field_sovereign"]) {
      await select.selectOption(id);
      assert.equal(await page.locator("[data-monster-practice-start]").isDisabled(), true);
      assert.match(await page.locator("[data-monster-practice-unavailable]").innerText(), /未实现/);
    }
    await select.selectOption("spore_leaper");
    await page.locator("[data-monster-practice-start]").click();
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    await page.locator("[data-monster-practice-cancel]").click();
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    await page.locator("[data-monster-practice-start]").click();
    await page.locator("[data-monster-practice-confirm]").click();
    await page.locator("[data-monster-practice-reset]").click();
    await page.locator("[data-monster-practice-confirm]").click();
    await select.selectOption("flux_lancer");
    await page.locator("[data-monster-practice-start]").click();
    await page.locator("[data-monster-practice-confirm]").click();
    await page.locator("[data-monster-practice-exit]").click();
    await page.locator("[data-monster-practice-confirm]").click();
    assert.deepEqual(await page.evaluate(() => window.calls), [["start", "spore_leaper"], ["reset", "spore_leaper"], ["start", "flux_lancer"], ["exit", "flux_lancer"]]);
    await page.evaluate(() => window.setLocale("en"));
    await select.selectOption("neural_weaver");
    assert.equal(await page.locator("[data-monster-practice-start]").isEnabled(), true);
    await select.selectOption("many_core");
    assert.match(await page.locator("[data-monster-practice-unavailable]").innerText(), /not yet implemented/i);
    assert.deepEqual(await page.evaluate(() => window.sideEffects), []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});


test("M3 details distinguish bound declarations, reprojection, attempted landings and unavailable evidence in both locales", async () => {
  const page = await browser.newPage();
  await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.routeWebSocket("**/*", ws => ws.close());
  try {
    await page.goto(`${base}/__monster-practice__`);
    await page.waitForFunction(() => typeof window.showIntent === "function");
    const request = { targetIds: ["mech:Assault", "mech:Gunner"], radius: 5 };
    const original = { skillId: "gravity_well", displacement: { request }, displacementProjection: {
      status: "reprojected", reason: null, attackCells: [{ x: 4, y: 5 }], effects: [
        { entityId: "mech:Assault", status: "move", from: { x: 4, y: 7 }, to: { x: 4, y: 6 }, reason: null },
        { entityId: "mech:Gunner", status: "void", from: { x: 2, y: 7 }, to: { x: 3, y: 7 }, reason: "obstacle" },
      ],
    } };
    const projection = structuredClone(original);
    projection.displacementProjection.effects[0].to = { x: 3, y: 6 };
    const state = { turn: 4, boss: { intent: original }, corrode: { fields: [{ id: "field", cell: { x: 1, y: 2 }, expiresAfterRound: 5 }] } };
    const show = (locale, preview) => page.evaluate(props => window.showIntent(props), { locale, state, preview });
    const details = page.locator("[data-monster-intent]");
    await show("zh-Hans", { monsterProjection: projection });
    await details.waitFor();
    assert.match(await page.locator("[data-monster-hazards]").innerText(), /1,2 \(2 回合\)/);
    let text = await details.innerText();
    assert.match(text, /Assault → Gunner/);
    assert.match(text, /4,7 → 4,6 · 落点/);
    assert.match(text, /4,7 → 3,6 · 落点/);
    assert.match(text, /2,7 → 3,7 · 落空（箭头为尝试位置）: 障碍阻挡/);
    assert.match(text, /剩余: 2 回合/);
    assert.match(text, /不计入攻击威胁格列表/);
    await show("en", null);
    await page.getByText("Preview unavailable; do not assume safety.").waitFor();
    text = await details.innerText();
    assert.match(text, /void \(arrow is attempted destination\): obstacle blocks landing/);
    assert.match(text, /Remaining: 2 turns/);
    assert.match(await page.locator("[data-monster-hazards]").innerText(), /1,2 \(2 turns\)/);
    await show("en", { monsterProjection: null });
    await page.getByText(/Enemy phase not reached/).waitFor();
    assert.doesNotMatch(await details.innerText(), /Preview unavailable/);
    const corrode = { ...state, boss: { intent: { skillId: "corrode_cell", status: "planned", corrode: { target: { x: 4, y: 7 }, durationTurns: 2 } } } };
    const voided = { ...corrode.boss.intent, status: "void", corrode: { ...corrode.boss.intent.corrode, reason: "blocked" } };
    await page.evaluate(props => window.showIntent(props), { locale: "en", state: corrode, preview: { monsterProjection: voided } });
    await page.getByText(/Void: terrain blocked/).waitFor();
    assert.match(await details.innerText(), /Bound cell: 4,7/);
  } finally { await page.close(); }
});
