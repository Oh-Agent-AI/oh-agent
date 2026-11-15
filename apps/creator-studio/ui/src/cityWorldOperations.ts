/**
 * world.set 语义合并（世界多样化规格 §5.2，S4）：可信 Studio 适配器把 world.set
 * operations 合并进已存 City profile，合并结果经 validateCityWorldProfile 复验后
 * 作为 preview 请求的 `profile` 发给宿主；宿主只做结构/预算/身份核对（生成目录
 * assets/creator/worlds.json），深度语义以 city-sdk 为唯一来源。
 *
 * 落位规则与 SDK 契约一致：arid 的 legacy 沙丘键（landform.duneScale 等三个）
 * 写回 `parameters.dunes`（diversity 不得重述 v1 字段），其余键写入
 * `parameters.diversity` 且只持久化显式键（默认值在构建期归一化）；coastal 已
 * 解冻字段（shape.bayHalfWidth/bayShift）直接写入 `parameters.coastal`。
 */
import { ARID_DUNES_LEGACY_KEYS, ARID_DUNES_WORLD_V2, COASTAL_ISLANDS_WORLD_V1, validateCityWorldProfile, validateWorldParametersV1, type CityWorldProfileV1, type WorldCapabilityV1 } from "@agent-vitals/city-sdk";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const capabilityFor = (generator: string): WorldCapabilityV1 | null =>
  generator === "arid-dunes-v1" ? ARID_DUNES_WORLD_V2 : generator === "coastal-islands-v1" ? COASTAL_ISLANDS_WORLD_V1 : null;

/** Merge world.set operations into a validated profile; null means rejected
 * (structural mismatch, unknown key/range/preset, or a result that no longer
 * passes validateCityWorldProfile). Deterministic for the same input. */
export function applyCityWorldOperations(profile: CityWorldProfileV1, operations: unknown): CityWorldProfileV1 | null {
  const capability = capabilityFor(profile.geography.generator);
  if (!capability || !Array.isArray(operations) || operations.length === 0 || operations.length > 16) return null;
  const requested: Record<string, number | string> = {};
  for (const operation of operations) {
    if (!isObject(operation)) return null;
    if (Object.keys(operation).some(key => key !== "op" && key !== "preset" && key !== "params")) return null;
    if (operation.op !== "world.set") return null;
    const params: Record<string, unknown> = {};
    if (operation.preset !== undefined) {
      const preset = capability.presets.find(item => item.id === operation.preset);
      if (!preset) return null;
      Object.assign(params, preset.parameters);
    }
    if (operation.params !== undefined) {
      if (!isObject(operation.params)) return null;
      Object.assign(params, operation.params);
    }
    if (Object.keys(params).length === 0) return null;
    Object.assign(requested, params);
  }
  // 语义校验单一来源：目录键与范围；显式键取归一化后的值（完整记录由构建期默认补全，不持久化）。
  const checked = validateWorldParametersV1(capability, requested);
  if (!checked.ok) return null;
  const explicit = Object.fromEntries(Object.keys(requested).map(key => [key, checked.value[key]]));
  const merged = mergeIntoProfile(profile, explicit);
  if (!merged) return null;
  const final = validateCityWorldProfile(merged);
  return final.ok ? final.value : null;
}

function mergeIntoProfile(profile: CityWorldProfileV1, explicit: Record<string, number | string>): CityWorldProfileV1 | null {
  // 判别联合按 biome+generator 收窄不到单一分支的参数形状；合并是结构性的，
  // 结果交回 validateCityWorldProfile 复验，这里按宽松形状读写。
  const parameters = profile.geography.parameters as Record<string, unknown>;
  if (profile.geography.generator === "arid-dunes-v1") {
    const dunes = { ...(parameters.dunes as Record<string, number>) };
    const diversity = { ...((parameters.diversity as Record<string, number | string> | undefined) ?? {}) };
    for (const [key, value] of Object.entries(explicit)) {
      if (ARID_DUNES_LEGACY_KEYS.includes(key)) dunes[key.slice("landform.".length)] = value as number;
      else diversity[key] = value;
    }
    const merged: unknown = { ...profile, geography: { ...profile.geography, parameters: { dunes, ...(Object.keys(diversity).length > 0 ? { diversity } : {}) } } };
    return merged as CityWorldProfileV1;
  }
  if (profile.geography.generator === "coastal-islands-v1") {
    const coastal = { ...(parameters.coastal as Record<string, unknown>) };
    for (const [key, value] of Object.entries(explicit)) {
      const field = key.slice("shape.".length);
      // coastal 目录键必须落在已存在的已解冻字段上；未来目录扩展未进入
      // CoastalWorldParametersV1 之前一律判负。
      if (!(field in coastal)) return null;
      coastal[field] = value;
    }
    const merged: unknown = { ...profile, geography: { ...profile.geography, parameters: { coastal } } };
    return merged as CityWorldProfileV1;
  }
  return null;
}
