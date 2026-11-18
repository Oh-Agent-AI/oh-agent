import type {
  CityInteractionDescriptorV1,
  CityTargetRefV1,
  PlayerScopeV1,
} from "../../agent-vitals-city-sdk/src/contracts";
import { canonicalJson } from "../../agent-vitals-city-sdk/src/package";
import {
  createGameAccessV1,
  evaluateGameInvocation,
  type GameAccessV1,
  type HostGrantV1,
} from "../../city-game-sdk/src/protocol/access";
import type { InstalledGameV1 } from "../../city-game-sdk/src/protocol/installedGame";
import type { CodeGameManifestV2 } from "../../city-game-sdk/src/protocol/manifestV2";
import { GameRuntimeError } from "./errors";

export type GameLaunchRequestV1 = Readonly<{
  launchId: string;
  cityId: string;
  cityRevision: number;
  worldRevision: string;
  snapshotDigest: string;
  interactionRevision: string;
  target: CityTargetRefV1;
  gameId: string;
  entry: string;
  presentation: "overlay" | "exclusive";
  playerScope: PlayerScopeV1;
}>;

export type GameLaunchResultV1 = Readonly<{
  launchId: string;
  runId: string;
  installationId: string;
  gameId: string;
  entry: string;
  presentation: "overlay" | "exclusive";
}>;

export type GameLaunchAdapterV1 = Readonly<{
  launch(request: GameLaunchRequestV1, grant: HostGrantV1<PlayerScopeV1>): Promise<GameLaunchResultV1>;
}>;

export type InteractionRouterOptionsV1 = Readonly<{
  declarative: GameLaunchAdapterV1;
  "legacy-runtime": GameLaunchAdapterV1;
  code: GameLaunchAdapterV1;
  revisions?: () => { worldRevision: string; interactionRevision: string };
}>;

export class InstalledGameRegistryV1 {
  private readonly installations = new Map<string, InstalledGameV1>();

  register(input: InstalledGameV1): InstalledGameV1 {
    validateInstallation(input);
    const existing = this.installations.get(input.installationId);
    if (existing && existing.contentDigest !== input.contentDigest) {
      throw new GameRuntimeError("game_package_integrity_failed", "The installation id is already bound to different content.");
    }
    if (existing && canonicalJson(existing) !== canonicalJson(input)) {
      throw new GameRuntimeError("game_launch_conflict", "The installation record changed after registration.");
    }
    this.installations.set(input.installationId, input);
    return input;
  }

  get(installationId: string): InstalledGameV1 {
    const value = this.installations.get(installationId);
    if (!value) throw new GameRuntimeError("game_installation_not_found", `Installation ${installationId} is not registered.`);
    return value;
  }

  findGame(gameId: string, gameVersion?: string): InstalledGameV1 {
    const candidates = [...this.installations.values()]
      .filter((value) => value.gameId === gameId && (gameVersion === undefined || value.gameVersion === gameVersion))
      .sort((left, right) => right.gameVersion.localeCompare(left.gameVersion));
    const value = candidates[0];
    if (!value) throw new GameRuntimeError("game_installation_not_found", `Game ${gameId} is not installed.`);
    return value;
  }

  list(): readonly InstalledGameV1[] {
    return Object.freeze([...this.installations.values()].sort((left, right) => left.installationId.localeCompare(right.installationId)));
  }
}

export class InteractionRouter {
  constructor(
    private readonly installations: InstalledGameRegistryV1,
    private readonly options: InteractionRouterOptionsV1,
  ) {}

  private readonly launches = new Map<string, Promise<GameLaunchResultV1>>();
  private readonly launchKeys = new Map<string, string>();

  async launch(
    request: GameLaunchRequestV1,
    access: GameAccessV1,
    grant: HostGrantV1<PlayerScopeV1>,
    descriptor?: CityInteractionDescriptorV1,
  ): Promise<GameLaunchResultV1> {
    const fingerprint = canonicalJson(request);
    const existingKey = this.launchKeys.get(request.launchId);
    if (existingKey !== undefined) {
      if (existingKey !== fingerprint) throw new GameRuntimeError("game_launch_conflict", "The launchId is already bound to a different request.");
      return this.launches.get(request.launchId) as Promise<GameLaunchResultV1>;
    }
    const installation = this.installations.findGame(request.gameId);
    if (installation.status !== "installed") throw new GameRuntimeError("game_installation_unavailable", `Game ${request.gameId} is ${installation.status}.`);
    const entry = installation.entries.find((candidate) => candidate.id === request.entry);
    if (!entry) throw new GameRuntimeError("game_entry_invalid", `Game ${request.gameId} has no registered entry ${request.entry}.`);
    if (!entry.presentations.includes(request.presentation)) {
      throw new GameRuntimeError("game_presentation_unsupported", `Entry ${request.entry} does not support ${request.presentation}.`);
    }
    if (descriptor) validateDescriptor(descriptor, request);
    if (this.options.revisions) {
      const current = this.options.revisions();
      if (current.worldRevision !== request.worldRevision || current.interactionRevision !== request.interactionRevision) {
        throw new GameRuntimeError("game_world_revision_conflict", "The City or interaction revision changed before launch.");
      }
    }
    const decision = evaluateGameInvocation("world.read", {
      runId: request.launchId,
      playerScope: request.playerScope,
    }, access, grant);
    if (!decision.ok) throw new GameRuntimeError("game_permission_denied", `Launch permission denied: ${decision.reason}.`);
    const adapter = this.options[installation.kind];
    const result = adapter.launch(request, grant);
    this.launchKeys.set(request.launchId, fingerprint);
    this.launches.set(request.launchId, result);
    result.catch(() => {
      this.launchKeys.delete(request.launchId);
      this.launches.delete(request.launchId);
    });
    return result;
  }
}

function validateInstallation(input: InstalledGameV1): void {
  if (!input.installationId || !input.gameId || !input.gameVersion || !input.contentDigest) {
    throw new GameRuntimeError("game_installation_invalid", "Installation identity and content digest are required.");
  }
  if (input.entries.length === 0) throw new GameRuntimeError("game_installation_invalid", "An installed game must expose at least one entry.");
  const ids = new Set<string>();
  for (const entry of input.entries) {
    if (!entry.id || ids.has(entry.id) || entry.presentations.length === 0) {
      throw new GameRuntimeError("game_installation_invalid", "Installed game entries must have unique ids and a presentation.");
    }
    ids.add(entry.id);
  }
}

function validateDescriptor(descriptor: CityInteractionDescriptorV1, request: GameLaunchRequestV1): void {
  if (descriptor.action.type !== "game.launch") throw new GameRuntimeError("game_runtime_invalid", "Only game.launch can start an installed game.");
  if (descriptor.target.kind !== request.target.kind || descriptor.target.id !== request.target.id) {
    throw new GameRuntimeError("game_launch_conflict", "The interaction target does not match the launch request.");
  }
  const action = descriptor.action;
  if (action.gameId !== request.gameId || (action.entry ?? "default") !== request.entry || action.presentation !== request.presentation) {
    throw new GameRuntimeError("game_launch_conflict", "The interaction action does not match the launch request.");
  }
}

export function createAccessForManifest(
  manifest: CodeGameManifestV2,
  availableCapabilities: GameAccessV1["availableCapabilities"],
  grant: HostGrantV1<PlayerScopeV1>,
): GameAccessV1 {
  return createGameAccessV1(manifest, availableCapabilities, grant);
}
