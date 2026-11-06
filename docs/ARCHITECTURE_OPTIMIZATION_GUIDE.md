# 架构优化执行指南（面向执行 Agent）

> 状态：草案，2026-09-24 起草，基线 commit `e3e06ce`
> 读者：执行代码调整的 Agent（Claude / Codex / 其他）。人类评审者请重点看 §6「需人类拍板的决策」。
> 本文是**执行指令**，不是设计辩论。每个工作流（W1–W9）写明了目标、证据、步骤、禁止事项和验收标准。
> 做之前先读完 §1、§2，然后只领取**一个**工作流。

---

## 0. 使用规则（每个执行 Agent 必须遵守）

1. **一次只做一个工作流，一个工作流开一个分支**：`arch/W<n>-<slug>`，例如 `arch/W2-typed-ipc`。
   不要把两个工作流的改动混进同一个 PR。W 之间的依赖见 §4。
2. **行为不变是默认前提。** 除非某个工作流写明「这一步有意改行为」，否则 golden、差分、契约测试
   必须**不改期望值**就全绿。不允许为了让测试变绿去跑 `golden_runner.py --update`。
3. **按小步提交，每步都能编译、都能过测试。** 结构搬迁（移动文件或模块）和逻辑改动
   分成不同 commit，方便审查时用 `git diff -M` 看出这是纯搬迁。
4. **以棘轮守卫为准。** 多数工作流会新加一个「只许减少、不许增加」的计数测试（见各工作流的验收部分）。
   先加守卫、记下当前值，再动手迁移；每迁移一批就把阈值往下调。
5. **遵守仓库既有纪律**（CLAUDE.md 全文仍然有效），特别是：
   - 注释用中文，写清楚「为什么显然的做法是错的」。
   - 修过的 bug 要在 `tests/test_regressions.py` 或对应的 Rust 测试里留一条，docstring 写清楚当时坏的是什么。
   - 菜单栏 app 只能以 `.app` 形态验证（`cargo tauri build --bundles app` + `open`），**绝不直接运行二进制**。
   - 只在主仓库构建和安装桌面端或 CLI；worktree 里只改代码。
6. **遇到本文没写到的情况**：先停下来，在 PR 描述里写清楚问题，不要自己扩大范围。
   本文列出的「禁止事项」优先于执行者对「更好做法」的判断。
7. **完成标准**：§5 的通用验证命令全部通过，加上该工作流自己的验收条目，再按 §7 的格式写 PR 描述。

---

## 1. 现状快照（基线 `e3e06ce`，用于衡量进展）

| 指标 | 基线值 | 出处 |
|---|---|---|
| `agent-vitals-runtime` 代码行 | 41,111（9 个子系统：mcp 8.2k / query 7.6k / ingest 7.0k / sessions 5.9k / billing 4.8k / core / skills / trust / sources） | `crates/agent-vitals-runtime/src/` |
| `apps/cli/src/main.rs` | 5,651 行，业务代码约 5,500 行 | 第 5500 行起是 `#[cfg(test)]` |
| `apps/desktop/src-tauri/src/lib.rs` | 6,654 行，85 个 `#[tauri::command]`，非测试代码约 2,400 行 | `generate_handler!` 在第 4844 行 |
| `store.rs` | 2,513 行，39 个命令 | |
| 返回无类型 `serde_json::Value` 的命令 | ≈ 90 个（`Result<Value,String>` 35 / `Value` 33 / `Result<Value,Value>` 22） | lib.rs + store.rs |
| 进程级 `static` 缓存或锁（桌面 + runtime） | ≥ 8 个 | 见 W5 |
| `agent-vitals-data/src/authority.rs` | 6,593 行，业务代码约 4,200 行 | |
| Python 包 | 72 个模块 / 26,340 行，ClawHub 几乎全部打包 | `package-clawhub.yml:74` |
| Rust 中 legacy/TODO/FIXME 标记 | 671 个 | |
| Cargo workspace 个数 | 2（根 + `apps/desktop/src-tauri`），两份 `Cargo.lock` | |

---

## 2. 全局不变量（任何工作流都不能破坏）

这些是现有架构里做对了的部分。重构要**保住**它们，不能把它们当作障碍绕过去：

- **依赖方向单向**：`harnesses → domain → vitals-core`，`data → domain`，`runtime → {data, domain, harnesses}`。
  新增 crate 时，必须在对应的 `tests/dependency_budget.rs` 里加上方向断言。
- **domain 纯度**：不碰 fs/process/env/clock，不认识执行环境的 wire 格式
  （`domain_holds_no_dsh_wire_module` 等守卫）。
- **I/O 只出现在 `/sources` 路径下**（`io_tokens_only_appear_under_sources`）。
- **数据面权威**：facts JSONL 是 append-only 的权威源；`agent-vitals.sqlite3` 是 SQL 权威库；
  writer lease、半行修复、13 个月保留期的 fencepost 都不能动。
- **四个金额量互不相加**（nominal / metered / subscription / unpriced，外加 metered_declared）。
  重构不能把它们合并进同一个字段。
- **出口政策**：MCP 面和导出面的脱敏红线不变；新增任何出网路径都需要产品评审（CLAUDE.md「数据留存与出口政策」）。
- **Python↔Rust golden 逐字节一致**：只要某条规则的 Python 实现还在，差分门禁就必须是绿的。

---

## 3. 工作流

优先级：**P0** 会持续产生缺陷或已经造成数据分歧；**P1** 是结构性的，拖着不做会越来越贵；**P2** 是收益明确的卫生工作。

### W1 [P0] Python 范围收窄：ClawHub 不再分发会话、成本、状态栈

> ⚠️ 这是产品决策，**开工前需要人类批准**（§6-D1）。批准之前只能做步骤 1（盘点）。

**问题证据**
- Rust 已经停用 `month.json`：`crates/agent-vitals-runtime/src/core/takeover.rs:365` 断言「month.json 已退役，不能写」。
- Python 的 `packages/agent-vitals-python/agent_vitals/agent/state.py` 仍在维护
  `month.json` / `month-archive.json`，并通过 ClawHub 分发。同一台机器上存在两套互相矛盾的账。
- `TAURI_RUNTIME_WORKBENCH_SPEC.md` §7.1 定下的逐步缩减计划没有落地，需要两边对齐的面反而在变大
  （usage_fact、sessions_sql）。

**目标状态**
- ClawHub 包只含：`skills/`（静态体检）、`cli.py`/`compat.py`/`paths.py`/`util.py`/`source_identity.py`，
  以及 SKILL.md 工作流**确实需要**的只读诊断模块。
- 会话审计和成本类子命令（`behavior`、`*-usage-facts`、`budget`、`calendar` 等）在 Python 侧改成：
  检测到 Rust 二进制（`AGENT_VITALS_BIN` 或 `PATH` 中的 `agent-vitals`）就调用它；
  检测不到就输出结构化的 `unavailable` 并说明原因。**绝不能退回到旧的 JSON 账本。**

**步骤**
1. **盘点**（不需要批准）：生成 `docs/PYTHON_SCOPE_INVENTORY.md`，逐个模块列出：
   被哪些 SKILL.md 步骤或 CLI 子命令用到、有没有 Rust 对应实现、在哪个差分测试里、建议保留还是退役。
   `state.py`、`budget.py`、`cost.py`、`r2a.py`、`sessions_sql.py` 必须逐个给出结论。
2. 在 `cli.py` 加 `_delegate_to_rust(subcommand, argv)`：只做调用子进程和透传输出，
   不做任何二次计算。它的测试放进 `tests/test_cli_matrix.py`。
3. 按盘点结论**逐个模块**退役。每退役一个模块，要同时改：
   - `.github/workflows/package-clawhub.yml:74` 的允许清单；
   - `tests/test_clawhub_packaging.py` 的 `ALLOWED_PACKAGE_FILES`；
   - `tests/test_classification.py` 的家族集合；
   - 对应的 Python 差分测试：改成只在 `AGENT_VITALS_BIN` 存在时比较委托输出，或者删除；
   - `SKILL.md` 与 `references/guide.zh-CN.md` 里对应的说明（中英文同步）。
4. 模块代码本身先从包里排除，**源文件在仓库里保留一个版本周期**，然后再删。

**禁止事项**
- 不要让 Python 去读 Rust 的 SQLite 权威库然后自己算钱（这等于长出第五份成本实现）。
- 不要改 `skills/` 静态体检的输出（golden 必须不动）。

**验收**
- ClawHub 打包产物里没有 `state.py`、`budget.py`、`cost.py`、`r2a.py`。
- `python3 -m unittest discover tests` 与 `python3 tests/golden_runner.py` 全绿，
  并且 `AGENT_VITALS_BIN=target/release/agent-vitals python3 tests/golden_runner.py` 全绿。
- 在没有 Rust 二进制的环境里，`python3 scripts/scan.py behavior <log>` 输出 `unavailable` 并以非零码退出，
  不会崩溃，也不会编造数据。

---

### W2 [P0] 桌面 IPC 类型化：Rust DTO 是形状的唯一来源

**问题证据**：约 90 个 Tauri 命令返回 `serde_json::Value`；前端用 `invoke<T>`
（`apps/desktop/ui-dev/react/src/lib/tauri.ts`），`T` 是手写的。
CLAUDE.md「形状来源纪律」记录的 10 条确认缺陷，根因都是手写的形状互相印证、一起写错。
现有的 `scripts/verify-react-*-contract.mjs` 也是手写形状。

**目标状态**：每个命令的请求和返回都是带 `#[derive(Serialize, ts_rs::TS)]` 的结构体；
TS 类型从 Rust 生成到 `apps/desktop/ui-dev/react/src/lib/generated/`；前端只 import 生成的类型。

**选型**：用 `ts-rs`（只绑定 DTO，不绑定 Tauri 版本）。不用 `tauri-specta`：它仍处于 RC 阶段，
而且会接管命令注册，改动面太大。`ts-rs` 只作为桌面端依赖，不进入 CLI 和 Python 分发物，
所以不违反「分发物无第三方供应链」的约束。

**步骤**
1. 加棘轮测试 `apps/desktop/src-tauri/tests/ipc_typing_ratchet.rs`：扫描 `src/**/*.rs`，
   统计 `#[tauri::command]` 后 3 行内出现 `Value` 返回类型的命令个数，断言 `<= 基线值`。
2. 建 `apps/desktop/src-tauri/src/dto/` 模块，按功能分文件（overview / sessions / trust / billing / settings …）。
3. **一次迁移一个功能页**，顺序是：overview → sessions → usage → findings → trust → settings → 其余。每个页面：
   a. 以**产生方**的真实序列化代码为准定义结构体。先读 fold 或查询函数，不要读前端代码来猜形状。
      可选字段用 `Option<T>` 加 `#[serde(skip_serializing_if = "Option::is_none")]`，
      确保序列化出来的 JSON **字节不变**。
   b. 命令签名改成 `-> Result<XxxDto, IpcError>`。`IpcError` 是统一的错误枚举，
      取代现在混用的 `Result<_, String>` 和 `Result<_, Value>`；它的序列化形状必须和前端现在解析的错误形状兼容。
   c. 用 `cargo test export_bindings` 生成 TS，前端改为使用生成的类型，删掉对应的手写类型。
   d. 对应的 `.mjs` 契约脚本改为 import 生成的类型或 fixture；stub 的形状必须来自生成物，并在注释里写明来源。
   e. 调低棘轮阈值。
4. CI：在 `verify.yml` 加一步：重新生成 bindings，然后 `git diff --exit-code apps/desktop/ui-dev/react/src/lib/generated/`。

**禁止事项**
- 不要在迁移中「顺手」改字段名或语义。改名要单独开 PR，并同步前端。
- 不要为了通过类型检查，在前端用 `as any` 或 `as unknown as` 绕过。
- `serde_json::Value` 只允许用在真正开放的透传字段上（例如 MCP 原样结果），并且要加注释说明原因。

**验收**
- 棘轮阈值降到 ≤ 5，每个剩下的都有注释说明理由。
- `npm run verify:react` 全绿，`tsc --noEmit` 零错误。
- 每迁移完一个页面，就按 `.app` 形态人工打开该页面，确认渲染和迁移前一致（PR 里附截图或说明）。

---

### W3 [P1] 拆分 `agent-vitals-runtime`

**问题证据**：41k 行，9 个子系统，是全仓库最大的 crate；`legacy-r2a` / `watcher` / `mcp-internal`
这几个 feature 的组合靠人记；改任何一处，所有消费者都要全量重新编译。

**目标 crate 布局**

```
crates/agent-vitals-runtime-core/    # home(HomeResolver) / clock / logging / retention / statistics_timezone / lease
crates/agent-vitals-ingest/          # ingest/ + sources/ + source_graph + events + watcher(feature)
crates/agent-vitals-query/           # query/（summary / trace / read_memo / read_gate）+ sessions/ 的只读部分
crates/agent-vitals-billing/         # billing/：纯计算下沉到 domain，剩下的 I/O 编排留在这里
crates/agent-vitals-mcp/             # mcp/（出口面单独一个 crate，便于审查脱敏红线）
crates/agent-vitals-trust/           # trust/ + skills/（若 skills 与 trust 无耦合则各自独立）
crates/agent-vitals-runtime/         # 过渡期门面：pub use 以上各 crate，保持一个周期后删除
```

~~依赖方向：`runtime-core ← ingest ← query`~~（**已被实测推翻**，见下方进度）。

**进度（2026-09-24，分支 `arch/W3-split-runtime`）**
- ✅ 解环（`83f98bf`）：原先有十几条双向依赖，大多是因为时钟、锁、错误类型放错了模块。
  实测的生产依赖 DAG 是：
  `L0 core/pricing/source_graph ← L1 envelope/events/skills ← L2 sources/sessions ← L3 query ← L4 billing ← L5 ingest/trust ← L6 mcp`。
  注意 **ingest 在 query 之上**：同步完成后会触发价格对账（`price_discovery`），而价格对账要读 `query::summary`。
- ✅ 分层守卫 `crates/agent-vitals-runtime/tests/module_layering.rs`（`b160bfd`）。
- ✅ 拆出 `agent-vitals-runtime-core`（L0–L1，约 6.9k 行，`62ab747`）。
- ✅ W8 先行（`77ff4ff`、`b6afc21`）：行为 findings 改为同步后增量评估，r2a 整体删除（见 W8）。
- ✅ 执行环境注册表（`7a1ffca`）：`agent-vitals-harnesses::sources::session_harnesses`；runtime 的执行环境 wire 代码
  （Codex 计价/会话审计、DSH 行为审计/会话发现，约 1.7k 行）搬进 harnesses。
- ✅ 进程内同步引擎 + tick 调度状态机（`1ee3d2c`），桌面 tick 改用它们并移除遗留的
  discover/oneline/claude-sync 子进程（`e441d90`，顺带修复「每次成功同步都显示为失败」）。
- ✅ 拆 crate（`0fe6d37`…`5971be9`）：query（L2–L3）→ billing（L4）→ ingest、trust（L5）→ mcp（L6）；
  `agent-vitals-runtime` 成为纯门面。
- ⚠️ 未做 `.app` 真机验证（桌面 tick 行为已变，CLAUDE.md 要求在主仓库构建 `.app` 验证）。
- 遗留：runtime 门面的 `[dependencies]` 仍列着已不直接使用的 crate（其 `tests/` 在用部分）；
  `sync_harness` 内部仍有 codex 批量 emit 的执行环境分支；`watch_topology` 的默认监听根与注册表的
  默认根是两份约定；CLI 的 `oneline` / `claude-sync` / `discover` 命令本身未删。
- 后续可做：把 ingest 对 billing 的依赖反转成注入式消费者（`sync_service.rs` 的 price-reconcile），
  ingest 就能下沉到 query 之下；`query::cost_breakdown` 里的 MCP `spec()` 外壳应该移回 mcp。

**步骤**
1. 先画出当前模块之间的依赖图：`cargo modules` 或 grep `crate::` 引用都可以。
   结果写进 PR 描述；如果发现环，先解环再拆。
2. 按**叶子优先**的顺序抽取：runtime-core → billing → trust/skills → mcp → query → ingest。
   每抽一个 crate：
   - 搬迁 commit 只做 `git mv` 和 `use` 路径修改；
   - 门面 crate 里加 `pub use agent_vitals_xxx as xxx;`，让 CLI 和桌面端的导入路径不变；
   - 新 crate 加 `tests/dependency_budget.rs`，写明允许的依赖集合；
   - `Cargo.toml` 的 `members` / `default-members` 同步更新。
3. `ENV_LOCK`（`runtime/src/lib.rs:94`）归 W5 处理，拆分时不要把它复制到多个 crate。
   如果临时需要，放在 `runtime-core` 的 `#[cfg(any(test, feature = "test-support"))]` 下。
4. 全部抽完后，CLI 和桌面端改为直接依赖需要的子 crate，门面 crate 在**下一个** PR 里删除。

**禁止事项**
- 拆分期间不改任何函数签名或逻辑，只改路径。
- 不要借机把 `sessions/r2a_store.rs` 挪进新 crate。它的去留由 W8 决定，拆分时原样放进 `query`，
  继续由 `legacy-r2a` feature 控制。

**验收**
- 每个新 crate ≤ 12k 行（mcp 若超过要说明理由）。
- `cargo test`、`cargo clippy --release --all-targets -- -D warnings` 全绿；
  桌面 `cargo tauri build --bundles app` 成功。
- 记录拆分前后改一行 `query/` 代码的增量编译时间（`cargo build -p agent-vitals` 两次计时），写进 PR 描述。

---

### W4 [P1] 应用服务层 + 瘦入口

**问题证据**：CLI `main.rs` 业务代码约 5,500 行，一个 `fn main` 从第 1735 行开始分派全部子命令；
桌面端 `lib.rs` 有 85 个命令堆在一个文件里。两边各自拼装「读 → 算 → 组装」的流程，已经在慢慢不一样
（例如 `main.rs:997` 的 Findings 走 r2a_store，而桌面端走 SQL）。

**目标状态**
- 在 `agent-vitals-query`（W3 之后；W3 之前就放在 `runtime/src/app/`）里加 `app` 模块：
  **每个用例一个函数**，输入显式的 `AppCtx`（home、clock、cache），输出 W2 的 DTO 或 CLI 的报告结构体。
  例如 `app::overview(&ctx, OverviewQuery) -> OverviewDto`。
- CLI：`apps/cli/src/commands/<name>.rs`，每个文件只做「clap 参数 → 调 app 函数 → 渲染（JSON/文本）」。
  `main.rs` 只保留 `Cli` 定义和分派，目标 ≤ 400 行。
- 桌面端：`apps/desktop/src-tauri/src/commands/<feature>.rs`，`lib.rs` 只保留 `run()`、插件和托盘装配，
  以及 `generate_handler!`，目标 ≤ 800 行（不含测试）。

**步骤**
1. 加行数棘轮测试：`apps/cli/tests/entry_size_ratchet.rs` 和桌面端的同名测试，
   分别断言 main.rs、lib.rs 的非测试行数 ≤ 基线值。
2. 先做**两端都有的用例**，收益最大：overview / sessions list / session detail / data-status / budget。
   对每个用例，先对比两端现在的实现，把差异列进 PR。
   **如果两端结果不同，先停下来报告，不要自己选一边**（这可能是个 bug，需要人类判断哪边对）。
3. 再搬只有一端有的命令（纯搬迁）。
4. 测试跟着代码走：原来在 main.rs 或 lib.rs 里的 `#[cfg(test)]` 搬到对应的 `commands/*.rs` 或 `app/*.rs`。

**禁止事项**
- app 层不能依赖 clap、tauri，也不能调用 `println!`。
- 不能为了复用去改 CLI 的 `--json` 输出（CLI help 和输出受 `test_regressions` 与 golden 约束）。

**验收**：行数目标达成；`tests/test_cli_matrix.py` 的差分、golden、`npm run verify:react` 全绿。

---

### W5 [P1] 统一读缓存，去掉进程级全局状态

**问题证据**（修刷新风暴和 tab 卡顿时一层层叠上去的，失效规则各不相同）：
- 桌面端：`overview.rs:368 MONTHLY_MEMO`、`lib.rs:2387 MEMO`、`lib.rs:2484 SYNC_COMPUTE_LOCK`、
  `lib.rs:4339 GATE`、`store.rs:199 PROBE_RESULTS`
- runtime：`query/read_memo.rs`、`codex_merged_cached`（60s TTL）、`mcp/data_status.rs:451 CACHE`
- `runtime/src/lib.rs:94 pub static ENV_LOCK`：测试用的锁编进了正式库，原因是 home 路径是从环境变量读的，而不是作为参数传入。

**目标状态**
- 一个 `ReadModelCache`（放在 query crate），键为 `(data_home, authority_revision, query_key)`。
  失效**由 revision 推进驱动**：沿用现有的 `Invalidated { revision }` 事件（`runtime/src/events.rs`）。
  只有读不到 revision 的数据源（例如 codex rollout 目录）才保留 TTL，并在注释里说明原因。
- 并发防护沿用现有的 `ReadGate` 语义（同 revision 并发 N 个请求，实际计算次数 ≤ permits），
  但把它变成 cache 的内部实现，不再单独放一个 static。
- 桌面端通过 `tauri::Manager::manage` 注入 `AppCtx`；CLI 每次执行建一个短生命周期的 `AppCtx`。
- `HomeResolver` 显式传参；测试用 `tempdir` 构造 ctx，**不再改进程环境变量**，然后删除 `ENV_LOCK`。

**步骤**
1. 把现有缓存的行为测试补全：`overview_memo_concurrency_and_stale_guard`、刷新风暴 R1–R5 相关测试。
   这些是回归护栏，**先确认它们全绿，再动代码**。
2. 实现 `ReadModelCache`，把现有 memo 一个个迁过去；每迁一个就删掉对应的 static。
3. 最后处理 `ENV_LOCK`：grep 所有 `set_var("AGENT_VITALS_HOME"` 的测试，改为注入 ctx。

**禁止事项**
- 缓存命中路径必须返回 `Arc`，不能在锁内深拷贝（CLAUDE.md 性能形状一节，2026-09-05 事故）。
- codex 数据面必须走统一缓存。不能新建一条「枚举 + fold」管线（那样会把「每个 tab 做三倍全量 fold」的回归原样再造一次）。

**验收**：`rg 'static .*(OnceLock|Mutex)' apps/desktop/src-tauri/src crates/*/src` 只剩 logging 单例和写入锁的 `MACHINE_NS_LOCK`，并且都有注释；`ENV_LOCK` 已删除；刷新风暴相关测试全绿；按 `.app` 形态快速切换 tab 不卡顿（人工验证，写进 PR）。

---

### W6 [P2] 统一依赖版本与 workspace

**问题证据**：`apps/desktop/src-tauri` 是独立 workspace，有自己的 `Cargo.lock`；
`rusqlite = 0.31 bundled` 在 cli / data / probe / runtime / harnesses 里分别声明。目前两边版本碰巧一致。

**步骤**
1. 根 `Cargo.toml` 加 `[workspace.dependencies]`，放入 `rusqlite`、`serde`、`serde_json`、`regex`、
   `sha2`、`walkdir`、`clap`；各 crate 改为 `rusqlite = { workspace = true, features = [...] }`。
2. 桌面端二选一（需要人类确认，见 §6-D2）：
   - **方案 A（推荐）**：并入根 workspace 的 `members`，**不进** `default-members`，保持 `cargo test` 不构建 tauri；
     删除 `apps/desktop/src-tauri/Cargo.lock`。
   - **方案 B**：保持独立，但在 CI 加脚本比较两份 lock 中共同依赖的版本，不一致就失败。
3. 并入后验证 `cargo tauri build --bundles app` 在 `apps/desktop/src-tauri` 下仍然正常（tauri-cli 支持从子目录定位 workspace）。

**验收**：全仓库只有一处 rusqlite 版本声明；CI 绿；`.app` 构建产物能启动，托盘正常显示。

---

### W7 [P2] 跨仓库契约版本化（wasm + pricing）

**问题证据**：从 2026-09-22 起，wasm 和 `pricing.json` 要手动复制到 `dsh-agent-vitals-audit`；
`test_pricing_lockstep.py` 只能跳过，漏复制已经没有任何自动检查。

**步骤**
1. 新建 `.github/workflows/release-contracts.yml`：在 `contracts-v*` tag 上构建 wasm
   （`wasm-pack build --target web`，关闭 wasm-opt），并把 `agent_vitals_wasm.js`、`_bg.wasm`、
   `assets/pricing.json`、`assets/codex_pricing.json` 和 `CONTRACTS.sha256` 上传为 Release 附件。
2. 仓库根目录加 `contracts.lock.json`，记录当前契约版本和各文件的 sha256。
   `tests/test_pricing_lockstep.py` 改为：断言 `assets/pricing.json` 的哈希与 lock 一致；
   如果不一致，失败提示「发了新 pricing 要先 bump contracts 版本」。
3. 在 PR 里给 `dsh-agent-vitals-audit` 仓库写明需要的对应改动（固定使用某个契约版本，CI 校验哈希）。
   **本仓库的 Agent 不要直接修改那个仓库**，只输出说明。

**验收**：改 `assets/pricing.json` 却不更新 `contracts.lock.json` 时，本仓库 CI 失败。

---

### W8 [P2] 遗留清理：r2a、legacy 标记、执行环境分派

> ✅ 已完成（2026-09-24，`77ff4ff`/`b6afc21`）：原计划「直接删」的前提不成立——r2a 是行为
> findings 写入 Issues 表的唯一生产者，且 React 切换后无人触发。改为同步后增量评估
> （`ingest/findings_eval.rs`，身份与 r2a 逐字段一致），再整体删除 r2a。
> 执行环境分派注册表也已完成（见 W3 进度）。

1. **r2a 退役**：CLI Findings 仍走 `agent_vitals_runtime::sessions::r2a_store::sessions_findings`
   （`apps/cli/src/main.rs:4341`，说明在 `:997`）。
   把它改成走 SQL 权威库的 findings 查询，与桌面端 Findings 页同源；
   然后移除 CLI 的 `features = ["legacy-r2a"]`，再删除 `r2a_store.rs`、`legacy-r2a` feature，
   以及 Python 的 `r2a.py`（后者与 W1 协调）。
   改之前先对真机数据做一次新旧输出比对，差异写进 PR。
2. **执行环境分派注册表**：在 `agent-vitals-harnesses` 定义
   `trait HarnessSource { fn kind() -> HarnessKind; fn discover(&self, home) -> Vec<PathBuf>; fn canonical_session(..); fn quota(..) -> Option<..> }`
   和一个静态注册表。把 `runtime/src/query/trace_service.rs:143-168`、`query/summary/quotas.rs`、
   `harnesses/src/sources/{parsers,canonical_input}.rs` 里的 `"claude-code" => …` 字符串 match 换成查注册表。
   目标：以后接入 Pi 或 Hermes 时，**只新增**一个 `HarnessSource` 实现，不用改 query 层。
3. **legacy 标记**：671 处 `legacy|deprecated|TODO|FIXME`。输出一份分类清单
   （已失效可删 / 有 issue 待办 / 是描述历史的注释），**只删「已失效可删」这一类**，其余只登记。

**验收**：`legacy-r2a` 在仓库里 grep 不到；`trace_service.rs` 不再有执行环境字符串 match；legacy 标记减少的数量写进 PR。

---

### W10 [P2] domain 去执行环境化：会话语义只定义一次

**背景（2026-09-27 盘点）**：`agent-vitals-domain` 的职责是执行环境无关规则，但仍有按执行环境名写死的
分支；反过来，`agent-vitals-harnesses` 里有本该执行环境无关的会话语义被每个执行环境各写一份。

**已完成（会话消耗诊断 P0 顺手收口）**：
- 新增 `domain::session_semantics`：`fingerprint` / `safe_label` / `iso_to_epoch_ms` / `outcome` /
  `session_span`（原 `harnesses::workflow_utils`，dsh 另有逐字副本）、`invocation_fingerprint`
  （原 claude / codex 各一份）、`ModelSwitchTracker`（原四个执行环境各一段 `previous_model` 比较）、
  `UserTurnSignal` + `TurnTracker`（回合语义）。`harnesses::workflow_utils` 退为 re-export。
- Claude 的回合判据收成一份 `harnesses::claude_code::sessions::turns::turn_signal`，evidence（SV612、
  调用树、UserPrompts 覆盖）与 workflow（`task_started`）共用；Python 镜像
  `claude_evidence.turn_signal`，`tests/test_claude_turns.py` 钉住。此前两处结论不同，同一会话在调用树
  与消耗诊断里回合数对不上。

**待做（按执行环境名分支的 domain 代码）**：

| 位置 | 现状 | 目标 |
|---|---|---|
| `domain/cost/mod.rs::metered_estimate_minor` | `harness == "codex" / "claude-code"` 选价卡与桶形状 | 调用方传入规范化的四桶 + 价卡目录；执行环境差异留在 harnesses 的 usage 适配 |
| `domain/usage.rs`（`SOURCE_CODEX`、`canonical_tokens` 按 source 选形状） | 按来源切换 token 桶字段名 | 执行环境适配器先产规范桶，domain 只折叠规范桶 |
| `domain/canonical_audit.rs` | 按执行环境 id 决定 SV607/608 降级 | 由执行环境能力声明（`harness_capability`）驱动，不认执行环境名 |

**完成标准**：`agent-vitals-domain/tests/dependency_budget.rs` 增加一条守卫——`src/domain/` 生产代码
（`#[cfg(test)]` 之外）不出现执行环境名字面量（`"claude-code"`、`"codex"`、`"dsh"`、`"workbuddy"`），
以上三处迁完后打开。

### W9 [P2] 拆大文件与整理文档

1. `crates/agent-vitals-data/src/authority.rs`（业务代码约 4,200 行）拆成 `authority/{schema.rs, migrations.rs, writers.rs, readers.rs, mod.rs}`；
   `authority_query.rs` 按查询主题（usage / billing / issues / sessions）拆开。纯搬迁，公开 API 路径通过 `pub use` 保持不变。
2. 文档：
   - 新建 `docs/adr/`，把 CLAUDE.md 里的事故和历史叙述（Phase A–E 的历史、各次事故经过）
     提炼成 ADR（背景 / 决策 / 后果），CLAUDE.md 只保留**现在仍然成立的规则**和指向 ADR 的链接。
     目标是 CLAUDE.md 篇幅减半以上，不丢任何一条仍然有效的不变量。
   - `docs/` 下已完成阶段的 research 文档移到 `docs/archive/`，并在 `docs/README.md` 建索引。
   - 这项改动一定要**请人类审阅**，因为 CLAUDE.md 会影响所有 Agent 的行为。

---

## 4. 执行顺序与依赖

```
第 1 批（可并行）：W2（IPC 类型）   W6（依赖统一）   W7（契约版本化）   W1-步骤1（仅盘点）
第 2 批：          W3（拆 runtime） ──► W4（应用服务层） ──► W5（统一缓存，依赖 W4 的 AppCtx）
第 3 批：          W1（步骤 2+，需批准）   W8（r2a 退役依赖 W4 的 findings 用例）   W9
```

- W2 可以先于 W4 进行：DTO 先放在桌面端 `dto/`，W4 时再上移到 app 层。
- W3 和 W2 改动的文件基本不重叠，可以并行，但**不要**同时开 W3 和 W4。

---

## 5. 通用验证命令（每个 PR 都要跑，结果贴进 PR）

```bash
cargo test
cargo clippy --release --all-targets -- -D warnings
python3 -m unittest discover tests
python3 tests/golden_runner.py
cargo build --release && AGENT_VITALS_BIN=target/release/agent-vitals python3 tests/golden_runner.py
(cd apps/desktop/ui-dev && npm run verify:react)
# 改动涉及桌面端时额外执行：
(cd apps/desktop/src-tauri && cargo tauri build --bundles app) && open apps/desktop/src-tauri/target/release/bundle/macos/agent-vitals.app
# 改动涉及 wasm 暴露面时额外执行：
(cd crates/agent-vitals-wasm && wasm-pack build --target web)
```

有任何一项跳过，要在 PR 里写明原因；不能写成「应该没问题」。

---

## 6. 需人类拍板的决策（执行 Agent 不得自行决定）

| 编号 | 问题 | 默认建议 | 阻塞的工作流 |
|---|---|---|---|
| D1 | ClawHub 是否停止分发 Python 的会话、成本、状态功能？是否需要弃用期？ | 停止分发；先发一个版本，在输出里带弃用提示 | W1 步骤 2+ |
| D2 | 桌面端并入根 workspace（方案 A）还是保持独立加 CI 比对（方案 B）？ | A | W6 步骤 2 |
| D3 | W4 发现 CLI 与桌面端对同一用例结果不同时，以哪边为准？ | 逐个用例上报，由人类判断 | W4 |
| D4 | CLAUDE.md 大幅精简是否接受？ | 接受，但由人类审阅 PR | W9 |

---

## 7. PR 描述模板

```markdown
## 工作流
W<n> — <标题>（本 PR 覆盖步骤 x–y）

## 改动
- 纯搬迁 commit：<hash 列表>
- 逻辑改动 commit：<hash 列表 + 一句话说明>

## 棘轮 / 指标
- <指标名>：基线 <a> → 本 PR <b>

## 验证
- [ ] cargo test / clippy
- [ ] python unittest / golden（Python + AGENT_VITALS_BIN）
- [ ] npm run verify:react
- [ ] .app 人工验证（如适用）：<看了什么>
- 跳过项及原因：<无 / …>

## 发现的问题 / 需人类决定
- <例如 W4 中 CLI 与桌面端结果不一致的用例>
```
