/** Non-authoritative local test fixture. Never expose these states to remote or live play. */
import {
  BOARD, MAX_TURNS, STEP_DIRS, assaultTerrainBlocked, enemiesRemain, eq, footprint, inb, key,
  living, livingStakeBuildings, noSpawn, stakeBuildings, water,
  type Cell, type MatchState, type Outcome, type PresentationUnit, type Raider,
} from "../src/game/mecha/board.ts";
import {
  prepareSwarmLink, reprojectSwarmLink, resolveSwarmLink, reconcileSwarmLink,
  type SwarmIntent, type SwarmLinkState, type SwarmProjection,
} from "../src/game/mecha/skillSwarmLink.ts";

/**
 * Gated L5 host adapter. This is NOT an enabled monster or a TurnEvent producer:
 * the caller must integrate its immutable results into the turn, presentation and
 * replay contracts before exposing L5. Only trusted local match snapshots are
 * accepted; this is not a parser for untrusted saved or remote data.
 */
export type SwarmBattle = {
  version: 1;
  match: MatchState;
  nextSpawnId: number;
  resolvedActions: string[];
  pending: { origin: Cell; intent: SwarmIntent } | null;
};
export type SwarmBattleEvent =
  | { type: "raider_spawn"; unit: PresentationUnit }
  | { type: "summon_skipped"; cell: Cell; reason: string }
  | { type: "raider_remove"; unit: PresentationUnit; reason: "death" | "expired" }
  | { type: "outcome"; outcome: Outcome };
export type SwarmBattleResult =
  | { status: "resolved"; battle: SwarmBattle; events: SwarmBattleEvent[] }
  | { status: "void"; reason: string; battle: SwarmBattle; events: [] };

const SWARM_MAX_SPAWN = 2, SWARM_CAP = 4, SWARM_HP = 2, SWARM_LIFETIME = 2;

/** Eight orthogonal perimeter cells in stable row-major order, including off-board cells. */
function swarmCandidates(origin: Cell): Cell[] {
  const cells: Cell[] = [];
  for (let y = origin.y - 1; y <= origin.y + 2; y++) for (let x = origin.x - 1; x <= origin.x + 2; x++) {
    if ((x >= origin.x && x <= origin.x + 1 && (y === origin.y - 1 || y === origin.y + 2)) ||
        (y >= origin.y && y <= origin.y + 1 && (x === origin.x - 1 || x === origin.x + 2))) cells.push({ x, y });
  }
  return cells;
}

/** Reserve the swarm namespace before a match; the adapter does not authorize L5. */
export function createSwarmBattle(match: MatchState): SwarmBattle {
  if (match.outcome || match.phase === "finished" || match.mission || match.monsterContent ||
      match.raiders.some(r => r.summon || r.id.startsWith("swarm:"))) throw new Error("swarm_adapter_unavailable");
  return { version: 1, match: structuredClone(match), nextSpawnId: 0, resolvedActions: [], pending: null };
}

/** Enforce fixed host rules; the generic primitive deliberately does not authenticate requests. */
function validSwarmBattle(battle: SwarmBattle): boolean {
  if (!battle || battle.version !== 1 || !battle.match || battle.match.mission || battle.match.monsterContent ||
      !Number.isSafeInteger(battle.match.turn) || battle.match.turn < 1 || battle.match.turn > 1000000 ||
      !Number.isSafeInteger(battle.nextSpawnId) || battle.nextSpawnId < 0 || battle.nextSpawnId > 1000000000 ||
      !Array.isArray(battle.resolvedActions) || battle.resolvedActions.length > 256 ||
      battle.resolvedActions.some(id => typeof id !== "string" || !/^split:[1-9][0-9]*$/.test(id)) ||
      new Set(battle.resolvedActions).size !== battle.resolvedActions.length || !Array.isArray(battle.match.raiders)) return false;
  for (const raider of battle.match.raiders) {
    if (!raider.summon) { if (raider.id.startsWith("swarm:")) return false; continue; }
    const suffix = /^swarm:(0|[1-9][0-9]*)$/.exec(raider.id);
    if (!suffix || !Number.isSafeInteger(Number(suffix[1])) || Number(suffix[1]) >= battle.nextSpawnId ||
        raider.summon.parentId !== "boss" || raider.summon.speciesId !== "swarm_child" ||
        !Number.isSafeInteger(raider.summon.expiresAtRound) || raider.summon.expiresAtRound < 1) return false;
  }
  if (!battle.pending) return battle.pending === null;
  const { origin, intent } = battle.pending;
  if (!origin || !Number.isInteger(origin.x) || !Number.isInteger(origin.y) || !inb(origin) ||
      !intent || intent.version !== 1 || intent.round !== battle.match.turn || !intent.request) return false;
  const request = intent.request;
  return request.skillId === "split_swarm" && request.actionId === `split:${intent.round}` && request.actorId === "boss" &&
    request.speciesId === "swarm_child" && request.maxSpawn === SWARM_MAX_SPAWN && request.summonCap === SWARM_CAP &&
    request.spawnRange === 1 && request.hp === SWARM_HP && request.lifetime === SWARM_LIFETIME &&
    Array.isArray(request.candidates) && JSON.stringify(request.candidates) === JSON.stringify(swarmCandidates(origin));
}

function swarmWorld(battle: SwarmBattle, additionallyBlocked: Cell[] = []): SwarmLinkState {
  const s = battle.match, blocked: Cell[] = [];
  for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
    const c = { x, y };
    if (noSpawn(s, c) || s.obstacles.some(v => eq(v, c)) || s.covers.some(v => eq(v, c)) ||
        s.buildings.some(b => b.cells.some(v => eq(v, c))) ||
        s.deployment?.zone.some(v => eq(v, c)) || s.deployment?.reservedCells.some(v => eq(v, c)) ||
        s.assaultTerrainSafety?.unsafeCells.some(v => eq(v, c)) || additionallyBlocked.some(v => eq(v, c))) blocked.push(c);
  }
  return { version: 1, width: BOARD, height: BOARD, round: s.turn, finished: !!s.outcome || s.phase === "finished",
    blocked, links: [], nextSpawnId: battle.nextSpawnId, nextLinkId: 0, resolvedActions: [...battle.resolvedActions],
    units: [
      { id: "boss", side: "enemy", cell: { ...s.boss.anchor }, width: 2, height: 2, hp: s.boss.hp },
      ...s.mechs.filter(m => m.hp > 0).map(m => ({ id: `mech:${m.id}`, side: "player", cell: { ...m.pos }, width: 1, height: 1, hp: m.hp })),
      ...s.raiders.filter(r => r.hp > 0 || r.summon).map(r => ({ id: r.id, side: "enemy", cell: { ...r.pos }, width: 1, height: 1, hp: r.hp,
        ...(r.summon ? { summon: { ...r.summon } } : {}) })),
    ] };
}

/** Preserve existing walkable components and access to buildings/at least one exit for each mech.
 * Evaluate the whole accepted set, not each spawn against the initial board alone. */
function swarmPreservesPaths(s: MatchState, births: Cell[]): boolean {
  const occupied = new Set<string>();
  if (s.boss.hp > 0) for (const c of footprint(s.boss.anchor)) occupied.add(key(c));
  for (const r of s.raiders) if (r.hp > 0) occupied.add(key(r.pos));
  const removed = new Set(births.map(key));
  const passable = (c: Cell, after: boolean) => inb(c) && !water(s, c) && !occupied.has(key(c)) &&
    !s.obstacles.some(v => eq(v, c)) && !s.covers.some(v => eq(v, c)) &&
    !s.buildings.some(b => b.cells.some(v => eq(v, c))) && (!after || !removed.has(key(c)));
  const reach = (start: Cell, after: boolean, assault: boolean): Set<string> => {
    const seen = new Set<string>();
    if (!passable(start, after)) return seen;
    const queue = [start]; seen.add(key(start));
    for (let i = 0; i < queue.length; i++) for (const dir of STEP_DIRS) {
      const from = queue[i]!, to = { x: from.x + dir.x, y: from.y + dir.y }, k = key(to);
      if (seen.has(k) || !passable(to, after) || (assault && assaultTerrainBlocked(s, from, to))) continue;
      seen.add(k); queue.push(to);
    }
    return seen;
  };
  // Protect every existing connected component, including unoccupied corridors.
  const seen = new Set<string>();
  for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
    const c = { x, y }, k = key(c);
    if (!passable(c, false) || seen.has(k)) continue;
    const before = reach(c, false, false);
    for (const p of before) seen.add(p);
    const survivors = [...before].filter(p => !removed.has(p));
    if (survivors.length) {
      const [x0, y0] = survivors[0]!.split(",").map(Number);
      const after = reach({ x: x0!, y: y0! }, true, false);
      if (survivors.some(p => !after.has(p))) return false;
    }
  }
  for (const m of living(s)) {
    const before = reach(m.pos, false, m.id === "Assault"), after = reach(m.pos, true, m.id === "Assault");
    if ([...before].some(p => !removed.has(p) && !after.has(p)) || (before.size > 1 && after.size <= 1)) return false;
    for (const b of livingStakeBuildings(s)) {
      const perimeter = b.cells.flatMap(c => STEP_DIRS.map(d => ({ x: c.x + d.x, y: c.y + d.y })));
      if (perimeter.some(c => before.has(key(c))) && !perimeter.some(c => after.has(key(c)))) return false;
    }
  }
  return true;
}

/** Use the primitive repeatedly until ordered births jointly satisfy host path policy. */
function swarmProjection(battle: SwarmBattle): { projection: SwarmProjection; world: SwarmLinkState; protectedCells: Cell[] } {
  const protectedCells: Cell[] = [];
  for (;;) {
    const world = swarmWorld(battle, protectedCells);
    const projection = reprojectSwarmLink(world, battle.pending!.intent);
    if (projection.status === "void" || projection.skillId !== "split_swarm") return { projection, world, protectedCells };
    const accepted: Cell[] = [];
    let rejected: Cell | undefined;
    for (const slot of projection.slots) if (slot.unit) {
      if (!swarmPreservesPaths(battle.match, [...accepted, slot.cell])) { rejected = slot.cell; break; }
      accepted.push(slot.cell);
    }
    if (!rejected) return { projection, world, protectedCells };
    protectedCells.push({ ...rejected });
  }
}

function visibleSwarmProjection(result: ReturnType<typeof swarmProjection>): SwarmProjection {
  if (result.projection.status === "void" || result.projection.skillId !== "split_swarm") return result.projection;
  return { ...result.projection, slots: result.projection.slots.map(slot =>
    slot.reason === "blocked" && result.protectedCells.some(c => eq(c, slot.cell)) ? { ...slot, reason: "protected_path" } : slot) };
}

function swarmNeedsReconciliation(battle: SwarmBattle): boolean {
  return battle.match.raiders.some(r => r.summon && (r.hp <= 0 || r.summon.expiresAtRound <= battle.match.turn));
}

export function prepareSwarmBattle(battle: SwarmBattle): SwarmBattleResult {
  if (!validSwarmBattle(battle)) return { status: "void", reason: "invalid_state", battle, events: [] };
  if (battle.pending) return { status: "void", reason: "pending_intent", battle, events: [] };
  if (swarmNeedsReconciliation(battle)) return { status: "void", reason: "reconciliation_required", battle, events: [] };
  const origin = { ...battle.match.boss.anchor };
  const prepared = prepareSwarmLink(swarmWorld(battle), { skillId: "split_swarm", actionId: `split:${battle.match.turn}`,
    actorId: "boss", speciesId: "swarm_child", candidates: swarmCandidates(origin), maxSpawn: SWARM_MAX_SPAWN,
    summonCap: SWARM_CAP, spawnRange: 1, hp: SWARM_HP, lifetime: SWARM_LIFETIME });
  if (prepared.status === "void") return { status: "void", reason: prepared.reason, battle, events: [] };
  const next = structuredClone(battle); next.pending = { origin, intent: prepared.intent };
  return { status: "resolved", battle: next, events: [] };
}

export function reprojectSwarmBattle(battle: SwarmBattle): SwarmProjection {
  if (!validSwarmBattle(battle)) return { status: "void", reason: "invalid_state" };
  if (!battle.pending) return { status: "void", reason: "no_intent" };
  if (swarmNeedsReconciliation(battle)) return { status: "void", reason: "reconciliation_required" };
  return visibleSwarmProjection(swarmProjection(battle));
}

// JSON object property order is not part of the projection contract; array order is.
function sameSwarmProjection(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((value, index) => sameSwarmProjection(value, b[index]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left).sort(), other = Object.keys(right).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && sameSwarmProjection(left[key], right[key]));
}

export function resolveSwarmBattle(battle: SwarmBattle, expected?: SwarmProjection): SwarmBattleResult {
  if (!validSwarmBattle(battle)) return { status: "void", reason: "invalid_state", battle, events: [] };
  if (!battle.pending) return { status: "void", reason: "no_intent", battle, events: [] };
  if (swarmNeedsReconciliation(battle)) return { status: "void", reason: "reconciliation_required", battle, events: [] };
  const computed = swarmProjection(battle), preview = visibleSwarmProjection(computed);
  if (preview.status === "void") return { status: "void", reason: preview.reason, battle, events: [] };
  if (expected !== undefined && !sameSwarmProjection(expected, preview)) return { status: "void", reason: "stale_projection", battle, events: [] };
  const resolved = resolveSwarmLink(computed.world, battle.pending.intent, computed.projection);
  if (resolved.status === "void") return { status: "void", reason: resolved.reason, battle, events: [] };
  const next = structuredClone(battle), events: SwarmBattleEvent[] = [];
  next.pending = null; next.nextSpawnId = resolved.state.nextSpawnId; next.resolvedActions = resolved.state.resolvedActions;
  for (const effect of resolved.events) {
    if (effect.type === "summon_spawned") {
      const u = effect.unit;
      const child: Raider = { id: u.id, pos: { ...u.cell }, hp: u.hp, intent: null,
        summon: { parentId: "boss", speciesId: "swarm_child", expiresAtRound: u.summon!.expiresAtRound } };
      next.match.raiders.push(child);
      events.push({ type: "raider_spawn", unit: { id: child.id, pos: { ...child.pos }, hp: child.hp } });
    } else if (effect.type === "summon_skipped") {
      const reason = computed.protectedCells.some(c => eq(c, effect.cell)) && effect.reason === "blocked" ? "protected_path" : effect.reason;
      events.push({ type: "summon_skipped", cell: { ...effect.cell }, reason });
    }
  }
  return { status: "resolved", battle: next, events };
}

/** A dead caster cannot retarget or retry its already bound action. */
export function cancelVoidSwarmBattle(battle: SwarmBattle): SwarmBattleResult {
  if (!validSwarmBattle(battle)) return { status: "void", reason: "invalid_state", battle, events: [] };
  if (!battle.pending) return { status: "void", reason: "no_intent", battle, events: [] };
  const projection = reprojectSwarmBattle(battle);
  if (projection.status !== "void" || projection.reason !== "actor_dead") {
    return { status: "void", reason: "intent_not_cancelable", battle, events: [] };
  }
  const next = structuredClone(battle);
  next.resolvedActions.push(next.pending!.intent.request.actionId);
  next.pending = null;
  return { status: "resolved", battle: next, events: [] };
}

/** Explicit cleanup immediately after each health effect; call before checking victory. */
export function reconcileSwarmBattle(battle: SwarmBattle): SwarmBattleResult {
  if (!validSwarmBattle(battle)) return { status: "void", reason: "invalid_state", battle, events: [] };
  const result = reconcileSwarmLink(swarmWorld(battle));
  if (result.status === "void") return { status: "void", reason: result.reason, battle, events: [] };
  const next = structuredClone(battle), events: SwarmBattleEvent[] = [];
  for (const effect of result.events) if (effect.type === "summon_removed") {
    const index = next.match.raiders.findIndex(r => r.id === effect.unitId && r.summon);
    if (index < 0) return { status: "void", reason: "invalid_state", battle, events: [] };
    const r = next.match.raiders[index]!;
    events.push({ type: "raider_remove", unit: { id: r.id, pos: { ...r.pos }, hp: r.hp }, reason: effect.reason });
    next.match.raiders.splice(index, 1);
  }
  // Match the non-mission combat outcome precedence after lifecycle cleanup.
  // This adapter does not run combat's finish-time status/presentation cleanup.
  const outcome: Outcome | null = !enemiesRemain(next.match) ? "victory" :
    living(next.match).length === 0 ? "defeat_wipe" :
    stakeBuildings(next.match).length > 0 && livingStakeBuildings(next.match).length === 0 ? "defeat_buildings" : null;
  if (outcome) {
    next.match.outcome = outcome; next.match.phase = "finished"; next.pending = null;
    events.push({ type: "outcome", outcome });
  }
  return { status: "resolved", battle: next, events };
}

/** Advance once at the enemy-round boundary, before preparing the next intent. */
export function advanceSwarmBattle(battle: SwarmBattle): SwarmBattleResult {
  if (!validSwarmBattle(battle)) return { status: "void", reason: "invalid_state", battle, events: [] };
  if (battle.match.outcome || battle.match.phase === "finished") return { status: "void", reason: "finished", battle, events: [] };
  if (battle.pending) return { status: "void", reason: "pending_intent", battle, events: [] };
  if (swarmNeedsReconciliation(battle)) {
    return { status: "void", reason: "reconciliation_required", battle, events: [] };
  }
  if (battle.match.turn >= MAX_TURNS) return { status: "void", reason: "round_limit", battle, events: [] };
  const next = structuredClone(battle); next.match.turn += 1;
  return reconcileSwarmBattle(next);
}
