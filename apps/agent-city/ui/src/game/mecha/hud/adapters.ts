import type { MatchState, MechId } from "../board";
import type { SequentialControllerView } from "../sequentialController";
import type { ClassicHudSource, MechaHudModel, MechaHudPhase, MechaHudProjection } from "./model";

const hudPhase = (match: MatchState, deployment: boolean): MechaHudPhase => {
  if (match.outcome || match.phase === "finished") return "finished";
  if (deployment || match.phase === "deployment") return "deployment";
  if (match.phase === "player_plan") return "planning";
  return "resolving";
};

function project(mode: MechaHudModel["mode"], match: MatchState, selected: MechId, deployment: boolean, projection: MechaHudProjection): MechaHudModel {
  const displayMatch = projection.displayMatch ?? match;
  const displayedSelection = projection.selected ?? selected;
  const displayedDeployment = projection.deployment ?? deployment;
  const rosterFacts = new Map(projection.roster.map(row => [row.id, row]));
  return {
    mode,
    label: projection.label,
    phase: hudPhase(displayMatch, displayedDeployment),
    sourcePhase: projection.sourcePhase ?? displayMatch.phase,
    round: projection.round ?? displayMatch.turn,
    objective: projection.objective,
    threats: projection.threats,
    roster: displayMatch.mechs.map(mech => {
      const facts = rosterFacts.get(mech.id);
      return {
        id: mech.id,
        hp: mech.hp,
        maxHp: facts?.maxHp ?? null,
        selected: mech.id === displayedSelection,
        statuses: facts?.statuses ?? [],
        rights: facts?.rights ?? { move: false, action: false },
      };
    }),
    selected: { id: displayedSelection, actions: projection.actions, targets: projection.targets, preview: projection.preview },
    replay: projection.replay,
    notices: projection.notices,
  };
}

/** Converts the classic controller snapshot plus its already-computed view facts into the HUD contract. */
export function buildClassicHud(state: ClassicHudSource, projection: MechaHudProjection): MechaHudModel {
  return project("classic", state.match, state.selected, Boolean(state.deployment), projection);
}

/** Converts the sequential controller snapshot plus its already-computed view facts into the HUD contract. */
export function buildSequentialHud(state: SequentialControllerView, projection: MechaHudProjection): MechaHudModel {
  return project("sequential", state.match, state.selected, Boolean(state.placements), projection);
}
