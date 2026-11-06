# Codex rollout fixtures

Two synthetic Codex session rollouts, used by the P4 differential tests
(`tests/test_cli_matrix.py`) and the characterization tests
(`tests/test_characterization.py`). Rebuild with:

```bash
python3 fixtures/codex/build_codex_fixture.py
```

The builder is deterministic (fixed timestamps/IDs) and self-verifying: it
re-opens each file and asserts the envelope plus the exact §13 coverage both
modes must produce, so a fixture that stops exercising the mapping table fails
loudly.

## Why these exist

`docs/RUNTIME_EVIDENCE_CONTRACT.md` §17 P4 is the "sound" proof: Codex is the
only harness that emits **two incompatible formats without declaring which**
(`history_mode` ∈ {`legacy`, `paginated`}). If one new harness + two shapes forces
a structural change in the shared type layer (`CanonicalSession`/`Coverage`/
`RuleSpec`), the model is unsound. The two files deliberately carry **different**
coverage so the differential can assert "two rows, not one" (§17.1):

| | `legacy.jsonl` | `paginated.jsonl` |
|---|---|---|
| history_mode | `legacy` | `paginated` |
| cli_version | `0.146.0-alpha.3.1` | `0.149.0-alpha.4` |
| model | `gpt-5.6-sol` | `gpt-5.6-pro` |
| signals | ToolCalls, ToolResults, TurnBoundaries, Usage, UsageAggregate, ContextWindow, QuotaConsumption, ApprovalPolicy, SandboxModes, Compaction, SubagentSpawns, SkillInvocations, FileMutations | ToolCalls, ToolResults, ApprovalDecisions, ApprovalPolicy, SandboxModes, Compaction, SubagentSpawns, SkillInvocations, Hooks, FileMutations, UserPrompts |
| Tool-call duration | absent | present (`CommandExecution.duration`) |
| FileMutations bucket | `lossy` (`patch_apply_end` only) | `measured` (`FileChange`) |
| Hooks / ApprovalDecisions | zero | measured (`HookPrompt` / `FileChange.auto_approved`) |

## Wire format (source of truth: the live corpus, not §14.1)

§14.1's PascalCase Rust enum names are **not** the wire format. This was
confirmed by re-surveying the live corpus (`~/.codex/sessions/`, 51 rollouts,
date-partitioned `2026/07/…` / `2026/08/…`). The real shape:

- **Envelope** `{timestamp, type, payload}`. Top-level `type` ∈
  `{session_meta, turn_context, event_msg, response_item, world_state,
  compacted, inter_agent_communication_metadata}`.
- **Shape probe** = `session_meta.payload.history_mode` ∈ {`legacy`,
  `paginated`} (lowercase). No content probing needed; mixed streams exist, so
  the reader never branches on mode — one flat type→Signal table handles both.
- **Three parallel item namespaces**, all folded into one coverage table:
  - `event_msg.payload.type` (Legacy events): `token_count`, `task_started` /
    `task_complete`, `thread_settings_applied`, `patch_apply_end`,
    `mcp_tool_call_end`, `web_search_end`, `sub_agent_activity`,
    `context_compacted`, `user_message`, `agent_message`, `agent_reasoning`,
    `thread_rolled_back`, `turn_aborted`, `image_generation_end`,
    `thread_goal_updated`, and `item_completed` (the Paginated carrier).
  - `event_msg.type == "item_completed"` → `payload.item.type` ∈
    `{CommandExecution, FileChange, McpToolCall, DynamicToolCall,
    SubAgentActivity, ContextCompaction, CollabAgentToolCall, Plan, Reasoning,
    AgentMessage, UserMessage, Extension, ImageView}` (`HookPrompt` documented
    in §14.1, absent from this corpus but mapped anyway).
  - `response_item.payload.type` ∈ `{reasoning, custom_tool_call,
    custom_tool_call_output, message, function_call, function_call_output,
    agent_message, tool_search_call, tool_search_output}`.
- **Tokens**: `event_msg.type == "token_count"` → `payload.info.{total_token_usage,
  last_token_usage, model_context_window}` + `payload.rate_limits.{plan_type, …}`.
  `model_context_window` → ContextWindow.
- **provenance**: `session_meta.payload.{session_id, id, history_mode,
  cli_version, cwd}` — **`payload.model` is NULL in session_meta**; `model` and
  `workspace_roots` come from `turn_context.payload` (latest non-empty wins,
  the same "current state" convention as DSH's `last_catalog_wins`).

## `usage-fact/` — the Stage-2 UsageFact corpus

`docs/VITALS_CORE_V0_7_STAGE_2_CODEX_ADAPTER.md` §6/§8 adds an emitter that
drives the **same** per-`token_count` state machine as the cost fold
(`CodexFoldState.apply` ↔ `codex_token_facts`): every consumed `token_count`
becomes one immutable `UsageFact` in `by_model`. `usage-fact/` is a second,
self-contained corpus whose `token_count`s are deliberately **fold-consumable**
(object-shaped `total_token_usage` + `last_token_usage`), unlike the top-level
`legacy.jsonl` whose integer `last_token_usage: 60000` is the evidence layer's
simplified shape and reads as `Unreadable` under the fold. The two top-level
files stay as the §13 evidence/coverage probes.

Six files, regenerated and self-checked by the same builder:

| file | history_mode | what it proves (spec §6) |
|---|---|---|
| `usage-fact/legacy.jsonl` | legacy | 2 Consumed facts + all three residuals: token_count before first `turn_context` → Unattributed, same-total repeat → Repeat, reasoning>output → Unreadable (§6.3 acceptance 3) |
| `usage-fact/paginated.jsonl` | paginated | 1 Consumed fact + Repeat/Unreadable; CommandExecution + `custom_tool_call` **dual-shadow** execs → 0 facts (§6.5 acceptance 5) — mode is provenance only, the emitter never branches on `history_mode` |
| `usage-fact/rollout-1a.jsonl` + `rollout-1b.jsonl` | legacy | **cross-stem** pair: byte-identical content, same logical `session_id`, same offsets → each file emits its own fact, never merged (§6.8 acceptance 8) |
| `usage-fact/rollout-live.jsonl` + `usage-fact/archive/rollout-live.jsonl` | paginated | **live/archive** pair under one stem: byte-identical → 1 fact + a `duplicate` attempt (§6.9 acceptance 9, §6.6 acceptance 6) |

`rollout_source_id` = `path.stem`; `source_event_id` = `stem:byte_offset:fnv1a64`
(canonical row). `build_codex_fixture.py::write_usage_fact_fixtures` runs the
real emitter and asserts the exact coverage/attempts dicts, so a fixture whose
shapes stop exercising the fold's discriminations fails at build time — the same
self-verifying posture as the top-level `assert_coverage`.

## Consumers

- `scripts/agent_vitals/adapters/codex_session.py` ↔ `src/codex_session.rs` —
  the JSONL reader (locate → shape → extract).
- `scripts/agent_vitals/agent/codex_evidence.py` ↔
  `crates/agent-vitals-adapters/src/harnesses/codex/sessions/evidence.rs` — the coverage fold
  (derive → coverage).
- `scripts/agent_vitals/agent/codex_usage_fact.py` ↔
  `src/agent/codex_usage_fact.rs` — the Stage-2 UsageFact emitter (§5/§6).
- `tests/test_cli_matrix.py::test_codex_evidence_legacy` /
  `test_codex_evidence_paginated` — the byte-for-byte Python↔Rust differential.
- `tests/test_codex_usage_fact.py` — the §6 acceptance suite over `usage-fact/`
  (+ `fixtures/codex/cost/rollout-sol.jsonl` for the no-`session_meta` stem
  fallback), with a Rust-binary byte-parity class gated on `AGENT_VITALS_BIN`.
