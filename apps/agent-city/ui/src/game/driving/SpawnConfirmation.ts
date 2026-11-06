import { isVerifiedSpawnCredential, type VerifiedSpawnCredential } from "./spawnPoints";

/** Identity of the exact scene and released graph against which a candidate was validated. */
export type SpawnConfirmationBinding = Readonly<{
  sceneId: string;
  worldRevision: string;
  graphBoundaryHash: string;
  vehicleConfigHash: string;
}>;

export type SpawnCandidateChoice = Readonly<{ id: string; sourceUnitId: string }>;
export type SpawnConfirmationSnapshot = Readonly<
  | { status: "unavailable"; reason: string }
  | { status: "derived"; binding: SpawnConfirmationBinding; candidates: readonly SpawnCandidateChoice[]; selectedSpawnId: string | null }
  | { status: "validated"; binding: SpawnConfirmationBinding; candidates: readonly SpawnCandidateChoice[]; selectedSpawnId: string }
  | { status: "confirmed"; binding: SpawnConfirmationBinding; candidates: readonly SpawnCandidateChoice[]; selectedSpawnId: string }
  | { status: "invalidated"; reason: string }
>;
export type FormalSpawnResolution = Readonly<{ ok: true; credential: VerifiedSpawnCredential } | { ok: false; reason: string }>;

const unavailable = (reason: string): SpawnConfirmationSnapshot => Object.freeze({ status: "unavailable", reason });
const invalidated = (reason: string): SpawnConfirmationSnapshot => Object.freeze({ status: "invalidated", reason });
function sameBinding(a: SpawnConfirmationBinding, b: SpawnConfirmationBinding): boolean {
  return a.sceneId === b.sceneId && a.worldRevision === b.worldRevision && a.graphBoundaryHash === b.graphBoundaryHash &&
    a.vehicleConfigHash === b.vehicleConfigHash;
}
function validBinding(value: SpawnConfirmationBinding): boolean {
  return [value.sceneId, value.worldRevision, value.graphBoundaryHash, value.vehicleConfigHash].every((part) => typeof part === "string" && part.trim().length > 0);
}

/** Instance-local explicit selection. It holds only a sealed credential after full validation; it never persists. */
export class SpawnConfirmationStore {
  private current: SpawnConfirmationSnapshot = unavailable("released-graph-unavailable");
  private credential: VerifiedSpawnCredential | null = null;
  private readonly listeners = new Set<() => void>();

  get snapshot(): SpawnConfirmationSnapshot { return this.current; }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  private publish(next: SpawnConfirmationSnapshot, credential: VerifiedSpawnCredential | null = null): void {
    this.current = next;
    this.credential = credential;
    for (const listener of this.listeners) listener();
  }

  derive(binding: SpawnConfirmationBinding, candidates: readonly SpawnCandidateChoice[]): boolean {
    if (!validBinding(binding)) { this.invalidate("scene-binding-unavailable"); return false; }
    const ids = new Set<string>();
    for (const item of candidates) {
      if (!item.id.trim() || !item.sourceUnitId.trim() || ids.has(item.id)) { this.invalidate("invalid-spawn-candidates"); return false; }
      ids.add(item.id);
    }
    if (!candidates.length) { this.publish(unavailable("no-validated-spawn-candidates")); return false; }
    const frozenBinding = Object.freeze({ ...binding });
    const frozenCandidates = Object.freeze(candidates.map((item) => Object.freeze({ ...item })));
    this.publish(Object.freeze({ status: "derived", binding: frozenBinding, candidates: frozenCandidates, selectedSpawnId: null }));
    return true;
  }

  validate(binding: SpawnConfirmationBinding, credential: VerifiedSpawnCredential): boolean {
    const current = this.current;
    if (current.status !== "derived" || !sameBinding(current.binding, binding) || !isVerifiedSpawnCredential(credential) || !credential.isFresh() ||
      credential.worldRevision !== binding.worldRevision || credential.graphBoundaryHash !== binding.graphBoundaryHash ||
      credential.vehicleConfigHash !== binding.vehicleConfigHash ||
      !current.candidates.some((item) => item.id === credential.spawnId && item.sourceUnitId === credential.sourceUnitId)) {
      this.invalidate("spawn-validation-stale-or-mismatched"); return false;
    }
    this.publish(Object.freeze({ status: "validated", binding: current.binding, candidates: current.candidates, selectedSpawnId: credential.spawnId }), credential);
    return true;
  }

  confirm(binding: SpawnConfirmationBinding, spawnId: string): boolean {
    const current = this.current;
    // Confirmation is idempotent for the same live authorization. Repeated clicks
    // must not turn an already confirmed candidate into an invalidated session.
    if (current.status === "confirmed" && sameBinding(current.binding, binding) && current.selectedSpawnId === spawnId &&
      this.credential && isVerifiedSpawnCredential(this.credential) && this.credential.isFresh()) return true;
    if (current.status !== "validated" || !sameBinding(current.binding, binding) || current.selectedSpawnId !== spawnId ||
      !this.credential || !isVerifiedSpawnCredential(this.credential) || !this.credential.isFresh()) {
      this.invalidate("spawn-confirmation-stale-or-mismatched"); return false;
    }
    this.publish(Object.freeze({ status: "confirmed", binding: current.binding, candidates: current.candidates, selectedSpawnId: spawnId }), this.credential);
    return true;
  }

  getConfirmed(binding: SpawnConfirmationBinding): VerifiedSpawnCredential | null {
    const current = this.current;
    if (current.status !== "confirmed" || !sameBinding(current.binding, binding) || !this.credential ||
      !isVerifiedSpawnCredential(this.credential) || !this.credential.isFresh() ||
      this.credential.worldRevision !== binding.worldRevision || this.credential.graphBoundaryHash !== binding.graphBoundaryHash ||
      this.credential.vehicleConfigHash !== binding.vehicleConfigHash) {
      if (current.status === "confirmed") this.invalidate("spawn-confirmation-invalidated");
      return null;
    }
    return this.credential;
  }

  cancel(): void { this.invalidate("user-cancelled"); }
  invalidate(reason = "scene-or-vehicle-changed"): void { this.publish(invalidated(reason)); }
  markUnavailable(reason = "released-graph-unavailable"): void { this.publish(unavailable(reason)); }
}

/** One authorization gate shared by the hook and its executable regression guard. */
export function resolveFormalSpawn(store: SpawnConfirmationStore, binding: SpawnConfirmationBinding | null | undefined,
  currentCredential: VerifiedSpawnCredential | null): FormalSpawnResolution {
  if (!binding || !currentCredential) return Object.freeze({ ok: false, reason: "released-graph-or-spawn-unavailable" });
  const confirmed = store.getConfirmed(binding);
  if (!confirmed) return Object.freeze({ ok: false, reason: "spawn-confirmation-required" });
  if (confirmed !== currentCredential || !isVerifiedSpawnCredential(currentCredential) || !currentCredential.isFresh() ||
    currentCredential.worldRevision !== binding.worldRevision || currentCredential.graphBoundaryHash !== binding.graphBoundaryHash ||
    currentCredential.vehicleConfigHash !== binding.vehicleConfigHash) {
    store.invalidate("spawn-confirmation-invalidated");
    return Object.freeze({ ok: false, reason: "spawn-confirmation-stale-or-mismatched" });
  }
  return Object.freeze({ ok: true, credential: confirmed });
}
