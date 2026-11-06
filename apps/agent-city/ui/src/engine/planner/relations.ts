/** Geometric contact is not graph connectivity; all consumers share this classification. */
import { DetMath as Math } from "../detMath";
import type { Vec2 } from "../cityLayout";

export const ROAD_RELATION_CONFIG = { version: 1, nearDistance: 0.5, epsilon: 1e-9 };
export const ARTERIAL_CROWDING_CONFIG = { version: 1, maxDistance: 25, maxAngleDeg: 15, minOverlapT: 0.1, maxOverlapT: 0.9 };

/** One conflict per road pair, measured on actual segments in both directions.
 * Array order and a curved road's endpoint chord must not change the evidence. */
export function crowdedPolylinePair(a: Vec2[], b: Vec2[]): { at: Vec2; distance: number } | null {
  let best: { at: Vec2; distance: number } | null = null;
  for (let i = 1; i < a.length; i += 1) for (let j = 1; j < b.length; j += 1) {
    const u = { x: a[i].x - a[i - 1].x, z: a[i].z - a[i - 1].z }, v = { x: b[j].x - b[j - 1].x, z: b[j].z - b[j - 1].z };
    const lu = Math.hypot(u.x, u.z), lv = Math.hypot(v.x, v.z);
    if (!lu || !lv || Math.abs((u.x * v.x + u.z * v.z) / (lu * lv)) <= Math.cos(ARTERIAL_CROWDING_CONFIG.maxAngleDeg * Math.PI / 180)) continue;
    for (const [p, q, start, end] of [[a[i - 1], a[i], b[j - 1], b[j]], [b[j - 1], b[j], a[i - 1], a[i]]]) {
      const mid = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 }, dx = end.x - start.x, dz = end.z - start.z;
      const t = ((mid.x - start.x) * dx + (mid.z - start.z) * dz) / (dx * dx + dz * dz);
      if (t <= ARTERIAL_CROWDING_CONFIG.minOverlapT || t >= ARTERIAL_CROWDING_CONFIG.maxOverlapT) continue;
      const distance = Math.hypot(mid.x - start.x - t * dx, mid.z - start.z - t * dz);
      if (distance >= ARTERIAL_CROWDING_CONFIG.maxDistance) continue;
      if (!best || distance < best.distance || (distance === best.distance && (mid.x < best.at.x || (mid.x === best.at.x && mid.z < best.at.z)))) best = { at: mid, distance };
    }
  }
  return best;
}
export type SegmentRelationKind = "invalid" | "separate" | "endpoint-contact" | "endpoint-on-edge"
  | "interior-crossing" | "collinear-overlap" | "endpoint-near-node" | "endpoint-near-edge" | "parallel-near";
export type SegmentRelation = {
  kind: SegmentRelationKind;
  distance: number;
  a: { t: number; point: Vec2 };
  b: { t: number; point: Vec2 };
  overlap?: { a: [number, number]; b: [number, number] };
};
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const pointAt = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
const endpoint = (t: number) => t === 0 || t === 1;

/** Exact strict predicate retained for callers not yet handling T/overlap/near-contact transactions. */
export function roadSegmentsCrossInterior(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Closest clamped parameters, including zero-length segments (point queries). */
export function closestSegmentPoints(p1: Vec2, q1: Vec2, p2: Vec2, q2: Vec2): Omit<SegmentRelation, "kind" | "overlap"> {
  const dx = q1.x - p1.x, dz = q1.z - p1.z, ex = q2.x - p2.x, ez = q2.z - p2.z;
  const rx = p1.x - p2.x, rz = p1.z - p2.z;
  const a = dx * dx + dz * dz, e = ex * ex + ez * ez, f = ex * rx + ez * rz;
  const eps = 1e-12;
  let s = 0, t = 0;
  if (a > eps || e > eps) {
    if (a <= eps) t = clamp(f / e);
    else {
      const c = dx * rx + dz * rz;
      if (e <= eps) s = clamp(-c / a);
      else {
        const b = dx * ex + dz * ez, denom = a * e - b * b;
        s = denom > eps ? clamp((b * f - c * e) / denom) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = clamp(-c / a); }
        else if (t > 1) { t = 1; s = clamp((b - c) / a); }
      }
    }
  }
  const u = pointAt(p1, q1, s), v = pointAt(p2, q2, t);
  return { distance: Math.hypot(u.x - v.x, u.z - v.z), a: { t: s, point: u }, b: { t, point: v } };
}

export function classifyRoadSegments(a: Vec2, b: Vec2, c: Vec2, d: Vec2, tolerance = ROAD_RELATION_CONFIG.nearDistance): SegmentRelation {
  if (![a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z, tolerance].every(Number.isFinite) || tolerance < 0) {
    return { kind: "invalid", distance: Infinity, a: { t: 0, point: { ...a } }, b: { t: 0, point: { ...c } } };
  }
  const closest = closestSegmentPoints(a, b, c, d);
  const ux = b.x - a.x, uz = b.z - a.z, vx = d.x - c.x, vz = d.z - c.z;
  const lu2 = ux * ux + uz * uz, lv2 = vx * vx + vz * vz;
  const determinant = ux * vz - uz * vx, eps = ROAD_RELATION_CONFIG.epsilon;
  const parallel = lu2 > eps * eps && lv2 > eps * eps && Math.abs(determinant) <= eps * Math.sqrt(lu2 * lv2);
  // Exact endpoint evidence precedes floating-point parameter division. A
  // registered shared endpoint must not become a tiny interior T because t
  // rounds to 0.9999999999999999. Parallel overlap still takes precedence.
  const shared = [
    { p: a, q: c, t: 0, s: 0 }, { p: a, q: d, t: 0, s: 1 },
    { p: b, q: c, t: 1, s: 0 }, { p: b, q: d, t: 1, s: 1 },
  ].find(({ p, q }) => p.x === q.x && p.z === q.z);
  const sharedContact = (): SegmentRelation => ({ kind: "endpoint-contact", distance: 0,
    a: { t: shared!.t, point: { ...shared!.p } }, b: { t: shared!.s, point: { ...shared!.q } } });
  if (shared && !parallel) return sharedContact();
  // Strict intersections precede approximate parallel tests: even a very small real crossing is unsafe.
  if (determinant !== 0) {
    const dx = c.x - a.x, dz = c.z - a.z;
    const t = (dx * vz - dz * vx) / determinant, s = (dx * uz - dz * ux) / determinant;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1) {
      const ea = endpoint(t), eb = endpoint(s);
      return { kind: ea && eb ? "endpoint-contact" : ea || eb ? "endpoint-on-edge" : "interior-crossing",
        distance: 0, a: { t, point: pointAt(a, b, t) }, b: { t: s, point: pointAt(c, d, s) } };
    }
  }
  if (parallel && Math.abs((c.x - a.x) * uz - (c.z - a.z) * ux) <= eps * Math.sqrt(lu2)) {
    const tc = ((c.x - a.x) * ux + (c.z - a.z) * uz) / lu2;
    const td = ((d.x - a.x) * ux + (d.z - a.z) * uz) / lu2;
    const lo = Math.max(0, Math.min(tc, td)), hi = Math.min(1, Math.max(tc, td));
    if (hi > lo && (hi - lo) * Math.sqrt(lu2) > eps) {
      const u = pointAt(a, b, lo), v = pointAt(a, b, hi);
      const sl = clamp(((u.x - c.x) * vx + (u.z - c.z) * vz) / lv2);
      const sh = clamp(((v.x - c.x) * vx + (v.z - c.z) * vz) / lv2);
      return { ...closest, kind: "collinear-overlap", distance: 0, overlap: { a: [lo, hi], b: [sl, sh] } };
    }
  }
  if (shared) return sharedContact();
  if (closest.distance > tolerance) return { ...closest, kind: "separate" };
  if (closest.distance <= eps) return { ...closest, kind: endpoint(closest.a.t) && endpoint(closest.b.t) ? "endpoint-contact" : "endpoint-on-edge" };
  const tc = lu2 ? ((c.x - a.x) * ux + (c.z - a.z) * uz) / lu2 : 0;
  const td = lu2 ? ((d.x - a.x) * ux + (d.z - a.z) * uz) / lu2 : 0;
  const projectedOverlap = Math.min(1, Math.max(tc, td)) > Math.max(0, Math.min(tc, td));
  return { ...closest, kind: parallel && projectedOverlap ? "parallel-near" : endpoint(closest.a.t) && endpoint(closest.b.t) ? "endpoint-near-node" : "endpoint-near-edge" };
}
