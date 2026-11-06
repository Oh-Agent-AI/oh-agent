/** New arterial candidates use the same real-polyline relation as final verification. */
import { roadWidthFor } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import type { RoadEdge, Vec2 } from "../cityLayout";
import { keyOf } from "./network";
import { ARTERIAL_CROWDING_CONFIG, crowdedPolylinePair } from "./relations";

export function roadCandidateCrowding(accepted: readonly RoadEdge[], candidates: readonly { a: Vec2; b: Vec2; arterial: boolean }[]):
  { candidateIndex: number; hostId: string } | null {
  const sampledRoads = new Map<RoadEdge, Vec2[]>();
  const roads = accepted.filter((edge) => !edge.bridge && edge.kind === "arterial");
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (!candidate.arterial) continue;
    const a = keyOf(candidate.a), b = keyOf(candidate.b), from = `${a.x}:${a.z}`, to = `${b.x}:${b.z}`;
    const proposed: RoadEdge = { id: [from, to].sort().join("/"), from, to, width: roadWidthFor("collector"), kind: "arterial", points: [a, b] };
    for (const road of roads) {
      if ([from, to].some((id) => id === road.from || id === road.to)) continue;
      const gap = ARTERIAL_CROWDING_CONFIG.maxDistance;
      // A corridor pair within gap must have overlapping expanded bounds.
      // Avoid sampling remote roads in large cities; this cannot hide a close pair.
      if (road.points.every(p => p.x < Math.min(a.x, b.x) - gap)
        || road.points.every(p => p.x > Math.max(a.x, b.x) + gap)
        || road.points.every(p => p.z < Math.min(a.z, b.z) - gap)
        || road.points.every(p => p.z > Math.max(a.z, b.z) + gap)) continue;
      // Long accepted roads may be split at later junctions. Probe their actual
      // corridor now, so subdivision cannot reveal a conflict after block publication.
      const sampled = () => {
        const cached = sampledRoads.get(road);
        if (cached) return cached;
        const points = road.points;
        const result = points.flatMap((p, k) => {
          if (!k) return [p];
          const a = points[k - 1], count = Math.ceil(Math.hypot(p.x - a.x, p.z - a.z) / 10);
          return Array.from({ length: count }, (_, j) => ({ x: a.x + (p.x - a.x) * (j + 1) / count, z: a.z + (p.z - a.z) * (j + 1) / count }));
        });
        sampledRoads.set(road, result);
        return result;
      };
      if (crowdedPolylinePair(proposed.points, road.points)
        || crowdedPolylinePair(proposed.points, sampled())) return { candidateIndex: i, hostId: road.id };
    }
    roads.push(proposed);
  }
  return null;
}
