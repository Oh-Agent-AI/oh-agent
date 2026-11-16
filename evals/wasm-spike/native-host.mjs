/**
 * Node-native execution face of the spike: the same dist bundle that Studio's webview
 * pipeline would load, imported by V8 (Node 22) instead of WASM QuickJS.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const distIndex = path.resolve(import.meta.dirname, "../../packages/agent-vitals-city-sdk/dist/index.js");
const distUrl = pathToFileURL(distIndex).href;

const citySdk = await import(distUrl);

export function validateNative(jsonText) {
  return JSON.stringify(citySdk.validateVehicleProfileV1(JSON.parse(jsonText)));
}

export function nativePreset() {
  return citySdk.ORNITHOPTER_VEHICLE_PRESET_V1;
}

export function nativeValidateObject(profile) {
  return JSON.stringify(citySdk.validateVehicleProfileV1(profile));
}

export { distIndex, distUrl };
