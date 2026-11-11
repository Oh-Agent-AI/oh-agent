import type { GameSceneAcquisition, GameSceneLease, GameScenePort, GameSelection } from "../game/runtime/GameScenePort";

export type RemoteGameplayLease<Snapshot, VisualObject> = GameSceneLease<Snapshot, VisualObject>;
export type RemoteGameplayHost<Snapshot, VisualObject> = Pick<GameScenePort<Snapshot, VisualObject>, "acquireResult">;

/** Acquire the existing City scene lease for a remote game. The host owns
 * camera/object exclusivity; this bridge adds no parallel lease state. */
export async function acquireRemoteGameplay<Snapshot, VisualObject>(
  host: RemoteGameplayHost<Snapshot, VisualObject>,
  selection: GameSelection,
  runId: number,
  signal: AbortSignal,
): Promise<RemoteGameplayLease<Snapshot, VisualObject>> {
  if (signal.aborted) throw new Error("remote_game_cancelled");
  let result: GameSceneAcquisition<Snapshot, VisualObject>;
  try { result = await host.acquireResult(selection, runId, signal); }
  catch { throw new Error(signal.aborted ? "remote_game_cancelled" : "remote_scene_unavailable"); }
  if (signal.aborted) {
    if (result.status === "ready") result.lease.release();
    throw new Error("remote_game_cancelled");
  }
  if (result.status !== "ready") throw new Error(`remote_scene_${result.reason || result.status}`);
  return result.lease;
}
