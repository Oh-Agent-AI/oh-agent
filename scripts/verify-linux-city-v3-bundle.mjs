#!/usr/bin/env node
// Packaged Agent City click-through for city:v3 paging on Linux.
// Playwright drives the bundled plugin webview assets (WebKitGTK has no
// Playwright adapter). Optional xvfb smoke launches the extracted Tauri deb.
//
//   node scripts/verify-linux-city-v3-bundle.mjs --skip-native
//   node scripts/verify-linux-city-v3-bundle.mjs --native-only --deb path/to.deb
//   node scripts/verify-linux-city-v3-bundle.mjs --plugin-dir <ui> --out <dir> --deb <deb>
//
// Playwright results are also written to <out>/playwright-results.json so a later
// --native-only run cannot clobber the six checks.
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const opt = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const outDir = path.resolve(opt("--out", path.join(repo, "artifacts/city-v3-linux-clickthrough")));
const pluginDir = path.resolve(opt("--plugin-dir", path.join(repo, "apps/desktop/src-tauri/ui-react-dist/plugins/AgentCity.plugin/ui")));
const nativeDeb = opt("--deb", null);
const skipNative = args.has("--skip-native");
const nativeOnly = args.has("--native-only");
const TOTAL = 4101;
const PAGE = 500;
const CAP = 4000;
const NOW = Date.parse("2026-10-22T16:00:00Z");
const hex = (n) => n.toString(16).padStart(32, "0");
const handle = (prefix, n) => `${prefix}_${hex(n)}`;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const mime = (file) => file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") ? "image/jpeg" : file.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";

function sessionRow(index, days) {
  const at = iso(NOW - 1000 - index);
  const fromMs = NOW - days * 86_400_000;
  if (Date.parse(at) < fromMs) return null;
  return {
    id: handle("sr", index + 1), harness: "codex",
    title: index % 7 === 0 ? `Session ${index + 1}` : null,
    title_source: index % 7 === 0 ? "codex_thread_name" : null,
    asset_ref: handle("ca", index + 1), layout_order: index + 1, usage_event_count: 1,
    title_state: index % 7 === 0 ? "available" : "unavailable",
    first_event_at: at, last_event_at: at, window_first_event_at: at, window_last_event_at: at,
    lifetime_first_event_at: at, lifetime_last_event_at: at,
    tokens: { input: 60, uncached_input: 10, cache_read: 20, cache_write: 30, output: 40, total: 100 },
    event_count: 1, model_ids: [index + 1 === TOTAL ? "outside-cap-model" : "visible-model"],
  };
}

function windowDto(days) {
  const fromMs = NOW - days * 86_400_000;
  return { days, from_ms: fromMs, to_ms: NOW, from: iso(fromMs), to: iso(NOW), timezone: "UTC", calendar_mode: "rolling", boundary: "half_open" };
}

function harnesses() {
  return [{ id: "codex", display_name: "Codex", capabilities: { session_statistics: { available: true }, findings: { available: true, reason: null } } }];
}

function v2Projection(days, count) {
  const sessions = [];
  for (let index = 0; index < count; index += 1) {
    const row = sessionRow(index, days);
    if (row) sessions.push({
      id: row.id, harness: row.harness, title: row.title, title_source: row.title_source,
      first_event_at: row.first_event_at, last_event_at: row.last_event_at, tokens: row.tokens, event_count: 1,
    });
  }
  return {
    protocol: "city:v2", source: "fixture", harnesses: harnesses(), generated_at: iso(NOW),
    window: { days, label: `最近 ${days} 天`, from: iso(NOW - days * 86_400_000), to: iso(NOW) },
    sessions, findings: [], coverage: { total: sessions.length, returned: sessions.length, truncated: false, unknown_time: 0 },
    status: "ready",
  };
}

function createV3Host() {
  let revision = 1, snapshot = handle("sr", 0xabc), context = handle("sr", 0xdef);
  let failDetailOnce = false, laterPages = null, releaseLaterPages = () => {};
  const holdLaterPages = () => { laterPages = new Promise((resolve) => { releaseLaterPages = resolve; }); };
  holdLaterPages();
  const ok = (requestId, result) => ({ version: 1, requestId, ok: true, result, error: null });
  const err = (requestId, code) => ({ version: 1, requestId, ok: false, result: null, error: { code, retryable: true } });
  const overviewModules = (days) => {
    const generated = iso(NOW);
    return {
      overview: { state: "ready", supported: true, data: {
        session_count: TOTAL, usage_event_count: TOTAL,
        tokens: { input: TOTAL * 60, output: TOTAL * 40, total: TOTAL * 100, uncached_input: TOTAL * 10, cache_read: TOTAL * 20, cache_write: TOTAL * 30 },
        models: { model_ids: ["outside-cap-model", "visible-model"], unknown_model_usage_events: 0, legacy_usage_events: 0 },
        time_classification: { scope: "window", unknown_time_only: 0, mixed_time: 0, excluded_no_usage: 0 },
      }, freshness: { read_at: generated, source_state: "unknown", reason: "source_freshness_not_measured" } },
      activity: { state: "ready", supported: true, data: { timezone: "UTC", days: [{ date: "2026-10-21", session_count: TOTAL, event_count: TOTAL, tokens: TOTAL * 100 }],
        busiest_day: { date: "2026-10-21", session_count: TOTAL, event_count: TOTAL, tokens: TOTAL * 100 } },
        freshness: { read_at: generated, source_state: "unknown", reason: "source_freshness_not_measured" } },
      findings: { state: "empty", supported: true, data: { current_backlog: [], window_new: [] } },
      skills: { state: "ready", supported: true, load: "on_demand" },
      workflow: { state: "ready", supported: true, load: "on_demand" },
    };
  };
  const pageOf = (days, offset) => {
    const sessions = [];
    for (let index = offset; index < Math.min(offset + PAGE, CAP, TOTAL); index += 1) {
      const row = sessionRow(index, days);
      if (row) sessions.push(row);
    }
    const next = offset + sessions.length;
    return { sessions, next_cursor: next < Math.min(CAP, TOTAL) ? String(next) : null,
      coverage: { matched: TOTAL, returned: sessions.length, offset, has_more: next < Math.min(CAP, TOTAL),
        render_budget: 4000, selection: "window_last_event_desc_session_key_asc", order: "window_last_event_desc_session_key_asc" } };
  };
  async function handleRequest(request) {
    const payload = request?.payload ?? {};
    const requestId = request.requestId;
    if (request.method !== "data.read") return err(requestId, "plugin_command_unavailable");
    if (payload.projection === "city-settings") return ok(requestId, { seed: 74031 });
    if (payload.projection === "city" && payload.version === 2) return ok(requestId, v2Projection(payload.windowDays ?? 366, payload.windowDays === 366 ? 800 : 280));
    if (payload.projection !== "city" || payload.version !== 3) return err(requestId, "landing_method_unavailable");
    const days = payload.windowDays ?? payload.window?.days ?? 366;
    const envelope = () => ({ protocol: "city:v3", source: "local", query_semantics: "city-window-v3.1",
      data_revision: revision, snapshot, context, generated_at: iso(NOW), window: payload.window ?? windowDto(days) });
    if (payload.operation === "overview") {
      return ok(requestId, { ...envelope(), harnesses: harnesses(), page: pageOf(days, 0), modules: overviewModules(days) });
    }
    if (payload.operation === "sessions.page") {
      if (laterPages) await laterPages;
      const offset = Number(payload.cursor);
      if (!Number.isInteger(offset) || offset < 0) return err(requestId, "invalid_cursor");
      return ok(requestId, { ...envelope(), page: pageOf(days, offset) });
    }
    if (payload.operation === "session.detail") {
      if (failDetailOnce) { failDetailOnce = false; return err(requestId, "revision_changed"); }
      const index = Number.parseInt(String(payload.id).slice(3), 16) - 1;
      const row = sessionRow(index, days);
      if (!row || row.id !== payload.id) return err(requestId, "session_unavailable");
      return ok(requestId, { ...envelope(), detail: { ...row, cost: { cost_minor: null, status: "unavailable", reason: "unpriced", has_unresolved: true, complete: false, breakdown: [] },
        task_excerpts: [{ role: "user_first", text: "Fix the loading indicator", provenance: "verbatim", is_excerpt: true }], excerpt_scope: "session_lifetime_not_window" } });
    }
    return err(requestId, "city_method_unavailable");
  }
  return {
    handleRequest, releaseLaterPages: () => { releaseLaterPages(); laterPages = null; },
    simulateBackgroundWrite() { revision += 1; snapshot = handle("sr", 0x111); context = handle("sr", 0x222); failDetailOnce = true; },
  };
}

function servePlugin(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const file = path.normalize(url.pathname === "/" ? "/index.html" : url.pathname);
    const full = path.join(root, file);
    if (!full.startsWith(root) || !existsSync(full) || statSync(full).isDirectory()) { res.writeHead(404); res.end("missing"); return; }
    res.writeHead(200, { "content-type": mime(full), "cache-control": "no-store" });
    createReadStream(full).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

async function waitFor(page, predicate, timeout = 180_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await page.evaluate(predicate).catch((error) => ({ error: String(error) }));
    if (last && last.ok) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`timeout waiting for probe: ${JSON.stringify(last)}`);
}

async function screenshot(page, name) {
  const file = path.join(outDir, name);
  const target = page.locator(".city-app").first();
  if (await target.count()) await target.screenshot({ path: file, timeout: 120_000, animations: "disabled" });
  else await page.screenshot({ path: file, timeout: 120_000, animations: "disabled" });
  return file;
}

function probeFn() {
  const probe = window.__AV_CITY_PROBE__?.();
  if (!probe) return { ok: false, missing: true };
  return { ok: true, ...probe };
}

async function runPlaywright() {
  if (!existsSync(path.join(pluginDir, "index.html"))) {
    throw new Error(`plugin assets missing at ${pluginDir} (build the desktop bundle or pass --plugin-dir)`);
  }
  const require = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"));
  const { chromium } = require("playwright");
  const { server, origin } = await servePlugin(pluginDir);
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
  });
  const checks = {};
  const host = createV3Host();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("__clickthroughInvoke", async (command, args) => {
    if (command === "plugin_message") return { version: 1, requestId: "", ok: true, result: null, error: null };
    if (command === "plugin_request") return host.handleRequest(args.request);
    throw new Error(`unexpected_command:${command}`);
  });
  await page.addInitScript(() => {
    window.__AV_PLUGIN_INSTANCE__ = "linux-clickthrough";
    window.__AV_PLUGIN_LOCALE__ = "zh-Hans";
    window.__TAURI__ = { core: { invoke: (command, args) => window.__clickthroughInvoke(command, args) } };
  });
  const t0 = Date.now();
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  const first = await waitFor(page, () => {
    const probe = window.__AV_CITY_PROBE__?.();
    if (!probe?.firstModelFrame || !probe.scene?.occupantCount) return { ok: false, stage: probe?.cityLoad, returned: probe?.coverage?.returned, occupants: probe?.scene?.occupantCount };
    return { ok: true, ...probe };
  }, 240_000);
  const firstPaintMs = Date.now() - t0;
  await page.locator(".city-summary-trigger").click({ timeout: 5_000 }).catch(() => {});
  const firstShot = await screenshot(page, "01-v3-first-paint.png");
  await page.locator(".city-summary-trigger").click({ timeout: 2_000 }).catch(() => {});
  const near = (a, b, eps = 2) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= eps);
  let settled = first.scene.camera;
  for (let step = 0; step < 24; step += 1) {
    await page.waitForTimeout(250);
    const cam = (await page.evaluate(probeFn)).scene?.camera;
    if (cam && near(cam.position, settled.position, 0.2) && near(cam.target, settled.target, 0.2)) { settled = cam; break; }
    if (cam) settled = cam;
  }
  checks.defaultV3FirstPage = {
    pass: first.protocol === "v3" && first.search === "" && first.hasV3Context === true
      && first.coverage?.returned === PAGE && first.coverage?.total === TOTAL && first.coverage?.truncated === true
      && first.scene.occupantCount > 0 && first.scene.lastApplyMode === "mount",
    protocol: first.protocol, search: first.search, coverage: first.coverage,
    occupants: first.scene.occupantCount, scaleTier: first.scene.scaleTier, applyMode: first.scene.lastApplyMode,
    firstPaintMs, screenshot: firstShot,
  };
  const firstIds = Object.keys(first.scene.positions).slice(0, 40);
  const firstPositions = Object.fromEntries(firstIds.map((id) => [id, first.scene.positions[id]]));
  const firstCamera = settled;
  const hoverId = firstIds[1] ?? firstIds[0];
  const selectId = firstIds[0];
  await page.evaluate(({ hoverId, selectId }) => {
    window.__AV_CITY_SET_HOVERED__?.(hoverId);
    window.__AV_CITY_SELECT__?.(selectId);
  }, { hoverId, selectId });
  await page.waitForTimeout(300);
  host.releaseLaterPages();
  const full = await waitFor(page, () => {
    const probe = window.__AV_CITY_PROBE__?.();
    if (!probe?.firstModelFrame || probe.coverage?.returned !== 4000) return { ok: false, returned: probe?.coverage?.returned, occupants: probe?.scene?.occupantCount };
    return { ok: true, ...probe };
  }, 180_000);
  const fullLoadMs = Date.now() - t0;
  const fullShot = await screenshot(page, "02-v3-full-load.png");
  const moved = firstIds.filter((id) => {
    const prev = firstPositions[id], next = full.scene.positions[id];
    return !next || next.x !== prev.x || next.z !== prev.z;
  });
  checks.laterPagesAppendStable = {
    pass: full.scene.scaleTier === first.scene.scaleTier && moved.length === 0
      && full.scene.occupantCount >= first.scene.occupantCount && full.scene.lastApplyMode === "append"
      && near(full.scene.camera.position, firstCamera.position) && near(full.scene.camera.target, firstCamera.target),
    firstOccupants: first.scene.occupantCount, fullOccupants: full.scene.occupantCount,
    scaleTier: full.scene.scaleTier, applyMode: full.scene.lastApplyMode, moved: moved.slice(0, 8),
    cameraFirst: firstCamera, cameraFull: full.scene.camera, fullLoadMs, screenshot: fullShot,
  };
  const persist = await page.evaluate(probeFn);
  checks.hoverSelectionCameraPersist = {
    pass: persist.selected === selectId && persist.scene?.hoveredId === hoverId
      && near(persist.scene.camera.position, firstCamera.position) && near(persist.scene.camera.target, firstCamera.target),
    selected: persist.selected, hovered: persist.scene?.hoveredId,
    camera: persist.scene?.camera, screenshot: await screenshot(page, "03-hover-selection-persist.png"),
  };
  host.simulateBackgroundWrite();
  await page.getByRole("button", { name: /查看会话详情|View session details/ }).click({ timeout: 15_000 });
  const detail = await page.getByRole("status").filter({ hasText: /正在读取会话详情|Reading session details|用户输入摘录|No excerpts|Fix the loading indicator/ }).first()
    .waitFor({ timeout: 20_000 }).then(() => page.evaluate(probeFn)).catch(() => page.evaluate(probeFn));
  const unavailable = await page.getByText(/详情暂不可用|Details unavailable/).count();
  const recovered = await page.getByText(/Fix the loading indicator|用户输入摘录/).count();
  checks.detailsRecoverAfterWrite = {
    pass: unavailable === 0 && recovered > 0 && detail.details === true,
    unavailable, recovered, screenshot: await screenshot(page, "04-details-recover.png"),
  };
  await context.close();
  const landing = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const landingPage = await landing.newPage();
  await landingPage.exposeFunction("__clickthroughInvoke", async (command, args) => {
    if (command === "plugin_message") return { version: 1, requestId: "", ok: true, result: null, error: null };
    if (command === "plugin_request") return host.handleRequest(args.request);
    throw new Error(`unexpected_command:${command}`);
  });
  await landingPage.addInitScript(() => {
    window.__AV_PLUGIN_INSTANCE__ = "linux-clickthrough-landing";
    window.__AV_PLUGIN_LOCALE__ = "zh-Hans";
    window.__TAURI__ = { core: { invoke: (command, args) => window.__clickthroughInvoke(command, args) } };
  });
  await landingPage.goto(`${origin}/?presentation=landing&windowDays=30`, { waitUntil: "domcontentloaded" });
  const landingProbe = await waitFor(landingPage, () => {
    const probe = window.__AV_CITY_PROBE__?.();
    if (probe?.protocol === "v2" && probe.firstModelFrame) return { ok: true, ...probe };
    return { ok: false, protocol: probe?.protocol, frame: probe?.firstModelFrame, stage: probe?.cityLoad };
  }, 180_000);
  checks.landingStaysV2 = {
    pass: landingProbe.protocol === "v2" && landingProbe.hasV3Context === false && String(landingProbe.search).includes("presentation=landing"),
    protocol: landingProbe.protocol, search: landingProbe.search, coverage: landingProbe.coverage,
    screenshot: await screenshot(landingPage, "05-landing-v2.png"),
  };
  await landing.close();
  const forced = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const forcedPage = await forced.newPage();
  await forcedPage.exposeFunction("__clickthroughInvoke", async (command, args) => {
    if (command === "plugin_message") return { version: 1, requestId: "", ok: true, result: null, error: null };
    if (command === "plugin_request") return host.handleRequest(args.request);
    throw new Error(`unexpected_command:${command}`);
  });
  await forcedPage.addInitScript(() => {
    window.__AV_PLUGIN_INSTANCE__ = "linux-clickthrough-v2";
    window.__AV_PLUGIN_LOCALE__ = "zh-Hans";
    window.__TAURI__ = { core: { invoke: (command, args) => window.__clickthroughInvoke(command, args) } };
  });
  await forcedPage.goto(`${origin}/?cityData=v2`, { waitUntil: "domcontentloaded" });
  const forcedProbe = await waitFor(forcedPage, () => {
    const probe = window.__AV_CITY_PROBE__?.();
    if (probe?.protocol === "v2" && probe.firstModelFrame) return { ok: true, ...probe };
    return { ok: false, protocol: probe?.protocol, frame: probe?.firstModelFrame, stage: probe?.cityLoad };
  }, 180_000);
  checks.forcedV2Works = {
    pass: forcedProbe.protocol === "v2" && String(forcedProbe.search).includes("cityData=v2") && forcedProbe.hasV3Context === false
      && (forcedProbe.coverage?.returned ?? 0) > 0,
    protocol: forcedProbe.protocol, search: forcedProbe.search, coverage: forcedProbe.coverage,
    screenshot: await screenshot(forcedPage, "06-forced-v2.png"),
  };
  await forced.close();
  await browser.close();
  server.close();
  return { checks, firstPaintMs, fullLoadMs, errors };
}

function findDeb() {
  if (nativeDeb) return nativeDeb;
  const dir = path.join(repo, "apps/desktop/src-tauri/target/release/bundle/deb");
  if (!existsSync(dir)) return null;
  const found = spawnSync("bash", ["-lc", `find ${JSON.stringify(dir)} -name '*.deb' | head -1`], { encoding: "utf8" }).stdout.trim();
  return found || null;
}

function runNative(deb) {
  const nativeOut = path.join(outDir, "native");
  mkdirSync(nativeOut, { recursive: true });
  const extract = path.join(nativeOut, "pkg");
  spawnSync("rm", ["-rf", extract], { stdio: "ignore" });
  mkdirSync(extract, { recursive: true });
  execFileSync("dpkg-deb", ["-x", deb, extract]);
  const bin = spawnSync("bash", ["-lc", `find ${JSON.stringify(extract)} -type f -name agent-vitals-menubar | head -1`], { encoding: "utf8" }).stdout.trim();
  if (!bin) return { pass: false, reason: "menubar_binary_missing", deb };
  const home = path.join(nativeOut, "home");
  spawnSync("rm", ["-rf", home], { stdio: "ignore" });
  mkdirSync(home, { recursive: true });
  const seed = spawnSync("cargo", ["run", "-p", "agent-vitals-query", "--example", "seed_city_home", "--", home, "4101"], {
    cwd: repo, encoding: "utf8", timeout: 120_000,
  });
  const display = ":93";
  const env = {
    ...process.env, DISPLAY: display, AGENT_VITALS_HOME: home, GDK_BACKEND: "x11",
    WEBKIT_DISABLE_COMPOSITING_MODE: "1", LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe",
    WEB_GL_ALLOW_SOFTWARE: "1", WEBKIT_DISABLE_SANDBOX: "1", NO_AT_BRIDGE: "1",
  };
  const xvfb = spawn("Xvfb", [display, "-screen", "0", "1400x900x24", "-ac"], { stdio: "ignore" });
  const ffmpeg = spawn("ffmpeg", ["-y", "-f", "x11grab", "-video_size", "1400x900", "-i", display,
    "-t", "90", "-an", path.join(nativeOut, "native-workbench.mp4")], { stdio: "ignore" });
  let app;
  try {
    spawnSync("sleep", ["1"]);
    app = spawn("dbus-run-session", ["--", bin, "--show-workbench"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const log = [];
    app.stdout.on("data", (chunk) => log.push(chunk.toString()));
    app.stderr.on("data", (chunk) => log.push(chunk.toString()));
    spawnSync("sleep", ["8"]);
    const wid = spawnSync("xdotool", ["search", "--name", "Oh Agent"], { env, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).pop();
    if (wid) {
      spawnSync("xdotool", ["windowactivate", "--sync", wid], { env });
      spawnSync("xdotool", ["mousemove", "--window", wid, "56", "155", "click", "1"], { env });
    }
    spawnSync("sleep", ["6"]);
    const overview = path.join(nativeOut, "07-native-workbench.png");
    spawnSync("bash", ["-lc", `import -display ${display} -window root ${JSON.stringify(overview)}`], { env, encoding: "utf8" });
    if (wid) spawnSync("xdotool", ["mousemove", "--window", wid, "56", "155", "click", "1"], { env });
    spawnSync("sleep", ["25"]);
    const cityShot = path.join(nativeOut, "08-native-city.png");
    const grabbed = spawnSync("bash", ["-lc", `import -display ${display} -window root ${JSON.stringify(cityShot)}`], { env, encoding: "utf8" });
    writeFileSync(path.join(nativeOut, "native.log"), log.join(""));
    const appLog = path.join(home, "logs/app.log");
    if (existsSync(appLog)) spawnSync("cp", [appLog, path.join(nativeOut, "app.log")]);
    const diagSrc = "/tmp/agent-vitals-plugin-diagnostics.json";
    let diagnostics = null;
    if (existsSync(diagSrc)) {
      spawnSync("cp", [diagSrc, path.join(nativeOut, "diag.json")]);
      try { diagnostics = JSON.parse(readFileSync(diagSrc, "utf8")); } catch {}
    }
    const pluginReady = diagnostics?.ready === true;
    const pluginWebview = pluginReady ? "ready" : (existsSync(cityShot) ? "opened" : "missing");
    return {
      pass: existsSync(overview) && app.exitCode == null && pluginReady, screenshot: existsSync(overview) ? overview : null,
      cityScreenshot: existsSync(cityShot) ? cityShot : null,
      binary: bin, seed: seed.status, seedOut: (seed.stdout || "") + (seed.stderr || ""),
      import: grabbed.status, log: path.join(nativeOut, "native.log"), windowId: wid || null,
      recording: existsSync(path.join(nativeOut, "native-workbench.mp4")) ? path.join(nativeOut, "native-workbench.mp4") : null,
      pluginWebview, diagnostics: diagnostics ? { ready: diagnostics.ready, codes: (diagnostics.events || []).map((e) => e.code) } : null,
      note: "Playwright cannot attach to WebKitGTK. Native xvfb smoke launches the packaged binary, seeds 4101 sessions, and clicks City. Success is plugin diagnostics ready=true (toolbar_updated / view_load), not a 3D first-paint wait.",
    };
  } finally {
    try { app?.kill("SIGTERM"); } catch {}
    try { ffmpeg.kill("SIGINT"); } catch {}
    try { xvfb.kill("SIGTERM"); } catch {}
    spawnSync("sleep", ["1"]);
    try { app?.kill("SIGKILL"); } catch {}
    try { ffmpeg.kill("SIGKILL"); } catch {}
    try { xvfb.kill("SIGKILL"); } catch {}
  }
}

mkdirSync(outDir, { recursive: true });
const previousReport = existsSync(path.join(outDir, "report.json")) ? JSON.parse(readFileSync(path.join(outDir, "report.json"), "utf8")) : null;
const previousPlaywrightFile = path.join(outDir, "playwright-results.json");
const previousPlaywright = existsSync(previousPlaywrightFile)
  ? JSON.parse(readFileSync(previousPlaywrightFile, "utf8"))
  : previousReport?.playwright;
const playwright = nativeOnly ? previousPlaywright ?? { checks: {}, skipped: true } : await runPlaywright();
if (!playwright.skipped) writeFileSync(previousPlaywrightFile, JSON.stringify(playwright, null, 2));
const report = {
  generated_at: new Date().toISOString(),
  pluginDir, outDir,
  playwright,
  native: skipNative ? { skipped: true } : (() => {
    const deb = findDeb();
    if (!deb) return { skipped: true, reason: "deb_not_found" };
    try { return { deb, ...runNative(deb) }; }
    catch (error) { return { pass: false, deb, error: String(error) }; }
  })(),
};
writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
const failed = Object.entries(playwright.checks || {}).filter(([, check]) => check && !check.pass).map(([name]) => name);
console.log(JSON.stringify({ outDir, firstPaintMs: playwright.firstPaintMs, fullLoadMs: playwright.fullLoadMs, failed, native: report.native.skipped ? "skipped" : report.native.pass }, null, 2));
process.exit(failed.length ? 1 : 0);
