# Claude Code fixtures

One synthetic Claude Code session, used by the `claude-session` acceptance gate
(`tests/test_cli_matrix.py` — differential py==rs via `AGENT_VITALS_BIN`) and
the §10 acceptance checks in `docs/CLAUDE_CODE_INTEGRATION.md`. Rebuild with:

```bash
python3 fixtures/claude/build_claude_fixture.py
```

The builder is deterministic (fixed timestamps/UUIDs) and self-verifying: it
re-opens `healthy.jsonl` and runs the real evidence + audit projection, asserting
the exact §10 三态契约 (SV607/608/609/610/614 Unavailable, `rules_unavailable=5`,
`findings_total=0`, `ToolCalls=2` / `ToolResults=2` / `TurnBoundaries=1`), so a
fixture that stops exercising the mapping table fails loudly instead of silently
changing the gate.

## Why this exists

Claude Code persists each session as one append-only JSONL under
`~/.claude/projects/<workspace-slug>/<session-id>.jsonl`. Unlike DSH/Codex there
is no index file: `session_id` is the filename stem and the **session itself is
the leaf**. The record shapes that the adapter depends on are:

- `user` events whose `message.content` is a **string** → a pure-text human
  prompt → **turn root** (§8: content-based, NOT `parentUuid` — the real corpus
  has 886 pure-text users with non-null parentUuid vs 8 with null).
- `assistant` events whose `message.content` is an array of `tool_use` blocks
  (Anthropic Message shape), carrying `id`/`model`/`usage`.
- `user` events whose `message.content` is an array of `tool_result` blocks —
  the tool-loop continuation of the *open* turn, never a new root.
- `tool_result.is_error` three-state: `true`/`false` → `failed=Some(bool)`
  (lossy — reason collapsed to a boolean), key absent → `failed=None`
  (measured). `error_code` is **structurally absent** in Claude, stays `None`.
- `ai-title` records carry `aiTitle` → the session title.

## The fixture

`healthy.jsonl` — one turn, two tool calls (one Bash, one Write to
`/repo/x.rs` inside the workspace root), two tool results (one error, one
normal), one title. No sensitive paths, no network tools, no duplicate sigs, so
SV601–606/611/612/613 spin to MeasuredZero and SV607/608/609/610/614 are
Unavailable — the healthy-session shape of §10 acceptance #4.

The Rust side (`crates/agent-vitals-adapters/src/harnesses/claude_code/sessions/evidence.rs` +
`src/agent/claude_session.rs`) builds the same records inline; the differential
gate in `tests/test_cli_matrix.py::test_claude_session_detail_differential`
feeds this file to both implementations and byte-compares the output, which is
what pins the two sides together.
