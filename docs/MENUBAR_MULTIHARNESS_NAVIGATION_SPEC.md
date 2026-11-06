# 菜单栏多执行环境导航（执行环境 → 最近会话）—— 设计 spec

状态：**v1.3（2026-09-02）**。v1.1 的 Phase 1/2（投影命令 `sessions navigation`、L1 执行环境行、
L2 最近 N 深链、`WorkbenchTarget` 双通路、前端 harness 过滤）已随 2026-09-01/02 系列提交落地；
v1.2 加 Claude Code 成本数据面（第三执行环境行 claude-code + 顶层账卡分列 + claude-sync 尾折，
Rust/Python 差分逐字节，golden 15/15）。本版把 v1.2 的「追加 `Claude 估` 后缀列」改成
**顶层钱行 = Σ 按量流合并总账**——用户真机那天（DSH 空转、钱全在 Claude Code 里跑的
deepseek 流上）分列呈现成 `¥0 · Claude 估 ≈¥37.17`，顶层「按量成本」行读起来像真没花钱，
用户据此报 bug。本版修订（均已实现）：

1. **第三执行环境行 `claude-code`**（原固定两行 dsh→codex 变三行，键序稳定）。claude 执行环境行的
   `today_tokens` basis=**ledger**（`claude_ledger_day_tokens` 读 claude-ledger 当日 flat
   日 4 型 token 总量，SNAKE_KEYS 唯一真源），`today_sessions`/`recent` 复用 r2a
   `SessionStore::claude_code`；ledger 当日缺席 → null 三元组（status partial，诚实形态）。
2. **顶层钱行 = 合并按量总账**（`metered_amount`，替代 v1.2 的追加列）：`今日/本月按量成本`
   是 **Σ 按量流**——CNY 主账 = **DSH 实测 + Claude catalog CNY 估 相加**；任何 Claude 估
   分量并入 → 整段前缀 `≈`（`今日按量成本：≈¥37.17 · 188.2M tokens`），纯 DSH 段保持实测
   精度、不带 ≈（一笔实测 ¥ 不标成估）。anthropic USD 流按 §3.1 套餐排除、**不进 ¥ 主账**
   （混币不能相加），只在整行完全没有 ¥ 侧（DSH 也没折到账 + Claude 无 CNY 价流）时单独
   浮出 `≈$B`（measured 不消失）。今日行 token 同源合并（`today_merged_tokens` = DSH 当日
   + Claude 当日 ledger 4 型，token 与价目卡无关）；本月行只显金额、**去掉 `/ ¥600` 分母**
   （分母是 DSH 预算——合并后 ¥ 主账已跨执行环境，拿 DSH 预算当整个总账的分母是把两件事绑成
   一行；DSH 预算状态常驻在底部预算行 budget_item）。**预算/alert 仍 DSH-only**（D2）。
3. **tick 顺序**变为 DSH discover/oneline → `claude-sync`（claude 账尾折）→ 执行环境区刷新 →
   emit；claude-sync 幂等（size/mtime 指纹），失败 → SyncStatus `fail("claude-sync", …)`
   留痕不 abort tick（执行环境行照刷）。`上次同步` 行后缀（DSH 折叠 + Claude 账）。

**v1.3 修订说明（为何 v1.2 的「独立后缀列」被合并总量取代）**：v1.2 把 Claude catalog 折算
挂成 DSH ¥ 之后的 ` · Claude 估 ≈¥B/≈$C` 后缀列，理由是「估算不进主账单、与实付精度隔离」
——但用户读顶层行是按 §3.1 决策 1 的口径读的（**钱行 = Σ 按量流总量**）：那笔在 Claude Code
里跑的 deepseek 是**真按量**（用户没有套餐），只是价卡是 catalog 折算的估算而非实付账单。
v1.2 把它放后缀，顶层呈现 `¥0 · Claude 估 ≈¥37.17`，读数像「真没花钱」。v1.3 走回 §3.1
决策 1 的「按量流并入同一总量」：deepseek 就是按量供应商，从哪个 harness 跑都一样，钱行就该
是 Σ。估算并入后**整段标 `≈`** 保住 D6 诚实性（不假装实付）；USD/CNY 仍分币种不混加，anthropic
套餐流仍不进 ¥ 主账。这与 DSH 侧 `费用（估算）≈ ¥…` 的先例同构——DSH 对无 by_model 的日
子也标 ≈ 兜底，不是只有 Claude 需要「估算」标签。§3.1 的「绝不每执行环境一行钱」本版恢复为主账
规则（顶层钱行永远一个总数，不拆三执行环境钱）；v1.2 的「per-harness 成本行」仍然不做（§10 Phase 3）。

（v1.1 原修订记录保留如下。）

v1.0 于 2026-09-01 经设计评审，5 个阻断问题（2×P0 + 3×P1）在本版全部修订：

| # | 级别 | 问题 | 本版修订 |
|---|---|---|---|
| 1 | P0 | 顶层「今日/本月/预算」行是 DSH-only，却被当全局行 | 钱行语义定为**按量计费总成本**（Σ 按量流），标签按计量语义不按执行环境名（`今日按量成本`）；**「按量 vs 套餐」按供应商/模型分，不按执行环境分**——Claude Code 实测跑 DeepSeek（按量），claude-\* 家族走 Claude Pro 套餐（§3.1），套餐（Codex）与 token plan（MiniMax）不计入；未来按量流并入同一总量（§3.1） |
| 2 | P0 | Codex「今日 token」按 date_span 交叠过滤 + 整会话 `tokens_total` 求和——跨日会话整段算进今天，是指标错误 | 新增只读投影命令 `sessions navigation`，Codex 今日 token **从事件时间按北京日界折叠**（复用 core 现成 `codex_hour_of`/折叠，见 §6 决策 3/4） |
| 3 | P1 | 第一页 `--page-size 50` 取不到全局最近 5 个（list 按 SessionKey 序，页内排序 ≠ 全局） | 最近 N 在**数据层全量排序后分页**：core 新增纯比较器 `recent_cmp`（`date_span.last DESC, session_revision DESC, SessionKey ASC`）+ Python 镜像锁步（§6 决策 2） |
| 4 | P1 | 工作台无 harness 过滤；`focus_session(Value)` 表达不了「打开列表按 harness 过滤」 | 强类型 `WorkbenchTarget` 枚举 + 工作台会话页加真 harness 过滤 + 「持久 pending target + 窗口 focus 事件通知」双通路（§7） |
| 5 | P1 | 刷新执行模型未定案：spawn 次数矛盾、`Command::output()` 无超时、无 stale/防旧覆盖 | 单命令单 spawn、single-flight（SyncLock）、20s 超时 + kill、保留末次成功快照标 stale、generation 由同步单写保证（§6 决策 5） |

其他修正：`date_span.last` 前 8 字符是 `YYYY-MM-` 不是 `MM-DD`（改为 `[5..10]`）；L2 行用**截断标题优先**（防同 `<日期·模型·tokens>` 多行不区分）；执行环境区**始终渲染**固定 dsh→codex 两行（不再「整体失败不渲染」）；Phase 3 移除 live 指示矛盾；测试补齐跨日/全局 recent/partial coverage/超时/旧覆盖/动态菜单 ID/端到端跳转。

架构要点：数据组装从「托盘 4 次 `sessions list` spawn 拼装」改为**单只读投影命令**（`sessions navigation`），返回 versioned `HarnessNavigationSnapshot`；**Tauri 只缓存快照并渲染菜单，不负责重新解释测量数据**——排序、日界折叠、覆盖率全部在数据层完成。Codex 北京日界折叠**不是新测量**，复用 core 现成折叠链路（`codex_fold_file`/`codex_aggregate_hours`/`codex_by_model_from_hours`，`crates/agent-vitals-core/src/adapters/harnesses/codex/sessions/usage.rs` ↔ `scripts/agent_vitals/agent/codex_usage.py`，已在差分守卫下）。

## 0. TL;DR

- **现状托盘菜单全平、单执行环境**：今日成本/日预算/本月成本/最近会话/预算状态/同步/打开工作台/立即同步/退出（`src-tauri/src/lib.rs:271-335`），数据全部来自 DSH state 文件（today.json/month.json/alert.json/oneline.json），**对 Codex 无感**。
- **CodexBar 是「每 provider 一个状态图标 + popover tiles（用量条 + reset 倒计时）」、Merge 模式把多 provider 折进单图标 + 每 provider 概览行**。结论：抄「每执行环境一行状态」，不抄「菜单里列会话」（会话/成本历史在持久化视图）。
- **设计**：L1 每执行环境一行 = 今日 token + 今日会话数（**token 轴**，规避 DSH-CNY vs Codex-USD 币种分叉）；L2 = 该执行环境最近 N 个会话的**跳转清单**（身份字段、无成本列），点击深链到工作台会话详情。L2 是「跳转」不是「浏览器」——浏览/分页/过滤是工作台会话 tab 的职责。
- **数据源**：执行环境区统一走新投影命令 `agent-vitals sessions navigation --day <北京今天> --recent 5 --json`（§5），一次 spawn 返回三个执行环境的 `HarnessNavigationSnapshot`；DSH 今日 token 读 today.json（与顶层钱行**同源**），Codex 今日 token 从事件时间按北京日界折叠，Claude Code 今日 token 读 claude-ledger（basis=ledger，§5.2）。
- **诚实降级**：每个执行环境 status = ready / partial / unavailable；store 冷 build 失败/超时 → 执行环境行「—」+ 子菜单「会话数据暂不可用」，主入口（今日/预算/同步）照常；绝不臆造 0。
- **明确不做**：live「正在运行」指示、per-harness 今日成本（需币种决策，v2；**v1.3 例外**：Claude Code 的 deepseek 按量流按 catalog 折算并进顶层**合并**总账——那不是 per-harness 行，是同一条 ¥ 主账里的估分量，见顶部 v1.3 修订）、reset 倒计时。

## 1. 背景：CodexBar 对照

CodexBar（Swift 原生 macOS 14+ 菜单栏 app）的事实（README + 截图描述）：

- 默认**每 provider 一个菜单栏图标**，图标本身是微型用量表；有 merge 模式合并成单图标 + 切换器。**Merge 模式 = 单图标 + 每 provider 一个概览行 + 点击进 provider 详情**（6 provider 的 overview 行是 CodexBar 的多 provider 形态）。错误/过期数据可置灰或显示 incident 指示。
- 点开是 **popover**：provider tiles（icon / name / usage bar / reset countdown，session/weekly/monthly 窗口）。
- **会话/成本历史刻意放在持久化视图（Settings → Usage & Spend），popover 里不列会话**。

三条对照结论：

1. **保持单图标，不抄多图标**。Tauri 一个 tray 挂一个菜单天然就是「单图标 + 内部分层」——CodexBar 的 merge 模式正是我们的既有形态，不用变。我们的 3 个执行环境 ≈ CodexBar 的 6 provider overview rows：L1 每执行环境一行 + 展开进执行环境详情。
2. **抄「每执行环境一行状态」**：一眼看出哪个执行环境今天在烧 token。这是 CodexBar 真正做对的地方，也是我们单执行环境菜单暴露的断层（§2.3-1）。
3. **不抄「列会话」**：CodexBar 明确把会话/成本历史留在独立视图。我们的工作台会话 tab 已经是这个独立视图，菜单栏再展开 10 行会话是重复造一个更差版本。

CodexBar 有而我们**不该**抄的：reset 倒计时（provider 额度窗口，我们审计的是本地成本没有额度窗口）；live 指示（无可靠 running 信号，§2.3-6）。

## 2. 现状盘点

### 2.1 托盘（src-tauri，独立 workspace）

- 全平菜单，无 submenu 先例（`lib.rs:271-335` 全 `MenuItem`）。
- 数据源 `read_overview` → `overview.rs::read_overview`，**DSH-only**：today.json（今日 token + 成本）、month.json（本月）、alert.json（预算权威）、oneline.json（最近会话行）。
- 托盘标题「今日 tokens · ¥」（`today_title`，`lib.rs:162-171`）。
- tick 每 5 分钟 discover → spawn `oneline`（**DSH-only**，`lib.rs:485-495`），启动即跑一轮。
- 金额格式统一走 `fmt_money`（`lib.rs:33-37`）。

### 2.2 会话数据面（R2A store，二进制 crate）

- `sessions list --harness-kind dsh|codex --json`：`src/agent/r2a_store.rs:970-1045`；Tauri IPC 薄壳 `src-tauri/src/store.rs:128-149`（spawn 二进制 + stdout 解析 + 类型化错误透传）。**IPC 的 `Command::output()` 无超时（`store.rs:108-110`）——这是工作台路径，故意保留**：冷 cache 首建 30+ 秒是合法等待，前端有「加载中…」banner（`workbench.js:489-495`），加超时会打断它。菜单刷新路径**另立**超时契约（§6 决策 5），两者不共用。
- **harness_kind 硬编码两值**：`dsh` / `codex`。
- list 项字段（`Summary`，`r2a_store.rs:142-151`）：`session_key.harness_kind/native_id`、`title`、`model`、`date_span.first/last`（**UTC 日期**）、`tokens_total`、`findings_total`、`cost_usd`。**DSH 的 `cost_usd` 恒为 None**（`r2a_store.rs:202-203`）→ L2 不能带成本列。
- 分页页有 `total`。
- **排序 = SessionKey 四元组序**（harness_kind → native_id → source_profile → machine_namespace，`crates/agent-vitals-core/src/contracts/r2a.rs:22`、`:149-152`），**非时间序** → 「最近 N 个」不能直接取第一页。
- 日期过滤 = **date_span 交叠语义**：`[first,last]` 与 `[date_from,date_to]` 有交叠才算命中（`r2a.rs:201-216`）。**这只适合当「会话计数」的判定，不能当 token 归属的判定**——P0-2 的根因就在这。
- 工作台会话 tab 已消费同一命令（`workbench.js:414-505`），冷 cache 首建要几十秒；行已显示 `harness_kind`（`:540`），**但没有 harness 过滤**（`loadSessions` 只传 `pageSize`，`:487`）——P1-4。

### 2.3 Codex 北京日界折叠已存在（P0-2 的关键事实）

`codex_usage.rs`/`codex_usage.py`（core 纯函数 + Python 逐字节镜像，差分守卫下）已经有按北京日界折叠的完整链路：

- `codex_hour_of(event)`：事件时间戳（UTC ISO 串）→ 北京小时桶 `YYYY-MM-DDTHH`（`codex_usage.py:173-203`，`+8` 固定偏移、无夏令时；结构校验 + 日历合法性 round-trip，非法 → None 不编造）。
- `codex_fold_file(events)` → `{by_hour_model, by_model, unaccounted, plan}`：单 rollout 有序折叠；`unaccounted` 是残差哨兵（无效 last_usage / 首个 turn_context 前的 token，`codex_usage.py:249-253`）。
- `codex_merge_folds` / `codex_aggregate_hours` / `codex_by_model_from_hours(by_hour_model, prefix)`：跨文件合并 → 小时桶聚合成日期桶 → 按前缀过滤（`--today` 传 `YYYY-MM-DD`）。

`codex-cost` 命令（`main.rs:1278-1348`）已经用这条链路做**北京日**的折叠、过滤、计价。所以导航投影的「Codex 今日 token」直接复用，**不是新测量、不进差分 golden、不长第四份拷贝**。

### 2.4 六个缺口（本文要解决或明确不解决的）

| # | 缺口 | 本文处理 |
|---|---|---|
| 1 | 托盘对 Codex 无感，overview 无 per-harness 轴 | 解决：L1 执行环境行（§4） |
| 2 | 顶层钱行是 DSH-only 却被当全局 | 解决：加执行环境名前缀（P0-1，§4） |
| 3 | `sessions list` 无时间序，「最近 N 个」要全局排序 | 解决：core 新增 `recent_cmp`，数据层排序后分页（P1-3，§6 决策 2） |
| 4 | Codex「今日 token」的归属判定错误（date_span 交叠 + 整会话求和） | 解决：事件时间北京日折叠（P0-2，§6 决策 4） |
| 5 | 无 deep-link：工作台详情只能内部开 | 解决：强类型 WorkbenchTarget + 双通路（§7） |
| 6 | 无 live「正在运行」信号（dsh_autosync 已删） | **不做**（§11），"活跃"钉死为今日活跃 |

## 3. 需求与语义钉死

用户提议：「1 级导航是执行环境+执行环境（例如 Deepseek Harness 15k 活跃、Codex 20k），点击以后二级展开 10 个最近的 session」。

- **「活跃」钉死为今日活跃**：今日（北京日界）token 总数 + 今日会话数。**不是**「正在运行」——我们没有可靠的 running 信号，且用户示例本身就是 token 数。
- **L1 行用 token + 会话数，不用钱**：① 与用户示例一致；② 规避币种分叉；③ per-harness 成本需要币种决策（v2）。**钱不消失，但语义是「按量计费总成本」，既不是「某一执行环境」也不是「全 AI 总支出」**（P0-1，§3.1）：钱行 = Σ(全部按量流)，**按供应商（provider/模型）分，不按执行环境分**——Claude Code 是壳，本会话实测其 `message.model` = `deepseek-v4-*`（DeepSeek 按量流）；套餐（Codex）与 token plan（MiniMax）不计入；未来任何新按量流并入同一总量。
- **「10 个」改为前 5 个**：L2 是跳转清单不是浏览器——跳最近 5 个足够。10 个恰好卡在「jump 太多 / browser 太少」的死区。
- **v1 L2 没有「查看全部会话 →」行**（2026-09-01 用户决策）：L2 是纯跳转清单；工作台会话 tab 从既有「打开工作台」菜单项进入。深链 DTO 仍把 SessionList 变体定义成强类型（§7），v1 不发射。

### 3.1 成本轴与用量轴（P0-1 修订后的语义）

菜单有两条**正交**的轴，不要合并。成本侧的关键原则是：**「按量 vs 套餐」按供应商（provider / 实际服务请求的模型）分，不按执行环境（harness）分。** 执行环境只是壳——同一个 Claude Code 壳，后面可以跑官方 Claude（套餐）或 DeepSeek（按量）；成本归属看 `assistant.message.model` 是谁，不看哪个 harness 发起了会话。

**实测证据（2026-09-01 本会话）**：Claude Code 会话日志（`~/.claude/projects/*/session.jsonl`）的 `assistant` 事件里 `message.model = deepseek-v4-flash | deepseek-v4-pro`、`message.usage` 带完整 input/output/cache token——这两个模型名正是 `pricing.json` 里 `deepseek-official`（原厂，`-flash`/`-pro`）与 `shengsuanyun`（胜算云，`-pro`）的键。即**当前「Claude Code」这个 harness 实际在跑 DeepSeek 按量流**，与官方 Claude 订阅无关。

**计费类型判别位（2026-09-01 实测）**：
1. **账号级（权威）：`~/.claude.json::oauthAccount`**（repo 已读同一文件取 enabledPlugins，同源同模式）——实测 `organizationType: "claude_pro"`、`billingType: "apple_subscription"`、`organizationRateLimitTier: "default_claude_ai"`、`hasExtraUsageEnabled: false`。这是订阅身份的**持久化、程序可读**信号（用户确认是 Pro 会员，字段吻合）。
2. **请求级（模型推断）：`cost-state.hasUnknownModelCost`**（实测 5 个会话文件）——纯 `claude-*` 族 → `false`（官方可估成本）；任何含 `deepseek-*`/`MiniMax-*` 的族 → `true`（三方不知价）。※ 注（2026-09-01 实测）：`cost-state.totalCostUSD` 字段名虽叫 USD，但对三方模型数值量级是**常规价 ¥、不分时**——当前会话实测 `totalCostUSD=12.44`（= `~/.claude.json::lastCost`，同一源），repo 按 deepseek 常规价重算 ≈¥12.6（差 ~1%），而 repo 按 core 分时实付估算 ¥19.95（peak 翻倍）。costUSD 只能当「官方等效价」参照，不可当实付。
3. **剩余用量（5h/7d 的 0%/20%）——分执行环境（2026-09-01 实测修正：Claude Code 有 quota 数据但无百分比；Codex 有百分比且 repo 已读）**：
   - **Codex：本地有，周期正向**。`rollout` 每个 `token_count` 事件的 `payload.rate_limits` 带 `plan_type`（"plus"）+ `primary/secondary{used_percent, window_minutes, resets_at}` + `credits{has_credits}`——**repo 已读**：`codex_cost.py`（`_window_label` 300→`5小时`/10080→`每周`、`_pct_text`、「剩余」=100−used、`_reset_beijing_text`）、`codex_evidence.py:320`（QuotaConsumption 信号，`rate_limits` 须为 dict 才计）、`codex_session_audit.py`。这就是「5小时 0% / 7天 20% / 5d17h」的落盘源（primary window_minutes=300=5h、secondary=10080=7d，resets_at 换算即 5d17h）。
   - **Claude Code：本地有 quota 数据，但无剩余百分比**。session.jsonl 的 `assistant` 事件**顶层**有 `quotaLimits`——是**限流拒绝快照**（仅 API 返回限流错误时出现，实测 7 条分布在 8/24–8/27 三天的会话）：`rateLimitType`（`"five_hour"`|`"seven_day"`，与 /usage 的「5小时/7天」窗口同源——GrowthBook 缓存 `tengu_rate_limit_promo_notices` 的 `bar:"seven_day"` 亦证窗口命名）+ `resetsAt`（Unix 秒）+ `status:"rejected"` + `overageStatus`/`overageDisabledReason`/`isUsingOverage`/`upgradePaths`。**无 `used_percent`**：5小时 0%/7天 20% 那个百分比是 `/usage` 运行时从 Anthropic API rate_limit 响应读的，不落盘——agent vitals 只能读 `organizationRateLimitTier`（档位）与限流/重置证据（`quotaLimits`），不能读实时百分比。
   - **附加源（不进会话 JSONL）**：`~/.claude.json::projects.<cwd>.lastModelUsage` = Claude Code 自己维护的**最近会话 per-model 用量 + `costUSD`**（官方价估算；模型名带 `[1M]` 后缀；`lastCost` = 各模型 costUSD 之和——实测当前会话 deepseek-v4-flash 11.07 + -pro[1M] 1.37 = 12.44 对上，`lastSessionId` 指到当前会话 uuid）；同对象还有 `lastTotal*Tokens`/`lastSessionMetrics`（hook/渲染耗时分位）。零解析成本的用量/成本快照，但**非时间线**（无逐请求、无日期轴），且 costUSD 是 API 等效价非实付——作接入时的对照基准，不可当按量实付。
4. **路由级（harness 配置，强于模型推断——2026-09-01 实测补）**：`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_DEFAULT_*_MODEL` 是 Claude Code 的**模型路由开关**，决定请求打到哪个供应商、什么计费。**实测本机**：`BASE_URL=https://api.deepseek.com/anthropic`（DeepSeek 原厂 Anthropic 兼容端点）+ `AUTH_TOKEN=sk-…`（DeepSeek 官方 key）+ `DEFAULT_OPUS/SONNET/FABLE_MODEL=deepseek-v4-pro[1M]`、`DEFAULT_HAIKU_MODEL=deepseek-v4-flash` → **当前 Claude Code 全部请求路由到 DeepSeek 原厂，纯按量**；即使客户端写 `claude-*` 模型名也打 deepseek 端点。※ **诚实性：base URL 是进程启动时的环境变量快照，session.jsonl 不保留**（实测全事件扫描无任何结构化端点字段，命中全是对话文本）——历史会话读不出当时的端点；可追溯的替代判据是**模型名 + 缓存语义**：`claude-*` 且 `cache_creation>0`（Anthropic 官方 prompt caching，8/2–8/26 会话为证）→ 官方端点时期；`deepseek-*` 且 `cache_creation=0`（DeepSeek 自动缓存语义）→ DeepSeek 端点。provider 判定按「当前配置为准、历史按模型+缓存推断」，不假装确定。

综合：**claude-* 家族 = Pro 订阅（套餐）** 仅在旧配置（端点=官方 + 登录态）下成立；**当前本机路由配置下 claude-* 与 deepseek-* 一样是按量流**（供应商=DeepSeek 原厂，base URL 证明）——计费模式由 harness 路由配置决定，模型名不携带。「按供应商/模型分、不按 harness 分」仍成立，但「模型→计费类型」的映射要先经路由配置过滤。

按供应商（成本）分三类支出：

| 类别 | 供应商/模型 | 计费 | 是否计入钱行 |
|---|---|---|---|
| 按量流 | DeepSeek（`deepseek-v4-flash`/`-pro`；**Claude Code 流=原厂**（base URL 证明）、DSH 流=胜算云 gateway） | 逐 token 实付 | **计入**：Σ 按量流 = 按量总成本 |
| 套餐订阅 | Codex（GPT）$20/月、**Claude Pro（含 Claude Code）$20/月** | 固定周期费，与 token 无关 | 不计入（`codex-cost` 的 USD、Claude Code `cost-state` 的 costUSD 都是 API 等效价，非实付） |
| Token plan | MiniMax ¥114/月 | 预付固定额度 | 不计入（预付，边际成本 0） |

**同 harness 双计费**：Claude Code 一个 harness 内，`claude-*` 家族走 Pro 订阅（套餐，不计按量）、`deepseek-*` 家族走按量（计入）——cost 轴按模型家族分账，harness 只是载体。这与「用量轴按 harness、成本轴按供应商」的正交结构一致。

- **成本轴（顶层钱行）= Σ(按量供应商流)**。当前按量供应商只有 **DeepSeek 一个**，但它从**多个 harness** 可达：DSH（DeepSeek Harness）、Claude Code（本会话实测）。**流按供应商合并，不按 harness 分**——「Claude Code 跑 DeepSeek」的 token 归进 DeepSeek 流，而不是单开一条「Claude Code 流」。钱行不是「某一执行环境的成本」、也不是「全 AI 总支出」：套餐与 token plan 按定义不进按量账（混进按量账既无法逐 token 计价、也会让「今日成本」随订阅周期跳变）。真要一屏看「AI 总支出」，是另一条**固定成本输入**（订阅费/token plan 费），v2 候选（§10 Phase 3）。
- **用量轴（L1 执行环境行）= 每执行环境（harness）token + 会话数**：DeepSeek Harness / Codex / Claude Code / 未来，不带钱（币种分叉，§2.2）。执行环境行是**导航轴**（哪个壳、几个会话），与成本轴（哪个供应商、多少钱）**正交**——一个执行环境行的 token 可能喂给按量流（Claude Code→DeepSeek），另一个喂给套餐（Codex→GPT）。
- **未来按量流并入总成本**：新按量供应商（如 Claude API、OpenAI API 超量）要么扩展 state 折叠为多供应商账本、要么单独折叠后并入**同一总量**——钱行永远是总量，**绝不变成「每执行环境一行钱」**。新供应商若为美元，并入 ¥ 总量前需先定币种决策（Phase 3，§10）。

**数据面覆盖的诚实性（v1.3 已闭环，原「开放项」）**：钱行只报「当前数据面折叠得到的按量流之和」。v1.1 时代只折叠了 DSH 会话，Claude Code harness 跑的 DeepSeek 按量流不在账上——钱行是下界。2026-09-02 claude-sync 落地后 Claude Code 会话日志已可折叠（cost-state 基线 + 行尾增量，CLAUDE_CODE_INTEGRATION §9.3），口径是 **catalog 官方卡折算的估算**而非 DSH 的实付流。v1.2 为此把 Claude 估挂成**独立后缀列**不进主账；v1.3 改走 §3.1 决策 1 的「Σ 按量流」——deepseek 从哪个 harness 跑都是同一条按量流，钱行就是 Σ，估算并入主账的代价用**整段 `≈` 前缀**标注（`metered_amount` truth table 钉住：纯 DSH 段精确不带 ≈，任何估分量并入才整段 ≈，USD 只在整行无 ¥ 侧时浮出）。不假装全量，也不把估算冒充实付——`≈` 就是不充实的记号。

这把评审 P0-1 的「钱行是 DSH-only」钉正为：钱行按**供应商**（DeepSeek 按量）语义，标签用 `按量` 不按执行环境名，所以将来从 Claude Code 或其它 harness 接入同一供应商流也不换标签。

## 4. 菜单结构设计

现状 → 目标（**粗体 = 新增/改动**，`→` = 深链到工作台）：

```
现状（lib.rs:271-335，全平）          目标
──────────────────────              ──────────────────────────────
今日成本：¥12.34 · 1.4M tokens       今日按量成本：≈¥37.17 · 188.2M tokens        ← v1.3 合并总账（DSH 实测 + Claude deepseek 估 CNY 相加）
今日预算：¥24 / ¥30（93%）           今日按量预算：¥24 / ¥30（93%）             ← 预算只对 DSH，不动
本月成本：¥774.7 / ¥600              本月按量成本：≈¥106.1                      ← v1.3 合并；去掉 /¥600 分母
最近会话：deepseek-v4-flash · 15K     ─────────────────
    · ¥0.02  ⚡ 删除，被执行环境行吸收    ▸ DeepSeek Harness · 1.4M · 3 会话        ← L1 子菜单
                                    ▸ Codex · 20K · 1 会话
                                    ▸ Claude Code · 176.7M · 3 会话             ← 第三执行环境行
预算：✓ ¥12.79 / ¥600                ─────────────────
上次同步：09:50 成功                  预算：✓ ¥12.79 / ¥600                      ← 预算底部行 DSH-only
─────────────────                   上次同步：09:50 成功（DSH 折叠 + Claude 账）
打开工作台… / 立即同步 / 退出          ─────────────────
                                    打开工作台… / 立即同步 / 退出
```

（示例数值取 v1.3 真机那天：DSH 空转、钱全在 Claude Code 的 deepseek 流上 → 今日/本月
合并总账 = Claude catalog CNY 估占主导，`≈` 前缀标估；pure-DSH 的日子是精确形式
`今日按量成本：¥12.34 · 1.4M tokens` / `本月按量成本：¥774.7`，不带 ≈——一笔实测 ¥
不标成估。USD 套餐流只在整行完全没有 ¥ 侧时单独浮出 `≈$B`。分母移除见修订说明；
顶部今日/本月行 = Overview `claude_today/claude_month` 的 `currency_totals` + DSH
实测的合并，全部由 `money_rows_text` 纯函数拼出，单测钉逐行文案。）

L1 执行环境行展开后的 L2 子菜单（以 DSH 为例）：

```
▸ DeepSeek Harness · 1.4M · 3 会话        ← 点击展开
  09-01 · 修复 month.json 三倍重复计数 · 15K     ← 截断标题优先
  09-01 · 工作台时间线 spec · 4.5K
  08-31 · deepseek-v4-pro-0813 · 12K            ← 无标题 → 模型短名兜底
  ─────────────────
  数据更新于 08:32 · 可能已过期                  ← 仅 stale 时出现（§6 决策 5）
```

结构决策：

- **顶层钱行**：今日/本月/预算三行是**按量计费总成本**（§3.1），标签按计量语义（`今日按量成本`），不按执行环境名。v1.3 起今日/本月两行 = `money_rows_text` **合并总账**（DSH 实测 + Overview `claude_today/claude_month` 的 `currency_totals.CNY` 相加；估分量并入 → 整段 `≈`，USD 只在整行无 ¥ 侧时浮出 `≈$B`；**预算行不动、DSH-only**）。`上次同步` 行注明「（DSH 折叠 + Claude 账）」——它是 oneline 同步时间，与执行环境快照的 `generated_at`（§6 决策 5）是两个东西，不混（tick 叠 claude-sync 自 v1.2 起，失败时 SyncStatus 留痕，见顶部修订）。
- **预算/同步/今日/本月永远留在顶层，不藏进执行环境**——它们是主入口最该一眼看到的东西；harness 展开是增量信息，不是替代。
- **L1 行的顺序 = 固定执行环境序**（dsh → codex → claude-code），不是按 token 量排序——菜单每轮重建的排序要稳定。
- **执行环境区始终渲染三行**（固定序），不因单执行环境失败整体消失——失败走 §8 的逐执行环境降级文案。
- **「最近会话」平铺行删除**：它展示的是「最近一条 DSH 会话」，被 DSH 执行环境子菜单吸收。
- **L2 行格式 `<date> · <title 截断 | short_model | native_id> · <tokens>`**：身份字段、无成本列。**标题优先**（P1 修正：同 `<日期·模型·tokens>` 的多行用截断标题区分；无标题落 `short_model`，再无落 `native_id`，与 `titleText`（`workbench.js:565-571`）同一兜底链）。标题截断 ~24 字符。`date` = `MM-DD`（`date_last[5..10]`；非当年带年，见下）；`tokens_total` 用 `fmt_tokens`。点击身份 = `session_key`（L2 行显示文本撞车时点的是各自会话，显示文本只是尽力区分）。
- harness 显示名映射是**托盘侧展示**（dsh → `DeepSeek Harness`，codex → `Codex`，claude-code → `Claude Code`），与 `short_model` 同类，不是 core 规则。

**日期截断修正**：`date_span.last` 是 `YYYY-MM-DD`，`[0..8]` = `YYYY-MM-`（错）。`MM-DD` 取 `[5..10]`；`date_last` 年份 ≠ 当前年时显示完整 `YYYY-MM-DD`（老会话跨年，`MM-DD` 会误导）。

## 5. 数据契约

### 5.1 投影命令（单一真相源，Tauri 只缓存渲染）

```
agent-vitals sessions navigation --day 2026-09-01 --timezone Asia/Shanghai --recent 5 --json
```

- `--day`：北京日期，默认 `today_beijing()`（`src/agent/codex_cost.rs`）。
- `--timezone`：仅接受 `Asia/Shanghai`（校验；core 日界固定 UTC+8、无夏令时，`codex_usage.py:156-157`。未来真要支持别的时区是 core 改动，本命令不假装通用）。
- `--recent N`：每执行环境的最近 N，默认 5。
- 读：dsh store、codex store、claude store、today.json（DSH 今日 token）、claude-ledger（claude 今日 token）。store 构建失败/超时 → 对应执行环境 `unavailable`，不 abort 全命令。
- 输出 versioned envelope（stdout，`{"schema_version":1,…}`）：

```json
{
  "schema_version": 1,
  "day_key": "2026-09-01",
  "timezone": "Asia/Shanghai",
  "generated_at": "2026-09-01T02:31:00Z",
  "harnesses": [ /* 固定 dsh → codex → claude-code（v1.2） */ ]
}
```

### 5.2 HarnessNavigationSnapshot（每执行环境一个）

```json
{
  "harness_kind": "dsh",
  "status": "ready | partial | unavailable",
  "today_tokens": { "value": 1234567, "basis": "state-file", "coverage": "complete" },
  "today_sessions": 3,
  "recent": [ /* RecentRow × N */ ],
  "store_revision": "…"
}
```

**status**（数据可得性）：
- `unavailable`：store 构建失败 / 该执行环境无数据源 / 命令读到不可恢复错误。
- `ready`：`today_tokens.value` 非 null **且** `today_sessions` 非 null **且** recent 可算（0 条 = 真零，也是 ready）。
- `partial`：三者至少缺一（例如 recent 有但 `today_tokens` null）。

**today_tokens**（L1 token 数）：
- DSH：`value` = today.json 的 token 总量（`basis="state-file"`，与顶层钱行**同源**，一致性测试钉死）；today.json 缺失 → `value=null`、`basis=null`。`coverage` 恒 `complete`——state 折叠的覆盖率是 state 层自己的轴，日历已单独展示（`workbench.js:444-448`），菜单不重复读。
- Codex：`value` = 事件时间按北京日界折叠后的当日桶之和（`basis="events"`，复用 §2.3 链路：全部 codex 会话 → `codex_fold_file` → `codex_merge_folds` → `codex_aggregate_hours` → 取 `day_key` 日桶求和）。`coverage`：折叠 `unaccounted.tokens_seen > 0` → `partial`（当日数可能是下界），`== 0` → `complete`；`by_hour_model` 空（无任何 token 事件）→ `value=null`、`coverage=null`（读到了会话但没计量，诚实「测不出」）。
- Claude Code（v1.2）：`value` = claude-ledger 当日 flat 日 4 型 token 总和（`basis="ledger"`——`claude_ledger_day_tokens` 读 `state/claude-ledger.json`，ledger 由 `claude-sync` 维护，见 CLAUDE_CODE_INTEGRATION §9.3）。`coverage` 恒 `complete`（ledger 日桶没有逐日 unaccounted 哨兵，v1 fold 的残差是全局量）；当日缺席 / ledger 不存在 → `value=null`、`basis=null`、`coverage=null`（**今天没测到账**，诚实 null——与 codex 当日桶缺席同语义，不是 0）。当日存在但全零（只有全零 unknown 桶的病理日）→ `value=0`（「测到 0」不是「没测」）。`today_sessions`/`recent` 复用 r2a `SessionStore::claude_code`（第三源，§5 接入面）；claude 无数据源（fixture home 无 `~/.claude`）→ `unavailable`。
- store 可读且**零会话** → `value=0`（真零，`basis="events"`、`coverage="complete"`）——没有会话就没有 token，0 是诚实测量不是编造。

**today_sessions**：date_span 与 `[day_key, day_key]` 交叠（core `SessionFilter::matches` 同语义）的会话计数；无 date 的 degraded 会话不计入。**这是「今天碰过的会话」计数，不是 token 归属的判定**（跨日会话计 1 次是对的——它今天确实活跃；token 归属已由折叠解决）。

**recent**（L2）：**全量排序后取前 N**（§6 决策 2）：
- 排序键：`date_span.last DESC`（无日期 last）→ `session_revision DESC`（无 revision last）→ `SessionKey` 四元组 ASC（`sort_tuple`）。
- 比较器 `recent_cmp` 是 core 新增纯函数（`r2a.rs` ↔ `r2a.py` 锁步 + 差分 parity 测试）。

**RecentRow**：

```json
{
  "session_key": { "harness_kind": "…", "native_id": "…", "source_profile": null, "machine_namespace": null },
  "title": "…", "model": "…", "tokens_total": 12345,
  "date_first": "2026-08-28", "date_last": "2026-09-01", "revision": "…"
}
```

`session_key` 是 `SessionKey::to_json()` 的 4 字段对象（core `SessionKey` 不 derive Serialize，`r2a.rs:87-93`、`to_json` 112-119）——深链原样透传，`sessions_read` 期待同形状。`revision` 从 store envelope 读（list DTO 没有，导航命令补读）。

### 5.3 Tauri 侧

- `read_overview` 返回新增 `harnesses: [HarnessRow]`（`overview.rs` 组装），`HarnessRow` 是**展示结构**：`{harness_kind, display_name, today_tokens: Option<i64>, today_sessions: Option<u64>, status, stale, recent: [RecentSessionRow]}`，全部字段来自快照，**托盘不做任何排序/求和/日界换算**。
- 快照经 `state/harnesses.json` 持久化（镜像 `save_sync_status_at`，`overview.rs:112-118`）；启动读旧值 warm-start（§6 决策 5）。

## 6. 数据源缺口与实现决策

### 决策 1 —— L1 用 token + 会话数，不用钱
理由：币种分叉（§2.2）+ 用户示例本身就是 token。**钱保留在顶层，语义是「按量计费总成本」**（§3.1）：标签 `今日按量成本` 等，不按执行环境名。不做「今日成本：Codex ¥X」——Codex 是套餐（不计入按量账）+ 即便按量也需币种决策（v2）。

### 决策 2 —— 「最近 N」在数据层全量排序后分页，core 新增 `recent_cmp`
`sessions list` 排序是 SessionKey 四元组序（§2.2），不是时间序。**第一页 50 条页内取最近 ≠ 全局最近**（P1-3：真实 store 里按 key 序靠前的会话很可能不是最近的；排序错误发生在分页之前，展示层无法修复）。所以排序在**数据层**、在分页之前做：`sessions navigation` 读全量 summaries（+revision），按 `recent_cmp` 排完取前 N，**不分页**（导航命令直接 `--recent N`，没有 cursor）。

`recent_cmp`（core 纯函数，`r2a.rs` ↔ `r2a.py` 锁步）：
```
date_span.last DESC（None last）→ session_revision DESC（None last）→ SessionKey ASC（sort_tuple）
```
只有 10 行级别的比较器，进 core 是仓库「纯规则单一真相源」惯例，Python 镜像 + parity 测试钉住。**不改 `sessions list` 的既有排序/过滤语义**（§11）。

### 决策 3 —— 数据组装 = 单只读投影命令，Tauri 只缓存渲染
**不用四次 `sessions list` 拼菜单**（v1.0 决策 3/5/7 的「每执行环境 2 次窄查询 ×2 执行环境 = 4 spawn」整体作废）：排序、日界折叠、覆盖率、会话计数全部是数据层的测量，托盘拼不出来（`tokens_total` 整会话求和正是 P0-2 的错误根源）。新投影命令 `sessions navigation`（§5.1）一次 spawn 返回两执行环境快照。**Tauri 只缓存快照到 harnesses.json 并渲染，不重新解释测量数据**——这条同时满足「计算在 core、托盘不长第二份拷贝」（CLAUDE.md 写右边界）。

### 决策 4 —— 北京日界：token 按事件时间折叠，会话计数按 date_span 交叠
v1.0 用 `--from T --to T` date_span 交叠过滤求和 `tokens_total`，跨日会话整段算进今天——**指标错误**（P0-2），作废。

- **Codex 今日 token**：事件时间 → 北京日界折叠（`codex_hour_of` +8，§2.3 链路复用）。跨日会话的今日部分 = 今日事件桶之和，不是整会话总和。北京 0–8 点早间会话事件归入北京今日（UTC 昨天），折叠天然正确，**不再是已知近似**。
- **today_sessions**：date_span 交叠计数（§5.2）。这是独立的「今天活跃会话数」指标，跨日会话计 1 次。
- **诚实性**：value 可 null（测不出）+ coverage 可 partial（unaccounted 哨兵），绝不拿「0 token」冒充「没跑」。（unaccounted 是全时段残差——当日粒度不重算，coverage=partial 是保守下界标注，注释里写清。）

### 决策 5 —— 刷新执行模型（P1-5 定案）
- **启动**：读 harnesses.json（末次成功快照）立即建菜单，**不等 store 构建**。harnesses.json 缺场 → 三执行环境 unavailable 行（§8）。
- **单飞（single-flight）**：`refresh_harnesses()` 同步跑在 `sync_tick` 内、`SyncLock` 之下（`lib.rs:475-479`）。`sync_now` 与 tick 线程都要先拿锁 → **不可能并发刷新**。generation 由「同步单写」保证：慢的旧刷新不可能覆盖新结果，因为同一时刻只有一个刷新在跑。注释里写清这条不变量。
- **超时 + kill**：`sessions navigation` 用 `Command::spawn()` + `try_wait()` 轮询（每 50ms），**20s 硬上限**，超时 `child.kill()` + `wait()`。冷 store 首建 30+ 秒 → 首轮可能超时 → 执行环境区 degraded，下一轮 tick（5 分钟后）重试。
- **保留末次成功快照标 stale**：刷新失败**不覆盖** harnesses.json（数据不丢）；托盘按 `generated_at` 年龄判定 stale：`now - generated_at > 2 × tick 周期`（10 分钟）→ 执行环境子菜单底部加禁用项 `数据更新于 hh:mm · 可能已过期`。L1 保留末次成功数值。
- **执行环境更新时间与 DSH 上次同步分开**：`上次同步` 行只指 DSH oneline（`lib.rs:224-248`）；执行环境数据的新鲜度由 harnesses.json 的 `generated_at` + stale 标记表达（§4）。两个时间轴不混。
- **工作台 IPC 的超时缺口**：`store.rs:108` 的 `Command::output()` 无超时是**故意的**（冷 build 30s+ 合法 + 前端有 loading banner，`workbench.js:489-495`）。菜单刷新的 20s 超时是**另一条路径**，不共用；store.rs 保持现状，不加超时（加了会打断工作台冷启动）。

### 决策 6 —— L2 行无成本列
`cost_usd` 对 DSH 恒 None、Codex 是 USD（§2.2）——L2 若带钱，同一列两种币种且一半是空。L2 是跳转清单，身份字段（日期/标题/模型/token 量）足够识别；成本在详情页。

## 7. 深链：工作台 focus_session

### 7.1 强类型目标（P1-4）

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum WorkbenchTarget {
    SessionList { harness_kind: Option<String> },   // 打开会话 tab，按 harness 过滤（None = 全部）
    SessionDetail { session_key: SessionKeyJson },
}

#[derive(Serialize, Deserialize)]
struct SessionKeyJson {
    harness_kind: String,
    native_id: String,
    source_profile: String,
    machine_namespace: String,
}
```

`SessionKeyJson` 是 core `SessionKey::to_json()` 的 4 字段镜像（serde 强类型，不再用裸 `Value`）；前端把同一对象回传 `sessions_read`（`store.rs:152-167` 已期待该形状）。v1 菜单只发射 `SessionDetail`（L2 行）；`SessionList` 变体存在以表达「打开列表按 harness 过滤」，等「查看全部会话」回归时发射。

**两处与早版代码块字面的差异（2026-09-01 落地时定案，prose/字节契约压过字面）**：
- `SessionKeyJson` 不加 `rename_all = "camelCase"`——`to_json()` 发 snake_case 键，`sessions read` 的 `SessionKey::from_json` 只认 4 个 snake_case 键；camelCase 会让回传打到解析不了的对象（not-found）。
- 字段用非 Option `String`——`to_json()` 恒发 4 个 string，Option 会让 null 反序列化通过、序列化回 null，回传时 `from_json` 失败。类型自己堵死这条路，比运行时检查诚实。

### 7.2 IPC 与事件（双通路）

- `focus_session(target: WorkbenchTarget)`：覆盖式存入 `Mutex<Option<WorkbenchTarget>>`，`AppHandle::emit_all("focus-target", ())` 推事件，`show_workbench`（`lib.rs:511-515`）。
- `peek_focus_target() -> Option<WorkbenchTarget>`：**非破坏性**读（持久 pending target——窗口未建/未可见时菜单点击的目标保留到工作台下次消费）。
- `clear_focus_target()`：工作台**成功应用后**调用清除（P1-4 的「成功后再清除」；应用失败也 clear——错误横幅已向用户说明，不无限重试，菜单再点会覆盖新目标）。
- 工作台侧：监听 `focus-target` 事件（**push**）+ 在 init / window focus / `visibilitychange`(visible) 时 pull `peek_focus_target`（**pull**，兜底窗口未建/事件丢的竞态）。双通路 = 事件通知（工作台已可见时菜单一戳就跳）+ 持久目标（还没建好/不可见时下次可见命中）。拿到 `SessionDetail` → `switchTab("sessions")` + `showSession(最小对象)`（复用 `openSessionFromFinding` 范式，`workbench.js:1254-1265`；`showSession` 对缺字段逐个判空，`:594-600`）。拿到 `SessionList` → 切 tab + 设 harness 过滤 + 重置分页 + 重新加载。
- 不依赖 Tauri `emit` 时机的可靠性——事件只是通知，目标是持久状态，pull 是最终仲裁。

### 7.3 前端 harness 过滤（P1-4）

工作台会话 tab 加过滤状态 `sessFilter: "all" | "dsh" | "codex"` + 一行 filter chips（全部 / DeepSeek Harness / Codex）：`loadSessions` 把 `harness_kind`（非 all 时）传给 `sessions_list` IPC（参数已存在，`store.rs:129`），过滤变化时重置分页。行已显示 `harness_kind` 列（`:540`）。这是增强既有 tab，不是新 UI。

## 8. 诚实降级规则

每执行环境一行，按快照 status + 托盘侧 stale 渲染：

| 场景 | 执行环境行 L1 | 子菜单 L2 |
|---|---|---|
| 二进制缺失 / 命令 spawn 失败 | `DeepSeek Harness · —` | 「会话数据暂不可用」（禁用项） |
| status = `unavailable`（store 构建失败/无数据源） | `DeepSeek Harness · —` | 「会话数据暂不可用」（禁用项） |
| status = `ready`，零会话（真零） | `DeepSeek Harness · 0 · 0 会话` | 「尚无会话」（禁用项） |
| status = `ready`，有数据 | `DeepSeek Harness · 1.4M · 3 会话` | N 行跳转 |
| status = `partial` | 现有字段渲染，缺失段「—」 | 有则渲染，缺则「—」 |
| `today_tokens.coverage = partial` | token 数加 `≈` 前缀（`≈15K`） | — |
| stale（托盘派生，§6 决策 5） | 保持末次成功数值 | 底部禁用项 `数据更新于 hh:mm · 可能已过期` |

铁律：**缺数据显示「—」/诚实描述，不摆 0 冒充**（CLAUDE.md 空态诚实）；「没有会话」与「读不了会话」是两个不同的字。执行环境区失败不得影响顶层今日/预算/同步行——主入口永不因增量信息崩。执行环境区**始终渲染**固定 dsh→codex→claude-code 三行（v1.0 的「执行环境区整体失败不渲染」删除，与「Codex · —」矛盾由此解除）。

## 9. 测试计划

### 9.1 导航投影命令（core + 二进制侧）

1. **P0-2 跨日会话回归**：单个 Codex 会话跨越 `2026-08-31..2026-09-01`，两天都有 token 事件；`--day 2026-09-01` 的 `today_tokens` = **只含 09-01 事件**的折叠值，不是整会话 `tokens_total`。
2. **P1-3 全局 recent**：60 个会话，按 key 序最前的 50 个**不是**时间上最近的；`--recent 5` 返回按 `date_cmp` 的全局最近 5，序正确。`recent_cmp` 注入乱序 items 钉住输出。
3. **status 矩阵**：store 可读空 → `ready` + `today_tokens=0`（真零）；store 可读有会话无 token 事件 → `partial` + `today_tokens=null`；store 构建失败 → `unavailable`。
4. **coverage**：折叠 `unaccounted > 0` → `coverage=partial`；`== 0` → `complete`。
5. **DSH today_tokens**：与 today.json 同源（构造冲突输入，快照报 today.json 值）。
6. **锁步**：`recent_cmp` Py↔Rust parity；`codex-fold`/`codex-cost` 既有 golden **零更新**（复用同一折叠，无新测量）。

### 9.2 托盘侧（`lib.rs`/`overview.rs` `#[cfg(test)]` 注入 now）

7. **菜单结构**：三执行环境行、固定 dsh→codex→claude-code 序、L2 行数、删除「最近会话」平铺行、顶层钱行按计量语义标签（`今日按量成本`，不按执行环境名；v1.3 起 assert 合并总账 `metered_amount` 的 11 态 truth table——纯 DSH 精确 / 估并入整段 ≈ / 无 ¥ 侧 USD 浮出 / 双无 → 诚实 —，`metered_amount_truth_table` + `money_rows_merge_dsh_and_claude_never_say_no_data_when_metered` 钉今日/本月整行文案）。
8. **DSH 一致性**：构造 `ov.today` 与 harnesses 冲突的输入，菜单报 today.json 值。
9. **降级矩阵**：§8 每行一测（文案逐字）——unavailable/零会话/partial/stale 各一条。
10. **stale**：`generated_at` 超过 2×tick → 子菜单出现过期 footer；刷新失败不覆盖 harnesses.json。
11. **深链**：`peek_focus_target` 连续读两次返回同一目标（持久）；`clear` 后 None；`focus_session` 覆盖旧目标；`WorkbenchTarget` serde round-trip（camelCase tag）。
12. **动态菜单 ID 映射**：`harness:{kind}` / `session:{kind}:{i}` → `on_menu_event` → 正确 `WorkbenchTarget`（含 stale footer 的禁用项不可点）。

### 9.3 端到端（手动 + 可选集成）

13. 菜单点 L2 行 → 工作台打开该会话详情（`focus_session` → 事件/可见性 → `peek`/`clear` 只消费一次）。
14. 菜单点开后工作台未建 → 建好首次可见时命中同一目标。
15. **无需 golden 更新**：不加价表、不改既有规则——差分守卫与 golden 都不受影响（改完 `cargo test` 全绿 + Python 套件全绿，零 `--update`；唯一新增的 core 规则是 `recent_cmp`，它带自己的 parity 测试，不碰任何既有 golden）。

## 10. 分阶段实施

### Phase 1 —— 投影命令 + L1 执行环境行 + 钱行改名
core `recent_cmp`（+Python 镜像）；二进制 `sessions navigation`（复用 codex 折叠链路）；`overview.rs` HarnessRow + harnesses.json 读写；`lib.rs` 菜单执行环境区 + Submenu + 顶层钱行改按量标签 + 刷新模型（单飞/超时/stale）。验收：三执行环境行出现、DSH 与顶层今日行一致、Codex 今日 token 与整会话求和不一致时可复现（跨日会话）、降级矩阵通过。（Phase 1/2 已落地；第三执行环境行随 r2a/成本数据面并入，顶层钱行按 v1.3 合并总账修订，见顶部修订。）

### Phase 2 —— L2 最近 N + 深链 + 前端 harness 过滤
`WorkbenchTarget` IPC（focus/peek/clear + 事件）；工作台双通路消费 + harness 过滤；L2 渲染前 5 行。验收：菜单点 L2 → 工作台打开该会话；peek/clear 语义测试过；harness 过滤工作。

### Phase 3（v2，另立项）—— per-harness 成本
Codex 北京日界折叠**已在 v1 落地**（不再是 Phase 3）。Phase 3 只余：per-harness 成本展示（需先定币种决策：Codex 按 CNY 价表定价 vs 菜单区分币种 vs 保持 token-only）。live 指示**明确不做**（§11），从本阶段移除（v1.0 的「Phase 3 评估 live」矛盾由此解除）。

## 11. Out of scope（明确不做）

- **live「正在运行」指示**（§2.4-6，需要 autosync 式检测，已删）。
- **per-harness 今日/本月成本**（Phase 3，需币种决策；v1.3 只把 Claude Code 的 deepseek 按量流并进顶层**合并**总账 ≈ 行——不是每执行环境一行钱，预算/alert 仍 DSH-only，不做完整 per-harness 成本行）。
- **reset 倒计时**（provider 额度窗口语义，我们审计本地成本无额度窗口）。
- **菜单内分页/搜索/过滤**（那是工作台会话 tab 的职责）。
- **多图标模式**（保持单图标 + 菜单内分层，§1 结论 1）。
- **改 `sessions list` 的既有排序/过滤语义**（`recent_cmp` 只服务导航投影，list 契约不动）。
- **工作台 session DTO 字段扩展**（L2 身份字段已够用；`revision` 是导航命令内部从 store envelope 补读，不进 list DTO）。
- **给 `store.rs` 的 `Command::output()` 加超时**（工作台冷 build 30s+ 合法，`workbench.js:489-495` 有 loading banner；菜单刷新有自己的 20s 超时路径）。

## 12. 与既有文档的关系

- `MENUBAR_MIGRATION.md` §11：本文把「多 harness / 跨执行环境菜单栏聚合」从 out-of-scope 挪进范围；§11 其余 out-of-scope 项不变。
- `R2A_CONTRACT_DESIGN.md`：会话 store 契约，本文只读消费 + 新增只读投影命令 `sessions navigation`，不改既有命令契约。
- `UNIFIED_COST_VIEW.md`：Codex 北京日界折叠复用其「统一多桶折叠契约」（小时桶 + +8 归日），不加第四份拷贝。
- `TAURI_RUNTIME_WORKBENCH_SPEC.md`：工作台窗口语义（hide-not-destroy、tab 状态保留），§7 深链必须与之兼容。
- `PRODUCT.md` 菜单栏章节：落地后在产品文档同步更新（双语，CLAUDE.md 编辑惯例）。

## 附：本文核实的事实清单（2026-09-01，评审修订后）

- 托盘菜单全平、单执行环境：`src-tauri/src/lib.rs:271-335`；tick DSH-only `lib.rs:485-495`；`today_title` `lib.rs:162-171`；`short_model` `lib.rs:176-178`。
- `sessions list` IPC 薄壳：`src-tauri/src/store.rs:128-149`；**`Command::output()` 无超时 `store.rs:108-110`**（工作台路径，故意保留，§6 决策 5）。
- harness_kind 两值：`src/agent/r2a_store.rs:267`（summary 分发）、`:984`（list 分发）。
- list 项字段：`r2a_store.rs:142-151`（Summary）；DSH `cost_usd` 恒 None：`:202-203`。
- 排序非时间序：`crates/agent-vitals-core/src/contracts/r2a.rs:22`、`:149-152`（四元组序）。
- 日期过滤交叠语义：`r2a.rs:201-216`；degraded 会话在有日期过滤时被排除：`r2a.rs:188-189`。
- **Codex 北京日界折叠已存在**：`codex_usage.py:173-203`（`codex_hour_of` +8 北京小时桶）、`:255-350`（`codex_fold_file` + unaccounted 哨兵）、`:353-438`（merge）、`:441-464`（聚合日期桶）、`:467-497`（按前缀过滤）；Rust 镜像 `crates/agent-vitals-core/src/adapters/harnesses/codex/sessions/usage.rs`；命令链路 `main.rs:1278-1348`（codex-cost）。
- 工作台会话 tab：`src-tauri/ui/workbench.js:480-514`（`loadSessions` 只传 pageSize，**无 harness 过滤**）、`:540`（行已显示 harness_kind）、`:565-571`（titleText：title → native_id 兜底）、`:573-586`（showSession：最小对象可开详情）、`:489-495`（冷 cache 几十秒 + loading banner）。
- 托盘无 Submenu 先例、无 harness 显示名映射。
- CodexBar（steipete/CodexBar）：Swift 原生、每 provider 一图标 + popover tiles（用量条/reset 倒计时）、**Merge 模式单图标 + 多 provider overview rows + provider 详情跳转**、会话/成本历史在持久化 Settings → Usage & Spend 视图、popover 不列会话。
