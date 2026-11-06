# City Driving Native Endurance Test

## Purpose

Verify the packaged macOS app can drive continuously without false long-frame pauses, input lockup, scene lease loss, steadily growing render resources, or a frozen HUD. This is an interactive acceptance test; headless ticks and browser tests are supporting evidence only.

## Build and launch

Build the UAT bundle from the tested worktree:

```sh
cd apps/desktop/src-tauri
AGENT_VITALS_CITY_GAME_UAT=1 cargo tauri build --bundles app
open target/release/bundle/macos/agent-vitals.app
```

Never launch the menubar executable directly. Record the tested Git HEAD, app bundle build timestamp, city session count, seed, macOS version, display refresh rate, and selected quality level.

## 30-minute drive protocol

1. Enter the actual populated city and choose a connected roadway, including one bridge approach if available. Start a stopwatch after the car is moving.
2. Drive for 30 minutes. Every 5 minutes alternate acceleration, braking/reverse, steering, pause/resume, and camera orbit. Include at least five city intersections and one bridge transition; avoid repeatedly tapping controls only at spawn.
3. At each 5-minute mark record HUD speed, runtime sample count, frame P95/P99, tick CPU P95, present CPU P95, maximum catch-up steps, frame-gap/catch-up counters, camera holds/shrinks, event-log count, and renderer geometry/texture counts if available.
4. At the end, pause and resume once, exit driving, re-enter, and verify the city view and controls recover. Check macOS Activity Monitor for memory trend and note process memory at each mark.
5. If a pause, stall, collision trap, or unexplained stop occurs, preserve the on-screen local event timeline and note wall-clock time, XYZ, reason, obstacle IDs, and last 60 seconds of runtime metrics. Do not upload local logs.

## Acceptance criteria

- No unexpected pause or unresolved simulation state during ordinary driving.
- No input loss lasting more than one second while the app remains foregrounded.
- Frame P95 remains at or below 33.3 ms at the selected quality; any sustained >50 ms period is investigated and recorded.
- No monotonic renderer geometry/texture growth across repeated pause/resume/entry cycles after warm-up. Process memory may fluctuate; report the measured trend rather than inferring a leak from one sample.
- Exit restores the city camera and controls, and re-entry works without restarting the app.
- All failures retain a local reason and location; an inconclusive query must not be reported as a blocked road or a successful passage.

## Run record

| Field | Result |
|---|---|
| Status | Partial native UAT — 2026-10-19; 30-minute endurance and bridge crossing not completed |
| Git HEAD / dirty worktree | `b1ea565a` / dirty; bundle includes the worktree UI and city-driving changes |
| App build timestamp | 2026-10-19 07:37:32 CST; `cargo tauri build --bundles app` succeeded and the built `.app` was opened with Launch Services |
| macOS / display / quality | macOS 26.5.2 (25F84), Apple M3 Pro, built-in Liquid Retina XDR 3024×1964; refresh rate and quality preset not exposed by the captured system report/UI |
| City sessions / seed / road region | Live populated City scene; seed/session identity was not exposed in the native HUD. Spawn XYZ `(-63.4, 1.2, 802.8)` |
| Duration | About 2 minutes of interactive driving across two diagnostic entries; process was alive for 5m33s at the memory sample. Does not satisfy the 30-minute protocol |
| Unexpected pauses / stalls | Initial straight-road acceleration worked and reached 91.7 km/h. After steering at the next junction, the car stopped at a curb/divider and HUD showed `Obstacle ahead`; event log reported `support-stop` around `(45.3, 1.2, 1040.2)`. Reverse moved the car once, but forward recovery did not. This is a real route blockage/support-boundary case; it is not evidence about an elevated-road bridge transition. No long-frame pause or scene-lease failure observed. |
| 5-minute metric samples | No 5-minute marks reached. Last expanded snapshot: frame P95 47 ms, tick CPU P95 1 ms, present CPU P95 1 ms, maximum catch-up 5, frame-budget overruns 4, camera holds/shrinks 0; sample window capped at 2,048. The short interactive window includes UI inspection and is not a steady-state performance result. |
| Memory / geometry / texture trend | One process RSS sample: 1,145,344 KiB (~1.09 GiB) at 5m33s uptime. No renderer geometry/texture counters available and no trend can be inferred from one sample. |
| Exit and re-entry | Pass — exited the first diagnostic session back to City, then re-entered the driving session without restarting the app. Escape resumed from the initial ready/pause state. |
| Evidence location | Live native UI observations only; no screenshot or raw event log was saved. Event details remain in the session-local in-memory diagnostic panel and are not uploaded. |
| Focused regression checks | Pass — `node scripts/verify-city-expressway-driving.mjs` (152/152 real elevated-road samples accept parked + rolling cars; without deck policy 152/152 block; deep overlap remains physical); `node scripts/verify-city-driving-bridge-crossing.mjs` (beam bridge reaches far road, suspension bridge dead end stops at railing, under-deck body remains blocked). These are deterministic fixture tests, not evidence that this native city route crossed a bridge. |

## Supporting code checks (not native acceptance)

On 2026-10-19 the current worktree passed:

- `node scripts/verify-city-driving-event-log.mjs`
- `node scripts/verify-city-driving-bridge-crossing.mjs`
- `node scripts/verify-city-bridge-roll-transition.mjs`
- `node scripts/verify-city-bridge-roll-transition.mjs --bank-42`
- `node scripts/verify-city-preparation.mjs`
- `node scripts/verify-city-driving-entry.mjs`
- `node scripts/verify-city-driving-vtol.mjs`
- `node scripts/verify-city-driving-structure-world.mjs`
- `node scripts/verify-city-frame-surface.mjs`
- `cd apps/agent-city/ui && npm run typecheck && npm run build`

These tests do not replace the interactive endurance run above.

## 2026-10-20 P0 build and attempted acceptance

- Base `b1cb7d3d` plus the input/title/navigation repairs and collision v6; the same source is now recorded in `aa7efe9d`, `481844e7`, `a24b2731`, and packaging configuration in `ce432d8c`.
- `cargo tauri build --bundles app --no-sign --ci` succeeded. Bundle path: `apps/desktop/src-tauri/target/release/bundle/macos/agent-vitals.app`; identifier `ai.ohagent.desktop`, CLI authority schema v32. This is an unsigned local validation bundle, not a notarized release.
- Workbench/City/native driving preparation were observed; a key-held acceleration reached 77.6 km/h, pause/resume/reverse controls responded, and a rolling HUD snapshot showed frame P95 about 22–24 ms, tick/present CPU P95 1 ms, catch-up maximum 3 and zero frame overruns. These observations were made while an older installed app with the same identifier was still running, so they are preliminary and cannot prove which build was controlled.
- The older installed instance was exited to disambiguate. The next computer-control observation reported the Mac locked; a manual unlock was requested. Latest-build driving, physical IME, airplane/car switching, session-detail navigation and the 30-minute endurance run are therefore **not accepted yet**. No 30-minute memory or frame trend was recorded.
- Collision evidence independent of the GUI: captured tick181 query resolves as contact in 9235 tests with the original 18553 remaining budget; 17 historical differential cases pass. Large-city structure-transition checks have no budget-exhausted results in the tested 1000/7, 1000/65537 and 2000/42 runs; 1000/7 still has topology/pilot failures. These are not substitutes for native acceptance.
