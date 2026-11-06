import { inb, type Cell, type MatchState, type MechId } from "./board";
import { reproject } from "./combat";

/** A forecast describes the current declaration, never a confirmed status hit. */
export type StatusForecast = {
  skill: "spore_leap" | "ring_pierce" | "prism_frost" | "gravity_well";
  cells: Cell[];
  pulls: Array<{ mech: MechId; from: Cell; to: Cell | null; collision: Cell | null }> | null;
};

/** The authority keeps the declaration fixed; recompute its projection on a clone
 * so committed moves cannot leave stale warnings or retarget the skill. */
export function projectStatusForecastState(state: MatchState): MatchState | null {
  try {
    const projected = structuredClone(state);
    if (projected.statusEncounter && projected.boss.hp > 0 && projected.boss.intent) reproject(projected);
    return projected;
  } catch { return null; }
}

export function statusForecast(state: MatchState): StatusForecast | null {
  const intent = state.boss.intent;
  if (!state.statusEncounter || state.boss.hp <= 0 || !intent || intent.status === "void" ||
      !(["spore_leap", "ring_pierce", "prism_frost", "gravity_well"] as string[]).includes(intent.skillId)) return null;
  const cells = intent.projected.filter(inb).map(cell => ({ ...cell }));
  const skill = intent.skillId as StatusForecast["skill"];
  if (skill !== "gravity_well") return { skill, cells, pulls: null };
  const projection = intent.displacementProjection;
  if (!projection) return { skill, cells, pulls: null };
  const pulls: NonNullable<StatusForecast["pulls"]> = [];
  for (const effect of projection.effects) {
    const mech = state.mechs.find(unit => unit.hp > 0 && effect.entityId === `mech:${unit.id}` && effect.from && unit.pos.x === effect.from.x && unit.pos.y === effect.from.y);
    if (!mech || !effect.from) continue;
    pulls.push({ mech: mech.id, from: { ...effect.from }, to: effect.status === "move" && effect.to ? { ...effect.to } : null,
      collision: effect.status === "void" && effect.collision ? { ...effect.collision.cell } : null });
  }
  return { skill, cells, pulls };
}
