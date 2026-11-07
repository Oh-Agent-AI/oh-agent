import test from "node:test";
import assert from "node:assert/strict";
import { createMatch } from "../src/game/mecha/rules.ts";
import { SequentialController } from "../src/game/mecha/sequentialController.ts";
import { SequentialTurn } from "../src/game/mecha/sequentialTurn.ts";

function setup() {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 }, deployment: true,
    mechs: [{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 5, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }] });
  return new SequentialController(state);
}
function deploy(c: SequentialController) {
  c.place("Assault", { x: 0, y: 8 }); c.place("Gunner", { x: 3, y: 8 }); c.place("Support", { x: 6, y: 8 });
  assert.equal(c.getState().canConfirmDeployment, true); c.confirmDeployment();
  assert.equal(c.getState().match.phase, "player_plan");
}

test("deployment is explicit and remains at the committed cells without an automatic plan", () => {
  const c = setup(); assert.equal(c.getState().canConfirmDeployment, false);
  c.place("Assault", { x: 0, y: 8 }); c.place("Gunner", { x: 0, y: 8 });
  assert.equal(c.getState().error, "duplicate_cell");
  c.undoPlacement(); assert.deepEqual(c.getState().placements, []);
  deploy(c);
  assert.deepEqual(c.getState().match.mechs.map(m => m.pos), [{ x: 0, y: 8 }, { x: 3, y: 8 }, { x: 6, y: 8 }]);
  assert.equal(c.getState().presentation, null); assert.equal(c.records().length, 0);
  assert.ok(Object.values(c.getState().rights!).every(right => right.move && right.action));
});

test("deployment reset is undoable and cannot alter a confirmed match", () => {
  const c = setup();
  c.place("Assault", { x: 0, y: 8 });
  c.place("Gunner", { x: 3, y: 8 });
  const beforeReset = c.getState().placements;
  assert.equal(c.getState().canUndoPlacement, true);
  c.resetPlacement();
  assert.deepEqual(c.getState().placements, []);
  c.undoPlacement();
  assert.deepEqual(c.getState().placements, beforeReset);
  c.place("Support", { x: 6, y: 8 });
  c.confirmDeployment();
  const confirmed = structuredClone(c.getState().match);
  c.resetPlacement();
  assert.deepEqual(c.getState().match, confirmed);
  assert.equal(c.getState().placements, null);
});

test("preview is isolated; committed moves lock input during presentation and undo restores authority", () => {
  const c = setup(); deploy(c); const before = structuredClone(c.getState());
  const preview = c.preview({ kind: "move", mech: "Assault", to: { x: 0, y: 7 } });
  assert.ok(preview?.ok); assert.deepEqual(c.getState(), before); assert.equal(c.records().length, 0);
  c.execute({ kind: "move", mech: "Assault", to: { x: 0, y: 7 } });
  const moved = c.getState(); assert.deepEqual(moved.match.mechs[0]!.pos, { x: 0, y: 7 });
  assert.ok(moved.presentation); assert.equal(moved.rights!.Assault.move, false);
  c.execute({ kind: "undo" }); assert.equal(c.records().length, 1, "presentation locks subsequent input");
  c.finishPresentation(); c.execute({ kind: "undo" });
  assert.deepEqual(c.getState().match.mechs[0]!.pos, { x: 0, y: 8 });
  assert.equal(c.getState().rights!.Assault.move, true);
});

test("end requires explicit confirmation when actions remain and replay preserves accepted commands", () => {
  const c = setup(); deploy(c); const initial = structuredClone(c.getState().match);
  c.execute({ kind: "end", confirmUnused: false }); assert.equal(c.getState().error, "confirmation_required");
  assert.equal(c.records().length, 0);
  const forecast = c.preview({ kind: "end", confirmUnused: true });
  assert.ok(forecast?.ok);
  assert.deepEqual(c.getState().match, initial, "forecast must not change the live match");
  c.execute({ kind: "end", confirmUnused: true });
  assert.equal(c.getState().match.turn, initial.turn + 1); assert.ok(c.getState().presentation);
  assert.deepEqual(c.getState().match, forecast.snapshot.match, "ending without another command matches the forecast");
  assert.deepEqual(SequentialTurn.replay(initial, c.records()).snapshot().match, c.getState().match);
  c.finishPresentation(); assert.equal(c.getState().presentation, null);
});

test("invalid ruleset does not silently enter the v1.5 adapter", () => {
  const legacy = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash" });
  assert.throws(() => new SequentialController(legacy), /invalid_sequential_controller_start/);
});

test("durable controller exposes no committed move before storage acknowledges it", async () => {
  const c = setup(); deploy(c); const before = structuredClone(c.getState().match);
  let release!: () => void;
  assert.equal(c.attachDurable({ async commit() { await new Promise<void>(resolve => { release = resolve; }); } }), true);
  const pending = c.executeDurable({ kind: "move", mech: "Assault", to: { x: 0, y: 7 } });
  assert.equal(c.getState().persistence, "saving"); assert.deepEqual(c.getState().match, before);
  c.execute({ kind: "act", mech: "Gunner", action: { kind: "skip" } });
  assert.equal(c.records().length, 0, "synchronous path cannot bypass durability");
  release(); await pending;
  assert.equal(c.getState().persistence, "ready"); assert.deepEqual(c.getState().match.mechs[0]!.pos, { x: 0, y: 7 });
  assert.ok(c.getState().presentation);
});

test("unconfirmed writes freeze the controller without exposing the candidate state", async () => {
  const c = setup(); deploy(c); const before = structuredClone(c.getState().match);
  assert.equal(c.attachDurable({ async commit() { throw new Error("ack lost"); } }), true);
  await c.executeDurable({ kind: "move", mech: "Assault", to: { x: 0, y: 7 } });
  assert.equal(c.getState().persistence, "unconfirmed"); assert.deepEqual(c.getState().match, before);
  await c.executeDurable({ kind: "act", mech: "Gunner", action: { kind: "skip" } });
  assert.equal(c.records().length, 0);
});
