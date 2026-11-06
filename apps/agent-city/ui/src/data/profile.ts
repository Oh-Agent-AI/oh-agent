/**
 * 飞行档案端口（§9，G3.2）：FlightProfileV1 的读取/合并/保存。
 * 存储三级降级：原生 plugin.state 端口（incognito WebView 下唯一可靠的跨重启存储）
 * → 浏览器预览 origin 的有界 localStorage → 内存（HUD 提示「成绩仅本次保留」）。
 * 档案只含玩法记录：无 session handle、无提示词、无路径、无任务轨迹。
 */
import { invokeHost, embedded } from "../host";
import type { PluginResponseV1, PluginStateReadResult, PluginStateWriteResult } from "@agent-vitals/app-sdk";

export const PROFILE_KEY = "flight-profile:v1";
const LOCAL_STORAGE_KEY = "city.flight-profile.v1";
const MAX_RECORDS = 20;

export type FlightRecord = { courseId: string; bestTimeMs: number; collisions: number };

export type FlightProfileV1 = {
  schemaVersion: 1;
  tutorialSeen: boolean;
  preferences: { muted: boolean; reducedCameraMotion: boolean };
  /** 顺序即最近访问序（末尾最新）；超额淘汰最旧（§9）。 */
  records: FlightRecord[];
};

export const EMPTY_PROFILE: FlightProfileV1 = {
  schemaVersion: 1,
  tutorialSeen: false,
  preferences: { muted: false, reducedCameraMotion: false },
  records: [],
};

export type ProfilePortTier = "native" | "local" | "memory";

export type ProfilePort = {
  tier: ProfilePortTier;
  profile: FlightProfileV1;
  /** true = 只读降级（未知新版本/持续写失败）：已知成绩不被旧状态静默覆盖。 */
  readOnly: boolean;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** 读取时验证：字段有限、版本已知；未知新版本只读降级；损坏（缺版本/缺结构）启用空档案。 */
export function parseProfile(value: unknown): { profile: FlightProfileV1; readOnly: boolean } | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) {
    if (typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion) && raw.schemaVersion > 1) {
      // 未知新版本：只读降级为空档案（不写回、不覆盖）。
      return { profile: { ...EMPTY_PROFILE }, readOnly: true };
    }
    return null; // 缺版本/非法版本：按损坏处理（空档案，可写重建）
  }
  const records: FlightRecord[] = [];
  if (Array.isArray(raw.records)) {
    for (const entry of raw.records.slice(0, MAX_RECORDS)) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.courseId === "string" && record.courseId.length > 0 && record.courseId.length <= 128
        && finite(record.bestTimeMs) && record.bestTimeMs >= 0 && finite(record.collisions) && record.collisions >= 0) {
        records.push({ courseId: record.courseId, bestTimeMs: record.bestTimeMs, collisions: record.collisions });
      }
    }
  }
  const preferences = (typeof raw.preferences === "object" && raw.preferences !== null ? raw.preferences : {}) as Record<string, unknown>;
  return {
    profile: {
      schemaVersion: 1,
      tutorialSeen: raw.tutorialSeen === true,
      preferences: { muted: preferences.muted === true, reducedCameraMotion: preferences.reducedCameraMotion === true },
      records,
    },
    readOnly: false,
  };
}

/** 成绩合并：同路线取更优（最终用时，并列时碰撞少者）；记录移到末尾（最近访问）；超额淘汰最旧。 */
export function mergeRecord(profile: FlightProfileV1, record: FlightRecord): FlightProfileV1 {
  const kept = profile.records.filter((existing) => existing.courseId !== record.courseId);
  const previous = profile.records.find((existing) => existing.courseId === record.courseId);
  const better = !previous
    || record.bestTimeMs < previous.bestTimeMs
    || (record.bestTimeMs === previous.bestTimeMs && record.collisions < previous.collisions);
  const next = better ? record : previous;
  const records = [...kept, next].slice(-MAX_RECORDS);
  return { ...profile, records };
}

async function nativeRead(): Promise<{ value: unknown; revision: number } | null> {
  const requestId = `city-profile-read-${Date.now()}`;
  const response = await invokeHost<PluginResponseV1<PluginStateReadResult>>("plugin_request", { request: {
    version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId, method: "plugin.state.read",
    payload: { key: PROFILE_KEY },
  } });
  if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result) {
    throw new Error(response.error?.code ?? "state_unavailable");
  }
  return response.result;
}

async function nativeWrite(revision: number, value: FlightProfileV1): Promise<number> {
  const requestId = `city-profile-write-${Date.now()}`;
  const response = await invokeHost<PluginResponseV1<PluginStateWriteResult>>("plugin_request", { request: {
    version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId, method: "plugin.state.write",
    payload: { key: PROFILE_KEY, revision, value },
  } });
  if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result) {
    throw new Error(response.error?.code ?? "state_unavailable");
  }
  return response.result.revision;
}

/** 原生 IO 面（注入点：测试用假实现替换，不触达 host 信封）。 */
export type NativeStateIo = {
  read: typeof nativeRead;
  write: typeof nativeWrite;
};

const defaultNativeIo: NativeStateIo = { read: nativeRead, write: nativeWrite };

function localRead(): { value: unknown } | null {
  try {
    const text = localStorage.getItem(LOCAL_STORAGE_KEY);
    return text === null ? null : { value: JSON.parse(text) };
  } catch {
    return null; // 解析失败或存储不可用 → 空档案/内存
  }
}

function localWrite(value: FlightProfileV1): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(value));
  } catch {
    throw new Error("local_storage_unavailable");
  }
}

/**
 * 载入档案：优先原生端口（真实 WebView）。原生读取报「损坏」（state_unavailable）时
 * 先尝试一次修复写（revision 0 + 空档案）——宿主会备份损坏副本并重建文件，原生层
 * 自愈后再继续用原生；修复失败或其他错误（端口不存在/未授权）才降级 localStorage。
 * 不做修复写的旧问题：原生持续损坏、成绩永远只落在回退层（Rust 端备份逻辑永不触发）。
 */
export async function loadProfilePort(native: NativeStateIo = defaultNativeIo): Promise<ProfilePort> {
  if (embedded() && window.__AV_PLUGIN_INSTANCE__) {
    try {
      const read = await native.read();
      if (read && read.value !== null) {
        const parsed = parseProfile(read.value);
        if (parsed) {
          return {
            tier: "native",
            profile: parsed.profile,
            readOnly: parsed.readOnly,
            revision: read.revision,
          } as ProfilePort & { revision: number };
        }
        // 结构损坏（宿主信封有效、档案内容不合法）：只读降级——原件原封保留在
        // 原生存储（宿主按设计不感知业务 schema，不会备份这类文件），空档案仅在
        // 内存启用，绝不写回覆盖（§9「不能静默覆盖」；新成绩经 HUD 标注未保存）。
        return {
          tier: "native",
          profile: { ...EMPTY_PROFILE },
          readOnly: true,
          revision: read.revision,
        } as ProfilePort & { revision: number };
      }
      return {
        tier: "native",
        profile: { ...EMPTY_PROFILE },
        readOnly: false,
        revision: read?.revision ?? 0,
      } as ProfilePort & { revision: number };
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "state_unavailable") {
        try {
          // 修复写：宿主端 load() 仍读出损坏 → 备份 .corrupt-* → 落新档。
          // （若此刻文件已变有效会得到 revision_conflict，同样落到降级分支。）
          const revision = await native.write(0, { ...EMPTY_PROFILE });
          return { tier: "native", profile: { ...EMPTY_PROFILE }, readOnly: false, revision } as ProfilePort & { revision: number };
        } catch {
          // 修复失败（IO 故障/宿主拒绝）：降级。
        }
      }
      // 原生端口不可用（预览 iframe / 宿主旧版本 / 持续 IO 故障）：降到 localStorage。
    }
  }
  const local = localRead();
  const parsed = local?.value ? parseProfile(local.value) : null;
  if (parsed) {
    if (parsed.readOnly) return { tier: "local", profile: parsed.profile, readOnly: true };
    try {
      localWrite(parsed.profile);
      return { tier: "local", profile: parsed.profile, readOnly: parsed.readOnly };
    } catch {
      // 存储只读/满：内存档。
    }
  }
  return { tier: "memory", profile: parsed?.profile ?? { ...EMPTY_PROFILE }, readOnly: false };
}

/** 保存档案（设置变更与比赛结算时调用，不逐帧）。失败返回 false（HUD 显示「本次成绩尚未保存」）。 */
export async function saveProfile(port: ProfilePort, profile: FlightProfileV1, native: NativeStateIo = defaultNativeIo): Promise<ProfilePort> {
  if (port.readOnly) return port; // 只读降级不写回（未知版本不覆盖）
  if (port.tier === "native" && "revision" in port) {
    const revision = (port as ProfilePort & { revision: number }).revision;
    try {
      const next = await native.write(revision, profile);
      return { ...port, profile, revision: next } as ProfilePort & { revision: number };
    } catch (error) {
      if (error instanceof Error && error.message === "revision_conflict") {
        // 冲突：重读 → 合并（已知成绩不被旧状态静默覆盖）→ 重写一次。
        try {
          const read = await native.read();
          const parsed = read && read.value !== null ? parseProfile(read.value) : null;
          if (read && read.value !== null && (!parsed || parsed.readOnly)) {
            return { ...port, profile, readOnly: true };
          }
          const merged = parsed ? parsed.profile : { ...EMPTY_PROFILE };
          let combined = merged;
          for (const record of profile.records) combined = mergeRecord(combined, record);
          const next = await native.write(read?.revision ?? 0, combined);
          return { tier: "native", profile: combined, readOnly: false, revision: next } as ProfilePort & { revision: number };
        } catch {
          return { ...port, profile, readOnly: true };
        }
      }
      return { ...port, profile, readOnly: true };
    }
  }
  if (port.tier === "local") {
    try {
      localWrite(profile);
      return { ...port, profile };
    } catch {
      return { tier: "memory", profile, readOnly: false };
    }
  }
  return { ...port, profile }; // 内存档：本次会话内保留
}
