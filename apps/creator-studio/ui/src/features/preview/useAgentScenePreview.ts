import { useEffect, useMemo, useState } from "react";
import type { CityProjectAssetCatalogV1, SceneDraftV1 } from "@oh-agent/city-sdk";
import type { CreatorRequest } from "../../adapters/creatorHost";
import type { Project } from "../../contracts/creatorStudio";
import type { AgentColliderPreview } from "./sceneColliderPreview";
import { buildScenePreviewDraft } from "./scenePreview";
import { loadProjectSceneAssets } from "./projectAssetSnapshot";

export type AgentScenePreviewPlan = Readonly<{
  previewId: string;
  projectId: string;
  revision: number;
  scene: SceneDraftV1;
}>;

export type AgentSceneAssetState = Readonly<{
  context: AgentScenePreviewPlan;
  status: "loading" | "ready" | "failed";
  assets?: CityProjectAssetCatalogV1;
  files?: ReadonlyMap<string, Uint8Array>;
  code?: string;
}>;

export function useAgentScenePreview(request: CreatorRequest, preview: AgentColliderPreview | null, project: Project | null) {
  const plan = useMemo<AgentScenePreviewPlan | null>(() => {
    if (!preview?.sceneOperations || !project || project.projectId !== preview.projectId || project.revision !== preview.revision) return null;
    const scene = buildScenePreviewDraft(project.scene ?? { schemaVersion: 1, objects: [] }, preview.sceneOperations);
    return scene ? { previewId: preview.previewId, projectId: project.projectId, revision: project.revision, scene } : null;
  }, [preview, project]);
  const [state, setState] = useState<AgentSceneAssetState | null>(null);
  useEffect(() => {
    if (!plan || !project) { setState(null); return; }
    let cancelled = false;
    setState({ context: plan, status: "loading" });
    void loadProjectSceneAssets(request, project, plan.scene).then(loaded => {
      if (!cancelled) setState({ context: plan, status: "ready", ...loaded });
    }).catch(error => {
      if (!cancelled) setState({ context: plan, status: "failed",
        code: error instanceof Error ? error.message.slice(0, 100) : "creator_asset_snapshot_invalid" });
    });
    return () => { cancelled = true; };
  }, [plan, project, request]);
  return { plan, state };
}
