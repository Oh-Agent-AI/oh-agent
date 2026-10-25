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

function workerScopeAvailable(): boolean {
  return typeof Worker !== "undefined" && typeof URL !== "undefined";
}

/** One worker per request. Cancelling terminates it; the next request starts a
 *  fresh one, so stale messages cannot cross runs. */
function startWorkerSearch(
  snapshot: FightTerrainSnapshot,
  roads: readonly RoadEdge[],
  requestId: string,
  handlers: FightSearchHandlers,
): FightSearchHandle | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./fightWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  };
  worker.onmessage = (event: MessageEvent<FightWorkerResponse>) => {
    if (finished) return;
    const message = event.data;
    if (!message || message.requestId !== requestId) return;
    if (message.type === "progress") handlers.onProgress?.(message.evaluated);
    else if (message.type === "result") { finish(); handlers.onResult(message.catalog); }
    else { finish(); handlers.onError(new Error(message.message)); }
  };
  worker.onerror = (event) => {
    if (finished) return;
    finish();
    handlers.onError(new Error(event.message || "fight_worker_failed"));
  };
  const request: FightWorkerRequest = { type: "search", requestId, snapshot, roads: roads.slice() };
  const transfer: Transferable[] = [];
  for (const seed of snapshot.seeds) {
    transfer.push(seed.patch.heights.buffer);
    if (seed.patch.slopes) transfer.push(seed.patch.slopes.buffer);
  }
  try {
    worker.postMessage(request, transfer);
  } catch (reason) {
    finish();
    handlers.onError(reason);
    return { cancel: () => {} };
  }
  return { cancel: finish };
}

export function startPreparedSearch(
  snapshot: FightTerrainSnapshot,
  roads: readonly RoadEdge[],
  handlers: FightSearchHandlers,
  signal?: AbortSignal,
): FightSearchHandle {
  const requestId = `${snapshot.fingerprint}:${snapshot.revision}`;
  if (workerScopeAvailable()) {
    let detachAbort: (() => void) | null = null;
    const wrapped: FightSearchHandlers = {
      onProgress: handlers.onProgress,
      onResult: (catalog) => { detachAbort?.(); handlers.onResult(catalog); },
      onError: (reason) => { detachAbort?.(); handlers.onError(reason); },
    };
    const handle = startWorkerSearch(snapshot, roads, requestId, wrapped);
    if (handle) {
      if (!signal) return handle;
      const onAbort = () => handle.cancel();
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
      return { cancel: () => { detachAbort?.(); handle.cancel(); } };
    }
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const detachAbort = () => signal?.removeEventListener("abort", onAbort);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  void searchPreparedAsync(snapshot, roads, {
    signal: controller.signal,
    sliceMs: 8,
    onProgress: handlers.onProgress,
  }).then((catalog) => {
    detachAbort();
    handlers.onResult(catalog);
  }, (reason: unknown) => {
    detachAbort();
    if ((reason as { name?: string } | null)?.name === "AbortError") return;
    handlers.onError(reason);
  });
  return {
    cancel: () => {
      detachAbort();
      controller.abort();
    },
  };
}
