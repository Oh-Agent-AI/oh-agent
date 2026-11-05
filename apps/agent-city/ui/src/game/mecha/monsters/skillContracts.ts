import type { MonsterContentVersion, MonsterSkillId } from "./contracts";

/** JSON-shaped type only: runtime code must still validate numbers and input values. */
export type SkillData = null | boolean | number | string | readonly SkillData[] | { readonly [key: string]: SkillData };
export type SkillReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer U)[] ? readonly SkillReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: SkillReadonly<T[K]> }
  : T;
export type SkillCell = Readonly<{ x: number; y: number }>;
export type SkillTargetBinding =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "entity"; entityId: string }>
  | Readonly<{ kind: "cell"; cell: SkillCell }>;

/** Original declared identity and binding remain separate from a changing projection. */
export type PreparedSkillIntent<Id extends MonsterSkillId, Data extends SkillData> = Readonly<{
  skillId: Id;
  contentVersion: MonsterContentVersion;
  actorId: string;
  target: SkillTargetBinding;
  declaredCells: readonly SkillCell[];
  data: SkillReadonly<Data>;
}>;
export type SkillPrepareResult<Id extends MonsterSkillId, Data extends SkillData> =
  | Readonly<{ status: "planned"; intent: PreparedSkillIntent<Id, Data> }>
  | Readonly<{ status: "void"; reason: string }>;
export type SkillProjection<Data extends SkillData> =
  | Readonly<{ status: "reprojected"; projectedCells: readonly SkillCell[]; data: SkillReadonly<Data> }>
  | Readonly<{ status: "void"; projectedCells: readonly []; reason: string; data: SkillReadonly<Data> }>;
export type SkillResolution<Change extends SkillData, Event extends SkillData> =
  | Readonly<{ status: "resolved"; changes: readonly SkillReadonly<Change>[]; events: readonly SkillReadonly<Event>[] }>
  | Readonly<{ status: "void"; reason: string; changes: readonly []; events: readonly SkillReadonly<Event>[] }>;

/**
 * Future rule-handler shape only; no handlers or execution are registered here.
 * prepare must be deterministic and independent of wall time, DOM and random sources;
 * reproject must preserve the prepared binding; resolve must not call presentation.
 * The same resolve implementation must be used for preview and actual execution.
 * Implementations still need runtime validation, bounded effects, terminal checks,
 * deterministic event ordering and tests: TypeScript cannot enforce those properties.
 */
export type MonsterSkillHandler<
  Id extends MonsterSkillId, State, IntentData extends SkillData, ProjectionData extends SkillData,
  Change extends SkillData, Event extends SkillData,
> = Readonly<{
  prepare: (state: SkillReadonly<State>, actorId: string) => SkillPrepareResult<Id, IntentData>;
  reproject: (state: SkillReadonly<State>, intent: PreparedSkillIntent<Id, IntentData>) => SkillProjection<ProjectionData>;
  resolve: (state: SkillReadonly<State>, intent: PreparedSkillIntent<Id, IntentData>, projection: SkillProjection<ProjectionData>) => SkillResolution<Change, Event>;
}>;
