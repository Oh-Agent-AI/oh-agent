import { test } from "node:test";
import { strict as assert } from "node:assert";
import { battleRandom, nextBattleRandom } from "../src/game/mecha/contracts/battleExtension.ts";
test("random stream is reproducible and can resume from saved state", () => {
  const first = nextBattleRandom(battleRandom(123));
  const second = nextBattleRandom(first.random);
  assert.deepEqual(first, nextBattleRandom(battleRandom(123)));
  assert.deepEqual(second, nextBattleRandom(JSON.parse(JSON.stringify(first.random))));
  assert.notEqual(first.value, second.value);
});
test("invalid random state and unknown versions are rejected", () => {
  for (const value of [0, -1, 1.5, 2 ** 32, NaN]) assert.throws(() => battleRandom(value));
  assert.throws(() => nextBattleRandom({ algorithm: "future" as "xorshift32:v1", state: 1 }));
});
