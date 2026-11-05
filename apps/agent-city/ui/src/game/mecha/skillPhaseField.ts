/**
 * Provisional, local-only L9/L10 rules. This module is NOT connected to MatchState,
 * enemy planning, presentation, replay or remote play. All inputs and outputs are
 * plain data; the host remains responsible for turn/outcome and atomic commits.
 */
export type PhaseFieldCell = { x: number; y: number };
export type PhaseFieldUnit = { id: string; cell: PhaseFieldCell; width: 1 | 2; height: 1 | 2; hp: number };
export type PhaseFieldWorld = {
  version: 1; width: number; height: number; round: number;
  /** True only after deployment and before an outcome, as determined by the host. */
  active: boolean; phaseId: string; actorId: string; blocked: PhaseFieldCell[]; units: PhaseFieldUnit[];
};
export type Core = { id: string; cell: PhaseFieldCell; alive: boolean };
export type CoreMigrationState = PhaseFieldWorld & {
  maxHp: number; cores: Core[]; currentCoreId: string; skills: string[]; migratedIds: string[];
};
export type CoreMigrationRequest = {
  skillId: "core_migration"; migrationId: string; threshold: number; targetCoreId: string;
  nextPhaseId: string; nextSkills: string[];
};
export type CoreMigrationIntent = {
  version: 1; skillId: "core_migration"; round: number; actorId: string; actorCell: PhaseFieldCell;
  phaseId: string; sourceCoreId: string; sourceCoreCell: PhaseFieldCell; targetCoreId: string;
  targetCoreCell: PhaseFieldCell; migrationId: string; threshold: number; maxHp: number;
  previousSkills: string[]; nextPhaseId: string; nextSkills: string[];
};
export type FoldPair = { from: PhaseFieldCell; to: PhaseFieldCell };
export type FoldMove = { unitId: string; from: PhaseFieldCell; to: PhaseFieldCell; width: 1 | 2; height: 1 | 2 };
export type SpaceFoldState = PhaseFieldWorld & { resolvedFoldIds: string[] };
export type SpaceFoldRequest = { skillId: "space_fold"; actionId: string; mapping: FoldPair[] };
export type SpaceFoldIntent = {
  version: 1; skillId: "space_fold"; round: number; actorId: string; actorCell: PhaseFieldCell;
  phaseId: string; actionId: string; mapping: FoldPair[]; moves: FoldMove[];
};
export type PhaseFieldPrepare<I> = { status: "planned"; intent: I } | { status: "void"; reason: string };
export type CoreProjection = { status: "reprojected"; fromCoreId: string; toCoreId: string; fromPhaseId: string; toPhaseId: string; nextSkills: string[] } | { status: "void"; reason: string };
export type FoldProjection = { status: "reprojected"; mapping: FoldPair[]; moves: FoldMove[] } | { status: "void"; reason: string };
export type CoreEvent = { type: "core_migrated"; migrationId: string; fromCoreId: string; toCoreId: string; fromPhaseId: string; toPhaseId: string; skills: string[] };
export type FoldEvent =
  | { type: "space_fold_applied"; actionId: string; mapping: FoldPair[] }
  | { type: "space_fold_move"; actionId: string; unitId: string; from: PhaseFieldCell; to: PhaseFieldCell };
export type PhaseFieldResolution<S, E> = { status: "resolved"; state: S; events: E[] } | { status: "void"; reason: string; state: S; events: [] };

// Provisional safety limits, not balancing values. Mapping is a closed permutation:
// terrain does not move; only whole live unit footprints are translated atomically.
export const PHASE_FIELD_MAX_MAPPING = 64;
const MAX_UNITS = 256, MAX_HISTORY = 256, MAX_CORES = 16, MAX_SKILLS = 16;
const int = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
const id = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(s);
const validCell = (c: PhaseFieldCell): boolean => !!c && int(c.x, 0, 127) && int(c.y, 0, 127);
const key = (c: PhaseFieldCell): string => `${c.x},${c.y}`;
const sameCell = (a: PhaseFieldCell, b: PhaseFieldCell): boolean => a.x === b.x && a.y === b.y;
const cloneCell = (c: PhaseFieldCell): PhaseFieldCell => ({ x: c.x, y: c.y });
const compareCell = (a: PhaseFieldCell, b: PhaseFieldCell): number => a.y - b.y || a.x - b.x;
const inside = (s: PhaseFieldWorld, c: PhaseFieldCell): boolean => validCell(c) && c.x < s.width && c.y < s.height;
const validIds = (v: string[], max: number, allowEmpty = true): boolean => Array.isArray(v) && v.length <= max && (allowEmpty || v.length > 0) && Array.from(v).every(id) && new Set(v).size === v.length;
const footprint = (u: PhaseFieldUnit): PhaseFieldCell[] => {
  const cells: PhaseFieldCell[] = [];
  for (let y = 0; y < u.height; y++) for (let x = 0; x < u.width; x++) cells.push({ x: u.cell.x + x, y: u.cell.y + y });
  return cells;
};
function validWorld(s: PhaseFieldWorld): boolean {
  if (!s || s.version !== 1 || !int(s.width, 1, 128) || !int(s.height, 1, 128) ||
      !int(s.round, 0, 1000000) || typeof s.active !== "boolean" || !id(s.phaseId) || !id(s.actorId) ||
      !Array.isArray(s.blocked) || s.blocked.length > 16384 || !Array.isArray(s.units) || s.units.length > MAX_UNITS) return false;
  const blocked = new Set<string>(), occupied = new Set<string>(), ids = new Set<string>();
  for (const p of s.blocked) { if (!inside(s, p) || blocked.has(key(p))) return false; blocked.add(key(p)); }
  for (const u of s.units) {
    if (!u || !id(u.id) || ids.has(u.id) || !inside(s, u.cell) || !int(u.width, 1, 2) || !int(u.height, 1, 2) || !int(u.hp, 0, 1000000)) return false;
    ids.add(u.id);
    if (u.id === s.actorId && (u.width !== 2 || u.height !== 2)) return false;
    for (const p of footprint(u)) {
      if (!inside(s, p)) return false;
      if (u.hp > 0) { if (occupied.has(key(p)) || blocked.has(key(p))) return false; occupied.add(key(p)); }
    }
  }
  return true;
}
function validCoreState(s: CoreMigrationState): boolean {
  if (!validWorld(s) || !int(s.maxHp, 2, 1000000) || !validIds(s.skills, MAX_SKILLS, false) ||
      !validIds(s.migratedIds, MAX_HISTORY) || !id(s.currentCoreId) || !Array.isArray(s.cores) || s.cores.length < 2 || s.cores.length > MAX_CORES) return false;
  const actor = s.units.find(u => u.id === s.actorId);
  if (!actor || actor.hp > s.maxHp) return false;
  const ids = new Set<string>(), positions = new Set<string>();
  for (const core of s.cores) {
    // Cores are declared positions within the same existing boss footprint, not new units.
    if (!core || !id(core.id) || ids.has(core.id) || !inside(s, core.cell) || positions.has(key(core.cell)) ||
        typeof core.alive !== "boolean" || !footprint(actor).some(p => sameCell(p, core.cell))) return false;
    ids.add(core.id); positions.add(key(core.cell));
  }
  return ids.has(s.currentCoreId);
}
function validFoldState(s: SpaceFoldState): boolean { return validWorld(s) && validIds(s.resolvedFoldIds, MAX_HISTORY); }
function mappingValid(s: PhaseFieldWorld, pairs: FoldPair[]): boolean {
  if (!Array.isArray(pairs) || pairs.length < 2 || pairs.length > PHASE_FIELD_MAX_MAPPING) return false;
  const from = new Set<string>(), to = new Set<string>();
  for (const p of pairs) {
    if (!p || !inside(s, p.from) || !inside(s, p.to) || from.has(key(p.from)) || to.has(key(p.to))) return false;
    from.add(key(p.from)); to.add(key(p.to));
  }
  return [...from].every(k => to.has(k));
}
const canonicalMapping = (pairs: FoldPair[]): FoldPair[] => pairs.map(p => ({ from: cloneCell(p.from), to: cloneCell(p.to) })).sort((a, b) => compareCell(a.from, b.from));
function sameIds(a: string[], b: string[]): boolean { return a.length === b.length && a.every((v, i) => v === b[i]); }
function sameMoves(a: FoldMove[], b: FoldMove[]): boolean {
  return a.length === b.length && a.every((m, i) => { const n = b[i]; return !!n && validCell(n.from) && validCell(n.to) && m.unitId === n.unitId && m.width === n.width && m.height === n.height && sameCell(m.from, n.from) && sameCell(m.to, n.to); });
}
function cloneWorld<S extends PhaseFieldWorld>(s: S): S {
  return { ...s, blocked: s.blocked.map(cloneCell), units: s.units.map(u => ({ ...u, cell: cloneCell(u.cell) })) };
}
function liveActor(s: PhaseFieldWorld): PhaseFieldUnit | undefined { return s.units.find(u => u.id === s.actorId && u.hp > 0); }
const fail = (reason: string): { status: "void"; reason: string } => ({ status: "void", reason });

/** Declare before crossing the absolute HP threshold; HP equal to threshold triggers. */
export function prepareCoreMigration(s: CoreMigrationState, r: CoreMigrationRequest): PhaseFieldPrepare<CoreMigrationIntent> {
  if (!validCoreState(s)) return fail("invalid_state");
  if (!s.active) return fail("inactive");
  const actor = liveActor(s);
  if (!actor) return fail("actor_unavailable");
  if (!r || r.skillId !== "core_migration" || !id(r.migrationId) || !id(r.targetCoreId) || !id(r.nextPhaseId) ||
      !validIds(r.nextSkills, MAX_SKILLS, false) || !int(r.threshold, 1, s.maxHp - 1)) return fail("invalid_request");
  if (s.migratedIds.includes(r.migrationId)) return fail("already_resolved");
  if (r.nextPhaseId === s.phaseId) return fail("invalid_request");
  if (s.migratedIds.length >= MAX_HISTORY) return fail("history_full");
  if (actor.hp <= r.threshold) return fail("threshold_already_reached");
  const source = s.cores.find(c => c.id === s.currentCoreId), target = s.cores.find(c => c.id === r.targetCoreId);
  if (!source?.alive) return fail("source_unavailable");
  if (!target?.alive || source.id === target.id) return fail("target_unavailable");
  return { status: "planned", intent: { version: 1, skillId: r.skillId, round: s.round, actorId: s.actorId,
    actorCell: cloneCell(actor.cell), phaseId: s.phaseId, sourceCoreId: source.id, sourceCoreCell: cloneCell(source.cell),
    targetCoreId: target.id, targetCoreCell: cloneCell(target.cell), migrationId: r.migrationId, threshold: r.threshold,
    maxHp: s.maxHp, previousSkills: [...s.skills], nextPhaseId: r.nextPhaseId, nextSkills: [...r.nextSkills] } };
}
function validCoreIntent(i: CoreMigrationIntent): boolean {
  return !!i && i.version === 1 && i.skillId === "core_migration" && int(i.round, 0, 1000000) && id(i.actorId) && validCell(i.actorCell) &&
    id(i.phaseId) && id(i.sourceCoreId) && validCell(i.sourceCoreCell) && id(i.targetCoreId) && validCell(i.targetCoreCell) &&
    i.sourceCoreId !== i.targetCoreId && id(i.migrationId) && int(i.maxHp, 2, 1000000) && int(i.threshold, 1, i.maxHp - 1) &&
    id(i.nextPhaseId) && i.nextPhaseId !== i.phaseId && validIds(i.previousSkills, MAX_SKILLS, false) && validIds(i.nextSkills, MAX_SKILLS, false);
}
export function reprojectCoreMigration(s: CoreMigrationState, i: CoreMigrationIntent): CoreProjection {
  if (!validCoreState(s)) return fail("invalid_state");
  if (!validCoreIntent(i)) return fail("invalid_intent");
  if (!s.active) return fail("inactive");
  if (s.migratedIds.includes(i.migrationId)) return fail("already_resolved");
  if (s.migratedIds.length >= MAX_HISTORY) return fail("history_full");
  if (s.round !== i.round) return fail("round_changed");
  if (s.phaseId !== i.phaseId || s.currentCoreId !== i.sourceCoreId || !sameIds(s.skills, i.previousSkills) || s.maxHp !== i.maxHp) return fail("phase_changed");
  const actor = liveActor(s);
  if (!actor || s.actorId !== i.actorId) return fail("actor_unavailable");
  if (!sameCell(actor.cell, i.actorCell)) return fail("actor_changed");
  const source = s.cores.find(c => c.id === i.sourceCoreId), target = s.cores.find(c => c.id === i.targetCoreId);
  if (!source?.alive) return fail("source_unavailable");
  if (!target?.alive) return fail("target_unavailable");
  if (!sameCell(source.cell, i.sourceCoreCell) || !sameCell(target.cell, i.targetCoreCell)) return fail("target_changed");
  if (actor.hp > i.threshold) return fail("threshold_not_reached");
  return { status: "reprojected", fromCoreId: source.id, toCoreId: target.id, fromPhaseId: s.phaseId, toPhaseId: i.nextPhaseId, nextSkills: [...i.nextSkills] };
}
/** Optional expected projection is a stale-preview guard, not a substitute for host revision checks. */
export function resolveCoreMigration(s: CoreMigrationState, i: CoreMigrationIntent, expected?: CoreProjection): PhaseFieldResolution<CoreMigrationState, CoreEvent> {
  const p = reprojectCoreMigration(s, i);
  if (p.status === "void") return { ...p, state: s, events: [] };
  if (expected !== undefined && (!expected || expected.status !== "reprojected" || expected.fromCoreId !== p.fromCoreId || expected.toCoreId !== p.toCoreId ||
      expected.fromPhaseId !== p.fromPhaseId || expected.toPhaseId !== p.toPhaseId || !Array.isArray(expected.nextSkills) || !sameIds(expected.nextSkills, p.nextSkills))) return { ...fail("stale_projection"), state: s, events: [] };
  const state = { ...cloneWorld(s), cores: s.cores.map(c => ({ ...c, cell: cloneCell(c.cell) })), phaseId: p.toPhaseId, currentCoreId: p.toCoreId, skills: [...p.nextSkills], migratedIds: [...s.migratedIds, i.migrationId] };
  return { status: "resolved", state, events: [{ type: "core_migrated", migrationId: i.migrationId, fromCoreId: p.fromCoreId, toCoreId: p.toCoreId, fromPhaseId: p.fromPhaseId, toPhaseId: p.toPhaseId, skills: [...p.nextSkills] }] };
}

// Mapping changes occupancy, not terrain. Each affected footprint must be wholly
// mapped and preserve shape under one translation; all movement is simultaneous.
function calculateMoves(s: SpaceFoldState, mapping: FoldPair[]): { moves: FoldMove[] } | { reason: string } {
  const bySource = new Map(mapping.map(p => [key(p.from), p.to]));
  const order = new Map(mapping.map((p, index) => [key(p.from), index]));
  const moves: Array<FoldMove & { order: number }> = [];
  for (const u of s.units) {
    if (u.hp <= 0) continue;
    const cells = footprint(u), touched = cells.filter(c => bySource.has(key(c)));
    if (!touched.length) continue;
    if (touched.length !== cells.length) return { reason: "partial_footprint" };
    const destination = bySource.get(key(u.cell))!;
    const dx = destination.x - u.cell.x, dy = destination.y - u.cell.y;
    if (cells.some(c => { const to = bySource.get(key(c))!; return to.x !== c.x + dx || to.y !== c.y + dy; })) return { reason: "distorted_footprint" };
    if (cells.some(c => s.blocked.some(b => b.x === c.x + dx && b.y === c.y + dy))) return { reason: "blocked_destination" };
    moves.push({ unitId: u.id, from: cloneCell(u.cell), to: cloneCell(destination), width: u.width, height: u.height,
      order: Math.min(...cells.map(c => order.get(key(c))!)) });
  }
  moves.sort((a, b) => a.order - b.order || (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
  return { moves: moves.map(({ order: _order, ...move }) => move) };
}
export function prepareSpaceFold(s: SpaceFoldState, r: SpaceFoldRequest): PhaseFieldPrepare<SpaceFoldIntent> {
  if (!validFoldState(s)) return fail("invalid_state");
  if (!s.active) return fail("inactive");
  const actor = liveActor(s);
  if (!actor) return fail("actor_unavailable");
  if (!r || r.skillId !== "space_fold" || !id(r.actionId) || !mappingValid(s, r.mapping)) return fail("invalid_mapping");
  if (s.resolvedFoldIds.includes(r.actionId)) return fail("already_resolved");
  if (s.resolvedFoldIds.length >= MAX_HISTORY) return fail("history_full");
  const mapping = canonicalMapping(r.mapping), result = calculateMoves(s, mapping);
  if ("reason" in result) return fail(result.reason);
  return { status: "planned", intent: { version: 1, skillId: r.skillId, round: s.round, actorId: s.actorId,
    actorCell: cloneCell(actor.cell), phaseId: s.phaseId, actionId: r.actionId, mapping, moves: result.moves } };
}
function validFoldIntent(s: SpaceFoldState, i: SpaceFoldIntent): boolean {
  if (!i || i.version !== 1 || i.skillId !== "space_fold" || !int(i.round, 0, 1000000) || !id(i.actorId) ||
      !validCell(i.actorCell) || !id(i.phaseId) || !id(i.actionId) || !mappingValid(s, i.mapping) || !Array.isArray(i.moves) || i.moves.length > MAX_UNITS) return false;
  if (i.mapping.some((p, n) => n > 0 && compareCell(i.mapping[n - 1]!.from, p.from) >= 0)) return false;
  const ids = new Set<string>();
  for (const m of i.moves) {
    if (!m || !id(m.unitId) || ids.has(m.unitId) || !inside(s, m.from) || !inside(s, m.to) || !int(m.width, 1, 2) || !int(m.height, 1, 2)) return false;
    ids.add(m.unitId);
  }
  return true;
}
export function reprojectSpaceFold(s: SpaceFoldState, i: SpaceFoldIntent): FoldProjection {
  if (!validFoldState(s)) return fail("invalid_state");
  if (!validFoldIntent(s, i)) return fail("invalid_intent");
  if (!s.active) return fail("inactive");
  if (s.resolvedFoldIds.includes(i.actionId)) return fail("already_resolved");
  if (s.resolvedFoldIds.length >= MAX_HISTORY) return fail("history_full");
  if (s.round !== i.round) return fail("round_changed");
  if (s.phaseId !== i.phaseId) return fail("phase_changed");
  const actor = liveActor(s);
  if (!actor || s.actorId !== i.actorId) return fail("actor_unavailable");
  if (!sameCell(actor.cell, i.actorCell)) return fail("actor_changed");
  const result = calculateMoves(s, i.mapping);
  if ("reason" in result) return fail(result.reason);
  if (!sameMoves(result.moves, i.moves)) return fail("target_changed");
  return { status: "reprojected", mapping: canonicalMapping(i.mapping), moves: result.moves };
}
function sameMapping(a: FoldPair[], b: FoldPair[]): boolean {
  return a.length === b.length && a.every((p, n) => !!b[n] && validCell(b[n]!.from) && validCell(b[n]!.to) && sameCell(p.from, b[n]!.from) && sameCell(p.to, b[n]!.to));
}
export function resolveSpaceFold(s: SpaceFoldState, i: SpaceFoldIntent, expected?: FoldProjection): PhaseFieldResolution<SpaceFoldState, FoldEvent> {
  const p = reprojectSpaceFold(s, i);
  if (p.status === "void") return { ...p, state: s, events: [] };
  if (expected !== undefined && (!expected || expected.status !== "reprojected" || !Array.isArray(expected.mapping) || !Array.isArray(expected.moves) ||
      !sameMapping(p.mapping, expected.mapping) || !sameMoves(p.moves, expected.moves))) return { ...fail("stale_projection"), state: s, events: [] };
  const destinations = new Map(p.moves.map(m => [m.unitId, m.to]));
  const units = s.units.map(u => ({ ...u, cell: cloneCell(destinations.get(u.id) ?? u.cell) }));
  return { status: "resolved", state: { ...cloneWorld(s), units, resolvedFoldIds: [...s.resolvedFoldIds, i.actionId] },
    events: [{ type: "space_fold_applied", actionId: i.actionId, mapping: canonicalMapping(p.mapping) },
      ...p.moves.filter(m => !sameCell(m.from, m.to)).map(m => ({ type: "space_fold_move" as const, actionId: i.actionId, unitId: m.unitId, from: cloneCell(m.from), to: cloneCell(m.to) }))] };
}

/* Integration is deliberately NOT complete:
 * - Version and persist phase/skills/cores and one-shot IDs in authoritative state,
 *   snapshots and replay; host must authenticate declarations and allocate unique IDs.
 * - Supply active only after deployment and before outcome; map all impassable
 *   terrain, buildings, reservations and protected cells into blocked, all live
 *   footprints into units, and enforce host-specific map/connectivity restrictions.
 * - Declarations expire at a round boundary. Re-declare an untriggered threshold
 *   before it is reached in a later round; a late declaration is rejected.
 * - Declare at enemy_prepare, expose threshold, target, skills, affected cells,
 *   mapping and order in UI. Choose the exact host damage/phase boundary; never
 *   resurrect a dead actor or bypass host victory. Threshold is absolute HP, not %.
 * - Reproject after player effects, then use this SAME resolver for preview and
 *   actual under an authoritative revision check. Atomically apply returned state
 *   and ordered events; migrate skill IDs only through the host's fixed registry.
 * - Add AI, event presentation, full match/replay tests and independently gate both
 *   species. Remote remains disabled until explicit version/protocol validation.
 */
