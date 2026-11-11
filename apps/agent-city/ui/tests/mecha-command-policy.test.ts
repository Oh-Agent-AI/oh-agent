import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SequentialTurn } from "../src/game/mecha/sequentialTurn.ts";
import { nextCommand } from "../src/game/mecha/ai/commandPolicy.ts";

function fixture() {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(state); return state;
}

test("policy picks an adjacent attack without mutating the live authority", () => {
  const state = fixture(), session = new SequentialTurn(state), before = session.snapshot();
  const intent = nextCommand(session);
  assert.equal(intent.kind, "act");
  if (intent.kind !== "act") return;
  assert.equal(intent.mech, "Assault");
  assert.deepEqual(session.snapshot(), before);
});

test("a search branch can advance independently of the live authority", () => {
  const state = fixture(), session = new SequentialTurn(state), before = session.snapshot();
  const branch = session.branch();
  const moved = branch.execute({ kind: "move", id: "b", revision: branch.snapshot().match.revision, mech: "Gunner", to: { x: 1, y: 5 } });
  assert.ok(moved.ok);
  assert.deepEqual(session.snapshot(), before);
  assert.notDeepEqual(branch.snapshot().match.mechs, session.snapshot().match.mechs);
});

test("policy ends the turn when no improving command exists", () => {
  const state = fixture();
  state.boss.hp = 0; state.raiders = [];
  const session = new SequentialTurn(state);
  assert.deepEqual(nextCommand(session), { kind: "end" });
});
