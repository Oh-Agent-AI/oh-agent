#!/usr/bin/env node
// Real City UI/controller/rules acceptance, using synthetic data only.
// Run: node tests/mecha-monster-practice.browser.mjs [http://127.0.0.1:PORT]
// With no URL, starts an isolated local Vite server and removes its temporary cache.
// Optional: MECHA_CHROME=/absolute/path/to/chrome, MECHA_BROWSER_ANGLE=metal, MECHA_LANG=zh|en.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const ui = path.join(repo, "apps/agent-city/ui");
const uiRequire = createRequire(path.join(ui, "package.json"));
const desktopRequire = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"));
const { chromium } = desktopRequire("playwright");
const species = [
  { id: "spore_leaper", skill: "spore_leap", label: "L1", zh: "孢子弹跳", en: "Spore leap" },
  { id: "flux_lancer", skill: "ring_pierce", label: "L2", zh: "环轨穿刺", en: "Ring pierce" },
  { id: "prism_warden", skill: "prism_guard", label: "L4", zh: "棱镜护盾", en: "Prism guard" },
  { id: "porous_shaper", skill: "corrode_cell", label: "L3", zh: "蚀格", en: "Corrode cell" },
  { id: "phase_stalker", skill: "phase_swap", label: "L6", zh: "相位交换", en: "Phase swap" },
  { id: "gravity_core", skill: "gravity_well", label: "L7", zh: "引力井", en: "Gravity well" },
];
const unavailable = ["swarm_mantle", "neural_weaver", "many_core", "field_sovereign"];
const seed = "4196523069";
const langs = process.env.MECHA_LANG ? [process.env.MECHA_LANG] : ["zh", "en"];
assert.ok(langs.every(lang => lang === "zh" || lang === "en"), "MECHA_LANG must be zh or en");
let server, browser, cacheDir;
let failures = 0;

async function deploy(page) {
  const confirm = page.getByRole("button", { name: /^(确认部署|Confirm deployment)$/ });
  await confirm.waitFor({ state: "visible" });
  const list = page.locator(".mecha-deploy-list");
  if (await list.getAttribute("open") === null) await list.locator("summary").click();
  const used = new Set();
  for (let i = 0; i < 3; i++) {
    await page.locator(".mecha-deploy-roster .mecha-plan-card__select").nth(i).click();
    const options = await page.locator("#mecha-deploy-choice option").evaluateAll(rows => rows.map(r => r.value).filter(Boolean));
    const cell = options.find(value => !used.has(value));
    assert.ok(cell, "three distinct deployable cells required");
    used.add(cell);
    await page.locator("#mecha-deploy-choice").selectOption(cell);
    await page.getByRole("button", { name: /^(放置机甲|Place mech)$/ }).click();
  }
  await confirm.click();
  await page.locator('.mecha-overlay[data-phase="player_plan"]').waitFor();
  return [...used];
}

async function checkCase(origin, lang, spec) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: lang === "zh" ? "zh-CN" : "en-US", serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [], blocked = [], sockets = [];
  let hooks = 0;
  page.on("pageerror", error => errors.push(error.message));
  await context.routeWebSocket("**/*", ws => { sockets.push(ws.url()); ws.close(); });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { blocked.push(url.origin); return route.abort(); }
    if (url.pathname !== "/src/game/MechaBoard.tsx") return route.continue();
    const response = await route.fetch();
    const body = await response.text();
    const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
    assert.equal(body.split(needle).length, 2, "real controller hook changed; refusing to patch rules or guess");
    hooks++;
    return route.fulfill({ response, body: body.replace(needle, needle + "\nwindow.__practiceController = controllerRef.current;") });
  });
  await page.addInitScript(({ seed, lang }) => {
    localStorage.setItem("city.seed", seed);
    window.__AV_PLUGIN_LOCALE__ = lang === "zh" ? "zh-Hans" : "en";
  }, { seed, lang });
  try {
    console.log(`START ${lang} ${spec.label}: loading synthetic city`);
    await page.goto(`${origin}/?fixtureSessions=30`, { waitUntil: "domcontentloaded", timeout: 240000 });
    console.log(`START ${lang} ${spec.label}: document loaded`);
    await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 240000 });
    await page.waitForFunction(() => window.__AV_CITY_PROBE__?.().source === "fixture", null, { timeout: 240000 });
    console.log(`START ${lang} ${spec.label}: fixture ready`);
    await page.getByRole("button", { name: lang === "zh" ? "城市设置" : "City settings" }).click();
    await page.getByRole("button", { name: lang === "zh" ? "机甲战棋" : "Mecha tactics", exact: true }).click();
    await page.waitForFunction(() => window.__practiceController?.getState().match.phase === "deployment");
    console.log(`START ${lang} ${spec.label}: opened mecha`);
    assert.equal(hooks, 1, "the actual board controller must be exposed exactly once");
    await page.locator('[data-mecha-settings-trigger="battlefield"]').click();
    const panel = page.locator("#mecha-battlefield-settings");
    await panel.waitFor({ state: "visible" });
    const practice = panel.locator("[data-monster-practice]");
    await practice.locator("summary").click();
    const select = practice.locator("[data-monster-practice-select]");
    assert.equal(await select.locator("option").count(), 10, "all ten planned species are listed");
    for (const id of unavailable) {
      await select.selectOption(id);
      assert.equal(await practice.locator("[data-monster-practice-start]").isDisabled(), true, `${id} must not be startable`);
      assert.ok(await practice.locator("[data-monster-practice-unavailable]").isVisible(), `${id} must explain unavailability`);
    }
    await select.selectOption(spec.id);
    assert.equal(await practice.locator("[data-monster-practice-start]").isEnabled(), true);
    assert.equal(await practice.locator("[data-monster-practice-info]").getAttribute("data-species-id"), spec.id);
    assert.equal((await practice.locator("[data-monster-practice-level]").innerText()).trim(), spec.label.slice(1));
    assert.equal((await practice.locator("[data-monster-practice-skill]").innerText()).trim().toLowerCase(), spec[lang].toLowerCase());
    assert.ok((await practice.locator("[data-monster-practice-counter]").innerText()).trim(), "counterplay must be displayed");
    const beforeCancel = await page.evaluate(() => JSON.stringify(window.__practiceController.getState().match));
    await practice.locator("[data-monster-practice-start]").click();
    await practice.locator("[data-monster-practice-cancel]").click();
    assert.equal(await page.evaluate(() => JSON.stringify(window.__practiceController.getState().match)), beforeCancel, "cancel must preserve match");
    await practice.locator("[data-monster-practice-start]").click();
    await practice.locator("[data-monster-practice-confirm]").click();
    await page.waitForFunction(id => window.__practiceController.getState().match.monsterContent?.speciesId === id, spec.id);
    assert.equal(await page.locator("[data-monster-practice-active]").getAttribute("data-species-id"), spec.id);
    await panel.locator(".mecha-settings-close").click();
    await page.locator('[data-mecha-settings-trigger="remote"]').click();
    const remote = page.locator("#mecha-remote-settings");
    await remote.locator("[data-monster-practice-remote-disabled]").waitFor({ state: "visible" });
    assert.equal(await remote.locator("[data-monster-practice-remote-disabled]").count(), 1, "remote play must be unavailable during practice");
    await remote.locator(".mecha-settings-close").click();
    console.log(`START ${lang} ${spec.label}: practice selected`);
    const placements = await deploy(page);
    console.log(`START ${lang} ${spec.label}: deployed`);
    const intent = await page.evaluate(() => window.__practiceController.getState().match.boss.intent);
    assert.equal(intent?.skillId, spec.skill, `${spec.label}: wrong declared skill`);
    const m3 = ["corrode_cell", "phase_swap", "gravity_well"].includes(spec.skill);
    assert.ok(intent.status === "planned" || (m3 && intent.status === "void"), `${spec.label}: unexpected declaration status`);
    const threats = page.locator(".mecha-threat-details");
    await threats.locator("summary").click();
    assert.ok((await threats.innerText()).toLowerCase().includes(spec[lang].toLowerCase()), `${spec.label}: declared skill must be visible in battle HUD`);
    if (["corrode_cell", "phase_swap", "gravity_well"].includes(spec.skill)) {
      assert.equal(await threats.locator("[data-monster-intent]").count(), 1, "declaration and draft details must be visible");
      assert.match(await threats.locator("[data-monster-intent]").innerText(), lang === "zh" ? /草稿重投影/ : /Draft reprojection/);
    }
    // Plan the explicit holds via the actual roster and action controls.
    for (let i = 0; i < 3; i++) {
      await page.locator(".mecha-pack .mecha-plan-card__select").nth(i).click();
      await page.locator('[data-mecha-action="skip"]').click();
    }
    const before = await page.evaluate(() => {
      const s = window.__practiceController.getState();
      return structuredClone({ match: s.match, preview: s.preview, ready: s.packReady, pending: s.pendingIds });
    });
    assert.equal(before.ready, true, JSON.stringify(before.pending));
    assert.equal(before.preview.ok, true, JSON.stringify(before.preview));
    assert.deepEqual(before.preview.assumed, [], "all actions must be explicitly planned");
    await page.locator(".mecha-submit-primary").click();
    if (await page.locator(".mecha-hold-confirm").isVisible()) await page.locator(".mecha-hold-confirm .mecha-submit-primary").click();
    await page.waitForFunction(revision => window.__practiceController.getState().match.revision > revision, before.match.revision);
    const after = await page.evaluate(() => {
      const s = window.__practiceController.getState();
      return structuredClone({ match: s.match, log: s.lastLog, stages: s.combat.presentationStages, replay: s.replayAvailable });
    });
    assert.equal(after.match.monsterContent?.speciesId, spec.id);
    assert.ok(after.replay >= 1, "accepted turn must be recorded");
    assert.deepEqual(after.log, before.preview.log, `${spec.label}: settled events differ from preview`);
    assert.deepEqual(after.stages, before.preview.stages, `${spec.label}: presentation stages differ from preview`);
    assert.equal(after.match.outcome, before.preview.outcome, `${spec.label}: outcome differs from preview`);
    if (intent.status === "void") {
      // The city rear deployment may leave all units outside displacement range.
      // This is a legitimate void, not a fabricated move or a reason to patch the map.
      assert.equal(before.preview.monsterProjection?.status, "void");
      assert.ok(!after.log.some(event => event.type === "monster_displacement" ||
        (event.type === "enemy" && event.actor === "boss" && event.skill === spec.skill) ||
        (event.type === "corrode_field" && event.change === "created")));
    } else if (spec.skill === "prism_guard") {
      assert.equal(intent.targetId, "boss");
      assert.equal(intent.shieldHits, 1);
      assert.ok(after.log.some(event => event.type === "monster_status" && event.change === "applied"), "prism status application missing");
      assert.deepEqual(after.stages.afterEnemy.boss.shield, { kind: "prism_guard", hits: 1 });
    } else if (spec.skill === "corrode_cell") {
      const field = after.log.find(item => item.type === "corrode_field" && item.change === "created");
      assert.ok(field, "corrode must create its bound field");
      assert.deepEqual(field.field.cell, intent.corrode.target);
      assert.equal(field.field.expiresAfterRound - field.field.createdRound + 1, intent.corrode.durationTurns);
    } else {
      const event = after.log.find(item => item.type === "enemy" && item.actor === "boss" && item.skill === spec.skill);
      assert.ok(event, `${spec.label}: actual signature event missing; intent=${JSON.stringify(intent)}, events=${JSON.stringify(after.log)}`);
      assert.deepEqual(event.cells, intent.projected, `${spec.label}: attack cells differ from declared intent`);
      if (spec.skill === "spore_leap") {
        const move = after.log.find(item => item.type === "boss_move");
        assert.ok(move, "spore leap must move the boss");
        assert.deepEqual(move.from, before.match.boss.anchor);
        assert.deepEqual(move.to, { x: move.from.x + intent.landingOffset.x, y: move.from.y + intent.landingOffset.y });
      }
      if (spec.skill === "ring_pierce") assert.ok(intent.direction && Number.isInteger(intent.lane), "ring pierce must bind direction and lane");
      if (spec.skill === "phase_swap" || spec.skill === "gravity_well") {
        const moves = after.log.filter(item => item.type === "monster_displacement");
        assert.ok(moves.length, "bound displacement must be emitted");
        assert.ok(after.log.indexOf(moves[0]) < after.log.indexOf(event), "displacement precedes attack");
        assert.deepEqual(before.preview.monsterProjection.displacement.request.targetIds, intent.displacement.request.targetIds);
      }
    }
    // Wait for the actual presentation to finish; never shortcut or replace it.
    await page.waitForFunction(() => !window.__practiceController.getState().performance, null, { timeout: 120000 });
    if (spec.skill === "prism_guard") {
      const shield = page.locator('[data-prism-shield-status="active"]');
      await shield.waitFor({ state: "visible" });
      assert.equal(await shield.getAttribute("data-prism-shield-hits"), "1");
    }
    assert.equal(after.match.outcome, null, "fixture must remain live to exercise UI exit");
    await page.locator('[data-mecha-settings-trigger="battlefield"]').click();
    if (await practice.getAttribute("open") === null) await practice.locator("summary").click();
    await practice.locator("[data-monster-practice-exit]").click();
    await practice.locator("[data-monster-practice-confirm]").click();
    await page.waitForFunction(() => !Object.hasOwn(window.__practiceController.getState().match, "monsterContent") && window.__practiceController.getState().match.phase === "deployment");
    assert.equal(await page.locator("[data-monster-practice-active]").count(), 0);
    await panel.locator(".mecha-settings-close").click();
    await page.locator(".mecha-battle-menu > summary").click();
    await page.getByRole("button", { name: lang === "zh" ? "退出战斗" : "Exit battle", exact: true }).click();
    await page.locator(".mecha-overlay").waitFor({ state: "hidden" });
    assert.deepEqual(errors, [], "uncaught page errors");
    console.log(`PASS ${lang} ${spec.label} ${spec.id}: UI select/cancel/remote guard/deploy/hold/submit, ${spec.skill} (${intent.status}), preview=events/stages/outcome, exit; cells=${placements.join(" ")}, blocked HTTP=${blocked.length}, blocked WS=${sockets.length}`);
  } catch (error) {
    if (errors.length) console.error(`${lang} ${spec.label} page errors:`, errors);
    throw error;
  } finally { await context.close(); }
}

try {
  let origin;
  if (process.argv[2]) {
    const url = new URL(process.argv[2]);
    assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "dev server must be HTTP loopback");
    origin = url.origin;
  } else {
    const { createServer } = await import(pathToFileURL(uiRequire.resolve("vite")).href);
    const react = (await import(pathToFileURL(uiRequire.resolve("@vitejs/plugin-react")).href)).default;
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "mecha-practice-vite-"));
    server = await createServer({ configFile: false, root: ui, base: "./", plugins: [react()],
      define: { __CITY_GAME_UAT__: JSON.stringify(false) }, cacheDir, logLevel: "error",
      server: { host: "127.0.0.1", port: 0, hmr: false } });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
  }
  browser = await chromium.launch({ headless: true, ...(process.env.MECHA_CHROME ? { executablePath: process.env.MECHA_CHROME } : {}),
    args: [process.env.MECHA_BROWSER_ANGLE === "metal" ? "--use-angle=metal" : "--enable-unsafe-swiftshader", "--disable-background-networking", "--disable-component-update"] });
  for (const lang of langs) for (const spec of species.filter(item => !process.env.MECHA_SPECIES || process.env.MECHA_SPECIES.split(",").includes(item.id))) {
    try { await checkCase(origin, lang, spec); }
    catch (error) { failures++; console.error(`FAIL ${lang} ${spec.label} ${spec.id}:`, error.stack ?? error); }
  }
  const count = langs.length * species.filter(item => !process.env.MECHA_SPECIES || process.env.MECHA_SPECIES.split(",").includes(item.id)).length;
  console.log(`Practice browser acceptance: ${count - failures}/${count} cases passed; synthetic fixture only.`);
  if (failures) process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
}
