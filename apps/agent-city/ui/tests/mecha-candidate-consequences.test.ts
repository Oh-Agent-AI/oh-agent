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

test("charge uses the same committed shove for preview and playback, including collision", async () => {
  const { performanceFromLog } = await import("../src/game/mecha/performance.ts");
  for (const blocked of [false, true]) {
    const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [],
      boss: { x: 4, y: 4 }, obstacles: blocked ? [{ x: 6, y: 4 }] : [],
      mechs: [{ id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] });
    bossPrepare(state);
    const preview = ready(state, { revision: state.revision, items: [{ mechId: "Assault", moveTo: null, action: { kind: "charge", target: "boss" } }] });
    const result = candidateResult(preview, "Assault", "boss");
    assert.equal(result.action?.damage, 4);
    assert.equal(result.shoves.length, 1);
    const shove = result.shoves[0]!;
    assert.equal(Boolean(shove.event.hit), blocked);
    assert.deepEqual(shove.from, { x: 4, y: 4 });
    assert.deepEqual(shove.to, blocked ? { x: 4, y: 4 } : { x: 5, y: 4 });
    const eventIndex = preview.log.indexOf(shove.event);
    const cues = performanceFromLog(state, preview.stages!.afterPrepare, preview.log);
    const playback = cues.find(cue => cue.kind === "knockback" && cue.sourceLogIndex === eventIndex);
    if (blocked) assert.equal(playback, undefined, "collision must not fabricate displacement");
    else {
      assert.ok(playback && playback.kind === "knockback");
      assert.deepEqual(playback.path, [shove.from, shove.to], "preview and playback derive the same movement");
    }
  }
});

test("shove projection preserves blocked and unavailable evidence without mutating inputs", async () => {
  const { projectShove } = await import("../src/game/mecha/skillEffects.ts");
  const origin = { x: 4, y: 4 };
  const event = { type: "shove" as const, unit: "boss" as const, dir: { x: 1, y: 0 }, hit: "wall", damage: 2 };
  const before = structuredClone(event);
  assert.deepEqual(projectShove(event, origin), { status: "blocked", from: origin, to: origin });
  assert.deepEqual(projectShove(event, undefined), { status: "unknown", from: null, to: null });
  const moving = { ...event, hit: undefined };
  assert.deepEqual(projectShove(moving, origin), { status: "moved", from: origin, to: { x: 5, y: 4 } });
  assert.deepEqual(event, before);
  assert.deepEqual(origin, { x: 4, y: 4 });
});

test("movement effect projection preserves phase swap groups and never fabricates shove origins", async () => {
  const { projectMovementEffect } = await import("../src/game/mecha/skillEffects.ts");
  const swap = { type: "monster_displacement" as const, skill: "phase_swap" as const, moves: [
    { unit: "boss", from: { x: 4, y: 4 }, to: { x: 7, y: 7 } },
    { unit: "mech:Assault", from: { x: 7, y: 7 }, to: { x: 4, y: 4 } },
  ] };
  const original = structuredClone(swap);
  const projected = projectMovementEffect(swap);
  assert.equal(projected.mode, "phase_swap");
  assert.deepEqual(projected.moves.map(m => [m.actor, m.from, m.to]), [
    ["boss", { x: 4, y: 4 }, { x: 7, y: 7 }], ["Assault", { x: 7, y: 7 }, { x: 4, y: 4 }],
  ]);
  projected.moves[0]!.to!.x = 0;
  assert.deepEqual(swap, original, "projections cannot mutate authority events");
  const shove = { type: "shove" as const, unit: "boss" as const, dir: { x: 1, y: 0 }, damage: 0 };
  assert.equal(projectMovementEffect(shove).moves[0]!.status, "unknown");
  assert.equal(projectMovementEffect({ ...shove, hit: "wall" }, { x: 4, y: 4 }).moves[0]!.status, "blocked");
});

test("building collision projection deduplicates footprints and does not mutate authority state", async () => {
  const { projectBuildingCollision } = await import("../src/game/mecha/skillEffects.ts");
  const buildings = [
    { id: "a", hp: 5, cells: [{ x: 6, y: 0 }, { x: 6, y: 1 }] },
    { id: "b", hp: 1, cells: [{ x: 7, y: 1 }] },
    { id: "ruin", hp: 0, cells: [{ x: 7, y: 0 }] },
  ];
  const before = structuredClone(buildings);
  assert.deepEqual(projectBuildingCollision([{ x: 6, y: 0 }, { x: 6, y: 1 }, { x: 7, y: 1 }], buildings, 2), [
    { id: "a", before: 5, after: 3 }, { id: "b", before: 1, after: 0 },
  ]);
  assert.deepEqual(buildings, before);
  assert.throws(() => projectBuildingCollision([], buildings, -1), /invalid_collision_damage/);
  assert.throws(() => projectBuildingCollision([], [...buildings, buildings[0]!], 2), /invalid_collision_building/);
});

test("staged v1.5 building collisions damage both sides once while v1.4 remains unchanged", async () => {
  const { tryTranslateBoss, tryPushMech } = await import("../src/game/mecha/combat.ts");
  const { swapEventSink } = await import("../src/game/mecha/board.ts");
  for (const ruleset of ["mecha-v1.4", "mecha-v1.5"] as const) {
    const state = createMatch({ ruleset, preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], raiders: [],
      boss: { x: 4, y: 4 }, buildings: [{ id: "tower", cells: [{ x: 6, y: 4 }, { x: 6, y: 5 }], hp: 5 }],
      mechs: [{ id: "Assault", pos: { x: 1, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] });
    const events: import("../src/game/mecha/board.ts").TurnEvent[] = [];
    const previous = swapEventSink(events);
    try { assert.equal(tryTranslateBoss(state, { x: 1, y: 0 }), false); } finally { swapEventSink(previous); }
    assert.deepEqual(state.boss.anchor, { x: 4, y: 4 });
    assert.equal(state.boss.hp, 38);
    assert.equal(state.buildings[0]!.hp, ruleset === "mecha-v1.5" ? 3 : 5);
    const shove = events.find(e => e.type === "shove"); assert.ok(shove && shove.type === "shove");
    assert.equal(shove.effects?.filter(e => e.kind === "building").length ?? 0, ruleset === "mecha-v1.5" ? 1 : 0);
    const mechState = createMatch({ ruleset, preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], raiders: [],
      boss: { x: 7, y: 7 }, buildings: [{ id: "tower", cells: [{ x: 2, y: 1 }], hp: 5 }],
      mechs: [{ id: "Assault", pos: { x: 1, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] });
    assert.equal(tryPushMech(mechState, "Assault", { x: 1, y: 0 }), false);
    assert.deepEqual(mechState.mechs[0]!.pos, { x: 1, y: 1 });
    assert.equal(mechState.mechs[0]!.hp, 12);
    assert.equal(mechState.buildings[0]!.hp, ruleset === "mecha-v1.5" ? 3 : 5);
  }
});

test("staged building collision preserves shield and records building destruction", async () => {
  const { tryTranslateBoss } = await import("../src/game/mecha/combat.ts");
  const { swapEventSink } = await import("../src/game/mecha/board.ts");
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], raiders: [],
    boss: { x: 4, y: 4 }, monsterContent: { speciesId: "prism_warden", contentVersion: 1 },
    buildings: [{ id: "tower", cells: [{ x: 6, y: 4 }, { x: 6, y: 5 }], hp: 1 }],
    mechs: [{ id: "Assault", pos: { x: 1, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] });
  state.boss.shield = { kind: "prism_guard", hits: 1 };
  const events: import("../src/game/mecha/board.ts").TurnEvent[] = [];
  const old = swapEventSink(events);
  try { assert.equal(tryTranslateBoss(state, { x: 1, y: 0 }), false); } finally { swapEventSink(old); }
  assert.equal(state.boss.hp, 40); assert.equal(state.boss.shield, undefined);
  assert.equal(state.buildings[0]!.hp, 0); assert.equal(state.outcome, "defeat_buildings");
  assert.ok(events.some(e => e.type === "monster_status" && e.change === "absorbed"));
  assert.ok(events.some(e => e.type === "shove" && e.effects?.some(effect => effect.kind === "building" && effect.before === 1 && effect.after === 0)));
});

test("staged v1.5 collision has identical preview, authority and health evidence", async () => {
  const { buildHealthTimeline } = await import("../src/game/mecha/healthTimeline.ts");
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], raiders: [],
    boss: { x: 4, y: 4 }, buildings: [{ id: "tower", cells: [{ x: 6, y: 4 }, { x: 6, y: 5 }], hp: 5 }],
    mechs: [{ id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] });
  bossPrepare(state);
  const plan: ArenaPlan = { revision: state.revision, items: [
    { mechId: "Assault", moveTo: null, action: { kind: "charge", target: "boss" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    { mechId: "Support", moveTo: null, action: { kind: "skip" } },
  ] };
  const preview = previewPlan(state, plan); const played = playTurn(state, plan);
  assert.ok(preview.ok && played.ok);
  assert.deepEqual(preview.log, played.log);
  const hit = played.log.find(e => e.type === "shove" && e.unit === "boss");
  assert.ok(hit && hit.type === "shove" && hit.hit);
  assert.ok(hit.effects?.some(e => e.kind === "building" && e.id === "tower" && e.before === 5 && e.after === 3));
  const timeline = buildHealthTimeline(state, played.state, played.log, played.presentationStages);
  assert.ok(timeline.ok, timeline.ok ? "" : timeline.reason);
});
