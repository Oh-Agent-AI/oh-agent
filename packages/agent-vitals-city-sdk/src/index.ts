export * from "./types";
export * from "./contracts";
export { canonicalDigest, sha256Bytes, sha256Text } from "./digest";
export {
  CityWorldCompileError, WORLD_COMPILER_V1, compileCityWorld, compileWorld, compileWorldResult,
  createSeededRandomV1, createStableIdV1, createWorldCompiler, createWorldGeneratorContext,
  defineCityWorld, defineWorldGenerator, defineWorldPlan, stableIdV1,
  type CityWorldGeneratorContextV1, type CityWorldGeneratorDefinitionV1, type CityWorldGeneratorV1,
} from "./authoring";
export {
  CITY_COMPILE_CONTEXT_V1_JSON_SCHEMA, CITY_SHARED_CONTRACT_SCHEMAS_V1,
  CITY_WORLD_PLAN_V1_JSON_SCHEMA, CITY_WORLD_SNAPSHOT_V4_JSON_SCHEMA, type CityJsonSchemaV1,
} from "./schema";
export {
  CITY_ROAD_ENDPOINT_TOLERANCE_METERS_V1, CITY_WORLD_FLOAT_SCALE_V1,
  computeCityWorldDigests, validateCityJsonSchema, validateCityWorldSnapshot,
  validateCompileContext, validateWorldPlan, type CityWorldDigestSetV1,
} from "./sharedValidate";
export { segmentCrossesWorldVolume, segmentIntersectsVolumeGeometry, segmentPassesRingGate, sweepSegmentThroughVolumes } from "./worldVolumes";
export {
  compileWorldFixtureV1, createWorldCompilerFixtureV1, reverseWorldPlanCollections,
  verifyWorldCompilerDeterminism, type WorldCompilerFixtureV1, type WorldDeterminismEvidenceV1,
} from "./testing";
export { completionThresholdOverrides, listAnchors, listAssets, listSceneObjects, validateAssetRefs, validateCityInstance, validateCityLayout, validateCityLayoutScope, validateCityLayoutSnapshot, validateCityLayoutSnapshotV2, validateCityLayoutSnapshotScoped, validateCityLayoutSnapshotV3, validateCityProjectAssetCatalog, validateCitySkinPack, validateCityWorldProfile, validateMount, validateSceneDraft } from "./validate";
export { compileRules, createRun, runHeadless } from "./runtime";
export type { CompiledRulesV1, RuleRunV1 } from "./runtime";
export { parseMiniGamePackJson, validateMiniGamePack } from "./content";
export { CREATOR_CAPABILITIES_V1, CREATOR_CAPABILITY_VERSION, CREATOR_GAME_TYPES_V1, CREATOR_OPERATIONS_V1, CREATOR_RECOVERIES_V1, CREATOR_WORLDS_V1, CREATOR_WORLD_BUDGETS_V1, type CreatorCapabilitiesDescriptor, type CreatorGameTypeStatusV1, type CreatorGameTypeSummaryV1, type CreatorOperationDescriptor, type CreatorOperationKind } from "./creatorCapabilities";
export { CREATOR_TEMPLATES_V1, type CreatorTemplateV1 } from "./creatorTemplates";
// PR12 统一创作模板目录：Code Game 模板目录（生成产物，勿手改——见文件头）。
export { CREATOR_CODE_TEMPLATES_V1, type CreatorCodeTemplateV1 } from "./creatorCodeTemplates.generated";
export { canonicalJson, validateCityContentPackage, validatePackageManifest, PACKAGE_V1_LIMITS } from "./package";
export { validateContentPackageManifestV2, verifyContentPackageBytesV2, inspectContentPackageV2, inspectContentArtifactV2, CONTENT_PACKAGE_V2_LIMITS } from "./contentPackageV2";
export { validateWorldPlanPatch } from "./worldPlanPatch";
export { ARID_DUNES_WORLD_V2, ARID_DUNES_LEGACY_KEYS, COASTAL_ISLANDS_WORLD_V1, COASTAL_PROFILE_ID_V1, resolveWorldPresetV1, validateWorldCapabilityV1, validateWorldParametersV1, WORLD_PARAMETER_LIMITS,
  type WorldCapabilityV1, type WorldParameterDescriptorV1, type WorldParameterGroupV1, type WorldParameterKeyV1, type WorldParameterKindV1, type WorldPresetV1 } from "./worldParameters";
export { CITY_SKIN_PACK_IDS_V1, CITY_THEMES_V1, CITY_THEME_IDS_V1, citySkinPackForTheme, cityThemeForSkinPack, isCitySkinPackIdV1, isCityThemeIdV1,
  type CitySkinPackIdV1, type CityThemeIdV1, type CityVisualThemeV1 } from "./themes";
export { inspectGlbBytes } from "./model";
export type { GlbModelInspectionV1 } from "./model";

export { hasDuplicateJsonKeys } from "./jsonStrict";
export { validateGameTypeDescriptorV1, type GameTypeCapabilityV1, type GameTypeDescriptorV1, type GameTypeSlotKindV1 } from "./gameTypes";
export { FIXED_WING_VEHICLE_PRESET_V1, ORNITHOPTER_VEHICLE_PRESET_V1, validateVehicleProfileV1, VEHICLE_BOUNDS_LIMITS_V1, VEHICLE_CAMERA_BOUNDS_V1,
  VEHICLE_CAMERA_DEFAULTS_V1, VEHICLE_PERFORMANCE_DERIVATION_V1, VEHICLE_PHYSICS_BOUNDS_V1, VEHICLE_PHYSICS_KEYS_V1, VEHICLE_PHYSICS_RATIOS_V1, VEHICLE_PROFILE_LIMITS_V1,
  CREATOR_VEHICLE_CATALOG_V1, defaultVehicleCameraV1, estimateVehiclePerformanceV1,
  type VehicleFlightModelV1, type VehiclePerformanceEstimateV1, type VehicleProfileBoundsV1, type VehicleProfileV1 } from "./vehicleProfile";
