# 审计：v0.9 数据面迭代 Stage A–C（完成度核对 + 代码审计，2026-09-06）

- **审计对象**：v0.9 数据面三阶段的最终代码状态——`457ee7f`（R3→R4 文档）…
  `d18c57a`（Stage C 收口标注），共 18 笔提交，其中代码主体为 Stage A
  `93fbc0d`/`f1850bc`/`0f1d6b5`/`dc0701b`、Stage B `2d32ed0`/`6b3aadd`/`d90a234`/
  `9fbf920`/`7b76c8f`、Stage C `3ffe10f`/`c5841f4` 及各自文档同步。
- **方法**：完成度按规格 §0.2 状态表与 §8 DoD 逐条对照实码；代码审计对
  Stage A–C 新增/改动的 ~3.4k 行逐文件精读（`agent-vitals-data` 全部、
  `agent-vitals-runtime` 的 lease/ingest/export/summary/state、CLI data-*
  接线、emitter 归位 diff），每条 finding 追到具体行号与触发条件才定性。
- **gate 实测（全部本审计实跑，非引用既有记录）**：
  - `cargo test` 全 crate 通过（binary 313 / domain 431+ / harnesses 56+ /
    vitals-core 53+，exit 0）；
  - `cargo clippy --release --all-targets -- -D warnings` exit 0；
  - `AGENT_VITALS_BIN=<release 二进制> python3 tests/golden_runner.py`
    ——15/15 逐字节一致；
  - usage-fact 三执行环境差分 `tests.test_{claude,codex,dsh}_usage_fact`
    ——55/55 通过；
  - `AGENT_VITALS_BIN=… python3 -m unittest discover tests`
    ——**1164 项通过（skipped=4，为无 hypothesis 环境的可选项）**，与
    Stage C 文档声称的 1164 吻合。不带 `AGENT_VITALS_BIN` 时该套件
    skipped=234——差分面在未指定二进制时静默跳过，复现验证时须注意。
- **结论先行**：三阶段主体真实落地，文档标注诚实（🔶/❌ 未虚报）；测试面
  全绿且差分回路闭合。审计发现 **1 条 CONFIRMED P1（lease 释放竞态）+
  1 条 P2（retention 失败不可观测，注释与行为不符）+ 2 条 P3**，均给出修法；
  另有 4 条非缺陷观察记录在案。

---

## 0. 完成度核对（规格 §0.2 / §7 / §8 DoD 对照实码）

### 0.1 已落地并经本次审计验证的交付物

| 交付物 | 落点 | 审计验证方式 |
|---|---|---|
| UsageFact append-only writer：fact_id exactly-once、崩溃尾面**修复**（半行截断/缺封口补 `\n`）、中间坏行拒绝 | `agent-vitals-data/src/evidence.rs` | 精读 + 4 个尾面/去重测试核对 |
| emitter 归位执行环境 sources 层（行级原语下沉纯层，CLI re-export） | `agent-vitals-harnesses/harnesses/<h>/sources/usage_fact.rs` + `claude_code/sessions/usage.rs` + `dsh/sessions/header.rs` | diff 确认为纯搬迁 + re-export；parity 55/55 |
| Runtime ingest service：封闭执行环境词表、按事实 harness 分组落盘、写后重放自检、lease 接线 | `agent-vitals-runtime/src/ingest_service.rs` | 精读 + 8 项单测 |
| SQLite 可重建索引：fact_id 主键、版本迁移=整库重建、损坏自愈、事务回滚防假零 | `agent-vitals-data/src/store.rs` | 精读 + 7 项单测（含删库/损坏/回滚） |
| writer lease：O_EXCL + **原子 rename 陈旧偷取**（unlink+create 的无主窗口缺陷已修并有测试钉住） | `agent-vitals-runtime/src/lease.rs` | 精读（发现 #1，见下） |
| data-reconcile：索引 vs DTO 逐执行环境三态（measured/no-facts/index-only）、同月窗对月窗（P1-3 已修） | `ingest_service.rs::reconcile_index_vs_dto` + `store.rs::tokens_by_harness(month)` | 精读 + 单测 |
| data-unresolved：逐模型四类原因下钻（codex 两层 by_model 形状 P1-1 已修） | `summary.rs::unresolved_detail` + `codex_unresolved_rows` | 精读 + 形状钉测 |
| 保留滚动：13 个自然月（cutoff = current − 12，fencepost 钉死）、无日期行保留、幂等 | `evidence.rs::retain` + `ingest_service.rs::enforce_retention` + `month_shift` | 精读 + fencepost/跨年/0 钳制单测（发现 #2，见下） |
| 脱敏导出双路径：四身份字段 fnv1a64 伪名化 + fact_id 契约层重 stamp | `agent-vitals-runtime/src/export.rs` | 精读（发现 #3，见下） |
| 订阅摊销：FixedSubscription 写入方、账期过滤、零用量补建、只进月不进日、币种冲突冻结 | `summary.rs::apply_subscription_fees` + `ProviderAcc` | 精读 + Stage B/C 回归测试 |
| CLI data-* 五命令：rebuild-index / reconcile / unresolved / export-private / export-redacted | `apps/cli/src/main.rs:2042-2171` | 精读接线 |

### 0.2 DoD 记分（§8 八条，R4 标注核对）

| # | 条款 | 标注 | 审计核对 |
|---|---|---|---|
| 1 | 删 SQLite 后可由事实文件重建等价 projection | ✅ | ✅ 属实（`open_or_rebuild` + 删库/损坏自愈测试） |
| 2 | 各提交点故障注入不双计不漏计 | 🔶 | ✅ 属实：facts/projection/lease 三点有注入测试；intent/manifest 未实现且**如实未声称** |
| 3 | 双进程遵守同一 writer lease | ✅ | ✅ 属实（发现 #1 是该机制内的残余竞态，非标注失实） |
| 4 | 每月成本五档分离且可下钻 | ✅ | ✅ 属实 |
| 5 | coverage 不把未知伪装成零 | 🔶 | ✅ 属实（字段级已钉，投影层待完整化） |
| 6 | CLI/Tauri/HTML 同一 DTO | ✅ | ✅ 保持 |
| 7 | Python/Rust byte-parity、Python 无新 writer | ✅ | ✅ 属实（1164 + golden 15/15 实测）；`--write` 为 Rust-only 且 flag 关闭时 payload 与 Python 字节相等 |
| 8 | v0.10 数据可只依赖本版事实与 projection | ❌ | ✅ 标注诚实：依赖 §0.3 遗留项 |

### 0.3 遗留项（文档已如实标注，非本次审计新发现）

- checkpoint / sync_service（连带 §7.1 watcher 门槛未触发）；
- generation transaction（intent → manifest）与 `HarnessBillRecord`（待 WorkBuddy 范围确认）；
- CanonicalSession snapshot writer（Stage A 记录的剩余项）；
- coverage projection 完整化（DoD #5 后半）；
- 四项数据缺口等用户输入（中转 cache_read 单价 / GLM 价卡 / ChatGPT Plus 月费 / 汇率）——非工程阻塞。

**总评：v0.9 数据面迭代按其自身 DoD 口径为「三阶段完成、6/8 达成、2 部分达成、
1 依赖遗留」，文档状态表与实码一致，没有发现虚报达成的地方。**

---

## 共 4 条 CONFIRMED，按严重度排序。

---

## #1（最高）lease 释放不校验归属——TTL 超时被偷后，原持有者的释放会删掉新持有者的锁 → 双持锁

- **位置**：`crates/agent-vitals-runtime/src/lease.rs:181-185`（`release()`）、
  `:192-196`（`Drop`）。
- **事实**：两个释放路径都无条件 `std::fs::remove_file(&self.path)`，不读锁文件
  内容校验「这把锁还是不是我的」。而偷取路径（`:125-146`）允许任何进程在 TTL
  过期后 rename 走旧锁并 `create_new` 一把新锁到同一路径。于是存在这个序列：
  1. 进程 A 持锁进入临界区，耗时超过 TTL（`ingest`/`rebuild` 的 TTL 60s 正是按
     「最坏重建时长」设计的——重建逼近 60s 是规格预期的形态，不是异常）；
  2. 进程 B 判定锁陈旧，rename 偷走，create_new 成功 → B 是唯一合法持有者；
  3. A 的临界区结束，`release()`（或 Drop 兜底）删除 `path` ——**删掉的是 B 的锁**；
  4. 进程 C `acquire` 成功 → B 与 C 同时认为自己持锁，互斥破产（DoD #3 的核心保障）。
- **后果**：互斥失效的具体后果取决于临界区——`facts-ingest` 锁内含 JSONL 尾面
  截断/封口与索引写入，双持有者并发 truncate 是 Stage B 审查 P1-2 修掉的同款
  破坏面（「写坏文件」）；`state-write` 锁内是 month.json 读改写序列，双持有者
  即三倍计数事故的进程间版本复发。触发前提是「临界区超过 TTL」，设计文档
  （模块头）用「临界区必须短」的纪律压它，但 **TTL 60s 的 ingest 锁自己声明了
  临界区可以到秒级**——纪律与参数在同一个模块里自相矛盾，且该场景无测试。
- **修法**：`release()` 前读锁 JSON，`holder` + `pid` 匹配自身才删（不匹配 =
  锁已易主，如实静默放弃——TTL 兜底语义不变）；Drop 同样校验。实现上与现有
  body 写入对称，不引入新依赖；补一条「TTL 过期被偷后，原持有者释放不删新锁」
  的测试。

## #2（高）retention 失败被静默吞掉——`RebuildOutcome` 文档谎称「错误已上 stderr」，操作者不可观测

- **位置**：`crates/agent-vitals-runtime/src/ingest_service.rs:378`
  （`let retention = enforce_retention(...).ok();`）；`:385-394`
  （`RebuildOutcome` 的 doc 注释）；消费方 `apps/cli/src/main.rs:2070-2077`。
- **事实**：`rebuild_index` 在锁内执行保留滚动，失败时 `.ok()` 把错误整个丢弃，
  `retention` 落 `None`。但 `RebuildOutcome` 的文档写的是「None = ……或
  retention 失败（**错误已上 stderr**）」——实际没有任何 stderr 输出；CLI 渲染
  只在 `Some(ret)` 时打印 retention 行。调用方拿到的 `None` 无法区分
  「权威里没有需要滚动的执行环境文件」与「滚动失败」。
- **后果**：这条注释自称是审查 P2 的修复（「丢掉报告 = 滚动对操作者不可观测」），
  而修复本身恰恰还留着一个不可观测口：I/O 类失败（权限、磁盘满）下，用户以为
  保留滚动做了，实际一条没删——`retain` 是对权威 JSONL 的**不可逆重写**，
  它的失败面必须可见。与本仓 `unaccounted_usage`/`RebuildReport` 如实上呈的
  惯例不符。
- **修法**：`RebuildOutcome.retention` 改为 `Result<Value, String>` 的枚举
  （或加 `retention_error: Option<String>` 字段），CLI 对失败路径 eprintln；
  或者最小修：`rebuild_index` 里 `.map_err(|e| eprintln!("retention failed: {e}"))` 后
  再 `.ok()`，并同步改正 doc 注释。两案都须把「None 的两种含义」从文档里删掉。

## #3（低）export 双路径不拿 ingest lease——与 reconcile 的加锁纪律不一致

- **位置**：`crates/agent-vitals-runtime/src/export.rs:22`（`export_private`）、
  `:47`（`export_redacted`）；对照 `ingest_service.rs:260-266`
  （`reconcile_index_vs_dto` 拿 `.ingest.lock`）。
- **事实**：reconcile 对同一份权威数据读之前先拿锁（注释：「并发 rebuild 会把
  读侧甩到孤儿 inode」），export 两函数却无锁直读。并发 ingest 的尾面修复
  （truncate）或 append 进行中时：导出**不会损坏**（rename 原子、`replay` 对尾
  半行按 Truncate 报告、`export_private` 是单次整体 read），但 redacted 导出可能
  静默漏掉一条正在写入的尾行，私有导出可能拿到一个非原子截面——两个导出件
  之间可能互不一致。
- **后果**：低——导出是人工诊断动作，非账目路径；且 exactly-once 重跑可自愈。
  但同一模块树里「读权威前拿锁」已经是一条成文纪律，只差 reconcile 一处执行。
- **修法**：两个 export 函数开头各加一把同路径同 TTL 的 `acquire_blocking`
  （持有者名 `facts-export`），或文档里明写「导出允许读到近似截面」的取舍。

## #4（低）文档卫生：权威词表文档的旧版残留 + repo layout 缺新 crate

- **位置**：
  - 工作区未跟踪文件 `docs/ATTRIBUTABLE_WASTE_副本.md`——与正本 diff 确认是
    **旧版**：缺 §6.7（名义成本口径，2026-09-05 新增）整节 61 行。CLAUDE.md
    指定该文件为成本词表「权威定义」，仓库里同时存在一份缺最新口径的副本，
    被误读的概率不低；
  - `CLAUDE.md`「Repo layout」节未列 `crates/agent-vitals-data`——该 crate 是
    v0.9 Stage A 新增的 writer/store/billing 本体（workspace members 里有），
    单一事实源文档已经漂移。
- **修法**：删除副本文件；CLAUDE.md 补一行 crate 条目（含「权威 JSONL 在此、
  SQLite 只是可丢弃投影」的职责说明）。

---

## 5. 非缺陷观察（记录在案，不需动作）

1. **`store.rs::insert_fact` 对同 fact_id 不同内容静默 IGNORE（首个胜出）**
   （`:298-321`）。fact_id 由六身份字段哈希决定，token 修正类重 emit（同身份、
   新桶值）会被索引层吞掉。当前 writer 侧 exactly-once 使该形状在单文件内
   不可达（同 fact_id 的第二行写不进 JSONL），属已知设计面；若未来出现
   「修正重报」需求，须先改契约层身份定义，不能只动索引层。
2. **`store.rs::facts_page` 的 `unwrap_or(Value::Null)`**（`:410`）：raw 列来源
   是 `fact.to_string()`，反序列化失败实际不可达；静默回退可接受。
3. **`evidence.rs::retain` 的 tmp 文件**（`.facts.retain-tmp.<pid>`，`:211-215`）
   crash 残留不清理——无害垃圾，同目录下次 retain 也不会撞名。
4. **`ingest_service.rs::reconcile_index_vs_dto` 的 `(Some(0), Some(0))` 分支**
   （`:293`）与下一分支 `(a != b)` 语义重复——可折叠，纯可读性小节。

## 6. 审计确认过的强面（逐条有测试背书）

- 尾面修复的「牙」测试：修复后 append 必须真实可读（旧实现「只容忍不修复」
  导致 e2 被吞而测试假绿的回归被钉死）——`evidence.rs:454-494`；
- 原子 rename 偷取 + 新鲜 unreadable 锁不可偷（P1-2 双持锁缺陷的修复）——
  `lease.rs:250-265`；
- rebuild 事务回滚防「空索引装健康」假零——`store.rs:553-580`；
- 月窗对账（P1-3：同月窗对同月窗）——`store.rs:527-550`；
- 保留滚动 fencepost（−12 不是 −13）+ 跨年 + 0 钳制——`ingest_service.rs:428-436`；
- 币种冲突冻结（审查 #8：冲突后不再重新认领，防另一币被单币桶吞）——
  `summary.rs:465-487`；
- 四身份字段伪名化（含 P1 补的 `source_event_id`）+ 稳定性——`export.rs` 测试；
- 订阅摊销三条纪律（零用量补建 / 账期过滤 / 只进月不进日）——`summary.rs` 三测试。

---

## 7. 修复优先级建议

1. **先修 #1**（lease release 校验归属）——它是 DoD #3 机制内的真竞态，修法
   小且独立，测试好写；
2. **#2 随手修**（一行 eprintln + 注释更正）；
3. #3、#4 可并入下一次数据面维护批次；
4. 修完 #1/#2 后跑全量 gate（含 `AGENT_VITALS_BIN` 差分）确认零漂移。

> 本文档独立成文、独立提交（先例：`CODE_REVIEW_V0_9_STAGE_A_D_KPI_BILLING` /
> `CODE_REVIEW_V0_9_WORKBENCH_UX`）。finding 均为 CONFIRMED——每条都追到
> 行号与可复现的触发序列，无 PLAUSIBLE 存疑项。
