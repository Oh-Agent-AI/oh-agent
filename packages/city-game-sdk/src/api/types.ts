import type { EntityIdV1 } from "../protocol/ids";

export type UnsubscribeV1 = () => void;
export type Vec3V1 = readonly [number, number, number];
export type GameOutcomeV1 = "success" | "failure";

/** Read-only identity of the City a run is bound to. A game never selects a
 * different City: the host freezes this at prepare() time. */
export type CitySnapshotV1 = Readonly<{
  cityId: string;
  seed: number;
  worldRevision: string;
  layoutId: string | null;
}>;

export type RouteV1 = Readonly<{
  id: string;
  /** Ordered centerline points in world metres, y-up, matching City units. */
  points: readonly Vec3V1[];
}>;

export type TerrainSampleV1 = Readonly<{
  height: number;
  normal: Vec3V1;
  walkable: boolean;
}>;

export type WorldAnchorV1 = Readonly<{
  id: string;
  kind: "spawn" | "route" | "zone" | "object";
  position: Vec3V1;
  radiusMeters?: number;
}>;

/** Closed box in world metres. Queries are bounded by construction so a game
 * cannot ask the host to scan the whole City every frame. */
export type WorldBoundsV1 = Readonly<{ min: Vec3V1; max: Vec3V1 }>;

export type WorldObjectV1 = Readonly<{
  id: string;
  kind: string;
  position: Vec3V1;
  bounds: WorldBoundsV1;
}>;

export interface WorldAPIV1 {
  city(): CitySnapshotV1;
  listRoutes(): readonly RouteV1[];
  /** Throws `game_world_object_missing` when the route is unknown — a missing
   * route is a game bug, not an empty world. */
  getRoute(routeId: string): RouteV1;
  sampleTerrain(x: number, z: number): TerrainSampleV1;
  listAnchors(): readonly WorldAnchorV1[];
  queryObjects(bounds: WorldBoundsV1): readonly WorldObjectV1[];
}

export type EntityTransformV1 = Readonly<{
  position: Vec3V1;
  rotation?: Vec3V1;
  scale?: Vec3V1;
}>;

export type EntitySnapshotV1 = Readonly<{
  id: EntityIdV1;
  prefabId: string;
  transform: EntityTransformV1;
  props: Readonly<Record<string, unknown>>;
}>;

export type EntityPatchV1 = Readonly<{
  position?: Vec3V1;
  rotation?: Vec3V1;
  scale?: Vec3V1;
  props?: Readonly<Record<string, unknown>>;
}>;

export interface EntityAPIV1 {
  /** Creates a run-owned temporary entity. The prefab must be declared in the
   * manifest as a `model/glb` asset; budgets are enforced by the host. */
  spawn(
    prefabId: string,
    transform: EntityTransformV1,
    props?: Readonly<Record<string, unknown>>,
  ): EntityIdV1;
  update(entityId: EntityIdV1, patch: EntityPatchV1): EntitySnapshotV1;
  get(entityId: EntityIdV1): EntitySnapshotV1;
  query(filter?: Readonly<{ prefabId?: string }>): readonly EntitySnapshotV1[];
  /** Idempotent. Returns false for an unknown or already-destroyed id so a
   * cleanup loop can run twice without inventing a second failure mode. */
  destroy(entityId: EntityIdV1): boolean;
}

export type GameEventMapV1 = Readonly<{
  "entity.clicked": Readonly<{ entityId: EntityIdV1 }>;
  "zone.entered": Readonly<{ zoneId: string; entityId: EntityIdV1 }>;
  "ui.action": Readonly<{ action: string; value?: number | string | boolean }>;
}>;

export type GameEventTypeV1 = keyof GameEventMapV1;

export interface EventAPIV1 {
  on<K extends GameEventTypeV1>(type: K, handler: (payload: GameEventMapV1[K]) => void): UnsubscribeV1;
}

export interface InputAPIV1 {
  /** Latest normalized input. Run-scoped: the host clears it on dispose and
   * never lets a game read another lease's keys. */
  actions(): Readonly<Record<string, number | boolean>>;
}

export interface UiAPIV1 {
  /** Host-rendered HUD state. P0 deliberately does not allow DOM access; the
   * host diffs and throttles this snapshot before rendering. */
  setHud(snapshot: Readonly<Record<string, unknown>>): void;
}

export interface AudioAPIV1 {
  play(assetId: string, options?: Readonly<{ volume?: number; loop?: boolean }>): void;
  stop(assetId: string): void;
}

export interface ClockAPIV1 {
  /** The single authoritative fixed step. Presentation may interpolate; gameplay
   * decisions must not use frame time. */
  readonly fixedDtSeconds: number;
  /** Diagnostics only. Never use this for win/lose decisions. */
  nowMs(): number;
}

export interface RandomAPIV1 {
  next(): number;
  int(minInclusive: number, maxExclusive: number): number;
}

/**
 * The only object a game receives. Every member is host-implemented and
 * permission-checked; there is deliberately no `scene`, `engine`, `invoke` or
 * DOM surface here, and the boundary test pins that.
 */
export interface GameContextV1 {
  readonly world: WorldAPIV1;
  readonly entities: EntityAPIV1;
  readonly events: EventAPIV1;
  readonly input: InputAPIV1;
  readonly ui: UiAPIV1;
  readonly audio: AudioAPIV1;
  readonly clock: ClockAPIV1;
  readonly random: RandomAPIV1;
  onFixedUpdate(fn: (dtSeconds: number) => void): UnsubscribeV1;
  onDispose(fn: () => void): UnsubscribeV1;
  finish(outcome: GameOutcomeV1, reason?: string): void;
}
