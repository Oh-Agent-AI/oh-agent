# Windows and Linux desktop builds

The desktop crate is an independent workspace; a root `cargo build` only builds
the CLI. Build desktop packages on the target operating system.

## Local builds

Install Node.js 20 (with npm), stable Rust, and Tauri's platform prerequisites:
<https://v2.tauri.app/start/prerequisites/>. Windows requires MSVC C++ build tools
and WebView2. Ubuntu requires WebKitGTK 4.1, GTK development dependencies,
Ayatana AppIndicator, librsvg, libssl, libxdo and patchelf (see the CI workflow).

From the repository root:

```sh
npm ci --prefix apps/desktop/ui-dev
cargo install tauri-cli --version 2.11.4 --locked
cd apps/desktop/src-tauri
cargo tauri build --ci
```

Tauri automatically merges `tauri.windows.conf.json` or `tauri.linux.conf.json`.
Windows produces an NSIS installer; Linux produces deb and AppImage packages in
`apps/desktop/src-tauri/target/release/bundle/`. The build hook builds the frontend,
official plugins and native CLI, and checks the CLI authority schema.
Do not set a cross-compilation target with this hook: it builds the host CLI.

The CLI is bundled as `bin/agent-vitals.exe` on Windows and `bin/agent-vitals` on
Linux/macOS. Runtime discovery prefers an explicit `AGENT_VITALS_BIN` override,
then Tauri's resource directory, executable-relative fallbacks, and finally PATH.
An installed desktop app does not require a separately installed CLI or Python.

## CI and releases

`desktop-platforms.yml` builds Windows x86_64 and Linux x86_64 on native runners,
runs discovery regression tests, and checks the CLI extracted/installed from the
package. Ubuntu 22.04 is the Linux build baseline; this does not promise support
for every Linux distribution, display server, GPU or tray implementation.
PR builds and manual runs upload installers as Actions artifacts without publishing.

`release-desktop.yml` calls the same workflow at the release ref. Publication waits
for macOS and both native platform builds, collects all installers, and includes
them in SHA256SUMS. Existing macOS signing and notarization gates still apply.
Windows installers are currently unsigned: Authenticode signing is not configured.

The release preflight requires a completed successful `verify.yml` run for the
exact tagged commit before either platform build starts. A pending, failed or
missing Verify run prevents release. The Intel macOS builder uses
`macos-15-intel`; `macos-13` is retired. Apple Silicon uses `macos-14`, and each
builder still checks its native architecture before staging artifacts.

### 2026-10-19 release preparation

- Public Releases remains empty. Windows/Linux CI artifacts are build outputs,
  not published downloads or proof of desktop UI acceptance.
- A valid local Developer ID signing identity exists. Repository signing secrets
  and a usable local notarization profile have not been configured/confirmed.
  Never publish the old local DMG as if it were a current notarized release.
- The infrastructure guard exposed missing short expressway exit slabs. The
  shared structure compiler now preserves nonzero short segments; its regression
  accounts for ramp resampling instead of assuming one slab per input segment.
- Typecheck and bridge-crossing regression pass. The full infrastructure guard
  proceeds past that regression but still fails the tier-1 seed-corpus highway
  survival assertion. The controlled river fixture passes. This remaining
  planning/fixture mismatch must be resolved before declaring Verify green or
  publishing the release; the assertion has not been disabled.

Package checks verify CLI presence and execution, not full desktop UI acceptance.
Before declaring a platform release ready, test installation, tray/window behavior,
sync, official plugins, and uninstall on a clean machine. macOS-only screenshot
and system-proxy discovery features retain their existing limitations.


## Brand and artifact contracts (2026-10-21)

The app is `Oh Agent.app` with identifier `ai.ohagent.desktop`. Internal desktop
and CLI names remain `agent-vitals-menubar` and `agent-vitals` (Windows: `.exe`).
Download names use `oh-agent-<version>-arm64.dmg` or `oh-agent-<version>-x86_64.dmg`
on macOS, and `oh-agent-<version>-<platform>-x86_64` plus the package extension
(`-setup.exe` for Windows). Existing macOS app zip naming is retained.

`desktop-release-artifacts.mjs` stages exactly one artifact per required format;
missing or duplicate outputs fail before copying. CI checks Linux desktop entry
and installed Windows product identity. Native builds/signing remain platform CI
acceptance work, not established by local static checks.
