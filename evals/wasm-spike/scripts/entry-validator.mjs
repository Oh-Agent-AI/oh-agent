/**
 * Tree-shaken spike entry: re-exports only the vehicle validator surface from the built
 * city-sdk dist artifact. esbuild consumes the ESM dist (sideEffects:false) and drops every
 * other validator, so the resulting IIFE measures the validator-only footprint a host
 * integration would actually embed. Provenance is unchanged: the code comes from dist bytes.
 */
export { validateVehicleProfileV1, ORNITHOPTER_VEHICLE_PRESET_V1 } from "../../../packages/agent-vitals-city-sdk/dist/index.js";
