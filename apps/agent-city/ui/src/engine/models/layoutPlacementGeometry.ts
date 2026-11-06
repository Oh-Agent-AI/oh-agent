/** Renderer rectangle projections only; foundations and model-door routes remain separate contracts. */
import { DetMath as Math } from "../detMath";
import type { Vec2 } from "../cityLayout";
export const LAYOUT_ENVELOPE_INSET = 0.01;
export const GARDEN_RENDER_GEOMETRY = { inset: 3, treeRingX: 0.44, treeRingZ: 0.42,
  treeMinimumRadius: 1.4, treeRadiusVariation: 0.9, flagX: 0.3, flagZ: 0.32,
  flagClothWidth: 5.2, flagClothOffset: 0.1 };
export const CIVIC_RENDER_GEOMETRY = { scale: 0.82, maxWidth: 48, maxDepth: 40 };
type ExtentTerm = { scale: number; offset: number };
type Envelope = { width: readonly ExtentTerm[]; depth: readonly ExtentTerm[] };
// Half-extents from civicSystem's window/glow thickness, fixed flags/signs,
// entrance canopies and steps. Negative scale describes the school entry
// inside its U; min-size and placement do not branch on building names.
export const CIVIC_RENDER_ENVELOPES: Readonly<Record<string, Envelope>> = {
  school: { width: [{ scale: 0.48, offset: 0.2 }, { scale: 0.42, offset: 2.1 }, { scale: 0, offset: 2.6 }],
    depth: [{ scale: 0.5, offset: 0.2 }, { scale: 0.51, offset: 0 }, { scale: -0.34, offset: 2.4 }] },
  mall: { width: [{ scale: 0.5, offset: 0.2 }, { scale: 0.42, offset: 3 }, { scale: 0.32, offset: 2.925 }],
    depth: [{ scale: 0.5, offset: 2.4 }, { scale: 0.42, offset: 1.95 }] },
  hospital: { width: [{ scale: 0.47, offset: 0.2 }, { scale: 0, offset: 3.9 }],
    depth: [{ scale: 0.22, offset: 2.4 }, { scale: 0.22, offset: 0.39 }, { scale: 0.23, offset: 0.2 }] },
};
const ceilSize = (value: number) => Math.ceil(value * 100) / 100;
const treeRadius = GARDEN_RENDER_GEOMETRY.treeMinimumRadius + GARDEN_RENDER_GEOMETRY.treeRadiusVariation;
export const GARDEN_MINIMUM_SIZE = {
  width: ceilSize(Math.max((treeRadius - GARDEN_RENDER_GEOMETRY.treeRingX * GARDEN_RENDER_GEOMETRY.inset + LAYOUT_ENVELOPE_INSET) / (0.5 - GARDEN_RENDER_GEOMETRY.treeRingX),
    (GARDEN_RENDER_GEOMETRY.flagClothWidth + GARDEN_RENDER_GEOMETRY.flagClothOffset + LAYOUT_ENVELOPE_INSET) / (0.5 - GARDEN_RENDER_GEOMETRY.flagX))),
  depth: ceilSize((treeRadius - GARDEN_RENDER_GEOMETRY.treeRingZ * GARDEN_RENDER_GEOMETRY.inset + LAYOUT_ENVELOPE_INSET) / (0.5 - GARDEN_RENDER_GEOMETRY.treeRingZ)),
};
export const DISTRICT_LANDMARK_RENDER_GEOMETRY = { skirtWidth: 17, skirtDepth: 17 };
export const DISTRICT_LANDMARK_ENVELOPE = { width: DISTRICT_LANDMARK_RENDER_GEOMETRY.skirtWidth + LAYOUT_ENVELOPE_INSET * 2,
  depth: DISTRICT_LANDMARK_RENDER_GEOMETRY.skirtDepth + LAYOUT_ENVELOPE_INSET * 2 };
export function civicMinimumSize(kind: string): { width: number; depth: number } | null {
  const declaration = CIVIC_RENDER_ENVELOPES[kind]; if (!declaration) return null;
  const minimum = (terms: readonly ExtentTerm[]) => ceilSize(Math.max(...terms.map((term) => (term.offset + LAYOUT_ENVELOPE_INSET) / (0.5 - term.scale * CIVIC_RENDER_GEOMETRY.scale))));
  return { width: minimum(declaration.width), depth: minimum(declaration.depth) };
}
export function civicEnvelopeSize(kind: string, width: number, depth: number): { width: number; depth: number } | null {
  const declaration = CIVIC_RENDER_ENVELOPES[kind];
  if (!declaration || ![width, depth].every(Number.isFinite) || width <= 0 || depth <= 0) return null;
  const W = Math.min(width, CIVIC_RENDER_GEOMETRY.maxWidth) * CIVIC_RENDER_GEOMETRY.scale;
  const D = Math.min(depth, CIVIC_RENDER_GEOMETRY.maxDepth) * CIVIC_RENDER_GEOMETRY.scale;
  const extent = (terms: readonly ExtentTerm[], size: number) => 2 * (Math.max(...terms.map((term) => term.scale * size + term.offset)) + LAYOUT_ENVELOPE_INSET);
  return { width: extent(declaration.width, W), depth: extent(declaration.depth, D) };
}
export function gardenFlagPosition(garden: Vec2 & { yaw: number; width: number; depth: number }): Vec2 {
  const c = Math.cos(garden.yaw), s = Math.sin(garden.yaw), x = garden.width * GARDEN_RENDER_GEOMETRY.flagX, z = garden.depth * GARDEN_RENDER_GEOMETRY.flagZ;
  return { x: garden.x + c * x + s * z, z: garden.z - s * x + c * z };
}
