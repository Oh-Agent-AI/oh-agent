export type ContentKind = "city-layout" | "city-skin" | "city-minigame";
export type ContentRef<K extends ContentKind = ContentKind> = {
  kind: K;
  id: string;
  version: string;
  digest: string;
};

export type AnchorKind = "spawn" | "route" | "zone" | "object";
export type AnchorCapability = "drive" | "walk";
export interface CityAnchorV1 {
  id: string;
  kind: AnchorKind;
  capabilities: AnchorCapability[];
  geometryRef: string;
}
/** Undirected, capability-scoped traversal between two stable anchors. */
export interface CityAnchorLinkV1 {
  id: string;
  fromAnchorId: string;
  toAnchorId: string;
  capabilities: AnchorCapability[];
}
export interface CityLayoutV1 {
  schemaVersion: 1;
  id: string;
  coordinateSystem: "city-local-m-v1";
  anchors: CityAnchorV1[];
  /** Optional for layouts without trusted topology; Creator snapshots include it. */
  links?: CityAnchorLinkV1[];
}
/** Immutable, host-captured layout identity supplied to a Creator project. */
export interface CityLayoutSnapshotV1 {
  schemaVersion: 1;
  worldRevision: string;
  seed: number;
  layout: CityLayoutV1;
}
/** Multi-City snapshot: world revisions and anchors are scoped to one City revision. */
export interface CityLayoutSnapshotV2 {
  schemaVersion: 2;
  cityId: string;
  cityRevision: number;
  worldRevision: string;
  seed: number;
  layout: CityLayoutV1;
}
export type CityGeographyGeneratorV1 = "coastal-islands-v1" | "arid-dunes-v1";
export interface CoastalWorldParametersV1 {
  profile: "miami-coastal";
  version: number;
  biome: "tropical";
  preferredAzimuth: number;
  azimuthTolerance: number;
  segmentArc: number;
  wetSandWidth: number;
  drySandWidth: number;
  promenadeOffset: number;
  boulevardOffset: number;
  hotelOffset: number;
  bandOuter: number;
  maxCoastalSlope: number;
  maxCoastalHeight: number;
  riverMargin: number;
  siteMargin: number;
  minValidRatio: number;
  bayHalfWidth: number;
  bayShift: number;
}
export interface AridDunesWorldParametersV1 {
  duneScale: number;
  duneAmplitude: number;
  orientationDeg: number;
}
export interface CityWorldProfileBaseV1 {
  schemaVersion: 1;
  id: string;
  version: number;
}
export type CityWorldProfileV1 = CityWorldProfileBaseV1 & (
  | { biome: "tropical"; geography: { generator: "coastal-islands-v1"; parameters: { coastal: CoastalWorldParametersV1 } }; visuals: { themeId: "miami" | "desert" } }
  | { biome: "arid"; geography: { generator: "arid-dunes-v1"; parameters: { dunes: AridDunesWorldParametersV1 } }; visuals: { themeId: "miami" | "desert" } }
);
/** Persisted identity of an independently authored City, not a plugin instance or a world profile ID. */
export interface CityInstanceV1 {
  schemaVersion: 1;
  cityId: string;
  revision: number;
  name: string;
  seed: number;
  profile: CityWorldProfileV1;
}
export interface CitySkinPackV1 {
  schemaVersion: 1;
  id: string;
  renderContract: "city-render-v1";
  compatibleGeographies: CityGeographyGeneratorV1[];
  visuals: { themeId: "miami" | "desert" };
}
export interface AnchorFilterV1 {
  kind?: AnchorKind;
  requires?: AnchorCapability[];
}
export interface CityAnchorGeometryV1 {
  positionMeters: Readonly<{ x: number; y: number; z: number }>;
  activationRadiusMeters?: number;
  facingRadians?: number;
}
export interface SlotSpecV1 {
  kind: AnchorKind;
  min: number;
  max: number;
  requires?: AnchorCapability[];
}
export interface MiniGamePackV1 {
  schemaVersion: 1;
  id: string;
  rulesVersion: 1;
  slots: Record<string, SlotSpecV1>;
  integerParameters?: Record<string, { min: number; max: number; default: number }>;
  rules: RuleGraphV1;
}
export interface CityGameMountV1 {
  schemaVersion: 1;
  mountId: string;
  layout: ContentRef<"city-layout">;
  game: ContentRef<"city-minigame">;
  entryAnchorId: string;
  bindings: Record<string, string[]>;
  parameterOverrides: Record<string, number>;
}
export interface SceneTransformV1 {
  positionMeters: Readonly<{ x: number; y: number; z: number }>;
  rotationRadians: Readonly<{ x: number; y: number; z: number }>;
  scale: Readonly<{ x: number; y: number; z: number }>;
}
export interface SceneModelObjectV1 {
  id: string;
  kind: "model";
  asset: ModelAssetRefV1;
  transform: SceneTransformV1;
}
/** Explicit static gameplay geometry. Visual models never become colliders implicitly. */
export interface SceneBoxColliderObjectV1 {
  id: string;
  kind: "collider";
  shape: "box";
  sizeMeters: Readonly<{ x: number; y: number; z: number }>;
  transform: SceneTransformV1;
}
export interface ModelAssetRefV1 {
  package: ContentRef;
  assetId: string;
  digest: string;
}
export interface ModelAssetCatalogEntryV1 {
  ref: ModelAssetRefV1;
  relativePath: string;
  byteLength: number;
  boundsMeters: Readonly<{ x: number; y: number; z: number }>;
  unit: "meter";
}
export interface ModelAssetCatalogV1 {
  schemaVersion: 1;
  entries: ReadonlyArray<ModelAssetCatalogEntryV1>;
}
/** Project-local development inventory. It is not a signed or installable package manifest. */
export interface CityProjectAssetEntryV1 {
  assetId: string;
  relativePath: string;
  sha256: string;
  byteLength: number;
  format: "glb-v2";
  boundsMeters?: Readonly<{ x: number; y: number; z: number }>;
}
export interface CityProjectAssetCatalogV1 {
  schemaVersion: 1;
  entries: ReadonlyArray<CityProjectAssetEntryV1>;
}
export interface ModelAssetFilterV1 {
  assetId?: string;
  packageId?: string;
  packageKind?: ContentKind;
  maxByteLength?: number;
}
export interface SceneAnchorObjectV1 {
  id: string;
  kind: "anchor";
  anchor: CityAnchorV1;
  transform: SceneTransformV1;
}
export type SceneObjectV1 = SceneModelObjectV1 | SceneAnchorObjectV1 | SceneBoxColliderObjectV1;
export interface SceneDraftV1 {
  schemaVersion: 1;
  objects: ReadonlyArray<SceneObjectV1>;
}
export interface SceneObjectFilterV1 {
  kind?: SceneObjectV1["kind"];
  id?: string;
  assetId?: string;
  anchorKind?: AnchorKind;
}
export interface ResolvedModelAssetRefsV1 {
  refs: ReadonlyArray<ModelAssetRefV1>;
  entries: ReadonlyArray<ModelAssetCatalogEntryV1>;
}
export interface DiagnosticV1 {
  code: string;
  severity: "error" | "warning";
  path: string;
  objectId?: string;
  message: string;
}
export type Result<T> =
  | { ok: true; value: T; diagnostics: DiagnosticV1[] }
  | { ok: false; diagnostics: DiagnosticV1[] };

export type RuleEventV1 =
  | { type: "run.started"; tick: number }
  | { type: "zone.entered" | "item.collected"; tick: number; slot: string; index: number }
  | { type: "timer.expired"; tick: number; timerId: string };
export type PlayerRuleInputV1 = Extract<RuleEventV1, { type: "zone.entered" | "item.collected" }>;
export type RuleGuardV1 =
  | { op: "counter.eq"; counter: string; value: number }
  | { op: "counter.eqEventIndex"; counter: string };
export type RuleActionV1 =
  | { op: "counter.add"; counter: string; amount: number }
  | { op: "timer.start"; timerId: string; durationTicks: number | { parameter: string } }
  | { op: "hud.hint"; text: string }
  | { op: "run.finish"; outcome: "success" | "failure" };
export interface RuleGraphV1 {
  counters: Record<string, { initial: number; max: number }>;
  nodes: Array<{
    id: string;
    on: { type: "run.started" } | { type: "zone.entered" | "item.collected"; slot: string } | { type: "timer.expired"; timerId: string };
    when?: RuleGuardV1[];
    actions: RuleActionV1[];
  }>;
}
export interface CityActivityEventV1 {
  type: "zone.entered" | "item.collected";
  slot: string;
  index: number;
}
export interface RuleStateV1 {
  tick: number;
  counters: Readonly<Record<string, number>>;
  outcome: "success" | "failure" | null;
  hints: readonly string[];
}
export interface RuleStepV1 {
  state: RuleStateV1;
  emitted: readonly RuleEventV1[];
}
export interface HeadlessTraceStepV1 {
  tick: number;
  inputs?: ReadonlyArray<PlayerRuleInputV1>;
}
export interface HeadlessRunInputV1 {
  layout: CityLayoutV1;
  game: MiniGamePackV1;
  mount: CityGameMountV1;
  seed: number;
  trace: ReadonlyArray<HeadlessTraceStepV1>;
  expected?: Readonly<{ outcome?: "success" | "failure" | null; counters?: Readonly<Record<string, number>> }>;
}
export interface PlaytestEvidenceV1 {
  schemaVersion: 1;
  passed: boolean;
  seed: number;
  stepCount: number;
  finalState: RuleStateV1;
  failures: ReadonlyArray<DiagnosticV1>;
}

/** Bounded local summary reported by the trusted City visual-playtest adapter. */
export interface VisualPlaytestEvidenceV1 {
  schemaVersion: 1;
  runtimeVersion: "city-mini-game-runtime-v1";
  releaseId: string;
  projectRevision: number;
  snapshotDigest: string;
  worldRevision: string;
  seed: number;
  game: Readonly<{ id: string; version: string; digest: string }>;
  tick: number;
  counters: Readonly<Record<string, number>>;
  outcome: "success" | "failure" | null;
  reasonCode: string | null;
}

export interface PackageFileV1 {
  path: string;
  mediaType: "application/json" | "model/gltf-binary";
  byteLength: number;
  sha256: string;
}
export interface PackageManifestV1 {
  schemaVersion: 1;
  package: { kind: "city-minigame"; id: string; version: string };
  entry: { layout: string; game: string; mount: string };
  files: ReadonlyArray<PackageFileV1>;
  packageDigest: string;
  signature: null;
}
export interface CityContentPackageV1 {
  format: "oh-agent-city-package-v1";
  manifest: PackageManifestV1;
  files: Readonly<Record<string, unknown>>;
}
