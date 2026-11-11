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
import React, { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { MechaPrismShieldStatus } from '/src/game/MechaPrismShield.tsx';
import { createMechaController } from '/src/game/mecha/controller.ts';
import { bossPrepare, createMatch, previewPlan } from '/src/game/mecha/rules.ts';
import { MAX_TURNS } from '/src/game/mecha/board.ts';
function initial() {
  const match = createMatch({preset:'covers_sparse_mid', script:'stationary_smash', boss:{x:4,y:4}, covers:[],
    mechs:[{id:'Assault',pos:{x:4,y:7}},{id:'Gunner',pos:{x:4,y:8}},{id:'Support',pos:{x:0,y:9}}],
    monsterContent:{speciesId:'prism_warden',contentVersion:1}});
  bossPrepare(match);
  return match;
}
function Fixture() {
  const [controller, setController] = useState(() => createMechaController({match:initial(), animate:true}));
  const [sequenceWaiting, setWaiting] = useState(false);
  const [locale, setLocale] = useState('zh-Hans');
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  window.controller = controller;
  window.setWaiting = setWaiting;
  window.setLocale = setLocale;
  window.setupTerminal = (shoot = false) => {
    if (!window.activeMatch) window.activeMatch = structuredClone(controller.getState().match);
    const match = structuredClone(window.activeMatch);
    match.turn = MAX_TURNS;
    if (shoot) {
      match.mechs.find(m => m.id === 'Assault').pos = {x:3,y:4};
      match.mechs.find(m => m.id === 'Gunner').pos = {x:5,y:8};
      match.mechs.find(m => m.id === 'Support').pos = {x:0,y:9};
    }
    window.terminalTurn = MAX_TURNS;
    window.terminalShoot = shoot;
    setController(createMechaController({match, animate:true}));
  };
  window.previewAddsShield = () => {
    const match = controller.getState().match;
    const plan = { revision:match.revision, items:match.mechs.filter(m => m.hp > 0).map(m => ({mechId:m.id, moveTo:null, action:{kind:'skip'}})) };
    const preview = previewPlan(match, plan);
    return preview.ok && preview.stages.afterEnemy.boss.shield?.hits === 1;
  };
  window.submitTurn = () => {
    const moving = window.terminalShoot ? 'Support' : 'Assault';
    controller.selectMech(moving);
    const snapshot = controller.getState();
    const pos = snapshot.match.mechs.find(m => m.id === moving).pos;
    const cell = snapshot.reach.find(c => c.x !== pos.x || c.y !== pos.y);
    if (!cell) throw new Error('fixture has no legal movement for performance');
    controller.setMove(moving, cell);
    for (const mech of controller.getState().match.mechs.filter(m => m.hp > 0)) controller.setAction(mech.id, window.terminalShoot && mech.id === 'Assault' ? {kind:'shoot', target:'boss'} : {kind:'skip'});
    const before = structuredClone(controller.getState().match);
    controller.submit();
    if (controller.getState().holdConfirmation) controller.confirmHold();
    const after = controller.getState();
    window.round = structuredClone({before, after:after.match, log:after.lastLog, presentationStages:after.combat.presentationStages});
  };
  return React.createElement(MechaPrismShieldStatus, { locale, controllerState:state, sequenceWaiting });
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`;
let server, browser, base, cache;
before(async () => {
  cache = await mkdtemp(path.join(os.tmpdir(), "mecha-ui-test-"));
  server = await createServer({ root, configFile: false, cacheDir: cache, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "prism-shield-fixture",
    resolveId(id) { if (id === "virtual:prism-shield-fixture") return "\0virtual:prism-shield-fixture"; },
    load(id) { if (id === "\0virtual:prism-shield-fixture") return fixture; },
    configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== "/__prism-shield__") return next(); res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><div id="root"></div><script type="module" src="/@id/virtual:prism-shield-fixture"></script>'); }); },
  }] });
  await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); if (cache) await rm(cache, { recursive: true, force: true }); });

test("prism shield uses committed live state and hides unrevealed and replay states", async () => {
  const page = await browser.newPage();
  await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.routeWebSocket("**/*", ws => ws.close());
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const status = page.locator("[data-prism-shield-status]");
  const expectStatus = async (kind, hits) => {
    await page.waitForFunction(expected => document.querySelector('[data-prism-shield-status]')?.getAttribute('data-prism-shield-status') === expected, kind, { timeout: 5000 }).catch(error => { throw new Error(`${error.message}; browser errors: ${errors.join('; ')}`); });
    assert.equal(await status.getAttribute("data-prism-shield-hits"), hits);
  };
  try {
    await page.goto(`${base}/__prism-shield__`);
    await expectStatus("absent", "0");
    assert.match(await status.innerText(), /无.*0/);
    assert.equal(await page.evaluate(() => window.previewAddsShield()), true, "predicted shield is not the current shield");
    await expectStatus("absent", "0");
    await page.evaluate(() => window.submitTurn());
    assert.equal(await page.evaluate(() => window.controller.getState().match.boss.shield?.hits), 1, "real turn committed shield");
    assert.equal(await page.evaluate(() => Boolean(window.controller.getState().performance)), true);
    await expectStatus("pending", null);
    assert.doesNotMatch(await status.innerText(), /剩余|\b1\b/);
    await page.evaluate(() => { window.setWaiting(true); window.controller.finishPerformance(); });
    await expectStatus("pending", null);
    await page.evaluate(() => window.setWaiting(false));
    await expectStatus("active", "1");
    assert.match(await status.innerText(), /存在.*1/);
    await page.evaluate(() => window.setLocale('en'));
    assert.match(await status.innerText(), /active.*1 hit remaining/i);

    // Even if the live match is shielded, playback must not display its unrelated status.
    assert.equal(await page.evaluate(() => window.controller.startSavedReplay([window.round])), true);
    await page.waitForFunction(() => !document.querySelector('[data-prism-shield-status]'));
    await page.evaluate(() => window.controller.stopReplay());
    await expectStatus("active", "1");

    // A real terminal turn expires the shield; don't reveal the committed 0 during its animation.
    await page.evaluate(() => window.setupTerminal());
    await page.waitForFunction(() => window.controller.getState().match.turn === window.terminalTurn);
    await page.evaluate(() => window.submitTurn());
    assert.equal(await page.evaluate(() => window.controller.getState().match.boss.shield), undefined);
    assert.ok(await page.evaluate(() => window.controller.getState().lastLog.some(e => e.type === 'monster_status' && e.change === 'expired')));
    assert.equal(await page.evaluate(() => Boolean(window.controller.getState().performance)), true);
    await expectStatus("pending", null);
    assert.doesNotMatch(await status.innerText(), /\b0\b|absent/i);
    await page.evaluate(() => window.controller.finishPerformance());
    await expectStatus("absent", "0");
    assert.match(await status.innerText(), /absent.*0 hits remaining/i);

    // Absorption is also a committed transition, not a visual or preview estimate.
    await page.evaluate(() => window.setupTerminal(true));
    await page.waitForFunction(() => window.controller.getState().match.turn === window.terminalTurn && window.controller.getState().match.boss.shield?.hits === 1);
    await expectStatus("active", "1");
    await page.evaluate(() => window.submitTurn());
    assert.ok(await page.evaluate(() => window.controller.getState().lastLog.some(e => e.type === 'monster_status' && e.change === 'absorbed')));
    assert.equal(await page.evaluate(() => window.controller.getState().match.boss.shield), undefined);
    await expectStatus("pending", null);
    await page.evaluate(() => window.controller.finishPerformance());
    await expectStatus("absent", "0");

    await page.evaluate(() => window.controller.restart({ monsterContent: null }));
    await page.waitForFunction(() => !document.querySelector('[data-prism-shield-status]'));
    await page.evaluate(() => window.controller.restart({ monsterContent: { speciesId:'flux_lancer', contentVersion:1 } }));
    assert.equal(await status.count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
