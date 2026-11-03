import assert from "node:assert/strict";
import test from "node:test";
import { createMatch } from "../src/game/mecha/rules.ts";
import { deployableCells, validateDeployPlan } from "../src/game/mecha/deployment.ts";
import { emptyDeploymentDraft, placeRemoteDeployment, undoRemoteDeployment } from "../src/remote/deploymentDraft.ts";

const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", deployment: true });
const cells = deployableCells(state);

test("remote draft previews legal placement, swaps and undo without mutating authority", () => {
  const before = structuredClone(state);
  let draft = emptyDeploymentDraft();
  for (const [id, cell] of [["Assault", cells[0]], ["Gunner", cells[1]], ["Support", cells[2]]] as const) {
    const result = placeRemoteDeployment(state, draft, id, cell!);
    assert.equal(result.fault, null);
    draft = result.draft;
  }
  assert.equal(validateDeployPlan(state, { revision: state.revision, placements: draft.placements }).ok, true);
  const previous = structuredClone(draft);
  const swap = placeRemoteDeployment(state, draft, "Assault", cells[1]!);
  assert.deepEqual(swap.draft.placements.find(p => p.mechId === "Gunner")!.pos, cells[0]);
  assert.deepEqual(swap.draft.placements.find(p => p.mechId === "Assault")!.pos, cells[1]);
  assert.deepEqual(undoRemoteDeployment(swap.draft), previous);
  assert.deepEqual(state, before);
});

test("remote draft rejects invalid cells and occupied placements without changing history", () => {
  const empty = emptyDeploymentDraft();
  assert.equal(placeRemoteDeployment(state, empty, "Assault", { x: -1, y: 0 }).fault?.code, "invalid_cell");
  const first = placeRemoteDeployment(state, empty, "Assault", cells[0]!).draft;
  const collision = placeRemoteDeployment(state, first, "Gunner", cells[0]!);
  assert.equal(collision.fault?.code, "duplicate_cell");
  assert.equal(collision.draft, first);
  assert.deepEqual(undoRemoteDeployment(first), empty);
});
