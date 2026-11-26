/**
 * Stable, run-scoped identifiers. They are opaque strings by contract: a host
 * may prefix them with a run scope later, so no consumer may parse an
 * EntityIdV1 back into an index or assume it is globally unique across runs.
 */
export type EntityIdV1 = string;
export type GameIdV1 = string;
export type RunIdV1 = string;
export type AssetIdV1 = string;
export type RouteIdV1 = string;
export type AnchorIdV1 = string;
export type BuildId = string;
export type DigestV1 = string;
