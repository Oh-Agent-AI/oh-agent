# WorkBuddy fixtures

One synthetic WorkBuddy home (`workdir/.workbuddy/`), used by the
`workbuddy-session` acceptance gate (`tests/test_cli_matrix.py` — differential
py==rs via `AGENT_VITALS_BIN`) and the §10 acceptance checks in
`docs/WORKBUDDY_INTEGRATION.md`. Rebuild with:

```bash
python3 fixtures/workbuddy/build_workbuddy_fixture.py
```

The builder is deterministic (fixed timestamps/hashes) and self-verifying: it
re-opens the home and runs the real evidence + audit projection, asserting the
exact §10 三态契约 and the §9 cost block. A fixture that stops exercising the
mapping table fails loudly instead of silently changing the gate.

## Why this exists

WorkBuddy persists each session across **four joinable surfaces** (§2.1; `traces/`
joins via `trace.sessionId` since E1/E2 — the earlier "session-anonymous" reading
was an analysis error, §12.2):

- `workbuddy.db` — `sessions` (**all 30 real-machine columns**, 2026-09-11
  `PRAGMA table_info` snapshot; the adapter still only *consumes* 8 by name —
  id/title/model/cwd/permission_mode/use_sandbox_cli/created_at/updated_at —
  the other 22 are built with the real types and left NULL on every fixture
  row) + `session_usage` (session_id/used/size/updated_at/credit_json, all 5
  real columns). **sessionId is the only join anchor.** `created_at`/
  `updated_at` (both tables) and audit-log `timestamp` are **INTEGER
  epoch-milliseconds** (13-digit), matching the real machine (2026-09-10) —
  not ISO strings. The adapter normalizes them per spec §6.2 (integer → ms →
  `YYYY-MM-DDTHH:MM:SSZ` UTC; out of `[2000-01-01, now+24h]` → null +
  `attempts`).
  The full 30/5-column shape exists for the §10 B4 双向 schema 哨兵
  (`schema_probe`, a trailing top-level key on both `--list` and single-session
  JSON): it diffs the live `PRAGMA table_info` columns against a declared
  2026-09-11 known-column baseline (`WB_KNOWN_SESSIONS_COLUMNS`/
  `WB_KNOWN_SESSION_USAGE_COLUMNS`, spec §11 规则 16 — a declared baseline, not
  a rule). A trimmed-down fixture schema would make the sentinel report a
  permanent false "22 columns missing" drift against its own baseline, which
  is exactly the paper-schema mistake spec §3.3 already tells this story
  about — so the fixture must carry the real column count even though the
  adapter reads most of it as NULL. On this fixture `schema_probe` must be
  silent: `{"migrations_applied": null, "sessions": {"unknown": [],
  "missing": []}, "session_usage": {"unknown": [], "missing": []}}`
  (`migrations_applied` is `null`, not `0` — the fixture has no
  `__workbuddy_drizzle_migrations` table, and B4 never fabricates one).
  Five of the 30 columns carry real-vocabulary values for spec §10 B5
  (`lifecycle`, a trailing key on every `--list` row and on the single-session
  JSON after `schema_probe`): s1 = `status completed / source_mode working`,
  s2 = `status terminated / source_mode coding`, both `is_playground 0 /
  is_background_automation 0 / deleted_at NULL`. They are **surfaced verbatim
  and never filtered on** — the harness has not declared their value vocabularies
  (ASK P0-3), so even a literal filter like "drop `is_playground=1`" would be an
  inference the adapter has no basis for; filtering is the consumer's decision.
  `is_playground`/`is_background_automation` stay INTEGER 0/1 (not bool),
  `deleted_at` goes through the same A2 epoch-ms normalizer as `created_at`.
  A session with a db row gets one explanatory note; an audit-log-only session
  (no db row) has `lifecycle: null` and no note.
- `audit-log/*.jsonl` — per-event decision records grouped by the **`sessionId`
  field** (not the filename), carrying `eventType`/`sequence`/`prevHash`/`hash`/
  `requestId`/`toolCallId`/`commandPreview`/`messageKey`/`messageParams`.
- `traces/<pid>/trace_<id>.json` — spec §9E.5 E1. Two traces in real-machine shape:
  `trace_e1s1…` is attributed to s1 via **`trace.sessionId`** (the only join key —
  string equality, never guessed) and carries 8 spans: 1 `agent` (cli), 1 `custom`
  (mcp_tools), 3 `function` (Bash, Edit, Write — Edit/Write `toolInput` decodes to a
  `file_path`), 3 `generation` (two with OpenAI-format `usage` under **mixed models**
  MiniMax-M3 / hy3, one cancelled with `toolOutput: null`). `trace_e1un…` has **no
  `sessionId` key** (the real machine's 321 unattributed traces are key-absent, not
  null) → `unattributed`, still real usage. **`toolInput`/`toolOutput` are JSON-encoded
  strings** (double-encoded, as on the real machine) — the reader must decode one
  layer; a fixture written as objects would make the gate test the wrong thing (§3.3).
  `trace.totalTokens` is deliberately 0 while spans carry usage — the reader must not
  read it (real machine: 302/675 are 0 with non-zero span usage). The reader keeps only
  `model`/`usage`/`file_path`/`toolName` — no prompt bodies (spec §4). Surfaces as the
  trailing `traces_probe` key on single-session JSON (`--list` untouched in E1).
- `file-history/<sessionId>/<contentHash>@v<n>` — version snapshots; the count
  is the FileMutations source (§3).

## The fixture

Two sessions:

- **s1 健康会话** — three clean records (two `sandbox-executed` bash, one
  `WebFetch`), a continuous hash chain (head `prevHash=""`), db `fullAccess` +
  `credit_json {"r1":22.53,"r2":19.48}` (real per-request magnitude ~22 credits)
  → healthy-session shape of §10 acceptance #4: `rules_unavailable=7`,
  `findings_total=0`, cost `{tokens:5000, credits:42.01, cash_cny:null,
  nominal_cny:2.1, nominal_basis:"pack-price-public:1000cr=50CNY@2026-07-01",
  harness_billed:true}` (A3: the sum is **credits**, not CNY; `cash_cny` is always
  null — no payment evidence on this machine; `nominal_cny = credits × 0.05`
  lands in the nominal lane only, never a spend lane).
- **s2 审批流程会话** — three approval decisions (approved/rejected/bulk-delete
  rejected) + one `sandbox-executed`, with a **rotated** hash-chain head
  (`prevHash="5a5a..."` on seq=100 has no predecessor) → the approvals axis +
  rotation note: `findings_total=4` (SV609×3 info, SV610×1 allowed-once
  warning), `rules_unavailable=6`, cost `{tokens:12000, credits:0.0,
  cash_cny:null, nominal_cny:0.0, nominal_basis:"…", harness_billed:true}` — a
  session not billed to credits (`credit_json={}`): the `0.0` is a real
  measurement (platform credit ledger genuinely unused), and the audit output
  carries an extra `notes` entry stating that the *cause* is not determinable
  here (self-configured route / promotional free tier / harness-side non-billing
  are indistinguishable) — it never asserts which one.

The Rust side (`crates/agent-vitals-harnesses/src/harnesses/workbuddy/sessions/evidence.rs` +
`crates/agent-vitals-harnesses/src/harnesses/workbuddy/sources/mod.rs`) reads the same sqlite db (rusqlite, bundled)
and audit-log; the differential gate in `tests/test_cli_matrix.py` copies
`workdir` into a temp HOME, feeds it to both implementations, and byte-compares
the output — which is what pins the two sides together.
