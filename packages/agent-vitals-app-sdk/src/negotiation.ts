import { PROJECTION_CAPABILITIES } from "./generated/contracts.js";

export function negotiateProjection(request: { id: string; face: string; versions: readonly number[] }):
  | { supported: true; version: number }
  | { supported: false; reason: "unsupported_projection" | "unsupported_face" | "unsupported_version" } {
  const named = PROJECTION_CAPABILITIES.filter((entry) => entry.id === request.id);
  if (named.length === 0) return { supported: false, reason: "unsupported_projection" };
  const faced = named.filter((entry) => entry.face === request.face);
  if (faced.length === 0) return { supported: false, reason: "unsupported_face" };
  const versions = faced.filter((entry) => request.versions.includes(entry.version)).map((entry) => entry.version);
  if (versions.length === 0) return { supported: false, reason: "unsupported_version" };
  return { supported: true, version: Math.max(...versions) };
}
