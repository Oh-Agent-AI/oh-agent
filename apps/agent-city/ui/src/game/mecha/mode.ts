import { isPracticeSpecies, isStatusSpecies, practiceSpecies } from "./monsters/catalog";
import type { PlannedMonsterSpeciesId } from "./monsters/contracts";

export type RemoteStatus = "idle" | "starting" | "active" | "stopping" | "unknown";
export type ReleaseChoice = "" | "sequential" | "status" | "practice";

export type StatusSpecies = import("./monsters/catalog").StatusMonsterId;

export type MechaModeInput = {
  dev: boolean;
  prod: boolean;
  debug: boolean;
  query: URLSearchParams;
  remoteStatus: RemoteStatus;
  nativeProbe: boolean;
  localTest: boolean;
  debugFixture: boolean;
  releaseChoice: ReleaseChoice;
  releaseStatus?: StatusSpecies | null;
  releaseMonster?: PlannedMonsterSpeciesId | null;
  encounterActive?: boolean;
};

export type MechaMode =
  | { kind: "picker" }
  | { kind: "sequential"; reason: string }
  | { kind: "status"; reason: string; species: StatusSpecies | null }
  | { kind: "practice"; reason: string; species: PlannedMonsterSpeciesId | null }
  | { kind: "closed"; reason: "invalid_build_flags" | "invalid_release_choice" | "invalid_status_species" | "invalid_practice_species" | "status_challenge_encounter" | "classic_retired" | "unsupported_build" };

const RELEASE_CHOICES: readonly ReleaseChoice[] = ["", "sequential", "status", "practice"];
const validStatusSpecies = (value: string): value is StatusSpecies => isStatusSpecies(value);
const validPracticeSpecies = (value: string): value is PlannedMonsterSpeciesId => isPracticeSpecies(value);

/** Resolves product, development and remote routing without reading browser or build globals. */
export function resolveMechaMode(input: MechaModeInput): MechaMode {
  if (input.dev && input.prod) return { kind: "closed", reason: "invalid_build_flags" };
  if (!RELEASE_CHOICES.includes(input.releaseChoice)) return { kind: "closed", reason: "invalid_release_choice" };

  if (input.prod) {
    if (input.releaseChoice === "") return { kind: "picker" };
    if (input.releaseChoice === "sequential") return { kind: "sequential", reason: "release_sequential" };
    if (input.releaseChoice === "practice") {
      const species = input.releaseMonster ?? null;
      if (species !== null && !validPracticeSpecies(species)) return { kind: "closed", reason: "invalid_practice_species" };
      return { kind: "practice", reason: species ? "release_practice" : "release_practice_picker", species };
    }
    const species = input.releaseStatus ?? null;
    if (species !== null && !validStatusSpecies(species)) return { kind: "closed", reason: "invalid_status_species" };
    return { kind: "status", reason: species ? "release_status_challenge" : "release_status_picker", species };
  }

  const probeAllowed = input.debug && (input.nativeProbe || input.localTest || input.debugFixture);
  const v15TestAllowed = input.dev || probeAllowed;
  if (!v15TestAllowed) return { kind: "closed", reason: "unsupported_build" };

  const mechaV15Query = input.query.get("mechaV15");
  const requested = input.nativeProbe || input.localTest || mechaV15Query === "1" || (input.dev && mechaV15Query === null);
  if (!requested) return { kind: "closed", reason: "classic_retired" };

  const practiceRequest = input.query.get("mechaMonster");
  if (practiceRequest !== null) {
    if (!validPracticeSpecies(practiceRequest)) return { kind: "closed", reason: "invalid_practice_species" };
    return { kind: "practice", reason: "development_practice_query", species: practiceRequest };
  }

  const statusRequest = input.query.get("mechaStatus");
  if (statusRequest === null) return { kind: "sequential", reason: input.nativeProbe ? "native_probe" : input.localTest ? "local_test" : "development_query" };
  if (!validStatusSpecies(statusRequest)) return { kind: "closed", reason: "invalid_status_species" };
  if (input.encounterActive) return { kind: "closed", reason: "status_challenge_encounter" };
  return { kind: "status", reason: "development_status_query", species: statusRequest };
}

export { practiceSpecies };
