import test from "node:test";
import assert from "node:assert/strict";
import { matchesCoreMigrationVersion, nextCoreMigrationVersion } from "../src/game/mecha/coreMigrationVersion.ts";
test("each host mutation invalidates a previously captured migration version", () => {
  const initial = { matchId: "match:1", revision: 0 };
  const prepared = nextCoreMigrationVersion(initial)!;
  const changed = nextCoreMigrationVersion(prepared)!;
  assert.equal(matchesCoreMigrationVersion(changed, prepared), false);
  assert.equal(matchesCoreMigrationVersion(changed, changed), true);
  assert.equal(matchesCoreMigrationVersion(changed, { matchId: "match:2", revision: 2 }), false);
});
test("version advancement rejects malformed and exhausted versions", () => {
  for (const revision of [-1, -0, 1.5, NaN, 1_000_000])
    assert.equal(nextCoreMigrationVersion({ matchId: "match:1", revision }), null);
  assert.equal(nextCoreMigrationVersion({ matchId: "", revision: 0 }), null);
});
