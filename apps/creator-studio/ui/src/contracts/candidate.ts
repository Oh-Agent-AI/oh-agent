export type CandidateRun = Readonly<{
  runId: string;
  status: "pending" | "claimed" | "completed" | "cancelled" | "failed" | "expired" | "unknown";
  createdAtMs: number | null;
  finishedAtMs: number | null;
  evidenceSource: "city-client-reported" | "host-verified" | null;
  evidence: unknown;
  failureCode: string | null;
}>;

export type ProjectCandidate = Readonly<{
  artifactKind: "candidate";
  candidateId: string;
  projectId: string;
  revision: number;
  contentDigest: string;
  status: "created" | "testing" | "tested" | "test-failed" | "accepted" | "unknown";
  createdAtMs: number;
  acceptedReleaseId: string | null;
  latestRun: CandidateRun | null;
}>;

const text = (value: unknown, max = 128): string | null => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function parseRun(value: unknown): CandidateRun | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("creator_candidate_invalid");
  const row = value as Record<string, unknown>;
  const runId = text(row.runId);
  if (!runId) throw new Error("creator_candidate_invalid");
  const status = ["pending", "claimed", "completed", "cancelled", "failed", "expired"].includes(String(row.status)) ? String(row.status) as CandidateRun["status"] : "unknown";
  return Object.freeze({ runId, status, createdAtMs: count(row.createdAtMs), finishedAtMs: count(row.finishedAtMs),
    evidenceSource: row.evidenceSource === "city-client-reported" || row.evidenceSource === "host-verified" ? row.evidenceSource : null,
    evidence: row.evidence ?? null, failureCode: text(row.failureCode) });
}

export function parseProjectCandidate(value: unknown): ProjectCandidate | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("creator_candidate_invalid");
  const row = value as Record<string, unknown>;
  const candidateId = text(row.candidateId);
  const projectId = text(row.projectId);
  const revision = count(row.revision);
  const contentDigest = text(row.contentDigest);
  const createdAtMs = count(row.createdAtMs);
  if (row.artifactKind !== "candidate" || !candidateId || !projectId || revision === null || !contentDigest || !/^sha256:[a-f0-9]{64}$/.test(contentDigest) || createdAtMs === null) throw new Error("creator_candidate_invalid");
  const status = ["created", "testing", "tested", "test-failed", "accepted"].includes(String(row.status)) ? String(row.status) as ProjectCandidate["status"] : "unknown";
  return Object.freeze({ artifactKind: "candidate", candidateId, projectId, revision, contentDigest, status, createdAtMs,
    acceptedReleaseId: text(row.acceptedReleaseId), latestRun: parseRun(row.latestRun ?? null) });
}

export function canAcceptCandidate(candidate: ProjectCandidate | null): candidate is ProjectCandidate {
  if (candidate === null || candidate.status !== "tested" || candidate.acceptedReleaseId !== null
    || candidate.latestRun?.status !== "completed" || !candidate.latestRun.evidenceSource) return false;
  const evidence = candidate.latestRun.evidence as Record<string, unknown> | null;
  // PR07 统一证据门禁：宿主复算与客户端回报相左（hostDisagreement）的证据不能被接受。
  return !!evidence && typeof evidence === "object" && !Array.isArray(evidence)
    && evidence.outcome === "success" && evidence.snapshotDigest === candidate.contentDigest
    && !evidence.hostDisagreement;
}

// PR07 Release 强闸（与宿主 publish_project_release 同构）：直接发布需要宿主复核
// 一致的 host-verified 证据；accept 仍容忍 city-client-reported（本地接受闸）。
export function canReleaseCandidate(candidate: ProjectCandidate | null): candidate is ProjectCandidate {
  return canAcceptCandidate(candidate) && candidate?.latestRun?.evidenceSource === "host-verified";
}

export function candidateEvidenceTrust(candidate: ProjectCandidate | null): string {
  const evidence = candidate?.latestRun?.evidence;
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence)
    && (evidence as Record<string, unknown>).hostDisagreement) {
    return "宿主复算与客户端回报不一致（hostDisagreement），不能接受或发布";
  }
  const source = candidate?.latestRun?.evidenceSource;
  return source === "host-verified" ? "Host 已用输入 Trace 复算并与回报一致" : source === "city-client-reported" ? "City 客户端回报（非 Host 验证）" : "暂无真实运行证据";
}
