# cc-trace 对本产品的应用研究

> 研究日期：2026-08-28。来源：[nanvon/cc-trace](https://github.com/nanvon/cc-trace)（main
> 分支，最后推送 2026-08-28，MIT）。**本文所有代码引用均已对照本地 clone 核实**
> （`git clone --depth 1`，HEAD `0f6610d` "版本号升至 0.1.23"），不是只看 README 的转述。
> 结论只写到「建议 + 取舍」，落地动作需单独评估。

## 1. cc-trace 是什么

Tauri 2 + Vue 3 + TypeScript + Rust 的桌面工具（macOS 菜单栏 / Windows 托盘），
实时显示 **Codex 与 Claude Code 的剩余额度**，并统计本机 **Token 用量与费用**。
同作者三个应用（cc-bar SwiftUI → 本仓库 Tauri 重构 → cc-trace-mobile）共享同一套
额度口径与视觉语言，数据互不互通。

两条数据源，只读：

- **账号额度**：`~/.codex/auth.json`（仅 OAuth）、`~/.claude/.credentials.json` +
  macOS Keychain（ADR-0013）；打官方接口
  `chatgpt.com/backend-api/wham/usage` 与 `api.anthropic.com/api/oauth/usage`。
- **本地用量**：只读扫描会话日志 JSONL —— Codex rollout
  （`session.jsonl` + `session_index.jsonl`）、Claude Code（`history.jsonl` +
  `project.jsonl`）、OpenCode（SQLite）、Pi。费用按公开 API 价格换算。

额度域模型（`docs/额度领域模型.md`）是 `QuotaWindow/QuotaSnapshot` 的事实来源：
四类窗口（`fiveHour`/`weekly`/`modelWeekly`/`unknown`），**未知窗口必须保留
`unknown`，不得猜成别的**；`remainingPercent` 统一在 Rust clamp 到 0–100；身份变化用
account id/邮箱的 SHA-256 前 16 hex 摘要检测（摘要落盘、展示身份不落盘，ADR-0025）。

## 2. 与本产品的重叠地图

两者**都从同一批会话日志（Codex rollout JSONL + Claude Code JSONL）折叠
token 用量与费用**。映射：

| cc-trace | 本产品 | 关系 |
|---|---|---|
| `usage/model.rs::TokenFacts`（uncached/output/reasoning/cache_read/cache_write_5m/cache_write_1h） | DSH `tokenUsage` / `usage.rs` 折叠 | **同一批 token 桶，字段一一对应** |
| `usage/model.rs::UsageEntry.dedup_key` | `usage.rs` 的 `(turn, step)` 去重 | 同一问题（一次逻辑计费出现在多个事件）的两种答案 |
| `usage/model.rs::ScanFileState.offset_bytes` + 各 source cursor | M3 state 层 `merge_month`（整文件重读） | **cc-trace 已做字节偏移增量，我们还没有** |
| `usage/pricing.rs` + `pricing-catalog.v1.json` + `pricing_remote.rs`（远程同步）+ `pricing_fingerprint` | `pricing.json` + build 时复制 + `test_pricing_lockstep.py` | 同一张价格表，两种维护策略 |
| `usage/usage_db.rs`（SQLite） | `month.json` + `month-archive.json` | 同一「跨调用累计」职责 |
| `providers/codex.rs`/`claude.rs`（额度接口 + 凭据） | `Cost::Quota` 变体（已定义、无活来源）；`codex-cost` 的 `plan` 块已从日志 `rate_limits` 吃进限速窗口快照 | **account-side 余额仍是 cc-trace 补上我们缺的一维；window-side 已从日志落地（§F）** |
| `contracts/usage.rs` | `token_by_model` / `token_by_date_model` / `cost_report` | 同一折叠的两种投影 |
| `examples/usage_audit.rs` + `scripts/compare_usage.py` | `tests/` 的差分门 + golden | **cc-trace 自带一个现成的差分 oracle** |
| Vue3 组件（UsageDailyChart/UsageModelTable/QuotaProgress/CompactView）+ HeroUI 视觉 | `docs/design/agent-vitals-menubar-concept-v1.png`（规划中的 Tauri 菜单栏） | 直接可借鉴的视觉/交互参考 |

**互补而非竞争**：cc-trace 不做任何行为审计——没有技能健康、SV601–614 探测器、
zombie/conflict/预算、轨迹检测。它只是「花了多少 + 还剩多少」的仪表盘。本产品是
「技能审计 + 会话行为审计 + 成本」。两者并行成立。

## 3. 可落地动作（按价值排序）

### A. 把 cc-trace 变成免费的差分 oracle（最便宜、立刻可做）

cc-trace 用**第三套独立实现**（不同于我们 Python+Rust 两套）解析同一批 Codex/Claude
日志。它的 `compare_usage.py` 已经写了「SQLite `usage_entries` 按
(day, source, model, speed) 分组」对账（`scripts/compare_usage.py:96`）。把它接进我们的验证：

- 同一批真实会话日志跑两个引擎，对账 `token_by_date_model` / `cost_report` 的月度
  总额与每日分桶 vs cc-trace 的 `usage_entries` 聚合。
- 价值：我们最硬的守恒律（「每个 token 恰好进 month.json 一次」「月总量与 per-session
  重算必须相等」）得到第四个独立实现的交叉验证；`carriesUsage()` 白名单的边界得到
  第二意见。
- 成本：一个只读对账脚本 + 本地跑一次。**不动生产代码。**
- **P4 已得独立背书**：cc-trace 的 Codex 解析（`usage/parser.rs:87`）读的正是我们 P4
  fixture 用的同一条路径 —— `token_count` → `payload.info.{last_token_usage,
  total_token_usage}`，桶字段 `input_tokens/output_tokens/cached_input_tokens/
  cache_write_input_tokens/reasoning_output_tokens`。两套独立实现 field-path 一致，
  P4 的线格式表没错。

#### A.2 实测结论（2026-08-29）：守恒律第四实现交叉验证通过，归属差异是 cc-trace 的 over-read

交付物 `scripts/cc_trace_oracle.py`（+ `tests/test_cc_trace_oracle.py`）对同一批真实
Codex rollout 日志（51 个文件）跑两套引擎，退出码只被**守恒律**驱动：

- **全量五桶 totals：5/5 逐字节全平**（uncached 58,362,171 / output 5,617,122 /
  cached 1,321,830,656 / cache_write 0 / reasoning 1,118,106）。
- **逐日总 token：25/25 逐字节全平**。这里修了 oracle 自身一个隐患：逐日总和按
  **六列互斥消费**加（uncached + output + cache_read + cache_write_5m + cache_write_1h
  + reasoning），不能按五桶加——cached_input ⊇ cache_write，按桶加会双计
  cache_write。真实语料 cache_write 恒 0 所以没炸过，fixture 钉了这行逻辑。
- **per-model 五桶分桶不平，但每桶各模型差值合计恰为 0** —— 纯重归属：归错模型但
  token 一个都没丢/多。守恒在桶级也保持。这维不 gate 退出码，只报告 + 归类。

**归属差异根因**（重放逐事件定位，`classify_attribution` 已数据复现）：cc-trace 的
Codex 模型游标从**三个**来源更新（`parser.rs:71-77` 读
`thread_settings_applied.thread_settings.model`），我们只从 `turn_context.model`
（`session_meta.model` 起手）更新。104 个差异事件形态：

| turn_context（我们归属） | thread_settings（cc-trace 归属） | 事件数 | token |
|---|---|---|---|
| sol | terra | 85 | 11,523,381 in / 45,888 out |
| sol | luna | 17 | 1,388,440 in / 4,543 out |
| terra | sol | 2 | 0 / 0 |

**判定：我们正确，cc-trace over-read。** 依据是事件流自身的 reverse 自然实验
（`rollout-2026-07-28…`）：

```
09:43:46  thread_settings.model=terra  (turn_context=terra)  ← 本轮正跑 terra
09:44:28  thread_settings.model=sol    (turn_context=terra)  ← settings 翻页到 sol
09:44:30  token_count … tc=terra th=sol                     ← 本轮仍 terra
09:44:39  token_count … tc=terra th=sol
09:46:55  turn_context=sol                                   ← 2.5 分钟后本轮才实际翻页
```

`thread_settings_applied` 是全量配置快照（model/service_tier/permission_profile/
collaboration_mode 一起落），**领先本轮实际翻页最多 2.5 分钟**；窗口内的请求仍由本轮
turn_context 声明的模型执行。settings 翻页**下轮生效**，不中途改执行模型。forward
方向（85+17 个「本轮 sol、settings 已翻 terra/luna」）是同一机制带真 token；2 个反向
事件落在同类窗口但带 0 token（零计量请求，归属无实际影响）。所以我们的
`turn_context`-only 归属规则是对的，**不改 codex 折叠代码**；若将来 cc-trace 反向
事件出现真 token（形态不再单向），需重新评估。

cost 金额两边天然不同（各自价格表，`codex_pricing.json` vs `pricing-catalog.json`），
只报告、不断言——token 守恒才是第四实现要验证的硬不变式。

### B. `session_index.jsonl` + `archived_sessions` —— Codex 的两个漏读

`usage/mod.rs:757-769` 显示 Codex 侧实际有**两个目录 + 一个索引**：

- `~/.codex/sessions`（live）—— 我们 P4 只扫了这个。
- `~/.codex/archived_sessions` —— **Codex 会把会话归档到这儿，cc-trace 两个目录都扫；
  我们只扫 live，归档会话的用量/成本会漏**。
- `~/.codex/session_index.jsonl`（`{"id", "thread_name", "updated_at"}`）—— cc-trace 用
  `usage/title_index.rs` 读它构建 `raw session id → 标题` 映射（只读、单行失败跳过、
  升级失败不报错）。我们没读，所以 `codex-evidence` 没有标题维度。

成本：读索引是纯新增低风险；补 `archived_sessions` 是覆盖完整性修复，涉及扫描根集合
（`codex_session` 的根、黄金档的 `archive` 语义），要小改适配器 + fixture。两件都
不进共享类型层。

### C. 字节偏移增量扫描，补 M3 state 层的「增量」缺环

我们的记忆已指出 Codex 明文 append-only JSONL 的字节偏移 checkpoint「比 DSH 的 zstd
简单」。cc-trace 的 `ScanFileState.offset_bytes` + per-source cursor + `ScanBatch`
（consumed_bytes/lines/invalid_lines）是现成设计。把 `merge_month` 从「每次整文件重读」
改成「从上次 offset 续读」，需要动 `state.py`/`usage.py` 的跨调用不变量——**M3 的
「每个 token 恰好进 month.json 一次」是出过事故的地方，要做成计划内重构而非快修**，
复用 `merge_month` 的幂等写语义。

### D. 计价维度：我们是 2 维，cc-trace 是 5 维

`pricing-catalog.v1.json` 一条目（48 条，按 `source × modelPrefix × speed`）：

```json
{ "source": "codex", "modelPrefix": "gpt-5.6", "speed": "standard",
  "uncachedInputUsdPerMTok": "5", "cacheReadUsdPerMTok": "0.5",
  "cacheWrite5mUsdPerMTok": "6.25", "cacheWrite1hUsdPerMTok": "10",
  "outputUsdPerMTok": "30",
  "usInferenceMultiplierBps": 10000,
  "longContextThresholdTokens": 272000,
  "longContextInputMultiplierBps": 20000, "longContextOutputMultiplierBps": 15000 }
```

计价维度对照：

| 维度 | cc-trace | 我们 |
|---|---|---|
| token 桶（uncached/cacheRead/cacheWrite5m/cacheWrite1h/output） | ✅ | ✅（DSH tokenUsage） |
| **`speed`（fast/standard，`normalize_speed`：`fast`/`priority`→Fast）** | ✅ `fast_multiplier_nanos` | ❌ 只有 peak/off-peak |
| **`usInferenceMultiplierBps`（US vs Global 地域）** | ✅ | ❌ |
| **`longContext`（>272000 token 的乘数）** | ✅ | ❌ |
| model | ✅（modelPrefix 前缀匹配） | ✅ |

`speed` 可从日志推导（Codex/Claude 事件里的 `speed` 字段），地域与 long-context 是
计费缺口。**菜单栏若要显示准确的 Claude Code 花费，这三维不补会一直偏**。
中成本（价格表扩展 + 每条请求的速度/地域/长上下文归属），中价值。

**注意：`speed` 不是通用维度，DSH 不要加。** 实测真实 DSH 会话（35,411 事件）里
`speed`/`fast`/`priority` 零命中——DSH 的「快档」是**不同的模型**
（`deepseek-v4-flash`，与 `deepseek-v4-pro` 同会话混用，靠 `data/header/config/model`
区分，`usage.rs:352,502` 已按模型分桶），价格表 `deepseek-official` 下 flash/pro 各自
有条目，价差已被模型名捕获。cc-trace 的 `speed` 之所以存在，是因为 Claude Code 的
Fast mode 用**同一个模型名**（opus）却按更高档计费，模型名区分不了才需要该字段。
→ 真正要加 `speed` 的地方是未来做 **P5（Claude Code 适配器）** 时。

**Codex 侧的成本折叠已落地（`agent-vitals codex-cost`，2026-08）**：给 Codex 做
cost fold 不再等 P5——`codex-cost` 就是 Codex 的成本引擎（USD、5 桶 + speed 行 +
longContext，见 `scripts/agent_vitals/agent/codex_cost.py` ↔ `src/codex_cost.rs`）。上面
三个缺口在 Codex 侧的落点：

- **`speed`**：Codex 日志有 `service_tier`（`turn_context`/`thread_settings_applied`），
  fold 保留 speed 游标，价格表 `codex_pricing.json` 里 `speed` 是**独立行**（fast 行
  ×2 是 catalog 写死的，不是代码乘的）。实测真实语料 1345 处 `service_tier` 全为
  `null` → 恒 `standard`，但解析路径完整（fast 行带 `longContextPriced:false`）。
- **地域（`usInferenceMultiplierBps`）**：Codex 日志无地域字段，catalog 里全部 codex
  条目 `usInferenceMultiplierBps == 10000`（=1.0×）→ 恒 Global，**不实现**（显式
  out of scope，注释说明即可，不臆造地域归属）。
- **`longContext`**：已补。`codex-cost` 按**单日聚合桶**的 `input_total` 判阈值
  （272000 → input ×2、output ×1.5）——不是按 by_model 合并后的模型总桶（合并桶
  会把「每天都没超窗」的多天小请求累加成假的大 input，凭空触发 LC，守恒测试当场
  红，见 `codex_cost_report` 的 LC 粒度注释）。
- **额度快照（`plan` 块，零网络，§F 的 log-side 一半落地）**：Codex 的 `token_count`
  事件自带 `rate_limits`——**即使 `info` 为 null 也读**（真实语料里 info:null 的事件
  仍带 rate_limits，配额是独立于 token 计量的状态）。折叠成 `plan` 快照
  （`plan_type`/`has_credits`/`limits`/`observed_at`），跨文件 merge 取 `observed_at`
  最新者；**`limits` 是「最后看见的非空限额」**——真实语料出过 primary/secondary 全
  null 的降级快照（2026-08-27 18:18 事件），直接覆盖会抹掉配额条，所以降级快照只
  推进 `observed_at`、不抹限额（fold 与 merge 同语义，Py↔Rust 两侧，见
  `codex_usage.rs` 的 `combine_plan`）。订阅套餐时仪表盘把美元重标价成「按量标价」
  （账单 = 套餐固定费），而不是伪造一个余额数字。
- **视图语义（2026-08）**：缺省 = 当前自然月（北京口径，与 DSH state 层一致），
  `--today` = 只看今天（过滤键 = 北京 YYYY-MM-DD），`--month all` = 全部月份，
  全量不再是缺省。输出契约带 `today` 字段，仪表盘热力图用它高亮「今」格。
  配额条的显示格式对齐 **Codex UI**（`plan` 行与配额面板同 spec，Py↔Rust 逐字节
  一致）：窗口标签 300→`5小时`/10080→`每周`，「剩余」= 100 − used、超限按 0 计，
  重置时间挂北京时区（今天 → `HH:MM`，否则 → `M月D日 HH:MM`，实测与 Codex 的
  「重置时间：10:03」「2026年9月4日 00:40」逐字对上）。行末附 `快照@{observed_at}`
  （ISO 原样）——日志读到的是最后一次写盘时刻而 Codex UI 是实时，快照时间戳诚实
  标注这种滞后（实测 5h 窗口日志 2% 已用 vs UI 5% 的差就来自这里，7d 窗口变化慢
  所以两边一致）。日志 `session_meta` 带 IANA `timezone`（本机 `Asia/Shanghai`），
  等于 UTC+8，是这套北京口径的交叉验证锚；通用 IANA→偏移（含夏令时）需 tz 库，
  属零依赖 CLI 之外，非 UTC+8 机器是独立的后续任务。

注意 `speed` 对 **DSH** 仍是「别加」：DSH 没有 `service_tier` 事件（实测 35,411
事件零命中），快档是不同模型（`deepseek-v4-flash`），价差已被模型名捕获。

**`effort` 同理不是计价维度（别加进成本引擎）。** 实测：DSH 38 份会话零 `effort`；
Codex 的 `turn_context.payload.effort` 取值 `low`/`medium`/`high`；Claude Code 的
`effort` 取值 `high`/`xhigh`/`max`/`off`（用户易把 Claude 的 high/max/off 误认成
Codex 同款）。**cc-trace 源码零 effort 处理**——它是准确计费的参考实现，定价全靠
token 桶（含 `reasoning_output_tokens`），证明 effort 不是价格乘数而是「思考强度」：
effort 越高 → reasoning 桶越大 → 花费越高，全部已被桶捕获。effort 若有用，是诊断/
provenance 字段（「这个 turn 为什么贵」），不是计价维度。

### E. 价格指纹 + 重计价（解决我们「历史月份用旧价格计价」的残余风险）

cc-trace 给每条 entry 盖 `pricing_fingerprint`，价格目录一变就用 `RepriceRow`/
`usage_audit.rs` 重算历史行。我们目前靠 build 时复制 + `test_pricing_lockstep.py`
守「三处价格一致」，但已入库的历史 `month.json` 仍可能带着旧价格。引入指纹后，
菜单栏/日历能检测价格表变化并对历史行重计价，不必等重建。低-中成本。

### F. 额度维（account-side 仍是产品决策；log-side 已落地一半）

**log-side 一半已落地（`agent-vitals codex-cost` 的 `plan` 块，2026-08，零网络）**：
Codex 的 `token_count` 事件自带 `rate_limits`，折叠直接读它（见 §D）——`plan_type`、
`has_credits`（`credits.has_credits`）、`primary/secondary` 的 `used_percent`/
`window_minutes`/`resets_at`、`observed_at`。这是**限速窗口的剩余情况**（如 5h/7d
窗口已用百分比 + 重置时间 + 套餐身份），**不是**账号余额/配额——后者需要打官方
wham/oauth 接口 + 凭据 + 网络，仍只能住执行环境侧。因为 `plan_type` 现在来自日志，
仪表盘对订阅套餐把每-token 美元诚实重标价成「按量标价」（账单 = 套餐固定费），
而不臆造余额数字：`Cost::Quota` 变体依然没有活来源，我们不为凑维度去编一个。

**剩下的 account-side 一半仍是产品决策**：cc-trace 的 `docs/额度领域模型.md` 是两个
官方额度接口（Codex wham/usage、Claude oauth/usage）的 field-path 权威，凭据来源
（auth.json、credentials.json、Keychain）与身份摘要方案全部现成。但做不做是一步产品
决策：它把本产品从「审计你的技能 + 你的花费 + 你的窗口剩余」扩展到「跟踪你的账号
余额」，需要网络请求与凭据处理——与本仓库「scan 时零网络」的约束冲突，只能住在执行环境
侧（Tauri 菜单栏 / dsh-client harness），不可能进 in-harness skill。若做，
`docs/额度领域模型.md` 是唯一事实来源；`QuotaWindow`/`QuotaSnapshot` 的纪律照搬
（未知窗口保留 `unknown`、`remainingPercent` clamp 0–100、身份 SHA-256 摘要落盘）。

### G. 菜单栏视觉/交互参考（免费）

cc-trace 的 CompactView、UsageDailyChart、QuotaProgress、HeroUI 风格、紧凑面板 +
「额度数字 + 余量分档着色」（ADR-0017）与 `docs/design/agent-vitals-menubar-concept-v1.png`
的诉求高度重合。直接当视觉参考取用。

## 4. 不做的事

- 不把 cc-trace 的扫描器代码搬进来（不同项目、不同域模型，且没有行为审计）。
- 不把本产品的技能审计/行为规则挂到 cc-trace 上——方向反了。
- 不改 cc-trace 的账号额度实现进 in-harness skill（零网络约束是铁律）。**日志里的
  `rate_limits` 快照不是账号实现**——`codex-cost` 的 `plan` 块只是读取会话日志本就
  带着的字段（`plan_type`/`used_percent`/`window_minutes`/`resets_at`），零网络，
  不碰凭据，也不臆造余额。

## 5. 推荐次序

1. **A（差分 oracle）** ✅ **已落地（2026-08-29）**：`scripts/cc_trace_oracle.py`
   + `tests/test_cc_trace_oracle.py`。实测守恒律 totals 5/5、逐日 25/25 逐字节全平
   ——第四实现交叉验证通过；per-model 归属差异已定位并判定为 cc-trace 的
   over-read（见 §A.2），不改我们代码。P4 线格式同时因此得到独立背书。
2. **B 拆成两件**：`session_index` 标题索引是纯新增、随下一次 Codex 适配器迭代带上；
   `archived_sessions` 是**覆盖完整性修复**（漏扫归档会话 = 漏成本），建议优先于标题。
   **✅ 两件都已落地（2026-08-28）**：
   - `archived_sessions`：`codex_session_roots_report` 成为 Codex 会话根集合的单一事实
     来源（live + archived 一起报告，存在性探测），`codex-evidence --roots` 列出两个根
     的存在/数量/字节；`probe_logs.py` 的 `CANDIDATE_DIRS` 同步补上。
   - 标题索引：`parse_session_index`/`read_session_index` 读 `~/.codex/session_index.jsonl`
     建 `{逻辑 session_id → thread_name}` 映射（实测 session_id 命中 47/51，rollout 文件
     名 UUID 只命中 21/51——join 键必须用逻辑 id），`codex-evidence <rollout>` 输出新增
     `title` 维度（索引缺失/不在索引 → null，存在性探测）。join 键**不是** cc-trace 用的
     `payload.id`——cc-trace 按文件名索引纯展示，我们按逻辑会话 id 才能覆盖被恢复的
     rollout（28/51 是 resume）。
3. **F（额度维）**：log-side 一半（`plan` 快照 + 按量标价重标价）已随 `codex-cost`
   落地，零网络、零凭据。account-side 一半（官方接口余额）先做产品决策；若做，
   `docs/额度领域模型.md` 是唯一事实来源。
4. **C/D/E** 各自独立，等菜单栏（消费 `token_by_date_model` 折叠的 Tauri 工作）落地时
   一并评估——它们本质上是同一个「菜单栏要显示准确花费」的问题。D 是三件事：
   `speed` 可从日志推导（最便宜）、地域与 longContext 是纯价格表扩展（次之）。
