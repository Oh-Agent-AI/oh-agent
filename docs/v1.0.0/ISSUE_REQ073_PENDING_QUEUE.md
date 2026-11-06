# 问题分析规格：REQ-073 待处理队列的归并层（"不以命中数冒充待办数"）

> 状态：**待实现**（分析完成，实测证据齐备；未改任何代码）
> 发现：2026-09-12，真机 UAT 侦察（`~/.agent-vitals`，schema 13）
> 影响阶段：**C（FR-09 待处理，REQ-073–080）**
> 关联纪律：REQ-060（可回答/不可回答两类分列）、REQ-074（首发六族）、REQ-076（排序）、REQ-077（五态）、REQ-078（自动关闭）、REQ-079（自动动作边界）

---

## 1. 目标

把"4,450 条原始命中"变成"几十个可行动的待办项"，并且**保留原始命中供展开**——即 REQ-073 的字面要求：
> 按问题族、对象、时间范围和证据归并；保留原始命中供展开，不以3900次命中冒充3900件待办。

## 2. 现状与差距（实测）

### 2.1 已有的地基（比预想完整）

| 能力 | 位置 | 状态 |
|---|---|---|
| 持久化 Issue 身份 + 生命周期 | `crates/agent-vitals-data/src/issues.rs` | 已实现（`IssueInput` / `stable_issue_id` / `upsert_issue`） |
| 状态迁移函数 | `issues.rs:85 transition_issue()` | **已实现但 0 次调用**（`issue_status_transitions` 表 0 行） |
| 只读建议目录 | `issues.rs:28 remedy_for()` | 仅 3 条映射 + `diagnostic-only` 兜底 |
| 读接口 | `apps/desktop/src-tauri/src/store.rs` 的 `sessions_issues()`（截至 2026-09-12 在 L304） | 已接线 |
| 单维归并 | `store.rs` 的 `issue_rollup()`（同日 L355） | **只按 `rule` 聚合** → `{rule, severity, category, hits, sessions}` |
| 前端调用 | `ui/workbench.js` 中 `invoke("sessions_issues")` 及其消费点（同日 L4015 起） | 读 `data.issues`（**全量数组**） |

### 2.2 四个缺口

**G1 只归并了一维。** REQ-073 要求四维（问题族/对象/时间范围/证据），现只做了问题族。
原料其实齐备：`instance_fingerprint` 恒为四段 `<session_key>\0<rule>\0<seq>\0<object>`：

| rule | object 段实例 | 性质 |
|---|---|---|
| SV601 | `rm -rf` | 命令模式 |
| SV602 | `sudo` | 命令模式 |
| SV604 | `~/.ssh/authorized_keys` | 敏感路径 |
| SV605 | `/ingest/export/summary/state` | 工作区外路径 |
| SV607 | `UNKNOWN_TOOL` | 工具名 |
| SV610 | `danger-full-access` | 权限模式 |
| SV611 | `read 连续重复 3 次` | 描述（含计数，需剥离） |
| SV613 | `进度停滞: 连续 4 个工具失败（首个 …）` | 描述（含计数） |
| SV614 | `权限异常: 危险模式 danger-full-access 授予 1…` | 描述（含计数） |

`metadata_json` 统一含 `category / evidence / remedy / seq / source / time / tool_name`。

**G2 全量返回原始命中。** `store.rs` 的 issue 查询（同日 L321）无窗口无分页，`issues` 数组整包回前端——这正是 REQ-073 禁止的形态。真机 4,450 条，按规则分布：

```
SV610 2617 · SV605 1102 · SV601 379 · SV611 120 · SV613 67
SV614 56 · SV604 32 · SV603 25 · SV602 20 · SV609 20 · SV607 12
按执行环境: codex 2767 / claude-code 1527 / dsh 156
evaluator: 全部 legacy-finding@v0.11
```

**G3 状态机未通电。** REQ-077 五态（待处理/稍后提醒/已确认/已解决/不适用）无入口；`transition_issue()` 从未被调用。

**G4 来源未统一。** `issue_instances` 只装行为规则。REQ-074 首发六族里，**数据连接失败 / 路由待确认 / 价格缺失 / 预算阈值** 分散在 `data_quality_issues`、`data-unresolved`、`budget alerts`、source status——待处理页必须合并这些来源，否则六族只覆盖两族。

## 3. 归并规格

### 3.1 归并键（四维）

```
group_key = (rule, harness, object_norm, evidence_class, day_bucket)
```

| 维 | 来源 | 归一化规则 |
|---|---|---|
| 问题族 | `issue_type` | 原样（SV6xx） |
| 执行环境 | `harness` | 原样 |
| **对象** | fingerprint 第 4 段 | **按族归一**（见 3.2） |
| **时间范围** | `opened_at_ms` → 北京日 | 日桶（窗口可选周） |
| **证据类** | `metadata.evidence` + `category` | 归类（同族下区分"重复/失败/超限/越权"） |

### 3.2 对象归一化规则表（**本规格的核心**）

| 族 | 归一化 | 例 |
|---|---|---|
| SV601 / SV602 / SV603（命令） | 取首 token（可执行名） | `rm -rf` → `rm`；`sudo apt …` → `sudo` |
| SV604 / SV605（路径） | 取父目录前缀 + `*` | `~/.ssh/authorized_keys` → `~/.ssh/*`；`/ingest/export/summary/state` → `/ingest/export/*` |
| SV607（工具） | 原样 | `UNKNOWN_TOOL` |
| SV610 / SV614（权限模式） | 原样（值域小） | `danger-full-access` |
| SV611 / SV613（描述） | 剥离计数与序号后取前缀 | `read 连续重复 3 次` → `read 连续重复`；`进度停滞: 连续 4 个工具失败…` → `进度停滞: 连续工具失败` |

**纪律**：归一化只做"同义合并"，不得跨越族或执行环境；剥离后的串不得丢语义（如 `rm` 与 `rmdir` 不可合并）。归一化函数须**纯函数 + 单测覆盖每个族**。

#### 3.2.1 P1 验收清单（对象归一化，逐条可勾）

> 状态：`issue_groups` 已在 `crates/agent-vitals-data/src/issues.rs` 出现（Loop 在实现中）。
> 下表是 P1 的**判据**，每条都要有对应断言；表内为真机已验证的输入形态。

| # | 判据 | 输入 → 期望 | 依据 |
|---|---|---|---|
| N1 | 命令族取首 token | `rm -rf` 与 `rm -f` → **同一组** | 真机 SV601 `rm -rf` |
| N2 | 首 token 不跨可执行名合并 | `rm` 与 `rmdir` → **不同组** | 防过度归并 |
| N3 | 命令族忽略参数差异 | `sudo apt install x` 与 `sudo rm y` → 同一组 `sudo` | 真机 SV602 `sudo` |
| N4 | 路径族取父目录 | `~/.ssh/authorized_keys` 与 `~/.ssh/known_harnesses` → 同一组 `~/.ssh/*` | 真机 SV604 |
| N5 | 路径族不跨目录合并 | `~/.ssh/id_rsa` 与 `/etc/harnesses` → 不同组 | — |
| N6 | 权限模式族原样 | `danger-full-access` 各自成组 | 真机 SV610（2617 条，最大组） |
| N7 | 描述族剥离计数 | `read 连续重复 3 次` 与 `…重复 7 次` → 同一组 | 真机 SV611 |
| N8 | 描述族剥离序号 | `连续 4 个工具失败（首个 …）` 与 `连续 9 个…` → 同一组 | 真机 SV613 |
| N9 | 跨族不合并 | 同 object 不同 rule（如 `danger-full-access` 出现在 SV610 与 SV614）→ **必须两组** | REQ-073 分族 |
| N10 | 跨执行环境不合并 | 同 rule 同 object 不同 harness → 不同组 | REQ-073 |

**真机参考量级**（4,450 条命中的分布，用于判断归并是否"过粗/过细"）：

```
SV610 2617 · SV605 1102 · SV601 379 · SV611 120 · SV613 67
SV614 56 · SV604 32 · SV603 25 · SV602 20 · SV609 20 · SV607 12
执行环境: codex 2767 / claude-code 1527 / dsh 156
```

归并后的**组数应显著小于命中数**（预期数十组量级）；若归并后仍是数百组，说明对象归一化过细（N1/N4/N7/N8 未落实）。

### 3.3 组 DTO

```json
{
  "group_id": "<hash of group_key>",
  "rule": "SV610", "harness": "codex",
  "object": "danger-full-access", "evidence_class": "权限越权",
  "bucket": "2026-09-12",
  "count": 194, "first_seen_at_ms": …, "last_seen_at_ms": …,
  "severity": "warning",                  // 组内最高，非求和
  "status_rollup": {"open":194,"later":0,"acknowledged":0,"resolved":0,"not_applicable":0},
  "sessions_count": 12,
  "sample_evidence": [ …≤3 条原始击中的摘要… ],
  "remedy": {"remedy_id": "…", "diagnostic_only": true},
  "actionability": 0.0…1.0                // REQ-076 排序依据
}
```

### 3.4 三级读取（取代全量返回）

| 级 | 内容 | 默认 |
|---|---|---|
| **L0** | 组列表 | 30 天窗、按 `actionability` 降序、每页 50 |
| **L1** | 某组的 instances | 分页 |
| **L2** | 单条详情（metadata / evidence / 原始命中） | 单条 |

**没有 L1 就不会有 L0 的全量代价**；`sessions_issues` 的 `issues` 全量数组必须改为按需查询。

## 4. 排序与呈现（REQ-076 / REQ-060）

- `actionability = f(severity, 证据充分度, 用户可否回答)`；**规则严重度 ≠ 已确认损害**——critical 不得直接渲染成"已造成危险"（REQ-076）。
- **两类必须分列**（REQ-060）：「**确认计费方式**」（用户能回答）与「**查看数据状态**」（用户无法回答）不得混在同一句黄色警告中。
- 未知影响金额**不填 0**（REQ-075）。

## 5. 状态机与自动关闭（REQ-077 / REQ-078）

- 五态：`open / later / acknowledged / resolved / not_applicable`；每次迁移落 `issue_status_transitions`（**表已存在，0 行**）。
- 接入点：**复用现成的 `issues.rs:85 transition_issue()`**——本规格不新写状态机，只补调用方（IPC + UI）。
- 自动关闭（REQ-078）三分支：可自动验证 → 下次评估后关闭；声明类 → 声明成功应用后完成；需持续观察 → 显示"验证中"。
- 用户说"知道了"**不得**自动等同于"客观问题已修复"（REQ-077）。

## 6. 自动动作边界（REQ-079）

首发自动动作**仅限**本 App 配置、重新扫描、重新估算。
`remedy_for()` 的 3 条映射需扩充为「证据 + 操作建议」，且**一律不得自动改执行环境文件或执行 shell**——执行环境侧只提供证据与建议。

## 7. 来源统一（REQ-074 六族）

| 族 | 当前所在 | 迁入方式 |
|---|---|---|
| 数据连接失败 | source status / `data_source_status` | 投影为 issue 组 |
| 路由待确认 | `data-unresolved` / `billing_import_candidates` | 同上 |
| 价格缺失 | `data_quality_issues`(no-price-card) / `data-unresolved` | 同上 |
| 预算阈值 | `budget_config` + 提醒账本 | 同上 |
| 异常用量增长 | 尚未实现（REQ-111 需 ≥7 可比日基线） | 后续 |
| 可解释的重复/失败 | `issue_instances`（已有） | 直接读 |

**统一不是合并存储**：各族保留自己的权威表，只在一个**只读投影层**（组 DTO）里汇合；禁止把行为问题写进 `data_quality_issues` 或反之。

## 8. 分期实施

| 期 | 内容 | 验收 |
|---|---|---|
| **P1** | 归并层（纯数据，无 UI）：`issue_groups()` + 对象归一化 + 分页 | 真机 4,450 条 → 组数（预估几十组）；每族归一化单测；跨族不合并断言 |
| **P2** | 来源统一：四类外部问题族并入同一组 DTO | 六族都能在组列表出现；各自权威表未被写入 |
| **P3** | 表面：待处理页 L0/L1/L2 + actionability 排序 + 两类分列 | UI 不再整包拉 `issues`；点击可展开原始命中 |
| **P4** | 状态机接线 + 自动关闭 + remedy 扩充 | 五态落 `issue_status_transitions`；自动动作白名单断言 |

**P1 可独立验收且风险最低**（不碰 UI、不动现有读路径），建议先做。

## 9. 验收（整体）

1. 真机：组数 << 命中数（给出两个数字与比值）；L0 响应 P95 ≤ 1s。
2. 展开任一组，能取回其全部原始命中（计数与组 `count` 相等）。
3. 归一化：`rm -rf` 与 `rm -f` 合为一组、`rm` 与 `rmdir` 不合；路径 `a/b/c` 与 `a/b/d` 合为 `a/b/*`。
4. 跨族不合并：同 object 不同 rule 必须两组。
5. 状态迁移：五态各有历史行；"知道了"不关闭问题。
6. 两类分列：可回答/不可回答不混句。
7. 自动动作白名单：断言不存在"改执行环境文件/执行 shell"的路径。

## 10. 明确不做

- 不把行为问题写进 `data_quality_issues`，也不反向（各自的权威表不动）。
- 不新写状态机（复用 `transition_issue`）。
- 不在 P1 碰 UI（避免与飞行中的桌面 Loop 冲突）。
- 不用"命中数"当"待办数"渲染任何计数（标题、徽标、摘要一律用**组数**）。

## 11. 维护注记（行号稳定性）

本规格引用的 `crates/agent-vitals-data/src/issues.rs` 已提交、行号稳定；而
`apps/desktop/src-tauri/src/store.rs` 与 `ui/workbench.js` **正在被 Loop 编辑**（未提交），
行号会漂移。规格内一律以**符号名为主、行号为辅并标注日期**；实现时以符号名为准。

## 12. 与其它项的关系

- **AC18**（多条相同 Issue、用户稍后处理）直接依赖本规格的归并与五态。
- **REQ-111**（异常用量增长）需要 ≥7 个可比有效日的基线，属本规格 P2 之后。
- **UAT**：`docs/v1.0.0/UAT_SMALL_LOOPS.md` 第 5 条（"仍不确定/稍后"）在 P4 完成后可验。
