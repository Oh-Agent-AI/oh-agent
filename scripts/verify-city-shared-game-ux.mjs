#!/usr/bin/env node
// §14 shared flight/car HUD, keyboard ownership and unit/copy contract guard.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadCity } from "./city-kit/index.mjs";

const root = new URL("../apps/agent-city/ui/src/", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [hud, flightHud, keyboard, carInput, flightHook, drivingBridge, closeDisclosure, panel, css, cityCss, copy] = await Promise.all([
  read("game/DrivingHud.tsx"), read("game/GameHud.tsx"), read("game/runtime/KeyboardInput.ts"),
  read("game/useCityDrivingPlay.ts"), read("game/useCityGame.ts"), read("game/useCityDriving.ts"),
  read("game/ui/closeOpenDisclosure.ts"), read("game/ui/GameSessionPanel.tsx"), read("game/game.css"), read("city.css"), read("game/gameCopy.ts"),
]);
assert.match(hud, /GameHudShell/); assert.match(hud, /GameControlsHelp/); assert.match(hud, /GameSessionPanel/);
assert.doesNotMatch(hud, /useCityDrivingUat|ReturnType/);
assert.match(hud, /export type DrivingHudModel/); assert.match(hud, /export type DrivingHudActions/);
assert.match(hud, /METERS_PER_UNIT/); assert.match(hud, /Math\.abs\(hud\.speed\)\s*\*\s*METERS_PER_UNIT\s*\*\s*3\.6/);
assert.doesNotMatch(hud, /GameSessionSnapshot|city-driving-hud|世界单位\s*\/\s*秒/);
assert.match(hud, /自由驾驶/); assert.match(hud, /道路体检通过/); assert.match(hud, /道路体检未通过/);
assert.doesNotMatch(hud, /道路认证中/); assert.match(hud, /details className="city-game-chip city-game-diagnostics"/);
assert.match(flightHud, /GameHudShell/); assert.match(flightHud, /GameSessionSnapshot/);
assert.match(keyboard, /event\.repeat/); assert.match(keyboard, /\["range", "checkbox", "radio", "button", "submit", "reset", "color", "file"\]/);
assert.match(keyboard, /if \(!this\.options\.isFocused\(\)\) return;/);
assert.match(carInput, /event\.code === "Escape"/); assert.match(carInput, /event\.repeat/);
assert.match(carInput, /phaseRef\.current === "preparing"\) exit\(\)/); assert.doesNotMatch(carInput, /event\.repeat\) exit\(\)/);
assert.match(hud, /hud\.phase === "running" \|\| helpOpen/);
assert.match(hud, /hud\.phase === "running" \|\| soundOpen/);
assert.match(flightHud, /\(!paused \|\| helpOpen\)/);
assert.match(closeDisclosure, /querySelector<HTMLElement>\("summary"\)\?\.focus\(\{ preventScroll: true \}\)/);
assert.match(panel, /visibleFocusables/); assert.match(panel, /activeIndex < 0/);
assert.match(carInput, /scene\.attach\(\[visuals\.current\.root\]\)/);
assert.match(carInput, /visualScene\.current\?\.detach\(\[currentVisuals\.root\]\)/);
assert.match(carInput, /presentDrivingCamera\(state, frameSeconds, cameraSweep, scene\)/);
assert.match(drivingBridge, /frame\.cameraSweep, scene/);
assert.match(carInput, /reason === "host-suspended"\) exit\(\)/);
assert.match(carInput, /car\.pause\(reason\)/);
assert.match(flightHook, /event\.repeat/); assert.match(flightHook, /phase === "preparing"\) \{ current\.exit\(\); return; \}/);
assert.match(css, /min-height:\s*44px/); assert.match(css, /:focus-visible/);
assert.match(cityCss, /\.city-app:has\(\.city-header\) \.city-summary-trigger\s*\{\s*top:\s*120px/);
assert.match(cityCss, /\.city-app:has\(\.city-header\) \.city-legend\s*\{\s*top:\s*172px/);
assert.match(cityCss, /@media\s*\(max-width:\s*360px\)[\s\S]*?\.city-summary-trigger\s*\{\s*top:\s*168px/);
assert.match(copy, /"驾驶诊断"\s*:\s*"Driving diagnostics"/); assert.match(copy, /"前方有障碍"\s*:/);

const { METERS_PER_UNIT } = await loadCity({ "engine/worldScale.ts": ["METERS_PER_UNIT"] });
for (const [speed, expected] of [[0, 0], [13, 93.6], [-13, 93.6]]) {
  const display = Math.abs(speed) * METERS_PER_UNIT * 3.6;
  assert.equal(Number(display.toFixed(1)), expected, `${speed} world units/s -> km/h`);
}
const englishKeys = new Set([...copy.matchAll(/^\s*"([^\"]+)"\s*:/gm)].map((match) => match[1]));
for (const source of [hud, flightHud]) {
  for (const [, text] of source.matchAll(/"([^"\n]*\p{Script=Han}[^"\n]*)"/gu)) {
    assert.ok(englishKeys.has(text), `English translation missing for ${text}`);
  }
}
const { gameText } = await loadCity({ "game/gameCopy.ts": ["gameText"] });
assert.equal(gameText("未知中文文案", "en"), "Translation unavailable: 未知中文文案", "missing translations retain source text for diagnosis");
console.log("Shared game UX: shared shell, vehicle telemetry, focused input, pause commands, bilingual free drive and km/h conversion passed.");
