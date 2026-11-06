import { CAR_DIMENSIONS } from "../carDimensions";
/** Conservative full steering-wheel envelope, not just the unsteered body width. */
export const DRIVING_FOOTPRINT = Object.freeze({
  halfLength: CAR_DIMENSIONS.length / 2,
  halfWidth: Math.max(CAR_DIMENSIONS.width / 2, CAR_DIMENSIONS.track / 2 + Math.hypot(CAR_DIMENSIONS.wheelRadius, CAR_DIMENSIONS.wheelWidth / 2)),
  wheelbase: CAR_DIMENSIONS.wheelbase, track: CAR_DIMENSIONS.track,
});
/** Horizontal collision inset in gameplay only; audits retain the full collider. */
export const GAMEPLAY_COLLISION_INSET = 0.12;

/** Slightly forgiving footprint for manual play. The audited footprint above
 * retains the complete tire steering envelope and its stricter clearance.
 * 边界层脚印与固体碰撞体对齐（两侧各缩 GAMEPLAY_COLLISION_INSET）：此前边界 hull
 * （1.45×0.75）反而大于碰撞体（1.28×0.58）——人行道缘石线比建筑更早触发拦停，
 * 「蹭到一点就停」的体感来源之一（2026-10-18 游玩档手感修正）。 */
export const GAMEPLAY_DRIVING_FOOTPRINT = Object.freeze({
  halfLength: CAR_DIMENSIONS.length / 2 - GAMEPLAY_COLLISION_INSET,
  halfWidth: CAR_DIMENSIONS.width / 2 - GAMEPLAY_COLLISION_INSET,
  wheelbase: CAR_DIMENSIONS.wheelbase, track: CAR_DIMENSIONS.track,
});
