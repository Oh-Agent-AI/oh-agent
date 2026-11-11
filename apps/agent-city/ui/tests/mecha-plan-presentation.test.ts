import assert from "node:assert/strict";
import test from "node:test";
import { blankDraft, type Draft } from "../src/game/mecha/planning.ts";
import { planActionLabel, planTargetLabel, presentPlanRow, projectedThreatState } from "../src/game/mecha/planPresentation.ts";

const present = (draft: Draft | undefined, openingSuggestion = false, hitDamage: number | null = null, locale: "zh-Hans" | "en" = "en") =>
  presentPlanRow({ draft, openingSuggestion, hitDamage, locale });

test("unplanned action is not an explicit hold and its move survives", () => {
  const draft = blankDraft().Assault;
  draft.moveTo = { x: 3, y: 2 };
  const before = structuredClone(draft);
  assert.deepEqual(present(draft), {
    actionState: "unplanned", openingSuggestion: false, movement: "3, 2", action: "Not chosen", target: null, hitDamage: null,
  });
  assert.deepEqual(draft, before);
  assert.equal(present(blankDraft().Assault).movement, "Stay");
  assert.equal(present(blankDraft().Assault, false, null, "zh-Hans").movement, "原位");
  assert.equal(present(undefined).movement, "Unknown");
  assert.equal(present(undefined).actionState, "unplanned");
  const retainedAction: Draft = { moveTo: { x: 1, y: 1 }, action: { kind: "shoot", target: "boss" }, explicit: false };
  assert.equal(present(retainedAction).action, "Not chosen");
  assert.equal(present(retainedAction).target, null);
});

test("opening suggestion is the supplied whole-draft flag, not row authorship", () => {
  const draft = blankDraft();
  draft.Assault = { moveTo: null, action: { kind: "melee", target: "boss" }, explicit: true };
  const suggested = present(draft.Assault, true);
  const changed = present(draft.Assault, false);
  assert.equal(suggested.actionState, "explicit-action");
  assert.equal(suggested.openingSuggestion, true);
  assert.deepEqual({ ...suggested, openingSuggestion: false }, changed);
  assert.equal(present(draft.Gunner, true).actionState, "unplanned");
  assert.equal(present(draft.Gunner, true).openingSuggestion, true);
});

test("explicit hold and attacks use board labels and actual target IDs", () => {
  assert.equal(present({ moveTo: null, action: { kind: "skip" }, explicit: true }).actionState, "explicit-hold");
  assert.equal(present({ moveTo: null, action: { kind: "skip" }, explicit: true }).action, "Hold");
  const attack: Draft = { moveTo: { x: 5, y: 4 }, action: { kind: "shoot", target: "raider-w" }, explicit: true };
  assert.equal(present(attack).action, "Shoot");
  assert.equal(present(attack).target, "West raider");
  assert.equal(present(attack, false, 0, "zh-Hans").target, "小怪西");
  assert.equal(present({ moveTo: null, action: { kind: "repair", target: "Gunner" }, explicit: true }).target, "Gunner");
  assert.equal(present({ moveTo: null, action: { kind: "charge" }, explicit: true }).target, "Not chosen");
  assert.equal(present({ moveTo: null, action: { kind: "melee", target: "unrecognized-id" }, explicit: true }).target, "unrecognized-id");
  assert.equal(planTargetLabel("boss", "en"), "Boss");
  assert.equal(planTargetLabel("constructor", "en"), "constructor");
  assert.deepEqual(["melee", "shoot", "charge", "pierce", "repair", "skip"].map((kind) => planActionLabel(kind as Draft["action"]["kind"], "en")), ["Melee", "Shoot", "Charge", "Pierce", "Repair", "Hold"]);
});

test("preview damage distinguishes unavailable, zero, and actual loss", () => {
  const draft = blankDraft().Assault;
  assert.equal(present(draft, false, null).hitDamage, null);
  assert.equal(present(draft, false, 0).hitDamage, 0);
  assert.equal(present(draft, false, 7).hitDamage, 7);
  assert.equal(present(draft, false, Number.NaN).hitDamage, null);
  assert.equal(present(draft, false, -1).hitDamage, null);
  assert.equal(present(draft, false, Number.POSITIVE_INFINITY).hitDamage, null);
});

test("projected threat unknown, no threat, and threat are distinct", () => {
  assert.equal(projectedThreatState(null), "unknown");
  assert.equal(projectedThreatState([]), "none");
  assert.equal(projectedThreatState([{ x: 1, y: 2 }]), "present");
});
