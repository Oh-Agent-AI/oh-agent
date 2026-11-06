# 给 WorkBuddy 的可观测性建议(适配器视角的「诉求清单」)

> 撰写 2026-09-11。真机核验基线见 §2(本次实测 `~/.workbuddy/`)。
> **本文的读者是 WorkBuddy 运行时/产品侧,不是 agent-vitals 的实现者。**
> agent-vitals 侧的动作项在 §7,但本文主体是「被观测方能给什么」,不是「观测方要改什么」。
> 关联:[WORKBUDDY_INTEGRATION.md](./WORKBUDDY_INTEGRATION.md)(已落地的适配器)·
> [WORKBUDDY_ONBOARDING_SPEC.md](./WORKBUDDY_ONBOARDING_SPEC.md)(口径与 Phase A–D)·
> [ATTRIBUTABLE_WASTE.md](./ATTRIBUTABLE_WASTE.md)(四栏成本与名义口径)·
> [PROVIDER_ROUTE_ATTRIBUTION_SPEC.md](./PROVIDER_ROUTE_ATTRIBUTION_SPEC.md) §6.4。
>
> **一句话总纲:我们要的不是「更多数据」,是「更少但更稳的契约」。**
> 每多暴露一个字段,就多一份漂移责任;每少声明一个语义,就多一处我们被迫猜测的地方。
> 本文每条建议都自带「若不做 → agent-vitals 如何诚实降级」,因此**每一条都可以被拒绝**——
> 被拒绝的代价是可见的、可接受的,不是隐式地变成错误数字。

---

## 0. 结论

1. **读取安全是一条防御性约束,不是当前缺口**(§3 P0-1,评审后**降为 P2**):
   `workbuddy.db` 是 WAL 库,实测主库 155KB 而 WAL 630KB——大部分已提交数据在 WAL 里。
   **`immutable=1` 或裸拷主库文件会静默丢弃 WAL**(实测 `immutable=1` 读到 22 会话、
   正常只读读到 23)。但现有适配器用 `SQLITE_OPEN_READ_ONLY` / `mode=ro`,**已参与 WAL、
   读到的是最新状态**;差分门禁读的是 tempdir 里的 fixture,从不碰活库。所以这条的
   价值是「别把读法改坏」,不是「现在的数字有错」。
2. **schema 加列是常态,不是意外**(§3 P0-2):`.workbuddy-sqlite-migrations/` 已有 10 个迁移,
   `sessions` 表被加了 6 次列。**加列本身没问题**,问题是外部观测者无法区分「新增了一列」
   和「我读错了表」。给一个 `schema_version` 就够,不需要承诺列不变。
3. **最值得要的一条是请求级路由枚举**(§3 P1-2,评审后**升为 P0**):一个
   `platform-credits / self-configured / promotional` 枚举值就能同时解掉 46.5% token
   落 `unpriced`、零积分只能两态、成因只能归用户声明三个问题——执行环境声明比用户声明
   好一个量级。**逐请求用量已解决(2026-09-12,spec Phase E)**:traces 的 generation span
   自带逐请求四桶,`cost.processed_tokens` 已是真实用量;§7.2 路径 1 已开。剩下的是让执行环境
   **声明 `usage`/`model` 字段是契约**(§3 P1-1 改写)。
4. **traces 不是匿名的**(§3 P2-3,评审后改写):`trace.sessionId` 结构化字段已存在、
   覆盖 22/23 会话。本文初版沿用 09-02 的错误结论,验收复测抓出。write/edit/subagent/
   duration 证据因此**可达**,是 agent-vitals 侧最大的一块未开发面。
5. **我们明确不要四样东西**(§4):价目表、账户面余额、prompt 正文、内部算法细节。
   观测边界止于「本机已发生的事」,越过这条线的东西即使给了也不该用。

## 1. 我们在测什么(一句话)

agent-vitals 做的事是:**把各执行环境(Codex / Claude Code / DSH / WorkBuddy)的会话行为与
消耗,归一化成同一套「证据 + 三态覆盖 + 四栏成本」结构**,并且**不许用估算冒充测量**。
因此它对执行环境的诉求集中在三件事上:**这个数测到了吗(measured / unavailable / measured-zero)**、
**它归谁记的账(执行环境 / 用户自配 / 未知)**、**它花在什么粒度上(请求 / 会话 / 常驻)**。

## 2. 真机核验基线(2026-09-11 08:00,`~/.workbuddy/`)

| 项 | 实测 | 与文档的差异 |
|---|---|---|
| `sessions` / `session_usage` | **23 / 23** 行 | 文档记 22 —— 多出的 1 个见下行 |
| 最新会话 | `203359fe-…`,2026-09-10 23:57 UTC,标题「分析文档 docs/WORKBUDDY_ONBOARDING_SPEC.md」,cwd = 本仓库 worktree | **观测者效应**:它是用 WorkBuddy 分析 spec(多半就是产出本文的那次)而生的,不是用户的自然使用。spec「2026-09 自然使用为零」**仍成立** |
| `workbuddy.db` 日志模式 | **WAL**;主库 155KB / **WAL 630KB**(持续增长) | 多数已提交数据在 WAL;现有只读打开方式已正确参与 WAL |
| 迁移 | **11** 个文件 / `__workbuddy_drizzle_migrations` 9 行 | `sessions` 被加列 6 次;文件数在本文撰写期间又 +1 |
| `sessions` 列数 | 30 列;适配器只用 5 列 | 见 §3 P0-3 |
| `status` 分布 | completed 21 / terminated 2(撰写时 working 1 已完成) | 未被适配器消费 |
| `source_mode` 分布 | working 19 / coding 3 / craft 1 | 未被适配器消费 |
| `automations` / `automation_runs` | 表已存在,**0 行** | schema 就位、数据未启用 |
| audit-log | 21 文件,最新 2026-08-23 | 与文档一致(23→21 轮转继续) |
| `logs/<date>/` | 已到 **2026-09-11** | **仍在增长的不是 audit-log,是这一面** |
| `sessions/*.json` 心跳 | 3 文件,`kind`= interactive / **prewarm** | 预热池会话无用户意图 |
| 当前会话 `model` | `hy4-preview-f`(裸内部代号) | 文档 §9 模型分布已过时 |

> **本次核验推翻了我自己在上一轮给出的一个建议**:我曾建议用 `immutable=1` 只读打开以
> 消除观测者效应。实测 WAL 630KB > 主库 155KB 后,该建议**是错的**——`immutable=1` 会
> 忽略 WAL,读到上一次 checkpoint 的陈旧状态(实测差 1 个会话)。现有适配器**没有**这样做。
>
> **另一处评审纠正(2026-09-11)**:本文初版据第 23 个会话断言「语料已恢复增长、spec 已过期」。
> 那个会话是用 WorkBuddy 分析 spec 自身产生的——由观测行为制造的会话不构成自然使用的证据。
> 这条直接影响 spec §7.4 / §12 对 Phase B 的排期判断,已改正。

## 3. 建议清单

### P0

#### P0-1 提供一个一致性只读快照通道(评审后:**实际优先级 P2**,编号保留以免交叉引用重排)

- **现状**:WAL 模式下,外部只读进程要么参与 `-shm`(有写入副作用风险),要么用
  `immutable=1`(静默丢 WAL,读到旧数据),要么复制三个文件(主机正在写,可能撕裂)。
- **建议**(任选其一,按推荐序):
  1. **定期 `VACUUM INTO '<path>/workbuddy-observe.db'`** 或 `sqlite3_backup` 产出一致
     快照,外部只读它;频率不必高(小时级即可,我们测的是历史不是秒级行情)。
  2. 提供一个稳定的只读副本路径(如 `~/.workbuddy/observe/workbuddy.db`),语义是
     「可能落后至多 N 分钟,但内部自洽」。
  3. 退化方案:暴露 `PRAGMA wal_checkpoint(PASSIVE)` 的可调用时机(不要求外部能调用,
     只要文档说明「何时 WAL 会回落」)。
- **为什么**:对**未来读法**的防御——任何人把打开方式改成 `immutable=1` 或改成裸拷
  主库文件,数字就会静默落后一个 checkpoint。**不是**当前缺口:现有适配器
  (`SQLITE_OPEN_READ_ONLY` / `mode=ro`)已参与 WAL,实测读到全部 23 个会话。
  初版此处写「差分会偶发 flaky」是错的——差分门禁读 tempdir fixture,从不碰活库。
- **若不做**(这才是当前该做的):适配器输出加 `source_snapshot`(`journal_mode` /
  `db_bytes` / `wal_bytes`,**不含 mtime**——fixture 上非确定会破坏逐字节差分),把
  「读到的是时点快照」显式化;并在代码注释里钉死「别改成 immutable、别裸拷」。
- **验收**:同一份语料连续两次 `workbuddy-session --list` 输出逐字节一致。

#### P0-2 给 `schema_version`,让漂移可声明

- **现状**:`.workbuddy-sqlite-migrations/` 有 10 个迁移,`sessions` 表依次被加上
  `plugin_context_json` / `addon_selection` / `session_settings` / `context_window` /
  `thought_level` / `last_user_prompt_expert_selection` 等列。**加列是对的**,但外部
  观测者的现有纪律只覆盖「缺列报 Unavailable」(见 `WORKBUDDY_INTEGRATION` §2.1),
  **不覆盖「多列」**——而多列恰恰是漂移信号,现在会静默通过。
- **建议**:
  1. 暴露一个 `schema_version`(整数或 ISO 日期串即可,可放在 `migration_meta` 表或
     一个 `~/.workbuddy/schema.json`)。
  2. 若愿意更进一步:给出**列清单契约**(哪些列是 stable / beta / internal)。
- **为什么**:有了版本号,我们就能把「未知列」写进哨兵、按版本降级,而不是在每次
  WorkBuddy 升级后靠人工发现门禁开始报错。这正是 `WORKBUDDY_INTEGRATION` §2.2 词表
  漂移事故的同类教训——那次的结论是「哨兵没漏,白名单错了」。
- **若不做**:适配器自加**双向哨兵**:未知列进 `attempts` 并在 notes 里报
  `schema-drift: unknown columns N`。版本号报 `<unknown>`,不做任何版本推断。
- **验收**:新增一列后,适配器输出里出现 `schema-drift` note 而非静默通过。

#### P0-3 公开会话生命周期字段的语义与词表

- **现状**:`status` / `source_mode` / `is_playground` / `deleted_at` /
  `last_activity_at` / `is_background_automation` 六列**已在库里**,但语义与取值词表不公开。
  适配器现在把它们一律忽略,等于**把所有会话一视同仁地塞进分母**。
- **建议**:文档化这六列的取值域与语义,尤其是:
  - `status`(completed / terminated / working)—— terminated 与 completed 现在混算;
  - `is_playground` —— 游乐场会话不承载真实任务,不该进任何成本/浪费分母;
  - `deleted_at` —— 软删语义(当前 0 行),我们需要知道它是否可回收;
  - `is_background_automation` —— 见 P1-4。
- **为什么**:这是**文档化 6 列语义就能消除一整类分母污染**的低成本高收益项——
  不需要改任何列,只需要说清取值域。
- **若不做**:适配器只能按字面值过滤(如排除 `is_playground=1`),并在 notes 标注
  「语义未经执行环境声明,过滤基于字面值」。**不做任何基于列名的推断**。

### P1

#### P1-1 逐请求用量(四桶 token + credit)—— **2026-09-12 改写(E6:已解决,只剩契约声明)**

- **现状(2026-09-12,spec Phase E 已落地)**:traces 的 generation span **有逐请求四桶
  usage**(每 span 恰 1 条 OpenAI 兼容 usage,5,067/5,067)。E4a/E4b 已接入——
  `cost.processed_tokens` = 该会话 traces 四桶之和,§7.2 路径 1 已开(统一会话面里有
  真四桶,不再「恒 0 沉底」);`session_usage.used` 是**最后一次调用上下文快照**不是
  使用量(§9E.1)。原先「§9 判不可拆四桶」的判定已随 E phase 作废。
- **剩余问题**:`usage`/`model` 字段未被执行环境**声明为契约**——若漂移只会表现为
  decode_failures/attempts 上升,而不是「执行环境改了什么」。
- **建议(改写)**:向执行环境**显式声明 `toolOutput[i].usage` 与 `toolOutput[i].model`
  是契约**,形状 = OpenAI 兼容 {prompt_tokens, cached_tokens, completion_tokens,
  …details} + 逐调用 model 串;不承诺稳就提供一个 `schema_version`。我们已实测两字段
  均真实,只差一句稳定承诺。
- **若不做**:维持现状(processed_tokens 假设「今日形状即契约」,漂移当月表现为
  decode 失败/attempts 上升),名义栏口径见 `ONBOARDING_SPEC` §5.2。

#### P1-2 请求级路由/归属证据(评审后:**实际优先级 P0**,唯一一把同时解三个问题的钥匙)

- **现状**:`sessions.model` 是字符串,前缀可粗分(`custom-local:` = 自配/第三方;
  `hy3` / `hy4-preview-f` = 平台内置),但**前缀是实现细节,不是契约**。
  实测同一模型(`MiniMax-M3`)有的会话记积分有的不记——轨道是**请求级**的,而会话表不记路由。
- **后果**:`ONBOARDING_SPEC` §2.1 因此判定零积分成因**不可分辨**(自配路由 / 限免促销 /
  执行环境未记账三者),并把成因归用户声明——这是正确的保守设计,但代价是 46.5% 的 token
  落在 `unpriced` 里,名义单位成本的分母被永久分裂。
- **建议**:在请求级(或至少会话级)落一个 `route` / `billing_source` 标记,取值如
  `platform-credits` / `self-configured` / `promotional`。**不需要暴露 endpoint**,
  一个枚举值即可。
- **为什么排 P0**:`ONBOARDING_SPEC` §2.1 把成因归「用户声明」是退而求其次——
  **执行环境声明比用户声明好一个量级**(执行环境知道,用户只是记得)。这一条要到了,
  §2.1 / §5.1.2 / §8.0 一半的保守设计都可以松绑;要不到,它们必须留着。
- **若不做**:维持「两态 + 成因归用户声明」;`models.json` 的路由线索只作**诊断提示**
  显示,不进任何判定(按 `ONBOARDING_SPEC` §11 规则 16:语料偶然不配写成规则)。

#### P1-3 配额分母(allowance / 余额 / 周期)

- **现状**:分子可测(`credit_json` 求和),**分母不可观测**——`sessions` 表 30 列无余额
  字段,余额在服务端账户面。
- **后果**:`QuotaConsumption` 只能是「分子 measured / 分母 unavailable」——这是 Coverage
  三态存在的意义,**不是缺陷**;但展示上只能报绝对量(如 `3,514 credit`),不能出百分比。
- **建议**:若用户已订阅,把当期 allowance 与周期起止**落在本机可读处**(一个 JSON 即可)。
  **不要**为了这个去暴露账户面余额——那超出本机观测边界(§4)。
  **与 §4.2 的边界画在这里**:allowance 是**计划参数**(订阅时就定了、周期内不变),
  余额是**实时状态**(每次请求都变)。前者的本地镜像是合理的,后者给了也只会失真。
- **若不做**:维持「allowance 未声明 → 只报绝对量,不出百分比」,并且展示时**三栏同屏**
  (积分配额 token / 未计入积分 token / 合计),避免单显绝对量造成「已看到全部用量」的错觉
  (`ONBOARDING_SPEC` §8.1 已规定)。

#### P1-4 自动化运行的会话级证据

- **现状**:`automations` / `automation_runs` / `automation_runtime_state` /
  `automation_delivery_outbox` 四表已存在(当前 0 行),`sessions.is_background_automation`
  列已存在。`automation_runs` 有 `result_success` / `runs_json` / `source_cwd` / `thread_id`。
- **为什么重要**:「无人值守运行」是 agent-vitals 目前对**任何执行环境都未建模**的一类信号,
  而它恰恰是可归因浪费最集中之处(定时跑空、重复执行、静默失败无人看)。
- **建议**:`automation_runs` 稳定关联到 `sessionId`(现有 `thread_id` 看起来是这个角色,
  但语义未声明),使「一次定时触发 → 消耗多少 → 是否成功」可闭环。
- **若不做**:agent-vitals 侧按 `WORKBUDDY_ONBOARDING_SPEC` §5.0 的纪律,把
  `AutomationRuns` 建成**执行环境中立**的 timeline signal,WorkBuddy 作为第一个实例;
  数据为空时三态报 `unavailable`,**不报 measured-zero**(未启用 ≠ 零次运行)。

### P2

#### P2-1 audit-log 轮转改为声明式

- **现状**:`WORKBUDDY_INTEGRATION` §2.3 靠「首条 `prevHash` 匹配不到任何记录」**推断**
  轮转(实测 `5018bac6` 从 seq=1268 起),并标注 `verified_from`。
- **建议**:`audit-log/manifest.jsonl`(已存在)+ `spool/` + `state.json` 若已承载分段清单,
  请声明其语义——让「链从哪一段开始有效」变成**读出来的**,不是**猜出来的**。
- **若不做**:维持结构校验 + `verified_from` note(现有实现已诚实,只是精度低)。

#### P2-2 区分预热/心跳会话与真实会话

- **现状**:`~/.workbuddy/sessions/*.json` 里 `kind` 有 `interactive` 与 **`prewarm`**
  (预热池,`cwd=/`,无用户意图)。这类会话若落进统计,会稀释一切人均/会话均值指标。
- **建议**:给预热会话一个稳定的可识别标记(库内列或 `kind` 值的公开词表)。
- **若不做**:适配器对 `cwd=/` 且 `model` 为空的会话记 `attempts`,不进分母。

#### P2-3 对 traces:声明 `trace.sessionId` 与 `Agent workflow` 的语义(评审后**改写**)

- **现状(2026-09-11 纠正)**:本文初版据 09-02 结论把 traces 当作「会话匿名」,要求 WorkBuddy
  「在 span 上落 `sessionId`」。**验收复测推翻了前提**:trace 包装对象**已有**结构化
  `sessionId` 字段——354/675 非空、100% 匹配 `sessions.id`、覆盖 22/23 会话、自 2026-07
  起就有(`RUNTIME_EVIDENCE_CONTRACT.md:747` 的 schema 例子里本来就写着)。09-02 的分析
  在 prompt 文本里扫 UUID,从未读这个字段。其余 321 个 trace 都是 `name='Agent workflow'`、
  **无** `sessionId` 键、`metadata:{}`、`totalTokens: 0`——**E5 纠正**:`Agent workflow`
  是 span name 不是 trace 类;`totalTokens` 302/675 为 0 而 span 有 usage,不可信;这些
  未归属 trace 的 generation span 有**真实 usage**(E4a 实测 1,202 个逐 span 落到
  unattributed,发 fact 前被拦)。
- **建议**(改为声明语义,不再要新字段):
  1. `trace.sessionId` 是**契约**还是**实现细节**?我们要按它 join,需要它稳定。
  2. `Agent workflow` 这些 trace 的语义:它**不该**有 sessionId,还是**应该有但缺失**?
     注意它们不是「单独一类,0 token」(E5:`name` 是标题不是类、`totalTokens` 不可信、
     有真实 usage)——答案决定我们是否仍该收 unattributed。
  3. span 级是否也会落 `sessionId`——非必需(包装层够用),但若有则可校验一致性。
- **若不做**:按现状接入——`trace.sessionId` 非空即归属(**字符串相等,不猜不推断**),
  `Agent workflow` 类进 attempts 并单列计数,语义标「执行环境未声明」。这条已从「结构性不可接」
  改判为「可接,归属键已知」,是 `ONBOARDING_SPEC` Phase E 的立项依据。


## 4. 我们明确**不**要的(同样重要)

1. **不要价目表**。WorkBuddy 的积分兑换价不是模型价卡;我们明确规定「不长第四份价格拷贝」
   (`ONBOARDING_SPEC` §4.2 规则 3)。成本归成本,价目归价目。**逐模型积分系数**
   (M2.5 0.18 / M3 0.25 …)同样属于价目——我们只报实测 `credit / token`,不要官方系数表,
   也不与之对账(`ONBOARDING_SPEC` §5.0 末段)。这不是漏了,是有意不要。
2. **不要账户面余额/账单**。本机观测边界止于「这台机器上发生了什么」。余额在服务端,
   给了我们也只会被当成本地快照而失真。
3. **不要 prompt 正文或对话内容**。我们要的是**结构证据**(有多少次、什么类型、何时、
   归谁),不是内容。「归谁」由 `trace.sessionId` 结构化给出(P2-3),**不需要也不会**读 span 里的 prompt 正文来推断——初版此处写「traces 目前匿名,这是好事」,把会话匿名与内容匿名混为一谈,两者都不成立(traces 既可归属、也含 prompt 文本),已改正。
4. **不要内部算法细节**(`commandHash` 如何计算、hash 链算法等)。我们只需要
   `prevHash == hash[i]` 的**字符串相等**结构校验,不重算、不验证算法。
5. **不要承诺「API 永不变」**。给版本号即可(§3 P0-2);承诺做不到的一致性比版本号有害。

## 5. agent-vitals 侧的反向承诺

本文的每一条诉求都对应我们自己的一条约束:

1. **只读,永不写回** `~/.workbuddy/`;不创建、不修改、不删除任何执行环境文件。
2. **缺列报缺、多列报哨兵、绝不猜**:未识别的字段进 `attempts` 与 notes,不静默丢弃,
   也不按名字推断语义。
3. **三态不冒充**:`measured` / `unavailable` / `measured-zero` 三态严格区分——
   「没测到」与「测到是零」是两件事,后者必须有证据。
4. **不发明不存在的边界**:无 turn 结构就不填 turn(§8 的 `TurnBoundaries` 只报 derived
   下界);无逐请求 token 就不拆四桶。
5. **失效即降级,不崩**:任一面不可读,该信号降级 Unavailable 并在 `data-status` 可见。
6. **语料偶然不写进规则**:本机观测到的模型名、比例、促销期,一律进哨兵与展示,
   不进判定分支(`ONBOARDING_SPEC` §11 规则 16)。

## 6. 证伪测试(每条建议定稿后逐条问)

任一条答「会报假话」,该建议即为拟核,应撤回或改形:

1. 若 WorkBuddy **0 个会话**,我们的输出是 `Unavailable` 还是 `0`?(应为前者)
2. 若用户换到**另一个套餐档位**,配额展示是否只报绝对量、不出百分比?
3. 若 WorkBuddy **升级加了 5 列**,适配器是报 `schema-drift` 还是静默通过?
4. 若 WAL 未回落,我们读到的快照是否**自带时点标注**、且不被当作当前真相?
5. 若 `automations` 表**有数据了**,`AutomationRuns` 是自动可用,还是需要新规则?

## 7. 落地状态

**agent-vitals 侧动作项**(本文之外的实现工作,均属增量、不动 core、不动差分契约):

| # | 动作 | 依赖 | 状态 |
|---|---|---|---|
| 1 | 双向 schema 哨兵(未知列进 `attempts`) | 无 | 见 spec §10 B4 |
| 2 | 会话生命周期字段**浮出**(不过滤——语义未声明,过滤是消费方的事) | 无(浮出不依赖答复;过滤才依赖) | 见 spec §10 B5 |
| 3 | 读取快照时点标注(`source_snapshot` 键) | **无**(评审:不依赖任何答复) | 见 spec §10 B3 |
| 4 | `AutomationRuns` 执行环境中立 signal | P1-4 答复 **+ 至少一行数据** | **明确不做**(spec §10:为 0 行表建跨执行环境 Signal 违反 §11 规则 16) |
| 5 | traces 改判「**可接**,归属键 `trace.sessionId`」并写入文档;traces 适配器立项 | 无 | 见 spec §10 B2 / Phase E |
| 6 | 校正本文档 §2 记录的错误建议(`immutable=1`) | 无 | 已在本版订正 |

**WorkBuddy 侧**:本文 §3 的十条为诉求,**无一条为阻塞**——被拒绝的代价已在各条的
「若不做」里写明,均为可见降级,不是隐式错误。
