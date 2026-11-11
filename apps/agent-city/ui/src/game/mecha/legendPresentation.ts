/** Contextual legend only; never changes legal moves or inferred risk. */
import type { GameLocale } from "../gameCopy";
import { projectedThreatState } from "./planPresentation";
import type { Cell } from "./rules";

export type LegendSnapshot = {
  deployment?: boolean;
  declaredTelegraph: readonly Cell[];
  projectedTelegraph: readonly Cell[] | null;
  predictionSource?: "draft" | "candidate";
  reach: readonly Cell[];
  move: Cell | null;
  inspectionSegments?: readonly { kind: "attack" | "move" }[];
  targetPreview?: { shove?: { from: Cell; to: Cell; blocked?: boolean } };
};
export type LegendItem = { id: "declared" | "projected" | "movement" | "landing" | "shove"; label: string; detail: string };

export function presentBattleLegend(view: LegendSnapshot, locale: GameLocale) {
  const en = locale === "en";
  const projected = projectedThreatState(view.projectedTelegraph);
  const declared = new Set(view.declaredTelegraph.map(cell => `${cell.x},${cell.y}`));
  const overlap = (view.projectedTelegraph ?? []).some(cell => declared.has(`${cell.x},${cell.y}`));
  const reachOverlap = view.reach.some(cell => declared.has(`${cell.x},${cell.y}`));
  const threats: LegendItem[] = view.deployment ? [] : [
    { id: "declared", label: en ? "Enemy attack" : "敌方攻击", detail: en ? "Red: attacker → striped danger cell" : "红框攻击者 → 斜纹危险格" },
    { id: "projected", label: view.predictionSource === "candidate" ? (en ? "Target preview" : "目标试算") : (en ? "Plan prediction" : "草稿预测"), detail: projected === "unknown" ? (en ? "Unknown · prediction unavailable" : "未知 · 预测不可用")
      : projected === "none" ? (en ? "No attack cells predicted" : "预测无攻击格")
      : view.predictionSource === "candidate" ? (en ? "Blue dashes: selected target, not confirmed" : "蓝色虚线：选定目标试算，尚未确认") : (en ? "Blue dashes: attack cells after plan" : "蓝色虚线：执行草稿后的攻击格") },
  ];
  const actions: LegendItem[] = [];
  if (view.reach.length || view.inspectionSegments?.some(segment => segment.kind === "move")) {
    actions.push({ id: "movement", label: view.deployment ? (en ? "Deployment zone" : "部署区") : en ? "Movement" : "移动", detail: view.deployment ? (en ? "Green cells: valid placements" : "绿色格子：可部署") : reachOverlap ? (en ? `Green cells: reachable · twin diamonds: reachable but threatened${view.inspectionSegments?.some(segment => segment.kind === "move") ? " · green arrow: route" : ""}` : `绿格可移动 · 双菱形：可移动但有危险${view.inspectionSegments?.some(segment => segment.kind === "move") ? " · 绿箭头：路线" : ""}`) : en ? "Green: available cells / planned route" : "绿格可移动 / 绿箭头为计划路线" });
  }
  if (view.move) actions.push({ id: "landing", label: en ? "Planned destination" : "计划落点", detail: en ? "Yellow diamond · not executed" : "黄色菱形 · 尚未执行" });
  if (view.targetPreview?.shove) actions.push({ id: "shove", label: en ? "Push preview" : "推挤预览", detail: view.targetPreview.shove.blocked ? (en ? "Red cross: blocked; stays in place" : "红色叉号：受阻，留在原位") : (en ? "Pale arrow + brackets: direction + landing" : "浅黄箭头＋落点框：方向与最终位置") });
  return { threats, actions, projected, overlap, reachOverlap, note: overlap ? (en ? "Red + blue: this cell remains threatened." : "红蓝叠加：该格仍有危险。") : null };
}
