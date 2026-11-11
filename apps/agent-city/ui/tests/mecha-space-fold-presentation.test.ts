import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSpaceFold } from "../src/game/mecha/spaceFoldPresentation.ts";
test("fold presentation preserves projected mapping and whole-unit moves", () => {
  const result = describeSpaceFold({ status: "reprojected", mapping: [
    { from: { x: 0, y: 1 }, to: { x: 2, y: 3 } }, { from: { x: 2, y: 3 }, to: { x: 0, y: 1 } },
  ], moves: [{ unitId: "boss", from: { x: 0, y: 1 }, to: { x: 2, y: 3 }, width: 2, height: 2 }] }, "zh");
  assert.deepEqual(result, { status: "ready", mapping: ["(1, 2) → (3, 4)", "(3, 4) → (1, 2)"], moves: ["boss：(1, 2) → (3, 4)（2×2）"] });
});
test("void projection is explicit and never suggests a mapping", () => {
  assert.deepEqual(describeSpaceFold({ status: "void", reason: "blocked" }, "en"), { status: "unavailable", reason: "blocked" });
});

test("presentation describes a real host projection without changing its authoritative state", async () => {
  const { createMatch } = await import("../src/game/mecha/rules.ts");
  const { prepareSpaceFoldHost, reprojectSpaceFoldHost } = await import("../src/game/mecha/skillSpaceFoldHostAdapter.ts");
  const pt = (x: number, y: number) => ({ x, y });
  const state = { version: 1 as const, ledger: { version: 1 as const, pending: null, committed: [] }, match: createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], boss: pt(0, 0),
    mechs: [{ id: "Assault", pos: pt(4, 2) }, { id: "Gunner", pos: pt(5, 2) }, { id: "Support", pos: pt(8, 8) }],
    raiders: [{ id: "r1", pos: pt(6, 2) }],
  }) };
  const prepared = prepareSpaceFoldHost(state, "fold1", [
    { from: pt(4, 2), to: pt(5, 2) }, { from: pt(5, 2), to: pt(6, 2) }, { from: pt(6, 2), to: pt(4, 2) },
  ]);
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") throw Error("fixture preparation failed");
  const projection = reprojectSpaceFoldHost(prepared.state, prepared.intent);
  assert.equal(projection.status, "reprojected");
  if (projection.status !== "reprojected") throw Error("fixture projection failed");
  const before = structuredClone(projection);
  const presentation = describeSpaceFold(projection.projection, "en");
  assert.equal(presentation.status, "ready");
  if (presentation.status !== "ready") throw Error("presentation failed");
  assert.equal(presentation.mapping.length, projection.projection.mapping.length);
  assert.equal(presentation.moves.length, projection.projection.moves.length);
  assert.deepEqual(projection, before);
});
