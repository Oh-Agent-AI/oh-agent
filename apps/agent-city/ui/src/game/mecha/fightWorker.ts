/** Battlefield search worker. The snapshot is plain data (anchors + typed-array
 *  terrain patches), so this file has no engine, DOM or City imports beyond the
 *  pure road-clearance helpers that `searchPrepared` already uses. */
import { searchPrepared, type FightCatalog, type FightTerrainSnapshot } from "./citySite";
import type { RoadEdge } from "../../engine/cityLayout";

export type FightWorkerRequest = {
  type: "search";
  requestId: string;
  snapshot: FightTerrainSnapshot;
  roads: RoadEdge[];
};

export type FightWorkerResponse =
  | { type: "progress"; requestId: string; evaluated: number }
  | { type: "result"; requestId: string; catalog: FightCatalog }
  | { type: "error"; requestId: string; code: "search_failed"; message: string };

type WorkerScope = {
  onmessage: ((event: MessageEvent<FightWorkerRequest>) => void) | null;
  postMessage: (message: FightWorkerResponse) => void;
};

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
  const request = event.data;
  if (!request || request.type !== "search") return;
  try {
    const catalog = searchPrepared(request.snapshot, request.roads, {
      onProgress: (evaluated) => scope.postMessage({ type: "progress", requestId: request.requestId, evaluated }),
    });
    scope.postMessage({ type: "result", requestId: request.requestId, catalog });
  } catch (error) {
    scope.postMessage({
      type: "error",
      requestId: request.requestId,
      code: "search_failed",
      message: error instanceof Error ? error.message : "battlefield search failed",
    });
  }
};
