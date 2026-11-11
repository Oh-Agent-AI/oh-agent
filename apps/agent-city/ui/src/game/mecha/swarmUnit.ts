import { prepareSwarmIntent, resolveSwarmIntent, projectSwarm, visibleSwarmProjection, type MatchState, type Intent } from "./board";

/** Swarm declaration runs after raider planning, preserving its binding order. */
export const swarmUnit = {
  declare(state: MatchState): Intent { return prepareSwarmIntent(state); },
  project(state: MatchState, intent: Intent): void {
    if (intent.status === "void") return;
    intent.swarmProjection = visibleSwarmProjection(projectSwarm(state, intent));
    intent.projected = intent.swarmProjection.status === "reprojected" && intent.swarmProjection.skillId === "split_swarm"
      ? intent.swarmProjection.slots.filter(s => !!s.unit).map(s => ({ ...s.cell })) : [];
    intent.status = intent.swarmProjection.status;
  },
  resolve(state: MatchState, intent: Intent): void { if (intent.status !== "void") resolveSwarmIntent(state, intent); },
} as const;
