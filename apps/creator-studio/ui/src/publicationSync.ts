// 发布按钮记下的 releaseId 只活在这次 React 会话里。权威是宿主 creator_releases：
// 同一项目、同一修订、status=published 才把 releaseId 交给试玩按钮。
export type ProjectPublicationV1 = {
  projectId: string;
  revision: number;
  releaseId: string | null;
  status: "published" | "unpublished";
};

export function releaseIdForOpenRevision(publication: ProjectPublicationV1 | null, openProjectId: string, openRevision: number): string | null {
  if (!publication || publication.projectId !== openProjectId || publication.revision !== openRevision || publication.status !== "published") return null;
  if (typeof publication.releaseId !== "string" || publication.releaseId.length === 0) return null;
  return publication.releaseId;
}

export type SceneCaptureDecision =
  | { ok: true; revision: number; refreshViewport: boolean }
  | { ok: false; code: "creator_capture_requires_project" | "revision_conflict" };

// 视口里的 revision 会落后于库（vehicle.define / publish 不刷新 projectRef）。
// 冲突只在请求的修订和库里的修订不一致时成立；库已经是请求的修订时，刷新视口再按库修订捕获。
export function resolveSceneCaptureRevision(input: {
  projectOpen: boolean;
  projectMatches: boolean;
  requestedRevision: number | undefined;
  authoritativeRevision: number | null;
  viewportRevision: number | null;
}): SceneCaptureDecision {
  if (!input.projectOpen || !input.projectMatches || input.viewportRevision === null || input.authoritativeRevision === null) {
    return { ok: false, code: "creator_capture_requires_project" };
  }
  if (input.requestedRevision !== undefined && input.requestedRevision !== input.authoritativeRevision) {
    return { ok: false, code: "revision_conflict" };
  }
  return {
    ok: true,
    revision: input.authoritativeRevision,
    refreshViewport: input.viewportRevision !== input.authoritativeRevision,
  };
}
