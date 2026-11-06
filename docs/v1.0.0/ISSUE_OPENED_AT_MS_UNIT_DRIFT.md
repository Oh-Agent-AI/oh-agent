# 问题分析规格：`issue_instances.opened_at_ms` 单位随执行环境分化（秒 vs 毫秒）

> 状态：**待修**（分析完成，真机证据齐备；未改任何代码）
> 发现：2026-09-12，验证 REQ-073 P1 归并层（`issue_groups`）时顺带发现
> 影响阶段：**C（FR-09 待处理，REQ-073 的「时间范围」维度）**
> 关联纪律：REQ-073（四维归并含时间范围）、REQ-077（状态机）；仓库既有纪律「整数纪元一律以毫秒为契约」（参见 `TestWorkbuddyIntegerEpochMsTimestamps` 同类回归）

---

## 1. 现象

`issue_groups()`（P1 归并层）按 `(问题族, 执行环境, 对象, 证据类, **日桶**)` 归并，其中日桶
由 `opened_at_ms` 算出。真机上：

- **1,542 / 4,450（34.7%）的实例被归入日桶 `1970-01-22`**；
- 这些实例的**真实日期在 2026-08 至 2026-09 之间**。

即：三分之一的待处理项在 UI 上会显示半个世纪前的日期，且**不同真实日期的实例被错误
合并进同一个时间桶**——REQ-073 的「时间范围」维度对这部分数据完全失真。

## 2. 实测证据

**E1 单位按执行环境分化**（真机 4,450 条 `issue_instances`）：

| 执行环境 | `metadata.time` 单位 | 条数 | 样本（值 → 按该单位解读） |
|---|---|---|---|
| `claude-code` | **秒** | 1,527 | `1788651641` → 2026-09-06 ✓ |
| `codex` | 秒 | 15 | — |
| `dsh` | **毫秒** | 156 | `1789005842115` → 2026-09-10 ✓ |
| `codex` | `None`（走兜底） | 2,752 | 兜底用 `now_ms()` → 毫秒 ✓ |

**E2 两列同源**：`opened_at_ms` 与 `metadata.time` 逐条同值（秒级行的两列都是秒），
证明前者是从后者原样抄来的。

**E3 兜底路径是对的**：`metadata.time = None` 的 2,752 条走
`now_ms()` 兜底 → 毫秒，日桶正确。**缺陷只在"有 time 且 time 是秒"的 1,542 条**。

**E4 受影响规则**（秒级按规则分布）：SV605 1045 · SV601 366 · SV611 46 · SV613 30 ·
SV603 19 · SV602 18 · SV604 18（覆盖 7 个规则族，非个别规则的问题）。

## 3. 根因

**写入点**：`crates/agent-vitals-runtime/src/sessions/r2a_store.rs:1668`

```rust
opened_at_ms: finding.time.unwrap_or_else(crate::sql_sync::now_ms),
```

`finding.time` 的单位**随执行环境 findings 层而变**，而这里原样写入一个名字带 `_ms` 的列
（`crates/agent-vitals-data/src/issues.rs:21 pub opened_at_ms: i64`）。

**上游**：`finding.time` 来自行为时间线的条目时间
（`crates/agent-vitals-domain/src/domain/behavior.rs:466` 的 `"time": to_json(entry.time)`），
而 `entry.time` 由**各执行环境适配器**在构造 canonical 时间线时填入——**各执行环境各自决定单位**，
没有任何一层统一。解析链：

```
执行环境适配器填 entry.time ──► behavior.rs:466 原样进 finding.time
   ──► r2a_store.rs:409 读取 ──► r2a_store.rs:1649 原样进 metadata.time
   ──► r2a_store.rs:1668 原样进 opened_at_ms ──► issues.rs:249 日桶（按 ms 解释）
```

**下游后果**（`crates/agent-vitals-data/src/issues.rs:249`）：

```rust
fn issue_day_bucket(opened_at_ms: i64) -> String {
    civil_date_from_days((opened_at_ms + BEIJING_OFFSET_MS).div_euclid(DAY_MS))
}
```

秒级值（≈1.79e9）除以 8.64e7 得 ≈20 天 → **1970-01-21/22**。

**另一处后果：时间窗静默排除**。`issue_groups(conn, from_ms, to_ms, …)` 的窗口过滤直接
比较数值——秒级值（1.79e9）恒小于任何毫秒级下界，因此**在 30 天视图里这 1,542 条会被
整体排除，且不报错**。这比显示错误日期更危险：用户看到的是"没有待处理项"。

## 4. 已排除的同源嫌疑（避免误修）

`crates/agent-vitals-runtime/src/sessions/r2a_store.rs:297` 的文档注释声称
`date_span = requests[].time（epoch 毫秒）`，并在 `dsh_extract_summary` 里做
`civil_from_unix_secs(ms / 1000, 0)`。**已核实这不是缺陷**：

- 该函数是 **DSH 专用**（`dsh_extract_summary`），而 DSH 的 `time` **确实是毫秒**（E1）；
- 它对毫秒值做 `/1000` 再转秒是**正确**的。

**结论**：`date_span` 无需改动；**不要**为了"统一"去动它，否则会把本来正确的 DSH 日期算错。

## 5. 规格（修复）

### 5.1 边界归一（必做，窄而稳）

在 `r2a_store.rs:1668` 写入前把 `finding.time` 归一到毫秒。**不得**用"数值大小猜单位"
的启发式散落在多个消费点；应是一个**具名的纯函数**，例如：

```rust
/// 纪元时间归一为毫秒。秒级输入（< 1e11）视为秒并放大。
/// 具名 + 单测，禁止在消费点各自内联猜测。
fn to_epoch_ms(t: i64) -> i64 { if t < 100_000_000_000 { t * 1000 } else { t } }
```

理由：`finding.time` 的单位目前由执行环境适配器决定（见 §3），在一个版本内无法保证全部改完；
边界归一保证**列契约恒成立**，且可独立验收。

### 5.2 产生方修正（应做，宽而正）

把各执行环境适配器填入 `entry.time` 的地方统一为毫秒（claude-code 的秒是主犯，1,527 条）。
优先做法是**在填 entry.time 处转换**，让 canonical 时间线的 `time` 有单一契约；
§5.1 的边界归一保留为防御层（两者并存不冲突，幂等）。

### 5.3 存量修复（必做）

一次性把 `issue_instances` 中单位错误的行修正到毫秒：

```sql
-- 秒级（< 1e11）→ 毫秒；同一个值也要同步修 metadata_json.time，保持 E2 的两列同源
UPDATE issue_instances SET opened_at_ms = opened_at_ms * 1000
 WHERE opened_at_ms < 100000000000;
```

要点：
- **幂等**（重跑无副作用：修正后不再 < 1e11）；
- **`metadata_json.time` 同步修正**——否则两列不再同源（E2 的不变式被破坏），且日后
  任何重放/重建会重新引入错误值；
- 修复后**日桶不再是 1970**，且这些实例重新进入 30 天窗口；
- 输出前后计数与日桶分布对比（可审计）。

### 5.4 契约钉死（必做）

新增回归类（命名对齐仓库既有纪律）：

- `TestIssueTimestampsAreMilliseconds`：
  - 写入路径：给定秒级 `finding.time` 的输入，断言落库的 `opened_at_ms` 是毫秒；
  - `to_epoch_ms` 纯函数：秒→×1000、毫秒→原样、边界值（1e11 前后）行为明确；
  - `issue_day_bucket`：秒级输入归一后**不产生 1970 日桶**；
- 断言 `opened_at_ms` 与 `metadata_json.time` **逐条同值**（复用 E2 的不变式）。

## 6. 验收

1. 修复后真机：`opened_at_ms < 1e11` 的行数 = **0**；日桶分布中不再出现 1970 年。
2. 月窗口查询：修复前被静默排除的 1,542 条**重新出现在**默认 30 天视图内（给出前后组数对比）。
3. 幂等：存量修复脚本连跑两次，第二次改动 0 行。
4. 回归类通过；且**不触碰** `dsh_extract_summary`（§4）。
5. 抽查 3 条原秒级实例：`opened_at_ms`、`metadata.time`、页面日桶三者一致且等于真实日期。

## 7. 明确不做

- 不改 `dsh_extract_summary` 的 `date_span`（§4 已证其正确）。
- 不在多个消费点各自内联"猜单位"（§5.1 要求单一具名函数）。
- 不改 `issue_instances` 的主键/身份语义（本修复只动时间列与派生日桶）。
- 不删除任何实例（本修复是**修正**，不是清理）。

## 8. 与其它项的关系

- **REQ-073 / P1**：本缺陷直接破坏 P1 的「时间范围」维度；修完 P1 的验收项（组数、
  分页）才有意义。
- **P1 验收清单**见 `ISSUE_REQ073_PENDING_QUEUE.md` §3.2.1（对象归一化判据 N1–N10）；
  本缺陷是**时间维**的对等缺陷，两者应一并修。
- **AC18**（多条相同 Issue、用户稍后处理）依赖稳定的时间窗，同样受本缺陷影响。
