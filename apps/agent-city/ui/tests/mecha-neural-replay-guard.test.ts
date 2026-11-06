import assert from "node:assert/strict";
import { isSafeNeuralReplayLedger } from "../src/game/mecha/neuralReplayValidation.ts";
import test from "node:test";
import { GDD_RULESET, MAX_TURNS, type ArenaPlan, type MatchState } from "../src/game/mecha/board.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { bossPrepare, createMatch, playTurn } from "../src/game/mecha/rules.ts";
import { createLocalReplayArchive, LOCAL_REPLAY_KEY, ReplayArchiveError, restoreLocalReplayArchive, restoreLocalReplayArchiveForSites, readLocalReplayEntryArchive, saveImportedLocalReplay, saveLocalReplay, loadLocalReplay, saveLocalReplayEntry, type ReplayArchiveSource, type ReplaySourceRound } from "../src/game/mecha/replayArchive.ts";

const site: CityMechaSite = {
  originX: 0, originZ: 0, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: [], blocked: [], boss: { x: 4, y: 4 }, raiders: [{ id: "a", pos: { x: 3, y: 4 } }], spawnSpread: 0,
  mechs: [{ id: "Assault", pos: { x: 2, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 1, y: 9 } }],
};
const options = { preset: "covers_sparse_mid" as const, script: "siege" as const, stake: "all" as const, deployment: false };
const incompatible = (e: unknown) => e instanceof ReplayArchiveError && e.code === "incompatible";
function hold(state: MatchState): ArenaPlan {
  return { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) };
}
function completedNeural(): ReplayArchiveSource {
  let state = matchFromSite(site, { ...options, monsterContent: { speciesId: "neural_weaver", contentVersion: 1 } });
  bossPrepare(state);
  const rounds: ReplaySourceRound[] = [];
  for (let i = 0; i < MAX_TURNS && !state.outcome; i++) {
    const plan = hold(state), result = playTurn(state, plan);
    assert.equal(result.ok, true);
    if (!result.ok) throw Error("turn failed");
    rounds.push({ before: state, after: result.state, plan, log: result.log, presentationStages: result.presentationStages });
    state = result.state;
  }
  assert.ok(state.outcome);
  assert.ok(rounds.some(r => r.after.neural?.journal.some(e => e.type === "link_created")), "fixture must create an authoritative link");
  return { site, ...options, rounds };
}
test("structural replay validation accepts every real L8 ledger", () => {
  const source = completedNeural();
  for (const round of source.rounds) for (const state of [round.before, round.after]) {
    assert.ok(isSafeNeuralReplayLedger(state.neural), "authoritative ledger must pass structural validation");
  }
});
function syntheticSource(): ReplayArchiveSource {
  const state = createMatch({ preset: options.preset, script: options.script, raiders: [{ id: "a", pos: { x: 1, y: 1 } }] });
  const rounds = Array.from({ length: 2 }, () => ({ before: structuredClone(state), after: structuredClone(state) }));
  return { get site() { throw Error("must reject before reading site"); }, rounds } as unknown as ReplayArchiveSource;
}
class Storage {
  data = new Map<string, string>([[LOCAL_REPLAY_KEY, "previous"]]);
  writes = 0;
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes++; this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

test("completed L8 archive replays deterministically and rejects altered evidence", async () => {
  const source = completedNeural();
  const raw = await createLocalReplayArchive(source);
  const restored = await restoreLocalReplayArchive(raw, site);
  assert.ok(restored);
  const corrupted = structuredClone(source);
  corrupted.rounds[0]!.after.neural!.nextLinkId += 1;
  await assert.rejects(createLocalReplayArchive(corrupted), incompatible);
  const archive = JSON.parse(raw); archive.resultDigest = "0".repeat(64);
  await assert.rejects(restoreLocalReplayArchive(JSON.stringify(archive), site), incompatible);
});

test("completed L8 match survives local storage and replay", async () => {
  const source = completedNeural();
  const storage = new Storage();
  await saveLocalReplay(storage, source);
  assert.equal(storage.writes, 1);
  const restored = await loadLocalReplay(storage, site);
  assert.ok(restored);
  assert.deepEqual(restored, source.rounds);
});

test("all round states reject own, hidden, inherited or accessor neural markers before cloning", async () => {
  for (const index of [0, 1]) for (const side of ["before", "after"] as const) {
    for (const kind of ["data", "undefined", "hidden", "inherited", "accessor"] as const) {
      const source = syntheticSource(), state = source.rounds[index]![side];
      let reads = 0;
      if (kind === "data") Object.defineProperty(state, "neural", { value: { version: 1 }, enumerable: true });
      if (kind === "undefined") Object.defineProperty(state, "neural", { value: undefined, enumerable: true });
      if (kind === "hidden") Object.defineProperty(state, "neural", { value: { version: 1 }, enumerable: false });
      if (kind === "inherited") Object.setPrototypeOf(state, { neural: { version: 1 } });
      if (kind === "accessor") Object.defineProperty(state, "neural", { enumerable: true, get() { reads++; throw Error("getter called"); } });
      await assert.rejects(createLocalReplayArchive(source), incompatible, `${index} ${side} ${kind}`);
      assert.equal(reads, 0);
    }
  }
});

test("neural species identity is rejected even when the ledger is missing", async () => {
  for (const index of [0, 1]) for (const side of ["before", "after"] as const) {
    const source = syntheticSource();
    source.rounds[index]![side].monsterContent = { speciesId: "neural_weaver", contentVersion: 1 };
    await assert.rejects(createLocalReplayArchive(source), incompatible);
  }
});


// Captured 2026-11-05 before battle-unit standardization; do not refresh to mask changes.
test("fixed v3 archive remains replayable", async () => {
  const raw = '{"schema":"mecha-local-replay:v3","monsterContent":{"speciesId":"neural_weaver","contentVersion":1},"ruleset":"mecha-v1.4","siteDigest":"94d8239a10448a1801022f0d664697e633bfd92f2f76547a32533fbbec09b8cd","resultDigest":"072e7bb28a46fa2c9e47c66560c9a1f35a3e8730f7b8e18346f0d79f07a9b510","preset":"covers_sparse_mid","script":"siege","stake":"all","deployment":false,"placements":[],"plans":[{"revision":1,"items":[{"mechId":"Assault","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":4,"items":[{"mechId":"Assault","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":7,"items":[{"mechId":"Assault","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":10,"items":[{"mechId":"Assault","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":13,"items":[{"mechId":"Assault","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":16,"items":[{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":19,"items":[{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":22,"items":[{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":25,"items":[{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":28,"items":[{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":31,"items":[{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":34,"items":[{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":37,"items":[{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":40,"items":[{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":43,"items":[{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]}]}';
  const rounds = await restoreLocalReplayArchive(raw, site);
  assert.ok(rounds.at(-1)!.after.outcome);
  const source = completedNeural();
  assert.equal(await createLocalReplayArchive({ ...source, rounds }), raw);
});
