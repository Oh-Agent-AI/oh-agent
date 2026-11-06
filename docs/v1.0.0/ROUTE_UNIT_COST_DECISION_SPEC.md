# 线路单位成本与「现在该用谁」决策规格

日期：2026-09-13（v2，按评审修订）
状态：草案，待评审。**范围：`v1.1`，不进 `v1.0.0-beta.1`**（Beta.1 只保留 §10 表中的轻量能力）。
依据：[ATTRIBUTABLE_WASTE.md](../ATTRIBUTABLE_WASTE.md) §4 W1 / §6 / §7、[PROVIDER_ROUTE_ATTRIBUTION_SPEC.md](../PROVIDER_ROUTE_ATTRIBUTION_SPEC.md)、[BETA_1_UI_UX_GAP_ANALYSIS.md](./BETA_1_UI_UX_GAP_ANALYSIS.md) §4 第 82/85 行、[BETA_1_OVERVIEW_IA_REVIEW.md](./BETA_1_OVERVIEW_IA_REVIEW.md)
真机锚点：2026-09-13 对 `~/.agent-vitals/agent-vitals.sqlite3` `usage_facts` 与 `~/.claude/projects/*/*.jsonl` 的只读分析，数字见 §3.4、§4.6、§8.3.1。

**三条核心原则**（其余规则都是它们的推论）：¥/M 只比较钱，不比较质量；缓存不可迁移；**未知不参与推荐**。

---

## 1. 要回答的用户问题

「现在该用谁」卡片目前只是配额展示（Codex 窗口剩多少）。本规格把它提升为"当前可用性 + 边际成本 + 切换成本 + 稳定性"的决策组件，回答四个问题：

| # | 用户问题 | 答案形态 | 决策后的动作 |
|---|---|---|---|
| Q1 | 现在开工该用哪个？ | 一条推荐线路（只来自**有明确证据**的线路） | 切到那个工具/模型 |
| Q2 | 套餐额度用完后走哪条最便宜？ | 备选线路，两个数：稳态 ¥/M、切换首轮 ¥/M | 决定备选，避免频繁切换 |
| Q3 | 哪条线路在白白烧钱？ | 命中率异常的线路告警（W1 嫌疑），带持续天数与**可复算**的估算金额 | 检查线路配置 / 联系服务商 / 换线 |
| Q4 | 这周和上周比，谁变便宜/变贵了？为什么？ | 周维度动态排名，带名次变化与原因码 | 跟进新模型、价格调整 |

本质：考核"在你自己的用量结构下、这条线路每百万 token 的边际成本"——不是价卡标价，不是生产力。

## 2. 词表

| 词 | 定义 | 备注 |
|---|---|---|
| **线路 (route)** | `(harness, provider, model_family)` | 决策粒度。同一模型经不同线路命中率差 4–30 倍（§3.4） |
| **model_family** | 原始 `model_id` 归一后的模型族（§5.1.1） | **聚合前先归一**，否则同一线路拆成多行 |
| **用量结构 (mix)** | 四桶占比 `{uncached, cache_read, cache_write, output}`，Σ=1 | 来自用户自己的 facts |
| **命中率 (hit)** | `cache_read / (uncached + cache_read + cache_write)` | 复用 `domain/cost/billing.rs::cache_hit_ratio` |
| **稳态有效单价** | `Σ_b mix_b × price_{route,b}`，¥/M（processed tokens） | 用该线路自己的正常 mix（§4.2） |
| **切换首轮单价** | 同上但 `cache_read → uncached`（命中=0） | 缓存不可跨线路迁移 |
| **边际成本** | 订阅且**额度已读且充足** → 0；按量 → 稳态单价；其余 → `null` | `null` 不参与推荐 |
| **稳定性** | 命中率在多日窗口内的分布分级（§4.3） | 不是单日快照 |
| **W1 嫌疑** | 命中率低于线路阈值的**告警**，金额为估算、不是浪费归因 | 公式 §4.6 |
| **周排名** | 自然周切片，用该周的 mix、命中率、**该周生效的价卡与汇率快照** | 时间序列，名次变化必须归因 |
| **推断线路** | `provider_id` 为空、由模型名推断价卡的线路 | 只能显示"按模型名参考估价"，不进任何结论（§5.2） |

## 3. 计算规则

### 3.1 有效单价

```
P            = 该线路价卡四桶单价（¥/M；USD 按与价卡同一快照冻结的 fx 折算，带 ≈）
mix          = 该线路正常 mix（§4.2 的 good-day 合并；分级落地前用全窗口 mix 并标「未分级」）

steady_unit  = mix.u·P.u + mix.r·P.r + mix.w·P.w + mix.o·P.o
switch_unit  = (mix.u + mix.r)·P.u + mix.w·P.w + mix.o·P.o        # 命中=0
```

**价卡完整性**（未知不显示为 0）：

- 四桶单价缺任一项 → `steady_unit = null`，卡面「部分计价」，**不参与排序**。
- 缓存写：价卡**明确声明** `cache_write: 0`（如 DeepSeek 自动缓存、MiniMax M3）才按 0；未声明 → 视为缺项。Anthropic 按 1hr 档（与名义口径 `NOMINAL_BASIS_NOTE` 一致）。`assets/pricing.json` 现有卡多数缺缓存写项，补齐是 alpha.1 的价卡完整性工作（§11-6）。
- 峰谷价（DeepSeek 官方/胜算云）：按该线路窗口内峰谷 token 实测占比加权（`event_peak`）；判不出时按峰值并标「按峰值（保守上界）」。
- 无价卡（如 GLM）→ 显示命中率与用量，`unit = null`，不排序、不估算、不借邻卡。

### 3.2 边际成本与排序

```
marginal(route) =
  0             订阅 且 quota.state = "available" 且 remaining ≥ 15%       # 仅 Codex 有此正向证据
  steady_unit   按量 且 steady_unit ≠ null 且 非推断线路
  null          其余：额度未知/已耗尽/不可读、无价卡、部分计价、推断线路

rank_key(route) = (marginal == 0 ? 0 : marginal ≠ null ? 1 : 2,
                   marginal ?? +∞,
                   −stability_score)
```

- **额度未知的订阅线路（MiniMax 等用户声明月费、无额度源）`marginal = null`**：可以显示"值回月费倍数"，**不作为推荐依据**——一条已耗尽、会产生额外计费的线路不能因为"是订阅"排到第一。
- Claude Pro：三态（§8.3.2）；`exhausted` → 边际 `+∞`（排到按量之后）；`unknown` → `null`。
- `insufficient`（§4.3）线路 `stability_score = 0`，排同组末尾，不进推荐。
- `recommendation.now` 只从 `marginal ≠ null` 的线路里取；`after_quota` 只从按量、非推断、`stable` 或 `incident` 的线路里取。都取不到 → 推荐区隐藏，不编。

### 3.3 跨线路比价（Q2）

用户整体 mix（窗口内全部线路合并）套到每张候选价卡 → 每线路 `steady_unit` / `switch_unit` 两列。候选集 = 窗口内出现过的线路 ∪ 用户已声明订阅的服务商；不列从未用过的服务商（不做导购）。

### 3.4 真机锚点（2026-09-13，最近 30 天）

整体 mix：未命中 4.5% · 缓存读 94.4% · 缓存写 0.8% · 输出 0.26%（命中率 95%）。此结构下 `steady_unit ≈ 0.94·P.r + 0.045·P.u`——缓存读单价与命中率决定一切。

| 线路 | 命中率 | 稳态 ¥/M | 切换首轮 ¥/M |
|---|---|---|---|
| claude-code / deepseek-v4-flash（推断） | 98% | 0.22 | 3.04 |
| claude-code / MiniMax-M3（推断） | 99% | 0.46 | 2.11 |
| codex / gpt-5.6-luna | 98% | 0.19 | 1.44 |
| claude-code / claude-sonnet-5（推断） | 99% | 2.67 | 21.77 |
| **dsh / shengsuanyun / deepseek-v4-pro** | **10%** | **8.21** | 9.09 |

两列相差 10–15×，是"不要频繁切换"的量化依据。胜算云 10% 是**单日事故**（DeepSeek 侧 bug，次日恢复），30 天聚合把它平均进去得出"这条线路很贵"的错误结论——这正是 §4 存在的理由，也是**alpha.1 不输出推荐**的理由（§10）。

## 4. 稳定性评估：多日窗口，不看单日

### 4.1 为什么不能看单日或整段聚合

单日：一次上游事故把线路判死。整段聚合：事故日的大量未命中 token 拉低整段命中率，掩盖其余 29 天正常。

### 4.2 逐日序列与指标

对每条线路计算逐日命中率 `hit_d`（统计时区日），只计**合格日**（输入侧 token ≥ `min_daily_input`=1M，且满足 §4.4 排除）。窗口默认 14 天。

| 指标 | 定义 |
|---|---|
| `hit_median` | 合格日命中率中位数——线路的"正常水平" |
| `hit_p10` | 10 分位 |
| `days_below` | `hit_d < threshold(route)` 的合格日数 |
| `worst_day` | 最低日（日期、命中率、token 量） |
| `eligible_days` | 合格日数 |

**正常 mix** = `hit_d ≥ threshold` 的合格日合并四桶（全都低于阈值时退回全窗口并标「按异常期结构」）。稳态单价用正常 mix，事故日不改变对线路正常价格的估计。

### 4.3 稳定性分级

| 级别 | 判定（窗口 14 天） | 卡面 |
|---|---|---|
| `stable` | `eligible_days ≥ 5` 且 `days_below ≤ 1` 且 `hit_median ≥ threshold` | 无标记 |
| `incident` | `hit_median ≥ threshold` 且 `2 ≤ days_below ≤ 3`，或 `days_below = 1` 但该日 token ≥ 窗口总量 20% | 灰字「MM-DD 曾异常」，不影响排序 |
| `unstable` | `days_below ≥ 4` 或 `hit_median < threshold` | W1 告警（§4.6 / §8.2），`stability_score` 降权 |
| `insufficient` | `eligible_days < 5` | 「样本不足」，不判级、不告警、不推荐 |

`stability_score = 1 − days_below / eligible_days`。

#### 4.3.1 阈值校准（不能全局 90%）

真机试跑：Codex Sol/Terra 中位 94%、偶有 81–85%，被全局 90% 标成"曾异常"。

```
threshold(route) = clamp(median(hit_d, 最近 30 天合格日) − 8pp, 60%, 95%)
                   若 30 天合格日 < 10 → 模型族默认表
```

默认表放 `assets/pricing.json::catalog.cache_hit_baseline`（与价卡同源同版本）：Anthropic claude-* 92% · OpenAI gpt-5.6-* 85% · DeepSeek v4-* 90% · MiniMax M3 92% / M2.7 55%（显式缓存写形态）· 其他/无价卡不判级。卡面 hover 显示当前阈值与来源。

### 4.4 W1 资格排除（沿用 ATTRIBUTABLE_WASTE §4）

不计入 `hit_d` 分母：会话首次请求、模型切换边界后首个请求、compaction 后首个请求、缓存语义未知的线路（无价卡或价卡无 `input_cached`）。先实现"会话首次请求"与"缓存语义未知"（facts 可直接判定），其余依赖 trace 数据的排除后置。

### 4.5 周维度动态排名

排名是**每周一份、可回看、可归因**的序列，不是快照——线路的"表现"只在时间里成立；新模型、缓存计费方式与价格随版本变化，静态排名会在价卡更新后悄悄失真。

```
对自然周 w、线路 r：
  mix_w     = 该周正常 mix        hit_w = 该周命中率中位数
  snap_w    = 该周生效的价卡+汇率快照（pricing_snapshots.effective_at ≤ 周末 的最新一条）
  steady_w  = effective_unit_cost(mix_w, snap_w)
  rank_w    = 按 §3.2 排序的名次
```

名次变化原因码（每线路每周 `rank_delta` + `reasons[]`，按顺序最多两条；**只有箭头没有原因不允许**）：

| 原因码 | 判定 | 卡面 |
|---|---|---|
| `hit_change` | `\|hit_w − hit_{w−1}\| ≥ 5pp` | 命中率 91% → 97% |
| `price_change` | `snap_w.card_id ≠ snap_{w−1}.card_id`（含缓存计费方式变化） | 价卡更新（缓存读 ¥0.42 → ¥0.21） |
| `fx_change` | 价卡未变、`snap_w.fx ≠ snap_{w−1}.fx` 且影响名次 | 汇率快照 7.15 → 7.30 |
| `new_route` | 上周无合格日、本周有 | **新** |
| `mix_change` | 单价变动 ≥ 10% 且非上述原因，**且名次实际变动**（否则静默——试跑四周产出 8 条 ±10% 正常波动） | 用量结构变化 |
| `dormant` | 本周无合格日 | 不进本周排名，保留历史 |

保留最近 12 周，落 `route_weekly_ranks` 投影表（可从 facts + pricing_snapshots 幂等重放，删表可重建）。稳定性（14 天滑窗）与周排名（自然周）共用逐日序列。

### 4.6 W1 金额估算公式（可复算）

W1 是"命中率异常"的嫌疑告警，金额是**估算的增量价差**，不是浪费归因、不进任何浪费分子。

```
对线路 r 的每个合格日 d，若 hit_d < threshold(r)：
  eligible_input_d    = uncached_d + cache_read_d + cache_write_d          # 已做 §4.4 排除
  baseline_hit        = hit_median(r)  若 eligible_days ≥ 5 且 hit_median ≥ threshold
                      = threshold(r)   否则
  expected_uncached_d = (1 − baseline_hit) × eligible_input_d
  excess_miss_d       = max(0, uncached_d − expected_uncached_d)
  extra_cost_d        = excess_miss_d × (P_d.u − P_d.r) / 1e6             # 本该按缓存读价付、实际按未命中价付的价差
                                                                            # P_d 取该日生效快照；峰谷按该日实测占比加权

excess_miss_tokens    = Σ_d excess_miss_d
estimated_excess      = Σ_d extra_cost_d
```

输入字段：`usage_facts` 四桶（`uncached_input_tokens / cache_read_tokens / cache_write_tokens`）、`event_peak`、`pricing_snapshots`。

降级与舍入：

- `P.u` 或 `P.r` 缺失 → 只报 `excess_miss_tokens`，`estimated_excess = null`，文案"约 N tokens 本可命中缓存（该线路无缓存价，未估算金额）"。
- USD 价卡 → 用同快照 fx 折算，金额带 ≈。
- token 按显示格式舍入（K/M）；金额四舍五入到整数元；`estimated_excess < ¥10` 显示"少量"，不显示具体数。
- `basis` 恒为 `estimated`；推断线路**不产出** W1（§5.2）。

真机复算（胜算云线路，2026-09 事故日）：`uncached_d = 365.5M`、`eligible_input_d ≈ 406.8M`、`baseline_hit = 0.93`（该线路正常中位）→ `expected_uncached ≈ 28.5M` → `excess_miss ≈ 337M` → `× (9.0 − 0.3)/1e6 ≈ ¥2,932`（按峰值；若该日谷时占比 60% 则 ≈ ¥1,800）。这就是告警里"多付约 ¥2,900（估算）"的来源；任何人用同一 facts 与快照都能复算出同一数。

## 5. 数据面

### 5.1 线路四桶逐日聚合（新增，runtime）

```sql
SELECT harness, provider_id, model_id, <统计时区日(event_ts_ms)> AS day,
       SUM(uncached_input_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(output_tokens),
       SUM(CASE WHEN event_peak THEN uncached_input_tokens + cache_read_tokens ELSE 0 END) AS peak_input,
       COUNT(*) AS facts
FROM usage_facts
WHERE deleted_at_ms IS NULL AND event_ts_ms >= :since
GROUP BY 1,2,3,4
```

落点 `agent-vitals-runtime::summary::route_daily_mix(days)`，进程级 60s memo（CLAUDE.md 性能纪律：工作台并发四命令，新增数据面不得每 tab 全量扫）。

#### 5.1.1 线路身份：先归一再聚合

SQL 按原始 `model_id` 分组只是取数；**在任何统计之前**，Rust 侧按 `route::model_family(model_id)` 把 `deepseek/deepseek-v4-flash`、`deepseek-v4-flash`、`custom-local:deepseek/deepseek-v4`、`deepseek-v4-flash-0731` 折到同一 `model_family`，再按 `(harness, provider, model_family, day)` 合并四桶。归一规则在 domain（Rust ↔ Python 同步），是**显式映射表 + 后缀剥离规则**，未命中映射的 `model_id` 原样作为 family 并标 `family_mapped: false`。AC15 钉住：同一线路在 `routes` 中只出现一行。

### 5.2 provider 缺失 → 推断线路只显示、不结论

真机 Claude Code 线路 `provider_id` 几乎全为 NULL（路由证据未归属，PROVIDER_ROUTE_ATTRIBUTION_SPEC 待落地）。仓库数据完整性规则：没有明确路由证据时，模型名推断**不能**升级成确定的 provider / billing 结论。统一规则：

| 允许 | 不允许 |
|---|---|
| 显示线路、命中率、稳定性 | 参与订阅归属（不能因模型名像 claude-* 就算进 Claude Pro） |
| 显示「按模型名参考估价 ≈¥0.22/M」（价卡由模型名唯一映射时） | 作为 `marginal`、进 `recommendation` |
| 状态「路由待确认」+ 入口到设置 → 数据源 | 产出 W1 金额告警（可在命中率列显示异常，不出告警行） |
| 进周排名的**观察列表**（标 ⓘ） | 进周排名的名次序列 |

模型名歧义（同名多卡、缓存语义不同）→ 不估价，只显示用量与命中率。

### 5.3 无价卡（GLM 等）

显示命中率与用量、标「无价卡」，不算单价、不排序、不告警、不借邻卡。真机 GLM 579M tokens。

### 5.4 价卡与汇率快照（历史周的输入）

`pricing_snapshots` 每次价卡更新落一条；快照**必须同时冻结 `fx_estimate`**（USD→CNY）。历史周按该周生效的快照取价与汇率，不用当前值回算——否则价卡未变、汇率变化时旧周人民币单价与名次照样漂移，AC11 不成立。缺历史快照的周用最早快照，标 `snapshot_basis: "earliest"`。`resolve_card` 增加快照参数（现读内置 `assets/pricing.json`）。

### 5.5 订阅额度与月费

- Codex：`data_codex_quota`（plan 快照，正向周期，仓库已读）。
- Claude Pro：`quotaLimits` 拒绝事件（§8.3.1，仓库尚无读取器）。
- 用户声明月费：`billing_declarations` / `harness_bills`，只用于"值回月费倍数"，不提供额度。

## 6. 架构落点

| 层 | 内容 | 锁步 |
|---|---|---|
| `agent-vitals-domain::route`（新，纯） | `model_family`、`effective_unit_cost(mix, snapshot)`、`switch_first_round_cost`、`stability(hit_series, threshold)`、`route_threshold`、`w1_excess(series, threshold, snapshot)`、`rank_routes`、`weekly_rank_delta` | Rust ↔ Python (`agent_vitals/agent/route.py`) 差分；单测用 §3.4 / §4.6 真机数字钉住 |
| `agent-vitals-harnesses::claude_code` | `quota_limits` 读取器（§8.3.1） | Python 镜像；差分钉 36 条真机事件 |
| `agent-vitals-runtime::summary` | `route_daily_mix` SQL + memo；family 归一后聚合；`route_decision` DTO；`route_weekly_ranks` 重放 | 形状由 Rust 序列化定义，mock 注明出处 |
| `agent-vitals-data` | `pricing_snapshots` 增加 fx 字段；`route_weekly_ranks` 投影表 | 可重建 |
| Tauri | 命令 `route_decision { days }`；`quota_window_alerts` tick | 与 `data_codex_quota` 并发 |
| 前端 | 总览精简卡（§8.1）；用量页线路对比与周排名（§8.4） | vm 测试 + 无头 Chrome 守卫 |
| MCP | `route_decision` 资源 | 复用 runtime |

### 6.1 DTO（`route_decision`）

```jsonc
{
  "window_days": 14,
  "snapshot": { "card_id": "ps_20260901", "fx_usd_cny": 7.15, "as_of": "2026-09" },
  "overall_mix": { "uncached": 0.045, "cache_read": 0.944, "cache_write": 0.008, "output": 0.0026 },
  "overall_hit": 0.95,
  "routes": [
    {
      "harness": "claude-code", "provider": null, "provider_inferred": "deepseek", "model_family": "deepseek-v4-flash",
      "billing": "unknown",                       // metered | subscription | unknown（推断线路恒 unknown）
      "currency": "CNY",
      "tokens_window": 1416600000,
      "hit_median": 0.98, "hit_p10": 0.96, "days_below": 0, "eligible_days": 12,
      "threshold": 0.90, "threshold_basis": "adaptive",
      "stability": "stable",
      "worst_day": null,
      "reference_unit": 0.22, "reference_switch_unit": 3.04,   // 推断线路：参考估价，非 steady_unit
      "steady_unit": null, "switch_unit": null,               // 只有已归属线路才有
      "unit_basis": "model-name-inferred",
      "marginal": null,
      "quota": null,
      "subscription_value": null,
      "note": "路由待确认；按模型名参考估价"
    },
    {
      "harness": "codex", "provider": "openai", "provider_inferred": null, "model_family": "gpt-5.6-luna",
      "billing": "subscription", "currency": "USD",
      "steady_unit": 0.19, "switch_unit": 1.44, "unit_basis": "official-price-card",
      "marginal": 0,
      "quota": { "state": "available", "remaining_pct": 62, "resets_at": 1789000000, "observed_at": "2026-09-13T09:32:00Z" }
    },
    {
      "harness": "claude-code", "provider": "anthropic", "model_family": "claude-sonnet-5",
      "billing": "subscription",
      "quota": { "state": "unknown", "window": "five_hour", "resets_at": null, "rejections_7d": 3, "fallback_available": true }
                                                  // Claude Pro 永无 remaining_pct；state ∈ exhausted|unknown
    }
  ],
  "weekly": { "current_week": "2026-W37", "weeks": [ /* 12 周，每周 { week, snapshot, ranks:[{route, rank, rank_delta, steady_unit, hit, reasons[]}], observed:[推断线路] } */ ] },
  "recommendation": {                             // 取不到时整块 null，前端隐藏推荐区
    "now": "codex/openai/gpt-5.6-luna",
    "after_quota": null,                          // 真机现状：按量且已归属的线路没有 → null，不编
    "reason": "Codex 额度剩 62%（20:13 重置）"
  },
  "alerts": [
    { "kind": "w1_suspect", "route": "dsh/shengsuanyun/deepseek-v4-pro", "days_below": 4, "eligible_days": 12,
      "hit_median": 0.35, "excess_miss_tokens": 337000000, "estimated_excess_cny": 2932, "basis": "estimated",
      "peak_basis": "peak-upper-bound" }
  ],
  "unpriced_routes": [ { "harness": "claude-code", "model_family": "glm-5.3-flash", "tokens_window": 579000000 } ]
}
```

## 7. 诚实性规则（写进 domain docstring 与卡面 hover）

1. **单价 ≠ 划算**。¥/M 只回答"同等 token 消耗下谁便宜"；卡面副标题固定"只比钱，不比质量"。
2. **缓存不可迁移**。跨线路比价必须同时给切换首轮单价。
3. **订阅是沉没成本**。边际 0 ≠ 免费；订阅行同时显示"值回月费倍数"。
4. **未知不参与推荐**。额度未知、已耗尽、无价卡、部分计价、推断线路、样本不足——一律 `marginal = null`，只显示不推荐。
5. **W1 是嫌疑不是浪费**。金额按 §4.6 可复算、标 `estimated`、不进浪费分子。
6. **推断只能显示参考**。模型名推断不升级为 provider / billing 结论，不进订阅归属、不进推荐、不出 W1 告警。
7. **未知不显示为 0**。缓存写价未声明 → 部分计价；无价卡 → 不估算。
8. **单日 ≠ 不稳定**。`incident` 与 `unstable` 分开。
9. **样本不足不下结论**。
10. **峰谷按实测占比**，判不出按峰值并标注。
11. **历史周用历史价卡与历史汇率**。快照同时冻结两者。
12. **负向快照只能推出"已耗尽直到 R"**，推不出剩余比例；R 过后回到未知。
13. **DTO 形状由 Rust 序列化定义**，mock 注明函数+行号。

## 8. 呈现

### 8.1 总览：精简决策卡（不塞表格）

六列六行在小窗口和 200% 字号下必然拥挤。总览只展示三件事，其余去用量页：

```
现在该用谁                     按最近 14 天用量结构 · 只比钱，不比质量           全部线路 ›
──────────────────────────────────────────────────────────────────────────────
★ 先用 Codex · GPT-5.6 Luna        额度剩 62% · 20:13 重置 · 套餐内
  额度用完后                        DeepSeek V4 Flash 经 Claude Code · 路由待确认，按模型名参考估价 ≈¥0.22/M
                                     （切换首轮 ≈¥3.04/M，尽量不要来回切）
──────────────────────────────────────────────────────────────────────────────
⚠ DeepSeek V4 Pro 经胜算云：14 天有 4 天命中率低于阈值，多付约 ¥2,900（估算）        查看逐日 ›
  Claude Pro：5 小时窗口已用完，10:50 重置 · 本周撞窗 3 次
```

- 第一行 = `recommendation.now`；`null` 时整行隐藏。
- 第二行 = `recommendation.after_quota`；`null` 时显示**观察项**（如上例的推断线路），前缀明确"路由待确认，参考估价"，不写"最便宜"。
- 异常区最多两条：W1 告警（§8.2）与订阅窗口状态（§8.3.2），按紧急度排；没有则不显示。
- 「全部线路 ›」→ 用量页线路视图（§8.4）。
- 卡面不出现任何 DTO 内部词（`provider_id`、`W1`、`excess_miss`），可见性守卫词表黑名单。
- 小窗口/200%：三行自然折行，无表格列。

### 8.2 W1 告警（通知组件 warn 级）

只在 `alerts` 非空时出现，文案固定：「{线路}：最近 {N} 天有 {days_below} 天缓存命中率低于阈值（中位 {hit_median}），按官方价估算多付约 {estimated_excess}（估算）」；缺价时改为「约 {excess_miss_tokens} tokens 本可命中缓存（未估算金额）」。同一线路 14 天一条；`incident` 不告警；不可关闭，随线路恢复 `stable` 自动消失。

### 8.3 时间窗口提醒（系统通知钩子，与排行分离）

提醒答"什么时候该动"（事件驱动、分钟级、可关闭），排行答"动到哪去"（周期、周级、不可关闭）。唯一接点：通知正文里的"建议切到 X"取自 `recommendation.after_quota`；`null` 时只发前半句。

#### 8.3.1 触发源

| 线路 | 数据形态 | 触发 | 级别 |
|---|---|---|---|
| Codex | plan 快照，正向周期（`rate_limits.primary{used_percent, resets_at}`，仓库已读） | 剩余 ≤ 15% / ≤ 5% | warn / danger |
| Claude Pro | `session.jsonl` `assistant` 事件顶层 `quotaLimits`——**仅被拒绝时出现**：`rateLimitType(five_hour/seven_day)`、`resetsAt`(Unix 秒)、`status:"rejected"`、`isUsingOverage`、`unifiedRateLimitFallbackAvailable`；无 `used_percent`。仓库尚无读取器 | 收到 rejected | danger |
| 任一 | `resetsAt` 到点 | 窗口重置 | info（默认关） |

真机锚点（2026-09-13）：70 个会话文件、36 条 `quotaLimits` 全部 rejected；09-11 一天内连撞三个 5 小时窗（重置 10:50 / 15:50 / 次日 02:00）。

#### 8.3.2 Claude Pro 三态（不得显示百分比）

```
unknown ──(rejected, resetsAt=R)──► exhausted until R ──(now ≥ R)──► unknown
```

`exhausted`：卡面「已耗尽 · 10:50 重置」，边际 +∞。`unknown`：「窗口状态未知 · 本周撞窗 N 次」（`seven_day` 单独标「周窗已耗尽」），边际 `null`。R 过后**不得**显示 100% 或任何剩余比例。

#### 8.3.3 通知规则

- 正文：`Codex 额度剩 12%，20:13 重置` / `Claude Pro 5 小时窗口已用完，10:50 重置`，后接 ` · 建议先切到 X（≈¥/M）` 仅当 `after_quota ≠ null`。
- 去重：复用 `runtime::budget_notifications` delivery-key，key = `(线路, resets_at, 档)`；Claude 同窗口多条 rejected 合并一条。
- 点击：打开总览并高亮决策卡（新增 `focus_route_decision`，复用预算通知的导航目标机制）。
- 设置 → 提醒：按线路开关 + Codex 阈值；默认开 Codex 与 Claude 限流，重置提醒默认关。
- 诚实边界：Claude 永不发"剩余 x%"；Codex 快照 > 60 分钟未更新时正文带"（快照 HH:MM）"；`fallback_available = true` 时加"Claude Code 可自动回退到其他模型"。
- 应用内镜像：同一事件在总览出一条 danger 级 `.notice`，不可关闭，`now ≥ R` 自动消失。

### 8.4 用量页：全部线路与周排名

完整表放这里（六列：线路 / 命中率(中位) / 稳定性 / 稳态 ¥/M / 切换首轮 / 边际），推断线路以「参考估价」列区分且置于分隔线下；12 周排名走势（每线路名次折线 + 价卡/汇率快照变更竖线）；点线路 → 逐日命中率。

### 8.5 与现有元素的关系

- 缓存命中率**不**回到 KPI 卡（规格第 82 行），只在线路维度显示。
- 「费用明细」按服务商分组（答"钱付给谁"），线路视图按线路（答"走哪条"），粒度不同是刻意的。
- 窗口提醒不改变排行的任何计算；排行不感知提醒是否发出。

## 9. 验收标准

| # | 断言 | 层 |
|---|---|---|
| AC1 | `effective_unit_cost` 对 §3.4 各线路结果与本文一致（±0.01） | domain 单测（Rust + Python 差分） |
| AC2 | 胜算云线路在真机 fixture 上判 `incident`（非 `unstable`），稳态单价按正常 mix 计算 | domain 单测 + 真机夹具 |
| AC3 | `days_below ≥ 4` 判 `unstable` 并产出 W1；`eligible_days < 5` 判 `insufficient` 且无告警、不进推荐 | domain 单测 |
| AC4 | 推断线路：`billing = unknown`、`marginal = null`、`steady_unit = null`、`reference_unit` 有值、不在 `recommendation`、不在 `alerts`、不进周排名名次序列 | domain 单测 |
| AC5 | 无价卡线路 `reference_unit = steady_unit = null`；缓存写未声明的价卡 → `steady_unit = null` 且 `unit_basis = "partial-price-card"` | domain 单测 |
| AC6 | 订阅线路：`quota.state = available` 且 ≥ 15% → `marginal = 0` 排最前；额度未知/耗尽 → `marginal ∈ {null, +∞}`，不进 `recommendation.now` | domain 单测 |
| AC7 | `route_decision` 60s 内重复调用命中 memo | runtime 测试 |
| AC8 | 总览卡：推荐行、备选行、≤ 2 条异常；`recommendation = null` 时推荐区隐藏；无表格列 | 无头 Chrome 守卫 |
| AC9 | 卡面文本不出现 `provider_id`、`W1`、`excess_miss` 等内部词 | 守卫词表黑名单 |
| AC10 | mock 形状注明 Rust 序列化函数与行号；键集逐字一致 | 形状测试 |
| AC11 | 价卡**或汇率**快照变更后，变更前各周 `steady_unit` 与 `rank` 字节不变；变更周 `reasons` 含 `price_change` / `fx_change` | domain + runtime |
| AC12 | `new_route` / `dormant` 语义正确 | domain 单测 |
| AC13 | `hit_change` 阈值 5pp；`mix_change` 仅在名次变动时产出 | domain 单测 |
| AC14 | `route_weekly_ranks` 删表后幂等重放字节一致 | runtime |
| AC15 | 同一 `model_family` 的多个原始 `model_id` 在 `routes` 中只出现一行；未命中映射的 id 原样保留并标记 | domain + runtime |
| AC16 | 线路阈值 = 30 天中位 − 8pp（clamp 60–95%）；合格日 < 10 回退默认表；Codex 中位 94% 线路的 85% 日不判低于阈值 | domain 单测（真机夹具） |
| AC17 | W1 金额按 §4.6 复算：胜算云事故日 `excess_miss ≈ 337M`、峰值估算 ≈ ¥2,932；缺 `P.u/P.r` 时金额 `null` 只报 tokens；< ¥10 显示"少量" | domain 单测（真机夹具） |
| AC18 | Claude Code 读取器解析 36 条真机 `quotaLimits` 字段齐全；Python 差分一致 | harnesses + 差分 |
| AC19 | Claude Pro 三态转换正确；任何状态 DTO 无 `remaining_pct` | domain 单测 |
| AC20 | 同 `(线路, resets_at, 档)` 只投递一次；同窗口多条 rejected 合并；开关关闭不投递 | runtime（复用 budget_notifications 夹具） |
| AC21 | 通知正文在 `after_quota = null` 时不含"建议"子句 | runtime 单测 |

## 10. 发布边界与分阶段

本规格整体属于 **`v1.1`**。它包含新 SQL 投影、价卡/汇率历史、Claude 读取器、系统通知、跨语言锁步、MCP 与线路趋势页，已是独立版本范围。**alpha.1 不输出推荐**：§3.4 已证明整段聚合会给出错误的"高成本"结论，在稳定性规则落地前推荐等于把已知风险包装成结论。

| 版本 | 可交付 | 验收 |
|---|---|---|
| **`v1.0.0-beta.1`** | 现有「现在该用谁」卡：**只展示有明确配额证据的 Codex**（剩余 %、重置时间、<15% 告急文案）；按量线路只作为"参考备选"文字，不排名、不标"最便宜"；不做单位成本排名、W1 金额、Claude 限流通知、历史周排名。费用明细按服务商分组保持现状 | 现有 vm 测试 + 可见性守卫 |
| **`v1.1.0-alpha.1`** | 线路四桶逐日聚合 + family 归一（§5.1）；价卡完整性（缓存写字段补齐，§3.1）；`effective_unit_cost` / `switch_first_round_cost`；**无推荐的线路观察页**（用量页 §8.4 的表，稳定性列显示「未分级」）；Claude Code `quotaLimits` 读取器 + 三态 + 撞窗计数（只显示，不通知） | AC1、AC4–AC5、AC7、AC15、AC18–AC19 |
| **`v1.1.0-beta.1`** | 稳定性分级 + 阈值校准（§4.2–4.4）；**可信推荐**（`recommendation` 上线，总览精简卡 §8.1）；W1 非归因告警 + 可复算金额（§4.6）；价卡与汇率快照冻结（§5.4） | AC2–AC3、AC6、AC8–AC11、AC16–AC17 |
| **`v1.1.0` 后续** | 周排名 + 原因码 + `route_weekly_ranks`；Claude 限流系统通知 + Codex 阈值通知（§8.3）；12 周趋势视图；MCP 资源；trace 依赖的 W1 排除 | AC12–AC14、AC20–AC21 |

## 11. 开放问题

1. `incident` 判定里"单日 token ≥ 窗口 20%"的权重——胜算云案例满足，但要防止一个重度使用日被误判为事故。
2. 峰谷加权：`event_peak` 在 Claude Code 线路上是否可靠（DSH 有，其他执行环境可能恒 0）。
3. 推荐是否限定"最近 7 天实际在用的线路"（避免推荐三周没碰的线路）。
4. 周排名候选集是否包含"本周没用但价卡有更新"的线路（新模型/降价提醒 vs 导购）。
5. 自然周 vs 滚动 7 天：先自然周，滚动窗口留给趋势视图。
6. 价卡缓存写字段补齐前，Anthropic 之外几乎所有线路都会落"部分计价"——alpha.1 的价卡完整性工作需要先梳理每家缓存计费方式（自动缓存免费 / 显式写收费 / 未知）。
