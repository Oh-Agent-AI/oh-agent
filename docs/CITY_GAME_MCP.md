# City Game Control MCP (local, headless)

`apps/agent-city/mcp/city-game-mcp.mjs` is a stdio MCP server that lets an Agent **play a
City game headlessly** so it can test it: open a session, feed inputs, step the fixed-step
simulation, read state / rule counters / a deterministic trace. It is the game-playing
counterpart of the Creator MCP (which can build, bind, publish and *open* a playtest but
never control one).

No network, no Three.js, no DOM, no persistence between processes. Every session lives in
memory for the lifetime of the server process.

## Start

From the repo root:

```bash
node --experimental-transform-types \
  --import ./scripts/mecha-ts-register.mjs \
  ./apps/agent-city/mcp/city-game-mcp.mjs
```

or from `apps/agent-city/ui`:

```bash
npm run mcp:game
```

An MCP client entry (`<repo>` is this checkout):

```json
{
  "mcpServers": {
    "city-game-control": {
      "command": "node",
      "args": [
        "--experimental-transform-types",
        "--import", "<repo>/scripts/mecha-ts-register.mjs",
        "<repo>/apps/agent-city/mcp/city-game-mcp.mjs"
      ]
    }
  }
}
```

> `--experimental-transform-types` (not `-strip-types`) is required: the runtime wrapper
> uses TypeScript parameter properties, which type stripping alone cannot run.

## Tools

| Tool | Purpose |
|---|---|
| `game_types` | Supported game types, vehicle presets, the shared input vocabulary and the determinism guarantee |
| `game_open` | Open a session: `gameType` (`flight`/`driving`), optional `vehicle` (preset id or a full `VehicleProfileV1`), optional creator `pack` + `gates`, optional `spawn`/`seed`/`maxTicks`; or `releaseId` (+ `dataHome`) to take vehicle/pack/gates from a published release |
| `game_step` | Advance N fixed ticks (≤600) holding one input; returns state, counters, gate count |
| `game_script` | Run a whole script (`[{ticks, input}, …]`) in one call; returns `traceDigest` |
| `game_state` | Read the authoritative state of a session |
| `game_trace` | Sampled trace (10 Hz, ≤512 samples) + `traceDigest` |
| `game_close` | Release the session's rule runner |

## Units and vocabulary

- **Everything is metres.** `gates` are gate centres in metres with a trigger `radius`
  (default 8 m); `pose`/`speed` are reported back in metres and m/s (flight) or units/s
  (driving). Internally the flight model runs in the City's world units (`/2`).
- One input vocabulary for every game type: `throttleUp` / `throttleDown` / `turnLeft` /
  `turnRight` / `pitchUp` / `pitchDown`. Driving aliases `forward` / `backward` / `left` /
  `right` are accepted, so the same script runs against either game type.

## Release mode (`releaseId`)

`game_open({ releaseId, dataHome })` reads the Creator store
`<data_home>/state/creator/projects.sqlite` (read-only) and takes:

- **vehicle** — the profile frozen at publish (`snapshot.vehicle`, id checked against `vehicleId`);
- **pack** — `snapshot.game`, with its digest recomputed as `sha256(canonicalJson(game))` and compared
  to every mount's `game.digest` (a mismatch is a corrupt release, not a new game);
- **gates** — `mount.bindings` → snapshot anchors → layout geometry.

`dataHome` defaults to `$AV_DATA_HOME` or `~/.agent-vitals`.

### Gate geometry is usually missing — by design, not by bug

The City adapter states it explicitly: *"geometry stays in the City adapter and is never
serialized"*. Layout snapshots v1/v2 carry anchors + links but **no** `positionMeters` /
`activationRadiusMeters`, and regenerating the city headlessly is **not** a substitute —
road pruning depends on live session data, so the regenerated node set does not match the
`geometryRef`s the snapshot recorded.

So the resolver never guesses:

- snapshot carries `geometry: [{ geometryRef, positionMeters, activationRadiusMeters? }]`
  (the shape a future snapshot version will serialize) → gates are resolved and
  `release.gateSource === "layout-geometry"`;
- otherwise → `isError: gates_required` with `boundAnchors` (which anchor ids the mounts
  bind) and `warnings: ["gate_geometry_not_serialized"]`; pass `gates` yourself in metres
  and `release.gateSource === "caller"`.

A partially resolvable gate set is refused whole (`gate_anchor_not_found`,
`gate_geometry_unresolved`, `gate_radius_missing`) — half a gate list silently moves the
game.

### Known content gap (fixed for new content, 2026-11-15)

`creator_city_anchor_upsert` only lets an anchor reuse an **existing** City geometryRef, so a
flight gate is usually bound to a road node. Two consequences:

1. several gates can end up on one node (a point, not a course) — still a content mistake to
   watch for;
2. road-node anchors carry **no** activation radius → `createMountedMiniGamePlan` rejects
   them with `zone_geometry_unavailable`.

The app-side fixes now handle both: the anchor upsert requires a fly spawn and adds the
reachability links, `creator_mount_bind` refuses a non-spawn entry, and the playtest view
merge gives a radius-less fly zone the documented 12 m default
(`RELEASE_ZONE_DEFAULT_RADIUS_METERS`). Releases frozen before that fix (no links, zone
entry) must be re-bound and re-published — the resolver refuses them honestly rather than
guessing.

## Rules are the real rules

`game_open` with a `pack` synthesises a sandbox layout whose anchors are exactly the gates
you passed, then builds the plan through **`createMountedMiniGamePlan`** and runs it through
**`MountedMiniGameControllerV1`** — the same validation and the same SDK rule runner the
in-app playtest uses. The server never reinterprets a creator pack: gate triggers, counters,
`timer.expired`, `run.finish` and the outcome all come from the runner, so a pass here means
a pass in the UI.

Vehicle physics is `vehicleFlightParams` from `FlightSimulation.ts` — the same single source
the engine uses (see `docs/CREATOR_FLIGHT_PIPELINE_2026_11_15.md` on the performance
derivation).

## Determinism

Fixed step `1/60 s`, no randomness. The same `game_open` arguments plus the same script
produce the same `traceDigest` — compare digests to detect a regression, and use two sessions
with different vehicles to prove trajectories actually diverge.

## Limits and what this server does NOT do

- Bounded: ≤64 gates, ≤600 ticks per step, ≤36 000 ticks per session, ≤512 trace samples.
- **No city collision.** The headless session uses a free plane / free car; obstacles,
  buildings and terrain are not loaded. A gate placed inside a building is reachable here
  but not in the app.
- **No releases / Studio.** It does not read `creator_releases`, does not resolve a City
  layout, and does not write playtest evidence. Use the Creator MCP
  (`creator_playtest_start/result`) for real, published playtests.
- **No input traces on disk.** Nothing is persisted; the trace lives in the session.
