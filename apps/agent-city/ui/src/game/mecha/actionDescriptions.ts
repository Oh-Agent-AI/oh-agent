import type { Action } from "./board";
import type { ShotCheck } from "./combat";

export const ACTION_DESCRIPTIONS: Record<Action["kind"], string> = {
  melee: "攻击相邻敌人，可推动大怪。",
  shoot: "沿直线射击射程内的敌人，路径不能被阻挡。",
  charge: "攻击相邻敌人，伤害更高，可推动大怪。",
  pierce: "沿直线射击，可穿过一处掩体、建筑或废墟。",
  repair: "为相邻友机恢复最多 4 点生命。",
  skip: "本机本回合不行动。",
};

export function shotCheckLabel(check: ShotCheck): string {
  switch (check.status) {
    case "available": return "可射击";
    case "not_aligned": return "不在同一行或列";
    case "out_of_range": return "超出射程";
    case "same_cell": return "目标与射手位于同一格";
    case "blocked_terrain": return "山地阻挡射线";
    case "blocked_obstacle": return "障碍阻挡射线";
    case "blocked_cover": return "掩体、建筑或废墟阻挡射线";
    case "blocked_unit": return "单位阻挡射线";
  }
}
