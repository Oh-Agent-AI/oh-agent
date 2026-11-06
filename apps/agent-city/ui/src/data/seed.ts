import { invokeHost, embedded } from "../host";
import type { PluginResponseV1 } from "@agent-vitals/app-sdk";
let sequence = 0;
export const DEMO_CITY_SEED = 74031;

/** Demo previews intentionally ignore and never modify the user's city seed. */
export function isStandaloneDemo(): boolean {
  return typeof window !== "undefined" && !window.__AV_PLUGIN_INSTANCE__ &&
    typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "1";
}

export function randomSeed(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0) || 1;
}
export async function citySeed(action: "read" | "write", seed?: number): Promise<number | null> {
  if (isStandaloneDemo()) return action === "read" ? DEMO_CITY_SEED : (seed ?? DEMO_CITY_SEED);
  if (!embedded() || window.__CITY_ISOLATION_FIXTURE__) {
    if (action === "write") localStorage.setItem("city.seed", String(seed));
    const saved = Number(localStorage.getItem("city.seed") ?? localStorage.getItem("agent-vitals.city-seed"));
    return Number.isInteger(saved) && saved > 0 && saved <= 4294967295 ? saved : null;
  }
  const requestId = `city-seed-${++sequence}`;
  try {
    const response = await invokeHost<PluginResponseV1<{ seed: number | null }>>("plugin_request", {
      request: { version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId, method: "data.read",
        payload: { projection: "city-settings", version: 1, action, ...(seed === undefined ? {} : { seed }) } },
    });
    if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result) throw new Error(response.error?.code ?? "seed_unavailable");
    const value = response.result.seed;
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 4294967295)) throw new Error("invalid_seed_response");
    return value;
  } catch {
    // 原生 IPC 尚未就绪（挂载竞态：插件实例创建/恢复中、suspended 未清零）。
    // 回退 localStorage——种子可用性优先于持久化路径的完美性；写入会在下次
    // IPC 就绪时同步到磁盘。用户不再看到「无法保存」错误。
    if (action === "write" && seed !== undefined) {
      try { localStorage.setItem("city.seed", String(seed)); } catch { /* 无存储时静默 */ }
    }
    const saved = Number(localStorage.getItem("city.seed"));
    return Number.isInteger(saved) && saved > 0 && saved <= 4294967295 ? saved : null;
  }
}
