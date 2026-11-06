import { footprintCenter, type ArenaPlan, type MatchState } from "../rules";
import { enemyStatsOf, STATS } from "../board";
import type { PlanEvaluation, PlanScorer, PlanSimulator, PlannerDoctrine, ScoreFactor, ScoreFactorId } from "./contracts";
import { approachCost, boardChargesTerrain, manh, threatFocus } from "./shared";
import { rulePlanSimulator } from "./simulate";

const TUNNEL_WEIGHTS = { boss: 20, raider: 12, building: -4, mech: -3, victory: 5000, wipe: -3000, buildings: -3000, timeout: -100 };
const PEEL_WEIGHTS = { boss: 8, raider: 24, building: -16, mech: -3, victory: 5000, wipe: -3000, buildings: -4000, timeout: -150 };

export function createPlanScorer(doctrine: PlannerDoctrine, simulator: PlanSimulator = rulePlanSimulator): PlanScorer {
  const weights = doctrine === "peel" ? PEEL_WEIGHTS : TUNNEL_WEIGHTS;
  return {
    weightVersion: "ai-weights:v1",
    score(state: MatchState, plan: ArenaPlan): PlanEvaluation | null {
      // V1 scores cumulative damage from the fixed legacy roster's base HP.
      // Births, removals and summon HP need ordered lifecycle/damage evidence;
      // snapshots alone cannot distinguish expiry from a kill or infer birth HP.
      // Refuse such evaluations until the simulator carries that evidence.
      const beforeIds = new Set(state.raiders.map(raider => raider.id));
      if (beforeIds.size !== state.raiders.length || state.raiders.some(raider => "summon" in raider)) return null;
      const result = simulator.apply(state, plan);
      if (!result) return null;
      const afterIds = new Set(result.raiders.map(raider => raider.id));
      if (afterIds.size !== result.raiders.length || beforeIds.size !== afterIds.size ||
          [...beforeIds].some(id => !afterIds.has(id)) || result.raiders.some(raider => "summon" in raider)) return null;
      const enemy = enemyStatsOf(result);
      const factors: ScoreFactor[] = [];
      const add = (id: ScoreFactorId, value: number, weight: number, note?: string) => {
        factors.push({ id, value, weight, score: value * weight, ...(note ? { note } : {}) });
      };
      add("boss_damage", enemy.bossHp - result.boss.hp, weights.boss);
      add("raider_damage", result.raiders.reduce((sum, raider) => sum + enemy.raiderHp - raider.hp, 0), weights.raider);
      add("building_damage", result.buildings.reduce((sum, building) => sum + building.maxHp - building.hp, 0), weights.building);
      add("mech_damage", result.mechs.reduce((sum, mech) => sum + STATS[mech.id].maxHp - mech.hp, 0), weights.mech);
      const center = doctrine === "peel" ? threatFocus(result).cell : footprintCenter(result.boss.anchor);
      let position = 0;
      for (const mech of result.mechs) {
        if (mech.hp > 0) position += boardChargesTerrain(result)
          ? approachCost(result, mech.pos, center, mech.id)
          : doctrine === "peel"
            ? manh(mech.pos, center)
            : Math.abs(mech.pos.x + 0.5 - center.x) + Math.abs(mech.pos.y + 0.5 - center.y);
      }
      add("position", position, -1);
      // A retained field can tick again next round. This is a small positional
      // risk, not predicted damage: the player may still move before that tick.
      // Immediate damage and forced displacement are already in the simulated
      // HP and positions above; do not count the current tick a second time.
      if (!result.outcome && result.corrode?.fields.length) {
        const fieldCells = new Set(result.corrode.fields.map(field => `${field.cell.x},${field.cell.y}`));
        const exposed = result.mechs.filter(mech => mech.hp > 0 && fieldCells.has(`${mech.pos.x},${mech.pos.y}`)).length;
        if (exposed) add("threat", exposed, -1, "remaining corrode exposure; avoidable next round");
      }
      if (result.outcome === "victory") add("victory", 1, weights.victory);
      else if (result.outcome === "defeat_wipe") add("defeat", 1, weights.wipe, result.outcome);
      else if (result.outcome === "defeat_buildings") add("defeat", 1, weights.buildings, result.outcome);
      else if (result.outcome === "defeat_timeout") add("defeat", 1, weights.timeout, result.outcome);
      return {
        plan,
        score: factors.reduce((sum, factor) => sum + factor.score, 0),
        factors,
        deterministicKey: JSON.stringify(plan.items),
      };
    },
  };
}
