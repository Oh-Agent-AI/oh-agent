# Windows Trust Runtime 规格

**状态：** Implementation-ready platform addendum（2026-09-20）
**目标版本：** v1.0.0-beta.4 之后的 Windows 增量发布
**上位规格：** [Findings 2.0：本地 Agent 数据访问与出境审计规格](FINDINGS_TRUST_EGRESS_MONITORING_SPEC.md)

## 0. 目的与发布结论

本文件把上位 Trust 规格中的 Windows runtime monitor 具体化为可实现、可降级、可测试的 Windows 平台方案。它不新增一套 Windows 专属的风险规则，也不把 Windows 的传感器能力伪装成“全量网络审计”。所有事实仍必须落入既有 `TrustObservation`、Incident、SV70x 和 coverage 合同。

当前发布结论：Windows Trust runtime 在实现本规格前保持 `unavailable`。Windows 端第一版应先交付低权限用户态能力，再按权限、签名、性能和隐私评审逐级开启 ETW/WFP；内核 minifilter 不属于默认安装内容。

Windows 的 ETW 能够让 consumer 实时接收用户态和内核事件，File I/O provider 可提供文件 I/O 类事件；WFP 能按应用、用户、连接和包/流层进行过滤与状态关联。它们是证据来源，不是“自动证明上传成功”的结论。参考：[ETW overview](https://learn.microsoft.com/en-us/windows/win32/etw/event-tracing-portal)、[File I/O ETW](https://learn.microsoft.com/en-us/windows/win32/etw/fileio)、[WFP architecture](https://learn.microsoft.com/en-us/windows/win32/fwp/windows-filtering-platform-architecture-overview)。

## 1. 范围与非目标

### 1.1 本次要解决的问题

Windows 端需要回答以下问题，并明确回答不了什么：

1. 哪个进程或可验证的 process group 读取了工作区、`.git` history、凭据范围或已知 checkpoint 目录。
2. 哪个进程形成了归档/加密快照，以及是否同时观察到上传准备、连接尝试或可归属的出站字节。
3. 进程拆分、broker、代理、系统服务、权限不足或事件丢失时，如何把结果标为 `partial/degraded/unavailable`。
4. 如何将 Windows 证据投影为现有 `TrustObservation`，不修改 Trust 风险规则的语义。

### 1.2 非目标

- 不读取文件内容、源码、prompt、tool 参数、请求体、TLS 明文、cookie、token、签名 URL 或完整命令行。
- 不安装根证书、不做 TLS 中间人、不阻断连接、不终止进程、不替用户轮换密钥。
- 不把 PowerShell 文本输出当作生产传感器；PowerShell 仅可作为人工诊断工具。
- 不默认安装驱动、不创建永久 autologger、不把用户数据上传到 Agent Vitals。
- 不因为检测到 `tar`、`zip`、`curl`、`rclone`、`aws s3` 等命令就认定发生了 Trust 外发；命令轨迹仍是辅助 `IntentHint`。

## 2. 能力分层与覆盖契约

Windows 传感器采用逐级能力模型。低级能力存在时，高级能力不可被推断出来。

| 层级 | capability | 主要来源 | 最高可产生的事实 | 默认权限 | 状态 |
|---|---|---|---|---|---|
| W0 | `windows_user_snapshot` | 原生 TCP/进程快照、受限目录扫描 | 进程、当前连接、E1/E3 尝试（无字节） | 普通用户 | 首发入口 |
| W1 | `windows_etw_partial` | 实时 ETW Process/Image + FileIo | 读取/打包范围、进程关联、E3 尝试 | 需要诊断权限时降级 | 第二阶段 |
| W2 | `windows_wfp_partial` | WFP ALE 连接事件及可归属计数 | 更可靠的目的地/进程关联；具备计数时 E4 | 管理员或签名组件视 API | 第三阶段 |
| W3 | `windows_minifilter_high_assurance` | 签名文件系统 minifilter | 高保证文件 I/O 证据；与网络证据组合后可达 E4 | 管理员、驱动安装 | 另行评审 |
| W4 | `windows_remote_accepted` | 服务端回执或本地 adapter 明确状态 | E5 | 不由 runtime 自行产生 | 不在本规格 |

覆盖状态仍沿用 `profiled`、`detected_unprofiled`、`not_detected`、`partial`、`unavailable`。W0/W1/W2 不是连续升级的承诺：系统必须把当前可用的 capability、权限、丢事件计数和缺失事实同时展示。

**发布边界：** W0/W1 没有可信出站字节计数时，最高为 E3；W2 只有在进程归属和字节计数都经过验证时，才可写 E4；任何本地 runtime 都不能写 E5。

## 3. 统一架构

### 3.1 模块布局

将现有 `crates/agent-vitals-runtime/src/trust_runtime_monitor.rs` 重构为平台无关接口，并由 Windows 实现下列模块：

```text
trust_runtime_monitor.rs       生命周期、能力、批量写入、跨平台降级
trust_runtime_monitor_windows.rs  Windows backend 选择与 capability probe
windows_process.rs             PID + creation time、父链、签名/版本、进程组
windows_etw.rs                 ETW session、FileIo/Process/Image 解码与丢失统计
windows_wfp.rs                 WFP/ALE 连接关联与可选字节计数
windows_paths.rs               仅内存路径分类和 workspace_ref 解析
```

模块边界必须保持：

- runtime 负责生命周期、权限探测、原生事件消费、队列和降级；
- domain 负责 `TrustObservation` 合同、stage/evidence 约束和规则；
- data 负责幂等写入、Incident correlator、Finding 与通知；
- UI/MCP 只读取脱敏状态，不接触原始 ETW、WFP 或路径。

不得把 ETW/WFP 原始记录落入 authority，也不得在数据层重复解析 Windows 原生格式。

### 3.2 生命周期

1. **Disabled：** 默认关闭；不创建 ETW session，不轮询连接，不请求管理员权限。
2. **Capability probe：** 用户打开开关后，依次探测 W0，再按显式配置尝试 W1/W2；失败只更新 coverage，不阻断应用。
3. **Running：** 以有界内存队列接收事件，按固定批次归一化为 observation；采集器自身进程和临时文件必须排除。
4. **Degraded：** 事件丢失、队列溢出、权限变化、provider 不可用或 attribution 不确定时，保留已验证事实并写入 `partial/degraded`。
5. **Stopping：** 关闭 ETW/WFP subscription，flush 已有 observation，清空原始内存缓存；不得留下后台服务或永久 session。

## 4. Windows 证据到 `TrustObservation` 的映射

### 4.1 Actor 与 process group

每条 observation 的 `actor_id` 必须由现有本机随机密钥 HMAC 设施产生；原始 PID 只能在内存中用于关联，不能进入 authority、MCP 或 export。用于防止 PID reuse 的最小键为：

```text
(pid, process_creation_time, executable_identity)
```

`executable_identity` 至少包含规范化 executable path 的内存摘要、签名发布者/包身份（若可读）和版本摘要；不保存原始路径。父进程链以相同的 creation time 规则验证，最多保留有限深度。无法验证父链时，actor 仍可单独记录，但 `process_group_confidence=low`，不可假设为同一 Agent。

sidecar、broker、浏览器网络进程、系统代理和容器必须单独建 actor；只有经 creation time、父链和明确的本地归属规则验证后，才可在内存中归并为 process group。代理或系统服务无法归属时，destination 可以存在，但 actor attribution 必须为 `unknown/partial`。

### 4.2 文件与工作区范围

Windows FileIo/快照事件只在内存中做路径分类，输出闭集 `scope_classes`：

- `workspace_current`
- `git_objects`
- `git_lfs`
- `git_logs_reflog`
- `archive_output`
- `checkpoint_output`
- `credential_like`
- `unknown`

路径分类必须先做规范化和大小写不敏感比较，拒绝 `..` 越界和重解析点误归属。若能从已验证 workspace root 得到工作区引用，写 HMAC `workspace_ref`；不能安全得到时留空，不用盘符、用户名、PID 或路径哈希替代。一个 actor 同时处理多个 workspace 时不得强行合并。

FileIo 事件只能说明读/写发生，不说明全部文件内容已成功读出。`git_objects`/`git_lfs`/`git_logs_reflog` 与 archive/checkpoint output 的时间关联可形成 E1 `package_observed`；单独读取不能形成上传 Finding。

### 4.3 归档与凭证

压缩/加密输出由以下有限信号组合判定：文件创建或写入、已知受限扩展名/目录、大小变化和同一 actor 的时间窗。不得执行归档文件解密或内容扫描。出现归档输出最多写：

```text
observation_kind = package_created
stage = package_observed
evidence_level = E1
```

只有独立 adapter 或明确可观测的 credential/presigned-upload preparation 才能写 E2；ETW 文件写入本身不能产生 E2。

### 4.4 网络与目的地

W0 采用原生 IP Helper/GetExtendedTcpTable 等 API 获取当前 TCP connection snapshot；PowerShell `Get-NetTCPConnection -OwningProcess` 仅用于人工诊断。它最多产生 `connection_established/E3`，不能产生 E4。

W1 可将 ETW 进程事件与连接快照按 `(pid, creation_time, time_window)` 关联；不得按 PID 单独猜测。W2 使用 WFP ALE 层捕获连接建立/关闭、进程归属和规范化 endpoint。destination 只写闭集：

```text
vendor_api | object_storage | telemetry | eval | model_api | unknown
```

harness 只允许保存规范化 hostname（无 path/query/token）；无法经过受限 allowlist 分类时写 `unknown`。对象存储连接单独不能产生 SV709。

E4 需要进程归属可信且有出站字节计数。若 WFP 只提供连接状态、或计数来自无法归属的系统代理，最高仍为 E3。不得记录包正文、TLS 明文、端口之外的敏感协议字段。

## 5. ETW 方案（W1）

### 5.1 Session 与 provider

首选实时 consumer session，不写 `.etl` 持久文件。FileIo 需要按 Microsoft 文档的 kernel File I/O 类别开启；Process/Image 用于 process creation、exit、image identity 和 creation time 关联。只在 Trust monitor 开启期间创建 session，关闭后停止并清理。

### 5.2 事件字段

允许进入内存事件结构的字段：时间戳、PID、父 PID、process creation time、operation kind、规范化路径分类、读/写方向、可用的大小、provider/event ID、session sequence。原始 path 仅在短生命周期内用于分类；不得进入日志、异常、调试响应或持久化。

### 5.3 丢失与反压

ETW buffer、consumer queue 和 batch writer 都必须有上限。任一层出现 lost event、buffer overflow、decode error 或 sequence gap：

1. 增加 `event_loss_count` 和 `coverage_reason=event_loss`；
2. 当前窗口标为 `partial/degraded`；
3. 不用补采或猜测填充缺失 observation；
4. 恢复后可继续采集，但不能把窗口恢复为完整覆盖。

不启用全局 autologger、boot tracing 或第三方 provider；provider 不可用时明确返回 capability unavailable。

## 6. WFP 方案（W2）

### 6.1 连接层

WFP 先实现 ALE connect/flow 事件和进程归属。必须同时保留 process creation time、方向、协议、地址/端口、分类结果和 attribution confidence。IPv4、IPv6、DNS 解析失败、短连接和连接重用都要有独立 fixture。

### 6.2 字节层

只有经 Windows 版本验证的 transport/stream counters 或签名 callout 能把字节计数归属于 actor 时，才允许写 E4。WFP 连接事件、TCP state、socket buffer 或应用层“上传成功”日志都不能单独写 E4。callout/driver 路径另需驱动签名、安装、升级、卸载和安全评审。

### 6.3 代理与系统服务

若连接由浏览器、企业代理、VPN、系统服务或容器发出，且无法将出口字节归回原始 Agent，保留：

```text
destination_class = <classified or unknown>
actor attribution = partial/unknown
evidence_level <= E3
coverage_state = partial
```

不得因为目的地 hostname 与上传服务相同而把多个 actor 合并。

## 7. Minifilter 高保证层（W3）

minifilter 仅作为可选高保证安装包，不随默认桌面应用安装。它是内核组件，必须具备：微软签名/企业签名流程、管理员同意、版本兼容矩阵、安全响应和卸载/恢复路径。实现前要单独完成威胁建模、性能压测和隐私评审。

minifilter 仍只上报事件摘要和分类，不上报文件内容。它能增强“某进程确实读取/写入了某类文件”的证据，但必须与 WFP 进程归属和字节计数分别验证后，才可生成 E4；驱动本身不能产生 E5。

## 8. 与 Agent trajectory 的边界

`CanonicalSession.tool_calls` 中的 `tar/zip/curl/ossutil/rclone/scp` 等只在 domain 层生成闭集 `IntentHint`。Windows runtime 不读取 shell 文本来“补强” ETW/WFP 结论，也不把 `IntentHint` 写入 `trust_observations`、MCP、export 或 `provenance_json`。

只有 process group 已由 Windows identity 规则验证，且 actor/workspace 使用本机 HMAC 引用时，未来才可把 hint 作为同一 Incident 的 `context`。它不能升级 stage/evidence、产生 SV70x 或通知；缺 join 条件则保持 `partial`。禁止用 harness、PID、session_id、trajectory_id 或相近时间猜测归并。

## 9. 权限、隐私与数据保留

1. 默认普通用户、默认关闭；不为提高覆盖而静默提权。
2. 数据目录、引用密钥和本地 authority 的 ACL 必须仅允许当前用户（或应用明确的服务账户）访问；拒绝继承到普通用户/Everyone 的宽权限。
3. ETW 默认 realtime only；显式诊断模式若写 `.etl`，必须告知用户、限制目录和时长，停止后自动删除，且不得进入 authority/MCP/export。
4. 原始 path、PID、命令行和 raw endpoint 只存在于短生命周期内存结构；持久化只保留 HMAC 引用、闭集分类、计数、时间、collector/version、coverage 和丢失统计，以及不含 path/query/token 的规范化 hostname（若对应 observation 需要）。
5. 采集器崩溃、队列溢出和异常消息必须经过脱敏；禁止把原始 Windows event payload 写入日志或崩溃报告。
6. 继续遵守离线产品政策：任何 Trust observation、Finding、执行环境标识或用户数据都不得随价目表/版本检查出网。

## 10. 能力状态与 IPC 合同

现有 `trust_monitor_status`、`save_trust_monitor_config`、`trust_runtime_snapshot` 保持命令兼容；Windows 扩展只增加脱敏字段：

```json
{
  "platform": "windows",
  "capabilities": ["windows_user_snapshot", "windows_etw_partial"],
  "coverage_state": "partial",
  "collector_id": "windows-etw-v1",
  "event_loss_count": 0,
  "byte_attribution": "unavailable|partial|verified",
  "process_attribution": "low|medium|high",
  "requires_admin": false,
  "driver_state": "not_installed|not_required|pending|active|failed",
  "last_error_code": "typed_enum_or_null"
}
```

`last_error_code` 必须是闭集枚举，例如 `permission_denied`、`provider_unavailable`、`buffer_overflow`、`unsupported_windows_version`、`driver_not_installed`；不得回显 Win32 message、路径或原始 event payload。Windows 实现不应另建 Windows 专属 Trust schema；现有 `TrustObservation` 字段足以表达上述投影。

## 11. 性能与可靠性目标

在代表性开发仓库和多进程 Agent workload 下：

- W0/W1 平均 CPU 目标小于 1%，常驻内存目标小于 100 MiB；
- 原始事件队列、归一化队列和批量写入队列均有硬上限；满载时丢弃原始事件并提高 coverage，不阻塞 Agent；
- 从事件到本地脱敏 observation 的目标延迟 p95 小于 5 秒；用户关闭后最多约 2 秒停止下一次采集；
- 单个 process group、workspace 和时间窗的 observation 数、scope 类别和字节计数必须有上限，避免恶意事件导致内存增长；
- collector 崩溃可重启但不能自动把历史缺口标为完整；重启后新 session 使用新的 `collector_session_ref`。

## 12. 降级矩阵

| 情况 | 保留事实 | 最高等级 | coverage | 禁止结论 |
|---|---|---:|---|---|
| 仅能读取当前 TCP snapshot | 连接/endpoint/进程快照 | E3 | partial | E4、E5、SV709 单凭连接 |
| ETW provider 无权限 | 已有 W0 事实 | E3 | degraded | “未发生读取/打包” |
| ETW 丢事件/队列溢出 | 丢失前已验证事实 | 原等级 | degraded | 补齐缺失链 |
| PID reuse 或父链无法验证 | 单进程事实 | E1/E3 | partial | process-group 归并 |
| 代理/系统服务代发 | 连接与 destination（若可分类） | E3 | partial | 原 Agent E4 |
| WFP 无可信字节计数 | connection attempt | E3 | partial | E4 transmitted |
| driver 未安装/签名失败 | W0/W1/W2 已有事实 | 现有等级 | unavailable/partial | 自动提示“安装驱动即可安全” |
| 未发现任何事件 | coverage 状态 | — | not_detected 或 unavailable | “未发生外传” |

## 13. 测试与验收

### 13.1 单元与黄金测试

- 使用合成 ETW/WFP records，不把真实路径、域名、命令行放入 fixtures；验证 decoder、大小写路径分类、重解析点、IPv4/IPv6、短连接、重复和时间窗。
- 验证 PID reuse、creation time、父链断裂、broker/proxy attribution、多个 workspace 不合并。
- 验证 event loss、buffer overflow、provider unavailable、permission denied、停止/重启和幂等 batch。
- TrustObservation redacted projection 加入 Rust golden；若 Python 有对应投影，增加 byte-lockstep；不要求 Python 模拟 ETW 原始采集。
- 运行现有 `cargo test --release`、`cargo clippy --release --all-targets -- -D warnings`、Python unittest、golden parity 和 `git diff --check`。

### 13.2 Windows 集成测试

Windows CI 至少覆盖：

1. 非生产临时工作区中生成 `.git` history、archive/checkpoint 输出，确认只能得到 E1；
2. 本地 loopback/test server 连接，确认 W0/W1 只能 E3；
3. 可控 WFP fixture 验证 destination class、process attribution 和 verified bytes 的门槛；
4. 企业代理/浏览器 broker 场景降级为 partial；
5. 普通用户、拒绝权限、禁用 provider、事件丢失、应用退出和机器睡眠恢复；
6. 未安装/签名失败的 minifilter 不影响桌面应用启动；
7. authority、MCP、redacted/private export 中不存在原始 path、PID、命令、请求体、凭据或 ETW payload。

W3 驱动测试必须在隔离 Windows runner 进行，不得通过关闭安全策略或签发临时未签名驱动混入普通 CI 门槛。

## 14. 分阶段实现清单

### W0：低权限快照（首个 Windows PR）

- 提取平台无关 monitor interface；实现 process identity、TCP snapshot、HMAC actor/workspace refs。
- 只产生 E1/E3；补充 Windows capability/coverage IPC 字段。
- 通过 PID reuse、IPv4/IPv6、代理和权限降级测试。

### W1：实时 ETW（第二个 Windows PR）

- 实现 realtime ETW session、FileIo/Process/Image decoder、有界队列和 lost-event 状态。
- 以分类后的 scope 生成 `package_created/read_observed`；禁止原始 path 落库。
- 通过 synthetic ETW golden 和 Windows CI integration。

### W2：WFP 归属与字节（单独评审）

- 先交付 ALE 连接归属；只有 verified byte counter 后才开启 E4。
- 增加代理、VPN、系统服务和多进程 sidecar 的 coverage fixtures。
- UI 明确显示 `byte_attribution=unavailable/partial/verified`。

### W3：高保证驱动（不随 beta.4）

- 完成驱动威胁建模、签名、安装/卸载、升级、性能、恢复和隐私评审。
- 仅在用户明确安装并批准后开启；任何失败都安全回落到 W0/W1/W2。

## 15. 发布门槛

Windows Trust 可以标为可用，必须同时满足：

1. Windows CI 通过 W0/W1 的权限、丢失、PID reuse、proxy 和停止恢复测试；
2. IPC/UI 能显示 capability、coverage、permission、event loss、byte attribution 和 driver state；
3. E1/E3/E4 的映射分别有脱敏 fixture 和 golden，且没有把“连接”升级为“已传输”；
4. Windows 运行时不写原始路径、命令、PID、ETW/WFP payload，不发出任何用户数据；
5. `trust_correlator`、SV702/SV705/SV709 和通知门槛不因 Windows 分支而改变；
6. W1/W2 失败时真实显示 `partial/degraded/unavailable`，绝不显示“未发现外传”；
7. W3 未完成时不得以 W0/W1/W2 的覆盖描述暗示高保证文件监控。

在上述门槛全部满足前，Windows Trust 的产品文案只能是“Windows runtime 尚未提供或仅提供有限覆盖；历史 profile 审计仍可用”。

## 16. 官方实现参考

- [Event Tracing Portal](https://learn.microsoft.com/en-us/windows/win32/etw/event-tracing-portal)
- [About Event Tracing](https://learn.microsoft.com/en-us/windows/win32/etw/about-event-tracing)
- [File I/O ETW events](https://learn.microsoft.com/en-us/windows/win32/etw/fileio)
- [NT Kernel Logger constants](https://learn.microsoft.com/en-us/windows/win32/etw/nt-kernel-logger-constants)
- [Event tracing sessions](https://learn.microsoft.com/en-us/windows/win32/etw/event-tracing-sessions)
- [About Windows Filtering Platform](https://learn.microsoft.com/en-us/windows/win32/fwp/about-windows-filtering-platform)
- [WFP architecture overview](https://learn.microsoft.com/en-us/windows/win32/fwp/windows-filtering-platform-architecture-overview)
- [Get-NetTCPConnection](https://learn.microsoft.com/en-us/powershell/module/nettcpip/get-nettcpconnection?view=windowsserver2025-ps)
- [Process Snapshotting](https://learn.microsoft.com/en-us/windows/win32/api/_proc_snap/)
- [File system minifilters](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/about-file-system-filter-drivers)
