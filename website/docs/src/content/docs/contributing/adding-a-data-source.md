---
draft: true
title: How do I add a new agent as a data source to Oh Agent?
description: A contributor guide to adding a new agent to Agent Vitals, the data layer of Oh Agent, either with a no-code manifest or as a built-in Rust source with parser, registry entry, Python parity and golden tests.
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
          {"@type": "ListItem", "position": 3, "name": "Add a data source", "item": "https://ohagent.ai/docs/contributing/adding-a-data-source"}
        ]
      }
---

There are two ways to add a new agent to Agent Vitals. The **manifest route** needs no code: describe the agent's JSONL logs in a JSON file, and its token usage is imported with cost marked as an estimate. The **built-in route** is a Rust change: write a parser under `crates/agent-vitals-harnesses`, add one row to the source registry, keep a few lists in sync, and add Python parity and golden tests. Only built-in sources get behaviour checks and session traces. Every source, either way, feeds Agent City automatically.

## Which route should I take?

| | Manifest | Built-in |
| --- | --- | --- |
| Code | None (JSON) | Rust + Python twin |
| Log formats | JSONL with one usage record per line, covered by one of 3 recipes | Anything (SQLite, zstd, multi-file joins…) |
| Usage, tokens, cost estimate | Yes (always `metered_estimate`) | Yes, with subscription evidence if provable |
| Behaviour findings, traces, titles | No | Yes, if you implement them |
| Review | Local only (official catalog later) | PR review |

Start with a manifest if you can: [Extra folders and manifest sources](/docs/integrations/custom-sources-and-manifests).

<!-- source: docs/HARNESS_MANIFEST_DSL_SPEC.md §0–§1 ("账面可自助，行为须官方"); crates/agent-vitals-harnesses/src/harnesses/generic/manifest.rs (RECIPE_IDS) -->

## Built-in route: step by step

The registry's own doc comment sums it up: adding a source means "add one row here and write the implementation in `harnesses/<h>/sources/`; the runtime doesn't change." In practice, a few closed lists also need updating.

### 1. Write the parser

Create `crates/agent-vitals-harnesses/src/harnesses/<name>/`, using the existing sources as models:

- `sessions/`: pure session evidence. No I/O, so it can also build for wasm.
- `sources/`: locate, read and parse files, behind the crate's `sources` feature. Typical files are `usage_fact.rs` (log lines → usage facts), `findings.rs` and a discovery module.
- Register the module in `src/harnesses/mod.rs`.

Keep harness-specific I/O here and pure policy in `agent-vitals-domain`.

<!-- source: crates/agent-vitals-harnesses/src/harnesses/mod.rs; harnesses/dsh/mod.rs ("sessions/ = 会话证据（纯，wasm 可链）。sources/ = 定位 / 读取 …#[cfg(feature = "sources")]"); harnesses/codex/sources/ (usage_fact.rs, findings.rs, …); AGENTS.md (Coding Style: "Keep harness-specific I/O in adapters/harness crates and deterministic policy logic in core/domain modules") -->

### 2. Add a row to the source registry

In `crates/agent-vitals-harnesses/src/sources/session_harnesses.rs`, append a `SessionHarness` to `SESSION_HARNESSES`:

| Field | What to provide |
| --- | --- |
| `id` | The harness id, for example `"my-agent"`. It must match the `harness` stamp on your usage facts |
| `default_root` | Where the agent lives on this machine, from `HarnessRoots`. Return `None` if it can't be located; that isn't an error |
| `files_under` | List session files under a root, returning files plus traversal errors |
| `accepts_custom_roots` | Whether users may add extra folders for this source |
| `findings` | `Some(evaluate)` for behaviour findings, or `None` |
| `session_sources` | Find a session's source files by native id (used for local drill-down only) |
| `title_index` | Optional side index for session titles, read-only and lenient |

Order matters: the registry order is the sync order and the order in sync reports. Append at the end. Also add your folder to `usage_source_roots` (the concrete usage folders a manifest may not claim a second time) and update the registry tests in the same file.

<!-- source: crates/agent-vitals-harnesses/src/sources/session_harnesses.rs (struct SessionHarness fields and docs; "顺序即契约"; usage_source_roots; tests registry_order_and_membership_are_the_fact_harness_vocabulary, default_roots_follow_the_existing_conventions) -->

### 3. Update the closed lists

These lists name every built-in source and are kept in sync by hand:

| List | File |
| --- | --- |
| `FACT_HARNESSES` | `crates/agent-vitals-runtime-core/src/core/fact_harnesses.rs` |
| `TRACE_HARNESSES` | `crates/agent-vitals-query/src/query/trace_service.rs` |
| `WIRED_HARNESSES` | `crates/agent-vitals-query/src/query/summary/mod.rs` |
| `HARNESSES` (reimport) | follows `FACT_HARNESSES` in `crates/agent-vitals-ingest/src/ingest/reimport_verify.rs` |
| `RESERVED_SLUGS` | `crates/agent-vitals-harnesses/src/harnesses/generic/manifest.rs`, so no manifest can claim your id |
| Extra-folder allowlist | `valid_harness` in `crates/agent-vitals-query/src/sources/custom_sources.rs` (only if `accepts_custom_roots`) |
| Display name | `harness_profile` in `agent-vitals-domain` (`harness_capability`), used by the desktop `harness_display_name` |
| File watching | `crates/agent-vitals-query/src/sources/watch_topology.rs` |

<!-- source: fact_harnesses.rs ("trace_service::TRACE_HARNESSES / reimport_verify::HARNESSES / summary::WIRED_HARNESSES 与本表同步维护——加执行环境四处一起改"); trace_service.rs:40; summary/mod.rs:33; reimport_verify.rs:23; manifest.rs RESERVED_SLUGS; custom_sources.rs valid_harness; apps/desktop/src-tauri/src/lib.rs harness_display_name → agent_vitals_domain::harness_capability::harness_profile; watch_topology.rs (per-harness watch roots) -->

**TBD:** the full list of places to touch. `docs/HARNESS_MANIFEST_DSL_SPEC.md` Appendix C lists 16 coupling points (CLI `--harness` enums, Python CLI choices, UI name maps, golden cases, downstream pricing/summary/export/MCP), but its file paths are older than the crate split. Re-audit with `rg` for an existing id such as `"workbuddy"` before opening a PR.

### 4. Add the Python twin and golden tests

Agent Vitals keeps a Python compatibility implementation in `packages/agent-vitals-python/agent_vitals/` (adapters such as `codex_session.py`, `dsh.py`, `workbuddy.py`). Output must match byte for byte:

- Add the Python adapter and a golden case under `golden/` (for example `golden/harness-workbuddy.json`), with fixtures in `fixtures/`.
- Add malformed-input tests: a missing root means "absent", never "zero sessions"; a bad line degrades only that line.
- Register any new problem class in `docs/AGENT_EXECUTION_PROBLEM_TAXONOMY.md` before writing emitters.

<!-- source: AGENTS.md (Project Structure; Testing Guidelines: "regression fixtures, malformed-input degradation tests, harness contract tests, and Python/Rust lockstep checks are the acceptance criteria"; policy item 5: taxonomy before emitters); packages/agent-vitals-python/agent_vitals/adapters/; golden/harness-workbuddy.json -->

### 5. Respect the data rules

- **Billing:** without explicit evidence of an official subscription route, usage is `metered_estimate` with `has_unresolved = true`. Never drop it or set it to zero.
- **Privacy:** store derived fields and short excerpts, not full transcripts. Never persist credentials.
- **Formatting:** don't run `rustfmt` on files. Check `git diff` after every edit.

<!-- source: AGENTS.md (Billing fallback rule; Data Retention & Serving-Face Policy; Coding Style: "Do not run rustfmt") -->

### 6. Run the checks

```sh
cargo test --release
cargo clippy --release --all-targets -- -D warnings
python3 -m unittest discover tests -v
python3 tests/golden_runner.py --diff
AGENT_VITALS_BIN="$PWD/target/release/agent-vitals" python3 tests/golden_runner.py --diff
```

Never refresh golden files just to make a failure go away. Your PR should explain contract changes and list the commands you ran.

<!-- source: AGENTS.md (Build, Test, and Development Commands; Commit & Pull Request Guidelines) -->

## Will my new source show up in Agent City?

Yes. City reads sources through a generic identity, not a fixed list, so a new source gets its own district. It uses a fallback colour unless a palette entry is added. **TBD:** where the per-source City palette lives (the fixture code mentions a fallback palette for unknown ids).

<!-- source: docs/CITY_LOCAL_DATA_PROJECTION.md ("v2 使用通用 HarnessPublicIdentityV1，不再限制为四个内置来源"); apps/agent-city/ui/src/data/provider.ts ("与真实投影同名（连字符），否则落到兜底调色板") -->

## Related

- [Data pipeline](/docs/architecture/data-pipeline)
- [Extra folders and manifest sources](/docs/integrations/custom-sources-and-manifests)
- [Architecture overview](/docs/architecture/overview)
- [Source on GitHub](https://github.com/Oh-Agent-AI/oh-agent)
