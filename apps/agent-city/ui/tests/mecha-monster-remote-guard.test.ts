import assert from "node:assert/strict";
import test from "node:test";
import { remoteArenaFromSite, remoteStateFromSite } from "../src/game/mecha/contracts/arena.ts";
import { createMatch, MECH_IDS, type MatchState } from "../src/game/mecha/rules.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";

const site: CityMechaSite = {
  originX: 0, originZ: 0, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: [], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
};

function legacyState(): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", deployment: true });
  // Construct an explicitly legacy state even if a future core adds this property.
  Reflect.deleteProperty(state, "monsterContent");
  return state;
}

function withMonsterContent(value: unknown, enumerable = true): MatchState {
  const state: unknown = legacyState();
  Object.defineProperty(state, "monsterContent", { value, enumerable, configurable: true });
  return state as MatchState;
}

test("legacy state projects without adding experimental encounter metadata", () => {
  const local = legacyState();
  const projected = remoteStateFromSite(site, local);
  assert.equal(Object.hasOwn(projected, "monsterContent"), false);
  assert.deepEqual(projected.boss, local.boss);
  assert.equal(remoteArenaFromSite(site, { arenaId: "city-flat", sourceRevision: "flat-1" }).arenaId, "city-flat");
});

const cases: Array<[string, unknown, boolean?]> = [
  ["valid experimental encounter", { speciesId: "spore_leaper", contentVersion: 1, visualSeed: 123 }],
  ["valid legacy encounter marker", { speciesId: "legacy_boss", contentVersion: 1, visualSeed: 0 }],
  ["unknown version", { speciesId: "spore_leaper", contentVersion: 999, visualSeed: 123 }],
  ["malformed content", { speciesId: "missing" }],
  ["null", null],
  ["undefined", undefined],
  ["non-enumerable null", null, false],
];

for (const [name, content, enumerable] of cases) {
  test(`own monsterContent (${name}) is rejected before projection`, () => {
    assert.throws(() => remoteStateFromSite(site, withMonsterContent(content, enumerable)), { message: "remote_match_unsupported" });
  });
}

test("the projection guard neither reads the marker nor begins projecting state or site", () => {
  const state = legacyState();
  Object.defineProperty(state, "monsterContent", { get() { throw new Error("marker read"); } });
  Object.defineProperty(state, "covers", { get() { throw new Error("state projected"); } });
  const unprojectableSite = new Proxy(site, { get() { throw new Error("site projected"); } });
  assert.throws(() => remoteStateFromSite(unprojectableSite, state), { message: "remote_match_unsupported" });
});

test("local summon markers cannot be silently stripped during remote projection", () => {
  for (const descriptor of [
    { value: { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 2 }, enumerable: true },
    { value: undefined, enumerable: true },
    { value: null, enumerable: false },
    { get() { throw new Error("summon marker must not be read"); }, enumerable: true },
  ]) {
    const state = legacyState();
    state.raiders.push({ id: "swarm:0", pos: { x: 2, y: 2 }, hp: 2, intent: null });
    Object.defineProperty(state.raiders[0]!, "summon", { ...descriptor, configurable: true });
    assert.throws(() => remoteStateFromSite(site, state), { message: "remote_match_unsupported" });
  }
});
