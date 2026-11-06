/**
 * 规划补丁存档端口（docs/CITY_PLAN_MANUAL_REPAIR_SPEC.md §4/§9，M1 首批）。
 * 模式与 data/seed.ts 相同：宿主 IPC（projection "city-plan-patch"）优先，
 * 未就绪/浏览器夹具时回退 localStorage——可用性优先，写回在 IPC 就绪后同步。
 *
 * 注意：宿主侧 Rust 投影尚未注册（plugin 面注册是单独的宿主批次，见 AGENTS.md
 * 插件面政策——Rust 查询、声明式投影、按请求授权）。在注册落地前 M1 一直走
 * localStorage 回退路径，这是如实的降级而不是错误。补丁是本地用户数据，绝不上传。
 */
import { invokeHost, embedded } from "../host";
import type { PluginResponseV1 } from "@agent-vitals/app-sdk";
import { coercePlanPatch, type PlanPatchV1 } from "../engine/planPatch";

/** archive：跨档重定位前的原补丁，种子 → 档位 → 补丁（路线图 SPEC P0-2）。只增不删，供导出/恢复用。 */
export type PlanPatchStoreV1 = { version: 1; patches: Record<string, PlanPatchV1>; archive?: Record<string, Record<string, PlanPatchV1>> };
const STORAGE_KEY = "city.plan-patch";
let sequence = 0;

export function emptyPlanPatchStore(): PlanPatchStoreV1 {
  return { version: 1, patches: {} };
}

/** 宽容读取：单条补丁形状不对就丢弃整条（诚实降级，见 coercePlanPatch），顶层形状不对返回 null。 */
function coerceStore(raw: unknown): PlanPatchStoreV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const store = raw as { version?: unknown; patches?: unknown };
  if (store.version !== 1 || !store.patches || typeof store.patches !== "object") return null;
  const patches: Record<string, PlanPatchV1> = {};
  for (const [seed, candidate] of Object.entries(store.patches as Record<string, unknown>)) {
    const patch = coercePlanPatch(candidate);
    if (patch) patches[seed] = patch;
  }
  const archive: Record<string, Record<string, PlanPatchV1>> = {};
  const rawArchive = (raw as { archive?: unknown }).archive;
  if (rawArchive && typeof rawArchive === "object") for (const [seed, tiers] of Object.entries(rawArchive as Record<string, unknown>)) {
    if (!tiers || typeof tiers !== "object") continue;
    for (const [tier, candidate] of Object.entries(tiers as Record<string, unknown>)) {
      const patch = coercePlanPatch(candidate);
      if (patch) (archive[seed] ??= {})[tier] = patch;
    }
  }
  return { version: 1, patches, ...(Object.keys(archive).length ? { archive } : {}) };
}

/** localStorage 读写都可能抛（隐私窗口、配额、被清的站点数据、手改坏的 JSON）：
 *  曾直接 `JSON.parse(localStorage.getItem(...))`，存档损坏时连 catch 分支里都在抛，补丁读取把整个挂载流程带崩。 */
function readLocal(): PlanPatchStoreV1 | null {
  try { return coerceStore(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")); } catch { return null; }
}
function writeLocal(store: PlanPatchStoreV1): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* 无存储：本次修改仅临时生效 */ }
}

export async function cityPlanPatchStore(action: "read" | "write", store?: PlanPatchStoreV1): Promise<PlanPatchStoreV1 | null> {
  if (!embedded() || window.__CITY_ISOLATION_FIXTURE__) {
    if (action === "write" && store) writeLocal(store);
    return readLocal();
  }
  const requestId = `city-plan-patch-${++sequence}`;
  try {
    const response = await invokeHost<PluginResponseV1<{ store: unknown }>>("plugin_request", {
      request: { version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId, method: "data.read",
        payload: { projection: "city-plan-patch", version: 1, action, ...(store === undefined ? {} : { store }) } },
    });
    if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result) throw new Error(response.error?.code ?? "plan_patch_unavailable");
    return coerceStore(response.result.store);
  } catch {
    // 宿主投影未注册/IPC 未就绪：回退 localStorage（同 seed.ts 的挂载竞态口径）。
    if (action === "write" && store) writeLocal(store);
    return readLocal();
  }
}
