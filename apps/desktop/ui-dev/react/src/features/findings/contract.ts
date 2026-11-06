import type { FindingsReport } from "../../lib/tauri";

/**
 * Merge one safe findings page into the currently visible projection.
 * Totals are authority-wide and therefore remain from the first page; rules
 * are unioned by rule so a later page cannot remove a filter option.
 */
export function mergeFindingsPage(current: FindingsReport | null, next: FindingsReport): FindingsReport {
  if (!current) return next;
  const knownGroups = new Set(current.issues.map((item) => item.group_id));
  const appendedIssues = next.issues.filter((item) => {
    if (knownGroups.has(item.group_id)) return false;
    knownGroups.add(item.group_id);
    return true;
  });
  const rules = new Map(current.rules.map((item) => [item.rule, item]));
  next.rules.forEach((item) => rules.set(item.rule, item));
  return {
    ...current,
    rules: Array.from(rules.values()),
    issues: [...current.issues, ...appendedIssues],
    next_cursor: next.next_cursor,
  };
}
