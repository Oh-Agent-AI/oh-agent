import { validateCityWorldProfile } from "@oh-agent/city-sdk";
import { MIAMI_CITY_WORLD_V1, type CityWorldProfileV1 } from "../engine/cityWorldProfile";
import { coercePlanPatch, type PlanPatchV1 } from "../engine/planPatch";

export type CodePreviewSource = Readonly<{
  cityId: string;
  seed: number;
  synthetic: boolean;
  profile: CityWorldProfileV1;
  planPatch: PlanPatchV1 | null;
}>;

export type CodePreviewBoot = Readonly<{
  previewId: string;
  source: CodePreviewSource;
}>;

export type CodePreviewBootResult =
  | Readonly<{ ok: true; value: CodePreviewBoot }>
  | Readonly<{ ok: false; error: string }>;

declare global {
  interface Window {
    __AV_CODE_PREVIEW_BOOT__?: unknown;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readCodePreviewBoot(): CodePreviewBootResult {
  const candidate = window.__AV_CODE_PREVIEW_BOOT__;
  if (!isRecord(candidate) || typeof candidate.previewId !== "string" || !candidate.previewId || !isRecord(candidate.source)) {
    return { ok: false, error: "Preview 启动参数不可用，请从 Creator Studio 重新打开。" };
  }
  const source = candidate.source;
  if (typeof source.cityId !== "string" || !source.cityId || typeof source.seed !== "number" || !Number.isFinite(source.seed)) {
    return { ok: false, error: "Preview 城市来源无效，请重新生成预览。" };
  }
  let profile: CityWorldProfileV1 = MIAMI_CITY_WORLD_V1;
  if (source.profile !== undefined) {
    const parsed = validateCityWorldProfile(source.profile);
    if (!parsed.ok) return { ok: false, error: `城市 Profile 无效（${parsed.diagnostics[0]?.code ?? "world_profile_invalid"}）。` };
    profile = parsed.value;
  }
  let planPatch: PlanPatchV1 | null = null;
  if (source.planPatch !== undefined && source.planPatch !== null) {
    planPatch = coercePlanPatch(source.planPatch);
    if (!planPatch || planPatch.seed !== source.seed) return { ok: false, error: "城市编辑补丁无效或与当前城市不匹配。" };
  }
  return { ok: true, value: {
    previewId: candidate.previewId,
    source: { cityId: source.cityId, seed: source.seed, synthetic: source.synthetic === true, profile, planPatch },
  } };
}
