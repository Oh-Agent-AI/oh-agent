# 决策区 React 移植 Spec（值回双轨 + 套餐窗口卡）

> 状态：**Draft v1.0（2026-09-30，未实施）**。
> 触发：用户对旧控制面板两项功能的记忆核实（2026-09-30）——React cutover 丢失了
> 旧总览「决策区」的两个组件：值回双轨列表与「现在该用谁」套餐窗口卡。两者在
> 旧 UI 中同属一个用户目标（**现在该用谁 / 这订阅值不值**），数据与后端 IPC
> 全部健在，纯前端移植。
> 关联：`ROUTE_UNIT_COST_DECISION_SPEC` §8.3.2（Claude 永无百分比）、
> `LANDING_VALUE_FIRST_SPEC` V1.1（产品先于页面）、精益画布痛点①（订阅覆盖
> 看不懂）。本 spec **不含** landing 内容位——按 V1.1 纪律，移植落地并截到
> 真图后另议上页。

---

## 0. 一句话结论

把旧总览决策区的两个组件按原语义移植到 React OverviewPage：**值回双轨**
（逐 provider/harness：申报月费 vs 名义 API 等价（参考），值回倍数三态 chip，
未填月费给设置指引）与**套餐窗口卡**（Codex 真实余量 meter+重置时刻、
Claude 三态永无百分比、无证据执行环境只显利用率）——后端零改动（两个 quota
IPC 命令与 monthly DTO 既有），全部新文案走 i18n 双语，契约脚本钉住
诚实红线（永无 Claude 百分比、值回措辞闭集、三态空态）。

---

## 1. 不可变决策（实施期间不重开）

1. **Claude 永无"剩余 N%"**（ROUTE_UNIT_COST_DECISION_SPEC §8.3.2）：
   只有 `unknown` / `exhausted（+ 重置时刻）`；契约脚本断言源码不含对
   claude 配额取百分比的路径。
2. **值回倍数的措辞闭集**：`值回月费 X.X×` / `⚠ 没用够（只值回月费的
   X.XX×）`（mult < 0.5）/ `⚠ 数字异常（折算为月费的 N 倍），请核对套餐`
   （mult > 50）。倍数基于**申报月费**（价目表订阅 + billing_declarations），
   声明"非付款验证"；**禁止**出现「可节省 / 省下 / 亏了」——展示倍数，
   退订判断留给用户。
3. **quota 快照三重守卫原样移植**（workbench.js:4379-4382 语义）：快照缺失/
   超 24h / 未来时间 / 已过重置时刻 → 显示「读不到套餐额度」，不把过期
   快照当现值、不把未知当零。
4. **三种空态分开**（沿 REQ-043 纪律）：读不到 DTO（无数据）/ 有用量未
   申报（「尚未设置套餐或账单」+ 指引链接到 `#settings` 的 billing 分区
   `settings-billing`）/ 无用量（无数据）。
5. **后端零改动**：`data_claude_quota` / `data_codex_quota`（lib.rs:4536+）
   与 monthly `by_provider.amounts_by_basis`（含 `fixed_subscription` /
   `api_equivalent`，React 桥已解析，tauri.ts:378/745）原样消费；本 spec
   只新增 React 桥包装（严格解析 + 拒绝）与 UI。golden/Python 零漂移是
   验收线（预期零 Rust 变更）。
6. **全部新文案走 i18n**（`message()`/`tr()` 键，zh+en 同批落）——与
   us-launch 方向一致；英文不是机械翻译。
7. 不做新通知：`quota_alerts`（每窗口一次、重置后再撞窗再提醒）已存在且
   已接 SettingsPage 开关，本 spec 不动它。
8. 不跑 rustfmt / 不做自动格式化；契约脚本同步扩展（overview 契约）。

## 2. 现状与缺陷（证据）

| # | 缺陷 | 证据 |
|---|---|---|
| 1 | 值回双轨丢失：React 无任何 `值回/没用够` 呈现 | grep React 零命中；旧实现 workbench.js:4251-4330（`值回月费 ${mult}×` :4327、`没用够` :4326、未填月费指引 :4323、`api_equivalent（参考）` chip :4316） |
| 2 | 套餐窗口卡丢失：React 不消费两个 quota IPC | tauri.ts 无 `data_claude_quota`/`data_codex_quota`；旧实现 workbench.js:4359-4400（Codex meter+`重置` :4389、三重守卫 :4379-4382、`读不到套餐额度` :4391、Claude 三态 :4400+） |
| 3 | 后端全部健在 | IPC lib.rs:4536+（claude，含 now 注入）/ codex 同族；`quota_alerts.rs` 通知与 SettingsPage 开关已迁移 |
| 4 | monthly DTO 的 basis 数据已到前端 | tauri.ts:378/745（`fixed_subscription`/`api_equivalent` 闭集解析） |

## 3. 目标结构（React OverviewPage，置于支出卡与发现条之间）

```
OverviewPage
 ├─ 支出卡（现状不动）
 ├─ 【新】决策区
 │   ├─ 套餐窗口卡「现在该用谁」
 │   │    Codex（订阅）：[====剩余 42%====] 剩余 42% · 10-01 14:00 重置
 │   │    Claude Pro：已耗尽 · 10-01 03:00 重置 ｜ 状态未知（两种诚实态）
 │   │    （无证据执行环境不进此卡，只在双轨里以利用率行呈现）
 │   └─ 值回双轨列表（按 provider，执行环境为副行）
 │        订阅（固定月费）¥140 · 名义 API 等价 $322（参考）
 │        [值回月费 2.3×] ｜ [⚠ 没用够（只值回月费的 0.42×）]
 │        [未填写月费，去填写 ›]（链接 #settings / settings-billing）
 │        has_unresolved → 既有 unresolved chip 复用
 ├─ 内嵌发现条（现状不动）
 └─ …
```

## 4. 设计

### 4.1 R1 · 桥接层（~0.5 天）

1. `readClaudeQuota()` / `readCodexQuota()`：invoke 包装 + 严格解析
   （codex：`plan_type`/`limits.primary.{used_percent,resets_at}`/
   `observed_at`，数值界检查 used_percent∈[0,100]、resets_at 正整数秒；
   claude：`{state: "unknown"|"exhausted", resets_at?, window?}` 闭集；
   越界/畸形 → 抛错进既有错误态，不静默）。
2. 无 handler（浏览器 mock）时返回显式 `unavailable`（与既有桥降级一致）。
3. 刷新挂载：随 OverviewPage 现有 gate/revision 刷新轮（Invalidated /
   SourceDataDeleted 走既有门），不加独立轮询。

### 4.2 R2 · 套餐窗口卡（~1 天）

1. Codex 行：守卫通过 → meter（剩余% = 100−used，<15% danger）+
   `剩余 N% · {MM-DD HH:mm} 重置`；守卫不过 → 「读不到套餐额度」中性 chip。
2. Claude 行：`exhausted` → `已耗尽 · {重置时刻}（{5 小时窗口|7 天窗口}）`；
   `unknown` → `状态未知`；**绝不渲染百分比**（§1-1）。
3. 卡头小字：`余量为快照，非官方实时`；`快照 {observed_at}` 时间戳行。

### 4.3 R3 · 值回双轨列表（~1.5 天）

1. 数据：monthly `by_provider`（harness 并入 provider 副行的既有分组语义，
   与旧 `groupByProvider(byProvider, byHarness)` 对齐；如 React 侧缺此分组
   则在组件内实现同规则）。
2. 行内容：provider 名 + `fixed_subscription` chip + `api_equivalent
   （参考）` chip（分币，不混加）+ 值回 chip 三态（§1-2 闭集）+
   `has_unresolved` → 既有 chip。
3. 空态：`fee==0 && listEq>0` → 「尚未设置套餐或账单」+ 指引
   `去填写 ›`（`#settings`，聚焦 `settings-billing` 分区）；双零 → 「无数据」；
   DTO 失败 → 「本月支出明细暂不可读」。
4. i18n：全部新串进 message 目录（zh+en），含 chip 文案与空态。

### 4.4 R4 · 契约扩展（~0.5 天，`verify-react-overview-contract.mjs`）

- 断言 OverviewPage 源：存在值回三态串与 `api_equivalent`（参考）标注；
  存在「读不到套餐额度」「尚未设置套餐或账单」空态；存在 settings-billing
  指引链接。
- 断言源码中 claude 配额路径不含 `百分比|percent` 计算（守 §1-1）。
- 断言禁词：`可节省|省下|亏了` 不出现在新组件源。
- 既有断言全绿不回退。

## 5. 明确不做

- 不动后端命令/DTO/通知；不做 Claude 正向余量（数据边界）；不做自动
  退订/换模型建议（倍数展示，判断归用户）；不做跨月值回趋势（后续）；
- 不含 landing 内容位（按 LANDING V1.1：产品落地+真图后另议，候选为 B3
  组强化或第四组）；
- 不重排现有支出卡/发现条。

## 6. 分期与进度（验收绿后打勾）

- [ ] R1 桥接（解析严格 + mock 降级）
- [ ] R2 套餐窗口卡（三守卫 + 三态 + i18n）
- [ ] R3 值回双轨（三态 chip + 三种空态 + 指引链接）
- [ ] R4 契约扩展 + 全量 verify:react 绿
- [ ] 手测清单（§7.2）+ 真机截图存档（为后续 landing 候选留证）

## 7. 验收标准

1. `verify:react` 全绿（含新断言）；tsc 干净；Rust 侧零 diff（golden/Python
   不跑也应有零漂移预期，抽查 golden 16 条确认）。
2. 手测：① Codex 有快照时 meter+重置时刻正确、快照过期显示读不到；
   ② Claude exhausted 显示重置、unknown 显示状态未知、无百分比出现；
   ③ 造一个 fee>0&listEq>0 的 provider 看值回 chip 三态（0.4×/2.3×/>50×）；
   ④ 未申报月费时空态 + 点击指引进 settings-billing 分区；
   ⑤ zh/en 双语切换文案完整。
3. 契约负向自测：注入「可节省」与 claude 百分比计算各一次应红。

## 8. 风险与守卫

| 风险 | 守卫 |
|---|---|
| 值回倍数被读成"省钱承诺" | 措辞闭集 + 「非付款验证」小字 + 契约禁词 |
| 过期 quota 快照误导 | 三重守卫客户端镜像 + 快照时间戳行 |
| 分组规则与旧版漂移（provider×harness） | 与旧 `groupByProvider` 同规则 + 测试数据对拍 |
| i18n 缺英文致 us-launch 回归 | zh+en 同批落 + 契约断言键存在 |

## 9. 测试矩阵

| 层 | 测试 | 阶段 |
|---|---|---|
| 桥 | 畸形 quota DTO 拒绝 / mock 降级 / 数值界 | R1 |
| 契约 | 值回三态串 / 空态三态 / 指引链接 / 禁词 / claude 无百分比 | R4 |
| 手测 | §7.2 五项 | 收尾 |
| 回归 | verify:react 全量 + tsc | 每阶段 |
