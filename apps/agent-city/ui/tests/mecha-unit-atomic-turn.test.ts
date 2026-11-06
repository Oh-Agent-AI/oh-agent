import assert from "node:assert/strict";
import test from "node:test";
import { bossPrepare, createMatch, living, playTurn } from "../src/game/mecha/rules.ts";

test("registered spore turn rejects a stale plan without mutating authority", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", monsterContent: { speciesId: "spore_leaper", contentVersion: 1 } });
  bossPrepare(state);
  const before = structuredClone(state);
  const items = living(state).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } }));
  const stale = playTurn(state, { revision: state.revision + 1, items });
  assert.equal(stale.ok, false);
  assert.deepEqual(state, before);
  const accepted = playTurn(state, { revision: state.revision, items });
  assert.equal(accepted.ok, true);
  assert.deepEqual(state, before);
  if (accepted.ok) assert.notEqual(accepted.state, state);
});
