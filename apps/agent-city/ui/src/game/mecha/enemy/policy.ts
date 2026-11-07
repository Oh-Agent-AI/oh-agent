import { scriptedEnemyPlanner } from "./planner";
import { baupEnemyPlanner } from "./plannerV2";
import type { EnemyPlanner, EnemyPolicy } from "./contracts";

export function enemyPlannerFor(policy: EnemyPolicy): EnemyPlanner {
  return policy === "baup" ? baupEnemyPlanner : scriptedEnemyPlanner;
}
