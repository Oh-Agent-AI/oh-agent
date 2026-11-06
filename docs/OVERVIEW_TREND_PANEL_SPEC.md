# Overview 用量趋势面板（今日逐小时堆叠 + 失败小时标记）SPEC v1.1

> **v1.1 重设计（2026-10-01，用户评审否决 v1.0）**：v1.0 的「当月逐日柱」在月初
> 只有一根孤柱，形态随日期剧烈变化，被判定为废形态。改为「今日逐小时 24 列」
> ——与用量页「当日按小时」同族形态，恒定 24 列、随时段累积，回答的是更即时的
> 问题（现在哪个时段在烧、哪个时段在炸）。失败标记同步从日粒度降到小时粒度
> （`opened_at_ms` 本就是毫秒时间戳）。小时 token 复用既有
> `read_hourly_distribution` 命令，不新增 token 读路径。

状态：**已实施**（2026-10-01，v1.1）；其中「只做今日 / 不做切换 / 零新读路径」三条已被 `OVERVIEW_TREND_RANGE_SPEC.md` v2.0 取代（失败族规则、计数语义、null≠零、r6 仍有效）。来源：落地页「产品演示」的概念图里有「按执行环境堆叠的每日
用量柱状图 + 有连续失败的日期高亮」（`website/landing/index.html` demo 区，明确标注为模拟
数据）。真实应用一直没这个形态：用量在用量页是月历热图 + 当日小时柱，失败信号在总览发现
条 / 发现页。本 spec 把演示承诺的「一眼看到用量走势 + 哪天在反复失败」落成总览顶部的一个
真实数据面板。

## 1. 目标与非目标

**目标**
- 总览统计卡下方新增「今日逐小时」面板：24 列（00–23）小时堆叠柱（DSH /
  Claude Code / Codex 三段，token 高度），有反复失败类发现的小时加橙色标记。
- 每根小时柱可点击，深链到当天会话（复用 R1 `sessionsDateHref`，不新增导航机制）。
- 小时 token 复用既有 `read_hourly_distribution` 命令；失败小时复用发现引擎的
  既有落库（`issue_instances`）——零新 ingest、零 schema 变更、零新 Tauri command。

**非目标**
- 不放任何金额（r6 红线：诊断/趋势信息不带钱；成本继续留在统计卡与决策区）。
- 不做日期切换/跨日滚动（面板固定跟随 `read_overview_details_snapshot` 的今日；
  历史去看用量页月历 + 当日小时，那边已有完整导航）。
- 不重算「连续失败」语义——标记忠实反映发现引擎已判定的问题，不在查询层新造规则。

## 2. 失败小时判定（数据契约）

**规则族**（与 `docs/AGENT_EXECUTION_PROBLEM_TAXONOMY.md` 注册的 trajectory 失败族一致）：
`SV611`（同一调用连续重复 ≥3 次）、`SV612`（turn 死循环）、`SV613`（进度停滞：连续
turn/工具失败），并兼容 legacy 规则名 `retry_loop`、`tool_failure`。列表是**规则级**而非
执行环境级——不写执行环境特化 SQL（数据完整性 watchlist 的 harness-agnostic 要求）。

**计数语义**：某小时 = `opened_at_ms` 落入该统计日该小时的失败族 issue 实例数（含任意
status：open / acknowledged / resolved / wontfix——标记表达「这小时发生过反复失败」这一
历史事实，用户对单条 issue 的处置不抹掉历史）。`UNIQUE(machine_namespace, issue_type,
instance_fingerprint)` 已在落库层去重，直接 COUNT 即可。

**小时桶**：与 `read_hourly_distribution` 同一条日界与口径——`beijing_day_bounds_ms`
（系统统计时区）日窗 + 统计时区**墙钟小时**（jiff `to_zoned(statistics_timezone()).hour()`，
与 token 柱的 SQLite `strftime('%H', …, 'localtime')` 对齐；不用「距日界流逝小时」，
DST 换日日两者会差一列）。

**输出**：`read_overview_details_snapshot` 增加 `failure_hours` 键：

```json
{ "date": "2026-10-01", "hours": { "9": 3, "14": 1 } }
```

键 `"0".."23"`；无数据小时不出键；权威库不可用或日期非法 → `null`（不是 `{"hours":{}}`
——null 表示「读不到」，空对象表示「读到了、零失败」，两者不得混同）。

## 3. 后端改动

1. `crates/agent-vitals-data/src/issues.rs` 新增
   `pub fn failure_hours_day(conn: &Connection, date: &str) -> Option<Value>`：
   - `beijing_day_bounds_ms(date)` 取窗口（None → 返回 None，非法日期不猜）。
   - `SELECT opened_at_ms FROM issue_instances WHERE issue_type IN (…) AND opened_at_ms >= ?1 AND opened_at_ms < ?2`（规则名是编译期常量内联，仅时间窗走绑定参数）。
   - Rust 侧按统计时区墙钟小时分桶，组装 `{"date", "hours": {hour: count}}`。
2. `apps/desktop/src-tauri/src/lib.rs` `overview_details_snapshot_at`：在 revision 采样
   循环内追加 `"failure_hours"`——与 monthly/daily/calendar 同一一致性窗口，不另开读路径。
3. Rust 测试（`issues.rs` tests，临时库）：
   - 小时桶（02:30 × 2 → "2"、09:59 → "9"）；
   - 非失败族规则（SV601、USAGE_GROWTH 类）不计入；
   - 日窗边界外（前日 23:59 尾部、次日 00:01）不计入；非法日期（02-30）→ None、
     合法空日 → 空 hours。

## 4. 前端改动

1. `lib/tauri.ts`：`OverviewDetails.failure_hours: Record<string, number> | null`；解析
   **容错降级**——键缺失、形状不对、外层 `date` 与请求日不一致、任一条目非法（键非
   0–23、值非正整数）→ 整体 `null`，不抛错（失败标记坏不该连累 token 面板，坏数据
   也不能丢弃后冒充真零）。
2. `features/overview/OverviewPage.tsx` 新增 `TrendPanel`：
   - 位置：统计卡之后、月/日汇总面板之前（「放在总览上面一目了然」）。
   - 恒定 24 列；高度 = 该小时 total / 当日峰值小时；三段堆叠 DSH（底）/
     Claude Code / Codex（顶）；空小时画 2px 灰基线。
   - 失败小时：柱下橙色圆点；`failure_hours` 为 null → 柱照画、图例处诚实标注
     「失败标记不可用」；空对象 → 无标记（真零）。
   - 每柱 `<a href={sessionsDateHref(details.date)}>`，aria/title 含小时、token、失败
     条数；零 token 且有失败的小时仍渲染标记点（诚实：没用量≠没失败）。
   - 小时数据读失败 → 「小时用量暂不可用」降级文案；读到且全零 → 诚实空态（仅在
     读取完成后显示，避免 loading 闪帧）。
   - 图例：DSH / Claude Code / Codex / 有反复失败。
3. `lib/i18n.ts`：新增 `overview.trendTitle / trendFailureLegend / trendFailureUnavailable /
   trendHourlyUnavailable / trendEmpty / trendNote / trendDayAria / trendDayFailures`
   （中英双语，占位符两侧一致，`translationIntegrityIssues` 机器校验）。
4. `public/tauri-mock.js`：`read_overview_details_snapshot` 返回
   `failure_hours: { date, hours: {"9":3,"14":1} }`（非请求日 → 空 hours，与日历窗口
   守卫同语义）；小时柱形状由既有 `read_hourly_distribution` mock 提供。
5. CSS：`react/src/styles.css` 平铺类（`.overview-trend*`），沿用现有配色变量，无新依赖。

## 5. 红线自查

- r6：面板只有 token 与失败标记，无任何金额。✓
- 计费诚实：不涉及。✓
- 隐私/服务面：纯本地读，无网络、无 MCP、无导出变化。✓
- Golden/Python-Rust parity：不动 CLI/golden 面（Tauri bundle 新键，mock+契约覆盖）。✓
## 6. 验收

1. `cargo test -p agent-vitals-data issues:: -p agent-vitals-desktop`（新测试绿）。
2. `cargo clippy --release --all-targets -- -D warnings`。
3. `npm run verify:react`（tsc + build + 全部契约脚本含 overview 契约新断言：
   TrendPanel 存在、深链走 nav helper、null 降级、mock 提供失败日、i18n 双语键齐全）。
4. subAgent 视觉验收：mock 数据下总览页截图——堆叠柱、失败标记、空态、降级态四景。
