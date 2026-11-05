import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

const { chromium } = createRequire(new URL('../../../desktop/ui-dev/package.json', import.meta.url))('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MechaMatch } from '/src/game/MechaBoard.tsx';
const site = {originX:0, originZ:0, yaw:0, cellW:16, cellD:16,
  terrain:Array.from({length:10},()=>Array(10).fill('land')),
  heights:Array.from({length:10},()=>Array(10).fill(0)), buildings:[], blocked:[],
  mechs:[{id:'Assault',pos:{x:0,y:9}},{id:'Gunner',pos:{x:3,y:9}},{id:'Support',pos:{x:6,y:9}}],
  boss:{x:4,y:1}, raiders:[], spawnSpread:0};
createRoot(document.getElementById('root')).render(React.createElement(MechaMatch, {
  locale:'zh-Hans', onClose:()=>{}, requestCloseRef:{current:null}, engine:{currentLayout:null},
  catalog:{flat:site,shore:null,ridge:null,alley:null}, remoteStatus:'idle', remoteLocked:{current:false}, onRemoteStatusChange:()=>{}
}));
`;
// Only the 3D renderer is substituted. The production Match, controller and rules run unchanged.
const worldStub = `
import React from 'react';
export const CityMechaWorld = React.forwardRef(function World({view}, ref) {
  window.__boardWorldView = view;
  React.useImperativeHandle(ref, () => ({}));
  return React.createElement('div', {'data-world-test-stub':''});
});
`;
let server, browser, base, cache;
before(async () => {
  cache = await mkdtemp(path.join(os.tmpdir(), 'mecha-world-wiring-'));
  server = await createServer({ root, configFile:false, cacheDir:cache, logLevel:'error', server:{host:'127.0.0.1',port:0}, plugins:[{
    name:'world-wiring-fixture', enforce:'pre',
    resolveId(id) { if (id === 'virtual:world-wiring-fixture' || id === 'virtual:world-stub') return '\0' + id; },
    load(id) { if (id === '\0virtual:world-wiring-fixture') return fixture; if (id === '\0virtual:world-stub') return worldStub; },
    transform(code,id) {
      if (!id.endsWith('/src/game/MechaBoard.tsx')) return;
      const entry = 'function MechaMatch({ locale, onClose, requestCloseRef, engine, catalog, initialShape, remoteStatus, remoteLocked, onRemoteStatusChange }:';
      const imported = 'import { CityMechaWorld, type CityMechaView, type CityMechaWorldHandle } from "./CityMechaWorld";';
      const controller = '  const controller = controllerRef.current;';
      for (const s of [entry, imported, controller]) assert.equal(code.split(s).length, 2, `fixture hook changed: ${s}`);
      return code.replace(entry,'export '+entry).replace(imported, 'import { CityMechaWorld } from "virtual:world-stub";').replace(controller, controller+'\n  window.__boardController = controller;');
    },
    configureServer(vite) { vite.middlewares.use((req,res,next) => { if(!req.url.startsWith('/__world-wiring__')) return next(); res.setHeader('Content-Type','text/html'); res.end('<!doctype html><div id="root"></div><script type="module" src="/@id/virtual:world-wiring-fixture"></script>'); }); }
  }] });
  await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({headless:true});
});
after(async () => { await browser?.close(); await server?.close(); if(cache) await rm(cache,{recursive:true,force:true}); });

test('real board passes the displayed live and replay species into its world view', async () => {
  const page = await browser.newPage();
  const errors = [], requests = [];
  page.on('request', req => requests.push(req.url()));
  page.on('pageerror', error => errors.push(error.stack));
  page.on('console', msg => { if (msg.type() === 'error' && !msg.text().startsWith('[vite] failed to connect to websocket')) errors.push(msg.text()); });
  page.on('requestfailed', req => errors.push(`${req.url()}: ${req.failure()?.errorText}`));
  await page.routeWebSocket('**/*', ws => ws.close());
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  try {
    await page.goto(`${base}/__world-wiring__?assaultTrial=1`);
    await page.waitForFunction(() => window.__boardWorldView && window.__boardController, null, {timeout:15000}).catch(async error => { throw new Error(`${error.message}; errors: ${errors.join('; ')}; state: ${JSON.stringify(await page.evaluate(() => ({html:document.body.innerHTML.slice(0,500), controller:!!window.__boardController, view:!!window.__boardWorldView})))}; requests: ${requests.slice(-12).join(' ')}`); });
    assert.equal(await page.evaluate(() => window.__boardWorldView.bossSpeciesId), undefined, 'legacy boss has no species visual');
    await page.evaluate(() => window.__boardController.restart({monsterContent:{speciesId:'spore_leaper',contentVersion:1}}));
    await page.waitForFunction(() => window.__boardWorldView?.bossSpeciesId === 'spore_leaper');
    // Build an actual spore round through deployment and the authoritative controller.
    await page.evaluate(() => {
      const c = window.__boardController;
      for (const id of ['Assault','Gunner','Support']) {
        c.selectMech(id);
        const cells = c.getState().deployment.cells;
        const target = cells.find(cell => !c.getState().deployment.placements.some(p => p.pos.x === cell.x && p.pos.y === cell.y));
        c.placeMech(id, target);
      }
      c.confirmDeployment();
      const state = c.getState();
      const mover = state.match.mechs.find(m => m.hp > 0);
      c.selectMech(mover.id);
      const reach = c.getState().reach.find(p => p.x !== mover.pos.x || p.y !== mover.pos.y);
      if (!reach) throw new Error('no legal move');
      c.setMove(mover.id, reach);
      for (const mech of c.getState().match.mechs.filter(m => m.hp > 0)) c.setAction(mech.id, {kind:'skip'});
      const before = structuredClone(c.getState().match);
      c.submit(); if(c.getState().holdConfirmation) c.confirmHold();
      const stateAfter = c.getState();
      if (!stateAfter.performance) throw new Error('real turn produced no performance');
      window.__round = structuredClone({before, after:stateAfter.match, log:stateAfter.lastLog, presentationStages:stateAfter.combat.presentationStages});
    });
    await page.waitForFunction(() => window.__boardWorldView?.bossSpeciesId === 'spore_leaper');
    await page.evaluate(() => window.__boardController.finishPerformance());
    await page.evaluate(() => window.__boardController.restart({monsterContent:{speciesId:'prism_warden',contentVersion:1}}));
    await page.waitForFunction(() => window.__boardWorldView?.bossSpeciesId === 'prism_warden');
    const shield = page.locator('[data-prism-shield-status="absent"][data-prism-shield-hits="0"]');
    assert.equal(await shield.isVisible(), true, 'shield status is visible in the real battle panel');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await shield.isVisible(), true, 'shield status remains visible on narrow screens');
    assert.equal(await page.evaluate(() => window.__boardController.startSavedReplay([window.__round])), true);
    await page.waitForFunction(() => window.__boardWorldView?.bossSpeciesId === 'spore_leaper');
    assert.equal(await page.evaluate(() => window.__boardController.getState().match.monsterContent.speciesId), 'prism_warden', 'replay must not use unrelated live match');
    assert.equal(await page.locator('[data-prism-shield-status]').count(), 0, 'replay must not expose the live shield');
    await page.evaluate(() => window.__boardController.stopReplay());
    await page.waitForFunction(() => window.__boardWorldView?.bossSpeciesId === 'prism_warden');
    // Synthetic unsupported future-version snapshot: it must not select a known visual.
    assert.equal(await page.evaluate(() => {
      const round = structuredClone(window.__round);
      round.before.monsterContent.contentVersion = 2;
      return window.__boardController.startSavedReplay([round]);
    }), true);
    await page.waitForFunction(() => window.__boardController.getState().replay && window.__boardWorldView?.bossSpeciesId === undefined);
    await page.evaluate(() => window.__boardController.stopReplay());
    await page.waitForFunction(() => window.__boardWorldView?.bossSpeciesId === 'prism_warden');
    await page.evaluate(() => window.__boardController.restart({monsterContent:null}));
    await page.waitForFunction(() => window.__boardWorldView && window.__boardWorldView.bossSpeciesId === undefined);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
