# Findings 2.0：本地 Agent 数据访问与出境审计规格

**状态：** Release-ready specification v2（2026-09-20）

**目标版本：** v1.0.0-beta.4
**适用范围：** P1 历史审计与 P2 低权限实时监测。实现只有满足第 12 节发布门槛，才可以对用户宣称该能力可用。

**产品定位：** 离线、只读、证据驱动的本地 Agent 信任审计。默认不拦截、不上传任何用户数据；不以“偷取”“训练”“转卖”等无法由本机证据证明的结论替代事实描述。

**关联文档：** [Agent 执行问题分类图谱](../AGENT_EXECUTION_PROBLEM_TAXONOMY.md)（第 7 层）与 [Findings 工作台规格](WORKBENCH_FINDINGS_TAB_SPEC.md)。本规格取代此前 Draft v1 中与当前实现、通知策略或发布门槛冲突的条款。

## 0. 已拍板的产品决策

Findings 2.0 增加一条新的证据平面：它不只分析 Agent 在工具轨迹中声明做过什么，也观察承载 Agent 的客户端、sidecar、插件和本地证据是否读取、打包、准备外发或发送了数据。

它必须遵守以下决策：

1. `TrustObservation` 是事实；`TrustIncident` 是同一行为链的时间窗聚合；`Finding` 是针对该行为链某一风险规则的判定。一次 Incident 可以关联 SV702、SV705、SV709 等多个 Finding，但用户默认看到的是一张行为链卡片，而非散乱告警。
2. 规则不按厂商分叉。执行环境 profile 只解决“在哪里取得何种本地证据”，不能成为安全判断本身。
3. `profiled`、`detected_unprofiled`、`not_detected` 是覆盖状态。未建档客户端不是风险 Finding，也不等同于安全；它必须在产品面显著显示为覆盖缺口。
4. P1 可独立发布历史审计；P2 必须默认关闭，并在能力受限时诚实显示 `partial` 或 `unavailable`。P2 不是 P1 的隐含前提。
5. 通知只由“新建或实质升级”的可通知 Finding 触发。E0/E1 永不发系统通知；一次普通刷新也绝不能重新通知。
6. 本产品不得采集文件内容、请求体、TLS 明文、凭据、完整命令行或原始路径；不得把任何 Trust 数据发送出设备。

## 1. 范围、术语与非目标

### 1.1 术语

| 名称 | 含义 |
|---|---|
| Observation | 可重复采集的单个事实，例如“检测到归档文件”“获得上传凭证”“已建立连接”。不单独作恶意结论。 |
| Evidence | Observation 的本地可复核来源、质量、采集器版本和安全锚点。 |
| Incident | 以关联键和时间窗聚合的行为链，保存阶段、计数、支持事实与缺失事实。不是新的用户可操作状态机。 |
| Finding | 对 Incident 应用一条 SV70x 规则的稳定判定，沿用 `issue_instances` 的状态与生命周期。 |
| Coverage | 已知检测面是否可用的陈述；不能被解释成“未发生外传”。 |

### 1.2 目标

1. 统一表达本地读取、打包、上传准备、外发尝试、字节发送和远端接受，且不夸大证据。
2. 支持 ZCode、MiniMax Code、导入执行环境和本地 profile；未知执行环境由通用传感器提供有限、如实的覆盖。
3. 将可关联的多条 observation 变为可复核的时间线和稳定 Finding，而非逐行报警。
4. 使用户能区分“未发现行为”“未支持该规则”“监测不可用”三种不同结论。
5. 允许用户暂停监测、忽略特定规则，并在不读取源码或网络正文的前提下获得处置建议。

### 1.3 非目标

- 不做 TLS 中间人、根证书安装、正文解密、进程/网络/文件阻断。
- 不将对象存储、未知域名或某个厂商名称单独视为恶意。
- 不从客户端证据推断云端训练、人工访问、出售、删除或长期留存。
- 不将 `detected_unprofiled` 伪装成风险告警；它是覆盖卡和健康信号。
- 不承诺 P2 能发现所有跨进程、内核级或代理转发的数据流。

## 2. Harness 覆盖与热插拔

### 2.1 两层机制

1. 统一关联器只理解范围、阶段、目的地类别、授权状态、重试与证据等级；它不依赖执行环境名。
2. `TrustAuditProfile` 只声明经过验证的本地根目录、归档命名约束、适配器能力与 consent 映射。内置 profile 与 `harnesses.d/<slug>/manifest.json` 中的 `trust` 声明都必须使用同一受限 schema 并自动热插拔；待批准草案不进入 active registry。

Trust 能力作为 Harness Manifest v1 的受限 `trust` 扩展加载；执行环境本身仍必须提供完整的
`manifest_version/display/discovery/source/session/recipe/event_key` 字段，避免只登记
一个目录却没有可审计的日志适配器。Trust 扩展的最小格式为：

```json
{
  "trust": {
    "roots": ["~/.example-agent/checkpoints"],
    "artifact_terms": ["snapshot", "checkpoint"],
    "extensions": [".enc", ".state"]
  }
}
```

根必须为 `~/` 下相对路径；禁止绝对路径、`..`、正则、shell、命令、任意 URL 和自由文本提取规则。纯 profile 最多产生 `package_observed/E1`；它不能证明上传。

### 2.2 Agent 协助的 Profile 热插拔

应提供 MCP 让本地 AI Agent 协助用户**编写、解释和验证**受限 profile；不应把每个长尾执行环境的适配工作都固化为产品内置代码。MCP 在这里是 profile control plane，不是原始证据或任意文件系统接口。

Agent 可做：根据用户提供的公开资料、客户端版本信息或用户明确粘贴的脱敏目录结构，生成 profile 草案、解释 capability/coverage、调用纯校验并将草案提交为待批准项。Agent 不可做：枚举用户磁盘、读取执行环境日志/manifest 内容、取得原始路径或命令行、写入任意位置、绕过桌面确认安装 profile。

MCP 工具契约如下：

| 工具 | 写入 | 输入/输出边界 |
|---|---|---|
| `trust_profile_schema` | 否 | 返回版本化 JSON Schema、闭集枚举和 capability 矩阵；无本机数据。 |
| `trust_profile_list` | 否 | 返回 profile ID、显示名、来源、校验状态、能力和 coverage；不返回本机绝对路径或原始 evidence。 |
| `trust_profile_validate` | 否 | 接收 draft JSON，执行 schema、根限制、保留词和 capability 校验；只返回字段级错误与安全预览。 |
| `trust_profile_stage` | 仅待批准存储 | 仅在 `data-mcp serve --allow-local-writes` 下接收已验证草案，写入专用 pending store，返回不透明 `proposal_ref`；不能直接生效。 |
| `trust_profile_proposal_status` | 否 | 返回 pending/approved/rejected/revoked 与拒绝码；不返回原始 profile 或本地路径。 |

桌面端必须显示草案的 ID、显示名、受限 root、可产生的最高证据等级、不可获得的能力和来源，并由**用户在本地 UI 明确批准**后才将其原子写入 `<AGENT_VITALS_HOME>/harnesses.d/<slug>/manifest.json`。待批准草案存放在独立的 `trust-profile-proposals/` 目录。MCP 客户端、Agent 和 `proposal_ref` 都不能替代该批准。拒绝或撤销必须移除 pending/active profile；撤销使用可恢复的本地目录移动。

AI 或用户创建的本地 profile 一律标为 `local_custom`：最多声明 `package_e1`，不能声明 credential、destination、outbound bytes、remote accepted 或 consent mismatch，不能单独触发通知。只有随本机应用版本发布、或由已验证 Harness Manifest 携带且具有对应 adapter/fixture 的 profile，才可获得更高能力；即使如此，实际 Observation 仍须由独立证据生成。

### 2.3 Coverage 契约

每个发现的执行环境根必须有以下之一：

| 状态 | 用户可见含义 | 能否创建 Trust 风险 Finding |
|---|---|---|
| `profiled` | 有已验证的 profile/adapter，可报告其能力矩阵 | 可以，受已实现规则限制 |
| `detected_unprofiled` | 发现疑似客户端，但没有可审计的专用 profile | 不可以；显示 Coverage 缺口与“如何导入 profile” |
| `not_detected` | 已知根未发现 | 不可以；不得表述为“未发生外传” |
| `partial` / `unavailable` | 传感器或权限无法提供某类证据 | 仅保留已有证据，不输出否定结论 |

Coverage 必须在 Findings 信任页顶部、执行环境详情和 CLI JSON 中出现。它不进入 SV70x 风险计数；如未来需要持久化行动项，另设 coverage family，不能复用安全规则码。

## 3. 证据模型

### 3.1 数据动作阶段与等级

| 阶段 | 值 | 最低证据 | 可说的事实 |
|---|---|---|---|
| 本地读取 | `read_observed` | manifest、状态或受限文件访问分类 | 已读取/枚举相应范围 |
| 本地打包 | `package_observed` | 包、加密归档或明确状态 | 已形成待处理载荷 |
| 上传准备 | `credential_observed` | 凭证、公钥、预签名目标或上传调用 | 已准备上传 |
| 上传尝试 | `egress_attempted` | POST/PUT/连接/失败或超时 | 已尝试外发，未证明成功 |
| 字节发送 | `egress_transmitted` | 归属到 actor 的出站字节与时序 | 对应数量字节离开进程 |
| 远端接受 | `remote_accepted` | accepted 状态或等价回执 | 远端至少接受对象/清单 |

证据等级固定为 `E0 inferred`、`E1 local_artifact`、`E2 upload_ready`、`E3 network_attempt`、`E4 transmitted`、`E5 accepted`。阶段和等级同时显示；后阶段不自动说明此前整个载荷均已发送。

### 3.2 `TrustObservation` 合同

```text
observation_id           稳定、内容无关的幂等 ID
machine_namespace, harness, actor_id, actor_kind, actor_version?
observed_at_ms, observation_kind, stage, evidence_level
workspace_ref?           本机随机密钥 HMAC；从不存原路径
scope_classes_json       仅闭集枚举
file_count?, byte_count?
destination_class?       vendor_api/object_storage/telemetry/eval/model_api/unknown
destination_host?        规范化 hostname；不得含 path/query/token
consent_kind?            indexing/telemetry/improvement/privacy/other_declared
consent_state            enabled/disabled/unavailable/ambiguous
source_id?, native_event_id?, source_line?, source_offset?
collector_id, collector_version, provenance_json, expires_at_ms?
```

`consent_kind` 与 `consent_state` 必须成对出现。适配器在无法证明相关开关种类时写 `unavailable`，不得把“任一设置关闭”压缩为 `disabled`。

禁止原始路径、文件名清单、源码、prompt、tool 参数/结果、请求体、header、cookie、JWT、签名 URL、RSA/AES 密钥和完整命令行进入 authority。

### 3.3 不可逆引用与密钥

`workspace_ref` 与 `actor_id` 的生成必须使用每台机器随机创建的 256-bit 本地 secret，以 HMAC-SHA-256 计算并加域分隔（例如 `workspace:`、`actor:`）。密钥：

- 保存于本机私有配置目录，权限仅限当前用户；永不写 authority、日志、MCP、导出、诊断包或崩溃报告；
- 首次初始化必须使用安全随机源，并以不可覆盖的原子安装完成（临时文件写满、刷新并同步后再 create-if-absent）；读取时拒绝符号链接、非普通文件、组/其他用户可读写的文件以及长度错误的 key；
- 首次创建失败时拒绝产生该引用，不以机器名、固定常量或无盐 SHA-256 降级；
- 本版本不提供主动轮换 API/UI；若未来轮换，旧引用允许失去可链接性并重新计算，且 UI 必须显示“本地引用已轮换，历史链路可能分段”；
- 持久化引用为 HMAC-SHA-256 的前 16 字节（128 bit）十六进制截断值，并使用不同域标签隔离 actor、workspace 与 event；
- `workspace_ref` 未被任何 adapter 填充前，也必须先完成此设施与测试。

## 4. 规则注册与能力矩阵

SV701–SV710 必须在分类图谱中逐项登记，包含 `implemented`、`partial`、`planned` 或 `unavailable` 状态和原因。产品不得把未实现规则的零结果呈现为“未发现”。

| 代码 | 类型 | P1 发布目标 | 最低判定契约 |
|---|---|---|---|
| SV701 | `workspace_scope_exceeded` | planned | 经 adapter 证明范围超出声明范围 |
| SV702 | `repository_history_packaged` | implemented | E1+ 证明包/范围包含 Git history 类别 |
| SV703 | `secondary_session_reporting` | planned | 有会话/eval 字段类别与二次链路证据 |
| SV704 | `tool_payload_secondary_egress` | planned | 有 tool 类别与独立外发链路证据 |
| SV705 | `consent_behavior_mismatch` | implemented | 同 Incident 中，明确 `consent_kind + disabled` 与对应 E2+ 行为 |
| SV706 | `audit_surface_bypass` | partial | sidecar 行为缺少 canonical tool/approval 对应；只作差集陈述 |
| SV707 | `background_retry_retention` | planned | pending/retry 证据跨阈值窗口且次数/持续时间可核验 |
| SV708 | `remote_controlled_egress_enablement` | planned | 本地可核验配置/凭证/flag 导致采集或上报启用 |
| SV709 | `direct_object_storage_egress` | implemented | 已关联的上传准备与 object-storage 尝试/发送/接受证据 |
| SV710 | `declared_exclusion_violated` | planned | 已版本化声明的排除类与实际范围证据冲突 |

表中是 P1 的**发布目标**，不是对当前 worktree 的完成声明。规则只有实现、脱敏 fixture、关联测试和产品面能力状态同时存在时，才可标为 `implemented`；它也不表示所有平台都能提供所需输入。每个规则还必须有 harness/platform capability 状态。

## 5. Authority、生命周期与隐私分面

### 5.1 表与迁移

Authority 追加版本化迁移，绝不在规格中预占 schema 编号。新增：

1. `trust_observations`：低频或聚合 Observation，按 `observation_id` 幂等；每行关联具名 `sync_runs`，文件来源可关联 `source_files`。
2. `trust_issue_evidence`：`issue_id + observation_id + evidence_role` 关联。
3. `trust_monitor_state`：开关、能力、最近成功时间、类型化错误与通知冷却状态；不存系统权限原文。
4. `trust_suppressions`：用户明确建立的 rule/harness/actor 粒度抑制，含范围、创建时间、可选过期时间和撤销记录；不得存路径或自由文本秘密。

所有 schema-bearing 开发与测试使用独立 `AGENT_VITALS_HOME`。迁移合入并经干净库、旧库逐级迁移和 `sqlite_master` 等价测试通过前，不得把草稿 schema 升级到日常真实 authority DB。

### 5.2 Issue 身份与抑制

Trust Finding 继续写入 `issue_instances`，`evaluator_id=trust-egress-correlator`。稳定实例键为：

```text
(machine_namespace, rule_code, harness, actor_id, workspace_ref, incident_bucket)
```

`incident_bucket` 是可控窗口标识，不能是单条 observation ID。`evidence_fingerprint` 仅用于证据版本变化，不能改变实例身份。

普通 observation 刷新只能更新证据摘要，**不得**把 `resolved`、`not_applicable` 或 `wontfix` 自动改回 `open`。若用户选择“忽略该规则”，必须写入 `trust_suppressions`；命中后不创建可见风险 Finding，UI 显示已抑制的规则、范围和撤销入口。新建或升级到抑制范围外的 Incident 才可创建新的 Finding。

### 5.3 元数据、保留与删除

Issue metadata 仅允许：阶段、证据等级、confidence、闭集 `evidence_origins`、闭集 `confidence_reasons`、scope classes、计数、destination class、`consent_kind/state`、Observation 数、最早/最近时间、coverage 状态、incident 状态。不得含 actor、workspace、hostname、source ID、锚点或路径；两个闭集字段不得承载自由文本。

高频 Observation 默认保留 7 天，可选 1/7/30 天；关闭 Finding 后保留脱敏摘要，原 Observation 按保留期清理。删除导入执行环境数据时必须先删 evidence link、再删 observation、再删 source，且将失去全部证据的 Trust Finding 诚实转为 expired/resolved。

Trust observation、时间线、引用密钥和原始证据不进入 MCP、默认导出或 redacted export；private export 也不得包含内容、凭据、请求体或原始路径。

## 6. 采集与关联

```text
执行环境日志 / 状态 / manifest ─ 历史 adapter ─┐
本地设置 ─ consent adapter ────────────────┼─ Observation ─ Incident correlator ─ Rule Findings
低权限进程 / 连接元数据 ─ 可选 runtime ────┘                                      └─ UI / eligible notification
```

### 6.1 历史 adapter

Adapter 只解析已存在的本地状态、日志、manifest 和设置，并立即归类、计数与哈希。ZCode 与 MiniMax Code 的 fixtures 必须脱敏、虚构路径并覆盖完整链与缺环链。读取客户端安装包内字符串最多形成 E0，不得升级为运行时结论。

### 6.2 P2 runtime monitor

P2 由桌面应用显式启用；关闭时不轮询、不新增 Observation、不申请通知权限。低权限 macOS 实现可使用 `lsof` 点时快照，但只能声称它实际观察到的类别：

- 同一进程出现 Git history 访问与归档写入：最多产生 E1 package；
- 同一进程或经可核验父子关系归并的 process group 出现已建立连接：最多产生 E3 attempted；
- 没有字节计数时，绝不产生 E4；没有明确回执时，绝不产生 E5；
- 未取得安全分类的目的地只写 `unknown`，不得触发 SV709；unknown + 大流量异常规则须等字节传感器可用后另行引入；
- 进程拆分、代理、容器、权限不足和漏采都必须输出 `partial/degraded`，而非“未发生”。

监测不得读内容、原始路径、完整命令行、hostname 或 TLS 明文。P3 的 Endpoint Security、Network Extension、Windows ETW/WFP、Linux eBPF/auditd 须另行进行权限、签名、性能和隐私评审。Windows 的分层能力、事件丢失、进程归属与发布门槛见 [Windows Trust Runtime 规格](WINDOWS_TRUST_RUNTIME_SPEC.md)。

本版本的平台能力边界必须显式展示：macOS 提供可选 `lsof` 点时快照和历史 profile 审计；Linux 仅提供历史 profile 审计，runtime monitor 为 `unavailable`；Windows 的 Trust 身份/审计能力在完成平台 CSPRNG 与 ACL 私有性校验前为 `unavailable`，不得呈现为“未发现外传”。所有平台仍可使用 Agent trajectory（SV601–614）和 coverage 状态；平台不可用只影响 Trust 侧事实，不改变行为轨迹结果。

### 6.3 Incident correlator（发布阻断）

关联器必须先按下列键聚合，再运行规则：

```text
(machine_namespace, harness, actor_id 或 verified_process_group, workspace_ref, time_window)
```

默认滚动窗口 60 分钟；相邻 Observation 间隔超过 30 分钟时切分为新 Incident。没有 `workspace_ref` 时不得把不同 workspace 强行合并；可在同 actor/window 下生成低置信的未知 workspace Incident，并明确缺失事实。

每个 Incident 必须输出：输入 Observation IDs、`first/last_observed_at_ms`、真实 `observation_count`、最远阶段、最高证据等级、支持事实、缺失事实、不可推断项与版本化关联策略。规则在 Incident 上运行：

- SV702、SV705、SV709 可以同时存在并关联同一 Incident；它们不得被强行折叠为一个 SV709。
- 链不完整时按实际最远阶段降级；缺少 credential、连接、字节或 accepted 的事实必须可见。
- SV709 至少要求同一 Incident 存在上传准备/业务链路与 object-storage 的尝试、发送或接受证据；对象存储单行连接不能单独定为 SV709。
- 关联器返回 `inserted`、`evidence_refreshed`、`severity_upgraded`、`stage_upgraded`、`suppressed` 的逐 Finding 结果，供 UI 和通知使用；禁止只返回笼统的 `findings_upserted`。

### 6.4 Agent 命令轨迹是辅助上下文，不是 Trust 证据升级

执行环境会话适配器可以从 `CanonicalSession.tool_calls` 看到 Agent 明确请求的工具及其参数；现有行为/轨迹规则（SV601–610、SV611–614）继续在领域层对这些事件做纯函数判断。典型的可疑意图包括：创建 `tar/zip/git archive`、读取 `.git`/凭据范围、调用加密工具、请求上传凭证、使用 `curl/ossutil/aws s3/rclone/scp` 等上传工具，以及后台重试或持久化。

这些命令轨迹只能表达 Agent 的**意图或可见动作**，不能替代执行环境/sidecar 的文件、凭证、网络和字节证据：

1. 命令参数可以在内存中短暂读取，但最多按固定上限截断；分类器版本固定，输出只能是闭集、版本化的 `IntentHint`，不得带匹配片段、命令、路径或 URL。例如：`workspace_read`、`git_history_read`、`archive_create`、`credential_access`、`network_intent`、`eval_report`、`unknown`。
2. `IntentHint` 不进入 `trust_observations`、`provenance_json`、`trust_issue_evidence`、MCP 或任何 export；不设置 `destination_class`，不提供 scope/byte/consent 事实，不把 E0 提升为 E1/E2+，不单独创建 SV70x 或系统通知。`curl`、`ossutil`、`rclone`、`scp` 等最多产生 `network_intent`，不能据此推断 `object_storage`。
3. 只有取得 verified process-group，以及本机随机密钥 HMAC 生成的 `actor_ref` 与 `workspace_ref` 后，才允许使用 `(machine_namespace, harness, actor_ref, workspace_ref, verified_process_group)` 加上同一滚动 60 分钟窗口、相邻间隔不超过 30 分钟的条件，把 hint 作为 Incident 的 `context` 关联。缺任一 join 条件、发生进程拆分或引用不可验证时必须保持 `partial`，不得用 harness、PID、session_id、trajectory_id 或时间猜测合并。
4. `tar`、`curl`、对象存储客户端等命令与独立的凭证/网络观察同时出现时，UI 可以并列展示“Agent 可见动作”和“Trust 事实”；只有后者满足 SV702/SV705/SV709 的最低证据契约时，才生成对应 Finding。现有 SHA `opaque_ref` 不是上述 HMAC 身份，不能用于未来 bridge。

因此，命令轨迹判断的代码归属为：执行环境 adapter 负责生成 `CanonicalSession`，`domain::behavior`/`domain::trajectory` 负责纯模式判断；未来的 `IntentHint` 分类器应位于 domain 层，runtime 只负责生命周期和能力降级，`trust_correlator` 仍只消费已脱敏的 TrustObservation。不得把 shell 正则直接塞进数据层关联器。

## 7. 判定与通知

### 7.1 Severity 与 confidence

`severity`（info/warning/critical）取决于范围、敏感类别、体量、授权偏差与持续时间；`confidence`（low/medium/high）取决于等级、多信号一致性、归属和时间关联。两者必须独立展示。

| 场景 | 最多结论 | severity / confidence |
|---|---|---|
| 仅安装包中有上传端点 | E0，静态能力线索 | info / low |
| 整仓 history manifest 或加密包 | E1 package | warning / high |
| 明确关闭 indexing 后仍取得同链路凭证 | E2 credential | warning / medium；不通知 |
| 关闭相关 consent 后有 POST/PUT/连接尝试 | E3 attempted | critical / high |
| process 归属的大量字节离开 | E4 transmitted | 至少 warning；范围/授权偏差可升 critical |
| accepted hash 与本地对象对应 | E5 accepted | critical / high |

`consent_state=unavailable/ambiguous` 不是 disabled，不得触发 SV705 critical。

### 7.2 可通知条件（唯一规范）

通知仅在实时监测已开启且用户允许系统通知时，满足全部条件才可发出：

1. 关联器结果是 `inserted`、`severity_upgraded` 或 `stage_upgraded`，不是 `evidence_refreshed`；
2. Finding 未被 suppression；
3. Finding 满足其可通知门槛：`critical + medium/high confidence`，或首次达到 E4/E5；SV705 仅在明确相关 consent disabled 且 E3+ 时可通知；
4. 同一 `(rule_code, harness, actor_id, workspace_ref, incident_bucket)` 在 **15 分钟** 冷却窗内没有已发送通知。

E0/E1 永不通知。E2 的 SV705 进入 Findings 但不通知。升级可以绕过“仅刷新不通知”的限制，但仍受同一 15 分钟 family 冷却控制；若产品以后需要绕过冷却，必须单独修改本节和验收测试。

通知文案只使用事实句，例如：“本地 Agent 在 14:32 尝试向对象存储发送归档；未观察到远端接受。查看证据。”不得使用“偷走了数据”等定罪措辞。

### 7.3 人工处置

首版动作只有：查看证据、暂停该执行环境监测、忽略该规则、撤销忽略、打开处置指引。不得自动终止进程、改防火墙、删快照、改客户端包或轮换凭据。

## 8. 产品面与 API

Trust 进入现有 Findings，而不是独立收件箱：

1. 状态卡显示历史审计、实时监测、权限和 coverage；
2. 风险摘要按六阶段计数，不显示“泄露数”；
3. 列表按 Incident 分组，展示关联的规则 chip、阶段、severity、confidence、授权状态和最近时间；
4. 时间线显示“设置 → 范围 → 打包 → 凭证 → 网络 → 回执”，未观察到的环节标记为“未观察到”，不能标记为“未发生”；
5. 规则/执行环境能力矩阵显示 implemented/partial/planned/unavailable 与原因；
6. 已抑制 Finding 可审计、可撤销，不混入开放风险计数。

IPC 至少包括 `trust_monitor_status`、`save_trust_monitor_config`、`trust_findings_summary`、`trust_finding_timeline`、`trust_evidence_open`、`trust_rules_coverage`、`trust_suppression_create/revoke`、`trust_profile_proposal_list/approve/reject/revoke`。本地详情只能读取脱敏 Observation 投影；按锚点复核的原始源只能在本地呈现时短暂读取，不缓存、不入库。

## 9. 可靠性、安全与性能

1. 历史审计沿用 source fingerprint 差量；实时写入最多每 10 秒一批。
2. Findings 首屏仅读 authority 聚合，目标 p95 小于 1 秒；原始源仅在用户展开时读取。
3. runtime 平均 CPU 小于 1%、内存小于 100 MiB；队列满、传感器崩溃或权限不足 fail-open 并输出 coverage degradation。
4. 采集器自身 I/O 必须排除，避免自激循环。
5. Agent Vitals 的价目表和版本检查不得携带 Observation、Finding、执行环境标识或任何用户数据。

## 10. 分期与发布范围

### P0：契约与样本

- 完成本规格的数据闭集、密钥设施、SV701–SV710 taxonomy/能力注册与脱敏 fixtures。
- 用独立数据目录验证迁移，禁止草稿 schema 污染真实 authority DB。

### P1：历史审计（可独立发布）

- Observation、evidence link、Incident correlator、suppression、ZCode/MiniMax adapter；
- Trust Findings、时间线、coverage/规则能力矩阵、CLI 手动审计；
- 无常驻 watcher、无系统通知、无自动阻断。

### P2：低权限实时监测（可在 P1 后增量发布）

- 桌面显式开关、通知授权、process-group 有限关联、能力降级和第 7.2 节通知门控；
- 不承诺字节级证据、文件 watcher 或 60 秒内必达；缺少这些能力必须显著显示。

### P3/P4：另行评审

P3 为 OS 级增强证据；P4 为阻断/隔离保护模式。两者均不由本规格授权。

## 11. 不能发布的情况

出现任一情形，P1/P2 对应能力不得发布或必须在 UI 中关闭：

1. 关联器仍按单条 Observation 建立 Issue，或 Observation count/时间范围固定为 1；
2. 未实现规则被 UI 默认为“未发现”，或 taxonomy 没有逐项覆盖状态；
3. `consent_kind` 缺失却启用 SV705 critical；
4. E0/E1 或普通证据刷新可以触发系统通知；
5. runtime 无 destination 分类却能够触发 SV709；
6. workspace/actor 引用使用固定、机器派生或无盐哈希；
7. 无 suppression 持久化/撤销出口却向用户展示“忽略该规则”；
8. 任意 Trust 原始证据、路径、内容、凭据或 Observation 时间线进入 MCP、默认导出、遥测或非本机网络请求；
9. 没有脱敏 ZCode/MiniMax 完整链和缺环 fixture，或没有关联、通知、迁移的回归测试。
10. MCP 可直接启用 profile、可读任意执行环境文件，或 `local_custom` profile 能产生 E2+ / SV705 / SV709 / 系统通知。

## 12. 发布验收标准

### 12.1 P1 历史审计

1. 重复输入产生幂等 Observation、Incident、Issue ID 与状态历史。
2. 完整 ZCode fixture（范围/打包/credential/object storage/accepted）产生一个 Incident、关联的 SV702 与 SV709；若 consent 明确 disabled，可另有关联 SV705。不得要求“恰好一个 SV709”。
3. 缺环 fixture 的 Incident 正确填充真实计数、起止时间、最远阶段与缺失事实；不得输出“已上传”或“远端接受”。
4. MiniMax fixture 能形成 eval/session 二次上报链，且不误报为整仓上传。
5. SV705 在 E2 时最多 warning/medium 且不可通知；在相关 `consent_kind=disabled` 与 E3+ 时才可 critical。
6. `detected_unprofiled`、`not_detected`、`partial` 和 `unavailable` 均与“无 Finding”区别显示。
7. resolved/not_applicable/wontfix 不会因新 Observation 刷新而自动 reopen；suppression 可创建、命中、撤销并经重启保持。
8. authority、MCP、redacted/private export 中都搜不到 fixture 的路径、内容、prompt、tool args/results、token、签名 URL 或密钥。
9. 删除源后仅保留脱敏摘要并显示“源已过期”，不保留悬空 evidence link。
10. `trust_profile_validate` 对绝对路径、`..`、通配执行规则、未知 capability、超出 `local_custom` 权限的能力和非闭集 consent/destination 值全部拒绝；拒绝信息不回显原始路径。
11. MCP 仅能 stage 已验证草案且仅在 `--allow-local-writes` 下可用；没有桌面本地确认时 profile 不生效。批准、拒绝、撤销后 profile registry 与 coverage 都可重复、原子地反映结果。
12. Agent 生成的 `local_custom` profile 在 fixture 中最多产生 E1 package/coverage，不能触发 SV705、SV709 或系统通知；MCP 返回体不含原始路径、artifact 名称、Observation 或 evidence 时间线。
13. 若实现 `IntentHint`：archive/curl/credential/path 命令 fixture 必须只输出闭集、确定性的标签且无原文泄露；Intent-only 不落 TrustObservation、不产生 SV70x/通知；未经 verified process-group 与 HMAC 引用不得关联；具备完整 join 条件时只能增加 `context`，不能改变 stage/evidence/severity；60 分钟窗口、30 分钟断链、超长/恶意参数降级 `unknown` 均有测试。Python 复用时必须增加 Python/Rust byte-lockstep。

### 12.2 P2 实时监测

10. 默认关闭；关闭后最多约 2 秒停止下一次轮询并不新增 Observation；开启通知时才申请权限。
11. 单进程 Git history + archive 只形成 E1/SV702，绝不触发通知；连接无 destination 分类不产生 SV709。
12. 有可核验 process-group、分类目的地和相应证据时才升级 Incident；无 bytes 不产生 E4，无 accepted 回执不产生 E5。
13. 通知测试必须覆盖 inserted、evidence_refreshed、severity_upgraded、stage_upgraded、suppressed 与冷却：刷新不通知，E0/E1 不通知，E2 SV705 不通知，合格升级最多一次/15 分钟 family。
14. 传感器不可用、权限不足、跨进程未能归并、丢事件时 coverage 为 degraded/partial，绝不输出“未发生外传”。

### 12.3 工程质量

15. 迁移在干净库和支持的旧库上逐级成功，schema 合约等价；测试不使用日常 authority DB。
16. 新增 fixture→golden/lockstep 覆盖 Trust audit、Incident 投影、Finding 摘要和通知候选；不得以刷新 snapshot 掩盖契约变化。
17. `python3 -m unittest discover tests -v`、`cargo test --release`、`cargo clippy --release --all-targets -- -D warnings`、golden parity 和迁移测试均通过。

## 13. 最终发布判断

达到本规格的 P1 验收后，产品可以发布为“本地 Agent 历史信任审计”；达到 P2 验收后，才可以发布为“可选低权限实时监测与报警”。两者都只能承诺本机实际证据覆盖到的阶段与范围。

这使 Findings 2.0 成为真正的重大升级：从会话自述升级到可复核的本地行为证据链，同时仍坚持离线、最小数据、透明覆盖边界与不过度归因。
