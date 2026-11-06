import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReadyCitySurfaceCapture } from "../../engine/surface/citySurfacePort";
import type { CollisionDimensions } from "../driving/CollisionIndex";
import { deriveSpawnCandidates, validateSpawnSpec, DRIVING_SPAWN_SCHEMA_VERSION, type VerifiedSpawnCredential } from "../driving/spawnPoints";
import type { PublishedDrivingGraph } from "../driving/audit/ReleasedDrivingGraph";
import type { SpawnCandidateChoice, SpawnConfirmationBinding, SpawnConfirmationSnapshot } from "../driving/SpawnConfirmation";
import { DrivingSpawnConfirmationPanel } from "./DrivingSpawnConfirmationPanel";
import type { GameLocale } from "../gameCopy";

type ConfirmationActions = Readonly<{
  deriveSpawnCandidates(binding: SpawnConfirmationBinding, candidates: readonly SpawnCandidateChoice[]): boolean;
  validateSpawnCandidate(binding: SpawnConfirmationBinding, credential: VerifiedSpawnCredential): boolean;
  confirmSpawn(binding: SpawnConfirmationBinding, spawnId: string): boolean;
  cancelSpawn(): void;
  invalidateSpawn(reason?: string): void;
}>;

/** Connects the audit controller's real published graph to the official spawn
 * credential flow. No graph (or stale graph) means no candidates and no proof. */
export function DrivingSpawnConfirmationController({
  publishedGraph, capture, binding, snapshot, actions, dimensions, centerHeight, locale, onEnter,
}: {
  publishedGraph: PublishedDrivingGraph | null;
  capture: ReadyCitySurfaceCapture | null;
  binding: SpawnConfirmationBinding | null;
  snapshot: SpawnConfirmationSnapshot;
  actions: ConfirmationActions;
  dimensions: CollisionDimensions;
  centerHeight: number;
  locale: GameLocale;
  onEnter: () => void;
}) {
  const [validationError, setValidationError] = useState<string | null>(null);
  const current = !!publishedGraph && !!capture && !!binding && publishedGraph.isCurrent() && capture.isLeaseCurrent() &&
    publishedGraph.graph.key.baseSnapshotHash === capture.worldRevision &&
    binding.worldRevision === capture.worldRevision &&
    binding.graphBoundaryHash === publishedGraph.graph.releaseBoundaryHash &&
    binding.vehicleConfigHash === publishedGraph.graph.key.vehicleConfigHash;
  const candidates = useMemo(() => current && publishedGraph
    ? deriveSpawnCandidates(publishedGraph.graph, (unitId) => publishedGraph.graph.geometry.find((entry) => entry.unitId === unitId)?.boundaryEvidence?.layerId ?? "")
    : [], [current, publishedGraph]);
  const choices = useMemo(() => candidates.map((candidate) => Object.freeze({ id: candidate.id, sourceUnitId: candidate.sourceUnitId })), [candidates]);
  const bindingIdentity = binding ? `${binding.sceneId}\u0000${binding.worldRevision}\u0000${binding.graphBoundaryHash}\u0000${binding.vehicleConfigHash}` : "";
  const latest = useRef({ bindingIdentity, publishedGraph, capture, binding, current });
  latest.current = { bindingIdentity, publishedGraph, capture, binding, current };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => () => actionsRef.current.invalidateSpawn("spawn-confirmation-controller-unmounted"), []);

  useEffect(() => {
    setValidationError(null);
    const currentBinding = latest.current.binding;
    if (!currentBinding) return;
    if (!current) {
      actionsRef.current.deriveSpawnCandidates(currentBinding, []);
      return;
    }
    actionsRef.current.deriveSpawnCandidates(currentBinding, choices);
  }, [bindingIdentity, choices, current]);

  const select = useCallback(async (spawnId: string) => {
    setValidationError(null);
    const candidate = candidates.find((entry) => entry.id === spawnId);
    const graph = publishedGraph;
    const worldCapture = capture;
    if (!candidate || !graph || !worldCapture || !binding || !current || !graph.isCurrent() || !worldCapture.isLeaseCurrent()) {
      actions.invalidateSpawn("spawn-validation-stale-or-missing-release");
      return;
    }
    const world = { capture: worldCapture, graph: graph.graph, isGraphCurrent: graph.isCurrent };
    let result: Awaited<ReturnType<typeof validateSpawnSpec>>;
    try {
      result = await validateSpawnSpec(world, {
        schemaVersion: DRIVING_SPAWN_SCHEMA_VERSION,
        worldRevision: worldCapture.worldRevision,
        vehicleConfigHash: binding.vehicleConfigHash,
        spawns: [{ id: candidate.id, sourceUnitId: candidate.sourceUnitId, x: candidate.x, z: candidate.z,
          heading: candidate.heading, layerId: candidate.layerId }],
      }, dimensions, centerHeight);
    } catch {
      actions.invalidateSpawn("spawn-validation-failed");
      setValidationError("spawn-validation-failed");
      return;
    }
    const now = latest.current;
    if (now.bindingIdentity !== bindingIdentity || now.publishedGraph !== graph || now.capture !== worldCapture ||
      !now.current || !graph.isCurrent() || !worldCapture.isLeaseCurrent()) {
      actions.invalidateSpawn("spawn-validation-stale-or-mismatched");
      return;
    }
    if (!result.ok) {
      setValidationError(result.reason);
      return;
    }
    const credential = result.credentials.find((entry) => entry.spawnId === spawnId);
    if (!credential || !actions.validateSpawnCandidate(binding, credential)) setValidationError("spawn-validation-stale-or-mismatched");
  }, [actions, binding, bindingIdentity, candidates, capture, centerHeight, current, dimensions, publishedGraph]);

  const confirm = useCallback((spawnId: string) => {
    if (!binding || !current || !publishedGraph?.isCurrent() || !capture?.isLeaseCurrent() ||
      !actions.confirmSpawn(binding, spawnId)) actions.invalidateSpawn("spawn-confirmation-stale-or-mismatched");
  }, [actions, binding, capture, current, publishedGraph]);
  const cancel = useCallback(() => {
    setValidationError(null);
    actions.cancelSpawn();
  }, [actions]);

  return <>
    <DrivingSpawnConfirmationPanel snapshot={snapshot} locale={locale} onSelectCandidate={(id) => { void select(id); }}
      onConfirm={confirm} onEnter={onEnter} onCancel={cancel} />
    {validationError ? <p role="status" className="city-game-spawn-validation-error">{validationError}</p> : null}
  </>;
}
