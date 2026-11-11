#!/usr/bin/env node
// Development-only integration test; all city data and relay messages are synthetic.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { layoutCity } from "../src/engine/cityLayout.ts";
import { MIAMI_COASTAL } from "../src/engine/citySeaside.ts";
import { createDreamSnapshotCandidate } from "../src/remote/city/dreamSnapshotCandidate.ts";
import { encodeDreamSnapshot } from "../src/remote/city/dreamSnapshotCodec.ts";
import { parseDreamCitySnapshot } from "../src/remote/city/dreamSnapshotContract.ts";

const model = {
  districts: [{ id: "codex", label: "Codex", sessionCount: 1, tokensTotal: 42, activeCount: 1, anomaly: null }],
  buildings: [{ id: "synthetic-session", districtId: "codex", archetype: "tower", facade: 1, seed: 0.5, tokensTotal: 42, height: 8, footprint: 3, startedAt: 100, endedAt: null, active: true, builtFraction: 0.5, busyness: 0.2, aggregated: false, extraCount: 0 }],
  rows: new Map([["synthetic-session", { title: "Synthetic session" }]]),
  generatedAt: 0, windowStartMs: 0, windowEndMs: 1, windowLabel: "test", stats: { renderedSessions: 1, aggregatedSessions: 0, totalSessions: 1, tokensTotal: 42, activeCount: 1, truncated: false },
};
const camera = { position: [100, 120, 80], target: [0, 0, 0], up: [0, 1, 0], fov: 50, controls: { minDistance: 1, maxDistance: 1000, enablePan: true, zoomToCursor: false, orbitLockedId: null } };
const layout = layoutCity(model, null, 74031, MIAMI_COASTAL, "off");
const city = createDreamSnapshotCandidate(model, layout, "off", camera);
parseDreamCitySnapshot(new TextEncoder().encode(JSON.stringify(city)));
const envelope = await encodeDreamSnapshot(new TextEncoder().encode(JSON.stringify(city)));
const { chromium } = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url))("playwright");
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  const requests = [];
  const pages = [];
  for (let visitor = 0; visitor < 2; visitor++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    let pairAttempts = 0;
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "warning") errors.push(message.text()); });
    await page.route("**/v1/rooms/testroom/*", async route => {
      const request = route.request();
      const body = request.postDataJSON();
      if (request.url().endsWith("/join")) {
        requests.push(body.deviceSecret);
        await route.fulfill({ json: { ok: true, deviceId: `device${visitor}`, playerId: "guest" } });
      } else if (pairAttempts++ === 0) await route.fulfill({ status: 401, json: { ok: false } });
      else await route.fulfill({ json: { ok: true, ticket: "a".repeat(64) } });
    });
    await page.exposeFunction("__syntheticDreamEnvelope", () => envelope);
    await page.addInitScript(() => {
      window.WebSocket = class extends EventTarget {
        static OPEN = 1;
        readyState = 1;
        constructor() {
          super(); window.__dreamSocket = this;
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ protocol: "app-remote:v1", appId: "city", sessionId: "testpub", capability: "city-dream:v1", type: "ready", role: "guest", playerId: "guest" }) })));
        }
        send(data) {
          const request = JSON.parse(data);
          void window.__syntheticDreamEnvelope().then(snapshot => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ protocol: "app-remote:v1", appId: "city", sessionId: "testpub", capability: "city-dream:v1", type: "response", requestId: request.requestId, result: { ok: true, snapshot } }) })));
        }
        close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
      };
    });
    const base = process.argv[2] ?? "http://127.0.0.1:5192";
    await page.goto(`${base}/remote.html?capability=city-dream%3Av1&room=testroom&publication=testpub&invite=testinvite#${"b".repeat(64)}`, { waitUntil: "domcontentloaded" });
    await page.getByText("等待城市主人批准…").waitFor();
    try { await page.getByText("城市概览").waitFor({ timeout: 15000 }); await page.getByText(/1 个会话 · 42 tokens/).waitFor(); }
    catch (error) { throw new Error(`visitor did not load: ${await page.locator("body").innerText()} / errors: ${errors.join(", ")}`, { cause: error }); }
    await page.locator('canvas[aria-label="旋转和缩放城市场景"]:visible').waitFor();
    assert.equal(new URL(page.url()).hash, "", "invitation secret must be removed from the address after join");
    pages.push({ page, context, errors });
  }
  assert.notEqual(requests[0], requests[1], "each browser obtains its own secret");
  await pages[0].page.screenshot({ path: "/tmp/dream-city-visitor-synthetic-390x844.png" });
  await pages[0].page.evaluate(() => window.__dreamSocket.close());
  await pages[0].page.getByText("连接已关闭，城市已清除。请重新打开链接。").waitFor();
  assert.equal(await pages[0].page.locator("canvas").count(), 0);
  assert.equal(await pages[1].page.locator("canvas:visible").count(), 1, "one visitor disconnect must not clear another visitor's city");
  for (const item of pages) { assert.deepEqual(item.errors, []); await item.context.close(); }
  console.log("PASS two synthetic visitors join, load independent scenes and clear on disconnect");
} finally {
  await browser.close();
}
