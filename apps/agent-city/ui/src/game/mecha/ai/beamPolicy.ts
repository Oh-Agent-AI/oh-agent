import { MECH_IDS, manh, mech, moveBudget, occupant, pathDistance, type Cell, type MatchState, type MechId } from "../board";
import { legalActions } from "../combat";
import { statusBlocks } from "../statusEffects";
import type { SequentialTurn } from "../sequentialTurn";
import { nextCommand, stateValue, type CommandIntent } from "./commandPolicy";

export type BeamOptions = { beamWidth?: number; maxDepth?: number; moveCandidates?: number };

type Candidate = CommandIntent;

function blocked(state: MatchState, id: MechId): { move: boolean; action: boolean } {
  return state.statusEncounter ? statusBlocks(state.statusEncounter.statuses, id) ?? { move: false, action: false } : { move: false, action: false };
}

function nearestEnemy(state: MatchState, from: Cell): number {
  const cells: Cell[] = [];
  if (state.boss.hp > 0) cells.push(state.boss.anchor);
  for (const raider of state.raiders) if (raider.hp > 0) cells.push(raider.pos);
  return cells.length ? Math.min(...cells.map(cell => manh(from, cell))) : 0;
}

/** Positional tie-breaker: closer to the nearest enemy is better, all else equal. */
function positional(state: MatchState): number {
  let total = 0;
  for (const id of MECH_IDS) {
    const unit = mech(state, id);
    if (unit && unit.hp > 0) total += nearestEnemy(state, unit.pos);
  }
  return -total * 0.25;
}

function heuristic(state: MatchState): number { return stateValue(state) + positional(state); }

function candidates(state: MatchState, moveCandidates: number): Candidate[] {
  const out: Candidate[] = [];
  for (const id of MECH_IDS) {
    const unit = mech(state, id);
    if (!unit || unit.hp <= 0) continue;
    const limit = blocked(state, id);
    if (!limit.action) {
      for (const action of legalActions(state, id)) {
        if (action.kind === "skip") continue;
        out.push({ kind: "act", mech: id, action });
      }
    }
    if (!limit.move) {
      const moves: Array<{ to: Cell; gain: number }> = [];
      const before = nearestEnemy(state, unit.pos);
      for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
        const to = { x, y };
        if (to.x === unit.pos.x && to.y === unit.pos.y) continue;
        if (occupant(state, to) !== "empty") continue;
        const distance = pathDistance(state, unit.pos, to, id, { alliesPass: true });
        if (distance === null || distance > moveBudget(id)) continue;
        moves.push({ to, gain: before - nearestEnemy(state, to) });
      }
      moves.sort((a, b) => b.gain - a.gain || a.to.y - b.to.y || a.to.x - b.to.x);
      for (const move of moves.slice(0, moveCandidates)) out.push({ kind: "move", mech: id, to: move.to });
    }
  }
  return out;
}

function execute(turn: SequentialTurn, intent: Candidate, serial: number) {
  const revision = turn.snapshot().match.revision;
  const command = intent.kind === "end" ? { kind: "end" as const, confirmUnused: true, id: `beam-${serial}`, revision } : { ...intent, id: `beam-${serial}`, revision };
  return turn.execute(command);
}

function lookahead(turn: SequentialTurn): number {
  const state = turn.snapshot().match;
  if (state.outcome) return heuristic(state);
  const leaf = turn.branch();
  const revision = leaf.snapshot().match.revision;
  const ended = leaf.execute({ kind: "end", id: "beam-end", revision, confirmUnused: true });
  return ended.ok ? heuristic(ended.snapshot.match) : -Infinity;
}

/** Beam search over real commands, including moves; leaves resolve one enemy phase. */
export function nextBeamCommand(authority: SequentialTurn, options: BeamOptions = {}): CommandIntent {
  const beamWidth = Math.max(1, Math.min(8, options.beamWidth ?? 4));
  const maxDepth = Math.max(1, Math.min(8, options.maxDepth ?? 4));
  const moveCandidates = Math.max(0, Math.min(6, options.moveCandidates ?? 3));
  const root = authority.snapshot();
  if (root.match.outcome || root.match.phase !== "player_plan") return { kind: "end" };
  const baseline = heuristic(root.match);
  let beam: Array<{ turn: SequentialTurn; intents: Candidate[]; score: number }> = [{ turn: authority.branch(), intents: [], score: baseline }];
  let best: { intents: Candidate[]; score: number } | null = null;
  let serial = 0;
  for (let depth = 0; depth < maxDepth; depth++) {
    const expanded: Array<{ turn: SequentialTurn; intents: Candidate[]; score: number }> = [];
    for (const node of beam) {
      if (node.turn.snapshot().match.outcome) continue;
      for (const intent of candidates(node.turn.snapshot().match, moveCandidates)) {
        const turn = node.turn.branch();
        if (!execute(turn, intent, ++serial).ok) continue;
        expanded.push({ turn, intents: [...node.intents, intent], score: heuristic(turn.snapshot().match) });
      }
    }
    if (expanded.length === 0) break;
    expanded.sort((a, b) => b.score - a.score || a.intents.length - b.intents.length);
    beam = expanded.slice(0, beamWidth);
    for (const node of beam) {
      const score = lookahead(node.turn);
      if (score > baseline && (!best || score > best.score)) best = { intents: node.intents, score };
    }
  }
  const chosen = best as { intents: Candidate[]; score: number } | null;
  return chosen ? chosen.intents[0]! : nextCommand(authority);
}
