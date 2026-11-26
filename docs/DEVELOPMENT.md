# Development guide

Start with the [repository guidelines](../AGENTS.md). Use the paths and checks below for the area you are changing.

## Architecture and code entry points

| Area | Current entry point | Further reading |
| --- | --- | --- |
| Creator Studio | [Studio UI](../apps/creator-studio/ui/src) and [Creator MCP tools](../crates/agent-vitals-mcp/src/mcp) | [Connect an agent](AGENT_CREATOR_MCP_CLIENT_SETUP.md) · [Experience packages](CREATOR_EXPERIENCE_PACKAGE_2026_11_16.md) |
| City and gameplay | [City UI](../apps/agent-city/ui/src), including the engine and built-in flight, driving, mecha and cinema | [Code game preview isolation](CITY_CODE_GAME_PREVIEW_ISOLATION_SPEC_2026-11-19.md) |
| SDKs | [App SDK](../packages/agent-vitals-app-sdk), [City SDK](../packages/agent-vitals-city-sdk), [Game SDK](../packages/city-game-sdk), [City game runtime](../packages/agent-vitals-city-game-runtime) and [Narrative SDK](../packages/agent-vitals-narrative-sdk) | [City SDK V3 RFC](OH_AGENT_CITY_SDK_V3_INTEGRATION_RFC_2026-11-19.md) · [Implementation report and open work](V3_IMPLEMENTATION_REPORT_2026-11-21.md) |
| Desktop and lifecycle | [Tauri host](../apps/desktop/src-tauri), [official plugin descriptors](../apps/desktop/plugins.json) and [React workbench](../apps/desktop/ui-dev) | [Desktop setup and packaging](../apps/desktop/src-tauri/README.md) |
| Local analytics and CLI | [Rust CLI](../apps/cli), [data/domain/harness/runtime crates](../crates) and [Python implementation](../packages/agent-vitals-python) | [Data handling and billing](DATA_HANDLING_POLICY.md) · [Golden fixtures](../golden) · [Tests](../tests) |
| Web demo and public docs | [Landing page](../website/landing) and [documentation site](../website/docs) | [Landing build and verification](../website/landing/README.md) |

Studio composes authoring and review workflows. City and game runtimes execute in TypeScript. The desktop host supplies authorized data and commits durable changes. Keep the TS authoring and presentation path usable through explicit ports so a browser runtime does not require desktop IPC for input or rendering.

The Miami application shell, world, themes and built-in games still live in this repository. The target layout keeps the shared engine and SDK contracts in the platform repository and moves the City app and the four game packages to their own repositories. Studio manages content through manifests, verified builds and installations. Before cutting over, replace Studio's direct imports of City internals, remove the engine's dependencies on specific games, and verify pinned builds, runtime discovery and gameplay parity.

### Remote gameplay

- **Browser-local play.** The Web City runtime processes input, simulation and rendering in TypeScript. A visitor session keeps its play state separate from the owner's desktop state. The public demo uses synthetic data.
- **Remote control of an existing session.** A receiving device uses the commands of a specific authorized session. The TS game runtime handles those commands and produces game state. Host and relay enforce identity, capability, expiry, and message bounds. Persistent writes and evidence use the host's normal authority checks.
- **New modes.** Define and verify the capability, field allowlist and stop/revocation behavior first. Relay payloads stay in memory. New games use the SDK's scoped ports. Any extension of the data or authority exposed remotely requires a reviewed policy decision. [Data policy, items 7–8](DATA_HANDLING_POLICY.md#remote-exceptions)

For the current implementation and validation gaps, see the [remote interaction design](REMOTE_GAME_INTERACTION_ARCHITECTURE_2026_11_08.md) and the [Dream City implementation notes](AGENT_CITY_DREAM_CITY_IMPLEMENTATION_SPEC_2026_11_08.md).

## Build and develop

Run the commands from the repository root. Use stable Rust, npm and Node.js 22 for the TS test commands below. Check the [desktop instructions](../apps/desktop/src-tauri/README.md) for Tauri and platform prerequisites. The desktop has its own Cargo workspace.

```sh
cargo build --release
./target/release/agent-vitals --help
```

For a fresh City and Studio frontend checkout, build the City SDK before checking consumers. Studio currently shares City viewport source, so install the City dependencies too.

```sh
npm ci --prefix packages/agent-vitals-city-sdk
npm run build --prefix packages/agent-vitals-city-sdk
npm ci --prefix packages/city-game-sdk
npm ci --prefix apps/agent-city/ui
npm ci --prefix apps/creator-studio/ui
```

Use the [Game SDK examples](../packages/city-game-sdk/README.md) or [hello-city](../games/hello-city/README.md) to develop a game package. Integration instructions live next to each adapter, including the [DSH profile bundle](../integrations/dsh/README.md).

### macOS build and tray

```sh
bash scripts/build-macos-app.sh
open "apps/desktop/src-tauri/target/release/bundle/macos/Oh Agent.app"
```

Use the built bundle for tray checks. Keep `set_activation_policy(Accessory)` in the app so the policy is restored after tao initializes. The current bundle ID is `ai.ohagent.desktop`. The CLI and current data-directory names retain `agent-vitals`.

<details>
<summary>macOS 26 tray incident notes</summary>

The September 2026 incident showed that running a bare menu bar binary can register the status item under the launcher, leaving a stale entry and hiding the tray. Launch with `open` and check the app's entry in System Settings → Menu Bar.

For historical diagnosis, the Control Center preference file under the group container holds `trackedApplications` as nested binary plist data. It contains identity/record pairs with `menuItemLocations` and `isAllowed`. Inspect the nested data rather than relying on the outer plist display. The incident used an older bundle ID. Use the installed bundle's ID when identifying entries. Direct edits to that preference can race cached writes by `cfprefsd` or Control Center. System preference recovery is separate from a repository build or tray check.

</details>

## Checks

Pick the checks relevant to the change. The CI workflows cover platform and packaging details.

| Change | Checks from the repository root |
| --- | --- |
| Rust CLI and shared crates | `cargo test --release` and `cargo clippy --release --all-targets -- -D warnings` |
| Creator MCP | `cargo test -p agent-vitals-mcp`. Live Studio calls need the desktop host and an active official Studio instance. |
| Desktop host | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` after preparing desktop build resources. See [desktop CI](../.github/workflows/desktop-platforms.yml) for platform coverage. |
| Studio UI | `npm run typecheck --prefix apps/creator-studio/ui` and `npm test --prefix apps/creator-studio/ui` |
| City UI | `npm run typecheck --prefix apps/agent-city/ui`. See [City guards](../.github/workflows/verify.yml) for the affected gameplay and projection checks. |
| SDK contracts | Run `npm test` and `npm run typecheck` in the affected package. For changes to the embedded City validator, also use `node apps/desktop/src-tauri/embedded_city_sdk/build.mjs --check`. |
| Relay | In `apps/agent-city/relay`, run `npm ci`, `npm test` and `npm run typecheck`. |
| Python and output contracts | `python3 -m unittest discover tests -v` and `python3 tests/golden_runner.py --diff` |
| Rust/Python parity | After building the Rust CLI, run `AGENT_VITALS_BIN="$PWD/target/release/agent-vitals" python3 tests/golden_runner.py --diff`. |
| Public demo | `node website/landing/tools/verify-landing.mjs`. See the [landing guide](../website/landing/README.md) to rebuild and preview it. |

Use descriptive `test_*.py` names and `unittest.TestCase` classes. Put Rust integration tests under the affected crate's `tests/` directory. Cover malformed inputs, harness contracts and cross-language parity where applicable. Treat reviewed golden updates as contract changes.
