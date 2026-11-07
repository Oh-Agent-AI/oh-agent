import test from "node:test";
import assert from "node:assert/strict";
import { buildSequentialOpening } from "../src/game/mecha/sequentialOpening.ts";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SequentialTurn } from "../src/game/mecha/sequentialTurn.ts";
import { restoreSequentialSnapshot } from "../src/game/mecha/session/SequentialMatchSession.ts";
import { SEQUENTIAL_NET_PROTOCOL } from "../src/game/mecha/contracts/sequentialTransport.ts";

function fixture() {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(state); return state;
}

test("handoff opening is opening plus accepted commands and rebuilds the same revision", () => {
  const initial = fixture(), turn = new SequentialTurn(initial);
  const move = turn.execute({ kind: "move", id: "m", revision: turn.snapshot().match.revision, mech: "Assault", to: { x: 3, y: 2 } });
  assert.ok(move.ok);
  if (!move.ok) return;
  const opening = buildSequentialOpening({ initial, placements: [], records: turn.records() });
  assert.equal(opening.commands.length, 1);
  assert.deepEqual(opening.initial, initial);
  const restored = restoreSequentialSnapshot({ protocol: SEQUENTIAL_NET_PROTOCOL, matchId: "m1", ruleset: "mecha-v1.5", revision: move.snapshot.match.revision, ...opening });
  assert.equal(restored.snapshot().match.revision, move.snapshot.match.revision);
  assert.deepEqual(restored.snapshot().match.mechs[0]!.pos, { x: 3, y: 2 });
});

test("the builder clones the opening instead of mutating the caller", () => {
  const initial = fixture();
  const opening = buildSequentialOpening({ initial, placements: [], records: [] });
  initial.mechs[0]!.pos.x = 9;
  assert.equal(opening.initial.mechs[0]!.pos.x, 3);
});
