# 需求文档：agent-vitals 成本日历 + xbar 状态栏 + 预算预警

> 状态：草案（待评审）
> 关联文档：[PRODUCT.md](./PRODUCT.md) §5.8 watch / §7.3 Health Score / §9 成功指标 · [ARCHITECTURE.md](./ARCHITECTURE.md) §0.2 三种使用姿势 / §0.3 明确不做的 / §7 配置 / §8.1 Local First · [RUNTIME_EVIDENCE_CONTRACT.md](./RUNTIME_EVIDENCE_CONTRACT.md) §3 Signals / §4 Coverage

---

## 1. 背景与目标

### 1.1 现状缺口

agent-vitals 目前能回答「**这个**会话发生了什么、花了多少」，不能回答「**今天**怎么样、本周趋势如何、超预算了没」：

| 缺失能力 | 用户视角的提问 |
|---------|--------------|
| **跨 session 聚合** | 我今天花了多少？这个月呢？ |
| **时段细分** | 高峰期占比多少？哪些时段最贵？ |
| **趋势可见性** | 比上周涨了还是跌了？ |
| **预算护栏** | 超过预算前有没有提醒？ |
| **被动监控** | 不打开 CLI 也能看到状态 |

`usage.py::token_by_model` 和 `cost.py::cost_report` 当前都是**单 session fold**——只能算"这次会话花了多少"。`PRODUCT §8.3 护城河 #3 Historical Dataset` 写了"长期积累"，但**没有落地路径**。

### 1.2 设计原则（与现有纪律一致）

| 原则 | 来源 | 本设计的体现 |
|------|------|-------------|
| **三种使用姿势共用同一个游标** | ARCHITECTURE §0.2 | xbar tick、日历 HTML、CLI 命令读同一份状态文件 |
| **不写用户配置** | ARCHITECTURE §0.3 | 状态文件是审计产物归档，不算"配置" |
| **不联网、不上报** | ARCHITECTURE §8.1 | 预算本地配置，告警本地触发 |
| **缺列不编列** | PRODUCT §5.6 + 不变量 12 | 没有当日数据 = 当日不渲染，不是 0 |
| **启发式只排序不裁决** | ARCHITECTURE §5.4 | 告警级别是建议，不是阻断 |
| **Unknown ≠ Zero** | ARCHITECTURE §2.1 | 当日 cost 缺失显示为 `null`，不是 `0` |
| **预算分位数自适应** | 本设计新增纪律 §4 | 阈值 = max(用户设定, 7日均 × 1.5) |

### 1.3 三个子功能的边界

```
┌─────────────────────────────────────────────────────┐
│ v1.x.1  成本日历  状态文件 + 静态 HTML 日历       │
├─────────────────────────────────────────────────────┤
│ v1.x.2  xbar 状态栏  macOS / SwiftBar 插件         │
├─────────────────────────────────────────────────────┤
│ v1.x.3  预算预警  预算配置 + 三档告警 + snooze     │
└─────────────────────────────────────────────────────┘
```

**依赖关系**：1.1 → 1.2 → 1.3。1.1 是基础设施，1.2 与 1.3 都是它的消费者。

---

## 2. 总体设计

### 2.1 三种使用姿势的统一模型

```
单 session 审计（behavior <log>）
     │
     │  单会话 fold（已有）
     ▼
cost_report { total, per_model, by_hour }
     │
     │  写入（自动）
     ▼
~/.agent-vitals/state/
├── oneline.json        # 状态栏那一行的数据源
├── today.json          # 当日逐小时
├── month.json          # 当月逐日
└── sessions/           # 当日逐 session 详情（路径 A）
     └── 2026-08-25/
         ├── session-A.json
         └── session-B.json
     │
     │  读取（被动）
     ├─────────────────────────┬─────────────────────────┐
     ▼                         ▼                         ▼
 xbar tick              日历 HTML                预算告警
 (5 分钟一次)          (按需打开)              (状态栏颜色)
```

**三条消费路径共用同一份状态文件**——xbar tick、日历 HTML、预算告警都是**只读消费者**。

### 2.2 状态文件的写入触发

**唯一写入触发点**：`behavior <log>` 命令的末尾。

不是每次 tick——tick 是**只读**。不是 cron——cron 是 daemon（违反 §0.3）。

写入是审计的**副产物**——用户跑一次审计，自动沉淀一份状态。

```
用户跑一次 agent-vitals behavior <log>
↓
审计完毕
↓
顺手写 oneline.json / today.json / month.json（30 行新代码）
↓
下一次 xbar tick 自然看见
```

### 2.3 状态文件目录结构

```
~/.agent-vitals/
├── config.toml          # 已有：用户配置（含 [budget] 节）
├── snapshots/           # 已有：装机报告，30 份滚动
├── state/               # 新增：行为审计副产品
│   ├── oneline.json     # 状态栏数据
│   ├── today.json       # 当日 detail（用户切换日期时读）
│   ├── month.json       # 当月 detail
│   ├── budget.json       # 当前预算快照（含自适应阈值）
│   └── sessions/        # 逐 session 详情
│       └── 2026-08-25/
│           ├── session-A.json
│           └── session-B.json
└── state.lock           # 文件锁，防止并发写
```

**目录权限**：`0700`（与 `snapshots/` 一致）。**文件权限**：`0600`。

### 2.4 状态文件目录与现有快照目录的关系

| 目录 | 现有/新增 | 内容 | 触发方式 |
|------|---------|------|---------|
| `snapshots/` | 已有 | 装机层报告 | 用户显式 `snapshot` 命令 |
| `state/` | 新增 | 行为审计副产品 | 每次 `behavior <log>` 自动 |

**两份数据有完全不同的语义**：
- `snapshots/` 是「两次装机之间的 diff」
- `state/` 是「跨 session 的趋势」

不合并——两份的写入触发、读取频率、保留策略都不同。

---

## 3. 子功能 v1.x.1：成本日历

### 3.1 数据契约：`oneline.json`

```json
{
  "schema_version": "1.0",
  "as_of": "2026-08-25T15:30:00+08:00",

  "today": {
    "cost_cny": 22.4,
    "tokens": 180000,
    "peak_cost_cny": 14.2,
    "off_peak_cost_cny": 8.2,
    "session_count": 3,
    "by_hour": {
      "09": 4.2,
      "10": 6.8,
      "11": 3.1,
      "14": 4.0,
      "15": 4.3
    },
    "by_model": {
      "deepseek-v4-pro": 12.4,
      "deepseek-v4-flash": 8.0,
      "claude-sonnet-5": 2.0
    }
  },

  "week": {"cost_cny": 130.6, "days_so_far": 3, "daily_avg": 43.5},
  "month": {"cost_cny": 412.0, "days_so_far": 25, "daily_avg": 16.5},

  "trend": {
    "vs_yesterday": "+23%",
    "vs_week_avg": "+5%",
    "vs_month_avg": "+36%"
  },

  "alert": {
    "level": "warn",
    "ratio": 0.747,
    "peak_share": 0.633,
    "peak_over": false,
    "reasons": ["today at 75% of daily budget"],
    "snoozed_until": null
  },

  "notified_session_ids": ["session-A", "session-B"]
}
```

**字段约束**：

| 字段 | 缺失语义 | 渲染行为 |
|------|---------|---------|
| `today.cost_cny` | 当日无 session | `null`，不渲染数字 |
| `today.by_hour` | 当日无 session | `{}`，不渲染日历 |
| `week.cost_cny` | 本周无 session | `null` |
| `trend.vs_yesterday` | 无对比基线 | 字段缺席，不是 `0%` |

### 3.2 数据契约：`today.json`

```json
{
  "schema_version": "1.0",
  "date": "2026-08-25",
  "hourly": [
    {
      "hour": "2026-08-25T09",
      "is_peak": true,
      "cost_cny": 4.2,
      "tokens": 32000,
      "sessions": ["session-A"]
    },
    {
      "hour": "2026-08-25T15",
      "is_peak": true,
      "cost_cny": 4.3,
      "tokens": 28000,
      "sessions": ["session-B", "session-C"]
    }
  ],
  "sessions": ["session-A", "session-B", "session-C"]
}
```

**保留窗口**：最近 7 天。**滚动规则**：超过 7 天的 `today.json` 删除（避免状态文件膨胀）。

### 3.3 数据契约：`month.json`

```json
{
  "schema_version": "1.0",
  "month": "2026-08",
  "daily": [
    {
      "date": "2026-08-01",
      "cost_cny": 12.0,
      "peak_cost_cny": 8.0,
      "off_peak_cost_cny": 4.0,
      "session_count": 2
    }
  ]
}
```

**保留窗口**：当前月 + 上个月。超过 62 天的删除。

### 3.4 命令接口

```bash
agent-vitals behavior <log>          # 现有命令，末尾自动写状态文件
agent-vitals oneline                  # 新增：打印 oneline.json 摘要 + 渲染到 stdout
agent-vitals oneline --write-state    # 等价于 behavior 末尾自动做的写入
agent-vitals calendar                 # 新增：输出本月日历（终端 ASCII 版）
agent-vitals calendar --html <path>   # 新增：输出静态 HTML 日历
agent-vitals calendar --day 2026-08-25 # 查看某天详情
agent-vitals calendar --week          # 本周视图
agent-vitals calendar --month 2026-08 # 指定月份
```

### 3.5 静态 HTML 日历设计

**布局**：

```
┌─────────────────────────────────────────────────────────────┐
│ Agent Vitals · Cost Calendar · August 2026                  │
├─────────────────────────────────────────────────────────────┤
│ [< Aug] [Today] [Sep >]   · View: month / week / day        │
├─────────────────────────────────────────────────────────────┤
│  Sun  │  Mon  │  Tue  │  Wed  │  Thu  │  Fri  │  Sat       │
├───────┼───────┼───────┼───────┼───────┼───────┼───────┤    │
│  27   │  28   │  29   │  30   │  31   │   1   │   2       │
│   -- │   -- │   -- │ ¥18  │ ¥22  │ ¥15  │ ¥20      │
│ ████ │ ████ │ ████ │ ▓▓░░ │ ████ │ ▓░░░ │ ▓▓░░     │
├───────┼───────┼───────┼───────┼───────┼───────┼───────┤    │
│   3   │   4   │   5   │   6   │   7   │   8   │   9       │
│ ¥35● │ ¥12  │ ¥18  │ ¥28  │ ¥19  │ ¥22  │ ¥16      │
│ ████ │ ▓░░░ │ ▓▓░░ │ ████ │ ▓▓░░ │ ▓▓░░ │ ▓░░░     │
├───────┼───────┼───────┼───────┼───────┼───────┼───────┤    │
│  10   │  11   │  12   │  13   │  14   │  15   │  16       │
│ ¥14  │ ¥17  │ ¥21  │ ¥19  │ ¥12  │ ¥24  │ ¥18      │
│ ▓░░░ │ ▓▓░░ │ ▓▓░░ │ ▓▓░░ │ ▓░░░ │ ████ │ ▓▓░░     │
├───────┴───────┴───────┴───────┴───────┴───────┴───────┤    │
│ Month total: ¥412  · Daily avg: ¥16.5  · Peak share: 62% │
│ [< daily bars colored by peak/off-peak share >]            │
└─────────────────────────────────────────────────────────────┘
```

**单元格视觉规则**：

```
无数据 (--)：灰色边框
有数据但正常：浅色背景 + 当日费用
超预算（红）：实色红条
预算警告（橙）：斜纹橙条
预算接近（黄）：斜纹黄条
周末：自动标 "weekend" 灰底（off-peak 全天）
```

**单元格可点击** → 弹出当日详情面板（session 列表、每小时拆分、模型拆分）。

### 3.6 离线打开

HTML 文件是**完全静态**——所有数据内嵌，不需服务器。

```bash
# 用户流程
agent-vitals calendar --html ~/.agent-vitals/calendar.html
open ~/.agent-vitals/calendar.html   # macOS
xdg-open ~/.agent-vitals/calendar.html  # Linux
```

**与 PRODUCT §5.9 决策一致**：静态 HTML 是默认投递方式，零端口零 daemon。

---

## 4. 子功能 v1.x.2：xbar 状态栏

### 4.1 渲染目标

macOS 状态栏（xbar / SwiftBar）：

```
[💰 ¥22.4]
```

点击展开（菜单）：

```
¥22.4 · today                 (主行)
├ 本周 ¥130.6 (7日均¥43.5)
├ 本月 ¥412.0 (日均¥16.5)
├
├ ────── 高峰占比 63% ──────
├ 09-12 peak ¥14.2 (63%)
├ off-peak ¥8.2 (37%)
├
├ ────── 模型分布 ──────
├ pro ¥12.4 (55%)
├ flash ¥8.0 (36%)
├ claude ¥2.0 (9%)
├
├ ────── 告警 ──────
├ 🟡 今日 ¥22.4 / ¥30 (75%)
├ 比7日均 +5%
├
├ ────── 操作 ──────
├ ↗ 打开本日详情 (HTML)
├ ↗ 打开本月日历 (HTML)
├ ↗ 打开本日 session 列表
├
├ ────── 设置 ──────
├ ⚙ 调整预算 | href=agent-vitals budget set
├ 🔕 静音 1 小时 | bash=...
├ 🔕 永久关闭预算告警 | bash=...
```

### 4.2 xbar 插件脚本

```bash
#!/bin/bash
# ~/.xbar/plugins/agent-vitals.5m.sh
# 每 5 分钟 tick 一次
# <xbar.title>Agent Vitals</xbar.title>
# <xbar.version>1.0</xbar.version>

export PATH="$HOME/.local/bin:$PATH"

# xbar 渲染：主菜单显示一行 + 颜色
# xbar 期望 ≤ 1 秒返回
exec agent-vitals oneline --xbar
```

### 4.3 性能边界

**xbar tick 必须 ≤ 1 秒**——否则状态栏抖动。

- `oneline --xbar` 只读 `oneline.json`（已折好的状态），不解析原始日志
- **不联网、不调 Python 解释器（除非必要）**
- 如果 `oneline.json` 不存在或过期，状态栏显示 `--` 而不是 fail

### 4.4 颜色编码

| 状态 | 颜色 | 条件 |
|------|------|------|
| 正常 | 默认 | 无告警 |
| 接近预算 | 🟡 黄 | 日预算 70-90% |
| 警告 | 🟠 橙 | 日预算 90-100% |
| 超过 | 🔴 红 | 日预算 > 100% |
| 无数据 | ⚪ 灰 | `today.cost_cny = null` |

xbar 通过 `| color=red` 等修饰符实现：

```
¥22.4 | color=yellow font=JetBrainsMono size=12
```

### 4.5 平台支持

| 平台 | 工具 | 状态 |
|------|------|------|
| macOS | xbar + SwiftBar | v1.x.2 首发 |
| Linux | ArgBar / StatusBarX | v1.x.x 推迟 |
| Windows | 不支持 | 不做 |

**理由**：状态栏渲染是分平台工作——`agent-vitals oneline --xbar` 是 macOS 专属，但**底层状态文件层通用**。其他平台用户可以用 `agent-vitals calendar --html` + 浏览器 pinned tab 替代。

---

## 5. 子功能 v1.x.3：预算预警

### 5.1 预算模型

```toml
# ~/.agent-vitals/config.toml（已有文件，加一节）

[budget]
enabled = true
daily_cny = 30.0          # 默认 ¥30
weekly_cny = 180.0         # 默认 ¥180
monthly_cny = 600.0         # 默认 ¥600
peak_share_max = 0.5       # 高峰占比上限
warn_at_ratio = 0.8        # 80% 时开始预警

# 可选：自适应阈值
adaptive_floor = true      # 阈值 = max(设定, 7日均 × 1.5)
adaptive_window_days = 7
adaptive_multiplier = 1.5
```

**字段语义**：

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | false = 完全不告警 |
| `daily_cny` | `30` | 当日累计 cost 上限 |
| `peak_share_max` | `0.5` | 当日 peak cost 占比上限 |
| `adaptive_floor` | `true` | 自适应保底 |
| `warn_at_ratio` | `0.8` | 触发"接近"预警的比率 |

### 5.2 告警等级

```
ratio = today_cost / effective_daily_budget

ratio < 0.70           → ok     (无颜色 / 绿色)
0.70 ≤ ratio < 0.90    → near   (黄色)
0.90 ≤ ratio < 1.00    → warn   (橙色)
ratio ≥ 1.00            → over   (红色)
```

`effective_daily_budget` 计算：

```python
if adaptive_floor:
    daily_avg = sum(last_N_days) / N
    effective = max(daily_cny, daily_avg * adaptive_multiplier)
else:
    effective = daily_cny
```

### 5.3 告警字段

```json
{
  "alert": {
    "level": "warn",
    "ratio": 0.747,
    "peak_share": 0.633,
    "peak_over": true,
    "reasons": [
      "today at 75% of daily budget (¥22.4 / ¥30.0)",
      "peak share 63% exceeds max 50%"
    ],
    "snoozed_until": null,
    "effective_daily_budget": 30.0,
    "adaptive_floor_applied": false
  }
}
```

`reasons` 数组——**多原因并列**，不合并。这是与"只列实际非零信号"的纪律一致。

### 5.4 peak_share 反投机条款

**问题场景**：Agent 全在高峰期跑 → 实际工作量没翻倍，但 cost 翻倍（高峰单价 = 空闲 × 2）。

`peak_share_max = 0.5` 防止：
- 当日 peak cost / total cost > 0.5 → `peak_over: true`
- 加入告警 reasons
- 状态栏变红

**取舍**：
- 保守用户：把 `peak_share_max` 调到 0.7
- 重度高峰用户：调到 0.9
- 不在意高峰：设 `0.0`（关闭反投机）

### 5.5 用户操作

```bash
agent-vitals budget set --daily 50
agent-vitals budget set --peak-share-max 0.7
agent-vitals budget disable              # 暂时关闭
agent-vitals budget enable               # 重新开启
agent-vitals budget show                 # 查看当前配置
```

**snooze**（xbar 菜单点击触发）：

```bash
agent-vitals budget snooze --hours 1     # 静默 1 小时
agent-vitals budget snooze --until EOD   # 静默到今天结束
```

snooze 状态持久化到 `budget.json`：

```json
{
  "snoozed_until": "2026-08-25T16:30:00+08:00",
  "snooze_reason": "user-clicked"
}
```

**到期后自动失效**——不是事件触发，是**状态文件读取时检测**。

### 5.6 snooze 的边界

| 边界 | 行为 |
|------|------|
| snooze 过期 | 自动恢复告警（无需手动取消）|
| snooze 进行中 | oneline.json 仍写入告警数据，但 `level: "snoozed"` |
| 永久关闭 | 用户设 `enabled = false` |
| 重新打开 | 用户设 `enabled = true`，**累积的成本照算**（不会"补告警"）|

### 5.7 与现有 CI 闸门的关系

ARCHITECTURE §6 定义 `--fail-on` 退出码是装机层 CI 闸门：

```bash
agent-vitals doctor --fail-on warning
```

**预算告警与 CI 无关**——CI 是装机层的 "这次变更能不能合"，预算是行为层的"今天超没超"。两者**不交叉**。

预算告警出现在：
- xbar 状态栏
- `agent-vitals oneline` CLI 输出
- 日历 HTML 渲染

**不**出现在：
- `doctor --json`（装机层）
- `behavior <log>` 行为审计（单 session）
- CI 退出码

---

## 6. 落地的最小工作量

### 6.1 v1.x.1：状态文件 + 日历

| 任务 | 文件 | 行数 |
|------|------|------|
| `usage.py` 加 `hour_bucket` 折叠 | `scripts/agent_vitals/agent/usage.py` | +40 |
| `cost.py` 加 `per_hour` 输出 | `scripts/agent_vitals/agent/cost.py` | +30 |
| 平行 Rust 实现 | `crates/agent-vitals-core/src/domain/usage.rs` + `cost.rs` | +60 |
| 新增 `state.py`（写 oneline/today/month） | `scripts/agent_vitals/agent/state.py`（新文件）| ~150 |
| 新增 `cli.py` 子命令 `oneline` `calendar` | `scripts/agent_vitals/cli.py` | +50 |
| 平行 Rust CLI | `src/main.rs` | +60 |
| 静态 HTML 模板 | `scripts/agent_vitals/calendar_template.html` | ~200 |
| 测试 | `tests/test_state.py` `tests/test_calendar.py` | ~300 |
| **合计** | | ~890 |

### 6.2 v1.x.2：xbar 插件

| 任务 | 文件 | 行数 |
|------|------|------|
| `oneline --xbar` 渲染模式 | `scripts/agent_vitals/cli.py` | +30 |
| xbar 插件脚本（shell）| `contrib/xbar/agent-vitals.5m.sh` | ~20 |
| 文档 | `docs/XBAR_INTEGRATION.md`（新文件）| ~150 |
| **合计** | | ~200 |

### 6.3 v1.x.3：预算预警

| 任务 | 文件 | 行数 |
|------|------|------|
| `budget.py` 加载 + 计算告警等级 | `scripts/agent_vitals/agent/budget.py`（新文件）| ~150 |
| `state.py` 加 budget 字段 | `scripts/agent_vitals/agent/state.py` | +50 |
| `cli.py` `budget` 子命令 | `scripts/agent_vitals/cli.py` | +80 |
| snooze 持久化 | `state.py` | +30 |
| 配置文件 schema 文档 | `docs/CONFIG.md`（新文件）| ~200 |
| 测试 | `tests/test_budget.py` | ~200 |
| **合计** | | ~710 |

### 6.4 总计

```
v1.x.1  ~890 行  (1-2 周)
v1.x.2  ~200 行  (2-3 天)
v1.x.3  ~710 行  (1 周)
─────────────
合计     ~1800 行
```

**没有架构改动**——纯增量。

---

## 7. 风险与开放问题

### 7.1 风险

1. **状态文件膨胀**——未做容量限制 → 状态目录无限增长
   - 缓解：`today.json` 7 天滚动，`month.json` 62 天滚动，`sessions/` 30 天滚动

2. **写入阻塞**——`behavior <log>` 末尾写状态文件时磁盘满 → 审计失败
   - 缓解：写文件失败时**只打 warning**，不中断审计（审计主路径不受影响）

3. **并发写**——同时跑两次审计
   - 缓解：`state.lock` 文件锁（fcntl.flock）

4. **时区混淆**——`as_of` 是本地时间还是 UTC？
   - 设计：本地时间 + 显式 `+08:00` 偏移（与现有 `usage.py::_BEIJING_OFFSET_SECS` 一致）

5. **peak 时段判断变化**——业务侧改高峰定义后历史数据怎么对齐？
   - 设计：保留旧时段标签，**不可重新计算**——历史就是历史

### 7.2 开放问题

1. **预算的"季度"档位**——月预算够不够？
   - 当前：日/周/月三档
   - 推迟：季度档位（v2 再说）

2. **多用户/多机器同步**——同一用户在多台机器跑怎么办？
   - 当前：每台机器独立预算（不是同一个值）
   - 推迟：跨机器同步（如果要做，需要云端，与 Local First 冲突）

3. **预算修改历史**——用户改了预算后，旧告警历史是否要回溯？
   - 当前：旧告警不重算（`budget.json` 留快照）
   - 推迟：审计模式（v2 再说）

4. **跨月切换**——8 月 31 日 23:59 触发预算超限，9 月 1 日会重置吗？
   - 设计：自然月切换，9 月 1 日 `today.cost_cny = 0`，告警自然消失

---

## 8. 验收标准

### 8.1 v1.x.1 验收

```
[ ] 跑一次 behavior <log> 后，~/.agent-vitals/state/oneline.json 存在
[ ] oneline.json 字段齐全，schema_version = "1.0"
[ ] today.cost_cny 等于该 session 的 cost_report.total
[ ] today.by_hour 折叠正确（每条 usage sample 按 event.time 分桶）
[ ] peak_cost + off_peak_cost == today.cost_cny
[ ] 无 session 的日子 today.cost_cny = null
[ ] calendar --html 生成文件可在浏览器打开
[ ] calendar --html 文件不引用外部资源（CDN、外部 JS、CSS）
[ ] 双实现锁步：Python 生成的 oneline.json == Rust 生成的
```

### 8.2 v1.x.2 验收

```
[ ] xbar 插件脚本在 macOS 上每 5 分钟自动刷新
[ ] oneline --xbar 输出 ≤ 1 秒
[ ] 状态栏显示 ¥XX.X 格式
[ ] 菜单点击"打开本日详情"能在浏览器打开 HTML
[ ] 状态栏颜色随 alert.level 变化（绿/黄/橙/红）
```

### 8.3 v1.x.3 验收

```
[ ] config.toml 加 [budget] 节后，behavior 跑完 oneline.json 出现 alert 字段
[ ] alert.level 在四个阈值正确切换
[ ] snooze --hours 1 后，oneline.json 的 level = "snoozed"
[ ] snooze 过期后自动恢复
[ ] peak_share_max 超限时告警
[ ] 自适应阈值在 7 日均计算正确
[ ] budget disable 后 alert.level = "ok"
```

---

## 9. 与现有文档的兼容性

### 9.1 不冲突的现有纪律

| 纪律 | 体现 |
|------|------|
| ARCHITECTURE §0.2 三姿势共用同一份状态 | 本设计的核心 |
| ARCHITECTURE §0.3 不写用户配置 | 状态文件是审计归档，**不是配置** |
| ARCHITECTURE §2.1 Unknown ≠ Zero | oneline.json 缺失字段为 null |
| ARCHITECTURE §5.4 启发式只排序不裁决 | 告警不阻断、不修改 agent 行为 |
| ARCHITECTURE §8.3 Local First | 数据不联网、不上报 |
| PRODUCT §5.8.4 xbar 常驻 | 本设计是 §5.8 的具体落地 |
| PRODUCT §5.8.5 告警纪律 | 三档告警 + snooze + 独立于严重度 |
| PRODUCT §7.3 无 Health Score | 不引入分数，只有颜色 |

### 9.2 需要补充的纪律

**新增纪律**：状态文件的写入触发与归档语义——

> **状态文件是审计副产品，不是配置**。
> 写入触发：`behavior <log>` 末尾的 fold 完成后。
> 写入失败：打 warning，**不中断审计主路径**。
> 删除规则：today.json 7 天滚动、month.json 62 天滚动、sessions/ 30 天滚动。
> 用户关闭：`config.toml [budget] enabled = false` —— 关闭预算告警，但不关闭状态文件本身（仍是审计产物）。

**需要在 ARCHITECTURE.md §0.3 补充**：

```
| 不做 | 那是谁的活 |
|------|----------|
| ...  | ...      |
| 跨机器同步预算 | 云端同步与 Local First 冲突 |
```

---

## 10. 文档附录

### 10.1 关联文件

| 路径 | 用途 |
|------|------|
| `scripts/agent_vitals/agent/state.py` | 新增：状态文件写入 |
| `scripts/agent_vitals/agent/budget.py` | 新增：预算加载与告警计算 |
| `scripts/agent_vitals/calendar_template.html` | 新增：HTML 模板 |
| `crates/agent-vitals-core/src/domain/state.rs` | 新增：Rust 平行实现 |
| `crates/agent-vitals-core/src/domain/budget.rs` | 新增：Rust 平行实现 |
| `contrib/xbar/agent-vitals.5m.sh` | 新增：xbar 插件 |
| `docs/XBAR_INTEGRATION.md` | 新增：xbar 集成文档 |
| `docs/CONFIG.md` | 新增：完整 config.toml 文档 |
| `tests/test_state.py` | 新增：状态文件测试 |
| `tests/test_calendar.py` | 新增：日历命令测试 |
| `tests/test_budget.py` | 新增：预算告警测试 |

### 10.2 实施顺序

```
M1 (本周)   usage.py hour_bucket fold
M2          cost.py per_hour 输出
M3          state.py 骨架 + oneline.json schema
M4          cli.py oneline / calendar 子命令
M5          Rust 平行实现
M6          静态 HTML 模板
M7          xbar 插件脚本 + xbar 文档
M8          budget.py + config.toml [budget] 节
M9          snooze 持久化
M10         CI 集成测试 + golden fixtures
```

---

**附录：变更影响摘要**

| 文档 | 需要的改动 |
|------|----------|
| PRODUCT.md | §5.8 加 watch --oneline 的具体交付物；§9 指标加 "Calendar attach rate" |
| ARCHITECTURE.md | §0.3 补充「跨机器同步不做」；§7 加 [budget] 节 schema；§8.2 补充状态文件归档语义 |
| ENGINEERING.md | §6.8 双实现差分护栏加 oneline.json / budget.json |
| HARNESS_ADAPTER_CONTRACT.md | 不变 |
| RUNTIME_EVIDENCE_CONTRACT.md | 不变（运行时层与本需求解耦）|
| AGENT_BEHAVIOR_AUDIT.md | 不变（单 session 审计，与本需求正交）|