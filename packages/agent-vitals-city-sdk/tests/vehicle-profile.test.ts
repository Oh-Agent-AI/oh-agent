import test from "node:test";
import assert from "node:assert/strict";
import { FIXED_WING_VEHICLE_PRESET_V1, ORNITHOPTER_VEHICLE_PRESET_V1, validateVehicleProfileV1,
  VEHICLE_BOUNDS_LIMITS_V1, VEHICLE_CAMERA_BOUNDS_V1, VEHICLE_PHYSICS_BOUNDS_V1, VEHICLE_PHYSICS_KEYS_V1, VEHICLE_PHYSICS_RATIOS_V1,
  type VehicleProfileV1 } from "../src/vehicleProfile";
import { validateMiniGamePack } from "../src/content";
import { CREATOR_TEMPLATES_V1 } from "../src/creatorTemplates";

const clone = (profile: VehicleProfileV1): Record<string, unknown> => JSON.parse(JSON.stringify(profile)) as Record<string, unknown>;
const firstCode = (result: { ok: boolean; diagnostics: Array<{ code: string; path: string }> }) => {
  assert.equal(result.ok, false, "expected rejection");
  return result.diagnostics[0]!;
};

test("both built-in presets validate and are deeply frozen", () => {
  for (const preset of [ORNITHOPTER_VEHICLE_PRESET_V1, FIXED_WING_VEHICLE_PRESET_V1]) {
    const verdict = validateVehicleProfileV1(preset);
    assert.equal(verdict.ok, true, preset.id);
    assert.deepEqual(verdict.ok ? verdict.diagnostics : [], []);
    assert.equal(Object.isFrozen(preset), true);
    assert.equal(Object.isFrozen(preset.physics), true);
    assert.equal(Object.isFrozen(preset.bounds), true);
    assert.equal(Object.isFrozen(preset.camera), true);
  }
  assert.equal(ORNITHOPTER_VEHICLE_PRESET_V1.flightModel, "flapping");
  assert.equal(ORNITHOPTER_VEHICLE_PRESET_V1.modelAssetId, null);
  assert.equal(FIXED_WING_VEHICLE_PRESET_V1.flightModel, "fixed-wing");
});

test("preset physics stays inside the declared per-key bounds (bound pins)", () => {
  for (const preset of [ORNITHOPTER_VEHICLE_PRESET_V1, FIXED_WING_VEHICLE_PRESET_V1]) {
    for (const [key, value] of Object.entries(preset.physics)) {
      const [min, max] = VEHICLE_PHYSICS_BOUNDS_V1[key as keyof typeof VEHICLE_PHYSICS_BOUNDS_V1];
      assert.ok(value >= min && value <= max, `${preset.id}.${key}=${value} outside [${min}, ${max}]`);
    }
    for (const [key, value] of Object.entries(preset.camera)) {
      const [min, max] = VEHICLE_CAMERA_BOUNDS_V1[key as keyof typeof VEHICLE_CAMERA_BOUNDS_V1];
      assert.ok(value >= min && value <= max, `${preset.id}.${key}=${value} outside [${min}, ${max}]`);
    }
    for (const [key, value] of Object.entries(preset.bounds)) {
      const [min, max] = VEHICLE_BOUNDS_LIMITS_V1.halfExtentM;
      assert.ok(value >= min && value <= max, `${preset.id}.${key}=${value} outside [${min}, ${max}]`);
    }
  }
});

test("preset physics stays physically usable (wing loading / thrust-to-mass ratios pinned)", () => {
  for (const preset of [ORNITHOPTER_VEHICLE_PRESET_V1, FIXED_WING_VEHICLE_PRESET_V1]) {
    const loading = preset.physics.massKg / preset.physics.wingAreaM2;
    assert.ok(loading >= VEHICLE_PHYSICS_RATIOS_V1.minWingLoadingKgPerM2 && loading <= VEHICLE_PHYSICS_RATIOS_V1.maxWingLoadingKgPerM2, `${preset.id} wing loading ${loading}`);
    const accel = preset.physics.thrustN / preset.physics.massKg;
    assert.ok(accel >= VEHICLE_PHYSICS_RATIOS_V1.minThrustAccelMs2 && accel <= VEHICLE_PHYSICS_RATIOS_V1.maxThrustAccelMs2, `${preset.id} thrust accel ${accel}`);
  }
});

test("physics keys are exactly the declared set for the declared flight model", () => {
  assert.deepEqual(Object.keys(FIXED_WING_VEHICLE_PRESET_V1.physics), [...VEHICLE_PHYSICS_KEYS_V1["fixed-wing"]]);
  assert.deepEqual(Object.keys(ORNITHOPTER_VEHICLE_PRESET_V1.physics), [...VEHICLE_PHYSICS_KEYS_V1["flapping"]]);
  // flapping-only keys must not appear in the fixed-wing key list and vice versa.
  assert.ok(VEHICLE_PHYSICS_KEYS_V1["fixed-wing"].every(key => !key.startsWith("flap")));
  assert.ok(VEHICLE_PHYSICS_KEYS_V1["vtol"].includes("hoverClimbRateMps"));
});

test("rejects unknown top-level fields and wrong schema version", () => {
  const input = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
  (input as Record<string, unknown>).script = "run()";
  assert.equal(firstCode(validateVehicleProfileV1(input)).code, "vehicle_profile_invalid");
  const schema = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
  schema.schemaVersion = 2;
  assert.equal(firstCode(validateVehicleProfileV1(schema)).code, "vehicle_profile_unsupported");
});

test("rejects non-plain-text ids and labels (no script/injection surface)", () => {
  const badId = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
  badId.id = "vehicle/x;drop";
  assert.equal(firstCode(validateVehicleProfileV1(badId)).code, "vehicle_profile_invalid");
  const badLabel = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
  badLabel.label = "}<script>alert(1)</script>";
  assert.equal(firstCode(validateVehicleProfileV1(badLabel)).code, "vehicle_profile_invalid");
  const colonAsset = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
  colonAsset.modelAssetId = "data:evil";
  assert.equal(firstCode(validateVehicleProfileV1(colonAsset)).code, "vehicle_profile_invalid");
  const goodAsset = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
  goodAsset.modelAssetId = "project-asset.ornithopter-v2";
  assert.equal(validateVehicleProfileV1(goodAsset).ok, true);
});

test("rejects physics records that are not finite bounded numbers", () => {
  const stringPhysics = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
  stringPhysics.physics.massKg = "340" as unknown as number;
  assert.equal(firstCode(validateVehicleProfileV1(stringPhysics)).code, "vehicle_profile_invalid");
  const nanPhysics = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
  nanPhysics.physics.thrustN = Number.NaN;
  assert.equal(firstCode(validateVehicleProfileV1(nanPhysics)).code, "vehicle_profile_out_of_bounds");
  const infinityPhysics = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
  infinityPhysics.physics.maxSpeedMps = Number.POSITIVE_INFINITY;
  assert.equal(firstCode(validateVehicleProfileV1(infinityPhysics)).code, "vehicle_profile_out_of_bounds");
  const unknownKey = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
  unknownKey.physics.afterburnerN = 1;
  assert.equal(firstCode(validateVehicleProfileV1(unknownKey)).code, "vehicle_profile_invalid");
  const missingKey = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
  delete missingKey.physics.flapFrequencyHz;
  assert.equal(firstCode(validateVehicleProfileV1(missingKey)).code, "vehicle_profile_invalid");
  const flappingKeysOnFixedWing = clone(FIXED_WING_VEHICLE_PRESET_V1);
  flappingKeysOnFixedWing.physics.flapFrequencyHz = 2;
  assert.equal(firstCode(validateVehicleProfileV1(flappingKeysOnFixedWing)).code, "vehicle_profile_invalid");
});

test("enforces per-key numeric bounds at the boundary values", () => {
  const heavy = clone(FIXED_WING_VEHICLE_PRESET_V1);
  heavy.physics.massKg = VEHICLE_PHYSICS_BOUNDS_V1.massKg[1] + 1;
  assert.equal(firstCode(validateVehicleProfileV1(heavy)).code, "vehicle_profile_out_of_bounds");
  heavy.physics.massKg = VEHICLE_PHYSICS_BOUNDS_V1.massKg[1];
  // Boundary values are accepted only when the ratio checks still hold: a 20 t
  // airframe on the preset wing breaks wing loading, which is the intended pin.
  const verdict = validateVehicleProfileV1(heavy);
  assert.equal(verdict.ok, false);
  assert.equal(firstCode(verdict).code, "vehicle_profile_unphysical");
  const camera = clone(FIXED_WING_VEHICLE_PRESET_V1);
  camera.camera.fovDeg = VEHICLE_CAMERA_BOUNDS_V1.fovDeg[1] + 1;
  assert.equal(firstCode(validateVehicleProfileV1(camera)).code, "vehicle_profile_out_of_bounds");
  const bounds = clone(FIXED_WING_VEHICLE_PRESET_V1);
  bounds.bounds.halfWidthM = VEHICLE_BOUNDS_LIMITS_V1.halfExtentM[1] + 1;
  assert.equal(firstCode(validateVehicleProfileV1(bounds)).code, "vehicle_profile_out_of_bounds");
  const unknownCameraKey = clone(FIXED_WING_VEHICLE_PRESET_V1);
  unknownCameraKey.camera.shake = 1;
  assert.equal(firstCode(validateVehicleProfileV1(unknownCameraKey)).code, "vehicle_profile_invalid");
});

test("cross-field ratio checks reject unphysical profiles", () => {
  const paperWing = clone(FIXED_WING_VEHICLE_PRESET_V1);
  paperWing.physics.massKg = 300;
  paperWing.physics.wingAreaM2 = 400;
  assert.equal(firstCode(validateVehicleProfileV1(paperWing)).code, "vehicle_profile_unphysical");
  const overloaded = clone(FIXED_WING_VEHICLE_PRESET_V1);
  overloaded.physics.massKg = 20000;
  overloaded.physics.wingAreaM2 = 160;
  assert.equal(firstCode(validateVehicleProfileV1(overloaded)).code, "vehicle_profile_unphysical");
  const underpowered = clone(FIXED_WING_VEHICLE_PRESET_V1);
  underpowered.physics.thrustN = 619;
  assert.equal(firstCode(validateVehicleProfileV1(underpowered)).code, "vehicle_profile_unphysical");
  const overpowered = clone(FIXED_WING_VEHICLE_PRESET_V1);
  overpowered.physics.thrustN = 18601;
  assert.equal(firstCode(validateVehicleProfileV1(overpowered)).code, "vehicle_profile_unphysical");
});

test("flight-checkpoint template lands in CREATOR_TEMPLATES_V1 with a validating pack", () => {
  const template = CREATOR_TEMPLATES_V1.find(item => item.id === "flight-checkpoint");
  assert.ok(template, "flight-checkpoint template must exist");
  assert.equal(template.pack.id, "creator.flight-checkpoint");
  assert.equal(template.pack.slots.gates.kind, "zone");
  assert.equal(template.pack.slots.gates.min, 3);
  assert.equal(template.pack.slots.gates.max, 8);
  assert.deepEqual(template.pack.slots.gates.requires, ["fly"]);
  assert.ok(template.pack.integerParameters.timeLimitTicks);
  assert.deepEqual(validateMiniGamePack(template.pack).diagnostics, []);
  // The flapping naming template stays as a deprecated alias (preset-backed).
  assert.ok(CREATOR_TEMPLATES_V1.find(item => item.id === "ornithopter-flight"), "ornithopter-flight alias retained");
});
