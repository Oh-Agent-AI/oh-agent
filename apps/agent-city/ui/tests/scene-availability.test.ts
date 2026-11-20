import test from "node:test";
import assert from "node:assert/strict";
import { citySceneFailureLog, citySceneFailureMessage, classifyCitySceneFailure } from "../src/engine/sceneAvailability.ts";

test("keeps a real WebGL failure distinct from a layout failure", () => {
  const webgl = classifyCitySceneFailure(new Error("Error creating WebGL context."));
  assert.equal(webgl.surface, "webgl");
  assert.equal(webgl.code, "webgl_context_unavailable");
  assert.equal(citySceneFailureMessage(webgl), "当前环境无法显示三维城市，仍可查看会话摘要。");
  assert.deepEqual(citySceneFailureLog(webgl), { stage: "rendering", reason: "webgl_context_unavailable", outcome: "failed" });

  const layout = classifyCitySceneFailure(new Error("layout-preparation:planning-worker-failed"));
  assert.equal(layout.surface, "layout");
  assert.equal(layout.code, "planning-worker-failed");
  assert.equal(citySceneFailureMessage(layout), "城市布局未能生成，三维场景暂未装配；会话摘要仍可查看。");
  assert.deepEqual(citySceneFailureLog(layout), { stage: "planning", reason: "planning-worker-failed", outcome: "failed" });
  assert.equal(classifyCitySceneFailure(new Error("city-world-biome-generator-mismatch")).code, "city_world_biome_generator_mismatch");
  assert.equal(classifyCitySceneFailure("layout-preparation-cancelled").code, "layout_preparation_cancelled");
});

test("bounds a layout reason to a loggable scene dimension", () => {
  const noisy = classifyCitySceneFailure(new Error(`layout-preparation:${"a".repeat(80)} /secret`));
  assert.equal(noisy.code.length <= 40, true);
  assert.match(noisy.code, /^[a-z0-9_.:-]+$/);
  assert.equal(noisy.code.includes("secret"), false);
});
