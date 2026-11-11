#!/usr/bin/env node
// Local, synthetic, headed-Chrome diagnostic, NOT device acceptance.
// Usage: node apps/agent-city/ui/tests/mecha-monster-baseline-performance.browser.mjs
// Requires the UI's Vite dependencies, desktop/ui-dev's Playwright and Chrome.
// Optional: MECHA_CHROME=/absolute/path/to/Chrome. Results go to stdout only.
// Uses a private loopback Vite server/cache and an ephemeral browser profile.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { completeLocalDeployment } from "../../../../scripts/mecha-deployment-browser-helpers.mjs";

const ui = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const uiRequire = createRequire(path.join(ui, "package.json"));
const desktopRequire = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"));
const { createServer } = await import(pathToFileURL(uiRequire.resolve("vite")).href);
const react = (await import(pathToFileURL(uiRequire.resolve("@vitejs/plugin-react")).href)).default;
const { chromium } = desktopRequire("playwright");
const playwrightVersion = desktopRequire("playwright/package.json").version;
const chrome = process.env.MECHA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const seed = "4196523069";
const fixtureSessions = 30;
const warmupMs = 5000;
const sampleMs = 10000;
const viewport = { width: 1100, height: 700 };
const cacheDir = await mkdtemp(path.join(os.tmpdir(), "mecha-mon000-vite-"));
let server;
let browser;
let context;

function macVersion() {
  if (process.platform !== "darwin") return null;
  try { return execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(); }
  catch { return null; }
}

try {
  // Match the checked-in Vite config, but avoid writing its normal node_modules cache.
  server = await createServer({
    configFile: false,
    root: ui,
    base: "./",
    plugins: [react()],
    define: { __CITY_GAME_UAT__: JSON.stringify(process.env.AGENT_VITALS_CITY_GAME_UAT === "1") },
    cacheDir,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: false,
    executablePath: chrome,
    args: ["--disable-background-networking", "--disable-component-update"],
  });
  context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "en-US", serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const pageErrors = [];
  let blockedRequests = 0;
  let instrumented = 0;
  page.on("pageerror", error => pageErrors.push(error.message));
  // No application traffic outside the ephemeral loopback origin. No host bridge,
  // local user data, persistent browser profile, external WS or remote arena.
  await page.routeWebSocket("**/*", ws => ws.close());
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { blockedRequests += 1; return route.abort(); }
    if (url.pathname !== "/src/engine/CityEngine.ts") return route.continue();
    const response = await route.fetch();
    const body = await response.text();
    // Measure actual render submissions, not every RAF: CityEngine intentionally
    // throttles idle/software-rendered frames. One guarded callback per render.
    const needle = "this.lastRenderAt = now;\n    this.accountFrame(now, idle);";
    assert.equal(body.split(needle).length, 2, "CityEngine render hook changed; refusing a misleading sample");
    const patched = body.replace(needle, "this.lastRenderAt = now;\n    window.__MON000_FRAME__?.(performance.now());\n    this.accountFrame(now, idle);");
    instrumented += 1;
    return route.fulfill({ response, body: patched });
  });
  await page.addInitScript(seedValue => {
    localStorage.setItem("city.seed", seedValue);
    window.__AV_PLUGIN_LOCALE__ = "en";
  }, seed);
  await page.goto(`${origin}/?fixtureSessions=${fixtureSessions}`, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await page.locator(".city-loading").waitFor({ state: "hidden" });
  await page.waitForFunction(() => {
    const p = window.__AV_CITY_PROBE__?.();
    return p?.source === "fixture" && p?.firstModelFrame === true && !!document.querySelector("canvas");
  }, null, { timeout: 240_000 });
  assert.equal(instrumented, 1, "render hook not installed exactly once");
  await page.bringToFront();

  const sceneInfo = async () => page.evaluate(() => {
    const p = window.__AV_CITY_PROBE__?.();
    const canvas = document.querySelector("canvas");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    const rect = canvas?.getBoundingClientRect();
    return {
      source: p?.source ?? null, sessionCount: p?.sessionCount ?? null,
      coverage: p?.coverage ?? null, firstModelFrame: p?.firstModelFrame ?? null,
      scaleTier: p?.scene?.scaleTier ?? null, visibility: document.visibilityState,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      canvas: canvas ? { width: canvas.width, height: canvas.height, cssWidth: rect.width, cssHeight: rect.height } : null,
      gpu: gl ? { version: gl.getParameter(gl.VERSION), vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null } : null,
    };
  });
  const measure = async label => {
    const before = await sceneInfo();
    assert.equal(before.source, "fixture");
    assert.equal(before.visibility, "visible", `${label}: page is hidden`);
    assert.ok(before.gpu && before.canvas?.width && before.canvas?.height, `${label}: no WebGL canvas`);
    await page.waitForTimeout(warmupMs);
    const sample = await page.evaluate(duration => new Promise((resolve, reject) => {
      if (document.visibilityState !== "visible") return reject(new Error("page hidden before sampling"));
      const times = [];
      let hidden = false;
      const visibility = () => { if (document.visibilityState !== "visible") hidden = true; };
      document.addEventListener("visibilitychange", visibility);
      window.__MON000_FRAME__ = now => times.push(now);
      const start = performance.now();
      setTimeout(() => {
        const elapsed = performance.now() - start;
        delete window.__MON000_FRAME__;
        document.removeEventListener("visibilitychange", visibility);
        if (hidden || document.visibilityState !== "visible") return reject(new Error("page hidden during sampling"));
        if (times.length < 3) return reject(new Error(`only ${times.length} rendered frames sampled`));
        const intervals = times.slice(1).map((time, i) => time - times[i]);
        if (intervals.some(n => !Number.isFinite(n) || n <= 0)) return reject(new Error("invalid frame timestamps"));
        const sorted = [...intervals].sort((a, b) => a - b);
        resolve({ elapsedMs: elapsed, frames: times.length, intervals: intervals.length,
          coveredMs: times.at(-1) - times[0],
          meanMs: intervals.reduce((sum, n) => sum + n, 0) / intervals.length,
          p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], minMs: sorted[0], maxMs: sorted.at(-1) });
      }, duration);
    }), sampleMs);
    const after = await sceneInfo();
    assert.equal(after.visibility, "visible");
    assert.equal(after.source, "fixture");
    return { label, before, after, sample };
  };

  const city = await measure("city: idle default camera, default auto quality");
  await page.getByRole("button", { name: "City settings", exact: true }).click();
  await page.getByRole("button", { name: "Mecha tactics", exact: true }).click();
  await page.locator('.mecha-overlay[data-phase="deployment"]').waitFor({ timeout: 240_000 });
  const placements = await completeLocalDeployment(page);
  assert.equal(placements.length, 3);
  await page.locator('.mecha-overlay[data-phase="player_plan"]').waitFor();
  const battle = await measure("mecha: default siege, player planning idle after local deployment");
  assert.equal(await page.locator('.mecha-overlay[data-phase="player_plan"]').count(), 1);
  assert.deepEqual(pageErrors, [], "uncaught browser errors invalidate the sample");

  const report = {
    kind: "MON-000 local synthetic diagnostic; not real-device acceptance",
    timestamp: new Date().toISOString(),
    environment: { platform: process.platform, osRelease: os.release(), macOS: macVersion(), arch: process.arch,
      cpu: os.cpus()[0]?.model ?? null, browser: browser.version(), browserExecutable: chrome, playwright: playwrightVersion,
      headless: false, viewport, deviceScaleFactor: 1 },
    fixture: { seed, requestedSyntheticSessions: fixtureSessions, cityQuality: "auto", deploymentCells: placements,
      origin: "private loopback Vite dev server", blockedExternalRequests: blockedRequests },
    methodology: { warmupMsPerScene: warmupMs, requestedSampleMsPerScene: sampleMs,
      metric: "intervals between consecutive CityEngine renderFrame completions, measured with performance.now()",
      p95: "nearest-rank: sorted[ceil(0.95*N)-1]", includesIdleThrottling: true,
      instrument: "one guarded callback injected into served CityEngine module; no source files modified" },
    city, battle,
    limitations: [
      "CPU-side render submission completion cadence, not GPU completion or GPU frame cost; renderer is asynchronous.",
      "Vsync, compositor, idle throttling, background workloads, display occlusion and measurement callback affect results.",
      "Synthetic fixture, default idle camera and planning state only; no battle animation or worst-case stress.",
      "Headed desktop Chrome and Vite development mode are not the shipped Tauri WebView or a representative device matrix.",
      "No performance thresholds, assertions of target FPS, or SDF measurements are implied.",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context?.close();
  await browser?.close();
  await server?.close();
  await rm(cacheDir, { recursive: true, force: true });
}
