import { embedded, invokeHost } from "../host";
import { validateCityProjectionV2, type CityModuleV3, type PluginRequestV1, type PluginResponseV1, type TypedObjectResultV1, type CityUiProjectionV2 } from "@agent-vitals/app-sdk";
import { defaultKitModel, parseKitModel, type KitModel } from "../engine/sessionKitConstruction";
import { isInheritanceDocument, resolveInheritance } from "../engine/sessionKitInheritance";
import { ensureCityAssetObject, reconcileLegacyCityAssetIdentities, resolveCityAssetRefsByStableRef,
  type CityAssetBookmarkObjectClient } from "./cityAssetBookmarks";
import {
  readTypedCityActivityShadowFromHost,
  readTypedCityFindingShadowFromHost,
  readTypedCitySkillWorkflowShadowFromHost,
  readTypedCityModelUsageShadowFromHost,
  readTypedCityTimeCoverageShadowFromHost,
  readTypedCitySessionShadowFromHost,
  readTypedCityStableRefsFromHost,
  readTypedCityUsageSummaryShadowFromHost,
  readTypedCitySessionDetailFromHost,
  promoteCityTypedWindowValues,
  type CityTypedSessionDetail,
} from "./typedCitySessionAdapter";
import { readLegacyCityAssetCrosswalk, readLegacyCityStoreSnapshot } from "./cityLegacyStore";
import { cityProjectionDelay, cityProjectionErrorCode, retryCityProjection } from "./projectionRetry";
import { importLegacyBuildingOverride, listCityBuildingObjectsByStableRef, readCityBuildingObject,
  type CityBuildingObjectClient, type CityBuildingObjectSnapshot, type CityBuildingStoredObject } from "./cityBuildingObjects";

export type CityProjectionV1 = CityUiProjectionV2;

const stableAssetRefsByProjection = new WeakMap<CityProjectionV1, Map<string, string>>();
export function stableAssetRefsForProjection(projection: CityProjectionV1): ReadonlyMap<string, string> {
  return stableAssetRefsByProjection.get(projection) ?? new Map();
}
function rememberStableAssetRefs(projection: CityProjectionV1, refs: Map<string, string> | undefined): void {
  if (refs) stableAssetRefsByProjection.set(projection, refs);
}

type WindowDays = 7 | 30 | 90 | 366;

function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export interface CityDataProvider {
  getProjection(input: {
    windowDays: 7 | 30 | 90 | 366;
    signal?: AbortSignal;
    onStage?: (stage: "reading_summary" | "reading_sessions" | "ready") => void;
    onPartial?: (projection: CityProjectionV1) => void;
  }): Promise<CityProjectionV1>;
}

/** Packaged City reads always use generic typed-data; v3 remains migration-only. */
export function cityDataProtocol(): "typed" {
  return "typed";
}


/** 独立页 `?fixtureSessions=N`：确定性合成 N 个会话，用来在浏览器里看「楼多起来」的城市。
 *  默认 3 个会话的 fixture 几乎没有会话楼，酒店街/立面/天际线都无从评估。只走 fixture 路径。 */
function syntheticSessions(count: number): CityProjectionV1["sessions"] {
  const harnesses = ["codex", "claude-code", "dsh", "workbuddy"]; // 与真实投影同名（连字符），否则落到兜底调色板
  let state = 0x9e3779b9;
  const next = () => { state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return state / 0x1_0000_0000; };
  const end = Date.parse("2026-10-03T00:00:00Z");
  return Array.from({ length: count }, (_, index) => {
    const start = end - Math.floor(next() * 85 * 86_400_000);
    const total = Math.round(5_000 * Math.pow(1_000, next())); // 5K..5M，对数均匀
    const input = Math.round(total * 0.8);
    return {
      id: `fixture-synth-${String(index + 1).padStart(3, "0")}`,
      harness: harnesses[Math.floor(next() * harnesses.length)],
      first_event_at: new Date(start).toISOString().replace(/\.\d{3}Z$/, "Z"),
      last_event_at: new Date(start + 1_800_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      tokens: { input, output: total - input, total },
    };
  });
}

function fixtureProjection(windowDays: 7 | 30 | 90 | 366): CityProjectionV1 {
  const from = ({ 7: "2026-09-27T00:00:00Z", 30: "2026-09-03T00:00:00Z", 90: "2026-07-06T00:00:00Z", 366: "2025-10-03T00:00:00Z" } as const)[windowDays];
  // 只在浏览器里读查询参数：Node 守卫（verify-react-city-data）没有 location / URLSearchParams。
  const search = typeof location !== "undefined" && typeof URLSearchParams !== "undefined" ? new URLSearchParams(location.search) : null;
  const synthetic = Number(search?.get("fixtureSessions") ?? 0);
  const allSessions: CityProjectionV1["sessions"] = Number.isInteger(synthetic) && synthetic > 0 ? syntheticSessions(Math.min(synthetic, 3000)) : [
    { id: "fixture-session-001", harness: "codex", title: "修复菜单栏图标不显示", title_source: "codex_thread_name", first_event_at: "2026-10-02T09:10:00Z", last_event_at: "2026-10-02T09:42:00Z", tokens: { input: 12400, output: 3100, total: 15500 } },
    { id: "fixture-session-002", harness: "claude_code", title: "重构 surface compiler", title_source: "claude_ai_title", first_event_at: "2026-09-28T14:05:00Z", last_event_at: "2026-09-28T14:51:00Z", tokens: { input: 8700, output: 2200, total: 10900 } },
    { id: "fixture-session-003", harness: "codex", first_event_at: "2026-09-17T07:20:00Z", last_event_at: "2026-09-17T08:02:00Z", tokens: { input: 22100, output: 5400, total: 27500 } },
  ];
  const sessions = allSessions.filter((session) => session.first_event_at >= from);
  const claudeId = sessions.some((session) => session.harness === "claude-code") ? "claude-code" : "claude_code";
  return {
    protocol: "city:v2",
    source: "fixture",
    harnesses: [{ id: "codex", display_name: "Codex" }, { id: claudeId, display_name: "Claude Code" }, { id: "dsh", display_name: "DSH" }, { id: "workbuddy", display_name: "WorkBuddy" }].map((h) => ({ ...h,
      capabilities: { session_statistics: { available: true }, findings: { available: true, reason: null } } })),
    generated_at: "2026-10-03T12:00:00Z",
    window: { days: windowDays, label: `最近 ${windowDays} 天`, from, to: "2026-10-03T00:00:00Z" },
    sessions,
    findings: [
      { harness: "codex", severity: "warning", count: 2 },
      { harness: "claude_code", severity: "info", count: 1 },
    ],
    coverage: { total: sessions.length, returned: sessions.length, truncated: false, unknown_time: 0 },
    status: "ready",
  };
}

/** 演示城市（standalone ?demo=1）：确定性生成 ~280 条会话，让浏览器里的城市达到
 * 真实规模（路网 + 楼群 + 背景聚合楼），供驾驶 UAT 等需要完整城市场面的测试。
 * 仅在非嵌入（standalone）浏览器预览生效——嵌入宿主永不读它，隔离测试的
 * `__CITY_ISOLATION_FIXTURE__` 也不经过这里。 */
function demoCityProjection(windowDays: 7 | 30 | 90 | 366): CityProjectionV1 {
  const windowEndMs = Date.parse("2026-10-03T00:00:00Z");
  const from = ({ 7: "2026-09-27T00:00:00Z", 30: "2026-09-03T00:00:00Z", 90: "2026-07-06T00:00:00Z", 366: "2025-10-03T00:00:00Z" } as const)[windowDays];
  // mulberry32：确定性，刷新/重跑同一城市。
  let seed = 0x63697479;
  const random = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const harnesses = ["codex", "claude_code"] as const;
  const sessions: CityProjectionV1["sessions"] = [];
  for (let index = 0; index < 280; index += 1) {
    // 90 天内偏近期分布（每天 1~6 条），366 天窗口额外铺一批历史楼。
    const daysAgo = Math.floor(random() * (windowDays >= 366 ? 300 : 88));
    const dayStart = windowEndMs - (daysAgo + 1) * 86400000;
    const start = dayStart + Math.floor(random() * 10 + 1) * 3600000;
    const durationMinutes = 12 + Math.floor(random() * 110);
    const input = 3000 + Math.floor(random() * 90000);
    const output = 800 + Math.floor(random() * 12000);
    const harness = harnesses[Math.floor(random() * harnesses.length)];
    sessions.push({
      id: `demo-session-${String(index + 1).padStart(3, "0")}`,
      harness,
      // 每 4 条给 1 条标题（其余保持无标题：验证 fallback 命名路径）。
      ...(index % 4 === 0
        ? { title: `演示会话 ${index + 1}：${harness === "codex" ? "rollout 解析" : "evidence 对拍"}`, title_source: harness === "codex" ? ("codex_thread_name" as const) : ("claude_ai_title" as const) }
        : {}),
      first_event_at: new Date(start).toISOString().replace(/\.\d+Z$/, "Z"),
      last_event_at: new Date(start + durationMinutes * 60000).toISOString().replace(/\.\d+Z$/, "Z"),
      tokens: { input, output, total: input + output },
    });
  }
  const visible = sessions.filter((session) => session.first_event_at >= from);
  return {
    protocol: "city:v2",
    source: "fixture",
    harnesses: [{ id: "codex", display_name: "Codex" }, { id: "claude_code", display_name: "Claude Code" }].map((h) => ({ ...h,
      capabilities: { session_statistics: { available: true }, findings: { available: true, reason: null } } })),
    generated_at: "2026-10-03T12:00:00Z",
    window: { days: windowDays, label: `最近 ${windowDays} 天`, from, to: "2026-10-03T00:00:00Z" },
    sessions: visible,
    findings: [
      { harness: "codex", severity: "warning", count: Math.floor(visible.length * 0.08) },
      { harness: "codex", severity: "info", count: Math.floor(visible.length * 0.05) },
      { harness: "claude_code", severity: "warning", count: Math.floor(visible.length * 0.04) },
    ],
    coverage: { total: visible.length, returned: visible.length, truncated: false, unknown_time: 0 },
    status: "ready",
  };
}

declare global {
  interface Window {
    __CITY_ISOLATION_FIXTURE__?: boolean;
    __TAURI__?: {
      core?: {
        invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
      };
    };
  }
}

/** Explicit synthetic aggregates for previewing facility panels; never a fallback for local data. */
function completeFixture(projection: CityProjectionV1): CityProjectionV1 {
  const days = new Map<string, { date: string; session_count: number; event_count: number; tokens: number }>();
  const sessions = projection.sessions.map((session) => {
    const day=session.first_event_at.slice(0,10);
    const item=days.get(day) ?? {date:day,session_count:0,event_count:0,tokens:0};
    item.session_count++; item.event_count+=session.event_count ?? 1; item.tokens+=session.tokens.total; days.set(day,item);
    return { ...session, event_count: session.event_count ?? 1,
      tokens: { ...session.tokens, uncached_input: session.tokens.input, cache_read: 0, cache_write: 0 },
      model_ids: [`fixture/${session.harness}-model`] };
  });
  const tokens=sessions.reduce((sum,s)=>({input:sum.input+s.tokens.input,output:sum.output+s.tokens.output,total:sum.total+s.tokens.total}),{input:0,output:0,total:0});
  const activity=[...days.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const busiest=[...activity].sort((a,b)=>b.session_count-a.session_count || b.tokens-a.tokens || b.date.localeCompare(a.date))[0] ?? null;
  return { ...projection, sessions, summary:{session_count:sessions.length,usage_event_count:sessions.reduce((n,s)=>n+s.event_count,0),
      tokens:{...tokens,uncached_input:tokens.input,cache_read:0,cache_write:0}},
    models:[...new Set(sessions.flatMap((s)=>s.model_ids))].sort(),
    model_coverage:{unknown_model_usage_events:0,legacy_usage_events:0},activity:{days:activity,busiest_day:busiest,timezone:"UTC"} };
}

async function applyLegacyBookmarkCrosswalk(
  projection: CityProjectionV1,
  legacyRefs: readonly string[],
  legacySourceRevision: string,
  dataRevision: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!legacyRefs.length) return;
  if (signal?.aborted) throw new Error("city_request_cancelled");
  if (projection.data_revision !== dataRevision) {
    throw new Error("city_asset_crosswalk_revision_changed");
  }
  const result = await readLegacyCityAssetCrosswalk(legacyRefs, legacySourceRevision, dataRevision);
  if (signal?.aborted) throw new Error("city_request_cancelled");
  if (result.dataRevision !== projection.data_revision || result.sourceRevision !== legacySourceRevision) {
    throw new Error("city_asset_crosswalk_revision_changed");
  }
  const matched = result.pairs.map(({ asset_ref, stable_ref }) => ({ legacyAssetRef: asset_ref, stableRef: stable_ref }));
  const objectClient = await cityBuildingObjectClient() as unknown as CityAssetBookmarkObjectClient;
  await reconcileLegacyCityAssetIdentities(objectClient, matched.map(({ legacyAssetRef, stableRef }) => ({ legacyAssetRef, stableRef })));
  for (let offset = 0; offset < matched.length; offset += 8) {
    await Promise.all(matched.slice(offset, offset + 8).map(({ legacyAssetRef, stableRef }) =>
      ensureCityAssetObject(objectClient, legacyAssetRef, stableRef)));
  }
  const currentStableByAsset = stableAssetRefsForProjection(projection);
  const currentByStableRef = new Map(projection.sessions.flatMap((session) => {
    const stableRef = session.asset_ref ? currentStableByAsset.get(session.asset_ref) : undefined;
    return stableRef ? [[stableRef, session] as const] : [];
  }));
  const assetRefs = new Map(currentStableByAsset);
  for (const { legacyAssetRef, stableRef } of matched) {
    const session = currentByStableRef.get(stableRef);
    if (!session) continue;
    const projectedAssetRef = session.asset_ref;
    session.asset_ref = legacyAssetRef;
    if (projectedAssetRef) assetRefs.delete(projectedAssetRef);
    assetRefs.set(legacyAssetRef, stableRef);
  }
  rememberStableAssetRefs(projection, assetRefs);
  (window as Window & { __CITY_ASSET_CROSSWALK_ROLLOUT__?: unknown }).__CITY_ASSET_CROSSWALK_ROLLOUT__ = {
    source: "typed-legacy-crosswalk", status: "bookmark-migration", dataRevision: projection.data_revision,
    sourceRevision: legacySourceRevision, matched: matched.length, unresolved: result.unresolved.length,
  };
}
export type BuildingOverrideRow = { asset_ref: string; revision: number; kit_version: string; source: string; model: KitModel; updated_at_ms?: number };
export type BuildingOverridesResult = {
  overrides: BuildingOverrideRow[];
  objectStates: Array<{ asset_ref: string; state: CityBuildingObjectSnapshot }>;
};

function parseOverrideRow(raw: unknown, tokensByAsset: ReadonlyMap<string, number>): BuildingOverrideRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.asset_ref !== "string" || !/^ca_[0-9a-f]{32}$/.test(row.asset_ref)) return null;
  if (typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0) return null;
  const stored = row.stored_document ?? row.model;
  let candidate = stored;
  if (isInheritanceDocument(stored)) {
    const tokens = tokensByAsset.get(row.asset_ref);
    if (tokens === undefined || !Number.isSafeInteger(tokens) || tokens < 0) return null;
    try { candidate = resolveInheritance(defaultKitModel(tokens), stored); }
    catch { return null; }
  }
  const model = parseKitModel(candidate);
  if (!model) return null;
  return { asset_ref: row.asset_ref, revision: row.revision, kit_version: model.kit_version,
    source: typeof row.source === "string" ? row.source : "override", model,
    ...(typeof row.updated_at_ms === "number" && Number.isSafeInteger(row.updated_at_ms) && row.updated_at_ms >= 0 ? { updated_at_ms: row.updated_at_ms } : {}) };
}

export async function cityBuildingObjectClient(): Promise<CityBuildingObjectClient> {
  const instanceId = window.__AV_PLUGIN_INSTANCE__;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedObjectClient }] = await Promise.all([import("@agent-vitals/app-sdk")]);
  return createTypedObjectClient(instanceId, (request) =>
    invokeHost<PluginResponseV1<TypedObjectResultV1>>("plugin_request", { request })) as CityBuildingObjectClient;
}

// Session refs already migrated during this WebView lifetime no longer need the
// City-specific v3 read path. Generic object revisions are the live poll source.
const legacyBuildingSnapshotResolved = new Set<string>();
const legacyBuildingSnapshotInFlight = new Set<string>();
const legacyBuildingSnapshotByAsset = new Map<string, BuildingOverrideRow | null>();
const cityAssetCrosswalkResolved = new Set<string>();
let legacyBuildingRowsPromise: Promise<{ rows: unknown[]; sourceRevision: string }> | null = null;

/** Read old building rows through the descriptor-scoped typed migration dataset. */
async function readLegacyBuildingRows(expectedRevision?: string): Promise<{ rows: unknown[]; sourceRevision: string }> {
  if (legacyBuildingRowsPromise) {
    const cached = await legacyBuildingRowsPromise;
    if (expectedRevision === undefined || cached.sourceRevision === expectedRevision) return cached;
    throw new Error("city_legacy_source_changed");
  }
  legacyBuildingRowsPromise = readLegacyCityStoreSnapshot().then((snapshot) => {
    if (expectedRevision !== undefined && snapshot.sourceRevision !== expectedRevision) throw new Error("city_legacy_source_changed");
    return { rows: snapshot.buildingRows, sourceRevision: snapshot.sourceRevision };
  }).catch((error) => {
    legacyBuildingRowsPromise = null;
    throw error;
  });
  return legacyBuildingRowsPromise;
}

async function findUnmappedLegacyAssetRefs(refs: readonly string[]): Promise<string[]> {
  const unique = [...new Set(refs)];
  if (unique.length > 4_000) throw new Error("city_legacy_asset_limit");
  if (!unique.length) return [];
  const client = await cityBuildingObjectClient() as unknown as CityAssetBookmarkObjectClient;
  const mapped = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += 200) {
    const aliases = unique.slice(offset, offset + 200);
    const page = await client.list({ objectType: "city.asset:v1", schemaVersion: 1, aliases });
    if (page.hasMore || page.nextCursor !== null || page.objects.length > aliases.length) throw new Error("city_asset_identity_invalid");
    const requested = new Set(aliases);
    for (const object of page.objects) {
      const assetRef = object.body?.assetRef;
      const stableRef = object.body?.sourceRef;
      if (object.schemaVersion !== 1 || object.deleted || !object.body || object.body.schema !== "city-asset-ref:v1"
          || Object.keys(object.body).length !== 3 || typeof assetRef !== "string" || !/^ca_[0-9a-f]{32}$/.test(assetRef)
          || (stableRef !== null && (typeof stableRef !== "string" || !/^srp_[a-f0-9]{32}$/.test(stableRef)))) {
        throw new Error("city_asset_identity_invalid");
      }
      if (typeof stableRef === "string" && requested.has(assetRef)) mapped.add(assetRef);
    }
  }
  return unique.filter((assetRef) => !mapped.has(assetRef));
}

/** Import typed legacy building rows once per asset ref, then poll generic objects. */
export async function readBuildingOverrides(assetRefs: string[],
  stableAssetRefs: ReadonlyMap<string, string> = new Map(), tokensByAsset: ReadonlyMap<string, number> = new Map()): Promise<BuildingOverridesResult> {
  const overrides: BuildingOverrideRow[] = [];
  const objectStates: Array<{ asset_ref: string; state: CityBuildingObjectSnapshot }> = [];
  const seen = new Set<string>();
  let typedObjectClient: CityBuildingObjectClient | null = null;
  let imported = 0;
  let matched = 0;
  let genericAuthoritative = 0;
  let conflicts = 0;
  let missing = 0;
  const refs = [...new Set(assetRefs.filter((id) => /^ca_[0-9a-f]{32}$/.test(id)))];
  for (const [assetRef, stableRef] of stableAssetRefs) {
    if (!/^ca_[0-9a-f]{32}$/.test(assetRef) || !/^srp_[a-f0-9]{32}$/.test(stableRef)) throw new Error("typed_city_stable_ref_invalid");
  }
  const slices = refs.length ? Array.from({ length: Math.ceil(refs.length / 200) }, (_, index) => refs.slice(index * 200, index * 200 + 200)) : [[]];
  for (const slice of slices) {
    const legacySlice = slice.filter((assetRef) => !legacyBuildingSnapshotResolved.has(assetRef) && !legacyBuildingSnapshotInFlight.has(assetRef));
    legacySlice.forEach((assetRef) => legacyBuildingSnapshotInFlight.add(assetRef));
    let legacySnapshotReady = false;
    try {
      const rawOverrides = legacySlice.length
        ? (await readLegacyBuildingRows()).rows.filter((item) => {
          const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
          return typeof row?.asset_ref === "string" && legacySlice.includes(row.asset_ref);
        })
        : [];
      if (legacySlice.length) legacySnapshotReady = true;
      const legacyOverrideRefs = new Set(rawOverrides.flatMap((item) => {
        const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
        return typeof row?.asset_ref === "string" && legacySlice.includes(row.asset_ref) ? [row.asset_ref] : [];
      }));
      const legacyHandledRefs = new Set<string>();
      const stableRefsForPage = [...new Set(slice.flatMap((assetRef) => {
        const stableRef = stableAssetRefs.get(assetRef);
        return stableRef ? [stableRef] : [];
      }))];
      let prefetchedObjects = new Map<string, CityBuildingStoredObject>();
      let prefetchComplete = false;
      if (stableRefsForPage.length) {
        try {
          typedObjectClient ??= await cityBuildingObjectClient();
          prefetchedObjects = await listCityBuildingObjectsByStableRef(typedObjectClient, stableRefsForPage);
          prefetchComplete = true;
        } catch { /* fall back to scoped readByAlias requests below */ }
      }
      const genericByAsset = new Map<string, CityBuildingObjectSnapshot>();
      const objectStateByAsset = new Map<string, CityBuildingObjectSnapshot>();
      if (stableRefsForPage.length && typedObjectClient) {
        for (const assetRef of slice) {
          const stableRef = stableAssetRefs.get(assetRef);
          if (!stableRef) continue;
          try {
            const stored = prefetchComplete ? prefetchedObjects.get(stableRef) ?? null : undefined;
            const state = await readCityBuildingObject(typedObjectClient, stableRef, stored);
            if (state) {
              objectStateByAsset.set(assetRef, state);
              if (state.authority === "generic-object") {
                genericByAsset.set(assetRef, state);
                genericAuthoritative += 1;
              }
            }
          } catch { missing += 1; /* Keep legacy fallback when the generic object is unavailable or malformed. */ }
        }
      }
      for (const item of rawOverrides) {
        let row = parseOverrideRow(item, tokensByAsset);
        if (row && !seen.has(row.asset_ref)) {
          const generic = genericByAsset.get(row.asset_ref);
          if (generic) {
            legacyHandledRefs.add(row.asset_ref);
            seen.add(row.asset_ref);
            if (generic.model) overrides.push({ asset_ref: row.asset_ref, revision: generic.domainRevision,
              kit_version: generic.model.kit_version, source: "generic-object", model: generic.model,
              ...(generic.updatedAtMs === undefined ? {} : { updated_at_ms: generic.updatedAtMs }) });
            continue;
          }
          const stableRef = stableAssetRefs.get(row.asset_ref);
          if (stableRef) {
            try {
              typedObjectClient ??= await cityBuildingObjectClient();
              // Persist the legacy ca_* ↔ stable source-ref crosswalk in the
              // generic asset object store while the old session page still
              // supplies both identities. This lets later readers stop calling
              // the City-specific asset registry without losing saved assets.
              const crosswalkKey = `${row.asset_ref}\0${stableRef}`;
              if (!cityAssetCrosswalkResolved.has(crosswalkKey)) {
                await ensureCityAssetObject(typedObjectClient as unknown as CityAssetBookmarkObjectClient, row.asset_ref, stableRef);
                if (cityAssetCrosswalkResolved.size >= 4_000) cityAssetCrosswalkResolved.clear();
                cityAssetCrosswalkResolved.add(crosswalkKey);
              }
            } catch { missing += 1; /* Preserve legacy building reads if crosswalk migration is unavailable. */ }
            try {
              typedObjectClient ??= await cityBuildingObjectClient();
              const migrated = await importLegacyBuildingOverride(typedObjectClient, stableRef, row,
                prefetchComplete ? prefetchedObjects.get(stableRef) ?? null : undefined);
              if (migrated.state === "imported") imported += 1;
              else if (migrated.state === "matched") matched += 1;
              else if (migrated.state === "conflict" || migrated.state === "invalid") conflicts += 1;
              else missing += 1;
              if (migrated.state === "imported" || migrated.state === "matched") {
                legacyHandledRefs.add(row.asset_ref);
                legacyBuildingSnapshotByAsset.set(row.asset_ref, row);
              }
              // The typed legacy export remains authoritative until the typed object and
              // old row agree; imported objects never change this frame's result.
              if ((migrated.state === "imported" || migrated.state === "matched") && migrated.model) row = { ...row, model: migrated.model };
            } catch { missing += 1; /* object grant or transport unavailable: keep the legacy row */ }
          }
          seen.add(row.asset_ref); overrides.push(row);
        }
      }
      for (const [assetRef, generic] of genericByAsset) {
        if (seen.has(assetRef)) continue;
        seen.add(assetRef);
        if (generic.model) overrides.push({ asset_ref: assetRef, revision: generic.domainRevision,
          kit_version: generic.model.kit_version, source: "generic-object", model: generic.model,
          ...(generic.updatedAtMs === undefined ? {} : { updated_at_ms: generic.updatedAtMs }) });
      }
      for (const assetRef of slice) {
        if (seen.has(assetRef)) continue;
        const cachedLegacy = legacyBuildingSnapshotByAsset.get(assetRef);
        if (cachedLegacy) {
          seen.add(assetRef);
          overrides.push(cachedLegacy);
        }
      }
      for (const [assetRef, state] of objectStateByAsset) objectStates.push({ asset_ref: assetRef, state });
      if (legacySnapshotReady) {
        for (const assetRef of legacySlice) {
          if (!legacyOverrideRefs.has(assetRef)) {
            legacyBuildingSnapshotByAsset.set(assetRef, null);
            legacyBuildingSnapshotResolved.add(assetRef);
          } else if (legacyHandledRefs.has(assetRef)) legacyBuildingSnapshotResolved.add(assetRef);
        }
      }
    } finally {
      legacySlice.forEach((assetRef) => legacyBuildingSnapshotInFlight.delete(assetRef));
    }
  }
  if (typeof window !== "undefined" && stableAssetRefs.size) {
    (window as Window & { __CITY_TYPED_BUILDING_OBJECTS__?: unknown }).__CITY_TYPED_BUILDING_OBJECTS__ = {
      status: conflicts ? "parity_conflict" : genericAuthoritative > 0 ? "authoritative" : imported + matched > 0 ? "active" : "not_migrated",
      imported, matched, genericAuthoritative, conflicts, missing,
    };
  }
  return { overrides, objectStates };
}
function mapTypedSessionDetail(base: CityProjectionV1["sessions"][number], typed: CityTypedSessionDetail): CityProjectionV1["sessions"][number] {
  const session = typed.detail.session;
  const excerpts = typed.excerpts.excerpts.map((excerpt) => {
    if (!["verbatim", "truncated", "scrubbed"].includes(excerpt.provenance)) throw new Error("typed_city_detail_excerpt_invalid");
    return { role: excerpt.role, text: excerpt.text, provenance: excerpt.provenance as "verbatim" | "truncated" | "scrubbed", is_excerpt: true as const };
  });
  const cost = typed.cost.cost;
  return {
    ...base,
    id: session.id,
    harness: session.harness,
    title: session.title,
    title_source: session.title_source,
    first_event_at: session.first_event_at,
    last_event_at: session.last_event_at,
    window_first_event_at: session.window_first_event_at,
    window_last_event_at: session.window_last_event_at,
    lifetime_first_event_at: session.lifetime_first_event_at,
    lifetime_last_event_at: session.lifetime_last_event_at,
    tokens: session.tokens,
    event_count: session.event_count,
    usage_event_count: session.event_count,
    model_ids: session.model_ids,
    model_coverage: session.model_coverage,
    title_state: session.title ? "available" : "unavailable",
    task_excerpts: excerpts,
    excerpt_scope: "session_lifetime_not_window",
    cost_minor: cost.cost_minor,
    cost_breakdown: cost.breakdown,
    cost_complete: cost.complete,
    cost_reference_prices: cost.reference_prices,
    cost_status: { state: cost.status, reason: cost.reason, has_unresolved: cost.has_unresolved },
  } as unknown as CityProjectionV1["sessions"][number];
}
export async function readCitySessionDetail(projection: CityProjectionV1, id: string, signal?: AbortSignal): Promise<CityProjectionV1["sessions"][number]> {
  const base = projection.sessions.find((session) => session.id === id);
  if (!base) throw new Error("session_unavailable");
  if (projection.source !== "local") return base;
  if (signal?.aborted) throw new Error("city_request_cancelled");
  const target = window as Window & { __CITY_TYPED_SESSION_DETAIL_ROLLOUT__?: unknown };
  try {
    const typed = await readTypedCitySessionDetailFromHost({ sessionRef: id, windowDays: projection.window.days }, signal);
    if (typed.detail.session.id !== id) throw new Error("typed_city_detail_session_mismatch");
    if (signal?.aborted) throw new Error("city_request_cancelled");
    target.__CITY_TYPED_SESSION_DETAIL_ROLLOUT__ = { source: "typed", status: "authoritative",
      dataRevision: typed.detail.dataRevision, sessionRef: id };
    return mapTypedSessionDetail(base, typed);
  } catch (error) {
    target.__CITY_TYPED_SESSION_DETAIL_ROLLOUT__ = { source: "typed", status: "unavailable",
      reason: error instanceof Error ? error.message : "typed_city_detail_unavailable", sessionRef: id };
    throw error;
  }
}
export async function readCityModule(projection: CityProjectionV1, module: "findings" | "skills" | "workflow", signal?: AbortSignal, _fresh = false, harness?: string) {
  if (projection.source !== "local") return { source: "fixture" as const, window: projection.window, generated_at: projection.generated_at,
    result: module === "findings" ? { state: "ready", supported: true, data: { current_backlog: projection.findings.filter((row) => !harness || row.harness === harness), window_new: [], detail_state: "unsupported" } }
      : module === "skills" ? { state: "ready", supported: true, data: { coverage: "synthetic_fixture", inventory_included: false, truncated: false,
        skills: projection.harnesses.filter((item) => !harness || item.id === harness).map((item) => ({ harness: item.id,
          skill: "demo-code-review", invocations: 3, sessions: 2, finished_events: 2, failed_events: 1, succeeded_events: 1,
          last_invoked_at_ms: Date.parse(projection.window.to) - 60000 })) } }
      : { state: "ready", supported: true, data: { coverage: "synthetic_fixture", truncated: false, outcome_scope: "unpaired_events",
        events: projection.harnesses.filter((item) => !harness || item.id === harness).map((item) => ({ harness: item.id,
          event_type: "tool_finished", events: 3, sessions: 2, failed_events: 1, last_event_at_ms: Date.parse(projection.window.to) - 60000 })) } } };
  if (signal?.aborted) throw new Error("city_request_cancelled");
  let revision: number;
  let fromMs: number;
  let toMs: number;
  let result: CityModuleV3;
  if (module === "findings") {
    const typed = await readTypedCityFindingShadowFromHost(projection.window.days);
    if (signal?.aborted) throw new Error("city_request_cancelled");
    revision = typed.dataRevision;
    fromMs = typed.window.fromMs;
    toMs = typed.window.toMs;
    if (typed.windowDays !== projection.window.days || toMs - fromMs !== projection.window.days * 86_400_000) {
      throw new Error("typed_city_module_window_invalid");
    }
    const data = {
      current_backlog: typed.current_backlog.map((row) => ({ harness: row.harness_id, severity: row.severity, count: row.count })),
      window_new: typed.window_new.map((row) => ({ harness: row.harness_id, severity: row.severity, count: row.count })),
      capabilities: typed.capabilities.map((row) => {
        const identity = projection.harnesses.find((item) => item.id === row.harness_id);
        return identity ? { ...identity, capabilities: { ...identity.capabilities,
          findings: { available: row.available, reason: row.reason } } }
          : { id: row.harness_id, display_name: row.harness_id, capabilities: { findings: { available: row.available, reason: row.reason } } };
      }),
      detail_state: "unsupported",
    };
    const scopedData = harness ? { ...data,
      current_backlog: data.current_backlog.filter((row) => row.harness === harness),
      window_new: data.window_new.filter((row) => row.harness === harness),
      capabilities: data.capabilities.filter((row) => row.id === harness),
    } : data;
    const supported = scopedData.capabilities.some((row) => row.capabilities.findings.available);
    result = { state: !supported ? "unsupported" : scopedData.current_backlog.length || scopedData.window_new.length ? "ready" : "empty",
      supported, data: scopedData };
  } else {
    const { skills, workflow } = await readTypedCitySkillWorkflowShadowFromHost(projection.window.days);
    if (signal?.aborted) throw new Error("city_request_cancelled");
    if (skills.dataRevision !== workflow.dataRevision || skills.windowDays !== workflow.windowDays
        || skills.window.fromMs !== workflow.window.fromMs || skills.window.toMs !== workflow.window.toMs
        || skills.windowDays !== projection.window.days || skills.window.toMs - skills.window.fromMs !== projection.window.days * 86_400_000) {
      throw new Error("typed_city_module_snapshot_mismatch");
    }
    revision = skills.dataRevision;
    fromMs = skills.window.fromMs;
    toMs = skills.window.toMs;
    const rows = module === "skills" ? skills.skills.map((row) => ({ harness: row.harness_id, skill: row.label,
      invocations: row.invocations, sessions: row.sessions, last_invoked_at_ms: row.last_invoked_at_ms,
      finished_events: row.finished_events, failed_events: row.failed_events, succeeded_events: row.succeeded_events }))
      : workflow.events.map((row) => ({ harness: row.harness_id,
        event_type: row.event_type, events: row.count, sessions: row.sessions, last_event_at_ms: row.last_event_at_ms,
        failed_events: row.failed_events }));
    const scopedRows = harness ? rows.filter((row) => row.harness === harness) : rows;
    const rawData: Record<string, unknown> = module === "skills"
      ? { skills: scopedRows, truncated: skills.truncated, coverage: skills.coverage,
        outcome_scope: skills.outcomeScope, inventory_included: skills.inventoryIncluded }
      : { events: scopedRows, truncated: workflow.truncated, coverage: workflow.coverage, outcome_scope: workflow.outcomeScope };
    result = { state: scopedRows.length ? "ready" : "empty", supported: true, data: rawData };
  }
  if (signal?.aborted) throw new Error("city_request_cancelled");
  (window as Window & { __CITY_TYPED_MODULE_ROLLOUT__?: unknown }).__CITY_TYPED_MODULE_ROLLOUT__ = {
    module, source: "typed", status: "authoritative", dataRevision: revision,
    window: { fromMs, toMs },
  };
  return { source: "local" as const, result, window: { days: projection.window.days,
    from_ms: fromMs, to_ms: toMs, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
    timezone: projection.activity?.timezone ?? "UTC", calendar_mode: "rolling" as const, boundary: "half_open" as const },
    generated_at: new Date().toISOString() };
}
async function readTypedProjection(windowDays: 7 | 30 | 90 | 366, signal?: AbortSignal,
  onStage?: (stage: "reading_summary" | "reading_sessions" | "ready") => void,
  pin?: { toMs: number; dataRevision: number }): Promise<CityProjectionV1> {
  onStage?.("reading_summary");
  const [sessions, harnesses] = await Promise.all([
    readTypedCitySessionShadowFromHost(windowDays, signal, pin),
    (async () => {
      const instanceId = window.__AV_PLUGIN_INSTANCE__;
      if (!instanceId) throw new Error("plugin_instance_unavailable");
      const [{ createHarnessDataClient }] = await Promise.all([import("@agent-vitals/app-sdk")]);
      const client = createHarnessDataClient(instanceId, (request) => invokeHost<PluginResponseV1>("plugin_request", { request }));
      return client.list();
    })(),
  ]);
  if (signal?.aborted) throw new Error("city_request_cancelled");
  if (sessions.dataRevision !== harnesses.data_revision) throw new Error("revision_changed");
  const stableRefs = await readTypedCityStableRefsFromHost(windowDays, {
    toMs: sessions.window.toMs, dataRevision: sessions.dataRevision,
  }, signal);
  if (stableRefs.dataRevision !== sessions.dataRevision || stableRefs.window.fromMs !== sessions.window.fromMs
      || stableRefs.window.toMs !== sessions.window.toMs || stableRefs.bySessionId.size !== sessions.sessions.length) {
    throw new Error("typed_city_stable_ref_parity");
  }
  const stableRefBySessionId = new Map<string, string>();
  for (const session of sessions.sessions) {
    const stableRef = stableRefs.bySessionId.get(session.id);
    if (!stableRef) throw new Error("typed_city_stable_ref_parity");
    stableRefBySessionId.set(session.id, stableRef);
  }
  const objectClient = await cityBuildingObjectClient();
  const assetRefByStableRef = await resolveCityAssetRefsByStableRef(
    objectClient as unknown as CityAssetBookmarkObjectClient, [...stableRefBySessionId.values()]);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const typedValues = await promoteCityTypedWindowValues({
    readers: {
      summary: readTypedCityUsageSummaryShadowFromHost,
      activity: readTypedCityActivityShadowFromHost,
      models: readTypedCityModelUsageShadowFromHost,
      timeCoverage: readTypedCityTimeCoverageShadowFromHost,
      findings: readTypedCityFindingShadowFromHost,
    },
    legacy: {}, windowDays, timezone,
    window: { fromMs: sessions.window.fromMs, toMs: sessions.window.toMs },
    dataRevision: sessions.dataRevision, signal,
  });
  const summary = typedValues.values.summary;
  if (!summary?.tokens || !Number.isSafeInteger(summary.session_count) || !Number.isSafeInteger(summary.usage_event_count)
      || !Number.isSafeInteger(summary.tokens.input) || !Number.isSafeInteger(summary.tokens.output)
      || !Number.isSafeInteger(summary.tokens.total)) throw new Error("typed_city_summary_unavailable");
  const models = typedValues.values.models;
  const timeCoverage = typedValues.values.timeCoverage;
  const findings = typedValues.values.findings;
  const activityData = typedValues.values.activity;
  const assetRefs = new Map<string, string>();
  const projectionSessions = sessions.sessions.map((session) => {
    const stableRef = stableRefBySessionId.get(session.id)!;
    const assetRef = assetRefByStableRef.get(stableRef);
    if (!assetRef) throw new Error("city_asset_identity_invalid");
    assetRefs.set(assetRef, stableRef);
    return {
      id: session.id, harness: session.harness,
      title: session.title ?? null, title_source: session.title_source ?? null,
      title_state: session.title_state, asset_ref: assetRef,
      first_event_at: session.lifetime_first_event_at ?? session.first_event_at,
      last_event_at: session.lifetime_last_event_at ?? session.last_event_at,
      window_first_event_at: session.first_event_at, window_last_event_at: session.last_event_at,
      lifetime_first_event_at: session.lifetime_first_event_at, lifetime_last_event_at: session.lifetime_last_event_at,
      layout_order: session.window_order, event_count: session.event_count, usage_event_count: session.event_count,
      tokens: { ...session.tokens }, model_ids: [...session.model_ids], model_coverage: { ...session.model_coverage },
      cost_minor: null,
      cost_status: { state: "unavailable" as const, reason: "load_on_demand", has_unresolved: false },
    };
  });
  onStage?.("reading_sessions");
  const projection = validateCityProjectionV2({
    protocol: "city:v2", source: "local", data_revision: sessions.dataRevision,
    generated_at: new Date().toISOString(), harnesses: harnesses.harnesses,
    window: { days: windowDays, label: `最近 ${windowDays} 天`, from: new Date(sessions.window.fromMs).toISOString(), to: new Date(sessions.window.toMs).toISOString() },
    sessions: projectionSessions,
    summary: { ...summary, tokens: { ...summary.tokens } },
    models: models?.models.map((row) => row.model_id).filter((id): id is string => typeof id === "string") ?? [],
    model_coverage: models ? {
      unknown_model_usage_events: models.coverage.unknown_model_usage_events ?? 0,
      legacy_usage_events: models.coverage.legacy_usage_events ?? 0,
    } : undefined,
    activity: activityData ? {
      timezone: activityData.timezone,
      days: activityData.days.map((row) => ({ date: row.date!, session_count: row.session_count!, event_count: row.event_count!, tokens: row.tokens! })),
      busiest_day: activityData.days.reduce((best, row) => !best || (row.tokens ?? 0) > (best.tokens ?? 0)
        ? { date: row.date!, session_count: row.session_count!, event_count: row.event_count!, tokens: row.tokens! } : best, null as CityProjectionV1["activity"] extends { busiest_day: infer T } ? T : never),
    } : undefined,
    findings: findings?.current_backlog.map((row) => ({ harness: row.harness_id, severity: row.severity, count: row.count })) ?? [],
    coverage: {
      total: sessions.coverage.total, returned: sessions.coverage.returned, truncated: sessions.coverage.truncated,
      unknown_time: (timeCoverage?.unknown_time_only ?? 0) + (timeCoverage?.mixed_time ?? 0),
      unknown_time_semantics: "compat_any_untimed_fact_all_sessions",
      time_classification: timeCoverage,
      findings_state: findings ? "partial" : "unavailable",
    },
    status: sessions.coverage.total > 0 ? "ready" : "empty",
  });
  rememberStableAssetRefs(projection, assetRefs);
  (window as Window & { __CITY_TYPED_SESSION_ROLLOUT__?: unknown }).__CITY_TYPED_SESSION_ROLLOUT__ = {
    source: "typed", status: "authoritative", dataRevision: sessions.dataRevision,
    count: sessions.coverage.returned, total: sessions.coverage.total,
  };
  (window as Window & { __CITY_TYPED_MODULE_ROLLOUT__?: unknown }).__CITY_TYPED_MODULE_ROLLOUT__ = {
    source: "typed", values: typedValues.statuses, dataRevision: sessions.dataRevision,
    window: { fromMs: sessions.window.fromMs, toMs: sessions.window.toMs },
  };
  onStage?.("ready");
  return projection;
}

/** Typed-only projection with a revision-pinned migration bridge for old City asset IDs. */
async function readTypedProjectionWithLegacyMigration(windowDays: 7 | 30 | 90 | 366, signal?: AbortSignal,
  onStage?: (stage: "reading_summary" | "reading_sessions" | "ready") => void): Promise<CityProjectionV1> {
  const legacySnapshot = await readLegacyCityStoreSnapshot();
  legacyBuildingRowsPromise = Promise.resolve({ rows: legacySnapshot.buildingRows, sourceRevision: legacySnapshot.sourceRevision });
  const legacyRefs = new Set([...legacySnapshot.bookmarkRefs, ...legacySnapshot.claimRefs]);
  for (const item of legacySnapshot.buildingRows) {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
    if (typeof row?.asset_ref === "string" && /^ca_[0-9a-f]{32}$/.test(row.asset_ref)) legacyRefs.add(row.asset_ref);
  }
  const pendingLegacyRefs = await findUnmappedLegacyAssetRefs([...legacyRefs]);
  if (!pendingLegacyRefs.length) return readTypedProjection(windowDays, signal, onStage);
  const projection = await readTypedProjection(windowDays, signal, onStage);
  const dataRevision = projection.data_revision;
  if (typeof dataRevision !== "number" || !Number.isSafeInteger(dataRevision)) throw new Error("city_asset_crosswalk_revision_changed");
  await applyLegacyBookmarkCrosswalk(projection, pendingLegacyRefs, legacySnapshot.sourceRevision,
    dataRevision, signal);
  return projection;
}

export function reportCityScene(stage: "model" | "planning" | "mounting" | "rendering" | "first_frame",
  elapsedMs: number, windowDays: WindowDays): void {
  if (!embedded() || !window.__AV_PLUGIN_INSTANCE__) return;
  void invokeHost("plugin_message", { message: {
    version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, type: "plugin.performance",
    metric: "scene", outcome: "success", elapsedMs: Math.max(0, Math.round(elapsedMs)),
    dimensions: { stage, windowDays },
  } }).catch(() => {});
}

function reportCityLoad(outcome: "success" | "partial" | "cancelled" | "failed",
  started: number, windowDays: WindowDays, attempts: number, revisionRetries: number,
  fallback: "none", pageReturned?: number): void {
  if (!embedded() || !window.__AV_PLUGIN_INSTANCE__) return;
  void invokeHost("plugin_message", { message: {
    version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, type: "plugin.performance",
    metric: "data-load", outcome, elapsedMs: Math.max(0, Math.round(monotonicNow() - started)),
    dimensions: { attempt_count: attempts, revision_retry_count: revisionRetries, fallback, window_days: windowDays,
      ...(typeof pageReturned === "number" ? { page_returned: pageReturned } : {}) },
  } }).catch(() => {});
}

export const tauriCityDataProvider: CityDataProvider = {
  async getProjection({ windowDays, signal, onStage, onPartial }) {
    const standalone = !window.__AV_PLUGIN_INSTANCE__;
    if (standalone && new URLSearchParams(location.search).get("demo") === "1") return completeFixture(demoCityProjection(windowDays));
    // 浏览器预览（ui-dev 工作台 iframe）：有插件实例但没有原生宿主，typed 链与
    // legacy 桥都无法满足。按数据政策走合成夹具（界面如实标注「合成 fixture」），
    // 与独立页同一条路径，绝不把预览请求伪装成本机数据。
    if (!standalone && window.parent !== window && !(window as Window & { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core?.invoke) {
      return completeFixture(fixtureProjection(windowDays));
    }
    if (standalone || window.__CITY_ISOLATION_FIXTURE__) return completeFixture(fixtureProjection(windowDays));
    const started = monotonicNow();
    let attempts = 0, revisionRetries = 0;
    try {
      const projection = await retryCityProjection(() => readTypedProjectionWithLegacyMigration(windowDays, signal, onStage), {
        signal, delay: cityProjectionDelay, onAttempt: (count, code) => { attempts = count; if (code === "revision_changed") revisionRetries++; },
      });
      if (signal?.aborted) throw new Error("city_request_cancelled");
      onPartial?.(projection);
      reportCityLoad("success", started, windowDays, attempts, revisionRetries, "none", projection.coverage.returned);
      return projection;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.message === "city_request_cancelled")) {
        reportCityLoad("cancelled", started, windowDays, attempts, revisionRetries, "none");
      } else {
        const reason = cityProjectionErrorCode(error);
        (window as Window & { __CITY_TYPED_SESSION_ROLLOUT__?: unknown }).__CITY_TYPED_SESSION_ROLLOUT__ = {
          source: "typed", status: "unavailable", reason,
        };
        reportCityLoad("failed", started, windowDays, attempts, revisionRetries, "none");
      }
      throw error;
    }
  },
};
