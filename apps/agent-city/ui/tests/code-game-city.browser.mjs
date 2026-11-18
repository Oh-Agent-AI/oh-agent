#!/usr/bin/env node
// Real City dev server + real WebGL: builds hello-city, then proves that the
// bundle imports, acquires the City scene lease, ticks from City frames, moves
// a mesh and releases everything on finish.
//
//   npm run preview:code-game
//   npm run dev -- --port 5199 --strictPort
//   node tests/code-game-city.browser.mjs http://127.0.0.1:5199
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:5199";
const url = `${base}/?codeGame=/code-games/hello-city.js&codeGameManifest=/code-games/hello-city.manifest.json`;
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
const errors = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});

try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__ohAgentCodeGame !== undefined, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__ohAgentCodeGame.status() === "running", null, { timeout: 60000 });

  const running = await page.evaluate(() => ({
    status: window.__ohAgentCodeGame.status(),
    telemetry: window.__ohAgentCodeGame.telemetry(),
  }));
  assert.equal(running.status, "running");
  assert.equal(running.telemetry.entities, 1, "the cube must be alive while the run is active");
  assert.equal(typeof running.telemetry.tick, "number");

  const firstTick = running.telemetry.tick;
  await page.waitForFunction(
    (tick) => (window.__ohAgentCodeGame.telemetry()?.tick ?? 0) > tick,
    firstTick,
    { timeout: 10000 },
  );
  const advanced = await page.evaluate(() => window.__ohAgentCodeGame.telemetry());
  assert.ok(advanced.tick > firstTick, `tick must advance (was ${firstTick}, now ${advanced.tick})`);
  assert.ok(advanced.hud, "the HUD snapshot must reach the host");
  await page.screenshot({ path: "/tmp/code-game-city-running.png" });

  await page.waitForFunction(() => window.__ohAgentCodeGame.status() === "finished", null, { timeout: 60000 });
  const finished = await page.evaluate(() => ({
    state: window.__ohAgentCodeGame.state,
    telemetry: window.__ohAgentCodeGame.telemetry(),
  }));
  assert.equal(finished.telemetry.outcome, "success");
  assert.equal(finished.telemetry.reason, "route_complete");
  assert.equal(finished.telemetry.entities, 0, "finish must destroy run-owned entities");
  assert.equal(finished.state.status, "finished");

  const relevant = errors.filter((message) => !/favicon|WebGL|GPU|SwiftShader/i.test(message));
  assert.deepEqual(relevant, [], `page errors: ${relevant.join("\n")}`);

  await page.screenshot({ path: "/tmp/code-game-city.png" });
  console.log(JSON.stringify({ ok: true, firstTick, finalTick: finished.telemetry.tick, url, screenshot: "/tmp/code-game-city.png" }, null, 2));
} finally {
  await browser.close();
}
