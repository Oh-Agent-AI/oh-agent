/** INTERNAL PROTOTYPE ONLY: do not expose as a user-facing share feature until
 * complete rule equivalence and a rule-implementation version gate are reviewed.
 * Local, rules-only opening exchange. This is not a City site, replay archive,
 * remote arena, authentication token, or a promise of 3D reconstruction.
 * Valid only for the audited rule implementation; GDD_RULESET alone is not a
 * build fingerprint. A rule change requires review and a challenge version bump.
 * IDs are replaced by order-preserving ranks and heights by relative heights.
 * Only fresh createMatch states are supported; deployment drafts are not state. */
import { BOARD, GDD_RULESET, MECH_IDS, footprint, key, noSpawn, type AssaultTerrainSafety, type Cell, type LocalMissionId, type MatchState } from "./board";
import { canonicalJson } from "./contracts/match";
import { applyDeployPlan, bossPrepare, createMatch, deployableCells } from "./rules";

type Opening = {
  preset: MatchState["preset"]; script: MatchState["script"]; difficulty: MatchState["difficulty"] | null;
  stake: MatchState["stake"]; mission: LocalMissionId | null;
  phase: "deployment" | "enemy_prepare";
  terrain: MatchState["terrain"]; heights: number[][]; safety: AssaultTerrainSafety | null;
  covers: Cell[]; obstacles: Cell[];
  buildings: Array<{ id: string; cells: Cell[] }>;
  raiders: Array<{ id: string; pos: Cell }>;
  mechs: Array<{ id: MatchState["mechs"][number]["id"]; pos: Cell }>;
  boss: Cell; deployment: { zone: Cell[]; reservedCells: Cell[] } | null;
};
type Envelope = { schema: "mecha-challenge:v1"; ruleset: typeof GDD_RULESET; opening: Opening; checksum: string };
export const CHALLENGE_CODE_MAX_BYTES = 64_000;
export type ChallengeCodeErrorCode = "invalid" | "incompatible" | "unavailable";
export class ChallengeCodeError extends Error {
  readonly code: ChallengeCodeErrorCode;
  constructor(code: ChallengeCodeErrorCode) { super(code); this.code = code; }
}
const fail = (code: ChallengeCodeErrorCode): never => { throw new ChallengeCodeError(code); };
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const oneOf = (v: unknown, choices: readonly string[]) => typeof v === "string" && choices.includes(v);
const cell = (v: unknown): v is Cell => obj(v) && keys(v, ["x", "y"]) && Number.isInteger(v.x) && Number.isInteger(v.y) && (v.x as number) >= 0 && (v.x as number) < BOARD && (v.y as number) >= 0 && (v.y as number) < BOARD;
const cells = (v: unknown): v is Cell[] => Array.isArray(v) && v.length <= BOARD * BOARD && v.every(cell) && new Set(v.map(key)).size === v.length;
const rankIds = (ids: string[], prefix: string) => {
  if (ids.some(id => typeof id !== "string" || id.length === 0 || id.length > 1024) || new Set(ids).size !== ids.length) return fail("invalid");
  return new Map([...ids].sort().map((id, i) => [id, `${prefix}-${String(i).padStart(3, "0")}`]));
};

/** Bounded validation precedes createMatch, planners, and all expensive operations. */
function validOpening(v: unknown): v is Opening {
  if (!obj(v) || !keys(v, ["preset", "script", "difficulty", "stake", "mission", "phase", "terrain", "heights", "safety", "covers", "obstacles", "buildings", "raiders", "mechs", "boss", "deployment"])) return false;
  if (!oneOf(v.preset, ["covers_sparse_mid", "covers_diag_corridor", "covers_twin_clusters"]) || !oneOf(v.script, ["stationary_smash", "cadence_ssw", "raid_ssw", "siege"]) || !(v.difficulty === null || oneOf(v.difficulty, ["easy", "normal", "hard"])) || !oneOf(v.stake, ["all", "frontage"]) || !(v.mission === null || v.mission === "rescue:v1") || !oneOf(v.phase, ["deployment", "enemy_prepare"])) return false;
  if (!Array.isArray(v.terrain) || v.terrain.length !== BOARD || !v.terrain.every(row => Array.isArray(row) && row.length === BOARD && row.every(t => oneOf(t, ["land", "water", "mountain", "road"])))) return false;
  if (!Array.isArray(v.heights) || v.heights.length !== BOARD || !v.heights.every(row => Array.isArray(row) && row.length === BOARD && row.every(h => typeof h === "number" && Number.isFinite(h) && Math.abs(h) <= 1_000_000)) || v.heights[0][0] !== 0) return false;
  if (v.safety !== null) {
    if (!obj(v.safety) || !keys(v.safety, ["unsafeCells", "unsafeEdges"]) || !cells(v.safety.unsafeCells) || !Array.isArray(v.safety.unsafeEdges) || v.safety.unsafeEdges.length > 342) return false;
    const edges = new Set<string>();
    for (const edge of v.safety.unsafeEdges) {
      if (!obj(edge) || !keys(edge, ["from", "to"]) || !cell(edge.from) || !cell(edge.to) || Math.max(Math.abs(edge.from.x - edge.to.x), Math.abs(edge.from.y - edge.to.y)) !== 1) return false;
      const id = [key(edge.from), key(edge.to)].sort().join("|");
      if (edges.has(id)) return false;
      edges.add(id);
    }
  }
  if (!cells(v.covers) || !cells(v.obstacles) || !cell(v.boss) || v.boss.x >= BOARD - 1 || v.boss.y >= BOARD - 1) return false;
  if (!Array.isArray(v.buildings) || v.buildings.length > 100 || !v.buildings.every(b => obj(b) && keys(b, ["id", "cells"]) && typeof b.id === "string" && /^building-\d{3}$/.test(b.id) && cells(b.cells) && b.cells.length > 0)) return false;
  if (!Array.isArray(v.raiders) || v.raiders.length > 100 || !v.raiders.every(r => obj(r) && keys(r, ["id", "pos"]) && typeof r.id === "string" && /^raider-\d{3}$/.test(r.id) && cell(r.pos))) return false;
  // Require exactly the generated rank namespace, not arbitrary user-supplied strings.
  for (const [list, prefix] of [[v.buildings, "building"], [v.raiders, "raider"]] as const) {
    const ids = list.map(item => item.id).sort();
    if (ids.some((id, i) => id !== `${prefix}-${String(i).padStart(3, "0")}`)) return false;
  }
  if (!Array.isArray(v.mechs) || v.mechs.length !== MECH_IDS.length || !v.mechs.every(m => obj(m) && keys(m, ["id", "pos"]) && oneOf(m.id, MECH_IDS) && cell(m.pos)) || new Set(v.mechs.map(m => m.id)).size !== MECH_IDS.length) return false;
  if (v.phase === "deployment") {
    if (!obj(v.deployment) || !keys(v.deployment, ["zone", "reservedCells"]) || !cells(v.deployment.zone) || !cells(v.deployment.reservedCells)) return false;
  } else if (v.deployment !== null) return false;
  // A physical opening has no overlapping occupants. Deployment placeholders are
  // still required to be valid; no hidden occupied-cell precedence is accepted.
  const occupied = [...v.covers, ...v.obstacles, ...v.buildings.flatMap(b => b.cells), ...footprint(v.boss), ...v.raiders.map(r => r.pos), ...v.mechs.map(m => m.pos)];
  if (new Set(occupied.map(key)).size !== occupied.length) return false;
  return true;
}

function build(o: Opening): MatchState {
  try {
    const state = createMatch({ preset: o.preset, script: o.script, ...(o.difficulty ? { difficulty: o.difficulty } : {}), stake: o.stake,
      ...(o.mission ? { mission: o.mission } : {}), covers: o.covers, obstacles: o.obstacles, terrain: o.terrain, heights: o.heights,
      ...(o.safety ? { assaultTerrainSafety: o.safety } : {}), buildings: o.buildings, raiders: o.raiders, mechs: o.mechs, boss: o.boss,
      deployment: o.phase === "deployment", ...(o.deployment ? { deployZone: o.deployment.zone, reservedDeployCells: o.deployment.reservedCells } : {}) });
    // createMatch can expand/truncate a siege roster; the encoded roster must be
    // the actual opening, never a request to silently invent other units.
    if (canonicalJson(state.raiders.map(r => ({ id: r.id, pos: r.pos }))) !== canonicalJson(o.raiders)) return fail("incompatible");
    if ([...footprint(state.boss.anchor), ...state.raiders.map(r => r.pos), ...state.mechs.map(m => m.pos)].some(c => noSpawn(state, c))) return fail("invalid");
    if (state.deployment) {
      const available = deployableCells(state);
      if (available.length < MECH_IDS.length) return fail("invalid");
      const deployed = applyDeployPlan(state, { revision: state.revision, placements: MECH_IDS.map((mechId, i) => ({ mechId, pos: available[i]! })) });
      if (!deployed.ok || deployed.state.outcome || deployed.state.phase !== "player_plan") return fail("incompatible");
    } else {
      const preview = structuredClone(state); bossPrepare(preview);
      if (preview.outcome || preview.phase !== "player_plan") return fail("incompatible");
    }
    return state;
  } catch (error) { if (error instanceof ChallengeCodeError) throw error; return fail("incompatible"); }
}

async function digest(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) return fail("unavailable");
  try {
    const result = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
    return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, "0")).join("");
  } catch { return fail("unavailable"); }
}

/** Export only a freshly constructed authority state, before preparation/deploy.
 * The checksum detects accidental changes, not malicious authorship. */
export async function exportChallengeCode(state: MatchState): Promise<string> {
  try { return await exportOpening(state); }
  catch (error) { if (error instanceof ChallengeCodeError) throw error; return fail("invalid"); }
}

async function exportOpening(state: MatchState): Promise<string> {
  // Snapshot before the first await; callers can continue using their match safely.
  try { state = structuredClone(state); } catch { return fail("invalid"); }
  if (!state || state.ruleset !== GDD_RULESET || !["deployment", "enemy_prepare"].includes(state.phase) || state.turn !== 1 || state.revision !== 0 || state.outcome !== null) return fail("invalid");
  if (!Array.isArray(state.buildings) || state.buildings.length > 100 || !Array.isArray(state.raiders) || state.raiders.length > 100 || !Array.isArray(state.mechs)) return fail("invalid");
  const buildingIds = rankIds(state.buildings.map(b => b.id), "building");
  const raiderIds = rankIds(state.raiders.map(r => r.id), "raider");
  if ([...buildingIds.keys(), ...raiderIds.keys()].some(id => id === "boss" || MECH_IDS.includes(id as typeof MECH_IDS[number])) || [...buildingIds.keys()].some(id => raiderIds.has(id))) return fail("invalid");
  if (!Array.isArray(state.heights) || state.heights.length !== BOARD || !state.heights.every(row => Array.isArray(row) && row.length === BOARD && row.every(Number.isFinite))) return fail("invalid");
  const base = state.heights[0]![0]!;
  const heights = state.heights.map(row => row.map(h => h - base));
  // Fail closed unless every ordered pairwise IEEE-754 height difference is
  // exactly preserved. Current movement and AI use these differences; shooting
  // uses the separately preserved terrain/occupancy. This is deliberately more
  // restrictive than testing today's single uphill threshold, and avoids hiding
  // cancellation or boundary changes behind a guessed list of thresholds.
  const before = state.heights.flat(), after = heights.flat();
  for (let i = 0; i < before.length; i++) for (let j = 0; j < before.length; j++) {
    const difference = before[i]! - before[j]!;
    if (!Number.isFinite(difference) || difference !== after[i]! - after[j]!) return fail("incompatible");
  }
  const opening: Opening = {
    preset: state.preset, script: state.script, difficulty: state.difficulty ?? null, stake: state.stake, mission: state.mission?.kind ?? null,
    phase: state.phase as Opening["phase"], terrain: state.terrain, heights, safety: state.assaultTerrainSafety ?? null,
    covers: state.covers, obstacles: state.obstacles, buildings: state.buildings.map(b => ({ id: buildingIds.get(b.id)!, cells: b.cells })),
    raiders: state.raiders.map(r => ({ id: raiderIds.get(r.id)!, pos: r.pos })), mechs: state.mechs.map(m => ({ id: m.id, pos: m.pos })),
    boss: state.boss.anchor, deployment: state.deployment ?? null,
  };
  if (!validOpening(opening)) return fail("invalid");
  const rebuilt = build(opening);
  // Compare the entire state, after the only two deliberate transformations.
  // This rejects modified HP, intents, mission target, extra fields, etc. In
  // particular, ID-dependent rescue roles must survive the replacement.
  const normalize = (source: MatchState) => {
    const result = structuredClone(source);
    result.heights = heights;
    result.buildings.forEach(b => { b.id = buildingIds.get(b.id)!; });
    result.raiders.forEach(r => { r.id = raiderIds.get(r.id)!; });
    return result;
  };
  if (canonicalJson(normalize(state)) !== canonicalJson(rebuilt)) return fail("incompatible");
  // Also compare the real prepared enemy state, not merely createMatch output.
  // This is a conservative smoke check, not a proof for future rule versions.
  let originalOpening = structuredClone(state), rebuiltOpening = structuredClone(rebuilt);
  if (originalOpening.deployment) {
    const available = deployableCells(originalOpening);
    const placements = MECH_IDS.map((mechId, i) => ({ mechId, pos: available[i]! }));
    const a = applyDeployPlan(originalOpening, { revision: originalOpening.revision, placements });
    const b = applyDeployPlan(rebuiltOpening, { revision: rebuiltOpening.revision, placements });
    if (!a.ok || !b.ok) return fail("incompatible");
    originalOpening = a.state; rebuiltOpening = b.state;
  } else { bossPrepare(originalOpening); bossPrepare(rebuiltOpening); }
  if (canonicalJson(normalize(originalOpening)) !== canonicalJson(rebuiltOpening)) return fail("incompatible");
  const body = { schema: "mecha-challenge:v1" as const, ruleset: GDD_RULESET, opening };
  const code = canonicalJson({ ...body, checksum: await digest(body) });
  if (new TextEncoder().encode(code).length > CHALLENGE_CODE_MAX_BYTES) return fail("invalid");
  return code;
}

/** Parse canonical JSON and reconstruct an independent authority state. Callers
 * must still use applyDeployPlan/bossPrepare and playTurn, not inject snapshots. */
export async function importChallengeCode(code: string): Promise<MatchState> {
  if (typeof code !== "string" || code.length > CHALLENGE_CODE_MAX_BYTES || new TextEncoder().encode(code).length > CHALLENGE_CODE_MAX_BYTES) return fail("invalid");
  let value: unknown;
  try { value = JSON.parse(code); } catch { return fail("invalid"); }
  if (!obj(value) || !keys(value, ["schema", "ruleset", "opening", "checksum"])) return fail("invalid");
  if (value.schema !== "mecha-challenge:v1" || value.ruleset !== GDD_RULESET) return fail("incompatible");
  if (typeof value.checksum !== "string" || !/^[0-9a-f]{64}$/.test(value.checksum) || !validOpening(value.opening) || canonicalJson(value) !== code) return fail("invalid");
  const envelope = value as Envelope;
  const body = { schema: envelope.schema, ruleset: envelope.ruleset, opening: envelope.opening };
  if (await digest(body) !== envelope.checksum) return fail("invalid");
  return build(envelope.opening);
}
