# AGENT_VITALS_V0_8_ARCHITECTURE_SPEC 可行性审阅

> 状态：审阅意见 v1（2026-09-03）
> 审阅对象：`docs/AGENT_VITALS_V0_8_ARCHITECTURE_SPEC.md`（目标架构提案 v2）
> 审阅基准：`main` … `2b1936f`（v0.7 Stage 1–3 收尾后）的工作树
> 关联：`TAURI_RUNTIME_WORKBENCH_SPEC.md` §7.1、`VITALS_CORE_V0_5/0_6/0_7_*`、
> `VITALS_CORE_V0_7_ADAPTER_DECISIONS.md`（"先独立 commit 评审拍板、拍板后才动代码"的先例）

> 2026-09-04 后续状态：用户已拍板并授权实施 Phase A 边界；本文件 §0–§7 保留为
> 当时的可行性审阅记录。Phase A 实际落地见 §8；Phase B1 后续实施与依赖顺序
> 修正见 §9。Phase B2–F 仍须逐阶段验收。

---

## 0. 结论

**方向可行，作为分阶段目标架构成立；但它是"提案 v2"、不是一份可一次性落地的实施规格。**

- 六层单向依赖模型与三证据面（Skill / Session / MCP）分离在概念上自洽，且与本仓
  **已经存在**的边界纪律（`vitals-core` 真无 I/O、`dependency_boundary.rs`、
  `harness_contract.rs` G1–G10、golden / Python↔Rust byte-parity、CLAUDE.md「不长第
  N 份拷贝」）同源，不是另起炉灶。
- 与已拍板的 `TAURI_RUNTIME_WORKBENCH_SPEC.md §7.1`（渐进弱化 Python）**一致**：
  编排/IO 立即 Rust-only、纯规则按档迁 core、Python 四态生命周期——v0.8 的 §9
  与 §13 Phase E 没有和它冲突。
- 但**全量 v0.8 = 六个独立 Phase（A–F），跨整个仓库**：拆 4 个 crate、新增 Model
  Catalog / Billing / User Profile / MCP 四条领域线、搬 `src-tauri` / Python /
  `dsh-client`。规格自己反复声明（§0、§11、§13、§12.3）：**每个 Phase 是独立重
  构，不与功能/schema/计费改动混在一个 commit**。这不是一个会话能"开始开发 → 全
  部跑通 → 发布"的单一交付物。

**因此本次的正确动作**（与本仓 `ADAPTER_DECISIONS.md` 先例一致）：

1. 本审阅文档独立成文、独立提交，作为 v0.8 的**拍板前置**（§6 检查单）。
2. 落地 Phase A 里**唯一现在就安全、纯增量**的一片：把「未来 domain/adapters
   crate 必须保持纯净」这条约束**变成可执行的架构测试**（§14.2 + §15 DoD），
   趁迁移**之前**钉住——迁移过程中任何一步破坏它，CI 立刻红。见 §7。
3. Phase A 的其余部分（~30 个文件搬进子目录 + runtime 调用链拆分）和 Phase B–F
   **不在本次范围**，每个 Phase 需要各自的分支 / 评审 / 逐字节零漂移验收。

成熟度自评 65–70% 是**克制且准确**的；本审阅不下调，也不上调。

---

## 1. 与现状的一致性核对（逐条实测）

| 规格断言 | 实测结果 | 结论 |
|---|---|---|
| §12.2.1 `vitals-core` 无 I/O、无执行环境概念，有依赖边界测试 | `crates/vitals-core` 依赖仅 serde/serde_json/thiserror/sha2；`tests/dependency_boundary.rs` 6 测（禁依赖 + 禁执行环境词 + 独立 Tauri workspace 跨仓核对） | ✅ 属实 |
| §12.2.2 `agent-vitals-core` 纯计算，Tauri 复用其成本函数、无第四套计价 | `src/agent/cost.rs` 只有 8 行 `pub use agent_vitals_core::cost::*`；`crates/agent-vitals-core` 直接依赖仅 regex/serde_json/vitals-core | ✅ 属实 |
| §15 DoD「domain 不读取文件、环境变量、数据库或系统时间」 | `agent-vitals-core/src/**` 非 test 代码对 `std::fs` / `std::process` / `std::env` / `SystemTime::now` 命中数 = **0**（唯一 `SystemTime::now` 在 `budget.rs` 的 `#[cfg(test)]`） | ✅ **当前已满足**——这正是可以现在就加守卫钉住的原因 |
| §12.3 P1「`agent-vitals-core/src` 平铺 Claude/Codex/DSH/WorkBuddy 模块」 | `claude_code_evidence.rs`(49K) `codex_evidence.rs`(85K) `codex_usage.rs`(77K) `dsh_evidence.rs`(33K) `workbuddy_evidence.rs`(36K) 全部平铺在 crate 根 | ✅ 属实——执行环境词汇确实进了名义上的"core" |
| §12.3 P1「data-home 解析存在 Python、CLI Rust、Tauri 三份」 | Rust 侧 `AGENT_VITALS_HOME` 读取散在 `discovery.rs`/`budget.rs`/`r2a_store.rs`/`state.rs`/`takeover.rs`；Tauri `overview.rs:395` 另一份（含 legacy `.skill-vitals` 回退）；Python `paths.py` 第三份 | ✅ 属实 |
| §12.3 P1「`src/skills/inventory.rs` 同时编排 Skill inventory + DSH session evidence + Codex runtime probe」 | `inventory.rs` 顶部 import `crate::dsh` + `skills::codex` + `skills::openclaw`，docstring 明写四阶段编排含 probe/reconcile | ✅ 属实（但该文件的 docstring 已对"为什么不是一个 trait"给了充分论证——见 §3 反对意见） |
| §12.3 P1「`cost.rs` 同时承担模型匹配、价格表、订阅排除、成本投影」 | `crates/agent-vitals-core/src/domain/cost.rs` = **99 KB**，单文件含 `price_claude_map` / `resolve_card_catalog` / `flat_rate` / `bucket_price` / `priced_day` / 订阅排除估算 | ✅ 属实——这是最有说服力的一条 |
| §14.9「WASM 只能链接 vitals-core、domain 和 adapters 的纯模块」 | `agent-vitals-wasm` 依赖**整个** `agent-vitals-core`（含 `codex_evidence` / `dsh_evidence` / `r2a` / `state` / `cost`）；靠死代码消除裁剪，不是靠 crate 边界 | ⚠️ 现状不满足——需要 crate 拆分才能真正兑现，属 Phase C 的收益之一 |
| §12.2.4 `harness_runtime_registration.rs` 已校验注册 | `src/agent/harness_runtime_registration.rs` 存在，`harness_contract.rs` G2/G3 已跑 CLI harness 词表 ↔ registry ↔ adapter 目录三处逐字对账 | ✅ 属实，是 §7 Harness Registry 的可演进基础 |
| §11 迁移映射表 | 逐条对照现有文件，**路径均存在、映射方向合理**（`usage_fact.rs`→domain/contracts、`*_evidence.rs`→adapters/harnesses、`r2a.rs` 拆纯契约/存储投影、`src-tauri`→apps/desktop 等） | ✅ 表本身无错，但见 §4 关于 `usage.rs` / `cost.rs` 拆分粒度的保留意见 |

**没有发现规格与现状的事实性冲突。** 规格对差距的描述是准确的，不是想象出来的问题。

---

## 2. 架构判断：哪些是对的

1. **六层单向 + 三禁止方向（§3.1/§3.2）** 是对的，而且**可测**——本仓已经证明
   文本级静态断言足以守住 crate 依赖方向（`dependency_boundary.rs` 的做法）。
2. **Source Connector ↔ Harness Adapter 分工（§1.1/§1.2/§4.2）** 是对的：I/O 策略与
   wire 语义是两种会独立变化的知识，DSH 的 `runtime::sources`（找 `.zstd` + 多帧
   解压）vs `adapters::harnesses::dsh`（认 `assistant/chunk` + 相邻 shadow 替换）这条
   切线清晰，且 Stage 3 已经把 observer 从 request_metrics 抽出来、正好落在这条线上。
3. **Skill / Session / MCP 三证据面不共用 scanner/fold/输出模型（§1.6/§4.1/§5 条 11）**
   是对的：`Installed → Loaded → Triggered` 漏斗与 `UsageFact` 是不同节奏、不同
   失败语义的东西，`inventory.rs` 现在把它们塞一起确实让"空值 vs unavailable"
   语义变糊。
4. **Model Catalog 四步（§1.7）+ 成本输出五分（§10.4）** 是对的，而且是整份规格里
   **收益最高**的一块：`cost.rs` 99KB 单文件、`billing.toml` 语义（§10.3 的
   `harness + source_profile` 路由粒度）、"套餐覆盖 ≠ 单价为零"——这些是当前
   `claude_subscription_uncovered_estimate` 这种打补丁做法的根因，值得优先。
5. **不抽 `HarnessAdapter` 大 trait（§5 末段 / §4.2 末段）** 是对的克制：规格自己说
   "至少三个执行环境出现完全相同、稳定的调用生命周期后才抽最小 trait"——与
   `inventory.rs` docstring 的现有论证一致。
6. **Python 作为独立 package + 四态状态标注（§9）** 与 `TAURI_RUNTIME_WORKBENCH_SPEC
   §7.1` 一致，没有制造第二套路线图。
7. **§13 分阶段 + §14 架构守卫 + §15 DoD** 的组合是对的工程方法：先让依赖方向
   变成可执行的产品边界，再搬文件。

---

## 3. 风险、需修正或澄清的点

### 3.1 [拍板前必须解决] 规格是 v2 提案，不是已拍板

规格头部写「目标架构提案 v2」，§14 v4 的先例（`ADAPTER_DECISIONS.md`）是——这种
量级的结构改动，**先独立 commit 评审拍板、拍板后才动代码**。本审阅 = 拍板前置。
在用户明确"拍板"之前，不应执行 Phase A 的文件搬迁（Phase A 的**守卫测试**是纯
增量、不改行为，可先行，见 §7）。

### 3.2 [粒度保留意见] `usage.rs` / `cost.rs` 的拆分不是纯搬运

§11 迁移表把 `usage.rs`（**188 KB**）写成"拆为 domain 通用计算与
`adapters/harnesses/dsh/usage.rs`"、`cost.rs`（99 KB）写成"拆为 domain models/ +
billing/"。这两条**不是**"移动文件"级别的操作：

- `usage.rs` 里 `token_by_model` / `token_by_date_model` / `usage_fold_resume` /
  `request_metrics` / DSH observer 是**互相咬合**的（CLAUDE.md 用大段篇幅描述它们
  的 resumability 契约、reconcile 不变量、`(turn,step)` 去重）。切"哪部分是 DSH
  wire、哪部分是跨执行环境 fold"需要一次真正的设计，且每一刀都要 golden + parity +
  `usage_fold_resume_equals_full_fold` 零漂移。**这是 Phase C 的主体工作量，不是
  Phase A/B 顺手**。
- `cost.rs` 同理：`price_claude_map` doc 注释自钉「日面与会话面的钱必须同源」、
  G10 哨兵钉「恰好三个计价入口」——拆 `models/` + `billing/` 时这些不变量要跟着
  迁移，不能断。

**建议**：§11 这两行标注"= Phase C 设计项，非搬运"，避免被读成低风险移动。

**2026-09-04 调研修正**（`docs/AGENT_VITALS_V0_8_PHASE_C_RESEARCH.md`）：进一步核实后
分成两件事——① 抽 `agent-vitals-domain` crate 的**阻塞项**是断 `domain → harness`
的 6 个生产耦合点（~370 行，3 组「移动 + 改 import」），`usage.rs` 里的耦合全在
**生产零调用**的 canonical 归一层；② `cost.rs` 拆 models/billing、`usage.rs`
wire/fold 分离**零 harness 耦合、不阻塞 crate 抽出**，是 domain 内部重构，建议并入
Phase D。本条对「非搬运」的判断只对 ② 成立；① 比原估计小得多。

### 3.3 [澄清] `agent-vitals-adapters` 无 I/O 与 Python 镜像的关系

§9 + §14.8：Python 镜像存在期间公开 JSON 保持 byte-parity。但 v0.8 把 Rust 侧拆成
`domain` + `adapters` 两个 crate，Python 侧 §2 目录只有 `adapters/` + `contracts/`
+ `compatibility/`（没有对应的 domain 层）。**Python 包的分层要不要跟着拆成
contracts/domain/adapters**（§12.3 P2 说"采用相同分层"）需要明确：如果拆，
`test_classification.py` 的 family set、`package-clawhub.yml` 的 allow-list 都要
重排；如果不拆，Python 侧的"domain vs adapter"边界只存在于文档。**建议 Phase E
再定，Phase A–D 期间 Python 不动分层**，只在 Rust 侧建边界。

### 3.4 [澄清] `~/.agent-vitals/` 布局与现有 state 的迁移

§10.2 提出 `config.toml` / `billing.toml` / `sources.toml` + `state/` + `cache/`。
现状 home 里是 `today.json` / `month.json` / `month-archive.json` / R2a cache +
`skill-scan` 快照，没有 TOML 配置层。§10.2 末段的兼容顺序
（`AGENT_VITALS_HOME → SKILL_VITALS_HOME → ~/.agent-vitals → ~/.skill-vitals`）
必须**在 HomeResolver 落地那一刻就带上**，且 `version.json` 迁移状态要有测试。
**这是 Phase D 的验收项，本审阅只标记不展开**。

### 3.5 [反对意见 - 局部] `inventory.rs` 拆分要保留其现有论证

§12.3 P1 要求拆 `src/skills/inventory.rs`。该文件 docstring **已经**论证了"为什么
四个执行环境适配器不是一个 trait"（差异在"哪些阶段存在"而非"同阶段怎么做"），并给
了 additive（codex）vs exclusive（openclaw）这条真正的语义分界。拆 Skill Source /
Service 时**这段论证和它对应的测试必须迁移过去**，不能在"分层"的名义下丢掉——
否则新结构会重新长出 trait 空实现。

### 3.6 [范围] MCP Surface（§4/§5/§8/§13 Phase F）纯属未来

规格自己把 MCP 放"后续阶段"、"未实现时不建空模块"。本审阅**不评估 MCP 的可行
性**——等 Phase A–E 落地、且有真实 MCP 证据语料后单独立项。

### 3.7 [工程] 分支与提交纪律

当前工作分支 `docs/cost-attribution-and-hour-axis-spec` 已累积 38 个未推送提交、
且分支名与内容（v0.7 Stage 1–3 全在里面）已不符。v0.8 的每个 Phase 应**各自开
分支**，不继续堆在这条分支上。本审阅文档 + Phase A 守卫按本仓既有习惯提交，
但后续 Phase 必须换分支。

---

## 4. 可行性分档（代价与顺序）

| Phase | 内容 | 代价 | 风险 | 前置 |
|---|---|---|---|---|
| **A（守卫）** | §14.2/§14.4/§15 DoD 变可执行测试（本次落地）| 小（~1 个测试文件，纯增量）| 极低（约束已满足）| 无 |
| A（边界）| `agent-vitals-core/src` 内建 `contracts/domain/adapters/harnesses` 子模块 + re-export | 中（~30 文件搬子目录，`lib.rs` 重写，CLAUDE.md 大段更新）| 中（golden/parity 零漂移门 + CLAUDE.md 引用的模块路径全失效需同步）| 拍板 |
| **B** | 抽 `agent-vitals-adapters` crate（先 claude/codex，再 dsh/workbuddy）| 大 | 中高（wasm 依赖重接、`test_classification` family set 重构、clawhub 打包边界）| A 完成 |
| **C** | 抽 `agent-vitals-domain` crate + 拆 `cost.rs`→models/billing + 拆 `usage.rs`→domain/adapter | **最大**（§3.2）| 高（计价/fold 不变量逐刀零漂移）| B 完成 |
| **D** | `agent-vitals-runtime` crate + 唯一 HomeResolver + User Profile/Catalog loader + Skill/Session services | 大 | 高（state owner 唯一性、Tauri 去子进程、home 迁移）| C 完成 |
| **E** | `apps/cli` + `apps/desktop` + `packages/agent-vitals-python` + `integrations/dsh-client` 目录搬迁 | 中（主要是路径 + CI）| 中（发布流水线、`.github/workflows/*` 全改）| D 完成 |
| **F** | MCP Surface | 未知 | 未知 | E 完成 + 真实 MCP 语料 |

**结论**：A（守卫）今天可做。A（边界）→ E 是一串**互相串行**的大重构，每个都需要
独立分支、独立评审、逐字节零漂移验收。合计工作量远超单次会话，且规格明令不许
压成大提交。

---

## 5. 拍板前置检查单（建议用户逐项确认后再进 Phase A 边界）

1. [x] v0.8 已升为「已拍板」（2026-09-04）。
2. [x] `usage.rs`/`cost.rs` 语义拆分保留为 Phase C 设计项；Phase A 只移动所有权路径。
3. [x] Python 包在 Phase A–D 期间不改分层。
4. [x] Phase A 使用独立分支 `codex/v0.8-phase-a-boundaries`。
5. [x] Phase A 同批更新 CLAUDE.md、文档、fixture 与测试中的模块路径引用。
6. [x] `~/.agent-vitals/` 新布局及迁移测试保留为 Phase D 硬验收项。
7. [x] MCP 保留为 Phase F 单独立项，本轮不承诺。

---

## 6. 本次落地范围

**只做 Phase A 的守卫片（§14.2 + §15 DoD 可执行化），不搬任何文件、不改任何行为。**

- 新增 `crates/agent-vitals-core/tests/dependency_budget.rs`：
  1. `[dependencies]` ⊆ 允许清单——禁止 `rusqlite` / `ruzstd` / `tokio` / `notify` /
     `reqwest` / `tauri` / `wasm-bindgen` 等 I/O / 原生 / 运行时依赖悄悄进入未来的
     domain+adapters（§3.3 依赖预算、§14.2）。
  2. 非 test 源码零 `std::fs` / `std::process` / `std::env` / `SystemTime::now` /
     `Instant::now`（§15 DoD「domain 不读取文件、环境变量、数据库或系统时间」）。
  3. 不依赖 `agent-vitals`（二进制）/ `agent-vitals-wasm`（§3.2 禁止方向）。
- 本审阅文档。

两者一起提交，全套 gate（`cargo test` / `cargo clippy` / Python `unittest` /
golden 双侧）验证零漂移后推送。**Phase A 边界搬迁及 B–F 待用户按 §5 拍板后各自
开分支执行。**

---

## 8. Phase A 边界实施记录（2026-09-04）

用户完成 §5 拍板后，Phase A 边界在独立 worktree/分支实施，未改变公开 JSON、计费、
fold、fact identity 或执行环境 wire 语义：

1. `agent-vitals-core/src` 从平铺结构迁为 `contracts/`、`domain/`、
   `adapters/harnesses/<harness>/sessions/`，执行环境集合为 Claude Code、Codex、DSH、WorkBuddy。
2. `lib.rs` 保留旧 public path compatibility re-export；新代码可使用显式所有权路径。
3. `dependency_budget.rs` 增加目录集合、执行环境集合、re-export 等价和
   domain→harness 既有兼容债务不得增长的守卫。
4. `src/agent/session_sources.rs` 成为 DSH Session 证据读取入口；
   `src/skills/inventory.rs` 只消费注入的 `SessionEvidenceInput`，不再直接读取
   Session 日志。注册表快照与 Codex/OpenClaw probe 仍是 Skill capability 证据。
5. Python 目录结构、state schema、计费逻辑、Tauri 与 MCP 范围均未改变。

Phase A 完成不等于 v0.8 全部完成。下一阶段是 Phase B：抽出独立
`agent-vitals-adapters` crate；必须在 Phase A 全量门禁和零漂移审计通过后另开评审。

---

## 9. Phase B1 实施与顺序修正（2026-09-04）

独立分支 `codex/v0.8-phase-b-adapters` 已建立 `agent-vitals-adapters` crate，并迁出
Claude evidence、Codex evidence、WorkBuddy evidence。CLI 使用新 crate 的统一 facade；
新 crate 保持无文件、进程、环境变量、SQLite、zstd、watcher 与 Tauri 依赖。

实施中确认 Phase A 守卫记录的两组反向依赖会导致 Cargo 环：

- `domain::usage` → Codex usage fold；
- `domain::{behavior,trajectory,compaction,waste}` → DSH evidence。

所以 Codex usage 与 DSH evidence 暂留 core 的 `adapters/`，由新 adapter crate 统一
re-export。该状态不是最终所有权，也不冒充 Phase B 全部完成。Phase C 的第一步应先
解除 domain→harness 依赖，然后 Phase B2 将这两个模块物理迁出；架构测试禁止残余集合
从两个继续增长。这样避免为了目录纯洁复制解析器或提前改变 fold 语义。

**B1 收口（2026-09-04）**：

- **格式噪声清理**：迁移过程一度对 `harness_contract.rs` / `dependency_budget.rs`
  跑了 `cargo fmt` 全文件重排（本仓无 `rustfmt.toml`、既有风格刻意紧凑）——已还原，
  两个测试文件现在只剩实质路径/断言改动（g3/g8 evidence 路径改仓根相对、
  `residual_harness_adapter_directories` 断言收敛到 `["codex","dsh"]`）。
- **WASM 依赖**：一度给 `agent-vitals-wasm/Cargo.toml` 挂了 `agent-vitals-adapters`
  依赖，但 `wasm/src/lib.rs` 一个符号都没用它——已撤掉。§3.1 的 `wasm ─► adapters`
  是未来边，带真实调用点的 Phase 再加。
- **全量门禁零漂移**（`codex/v0.8-phase-b-adapters` 工作树）：
  `cargo build --release` / `cargo test --release`（313 binary + 35 adapters +
  452 core + 4 依赖预算 + SV601–614 parity + 53 vitals-core，全绿）/
  `cargo clippy --release --all-targets -D warnings` clean /
  `python3 -m unittest discover tests` 1143 通过 226 skipped /
  golden 15 Python + 15 Rust 逐字节一致 / `cargo check -p agent-vitals-wasm` 绿。
