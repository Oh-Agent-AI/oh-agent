/**
 * Standalone L9 rules only: no match, board, replay, UI, or remote integration.
 * All records are bounded JSON data. The host must retain the original binding
 * returned by prepare separately from any untrusted intent/projection, provide
 * the correct active/round/HP facts, and revision-check and atomically commit
 * state and events. It also enforces any board, deployment and outcome rules.
 * A plain binding is not a signature and cannot authenticate itself. The host
 * must ensure stable, non-recycled core IDs and trustworthy one-shot history.
 * Phases are one-shot: a previously migrated-from phase cannot be a destination.
 * Skill IDs are data only; the host must authorize the declared skill group.
 */
export type MigrationCell = { x: number; y: number };
export type MigrationCore = { id: string; cell: MigrationCell; alive: boolean };
export type MigrationRecord = { id: string; phaseId: string };
export type MigrationState = {
  version: 1; round: number; active: boolean; actorId: string; hp: number; maxHp: number;
  phaseId: string; currentCoreId: string; cores: MigrationCore[]; skills: string[];
  migrations: MigrationRecord[];
};
export type MigrationRequest = {
  skillId: "core_migration"; migrationId: string; threshold: number;
  targetCoreId: string; nextPhaseId: string; nextSkills: string[];
};
export type MigrationIntent = {
  version: 1; skillId: "core_migration"; round: number; actorId: string; phaseId: string;
  sourceCoreId: string; sourceCoreCell: MigrationCell; targetCoreId: string; targetCoreCell: MigrationCell;
  migrationId: string; threshold: number; maxHp: number; declaredHp: number;
  previousSkills: string[]; nextPhaseId: string; nextSkills: string[];
};
/** Binding and intent have the same wire shape, but must be stored independently. */
export type MigrationBinding = MigrationIntent;
export type MigrationProjection = { status: "reprojected"; intent: MigrationIntent; hp: number };
export type MigrationEvent =
  | { type: "core_migrated"; migrationId: string; fromCoreId: string; toCoreId: string }
  | { type: "phase_changed"; migrationId: string; fromPhaseId: string; toPhaseId: string }
  | { type: "skills_changed"; migrationId: string; previousSkills: string[]; nextSkills: string[] };
export type MigrationVoid = { status: "void"; reason: string };
export type MigrationPrepare = { status: "planned"; binding: MigrationBinding; intent: MigrationIntent } | MigrationVoid;
export type MigrationReprojection = MigrationProjection | MigrationVoid;
export type MigrationResolution = { status: "resolved"; state: MigrationState; events: MigrationEvent[] } | MigrationVoid;

// Safety bounds, not balance tuning. Phase IDs and migration IDs are never evicted.
export const CORE_MIGRATION_MAX_CORES = 16;
export const CORE_MIGRATION_MAX_SKILLS = 16;
export const CORE_MIGRATION_MAX_HISTORY = 256;
const MAX_NUMBER = 1_000_000;
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= min && v <= max;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(v);
const fail = (reason: string): MigrationVoid => ({ status: "void", reason });

// Reject extra, missing, non-JSON, inherited, accessor and sparse fields rather
// than silently accepting data that would change on a JSON round trip.
function object(v: unknown, fields: readonly string[]): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(v);
  if (keys.length !== fields.length || keys.some(k => typeof k !== "string" || !fields.includes(k))) return false;
  return fields.every(k => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    return !!d && d.enumerable && "value" in d;
  });
}
function array(v: unknown, min: number, max: number): v is unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length < min || v.length > max ||
      Reflect.ownKeys(v).length !== v.length + 1) return false;
  for (let n = 0; n < v.length; n++) {
    const d = Object.getOwnPropertyDescriptor(v, String(n));
    if (!d || !d.enumerable || !("value" in d)) return false;
  }
  return true;
}
function ids(v: unknown, min: number, max: number): v is string[] {
  return array(v, min, max) && v.every(id) && new Set(v).size === v.length;
}
function cell(v: unknown): v is MigrationCell {
  if (!object(v, ["x", "y"])) return false;
  const c = v as MigrationCell;
  return integer(c.x, 0, 127) && integer(c.y, 0, 127);
}
const sameCell = (a: MigrationCell, b: MigrationCell): boolean => a.x === b.x && a.y === b.y;
const sameIds = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, n) => v === b[n]);
const copyCell = (c: MigrationCell): MigrationCell => ({ x: c.x, y: c.y });
const copyIntent = (i: MigrationIntent): MigrationIntent => ({ ...i, sourceCoreCell: copyCell(i.sourceCoreCell),
  targetCoreCell: copyCell(i.targetCoreCell), previousSkills: [...i.previousSkills], nextSkills: [...i.nextSkills] });

function validState(s: MigrationState): boolean {
  if (!object(s, ["version", "round", "active", "actorId", "hp", "maxHp", "phaseId", "currentCoreId", "cores", "skills", "migrations"]) ||
      s.version !== 1 || !integer(s.round, 0, MAX_NUMBER) || typeof s.active !== "boolean" || !id(s.actorId) ||
      !integer(s.maxHp, 2, MAX_NUMBER) || !integer(s.hp, 0, s.maxHp) || !id(s.phaseId) || !id(s.currentCoreId) ||
      !ids(s.skills, 1, CORE_MIGRATION_MAX_SKILLS) || !array(s.cores, 1, CORE_MIGRATION_MAX_CORES) ||
      !array(s.migrations, 0, CORE_MIGRATION_MAX_HISTORY)) return false;
  const coreIds = new Set<string>(), positions = new Set<string>();
  for (const c of s.cores) {
    if (!object(c, ["id", "cell", "alive"]) || !id(c.id) || !cell(c.cell) || typeof c.alive !== "boolean" ||
        coreIds.has(c.id) || positions.has(`${c.cell.x},${c.cell.y}`)) return false;
    coreIds.add(c.id); positions.add(`${c.cell.x},${c.cell.y}`);
  }
  if (!coreIds.has(s.currentCoreId)) return false;
  const actionIds = new Set<string>(), phases = new Set<string>();
  for (const m of s.migrations) {
    if (!object(m, ["id", "phaseId"]) || !id(m.id) || !id(m.phaseId) || actionIds.has(m.id) || phases.has(m.phaseId)) return false;
    actionIds.add(m.id); phases.add(m.phaseId);
  }
  return true;
}
function validRequest(r: MigrationRequest, maxHp: number): boolean {
  return object(r, ["skillId", "migrationId", "threshold", "targetCoreId", "nextPhaseId", "nextSkills"]) &&
    r.skillId === "core_migration" && id(r.migrationId) && integer(r.threshold, 1, maxHp - 1) &&
    id(r.targetCoreId) && id(r.nextPhaseId) && ids(r.nextSkills, 1, CORE_MIGRATION_MAX_SKILLS);
}
function validIntent(i: MigrationIntent): boolean {
  return object(i, ["version", "skillId", "round", "actorId", "phaseId", "sourceCoreId", "sourceCoreCell", "targetCoreId", "targetCoreCell",
    "migrationId", "threshold", "maxHp", "declaredHp", "previousSkills", "nextPhaseId", "nextSkills"]) &&
    i.version === 1 && i.skillId === "core_migration" && integer(i.round, 0, MAX_NUMBER) && id(i.actorId) && id(i.phaseId) &&
    id(i.sourceCoreId) && cell(i.sourceCoreCell) && id(i.targetCoreId) && cell(i.targetCoreCell) &&
    i.sourceCoreId !== i.targetCoreId && !sameCell(i.sourceCoreCell, i.targetCoreCell) && id(i.migrationId) &&
    integer(i.maxHp, 2, MAX_NUMBER) && integer(i.threshold, 1, i.maxHp - 1) && integer(i.declaredHp, i.threshold + 1, i.maxHp) &&
    ids(i.previousSkills, 1, CORE_MIGRATION_MAX_SKILLS) && id(i.nextPhaseId) && i.nextPhaseId !== i.phaseId &&
    ids(i.nextSkills, 1, CORE_MIGRATION_MAX_SKILLS);
}
function sameIntent(a: MigrationIntent, b: MigrationIntent): boolean {
  return a.version === b.version && a.skillId === b.skillId && a.round === b.round && a.actorId === b.actorId &&
    a.phaseId === b.phaseId && a.sourceCoreId === b.sourceCoreId && sameCell(a.sourceCoreCell, b.sourceCoreCell) &&
    a.targetCoreId === b.targetCoreId && sameCell(a.targetCoreCell, b.targetCoreCell) && a.migrationId === b.migrationId &&
    a.threshold === b.threshold && a.maxHp === b.maxHp && a.declaredHp === b.declaredHp &&
    sameIds(a.previousSkills, b.previousSkills) && a.nextPhaseId === b.nextPhaseId && sameIds(a.nextSkills, b.nextSkills);
}

/** Declare strictly above the absolute HP threshold, in the current round. */
export function prepareCoreMigration(state: MigrationState, request: MigrationRequest): MigrationPrepare {
  if (!validState(state)) return fail("invalid_state");
  if (!state.active) return fail("inactive");
  if (state.hp === 0) return fail("actor_unavailable");
  if (!validRequest(request, state.maxHp) || request.nextPhaseId === state.phaseId) return fail("invalid_request");
  if (state.migrations.some(m => m.id === request.migrationId)) return fail("already_resolved");
  if (state.migrations.some(m => m.phaseId === state.phaseId)) return fail("phase_already_migrated");
  if (state.migrations.some(m => m.phaseId === request.nextPhaseId)) return fail("target_phase_already_migrated");
  if (state.migrations.length >= CORE_MIGRATION_MAX_HISTORY) return fail("history_full");
  if (state.hp <= request.threshold) return fail("threshold_already_reached");
  const source = state.cores.find(c => c.id === state.currentCoreId);
  const target = state.cores.find(c => c.id === request.targetCoreId);
  if (!source?.alive) return fail("source_unavailable");
  if (!target?.alive || target.id === source.id) return fail("target_unavailable");
  const intent: MigrationIntent = { version: 1, skillId: "core_migration", round: state.round, actorId: state.actorId,
    phaseId: state.phaseId, sourceCoreId: source.id, sourceCoreCell: copyCell(source.cell), targetCoreId: target.id,
    targetCoreCell: copyCell(target.cell), migrationId: request.migrationId, threshold: request.threshold,
    maxHp: state.maxHp, declaredHp: state.hp, previousSkills: [...state.skills], nextPhaseId: request.nextPhaseId,
    nextSkills: [...request.nextSkills] };
  return { status: "planned", binding: copyIntent(intent), intent };
}

/** Recheck the exact binding; a missing, dead, moved or replaced target is never reselected. */
export function reprojectCoreMigration(state: MigrationState, binding: MigrationBinding, intent: MigrationIntent): MigrationReprojection {
  if (!validState(state)) return fail("invalid_state");
  if (!validIntent(binding)) return fail("invalid_binding");
  if (!validIntent(intent)) return fail("invalid_intent");
  if (!sameIntent(binding, intent)) return fail("intent_changed");
  if (!state.active) return fail("inactive");
  if (state.migrations.some(m => m.id === binding.migrationId)) return fail("already_resolved");
  if (state.migrations.some(m => m.phaseId === binding.phaseId)) return fail("phase_already_migrated");
  if (state.migrations.some(m => m.phaseId === binding.nextPhaseId)) return fail("target_phase_already_migrated");
  if (state.migrations.length >= CORE_MIGRATION_MAX_HISTORY) return fail("history_full");
  if (state.round !== binding.round) return fail("round_changed");
  if (state.phaseId !== binding.phaseId || state.currentCoreId !== binding.sourceCoreId || state.maxHp !== binding.maxHp ||
      !sameIds(state.skills, binding.previousSkills)) return fail("phase_changed");
  if (state.actorId !== binding.actorId || state.hp === 0) return fail("actor_unavailable");
  const source = state.cores.find(c => c.id === binding.sourceCoreId);
  const target = state.cores.find(c => c.id === binding.targetCoreId);
  if (!source?.alive) return fail("source_unavailable");
  if (!sameCell(source.cell, binding.sourceCoreCell)) return fail("source_changed");
  if (!target?.alive) return fail("target_unavailable");
  if (!sameCell(target.cell, binding.targetCoreCell)) return fail("target_changed");
  if (state.hp > binding.threshold) return fail("threshold_not_reached");
  return { status: "reprojected", intent: copyIntent(binding), hp: state.hp };
}

/**
 * Require the earlier projection and exact HP to still match. The three events
 * are ordered core, phase, skills; state and events are one atomic result.
 * The threshold fires at 0 < HP <= threshold, never on actor death.
 */
export function resolveCoreMigration(
  state: MigrationState, binding: MigrationBinding, intent: MigrationIntent, expected: MigrationProjection,
): MigrationResolution {
  const projection = reprojectCoreMigration(state, binding, intent);
  if (projection.status === "void") return projection;
  if (!object(expected, ["status", "intent", "hp"]) || expected.status !== "reprojected" ||
      !validIntent(expected.intent) || !sameIntent(projection.intent, expected.intent) || expected.hp !== projection.hp) return fail("stale_projection");
  return { status: "resolved", state: { version: 1, round: state.round, active: state.active, actorId: state.actorId,
    hp: state.hp, maxHp: state.maxHp, phaseId: binding.nextPhaseId, currentCoreId: binding.targetCoreId,
    cores: state.cores.map(c => ({ id: c.id, cell: copyCell(c.cell), alive: c.alive })), skills: [...binding.nextSkills],
    migrations: [...state.migrations.map(m => ({ id: m.id, phaseId: m.phaseId })), { id: binding.migrationId, phaseId: binding.phaseId }] },
    events: [
      { type: "core_migrated", migrationId: binding.migrationId, fromCoreId: binding.sourceCoreId, toCoreId: binding.targetCoreId },
      { type: "phase_changed", migrationId: binding.migrationId, fromPhaseId: binding.phaseId, toPhaseId: binding.nextPhaseId },
      { type: "skills_changed", migrationId: binding.migrationId, previousSkills: [...binding.previousSkills], nextSkills: [...binding.nextSkills] },
    ] };
}
