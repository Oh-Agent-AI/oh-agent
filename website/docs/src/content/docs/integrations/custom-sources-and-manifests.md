---
lastUpdated: 2026-11-14
title: How do I add other log folders or an unsupported agent to Oh Agent?
description: Add extra Claude Code, Codex or DSH log folders in Settings, or describe another agent's JSONL logs in a manifest, a JSON file Oh Agent imports without running any code.
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
          {"@type": "ListItem", "position": 3, "name": "Integrations", "item": "https://ohagent.ai/docs/integrations"},
          {"@type": "ListItem", "position": 4, "name": "Extra folders and manifest sources", "item": "https://ohagent.ai/docs/integrations/custom-sources-and-manifests"}
        ]
      }
---

Agent Vitals has two ways to read data beyond the default folders. **Extra folders** add more read locations for a built-in source (Claude Code, Codex or DeepSeek Harness), using the same parser. **Manifest sources** let you describe a different agent's JSONL logs in a JSON file, so its token usage is imported with no code and no restart. Manifest sources get usage and cost estimates, but no behaviour checks.

## Key facts

- **Extra folders:** desktop Settings → "Additional read locations". Supported for Claude Code, Codex and DSH, not WorkBuddy. The folder must be an absolute path to an existing directory.
- **Stored in** `~/.agent-vitals/state/custom-sources.json`, on this Mac only.
- **Manifest sources** live in `~/.agent-vitals/harnesses.d/<slug>/manifest.json`, and their data gets the source id `harness:<slug>`.
- **No code runs.** A manifest picks one of three built-in extraction recipes and maps fields with dot paths. Script adapters and expression rules are rejected.
- **Costs are always estimates** for manifest sources (`metered_estimate`, with `has_unresolved`), and a manifest can't change that.
- **They show up in the city.** City v2 uses a generic source identity (`HarnessPublicIdentityV1`), so it is not limited to the four built-in sources. A manifest source can get its own district once it has data.

<!-- source: apps/desktop/ui-dev/react/src/lib/i18n.ts ("sx.locTitle": "Additional read locations" / "其他读取位置"); apps/desktop/src-tauri/src/lib.rs (custom_source_roots, pick_custom_source_root, add_custom_source_root, remove_custom_source_root) -->
<!-- source: crates/agent-vitals-query/src/sources/custom_sources.rs (valid_harness: claude-code | codex | dsh; must be absolute; add requires is_dir(); state/custom-sources.json) -->
<!-- source: crates/agent-vitals-query/src/sources/harness_registry.rs (data_home.join("harnesses.d")); source_controls.rs (format!("harness:{slug}")) -->
<!-- source: crates/agent-vitals-harnesses/src/harnesses/generic/manifest.rs (RECIPE_IDS; records (P2) and adapter (P1.5) explicitly rejected in P0); crates/agent-vitals-ingest/src/ingest/plugin_ingest.rs (billing lock metered / metered_estimate, "manifest 无权改") -->
<!-- source: docs/CITY_LOCAL_DATA_PROJECTION.md ("v2 使用通用 HarnessPublicIdentityV1，不再限制为四个内置来源"); packages/agent-vitals-app-sdk/src/city-ui-projection.ts. Verified against origin/dev 36e4b55a on 2026-11-14. -->

## Which folder should I pick as an extra location?

:::caution[Pick the parent folder, not the sessions folder]
The folder you add is passed to the same file finder used for your home directory, and that finder appends the agent's usual subpath. For Codex, Oh Agent reads `<folder>/.codex/sessions/` and `<folder>/.codex/archived_sessions/`. For Claude Code it reads `<folder>/.claude/projects/`. For DSH it reads `<folder>/sessions/`. Pick a home-like parent: the directory that contains `.codex`, `.claude`, or (for DSH) the `sessions` folder itself. The Settings field's placeholder, `/Volumes/…/sessions`, looks like you should pick the sessions folder; that path would find nothing for Codex or Claude Code, and for DSH it would look for `sessions/sessions`.
:::

<!-- source: crates/agent-vitals-ingest/src/ingest/sync_service.rs (custom roots: (harness.files_under)(Path::new(&source.root))); claude_project_files_with_errors joins .claude/projects; codex_rollout_files_with_errors joins .codex/sessions and .codex/archived_sessions; dsh_session_files_with_errors joins sessions. Verified origin/dev 36e4b55a. -->
<!-- source: apps/desktop/ui-dev/react/src/features/settings/SettingsPage.tsx (placeholder="/Volumes/…/sessions") -->

This is also why a custom `CLAUDE_CONFIG_DIR` or `CODEX_HOME` usually isn't covered: those folders are rarely named `.claude` or `.codex` inside a parent you can pick.

## What does a manifest look like?

This example comes from the design spec, for an agent called ZCode. It's an illustration, not an officially supported source:

```json
{
  "manifest_version": 1,
  "slug": "zcode",
  "display": { "name": "ZCode" },
  "discovery": {
    "roots": ["~/.zcode/cli/rollout"],
    "include": ["model-io-sess_*.jsonl"]
  },
  "source": { "format": "jsonl" },
  "session": {
    "from": "filename",
    "pattern": "^model-io-sess_(?P<id>.+)\\.jsonl$"
  },
  "recipe": "request-usage-anthropic-v1",
  "overrides": {
    "event_ts": "completedAt",
    "model_raw": "model.modelId",
    "uncached_input_tokens": "usage.input_tokens",
    "output_tokens": "usage.output_tokens",
    "cache_read_tokens": "usage.cache_read_input_tokens",
    "cache_write_tokens": "usage.cache_write_input_tokens",
    "provider_request_id": "requestId"
  },
  "event_key": { "paths": ["requestId", "attempt"] },
  "billing": { "policy": "lock:metered_estimate" }
}
```

- **Recipes** (choose one): `request-usage-anthropic-v1`, `request-usage-openai-total-input-v1`, `request-usage-four-bucket-v1`.
- **Fields you can remap:** `event_ts`, `model_raw`, `provider_raw`, `uncached_input_tokens`, `total_input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `output_tokens`, `provider_request_id`.
- **Reserved slugs:** `claude-code`, `codex`, `dsh`, `workbuddy`, `openclaw`, `hermes`, plus any slug starting with `harness-` or `plugin-`, so a manifest can't pose as a built-in source.
- **Row limits:** 50,000 records per file by default, 500,000 at most. Over the limit, the whole file is skipped, never cut short.
- **Schema:** `docs/schemas/harness-manifest-v1.json` in the repo.

<!-- source: docs/HARNESS_MANIFEST_DSL_SPEC.md Appendix B.1 (ZCode manifest; trust block omitted here) -->
<!-- source: generic/manifest.rs (RECIPE_IDS, OVERRIDE_SLOTS, RESERVED_SLUGS, slug.starts_with("harness-"|"plugin-"), DEFAULT_MAX_ROWS_PER_FILE = 50_000, HARD_MAX_ROWS_PER_FILE = 500_000, MANIFEST_VERSION = 1); docs/schemas/harness-manifest-v1.json -->
<!-- source: golden/harness-generic-zcode.json (golden case exists for the generic path) -->

## How do I test and install a manifest?

With the CLI:

```sh
M=~/.agent-vitals/harnesses.d/zcode/manifest.json
NS=$(agent-vitals state machine-namespace)

# Dry run: discovery, extraction, fact-ID stability, format checks. Writes nothing.
agent-vitals manifest-validate --manifest "$M" --json

# Install = preview first, then confirm with the preview_sha256 that the preview printed.
agent-vitals manifest-install --manifest "$M" --machine-namespace "$NS"
agent-vitals manifest-install --manifest "$M" --machine-namespace "$NS" --confirm <preview_sha256>

# See what is registered and what has data.
agent-vitals manifest-list
agent-vitals harness-inventory --window-days 30
```

`agent-vitals state machine-namespace` prints the machine namespace stored in `machine.json` (the third component of a SessionKey). If that file is missing, the command creates a namespace and prints it.

`manifest-uninstall --slug`, `manifest-rollback --slug --revision` and `manifest-recompute` follow the same preview → `--confirm` pattern. The old direct-write `manifest-ingest` is retired: install, then let the normal sync import the data.

The desktop app does not have a local manifest import screen. Today it only has the official-catalog commands (`manifest_catalog_status`, `install_manifest_catalog_harness`). Use the CLI to validate and install a local manifest.

<!-- source: apps/cli/src/main.rs (StateAction::MachineNamespace "Print (creating if needed) the machine namespace — SessionKey's third component, persisted in machine.json"; ManifestList, HarnessInventory, ManifestCatalogStatus, ManifestInstall "Preview or explicitly activate a local harness manifest… Exact preview_sha256 returned by the preceding dry run", ManifestUninstall, ManifestRollback, ManifestRecompute, ManifestValidate "Path to harnesses.d/<slug>/manifest.json", ManifestIngest "Retired direct-write command") -->
<!-- source: crates/agent-vitals-runtime-core/src/core/takeover.rs (machine_namespace reads/creates machine.json) -->
<!-- source: apps/desktop/src-tauri/src/lib.rs (manifest_catalog_status, save_manifest_catalog_policy, update_manifest_catalog, install_manifest_catalog_harness; no manifest_preview / manifest_import found by rg). Verified origin/dev 36e4b55a. -->

## What doesn't a manifest source get?

- **Behaviour findings** (the SV6xx checks) and session traces. Those only run for built-in sources that have been reviewed.
- **Subscription pricing.** There's no official evidence of a subscription, so usage stays a metered estimate.
- **The official catalog**, for now. The app can fetch reviewed manifests from this repo's catalog, but `catalog/index.json` has no entries yet.

<!-- source: docs/HARNESS_MANIFEST_DSL_SPEC.md §0–§1 ("账面可自助，行为须官方"; 行为面不开放); docs/APP_PLUGIN_HARNESS_DATA_CONTRACT.md ("目前 manifest 不获得内置行为审计能力"); catalog/index.json (entries: [] at origin/dev 36e4b55a); catalog/README.md -->

## Related

- [Data pipeline](/docs/architecture/data-pipeline)
- [Integrations overview](/docs/integrations)
