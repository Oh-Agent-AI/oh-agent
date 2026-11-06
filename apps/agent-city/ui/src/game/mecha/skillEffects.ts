/** Small, explicit effect chain for existing PvE melee skills.
 * Authority adapters own mutations, collision rules and event emission.
 */
import type { Action, Cell, TurnEvent } from "./board";

export type MeleeSkill = Extract<Action, { kind: "melee" | "charge" }>["kind"];
export type MeleeEffect = Readonly<{ kind: "strike"; bonus: number }> | Readonly<{ kind: "push_living_boss" }>;
const meleeEffects: Readonly<Record<MeleeSkill, readonly MeleeEffect[]>> = {
  melee: [{ kind: "strike", bonus: 0 }, { kind: "push_living_boss" }],
  charge: [{ kind: "strike", bonus: 2 }, { kind: "push_living_boss" }],
};

export function executeMeleeEffects(skill: MeleeSkill, target: string, effects: {
  strike(bonus: number): void;
  bossAlive(): boolean;
  pushBoss(): void;
}): void {
  for (const effect of meleeEffects[skill]) {
    if (effect.kind === "strike") effects.strike(effect.bonus);
    else if (target === "boss" && effects.bossAlive()) effects.pushBoss();
  }
}

/** Decode a committed shove once for all projections; unknown origin stays unknown. */
export function projectShove(event: Extract<TurnEvent, { type: "shove" }>, origin: Cell | undefined): {
  status: "moved" | "blocked" | "unknown"; from: Cell | null; to: Cell | null;
} {
  if (!origin) return { status: "unknown", from: null, to: null };
  const from = { ...origin };
  return event.hit
    ? { status: "blocked", from, to: { ...from } }
    : { status: "moved", from, to: { x: from.x + event.dir.x, y: from.y + event.dir.y } };
}

/** Shared presentation projection of committed movement effects.
 * Special movements must first pass presentation evidence validation at the caller.
 * A phase swap remains one group so consumers cannot accidentally serialize it.
 */
export type MovementEffectProjection = {
  mode: "shove" | "phase_swap" | "gravity_well";
  moves: Array<{ actor: string; status: "moved" | "blocked" | "unknown"; from: Cell | null; to: Cell | null }>;
};
export function projectMovementEffect(
  event: Extract<TurnEvent, { type: "shove" | "monster_displacement" }>, origin?: Cell,
): MovementEffectProjection {
  if (event.type === "shove") {
    return { mode: "shove", moves: [{ actor: event.unit, ...projectShove(event, origin) }] };
  }
  return { mode: event.skill, moves: event.moves.map(move => ({
    actor: move.unit.startsWith("mech:") ? move.unit.slice(5) : move.unit,
    status: "moved" as const, from: { ...move.from }, to: { ...move.to },
  })) };
}

/** Shared numeric health effects; authority retains targeting and shield policies. */
export function applyDamage(hp: number, amount: number): number {
  return Math.max(0, hp - amount);
}
export function applyHealing(hp: number, amount: number, maxHp: number): number {
  return Math.min(maxHp, hp + amount);
}

/** Pure proposed collision result. The caller must supply only building cells
 * newly entered by the displaced footprint. This does not mutate MatchState or
 * change the v1.4 rules; a versioned authority must commit and emit it.
 */
export function projectBuildingCollision(
  cells: readonly Cell[], buildings: readonly { id: string; cells: readonly Cell[]; hp: number }[], amount: number,
): Array<{ id: string; before: number; after: number }> {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("invalid_collision_damage");
  const impacted = new Set(cells.map(cell => `${cell.x},${cell.y}`));
  const seen = new Set<string>();
  const result: Array<{ id: string; before: number; after: number }> = [];
  for (const building of buildings) {
    if (!building.id || seen.has(building.id) || !Number.isSafeInteger(building.hp) || building.hp < 0) throw new Error("invalid_collision_building");
    seen.add(building.id);
    if (building.hp === 0 || !building.cells.some(cell => impacted.has(`${cell.x},${cell.y}`))) continue;
    result.push({ id: building.id, before: building.hp, after: applyDamage(building.hp, amount) });
  }
  return result;
}
