/** Exact rectangle/capsule admission on every accepted polyline segment. */
import type { RoadEdge } from "../cityLayout";
import { orientedRectPolygon, segmentToPolygonDistance, type OrientedRect } from "./footprint";

export function lotClearsRoads(lot: OrientedRect, roads: readonly RoadEdge[],
  nearby?: readonly { a: { x: number; z: number }; b: { x: number; z: number }; width: number }[]): boolean {
  if (![lot.x, lot.z, lot.yaw, lot.width, lot.depth].every(Number.isFinite) || lot.width <= 0 || lot.depth <= 0) return false;
  // footprint's planar convention is opposite to renderer rotationY.
  const polygon = orientedRectPolygon({ ...lot, yaw: -lot.yaw });
  const clear = (a: { x: number; z: number }, b: { x: number; z: number }, width: number) =>
    Number.isFinite(width) && width > 0 && segmentToPolygonDistance(a, b, polygon) >= width / 2 + 0.5;
  // Layout occupancy passes the nearby centreline index; scanning every accepted
  // edge per hotel/ocean lot was ~190ms of the first occupancy on Miami tier 10.
  if (nearby) return nearby.every((seg) => clear(seg.a, seg.b, seg.width));
  return roads.every(edge => Number.isFinite(edge.width) && edge.width > 0 && edge.points.length >= 2
    && edge.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.z))
    && edge.points.slice(1).every((b, i) => clear(edge.points[i], b, edge.width)));
}
