#!/usr/bin/env node
// Synthetic Vite-only compatibility test: replaces RemoteMechaControls with an
// in-page active-state toggle. No relay, credentials, real sessions or host IPC.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5179";
const holdFixture = process.argv.includes("--hold");
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, locale: "en-US" });
  page.setDefaultTimeout(120_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/src/game/mecha/RemoteMechaControls.tsx*", async (route) => route.fulfill({
    status: 200, contentType: "application/javascript", body: `import React from "/node_modules/.vite/deps/react.js";
      export function RemoteMechaControls({onStatusChange}) { return React.createElement("div", null,
        React.createElement("button", {"data-test": "remote-on", onClick: () => onStatusChange("active")}, "Test remote on"),
        React.createElement("button", {"data-test": "remote-off", onClick: () => onStatusChange("idle")}, "Test remote off")); }`,
  }));
  await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
    assert.ok(body.includes(needle), "controller instrumentation point changed");
    body = `import { createMatch as fixtureMatch, bossPrepare as prepareFixture, living as fixtureLiving } from "/src/game/mecha/rules.ts";\n` + body;
    body = body.replace(needle, `const fixture = fixtureMatch(${holdFixture ? `{
      preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 4 },
      buildings: [{ id: "b1", cells: [{ x: 3, y: 4 }] }, { id: "b2", cells: [{ x: 3, y: 5 }] },
        { id: "b3", cells: [{ x: 0, y: 0 }] }, { id: "b4", cells: [{ x: 1, y: 0 }] }, { id: "b5", cells: [{ x: 2, y: 0 }] }],
      mechs: [{ id: "Assault", pos: { x: 1, y: 9 } }, { id: "Gunner", pos: { x: 5, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }]
    }` : `{ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 },
      raiders: [{ id: "raider-w", pos: { x: 4, y: 4 } }, { id: "raider-e", pos: { x: 6, y: 4 } }],
      mechs: [{ id: "Assault", pos: { x: 5, y: 2 } }, { id: "Gunner", pos: { x: 2, y: 8 } }, { id: "Support", pos: { x: 6, y: 2 } }] }`});
      prepareFixture(fixture);
      ${holdFixture ? `fixture.boss.intent = { skillId: "sweep", local: [{ x: -1, y: 0 }, { x: -1, y: 1 }], projected: [{ x: 3, y: 4 }, { x: 3, y: 5 }], cdSweep: 0, status: "planned" };` : ""}
      controllerRef.current = createMechaController({ animate: true, locale, site, match: fixture,
        planner: (state) => ({ revision: state.revision, items: fixtureLiving(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) }) });
      window.__lockController = controllerRef.current;`);
    body = body.replace("  const activeMechs = state ? living(state) : [];", "  window.__lockClickCell = clickCell;\n  const activeMechs = state ? living(state) : [];");
    await route.fulfill({ response, body });
  });
  await page.addInitScript(() => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = "en"; });
  await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await page.locator(".city-loading").waitFor({ state: "hidden" });
  console.log("synthetic city loaded");
  try { await page.getByRole("button", { name: "City settings" }).click({ timeout: 40000 }); }
  catch (error) { console.error("UI diagnostic", (await page.locator("body").innerText()).slice(0, 2000), errors); throw error; }
  await page.getByRole("button", { name: "Mecha tactics" }).click();
  if (holdFixture) {
    await page.locator(".mecha-submit-primary").click();
    const confirm = page.locator(".mecha-hold-confirm");
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /Predicted building loss 12/);
    const before = await page.evaluate(() => ({ draft: structuredClone(window.__lockController.getState().draft), turn: window.__lockController.getState().match.turn }));
    await page.locator('[data-test="remote-on"]').evaluate((button) => button.click());
    assert.equal(await page.getByRole("button", { name: "Return to editing" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Submit anyway" }).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => ({ draft: structuredClone(window.__lockController.getState().draft), turn: window.__lockController.getState().match.turn })), before);
    await page.locator('[data-test="remote-off"]').evaluate((button) => button.click());
    await page.getByRole("button", { name: "Return to editing" }).click();
    assert.equal(await confirm.count(), 0);
    console.log("Synthetic remote-active hold confirmation lock and restoration passed.");
  } else {
    await page.locator(".mecha-pack li > button").nth(2).click();
    console.log("battle ready; Support selected");
    await page.locator(".mecha-selected-actions > .mecha-actions > button").filter({ hasText: /^Repair$/ }).click();
    await page.locator(".mecha-target-preview .mecha-actions > button").first().click();
    await page.locator(".mecha-candidate-actions button").first().waitFor();
    console.log("repair candidate ready");
    const before = await page.evaluate(() => structuredClone(window.__lockController.getState().draft));
    await page.locator('[data-test="remote-on"]').evaluate((button) => button.click());
    assert.match(await page.locator(".mecha-turn-summary [role=status]").innerText(), /does not sync the remote battle/);
    assert.match(await page.locator(".mecha-submit").innerText(), /Local planning is locked during remote play/);
    assert.equal(await page.locator(".mecha-candidate-actions button").first().isDisabled(), true, "candidate confirmation must lock while remote is active");
    assert.equal(await page.locator(".mecha-target-preview .mecha-actions > button").first().isDisabled(), true, "target selection must lock while remote is active");
    assert.equal(await page.locator(".mecha-pack li > button").first().isDisabled(), true, "local mech selection must lock while remote is active");
    await page.evaluate(() => window.__lockClickCell(5, 2, "mouse"));
    assert.deepEqual(await page.evaluate(() => window.__lockController.getState().draft), before, "board input must not mutate draft while remote is active");
    await page.locator('[data-test="remote-off"]').evaluate((button) => button.click());
    assert.deepEqual(await page.evaluate(() => window.__lockController.getState().draft), before);
    assert.equal(await page.locator(".mecha-turn-summary [role=status]").count(), 0);
    assert.equal(await page.locator(".mecha-candidate-actions button").first().isDisabled(), false);
    await page.locator(".mecha-candidate-actions button").first().click();
    assert.equal(await page.evaluate(() => window.__lockController.getState().draft.Support.action.kind), "repair");
  }
  assert.deepEqual(errors, []);
  console.log("Synthetic remote-active UI lock and restoration passed; no network, native host or remote session used.");
} finally { await browser.close(); }
