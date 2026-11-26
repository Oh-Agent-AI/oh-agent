import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadProjectSceneAssets } from "../src/features/preview/projectAssetSnapshot.ts";

const bytes = new Uint8Array(32_770).map((_, index) => index % 251);
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const relativePath = `assets/${digest.slice("sha256:".length)}.glb`;
const scene = { schemaVersion: 1 as const, objects: [{ id: "taxi", kind: "model" as const,
  asset: { package: { kind: "city-layout" as const, id: "layout-a", version: "1", digest: "world-a" }, assetId: "taxi-asset", digest },
  transform: { positionMeters: { x: 1, y: 2, z: 3 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] };
const project = { projectId: "project-a", revision: 4, assets: { schemaVersion: 1, entries: [{ assetId: "taxi-asset",
  relativePath, sha256: digest, byteLength: bytes.length, format: "glb-v2" as const }] } };

function assetRequest(corruptChunk = false) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const request = async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
    calls.push({ method, payload });
    if (method === "creator.asset.snapshot.open") return { snapshotId: "snapshot-a", projectId: "project-a", revision: 4,
      assetId: "taxi-asset", digest, byteLength: bytes.length } as T;
    if (method === "creator.asset.snapshot.read") {
      const offset = Number(payload.offset);
      const end = Math.min(offset + 32 * 1024, bytes.length);
      const chunk = bytes.slice(offset, corruptChunk && offset > 0 ? end - 1 : end);
      return { projectId: "project-a", revision: 4, assetId: "taxi-asset", digest, offset, totalBytes: bytes.length,
        complete: end === bytes.length, data: Buffer.from(chunk).toString("base64") } as T;
    }
    if (method === "creator.asset.snapshot.close") return { closed: true } as T;
    throw new Error("unexpected_method");
  };
  return { request, calls };
}

test("project scene assets load through revision-bound chunked snapshots and close", async () => {
  const { request, calls } = assetRequest();
  const loaded = await loadProjectSceneAssets(request, project, scene);
  assert.deepEqual(loaded.files.get(relativePath), bytes);
  assert.equal(calls.filter(call => call.method === "creator.asset.snapshot.read").length, 2);
  assert.equal(calls.at(-1)?.method, "creator.asset.snapshot.close");
});

test("project scene asset loader rejects inconsistent chunks and still closes", async () => {
  const { request, calls } = assetRequest(true);
  await assert.rejects(loadProjectSceneAssets(request, project, scene), /creator_asset_snapshot_invalid/);
  assert.equal(calls.at(-1)?.method, "creator.asset.snapshot.close");
});
