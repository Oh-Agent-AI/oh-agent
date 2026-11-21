export type StableIdV1 = string;
export type DigestV1 = string;
export type RevisionIdV1 = string;
export type BuildId = string;
export type OperationId = string;
export type Vec2V1 = readonly [number, number];
export type Vec3V1 = readonly [number, number, number];
export type QuatV1 = readonly [number, number, number, number];

export interface Bounds3V1 { readonly min: Vec3V1; readonly max: Vec3V1 }
export interface TransformV1 {
  readonly position: Vec3V1;
  readonly rotation: QuatV1;
  readonly scale: Vec3V1;
}
export interface CityPageV1<T> { readonly items: readonly T[]; readonly nextCursor?: string }
export interface TerrainSampleV1 { readonly height: number; readonly normal: Vec3V1; readonly walkable: boolean }
export type CityTargetRefV1 =
  | { readonly kind: "world-object"; readonly id: StableIdV1 }
  | { readonly kind: "resident"; readonly id: StableIdV1 }
  | { readonly kind: "place"; readonly id: StableIdV1 };
export interface PlayerScopeV1 {
  readonly playerId: string;
  readonly kind: "local-profile" | "remote-guest" | "preview";
}

// StateScopeV1 discriminated union (RFC §3.5.1): every DTO carries `kind`; runtimes
// dispatch authorization per variant and fail closed on unknown variants.
export interface GameStateScopeV1 {
  readonly kind: "game";
  readonly playerId: string;
  readonly cityId: string;
  readonly gameId: string;
  readonly gameRunId?: string;
}
export interface StoryStateScopeV1 {
  readonly kind: "story";
  readonly playerId: string;
  readonly cityId: string;
  readonly storyId: string;
  readonly storyRunId: string;
  readonly residentId?: StableIdV1;
}
export interface CityResidentPublicScopeV1 {
  readonly kind: "city-resident-public";
  readonly cityId: string;
  readonly residentId: StableIdV1;
}
export type StateScopeV1 = GameStateScopeV1 | StoryStateScopeV1 | CityResidentPublicScopeV1;

export const TRAVEL_MODES_V1 = ["walk", "drive", "fly", "swim", "submersible"] as const;
export type TravelModeV1 = typeof TRAVEL_MODES_V1[number];
export const ANCHOR_KINDS_V2 = ["spawn", "route", "zone", "object", "checkpoint"] as const;
export type AnchorKindV2 = typeof ANCHOR_KINDS_V2[number];
export const ROAD_KINDS_V2 = ["road", "tunnel", "walkway", "flight-path"] as const;
export type RoadKindV2 = typeof ROAD_KINDS_V2[number];
export const WORLD_VOLUME_KINDS_V1 = ["water", "airspace", "checkpoint", "hazard", "trigger", "navigation"] as const;
export type WorldVolumeKindV1 = typeof WORLD_VOLUME_KINDS_V1[number];
export const WORLD_CAPABILITIES_V2 = [
  "world.snapshot", "roads.graph", "terrain.heightfield", "environment.parameters",
  "sites.indexed", "objects.indexed", "volumes.indexed", "navigation.surface",
  "navigation.volume", "appearance.profiles", "time.simulation", "residents.registry",
  "places.registry",
] as const;
export type WorldCapabilityV2 = typeof WORLD_CAPABILITIES_V2[number];

export interface SiteDtoV2 {
  readonly id: StableIdV1;
  readonly kind: string;
  readonly bounds: Bounds3V1;
  readonly objectIds: readonly StableIdV1[];
  readonly placeId?: StableIdV1;
}
export interface WorldObjectDtoV2 {
  readonly id: StableIdV1;
  readonly kind: string;
  readonly transform: TransformV1;
  readonly bounds: Bounds3V1;
  readonly siteId?: StableIdV1;
  readonly assetDigest?: DigestV1;
  readonly collision: Readonly<
    | { kind: "none" }
    | { kind: "box" }
    | { kind: "mesh"; assetDigest: DigestV1 }
  >;
}
export interface AnchorDtoV2 {
  readonly id: StableIdV1;
  readonly kind: AnchorKindV2;
  readonly position: Vec3V1;
  readonly radiusMeters?: number;
  readonly objectId?: StableIdV1;
  readonly travelModes: readonly TravelModeV1[];
}
export interface RoadEdgeDtoV2 {
  readonly id: StableIdV1;
  readonly kind: RoadKindV2;
  readonly fromAnchorId: StableIdV1;
  readonly toAnchorId: StableIdV1;
  readonly directed: boolean;
  readonly travelModes: readonly TravelModeV1[];
  readonly centerline: readonly Vec3V1[];
}
export type VolumeGeometryV1 = Readonly<
  | { kind: "box"; bounds: Bounds3V1 }
  | { kind: "sphere"; center: Vec3V1; radiusMeters: number }
  | { kind: "convex-prism"; polygonXZ: readonly Vec2V1[]; minY: number; maxY: number }
  | { kind: "ring"; center: Vec3V1; normal: Vec3V1; innerRadiusMeters: number; outerRadiusMeters: number; thicknessMeters: number }
>;
export interface WorldVolumeDtoV1 {
  readonly id: StableIdV1;
  readonly kind: WorldVolumeKindV1;
  readonly geometry: VolumeGeometryV1;
  readonly travelModes?: readonly TravelModeV1[];
  readonly objectId?: StableIdV1;
}
export interface CityPlaceV1 {
  readonly id: StableIdV1;
  readonly kind: string;
  readonly displayName: string;
  readonly objectRef: StableIdV1;
  readonly activities: readonly string[];
}
export type CityResidentScheduleV1 = Readonly<{
  daysOfWeek: readonly (0 | 1 | 2 | 3 | 4 | 5 | 6)[];
  startLocalTime: string;
  endLocalTime: string;
  placeId: StableIdV1;
}>;
export interface CityResidentV1 {
  readonly id: StableIdV1;
  readonly displayName: string;
  readonly prefabRef: string;
  readonly homePlaceId?: StableIdV1;
  readonly schedule?: readonly CityResidentScheduleV1[];
  readonly interactions: readonly string[];
}

export interface CityResolvedGeneratorIdentityV1 {
  readonly id: string;
  readonly contractVersion: 1;
  readonly version: string;
  readonly codeDigest: DigestV1;
}
export interface CompileContextV1 {
  readonly cityId: string;
  readonly cityRevision: number;
  readonly seed: number;
  readonly generator: CityResolvedGeneratorIdentityV1;
  readonly assetsDigest: DigestV1;
  readonly capabilities: readonly WorldCapabilityV2[];
}
export interface RoutePlanV1 {
  readonly id: StableIdV1;
  readonly kind: RoadEdgeDtoV2["kind"];
  readonly fromAnchorId: StableIdV1;
  readonly toAnchorId: StableIdV1;
  readonly bidirectional: boolean;
  readonly travelModes: RoadEdgeDtoV2["travelModes"];
  readonly centerline: readonly Vec3V1[];
}
export interface CityTerrainV1 {
  readonly format: "heightfield-tiles-v1";
  readonly tiles: readonly Readonly<{
    id: StableIdV1;
    assetDigest: DigestV1;
    bounds: Bounds3V1;
  }>[];
}
export interface WorldPlanV1 {
  readonly schemaVersion: 1;
  readonly terrain: CityTerrainV1;
  readonly environment?: CitySemanticEnvironmentV1;
  readonly sites: readonly SiteDtoV2[];
  readonly routes: readonly RoutePlanV1[];
  readonly objects: readonly WorldObjectDtoV2[];
  readonly anchors: readonly AnchorDtoV2[];
  readonly volumes: readonly WorldVolumeDtoV1[];
  readonly places: readonly CityPlaceV1[];
  readonly residents: readonly CityResidentV1[];
}
export interface WorldCompilerV1 {
  compile(plan: WorldPlanV1, context: CompileContextV1): CityWorldSnapshotV4;
}

export interface CityRevisionSetV1 {
  readonly worldRevision: RevisionIdV1;
  readonly environmentRevision: RevisionIdV1;
  readonly weatherRevision: RevisionIdV1;
  readonly placeRevision: RevisionIdV1;
  readonly residentRevision: RevisionIdV1;
  readonly interactionRevision: RevisionIdV1;
  readonly appearanceRevision: RevisionIdV1;
  readonly renderRevision: RevisionIdV1;
  readonly clockRevision: RevisionIdV1;
}
export interface CityWorldHeaderV1 {
  readonly schemaVersion: 1;
  readonly cityId: string;
  readonly cityRevision: number;
  readonly seed: number;
  readonly generator: CityResolvedGeneratorIdentityV1;
  readonly coordinateSystem: "city-local-m-v1";
  readonly capabilities: readonly WorldCapabilityV2[];
  readonly revisions: CityRevisionSetV1;
  readonly topologyDigest: DigestV1;
  readonly snapshotDigest: DigestV1;
}
export type CitySemanticEnvironmentV1 = Readonly<{
  medium: "air" | "water" | "vacuum" | "mixed";
  biome: string;
}>;
export interface CityWorldSnapshotV4 {
  readonly schemaVersion: 4;
  readonly header: CityWorldHeaderV1;
  readonly terrain: CityTerrainV1;
  readonly environment: CitySemanticEnvironmentV1;
  readonly roads: readonly RoadEdgeDtoV2[];
  readonly sites: readonly SiteDtoV2[];
  readonly objects: readonly WorldObjectDtoV2[];
  readonly anchors: readonly AnchorDtoV2[];
  readonly volumes: readonly WorldVolumeDtoV1[];
  readonly places: readonly CityPlaceV1[];
  readonly residents: readonly CityResidentV1[];
}

export interface BoundedAssetReaderV1 {
  readonly digest: DigestV1;
  readonly byteLength: number;
  read(): Promise<Uint8Array>;
}
export interface WorldQueryV1 {
  header(): CityWorldHeaderV1;
  roads(query: { bounds?: Bounds3V1; limit: number; cursor?: string }): CityPageV1<RoadEdgeDtoV2>;
  objects(query: { bounds?: Bounds3V1; kinds?: readonly string[]; limit: number; cursor?: string }): CityPageV1<WorldObjectDtoV2>;
  anchors(query: { kinds?: readonly AnchorDtoV2["kind"][]; limit: number; cursor?: string }): CityPageV1<AnchorDtoV2>;
  volumes(query: { bounds?: Bounds3V1; kinds?: readonly WorldVolumeDtoV1["kind"][]; limit: number; cursor?: string }): CityPageV1<WorldVolumeDtoV1>;
  terrainSample(x: number, z: number): TerrainSampleV1;
}
export interface WorldAssetV1 {
  openTerrainTile(id: StableIdV1, expectedDigest: DigestV1): Promise<BoundedAssetReaderV1>;
  openModel(assetDigest: DigestV1): Promise<BoundedAssetReaderV1>;
}
export interface CityEnvironmentV1 {
  readonly schemaVersion: 1;
  readonly medium: "air" | "water" | "vacuum" | "mixed";
  readonly biome: string;
  readonly simulationUtcMs: number;
  readonly timeZoneId: string;
  readonly localHour: number;
  readonly environmentRevision: RevisionIdV1;
  readonly weatherRevision: RevisionIdV1;
  readonly clockRevision: RevisionIdV1;
  readonly weather: Readonly<{ kind: string; intensity: number }>;
}
export interface CityRenderProfileRefV1 {
  readonly id: string;
  readonly version: string;
  readonly digest: DigestV1;
  readonly renderRevision: RevisionIdV1;
}
export interface CityAppearanceRefV1 {
  readonly theme: Readonly<{ id: string; version: string; digest: DigestV1 }>;
  readonly renderProfile: CityRenderProfileRefV1;
  readonly appearanceRevision: RevisionIdV1;
}

export interface CityTemporalSnapshotV1 {
  readonly schemaVersion: 1;
  readonly cityId: string;
  readonly clockId: string;
  readonly simulationUtcMs: number;
  readonly timeZoneId: string;
  readonly mode: "realtime" | "paused" | "accelerated";
  readonly timeScale: number;
  readonly tick: number;
  readonly clockRevision: RevisionIdV1;
  readonly uncertainty?: "clock_uncertain";
}
export interface CityTemporalPolicyV1 {
  readonly schemaVersion: 1;
  readonly defaultMode: "realtime";
  readonly timeZoneId: string;
  readonly offlinePolicy: "pause" | "advance";
  readonly maxCatchUpMs: number;
}
export interface StoryEventRecordV1 {
  readonly eventId: string;
  readonly occurrenceId: string;
  readonly dueAtUtcMs: number;
  readonly status: "scheduled" | "due" | "processing" | "committed" | "skipped" | "expired" | "failed";
  readonly lastProcessedTick: number;
  readonly idempotencyKey: string;
  readonly storyRevision: RevisionIdV1;
  readonly clockRevision: RevisionIdV1;
}

export type CityInteractionActionV1 =
  | { readonly type: "game.launch"; readonly gameId: string; readonly entry?: string; readonly presentation: "exclusive" | "overlay" }
  | { readonly type: "dialogue.open"; readonly dialogueId: string; readonly presentation: "overlay" }
  | { readonly type: "place.enter"; readonly placeId: StableIdV1 }
  | { readonly type: "quest.start"; readonly questId: string };
export interface CityInteractionDescriptorV1 {
  readonly schemaVersion: 1;
  readonly id: StableIdV1;
  readonly target: CityTargetRefV1;
  readonly trigger: "click" | "approach" | "event";
  readonly action: CityInteractionActionV1;
  readonly conditions?: readonly Readonly<{
    key: string;
    op: "eq";
    value: string | number | boolean;
  }>[];
  readonly priority?: number;
}

export const ACTOR_INTENT_KINDS_V1 = ["speak", "move", "interact", "invite", "join-game", "offer-quest", "suggest-meetup"] as const;
export type ActorIntentKindV1 = typeof ACTOR_INTENT_KINDS_V1[number];
export interface ActorIntentV1 {
  readonly kind: ActorIntentKindV1;
  readonly targetId?: StableIdV1;
  readonly payload?: Readonly<Record<string, string | number | boolean>>;
}
export interface CityAgentActorBindingV1 {
  readonly schemaVersion: 1;
  readonly actorId: string;
  readonly residentId: StableIdV1;
  readonly mode: "external-mcp" | "managed-session";
  readonly personaRef: string;
  readonly allowedIntents: readonly ActorIntentKindV1[];
  readonly routineRef?: string;
}
export interface ValidatedStoryIntentV1 extends ActorIntentV1 {
  readonly canonDigest: DigestV1;
  readonly baseStoryRevision: RevisionIdV1;
  readonly auditTraceId: string;
}
export interface StoryCommitCommandV1 {
  readonly operationId: OperationId;
  readonly eventId: string;
  readonly playerScope: PlayerScopeV1;
  readonly cityId: string;
  readonly gameId: string;
  readonly storyScope?: StoryStateScopeV1;
  readonly residentId?: StableIdV1;
  readonly expectedStoryRevision: RevisionIdV1;
  readonly expectedClockRevision: RevisionIdV1;
  readonly intent: ValidatedStoryIntentV1;
}
