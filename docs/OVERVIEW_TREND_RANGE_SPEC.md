# 用量趋势图：本日 / 本周 / 本月三档 + 共享图表组件 SPEC v2.0

状态：**已实施**（2026-10-01，T1–T6 + A1/A2/A3 验收，见 §7）。取代 `OVERVIEW_TREND_PANEL_SPEC.md` v1.1 中
「只做今日逐小时」「不做日期切换」「零新读路径」三条；v1.1 其余契约（失败族规则、
计数语义、null≠零、r6 无金额）继续有效。

## 0. 起因（视觉评审，2026-10-01）

对照落地页演示图（`website/landing/index.html` demo：按执行环境堆叠 + 失败日橙色高亮 +
`This week / This month` 切换 + 「View trace」提示）核对真实总览面板，问题如下：

1. **图太小**：24 柱缩在 ~1900px 宽卡片中间。实测（headless Chrome）根因是
   `.info-panel` 为 `display:flex` 横排，标题与图表被并排挤成一行，图只剩 244px
   （卡片 1170px）；`max-width: 22px` 柱宽上限只是次要因素。修复 = `.overview-trend
   { display:block }` + 去掉 px 上限，修后图宽 1080px/1170px，900px 窗口 580/670。
2. **无坐标轴 / 无数值**：看不出多少 token，仅靠 `title` tooltip。
3. **图例与数据不符**：图例列「有反复失败」橙色，但没失败时一点橙色都没有，读者分不清
   「今天没失败」与「没画出来」。
4. **只有「今日」**：演示承诺的周/月走势不存在。
5. **与用量页重复**：用量页「小时明细」（`UsagePage.tsx` `usage-hour-*`）与总览
   `TrendPanel` 调同一条 `read_hourly_distribution`，却各写一套渲染（总览堆叠+失败，
   用量页单色合计）。
6. 卡片与下一行间距不一致、标题层级弱（日期比标签大）。

## 1. 目标与非目标

**目标**
- G1 抽共享图表组件 `UsageTrendChart`，总览与用量页「小时明细」共用同一渲染。
- G2 总览面板支持三档：**本日**（24 小时）、**本周**（自然周 7 日，周一起）、
  **本月**（自然月，1 日 → 月末，未来日留空位）。
- G3 失败标记在三档都生效（日→小时、周/月→日）；读不到 → 诚实「失败标记不可用」，
  不画假零。
- G4 修视觉：柱铺满卡片、Y 轴刻度（max/中/0）、悬停即时数值、无失败时图例橙色项
  不出现（或换成「今日无反复失败」文案）、统一间距、标题层级。

**非目标**
- 不放金额（r6）。不做任意区间选择、不做跨月周以外的历史翻页（历史去用量页日历）。
- 不新增导出/MCP 面；不改 CLI/golden。
- 不重算失败语义，沿用 v1.1 §2 规则族。

## 2. 口径与数据契约

### 2.1 三档桶定义（统计时区 = `statisticsMonthAndDate(timezone)` 的同一时区）

| 档 | 桶数 | 桶 key | 数据源 | 失败源 |
|---|---|---|---|---|
| day | 24 | 小时 0–23 | `read_hourly_distribution(today)` | `failure_hours`（已有） |
| week | 7 | 周一…周日 7 个日期 | 日历 `UsageDay.{dsh,claude,codex}_tokens` | `failure_days`（新） |
| month | 当月天数 | 1…月末 | 同上 | `failure_days`（新） |

- **自然周**：周一为起点，含今天所在的周；今天之后的日期是**未来桶**（画空位，不画 0
  柱、不进峰值计算）。周起点由纯函数 `weekStartOf(date)`（前端，无时区陷阱：只对
  `YYYY-MM-DD` 做公历运算，不经 `Date` 本地时区）给出。
- **周跨月**：本周含上月日期时，额外 `readUsageCalendar(prevMonth)` 补上月那几天；
  读失败 → 那几天桶标 `unavailable`（灰斜纹，不是 0）。
- **月**：直接用快照里已有的 `calendar`（本月），零额外读取。
- 日历里**缺失的过去日期** = 无已观测事实 = 画 0 柱（与用量页「空格 = 没有已观测
  事实，不补造」一致）；与 `unavailable`（读不到）区分。

### 2.2 失败日聚合（后端新增）

`agent_vitals_data::issues::failure_days_range(conn, from, to) -> Option<Value>`：

```json
{ "from": "2026-09-01", "to": "2026-10-01", "days": { "2026-09-15": 3, "2026-10-01": 4 } }
```

- 规则族、计数语义（含任意 status）与 `failure_hours_day` 完全一致——**共用同一个
  常量与同一个日界函数**，不复制 SQL 白名单。
- 日归属：`opened_at_ms` 按统计时区**墙钟日期**分桶（`to_zoned(statistics_timezone())
  .date()`），与 `beijing_day_bounds_ms` 日窗一致。
- 窗口：`[from 日窗起, to 日窗止)`；任一日期非法、`from > to`、跨度 > 62 天 → `None`。
  无数据日不出键；合法空窗 = 空 `days`（读到零失败）；`None` = 读不到。
- 快照 `read_overview_details_snapshot` 增加 `failure_days` 键，窗口 = `[date-30d, date]`
  （一定覆盖「本月 1 日起」与「本周周一起」）。与 `failure_hours` 同一 revision 括号，
  **不新增 Tauri command**。

### 2.3 前端共享组件契约

```ts
type TrendBucket = {
  key: string;            // "09" | "2026-10-01"
  label: string;          // 轴标签（稀疏显示）
  dsh: number | null; claude: number | null; codex: number | null; // null=读不到
  failures: number | null;// null=失败标记不可用；0=读到零
  state: "ok" | "future" | "unavailable";
  href?: string;          // 钻取目标（总览：当天会话；用量页：不传）
};
```

`UsageTrendChart({ buckets, ariaLabel, showFailureLegend, onSelect? })`：
- 纯展示组件，不拉数据；三档与用量页各自装配 `buckets`（纯函数
  `buildHourBuckets` / `buildDayBuckets`，放 `features/usage/trendBuckets.ts`，可被
  `.mjs` 契约脚本直接 import 测试）。
- 柱宽 `flex:1`，**不设 max-width 上限**（日/周档用 `max-width` 仅限 week 档的 7 根
  粗柱，避免 7 根撑成巨块：`min(100%, 64px)`，其余档无限制）；高度 = bucket total /
  可见桶峰值；Y 轴三条刻度线（max、max/2、0），max 取「漂亮数」上取整。
- 悬停/聚焦出浮层：桶标签、三执行环境分项 tokens、失败条数（>0 时）。键盘可聚焦。
- 失败桶：柱顶橙色描边 + 底部橙点（演示图的「整根高亮」简化为描边，避免橙色吞掉
  堆叠色语义）。`failures === null` → 图例旁「失败标记不可用」；`failures === 0`
  全桶 → 图例里不出橙色项，改为文字「该范围无反复失败」。
- `state: future` → 无柱，仅淡轴位；`unavailable` → 灰斜纹占位。
- 柱可点（有 `href` 时是 `<a>`；`onSelect` 时是 `<button>`）。

### 2.4 用量页复用

「小时明细」换成 `UsageTrendChart`（`buildHourBuckets`，不传 `failures`、`href`）；
删除 `usage-hour-*` 专用 CSS 与渲染。选日期/加载/错误态不变。行为不倒退：空小时仍
是灰基线、`hourlyNote` 照留。

## 3. 红线自查

- r6：只有 token 与失败标记，无金额。
- 无假零：`null`/`unavailable` 与 0 三态分明（§2.1/2.3）。
- 隐私：纯本地读，无网络、无 MCP/导出变化。
- 单一规则族常量：失败族白名单只在 `issues.rs` 一处。
- 时区：周/月日期运算只在 `YYYY-MM-DD` 字符串/公历上做，不用本地 `Date`。

## 4. 任务拆分（每个任务：实现 → 测试 → 提交；阶段末 subAgent 验收）

| # | 任务 | 范围 | 验收（自动） |
|---|---|---|---|
| T1 | 后端 `failure_days_range` + 快照 `failure_days` | `issues.rs`、`lib.rs` | `cargo test -p agent-vitals-data issues::`；快照 JSON 单测；clippy |
| T2 | 前端数据层：`failure_days` 解析（容错降级）、`weekStartOf`、`buildHourBuckets/buildDayBuckets`、周跨月补读 | `lib/tauri.ts`、`features/usage/trendBuckets.ts`、`tauri-mock.js` | 新增 `.mjs` 纯函数契约脚本：周起点（周一/周日/月初/年初）、跨月、未来桶、null≠0 |
| T3 | 共享组件 `UsageTrendChart` + CSS | `components/`、`styles.css` | tsc；契约脚本断言：无 max-width 上限、Y 轴、三态、聚焦 |
| T4 | 总览接入三档切换（本日/本周/本月，切换态落 localStorage try/catch） | `OverviewPage.tsx`、i18n 双语 | `verify:react` 全绿；i18n 完整性机器校验 |
| T5 | 用量页复用、删重复 CSS/渲染 | `UsagePage.tsx`、`styles.css` | 既有 `verify-react-usage-window-contract` 绿 + 新断言（用量页不再含 `usage-hour-grid`） |
| T6 | 契约/回归收口 + 更新 v1.1 spec 状态说明 | scripts、docs | `npm run verify:react`、`cargo test`、clippy 全绿 |

**subAgent 验收节点**
- A1（T1 后）：独立审查后端——规则族是否单一来源、日界/DST、窗口守卫、`None` vs 空。
- A2（T3 后）：独立审查组件——三态、a11y、与 spec §2.3 逐条对照；mock 数据截图
  （Chrome 开 `npm run dev:react`，三档 + 空态 + 降级态）。
- A3（T5/T6 后，终验）：整体对照本 spec §1 目标与 §0 六条问题逐项勾选，并回归用量页。

每个验收发现 → 修复 → 复验，直到无 P0/P1。

## 5. 验收标准（终验）

1. §0 六条问题逐项有对应改动与证据（截图或测试）。
2. 三档切换在 mock 与真实 DTO 形状下均可渲染；周跨月、月初（仅 1 柱+未来空位）、
   空数据、失败不可用四景无异常。
3. `cargo test`（涉及 crate）、`cargo clippy --release --all-targets -- -D warnings`、
   `npm run verify:react` 全绿。
4. 用量页「小时明细」视觉/行为不倒退，且代码里只剩一套趋势柱渲染。

## 6. 开放决策（已按默认推进，可推翻）

- 周起始日：**周一**（自然周的常见定义；与统计时区无关，只看公历）。
- 失败高亮样式：描边 + 底点，而非整柱变橙（保住执行环境堆叠色的可读性）。

## 7. 实施记录（2026-10-01）

- T1 `failure_days_range/trailing` + 快照 `failure_days`（含 A1 建议的 31 号边界测试）；
  T2 `trendBuckets.ts` + 可执行契约脚本；T3 `UsageTrendChart`；T4 总览三档；
  T5 用量页复用并删除 `usage-hour-*`；T6 契约/文档收口。
- **A1（后端，subAgent）**：无 P0/P1；P2（`issue_instances` 无 `(issue_type, opened_at_ms)`
  索引、快照多一次扫描）暂不处理——当前表规模下开销可忽略，表增长后再加索引或合并两次聚合。
- **A2（视觉）**：subAgent 的 Chrome 扩展未连接，改由本机 headless Chrome + CDP 实测
  （脚本只在作业临时目录，未入库）。发现并修复真正根因（flex 横排，见 §0.1）；实测
  三档在 1400/900px 下图宽、柱宽、失败标记数、未来位数、Y 轴、浮层不被裁剪均符合 §2.3。
- 已知遗留：浏览器 mock 缺 `harness_display_names` / `fx_convert_amounts` 两条命令（仅控制台
  噪声，与本特性无关）；周档轴标签为日号，星期只在浮层里。
