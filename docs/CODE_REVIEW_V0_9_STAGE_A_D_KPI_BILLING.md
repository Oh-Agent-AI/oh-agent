# 代码审查：v0.9 Stage A–D KPI/计费模型重构（2026-09-05）

- **范围**：`c7d0e06`（Stage A billing_modes 判定层）→ `f004756`（Stage B by_provider
  分流）→ `68ca4eb`（Stage C FixedSubscription 写入方）→ `6586112`（Stage D 总览
  KPI 行/双轨账/决策卡）→ `2a9603c`（KPI 行日键复用 beijingToday）。审查请求名
  「kpi-billing-model-refactor」，仓库无同名分支，按语义定位到以上五笔。
- **方法**：全量 diff 精读 + 数据形状逐层对账（fold 的 plan 形状、`merge_month_body`
  /`BUCKET_FIELDS` 决定的 month.json day 形状、DTO 序列化键 vs 前端读取键、HTML
  tile id 清单）。每条 finding 都追到真实数据形状才定性。
- **gate 实测**：`cargo test -p agent-vitals-runtime -p agent-vitals-domain` exit 0；
  `verify-workbench-kpi-decide.mjs` 全过——但注意它的 quota stub 把 finding #1 的
  错误形状测了进去（见 #1/#9），全绿不等于对。pricing lockstep 3/3 + 字节一致。
- **审查期间工作树被并行开发推进**（新增未提交的 `calendar_month` Token 日历 +
  `lib.rs` 测试）。涉及未提交代码的 finding（#5、#4 后半）标注为「未提交」，
  建议落定前先修。

共 **10 条 CONFIRMED**，按严重度排序。

---

## #1（最高）决策卡 Codex 窗口条整条功能失效——`quota.primary` vs `quota.limits.primary`

- **位置**：`apps/desktop/src-tauri/ui/workbench.js:660-663`；
  根因三处同源：`crates/agent-vitals-runtime/src/summary.rs:714`（`codex_quota_snapshot`
  的 doc 注释写错返回形状）、`scripts/verify-workbench-kpi-decide.mjs:124,131`（stub
  按错误形状构造）。
- **事实**：fold 的真实形状（`agent-vitals-harnesses/src/harnesses/codex/sessions/usage.rs::
  plan_from_rate_limits` :202-233）把 `primary`/`secondary` 收在 **`limits` 之下**：
  `{plan_type, has_credits, limits: {primary: {used_percent, window_minutes, resets_at}},
  observed_at}`。`data_codex_quota` 原样返回该 plan。前端 `quota.primary.used_percent`
  → undefined → 恒走「无订阅窗口数据」分支。
- **后果**：不只是窗口条不渲染——四态建议状态机依赖 `codexState`，它恒 null，
  建议行**永远停留在「等待窗口数据（Codex 快照不可得）」**，`<15%` 即将限流预警
  永远无法触发。决策卡的招牌功能（Codex 唯一正向余量源）在真机上是死的，而
  verify 全绿——stub 与渲染器互相印证了同一个错误期望（本仓库反复警示的
  「fixture 镜像实现 bug」）。`codex_quota_snapshot` 的 doc 注释（`{"plan_type",
  "primary": …}`）大概率是前端作者被误导的源头。
- **修法**：① 前端改读 `quota.limits.primary`；② 改 doc 注释；③ **stub 改成从
  fold 真实形状构造**（理想：形状来源钉一个共享 fixture，前端验证与 Rust 单测
  都引用它，不再手写形状）。

## #2（高）「今日 tokens」的 DSH 贡献结构性恒零——单日对象被当 days-map 迭代

- **位置**：`crates/agent-vitals-runtime/src/summary.rs:975`（`daily_summary` 传入
  `day_value`）；`dsh_tokens` 定义 :619-641；月度调用 :914。
- **事实**：日度路径把**单个 day 对象**（键 = `uncached_input_tokens`/`by_model`
  等字段名）传进按 `{date: day}` map 设计的 `dsh_tokens`，其
  `date.starts_with(window)` 过滤对字段名键**永假** → 整天被跳过 → 恒返回
  `HarnessTokens::default()`（全零 + `cache_hit_ratio: None`）。
- **后果**：KPI「今日 tokens」tile 静默漏掉 DSH 贡献；DSH-only 的日子显示
  「无数据」而实际有真实用量——正是 spec §0.1 / MeasuredZero≠Unavailable 纪律
  禁止的假零。`dsh_tokens` **无任何测试覆盖**（全文件仅定义 + 两处调用）。
- **对早前中断的审查代理结论的修正**：其遗留结论「月度路径也读错层（day 是
  `{"by_model": …}`）」**需要收窄**——正常管线的 day 顶层确实有
  `merge_buckets(…, "date")` 折叠出的 8 个 `BUCKET_FIELDS`（`domain/state.rs`），
  月度路径（键是日期、读顶层桶）在真机数据上**大多能读对**；只有「`by_model`
  有量、顶层零桶」的变形日（跨零点切片等，恰是 `summary.rs` 自家测试 fixture
  :1295 手写的形状）会静默漏计。每必现的是**日度**路径。
- **修法**：拆出 `dsh_day_tokens(day: &Value) -> HarnessTokens`（顶层桶为权威、
  `by_model` 逐模型累加作回退，镜像 `priced_day` 的双形状处理），月度逐日调用、
  日度直接调用；补一个从真实形状 month.json 到 `tokens_by_harness` 非零的端到端
  单测。

## #3（高）单位 tile 的跨币披露是死代码——混币相加标 "$/M" 无任何说明

- **位置**：`apps/desktop/src-tauri/ui/workbench.js:564-570`。
- **事实**：`set("unit", …)` 先把「跨币暂未折算：按 USD 桶计（见月度带副行）」
  写进 `ov-*-unit-sub`，**下一语句** :569 立即用 `"实际 …/M"` 覆写同一元素。
  唯一披露混币口径的文案永远不会显示；主行是把 USD+CNY 名义相加后标 USD
  符号的数字。
- **修法**：副行两段并写（`"跨币未折算 · 实际 …/M"`），或主行去掉 USD 符号
  改口径标签。

## #4（高）`data_codex_quota` 漏 USERPROFILE 回落，注释却声称与 `codex_home` 同源

- **位置**：`apps/desktop/src-tauri/src/lib.rs:1236`（已提交）；**:1245
  `read_calendar_month`（未提交）复制了同一模式**。
- **事实**：注释写「与 runtime summary.rs::codex_home 同一条 HOME → USERPROFILE
  优先序」，代码却是 `std::env::var("HOME").unwrap_or_default()`——没有
  USERPROFILE 回落（runtime 侧 :105-111 是 `HOME → USERPROFILE → 空串`）。
- **后果**：Windows 桌面端 HOME 通常未设 → home 为空 → rollout 枚举为空 →
  quota 恒 null（静默假 Unavailable）。
- **修法**：两处改用与 `codex_home` 同一条解析（抽公共 helper 或复用 runtime
  导出）。

## #5（高，未提交代码）`calendar_month` 复制了同一错层读取模式

- **位置**：`crates/agent-vitals-runtime/src/summary.rs:782`（工作树未提交 diff）。
- **事实**：Token 日历的 DSH 分支同样在 day 顶层 `day.get(k)` 读四桶——
  `by_model`-only 的日子静默计 0；而**同一循环**里的 `priced_day`（:786）经
  `by_model` 给这一天记了真实金额——同一天「钱非零、token 为零」。与 #2 同修：
  抽出的 `dsh_day_tokens` 两处共用。
- **建议**：趁代码未提交、形状未扩散，先修成本最低。

## #6（中）决策卡每次渲染全量重 fold 全部 codex rollout

- **位置**：`summary.rs:718`（`codex_quota_snapshot`）；调用点 `workbench.js:655`。
- **事实**：每次 `renderOverview`（刷新/同步事件/手动同步后重拉）→ invoke →
  枚举 + fold 约 60 份 rollout。提交信息自己把「同一次渲染重复 invoke
  data_monthly_summary」列为可感知卡顿并修掉了，这条同类。
- **修法**：plan 只在出现更新的 rate_limits 事件时才变——月/日 summary 组装时
  顺手算出并缓存，或 Tauri 侧做会话级 memo。

## #7（低）账期字节切片可 panic

- **位置**：`summary.rs:674`（`apply_subscription_fees`）。
- **事实**：`&start[..7]` 在非字符边界 panic（`billing_period_start`/`reported_at`
  混入非 ASCII 时）。数据源是自家价表，概率低，但 billing.rs 对脏声明的既定
  处理是显式可见（mode 脏值 → Unknown）而非 panic。改 `chars().take(7)` 即可。

## #8（低）`ProviderAcc::add` 币种冲突后可被重新认领

- **位置**：`summary.rs:413` 起。
- **事实**：冲突置 `currency=None` 后，后续同币种 `add` 走 `None =>` 分支重新
  认领；跨 basis 双币（如 ApiEquivalent=USD + MeteredEstimate=CNY）不会触发
  `finish` 的 `multi_currency` 清空 → 条目带单一 currency 收尾，`total_actual_spend`
  会把另一币金额按该币桶进。当前价表每 provider 单币 + unresolved 标志仍亮，
  属理论形状，但与注释「绝不冒充单币」意图不符——冲突后应冻结 `currency=None`。

## #9（低）verify 脚本恒真断言 + stub 形状错误

- **位置**：`scripts/verify-workbench-kpi-decide.mjs:33`（恒真：
  `X === false || X`）、`:124,131`（quota stub 形状 = #1 的错误期望）。
- **修法**：删/改 ：33 为行为断言；#1 修复时一并把 stub 改成 fold 真实形状，
  否则守卫继续给假绿。

## #10（nit）改名记录注释写反旧函数名

- **位置**：`crates/agent-vitals-domain/src/domain/cost/mod.rs:205`。
- **事实**：「原 `cache_counterfactual_cost`」应为「原 `nominal_vs_actual_cost`」
  （:210 的「它本来就叫这个」试图圆但读反）；Python 侧 `cost.py` 的记录是对的。
  追考古时会把人引向不存在的旧名。

---

## 值得肯定

- **billing.rs 判定层**（Stage A）：`Unknown` 显式存在不默认、声明序即优先级有
  `billing_route_specific_declaration_wins_over_generic` 钉住、`preserve_order`
  在 domain/harnesses/cli 三处显式开启（「先专后泛」契约的承重墙）、「名义三件套
  砍掉防第二份计价规则」的审阅修正方向正确。
- **Stage C 摊费纪律**：零用量月份照摊（订阅费不付用量也在付）、账期过滤
  （GLM 9-05 前不摊）、只进月不进日，三条都写进了注释和测试。
- **`total_actual_spend` 零金额不撑币桶**：与 negative-zero 教训同源的对称面。
- **nominal 让位改名**：Rust/Python 两侧 lockstep 干净，语义记录完整（#10 只是
  注释笔误）。
- **月度带四 tile 是有意的**（HTML 注释「同构四 tile」）；`renderKpiRow("m")`
  对缺失 `ov-m-cache` 的静默 no-op 是渲染器容差，不属缺陷。

## 共同根因与防再犯

#1、#2、#5 是同一模式的三个面：**渲染器/适配器与数据真实形状之间没有共享的
形状来源**——fold 的 plan 形状、month.json day 的合成形状都只存在于 Rust 侧
注释与折叠代码里，前端与 verify stub 各自手写期望，错了互相印证。建议：

1. 形状来源 fixture 化：fold plan、month.json day 各钉一个最小 fixture 文件，
   Rust 单测与 `.mjs` 验证都从它读（前端验证已有「node+vm 执行真实文件」的
   好底子，缺的是**输入**也真实）。
2. `dsh_tokens`/`dsh_day_tokens` 补从真实形状 month.json 到 `tokens_by_harness`
   非零的端到端断言（本次两条头部 bug 都是「生产者零测试、消费者合成 DTO
   测试」的夹缝产物）。
3. `.mjs` 的 stub 一律注明形状出处（函数/行号），形状变更时同一 PR 必须同改。
