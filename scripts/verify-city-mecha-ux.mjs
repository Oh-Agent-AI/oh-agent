#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadCity } from "./city-kit/index.mjs";

const root = new URL("../apps/agent-city/ui/src/", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [city, engine, board, world, css, copy] = await Promise.all([
  read("CityApp.tsx"), read("engine/CityEngine.ts"), read("game/MechaBoard.tsx"), read("game/CityMechaWorld.tsx"), read("game/game.css"), read("game/gameCopy.ts"),
]);

assert.match(city, /!embedded\(\) && !mechaOpen && <header className="city-header"/);
assert.match(city, /!driving\.active && !mechaOpen && sceneReady && <SquadFeed/);
assert.match(city, /hidden=\{driving\.active \|\| mechaOpen\}/);
assert.match(city, /game\.active \|\| mechaOpen \|\| !!experience\.film/);
assert.match(city, /labels, cinema, mechaOpen, roadAuditOpen/);

assert.match(board, /className="mecha-battle-bar"/);
assert.match(board, /setPaused\(\(value\) => !value\)/);
assert.match(board, /if \(!auto \|\| paused\) return undefined/);
assert.match(board, /if \(auto \|\| paused \|\| state\.phase !== "player_plan"\) return/);
assert.match(board, /plannedCount = activeMechs\.filter/);
assert.match(board, /pendingNames = activeMechs\.filter/);
assert.match(board, /\{t\("已规划"\)\} \{plannedCount\}\/\{activeMechs\.length\}/);
assert.match(board, /pendingNames\.join\("、"\)/);
assert.match(board, /<details className="mecha-settings">/);
assert.match(board, /className="mecha-map-legend"/);
for (const label of ["可移动", "计划落点", "敌方预告", "打法目标"]) assert.match(board, new RegExp(`t\\("${label}"\\)`));
assert.match(board, /worldRef\.current\?\.rotateCamera\(\)/);
assert.match(board, /worldRef\.current\?\.resetCamera\(\)/);
assert.match(css, /\.mecha-overlay\.is-city \{ display: block; background: transparent; pointer-events: none; \}/);
assert.match(css, /\.mecha-overlay\.is-city \.mecha-pack \{ position: absolute; left: 12px; bottom: 12px; display: flex/);
assert.match(css, /\.mecha-overlay\.is-city \.mecha-submit \{ position: absolute; right: 12px; bottom: 12px/);
assert.match(css, /@media \(max-width: 600px\)/);
assert.match(css, /@media \(max-height: 640px\)/);
assert.match(css, /@media \(max-width: 600px\) and \(max-height: 520px\)/);
assert.match(world, /acquireModeLease\(\{ camera: "orbit" \}\)/);
assert.doesNotMatch(world, /frameCamera/);
assert.match(world, /empty: 0\.05/);
assert.match(world, /grid[^\n]*opacity: 0\.28/);
assert.match(world, /ring\.mat\.opacity = figure\.selected \|\| targeted \? 1 : 0\.48/);
assert.match(world, /targets\.has\(id\) \? "target"/);
assert.match(world, /targetIds\.has\(raider\.id\)/);
assert.match(board, /new Set\(actions\.map\(\(action\) => action\.kind\)\)/);
assert.doesNotMatch(board, /const named = action\.kind/);
assert.match(board, /validTarget\(state, selected, moveTo, targeting, option\.id\)/);
assert.match(board, /targets: targetOptions\.flatMap/);
assert.match(css, /\.mecha-cell\.is-target/);
assert.match(css, /\.mecha-selected-actions\.is-targeting/);
assert.match(engine, /acquireModeLease\(options: \{ camera\?: "fixed" \| "orbit" \}/);
assert.match(engine, /setOrbitView: \(view\) =>/);
assert.match(engine, /options\.camera !== "orbit"/);
assert.match(engine, /this\.cameraOwner === "game" \|\| this\.modeLeases\.busy/);
assert.match(engine, /this\.gameFrame\?\.\(dt\)/);

const englishKeys = new Set([...copy.matchAll(/^\s*"([^\"]+)"\s*:/gm)].map((match) => match[1]));
for (const [, text] of board.matchAll(/"([^"\n]*\p{Script=Han}[^"\n]*)"/gu)) {
  assert.ok(englishKeys.has(text), `English translation missing for ${text}`);
}
const { gameText } = await loadCity({ "game/gameCopy.ts": ["gameText"] });
assert.equal(gameText("已规划", "en"), "Planned");
assert.equal(gameText("战场设置与规则", "en"), "Battlefield settings and rules");
assert.equal(gameText("旋转 90°", "en"), "Rotate 90°");
assert.equal(gameText("战术视角", "en"), "Tactical view");
console.log("Mecha UX: compact HUD, shared orbit camera, click isolation, responsive layout and translations passed.");
