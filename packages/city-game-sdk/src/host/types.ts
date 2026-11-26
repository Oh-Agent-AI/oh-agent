import type {
  CitySnapshotV1,
  EntitySnapshotV1,
  GameOutcomeV1,
  RouteV1,
  TerrainSampleV1,
  WorldAnchorV1,
  WorldBoundsV1,
  WorldObjectV1,
} from "../api/types";
import type { EntityIdV1 } from "../protocol/ids";
import type { CodeGameManifestV1 } from "../protocol/manifest";

/**
 * The host side of the boundary. `WorldSourceV1` is implemented by the City
 * adapter (or a headless fixture) and is never handed to game code — games see
 * only the permission-checked `WorldAPIV1` facade.
 */
export type WorldSourceV1 = Readonly<{
  city(): CitySnapshotV1;
  listRoutes(): readonly RouteV1[];
  getRoute(routeId: string): RouteV1 | null;
  sampleTerrain(x: number, z: number): TerrainSampleV1 | null;
  listAnchors(): readonly WorldAnchorV1[];
  queryObjects(bounds: WorldBoundsV1): readonly WorldObjectV1[];
}>;

/**
 * Visual ownership is a port, not a Three.js dependency: the City adapter
 * creates/updates/removes meshes, the SDK only reports entity lifecycle.
 * Every run-owned entity gets exactly one `destroy`, including on failure.
 */
export type RenderPortV1 = Readonly<{
  spawn(entity: EntitySnapshotV1): void;
  update(entity: EntitySnapshotV1): void;
  destroy(entityId: EntityIdV1): void;
}>;

export type CodeGameHostStatusV1 =
  | "created"
  | "preparing"
  | "ready"
  | "running"
  | "paused"
  | "finished"
  | "failed"
  | "disposed";

export type CodeGameHostOptionsV1 = Readonly<{
  manifest: CodeGameManifestV1;
  world: WorldSourceV1;
  seed: number;
  runId?: string;
  fixedDtSeconds?: number;
  /** Diagnostics clock only. Defaults to 0 so headless runs are deterministic
   * even if someone forgets to inject one. */
  nowMs?: () => number;
  render?: RenderPortV1;
  hudByteLimit?: number;
}>;

export type GameTelemetryV1 = Readonly<{
  runId: string;
  status: CodeGameHostStatusV1;
  disposed: boolean;
  tick: number;
  outcome: GameOutcomeV1 | null;
  reason: string | null;
  entities: number;
  hud: Readonly<Record<string, unknown>> | null;
  counters: Readonly<{
    spawns: number;
    destroys: number;
    fixedUpdates: number;
    hudUpdates: number;
    audioPlays: number;
    events: number;
    errors: number;
  }>;
  diagnostics: number;
}>;
