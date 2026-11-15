import test from "node:test";
import assert from "node:assert/strict";
import { validateVehicleProfileV1, validateGameTypeDescriptorV1, FIXED_WING_VEHICLE_PRESET_V1, ORNITHOPTER_VEHICLE_PRESET_V1 } from "@agent-vitals/city-sdk";
import { createGameRuntimeRegistry, DEPRECATED_GAME_TYPE_IDS_V1, FLIGHT_CHECKPOINT_GAME_TYPE_V1, ORNITHOPTER_GAME_TYPE_V1,
  validateTemplateLink } from "../src/index.ts";
import { GameRuntimeError } from "../src/errors.ts";
import type { GameRuntimeHandleV1, GameRuntimeV1 } from "../src/index.ts";

/** Fake fixed-step runtime implementing the city-flight-generic contract seam. */
function fakeRuntime(type = "city-flight-generic", contractVersion = 1): GameRuntimeV1 {
  return {
    type, contractVersion, execution: "fixed-step",
    prepare: async (): Promise<{ ok: true; value: GameRuntimeHandleV1 }> => ({
      ok: true,
      value: { telemetry: () => ({ status: "ready", tick: 0, counters: {}, metrics: {}, reason: null }), fixedStep: () => {}, dispose: () => {} },
    }),
  };
}

test("creator.flight-checkpoint-v1 is a valid data-only descriptor on the generic flight runtime", () => {
  const verdict = validateGameTypeDescriptorV1(FLIGHT_CHECKPOINT_GAME_TYPE_V1);
  assert.equal(verdict.ok, true);
  assert.equal(FLIGHT_CHECKPOINT_GAME_TYPE_V1.runtime.id, "city-flight-generic");
  assert.equal(FLIGHT_CHECKPOINT_GAME_TYPE_V1.runtime.contractVersion, 1);
  assert.equal(FLIGHT_CHECKPOINT_GAME_TYPE_V1.templateCatalog, "creator");
  assert.equal(FLIGHT_CHECKPOINT_GAME_TYPE_V1.template, "flight-checkpoint");
  assert.equal(FLIGHT_CHECKPOINT_GAME_TYPE_V1.slots.launch.kind, "spawn");
  assert.deepEqual(FLIGHT_CHECKPOINT_GAME_TYPE_V1.slots.launch.requires, ["fly"]);
  assert.equal(FLIGHT_CHECKPOINT_GAME_TYPE_V1.slots.gates.kind, "zone");
  assert.equal(FLIGHT_CHECKPOINT_GAME_TYPE_V1.slots.gates.min, 3);
  assert.equal(FLIGHT_CHECKPOINT_GAME_TYPE_V1.slots.gates.max, 8);
  assert.equal(FLIGHT_CHECKPOINT_GAME_TYPE_V1.assetRoles.vehicle.required, false);
  assert.equal(validateTemplateLink(FLIGHT_CHECKPOINT_GAME_TYPE_V1), null);
});

test("creator.flight-checkpoint-v1 registers against a city-flight-generic adapter", () => {
  const registry = createGameRuntimeRegistry();
  const registered = registry.register(FLIGHT_CHECKPOINT_GAME_TYPE_V1, fakeRuntime());
  assert.equal(registered.id, "creator.flight-checkpoint-v1");
  assert.equal(registry.resolve("creator.flight-checkpoint-v1", 1).type, "city-flight-generic");
  assert.throws(() => registry.resolve("creator.flight-checkpoint-v1", 2),
    (error: unknown) => error instanceof GameRuntimeError && error.code === "game_type_version_mismatch");
});

test("the deprecated ornithopter alias stays unregistrable and is marked preset-backed", () => {
  assert.equal(ORNITHOPTER_GAME_TYPE_V1.id, DEPRECATED_GAME_TYPE_IDS_V1.flightOrnithopter);
  assert.equal(ORNITHOPTER_GAME_TYPE_V1.templateCatalog, "planned");
  assert.match(validateTemplateLink(ORNITHOPTER_GAME_TYPE_V1) ?? "", /planned template/);
  assert.equal(validateGameTypeDescriptorV1(ORNITHOPTER_GAME_TYPE_V1).ok, true);
  const registry = createGameRuntimeRegistry();
  assert.throws(() => registry.register(ORNITHOPTER_GAME_TYPE_V1, fakeRuntime("city-flight-ornithopter")),
    (error: unknown) => error instanceof GameRuntimeError && error.code === "game_type_template_mismatch");
});

test("vehicle presets stay valid contracts (lockstep with the flight runtime seam)", () => {
  for (const preset of [ORNITHOPTER_VEHICLE_PRESET_V1, FIXED_WING_VEHICLE_PRESET_V1]) {
    const verdict = validateVehicleProfileV1(preset);
    assert.equal(verdict.ok, true, preset.id);
  }
});
