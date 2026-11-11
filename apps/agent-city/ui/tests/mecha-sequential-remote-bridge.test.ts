import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SEQUENTIAL_NET_PROTOCOL } from "../src/game/mecha/contracts/sequentialTransport.ts";
import { startRemoteHostRuntime } from "../src/remote/RemoteHostRuntime.ts";
import { REMOTE_HOST_ADAPTERS } from "../src/remote/remoteHostManifest.ts";
import { prepareRemoteCityDisplay } from "../src/remote/city/trustedRemoteCityDisplay.ts";

test("generic desktop host runtime creates and advances a v1.5 match within its injected scope", async () => {
  const initial = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(initial);
  const dataKeys = ["scaleTier", "biome", "core", "islandRadius", "seed", "districts", "blocks", "roadNodes", "roadEdges", "activityKey", "coastRoads", "culDeSacEnds", "junctionRings", "highwayRamps", "districtLandmarks", "terrain", "extent", "coast", "river", "publicSites", "parkTrees", "urbanBounds", "bridges", "boatLanes", "boundsRadius", "decorMountains", "districtAnchors", "highways", "massing", "civics", "landmarks", "seaside", "airport", "coastalConfigKey", "coastalConfig", "contextBuildings", "gardens", "boatLoops", "seaMountains"];
  const data: Record<string, unknown> = Object.fromEntries(dataKeys.map(key => [key, null]));
  Object.assign(data, {
    scaleTier: 1, biome: "tropical", core: { x: 0, z: 0 }, islandRadius: 100, seed: 7,
    districts: [{ id: "district-0001", label: "Test district", center: { x: 0, z: 0 }, radius: 1,
      terrain: { __remoteTerrain: { center: { x: 0, z: 0 }, radius: 100, hasRiver: false } }, slots: { __remoteMap: [] }, grounds: { __remoteMap: [] },
      carPaths: [], river: null, riverHalfWidth: 0, trees: [], plaza: { x: 0, y: 0, z: 0 }, anomaly: null, sessionCount: 0, landValue: { __remoteMap: [] }, roads: [] }],
    blocks: [], roadNodes: [], roadEdges: [], activityKey: "remote-layout-7-1",
    terrain: { __remoteTerrain: { center: { x: 0, z: 0 }, radius: 100, hasRiver: false } }, extent: 100,
  });
  const cityDisplay = prepareRemoteCityDisplay({
    schema: "remote-city-display:v2", seed: 7,
    model: { districts: [{ id: "district-0001", label: "Test district", sessionCount: 0, tokensTotal: 0, activeCount: 0, anomaly: null }], buildings: [],
      stats: { renderedSessions: 0, aggregatedSessions: 0, totalSessions: 0, tokensTotal: 0, activeCount: 0, truncated: false }, rows: [] },
    layout: { schema: "remote-city-layout:v1", revision: 1, generatorVersion: 1, seed: 7, backdrop: "off",
      camera: { position: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0], fov: 50 }, data },
  });
  const context = { token: "a".repeat(64), appId: "city", capability: "mecha:v4", sessionId: "match-bridge" };
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const listeners = new Map<string, (event: any) => void>();
  const replies: Array<{ type: string; message?: Record<string, unknown>; snapshot?: unknown }> = [];
  const bridge = {
    __AV_REMOTE_HOST_CONTEXT__: context,
    __TAURI__: { core: { invoke: (_name: string, args: { reply: typeof replies[number] }) => { replies.push(args.reply); return Promise.resolve(); } } },
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  Object.defineProperty(globalThis, "window", { value: bridge, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: { body: { textContent: "" } }, configurable: true, writable: true });
  const close = startRemoteHostRuntime(REMOTE_HOST_ADAPTERS);
  const dispatch = listeners.get("__AV_REMOTE_HOST_REQUEST__")!;
  const send = async (method: string, payload: Record<string, unknown>, requestId: string, scope = context) => {
    dispatch({ detail: {
    ...scope, request: { protocol: "app-remote:v1", appId: scope.appId, sessionId: scope.sessionId, capability: scope.capability, type: "request", requestId, method, payload },
    } });
    await new Promise(resolve => setImmediate(resolve));
  };
  try {
    assert.equal(replies[0]?.type, "ready");
    const placements = initial.mechs.map(unit => ({ mechId: unit.id, pos: unit.pos }));
    const bootstrap = { initial, placements, commands: [], citySite: {}, projections: [{ id: "city-remote-display:v2", value: cityDisplay }] };
    await send("session.bootstrap", { ...bootstrap, ruleset: "mecha-v1.4" }, "invalid-bootstrap");
    assert.deepEqual(replies.at(-1)?.message?.result, { ok: false, error: { code: "invalid_plan" } });
    await send("session.bootstrap", { ...bootstrap, ruleset: "mecha-v1.5" }, "create");
    assert.equal(replies.at(-1)?.type, "created", "the v1.5 adapter reports created after installing state");
    await send("sequential.snapshot", { matchId: "match-bridge" }, "snapshot");
    const first = replies.at(-1)?.message;
    assert.equal(first?.protocol, SEQUENTIAL_NET_PROTOCOL);
    const firstResult = first?.result as { ok: boolean; snapshot?: { revision: number; ruleset: string } };
    assert.equal(firstResult.ok, true);
    assert.equal(firstResult.snapshot?.ruleset, "mecha-v1.5");
    const revision = firstResult.snapshot!.revision;
    await send("sequential.command.submit", { matchId: "match-bridge", baseRevision: revision,
      command: { kind: "move", id: "phone-1", revision, mech: "Assault", to: { x: 3, y: 2 } } }, "move");
    const moved = replies.at(-1)?.message?.result as { ok: boolean; snapshot?: { revision: number; commands: unknown[] } };
    assert.equal(moved.ok, true);
    assert.equal(moved.snapshot?.revision, revision + 1);
    assert.equal(moved.snapshot?.commands.length, 1);
    await send("session.freeze", {}, "freeze");
    const frozen = replies.at(-1);
    assert.equal(frozen?.type, "frozen");
    assert.deepEqual(frozen?.snapshot, moved.snapshot);
    await send("sequential.command.submit", { matchId: "match-bridge", baseRevision: revision + 1,
      command: { kind: "undo", id: "phone-2", revision: revision + 1 } }, "late");
    assert.equal((replies.at(-1)?.message?.result as { ok: boolean }).ok, false);
    await send("session.freeze", {}, "retry");
    assert.deepEqual(replies.at(-1)?.snapshot, frozen?.snapshot, "retry returns the same frozen history");
    const count = replies.length;
    send("local.freeze", {}, "wrong-session", { ...context, sessionId: "other-session" });
    assert.equal(replies.length, count, "a cross-session host request is ignored");
  } finally {
    close();
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true, writable: true });
  }
});
