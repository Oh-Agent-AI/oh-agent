# Codex cost fixtures

Three synthetic Codex rollout files for the `codex-cost` differential
(`tests/test_cli_matrix.py`) and characterization (`tests/test_characterization.py`)
tests. Rebuild with:

```bash
python3 fixtures/codex/cost/build_fixtures.py
```

The builder is deterministic (fixed timestamps) and **self-verifying**: it folds
each rollout through the real `codex_usage` + prices through the real `codex_cost`
and asserts the hand-computed expectations documented at the top of the file, so a
fixture that stops exercising a fold/pricing behaviour fails loudly.

## What each file covers

| | `rollout-sol.jsonl` | `rollout-terra.jsonl` | `rollout-unpriced.jsonl` |
|---|---|---|---|
| model(s) | `gpt-5.6-sol` | `gpt-5.6-terra` → mid-file switch → `gpt-5.6-luna` | `codex-auto-review` |
| date(s) | 2026-08-01 / 08-02 | 2026-07-15 (archived) | 2026-08-03 |
| live/archived | live (`sessions/`) | **archived** (`archived_sessions/`) | live |
| dedup full-repeat (`last==total`) | yes (skipped) | — | — |
| dedup zeroed-repeat (`last` all-zero + fake total) | yes (skipped at dedup layer) | — | — |
| token_count before first `turn_context` | yes → `unaccounted` | — | — |
| invalid `last` (reasoning > output) | yes → `unaccounted` | — | — |
| cache_write (5m bucket) | yes | yes | — |
| longContext (input > 272000) | yes (08-02 bucket) | no (both under threshold) | — |
| unpriced model | — | — | yes (6000 tokens) |

The archived placement of `rollout-terra.jsonl` is deliberate: it proves
`codex-cost` scans both `~/.codex/sessions/` **and** `~/.codex/archived_sessions/`
(cc-trace 研究 §B 的漏读教训——漏扫归档会话 = 漏成本).

## Hand-computed expectations (asserted by the builder)

- `gpt-5.6-sol` (5 / 0.5 / 6.25 / 30): 08-01 bucket `(uncached 50000, cached 40000,
  write 10000, output 10000)` = **$0.6325**; 08-02 bucket `(120000, 150000, 30000,
  60000)`, input_total 300000 > 272000 → longContext (input ×2, output ×1.5) =
  **$4.425**; total **$5.0575**.
- `gpt-5.6-terra` (2 / 0.2 / 2.5 / 12): `(65000, 30000, 5000, 20000)` = **$0.3885**.
- `gpt-5.6-luna` (0.2 / 0.02 / 0.25 / 1.2): `(130000, 60000, 10000, 50000)` =
  **$0.0897**.
- `codex-auto-review`: no catalog entry → `priced:false`, `unpriced_tokens` = 6000.
- unaccounted: `token_count_before_turn_context` ×1 (tokens_seen 1100),
  `token_count_invalid_last_usage` ×1 (tokens_seen 670).

All-model total (no month filter) = 0.6325 + 4.425 + 0.3885 + 0.0897 + 0 =
**$5.5357**; `--month 2026-08` keeps only sol + codex-auto-review → **$5.0575**
(the July archived session drops off the date axis, and `by_model` is recomputed
from the filtered dates so `sum(days.cost) == total_cost_usd` still reconciles).

## Consumers

- `scripts/agent_vitals/agent/codex_usage.py` ↔ `crates/agent-vitals-core/src/adapters/harnesses/codex/sessions/usage.rs`
  — the fold.
- `scripts/agent_vitals/agent/codex_cost.py` ↔ `src/codex_cost.rs` — the pricing.
- `scripts/agent_vitals/adapters/codex_session.py` ↔ `src/codex_session.rs` —
  the `rollout-*.jsonl` enumeration (`codex_rollout_files`).
- `tests/test_cli_matrix.py::test_codex_cost_differential` /
  `test_codex_cost_month_filter_reconciles` — byte-for-byte Python↔Rust.
- `tests/test_characterization.py::CodexCostCharacterization` — pins the numbers
  above against the Python implementation (the Rust side pins the same via its
  own `#[cfg(test)]`).
