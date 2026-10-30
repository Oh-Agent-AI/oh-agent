/**
 * 机甲战棋控制器守卫（整改规格 §3.5、验收 3/5/9/10）。
 * 控制器是纯 TS，所以这里不需要 React、DOM 或定时器：自动对战靠手动 tick() 推进，
 * 规划器用注入的计数桩，确认「每个局面只规划一次」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PLAN_FAULT_CAUSES, planFaultText } from "../apps/agent-city/ui/src/game/gameCopy.ts";
import { peelPlan, planForDoctrine, squadPlan, type DoctrineId } from "../apps/agent-city/ui/src/game/mecha/ai.ts";
import { createMechaController, cuesFromLog, type Planner } from "../apps/agent-city/ui/src/game/mecha/controller.ts";
import type { CityMechaSite } from "../apps/agent-city/ui/src/game/mecha/citySite.ts";
import { bossPrepare, createMatch, living, type ArenaPlan, type MatchState, type MechId, type TurnEvent } from "../apps/agent-city/ui/src/game/mecha/rules.ts";

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

test("hovering one enemy shows only that enemy's post-push telegraph", () => {
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
  assert.deepEqual(c.getState().telegraph, [], "an enemy with no telegraph contributes no cells");
  c.setHoveredEnemy(null);
  assert.deepEqual(c.getState().telegraph, preview.telegraphAfter);
  assert.equal(c.getState().preview.ok && c.getState().preview.hitsAfter.Assault, c.getState().hits.Assault);
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
