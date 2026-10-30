type Cell = { x: number; y: number };
export type PerformanceAttack = "melee" | "shoot" | "charge" | "pierce" | "repair" | "smash" | "sweep";
export type MechaPerformanceEvent =
  | { kind: "move" | "knockback"; actor: string; path: Cell[]; duration: number }
  | { kind: "attack"; actor: string; attack: PerformanceAttack; from: Cell; target: Cell; targetIds: string[]; duration: number }
  | { kind: "death"; actor: string; at: Cell; duration: number };
