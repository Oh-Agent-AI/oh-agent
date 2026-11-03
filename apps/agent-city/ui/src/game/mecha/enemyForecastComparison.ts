import type { MechaPreview } from "./controller";
import type { Cell, TurnEvent } from "./rules";

type Attack = Extract<TurnEvent, { type: "enemy" }>;
export type EnemyForecastChange = {
  actor: string;
  kind: "stopped" | "started" | "changed";
  beforeCount: number;
  afterCount: number;
  beforeSkills: Attack["skill"][];
  afterSkills: Attack["skill"][];
  beforeCells: Cell[];
  afterCells: Cell[];
};
export type EnemyForecastComparison = { status: "unknown" } | { status: "ready"; changes: EnemyForecastChange[] };

const cellKey = (cell: Cell) => `${cell.x},${cell.y}`;
const cellsOf = (attacks: readonly Attack[]) => {
  const cells = new Map<string, Cell>();
  for (const attack of attacks) for (const cell of attack.cells) cells.set(cellKey(cell), { ...cell });
  return [...cells.values()].sort((a, b) => a.x - b.x || a.y - b.y);
};
// Compare a multiset: an actor may attack multiple times and ordering of cells
// within an attack does not represent a different footprint. Global execution
// order and damage are deliberately outside the claim made by this comparison.
const signature = (attacks: readonly Attack[]) => attacks.map(attack => JSON.stringify([
  attack.skill, [...new Set(attack.cells.map(cellKey))].sort(),
])).sort().join("|");

/** Compares actual whole-turn executions, never causal attribution or declarations. */
export function compareEnemyForecasts(before: MechaPreview | null, after: MechaPreview | null): EnemyForecastComparison {
  if (!before?.ok || !after?.ok || before.revision !== after.revision || before.draftVersion !== after.draftVersion) return { status: "unknown" };
  const group = (attacks: readonly Attack[]) => {
    const result = new Map<string, Attack[]>();
    for (const attack of attacks) result.set(attack.actor, [...(result.get(attack.actor) ?? []), attack]);
    return result;
  };
  const old = group(before.enemyOrder), next = group(after.enemyOrder);
  const actors = [...new Set([...old.keys(), ...next.keys()])].sort();
  const changes: EnemyForecastChange[] = [];
  for (const actor of actors) {
    const a = old.get(actor) ?? [], b = next.get(actor) ?? [];
    if (signature(a) === signature(b)) continue;
    changes.push({ actor, kind: !b.length ? "stopped" : !a.length ? "started" : "changed", beforeCount: a.length, afterCount: b.length, beforeSkills: a.map(event => event.skill).sort(), afterSkills: b.map(event => event.skill).sort(), beforeCells: cellsOf(a), afterCells: cellsOf(b) });
  }
  return { status: "ready", changes };
}
