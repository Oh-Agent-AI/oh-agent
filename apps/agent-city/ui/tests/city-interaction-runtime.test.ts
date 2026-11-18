import test from "node:test";
import assert from "node:assert/strict";
import { CityInteractionRuntime } from "../src/game/runtime/cityInteractionRuntime";
import { InteractionRouter, type GameLaunchRequestV1 } from "../../../../packages/agent-vitals-city-game-runtime/src/interaction";
import type { CityLayout } from "../src/engine/cityLayout";
import type { CityLayoutSdkViewV1 } from "../src/engine/sdk/cityLayoutAdapter";

const layout = {
  seed: 123,
  derivedNetworkVersion: 7,
  terrain: {
    height: (x: number, _z: number) => x * 0.1,
    buildable: (x: number, _z: number) => x >= 0,
  },
  roadNodes: [{ id: "n0", x: 0, z: 0 }, { id: "n1", x: 10, z: 0 }],
  roadEdges: [{
    id: "a-arterial", from: "n0", to: "n1", width: 14, kind: "arterial",
    points: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
  }],
  blocks: [{ id: "block-1", x: 4, z: 2, width: 8, depth: 6 }],
} as unknown as CityLayout;
const view = { layout: { id: "layout-live" }, worldRevision: "world-live-7" } as CityLayoutSdkViewV1;
const engine = {
  currentLayout: layout,
  getCitySdkLayoutView: () => view,
};

test("legacy activity launch goes through the unified InstalledGameRegistry and InteractionRouter", async () => {
  const original = InteractionRouter.prototype.launch;
  const requests: GameLaunchRequestV1[] = [];
  InteractionRouter.prototype.launch = async function (request, access, grant, descriptor) {
    requests.push(request);
    return original.call(this, request, access, grant, descriptor);
  };
  try {
    const runtime = new CityInteractionRuntime();
    await runtime.launch(engine as never, {
      typeId: "miami.mecha-v1",
      presentation: "exclusive",
      launchId: "launch-mecha-1",
    });
    await runtime.launch(engine as never, {
      typeId: "miami.mecha-v1",
      presentation: "exclusive",
      launchId: "launch-mecha-1",
    });
  } finally {
    InteractionRouter.prototype.launch = original;
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.gameId, "miami.mecha-v1");
  assert.equal(requests[0]?.cityId, "city:123");
  assert.equal(requests[0]?.entry, "default");
  assert.equal(requests[0]?.presentation, "exclusive");
  assert.equal(requests[0]?.launchId, "launch-mecha-1");
  assert.match(requests[0]?.snapshotDigest ?? "", /^sha256:/);
});
