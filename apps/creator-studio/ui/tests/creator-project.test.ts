import test from "node:test";
import assert from "node:assert/strict";
import { creatorWorkKindForProject } from "../src/contracts/creatorProject.ts";
import { layoutSelectionKey } from "../src/contracts/creatorStudio.ts";

test("template mini-game projects are Game work, not City instances or Story projects", () => {
  assert.equal(creatorWorkKindForProject("city-minigame-project"), "game");
  assert.equal(creatorWorkKindForProject("city"), null);
  assert.equal(creatorWorkKindForProject("story"), null);
  assert.equal(creatorWorkKindForProject("future-project-kind"), null);
});

test("layout selection keeps City-scoped and legacy identities distinct", () => {
  const layout = { worldRevision: "world-1", layoutId: "layout-1", seed: 7, anchorCount: 2, updatedAtMs: 1 };
  assert.equal(layoutSelectionKey(layout), "world-1");
  assert.equal(layoutSelectionKey({ ...layout, cityId: "city-1", cityRevision: 3 }), "city-1::world-1");
});
