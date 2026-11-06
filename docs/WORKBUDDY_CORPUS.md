# WorkBuddy 会话语料快照(实测)

> 采集日期:2026-09-02;**快照时刻 2026-09-02(+08)**,下文所有计数为该时刻。
> 源:本地 `~/.workbuddy`(`workbuddy.db` 的 sessions/session_usage 表 + `audit-log/*.jsonl`
> 决策账本 + `file-history/` 版本快照)。
> 观测单位 = 会话(DB 行);行为证据单位 = audit-log 记录。**所有数字是聚合,不含任何
> 原始行、路径、URL、命令、会话标识。**
>
> 关联:[COST_BASELINE.md](./COST_BASELINE.md)(Codex/DSH 基线方法与语料期纪律)·
> [CLAUDE_CODE_CORPUS.md](./CLAUDE_CODE_CORPUS.md)(Claude Code 语料,同法不同源)·
> [WORKBUDDY_INTEGRATION.md](./WORKBUDDY_INTEGRATION.md)(接入规格,本语料的事故记录见 §5)。
>
> **用前必读**:WorkBuddy 的成本是 **harness-billed**——`session_usage.credit_json` 是执行环境
> 自己记的**积分(credit)账单**,单位是积分(2026-09-02 用户纠正:WorkBuddy 是积分制;
> 量级亦证——单请求中位 22 credit,若是 ¥ 则 ¥22/请求,价目表上不成立)。**官方汇率公开**
> (WorkBuddy 是腾讯生态产品,与 CodeBuddy 同账号积分共享):1,000 积分 = ¥50(加量包价,
> 2026-07-01 起;此前 ¥38)→ **1 credit ≈ ¥0.05**。¥ 等值按此汇率标注,**basis=公开定价
> 非账单**;且用户积分来自官方套餐/活动发放**无实付 → 现金口径 ¥0**,¥ 金额只是机会
> 成本感知层(§4 双口径)。本机数据面无余额/订阅字段。本语料的钱**不并入** COST_BASELINE
> 主表(与 Claude Code 语料同因:执行环境计费语义与 catalog-provider 估算不可比)。
> 语料是**活账本**:audit-log 持续追加 + 按日轮转,重跑任何数字都会漂;以本快照为准。

## 1. 语料声明

| 项 | 值 |
|---|---|
| 源 | `~/.workbuddy`(sqlite db + audit-log 决策账本 + file-history) |
| 会话数 | 22(DB `sessions` 行;每会话一个逻辑审计面) |
| audit-log 记录数 | 2,563(事件 2,546 + 轮转段标记 17) |
| 语料期 | 创建 2026-07-29 → 2026-08-22,最后活动至 2026-08-23(+08,取自 DB 行) |
| 会话↔审计 join | 21/22(1 个会话无审计记录;audit-log 另有 3 条命令记录属会话面外,join 不上任何 DB 会话) |
| 成本 basis | **harness-billed(credit_json 执行环境积分账单,单位=credit,非 ¥)**;22/22 会话 `harness_billed=true`;**双轨供给**:平台积分制 + 用户自配独立 API(§4) |
| CLI date_span | **全 None**——适配器已知缺口,见 §6 |

## 2. 结构事实(audit-log 词表,真机核实)

**词表 = (category, eventType) 二元组**,category 是决策轴、eventType 是轴内路径。全部
2,546 条事件记录经两个字段分类,无一条落入未知哨兵(§5 修复的直接结果):

| category | eventType | decision | 条数 | 进证据轴 |
|---|---|---|---|---|
| `command-safety` | `command-safety.sandbox-executed` | allowed | 2,391 | tool_calls + sandbox |
| `network` | `WebFetch` | allowed / failed | 72 / 3 | tool_calls + network |
| `file-safety` | `file-safety.bulk-delete.needs-approval` | info | 34 | approvals |
| `file-safety` | `file-safety.bulk-delete.approved` | approved | 28 | approvals |
| `file-safety` | `file-safety.bulk-delete.rejected` | rejected | 6 | approvals |
| `approval` | `Bash` | approved | 1 | approvals |
| `rejection` | `Bash` | rejected | 11 | approvals |
| —(段标记) | —(无 eventType) | — | 17 | 不计数(§5) |

- **hash 链完整性**:2,501/2,523 链节连续 = **99.1%**;10 个会话存在断链,11 个会话带
  轮转标注(最老记录 `prevHash` 无前驱,核实起点后移——轮转是账本操作,诚实标注,
  不当作损坏)。16 条缺 hash/prevHash 的记录跳过(段标记,不参与链验证)。
- **审批双计纪律**:approval/rejection 只进 approvals 轴;`sandbox-executed` 同时进
  tool_calls + sandbox 轴(一次命令,两轴各一条 entry,ordinal 按 entry 递增,见
  `tests/test_timeline_ordinals.py`)。
- **TurnBoundaries**:319 全部 derived(按不同 requestId 计数),无 measured——审计记录
  没有原生 turn 概念,这是 WorkBuddy 侧的结构事实,不是缺失。
- **file-history**:16 个会话目录 / 730 个版本快照(FileMutations measured=730,一次
  快照 = 一次 mutation 计数)。
- **权限面**:`bypassPermissions` 19 / `fullAccess` 3;`use_sandbox_cli` 恒 1(命令审计
  是 sandbox CLI 写的,`sandbox-executed` 记录即命令执行的镜像)。
- **credit_json**:100 条请求级**积分**计价(值域 0.26~365.06 credit,中位 22.06)/ 11 个
  会话;11 个会话无 credit:6 个自配轨 deepseek(正确账务)+ 5 个平台轨会话未走积分(§4)。

## 3. 行为发现(规则层,修复后)

findings **171** 条:critical **47** / warning **44** / info **80**。全部来自证据轴的
真实记录——修复前(§5)这条管道在真机上只产出了 1 条。

| 规则 | 计数 | severity | 语义(命中来源) |
|---|---|---|---|
| SV601 | 47 | critical | 破坏性命令 `rm -rf` 类,出现在 **9/22** 会话 |
| SV609 | 80 | info | 审批被问 = 68 条 bulk-delete 决策 + 12 条 approval/rejection,**与审批轴计数逐条对账** |
| SV610 | 29 | warning | 审批放行(allowed-once)= 28 条 bulk-delete.approved + 1 条 approval ✓ |
| SV614 | 11 | warning | 拒绝 = rejection 轴 11 条 ✓ |
| SV606 | 1 | warning | 内网/裸 IP 外联(web_fetch 目标,地址不展示) |
| SV611 | 3 | warning | 重复工具调用检测(同命令多次执行) |

三态分布(每规则 22 会话满额):

| 规则 | measured_zero | unavailable | findings 会话 |
|---|---|---|---|
| SV601(破坏性命令) | 12 | 1 | **9** |
| SV602(提权) | 21 | 1 | 0(普查:sudo / chmod 777 / chown 全零命中) |
| SV603(远程执行) | 21 | 1 | 0(普查:curl\|sh 全零命中) |
| SV606(内网外联) | 20 | 1 | 1 |
| SV609(审批被问) | 5 | 16 | 1+ |
| SV610(审批放行) | 16 | 1 | 5 |
| SV611(重复调用) | 19 | 1 | 2 |
| SV614(审批拒绝) | 18 | 1 | 3 |
| SV604/605/607/608/612/613 | 0 | 22 | 0 |

- **SV602/603/604/605/607/608 的 unavailable/measured_zero 是诚实的**:审计记录里
  不存在 sudo/curl|sh/敏感文件写/绝对路径写/exit 码——Codex 侧的这些维度在 WorkBuddy
  词表里没有对应物,报零比编造强。
- **命令形态普查**(全量 audit-log,带空格形态):`rm -rf /` **15**、`rm -rf` 非根 **29**、
  `pip install` 18、`npm install` 8、`sudo` 0、`curl|sh` 0、`chmod 777` 0、`git push` 0。
  SV601 检出 47 vs 普查 44 是**口径差**(检测器按词边界 `\brm\s+-[a-z]*r[a-z]*f[a-z]*\b`
  匹配,不要求尾随空格;普查只数带空格形态),两口径都列、不合并。
- **WebFetch**:75 条 / 15 个不同 harness;top-1 harness 占 44/75(59%),top-3 占 83%——请求
  集中于财经数据类站点(按 harness 语义聚合,不点名域名)。3 条 failed(失败不占可用计数)。

## 4. 成本(harness-billed:credit_json 是执行环境自己的积分账单,单位=credit,非 ¥)

**合计 4,307.76 credit / 2,071,123 tokens**。积分是执行环境记的,不是我们按价目表算的——
**执行环境记了 0 的会话,我们报 0,不编价**。积分↔¥ 本机数据面无信号,官方公开汇率
(1,000 积分 = ¥50,§6 标注 basis)**只在机会成本口径下换算**——现金口径 ¥0,
¥ 金额不冒充账单;credit 仍作执行环境内部相对成本结构的主单位。

**双轨供给(2026-09-02 用户确认 + 网络核实)**:WorkBuddy 是腾讯生态产品(与 CodeBuddy
同一账号、积分共享),同时支持**平台积分制**(平台代调模型、消耗积分)与**用户自配独立
API**(models.json 每模型带用户 key + 端点;市面有第三方中转冒充「自定义模型」的玩法,
调用费用在第三方账户、积分账本不记)。积分账本(credit_json)只记平台积分轨;自配轨的
调用费用在用户自己的 API 账户,积分账本本就不记。数据面观察(端点 ↔ 记账,
**是相关性不是按模型的固定规则**):

**官方汇率(公开定价,非本机数据)**:**1,000 积分 = ¥50**(2026-07-01 起加量包价;此前
¥38/1,000)→ **1 credit ≈ ¥0.05(旧 ¥0.038)**。交叉验证:flash 会话 3.85 credit ≈ ¥0.19,
63,729 tokens → ¥3.0/M,落在官方 deepseek 价(¥1.5~9/M)区间内。**积分系数制**(官方
机制):积分消耗 = 模型系数 × token × 任务复杂度(M2.5 0.18、M3 0.25、DeepSeek V3.2
0.30、GLM-5.2 1.06)——这解释了本语料「无单一 tokens↔credit 汇率」:跨会话/跨模型的
credit/M 漂移(60~13,000)是系数 + 缓存命中 + 复杂度差异,不是账本错误。

**统计口径(2026-09-02 用户确认:积分来自官方套餐/活动发放,无实际付费)**——双口径,
沿用 Claude Code 语料的订阅纪律(套餐/赠送积分没有边际账单,摊销只作感知层):

| 口径 | 值 | basis |
|---|---|---|
| **现金(cash)** | **¥0** | user-reported:未实付,语料内无现金流出;**不冒充已花钱** |
| **机会成本(感知层)** | **¥215.39**(4,307.76 × ¥0.05;旧价口径 ¥163.7) | 官方加量包价——「若这些积分需充值购买」的价值,不是账单,不作真实财务 |

- 官方规则:套餐积分**当月有效、不累积结转**;语料月用量 4,308 credit ≈ 标准版月配额
  4,000(¥99/月,连续包月 ¥70)——若用量常态贴近配额,**套餐费是「基础设施成本」,不按
  积分摊销**(摊了会双重计费);超配额部分才以加量包价计边际。
- 每会话中位 0.65 credit(现金口径 ¥0;机会成本 ¥0.03);top-1 会话 1,763.88 credit
  (机会成本 ¥88)。

| 模型(DB `model` 字段,真值) | 会话 | credit | tokens | 注 |
|---|---:|---:|---:|---|
| `auto`(执行环境路由) | 4 | 2,823.36 | 348,752 | 65% 积分 / 17% tokens;平台内置 |
| `custom-local:MiniMax-M3` | 5 | 1,030.81 | 646,906 | 官方端点 api.minimaxi.com;5 会话中 **3 个**有 credit(混用,见下) |
| `hy3` | 4 | 448.44 | 294,043 | 平台内置(不在 models.json) |
| `deepseek-v4-flash` | 1 | 3.85 | 63,729 | 平台内置 |
| `custom-local:MiniMax-M2.5` | 2 | 1.30 | 39,874 | 官方端点;2 会话中 1 个有 credit |
| `custom-local:deepseek/deepseek-v4-flash` | 6 | **0.00** | **677,819** | **自配轨**:models.json vendor=Custom + 用户 key,端点 shengsuanyun.com 自配网关——费用走用户自己的 API 账户,积分账本本就不记;0 是正确账务,不是缺口 |

> **custom-local: 前缀 = models.json 本地条目,不代表轨道**:M3/M2.5 带前缀但记积分;
> deepseek 自配网关不记。轨道是**会话/请求级**的:16 个平台轨会话中 5 个无 credit
> (未走积分),同模型跨会话混用存在——本机数据面无法区分「切了自配 key」与「平台未计费」,
> 只报账本事实。

- **每会话成本**:min 0 / p25 0 / **中位 0.65 credit** / p75 132.84 / max 1,763.88;11 个
  有 credit 的会话之外成本全为 0。
- **每会话 tokens**:min 0(无审计记录会话)/ **中位 78,162** / max 218,256。
- **集中度**:top-1 会话占 41%,top-3 占 78%,top-5 占 92%——**长尾主导**,与
  Codex/DSH/CC 三语料同构(COST_BASELINE §3)。
- **credit/M tokens**:总体 2,079.9(被 auto 会话拉高);每会话中位 16.3——auto 会话的
  credit/M 远高于非 auto,是观察,不做因果(执行环境路由语义不在审计面内)。
- **单位**:credit 为主;¥ 等值仅按**官方加量包汇率**(1,000 积分 = ¥50,2026-07-01 起)
  标注(basis=公开定价,非账单),与 COST_BASELINE 的 USD 行不相加。

## 5. 词表漂移事故(2026-09-02 真机核实 + 修复,一等发现)

本次语料分析本身就是一次**适配器缺陷现场**:已提交的 WorkBuddy evidence
(`KNOWN_EVENT_TYPES`)用的是**纸面词表**('sandbox-executed'/'commandApproved'/
'commandRejected' 裸名),真机词表是 §2 的 (category, eventType) 二元组。后果:

- **2,471/2,563 条真实记录被当作 unknown 丢弃**(ToolCalls 只剩 WebFetch 的 75 条);
  21/22 会话的 attempts 哨兵诚实记录了丢弃——**哨兵没错,错在白名单本身**。
- 差分门禁**两侧同错互证**:fixture 固化了相同的纸面词,Python 与 Rust 都"通过"了
  golden——fixture 是「真机形状」的代理,写错词就是让门禁测错东西。
- 修复:白名单改为 (category, eventType) 对;`build_workbuddy_fixture.py` 与
  `tests/test_regressions.py::TestWorkbuddyEvidenceVocabularyIsTheRealMachineVocabulary`
  钉死真机词表 + 哨兵行为。
- 修复后对账:CLI ToolCalls **2,463** = audit-log bash 2,388 + web 75,逐会话 0 不一致;
  ApprovalDecisions **80** = 审计 80;unknown 哨兵清零;attempts = 22 个 traces-only
  (§14.4 跳过)。**勘误 2026-09-11**:此处「traces 会话匿名、无 sessionId join 锚点」
  **是错的**——trace 包装对象有结构化 `sessionId` 字段(354/675 非空、100% 匹配
  `sessions.id`、覆盖 22/23 会话、自 2026-07 起就有);09-02 的分析在 prompt 文本里扫
  UUID 而从未读该字段。详见 `WORKBUDDY_INTEGRATION.md` §12.2。attempts 计数本身仍然
  诚实——它记的是「现有实现没接」,不是「不可接」。**勘误 2026-09-12(Phase E 落地)**:
  未归属 trace 不是「另一类 0 token 的编排」——`name='Agent workflow'` 是标题不是类;
  `totalTokens` 302/675 为 0 而 span 有 usage,不可信;它们的 generation span 有真实
  用量(E4a 实测 1,202 个逐 span 落 unattributed)。`session_usage.used` = 最后一次调用
  上下文快照,不是使用量(§9E.1)——真实处理量在 traces(usage_facts / cost.processed_tokens)。
- 17 条轮转段标记记录(entryCount/event/firstHash/lastHash/fileSha256,无 category/
  eventType)是**账本元数据不是事件**:不计数、不误报、参与 hash 链轮转语义。

## 6. 诚实性注记

- **积分是执行环境账单,不是估算**:basis=credit_json(平台积分轨);6 会话 / 678K tokens 报
  0.00 credit 与**自配轨**自洽(端点 shengsuanyun.com 自配网关,费用在用户自己的 API
  账户,积分账本本就不记;官方端点与平台内置模型记积分)。但这是**端点相关性,不是按
  模型的固定规则**:同模型跨会话混用存在(M3 5 会话中 3 个有 credit),轨道是会话/请求级,
  本机数据面不裁决「切了自配 key」与「平台未计费」的区别,只报账本事实。**积分↔¥ 无
  换算率**:官方公开定价 1,000 积分 = ¥50(加量包,2026-07-01 起;此前 ¥38),本机数据面
  无余额/订阅字段——汇率取官方公开价并标注 basis,不编本机没有的账单数字。**现金口径
  ¥0**(用户无实付,积分官方发放),¥ 数字一律是机会成本感知层,不冒充账单。
- **CLI date_span 全 None 是适配器缺口**:真机记录 `timestamp` 为 epoch-ms 整数,
  `date_span_of` 只认 ISO 字符串 → 解析不到就诚实报 None(缺列报缺,没有编造);
  本文档日期轴取自 DB `created_at`/`last_activity_at`。修复留待适配器后续工作包。
- **活账本,双向漂移**:audit-log 按日轮转 + 持续追加,10 会话断链、11 会话轮转标注;
  重跑数字会漂,以快照为准。G 节对账(CLI 2,463 vs 普查 bash 2,388)的差是口径
  (CLI 计 bash+web_fetch;普查只数 bash)加 3 条会话面外记录,均已归因。
- **未做因果推断**:auto 会话高 credit/M、断链会话、SV601 集中会话都是观察,不是执行环境优劣
  或记账问题的结论。
- **聚合纪律**:本文不含任何原始行、路径、URL、命令、会话标识;域名、命令形态均以
  聚合模式呈现。
