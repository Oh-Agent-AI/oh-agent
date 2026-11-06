---
title: How do I install Oh Agent? Downloads for macOS, Windows and Linux
description: Download Oh Agent 1.0.0-beta.3 (pre-release) for Apple Silicon Mac, Windows x64 or Linux x64. Install steps per platform, checksum verification, signing status and first run.
lastUpdated: 2026-10-22
head:
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
          {"@type": "ListItem", "position": 1, "name": "Oh Agent", "item": "https://ohagent.ai/"},
          {"@type": "ListItem", "position": 2, "name": "Docs", "item": "https://ohagent.ai/docs"},
          {"@type": "ListItem", "position": 3, "name": "Install", "item": "https://ohagent.ai/docs/install"}
        ]
      }
---

Oh Agent **1.0.0-beta.3** is the current release. It is a **pre-release (beta)** published on [GitHub](https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3) with installers for **Apple Silicon Mac, Windows x64 and Linux x64**. An Intel Mac build is coming later.

:::note[Beta]
1.0.0-beta.3 is a beta. The Apple Silicon build is Developer ID signed and Apple notarized. The Windows and Linux builds are **not code-signed yet**, so your system may show a warning. The release notes list the known issues.
:::

<!-- source: GitHub release app-v1.0.0-beta.3 (prerelease: true, published 2026-10-22, assets + release notes); apps/desktop/src-tauri/tauri.conf.json (version 1.0.0-beta.3, productName Oh Agent, identifier ai.ohagent.desktop, minimumSystemVersion 11.0) -->

## Key facts

- **Version:** 1.0.0-beta.3, marked *Pre-release* on GitHub.
- **Price:** free and open source (MIT).
- **macOS:** Apple Silicon (arm64), macOS 11.0 or later. Signed and notarized.
- **Windows:** x64 setup installer. Not code-signed yet.
- **Linux:** x64 `.deb` (Debian / Ubuntu) and `.AppImage`. Not signed yet.
- **Intel Mac:** not in this release; coming later.
- **Checksums:** a `SHA256SUMS` file is published next to the installers.

## Which file do I download?

| Platform | File |
| --- | --- |
| macOS, Apple Silicon | [`oh-agent-1.0.0-beta.3-arm64.dmg`](https://github.com/Oh-Agent-AI/oh-agent/releases/download/app-v1.0.0-beta.3/oh-agent-1.0.0-beta.3-arm64.dmg) |
| Windows x64 | [`oh-agent-1.0.0-beta.3-windows-x86_64-setup.exe`](https://github.com/Oh-Agent-AI/oh-agent/releases/download/app-v1.0.0-beta.3/oh-agent-1.0.0-beta.3-windows-x86_64-setup.exe) |
| Linux x64 (Debian / Ubuntu) | [`oh-agent-1.0.0-beta.3-linux-x86_64.deb`](https://github.com/Oh-Agent-AI/oh-agent/releases/download/app-v1.0.0-beta.3/oh-agent-1.0.0-beta.3-linux-x86_64.deb) |
| Linux x64 (portable) | [`oh-agent-1.0.0-beta.3-linux-x86_64.AppImage`](https://github.com/Oh-Agent-AI/oh-agent/releases/download/app-v1.0.0-beta.3/oh-agent-1.0.0-beta.3-linux-x86_64.AppImage) |
| All | [`SHA256SUMS`](https://github.com/Oh-Agent-AI/oh-agent/releases/download/app-v1.0.0-beta.3/SHA256SUMS) |

All files are also listed on the [1.0.0-beta.3 release page](https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3). Because this is a pre-release, GitHub's "latest release" shortcut does not point to it; use the links above.

## How do I install it on macOS?

1. Download `oh-agent-1.0.0-beta.3-arm64.dmg`.
2. Open the DMG and drag **Oh Agent** to **Applications**.
3. Open Oh Agent from Applications.

The installed app is `Oh Agent.app` (bundle identifier `ai.ohagent.desktop`). It needs macOS 11.0 or later on an Apple Silicon Mac. This build is Developer ID signed, notarized and stapled, so it opens without a Gatekeeper override.

## How do I install it on Windows?

1. Download `oh-agent-1.0.0-beta.3-windows-x86_64-setup.exe`.
2. Run the installer.

The installer is not Authenticode-signed yet, so Windows may show an "unknown publisher" or SmartScreen warning. Check the file against `SHA256SUMS` (below) before you choose to run it anyway.

## How do I install it on Linux?

On Debian or Ubuntu, install the `.deb`:

```sh
sudo apt install ./oh-agent-1.0.0-beta.3-linux-x86_64.deb
```

Or run the portable AppImage:

```sh
chmod +x oh-agent-1.0.0-beta.3-linux-x86_64.AppImage
./oh-agent-1.0.0-beta.3-linux-x86_64.AppImage
```

Whether the AppImage runs depends on your distribution's runtime and FUSE support. Neither package is signed yet.

## How do I verify the download?

Download `SHA256SUMS` into the same folder as the installer, then compare:

```sh
# macOS: compare the output with the matching line in SHA256SUMS
shasum -a 256 oh-agent-1.0.0-beta.3-arm64.dmg

# Linux: checks every file in SHA256SUMS that you downloaded
sha256sum -c SHA256SUMS --ignore-missing
```

```powershell
# Windows (PowerShell): compare the output with the line in SHA256SUMS
Get-FileHash .\oh-agent-1.0.0-beta.3-windows-x86_64-setup.exe -Algorithm SHA256
```

## What is tested in this beta?

From the release notes:

- **macOS Apple Silicon:** signed, notarized and stapled.
- **Windows:** silent installation, installed product identity and the bundled command-line tool were checked in CI. Interactive use has not been manually accepted yet.
- **Linux:** `.deb` extraction, the desktop entry and the bundled command-line tool were checked in CI; the AppImage was generated. Interactive use has not been manually accepted yet.
- **Known issues:** two Agent City checks did not pass at publication (a road-terrain regression check and a ground-surface geometry baseline), so road passability in City is not fully certified. Full CI and long-duration driving acceptance were not complete.

## What happens after I open it?

Oh Agent reads the session logs your agents already keep in your home folder. You need no account and no API key, and nothing is uploaded. Your OS may ask you to allow access to those folders. Then:

- [Claude Code data source](/docs/data-sources/claude-code) · [Codex data source](/docs/data-sources/codex)
- [What each building in Agent City means](/docs/city-guide)
- [Does Oh Agent upload my sessions?](/docs/privacy-and-data)

## Can I try Oh Agent without installing?

Yes, partly. The [web demo on ohagent.ai](https://ohagent.ai/) runs the real City frontend on 2,000 synthetic sessions (30-day window). It doesn't read your logs, and it hides the game, export and seed controls.

<!-- source: website/landing/README.md (2000 mock sessions in 30 days; presentation=landing hides game, export and seed controls) -->

## Why do I still see agent-vitals after installing?

The app's display name is Oh Agent. The bundled command-line tool and the data folder `~/.agent-vitals/` still use the earlier internal name `agent-vitals`, for compatibility. Don't rename them.

If you ran an early macOS build named `agent-vitals.app` (identifier `com.mixlabpro.agent-vitals`), quit and delete it; otherwise macOS shows two menu bar icons.

<!-- source: apps/desktop/src-tauri/README.md ("CLI 与数据目录继续使用 agent-vitals"); README.md -->

## How can developers build it from source?

You need Node.js with npm, stable Rust, Tauri's platform prerequisites and the Tauri CLI. From the repository root, on macOS:

```sh
# Command-line tool
cargo build --release
./target/release/agent-vitals --help

# Local macOS .app build
npm ci --prefix apps/desktop/ui-dev
npm ci --prefix apps/agent-city/ui
bash scripts/build-macos-react-app.sh
```

A local build is an ad-hoc signed test build for development, not a release package. See the [desktop README](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/apps/desktop/src-tauri/README.md) for details.

<!-- source: README.md ("Development quick start") -->

## How do I get notified about new releases?

- Watch the [GitHub repository](https://github.com/Oh-Agent-AI/oh-agent) (Watch → Custom → Releases).
- Follow [@ohagentai](https://x.com/ohagentai) on X.
