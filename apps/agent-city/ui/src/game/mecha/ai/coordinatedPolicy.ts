import { MECH_IDS, mech, type MatchState } from "../board";
import { legalActions } from "../combat";
import { statusBlocks } from "../statusEffects";
import type { SequentialTurn } from "../sequentialTurn";
import { nextCommand, stateValue, type CommandIntent } from "./commandPolicy";

const MAX_PLANS = 256;

function optionsFor(state: MatchState, id: (typeof MECH_IDS)[number]) {
  if (!mech(state, id)) return [];
  if (state.statusEncounter && statusBlocks(state.statusEncounter.statuses, id)?.action) return [];
  return legalActions(state, id).filter((action, index, list) => list.findIndex(other => JSON.stringify(other) === JSON.stringify(action)) === index);
}

/**
 * Coordinated actions with one enemy-phase lookahead. It plans the remaining
 * action-bearing mechs together, resolves the real enemy phase, then returns
 * only the first command so the live controller still owns presentation.
 */
export function nextCoordinatedCommand(authority: SequentialTurn): CommandIntent {
  const snapshot = authority.snapshot(), state = snapshot.match;
  if (state.outcome || state.phase !== "player_plan") return { kind: "end" };
  const actors = MECH_IDS.filter(id => snapshot.rights[id]?.action && optionsFor(state, id).length > 0);
  if (actors.length === 0) return nextCommand(authority);
  const groups = actors.map(id => optionsFor(state, id));
  const baseline = stateValue(state);

  let best: { intents: CommandIntent[]; score: number } | null = null;
  let plans = 0;
  const walk = (index: number, branch: SequentialTurn, intents: CommandIntent[]): void => {
    if (plans >= MAX_PLANS) return;
    if (index === actors.length) {
      plans++;
      if (!branch.snapshot().match.outcome) {
        const revision = branch.snapshot().match.revision;
        const ended = branch.execute({ kind: "end", id: "coord-end", revision, confirmUnused: true });
        if (!ended.ok) return;
        const score = stateValue(ended.snapshot.match);
        if (score > baseline && (!best || score > best.score)) best = { intents, score };
        return;
      }
      const score = stateValue(branch.snapshot().match);
      if (score > baseline && (!best || score > best.score)) best = { intents, score };
      return;
    }
    for (const action of groups[index]!) {
      const next = branch.branch();
      const revision = next.snapshot().match.revision;
      const result = next.execute({ kind: "act", id: `coord-${index}`, revision, mech: actors[index]!, action });
      if (result.ok) walk(index + 1, next, [...intents, { kind: "act", mech: actors[index]!, action }]);
    }
  };
  walk(0, authority.branch(), []);
  const chosen = best as { intents: CommandIntent[]; score: number } | null;
  return chosen ? chosen.intents[0]! : nextCommand(authority);
}
