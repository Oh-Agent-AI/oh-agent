/** Starts a prepared search on the worker when the host has one, and falls back to
 *  the sliced main-thread search (§10 "worker unavailable" path) when it does not.
 *  The fallback is bounded per slice, so it stays under the 50 ms task budget. */
import { searchPreparedAsync, type FightCatalog, type FightTerrainSnapshot } from "./citySite";
import type { RoadEdge } from "../../engine/cityLayout";
import type { FightWorkerRequest, FightWorkerResponse } from "./fightWorker";

export type FightSearchHandlers = {
  onProgress?: (evaluated: number) => void;
  onResult: (catalog: FightCatalog) => void;
  onError: (reason: unknown) => void;
};

export type FightSearchHandle = { cancel: () => void };

/** worker 首条消息（progress/result）的等待上限；超时视为加载失败，回退主线程。 */
export const WORKER_LOAD_TIMEOUT_MS = 4000;
export type FightSearchOptions = { loadTimeoutMs?: number };

function workerScopeAvailable(): boolean {
  return typeof Worker !== "undefined" && typeof URL !== "undefined";
}

/** 主线程分片搜索：既是无 worker 环境的路径，也是 worker 异步失败后的回退。 */
function startMainThreadSearch(
  snapshot: FightTerrainSnapshot,
  roads: readonly RoadEdge[],
  handlers: FightSearchHandlers,
): FightSearchHandle {
  const controller = new AbortController();
  void searchPreparedAsync(snapshot, roads, {
    signal: controller.signal,
    sliceMs: 8,
    onProgress: handlers.onProgress,
  }).then((catalog) => {
    handlers.onResult(catalog);
  }, (reason: unknown) => {
    if ((reason as { name?: string } | null)?.name === "AbortError") return;
    handlers.onError(reason);
  });
  return { cancel: () => controller.abort() };
}

/** One worker per request. Cancelling terminates it; the next request starts a
 *  fresh one, so stale messages cannot cross runs.
 *  worker 的任何失败（同步构造/postMessage 抛错、onerror、error 消息、首条消息超时）
 *  都回退到主线程分片搜索，而不是把"战场选择失败"报给界面——重试只会再失败一次。 */
function startWorkerSearch(
  snapshot: FightTerrainSnapshot,
  roads: readonly RoadEdge[],
  requestId: string,
  handlers: FightSearchHandlers,
  loadTimeoutMs: number,
): FightSearchHandle | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./fightWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  let finished = false;
  let fallback: FightSearchHandle | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimer();
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  };
  const fallBack = () => {
    if (finished) return;
    finish();
    fallback = startMainThreadSearch(snapshot, roads, handlers);
  };
  worker.onmessage = (event: MessageEvent<FightWorkerResponse>) => {
    if (finished) return;
    const message = event.data;
    if (!message || message.requestId !== requestId) return;
    clearTimer(); // 收到属于本次请求的消息 = worker 已经起来了
    if (message.type === "progress") handlers.onProgress?.(message.evaluated);
    else if (message.type === "result") { finish(); handlers.onResult(message.catalog); }
    else fallBack();
  };
  worker.onerror = () => fallBack();
  timer = setTimeout(fallBack, loadTimeoutMs);
  const request: FightWorkerRequest = { type: "search", requestId, snapshot, roads: roads.slice() };
  // 不用 transfer 列表：transfer 会让主线程这份 patch 的 ArrayBuffer 被分离（长度 0），
  // worker 一旦异步失败，回退就只能读到空数组、搜出错误目录。这里发结构化克隆（拷贝一次
  // 几百 KB 的高度图），换来主线程原件始终完好，回退无需重新采样。
  try {
    worker.postMessage(request);
  } catch {
    fallBack();
  }
  return {
    cancel: () => {
      finish();
      fallback?.cancel();
    },
  };
}

export function startPreparedSearch(
  snapshot: FightTerrainSnapshot,
  roads: readonly RoadEdge[],
  handlers: FightSearchHandlers,
  signal?: AbortSignal,
  options: FightSearchOptions = {},
): FightSearchHandle {
  const requestId = `${snapshot.fingerprint}:${snapshot.revision}`;
  let detachAbort: (() => void) | null = null;
  const wrapped: FightSearchHandlers = {
    onProgress: handlers.onProgress,
    onResult: (catalog) => { detachAbort?.(); handlers.onResult(catalog); },
    onError: (reason) => { detachAbort?.(); handlers.onError(reason); },
  };
  const handle =
    (workerScopeAvailable()
      ? startWorkerSearch(snapshot, roads, requestId, wrapped, options.loadTimeoutMs ?? WORKER_LOAD_TIMEOUT_MS)
      : null) ?? startMainThreadSearch(snapshot, roads, wrapped);
  if (!signal) return handle;
  const onAbort = () => handle.cancel();
  if (signal.aborted) onAbort();
  else {
    signal.addEventListener("abort", onAbort, { once: true });
    detachAbort = () => signal.removeEventListener("abort", onAbort);
  }
  return { cancel: () => { detachAbort?.(); handle.cancel(); } };
}
