# Worktree reconciliation · 2026-09-25

This note records code integration, not a Beta release approval. Installed-app
usability testing, clean-machine installation, signing and notarization remain
separate release gates in `BETA_1_EXECUTION_PLAN.md`.

| Worktree | Status on `main` | Boundary |
|---|---|---|
| `feat/refresh-storm-fix` | Already an ancestor of `main` | No further merge needed. |
| `feat/watcher-hardening` | Already an ancestor of `main` | No further merge needed. |
| `codex/ac28-uncertain-later` | Reconciled into current code and tests | “Still uncertain” keeps the candidate pending; both declaration write APIs reject `unknown`. |
| `codex/ac14-recalc-recovery` | Reconciled into current code and tests | Queued/failed recalculations retain the last successfully published result; a later explicit revoke still removes coverage. Recovery and retry UI already exist in the current workbench. |
| `overview-backend-wiring-2` | Merged as superseded history (`-s ours`) | Its committed overview implementation predates the current React/Authority integration. All 17 changed paths have later versions on `main`; the legacy and React overview contract suites pass. Its five uncommitted session-span edits were compared separately: the `span` output and Python/Rust key-order expectations already exist on `main`. The dirty worktree was not modified. |
| detached `bf14` worktree | Commit already an ancestor of `main`; no merge needed | Its uncommitted schema-v4 catalog/template migration is present in the current schema-v27 evolution. The four untracked files exist on `main`; the two that differ have newer additions or updated v1 checks. The dirty worktree was not modified. |

The current UI follow-up also fixes the usage harness summary to use the dynamic
Authority source summary, makes Settings navigation/reload reflect the selected
section and full page, and stops a Skill harness-selection change from implicitly
starting a scan. The release checklist remains open until the installed `.app`
passes a separate end-to-end usability run.

Reconciliation verification on 2026-09-25: `npm run verify` and
`npm run verify:react` both passed in `apps/desktop/ui-dev`. The Vite build emitted
non-failing bundle/import warnings; this reconciliation did not alter runtime code.
