# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This repo **is** an Agent Skill (`SKILL.md` at the root), not a library that ships one.
It health-checks the *other* skills installed on the machine. There are now **two
implementations kept in lockstep** (see §Architecture; the dual structure is being phased
down per `docs/TAURI_RUNTIME_WORKBENCH_SPEC.md` §7.1): a Python scanner
(`scripts/` entrypoint + `packages/agent-vitals-python/agent_vitals/`) and a Rust binary +
shared lib + wasm build (`apps/cli/src/` + `crates/`). The
Python scanner is stdlib-only — no dependencies, no network calls; the Rust side has
normal crates.io deps (clap/regex/serde/serde_json/sha2/walkdir) and the wasm crate adds
wasm-bindgen. The "no network, no third-party supply chain" constraint still holds for
what is *distributed* as the in-harness skill: a skill that audits skills for supply-chain
risk cannot itself pull third-party code at scan time.

There is also a **DeepSeek Harness (DSH) integration**: `integrations/dsh/` (the installable
profile bundle, still in this repo — no build, no deps; the `dsh/` name is a leftover from
before Phase E1 moved it under `integrations/`). The other half, the dual-face audit
plugin whose harness half folds session events through the Rust behavior rules compiled to wasm
and whose client half renders a 「审计」tab, was **extracted to a standalone repository,
`dsh-agent-vitals-audit`, on 2026-09-22** (its `npm` toolchain depends on private
`@deepseek-ai/*` packages that can't be resolved from this environment/CI, and it was never
actually coupled to this repo's Cargo/Python builds). This repo still owns the wasm crate that
plugin consumes (`crates/agent-vitals-wasm/`) and the price table it reads a build-time copy
of (`assets/pricing.json`); syncing those into the standalone repo after a change is now a
manual step documented in that repo's README, not something this repo's tests catch. See
`docs/DSH_INTEGRATION.md` and `docs/AGENT_BEHAVIOR_AUDIT.md` for the design (now describing a
cross-repo architecture, not a single-repo one).

Documentation is bilingual. `SKILL.md` (the agent-facing instructions) is English, with
`references/guide.zh-CN.md` as the complete Chinese equivalent; `README.md` is English
first, then a Chinese section anchored at `#中文`. When editing behaviour, both
`README.md` sections usually need the same change, and a change to the workflow in
`SKILL.md` needs the matching change in `guide.zh-CN.md`.

## Repo layout

```
Cargo.toml                  # 纯 [workspace] manifest（Phase E3 起；[profile.release] 留根，Cargo 规则）：
                            #   apps/cli + crates/{vitals-core,agent-vitals-domain,agent-vitals-harnesses,agent-vitals-runtime,agent-vitals-wasm}
apps/cli/                   # Rust binary crate（the `agent-vitals` CLI），Phase E3 由根 src/ 迁来
  src/skills/               #   静态 SKILL.md 体检（analysis/security/doctor/discovery/…）
  src/agent/                #   会话行为/成本审计的 CLI 侧 I/O 接线：v0.7 UsageFact 发射器
                            #   （{claude,codex,dsh}_usage_fact）、成本折叠（cost/claude_cost，
                            #   后者只剩 fold 引擎，与 claude_usage_fact 双向耦合）、CLI 展示
                            #   助手（oneline/plan）、执行环境能力注册表（harness_runtime_
                            #   registration）。behavior/codex_cost/codex_session_audit/
                            #   discovery/r2a_store 已整体迁进
                            #   agent-vitals-runtime::sessions（v0.9 Stage 0.3）。
  src/util.rs               #   二进制侧 util（split_lines/pyround 等 re-export 自 domain）
crates/vitals-core/         # 执行环境无关的通用审计机制（Event→Trajectory→Detector→Finding→Replay）；不认识 Agent/执行环境
crates/agent-vitals-data/   # v0.9 Stage A/B：数据面本体（spec §3.4/§5.1）。权威 UsageFact JSONL
                            #   的 writer/replay/保留滚动（evidence）+ SQLite **可重建**索引
                            #   （store，删库从 JSONL 重建）+ BillingContext（billing）——
                            #   索引是可丢弃投影，权威在 JSONL；只依赖 domain + rusqlite
                            #   （tests/dependency_budget.rs 钉边界），实现走 runtime::ingest_service
crates/agent-vitals-domain/ # v0.8 Phase C：PURE computation + 词表契约，single source of truth。
                            #   src/{contracts,domain,compatibility}/ + lib.rs。contracts/=执行环境无关词表
                            #   （evidence/harness_capability/source_identity/usage_fact/r2a，只碰 serde_json）；
                            #   domain/=跨执行环境计算（Phase D1 起对任何执行环境 wire 事件形状不知情）；
                            #   compatibility/=vitals-core 桥。lib.rs 暴露嵌套 + 扁平两套路径。
crates/agent-vitals-harnesses/ # v0.8：一个 crate 装所有执行环境的 wire 适配（D3 由 agent-vitals-adapters 改名）。
                            #   harnesses/<h>/sessions/=会话证据（纯，wasm 可链）：claude_code/codex/workbuddy evidence、
                            #   Codex usage fold、canonical_usage、Phase D1 起的 DSH evidence/audit/compaction/waste。
                            #   harnesses/<h>/{sources/（I/O，feature-gated）,skills/,capability.rs}=D4/D5 填。依赖 domain。
                            #   W3：`sources::session_harnesses` 会话执行环境注册表（根 / 枚举 / findings 评估 / trace 定位），
                            #   runtime 遍历它、不按执行环境名分支；接新执行环境 = 加一行 + 写 harnesses/<h>/sources 实现。
crates/agent-vitals-runtime/ # **门面**（W3，2026-09-24）：自身无实现，原样 re-export 下面 6 个层 crate 的全部
                            #   模块与扁平别名，外部 `agent_vitals_runtime::X` 路径不变。`watcher` / `mcp-internal`
                            #   feature 只做转发。只能依赖严格更低层：crate 间由 Cargo 保证，crate 内由
                            #   `tests/module_layering.rs` 钉住（扫整个 runtime 家族）；内部代码写真实路径
                            #   （`crate::clock::now_ms`，不写兼容别名 `crate::sql_sync::now_ms`）。
crates/agent-vitals-runtime-core/ # L0 core（home/clock/lease/state/SQL 权威标记/执行环境词表）· pricing · source_graph
                            #   · L1 envelope（MCP/查询共用工具协议）· events（outbox）· skills。
crates/agent-vitals-query/  # L2 sources（源配置/插件执行环境/监听拓扑）· sessions（执行环境适配的 runtime 薄封装：
                            #   供给时钟/时区/价卡）· L3 query（summary 仓储/trace/export/决策矩阵/读缓存）。
crates/agent-vitals-billing/ # L4 billing：预算、计费预览与归因、价格发现、额度提醒。
crates/agent-vitals-ingest/ # L5 写入侧：sync_service（发现走 harnesses 会话执行环境注册表）、engine（进程内同步，
                            #   桌面 tick 与 CLI `sync-facts` 共用）、scheduler（tick 轻/重调度状态机，有单测）、
                            #   findings_eval（同步后增量评估行为 findings → issue_instances）、watch、保留滚动。
crates/agent-vitals-trust/  # L5 Trust / Egress 审计（与 ingest 同层互不依赖）。
crates/agent-vitals-mcp/    # L6 Data MCP 工具应用层——出口面，脱敏红线在这里审（传输层在 apps/cli/src/mcp.rs）。
crates/agent-vitals-wasm/   # cdylib: wasm-bindgen wrapper over domain + harnesses (audit_events), built with wasm-pack
scripts/scan.py             # thin entrypoint; stays here (documented `python3 scripts/scan.py`
                            #   command, and what the ClawHub package ships at scripts/scan.py) —
                            #   Phase E4 moved the package itself, this file just sys.path's to it
packages/agent-vitals-python/
  agent_vitals/              # Python 包：同样拆 skills/（静态体检）+ agent/（会话/成本）子树；
                            #   adapters/（执行环境适配器）与 cli/compat/util/paths 留顶层。ClawHub 打包
                            #   产物镜像同一相对结构（packages/agent-vitals-python/agent_vitals/），
                            #   scan.py 的一份 sys.path 逻辑在源仓库和打包产物里都成立
scripts/probe_logs.py       # legacy fallback (not in the default flow)
assets/                      # v0.8 Phase E5：Rust/Python/dsh-agent-vitals-audit（外部仓库）
                            #   三方共读的资产，不是 Python 包私有数据——pricing.json/
                            #   codex_pricing.json/templates/{calendar,codex_session}.html。
                            #   Tauri icons/ 不在这里（留 apps/desktop/src-tauri/icons/，工具约定）
SKILL.md                    # agent-facing driver: routes to doctor, names the SV codes
references/                 # harnesses.md (per-harness evidence), judgment.md, guide.zh-CN.md
docs/                       # design docs (ENGINEERING, DSH_INTEGRATION, AGENT_BEHAVIOR_AUDIT, …)
integrations/dsh/           # DSH-1 profile bundle (registers agent-vitals as a DSH skill) — moved here in Phase E1
                            #   （dsh-client 曾是这里的邻居，2026-09-22 拆到独立仓库
                            #   dsh-agent-vitals-audit，见「What this repo is」一节）
apps/desktop/src-tauri/     # 菜单栏 app（Tauri 2，**独立 workspace**，Phase E2 从根移进 apps/desktop/）：
                            #   托盘 + 工作台（总览 KPI 行/双轨账/决策卡、Token 日历）。
                            #   金钱与计价委托 domain::cost，跨执行环境查询走 runtime 的
                            #   SqlSummaryRepository（冻结 DTO；Phase 4.3 后是唯一实现），不长第四份拷贝
fixtures/ + golden/         # test corpus + byte-for-byte scanner snapshots
tests/                      # 28 Python test files（含分类守卫 tests/test_classification.py）
.github/workflows/          # verify.yml, release-desktop.yml, …（skill 体检的 release.yml 与 package-clawhub.yml
                            #   已删：skill 不单独发 GitHub Release、不进 CI 打包，后续迁出本仓库）
```

**两个子树的分界**（`tests/test_classification.py` 用显式清单钉死）：`skills/` 是
**skill 体检**——静态扫 SKILL.md/目录/触发数据；`agent/` 是 **skill 执行 + 成本**——
审计一次会话里 skill 被调用得好不好（读运行证据，不是 SKILL.md 文本）。名字像
扫描器的 `skill.py`/`skill.rs` 属 agent 家族（会话执行），**不进 skills/**；`codex.py`
（安装时执行环境扫描证据源）进 skills/，`codex_session.py`（会话读取）留 adapters/。
Python 与 Rust 两侧同构，模块清单见 tests/test_classification.py 的家族 set。

The **`agent-vitals-domain` crate is the single source of truth for pure rules**.
`apps/cli/src/agent/behavior.rs` in the binary is a thin wrapper that re-exports
`agent_vitals_domain::behavior::*` and keeps only the I/O entry (`audit_session_log`). The
wasm crate wraps the same domain, so the browser/Node runs the exact same rules as the
CLI — never a second copy.

**v0.8 crate split (Phase C complete, Phase D in progress — `docs/AGENT_VITALS_V0_8_ARCHITECTURE_SPEC.md`).**
The workspace is now four crates:

- **`vitals-core`** — the harness-agnostic engine (unchanged).
- **`agent-vitals-domain`** — `contracts/` (harness-agnostic vocabulary — `evidence`,
  `harness_capability`, `source_identity`, `usage_fact`, `r2a`) + `domain/` (pure business
  computation — since Phase D1 it knows **no** harness wire format) + `compatibility/` (the
  `vitals-core` bridge). Depends on `vitals-core` + `regex` + `serde_json`.
  `[dev-dependencies] agent-vitals-harnesses` for `domain/usage.rs::tests` (exchange only
  `serde_json::Value`) and `tests/behavior_rules.rs` (an integration test — domain is
  compiled once there, so `build_dsh_evidence` fixtures returning `CanonicalSession` are
  fine; the same call inside an *inline* `#[cfg(test)]` hits `multiple versions of crate`).
  `lib.rs` re-exports both nested (`agent_vitals_domain::{contracts,domain}::X`) and flat
  (`agent_vitals_domain::{evidence,behavior,cost,…}::X`) paths.
- **`agent-vitals-harnesses`** (was `agent-vitals-adapters` until Phase D3) — one crate, one
  folder per harness: `harnesses/<h>/sessions/` (session evidence — pure, wasm-linkable: all
  `*_evidence`, Codex fold, `canonical_usage`, and the DSH session wire
  `{evidence,audit,compaction,waste}` moved here in D1), plus `harnesses/<h>/{sources/
  (feature-gated I/O), skills/, capability.rs}` to be filled by D4/D5. Depends on
  `agent-vitals-domain`.

**History**: Phase A carved `agent-vitals-core/src` into `contracts/`/`domain/`/
`compatibility/` dirs; B1 extracted the adapters crate; B2 (Phase C Step 3) moved
`codex_usage` + `canonical_usage` into it; Step 4 consolidated `contracts` into
`agent-vitals-domain` and deleted the one-cycle `agent-vitals-core` facade (the binary /
wasm / harnesses / `src-tauri` import `agent_vitals_domain::*` directly). Phase D1 moved the
DSH session wire out of domain; D3 renamed the crate. Execution logs:
`AGENT_VITALS_V0_8_PHASE_{C,D}_RESEARCH.md`.

**Executable boundary guards** (each crate's `tests/dependency_budget.rs` /
`crates/vitals-core/tests/dependency_boundary.rs`): `contracts/` stays serde_json-only
(`contracts_module_stays_vocabulary_only`); `domain/` takes no fs/process/env/clock and
holds no DSH wire module (`domain_holds_no_dsh_wire_module` +
`domain_production_code_has_no_harness_adapter_dependency`); dependency direction is one-way
(`harnesses → domain → vitals-core`); `vitals-core` names no Agent/harness term and depends on no
`agent-vitals-*` crate.

**Phase D done so far**: D1 (wire/fold), D2 (`cost.rs` split), D3 (crate rename), D4/D5
(all harness session readers — `src/dsh.rs` + `src/agent/{claude,codex,workbuddy}_session.rs` —
moved to `agent-vitals-harnesses/src/harnesses/<h>/sources.rs` behind `#[cfg(feature = "sources")]`;
`ruzstd`/`walkdir`/`rusqlite` are now optional deps of harnesses under the `sources` feature;
the binary enables it, wasm sets `default-features = false`; `split_lines` moved to
`agent-vitals-domain::util`), D7 (`agent-vitals-runtime` crate; `home` = the single
`HomeResolver`), D6 (`state` / `budget` / `takeover` / `session_sources` / `clock` moved
into `agent-vitals-runtime`; `civil_from_unix_secs` → `agent-vitals-domain::util`).
**Phase D structural refactor is done** — the crate skeleton (domain / harnesses / runtime /
wasm + feature-gated `sources`) is in place. `apps/cli/src/agent/r2a_store.rs` and
`discovery.rs` stay in the CLI crate — entangled with the CLI cost/audit handlers
(`codex_session_audit` / `codex_cost` / `claude_cost`), they're legitimately CLI-side
"read evidence → call domain → render report" service code, not deferred runtime debt; D6
already moved the actual pure state/ledger layer (`state`/`budget`/`takeover`/
`session_sources`) into `agent-vitals-runtime`. Phase E (dir moves, `docs/
AGENT_VITALS_V0_8_PHASE_E_RESEARCH.md`) is in progress: E1 (`dsh`/`dsh-client` →
`integrations/`), E2 (`src-tauri` → `apps/desktop/src-tauri`), E3 (`src/` → `apps/cli/`),
E4 (`scripts/agent_vitals/` → `packages/agent-vitals-python/agent_vitals/`; `scripts/scan.py`
stays put and just points its `sys.path` at the new location — the packaged ClawHub artifact
mirrors the same relative layout so one `sys.path` formula works in both places), E5
(`pricing.json`/`codex_pricing.json`/`templates/` → repo-root `assets/` — the subset of
spec §11's `assets/` tree that already has real cross-language lockstep tests; the
`catalog/{models,pricing,subscriptions}` registry + loader + `billing.toml` are v0.9+
feature work, not a directory move, so E5 does not build them; Tauri's `icons/` stays put —
tool convention, zero lockstep value), E6 (CI workflow path sync — verify.yml/release.yml/
verify-dsh-client.yml needed no changes, already workspace-root-relative or fixed in E1;
swept up several stale `src-tauri`/`src/agent/cost.rs`/`dsh-client/...` path mentions left
in comments by E1-E5) done. **Phase E (E1-E6) is complete.** Then Phase F (MCP).

Guard: `agent-vitals-harnesses/tests/dependency_budget.rs::io_tokens_only_appear_under_sources`
— `std::fs`/`ruzstd`/`rusqlite`/… may appear only in files whose path contains `/sources`.

## Commands

```bash
# Python suite — everything (352 tests)
python3 -m unittest discover tests
python3 tests/test_regressions.py          # regression suite only
python3 tests/golden_runner.py             # golden diff (15 snapshots)
python3 tests/golden_runner.py --diff      # …and show the first mismatch
python3 tests/golden_runner.py --update    # re-freeze after an intended change (confirm first!)
python3 -m unittest tests.test_invariants  # the 12-invariant acceptance gate

# Rust — ~970 tests: binary (313) + agent-vitals-domain (431 lib + harness_contract +
# dependency_budget + 15 svNNN_parity) + agent-vitals-harnesses (56 + dependency_budget)
# + vitals-core (53 + boundary/replay/perf/pipeline). The wasm crate has no harness-side
# tests; its build is wasm-pack (below).
cargo test                                 # default members: binary + the 3 lib crates
cargo clippy --release --all-targets -- -D warnings   # CI gate: scan path must not unwrap
cargo build --release                       # the CLI binary

# wasm — build the audit_events wasm + JS glue into crates/agent-vitals-wasm/pkg/
cargo install wasm-pack                     # one-time
(cd crates/agent-vitals-wasm && wasm-pack build --target web)
#   then copy pkg/agent_vitals_wasm.js + pkg/agent_vitals_wasm_bg.wasm into the standalone
#   dsh-agent-vitals-audit repo (extracted 2026-09-22 — no longer integrations/dsh-client/
#   in this repo; see that repo's README for the exact destination path)

# scanner CLI (Python implementation; the Rust binary is the same surface)
python3 scripts/scan.py                     # scan, print JSON to stdout
python3 scripts/scan.py --path <dir> --json out.json
python3 scripts/scan.py --redact --redact-names --json safe.json
python3 scripts/scan.py --baseline prev.json --json out.json

# CLI subcommands (both implementations): doctor · list · explain · overlap · snapshot · diff ·
#   plan · behavior · skill-audit (Rust only — Python's `behavior --json` has the `skill` key but has
#   never had its own subcommand) · duration-audit ·
#   {claude,codex,dsh}-usage-facts (v0.7 数据面诊断，只读、不写盘)
#   `plan` turns the scan report into a ranked savings plan（zombie/oversized/trim-description/
#   shadow → 每条点名 skill、标 risk、给测量的 token 节省与 SV 码；诚实性规则见
#   `crates/agent-vitals-domain/src/domain/plan.rs` docstring）。
#   `behavior <session-log>` audits a DSH session log for SV601–SV614 findings（单事件规则 + 轨迹级检测器）.
#   `duration-audit <session-log>` audits execution duration（工具调用/turn/step/审批/hook 消费五路耗时，
#   D1-D4 的 core 纯函数）；`--json` 输出与 `behavior --json` 的 `duration` 键是同一份数据。
#   `{claude,codex,dsh}-usage-facts <session-file> --machine-namespace NS [--json -]` 把一份会话
#   replay 成 `UsageFact` 事实行（claude=per-message／codex=per-token_count／dsh=per-slot 粒度，
#   facts + coverage；codex 收多 rollout）。**内存 emit + 只读诊断，不写盘**——v0.7 候选 #3
#   adapter 段，规格见 `docs/VITALS_CORE_V0_7_STAGE_{1,2,3}_*_ADAPTER.md` + `DATA_PLANE_SPEC.md` §7。
```

`tests/test_properties.py` needs `hypothesis`, which is **optional** — the suite skips it
when absent, so the repo stays dependency-free. To run it:
`python3 -m venv .venv && .venv/bin/python -m pip install hypothesis`, then
`.venv/bin/python -m unittest discover tests` (more tests than without).

**菜单栏 app（apps/desktop/src-tauri）只能以 .app 形态验证，绝不裸跑二进制。**
验证托盘一律 `cd apps/desktop/src-tauri && cargo tauri build --bundles app`，再
`open "target/release/bundle/macos/Oh Agent.app"`（走 LaunchServices）。直接跑
`target/{debug,release}/agent-vitals-menubar`——无论是否在 agent 的沙箱 shell 里——
macOS 26 **永远不摆放它的状态栏项**（窗口能建、`rect()` 只给占位坐标），而且每个裸跑路径
都会往「系统设置 › 菜单栏」的注册表塞一条垃圾条目。2026-09-14 的"托盘突然消失"就是
Codex 与 Claude 反复裸跑 + 旧 bundle id 在该注册表里的记录损坏叠出来的，最终靠把
identifier 改成 `com.mixlabpro.agent-vitals` 绕开；另外 `set_activation_policy(Accessory)`
不能删——tao 启动时显式设回 Regular，Info.plist 的 LSUIElement 会被盖掉。

## Architecture

The load-bearing split: **`scan.py` measures, `SKILL.md` judges.** The scanner emits one
deterministic JSON document and deliberately refuses to decide whether something is
*good*; the agent-facing procedure supplies that judgment (checks 2.1–2.7, report format,
interaction rules). Semantic overlap detection (check 2.3) is absent from the script
because it is not a regex problem — the model does it from the `description` fields.

### The distinction the whole design turns on: disk ≠ context

`total_skills_on_disk` and `loaded_skills` differ substantially. Disabled plugin copies,
the same plugin under `plugins/cache/` and `plugins/marketplaces/`, and other harnesses'
skills all sit on disk while costing zero context. `classify()` → `loaded`/`loaded_reason`
decides this per skill by reading `enabledPlugins` from `~/.claude.json`. **Budget,
conflicts, and zombies are computed over `loaded` only.** `--all` exists purely to
diagnose "why did only 15 of my 70 skills load" — never write a report from its budget
numbers.

### Harness-capability degradation

Three outputs require Claude Code's `~/.claude.json`: description budget (2.1),
loaded-vs-disk (`enabledPlugins`), and trigger data (2.5, `skillUsage`). On other harnesses
these must report as unavailable. **Never substitute install time or mtime for a missing
trigger count** — a report missing a column is useful; a report with a fabricated one is
not. This principle extends to the behavior rules: when the workspace root is unknown,
SV605 degrades to the absolute-path heuristic rather than under-reporting.

### Security heuristics sort, they never acquit

`is_cited()` marks a finding as *looking* like a quoted example or defensive documentation.
It is an annotation for ordering only. `max_severity` is authoritative and includes cited
findings; `max_severity_uncited` exists solely to decide *what to read first*, never
*whether to read it*. Any change that lets a heuristic suppress a finding is a regression
regardless of how well it scores on samples. `security_scan()` early-returns
`self_excluded: True` for `SELF_SKILL_ROOT`.

### Cost accounting: four buckets, do not merge them

| Field | Meaning |
|---|---|
| `tier1_tokens` | frontmatter — resident in context at every startup |
| `tier2_core_tokens` | SKILL.md body — loaded **whenever** the skill triggers |
| `tier2_refs_tokens` | `.md` under `references/`/`docs/` or sibling to SKILL.md — on demand |
| `tier2_max_tokens` | core + refs — worst case when everything is read |

Split recommendations use **`tier2_core_tokens`, never line count**: measured density varied
>4× within one library. `.md` in other subdirectories is classified as data corpus; `REPO_META`
is excluded entirely.

### v0.9 成本词表与计费归属（2026-09-05，权威定义见 docs/ATTRIBUTABLE_WASTE.md §6/§6.7）

「花了多少钱」在本仓库是**四个互不相加的量**，UI 与 DTO 不得混用：`nominal_cost`
（名义成本，官方标价折算、不扣套餐/中转折扣/促销——"名义 GDP"式客观基准，缓存
两桶实测占 92.8%）、`metered_spend`（按量实付）、`FixedSubscription`（订阅月费，
不付用量也在付——零用量月份照摊，GLM 2026-09-05 前不摊）与 `unpriced_tokens`
（无价卡 token，既不计 0 也不借卡）。**实际支出 = 按量实付 + 订阅月费**，分币
分栏永不相加；订阅利用率 = 名义/月费，**>50× 是「归属待核」告警而非套利**
（anthropic 380× 实测即声明错误的自检信号）。词表陷阱：`nominal` 一词已从
`nominal_vs_actual_cost`（已改名 `cache_counterfactual_cost`——"无缓存反事实"，
与市场标价差 8~10 倍）让位给 §6.7 口径，不得回用。

**2026-09-17 增补**：第五个量 `metered_declared`（归因估算——用户在计费声明里答过
「经 X 按量付费」的用量，按 X 的价卡/原厂官方卡估）与 `metered_estimate` 同属估算档、
不 summable；总览「按量费用」读 `MonthlySummary::metered_view()`（账单 > 归因估算 >
默认估算，同计费方内取代、跨币分栏），预算 `estimate` profile 已用 = 该视图 + 订阅月费
按天摊派。归因是**持续生效的规则**（`sync_facts` 末尾 `billing_apply_active_declarations`），
不是保存时的一次物化。token 面（`tokens_by_harness`、日历、小时图、会话列表）恒**全量**，
只有金额面排除订阅覆盖——两者曾共用一份聚合，订阅声明一生效用量就缩水。

归属的粒度是 **(harness, provider)** 而非 harness：`HarnessAmount.amounts_by_basis` 一档
只有一个数，claude-code 执行环境内 anthropic(USD)+minimax(CNY) 同桶跨币相加就是
编造——所以权威归属在 `MonthlySummary.by_provider`（键 `"harness/provider"`，条目
级 currency 单币）；`by_harness` 保留币种分栏的旧口径（有测试钉着），**新增消费方
一律读 by_provider**。计费模式来自 `pricing.json::catalog_2026_09.billing_modes`
（`billing_route_of`，声明序即优先级、与价卡解耦——无价卡模型 glm-* 也能归属；
`resolve_card_catalog` 靠价卡反查是已知缺陷面，别新增依赖它的归属逻辑）。

**性能形状（2026-09-05 tab 卡顿事故）**：工作台一次渲染并发发起 daily/monthly/
calendar/quota 四个命令——**任何新增的 codex 数据面必须走
`runtime::summary::codex_merged_cached`（进程级 60s memo，按 home 键控）**，
自建枚举+fold 管线就是每 tab 三倍全量 fold 的回归复刻（60 份 rollout 单次
2~5s）。命中路径是 Arc——锁内深拷贝几 MB JSON 会把并发命令串行卡在锁上，
缓存自身变成瓶颈（已修，别改回去）。

**形状来源纪律（Stage A–D 审查 10 条确认缺陷的共同根因）**：渲染器/verify stub
手写数据期望形状，会与 fold/DTO 的真实形状互相印证着一起错（quota 的
`limits.primary`、`dsh_tokens` 的单日对象——两者当时 gate 全绿是假绿）。新消费
方接入 wire 数据前，先读产生方的 fold/序列化代码或 fixture 钉形状；`.mjs` stub
必须注明形状出处（函数+行号），形状变更同一 PR 同改。

### 价卡每日同步（2026-09-29）

底表 `assets/pricing.json` + `codex_pricing.json` 仍由维护者手工维护、编译进二进制、被
金额测试钉着——**CI 不改底表**。每日同步只写叠加层 `assets/pricing-sync.json`：
`.github/workflows/pricing-sync.yml` 每天跑 `scripts/pricing_sync.py`，比对 models.dev /
LiteLLM / OpenRouter 三个公开 JSON 源（不爬 HTML），一个字段 ≥2 源一致才采用，只取原厂
条目（不取 Azure/Bedrock 路由价）；归零或相对底表 >5 倍的变动不发布（进 `rejected`）。
用户定的「全部自动发布」：有变化直接提交 main。DeepSeek / MiniMax（人民币底表、峰谷/分档）
不在同步范围。

app 端：每 6 小时拉一次叠加层（`validate_sync_overlay` 校验）→ `sql_sync::snapshot_with_sync_overlay`
把叠加层原文（`provider_catalog_snapshots`，来源 `public-sync-overlay`）与「底表 + 叠加层」
完整快照（`pricing_snapshots`，`catalog_version` 引用叠加层）同一事务入库。两条合并规则
（`domain::cost::sync_overlay`）不能混用：**新快照覆盖**（改价只对之后的用量生效，厂商
调价不改写历史）；**读历史快照只补缺卡**（新模型发布到价卡上线之间的用量，已有价不动；
会话计费桶标 `pricing_source = "backfilled"`）。叠加层存库不存文件：历史回补在只拿得到
`Connection` 的查询里读它。模型名匹配是「精确 > 最长前缀，且剩余部分不能是新版本号/档位」
（`norm_model_in` ↔ `cost.py::_norm_model_in`，对照表 `tests/test_cost_model_match.py`）——
旧的「第一个前缀命中」让 claude-opus-5-5 吃到 claude-opus-5 的卡且永不报缺价。

### 汇率每日同步（2026-10-01）

与价卡同一个作业（`pricing-sync.yml`）、同一个用户开关（「允许公共价格更新」）、同一类请求（固定
公开 HTTPS 地址、纯静态文件、不带任何用户数据——不改变「app 不回传用户数据」的前提）。
`scripts/fx_sync.py` 取两个独立公开 JSON 源（Frankfurter/欧央行、fawazahmed0），**两源一致（≤0.5%）才
采用**，写 `assets/fx-sync.json`；相对上一份已发布快照偏差 >25% 或日期倒退则**整份**不发布。
app 端 `fx_settings::save_synced` 用 `FxSnapshot::validate_update` 再校验一遍（日期不倒退/不在未来、
共有币种 ±25%、不残缺）并原子落盘 `state/fx-synced-rates.json`；`effective_snapshot` 每次读取都按
内置快照重新校验，坏文件或落后于内置的文件自动退回内置。汇率拉取失败不影响价卡，反之亦然；
用户手动汇率仍优先于任何快照。`tests::the_published_fx_sync_file_is_accepted_by_the_app_validator`
钉住「CI 能发布的文件 app 一定收得下」。

### 计费声明属于服务商，不属于执行环境（2026-10-01）

计费关系（订阅 / API Key / 中转 / 组织）是**服务商账号**上的事，结算按「服务商 + 模型」，执行环境只是
用量的来源壳：同一个 GLM Lite 套餐在 Claude Code 与 ZCode 里是同一份，同一个中转账号在 Claude Code
与 Codex 里也是同一个账号。曾经声明按 `(执行环境, 服务商)` 切分，真机里同一服务商在每个执行环境各留一份、
生效期各自漂移，匹配还要给订阅单开「账号级」补丁。

- **数据层没有执行环境参数**：`billing_declaration_put` / `revision_save` / `fact_selection(_with)` /
  `impact_preview*` / `billing_official_api_declared` 都只收 `provider_id`；`BillingDeclarationRow`
  与 MCP/Tauri 的声明 DTO 不带执行环境。选事实的唯一谓词是 `f.provider_id = ?`（「服务商未知」的组是
  `provider_id IS NULL` + 模型范围），**不看 `f.harness`**；要收窄用 account / route / model / session 作用域。
- **`harness` 列只是旧库 `NOT NULL` 的占位**：写入固定值 `authority::ALL_HARNESSES`（`"*"`），任何谓词都不读它。
  想把执行环境重新当匹配条件，必须先改 `ALL_HARNESSES` 的文档并过评审——这正是被拆掉的耦合。
- **导入候选保留执行环境**（`billing_import_candidates.harness`）：它是「在哪个执行环境的配置里发现的线索」，属于证据来源；
  把候选确认成声明时只比对服务商。
- **结算币种按服务商记**（`declared_settlement_currencies()` → `provider → 币种`）；**月费按服务商只摊一次**
  （旧的 `(执行环境, 服务商)` 去重会让同一订阅在两个执行环境各摊一份）。月费在 `by_provider`（键 `执行环境/服务商`）
  里要有个落点执行环境，只用于展示：服务商自家执行环境 > 用量最集中的执行环境（`dominant_harness_of_provider`）> `unattributed`。
- **收窄靠作用域，不靠执行环境**：「服务商未知」的答复（`("provider","unresolved")`，匹配 `provider_id IS NULL` 的事实）
  **必须带** model / route / account / session 之一，否则它就是对所有执行环境、所有未归属用量的兜底——写入时拒绝，
  旧库里留下的这类声明选择谓词恒假（`0 = 1`，宁可不匹配也不吞用量）。确认弹窗对这类组始终写上组内模型，
  没有可识别模型（`<unknown>`）就拦下，不允许声明。
- **重复保存守卫**：新声明与某条现行声明在服务商 / 关系 / 套餐 / 金额 / 币种 / 起止 / 作用域（集合相等）上完全一致，
  `billing_declaration_revision_save` 返回 `false` 不新建（连点保存曾留下两条一模一样的 minimax 声明）；
  Tauri 命令据此回 `duplicate: true` 且不入队重算。撤销过的声明不再占位。
- **未做**：`by_provider` 的键仍是 `执行环境/服务商`、待确认组仍按 `(执行环境, 服务商, 模型)` 切——那是**用量视图**，
  执行环境是事实自带的来源维度，不是计费归属；改成服务商键会波及全部金额 DTO 与 golden，另立项。

### v0.9.1 数据面维护（SQL 权威库操作面；Phase 4.3 后）

- **布局**：`<data_home>/facts/<harness>.jsonl`（append-only 权威源，执行环境封闭
  词表 claude-code/codex/dsh/workbuddy——E4b 起四执行环境，见 docs/WORKBUDDY_ONBOARDING_SPEC.md §9E.5；workbuddy 金额面恒 unresolved）
  + `<data_home>/agent-vitals.sqlite3`（v0.9.1
  SQL 权威库——所有读经它）。**权威库不自愈**（与已退役的旧 `index.sqlite3`
  投影的本质区别）：`PRAGMA integrity_check` 失败 → `data-status` 报
  `health: critical`；恢复 = `rm agent-vitals.sqlite3* && agent-vitals
  data-migrate`（从 facts JSONL 幂等重放）。
- **writer lease**（`runtime::lease`）：O_EXCL + **原子 rename 陈旧偷取**
  （unlink+create 有无主窗口会双持锁——别改回去）；接线 facts ingest /
  authority 写 / retention。TTL 60s；临界区必须短，慢 fold/emit 在锁外。
- **崩溃恢复**：facts 尾面（crash 半行）由 `FactWriter::open` 修复（半行
  截断 / 完整 JSON 缺封口补换行）——在半行上直接 append 会把新事实和残行
  合并成损坏行，这是 Stage A 审查抓出的真 bug，测试钉死。
- **保留滚动**：UsageFact 保留最近 13 个自然月（含当月，cutoff =
  current − 12——fencepost 已钉死）。`ingest_service::enforce_retention`
  滚 facts JSONL + `authority::retention_usage_facts` 滚权威库，两处共享
  `sql_sync::RETENTION_MONTHS_MINUS_ONE`；`sync_facts` 每天首轮在
  `.ingest.lock` 内自动跑一次。解析不出 YYYY-MM 的事实**按 undated 保留**。
- **导出双路径**（spec §6 明令，不能是一个 `redacted: bool`）：
  `data-export-private`（原样）与 `data-export-redacted`（身份字段 fnv1a64
  伪名化 + fact_id 经契约层重 stamp）是两个独立函数/两个 CLI 子命令。
- **诊断命令**：`data-status`（schema / integrity / health / 质量摘要——
  spec §9 data doctor 的权威库部分）/ `data-unresolved`（逐模型下钻
  unresolved：billing-route-unknown / billing-mode-unknown / no-price-card /
  partial-price-basis）。CLI help 是英文-only 面
  （test_regressions::test_help_defaults_to_english 钉住）。
- **Phase 4.3 退役**（分支 `v0.9.1-phase-4.3-retire-legacy`，用户 2026-09-07
  提前执行）：`summary::JsonSummaryRepository` + 4 个 legacy 读 wrapper、CLI
  `data-reconcile` / `data-reconcile-authority` / `data-budget-reconcile` /
  `data-rebuild-index`、旧 `agent_vitals_data::store`（`index.sqlite3` /
  `FactsIndex`）、legacy `budget show`（→ SQL）、`data-migrate` 的
  `legacy_aggregate` ledger 导入（→ `--with-legacy-ledger` opt-in）全部退役。
  `SummaryRepository` 只剩 `SqlSummaryRepository` 一个实现。**Stage 5b 待做**：
  DSH `oneline` tick 的 `state.rs` merge 写（month.json/today.json/ledger）+
  `evaluate_alert_from_state`/`_after_fold`——需先把 `oneline` 重写成「只产
  导航快照」；`sql_authority_enabled` 已冻结其写盘（Phase 4.2），不阻塞纯 SQL 读。

### 数据留存与出口政策（2026-09-19 决策：留存放开、出口收口、无回传钉死）

定位是**以数据体验为中心的离线桌面产品，app 不回传用户数据**。现有出网请求只有
公开价目目录拉取与版本检查，均不含用户数据；这是受保护前提——新增任何把用户数据
送出本机的路径（telemetry、带载荷的崩溃上报、云同步）必须先经显式产品评审并同步
改写本节与 `AGENTS.md` 的同名节。

- **留存放开（摄取期不再销毁信号）**：错误分类码（HTTP 状态、JSON-RPC −32xxx、
  工具错误词表）、截断摘录（~120 字：错误首行、参数摘要）、尺寸/计数等结构化派生
  全量入库；指纹（canonical args、`error_fingerprint`）保留但降级为去重/索引键，
  不再充当分类字段的替代品。内容富化进**新列/新表**并标 `Provenance`——既有
  事实表契约只经评审过的 golden 更新变动，账务/行为事实表（facts 层）与内容层
  （enrichment 层）分表，纯度不动。
- **出口收口（脱敏是呈现期投影）**：MCP 面维持现有红线（issues_summary 的
  "never expose raw errors or invocation arguments" 等）——本地 agent 是有网消费者，
  data-mcp 供出的任何内容都可能随 agent 上下文离开本机；导出维持双路径
  （`data-export-private` 显式、`data-export-redacted` 默认）。脱敏发生在各出口的
  服务面，**永远不是摄取期丢数据的理由**。
- **红线字段例外（永不落盘）**：凭据（cc-switch token、API key）在任何我们拥有的
  库/文件里不落盘；probe/测试功能只允许内存直传子进程 env。金丝雀题面（L1 探针
  题库）按机密待遇：不进 MCP、不进导出、不进任何 agent 可读面。
- **原文留源 + 锚点**：执行环境原始日志是逐字存储的唯一样本；权威库只存分析增量与
  锚点（source_id + native event id，行号/偏移做可自校验的加速 hints），不复制
  全文（GB 级会话）。原文 JSONL 段落查看是**本地呈现层专属能力**：呈现时读取、
  永不落库、永不进 MCP/导出载荷；执行环境轮换掉源日志后诚实降级为「源已过期，仅存
  库内脱敏投影」，不得静默 404。
- **本政策不放宽项**：账务诚实纪律（`metered_estimate`、`has_unresolved`、不静默
  归因）、golden/Python-Rust 字节对等、以及新问题类先在
  `docs/AGENT_EXECUTION_PROBLEM_TAXONOMY.md` 登记再写 emitter 的规矩。

### Other invariants with tests behind them

- **Zombie verdicts need an age gate** (`zombie_min_age_days`, default 14).
- **Plugin skills are namespaced** — dedup key is `(namespace, name)` i.e. `<plugin>:<name>`.
- **Override precedence is `enterprise > personal > project > plugin`** — the home copy
  shadows the project one. This is why `conflicts` splits into `shadowed_newer`,
  `intentional_override`, and `redundant`.
- **Redaction must survive into paths and free text** — `--redact-names` collects every
  name first, then replaces longest-first; `description` is dropped wholesale. All
  statistics must remain identical after redaction.

### Dual implementation, differential guard (2026-08 revision)

Python and Rust are **currently parallel implementations under a differential gate** —
but this is not an immutable hard limit. It is a clause this repo is revising: per
`docs/TAURI_RUNTIME_WORKBENCH_SPEC.md` §7.1 (Phased Python Diminishment RFC), the
structure is phased down — orchestration/IO (Tauri, IPC, watchers) is Rust-only from
tier 1; pure rules migrate into the Rust core one rule at a time, each removed from
Python only after the lockstep gate passes; the Python distribution form retires only
when the tier-3 exit conditions hold. While a rule's Python implementation still
exists, divergence must not survive one CI run: both implementations run the same
goldens byte-for-byte, and the `differential` job turns red the day they disagree.
Rust serves the binary channels (npm/brew/cargo/Release); Python serves the ClawHub
in-harness skill form and cross-language readers. See `docs/ENGINEERING.md` §6.8.

### DSH audit: computation is harness-side

**This whole section describes the standalone `dsh-agent-vitals-audit` repo** (extracted from
`integrations/dsh-client/` on 2026-09-22), kept here because the design still governs how this
repo's wasm crate and price table must be shaped to stay consumable by it — every
`integrations/dsh-client/...` path below is now a path in *that* repo, not this one.

The browser cannot read raw session events (the client `SessionFace` only exposes
projections, and approval/sandbox events are log-only). So behavior findings are
computed on the **harness** via a `sessionProjections` projection whose `view` calls the
wasm `audit_events` over the raw event fold; the client reads `useProjection('behaviorFindings')`.
The cost side (per-model token buckets) folds through the same core — the `tokenByModel`
projection's `view` calls the wasm `token_by_model` — so the tab runs the *exact* engine the
CLI `behavior` command runs (never a second copy). Pricing those buckets into money is
*also* harness-side now: the `costReport` projection (`integrations/dsh-client/src/harness/index.ts`) reads
`tokenByModel`'s fold and prices it against `integrations/dsh-client/pricing.json` — a build-time copy of
the single-source `assets/pricing.json` (Rust embeds the source via
`include_str!`; Node can `readFileSync` its own copy directly, unlike the browser). The client
just renders `useProjection('costReport')`. `AuditView.tsx` keeps a second, *display-only*
baked `PRICING` copy in `styles/index.ts` — not for pricing math, only for the model
short-name lookup used in badges/chips — guarded by `tests/test_pricing_lockstep.py` (which
also byte-compares `integrations/dsh-client/pricing.json` against the source, catching a forgotten copy).
See `docs/AUDIT_TAB_DESIGN.md` for the current optimization backlog.

**The one exception to "computation is harness-side": the timeline's geometry.** Turning
`requests[]` into an SVG path is presentation, not measurement, so it lives client-side in
`integrations/dsh-client/src/client/timeline.ts` — but as a *pure* module, exported through
`index.cts`'s `__pure` (test-only surface) and asserted directly by
`scripts/verify-timeline.mjs`. The reason it is isolated at all: a wrong scale factor
draws a wrong chart **without failing anything** — no exception, no red test, only a human
noticing the curve looks off. Two invariants have tests behind them: the curve may be
aggregated to display width but **event markers never are** (`eventsIn === eventsOut`),
and a bucket with no measured rows **breaks the line** rather than interpolating across a
gap that was never measured. The timeline deliberately has no "cost" mode: per-request
pricing needs each request's own peak/off-peak verdict, a rule that lives in the Rust core
and is exposed only through aggregates — reimplementing it in the browser would be a
fourth copy.

### Codex 行为检测：2026-08 起原生填 timeline，SV 规则部分可跑

Codex 会话解析（`adapters/codex_session.py`）对齐了**三套 schema 里的两套**：cost
（`codex_usage.py` 的 5 桶读 `last_token_usage` + 按 `total_token_usage` 签名去重，
`:9-15` 明写故意不同于 DSH 的 4 桶 + `(turn, step)` 去重）和 evidence（`codex_evidence.rs`
的 19 信号覆盖计数）。behavior 层的历史分两段，都是被真机证据纠正的假结论：

- **曾以为「Codex wire 格式凑不齐 boundary-event payload、硬填即编造零、timeline 恒为
  空」**——基于旧 fixture，被真实 rollout 推翻：Paginated 线格式其实能原生填满 4 条
  timeline（approvals 除外）。`custom_tool_call{exec}` 与 `CommandExecution` 是同一逻辑
  exec 的两份影子（`call_id` 与 item `id` 无 join key），以 `CommandExecution` 为主源、
  跳过影子，否则双重计数会破坏 SV611 的重复检测。`sandbox_policy` 线格式漂移（真实对象
  `{type}` vs 旧 fixture 字符串）两态都认——P4.5 RolloutItem schema-drift sentinel
  （§14.4）早该抓到的 drift。
- **门控一度读覆盖计数**（`s.coverage.get(**sig).total() == 0`）而 detector 主体读边界
  事件流（`detect_sv612` 按 turn 分组迭代）。DSH 上两者同源；Codex 上分叉——
  `derive_coverage` 把 `task_started` 等数成非零 measured、timeline 恒空（当时的真实
  状态），读计数会让门控放行、主体空转，产出 **MeasuredZero** 而非诚实的 Unavailable
  （`evidence.rs`「adapter 不得用读不到的东西刷覆盖」的镜像面）。现门控改读
  `CanonicalSession::timeline_is_empty`（`evidence.rs`，requires 信号映射到对应 timeline
  的非空性），单测
  `empty_timeline_with_nonzero_coverage_is_unavailable_not_measured_zero`
  钉住「覆盖非零 + 时间线为空 → Unavailable」。

**`TurnBoundaries` 是撞车名**：evidence 侧（`codex_evidence.rs`，`task_started`/`task_complete`
即 bump measured）是覆盖**计数**；detector 侧（`trajectory.rs`，SV612/613 的 `requires`）是
边界**事件流**的门槛。这正是「coverage 里 Codex 的 TurnBoundaries 是绿的、behavior 层却
一行不跑」的历史来源。

**当前真值表**（`populate_codex_timelines` 填充，真值表单测钉住），按线格式分两栏：
- **Paginated**（有 CommandExecution）：SV601/602/603（exec→bash，命中 rm/sudo/curl|sh 类）、
  SV610（sandbox_policy→sandbox_modes，danger-full-access）、SV611/612/613
  （tool_calls/turns/tool_results 非空）、SV614c（OR 门控：approvals 空但 sandbox 非空）
  **可跑**；SV604/605/606（Codex 没有 write/edit/web_fetch 工具名）与 SV607/608
  （`exit_code:N` 合成码 ∉ DSH 码集）诚实报 **MeasuredZero**；SV609 / SV614a-b（approvals 空）
  报 **Unavailable**。
- **Legacy**（无 CommandExecution——真实 7/25 的 679 次工具执行全是 `custom_tool_call`，它是
  JS 沙箱工具、不一定是 shell）：`exec→bash` 只在能挖出字面量 `exec_command({cmd})` 的 input
  上发生（quote-aware 提取，实测 187/679），apply_patch 等非 shell 不误报；custom_tool_call
  路径不产 tool_results（无 exit/error 源），但 function_call_output 照常填（error 恒 null
  → None），所以 SV607/608 与 SV613(b) 报 **MeasuredZero**（规则照跑零命中）；SV612 因
  custom_tool_call 与 function_call 都无 turn_id、turn sig 恒空报 **MeasuredZero**；SV611 只
  在挖出的 bash 子集上跑。

`exec→bash`/`exit_code→error_code` 是 L2 适配器的执行环境词表翻译（近似、可能误报）；「Codex
根本没有的维度 → MeasuredZero 而非 Unavailable」是已知代价，name-aware 门控是后续项。结构
对齐由 `tests/test_canonical_schema.py` 逐字段对账 Rust `CanonicalSession`；非空形状由
`test_populated_timelines_are_native_and_structured` 钉住，Legacy 回退由
`test_legacy_fallback_extracts_real_shell_cmds_only` 钉住。

## Six test layers, six different jobs

- `tests/test_regressions.py` — one case per **defect that actually shipped**.
- `tests/golden_runner.py` + `golden/*.json` — byte-for-byte snapshots. `AGENT_VITALS_BIN=<path>`
  points it at the Rust binary; that env var is the whole Python→Rust test story.
- `tests/test_invariants.py` — asserts the 12 invariants by their discriminating values.
- `tests/test_characterization.py` — pins the pure functions (`est_tokens`,
  `parse_frontmatter`, `plugin_identity`, `lookup_usage`, `is_cited`, `days_since`,
  `redact`, `diff_against`) to exact values; these are the numbers a Rust `#[cfg(test)]`
  must reproduce.
- `tests/test_properties.py` (hypothesis, optional) — redaction leaves no real name in
  any field at any depth, and `est_tokens` is total over arbitrary Unicode.
- `tests/test_degradation.py` — malformed corpus must not abort the scan, and malformed
  entries must *surface* rather than vanish (explicitly bought in Rust).

`--update` rewrites the oracle. Confirm the diff is intended first; a reflexive `--update`
turns the golden into a record of current behaviour and the test stops meaning anything.

### Tests read the real machine

`run_scan()` with no `--path` scans the actual harness directories of whoever runs it.
`SCAN_CMD` is the Rust binary when `AGENT_VITALS_BIN` is set, else the Python scanner.
`TestScannerExcludesItself.test_self_excluded` therefore passes `--self-root ROOT`
explicitly: the binary has no `__file__` to infer its own skill dir from, and without the
flag it used to silently scan itself (22 own-rule findings) under the differential
harness — the exact regression that test guards. Any failure in this file is real.

**`--path` does not isolate** — `main()` does `DEFAULT_ROOTS + [custom paths]`. Anything
needing reproducible output must set `HOME=<fixture root>` and `cwd=<fixture root>/workdir`.
On macOS `/tmp` is a symlink to `/private/tmp`; `classify()` prefix-compares an unresolved
`HOME_N` against `skill_dir.resolve()`, which silently demotes every `personal` skill to
`unknown`. `tests/golden_runner.py` handles all of this.

## Editing conventions

Comments in `scan.py`, `src/*.rs`, and the test docstrings are Chinese and explain *why the
obvious implementation was wrong*, usually citing the defect that shipped. Preserve that
register: when changing one of the invariants above, update the comment explaining the
trade-off, and add a regression test whose docstring says what actually broke.

When a rule changes, it changes in **three places that must stay in lockstep**: the Rust
domain crate (`crates/agent-vitals-domain/`, imported as `agent_vitals_domain::*`), the
Python implementation (`packages/agent-vitals-python/agent_vitals/agent/behavior.py`), and — for anything the
DSH audit tab uses — the wasm crate (rebuild + re-copy the `.wasm` into the standalone
`dsh-agent-vitals-audit` repo — see its README; no longer `integrations/dsh-client/` in this
repo, extracted 2026-09-22). The differential golden guard
catches Python↔Rust drift; the wasm↔CLI drift is caught only by re-running the wasm build
against the same fixtures, so verify that manually. The **trajectory detectors** (`trajectory.rs` ↔ `trajectory.py` ↔ wasm `audit_events` 合并 ↔ dsh 提取的 `turn/start·step/start·turn/end·step/end` 边界信号) are the same lockstep. The **cost fold** (`usage.rs` ↔
`usage.py` ↔ wasm `token_by_model` ↔ dsh adapter `usage_events`) is the same three-way
lockstep; its reconciliation invariant — bucket sums must equal DSH's `tokenUsage` — is
checked against a real session log in the CLI's `behavior` output.

The **v0.7 UsageFact emitters** (`{claude,codex,dsh}_usage_fact.py` ↔
`agent-vitals-harnesses/harnesses/<h>/sources/usage_fact.rs` — v0.9 Stage A 归位出
apps/cli，CLI 经 `agent_vitals_harnesses::*_usage_fact` re-export，driven by the
`{claude,codex,dsh}-usage-facts` CLIs)
are Python↔Rust byte-parity locksteps pinned by `AGENT_VITALS_BIN` differential in
`tests/test_{claude,codex,dsh}_usage_fact.py`. They share ONE identity primitive —
`crates/agent-vitals-domain/src/contracts/source_identity.rs` (`canonical_json` + `fnv1a64_hex`) ↔
top-level `packages/agent-vitals-python/agent_vitals/source_identity.py` — which is also what
`usage_fact.{rs,py}`'s `fact_id` and the DSH observer's frozen `source_event_id` hash
through; **no consumer may grow a second inline copy** (the `test_classification.py`
agent-family sets pin the module list verbatim; the ClawHub packaging allow-lists were
removed with `package-clawhub.yml` in 2026-10). The emit is
in-memory + read-only diagnostic only — nothing is written to disk yet (see
`docs/VITALS_CORE_V0_7_DATA_PLANE_SPEC.md` §7). E4b superseded the "deliberately
excluded" decision (2026-09-11, docs/WORKBUDDY_ONBOARDING_SPEC.md §9E.5): WorkBuddy
joined FACT_HARNESSES and the sync pipeline — facts carry `provider_id: null`
(unresolved money by design, §2.1); the CLI `--write` and `sync-facts` are Rust-only,
the Python mirror stays read-only diagnostic.

**"Which events carry usage" is one predicate, and it was duplicated twelve times.** It
lives in `usage.rs::usage_sample` (the authority), mirrored in `usage.py::_usage_sample`,
and gated *earlier* by the DSH adapter (`dsh.rs`/`dsh.py::is_usage_event`) and *earlier
still* by eight `apply()` filters in `src/harness/index.ts` of the standalone `dsh-agent-vitals-audit`
repo (now collapsed into one `carriesUsage()` helper). Each layer runs before the next, so **fixing the authority alone
fixes nothing** — an event dropped by the adapter never reaches the fold, and one dropped by
a projection's `apply()` never reaches wasm. That is exactly how `compaction/summary`'s real
token spend (it carries `data.usage` *and* its own `model`/`provider`, which differ from the
session's active model) went uncounted everywhere: it failed the type whitelist, and it has
no `turn`/`step` because compaction is command-triggered, not part of any turn
(`compaction_identity()` hashes `compactionId` into negative space to give it a dedup slot;
`request_metrics` reports its turn/step as `null` so that internal identity never leaks out
as a plausible-looking turn number).

The durable defense is not a longer whitelist but a **residual sentinel**: every fold reports
`unaccounted_usage` — events it did *not* consume whose payload nonetheless contains the very
token field names it knows how to read. It is the dual of `unreported_fields` ("the harness never
reported this field" vs. "the harness reported tokens and we failed to catch them"), and in the
evidence model it is `Signal::Usage`'s `unmetered` count — `evidence.rs` predicted this bug
verbatim: *adapters must not inflate their own coverage by not counting what they cannot read*.
Because of the layering, the sentinel is useless unless the layers above it are **permissive**:
adapter and projection filters keep anything usage-*shaped* (`usage_shaped_tokens` /
`looksUsageShaped`), while pricing stays strict (`usage_sample` only). Wide in, narrow out —
the machine finds, a human classifies. Never merge those two paths: structural detection alone
would double-count, since one logical charge appears in several events (that is what the
`(turn, step)` replacement dedup exists for). The sentinel initially reported *zero* gaps —
a false negative caused by the adapter filter sitting above it; treat a clean sentinel as
meaningful only once every layer above it is permissive.

**The same fold has a third projection, and it is load-bearing: `token_by_date_model`
(`usage.rs` ↔ `usage.py`).** The calendar and the DSH audit tab are not two features that
happen to both compute money — they are **one audit capability projected along two axes**:
the tab slices by session (`token_by_model`), the calendar slices by time
(`token_by_date_model`), and *the monthly token total and cost of the two must be equal*.
Nothing enforced that until 2026-08, when the calendar reported ¥2386 for a month whose
per-session recomputation was ¥1733 — found by hand, not by a test. The guards now are
`usage.rs::token_by_date_model_reconciles_with_token_by_model` (exact equality; the only
legitimate difference is untimed samples, which the date axis drops by design and which is
pinned by its own test) and a byte-for-byte Python↔Rust parity test on both sides. Do not
"simplify" the date axis into a Python-only helper: it fell outside the differential once
already, and the menu-bar work (Rust-Tauri) consumes this same fold.

**The same fold is also *resumable* (the watcher's incremental path, §10.2).** The fold's
cross-turn state lives in `UsageFoldState` (`usage.rs`) / `_usage_fold_default`+friends
(`usage.py`), and the contract `fold(events[0..n]) == fold_resume(checkpoint@k, events[k..n])`
for any **turn boundary** k is pinned byte-for-byte on both sides
(`usage_fold_resume_equals_full_fold_at_turn_boundaries` in Rust, `tests/test_resumability.py`
in Python, plus cross-language characterization on `usage_fold_resume` and
`usage_fold_checkpoint_json`). The `last` same-step dedup slot is deliberately **not** in the
checkpoint — a resume suffix starts at a turn boundary, so its first usage event is a new turn
and cannot collide with the prefix's final (turn, step); mid-turn checkpoints would need to
serialise that slot, and the contract does not promise them. Incremental folding is not a
separate fast path: `token_by_model` itself is `usage_fold_checkpoint` + `usage_fold_resume`,
so the two are equal by construction. In Python, `usage_fold_resume` deep-copies the state —
a resume that mutates the caller's checkpoint would silently double-count on reuse. (`state.py`'s `merge_today`/`merge_month`/
`rotate_today`/`read_month`/`list_months`, `budget.py`, `cli.py`'s `oneline`/`calendar`) is
the one place in this repo that accumulates *across* invocations, and its invariants are not
input→output but **cross-call**: every token lands in `month.json` exactly once
(`merge_month` owns that write — `rotate_today` must never also add, which is what silently
tripled 2026-08), a backfilled log attributes to *its own* date rather than `_today_key()`,
and a day whose `by_model` covers only part of its tokens must be labelled `partial`, never
priced as if exact — that check lives in exactly one place, `cost.py::priced_day`, because
the day it existed only inside the calendar's renderer, the calendar and the budget menu-bar
projection (same `month.json`, same month) silently disagreed with each other on the price of
that day. Tests here must start from *already-populated* state; every one of these bugs
survived a green suite because the tests began from an empty state directory — including one
introduced *while fixing another*: `priced_day` was added for the calendar and left
`budget.py` un-migrated for a turn, which a cross-projection-agreement test (`budget.py`'s
`test_month_and_calendar_agree_on_the_same_partial_coverage_day`) now pins directly, rather
than relying on each call site being individually correct.

`month.json` holds **only the current calendar month**; `merge_month` migrates any date that
has rolled out of it into `month-archive.json` (keyed `{"YYYY-MM": {"days": {...}}}`) before
writing new data, so that no reader of `month.json` needs to filter by date to get "this
month's" figure right — before this, nothing filtered, and a month.json carrying a couple of
leftover August rows reported a September total 201× too high. The migration write is a
per-day *replacement* (idempotent — crashing mid-migration and retrying re-copies the same
day, never doubles it); a *backfill* into an already-archived month is a per-day
*accumulation* instead, because that call is new evidence, not a re-run of the same migration.
Query a historical month with `state.read_month("YYYY-MM")` /
`agent-vitals budget show --month YYYY-MM`; `state.list_months()` /
`agent-vitals state months` enumerates what has data. The computation (`token_by_date_model`,
`priced_day`) is in agent-vitals-domain / `cost.py` precisely so the Tauri menu bar and any future
month-query surface reuse it rather than growing a fourth copy. The DeepSeek **price
table** lives only in `assets/pricing.json` (CLI 两侧读它；直到 2026-09-22，`integrations/
dsh-client/pricing.json` 是 build 时复制出的运行时份、`styles/index.ts` 另内嵌一份仅供
展示用的模型短名副本——三处由 `tests/test_pricing_lockstep.py` 守。dsh-client 拆成独立
仓库 `dsh-agent-vitals-audit` 后，那两份副本活在那个仓库里，`test_pricing_lockstep.py`
在本仓库摸不到 dsh-client 目录时优雅跳过，不再是硬失败——同步纪律见那个仓库 README）;
prices are business data, not rules — they change without a golden `--update`. The
**cost computation itself** (`cost_report`) is a fourth lockstep, one level up from the
price table: `crates/agent-vitals-domain/src/domain/cost/mod.rs` ↔ `packages/agent-vitals-python/agent_vitals/agent/cost.py`
↔ `src/harness/index.ts::costReportFrom` in the standalone `dsh-agent-vitals-audit` repo all
implement the same peak/off-peak-split pricing math over `{by_model, sequence}`; the CLI
two-language parity is caught by `test_cli_matrix.py`'s `both()` differential, the TS mirror
by that repo's own `scripts/verify-harness.mjs` asserting real numbers against its checked-in
`pricing.json` copy. (2026-08: cost 从二进制 `src/agent/cost.rs` 迁进 domain crate —— preflight
Phase 0-1 —— 二进制侧退成 `pub use` 薄封装；`priced_day` 一并进 core
（`cost.rs::priced_day` ↔ `cost.py::priced_day`，`tests/test_cost_priced_day.py` 交叉锁定），
Tauri 菜单栏与未来按月查询 surface 直接 `use agent_vitals_domain::cost`，不长第四份拷贝。)

Scan output must never be committed — `.gitignore` covers `skill-scan*.json`, `scan-*.json`,
`*.scan.json`, and the npm `node_modules/` of `integrations/dsh/` (that ignore line for
`integrations/dsh-client/` is now dead weight left over from before the 2026-09-22 extraction —
harmless, but there is nothing left under that path to ignore). What used to be the committed
`integrations/dsh-client/agent_vitals_wasm_bg.wasm` and `integrations/dsh-client/pricing.json`
build-artifact exceptions (the harness plugin `readFileSync`s both at runtime — the wasm binary
and the price table `costReport` prices against — `wasm-opt` disabled so the wasm build needs
no network, `pricing.json` a plain `cp` from `assets/pricing.json`) now live as the equivalent
committed files in the standalone `dsh-agent-vitals-audit` repo; re-copy them by hand there
whenever this repo's source changes — `tests/test_pricing_lockstep.py`'s
`HarnessPricingCopyLockstepTests` used to byte-compare them and fail loudly on a forgotten copy,
but it can no longer see that repo's copy, so it now skips instead. The forgotten-copy failure
mode this test used to catch is real again; there is no automated guard for it anymore.
