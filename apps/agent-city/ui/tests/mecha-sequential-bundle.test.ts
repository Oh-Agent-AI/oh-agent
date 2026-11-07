import test from "node:test";
import assert from "node:assert/strict";
import { MECH_IDS } from "../src/game/mecha/board.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { SequentialController } from "../src/game/mecha/sequentialController.ts";
import { createSequentialReplayBundle, restoreSequentialReplayBundle, statusDeploymentFromSite, type StatusMonsterId } from "../src/game/mecha/sequentialReplayBundle.ts";
import { applyDeployPlan } from "../src/game/mecha/deployment.ts";
import { SequentialTurn } from "../src/game/mecha/sequentialTurn.ts";
import { deleteSequentialReplay, listSequentialReplays, loadSequentialReplay, saveSequentialReplay } from "../src/game/mecha/sequentialReplayRepository.ts";
import type { ReplayBackend } from "../src/game/mecha/replayBackend.ts";
import { checkpointStore, readSequentialCheckpoint, type Checkpoint, type CheckpointBackend } from "../src/game/mecha/sequentialCheckpoint.ts";
import { SequentialDurableAuthority } from "../src/game/mecha/sequentialDurable.ts";
import { projectStatusForecastState, statusForecast } from "../src/game/mecha/statusForecast.ts";

const site: CityMechaSite = {
  originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: [{ id: "private-building", cells: [{ x: 1, y: 4 }], x: 1, z: 4, yaw: 0, ground: 0, height: 12 }], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })), boss: { x: 4, y: 0 },
  raiders: [{ id: "private-raider", pos: { x: 1, y: 2 } }], spawnSpread: 0,
};
test("forecast reprojects a committed move without changing the frozen direction or authority", () => {
  const arena: CityMechaSite = { ...structuredClone(site), boss: { x: 4, y: 4 }, buildings: [], raiders: [],
    mechs: [{ id: "Assault", pos: { x: 4, y: 7 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] };
  const pending = statusDeploymentFromSite(arena, "prism_warden");
  const deployed = applyDeployPlan(pending, { revision: pending.revision, placements: arena.mechs.map(unit => ({ mechId: unit.id, pos: unit.pos })) }); assert.ok(deployed.ok);
  const turn = new SequentialTurn(deployed.state), direction = structuredClone(deployed.state.boss.intent!.direction);
  const moved = turn.execute({ kind: "move", id: "move", revision: deployed.state.revision, mech: "Assault", to: { x: 3, y: 7 } }); assert.ok(moved.ok);
  const before = structuredClone(moved.snapshot.match), projected = projectStatusForecastState(moved.snapshot.match); assert.ok(projected);
  assert.deepEqual(moved.snapshot.match, before);
  assert.deepEqual(projected.boss.intent!.direction, direction);
  assert.equal(statusForecast(projected)?.skill, "prism_frost");
  assert.equal(statusForecast(projected)?.cells.some(cell => cell.x === 3 && cell.y === 7), false);
});
function played() {
  const c = new SequentialController(matchFromSite(site, { ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "siege", deployment: true }));
  assert.equal(c.replayEvidence(), null);
  MECH_IDS.forEach((id, i) => c.place(id, { x: i * 3, y: 8 })); c.confirmDeployment();
  c.execute({ kind: "move", mech: "Assault", to: { x: 0, y: 7 } }); c.finishPresentation();
  c.select("Assault"); c.execute({ kind: "undo", mech: "Assault" }); c.finishPresentation();
  c.execute({ kind: "act", mech: "Gunner", action: { kind: "skip" } }); c.finishPresentation();
  c.execute({ kind: "reset" }); c.finishPresentation();
  c.execute({ kind: "end", confirmUnused: true }); c.finishPresentation();
  const evidence = c.replayEvidence(); assert.ok(evidence);
  return { c, evidence };
}

for (const speciesId of ["spore_leaper", "flux_lancer", "prism_warden", "gravity_core"] as StatusMonsterId[]) {
  test(`v2 status bundle reconstructs ${speciesId} opening and validates its command history`, async () => {
    const pending = statusDeploymentFromSite(site, speciesId);
    const placements = MECH_IDS.map((mechId, i) => ({ mechId, pos: { x: i * 3, y: 8 } }));
    const deployed = applyDeployPlan(pending, { revision: pending.revision, placements }); assert.ok(deployed.ok);
    const turn = new SequentialTurn(deployed.state);
    const ended = turn.execute({ kind: "end", id: "c0", revision: deployed.state.revision, confirmUnused: true }); assert.ok(ended.ok);
    const evidence = { placements, initial: deployed.state, records: turn.records() };
    const raw = await createSequentialReplayBundle(site, evidence), parsed = JSON.parse(raw);
    assert.equal(parsed.schema, "mecha-sequential-bundle:v2"); assert.equal(parsed.replay.schema, "mecha-sequential-replay:v2");
    assert.equal(parsed.opening.encounter.speciesId, speciesId);
    assert.ok(!raw.includes("private-building") && !raw.includes("private-raider"));
    const restored = await restoreSequentialReplayBundle(site, raw);
    assert.deepEqual(restored.session.snapshot(), turn.snapshot());
    for (const edit of [
      (value: any) => { value.opening.encounter.statusRules = "unknown"; },
      (value: any) => { value.opening.encounter.speciesId = "neural_weaver"; },
      (value: any) => { value.replay.schema = "mecha-sequential-replay:v1"; },
      (value: any) => { value.replay.entries[0].eventDigest = "0".repeat(64); },
      (value: any) => { value.opening.encounter.extra = true; },
    ]) { const damaged = JSON.parse(raw); edit(damaged); await assert.rejects(restoreSequentialReplayBundle(site, JSON.stringify(damaged))); }
  });
}

test("v2 checkpoint restores an actual frozen mech and deduplicates a lost acknowledgement", async () => {
  const encounterSite: CityMechaSite = { ...structuredClone(site), boss: { x: 4, y: 4 }, buildings: [], raiders: [],
    mechs: [{ id: "Assault", pos: { x: 4, y: 7 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 9, y: 9 } }] };
  const pending = statusDeploymentFromSite(encounterSite, "prism_warden");
  const placements = encounterSite.mechs.map(unit => ({ mechId: unit.id, pos: { ...unit.pos } }));
  const deployed = applyDeployPlan(pending, { revision: pending.revision, placements }); assert.ok(deployed.ok);
  let saved: Checkpoint = { revision: 0, raw: null };
  const backend: CheckpointBackend = { async read() { return structuredClone(saved); }, async write(revision, raw) {
    if (revision !== saved.revision) throw new Error("conflict"); saved = { revision: revision + 1, raw }; return saved.revision;
  } };
  const authority = new SequentialDurableAuthority(deployed.state, [], checkpointStore(encounterSite, { initial: deployed.state, placements }, backend, 0, deployed.state.revision));
  const command = { kind: "end" as const, id: "c0", revision: deployed.state.revision, confirmUnused: true };
  const first = await authority.execute(command); assert.ok(first.ok);
  assert.ok(first.snapshot.match.statusEncounter?.statuses.some(status => status.kind === "freeze" && status.target === "Assault"));
  const recovered = await readSequentialCheckpoint(encounterSite, backend); assert.ok(recovered.restored);
  assert.deepEqual(recovered.restored.session.snapshot(), authority.snapshot());
  const evidence = { ...recovered.restored, records: recovered.restored.session.records() };
  const matching = new SequentialController(statusDeploymentFromSite(encounterSite, "prism_warden"));
  const different = new SequentialController(statusDeploymentFromSite(encounterSite, "spore_leaper"));
  assert.equal(different.canRestore(evidence), false);
  assert.equal(matching.canRestore(evidence), true); assert.equal(matching.restore(evidence), true);
  assert.deepEqual(matching.getState().match, first.snapshot.match);
  let writes = 0;
  const retry = new SequentialDurableAuthority(recovered.restored.initial, recovered.restored.session.records(), { async commit() { writes++; } });
  assert.deepEqual(await retry.execute(command), first); assert.equal(writes, 0);
  assert.deepEqual(await retry.execute({ kind: "move", id: "c1", revision: first.snapshot.match.revision, mech: "Assault", to: { x: 3, y: 7 } }), { ok: false, reason: "status_blocks_move" });
});

test("v1.5 bundle reconstructs deployment and ordered commands without storing city identifiers", async () => {
  const { c, evidence } = played();
  const raw = await createSequentialReplayBundle(site, evidence);
  assert.ok(!raw.includes("private-building")); assert.ok(!raw.includes("private-raider")); assert.ok(!raw.includes("originX"));
  const restored = await restoreSequentialReplayBundle(site, raw);
  assert.deepEqual(restored.session.snapshot().match, c.getState().match);
  assert.deepEqual(restored.session.records().map(record => record.command.kind), ["move", "undo", "act", "reset", "end"]);
  assert.deepEqual(restored.session.records().filter(record => record.causalEvent).map(record => record.causalEvent!.kind), ["undo_move", "reset_turn"]);
  evidence.placements[0]!.pos.x = 9;
  assert.equal(c.replayEvidence()!.placements[0]!.pos.x, 0);
});

test("v1.5 bundle rejects wrong site, altered opening, commands, versions and source evidence", async () => {
  const { evidence } = played(), raw = await createSequentialReplayBundle(site, evidence);
  const wrong = structuredClone(site); wrong.originX++;
  await assert.rejects(restoreSequentialReplayBundle(wrong, raw), /invalid_sequential_bundle/);
  for (const edit of [
    (v: any) => { v.ruleset = "mecha-v1.4"; },
    (v: any) => { v.opening.placements[0].pos.x = 10; },
    (v: any) => { v.opening.placements[0].pos = v.opening.placements[1].pos; },
    (v: any) => { v.opening.secret = "data"; },
    (v: any) => { v.replay.entries[0].command.to.x++; },
    (v: any) => { v.replay.entries[0].eventDigest = "0".repeat(64); },
    (v: any) => { v.replay.entries = []; },
  ]) {
    const value = JSON.parse(raw); edit(value);
    await assert.rejects(restoreSequentialReplayBundle(site, JSON.stringify(value)));
  }
  const changed = structuredClone(evidence); changed.initial.boss.hp--;
  await assert.rejects(createSequentialReplayBundle(site, changed), /invalid_sequential_bundle/);
  const empty = await createSequentialReplayBundle(site, { ...evidence, records: [] });
  assert.deepEqual((await restoreSequentialReplayBundle(site, empty)).session.snapshot().match, evidence.initial);
});

test("local repository verifies before saving, reads back and restores without mixing records", async () => {
  const rows = new Map<string, string>();
  const backend: ReplayBackend = {
    async list() { return [...rows].map(([key, raw]) => ({ key, raw })); },
    async insert(key, raw) { rows.set(key, raw); },
    async delete(key) { rows.delete(key); },
  };
  const { c, evidence } = played(), raw = await createSequentialReplayBundle(site, evidence);
  await assert.rejects(saveSequentialReplay({ ...site, originX: 8 }, raw, backend));
  assert.equal(rows.size, 0);
  const key = await saveSequentialReplay(site, raw, backend);
  rows.set("agent-city:mecha-local-replay-entry:v1:12345678-1234-1234-1234-123456789abc", "legacy");
  rows.set("unrecognized-record", "unknown");
  const list = await listSequentialReplays(backend);
  assert.equal(list.length, 1); assert.equal(list[0]!.damaged, false);
  assert.deepEqual((await loadSequentialReplay(site, key, backend)).session.snapshot().match, c.getState().match);
  rows.set(key, "broken"); assert.equal((await listSequentialReplays(backend))[0]!.damaged, true);
  await assert.rejects(loadSequentialReplay(site, key, backend), /invalid_sequential_entry/);
  await deleteSequentialReplay(key, backend); assert.equal(rows.size, 2);
});

test("resuming a saved match rebuilds undo, rights, checkpoint and spent reset without id collisions", async () => {
  const { c, evidence } = played();
  const raw = await createSequentialReplayBundle(site, evidence);
  const restored = await restoreSequentialReplayBundle(site, raw);
  const next = new SequentialController(matchFromSite(site, { ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "siege", deployment: true }));
  assert.equal(next.restore({ ...restored, records: restored.session.records() }), true);
  assert.deepEqual(next.getState().match, c.getState().match);
  assert.deepEqual(next.getState().rights, c.getState().rights);
  assert.equal(next.getState().resetUsed, true);
  next.execute({ kind: "reset" }); assert.equal(next.getState().error, "reset_used");
  next.execute({ kind: "act", mech: "Gunner", action: { kind: "skip" } }); next.finishPresentation();
  assert.equal(next.records().length, evidence.records.length + 1);
  assert.equal(new Set(next.records().map(record => record.command.id)).size, next.records().length);
  const continued = next.replayEvidence(); assert.ok(continued);
  const again = await restoreSequentialReplayBundle(site, await createSequentialReplayBundle(site, continued));
  assert.deepEqual(again.session.snapshot().match, next.getState().match);
});

test("resume preserves move undo and rejects altered evidence without replacing the current match", async () => {
  const start = () => new SequentialController(matchFromSite(site, { ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "siege", deployment: true }));
  const original = start(); MECH_IDS.forEach((id, i) => original.place(id, { x: i * 3, y: 8 })); original.confirmDeployment();
  original.execute({ kind: "move", mech: "Assault", to: { x: 0, y: 7 } }); original.finishPresentation();
  const evidence = original.replayEvidence(); assert.ok(evidence);
  const next = start(), before = structuredClone(next.getState());
  const bad = structuredClone(evidence); bad.records[0]!.snapshot.match.boss.hp--;
  assert.equal(next.restore(bad), false); assert.deepEqual(next.getState(), before);
  assert.equal(next.restore(evidence), true); assert.equal(next.getState().canUndo, true);
  next.execute({ kind: "undo", mech: "Assault" }); next.finishPresentation();
  assert.deepEqual(next.getState().match.mechs[0]!.pos, { x: 0, y: 8 });
  assert.equal(next.getState().rights!.Assault.move, true);
});

test("a completed replay remains viewable but cannot replace a live match", async () => {
  const { c } = played();
  for (let i = 0; i < 20 && !c.getState().match.outcome; i++) {
    c.execute({ kind: "end", confirmUnused: true }); c.finishPresentation();
  }
  assert.ok(c.getState().match.outcome);
  const evidence = c.replayEvidence(); assert.ok(evidence);
  const restored = await restoreSequentialReplayBundle(site, await createSequentialReplayBundle(site, evidence));
  assert.ok(restored.session.snapshot().match.outcome);
  const live = new SequentialController(matchFromSite(site, { ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "siege", deployment: true }));
  const before = structuredClone(live.getState());
  assert.equal(live.restore({ ...restored, records: restored.session.records() }), false);
  assert.deepEqual(live.getState(), before);
});

test("checkpoint write-ahead persists verified commands and rejects a stale writer", async () => {
  let saved: Checkpoint = { revision: 0, raw: null };
  const backend: CheckpointBackend = {
    async read() { return structuredClone(saved); },
    async write(version, raw) { if (version !== saved.revision) throw new Error("conflict"); saved = { revision: version + 1, raw }; return saved.revision; },
  };
  const source = played().evidence;
  const restoredSource = await restoreSequentialReplayBundle(site, await createSequentialReplayBundle(site, source));
  const evidence = { initial: restoredSource.initial, placements: restoredSource.placements, records: restoredSource.session.records() };
  const oldRevision = evidence.records.at(-1)!.revision;
  const make = () => new SequentialDurableAuthority(evidence.initial, evidence.records,
    checkpointStore(site, evidence, backend, 0, oldRevision));
  const first = make(), stale = make();
  const command = { kind: "act" as const, id: `c${evidence.records.length}`, revision: oldRevision, mech: "Gunner" as const, action: { kind: "skip" as const } };
  assert.ok((await first.execute(command)).ok);
  const read = await readSequentialCheckpoint(site, backend); assert.ok(read.restored);
  assert.equal(read.checkpoint.revision, 1);
  assert.deepEqual(read.restored.session.snapshot(), first.snapshot());
  assert.equal(read.restored.session.records().at(-1)!.command.id, command.id);
  let unexpectedWrites = 0;
  const recovered = new SequentialDurableAuthority(read.restored.initial, read.restored.session.records(), { async commit() { unexpectedWrites++; } });
  assert.ok((await recovered.execute(command)).ok); assert.equal(unexpectedWrites, 0, "same command remains idempotent after checkpoint restore");
  assert.deepEqual(await stale.execute(command), { ok: false, reason: "storage_unconfirmed" });
  assert.equal(stale.needsReload(), true);
  assert.equal(stale.snapshot().match.revision, oldRevision);
  const otherSite = structuredClone(site); otherSite.originX++;
  await assert.rejects(readSequentialCheckpoint(otherSite, backend), /invalid_sequential_bundle/);
});

test("checkpoint readback failure freezes the match until durable history is reloaded", async () => {
  let saved: Checkpoint = { revision: 0, raw: null }, failRead = true;
  const backend: CheckpointBackend = {
    async read() { if (failRead) throw new Error("read failed"); return structuredClone(saved); },
    async write(version, raw) { if (version !== saved.revision) throw new Error("conflict"); saved = { revision: version + 1, raw }; return saved.revision; },
  };
  const source = played().evidence;
  const restoredSource = await restoreSequentialReplayBundle(site, await createSequentialReplayBundle(site, source));
  const evidence = { initial: restoredSource.initial, placements: restoredSource.placements, records: restoredSource.session.records() };
  const revision = evidence.records.at(-1)!.revision;
  const session = new SequentialDurableAuthority(evidence.initial, evidence.records, checkpointStore(site, evidence, backend, 0, revision));
  const result = await session.execute({ kind: "act", id: `c${evidence.records.length}`, revision, mech: "Gunner", action: { kind: "skip" } });
  assert.deepEqual(result, { ok: false, reason: "storage_unconfirmed" });
  assert.equal(session.snapshot().match.revision, revision); assert.equal(session.needsReload(), true);
  failRead = false;
  const recovered = await readSequentialCheckpoint(site, backend); assert.ok(recovered.restored);
  assert.equal(recovered.restored.session.snapshot().match.revision, revision + 1);
  assert.equal(recovered.restored.session.records().length, evidence.records.length + 1);
});

test("checkpoint rejects noncanonical command identities before writing", async () => {
  const { evidence } = played(); let writes = 0;
  const backend: CheckpointBackend = {
    async read() { return { revision: 0, raw: null }; },
    async write() { writes++; return 1; },
  };
  const revision = evidence.records.at(-1)!.revision;
  const session = new SequentialDurableAuthority(evidence.initial, evidence.records, checkpointStore(site, evidence, backend, 0, revision));
  assert.deepEqual(await session.execute({ kind: "act", id: "not-canonical", revision, mech: "Gunner", action: { kind: "skip" } }), { ok: false, reason: "storage_unconfirmed" });
  assert.equal(writes, 0); assert.equal(session.snapshot().match.revision, revision);
});
