type Cell = { x: number; y: number };
export type PerformanceAttack = "melee" | "shoot" | "charge" | "pierce" | "repair" | "smash" | "sweep";
export type MechaPerformanceEvent = (
  | { kind: "move" | "knockback"; actor: string; path: Cell[]; duration: number }
  | { kind: "attack"; actor: string; attack: PerformanceAttack; from: Cell; target: Cell; targetIds: string[]; duration: number }
  | { kind: "monster_displacement"; actor: "boss"; skill: "phase_swap" | "gravity_well"; moves: Array<{ actor: string; from: Cell; to: Cell }>; duration: number }
  | { kind: "neural_link"; actor: "boss"; change: "created" | "broken"; from: Cell; target: Cell; duration: number }
  | { kind: "corrode_field"; actor: "boss"; change: "created" | "expired"; fieldId: string; cell: Cell; duration: number }
  | { kind: "corrode_tick"; actor: string; fieldId: string; cell: Cell; damage: number; duration: number }
  | { kind: "status_cue"; actor: string; source: string; status: "poison" | "burn" | "freeze" | "stun"; change: "applied" | "refreshed" | "advanced" | "damage" | "expired" | "removed"; remainingTurns?: number; cell: Cell; duration: number }
  | { kind: "raider_spawn"; actor: string; at: Cell; hp: number; duration: number }
  | { kind: "raider_remove"; actor: string; at: Cell; hp: number; reason: "death" | "expired"; duration: number }
  | { kind: "death"; actor: string; at: Cell; duration: number }
) & { /** Index in the committed rule log, when derived from one. */ sourceLogIndex?: number };
