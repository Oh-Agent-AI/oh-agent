# WorkBuddy 接入规格（Phase A–D）

> 撰写 2026-09-10。真机语料实测基线见 §2（本次重测，非引用旧数字）。
> **状态（2026-09-10）：Phase A 全部收口（A1–A6 见 §10，均已 commit 且门禁通过）。**
> §3 的三条实测缺陷——`cost.cny` 把积分当人民币、`date_span` 真机恒 null、fixture
> 是纸面 schema——**均已修复**；`cost` 块现为 §6.1 的 6 键形状。Phase B/C/D 仍是
> 决策门（§7.4 建议路径 2，即不做；§9 明确不做）。
> 关联：[WORKBUDDY_INTEGRATION.md](./WORKBUDDY_INTEGRATION.md)（2026-09-02 调研 +
> 会话行为适配器，**已落地**）· [ATTRIBUTABLE_WASTE.md](./ATTRIBUTABLE_WASTE.md)
> §6/§6.6/§6.7（成本词表与名义口径）· [AGENT_VITALS_V0_9_DATA_VALUE_ARCHITECTURE_SPEC.md](./AGENT_VITALS_V0_9_DATA_VALUE_ARCHITECTURE_SPEC.md)
> （数据面本体）· [PROVIDER_ROUTE_ATTRIBUTION_SPEC.md](./PROVIDER_ROUTE_ATTRIBUTION_SPEC.md)
> §6.4 · memory `workbuddy-data-facts`（真机词表与积分口径的权威记录）。
>
> **与 WORKBUDDY_INTEGRATION.md 的分工**：那篇管「WorkBuddy 的一次会话怎么变成
> CanonicalSession + SV601–614 findings」，已实现并被六条差分钉住。本篇管**它之后
> 的三件事**——已落地部分的口径纠错、会话面接进统一查询、金额面归属到哪一栏。
> 本篇**勘误**那篇的 §9 与 §2.1（见 §6.3）。

## 修订记录

**v2（2026-09-10 当日修订）——两处结构性错误，均为初稿写错、经代码核实推翻：**

1. **初稿 §6 把 Phase B 写成「新增 `SessionStore::workbuddy` + 翻 `session_store`
   声明」，全部作废。** `r2a_store.rs` 自 v0.9.1 PR #4 起标记 DEPRECATED、整文件
   behind `legacy-r2a` feature gate、计划 v0.9.3 由 PR #5 删除，删除清单**逐字包含**
   「删 `harness_runtime_registration.rs::session_store` 字段」。初稿是在一个正在被
   删除的模块上加执行环境、翻一个正在被删除的字段。正确形状见新 §7。
2. **初稿 §4.2 第 1 条「禁止 credit 折算进任何汇总面」过严。** `ATTRIBUTABLE_WASTE.md`
   §6.7 原文：「名义是度量衡（厘米可换英寸），实际是账（美元不能当人民币加进账本）」
   ——名义栏**允许**按显式声明、带日期的汇率折算。禁止的只是折算结果进**实付栏与
   预算分子**。正确形状见新 §5。

初稿另有两处小错一并修正：CLI 子命令是 `data-harness-bill`（连字符）不是 `data harness-bill`；
`sessions list --harness-kind` 早已是自由字符串，不存在需要放开的词表。

**v3（2026-09-11）——一处编造的分类、一处特例化设计，均经真机/代码推翻：**

3. **v2 §2/§5.1 把零积分会话统称「自配轨」，是编的。** `hy3` 是平台内置模型、根本
   没有自配路由可走，却有 2 个零积分会话——用户给出真相：**平台推广自家模型的限免**。
   零积分至少三种成因且不可分辨。改为**两态 + 成因归用户声明**（新 §2.1）。
4. **v2 把 WorkBuddy 的配额当特例设计。** 用户指出 Codex/Claude/WorkBuddy 是同一形状
   （内部配额 + 第三方通道），代码核实成立——`plan_from_rate_limits` 产出的 Codex 配额
   快照里**本来就有 `has_credits`**。改为「补既有抽象的第三个实例」（新 §5.0），
   Phase C 相应收缩到两条结构性项（新 §8.0）。

v3 另新增：赠送积分**不产生** `harness_bills` 行的语义澄清（§5.1.1）· 限免属名义栏且
名义价值不为零（§5.1.2）· §6.7 倍数护栏对合法免费额度的**跨执行环境假阳性**（§5.3.1，
应迁出本篇）· 抗拟核判据与证伪测试（§11 规则 16）。

**v4（2026-09-11，Phase E 分析步）——traces 的 span 面实测推翻本篇的 token 前提：**

5. **「无逐请求 token、不可拆四桶」不成立。** generation span 的 `toolOutput`（二次
   JSON 编码的字符串，解一层）里 3,865/3,947 带 OpenAI 格式 `usage`（prompt / cached /
   completion / reasoning）+ **逐调用 `model`**。§9 Phase D、§7.2 路径 1「四桶全 0」、
   §5.2 分母、§6.1 `cost.tokens` 语义、ASK P1-1 全部要改——见 §9E.2 清单。
6. **`session_usage.used` 不是 processed tokens**——它是**会话最后一次 generation
   调用的 `prompt_tokens`**（16/21 逐字相等，即最后一次调用时的上下文占用），一个
   快照不是累计。本篇此前所有「2.07M token」都是错的量纲。归属会话的真实 processed
   ≈ **176.9M**。（初稿写「定义未知」，验收者多试一种组合就对上了——规则 17 第 (c) 条
   的活例：对账没做够就不能写「未知」。）
7. **B2 的「`Agent workflow` = 另一类、0 token」错了一半**：`trace.totalTokens` 字段
   不可靠（302/675 为 0 但 span 有 usage）；`Agent workflow` 是 name 不是类——有
   sessionId 的 trace 也叫这个名。唯一分类器是 `sessionId` 有无。

**同一根因第三次出现**：09-02 的分析既没读 `trace.sessionId`，也没解 `toolInput`/
`toolOutput` 的二次编码，也信了 `trace.totalTokens`。教训写进 §11 规则 17。

## 0. 结论

1. **WorkBuddy 已接了一半**：静态 skill 体检 + 会话行为审计已落地；v0.9 数据面是
   刻意的「声明但排除」（用户 2026-09-05 决定，`fixtures/v09/workbuddy/EXCLUDED.md`）。
2. **已落地的那一半曾报错误的数字**（§3 三条实测缺陷）：`cost.cny` 把积分当人民币
   （约 20× 高估）、`date_span` 真机恒 null、fixture 是纸面 schema。**与接不接数据面
   无关，是既有代码的 bug**，Phase A 独立修——**三条均已在 Phase A（A1–A6）修复并
   commit**（详见 §10）。
3. **「会话面」与「事实面」在当前架构下不可分**（§7.1 的 SQL 证据）：统一
   `sessions list` 是对 `usage_facts` 的 GROUP BY，一个会话出现在统一面**当且仅当**
   它有至少一条带时间戳的非聚合 UsageFact。所以「先接会话、再谈成本」的分层没有落点。
4. **成本能统一，统一在名义栏**（§5）：WorkBuddy 的积分按公开兑换价折算 ¥215.39，
   单位名义成本 **¥194.2/M tokens**（积分轨分母），可与 Codex/Claude/DSH 横比。
   实付栏它贡献 0（积分为套餐赠送）；若用户在付 WorkBuddy/CodeBuddy 月费，那笔才是
   它的真实现金成本，走 `fixed_subscription` 手工录入，与积分数无关。
5. **发 UsageFact ≠ 编造 token 桶**（§7.2 vs §9）：为进统一会话面而发四桶全 0 的
   逐请求事实是诚实的（表达"此执行环境不报分桶"）；把会话级聚合 `used` 拆进四桶冒充
   token 计量是编造，明确不做。

## 1. 现状清单（代码核实 2026-09-10）

| 面 | 状态 | 落点 |
|---|---|---|
| 静态 skill 扫描 | ✅ | `harnesses/workbuddy/sources/skills.rs` · `golden/harness-workbuddy.json` |
| 会话证据（CanonicalSession） | ✅ | `harnesses/workbuddy/sessions/evidence.rs` |
| 会话 I/O + CLI `workbuddy-session` | ✅ | `harnesses/workbuddy/sources/mod.rs` · Python 镜像 · 六条差分 |
| capability 声明面 | ✅ | `harness_capability::HARNESSES` 有 workbuddy 行（`session_store: false, fold: None`） |
| 统一 `sessions list/read` | ❌ | 走 SQL（`mcp::sessions_search` / `session_detail`）；库里无 workbuddy 行 |
| facts → SQL 权威库 | ❌ 刻意排除 | `ingest_service::FACT_HARNESSES` 三执行环境封闭词表 |
| 金额面（by_harness / by_provider / 预算 / 日历） | ❌ 刻意排除 | `summary.rs:29 PERMANENTLY_EXCLUDED_HARNESSES` |
| ~~`SessionStore`~~ | ⚠️ **待删** | `r2a_store.rs` DEPRECATED（PR #4）→ v0.9.3 删除（PR #5）；**不要在此加执行环境** |
| traces（write/edit/subagent/duration 证据） | ❌ **可接但未接**（09-11 纠正） | 归属键 `trace.sessionId` 覆盖 22/23 会话；现有适配器按 09-02 错误结论标 Unavailable——Phase E |

「排除」不是遗漏：`tests/test_v09_onboarding_fixtures.py::test_workbuddy_is_declared_but_excluded`
**双向**钉死——注册表必须有它的行，`by_harness` 必须没有它。任何一侧的擅自变更都是回归。

## 2. 真机语料实测基线（2026-09-10）

`~/.workbuddy/` 本机重测：

| 项 | 实测 |
|---|---|
| 会话 | 22（`sessions` / `session_usage` 各 22 行） |
| **① 积分轨（证实）** | **11 会话 · 1,109,007 token · 4,307.76 credit** |
| **② 未计入积分（成因不判定）** | **11 会话 · 962,116 token · 0 credit**——见 §2.1，**不可**断言是自配轨 |

> **2026-09-12 脚注（E5）**：本表的 token 列是 `session_usage.used`——**最后一次
> 调用的上下文占用 prompt_tokens 快照**（§9E.1），不是 processed 用量；留档作历史
> 基准，**不**充当 §5.2 名义分母。processed 口径见 §5.2：积分轨 435,907,687 /
> 全量 473,051,927。
| 语料跨度 | **2026-07-29 → 2026-08-23**（北京日）；**2026-09 自然使用为零**（09-11 多出的第 23 个会话是用 WorkBuddy 分析本 spec 产生的——观测者效应，不计） |
| audit-log | **21 个文件**（2026-09-02 时为 23）——账本在轮转 |
| `requestId` → audit-log 时间戳 join | **64/100**；**10/11** 个有积分的会话至少命中一条 |
| **跨北京日的会话** | **9/22**（有积分的 8/11）；最长 `9e4b26f5` 08-04 → 08-17，**13 天** |
| audit 词表 | 仍是 `(category, eventType)` 对：sandbox-executed 2391 · WebFetch 75 · bulk-delete 68 · Bash 审批 12 · 段标记 17 |
| 心跳 `sessions/*.json`（09-11 08:00 补测） | **3 文件**，`kind` = interactive ×2 / **`prewarm` ×1**（`cwd=/`，预热池，无用户意图）——**推翻 memory「心跳目录恒空」**。**时点快照**：文件随进程生灭，验收复测（同日稍后）只剩 2 个 interactive——prewarm 的存在是结构性事实，某一刻有几个是语料偶然 |
| 模型代号漂移（09-11 补测） | 第 23 会话 `model = hy4-preview-f`（裸内部代号，此前语料无）——印证 §11 规则 16：模型名是语料偶然 |
| `workbuddy.db` 日志模式（09-11 补测） | **WAL**，主库 155KB / WAL 630KB；现有 `SQLITE_OPEN_READ_ONLY` / `mode=ro` **已参与 WAL**（读到 23）；`immutable=1` 会静默丢 WAL（读到 22）——**别改成 immutable、别裸拷主库** |

三条与旧记录不符、以本次为准：

- **`requestId` join 率是 64%，不是 memory 里的 13%**。旧数字应是词表漂移事故期间的产物。
- **audit-log 文件从 23 掉到 21**：轮转是活的，「最老记录可能被轮转」不是理论风险。
- **两态的 token「几乎各占一半」是 used 口径**（1,109,007 vs 962,116）——used 是最后调用
  上下文快照，不是用量；processed 口径积分轨占 92.1%（§5.2 E5 重算）。旧基线保留作历史。

**自然使用已停止**是排期依据（§12），不是不接的理由：行为证据的价值是历史性的。
（观测者自身制造的会话——如用 WorkBuddy 分析本 spec——不算自然使用，见 09-11 补测行。）

### 2.1 「零积分」不可断言成因——两态，不是三桶

初稿（及本篇 v2）把零积分会话统称「自配轨」。**那是编的**，本机数据当场证伪：

| model | 有积分 | 无积分 | models.json endpoint |
|---|---|---|---|
| `custom-local:MiniMax-M2.5` | 1 | 1 | api.minimaxi.com **←混轨** |
| `custom-local:MiniMax-M3` | 3 | 2 | api.minimaxi.com **←混轨** |
| `custom-local:deepseek/deepseek-v4-flash` | 0 | 6 | beta-router.shengsuanyun.com |
| `hy3`（平台内置） | 2 | 2 | — **←混轨** |

三条结论：

1. **`credits == 0` 不识别轨道**。`hy3` 是平台内置模型、**根本没有自配路由可走**，却有
   2 个零积分会话。用户 2026-09-11 给出真相：那是**平台推广自家模型的限免**。
2. **`models.json` 给的是「该模型能不能走自配」，不是「这个会话走没走」**。同一模型
   同一条目，有的会话记积分有的不记——轨道是会话/请求级，而会话表不记路由。
3. **`vendor` 字段不可信**：`MiniMax-M3` 标 `vendor: "Custom"` 但 `url` 是官方端点
   `api.minimaxi.com`。vendor 是 UI 标签，`url` 才是路由证据。

因此**分类只有两态**（① 积分轨证实 / ② 未计入积分），成因**不进分类维度**。
已知成因至少三种——自配路由 · **限免促销** · 执行环境未记账——且**成因是业务决策、按月变动**
（促销会结束）。把成因检测写进规则，等于把一个促销期固化成产品概念（§4.2 规则 7、
§11 规则 16）。

**成因归用户声明，不归机器推断**——与 `subscriptions` / allowance 同一类。
`models.json` 的路由线索可作**诊断提示**显示，不可作分类依据：它连「是不是自配路由」
都证明不了，更不能排除限免。

## 3. 三条实测缺陷（Phase A 的对象）

### 3.1 `cost.cny` 把积分当人民币报

```
$ agent-vitals workbuddy-session --session ad447428-… --json -
"cost": { "tokens": 133966, "cny": 1763.88, "harness_billed": true }
```

`1763.88` 是**积分**。按官方加量包公开价（1,000 积分 = ¥50，2026-07-01 起）折算约
**¥88.19**。字段名叫 `cny`、旁边站着 `harness_billed: true`，任何下游只会当钱读。

落点：`harnesses/workbuddy/sources/mod.rs::cost_of`（Rust）↔
`agent/workbuddy_session_audit.py:155`（Python）——两侧字面相同，差分门禁全绿，因为
**两边错得一模一样**。

### 3.2 `date_span` 在真机恒为 null——在新架构下这是致命的

```
$ agent-vitals workbuddy-session --list
1586b156-…  打招呼  custom-local:deepseek/…  - → -      ← 日期列全空
```

根因：真机 `audit-log.timestamp` 是 **epoch-ms 整数**，`sessions.created_at` /
`updated_at` 是 **INTEGER** 列；而 `date_span_of` 只收字符串（Rust `Value::as_str`、
Python `_is_iso_ts`），整数一律读成 None，兜底路径同样是 `str_field` → 也 None。

初稿把这条评为「列表排序难看」，**低估了**。统一会话面的 SQL 硬条件是
`event_ts_ms IS NOT NULL`（§7.1）——**没有时间戳的事实等于不存在**。这条从可用性
缺陷升级为 Phase B 的存亡前提。

### 3.3 fixture 是纸面 schema，与真机形状不一致

`fixtures/workbuddy/build_workbuddy_fixture.py`：

```python
"CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, model TEXT, "
"cwd TEXT, permission_mode TEXT, use_sandbox_cli INTEGER, "
"created_at TEXT, updated_at TEXT);"          # 真机：INTEGER，且该表有 30 列
...
("s1", 5000, 12345, '{"r1":0.02,"r2":0.03}')  # 真机单请求积分中位 22.06
```

audit-log 的 `timestamp` 同样写成 ISO 串。**这是 2026-09-02 词表漂移事故的同款复刻**
——fixture 与实现同错互证，六条差分全绿却测不到真机形状。那次的教训（memory 原文）
是「fixture 是『真机形状』的代理，写错词就是让门禁测错东西；词表以真机审计为准，
不认文档」。这次错的不是词表是**类型**，纪律同一条。

> **不修 fixture 就修不了 §3.2**：在 ISO 串 fixture 上做整数时间戳兼容，测试既无法
> 转红也无法转绿。Phase A 的工作项因此以 fixture 先行（§10 项 1）。

## 4. 目标 / 非目标

### 4.1 目标

- **A**：`workbuddy-session` 的成本块与时间轴对真机说真话；fixture 承载真机形状。
- **B**：WorkBuddy 会话进入统一 `sessions list/read/navigation`——或明确选择不进。
- **C**（拍板后）：名义栏归属 + 真实现金账单的手工录入通路。

### 4.2 非目标（写死，防后续滑坡）

1. **不把 credit 折算值写进实付栏或预算分子**。名义栏可进（§5，须带 basis 串与日期）；
   `metered_spend` / `summable_total` / `budget_status_sql` 的分子**不可**。
   ——初稿此条写成「禁止进任何汇总面」，过严，见修订记录 2。
2. **不把会话级聚合 `used` 拆进 usage_facts 四桶**（§9）。
3. **不动 `assets/pricing.json`**：积分兑换价不是模型价卡，不长第四份价格拷贝。
4. **不新增 `BillingBasis` 档**。五档词表有硬常量 `variant_count()` 与 `as_str`/
   `from_wire` 双向映射，为一个执行环境开第六档是把口径问题伪装成类型问题。
5. **不在 `r2a_store.rs` 上加任何 WorkBuddy 代码**（该模块待删，§7.1）。
6. **不重建 wasm、不碰 DSH tab**；**不用 traces 猜 session**（`WORKBUDDY_INTEGRATION` §6/§12.2 延续）。
7. **不为 WorkBuddy 设计专属配额机制**（§5.0）：它是「内部配额 + 第三方通道」这个
   既有形状的第三个实例，要补的是抽象的实例，不是执行环境的特例。
8. **不由机器推断零积分成因**（§2.1）：自配路由 / 限免促销 / 执行环境未记账三者不可分辨，
   且成因是**按月变动的业务决策**。成因归用户声明。
9. **不把语料观测写成规则**（§11 规则 16）：观测进哨兵与展示，规则只建在结构性事实上。

## 5. 成本口径：WorkBuddy 在四条栏里各占什么

`CLAUDE.md` 的成本词表：「花了多少钱」是**四个互不相加的量**，且分币分栏永不相加。
所以不存在一个「因为拒绝折算而被打破的统一总数」——那个总数按设计就不存在。

### 5.0 WorkBuddy 不是特例，是第三个实例（2026-09-11 定调）

用户指出、代码核实成立：**Codex / Claude Code / WorkBuddy 是同一个形状**——
一个内部配额 + 一个第三方绕行通道。`codex/sessions/usage.rs::plan_from_rate_limits`
产出的配额快照里**本来就有 `has_credits` 字段**：

| | 内部配额单位 | 重置周期 | 第三方路由证据 |
|---|---|---|---|
| Codex | `used_percent`（执行环境自报） | 滚动窗口 `window_minutes` | `billing_modes` 判定链②路由层 |
| Claude Code | `quotaLimits` five_hour / seven_day | 滚动窗口 | `ANTHROPIC_BASE_URL` / `AUTH_TOKEN` |
| **WorkBuddy** | **credit（可数）** | **自然月，不结转** | **`models.json` 的 `url`** |

`PROVIDER_ROUTE_ATTRIBUTION_SPEC.md` §6.4 早已这样规定：「WorkBuddy 和其他执行环境：
**复用相同的 adapter 输出契约**」。本篇前几版把它当特例设计，是没把这条读进去。

**后果：不为 WorkBuddy 设计任何专属配额机制**（§4.2 规则 6）。要做的是补既有抽象
的第三个实例：`sql_sync.rs` 把 `snapshot_kind` 写死成字面量 `'codex_quota'`——
参数化即可；表 `harness_runtime_snapshots` 本身已是 `(harness, snapshot_kind)` 通用形状。

**一处不可抹平的保真度差异**：Codex/Claude 的分子分母都由执行环境自报（`used_percent`
已折算）；WorkBuddy **分子可测（credit_json）、分母不可观测**（会话表 30 列无余额
字段，余额在服务端账户面）。所以它的 `QuotaConsumption` 是「分子 measured / 分母
unavailable」——正是 Coverage 三态存在的意义，不是缺陷。

**而可数单位带来另两家没有的能力**：积分 = 模型系数 × token（官方系数随促销变动），
所以 `credit / token` 可**逐模型反推实测系数**。Codex/Claude 的 `used_percent` 是执行环境
折算后的结果，反推不出单价结构。这也解释了 memory 记的 credit/M 跨会话漂移
60~13,000——不是账本错误，是模型混用。**只报实测系数，不与任何内置系数表对账**
（内置表 = 把促销期快照固化成常量，§11 规则 16）。

### 5.1 四栏归属

| 栏 | WorkBuddy 贡献 | 依据 |
|---|---|---|
| `nominal_cost`（名义，可比度量尺） | **¥215.39** = 4,307.76 credit × ¥0.05 | §6.7「名义**允许**按显式声明、带日期的汇率折算」 |
| `metered_spend`（按量实付） | **0**（积分为套餐/活动赠送，无按量付费流） | 用户裁决 2026-09-02 |
| `FixedSubscription` | **若用户在付 WorkBuddy/CodeBuddy 月费，那才是它的真实现金成本** | 走 `data-harness-bill --basis fixed_subscription`，**与积分数无关** |
| `unpriced_tokens` | **未计入积分**的 **962,116** token（§2.1 ②） | 成因不判定；其中已知有限免促销与自配路由，本机均无价卡 |

**第三行是初稿完全漏掉的**：memory 记着「套餐费按基础设施成本不按积分摊销」——
若确实在付月费，WorkBuddy 的现金成本不是 0，只是它跟积分数无关，不能由积分推出。

#### 5.1.1 赠送积分**不产生** `harness_bills` 行

`BillingBasis::HarnessBilled` 的语义是**「这个数字由执行环境产出，不是我们价卡算的」**
——它管*谁产出了这个数*，不管*钱有没有动*。所以：

- **已购加量包** → 有账单 → `harness_bills` 行，进总额、进预算，天经地义；
- **赠送/赠送性积分** → **没有账单** → **根本不产生 `harness_bills` 行**。

赠送积分不需要一个「该算多少钱」的答案。正确答案是它不产生金额行——`harness_bills`
的每一行都必须对应一张真实账单。这不是回避，这就是答案。

#### 5.1.2 限免促销属**名义栏**，其名义价值不为零

`ATTRIBUTABLE_WASTE.md` §6.7 逐字点名了这一档：名义成本「**不扣套餐、不扣中转折扣、
不扣促销**——这正是「名义」的定义」。限免的 token 是**真消耗、真产出**：

| | 值 |
|---|---|
| credits | 0（真测量——确实没消耗积分） |
| cash | 0（真的免费） |
| **nominal** | **> 0**（按标价该值多少钱） |

**当前实际处理已经正确、无需改代码**：`hy3` 在 `assets/pricing.json` 里没有价卡
（`hy3`/`hunyuan`/`混元`/`tencent`/`腾讯` 全部查无），故其 145,034 token 落
`unpriced_tokens` / `no-price-card`。用户若声明 hy3 官方标价，它们进名义栏并显示
「促销省下 ¥X」——那是真实的**已捕获价值**，与浪费相反，是本仓库当前完全看不见的
一类信号。

### 5.2 名义单位成本与分母陷阱

§6.7 的可比量是 `nominal_cost / processed_tokens × 1M`。WorkBuddy 无逐桶单价、无逐
模型 token，走不了标准的 `Σ 桶 × 单价`，但「积分 × 兑换价」是同等性质的 list-price
派生量，落进同一栏。

**分母必须是 processed tokens（traces 四桶之和），不是 `used`**（E5，§9E.5 实施
注记）。`session_usage.used` 是**最后一次调用的上下文占用 prompt_tokens 快照**
（§9E.1 实测：22/22 会话里 16 个逐字相等、1 个 ±0.5%、5 个偏离——它测的是「最后
一次会话中的 context size」，不是「这次会话处理了多少」）。用 processed 重算
（2026-09-12 真机，5,222 个 generation span，积分>0 的会话 12 个）：

```
积分轨分母（正确）:  ¥215.49 / 435,907,687 tok = ¥0.49/M   （12 个积分>0 会话）
全量分母:            ¥215.49 / 473,051,927 tok = ¥0.46/M
unpriced（免费轨 11 会话）: 37,144,240 tok → 不进分母不计 0
```

旧口径「各占一半、稀释 46%」（2026-09-02 的 used 基准）被 processed 推翻：
**积分轨占全量 92.1%**、免费轨只 7.9%——把免费部分算进分母只稀释 8.3%，不是
46%。差异变小不是「不重要」，是**旧的 46% 稀释论证建立在量纲错误的 `used` 上、
作废**；§2 的 used 基准保留但降格为历史注解（脚注加在 §2 表）。

**规格**：WorkBuddy 名义单位成本的分母**只含积分轨 processed token**（`credit_json`
求和 > 0 的会话）；未计入积分的 37,144,240 只进 `unpriced_tokens`，不进分母也不计 0。

**两把尺不能相加**：其他执行环境的名义是 `token × 官方卡`，WorkBuddy 的是
`积分 × 兑换价`。并列可比，求和无意义——展示层必须并列不合计。

### 5.3 `nominal / actual` 倍数护栏

§6.7 规定倍数 > 50× 时报「计费声明与实际用量不符」而非「值 N 倍」。WorkBuddy 的
`actual = 0` 使倍数**无定义**：展示层必须走「**无实付证据，不计算倍数**」分支，
不得显示 ∞，更不得显示「省了 N 倍」。

#### 5.3.1 护栏对合法免费额度的假阳性——**已迁至 `ATTRIBUTABLE_WASTE.md` §6.7**（B7）

发现于本篇（`hy3` 限免：nominal > 0、actual = 0，护栏会误报「计费声明错误」），但它
是**跨执行环境**口径缺口，不是 WorkBuddy 的附属条款。豁免分支的规格（先查已声明的免费
额度 → 有则显示「免费额度（已声明）」，无则维持原告警；成因归声明不归推断）现在
住在 `ATTRIBUTABLE_WASTE.md` §6.7「护栏的第二种成因」段，本节只留指针。

## 6. Phase A：口径与时间轴修复

**独立价值，不依赖任何后续 Phase，是 §7 两条路径的共同前置，可立即执行。**

### 6.1 `cost` 块新契约

```json
"cost": {
  "tokens": 133966,
  "credits": 1763.88,
  "cash_cny": null,
  "nominal_cny": 88.19,
  "nominal_basis": "pack-price-public:1000cr=50CNY@2026-07-01",
  "harness_billed": true
}
```

| 字段 | 语义 | 纪律 |
|---|---|---|
| `tokens` | `session_usage.used`（会话级聚合） | 无逐请求 token，不拆桶 |
| `credits` | `credit_json` 各 requestId 之和，**单位 = 积分** | 按厘累计防浮点漂移（既有实现保留） |
| `cash_cny` | 现金口径实付 | **恒 `null`**——本机无支付证据。缺失报缺，**绝不填 0**（0 是「确实没花」的真测量，我们不知道） |
| `nominal_cny` | `credits × 0.05`，**名义栏**输入（§5.1） | 可进名义汇总，**不可**进实付栏/预算分子 |
| `nominal_basis` | 折算依据 + 日期的可追溯串 | 兑换价变更时改这里，不改静默数字 |
| `harness_billed` | 保留 | 执行环境自己记账、非我方重计价 |

**破坏性变更**：`cny` 键消失（改为语义明确的 `cash_cny` / `nominal_cny` 二分）。
全仓库消费方只有两处（Rust/Python 各一），无外部读者。

`credits` 为 0 且 `used` 缺失 → 整个 `cost` 为 `null`（既有降级纪律不变）。
**未计入积分的会话** → `credits: 0.0` + `nominal_cny: 0.0` 是**真测量**（平台积分轨
确实未消耗），但其成因**不可判定**（§2.1）——由 `notes` 一条说明「未计入积分，成因
不判定」，**不由数字冒充，也不由适配器指认成因**（§11 第 14 条）。

### 6.2 时间戳解析规则

`audit-log.timestamp`、`sessions.created_at` / `updated_at` 三处统一：

1. **字符串** → 走现有 ISO 路径（其他执行环境与旧 fixture 的既有形状不回归）。
2. **整数 / 浮点** → **按毫秒解释**（真机三处均为 13 位 epoch-ms），归一成
   `YYYY-MM-DDTHH:MM:SSZ` UTC 串。
3. **合法性窗口**：归一结果落在 `[2000-01-01T00:00:00Z, now + 24h]` 之外 → 视为
   不可解析，报 `null` 并计入 `attempts`。**不做「10 位当秒、13 位当毫秒」的自动
   嗅探**——那是在一个只观测到毫秒的执行环境上发明一条无证据支撑的规则。
4. 其余类型（bool / null / object）→ `null`。

`date_span` 的排序在归一后按串字典序（= 时间序）进行，与既有实现一致。

### 6.3 文档勘误

`WORKBUDDY_INTEGRATION.md` 三处按 §3.1/§5 改写，并加一行指回本篇：

- §9 首句「`credit_json` = `{requestId: ¥}`」→ `{requestId: credit}`；
  「TOTAL ¥4307.76」→「TOTAL 4,307.76 credit（名义 ¥215.39；现金口径无实付证据）」。
- §2.1 表 `session_usage` 行的「`credit_json`(执行环境计费)」→「(执行环境**积分**账单)」。
- §9 输出契约段的 `{tokens, cny, harness_billed}` → §6.1 的新形状。

### 6.4 Phase A 验收

1. `workbuddy-session --list` 在**真机**上日期列非空（当前全 `-`）。
2. `workbuddy-session --session <top-credit> --json -` 的 `cost` 是 §6.1 形状，
   `cash_cny` 为 `null`，`nominal_cny` 与 `credits × 0.05` 一致到分。
3. fixture 的 db schema 列类型与真机一致（`created_at`/`updated_at` INTEGER、
   `session_usage` 含 `updated_at`），audit-log `timestamp` 为 epoch-ms 整数，
   credit 值改真机量级；builder 自校验数字同步更新。
4. 六条既有差分（`test_cli_matrix.py`）在新 fixture 上重新逐字节一致。
5. 新增回归：整数时间戳能解析、越界时间戳报 null 且进 attempts、`cost` 不含 `cny`
   键、`nominal_cny` 不出现在任何**实付**汇总 DTO 里。

## 7. Phase B：统一会话面——两条路径二选一

### 7.1 决定性的架构事实

统一 `sessions list` 不是「列 sessions 表」，是**对 `usage_facts` 做 GROUP BY**：

```sql
-- crates/agent-vitals-data/src/authority_query.rs:907 SQL_SESSIONS_IN_WINDOW
SELECT session_key, harness, MIN(event_ts_ms), MAX(event_ts_ms), COUNT(*),
       SUM(uncached_input_tokens), … GROUP_CONCAT(DISTINCT COALESCE(model_id,'<unknown>'))
FROM usage_facts
WHERE harness = ?1 AND observation_kind != 'legacy_aggregate'
  AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL AND session_key IS NOT NULL
  AND event_ts_ms >= ?2 AND event_ts_ms < ?3
GROUP BY session_key
```

`harnesses` 为空时的执行环境枚举同样是 `SELECT DISTINCT harness FROM usage_facts`（同文件 :943）。

**推论**：一个会话出现在统一面，**当且仅当**它有至少一条带时间戳的非聚合 UsageFact。
因此：

- 「先接会话面、后谈成本面」的分层**没有落点**——它描述的是 r2a 时代的形状。
- `sessions list --harness-kind` 是自由 `Vec<String>`（`main.rs:809`）、`harnesses` 过滤是
  自由字符串数组（`sessions_search.rs:31`）：**门早就开着**，无词表需要放开。
- `sessions read` 已无逐执行环境分支（`main.rs:3226` 直接 `dispatch("session_detail")`
  按 `session_ref` 查 SQL），**没有 branch 可加**。
- `SessionStore::workbuddy` 是往待删模块里加执行环境（§1 末行），**不做**。

### 7.2 路径 1：发逐请求 UsageFact，进统一面

**粒度 = 逐 `requestId`**（`credit_json` 的 100 条），不是逐会话。逐会话方案已被
实测否决：**9/22 会话跨北京日（有积分的 8/11），最长跨 13 天**——把整个会话的用量
记在 `updated_at` 那一天，是把 13 天的花费砸进一格日历。

字段映射：

| UsageFact 字段 | 取值 |
|---|---|
| `harness` | `workbuddy`（需进 `ingest_service::FACT_HARNESSES`） |
| `native_session_id` | db `sessions.id` |
| `source_event_id` | `requestId`（执行环境原生稳定 id） |
| `observation_kind` | `harness-credit-entry`（新值，非 `legacy_aggregate`，故不被 §7.1 查询排除） |
| `event_ts_utc` | 同会话 audit-log 里该 requestId 的**最早**时间戳（实测 64/100 可得） |
| `time_basis` | `native`；**无时间戳的 36 条写 `null`** |
| 四桶 token | **全 0** |
| `amount_decimal` / `amount_basis` | credits / `harness_billed` |
| `source_usage_semantics` | 声明执行环境原生粒度 |

三条纪律：

1. **四桶全 0 是诚实的**，表达「此执行环境不报分桶」；在 `sessions list` 里表现为该会话
   total=0、按 total 降序沉底。把 `used` 塞进 `uncached_input_tokens` 凑总量是编造桶
   （§9），**不可**。
2. **36% 无时间戳的行写 `time_basis: null` 且 `event_ts_utc: null`**，与 DSH emitter
   的既有惯例一致（`dsh/sources/usage_fact.rs:112`「epoch 0 是真时间、不是无时间」）。
   **不发明会话级回退时间**——那是在没有分辨率的地方发明分辨率。代价如实：这些行
   入库但不进时间窗口查询。
3. **`tokens_by_harness["workbuddy"]` 必须继续被排除**。四桶全 0 会让它报 0 token，
   那是 MeasuredZero 冒充真测量——workbuddy 留在 token DTO 的排除名单里。

**可见性代价（如实）**：22 个会话里 **10 个**会出现在统一面（10/11 个有积分的会话
至少有一条带时间戳的行；另 1 个有积分会话的 requestId 全部 join 不上；11 个未计入
积分的会话没有任何积分事实，诚实缺席）。

前置：Phase A 全部三项。

### 7.3 路径 2：维持现状，`workbuddy-session` 保持独立子命令

行为审计价值（真机 2,463 次工具调用、80 条审批决策、hash 链账本）**已经拿到了**，
只是不在统一列表里。代价：工作台看不到 WorkBuddy 会话。

考虑到语料**已停止增长**（2026-09 零活动）且 audit-log 正在轮转（23 → 21 文件），
这条的性价比不差。

### 7.4 选择建议

**推荐路径 2，除非 WorkBuddy 恢复活跃使用。** 路径 1 的收益是 10/22 个历史会话出现
在一个按 token 排序的列表里，而它们的 token 恒为 0（沉底）；成本是一个新
`observation_kind`、一次 `FACT_HARNESSES` 词表放开、以及在每个消费方逐一审计
「workbuddy 是否该被排除」。**收益与成本不成比例**——除非语料重新增长。

### 7.5 Phase B 验收（若选路径 1）

1. `sessions list --harness-kind workbuddy --day <有数据的日>` 列出该日会话，
   token 列为 0，排序沉底。
2. 其余三执行环境的 `sessions list` 输出**逐字节不变**。
3. `tokens_by_harness` **无** workbuddy 键；`monthly_summary.excluded_harnesses` 仍含它。
4. 无时间戳的 36 条事实**在库里可查**（`data-status` 计数含它们）但**不进**任何
   时间窗口查询。
5. `data-reimport-verify` 通过（幂等重放逐字节一致）。

## 8. Phase C：名义栏与真实账单（需拍板）

> **2026-09-11 收缩**：本节前一版提了四件事（三执行环境同构 · 配额计量 · 三桶分类 ·
> 系数对账）。按 §11 规则 16 的判据筛掉拟核部分后，**只剩两条纯结构性的**（§8.0）。
> 配额百分比 · 系数对账 · 成因分类**全部降级为「有数据时的展示」，不进规则层**——
> 这样即使 WorkBuddy 改版或换用户，坏的最多是展示，不会是判定。

### 8.0 收缩后的结构性两条

1. **`QuotaConsumption` 从 WorkBuddy 的 `unmeasured_signals` 移出**，覆盖状态标注
   「分子 measured / 分母 unavailable」（§5.0 末段）。这条不依赖任何语料数字。
   连带：`derive_coverage` 必须真的产出该信号计数——声明了就必须真能测，否则是
   `evidence.rs`「适配器不得用读不到的东西刷覆盖」那条纪律的反面。
   同步面：`harness_capability.rs` + Python 镜像 + `test_harness_capability.py` /
   `test_harness_contract.py` 的 byte-parity 断言。
2. **第三方 Key 走既有 `billing_modes` 判定链 + RouteEvidence**，**零 WorkBuddy
   专属逻辑**（`PROVIDER_ROUTE_ATTRIBUTION_SPEC.md` §6.4 已如此规定）。

**架构影响**：若配额只**现算不落表**（22 会话、credit_json 求和，毫秒级），则
**零表、零封闭词表、零同步管线**。若要落 `harness_runtime_snapshots` 存历史，则因该表
的 `ingested_run_id NOT NULL REFERENCES sync_runs(run_id)` 外键，WorkBuddy 必须进
同步管线，要碰 `FACT_HARNESSES` / `sync_service::batches` / `WIRED_HARNESSES` 等 5 处执行环境
列表——**但按 §5.0 那不是给特例开口子，是让「支持配额快照的执行环境」列表承认第三个
实例**。语料已停止增长，**建议先现算**。

> **未验证的交互风险**：若用户声明 WorkBuddy 订阅并填 `amount_per_month`，
> `declared_subscriptions` 是按 **provider** 枚举（不是 harness），`apply_subscription_fees`
> 会把它摊进 `by_provider`；而 WorkBuddy 在 `PERMANENTLY_EXCLUDED_HARNESSES` 里，一旦
> 落进 `by_provider` 就会触发 `contract_violations()` 的「排除的执行环境不能同时贡献
> 数据」。**此交互只读了一半代码，未跑测试验证**——真做 Phase C 前必须先确认。

### 8.1 名义栏（可做，风险低）

把 §5.2 的 `¥194.2/M`（积分轨分母）接进名义成本视图，**并列不合计**（§5.2 末段），
并遵守 §5.3 的倍数护栏（含 §5.3.1 的限免豁免缺口）。这一步不碰 `metered_spend`、
不碰预算、不碰 `pricing.json`。

**配额展示若做，必须三栏同屏**——只显示 `3,514 / 4,000 = 88%` 会让用户以为看到了
全部 WorkBuddy 用量，而实际上 **46.5% 的 token 根本不经过配额**：

```
WorkBuddy 2026-08
  积分配额   3,514 / 4,000 credit (88%)  ·  1,109,007 token   ← allowance 未声明则只报绝对量
  未计入积分                             ·    962,116 token   ← 成因不判定（§2.1）
```

单显百分比就是**靠省略撒谎**（§6.6「无法证明完整时不编百分比」同款）。

### 8.2 真实现金账单（用户提供证据时）

两类，都走**既有**手工录入面，**零新代码**：

```bash
# 加量包实际购买
agent-vitals data-harness-bill set --harness workbuddy --provider workbuddy \
  --month 2026-08 --basis harness_billed --amount-minor <分> --currency CNY \
  --evidence-ref "receipt:<订单号>"

# 订阅月费（§5.1 第三行——与积分数无关）
agent-vitals data-harness-bill set --harness workbuddy --provider workbuddy \
  --month 2026-08 --basis fixed_subscription --amount-minor <分> --currency CNY \
  --evidence-ref "subscription:<账期>"
```

`apply_harness_bills`（`summary.rs:1153`）已把这类行折进 `by_provider["workbuddy/workbuddy"]`；
`data-harness-bill` 的 CLI help 原文即写着「Harness bills (**WorkBuddy credit**, subscription
invoices…) are **user-entered, not derived from our price cards**」。

此时且仅此时需同步：从 `PERMANENTLY_EXCLUDED_HARNESSES` 摘除 workbuddy（否则
`contract_violations()` 会正确地报「排除的执行环境不能同时贡献数据」），并改写
`test_v09_onboarding_fixtures.py` 的金额面断言。

**系统永不自动生成这两行**：`amount_minor` 必须来自用户提供的收据/账期，不能来自
`credits × 0.05`。前者是账，后者是尺——§6.7 的词表陷阱条款在这里逐字适用。

## 9. Phase D：把 `used` 拆进四桶冒充 token 计量——明确不做

与 §7.2 的「四桶全 0」划清界限：**发事实是诚实的，编桶不是。**

1. **无逐请求 token**：只有会话级 `used`。四桶任填其一都是编造构成。
2. **无四桶语义**：WorkBuddy 不暴露缓存读写，`cache_hit_ratio` 无源。
3. **借用其他执行环境的卡计价**：§6.7 实测同一模型按不同卡计价相差 **46 倍**，借卡等于编价。

工程面附注：WorkBuddy 是**单文件 sqlite + 目录账本**，与 `source_files` 的
(size, mtime) 逐文件指纹模型不匹配——db 每写一次全库 mtime 就变，**文件指纹层面做
不到「只重建受影响的会话」**（r2a v2 的逐 session 依赖指纹对 DSH/Codex 成立，是因为
1 文件 ≈ 1 会话）。若将来确需增量，只能读 db 的 `sessions.updated_at` /
`session_usage.updated_at`（真机确认均为 INTEGER 列）做**内容级**逐会话指纹。

## 9E. Phase E：traces 是 WorkBuddy 的真实数据面（v4 重写，分析步已完成）

### 9E.1 真机 span 面实测（2026-09-11，675 trace / 354 有 sessionId）

**结构**：`{trace: {traceId, name, workerPid, startedAt, endedAt, duration, status, spanCount,
totalTokens, metadata, sessionId?, agentName?, modelInfo?}, spans: [...]}`。span 键：
`traceId, spanId, parentId, name, type, startedAt, endedAt, duration, status, error` +
按 type 附加。**时间戳全是 ISO 毫秒串**（`2026-08-14T23:49:18.442Z`），与 db/audit-log
的 epoch-ms 整数不同——走 A2 的字符串路径。

| span.type | 数量（有 sessionId） | 附加键 | 内容 |
|---|---|---|---|
| `function` | 3,944 | `toolName`, `toolInput`, `toolOutput` | Bash 1,661 · Read 698 · **Edit 612 · Write 172** · TaskUpdate 151 · WebSearch 94 … |
| `generation` | 3,947 | `toolInput`, `toolOutput` | LLM 调用；`toolOutput` 解码后 = 响应对象列表，**3,865 带 `usage`** |
| `agent` | 387 | `agentName` | 子代理/编排（`cli` 等）→ SubagentSpawns |
| `custom` | 9,913 | — | 全部 `mcp_tools` |

**二次编码**：`toolInput` / `toolOutput` 是 **JSON 字符串**，必须 `json.loads` 一层。
解码后：Edit/Write 的 `toolInput` **783/784 带 `file_path`**（+ `old_string`/`new_string`/
`content`）；generation 的 `toolOutput[i].usage` = `{prompt_tokens, completion_tokens,
total_tokens, prompt_tokens_details.cached_tokens, completion_tokens_details.reasoning_tokens}`
（OpenAI 格式），`toolOutput[i].model` = **逐调用模型**（`custom-local:MiniMax-M3` /
`hy3` / `auto` …）。

**三个字段不可信**：
- `trace.totalTokens`：273/675 与 Σspan 相等，**302 为 0 但 span 有 usage** → 不用，只信 span；
- `sessions.model`：会话默认值，不是实际调用——`5018bac6` 一个会话实际调了 6 个模型；
- `session_usage.used`：**不是 processed tokens**——累计类组合全对不上（used/(uncached
  +completion) 在 0.002~0.118 乱跳），但 **= 会话最后一次 generation 调用的
  `prompt_tokens`**（E5 实测 22/22：16 逐字相等、1 ±0.5%、5 偏离——分布与成因记录在 E5 实施注记）。
  即「最后一次调用时的上下文占用」快照。可用，但语义是**上下文大小**不是用量。

**规模**（有 sessionId 的 354 个 trace）：uncached 174.5M + completion 2.5M = **processed
176.9M**，另 cached **296.1M**（Σ`prompt_tokens_details.cached_tokens`，与
`trace.modelInfo.totalCachedTokens` Σ296.4M 互证；uncached + cached = Σprompt 470.6M 对账
成立——初稿写 234M 是算错）；无 sessionId 的 321 个 trace **另有 1,202 次 generation、167M
prompt**——不是 0 token，是**未归属的真实用量**（成因未知，ASK P2-3 的问题仍成立）。

### 9E.2 被推翻的结论（本篇内，逐条）

| 位置 | 原结论 | 实测 | 处置 |
|---|---|---|---|
| §9 Phase D | 「把 `used` 拆四桶 = 编造」 | 前提不成立：四桶从 generation usage **直算**（uncached = prompt − cached；cache_read = cached；output = completion；cache_write = 0 并注明 OpenAI 格式无此桶；reasoning 单列，同 Codex 五桶） | §9 保留「不拆 `used`」，删「WorkBuddy 无四桶」 |
| §7.2 路径 1 | 「四桶全 0，token 恒 0 沉底」 | 可发**真事实**，与 Codex 同形 | 路径 1 重写为 E-a，路径 2 不再是推荐 |
| §5.2 | 名义单位成本分母 1,109,007 | 量纲错（`used`）；应为 processed tokens，且 §6.7 标准路径（token × 官方卡 **逐调用模型**）现在**可走** | **E5 已重算**：§5.2 现用 processed 分母（积分轨 ¥0.49/M、全量 ¥0.46/M） |
| §6.1 | `cost.tokens = used` | `used` = 最后一次调用的上下文占用（`prompt_tokens` 快照），不是用量 | **E5 已落地**：键保留 + note（used = last-call context size）+ `processed_tokens` 新键 |
| §2 基线表 | 「积分轨 1,109,007 token」 | 同上 | **E5 脚注已加**（used 基准、不作名义分母） |
| B2 / §12.2 | 「`Agent workflow` = 另一类、0 token」 | 是 name 不是类；`totalTokens` 不可信；有真实用量 | **E6 已修改**：INTEGRATION §12.2 项与 ASK P2-3 均改为「name 不是类、有真实用量」 |
| ASK P1-1 | 「最大缺口是逐请求用量」 | 数据在 traces 里 | **E6 已改写**：P1-1 = 「请声明 `usage` 与 `model` 字段是契约」 |
| §5.0 末段 | 「积分系数只能逐会话反推」 | 逐调用 model + 逐 requestId credit → **可逐调用**（若 span 与 requestId 可 join，待测） | **E5/E6 已落地**（traces 逐 span usage/model；span 与 requestId 的 join 仍待测，不阻塞） |

### 9E.3 修订后的范围：Phase E = WorkBuddy 的真实数据面

不再是「行为证据补丁」。traces 同时是（a）唯一的逐请求 token 源、（b）唯一的逐调用
模型源、（c）唯一的 write/edit 路径 / 子代理 / 工具耗时 / 工具错误源。接入后 WorkBuddy
可走与 Codex **同形**的 UsageFact 管线（五桶 × 逐调用模型 × ISO 时间戳），§7.1 的统一
会话面自然打开——**不需要**为它开任何特例。

### 9E.4 前置纪律（v4，8 条）

1. 归属 = `trace.sessionId` **字符串相等**；空/缺 → attempts，**不猜**。
2. 无 sessionId 的 trace **不是另一类**——同名同形，只是没归属。它们的 usage 单列
   `unattributed`（真实用量，不进任何会话，不当损坏）；成因等执行环境声明。
3. `toolInput` / `toolOutput` **必须解一层 JSON**；解不开 → 该 span 的对应信号 unavailable
   + attempts，不猜。
4. 四桶只从 span 级 `usage` 算；**`trace.totalTokens` 不读**（不可信）；`used` 不参与。
5. 模型只取 `toolOutput[i].model`（逐调用）；`sessions.model` 不参与归属。
6. 与 audit-log 的 `command-safety.sandbox-executed` **不双计**——**E3 已测已定**：
   `toolCallId` 与 `spanId` 不可 join（0/2,398），audit-log 更完整（2,398 vs 1,661），
   文本 59% 相等；**audit-log 是 Bash 唯一源**，span 的 Bash 只在 notes 里报数、永不进
   tool_calls。同 Codex `custom_tool_call` vs `CommandExecution` 的处置。
7. 653MB / 675 文件：增量读（mtime + 已见 traceId）；解码 `toolOutput` 只取 `usage`/
   `model`，**不保留响应正文**（§4 不要 prompt 正文）。
8. ~~两个「session-anonymous」运行时字面量~~ **E2 已移除**：`WORKBUDDY_SV604_605_REASON`
   与 workbuddy 的 `degraded_rules` 行（Rust + Python）、`TRACES_ERROR` 与 traces 的
   SourceAttempt。`is_unavailable` 已翻 ToolResults / SubagentSpawns（差分重冻）；Usage
   留给 E4（逐调用 usage 进 UsageFact 后再翻）；StepBoundaries 无源，不翻。
   顺带发现并修了 Python `ALL_SIGNALS` 漏掉 `SubagentSpawns` 的既有不对齐——它恒
   unavailable 时被 `_UNAVAILABLE_SIGNALS` 的循环掩盖，E2 让它可测就当场 KeyError。

### 9E.5 Phase E 执行清单

> 每项走【分析 → 编码 → 测试 → 子智能体验收 → commit】。E1 先行——它是 E2–E5 的
> 共同读取层。

- [x] **E1 · traces 读取层 + fixture**（locate → shape → extract）
      `harnesses/workbuddy/sources/traces.rs` ↔ `adapters/workbuddy_traces.py`：枚举
      `traces/*/trace_*.json`，按 `trace.sessionId` 分组，解码 `toolInput`/`toolOutput`
      （只留 `usage`/`model`/`file_path`/`toolName`），ISO 时间戳走 A2 字符串路径；
      无 sessionId → `unattributed` 桶。fixture：`fixtures/workbuddy/workdir/.workbuddy/
      traces/` 两个 trace（一个归属 s1、一个无 sessionId），真机形状（二次编码、ISO ms、
      OpenAI usage 含 cached/reasoning、混合模型）。**实施注记**：E1 落地为全量读
      （真机 675 文件 0.87s Rust / 2.0s Python），探针 `traces_probe` 只加在单会话
      审计 JSON 末位，`--list` 不动；增量索引留 E4。真机 4 个 decode_failures 全是
      `toolInput: ""`——空串 ≠ null，照记失败不猜。顺带修了 B1 的 `.gitignore`
      `.workbuddy/` 未锚定根目录、把 fixture 的 `traces/` 也忽略了的 bug。
- [x] **E2 · 行为 timeline 填充**（SV604/605/607/608 + SubagentSpawns）
      function span → `tool_calls`（name = toolName，args_text 含 `file_path`）+
      `tool_results`（status/error → error_code）；agent span → SubagentSpawns；
      `is_unavailable` 翻转 ToolResults/SubagentSpawns；`degrade_sv604_605` 移除；
      `WORKBUDDY_SV604_605_REASON` / `TRACES_ERROR` 删除；§13 矩阵 G5 登记更新。
- [x] **E3 · Bash 双源对账**（纪律 6）——**裁决：audit-log 是 Bash 唯一源，span 的 Bash 永不并入**
      真机实测（2026-09-11）：audit `toolCallId`（`call_00_…`）vs span `spanId`（`span_…`）
      两套命名空间，**0/2,398 可 join**（验收者全量复算 0/2,395 同结论；初稿 2,114 是只扫 top-10 会话的分母）；sandbox-executed 2,398 条 vs Bash span 1,661 个
      （2,380 distinct toolCallId ≈ 1:1，不是子命令拆分——是 traces 按 worker pid 存、
      轮转丢失约 30%）；命令文本只 59% 相等。没有身份键就没有 dedup，模糊合并是猜。
      audit-log 是 hash 链安全账本且更完整。**代价如实**：Bash 的 status/duration 只在
      span 里、无键可挂 → Bash 没有 tool_results。回归钉「文本完全相等也不合并」。
- [x] **E4a · UsageFact emitter + 只读 CLI**（`harnesses/workbuddy/sources/usage_fact.rs` ↔
      `agent/workbuddy_usage_fact.py`；分期同 v0.7 三执行环境先例：先内存 emit + 只读诊断，
      不动词表、不写盘）
      与 Codex 同形：`observation_kind = "assistant-usage"`、identity = spanId（**native**，
      真机每 generation span 恰 1 条 usage，5,067/5,067）、time = span.startedAt（ISO ms
      串，`time_basis: native`）、`model_raw` = 逐调用 `model` 原串（**不解析前缀**，§2.1）、
      `source_usage_semantics: "delta"`（每 span 一次独立调用）；四桶 uncached = prompt −
      cached / cache_read = cached / cache_write = 0 / output = completion（OpenAI 的
      completion 已含 reasoning，不再加）。归属走 `resolve_billing_attribution(None, None)`
      → `provider_id: null`、`pricing_basis: metered_estimate`、`has_unresolved: true`——
      §2.1 的诚实表达；models.json **不**作 RouteEvidence 传入（即便传也是 ConfigCurrent →
      仍 unresolved）。**未归属 trace 按 Codex 先例计 attempts.unattributed，不发事实**
      （初稿写的 `session_key_orphan` 方案作废——`native_session_id` 是身份必填字段，
      编一个就是编 session）。`workbuddy-usage-facts <home> --machine-namespace NS [--json -]`；
      `tests/test_workbuddy_usage_fact.py` byte-parity。**实施注记**：真机 3,865 facts +
      155 skip + 1,202 unattributed = 5,222 generation span（恒等式钉回归）；两侧 `--json`
      逐字节一致。**顺带修了 main 预存的契约锁步断裂**：`2e011fc fix(v0.12)` 给 Rust
      `USAGE_FACT_FIELDS` 加 `billing_template_id`、Python 没跟——四执行环境 usage-fact 差分在
      带二进制时全红（本地 `discover` 不带 `AGENT_VITALS_BIN` 故一直 skip；CI 会红）。
      加回那一个键后 codex/claude 转绿。**仍红且不在本分支范围**（基线 `88ae4a7` 自建
      二进制复现）：DSH usage-fact 差分 2 条（Python DSH emitter 在隔离 HOME 下读到路由
      证据、Rust 没读——`pricing_basis` route-observed vs metered_estimate）、Codex
      `api_equivalent` 计费档 2 条、data-status health 1 条——均为 main 的 v0.11/v0.12
      provider 工作遗留，与 `verify-workbench-traces.mjs` 同类。
- [x] **E4b · 进封闭词表与同步管线**
      `FACT_HARNESSES` / `TRACE_HARNESSES` / `reimport_verify::HARNESSES` / `WIRED_HARNESSES` /
      `sync_service::batches` 全部 4→4（`reimport_verify::HARNESSES` 复用 `FACT_HARNESSES`
      作 `const HARNESSES = crate::ingest_service::FACT_HARNESSES`，不再单开一份）；sync 的
      dirty-file 枚举 = `workbuddy_trace_files(root)`（locate 面），每文件一个
      source_id、`(size, mtime)` 指纹增量——纪律 7 的索引由 `source_files` 表免费
      得到；无 sessionId 的 trace 照落指纹（本轮已处理），不会每 tick 重读 686MB。
      **tokens_by_harness 含 workbuddy，由 SQL `harness_window_tokens` 直读四桶真值**（非
      §7.2 的「恒 0 冒充」）；`data-status`（facts/sources/covered_from/to，整执行环境
      unpriced——裸模型名不许去撞 DSH 卡）/ `data-unresolved`（`workbuddy/unknown`
      逐模型 billing-route-unknown）/ `data-reimport-verify` / `workbuddy-usage-facts
      --write`（落 `<data_home>/facts/workbuddy.jsonl`）全部认 workbuddy。
      **金额面保持 excluded**：facts 一律 `provider_id: null`（§2.1 三轨不可判）→
      `amounts_by_basis` 恒空 + `has_unresolved` + `billing-route-unknown`，不进
      by_provider，`summable_total` 不含它；`by_harness` 有行是为了「有数据可见」——
      excluded_harnesses 因此是空集（DTO 语义「已知存在但本版本不产出数据」不再适用）。
      summary 全量接线的代价实测：`coverage 4/4`、`contract_violations` 空（单个
      WIRED_HARNESSES / `HARNESS_PROVIDER_MAP`（workbuddy → `&[]`）同表钉死）。
      **统一会话面（§7.2 路径 1）自动成立且已实测**：`sessions list --harness-kind
      workbuddy` 返回 23 个会话、token 四桶真的（2026-08 月 2,407 会话事件、
      452,073,138 tokens）、`cost_minor: null`；`sessions read` 200 条/页的事实
      时间线；`trace-ref` 在 canonical_input 的 workbuddy 分派下产出
      `{tool_call, model_invocation}` 节点图（真机会话 3,687 节点/1,705 模型节点，
      edges 0 = WorkBuddy 无 parentId 链，诚实覆盖）。**实施注记**：真机 `sync-facts`
      首轮 workbuddy 675 文件 3,865 事实 ~2s，二轮 675 skipped（指纹命中）；Python
      侧镜像 locate/shape 拆分只为钉「逐文件拼接 == 全量」等式，不生成写路径。
- [x] **E5 · 成本词表回填**
      §5.2 用 processed tokens 重算名义单位成本（积分轨 vs 全量两栏都算，分母口径按
      归属会话）；`cost.tokens` 改名或加 note「last-call context size」；`cost` 块加
      `processed_tokens`（来自 traces，四桶之和）；§2 基线表脚注；记下 `used` 与
      last-call prompt 不等的 4 个会话（`ad447428` 等）的成因线索（压缩/重置？）。
        **实施注记（2026-09-12）**：
        - `cost` 块 7 键（Rust↔Python 逐字节）：`tokens` 保留 = `used`、语义由新
          note 承担（`WB_TOKENS_ARE_LAST_CALL_NOTE`；不重排键名）、新成员
          `processed_tokens` = 该会话 traces 四桶之和（`processed_tokens_from_spans`
          ：与 E4a emitter 同一挑选规则——每 generation span 取第一条 usage，
          uncached+ cache_read + output，write 恒 0；decode_failed span 不进、
          traces_probe.decode_failures 照报；traces 目录缺失 → null，不编 0）。
          真机：s1 fixture = 27,750（4,000+8,000+300 · 4,000+11,000+450），
          db-only 会话 = null。
        - **§5.2 重算**：分母从 `used` 换 processed tokens——积分轨 ¥0.49/M、
          全量 ¥0.46/M、免费轨 37.1M token 单列 unpriced（「稀释 46%」的旧论证
          建立在量纲错误的 used 上，作废；见 §5.2 全文）。
        - **§6.1 表一行**：`cost.tokens = used` 行标记为「键保留 + note + processed
          另出」→ **本轮已按该方案落地**。
        - **§2 基线脚注**：used 基准注记为历史注解，不再当名义分母。
        - **used ≠ last-call 的 5 个会话**（2026-09-12 实测，22/22 逐字比较；
          16 逐字相等 + 1 个 ±0.5% + 5 个偏离）：`ad447428`（used 133,966 <
          last prompt 278,682）、`ef6c0fd7`（56,027 < 159,255）、`49525d61`
          （0 < 76,694——used 列缺值）、`4e20a4ee`（39,874 < 49,101）、
          `9e4b26f5`（used 107,319 **>** last prompt 83,910——13 天长会话）
          。成因线索：used 是执行环境聚合值的**某时点快照**，与「最后一次调用」的
          拍照点不同步（压缩/重置后 used 停留早期，但末次调用 prompt 已长大；
          或者反之 used 拍在更晚）。`3acac645` 偏 0.5% 算界内。
- [x] **E6 · 文档收口**
      INTEGRATION §9（cost 块 7 键、token 语义、processed 另出——E5 已顺带改）/§12 项
      2/5/6（Agent workflow 是 name 不是类、traces 已接、used 语义）、ASK §0 项 3 +
      P1-1（改写为「请声明 `usage` 与 `model` 字段是契约」）+ P2-3（name 非类、有真实
      用量）、CORPUS §5-6 勘误续（totalTokens 不可信、unattributed 有真实用量）、memory
      `workbuddy-data-facts` 再勘误（`used` 语义、Agent workflow 非另一类、逐调用 model、
      WAL/join/月用量要点保留）。**实施注记**：本项 doc-only——没有测试文件变更；§9E.2
      六行「处置」列全部更新为落地状态。corpus 原 §6 的 6 会话/678K 旧账面、memory 与
      INTEGRATION 的旧结论段落保留作历史并有显式推翻标注，不留「悄悄改掉」的歧义。

**明确不在 E 里**：把 credit 折成钱进实付栏（§5 口径不变）；用 span 里的 prompt 正文
做任何事（§4）；给无 sessionId 的 trace 猜归属（纪律 1）。

## 10. 工作项（依赖序 · 执行清单）

> 分支 `feat/workbuddy-adapter`（worktree，基线 main@88ae4a7）。每项一个滚动内循环：
> **分析 → 编码 → 测试 → 通过后 commit**。勾选 = 该项已 commit 且门禁通过。

**Phase A**（§7 两条路径的共同前置，独立可交付；修的是既有 bug，不依赖任何口径决策）

- [x] **A1 · fixture 承载真机形状**（§3.3/§6.4-3）
      `fixtures/workbuddy/build_workbuddy_fixture.py`：`sessions.created_at`/`updated_at`
      改 INTEGER、`session_usage` 补 `updated_at` 列、audit-log `timestamp` 改 epoch-ms
      整数、credit 值改真机量级；builder 自校验数字同步。**必须最先做**——在 ISO 串
      fixture 上做整数兼容，测试既无法转红也无法转绿。
- [x] **A2 · 时间戳归一**（§6.2）
      `harnesses/workbuddy/sources/mod.rs` 的 `date_span_of` + `workbuddy_session_meta`
      ↔ `adapters/workbuddy_session.py` / `agent/workbuddy_session_audit.py`。
      字符串走旧路径、整数按毫秒、越界报 null 并进 attempts、不做秒/毫秒嗅探。
      **双侧同一 commit**。
- [x] **A3 · `cost` 块改契约**（§6.1）
      `cost_of` ↔ Python 镜像：`cny` → `cash_cny`(恒 null) + `nominal_cny` +
      `nominal_basis`；`credits` 取代原 `cny` 的求和值。键序两侧逐字节一致。
      非积分轨会话多发一条 `notes`（真实开销在用户自配 API 账户、本机不可见）。
      A4 的部分交付：`nominal_cny` 只活在 workbuddy 会话适配器、`PERMANENTLY_
      EXCLUDED_HARNESSES` 仍含 workbuddy——回归钉住（`TestNominalCnyNeverEntersASpendSummaryDto`）。
      evidence.rs 的整数时间戳 fold-in **推迟**：`TimelineEntry.time` 实际会进
      `audit` 投影输出，单改 Rust 会打破 Python↔Rust 差分，需 `workbuddy_evidence.py`
      的 `_parse_time` 同步——超出 A3 范围，留作独立项。
- [x] **A4 · 差分重新冻结 + 新增回归**（§6.4-4/5）
      `tests/test_cli_matrix.py` 六条 workbuddy 差分在新 fixture 上重新逐字节一致；
      新增回归：整数时间戳可解析 · 越界时间戳报 null 且进 attempts · `cost` 不含
      `cny` 键 · `nominal_cny` 不出现在任何**实付**汇总 DTO 里。
- [x] **A5 · 文档勘误**（§6.3）
      `WORKBUDDY_INTEGRATION.md` §9 两处 + §2.1 表一处 + §9 输出契约段；
      本篇状态行更新。
- [x] **A6 · evidence.rs 整数时间戳 lockstep**（A3 推迟项）
      `harnesses/workbuddy/sessions/evidence.rs::parse_time` ↔
      `packages/agent-vitals-python/agent_vitals/agent/workbuddy_evidence.py::_parse_time`：
      整数/浮点按毫秒归一，固定上下界 `[2000-01-01, 2100-01-01)`（纯 crate 读不了时钟，
      不用 now 窗口）。`TimelineEntry.time` 会进 `audit` 投影，**双侧同一 commit** 且
      会移动差分——A4 的最终重冻覆盖它。

- [x] **A7 · 零积分 note 去掉成因指认**（§2.1 逼出的 A3 缺陷，2026-09-11）
      A3 首版 note 断言「the real spend is on the user's own API account (self-configured
      key + endpoint)」——真机 `hy3` 限免会话（平台送的，不存在那笔支出）当场证伪。
      改为「session not billed to credits … cause is NOT determinable — self-configured
      route / promotional free tier / harness-side non-billing are indistinguishable」；
      Rust ↔ Python 同 commit；差分期望、fixture 自校验、回归测试同步改为断言
      **三种成因都点名为不可分辨且不单独指认任何一种**。

**验收门禁**（每项 commit 前必跑，A5 仅需前两条）

```bash
cargo test -p agent-vitals-harnesses                    # workbuddy evidence + sources
python3 -m unittest discover tests                  # Python 全量
AGENT_VITALS_BIN=target/release/agent-vitals python3 -m unittest tests.test_cli_matrix
python3 tests/golden_runner.py                      # 15 张快照不得漂移
```

### Phase A+ · 观测性收尾（2026-09-11，源自 `WORKBUDDY_OBSERVABILITY_ASK.md` §7 + 评审）

> 每项走【分析 → 编码 → 测试 → **子智能体验收** → 通过后 commit】。实现者不 commit；
> 验收者独立审 diff 与门禁；验收通过才落 commit。全部取自 ASK 各条的「若不做」
> 降级路径——**不依赖 WorkBuddy 侧任何答复**。

- [x] **B1 · ASK 文档纠偏 + spec §2 回流**（doc-only）
      P0-1 两条后果推断改正（现有适配器 `SQLITE_OPEN_READ_ONLY` 已参与 WAL，实测读到
      23 会话；差分读 tempdir fixture 从不碰活库）· P0-1 降 P2、P1-2 升 P0 ·
      「语料已恢复增长」改为观测者效应限定（第 23 会话是用 WorkBuddy 分析本 spec 产生的）·
      P0-3 措辞 · P1-3 与 §4.2 的边界明说 · 系数明写不在诉求内 · §7 #3 去依赖。
      回流 spec §2：心跳 `prewarm` 会话存在（推翻 memory「恒空」）· `hy4-preview-f` 裸代号。
- [x] **B2 · traces 改判——方向反转**（doc-only；首版被验收 FAIL 后重写）
      首版按 09-02 结论写「结构性不可接」，验收者 live spot-check 发现 **`trace.sessionId`
      结构化字段存在**（354/675 非空、100% 匹配 `sessions.id`、覆盖 22/23 会话、自 07 月起有），
      09-02 分析是在 prompt 文本扫 UUID、从未读该字段。改判为**可接**：
      `WORKBUDDY_INTEGRATION.md` §2.1/§1.3/§12.2/§12.5 · `WORKBUDDY_CORPUS.md` 勘误 ·
      ASK P2-3 改写为「声明语义」· 本 spec 新增 Phase E 立项。**纪律不变**：不用 prompt
      文本猜 session；`Agent workflow` 类（无 sessionId 键）进 attempts 单列。
- [x] **B3 · 读取快照时点标注**（code，ASK P0-1 若不做）
      `workbuddy-session` 输出加 `source_snapshot: {journal_mode, db_bytes, wal_bytes}`
      ——**不含 mtime**（fixture 上非确定，会破坏逐字节差分）。Rust↔Python 同 commit。
- [x] **B4 · 双向 schema 哨兵**（code，ASK P0-2 若不做）
      对 `sessions`/`session_usage` 的活列集与**声明的已知列清单**比对，未知列进
      `attempts` + note `schema-drift: unknown columns N`；`migrations_applied` 读
      `__workbuddy_drizzle_migrations` 行数（测量，非推断），表缺失报 null。
      已知列清单 = 2026-09-11 真机 30 列快照，**是声明的基线不是规则**（§11 规则 16）。
- [x] **B5 · 生命周期字段浮出（不过滤）**（code，ASK P0-3 若不做）
      `status` / `source_mode` / `is_playground` / `deleted_at` / `is_background_automation`
      按名读入 `--list` 行与会话 meta，缺列 null；**只浮出不过滤**（语义执行环境未声明，过滤
      是消费方的事），note 标注「语义未经执行环境声明」。
- [x] **B6 · `QuotaConsumption` 声明修正**（code，spec §8.0 第 1 条）
      从 WorkBuddy `unmeasured_signals` 移出；`derive_coverage` 产出 measured =
      `credit_json` 条目数（分子），分母 unavailable 由 note 说明。同步
      `harness_capability.rs` + Python 镜像 + `test_harness_capability.py` / `test_harness_contract.py`
      byte-parity；`harnesses --json` 输出会动，差分照冻。
- [x] **B7 · §5.3.1 护栏假阳性迁入 `ATTRIBUTABLE_WASTE.md` §6.7**（doc-only）
      加「已声明免费额度」豁免分支的缺口记录；本 spec §5.3.1 改为指针。

**明确不做（记录理由）**：ASK P1-4 的 `AutomationRuns` 执行环境中立 signal——新增 `Signal`
变体会改 `total_fields` / `denominator_version`（跨执行环境、含 wasm），而 `automations`
四表 **0 行**。为空表建跨执行环境规则违反 §11 规则 16；等第一行数据出现再立项。

### 不在本清单内（不是待办，是决策门）

- **Phase B**：需先按 §7.4 选路径；spec 的建议是**路径 2（不做）**——收益是 10/22 个
  历史会话进入一个按 token 排序的列表而它们 token 恒为 0，成本是新
  `observation_kind` + 词表放开 + 逐消费方审计。语料 2026-09 已零活动。
- **Phase C**：需用户拍板 §5 的非现金口径；账单录入通路已存在（§8.2），零新代码。
- **Phase D**：§9 明确不做。

## 11. 诚实性纪律（继承 + 新增）

继承 `WORKBUDDY_INTEGRATION.md` §12 全部十条。本篇新增七条：

11. **credit 是积分不是货币**：任何把 credit 显示成 ¥ 的字段必须自带 `basis` 串与
    日期，且只能落名义栏（§5.1）。
12. **`cash_cny` 缺失报 `null`**：本机没有支付证据。填 0 是断言「确实没花钱」，
    我们不知道这件事。
13. **fixture 必须承载真机形状**：schema 列类型、时间戳类型、数值量级三项与真机
    对齐；纸面 schema 让差分门禁测错东西（§3.3，与 2026-09-02 词表漂移同一教训）。
14. **`credits: 0.0` 不等于零开销，也不指认成因**：它只说明平台积分轨未消耗。
    可能是自配路由（花在用户自有 API 账户，本机不可观测）、**限免促销**（真免费）、
    或执行环境未记账——三者不可分辨（§2.1）。由 `notes` 说明「未计入积分，成因不判定」，
    **不由数字冒充，也不由适配器指认**。
15. **名义单位成本的分母只含积分轨 processed token**（§5.2）：全量分母会稀释单位成本
    （实测 8.3%、92.1% vs 7.9%——旧口径的「46%」建立在 `used` 上、已被 §5.2 作废），
    那是让不占配额的 token 免费搭车。
16. **结构性事实才配写成规则；语料偶然只能报成数据**（2026-09-11 定调）。判据：
    这条事实是**产品设计**决定的，还是**这台机器的 22 个会话**决定的。

    | 结构性（可建规则） | 语料偶然（只能报数据） |
    |---|---|
    | 内部配额 + 第三方绕行通道并存 | 4,307.76 credit / 88% / 46.5% |
    | `credit_json` 按 requestId 键控 | `¥0.05` 兑换价（07-01 前是 ¥38/1000） |
    | 会话表 30 列无余额字段 → 分母不可观测 | 4,000/月 配额（套餐档位不同） |
    | 轨道是会话/请求级而会话表不记路由 → 可混轨 | 这台机器恰好 3 个模型混轨 |
    | 积分 = 模型系数 × token（执行环境定价杠杆） | M2.5 `0.18` / M3 `0.25`（促销会变） |

    落地手法沿用仓库既有的**残差哨兵**纪律（`CLAUDE.md`：「宽进严出——机器发现，
    人来分类」）：**语料观测不进规则，进哨兵**。WorkBuddy 适配器已在做（不认识的
    audit-log 记录进 `attempts` 而非静默丢弃）。

17. **「本机不可观测」必须建立在读完整数据形状之上**（2026-09-11，同一根因三次）：
    09-02 的分析没读 `trace.sessionId`（→「会话匿名」）、没解 `toolInput`/`toolOutput`
    的二次 JSON 编码（→「无逐请求 token」「无路径」）、信了 `trace.totalTokens`
    （→「0 token」）。三条都被写成了产品结论并流进两份 spec、一份 memory、四份文档。
    规则：声明一个表面「不可接」之前，(a) 读过仓库自己的 schema 文档；(b) 对该表面
    的每个字符串字段试过 `json.loads`；(c) 用两个独立字段互相对账过（如 span 级 vs
    trace 级 token）。任一条没做，只能写「未核实」，不能写「不可观测」。

    **证伪测试**（设计定稿后逐条问，任一条答「会报假话」即为拟核）：
    ① 本机 **0 个 WorkBuddy 会话**时报什么？（应 Unavailable，不是 0）
    ② 用户是**另一个套餐档位**时报什么？（allowance 未声明 → 只报绝对量，不出百分比）
    ③ WorkBuddy **新版在会话表记了路由**时报什么？（②态应自动缩小，而非因多个字段而崩）

## 12. 与 v1.0.0 的关系

`AGENT_VITALS_APP_V1_0_0_PRD.md` 首发执行环境明写 **Codex / Claude Code / DSH**，全文零处
提及 WorkBuddy。因此：

- **Phase A 与 v1.0.0 正交**，随时可做——它修的是既有代码正在输出的错误金额与空日期。
- **Phase B 排在 v1.0.0 之后**，且优先按 §7.4 选路径 2（不做）。
- **Phase C 的名义栏**（§8.1）可与 v1.0.0 的「公私价目隔离」缺口一并考虑——两者都是
  「哪些钱算谁的」问题；**Phase C 的账单录入**（§8.2）已有通路，无需排期。
- **Phase D 不做。**
