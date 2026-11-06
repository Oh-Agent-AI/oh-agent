import { BOARD, type AssaultTerrainSafety, type Cell } from "./board";
import { cellWorld, type CityMechaSite } from "./citySite";

type TerrainHeight = (x: number, z: number) => number;

export function sampleAssaultTerrainSafety(
  site: CityMechaSite, height: TerrainHeight, radius: number, maxGrade: number, spacing: number,
): AssaultTerrainSafety {
  if (![radius, maxGrade, spacing].every(Number.isFinite) || radius <= 0 || maxGrade < 0 || spacing <= 0) throw new Error("invalid Assault terrain safety parameters");
  const safe = (x: number, z: number) => {
    const values = [height(x - radius, z), height(x + radius, z), height(x, z - radius), height(x, z + radius)];
    if (!values.every(Number.isFinite)) throw new Error("invalid Assault terrain height");
    return Math.hypot((values[1]! - values[0]!) / (2 * radius), (values[3]! - values[2]!) / (2 * radius)) <= maxGrade;
  };
  const unsafeCells: Cell[] = [], unsafeEdges: Array<{ from: Cell; to: Cell }> = [];
  for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
    const from = { x, y }, a = cellWorld(site, from);
    if (!safe(a.x, a.z)) unsafeCells.push(from);
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
      const to = { x: x + dx!, y: y + dy! };
      if (to.x < 0 || to.x >= BOARD || to.y >= BOARD) continue;
      const b = cellWorld(site, to);
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / spacing));
      let valid = true;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        if (!safe(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) { valid = false; break; }
      }
      if (!valid) unsafeEdges.push({ from, to });
    }
  }
  return { unsafeCells, unsafeEdges };
}
