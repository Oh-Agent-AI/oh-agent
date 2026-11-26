import { useEffect, useState } from "react";
import { validateSceneDraft, type CityProjectAssetCatalogV1, type SceneDraftV1 } from "@oh-agent/city-sdk";
import type { CreatorRequest } from "../../adapters/creatorHost";
import type { Project } from "../../contracts/creatorStudio";
import { loadProjectSceneAssets } from "./projectAssetSnapshot";

export function useProjectSceneAssets(request: CreatorRequest, project: Project | null) {
  const [state, setState] = useState<Readonly<{
    key: string;
    status: "loading" | "ready" | "failed";
    scene?: SceneDraftV1;
    assets?: CityProjectAssetCatalogV1;
    files?: ReadonlyMap<string, Uint8Array>;
    code?: string;
  }> | null>(null);
  const key = project ? `${project.projectId}:${project.revision}` : null;
  useEffect(() => {
    if (!project || !key) { setState(null); return; }
    const scene = validateSceneDraft(project.scene ?? { schemaVersion: 1, objects: [] });
    if (!scene.ok) { setState({ key, status: "failed", code: "creator_scene_invalid" }); return; }
    let cancelled = false;
    setState({ key, status: "loading" });
    void loadProjectSceneAssets(request, project, scene.value).then(loaded => {
      if (!cancelled) setState({ key, status: "ready", scene: scene.value, ...loaded });
    }).catch(error => {
      if (!cancelled) setState({ key, status: "failed", code: error instanceof Error ? error.message.slice(0, 100) : "creator_asset_snapshot_invalid" });
    });
    return () => { cancelled = true; };
  }, [key, project, request]);
  return { key, state };
}
