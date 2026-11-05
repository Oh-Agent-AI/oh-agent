import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bossPrepare, createMatch, playTurn, previewPlan, type MatchState } from "../src/game/mecha/rules";
import { describeUnitIdentity } from "../src/game/mecha/unitIdentity";
import { inspectCell } from "../src/game/mecha/cellInspection";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

async function component(file: string, name: string) {
  const bundle = await require("esbuild").build({
    entryPoints: [fileURLToPath(new URL(`../src/game/${file}`, import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
    plugins: [{ name: "swarm-ui-test-imports", setup(builder: any) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args: any) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      builder.onLoad({ filter: /\.(css|jpg|png|svg)$/ }, () => ({ contents: 'export default "fixture"', loader: "js" }));
    } }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`))[name];
}

function battle(): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash",
    monsterContent: { speciesId: "swarm_mantle", contentVersion: 1 }, boss: { x: 4, y: 4 },
    covers: [], buildings: [], raiders: [{ id: "ordinary", pos: { x: 8, y: 8 } }], mechs: [
      { id: "Assault", pos: { x: 4, y: 2 } }, { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 1, y: 9 } },
    ],
  });
  bossPrepare(state);
  return state;
}
function plan(state: MatchState, move = false) {
  return { revision: state.revision, items: state.mechs.map(mech => ({ mechId: mech.id,
    moveTo: move && mech.id === "Assault" ? { x: 4, y: 3 } : null, action: { kind: "skip" as const } })) };
}

test("actual summon metadata identifies children; a swarm-like ID alone never does", async () => {
  const state = battle(), result = playTurn(state, plan(state));
  assert.ok(result.ok, JSON.stringify(result));
  const child = result.state.raiders.find(raider => raider.summon?.speciesId === "swarm_child");
  assert.ok(child);
  assert.deepEqual(describeUnitIdentity(child.id, "en", child), {
    id: child.id, label: "Swarm child", symbol: "✣", side: "enemy", sideLabel: "Enemy", known: true,
  });
  assert.equal(describeUnitIdentity(child.id, "zh-Hans", child).label, "群构子体");
  assert.equal(describeUnitIdentity(child.id, "en").side, "unknown");
  assert.equal(describeUnitIdentity(child.id, "en", { id: child.id }).label, child.id);
  assert.equal(describeUnitIdentity(child.id, "en", { id: child.id }).side, "enemy");
  assert.equal(describeUnitIdentity(child.id, "en", { ...child, id: "different" }).side, "unknown");
  assert.equal(describeUnitIdentity(child.id, "en", { ...child, summon: { ...child.summon!, expiresAtRound: NaN } }).label, child.id);
  assert.equal(describeUnitIdentity(child.id, "en", { ...child, summon: { ...child.summon!, parentId: "other" as "boss" } }).label, child.id);
  assert.equal(describeUnitIdentity(child.id, "en", { ...child, summon: { ...child.summon!, speciesId: "other" as "swarm_child" } }).label, child.id);
  assert.equal(describeUnitIdentity("arbitrary-id", "en", { ...child, id: "arbitrary-id" }).label, "Swarm child");
  assert.equal(describeUnitIdentity("raider-w", "en", { id: "raider-w" }).label, "West raider");
  assert.equal(describeUnitIdentity("ordinary", "en", result.state.raiders.find(r => r.id === "ordinary")).side, "enemy");

  const info = inspectCell(result.state, child.pos, {}, child.id)!;
  assert.deepEqual(info.unit?.summon, child.summon);
  assert.notEqual(info.unit?.summon, child.summon);
  const Inspector = await component("MechaCellInspector.tsx", "MechaCellInspector");
  for (const [locale, label] of [["en", "Swarm child · Enemy"], ["zh-Hans", "群构子体 · 敌方"]]) {
    for (const compact of [true, false]) {
      const html = renderToStaticMarkup(React.createElement(Inspector, { info, locale, compact, onClose() {} }));
      assert.match(html, /data-unit-side="enemy"/);
      assert.ok(html.includes(label), html);
    }
  }
});

test("split-swarm intent presents authoritative fixed candidates and real draft slot reasons", async () => {
  const state = battle(), intent = state.boss.intent!;
  assert.equal(intent.swarm?.request.skillId, "split_swarm");
  if (intent.swarm?.request.skillId !== "split_swarm") throw new Error("missing split binding");
  const preview = previewPlan(state, plan(state, true));
  assert.ok(preview.ok, JSON.stringify(preview));
  const projected = preview.monsterProjection?.swarmProjection;
  assert.ok(projected?.status === "reprojected" && projected.skillId === "split_swarm");
  assert.equal(projected.slots.find(slot => slot.cell.x === 4 && slot.cell.y === 3)?.reason, "occupied");
  const Intent = await component("MechaMonsterIntent.tsx", "MechaMonsterIntent");
  const html = renderToStaticMarkup(React.createElement(Intent, { locale: "en", state, preview }));
  assert.ok(html.includes(intent.swarm.request.candidates.map(c => `${c.x},${c.y}`).join("、")));
  assert.match(html, /data-swarm-slot="4,3" data-status="invalid">4,3 · invalid: destination occupied/);
  for (const slot of projected.slots.filter(slot => slot.unit)) {
    assert.ok(html.includes(`data-swarm-slot="${slot.cell.x},${slot.cell.y}" data-status="valid"`));
  }
  assert.match(html, /Projected spawns, not units already spawned/);
  assert.match(html, /per-action spawn limit/);
  const zh = renderToStaticMarkup(React.createElement(Intent, { locale: "zh-Hans", state, preview }));
  assert.match(zh, /原始候选格（顺序固定）/);
  assert.match(zh, /4,3 · 无效: 落点被占用/);
});

test("missing, mismatched, void and contradictory swarm projection evidence degrades honestly", async () => {
  const state = battle(), preview = previewPlan(state, plan(state));
  assert.ok(preview.ok && preview.monsterProjection);
  const Intent = await component("MechaMonsterIntent.tsx", "MechaMonsterIntent");
  const render = (preview: unknown) => renderToStaticMarkup(React.createElement(Intent, { locale: "en", state, preview }));
  assert.match(render(null), /Preview unavailable; do not assume safety/);
  assert.match(render({ monsterProjection: null }), /Enemy phase not reached/);
  const mismatch = structuredClone(preview.monsterProjection);
  if (mismatch.swarm?.request.skillId !== "split_swarm") throw new Error("missing split binding");
  mismatch.swarm.request.actionId = "another-action";
  assert.match(render({ monsterProjection: mismatch }), /Candidate projection unavailable/);
  const voided = structuredClone(preview.monsterProjection);
  voided.swarmProjection = { status: "void", reason: "stale_round" };
  assert.match(render({ monsterProjection: voided }), /Skill void: declaration round expired/);
  const contradictory = structuredClone(preview.monsterProjection);
  if (contradictory.swarmProjection?.status !== "reprojected" || contradictory.swarmProjection.skillId !== "split_swarm") throw new Error("missing slots");
  contradictory.swarmProjection.slots[0]!.reason = null;
  contradictory.swarmProjection.slots[0]!.unit = null;
  assert.match(render({ monsterProjection: contradictory }), /data-status="unknown"/);
  contradictory.swarmProjection.slots[0]!.cell.x++;
  assert.match(render({ monsterProjection: contradictory }), /Candidate projection unavailable/);
  const conflict = structuredClone(preview.monsterProjection);
  conflict.status = "void";
  assert.match(render({ monsterProjection: conflict }), /Candidate projection unavailable/);
  const protectedPath = structuredClone(preview.monsterProjection);
  if (protectedPath.swarmProjection?.status !== "reprojected" || protectedPath.swarmProjection.skillId !== "split_swarm") throw new Error("missing slots");
  protectedPath.swarmProjection.slots[0]!.reason = "protected_path";
  protectedPath.swarmProjection.slots[0]!.unit = null;
  assert.match(render({ monsterProjection: protectedPath }), /invalid: protected path/);
  const noBinding = structuredClone(state);
  noBinding.boss.intent!.swarm = undefined;
  const unavailable = renderToStaticMarkup(React.createElement(Intent, { locale: "en", state: noBinding, preview: null }));
  assert.match(unavailable, /Original candidate cells \(fixed order\): unavailable/);
});
