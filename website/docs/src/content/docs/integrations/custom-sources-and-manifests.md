---
draft: true
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
- **They show up in the city.** City's source list uses a generic identity, so a manifest source can get its own district. **TBD:** check on a real install.

<!-- source: apps/desktop/ui-dev/react/src/lib/i18n.ts ("sx.locTitle": "Additional read locations" / "其他读取位置"); apps/desktop/src-tauri/src/lib.rs (custom_source_roots, pick_custom_source_root, add_custom_source_root, remove_custom_source_root) -->
<!-- source: crates/agent-vitals-query/src/sources/custom_sources.rs (valid_harness: claude-code | codex | dsh; must be absolute; add requires is_dir(); state/custom-sources.json) -->
<!-- source: crates/agent-vitals-query/src/sources/harness_registry.rs (data_home.join("harnesses.d")); source_controls.rs (format!("harness:{slug}")) -->
<!-- source: crates/agent-vitals-harnesses/src/harnesses/generic/manifest.rs (RECIPE_IDS; records (P2) and adapter (P1.5) explicitly rejected in P0); crates/agent-vitals-ingest/src/ingest/plugin_ingest.rs (billing lock metered / metered_estimate, "manifest 无权改") -->
<!-- source: docs/CITY_LOCAL_DATA_PROJECTION.md ("v2 使用通用 HarnessPublicIdentityV1，不再限制为四个内置来源") -->

## Which folder should I pick as an extra location?

:::caution[TBD: check before publishing]
In code, the folder you add is handed to the same file finder as your home folder, and that finder appends the agent's usual subpath. So for Codex, Oh Agent reads `<folder>/.codex/sessions/` and `<folder>/.codex/archived_sessions/`. For Claude Code it reads `<folder>/.claude/projects/`, and for DSH, `<folder>/sessions/`. The Settings field's placeholder, `/Volumes/…/sessions`, suggests picking the sessions folder itself, which would find nothing for Codex or Claude Code. Confirm the intended behaviour with the maintainers and fix either the code or the hint.
:::

<!-- source: crates/agent-vitals-ingest/src/ingest/sync_service.rs (custom roots: (harness.files_under)(Path::new(&source.root))); session_harnesses.rs (claude-code/codex default_root = user home; files_under joins .claude/projects or .codex/sessions; dsh joins sessions) -->
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
- **Reserved slugs:** `claude-code`, `codex`, `dsh`, `workbuddy`, `openclaw`, `hermes`, so a manifest can't pose as a built-in source.
- **Row limits:** 50,000 records per file by default, 500,000 at most. Over the limit, the whole file is skipped, never cut short.
- **Schema:** `docs/schemas/harness-manifest-v1.json` in the repo.

<!-- source: docs/HARNESS_MANIFEST_DSL_SPEC.md Appendix B.1 (ZCode manifest; trust block omitted here) -->
<!-- source: generic/manifest.rs (RECIPE_IDS, OVERRIDE_SLOTS, RESERVED_SLUGS, DEFAULT_MAX_ROWS_PER_FILE = 50_000, HARD_MAX_ROWS_PER_FILE = 500_000, MANIFEST_VERSION = 1); docs/schemas/harness-manifest-v1.json -->
<!-- source: golden/harness-generic-zcode.json (golden case exists for the generic path) -->

## How do I test and install a manifest?

With the CLI:

```sh
M=~/.agent-vitals/harnesses.d/zcode/manifest.json

# Dry run: discovery, extraction, fact-ID stability, format checks. Writes nothing.
agent-vitals manifest-validate --manifest "$M" --json

# Install = preview first, then confirm with the preview_sha256 that the preview printed.
agent-vitals manifest-install --manifest "$M" --machine-namespace <ns>
agent-vitals manifest-install --manifest "$M" --machine-namespace <ns> --confirm <preview_sha256>

# See what is registered and what has data.
agent-vitals manifest-list
agent-vitals harness-inventory --window-days 30
```

`manifest-uninstall --slug`, `manifest-rollback --slug --revision` and `manifest-recompute` follow the same preview → `--confirm` pattern. The old direct-write `manifest-ingest` is retired: install, then let the normal sync import the data.

**TBD:** where users get the `<ns>` value. There's a `machine-namespace` subcommand, but this flow hasn't been tried end to end for these docs. Also TBD: whether the desktop app will get a local import screen. Today it only has the official-catalog commands (`manifest_catalog_status`, `install_manifest_catalog_harness`).

<!-- source: apps/cli/src/main.rs (ManifestList, HarnessInventory, ManifestCatalogStatus, ManifestInstall "Preview or explicitly activate a local harness manifest… Exact preview_sha256 returned by the preceding dry run", ManifestUninstall, ManifestRollback, ManifestRecompute, ManifestValidate "Path to harnesses.d/<slug>/manifest.json", ManifestIngest "Retired direct-write command"; MachineNamespace subcommand) -->
<!-- source: apps/desktop/src-tauri/src/lib.rs (manifest_catalog_status, save_manifest_catalog_policy, update_manifest_catalog, install_manifest_catalog_harness; no manifest_preview / manifest_import found by rg) -->

## What doesn't a manifest source get?

- **Behaviour findings** (the SV6xx checks) and session traces. Those only run for built-in sources that have been reviewed.
- **Subscription pricing.** There's no official evidence of a subscription, so usage stays a metered estimate.
- **The official catalog**, for now. The app can fetch reviewed manifests from this repo's catalog, but `catalog/index.json` has no entries yet.

<!-- source: docs/HARNESS_MANIFEST_DSL_SPEC.md §0–§1 ("账面可自助，行为须官方"; 行为面不开放); docs/APP_PLUGIN_HARNESS_DATA_CONTRACT.md ("目前 manifest 不获得内置行为审计能力"); catalog/README.md -->

## Related

- [Data pipeline](/docs/architecture/data-pipeline)
- [Add a new data source in code](/docs/contributing/adding-a-data-source)
- [Integrations overview](/docs/integrations)
