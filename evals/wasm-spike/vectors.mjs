/**
 * W1 spike acceptance vectors (docs/STUDIO_AGENT_FIRST_EDITOR_SPEC_2026_11_15.md section 11.3).
 *
 * Naming note: the task brief refers to the host-side structural gate codes
 * (`creator_vehicle_*`, apps/desktop/src-tauri/src/creator_projects.rs). The city-sdk TS
 * validator emits its own `vehicle_profile_*` codes; the vectors below assert the *TS
 * validator's* codes because both sides of this comparison run that validator. The mapping is
 *   vehicle_profile_invalid      <-> creator_vehicle_invalid
 *   vehicle_profile_out_of_bounds <-> creator_vehicle_out_of_bounds
 *   vehicle_profile_unphysical    <-> creator_vehicle_unphysical
 * Every vector is a JSON text so both runtimes parse the *same bytes* with their own
 * JSON.parse before calling validateVehicleProfileV1 — the shape the host integration will
 * actually use (JSON in, diagnostics out).
 */

const PRESET_JSON = `{
  "schemaVersion": 1,
  "id": "vehicle.ornithopter",
  "label": "扑翼机",
  "modelAssetId": null,
  "flightModel": "flapping",
  "physics": {
    "massKg": 340,
    "wingAreaM2": 18,
    "thrustN": 10000,
    "maxSpeedMps": 120,
    "dragCoefficient": 0.1,
    "turnRateRps": 0.9,
    "climbRateMps": 34,
    "sinkRateMps": 26,
    "flapFrequencyHz": 2.4,
    "flapAmplitudeRad": 1.1
  },
  "bounds": { "halfLengthM": 3.6, "halfWidthM": 4.8, "halfHeightM": 1.4 },
  "camera": { "followDistanceM": 26, "heightOffsetM": 12, "fovDeg": 52 }
}`;

function mutate(jsonText, mutation) {
  const parsed = JSON.parse(jsonText);
  mutation(parsed);
  return JSON.stringify(parsed);
}

const outOfBoundsJson = mutate(PRESET_JSON, profile => { profile.physics.maxSpeedMps = 999; });
const unphysicalJson = mutate(PRESET_JSON, profile => { profile.physics.wingAreaM2 = 2.0; });
const unknownKeyJson = mutate(PRESET_JSON, profile => { profile.extra = 1; });
const nonObjectJson = `42`;
const badSchemaJson = mutate(PRESET_JSON, profile => { profile.schemaVersion = 2; });

export const VECTORS = [
  {
    id: "valid-preset",
    description: "ORNITHOPTER_VEHICLE_PRESET_V1 (as JSON text) -> ok:true",
    expectOk: true,
    expectCodes: [],
    jsonText: PRESET_JSON,
  },
  {
    id: "out-of-bounds",
    description: "physics.maxSpeedMps = 999 -> vehicle_profile_out_of_bounds at physics.maxSpeedMps",
    expectOk: false,
    expectCodes: ["vehicle_profile_out_of_bounds"],
    jsonText: outOfBoundsJson,
  },
  {
    id: "unphysical-wing-loading",
    description: "physics.wingAreaM2 = 2.0 (loading 170 kg/m^2 > 120) -> vehicle_profile_unphysical at physics.wingAreaM2",
    expectOk: false,
    expectCodes: ["vehicle_profile_unphysical"],
    jsonText: unphysicalJson,
  },
  {
    id: "unknown-key",
    description: "unknown top-level key -> vehicle_profile_invalid",
    expectOk: false,
    expectCodes: ["vehicle_profile_invalid"],
    jsonText: unknownKeyJson,
  },
  {
    id: "non-object-input",
    description: "JSON number input -> vehicle_profile_invalid (single fatal diagnostic)",
    expectOk: false,
    expectCodes: ["vehicle_profile_invalid"],
    jsonText: nonObjectJson,
  },
  {
    id: "unsupported-schema-version",
    description: "schemaVersion = 2 -> vehicle_profile_unsupported",
    expectOk: false,
    expectCodes: ["vehicle_profile_unsupported"],
    jsonText: badSchemaJson,
  },
];

export { PRESET_JSON };
