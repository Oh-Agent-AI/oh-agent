import test from "node:test";
import assert from "node:assert/strict";
import { validateGameTypeDescriptorV1 } from "@agent-vitals/city-sdk";
import { createGameRuntimeRegistry, GameRuntimeError, MIAMI_ACTIVITY_CATALOG_V1, ORNITHOPTER_GAME_TYPE_V1 } from "../src/index.ts";
import type { GameRuntimeHandleV1, GameRuntimeV1 } from "../src/index.ts";

const descriptor = {
  schemaVersion: 1,
  id: "creator.test-flight-v1",
  version: 1,
  label: "Test flight",
  template: "test-flight",
  runtime: { id: "test.flight", contractVersion: 3 },
  slots: { gates: { kind: "route", min: 1, max: 4, requires: ["fly"] } },
  parameters: { timeLimit: { min: 10, max: 100, default: 30 } },
  assetRoles: { vehicle: { kind: "model-glb", required: true } },
  hud: "test-flight-hud",
};

function fakeRuntime(type = "test.flight", contractVersion = 3): GameRuntimeV1 {
  return {
    type, contractVersion,
    prepare: async (): Promise<{ ok: true; value: GameRuntimeHandleV1 }> => ({
      ok: true,
      value: { telemetry: () => ({ status: "ready", tick: 0, counters: {}, metrics: {}, reason: null }), fixedStep: () => {}, dispose: () => {} },
    }),
  };
}

test("registers and resolves a validated game type by exact contract version", () => {
  const registry = createGameRuntimeRegistry();
  assert.equal(Object.isFrozen(registry.register(descriptor, fakeRuntime())), true);
  assert.equal(registry.resolve("creator.test-flight-v1", 3).type, "test.flight");
  assert.equal(registry.descriptors().length, 1);
});

test("fails closed on duplicate ids, unknown types and contract drift", () => {
  const registry = createGameRuntimeRegistry();
  registry.register(descriptor, fakeRuntime());
  assert.throws(() => registry.register(descriptor, fakeRuntime()), (error: unknown) => error instanceof GameRuntimeError && error.code === "game_type_duplicate");
  assert.throws(() => registry.resolve("creator.missing-v1", 3), (error: unknown) => error instanceof GameRuntimeError && error.code === "game_type_unknown");
  assert.throws(() => registry.resolve("creator.test-flight-v1", 2), (error: unknown) => error instanceof GameRuntimeError && error.code === "game_type_version_mismatch");
});

test("rejects implementation/descriptor mismatches and unbounded descriptors", () => {
  const registry = createGameRuntimeRegistry();
  assert.throws(() => registry.register(descriptor, fakeRuntime("other.flight")), (error: unknown) => error instanceof GameRuntimeError && error.code === "game_runtime_invalid");
  assert.throws(() => registry.register(descriptor, fakeRuntime("test.flight", 2)), (error: unknown) => error instanceof GameRuntimeError && error.code === "game_runtime_invalid");
  assert.throws(() => registry.register({ ...descriptor, code: "run()" }, fakeRuntime()), (error: unknown) => error instanceof GameRuntimeError && error.code === "game_type_invalid");
});

test("built-in catalog and the planned ornithopter descriptor are valid data-only contracts", () => {
  assert.equal(MIAMI_ACTIVITY_CATALOG_V1.length, 4);
  for (const item of [...MIAMI_ACTIVITY_CATALOG_V1, ORNITHOPTER_GAME_TYPE_V1]) {
    assert.equal(validateGameTypeDescriptorV1(item).ok, true, item.id);
  }
  assert.equal(ORNITHOPTER_GAME_TYPE_V1.runtime.id, "city-flight-ornithopter");
});
