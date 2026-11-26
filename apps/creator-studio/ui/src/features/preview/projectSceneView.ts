import { validateSceneDraft, type CityProjectAssetCatalogV1, type SceneDraftV1 } from "@oh-agent/city-sdk";

export type ProjectSceneView = Readonly<{
  scene: SceneDraftV1;
  assets: CityProjectAssetCatalogV1;
  files: ReadonlyMap<string, Uint8Array>;
}>;

type BaseSceneView = Readonly<{
  scene: SceneDraftV1;
  assets: CityProjectAssetCatalogV1;
  files: ReadonlyMap<string, Uint8Array>;
}> | undefined;

export function composeProjectSceneView(base: BaseSceneView, project: ProjectSceneView | null): ProjectSceneView | null {
  if (!project) return null;
  if (!base) return project;
  const ids = new Set(base.scene.objects.map(object => object.id));
  if (project.scene.objects.some(object => ids.has(object.id))) return null;
  const assets = new Map(base.assets.entries.map(entry => [entry.assetId, entry]));
  for (const entry of project.assets.entries) {
    const existing = assets.get(entry.assetId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) return null;
    assets.set(entry.assetId, entry);
  }
  const scene = validateSceneDraft({ schemaVersion: 1, objects: [...base.scene.objects, ...project.scene.objects] });
  if (!scene.ok) return null;
  return { scene: scene.value, assets: { schemaVersion: 1, entries: [...assets.values()] },
    files: new Map([...base.files, ...project.files]) };
}
