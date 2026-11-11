import type { DeployPlacement } from "./deployment";
import type { MatchState } from "./board";
import type { SequentialCommand, SequentialRecord } from "./sequentialTurn";
import type { CityMechaSite } from "./citySite";
import { remoteStateFromSite } from "./contracts/arena";

export type SequentialOpening = Readonly<{
  initial: MatchState;
  placements: DeployPlacement[];
  commands: SequentialCommand[];
}>;

/**
 * Handoff carries the opening plus accepted commands only. The receiver rebuilds
 * through SequentialTurn, so a stale revision or altered command cannot be hidden
 * inside a copied snapshot.
 */
export function buildSequentialOpening(evidence: { initial: MatchState; placements: DeployPlacement[]; records: readonly SequentialRecord[] }, site?: CityMechaSite): SequentialOpening {
  const initial = site ? remoteStateFromSite(site, evidence.initial) : structuredClone(evidence.initial);
  const targetIds = new Map<string, string>();
  if (site) {
    site.buildings.forEach((building, index) => targetIds.set(building.id, initial.buildings[index]?.id ?? `other-building-${String(index).padStart(4, "0")}`));
    evidence.initial.raiders.forEach((raider, index) => targetIds.set(raider.id, `raider-${String(index).padStart(4, "0")}`));
  }
  const commands = evidence.records.map(record => {
    const command = structuredClone(record.command);
    if (site && command.kind === "act" && command.action.kind !== "skip" && command.action.target) {
      const target = command.action.target;
      if (target !== "boss" && target !== "Assault" && target !== "Gunner" && target !== "Support") {
        const mapped = targetIds.get(target);
        if (!mapped) throw new Error("remote_match_unsupported");
        command.action.target = mapped;
      }
    }
    return command;
  });
  return {
    initial,
    placements: structuredClone(evidence.placements),
    commands,
  };
}
