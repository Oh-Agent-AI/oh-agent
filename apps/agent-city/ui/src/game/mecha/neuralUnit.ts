import { prepareNeuralIntent, resolveNeuralIntent, projectNeural, type MatchState, type Intent } from "./board";
/** Neural declaration follows raider planning to preserve its target binding. */
export const neuralUnit = {
  declare(state: MatchState): Intent { return prepareNeuralIntent(state); },
  project(state: MatchState, intent: Intent): void {
    if (!state.neural?.pending) return;
    const projection = projectNeural(state, intent);
    intent.swarmProjection = projection;
    intent.projected = [];
    intent.status = projection.status;
  },
  resolve(state: MatchState, intent: Intent): void { resolveNeuralIntent(state, intent); },
} as const;
