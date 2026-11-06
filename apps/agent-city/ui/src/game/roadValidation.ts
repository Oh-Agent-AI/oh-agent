/** Terminal city-wide road check used by the driving HUD.
 *
 * This is the same layout-rule pass as the minimap (grade / bridgehead), not the
 * optional physics RoadAuditWorker. The HUD used to keep a UAT chip that said
 * validation was still in progress for the whole session; QA could not tell a
 * hang from a completed fail. One blocked cell is a finished fail, with a map
 * point the minimap already marks. */
import type { CityLayout } from "../engine/cityLayout";
import { minimapModel, type MinimapIssue } from "../minimap/roadConditions";

export type RoadValidationReport = Readonly<{
  status: "complete";
  verdict: "passed" | "failed";
  blocked: number;
  steep: number;
  issues: readonly MinimapIssue[];
  primary: MinimapIssue | null;
}>;

export function roadValidationReport(layout: CityLayout): RoadValidationReport {
  const model = minimapModel(layout);
  const blockedIssues = model.issues.filter((issue) => issue.severity === "blocked");
  return Object.freeze({
    status: "complete",
    verdict: blockedIssues.length === 0 ? "passed" : "failed",
    blocked: blockedIssues.length,
    steep: model.issues.filter((issue) => issue.severity === "steep").length,
    issues: model.issues,
    primary: blockedIssues[0] ?? null,
  });
}
