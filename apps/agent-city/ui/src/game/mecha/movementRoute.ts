/** Convert a validated cell route to scene positions without silently inventing heights. */
import { BOARD, type Cell } from "./board";
import { cellWorld, type CityMechaSite } from "./citySite";
import type { MovementPoint } from "./movementStage";

export function movementWaypoints(site: CityMechaSite, cells: readonly Cell[]): MovementPoint[] | null {
  if (!cells.length || ![site.originX, site.originZ, site.yaw, site.cellW, site.cellD].every(Number.isFinite) || site.cellW <= 0 || site.cellD <= 0) return null;
  const points: MovementPoint[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y) || cell.x < 0 || cell.y < 0 || cell.x >= BOARD || cell.y >= BOARD) return null;
    if (i && Math.abs(cell.x - cells[i-1]!.x) + Math.abs(cell.y - cells[i-1]!.y) !== 1) return null;
    if (!Number.isFinite(site.heights[cell.y]?.[cell.x])) return null;
    const point = cellWorld(site, cell);
    if (![point.x, point.y, point.z].every(Number.isFinite)) return null;
    points.push(point);
  }
  return points;
}
