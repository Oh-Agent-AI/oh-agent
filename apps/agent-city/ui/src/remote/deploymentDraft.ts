import { deploymentCellFault, type DeployFault, type DeployPlacement } from "../game/mecha/deployment";
import { type Cell, type MatchState, type MechId } from "../game/mecha/rules";

export type RemoteDeploymentDraft = { placements: DeployPlacement[]; history: DeployPlacement[][] };
export const emptyDeploymentDraft = (): RemoteDeploymentDraft => ({ placements: [], history: [] });
const same = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y;

/** Only local preview state changes here; authority still validates the complete packet. */
export function placeRemoteDeployment(state: MatchState, draft: RemoteDeploymentDraft, mechId: MechId, cell: Cell):
  { draft: RemoteDeploymentDraft; fault: DeployFault | null } {
  const fault = deploymentCellFault(state, cell);
  if (fault) return { draft, fault };
  const current = draft.placements.find(p => p.mechId === mechId);
  const occupant = draft.placements.find(p => p.mechId !== mechId && same(p.pos, cell));
  if (current && same(current.pos, cell)) return { draft, fault: null };
  if (occupant && !current) return { draft, fault: { code: "duplicate_cell" } };
  const placements = structuredClone(draft.placements);
  const moved = placements.find(p => p.mechId === mechId);
  const swapped = placements.find(p => p.mechId !== mechId && same(p.pos, cell));
  if (swapped && current) swapped.pos = { ...current.pos };
  if (moved) moved.pos = { ...cell }; else placements.push({ mechId, pos: { ...cell } });
  return { draft: { placements, history: [...draft.history, structuredClone(draft.placements)] }, fault: null };
}

export function undoRemoteDeployment(draft: RemoteDeploymentDraft): RemoteDeploymentDraft {
  return draft.history.length ? { placements: draft.history[draft.history.length - 1]!, history: draft.history.slice(0, -1) } : draft;
}
