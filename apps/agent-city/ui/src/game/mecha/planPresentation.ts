/** Presentation only: this module does not validate or modify a draft. */
import { gameText, type GameLocale } from "../gameCopy";
import { describeUnitIdentity } from "./unitIdentity";
import type { Draft } from "./planning";
import type { Action, Cell } from "./rules";

export type PlanActionState = "unplanned" | "explicit-hold" | "explicit-action";
export type ProjectedThreatState = "unknown" | "none" | "present";

// Keep in sync with MechaBoard's actionLabel and its gameText translations.
const ACTION_LABELS: Record<Action["kind"], string> = {
  melee: "近战", shoot: "射击", charge: "冲撞", pierce: "穿射", repair: "维修", skip: "待机",
};

export function planActionLabel(kind: Action["kind"], locale: GameLocale): string {
  return gameText(ACTION_LABELS[kind], locale);
}

/** Keep unrecognized IDs visible instead of guessing what entity they describe. */
export function planTargetLabel(id: string, locale: GameLocale): string {
  return describeUnitIdentity(id, locale).label;
}

export function projectedThreatState(cells: readonly Cell[] | null): ProjectedThreatState {
  return cells === null ? "unknown" : cells.length === 0 ? "none" : "present";
}

export type PlanPresentation = {
  actionState: PlanActionState;
  /** The controller's whole-draft condition, not row-level provenance. */
  openingSuggestion: boolean;
  movement: string;
  action: string;
  target: string | null;
  hitDamage: number | null;
};

export function presentPlanRow({ draft, openingSuggestion, hitDamage, locale }: {
  draft: Draft | undefined;
  openingSuggestion: boolean;
  /** Enemy-phase HP loss from the current valid preview; null means unknown. */
  hitDamage: number | null;
  locale: GameLocale;
}): PlanPresentation {
  const actionState: PlanActionState = !draft?.explicit ? "unplanned"
    : draft.action.kind === "skip" ? "explicit-hold" : "explicit-action";
  const movement = !draft ? (locale === "en" ? "Unknown" : "未知")
    : draft.moveTo ? `${draft.moveTo.x}, ${draft.moveTo.y}`
    : gameText("原位", locale);
  const action = actionState === "unplanned" ? gameText("未选择", locale) : planActionLabel(draft!.action.kind, locale);
  const target = actionState !== "explicit-action" ? null
    : "target" in draft!.action && draft!.action.target
      ? planTargetLabel(draft!.action.target, locale)
      : gameText("未选择", locale);
  return {
    actionState, openingSuggestion, movement, action, target,
    hitDamage: hitDamage !== null && Number.isFinite(hitDamage) && hitDamage >= 0 ? hitDamage : null,
  };
}
