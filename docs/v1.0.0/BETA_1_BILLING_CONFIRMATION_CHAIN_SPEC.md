# v1.0.0-beta.1 计费确认主链规格（B06 / B07）

**状态：** v1.4（2026-09-16；把用户声明的**订阅月费**接进「实际支出」，订阅改为持续有效，见 §10.3）。v1.3（2026-09-16；按产品决策把声明结束日期改为**选填**——留空＝持续有效、开放到未来，用于「按量充值 / 长期付费，不知道哪天结束」的关系，见 §5.4a 与 D02）。v1.2（2026-09-15；v1.1 全部落地后，按产品决策收敛为「明确计费方式」单一路径：按缺什么问什么、同类组批量、保存→重新归因→重算→各面刷新，见 §5.2a/§5.3a/§5.7 与 §10），作为 Beta 1 P2 / B1-M3「计费闭环」的实现合同  
**日期：** 2026-09-16  
**范围编号：** [发布规格](BETA_1_RELEASE_SPEC.md) B06、B07；真机矩阵 T06、T08、T10；[执行计划](BETA_1_EXECUTION_PLAN.md) E201–E208；PRD REQ-017–032、REQ-143–149；AC05、AC09、AC13、AC14、AC26、AC27、AC28  
**关联文档：** [UAT 2026-09-15](UAT_FULL_2026-09-15.md)、[小闭环 UAT 清单](UAT_SMALL_LOOPS.md)、[总览后端接入规格](BETA_1_OVERVIEW_BACKEND_INTEGRATION_SPEC.md)、[设置页规格](BETA_1_SETTINGS_PAGE_SPEC.md)、[版本冻结记录](BETA_1_VERSION_FREEZE_2026-09-15.md)、[Provider 路由归属规格](../PROVIDER_ROUTE_ATTRIBUTION_SPEC.md)

## 0. 一句话结论

这条链**不是从零开始**：数据层的声明/修订/作用范围/重算任务/归因表、原子发布、
重启恢复、撤销，以及内部 MCP `billing_workflow` 的 20 个 typed 动作都已实现并有
测试。真正的缺口有六处，其中三处会让用户在真实 `.app` 里得到**错误的结论**（而
不只是缺证据），必须在 T08 真机验收之前修：

| # | 缺口 | 严重度 | 现象 |
|---|---|---|---|
| G1 | 候选列表的主按钮「是我的套餐」只改候选状态，**不产生归因、不重算**，用量仍按量估算；而提示文案承诺「确认后就能分清哪些在套餐内」 | **P0**（AC27 反向失败：用户以为确认了，数字没变） | `workbench.js:2359-2426` |
| G2 | 保存前预览只算**当前统计月**，重算却按声明有效期**全历史**归因（`i64::MIN..MAX`）；预览 ≠ 实际写入范围 | **P0**（E203「预览与实际写入使用同一范围」失败） | `workbench.js:1865-1873` vs `authority.rs:2524` |
| G3 | 声明一律 `effective_end = null`（开放到未来）；B06 明令 Beta「不自动扩展到未来记录」 | **P0**（范围纪律）；v1.3 起改为**结束选填**（留空＝持续有效），原推理已在 §3 事实 3 修正 / §5.4a | `workbench.js:1899` |
| G4 | 预览没有金额，只有 tokens/事实/会话；REQ-026/AC27 要求「移出估算 X / 保持估算 X / 仍待确认 X」 | P1 | `BillingDeclarationImpactPreview` 无金额字段 |
| G5 | REQ-023 的「执行环境 × provider × 模型 × 路由证据」分组已在数据层实现（`summary.rs:908 unresolved_billing_groups`）但**零消费方**；UI 只从旧资产迁移候选 `billing_import_candidates` 出发，无旧资产的新用户看不到任何待确认组 | P1（E201 一般情形不成立） | `summary.rs:908`；无 Tauri 命令 |
| G6 | 保存与重算分成「保存」「应用」两次点击；只保存不应用会留下「声明已存在、数字未变、待处理列表也不显示」的半状态 | P1 | `workbench.js:1911-1912, 1919` |

另有三处不改数字但要收口：修订级预览 `billing_declaration_impact_preview` 前端零调用（孤儿端点）；「稍后」的 30 天降级存在 webview `localStorage` 而不在权威库；声明的生效月边界硬编码北京时（`'+8 hours'`），与可配置统计时区无关。§8 给出决策。

## 1. 目标

用户在真实 `.app` 中不看文档、不开终端，能完成两条路径并得到与 CLI/MCP 一致的结果：

1. **确认路径**：总览提示 → 待确认组 → 选「官方订阅」→ 看到作用范围与金额变化 → 保存 → 重算回执 → 总览/日历/会话同一版本 → 撤销 → 回到确认前。
2. **不确定路径**：选「仍不确定」或「稍后」→ 按量估算与不确定标记保留 → 退出重开仍能从待处理找回 → 30 天内不再抢占首屏。

以及一条恢复路径：重算失败 / 处理中退出 → 重开后旧结果仍可读、任务可见可重试、没有半发布。

## 2. 范围与非目标

### 2.1 本规格改动的范围

- 候选/待确认组的**来源与分组**（G5）、主按钮语义（G1）。
- 声明的**作用范围纪律**：显式起止日期 + 模型作用域（G3）。
- **预览合同**：范围 = 写入范围，三个数字 + 分币金额（G2、G4）。
- **保存即入队**的单动作合同与回执（G6）。
- 撤销、不确定/稍后、失败/重试/重启恢复的既有实现按本规格钉住不变量并补真机证据。
- 删除孤儿端点；不新增第二套预览/计价逻辑。

### 2.2 不在范围（保持 D01/D02 延期状态，不得因本规格回流）

- 付款/账单录入、CSV 导入、已确认支出预算（D01）。`harness_bill_*` 命令保留只读兼容，不新增入口。
- 第三方价卡/倍率编辑、多账户套餐、「以后同类记录」自动声明（D02）。`relationship_kind = third_party` 在 Beta 只记录关系，不改变金额。
- 跨执行环境 canonical 归一（D05）：组键用 `harness/raw` 消歧后的 `provider_id`/`model_id`，不合并实体。
- 在线价目更新（D06）。
- 修改**已保存**声明的编辑表单：Beta 只提供「撤销后重新确认」，不提供原位编辑（这也是删除修订级预览端点的依据）。

### 2.3 计费边界（发布规格 §3.1，本规格不得放松）

- 声明只改变**归因**（哪些用量在套餐内），永不产生「已付款」：用量本身不会被声明标成"付过了"，`actual spend` 里的按量档仍只来自账单/付款记录。
  **但不含订阅月费**（v1.3 澄清）：用户在「明确计费方式」里声明的**月费**是自报的固定支出，按 `BillingBasis::FixedSubscription`（定义原话：「**用户声明的**固定订阅费用」）进入「实际支出」的订阅档——与账单录入的 `metered_actual`/`harness_billed` 并列不混。这条与「用量不产生已付款」不矛盾：一个月费是**关系**层的自报固定成本，不是把某批 usage 标成付过。
- 币种永不相加；金额永远带 `currency` 与 `basis`。
- `unknown` 不是声明：不写 `billing_declarations`，不入队重算。
- 原始 `usage_facts` 不因任何声明/撤销/重算而变；守恒用 `data-reimport-verify` 与事实计数对拍。

## 3. 数据模型与「一个谓词」

已存在（`crates/agent-vitals-data/src/authority.rs`，schema v13）：

| 表 | 作用 | 关键约束 |
|---|---|---|
| `billing_import_candidates` | 旧资产迁移出的套餐候选（`pending/accepted/dismissed`） | 幂等 put；`reopen` 回到 pending |
| `billing_declarations` | 声明当前态（每 `declaration_id` 一行） | upsert |
| `billing_declaration_revisions` | 不可变修订（`saved`/`revoked`），`revision_number` 递增、`supersedes_revision_id` 唯一 | `save` 校验必须 supersede 当前修订（`authority.rs:2136-2150`） |
| `billing_declaration_scopes` | 修订的作用域 `account/route/model/session` | 同一修订内不得重复 |
| `billing_recalculation_jobs` | 每修订一个任务（`ON CONFLICT(revision_id) DO NOTHING`） | `queued→running→succeeded/failed/cancelled`；`retry` 只允许 failed/cancelled |
| `billing_recalculation_results` | 任务结果快照 | 只在 COMMIT 内写入 |
| `billing_fact_attributions` | 事实级归因（`subscription_covered` / `user_declared`） | 只在 COMMIT 内写入（`authority.rs:2555-2596`） |

**唯一的排除谓词**（所有金额/日历/小时/会话/MCP 查询共用；`authority_query.rs:58-63` 等 7 处、`summary.rs:925`（`unresolved_billing_groups`）、`cost_breakdown.rs:222`）：

```sql
NOT EXISTS (SELECT 1 FROM billing_fact_attributions ba
  JOIN billing_declaration_revisions br ON br.revision_id = ba.revision_id
  WHERE ba.fact_id = usage_facts.fact_id
    AND ba.attribution_kind = 'subscription_covered'
    AND br.revision_number = (SELECT MAX(br2.revision_number)
        FROM billing_declaration_revisions br2 WHERE br2.declaration_id = br.declaration_id)
    AND br.change_kind = 'saved')
```

由此推出三条本规格依赖的既有事实，验收时按它们解释现象：

1. **只有 `official_subscription` 改数字。** 重算把该修订匹配到的事实写成 `subscription_covered`，按量估算随即排除它们；其他四种 kind 写 `user_declared`，谓词不认，金额不变（`authority.rs:2541-2544`）。UI 必须把这件事说出来（§5.3），不能让「组织承担」看起来像省了钱。
2. **撤销不需要重算。** `revoke` 追加 `change_kind='revoked'` 的新修订成为 MAX，谓词立即失效，事实回到按量估算；旧 `results`/`attributions` 原样保留可追溯（`authority.rs:2194-2260`）。
3. **未归因的事实永远按量。** 归因只在重算 COMMIT 时按当时存在的 `fact_id` 写入；之后同步进来的新事实没有归因行。所以「不自动扩展到未来」在数据层已经成立——但只要 `effective_end` 为空，任何一次 `retry` 或新修订的重算都会把新事实扫进去。G3 因此必须在写入侧堵住，而不是依赖这个副作用。
   **v1.3 修正**：上面这半句「任何一次 retry 都会把新事实扫进去」漏掉了前提——重算**根本不会自己再跑**。`billing_recalculation_jobs` 是 `UNIQUE(revision_id)`，`billing_recalculation_retry` 只收 `failed`/`cancelled`（注释写明「成功任务不回退」），没有任何周期性重跑；桌面侧 `recover_billing_recalculations` 只恢复**已排队**的任务，不新建。所以留空 `effective_end` 并不构成「自动扩展到未来」：它不会改写任何已写事实的归因，新同步进来的事实仍是按量（见 §5.4a）。原文把「开放期」误当成了「自动扩展开关」——两个不同的东西。

## 4. 术语

| 词 | 定义 | Beta 里的来源 |
|---|---|---|
| 候选（candidate） | 旧资产迁移出的「你可能有这个套餐」记录 | `billing_import_candidates` |
| 待确认组（group） | 一个月内 `harness × provider_id × model_id × evidence_basis × pricing_basis` 上仍按量估算或路由证据不是 `explicit-official-route` 的用量聚合 | `summary.rs:908 unresolved_billing_groups` |
| 声明（declaration） | 用户对「这批用量如何付费」的回答；版本化 | `billing_declarations` + revisions |
| 作用范围（scope） | 声明命中事实的条件：`harness`、`provider_id`、`effective_start..=effective_end`（北京时间日期）、`scopes[]` | revision + scopes |
| 影响预览（preview） | 在**与写入完全相同的范围**上只读计算：命中事实数/会话数/tokens，以及分币金额三分 | §5.5 |
| 重算（recalc） | 把一个 `saved` 修订的命中事实写成归因并原子发布结果快照 | `billing_recalculation_run` |
| 回执（receipt） | 保存后原位显示的结果：修订号、任务状态、范围、金额变化、撤销按钮 | §5.6 |

候选与组的关系：候选只是组的一种**证据来源**（`evidence_ref = legacy-import-candidate:<id>`，`source_candidate_id` 回填）。面板以**组**为单位展示；有候选证据的组预填 provider/金额/起始月，并在保存时把候选置为 `accepted`（`authority.rs:2109-2135` 已做）。

## 5. 用户路径合同

### 5.1 入口提示（AC26、REQ-019/020）

- 触发条件：本统计月 `unresolved_billing_groups` 非空**或**存在 pending 候选。只有候选、无组时（旧资产但当月无用量）也提示。
- 文案必须同时含三件事：受影响 tokens 与会话数（各组求和）、当前默认处理（「已按官方价估算」）、确认收益（「确认后可区分订阅覆盖和额外费用」）。金额只在**单币**时显示总数，多币按币种分列，不相加。
- 主按钮文案固定「确认计费方式」；次操作「稍后」；不得出现「编辑」「已省」。「查看数据状态」是另一个入口，不能替代。
- 现有实现：`workbench.js:2306-2323`、`renderBillingImportCandidates`。改动：`pendingTokens` 的来源从候选 `impact` 改为组聚合 + 候选并集（§6 F1）。

### 5.2 待确认组面板（REQ-023、E201）

- 打开位置：设置 tab（`data-tab="sources"`，页内标题「设置」）的「计费与套餐」分区 `#settings-billing`（`ov-billing-review-panel` 就住在那里）。这是设置页规格的既定信息架构，不是数据源页；Draft v1 误读了 `switchTab("sources")`，本版更正，不再要求改成总览内抽屉。
- 数据源：新增只读 Tauri 命令 `billing_confirmation_groups(month)`，返回 `runtime::summary::unresolved_billing_groups(month)` 的结果并补齐 `estimated_amounts[]`（§6 B1）。
- 排序：默认按**估算金额**降序（同币内），无价卡的组按 tokens 降序排在有金额组之后；不得按创建顺序或 `candidate_id`。
- 每组展示：执行环境、provider、模型、路由证据（`evidence_basis` 的用户文案映射，见设置页规格的 reason code 表）、日期范围（`first/last_event_at_ms` 按统计时区）、会话数、tokens、名义估算（分币）、当前依据（`pricing_basis`）与置信状态。
- 组行只有一个主操作「确认计费方式」（打开 §5.3），没有「是我的套餐 / 不是」二选一（G1 的修法）。有候选证据的组附一行「来自旧版本套餐记录：<provider> <金额> 自 <月> 起」和一个文字链「这不是我的套餐」→ `candidate_resolve(dismissed)`，只处理候选，不碰用量。
- 每次只展开一组。

### 5.2a 批量：同执行环境、同未知原因、同适用日期的组一起处理（v1.2）

- 弹窗打开时默认勾选所有与目标组 **批量键相同** 的组：`harness × provider_id × evidence_basis × pricing_basis × effective_start × effective_end`（`workbench.js::billingBatchKey`）。勾选行文案固定：「将同时处理 N 个模型、M 个会话、X tokens（同一执行环境、同一未知原因、同一适用日期）」。
- 批量 = **一条声明、多条 `model` 作用域**（同 kind 并集），因此一次预览、一个修订、一个重算任务；预览的「移出」是各组求和，「保持」是同执行环境同 provider 期间内未选中的其余事实。
- 取消勾选只处理目标组；候选专属行（当月无用量）和已处理候选行不参与批量。

### 5.3 关系选择（REQ-021/024/029/030/031、AC05/AC09）

#### 5.3a 按缺什么问什么（v1.2 收敛后的表单）

按钮文案统一为 **「明确计费方式」**（入口提示、组行、待处理入口、弹窗标题）。弹窗不再直接选 `relationship_kind`，而是按组缺什么依次问（`workbench.js::billingMissing` / `billingRelationshipFromSteps`）：

| 缺什么 | 判定 | 问什么 | 保存时落到哪 |
|---|---|---|---|
| 服务商未知 | `provider_id = "<unknown>"`（事实 `provider_id IS NULL`） | 「这批用量是哪家服务商的？」（`ov-known-providers` 列表） | 声明 `provider_id` = 用户选的；作用域加 `("provider","unresolved")`（schema v14，只命中 NULL-provider 事实）；官方路由时同时 `save_price_route(model, provider, mode)`，下一轮同步归到该服务商 |
| 路由未知 | `evidence_basis ∉ {explicit-official-route, session-native, account-time-bound, config-time-bound}` | 官方路由 / 第三方服务 / 仍不确定 | 第三方 → `third_party`；仍不确定 → 不写声明（§5.9） |
| 计费方式未知 | 路由为官方时总是问 | 官方订阅 / 官方 API（按量）/ 组织承担 | `official_subscription` / `official_api` / `organization` |
| 订阅 | 上一步选订阅 | 套餐名（可选）、月费与币种或「金额暂不清楚」、起止日期 | `subscription_name` / `amount_minor+currency`（未知 → 双空，不补挂牌价，AC09）；有旧候选时预填其金额供核对 |

三步之后仍是 §5.5 预览 → §5.6「确认并保存声明」。每一步旁的结果说明文案见 §5.3 表「Beta 对数字的影响」列。


面板第一问固定：「这批用量如何付费？」五选一，每项旁边一句**结果说明**（Beta 的真实行为，不许美化）：

| 选项 | `relationship_kind` | Beta 对数字的影响 | 进一步问什么 |
|---|---|---|---|
| 官方订阅 | `official_subscription` | 命中用量移出按量估算，进入「订阅覆盖」；订阅月费只在有账单/付款记录时计入实际支出 | 套餐名（可空）、月费与币种（可选「金额暂不清楚」→ `amount_minor/currency = null`，不补挂牌价）、起止日期 |
| 官方 API | `official_api` | 金额不变（本来就按官方价估算）；记录为已确认依据 | 无 |
| 第三方服务 | `third_party` | Beta 不改金额；提示「第三方价卡编辑随后续测试版提供，当前仍按官方价估算」 | 无（D02） |
| 组织承担 | `organization` | 只改承担者标签；金额与估算状态不变，不等于免费 | 无 |
| 仍不确定 | （不写声明） | 保持按量估算与不确定原因；进入待处理，30 天不抢首屏 | 无 |

约束：

- 同一执行环境可有多条声明（不同 provider/模型/期间），但同一 `declaration_id` 的当前修订只有一条。
- 与仓库 Watchlist 冲突的证据不被订阅吞掉（E207）：组的 `evidence_basis` 若已是 `explicit-official-route` 以外的**明确相反证据**（例如显式 custom endpoint），选「官方订阅」时预览必须显示「仍待确认 X」而非移出。实现：预览与重算都只匹配 `evidence_basis` 与组一致的事实（§6 B2 的 `route` scope）。
- `unknown` 永不持久化为声明（守卫测试 §7 R4）。

### 5.4 作用范围（REQ-025 的 Beta 子集、B06、G3）

Beta 只开放两种范围（v1.3 起第二种的结束日可选）：

1. **仅这一组**（默认，系统推荐的最窄可靠范围）：`scopes = [{model: <model_id>}, {route: <route_evidence_id 或组的 evidence_basis 键>}]`，`effective_start = 组内最早事实所在日`，`effective_end = 组内最晚事实所在日`。
2. **所选日期范围**：用户在起止日期控件里改，`end >= start`，且不得晚于今天（北京时间）；`effective_end` 可留空＝持续有效（§5.4a）。

不开放「以后同类记录」**自动声明**（D02 的原意）；`effective_end = null` 在桌面命令层**允许**（§6 B3，v1.3），内部 MCP `billing_workflow.declaration_save` 一直允许（它不是用户面）。

### 5.4a 结束日期选填（v1.3，2026-09-16）

- **规则**：`effective_start` 必填且不晚于今天（北京时间）；`effective_end` **选填**——留空（或空串）＝**持续有效**（开放到未来），用于「按量充值 / 长期付费，不知道哪天结束」的关系；填了则必须 `end >= start` 且不晚于今天。桌面 UI 的入口是日期行下面的「持续有效（不设结束日期）」勾选框：勾选＝结束字段清空并禁用，保存发 `null`。**不要把这个入口做成"让用户清空日期框"**——原生 `<input type="date">` 没有"未设置"这个状态（点开日历弹窗选不出空、清空只能全选删除），用户看到「选填」却做不到（2026-09-16 真机复验）。
- **为什么留空是安全的**（§3 事实 3 的 v1.3 修正）：归因只在重算 COMMIT 时按当时存在的事实写入，而成功任务是终态、没有任何周期性重跑。所以留空**既不会**改写已写事实的归因，**也不会**让之后同步进来的事实自动变成套餐内。留空是「这个关系还没结束」的**记录**，不是「自动扩展到未来」的开关。
- **留空的边界（验收时必须知道）**：正因为它不自动重跑，留空声明的覆盖停在**保存那一刻**已入库的事实。之后同步进来的用量仍是按量，直到用户重新声明。对 `official_subscription` 以外的四种 kind 这件事**不影响金额**——它们写 `user_declared`，而「唯一的排除谓词」只认 `subscription_covered`（§3 事实 1），`user_declared` 当前全仓库零消费方。`official_subscription` 的日期控件是隐藏的、由订阅锚点写成「锚点 – 今天」（§4 第 5 步），本次不改——要让订阅持续覆盖未来用量需要一条显式的重跑路径，属于**独立的后续决定**。

日期边界使用北京时间自然日（`strftime('%Y-%m-%d', ..., '+8 hours')`）。UI 起止日期控件旁注明「按北京时间日期」；统计时区改动不影响声明日期。

### 5.5 影响预览（REQ-026、AC27、E203、G2、G4）

- 预览必须与写入使用**同一组参数**：`harness, provider_id, effective_start, effective_end, scopes`——`window_start/end_ms` 不再由前端按统计月传，而由后端从 `effective_start..=effective_end` 推出（§6 B2）。前端不得再传 `billingMonthWindow(statisticsMonth())`。
- 返回三组数字，缺一不可：
  - **移出估算**：命中且当前为 `metered_estimate` 的事实 → tokens、会话数、分币金额；
  - **保持估算**：同 harness/provider/期间内**未命中** scope 的事实 → tokens、分币金额；
  - **仍待确认**：命中但 `evidence_basis` 与组不一致（冲突证据）或无价卡的事实 → tokens，金额标 `unresolved` 与原因码。
- 金额口径 = 名义按量估算（`metered_estimate` 同一价卡版本），与总览「按量估算」卡片同源；由 `cost_breakdown` 的桶计价路径抽出的共享函数计算（§6 B1/B2），**不得**在预览里另写一套价格查询。
- 非 `official_subscription` 的关系：预览仍显示三组，但「移出估算」恒为 0，并明示「此选项不改变金额」。
- 文案模板：`预计从按量估算中移出 {tokens} tokens · {sessions} 个会话 · ¥{cny} / ${usd}；保持估算 {tokens}；仍待确认 {tokens}（{reason}）。范围：{harness} · {provider} · {model} · {start}–{end}。` 币种缺项不显示，不写 0。

### 5.6 保存 = 确认 + 入队（REQ-147、E204、G6）

- 预览之后只有一个主按钮「确认并保存声明」。点击后**一次**用户动作完成：`save_billing_declaration_revision` → 成功后立即 `enqueue_billing_recalculation`（`official_subscription` 时）→ 返回 `{revision_id, declaration_id, job_id|null}`。不再有第二个「应用」按钮。
- 顺序与失败语义：保存成功、入队失败 → 回执显示「声明已保存，重算未入队」+「重试入队」按钮；声明不回滚（修订是不可变事实）。
- 回执（原位、不跳页）：修订号、范围、三组数字、任务状态（`queued/running/succeeded/failed`）、「撤销」按钮。轮询策略：前端 250ms × 20 次后若仍非终态，显示「后台处理中，可在待处理查看」，并把任务留在 `billing_recalculation_jobs` 列表（已实现，`workbench.js:758`）。
- 幂等：同一 `revision_id` 重复保存返回 `changed=false`，不重复入队（数据层已保证）。

### 5.7 各面刷新（AC27「总览/日历/会话/MCP 一致」）

- 一致性来源不是「刷新调用」而是**§3 的唯一谓词**：任何面只要重新查询，就得到同一版本。
- 完整顺序（v1.2）：用户补充归因 → 保存版本化修订 → 后端重新归因（`billing_fact_attributions`）→ 重算费用（结果快照原子发布）→ 刷新各面。桌面端的用量页按月缓存（`calendarLoadedMonth`）、会话与待处理懒加载缓存（`sessState.loaded` / `findState.loaded`）——重算成功与撤销成功后由 `refreshAfterBillingChange()` 统一作废三处缓存、重绘总览，并对当前正开着的用量/会话/待处理页立即重拉；其余页下次进入时重拉。**不是刷新页面**，数据来源仍是同一权威库。
- 处理中：回执显示「正在重新归因并重算费用…」；超过轮询窗口仍未完成时明示「完成前各页继续显示上一版本」，任务留在「重算状态」列表。
- 真机证据要求（T08）：同一隔离数据根上，保存前/后、撤销后三个时点各截：总览按量估算卡、日历该月合计、会话列表该组任一会话的成本依据、`data coverage --month`、MCP `cost_breakdown{group_by:[harness,provider_id,billing_mode]}`。五处的移出金额必须逐位相等；`cost_breakdown` 的 `billing_mode='subscription'` 桶等于预览「移出估算」。
- 性能：`billing_confirmation_groups` 与预览走 `SqlSummaryRepository` 直查；不得引入新的 fold 管线（CLAUDE.md 2026-09-05 事故）。

### 5.8 撤销（AC13、E205）

- 入口：回执上的「撤销」，以及「计费与套餐」设置分区里每条有效声明的「撤销计费声明」（已实现 `workbench.js:2221-2245`）。
- 行为：`revoke_billing_declaration(revision_id=rev-revoke-*, declaration_id, supersedes=current_revision_id)`；不删除任何行；不入队重算（§3 事实 2）；回执文案「已撤销，用量已回到按量估算；历史修订与重算结果保留可查」。
- 撤销后同一组重新出现在待确认组列表（谓词失效 → `unresolved_billing_groups` 再次命中）；来源候选若已 `accepted`，保持 accepted（候选≠归因），不自动 reopen。
- 证据：撤销前后 `usage_facts` 计数与 `data-reimport-verify` 通过；`declaration_revisions` 长度 +1；金额回到确认前逐位相等。

### 5.9 仍不确定 / 稍后（AC28、E206、T06）

- 「仍不确定」：只做影响展示（已实现 `unknown_preview` 分支）+ 记录 30 天降级；不写声明、不改候选、不入队。
- 「稍后」：只记录 30 天降级。
- 30 天降级存储：Beta 保留 webview `localStorage` + `sessionStorage` 双写（`workbench.js:1784-1792`），理由与代价见 §8 D2。
- 找回入口：待处理页 `BILLING_CONFIRMATION` 组（`issues.rs:592-608` 已投影 pending 候选；**需补**：无候选、只有组的情形也要投影，§6 B4）+ 设置「计费与套餐」分区的候选入口（已有 `settings-billing-candidates`）。
- 真机证据：选「稍后」→ 退出 → 重开：首屏无提示；待处理可见；设置可打开；`data-unresolved --month` 该组仍在；`billing_declarations` 无新行。

### 5.10 失败、重试、重启恢复（AC14、E208、T10）

已实现且本规格钉住不变：

- worker 在独立线程持 `.billing-recalculation.lock`（60s TTL），锁被占 → 任务 `failed(worker_busy)`；三次退避重试后 `failed(worker_failed)`（`lib.rs:2512-2564`）。
- 启动时 `recover_billing_recalculations`：`running` → `failed(interrupted)`，`queued` 重新派发（`lib.rs:3205`，`authority.rs:2468-2484`）。
- 只有 COMMIT 内才写结果与归因；失败/中断的任务对谓词零影响（旧版本继续可读，无半发布）。
- `jobs_needing_attention` 列出 `queued/running/failed/cancelled`，`succeeded` 不出现；显式重试只接受 `failed/cancelled`（`authority.rs:2452-2463`）。

补充要求：

- 失败回执必须显示 `error_code` 的用户文案（`worker_busy`「另一次重算正在进行」、`interrupted`「上次退出时中断」、`preview_failed/fact_match_failed/transaction_failed`「重算未能完成」），并保留「重试」按钮；不得显示原始 SQLite 错误串。
- 重复触发：同一修订再次入队返回 `changed=false`，UI 提示「该修订已有任务」。
- 真机证据（T10）：入队后立即 `kill -9` App → 重开 → 待处理/回执显示 `failed(interrupted)` → 点重试 → `succeeded`；全程 `usage_facts` 计数不变、`billing_fact_attributions` 无重复 `(fact_id, revision_id)`（唯一索引保证）、`billing_recalculation_results` 每 job 一行。

## 6. 改动清单

### 6.1 后端（Rust）

| ID | 位置 | 改动 | 对应缺口 |
|---|---|---|---|
| B1 | `crates/agent-vitals-runtime/src/summary.rs::unresolved_billing_groups` + 新 Tauri 命令 `billing_confirmation_groups(month)`（`apps/desktop/src-tauri/src/lib.rs`，注册进 `generate_handler!`） | 把 `estimated_cost_minor: null` 换成 `estimated_amounts: [{currency, amount_minor, basis:"metered_estimate", pricing_version}]`，计价复用 `mcp/cost_breakdown.rs::collect_window` 的桶计价——把「桶 → 金额」抽成 `agent-vitals-runtime` 内可复用函数，`cost_breakdown` 与本命令共用；无价卡组 `estimated_amounts=[]` 并给 `unresolved_reason` | G5、G4 |
| B2 | `crates/agent-vitals-data/src/authority.rs::billing_declaration_impact_preview_for` + `lib.rs::billing_candidate_impact_preview` | 返回结构扩为 `{moved: {facts, sessions, tokens, amounts[]}, kept: {...}, pending: {tokens, reasons[]}}`；窗口由 `effective_start..=effective_end` 推出，命令签名去掉 `window_*_ms`；`route` scope 用于把冲突证据归入 `pending` | G2、G4、E207 |
| B3 | `lib.rs::save_billing_declaration_revision` | 桌面命令层校验（v1.3）：`effective_start` 必填且不晚于今天（北京时间）；`effective_end` **选填**——留空/空串＝持续有效，填了则 `>= start` 且 `<=` 今天；`relationship_kind != "unknown"`；**v1.5：所有关系种类**都在同一命令内 `billing_recalculation_enqueue` 并 spawn worker、返回 `job_id`——非订阅重算写 `user_declared`，金额不变（D02），但待确认组认它，确认后行关掉（撤销重开）。此前只有 `official_subscription` 入队，third_party 声明无任何消费方、行永远留在待确认（2026-09-16 真机）。数据层 `billing_declaration_revision_save` 不改（MCP 面保持通用） | G3、G6 |
| B4 | `crates/agent-vitals-data/src/issues.rs` 的 `BILLING_CONFIRMATION` 投影 | 除 pending 候选外，把 `unresolved_billing_groups` 的组也投影为 `billing_group` 来源，`source_kind` 区分，同对象同原因去重（B09 已有规则） | AC28 找回 |
| B5 | `lib.rs::billing_declaration_impact_preview`（`:2405`）与 `runtime::summary::billing_declaration_impact_preview`（`summary.rs:950`） | 删除（前端零调用；MCP `declaration_preview` 直接走 db 方法 `billing_declaration_impact_preview_for`，不受影响）；`generate_handler!` 同步移除；`tauri-mock.js:526` 对未知命令抛 `Unsupported browser mock command`，jsdom 守卫中任何残留调用都会失败 | 孤儿端点 |
| B6 | `lib.rs::resolve_billing_import_candidate` | 保留 `dismiss/reopen`；`accept` 分支改为拒绝（返回错误「请通过确认计费方式保存声明」），因为 accept 由 `save` 在事务内完成（`authority.rs:2127-2134`） | G1 |

不改：schema（v13 不动）、`billing_workflow` MCP 面、`billing_recalculation_run` 的原子发布、谓词。

### 6.2 前端（`apps/desktop/src-tauri/ui/workbench.js` / `.html` / `.css`）

| ID | 改动 | 对应 |
|---|---|---|
| F1 | `loadOverviewData` 的 `candidates` 行改为并发读 `billing_confirmation_groups(statisticsMonth())` + `billing_import_candidates`；`renderBillingImportCandidates` 重命名为 `renderBillingConfirmation`，输入为组列表（候选合并为组的证据行） | G5、G1 |
| F2 | 面板保持在设置 › 计费与套餐分区（`switchTab("sources")` 即设置 tab）；本条按 v1.1 更正为「不改」 | §5.2 |
| F3 | 组行主按钮唯一「确认计费方式」；去掉「是我的套餐 / 不是」；候选证据行的「这不是我的套餐」→ `dismiss` | G1 |
| F4 | 声明面板：五选一 + 每项结果说明；起止日期控件（默认组的首尾日，`end` **选填**——日期行下的「持续有效（不设结束日期）」勾选框，v1.3）；作用范围固定「仅这一组」+ 可改日期 | §5.3、§5.4、§5.4a |
| F5 | 预览调用改为无 `window_*`，渲染三组数字与分币金额；非订阅关系时「移出」显示 0 并注明不改金额 | §5.5 |
| F6 | 「确认并保存声明」单按钮：save → 用返回的 `job_id` 轮询；删除 `ov-billing-apply` 及其 onclick | G6 |
| F7 | 失败回执 `error_code` 文案映射；重复入队提示 | §5.10 |
| F8 | `tauri-mock.js` 新增 `billing_confirmation_groups` 与新预览形状的 fixture，**注明来源函数与行号**（CLAUDE.md 形状来源纪律） | 合同测试 |

## 7. 不变量与测试

### 7.1 Rust（各在既有测试文件旁）

- R1 `authority.rs`：预览（新签名）与 `billing_declaration_matching_fact_ids` 对同一修订返回**相同事实集合**（`fact_count` 相等、`total_tokens` 相等）——这是 G2 的直接钉子。
- R2 `authority.rs`：`effective_end` 为空的修订重算后，再同步一条更晚的事实 → 该事实**拿不到**归因行、仍是按量估算（重算不会自己再跑，§5.4a）；对已成功的任务调 `retry` 是 no-op（`billing_recalculation_retry` 只收 `failed`/`cancelled`）。桌面命令层 B3（v1.3）**接受**空 `effective_end`，只拒绝非法起始与「倒置 / 晚于今天」的结束（在 `lib.rs` 单测钉住）。
- R3 `summary.rs`：`unresolved_billing_groups` 在一组被 `official_subscription` 重算后消失，撤销后重新出现；`official_api/organization/third_party` 重算后**不**消失。
- R4 `lib.rs`：`save_billing_declaration_revision` 收到 `relationship_kind="unknown"` 返回错误，`billing_declarations` 无新行。
- R5 `cost_breakdown.rs` ↔ 新预览：同一隔离库上，`cost_breakdown` 的 `subscription` 桶金额 == 预览 `moved.amounts`（同币逐位）。
- R6 `lib.rs`：`accept` 分支返回错误且候选状态不变。
- R7 既有 `mutation_requires_explicit_local_write_permission`、`billing_declaration_revisions_are_scoped_immutable_and_revocable`、`unified_groups_include_source_failures_and_pending_candidates_without_merging` 保持通过；后者扩一条「只有组、无候选」的用例。

### 7.2 结构守卫（`scripts/verify-workbench-*.mjs`，jsdom + `tauri-mock.js`）

- V1 `workbench.js` 不再出现字符串 `billing_declaration_impact_preview`、`ov-billing-apply`、`switchTab("sources")` 于计费路径。
- V2 预览渲染出的三组数字与 mock fixture 逐字段一致；多币不相加（fixture 放 CNY+USD）。
- V3 组列表排序：金额降序，无价卡组在后。
- V4 「仍不确定」两次点击后：无 `save_billing_declaration_revision` 调用、`localStorage` 写入 `BILLING_REVIEW_DEFER_KEY`。

### 7.3 隔离环境 smoke（已有 `tests/mcp_v1_management_smoke.py`）

- 保持 29 步通过；新增 3 步：`declaration_preview` 的 `effective_end` 为空与非空各一次，断言非空时 `fact_count` ≤ 空时；`recalc_run` 后 `candidate_list` 中来源候选为 `accepted`。
- 桌面命令层没有 MCP 等价面，B3/B6 只能靠 R2/R4/R6 单测 + 真机。

### 7.4 真机（唯一能关闭 AC 的证据；发布规格 §5：不以 `tauri dev`/mock 替代）

| 小闭环 | AC | 步骤（同一脱敏可回滚数据根） | 必须留下的证据 |
|---|---|---|---|
| Loop 18-22 | AC26 | 迁移出候选 → 总览 | 提示三要素截图；`data-unresolved --month` 组列表 |
| Loop 24-28 | AC27 | 组 → 官方订阅 → 预览 → 确认并保存 → 回执 succeeded → 总览/日历/会话 → CLI/MCP | §5.7 的五处对拍逐位相等 |
| Loop 41/12 | AC13 | 撤销 → 回执 → 三面 | 金额回到确认前；`data-reimport-verify` 通过 |
| Loop 28 | AC28 | 仍不确定 / 稍后 → 退出重开 → 待处理/设置找回 | 首屏无提示截图；待处理有组；`billing_declarations` 无新行 |
| Loop 20-22 | AC14 | 入队 → `kill -9` → 重开 → failed(interrupted) → 重试 → succeeded | 事实计数不变；归因无重复；结果每 job 一行 |

真机走查需要桌面 Computer Use 或人工；本仓库的编码代理只能交付 §7.1–7.3 与构建好的候选 `.app`，不能自证 §7.4。

## 8. 决策记录（待拍板项标 ⏳）

- **D1 候选主按钮语义（G1）**：采纳「组为主体、候选为证据」，去掉「是我的套餐」直接 accept。替代方案「accept 自动创建 official_subscription 声明并入队」被否：它跳过预览，违反 REQ-026「保存前预览」。
- **D2 30 天降级存在 localStorage**：Beta 保留。代价：换数据根/清 webview 存储会重新提示；诊断导出看不到。收益：不动 schema v13、不给权威库加 UI 偏好表。正式版若要跨设备一致再入库。
- **D3 声明日期边界 = 北京自然日**：已实现并在 UI 标注；旧 `YYYY-MM` 数据按月首日/末日兼容读取。统计时区改动不影响声明日期。
- **D4 删除修订级预览端点（B5）**：删。理由：Beta 无原位编辑；保留会让 `generate_handler!` 暴露一条无 UI、无 mock、无守卫的命令。
- **D5 撤销不重算**：维持数据层现状，理由见 §3 事实 2；回执文案说明「立即生效」。
- **D6 非订阅关系不改金额**：维持并在 UI 明示（§5.3 结果说明列）。⏳ 产品是否接受「组织承担」在 Beta 只是标签——若不接受，需要 D01 的付款方模型，超出 Beta。
- ⏳ **D7 组键是否含 `model_id`**：本规格按 REQ-023 含模型。若真机发现同 provider 多模型导致组过碎（用户要逐个确认），可退到 `harness × provider × evidence_basis`，但 `scopes` 仍按模型写多条，不得写空 scope。

## 9. 执行顺序与出口

1. B5、B6、R4、R6（半天）：先关掉会误导的面（孤儿端点、accept 直通）。
2. B2 + R1 + R5（1 天）：预览 = 写入范围 + 金额；这是 T08 的前提。
3. B1 + B4 + F1–F3 + V3（1–1.5 天）：组面板与待处理投影。
4. B3 + F4–F7 + V1/V2/V4（1 天）：范围纪律、单按钮保存、回执与失败文案。
5. 7.3 smoke 扩展 + 构建候选 `.app`（半天）→ 交真机 §7.4。

P2 出口（执行计划 §6）：同一隔离数据根上「候选/组 → 预览 → 保存 → 重算 → 各面刷新 → 撤销」与「仍不确定 → 重开 → 找回」两条真实 App 路径通过，底层表守恒；不能用 MCP 写操作或 Vite mock 关闭 T06/T08/T10。

出口前不得做的事：不因 T08 数字对不上而放宽谓词或改价卡；不为让「组织承担」看起来有效而伪造金额变化；不把 `unknown` 写成声明去消掉黄色状态（REQ-031）。

## 10. 执行记录（2026-09-15，分支 `worktree-v1.0.0-beta1-p2-billing-chain`）

| 提交 | 覆盖 | 验证 |
|---|---|---|
| `37bce83` | B5、B6、B3 后端（孤儿端点删除；`accept` 拒绝；`unknown`/空 `effective_end`/晚于当月拒绝；官方订阅保存即入队并返回 `job`） | R4、R6（`lib.rs` 单测） |
| `6436c5e` | B2：`authority::billing_declaration_fact_selection` 唯一谓词；预览窗口 = 声明有效期；`conflict` 证据单列；`runtime::billing_preview::declaration_impact_preview` 三组数字 + 分币金额，计价走 `cost_breakdown::price_fact_selection` | R1（`authority.rs::preview_and_recalculation_select_the_same_facts`）、R5（`billing_preview.rs::preview_moved_amounts_equal_cost_breakdown_subscription_bucket_after_recalc`） |
| `ed1749c` | B1、B4、F1–F7：`SQL_UNRESOLVED_BILLING_GROUPS` 单一定义、`billing_confirmation_groups` 命令、待处理 `billing_group` 投影、组面板、有界起止日期、单动作保存、回执/撤销/重试、error_code 文案、mock 形状出处 | R3、V1–V4（`verify-workbench-sources.mjs` 计费段）、`verify-workbench-overview-contract.mjs` |
| 本次 | §7.3 smoke +3 步；clippy 类型别名 | `tests/mcp_v1_management_smoke.py`（22 typed actions，`--features mcp-internal` 内部构建） |

全量门：`cargo test`（根 workspace 全绿）、`cargo clippy --release --all-targets -- -D warnings`、
桌面 crate `cargo test --lib`（116）与 clippy、`python3 -m unittest discover tests`（1189，
skipped 208）、golden 15/15（Python 与 Rust 二进制各一遍）、全部 `scripts/verify-workbench-*.mjs`。
候选 `.app`：`cargo tauri build --ci --bundles app` → `CFBundleShortVersionString = 1.0.0-beta.1`、
随包 CLI `1.3.0`、arm64；未签名（G09 未做，内部测试构建）。

**仍未关闭（只能靠真机）**：§7.4 五条小闭环（AC26/27/13/28/14）的截图与五处对拍。编码代理
不能驱动 Tauri 窗口；候选包在 `apps/desktop/src-tauri/target/release/bundle/macos/agent-vitals.app`。

### 10.1 v1.2 收敛（2026-09-15，分支 `worktree-v1.0.0-beta1-p2-clarify-billing`）

- 数据层：schema v13 → **v14**，`billing_declaration_scopes.scope_kind` 词表加 `provider`（唯一合法值 `unresolved`）；`billing_declaration_fact_selection` 据此把 `f.provider_id = ?2` 换成 `IS NULL`（`authority.rs` 测试 `provider_unresolved_scope_targets_null_provider_facts_only`）。既有库在 open 时原地迁移（重建表搬行、重建索引）。
- 前端：`openBillingDeclaration(target, rows)` 按缺什么问什么 + 批量勾选；`refreshAfterBillingChange()` 作废三处缓存并重拉当前页；待处理页 `billing_group` 项入口同样打开该弹窗；文案「明确计费方式」。
- 守卫：`verify-workbench-sources.mjs` 计费段重写（三步表单、批量、服务商未知、月费未知不补挂牌价、缓存作废、仍不确定不写声明/归属）；`verify-workbench-kpi-decide.mjs` 待处理入口文案。
- 全量门：根 workspace `cargo test` / clippy、桌面 116 单测 / clippy、Python 1189、golden 15/15（Python + Rust 二进制）、全部 `verify-workbench-*.mjs`、两条 MCP smoke。

### 10.2 v1.3 结束日期选填（2026-09-16，同一分支）

- **决定**：声明的 `effective_end` 改为**选填**，留空＝持续有效（开放到未来）。触发是产品侧的用例——按量充值 / 长期付费的关系「不知道哪天结束」，强制填结束日等于让用户编一个日期出来。
- **推理修正**：v1.2 把「开放期」当成「自动扩展开关」而选择堵住（§3 事实 3 原文），但重算**没有**任何周期性重跑（`UNIQUE(revision_id)` + 成功即终态 + `recover` 只恢复已排队任务），所以留空既不改写已写归因，也不会自动覆盖后来同步进来的事实。允许之后不会引入「静默扩展」。见 §3 事实 3 的 v1.3 修正与 §5.4a。
- **改动面**：`lib.rs::validate_desktop_declaration`（空 end 放行；仍拒非法起始、倒置的结束、晚于今天）；`workbench.html` 结束字段文案（「结束（选填）」）＋日期行下的「持续有效（不设结束日期）」勾选框；`workbench.js`（新增 `syncBillingOpenEnded` 作为不设结束日期的唯一入口、保存校验、三处 `invoke` 发 `null`、新增 `billingRangeText` 统一区间文案、`syncBillingDateBounds` 不把清空的字段填回去、作用范围句写「持续有效」、订阅分支强制撤销勾选）。
- **守卫**：`lib.rs` 单测改名 `desktop_declaration_is_bounded_when_dated_and_open_ended_when_blank`；`verify-workbench-sources.mjs` 新增 5 条断言（默认不勾即保持有界、勾选后字段清空并禁用且作用范围写「持续有效」、勾选经 restep 仍在、预览发 `null`、保存发 `null`），并已确认回退时会红（摘掉勾选框的事件绑定后该段直接抛错）。
- **留空的边界**（验收别误读）：留空声明的覆盖停在**保存那一刻**已入库的事实，之后同步进来的用量仍按量。对 `official_subscription` 以外的四种 kind，这不影响金额——它们写 `user_declared`，而排除谓词只认 `subscription_covered`。订阅路径当时写成「锚点 – 今天」，**已在 §10.3 改为持续有效**（订阅月费是按月付的，写成今天会让它次月归零）；订阅覆盖未来用量仍需一条显式的重跑路径（成功任务终态，`retry` 不收成功任务），**未做，属独立决定**。

### 10.3 声明的订阅月费进入「实际支出」（2026-09-16，同一分支）

- **决定**：用户在「明确计费方式」里填的**月费**进入 `by_provider` 的 `FixedSubscription` 档，也就是概况「订阅月费」那一行与「实际支出」的订阅档（§2.3 的澄清）。
- **根因是三处独立断链**（2026-09-16 真机：声明了 anthropic 20 USD/月，概况仍写「尚未设置套餐或账单」）：
  1. `apply_subscription_fees` 只枚举价目表的 `catalog_2026_09.subscriptions`，而内置 `assets/pricing.json` **没有这一节**（整个文件无 `amount_per_month`）；
  2. 设置 › 价格目录只能写**价卡**与**归属**（`price_overrides` 的 `cards`/`routes`），写不了订阅——那条路用户也走不通；
  3. 订阅声明把结束日写成**今天**，即便接上了，月费也会在次月归零。
  声明行的 `amount_minor`/`currency` 此前**没有任何算钱的消费方**（只有内部 MCP 与「当前计费声明」列表读那张表），所以那 20 USD 在任何数字上都不出现。
- **改动面**：`summary.rs` 新增 `declared_subscription_fees` + `apply_declared_subscription_fees`，月费落地抽成 `add_fixed_subscription_fee` 供价目表与声明两条来源共用；调用点仍是 `monthly_summary`（`db` 与 `apply_harness_bills` 同处可取）。**声明优先**：同一 provider 上价目表那条让位，一笔月费不摊两次。`billing_declarations` 是当前态表、撤销会软删它 → **撤销即停止扣**。
- **四条边界**（单测钉住）：非 `official_subscription` 不摊（§3 事实 1）；金额或币种缺失不摊、不记 0（弹窗允许「金额暂不清楚」）；早于生效月不摊；晚于结束月不摊（到期后继续收月费是编造）。只进月、不进日。
- **订阅改为持续有效**：`syncBillingDeclarationSteps` 的订阅分支不再写 `end = today`，改为勾上「持续有效」（结束日留空）。离开订阅（切按量/组织/中转）**必须一并撤回这个勾**——否则按量声明会被静默留成开放期（守卫 `verify-workbench-sources` 的 #5 断言抓到）。
- **守卫**：`summary.rs` 三条单测，其中一条是**接线**测试（走 `monthly_summary` DTO）——只钉函数会漏掉「函数没被调用」这一类；`verify-workbench-sources.mjs` 的订阅路径断言改判 `effectiveEnd === null`，并新增离开订阅撤回勾选的断言。
