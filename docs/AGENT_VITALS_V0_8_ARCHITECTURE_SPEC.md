# Agent Vitals 目录与模块边界设计

> 状态：目标架构 **v3.1**（2026-09-04：执行环境统一为 `agent-vitals-harnesses` 单 crate +
> feature-gated `sources/`，见 §4/§5/§6）。**Phase A-E 已全部实施完成并合入
> `main`**（2026-09-04，`27e2960`…`012065c`）——workspace 现为 `vitals-core` ←
> `agent-vitals-domain`（`contracts/` + `domain/` + `compatibility/`，单 crate）←
> `agent-vitals-harnesses`（Phase D3 由 `agent-vitals-adapters` 改名；`harnesses/<h>/
> sessions/`=纯 + `harnesses/<h>/sources/`=feature-gated I/O）← `agent-vitals-runtime`
> （Phase D6/D7：state/budget/takeover/session_sources/clock + 唯一
> `HomeResolver`）← `apps/cli`（二进制，Phase E3 由根 `src/` 迁来）/
> `agent-vitals-wasm` / `apps/desktop/src-tauri`（Phase E2 由根 `src-tauri/` 迁来）。
> `agent-vitals-core` 与中途的 `agent-vitals-contracts` 独立 crate 均已撤销；调用方
> 直接 `use agent_vitals_domain::*`。目录搬迁（Phase E1-E6：`integrations/`
> `packages/agent-vitals-python/` `assets/`）同样已完成。**本文档下方 §2/§8/§11/§13
> 等小节仍保留大量 Phase 进行中/`agent-vitals-adapters` 旧称的叙述——这些是历史
> 实施记录，未逐段刷新到"已实施"时态；当前真实状态以 `CLAUDE.md` 的 Repo layout
> 段 + `AGENT_VITALS_V0_8_PHASE_{C,D,E,F}_RESEARCH.md` 的完成记录为准。**
> **Phase F（MCP Surface）**：F1a（会话证据 `mcp__` 命名拆分，零新 I/O）已完成
> （`4dc0312`）；F1b（读 `~/.claude.json` 的 `mcpServers` 配置）及以后**用户
> 2026-09-04 拍板暂停，留给用户专门评审**——实测该文件本机真实携带明文 API
> 凭证，写错默认透出边界的后果不可轻易补救，见
> `AGENT_VITALS_V0_8_PHASE_F_RESEARCH.md`。
> 适用范围：Rust workspace、Tauri、Python 便携实现、执行环境接入与测试资产
> 关联文档：`ARCHITECTURE.md`、`DELIVERY_ARCHITECTURE.md`、
> `TAURI_RUNTIME_WORKBENCH_SPEC.md`、`VITALS_CORE_V0_5_IMPLEMENTATION_SPEC.md`、
> `VITALS_CORE_V0_6_HARNESS_CONTRACT_SPEC.md`、`VITALS_CORE_V0_7_DATA_PLANE_SPEC.md`

> v2 补充：Skill/Session 双数据面、Model & Billing、User Profile，以及基于现有
> Rust/Python/Tauri 代码的架构差距评估。本文描述目标边界，不授权在功能提交中夹带
> 目录搬迁。
>
> v3 实施记录（历史叙述，保留原文）：Phase A 建 `contracts/domain/adapters/
> compatibility` 所有权目录并以 re-export 保旧路径；DSH Session 读取从 Skill
> inventory 移到 Session source 后注入。Phase B1 抽出 `agent-vitals-adapters` 并
> 迁出叶子 evidence adapter。Phase C（Step 1–4）断开 `domain → harness` 生产耦合、把
> `contracts/`+`domain/`+`compatibility/` 收进 `agent-vitals-domain`、撤销
> `agent-vitals-core` facade。B2（Codex fold + canonical 层物理迁 adapters）随
> Step 3 收口。Phase D（D1-D7）完成 wire/fold 分离、`cost.rs` 切分、
> `agent-vitals-adapters` → `agent-vitals-harnesses` 改名、harness I/O → `sources/`、
> `agent-vitals-runtime` crate、唯一 `HomeResolver`。Phase E（E1-E6）完成
> `apps/`/`packages/`/`integrations/`/`assets/` 目录搬迁。**执行细节见各自的
> `AGENT_VITALS_V0_8_PHASE_{C,D,E}_RESEARCH.md` 完成记录，不在本文重复。**

## 0. 结论

Agent Vitals 应形成六层单向架构，并由三类独立数据面提供证据：

```text
用户配置            套餐、按量账户、数据源覆盖、预算与偏好
   │
   ├───────────────┐
   ▼               ▼
产品入口（CLI / Tauri / integrations）
                    │
                    ▼
Runtime             文件、SQLite、zstd、watcher、state、catalog、任务编排
                    │
                    ▼
Harness Adapters       Skill / Session / MCP 的执行环境 wire 解释与标准事实生成
                    │
                    ▼
Agent Domain        模型解析、Billing、UsageFact、Evidence、Finding、报告投影
                    │
                    ▼
Vitals Core         完全通用的证据、覆盖率、检测与回放机制
```

三类证据面必须区分：

```text
Skill Surface       Agent 声明、加载和可发现的能力
Session Surface     Agent 实际行为、用量、成本与轨迹
MCP Surface         外部工具服务的配置与运行健康（后续阶段）
```

它们可以共享同一个执行环境 descriptor、source profile 和 provenance，但不能因为底层都
“扫描文件”而共用 scanner、fold 或输出模型。

关键命名：

- `vitals-core`：真正通用的 Vitals Framework，不认识 Agent 或任何执行环境；
- `agent-vitals-domain`：Agent Vitals 的跨执行环境领域契约与业务计算（纯）；
- `agent-vitals-harnesses`：**一个执行环境一个文件夹**（§4 v3.1）——每个执行环境的
  `sources/`（I/O，`sources` feature 门控）+ `sessions/`/`skills/`（纯）同目录相邻；
  wasm 用 `default-features = false` 只链纯子树；
- `agent-vitals-runtime`：**非执行环境**的本机机器——state/ledger、watcher、唯一
  `HomeResolver`、catalog loader、User Profile、service 编排；依赖 `agent-vitals-harnesses`
  的 `sources` feature；
- `Model Catalog`：模型/provider 身份与版本化价格、套餐定义；
- `User Profile`：当前用户声明的账户、套餐、费用和计费路由；
- `agent-vitals`：用户看到的产品名、CLI 命令和安装包名。

**已到位**（Phase A-E 全部完成）：`agent-vitals-domain` = `contracts/`（执行环境无关词表）+
`domain/`（跨执行环境计算）+ `compatibility/`（vitals-core 桥）。`agent-vitals-core` 已删除。
`agent-vitals-adapters` → `agent-vitals-harnesses`（`harnesses/<h>/sessions/` 纯 +
`harnesses/<h>/sources/` feature-gated I/O）已完成改名+落地，DSH wire 已从
`domain/dsh/` 迁进 `harnesses/dsh/sessions/`。`agent-vitals-runtime` crate、
`apps/{cli,desktop/src-tauri}`、`packages/agent-vitals-python/`、
`integrations/{dsh,dsh-client}/`、`assets/` 均已到位。

> **v3.1 修订（2026-09-04）**：§4 起把 v3 的「`agent-vitals-adapters/harnesses/<h>/`（纯）
> + `agent-vitals-runtime/sources/<h>/`（I/O）双 crate」统一为 `agent-vitals-harnesses`
> 单 crate + feature-gated `sources/`（用户维护性反馈）。**§2 目录树、§3 依赖规则、
> §8 接入模板、§11 迁移映射、§13 分阶段、§14 守卫里凡出现 `adapters/harnesses` +
> `runtime/sources` 双 crate 表述的，一律以 §4/§5/§6 为准**；这些下游小节的逐字
> 更新随 Phase C/D 落地时同步，不在本次 doc 改动里全刷。

---

## 1. 核心术语

### 1.1 Source Connector

Source Connector 回答：**数据在哪里，如何可靠地取到？**

职责包括：

- 定位执行环境安装目录和会话文件；
- 读取文件、SQLite、JSONL；
- zstd 解压与多帧读取；
- 文件监听、debounce、checkpoint；
- 权限、缺文件、坏压缩等 I/O 错误分类；
- 生成 source revision/fingerprint。

它不解释 token 字段，不判断两行是不是同一次请求，也不计算 Finding。

### 1.2 Harness Adapter

Harness Adapter 回答：**拿到内存中的执行环境记录后，这些记录是什么意思？**

职责包括：

- 识别执行环境 wire shape；
- 把执行环境字段翻译成稳定的领域字段；
- 消解执行环境特有的 shadow、重复视图和累计快照；
- 把 cumulative 变成 delta；
- 生成 `CanonicalEvent`、`CanonicalEvidence`、`UsageFact`；
- 声明该执行环境的 capability/coverage 上限；
- 保留 provider/model 等原始证据。

Harness Adapter 可以执行**执行环境语义所必需的纯计算**，但不能读文件、环境变量、SQLite，
也不能写 state。这里的“adapter 不做计算”应理解为“不做跨执行环境产品分析”，而不是
禁止它完成去重、快照差分和字段归一化。

### 1.3 Agent Domain

Agent Domain 回答：**标准事实产生后，Agent Vitals 如何审计和解释？**

职责包括：

- `UsageFact`、`SessionKey`、Coverage 等契约；
- 跨执行环境统一的 cost/budget/usage 计算；
- trajectory、detector、Finding；
- 会话、日历、总览等投影；
- schema migration 与兼容投影。

它不能知道执行环境文件位于哪里，也不应直接解析 Claude/Codex/DSH 原始 JSON 路径。

### 1.4 Vitals Core

Vitals Core 回答：**任意领域的事实如何形成可回放、可解释、三态诚实的诊断？**

它只提供通用机制：Event、Evidence、Signal、Coverage、Provenance、Detector、Replay、
Engine、Finding。公开模块、类型和 fixture 不出现 Codex、Claude、DSH、WorkBuddy、Skill
或 SV 规则码。

### 1.5 Product App

CLI、Tauri 和 integrations 是交互与投递层：解析参数、调用 runtime service、展示或
导出结果。它们不复制 adapter、计费和 detector 的规则。

### 1.6 Skill Surface 与 Session Surface

Skill 与 Session 虽然都可能来自磁盘扫描，但语义完全不同：

| 数据面 | 回答的问题 | 典型输入 | 主要输出 | 更新节奏 |
|---|---|---|---|---|
| Skill Surface | Agent 能做什么、什么已加载/可发现 | `SKILL.md`、plugin/config、skills/list | `SkillVitalRecord`、能力漏斗 | 配置变化、低频扫描 |
| Session Surface | Agent 实际做了什么、哪里异常 | JSONL、rollout、SQLite、事件流 | `CanonicalSession`、`UsageFact`、Finding | 日志追加、近实时 |
| MCP Surface | 外部工具是否配置正确、可用、可靠 | MCP config、handshake、tool call/result | `McpServerRecord`、MCP Finding | 配置变化 + 运行事件 |

三者只通过稳定身份和 provenance 关联。例如 Session 中的 skill invocation 可以推进
`Installed → Loaded → Triggered` 漏斗，但 Session Adapter 不负责扫描 `SKILL.md`，Skill
Adapter 也不负责解释 token/cost。

### 1.7 Model Catalog 与 Billing

模型层分成四个连续步骤，不能塞进 Harness Adapter 或单个 `cost.rs`：

```text
model_raw/provider_raw
        ↓ Model Resolver
model_id/provider_id + normalization_version
        ↓ Rate Card Resolver
时间有效的模型价格
        ↓ User Billing Route
subscription / metered / hybrid / unknown
        ↓ Cost Projection
billed / estimated / covered / uncovered / unresolved
```

官方模型、价格和套餐定义属于版本化 Catalog；“当前用户买了什么”属于 User Profile。
套餐覆盖不等于 token 单价为零，月度总感知成本必须把固定订阅支出与按量支出分开。

### 1.8 User Profile

User Profile 是用户声明的本机配置，不是程序观测 state：

- 产品偏好与预算；
- 执行环境 source path/profile 覆盖；
- 用户账户别名；
- 订阅套餐、有效期、实际月费和币种；
- harness/source_profile/provider 到计费账户的路由；
- 按量、订阅、混合或未知的声明。

Runtime 负责从 `~/.agent-vitals/` 读取并校验配置，再把 typed `BillingContext` 传给
Domain。Domain 不自行读取 home，配置中也不保存 API Key、OAuth token、Cookie 或支付
凭证。

---

## 2. 目标目录结构

```text
agent-vitals/
├── Cargo.toml                         # Rust workspace，只声明成员与公共 profile
├── README.md
│
├── apps/                              # 用户直接运行的产品
│   ├── cli/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs
│   │       ├── commands/
│   │       │   ├── scan.rs
│   │       │   ├── doctor.rs
│   │       │   ├── sessions.rs
│   │       │   ├── usage_facts.rs
│   │       │   └── export.rs
│   │       └── output/
│   │           ├── json.rs
│   │           └── terminal.rs
│   │
│   └── desktop/
│       ├── src-tauri/
│       │   ├── Cargo.toml
│       │   └── src/
│       │       ├── main.rs
│       │       ├── commands/
│       │       ├── tray/
│       │       ├── watcher/
│       │       └── window/
│       └── ui/
│           ├── package.json
│           └── src/
│               ├── pages/
│               │   ├── overview/
│               │   ├── sessions/
│               │   ├── calendar/
│               │   ├── findings/
│               │   └── sources/
│               ├── components/
│               └── ipc/
│
├── crates/
│   ├── vitals-core/                   # 通用机制；现有 crate 保留
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── id.rs
│   │       ├── event.rs
│   │       ├── signal.rs
│   │       ├── coverage.rs
│   │       ├── provenance.rs
│   │       ├── trajectory.rs
│   │       ├── detector.rs
│   │       ├── evidence.rs
│   │       ├── finding.rs
│   │       ├── replay.rs
│   │       ├── engine.rs
│   │       ├── report.rs
│   │       └── error.rs
│   │
│   ├── agent-vitals-domain/           # 跨执行环境 Agent 领域
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── contracts/
│   │       │   ├── mod.rs
│   │       │   ├── usage_fact.rs
│   │       │   ├── session_key.rs
│   │       │   ├── source_identity.rs
│   │       │   ├── harness_capability.rs
│   │       │   └── coverage.rs
│   │       ├── audit/
│   │       │   ├── mod.rs
│   │       │   ├── canonical_audit.rs
│   │       │   ├── trajectory.rs
│   │       │   ├── findings.rs
│   │       │   └── detectors/
│   │       ├── analytics/
│   │       │   ├── mod.rs
│   │       │   ├── usage.rs
│   │       │   ├── budget.rs
│   │       │   ├── duration.rs
│   │       │   ├── compaction.rs
│   │       │   └── waste.rs
│   │       ├── models/
│   │       │   ├── mod.rs
│   │       │   ├── identity.rs
│   │       │   ├── resolver.rs
│   │       │   ├── aliases.rs
│   │       │   └── normalization.rs
│   │       ├── billing/
│   │       │   ├── mod.rs
│   │       │   ├── account.rs
│   │       │   ├── user_profile.rs
│   │       │   ├── rate_card.rs
│   │       │   ├── subscription.rs
│   │       │   ├── entitlement.rs
│   │       │   ├── attribution.rs
│   │       │   ├── price_engine.rs
│   │       │   └── currency.rs
│   │       ├── projection/
│   │       │   ├── mod.rs
│   │       │   ├── session.rs
│   │       │   ├── calendar.rs
│   │       │   ├── overview.rs
│   │       │   └── source_status.rs
│   │       └── compatibility/
│   │           ├── canonical_session.rs
│   │           └── legacy_findings.rs
│   │
│   ├── agent-vitals-adapters/         # 无 I/O 的 harness 适配
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── registry.rs
│   │       ├── shared/
│   │       │   ├── canonical_json.rs
│   │       │   ├── timestamp.rs
│   │       │   └── identity.rs
│   │       └── harnesses/
│   │           ├── claude_code/
│   │           │   ├── mod.rs
│   │           │   ├── skills/
│   │           │   │   ├── manifest.rs
│   │           │   │   └── visibility.rs
│   │           │   ├── sessions/
│   │           │   │   ├── wire.rs
│   │           │   │   ├── evidence.rs
│   │           │   │   ├── usage.rs
│   │           │   │   └── usage_fact.rs
│   │           │   └── capability.rs
│   │           ├── codex/
│   │           │   ├── mod.rs
│   │           │   ├── skills/
│   │           │   │   ├── catalog.rs
│   │           │   │   └── visibility.rs
│   │           │   ├── sessions/
│   │           │   │   ├── wire.rs
│   │           │   │   ├── evidence.rs
│   │           │   │   ├── usage.rs
│   │           │   │   └── usage_fact.rs
│   │           │   └── capability.rs
│   │           ├── dsh/
│   │           │   ├── mod.rs
│   │           │   ├── skills/
│   │           │   │   ├── manifest.rs
│   │           │   │   ├── visibility.rs
│   │           │   │   └── invocation.rs
│   │           │   ├── sessions/
│   │           │   │   ├── wire.rs
│   │           │   │   ├── observer.rs
│   │           │   │   ├── evidence.rs
│   │           │   │   ├── usage.rs
│   │           │   │   └── usage_fact.rs
│   │           │   ├── mcp/           # 后续阶段；未实现时不建空模块
│   │           │   └── capability.rs
│   │           ├── workbuddy/
│   │           │   ├── mod.rs
│   │           │   ├── skills/
│   │           │   ├── sessions/
│   │           │   │   ├── wire.rs
│   │           │   │   ├── evidence.rs
│   │           │   │   └── usage.rs
│   │           │   └── capability.rs
│   │           ├── openclaw/
│   │           └── hermes/
│   │
│   ├── agent-vitals-runtime/          # 本机 I/O、状态和调度
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── sources/
│   │       │   ├── mod.rs
│   │       │   ├── claude_code/
│   │       │   │   ├── skills/
│   │       │   │   │   ├── discovery.rs
│   │       │   │   │   └── config_reader.rs
│   │       │   │   └── sessions/
│   │       │   │       ├── discovery.rs
│   │       │   │       └── jsonl_reader.rs
│   │       │   ├── codex/
│   │       │   │   ├── skills/
│   │       │   │   │   └── app_server.rs
│   │       │   │   └── sessions/
│   │       │   │       ├── discovery.rs
│   │       │   │       └── rollout_reader.rs
│   │       │   ├── dsh/
│   │       │   │   ├── skills/
│   │       │   │   │   ├── discovery.rs
│   │       │   │   │   └── config_reader.rs
│   │       │   │   ├── sessions/
│   │       │   │   │   ├── discovery.rs
│   │       │   │   │   ├── session_reader.rs
│   │       │   │   │   └── zstd.rs
│   │       │   │   └── mcp/           # passive config；active probe 必须显式授权
│   │       │   └── workbuddy/
│   │       │       ├── skills/
│   │       │       └── sessions/
│   │       │           ├── discovery.rs
│   │       │           ├── sqlite.rs
│   │       │           └── history_reader.rs
│   │       ├── user/
│   │       │   ├── home.rs
│   │       │   ├── config.rs
│   │       │   ├── billing.rs
│   │       │   ├── sources.rs
│   │       │   ├── validation.rs
│   │       │   └── migration.rs
│   │       ├── catalog/
│   │       │   ├── loader.rs
│   │       │   ├── cache.rs
│   │       │   └── validation.rs
│   │       ├── state/
│   │       │   ├── mod.rs
│   │       │   ├── store.rs
│   │       │   ├── ledger.rs
│   │       │   ├── migration.rs
│   │       │   └── takeover.rs
│   │       ├── watcher/
│   │       │   ├── filesystem.rs
│   │       │   ├── scheduler.rs
│   │       │   └── debounce.rs
│   │       └── services/
│   │           ├── session_service.rs
│   │           ├── usage_service.rs
│   │           ├── audit_service.rs
│   │           └── report_service.rs
│   │
│   └── agent-vitals-wasm/
│       └── src/lib.rs
│
├── packages/
│   └── agent-vitals-python/           # Python 便携/兼容实现，独立发布边界
│       ├── pyproject.toml
│       └── agent_vitals/
│           ├── cli.py
│           ├── adapters/
│           │   ├── claude_code/
│           │   ├── codex/
│           │   ├── dsh/
│           │   └── workbuddy/
│           ├── contracts/
│           ├── compatibility/
│           └── skills/
│
├── integrations/                      # 执行环境内 UI、插件和便携调用入口
│   ├── dsh-client/
│   ├── openclaw/
│   └── skills/
│
├── assets/
│   ├── catalog/
│   │   ├── models/
│   │   ├── pricing/
│   │   └── subscriptions/
│   ├── templates/
│   └── icons/
│
├── fixtures/                          # 按执行环境保存原始、脱敏、可重放语料
│   ├── claude_code/
│   ├── codex/
│   ├── dsh/
│   └── workbuddy/
│
├── tests/
│   ├── architecture/                  # 依赖方向与注册完整性
│   ├── contracts/                     # UsageFact/SessionKey/schema
│   ├── parity/                        # Python ↔ Rust 字节一致
│   ├── golden/                        # 重构零漂移
│   └── integration/                   # CLI/runtime/Tauri 边界
│
├── docs/
│   ├── architecture/
│   ├── specs/
│   ├── adr/
│   ├── harness-integrations/
│   └── product/
│
└── xtask/                             # fixture、golden、检查和发布编排
    └── src/
```

---

## 3. 依赖规则

### 3.1 允许的方向

```text
apps/cli ───────────────┐
apps/desktop ───────────┼──► agent-vitals-runtime
integrations ───────────┘              │
                            ┌───────────┴────────────┐
                            │ user config + catalog │
                            └───────────┬────────────┘
                                       ▼
                           agent-vitals-adapters
                                       │
                                       ▼
                            agent-vitals-domain
                                       │
                                       ▼
                                 vitals-core

agent-vitals-wasm ─────────► agent-vitals-adapters（仅纯模块）
agent-vitals-wasm ─────────► agent-vitals-domain ─► vitals-core
```

### 3.2 禁止的方向

```text
vitals-core              → 任意 Agent/执行环境/runtime/app
agent-vitals-domain      → adapter/runtime/app
agent-vitals-adapters    → runtime/app
agent-vitals-runtime     → CLI/Tauri UI
Tauri UI                 → 直接读取执行环境文件或 state
```

同层模块之间也不得通过 JSON 绕过正式类型契约。JSON 是跨语言和外部 API；Rust crate
内部优先使用 typed struct，在序列化边界才转 JSON。

### 3.3 依赖预算

- `vitals-core`：只接受通用、可 WASM、无 I/O 依赖；
- `agent-vitals-domain`：可依赖 `vitals-core`、serde、纯算法库；
- `agent-vitals-harnesses`：可依赖 domain / core / 纯解析库；`rusqlite`/`ruzstd`/
  `walkdir` 是 **optional dep**，仅 `sources` feature 开启时链入（§4.3）。**不许**
  `tokio`/`notify`/watcher/编排——那些属 runtime。默认 feature 集为空，wasm 用
  `default-features = false` 只拿纯子树；
- `agent-vitals-runtime`：`agent-vitals-harnesses`（`features = ["sources"]`）+
  `notify`/watcher/service 编排 + state 存储；
- `apps/desktop`：依赖 runtime，Tauri command 不持有领域规则。

用户配置和 Catalog 是输入，不是更高权限的业务层：Runtime 只负责读取、校验和版本选择，
Domain 的 resolver/billing 接收 typed snapshot 后计算，不能在纯函数内部再次读取磁盘。

---

## 4. 一个执行环境一个文件夹（v3.1 修订，2026-09-04）

> **修订**：v3 原方案把同一执行环境拆在 `agent-vitals-adapters/harnesses/<h>/`（纯）与
> `agent-vitals-runtime/sources/<h>/`（I/O）两个 crate。用户 2026-09-04 指出这不利
> 于维护——执行环境接入要动两个 crate、藏得深。v3.1 改为**一个执行环境一个文件夹**，
> `sources/`（I/O）与 `sessions/`/`skills/`（纯）作它的子目录，编译期 I/O 边界靠
> **feature-gate + 源码扫描守卫**保住（§4.3），不靠 crate 边界。

```text
crates/agent-vitals-harnesses/               # 一个 crate，所有执行环境
  Cargo.toml   # ruzstd / rusqlite / walkdir 均 optional，由 "sources" feature 开
  src/
    lib.rs
    registry.rs                          # HarnessDescriptor 汇总
    shared/{canonical_json,timestamp,identity}.rs
    dsh/
      sources/    { discovery, session_reader, zstd, fingerprint }   # I/O，#[cfg(feature="sources")]
      sessions/   { wire, evidence, observer, usage, usage_fact }    # 纯
      skills/     { manifest, visibility, invocation }               # 纯
      mcp/        { config, events, probe }                          # 后续；probe 属 I/O
      capability.rs
    codex/  claude_code/  workbuddy/  openclaw/  hermes/             # 同构
```

数据流不变，只是同一执行环境的两段现在同目录相邻：

```text
harnesses::dsh::sources                       (feature = "sources")
  locate → read → decompress → fingerprint → SourceDocument
                         │
                         ▼
harnesses::dsh::sessions                       (纯，wasm 可链)
  parse wire → observe → dedupe/delta → UsageFact / CanonicalEvidence
                         │
                         ▼
agent-vitals-domain
  cost → findings → session/calendar/overview projection
```

### 4.0 为什么不合成一个无条件带 I/O 的 crate —— wasm

`agent-vitals-wasm` 必须链接 `harnesses::<h>::sessions` 的纯代码（behavior/trajectory
的 DSH raw shim、evidence、usage fold），但 `ruzstd`/`rusqlite`/`walkdir` 编不到
`wasm32`。所以 `sources/` 整体 `#[cfg(feature = "sources")]`，I/O 依赖 `optional`：

- **wasm**：`agent-vitals-harnesses = { default-features = false }` → `sources/` 不存在，纯子树编译
- **binary / runtime**：`features = ["sources"]` → 全量
- feature 关时，误把需要 gated dep 的 I/O 写进 `sessions/` → **纯构建编译失败**
- 不需要 dep 的 `std::fs`/`std::env`/`std::process` → §4.3 源码扫描守卫兜

### 4.1 同一执行环境内部：sources / sessions / skills / mcp

目录第一维按执行环境组织（新增 harness 只碰一个文件夹）；第二维分 I/O 与证据面：

```text
harnesses/dsh/
├── sources/      locate/read/decompress/fingerprint —— I/O，feature-gated
├── skills/       SKILL.md、启用/加载/遮蔽、调用关联 —— 纯
├── sessions/     行为事件、轨迹、usage、cost 事实 —— 纯
├── mcp/          MCP 配置与运行证据（后续）；probe 属 I/O
└── capability.rs 三个 surface 分别声明能力上限
```

Skill 与 Session 的关联发生在 Domain/service，不发生在 reader：Session 中观测到
`skill-invocation` 后，用稳定的 harness/source_profile/observer/skill identity 与
`SkillVitalRecord` 对账。扫描不到某个 surface 时必须标 unavailable，不能用空数组伪装
“实测为零”。

### 4.2 sources / sessions 的分工示例

以 DSH 为例：

| 代码 | 归属 | 原因 |
|---|---|---|
| 查找 `session.jsonl.zstd` | `harnesses/dsh/sources/` | 文件系统策略（feature-gated） |
| 多帧 zstd 解压 | `harnesses/dsh/sources/zstd.rs` | I/O / 原生依赖（`ruzstd`，feature-gated） |
| 识别 `assistant/chunk` usage | `harnesses/dsh/sessions/wire.rs` | DSH wire 语义（纯） |
| 相邻 run shadow 替换 | `harnesses/dsh/sessions/observer.rs` | DSH 计量语义（纯） |
| 生成 DSH `UsageFact` | `harnesses/dsh/sessions/usage_fact.rs` | 执行环境 → 领域契约边界（纯） |
| 汇总跨执行环境月度 token | `agent-vitals-domain` | 与 DSH 无关 |
| Tauri 自动刷新 | `apps/desktop` / `agent-vitals-runtime` | 生命周期与 UI 编排 |

`agent-vitals-runtime` 仍存在，但只装**非执行环境**机器：state store / ledger、watcher、
唯一 `HomeResolver`、catalog loader、User Profile，以及把 `harnesses::<h>::sources` 产出的
`SourceDocument` 交给 `harnesses::<h>::sessions` 的 service 层。它依赖
`agent-vitals-harnesses`（`features = ["sources"]`）。

### 4.3 编译期 I/O 边界怎么保住（不靠 crate 边界）

1. **feature-gate**：`sources/` 与 `mcp/probe.rs` 整体 `#[cfg(feature = "sources")]`，
   `ruzstd`/`rusqlite`/`walkdir` 是 `optional` dep。纯构建（wasm、
   `default-features = false`）里它们不编译——需要 gated dep 的 I/O 误入 `sessions/`
   即编译失败。
2. **源码扫描守卫**（`agent-vitals-harnesses/tests/harness_boundary.rs`，仿
   `dependency_budget.rs`）：`src/**/*.rs` 里 `std::fs` / `std::process` /
   `std::env::` / `File::open` / `Connection::open` / `ruzstd` / `rusqlite` 只许出现在
   路径含 `/sources/` 或 `mcp/probe.rs` 的文件；`sessions/`、`skills/`、`shared/`、
   `registry.rs`、`capability.rs` 命中即红。
3. **反向依赖**：`agent-vitals-harnesses` 的 `[dependencies]` 否定清单——不许
   `agent-vitals`（binary）、`tauri`、`notify`、`tokio` 等（`sources` feature 只加
   读取器需要的最小 I/O 集，不加编排/watcher）。

---

## 5. Harness 目录内部契约

每个执行环境一个文件夹，按能力选择下列子目录/文件；不支持的能力不创建空文件：

```text
harnesses/<harness>/
├── mod.rs                 对外出口与 descriptor
├── sources/               ── I/O，#[cfg(feature = "sources")] ──
│   ├── discovery.rs       会话根目录、SKILL.md/plugin config、候选文件
│   ├── session_reader.rs  JSONL / rollout / SQLite 读取
│   ├── zstd.rs            仅需要时（DSH）
│   ├── fingerprint.rs     revision / checkpoint 输入
│   └── error.rs           I/O 错误映射
├── skills/                ── 纯 ──
│   ├── manifest.rs        执行环境 Skill 元数据
│   ├── visibility.rs      enabled/loaded/discoverable
│   ├── shadowing.rs       scope 与同名覆盖
│   └── invocation.rs      与 Session 调用证据的关联
├── sessions/              ── 纯 ──
│   ├── wire.rs            执行环境会话字段与版本嗅探
│   ├── evidence.rs        raw → CanonicalEvidence/CanonicalEvent
│   ├── observer.rs        请求槽、shadow、累计快照
│   ├── usage.rs           执行环境 token 语义
│   └── usage_fact.rs      observation → UsageFact
├── mcp/                   后续独立 surface（probe.rs 属 I/O，feature-gated）
└── capability.rs          三个 surface 分别声明能力上限
```

统一要求：

1. `sessions/`/`skills/` 输入是内存数据或 `Read` 抽象，不自行定位用户目录；
   路径定位/解压/读取只在 `sources/`（feature-gated）；
2. `sessions/`/`skills/` 不读环境变量、不读全局配置、不写 state、不负责 watcher；
3. raw 字段保持原样，normalized 字段带版本；
4. 缺失与真实零分开；
5. cumulative 在 `sessions/` 边界转 delta；
6. shadow、重复与不可归属必须可解释；
7. 输出由 domain contract 校验；
8. 同一输入产生确定性、可逐字节比较的输出；
9. capability 声明必须进入 harness registry 完整性测试；
10. Skill scanner 不读 token/cost，Session scanner 不扫描 `SKILL.md`；
11. MCP 默认只消费配置和已有证据，主动 handshake/probe 由 Runtime 显式授权；
12. `sources/` 产出统一 `SourceDocument`（§6），不直接产报告。

**Trait 标准化（4 执行环境起，v3.1 收窄）**：不做一个包办的 `HarnessAdapter` 大 trait
——执行环境差异在「**哪些 surface 存在**」（Claude Code 无 runtime probe、WorkBuddy
roots 来自清单文件），大 trait 逼出空实现。做**按 surface 的小 trait**，执行环境只
impl 它有的那几个：

```text
trait SessionSource   { fn discover(..) -> Vec<SourceDocument>; fn read(doc) -> RawSession; }   // sources/
trait SessionAdapter  { fn evidence(raw) -> CanonicalEvidence; fn usage(raw) -> UsageObservations; } // sessions/
trait SkillSource     { fn inventory(..) -> Vec<RawSkillEntry>; }                                // skills/ + sources
trait SkillAdapter    { fn record(raw) -> SkillVitalRecord; }
```

`registry.rs` 的 `HarnessDescriptor` 汇总每个执行环境 impl 了哪些、每个 surface 的能力
上限——`inventory.rs` 现有「四阶段，缺哪个阶段就是缺哪个能力」的哲学升级成类型。

---

## 6. `sources/` 输出契约

`harnesses/<h>/sources/` 统一产出，不直接是最终报告：

```text
SourceDocument {
    harness,
    source_profile,
    path/reference,
    revision,
    bytes/records,
    read_status,
}
```

然后由 `services/session_service` 把 SourceDocument 交给对应 Harness Adapter。这样 CLI、Tauri
和批处理共用同一个调用链，不会各写一套“读完以后顺手解析”的实现。

Skill Source 可以使用同一 envelope，但 `kind="skill-manifest|skill-runtime-catalog"`；
Session Source 使用 `kind="session-log|rollout|session-db"`。`kind` 是调度标签，不能靠
文件扩展名猜数据面。

---

## 7. Harness Registry

registry 负责把执行环境名称、能力和 adapter/source 入口关联起来，但不成为万能 dispatcher。

建议 descriptor 至少包含：

```text
HarnessDescriptor {
    id,
    display_name,
    adapter_version,
    skill_surface: { inventory, visibility, invocation_evidence },
    session_surface: { discovery, behavior, usage, live_watch },
    mcp_surface: { config, passive_runtime_evidence, active_probe },
    supported_sources,
    supported_signals,
    supported_outputs,
}
```

注册完整性守卫必须验证：

- CLI `--harness` 词表与 registry 一致；
- adapter 目录与 registry 一致；
- runtime source 若存在，registry 必须声明；
- capability matrix 中每个执行环境都有来源；
- Skill/Session/MCP 三个 surface 分别声明，不允许一个总 `available=true` 代替；
- 无 source 的纯导入 adapter 必须显式标记 `external-input-only`；
- UI 不维护第二份执行环境列表。

---

## 8. 新执行环境接入模板

以新增 `new-harness` 为例——**只碰一个文件夹**：

```text
crates/agent-vitals-harnesses/src/new_harness/
├── mod.rs                   # 对外出口 + descriptor
├── sources/                 # 有 I/O 时创建（feature = "sources"）
│   ├── discovery.rs
│   ├── session_reader.rs
│   └── error.rs
├── skills/                  # 有 Skill Surface 时创建（纯）
│   ├── manifest.rs
│   └── visibility.rs
├── sessions/                # 有 Session Surface 时创建（纯）
│   ├── wire.rs
│   ├── evidence.rs
│   ├── usage.rs
│   └── usage_fact.rs
├── mcp/                     # 后续（probe.rs 属 I/O）
└── capability.rs

fixtures/new_harness/{README.md, minimal.jsonl, malformed.jsonl, build_fixture.*}
docs/harness-integrations/new-harness.md
```

接入顺序：

1. 用真实脱敏语料记录 wire contract；
2. 分别决定 Skill/Session/MCP surface 的能力，不把未知项填零；
3. 只为真实存在的 surface 建子目录：`sources/` impl `SessionSource`/`SkillSource`，
   `sessions/` impl `SessionAdapter`，`skills/` impl `SkillAdapter`（§5 小 trait）；
4. 实现纯 wire parser；Session 可用时生成 CanonicalEvidence；有 usage 再做
   observation 与 UsageFact；
5. `registry.rs` 注册 `HarnessDescriptor`（声明 impl 了哪几个 surface）；
6. 加 Rust 单测、golden、跨语言 parity（仍有 Python 镜像时）；
   `harness_boundary.rs` 守卫自动覆盖新目录（I/O 只许在 `sources/`）；
7. 最后接 CLI/Tauri 展示。

新增执行环境不应要求修改 `vitals-core`。如果为了接入一个 harness 必须在 `vitals-core` 中
新增执行环境字段，说明边界放错，应退回 adapter/domain 重新设计。

---

## 9. Python 的位置

Python 不再与 Rust 项目源码混放成看似同一实现层，而作为独立 package：

```text
packages/agent-vitals-python/
```

短期职责：

- ClawHub/OpenClaw 等无二进制安装场景；
- 现有 Skill 调用入口；
- Rust 迁移期间的独立 parity oracle；
- 必要的便携、只读诊断。

长期原则：

- Tauri/runtime 不调用 Python 子进程完成核心工作；
- 新的 watcher、SQLite writer、state owner 只实现 Rust；
- Python 不无条件复制每个新产品能力；
- 每个平行模块必须标明 `authoritative / mirror / compatibility / retiring` 状态；
- 达到退役能力门后，可将 Python 缩成 CLI 客户端或移出主仓库。

---

## 10. Model、Billing 与用户配置

### 10.1 四类数据必须分开

| 类别 | 例子 | 权威来源 | 可否由程序推断 |
|---|---|---|---|
| Model Registry | 模型别名、provider、系列、上下文窗 | 随产品发布的版本化资产与执行环境原始字段 | 可解析身份，无法匹配时保留 raw |
| Rate Card Catalog | 按 provider/model/时间生效的 input/cache/output 单价 | 版本化资产或有来源记录的远端 catalog | 不能从 token 或模型名猜价格 |
| User Profile | 用户买了 Claude Pro、月费 ¥140、生效日期 | 用户声明或受信任的账户同步 | 缺失时只能标 unknown |
| Observed Usage | 某次请求的 input/cache/output token | Session Surface 原始证据 | 由 adapter 规范化 |

Registry/Rate Card 不能写死“用户订阅了什么”；User Profile 不能复制整张模型价格表；
Session Adapter 不能因为看到某个执行环境就默认它被套餐覆盖。这四个输入在 Billing Domain
中才合流。

### 10.2 `~/.agent-vitals/` 的推荐布局

```text
~/.agent-vitals/
├── config.toml                 # UI、预算、币种、隐私与刷新偏好
├── billing.toml                # 用户账户、套餐、有效期、实际月费、计费路由
├── sources.toml                # 执行环境 source profile 与显式路径覆盖
├── state/                      # 程序生成，可重建的 ledger/index/projection
│   ├── ledger/
│   ├── sessions/
│   └── projections/
├── cache/                      # 可删除、可重建
│   ├── catalogs/
│   └── checkpoints/
├── reports/                    # 导出的 HTML/JSON，不作为真相源回读
├── logs/
└── version.json               # home schema 与迁移状态
```

边界规则：

- `config.toml`、`billing.toml`、`sources.toml` 是用户输入；不能被扫描任务静默覆盖；
- `state/`、`cache/`、`reports/` 是程序产物；删除后不应改变用户的套餐声明；
- API Key、OAuth token、Cookie、银行卡信息不写入这些文件，敏感引用使用系统 Keychain、
  环境变量或执行环境自己的凭证存储；
- 配置文件建议仅当前用户可读写；导出报告默认脱敏路径、账户名和原始 prompt；
- 当前兼容顺序
  `AGENT_VITALS_HOME → SKILL_VITALS_HOME → ~/.agent-vitals → ~/.skill-vitals`
  保留到显式迁移完成，不能仅因改名让历史 state 消失。

目前 Python、根 Rust CLI、Tauri 各自实现了 data-home 选择。语义虽有测试对齐，目标仍应是
Runtime 中唯一的 `HomeResolver`；迁移期保留三端契约测试，调用方切换后再删除复制代码。

### 10.3 `billing.toml` 的语义示例

```toml
schema_version = 1
reporting_currency = "CNY"

[[accounts]]
id = "anthropic-personal"
provider = "anthropic"
mode = "subscription"

[[accounts.subscriptions]]
plan_id = "claude-pro"
monthly_price = 140.00
currency = "CNY"
valid_from = "2026-08-01"
# valid_to 缺失表示当前仍有效；并不表示所有 Anthropic API 用量都被覆盖

[[accounts]]
id = "openai-api"
provider = "openai"
mode = "metered"

[[routes]]
harness = "claude-code"
source_profile = "personal"
account = "anthropic-personal"

[[routes]]
harness = "codex"
source_profile = "api-project-a"
account = "openai-api"
```

`route` 应以 `harness + source_profile` 为最低可靠粒度；需要时再增加 provider、workspace 或
组织维度。只按模型名匹配会把同名模型的订阅渠道和 API 渠道混为一笔。

### 10.4 成本输出不能只有一个 `cost`

建议月度总览至少分开：

```text
perceived_monthly_cost
├── subscription_fixed_cost       用户声明的固定套餐支出
├── metered_billed_cost            有账单/明确计费路由的按量金额
├── metered_estimated_cost         只有 token × catalog 的估算金额
├── covered_usage_equivalent       套餐覆盖用量的反事实等价金额（诊断项）
└── unresolved_usage               无法归属账户/价格的 token 与原因
```

首页可展示“本月总感知成本”，但必须允许拆开订阅与按量；缓存率、reasoning 占比、浪费归因
属于诊断指标，不应冒充账单。价格未知、路由冲突或套餐覆盖未知时，结果必须是 `unknown` /
`unresolved`，不能回落成零。

Catalog 中每张 rate card 应携带 `catalog_version`、币种、`effective_from/to`、输入/缓存输入/
输出价格和来源。历史会话按事件时间选择价格版本；更新 catalog 不应改写已封账事实，只能
生成带新 projection version 的重算结果。

---

## 11. 现有文件迁移映射

> 「当前文件/目录」列写的是 **v0.8 之前**的扁平布局。Phase B/C 已落地的行标 ✅
> 并给出实际落点；未标的仍待 Phase D/E。

| 当前文件/目录 | 目标位置 |
|---|---|
| `crates/vitals-core` | 原位保留 |
| `agent-vitals-core/usage_fact.rs` | ✅ `agent-vitals-domain/src/contracts/usage_fact.rs` |
| `agent-vitals-core/r2a.rs` 的纯契约 | ✅ `agent-vitals-domain/src/contracts/r2a.rs`（`SessionKey` 等） |
| `agent-vitals-core/r2a.rs` 的存储投影 | `agent-vitals-runtime/state/`（Phase D） |
| `agent-vitals-core/claude_code_evidence.rs` | ✅ `agent-vitals-adapters/src/harnesses/claude_code/sessions/evidence.rs` |
| `agent-vitals-core/codex_evidence.rs` | ✅ `agent-vitals-adapters/src/harnesses/codex/sessions/evidence.rs` |
| `agent-vitals-core/codex_usage.rs` | ✅ `agent-vitals-adapters/src/harnesses/codex/sessions/usage.rs` |
| `agent-vitals-core/dsh_evidence.rs` | ⏳ `agent-vitals-domain/src/domain/dsh/evidence.rs`（登记债，Phase D 迁 `harnesses/dsh/sessions/`） |
| `agent-vitals-core/workbuddy_evidence.rs` | ✅ `agent-vitals-adapters/src/harnesses/workbuddy/sessions/evidence.rs` |
| `agent-vitals-core/usage.rs` | ✅ `agent-vitals-domain/src/domain/usage.rs`（通用计算）；DSH wire 部分 = `domain/dsh/`（Phase D 迁 adapters） |
| `agent-vitals-core/cost.rs` | `agent-vitals-domain/src/domain/cost.rs`（as-is 已进）；拆 `models/` + `billing/` 并入 Phase D |
| `src/skills/discovery.rs`、`src/skills/inventory.rs` | runtime Skill Source + Skill service；移除对 Session reader 的直接编排 |
| `src/skills/snapshot.rs`、`scripts/agent_vitals/paths.py`、Tauri `overview.rs` 的 home 解析 | `agent-vitals-runtime/user/home.rs`，迁移期保留跨实现契约测试 |
| `src/agent/*session*.rs` | `agent-vitals-runtime/sources/<harness>/reader.rs` |
| `src/agent/discovery.rs` | `agent-vitals-runtime/sources/` + registry |
| `src/agent/r2a_store.rs` | `agent-vitals-runtime/state/` |
| `src/agent/takeover.rs` | `agent-vitals-runtime/state/takeover.rs` |
| `src-tauri` | `apps/desktop/src-tauri` |
| `src-tauri/ui` | `apps/desktop/ui` |
| `scripts/agent_vitals` | `packages/agent-vitals-python/agent_vitals` |
| `dsh-client` | `integrations/dsh-client` |
| `scripts/agent_vitals/pricing.json` | `assets/catalog/pricing/`；由 catalog loader 校验并版本选择 |
| `pricing.json` 里的套餐定义 | `assets/catalog/subscriptions/`；用户购买事实进入 `~/.agent-vitals/billing.toml` |
| 模板、图标 | `assets/` 对应子目录 |

Stage 3 DSH observer 的当前落点在 `agent-vitals-domain::usage`（`agent-vitals-core`
已删除），先守住 byte-neutral 与 Python/Rust parity。目标架构下它属于
`agent-vitals-adapters::harnesses::dsh::observer`。这次功能实现与目录迁移应分开提交，不能用
架构整理扩大 Stage 3 的变更面。

---

## 12. 现有代码架构评估

### 12.1 总评

当前代码不是“推倒重来”的状态。通用 Core、执行环境事实、CLI/Tauri、Python parity 已经形成
可工作的垂直闭环；尤其 `vitals-core` 的无 I/O 和无执行环境词汇边界是真实存在的，不只是
文档约定。问题主要在 `vitals-core` 之上的物理边界尚未跟上功能增长。

以“能否低风险接入第五、第六个执行环境，并让 CLI/Tauri 共用同一热更新数据面”为标准，当前
架构成熟度约 **65%–70%**：基础契约和验证能力较强，模块归属、运行时服务与用户计费模型
仍不完整。这个百分比是架构判断，不是测试覆盖率。

### 12.2 已经做对的部分

1. `crates/vitals-core` 已明确禁止 I/O 和执行环境概念，并有依赖边界测试；这是可以继续保留的
   Framework Core。
2. `agent-vitals-core` 明确定位纯计算，Tauri 复用其成本函数，没有产生第四套计价公式。
3. UsageFact、golden、Python/Rust byte-parity 和 CLI matrix 为后续搬目录提供了很强的
   零漂移护栏。
4. `harness_runtime_registration.rs` 已开始校验执行环境运行时注册与 Core harness 列表，为目标 Harness
   Registry 提供了可演进基础。
5. 新旧 data home 优先级已经在 Python、Rust CLI、Tauri 三端明确并测试，品牌迁移不会
   直接丢失老用户状态。
6. Tauri 已能消费现有 Core 与 CLI 会话 DTO，证明桌面入口不需要 Node.js app server 才能
   建立闭环。

### 12.3 主要差距与优先级

| 优先级 | 现状 | 风险 | 目标动作 |
|---|---|---|---|
| P1 | `agent-vitals-core/src` 平铺 Claude/Codex/DSH/WorkBuddy 模块 | 新执行环境继续扩大“core”含义，所有权不清 | 先在现 crate 内建 `contracts/domain/adapters/harnesses`，再拆 crate |
| P1 | 缺独立 Runtime；根 CLI 管 reader/state，Tauri 又直接读 state 并 spawn CLI | 热更新、锁、checkpoint 和错误语义可能出现两套 owner | 抽 runtime services；CLI/Tauri 都成为客户端 |
| P1 | `src/skills/inventory.rs` 同时编排 Skill inventory、DSH session evidence、Codex runtime probe | Skill 与 Session 数据面耦合，失败/空值含义不清 | 拆 Skill Source/Service 与 Session Source/Service，只在 Domain 投影关联 |
| P1 | `cost.rs` 同时承担模型匹配、价格表、订阅排除和成本投影 | 无法诚实表达用户买了什么、历史价格和混合计费 | 建 Model Catalog、BillingContext、User Profile 三个明确边界 |
| P1 | data-home 解析存在 Python、CLI Rust、Tauri 三份 | 规则演进时可能漂移 | Runtime 建唯一 `HomeResolver`；迁移期用契约测试锁步 |
| P2 | `usage.rs`、`r2a_store.rs`、根 `main.rs`、Tauri `lib.rs/overview.rs` 均接近或超过 2K 行 | 修改影响面大，职责难以独立测试 | 按领域/服务/command 渐进切片，不做机械按行数拆分 |
| P2 | Python adapter 反向导入 `agent.usage`，部分模块靠延迟 import 避免环 | 镜像实现的层级含义不稳定 | Python 包采用相同 contracts/domain/adapters 分层，共享 helper 下沉 |
| P2 | `r2a_store.rs` 聚合 discovery、store、projection 与执行环境差异 | Session data plane 难以复用和增量化 | 分成 source index、ledger/store、projection service |

这些是结构性债务，暂未发现需要中止 Stage 3 的架构级 P0。Stage 3 应继续按已批准的
byte-neutral observer 范围完成；不要在同一个提交中顺手移动目录。真正的 P0 仍是事实
身份、去重、累计转 delta、封账/增量语义等正确性，一旦相关门禁失败才应阻断功能开发。

### 12.4 对 Tauri 的判断

Tauri 自身就是常驻桌面进程，不需要额外启动 Node.js 服务来监听 Session 日志。目标是把
watcher、reader、ledger 和 projection 放进 Rust Runtime，由 Tauri command 调 service，
并用 event 推送 UI。当前 `store.rs` 通过子进程取得 sessions DTO 是合理的过渡兼容层，
但不应成为最终内部架构；`overview.rs` 直接解析 home/config/state 也应逐步迁往 Runtime。

这意味着报告既可以封装在客户端内，也可以导出浏览器可打开的静态 HTML：两者消费同一
projection DTO，而不是维护两套审计和计费逻辑。

---

## 13. 分阶段迁移

### Phase A：先建立逻辑边界，不改 crate 名

- [x] 在现有 `agent-vitals-core/src` 内建立 `contracts/`、`domain/`、`adapters/harnesses/`；
- [x] 在现有 runtime 代码内先区分 `skills/` 与 `sessions/` 调用链；
- [x] 用 re-export 保持旧 public path；
- [x] 新执行环境代码不再落到根目录；
- [x] 增加禁止 adapter 依赖 I/O crate 的架构测试。

Phase A 的 runtime 边界采用依赖注入而不是新建一套 fold：
`agent/session_sources.rs` 读取 DSH Session 证据，根编排层把已读取的
`SessionEvidenceInput` 传给 `skills/inventory.rs`。Skill inventory 仍可做
Installed/Loaded/Triggered 关联，但不能自行扫描 Session 文件。Codex/OpenClaw 的
runtime probe 仍属于 Skill capability 求证，不被误分类为 Session 日志读取。

### Phase B：抽出执行环境 crate

> **v3.1**：B 的产物 crate 从 `agent-vitals-adapters`（纯）演进为
> `agent-vitals-harnesses`（单 crate，feature-gated `sources/`，§4）。B1 已落地的
> `harnesses/<h>/sessions/` 结构**原样保留**——只是后续 B2/C/D 往里加 `sources/` +
> `sources` feature + `harness_boundary.rs` 守卫，并可择时把 crate 名改为
> `agent-vitals-harnesses`（或保留 `-adapters` 名，非阻塞）。

**B1（已完成，2026-09-04）：**

- [x] 建立独立纯计算 crate、四执行环境命名空间、统一 flat compatibility facade；
- [x] 迁移 Claude evidence、Codex evidence、WorkBuddy evidence 三个叶子 adapter；
- [x] CLI 改为统一从 `agent-vitals-adapters` 调用；
- [x] 增加 adapter 依赖预算、无 I/O、无反向依赖和 facade 等价守卫；
- [x] 全量门禁零漂移：`cargo test/clippy`、Python `unittest` 1143、golden 15+15
      逐字节、`cargo check -p agent-vitals-wasm` 全绿。

WASM **暂不登记** `agent-vitals-adapters` 依赖——`agent-vitals-wasm/src/lib.rs`
当前只调 `domain` 侧函数（behavior/trajectory/usage/…），没有一个符号来自新
adapter crate。§3.1 的 `wasm ─► adapters` 边是**未来边**：等某个 Phase 让 wasm
经 adapter facade 取证据时，届时那个 Phase 带真实调用点一起加，不提前挂空依赖。

**B2（随 Phase C Step 3 收口，2026-09-04 — ✅ 完成）：**

- [x] 物理迁移 Codex usage（`codex_usage` + `canonical_usage` → `agent-vitals-adapters`）；
- [x] DSH wire（`evidence`/`audit`/`compaction`/`waste`）**未进 adapters**——落
      `agent-vitals-domain/src/domain/dsh/`，作登记的 layer-2 债（`build_dsh_evidence`
      fixture 跨 crate 传 `CanonicalSession` 会撞 `multiple versions of crate`，见下 Phase C）；
- [x] `agent-vitals-core/src/adapters/` 删除；全量门禁与 Python/Rust parity 零漂移
      （`AGENT_VITALS_V0_8_PHASE_C_RESEARCH.md` §6quater）。

原提案未展开的 Cargo 环（`domain::usage` 调 Codex fold、`domain::{behavior,trajectory,
compaction,waste}` 调 DSH evidence，若 domain 反依赖 adapter 就成环）已由 Phase C
Step 1–3 拆解：纯计算耦合（`Coords`、canonical 归一层、`match_behavior/trajectory` shim）
迁走后，`domain/` **生产**代码对 harness 适配的引用归零；`domain/dsh/` 的 4 个 wire
模块是仅剩的一处，且只被 `#[cfg(test)]` fixture 依赖（见 Phase C）。

### Phase C：抽出 `agent-vitals-domain`（✅ 完成，2026-09-04）

> **代码调研先行**（用户 2026-09-04 要求）：`docs/AGENT_VITALS_V0_8_PHASE_C_RESEARCH.md`。
> 调研结论修正了本节的范围估计——真实的 `domain → harness` 生产耦合是 **6 个点 / ~370 行**
> （3 组：`Coords`+`tool_invocation`；`match_behavior`/`match_trajectory` raw shim；
> canonical 归一层），**不是**「拆 `usage.rs` 188KB」。

- **C1–C3（阻塞项，见调研 §2–4）** — ✅ Step 1a/1b/2a/2b（commit `4b44b8c`..`6ce4d13`）：
  `Coords`+`tool_invocation` → `domain/coords.rs`（过渡）；`match_behavior/trajectory` raw
  shim → DSH adapter；canonical 归一层 → `agent-vitals-adapters`。`domain/` 生产代码
  对 `crate::{dsh_evidence,codex_usage,adapters}` 引用归零。
- **B2** — ✅ Step 3（commit `ecdda70`）：`codex_usage` + `canonical_usage` 迁进
  `agent-vitals-adapters`。DSH wire（`evidence`/`audit`/`compaction`/`waste`）**留在
  `domain/dsh/`**——`domain/{behavior,trajectory}.rs` 的 inline `#[cfg(test)]` 用
  `build_dsh_evidence` 造 `CanonicalSession` fixture，`domain → adapters` 的
  `[dev-dependencies]` 成环会让 Cargo 把 domain 编两遍（`multiple versions of crate`）。
- **抽 crate** — ✅ Step 4（commit `f4180ca` + 收尾）：`contracts/` + `domain/` +
  `compatibility/` 整体成 **`agent-vitals-domain`** crate。Step 4 中途一度多出
  `agent-vitals-contracts`（独立词表 crate）与 `agent-vitals-core`（薄 re-export
  facade）两层，Step 4 收尾把它们撤销——`contracts/` 作 domain 的子模块（对齐 §9），
  调用方直接 `use agent_vitals_domain::*`（binary/wasm/adapters/src-tauri 全改）。
  终态 = §3.1 的图：`adapters → domain → vitals-core`。详见调研文档 §6quinquies。
- **Phase C 遗留的一处债（转 Phase D 首项）**：`domain/dsh/` 里 4 个模块仍**直接
  解析 DSH 原始事件形状**，与「domain 不解释执行环境 wire」的目标不一致。它只以
  `#[cfg(test)] build_dsh_evidence` fixture 形式被依赖，由
  `agent-vitals-domain/tests/dependency_budget.rs` 钉为**唯一**登记债、不许扩张。
  wire/fold 分离（把这 4 个模块迁进 `harnesses/<h>/sessions/`）是 **Phase D 的第一项**
  ——那时 `harnesses/<h>/sources/` 落地，`sessions/` 收 wire 解析顺理成章。
- **不在 Phase C**：`cost.rs` 99KB 拆 Model Resolver / Rate Card / BillingContext /
  Cost Projection —— 零 harness import，是 domain **内部**重构，并入 Phase D（与 Model
  Catalog / BillingContext / User Profile 同批）。

### Phase D：建立 `agent-vitals-runtime` + harness `sources/`

- **D1 · wire/fold 分离（Phase C 遗留债）—— ✅ 完成（2026-09-04）**：
  `agent-vitals-domain/src/domain/dsh/` 的 4 个模块（`evidence`/`audit`/`compaction`/
  `waste`）迁进 `agent-vitals-adapters/src/harnesses/dsh/sessions/`；`domain/` 对执行环境 wire
  形状彻底不知情。`build_dsh_evidence` fixture 测试迁去
  `agent-vitals-domain/tests/behavior_rules.rs`（integration test）。`Coords` 留
  `domain/coords.rs`（抽象字段名，harness-agnostic）。wasm 加 `agent-vitals-adapters` dep +
  重建。记录见 `AGENT_VITALS_V0_8_PHASE_D_RESEARCH.md` §D1。此时尚无 `sources/`——
  D1 不需要它，只是纯模块迁移；D3 之后 `harnesses/dsh/sessions/` 与 `sources/` 同目录相邻。
- **harness I/O 落 `harnesses/<h>/sources/`**（v3.1）：`src/dsh.rs`（zstd）、
  `src/agent/workbuddy_session.rs`（sqlite）、`src/agent/*session*.rs`（readers）、
  `src/agent/discovery.rs` 迁进对应执行环境的 `sources/`，`agent-vitals-harnesses` 加
  `sources` feature + `optional` I/O dep + `harness_boundary.rs` 守卫；
- `agent-vitals-runtime` = **非执行环境**机器：state/ledger、watcher、唯一 HomeResolver、
  User Profile/Catalog loader、Skill/Session services（编排 `harnesses::<h>::sources` →
  `harnesses::<h>::sessions`）；
- 承接 v0.7 延期的数据平面：`UsageFact` writer、per-harness materialized view、
  R2a `SourceFingerprint` 增量失效、WorkBuddy `UsageFact` 接入；
- 在出现第二个持久 schema 时实现首个真实 migration，并同时交付原子写入、fsync
  与故障注入；没有 v2 之前不创建凑数迁移；
- CLI 与 Tauri 共用 runtime services；
- 禁止 Tauri command 直接读任意执行环境 state 文件。

### Phase E：整理产品与 Python 包

- 根 CLI 移入 `apps/cli`，二进制名仍是 `agent-vitals`；
- `src-tauri` 移入 `apps/desktop`；
- Python 移入独立 package；
- `dsh-client` 移入 integrations。

### Phase F：再启用 MCP Surface

- 先接被动配置与现有 session 中的 MCP tool-call/result 证据；
- 主动 health probe 必须有用户授权、超时、速率限制和敏感信息边界；
- MCP 健康进入独立 coverage，不用 Skill 或 Session 的空数组代替 unavailable。

每个 Phase 都是独立重构，不与新功能、schema 升级或计费算法变更混在一个 commit。

---

## 14. 架构守卫

需要新增自动检查，避免目录只停留在文档层：

1. `vitals-core` 文件和公开符号禁止执行环境词汇；
2. domain 的 Cargo 依赖禁止 runtime/Tauri/SQLite/zstd/watcher；
3. `agent-vitals-harnesses`：`std::fs`/`std::process`/`std::env`/`File::open`/
   `Connection::open`/`ruzstd`/`rusqlite` 只许出现在路径含 `/sources/` 或
   `mcp/probe.rs` 的文件（`harness_boundary.rs` 源码扫描）；`sources/` 整体
   `#[cfg(feature = "sources")]`，I/O dep 为 `optional`；
4. runtime 依赖 `agent-vitals-harnesses`（`features=["sources"]`），反向（harnesses→runtime）
   编译失败；
5. Tauri/CLI 中禁止重新实现 token/cost/fact_id 公式；
6. registry、CLI harness 枚举、`harnesses/<h>/` 目录、capability matrix 双向相等；
7. 每个执行环境至少有真实脱敏 fixture 与 malformed/unknown coverage；
8. Python 镜像存在期间，公开 JSON 保持 Python/Rust byte-parity；
9. WASM（`agent-vitals-harnesses` 用 `default-features = false`）只链纯子树——
   `sources/` 不参与编译，且 wasm crate 图里无 `ruzstd`/`rusqlite`；
10. 旧 public path 的 re-export 必须有明确删除里程碑；
11. Skill/Session/MCP 的 capability 和 coverage 分开，scanner 不跨 surface 读取；
12. Catalog 必须携带版本、币种与有效期，历史价格选择有回归测试；
13. Billing 路由缺失/冲突必须产生 unresolved，禁止默认为免费；
14. 用户配置与可重建 state 分目录，配置与导出中不得保存凭证；
15. data-home 解析最终只有 Runtime 一个生产实现。

---

## 15. Definition of Done

目录重构完成必须同时满足：

- 新增执行环境只修改 adapter、runtime source、registry、fixture 和接入文档；
- `vitals-core` 不出现任何执行环境或 Agent 专属词；
- domain 不读取文件、环境变量、数据库或系统时间；
- adapter 不发现路径、不写 state；
- runtime 不解释 token wire shape、不实现 detector；
- Skill、Session、MCP 三个 surface 的 scanner、capability 与 coverage 可独立失败；
- 模型身份、价格目录、用户套餐和观测用量是四个可单独版本化/验证的输入；
- 月度成本能分开固定订阅、已计费按量、估算按量、覆盖等价额与 unresolved；
- `~/.agent-vitals/` 中用户配置不会被重建 state 的流程覆盖，也不保存敏感凭证；
- CLI 与 Tauri 不复制领域算法；
- WASM 可只编译纯计算链；
- Python 的保留范围和退出条件可见；
- 全量 Rust 测试、clippy、golden、CLI matrix 和 parity 全绿；
- 目录移动前后所有公开 JSON 和报告语义零漂移。

这份目录设计的目标不是让文件树“看起来整齐”，而是让依赖方向成为可执行的产品边界：
执行环境越多，新增成本应收敛在一对 `adapter + source` 中，而不是继续扩散到 Core、CLI、Tauri
和每一张报告页面。
