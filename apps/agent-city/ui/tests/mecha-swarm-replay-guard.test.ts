import assert from "node:assert/strict";
import test from "node:test";
import { createMatch } from "../src/game/mecha/rules.ts";
import { createLocalReplayArchive, ReplayArchiveError, saveLocalReplay, type ReplayArchiveSource } from "../src/game/mecha/replayArchive.ts";

function fixture(): ReplayArchiveSource {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", raiders: [{ id: "r", pos: { x: 9, y: 0 } }] });
  const a = structuredClone(state), b = structuredClone(state), c = structuredClone(state), d = structuredClone(state);
  // The guard must reject before it reads or clones any unrelated archive input.
  return { get site() { throw new Error("must not read site"); }, rounds: [
    { before: a, after: b }, { before: c, after: d },
  ] } as unknown as ReplayArchiveSource;
}
const incompatible = (error: unknown) => error instanceof ReplayArchiveError && error.code === "incompatible";

test("archive rejects every round's marked summons before clone, hashing or site access", async () => {
  for (const round of [0, 1]) for (const side of ["before", "after"] as const) {
    for (const kind of ["data", "undefined", "hidden", "inherited", "accessor"] as const) {
      const source = fixture(), raider = source.rounds[round]![side].raiders[0]!;
      let reads = 0;
      const marker = { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 3 };
      if (kind === "data") Object.defineProperty(raider, "summon", { value: marker, enumerable: true });
      if (kind === "undefined") Object.defineProperty(raider, "summon", { value: undefined, enumerable: true });
      if (kind === "hidden") Object.defineProperty(raider, "summon", { value: marker, enumerable: false });
      if (kind === "inherited") Object.setPrototypeOf(raider, { summon: marker });
      if (kind === "accessor") Object.defineProperty(raider, "summon", { enumerable: true, get() { reads++; return marker; } });
      await assert.rejects(createLocalReplayArchive(source), incompatible, `${round} ${side} ${kind}`);
      assert.equal(reads, 0);
    }
  }
});

test("rejected summon replay never overwrites a stored replay", async () => {
  const source = fixture();
  source.rounds[1]!.after.raiders[0]!.summon = { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 3 };
  let saved = "existing";
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; }, removeItem: () => { saved = ""; } };
  await assert.rejects(saveLocalReplay(storage, source), incompatible);
  assert.equal(saved, "existing");
});

test("L5 metadata and roster reject hidden data, prototypes and getters before reading", async () => {
  for (const area of ["marker", "ledger", "actions", "roster"] as const) {
    for (const defect of ["hidden", "accessor", "extra", "inherited"] as const) {
      const source = fixture(), state = source.rounds[0]!.before;
      state.monsterContent = { speciesId: "swarm_mantle", contentVersion: 1 };
      state.swarm = { version: 1, nextSpawnId: 1, resolvedActions: ["split:1"] };
      state.raiders[0]!.summon = { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 3 };
      const value: any = area === "marker" ? state.raiders[0]!.summon : area === "ledger" ? state.swarm : area === "actions" ? state.swarm.resolvedActions : state.raiders;
      const key = area === "marker" ? "parentId" : area === "ledger" ? "version" : "0";
      let reads = 0;
      if (defect === "hidden") Object.defineProperty(value, key, { value: value[key], enumerable: false, configurable: true });
      if (defect === "accessor") Object.defineProperty(value, key, { enumerable: true, configurable: true, get() { reads++; throw Error("getter executed"); } });
      if (defect === "extra") Object.defineProperty(value, "extra", { value: 1, enumerable: false });
      if (defect === "inherited") Object.setPrototypeOf(value, Object.create(Object.getPrototypeOf(value)));
      await assert.rejects(createLocalReplayArchive(source), incompatible, `${area} ${defect}`);
      assert.equal(reads, 0, `${area} ${defect}`);
    }
  }
});
