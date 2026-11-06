//! 扫描本机各 Agent 执行环境的 skill 安装目录，输出成本清单（JSON）。
//!
//! 只做确定性统计，不做判断。判断交给调用它的 Agent。
//!
//! 关键设计：**区分「装在磁盘上」和「真的进了上下文」**。未启用的插件副本、
//! 其他执行环境（Codex 等）的 skill 都在磁盘上，但不占 Claude Code 的描述预算。
//! 把它们算进去会得出「预算超支」的假警报。
//!
//! 本文件是 scripts/scan.py 的移植。输出必须与之逐字节一致 ——
//! `python3 tests/golden_runner.py` 是唯一裁判。

// 子树：skills/（静态 SKILL.md 体检）+ agent/（会话行为/成本审计）。
// dsh.rs 与 util.rs 是两世界共享，留在顶层。
mod agent;
mod mcp;
mod skills;
mod util;

use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use serde_json::{json, Value};

use agent_vitals_runtime::skills::scanner::Ctx;
use util::norm;

// v0.8 Phase E7.2：覆盖优先级排序（level_rank/level_rank_for/severity_rank/
// conflict_rank/CODEX_FALLBACK_DESC_BUDGET/layer_of）+ JSON 字段取值助手
// （s/i/f/b/chars）迁进 agent-vitals-domain（纯计算，不认识执行环境 wire 格式，
// 本该一直在那）。`analysis.rs`/`overlap.rs` 同一步跟着搬进 domain；
// `layer_of` 原本因为 `discovery.rs` 还在二进制里而保留 re-export，E7.5
// discovery.rs 也搬进库 crate 后这条 re-export 已无调用点，删掉——只有
// `s`/`i`/`f`/`b`（doctor/explain/report/snapshot/oneline 用）在 apps/cli
// 里还有调用点，保留 re-export 让这些 call site 零改动；其余
// （`conflict_rank`/`level_rank`/`level_rank_for`/`severity_rank`/
// `CODEX_FALLBACK_DESC_BUDGET`/`chars`）只在 domain/runtime 内部被用，不再
// re-export（`doctor.rs` 恰好有自己独立的 `severity_rank` 实现，同名不同
// 函数，不是同一份代码的两个入口）。
pub(crate) use agent_vitals_domain::util::{b, f, i, s};

/// 拒绝负数。**不能静默接受后产出垃圾** —— `--budget -1` 会算出
/// `pct_used: -6300.0` 并原样打进摘要行，一个负百分比被当成测量值输出。
/// 拒绝比编一个数好。
///
/// 需要配合 `allow_negative_numbers`：否则 clap 把 `-1` 当成另一个参数，
/// 报「未知参数」，用户看不出真正的问题在哪。
fn non_negative(s: &str) -> Result<i64, String> {
    let v: i64 = s.parse().map_err(|_| format!("not an integer: {}", s))?;
    if v < 0 {
        return Err(format!("cannot be negative (received {})", v));
    }
    Ok(v)
}

#[derive(Parser)]
#[command(
    name = "agent-vitals",
    version,
    about = "Agent Skills health-check scanner",
    allow_negative_numbers = true
)]
struct Args {
    /// Analyze one harness; default: scan every supported harness separately
    #[arg(long, global = true, default_value = "all",
          value_parser = ["all", "claude-code", "codex", "openclaw", "hermes", "workbuddy", "dsh"])]
    harness: String,

    /// Additional scan path; repeatable
    #[arg(long = "path", global = true)]
    path: Vec<String>,

    /// Write scan JSON to FILE; use - for stdout. Without this option, run doctor.
    #[arg(long = "json", value_name = "FILE")]
    json: Option<PathBuf>,

    /// Description character budget; default: 15000
    #[arg(long, global = true, value_parser = non_negative)]
    budget: Option<i64>,

    /// Calculate budget and conflicts over all on-disk skills (diagnostic; default: loaded only)
    #[arg(long, global = true)]
    all: bool,

    /// Minimum installed age for zombie classification; default: 14
    #[arg(long = "zombie-age", global = true, default_value_t = 14, value_parser = non_negative)]
    zombie_age: i64,

    /// Recommend splitting above this tier2_core_tokens value; default: 6000
    #[arg(long = "split-threshold", global = true, default_value_t = 6000, value_parser = non_negative)]
    split_threshold: i64,

    /// Previous scan JSON used for change comparison
    #[arg(long, global = true)]
    baseline: Option<PathBuf>,

    /// Exit code 1 when a finding at this severity is present (for CI). Default: critical; none never fails on findings
    #[arg(long = "fail-on", global = true, default_value = "critical",
          value_parser = ["none", "critical", "warning", "info"])]
    fail_on: String,

    /// Diagnostic codes excluded from the gate, comma-separated (e.g. SV301,SV302). Ignored codes are still printed
    #[arg(long, global = true, default_value = "")]
    ignore: String,

    /// Gate only diagnostics that are new relative to the baseline; exit code 2 without a baseline
    #[arg(long = "new-only", global = true)]
    new_only: bool,

    /// Disable doctor's automatic snapshot and comparison
    #[arg(long = "no-snapshot", global = true)]
    no_snapshot: bool,

    /// Redact home directories and user names in absolute paths for safe sharing
    #[arg(long, global = true)]
    redact: bool,

    /// Also redact skill names to stable skill-001-style IDs
    #[arg(long = "redact-names", global = true)]
    redact_names: bool,

    /// This tool's own skill directory, excluded from security scanning; inferred when omitted.
    #[arg(long = "self-root", global = true)]
    self_root: Option<PathBuf>,

    /// Print the CLI build contract without touching local state. Release packagers use
    /// this to prove the bundled CLI can open the desktop app's authority schema.
    #[arg(long = "build-info", global = true, hide = true)]
    build_info: bool,

    /// DSH registry snapshot JSON (probe evidence); when absent, loaded falls back to the session log
    #[arg(long = "runtime-json", global = true)]
    runtime_json: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Option<Cmd>,
}

/// Subcommands are layered on top of the existing options.
///
/// `agent-vitals` with no arguments is equivalent to `doctor` (PRODUCT §5): the
/// deciding factor is whether `--json` was given, not whether a subcommand was used —
/// SKILL.md and every integration test rely on `--json <file>` for the raw JSON, so
/// demoting the scan to a subcommand would break every caller at once.
#[derive(Subcommand)]
enum Cmd {
    /// List discovered skills and their effective state
    List {
        /// Show dormant / zombie only
        #[arg(long)]
        unused: bool,
        /// Show shadowed copies only
        #[arg(long)]
        shadowed: bool,
        /// Dormant threshold in days; default: 30
        #[arg(long, value_parser = non_negative)]
        stale: Option<i64>,
        #[arg(long, default_value = "cost", value_parser = ["usage", "cost", "name"])]
        sort: String,
        /// Show only the first N rows
        #[arg(long)]
        top: Option<usize>,
        /// Write JSON instead of a table. Unlike the top-level --json, this serializes
        /// the table rows rather than the scan.
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Turn scan facts into cause, impact, and action
    Doctor {
        /// Jaccard threshold for SV401; default: 0.25 (shared with overlap)
        #[arg(long, default_value_t = skills::doctor::DEFAULT_OVERLAP_MIN)]
        min: f64,
        /// Write diagnostic JSON instead of a report
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
        /// Attach the full scan report to the JSON payload as "report". A consumer
        /// that needs both the SV diagnostics and the harness summaries then scans
        /// once instead of twice (the desktop Skill tab; budget/trigger evidence
        /// lives in the report, SV codes in the diagnostics).
        #[arg(long = "with-report", requires = "rows_json")]
        with_report: bool,
    },
    /// Turn the scan report into a quantified, ranked, honest savings plan
    /// (diagnosis → treatment plan; SKILL.md §4 Recommended disposition as data).
    ///
    /// Items are a **proposal**: risk ordering is a suggested reading order, the
    /// decision stays with the user (`Never delete or disable a skill unless the
    /// user explicitly asks`). `savings_per_event` is always measured (report
    /// fields, tokens); `events_per_month` is filled ONLY from `--startup-rate`
    /// (an estimate, never from lifetime `usage_count` — that is exposed
    /// separately as `measured_lifetime_triggers`).
    Plan {
        /// Estimated starts of Claude Code per month; the ONLY source for
        /// per-startup items' events_per_month (an estimate, not a measurement)
        #[arg(long, value_parser = non_negative)]
        startup_rate: Option<i64>,
        /// Write plan JSON to FILE; use - for stdout
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Save a snapshot to ~/.agent-vitals/snapshots
    Snapshot {
        /// Retain the newest N snapshots; default: 30; 0 means unlimited
        #[arg(long, default_value_t = agent_vitals_runtime::skills::snapshot::SNAPSHOT_KEEP, value_parser = non_negative)]
        keep: i64,
    },
    /// Compare with the previous snapshot
    Diff {
        /// Snapshot file to compare; default: latest
        file: Option<PathBuf>,
        /// Write JSON instead of a report
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Explain why one skill is ineffective and how to fix it
    Explain {
        /// Skill name or <plugin>:<name>
        name: String,
        /// Jaccard threshold for neighbors; default: 0.25 (shared with overlap)
        #[arg(long, default_value_t = skills::doctor::DEFAULT_OVERLAP_MIN)]
        min: f64,
        /// Write JSON instead of a report
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Lexical filter for skills that may compete for similar requests
    Overlap {
        /// Jaccard threshold; default: 0.25
        #[arg(long, default_value_t = skills::doctor::DEFAULT_OVERLAP_MIN)]
        min: f64,
        /// Show only the first N pairs
        #[arg(long)]
        top: Option<usize>,
        /// Write JSON instead of a table
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Audit a DSH session log for high-risk behaviors (SV601-SV610)
    Behavior {
        /// Path to the DSH session JSONL log (file or directory)
        session_log: PathBuf,
        /// Write findings JSON to FILE; use - for stdout
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Local-only Trust/Egress historical audit. Reads artifact metadata only;
    /// it never uploads data, reads artifact contents, or claims cloud-side use.
    Trust {
        #[command(subcommand)]
        action: TrustAction,
    },
    /// Fold a DSH session log into navigation snapshots (oneline.json +
    /// sessions.jsonl). Business usage/cost data is written and read only via
    /// the SQL authority. Fenced: state owner must be `rust` (takeover) unless
    /// --shadow. Writer fencing fails fast before the audit cost.
    Oneline {
        /// Path to the DSH session JSONL log (single file, not a directory)
        session_log: PathBuf,
        /// Native session id override (the tick's discovery passes the agentId
        /// dir name here — DSH logs are always named `session.jsonl`, so the
        /// file-stem default "session" would collide every session into one
        /// dedup key). Default: file stem, byte-mirroring Python scan.py.
        #[arg(long = "session-id")]
        session_id: Option<String>,
        /// Compatibility flag retained for old scripts. SQL-authority mode has
        /// no legacy merge step, so it has no effect.
        #[arg(long)]
        no_merge: bool,
        /// Rehearse on a copy: skip writer fencing (like `state fold-session --shadow`)
        #[arg(long)]
        shadow: bool,
    },
    // Discover 是 R1d-tick 的输入面：Tauri tick 在这里 shell out，折最新未折。
    // 中文说明放注释——clap 的 help 是 scanner-owned 文本，test_regressions 的
    // test_help_defaults_to_english 钉死 ASCII-only（英文），不能漏进 command surface。
    /// Discover unfolded DSH sessions under `<DSH_HOME>/sessions` (R1d-tick
    /// input: the Tauri tick shells out here and folds the latest). Read-only:
    /// touches no fencing and writes no state; zstd-only sessions are counted
    /// and reported honestly (decompression is unwired — an R2a SessionStore
    /// gap). JSON output: `unfolded` sorted by mtime descending (latest first).
    Discover {
        /// Write JSON to FILE; use - for stdout. Default: stdout.
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Print the HarnessProfile registry (v0.6 harness-contract spec §5.1): the
    /// four runtime harnesses' declared structural capabilities (unmeasured
    /// signals, degraded rules, session-store/fold capability). This is the
    /// registry itself, not a per-session derive — see `docs/
    /// VITALS_CORE_V0_6_HARNESS_CONTRACT_SPEC.md` §5.2 for what it does and does
    /// not answer.
    Harnesses {
        /// Write harnesses JSON to FILE; use - for stdout. Without this option,
        /// print a human table.
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Audit a DSH session log for Skill execution events (skill-invocation / tool/call name=skill).
    SkillAudit {
        /// Path to the DSH session JSONL log (file or directory)
        session_log: PathBuf,
        /// Write skill audit JSON to FILE; use - for stdout
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Audit a DSH session log for execution duration (tool calls / turns / steps / approvals / hooks).
    DurationAudit {
        /// Path to the DSH session JSONL log (file or directory)
        session_log: PathBuf,
        /// Write duration audit JSON to FILE; use - for stdout
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Build the deterministic TraceGraph for one session file (v0.10.0).
    /// Read-only diagnostic: emits the graph JSON (nodes / edges / coverage),
    /// writes no state. Nodes are ordered by (scope, ordinal) — never by
    /// timestamp; missing parent/time/status are counted in coverage, never
    /// fabricated. Three-harness closed vocabulary: claude-code / codex / dsh.
    Trace {
        /// Path to a session file (jsonl; dsh accepts .zstd)
        session_file: PathBuf,
        /// Which harness's wire format to parse (claude-code / codex / dsh)
        #[arg(long, value_parser = ["claude-code", "codex", "dsh"])]
        harness: String,
        /// machine_namespace component of SessionKey — required (spec §9);
        /// the CLI never invents one (missing exits 2)
        #[arg(long)]
        machine_namespace: Option<String>,
        /// source_profile component of SessionKey (default: 'default')
        #[arg(long, default_value = "default")]
        source_profile: String,
        /// Write the TraceGraph JSON to FILE; use - for stdout (default: summary)
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
        /// Project the graph into the timeline_series spec (input shape of
        /// ui/timeline.js buildGeometry) instead of the raw graph — data
        /// preparation only, the geometry itself stays the single shared one
        #[arg(long = "timeline-series")]
        timeline_series: bool,
    },
    /// V16 anchor report (LOCAL presentation layer only, never an MCP tool):
    /// given an opaque session_ref, print that session's workflow anchor
    /// coordinates (native_event_id + line/offset hints + error classes) and
    /// task-intent excerpts from the authority DB. No paths are resolved here.
    TraceAnchors {
        /// Opaque session_ref from `sessions list` / sessions_search.
        #[arg(long)]
        session_ref: String,
    },
    /// Build a TraceGraph for a session returned by `sessions list` without
    /// exposing or accepting a raw source path. This is the public v0.10
    /// drill-down path; `trace <file>` remains a local diagnostic utility.
    TraceRef {
        /// Opaque session_ref from `sessions list` / sessions_search.
        #[arg(long)]
        session_ref: String,
        /// Write JSON to FILE; use - for stdout (default: stdout).
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
        /// Return timeline_series instead of the full TraceGraph.
        #[arg(long = "timeline-series")]
        timeline_series: bool,
    },
    /// Audit a Codex rollout log into a CanonicalSession with §13 coverage
    /// (P4 "sound" proof — Legacy + Paginated fold into the shared 19-signal model).
    ///
    /// Emits coverage JSON, not findings: Codex has no SV601-614 detectors yet
    /// (detector decoupling is the deferred later phase). `--harness codex` is the
    /// install-time probe surface and is unrelated to this subcommand.
    CodexEvidence {
        /// Path to the Codex rollout JSONL log (or use --roots)
        #[arg(required_unless_present = "roots")]
        session_log: Option<PathBuf>,
        /// List the Codex session roots (live + archived) instead of auditing
        /// one log — archived_sessions existence is probed, never an error
        #[arg(long = "roots")]
        roots: bool,
        /// Write coverage JSON to FILE; use - for stdout
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Price Codex token usage (USD) into a per-model / per-day cost report
    /// (cc-trace research §D landing, docs/CC_TRACE_APPLICATION.md §5 item 4).
    /// Reads the SQL authority DB (populated by `sync-facts`); priced against
    /// codex_pricing.json (USD). Text / JSON / HTML. Codex is a ChatGPT
    /// subscription, so the USD figure is list-price, not a bill.
    CodexCost {
        /// Restrict the report to one calendar month; `all` = every month
        #[arg(long = "month")]
        month: Option<String>,
        /// Today only; default (no flags) is the current calendar month
        #[arg(long = "today", conflicts_with = "month")]
        today: bool,
        /// Write the report JSON to FILE; use - for stdout
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
        /// Write a self-contained HTML dashboard to FILE
        #[arg(long = "html")]
        html: Option<PathBuf>,
    },
    /// Audit ONE Codex session (per-session cost + provenance), in the DSH
    /// audit-tab visual language. `codex-cost` aggregates session identity away
    /// during fold; `codex-evidence` gives per-file provenance without cost.
    /// This joins the two halves back around a logical session_id (resume
    /// rollouts merge by session_id), reusing the exact fold → price path.
    /// Stateless single call; `--list` enumerates sessions (the id picker).
    CodexSession {
        /// List all Codex sessions: id/title/model/file count/date span
        #[arg(long)]
        list: bool,
        /// The logical session_id to audit; default = the most recent session
        #[arg(long)]
        session: Option<String>,
        /// Write the audit JSON to FILE; use - for stdout
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
        /// Write a self-contained HTML audit report to FILE
        #[arg(long = "html")]
        html: Option<PathBuf>,
    },
    /// Audit a Claude Code session (`~/.claude/projects/**/*.jsonl`) into a
    /// CanonicalSession with §13 coverage + SV601–614 findings. Claude's tool
    /// results carry no reason codes, so SV607/608 degrade to Unavailable
    /// (harness capability, §12); SV609/610/614 are Unavailable via the empty
    /// approval/sandbox timelines. Stateless single call; `--list` enumerates.
    ClaudeSession {
        /// List all Claude sessions: id/title/model/cwd/date span
        #[arg(long)]
        list: bool,
        /// The session_id to audit; default = the most recent session
        #[arg(long)]
        session: Option<String>,
        /// Write the audit JSON to FILE; use - for stdout
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Fold Claude Code session files (`~/.claude/projects/**/*.jsonl`) into the
    /// claude data plane: claude-fold.json checkpoints + claude-ledger.json /
    /// claude-ledger-archive.json per-day by_model buckets (R1d-tick producer
    /// for the tray's Claude ≈ estimate columns; the tick runs this after the
    /// DSH oneline fold). Byte-for-byte mirror of Python `scan.py claude-sync`.
    /// Fenced like oneline: state owner must be `rust` (takeover) unless
    /// --shadow. Tail-reads appended rows since the last sync (offset + size +
    /// mtime checkpoints, exactly-once); cost-state records replace the
    /// session baseline rather than adding to it.
    ClaudeSync {
        /// Rehearse on a copy: skip writer fencing (like `oneline --shadow`)
        #[arg(long)]
        shadow: bool,
    },
    /// Audit ONE Claude session JSONL into per-message UsageFact rows (facts +
    /// attempts + coverage; v0.7 spec §3 candidate #3). R1 ratified: in-memory
    /// emit + read-only diagnostic — writes no state at all. machine_namespace
    /// is REQUIRED (spec §9): a fact's identity fields seed its fact_id, so a
    /// CLI-invented namespace would make replays unstable AND trigger takeover's
    /// identity bootstrap (a state write) — both forbidden, so a missing value
    /// fails with exit 2 instead of being defaulted.
    /// Byte-for-byte mirror of Python `scan.py claude-usage-facts --json -`.
    ClaudeUsageFacts {
        /// Path to a Claude session JSONL file
        session_jsonl: PathBuf,
        /// machine_namespace component of SessionKey — required (spec §9);
        /// the CLI never reads/writes state to invent one (missing exits 2)
        #[arg(long)]
        machine_namespace: Option<String>,
        /// source_profile component of SessionKey (default: 'default')
        #[arg(long, default_value = "default")]
        source_profile: String,
        /// Write the UsageFact JSON to FILE; use - for stdout (default: human summary)
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
        /// v0.9 Stage A: persist facts through the runtime ingest service into
        /// <data_home>/facts/<harness>.jsonl (exactly-once by fact_id). Rust-only
        /// by design — Python grows no writer (spec DoD #7); without this flag
        /// the output stays byte-identical to the Python implementation.
        #[arg(long)]
        write: bool,
    },
    /// List validated manifest harnesses (HARNESS_MANIFEST_DSL_SPEC §7.2 registry).
    /// Read-only; broken manifests are reported, never fatal (degradation
    /// isolation). Python mirror lands with the parity task.
    ManifestList,
    /// Read-only combined harness registration/data inventory; never activates candidates.
    HarnessInventory {
        #[arg(long, default_value_t = 30)]
        window_days: u16,
    },
    /// Local manifest-catalog check status (E06): reads the status/policy files
    /// written by the desktop check. CLI has no network transport — the fetch
    /// itself is desktop-owned, mirroring the pricing catalog.
    ManifestCatalogStatus,
    /// Preview or explicitly activate a local harness manifest. No network or fact writes.
    ManifestInstall {
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        machine_namespace: String,
        /// Optional bounded file sample; discovery is used when omitted.
        #[arg(long = "file")]
        files: Vec<PathBuf>,
        /// Exact preview_sha256 returned by the preceding dry run.
        #[arg(long)]
        confirm: Option<String>,
        #[arg(long = "json")]
        rows_json: bool,
    },
    /// Preview or confirm removal of one active harness manifest slot.
    ManifestUninstall {
        #[arg(long)]
        slug: String,
        #[arg(long)]
        confirm: Option<String>,
    },
    /// Preview or confirm rollback of one harness to a historically active revision.
    ManifestRollback {
        #[arg(long)]
        slug: String,
        #[arg(long)]
        revision: String,
        #[arg(long)]
        machine_namespace: String,
        #[arg(long = "file")]
        files: Vec<PathBuf>,
        #[arg(long)]
        confirm: Option<String>,
    },
    /// Explicit historical replay into a separate immutable result; never rewrites bills.
    ManifestRecompute {
        #[arg(long)]
        slug: String,
        #[arg(long)]
        revision: String,
        #[arg(long)]
        machine_namespace: String,
        #[arg(long = "file")]
        files: Vec<PathBuf>,
        #[arg(long)]
        confirm: Option<String>,
    },
    /// Dry-run a manifest harness (§6.5 first-install walkthrough): discovery + extraction +
    /// fact_id stability + format guard. No writes. With --file, feed fixture
    /// files directly (golden/parity mode); otherwise discovery per manifest.
    /// Mirrors Python `scan.py manifest-validate`.
    ManifestValidate {
        /// Path to harnesses.d/<slug>/manifest.json
        #[arg(long)]
        manifest: PathBuf,
        /// Optional explicit files (fixture mode); discovery otherwise
        #[arg(long = "file")]
        files: Vec<PathBuf>,
        /// machine_namespace for fact identity (fixture mode requires it too)
        #[arg(long)]
        machine_namespace: Option<String>,
        /// Print the full report as JSON to stdout
        #[arg(long = "json")]
        rows_json: bool,
    },
    /// Retired direct-write command. Install with preview/confirm, then use sync.
    ManifestIngest {
        /// Path to harnesses.d/<slug>/manifest.json (slug must match dir name)
        #[arg(long)]
        manifest: PathBuf,
        /// machine_namespace component of SessionKey — required (spec §9)
        #[arg(long)]
        machine_namespace: Option<String>,
        /// Persist through ingest service + authority
        #[arg(long)]
        write: bool,
        /// Print the full report as JSON to stdout
        #[arg(long = "json")]
        rows_json: bool,
    },
    /// Replay a WorkBuddy home (`~/.workbuddy`) into UsageFact rows — one per
    /// generation span with usage, keyed by trace.sessionId (E4a, spec §9E.5).
    /// Buckets map like Codex's OpenAI-format usage: uncached = prompt − cached,
    /// cache_read = cached, cache_write = 0, output = completion. Provider/route
    /// attribution is resolved via the current endpoint hint and left
    /// unresolved on purpose (platform-credit vs self-configured vs promo
    /// track is per-request and not observable locally, spec §2.1). Traces
    /// without a sessionId are counted as `unattributed`, never emitted.
    /// Without --write this is an in-memory, read-only diagnostic, byte-for-byte
    /// mirror of Python `scan.py workbuddy-usage-facts --json -`.
    WorkbuddyUsageFacts {
        /// WorkBuddy home directory (the one containing traces/)
        root: PathBuf,
        /// machine_namespace component of SessionKey — required (spec §9);
        /// the CLI never reads/writes state to invent one (missing exits 2)
        #[arg(long)]
        machine_namespace: Option<String>,
        /// source_profile component of SessionKey (default: 'default')
        #[arg(long, default_value = "default")]
        source_profile: String,
        /// Write the UsageFact JSON to FILE; use - for stdout (default: human summary)
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
        /// Persist facts through the runtime ingest service into
        /// <data_home>/facts/workbuddy.jsonl (exactly-once by fact_id). Rust-only
        /// by design — Python grows no writer; without this flag the output stays
        /// byte-identical to the Python implementation. (E4b, spec §9E.5)
        #[arg(long)]
        write: bool,
    },
    /// Audit ONE or MORE Codex rollout JSONL files into per-`token_count`
    /// UsageFact rows (facts + attempts + coverage; v0.7 spec §3 candidate #3
    /// Stage 2). In-memory emit + read-only diagnostic — writes no state at all.
    /// machine_namespace is REQUIRED (spec §9) — same reasoning as
    /// claude-usage-facts: missing exits 2 instead of being defaulted.
    /// source_event_id is namespaced by the physical rollout stem (not the
    /// logical session): the same stem re-collected byte-identically dedups
    /// (live/archive), different stems never merge (2026-09-03 decision D′).
    /// Byte-for-byte mirror of Python `scan.py codex-usage-facts --json -`.
    CodexUsageFacts {
        /// One or more Codex rollout JSONL file paths
        #[arg(required = true, num_args = 1..)]
        rollouts: Vec<PathBuf>,
        /// machine_namespace component of SessionKey — required (spec §9);
        /// the CLI never reads/writes state to invent one (missing exits 2)
        #[arg(long)]
        machine_namespace: Option<String>,
        /// source_profile component of SessionKey (default: 'default')
        #[arg(long, default_value = "default")]
        source_profile: String,
        /// Write the UsageFact JSON to FILE; use - for stdout (default: human summary)
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
        /// v0.9 Stage A: persist facts through the runtime ingest service into
        /// <data_home>/facts/<harness>.jsonl (exactly-once by fact_id). Rust-only
        /// by design — Python grows no writer (spec DoD #7); without this flag
        /// the output stays byte-identical to the Python implementation.
        #[arg(long)]
        write: bool,
    },
    /// Audit ONE DSH session file (`.jsonl` or multi-frame `.zstd`) into
    /// per-observation-slot UsageFact rows (facts + coverage; v0.7 spec §3
    /// candidate #3 Stage 3). In-memory emit + read-only diagnostic — writes no
    /// state at all. machine_namespace is REQUIRED (spec §9) — same reasoning as
    /// claude-usage-facts: missing exits 2 instead of being defaulted.
    /// source_profile derives from the header cwd by default; a header with no
    /// cwd and no explicit profile is `unattributed` (exit 2). Strict single-file
    /// errors (§4.1) never emit a fake-empty success.
    /// Byte-for-byte mirror of Python `scan.py dsh-usage-facts --json -`.
    DshUsageFacts {
        /// Path to a DSH session file (.jsonl or multi-frame .zstd)
        #[arg(long = "path")]
        session_path: PathBuf,
        /// machine_namespace component of SessionKey — required (spec §9);
        /// the CLI never reads/writes state to invent one (missing exits 2)
        #[arg(long)]
        machine_namespace: Option<String>,
        /// source_profile component of SessionKey (default: derive from the
        /// session header cwd; explicit wins; header cwd missing + none →
        /// unattributed, exit 2)
        #[arg(long)]
        source_profile: Option<String>,
        /// Write the UsageFact JSON to FILE; use - for stdout (default: human summary)
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
        /// v0.9 Stage A: persist facts through the runtime ingest service into
        /// <data_home>/facts/<harness>.jsonl (exactly-once by fact_id). Rust-only
        /// by design — Python grows no writer (spec DoD #7); without this flag
        /// the output stays byte-identical to the Python implementation.
        #[arg(long)]
        write: bool,
    },
    /// Routine facts sync across all three harnesses (locate, checkpoint diff,
    /// emit, then SQL authority + legacy dual-write). Idempotent: re-runs
    /// skip unchanged files (source_files fingerprints) and dedup facts by
    /// fact_id. The machine namespace comes from machine.json (the sync
    /// caller IS the machine). v0.9.1 retirement-path step 1.
    SyncFacts {
        /// Output the sync report as JSON
        #[arg(long = "json")]
        rows_json: bool,
        /// Targeted sync (LIGHT-PATH spec §5.2): only run these harnesses'
        /// batches (comma-separated, e.g. `--harnesses claude-code,codex`).
        /// Absent = all harnesses (default, byte-identical to the old form).
        #[arg(long = "harnesses")]
        harnesses: Option<String>,
    },
    /// One-time import of the legacy facts JSONL into the SQL authority DB
    /// (spec 6.2.1: JSONL is the highest-fidelity migration source; same
    /// fact_id = idempotent). Safe to re-run. By default imports ONLY the
    /// raw per-message facts JSONL; pass --with-legacy-ledger to also fold
    /// the claude-ledger deep-history aggregates (observation_kind=
    /// legacy_aggregate) for days whose session files have already rotated
    /// away.
    DataMigrate {
        /// Also import claude-ledger.json deep-history as legacy_aggregate rows
        #[arg(long = "with-legacy-ledger")]
        with_legacy_ledger: bool,
    },
    /// Authority DB status: schema version, recent sync runs, source
    /// counts, data-quality summary (spec 9, authority part of data
    /// doctor).
    DataStatus {
        /// Output as JSON
        #[arg(long = "json")]
        rows_json: bool,
    },
    /// Phase 2.8 (spec 5.3): explicit harness-bill management. Harness bills (WorkBuddy
    /// credit, subscription invoices, relay statements) are user-entered, not
    /// derived from our price cards. `set` upserts one; `list --month` shows a
    /// period; `delete --id` soft-deletes. Amounts are minor units (integer).
    DataHarnessBill {
        #[arg(value_parser = ["set", "list", "delete"])]
        action: String,
        /// set/list/delete: billing period YYYY-MM (default: current for list)
        #[arg(long)]
        month: Option<String>,
        /// set: harness (e.g. workbuddy)
        #[arg(long)]
        harness: Option<String>,
        /// set: provider id (e.g. workbuddy)
        #[arg(long)]
        provider: Option<String>,
        /// set: billing basis (harness_billed | fixed_subscription | metered_actual | ...)
        #[arg(long)]
        basis: Option<String>,
        /// set: amount in minor units (¥1.00 = 100)
        #[arg(long = "amount-minor")]
        amount_minor: Option<i64>,
        /// set: currency (e.g. CNY, USD)
        #[arg(long)]
        currency: Option<String>,
        /// set: free-text evidence reference (also part of the dedup key)
        #[arg(long)]
        evidence: Option<String>,
        /// delete: the bill_id to soft-delete
        #[arg(long = "id")]
        bill_id: Option<String>,
        /// Output JSON
        #[arg(long = "json")]
        rows_json: bool,
    },
    /// Export facts from the SQL authority database (spec §9: both exports are
    /// generated from SQL queries). Identity fields verbatim; soft-deleted rows
    /// excluded. Files land as <harness>.jsonl
    DataExportPrivate {
        /// Output directory (created on demand); files land as <harness>.jsonl
        #[arg(long)]
        out: PathBuf,
    },
    /// Export facts with identity fields pseudonymized (machine_namespace /
    /// native_session_id / source_profile / source_event_id → stable fnv1a64
    /// pseudonyms, fact_id re-stamped through the contract layer). Same SQL
    /// source as data-export-private. Spec §6: this is a SEPARATE
    /// write path from data-export-private by design — not a --redacted flag.
    DataExportRedacted {
        /// Output directory (created on demand); files land as <harness>.jsonl
        #[arg(long)]
        out: PathBuf,
    },
    /// Drill into unresolved/unpriced usage per model (completes DoD #4:
    /// monthly cost split by basis AND drillable to its sources). Groups
    /// match by_provider keys; reasons: billing-route-unknown /
    /// billing-mode-unknown / no-price-card / partial-price-basis. Stage B.
    DataUnresolved {
        /// Month to inspect ("YYYY-MM"; default: current month)
        #[arg(long)]
        month: Option<String>,
        /// Output as JSON
        #[arg(long = "json")]
        rows_json: bool,
    },
    /// Billing confirmation groups for one month with the program's own
    /// verdict per group (auto-attribution spec §5.1: determined /
    /// one_question / needs_input) — the same data the desktop
    /// billing-confirmation list renders, for CLI/desktop reconciliation. Read-only; account
    /// evidence is limited to the allow-listed plan fields.
    BillingGroups {
        /// Month to inspect ("YYYY-MM"; default: current month)
        #[arg(long)]
        month: Option<String>,
        /// Output as JSON (groups + clusters)
        #[arg(long = "json")]
        rows_json: bool,
    },
    /// Re-import the authoritative facts/*.jsonl into TWO throwaway temp DBs
    /// (one round crashes after the first harness, then reopens + re-migrates
    /// idempotently) and diff the per-harness, per-Beijing-month aggregates.
    /// Proves Q12: re-running any month/day query is byte-identical to the
    /// first successful import, no half-commits. Never touches the live DB.
    /// This is the MCP-external half of migration self-check (spec §8.1.2);
    /// the read-only MCP does not do re-imports.
    DataReimportVerify {
        /// Output the full machine-readable report as JSON
        #[arg(long = "json")]
        rows_json: bool,
    },
    /// Audit a WorkBuddy session (`~/.workbuddy/` sqlite db + audit-log + file-history)
    /// into a CanonicalSession with §13 coverage + SV601–614 findings. The db
    /// `sessions` row is the join anchor across the four joinable surfaces (spec
    /// §2.1; traces join via `trace.sessionId` since E1/E2); cost is the harness-billed
    /// credit_json (spec §9). Edit/Write spans feed SV604/605, span status feeds
    /// SV607/608, agent spans feed SubagentSpawns; Bash spans are not folded until
    /// E3 (audit-log stays the Bash source). Stateless single call; `--list` enumerates.
    WorkbuddySession {
        /// List all WorkBuddy sessions: id/title/model/cwd/date span
        #[arg(long)]
        list: bool,
        /// The session_id to audit; default = the most recent session
        #[arg(long)]
        session: Option<String>,
        /// Write the audit JSON to FILE; use - for stdout
        #[arg(long = "json")]
        rows_json: Option<PathBuf>,
    },
    /// Inspect the spend budget alert (thresholds + current alert level).
    /// Since Phase 4.3 the read path is the SQL authority DB (same source as
    /// `budget-sql`); `budget show` is kept as the familiar entry point.
    /// Write actions (`set`/`snooze`/…) live under `budget-sql`.
    Budget {
        /// show — 只读告警态（读 SQL 权威库）
        #[arg(value_parser = ["show"])]
        action: String,
        /// Query a specific month (YYYY-MM) instead of the current one
        #[arg(long)]
        month: Option<String>,
        /// Print JSON to stdout instead of the human-readable report
        #[arg(long)]
        json: bool,
    },
    /// v0.9.1 Phase 3.4 SQL budget surface: explicit management API over the
    /// authority DB's `budget_config`/`budget_snoozes` (spec §5.3), replacing
    /// alert.json/budget.json reads. Amounts are CNY minor units (integer cents).
    /// `alert` computes the full budget alert from the authority DB (SQL
    /// equivalent of `budget show`), cross-harness metered CNY.
    BudgetSql {
        #[arg(value_parser = ["status", "profiles", "profile-set", "alert", "config-show", "config-set", "snooze-set", "snooze-clear"])]
        action: String,
        /// status/config-show: query this month (YYYY-MM) instead of the current one
        #[arg(long)]
        month: Option<String>,
        /// config-set: monthly budget in CNY minor (¥600.00 = 60000)
        #[arg(long)]
        monthly_cny_minor: Option<i64>,
        /// config-set: daily budget in CNY minor
        #[arg(long)]
        daily_cny_minor: Option<i64>,
        /// config-set: warning ratio in basis points (80% = 8000)
        #[arg(long)]
        warning_ratio_bp: Option<i64>,
        /// snooze-set: snooze until this ISO datetime (Beijing time, e.g. 2026-09-10T08:00:00)
        #[arg(long)]
        until: Option<String>,
        /// profile-set: estimate or confirmed
        #[arg(long)]
        profile: Option<String>,
        /// profile-set: explicit ISO-4217-like currency code (for example CNY or USD)
        #[arg(long)]
        currency: Option<String>,
        /// profile-set: monthly amount in the selected currency's minor unit
        #[arg(long)]
        profile_monthly_minor: Option<i64>,
        /// profile-set: optional daily amount in the selected currency's minor unit
        #[arg(long)]
        profile_daily_minor: Option<i64>,
        /// profile-set: warning ratio in basis points (80% = 8000)
        #[arg(long)]
        profile_warning_ratio_bp: Option<i64>,
    },
    /// Drive the Rust state write chain. R1c: the pure merge rules live in
    /// core::state (single source of truth), this subcommand is the I/O + time
    /// wiring; the differential in tests/test_cli_matrix.py drives it against
    /// Python state.py on an isolated AGENT_VITALS_HOME for byte-for-byte lockstep.
    /// This is also the surface the R1d tick calls instead of spawning python3.
    State {
        #[command(subcommand)]
        action: StateAction,
    },
    /// R2a SessionStore query surface (docs/R2A_CONTRACT_DESIGN.md §2-3): a
    /// versioned, in-memory read-only query model over normalized SessionReport
    /// envelopes. Stateless single call — populates from Codex sources on
    /// demand (Phase 1); DSH (zstd) is reported `source-unavailable`, never an
    /// empty page (§3.3).
    /// `sessions` — v0.10 read face over the SQL authority（spec §7）。
    Sessions {
        #[command(subcommand)]
        action: SessionsAction,
    },
    /// Probe runner for the Test tab (V17): L0 identity probes with three-tier
    /// verdicts, consent-gated credentials, interleaved paired runs.
    Probe {
        #[command(subcommand)]
        action: ProbeAction,
    },
    /// Passive route-quality report for the Test tab v2 (2026-09-20 pivot):
    /// aggregates RECORDED usage facts by harness × model family — actual model
    /// identity is hard evidence from protocol responses, no probe requests.
    RoutesQuality {
        /// Window length in days (default 90).
        #[arg(long, default_value_t = 90)]
        days: u32,
        /// Machine-readable JSON (the workbench face; plain text otherwise).
        #[arg(long)]
        json: bool,
    },
    /// Read-only Data Query API surface (v0.9 Stage 0.5, spec §7's suggested
    /// `data coverage`). Goes through the `SummaryRepository` trait to the
    /// runtime's repository — `SqlSummaryRepository` (reads the authority DB
    /// `agent-vitals.sqlite3`); the legacy `JsonSummaryRepository` was retired
    /// in Phase 4.3. The CLI only goes through the trait, never naming the
    /// concrete type past the call site (spec §3.1 dependency table). `--json`
    /// prints the frozen `to_json()` DTO verbatim; spec §3.1 makes it a
    /// contract violation to consume amounts while dropping
    /// freshness/coverage/excluded_harnesses, so both views surface all three.
    Data {
        #[command(subcommand)]
        action: DataAction,
    },
    /// Data MCP: local, stdio server over the SQL authority DB
    /// (docs/AGENT_VITALS_DATA_MCP_SPEC.md). Read operations are safe and
    /// typed; control-plane mutations are guarded by an explicit flag.
    DataMcp {
        #[command(subcommand)]
        action: DataMcpAction,
    },
}

#[derive(Subcommand)]
enum TrustAction {
    /// Scan a configured Trust artifact profile, write redacted local
    /// observations, and project supported Findings. `all` scans every valid
    /// built-in or locally configured profile.
    Audit {
        /// Profile id to scan, or all
        #[arg(long, default_value = "all")]
        harness: String,
        /// Print the report as JSON to stdout
        #[arg(long)]
        json: bool,
    },
    /// Read already persisted redacted Trust observations without scanning harnesses.
    Evidence {
        /// Optional profile id filter.
        #[arg(long)]
        harness: Option<String>,
        /// Maximum most-recent evidence rows (1..=500).
        #[arg(long, default_value_t = 200)]
        limit: usize,
        /// Opaque cursor returned by the previous page.
        #[arg(long)]
        cursor: Option<String>,
        /// Print the report as JSON.
        #[arg(long)]
        json: bool,
    },
    /// List valid local Trust profiles. This reports collection capability, not
    /// whether a product has performed any data transfer.
    Profiles {
        /// Print the report as JSON to stdout
        #[arg(long)]
        json: bool,
    },
    /// Discover installed local-agent directories without reading their
    /// contents. Unprofiled candidates are coverage gaps, never Findings.
    Discover {
        /// Print the report as JSON to stdout
        #[arg(long)]
        json: bool,
    },
    /// Capture one explicit, low-privilege local-process behavior snapshot.
    /// This is not a background watcher and cannot prove byte transmission.
    Monitor {
        #[command(subcommand)]
        action: TrustMonitorAction,
    },
}

#[derive(Subcommand)]
enum TrustMonitorAction {
    /// On supported platforms, correlate concurrent Git-history reads, archive
    /// writes, and established connections without reading their contents.
    Snapshot {
        /// Print the report as JSON to stdout
        #[arg(long)]
        json: bool,
    },
}

/// `data-mcp` sub-actions.
#[derive(Subcommand)]
enum DataMcpAction {
    /// Run the stdio MCP server (JSON-RPC 2.0, line-delimited). Blocks until
    /// stdin is closed, then exits 0.
    Serve {
        /// Enable typed local control-plane and Authority management writes in
        /// isolated/local use. Arbitrary SQL, raw source payloads, and generic
        /// filesystem writes remain unavailable.
        #[arg(long)]
        allow_local_writes: bool,
    },
}

// `data` 子命令的子动作。Stage 0 的 repository 只有 `monthly_summary`/
// `daily_summary` 两个查询（spec §3.1 的 `coverage_status(CoverageQuery)` 是
// Stage B 的独立查询面）——MonthlySummary DTO 本身承载 coverage/excluded_
// harnesses，所以月视图命令沿用 spec 建议名 `coverage`，不另设第二个命令去打印
// 同一份 DTO 的另一种排版。帮助文本一律英文（test_regressions 钉 `--help`
// 无 CJK——scanner-owned text 的纪律），中文设计注记只留在这里。
#[derive(Subcommand)]
enum DataAction {
    /// Monthly cross-harness summary (coverage, excluded harnesses, freshness).
    /// Missing data renders as "no data", never as zero.
    Coverage {
        /// Query a specific month (YYYY-MM) instead of the current statistics month
        #[arg(long)]
        month: Option<String>,
        /// Print the frozen DTO JSON to stdout (default: compact text view)
        #[arg(long)]
        json: bool,
    },
    /// Single-day cross-harness summary (statistics date, YYYY-MM-DD).
    Daily {
        /// Statistics date to query (YYYY-MM-DD)
        #[arg(long)]
        date: String,
        /// Print the frozen DTO JSON to stdout (default: compact text view)
        #[arg(long)]
        json: bool,
    },
    /// Audit provider attribution conservation on the SQL authority facts.
    ReplayProviderEvidence {
        /// Machine-readable audit report destination.
        #[arg(long, default_value = "artifacts/v0.11/provider-replay-report.json")]
        report: PathBuf,
    },
    /// Phase 4.2 (spec 6.1/6.3): the `sql_authority_enabled` switch. When set,
    /// the SQL authority DB is the sole runtime authority and legacy state-JSON
    /// writes (today/month/alert.json, claude ledger) are frozen — old files are
    /// kept but no longer updated. `enable` gates on authority-DB health
    /// (integrity ok, facts present, last sync run succeeded); `--force`
    /// overrides. `disable` returns to dual-write.
    Authority {
        #[arg(value_parser = ["status", "enable", "disable"])]
        action: String,
        /// enable: set the flag even if the authority DB is not healthy
        #[arg(long)]
        force: bool,
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
}

/// `sessions` 子命令的子动作（v0.9.1 SQL 权威库收口：list/read/navigation
/// 改走 `mcp::dispatch`，envelope 与 MCP `tools/call` 同源）。
///
/// - `List`：`mcp::sessions_search(date|month, harnesses?, hour?, min_tokens?, limit, cursor)`
///   —— 参数名与 MCP 输入 schema 一致；`--day` 与 `--month` 二选一。
/// - `Read`：`mcp::session_detail(session_ref, limit?, cursor?)` —— `session_ref`
///   是 MCP 返回的 HMAC（`sr_<32hex>`），不是原生 session key。
/// - `Findings`：先 `sync_facts`（行为 findings 由同步后的
///   `ingest::findings_eval` 对变更的 DSH / Codex 会话增量评估），再读权威库
///   issue 分组——与桌面 Findings 页同一数据源。W8 起 r2a_store 已删除。
/// - `Navigation`：今日 token 走 SQL 权威库（`authority_day_token_totals`，
///   与 r2a_store `sessions_navigation` 同源），`recent[]` 改成
///   `mcp::dispatch("sessions_search", {date, limit})`。
///
/// Probe runner for the Test tab (WORKBENCH_TEST_TAB_SPEC §6). P1: L0 identity
/// probes; verdicts come from domain::probe frozen rules.
#[derive(Subcommand)]
enum ProbeAction {
    /// Add a probe route profile (credentials are stored as REFERENCES only —
    /// 'env:VAR' or 'ccswitch:<provider-row>'; the secret itself never lands in the DB).
    /// With --from-cc-switch, batch-register every claude relay found in
    /// ~/.cc-switch (label/endpoint/model/credential-ref are discovered, not typed).
    RoutesAdd {
        /// Scan ~/.cc-switch and register every claude relay as a route
        /// (mutually exclusive with --label/--model/--route-id/--endpoint/--credential-ref).
        #[arg(long = "from-cc-switch")]
        from_cc_switch: bool,
        /// Stable route id (default: derived from label)
        #[arg(long)]
        route_id: Option<String>,
        #[arg(long)]
        label: Option<String>,
        /// claude-code | codex (P1 runs claude-code)
        #[arg(long, default_value = "claude-code")]
        harness_kind: String,
        /// Official direct connection uses the CLI's own login; a relay endpoint goes here.
        #[arg(long)]
        endpoint: Option<String>,
        /// Credential reference: 'env:VAR' or 'ccswitch:<provider-row>'
        #[arg(long = "credential-ref")]
        credential_ref: Option<String>,
        /// Model alias requested on this route (identity probe compares it to resolved).
        #[arg(long)]
        model: Option<String>,
    },
    /// List route profiles (with consent state).
    Routes {
        #[arg(long)]
        json: bool,
    },
    /// Show the CURRENT effective claude route (from ~/.claude/settings.json env,
    /// whitelisted: base_url + model only — credentials are never read). This is
    /// the default object of the tab's active test (spec §0 v1.2): test what the
    /// harness actually uses, no isolation injection.
    Current {
        #[arg(long)]
        json: bool,
    },
    /// Grant one-time consent for a route's credential to launch probe requests.
    Consent {
        #[arg(long)]
        route_id: String,
    },
    /// Run an L0 identity probe (single route, or paired A/B interleaved).
    /// --route-a current tests the CURRENT effective route (no isolation — the
    /// harness's own settings apply; the honest answer for cc-switch machines).
    Run {
        #[arg(long = "route-a")]
        route_a: String,
        #[arg(long = "route-b")]
        route_b: Option<String>,
        /// Model override for --route-a current (updates the current-route row;
        /// ignored for regular routes whose model comes from the profile).
        #[arg(long)]
        model: Option<String>,
        /// Repeats per route (paired mode interleaves A/B/A/B…)
        #[arg(long, default_value_t = 1)]
        repeats: usize,
        /// Hard cap on launched probes for this run (P1 budget semantics).
        #[arg(long = "max-probes", default_value_t = agent_vitals_probe::runner::DEFAULT_MAX_PROBES)]
        max_probes: usize,
        /// Explicit claude binary path (default: $AGENT_VITALS_CLAUDE_BIN or PATH).
        #[arg(long = "claude-bin")]
        claude_bin: Option<PathBuf>,
    },
    /// Show run status (job row; no results).
    Status {
        #[arg(long)]
        run_id: String,
    },
    /// Full report for a run: results + verdict with evidence chain.
    Report {
        #[arg(long)]
        run_id: String,
    },
}

#[derive(Subcommand)]
enum SessionsAction {
    /// List sessions active in a statistics-timezone day or month (optional hour drill-down,
    /// optional harness / min_tokens filter). Output envelope is byte-identical to
    /// the MCP `sessions_search` tool result.
    List {
        /// Statistics day YYYY-MM-DD (exactly one of --day / --month)
        #[arg(long)]
        day: Option<String>,
        /// Statistics month YYYY-MM (exactly one of --day / --month)
        #[arg(long)]
        month: Option<String>,
        /// Inclusive statistics start date for a custom range; pair with --to-date
        #[arg(long = "from-date")]
        date_from: Option<String>,
        /// Inclusive end date in the configured statistics timezone; pair with --from-date
        #[arg(long = "to-date")]
        date_to: Option<String>,
        /// Restrict to this local statistics hour (0..=23). Requires --day.
        #[arg(long)]
        hour: Option<u32>,
        /// Filter by harness kind (repeatable: `--harness-kind claude-code --harness-kind codex`)
        #[arg(long = "harness-kind", value_name = "HARNESS")]
        harness_kind: Vec<String>,
        /// Restrict to this exact model id
        #[arg(long)]
        model: Option<String>,
        /// Restrict to this exact provider id
        #[arg(long)]
        provider: Option<String>,
        /// Drop sessions whose window total is below this
        #[arg(long)]
        min_tokens: Option<i64>,
        /// Page size; default 50, max 500
        #[arg(long, default_value_t = 50)]
        page_size: usize,
        /// Opaque cursor from a previous page's `data.next_cursor`
        #[arg(long)]
        cursor: Option<String>,
        /// Result ordering: `tokens` (window total desc, default) or `oldest`
        /// (first event asc — the City loader pages oldest-first so a year-long
        /// window always reaches the earliest sessions within its load cap)
        #[arg(long, default_value = "tokens")]
        order: String,
        /// Print the envelope JSON to stdout
        #[arg(long)]
        json: bool,
    },
    /// Read ONE session timeline by `session_ref` (HMAC, from `sessions list`).
    /// Output envelope is byte-identical to the MCP `session_detail` tool result.
    Read {
        /// Opaque session_ref (sr_<32hex>) from `sessions list`
        #[arg(long = "session-ref")]
        session_ref: String,
        /// Timeline page size; default 200, max 1000
        #[arg(long, default_value_t = 200)]
        page_size: usize,
        /// Opaque cursor from a previous page's `data.next_cursor`
        #[arg(long)]
        cursor: Option<String>,
        /// Print the envelope JSON to stdout
        #[arg(long)]
        json: bool,
    },
    /// Sync, then list findings from the authority database (all history),
    /// grouped by rule. Behavior findings are evaluated during sync for changed
    /// DSH / Codex sessions; this is the same source the workbench Findings page reads.
    Findings {
        /// Print the grouped findings JSON to stdout
        #[arg(long)]
        json: bool,
    },
    /// Multi-harness navigation projection (today tokens + today session count +
    /// recent N deep-link rows per harness). The Tauri menu bar caches this envelope
    /// and only re-renders (§6 决策 3）；today_tokens 走 SQL 权威库，
    /// recent[] 走 `mcp::sessions_search`。
    Navigation {
        /// Day to project (YYYY-MM-DD in the configured statistics timezone). Defaults to today.
        #[arg(long, default_value = "")]
        day: String,
        /// Timezone of the projected day (valid IANA name; defaults to the configured/OS value).
        #[arg(long)]
        timezone: Option<String>,
        /// How many recent rows per harness; default 5
        #[arg(long, default_value_t = 5)]
        recent: usize,
        /// Print the envelope JSON to stdout
        #[arg(long)]
        json: bool,
    },
}

/// `state` 子命令的子动作 —— 一动作一入口，喂的都是**已算好**的 JSON
/// （hour-buckets / by_date_model / summary），CLI 只接线不重算，让差分测试能
/// 逐字节对账 Python 侧。
#[derive(Subcommand)]
enum StateAction {
    /// Write oneline.json (the tick's display summary; Python `state.write_oneline`)
    WriteOneline { summary: PathBuf },
    /// Append one summary row to sessions.jsonl (Python `state.append_session_history`)
    AppendHistory { summary: PathBuf },
    /// Session-level dedup fold (R1d §4.2/§4.3): fold a session's pre-computed
    /// navigation snapshot into oneline/sessions.jsonl exactly once.
    /// Fenced: refuses unless the writer-manifest owner is "rust" (run
    /// `state takeover rust` first, or pass --shadow to rehearse on a copy).
    FoldSession {
        /// fold-req JSON (session_id/harness_kind/machine_namespace/oneline).
        /// Any old business-ledger fields are ignored.
        req: PathBuf,
        /// Shadow mode: skip the owner check and fold into whatever
        /// AGENT_VITALS_HOME points at (non-authority rehearsal copy).
        #[arg(long)]
        shadow: bool,
    },
    /// Atomically switch the state writer (owner + epoch+1). This is the
    /// §4.2 cutover point: run `takeover rust` to let Rust produce, `takeover
    /// python` to roll back.
    Takeover {
        /// "rust" or "python"
        owner: String,
    },
    /// Print (creating if needed) the machine namespace — SessionKey's third
    /// component, persisted in machine.json (app-owned config, §4.3).
    MachineNamespace,
}

/// 探测「扫描器自身所在的 skill 目录」。
///
/// Python 版靠 `__file__` 就能定位自己；二进制形态下这条线断了 ——
/// 二进制装在 npm / cargo 的 bin 目录里，和 skill 目录没有任何关系。
///
/// **不能按内容判断**（比如认 `name: agent-vitals`）：那样任何 skill 改个名字
/// 就能让自己免于安全扫描。按**安装位置**判断才不可伪造 —— 只有当二进制确实
/// 被放在某个 skill 目录里面时（`<skill>/bin/agent-vitals` 这种形态），
/// 才认那个目录是自己。
///
/// 探测不到就**不排除任何东西**。宁可把自己也扫一遍（多几条 cited 命中），
/// 也不能给出一个可以被冒名顶替的豁免。
fn detect_self_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?;
    for _ in 0..3 {
        if dir.join("SKILL.md").is_file() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
    None
}

/// 报告 → 闸门 → 存档，返回退出码。
///
/// **顺序是有意的。**闸门结论要紧跟报告（读者刚看完发现），存档放最后
/// （它是副作用，不是结论）。存档失败不影响闸门的退出码 —— 一个写不了快照的
/// CI runner 不该因此把构建判成通过或失败。
fn run_doctor(
    doc: &Value,
    args: &Args,
    min: f64,
    auto_snapshot: bool,
    baseline: Option<&std::path::Path>,
) -> i32 {
    print!(
        "{}",
        skills::doctor::render_doctor(
            doc,
            &skills::doctor::DoctorOpts {
                split_threshold: args.split_threshold,
                min,
                version: env!("CARGO_PKG_VERSION"),
            }
        )
    );
    let ds = skills::doctor::diagnose(doc, args.split_threshold, min);

    let mut base_ds: Option<Vec<Value>> = None;
    if args.new_only {
        let path = match baseline {
            None => {
                eprintln!(
                    "--new-only needs a baseline: run `agent-vitals snapshot` first, \
or specify one with --baseline."
                );
                return skills::doctor::EXIT_TOOL_ERROR;
            }
            Some(p) => p,
        };
        let prev: Value = match util::read_lossy(path).and_then(|t| serde_json::from_str(&t).ok()) {
            None => {
                eprintln!("--new-only could not read baseline {}", path.display());
                return skills::doctor::EXIT_TOOL_ERROR;
            }
            Some(v) => v,
        };
        // **在基线文档上重跑同一个 diagnose。**它是纯函数，这一步不需要任何
        // 额外的「历史诊断」存储，也就不会与快照的内容脱节。
        base_ds = Some(skills::doctor::diagnose(&prev, args.split_threshold, min));
    }

    let ignore: Vec<String> = args
        .ignore
        .split(',')
        .map(|x| x.trim().to_uppercase())
        .filter(|x| !x.is_empty())
        .collect();
    let (text, rc) = skills::doctor::render_gate(
        &ds,
        &skills::doctor::GateOpts {
            fail_on: args.fail_on.clone(),
            ignore,
        },
        base_ds.as_deref(),
    );
    print!("{}", text);
    print!(
        "{}",
        agent_vitals_runtime::skills::snapshot::doctor_snapshot(doc, auto_snapshot)
    );
    rc
}

/// `codex-evidence` 的人读呈现——从 `codex_evidence_json` 输出的同一个 Value
/// 上读（形状唯一来源），Python 侧 `cli.py` 的 codex-evidence handler 逐字节
/// 对齐这一份。
fn render_codex_evidence(out: &Value) -> String {
    let dash = |v: Option<&Value>| match v {
        Some(Value::String(s)) => s.clone(),
        Some(_) => "—".to_string(),
        None => "—".to_string(),
    };
    let roots: String = out
        .get("workspace_roots")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|r| r.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "—".to_string());
    let signals: Vec<&str> = out
        .get("signals")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str()).collect())
        .unwrap_or_default();

    let mut s = String::new();
    s.push_str(&format!(
        "harness: {}\n",
        dash(Some(&Value::String("codex".into())))
    ));
    s.push_str(&format!("session: {}\n", dash(out.get("session_id"))));
    s.push_str(&format!("title: {}\n", dash(out.get("title"))));
    s.push_str(&format!(
        "history_mode: {}\n",
        dash(out.get("history_mode"))
    ));
    s.push_str(&format!("cli_version: {}\n", dash(out.get("cli_version"))));
    s.push_str(&format!("model: {}\n", dash(out.get("model"))));
    s.push_str(&format!("workspace_roots: {roots}\n"));
    s.push_str(&format!("signals: {}\n", signals.join(", ")));
    s.push('\n');
    // 逐条列出「有覆盖」的信号（也就是 signals 数组里的那些）——19 个全零的
    // unavailable 信号不在人读视图里制造噪音，JSON 里才是全量。
    if let Some(cov) = out.get("coverage").and_then(|v| v.as_object()) {
        for name in &signals {
            if let Some(c) = cov.get(*name) {
                let (m, d, l, u) = (
                    c.get("measured").and_then(|v| v.as_u64()).unwrap_or(0),
                    c.get("derived").and_then(|v| v.as_u64()).unwrap_or(0),
                    c.get("lossy").and_then(|v| v.as_u64()).unwrap_or(0),
                    c.get("unmetered").and_then(|v| v.as_u64()).unwrap_or(0),
                );
                s.push_str(&format!(
                    "  {name:<20} measured={m} derived={d} lossy={l} unmetered={u}\n"
                ));
            }
        }
    }
    s.push('\n');
    s.push_str(&format!(
        "attempts: {}    notes: {}\n",
        out.get("attempts")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0),
        out.get("notes")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0),
    ));
    s
}

/// `codex-evidence --roots` 的人读呈现——从 `codex_session_roots_report` 的
/// 同一个 Value 上读（形状唯一来源），Python 侧 `cli.py::_render_codex_roots`
/// 逐字节对齐这一份。缺席的根不猜路径也不报错，只标 `(absent)`。
fn render_codex_roots(out: &Value) -> String {
    let mut s = String::from("harness: codex\n");
    if let Some(roots) = out.get("roots").and_then(|v| v.as_array()) {
        for entry in roots {
            let (Some(kind), Some(path)) = (
                entry.get("kind").and_then(|v| v.as_str()),
                entry.get("path").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            if entry
                .get("exists")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let fc = entry
                    .get("file_count")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let tb = entry
                    .get("total_bytes")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                s.push_str(&format!("{kind:<8} {path}  ({fc} rollouts, {tb} bytes)\n"));
            } else {
                s.push_str(&format!("{kind:<8} {path}  (absent)\n"));
            }
        }
    }
    s
}

/// `agent-vitals plan` 的人读呈现 —— 从 `build_plan` 的同一个 Value 上读
/// （形状唯一来源），Python 侧 `cli.py::_render_plan_human` 逐字节对齐这一份。
/// 渲染只做呈现：null 一律落 `—`（没测到就标没测到，不假装 0），summary 不汇总
/// token（per-startup 与 per-trigger 单位不可通约）。
fn render_plan(out: &Value) -> String {
    let harness = out
        .get("harness_selection")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let startup = out.get("startup_rate_per_month").and_then(|v| v.as_i64());
    let refs: Vec<&str> = out
        .get("diagnosis_refs")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    let summary = out.get("summary").unwrap_or(&Value::Null);
    let n = summary
        .get("item_count")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let savings = summary
        .get("savings_items")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let mut s = String::new();
    s.push_str(&format!("harness: {harness}\n"));
    match startup {
        Some(x) => s.push_str(&format!("startup rate per month: {x}\n")),
        None => s.push_str("startup rate per month: —\n"),
    }
    if refs.is_empty() {
        s.push_str("diagnosis refs: (none)\n");
    } else {
        s.push_str(&format!("diagnosis refs: {}\n", refs.join(", ")));
    }
    s.push('\n');
    s.push_str(&format!("{n} items · {savings} with measured savings\n\n"));
    if let Some(items) = out.get("items").and_then(|v| v.as_array()) {
        for (i, it) in items.iter().enumerate() {
            let id = it.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let skill = it.get("skill").and_then(|v| v.as_str()).unwrap_or("");
            let risk = it.get("risk").and_then(|v| v.as_str()).unwrap_or("");
            s.push_str(&format!("{}. {id}  {skill}  [{risk}]\n", i + 1));
            match it.get("savings_per_event") {
                Some(Value::Object(o)) => {
                    let tokens = o.get("tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                    let per = o.get("per").and_then(|v| v.as_str()).unwrap_or("");
                    s.push_str(&format!("   savings: {tokens} tokens per {per}\n"));
                }
                _ => s.push_str("   savings: none measured\n"),
            }
            match it.get("events_per_month") {
                Some(v) if !v.is_null() => s.push_str(&format!("   events per month: {v}\n")),
                _ => s.push_str("   events per month: —\n"),
            }
            match it.get("measured_lifetime_triggers") {
                Some(v) if !v.is_null() => {
                    s.push_str(&format!("   lifetime triggers measured: {v}\n"));
                }
                _ => s.push_str("   lifetime triggers measured: —\n"),
            }
            let drefs: Vec<&str> = it
                .get("diagnosis_refs")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
                .unwrap_or_default();
            if drefs.is_empty() {
                s.push_str("   diagnosis: (none)\n");
            } else {
                s.push_str(&format!("   diagnosis: {}\n", drefs.join(", ")));
            }
            let rationale = it.get("rationale").and_then(|v| v.as_str()).unwrap_or("");
            s.push_str(&format!("   {rationale}\n\n"));
        }
    }
    s
}

/// `codex-fold → 计价` 共享助手：从已折叠合并的 fold 出一个 `--json` 报告 dict
/// （harness/currency/month/today 外层包装 + report 键）。filter_key=None 不过滤
/// （all 视图）；want_hours=True 时报告带 hours（today 视图小时热力图）。空折叠
/// 给全零结构而不是 None——调用方要的是「没有数据」而不是「崩了」，且包装是
/// 固定契约（unaccounted/plan 透传，无时间归属、不随月过滤）。与 Python
/// `cli.py::codex_report_from_merged` 同构（差分看守字节一致）。
fn codex_report_from_merged(
    merged: &Value,
    filter_key: Option<&str>,
    month_out: Option<&str>,
    want_hours: bool,
) -> Value {
    let mut by_hour_model = merged["by_hour_model"].clone();
    let mut by_model = merged["by_model"].clone();
    if let Some(m) = filter_key {
        // 过滤小时轴（升序 -> 保持升序），再重算 by_model。小时键 `YYYY-MM-DDTHH`
        // 用 startswith 匹配：月份前缀 `YYYY-MM` / 今天 `YYYY-MM-DD` 都成立。
        let mut filtered = serde_json::Map::new();
        if let Some(bh) = by_hour_model.as_object() {
            for (h, v) in bh {
                if h.starts_with(m) {
                    filtered.insert(h.clone(), v.clone());
                }
            }
        }
        by_hour_model = Value::Object(filtered);
        // 重算模型轴：merge 的 by_model 只读 fold 的 by_model 字段，不读
        // by_hour_model——拿 merge 折回去得到的是空模型轴（真实 defect：
        // --month 整份报告静默变全零）。
        by_model = agent_vitals_harnesses::codex_usage::codex_by_model_from_hours(&by_hour_model, None);
    }
    let pricing = agent_vitals_runtime::sessions::codex_cost::load_codex_pricing();
    let plan = merged["plan"].clone();
    let report = agent_vitals_runtime::sessions::codex_cost::codex_cost_report(
        &by_hour_model,
        &by_model,
        &merged["unaccounted"],
        &plan,
        &pricing,
        want_hours,
    );
    let report = report.unwrap_or_else(|| {
        // 空折叠：全零结构（同 handler 注释——透传 unaccounted/plan）。
        let mut tt = serde_json::Map::new();
        for f in agent_vitals_harnesses::codex_usage::CODEX_TOKEN_FIELDS {
            tt.insert(f.to_string(), json!(0));
        }
        let mut base = serde_json::Map::new();
        base.insert("total_cost_usd".into(), json!(0));
        base.insert("total_tokens".into(), Value::Object(tt));
        base.insert("per_model".into(), Value::Object(serde_json::Map::new()));
        base.insert("days".into(), Value::Array(vec![]));
        base.insert("unpriced_tokens".into(), json!(0));
        base.insert("unaccounted_usage".into(), merged["unaccounted"].clone());
        base.insert("plan".into(), plan);
        if want_hours {
            base.insert("hours".into(), Value::Array(vec![]));
        }
        Value::Object(base)
    });
    let mut out = serde_json::Map::new();
    out.insert("harness".into(), json!("codex"));
    out.insert("currency".into(), json!("USD"));
    out.insert(
        "month".into(),
        month_out.map(Value::from).unwrap_or(Value::Null),
    );
    out.insert(
        "today".into(),
        json!(agent_vitals_runtime::sessions::codex_cost::today_beijing()),
    );
    if let Some(rep) = report.as_object() {
        for (k, v) in rep {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// 统一看板内联的 codex 规范单块（docs/UNIFIED_COST_VIEW.md 的 1 号执行环境契约）：
/// {harness, currency, today, default, views:{today,month,all}}。每个 view 即
/// `codex_report_from_merged` 的一个报告。today 视图 want_hours=True；month
/// 视图用调用方给的 month_key/month_out；all 视图不过滤。与 Python
/// `cli.py::codex_calendar_blob` 同构。
fn codex_calendar_blob(
    merged: &Value,
    month_key: Option<&str>,
    month_out: Option<&str>,
    default: &str,
) -> Value {
    let today = agent_vitals_runtime::sessions::codex_cost::today_beijing();
    let mut views = serde_json::Map::new();
    views.insert(
        "today".into(),
        codex_report_from_merged(merged, Some(&today), Some(&today[..7]), true),
    );
    views.insert(
        "month".into(),
        codex_report_from_merged(merged, month_key, month_out, false),
    );
    views.insert(
        "all".into(),
        codex_report_from_merged(merged, None, None, false),
    );
    let mut blob = serde_json::Map::new();
    blob.insert("harness".into(), json!("codex"));
    blob.insert("currency".into(), json!("USD"));
    blob.insert("today".into(), json!(today));
    blob.insert("default".into(), json!(default));
    blob.insert("views".into(), Value::Object(views));
    Value::Object(blob)
}

/// `codex-cost --html`：复用统一看板模板 calendar.html（退役独立 codex_cost.html，
/// 一套视觉模板，见 docs/UNIFIED_COST_VIEW.md）。只内联 codex 规范单块 +
/// `AGENT_VITALS_DEFAULT_HARNESS='codex'`（codex 视角的看板，不内联 DSH 块）。
/// JSON 经 `</script`/`<!--` 转义。与 Python `cli.py::_render_codex_cost_html`
/// 同构（HTML 文件不参与差分，只需等价可解析的页面）。
fn render_codex_cost_html(
    output_path: &Path,
    merged: &Value,
    month_key: Option<&str>,
    month_out: Option<&str>,
    default: &str,
) {
    const TEMPLATE: &str = include_str!("../../../assets/templates/calendar.html");
    let blob = codex_calendar_blob(merged, month_key, month_out, default);
    let json_text = serde_json::to_string(&blob).unwrap_or_default();
    let safe = json_text
        .replace("</script", "<\\/script")
        .replace("<!--", "<\\!--");
    let inject =
        format!("<script id=\"agent-vitals-data-codex\" type=\"application/json\">{safe}</script>");
    let harness_inject = "<script>window.AGENT_VITALS_DEFAULT_HARNESS = 'codex';</script>";
    let html = TEMPLATE
        .replacen("</head>", &format!("{inject}\n</head>"), 1)
        .replacen("</head>", &format!("{harness_inject}\n</head>"), 1);
    if let Some(parent) = output_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(output_path, html).is_err() {
        eprintln!("failed to write {}", output_path.display());
        std::process::exit(2);
    }
}

/// v0.9 Stage 0.5 的 Data 面文本视图（`data coverage` / `data daily` 的默认
/// 输出）。呈现是 CLI 的职责（spec §3.1：data 层不做 UI 呈现），但诚实规则
/// 与 DTO 同源：Unavailable → "no data"，绝不渲染 0（0.6 纪律提前落到 CLI
/// 面）；金额一律带 basis 标签——estimate/api_equivalent 不冒充真实账单
/// （spec §4）。不标货币符号：Stage 0 DTO 刻意不带 currency 字段（§8.4/0.4c
/// 的决定：口径字段承载语义，混币永不相加），文本视图不重新发明。
fn amount_parts(h: &agent_vitals_data::projection::HarnessAmount) -> Vec<String> {
    let mut parts: Vec<String> = h
        .amounts_by_basis
        .iter()
        .map(|(b, v)| format!("{}={:.2}", b.as_str(), v))
        .collect();
    if parts.is_empty() {
        // 有观测、无钱（全 unknown 日）——不是 0，也不是账单（Unresolved
        // 不得归零，见 summary.rs::claude_harness_amount）。
        parts.push("no priceable amount (unresolved)".to_string());
    }
    if h.has_unresolved {
        parts.push("has unresolved tokens".to_string());
    }
    parts
}

fn freshness_tag(h: &agent_vitals_data::projection::HarnessAmount) -> String {
    use agent_vitals_data::projection::FreshnessState;
    let last = h.freshness.last_observed_at.as_deref().unwrap_or("-");
    match h.freshness.state {
        FreshnessState::Fresh => format!("fresh ({last})"),
        FreshnessState::Stale => format!("stale ({last})"),
        FreshnessState::Partial => format!("partial ({last})"),
        // "Unavailable 不能带 last_observed_at"（domain 不变式 3）——防御性
        // 保留 last 位，但状态词本身已经说明没有观测。
        FreshnessState::Unavailable => "no data (unavailable)".to_string(),
    }
}

fn print_monthly_summary_text(s: &agent_vitals_data::projection::MonthlySummary) {
    println!("month {}", s.month);
    for (name, h) in &s.by_harness {
        let amounts = amount_parts(h).join("  ");
        if h.freshness.state == agent_vitals_data::projection::FreshnessState::Unavailable {
            println!("  {name:<12} {}", freshness_tag(h));
        } else {
            println!("  {name:<12} {amounts}");
            println!("  {:<12} {}", "", freshness_tag(h));
        }
    }
    println!(
        "coverage {}/{} (denominator v{})",
        s.coverage.measured_fields, s.coverage.total_fields, s.coverage.denominator_version
    );
    let excluded: Vec<&str> = s.excluded_harnesses.iter().map(|x| x.as_str()).collect();
    if excluded.is_empty() {
        println!("excluded harnesses: (none)");
    } else {
        println!("excluded harnesses: {}", excluded.join(", "));
    }
    println!(
        "summable total: {:.2} (estimates/diagnostics excluded, see per-harness basis)",
        s.total_summable()
    );
}

fn print_daily_summary_text(s: &agent_vitals_data::projection::DailySummary) {
    println!("date {}", s.date);
    for (name, h) in &s.by_harness {
        let amounts = amount_parts(h).join("  ");
        if h.freshness.state == agent_vitals_data::projection::FreshnessState::Unavailable {
            println!("  {name:<12} {}", freshness_tag(h));
        } else {
            println!("  {name:<12} {amounts}");
            println!("  {:<12} {}", "", freshness_tag(h));
        }
    }
    println!(
        "coverage {}/{} (denominator v{})",
        s.coverage.measured_fields, s.coverage.total_fields, s.coverage.denominator_version
    );
    let excluded: Vec<&str> = s.excluded_harnesses.iter().map(|x| x.as_str()).collect();
    if excluded.is_empty() {
        println!("excluded harnesses: (none)");
    } else {
        println!("excluded harnesses: {}", excluded.join(", "));
    }
    println!(
        "summable total: {:.2} (estimates/diagnostics excluded, see per-harness basis)",
        s.total_summable()
    );
}

fn cli_build_info() -> Value {
    json!({
        "cli_version": env!("CARGO_PKG_VERSION"),
        "authority_schema": agent_vitals_data::authority::SCHEMA_VERSION,
    })
}

/// `sessions findings` 的读取面：**全部历史**的 issue 组。不套桌面 Findings 页的
/// 30 天窗——r2a 时代这条命令就汇总所有会话，issue 的 `opened_at_ms` 又取
/// finding 发生时刻，套窗会让老会话的发现凭空消失（fixture 测试抓到）。JSON 原样
/// 给 `issue_groups_with_sources` 的投影并加版本号；人读输出只给规则级汇总。
fn print_findings(data_home: &Path, json_out: bool) {
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    let db = match agent_vitals_data::authority::AuthorityDb::open_readonly(&path) {
        Ok(db) => db,
        Err(error) => {
            eprintln!("authority database unavailable at {}: {error}", path.display());
            std::process::exit(2);
        }
    };
    let raw = match agent_vitals_data::issues::issue_groups_with_sources(db.conn(), None, None, usize::MAX, None) {
        Ok(raw) => raw,
        Err(error) => {
            eprintln!("findings query failed: {error}");
            std::process::exit(2);
        }
    };
    if json_out {
        let mut dto = serde_json::Map::new();
        dto.insert("schema_version".into(), Value::String("agent-vitals-findings/v2".into()));
        if let Value::Object(fields) = raw {
            dto.extend(fields);
        }
        println!("{}", serde_json::to_string_pretty(&Value::Object(dto)).unwrap_or_default());
        return;
    }
    println!(
        "findings: {} group(s) · critical {} · warning {} · info {}",
        raw["total_groups"].as_u64().unwrap_or(0),
        raw["summary_critical"].as_u64().unwrap_or(0),
        raw["summary_warning"].as_u64().unwrap_or(0),
        raw["summary_info"].as_u64().unwrap_or(0),
    );
    for rule in raw["summary_rules"].as_array().into_iter().flatten() {
        println!(
            "  {:<10} {:<9} {:<9} hits {:>5}  sessions {:>4}",
            rule["rule"].as_str().unwrap_or(""),
            rule["severity"].as_str().unwrap_or(""),
            rule["category"].as_str().unwrap_or(""),
            rule["hits"].as_u64().unwrap_or(0),
            rule["sessions"].as_u64().unwrap_or(0),
        );
    }
}

fn main() {
    let args = Args::parse();
    if args.build_info {
        println!("{}", serde_json::to_string(&cli_build_info()).unwrap_or_default());
        return;
    }
    // 统计时区偏好必须在任何 SQLite localtime 查询前应用；缺失配置继续使用 OS 时区。
    if let Err(error) = agent_vitals_runtime::statistics_timezone::apply(
        &agent_vitals_runtime::home::data_home(),
    ) {
        eprintln!("statistics timezone unavailable: {error}");
        std::process::exit(2);
    }
    // Data MCP：本机 stdio server，永不返回（stdin EOF → exit 0）。在扫描
    // 之前短路——它不碰 skill 扫描，只对 SQL 权威库做只读查询。
    if let Some(Cmd::DataMcp { action }) = &args.cmd {
        match action {
            DataMcpAction::Serve { allow_local_writes } => mcp::serve(*allow_local_writes),
        }
    }

    // Trust historical audit is a deliberately separate, local-only writer.
    // It runs before generic skill scanning: a user asking for this diagnostic
    // must not also trigger unrelated harness/file scans.
    if let Some(Cmd::Trust { action }) = &args.cmd {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            eprintln!("trust: HOME is unavailable");
            std::process::exit(2);
        };
        let data_home = agent_vitals_runtime::home::data_home();
        let (profiles, profile_errors) = agent_vitals_runtime::trust_audit::profiles(&data_home, &home);
        match action {
            TrustAction::Audit { harness, json } => {
                let targets: Vec<_> = if harness == "all" {
                    profiles.iter().collect()
                } else {
                    profiles.iter().filter(|profile| profile.id() == harness).collect()
                };
                if targets.is_empty() {
                    eprintln!("trust audit: no valid profile `{harness}`; run `agent-vitals trust profiles`");
                    std::process::exit(2);
                }
                let machine_namespace = agent_vitals_runtime::takeover::machine_namespace();
                let now_ms = agent_vitals_runtime::sql_sync::now_ms();
                let reports = targets.into_iter().map(|target| {
                    agent_vitals_runtime::trust_audit::audit_and_store(
                        &data_home, target, &machine_namespace, now_ms,
                    )
                }).collect::<Result<Vec<_>, _>>();
                match reports {
                    Ok(reports) if *json => println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                        "reports": reports, "profile_errors": profile_errors,
                    })).unwrap_or_default()),
                    Ok(reports) => for report in reports {
                        println!("{}: {} artifacts ({} new, {} duplicate), {} findings", report.harness, report.discovered, report.inserted, report.duplicate, report.findings_upserted);
                    },
                    Err(error) => { eprintln!("trust audit failed: {error}"); std::process::exit(2); }
                }
                return;
            }
            TrustAction::Evidence { harness, limit, cursor, json } => {
                match agent_vitals_runtime::trust::trust_audit::read_evidence_history(&data_home, harness.as_deref(), *limit, cursor.as_deref()) {
                    Ok(page) => {
                        let count = page.evidence.len();
                        let payload = serde_json::json!({ "harness": harness, "evidence": page.evidence, "count": count, "next_cursor": page.next_cursor, "source": "authority_readonly" });
                        if *json { println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default()); }
                        else { println!("{} persisted evidence rows", count); }
                    }
                    Err(error) => { eprintln!("trust evidence read failed: {error}"); std::process::exit(2); }
                }
                return;
            }
            TrustAction::Profiles { json } => {
                let payload = serde_json::json!({
                    "profiles": agent_vitals_runtime::trust_audit::profile_summaries(&profiles),
                    "profile_errors": profile_errors,
                });
                if *json { println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default()); }
                else {
                    for profile in payload["profiles"].as_array().into_iter().flatten() {
                        println!("{}: {} ({})", profile["id"].as_str().unwrap_or("?"), profile["capability"].as_str().unwrap_or("?"), profile["source"].as_str().unwrap_or("?"));
                    }
                    for error in payload["profile_errors"].as_array().into_iter().flatten().filter_map(|item| item.as_str()) {
                        eprintln!("trust profile warning: {error}");
                    }
                }
                return;
            }
            TrustAction::Discover { json } => {
                let candidates = agent_vitals_runtime::trust_audit::discover_harness_candidates(&home, &profiles);
                let payload = serde_json::json!({"candidates": candidates, "profile_errors": profile_errors});
                if *json { println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default()); }
                else {
                    for candidate in payload["candidates"].as_array().into_iter().flatten() {
                        println!("{}: {}", candidate["id"].as_str().unwrap_or("?"), candidate["coverage_state"].as_str().unwrap_or("?"));
                    }
                }
                return;
            }
            TrustAction::Monitor { action } => match action {
                TrustMonitorAction::Snapshot { json } => {
                    let report = agent_vitals_runtime::trust_runtime_monitor::snapshot_and_store(
                        &data_home, &agent_vitals_runtime::takeover::machine_namespace(),
                        agent_vitals_runtime::sql_sync::now_ms(),
                    );
                    match report {
                        Ok(report) if *json => println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default()),
                        Ok(report) => println!("runtime monitor: {} candidate processes, {} observations ({})", report.candidate_processes, report.observations, report.capability),
                        Err(error) => { eprintln!("trust monitor failed: {error}"); std::process::exit(2); }
                    }
                    return;
                }
            },
        }
    }

    // 行为审计：审计一份 DSH 会话日志的执行轨迹，**不跑 skill 扫描**。
    // 独立取证命令（读会话日志 → 规则引擎 → findings），在扫描之前短路。
    if let Some(Cmd::Behavior {
        session_log,
        rows_json,
    }) = &args.cmd
    {
        if let Some(path) = rows_json {
            // `--json` 的 20 键载荷在 behavior.rs::audit_payload（唯一来源）——
            // DSH SessionReport 的 session 载荷就是它，键序逐字节对齐 Python。
            let Some(payload) =
                agent_vitals_runtime::sessions::behavior::audit_payload(session_log)
            else {
                eprintln!("session log unavailable: unreadable, malformed, or schema mismatch");
                std::process::exit(2);
            };
            let findings_len = payload
                .get("findings")
                .and_then(|v| v.as_array())
                .map_or(0, |a| a.len());
            let text = serde_json::to_string_pretty(&payload).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}: {} findings", path.display(), findings_len);
            }
            return;
        }
        let Some(audit) = agent_vitals_runtime::sessions::behavior::audit_session_log(session_log)
        else {
            eprintln!("session log unavailable: unreadable, malformed, or schema mismatch");
            std::process::exit(2);
        };
        let findings = &audit.findings;
        for f in findings {
            let sev = f.get("severity").and_then(|v| v.as_str()).unwrap_or("");
            let glyph = match sev {
                "critical" => "✕",
                "warning" => "⚠",
                _ => "·",
            };
            let rule = f.get("rule").and_then(|v| v.as_str()).unwrap_or("");
            let cat = f.get("category").and_then(|v| v.as_str()).unwrap_or("");
            let ev = f.get("evidence").and_then(|v| v.as_str()).unwrap_or("");
            let seq_s = f
                .get("seq")
                .and_then(|v| v.as_i64())
                .map(|n| n.to_string())
                .unwrap_or_else(|| "None".to_string());
            println!("{glyph} {rule} {cat} {ev} (seq {seq_s})");
        }
        // 成本块：findings 之后空行 + 费用估算（纯展示层，见 cost.rs）。无
        // 可分桶的桶时 cost_block 返回空列表 → 不打印（与 tab 空态同构）。
        let pricing = agent::cost::load_pricing();
        let block = agent::cost::cost_block(&audit.usage, &pricing);
        if !block.is_empty() {
            println!();
            for line in &block {
                println!("{line}");
            }
        }
        // 闸门与 doctor 同一套 --fail-on/--ignore 语义（无 --new-only，见
        // behavior_gate 的 docstring）。此前硬编码「有 critical 就退 1」，把
        // --fail-on warning / --ignore SV603 这类全局参数静默吞掉了。成本不
        // 影响退出码——闸门只看风险。
        std::process::exit(agent_vitals_runtime::sessions::behavior::behavior_gate(
            findings,
            &args.fail_on,
            &args.ignore,
        ));
    }

    // R1d-tick：oneline 生产者——把一份 DSH 会话日志折成导航摘要，并在 ledger
    // 记 key。业务账仅由 SQL authority 提供。在扫描之前短路（与 behavior 同款），
    // fencing/审计失败 exit 2 不落盘；dedup 命中则正常退出（无输出以外副作用）。
    if let Some(Cmd::Oneline {
        session_log,
        session_id,
        no_merge,
        shadow,
    }) = &args.cmd
    {
        match agent::oneline::oneline(session_log, session_id.as_deref(), *no_merge, *shadow) {
            Ok(_) => return,
            Err(msg) => {
                eprintln!("{msg}");
                std::process::exit(2);
            }
        }
    }

    // v0.6 harness-contract spec §5.1/§11-M0: print the core HarnessProfile registry
    // as-is. `harnesses_json()` is the byte-parity surface Python's
    // `harness_capability.harnesses_json()` mirrors (G1).
    if let Some(Cmd::Harnesses { rows_json }) = &args.cmd {
        let out = agent_vitals_domain::harness_capability::harnesses_json();
        if let Some(path) = rows_json {
            let text = serde_json::to_string_pretty(&out).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}", path.display());
            }
        } else {
            for h in out["harnesses"].as_array().cloned().unwrap_or_default() {
                let id = h["id"].as_str().unwrap_or("?");
                let display = h["display"].as_str().unwrap_or("?");
                let unmeasured = h["unmeasured_signals"]
                    .as_array()
                    .map(|a| a.len())
                    .unwrap_or(0);
                let degraded = h["degraded_rules"].as_array().map(|a| a.len()).unwrap_or(0);
                let store = h["session_store"].as_bool().unwrap_or(false);
                let fold = h["fold"].as_str().unwrap_or("none");
                println!(
                    "{id} ({display}): unmeasured={unmeasured} degraded_rules={degraded} \
session_store={store} fold={fold}"
                );
            }
        }
        return;
    }

    // R1d-tick：discover——列 DSH 会话根下未折的裸 session.jsonl（mtime 最新在前）。
    // 只读：不碰 fencing、不写 state；tick 与验收测试都从这里拿「折哪条」。
    if let Some(Cmd::Discover { rows_json }) = &args.cmd {
        let report = agent_vitals_runtime::sessions::discovery::discover();
        let text = serde_json::to_string_pretty(&report).unwrap_or_default();
        if let Some(path) = rows_json {
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            }
        } else {
            println!("{text}");
        }
        return;
    }

    // T11：Skill 执行审计——从会话日志抽取 skill-invocation / tool/call(name=skill) 事件，
    // 输出调用记录（触发方式/加载状态/耗时/位置）。与 behavior 不同：这是 skill 专用，
    // 只出 skill 相关的 invocations 结构，不带 SV601–614 findings。
    if let Some(Cmd::SkillAudit {
        session_log,
        rows_json,
    }) = &args.cmd
    {
        let Some(audit) = agent_vitals_runtime::sessions::behavior::audit_session_log(session_log)
        else {
            eprintln!("session log unavailable: unreadable, malformed, or schema mismatch");
            std::process::exit(2);
        };
        let skill = &audit.skill;
        if let Some(path) = rows_json {
            let text = serde_json::to_string_pretty(skill).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                let inv_count = skill.as_array().map(|a| a.len()).unwrap_or(0);
                println!("Wrote {}: {} skill invocations", path.display(), inv_count);
            }
            return;
        }
        // 人读格式：按触发方式和加载状态分组统计
        let invs = skill.as_array().cloned().unwrap_or_default();
        if invs.is_empty() {
            println!("No skill invocations found in session log.");
            return;
        }
        let mut by_mode = std::collections::HashMap::new();
        let mut by_status = std::collections::HashMap::new();
        for inv in &invs {
            let m = inv
                .get("trigger_mode")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let s = inv
                .get("load_status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            *by_mode.entry(m).or_insert(0) += 1;
            *by_status.entry(s).or_insert(0) += 1;
        }
        println!("Skill invocations: {} total", invs.len());
        for (m, n) in &by_mode {
            println!("  {}: {}", m, n);
        }
        for (s, n) in &by_status {
            println!("  {}: {}", s, n);
        }
        return;
    }

    // v0.10.0 的公开下钻入口：只收 sessions_search 给出的 opaque session_ref。
    // 它直接复用 runtime MCP dispatcher，因此 SQL facts、价卡成本、canonical
    // evidence 与桌面端/MCP 完全同源；绝不把 caller-supplied path 送进公开接口。
    if let Some(Cmd::TraceAnchors { session_ref }) = &args.cmd {
        // 本地呈现层专属（V16 spec §5）：锚点坐标 + 摘录。绝不走 mcp dispatch
        // ——那是 agent 消费面，锚点=「去哪找原文」的地图不出那个面。
        let data_home = agent_vitals_runtime::home::data_home();
        let salt = match agent_vitals_runtime::mcp::session_ref::load_or_create_salt(&data_home) {
            Ok(salt) => salt,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        };
        let db_path = agent_vitals_data::authority::default_authority_path(&data_home);
        if !db_path.exists() {
            eprintln!("authority database not found at {}", db_path.display());
            std::process::exit(2);
        }
        let db = match agent_vitals_data::authority::AuthorityDb::open_readonly(&db_path) {
            Ok(db) => db,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        };
        let candidates: Vec<String> = {
            let mut stmt = match db.conn().prepare("SELECT session_key FROM sessions") {
                Ok(stmt) => stmt,
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(2);
                }
            };
            let rows = match stmt.query_map([], |row| row.get::<_, String>(0)) {
                Ok(rows) => rows,
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(2);
                }
            };
            rows.filter_map(Result::ok).collect()
        };
        let Some(session_key) =
            agent_vitals_runtime::mcp::session_ref::resolve(&salt, session_ref, candidates)
        else {
            eprintln!("session_ref did not match any session on this machine");
            std::process::exit(2);
        };
        match agent_vitals_runtime::trace_service::session_anchor_report(db.conn(), &session_key) {
            Ok(report) => {
                println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
        return;
    }
    if let Some(Cmd::TraceRef { session_ref, rows_json, timeline_series }) = &args.cmd {
        let output = if *timeline_series { "timeline_series" } else { "graph" };
        let data_home = agent_vitals_runtime::home::data_home();
        let envelope = match agent_vitals_runtime::mcp::dispatch(
            "session_trace",
            &json!({"session_ref": session_ref, "output": output}),
            &data_home,
        ) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        };
        let Some(data) = envelope.get("data") else {
            eprintln!("session_trace returned an invalid envelope");
            std::process::exit(2);
        };
        let text = serde_json::to_string_pretty(data).unwrap_or_default();
        if let Some(path) = rows_json {
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}", path.display());
            }
        } else {
            println!("{text}");
        }
        return;
    }

    // `trace <file>` 保留为本地诊断入口：它允许直接检查尚未进入 authority 的
    // 文件，因此不承诺 SQL metrics parity；产品下钻请用上面的 `trace-ref`。
    // v0.10.0：TraceGraph 子命令——只读诊断，spec §7 v0.10.0 门槛 1/2/6 的 CLI 面。
    // `machine_namespace` 与 {claude,codex,dsh}-usage-facts 同一条纪律：CLI 不
    // 发明身份段（缺失 exit 2），fact_id/图 id 的重放稳定性靠调用方显式给值。
    // memo 层（trace_service）在这里不启用：子命令是一次性进程，进程级 memo
    // 没有第二次命中机会——缓存住进图里反而是纯开销。memo 是给常驻消费面
    // （Tauri / MCP server）用的。
    if let Some(Cmd::Trace {
        session_file,
        harness,
        machine_namespace,
        source_profile,
        rows_json,
        timeline_series,
    }) = &args.cmd
    {
        let Some(ns) = machine_namespace.as_deref().filter(|s| !s.is_empty()) else {
            eprintln!("--machine-namespace is required (spec §9: the CLI never invents identity segments)");
            std::process::exit(2);
        };
        let native_id = session_file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        let key = agent_vitals_domain::contracts::session_key::SessionKey::new(
            harness,
            &native_id,
            source_profile,
            ns,
        );
        let canonical = match agent_vitals_harnesses::canonical_input::canonical_session_for_path(
            session_file,
            harness,
        ) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("session source unavailable: {e}");
                std::process::exit(2);
            }
        };
        let graph =
            agent_vitals_domain::domain::trace::build_trace_graph(&canonical, key);
        if *timeline_series {
            // 形状 = 既有 buildGeometry 的输入契约（spec §2.1.2：几何不写第二份，
            // 这里只产数据准备）。AllRecorded 未暴露成 CLI 参数——v0.10.0 的图
            // 只有 adapter 选定的一条路径，域层会诚实拒绝。
            let series = agent_vitals_domain::domain::trace::project_timeline_series(
                &graph,
                agent_vitals_domain::evidence::Linearization::LeafPath,
            )
            .expect("LeafPath projection cannot fail by contract");
            let text = serde_json::to_string_pretty(&series).unwrap_or_default();
            if let Some(path) = rows_json {
                if path == &PathBuf::from("-") {
                    println!("{text}");
                } else if std::fs::write(path, &text).is_err() {
                    eprintln!("failed to write {}", path.display());
                    std::process::exit(2);
                } else {
                    println!("Wrote {}", path.display());
                }
            } else {
                println!("{text}");
            }
            return;
        }
        if let Some(path) = rows_json {
            let text = serde_json::to_string_pretty(&graph.to_json()).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}", path.display());
            }
            return;
        }
        // 人读摘要：节点类型计数 + coverage 六计数 + 头两个/尾一个节点的
        // 原生 id——摘要足够回答「这会话里发生了什么、图缺什么」。
        let cov = &graph.coverage;
        println!(
            "TraceGraph {} harness={} nodes={} edges={}",
            graph.graph_id,
            harness,
            cov.total_nodes,
            cov.total_edges
        );
        let mut by_type: std::collections::BTreeMap<&str, u32> = Default::default();
        for n in &graph.nodes {
            *by_type.entry(n.node_type.as_str()).or_insert(0) += 1;
        }
        for (t, n) in &by_type {
            println!("  {t}: {n}");
        }
        println!(
            "coverage: missing_parent={} missing_time={} missing_status={} unmetered_nodes={}",
            cov.missing_parent, cov.missing_time, cov.missing_status, cov.unmetered_nodes
        );
        return;
    }

    // D11：执行时长审计——工具调用/turn/step/审批等待/hook 消费五路耗时数据。
    // 与 skill-audit 同一种结构（独立子命令 + `--json` 输出同一份 core 结果），
    // 这里额外给人读格式加一段"最慢的几条"——这正是这个命令存在的理由，不是
    // 跟 skill-audit 一样只报计数就够了。
    if let Some(Cmd::DurationAudit {
        session_log,
        rows_json,
    }) = &args.cmd
    {
        let Some(audit) = agent_vitals_runtime::sessions::behavior::audit_session_log(session_log)
        else {
            eprintln!("session log unavailable: unreadable, malformed, or schema mismatch");
            std::process::exit(2);
        };
        let duration = &audit.duration;
        if let Some(path) = rows_json {
            let text = serde_json::to_string_pretty(duration).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}", path.display());
            }
            return;
        }
        let arr = |key: &str| {
            duration
                .get(key)
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
        };
        let tool_calls = arr("tool_calls");
        let turns = arr("turns");
        let steps = arr("steps");
        let approvals = arr("approvals");
        let hooks = duration
            .pointer("/hooks/executions")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if tool_calls.is_empty()
            && turns.is_empty()
            && steps.is_empty()
            && approvals.is_empty()
            && hooks.is_empty()
        {
            println!("No duration data found in session log.");
            return;
        }
        println!(
            "Tool calls: {} · Turns: {} · Steps: {} · Approvals: {} · Hook executions: {}",
            tool_calls.len(),
            turns.len(),
            steps.len(),
            approvals.len(),
            hooks.len()
        );
        // 最慢的几条工具调用——duration_ms 缺失（incomplete/failed 没等到结果）
        // 的排到最后，不是当成 0（那样反而会排到最前，读成"最快"）。
        let mut slow = tool_calls;
        slow.sort_by_key(|r| std::cmp::Reverse(r.get("duration_ms").and_then(|v| v.as_i64())));
        let timed: Vec<_> = slow
            .into_iter()
            .filter(|r| r.get("duration_ms").and_then(|v| v.as_i64()).is_some())
            .collect();
        if !timed.is_empty() {
            println!("\nSlowest tool calls:");
            for row in timed.iter().take(5) {
                let name = row
                    .get("tool_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(unknown)");
                let ms = row.get("duration_ms").and_then(|v| v.as_i64()).unwrap_or(0);
                let status = row
                    .get("load_status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                println!("  {name} — {ms}ms ({status})");
            }
        }
        return;
    }

    // P4（docs/RUNTIME_EVIDENCE_CONTRACT.md §17）：Codex rollout → CanonicalSession
    // 的 "sound" 证明。输出 §13 coverage，不是 findings——Codex 还没有 SV601–614
    // 检测器（detector decoupling 是后置的更大一摊，P4 明确不做）。`--harness codex`
    // 是安装时探针的表面，与这个子命令无关（命名冲突见 codex_session.rs 顶部注释）。
    if let Some(Cmd::CodexEvidence {
        session_log,
        roots,
        rows_json,
    }) = &args.cmd
    {
        if *roots {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_default();
            let report =
                agent_vitals_harnesses::codex_session::codex_session_roots_report(Path::new(&home));
            if let Some(path) = rows_json {
                let text = serde_json::to_string_pretty(&report).unwrap_or_default();
                if path == &PathBuf::from("-") {
                    println!("{text}");
                } else if std::fs::write(path, &text).is_err() {
                    eprintln!("failed to write {}", path.display());
                    std::process::exit(2);
                } else {
                    println!("Wrote {}", path.display());
                }
            } else {
                print!("{}", render_codex_roots(&report));
            }
            return;
        }
        // clap 的 required_unless_present 保证：roots=false 时 session_log 必在。
        let session_log = session_log
            .as_ref()
            .expect("session_log required unless --roots");
        let parsed = agent_vitals_harnesses::codex_session::read_codex_session_log(session_log);
        if parsed.get("degraded").and_then(|v| v.as_str()).is_some() {
            eprintln!("session log unavailable: unreadable, malformed, or empty");
            std::process::exit(2);
        }
        let items: Vec<Value> = parsed
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let session_id = parsed
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            // §14.4 back-fill：session_meta 缺席时退回文件名，保证 session 永远
            // 可指认（与 behavior 的 dsh session_id 同款兜底）。
            .unwrap_or_else(|| {
                session_log
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string()
            });
        let history_mode = parsed
            .get("history_mode")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let cli_version = parsed
            .get("cli_version")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let model = parsed
            .get("model")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let workspace_roots: Vec<String> = parsed
            .get("workspace_roots")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|r| r.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        // 标题从 ~/.codex/session_index.jsonl 查（索引缺失/不在索引 → None，存在性
        // 探测，绝不报错）。`session_id` 这里还要移进 build，先借引用查表。
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        let session_index = agent_vitals_harnesses::codex_session::read_session_index(Path::new(&home));
        let title = session_index.get(&session_id).cloned();
        let evidence = agent_vitals_harnesses::codex_evidence::build_codex_evidence(
            items,
            session_id,
            title,
            history_mode,
            cli_version,
            workspace_roots,
            model,
        );
        if let Some(path) = rows_json {
            let out = agent_vitals_harnesses::codex_evidence::codex_evidence_json(&evidence);
            let text = serde_json::to_string_pretty(&out).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                let n = out
                    .get("signals")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                println!("Wrote {}: {} signals", path.display(), n);
            }
            return;
        }
        print!(
            "{}",
            render_codex_evidence(&agent_vitals_harnesses::codex_evidence::codex_evidence_json(
                &evidence
            ))
        );
        return;
    }

    // Codex 成本报告（cc-trace 研究 §D 落地）。**v0.9.1 Tier B（spec §5.2）**：
    // codex 用量从 SQL 权威库读（`runtime::summary::codex_merged_from_sql` →
    // `authority_query::codex_by_hour_model`），不再全量 fold `~/.codex` rollout；
    // Python 侧 `codex-cost` 已整命令退役（ClawHub stdlib-only、无权威库），此
    // 路径 Rust-only。无状态单次调用：SQL 全窗查 → 计价 → 文本/JSON/HTML 三路。
    // 时间轴是**小时桶**（统一多桶折叠契约，见 docs/UNIFIED_COST_VIEW.md）。
    // `--month` 过滤小时轴后**重算** by_model（`codex_by_model_from_hours` 把过滤
    // 后的小时求和折回模型轴），保证 days 与 per_model 对得上。SQL 面降级：
    // `unaccounted` 恒 `[]`（残差哨兵是 rollout fold 独有）、`plan` 只有 tier
    // tag（限额快照丢失，见 `codex_merged_from_sql` doc）。`--today` 时报告带
    // `hours`（小时热力图数据）。
    if let Some(Cmd::CodexCost {
        month,
        today,
        rows_json,
        html,
    }) = &args.cmd
    {
        let (merged, note) = agent_vitals_runtime::summary::codex_merged_from_sql(
            &agent_vitals_runtime::home::data_home(),
        );
        // 库缺失/打不开 → stderr 提示：不把「空报告」当成「codex 没花钱」端出去
        // （二进制-only 安装从没跑过 sync-facts 时就是这个形态）。
        if let Some(note) = note {
            eprintln!("note: {note}");
        }
        // 月份解析（北京口径，与 Python `cli.py` 同源）：默认 = 当前自然月；
        // `--today` = 今天（过滤键是完整 YYYY-MM-DD，month 标签取今天所属月）；
        // `--month all` = 全部月份；其余 = 指定月。filter_key=None 即不过滤。
        let (filter_key, month_out): (Option<String>, Option<String>) = if *today {
            let t = agent_vitals_runtime::sessions::codex_cost::today_beijing();
            (Some(t.clone()), Some(t[..7].to_string()))
        } else {
            match month.as_deref() {
                Some("all") => (None, None),
                Some(m) => (Some(m.to_string()), Some(m.to_string())),
                None => {
                    let cur = agent_vitals_runtime::sessions::codex_cost::current_month_beijing();
                    (Some(cur.clone()), Some(cur))
                }
            }
        };
        // `--today` 时 want_hours=True：报告带 hours 键（today 视图渲染小时热力图）。
        // 折叠→过滤→计价→包装全部走共享助手（与 `_render_codex_cost_html` 的
        // 3 视图 blob 同一份逻辑，见 `codex_report_from_merged`）。
        let want_hours = *today;
        let out = codex_report_from_merged(
            &merged,
            filter_key.as_deref(),
            month_out.as_deref(),
            want_hours,
        );
        let mut wrote = false;
        if let Some(path) = rows_json {
            let text = serde_json::to_string_pretty(&out).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}", path.display());
            }
            wrote = true;
        }
        if let Some(path) = html {
            // `--html` 复用统一看板模板（codex 视角）：default 随请求——请求月
            // → "month"、全部 → "all"、今天 → "today"、无请求 → "month"。
            let default_view = if *today {
                "today"
            } else if month.as_deref() == Some("all") {
                "all"
            } else {
                "month"
            };
            render_codex_cost_html(
                path,
                &merged,
                filter_key.as_deref(),
                month_out.as_deref(),
                default_view,
            );
            wrote = true;
        }
        if !wrote {
            print!(
                "{}",
                agent_vitals_runtime::sessions::codex_cost::render_codex_cost(&out)
            );
        }
        return;
    }

    // Codex 单会话审计：逐 session 成本 + 出处覆盖并集。codex-cost 在折叠时把
    // session 身份聚合掉，codex-evidence 给出处但不含成本；这里把该 session 的
    // 文件们折叠→合并→计价（复用 codex-cost 同一条路径），再把 evidence 覆盖取
    // 并集，拼回一个逻辑 session（跨文件 resume 按 session_id 合并）。
    // `--list` 只是选 id 的前置（id/标题/模型/文件数/时间跨度），单会话深挖是
    // `--html`/`--json`/文本三路。无状态单次调用。HTML 是新模板
    // codex_session.html（套 DSH 审计 tab 的版式，docs/DSH_INTEGRATION.md 的
    // .sv-* 视觉约定），JSON 经 `</script`/`<!--` 转义后内联。
    if let Some(Cmd::CodexSession {
        list,
        session,
        rows_json,
        html,
    }) = &args.cmd
    {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        let home_path = Path::new(&home);
        if *list {
            if html.is_some() {
                eprintln!("--list only supports --json or plain text, not --html");
                std::process::exit(2);
            }
            let out =
                agent_vitals_runtime::sessions::codex_session_audit::codex_session_list(home_path);
            if let Some(path) = rows_json {
                let text = serde_json::to_string_pretty(&out).unwrap_or_default();
                if path == &PathBuf::from("-") {
                    println!("{text}");
                } else if std::fs::write(path, &text).is_err() {
                    eprintln!("failed to write {}", path.display());
                    std::process::exit(2);
                } else {
                    println!("Wrote {}", path.display());
                }
            } else {
                print!(
                    "{}",
                    agent_vitals_runtime::sessions::codex_session_audit::render_codex_session_list(
                        &out
                    )
                );
            }
            return;
        }
        // 缺省 --session = 最新（list 排序首项 = 末行时间戳最晚）。无任何 rollout
        // 文件 → 「no codex sessions found」，与 codex-cost 对空家目录的处理一致。
        let session_id = match session {
            Some(s) => s.clone(),
            None => {
                let list = agent_vitals_runtime::sessions::codex_session_audit::codex_session_list(
                    home_path,
                );
                let first = list
                    .get("sessions")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                    .and_then(|v| v.get("session_id"))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                match first {
                    Some(s) => s,
                    None => {
                        eprintln!("no codex sessions found");
                        std::process::exit(2);
                    }
                }
            }
        };
        let Some(out) =
            agent_vitals_runtime::sessions::codex_session_audit::codex_session_audit_json(
                home_path,
                &session_id,
            )
        else {
            eprintln!("codex session not found: {session_id}");
            std::process::exit(2);
        };
        let mut wrote = false;
        if let Some(path) = rows_json {
            let text = serde_json::to_string_pretty(&out).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}", path.display());
            }
            wrote = true;
        }
        if let Some(path) = html {
            agent_vitals_runtime::sessions::codex_session_audit::render_codex_session_html(
                path, &out,
            );
            wrote = true;
        }
        if !wrote {
            print!(
                "{}",
                agent_vitals_runtime::sessions::codex_session_audit::render_codex_session(&out)
            );
        }
        return;
    }

    // Claude Code 会话审计。与 codex-session 同款 home 解析与缺省 --session =
    // 最新；SV607/608 的 Unavailable 覆盖在 claude_session.rs（harness-capability
    // degradation，§12）。
    if let Some(Cmd::ClaudeSession {
        list,
        session,
        rows_json,
    }) = &args.cmd
    {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        let home_path = Path::new(&home);
        if *list {
            let out = agent_vitals_harnesses::claude_session::claude_session_list(home_path);
            if let Some(path) = rows_json {
                let text = serde_json::to_string_pretty(&out).unwrap_or_default();
                if path == &PathBuf::from("-") {
                    println!("{text}");
                } else if std::fs::write(path, &text).is_err() {
                    eprintln!("failed to write {}", path.display());
                    std::process::exit(2);
                } else {
                    println!("Wrote {}", path.display());
                }
            } else {
                print!(
                    "{}",
                    agent_vitals_harnesses::claude_session::render_claude_session_list(&out)
                );
            }
            return;
        }
        // 缺省 --session = 最新（list 排序首项 = 末行时间戳最晚）。
        let session_id = match session {
            Some(s) => s.clone(),
            None => {
                let list = agent_vitals_harnesses::claude_session::claude_session_list(home_path);
                let first = list
                    .get("sessions")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                    .and_then(|v| v.get("session_id"))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                match first {
                    Some(s) => s,
                    None => {
                        eprintln!("no claude sessions found");
                        std::process::exit(2);
                    }
                }
            }
        };
        let Some(out) =
            agent_vitals_harnesses::claude_session::claude_session_audit_json(home_path, &session_id)
        else {
            eprintln!("claude session not found or unreadable: {session_id}");
            std::process::exit(2);
        };
        let text = serde_json::to_string_pretty(&out).unwrap_or_default();
        if let Some(path) = rows_json {
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}", path.display());
            }
        } else {
            println!("{text}");
        }
        return;
    }

    // claude-sync：Claude Code 会话账 fold 生产者（tick 在 oneline 之后调）。
    // home 解析同 claude-session；fencing/内部错误 exit 2（同 oneline 语义）。
    if let Some(Cmd::ClaudeSync { shadow }) = &args.cmd {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        match agent::claude_cost::claude_sync(Path::new(&home), *shadow) {
            Ok(_) => return,
            Err(msg) => {
                eprintln!("{msg}");
                std::process::exit(2);
            }
        }
    }

    // ── v0.9 Stage A：emit → ingest 端到端接线（R4 §5 ingest_service）────
    // --write 把 emitter 的事实流经 runtime 共享 ingest service 落盘
    // `<data_home>/facts/<harness>.jsonl`：按事实自身 `harness` 分组、fact_id
    // exactly-once、写后重放自检。**唯一写路径**——sync_service（Stage B）
    // 也走 ingest_service，不在这里旁路直捅 writer。
    fn run_ingest(
        write: bool,
        cmd: &str,
        facts: &[serde_json::Value],
    ) -> Option<agent_vitals_runtime::ingest_service::IngestReport> {
        if !write {
            return None;
        }
        match agent_vitals_runtime::ingest_service::ingest_facts(
            &agent_vitals_runtime::home::data_home(),
            facts,
        ) {
            Ok(r) => Some(r),
            Err(e) => {
                eprintln!("{cmd} --write failed: {e}");
                std::process::exit(2);
            }
        }
    }

    fn attach_write_report(
        mut payload: serde_json::Value,
        report: &Option<agent_vitals_runtime::ingest_service::IngestReport>,
    ) -> serde_json::Value {
        if let Some(r) = report {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert(
                    "write".to_string(),
                    serde_json::to_value(r).expect("IngestReport serializes"),
                );
            }
        }
        payload
    }

    fn print_ingest_summary(report: &Option<agent_vitals_runtime::ingest_service::IngestReport>) {
        if let Some(r) = report {
            for h in &r.harnesses {
                println!(
                    "ingest → {}: +{} appended, {} duplicate, {} invalid, total {}{}",
                    h.facts_path.display(),
                    h.appended,
                    h.duplicate,
                    h.invalid,
                    h.total_after,
                    if h.repaired_tail {
                        " (repaired crash tail)"
                    } else {
                        ""
                    },
                );
            }
        }
    }

    // claude-usage-facts：单份 Claude JSONL → UsageFact rows（内存 emit，不写
    // state）。R1 拍板：per-message 事实行 + attempts + coverage，`--json -`
    // 输出与 Python `scan.py claude-usage-facts --json -` 字节相等（parity 钉测
    // 在 tests/test_claude_usage_fact.py::ClaudeUsageFactsBothTests）。
    if let Some(Cmd::ClaudeUsageFacts {
        session_jsonl,
        machine_namespace,
        source_profile,
        rows_json,
        write,
    }) = &args.cmd
    {
        // machine_namespace 必传且非空（spec §9）。绝不让 CLI 读 takeover 身份来
        // 补齐：那是一次隐式 state 写，而 claude-usage-facts 是只读诊断。
        let ns = match machine_namespace {
            Some(ns) if !ns.is_empty() => ns.clone(),
            _ => {
                eprintln!(
                    "claude-usage-facts: --machine-namespace is required \
                     (v0.7 spec §9: caller-provided; a CLI default would write state)"
                );
                std::process::exit(2);
            }
        };
        let sid = session_jsonl
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let result = match agent::claude_usage_fact::claude_jsonl_to_usage_facts(
            session_jsonl,
            &ns,
            source_profile,
            &sid,
        ) {
            Ok(r) => r,
            Err(msg) => {
                eprintln!("claude-usage-facts failed: {msg}");
                std::process::exit(2);
            }
        };
        let write_report = run_ingest(*write, "claude-usage-facts", &result.facts);
        if let Some(path) = rows_json {
            let payload = attach_write_report(
                agent::claude_usage_fact::to_payload_value(&result, &sid, &ns, source_profile),
                &write_report,
            );
            let text = serde_json::to_string_pretty(&payload).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}: {} facts", path.display(), result.facts.len());
            }
        } else {
            print!(
                "{}",
                agent::claude_usage_fact::to_human_summary(
                    &result,
                    session_jsonl,
                    &sid,
                    &ns,
                    source_profile
                )
            );
            print_ingest_summary(&write_report);
        }
        return;
    }

    // Stage 2（commit 2）：Codex UsageFact 诊断 CLI（v0.7 spec §3 候选 #3）。
    // 一份或多份 rollout JSONL → facts + attempts + coverage；**不写盘**。source
    // event id 按 rollout stem 命名空间——同 stem 的 byte-identical 复本去重、
    // 异 stem 永不误合并。与 Python `scan.py codex-usage-facts --json -` 字节相等
    // （parity 钉测在 tests/test_codex_usage_fact.py）。
    if let Some(Cmd::HarnessInventory { window_days }) = &args.cmd {
        match agent_vitals_runtime::query::app_harnesses::inventory(&agent_vitals_runtime::home::data_home(),
            *window_days, agent_vitals_runtime::core::clock::now_ms()) {
            Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default()),
            Err(code) => { eprintln!("{code}"); std::process::exit(1); }
        }
        return;
    }
    if let Some(Cmd::ManifestList) = &args.cmd {
        let payload = agent_vitals_runtime::plugin_ingest::plugin_list(
            &agent_vitals_runtime::home::data_home(),
        );
        println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());
        return;
    }

    if let Some(Cmd::ManifestCatalogStatus) = &args.cmd {
        // 只读本地状态/策略文件（与桌面共享同一事实源）；无网络。
        let data_home = agent_vitals_runtime::core::home::data_home();
        let read = |name: &str| {
            std::fs::read(data_home.join(name))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        };
        let mut status = read("manifest-catalog-update.json").unwrap_or_else(|| {
            serde_json::json!({ "state": "never_checked",
                "source_url": "https://raw.githubusercontent.com/Oh-Agent-AI/oh-agent/main/catalog/index.json" })
        });
        let network_enabled = read("manifest-catalog-policy.json")
            .and_then(|policy| policy.get("network_enabled").and_then(|v| v.as_bool()))
            .unwrap_or(false);
        status["network_enabled"] = serde_json::Value::Bool(network_enabled);
        println!("{}", serde_json::to_string_pretty(&status).unwrap_or_default());
        return;
    }

    if let Some(Cmd::ManifestInstall { manifest, machine_namespace, files, confirm, rows_json: _ }) = &args.cmd {
        let home = std::env::var("HOME").unwrap_or_default();
        match agent_vitals_runtime::ingest::local_manifest_install::local_manifest_install(
            manifest, machine_namespace, &agent_vitals_runtime::core::home::data_home(),
            Path::new(&home), files, confirm.as_deref()) {
            Ok(payload) => println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default()),
            Err(error) => { eprintln!("manifest-install failed: {error}"); std::process::exit(2); }
        }
        return;
    }

    if let Some(Cmd::ManifestUninstall { slug, confirm }) = &args.cmd {
        let data_home = agent_vitals_runtime::core::home::data_home();
        match agent_vitals_runtime::ingest::local_manifest_lifecycle::local_harness_change(
            &data_home, Path::new(""), slug,
            agent_vitals_runtime::ingest::local_manifest_lifecycle::HarnessChange::Uninstall,
            &[], None, confirm.as_deref()) {
            Ok(payload) => println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default()),
            Err(error) => { eprintln!("manifest-uninstall failed: {error}"); std::process::exit(2); }
        }
        return;
    }

    if let Some(Cmd::ManifestRollback { slug, revision, machine_namespace, files, confirm }) = &args.cmd {
        let home = std::env::var("HOME").unwrap_or_default();
        let data_home = agent_vitals_runtime::core::home::data_home();
        match agent_vitals_runtime::ingest::local_manifest_lifecycle::local_harness_change(
            &data_home, Path::new(&home), slug,
            agent_vitals_runtime::ingest::local_manifest_lifecycle::HarnessChange::Rollback { revision_id: revision },
            files, Some(machine_namespace), confirm.as_deref()) {
            Ok(payload) => println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default()),
            Err(error) => { eprintln!("manifest-rollback failed: {error}"); std::process::exit(2); }
        }
        return;
    }

    if let Some(Cmd::ManifestRecompute { slug, revision, machine_namespace, files, confirm }) = &args.cmd {
        let home = std::env::var("HOME").unwrap_or_default();
        match agent_vitals_runtime::ingest::manifest_recompute::recompute(
            &agent_vitals_runtime::core::home::data_home(), Path::new(&home), slug,
            revision, machine_namespace, files, confirm.as_deref()) {
            Ok(payload) => println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default()),
            Err(error) => { eprintln!("manifest-recompute failed: {error}"); std::process::exit(2); }
        }
        return;
    }

    if let Some(Cmd::ManifestValidate {
        manifest,
        files,
        machine_namespace,
        rows_json,
    }) = &args.cmd
    {
        let ns = machine_namespace.clone().unwrap_or_default();
        let home = std::env::var("HOME").unwrap_or_default();
        let result = agent_vitals_runtime::plugin_ingest::run_plugin(
            manifest,
            files,
            &ns,
            Path::new(&home),
        );
        let payload = match result {
            Ok(mut report) => {
                let gate = agent_vitals_runtime::plugin_ingest::validate_gate(&report);
                let facts = std::mem::take(&mut report.facts);
                serde_json::json!({
                    "mode": "validate",
                    "gate": match &gate { Ok(()) => "pass", Err(_) => "refuse" },
                    "gate_problem": gate.err(),
                    "report": report,
                    "facts": facts,
                })
            }
            Err(e) => serde_json::json!({ "mode": "validate", "error": e }),
        };
        // 退出码与消费语义（验收修复 #1）：硬错误与 gate refusal 一律
        // exit 2——JSON 模式不豁免，自动化拿「安装成功」当成功。
        let failed = payload.get("error").is_some()
            || payload.get("gate").and_then(|v| v.as_str()) != Some("pass");
        if *rows_json || payload.get("error").is_none() {
            println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());
        }
        if let Some(err) = payload.get("error").and_then(|v| v.as_str()) {
            eprintln!("manifest-validate failed: {err}");
        }
        if failed {
            std::process::exit(2);
        }
        return;
    }

    if let Some(Cmd::ManifestIngest {
        manifest,
        machine_namespace,
        write,
        rows_json: _,
    }) = &args.cmd
    {
        let _ = (manifest, machine_namespace, write);
        eprintln!("manifest-ingest --write is retired: use manifest-install with explicit preview/confirm, then run the normal sync for active manifests");
        std::process::exit(2);
    }

    if let Some(Cmd::WorkbuddyUsageFacts {
        root,
        machine_namespace,
        source_profile,
        rows_json,
        write,
    }) = &args.cmd
    {
        let ns = match machine_namespace {
            Some(ns) if !ns.is_empty() => ns.clone(),
            _ => {
                eprintln!(
                    "workbuddy-usage-facts: --machine-namespace is required \
                     (v0.7 spec §9: caller-provided; a CLI default would write state)"
                );
                std::process::exit(2);
            }
        };
        let result = match agent_vitals_harnesses::workbuddy_usage_fact::workbuddy_traces_to_usage_facts(
            root,
            &ns,
            source_profile,
        ) {
            Ok(r) => r,
            Err(msg) => {
                eprintln!("workbuddy-usage-facts failed: {msg}");
                std::process::exit(2);
            }
        };
        let write_report = run_ingest(*write, "workbuddy-usage-facts", &result.facts);
        if let Some(path) = rows_json {
            let payload = attach_write_report(
                agent_vitals_harnesses::workbuddy_usage_fact::to_payload_value(&result, &ns, source_profile),
                &write_report,
            );
            let text = serde_json::to_string_pretty(&payload).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}: {} facts", path.display(), result.facts.len());
            }
        } else {
            print!(
                "{}",
                agent_vitals_harnesses::workbuddy_usage_fact::to_human_summary(&result, root, &ns, source_profile)
            );
            print_ingest_summary(&write_report);
        }
        return;
    }

    if let Some(Cmd::CodexUsageFacts {
        rollouts,
        machine_namespace,
        source_profile,
        rows_json,
        write,
    }) = &args.cmd
    {
        // machine_namespace 必传（spec §9）。绝不让 CLI 读 takeover 身份来补齐：
        // 那是一次隐式 state 写（bootstrap machine.json），而 codex-usage-facts
        // 是只读诊断——缺失或空串即失败（exit 2），与 Python handler 同款。
        let ns = match machine_namespace {
            Some(ns) if !ns.is_empty() => ns.clone(),
            _ => {
                eprintln!(
                    "codex-usage-facts: --machine-namespace is required \
                     (v0.7 spec §9: caller-provided; a CLI default would write state)"
                );
                std::process::exit(2);
            }
        };
        let result = match agent::codex_usage_fact::codex_rollouts_to_usage_facts(
            rollouts,
            &ns,
            source_profile,
        ) {
            Ok(r) => r,
            Err(msg) => {
                eprintln!("codex-usage-facts failed: {msg}");
                std::process::exit(2);
            }
        };
        let write_report = run_ingest(*write, "codex-usage-facts", &result.facts);
        if let Some(path) = rows_json {
            let payload = attach_write_report(
                agent::codex_usage_fact::to_payload_value(&result, &ns, source_profile),
                &write_report,
            );
            let text = serde_json::to_string_pretty(&payload).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}: {} facts", path.display(), result.facts.len());
            }
        } else {
            print!(
                "{}",
                agent::codex_usage_fact::to_human_summary(&result, rollouts, &ns, source_profile)
            );
            print_ingest_summary(&write_report);
        }
        return;
    }

    if let Some(Cmd::DshUsageFacts {
        session_path,
        machine_namespace,
        source_profile,
        rows_json,
        write,
    }) = &args.cmd
    {
        // machine_namespace 必传（spec §9），同 codex-usage-facts：绝不让 CLI 读
        // takeover 身份补齐（隐式 state 写），缺失或空串即失败（exit 2）。
        let ns = match machine_namespace {
            Some(ns) if !ns.is_empty() => ns.clone(),
            _ => {
                eprintln!(
                    "dsh-usage-facts: --machine-namespace is required \
                     (v0.7 spec §9: caller-provided; a CLI default would write state)"
                );
                std::process::exit(2);
            }
        };
        // strict 硬错误（读/解码/解析/身份/归属/duplicate）→ exit 2，不出空成功伪装
        // 「没有用量」。Err 串恒为 "code: message"，与 Python DshUsageFactError 同源。
        let result = match agent::dsh_usage_fact::dsh_session_to_usage_facts(
            session_path,
            &ns,
            source_profile.as_deref(),
        ) {
            Ok(r) => r,
            Err(msg) => {
                eprintln!("dsh-usage-facts failed: {msg}");
                std::process::exit(2);
            }
        };
        let write_report = run_ingest(*write, "dsh-usage-facts", &result.facts);
        if let Some(json_path) = rows_json {
            // --json payload = spec §5 字面 {facts, coverage}（键序固定，Python
            // handler 的 payload dict 同款；--write 追加 Rust-only 的 `write`
            // 键，flag 关闭时与 Python 字节相等）。facts 是 build_usage_fact
            // 输出、coverage 四键。
            let payload = attach_write_report(
                agent::dsh_usage_fact::to_payload_value(&result),
                &write_report,
            );
            let text = serde_json::to_string_pretty(&payload).unwrap_or_default();
            if json_path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(json_path, &text).is_err() {
                eprintln!("failed to write {}", json_path.display());
                std::process::exit(2);
            } else {
                println!(
                    "Wrote {}: {} facts",
                    json_path.display(),
                    result.facts.len()
                );
            }
        } else {
            print!(
                "{}",
                agent::dsh_usage_fact::to_human_summary(&result, session_path, &ns)
            );
            print_ingest_summary(&write_report);
        }
        return;
    }

    // sync-facts（Stage B 遗留收口）：三执行环境例行 ingest——退休路径第 ① 步。
    // 托盘 tick 未来也调这一条（不各自长文件枚举）。
    if let Some(Cmd::SyncFacts { rows_json, harnesses }) = &args.cmd {
        let only_harnesses: Option<std::collections::BTreeSet<String>> = harnesses
            .as_ref()
            .map(|list| {
                list.split(',')
                    .map(|h| h.trim().to_string())
                    .filter(|h| !h.is_empty())
                    .collect::<std::collections::BTreeSet<_>>()
            })
            // 空集合 = 过滤掉一切 = no-op 同步——手敲 `--harnesses ""` 的守卫：
            // 视同未给参（全执行环境），与桌面侧的防呆一致。
            .filter(|set| !set.is_empty());
        match agent_vitals_runtime::sync_service::sync_facts_filtered(
            &agent_vitals_runtime::home::data_home(),
            only_harnesses.as_ref(),
        ) {
            Ok(report) => {
                if *rows_json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&report).unwrap_or_default()
                    );
                } else {
                    println!(
                        "Facts sync: +{} appended, {} duplicate",
                        report.total_appended, report.total_duplicate
                    );
                    if report.declarations_applied > 0 {
                        println!(
                            "  billing declarations: {} new facts attributed under active rules",
                            report.declarations_applied
                        );
                    }
                    for h in &report.harnesses {
                        println!(
                            "  {:<12} seen {} synced {} skipped {} (+{} dup{})",
                            h.harness,
                            h.files_seen,
                            h.files_synced,
                            h.files_skipped,
                            h.appended,
                            if h.errors.is_empty() {
                                String::new()
                            } else {
                                format!("; {} error(s)", h.errors.len())
                            },
                        );
                    }
                }
                // 单执行环境的坏文件不回滚其他执行环境已经写入的事实，但也绝不能把
                // 这轮报告成成功：桌面端需要据此把该执行环境标成“需要处理”。
                // 错误写 stderr，使桌面 `run_facts_sync` 能保留执行环境名和原因。
                let failed_harnesses: Vec<_> = report.harnesses.iter()
                    .filter(|harness| !harness.errors.is_empty())
                    .collect();
                if !failed_harnesses.is_empty() {
                    for harness in failed_harnesses {
                        eprintln!(
                            "sync-facts partial failure [{}]: {}",
                            harness.harness,
                            harness.errors.join(" | "),
                        );
                    }
                    std::process::exit(1);
                }
            }
            Err(e) => {
                eprintln!("sync-facts failed: {e}");
                std::process::exit(2);
            }
        }
        return;
    }

    // data-migrate / data-status（v0.9.1 Phase 2 收口）：存量迁移与权威库
    // 状态面。migrate 幂等（fact_id 主键），可重复执行直到全 duplicate。
    if let Some(Cmd::DataMigrate { with_legacy_ledger }) = &args.cmd {
        let data_home = agent_vitals_runtime::home::data_home();
        let db = match agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&data_home),
            agent_vitals_runtime::sql_sync::now_ms(),
        ) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("data-migrate failed: {e}");
                std::process::exit(2);
            }
        };
        let run_id = agent_vitals_runtime::sql_sync::new_run_id("migration");
        if let Err(e) = db.begin_run(
            &run_id,
            "migration",
            agent_vitals_runtime::sql_sync::now_ms(),
        ) {
            eprintln!("data-migrate failed: {e}");
            std::process::exit(2);
        }
        // E05/v30 文件侧迁移（幂等）：先把 plugin- 期行重 stamp 到 harness: 身份
        // （与 authority v30 同拍板），再改 facts 文件名。挂在 data-migrate 而
        // 非仅靠 retention——CLI 调用图裁剪后后者不一定被链接，且这是显式
        // 维护命令，确定性触发优于等每日首轮。
        let restamp = agent_vitals_runtime::ingest::ingest_service::restamp_manifest_fact_files(&data_home);
        let rename = agent_vitals_runtime::ingest::ingest_service::migrate_manifest_facts_prefix(&data_home);
        println!("manifest facts restamp: {}", serde_json::to_string_pretty(&restamp).unwrap_or_default());
        println!("manifest facts rename: {}", serde_json::to_string_pretty(&rename).unwrap_or_default());
        // 迁移总量（JSONL + legacy ledger 合并同一口径——收尾行与 migrations
        // checkpoint 都从这读）。
        struct Totals {
            inserted: usize,
            duplicate: usize,
            rejected: usize,
            updated: usize,
            conflicts: usize,
        }
        let mut total = Totals {
            inserted: 0,
            duplicate: 0,
            rejected: 0,
            updated: 0,
            conflicts: 0,
        };
        for harness in agent_vitals_runtime::ingest_service::FACT_HARNESSES {
            let path = data_home.join("facts").join(format!("{harness}.jsonl"));
            if !path.exists() {
                continue;
            }
            match db.with_immediate_txn(|conn| {
                let writer = agent_vitals_data::fact_writer_sql::SqlFactWriter::new(
                    conn,
                    &run_id,
                    agent_vitals_runtime::sql_sync::now_ms(),
                )?;
                writer.import_facts_jsonl(harness, &path)
            }) {
                Ok(r) => {
                    println!(
                        "  {harness}: +{} inserted, {} duplicate, {} rejected",
                        r.inserted, r.duplicate, r.rejected
                    );
                    total.inserted += r.inserted;
                    total.duplicate += r.duplicate;
                    total.rejected += r.rejected;
                }
                Err(e) => {
                    let _ = db.finish_run(
                        &run_id,
                        "failed",
                        Some("import_failed"),
                        Some(&e.to_string()),
                        agent_vitals_runtime::sql_sync::now_ms(),
                    );
                    eprintln!("data-migrate failed ({harness}): {e}");
                    std::process::exit(2);
                }
            }
        }
        // Phase 4.3 Stage 4：claude ledger 深历史导入默认关闭（用户
        // 2026-09-07 决定：纯原始日志重导入，不要 legacy 兜底）。
        // `--with-legacy-ledger` 显式打开——`legacy_import` 模块保留
        // （spec §10「legacy 代码只留 importer」），只是不再是默认路径。
        if *with_legacy_ledger {
            // Phase 3.2（spec §6.2.3）：claude ledger 深历史 → legacy_aggregate。
            // 这些账在 JSONL 里**没有对应行**——claude 客户端会压缩/轮转会话文件，
            // 历史行物理消失后 ledger 里仍有账（R4 §5.2a：ledger 是这部分账的
            // store of record）。不用判断「该日是否已有实时事实」：legacy 身份
            // 五元组（machine_namespace="legacy" / native_session_id="day:{day}"）
            // 与实时事实完全不重叠，查询侧 SqlSummaryRepository::merged_claude_days
            // 先铺 legacy 再被实时行按日覆盖（有实时用实时、没有才退深历史）。
            let ledger_days = match agent_vitals_data::legacy_import::load_claude_ledger_days(
                &agent_vitals_runtime::state::state_dir(),
            ) {
                Ok(d) => d,
                Err(e) => {
                    // 坏 ledger（非法 JSON 等）与 JSONL 导入失败同款处理：run 记
                    // failed 后退出——吞掉它就是「看似迁移成功、深历史实际没进库」。
                    let _ = db.finish_run(
                        &run_id,
                        "failed",
                        Some("import_failed"),
                        Some(&e.to_string()),
                        agent_vitals_runtime::sql_sync::now_ms(),
                    );
                    eprintln!("data-migrate failed (claude-ledger): {e}");
                    std::process::exit(2);
                }
            };
            if ledger_days
                .as_object()
                .map(|m| !m.is_empty())
                .unwrap_or(false)
            {
                match db.with_immediate_txn(|conn| {
                    agent_vitals_data::legacy_import::import_claude_ledger_days(
                        conn,
                        &run_id,
                        agent_vitals_runtime::sql_sync::now_ms(),
                        &ledger_days,
                    )
                }) {
                    Ok(r) => {
                        println!(
                        "  claude-ledger: +{} inserted, {} duplicate, {} updated, {} rejected, {} conflicts",
                        r.imported, r.duplicate, r.updated, r.rejected, r.conflicts
                    );
                        total.inserted += r.imported;
                        total.duplicate += r.duplicate;
                        total.updated += r.updated;
                        // 拒入行并入总 rejected（2026-09-07 审查收口：否则
                        // checkpoint 的 rejected 键只剩 JSONL 侧的数，迁移摘要
                        // 与 data_quality_issues 面互相矛盾）。
                        total.rejected += r.rejected;
                        total.conflicts += r.conflicts;
                    }
                    Err(e) => {
                        let _ = db.finish_run(
                            &run_id,
                            "failed",
                            Some("import_failed"),
                            Some(&e.to_string()),
                            agent_vitals_runtime::sql_sync::now_ms(),
                        );
                        eprintln!("data-migrate failed (claude-ledger): {e}");
                        std::process::exit(2);
                    }
                }
            }
            // ledger 的无日期残差池（`unaccounted`）：不编日期塞 usage_facts，记为
            // 一条 `undated_residual` 覆盖缺口 issue（spec §5.4：无日期事实不静默
            // 丢弃；裁决见 legacy_import::import_claude_ledger_unaccounted）。
            match agent_vitals_data::legacy_import::load_claude_ledger_unaccounted(
                &agent_vitals_runtime::state::state_dir(),
            ) {
                Ok(unacc) => {
                    match db.with_immediate_txn(|conn| {
                    agent_vitals_data::legacy_import::import_claude_ledger_unaccounted(
                        conn,
                        agent_vitals_runtime::sql_sync::now_ms(),
                        &unacc,
                    )
                }) {
                    Ok(0) => {}
                    Ok(tokens) => println!(
                        "  claude-ledger unaccounted: {tokens} undated residual tokens recorded as a coverage-gap issue (not facts)"
                    ),
                    Err(e) => eprintln!("data-migrate warning (claude-ledger unaccounted): {e}"),
                }
                }
                Err(e) => {
                    eprintln!("data-migrate warning (claude-ledger unaccounted, unreadable): {e}")
                }
            }
        } // end `if *with_legacy_ledger`
        // v1.0：旧版公共价表曾错误携带个人订阅。先从升级前已经落库的
        // 快照迁移为本地待确认候选，再保存新公共价卡；迁移可重复执行，已有
        // 用户账单不会被覆盖或被当作自动确认。
        match agent_vitals_runtime::sql_sync::migrate_legacy_subscription_snapshots(
            &db,
            agent_vitals_runtime::sql_sync::now_ms(),
        ) {
            Ok(0) => {}
            Ok(rows) => println!("  legacy subscriptions: {rows} pending confirmation candidates found"),
            Err(e) => eprintln!("data-migrate warning (legacy subscriptions): {e}"),
        }
          // Phase 2.8：落当前价格快照（§5.3：历史查询按记录的 pricing version 重放）。
        match agent_vitals_runtime::sql_sync::snapshot_current_pricing(&db) {
            Ok(true) => println!("  pricing snapshot: new version captured"),
            Ok(false) => {}
            Err(e) => eprintln!("data-migrate warning (pricing snapshot): {e}"),
        }
        let _ = db.finish_run(
            &run_id,
            "succeeded",
            None,
            None,
            agent_vitals_runtime::sql_sync::now_ms(),
        );
        // spec §6.1：迁移必须记录在 migrations 表（与 DDL 版本分离）——
        // checkpoint 可重跑的锚点。
        let _ = db.conn().execute(
            "INSERT INTO migrations(migration_id, started_at_ms, completed_at_ms,
                 status, source_version, target_version, checkpoint_json, error_detail)
             VALUES (?1, ?2, ?3, 'completed', 'jsonl-legacy', ?4, ?5, NULL)
             ON CONFLICT(migration_id) DO UPDATE SET
                 completed_at_ms = excluded.completed_at_ms,
                 status = excluded.status,
                 checkpoint_json = excluded.checkpoint_json",
            rusqlite::params![
                run_id,
                agent_vitals_runtime::sql_sync::now_ms(),
                agent_vitals_runtime::sql_sync::now_ms(),
                format!(
                    "sql-authority-v{}",
                    agent_vitals_data::authority::SCHEMA_VERSION
                ),
                json!({
                    "inserted": total.inserted, "duplicate": total.duplicate,
                    "rejected": total.rejected, "updated": total.updated,
                    "conflicts": total.conflicts,
                })
                .to_string(),
            ],
        );
        println!(
            "Migration done: +{} inserted, {} duplicate, {} rejected, {} updated, {} conflicts",
            total.inserted, total.duplicate, total.rejected, total.updated, total.conflicts
        );
        return;
    }
    if let Some(Cmd::DataStatus { rows_json }) = &args.cmd {
        let data_home = agent_vitals_runtime::home::data_home();
        let db_path = agent_vitals_data::authority::default_authority_path(&data_home);
        // `AuthorityDb::open` 对缺文件会**建库**（全 DDL）——必须在 open 之前
        // 判存在，否则「刚被删/从没同步过」和「同步了但没有事实」在 open 之后
        // 长得一模一样（facts=0），而前者在 sql_authority_enabled 下是灾难态
        // （旧 JSON 写入已冻结、权威库刚被清空 → 零绝不是「没花钱」）。
        let db_existed = db_path.exists();
        let out = (|| -> Result<Value, String> {
            // CLI 侧沿用 `AuthorityDb::open`（缺文件建库 + 清扫中断批次）——
            // `db_existed` 已在 open 之前判过，「刚被删 vs 从没同步」的区分不丢。
            // 数据组装与 MCP `data_status` 工具同源（`mcp::data_status_report`），
            // spec §5「同一 repository / 同一 DTO」。
            let db = agent_vitals_data::authority::AuthorityDb::open(
                &db_path,
                agent_vitals_runtime::sql_sync::now_ms(),
            )
            .map_err(|e| e.to_string())?;
            // CLI `data-status` 与 MCP `data_status` 工具同源：都走
            // `mcp::data_status_report`（spec §5「同一 repository / 同一 DTO」）。
            // 损坏恢复 / 「删库不回落」的 health + hints 逻辑也在那一份里。
            let enabled = agent_vitals_runtime::sql_authority::is_enabled(&data_home);
            let mut report = agent_vitals_runtime::mcp::data_status_report(
                db.conn(), db_existed, enabled,
            );
            agent_vitals_runtime::mcp::augment_sync_failure(&mut report, &data_home);
            Ok(report)
        })();
        match out {
            Ok(v) => {
                let health = v["health"].as_str().unwrap_or("ok");
                if *rows_json {
                    println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
                } else {
                    println!(
                        "Authority DB ({}): schema v{}, integrity {}, facts {}, sources {}, sessions {}, open issues {}, sql_authority_enabled {}",
                        data_home.display(),
                        v["schema_version"].as_str().unwrap_or("?"),
                        v["integrity"].as_str().unwrap_or("?"),
                        v["facts"],
                        v["sources"],
                        v["sessions"],
                        v["open_quality_issues"],
                        v["sql_authority_enabled"],
                    );
                    if let Some(by_code) = v["open_quality_issues_by_code"].as_object() {
                        for (code, n) in by_code {
                            println!("  issue [{code}]: {n}");
                        }
                    }
                    if let Some(runs) = v["recent_runs"].as_array() {
                        for r in runs {
                            println!(
                                "  run {} [{}] {} (at {}){}",
                                r["run_id"],
                                r["trigger"],
                                r["status"],
                                r["started_at_ms"],
                                r["error_code"]
                                    .as_str()
                                    .map(|c| format!(" err={c}"))
                                    .unwrap_or_default(),
                            );
                        }
                    }
                    println!("  health: {health}");
                    if let Some(hints) = v["hints"].as_array() {
                        for h in hints {
                            eprintln!("  ! {}", h.as_str().unwrap_or_default());
                        }
                    }
                }
                // 4.4：critical（库被删/损坏/enabled 但空）→ 非零退出，脚本
                // 可判；「明确告警不回落」的机器可读信号。
                if health == "critical" {
                    std::process::exit(1);
                }
            }
            Err(e) => {
                eprintln!("data-status failed: {e}");
                std::process::exit(2);
            }
        }
        return;
    }

    // data harness-bill（Phase 2.8，spec §5.3 显式管理 API）
    if let Some(Cmd::DataHarnessBill {
        action,
        month,
        harness,
        provider,
        basis,
        amount_minor,
        currency,
        evidence,
        bill_id,
        rows_json,
    }) = &args.cmd
    {
        let db = match agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(
                &agent_vitals_runtime::home::data_home(),
            ),
            agent_vitals_runtime::sql_sync::now_ms(),
        ) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("data harness-bill: authority DB unavailable: {e}");
                std::process::exit(2);
            }
        };
        let now = agent_vitals_runtime::sql_sync::now_ms();
        match action.as_str() {
            "set" => {
                let (Some(h), Some(p), Some(per), Some(b), Some(amt), Some(cur)) = (
                    harness.as_deref(),
                    provider.as_deref(),
                    month.as_deref(),
                    basis.as_deref(),
                    *amount_minor,
                    currency.as_deref(),
                ) else {
                    eprintln!("data harness-bill set: --harness --provider --month --basis --amount-minor --currency are all required");
                    std::process::exit(2);
                };
                let ev = evidence.as_deref().unwrap_or("");
                let id = format!("{h}:{p}:{per}:{b}:{ev}");
                match db
                    .with_immediate_txn(|_c| db.harness_bill_put(&id, h, p, per, b, amt, cur, ev, now))
                {
                    Ok(()) => println!("harness bill saved: {id} = {amt} {cur} ({b})"),
                    Err(e) => {
                        eprintln!("data harness-bill set failed: {e}");
                        std::process::exit(2);
                    }
                }
            }
            "list" => {
                let per = month
                    .clone()
                    .unwrap_or_else(agent_vitals_runtime::clock::current_month_beijing);
                match db.harness_bills_for_period(&per) {
                    Ok(rows) => {
                        if *rows_json {
                            let arr: Vec<Value> = rows.iter().map(|(h, p, b, a, c)| json!({
                                "harness": h, "provider": p, "basis": b, "amount_minor": a, "currency": c,
                            })).collect();
                            println!(
                                "{}",
                                serde_json::to_string_pretty(&json!({"month": per, "bills": arr}))
                                    .unwrap_or_default()
                            );
                        } else {
                            println!("Harness bills ({per}):");
                            for (h, p, b, a, c) in &rows {
                                println!("  {h}/{p} {b}: {a} {c}");
                            }
                            if rows.is_empty() {
                                println!("  (none)");
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("data harness-bill list failed: {e}");
                        std::process::exit(2);
                    }
                }
            }
            "delete" => {
                let Some(id) = bill_id.as_deref() else {
                    eprintln!("data harness-bill delete: --id required");
                    std::process::exit(2);
                };
                match db.with_immediate_txn(|_c| db.harness_bill_delete(id, now)) {
                    Ok(true) => println!("harness bill {id} soft-deleted"),
                    Ok(false) => {
                        eprintln!("data harness-bill delete: no active bill with id {id}");
                        std::process::exit(1);
                    }
                    Err(e) => {
                        eprintln!("data harness-bill delete failed: {e}");
                        std::process::exit(2);
                    }
                }
            }
            other => {
                eprintln!("data harness-bill: unknown action {other}");
                std::process::exit(2);
            }
        }
        return;
    }

    // data-export-private / data-export-redacted（Stage C，spec §6；v0.9.1
    // Phase 3.6 起数据源 = SQL 权威库，spec §9）：两条独立写路径——私有 trace
    // 原样、脱敏导出重导身份。命令面分开正是 spec「不能由一个 redacted: bool
    // 决定」的落地。字段映射与锁语义（SQL 快照，不再拿 .ingest.lock）见
    // runtime::export 模块头。
    if let Some(Cmd::DataExportPrivate { out }) = &args.cmd {
        match agent_vitals_runtime::export::export_private(
            &agent_vitals_runtime::home::data_home(),
            out,
        ) {
            Ok(files) => println!("Private export: {} fact file(s) → {}", files, out.display()),
            Err(e) => {
                eprintln!("data-export-private failed: {e}");
                std::process::exit(2);
            }
        }
        return;
    }
    if let Some(Cmd::DataExportRedacted { out }) = &args.cmd {
        match agent_vitals_runtime::export::export_redacted(
            &agent_vitals_runtime::home::data_home(),
            out,
        ) {
            Ok((files, n)) => println!(
                "Redacted export: {} fact(s) in {} file(s) → {}",
                n,
                files,
                out.display()
            ),
            Err(e) => {
                eprintln!("data-export-redacted failed: {e}");
                std::process::exit(2);
            }
        }
        return;
    }

    // data-unresolved（Stage B）：has_unresolved 的逐模型下钻（DoD #4）。
    if let Some(Cmd::BillingGroups { month, rows_json }) = &args.cmd {
        let month = month
            .clone()
            .unwrap_or_else(agent_vitals_runtime::clock::current_month_beijing);
        let report = match agent_vitals_runtime::summary::SqlSummaryRepository::new().open_db() {
            Some(db) => agent_vitals_runtime::billing_preview::confirmation_groups(&db, &month),
            None => serde_json::json!({"status": "unavailable", "month": month, "groups": [], "clusters": []}),
        };
        if *rows_json {
            println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
        } else {
            println!("Billing confirmation clusters (month {month}, status {}):", report["status"].as_str().unwrap_or("?"));
            println!("  (~vendor = billing party still open; the row is the model vendor's)");
            for c in report["clusters"].as_array().map(|a| a.iter()).into_iter().flatten() {
                let v = &c["auto_verdict"];
                // 网关行的 `billing_party` 恒空，只印它会让同执行环境的多行长得一模一样
                // （簇主键含 model_vendor 才拆开，人眼却看不到那个维度）。
                let party = match (v["billing_party"].as_str(), v["model_vendor"].as_str()) {
                    (Some(party), _) => party.to_string(),
                    (None, Some(vendor)) => format!("~{vendor}"),
                    (None, None) => "<unknown>".to_string(),
                };
                println!(
                    "  {:<12} {:<12} {:<12} {:<18} {:<21} models={:<2} tokens={:<12} basis={}",
                    c["harness"].as_str().unwrap_or("?"),
                    party,
                    v["state"].as_str().unwrap_or("?"),
                    v["route_state"].as_str().unwrap_or("?"),
                    v["relationship_kind"].as_str().unwrap_or("-"),
                    c["models"].as_array().map_or(0, Vec::len),
                    c["tokens"],
                    v["basis"].as_array().map(|b| b.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("+")).unwrap_or_default(),
                );
            }
        }
        return;
    }
    if let Some(Cmd::DataUnresolved { month, rows_json }) = &args.cmd {
        let month = month
            .clone()
            .unwrap_or_else(agent_vitals_runtime::clock::current_month_beijing);
        let detail = agent_vitals_runtime::summary::unresolved_detail(&month);
        if *rows_json {
            let out = serde_json::json!({"month": month, "providers": detail});
            println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        } else {
            println!("Unresolved usage detail (month {month}):");
            let mut any = false;
            for (prov, rows) in detail.as_object().map(|m| m.iter()).into_iter().flatten() {
                for r in rows.as_array().map(|a| a.iter()).into_iter().flatten() {
                    any = true;
                    println!(
                        "  {:<24} {:<28} {:<22} tokens={}",
                        prov,
                        r["model"].as_str().unwrap_or("?"),
                        r["reason"].as_str().unwrap_or("?"),
                        r["tokens"],
                    );
                }
            }
            if !any {
                println!("  (none — all measured usage is priced and routed)");
            }
        }
        return;
    }

    // data-reimport-verify（spec §8.1.2 / Q12）：两个临时库重放比对，不碰生产库。
    // reconciled → exit 0；发现未解释差异 → exit 1（open data quality issue）；
    // 跑不起来（facts 损坏等）→ exit 2。
    if let Some(Cmd::DataReimportVerify { rows_json }) = &args.cmd {
        let data_home = agent_vitals_runtime::home::data_home();
        match agent_vitals_runtime::reimport_verify::run(&data_home) {
            Ok(report) => {
                if *rows_json {
                    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
                } else {
                    let verified = report["verified"].as_bool().unwrap_or(false);
                    println!(
                        "Reimport verify: {} ({} rounds, {} harness-months, facts A={} B={}, swept interrupted={})",
                        if verified { "VERIFIED — byte-identical" } else { "MISMATCH" },
                        report["rounds"],
                        report["buckets_compared"],
                        report["facts_round_a"],
                        report["facts_round_b"],
                        report["interrupted_runs_swept"],
                    );
                    for d in report["diffs"].as_array().map(|a| a.iter()).into_iter().flatten() {
                        println!(
                            "  DIFF {}/{}: A={} B={}",
                            d["harness"], d["bj_month"], d["round_a"], d["round_b"]
                        );
                    }
                }
                if !report["verified"].as_bool().unwrap_or(false) {
                    std::process::exit(1);
                }
            }
            Err(e) => {
                eprintln!("data-reimport-verify failed: {e}");
                std::process::exit(2);
            }
        }
        return;
    }

    // WorkBuddy 会话审计。与 claude/codex-session 同款 home 解析与缺省 --session =
    // 最新；SV604/605 的 Unavailable 覆盖在 workbuddy_session.rs（harness-capability
    // degradation，spec §3.1）。db 无行且 audit-log 无记录 → 不存在（exit 2）。
    if let Some(Cmd::WorkbuddySession {
        list,
        session,
        rows_json,
    }) = &args.cmd
    {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        let home_path = Path::new(&home);
        if *list {
            let out = agent_vitals_harnesses::workbuddy_session::workbuddy_session_list(home_path);
            if let Some(path) = rows_json {
                let text = serde_json::to_string_pretty(&out).unwrap_or_default();
                if path == &PathBuf::from("-") {
                    println!("{text}");
                } else if std::fs::write(path, &text).is_err() {
                    eprintln!("failed to write {}", path.display());
                    std::process::exit(2);
                } else {
                    println!("Wrote {}", path.display());
                }
            } else {
                print!(
                    "{}",
                    agent_vitals_harnesses::workbuddy_session::render_workbuddy_session_list(&out)
                );
            }
            return;
        }
        // 缺省 --session = 最新（list 排序首项 = updated_at 最晚）。
        let session_id = match session {
            Some(s) => s.clone(),
            None => {
                let list = agent_vitals_harnesses::workbuddy_session::workbuddy_session_list(home_path);
                let first = list
                    .get("sessions")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                    .and_then(|v| v.get("session_id"))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                match first {
                    Some(s) => s,
                    None => {
                        eprintln!("no workbuddy sessions found");
                        std::process::exit(2);
                    }
                }
            }
        };
        let Some(out) = agent_vitals_harnesses::workbuddy_session::workbuddy_session_audit_json(
            home_path,
            &session_id,
        ) else {
            eprintln!("workbuddy session not found or unreadable: {session_id}");
            std::process::exit(2);
        };
        let text = serde_json::to_string_pretty(&out).unwrap_or_default();
        if let Some(path) = rows_json {
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}", path.display());
            }
        } else {
            println!("{text}");
        }
        return;
    }

    // v0.9.1 SQL 权威库收口（PR #2）：`sessions list` / `read` / `navigation`
    // 改走 `mcp::dispatch`，envelope 与 MCP `tools/call` 同源；`findings` 读权威库
    // issue 分组（W8：由同步后的 findings_eval 产出），session_detail 另外返回
    // SQL workflow 事件轴。
    if let Some(Cmd::Probe { action }) = &args.cmd {
        let data_home = agent_vitals_runtime::home::data_home();
        let db_path = agent_vitals_data::authority::default_authority_path(&data_home);
        if !db_path.exists() {
            eprintln!("authority database not found at {} — run a sync first", db_path.display());
            std::process::exit(2);
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis() as i64)
            .unwrap_or_default();
        let db = match agent_vitals_data::authority::AuthorityDb::open(&db_path, now_ms) {
            Ok(db) => db,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        };
        let conn = db.conn();
        // 「当前路线」行的 ensure（spec §0 v1.2）：无存储凭据、无端点注入——
        // endpoint 刻意 NULL，让 claude 完全按自己的 settings 发起（测的才是
        // 「现在生效的路线」）。consent 在建行时即置：该行没有 credential_ref，
        // consent 门针对的「用存储凭据发起计费请求」不适用；知情动作由调用方
        // （UI 两击布防 / CLI 用户本人）承担。put_route 冲突时保留既有 consent、
        // 只刷模型/标签（模型可被 --model 反复改写）。
        fn ensure_current_route_row(
            conn: &rusqlite::Connection,
            model_override: Option<&str>,
            now_ms: i64,
        ) -> String {
            let hint = std::env::var_os("HOME")
                .as_deref()
                .map(std::path::Path::new)
                .and_then(agent_vitals_probe::current_route::read_claude_settings_hint);
            let model = model_override
                .map(str::to_string)
                .or_else(|| hint.as_ref().and_then(|h| h.model.clone()))
                .unwrap_or_else(|| "claude-sonnet-5".to_string());
            let route = agent_vitals_data::probe::ProbeRoute {
                route_id: agent_vitals_probe::current_route::CURRENT_ROUTE_ID.to_string(),
                label: "当前配置（执行环境现在实际使用的路线）".to_string(),
                harness_kind: "claude-code".to_string(),
                endpoint_base_url: None,
                credential_ref: None,
                model_requested: model,
                consent_granted_at_ms: Some(now_ms),
            };
            if let Err(error) = agent_vitals_data::probe::put_route(conn, &route, now_ms) {
                eprintln!("{error}");
                std::process::exit(2);
            }
            route.route_id
        }
        match action {
            ProbeAction::RoutesAdd { from_cc_switch, route_id, label, harness_kind, endpoint, credential_ref, model } => {
                if *from_cc_switch {
                    if route_id.is_some() || label.is_some() || endpoint.is_some() || credential_ref.is_some() || model.is_some() {
                        eprintln!("--from-cc-switch 与 --label/--model/--route-id/--endpoint/--credential-ref 互斥（发现式注册不手填字段）");
                        std::process::exit(2);
                    }
                    let Some(home) = std::env::var_os("HOME") else {
                        eprintln!("--from-cc-switch 需要 $HOME（cc-switch 库在 ~/.cc-switch）");
                        std::process::exit(2);
                    };
                    let report = match agent_vitals_probe::discover::scan_ccswitch(Path::new(&home)) {
                        Ok(report) => report,
                        Err(error) => {
                            eprintln!("{error}");
                            std::process::exit(2);
                        }
                    };
                    let mut entries = Vec::new();
                    for route in &report.routes {
                        let route_id = agent_vitals_domain::source_identity::fnv1a64_hex(
                            format!("{}|{harness_kind}", route.label).as_bytes(),
                        );
                        // 已存在的档案不动（put_route 虽保留 consent，但重复注册
                        // 会把 updated_at 无意义地刷新；幂等以「存在即跳过」为准）。
                        let exists: bool = conn
                            .query_row(
                                "SELECT 1 FROM probe_routes WHERE route_id = ?1",
                                rusqlite::params![route_id],
                                |_| Ok(()),
                            )
                            .is_ok();
                        if exists {
                            entries.push(serde_json::json!({
                                "route_id": route_id,
                                "label": route.label,
                                "model": route.model,
                                "endpoint": route.base_url,
                                "credential_ref": format!("ccswitch:{}", route.provider_row),
                                "status": "exists",
                            }));
                            continue;
                        }
                        let stored = agent_vitals_data::probe::ProbeRoute {
                            route_id: route_id.clone(),
                            label: route.label.clone(),
                            harness_kind: harness_kind.clone(),
                            endpoint_base_url: Some(route.base_url.clone()),
                            credential_ref: Some(format!("ccswitch:{}", route.provider_row)),
                            model_requested: route.model.clone(),
                            consent_granted_at_ms: None,
                        };
                        if let Err(error) = agent_vitals_data::probe::put_route(conn, &stored, now_ms) {
                            eprintln!("{error}");
                            std::process::exit(2);
                        }
                        entries.push(serde_json::json!({
                            "route_id": route_id,
                            "label": route.label,
                            "model": route.model,
                            "endpoint": route.base_url,
                            "credential_ref": format!("ccswitch:{}", route.provider_row),
                            "status": "added",
                            "next": format!("agent-vitals probe consent --route-id {route_id}"),
                        }));
                    }
                    println!(
                        "{}",
                        serde_json::json!({
                            "routes": entries,
                            "skipped": report.skipped,
                            "hint": "凭据只存 ccswitch:<provider-row> 引用；consent 逐条显式授予。",
                        })
                    );
                } else {
                    let (Some(label), Some(model)) = (label.clone(), model.clone()) else {
                        eprintln!("routes-add 需要 --label 与 --model（或改用 --from-cc-switch 扫描发现）");
                        std::process::exit(2);
                    };
                    let route_id = route_id.clone().unwrap_or_else(|| {
                        agent_vitals_domain::source_identity::fnv1a64_hex(
                            format!("{label}|{harness_kind}").as_bytes(),
                        )
                    });
                    let route = agent_vitals_data::probe::ProbeRoute {
                        route_id: route_id.clone(),
                        label: label.clone(),
                        harness_kind: harness_kind.clone(),
                        endpoint_base_url: endpoint.clone(),
                        credential_ref: credential_ref.clone(),
                        model_requested: model.clone(),
                        consent_granted_at_ms: None,
                    };
                    if let Err(error) = agent_vitals_data::probe::put_route(conn, &route, now_ms) {
                        eprintln!("{error}");
                        std::process::exit(2);
                    }
                    println!(
                        "{{\"route_id\": \"{route_id}\", \"consent\": \"none\", \"next\": \"agent-vitals probe consent --route-id {route_id}\"}}"
                    );
                }
            }
            ProbeAction::Routes { json } => {
                let mut stmt = match conn.prepare(
                    "SELECT route_id, label, harness_kind, endpoint_base_url, credential_ref,
                            model_requested, consent_granted_at_ms
                     FROM probe_routes ORDER BY created_at_ms",
                ) {
                    Ok(stmt) => stmt,
                    Err(error) => {
                        eprintln!("{error}");
                        std::process::exit(2);
                    }
                };
                let rows = stmt.query_map([], |row| {
                    Ok(serde_json::json!({
                        "route_id": row.get::<_, String>(0)?,
                        "label": row.get::<_, String>(1)?,
                        "harness_kind": row.get::<_, String>(2)?,
                        "endpoint_base_url": row.get::<_, Option<String>>(3)?,
                        "credential_ref": row.get::<_, Option<String>>(4)?,
                        "model_requested": row.get::<_, String>(5)?,
                        "consent_granted_at_ms": row.get::<_, Option<i64>>(6)?,
                    }))
                });
                let mut routes = Vec::new();
                match rows {
                    Ok(rows) => {
                        for row in rows {
                            match row {
                                Ok(value) => routes.push(value),
                                Err(error) => {
                                    eprintln!("{error}");
                                    std::process::exit(2);
                                }
                            }
                        }
                    }
                    Err(error) => {
                        eprintln!("{error}");
                        std::process::exit(2);
                    }
                }
                if *json {
                    println!("{}", serde_json::to_string_pretty(&routes).unwrap_or_default());
                } else {
                    for route in &routes {
                        let consent = if route["consent_granted_at_ms"].is_null() { "未授权" } else { "已授权" };
                        println!(
                            "{}\t{}\t{}\t{}\t[{}]",
                            route["route_id"].as_str().unwrap_or("?"),
                            route["label"].as_str().unwrap_or("?"),
                            route["model_requested"].as_str().unwrap_or("?"),
                            route["credential_ref"].as_str().unwrap_or("官方直连"),
                            consent,
                        );
                    }
                }
            }
            ProbeAction::Consent { route_id } => {
                if let Err(error) = agent_vitals_data::probe::grant_consent(conn, route_id, now_ms) {
                    eprintln!("{error}");
                    std::process::exit(2);
                }
                println!("consent granted for route {route_id} (发起探针即代表请求将经过该路线的中转商)");
            }
            ProbeAction::Current { json } => {
                let hint = std::env::var_os("HOME")
                    .as_deref()
                    .map(std::path::Path::new)
                    .and_then(agent_vitals_probe::current_route::read_claude_settings_hint);
                let value = serde_json::json!({
                    "route_id": agent_vitals_probe::current_route::CURRENT_ROUTE_ID,
                    "base_url": hint.as_ref().and_then(|h| h.base_url.clone()),
                    "model": hint.as_ref().and_then(|h| h.model.clone()),
                    "note": "白名单读取 ~/.claude/settings.json（base_url/model）；凭据不读。",
                });
                if *json {
                    println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default());
                } else {
                    println!("当前路线：{}", value["base_url"].as_str().unwrap_or("官方直连（无自定义端点）"));
                    println!("默认模型：{}", value["model"].as_str().unwrap_or("（未配置）"));
                }
            }
            ProbeAction::Run { route_a, route_b, model, repeats, max_probes, claude_bin } => {
                let route_a = if route_a == "current" {
                    ensure_current_route_row(conn, model.as_deref(), now_ms)
                } else {
                    if model.is_some() {
                        eprintln!("--model 只与 --route-a current 搭配（普通路线的模型来自档案）");
                        std::process::exit(2);
                    }
                    route_a.clone()
                };
                let config = agent_vitals_probe::runner::RunConfig {
                    route_a,
                    route_b: route_b.clone(),
                    repeats: *repeats,
                    max_probes: *max_probes,
                    claude_bin: claude_bin.clone(),
                };
                match agent_vitals_probe::runner::execute(&db, &config, now_ms) {
                    Ok(run_id) => {
                        let report = agent_vitals_data::probe::run_report(conn, &run_id)
                            .ok()
                            .flatten()
                            .unwrap_or(serde_json::json!({}));
                        println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
                    }
                    Err(error) => {
                        eprintln!("{error}");
                        std::process::exit(2);
                    }
                }
            }
            ProbeAction::Status { run_id } => {
                match agent_vitals_data::probe::get_run(conn, run_id) {
                    Ok(Some(run)) => println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                        "run_id": run.run_id, "mode": run.mode, "status": run.status,
                        "route_a_id": run.route_a_id, "route_b_id": run.route_b_id,
                        "n_repeats": run.n_repeats,
                        "started_at_ms": run.started_at_ms, "finished_at_ms": run.finished_at_ms,
                    })).unwrap_or_default()),
                    Ok(None) => {
                        eprintln!("run '{run_id}' not found");
                        std::process::exit(2);
                    }
                    Err(error) => {
                        eprintln!("{error}");
                        std::process::exit(2);
                    }
                }
            }
            ProbeAction::Report { run_id } => {
                match agent_vitals_data::probe::run_report(conn, run_id) {
                    Ok(Some(report)) => println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default()),
                    Ok(None) => {
                        eprintln!("run '{run_id}' not found");
                        std::process::exit(2);
                    }
                    Err(error) => {
                        eprintln!("{error}");
                        std::process::exit(2);
                    }
                }
            }
        }
        return;
    }

    if let Some(Cmd::RoutesQuality { days, json }) = &args.cmd {
        let data_home = agent_vitals_runtime::home::data_home();
        let db_path = agent_vitals_data::authority::default_authority_path(&data_home);
        if !db_path.exists() {
            eprintln!("authority database not found at {} — run a sync first", db_path.display());
            std::process::exit(2);
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis() as i64)
            .unwrap_or_default();
        let since_ms = now_ms.saturating_sub((*days as i64) * 86_400_000);
        let db = match agent_vitals_data::authority::AuthorityDb::open(&db_path, now_ms) {
            Ok(db) => db,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        };
        match agent_vitals_data::route_quality::route_quality_summary(db.conn(), since_ms, now_ms) {
            Ok(report) => {
                if *json {
                    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
                } else {
                    // 人读面：每执行环境一段，族行 = 请求占比 + 请求/会话/token。
                    let text = |value: &serde_json::Value| value.as_str().unwrap_or("?").to_string();
                    let num = |value: &serde_json::Value| value.as_i64().unwrap_or(0);
                    for harness in report["harnesses"].as_array().unwrap_or(&Vec::new()) {
                        println!("== {}（{} 请求 / {} 会话，近 {} 天）",
                            text(&harness["harness"]), num(&harness["totals"]["requests"]), num(&harness["totals"]["sessions"]), days);
                        for family in harness["families"].as_array().unwrap_or(&Vec::new()) {
                            println!("  {:<10} {:>5}%  {:>6} 请求  {:>4} 会话  {:>14} tokens  [{}]",
                                text(&family["family"]),
                                family["request_share"].as_f64().unwrap_or(0.0),
                                num(&family["requests"]),
                                num(&family["sessions"]),
                                num(&family["tokens_total"]),
                                text(&family["flag"]),
                            );
                            for model in family["models"].as_array().unwrap_or(&Vec::new()) {
                                println!("      - {:<34} {:>6} 请求  provider={}",
                                    text(&model["model"]),
                                    num(&model["requests"]),
                                    text(&model["provider_raw"]),
                                );
                            }
                        }
                    }
                }
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
        return;
    }

    if let Some(Cmd::Sessions { action }) = &args.cmd {
        let data_home = agent_vitals_runtime::home::data_home();
        match action {
            SessionsAction::List {
                day,
                month,
                date_from,
                date_to,
                hour,
                harness_kind,
                model,
                provider,
                min_tokens,
                page_size,
                cursor,
                order,
                json,
            } => {
                // 严格校验三种时间窗形态：单日、月份、成对自定义日期范围。
                // `mcp::dispatch` 仍会做格式和日期合法性校验；CLI 先拒绝结构
                // 歧义，给出更清晰的错误。
                let range_pair = date_from.is_some() == date_to.is_some();
                let window_shape_ok = range_pair
                    && matches!(
                        (day.is_some(), month.is_some(), date_from.is_some()),
                        (true, false, false) | (false, true, false) | (false, false, true)
                    );
                if !window_shape_ok {
                        eprintln!(
                            "use exactly one of --day, --month, or the paired --from-date / --to-date"
                        );
                        std::process::exit(2);
                }
                let mut args = serde_json::Map::new();
                if let Some(d) = day {
                    args.insert("date".into(), Value::String(d.clone()));
                }
                if let Some(m) = month {
                    args.insert("month".into(), Value::String(m.clone()));
                }
                if let Some(d) = date_from {
                    args.insert("date_from".into(), Value::String(d.clone()));
                }
                if let Some(d) = date_to {
                    args.insert("date_to".into(), Value::String(d.clone()));
                }
                if let Some(h) = hour {
                    args.insert("hour".into(), Value::Number((*h).into()));
                }
                if !harness_kind.is_empty() {
                    args.insert(
                        "harnesses".into(),
                        Value::Array(harness_kind.iter().cloned().map(Value::String).collect()),
                    );
                }
                if let Some(model) = model {
                    args.insert("model".into(), Value::String(model.clone()));
                }
                if let Some(provider) = provider {
                    args.insert("provider".into(), Value::String(provider.clone()));
                }
                if let Some(mt) = min_tokens {
                    args.insert("min_tokens".into(), Value::Number((*mt).into()));
                }
                args.insert(
                    "limit".into(),
                    Value::Number(serde_json::Number::from(*page_size)),
                );
                if let Some(c) = cursor {
                    args.insert("cursor".into(), Value::String(c.clone()));
                }
                if order != "tokens" {
                    args.insert("order".into(), Value::String(order.clone()));
                }
                dispatch_sessions("sessions_search", Value::Object(args), *json, &data_home);
            }
            SessionsAction::Read {
                session_ref,
                page_size,
                cursor,
                json,
            } => {
                let mut args = serde_json::Map::new();
                args.insert(
                    "session_ref".into(),
                    Value::String(session_ref.clone()),
                );
                args.insert(
                    "limit".into(),
                    Value::Number(serde_json::Number::from(*page_size)),
                );
                if let Some(c) = cursor {
                    args.insert("cursor".into(), Value::String(c.clone()));
                }
                dispatch_sessions("session_detail", Value::Object(args), *json, &data_home);
            }
            SessionsAction::Findings { json } => {
                // W8：行为 findings 唯一生产者是同步后的评估器（ingest::findings_eval，
                // 取代 r2a SessionStore）。先同步一轮——只用 CLI、不开桌面的用户也要拿到
                // 最新评估；再读权威库的 issue 组，与 React Findings 页同一数据源。
                // 同步失败不阻断读：已落库的评估仍是真实数据，失败如实上 stderr。
                if let Err(error) = agent_vitals_runtime::ingest::sync_service::sync_facts(&data_home) {
                    eprintln!("sync before findings failed (showing last evaluated findings): {error}");
                }
                print_findings(&data_home, *json);
            }
            SessionsAction::Navigation {
                day,
                timezone,
                recent,
                json,
            } => {
                // `main` has already applied the persisted preference to TZ.  Do not
                // put a Beijing default in the CLI: a clean install follows the OS
                // timezone and a configured install follows its saved preference.
                let timezone = timezone
                    .clone()
                    .unwrap_or_else(agent_vitals_runtime::clock::statistics_timezone_name);
                if let Err(error) = agent_vitals_runtime::statistics_timezone::validate_timezone(&timezone) {
                    eprintln!("invalid --timezone {timezone:?}: {error}");
                    std::process::exit(2);
                }
                // 显式参数优先于持久化值；Tauri 传入的也是同一份偏好。
                std::env::set_var("TZ", &timezone);
                // `--day` 缺省 = 当前统计时区的今天。
                let day = if day.is_empty() {
                    agent_vitals_runtime::sessions::codex_cost::today_beijing()
                } else {
                    day.clone()
                };
                sessions_navigation_v2(&day, &timezone, *recent, *json, &data_home);
            }
        }
        return;
    }

    // 预算告警只读路径。Phase 4.3：`budget_show`/`budget_show_month` 读 SQL
    // 权威库（`evaluate_alert_from_sql` / `month_cost_sql`），不再读 today.json
    // / month.json（spec §5.2 禁读清单）。决策仍在 core（`evaluate_alert`）。
    if let Some(Cmd::Budget {
        action,
        month,
        json,
    }) = &args.cmd
    {
        match action.as_str() {
            "show" => {
                if let Some(m) = month {
                    agent_vitals_runtime::budget::budget_show_month(m, *json);
                } else {
                    agent_vitals_runtime::budget::budget_show(*json);
                }
            }
            // clap value_parser 只放行 "show"，这里不可达 —— 防御性保留，
            // R1c 加写路径时替换成真分支。
            other => {
                eprintln!("budget action not implemented in Rust yet: {other}");
                std::process::exit(2);
            }
        }
        return;
    }

    // v0.9.1 Phase 3.4 SQL 预算面：budget_config/budget_snoozes 显式管理 API
    // + budget_status_sql（替代 alert.json/budget.json 的读面；Tier B 切完
    // 托盘预算卡后旧链停写）。金额全 minor 整数；错误路径 exit 2。
    if let Some(Cmd::BudgetSql {
        action,
        month,
        monthly_cny_minor,
        daily_cny_minor,
        warning_ratio_bp,
        until,
        profile,
        currency,
        profile_monthly_minor,
        profile_daily_minor,
        profile_warning_ratio_bp,
    }) = &args.cmd
    {
        let db = || -> agent_vitals_data::authority::AuthorityDb {
            match agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(
                    &agent_vitals_runtime::home::data_home(),
                ),
                agent_vitals_runtime::sql_sync::now_ms(),
            ) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("budget-sql failed: {e}");
                    std::process::exit(2);
                }
            }
        };
        match action.as_str() {
            "status" => {
                let m = month
                    .clone()
                    .unwrap_or_else(agent_vitals_runtime::clock::current_month_beijing);
                match agent_vitals_runtime::budget::budget_status_sql(&m) {
                    Some(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                    None => {
                        eprintln!("budget-sql status failed: authority DB unavailable");
                        std::process::exit(2);
                    }
                }
            }
            "profiles" => {
                let m = month
                    .clone()
                    .unwrap_or_else(agent_vitals_runtime::clock::current_month_beijing);
                match agent_vitals_runtime::budget::budget_profiles_status_sql_at(
                    &agent_vitals_runtime::home::data_home(), &m,
                ) {
                    Some(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                    None => {
                        eprintln!("budget-sql profiles failed: authority DB unavailable");
                        std::process::exit(2);
                    }
                }
            }
            "profile-set" => {
                let (Some(profile), Some(currency), Some(monthly)) =
                    (profile, currency, profile_monthly_minor) else {
                    eprintln!("profile-set requires --profile, --currency and --profile-monthly-minor");
                    std::process::exit(2);
                };
                let d0 = db();
                match d0.budget_profile_set(
                    profile, currency, *monthly, *profile_daily_minor,
                    profile_warning_ratio_bp.unwrap_or(8_000),
                    agent_vitals_runtime::sql_sync::now_ms(),
                ) {
                    Ok(()) => println!("budget profile saved: {profile} {currency} monthly={monthly}"),
                    Err(e) => {
                        eprintln!("budget-sql profile-set failed: {e}");
                        std::process::exit(2);
                    }
                }
            }
            "alert" => {
                // SQL 权威面的 `budget show` 等价物：evaluate_alert 从权威库算
                // （跨执行环境按量 CNY 口径），不读 today.json/month.json/alert.json。
                let v = agent_vitals_runtime::budget::evaluate_alert_from_sql(
                    &agent_vitals_runtime::home::data_home(),
                );
                println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            }
            "config-show" => {
                let d = db();
                match d.budget_config_get() {
                    Ok(Some(c)) => println!(
                        "{}",
                        serde_json::to_string_pretty(&json!({
                            "monthly_cny_minor": c.monthly_cny_minor,
                            "daily_cny_minor": c.daily_cny_minor,
                            "warning_ratio_bp": c.warning_ratio_bp,
                            "updated_at_ms": c.updated_at_ms,
                        }))
                        .unwrap_or_default()
                    ),
                    Ok(None) => println!("(no budget config — use config-set or let status seed from legacy config.toml)"),
                    Err(e) => {
                        eprintln!("budget-sql config-show failed: {e}");
                        std::process::exit(2);
                    }
                }
            }
            "config-set" => {
                let (Some(m), Some(d)) = (monthly_cny_minor, daily_cny_minor) else {
                    eprintln!("config-set requires --monthly-cny-minor and --daily-cny-minor");
                    std::process::exit(2);
                };
                if *m < 0 || *d < 0 || warning_ratio_bp.is_some_and(|w| !(0..=10_000).contains(&w))
                {
                    eprintln!("config-set: amounts must be non-negative; warning-ratio-bp within 0..=10000");
                    std::process::exit(2);
                }
                let d0 = db();
                match d0.budget_config_set(
                    *m,
                    *d,
                    warning_ratio_bp.unwrap_or(8_000),
                    agent_vitals_runtime::sql_sync::now_ms(),
                ) {
                    Ok(()) => println!(
                        "budget config saved: monthly={m} daily={d} warn_bp={}",
                        warning_ratio_bp.unwrap_or(8_000)
                    ),
                    Err(e) => {
                        eprintln!("budget-sql config-set failed: {e}");
                        std::process::exit(2);
                    }
                }
            }
            "snooze-set" => {
                let Some(u) = until else {
                    eprintln!("snooze-set requires --until <ISO datetime>");
                    std::process::exit(2);
                };
                // 解析在 runtime 侧做（iso_to_ms_beijing 未导出——这里经
                // budget_status_sql 的伴生入口直接传串，由 runtime 解析并
                // 落库；解析失败如实报错不猜时区）。
                match agent_vitals_runtime::budget::budget_snooze_set_sql(u) {
                    Ok(ms) => println!("snoozed until {u} (until_ms={ms})"),
                    Err(e) => {
                        eprintln!("budget-sql snooze-set failed: {e}");
                        std::process::exit(2);
                    }
                }
            }
            "snooze-clear" => {
                let d0 = db();
                match d0.budget_snooze_clear() {
                    Ok(()) => println!("snooze cleared"),
                    Err(e) => {
                        eprintln!("budget-sql snooze-clear failed: {e}");
                        std::process::exit(2);
                    }
                }
            }
            other => {
                eprintln!("budget-sql action not implemented: {other}");
                std::process::exit(2);
            }
        }
        return;
    }

    // 导航状态写链。业务数据不可由此命令写入或读取：SQL authority 是唯一来源。
    if let Some(Cmd::State { action }) = &args.cmd {
        use agent_vitals_runtime::state as st;
        let read_input = |p: &PathBuf| -> serde_json::Value {
            let text = std::fs::read_to_string(p).unwrap_or_else(|e| {
                eprintln!("cannot read {p:?}: {e}");
                std::process::exit(2);
            });
            serde_json::from_str(&text).unwrap_or_else(|e| {
                eprintln!("invalid JSON in {p:?}: {e}");
                std::process::exit(2);
            })
        };
        match action {
            StateAction::WriteOneline { summary } => {
                st::write_oneline(&read_input(summary));
            }
            StateAction::AppendHistory { summary } => {
                st::append_session_history(&read_input(summary));
            }
            StateAction::FoldSession { req, shadow } => {
                use agent_vitals_runtime::takeover::FoldOutcome;
                match agent_vitals_runtime::takeover::fold_session(&read_input(req), *shadow) {
                    Ok(FoldOutcome::Folded) => println!(r#"{{"outcome":"folded"}}"#),
                    Ok(FoldOutcome::SkippedAlreadyFolded) => {
                        println!(r#"{{"outcome":"skipped"}}"#);
                    }
                    Err(msg) => {
                        eprintln!("{msg}");
                        std::process::exit(2);
                    }
                }
            }
            StateAction::Takeover { owner } => {
                agent_vitals_runtime::takeover::takeover(owner);
                println!("owner switched to {owner}");
            }
            StateAction::MachineNamespace => {
                println!("{}", agent_vitals_runtime::takeover::machine_namespace());
            }
        }
        return;
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let home_n = norm(&PathBuf::from(&home));
    let cwd_n = std::env::current_dir()
        .map(|p| norm(&p))
        .unwrap_or_default();

    // 默认预算取自环境变量。口径随 Claude Code 版本变化，故做成可配置。
    let default_budget: i64 = std::env::var("SLASH_COMMAND_TOOL_CHAR_BUDGET")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(15000);
    let budget = args.budget.unwrap_or(default_budget);

    // 扫描器自身所在的 skill 根目录：安全扫描要排除它（不变量 5）
    let self_root = args.self_root.clone().or_else(detect_self_root);

    let ctx = Ctx {
        home_n: home_n.clone(),
        cwd_n: cwd_n.clone(),
        self_root,
    };

    let cfg = agent_vitals_harnesses::harnesses::claude_code::sources::skills::read_harness_config(&home_n);

    // Session surface 负责读日志；Skill surface 只消费注入的证据。
    let (dsh_path, dsh_evidence) =
        agent_vitals_runtime::session_sources::read_dsh_skill_correlation();
    let inv = agent_vitals_runtime::skills::inventory::take(
        &agent_vitals_runtime::skills::inventory::Selection {
            harness: &args.harness,
            extra_paths: &args.path,
            runtime_json: args.runtime_json.as_deref(),
        },
        &home_n,
        &cfg,
        &ctx,
        agent_vitals_runtime::skills::inventory::SessionEvidenceInput {
            dsh_path,
            dsh: dsh_evidence,
        },
    );

    // 采集到此为止；下面全是纯数据变换，交给 report。
    let rep = skills::report::build(&skills::report::ReportInput {
        harness: &args.harness,
        all: args.all,
        budget,
        zombie_age: args.zombie_age,
        split_threshold: args.split_threshold,
        home_n: &home_n,
        inv: &inv,
        cfg: &cfg,
    });
    let mut doc = rep.doc;

    // 快照要在**算完 diff 之后**才写，否则这一次会拿自己当基线，变化段永远
    // 是空的 —— 一个看起来在工作、实际什么都没比的功能。
    let auto_snapshot = matches!(&args.cmd, None | Some(Cmd::Doctor { .. }))
        && !args.no_snapshot
        && args.json.is_none()
        && !matches!(
            &args.cmd,
            Some(Cmd::Doctor {
                rows_json: Some(_),
                ..
            })
        );
    let baseline: Option<PathBuf> = args.baseline.clone().or_else(|| {
        match &args.cmd {
            Some(Cmd::Diff { file, .. }) => file
                .clone()
                .or_else(agent_vitals_runtime::skills::snapshot::latest_snapshot),
            // --new-only 也要找基线。**不能只挂在 auto_snapshot 上** ——
            // `--no-snapshot` 的语义是「别写」，不是「别比」。
            _ if auto_snapshot || args.new_only => {
                agent_vitals_runtime::skills::snapshot::latest_snapshot()
            }
            _ => None,
        }
    });
    if let Some(b) = &baseline {
        // 先算完再插入：diff 要读 doc 的内容，不能在可变借用期间读
        let d = skills::diff::diff_against(b, &doc);
        doc.as_object_mut()
            .unwrap()
            .insert("diff_vs_baseline".into(), d);
    }

    if args.redact || args.redact_names {
        doc = skills::redact::redact(&doc, args.redact_names, &home_n, &cwd_n);
        doc.as_object_mut().unwrap().insert(
            "redacted".into(),
            json!({
                "paths": true,
                "names": args.redact_names,
                "note": "This output is redacted for sharing. Run a new scan to obtain the original data.",
            }),
        );
    }

    // v0.9 Stage 0.5 Data Query API（只读诊断）。数据面经 trait——CLI 拿到
    // 的是 `Box<dyn SummaryRepository>`，不 new 具体类型到调用点之外、不读
    // 任何 state 文件（spec §3.1 依赖表：apps 只消费 Runtime 的版本化 DTO）。
    // Phase 4.3：`SummaryRepository` 只剩 `SqlSummaryRepository` 一个实现，
    // legacy `JsonSummaryRepository` 已删——读源只有 SQL 权威库一处。
    if let Some(Cmd::Data { action }) = &args.cmd {
        let repo: Box<dyn agent_vitals_data::repository::SummaryRepository> =
            Box::new(agent_vitals_runtime::summary::SqlSummaryRepository::new());
        match action {
            DataAction::Coverage { month, json } => {
                let m = month
                    .clone()
                    .unwrap_or_else(agent_vitals_runtime::clock::current_month_beijing);
                let summary =
                    repo.monthly_summary(&agent_vitals_data::repository::MonthlySummaryQuery {
                        month: m,
                    });
                if *json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&summary.to_json()).unwrap_or_default()
                    );
                } else {
                    print_monthly_summary_text(&summary);
                }
            }
            DataAction::Daily { date, json } => {
                let summary =
                    repo.daily_summary(&agent_vitals_data::repository::DailySummaryQuery {
                        date: date.clone(),
                    });
                if *json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&summary.to_json()).unwrap_or_default()
                    );
                } else {
                    print_daily_summary_text(&summary);
                }
            }
            DataAction::ReplayProviderEvidence { report } => {
                let dh = agent_vitals_runtime::home::data_home();
                let path = agent_vitals_data::authority::default_authority_path(&dh);
                let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
                    .unwrap_or_else(|e| { eprintln!("provider replay failed: {e}"); std::process::exit(2); });
                let conn = db.conn();
                let before_ids: Vec<String> = conn.prepare("SELECT fact_id FROM usage_facts WHERE deleted_at_ms IS NULL")
                    .and_then(|mut s| s.query_map([], |r| r.get(0)).and_then(|rows| rows.collect()))
                    .unwrap_or_else(|e| { eprintln!("provider replay query failed: {e}"); std::process::exit(2); });
                let before_count = before_ids.len() as i64;
                drop(db);
                let sync = agent_vitals_runtime::sync_service::force_codex_provider_replay(&dh)
                    .unwrap_or_else(|e| { eprintln!("provider replay sync failed: {e}"); std::process::exit(2); });
                if sync.harnesses.iter().any(|h| !h.errors.is_empty()) {
                    eprintln!("provider replay encountered unreadable source files");
                    std::process::exit(2);
                }
                let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
                    .unwrap_or_else(|e| { eprintln!("provider replay reopen failed: {e}"); std::process::exit(2); });
                let conn = db.conn();
                let row = conn.query_row(
                    "SELECT COUNT(*), COALESCE(SUM(uncached_input_tokens),0),
                            COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_write_tokens),0),
                            COALESCE(SUM(output_tokens),0),
                            COALESCE(SUM(CASE WHEN provider_id = 'cogfoundry.ai' THEN 1 ELSE 0 END),0),
                            COALESCE(SUM(CASE WHEN provider_id IS NULL THEN 1 ELSE 0 END),0)
                     FROM usage_facts WHERE deleted_at_ms IS NULL",
                    [], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,i64>(1)?, r.get::<_,i64>(2)?, r.get::<_,i64>(3)?, r.get::<_,i64>(4)?, r.get::<_,i64>(5)?, r.get::<_,i64>(6)?))
                ).unwrap_or_else(|e| { eprintln!("provider replay query failed: {e}"); std::process::exit(2); });
                let (facts, uncached, cache_read, cache_write, output, cogfoundry, unknown) = row;
                let after_ids: Vec<String> = conn.prepare("SELECT fact_id FROM usage_facts WHERE deleted_at_ms IS NULL")
                    .and_then(|mut s| s.query_map([], |r| r.get(0)).and_then(|rows| rows.collect()))
                    .unwrap_or_else(|e| { eprintln!("provider replay id query failed: {e}"); std::process::exit(2); });
                let conserved = before_ids.iter().all(|id| after_ids.iter().any(|x| x == id));
                let conflict_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM data_quality_issues
                     WHERE resolved_at_ms IS NULL AND scope_key LIKE 'attribution_conflict:%'",
                    [], |r| r.get(0)
                ).unwrap_or(0);
                if !conserved {
                    eprintln!("provider replay failed: fact_id conservation check failed");
                    std::process::exit(2);
                }
                let report_value = serde_json::json!({
                    "replay_run": format!("replay-{}", agent_vitals_runtime::sql_sync::now_ms()),
                    "parser_version": "v0.11-provider-attribution",
                    "before_fact_count": before_count, "after_fact_count": facts,
                    "fact_id_conservation": conserved,
                    "sync_report": sync,
                    "token_totals": { "uncached_input_tokens": uncached, "cache_read_tokens": cache_read, "cache_write_tokens": cache_write, "output_tokens": output },
                    "provider_distribution": { "cogfoundry.ai": cogfoundry, "unknown": unknown },
                    "conflict_count": conflict_count, "unresolved_count": unknown,
                    "recovered_cogfoundry_facts": cogfoundry,
                    "unrecoverable_unknown_facts": unknown,
                });
                if let Some(parent) = report.parent() { let _ = std::fs::create_dir_all(parent); }
                std::fs::write(report, serde_json::to_string_pretty(&report_value).unwrap_or_default())
                    .unwrap_or_else(|e| { eprintln!("provider replay report write failed: {e}"); std::process::exit(2); });
                println!("provider replay audit written");
            }
            DataAction::Authority {
                action,
                force,
                json,
            } => {
                let dh = agent_vitals_runtime::home::data_home();
                match action.as_str() {
                    "status" => {
                        let st = agent_vitals_runtime::sql_authority::status(&dh);
                        if *json {
                            println!("{}", serde_json::to_string_pretty(&st).unwrap_or_default());
                        } else {
                            println!("sql_authority_enabled: {}", st["sql_authority_enabled"]);
                            if let Some(at) = st["marker"]["enabled_at"].as_str() {
                                println!("  enabled_at: {at}");
                            }
                        }
                    }
                    "enable" => {
                        // Phase 4.3 起没有 legacy 第二实现可对账——门槛改成
                        // 「权威库自身健康」：可打开 + integrity ok + 有事实 +
                        // 最近一次 sync run 成功。空/损坏/从没同步的库不许翻开关
                        // （翻了 = 旧 JSON 冻结 + 权威库是空的 = 静默零花销）。
                        let health = (|| -> Result<serde_json::Value, String> {
                            let db = agent_vitals_data::authority::AuthorityDb::open(
                                &agent_vitals_data::authority::default_authority_path(&dh),
                                agent_vitals_runtime::sql_sync::now_ms(),
                            )
                            .map_err(|e| e.to_string())?;
                            let conn = db.conn();
                            let integrity: String = conn
                                .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                                .unwrap_or_else(|e| format!("integrity_check failed: {e}"));
                            let facts: i64 = conn
                                .query_row(
                                    "SELECT COUNT(*) FROM usage_facts WHERE deleted_at_ms IS NULL",
                                    [],
                                    |r| r.get(0),
                                )
                                .unwrap_or(0);
                            let last_run: Option<String> = conn
                                .query_row(
                                    "SELECT status FROM sync_runs ORDER BY started_at_ms DESC LIMIT 1",
                                    [], |r| r.get(0),
                                )
                                .ok();
                            Ok(serde_json::json!({
                                "integrity": integrity,
                                "facts": facts,
                                "last_run": last_run,
                            }))
                        })();
                        let (ok, health) = match &health {
                            Ok(h) => (
                                h["integrity"] == serde_json::json!("ok")
                                    && h["facts"].as_i64().unwrap_or(0) > 0
                                    && h["last_run"] == serde_json::json!("succeeded"),
                                h.clone(),
                            ),
                            Err(e) => (false, serde_json::json!({"error": e})),
                        };
                        if !ok && !*force {
                            eprintln!(
                                "data authority enable: authority DB is not healthy \
                                 (need integrity=ok, facts>0, last sync run succeeded — \
                                 run `agent-vitals sync-facts` then `agent-vitals data-status`). \
                                 Pass --force to override. NOT enabling."
                            );
                            println!(
                                "{}",
                                serde_json::to_string_pretty(&serde_json::json!({
                                    "enabled": false, "health": health,
                                }))
                                .unwrap_or_default()
                            );
                            std::process::exit(1);
                        }
                        agent_vitals_runtime::sql_authority::enable(
                            &dh,
                            serde_json::json!({"health": health, "forced": !ok && *force}),
                        )
                        .unwrap_or_else(|e| {
                            eprintln!("data authority enable failed: {e}");
                            std::process::exit(2);
                        });
                        println!(
                            "sql_authority_enabled = true (health {}). Legacy state-JSON writes \
                             are now frozen; old files kept, not updated.",
                            if ok { "ok" } else { "FORCED past unhealthy DB" },
                        );
                        if *json {
                            println!(
                                "{}",
                                serde_json::to_string_pretty(
                                    &agent_vitals_runtime::sql_authority::status(&dh)
                                )
                                .unwrap_or_default()
                            );
                        }
                    }
                    "disable" => {
                        agent_vitals_runtime::sql_authority::disable(&dh).unwrap_or_else(|e| {
                            eprintln!("data authority disable failed: {e}");
                            std::process::exit(2);
                        });
                        println!("sql_authority_enabled = false — back to dual-write (legacy state JSON updated again).");
                    }
                    other => {
                        eprintln!("data authority: unknown action {other}");
                        std::process::exit(2);
                    }
                }
            }
        }
        return;
    }

    // `agent-vitals` 无参数等价于 `doctor`。判据是有没有给 --json，理由见 Cmd。
    if args.cmd.is_none() && args.json.is_none() {
        std::process::exit(run_doctor(
            &doc,
            &args,
            skills::doctor::DEFAULT_OVERLAP_MIN,
            auto_snapshot,
            baseline.as_deref(),
        ));
    }

    if let Some(Cmd::Snapshot { keep }) = &args.cmd {
        let (text, rc) = agent_vitals_runtime::skills::snapshot::render_snapshot(
            &doc,
            &agent_vitals_runtime::skills::snapshot::SnapshotOpts {
                keep: *keep,
                redacted: args.redact || args.redact_names,
            },
        );
        if rc == 0 {
            print!("{}", text);
        } else {
            eprint!("{}", text);
        }
        std::process::exit(rc);
    }

    if let Some(Cmd::Diff { rows_json, .. }) = &args.cmd {
        if let Some(path) = rows_json {
            match doc.get("diff_vs_baseline") {
                None => {
                    eprintln!("No snapshot is available for comparison.");
                    std::process::exit(1);
                }
            Some(d) => {
                // 与主扫描 / doctor 同语义：`-` 写 stdout（桌面「与上次快照对比」
                // 的取数路径，不留垃圾文件）。
                let text = serde_json::to_string_pretty(d).unwrap_or_default();
                if path == &PathBuf::from("-") {
                    println!("{text}");
                } else if std::fs::write(path, &text).is_err() {
                    eprintln!("failed to write {}", path.display());
                    std::process::exit(2);
                } else {
                    println!("Wrote {}", path.display());
                }
                return;
            }
            }
        }
        let gate = doc
            .pointer("/trigger_data/zombie_min_age_days")
            .and_then(|v| v.as_i64())
            .unwrap_or(args.zombie_age);
        let (text, to_stderr, rc) = agent_vitals_runtime::skills::snapshot::render_diff(&doc, gate);
        if to_stderr {
            eprint!("{}", text);
        } else {
            print!("{}", text);
        }
        std::process::exit(rc);
    }

    if let Some(Cmd::Doctor {
        min,
        rows_json,
        with_report,
    }) = &args.cmd
    {
        if let Some(path) = rows_json {
            let ds = skills::doctor::diagnose(&doc, args.split_threshold, *min);
            let n = ds.len();
            let mut payload = serde_json::json!({
                "schema_version": doc.get("schema_version"),
                "run": util::run_id(&doc),
                "harness_selection": doc.get("harness_selection"),
                "diagnostics": ds,
                "not_assessed": skills::doctor::NOT_ASSESSED.iter()
                    .map(|(c, n, w)| serde_json::json!({"code": c, "name": n, "reason": w}))
                    .collect::<Vec<_>>(),
            });
            if *with_report {
                payload["report"] = doc.clone();
            }
            // 与主扫描 `--json -` 同语义：stdout 是给调用方的管道，磁盘上不留 "-" 文件。
            let text = serde_json::to_string_pretty(&payload).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                println!("Wrote {}: {} diagnostics", path.display(), n);
            }
            return;
        }
        std::process::exit(run_doctor(
            &doc,
            &args,
            *min,
            auto_snapshot,
            baseline.as_deref(),
        ));
    }

    if let Some(Cmd::Plan {
        startup_rate,
        rows_json,
    }) = &args.cmd
    {
        // 纯派生：build_plan 只读已扫好的 doc，不触发 auto_snapshot（plan 是
        // 报告的一个视图，不是一次新扫描）。
        let payload = agent::plan::build_plan(&doc, *startup_rate);
        if let Some(path) = rows_json {
            let text = serde_json::to_string_pretty(&payload).unwrap_or_default();
            if path == &PathBuf::from("-") {
                println!("{text}");
            } else if std::fs::write(path, &text).is_err() {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            } else {
                let n = payload["summary"]["item_count"].as_i64().unwrap_or(0);
                println!("Wrote {}: {} items", path.display(), n);
            }
            return;
        }
        print!("{}", render_plan(&payload));
        return;
    }

    if let Some(Cmd::Explain {
        name,
        min,
        rows_json,
    }) = &args.cmd
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let o = skills::explain::ExplainOpts {
            name: name.clone(),
            min: *min,
            now,
        };
        match skills::explain::render_explain(&doc, &o, rows_json.is_some()) {
            // 找不到那个名字要以非零退出：脚本调用方靠退出码判断，打印一行
            // 「没找到」然后返回 0 会被当成「查过了，没问题」。
            skills::explain::ExplainOut::NotFound(msg) => {
                eprint!("{}", msg);
                std::process::exit(1);
            }
            skills::explain::ExplainOut::Json(payload, n) => {
                let path = rows_json
                    .as_ref()
                    .expect("Json branch implies rows_json is present");
                if std::fs::write(
                    path,
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )
                .is_err()
                {
                    eprintln!("failed to write {}", path.display());
                    std::process::exit(2);
                }
                println!("Wrote {}: {} copies", path.display(), n);
            }
            skills::explain::ExplainOut::Text(t) => print!("{}", t),
        }
        return;
    }

    if let Some(Cmd::List {
        unused,
        shadowed,
        stale,
        sort,
        top,
        rows_json,
    }) = &args.cmd
    {
        if let Some(path) = rows_json {
            let rows = skills::render::list_rows(
                &doc,
                &skills::render::ListOpts {
                    unused: *unused,
                    shadowed: *shadowed,
                    stale: *stale,
                    sort: sort.clone(),
                    top: *top,
                },
            );
            let n = rows.as_array().map(|a| a.len()).unwrap_or(0);
            if std::fs::write(
                path,
                serde_json::to_string_pretty(&rows).unwrap_or_default(),
            )
            .is_err()
            {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            }
            println!("Wrote {}: {} rows", path.display(), n);
            return;
        }
        print!(
            "{}",
            skills::render::render_list(
                &doc,
                &skills::render::ListOpts {
                    unused: *unused,
                    shadowed: *shadowed,
                    stale: *stale,
                    sort: sort.clone(),
                    top: *top,
                }
            )
        );
        return;
    }

    if let Some(Cmd::Overlap {
        min,
        top,
        rows_json,
    }) = &args.cmd
    {
        let o = agent_vitals_domain::skills::overlap::OverlapOpts {
            min: *min,
            top: *top,
        };
        if let Some(path) = rows_json {
            let rows = agent_vitals_domain::skills::overlap::overlap_pairs(&doc, &o);
            let n = rows.as_array().map(|a| a.len()).unwrap_or(0);
            if std::fs::write(
                path,
                serde_json::to_string_pretty(&rows).unwrap_or_default(),
            )
            .is_err()
            {
                eprintln!("failed to write {}", path.display());
                std::process::exit(2);
            }
            println!("Wrote {}: {} pairs", path.display(), n);
            return;
        }
        print!(
            "{}",
            agent_vitals_domain::skills::overlap::render_overlap(&doc, &o)
        );
        return;
    }

    // Python: json.dumps(out, ensure_ascii=False, indent=2)
    let text = serde_json::to_string_pretty(&doc).unwrap_or_default();

    // 预算不可用时**不能打印数字** —— 之前这里照着 `{}%` 的模板打，
    // 多执行环境下打出了 `描述预算 None%`：Python 的内部表示漏到了中文界面上，
    // 而且它读起来像「用了 None 那么多」，而不是「这个口径不适用」。
    let bd = doc.get("description_budget");
    let budget_available = bd
        .and_then(|b| b.get("available"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let budget_text = if budget_available {
        format!(
            "{}% ({})",
            bd.and_then(|b| b.get("pct_used"))
                .cloned()
                .unwrap_or(Value::Null),
            bd.and_then(|b| b.get("scope"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
        )
    } else if args.harness == "openclaw" {
        "configurable (not set for this instance)".to_string()
    } else {
        "unavailable".to_string()
    };

    let summary_counts = SummaryCounts {
        disk: rep.disk,
        loaded: rep.loaded,
        tier1_total: rep.tier1_total,
        budget_text,
        trigger_available: rep.trigger_available,
        harness: args.harness.clone(),
        oversized: rep.oversized,
        flagged: rep.flagged,
        all_cited: rep.all_cited,
    };

    match &args.json {
        // 原来的裸调用行为（JSON 打到 stdout）改用 `--json -`
        Some(path) if path.as_os_str() == "-" => println!("{}", text),
        Some(path) => {
            if let Err(e) = std::fs::write(path, &text) {
                eprintln!("failed to write {}: {}", path.display(), e);
                std::process::exit(2);
            }
            println!("{}", summary_counts.render(&path.to_string_lossy()));
        }
        None => unreachable!("no --json: the doctor branch above should have handled this"),
    }

    if !inv.unreadable.is_empty() {
        // 也写一份到 stderr：JSON 里那条字段只有解析输出的人会看到，
        // 而直接在终端跑的人同样需要知道清点数字是不完整的。
        eprintln!(
            "\nWarning: {} SKILL.md files could not be read and were excluded (see unreadable_skills):",
            inv.unreadable.len()
        );
        for u in inv.unreadable.iter().take(10) {
            eprintln!("  {}", s(u, "path"));
        }
    }
    if inv.skills.is_empty() {
        eprintln!("\nNo skills were found. Use --path to specify an installation directory.");
    }
}

struct SummaryCounts {
    disk: usize,
    loaded: usize,
    tier1_total: i64,
    budget_text: String,
    trigger_available: bool,
    harness: String,
    oversized: usize,
    flagged: usize,
    all_cited: usize,
}

impl SummaryCounts {
    fn render(&self, path: &str) -> String {
        // OpenClaw 的「已加载」需要运行时证实，措辞必须换一套 ——
        // 在那里说「已加载 N 个」会把「记录数」说成「确定在上下文里」。
        let active = if self.harness == "openclaw" {
            format!("{} runtime-visible records", self.loaded)
        } else {
            format!("{} loaded", self.loaded)
        };
        format!(
            "Wrote {}: {} skills on disk, {}, approximately {} Tier1 tokens, \
description budget {}, trigger data {}, {} split candidates, {} security findings \
({} contain only citation-like matches and still require review)",
            path,
            self.disk,
            active,
            self.tier1_total,
            self.budget_text,
            if self.trigger_available {
                "available"
            } else {
                "unavailable"
            },
            self.oversized,
            self.flagged,
            self.all_cited,
        )
    }
}

// ────────────── PR #2.3: mcp::dispatch 薄封装 + navigation v2 ──────────────
//
// CLI `sessions list` / `read` 与 MCP `tools/call` 输出 envelope 逐字节一致
// （同一份 `mcp::dispatch`，同一份 `mcp::build_envelope`）。这意味着 workbench
// Tauri IPC 与 CLI 子进程拿到的 JSON 在 schema_version / coverage / freshness
// / data 形状上完全一致——mcp_smoke.py S5 三消费面 parity 守门。
//
// 失败路径：与 MCP transport 同款 `error_envelope`（authority_state=unavailable
// + error.code）——不写 JSON-RPC error，不破坏 envelope schema。

/// `mcp::dispatch` 的 CLI 薄封装：`--json` 时直接 pretty-print envelope；非
/// `--json` 时给一个简短的人读摘要（harness / session 数 / 时间窗），envelope
/// 的全量字段仍在 JSON 路径里。
///
/// 错误：把 `ToolError` 折成 `error_envelope` 再 print——spec §11 稳定错误码
/// 透传，不写 JSON-RPC 错误（envelope schema 不破）。
fn dispatch_sessions(name: &'static str, args: Value, json_out: bool, data_home: &Path) {
    use agent_vitals_runtime::mcp;
    match mcp::dispatch(name, &args, data_home) {
        Ok(envelope) => {
            let text = serde_json::to_string_pretty(&envelope).unwrap_or_default();
            if json_out {
                println!("{text}");
            } else {
                print_sessions_summary(name, &envelope);
            }
        }
        Err(err) => {
            eprintln!("agent-vitals sessions {name}: [{}] {}", err.code, err.message);
            let env = mcp::error_envelope(&err);
            let text = serde_json::to_string_pretty(&env).unwrap_or_default();
            println!("{text}");
            // 与 `data_status` 同样的退出码语义：参数错 = 2，库不可读 = 3，
            // 内部错 = 1。但目前 ToolError 还没分类，所有错误退 3（DB/库层面）。
            std::process::exit(3);
        }
    }
}

/// envelope → 人读摘要：sessions_search 给时间窗 + 命中数；session_detail 给
/// harness + 时间线长度 + total。非 `--json` 模式用，避免一坨 JSON 砸脸。
fn print_sessions_summary(name: &'static str, env: &Value) {
    let data = &env["data"];
    match name {
        "sessions_search" => {
            let window = &data["window"];
            let label = window.get("label").and_then(Value::as_str).unwrap_or("?");
            let from = window.get("from").and_then(Value::as_str).unwrap_or("?");
            let to = window.get("to").and_then(Value::as_str).unwrap_or("?");
            let n = data["sessions"].as_array().map(|a| a.len()).unwrap_or(0);
            let total = data["window_total_tokens"].as_i64().unwrap_or(0);
            let has_more = data["has_more"].as_bool().unwrap_or(false);
            println!(
                "sessions {label}: {n} session(s), {total} tokens ({from} → {to}){}",
                if has_more { " [more pages]" } else { "" }
            );
        }
        "session_detail" => {
            let harness = data.get("harness").and_then(Value::as_str).unwrap_or("?");
            let n = data["event_count"].as_i64().unwrap_or(0);
            let total = data["tokens"]["total"].as_i64().unwrap_or(0);
            let tl = data["timeline"].as_array().map(|a| a.len()).unwrap_or(0);
            println!("session {harness}: {n} events, {total} tokens, timeline page = {tl}");
        }
        _ => {
            // 不应到这里——CLI 只 dispatch 上面的两个工具名。
            let _ = env;
        }
    }
}

/// `sessions navigation` 的 v2 实现：今日 token 走 SQL 权威库（与 r2a_store
/// `sessions_navigation` 同源：`authority_day_token_totals`），`recent[]` 走
/// `mcp::sessions_search({date, limit})`。三执行环境行结构与旧 envelope 对齐
/// （Tauri 菜单栏渲染端 0 行改动，`fmtUSD(null) → "—"` 接受 null cost）。
///
/// 失败降级（spec §0.1 不冒充）：单执行环境失败 → 该执行环境行 `unavailable`；top-level
/// 失败 → envelope 整体退到 `error_envelope` 形态。
fn sessions_navigation_v2(day_key: &str, timezone: &str, recent_n: usize, json_out: bool, data_home: &Path) {
    use agent_vitals_runtime::mcp;
    let data_home = data_home.to_path_buf();

    // today_tokens：单次只读事务，逐 harness 从 SQL 聚合出来。
    let sql_totals = agent_vitals_data::authority_query::day_token_totals_by_harness(&data_home, day_key);
    // 导航执行环境与可控来源共用动态注册表；保留原三执行环境的菜单顺序，
    // 再追加 WorkBuddy 与热插拔插件。历史使用事实不依赖会话文件是否仍在。
    let mut harness_ids = vec!["dsh".to_string(), "codex".to_string(), "claude-code".to_string()];
    for harness in agent_vitals_runtime::sources::source_controls::supported_harnesses_for(&data_home) {
        if !harness_ids.contains(&harness) {
            harness_ids.push(harness);
        }
    }
    let mut harnesses: Vec<Value> = Vec::with_capacity(harness_ids.len());
    for harness in harness_ids {
        let today_tokens = match sql_totals.as_ref() {
            Some(rows) => match rows.get(&harness) {
                Some(v) => json!({ "value": v, "basis": "sql-facts", "coverage": "complete" }),
                None => json!({ "value": Value::Null, "basis": Value::Null, "coverage": Value::Null }),
            },
            None => json!({ "value": Value::Null, "basis": Value::Null, "coverage": Value::Null }),
        };
        // recent[]：走 mcp::sessions_search，limit = recent_n；限本执行环境。
        // 库不可读 / 该日无事实 → 空数组（envelope 形态保留，不冒充）。
        let mut search_args = serde_json::Map::new();
        search_args.insert("date".into(), Value::String(day_key.to_string()));
        search_args.insert(
            "harnesses".into(),
            Value::Array(vec![Value::String(harness.clone())]),
        );
        search_args.insert(
            "limit".into(),
            Value::Number(serde_json::Number::from(recent_n)),
        );
        let recent = match mcp::dispatch("sessions_search", &Value::Object(search_args), &data_home) {
            Ok(env) => env["data"]["sessions"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|mut s| {
                    // 形状对齐旧 navigation envelope：
                    //   - `session_key` → `session_ref`（HMAC，菜单栏深链即可）；
                    //   - `tokens_total` / `model` / `date_first` / `date_last` 重命名。
                    let key = s["session_ref"].take();
                    let tokens_total = s["tokens"]["total"].take();
                    let first = s["first_event_at"].take();
                    let last = s["last_event_at"].take();
                    let model_id = s["model_ids"]
                        .as_array()
                        .and_then(|a| a.first().and_then(Value::as_str))
                        .map(str::to_string);
                    json!({
                        "session_key": key,
                        "title": Value::Null,
                        "model": model_id,
                        "tokens_total": tokens_total,
                        "date_first": first,
                        "date_last": last,
                        "cost_minor": s["cost_minor"].take(),
                    })
                })
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(), // 单执行环境失败 → 该执行环境行降级，不污染其他执行环境
        };
        let status = if sql_totals.is_none() {
            "unavailable"
        } else if today_tokens.get("value").and_then(Value::as_i64).is_some() {
            "ready"
        } else {
            "partial"
        };
        // today_sessions：SQL 在单 harness 单日内的 session 数（distinct
        // session_key），与 r2a_store「今日碰过的会话」计数同语义。
        let today_sessions = agent_vitals_data::authority_query::day_session_count(
            &data_home,
            day_key,
            &harness,
        );
        harnesses.push(json!({
            "harness_kind": harness,
            "status": status,
            "today_tokens": today_tokens,
            "today_sessions": today_sessions,
            "recent": recent,
            // `store_revision` 字段保留为 null（v0.9.1 SQL 权威库收口后这
            // 个字段不再有源——r2a_store v2 cache 的 max store_seq 已退役）。
            // Tauri 渲染端不会读这个字段；保留占位保持 envelope 形状兼容。
            "store_revision": Value::Null,
        }));
    }
    let envelope = json!({
        "schema_version": 1,
        "day_key": day_key,
        "timezone": timezone,
        "generated_at": agent_vitals_runtime::state::now_iso_utc(),
        "harnesses": harnesses,
    });
    let text = serde_json::to_string_pretty(&envelope).unwrap_or_default();
    if json_out {
        println!("{text}");
    } else {
        print_navigation_summary(&envelope);
    }
}

fn print_navigation_summary(env: &Value) {
    let day = env.get("day_key").and_then(Value::as_str).unwrap_or("?");
    println!("navigation {day}");
    if let Some(arr) = env.get("harnesses").and_then(Value::as_array) {
        for h in arr {
            let harness = h.get("harness_kind").and_then(Value::as_str).unwrap_or("?");
            let status = h.get("status").and_then(Value::as_str).unwrap_or("?");
            let today = h
                .get("today_tokens")
                .and_then(|t| t.get("value"))
                .and_then(Value::as_i64)
                .map(|v| v.to_string())
                .unwrap_or_else(|| "—".to_string());
            let n = h.get("today_sessions").and_then(Value::as_i64).unwrap_or(0);
            let recent = h.get("recent").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
            println!("  {harness} [{status}] today={today} tokens, {n} sessions, {recent} recent");
        }
    }
}

#[cfg(test)]
mod codex_sql_tests {
    use super::*;

    #[test]
    fn build_info_reports_the_authority_schema_without_opening_local_state() {
        let info = cli_build_info();
        assert_eq!(
            info["authority_schema"],
            json!(agent_vitals_data::authority::SCHEMA_VERSION)
        );
        assert_eq!(info["cli_version"], json!(env!("CARGO_PKG_VERSION")));
    }

    fn fresh_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("av-codex-sql-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// codex 按量事实一笔（gpt-5.6-sol，价目表里有价）。`ts_ms` 决定北京小时桶。
    fn seed_codex_fact(
        db: &agent_vitals_data::authority::AuthorityDb,
        id: &str,
        ts_ms: i64,
        u: i64,
    ) {
        db.conn()
            .execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('r', 1, 'cli', 'succeeded', 1) ON CONFLICT(run_id) DO NOTHING",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                &format!(
                    "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                         source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                         event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                         output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                     VALUES ('{id}', 'codex', 'm', 's', '{id}', 'token_count', NULL,
                             'gpt-5.6-sol', {ts_ms}, 0, {u}, 200000, 50000, 80000, 'r', 1, 1)"
                ),
                [],
            )
            .unwrap();
    }

    /// `codex_merged_from_sql`（Tier B：`codex-cost` 切 SQL 权威库）：
    /// - `by_hour_model` / `by_model` 从 `usage_facts` 的 codex 行读出、经
    ///   `codex_report_from_merged` 折出正数成本；
    /// - `unaccounted` = `[]`（残差哨兵是 rollout fold 独有）、`plan` 为空：
    ///   SQL 聚合没有可用于历史窗口的用户套餐证据，不能补写某个开发者的
    ///   `plus` 身份；
    /// - 库缺失 → note 非 None（CLI 打 stderr，不把空报告当「没花钱」）。
    #[test]
    fn codex_merged_from_sql_reads_facts_and_degrades_unaccounted_plan() {
        let dir = fresh_dir("degrade");

        // 空库（尚未建）→ note 提示 sync-facts；merged 不编造套餐标签。
        let (empty, note) = agent_vitals_runtime::summary::codex_merged_from_sql(&dir);
        assert!(note.is_some(), "库文件不存在 → 必须给 stderr 提示");
        assert_eq!(empty["unaccounted"], json!([]));
        assert_eq!(empty["plan"], json!({}));

        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&dir),
            1,
        )
        .unwrap();
        // The default statistics timezone follows the host, so assert the fact
        // appears in an hour bucket without assuming the test runner is in Beijing.
        seed_codex_fact(&db, "c1", 1_788_393_601_000, 800_000);
        drop(db);

        let (merged, note) = agent_vitals_runtime::summary::codex_merged_from_sql(&dir);
        assert!(note.is_none(), "库已建且可开 → 无提示");
        assert_eq!(merged["unaccounted"], json!([]));
        assert_eq!(merged["plan"], json!({}));
        let hours = merged["by_hour_model"].as_object().unwrap();
        assert!(
            hours.values().any(|hour| hour["gpt-5.6-sol"].is_object()),
            "statistics-timezone hour bucket should include the seeded model: {}",
            merged["by_hour_model"]
        );
        // 走真实报告路径：total_cost_usd 为正、per_model 有 sol、unaccounted 空、
        // plan 为空（缺证据时 render 侧保持按量估算标注）。
        let report = codex_report_from_merged(&merged, None, None, false);
        assert!(report["total_cost_usd"].as_f64().unwrap() > 0.0);
        assert!(report["per_model"]["gpt-5.6-sol"].is_object());
        assert_eq!(report["unaccounted_usage"], json!([]));
        assert_eq!(report["plan"], json!({}));
        // 缺套餐证据仍要标明按量估算，而非裸「total cost」。
        let text = agent_vitals_runtime::sessions::codex_cost::render_codex_cost(&report);
        assert!(
            text.contains("按量估算，待确认"),
            "缺套餐证据的 USD 总额必须标「按量估算，待确认」：{text}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **`Some(filter_key)` 分支覆盖**（删掉的 `test_codex_cost_month_filter_
    /// reconciles` 的 Rust-only 替身）：seed 跨两个北京月的 codex 事实，
    /// `codex_report_from_merged` 按月过滤后——
    /// - `per_model` 非空、`total_cost_usd > 0`（月过滤不得把报告静默清零，
    ///   这是真实 shipped defect 的回归）；
    /// - 守恒：`sum(days.cost_usd) == total_cost_usd`（过滤后 by_model 由
    ///   `codex_by_model_from_hours` 从过滤后小时重算，days 与 per_model 对得上）；
    /// - 过滤后 total < 全窗 total（另一个月的事实确实被排掉了）。
    #[test]
    fn codex_report_month_filter_reconciles_and_does_not_zero() {
        let dir = fresh_dir("monthfilter");
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&dir),
            1,
        )
        .unwrap();
        // 1786881600000 ms → 北京 2026-08-16T20；1788393601000 → 北京 2026-09-03T08。
        seed_codex_fact(&db, "aug", 1_786_881_600_000, 500_000);
        seed_codex_fact(&db, "sep", 1_788_393_601_000, 900_000);
        drop(db);

        let (merged, _) = agent_vitals_runtime::summary::codex_merged_from_sql(&dir);
        let all = codex_report_from_merged(&merged, None, None, false);
        let sep = codex_report_from_merged(&merged, Some("2026-09"), Some("2026-09"), false);

        let sep_total = sep["total_cost_usd"].as_f64().unwrap();
        assert!(sep_total > 0.0, "月过滤后报告不得静默清零");
        assert!(!sep["per_model"].as_object().unwrap().is_empty());
        let sep_days_sum: f64 = sep["days"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["cost_usd"].as_f64().unwrap_or(0.0))
            .sum();
        assert!(
            (sep_days_sum - sep_total).abs() < 1e-9,
            "守恒：sum(days)={sep_days_sum} != total={sep_total}"
        );
        assert!(
            sep_total < all["total_cost_usd"].as_f64().unwrap(),
            "9 月窗必须比全窗小（8 月那笔被排掉）"
        );
        // 8 月的日期不得出现在 9 月过滤后的 days 里。
        for d in sep["days"].as_array().unwrap() {
            assert!(d["date"].as_str().unwrap().starts_with("2026-09"));
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
