export type RemoteStatus = "idle" | "starting" | "active" | "stopping" | "unknown";
export type ReleaseChoice = "" | "classic" | "sequential" | "status";
import { isStatusSpecies, type StatusMonsterId } from "./monsters/catalog";

export type StatusSpecies = StatusMonsterId;

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
  encounterActive?: boolean;
};

export type MechaMode =
  | { kind: "picker" }
  | { kind: "classic"; reason: string }
  | { kind: "sequential"; reason: string }
  | { kind: "status"; reason: string; species: StatusSpecies | null }
  | { kind: "closed"; reason: "invalid_build_flags" | "invalid_release_choice" | "invalid_status_species" | "status_challenge_encounter" | "unsupported_build" };

const RELEASE_CHOICES: readonly ReleaseChoice[] = ["", "classic", "sequential", "status"];
const validStatusSpecies = (value: string): value is StatusSpecies => isStatusSpecies(value);

/** Resolves product, development and remote routing without reading browser or build globals. */
export function resolveMechaMode(input: MechaModeInput): MechaMode {
  if (input.dev && input.prod) return { kind: "closed", reason: "invalid_build_flags" };
  if (!RELEASE_CHOICES.includes(input.releaseChoice)) return { kind: "closed", reason: "invalid_release_choice" };

  // The remote transport is v1.4-only; its state always owns the classic route.
  if (input.remoteStatus !== "idle") return { kind: "classic", reason: "remote_requires_v14" };

  if (input.prod) {
    if (input.releaseChoice === "") return { kind: "picker" };
    if (input.releaseChoice === "classic") return { kind: "classic", reason: "release_classic" };
    if (input.releaseChoice === "sequential") return { kind: "sequential", reason: "release_sequential" };
    const species = input.releaseStatus ?? null;
    if (species !== null && !validStatusSpecies(species)) return { kind: "closed", reason: "invalid_status_species" };
    return { kind: "status", reason: species ? "release_status_challenge" : "release_status_picker", species };
  }

  const probeAllowed = input.debug && (input.nativeProbe || input.localTest || input.debugFixture);
  const v15TestAllowed = input.dev || probeAllowed;
  if (!v15TestAllowed) return { kind: "closed", reason: "unsupported_build" };

  const mechaV15Query = input.query.get("mechaV15");
  const requested = input.nativeProbe || input.localTest || mechaV15Query === "1" || (input.dev && mechaV15Query === null);
  if (!requested) return { kind: "classic", reason: mechaV15Query === "0" ? "development_classic_override" : "development_default" };

  const statusRequest = input.query.get("mechaStatus");
  if (statusRequest === null) return { kind: "sequential", reason: input.nativeProbe ? "native_probe" : input.localTest ? "local_test" : "development_query" };
  if (!validStatusSpecies(statusRequest)) return { kind: "closed", reason: "invalid_status_species" };
  if (input.encounterActive) return { kind: "closed", reason: "status_challenge_encounter" };
  return { kind: "status", reason: "development_status_query", species: statusRequest };
}
