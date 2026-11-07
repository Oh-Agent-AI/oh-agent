import assert from "node:assert/strict";
import test from "node:test";
import { blankDraft, checkDraftAction, checkDraftPlan, draftFromPlan, draftPlan, settledDraftBoard, type DraftAuthority } from "../src/game/mecha/planning.ts";
import { bossPrepare, createMatch, living, previewPlan, validateAndApplyPlan, type ArenaPlan, type MatchState } from "../src/game/mecha/rules.ts";
import { swapEventSink } from "../src/game/mecha/board.ts";
import { createMechaController } from "../src/game/mecha/controller.ts";

function pve(): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 }, mechs: [
    { id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 7, y: 8 } }, { id: "Support", pos: { x: 8, y: 9 } },
  ] });
  bossPrepare(state);
  return state;
}

test("draft assembly preserves moves, action modes, living order, and plan conversion", () => {
  const state = pve();
  state.mechs.find((m) => m.id === "Support")!.hp = 0;
  const draft = blankDraft(state);
  draft.Assault = { moveTo: { x: 3, y: 2 }, action: { kind: "melee", target: "boss" }, explicit: true };
  draft.Gunner = { moveTo: { x: 7, y: 7 }, action: { kind: "shoot", target: "boss" }, explicit: false };
  const normal = draftPlan(state, draft);
  assert.equal(normal.revision, state.revision);
  assert.deepEqual(normal.items.map((i) => i.mechId), living(state).map((m) => m.id));
  assert.deepEqual(normal.items.map((i) => i.action.kind), ["melee", "skip"]);
  assert.deepEqual(normal.items.map((i) => i.moveTo), [{ x: 3, y: 2 }, { x: 7, y: 7 }]);
  assert.deepEqual(draftPlan(state, draft, "movement").items.map((i) => i.action.kind), ["skip", "skip"]);
  assert.deepEqual(draftPlan(state, draft, { only: { id: "Gunner", action: { kind: "shoot", target: "boss" } } }).items.map((i) => i.action.kind), ["skip", "shoot"]);
  assert.deepEqual(draftFromPlan(state, normal).Gunner, { moveTo: { x: 7, y: 7 }, action: { kind: "skip" }, explicit: true });
  assert.equal(draftFromPlan(state, normal).Support.explicit, false);
  const before = structuredClone(state), board = settledDraftBoard(state, draft);
  assert.deepEqual(board.mechs.find((m) => m.id === "Assault")!.pos, { x: 3, y: 2 });
  board.mechs[0]!.pos.x = 0;
  assert.deepEqual(state, before);
});

test("PvE authority checks full movement and isolated action without mutating source or sink", () => {
  const state = pve(), before = structuredClone(state), draft = blankDraft();
  const outer: any[] = [];
  const previous = swapEventSink(outer);
  const authority: DraftAuthority = (plan) => {
    const sink = swapEventSink(null);
    try {
      const result = validateAndApplyPlan(structuredClone(state), plan);
      return "ok" in result ? result : { ok: false, fault: result };
    } finally { swapEventSink(sink); }
  };
  try {
    draft.Assault.moveTo = { x: 3, y: 2 };
    assert.equal(checkDraftPlan(draftPlan(state, draft, "movement"), authority).status, "ok");
    assert.equal(checkDraftAction(state, draft, "Assault", { kind: "melee", target: "boss" }, authority).status, "ok");
    draft.Assault.moveTo = null;
    assert.equal(checkDraftAction(state, draft, "Assault", { kind: "melee", target: "boss" }, authority).status, "rejected");
    draft.Assault.moveTo = { x: 7, y: 8 };
    assert.equal(checkDraftPlan(draftPlan(state, draft, "movement"), authority).status, "rejected");
    assert.deepEqual(outer, []);
    assert.deepEqual(state, before);
  } finally { swapEventSink(previous); }
});

test("authority exceptions stay unknown; controller preserves skip and failed revalidation behavior", () => {
  const state = pve(), draft = blankDraft();
  assert.deepEqual(checkDraftAction(state, draft, "Assault", { kind: "skip" }, () => { throw Error("unavailable"); }), { status: "unknown" });
  let fail = false, calls = 0;
  const planner = (s: MatchState): ArenaPlan => ({ revision: s.revision, items: living(s).map((m) => ({ mechId: m.id, moveTo: null, action: m.id === "Assault" ? { kind: "melee", target: "boss" } : { kind: "skip" } })) });
  const controller = createMechaController({ match: state, planner, validatePreview: (s, plan) => { calls++; if (fail) throw Error("unavailable"); return previewPlan(s, plan); } });
  controller.setAction("Gunner", { kind: "skip" });
  assert.equal(calls, 0, "local skip bypass remains unchanged");
  const before = structuredClone(controller.getState().draft);
  fail = true;
  controller.setMove("Assault", { x: 3, y: 2 });
  assert.deepEqual(controller.getState().draft, before);
  assert.match(controller.getState().notice ?? "", /暂不可用/);
  fail = false;
  controller.setMove("Assault", { x: 3, y: 2 });
  assert.deepEqual(controller.getState().draft.Assault.moveTo, { x: 3, y: 2 });
});
