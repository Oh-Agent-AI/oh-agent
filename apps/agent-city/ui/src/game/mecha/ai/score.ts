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
      const result = simulator.apply(state, plan);
      if (!result) return null;
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
