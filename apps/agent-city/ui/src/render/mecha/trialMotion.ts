/** Trial-only movement cadence: match the existing 60 fps easing at any frame rate. */
import type { MechaAction } from "./animation";

/** Keep a one-shot pose anchored until its current reaction finishes. */
export function trialMovementAllowed(action: MechaAction): boolean {
  return action === "idle" || action === "move";
}

export function trialMoveAlpha(deltaSeconds: number): number {
  const dt = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(deltaSeconds, 0.1)) : 0;
  return 1 - Math.pow(1 - 0.22, dt * 60);
}
