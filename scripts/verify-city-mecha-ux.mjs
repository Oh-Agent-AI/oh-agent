#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadCity } from "./city-kit/index.mjs";

const root = new URL("../apps/agent-city/ui/src/", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [city, engine, board, world, css, copy, animation, controller] = await Promise.all([
  read("CityApp.tsx"), read("engine/CityEngine.ts"), read("game/MechaBoard.tsx"), read("game/CityMechaWorld.tsx"), read("game/game.css"), read("game/gameCopy.ts"), read("render/mecha/animation.ts"), read("game/mecha/controller.ts"),
]);

assert.match(city, /!embedded\(\) && !mechaOpen && <header className="city-header"/);
assert.match(city, /!driving\.active && !mechaOpen && sceneReady && <SquadFeed/);
assert.match(city, /hidden=\{driving\.active \|\| mechaOpen\}/);
assert.match(city, /game\.active \|\| mechaOpen \|\| !!experience\.film/);
assert.match(city, /labels, cinema, mechaOpen, roadAuditOpen/);

assert.match(board, /className="mecha-battle-bar"/);
assert.match(board, /controller\.togglePause\(\)/);
assert.match(board, /if \(viewFailed \|\| !auto \|\| paused \|\| performance \|\| !controller\) return undefined/);
assert.match(controller, /!auto && !paused && !performance && !finished\(\)/);
assert.match(controller, /performanceFromLog\(match, result\.state, result\.log\)/);
assert.match(controller, /playTurn\(match, plan\)/);
assert.match(controller, /finishPerformance\(\) \{[\s\S]*?performance = null/);
assert.match(board, /\{t\("跳过演出"\)\}/);
assert.match(board, /disabled=\{!planning/);
assert.match(world, /pausedRef\.current \? 0 : dt/);
assert.match(animation, /this\.completed = true;\s*this\.onComplete\(\)/);
assert.match(board, /plannedCount = s\?\.plannedCount/);
assert.match(board, /pendingNames = \(s\?\.pendingIds/);
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
assert.match(world, /ring\.mat\.opacity = figure\.selected \|\| targeted \? 1 : 0\.68/);
assert.match(world, /ring\.mat\.color\.set\(figure\.selected \? "#f4f7fb" : MECHA_FACTION_COLORS\.friendly\)/);
assert.match(world, /Assault: marker\(MECHA_FACTION_COLORS\.friendly/);
assert.match(world, /Gunner: marker\(MECHA_FACTION_COLORS\.friendly/);
assert.match(world, /Support: marker\(MECHA_FACTION_COLORS\.friendly/);
assert.match(world, /boss: marker\(MECHA_FACTION_COLORS\.enemy, 10\.2, 13, 4\)/);
assert.match(world, /raiderWest: marker\(MECHA_FACTION_COLORS\.enemy, 2\.9, 4\.1, 4\)/);
assert.match(world, /targets\.has\(id\) \? "target"/);
assert.match(world, /targetIds\.has\(raider\.id\)/);
assert.match(board, /new Set\(s\.actions\.map/);
assert.doesNotMatch(board, /const named = action\.kind/);
assert.match(controller, /actionFault\(match, draft, selected/);
assert.match(board, /targets: performance \? \[\] : targetOptions\.flatMap/);
assert.match(world, /telegraph\.has\(id\) \? "telegraph"/);
assert.doesNotMatch(board, /MechaLineup|mecha-grid|方格棋盘|t\("布局"\)/);
assert.doesNotMatch(css, /\.mecha-grid|\.mecha-cell/);
assert.match(board, /className="mecha-overlay is-city"/);
assert.doesNotMatch(board, /mecha-overlay(?! is-city)/);
assert.match(board, /\{t\("战场"\)\}/);
assert.match(board, /s\.preview\.ok \? s\.preview\.telegraphAfter/);
assert.match(board, /telegraph: s\?\.telegraph/);
assert.match(board, /\{t\("推动后预告"\)\}/);
assert.match(board, /\{t\("推动后受击"\)\}/);
assert.match(board, /\{t\("撤回移动"\)\}/);
assert.match(board, /controller\.undoMove\(\)/);
assert.match(board, /onHoverEnemy/);
assert.match(world, /onHoverEnemyRef/);
assert.match(board, /这座城暂时没有可用机坪。/);
assert.match(board, /三维视角被其他模式占用。/);
assert.match(board, /楼太少时往往没有平地、靠岸或巷战。可以重试，或关掉战棋。/);
assert.match(controller, /undoMove\(\)/);
assert.match(controller, /movePast/);
assert.match(controller, /setHoveredEnemy/);
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
