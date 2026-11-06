import assert from "node:assert/strict";
import test from "node:test";
import { remoteStateFromSite } from "../src/game/mecha/contracts/arena.ts";
import { startRemoteSessionHost } from "../src/remote/RemoteSessionHost.ts";
import { deploymentGatewayFixture } from "./remote-deployment-gateway-fixture.ts";

const fakeSite = { buildings: [] } as any;
for (const marker of [null, { kind: "rescue:v1", target: { x: 0, y: 0 } }, "unknown"]) test(`projection and host reject any mission property: ${JSON.stringify(marker)}`, () => {
  const fixture = deploymentGatewayFixture();
  const state = { ...fixture.state, mission: marker } as any;
  assert.throws(() => remoteStateFromSite(fakeSite, state), /remote_match_unsupported/);
  const replies: any[] = [];
  const target = new EventTarget() as any;
  target.__AV_MECHA_SESSION_TOKEN__ = "token";
  target.__TAURI__ = { core: { invoke: async (_: string, { reply }: any) => { replies.push(reply); } } };
  const old = (globalThis as any).window;
  (globalThis as any).window = target;
  try {
    startRemoteSessionHost();
    const send = (s: any, requestId: string) => target.dispatchEvent(new CustomEvent("__AV_MECHA_REMOTE_REQUEST__", { detail: { token: "token", request: {
      protocol: "mecha-net:v1", type: "request", requestId, method: "match.create", payload: { config: {
        matchId: "m1", mode: "pve", arena: fixture.arena, state: s, players: [{ playerId: "owner", side: "A", role: "host" }],
      } },
    } } }));
    send(state, "bad");
    assert.equal(replies.find(r => r.message?.requestId === "bad")?.message.result.error.code, "invalid_plan");
    send(fixture.state, "good");
    assert.ok(replies.some(r => r.type === "created"), "a failed rescue request must not attach a session");
  } finally { (globalThis as any).window = old; }
});
