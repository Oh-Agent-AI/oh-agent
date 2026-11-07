#!/usr/bin/env node
// Local synthetic transport only. Exercises the real v1.5 phone view and host session.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createMatch, bossPrepare } from "../src/game/mecha/rules.ts";
import { restoreSequentialSnapshot, SequentialMatchSession } from "../src/game/mecha/session/SequentialMatchSession.ts";
import { SequentialRemoteHost } from "../src/game/mecha/session/SequentialRemoteHost.ts";

const { chromium } = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5187";
const initial = createMatch({
  ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
  mechs: [{ id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }],
});
bossPrepare(initial);
const session = new SequentialMatchSession("phone-browser-match", initial, []);
const host = new SequentialRemoteHost(session);
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
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(envelope) }));
        });
      }
      close() {}
    };
  });
  const url = `${base}/remote.html?match=phone-browser-match&ws=${encodeURIComponent("ws://synthetic.invalid")}&capability=mecha%3Av4`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByText("机甲战棋 1.5 · 手机续玩").waitFor();
  await page.getByText("回合 1 · revision 1", { exact: true }).waitFor();

  const grid = page.locator('.mecha-v15-phone > div[style*="grid-template-columns"] button');
  assert.equal(await grid.count(), 100);
  const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  assert.deepEqual(geometry, { viewport: 390, page: 390 }, "phone surface must not overflow horizontally");
  const moveIndex = await grid.evaluateAll(nodes => nodes.findIndex(node => getComputedStyle(node).backgroundColor === "rgb(31, 95, 74)"));
  assert.ok(moveIndex >= 0, "fixture must expose a legal move");
  const origin = { ...initial.mechs.find(unit => unit.id === "Assault").pos };
  await grid.nth(moveIndex).click();
  await page.getByText("回合 1 · revision 2", { exact: true }).waitFor();
  const moved = session.snapshot();
  assert.equal(moved.ok, true);
  assert.equal(moved.snapshot.commands.length, 1);
  assert.notDeepEqual(restoreSequentialSnapshot(moved.snapshot).snapshot().match.mechs.find(unit => unit.id === "Assault").pos, origin, "phone move must reach the host's v1.5 session");
  await page.screenshot({ path: "/tmp/mecha-v15-phone-host-390x844.png", fullPage: true });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByText("回合 1 · revision 2", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS v1.5 phone handoff browser: accepted move, refresh recovery, 390x844 without overflow");
  await context.close();
} finally {
  await browser.close();
}
