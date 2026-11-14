import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_CITY_SKINS_V1 } from "../src/engine/cityWorldProfile.ts";
import { CREATOR_CAPABILITIES_V1 } from "../../../../packages/agent-vitals-city-sdk/src/creatorCapabilities.ts";

// Creator 描述符在构建期生成，City 渲染目录在运行时使用；二者一旦分叉，Agent 可以
// 选中一个 City 根本渲染不出的皮肤。这里钉住“同一份皮肤 ID、同一顺序”。
test("Creator descriptor skin ids stay in lockstep with the City catalog", () => {
  assert.deepEqual(CREATOR_CAPABILITIES_V1.content.skins, BUILTIN_CITY_SKINS_V1.map(skin => skin.id));
});
