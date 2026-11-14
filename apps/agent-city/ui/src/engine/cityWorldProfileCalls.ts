import type { CityWorldProfileV1 } from "@agent-vitals/city-sdk";
import {
  parseCityWorldProfileJson,
  readCityAppearancePreference,
  readCityWorldProfilePreference,
  writeCityWorldProfileJson,
} from "./cityWorldProfile";

const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_PREVIEWS = 16;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;

type Preview = Readonly<{
  instanceId: string;
  baseProfile: string;
  profile: CityWorldProfileV1;
  expiresAt: number;
}>;
type AppliedOperation = Readonly<{ fingerprint: string; result: Record<string, unknown> }>;

export type CityWorldProfileCallOptions = Readonly<{
  instanceId: () => string | null;
  canApply: () => boolean;
  onApplied: (profile: CityWorldProfileV1) => void;
  now?: () => number;
  createPreviewId?: () => string;
}>;

/**
 * Agent world edits use a two-step, instance-bound preview capability. The
 * profile stays in the trusted City WebView and is revalidated before storage.
 */
export function createCityWorldProfileCallHandlers(options: CityWorldProfileCallOptions) {
  const previews = new Map<string, Preview>();
  const operations = new Map<string, AppliedOperation>();
  let sequence = 0;
  const now = options.now ?? (() => Date.now());
  const createPreviewId = options.createPreviewId ?? (() => {
    const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "") : `${now().toString(16)}${(++sequence).toString(16).padStart(8, "0")}`;
    return `cwp_${random}`;
  });

  function pruneExpired(at: number): void {
    for (const [id, preview] of previews) if (preview.expiresAt <= at) previews.delete(id);
    while (previews.size >= MAX_PREVIEWS) {
      const oldest = previews.keys().next().value as string | undefined;
      if (!oldest) break;
      previews.delete(oldest);
    }
  }

  return {
    "city.world.profile.preview": (payload: Record<string, unknown>) => {
      if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "profile") || !payload.profile || typeof payload.profile !== "object" || Array.isArray(payload.profile)) {
        throw new Error("city_world_profile_invalid_request");
      }
      const instanceId = options.instanceId();
      if (!instanceId) throw new Error("plugin_instance_unavailable");
      let raw: string;
      try { raw = JSON.stringify(payload.profile); } catch { throw new Error("world_profile_invalid_json"); }
      const validated = parseCityWorldProfileJson(raw);
      if (!validated.ok) throw new Error(validated.diagnostics[0]?.code ?? "city_world_profile_invalid");
      const at = now();
      pruneExpired(at);
      const previewId = createPreviewId();
      if (!/^cwp_[A-Za-z0-9_-]{8,96}$/.test(previewId) || previews.has(previewId)) throw new Error("city_world_preview_unavailable");
      const profile = Object.freeze(structuredClone(validated.profile)) as CityWorldProfileV1;
      previews.set(previewId, Object.freeze({
        instanceId,
        baseProfile: JSON.stringify(readCityWorldProfilePreference()),
        profile,
        expiresAt: at + PREVIEW_TTL_MS,
      }));
      return {
        previewId,
        expiresAtMs: at + PREVIEW_TTL_MS,
        currentWorld: { id: readCityWorldProfilePreference().id, version: readCityWorldProfilePreference().version },
        proposedWorld: { id: profile.id, version: profile.version, generator: profile.geography.generator, themeId: profile.visuals.themeId },
      };
    },
    "city.world.profile.apply": (payload: Record<string, unknown>) => {
      if (Object.keys(payload).length !== 2 || typeof payload.previewId !== "string" || typeof payload.operationId !== "string"
        || payload.previewId.length < 1 || payload.previewId.length > 128 || !OPERATION_ID.test(payload.operationId)) {
        throw new Error("city_world_profile_invalid_request");
      }
      const operationId = payload.operationId;
      const fingerprint = `${payload.previewId}`;
      const previous = operations.get(operationId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("operation_id_conflict");
        return previous.result;
      }
      const instanceId = options.instanceId();
      if (!instanceId) throw new Error("plugin_instance_unavailable");
      const preview = previews.get(payload.previewId);
      if (!preview || preview.expiresAt <= now()) { previews.delete(payload.previewId); throw new Error("preview_expired"); }
      if (preview.instanceId !== instanceId) throw new Error("plugin_instance_mismatch");
      const current = readCityWorldProfilePreference();
      if (JSON.stringify(current) !== preview.baseProfile) throw new Error("revision_conflict");
      // 独立 City 隔离完成前，禁止把另一个生成器/生态的 profile 应用到当前 City：
      // 沙漠 profile 一旦写到迈阿密的单份偏好，就会改掉用户现有城市。主题/参数
      // 调整仍允许（同一 generator），跨 generator 必须走独立 City 草稿。
      if (preview.profile.geography.generator !== current.geography.generator) throw new Error("city_world_profile_city_mismatch");
      if (!options.canApply()) throw new Error("city_world_busy");
      const persisted = writeCityWorldProfileJson(JSON.stringify(preview.profile));
      if (!persisted.ok) throw new Error(persisted.diagnostics[0]?.code ?? "city_world_profile_invalid");
      const appearance = readCityAppearancePreference();
      options.onApplied(appearance);
      const result = {
        applied: true,
        profileId: appearance.id,
        version: appearance.version,
        generator: appearance.geography.generator,
        themeId: appearance.visuals.themeId,
      };
      previews.delete(payload.previewId);
      operations.set(operationId, Object.freeze({ fingerprint, result }));
      while (operations.size > 64) operations.delete(operations.keys().next().value as string);
      return result;
    },
  };
}
