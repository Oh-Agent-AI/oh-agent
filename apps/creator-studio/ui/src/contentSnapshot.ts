import { inspectContentPackageV2, validateContentPackageManifestV2, validateCityWorldProfile, validateCityProjectAssetCatalog, validateSceneDraft, validateWorldPlanPatch, type ContentPackageManifestV2, type CityWorldProfileV1, type SceneDraftV1, type CityProjectAssetCatalogV1 } from "@oh-agent/city-sdk";
import type { InstalledContentPackage } from "./installedContent";
import { CITY_GENERATOR_VERSION } from "../../../agent-city/ui/src/engine/planPatch";

type Request = (method: string, payload: Record<string, unknown>) => Promise<unknown>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Generator compatibility is separate from semantic and publisher checks. */
export function supportsInstalledWorldGenerator(manifest: ContentPackageManifestV2): boolean {
  return manifest.kind === "city-world" && "generatorVersion" in manifest.entry && manifest.entry.generatorVersion === CITY_GENERATOR_VERSION;
}

/** Load only declared files from one instance-scoped, digest-pinned host snapshot. */
export async function inspectInstalledWorld(request: Request, item: InstalledContentPackage): Promise<{ manifest: ContentPackageManifestV2; profile: CityWorldProfileV1; scene: SceneDraftV1; assets: CityProjectAssetCatalogV1; patch: unknown; files: ReadonlyMap<string, Uint8Array> }> {
  const opened = await request("creator.content.snapshot.open", { packageId: item.packageId, version: item.version });
  if (!object(opened) || typeof opened.snapshotId !== "string") throw new Error("content_snapshot_invalid");
  const id = opened.snapshotId;
  try {
    const checked = validateContentPackageManifestV2(opened.manifest);
    if (!checked.ok || checked.value.kind !== "city-world" || checked.value.packageId !== item.packageId || checked.value.version !== item.version || checked.value.contentDigest !== item.contentDigest) throw new Error("content_snapshot_invalid");
    const files = new Map<string, Uint8Array>();
    for (const file of checked.value.files) {
      const bytes = new Uint8Array(file.byteLength);
      let offset = 0;
      do {
        const part = await request("creator.content.snapshot.read", { snapshotId: id, path: file.path, offset });
        if (!object(part) || part.contentDigest !== item.contentDigest || part.offset !== offset || part.totalBytes !== file.byteLength || typeof part.data !== "string" || typeof part.complete !== "boolean" || part.data.length > 65536) throw new Error("content_snapshot_invalid");
        let decoded: string;
        try { decoded = atob(part.data); } catch { throw new Error("content_snapshot_invalid"); }
        if (btoa(decoded) !== part.data || decoded.length > file.byteLength - offset || (!decoded.length && offset < file.byteLength)) throw new Error("content_snapshot_invalid");
        for (let index = 0; index < decoded.length; index++) bytes[offset + index] = decoded.charCodeAt(index);
        offset += decoded.length;
        if (part.complete !== (offset === file.byteLength)) throw new Error("content_snapshot_invalid");
      } while (offset < file.byteLength);
      files.set(file.path, bytes);
    }
    const result = await inspectContentPackageV2(checked.value, files);
    if (!result.ok) throw new Error(result.diagnostics[0]?.code ?? "content_semantics_invalid");
    const entry = checked.value.entry;
    if (!("profile" in entry)) throw new Error("content_snapshot_invalid");
    const parse = (path: string) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files.get(path)!));
    const profile = validateCityWorldProfile(parse(entry.profile));
    const scene = validateSceneDraft(parse(entry.scene));
    const assets = validateCityProjectAssetCatalog(parse(entry.assets));
    const patch = entry.patch ? validateWorldPlanPatch(parse(entry.patch), entry.defaultSeed, entry.generatorVersion) : null;
    if (!profile.ok || !scene.ok || !assets.ok || (patch && !patch.ok)) throw new Error("content_semantics_invalid");
    return { manifest: result.value.manifest, profile: profile.value, scene: scene.value, assets: assets.value, patch: patch?.value ?? null, files };
  } finally { await request("creator.content.snapshot.close", { snapshotId: id }).catch(() => {}); }
}
