import { invokeHost } from "../host";
import { createTypedDataClient, type PluginResponseV1, type TypedCityLegacyExportRecordV1 } from "@agent-vitals/app-sdk";

export type LegacyCityStoreSnapshot = {
  bookmarkRefs: string[];
  legacyBookmarkState: { revision: number; value: { schemaVersion: number; assetRefs: string[] } } | null;
  claimRefs: string[];
  claims: Record<string, unknown>[];
  buildingRows: unknown[];
  squadMailbox: unknown;
  sourceRevision: string;
};

let snapshotPromise: Promise<LegacyCityStoreSnapshot> | null = null;

function parseRecord(record: TypedCityLegacyExportRecordV1): Record<string, unknown> {
  return Object.fromEntries(record.columns.map((column, index) => [column, record.values[index]]));
}

/** Read and project the complete bounded legacy stream once per plugin WebView. */
export function readLegacyCityStoreSnapshot(): Promise<LegacyCityStoreSnapshot> {
  if (snapshotPromise) return snapshotPromise;
  snapshotPromise = (async () => {
    const instanceId = window.__AV_PLUGIN_INSTANCE__;
    if (!instanceId) throw new Error("plugin_instance_unavailable");
    const client = createTypedDataClient(instanceId, (request) =>
      invokeHost<PluginResponseV1>("plugin_request", { request }));
    const bookmarkRefs = new Set<string>();
    let legacyBookmarkState: LegacyCityStoreSnapshot["legacyBookmarkState"] = null;
    const claimRefs = new Set<string>();
    const claims: Record<string, unknown>[] = [];
    const buildingRows: unknown[] = [];
    let squadMailbox: unknown = null;
    let cursor: string | null = null;
    let sourceRevision: string | null = null;
    do {
      const page = await client.readCityLegacyStorePage({ cursor, limit: 500 });
      if ((page.records.length === 0 && page.nextCursor !== null) || (cursor !== null && page.nextCursor === cursor)) {
        throw new Error("legacy_export_cursor_invalid");
      }
      if (sourceRevision !== null && page.sourceRevision !== sourceRevision) throw new Error("city_legacy_source_changed");
      sourceRevision = page.sourceRevision;
      for (const record of page.records) {
        const [id, revisionOrAsset, documentOrRest, ...rest] = record.values;
        if (record.source === "registry.game_links") {
          if (id !== 1 || typeof revisionOrAsset !== "number" || !Number.isSafeInteger(revisionOrAsset)
              || revisionOrAsset < 0 || typeof documentOrRest !== "string" || rest.length !== 0) {
            throw new Error("legacy_bookmark_state_invalid");
          }
          let parsed: unknown;
          try { parsed = JSON.parse(documentOrRest); } catch { throw new Error("legacy_bookmark_state_invalid"); }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("legacy_bookmark_state_invalid");
          const value = parsed as Record<string, unknown>;
          if (Object.keys(value).length !== 2 || value.schemaVersion !== 1 || !Array.isArray(value.assetRefs)
              || value.assetRefs.length > 200 || value.assetRefs.some((ref) => typeof ref !== "string" || !/^ca_[0-9a-f]{32}$/.test(ref))
              || new Set(value.assetRefs).size !== value.assetRefs.length) throw new Error("legacy_bookmark_state_invalid");
          const assetRefs = value.assetRefs as string[];
          legacyBookmarkState = { revision: revisionOrAsset, value: { schemaVersion: 1, assetRefs } };
          for (const assetRef of assetRefs) bookmarkRefs.add(assetRef);
        } else if (record.source === "registry.save_refs") {
          const assetRef = revisionOrAsset;
          if (typeof assetRef !== "string" || !/^ca_[0-9a-f]{32}$/.test(assetRef) || documentOrRest !== undefined || rest.length !== 0) {
            throw new Error("legacy_bookmark_state_invalid");
          }
          bookmarkRefs.add(assetRef);
        } else if (record.source === "building.claims") {
          const claim = parseRecord(record);
          if (typeof claim.asset_ref !== "string" || !/^ca_[0-9a-f]{32}$/.test(claim.asset_ref)) {
            throw new Error("city_legacy_claim_invalid");
          }
          claimRefs.add(claim.asset_ref);
          claims.push(claim);
        } else if (record.source === "building.overrides") {
          const [assetRef, revision, kitVersion, modelJson, updatedAtMs] = record.values;
          if (typeof modelJson !== "string") continue;
          try { buildingRows.push({ asset_ref: assetRef, revision, kit_version: kitVersion,
            stored_document: JSON.parse(modelJson), updated_at_ms: updatedAtMs }); }
          catch { /* Invalid legacy JSON is skipped by the adapter validator. */ }
        } else if (record.source === "building.squad_mailbox") {
          const document = record.values[0];
          if (typeof document === "string") {
            try { squadMailbox = JSON.parse(document) as unknown; } catch { squadMailbox = null; }
          }
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    if (sourceRevision === null) throw new Error("city_legacy_source_unavailable");
    return { bookmarkRefs: [...bookmarkRefs], legacyBookmarkState, claimRefs: [...claimRefs], claims, buildingRows, squadMailbox, sourceRevision };
  })().catch((error) => {
    snapshotPromise = null;
    throw error;
  });
  return snapshotPromise;
}

/** Resolve selected legacy asset aliases inside the trusted host, returning only stable opaque refs. */
export async function readLegacyCityAssetCrosswalk(
  assetRefs: readonly string[], sourceRevision: string, dataRevision: number,
) {
  const instanceId = window.__AV_PLUGIN_INSTANCE__;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const client = createTypedDataClient(instanceId, (request) =>
    invokeHost<PluginResponseV1>("plugin_request", { request }));
  return client.readCityAssetCrosswalk({ assetRefs, sourceRevision, dataRevision });
}
