import assert from "node:assert/strict";
import test from "node:test";
import { createMatch, bossPrepare, RAIDER_HP, type MatchState } from "../src/game/mecha/rules";
import { declaredAttack, inspectCell, inspectionSegments } from "../src/game/mecha/cellInspection";

function fixture(): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [{ x: 2, y: 2 }], buildings: [{ id: "b1", cells: [{ x: 6, y: 6 }], hp: 9, maxHp: 16 }], raiders: [{ id: "raider-w", pos: { x: 7, y: 8 } }], boss: { x: 4, y: 0 }, mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }] });
  bossPrepare(state);
  return state;
}

test("empty tiles expose actual terrain and height without inventing occupants", () => {
  const state = fixture();
  for (const [x, terrain] of [[0, "land"], [1, "water"], [2, "mountain"], [3, "road"]] as const) {
    state.terrain[5]![x] = terrain; state.heights[5]![x] = 7.5;
    const info = inspectCell(state, { x, y: 5 })!;
    assert.equal(info.terrain, terrain); assert.equal(info.height, 7.5);
    assert.equal(info.object, "empty"); assert.equal(info.unit, undefined);
  }
  assert.equal(inspectCell(state, { x: -1, y: 0 }), null);
  assert.equal(inspectCell(state, { x: 10, y: 0 }), null);
  assert.equal(inspectCell(state, { x: 1.5, y: 5 }), null);
  assert.equal(inspectCell(state, { x: NaN, y: 5 }), null);
});

test("cover, scene obstacles, multi-cell buildings and rubble keep their own properties", () => {
  const state = fixture(); state.obstacles.push({ x: 2, y: 3 });
  assert.equal(inspectCell(state, { x: 2, y: 2 })!.object, "cover");
  assert.equal(inspectCell(state, { x: 2, y: 3 })!.object, "obstacle");
  const b = state.buildings[0]!; b.cells.push({ x: 7, y: 6 });
  assert.deepEqual(inspectCell(state, { x: 7, y: 6 })!.building, { id: "b1", hp: b.hp, maxHp: b.maxHp });
  b.hp = 0;
  assert.equal(inspectCell(state, { x: 6, y: 6 })!.object, "rubble");
});

test("all friendly units and every boss footprint cell expose rule stats", () => {
  const state = fixture();
  for (const mech of state.mechs) assert.equal(inspectCell(state, mech.pos)!.unit?.id, mech.id);
  assert.equal(inspectCell(state, state.mechs[0]!.pos)!.unit?.atk, 5);
  for (const x of [4, 5]) for (const y of [0, 1]) {
    const info = inspectCell(state, { x, y })!;
    assert.equal(info.unit?.id, "boss"); assert.equal(info.unit?.maxHp, 40);
    assert.deepEqual(info.attack?.origin, { x: 4, y: 0 });
  }
  assert.equal(inspectCell(state, state.raiders[0]!.pos)!.unit?.maxHp, RAIDER_HP);
});

test("actual friendly cells retain occupancy and expose the planned route", () => {
  const state = fixture(); const mech = state.mechs[0]!;
  const destination = { x: 1, y: 1 }; const draft = { Assault: { moveTo: destination } };
  const info = inspectCell(state, mech.pos, draft)!;
  assert.equal(info.unit?.id, "Assault"); assert.deepEqual(info.movePath?.[0], mech.pos);
  assert.deepEqual(info.movePath?.at(-1), destination);
  assert.equal(inspectCell(state, destination, draft)!.object, "empty");
  const segments = inspectionSegments(null, info.movePath);
  assert.equal(segments.length, info.movePath!.length - 1);
  for (const segment of segments) assert.equal(Math.abs(segment.from.x - segment.to.x) + Math.abs(segment.from.y - segment.to.y), 1);
});

test("attack areas produce independent directional rays, never a fictional walk path", () => {
  const state = fixture();
  state.boss.intent = { skillId: "sweep", status: "planned", local: [], cdSweep: 0, projected: [{ x: 4, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 2 }, { x: 11, y: 2 }] };
  const attack = declaredAttack(state, "boss")!; const segments = inspectionSegments(attack, [{ x: 0, y: 0 }, { x: 0, y: 1 }]);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map(s => s.from), [{ x: 4.5, y: .5 }, { x: 4.5, y: .5 }]);
  assert.ok(segments.every(s => s.kind === "attack"));
  assert.deepEqual(attack.targets, [{ x: 4, y: 2 }, { x: 5, y: 2 }]);
  segments[0]!.to.x = 9;
  assert.equal(state.boss.intent.projected[0]!.x, 4, "presentation cannot mutate rule targets");
});

test("missing, skip, void, dead and unknown declarations don't fabricate routes", () => {
  const state = fixture();
  state.boss.intent = null;
  assert.equal(declaredAttack(state, "boss")!.status, "missing");
  assert.deepEqual(inspectionSegments(declaredAttack(state, "boss"), null), []);
  for (const [skillId, status] of [["skip", "planned"], ["smash", "void"]] as const) {
    state.boss.intent = { skillId, status, local: [], projected: [{ x: 3, y: 1 }], cdSweep: 0 };
    assert.deepEqual(declaredAttack(state, "boss")!.targets, []);
  }
  state.boss.hp = 0;
  assert.equal(declaredAttack(state, "boss"), null);
  assert.equal(inspectCell(state, { x: 4, y: 0 })!.unit, undefined);
  assert.equal(declaredAttack(state, "not-an-enemy"), null);
});

test("a click on empty ground stays a terrain inspection even if it also queues a move", () => {
  const state = fixture(); const cell = { x: 1, y: 1 };
  const draft = { Assault: { moveTo: cell } };
  assert.equal(inspectCell(state, cell, draft)!.unit, undefined, "a planned destination does not contain an actual unit");
  assert.equal(inspectCell(state, cell, draft, null)!.object, "empty", "the original ground click isn't replaced by the moving model");
});


test("rescue raider inspection exposes its actual role without inventing legacy roles", () => {
  const state = fixture();
  const raider = state.raiders[0]!;
  assert.equal(inspectCell(state, raider.pos)?.unit?.role, undefined);
  state.mission = { kind: "rescue:v1", target: { x: 1, y: 1 } };
  raider.role = "interceptor";
  assert.equal(inspectCell(state, raider.pos)?.unit?.role, "interceptor");
  raider.role = "siege";
  assert.equal(inspectCell(state, raider.pos)?.unit?.role, "siege");
  assert.equal(inspectCell(state, state.boss.anchor)?.unit?.role, undefined);
});

test("raider role text is localized in full and compact inspections", async () => {
  const { createRequire } = await import("node:module");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const require = createRequire(import.meta.url);
  const bundle = await require("esbuild").build({
    entryPoints: [fileURLToPath(new URL("../src/game/MechaCellInspector.tsx", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
    plugins: [{ name: "inspection-test-imports", setup(builder: any) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args: any) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      builder.onLoad({ filter: /\.(css|jpg|png|svg)$/ }, () => ({ contents: 'export default "fixture"', loader: "js" }));
    } }],
  });
  const component = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const state = fixture(), raider = state.raiders[0]!;
  state.mission = { kind: "rescue:v1", target: { x: 1, y: 1 } }; raider.role = "interceptor";
  const info = inspectCell(state, raider.pos)!;
  for (const [locale, expected] of [["zh-Hans", "拦截型 · 优先接近存活机甲"], ["en", "Interceptor · closes on surviving mechs"]] as const) {
    for (const compact of [false, true]) {
      const html = require("react-dom/server").renderToStaticMarkup(require("react").createElement(component.MechaCellInspector, { info, locale, compact, onClose() {} }));
      assert.match(html, /data-raider-role="interceptor"/); assert.ok(html.includes(expected));
    }
  }
});
