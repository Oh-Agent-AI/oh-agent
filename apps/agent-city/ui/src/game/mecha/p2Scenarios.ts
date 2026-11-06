/**
 * Local curated combinations, not new terrain or enemy implementations.
 * The caller must supply the current city's trusted FightCatalog (normally the
 * UI's safety-filtered catalog); a missing window is never replaced by a fixture.
 * Nothing here persists, exports, or transmits site or match data.
 */
import { BOARD, MECH_IDS, RELAXED_SPAWN_MAX_DELTA, footprint, type Cell } from "./board";
import type { CityMechaSite, FightCatalog, FightShape } from "./citySite";
import { applyDeployPlan, deployableCells, validateDeployPlan, type DeployPlan } from "./deployment";
import { matchFromSite } from "./matchFromSite";
import { ENEMY_STATS, spawnsAreOpenGround, type BossScriptId, type BuildingStake, type CoverPresetId, type DifficultyId, type MatchState } from "./rules";

export type P2Scenario = Readonly<{
  id: string;
  shape: FightShape;
  script: BossScriptId;
  stake: BuildingStake;
  preset: CoverPresetId;
  label: Readonly<{ zh: string; en: string }>;
}>;

// Preset is an existing rules parameter, not a city map: matchFromSite clears covers.
const scenarios: P2Scenario[] = [
  { id: "flat-raid", shape: "flat", script: "raid_ssw", stake: "all", preset: "covers_sparse_mid", label: { zh: "平地突袭", en: "Flatland raid" } },
  { id: "shore-siege", shape: "shore", script: "siege", stake: "all", preset: "covers_sparse_mid", label: { zh: "海岸围攻", en: "Shore siege" } },
  { id: "ridge-cadence", shape: "ridge", script: "cadence_ssw", stake: "all", preset: "covers_sparse_mid", label: { zh: "山脊连击", en: "Ridge cadence" } },
  { id: "alley-siege", shape: "alley", script: "siege", stake: "frontage", preset: "covers_sparse_mid", label: { zh: "巷战围攻", en: "Alley siege" } },
];
for (const scenario of scenarios) { Object.freeze(scenario.label); Object.freeze(scenario); }
export const P2_SCENARIOS: readonly P2Scenario[] = Object.freeze(scenarios);

export type P2UnavailableReason = "unknown_scenario" | "invalid_difficulty" | "site_unavailable" | "invalid_site" | "invalid_spawns" | "incomplete_enemy_roster" | "invalid_enemy_roster" | "deployment_unavailable" | "opening_unavailable";
export type P2ScenarioResult =
  | { ok: false; reason: P2UnavailableReason }
  | { ok: true; scenario: P2Scenario; site: CityMechaSite; match: MatchState; suggestedDeployment: DeployPlan };

const validCell = (cell: Cell) => Boolean(cell && Number.isInteger(cell.x) && Number.isInteger(cell.y) && cell.x >= 0 && cell.x < BOARD && cell.y >= 0 && cell.y < BOARD);
const cellKey = (cell: Cell) => `${cell.x},${cell.y}`;

/** Validate structural assumptions; site provenance remains the caller's responsibility. */
function validSite(site: CityMechaSite): boolean {
  if (![site.originX, site.originZ, site.yaw, site.cellW, site.cellD, site.spawnSpread].every(Number.isFinite)
    || site.cellW <= 0 || site.cellD <= 0 || site.spawnSpread < 0 || site.spawnSpread > RELAXED_SPAWN_MAX_DELTA) return false;
  if (!Array.isArray(site.terrain) || site.terrain.length !== BOARD || !Array.isArray(site.heights) || site.heights.length !== BOARD) return false;
  for (let y = 0; y < BOARD; y += 1) {
    if (!Array.isArray(site.terrain[y]) || site.terrain[y]!.length !== BOARD || !Array.isArray(site.heights[y]) || site.heights[y]!.length !== BOARD) return false;
    if (Array.from(site.terrain[y]!).some(face => !["land", "road", "water", "mountain"].includes(face)) || Array.from(site.heights[y]!).some(h => !Number.isFinite(h))) return false;
  }
  if (!Array.isArray(site.buildings) || site.buildings.length < 2 || !Array.isArray(site.blocked) || !site.blocked.every(validCell)
    || !Array.isArray(site.mechs) || site.mechs.length !== MECH_IDS.length || !Array.isArray(site.raiders) || !validCell(site.boss)) return false;
  if (new Set(site.mechs.map(m => m.id)).size !== MECH_IDS.length || site.mechs.some(m => !MECH_IDS.includes(m.id) || !validCell(m.pos))) return false;
  if (new Set(site.buildings.map(b => b.id)).size !== site.buildings.length || site.buildings.some(b => !b.id || !Array.isArray(b.cells) || !b.cells.length || !b.cells.every(validCell))) return false;
  if (new Set(site.raiders.map(r => r.id)).size !== site.raiders.length || site.raiders.some(r => !r.id || !validCell(r.pos))) return false;
  if (site.assaultTerrainSafety && (!Array.isArray(site.assaultTerrainSafety.unsafeCells) || !site.assaultTerrainSafety.unsafeCells.every(validCell)
    || !Array.isArray(site.assaultTerrainSafety.unsafeEdges) || site.assaultTerrainSafety.unsafeEdges.some(edge => !validCell(edge.from) || !validCell(edge.to)))) return false;
  return true;
}

/**
 * Resolve a combination against the *current* catalog. The successful match is
 * still in deployment; suggestedDeployment is a witnessed legal opening, not an
 * automatic placement. Re-resolve after the catalog or difficulty changes.
 */
export function resolveP2Scenario(catalog: FightCatalog, id: string, difficulty?: DifficultyId): P2ScenarioResult {
  const scenario = P2_SCENARIOS.find(item => item.id === id);
  if (!scenario) return { ok: false, reason: "unknown_scenario" };
  if (difficulty !== undefined && difficulty !== "easy" && difficulty !== "normal" && difficulty !== "hard") return { ok: false, reason: "invalid_difficulty" };
  const site = catalog[scenario.shape];
  if (!site) return { ok: false, reason: "site_unavailable" };
  if (!validSite(site)) return { ok: false, reason: "invalid_site" };
  const match = matchFromSite(site, { preset: scenario.preset, script: scenario.script, stake: scenario.stake, difficulty, deployment: true });
  if (scenario.script === "siege" && match.raiders.length !== ENEMY_STATS[difficulty ?? "normal"].raiderCount) return { ok: false, reason: "incomplete_enemy_roster" };
  // createMatch may generate an extra id already used by a supplied site raider.
  const reservedIds = new Set<string>(["boss", ...MECH_IDS, ...match.buildings.map(b => b.id)]);
  if (new Set(match.raiders.map(r => r.id)).size !== match.raiders.length || match.raiders.some(r => reservedIds.has(r.id))) return { ok: false, reason: "invalid_enemy_roster" };
  const spawnCells = [...match.mechs.map(m => m.pos), ...footprint(match.boss.anchor), ...match.raiders.map(r => r.pos)];
  const heights = spawnCells.filter(validCell).map(c => match.heights[c.y]![c.x]!);
  const unsafe = new Set(site.assaultTerrainSafety?.unsafeCells.map(cellKey) ?? []);
  if (!spawnsAreOpenGround(match) || spawnCells.some(c => !validCell(c) || unsafe.has(cellKey(c)))
    || Math.max(...heights) - Math.min(...heights) > RELAXED_SPAWN_MAX_DELTA) return { ok: false, reason: "invalid_spawns" };
  const preferred: DeployPlan = { revision: match.revision, placements: match.mechs.map(m => ({ mechId: m.id, pos: { ...m.pos } })) };
  const cells = deployableCells(match);
  if (cells.length < MECH_IDS.length) return { ok: false, reason: "deployment_unavailable" };
  const fallback: DeployPlan = { revision: match.revision, placements: MECH_IDS.map((mechId, index) => ({ mechId, pos: cells[index]! })) };
  const suggestedDeployment = validateDeployPlan(match, preferred).ok ? preferred : fallback;
  if (!validateDeployPlan(match, suggestedDeployment).ok) return { ok: false, reason: "deployment_unavailable" };
  const opening = applyDeployPlan(match, suggestedDeployment);
  if (!opening.ok || opening.state.outcome || opening.state.phase !== "player_plan") return { ok: false, reason: "opening_unavailable" };
  return { ok: true, scenario, site, match, suggestedDeployment };
}
