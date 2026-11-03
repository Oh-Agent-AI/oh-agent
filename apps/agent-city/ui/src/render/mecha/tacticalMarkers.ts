import * as THREE from "three";

export const TACTICAL_COLORS = {
  declared: "#ff7066", projected: "#92e6ff", reach: "#75dc9b",
  move: "#82e5af", attack: "#ff7668", outline: "#fff4d2", shove: "#fff5b4",
} as const;

/** Arrow rims and cores must share a render queue. An opaque core is drawn
 * before its transparent rim regardless of renderOrder, letting the rim hide it.
 * Tactical colours are UI evidence, not surfaces affected by city fog/exposure. */
export function tacticalMarkerMaterial(color: string, opacity = 1, depthTest = true): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, opacity, transparent: true, forceSinglePass: true,
    depthTest, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
  });
}

/** Keep enemy arrowheads near six CSS pixels at a fitted perspective view.
 * The cell cap prevents a very distant/small board becoming a blanket of arrows.
 * shoveGeo's head spans .84 times its transverse scale. */
export function tacticalAttackWidths(worldPerPixel: number, cellSpan: number): readonly [number, number] {
  const pixel = Number.isFinite(worldPerPixel) && worldPerPixel > 0 ? worldPerPixel : 1;
  const span = Number.isFinite(cellSpan) && cellSpan > 0 ? cellSpan : 20;
  const core = Math.min(span * .4, Math.max(4.1, 6 * pixel / .84));
  const outline = Math.min(span * .5, Math.max(5.4, core + 2 * pixel / .84));
  return [outline, core];
}

/** Presentation-only insets along a true attack ray. Rectangular tile/footprint
 * extents are evaluated in board-local coordinates, independent of city yaw.
 * Leave a readable head on adjacent targets; never move or invent a target. */
export function tacticalAttackTrims(length: number, dx: number, dy: number, cellW: number, cellD: number, footprint = 1): readonly [number, number] {
  if (![length, dx, dy, cellW, cellD, footprint].every(Number.isFinite)
    || length <= 0 || cellW <= 0 || cellD <= 0 || footprint <= 0) return [0, 0];
  const localLength = Math.hypot(dx * cellW, dy * cellD);
  if (!Number.isFinite(localLength) || !localLength) return [0, 0];
  const ux = Math.abs(dx * cellW / localLength), uy = Math.abs(dy * cellD / localLength);
  const rim = Math.min(ux ? cellW / ux : Infinity, uy ? cellD / uy : Infinity);
  const start = rim * footprint * .40, end = rim * .24;
  if (!Number.isFinite(start + end)) return [0, 0];
  const scale = Math.min(1, length * .65 / (start + end));
  return [start * scale, end * scale];
}
