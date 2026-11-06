import type { RunEvidenceSummary, EvidenceClip } from "./driving/audit/AuditEvidenceStore";
export type RoadAuditDiagnostics = Readonly<{
  summaries: readonly RunEvidenceSummary[];
  clips: readonly Readonly<{ caseId:string; clip:EvidenceClip }>[];
  truncated:boolean;
}>;
