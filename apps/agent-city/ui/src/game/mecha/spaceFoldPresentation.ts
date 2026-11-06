/** Read-only description of an authoritative fold projection. */
import type { FoldProjection } from "./skillPhaseField";
export type SpaceFoldPresentation = { status: "unavailable"; reason: string } | { status: "ready"; mapping: string[]; moves: string[] };
/** Preserve rule order: the host determines the projection and its validity. */
export function describeSpaceFold(projection: FoldProjection, locale: "zh" | "en"): SpaceFoldPresentation {
  if (projection.status === "void") return { status: "unavailable", reason: projection.reason };
  const point = (cell: { x: number; y: number }) => `(${cell.x + 1}, ${cell.y + 1})`;
  return { status: "ready", mapping: projection.mapping.map(pair => `${point(pair.from)} → ${point(pair.to)}`),
    moves: projection.moves.map(move => locale === "zh" ? `${move.unitId}：${point(move.from)} → ${point(move.to)}（${move.width}×${move.height}）` : `${move.unitId}: ${point(move.from)} → ${point(move.to)} (${move.width}×${move.height})`) };
}
