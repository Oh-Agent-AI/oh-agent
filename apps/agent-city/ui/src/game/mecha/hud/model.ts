import type { Action, Cell, MechId, Phase } from "../board";

export type MechaHudPhase = "deployment" | "planning" | "resolving" | "finished";
export type MechaHudStatus = { icon: string; label: string };
export type MechaHudRosterEntry = {
  id: MechId;
  hp: number;
  maxHp: number | null;
  selected: boolean;
  statuses: MechaHudStatus[];
  rights: { move: boolean; action: boolean };
};
export type MechaHudActionRow = { kind: Action["kind"]; label: string; enabled: boolean };
export type MechaHudTarget = { id: string; label: string; cells: Cell[] };
export type MechaHudPreview = { status: "ready" | "invalid" | "unavailable"; damage: Array<{ target: string; before: number; after: number }> };
export type MechaHudReplay = { step: number; total: number };

/** Serializable presentation contract. All legality and combat facts are projected by the active rules adapter. */
export type MechaHudModel = {
  mode: "classic" | "sequential";
  label: string;
  phase: MechaHudPhase;
  sourcePhase: Phase;
  round: number;
  objective: { goal: string; buildings: Array<{ id: string; hp: number; maxHp: number }>; forecast: string | null };
  threats: Array<{ actor: string; cells: Cell[]; order?: number }>;
  roster: MechaHudRosterEntry[];
  selected: { id: MechId; actions: MechaHudActionRow[]; targets: MechaHudTarget[]; preview: MechaHudPreview | null };
  replay: MechaHudReplay | null;
  notices: Array<{ kind: "error" | "status" | "info"; text: string }>;
};

/** Stable interaction port shared by the classic and sequential HUD adapters. */
export type MechaHudActions = {
  select(id: MechId): void;
  moveTo(cell: Cell): void;
  chooseAction(kind: Action["kind"]): void;
  pickTarget(index: number): void;
  confirmAction(): void;
  undoMove(): void;
  resetTurn(): void;
  endTurn(): void;
  confirmEndTurn(unused: boolean): void;
};

export type MechaHudProjection = {
  label: string;
  displayMatch?: import("../board").MatchState;
  selected?: MechId;
  round?: number;
  deployment?: boolean;
  sourcePhase?: Phase;
  objective: MechaHudModel["objective"];
  threats: MechaHudModel["threats"];
  roster: Array<Pick<MechaHudRosterEntry, "id" | "maxHp" | "statuses" | "rights">>;
  actions: MechaHudActionRow[];
  targets: MechaHudTarget[];
  preview: MechaHudPreview | null;
  replay: MechaHudReplay | null;
  notices: MechaHudModel["notices"];
};
