# Trust 行为特征组合与通用取证规格

**状态：** Draft v1（2026-09-20）

**目标版本：** v1.0.0-beta.5 之后的 Trust 增量

**前置规格：** [Findings 2.0：本地 Agent 数据访问与出境审计](FINDINGS_TRUST_EGRESS_MONITORING_SPEC.md)、[Harness Manifest DSL](../HARNESS_MANIFEST_DSL_SPEC.md)、[Windows Trust Runtime](WINDOWS_TRUST_RUNTIME_SPEC.md)。若本规格与前置规格冲突，以 Findings 2.0 的离线、只读、脱敏和证据等级约束为准。

## 0. 决策摘要

Trust 不应以“这是 ZCode”或“这是 MiniMax Code”作为风险判断条件。执行环境只提供发现根、已审计能力与可选设置映射；统一关联器只消费行为特征链：

```text
范围读取 / 枚举 → 归档或索引状态 → 上传准备 → 出网尝试 → 字节发送 → 可验证回执
```

单一信号不是风险结论：SQLite、`.git`、压缩包、对象存储域名、普通聊天 API 或 `upload` 日志字样都不能独立证明未披露外传。新的实现必须让用户看见“观察到了什么”及“还缺什么”，而不是把缺环链路标作安全或偷取。

动态 Profile 可以组合受审计的 feature adapter；不得携带 SQL、正则、Shell、URL、任意解析代码或提高自身最高证据等级。只有随二进制发布、具有 fixture 和版本化 schema 指纹的 adapter 才能读取结构化状态值。

## 1. 问题与代码现状

当前实现的基础已经存在：

| 现有位置 | 已有能力 | 本规格指出的缺口 |
|---|---|---|
| `crates/agent-vitals-runtime/src/trust_audit.rs` | artifact 历史审计；ZCode checkpoint、MiniMax workspace-index adapter | Profile 只能选择一个 adapter，不能表达复合特征；adapter 输出缺少来源可信度 |
| `crates/agent-vitals-runtime/src/trust_runtime_monitor.rs` | macOS `lsof` 点时快照；Git history + archive/index 写入 + TCP 关联 | 无持续事件流、无字节数、无 proxy 最终目的地、无 verified process group |
| `crates/agent-vitals-harnesses/src/harnesses/generic/manifest.rs` | `trust` 根/文件特征与受限 adapter allowlist | 缺少多 adapter、版本、能力上限与 schema-fingerprint 声明 |
| `crates/agent-vitals-data/src/trust_correlator.rs` | 同 harness/actor/workspace/window 的 SV702、SV705、SV709 关联 | 对“工作区归档但尚无 Git history”只能保留 Observation，缺少通用覆盖/缺环解释 |
| `crates/agent-vitals-runtime/src/mcp/trust_profiles.rs` | 受限 Profile 草案、校验、stage，UI-only approve | 未展示 feature 矩阵和各 adapter 的最高证据等级 |

本规格不改变产品的离线承诺：任何读取都在本机完成；原始路径、对象 key、文件内容、消息、命令、请求正文、凭据和 TLS 明文均不得写入 authority、MCP、导出或诊断包。

## 2. 通用行为特征

### 2.1 特征族与证据上限

| 特征族 | 安全采集信号 | 可产生阶段 / 最高等级 | 不能推出的结论 |
|---|---|---|---|
| `workspace_scope` | manifest 内路径类别计数；运行时文件句柄的类别 | `read_observed` / E1 | 已归档、已上传、云端可读 |
| `git_history_scope` | `.git/objects`、packs、LFS、logs、reflog、bundle 的类别或计数 | `read_observed` 或 `package_observed` / E1 | 所有 Git 历史均已发送 |
| `package_artifact` | tar/zip/bundle/enc、manifest、archive hash、写入 mtime/大小 | `package_observed` / E1 | 上传成功或对象内容 |
| `sqlite_index_state` | 仅 schema 名称/列类别；受审计 layout 的聚合状态 | schema fingerprint：E0；明确 archive/manifest 状态：E1 | 任意 SQLite 都是上传队列 |
| `upload_preparation` | 预签名目标、公钥、对象 key、上传队列状态、credential 调用 | `credential_observed` / E2 | 数据已经离开设备 |
| `runtime_correlation` | 同 PID 或 verified process group 的读取、写入、连接时序 | `egress_attempted` / E3 | 请求方法、目的地、字节数、成功 |
| `network_transfer` | 用户已有代理/系统传感器提供的方法、类别、字节量、时序 | `egress_transmitted` / E4 | 云端使用、留存或训练 |
| `verified_receipt` | 可验证的响应/回执、对象可还原实验产物、独立云端审计 | `remote_accepted` / E5 | 训练、人工访问、出售 |
| `control_comparison` | 用户明确启动的开关前/后实验的脱敏设置快照和行为计数 | 不单独升级等级 | 开关的产品文案或法律含义 |

`workspace_scope` 可以只涉及工作树，`git_history_scope` 才表示历史对象类。规则不得把两者混为“整仓”。

### 2.2 SQLite 的两级处理

SQLite 很常见，不能因文件后缀或表名命中就发风险 Finding。

1. `sqlite_schema_fingerprint_v1` 只读取 `sqlite_master` 和 `PRAGMA table_info`，把表/列归为闭集类别（`workspace`、`revision`、`archive`、`manifest`、`upload`、`object_storage`、`retry`），立即丢弃原始名称。它最多写 E0 coverage 诊断，不能写 SV70x。
2. `sqlite_layout_<name>_vN` 是内核发布的固定查询模板。例如一个被 fixture 验证的 workspace-index layout 才可将 archive/manifest presence 写成 E1、对象 key presence 写成 E2、retry 计数写成 E1。模板必须限定数据库位置、表、列、类型、最大行数和聚合输出；绝不接受 Manifest 提供的 SQL。

MiniMax 的现有 workspace-index adapter 属于第二类。它是可复用 layout，而不是“MiniMax 名称触发的风险规则”。

### 2.3 `.git`、备份与归档的处理

扫描器只能在已批准执行环境 root 内检查以下结构类别：

- Git：objects、packs、LFS、logs、reflog、refs、bundle；
- 归档：tar、tgz、zip、zstd、bundle、enc、manifest；
- 状态：SQLite、LevelDB/RocksDB 元数据、JSON state、队列/retry 文件；
- 历史：执行环境明确命名的、固定上限的迁移备份。

不得递归扫描用户所有项目、家目录或任意 `.git`；不得因用户自己的备份工具、依赖缓存、模型下载或普通附件压缩包产生 Trust Finding。必须有“执行环境 root + 特征链关联”才可进入 Incident。

## 3. Profile 与 adapter 合同

### 3.1 从单 adapter 迁移到 feature 集合

Harness Manifest v1 的 `trust.adapter` 是当前兼容字段。新增可选 `trust.evidence_adapters`，取代它作为未来主字段：

```json
{
  "trust": {
    "roots": ["~/.example-agent"],
    "artifact_terms": ["snapshot", "manifest"],
    "extensions": [".json", ".enc"],
    "evidence_adapters": [
      "filesystem_artifact_v1",
      "sqlite_schema_fingerprint_v1",
      "runtime_process_correlation_v1"
    ]
  }
}
```

规则：

1. `adapter` 与 `evidence_adapters` 不能同时出现；旧字段在加载时转换成一项 feature 集合。
2. 数组长度为 1–8，去重、稳定排序，所有值必须为闭集 token。
3. Manifest 只能请求本机版本声明支持的 adapter；不支持时 Profile 标为 `partial`，不得静默回退到更高能力。
4. `filesystem_artifact_v1` 是唯一允许 local custom Profile 默认请求的 adapter，最高 E1，不能发系统通知。
5. layout adapter、consent adapter 与 network adapter 必须随二进制和 fixture 发布；MCP 只可提出草案，用户 UI 批准也不能越过该限制。

建议的初始 allowlist：

| adapter | 输入 | 最大等级 | 动态 Profile 可请求 |
|---|---|---|---|
| `filesystem_artifact_v1` | 根内受限元数据 | E1 | 是 |
| `sqlite_schema_fingerprint_v1` | SQLite schema 元数据 | E0 | 是 |
| `runtime_process_correlation_v1` | 平台低权限进程元数据 | E3 | 是，受平台能力限制 |
| `zcode_checkpoint_v1` | 固定 checkpoint JSON layout | E1；本地 state claim 另见 §4 | 仅内置/已验证 fixture |
| `workspace_index_layout_v1` | 固定 SQLite 聚合 layout | E2 | 仅内置/已验证 fixture |
| `proxy_egress_metadata_v1` | 用户已有代理的脱敏元数据 | E4 | 否，另行显式启用 |
| `settings_comparison_v1` | 用户确认的实验状态快照 | 不升级 | 仅内置实验流程 |

### 3.2 Adapter 描述与用户可见能力

每个 adapter 必须声明：输入类别、最高证据等级、平台支持、是否需要用户显式启用、是否能产生 Finding、是否能通知、fixture revision。`trust_profile_schema/list/validate/stage/proposal_status` 与桌面端必须展示这些元数据，不展示原始路径或证据。

`profiled` 表示已知 adapter 可运行，不表示已经观察到外传；`partial` 表示某些 feature 不可用；`detected_unprofiled` 永远是 coverage 缺口，不是风险。

### 3.3 监测优先级不是“有罪推定”

Profile 可声明闭集 `watch_priority: normal|enhanced`。它只影响覆盖提示、运行时检查排程和人工复核队列；不得参与 Observation 的 `evidence_level`、`evidence_origin`、Finding 严重性、Finding 创建或通知资格。`enhanced` 只能表示某执行环境值得更密集地验证，不表示当前机器已经发生上传。

## 4. Observation 与关联规则

### 4.1 新增 `evidence_origin`

`TrustObservation` 增加闭集 `evidence_origin`，与 `evidence_level` 分开：

| 值 | 含义 | E5 是否允许 |
|---|---|---|
| `local_artifact` | 文件或状态的本地结构 | 否 |
| `client_state_claim` | 客户端写入“accepted/success”等状态 | 否；最多保留为本地 claim |
| `runtime_process_metadata` | OS 进程、句柄、连接观察 | 否 |
| `network_metadata` | 方法/字节/时序等非正文网络元数据 | E4 可用，E5 不可用 |
| `verified_receipt` | 可验证响应、独立回执或可复现实验对象 | 可以 |

因此，客户端的 `lastAcceptedManifestHash` 不得单独写 E5/`remote_accepted`。它应写为 `RemoteAck` observation kind、`client_state_claim` origin，并保持在本地 E1/E2 语义；只有同 Incident 有 `verified_receipt` 才能将该链升级至 E5。这是对现有 ZCode state 映射的必要收紧。

### 4.2 通用 Incident 最低关联

关联键仍是 `(machine_namespace, harness, actor_id 或 verified_process_group, workspace_ref, time_window)`。新增特征链约束：

- E1 package + `git_history_scope`：可判 SV702；
- E1 package + E2 upload preparation：显示“已打包并准备上传”，默认不通知；
- E1 package + E3 runtime connection：显示“关联出网尝试”，无 destination/bytes 时不判 direct object storage；
- E2 + E3/E4 object storage：可判 SV709，仍不得陈述云端用途；
- `client_state_claim` 仅补充时间线，不能独立满足 SV709 或 SV710；
- 开关对照仅在两次实验的二进制版本、Profile revision、实验仓引用和时间窗一致时，才可能支持 SV705。

新 Finding 规则须先登记 [问题分类图谱](../AGENT_EXECUTION_PROBLEM_TAXONOMY.md) 第 7 层，再实现 emitter、fixture、correlator 与 UI。建议新增但初始均为 `planned`：`workspace_archive_upload_prepared`、`client_state_claimed_acceptance`、`control_setting_behavior_mismatch`；不得占用或重定义已有 SV701–SV710。

## 5. 用户引导的对照实验

实验不是默认扫描，也不是自动化渗透测试。用户必须在 UI 逐项确认：使用一次性仓库、无真实凭据、允许目标 Agent 访问该仓库、允许本产品记录脱敏时间/大小/状态。

推荐流程：

1. 创建或选择一次性实验仓；可包含虚构 canary 和仅在 Git 历史中存在的虚构条目。
2. 记录执行环境版本、Profile revision、开关状态类别和首次基线；不保存实际开关文本或仓库路径。
3. 用户自行完成“开”与“关”两次运行；产品不替用户改设置、不发送 prompt、不启动代理。
4. 每次运行只采集 artifact diff、结构性状态、允许的网络元数据和 runtime 分类计数。
5. 结果只报告可比性、链路阶段和缺环；canary 仅在用户本地展示，绝不进入 authority/MCP/export。

## 6. 平台传感器

| 平台 | 第一阶段 | 限制 |
|---|---|---|
| macOS | `lsof` 点时快照 + 历史 adapter | 无请求路径、字节、TLS 内容；本地代理可能遮蔽最终目的地 |
| Windows | ETW 进程/文件事件、TCP 表；WFP/代理元数据待独立授权 | 见 Windows Trust Runtime 规格；未完成前必须 `unavailable` |
| Linux | 历史 adapter | eBPF/auditd 另立规格；不得把缺失说成未发生 |

运行时 adapter 必须保留“部分可见”能力状态。进程名、完整命令行、原始路径和 hostname 都只在内存分类后丢弃；跨进程归属必须有 parent/签名/IPC 等可验证依据，不能因时间相近即合并。

## 7. 实施阶段与验收

### Phase A：语义收紧与数据合同

1. 在 domain 增加 `evidence_origin`，迁移 authority 与受限本地时间线；MCP/导出继续只暴露允许的结构化字段。
2. 把 ZCode 的本地 accepted state 降为 `client_state_claim`，补 fixture 覆盖“仅 state”“state + verified receipt”。
3. 在 taxonomy 登记拟新增规则及覆盖状态。

验收：仅本地 accepted state 不产生 E5/SV710；旧 Observation 迁移诚实显示 origin `unknown_legacy` 或等价缺失状态。

当前实现：Phase A 的 `evidence_origin`、v22 迁移、ZCode state 收紧，以及 `watch_priority` 的 manifest/MCP 元数据已落地；组合 feature 集、网络 metadata adapter 和实验工作流仍属后续阶段。

### Phase B：组合式 Profile

1. Harness Manifest 支持 `evidence_adapters`；保留 `adapter` 兼容解析与明确迁移错误。
2. Runtime 将 `TrustAuditProfile` 从单 enum 改为稳定排序的 feature 集合；adapter 输出合并时按 observation ID 去重。
3. MCP/UI 展示 feature 矩阵、最高等级、平台可用性和批准边界。

验收：同一非厂商 Profile 能组合 `filesystem_artifact_v1 + sqlite_schema_fingerprint_v1`；未知 adapter 无法 stage；legacy ZCode Profile 不退化。

### Phase C：通用结构扫描与关联

1. 实现 bounded `sqlite_schema_fingerprint_v1` 与固定备份 root 规则；不读取业务表记录。
2. 将 Git/归档/工作区类别标准化为闭集 scope classes；增加 fixture 覆盖普通附件、模型缓存、用户备份等非命中样本。
3. 扩展 correlator 的缺环摘要，不将 E1/E2 的普通观察伪装为风险。

验收：无关 SQLite 或 zip 不产生 SV；Git history + package 仍触发 SV702；MiniMax layout 可作为通用 layout 而非 slug 分支运行。

### Phase D：用户实验与高等级网络证据

1. 实现仅本地的 experiment session 元数据与 UI 确认流程。
2. 设计代理/Windows 网络 metadata adapter 的权限、脱敏和性能审查；未完成前不声称 E4/E5。
3. 只有 fixture、golden、Python/Rust parity（适用路径）、migration、desktop UI 截图和真实无敏感实验都通过时才发布。

## 8. 非目标与禁止项

- 不自动制造、上传或验证 canary；不修改执行环境隐私开关、二进制、代理、证书、防火墙或系统安全配置。
- 不把“云端可解密”表述为“用于训练/出售/人工浏览”。
- 不让热插拔 Manifest 获得任意 SQL、脚本、正则、网络请求或本机原始证据读取权。
- 不因缺少 runtime sensor、目录不存在、数据库为零行或没有 `.enc` 就输出“从未上传”。
- 不把当前 ZCode/MiniMax layout 作为其他执行环境的默认真相；新 layout 必须有版本、公开/用户提供的结构证据和脱敏 fixture。
