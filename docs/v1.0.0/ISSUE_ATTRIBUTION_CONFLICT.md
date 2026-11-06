# 问题分析规格：`invalid_fact` / `attribution_conflict` 大量未解决（16,951 条）

> 状态：**待修**（分析完成，实测证据齐备；未改任何代码）
> 发现：2026-09-12，真机 UAT 侦察（`~/.agent-vitals`，schema 12，活跃事实 26,935）
> 影响阶段：**C（FR-07/FR-09 待处理与质量面）**、以及 A 的质量报告纪律（REQ-092/093）
> 关联纪律：REQ-083（冲突必须提示、不静默抹证据）、REQ-073（不以命中数冒充待办数）

---

## 1. 现象

`data-status` 在真机上报：

```
health: warn
open_quality_issues: 16951
open_quality_issues_by_code: { "invalid_fact": 16951 }
```

占活跃事实（26,935）的 **62.9%**，且 `resolved_at_ms IS NULL` 的解决数为 **0**。

## 2. 实测证据（2026-09-12，只读）

| # | 事实 | 值 |
|---|---|---|
| E1 | 冲突记录总数 | 16,951，全部 `code='invalid_fact'`，`scope_type='fact'`，severity=`warning` |
| E2 | scope_key 形态 | `attribution_conflict:<fact_id>` 单条一事实，**未归并** |
| E3 | 执行环境分布 | 全部为 `codex`（claude-code / dsh 各 0） |
| E4 | 存量归属（冲突侧） | 16,009 条 = `billing_mode=subscription, pricing_basis=session-provider, provider_id=openai, evidence_basis=session-native`；924 条 = `metered/metered_estimate, provider=NULL, evidence_basis=config-current`；18 条 = `metered/metered_estimate, provider=openai, evidence_basis=missing` |
| E5 | 版本字段 | 冲突侧与非冲突侧**都是** `attribution_version=provider-v0.11`、`normalization_version=provider-v0.11`（同版本，**不是版本升级**） |
| E6 | 时间 | `first_seen` 集中在 2026-09-10 03:22–03:30；`last_seen` 延伸至 2026-09-11 10:43 |
| E7 | 读面是否受污染 | **否**。2026-07/08/09 三个月 `data coverage` 的 codex 均显示 `metered_estimate`（`amounts_by_basis` 单一），`total_summable` 正确排除估算 |
| E8 | 重放工具自报 | `force-codex-provider-replay` 的报告体内含 `conflict_count` 字段（`apps/cli/src/main.rs:3683` `conflict_count` 查询、3700 报告字段）——即该工具**预期**产出冲突计数 |
| E9 | 质量码分布 | 全库仅此一个码，无其他 `data_quality_issues` |

## 3. 根因

**代码位置**：`crates/agent-vitals-data/src/fact_writer_sql.rs:460-505`（判据 461-490、记录 499-506）

重放/重发时，同一 `fact_id` 的 INSERT 影响行数 `n == 0`（已存在），随后：

```rust
// 9 个字段：provider_id, provider_raw, billing_source, billing_mode,
//           pricing_basis, evidence_basis, normalization_version,
//           route_evidence_id, attribution_version
Ok(existing.iter().zip(incoming.iter())
    .any(|(old, new)| old.is_some() && new.is_some() && old != new))
```

任一两边非空且不同 → `write_rejected("attribution_conflict:<fact_id>", …)` 记一条**开放**质量问题；
紧接着的 UPDATE 只做 `COALESCE(col, incoming)`——**只补空，从不覆盖已有值**。

三个缺陷叠加成当前现象：

1. **判据把「重分类」当成了「冲突」**。v1.0.0 的「公共价目不得替用户声明订阅」改动把 codex 的
   归属从 `session-native / subscription` 改为 `metered_estimate`（见 `summary.rs` 的
   `BillingMode::Unknown => (MeteredEstimate, true)`）。同一批 rollout 重放时算出新值，与存量不同
   → 逐条记冲突。这是**同源重算的版本性重分类**，不是两个独立证据源的对立。
2. **版本字段语义被反转**。`attribution_version` / `normalization_version` 是**来源标记**，
   却被放进了「有差异就算冲突」的集合里。后果：**未来任何一次归因版本升级（例：provider-v0.12）
   会把库里每一条事实都判成冲突**——这是一颗定时炸弹，比本次 16,951 条严重得多。
3. **不可变语义与陈旧值并存且无出口**。COALESCE 不覆盖 → 存量永久停留在旧 basis；
   冲突记录每次重发都重新计数（`ON CONFLICT DO UPDATE last_seen_at_ms`）→ **永不解决**。

## 4. 影响面

| 面 | 影响 | 严重度 |
|---|---|---|
| 金额读面（总览/日历/会话/CLI/MCP） | **不受影响**（读路径按 `billing_modes` 声明重算 basis，不读存量列；E7 已证） | — |
| `data-status` health | 永久 `warn`；质量摘要被单一噪声码占满 | 中 |
| **FR-09 待处理（C 阶段待建）** | 若不归并，一建页即 **16,951 条待办**——正撞 REQ-073「不以 3900 次命中冒充 3900 件待办」 | **高** |
| REQ-092/093 质量/覆盖报告 | 质量覆盖数字被该码主导，掩盖真问题 | 中 |
| 逐 fact 下钻（会话详情） | 存量 basis 陈旧（`session-provider`），与聚合面的 `metered_estimate` **同窗不同口径**——UAT 第 3 条（确认计费方式）会撞见 | 中 |
| 未来归因版本升级 | 缺陷 2 会让**全库**事实变成冲突 | **高（潜在）** |

## 5. 必须同时满足的不变式（冲突面）

修复不得以牺牲下列任何一条为代价：

- **I1 事实身份不可变**：`fact_id`、`source_event_id`、`native_session_id`、`event_ts_ms` 与四桶 token
  **永不改写**；重放前后 token 守恒（`force-codex-provider-replay` 已有守恒自检，须保留）。
- **I2 真冲突必须浮现（REQ-083）**：当**两个独立证据源**对同一事实给出不同归属时，必须提示冲突、
  可预览受影响记录，**不得静默抹掉证据**。
- **I3 幂等**：同一重放执行任意次，结果与冲突集合收敛一致。
- **I4 读面不依赖存量归属列**：聚合口径只由声明/价卡算出；此性质当前成立（E7），须以测试钉住，
  因为它是"存量可以陈旧"这一选择成立的前提。
- **I5 质量面无噪声**：质量摘要/健康判定/待处理队列只承载可行动问题（REQ-073）。

## 6. 方案对比

| 方案 | 内容 | 利 | 弊 |
|---|---|---|---|
| **A. 只清扫** | 一次性把 16,951 条标 resolved | 改动最小 | 缺陷 1/2 仍在，下次重放再长；不解决陈旧 basis |
| **B. 只降级** | 把该码从 health/待办面排除 | 面上立刻干净 | 违反 I2（真冲突也被一并吞掉） |
| **C. 分离判据 + 版本门控重分类**（**推荐**） | ①版本字段移出「差异」集合，改作判据；②同版本不同值 ⇒ 真冲突（记开放问题）；③**异版本** ⇒ 重分类：允许覆写归属列（仅那 9 列中的派生列），记一条 informational 事件而非开放问题 | 治本；同时消掉定时炸弹（缺陷 2）；I1–I5 全满足；顺带让存量 basis 收敛，消除 UAT 第 3 条的隐患 | 需要一次回填；须为「覆写」划定严格边界 |

## 7. 选定规格（方案 C）

### 7.1 判据重写（`fact_writer_sql.rs`）

```
重放命中同 fact_id 时：
  if incoming.attribution_version != stored.attribution_version
     or incoming.normalization_version != stored.normalization_version:
        → 归类「重分类（reclassification）」：幂等覆写 9 个归属列中的派生列
          （provider_id/provider_raw/billing_source/billing_mode/pricing_basis/
            evidence_basis/route_evidence_id + 两个 version 列），
          并写一条 **informational** 记录（不进 open issue、不进待办）；
  else if 其余 7 个证据字段中任一「两边非空且不同」:
        → 归类「冲突（conflict）」：维持现状——记 open 问题，
          沿用 COALESCE 不覆写（REQ-083：不静默抹证据）；
  else:
        → 幂等补齐空列（现行 COALESCE 行为），不记任何记录。
```

关键点：**版本字段只作判据，不作差异项**——消除"版本升级 = 全库冲突"的定时炸弹。

### 7.2 覆写的边界（硬约束）

- 只允许覆写 9 个**归属/派生**列；`fact_id`/`source_event_id`/`native_session_id`/`event_ts_ms`/
  `observation_kind`/四桶 token/`source_id`/`ingested_run_id` **一律不动**。
- 覆写必须与 token 守恒自检同事务（沿用 `force-codex-provider-replay` 的守恒断言）。
- `usage_facts` 的 `UNIQUE(harness, machine_namespace, native_session_id, source_event_id,
  observation_kind)` 不受影响（键未变）。

### 7.3 回填（一次，幂等）

对现有 16,951 条：

- 因 E5 显示两侧**同版本**（`provider-v0.11`）→ 走 7.1 的 **conflict** 分支。但要注意：这批是
  **同版本下的重算差异**，说明 `provider-v0.11` 标签下代码发生过语义变更。回填策略：
  以「当前代码重算的归属」为权威，**一次性重分类**并把对应 open 记录标 `resolved`
  （理由：同源重算、非竞争证据），同时写一条表级说明（`schema_meta` 或 quality 的 informational 事件）。
- 回填后 `open_quality_issues` 中该码应为 **0**；`data-status` health 回到非 warn（若为唯一原因）。

### 7.3.1 存量清扫入口 —— **已实现（2026-09-12）**

**缺口**：修复后 writer 只在「版本差异 ⇒ 重分类」分支里关闭冲突；**干净重发（本次与
存量一致）这条路径没有出口**，于是由陈旧二进制产生的残留冲突永远开着——真机 306 条
只能手工 SQL 清。

**实现**（`crates/agent-vitals-data/src/fact_writer_sql.rs`，`else` 分支内）：

```rust
} else {                       // 非重分类：本版本内比对
    if attribution_conflict {
        self.write_rejected(...)?;          // 真冲突：仍然记
    } else {
        // 干净重发：本次与存量一致 → 此前记录的冲突已不可复现，关闭它。
        // 真冲突走上面的分支，不会被这里误关（REQ-083 不静默抹证据）。幂等。
        UPDATE data_quality_issues SET resolved_at_ms = ?now
          WHERE scope_key = ?scope_key AND resolved_at_ms IS NULL
    }
```

**回归**：`clean_reemit_resolves_a_stale_conflict`（先造遗留开放冲突 → 干净重发 →
断言已 resolved 且**记录保留非删除**）。相邻测试
`same_attribution_version_with_conflicting_evidence_stays_open` 继续看守真冲突不被误关。

**孤儿情形**（源 rollout 已被轮转 → 永不再重发）：不需专门清扫——待处理页默认 30 天
窗口会让它自然淡出，且**不删除**（REQ-083）。

### 7.4 面（surface）纪律

- `open_quality_issues_by_code` 与待处理队列：若未来仍出现真冲突，**按执行环境/provider/模式归并**
  （REQ-073），不得一条一待办。
- informational 记录不得计入 `health`。

## 8. 实施分解（供循环分包）

| 包 | 内容 | 交付 |
|---|---|---|
| 8.1 | 7.1 判据重写 + 单测（同版本不同值⇒冲突；异版本⇒重分类且不记 open；版本字段不参与差异） | `fact_writer_sql.rs` + 回归 |
| 8.2 | 7.2 覆写白名单 + 守恒断言同事务 | 同上 |
| 8.3 | 7.3 回填命令（幂等、可重跑、报告前后计数） | CLI 子命令 + 真机演练 |
| 8.4 | 7.4 面归并 + informational 不计 health | 质量面板/待处理 |
| 8.5 | I4 钉住：**读面不读存量归属列**的测试 | 测试 |

## 9. 验收

1. 真机回填后：`data-status` 的 `open_quality_issues` 该码 = 0；health 不再因它 warn。
2. 造一次**版本升级**重放（`attribution_version` 改 `provider-v0.12`）→ 断言**不产生**任何 open 冲突、
   token 守恒、身份列未变（这直接验证缺陷 2 已修）。
3. 造一次**同版本异证据**（人为改一条 `route_evidence_id`）→ 断言**产生** open 冲突（I2 不破）。
4. 重放幂等：连跑三次，冲突集合与事实集合收敛一致。
5. I4 测试：聚合读路径不引用 `usage_facts.pricing_basis/billing_mode` 存量列。
6. 回填前后 `usage_facts` 的 fact_id 集合与四桶总量逐位不变。

### 9.1 「假版本升级重放」真机演练 —— **已执行（2026-09-12）**

单测只覆盖 writer 判据；本节演练覆盖**整条链**：emitter 真会盖新版本号 → 同步管线传递
→ 无其他组件因此报错。

**方法**（零风险，不碰真机库、不碰飞行中的工作树）：

1. `git worktree add <tmp> HEAD`（独立副本）
2. `usage_fact.rs` 的 `provider-v0.12` → **`v0.13`**（2 处：normalization / attribution）
3. 独立 target 目录构建 release CLI
4. 复制真机 data home → 沙盒（db + machine.json + facts）
5. `AGENT_VITALS_HOME=<沙盒> <演练CLI> data replay-provider-evidence --harness codex`

**结果（四条断言全过）**：

| 断言 | 结果 |
|---|---|
| 不产生新冲突 | `conflict_count = 0` |
| 无开放残留 | 开放 `attribution_conflict` = **0** |
| 事实不可变（I1） | 共存事实 27,569 条，token/身份列**改动 0** |
| 归属收敛 | codex 全部 → **`provider-v0.13`**（含此前 8 条 v0.11 残留，一并收敛） |
| 总量可解释 | 四桶差 15,366,423 = 演练新增 40 条贡献 15,366,423（**逐位相等**） |
| integrity | ok |

**真机未被触碰**：演练前后真机始终 `v0.12`（21,551 条）+ 8 条 v0.11 残留，开放质量问题 0。

**结论**：缺陷 2（版本升级 ⇒ 全库误判冲突）已从「单测覆盖」升级为「整链实测通过」——
定时炸弹拆除有真机级证据。

## 10. 明确不做

- 不改四桶 token、fact_id 或任何身份列（I1）。
- 不把真冲突降级吞掉（I2）——方案 B 单独使用被否。
- 不改 `billing_modes` 声明语义（REQ-103 的"公共价目不含个人订阅"已成立，E4/E7 可证）。
- 不因本问题触碰 WorkBuddy 相关代码或分支。

## 11. 与 UAT 的关系

- UAT 第 3 条（确认计费方式 → AC27）**建议在本问题修复后执行**：否则确认后的重算会同时面对
  陈旧存量 basis 与 1.7 万条开放质量记录，观察结果不可归因。
- UAT 第 7 条（重算失败恢复）已通过数据侧检查（`sync_runs` 无悬挂、integrity ok）。
