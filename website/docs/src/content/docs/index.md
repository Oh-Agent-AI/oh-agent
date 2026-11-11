---
title: What is Oh Agent? Open-source AI agent behavior analytics, with Agent City
lastUpdated: 2026-10-22
description: Oh Agent is a free, open-source platform for analyzing your AI agents' behavior data, locally on your machine. The Agent Vitals engine reads Claude Code, Codex, DeepSeek Harness and WorkBuddy sessions; Agent City turns them into a 3D city.
head:
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "@id": "https://ohagent.ai/#software",
        "name": "Oh Agent",
        "applicationCategory": "DeveloperApplication",
        "operatingSystem": "macOS 11+ (Apple Silicon), Windows x64, Linux x64",
        "softwareVersion": "1.0.0-beta.3",
        "downloadUrl": "https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3",
        "isAccessibleForFree": true,
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "license": "https://opensource.org/licenses/MIT",
        "url": "https://ohagent.ai/",
        "sameAs": ["https://github.com/Oh-Agent-AI/oh-agent", "https://x.com/ohagentai"],
        "description": "Open-source, local-first platform for analyzing AI agent behavior data. Agent Vitals collects and analyzes Claude Code, Codex and other agent sessions on your machine; Agent City turns them into an explorable 3D city."
      }
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
          {"@type": "ListItem", "position": 1, "name": "Oh Agent", "item": "https://ohagent.ai/"},
          {"@type": "ListItem", "position": 2, "name": "Docs", "item": "https://ohagent.ai/docs"}
        ]
      }
---

Oh Agent is a free, open-source platform for analyzing your AI agents' behavior data. Agents are now part of everyday work and life, and Oh Agent's goal is to make them more valuable to you. It runs as a desktop app, built on the open-source **Agent Vitals** engine, with **Agent City** as its first app:

- **Agent Vitals**, the foundation: a local-first agent behavior data engine, embedded in the app (no server, no daemon). It reads the session history your agents (Claude Code, Codex and others) already keep on your machine, then parses and analyzes it: activity, tokens, cost estimates and behaviour findings.
- **Agent City**, built on Agent Vitals' data interface. It's an open-world data-visualization game where each session is a building in an explorable 3D city.

All analysis happens on your machine; your sessions are not uploaded.

<!-- source: README.md ("What is Oh Agent?", "Your history stays on your machine"); positioning per Bear, 2026-10-21 -->
<!-- source: layer boundary and file paths: /docs/architecture/overview ("What are the two layers, in code?") -->

## Key facts

- **Version:** 1.0.0-beta.3, a pre-release (beta) on [GitHub](https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3).
- **Platforms:** Apple Silicon Mac (signed and notarized), Windows x64 and Linux x64 (not code-signed yet). Intel Mac is coming later. See [Install](/docs/install).
- **Supported agents:** Claude Code, Codex, DeepSeek Harness and WorkBuddy.
- **One building = one session.** Building height follows the session's token count on a log curve.
- **Local-first:** no account and no API key needed; sessions are never uploaded.
- **License:** MIT. Source: [github.com/Oh-Agent-AI/oh-agent](https://github.com/Oh-Agent-AI/oh-agent).
- **Web demo:** [ohagent.ai](https://ohagent.ai/) runs the real City frontend on 2,000 synthetic sessions. It does not read your computer.

<!-- source: apps/desktop/src-tauri/tauri.conf.json ("version": "1.0.0-beta.3", "minimumSystemVersion": "11.0"); GitHub release app-v1.0.0-beta.3 (prerelease, arm64 dmg + Windows/Linux x86_64 assets) -->
<!-- source: crates/agent-vitals-query/src/sources/watch_topology.rs (default_source_watch_roots: claude-code, codex, workbuddy, dsh) -->
<!-- source: website/landing/README.md ("Public release": Releases page empty; demo = 2000 mock sessions / 30 days) -->
<!-- source: LICENSE (MIT) -->

## What does Oh Agent show?

- **Agent City.** Each session becomes a data building, each agent gets its own district, and token volume shapes the skyline. Select a building to inspect its session. See [What each building means](/docs/city-guide).
- **Activity replay.** Replay how the city grew within the selected time window (7, 30, 90 or 366 days on desktop).
- **Usage view.** A separate desktop view covers usage and cost by source and time. In the city, each building's details show an estimated cost, and public buildings such as City Hall open data panels.

<!-- source: README.md ("What is Oh Agent?"); apps/agent-city/ui/src/CityApp.tsx (windowOptions = [7, 30, 90, 366]); dev bf7196a: apps/agent-city/ui/src/CityExperience.tsx (costLabel), cityDataPlaces.ts. -->

The city is a picture of recorded activity, not a productivity score. A taller building means more tokens, not better work.

## Where does the data come from?

Oh Agent reads the session logs your agents already write to your home folder, for example `~/.claude/projects` for Claude Code and `~/.codex/sessions` for Codex. Details per agent:

- [Claude Code: where sessions are stored and how Oh Agent reads them](/docs/data-sources/claude-code)
- [Codex: where sessions are stored and how Oh Agent reads them](/docs/data-sources/codex)
- DeepSeek Harness (`~/.dsh`, or `$DSH_HOME` if set) and WorkBuddy (`~/.workbuddy`) are read the same way. See [what Oh Agent reads](/docs/privacy-and-data#what-files-does-oh-agent-read).

## How is it built, and can I extend it?

It's open source (MIT). The code lives in the [Oh-Agent-AI/oh-agent repository](https://github.com/Oh-Agent-AI/oh-agent): the Agent Vitals engine is a set of Rust crates under `crates/`, the desktop app is in `apps/desktop/`, and Agent City is in `apps/agent-city/`. Pages on the engine, the CLI, the Data MCP server and the architecture are being added to these docs over the coming days.

## Is my data private?

Yes. Sessions are analyzed on your machine and never uploaded. The app only goes online for a few public, data-free requests such as price tables and update checks. Full details: [Does Oh Agent upload my sessions?](/docs/privacy-and-data) and the [privacy policy](https://ohagent.ai/#privacy).

## How do I install it?

Download 1.0.0-beta.3 for Apple Silicon Mac, Windows or Linux. See [Install](/docs/install) for the files, install steps per platform and checksum verification.

## More

- [Agent City overview](https://ohagent.ai/#city) · [Download](https://ohagent.ai/#download) · [FAQ](https://ohagent.ai/#faq)
- Brand note: the public name is **Oh Agent**. The desktop app is `Oh Agent.app`; the CLI and data folders still use the internal name `agent-vitals`, and you don't need to rename anything.

<!-- source: README.md ("Oh Agent is the public brand. Repository names, CLI commands ... still use agent-vitals") -->
