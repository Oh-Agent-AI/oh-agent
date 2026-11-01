#!/usr/bin/env node
// Deterministic probe-script contract only. This does not start Tauri or verify pixels.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../apps/desktop/src-tauri/src/plugin_isolation_probe.rs", import.meta.url), "utf8");
const formalSource = source.slice(source.indexOf("fn formal_mecha_exercise("));
const settingsScript = formalSource.match(/host\.eval\(r#"([\s\S]*?)"#\)\.map_err\(\|_\| "formal_settings_failed"\)/)?.[1];
assert.ok(settingsScript, "formal settings probe script not found");
for (const locale of ["zh-Hans", "en"]) {
  let tick;
  let clicked = false;
  const events = [];
  const label = locale === "en" ? "City settings" : "城市设置";
  const button = { textContent: label, disabled: false, click() { clicked = true; } };
  const toolbar = { querySelectorAll() { return [button]; }, querySelector() { return null; } };
  runInNewContext(settingsScript, {
    document: { querySelector(selector) { return selector === ".plugin-toolbar" ? toolbar : null; } },
    window: { __TAURI__: { core: { invoke(_method, { code }) { events.push(code); } } } },
    setInterval(callback) { tick = callback; return 1; }, clearInterval() {}, setTimeout() {},
  });
  tick();
  assert.equal(clicked, true, `${locale}: formal settings were not opened`);
  assert.ok(events.includes("formal_settings_clicked"));
}
const original = source.match(/let entry_script = r#"([\s\S]*?)"#;/)?.[1];
const replacement = source.match(/\.replace\("clearInterval\(timer\); send\('mecha_board_ready'\);[\s\S]*?r#"([\s\S]*?)"#\)/)?.[1];
const target = "clearInterval(timer); send('mecha_board_ready');\n            }\n        },100); setTimeout(()=>clearInterval(timer),160000);";
const phase = "let phase=0, resumeAt=0;";
assert.ok(original?.includes(target) && original.includes(phase) && replacement, "probe instrumentation points changed");
const entry = original.replace(phase, "let phase=3, resumeAt=0, frameStart=null, frameDeadline=0;").replace(target, replacement);

for (const locale of ["zh-Hans", "en"]) for (const scenario of ["advancing", "stalled", "zero-canvas", "missing-clock"]) {
  let now = 0;
  let elapsed = 0;
  let tick;
  let timerActive = false;
  let entryClicked = false;
  const events = [];
  const labels = locale === "en" ? { dialog: "City settings", demo: "Demo", entry: "Mecha tactics" } : { dialog: "城市设置", demo: "演示", entry: "机甲战棋" };
  const document = {
    querySelector(selector) {
      if (selector.includes("dialog")) return selector === `dialog[open][aria-label="${labels.dialog}"]` ? {
        querySelector() { return null; },
        querySelectorAll() { return [{ textContent: labels.entry, disabled: false, click() { entryClicked = true; } }]; },
      } : null;
      if (selector === ".city-coverage-badge") return { textContent: labels.demo };
      if (selector === ".mecha-turn-summary") return {};
      if (selector === "canvas") return { width: scenario === "zero-canvas" ? 0 : 800, height: 600 };
      return null;
    },
  };
  const window = {
    __CITY_ISOLATION_FIXTURE__: true,
    __TAURI__: { core: { invoke(_method, { code }) { events.push(code); } } },
    __AV_CITY_PROBE__() { return { scene: { camera: { elapsed: scenario === "missing-clock" ? undefined : elapsed } } }; },
  };
  runInNewContext(entry, {
    window, document, localStorage: { getItem() { return "4196523069"; } },
    Date: { now: () => now }, Number,
    setInterval(callback) { tick = callback; timerActive = true; return 1; },
    clearInterval() { timerActive = false; }, setTimeout() {},
  });
  tick(); // Enter battle.
  assert.equal(entryClicked, true, `${locale}: battle entry was not activated`);
  now = 100; tick(); // DOM appears.
  now = 200; tick(); // Capture initial clock.
  elapsed = scenario === "stalled" ? 0 : 0.3;
  now = scenario === "advancing" ? 500 : 15_200;
  tick();
  assert.equal(events.includes("mecha_board_ready"), scenario === "advancing", scenario);
  assert.equal(events.includes("mecha_render_stalled"), scenario !== "advancing", scenario);
  assert.equal(timerActive, false, scenario);
}
console.log("Probe gate synthetic JS: Chinese/English advancing, stalled, zero-canvas and missing-clock paths passed; no native rendering tested.");

// Confirm mock labels and preference key match the source catalogs, not just the probe.
const cityCatalog = readFileSync(new URL("../apps/agent-city/ui/src/i18n.tsx", import.meta.url), "utf8");
const gameCatalog = readFileSync(new URL("../apps/agent-city/ui/src/game/gameCopy.ts", import.meta.url), "utf8");
const hostPreference = readFileSync(new URL("../apps/desktop/ui-dev/react/src/lib/localePreference.ts", import.meta.url), "utf8");
for (const pair of ['"城市设置": "City settings"', '"演示": "Demo"', '" 会话 · ": " sessions · "']) assert.ok(cityCatalog.includes(pair), `city catalog changed: ${pair}`);
assert.ok(gameCatalog.includes('"机甲战棋": "Mecha tactics"'));
assert.ok(hostPreference.includes('languageStorageKey = "agent-vitals.language"'));

// The English override is opt-in and only available on the isolated interactive host.
assert.match(source, /let interactive_en = interactive && std::env::args\(\)\.any\(\|arg\| arg == "--mecha-fixture-en"\);/);
assert.match(source, /localStorage\.setItem\('agent-vitals\.language', 'en'\)/);
assert.match(source, /\.incognito\(true\)\.initialization_script\(host_initialization\)/);
for (const locale of ["zh-Hans", "en"]) for (const missing of ["fixture", "seed", "badge"]) {
  let tick, clicked = false;
  const events = [];
  const labels = locale === "en" ? { dialog: "City settings", demo: "Demo", entry: "Mecha tactics" } : { dialog: "城市设置", demo: "演示", entry: "机甲战棋" };
  const dialog = { querySelector() { return null; }, querySelectorAll() { return [{ textContent: labels.entry, disabled: false, click() { clicked = true; } }]; } };
  const document = { querySelector(selector) {
    if (selector.includes("dialog")) return selector === `dialog[open][aria-label="${labels.dialog}"]` ? dialog : null;
    if (selector === ".city-coverage-badge") return { textContent: missing === "badge" ? "other" : labels.demo };
    return null;
  } };
  const window = { __CITY_ISOLATION_FIXTURE__: missing !== "fixture", __TAURI__: { core: { invoke(_method, { code }) { events.push(code); } } } };
  runInNewContext(entry, { window, document, localStorage: { getItem() { return missing === "seed" ? "other" : "4196523069"; } },
    Date: { now: () => 0 }, Number, setInterval(callback) { tick = callback; return 1; }, clearInterval() {}, setTimeout() {} });
  tick();
  assert.equal(clicked, false, `${locale}: ${missing} condition must block entry`);
  assert.ok(!events.includes("mecha_seed_applied"));
}
console.log("Probe guard synthetic JS: English override is scoped; missing fixture, seed or demo badge blocks entry.");

const observer = source.match(/pub\(crate\) const OBSERVER: &str = r#"([\s\S]*?)"#;/)?.[1];
assert.ok(observer, "observer script not found");
for (const locale of ["zh-Hans", "en"]) {
  let tick;
  let summary = locale === "en" ? "3 sessions · 12 tokens" : "3 会话 · 12 tokens";
  const events = [];
  const window = { __TAURI__: { core: { invoke(_method, { code }) { events.push(code); return Promise.resolve(); } } } };
  const document = { querySelector(selector) { return selector === ".city-summary-trigger" ? { textContent: summary } : null; }, querySelectorAll() { return []; } };
  runInNewContext(observer, { window, document, addEventListener() {}, setInterval(callback) { tick = callback; }, Set, String });
  tick();
  assert.ok(!events.includes("ui_ready"), `${locale}: observer accepted a missing fixture marker`);
  window.__CITY_ISOLATION_FAULTS__ = {};
  tick();
  assert.ok(events.includes("ui_ready"), `${locale}: fixture observer did not mark city ready`);
  summary = locale === "en" ? "2 sessions · 9 tokens" : "2 会话 · 9 tokens";
  tick();
  assert.ok(events.includes("window_seven_ready"), `${locale}: fixture observer did not notice the seven-day projection`);
}
console.log("Probe observer synthetic JS: Chinese/English fixture readiness and window changes passed.");
