#!/usr/bin/env node
// Browser regression uses the same iframe/postMessage adapter as dev:browser.
// Native process isolation is tested separately, never inferred from iframe tests.
//
// macOS 使用新版 headless Chromium + Metal，避免旧 headless shell 的 CPU
// SwiftShader 持续占满 GPU 进程。保留真实场景、交互与超时断言；初始化定位器
// 接受系统语言（英文/中文）。失败诊断有独立上限，不能再把原始错误挂住。
import assert from "node:assert/strict";
import { readFile, cp, mkdtemp, readdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"));
const { chromium } = require("playwright");
const { buildSync } = require("esbuild");
const fixtureRegistry = JSON.parse(await readFile(path.join(repo, "apps/desktop/plugins.json"), "utf8"));
fixtureRegistry.plugins.push({ id: "metrics", name: "Metrics", entry: "plugins/Metrics.plugin/ui/index.html", commandNamespace: "metrics" });
const fixtureCode = buildSync({ entryPoints: [path.join(repo, "fixtures/plugins/metrics/main.ts")], bundle: true, write: false, format: "iife" }).outputFiles[0].text;
const filmCode = buildSync({ entryPoints: [path.join(repo, "fixtures/plugins/city-film/main.ts")], bundle: true,
  write: false, format: "iife", loader: { ".jpg": "dataurl", ".glb": "dataurl" },
  nodePaths: [path.join(repo, "apps/agent-city/ui/node_modules")] }).outputFiles[0].text;
if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/verify-react-city-runtime.mjs [--recovery-only | --film-only | --features-only]");
  process.exit(0);
}
const dist = await mkdtemp(path.join(os.tmpdir(), "agent-city-browser-dist-"));
await cp(path.join(repo, "apps/desktop/src-tauri/ui-react-dist"), dist, { recursive: true });
const filmWorkerAsset = (await readdir(path.join(dist, "plugins/AgentCity.plugin/ui/assets"))).find((name) => /^film\.worker-.*\.js$/.test(name));
assert.ok(filmWorkerAsset, "production background film worker must be packaged");
const mimeTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".glb": "model/gltf-binary" };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/film-test.js") {
      response.setHeader("Content-Type", "text/javascript"); response.end(filmCode); return;
    }
    if (pathname === "/film-test.html") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<html><body><button>Test UI interaction</button><div style="width:96px;height:54px"><canvas style="width:100%;height:100%"></canvas></div><script>window.filmWorkerUrl='/plugins/AgentCity.plugin/ui/assets/${filmWorkerAsset}';</script><script src="/film-test.js"></script></body></html>`); return;
    }
    if (pathname === "/plugins/Metrics.plugin/ui/index.html") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<html><body><script>${fixtureCode.replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
      return;
    }
    const file = path.resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${dist}${path.sep}`)) { response.writeHead(403).end(); return; }
    response.setHeader("Content-Type", mimeTypes[path.extname(file)] ?? "application/octet-stream");
    const content = await readFile(file);
    response.end(file === path.join(dist, "index.html")
      ? content.toString().replace(/window\.__AV_PLUGIN_REGISTRY__=.*?;/, `window.__AV_PLUGIN_REGISTRY__=${JSON.stringify(fixtureRegistry)};`).replace("<head>", '<head><script src="/tauri-mock.js"></script><script src="/browser-plugin-host.js"></script>') : content);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, lastPage;

async function openWorkbench({ noWebGL = false, failModule = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  lastPage = page;
  // Native plugin fault deadlines remain 5s/15s and are tested separately.
  page.setDefaultTimeout(45000);
  const errors = [];
  page.testErrors = errors;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (failModule && /\/plugins\/AgentCity.plugin\/ui\/assets\/index-[^/]+\.js$/.test(url)) return route.fulfill({ status: 404, body: "" });
    return url.startsWith(origin) ? route.continue() : route.abort();
  });
  await page.addInitScript(({ noWebGL, failModule }) => {
    window.cityDrawCalls = 0;
    window.citySurface = { resets: 0, undrawnFrames: 0, pending: false };
    for (const dimension of ["width", "height"]) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension);
      Object.defineProperty(HTMLCanvasElement.prototype, dimension, {
        ...descriptor,
        set(value) {
          if (this.classList.contains("city-canvas")) {
            window.citySurface.resets++;
            window.citySurface.pending = true;
          }
          descriptor.set.call(this, value);
        },
      });
    }
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => raf((time) => {
      callback(time);
      if (window.citySurface.pending) window.citySurface.undrawnFrames++;
    });
    for (const Context of [WebGLRenderingContext, WebGL2RenderingContext]) {
      for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
        const draw = Context.prototype[name];
        if (!draw) continue;
        Context.prototype[name] = function (...args) {
          window.cityDrawCalls += 1;
          const result = draw.apply(this, args);
          if (this.canvas.classList.contains("city-canvas")) window.citySurface.pending = false;
          return result;
        };
      }
    }
    if (noWebGL) {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        return /webgl/.test(type) ? null : getContext.call(this, type, ...args);
      };
    }
    if (window.parent !== window) return;
    window.cityTest = { mode: "ready", rejectDays: null, delayDays: null, calls: [] };
    window.__AV_BROWSER_PROVIDERS__ = {};
    window.__AV_BROWSER_PROVIDERS__.city = async (request) => {
      if (request.payload.projection === "city-settings") {
        if (request.payload.action === "write") window.cityTest.seed = request.payload.seed;
        return { seed: window.cityTest.seed ?? 74031 };
      }
      const days = request.payload.windowDays;
      const { mode, rejectDays, delayDays } = window.cityTest;
      window.cityTest.calls.push(days);
      if (days === delayDays) await new Promise((resolve) => setTimeout(resolve, 300));
      if (mode === "error" || days === rejectDays) throw new Error("synthetic_failure");
      const from = { 7: "2026-09-27T00:00:00Z", 30: "2026-09-03T00:00:00Z", 90: "2026-07-06T00:00:00Z", 366: "2025-10-03T00:00:00Z" }[days];
      const sessions = mode === "empty" || mode === "unavailable" ? [] : [
        { id: "fixture-session-001", harness: "codex", first_event_at: "2026-10-02T09:10:00Z", last_event_at: "2026-10-02T09:42:00Z", tokens: { input: 12400, output: 3100, total: 15500 }, task_excerpts: [{ role: "user_first", text: "合成测试：修复登录界面", provenance: "verbatim", is_excerpt: true }] },
        { id: "fixture-session-002", harness: "claude_code", first_event_at: "2026-09-28T14:05:00Z", last_event_at: "2026-09-28T14:51:00Z", tokens: { input: 8700, output: 2200, total: 10900 } },
        { id: "fixture-session-003", harness: "codex", first_event_at: "2026-09-17T07:20:00Z", last_event_at: "2026-09-17T08:02:00Z", tokens: { input: 22100, output: 5400, total: 27500 } },
      ].filter((session) => session.first_event_at >= from);
      return { protocol: "city:v2", source: "fixture", harnesses: [{ id: "codex", display_name: "Codex", capabilities: { session_statistics: { available: true }, findings: { available: true, reason: null } } }, { id: "claude_code", display_name: "Claude Code", capabilities: { session_statistics: { available: true }, findings: { available: true, reason: null } } }], generated_at: "2026-10-03T12:00:00Z", window: { days, label: `最近 ${days} 天`, from, to: "2026-10-03T00:00:00Z" }, sessions: mode === "malformed" ? null : sessions, findings: mode === "malformedEffect" ? null : [], coverage: { total: sessions.length, returned: sessions.length, truncated: false, unknown_time: 0 }, status: mode.startsWith("malformed") ? "ready" : mode };
    };
  }, { noWebGL, failModule });
  await page.goto(origin);
  await page.locator(".sidebar").getByRole("button", { name: /^(Overview|总览)$/ }).waitFor();
  await page.evaluate(async () => {
    await window.__TAURI__.core.invoke("save_ui_language_config", { language: "zh-Hans" });
    localStorage.setItem("agent-vitals.language", "zh-Hans");
    window.dispatchEvent(new Event("agent-vitals-language-changed"));
  });
  await page.locator(".sidebar").getByRole("button", { name: "City", exact: true }).click();
  if (failModule) await page.getByRole("alert").filter({ hasText: "City 暂不可用" }).waitFor();
  else {
    // Header may be position:absolute and not "visible" to Playwright after the
    // scene-first HUD restructure — wait for the canvas or any city content instead.
    await page.frameLocator("iframe").locator(".city-canvas, .city-legend").first().waitFor({ state: noWebGL ? "attached" : "visible" });
    // Interaction regression starts in the product's eco mode.
    // 画质下拉在城市插件的设置对话框内（iframe），不在宿主工具栏——经 更多工具→城市设置 进入。
    if (!noWebGL) {
      await page.getByRole("button", { name: "更多工具", exact: true }).click();
      await page.getByRole("button", { name: "城市设置", exact: true }).click();
      const settings = city(page).getByRole("dialog", { name: "城市设置", exact: true });
      await settings.getByLabel("画质", { exact: true }).selectOption("eco");
      await settings.getByRole("button", { name: "关闭城市设置", exact: true }).click();
      // 收起展开的更多工具菜单：按钮标签切到 plugin.less，不收起会让后续「更多工具」定位失败。
      await page.getByRole("button", { name: "收起工具", exact: true }).click();
    }
  }
  return { page, errors };
}

function city(page) { return page.frameLocator("iframe"); }
async function openCitySettings(page) {
  const more = page.getByRole("button", { name: "更多工具", exact: true });
  if (await more.count()) await more.click();
  await page.getByRole("button", { name: "城市设置", exact: true }).click();
  return city(page).getByRole("dialog", { name: "城市设置", exact: true });
}
async function setCityWindow(page, days) {
  const settings = await openCitySettings(page);
  await settings.getByLabel("时间范围", { exact: true }).selectOption(String(days));
  await settings.press("Escape");
}
async function setCityLabels(page, visible) {
  const settings = await openCitySettings(page);
  await settings.getByLabel("显示建筑标签", { exact: true }).setChecked(visible);
  await settings.press("Escape");
}
async function cityLabelsVisible(page) {
  const settings = await openCitySettings(page);
  const visible = await settings.getByLabel("显示建筑标签", { exact: true }).isChecked();
  await settings.press("Escape");
  return visible;
}
async function cityStatus(page) {
  const toggle = city(page).getByRole("button", { name: "城市摘要", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  return city(page).locator(".city-legend p").first();
}
/** iframe 会被宿主重建（错误恢复/失效刷新）：跨步骤持有的 frame 句柄可能失效。
 *  对 iframe 内状态读写与条件等待一律经本助手——按需重取、失效重试（最长 5s），
 *  条件等待以轮询 Promise 表达（等价 waitForFunction 语义，重建风暴下仍收敛）。 */
async function cityEvaluate(page, fn, arg) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const frame = page.frames().find((item) => item.url().includes("AgentCity.plugin"));
    if (frame) {
      try { return await frame.evaluate(fn, arg); }
      catch (error) { lastError = error; }
    }
    await page.waitForTimeout(500);
  }
  throw lastError ?? new Error("city iframe never became available");
}
/** 轮询等待（waitForFunction 的重建安全版）：fn 返回真值即完成。 */
async function cityWaitFor(page, fn, timeoutMs = 20000, arg) {
  const started = Date.now();
  for (;;) {
    const value = await cityEvaluate(page, fn, arg);
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("cityWaitFor timeout");
    await page.waitForTimeout(250);
  }
}
async function expectSummary(page, sessions, tokens) {
  // Readiness must not require opening an optional panel or changing its state.
  try { await page.waitForFunction(({ sessions, tokens }) => {
    const frame = document.querySelector("iframe");
    const trigger = frame?.contentDocument?.querySelector(".city-summary-trigger");
    const locale = frame?.contentWindow?.__AV_PLUGIN_LOCALE__ === "en" ? "en-US" : "zh-CN";
    const compact = (value) => value === "—" ? value : new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 2 }).format(Number(value.replaceAll(",", "")));
    const expected = `${compact(sessions)} ${locale === "en-US" ? "sessions" : "会话"} · ${compact(tokens)} tokens`;
    return trigger?.querySelector("span")?.textContent === expected;
  }, { sessions, tokens }, { timeout: 45_000 }); }
  catch (error) {
    console.error("city summary did not show expected data (sessions=" + sessions + ")");
    throw error;
  }
}

try {
  browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--use-angle=metal"] });
  if (process.argv.includes("--film-only")) {
    const filmPage = await browser.newPage();
    const gpuErrors = [];
    filmPage.on("console", (message) => {
      if (/GL_INVALID_OPERATION|Film draw error/.test(message.text())) gpuErrors.push(message.text());
      if (message.type() === "error" || message.type() === "warning") console.error("Film fixture:", message.text());
    });
    await filmPage.goto(`${origin}/film-test.html`);
    const result = filmPage.evaluate(() => window.runCityFilmTest()).then((film) => ({ film }), (error) => ({ error }));
    const first = await Promise.race([result, filmPage.waitForFunction(() => window.filmProgress > 0).then(() => null)]);
    if (first?.error) throw first.error;
    if (first?.film) throw new Error("film completed before UI interaction test");
    await filmPage.getByRole("button", { name: "Test UI interaction" }).click({ timeout: 2000, noWaitAfter: true });
    const completed = await result;
    if (completed.error) throw completed.error;
    const film = completed.film;
    assert.equal(film.renderErrors, 0, "interactive scene must draw without WebGL errors");
    assert.deepEqual(gpuErrors, [], "foreground and export worker must draw without invalid buffer errors");
    assert.equal(film.signature, "ftyp");
    assert.equal(film.type, "video/mp4");
    assert.ok(film.bytes > 1024 && film.frames > 10 && film.pulses > 10);
    assert.ok(film.uiFrames > 10 && film.uiResponsive, "interactive renderer and button must remain alive during export");
    assert.equal(film.width, 320); assert.equal(film.height, 180);
    assert.ok(Number.isFinite(film.duration) && film.duration > 10);
    console.log("City real MP4 encode/decode:", JSON.stringify(film));
    await filmPage.close();
  } else {
  const { page, errors } = await openWorkbench();
  console.log("City browser fixture: initialized.");
  await expectSummary(page, "3", "53,900");
  let frame = page.frames().find((item) => item.url().includes("AgentCity.plugin"));
  const layout = await frame.evaluate(() => {
    const panel = document.querySelector(".city-app");
    const canvas = document.querySelector(".city-canvas");
    return { panel: panel.getBoundingClientRect().toJSON(), canvas: canvas.getBoundingClientRect().toJSON(), background: getComputedStyle(panel).backgroundColor, canvasPosition: getComputedStyle(canvas).position };
  });
  const main = await page.locator("main.plugin-main-content").boundingBox();
  assert.ok(Math.abs(layout.panel.width - main.width) < 1, "City must fill the host tab width");
  assert.ok(layout.panel.height > 500, "City must have a visible scene height");
  assert.equal(layout.canvasPosition, "absolute", "City CSS must ship with the module");
  assert.ok(Math.abs(layout.canvas.width - layout.panel.width) < 1);
  assert.equal(await city(page).getByRole("status").count(), 0, "WebGL must initialize normally");
  await frame.waitForFunction(() => window.cityDrawCalls > 0);
  assert.equal(await city(page).locator(".city-legend").count(), 0, "districts are disclosed on demand");
  assert.equal(await city(page).locator(".city-replay-controls").count(), 0, "replay starts compact");
  await city(page).getByRole("button", { name: "城市摘要", exact: true }).click();
  await city(page).locator(".city-legend button").first().click();
  await city(page).getByRole("button", { name: "时间回放", exact: true }).click();
  await city(page).getByRole("button", { name: "播放回放", exact: true }).click();
  await city(page).getByRole("button", { name: "暂停回放", exact: true }).click();
  await city(page).getByRole("button", { name: "回到实时", exact: true }).click();
  await page.getByRole("button", { name: "更多工具", exact: true }).click();
  await page.getByRole("button", { name: "城市设置", exact: true }).click();
  const settings = city(page).getByRole("dialog", { name: "城市设置", exact: true });
  await settings.getByLabel("岛屿种子", { exact: true }).fill("12345");
  await settings.getByRole("button", { name: "应用种子", exact: true }).click();
  await page.waitForFunction(() => window.cityTest.seed === 12345);
  console.log("City browser fixture: seed persisted through the injected provider.");
  await settings.getByLabel("选择会话（键盘入口）", { exact: true }).selectOption("fixture-session-001");
  await city(page).getByRole("button", { name: "查看会话详情", exact: true }).click();
  await city(page).getByRole("dialog", { name: "会话详情", exact: true }).getByText("合成测试：修复登录界面", { exact: true }).waitFor();
  await city(page).getByRole("button", { name: "关闭会话详情", exact: true }).click();
  await city(page).getByRole("button", { name: "关闭建筑详情", exact: true }).click();
  const photoDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "拍照", exact: true }).click();
  const photo = await photoDownload;
  assert.ok(photo.suggestedFilename().endsWith(".png"));
  assert.equal(await photo.failure(), null);
  const photoBytes = await readFile(await photo.path());
  assert.equal(photoBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(photoBytes.length > 1024, "photo must contain actual rendered pixels");
  const softwarePhoto = await frame.evaluate(() => {
    const gl = document.querySelector(".city-canvas").getContext("webgl2");
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return !!info && /swiftshader|llvmpipe|software|softpipe/i.test(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)));
  });
  if (softwarePhoto) assert.ok(photoBytes.readUInt32BE(16) <= 640 && photoBytes.readUInt32BE(20) <= 360, "software PNG must use bounded actual dimensions");
  await page.getByRole("button", { name: "拍照", exact: true }).waitFor();
  if (await page.getByRole("button", { name: "导出视频", exact: true }).isEnabled()) {
    await page.getByRole("button", { name: "导出视频", exact: true }).click();
    await city(page).locator(".city-export-preview").waitFor();
    assert.equal(await page.getByRole("button", { name: "拍照", exact: true }).isEnabled(), false, "photo and film saves must not overlap");
    await page.getByRole("button", { name: "城市设置", exact: true }).click();
    await settings.getByRole("status").waitFor();
    await settings.press("Escape");
    await city(page).locator(".city-export-preview").waitFor();
    await page.getByRole("button", { name: /^取消导出 · \d+%$/ }).waitFor();
    // Commands acknowledge acceptance separately from DOM updates. Wait for that
    // acknowledgement instead of racing the next click against host pending.
    await page.getByRole("button", { name: "重置视角", exact: true }).click({ timeout: 5000, noWaitAfter: true });
    await page.waitForFunction(async () => !(await window.__TAURI__.core.invoke("plugin_snapshot")).pending);
    await setCityLabels(page, false);
    assert.equal(await cityLabelsVisible(page), false, "labels must stay hidden");
    await setCityLabels(page, true);
    assert.equal(await cityLabelsVisible(page), true, "labels must be visible");
    await city(page).getByRole("button", { name: "播放回放", exact: true }).click({ timeout: 5000, noWaitAfter: true });
    await city(page).getByRole("button", { name: "暂停回放", exact: true }).click({ timeout: 5000, noWaitAfter: true });
    await city(page).getByRole("button", { name: "回到实时", exact: true }).click({ timeout: 5000, noWaitAfter: true });
    await setCityWindow(page, "7");
    await expectSummary(page, "2", "26,400");
    await city(page).getByRole("button", { name: "取消导出", exact: true }).click();
    await city(page).locator(".city-export-preview").waitFor({ state: "hidden" });
    await setCityWindow(page, "30");
    await expectSummary(page, "3", "53,900");
  }
  // 修复城市入口在「更多工具」里：点宿主工具栏按钮必须真的打开编辑面板，并且工具项变成「退出修复」。
  {
    const more = page.getByRole("button", { name: "更多工具", exact: true });
    if (await more.count()) await more.click();
    await page.getByRole("button", { name: /^修复(城市|规划)$/ }).click();
    await city(page).getByRole("region", { name: "规划修复" }).waitFor({ timeout: 8000 });
    if (process.env.CITY_REPAIR_SHOT) await page.screenshot({ path: process.env.CITY_REPAIR_SHOT });
    if (await more.count()) await more.click();
    await page.getByRole("button", { name: "退出修复", exact: true }).click();
    await city(page).getByRole("region", { name: "规划修复" }).waitFor({ state: "hidden", timeout: 8000 });
  }
  console.log("City restored interactions: passed (district focus, replay, persistent seed, keyboard selection, excerpts, PNG download, film cancellation).");
  if (process.argv.includes("--features-only")) {
    const screenshotPath = path.join(dist, "city-restored.png");
    await page.screenshot({ path: screenshotPath });
    console.log(`City restored screenshot: ${screenshotPath}`);
    await page.close();
  } else {
  await setCityLabels(page, false);
  assert.equal(await cityLabelsVisible(page), false, "labels must stay hidden");
  await setCityLabels(page, true);
  await page.getByRole("button", { name: "重置视角", exact: true }).click();
  await page.getByRole("button", { name: "航拍", exact: true }).click();
  await page.getByRole("button", { name: "停止航拍", exact: true }).click();
  await page.waitForFunction(async () => {
    const snapshot = await window.__TAURI__.core.invoke("plugin_snapshot");
    return snapshot?.status === "ready" && !snapshot.pending && snapshot.items.some((item) => item.id === "cinema" && item.label === "航拍");
  });
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForFunction(() => {
    const slot = document.querySelector(".native-plugin-slot")?.getBoundingClientRect();
    const frame = document.querySelector("iframe")?.getBoundingClientRect();
    return slot && frame && Math.abs(slot.width - frame.width) < 1 && Math.abs(slot.height - frame.height) < 1;
  });
  // Regression for resize callbacks clearing a canvas AFTER the render rAF.
  // iframe 可能已被宿主重建（错误恢复）：本段起全部经 cityEvaluate/cityWaitFor。
  await cityEvaluate(page, () => { window.citySurface.undrawnFrames = 0; window.citySurface.resets = 0; });
  for (const [width, height] of [[960, 680], [1200, 820], [1040, 740], [980, 710], [1100, 760]]) {
    await page.setViewportSize({ width, height });
    await cityWaitFor(page, () => {
      const canvas = document.querySelector(".city-canvas");
      if (!canvas || !canvas.parentElement) return false;
      const gl = canvas.getContext("webgl2"), info = gl.getExtension("WEBGL_debug_renderer_info");
      const software = !!info && /swiftshader|llvmpipe|software|softpipe/i.test(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)));
      const width = canvas.parentElement.clientWidth, height = canvas.parentElement.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 1, software ? Math.min(640 / width, 360 / height) : Infinity);
      return canvas.width === Math.floor(width * ratio) && canvas.height === Math.floor(height * ratio);
    });
  }
  const surface = await cityEvaluate(page, () => window.citySurface);
  assert.ok(surface && surface.resets > 0, "continuous resize must actually resize the drawing buffer");
  assert.equal(surface.undrawnFrames, 0, "buffer resets must be drawn before the rAF callback yields");
  const contextRecovery = await cityEvaluate(page, async () => {
    const canvas = document.querySelector(".city-canvas");
    const extension = canvas.getContext("webgl2").getExtension("WEBGL_lose_context");
    if (!extension) return false;
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("context_restore_timeout")), 10_000);
      canvas.addEventListener("webglcontextrestored", () => { clearTimeout(deadline); resolve(); }, { once: true });
      canvas.addEventListener("webglcontextlost", () => setTimeout(() => extension.restoreContext(), 250), { once: true });
      extension.loseContext();
    });
    return window.cityDrawCalls;
  });
  assert.notEqual(contextRecovery, false, "software WebGL must expose the loss/recovery test extension");
  await cityWaitFor(page, (before) => window.cityDrawCalls > before, 30000, contextRecovery);
  const cityInstanceBeforeSwitch = await page.evaluate(async () => (await window.__TAURI__.core.invoke("plugin_snapshot")).instanceId);
  await page.evaluate(() => {
    window.pluginResumeRefreshes = 0;
    const invoke = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = (command, args) => {
      if (command === "plugin_invalidate") window.pluginResumeRefreshes += 1;
      return invoke(command, args);
    };
  });
  await cityEvaluate(page, () => { window.cityRetentionMarker = "same-scene"; });
  await setCityLabels(page, false);
  assert.equal(await cityLabelsVisible(page), false, "labels must stay hidden");
  await page.locator(".sidebar").getByRole("button", { name: /^(Overview|总览)$/ }).click();
  await page.waitForFunction(() => document.querySelector("iframe")?.style.display === "none");
  await page.waitForTimeout(300);
  const pausedDraws = await frame.evaluate(() => window.cityDrawCalls);
  await page.waitForTimeout(300);
  assert.equal(await frame.evaluate(() => window.cityDrawCalls), pausedDraws, "hidden City must pause rendering");
  await page.locator(".sidebar").getByRole("button", { name: "City", exact: true }).click();
  assert.equal(await cityLabelsVisible(page), false, "labels must stay hidden");
  assert.equal(await page.evaluate(async () => (await window.__TAURI__.core.invoke("plugin_snapshot")).instanceId), cityInstanceBeforeSwitch);
  assert.equal(await frame.evaluate(() => window.cityRetentionMarker), "same-scene");
  await page.waitForFunction(() => window.pluginResumeRefreshes > 0);
  await frame.waitForFunction((before) => window.cityDrawCalls > before, pausedDraws);
  await setCityLabels(page, true);
  console.log("City tab retention: passed (same instance/scene/settings, hidden rendering paused, resume draws).");
  const summaryToggle = city(page).getByRole("button", { name: "城市摘要", exact: true });
  if (await summaryToggle.getAttribute("aria-expanded") !== "true") await summaryToggle.click();
  const replayToggle = city(page).getByRole("button", { name: "时间回放", exact: true });
  if (await replayToggle.count()) await replayToggle.click();
  await page.evaluate(() => {
    localStorage.setItem("agent-vitals.language", "en");
    window.dispatchEvent(new Event("agent-vitals-language-changed"));
  });
  await page.getByRole("button", { name: "City settings", exact: true }).waitFor();
  await city(page).getByRole("heading", { name: "Harness districts", exact: true }).waitFor();
  await city(page).getByRole("button", { name: "Play replay", exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await window.__TAURI__.core.invoke("plugin_snapshot")).instanceId), cityInstanceBeforeSwitch);
  await page.evaluate(() => {
    localStorage.setItem("agent-vitals.language", "zh-Hans");
    window.dispatchEvent(new Event("agent-vitals-language-changed"));
  });
  await page.getByRole("button", { name: "城市设置", exact: true }).waitFor();
  console.log("City locale propagation: passed (host en/zh changes, toolbar/content update, no instance reload).");
  await page.locator(".sidebar").getByRole("button", { name: "Metrics", exact: true }).click();
  await page.frameLocator("iframe").getByText("Metrics count: 0").waitFor();
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await page.frameLocator("iframe").getByText("Metrics count: 1").waitFor();
  await page.getByRole("button", { name: "Fail fixture", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Metrics 暂不可用" }).waitFor();
  await page.getByRole("alert").getByRole("button", { name: "重试 Metrics" }).click();
  await page.frameLocator("iframe").getByText("Metrics count: 0").waitFor();
  await page.locator(".sidebar").getByRole("button", { name: /^(Overview|总览)$/ }).click();
  await page.waitForFunction(() => document.querySelector("iframe")?.style.display === "none");
  await page.locator(".sidebar").getByRole("button", { name: "City", exact: true }).click();
  await expectSummary(page, "3", "53,900");
  const qualityDialog = await openCitySettings(page);
  await qualityDialog.getByLabel("画质", { exact: true }).selectOption("eco");
  await qualityDialog.getByRole("button", { name: "关闭城市设置", exact: true }).click();
  frame = page.frames().find((item) => item.url().includes("AgentCity.plugin"));
  assert.notEqual(await page.evaluate(async () => (await window.__TAURI__.core.invoke("plugin_snapshot")).instanceId), cityInstanceBeforeSwitch);
  console.log("Second-plugin integration: passed (shared SDK, navigation, load, command, failure/retry, dispose, switch back).");
  await page.evaluate(async () => {
    const before = await window.__TAURI__.core.invoke("plugin_snapshot");
    window.postMessage({ channel: "av-plugin-rpc", version: 1, instanceId: before.instanceId, type: "request", requestId: "forged", command: "plugin_message", args: { message: { version: 1, instanceId: before.instanceId, type: "runtime.error" } } }, location.origin);
  });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(async () => (await window.__TAURI__.core.invoke("plugin_snapshot")).status), "ready", "Messages from the host window, not the active iframe, must be ignored");
  await frame.evaluate(() => window.parent.postMessage({
    channel: "av-plugin-rpc", version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, type: "request", requestId: "malformed-tools", command: "plugin_message",
    args: { message: { version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, type: "toolbar.update", revision: 999999,
      items: [{ id: "broken", label: { invalid: true }, commandId: "city.broken", kind: "select", enabled: true, options: null }] } },
  }, location.origin));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(async () => (await window.__TAURI__.core.invoke("plugin_snapshot")).items.some((item) => item.id === "broken")), false, "Malformed toolbar descriptions must not reach host React rendering");
  await page.evaluate(async () => {
    const before = await window.__TAURI__.core.invoke("plugin_snapshot");
    let rejected = false;
    try { await window.__TAURI__.core.invoke("plugin_open", { pluginId: "city", restart: true, bounds: { x: 0, y: 0, width: -1, height: 100 } }); }
    catch { rejected = true; }
    const after = await window.__TAURI__.core.invoke("plugin_snapshot");
    if (!rejected || after?.instanceId !== before.instanceId) throw new Error("Invalid resize must preserve the current iframe");
  });
  const beforeInvalidation = await page.evaluate(() => window.cityTest.calls.length);
  await page.evaluate(async () => {
    const state = await window.__TAURI__.core.invoke("plugin_snapshot");
    await window.__TAURI__.core.invoke("plugin_invalidate", { instanceId: state.instanceId });
  });
  await page.waitForFunction((count) => window.cityTest.calls.length > count, beforeInvalidation);
  await expectSummary(page, "3", "53,900");
  console.log("Browser toolbar, aerial playback, iframe resize and sender validation: passed.");

  const picker = { selectOption: (days) => setCityWindow(page, days) };
  if (!process.argv.includes("--recovery-only")) {
  await picker.selectOption("7");
  await expectSummary(page, "2", "26,400");
  await picker.selectOption("90");
  await expectSummary(page, "3", "53,900");
  await picker.selectOption("366");
  await expectSummary(page, "3", "53,900");

  await page.evaluate(() => { window.cityTest.mode = "empty"; });
  await picker.selectOption("30");
  await expectSummary(page, "0", "0");
  await city(page).getByRole("status").filter({ hasText: "当前时间范围没有会话" }).waitFor();

  await page.evaluate(() => { window.cityTest.mode = "stale"; });
  await picker.selectOption("7");
  await expectSummary(page, "2", "26,400");
  await (await cityStatus(page)).filter({ hasText: "数据可能已过期" }).waitFor();

  await page.evaluate(() => { window.cityTest.mode = "unavailable"; });
  await picker.selectOption("30");
  await expectSummary(page, "—", "—");
  await city(page).getByRole("status").filter({ hasText: "City 数据不可用" }).waitFor();

  await page.evaluate(() => { window.cityTest.mode = "error"; });
  await picker.selectOption("7");
  await expectSummary(page, "—", "—");
  await city(page).getByRole("status").filter({ hasText: "City 数据暂不可用" }).waitFor();

  await page.evaluate(() => { window.cityTest.mode = "ready"; window.cityTest.rejectDays = 30; window.cityTest.delayDays = 30; });
  await picker.selectOption("30");
  await picker.selectOption("7");
  await expectSummary(page, "2", "26,400");
  await page.waitForTimeout(400);
  assert.match(await (await cityStatus(page)).innerText(), /合成 fixture/, "A superseded request failure must not replace the active result");
  await expectSummary(page, "2", "26,400");

  await page.evaluate(() => { window.cityTest.mode = "malformed"; window.cityTest.rejectDays = null; });
  await picker.selectOption("90");
  await page.getByRole("alert").filter({ hasText: "City 暂不可用" }).waitFor();
  assert.equal(await page.locator(".sidebar").getByRole("button", { name: /^(Overview|总览)$/ }).count(), 1, "A City render failure must preserve host navigation");
  await page.evaluate(() => { window.cityTest.mode = "ready"; });
  await page.locator(".plugin-fallback").getByRole("button", { name: "重试 City", exact: true }).click();
  await expectSummary(page, "3", "53,900");
  try {
    const retrySettings = await openCitySettings(page);
    await retrySettings.getByLabel("画质", { exact: true }).selectOption("eco");
    await retrySettings.getByRole("button", { name: "关闭城市设置", exact: true }).click();
  }
  catch (error) {
    console.error("Host retry diagnostics", JSON.stringify(await page.evaluate(() => ({
      nav: document.querySelector('.nav-item-active')?.textContent,
      toolbar: document.querySelector('.plugin-toolbar')?.textContent, panel: document.querySelector('.plugin-fallback')?.textContent,
    }))));
    throw error;
  }
  await page.evaluate(() => { window.cityTest.mode = "malformedEffect"; });
  await picker.selectOption("90");
  await page.getByRole("alert").filter({ hasText: "City 暂不可用" }).waitFor();
  await page.locator(".sidebar").getByRole("button", { name: /^(Overview|总览)$/ }).click();
  await page.locator(".header-actions").getByRole("button", { name: /^(Refresh|刷新)$/ }).waitFor();
  await page.evaluate(() => { window.cityTest.mode = "ready"; });
  await page.locator(".sidebar").getByRole("button", { name: "City", exact: true }).click();
  await expectSummary(page, "3", "53,900");
  }
  await page.evaluate(() => { window.cityTest.rejectDays = 30; });

  await page.locator(".sidebar").getByRole("button", { name: /^(Overview|总览)$/ }).click();
  assert.equal(await page.locator(".city-app").count(), 0);
  await page.locator(".sidebar").getByRole("button", { name: "City", exact: true }).click();
  await page.evaluate(async () => {
    const current = await window.__TAURI__.core.invoke("plugin_snapshot");
    await window.__TAURI__.core.invoke("plugin_invalidate", { instanceId: current.instanceId });
  });
  await city(page).getByRole("status").filter({ hasText: "City 数据暂不可用" }).waitFor();
  const qualityDialog2 = await openCitySettings(page);
  await qualityDialog2.getByLabel("画质", { exact: true }).selectOption("eco");
  await qualityDialog2.getByRole("button", { name: "关闭城市设置", exact: true }).click();
  await picker.selectOption("7");
  await expectSummary(page, "2", "26,400");
  assert.equal(page.context().pages().length, 1, "City must stay in the host window");
  if (!process.argv.includes("--recovery-only")) assert.ok(errors.length >= 2, "Injected City render/effect faults must actually execute");
  await page.close();

  const fallback = await openWorkbench({ noWebGL: true });
  await expectSummary(fallback.page, "3", "53,900");
  await city(fallback.page).getByRole("status").filter({ hasText: "当前环境无法显示三维城市" }).waitFor();
  assert.equal(await fallback.page.locator(".sidebar").getByRole("button", { name: /^(Overview|总览)$/ }).count(), 1);
  assert.deepEqual(fallback.errors, [], "Unavailable WebGL must not crash the host");
  await fallback.page.close();

  const brokenModule = await openWorkbench({ failModule: true });
  await brokenModule.page.locator(".sidebar").getByRole("button", { name: /^(Overview|总览)$/ }).click();
  assert.equal(await brokenModule.page.locator(".plugin-panel").count(), 0);
  await brokenModule.page.locator(".header-actions").getByRole("button", { name: /^(Refresh|刷新)$/ }).waitFor();
  await brokenModule.page.close();
  console.log("City browser regression: OK (dev:browser iframe/postMessage adapter, packaged CSS, WebGL, toolbar, windows, data states/races, failures/retry). Native isolation is verified separately.");
  }
  }
} catch (error) {
  if (lastPage && !lastPage.isClosed()) console.error("Browser fixture diagnostics", JSON.stringify(await Promise.race([lastPage.evaluate(async () => ({
    snapshot: await window.__TAURI__?.core?.invoke("plugin_snapshot"),
    fallback: document.querySelector(".plugin-fallback")?.textContent,
    url: location.href, body: document.body.innerText.slice(0, 1500),
  })).catch(() => null), new Promise((resolve) => setTimeout(() => resolve({ diagnostics: "page_unresponsive" }), 3000))])));
  console.error("Browser fixture page errors", lastPage?.testErrors ?? []);
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
