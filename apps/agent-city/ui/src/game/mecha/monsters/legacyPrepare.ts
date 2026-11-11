import type { Intent, MatchState } from "../board";
import { scriptedEnemyPrepare } from "../enemy";
import type { LegacyBossDefinition } from "./contracts";
import { lookupMonsterDefinition, MONSTER_CONTENT_VERSION_V1, MONSTER_RULESET_V1 } from "./registry";

// Bind the existing prepare implementation to its explicit registry entry. This
// adapter includes Raider preparation because the old function does; it does not
// introduce per-skill handlers, change the serialized match, or validate its script.
// The fixed descriptor is not inferred from legacy state or used to negotiate rules.
const entry = lookupMonsterDefinition(MONSTER_RULESET_V1, MONSTER_CONTENT_VERSION_V1, "legacy_boss");
if (!entry.ok || entry.definition.kind !== "legacy_boss") {
  throw new Error("Legacy boss registry entry is missing");
}

export const legacyBossPrepareAdapter: Readonly<{
  definition: LegacyBossDefinition;
  prepare: (state: MatchState) => Intent;
}> = Object.freeze({
  definition: entry.definition,
  prepare: (state) => scriptedEnemyPrepare(state),
});
