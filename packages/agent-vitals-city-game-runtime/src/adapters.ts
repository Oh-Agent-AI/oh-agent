import type { GameTypeDescriptorV1 } from "../../agent-vitals-city-sdk/src/index";
import { createGameRuntimeRegistry, type GameRuntimeRegistryV1 } from "./registry";
import { MIAMI_ACTIVITY_CATALOG_V1 } from "./builtin";
import type { GameRuntimeResultV1, GameRuntimeTelemetryV1, GameRuntimeV1 } from "./types";

/** The four existing Miami activities. They remain host-owned: the adapter
 * does not extract or reimplement their React/engine lifecycle. */
export type MiamiActivityIdV1 = "flight" | "driving" | "mecha" | "cinema";

export type MiamiLegacyActivityHandleV1 = Readonly<{
  telemetry: () => GameRuntimeTelemetryV1;
  dispose: () => void;
}>;

/** Host bridge implemented by the app around its existing hooks/session code.
 * `enter` must perform the same admission/lease steps the current UI uses; the
 * adapter only standardizes resolve/prepare/dispose and telemetry reading. */
export type MiamiLegacyActivityHostV1 = Readonly<{
  enter: (activity: MiamiActivityIdV1) => Promise<GameRuntimeResultV1<MiamiLegacyActivityHandleV1>>;
}>;

const ACTIVITY_IDS: readonly MiamiActivityIdV1[] = Object.freeze(["flight", "driving", "mecha", "cinema"]);

function descriptorFor(activity: MiamiActivityIdV1): GameTypeDescriptorV1 {
  const descriptor = MIAMI_ACTIVITY_CATALOG_V1.find(item => item.runtime.id === `miami.${activity}`);
  if (!descriptor) throw new Error(`Missing built-in descriptor for miami.${activity}.`);
  return descriptor;
}

/** Wrap one host-owned activity behind the runtime contract. The adapter is
 * `host-driven`: it must not call fixedStep or claim to own the simulation. */
export function createMiamiLegacyRuntime(activity: MiamiActivityIdV1, host: MiamiLegacyActivityHostV1): GameRuntimeV1 {
  const descriptor = descriptorFor(activity);
  return Object.freeze({
    type: descriptor.runtime.id,
    contractVersion: descriptor.runtime.contractVersion,
    execution: "host-driven" as const,
    prepare: async (): Promise<GameRuntimeResultV1<MiamiLegacyActivityHandleV1>> => host.enter(activity),
  });
}

/** Register the four Miami activities in a fresh app-side registry. This does
 * not surface them as Creator capabilities; descriptors remain catalog-only. */
export function createMiamiLegacyRegistry(host: MiamiLegacyActivityHostV1): GameRuntimeRegistryV1 {
  const registry = createGameRuntimeRegistry();
  for (const activity of ACTIVITY_IDS) registry.register(descriptorFor(activity), createMiamiLegacyRuntime(activity, host));
  return registry;
}
