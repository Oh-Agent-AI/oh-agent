# @agent-vitals/city-game-runtime

Runtime architecture for City game types. This package is intentionally
separate from `@agent-vitals/city-sdk`:

- `city-sdk` owns data-only content contracts and validation (`GameTypeDescriptorV1`,
  slots, parameters, rules, packages).
- this package owns the trusted runtime contract (`GameRuntimeV1`), the
  type→adapter registry, and app-injected ports (scene/input/audio/clock/activity).
- it must not import Three.js, React, DOM, or CityEngine. The app supplies ports.

## What is implemented here

- `GameRuntimeRegistryV1`: register a validated descriptor with a runtime
  implementation, resolve by `type + contractVersion`, reject duplicates,
  unknown types and version drift with stable codes.
- `GameRuntimeV1` / `GameRuntimeHandleV1` interfaces.
- Ports: scene, input, audio, clock, activity.
- `MIAMI_ACTIVITY_CATALOG_V1`: descriptors for the four built-in Miami
  activities (flight/driving/mecha/cinema). **Descriptors only** — existing
  app implementations must be wrapped as adapters before registration.
- `templateCatalog` lockstep: `creator` templates must exist in
  `CREATOR_TEMPLATES_V1`, `builtin` templates must exist in
  `BUILTIN_ACTIVITY_TEMPLATE_IDS`, and `planned` descriptors are rejected by
  the registry until their template lands.
- `ORNITHOPTER_GAME_TYPE_V1`: the planned Creator flight game type.
- `createMiamiLegacyRegistry(host)`: registers the four Miami activities as
  host-driven adapters delegating to `MiamiLegacyActivityHostV1.enter`. The SDK
  never double-steps them. The app-side host wiring and real Miami golden-script
  regression are the next step.

## Not implemented yet

Miami adapters, extracted flight/driving/mecha kernels, Creator templates,
capability publication and actual runtime registration. Those are the next
migration slices; none of them may change Miami behavior without golden tests.

## Migration sequence

1. Wrap `GameSession` (flight), driving session, `MechaModeRuntime`/cinema as
   app-side adapters; register them under a local registry.
2. Move only pure motion/input kernels into `@agent-vitals/city-game-kernels`
   if duplication is proven.
3. Add the ornithopter adapter using flight ports/kernels without editing
   Miami `FlightSimulation`.
4. Wire Creator capabilities/templates to descriptor discovery.
