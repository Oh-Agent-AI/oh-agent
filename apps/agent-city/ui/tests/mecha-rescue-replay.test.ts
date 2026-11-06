import assert from "node:assert/strict";
import test from "node:test";
import { MECH_IDS, moveBudget, pathRoute } from "../src/game/mecha/board.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { applyDeployPlan, bossPrepare, deployableCells, playTurn } from "../src/game/mecha/rules.ts";
import { createLocalReplayArchive, restoreLocalReplayArchive, restoreLocalReplayArchiveForSites, saveImportedLocalReplay, loadLocalReplayEntry, ReplayArchiveError, type ReplaySourceRound } from "../src/game/mecha/replayArchive.ts";

const site: CityMechaSite = {
  originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)), buildings: [], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
};
const options = { preset: "covers_sparse_mid" as const, script: "stationary_smash" as const, stake: "all" as const, mission: "rescue:v1" as const };
function completed(deployment: boolean) {
  let state = matchFromSite(site, { ...options, deployment });
  if (deployment) {
    const cells = deployableCells(state);
    const deployed = applyDeployPlan(state, { revision: state.revision, placements: MECH_IDS.map((mechId, i) => ({ mechId, pos: cells[i]! })) });
    assert.ok(deployed.ok); state = deployed.state;
  } else bossPrepare(state);
  const rounds: ReplaySourceRound[] = [];
  for (let i = 0; i < 15 && !state.outcome; i++) {
    const target = state.mission!.target;
    const unit = state.mechs.find(m => m.hp > 0 && pathRoute(state, m.pos, target, m.id, { alliesPass: true }));
    assert.ok(unit);
    const route = pathRoute(state, unit.pos, target, unit.id, { alliesPass: true })!;
    const destination = [...route.cells].reverse().find(cell => {
      if (state.mechs.some(m => m.id !== unit.id && m.hp > 0 && m.pos.x === cell.x && m.pos.y === cell.y)) return false;
      const distance = pathRoute(state, unit.pos, cell, unit.id, { alliesPass: true })?.cost;
      return distance !== undefined && distance <= moveBudget(unit.id);
    });
    assert.ok(destination);
    const plan = { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: m.id === unit.id ? destination : null, action: { kind: "skip" as const } })) };
    const result = playTurn(state, plan); assert.ok(result.ok);
    rounds.push({ before: state, after: result.state, plan, log: result.log, presentationStages: result.presentationStages });
    state = result.state;
  }
  assert.equal(state.outcome, "victory");
  return { site, preset: options.preset, script: options.script, stake: options.stake, deployment, rounds };
}
const isError = (code: string) => (e: unknown) => e instanceof ReplayArchiveError && e.code === code;
class StorageFixture {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(n: number) { return [...this.data.keys()][n] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}
for (const deployment of [false, true]) test(`v2 rescue replay survives export, import and authoritative reconstruction (deployment=${deployment})`, async () => {
  const source = completed(deployment);
  const raw = await createLocalReplayArchive(source);
  const archive = JSON.parse(raw);
  assert.equal(archive.schema, "mecha-local-replay:v2");
  assert.equal(archive.mission, "rescue:v1");
  assert.equal(raw.includes('"target":{"x"'), false, "mission coordinate is re-derived, not trusted as archive input");
  assert.deepEqual(await restoreLocalReplayArchive(raw, site), source.rounds);
  assert.deepEqual((await restoreLocalReplayArchiveForSites(raw, [{ id: "site", site }])).rounds, source.rounds);
  const storage = new StorageFixture();
  const saved = saveImportedLocalReplay(storage, raw, source.rounds.length);
  assert.equal(saved.existing, false);
  assert.deepEqual(await loadLocalReplayEntry(storage, saved.key, site), source.rounds);
  assert.equal(saveImportedLocalReplay(storage, raw, source.rounds.length).existing, true);
  for (const mutate of [
    (v: any) => { v.mission = "rescue:v2"; },
    (v: any) => { v.resultDigest = "0".repeat(64); },
    (v: any) => { v.plans[0].revision++; },
  ]) {
    const bad = structuredClone(archive); mutate(bad);
    await assert.rejects(restoreLocalReplayArchive(JSON.stringify(bad), site), isError("incompatible"));
  }
  const extra = structuredClone(archive); extra.target = { x: 1, y: 1 };
  await assert.rejects(restoreLocalReplayArchive(JSON.stringify(extra), site), isError("invalid"));
  const tampered = structuredClone(source); tampered.rounds[0]!.before.mission!.target.x++;
  await assert.rejects(createLocalReplayArchive(tampered), isError("incompatible"));
});

test("pre-change v1 archive fixture rebuilds and re-exports byte-for-byte", async () => {
  // Digests captured from the unmodified HEAD implementation, not regenerated by the code under test.
  const raw = JSON.stringify({
    schema: "mecha-local-replay:v1", ruleset: "mecha-v1.4",
    siteDigest: "357b58f98173434ea538fd1c7e1118201b9d0c2124699765774822ac03d2dca9",
    resultDigest: "db870730db7b334da6162c64032d8727a21b3a43ab59fd46817c44c3b1e174fb",
    preset: options.preset, script: options.script, stake: options.stake, deployment: false, placements: [],
    plans: Array.from({ length: 15 }, (_, i) => ({ revision: 1 + i * 3, items: MECH_IDS.map(mechId => ({ mechId, moveTo: null, action: { kind: "skip" } })) })),
  });
  const rounds = await restoreLocalReplayArchive(raw, site);
  assert.equal(rounds.at(-1)!.after.outcome, "defeat_timeout");
  assert.equal(Object.hasOwn(rounds[0]!.before, "mission"), false);
  assert.equal(await createLocalReplayArchive({ site, preset: options.preset, script: options.script, stake: options.stake, deployment: false, rounds }), raw);
});

// Captured 2026-11-05 before battle-unit standardization; do not refresh to mask changes.
test("fixed v2 archive remains replayable", async () => {
  const raw = '{"schema":"mecha-local-replay:v2","mission":"rescue:v1","ruleset":"mecha-v1.4","siteDigest":"357b58f98173434ea538fd1c7e1118201b9d0c2124699765774822ac03d2dca9","resultDigest":"a412b4bff4b82ff3c947fe74c0caec08d314adb02a1c9f68f940b135b92ad38f","preset":"covers_sparse_mid","script":"stationary_smash","stake":"all","deployment":false,"placements":[],"plans":[{"revision":1,"items":[{"mechId":"Assault","moveTo":{"x":0,"y":5},"action":{"kind":"skip"}},{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":4,"items":[{"mechId":"Assault","moveTo":{"x":0,"y":1},"action":{"kind":"skip"}},{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]},{"revision":7,"items":[{"mechId":"Assault","moveTo":{"x":0,"y":0},"action":{"kind":"skip"}},{"mechId":"Gunner","moveTo":null,"action":{"kind":"skip"}},{"mechId":"Support","moveTo":null,"action":{"kind":"skip"}}]}]}';
  const rounds = await restoreLocalReplayArchive(raw, site);
  assert.ok(rounds.at(-1)!.after.outcome);
  const source = completed(false);
  assert.equal(await createLocalReplayArchive({ ...source, rounds }), raw);
});
