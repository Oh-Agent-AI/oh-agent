import test from "node:test";
import assert from "node:assert/strict";
import { bossPrepare, createMatch } from "../src/game/mecha/rules.ts";
import { SEQUENTIAL_NET_PROTOCOL } from "../src/game/mecha/contracts/sequentialTransport.ts";
import { startRemoteSessionHost } from "../src/remote/RemoteSessionHost.ts";

test("desktop bridge creates and advances a v1.5 session on the v2 host protocol", () => {
  const initial = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "stationary_smash", covers: [], obstacles: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 3 } }, { id: "Gunner", pos: { x: 1, y: 6 } }, { id: "Support", pos: { x: 8, y: 8 } }] });
  bossPrepare(initial);
  const originalWindow = globalThis.window;
  let dispatch!: (event: { detail: unknown }) => void;
  const replies: Array<{ type: string; message?: Record<string, unknown> }> = [];
  const bridge = {
    __AV_MECHA_SESSION_TOKEN__: "session-secret",
    __TAURI__: { core: { invoke: (_name: string, args: { reply: { type: string; message?: Record<string, unknown> } }) => { replies.push(args.reply); return Promise.resolve(); } } },
    addEventListener: (_type: string, listener: typeof dispatch) => { dispatch = listener; },
  };
  Object.defineProperty(globalThis, "window", { value: bridge, configurable: true, writable: true });
  const send = (method: string, payload: Record<string, unknown>, requestId: string) => dispatch({ detail: {
    token: "session-secret", request: { protocol: SEQUENTIAL_NET_PROTOCOL, type: "request", requestId, method, payload },
  } });
  try {
    startRemoteSessionHost();
    assert.equal(replies[0]?.type, "ready");
    const placements = initial.mechs.map(unit => ({ mechId: unit.id, pos: unit.pos }));
    send("match.create", { config: { matchId: "match-bridge", ruleset: "mecha-v1.5", initial, placements, commands: [] } }, "create");
    assert.equal(replies.at(-1)?.type, "created", "the native v2 create envelope reaches the host");
    send("sequential.snapshot", { matchId: "match-bridge" }, "snapshot");
    const first = replies.at(-1)?.message;
    assert.equal(first?.protocol, SEQUENTIAL_NET_PROTOCOL);
    const firstResult = first?.result as { ok: boolean; snapshot?: { revision: number; ruleset: string } };
    assert.equal(firstResult.ok, true);
    assert.equal(firstResult.snapshot?.ruleset, "mecha-v1.5");
    const revision = firstResult.snapshot!.revision;
    send("sequential.command.submit", { matchId: "match-bridge", baseRevision: revision,
      command: { kind: "move", id: "phone-1", revision, mech: "Assault", to: { x: 3, y: 2 } } }, "move");
    const moved = replies.at(-1)?.message?.result as { ok: boolean; snapshot?: { revision: number; commands: unknown[] } };
    assert.equal(moved.ok, true);
    assert.equal(moved.snapshot?.revision, revision + 1);
    assert.equal(moved.snapshot?.commands.length, 1);
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
  }
});
