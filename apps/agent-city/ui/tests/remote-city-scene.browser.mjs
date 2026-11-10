#!/usr/bin/env node
// Synthetic visitor city: exercises the same renderer and production Mecha site search.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { layoutCity } from "../src/engine/cityLayout.ts";
import { MIAMI_COASTAL } from "../src/engine/citySeaside.ts";
import { anchorsFromCity, siteFightShapes } from "../src/game/mecha/citySite.ts";
import { captureCityVisualHero, captureCityVisualPalettes, createCitySnapshotProjector } from "../src/remote/city/cityDisplayProjection.ts";

// This fixed model/seed creates enough deterministic parcel anchors for the
// production city-site search to find a real playable window. It is still a
// synthetic local city; no owner data or relay is involved.
const BUILDING_COUNT = 8;
const buildings = Array.from({ length: BUILDING_COUNT }, (_, index) => ({
  id: `local-session-${String(index + 1).padStart(2, "0")}`,
  districtId: "local-district",
  archetype: "tower",
  facade: index % 5,
  seed: (index + 1) / (BUILDING_COUNT + 1),
  tokensTotal: 100,
  height: 8,
  footprint: 3,
  startedAt: index + 1,
  endedAt: null,
  active: true,
  builtFraction: 1,
  busyness: 0.2,
  aggregated: false,
  extraCount: 0,
}));
const model = {
  districts: [{ id: "local-district", label: "Codex", sessionCount: BUILDING_COUNT, tokensTotal: BUILDING_COUNT * 100, activeCount: BUILDING_COUNT, anomaly: null }],
  buildings,
  rows: new Map(buildings.map(building => [building.id, { title: `Synthetic session ${building.id}` }])),
  generatedAt: 0, windowStartMs: 0, windowEndMs: 1, windowLabel: "test", stats: { renderedSessions: BUILDING_COUNT, aggregatedSessions: 0, totalSessions: BUILDING_COUNT, tokensTotal: BUILDING_COUNT * 100, activeCount: BUILDING_COUNT, truncated: false },
};
const camera = { position: [100, 120, 80], target: [0, 0, 0], up: [0, 1, 0], fov: 50, controls: { minDistance: 1, maxDistance: 1000, enablePan: true, zoomToCursor: false, orbitLockedId: null } };
const layout = layoutCity(model, null, 74031, MIAMI_COASTAL, "off");
const localCatalog = siteFightShapes(layout.terrain, anchorsFromCity(layout, model), layout.roadEdges);
assert.ok(localCatalog.flat || localCatalog.shore || localCatalog.alley, "fixed synthetic city must produce a real production-search Mecha site");
const snapshot = createCitySnapshotProjector(74031, layout, "off", camera)(model);
const palettes = captureCityVisualPalettes(model, snapshot);
const hero = captureCityVisualHero(model, layout, snapshot);
const { chromium } = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url))("playwright");
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  const consoleErrors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`${process.argv[2] ?? "http://127.0.0.1:5192"}/remote.html`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.title(), "Agent City · Remote", "shared remote entry must not present itself as the retired Mecha-only page");
  const codecResult = await page.evaluate(async value => {
    const { encodeDreamSnapshot, decodeDreamSnapshot } = await import("/src/remote/city/dreamSnapshotCodec.ts");
    const original = JSON.stringify(value);
    const envelope = await encodeDreamSnapshot(new TextEncoder().encode(original));
    const restored = new TextDecoder("utf-8", { fatal: true }).decode(await decodeDreamSnapshot(envelope));
    return { matches: original === restored, envelopeBytes: new TextEncoder().encode(JSON.stringify(envelope)).length };
  }, snapshot);
  assert.equal(codecResult.matches, true, "browser must restore the exact projected snapshot bytes");
  assert.ok(codecResult.envelopeBytes < 230 * 1024);
  await page.evaluate(async () => {
    const element = document.createElement("div");
    element.style.cssText = "position:fixed;inset:0;z-index:99999;background:#102030";
    document.body.appendChild(element);
    const { createHarness } = await import("/tests/remote-city-scene-harness.tsx");
    window.__cityHarness = createHarness(element);
  });
  await page.evaluate(({ value, colors, heroId }) => window.__cityHarness.render(value, colors, heroId), { value: snapshot, colors: palettes, heroId: hero });
  await page.locator('canvas[aria-label="旋转和缩放城市场景"]:visible').waitFor({ timeout: 30000 });
  const bounds = await page.locator('canvas[aria-label="旋转和缩放城市场景"]').boundingBox();
  assert.ok(bounds && bounds.width >= 380 && bounds.height >= 830, "standalone canvas should fill the mobile viewport");
  await page.waitForTimeout(1000);
  assert.equal(await page.getByRole("alert").count(), 0, "valid city renders without an error");
  assert.equal(await page.getByRole("button", { name: "自由飞行" }).count(), 1, "visitor scene exposes an isolated free flight entry");
  await page.getByRole("button", { name: "机甲战棋" }).click();
  await page.getByText("已部署 0/3", { exact: false }).waitFor({ timeout: 60000 });
  await page.screenshot({ path: "/tmp/agent-city-dream-mecha-post-lease-390x844.png" });
  assert.equal(await page.locator('.mecha-v15-alert[role="alert"]').count(), 0, `visitor-local Mecha battlefield assets are available; console=${JSON.stringify(consoleErrors)} page=${JSON.stringify(errors)}`);
  assert.equal(await page.getByRole("button", { name: "远程控制" }).count(), 0, "visitor-local Mecha must not expose desktop remote controls");
  assert.equal(await page.getByRole("button", { name: "机甲战棋" }).count(), 0, "Mecha takes exclusive ownership of the visitor scene");
  const deployedCells = new Set();
  for (const [index, mechId] of ["Assault", "Gunner", "Support"].entries()) {
    if (index > 0) await page.locator(`.mecha-deploy-roster [data-mech-id="${mechId}"] button`).click();
    const deployList = page.locator(".mecha-deploy-list");
    if (!(await deployList.evaluate(element => element.open))) await deployList.locator("summary").click();
    const placement = page.locator("#mecha-deploy-choice");
    await placement.waitFor({ timeout: 15000 });
    const coordinates = await placement.locator("option").evaluateAll(options => options.map(option => option.value).filter(Boolean));
    const coordinate = coordinates.find(value => !deployedCells.has(value));
    assert.ok(coordinate, `${mechId} must have an unused legal deployment coordinate`);
    await placement.selectOption(coordinate);
    await page.getByRole("button", { name: "放置机甲", exact: true }).click();
    await page.screenshot({ path: `/tmp/agent-city-dream-mecha-deployed-${index + 1}-390x844.png` });
    await page.getByText(`已部署 ${index + 1}/3`, { exact: false }).waitFor({ timeout: 10000 });
    deployedCells.add(coordinate);
  }
  const confirmDeployment = page.getByRole("button", { name: "确认部署", exact: true });
  await confirmDeployment.waitFor({ timeout: 10000 });
  assert.equal(await confirmDeployment.isEnabled(), true, "three deployed mechs enable deployment confirmation");
  await confirmDeployment.click();
  await page.getByRole("button", { name: "结束回合", exact: true }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: "/tmp/agent-city-dream-mecha-390x844.png" });
  await page.getByRole("button", { name: "待机", exact: false }).first().click();
  await page.getByRole("button", { name: "确认行动", exact: true }).click();
  await page.getByRole("button", { name: "结束回合", exact: true }).click();
  const confirmEnd = page.getByRole("button", { name: "确认结束", exact: true });
  if (await confirmEnd.count()) await confirmEnd.click();
  await page.getByText("回合 2/", { exact: false }).waitFor({ timeout: 60000 });
  assert.equal(await page.getByRole("button", { name: "远程控制" }).count(), 0, "round progression remains visitor-local");
  await page.screenshot({ path: "/tmp/agent-city-dream-mecha-round2-390x844.png" });
  page.on("dialog", dialog => dialog.accept());
  await page.locator(".mecha-battle-menu summary").click();
  await page.getByRole("button", { name: "退出战斗" }).click();
  await page.getByRole("button", { name: "机甲战棋" }).waitFor({ timeout: 10000 });

  await page.getByRole("button", { name: "自由飞行" }).click();
  await page.getByText("自由练习", { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(await page.getByRole("button", { name: "自由飞行" }).count(), 0, "game entry replaces the idle launch controls");
  await page.screenshot({ path: "/tmp/agent-city-dream-synthetic-390x844.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "退出游戏" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "退出游戏" }).click();
  await page.getByRole("button", { name: "驾驶" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "驾驶" }).click();
  await page.getByRole("button", { name: "喷气飞车" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "喷气飞车" }).click();
  await page.getByRole("button", { name: "开始驾驶" }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "开始驾驶" }).click();
  const driveForward = page.getByRole("button", { name: "前进" });
  const driveThruster = page.getByRole("button", { name: "喷升" });
  await driveForward.waitFor({ timeout: 10000 });
  await driveThruster.waitFor({ timeout: 10000 });
  await page.screenshot({ path: "/tmp/agent-city-dream-driving-390x844.png" });
  await driveForward.hover();
  await page.mouse.down();
  assert.equal(await driveForward.getAttribute("aria-pressed"), "true", "touch forward control becomes pressed");
  await page.mouse.up();
  assert.equal(await driveForward.getAttribute("aria-pressed"), "false", "touch forward control releases");
  await driveThruster.hover();
  await page.mouse.down();
  assert.equal(await driveThruster.getAttribute("aria-pressed"), "true", "VTOL thrust touch control becomes pressed");
  await page.mouse.up();
  assert.equal(await driveThruster.getAttribute("aria-pressed"), "false", "cancelled touch control releases");
  await page.getByRole("button", { name: "暂停" }).click();
  assert.equal(await page.getByRole("button", { name: "前进" }).count(), 0, "pause removes touch controls and releases input");
  await page.getByRole("button", { name: "退出驾驶" }).click();
  await page.evaluate(() => window.__cityHarness.render(null));
  await page.getByText("正在同步城市场景…").last().waitFor();
  assert.equal(await page.locator('canvas[aria-label="旋转和缩放城市场景"]').count(), 0, "clearing the snapshot disposes its city view");
  await page.evaluate(value => window.__cityHarness.render({ ...value, layout: { ...value.layout, generatorVersion: 999 } }), snapshot);
  await page.getByText("无法加载城市快照，请重新获取链接或联系城市主人。").waitFor();
  await page.evaluate(value => window.__cityHarness.render(value), snapshot);
  await page.locator('canvas[aria-label="旋转和缩放城市场景"]:visible').waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
  console.log("PASS synthetic visitor city, local Mecha deployment and round, flight, VTOL driving, remote controls hidden, clear, malformed snapshot and recovery");
} finally {
  await browser.close();
}
