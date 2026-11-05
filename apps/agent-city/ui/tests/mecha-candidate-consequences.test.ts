import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { candidateResult } from "../src/game/mecha/candidateResult.ts";
import { forecastFizzles } from "../src/game/mecha/fizzleForecast.ts";
import { bossPrepare, createMatch, playTurn, previewPlan, type ArenaPlan, type MatchState } from "../src/game/mecha/rules.ts";

const require = createRequire(import.meta.url);
let componentPromise: Promise<any> | undefined;
function loadComponent() {
  return componentPromise ??= (async () => {
    const { build } = require("esbuild");
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("../src/game/MechaCandidateConsequences.tsx", import.meta.url))],
      bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
      plugins: [{ name: "candidate-consequences-test-imports", setup(builder: any) {
        builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args: any) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      } }],
    });
    return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  })();
}
async function render(result: any, candidate: any, baseline: any = candidate, locale: "zh" | "en" = "en") {
  const component = await loadComponent();
  return require("react-dom/server").renderToStaticMarkup(require("react").createElement(component.MechaCandidateConsequences, {
    result, candidate, baseline, locale, unitName: (id: string) => id,
  })) as string;
}
function ready(state: MatchState, plan: ArenaPlan) {
  const preview = previewPlan(state, plan);
  assert.ok(preview.ok, preview.ok ? "" : preview.fault.reason);
  const full: ArenaPlan = { ...plan, items: [...plan.items, ...preview.assumed.map(mechId => ({ mechId, moveTo: null, action: { kind: "skip" as const } }))] };
  const played = playTurn(state, full);
  assert.ok(played.ok);
  assert.deepEqual(preview.log, played.log, "preview uses the actual rule events");
  assert.deepEqual(preview.stages, played.presentationStages, "preview uses the actual stage snapshots");
  return { ...preview, status: "ready" as const, revision: state.revision, draftVersion: 0 };
}
function collisionCase() {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 0 } }, { id: "Support", pos: { x: 6, y: 1 } }] });
  state.mechs.find(mech => mech.id === "Gunner")!.hp = 1;
  bossPrepare(state);
  const plan: ArenaPlan = { revision: state.revision, items: [
    { mechId: "Support", moveTo: null, action: { kind: "skip" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "shoot", target: "boss" } },
    { mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } },
  ] };
  return ready(state, plan);
}

test("blocked 2×2 push exposes the event direction, each collision and subsequent fizzle", async () => {
  const preview = collisionCase();
  const result = candidateResult(preview, "Assault", "boss");
  assert.equal(result.action?.damage, 2);
  assert.equal(result.actionHp, 36);
  assert.equal(result.endHp, 36);
  assert.deepEqual(result.shoves.map(({ event, from, to }) => ({ dir: event.dir, hit: event.hit, from, to })), [
    { dir: { x: 1, y: 0 }, hit: "Gunner,Support", from: { x: 4, y: 0 }, to: { x: 4, y: 0 } },
  ]);
  assert.deepEqual(result.shoves[0]!.event.effects?.map(({ id, before, after }) => ({ id, before, after })), [
    { id: "boss", before: 38, after: 36 }, { id: "Gunner", before: 1, after: 0 }, { id: "Support", before: 12, after: 10 },
  ]);
  assert.deepEqual(result.kills, [{ kind: "mech", id: "Gunner", source: "collision" }]);
  assert.deepEqual(forecastFizzles(preview.log).map(({ mechId, cause }) => ({ mechId, cause })), [{ mechId: "Gunner", cause: "mech_dead" }]);
  const html = await render(result, preview);
  assert.match(html, /Push blocked · stays in place.*boss \(2×2 anchor\) 4,0 → 4,0/);
  assert.match(html, /Push direction \(Δx, Δy\).*\(\+1, 0\)/);
  assert.match(html, /Collision.*Gunner, Support/);
  assert.match(html, /boss HP 38 → 36/);
  assert.match(html, /Gunner HP 1 → 0/);
  assert.match(html, /Support HP 12 → 10/);
  assert.match(html, /other actions forecast to fizzle/);
  assert.match(html, /Gunner.*cooldown/i);
  assert.doesNotMatch(html, /No collision|No push occurred/);
  const zh = await render(result, preview, preview, "zh");
  assert.match(zh, /推挤方向（Δx, Δy）.*\(\+1, 0\)/);
  assert.match(zh, /碰撞.*Gunner、Support/);
  assert.match(zh, /不消耗冷却/);
});

test("a successful push reports an actual landing and no collision", async () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 4 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }] });
  bossPrepare(state);
  const preview = ready(state, { revision: state.revision, items: [{ mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } }] });
  const result = candidateResult(preview, "Assault", "boss");
  assert.deepEqual(result.shoves.map(({ from, to }) => ({ from, to })), [{ from: { x: 4, y: 4 }, to: { x: 5, y: 4 } }]);
  const html = await render(result, preview);
  assert.match(html, /Push landing.*4,4 → 5,4/);
  assert.match(html, /No collision\./);
  assert.doesNotMatch(html, /No push occurred\./);
  const withoutStages = { ...preview, stages: null };
  const unknown = candidateResult(withoutStages, "Assault", "boss");
  assert.equal(unknown.actionHp, null);
  assert.equal(unknown.endHp, null);
  const unknownHtml = await render(unknown, withoutStages);
  assert.match(unknownHtml, /boss \(2×2 anchor\) \? → \?/);
  assert.match(unknownHtml, /Push direction \(Δx, Δy\).*\(\+1, 0\)/);
  assert.match(unknownHtml, /Target HP after this action.*\?/);
});

test("a directly defeated boss is not given a fabricated push", async () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 4 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }] });
  state.boss.hp = 1;
  bossPrepare(state);
  const preview = ready(state, { revision: state.revision, items: [{ mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } }] });
  const result = candidateResult(preview, "Assault", "boss");
  assert.equal(result.action?.damage, 1);
  assert.equal(result.actionHp, 0);
  assert.deepEqual(result.shoves, []);
  assert.deepEqual(result.kills, [{ kind: "boss", id: "boss", source: "direct" }]);
  const html = await render(result, preview);
  assert.match(html, /No push occurred\./);
  assert.match(html, /This action destroyed.*boss/);
  assert.doesNotMatch(html, /Push direction|No collision\./);
});

test("a fizzled selected action is not presented as a zero-damage attack or push", async () => {
  const preview = collisionCase();
  const result = candidateResult(preview, "Gunner", "boss");
  assert.equal(result.action?.cause, "mech_dead");
  assert.equal(result.action?.fizzled, true);
  assert.deepEqual(result.shoves, []);
  const html = await render(result, preview);
  assert.match(html, /cooldown/i);
  assert.doesNotMatch(html, /Direct damage|No push occurred|Push direction/);
});

test("missing, invalid and unavailable predictions never display stale consequences", async () => {
  const preview = collisionCase();
  const result = candidateResult(preview, "Assault", "boss");
  const unavailable = { ok: false, status: "unavailable", revision: preview.revision, draftVersion: preview.draftVersion };
  const invalid = { ok: false, status: "invalid", revision: preview.revision, draftVersion: preview.draftVersion,
    fault: { code: "PLAN_PACK_REJECTED", reason: "invalid", mechId: "Assault", cause: "not_adjacent" } };
  for (const candidate of [unavailable, invalid]) {
    const html = await render(result, candidate, preview);
    assert.match(html, /unavailable|invalid/i);
    assert.doesNotMatch(html, /Direct damage|Push direction|Target HP|Whole.turn|Gunner HP/);
  }
  const missingAction = candidateResult(preview, "Support", "boss");
  assert.equal(missingAction.action, null);
  const html = await render(missingAction, preview);
  assert.doesNotMatch(html, /Direct damage|No push occurred|Whole.turn/);
});

test("water, mountain, cover and obstacle share an unspecified wall collision without invented details", async () => {
  for (const kind of ["water", "mountain", "cover", "obstacle"] as const) {
    const terrain: ("land" | "water" | "mountain")[][] = Array.from({ length: 10 }, () => Array(10).fill("land"));
    if (kind === "water" || kind === "mountain") terrain[1]![6] = kind;
    const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", terrain,
      covers: kind === "cover" ? [{ x: 6, y: 1 }] : [], obstacles: kind === "obstacle" ? [{ x: 6, y: 1 }] : [],
      buildings: [], raiders: [], boss: { x: 4, y: 0 },
      mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }] });
    bossPrepare(state);
    const preview = ready(state, { revision: state.revision, items: [{ mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } }] });
    const result = candidateResult(preview, "Assault", "boss");
    const shove = result.shoves[0]!;
    assert.equal(shove.event.hit, "wall", kind);
    assert.equal(shove.event.damage, 2, kind);
    assert.deepEqual(shove.from, shove.to, kind);
    assert.equal(result.actionHp, state.boss.hp - result.action!.damage - shove.event.damage, kind);
    const html = await render(result, preview);
    assert.match(html, /terrain, obstacle or boundary \(exact type unknown\)/);
    assert.match(html, /boss HP 38 → 36/);
    assert.doesNotMatch(html, /colli(?:ded|sion) (?:with |at )?(?:water|mountain|cover)/i);
  }
});

test("zero actual repair stays zero and does not invent damage, displacement or collision", async () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 0, y: 9 } }, { id: "Gunner", pos: { x: 7, y: 8 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(state);
  const preview = ready(state, { revision: state.revision, items: [{ mechId: "Support", moveTo: null, action: { kind: "repair", target: "Gunner" } }] });
  const result = candidateResult(preview, "Support", "Gunner");
  assert.equal(result.action?.damage, 0);
  assert.equal(result.healing, 0);
  assert.deepEqual(result.shoves, []);
  const html = await render(result, preview);
  assert.match(html, /Actual repair \+0/);
  assert.doesNotMatch(html, /No push occurred\./);
  assert.doesNotMatch(html, /Push direction|Collision destroyed/);
});

test("push direction follows each real rule event, not the displayed attacker position", async () => {
  for (const { pos, dir, landing, text } of [
    { pos: { x: 6, y: 4 }, dir: { x: -1, y: 0 }, landing: { x: 3, y: 4 }, text: /\(-1, 0\)/ },
    { pos: { x: 4, y: 3 }, dir: { x: 0, y: 1 }, landing: { x: 4, y: 5 }, text: /\(0, \+1\)/ },
    { pos: { x: 4, y: 6 }, dir: { x: 0, y: -1 }, landing: { x: 4, y: 3 }, text: /\(0, -1\)/ },
  ]) {
    const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 4 },
      mechs: [{ id: "Assault", pos }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }] });
    bossPrepare(state);
    const preview = ready(state, { revision: state.revision, items: [{ mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } }] });
    const result = candidateResult(preview, "Assault", "boss");
    assert.deepEqual(result.shoves[0]?.event.dir, dir);
    assert.deepEqual(result.shoves[0]?.to, landing);
    assert.match(await render(result, preview), text);
  }
});
