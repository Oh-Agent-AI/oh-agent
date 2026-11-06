# v1.0.0 Loop 日志完成项验证报告

> 验证日期：2026-09-12
> 验证对象：`docs/V1_0_0_LOOP_LOG.md` 声明的"已完成"功能
> 验证者：Claude Code（本机，只读复核；**未修改任何源文件、未提交、未 push**）
> 结论一句话：**日志本身诚实（只勾 4 项、明写不证明完整 FR），代码与单元测试基本到位；但"完整生效"有实质缺口——三条链路在真机上从未运行，一条核心功能达不到它自己写下的验收判据，另有一处静默截断使界面拿到的数据不是它显示的总数。**

---

## 1. 方法

| 项 | 值 |
|---|---|
| 分支 | `feat/v1.0.0-auto`，HEAD = `e337f16` |
| 工作树 | 2 处未提交改动（见 §5.2 / §5.3） |
| 代码复核 | 逐条 grep/read 日志点名的**函数、IPC、表、schema 版本**是否真实存在 |
| 真机复核 | 读 `~/.agent-vitals/` 的**副本**（`cp` 到 job tmp，含 `.sql-authority-enabled` 与 `machine.json`），不碰正在运行的库 |
| 未做 | 未改代码、未提交、未 push、未启动桌面 UI 点击 |

**副本口径提醒**：`data-status` 在只拷 db + `machine.json` 时会报 `sql_authority_enabled: false`；补拷 `.sql-authority-enabled` 后为 `true`。前者是沙盒缺文件的假象，本篇一律以补全后的读数为准。

---

## 2. 基线证据：三套测试

| 套件 | 命令 | 结果 |
|---|---|---|
| Rust workspace | `cargo test --release` | 26 suites，**1280 通过 / 1 失败 / 0 忽略** |
| desktop crate | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | **105 / 105 通过** |
| Python | `python3 -m unittest discover tests` | **1188 tests，OK，208 skipped，0 失败**（190.5s） |

唯一失败项与判定：

```
agent-vitals-runtime::lease::tests::stale_holder_release_does_not_steal_the_new_holders_lock
```

**单独复跑通过**（`finished in 0.06s`），**lease 模块串行复跑 7/7 通过**。判定为并行执行下的计时抖动，与 Loop 3 记录的同类现象一致（当时是 `drop_releases_the_lock_as_a_safety_net`），**非本轮回归**。

PRD 勾选状态与日志声明一致：**237 项可勾选，已勾 4 项**（REQ-034 / REQ-103 / REQ-144 / AC15）。

---

## 3. 真机上确认生效的项

全部经 `data-status` 或直接的 SQLite 只读查询在真机副本上取证。

| # | 声明（Loop） | 真机证据 | 判定 |
|---|---|---|---|
| 1 | schema 升级闸升至 v13（Loop 40 / 52） | `schema_meta.schema_version = 13`，`integrity = ok` | ✔ 生效 |
| 2 | 归因冲突清扫 + 干净重发关闭（Loop 47） | `data_quality_issues` 未解决数 = **0**（原 **16,951** 条 `invalid_fact`） | ✔ 生效 |
| 3 | Issue 时间单位归一为毫秒（Loop 77） | `issue_instances` 4,495 条中 `opened_at_ms < 1e11` 的 = **0**；日桶分布已是 2026-08/09 真实日期，**无 1970** | ✔ 生效 |
| 4 | Issue 自动关闭（Loop 82） | `issue_status_transitions` 75 行：**73 条 `legacy-finding@v0.11` / "not observed on re-evaluation"**、1 条 `reappeared`、1 条 `user@v1.0.0` | ✔ 真机跑通 |
| 5 | 50 个 Tauri IPC 注册 | `lib.rs:2373+` 全量清单与日志逐条对应 | ✔ 注册齐全 |
| 6 | 双预算 CLI / MCP 入口（Loop 55 / 56） | `budget-sql profiles` 返回结构化 DTO；MCP `tool_specs` 含 `budget_profiles` | ✔ 存在 |
| 7 | 保留期配置（Loop 43） | `facts/.authority-retention.json` 存在，`last_retention_date = 2026-09-12` | ✔ 生效 |

---

## 4. 未完整生效的项

### 4.1 【P0】L0 归并投影被静默截断，界面显示的总数不是它拿到的总数

**这是本轮最严重的一条，且日志与所有 Loop 均未记录。**

`issue_groups_with_sources` 是桌面 `sessions_issues` 实际调用的入口。它用 `usize::MAX` 明确表达"取全部行为组"：

```rust
// crates/agent-vitals-data/src/issues.rs:496
let behavior = issue_groups(conn, from_ms, to_ms, usize::MAX, None)?;
```

但 `issue_groups` 内部把 `page_size` **无条件夹紧到 500**：

```rust
// crates/agent-vitals-data/src/issues.rs:592
let end = (offset + page_size.clamp(1, 500)).min(values.len());
```

于是 `usize::MAX` 被静默降级为 500，**调用方"取全部"的意图失效**。真机实测（4,495 条 `issue_instances`）：

| 调用 | `total_groups` | 实际返回行数 |
|---|---|---|
| `issue_groups(…, usize::MAX, …)` | **786** | **500** |
| `issue_groups_with_sources(…, page_size=500, …)` | **503** | 500（`next_cursor = "500"`，第二页 3 行） |

三个后果，逐个都是缺陷：

1. **283 个行为组在进入合并投影前就已丢失**（786 → 500），未被任何计数记录；
2. **界面显示的总数是 503**（`store.rs:340` 的 `totals.issues = total_groups`；前端 `workbench.js:4058` 取值、`:4060` / `:4067` 渲染为"共 503 条发现"），而真实组数是 786 + 3 源组 —— **界面显示的数字既不等于真值，也不等于它自己渲染的行数**；
3. **`source_projection_count` 恒为 0**（`issues.rs:506` 用 `groups.len().saturating_sub(behavior.total_groups)` = 503 − 786 → 饱和减法 → 0），该字段在最需要它的时候失去意义。

**"未接分页"叠加放大**：`next_cursor` 确实回传到了前端（`store.rs:342`），但前端**从不消费 L0 的 `next_cursor`**——全仓对 `issue_groups_list`（能翻页的那个 IPC）**零调用**（仅 `lib.rs:2421` 注册、`store.rs:408` 定义）。真机上第二页那 3 组**永远点不到**。

**影响**：直接顶着 REQ-073 的字面要求。规格 `ISSUE_REQ073_PENDING_QUEUE.md` §3.4 要求 L0「30 天窗、每页 50」，§9.2 要求「展开任一组，能取回其全部原始命中」——现状是**无窗口、每页 500、无翻页、且总数不可信**。

**建议**：`issue_groups` 增加显式的"不限量"语义（例如 `Option<usize>` 或具名常量），不要靠 `clamp` 兜底；`sessions_issues` 改为透传窗口与分页；前端接上 L0 的 `next_cursor`，或直接改用 `issue_groups_list`。

### 4.2 【P1】`evidence_class` 取的是原始 evidence 而非 category，归并没达到它自己的验收判据

规格 §3.2.1 自设判据：

> 归并后的**组数应显著小于命中数**（预期数十组量级）；若归并后仍是数百组，说明对象归一化过细（N1/N4/N7/N8 未落实）。

真机实测 **4,495 条 → 786 组**（30 天窗 738 组）——正是规格预警的"数百组"。但根因不是对象归一化（N1–N10 经代码复核**均已正确落实**：`issue_group_key` → `issue_object` → `normalize_issue_object`，跨族/跨执行环境由 key 结构保证不合并），而是**漏做了"证据归类"这一步**：

```rust
// crates/agent-vitals-data/src/issues.rs:551-553（issue_groups）
let evidence_class = metadata.get("evidence").and_then(Value::as_str)
    .or_else(|| metadata.get("category").and_then(Value::as_str))
    .unwrap_or("<unknown>").to_string();
```

`metadata.evidence` 是**逐条不同的自由文本**，而 `metadata.category` 才是规格 §3.1 表格要的那个"类"。真机 `category` 只有 4 个干净值：

```
approval 2739 · sensitive-fs 1134 · shell 432 · trajectory 190
```

`evidence_class` 被这个原始文本撑开，成为组数的主要放大因子。反事实测算：

| 归并键 | 组数 |
|---|---|
| 现状（`rule\|harness\|object\|原始 evidence\|日桶`） | **786** |
| 改用 `category`（不叠日桶） | 340 |
| 改用 `category`（叠日桶） | 564 |

附带影响：真机 **1,160 / 4,495 条**的 `evidence` 是文件路径，它们经 `evidence_class` 进入 L0 DTO 并渲染到界面（`workbench.js:4102` 渲染 `category`、`:4222` 渲染 `evidence`）。**这是既有行为、非 Loop 引入**，但与 PRD 的隐私要求方向相反，改动时应一并处理。

**建议**：`evidence_class` 优先取 `metadata.category`（`evidence` 退为兜底），并按 §3.1 补齐 4 类映射的单测；同时评估组 DTO 是否应携带原始路径。

### 4.3 【证据缺口】计费重算 / 声明整条链路在真机上零足迹

```
billing_recalculation_jobs        0
billing_recalculation_results     0
billing_fact_attributions         0
billing_declarations              0
billing_declaration_revisions     0
billing_declaration_scopes        0
harness_bills                        0
```

Loop 14–33 的产物**代码在、单测过、schema 在**，但在真机上**一次都没有运行过**。这不是 bug，但意味着 REQ-143 / REQ-147 / REQ-148 / AC13 / AC27 目前**无法声称生效**——只有单测证据，没有端到端证据。日志在 Loop 42–47 多轮自认"独立验收未返回 verdict"，与此一致。

**建议**：在真机（或副本）上跑一次完整的「保存声明 → 影响预览 → 入队 → worker 执行 → 归因落库 → 汇总刷新」，把结果记为本项的真机证据。规格 `ISSUE_ATTRIBUTION_CONFLICT.md` §11 已提示应先做此步再做 UAT 第 3 条。

### 4.4 【证据缺口】双预算与账单录入从未被使用

- `budget_profiles = 0`，而 `budget_config = 1`（旧单币种：¥1/月、¥1/日、周 ¥180）——**用户仍走旧口径**，Loop 52–63 的双 profile 在真机上不体现；
- `harness_bills = 0`——账单录入（Loop 31–33）未使用；
- `billing_import_candidates = 3`——**这一条是真机有数据的**（Loop 7/8 的待确认候选），说明候选链路至少被真实触发过。

### 4.5 【已知】L2 详情真机未复验

Loop 84 自认：修复后 `.app` 重建安装，但 Computer Use 未重新取得可见工作台窗口，**L2 点击未复验**。Loop 83 的 UAT 记录为 `REQ-073 L2 walked ✘`。此项日志已诚实标注，此处仅确认仍处于未复验状态。

### 4.6 【卫生问题】`issue_groups_list` 是死接口

已注册（`lib.rs:2421`）、有实现（`store.rs:408`）、**无任何调用方**（前端、CLI、MCP 全部没有）。日志 Loop 79 把它列为"新增的 L0 入口"，实际 L0 走的是 `sessions_issues`。属未清理的重复面。

---

## 5. 分支与工作树状态（回答"主干"问题）

### 5.1 workbuddy **没有**合进 `main` 分支

| 引用 | 提交 | 含 workbuddy adapter？ | 含 v1.0.0 loop？ |
|---|---|---|---|
| `main`（本地） | `88ae4a7` | **否**（`git merge-base --is-ancestor feat/workbuddy-adapter main` → NO） | **否** |
| `origin/main` | `d9fe06e` | 否 | 否 |
| `feat/v1.0.0-auto`（当前 HEAD） | `e337f16` | **是**（`2acb515 merge(workbuddy): integrate adapter into v1.0.0`） | **是** |

- `HEAD` 领先 `origin/main` **219 个提交**，`main` 领先 `origin/main` **95 个提交**，两者**落后 0** ⇒ **远端什么都没有，全部未 push**。
- `docs/WORKBUDDY_ONBOARDING_SPEC.md` 在 `main` 上**根本不存在**（`fatal: path … exists on disk, but not in 'main'`）。

因此"workbuddy 已 merge 到主干"准确表述为：**已 merge 到 v1.0.0 这条开发主线**；git 分支 `main` 与 `origin/main` 都还没有。要真正落到主干，需要把 `feat/v1.0.0-auto` 合进 `main` 并 push——**本次未执行**。

### 5.2 【需处置】`docs/WORKBUDDY_ONBOARDING_SPEC.md` 被回退 519 行（未提交）

```
 HEAD 版本：970 行
工作树版本：451 行      ← 与任何一次提交都不匹配（逐提交 diff 全不命中）
```

被删掉的正是 E5/E6 的实测勘误（`used` 是上下文快照而非 processed 用量、零积分至少三种成因、`workbuddy.db` 是 WAL 别用 `immutable`），并把「三条均已在 Phase A 修复并 commit」改回「现在报错误的数字」。

**若提交，会抹掉已 merge 的文档成果。** 该文件不是本次验证产生的，我未做任何改动——建议先确认它是不是一次误写入，再决定丢弃或另行处置。

### 5.3 `apps/desktop/src-tauri/src/lib.rs` 有一处未提交增强

新增 `--show-workbench` 启动参数（`should_show_workbench_on_start`）及 1 个单测（desktop 现为 105 个测试，日志记的是 104）。逻辑无害，但**未提交、未记入日志**。

---

## 6. 复现步骤

```bash
# 基线
cargo test --release                                    # 1280 passed / 1 failed(抖动)
cargo test --release -p agent-vitals-runtime --lib lease:: -- --test-threads=1   # 7/7 通过
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml                     # 105/105
python3 -m unittest discover tests                      # 1188 OK / 208 skipped

# 真机（副本，只读）
SB="$TMPDIR/realcopy"; mkdir -p "$SB/facts"
cp ~/.agent-vitals/agent-vitals.sqlite3 ~/.agent-vitals/machine.json \
   ~/.agent-vitals/.sql-authority-enabled "$SB/"
AGENT_VITALS_HOME="$SB" ./target/release/agent-vitals data-status --json
AGENT_VITALS_HOME="$SB" ./target/release/agent-vitals budget-sql profiles

# 组数（§4.1/§4.2 的数字来自一次性探针，源码见附录 A）
```

无窗口 SQL 侧核对：

```sql
SELECT COUNT(*) FROM issue_instances;                                    -- 4495
SELECT COUNT(*) FROM issue_instances WHERE opened_at_ms < 100000000000;  -- 0
SELECT COUNT(*) FROM data_quality_issues WHERE resolved_at_ms IS NULL;   -- 0
SELECT COUNT(*) FROM issue_status_transitions;                           -- 75
```

---

## 7. 本次验证**不声称**的内容

- 不声称任何 PRD 条款可通过 —— 本次未勾选、也未建议勾选任何条目；
- 不声称 §3 之外的 Loop 全部正确 —— 未逐行复核全部 84 个 Loop 的实现细节，只验证了**日志点名的产物是否存在、真机是否有足迹**；
- 不声称桌面 UI 的实际渲染 —— 未启动应用点击，界面结论均由 `workbench.js` / `store.rs` 源码与数据层实测 DTO 推导；
- 未验证 workbuddy / hermes / pi 等新增执行环境在本机语料上的表现。

---

## 8. 建议的后续顺序

| 序 | 事项 | 理由 |
|---|---|---|
| 1 | 修 §4.1 的 `clamp` 静默截断 + 接上前端 L0 分页 | 唯一一条"界面数字与真实数据不一致"的缺陷，用户可见且违反 REQ-073 字面要求 |
| 2 | 修 §4.2 的 `evidence_class`（改取 `category`） | 让 REQ-073 P1 达到它自己写下的判据；改动小、有 4 类映射可直接落单测 |
| 3 | 处置 §5.2 的 spec 回退 | 未提交的破坏性改动，越早确认越安全 |
| 4 | 真机跑通 §4.3 的声明→重算闭环 | REQ-143/147/148 与 AC13/AC27 的真机证据唯一来源 |
| 5 | 决定 §5.1 的合并与 push | 219 个提交只存在于本机，无异地备份 |
| 6 | 清理 §4.6 死接口 / 补 §5.3 提交 | 卫生问题，可顺手 |

---

## 附录 A · 组数探针源码

一次性的独立 crate（`agent-vitals-data` 路径依赖 + `rusqlite` 只读连接），不写入本仓库：

```rust
use agent_vitals_data::issues;
fn main() {
    let path = std::env::args().nth(1).expect("db path");
    let conn = rusqlite::Connection::open_with_flags(
        &path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let raw = issues::issue_groups(&conn, None, None, usize::MAX, None).unwrap();
    println!("issue_groups(usize::MAX) total_groups={} returned={}",
        raw["total_groups"], raw["groups"].as_array().unwrap().len());
    let ui = issues::issue_groups_with_sources(&conn, None, None, 500, None).unwrap();
    println!("with_sources: total_groups={} rows={} next_cursor={}",
        ui["total_groups"], ui["groups"].as_array().unwrap().len(), ui["next_cursor"]);
}
```

真机输出：

```
issue_groups(usize::MAX)  total_groups=786 returned=500
issue_groups_with_sources(page_size=500):
   total_groups          = 503
   returned rows         = 500
   source_issue_count    = 4495
   source_projection_count = 0
   next_cursor           = "500"
   page2 returned rows   = 3
```
