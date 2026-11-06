# Plan Review: Harness Manifest DSL Specification

**Plan File**: `docs/HARNESS_MANIFEST_DSL_SPEC.md`
**Reviewer**: Codex

---

## Round 1 — 2026-09-19

### Overall Assessment

方案对“账面开放、行为封闭”、坏插件隔离、计费保守降级和分期策略的方向判断是正确的，但 P0 的核心数据流与当前仓库契约存在三处阻断性错位：任意本地可执行文件没有能力沙箱，候选行无法映射为现行 `UsageFact`，且生产同步并非经 JSONL `FactWriter` 单喉咙进入 authority DB。若按现稿直接实施，会同时引入数据外传风险、事实无法入库或身份漂移，以及 JSONL/SQLite 不一致。

**Rating**: 4.5/10

### Issues

#### Issue 1 (Critical): 任意适配器执行违背“绝不上传用户数据”的受保护前提
**Location**: §1“插件不获得任何凭据”、§2 `adapter.py`、§6.7、§9.1

“本体不传凭据”并不限制子进程读取用户可访问的其他日志、钥匙串代理、环境变量或直接联网。以用户身份运行任意 executable，与 AGENTS.md 的“app never uploads user data”保证不相容；预览输入/输出不是能力约束，也无法发现条件性外传。

**Suggestion**: P0 必须二选一并写成验收条件：只支持进程内声明式 DSL；或引入可验证的 OS 沙箱，明确网络禁止、只读白名单文件、净化环境、工作目录、子进程树和平台支持矩阵。若 macOS 沙箱无法稳定实现，应把脚本模式定义为显式开发者模式，不得进入默认导入向导。

#### Issue 2 (Critical): 候选事实行与现行 `UsageFact` 契约不兼容
**Location**: §5、§9.2、附录 B.2；对照 `crates/agent-vitals-domain/src/contracts/usage_fact.rs`

现行 builder 要求 `machine_namespace`、`harness`、`source_profile`、`native_session_id`、`source_event_id`、`observation_kind` 六个身份输入，并由本体计算 `fact_id`；token 字段名是 `uncached_input_tokens`、`cache_read_tokens`、`cache_write_tokens`、`output_tokens`。规范却要求脚本提供 `fact_id`、`ts`、`event`、`input_tokens`、`cache_read`、`cache_write`，没有定义其到正式契约的完整映射，并与“fact_id 会被 builder 覆盖”直接冲突。

**Suggestion**: 删除脚本提供 `fact_id` 的权力，定义版本化 `CandidateUsageV1 -> UsageFact` 映射表、每个身份字段的来源、`identity_basis`、时间字段/时区、source revision、provider attribution 与空值语义。稳定性检查应针对本体生成的正式 `fact_id`。

#### Issue 3 (Critical): “JSONL 唯一喉咙后进入 authority DB”不符合当前生产写路径
**Location**: §2 架构图、§2“复用 FactWriter”、§7.4、P0 AC；对照 `ingest_service.rs` 结尾说明与 `sync_service/sql_sync`

当前同步先直接写 SQL authority，再追加 JSONL；`ingest_facts` 明确不负责 SQLite 投影。仅让插件通过 `FactWriter` 会留下 JSONL 而不会自然进入 `usage_facts`，所以“既有 harness-agnostic 下游零改动”无法成立。若另加插件专属 SQL 写入，又会产生第二条写路径和失败恢复语义。

**Suggestion**: 先确定唯一权威写入事务：插件也走现有 `write_flat_facts_to_authority` 加 JSONL 双写编排，或先完成所有执行环境统一的单喉咙重构。规范必须定义 authority 成功/JSONL 失败、重试、lease、checkpoint 和对账行为。

#### Issue 4 (High): “全部下游 harness-agnostic、零改动”是未经证实的强断言
**Location**: §2 架构图、§7.4、附录 C #13

仓库仍存在 harness 分发和封闭词表，例如 cost domain 的 harness dispatch、summary 的 `WIRED_HARNESSES`、source controls 的 `HARNESSES`，以及若干 MCP/导出呈现路径。SQL 接受自由文本不代表定价、状态、筛选、导出和 UI 都会正确收纳插件。

**Suggestion**: 把“零改动”改为逐消费面审计矩阵：ingest、authority、pricing、billing declarations、summary、source controls、retention、export、MCP、decision matrix、UI。每项列出 expected behavior、代码入口与契约测试。

#### Issue 5 (High): 计费锁只写了目标值，没定义落库字段和防覆盖优先级
**Location**: §1、§6.1-2、§7.3 runtime、P0 AC

规范没有说明 `billing_source`、`billing_mode`、`pricing_basis`、`evidence_basis`、`provider_id` 和 `has_unresolved` 分别如何落地；现行计费声明可以后处理事实，单写 `metered_estimate` 也未证明不会被 declaration 或 route attribution 覆盖。

**Suggestion**: 给出插件事实的完整计费字段矩阵与优先级，明确 active billing declarations 不得把 `plugin:%` 改成 subscription，并添加 SQL 级回归测试和 MCP 可见的 uncertainty reason。

#### Issue 6 (High): provenance 仅在批报告中记录，无法对单条历史事实追责
**Location**: §2、§6.3、§7.3

报告若未持久化并与 fact 建立稳定关联，之后无法回答某条历史事实来自哪个 manifest/adapter 版本；而现行 `UsageFact` 只有 `adapter_version` 等字段，没有规范这些 hash 存在哪里、如何导出、如何参与重放。

**Suggestion**: 定义持久化的 adapter revision 表和 fact-to-revision 外键/稳定 id，或把受控 revision id 写入正式事实字段；说明 retention、private/redacted export、MCP 投影与 source expired 时的行为。

#### Issue 7 (High): 超限“截断并继续”会产生不可恢复的部分文件语义
**Location**: §3.2 `max_rows_per_file`、§6.4、§8.4

适配器输出超过上限时保留前 N 行，看似成功但实际丢掉其余记录。若随后 checkpoint 将源文件视为已处理，遗漏永久化；若不推进 checkpoint，每轮又重复执行和告警。输出顺序变化还会改变被保留的集合。

**Suggestion**: 超限应整文件失败且不提交，或协议支持确定性分页/游标。规范 checkpoint 何时推进，以及超限、超时、部分 stdout、authority/JSONL 任一失败时的原子性。

#### Issue 8 (High): 子进程协议缺少资源和进程树约束
**Location**: §9.1

仅有 wall-clock timeout 与行数限制不足以控制无限 stderr/stdout、单行超大 JSON、内存、CPU、打开文件数以及适配器派生的孙进程；“击杀进程”也未定义是否杀整个 process group。

**Suggestion**: 增加 stdout/stderr 字节上限、单行上限、流式解析、CPU/内存/FD 限制、进程组取消、临时文件策略和错误分类，并为每类故障写验收测试。

#### Issue 9 (High): Manifest JSON Schema 没有实现正文宣称的互斥和封闭性
**Location**: §3.2、附录 A

当前 `oneOf` 两个分支都只写 `required`；同时包含 `adapter` 与 `records` 时两个分支均匹配，虽然会因 `oneOf` 失败而拒绝，但语义隐晦且未来扩展易破坏。根对象、`discovery`、`session`、`adapter`、`source`、`limits`、`billing` 多处没有 `additionalProperties: false`；`pattern` 也无法保证存在名为 `id` 的捕获组。

**Suggestion**: 用显式 `not`/互斥定义，所有 v1 对象默认封闭；运行时做目录名一致、保留字、具名组、命令 token、`$FILE` 恰好一次、P0 禁止 records 等语义校验，Schema 只负责结构层。

#### Issue 10 (High): Python/Rust “天然 parity”结论不成立
**Location**: §2 设计要点、§7.3 Python 对等、§8.1

两侧虽执行同一脚本，但 discovery glob、`~` 展开、文件排序、symlink、正则、RFC3339 解析、默认值、候选行映射、错误分类、超时与进程终止仍是两套实现。当前 golden runner 也不是无需概念变更就能表达外部 manifest、脚本和多文件 fixture。

**Suggestion**: 列出真正需要 parity 的本体行为并建立共享 fixture；优先让 Python 调用 Rust CLI/共享协议实现，若保留双实现则继续字节级差分，不得称“免费”。

#### Issue 11 (Medium): 正则语法和文件发现确定性未定义
**Location**: §3.2 session、附录 B.1、§7.2 mtime cache

示例使用 `(?<id>...)`，而 Python 标准库使用 `(?P<id>...)`；若 Rust/Python 本体各自解析会直接分歧。glob 对大小写、隐藏文件、symlink、重复 root、文件排序和路径规范化也无定义。仅按目录/manifest mtime 失效不能可靠发现脚本替换或某些原子更新。

**Suggestion**: 选定独立于语言的 regex 子集和规范化语法，定义发现结果按 canonical path 排序去重、symlink 策略、允许 roots 边界，并以内容 hash/revision 而非单纯 mtime 做缓存键。

#### Issue 12 (Medium): 适配器无法如实报告源记录 invalid
**Location**: §6.5、§8.4、§9.1-2、附录 B.2

喉咙只能校验脚本输出的行。示例对坏 JSON、缺 requestId、无 usage 全部只写 stderr 的 `skipped` 总数，本体无法区分正常非用量行和数据损坏，也无法生成 `HarnessIngestReport.invalid` 的分类样例，因此 dry-run 的“invalid 计数”承诺不可实现。

**Suggestion**: 协议改为带类型的消息流（`fact` / `skip` / `invalid` / `summary`），定义稳定错误码、可脱敏摘要和计数一致性校验；stderr 只用于诊断，不能承载机器契约。

#### Issue 13 (Medium): 安装、升级、禁用、卸载和转正生命周期缺失
**Location**: §6.5、§10 P1、§11.2/5

“validate 后可 ingest”没有安装状态或不可变 revision；直接替换目录会让正在运行的 ingest 遇到 TOCTOU，删除 manifest 后历史显示名/审计信息丢失，脚本改变 identity 还可能双计。转正策略被留作开放问题，但它会影响 P0 的 harness identity 是否可逆。

**Suggestion**: P0 即定义 revisioned install、原子激活、禁用、升级预览、回滚、卸载只停新读取不删历史，以及 `plugin:zcode` 到官方 harness 的永久 alias/migration 决策。

#### Issue 14 (Medium): P2 `records` 被 v1 Schema 接受，但 P0 明确不实现
**Location**: §3.2、§4-5、附录 A、§10

同一个 `manifest_version: 1` 在 P0 schema 中会接受 `records`，而运行时无解释器。调用方无法仅凭版本知道某 manifest 是否受支持，错误会从安装期推迟到执行期。

**Suggestion**: P0 的发布 Schema 只允许 `adapter`，P2 要么提升 manifest/capability 版本，要么显式声明 `engine` 与 capability negotiation；设计草案可以留在文档，但不能进入当前可接受 Schema。

#### Issue 15 (Medium): 时间、事件和数值边界不足以形成稳定协议
**Location**: §9.2

`ts` 只说 RFC3339，未规定必须带 offset、如何归一到毫秒、闰秒/超范围处理；`event` 只说“字面量”却没枚举；token 没有最大值与求和溢出策略。这些都会影响 Rust/Python 字节一致和 authority 聚合。

**Suggestion**: 定义候选协议 JSON Schema：允许事件枚举、UTC 归一化规则、整数范围（至少 i64 非负）、null/缺失区别、未知字段策略和 canonical serialization。

#### Issue 16 (Low): “不重启”与 registry/cache/正在运行同步的交互没有验收
**Location**: §0 判据、§7.2

mtime cache 没有说明扫描周期、线程安全、失败后保留旧 revision 还是移除、同步中切换 revision 的一致性，因此“不重启即可接入”尚不是可测试承诺。

**Suggestion**: 定义 registry snapshot 生命周期：单次 ingest 固定 revision，更新原子切换，新 revision 校验失败继续使用旧版并告警；增加运行中替换 manifest/adapter 的并发测试。

#### Issue 17 (Low): 默认展示“模型清单/脱敏样本”仍需 serving-face 分类
**Location**: §6.5、§10 P1

导入向导是本地 presentation face，可以读取原始日志；但报告若持久化、导出或经 data-mcp 暴露，就必须遵守“raw errors/arguments 不出 MCP”的政策。规范未区分临时本地预览与持久化审计报告。

**Suggestion**: 把预览分为仅内存本地 UI 的 private projection 与可持久化的 redacted report，明确后者禁止原始路径、记录文本、错误全文和 invocation arguments。

#### Issue 18 (Suggestion): P0 范围同时包含引擎、双实现、CLI、真实试点和下游呈现，交付面偏大
**Location**: §7.3、§10 P0

在身份契约和安全执行尚未定案时，同时承诺 Rust/Python 双实现和真实 rollout 会放大返工。

**Suggestion**: 增设 P-1 spike：只做静态 manifest 校验、受控 fixture 的 CandidateV1 映射和 dry-run，不写 authority；通过安全/契约评审后再进入 P0 持久化。

### Positive Aspects

- “账面可自助，行为须官方”是清晰且必要的产品边界。
- 明确不把缺失 token 当 0、插件统一走 `metered_estimate`，符合仓库的 billing honesty 原则。
- 坏 manifest 不拖死官方执行环境、版本不认识就拒绝、slug 前置校验，降级方向正确。
- 先用真实适配器积累模式、再提炼 DSL，避免过早设计语言。
- 对 ZCode 请求侧/汇总侧双计风险已有具体数据证据，试点选择有价值。

### Summary

修订优先级：

1. 先解决任意脚本执行与离线/不出网承诺的冲突，确定默认产品面是否允许脚本。
2. 定义 `CandidateUsageV1 -> UsageFact` 的完整、由本体生成身份的契约。
3. 按当前 authority-first 双写路径重画数据流，并逐项审计下游，而不是宣称零改动。

**Consensus Status**: NEEDS_REVISION

---

## Round 2 — 2026-09-19

### Overall Assessment

v0.3 已完成关键架构反转：P0 仅接受内置 recipe 和受限路径覆写，正式身份与
`fact_id` 回到本体 builder，持久化路径也改为复用现有 authority-first 双写。
三个 Critical 阻断项均已消除；剩余问题主要是 P-1 应产出的实证数据、精确算法
和迁移设计，不妨碍把本规格作为 feasibility spike 的输入。

**Rating**: 8.2/10

### Previous Round Tracking

| # | Issue | Status | Notes |
|---|---|---|---|
| 1 | 任意适配器违反离线保证 | Resolved | P0 不执行脚本；adapter 降为需能力沙箱的 P1.5 |
| 2 | Candidate 与 UsageFact 不兼容 | Resolved | §9.1-2 给出正式 DTO 和逐字段映射，fact_id 由 builder 生成 |
| 3 | JSONL 单喉咙不符合生产路径 | Resolved | 架构改为 authority-first + JSONL 双写并列失败恢复 AC |
| 4 | 下游零改动断言 | Resolved | 改为消费面审计矩阵，附录 C 补 source controls/双写 |
| 5 | 计费字段和防覆盖不清 | Resolved | §6/§9 明确 metered、estimate、normalizer 与 declaration 禁令 |
| 6 | provenance 仅在报告 | Resolved | 新增 revision 与 fact-revision 持久化关系 |
| 7 | 截断导致永久漏账 | Resolved | 超限整文件失败且不推进 checkpoint |
| 8 | 子进程资源约束 | Deferred safely | 不进 P0；P1.5 列出沙箱和资源门槛 |
| 9 | Schema 不封闭 | Resolved | P0-only、`additionalProperties:false`、recipe/event_key 明确 |
| 10 | 天然 parity 断言 | Resolved | 明确仍需双语言 fixtures/golden |
| 11 | regex/discovery 不确定 | Resolved | 共同正则子集、canonical path、排序去重、symlink 规则 |
| 12 | invalid 无法如实报告 | Resolved | recipe 三态；future adapter 使用 typed message stream |
| 13 | 生命周期缺失 | Partially resolved | revision 原子激活/坏版回退已写；卸载/禁用细节仍需 P1 契约 |
| 14 | P0 schema 接受未实现引擎 | Resolved | P0 schema 不含 records/adapter |
| 15 | 时间与数值边界 | Resolved | §9.1 明确 offset、UTC、i64、null/缺失 |
| 16 | registry 热更新不确定 | Resolved | content hash、snapshot、validate 后原子激活 |
| 17 | preview serving-face 不清 | Resolved | 本地 private preview 与 redacted 持久面分离 |
| 18 | P0 范围过大 | Resolved | 新增不写库的 P-1，推断 UI 后移 P1 |

### Issues

#### Issue 1 (Medium): 80% 验证语料的选择规则仍未定义
**Location**: §2、§10 P-1

不少于 10 个执行环境仍可能被选择偏差操纵。
**Suggestion**: P-1 预先定义纳入条件、版本、样本时间窗、脱敏方法，以及按执行环境数和有效 usage 行数两种分母。

#### Issue 2 (Medium): recipe discriminator 尚缺可执行定义
**Location**: §4.1、附录 B

规范规定 required/forbidden shape，但没有列首批 recipe 的具体 shape。
**Suggestion**: P-1 为每个 recipe 增加注册表条目，列事件类型、required/forbidden slots、skip/invalid code。

#### Issue 3 (Medium): `source_profile` 稳定算法未钉死
**Location**: §9.2

“discovery root 的稳定 profile id”仍不足以保证跨路径移动和双语言一致。
**Suggestion**: 定义输入字段、canonical encoding、hash 算法以及 root 重排是否改变身份。

#### Issue 4 (Medium): plugin revision 表尚缺迁移与重建契约
**Location**: §6.3、§7.3

关系模型已明确，但没有 DDL、唯一键、retention 和 authority rebuild 行为。
**Suggestion**: 实施计划中补 schema migration、级联策略、private/redacted export 与重建测试。

#### Issue 5 (Medium): 双写第二阶段失败仍依赖“既有语义”概括
**Location**: §2、§10 P0 AC

AC 正确，但实现前仍需明确 checkpoint 和返回状态机。
**Suggestion**: 为 SQL duplicate + JSONL missing、JSONL corrupt、进程 crash 三种状态写时序测试表。

#### Issue 6 (Low): recipe provider normalizer 的版本字段未列入映射
**Location**: §9.2

provider 归一化会影响 provider_id 与价格匹配。
**Suggestion**: 明确 `normalization_version`、`attribution_version` 和升级重处理策略。

#### Issue 7 (Low): 禁用/卸载对 source controls 的用户契约仍开放
**Location**: §10 P1、§11.1

历史事实保留已说明，但停止后续读取的具体入口未写。
**Suggestion**: P1 明确 disable 不删历史、uninstall 只移除 active revision、删除事实需独立确认。

#### Issue 8 (Low): 样本推断缺少最低置信度和歧义阈值
**Location**: §10 P1

“带置信度和歧义”还不能形成验收测试。
**Suggestion**: 定义多候选并列、零 emit、累计/增量无法判断时必须拒绝自动确认。

#### Issue 9 (Low): P3 目录分发缺少真实性保护
**Location**: §10 P3

纯数据 manifest 虽不执行代码，恶意路径配置仍可诱导读取不应扫描的位置。
**Suggestion**: P3 单独定义签名、允许 roots 模板、用户授权和版本撤销，不复用本地任意 roots 权限。

#### Issue 10 (Suggestion): 文件名仍以 DSL 为中心
**Location**: 文档标题/文件名

标题已改为 Recipe/DSL/Adapter，但文件名仍可能让读者误判 P0 主路径。
**Suggestion**: 为避免破坏现有引用可暂不改名；立项时决定是否迁移为 `HARNESS_MANIFEST_SPEC.md` 并保留链接。

### Positive Aspects

- 安全边界从“用户确认脚本”升级为 P0 结构性不执行代码。
- recipe 按 token 语义而非 snake/camel 拼写分类，避免字段相似但口径不同。
- `emit/skip/invalid`、format guard 和整文件失败消除了假空集与部分提交。
- 正式 identity、billing honesty、provenance 与 serving-face 政策均有明确落点。
- P-1/P0/P1/P1.5/P2 分期现在可以独立验收和止损。

### Summary

v0.3 已可进入 P-1 feasibility spike；尚不应跳过 P-1 直接承诺 P0 的 80% 覆盖。
下一步最重要的是固定真实语料选择、首批 recipe discriminator 和 source_profile
身份算法。

**Consensus Status**: MOSTLY_GOOD
