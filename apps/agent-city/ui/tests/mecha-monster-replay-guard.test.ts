import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TURNS, MECH_IDS } from "../src/game/mecha/board.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { bossPrepare, playTurn } from "../src/game/mecha/rules.ts";
import { createLocalReplayArchive, LOCAL_REPLAY_KEY, ReplayArchiveError, restoreLocalReplayArchive, saveLocalReplay, type ReplayArchiveSource, type ReplaySourceRound } from "../src/game/mecha/replayArchive.ts";

const site: CityMechaSite = {
  originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: [], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
};
const options = { preset: "covers_sparse_mid" as const, script: "stationary_smash" as const, stake: "all" as const, deployment: false };

function completed(rescue: boolean): ReplayArchiveSource {
  let state = matchFromSite(site, { ...options, ...(rescue ? { mission: "rescue:v1" as const } : {}) });
  bossPrepare(state);
  const rounds: ReplaySourceRound[] = [];
  for (let i = 0; i < MAX_TURNS && !state.outcome; i++) {
    const plan = { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
    const result = playTurn(state, plan);
    assert.ok(result.ok);
    rounds.push({ before: state, after: result.state, plan, log: result.log, presentationStages: result.presentationStages });
    state = result.state;
  }
  assert.ok(state.outcome);
  assert.ok(rounds.length >= 3);
  return { site, ...options, rounds };
}
const isIncompatible = (error: unknown) => error instanceof ReplayArchiveError && error.code === "incompatible";

for (const rescue of [false, true]) {
  const version = rescue ? "v2" : "v1";
  test(`${version} legacy archive still round-trips without monster content`, async () => {
    const source = completed(rescue);
    const raw = await createLocalReplayArchive(source);
    assert.equal(JSON.parse(raw).schema, `mecha-local-replay:${version}`);
    const rounds = await restoreLocalReplayArchive(raw, site);
    assert.deepEqual(rounds, source.rounds);
    assert.equal(await createLocalReplayArchive({ ...source, rounds }), raw);

    // Inherited identity is ambiguous and could disappear when cloned; fail closed.
    const inherited = structuredClone(source);
    const before = inherited.rounds[0]!.before;
    Object.setPrototypeOf(before, { monsterContent: { version: "future" } });
    assert.equal(Object.hasOwn(before, "monsterContent"), false);
    await assert.rejects(createLocalReplayArchive(inherited), isIncompatible);
  });

  test(`${version} refuses every round's before/after own monsterContent, regardless of value`, async () => {
    const source = completed(rescue);
    for (const index of source.rounds.keys()) {
      for (const side of ["before", "after"] as const) {
        for (const value of [null, undefined, { version: "unknown" }, { version: "monster:v1", skills: [] }]) {
          const modified = structuredClone(source);
          // Isolate the state even if adjacent rounds share an object.
          modified.rounds[index]![side] = { ...modified.rounds[index]![side] };
          (modified.rounds[index]![side] as unknown as { monsterContent: unknown }).monsterContent = value;
          await assert.rejects(createLocalReplayArchive(modified), isIncompatible, `${version} round ${index} ${side}`);
        }
      }
    }
  });

  test(`${version} rejects monster states before requiring hashing`, async () => {
    const source = completed(rescue);
    const state = source.rounds[0]!.before as unknown as { monsterContent: unknown };
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    assert.ok(cryptoDescriptor);
    try {
      Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
      for (const value of [null, undefined, { version: "unknown" }]) {
        state.monsterContent = value;
        await assert.rejects(createLocalReplayArchive(source), isIncompatible);
      }
    } finally {
      Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    }
  });

  test(`${version} rejects before cloning and does not overwrite saved replay`, async () => {
    const source = completed(rescue);
    const state = source.rounds[1]!.after;
    // Non-enumerable fields disappear in structuredClone; enumerable functions cannot be cloned at all.
    Object.defineProperty(state, "monsterContent", { value: null, enumerable: false, configurable: true });
    await assert.rejects(createLocalReplayArchive(source), isIncompatible);
    Object.defineProperty(state, "monsterContent", { value: () => {}, enumerable: true });
    await assert.rejects(createLocalReplayArchive(source), isIncompatible);
    const data = new Map([[LOCAL_REPLAY_KEY, "previous replay"]]);
    let writes = 0;
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { writes++; data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    };
    await assert.rejects(saveLocalReplay(storage, source), isIncompatible);
    assert.equal(writes, 0);
    assert.equal(data.get(LOCAL_REPLAY_KEY), "previous replay");
  });
}
