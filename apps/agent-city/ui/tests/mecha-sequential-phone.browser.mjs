#!/usr/bin/env node
// Local synthetic transport only. Exercises the real v1.5 phone view and host session.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createMatch, bossPrepare } from "../src/game/mecha/rules.ts";
import { restoreSequentialSnapshot, SequentialMatchSession } from "../src/game/mecha/session/SequentialMatchSession.ts";
import { SequentialRemoteHost } from "../src/game/mecha/session/SequentialRemoteHost.ts";
import { layoutCity } from "../src/engine/cityLayout.ts";
import { MIAMI_COASTAL } from "../src/engine/citySeaside.ts";
import { createCityDisplayProjector } from "../src/remote/city/cityDisplayProjection.ts";

const { chromium } = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5187";
const initial = createMatch({
  ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
  mechs: [{ id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }],
});
bossPrepare(initial);
const session = new SequentialMatchSession("phone-browser-match", initial, []);
const model = {
  districts: [{ id: "local-district", label: "Codex", sessionCount: 1, tokensTotal: 42, activeCount: 1, anomaly: null }],
  buildings: [{ id: "local-session", districtId: "local-district", archetype: "tower", facade: 1, seed: 0.5, tokensTotal: 42, height: 8, footprint: 3, startedAt: 100, endedAt: null, active: true, builtFraction: 0.5, busyness: 0.2, aggregated: false, extraCount: 0 }],
  rows: new Map([["local-session", { title: "Synthetic session" }]]), generatedAt: 0, windowStartMs: 0, windowEndMs: 1, windowLabel: "test",
  stats: { renderedSessions: 1, aggregatedSessions: 0, totalSessions: 1, tokensTotal: 42, activeCount: 1, truncated: false },
};
const site = {
  originX: 0, originZ: 0, yaw: 0, cellW: 10, cellD: 10,
  terrain: Array.from({ length: 10 }, () => Array(10).fill("land")), heights: Array.from({ length: 10 }, () => Array(10).fill(0)),
  buildings: [], blocked: [], mechs: initial.mechs.map(unit => ({ id: unit.id, pos: unit.pos })), boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
};
const camera = { position: [100, 120, 80], target: [0, 0, 0], up: [0, 1, 0], fov: 50,
  controls: { minDistance: 1, maxDistance: 1000, enablePan: true, zoomToCursor: false, orbitLockedId: null } };
const layout = layoutCity(model, null, 74031, MIAMI_COASTAL, "off");
const city = createCityDisplayProjector(74031, site, layout, "off", camera)(model);
const host = new SequentialRemoteHost(session, city);
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("__mechaRelayRequest", request => {
    const response = host.handle({ ...request, protocol: "mecha-net:v2" });
    assert.ok(response, `host rejected ${request.method}`);
    return {
      protocol: "app-remote:v1", appId: "city", sessionId: request.sessionId, capability: "mecha:v4",
      type: "response", requestId: request.requestId, result: response.result,
    };
  });
  await page.addInitScript(() => {
    window.WebSocket = class SyntheticRelaySocket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(data) {
        const request = JSON.parse(data);
        void window.__mechaRelayRequest(request).then(envelope => {
          if (request.method === "sequential.command.submit" && window.__dropNextMechaResponse) { window.__dropNextMechaResponse = false; return; }
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(envelope) }));
        });
      }
      close() {}
    };
  });
  const url = `${base}/remote.html?match=phone-browser-match&ws=${encodeURIComponent("ws://synthetic.invalid")}&capability=mecha%3Av4&cityDebug`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByText("机甲战棋 1.5 · 手机续玩").waitFor();
  await page.getByText(/回合 1 · 选中：突击/).waitFor();

  await page.getByRole("button", { name: "战场" }).click();
  await page.waitForFunction(() => Boolean(window.__cityEngine?.camera && window.__cityEngine?.scene.getObjectByName("mecha-cell-2-3")));
  const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  assert.deepEqual(geometry, { viewport: 390, page: 390 }, "phone surface must not overflow horizontally");
  const origin = { ...initial.mechs.find(unit => unit.id === "Assault").pos };
  const point = await page.evaluate(() => {
    const { scene, camera, THREE } = window.__cityEngine;
    const tile = scene.getObjectByName("mecha-cell-2-3");
    const world = tile.getWorldPosition(new THREE.Vector3());
    world.y += 0.3;
    const ndc = world.project(camera);
    const rect = document.querySelector('canvas[aria-label="旋转和缩放城市场景"]').getBoundingClientRect();
    return { x: rect.left + (ndc.x + 1) * rect.width / 2, y: rect.top + (1 - ndc.y) * rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "撤销移动" && !button.disabled));
  const moved = session.snapshot();
  assert.equal(moved.ok, true);
  assert.equal(moved.snapshot.commands.length, 1);
  assert.notDeepEqual(restoreSequentialSnapshot(moved.snapshot).snapshot().match.mechs.find(unit => unit.id === "Assault").pos, origin, "phone move must reach the host's v1.5 session");
  await page.screenshot({ path: "/tmp/mecha-v15-phone-host-390x844.png", fullPage: true });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByText(/回合 1 · 选中：突击/).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "撤销移动" && !button.disabled));
  await page.evaluate(() => { window.__dropNextMechaResponse = true; });
  await page.getByRole("button", { name: "撤销移动" }).click();
  await page.getByText("命令结果未确认，请重新读取").waitFor();
  assert.equal(await page.getByRole("button", { name: "结束回合" }).isDisabled(), true);
  assert.equal(session.revision, 3, "host committed even though acknowledgement was lost");
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.getByText(/回合 1 · 选中：突击/).waitFor();
  assert.equal(await page.getByRole("button", { name: "结束回合" }).isDisabled(), false);
  assert.deepEqual(restoreSequentialSnapshot(session.snapshot().snapshot).snapshot().match.mechs.find(unit => unit.id === "Assault").pos, origin);
  assert.deepEqual(errors, []);
  console.log("PASS v1.5 phone handoff browser: accepted move, refresh and lost-ack recovery, 390x844 without overflow");
  await context.close();
} finally {
  await browser.close();
}
