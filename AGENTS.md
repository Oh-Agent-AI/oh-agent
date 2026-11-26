# Repository guidelines

Oh Agent is **Agent Roblox**. Agents create Cities and games with Creator Studio and the SDKs. People play and share those creations. Session history and token usage can enrich a City and power local analytics.

## Read what you need

| Working on | Start here |
| --- | --- |
| Product scope or release claims | [README](README.md#development-status) |
| Builds, tests, packaging or repository layout | [Development guide](docs/DEVELOPMENT.md) |
| Studio, creator tools, City Engine or game packages | [Architecture and code entry points](docs/DEVELOPMENT.md#architecture-and-code-entry-points) |
| Data access, ingestion, billing, export or remote features | [Data handling policy](docs/DATA_HANDLING_POLICY.md). Read the relevant rules before editing. |
| Browser play, control or invites | [Remote gameplay](docs/DEVELOPMENT.md#remote-gameplay) and [policy items 7–8](docs/DATA_HANDLING_POLICY.md#remote-exceptions) |

## Code ownership

- **Studio** coordinates authoring, human review, preview, release and installation through typed APIs. Keep editable Projects, immutable Candidates and Releases, Installations and Runs distinct. Reuse the creator job ledger for agent tasks.
- **TypeScript** owns City and game runtime behavior, rendering, input and the frame loop. Trusted TS adapters own app specific projections of approved DTOs. Keep game rules and content with their packages and expose shared engine capabilities through SDK contracts. New games use the same interfaces.
- **Rust Host** owns local data access, authorization, package verification, durable lifecycle transactions, CAS and idempotency. It decides the trust level of persisted evidence. A replay of client supplied events establishes agreement with those inputs. Keep gameplay, rendering and City specific projections outside Rust.
- **Web City** uses the same TS gameplay stack. Browser play and control of an existing desktop session use their own declared capabilities. Host and relay enforce session scope, message bounds, expiry and revocation.

## Data Retention & Serving-Face Policy (2026-09-19)

The [full policy](docs/DATA_HANDLING_POLICY.md) is mandatory. Local data stays on the device except for the policy's explicit remote City and mecha exceptions. Sharing a creation grants access only to the content and capabilities explicitly authorized for that action. Keep typed grants bounded and apply the existing MCP and export redaction rules. Raw log viewing stays local and host controlled. Keep secrets, canaries and unrestricted IPC out of app and remote surfaces.

## Data Integrity Watchlist

Follow the [provider and billing rules](docs/DATA_HANDLING_POLICY.md#data-integrity-watchlist). Subscription classification requires explicit route and scope evidence. Report uncertain routes as unresolved metered estimates and keep the authority provider query harness agnostic.

## Change rules

- Preserve surrounding Rust formatting. Do not run `rustfmt` or a file formatter that rewrites Rust. Review the full diff and diff stat immediately after Rust edits. The repository-wide formatter check is read-only.
- Keep harness I/O in adapters and deterministic policy in domain/core modules. Preserve Python 3.9 support and JSON field order where covered by golden contracts.
- Use [relevant checks](docs/DEVELOPMENT.md#checks) for the packages you touch. Refresh golden outputs only for reviewed contract changes.
- Check the macOS tray by opening the built `Oh Agent.app`. Never launch the bare `agent-vitals-menubar` executable for tray checks. See [macOS build and tray notes](docs/DEVELOPMENT.md#macos-build-and-tray).
- Use scoped Conventional Commit subjects. In PRs, link the relevant issue or spec and record contract changes, commands run and screenshots for UI changes. Call out schema changes, golden updates, degraded behavior and unavailable evidence.
