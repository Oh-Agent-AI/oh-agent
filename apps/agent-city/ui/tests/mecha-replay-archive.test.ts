import assert from "node:assert/strict";
import test from "node:test";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { createLocalReplayArchive, ReplayArchiveError, restoreLocalReplayArchive, saveLocalReplay, loadLocalReplay, deleteLocalReplay, LOCAL_REPLAY_KEY, LOCAL_REPLAY_LIBRARY_LIMIT, saveLocalReplayEntry, loadLocalReplayEntry, loadLocalReplayEntryForSites, readLocalReplayEntryArchive, restoreLocalReplayArchiveForSites, findLocalReplayArchive, saveImportedLocalReplay, listLocalReplays, deleteLocalReplayEntry } from "../src/game/mecha/replayArchive.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { MECH_IDS, type DifficultyId } from "../src/game/mecha/board.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { createMatch, bossPrepare } from "../src/game/mecha/rules.ts";

const site: CityMechaSite = {
  originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: [{ id: "private-building-identity", cells: [{ x: 1, y: 4 }], x: 1, z: 4, yaw: 0, ground: 0, height: 12 }], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 0 }, raiders: [{ id: "private-raider-identity", pos: { x: 1, y: 2 } }], spawnSpread: 0,
};
function complete(deployment: boolean) {
  const c = createMechaController({ site, deployment, script: "siege", animate: false,
    planner: state => ({ revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) }) });
  assert.equal(c.replayArchiveSource(), null);
  if (deployment) {
    for (const [i, id] of MECH_IDS.entries()) c.placeMech(id, { x: i * 3, y: 8 });
    c.confirmDeployment();
  }
  c.startAuto();
  for (let i = 0; i < 100 && !c.getState().match.outcome; i++) c.tick();
  assert.ok(c.getState().match.outcome);
  const source = c.replayArchiveSource(); assert.ok(source);
  return { c, source };
}
const isError = (code: string) => (e: unknown) => e instanceof ReplayArchiveError && e.code === code;

for (const deployment of [true, false]) test(`completed city replay reconstructs every authoritative round (deployment ${deployment})`, async () => {
  const { c, source } = complete(deployment);
  assert.notEqual(c.getState().match.outcome, "victory", "skip-only match should end in defeat");
  assert.equal(c.getState().matchRecap?.status, "verified", "a complete authoritative match yields a verified review");
  const current = structuredClone(c.getState().match);
  const raw = await createLocalReplayArchive(source);
  assert.ok(!raw.includes("private-building-identity"));
  assert.ok(!raw.includes("private-raider-identity"));
  assert.ok(!raw.includes("originX"));
  const restored = await restoreLocalReplayArchive(raw, site);
  assert.deepEqual(restored, source.rounds);
  restored[0]!.before.turn = 999;
  assert.notEqual(source.rounds[0]!.before.turn, 999);
  assert.deepEqual(c.getState().match, current);
  source.rounds[0]!.before.turn = 888;
  assert.notEqual(c.replayArchiveSource()!.rounds[0]!.before.turn, 888);
  c.restart();
  assert.equal(c.getState().matchRecap, null, "a new match must not inherit the old review");
});

test("rejects corrupt, extra, incompatible, altered and incomplete archives", async () => {
  const { source } = complete(true);
  const raw = await createLocalReplayArchive(source);
  const parsed = JSON.parse(raw);
  await assert.rejects(restoreLocalReplayArchive("{", site), isError("invalid"));
  await assert.rejects(restoreLocalReplayArchive("x".repeat(40_001), site), isError("invalid"));
  for (const edit of [
    (v: any) => { v.privateData = "secret"; },
    (v: any) => { v.plans[0].privateData = "secret"; },
    (v: any) => { v.plans[0].items[0].action.privateData = "secret"; },
    (v: any) => { v.placements[0].pos.x = 10; },
    (v: any) => { v.plans = []; },
    (v: any) => { v.resultDigest = "x"; },
  ]) {
    const value = structuredClone(parsed); edit(value);
    await assert.rejects(restoreLocalReplayArchive(JSON.stringify(value), site), isError("invalid"));
  }
  for (const edit of [
    (v: any) => { v.ruleset = "future"; },
    (v: any) => { v.resultDigest = "0".repeat(64); },
    (v: any) => { v.plans[0].revision += 1; },
    (v: any) => { v.plans.pop(); },
  ]) {
    const value = structuredClone(parsed); edit(value);
    await assert.rejects(restoreLocalReplayArchive(JSON.stringify(value), site), isError("incompatible"));
  }
  const changedSite = structuredClone(site); changedSite.originX += 1;
  await assert.rejects(restoreLocalReplayArchive(raw, changedSite), isError("incompatible"));
  const changedSource = structuredClone(source); changedSource.rounds[0]!.after.boss.hp--;
  await assert.rejects(createLocalReplayArchive(changedSource), isError("incompatible"));
  const unfinished = structuredClone(source); unfinished.rounds.pop();
  await assert.rejects(createLocalReplayArchive(unfinished), isError("invalid"));
});

test("raider targets are stored as indexes rather than city identifiers", async () => {
  const combatSite = structuredClone(site);
  combatSite.raiders = [{ id: "secret-raider-name", pos: { x: 0, y: 7 } }];
  const c = createMechaController({ site: combatSite, deployment: false, script: "siege", animate: false,
    planner: state => ({ revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({
      mechId: m.id, moveTo: state.turn === 1 && m.id === "Assault" ? { x: 0, y: 5 } : null,
      action: state.turn === 1 && m.id === "Assault" ? { kind: "melee" as const, target: "secret-raider-name" } : { kind: "skip" as const },
    })) }) });
  c.startAuto();
  for (let i = 0; i < 100 && !c.getState().match.outcome; i++) c.tick();
  assert.ok(c.getState().match.outcome, JSON.stringify(c.getState().fault));
  const source = c.replayArchiveSource(); assert.ok(source);
  assert.ok(source.rounds.some(r => r.plan.items.some(i => "target" in i.action && i.action.target === "secret-raider-name")), "fixture must actually target the private identifier");
  const raw = await createLocalReplayArchive(source);
  assert.ok(!raw.includes("secret-raider-name"));
  assert.match(raw, /"target":"r0"/);
  assert.deepEqual(await restoreLocalReplayArchive(raw, combatSite), source.rounds);
});

test("unavailable cryptography fails explicitly without changing the match", async () => {
  const { c, source } = complete(true);
  const before = structuredClone(c.getState().match);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    await assert.rejects(createLocalReplayArchive(source), isError("unavailable"));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
  assert.deepEqual(c.getState().match, before);
});


test("explicit storage saves one verified slot; storage failures are visible", async () => {
  const { source } = complete(true);
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  assert.equal(await loadLocalReplay(storage, site), null);
  await saveLocalReplay(storage, source);
  assert.equal(data.size, 1); assert.ok(data.has(LOCAL_REPLAY_KEY));
  assert.deepEqual(await loadLocalReplay(storage, site), source.rounds);
  const raw = data.get(LOCAL_REPLAY_KEY)!;
  const invalid = structuredClone(source); invalid.rounds[0]!.after.boss.hp--;
  await assert.rejects(saveLocalReplay(storage, invalid), isError("incompatible"));
  assert.equal(data.get(LOCAL_REPLAY_KEY), raw, "a failed replacement keeps the prior archive");
  deleteLocalReplay(storage); assert.equal(data.size, 0);
  const blocked = { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("quota"); }, removeItem: () => { throw Error("blocked"); } };
  await assert.rejects(saveLocalReplay(blocked, source), isError("storage"));
  await assert.rejects(loadLocalReplay(blocked, site), isError("storage"));
  assert.throws(() => deleteLocalReplay(blocked), isError("storage"));
});

test("saved replay leaves current deployment, draft and authority intact", async () => {
  const source = complete(true).source;
  const rounds = await restoreLocalReplayArchive(await createLocalReplayArchive(source), site);
  const c = createMechaController({ site, deployment: true, script: "siege", animate: false });
  c.placeMech("Assault", { x: 0, y: 8 });
  const before = structuredClone(c.getState());
  assert.equal(c.startSavedReplay(rounds), true);
  assert.equal(c.getState().replay!.source, "saved");
  assert.equal(c.getState().replay!.total, rounds.length);
  assert.deepEqual(c.getState().performance!.before, rounds[0]!.before);
  assert.deepEqual(c.getState().replay!.log, rounds[0]!.log);
  c.getState().replay!.log.length = 0;
  c.selectReplayTurn(0);
  assert.deepEqual(c.getState().replay!.log, rounds[0]!.log, "recap cannot alter the saved recording");
  c.pause(); c.selectReplayTurn(rounds.length - 1);
  assert.equal(c.getState().paused, true);
  assert.deepEqual(c.getState().performance!.before, rounds.at(-1)!.before);
  assert.deepEqual(c.getState().match, before.match);
  assert.deepEqual(c.getState().draft, before.draft);
  assert.deepEqual(c.getState().deployment!.placements, before.deployment!.placements);
  c.stopReplay();
  assert.equal(c.getState().replay, null); assert.equal(c.getState().paused, false);
  assert.deepEqual(c.getState().match, before.match);
  assert.deepEqual(c.getState().draft, before.draft);
  assert.deepEqual(c.getState().deployment!.placements, before.deployment!.placements);
  assert.deepEqual(c.getState().lastLog, before.lastLog);
  assert.equal(c.startSavedReplay(rounds), true);
  for (const round of rounds) {
    assert.deepEqual(c.getState().performance!.before, round.before);
    assert.deepEqual(c.getState().replay!.log, round.log);
    assert.deepEqual(c.getState().replay!.after, round.after);
    const replay = c.getState().replay!;
    if (replay.combat.healthTimeline?.ok) for (const step of replay.combat.healthTimeline.steps) {
      assert.equal(step.event, replay.log[step.eventIndex]);
    }
    c.finishPerformance();
  }
  assert.equal(c.getState().replay, null);
  assert.deepEqual(c.getState().match, before.match);
  assert.deepEqual(c.getState().deployment!.placements, before.deployment!.placements);
});

test("saved playback is gated while busy and does not replace current-session recording", async () => {
  const { c, source } = complete(false);
  const rounds = await restoreLocalReplayArchive(await createLocalReplayArchive(source), site);
  assert.equal(c.startSavedReplay([]), false);
  const active = createMechaController({ site, deployment: false, script: "siege" });
  active.pause(); assert.equal(active.startSavedReplay(rounds), false); active.resume();
  active.startAuto(); assert.equal(active.startSavedReplay(rounds), false); active.stopAuto();
  assert.equal(c.startSavedReplay(rounds), true);
  assert.equal(c.startSavedReplay(rounds), false);
  c.stopReplay();
  c.startReplay();
  assert.equal(c.getState().replay?.source, "current");
  assert.equal(c.getState().replay?.total, source.rounds.length);
  c.stopReplay();
});

test("saved playback preserves the live targeting and enemy focus, even when paused", async () => {
  const rounds = await restoreLocalReplayArchive(await createLocalReplayArchive(complete(false).source), site);
  const c = createMechaController({ site, deployment: false, script: "siege", animate: false });
  c.setTargeting("melee");
  c.setHoveredEnemy("boss"); c.setSelectedEnemy("boss");
  const before = structuredClone(c.getState());
  assert.equal(before.targeting, "melee");
  assert.equal(c.startSavedReplay(rounds), true);
  c.pause(); c.setTargeting(null); c.setHoveredEnemy(null); c.setSelectedEnemy(null);
  c.selectReplayTurn(rounds.length - 1);
  assert.equal(c.getState().targeting, before.targeting);
  assert.equal(c.getState().hoveredEnemy, before.hoveredEnemy);
  assert.equal(c.getState().selectedEnemy, before.selectedEnemy);
  c.stopReplay();
  assert.equal(c.getState().targeting, before.targeting);
  assert.equal(c.getState().hoveredEnemy, before.hoveredEnemy);
  assert.equal(c.getState().selectedEnemy, before.selectedEnemy);
  assert.deepEqual(c.getState().draft, before.draft);
  assert.deepEqual(c.getState().match, before.match);
});


test("saved playback retains a pinned target candidate", async () => {
  const rounds = await restoreLocalReplayArchive(await createLocalReplayArchive(complete(false).source), site);
  const match = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 3 },
    mechs: [{ id: "Assault", pos: { x: 0, y: 9 } }, { id: "Gunner", pos: { x: 3, y: 4 } }, { id: "Support", pos: { x: 2, y: 5 } }] });
  match.mechs.find(mech => mech.id === "Gunner")!.hp = 2;
  bossPrepare(match);
  const c = createMechaController({ match, planner: state => ({ revision: state.revision, items: state.mechs.filter(mech => mech.hp > 0).map(mech => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" as const } })) }) });
  c.selectMech("Support"); c.setTargeting("repair"); c.previewTarget("Gunner", "selection");
  const before = structuredClone(c.getState()); assert.equal(before.candidate?.target, "Gunner");
  assert.equal(c.startSavedReplay(rounds), true); c.pause(); c.selectReplayTurn(rounds.length - 1); c.stopReplay();
  assert.deepEqual(c.getState().candidate, before.candidate);
  assert.equal(c.getState().targeting, before.targeting);
  assert.deepEqual(c.getState().draft, before.draft);
  assert.deepEqual(c.getState().match, before.match);
});


function memoryLibrary() {
  const data = new Map<string, string>();
  const storage = {
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  return { data, storage };
}

test("multiple independent saves coexist with the legacy slot and can be selected and deleted", async () => {
  const source = complete(true).source;
  const raw = await createLocalReplayArchive(source);
  const { data, storage } = memoryLibrary();
  storage.setItem(LOCAL_REPLAY_KEY, raw);
  const first = saveLocalReplayEntry(storage, raw, source.rounds.length);
  const second = saveLocalReplayEntry(storage, raw, source.rounds.length);
  assert.notEqual(first, second);
  assert.equal(data.get(LOCAL_REPLAY_KEY), raw);
  assert.equal(listLocalReplays(storage).length, 3);
  for (const key of [LOCAL_REPLAY_KEY, first, second]) assert.deepEqual(await loadLocalReplayEntry(storage, key, site), source.rounds);
  assert.ok(!data.get(first)!.includes("private-building-identity"));
  deleteLocalReplayEntry(storage, first);
  assert.equal(data.has(first), false);
  assert.deepEqual(await loadLocalReplayEntry(storage, second, site), source.rounds);
  assert.deepEqual(await loadLocalReplayEntry(storage, LOCAL_REPLAY_KEY, site), source.rounds);
  assert.throws(() => deleteLocalReplayEntry(storage, "unrelated-key"), isError("invalid"));
});

test("full library, quota failure and damaged entries do not destroy other recordings", async () => {
  const source = complete(false).source; const raw = await createLocalReplayArchive(source);
  const { data, storage } = memoryLibrary();
  const keys = Array.from({ length: LOCAL_REPLAY_LIBRARY_LIMIT }, () => saveLocalReplayEntry(storage, raw, source.rounds.length));
  const before = new Map(data);
  assert.throws(() => saveLocalReplayEntry(storage, raw, source.rounds.length), isError("full"));
  assert.deepEqual(data, before);
  storage.setItem(keys[0]!, "{bad");
  assert.equal(listLocalReplays(storage).find(e => e.key === keys[0])?.damaged, true);
  await assert.rejects(loadLocalReplayEntry(storage, keys[0]!, site), isError("invalid"));
  assert.deepEqual(await loadLocalReplayEntry(storage, keys[1]!, site), source.rounds);
  deleteLocalReplayEntry(storage, keys[0]!);
  const beforeQuota = new Map(data);
  const quota = { ...storage, get length() { return storage.length; }, setItem: () => { throw Error("quota"); } };
  assert.throws(() => saveLocalReplayEntry(quota, raw, source.rounds.length), isError("storage"));
  assert.deepEqual(data, beforeQuota);
  const changed = structuredClone(site); changed.originX++;
  await assert.rejects(loadLocalReplayEntry(storage, keys[1]!, changed), isError("incompatible"));
});

test("a record changed while its digest is calculated is not played", async () => {
  const source = complete(false).source; const raw = await createLocalReplayArchive(source);
  const { storage } = memoryLibrary(); const key = saveLocalReplayEntry(storage, raw, source.rounds.length);
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    crypto.subtle.digest = async (...args) => { entered(); await gate; return original(...args); };
    const pending = loadLocalReplayEntry(storage, key, site);
    await waiting; storage.removeItem(key); release();
    await assert.rejects(pending, isError("changed"));
  } finally { crypto.subtle.digest = original; }
});


test("saved replay finds the first compatible current-city battlefield without changing candidates", async () => {
  const source = complete(true).source;
  const raw = await createLocalReplayArchive(source);
  const { storage } = memoryLibrary();
  const key = saveLocalReplayEntry(storage, raw, source.rounds.length);
  storage.setItem(LOCAL_REPLAY_KEY, raw);
  const other = structuredClone(site); other.originX++;
  const before = structuredClone([other, site]);
  const candidates = [{ id: "live", site: other }, { id: "historical", site }, { id: "duplicate", site }];
  for (const entry of [key, LOCAL_REPLAY_KEY]) {
    const restored = await loadLocalReplayEntryForSites(storage, entry, candidates);
    assert.equal(restored?.id, "historical");
    assert.deepEqual(restored?.rounds, source.rounds);
    assert.deepEqual(restored?.site, site);
    assert.notEqual(restored?.site, site);
  }
  assert.deepEqual([other, site], before);
  await assert.rejects(loadLocalReplayEntryForSites(storage, key, [{ id: "live", site: other }]), isError("incompatible"));
  await assert.rejects(loadLocalReplayEntryForSites(storage, LOCAL_REPLAY_KEY, []), isError("incompatible"));
  storage.removeItem(key);
  assert.equal(await loadLocalReplayEntryForSites(storage, key, candidates), null);
});

test("multi-site replay rejects tampering and storage failures, and snapshots candidates", async () => {
  const source = complete(false).source; const raw = await createLocalReplayArchive(source);
  const { storage } = memoryLibrary(); const key = saveLocalReplayEntry(storage, raw, source.rounds.length);
  const broken = JSON.parse(storage.getItem(key)!); const archive = JSON.parse(broken.archive);
  archive.resultDigest = "0".repeat(64); broken.archive = JSON.stringify(archive);
  storage.setItem(key, JSON.stringify(broken));
  await assert.rejects(loadLocalReplayEntryForSites(storage, key, [{ id: 1, site }]), isError("incompatible"));
  const denied = { ...storage, getItem: () => { throw Error("denied"); } };
  await assert.rejects(loadLocalReplayEntryForSites(denied, key, [{ id: 1, site }]), isError("storage"));
  storage.setItem(key, JSON.stringify({ ...broken, archive: raw }));
  const candidate = structuredClone(site);
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    crypto.subtle.digest = async (...args) => { entered(); await gate; return original(...args); };
    const pending = loadLocalReplayEntryForSites(storage, key, [{ id: 1, site: candidate }]);
    await waiting; candidate.originX++; release();
    const result = await pending;
    assert.deepEqual(result?.rounds, source.rounds);
    assert.deepEqual(result?.site, site);
  } finally { crypto.subtle.digest = original; }
});

test("multi-site replay refuses a record replaced while matching", async () => {
  const source = complete(false).source; const raw = await createLocalReplayArchive(source);
  const { storage } = memoryLibrary(); const key = saveLocalReplayEntry(storage, raw, source.rounds.length);
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    crypto.subtle.digest = async (...args) => { entered(); await gate; return original(...args); };
    const pending = loadLocalReplayEntryForSites(storage, key, [{ id: "a", site }]);
    await waiting; storage.removeItem(key); release();
    await assert.rejects(pending, isError("changed"));
  } finally { crypto.subtle.digest = original; }
});


test("portable replay import verifies the current site and preserves all live match data", async () => {
  const { c, source } = complete(true);
  const live = structuredClone(c.getState());
  const raw = await createLocalReplayArchive(source);
  const other = structuredClone(site); other.originX++;
  const verified = await restoreLocalReplayArchiveForSites(raw, [{ id: "other", site: other }, { id: "match", site }]);
  assert.equal(verified.id, "match");
  assert.deepEqual(verified.rounds, source.rounds);
  assert.deepEqual(c.getState(), live);
  await assert.rejects(restoreLocalReplayArchiveForSites(raw, [{ id: "other", site: other }]), isError("incompatible"));
  await assert.rejects(restoreLocalReplayArchiveForSites("{", [{ id: "match", site }]), isError("invalid"));
  const changed = JSON.parse(raw); changed.resultDigest = "0".repeat(64);
  await assert.rejects(restoreLocalReplayArchiveForSites(JSON.stringify(changed), [{ id: "match", site }]), isError("incompatible"));
  const { storage, data } = memoryLibrary();
  const first = saveImportedLocalReplay(storage, raw, verified.rounds.length);
  assert.equal(first.existing, false);
  assert.equal(readLocalReplayEntryArchive(storage, first.key), raw);
  const before = new Map(data);
  assert.deepEqual(saveImportedLocalReplay(storage, raw, verified.rounds.length), { key: first.key, existing: true });
  assert.deepEqual(data, before);
  assert.equal(findLocalReplayArchive(storage, raw), first.key);
  assert.throws(() => readLocalReplayEntryArchive(storage, "other-key"), isError("invalid"));
  storage.setItem(first.key, "{broken");
  assert.throws(() => readLocalReplayEntryArchive(storage, first.key), isError("invalid"));
  assert.equal(findLocalReplayArchive(storage, raw), null);
});

test("portable replay export supports the legacy slot and fails safely on storage errors", async () => {
  const raw = await createLocalReplayArchive(complete(false).source);
  const { storage } = memoryLibrary();
  storage.setItem(LOCAL_REPLAY_KEY, raw);
  assert.equal(readLocalReplayEntryArchive(storage, LOCAL_REPLAY_KEY), raw);
  assert.equal(findLocalReplayArchive(storage, raw), LOCAL_REPLAY_KEY);
  storage.removeItem(LOCAL_REPLAY_KEY);
  assert.equal(readLocalReplayEntryArchive(storage, LOCAL_REPLAY_KEY), null);
  storage.setItem(LOCAL_REPLAY_KEY, raw);
  const denied = { ...storage, getItem: () => { throw Error("denied"); } };
  assert.throws(() => readLocalReplayEntryArchive(denied, LOCAL_REPLAY_KEY), isError("storage"));
  assert.throws(() => findLocalReplayArchive(denied, raw), isError("storage"));
});

for (const difficulty of ["easy", "normal", "hard"] as DifficultyId[]) test(`difficulty ${difficulty} survives replay serialization and reconstruction`, async () => {
  const match = matchFromSite(site, { preset: "covers_sparse_mid", script: "siege", difficulty });
  bossPrepare(match);
  const c = createMechaController({ site, match, deployment: false, script: "siege", animate: false,
    planner: state => ({ revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) }) });
  c.startAuto();
  for (let i = 0; i < 100 && !c.getState().match.outcome; i++) c.tick();
  const source = c.replayArchiveSource(); assert.ok(source);
  const raw = await createLocalReplayArchive(source);
  assert.equal(JSON.parse(raw).difficulty, difficulty);
  assert.deepEqual(await restoreLocalReplayArchive(raw, site), source.rounds);
  const invalid = JSON.parse(raw); invalid.difficulty = "unknown";
  await assert.rejects(restoreLocalReplayArchive(JSON.stringify(invalid), site), isError("invalid"));
});
