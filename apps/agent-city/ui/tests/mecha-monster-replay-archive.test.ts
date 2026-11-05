import assert from "node:assert/strict";
import test from "node:test";
import { MECH_IDS, MONSTER_SKILLS } from "../src/game/mecha/board.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { canonicalJson } from "../src/game/mecha/contracts/match.ts";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { PLANNED_MONSTER_SPECIES_IDS, type PlannedMonsterSpeciesId } from "../src/game/mecha/monsters/contracts.ts";
import { bossPrepare } from "../src/game/mecha/rules.ts";
import { createLocalReplayArchive, loadLocalReplayEntryForSites, LOCAL_REPLAY_KEY, ReplayArchiveError, restoreLocalReplayArchive, restoreLocalReplayArchiveForSites, saveImportedLocalReplay, saveLocalReplay, type ReplayArchiveSource } from "../src/game/mecha/replayArchive.ts";
import { hasVerifiedReplaySave } from "../src/game/mecha/replayPersistenceGuard.ts";

const site: CityMechaSite = {
  originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: [{ id: "private-building", cells: [{ x: 1, y: 4 }], x: 1, z: 4, yaw: 0, ground: 0, height: 12 }],
  blocked: [], mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 0 }, raiders: [{ id: "private-raider", pos: { x: 1, y: 2 } }], spawnSpread: 0,
};
const options = { preset: "covers_sparse_mid" as const, script: "siege" as const, stake: "all" as const };
const isError = (code: string) => (error: unknown) => error instanceof ReplayArchiveError && error.code === code;
class MemoryStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
function complete(speciesId: PlannedMonsterSpeciesId, deployment = false, replaySite = site) {
  // Exercise the public site adapter and controller, not just a JSON round-trip.
  const init = { ...options, deployment, monsterContent: { speciesId, contentVersion: 1 as const } };
  const match = matchFromSite(replaySite, init);
  assert.deepEqual(match.monsterContent, init.monsterContent, "site adapter must not drop content");
  if (!deployment) bossPrepare(match);
  const controller = createMechaController({ site: replaySite, match, ...options, deployment, animate: false,
    planner: state => ({ revision: state.revision, items: state.mechs.filter(m => m.hp > 0)
      .map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) }) });
  if (deployment) {
    for (const [i, id] of MECH_IDS.entries()) controller.placeMech(id, { x: i * 3, y: 8 });
    controller.confirmDeployment();
  }
  controller.startAuto();
  for (let i = 0; i < 100 && !controller.getState().match.outcome; i++) controller.tick();
  assert.ok(controller.getState().match.outcome);
  const source = controller.replayArchiveSource(); assert.ok(source);
  return { controller, source };
}
async function sha(value: unknown): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, "0")).join("");
}
const evidence = (source: ReplayArchiveSource) => source.rounds.map(({ before, after, log, presentationStages }) => ({ before, after, log, presentationStages }));

for (const speciesId of PLANNED_MONSTER_SPECIES_IDS) {
  test(`v3 ${speciesId} reconstructs authoritative complete match and evidence`, {
    skip: Object.hasOwn(MONSTER_SKILLS, speciesId) ? false : "not yet implemented in the authoritative rules",
  }, async () => {
    const replaySite = ["porous_shaper", "phase_stalker", "gravity_core"].includes(speciesId) ? {
      ...site, buildings: [], boss: { x: 4, y: 4 },
      mechs: [{ id: "Assault" as const, pos: { x: 4, y: 7 } }, { id: "Gunner" as const, pos: { x: 4, y: 8 } }, { id: "Support" as const, pos: { x: 0, y: 9 } }],
    } : site;
    const { source } = complete(speciesId, false, replaySite);
    if (speciesId === "porous_shaper") {
      assert.ok(source.rounds.some(round => round.log.some(event => event.type === "corrode_field" && event.change === "created")), "replay must include an actual bound corrode field");
      assert.ok(source.rounds.some(round => round.log.some(event => event.type === "corrode_tick")), "replay must include actual corrode damage");
    } else if (speciesId === "phase_stalker" || speciesId === "gravity_core") {
      assert.ok(source.rounds.some(round => round.log.some(event => event.type === "monster_displacement")), "replay must include an actual displacement");
    }
    const raw = await createLocalReplayArchive(source);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.schema, "mecha-local-replay:v3");
    assert.deepEqual(parsed.monsterContent, { speciesId, contentVersion: 1 });
    assert.equal(parsed.siteDigest, await sha(replaySite));
    assert.equal(parsed.resultDigest, await sha(evidence(source)));
    for (const secret of ["private-building", "private-raider", "presentationStages", "originX"]) assert.equal(raw.includes(secret), false);
    const restored = await restoreLocalReplayArchive(raw, replaySite);
    assert.deepEqual(restored, source.rounds);
    assert.equal(await createLocalReplayArchive({ ...source, rounds: restored }), raw);
    restored[0]!.before.turn = 999;
    assert.notEqual(source.rounds[0]!.before.turn, 999);
  });
}

test("unimplemented species are rejected rather than silently archived as a different enemy", () => {
  for (const speciesId of PLANNED_MONSTER_SPECIES_IDS.filter(id => !Object.hasOwn(MONSTER_SKILLS, id))) {
    assert.throws(() => complete(speciesId), /unsupported_monster_content/, speciesId);
  }
});

test("v3 deployment, library import, site selection and controller playback use rebuilt rounds", async () => {
  const { source } = complete("spore_leaper", true);
  const raw = await createLocalReplayArchive(source);
  const archive = JSON.parse(raw);
  assert.equal(archive.deployment, true);
  assert.equal(archive.placements.length, 3);
  const storage = new MemoryStorage();
  const verified = await restoreLocalReplayArchiveForSites(raw, [{ id: "site", site }]);
  const saved = saveImportedLocalReplay(storage, raw, verified.rounds.length);
  assert.equal(saved.existing, false);
  const other = structuredClone(site); other.originX++;
  const loaded = await loadLocalReplayEntryForSites(storage, saved.key, [{ id: "other", site: other }, { id: "site", site }]);
  assert.equal(loaded?.id, "site");
  assert.deepEqual(loaded?.rounds, source.rounds);
  const receiver = createMechaController({ site, ...options, deployment: false, animate: false });
  assert.equal(receiver.startSavedReplay(loaded!.rounds), true);
  assert.ok(receiver.getState().replay);
  const match = receiver.getState().match;
  const savedRaw = storage.getItem(saved.key)!;
  assert.equal(hasVerifiedReplaySave(match, [{ match, key: saved.key, raw: savedRaw }], storage), true);
  storage.removeItem(saved.key);
  assert.equal(hasVerifiedReplaySave(match, [{ match, key: saved.key, raw: savedRaw }], storage), false);
});

test("v3 rejects unknown content, schema injection, altered site, evidence and commands", async () => {
  const { source } = complete("spore_leaper");
  const raw = await createLocalReplayArchive(source);
  const parsed = JSON.parse(raw);
  for (const edit of [
    (v: any) => { v.monsterContent.speciesId = "unknown"; },
    (v: any) => { v.monsterContent.speciesId = "legacy_boss"; },
    (v: any) => { v.monsterContent.contentVersion = 2; },
    (v: any) => { v.monsterContent.speciesId = "flux_lancer"; },
    (v: any) => { v.resultDigest = "0".repeat(64); },
    (v: any) => { v.plans[0].revision++; },
    (v: any) => { v.plans.pop(); },
    (v: any) => { v.ruleset = "future"; },
  ]) {
    const modified = structuredClone(parsed); edit(modified);
    await assert.rejects(restoreLocalReplayArchive(JSON.stringify(modified), site), isError("incompatible"));
  }
  for (const edit of [
    (v: any) => { v.monsterContent.extra = true; },
    (v: any) => { delete v.monsterContent; },
    (v: any) => { v.schema = "mecha-local-replay:v1"; },
    (v: any) => { v.schema = "mecha-local-replay:v2"; v.mission = "rescue:v1"; },
  ]) {
    const modified = structuredClone(parsed); edit(modified);
    await assert.rejects(restoreLocalReplayArchive(JSON.stringify(modified), site));
  }
  const changedSite = structuredClone(site); changedSite.originX++;
  await assert.rejects(restoreLocalReplayArchive(raw, changedSite), isError("incompatible"));
  for (const edit of [
    (s: ReplayArchiveSource) => { s.rounds[0]!.before.boss.hp--; },
    (s: ReplayArchiveSource) => { s.rounds[0]!.after.boss.hp--; },
    (s: ReplayArchiveSource) => { s.rounds[0]!.log.push({ type: "forged" } as never); },
    (s: ReplayArchiveSource) => { s.rounds[0]!.presentationStages = null; },
    (s: ReplayArchiveSource) => { s.rounds[0]!.plan.revision++; },
  ]) {
    const modified = structuredClone(source); edit(modified);
    await assert.rejects(createLocalReplayArchive(modified), isError("incompatible"));
  }
});

test("v3 checks all original state descriptors and identities before cloning or writing", async () => {
  const { source } = complete("spore_leaper");
  const storage = new MemoryStorage(); storage.setItem(LOCAL_REPLAY_KEY, "keep");
  for (const edit of [
    (state: any) => { delete state.monsterContent; },
    (state: any) => { state.monsterContent = { speciesId: "unknown", contentVersion: 1 }; },
    (state: any) => { state.monsterContent = { speciesId: "spore_leaper", contentVersion: 2 }; },
    (state: any) => { state.monsterContent = { speciesId: "flux_lancer", contentVersion: 1 }; },
    (state: any) => { state.monsterContent.hidden = true; },
    (state: any) => { Object.defineProperty(state, "monsterContent", { value: state.monsterContent, enumerable: false }); },
    (state: any) => { Object.defineProperty(state, "monsterContent", { get() { throw Error("must not invoke"); }, enumerable: true }); },
    (state: any) => { Object.defineProperty(state.monsterContent, "extra", { value: true }); },
    (state: any) => { Object.defineProperty(state.monsterContent, "speciesId", { get() { throw Error("must not invoke"); }, enumerable: true }); },
    (state: any) => { state.monsterContent[Symbol("extra")] = true; },
  ]) {
    for (const side of ["before", "after"] as const) {
      const modified = structuredClone(source);
      modified.rounds[1]![side] = structuredClone(modified.rounds[1]![side]);
      edit(modified.rounds[1]![side]);
      await assert.rejects(saveLocalReplay(storage, modified), isError("incompatible"));
      assert.equal(storage.getItem(LOCAL_REPLAY_KEY), "keep");
    }
  }
});

test("v3 carries actual monster intent and event evidence through reconstruction", async () => {
  const { source } = complete("spore_leaper");
  assert.ok(source.rounds.some(round => round.before.boss.intent?.skillId === "spore_leap"));
  assert.ok(source.rounds.some(round => round.log.some(event => event.type === "boss_move")));
  assert.ok(source.rounds.some(round => round.presentationStages !== null));
  const raw = await createLocalReplayArchive(source);
  const rebuilt = await restoreLocalReplayArchive(raw, site);
  assert.deepEqual(rebuilt.map(round => ({ intent: round.before.boss.intent, log: round.log, stages: round.presentationStages })),
    source.rounds.map(round => ({ intent: round.before.boss.intent, log: round.log, stages: round.presentationStages })));
});

test("v3 rejects malformed content before hashing and does not overwrite the old slot", async () => {
  const { source } = complete("spore_leaper");
  const storage = new MemoryStorage(); storage.setItem(LOCAL_REPLAY_KEY, "keep");
  const state = source.rounds[0]!.before as unknown as { monsterContent: unknown };
  state.monsterContent = { speciesId: "spore_leaper", contentVersion: 2 };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto"); assert.ok(descriptor);
  try {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    await assert.rejects(saveLocalReplay(storage, source), isError("incompatible"));
    assert.equal(storage.getItem(LOCAL_REPLAY_KEY), "keep");
  } finally { Object.defineProperty(globalThis, "crypto", descriptor); }
});
