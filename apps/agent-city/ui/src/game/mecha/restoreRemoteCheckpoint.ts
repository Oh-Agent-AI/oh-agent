import type { CityMechaSite } from "./citySite";
import type { SequentialSnapshot } from "./contracts/sequentialTransport";
import { canonicalJson } from "./contracts/match";
import { checkpointStore, writeSequentialCheckpoint, type CheckpointBackend } from "./sequentialCheckpoint";
import { restoreSequentialReplayBundle } from "./sequentialReplayBundle";
import { restoreSequentialSnapshot } from "./session/SequentialMatchSession";
import type { SequentialController } from "./sequentialController";
import { SequentialTurn } from "./sequentialTurn";
import { enemyPlannerFor } from "./enemy/policy";

/** Persist and verify the frozen phone history before enabling desktop input. */
export async function restoreRemoteCheckpoint(site: CityMechaSite, backend: CheckpointBackend, controller: SequentialController, snapshot: SequentialSnapshot): Promise<number> {
  const session = restoreSequentialSnapshot(snapshot);
  const enemyPolicy = snapshot.enemyPolicy ?? "scripted";
  const evidence = { initial: snapshot.initial, placements: snapshot.placements, records: session.records(), enemyPolicy };
  const current = await backend.read();
  if (!current.raw) throw new Error("checkpoint_unavailable");
  const existing = await restoreSequentialReplayBundle(site, JSON.parse(current.raw).archive);
  const desktop = controller.replayEvidence();
  if (!desktop) throw new Error("checkpoint_unavailable");
  const desktopState = SequentialTurn.replay(desktop.initial, desktop.records, { enemyPlanner: enemyPlannerFor(desktop.enemyPolicy) }).snapshot();
  const savedState = canonicalJson(existing.session.snapshot());
  if (savedState !== canonicalJson(desktopState) && savedState !== canonicalJson(session.snapshot())) throw new Error("checkpoint_conflict");
  const version = await writeSequentialCheckpoint(site, evidence, backend, current.revision);
  const saved = await backend.read();
  if (!saved.raw || saved.revision !== version) throw new Error("checkpoint_unavailable");
  const normalized = (await restoreSequentialReplayBundle(site, JSON.parse(saved.raw).archive)).session;
  controller.replaceFromSnapshot({ ...snapshot, enemyPolicy, commands: normalized.records().map(record => record.command) });
  if (!normalized.snapshot().match.outcome && !controller.attachDurable(checkpointStore(site, evidence, backend, version, normalized.snapshot().match.revision, enemyPolicy))) throw new Error("durability_unavailable");
  return version;
}
