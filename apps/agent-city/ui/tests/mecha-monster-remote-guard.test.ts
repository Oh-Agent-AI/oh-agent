import assert from "node:assert/strict";
import test from "node:test";
import { remoteArenaFromSite, remoteStateFromSite } from "../src/game/mecha/contracts/arena.ts";
import { MECHA_NET_PROTOCOL } from "../src/game/mecha/contracts/match.ts";
import { createMatch, MECH_IDS, type MatchState } from "../src/game/mecha/rules.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { startRemoteSessionHost } from "../src/remote/RemoteSessionHost.ts";

const site: CityMechaSite = {
  originX: 0, originZ: 0, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: [], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
};
const arena = remoteArenaFromSite(site, { arenaId: "city-flat", sourceRevision: "flat-1" });

function legacyState(): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", deployment: true });
  // Construct an explicitly legacy state even if a future core adds this property.
  Reflect.deleteProperty(state, "monsterContent");
  return state;
}

// Construct through unknown: this test does not depend on a new MatchState type.
function withMonsterContent(value: unknown, enumerable = true): MatchState {
  const state: unknown = legacyState();
  Object.defineProperty(state, "monsterContent", { value, enumerable, configurable: true });
  return state as MatchState;
}

function withHost(run: (send: (method: string, payload: unknown, requestId: string) => void, replies: any[]) => void) {
  const originalWindow = globalThis.window;
  let dispatch!: (event: { detail: unknown }) => void;
  const replies: any[] = [];
  const host = {
    __AV_MECHA_SESSION_TOKEN__: "session-secret",
    __TAURI__: { core: { invoke: (_name: string, args: { reply: unknown }) => { replies.push(args.reply); return Promise.resolve(); } } },
    addEventListener: (_type: string, listener: typeof dispatch) => { dispatch = listener; },
  };
  Object.defineProperty(globalThis, "window", { value: host, configurable: true, writable: true });
  const send = (method: string, payload: unknown, requestId: string) => dispatch({ detail: { token: "session-secret", request: {
    protocol: MECHA_NET_PROTOCOL, type: "request", requestId, method, payload,
  } } });
  try {
    startRemoteSessionHost();
    run(send, replies);
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
  }
}

function config(state: MatchState) {
  return { matchId: "m1", mode: "pve", arena, state, players: [{ playerId: "owner", side: "A", role: "host" }] };
}

const cases: Array<[string, unknown, boolean?]> = [
  ["valid experimental encounter", { speciesId: "spore_leaper", contentVersion: 1, visualSeed: 123 }],
  ["valid legacy encounter marker", { speciesId: "legacy_boss", contentVersion: 1, visualSeed: 0 }],
  ["unknown version", { speciesId: "spore_leaper", contentVersion: 999, visualSeed: 123 }],
  ["malformed content", { speciesId: "missing" }],
  ["null", null],
  ["undefined", undefined],
  ["non-enumerable null", null, false],
];

test("legacy state still projects and creates a remote PvE session", () => {
  const local = legacyState();
  const projected = remoteStateFromSite(site, local);
  assert.equal(Object.hasOwn(projected, "monsterContent"), false);
  assert.deepEqual(projected.boss, local.boss);
  withHost((send, replies) => {
    send("match.create", { config: config(projected) }, "create");
    assert.deepEqual(replies.at(-1), { type: "created", token: "session-secret" });
    send("match.snapshot", { matchId: "m1", playerId: "owner" }, "snapshot");
    const result = replies.at(-1).message.result;
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.state, projected);
    assert.equal(Object.hasOwn(result.value.state, "monsterContent"), false);
  });
});

for (const [name, content, enumerable] of cases) {
  test(`own monsterContent (${name}) is rejected before projection or host attachment`, () => {
    const state = withMonsterContent(content, enumerable);
    assert.throws(() => remoteStateFromSite(site, state), { message: "remote_match_unsupported" });
    withHost((send, replies) => {
      send("match.create", { config: config(state) }, "bad");
      assert.deepEqual(replies.at(-1).message.result, { ok: false, error: { code: "invalid_plan" } });
      assert.equal(replies.some(reply => reply.type === "created" || reply.message?.type === "event"), false);
      send("match.snapshot", { matchId: "m1", playerId: "owner" }, "snapshot");
      assert.deepEqual(replies.at(-1).message.result, { ok: false, error: { code: "unavailable" } });
      // A rejected request must not poison the host or attach a hidden session.
      send("match.create", { config: config(remoteStateFromSite(site, legacyState())) }, "good");
      assert.deepEqual(replies.at(-1), { type: "created", token: "session-secret" });
    });
  });
}

test("the guard neither reads the marker nor begins projecting state or site", () => {
  const state = legacyState();
  Object.defineProperty(state, "monsterContent", { get() { throw new Error("marker read"); } });
  Object.defineProperty(state, "covers", { get() { throw new Error("state projected"); } });
  const unprojectableSite = new Proxy(site, { get() { throw new Error("site projected"); } });
  assert.throws(() => remoteStateFromSite(unprojectableSite, state), { message: "remote_match_unsupported" });
  withHost((send, replies) => {
    send("match.create", { config: config(state) }, "bad");
    assert.deepEqual(replies.at(-1).message.result, { ok: false, error: { code: "invalid_plan" } });
    assert.equal(replies.some(reply => reply.type === "created" || reply.message?.type === "event"), false);
  });
});

test("local summon markers cannot be silently stripped or attached to a remote session", () => {
  for (const descriptor of [
    { value: { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 2 }, enumerable: true },
    { value: undefined, enumerable: true },
    { value: null, enumerable: false },
    { get() { throw new Error("summon marker must not be read"); }, enumerable: true },
  ]) {
    const state = legacyState();
    state.raiders.push({ id: "swarm:0", pos: { x: 2, y: 2 }, hp: 2, intent: null });
    Object.defineProperty(state.raiders[0]!, "summon", { ...descriptor, configurable: true });
    assert.throws(() => remoteStateFromSite(site, state), { message: "remote_match_unsupported" });
    withHost((send, replies) => {
      send("match.create", { config: config(state) }, "bad-summon");
      assert.deepEqual(replies.at(-1).message.result, { ok: false, error: { code: "invalid_plan" } });
      assert.equal(replies.some(reply => reply.type === "created" || reply.message?.type === "event"), false);
      send("match.create", { config: config(remoteStateFromSite(site, legacyState())) }, "good");
      assert.deepEqual(replies.at(-1), { type: "created", token: "session-secret" });
    });
  }
});
