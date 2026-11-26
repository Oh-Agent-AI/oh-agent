import { validateCityProjectAssetCatalog, type CityProjectAssetCatalogV1, type SceneDraftV1 } from "@oh-agent/city-sdk";

type Request = <T>(method: string, payload: Record<string, unknown>) => Promise<T>;
type ProjectAssetScope = Readonly<{ projectId: string; revision: number; assets?: unknown }>;

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

export async function loadProjectSceneAssets(request: Request, project: ProjectAssetScope, scene: SceneDraftV1): Promise<{
  assets: CityProjectAssetCatalogV1;
  files: ReadonlyMap<string, Uint8Array>;
}> {
  const checked = validateCityProjectAssetCatalog(project.assets ?? { schemaVersion: 1, entries: [] });
  if (!checked.ok) throw new Error("creator_project_asset_catalog_invalid");
  const models = scene.objects.filter(object => object.kind === "model");
  const entries = new Map(checked.value.entries.map(entry => [entry.assetId, entry]));
  const needed = new Map<string, (typeof checked.value.entries)[number]>();
  for (const model of models) {
    const entry = entries.get(model.asset.assetId);
    if (!entry || entry.sha256 !== model.asset.digest) throw new Error("creator_scene_asset_not_found");
    needed.set(entry.assetId, entry);
  }
  if (needed.size > 32 || [...needed.values()].reduce((sum, entry) => sum + entry.byteLength, 0) > 256 * 1024 * 1024) {
    throw new Error("creator_scene_asset_budget_exceeded");
  }
  const files = new Map<string, Uint8Array>();
  for (const entry of needed.values()) {
    const opened = object(await request("creator.asset.snapshot.open", {
      projectId: project.projectId, revision: project.revision, assetId: entry.assetId, digest: entry.sha256,
    }));
    const snapshotId = typeof opened?.snapshotId === "string" ? opened.snapshotId : "";
    if (!opened || !snapshotId || opened.projectId !== project.projectId
      || opened.revision !== project.revision || opened.assetId !== entry.assetId || opened.digest !== entry.sha256
      || opened.byteLength !== entry.byteLength) {
      if (snapshotId) await request("creator.asset.snapshot.close", { snapshotId }).catch(() => undefined);
      throw new Error("creator_asset_snapshot_invalid");
    }
    try {
      const bytes = new Uint8Array(entry.byteLength);
      let offset = 0;
      do {
        const part = object(await request("creator.asset.snapshot.read", { snapshotId, offset }));
        if (!part || part.projectId !== project.projectId || part.revision !== project.revision
          || part.assetId !== entry.assetId || part.digest !== entry.sha256 || part.offset !== offset
          || part.totalBytes !== entry.byteLength || typeof part.data !== "string" || typeof part.complete !== "boolean"
          || part.data.length > 65_536) throw new Error("creator_asset_snapshot_invalid");
        let decoded: string;
        try { decoded = atob(part.data); } catch { throw new Error("creator_asset_snapshot_invalid"); }
        if (btoa(decoded) !== part.data || decoded.length > entry.byteLength - offset
          || (!decoded.length && offset < entry.byteLength)) throw new Error("creator_asset_snapshot_invalid");
        for (let index = 0; index < decoded.length; index++) bytes[offset + index] = decoded.charCodeAt(index);
        offset += decoded.length;
        if (part.complete !== (offset === entry.byteLength)) throw new Error("creator_asset_snapshot_invalid");
      } while (offset < entry.byteLength);
      const actual = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
      if (actual !== entry.sha256) throw new Error("creator_asset_digest_mismatch");
      files.set(entry.relativePath, bytes);
    } finally {
      await request("creator.asset.snapshot.close", { snapshotId }).catch(() => undefined);
    }
  }
  return { assets: checked.value, files };
}
