import type { MechaRemoteCapability } from "./remoteCapability";

/** v1.5 is the only phone surface; old capability links fail closed with an explanation. */
export function remoteRoute(capability: MechaRemoteCapability | null): "sequential" | "retired" {
  return capability === "mecha:v4" ? "sequential" : "retired";
}
