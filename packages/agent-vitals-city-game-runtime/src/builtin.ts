import type { GameTypeDescriptorV1 } from "../../agent-vitals-city-sdk/src/index";

/** Single allowlist of built-in activity template IDs. Descriptors below use
 * these constants; neither the catalog nor a future capability projection may
 * invent a template string that is absent here. */
export const BUILTIN_ACTIVITY_TEMPLATE_IDS = Object.freeze({
  flight: "miami-flight",
  driving: "miami-driving",
  mecha: "miami-mecha",
  cinema: "miami-cinema",
});

/** Catalog of built-in activity types. These descriptors are NOT capability
 * declarations: until an adapter is registered, they cannot be resolved or
 * surfaced as playable game types. These are descriptors only: the app
 * must wrap the existing Miami implementations as runtime adapters before they
 * can be registered. Catalog validation happens in tests. */
export const MIAMI_ACTIVITY_CATALOG_V1: readonly GameTypeDescriptorV1[] = Object.freeze<GameTypeDescriptorV1[]>([
  { schemaVersion: 1, id: "miami.flight-v1", version: 1, label: "驾驶飞机", templateCatalog: "builtin", template: BUILTIN_ACTIVITY_TEMPLATE_IDS.flight,
    runtime: { id: "miami.flight", contractVersion: 1 }, slots: {}, parameters: {}, assetRoles: {}, hud: "miami-flight-hud" },
  { schemaVersion: 1, id: "miami.driving-v1", version: 1, label: "驾车", templateCatalog: "builtin", template: BUILTIN_ACTIVITY_TEMPLATE_IDS.driving,
    runtime: { id: "miami.driving", contractVersion: 1 }, slots: {}, parameters: {}, assetRoles: {}, hud: "miami-driving-hud" },
  { schemaVersion: 1, id: "miami.mecha-v1", version: 1, label: "机甲战棋", templateCatalog: "builtin", template: BUILTIN_ACTIVITY_TEMPLATE_IDS.mecha,
    runtime: { id: "miami.mecha", contractVersion: 1 }, slots: {}, parameters: {}, assetRoles: {}, hud: "miami-mecha-hud" },
  { schemaVersion: 1, id: "miami.cinema-v1", version: 1, label: "航拍", templateCatalog: "builtin", template: BUILTIN_ACTIVITY_TEMPLATE_IDS.cinema,
    runtime: { id: "miami.cinema", contractVersion: 1 }, slots: {}, parameters: {}, assetRoles: {}, hud: "miami-cinema-hud" },
]);

/** First planned Creator flight game type; not registered until its runtime
 * adapter lands. Kept here so capability/editor work can consume the contract. */
export const ORNITHOPTER_GAME_TYPE_V1 = Object.freeze({
  schemaVersion: 1, id: "creator.flight-ornithopter-v1", version: 1, label: "扑翼飞行", templateCatalog: "planned", template: "ornithopter-flight",
  runtime: { id: "city-flight-ornithopter", contractVersion: 1 },
  slots: {
    launch: { kind: "spawn", min: 1, max: 1, requires: ["fly"] },
    gates: { kind: "route", min: 3, max: 12, requires: ["fly"], role: "gate" },
  },
  parameters: {
    flapPower: { min: 1, max: 10, default: 6 },
    glideRatio: { min: 1, max: 20, default: 8 },
    turnRate: { min: 1, max: 10, default: 5 },
    wind: { min: 0, max: 10, default: 2 },
    timeLimit: { min: 30, max: 600, default: 120, unit: "seconds" },
  },
  assetRoles: { vehicle: { kind: "model-glb", required: true, maxBytes: 64 * 1024 * 1024, nodeRoles: ["wing.left", "wing.right"] } },
  hud: "flight-hud",
} as const) satisfies GameTypeDescriptorV1;
