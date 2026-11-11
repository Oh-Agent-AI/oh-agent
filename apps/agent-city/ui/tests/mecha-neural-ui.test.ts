import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bossPrepare, createMatch, playTurn, previewPlan, type MatchState } from "../src/game/mecha/rules.ts";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
async function component(file: string, name: string) {
  const bundle = await require("esbuild").build({
    entryPoints: [fileURLToPath(new URL(`../src/game/${file}`, import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
    plugins: [{ name: "neural-ui-test-imports", setup(builder: any) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args: any) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      builder.onLoad({ filter: /\.(css|jpg|png|svg)$/ }, () => ({ contents: 'export default "fixture"', loader: "js" }));
    } }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`))[name];
}
function battle(): MatchState {
  const s = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 4 },
    raiders: [{ id: "a", pos: { x: 3, y: 4 } }, { id: "b", pos: { x: 6, y: 4 } }],
    mechs: [{ id: "Assault", pos: { x: 2, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 1, y: 9 } }],
    monsterContent: { speciesId: "neural_weaver", contentVersion: 1 } });
  bossPrepare(s); return s;
}
function hold(s: MatchState) {
  return { revision: s.revision, items: s.mechs.map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
}

test("declaration and draft describe fixed target, actual parameters and non-attack semantics in both locales", async () => {
  const s = battle(), preview = previewPlan(s, hold(s)); assert.ok(preview.ok && preview.monsterProjection);
  const Intent = await component("MechaMonsterIntent.tsx", "MechaMonsterIntent");
  const render = (locale: string, state: unknown, p: unknown) => renderToStaticMarkup(React.createElement(Intent, { locale, state, preview: p }));
  const en = render("en", s, preview), zh = render("zh-Hans", s, preview);
  assert.match(en, /Fixed declared target: a/); assert.match(en, /Attack bonus \(before defense\): \+2/);
  assert.match(en, /Projected link \(not yet executed\)/); assert.match(en, /target destruction/);
  assert.match(zh, /固定宣告目标: a/); assert.match(zh, /预测链接（尚未执行）/);
  const result = playTurn(s, hold(s)); assert.ok(result.ok);
  assert.match(render("en", result.state, null), /Active links/);
  assert.match(render("en", result.state, null), /a · \+2/);
  assert.match(render("en", s, null), /Preview unavailable; do not assume safety/);
  assert.match(render("en", s, { monsterProjection: null }), /Enemy phase not reached/);
  const retargeted = structuredClone(preview.monsterProjection);
  if (retargeted.swarm?.request.skillId !== "neural_link") throw Error();
  retargeted.swarm.request.targetId = "raider:b";
  assert.match(render("en", s, { monsterProjection: retargeted }), /Link projection unavailable; do not assume safety/);
  const conflicting = structuredClone(preview.monsterProjection); conflicting.status = "void";
  assert.match(render("en", s, { monsterProjection: conflicting }), /Link projection unavailable; do not assume safety/);
  const missing = structuredClone(s); missing.boss.intent!.swarm = undefined;
  assert.match(render("en", missing, null), /Link declaration unavailable; do not assume safety/);
});

test("real target death shows the original target's void and the committed journal result", async () => {
  const s = battle(); s.raiders.find(r => r.id === "a")!.hp = 4;
  const plan = hold(s); plan.items[0]!.action = { kind: "melee", target: "a" } as never;
  const preview = previewPlan(s, plan), result = playTurn(s, plan); assert.ok(preview.ok && result.ok);
  const Intent = await component("MechaMonsterIntent.tsx", "MechaMonsterIntent");
  const Result = await component("MechaLastResult.tsx", "MechaLastResult");
  const html = renderToStaticMarkup(React.createElement(Intent, { locale: "en", state: s, preview }));
  assert.match(html, /Fixed declared target: a/); assert.match(html, /Link void: target destroyed/);
  assert.match(html, /The target will not be reselected/);
  const output = renderToStaticMarkup(React.createElement(Result, { locale: "en", t: (s: string) => s, lastLog: result.log }));
  assert.match(output, /Neural link void · a · target destroyed/);
});
