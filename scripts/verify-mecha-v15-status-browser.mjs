#!/usr/bin/env node
// Synthetic, local-only status encounter. Interception does not modify app sources.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5187";
const species = process.argv[3] ?? "prism_warden";
const screenshotPath = process.argv[4];
const scenario = {
  spore_leaper: { kind: "poison", badge: "☠️2", blocked: false, cells: ["3,5", "0,9", "9,9"] },
  flux_lancer: { kind: "burn", badge: "🔥2", blocked: false, cells: ["3,5", "0,9", "9,9"] },
  prism_warden: { kind: "freeze", badge: "🧊1", blocked: true, cells: ["4,7", "0,9", "9,9"] },
  gravity_core: { kind: "stun", badge: "💫1", blocked: true, cells: ["4,7", "0,9", "9,9"] },
}[species];
assert.ok(scenario, `Unknown species ${species}`);
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage(); page.setDefaultTimeout(60000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = "zh-Hans"; });
  await page.route("**/src/game/SequentialMechaMatch.tsx*", async route => {
    const response = await route.fetch(), source = await response.text();
    const opening = "const [controller] = useState(";
    const seam = "const state = useSyncExternalStore(controller.subscribe, controller.getState);";
    assert.equal(source.split(opening).length, 2); assert.equal(source.split(seam).length, 2);
    const fixture = `site = {...site, terrain: Array.from({length:10},()=>Array(10).fill('land')), heights: Array.from({length:10},()=>Array(10).fill(0)), buildings:[], blocked:${species === "gravity_core" ? "[{x:4,y:6}]" : "[]"}, raiders:[], boss:{x:4,y:4}, mechs:[{id:'Assault',pos:{x:${species === "spore_leaper" || species === "flux_lancer" ? 3 : 4},y:${species === "spore_leaper" || species === "flux_lancer" ? 5 : 7}}},{id:'Gunner',pos:{x:0,y:9}},{id:'Support',pos:{x:9,y:9}}]}; delete site.assaultTerrainSafety; `;
    await route.fulfill({ response, body: source.replace(opening, fixture + opening).replace(seam, `${seam} globalThis.__v15Controller = controller;`) });
  });
  await page.route("**/src/game/CityMechaWorld.tsx*", async route => {
    const response = await route.fetch(), source = await response.text(), seam = "if (player) {";
    assert.equal(source.split(seam).length, 2);
    await route.fulfill({ response, body: source.replace(seam, `globalThis.__v15Player = player; ${seam}`) });
  });
  const button = name => page.getByRole("button", { name, exact: true });
  async function enter() {
    await page.goto(`${base}/?fixtureSessions=30&mechaV15=1&mechaStatus=${species}`, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 180000 });
    console.log("Synthetic city loaded");
    await button("城市设置").click(); await button("机甲战棋").click();
    await page.locator("[data-mecha-v15]").waitFor();
  }
  await enter();
  const root = page.locator("[data-mecha-v15]"), select = page.locator("#v15-cell");
  for (const [index, cell] of scenario.cells.entries()) {
    await root.locator(".mecha-v15-roster button").nth(index).click();
    await select.selectOption(cell); await button("放置").click();
  }
  await button("确认部署").click();
  console.log("Deployment confirmed");
  try { await page.waitForFunction(() => globalThis.__v15Controller.getState().persistence === "ready", null, { timeout: 20000 }); }
  catch (error) {
    console.error("deployment diagnostics", await page.evaluate(() => { const s = globalThis.__v15Controller.getState(); return { phase: s.match.phase, persistence: s.persistence, error: s.error, panel: document.querySelector('.mecha-v15-panel')?.innerText }; }));
    throw error;
  }
  const expectedSkill = { spore_leaper: "spore_leap", flux_lancer: "ring_pierce", prism_warden: "prism_frost", gravity_core: "gravity_well" }[species];
  assert.equal(await page.evaluate(() => globalThis.__v15Controller.getState().match.boss.intent.skillId), expectedSkill);
  await page.getByRole("region", { name: "敌方状态预告" }).waitFor();
  await button("结束回合").click(); await button("确认结束").click();
  console.log("Enemy turn submitted");
  await page.waitForFunction(kind => globalThis.__v15Player?.elapsed > 0 && globalThis.__v15Player.events.some(event => event.kind === "status_cue" && event.status === kind), scenario.kind);
  await button("跳过演出").click();
  console.log("Verified status animation started and skipped");
  try { await page.waitForFunction(() => { const s = globalThis.__v15Controller.getState(); return s.match.turn === 2 && !s.presentation && s.persistence === "ready"; }, null, { timeout: 20000 }); }
  catch (error) {
    console.error("turn diagnostics", await page.evaluate(() => { const s = globalThis.__v15Controller.getState(), p = globalThis.__v15Player; return { phase: s.match.phase, turn: s.match.turn, persistence: s.persistence, error: s.error, presentation: Boolean(s.presentation), player: p && { elapsed: p.elapsed, completed: p.completed, events: p.events }, events: s.presentation?.events, panel: document.querySelector('.mecha-v15-panel')?.innerText }; }), "page errors", errors);
    throw error;
  }
  const frozen = await page.evaluate(() => globalThis.__v15Controller.getState().match.statusEncounter.statuses);
  assert.ok(frozen.some(s => s.kind === scenario.kind && s.target === "Assault" && s.remainingTurns === 2 - Number(scenario.kind === "freeze" || scenario.kind === "stun")));
  await page.waitForFunction(badge => document.querySelector('.mecha-world-healthbar[data-unit-id="Assault"] .mecha-world-healthbar__status')?.textContent === badge, scenario.badge);
  await page.waitForFunction(() => Number(document.querySelector('.mecha-world-unit-labels')?.dataset.statusAuraCount) > 0);
  if (screenshotPath) await page.screenshot({ path: screenshotPath });
  await root.locator(".mecha-v15-roster button").first().click();
  assert.equal(await select.isDisabled(), scenario.blocked);
  if (scenario.kind === "freeze") assert.ok(await page.getByText("冻结：不能主动移动，仍可行动。", { exact: true }).isVisible());
  if (scenario.kind === "stun") assert.ok(await page.getByText("眩晕：不能主动移动或行动。", { exact: true }).isVisible());
  await page.reload({ waitUntil: "domcontentloaded" });
  console.log("Reloading checkpoint");
  await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 180000 });
  await button("城市设置").click(); await button("机甲战棋").click();
  await button("恢复对局").click();
  await page.waitForFunction(() => globalThis.__v15Controller.getState().persistence === "ready");
  assert.deepEqual(await page.evaluate(() => globalThis.__v15Controller.getState().match.statusEncounter.statuses), frozen);
  await page.waitForFunction(badge => document.querySelector('.mecha-world-healthbar[data-unit-id="Assault"] .mecha-world-healthbar__status')?.textContent === badge, scenario.badge);
  await page.waitForFunction(() => Number(document.querySelector('.mecha-world-unit-labels')?.dataset.statusAuraCount) > 0);
  assert.equal(await select.isDisabled(), scenario.blocked);
  const checkpoint = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("agent-city-mecha-sequential-checkpoint", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction("checkpoint", "readonly"), get = tx.objectStore("checkpoint").get("current");
      get.onsuccess = () => { db.close(); resolve(get.result); }; get.onerror = () => reject(get.error); };
  }));
  const bundle = JSON.parse(JSON.parse(checkpoint.raw).archive);
  assert.equal(bundle.schema, "mecha-sequential-bundle:v2");
  assert.deepEqual(bundle.replay.entries.map(entry => entry.command.id), ["c0"]);
  assert.deepEqual(errors, []);
  console.log(`PASS v1.5 status ${species}: deploy, ${scenario.kind} cue and skip, restriction, checkpoint and reload recovery`);
  await context.close();
} finally { await browser.close(); }
