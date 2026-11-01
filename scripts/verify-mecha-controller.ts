/**
 * 机甲战棋控制器守卫（整改规格 §3.5、验收 3/5/9/10）。
 * 控制器是纯 TS，所以这里不需要 React、DOM 或定时器：自动对战靠手动 tick() 推进，
 * 规划器用注入的计数桩，确认「每个局面只规划一次」。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { PLAN_FAULT_CAUSES, gameText, planFaultText } from "../apps/agent-city/ui/src/game/gameCopy.ts";
import { peelPlan, planForDoctrine, squadPlan, type DoctrineId } from "../apps/agent-city/ui/src/game/mecha/ai.ts";
import { createMechaController, cuesFromLog, type Planner } from "../apps/agent-city/ui/src/game/mecha/controller.ts";
import { candidateResult } from "../apps/agent-city/ui/src/game/mecha/candidateResult.ts";
import type { CityMechaSite } from "../apps/agent-city/ui/src/game/mecha/citySite.ts";
import { bossPrepare, createMatch, living, previewPlan, type ArenaPlan, type MatchState, type MechId, type TurnEvent } from "../apps/agent-city/ui/src/game/mecha/rules.ts";

type Pos = { x: number; y: number };

/** 与 verify-mecha-tactics.ts 的 duel 同一局：大怪在 (4,0)，站桩砸击，无掩体。 */
function duel(mechs: Array<{ id: MechId; pos: Pos }>): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 }, mechs });
  bossPrepare(state);
  return state;
}

const NEAR_BOSS = [{ id: "Assault" as const, pos: { x: 3, y: 1 } }, { id: "Gunner" as const, pos: { x: 4, y: 4 } }, { id: "Support" as const, pos: { x: 8, y: 9 } }];

const hold = (state: MatchState): ArenaPlan => ({
  revision: state.revision,
  items: living(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })),
});

/** 数调用的规划器：calls 记下每次的 (revision, 打法)。 */
function counting(make: (state: MatchState, doctrine: DoctrineId) => ArenaPlan = hold) {
  const calls: Array<{ revision: number; doctrine: DoctrineId }> = [];
  const planner: Planner = (state, doctrine) => {
    calls.push({ revision: state.revision, doctrine });
    return make(state, doctrine);
  };
  return { planner, calls };
}

function fakeSite(opts: { blocked?: Pos[]; buildings?: Array<{ id: string; cells: Pos[] }> } = {}): CityMechaSite {
  const grid = <T,>(v: T) => Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => v));
  return {
    originX: 0, originZ: 0, yaw: 0, cellW: 1, cellD: 1,
    heights: grid(0),
    terrain: grid("land" as const),
    buildings: (opts.buildings ?? [{ id: "b1", cells: [{ x: 1, y: 1 }] }]).map((b) => ({ ...b, x: 0, z: 0, yaw: 0, ground: 0, height: 8 })),
    blocked: opts.blocked ?? [],
    mechs: [{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 5, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }],
    boss: { x: 4, y: 0 },
    raiders: [{ id: "raider-w", pos: { x: 1, y: 5 } }, { id: "raider-e", pos: { x: 8, y: 5 } }],
    spawnSpread: 0,
  } as unknown as CityMechaSite;
}

test("restart, script, shape and doctrine changes refill the draft from the planner", () => {
  const { planner, calls } = counting();
  const c = createMechaController({ planner });
  assert.equal(calls.length, 1, "the opening draft asks the planner once");
  assert.ok(Object.values(c.getState().draft).every((d) => d.explicit), "a fresh match starts with a doctrine-filled draft");

  c.restart({ script: "stationary_smash", preset: "covers_diag_corridor" });
  const afterScript = c.getState();
  assert.equal(afterScript.match.script, "stationary_smash");
  assert.equal(afterScript.preset, "covers_diag_corridor");
  assert.equal(calls.length, 2);
  assert.ok(Object.values(afterScript.draft).every((d) => d.explicit));

  // 换战场（站点）：楼和障碍格进规则，草稿重填，自动对战关闭。
  c.startAuto();
  c.restart({ site: fakeSite({ blocked: [{ x: 6, y: 6 }] }), script: "cadence_ssw", stake: "frontage" });
  const afterShape = c.getState();
  assert.equal(afterShape.auto, false);
  assert.equal(afterShape.stake, "frontage");
  assert.deepEqual(afterShape.match.obstacles, [{ x: 6, y: 6 }]);
  assert.equal(afterShape.match.buildings.length, 1, "D2=b: a non-siege script still carries the site's building");
  assert.equal(calls.length, 3);

  // 换打法：按新打法重填，规划器收到的是新打法。
  c.setDoctrine("peel");
  assert.equal(c.getState().doctrine, "peel");
  assert.deepEqual(calls.at(-1), { revision: afterShape.match.revision, doctrine: "peel" });
  assert.equal(calls.length, 4);
});

test("with the real planner, a doctrine change refills the draft with that doctrine's plan", () => {
  const c = createMechaController({ match: duel(NEAR_BOSS) });
  c.setDoctrine("peel");
  const want = peelPlan(c.getState().match).items;
  for (const item of want) assert.deepEqual(c.getState().draft[item.mechId], { moveTo: item.moveTo, action: item.action, explicit: true });
  c.setDoctrine("tunnel");
  for (const item of squadPlan(c.getState().match).items) assert.deepEqual(c.getState().draft[item.mechId].action, item.action);
  c.applyDoctrine("peel");
  assert.equal(c.getState().doctrine, "peel");
  assert.deepEqual(planForDoctrine(c.getState().match, "peel").items.map((i) => i.mechId), want.map((i) => i.mechId));
});

test("manual draft then submit advances one turn; cues come only from acts that took effect", () => {
  const match = duel(NEAR_BOSS);
  match.boss.hp = 1;
  const c = createMechaController({ match, planner: hold });
  const before = c.getState();
  c.setAction("Assault", { kind: "melee", target: "boss" });
  c.setAction("Gunner", { kind: "shoot", target: "boss" });
  assert.equal(c.getState().fault, null);
  assert.equal(c.getState().packReady, true);
  c.submit();
  const after = c.getState();
  assert.equal(after.match.outcome, "victory");
  assert.ok(after.lastLog.some((e) => e.type === "act" && e.fizzled && e.mechId === "Gunner"), "the overkill shot fizzled");
  assert.deepEqual(after.combat.actions, [{ actor: "Assault", action: "attack", target: "boss" }], "a fizzled shot plays no attack");
  assert.equal(after.combat.id, before.combat.id + 1);
  assert.ok(Object.values(after.draft).every((d) => !d.explicit), "the next turn's draft starts blank");
});

test("a normal turn advances turn and revision, and the enemy strike becomes a cue", () => {
  const c = createMechaController({ match: duel(NEAR_BOSS), planner: hold });
  const before = c.getState().match;
  c.submit();
  const after = c.getState();
  assert.equal(after.match.turn, before.turn + 1);
  assert.ok(after.match.revision > before.revision);
  assert.equal(after.match.phase, "player_plan", "playTurn hands back a fully prepared next turn");
  assert.ok(after.combat.actions.some((cue) => cue.actor === "boss" && cue.action === "attack"));
  assert.equal(after.combat.healthTimeline?.ok, true, "accepted turns provide a reconciled presentation timeline");
  assert.equal(after.combat.presentationRoutes?.ok, true, "accepted turns provide movement routes for presentation");
  assert.equal(after.notice, null);
});

test("cuesFromLog skips fizzled acts and builds repair and enemy cues", () => {
  const log: TurnEvent[] = [
    { type: "move", mechId: "Assault", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    { type: "act", mechId: "Assault", action: "melee", target: "boss", damage: 3 },
    { type: "act", mechId: "Gunner", action: "shoot", target: "boss", damage: 0, fizzled: true, cause: "target_gone" },
    { type: "act", mechId: "Support", action: "repair", target: "Assault", damage: 0 },
    { type: "shove", unit: "boss", dir: { x: 1, y: 0 }, damage: 0 },
    { type: "enemy", actor: "raider-w", skill: "smash", cells: [], damage: 0 },
  ];
  assert.deepEqual(cuesFromLog(log), [
    { actor: "Assault", action: "attack", target: "boss" },
    { actor: "Support", action: "repair", target: "Assault" },
    { actor: "raider-w", action: "attack" },
  ]);
});

test("a rejected submit leaves the match alone, names the mech in the player's language, and plays no cues", () => {
  const badPlan: Planner = (state) => ({
    revision: state.revision,
    items: living(state).map((m) => ({ mechId: m.id, moveTo: null, action: m.id === "Gunner" ? { kind: "melee" as const } : { kind: "skip" as const } })),
  });
  const c = createMechaController({ match: duel(NEAR_BOSS), planner: badPlan });
  const before = c.getState();
  assert.equal(before.packReady, true);
  c.submit();
  const after = c.getState();
  assert.equal(after.match, before.match, "the match object is untouched");
  assert.deepEqual(after.match, before.match);
  assert.equal(after.combat, before.combat, "no cue, not even an empty one, for a rejected pack");
  assert.deepEqual(after.lastLog, []);
  assert.equal(after.fault?.mechId, "Gunner");
  assert.equal(after.fault?.scope, "rejected");
  assert.ok(after.notice?.includes("射手"), after.notice ?? "");
  assert.deepEqual(after.draft, before.draft, "the player can fix the draft and resubmit");
  c.setLocale("en");
  assert.ok(c.getState().notice?.includes("Gunner"));
  assert.equal(/\p{Script=Han}/u.test(c.getState().notice ?? ""), false);
});

test("auto mode plans once per revision: the show beat and the resolve beat share one plan", () => {
  const { planner, calls } = counting();
  const c = createMechaController({ match: duel(NEAR_BOSS), planner });
  assert.equal(calls.length, 1);
  c.setDoctrine("tunnel");
  assert.equal(calls.length, 1, "same revision, same doctrine: cache hit");
  c.startAuto();
  assert.equal(c.getState().auto, true);
  const turn = c.getState().match.turn;
  c.tick();
  assert.equal(c.getState().beat, "resolve");
  assert.ok(Object.values(c.getState().draft).every((d) => d.explicit), "the show beat paints the plan into the draft");
  c.tick();
  assert.equal(c.getState().match.turn, turn + 1);
  assert.equal(c.getState().beat, "show");
  assert.equal(calls.length, 1, "both beats of turn 1 reused the opening plan");
  c.tick();
  c.tick();
  assert.equal(c.getState().match.turn, turn + 2);
  assert.equal(calls.length, 2, "exactly one more plan for turn 2");
  assert.notEqual(calls[0]!.revision, calls[1]!.revision);
});

test("doctrine changes are frozen during pause and resume in manual or auto play", () => {
  for (const auto of [false, true]) {
    const { planner, calls } = counting((state, doctrine) => ({
      revision: state.revision,
      items: living(state).map((m) => ({
        mechId: m.id, moveTo: null,
        action: doctrine === "peel" && m.id === "Assault" ? { kind: "melee" as const, target: "boss" as const } : { kind: "skip" as const },
      })),
    }));
    const c = createMechaController({ match: duel(NEAR_BOSS), planner });
    if (auto) c.startAuto();
    c.pause();
    const frozen = c.getState();
    const draft = structuredClone(frozen.draft);
    const callCount = calls.length;
    c.setDoctrine("peel");
    assert.equal(c.getState(), frozen, `paused ${auto ? "auto" : "manual"} snapshot must not change`);
    assert.deepEqual(c.getState().draft, draft);
    assert.equal(calls.length, callCount, "a paused doctrine change must not invoke the planner");
    c.resume();
    c.setDoctrine("peel");
    assert.equal(c.getState().doctrine, "peel");
    assert.deepEqual(c.getState().draft.Assault.action, { kind: "melee", target: "boss" }, "the resumed doctrine refills the draft");
    assert.equal(calls.length, callCount + 1, "after resume the new doctrine is planned even in auto mode");
    assert.deepEqual(calls.at(-1), { revision: c.getState().match.revision, doctrine: "peel" });
  }
});

test("doctrine changes are ignored outside the player planning phase", () => {
  const match = duel(NEAR_BOSS);
  match.phase = "enemy_prepare";
  const { planner, calls } = counting();
  const c = createMechaController({ match, planner });
  const frozen = c.getState();
  const callCount = calls.length;
  c.setDoctrine("peel");
  assert.equal(c.getState(), frozen);
  assert.equal(calls.length, callCount);
});

test("pause stops ticks and resume continues; an outcome stops auto", () => {
  const paused = createMechaController({ match: duel(NEAR_BOSS), planner: hold });
  paused.startAuto();
  paused.pause();
  const frozen = paused.getState();
  paused.tick();
  assert.equal(paused.getState(), frozen, "a paused tick changes nothing");
  assert.equal(frozen.interactive, false);
  paused.resume();
  paused.tick();
  assert.equal(paused.getState().beat, "resolve");
  paused.stopAuto();
  const stopped = paused.getState();
  paused.tick();
  assert.equal(paused.getState(), stopped, "a tick without auto changes nothing");

  const match = duel(NEAR_BOSS);
  match.boss.hp = 1;
  const finisher: Planner = (state) => ({
    revision: state.revision,
    items: living(state).map((m) => ({ mechId: m.id, moveTo: null, action: m.id === "Assault" ? { kind: "melee" as const, target: "boss" } : { kind: "skip" as const } })),
  });
  const c = createMechaController({ match, planner: finisher });
  c.startAuto();
  c.tick();
  c.tick();
  assert.equal(c.getState().match.outcome, "victory");
  assert.equal(c.getState().auto, false, "the outcome ends the auto run");
  const done = c.getState();
  c.tick();
  assert.equal(c.getState(), done);
});

test("commands after the match is finished are ignored", () => {
  const match = duel(NEAR_BOSS);
  match.boss.hp = 1;
  const c = createMechaController({ match, planner: hold });
  c.setAction("Assault", { kind: "melee", target: "boss" });
  c.submit();
  const done = c.getState();
  assert.equal(done.match.outcome, "victory");
  c.setMove("Assault", { x: 3, y: 2 });
  c.setAction("Assault", { kind: "skip" });
  c.setTargeting("melee");
  c.clickCell(3, 2);
  c.applyDoctrine("peel");
  c.setDoctrine("peel");
  c.submit();
  c.startAuto();
  c.pause();
  assert.equal(c.getState(), done, "no command changed anything, not even the snapshot identity");
  c.restart();
  assert.equal(c.getState().match.outcome, null, "restart is the way out");
});

test("moving onto another mech's drafted destination sends that mech back to unplanned", () => {
  const c = createMechaController({
    match: duel([{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 3, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }]),
    planner: hold,
  });
  c.setMove("Gunner", { x: 3, y: 8 });
  c.setAction("Gunner", { kind: "skip" });
  assert.deepEqual(c.getState().draft.Gunner, { moveTo: { x: 3, y: 8 }, action: { kind: "skip" }, explicit: true });
  c.setMove("Assault", { x: 3, y: 8 });
  const s = c.getState();
  assert.deepEqual(s.draft.Assault.moveTo, { x: 3, y: 8 });
  assert.deepEqual(s.draft.Gunner, { moveTo: null, action: { kind: "skip" }, explicit: false });
  assert.deepEqual([s.fault?.mechId, s.fault?.cause, s.fault?.scope], ["Gunner", "occupied", "draft"]);
  assert.ok(s.notice?.includes("射手"));

  // 目标格上站着一台不打算动的队友：这一步不成立，草稿原样。
  const stay = c.getState();
  c.setMove("Support", { x: 8, y: 9 });
  c.setMove("Assault", { x: 3, y: 9 });
  assert.notEqual(c.getState().fault, null);
  assert.deepEqual(c.getState().draft.Assault, stay.draft.Assault);
  // 跟随走位（v1.4）：队友原位的格子，只要队友自己也走开，就能进。
  c.setMove("Gunner", { x: 3, y: 8 });
  assert.deepEqual(c.getState().draft.Gunner.moveTo, { x: 3, y: 8 });
});

test("a mech's move re-validates the others' actions on the new post-move board", () => {
  // Gunner (4,4) 隔着 (4,3)(4,2) 打大怪；Support 走到 (4,3) 挡住射线，Gunner 的射击作废。
  const c = createMechaController({
    match: duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 4, y: 4 } }, { id: "Support", pos: { x: 3, y: 3 } }]),
    planner: hold,
  });
  c.setAction("Gunner", { kind: "shoot", target: "boss" });
  assert.equal(c.getState().draft.Gunner.action.kind, "shoot");
  c.setMove("Support", { x: 4, y: 3 });
  const s = c.getState();
  assert.deepEqual(s.draft.Gunner, { moveTo: null, action: { kind: "skip" }, explicit: false });
  assert.equal(s.fault?.mechId, "Gunner");
  assert.equal(s.fault?.scope, "draft");
  assert.ok(["out_of_reach", "not_adjacent", "other"].includes(s.fault?.cause ?? ""));
  assert.ok(s.notice?.includes("射手"));
  // 反过来：Support 退回，射击重新合法。
  c.setMove("Support", null);
  assert.ok(c.getState().actions.length >= 1);
  c.selectMech("Gunner");
  assert.ok(c.getState().actions.some((a) => a.kind === "shoot"));
});

test("preview reports the telegraph after an Assault shove, and hitsAfter reflects it", () => {
  // 空计划 = 空白草稿：没排的机甲由 previewPlan 当待机假设。
  const blank: Planner = (state) => ({ revision: state.revision, items: [] });
  const c2 = createMechaController({ match: duel(NEAR_BOSS), planner: blank });
  const base = c2.getState();
  // 还没排：Assault 站在 (3,1) 的预告格上，要挨打。
  assert.deepEqual(base.match.boss.intent!.projected, [{ x: 3, y: 1 }]);
  c2.setAction("Assault", { kind: "melee", target: "boss" });
  const s = c2.getState();
  assert.equal(s.preview.ok, true);
  if (!s.preview.ok) return;
  assert.deepEqual(s.preview.telegraphAfter, [{ x: 4, y: 1 }], "the shove carries the telegraph with the boss");
  assert.deepEqual(s.telegraph, [{ x: 4, y: 1 }], "the highlight follows the preview");
  assert.ok(base.hits.Assault > 0, "before the shove Assault is on the telegraph");
  assert.equal(s.hits.Assault, 0, "Assault stepped out of the shifted telegraph");
  assert.deepEqual(s.preview.assumed, ["Gunner", "Support"], "unplanned mechs are assumed to hold");
  // 没推动时（Assault 待机）受击来自 hitsAfter。
  const idle = createMechaController({ match: duel(NEAR_BOSS), planner: hold });
  idle.setAction("Assault", { kind: "skip" });
  const idleState = idle.getState();
  assert.equal(idleState.preview.ok && idleState.preview.hitsAfter.Assault, idleState.hits.Assault);
  assert.ok(idleState.hits.Assault > 0);
});

test("undo move restores the previous draft before submit and does nothing after fire", () => {
  const c = createMechaController({ match: duel(NEAR_BOSS), planner: hold });
  assert.equal(c.getState().canUndoMove, false, "a doctrine fill is not a player move");
  c.selectMech("Assault");
  c.setMove("Assault", { x: 3, y: 2 });
  assert.deepEqual(c.getState().draft.Assault.moveTo, { x: 3, y: 2 });
  assert.equal(c.getState().canUndoMove, true);
  c.setMove("Assault", { x: 2, y: 2 });
  assert.deepEqual(c.getState().draft.Assault.moveTo, { x: 2, y: 2 });
  c.undoMove();
  assert.deepEqual(c.getState().draft.Assault.moveTo, { x: 3, y: 2 });
  c.undoMove();
  assert.equal(c.getState().draft.Assault.moveTo, null);
  assert.equal(c.getState().canUndoMove, false);
  c.undoMove();
  assert.equal(c.getState().draft.Assault.moveTo, null);
  c.setMove("Assault", { x: 3, y: 2 });
  c.submit();
  const fired = c.getState();
  assert.equal(fired.canUndoMove, false, "submitting the pack clears the move stack");
  c.undoMove();
  assert.equal(c.getState().match.revision, fired.match.revision);
  assert.deepEqual(c.getState().draft.Assault.moveTo, fired.draft.Assault.moveTo);
});

test("hovering highlights an enemy without hiding other threats", () => {
  const c = createMechaController({ match: duel(NEAR_BOSS), planner: hold });
  c.setAction("Assault", { kind: "melee", target: "boss" });
  const preview = c.getState().preview;
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.deepEqual(preview.telegraphByActor.boss, [{ x: 4, y: 1 }]);
  assert.deepEqual(c.getState().telegraph, preview.telegraphAfter);
  c.setHoveredEnemy("boss");
  assert.deepEqual(c.getState().telegraph, [{ x: 4, y: 1 }]);
  assert.equal(c.getState().hoveredEnemy, "boss");
  c.setHoveredEnemy("raider-w");
  assert.deepEqual(c.getState().telegraph, preview.telegraphAfter, "other threats remain visible");
  assert.deepEqual(c.getState().focusedTelegraph, [], "an enemy with no telegraph has no focused cells");
  c.setHoveredEnemy(null);
  assert.deepEqual(c.getState().telegraph, preview.telegraphAfter);
  assert.equal(c.getState().preview.ok && c.getState().preview.hitsAfter.Assault, c.getState().hits.Assault);
});

test("three threats remain attributable on one reachable repair target", () => {
  const shared = { x: 5, y: 2 };
  const state = createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 },
    raiders: [{ id: "raider-w", pos: { x: 4, y: 4 } }, { id: "raider-e", pos: { x: 6, y: 4 } }],
    mechs: [{ id: "Assault", pos: shared }, { id: "Gunner", pos: { x: 2, y: 8 } }, { id: "Support", pos: { x: 6, y: 2 } }],
  });
  bossPrepare(state);
  const c = createMechaController({ match: state, planner: hold });
  c.selectMech("Support");
  c.setTargeting("repair");
  const base = c.getState();
  assert.ok(base.preview.ok);
  if (!base.preview.ok) return;
  assert.ok(base.reach.some((cell) => cell.x === shared.x && cell.y === shared.y));
  assert.ok(base.targetOptions.some((target) => target.id === "Assault" && target.cells.some((cell) => cell.x === shared.x && cell.y === shared.y)));
  assert.deepEqual(base.telegraph, [shared], "shared threats are one graphical cell, not three duplicated cells");
  for (const actor of ["boss", "raider-w", "raider-e"]) {
    assert.deepEqual(base.preview.telegraphByActor[actor], [shared]);
    c.setSelectedEnemy(actor);
    assert.equal(c.getState().selectedEnemy, actor);
    assert.deepEqual(c.getState().focusedTelegraph, [shared]);
    assert.deepEqual(c.getState().telegraph, [shared]);
    c.setHoveredEnemy(actor);
    assert.deepEqual(c.getState().focusedTelegraph, [shared]);
    c.setHoveredEnemy(null);
  }
  const before = structuredClone(c.getState().draft);
  c.clickCell(shared.x, shared.y, "touch");
  assert.equal(c.getState().candidate?.target, "Assault");
  assert.equal(c.getState().candidate?.source, "selection");
  assert.deepEqual(c.getState().draft, before, "touch preview must not commit the repair");
  c.setTargeting(null);
  assert.equal(c.getState().candidate, null);
  assert.deepEqual(c.getState().draft, before, "cancelling the preview must not alter the plan");
});

test("every plan fault cause has Chinese and English text that names the mech", () => {
  const names: Record<MechId, [string, string]> = { Assault: ["突击", "Assault"], Gunner: ["射手", "Gunner"], Support: ["支援", "Support"] };
  const seen = new Set<string>();
  for (const cause of PLAN_FAULT_CAUSES) {
    for (const id of Object.keys(names) as MechId[]) {
      for (const scope of ["rejected", "draft"] as const) {
        const zh = planFaultText({ cause, mechId: id }, "zh-Hans", scope);
        const en = planFaultText({ cause, mechId: id }, "en", scope);
        assert.ok(zh.includes(names[id][0]), zh);
        assert.ok(en.includes(names[id][1]), en);
        assert.equal(/\p{Script=Han}/u.test(en), false, en);
        assert.equal(/Translation unavailable/.test(en), false, en);
        if (id === "Assault" && scope === "rejected") seen.add(zh);
      }
    }
  }
  assert.equal(seen.size, PLAN_FAULT_CAUSES.length, "each cause says something different");
  assert.deepEqual([...PLAN_FAULT_CAUSES].sort(), ["cooldown", "mech_dead", "not_adjacent", "occupied", "other", "out_of_reach", "target_gone"]);
  // 没有 mechId（如 revision 过期）：通用句，不编造机甲名。
  assert.equal(planFaultText({ cause: "other" }, "zh-Hans"), "整包被拒，局面未变，可以重提。");
  assert.equal(/\p{Script=Han}/u.test(planFaultText({ cause: "other" }, "en")), false);
});

test("combat reset is distinguishable from a committed turn", () => {
  const c = createMechaController({ planner: counting().planner });
  assert.equal(c.getState().combat.reset, true);
  c.startAuto(); c.tick(); c.tick();
  const played = c.getState().combat;
  assert.equal(played.reset, undefined);
  assert.ok(played.presentationStages);
  c.restart();
  assert.equal(c.getState().combat.reset, true);
  assert.equal(c.getState().combat.id, played.id + 1);
});

test("reset restores this turn's opening draft without moving the turn clock", () => {
  const c = createMechaController({ match: duel(NEAR_BOSS), planner: hold });
  const before = c.getState();
  const opening = structuredClone(before.draft);
  const clock = { turn: before.match.turn, revision: before.match.revision, combat: before.combat.id };
  c.selectMech("Assault");
  c.setMove("Assault", { x: 3, y: 2 });
  c.setTargeting("melee");
  c.setHoveredEnemy("boss");
  assert.equal(c.getState().canResetTurn, true);
  c.resetTurn();
  const after = c.getState();
  assert.equal(after.match, before.match, "reset is a draft rollback, not a rule-level turn");
  assert.deepEqual([after.match.turn, after.match.revision, after.combat.id], [clock.turn, clock.revision, clock.combat]);
  assert.deepEqual(after.draft, opening);
  assert.equal(after.targeting, null);
  assert.equal(after.hoveredEnemy, null);
  assert.equal(after.canUndoMove, false);
  assert.equal(after.canResetTurn, false, "the once-per-match reset is spent");
  assert.equal(after.resetTurnUsed, true);
  assert.match(after.notice ?? "", /重置/);
  const spent = after;
  c.resetTurn();
  assert.equal(c.getState(), spent, "a second reset in the same turn changes nothing");
});

test("reset never rewinds a committed turn and stays spent until restart", () => {
  const c = createMechaController({ match: duel(NEAR_BOSS), planner: hold });
  c.resetTurn();
  const used = c.getState();
  assert.equal(used.resetTurnUsed, true);
  c.submit();
  const next = c.getState();
  assert.equal(next.match.turn, used.match.turn + 1, "submit is the only thing that advances the turn");
  assert.equal(next.resetTurnUsed, true);
  assert.equal(next.canResetTurn, false, "fire does not refund the reset");
  const committed = next;
  c.resetTurn();
  assert.equal(c.getState(), committed, "a post-submit reset cannot roll the resolved turn back");
  c.restart();
  assert.equal(c.getState().resetTurnUsed, false, "a new match gets its own reset");
  assert.equal(c.getState().canResetTurn, true);
});

test("reset is unavailable after the match ends", () => {
  const match = duel(NEAR_BOSS);
  match.boss.hp = 1;
  const c = createMechaController({ match, planner: hold });
  c.setAction("Assault", { kind: "melee", target: "boss" });
  c.submit();
  const done = c.getState();
  assert.equal(done.match.outcome, "victory");
  assert.equal(done.canResetTurn, false);
  c.resetTurn();
  assert.equal(c.getState(), done);
});

const BOARD_URL = new URL("../apps/agent-city/ui/src/game/MechaBoard.tsx", import.meta.url);
const CSS_URL = new URL("../apps/agent-city/ui/src/game/game.css", import.meta.url);
const LINEUP_URL = new URL("../apps/agent-city/ui/src/game/MechaLineup.tsx", import.meta.url);
const boardSource = readFileSync(BOARD_URL, "utf8");
const cssSource = readFileSync(CSS_URL, "utf8");

/**
 * 入口门禁是产品行为，不是样式：空目录、搜索失败、视角被占都必须留在 CityGate，
 * 不能退回已经删掉的方格棋盘。组件没有可脱离 React 调用的导出，所以这里像
 * verify-city-mecha-ux 一样钉源码结构，补上 verify:mecha 之前没有覆盖的三条失败路径。
 */
test("battle entry gates empty, failed and taken-view cities without a fallback board", () => {
  assert.match(
    boardSource,
    /function catalogPlayable\(catalog: FightCatalog \| null\)[\s\S]{0,180}?SHAPES\.some/,
    "an empty catalog must be unplayable: at least one shape has to carry a site",
  );
  for (const branch of [
    'if (phase === "loading")',
    'if (phase === "error")',
    'if (!engine || !catalogPlayable(catalog))',
    'if (!controller || !s || !state || !site)',
    'if (viewFailed)',
  ]) {
    const start = boardSource.lastIndexOf(branch);
    assert.ok(start >= 0, `missing gate branch: ${branch}`);
    const body = boardSource.slice(start, start + 1000);
    assert.match(body, /<CityGate/, `${branch} must stay on the city gate`);
  }
  // 只有一个对局挂载点；viewFailed 在 MechaMatch 内部也必须换成 CityGate，而不是退回棋盘。
  assert.equal((boardSource.match(/<MechaMatch/g) ?? []).length, 1, "exactly one match mount");
  assert.match(boardSource, /if \(viewFailed\) controller\?\.stopAuto\(\)/);
  // The tile-information card is not the removed playable 2D grid. Keep
  // banning every legacy cell token except this exact new inspector class.
  const fallbackBoard = /MechaLineup|mecha-grid|mecha-cell(?!-inspector(?![\w-]))|方格棋盘|t\("布局"\)/;
  for (const legacy of ["MechaLineup", "mecha-grid", "mecha-cell", "mecha-cell-water", "mecha-cell-inspector-grid"]) {
    assert.match(legacy, fallbackBoard, "legacy fallback tokens must remain forbidden");
  }
  assert.doesNotMatch(".mecha-cell-inspector", fallbackBoard);
  assert.doesNotMatch(boardSource, fallbackBoard);
  assert.doesNotMatch(cssSource, /\.mecha-grid|\.mecha-cell/);
  assert.equal(existsSync(LINEUP_URL), false, "the modal lineup board is gone, not merely unused");
});

test("availability keeps empty catalog distinct from a failed search", () => {
  assert.match(boardSource, /if \(phase === "loading"\) onAvailability\("searching"\)/);
  assert.match(boardSource, /else if \(phase === "error"\) onAvailability\("error"\)/);
  assert.match(boardSource, /else onAvailability\(playable \? "ready" : "empty"\)/);
});

test("every gate title, body and literal label has an English copy key", () => {
  const gateText = [...boardSource.matchAll(/(?:title|body)="([^"]+)"/g)].map((match) => match[1]!);
  const labels = [...boardSource.matchAll(/\bt\("([^"\n]+)"\)/g)].map((match) => match[1]!);
  assert.ok(new Set(gateText).size >= 8, "the three refusal paths plus the search progress copy");
  assert.ok(new Set(labels).size >= 30, "the HUD's literal copy is part of this guard");
  for (const text of new Set([...gateText, ...labels])) {
    const en = gameText(text, "en");
    assert.equal(en.startsWith("Translation unavailable:"), false, text);
    assert.equal(/\p{Script=Han}/u.test(en), false, text);
  }
});

test("every action inspection description is localized", () => {
  const table = /const ACTION_DESCRIPTIONS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(boardSource)?.[1];
  assert.ok(table, "the action inspection table must be readable from the board source");
  const descriptions = [...table.matchAll(/:\s*"([^"]+)"/g)].map((match) => match[1]!);
  assert.equal(new Set(descriptions).size, 6, "every action kind has its own explanation");
  for (const text of descriptions) {
    const en = gameText(text, "en");
    assert.equal(en.startsWith("Translation unavailable:"), false, text);
    assert.equal(/\p{Script=Han}/u.test(en), false, text);
  }
});

test("preview preserves a planned move while assuming an unplanned action", () => {
  const match = duel(NEAR_BOSS);
  const c = createMechaController({ match, planner: (state) => ({ revision: state.revision, items: [] }) });
  c.setMove("Assault", { x: 3, y: 2 });
  const s = c.getState();
  assert.equal(s.packReady, false);
  assert.deepEqual(s.pendingIds, ["Assault", "Gunner", "Support"]);
  assert.ok(s.preview.ok);
  if (!s.preview.ok) return;
  assert.deepEqual(s.preview.assumed, ["Assault", "Gunner", "Support"]);
  assert.deepEqual(s.preview.stages?.afterMovement.mechs.find((m) => m.id === "Assault")?.pos, { x: 3, y: 2 });
  c.setAction("Assault", { kind: "skip" });
  const updated = c.getState();
  assert.ok(updated.preview.ok);
  if (updated.preview.ok) assert.deepEqual(updated.preview.assumed, ["Gunner", "Support"]);
});

test("a failed preview does not expose fallback damage as a prediction", () => {
  const match = duel(NEAR_BOSS);
  match.phase = "finished";
  match.outcome = "defeat_timeout";
  const c = createMechaController({ match, planner: hold });
  assert.equal(c.getState().preview.ok, false);
  assert.equal(c.getState().hits, null);
});

function holdRiskMatch(): MatchState {
  const state = createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 4 },
    buildings: [{ id: "b1", cells: [{ x: 3, y: 4 }] }, { id: "b2", cells: [{ x: 3, y: 5 }] },
      { id: "b3", cells: [{ x: 0, y: 0 }] }, { id: "b4", cells: [{ x: 1, y: 0 }] }, { id: "b5", cells: [{ x: 2, y: 0 }] }],
    mechs: [{ id: "Assault", pos: { x: 1, y: 9 } }, { id: "Gunner", pos: { x: 5, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }],
  });
  bossPrepare(state);
  state.boss.intent = { skillId: "sweep", local: [{ x: -1, y: 0 }, { x: -1, y: 1 }], projected: [{ x: 3, y: 4 }, { x: 3, y: 5 }], cdSweep: 0, status: "planned" };
  return state;
}

test("all-wait building risk requires an explicit confirmation that can be cancelled", () => {
  const c = createMechaController({ match: holdRiskMatch(), planner: hold });
  const turn = c.getState().match.turn;
  c.submit();
  assert.deepEqual(c.getState().holdConfirmation, { buildingLoss: 12, outcome: null });
  assert.equal(c.getState().match.turn, turn);
  c.cancelHold();
  assert.equal(c.getState().holdConfirmation, null);
  assert.equal(c.getState().match.turn, turn);
  c.submit();
  c.confirmHold();
  assert.equal(c.getState().holdConfirmation, null);
  assert.equal(c.getState().match.turn, turn + 1);
  assert.equal(c.getState().match.buildings.reduce((sum, building) => sum + building.hp, 0), 68);
});

test("hold confirmation expires on draft change, pause, doctrine change and restart", () => {
  const c = createMechaController({ match: holdRiskMatch(), planner: hold });
  const turn = c.getState().match.turn;
  c.submit();
  c.setMove("Assault", { x: 1, y: 8 });
  assert.equal(c.getState().holdConfirmation, null);
  c.confirmHold();
  assert.equal(c.getState().match.turn, turn);
  c.submit();
  assert.ok(c.getState().holdConfirmation);
  c.pause();
  assert.equal(c.getState().holdConfirmation, null);
  c.resume();
  c.submit();
  assert.ok(c.getState().holdConfirmation);
  c.setDoctrine("peel");
  assert.equal(c.getState().holdConfirmation, null);
  c.submit();
  assert.ok(c.getState().holdConfirmation);
  c.restart();
  assert.equal(c.getState().holdConfirmation, null);
});

test("safe all-wait submits without confirmation; timeout still requires it", () => {
  const state = holdRiskMatch();
  state.boss.intent = { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "void" };
  const c = createMechaController({ match: state, planner: hold });
  c.submit();
  assert.equal(c.getState().holdConfirmation, null);
  assert.equal(c.getState().match.turn, 2);
  const timed = holdRiskMatch();
  timed.boss.intent = { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "void" };
  timed.turn = 15;
  const d = createMechaController({ match: timed, planner: hold });
  d.submit();
  assert.deepEqual(d.getState().holdConfirmation, { buildingLoss: 0, outcome: "defeat_timeout" });
  d.confirmHold();
  assert.equal(d.getState().match.outcome, "defeat_timeout");
});


test("preview exceptions are unavailable, do not invent damage, and recover on the next update", () => {
  let failed = true;
  const c = createMechaController({ match: holdRiskMatch(), planner: hold, preview: (state, plan) => {
    if (failed) throw new Error("synthetic preview failure");
    return previewPlan(state, plan);
  } });
  const first = c.getState();
  assert.equal(first.preview.status, "unavailable");
  assert.equal(first.hits, null);
  assert.ok(first.telegraph.length > 0, "current threats remain available as a labeled fallback");
  assert.equal("buildings" in first.preview, false);
  assert.equal("enemyOrder" in first.preview, false);
  failed = false;
  c.setHoveredEnemy("boss");
  const recovered = c.getState();
  assert.equal(recovered.preview.status, "ready");
  assert.equal(recovered.preview.revision, recovered.match.revision);
  assert.equal(recovered.preview.draftVersion, first.preview.draftVersion, "focus is not a draft change");
  assert.ok(recovered.preview.ok && recovered.preview.buildings.some((b) => b.endHp < b.startHp));
});

test("preview versions follow draft, doctrine, reset and match changes rather than focus", () => {
  const c = createMechaController({ match: holdRiskMatch(), planner: hold });
  let version = c.getState().preview.draftVersion;
  c.setHoveredEnemy("boss");
  assert.equal(c.getState().preview.draftVersion, version);
  c.setMove("Assault", { x: 1, y: 8 });
  assert.ok(c.getState().preview.draftVersion > version);
  version = c.getState().preview.draftVersion;
  c.resetTurn();
  assert.ok(c.getState().preview.draftVersion > version);
  version = c.getState().preview.draftVersion;
  c.setDoctrine("tunnel");
  assert.ok(c.getState().preview.draftVersion > version, "refilling the same doctrine invalidates the prior request");
  version = c.getState().preview.draftVersion;
  c.restart();
  assert.ok(c.getState().preview.draftVersion > version);
  assert.equal(c.getState().preview.revision, c.getState().match.revision);
});

test("reset invalidates a hold confirmation even when the restored draft is identical", () => {
  const c = createMechaController({ match: holdRiskMatch(), planner: hold });
  c.submit();
  assert.ok(c.getState().holdConfirmation);
  c.resetTurn();
  assert.equal(c.getState().holdConfirmation, null);
  c.confirmHold();
  assert.equal(c.getState().match.turn, 1);
});

test("target previews are temporary, pinned touch selection survives hover, and confirmation only edits the draft", () => {
  const c = createMechaController({ match: duel(NEAR_BOSS), planner: hold });
  const before = structuredClone(c.getState().draft);
  const version = c.getState().draftVersion;
  c.setTargeting("melee");
  assert.ok(c.getState().targetOptions.some((option) => option.id === "boss"));
  c.previewTarget("boss", "hover");
  assert.equal(c.getState().candidate?.source, "hover");
  assert.deepEqual(c.getState().draft, before);
  assert.equal(c.getState().draftVersion, version);
  c.previewTarget(null, "hover");
  assert.equal(c.getState().candidate, null);
  c.clickCell(4, 0, "touch");
  assert.equal(c.getState().candidate?.source, "selection");
  c.previewTarget(null, "hover");
  assert.equal(c.getState().candidate?.target, "boss");
  assert.deepEqual(c.getState().draft, before);
  c.confirmTarget();
  assert.deepEqual(c.getState().draft.Assault.action, { kind: "melee", target: "boss" });
  assert.equal(c.getState().match.turn, 1);
  assert.equal(c.getState().candidate, null);
  assert.equal(c.getState().targeting, null);
});

test("a later candidate attributes only its own shove while replaying the earlier boss movement", () => {
  const match = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash",
    covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 4 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 4, y: 3 } }] });
  bossPrepare(match);
  const c = createMechaController({ match, planner: hold });
  c.setAction("Assault", { kind: "melee", target: "boss" });
  c.selectMech("Support");
  c.setTargeting("melee");
  const beforeDraft = structuredClone(c.getState().draft);
  const beforeMatch = structuredClone(c.getState().match);
  const beforeVersion = c.getState().draftVersion;
  c.previewTarget("boss", "selection");
  const preview = c.getState().candidate?.preview;
  assert.ok(preview && preview.ok, "the temporary candidate has a valid whole-turn preview");
  assert.deepEqual(c.getState().draft, beforeDraft);
  assert.deepEqual(c.getState().match, beforeMatch);
  assert.equal(c.getState().draftVersion, beforeVersion);

  const first = candidateResult(preview, "Assault", "boss");
  const second = candidateResult(preview, "Support", "boss");
  assert.equal(first.action?.damage, 2);
  assert.deepEqual(first.action?.effects?.map(({ id, before, after }) => ({ id, before, after })), [{ id: "boss", before: 40, after: 38 }]);
  assert.equal(first.shoves.length, 1);
  assert.deepEqual(first.shoves[0]!.from, { x: 4, y: 4 });
  assert.deepEqual(first.shoves[0]!.to, { x: 5, y: 4 });
  assert.equal(second.action?.damage, 1, "the second action excludes Assault's damage");
  assert.deepEqual(second.action?.effects?.map(({ id, before, after }) => ({ id, before, after })), [{ id: "boss", before: 38, after: 37 }]);
  assert.equal(second.shoves.length, 1, "the second action excludes Assault's shove");
  assert.deepEqual(second.shoves[0]!.from, { x: 5, y: 4 });
  assert.deepEqual(second.shoves[0]!.to, { x: 6, y: 4 });
  assert.equal(first.endHp, 37);
  assert.equal(second.endHp, 37, "end HP describes the whole plan, not only this action");
  assert.equal(preview.stages?.afterPlayer.boss.hp, 37);
  assert.deepEqual(preview.stages?.afterPlayer.boss.anchor, { x: 6, y: 4 });

  c.confirmTarget();
  assert.deepEqual(c.getState().draft.Support.action, { kind: "melee", target: "boss" });
  assert.deepEqual(c.getState().draft.Assault, beforeDraft.Assault);
  assert.deepEqual(c.getState().draft.Gunner, beforeDraft.Gunner);
  assert.deepEqual(c.getState().match, beforeMatch, "confirming the target only changes the draft");
  c.submit();
  const after = c.getState();
  assert.equal(after.match.turn, beforeMatch.turn + 1);
  assert.deepEqual(after.lastLog, preview.log);
  assert.deepEqual(after.combat.presentationStages?.afterPlayer, preview.stages?.afterPlayer);
  assert.equal(after.match.boss.hp, second.endHp);
});

test("a candidate reports a prior shove that makes its target nonadjacent as a fizzle", () => {
  const match = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 3, y: 2 } }]);
  const c = createMechaController({ match, planner: hold });
  c.setAction("Assault", { kind: "melee", target: "boss" });
  c.selectMech("Support");
  c.setTargeting("melee");
  const beforeDraft = structuredClone(c.getState().draft);
  c.previewTarget("boss", "selection");
  const preview = c.getState().candidate?.preview;
  assert.ok(preview && preview.ok, "the initially legal target can fizzle during resolution");
  const effect = candidateResult(preview, "Support", "boss");
  assert.deepEqual(effect.action, { type: "act", mechId: "Support", action: "melee", target: "boss", damage: 0, fizzled: true, cause: "not_adjacent" });
  assert.deepEqual(effect.shoves, [], "the previous mech's shove is not the candidate's effect");
  assert.equal(effect.endHp, 38);
  assert.deepEqual(c.getState().draft, beforeDraft);
  c.confirmTarget();
  c.submit();
  assert.deepEqual(c.getState().lastLog, preview.log);
  assert.equal(c.getState().match.boss.hp, effect.endHp);
  assert.ok(!c.getState().combat.actions.some((cue) => cue.actor === "Support"), "a fizzled candidate produces no attack cue");
});

test("candidate is invalidated by cancel, selection change, reset, pause, doctrine, and restart", () => {
  for (const change of [
    (c: ReturnType<typeof createMechaController>) => c.setTargeting(null),
    (c: ReturnType<typeof createMechaController>) => c.selectMech("Gunner"),
    (c: ReturnType<typeof createMechaController>) => c.resetTurn(),
    (c: ReturnType<typeof createMechaController>) => c.togglePause(),
    (c: ReturnType<typeof createMechaController>) => c.setDoctrine("peel"),
    (c: ReturnType<typeof createMechaController>) => c.restart(),
  ]) {
    const c = createMechaController({ match: duel(NEAR_BOSS), planner: hold });
    c.setTargeting("melee");
    c.previewTarget("boss", "selection");
    assert.ok(c.getState().candidate);
    change(c);
    assert.equal(c.getState().candidate, null);
  }
});

test("candidate prediction failure stays unavailable rather than becoming a zero damage result", () => {
  const c = createMechaController({ match: duel(NEAR_BOSS), planner: hold, preview: () => { throw new Error("prediction unavailable"); } });
  c.setTargeting("melee");
  c.previewTarget("boss", "selection");
  assert.equal(c.getState().candidate?.preview.status, "unavailable");
  assert.deepEqual(c.getState().draft.Assault.action, { kind: "skip" });
});

test("repair targets reflect every mech's planned movement", () => {
  const c = createMechaController({ match: duel([{ id: "Assault", pos: { x: 2, y: 8 } }, { id: "Gunner", pos: { x: 4, y: 8 } }, { id: "Support", pos: { x: 6, y: 9 } }]), planner: hold });
  c.setMove("Gunner", { x: 5, y: 8 });
  c.selectMech("Support");
  c.setTargeting("repair");
  const target = c.getState().targetOptions.find((option) => option.id === "Gunner");
  assert.deepEqual(target?.cells, [{ x: 5, y: 8 }]);
});

test("failed target legality validation is not reported as an illegal target or allowed to corrupt the draft", () => {
  const c = createMechaController({ match: duel(NEAR_BOSS), planner: hold, validatePreview: () => { throw new Error("failure"); } });
  const before = structuredClone(c.getState().draft);
  c.setTargeting("melee");
  assert.equal(c.getState().targetValidationUnavailable, true);
  assert.deepEqual(c.getState().targetOptions, []);
  c.clickCell(4, 0);
  assert.match(c.getState().notice ?? "", /暂不可用/);
  c.setAction("Assault", { kind: "melee", target: "boss" });
  assert.deepEqual(c.getState().draft, before);
});

test("hover predictions are cached for one draft and invalidated after a real edit", () => {
  let calls = 0;
  const c = createMechaController({ match: duel(NEAR_BOSS), planner: hold, preview: (state, plan) => { calls += 1; return previewPlan(state, plan); } });
  c.setTargeting("melee");
  c.previewTarget("boss", "hover");
  const initial = calls;
  c.previewTarget(null, "hover");
  c.previewTarget("boss", "hover");
  assert.equal(calls, initial);
  c.setTargeting(null);
  c.setMove("Support", { x: 8, y: 8 });
  c.setTargeting("melee");
  c.previewTarget("boss", "hover");
  assert.ok(calls > initial);
});

test("unavailable actions explain cooldown or the settled draft's missing targets without changing legality", () => {
  const match = duel([
    { id: "Assault", pos: { x: 1, y: 1 } },
    { id: "Gunner", pos: { x: 4, y: 4 } },
    { id: "Support", pos: { x: 8, y: 9 } },
  ]);
  match.mechs.find((m) => m.id === "Gunner")!.cd = 1;
  const c = createMechaController({ match, planner: hold });
  const missing = () => c.getState().unavailableActions;
  assert.deepEqual(missing(), [{ kind: "melee", reason: "no_target" }, { kind: "charge", reason: "no_target" }]);
  c.setMove("Assault", { x: 3, y: 1 });
  assert.ok(c.getState().actions.some((action) => action.kind === "melee"));
  assert.ok(c.getState().actions.some((action) => action.kind === "charge"));
  assert.deepEqual(missing(), [], "moving into reach must remove the now-available reasons");
  c.selectMech("Gunner");
  assert.ok(c.getState().actions.some((action) => action.kind === "shoot"));
  assert.deepEqual(missing(), [{ kind: "pierce", reason: "cooldown" }], "cooldown must not imply the normal shot is unavailable");
  c.selectMech("Support");
  assert.deepEqual(missing(), [{ kind: "melee", reason: "no_target" }, { kind: "shoot", reason: "no_target" }, { kind: "repair", reason: "no_target" }]);
  assert.ok(!missing().some((entry) => c.getState().actions.some((action) => action.kind === entry.kind)), "an available action must never also be listed as unavailable");
  assert.equal(match.mechs.find((m) => m.id === "Gunner")!.cd, 1, "the explanatory projection must not change rules state");
});

test("all three mech skills report cooldown rather than inventing a target-based reason", () => {
  const match = duel(NEAR_BOSS);
  for (const mech of match.mechs) mech.cd = 1;
  const c = createMechaController({ match, planner: hold });
  for (const [mech, skill] of [["Assault", "charge"], ["Gunner", "pierce"], ["Support", "repair"]] as const) {
    c.selectMech(mech);
    assert.deepEqual(c.getState().unavailableActions.find((entry) => entry.kind === skill), { kind: skill, reason: "cooldown" });
    assert.ok(!c.getState().actions.some((action) => action.kind === skill));
  }
});
