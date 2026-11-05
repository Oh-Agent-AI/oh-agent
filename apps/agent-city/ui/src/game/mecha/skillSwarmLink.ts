/**
 * Local, versioned L5/L8 rule primitives. No battle or presentation imports.
 * The host owns turn advancement, victory, movement, damage and legal blocked
 * cells. See the integration notes below; these functions do not integrate a skill.
 */
export type SwarmCell = { x: number; y: number };
export type SwarmUnit = {
  id: string; side: string; cell: SwarmCell; width: number; height: number; hp: number;
  summon?: { parentId: string; speciesId: string; expiresAtRound: number };
};
export type NeuralLink = {
  id: string; sourceId: string; targetId: string; range: number;
  attackBonus: number; expiresAtRound: number;
};
export type SwarmLinkState = {
  version: 1; width: number; height: number; round: number; finished: boolean;
  /** Include impassable terrain, buildings, deployment reservations and protected lanes. */
  blocked: SwarmCell[]; units: SwarmUnit[]; links: NeuralLink[];
  nextSpawnId: number; nextLinkId: number; resolvedActions: string[];
};
export type SplitRequest = {
  skillId: "split_swarm"; actionId: string; actorId: string; speciesId: string;
  candidates: SwarmCell[]; maxSpawn: number; summonCap: number;
  spawnRange: number; hp: number; lifetime: number;
};
export type LinkRequest = {
  skillId: "neural_link"; actionId: string; actorId: string; targetId: string;
  range: number; attackBonus: number; lifetime: number;
};
export type SwarmLinkRequest = SplitRequest | LinkRequest;
export type SwarmIntent = { version: 1; round: number; request: SwarmLinkRequest };
export type SpawnSlot = { cell: SwarmCell; reason: string | null; unit: SwarmUnit | null };
export type SwarmProjection =
  | { status: "void"; reason: string }
  | { status: "reprojected"; skillId: "split_swarm"; slots: SpawnSlot[] }
  | { status: "reprojected"; skillId: "neural_link"; linkId: string; sourceId: string; targetId: string; range: number; attackBonus: number; expiresAtRound: number; breakConditions: LinkBreakReason[] };
export type SwarmEvent =
  | { type: "summon_spawned"; unit: SwarmUnit }
  | { type: "summon_skipped"; cell: SwarmCell; reason: string }
  | { type: "summon_removed"; unitId: string; reason: "death" | "expired" }
  | { type: "link_created"; link: NeuralLink }
  | { type: "link_broken"; linkId: string; reason: LinkBreakReason };
// Stable declaration and precedence when multiple break conditions occur together.
export const NEURAL_LINK_BREAK_CONDITIONS = Object.freeze(["source_dead", "target_dead", "side_changed", "expired", "out_of_range"] as const);
export type LinkBreakReason = typeof NEURAL_LINK_BREAK_CONDITIONS[number];
export type SwarmResolution =
  | { status: "void"; reason: string; state: SwarmLinkState; events: [] }
  | { status: "resolved"; state: SwarmLinkState; events: SwarmEvent[] };

// Hard bounds are part of this provisional v1 contract, not balance values.
export const SWARM_HARD_CAP = 12;
export const LINK_HARD_CAP = 12;
const MAX_CANDIDATES = 16, MAX_LIFETIME = 10, MAX_ACTIONS = 256;
const int = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
const id = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 128;
const cell = (c: SwarmCell): boolean => !!c && int(c.x, -1024, 1024) && int(c.y, -1024, 1024);
const eq = (a: SwarmCell, b: SwarmCell): boolean => a.x === b.x && a.y === b.y;
const within = (s: SwarmLinkState, p: SwarmCell): boolean => p.x >= 0 && p.y >= 0 && p.x < s.width && p.y < s.height;
const covers = (u: SwarmUnit, p: SwarmCell): boolean => p.x >= u.cell.x && p.x < u.cell.x + u.width && p.y >= u.cell.y && p.y < u.cell.y + u.height;
// Manhattan distance between the closest cells of two rectangular footprints.
function distance(a: SwarmUnit, b: SwarmUnit): number {
  return Math.max(0, a.cell.x - (b.cell.x + b.width - 1), b.cell.x - (a.cell.x + a.width - 1)) +
    Math.max(0, a.cell.y - (b.cell.y + b.height - 1), b.cell.y - (a.cell.y + a.height - 1));
}
function unitAt(p: SwarmCell): SwarmUnit { return { id: "_", side: "_", cell: p, width: 1, height: 1, hp: 1 }; }
function validState(s: SwarmLinkState): boolean {
  if (!s || s.version !== 1 || !int(s.width, 1, 128) || !int(s.height, 1, 128) ||
      !int(s.round, 0, 1000000) || typeof s.finished !== "boolean" ||
      !int(s.nextSpawnId, 0, 1000000000) || !int(s.nextLinkId, 0, 1000000000) ||
      !Array.isArray(s.blocked) || !Array.isArray(s.units) || !Array.isArray(s.links) || !Array.isArray(s.resolvedActions) ||
      s.units.length > 1024 || s.blocked.length > 16384 || s.links.length > LINK_HARD_CAP || s.resolvedActions.length > MAX_ACTIONS ||
      !Array.from(s.blocked).every(p => cell(p) && within(s, p)) || !Array.from(s.resolvedActions).every(id) ||
      new Set(s.resolvedActions).size !== s.resolvedActions.length) return false;
  const ids = new Set<string>(), occupied = new Set<string>();
  let summons = 0;
  for (const u of s.units) {
    if (!u || !id(u.id) || ids.has(u.id) || !id(u.side) || !cell(u.cell) || !int(u.width, 1, 2) || !int(u.height, 1, 2) ||
        !int(u.hp, 0, 1000000) || !within(s, u.cell) || !within(s, { x: u.cell.x + u.width - 1, y: u.cell.y + u.height - 1 })) return false;
    ids.add(u.id);
    if (Object.prototype.hasOwnProperty.call(u, "summon")) {
      if (!u.summon || typeof u.summon !== "object" || !id(u.summon.parentId) || !id(u.summon.speciesId) || !int(u.summon.expiresAtRound, 0, 1000010) || u.width !== 1 || u.height !== 1) return false;
      if (u.hp > 0) summons++;
    }
    if (u.hp > 0) for (let y = u.cell.y; y < u.cell.y + u.height; y++) for (let x = u.cell.x; x < u.cell.x + u.width; x++) {
      const key = `${x},${y}`;
      if (occupied.has(key)) return false;
      occupied.add(key);
    }
  }
  if (summons > SWARM_HARD_CAP) return false;
  const linkIds = new Set<string>(), targets = new Set<string>();
  for (const l of s.links) {
    if (!l || !id(l.id) || linkIds.has(l.id) || !id(l.sourceId) || !id(l.targetId) || l.sourceId === l.targetId ||
        targets.has(l.targetId) || !int(l.range, 0, 256) || !int(l.attackBonus, 1, 10) || !int(l.expiresAtRound, 0, 1000010)) return false;
    linkIds.add(l.id); targets.add(l.targetId);
  }
  return true;
}
function validRequest(r: SwarmLinkRequest): boolean {
  if (!r || !id(r.actionId) || !id(r.actorId) || !int(r.lifetime, 1, MAX_LIFETIME)) return false;
  if (r.skillId === "split_swarm") return id(r.speciesId) && Array.isArray(r.candidates) && r.candidates.length > 0 && r.candidates.length <= MAX_CANDIDATES &&
    Array.from(r.candidates).every(cell) && new Set(r.candidates.map(p => `${p.x},${p.y}`)).size === r.candidates.length &&
    int(r.maxSpawn, 1, MAX_CANDIDATES) && int(r.summonCap, 1, SWARM_HARD_CAP) && int(r.spawnRange, 0, 256) && int(r.hp, 1, 1000000);
  if (r.skillId === "neural_link") return id(r.targetId) && r.actorId !== r.targetId && int(r.range, 0, 256) && int(r.attackBonus, 1, 10);
  return false;
}
function copyState(s: SwarmLinkState): SwarmLinkState {
  return { ...s, blocked: s.blocked.map(p => ({ ...p })),
    units: s.units.map(u => ({ ...u, cell: { ...u.cell }, ...(u.summon ? { summon: { ...u.summon } } : {}) })),
    links: s.links.map(l => ({ ...l })), resolvedActions: s.resolvedActions.slice() };
}
function copyRequest(r: SwarmLinkRequest): SwarmLinkRequest {
  return r.skillId === "split_swarm" ? { ...r, candidates: r.candidates.map(p => ({ x: p.x, y: p.y })) } : { ...r };
}
function breakReason(s: SwarmLinkState, l: NeuralLink): LinkBreakReason | null {
  const source = s.units.find(u => u.id === l.sourceId), target = s.units.find(u => u.id === l.targetId);
  if (!source || source.hp === 0 || (source.summon && s.round >= source.summon.expiresAtRound)) return "source_dead";
  if (!target || target.hp === 0 || (target.summon && s.round >= target.summon.expiresAtRound)) return "target_dead";
  if (source.side !== target.side) return "side_changed";
  if (s.round >= l.expiresAtRound) return "expired";
  if (distance(source, target) > l.range) return "out_of_range";
  return null;
}
function calculate(s: SwarmLinkState, intent: SwarmIntent): SwarmProjection {
  if (!validState(s)) return { status: "void", reason: "invalid_state" };
  if (!intent || intent.version !== 1 || !validRequest(intent.request) || !int(intent.round, 0, 1000000)) return { status: "void", reason: "invalid_intent" };
  const r = intent.request;
  if (s.finished) return { status: "void", reason: "finished" };
  if (s.round !== intent.round) return { status: "void", reason: "stale_round" };
  if (s.resolvedActions.includes(r.actionId)) return { status: "void", reason: "already_resolved" };
  if (s.resolvedActions.length >= MAX_ACTIONS) return { status: "void", reason: "action_limit" };
  if (s.units.some(u => u.summon && (u.hp === 0 || s.round >= u.summon.expiresAtRound)) ||
      s.links.some(l => breakReason(s, l))) return { status: "void", reason: "reconciliation_required" };
  const actor = s.units.find(u => u.id === r.actorId);
  if (!actor || actor.hp === 0) return { status: "void", reason: "actor_dead" };
  if (r.skillId === "neural_link") {
    const target = s.units.find(u => u.id === r.targetId);
    if (!target || target.hp === 0) return { status: "void", reason: "target_dead" };
    if (target.side !== actor.side) return { status: "void", reason: "not_allied" };
    if (distance(actor, target) > r.range) return { status: "void", reason: "out_of_range" };
    if (s.links.some(l => l.targetId === r.targetId)) return { status: "void", reason: "target_already_linked" };
    if (s.links.length >= LINK_HARD_CAP) return { status: "void", reason: "link_cap" };
    if (s.nextLinkId >= 1000000000) return { status: "void", reason: "id_exhausted" };
    if (s.links.some(l => l.id === `neural-link:${s.nextLinkId}`)) return { status: "void", reason: "id_collision" };
    return { status: "reprojected", skillId: r.skillId, linkId: `neural-link:${s.nextLinkId}`, sourceId: r.actorId, targetId: r.targetId,
      range: r.range, attackBonus: r.attackBonus, expiresAtRound: s.round + r.lifetime, breakConditions: [...NEURAL_LINK_BREAK_CONDITIONS] };
  }
  let count = s.units.filter(u => u.summon && u.hp > 0).length, spawned = 0;
  const used = new Set(s.units.map(u => u.id));
  const slots: SpawnSlot[] = r.candidates.map(p => {
    let reason: string | null = null, unit: SwarmUnit | null = null;
    if (!within(s, p)) reason = "out_of_bounds";
    else if (distance(actor, unitAt(p)) > r.spawnRange) reason = "out_of_range";
    else if (s.blocked.some(b => eq(b, p))) reason = "blocked";
    else if (s.units.some(u => u.hp > 0 && covers(u, p))) reason = "occupied";
    else if (spawned >= r.maxSpawn) reason = "spawn_limit";
    else if (count >= r.summonCap || count >= SWARM_HARD_CAP) reason = "summon_cap";
    else if (s.units.length + spawned >= 1024) reason = "unit_limit";
    else if (s.nextSpawnId + spawned >= 1000000000) reason = "id_exhausted";
    else if (used.has(`swarm:${s.nextSpawnId + spawned}`)) reason = "id_collision";
    else {
      unit = { id: `swarm:${s.nextSpawnId + spawned}`, side: actor.side, cell: { x: p.x, y: p.y }, width: 1, height: 1, hp: r.hp,
        summon: { parentId: actor.id, speciesId: r.speciesId, expiresAtRound: s.round + r.lifetime } };
      count++; spawned++;
    }
    return { cell: { x: p.x, y: p.y }, reason, unit };
  });
  return { status: "reprojected", skillId: r.skillId, slots };
}
/** Prepare binds the exact candidates or target; no dynamic target selection. */
export function prepareSwarmLink(s: SwarmLinkState, request: SwarmLinkRequest):
  { status: "planned"; intent: SwarmIntent; projection: SwarmProjection } | { status: "void"; reason: string } {
  if (!validRequest(request)) return { status: "void", reason: "invalid_request" };
  const intent: SwarmIntent = { version: 1, round: s?.round, request: copyRequest(request) };
  const projection = calculate(s, intent);
  return projection.status === "void" ? projection : { status: "planned", intent, projection };
}
export function reprojectSwarmLink(s: SwarmLinkState, intent: SwarmIntent): SwarmProjection { return calculate(s, intent); }
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left).sort(), other = Object.keys(right).sort();
  return keys.length === other.length && keys.every((k, i) => k === other[i] && sameJson(left[k], right[k]));
}
/** Same calculation for preview and commit; optional expected preview is a stale-state guard. */
export function resolveSwarmLink(s: SwarmLinkState, intent: SwarmIntent, expected?: SwarmProjection): SwarmResolution {
  const projection = calculate(s, intent);
  if (projection.status === "void") return { status: "void", reason: projection.reason, state: s, events: [] };
  if (expected !== undefined && !sameJson(projection, expected)) return { status: "void", reason: "stale_projection", state: s, events: [] };
  const r = intent.request;
  const next = copyState(s);
  next.resolvedActions.push(r.actionId);
  const events: SwarmEvent[] = [];
  if (r.skillId === "split_swarm" && projection.skillId === "split_swarm") {
    for (const slot of projection.slots) {
      if (slot.reason) { events.push({ type: "summon_skipped", cell: slot.cell, reason: slot.reason }); continue; }
      const unit = slot.unit!;
      next.nextSpawnId++;
      next.units.push(unit); events.push({ type: "summon_spawned", unit: { ...unit, cell: { ...unit.cell }, summon: { ...unit.summon! } } });
    }
  } else if (r.skillId === "neural_link" && projection.skillId === "neural_link") {
    const link: NeuralLink = { id: projection.linkId, sourceId: r.actorId, targetId: r.targetId,
      range: r.range, attackBonus: r.attackBonus, expiresAtRound: projection.expiresAtRound };
    next.nextLinkId++;
    next.links.push(link); events.push({ type: "link_created", link: { ...link } });
  }
  return { status: "resolved", state: next, events };
}
/** Effect is a flat attack bonus, never a recursively linked multiplier. */
export function linkedAttackBonus(s: SwarmLinkState, targetId: string): number {
  if (!validState(s) || s.finished) return 0;
  const l = s.links.find(item => item.targetId === targetId);
  return l && !breakReason(s, l) ? l.attackBonus : 0;
}
/** Reconcile after *each* death/position/side change, before another rule effect. */
export function reconcileSwarmLink(s: SwarmLinkState): SwarmResolution {
  if (!validState(s)) return { status: "void", reason: "invalid_state", state: s, events: [] };
  if (s.finished) return { status: "void", reason: "finished", state: s, events: [] };
  const events: SwarmEvent[] = [];
  const removed = new Set<string>();
  for (const u of s.units) if (u.summon && (u.hp === 0 || s.round >= u.summon.expiresAtRound)) {
    removed.add(u.id); events.push({ type: "summon_removed", unitId: u.id, reason: u.hp === 0 ? "death" : "expired" });
  }
  // Resolve against the post-removal state; a removed or expired summon breaks its
  // links as source/target death, with the summon removal event emitted first.
  const nextWorld = copyState(s);
  nextWorld.units = nextWorld.units.filter(u => !removed.has(u.id));
  const links: NeuralLink[] = [];
  for (const l of nextWorld.links) {
    const reason = breakReason(nextWorld, l);
    if (reason) events.push({ type: "link_broken", linkId: l.id, reason }); else links.push(l);
  }
  nextWorld.links = links;
  return { status: "resolved", state: nextWorld, events };
}
/** Advance exactly one boundary; lifetime N is effective for rounds [birth, birth + N). */
export function advanceSwarmRound(s: SwarmLinkState): SwarmResolution {
  if (!validState(s)) return { status: "void", reason: "invalid_state", state: s, events: [] };
  if (s.finished) return { status: "void", reason: "finished", state: s, events: [] };
  if (s.round >= 1000000) return { status: "void", reason: "round_limit", state: s, events: [] };
  return reconcileSwarmLink({ ...s, round: s.round + 1 });
}

/* Integration (not done by this module):
 * 1. Extend versioned MatchState/intent/events and persist counters, action IDs,
 *    children, links and round in snapshots/replay. Never reuse a counter.
 * 2. Adapt all live footprints and the host's terrain/building/reservation/
 *    protected-path restrictions to blocked cells; enforce connectivity on the
 *    entire resulting board, not just each candidate in isolation. Bind explicit
 *    targets/candidates during enemy_prepare.
 * 3. Use reproject after player effects and the same resolver for preview and
 *    actual; atomically apply returned units/links/events to authoritative state.
 *    Feed the bonus into the chosen enemy attack calculation exactly once. The
 *    expected projection only guards staleness, not authority: the host must bind
 *    intents to the prepared plan and validate actor/species, skill parameters and
 *    content version against trusted rules, rather than accepting forged requests.
 *    Validate untrusted snapshots as bounded, plain, schema-only JSON before use;
 *    these typed local primitives do not authenticate input or sanitize extra fields.
 * 4. Reconcile after each movement, death or side change and advance once at the
 *    designated round boundary. Decide child actions and victory semantics in the
 *    battle engine; children survive their parent here until killed/expired. On
 *    finish the host owns any cleanup; these primitives reject further effects.
 *    The 256-action history is a match-wide hard limit: do not silently discard
 *    action IDs without a separate replay-safe retention/versioning design.
 * 5. Implement AI, UI, event playback and replay/serialization tests; guard remote
 *    matches until both peers negotiate a compatible rule/content version.
 */
