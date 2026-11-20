import test from "node:test";
import assert from "node:assert/strict";
import { creatorWorkKindForProject } from "../src/contracts/creatorProject.ts";

test("template mini-game projects are Game work, not City instances or Story projects", () => {
  assert.equal(creatorWorkKindForProject("city-minigame-project"), "game");
  assert.equal(creatorWorkKindForProject("city"), null);
  assert.equal(creatorWorkKindForProject("story"), null);
  assert.equal(creatorWorkKindForProject("future-project-kind"), null);
});
