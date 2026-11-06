/** Actual declared union projection and nominal plot reservation are distinct spaces.
 * XY clearance facts are partial: height, entrances and unregistered geometry remain unknown.
 */
import { hashSeed } from "../../cityModel";
import { DetMath as Math } from "../detMath";
import { GROUND_MODEL_FACTORIES, resolveGroundModel, type GroundModelResolution } from "../models/groundRegistry";
import { pointInRegion, MAX_FOOTPRINT_PARTS, MAX_CONVEX_VERTICES, type LocalFootprint, type LocalRegion, type Vec2 } from "../models/physical";
import type { GroundOwner } from "./modelGround";

export const MODEL_ENVELOPE_CONFIG = { version: 1, numericEpsilon: 1e-9, defaultRoadSetback: 3 } as const;
export type PlotReservationProxy = { readonly semantic: "nominal-plot-reservation"; readonly evidence: "legacy-radius";
  readonly region: Extract<LocalRegion, { shape: "circle" }> };
export type ModelEnvelope =
  | { readonly status: "partial"; readonly ownerId: string; readonly modelId: string; readonly modelRevision: string;
      readonly groundFootprint: LocalFootprint; readonly conservativeProjection: LocalFootprint; readonly plotReservation: PlotReservationProxy;
      readonly relocationCorridorEnvelope?: Extract<GroundModelResolution, { status: "partial" }>["relocationCorridorEnvelope"];
      readonly wholeModelReady: false; readonly missing: readonly string[] }
  | { readonly status: "unsupported"; readonly ownerId: string; readonly reason: string;
      readonly plotReservation?: PlotReservationProxy; readonly wholeModelReady: false };
export type EnvelopeRoad = { readonly id?: string; readonly width: number; readonly points: readonly Vec2[] };
export type SpatialRelation = { readonly relation: "clear" | "conflict" | "unsupported"; readonly distance: number; readonly required: number; readonly margin: number };
export type EnvelopeRoadInspection =
  | { readonly status: "partial"; readonly ownerId: string; readonly roadId?: string; readonly entity: SpatialRelation;
      readonly plotReservation: SpatialRelation; readonly semantic: "conservative-entity-projection"; readonly wholeModelReady: false; readonly missing: readonly string[] }
  | { readonly status: "unsupported"; readonly ownerId: string; readonly reason: string;
      readonly plotReservation?: SpatialRelation; readonly wholeModelReady: false };
export type EnvelopePairInspection =
  | { readonly status: "partial"; readonly entity: SpatialRelation; readonly plotReservations: SpatialRelation;
      readonly semantic: "conservative-entity-projections"; readonly wholeModelReady: false; readonly missing: readonly string[] }
  | { readonly status: "unsupported"; readonly reason: string; readonly proxy?: SpatialRelation;
      readonly proxySemantic?: "nominal-plots" | "actual-projection-and-nominal-plot";
      readonly plotReservations?: SpatialRelation; readonly wholeModelReady: false };

const finitePoint = (point: Vec2) => !!point && Number.isFinite(point.x) && Number.isFinite(point.z);
function validFootprint(footprint: LocalFootprint): boolean {
  if (!footprint || !Array.isArray(footprint.parts) || !footprint.parts.length || footprint.parts.length > MAX_FOOTPRINT_PARTS * 2) return false;
  return footprint.parts.every((region: LocalRegion) => {
    if (!region) return false;
    if (region.shape === "circle") return finitePoint(region.center) && Number.isFinite(region.radius) && region.radius >= 0;
    if (region.shape === "rect") return finitePoint(region.center) && Number.isFinite(region.width) && region.width > 0 && Number.isFinite(region.depth) && region.depth > 0;
    if (region.shape !== "convex" || !Array.isArray(region.vertices) || region.vertices.length < 3 || region.vertices.length > MAX_CONVEX_VERTICES || region.vertices.some((point: Vec2) => !finitePoint(point))) return false;
    let direction = 0;
    for (let i = 0; i < region.vertices.length; i++) {
      const a = region.vertices[i], b = region.vertices[(i + 1) % region.vertices.length];
      for (const point of region.vertices) {
        const value = (b.x - a.x) * (point.z - a.z) - (b.z - a.z) * (point.x - a.x);
        if (value === 0) continue;
        const sign = value > 0 ? 1 : -1;
        if (direction && sign !== direction) return false;
        direction = sign;
      }
    }
    return direction !== 0;
  });
}
const eps = MODEL_ENVELOPE_CONFIG.numericEpsilon;
const worldPoint = (point: Vec2, owner: GroundOwner): Vec2 => ({
  x: owner.x + point.x * Math.cos(owner.yaw) + point.z * Math.sin(owner.yaw),
  z: owner.z - point.x * Math.sin(owner.yaw) + point.z * Math.cos(owner.yaw),
});
function projectRegion(region: LocalRegion, owner: GroundOwner): LocalRegion {
  if (region.shape === "circle") return { shape: "circle", center: worldPoint(region.center, owner), radius: region.radius };
  const points = region.shape === "convex" ? region.vertices : [
    { x: region.center.x - region.width / 2, z: region.center.z - region.depth / 2 },
    { x: region.center.x + region.width / 2, z: region.center.z - region.depth / 2 },
    { x: region.center.x + region.width / 2, z: region.center.z + region.depth / 2 },
    { x: region.center.x - region.width / 2, z: region.center.z + region.depth / 2 },
  ];
  return { shape: "convex", vertices: points.map(point => worldPoint(point, owner)) };
}
export function resolveModelEnvelope(owner: GroundOwner): ModelEnvelope {
  const unsupported = (reason: string, plotReservation?: PlotReservationProxy): ModelEnvelope =>
    ({ status: "unsupported", ownerId: owner?.id ?? "", reason, ...(plotReservation ? { plotReservation } : {}), wholeModelReady: false });
  if (!owner || !owner.id || !owner.kind || ![owner.x, owner.z, owner.yaw, owner.radius].every(Number.isFinite) || owner.radius < 0)
    return unsupported("invalid model owner geometry");
  const plotReservation: PlotReservationProxy | undefined = owner.radius > 0 ? { semantic: "nominal-plot-reservation", evidence: "legacy-radius",
    region: { shape: "circle", center: { x: owner.x, z: owner.z }, radius: owner.radius } } : undefined;
  const resolution = resolveGroundModel(owner.kind, { seed: hashSeed(owner.id), radius: owner.radius });
  if (resolution.status === "unsupported") return unsupported(resolution.reason, plotReservation);
  try {
    const declaration = resolution.declaration;
    const groundFootprint = { parts: declaration.footprint.parts.map(region => projectRegion(region, owner)) };
    // Upper solids are conservatively projected into the same XY obstacle set.
    // This does not authorize passing beneath them without a height contract.
    const conservativeProjection = { parts: [...groundFootprint.parts, ...(declaration.overhang?.parts ?? []).map(region => projectRegion(region, owner))] };
    if (!plotReservation || !validFootprint(groundFootprint) || !validFootprint(conservativeProjection)) return unsupported("model declaration has no usable projection", plotReservation);
    return { status: "partial", ownerId: owner.id, modelId: declaration.modelId, modelRevision: declaration.modelRevision,
      groundFootprint, conservativeProjection, plotReservation, wholeModelReady: false,
      ...(resolution.relocationCorridorEnvelope ? { relocationCorridorEnvelope: { ...resolution.relocationCorridorEnvelope } } : {}),
      missing: [...resolution.missing, "height-qualified collision", "full model physical readiness"] };
  } catch (error) { return unsupported(error instanceof Error ? error.message : "invalid model projection", plotReservation); }
}

function pointSegmentDistance(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(point.x - a.x - dx * t, point.z - a.z - dz * t);
}
const cross = (a: Vec2, b: Vec2, point: Vec2) => (b.x - a.x) * (point.z - a.z) - (b.z - a.z) * (point.x - a.x);
function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  const straddles = (x: number, y: number) => (x >= -eps && y <= eps) || (x <= eps && y >= -eps);
  if (straddles(abC, abD) && straddles(cdA, cdB) &&
      Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + eps &&
      Math.max(Math.min(a.z, b.z), Math.min(c.z, d.z)) <= Math.min(Math.max(a.z, b.z), Math.max(c.z, d.z)) + eps) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}
function vertices(region: Exclude<LocalRegion, { shape: "circle" }>): readonly Vec2[] {
  if (region.shape === "convex") return region.vertices;
  return [
    { x: region.center.x - region.width / 2, z: region.center.z - region.depth / 2 },
    { x: region.center.x + region.width / 2, z: region.center.z - region.depth / 2 },
    { x: region.center.x + region.width / 2, z: region.center.z + region.depth / 2 },
    { x: region.center.x - region.width / 2, z: region.center.z + region.depth / 2 },
  ];
}
function pointRegionDistance(point: Vec2, region: LocalRegion): number {
  if (region.shape === "circle") return Math.max(0, Math.hypot(point.x - region.center.x, point.z - region.center.z) - region.radius);
  if (pointInRegion(point, region)) return 0;
  const polygon = vertices(region);
  return Math.min(...polygon.map((a, i) => pointSegmentDistance(point, a, polygon[(i + 1) % polygon.length])));
}
function segmentRegionDistance(a: Vec2, b: Vec2, region: LocalRegion): number {
  if (region.shape === "circle") return Math.max(0, pointSegmentDistance(region.center, a, b) - region.radius);
  if (pointInRegion(a, region) || pointInRegion(b, region)) return 0;
  const polygon = vertices(region);
  return Math.min(...polygon.map((c, i) => segmentDistance(a, b, c, polygon[(i + 1) % polygon.length])));
}
function regionDistance(a: LocalRegion, b: LocalRegion): number {
  if (a.shape === "circle") return Math.max(0, pointRegionDistance(a.center, b) - a.radius);
  if (b.shape === "circle") return Math.max(0, pointRegionDistance(b.center, a) - b.radius);
  const av = vertices(a), bv = vertices(b);
  if (pointInRegion(av[0], b) || pointInRegion(bv[0], a)) return 0;
  let distance = Infinity;
  for (let i = 0; i < av.length; i += 1) for (let j = 0; j < bv.length; j += 1)
    distance = Math.min(distance, segmentDistance(av[i], av[(i + 1) % av.length], bv[j], bv[(j + 1) % bv.length]));
  return distance;
}
export function footprintUnionDistance(a: LocalFootprint, b: LocalFootprint): number {
  if (!validFootprint(a) || !validFootprint(b)) return NaN;
  return Math.min(...a.parts.flatMap(part => b.parts.map(other => regionDistance(part, other))));
}
export function footprintPolylineDistance(footprint: LocalFootprint, points: readonly Vec2[]): number {
  if (!validFootprint(footprint) || !Array.isArray(points) || !points.length || points.some(point => !finitePoint(point))) return NaN;
  if (points.length === 1) return Math.min(...footprint.parts.map(part => pointRegionDistance(points[0], part)));
  let distance = Infinity;
  for (let i = 1; i < points.length; i += 1) for (const part of footprint.parts)
    distance = Math.min(distance, segmentRegionDistance(points[i - 1], points[i], part));
  return distance;
}
// Unsigned distance is zero for overlap and contact. Neither can certify clear
// space even when the caller's additional setback is zero.
const relation = (distance: number, required: number): SpatialRelation => ({ relation: !Number.isFinite(distance) ? "unsupported"
  : distance === 0 || distance < required ? "conflict" : "clear", distance, required, margin: distance - required });
export function inspectEnvelopeRoad(owner: GroundOwner, road: EnvelopeRoad,
  options: { readonly setback?: number } = {}): EnvelopeRoadInspection {
  const setback = options.setback ?? MODEL_ENVELOPE_CONFIG.defaultRoadSetback;
  if (!road || !Number.isFinite(road.width) || road.width <= 0 || !Array.isArray(road.points) || road.points.length < 2 ||
      road.points.some(point => !finitePoint(point)) || !Number.isFinite(setback) || setback < 0)
    return { status: "unsupported", ownerId: owner?.id ?? "", reason: "invalid complete road corridor/setback", wholeModelReady: false };
  const model = resolveModelEnvelope(owner), required = road.width / 2 + setback;
  const plotReservation = model.plotReservation ? relation(footprintPolylineDistance({ parts: [model.plotReservation.region] }, road.points), required) : undefined;
  if (model.status === "unsupported") return { status: "unsupported", ownerId: model.ownerId, reason: model.reason,
    ...(plotReservation ? { plotReservation } : {}), wholeModelReady: false };
  return { status: "partial", ownerId: model.ownerId, roadId: road.id,
    entity: relation(footprintPolylineDistance(model.conservativeProjection, road.points), required), plotReservation: plotReservation!,
    semantic: "conservative-entity-projection", wholeModelReady: false, missing: model.missing };
}
/** Complete XY corridor admission is not whole-model readiness. Undefined
 * preserves the legacy proxy for models without this explicit capability. */
export function declaredGroundRoadClear(owner: GroundOwner, roads: readonly EnvelopeRoad[]): boolean | undefined {
  const envelope = resolveModelEnvelope(owner);
  if (envelope.status === "unsupported" && Object.hasOwn(GROUND_MODEL_FACTORIES, owner?.kind ?? "")) return false;
  if (envelope.status !== "partial" || envelope.relocationCorridorEnvelope?.schemaVersion !== 1
    || envelope.relocationCorridorEnvelope.coverage !== "complete-conservative-renderer-xy") return undefined;
  return roads.every(road => !!road && Number.isFinite(road.width) && road.width > 0 && Array.isArray(road.points) && road.points.length >= 2
    && footprintPolylineDistance(envelope.conservativeProjection, road.points) >= road.width / 2 + MODEL_ENVELOPE_CONFIG.defaultRoadSetback);
}
export function inspectEnvelopePair(a: GroundOwner, b: GroundOwner, options: { readonly setback?: number } = {}): EnvelopePairInspection {
  const setback = options.setback ?? 0, first = resolveModelEnvelope(a), second = resolveModelEnvelope(b);
  if (!Number.isFinite(setback) || setback < 0) return { status: "unsupported", reason: "invalid entity separation", wholeModelReady: false };
  const plotReservations = first.plotReservation && second.plotReservation ? relation(footprintUnionDistance(
    { parts: [first.plotReservation.region] }, { parts: [second.plotReservation.region] }), setback) : undefined;
  if (first.status === "partial" && second.status === "partial") return { status: "partial",
    entity: relation(footprintUnionDistance(first.conservativeProjection, second.conservativeProjection), setback), plotReservations: plotReservations!,
    semantic: "conservative-entity-projections", wholeModelReady: false, missing: [...first.missing, ...second.missing] };
  const fp = first.status === "partial" ? first.conservativeProjection : first.plotReservation ? { parts: [first.plotReservation.region] } : undefined;
  const sp = second.status === "partial" ? second.conservativeProjection : second.plotReservation ? { parts: [second.plotReservation.region] } : undefined;
  return { status: "unsupported", reason: [first, second].filter((model): model is Extract<ModelEnvelope, { status: "unsupported" }> => model.status === "unsupported")
    .map(model => `${model.ownerId}: ${model.reason}`).join("; "),
    ...(fp && sp ? { proxy: relation(footprintUnionDistance(fp, sp), setback),
      proxySemantic: first.status === "partial" || second.status === "partial" ? "actual-projection-and-nominal-plot" as const : "nominal-plots" as const } : {}),
    ...(plotReservations ? { plotReservations } : {}), wholeModelReady: false };
}
