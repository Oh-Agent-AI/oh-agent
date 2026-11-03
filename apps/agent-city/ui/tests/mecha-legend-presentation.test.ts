import assert from "node:assert/strict";
import test from "node:test";
import { presentBattleLegend, type LegendSnapshot } from "../src/game/mecha/legendPresentation.ts";

const snapshot = (): LegendSnapshot => ({ declaredTelegraph: [{ x: 2, y: 3 }], projectedTelegraph: [{ x: 2, y: 3 }], reach: [], move: null });
for (const locale of ["zh-Hans", "en"] as const) {
  test(`${locale}: only two core threats with no operation, overlap is a note not a third symbol`, () => {
    const view = snapshot(), before = structuredClone(view), result = presentBattleLegend(view, locale);
    assert.deepEqual(result.threats.map(item => item.id), ["declared", "projected"]);
    assert.deepEqual(result.actions, []);
    assert.equal(result.projected, "present"); assert.equal(result.overlap, true); assert.ok(result.note);
    assert.deepEqual(view, before);
  });
  test(`${locale}: unknown prediction cannot imply safety or hide current declarations`, () => {
    const result = presentBattleLegend({ ...snapshot(), projectedTelegraph: null }, locale);
    assert.equal(result.projected, "unknown"); assert.equal(result.overlap, false); assert.equal(result.note, null);
    assert.match(result.threats[1]!.detail, /未知|Unknown/);
    assert.equal(result.threats[0]!.id, "declared");
    const none = presentBattleLegend({ ...snapshot(), projectedTelegraph: [] }, locale);
    assert.equal(none.projected, "none"); assert.match(none.threats[1]!.detail, /预测无攻击格|No attack cells predicted/);
    assert.notEqual(none.threats[1]!.detail, result.threats[1]!.detail);
    assert.equal(none.threats[0]!.id, "declared");
  });
  test(`${locale}: movement, destination and shove appear only for actual drawing inputs`, () => {
    const view = snapshot(); view.reach = [{ x: 1, y: 3 }];
    assert.deepEqual(presentBattleLegend(view, locale).actions.map(item => item.id), ["movement"]);
    view.move = { x: 1, y: 3 };
    assert.deepEqual(presentBattleLegend(view, locale).actions.map(item => item.id), ["movement", "landing"]);
    view.targetPreview = { shove: { from: { x: 2, y: 3 }, to: { x: 2, y: 4 } } };
    assert.deepEqual(presentBattleLegend(view, locale).actions.map(item => item.id), ["movement", "landing", "shove"]);
  });
  test(`${locale}: reachable danger retains movement and explains the overlapping markers`, () => {
    const view = snapshot(); view.reach = [...view.declaredTelegraph];
    for (const projected of [view.projectedTelegraph, null, []]) {
      view.projectedTelegraph = projected;
      const result = presentBattleLegend(view, locale);
      assert.equal(result.reachOverlap, true);
      assert.deepEqual(result.actions.map(item => item.id), ["movement"]);
      assert.match(result.actions[0]!.detail, /双菱形.*危险|twin diamonds.*threatened/);
      assert.equal(result.threats[0]!.id, "declared");
    }
    view.declaredTelegraph = [];
    const plain = presentBattleLegend(view, locale);
    assert.equal(plain.reachOverlap, false);
    assert.doesNotMatch(plain.actions[0]!.detail, /双菱形|twin diamonds/);
    view.reach = [];
    view.inspectionSegments = [{ kind: "attack" }];
    assert.deepEqual(presentBattleLegend(view, locale).actions, []);
    view.inspectionSegments = [{ kind: "move" }];
    assert.equal(presentBattleLegend(view, locale).actions[0]!.id, "movement");
  });
  test(`${locale}: deployment cells are valid placements, not a safety guarantee`, () => {
    const result = presentBattleLegend({ ...snapshot(), deployment: true, reach: [{x: 2, y: 3}] }, locale);
    assert.deepEqual(result.threats, []);
    assert.match(result.actions[0]!.detail, /可部署|valid placements/);
    assert.doesNotMatch(result.actions[0]!.detail, /安全|safe/);
  });
}
test("different current and projected cells do not manufacture an overlap warning", () => {
  const result = presentBattleLegend({ ...snapshot(), projectedTelegraph: [{ x: 3, y: 2 }] }, "en");
  assert.equal(result.projected, "present"); assert.equal(result.overlap, false); assert.equal(result.note, null);
});
for (const locale of ["zh-Hans", "en"] as const) {
  test(`${locale}: shove legend distinguishes landing from blocked origin`, () => {
    const view = snapshot();
    view.targetPreview = { shove: { from: {x: 4, y: 3}, to: {x: 5, y: 3} } };
    assert.match(presentBattleLegend(view, locale).actions.at(-1)!.detail, /落点框|brackets/);
    view.targetPreview = { shove: { from: {x: 4, y: 3}, to: {x: 4, y: 3}, blocked: true } };
    assert.match(presentBattleLegend(view, locale).actions.at(-1)!.detail, /受阻|blocked/);
  });
}
for (const locale of ["zh-Hans", "en"] as const) {
  test(`${locale}: selected target prediction is distinct from the current draft, including unknown and empty`, () => {
    const view = { ...snapshot(), predictionSource: "candidate" as const };
    const projected = presentBattleLegend(view, locale).threats[1]!;
    assert.match(projected.label, /目标试算|Target preview/);
    assert.match(projected.detail, /尚未确认|not confirmed/);
    const unknown = presentBattleLegend({ ...view, projectedTelegraph: null }, locale);
    assert.equal(unknown.projected, "unknown"); assert.match(unknown.threats[1]!.detail, /未知|Unknown/);
    const none = presentBattleLegend({ ...view, projectedTelegraph: [] }, locale);
    assert.equal(none.projected, "none"); assert.match(none.threats[1]!.detail, /预测无攻击格|No attack cells predicted/);
    assert.match(presentBattleLegend(snapshot(), locale).threats[1]!.label, /草稿预测|Plan prediction/);
  });
}
