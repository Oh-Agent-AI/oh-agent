import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { legalActions } from "../src/game/mecha/combat.ts";
import { sequentialTargets } from "../src/game/mecha/actionTargets.ts";
import { SequentialController } from "../src/game/mecha/sequentialController.ts";
import { sequentialPresentation } from "../src/game/mecha/sequentialPresentation.ts";

function fixture() {
  return createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 4 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] });
}
test("implicit single target highlights every boss cell without altering legal action", () => {
  const state = fixture(), before = structuredClone(state), actions = legalActions(state, "Assault");
  const options = sequentialTargets(state, actions, "charge", "Assault");
  assert.equal(options.length, 1); assert.equal(options[0]!.id, "boss");
  assert.deepEqual(options[0]!.cells, [{ x: 4, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 5 }, { x: 5, y: 5 }]);
  assert.deepEqual(actions[options[0]!.actionIndex], { kind: "charge" }); assert.deepEqual(state, before);
});
test("selecting a boss footprint previews and commits the same collision damage", async () => {
  const state = fixture();
  state.buildings = [{ id: "tower", cells: [{ x: 6, y: 4 }, { x: 6, y: 5 }], hp: 5, maxHp: 5 }];
  bossPrepare(state);
  const controller = new SequentialController(state), actions = legalActions(state, "Assault");
  const selected = sequentialTargets(state, actions, "charge", "Assault").find(target => target.cells.some(cell => cell.x === 5 && cell.y === 5));
  assert.ok(selected); const action = actions[selected.actionIndex]!;
  const preview = controller.preview({ kind: "act", mech: "Assault", action }); assert.ok(preview?.ok);
  const effects = sequentialPresentation(state, preview.snapshot.match, preview.events, preview.presentationStages); assert.ok(effects.ok);
  assert.ok(effects.health.steps.some(step => step.effect.kind === "building" && step.effect.before === 5 && step.effect.after === 3));
  assert.ok(effects.health.steps.some(step => step.effect.kind === "boss"));
  assert.equal(controller.attachDurable({ async commit() {} }), true);
  await controller.executeDurable({ kind: "act", mech: "Assault", action });
  assert.deepEqual(controller.getState().match, preview.snapshot.match);
  assert.deepEqual(controller.getState().presentation?.events, preview.events);
});
test("multiple explicit targets keep their own action binding and repair marks only allies", () => {
  const state = fixture(); state.raiders.push({ id: "raider-a", pos: { x: 2, y: 4 }, hp: 4, intent: null });
  const actions = legalActions(state, "Assault"), options = sequentialTargets(state, actions, "melee", "Assault");
  assert.deepEqual(new Set(options.map(option => option.id)), new Set(["boss", "raider-a"]));
  for (const option of options) assert.equal((actions[option.actionIndex] as { target: string }).target, option.id);
  state.mechs.find(unit => unit.id === "Support")!.pos = { x: 1, y: 9 };
  const repair = legalActions(state, "Support"), targets = sequentialTargets(state, repair, "repair", "Support");
  assert.deepEqual(targets.map(option => option.id), ["Gunner"]);
  assert.deepEqual(sequentialTargets(state, repair, "skip", "Support"), []);
});
