import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { canonicalJson } from "@agent-vitals/city-sdk";

const game = { schemaVersion: 1, id: "creator.collect-one", rulesVersion: 1, integerParameters: {}, slots: { targets: { kind: "zone", min: 1, max: 2, requires: ["drive"] } }, rules: { counters: {}, nodes: [] } };
const digest = `sha256:${createHash("sha256").update(canonicalJson(game)).digest("hex")}`;
const view = { layout: { schemaVersion: 1, id: "fixture", coordinateSystem: "city-local-m-v1", anchors: [
  { id: "spawn", kind: "spawn", capabilities: ["drive"], geometryRef: "g:spawn" },
  { id: "target", kind: "zone", capabilities: ["drive"], geometryRef: "g:target" },
], links: [{ id: "link", fromAnchorId: "spawn", toAnchorId: "target", capabilities: ["drive"] }] },
  geometry: new Map([["g:spawn", { positionMeters: { x: 0, y: 0, z: 0 } }], ["g:target", { positionMeters: { x: 10, y: 0, z: 0 } }]]),
  roadSegments: [], preferredStartMeters: { x: 0, z: 0 }, seed: 7, worldRevision: "r1" };
const handoff = { runId: "run-1", projectId: "project-1", revision: 1, releaseId: "release-1", snapshotDigest: `sha256:${"a".repeat(64)}`, game,
  mounts: [{ schemaVersion: 1, mountId: "mount-1", layout: { kind: "city-layout", id: "fixture", version: "1", digest: "r1" },
    game: { kind: "city-minigame", id: game.id, version: "1", digest }, entryAnchorId: "spawn", bindings: { targets: ["target"] }, parameterOverrides: {} }],
  scene: { schemaVersion: 1, objects: [] }, assets: { schemaVersion: 1, entries: [] }, assetRefs: [] };

test("claim validates the complete release and preserves its scene package", async () => {
  const methods: string[] = [];
  const fakeWindow: any = { __AV_PLUGIN_INSTANCE__: "city-1", __TAURI__: { core: { invoke: async (_command: string, args: any) => {
    methods.push(args.request.method);
    return { version: 1, requestId: args.request.requestId, ok: true, result: handoff };
  } } } };
  fakeWindow.parent = fakeWindow;
  (globalThis as any).window = fakeWindow;
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  const { claimCreatorPlaytest } = await import("../src/game/activity/loadCreatorExperiences");
  const result = await claimCreatorPlaytest(view as any);
  assert.equal(result?.experiences.length, 1);
  assert.deepEqual(result?.experiences[0].scenePackage?.scene, handoff.scene);
  assert.deepEqual(result?.experiences[0].scenePackage?.assetRefs, []);
  assert.deepEqual(methods, ["city.creator.playtest.claim"]);
});
