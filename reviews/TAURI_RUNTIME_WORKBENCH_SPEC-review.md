# Plan Review: Tauri Runtime Workbench 规格
**Plan File**: docs/TAURI_RUNTIME_WORKBENCH_SPEC.md
**Reviewer**: Codex

## Round 1 — 2026-08-30

### Overall Assessment

这份规格对“状态栏 / 工作台 / 静态报告”的产品分层和不引入 Node/HTTP/daemon 的近期边界判断基本合理，也明确意识到了空态、数据过期、非 append-only 日志和单一 state 写者等真实风险。但它尚不是可直接实施的计划：R1 没有能持续产出新鲜 state 的责任链，R2/R3 存在前置依赖倒置，而 Python/Rust “收缩后并行”更直接与 `CLAUDE.md` 的永久差分锁步硬限冲突。在数据生产与所有权、跨实现验收矩阵、会话身份/去重、持久检查点和 UI 异常态被写成可验收合约前，不建议进入 R1 实施。

**Rating**: 5/10

### Issues

#### Issue 1 (Critical): R1 只刷新读者，却没有定义谁持续产出新鲜 state

**Location**: §4.2 约束 3（“Python `oneline` / state 层继续是当前持久 state 的唯一写者；Tauri 第一阶段只读”）；§8 R1 范围（“5 分钟 timer + 手动刷新”、读 `alert.json`/`oneline.json`）；R4 才引入 `SessionMonitor`。

R1 的 timer 只会重读文件，不会让 `alert.json`、`oneline.json`、`today.json`、`month.json` 或 `sessions.jsonl` 产生新内容。当 SwiftBar 被替代后，如果没有另一个调度者运行 Python `oneline`/`dsh_autosync.py`，所谓“自动刷新”实际上只是反复显示旧快照；这与“可靠状态栏”的目标直接冲突。

**Suggestion**: 在 §4.2 增加“数据产出责任矩阵”，逐个列出每个 state 文件的产出者、触发者、频率和生命周期。R1 必须明确二选一：要么 Tauri 只调度现有 Python 唯一写链（不复制规则，且复用现有锁/幂等合约），要么将 R1 明确降级为“需外部 writer 的只读 viewer”并保留 SwiftBar/其他调度者。增加“禁用 SwiftBar 后连续运行一个会话，5 分钟内 state 和 UI 都确实变化”的端到端验收。

#### Issue 2 (Critical): Python/Rust 边界决策违反仓库的永久差分锁步硬限

**Location**: §0 第 36–39 行（“长期目标不是‘双语言全量镜像’”）；§7.1 表格中“仅在零安装 Skill 必须支持时保留兼容实现”和第 323–24 行“收缩后的平行”；§9 “只要求公开/便携契约做差分”；§11 决策 6。

`CLAUDE.md` 明确要求 Python/Rust 永久平行、公开输出字节级差分，并要求规则变更在 Rust core、Python 实现以及 DSH 所用 wasm 中锁步。规格将“是否需要 Python”交给后续开发者判断，会使新的会话规则、cost/coverage/finding 语义逃出现有差分门禁。桌面编排可以 Rust-only，但纯规则和公开语义不可以。

**Suggestion**: 重写 §7.1 为两类清单：① Tauri 窗口、IPC、watcher、应用自有 cache 等编排/I/O 可 Rust-only；② 任何会影响 `CanonicalSession`、Coverage、Finding、Cost、budget、date/model fold 或公开 JSON 的纯语义都必须按 `CLAUDE.md` 保持 Python↔Rust 字节锁步，DSH 涉及部分同步重建/验证 wasm。删除“收缩后平行”的政策变更，或者先单独修改 `CLAUDE.md` 并给出与现有发行渠道兼容的迁移 RFC；本规格不应暗中改写仓库硬限。

#### Issue 3 (Critical): R2 在关键后端合约出现前就承诺工作台

**Location**: §3.3 第 149–50 行（Tauri 页面“从 Session Store 获取最新数据”）；§8 R2 第 372–75 行（会话列表、Codex/DSH 审计、Token 日历、导出）；R3 第 387–91 行才引入 `SessionStore`、source adapter、`list_sessions` 和 `read_session`。

R2 的页面和导出功能在数据来源、会话列表、会话详情和查询模型存在之前无法交付。如果 R2 临时直读文件或 HTML，就会产生一条注定在 R3 被推翻的第二数据通路，同时破坏“前端只渲染 Rust 命令返回数据”的边界。

**Suggestion**: 将 R3 拆成 R2a“最小可查询 SessionStore + 版本化 DTO + `list/read` IPC + 冻结 fixture”和 R2b“工作台 UI/导出”，再将 cursor/checkpoint/watcher 优化留给后续阶段。如果坚持原顺序，则必须把 R2 降为只消费冻结 JSON 的 UI 原型，不宣称已接入真实会话。

#### Issue 4 (High): adapter、core 与 SessionStore 的单一职责边界仍然混淆

**Location**: §4.2 图中“执行环境日志 / App Server / DSH projection → adapter → `CanonicalSession + cost + coverage + findings`”；约束 1 又说这些语义由 core 定义；§5.2 说 core “只接收已规范化的数据并做纯计算”。

图示可被理解为 adapter 直接产出 cost/findings，这会让 Codex adapter、DSH projection 和 Tauri 文件 adapter 各自带计算逻辑。对 DSH 而言，projection 本身已在执行环境侧通过 wasm/core 计算；规格没有说 Tauri 是信任已计算投影、重算原始事件，还是混合两者。这是潜在的“第四份计算”入口。

**Suggestion**: 将管线改画为“SourceReader → HarnessNormalizer（只做词汇/schema 转换并报 coverage/unmetered）→ `agent-vitals-core`（唯一纯规则计算）→ versioned `SessionReport`→ SessionStore”。对 DSH 单独写明两种合法路径及优先级：信任带 `contract_version`/`engine_version` 的 wasm projection，或读取原始事件后用同一 core 重算；不得在 adapter/SessionStore/UI 内再价或再判定 finding。

#### Issue 5 (High): checkpoint 持久化与“不制造第二 state 写者”之间没有可实施边界

**Location**: §4.2 把 SessionStore 定义为“Tauri 内存中的只读查询模型”；§5.2 使用 cursor/fingerprint/checkpoint；§8 R3 验收要求“重启 Tauri 不重复累加”；R4 要求 monitor 不制造第二 state 写者。

纯内存 SessionStore 在重启后丢失 cursor/checkpoint；持久化它们又会让 Tauri 成为一个文件写者。这不一定违反“单一 state 写者”，但必须区分权威业务 state 和可丢弃的应用 cache；当前文档没有这条界线，实施者可能把 checkpoint 写进 Python state 目录，或每次重启全量扫描大日志。

**Suggestion**: 明确定义 Tauri 自有、可删除、带 schema/engine/source-fingerprint 版本的 cache 目录，且严禁写入 `~/.agent-vitals/state` 的权威文件。规定原子写、损坏回退、版本失效、源文件截断/替换时的重建规则，并在 R3 加入“删除 cache 只影响性能，不改变最终字节输出”的验收。

#### Issue 6 (High): 增量管线忽略了 checkpoint 只能位于 turn 边界的现有合约

**Location**: §5.2 “cursor/fingerprint → 增量 fold”；§5.3 第 247–54 行（变更后 0.5–2 秒更新，并笼统要求 `fold_resume(checkpoint, appended) == fold(all)`）；§8 R3 的 checkpoint/cursor 范围。

`CLAUDE.md` 明确说现有 `UsageFoldState` 只保证 turn 边界恢复，同 `(turn, step)` 的 `last` 去重槽没有序列化；中途 checkpoint 可导致重复计费。watcher 的任意文件 append 并不等于 turn 已结束，所以当前目标延迟与可恢复语义不能同时默认成立。

**Suggestion**: 在 §5.2 加入边界算法：只在已验证的 turn 边界持久 checkpoint，活跃 turn 保留可重放尾部，每次 append 从最后边界重 fold；无法识别边界则全量回退。如果确实需要中途 checkpoint，必须先扩展 checkpoint 序列化所有去重状态，并在 Rust/Python 字节差分及 wasm 回放中通过后才改规格。

#### Issue 7 (High): 跨来源会话身份、去重和接管策略缺失

**Location**: §4.3 同时把 Codex rollout 和 App Server 定义为同一会话的 live/回放路径，把 DSH projection 和已落盘会话定义为两条路；§5.4 只用未定义的 `session_id`。

当 App Server 断开后回退到 rollout、重连后再接管，或 DSH projection 与 post-hoc 日志同时可见时，系统需要知道这是同一逻辑会话而不是两笔成本。只用执行环境的 `session_id` 也可能在不同执行环境或机器上碰撞。缺少这个合约会导致重复会话、成本翻倍、事件逆序覆盖和 UI 跳转错位。

**Suggestion**: 定义不变的 `SessionKey` （至少包含 harness kind、harness-native id、source profile/machine namespace）以及每条记录的 `SourceRevision`/fingerprint。补充源优先级和接管状态机：App Server live 优先、rollout 用于回放/补洞，不按总量盲合并；projection 与日志必须通过可验证的 alias 关系归一。增加断线→回退→重连的无重复 fixture。

#### Issue 8 (High): R1 没有解决多文件快照的逻辑一致性

**Location**: §8 R1 同时读取 `alert.json` 和 `oneline.json`，并“保留最后一次可解析快照”；§9 对原子写的护栏仅是“读取失败时保留最后有效快照并重试”。

单个 JSON 文件可以原子替换，但 Python `oneline` 会依次写多个文件。Tauri 可能读到新 `oneline.json` + 旧 `alert.json`，或者在某一个文件失败时把两个不同会话/时点的“最后有效”值组合起来。这不是损坏 JSON，却会产生看似正常的假一致数字。

**Suggestion**: 为由同一次 `oneline` 产生的文件增加共享 `snapshot_id`/`source_session_id`/`generated_at`/schema version，由唯一 Python writer 写入，Tauri 只在一致时组合；无法一致时分区块显示各自时间戳和“部分更新”，不生成统一健康结论。若暂不改 schema，至少采用 read-before/read-after 的文件 fingerprint 稳定性检查并禁止跨快照拼接。

#### Issue 9 (High): “数据过期”被放在优先级最后，会用旧数据做出高置信结论

**Location**: §3.1 状态优先级“严重 Finding > 预算超限 > 配额紧张 > Agent 运行中 > 正常空闲 > 数据过期”；R1 又要求保留最后快照。

新鲜度不是与 finding/预算并列竞争的第六种业务状态，而是所有业务结论的可信度前提。按现有顺序，一条两天前的严重 Finding 会永远遮住“已两天未更新”，而旧的“正常空闲”也会在过期提示之前显示，违反空态/不可用诚实性。

**Suggestion**: 将状态拆为 `freshness/availability` 和 `health` 两个正交维度。数据 stale/unknown 时使用明显的全局徽标或覆盖主标题，业务结论必须带“截至某时”，不得显示“正常”或“正在运行”。写出 freshness 阈值、不同源各自的时钟、snoozed alert 与 stale 的组合真值表，并纳入 R1 UI 验收。

#### Issue 10 (High): 导出 IPC 信任前端传入的整份 session，且没有完整的隐私合约

**Location**: §5.4 `invoke("export_session_html", session) -> ExportResult`；§3.2 “在浏览器打开/导出 HTML/JSON”；§9 只笼统说“导出保留既有脱敏与 provenance 说明”。

前端传入整份 session 意味着 HTML 可以从被篡改、过期或与 SessionStore 不同版本的数据生成，破坏单一事实源。会话 evidence、备注、本机路径和工具参数可能包含敏感内容；仅限制读取路径并不解决导出脱敏、保存目标、符号链接或打开本地文件的权限风险。

**Suggestion**: 将命令改为 `export_session_html(session_key, expected_revision, export_options)`，后端从 SessionStore 取得对应冻结版本并拒绝 revision 冲突。导出目标必须经 Tauri 原生 save dialog，后端检查规范化路径/符号链接；默认应启用已有 redact 管线，在确认页面列出未脱敏字段、缺失的 cwd/provenance 和“非账单”假设。补充带路径、密钥形态文本、无 cwd 和导出失败的验收。

#### Issue 11 (High): 验收矩阵没有覆盖 wasm/DSH 锁步和已有 TS 执行环境投影

**Location**: §6 计划复用 `dsh-client` 的类型、timeline、格式化和 export；§8 R2 验收只比较“Tauri 与 HTML”；§9 “成本口径分裂”也只写 core/公共 JSON 和 HTML/Tauri fixture。

`CLAUDE.md` 指定了更宽的现实链路：Rust core ↔ Python ↔ wasm `audit_events`/`token_by_model` ↔ DSH adapter/projection，且 DSH 的 `costReportFrom` 仍有一份受测的 TS 计价镜像。只比 Tauri 和 HTML 可以让两个新界面同时忠实地显示一份已经与 DSH/Python 漂移的 JSON。

**Suggestion**: 在 §8 增加明确 CI/手工门禁矩阵：同一 raw fixture 分别经 Python、Rust core/CLI、wasm+DSH projection 生成报告，对 token buckets、cost、coverage 三态、findings、residuals 做字节或逐字段对账；再让 Tauri、DSH UI 和 HTML 消费同一 versioned DTO 做渲染断言。规则变更的 DoD 必须包含 wasm 重建、拷贝和真实 fixture 验证，不能只写“公共 JSON”。

#### Issue 12 (High): Token 日历缺少与会话轴、历史归档和 partial 覆盖率的对账合约

**Location**: §3.2 导航包含“Token 日历”；§8 R2 把日历列入范围；§4.2/§9 只泛称“state 文件”和“core/公共 JSON 为唯一来源”。

`CLAUDE.md` 已把 `token_by_date_model` 定义为负载能力：日历月总额必须与按会话 `token_by_model` 重算相等，未定时样本是唯一合法差异；`month.json` 只是当月，历史月在 `month-archive.json`，且覆盖不全的日子必须标 `partial`。规格没有说 R2 日历读什么、如何查历史月、如何显示 untimed/unpriced/residual，也没有跨投影验收。

**Suggestion**: 在 R2/R3 明确加入 `list_months`/`read_month(YYYY-MM)` 查询、当月与 archive 路由、`priced_day` 和 `token_by_date_model` 的 core 调用。验收应从“界面数字相同”提升为“同一已填充 state 上，日历轴与会话轴按币种/模型对账，差异只能落入明示 untimed/unaccounted 桶”，并覆盖跨月、回填和 partial `by_model` 的既有缺陷场景。

#### Issue 13 (Medium): 会话完结、稳定窗口和导出时机没有状态机

**Location**: §5.3 “完结：明确 run end 或稳定窗口后”；§3.3 “会话结束或用户点击导出时重新生成”；§4.3 同时面向 App Server、明文 rollout 和 DSH zstd/post-hoc。

不同源对“结束”的信号不同：App Server 可有 `turn/*` 事件，rollout 可能只是暂时不再增长，DSH 压缩文件也可能延迟落盘。未定义的“稳定窗口”会导致过早归档、重复 HTML、会话复活后丢失更新，或持续轮询。

**Suggestion**: 定义源无关状态 `Discovered → Active → Quiescent → Finalized → Reopened/Error`，并为每个 source adapter 指定什么证据可以触发转移。稳定窗口必须可配置/可测且只决定调度，不写入纯 fold 输出；导出文件应带 source revision 和 final/provisional 标志。增加“安静后又 append”和“结束事件重复”测试。

#### Issue 14 (Medium): IPC 合约没有版本、分页、类型化错误或并发顺序语义

**Location**: §5.4 的全部 IPC 草案，特别是 `list_sessions(filter) -> SessionSummary[]`、`refresh_sources() -> RefreshResult` 以及“收到事件后再拉取完整状态”。

会话列表可以无界增长，一次返回整个数组会占用 IPC 和 WebView 内存。多个 `session-updated`/过滤变更/手动刷新并发时，旧请求可能晚于新请求返回并覆盖新 UI。字符串错误或空数组也会把“无会话”与“源无权限/协议不兼容”混为同一空态。

**Suggestion**: 定义 versioned DTO envelope（`schema_version`, `store_revision`, `generated_at`, `source_statuses`）、稳定排序和 cursor pagination，并为每个命令定义类型化错误码（not-found、permission、stale-revision、schema-mismatch、source-unavailable、cancelled）。事件应只携带 key + monotonic revision，前端忽略低于当前 revision 的响应，并能取消被新筛选替代的请求。

#### Issue 15 (Medium): 实时性目标没有与大日志成本、背压和常驻资源上限绑定

**Location**: §5.3 定义 0.5–2 秒摘要、2–5 秒审计、1–5 分钟目录重扫；§10 只列出要采集内存/CPU/fold 耗时，没有通过阈值。

这些频率在多个活跃会话、大型 Codex rollout 或 DSH zstd 全量解压时可能同时触发多份重计算。“计算可被合并/取消”没有定义取消点、每源并发上限、饿饿保护、窗口隐藏时的降频或电池策略，很容易把常驻健康工具做成高 CPU 进程。

**Suggestion**: 在 §5 增加调度/背压设计：每会话 single-flight、只保留最新 revision、有界 worker pool、指数退避、全量 rescan 不与同源增量 fold 并发、窗口隐藏/电池模式降频。在 R3/R4 给出可验收预算（例如闲置 CPU、P95 update latency、峰值内存、指定大小 fixture 的全量/增量耗时）和压力测方法，不要只在上线后“采集指标”。

#### Issue 16 (Medium): 主窗口只定义了成功信息架构，没有定义用户可操作的异常/加载流程

**Location**: §3.2 的导航和功能列表；§5.4 的 `monitor-status` 事件；§8 R2 仅验收两次点击和 KPI 一致，没有页面状态验收。

规格没有说首次扫描时页面显示什么、刷新时是否保留旧数据、单个 source 失败时是否降级其他 source、筛选结果为空与源不可用如何区分，也没有权限修复、重试、App Server 重连、导出失败的交互。“Unavailable 不显示为零”只解决数值，没有解决用户下一步做什么。

**Suggestion**: 为总览、会话列表、会话详情、日历、Findings 和数据源页分别写状态矩阵：initial loading、refreshing-with-stale-data、honest empty、partial coverage、source offline/permission denied、schema mismatch、fatal error。每个状态指定文案、保留的数据、CTA（重试/打开设置/查看来源）和无障碍通知方式，并加入 R1/R2 验收。

#### Issue 17 (Medium): “设置 / 数据来源”暗示可编辑，但写权威和配置所有权未定义

**Location**: §3.2 导航中的“设置 / 数据来源”；§4.2 又要求 Tauri 第一阶段只读、路径仅限已注册执行环境根目录；§11 决策 3 禁止第二 state 写者。

用户会自然期待在“设置”页修改预算、源路径、刷新频率或脱敏选项。若它只是只读诊断页，当前名称和快捷操作会误导；若允许编辑 `config.toml` 或执行环境配置，则绕过了规格的只读/不修改执行环境配置护栏。

**Suggestion**: R2 先将其命名为“数据源状态”并明确只读，显示根目录、权限、最后成功、schema 版本和修复指引。如果后续要提供编辑，单独定义 app-owned preferences 与 Python-owned `config.toml`/执行环境配置的边界、写入 API、锁/原子替换、校验和回滚，并作为新里程碑，不要暗含在 R2 里。

#### Issue 18 (Medium): 跨执行环境聚合没有防止不同币种被直接相加

**Location**: §3.1 示例同时使用 `¥` 和 `$`；§3.2 支持跨执行环境/模型/日期筛选与总览；§4.2 约束 5 只说“金额始终携带币种”。

携带币种不等于聚合安全。跨执行环境总览、日历或状态栏“最高消耗”很容易将 CNY 与 USD 数值直接求和/排序，产生无意义的总额或错误预算状态。规格也没有承诺汇率来源，所以不应暗示可转换。

**Suggestion**: 把金额 DTO 定义为不可脱离的 `Money { amount, currency, pricing_basis, estimated }`，所有聚合 API 返回 `by_currency` map，严禁默认汇总不同币种。状态栏预算只能与同币种预算比较；跨币种筛选显示分组数字和“未汇率换算”。增加 CNY+USD 冻结 fixture，断言不出现单一 total。

#### Issue 19 (Low): “本地、匿名或用户可见”的指标策略混淆了存储与上报边界

**Location**: §10 首句（“至少采集本地、匿名或用户可见的诊断指标，不上传原始会话内容”）。

“本地”和“匿名”不是互换概念：匿名指标仍可能被上传，而会话时间、source 数、错误频率与使用路径的组合可以成为指纹。未定义是否上传、默认值、保留期、查看/删除方式和用户同意。

**Suggestion**: 将 R1/R2 的默认定为“仅本地、不上传”，写明存储路径、保留期、大小上限以及 UI 中的查看/清空入口。如果未来需要遥测，作为独立决策门，要求明确 opt-in、字段 allowlist、端侧聚合和可审计 payload，不能以“匿名”一词代替方案。

### Positive Aspects

- 三个产品面的职责分工清晰：状态栏用于一瞥，主窗口用于决策，单文件 HTML 用于归档/分享/降级，避免了把全量 Dashboard 塞进托盘弹层。
- 不引入生产 Node/HTTP 服务、第一阶段不拆 daemon 的抉择符合当前规模，也给出了何时才需要 daemon 的可观察条件。
- 已明确前端不计价、不读任意路径，并保留币种、定价基础、未计价 token、残差和“估算而非账单”说明，方向上对事实源和用户信任是正确的。
- 没有把文件 watcher 等同于可靠实时协议，对 DSH zstd、非 append-only 源、文件事件丢失和 App Server 长期路线的判断较为克制。
- 提出事件只作轻量提示、完整报告通过 IPC 按 id 重拉，以及先证明 resume/full-fold 等价再接 watcher，这些是良好的性能与正确性起点。

### Summary

最需要优先修订的三点是：

1. 补上 R1 的数据产出/调度责任链；否则 Tauri 只是每 5 分钟重读一份不再更新的旧 state。
2. 撤回与 `CLAUDE.md` 相冲突的“收缩后 Python/Rust 并行”，并把 Python↔Rust 字节差分、core SSOT 和 wasm/DSH 锁步写入每个相关里程碑的 DoD。
3. 先建立最小 SessionStore/版本化 IPC/会话身份与去重合约，再交付 R2 工作台；同时说清 checkpoint cache 与权威 state 的写权分界。

**Consensus Status**: NEEDS_REVISION

---

## Round 2 — 2026-08-30

### Overall Assessment

本轮修订是实质性的：R2a/R2b 已改为先契约后 UI，freshness 与 health 被正交化，turn-boundary checkpoint、app cache/权威 state、SessionKey、版本化 IPC、导出与币种护栏都有明显进步。依照项目所有者的方向，本评审不再将“修订永久 Python/Rust 并行”本身视为缺陷；但三档路线仍存在“档 2 保留零安装 Python 却允许删 Python 规则”的内部矛盾，状态唯一写者也没有 shadow/cutover/fencing/rollback 协议。R1 仍把互相矛盾的 A/B 生产链选项留到实施时决定，因此三个 Round-1 关键关切中，R2 顺序已解决，数据生产链和 Python 责任转移仍未达到可执行门槛。

**Rating**: 6.5/10

### Previous Round Tracking

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 1 | R1 只刷新读者，却没有定义谁持续产出新鲜 state | Partially Resolved | §4.2 增加了责任矩阵和 A/B 选项，但未做选择；B 要保留 SwiftBar，却与“禁用 SwiftBar 后 state 更新”验收矛盾，A 也未定义 session log 发现与 exactly-once 调度。 |
| 2 | Python/Rust 边界决策违反永久差分锁步硬限 | Resolved | 项目方向已明确变更，§0/§7.1 将其升格为分档 RFC，`CLAUDE.md` 也已同步修订；原“不得改边界”的反对不再适用，本轮改审查转移门。 |
| 3 | R2 在 SessionStore 契约前承诺工作台 | Resolved | §8 已拆为 R2a 最小 Store/版本化 IPC 和 R2b UI/导出，并明确 R2a 是前置。 |
| 4 | adapter、core 与 SessionStore 单一职责混淆 | Partially Resolved | 管线已重画，但 HarnessNormalizer 仍“报 coverage/unmetered”，core 又声称产出 coverage；DSH “信任投影”的版本不兼容行为也未定义。 |
| 5 | checkpoint 持久化与单一 state 写者无边界 | Resolved | §5.2 已将 Tauri cursor/checkpoint/index 限定在可删 app cache，禁止写权威 state，并增加失效/重建验收。 |
| 6 | 增量管线忽略 checkpoint 仅限 turn 边界 | Resolved | §5.2 明确只持久 turn-boundary checkpoint、重放活跃 turn 尾部、无法判边界则全量回退；现有 Python/Rust resume 测试也支持该范围。 |
| 7 | 跨来源会话身份、去重和接管缺失 | Partially Resolved | §4.3 新增 SessionKey/SourceRevision/源优先级骨架，但 machine namespace 的生成/持久和 App Server↔rollout、projection↔日志 alias 的可验证规则仍未给出。 |
| 8 | R1 多文件快照逻辑不一致 | Partially Resolved | §4.2 增加 snapshot_id/generated_at 与禁止跨快照拼接，但逐文件写入仍不是原子事务，崩溃重启后也无法找回最后完整 generation；fingerprint 只证明文件稳定，不证明同次产出。 |
| 9 | 数据过期被排在最后 | Resolved | §3.1 已将 freshness/availability 与 health 正交，且 R1 验收禁止 stale 时显示“正常/运行中”。 |
| 10 | 导出 IPC 信任前端 session 且隐私合约不完整 | Partially Resolved | §5.4 已改为 session_key+revision、后端冻结版本、save dialog 和默认 redact，但 redact 覆盖面/失败策略、safe-share/raw 区分与文件打开权限仍未成为可验收合约。 |
| 11 | 验收矩阵未覆盖 wasm/DSH/TS 执行环境锁步 | Partially Resolved | R2a 加了 Python/Rust/wasm+DSH 冻结 fixture 对账，但尚未规定自动 CI 命令、DSH DTO 版本协商和旧插件与新 Tauri/core 并存时的兼容门。 |
| 12 | Token 日历缺少会话轴/历史/覆盖率对账 | Partially Resolved | R2b 增加了日历轴↔会话轴、archive、partial 验收，但 `list_months`/`read_month` 只出现在 §12 对照说明，没有进入 R2a/R2b 范围或 IPC 合约。 |
| 13 | 会话完结/稳定窗口/导出时机无状态机 | Partially Resolved | R3 已列出 Discovered→Active→Quiescent→Finalized→Reopened/Error，但各 source 的转移证据、超时参数和 Reopened 后归档/导出处理仍留给实施者。 |
| 14 | IPC 无版本/分页/类型化错误/并发顺序 | Partially Resolved | §5.4 补了 envelope、cursor、错误码和 revision 忽略规则，但 SourceRevision/session revision/store_revision 的类型与作用域混用，cursor 的快照一致性/失效也未定义。 |
| 15 | 实时目标未绑大日志成本/背压/资源上限 | Partially Resolved | §5.3 加了 single-flight、worker pool、退避和降频，但所谓“§5.3 预算”没有任何数值，R3 验收仍无法判断通过/失败。 |
| 16 | 主窗口无异常/加载流程 | Partially Resolved | §3.2 列出了七态及要求的信息，但尚无逐页“保留什么/文案/CTA/ARIA 通知”真值表和可执行的 UI 验收用例。 |
| 17 | “设置/数据来源”暗示可编辑 | Resolved | §3.2 已改名为“数据源状态（只读）”，并把配置写入推迟到独立里程碑。 |
| 18 | 跨执行环境聚合可能直接相加异币种 | Resolved | §4.2 定义 Money DTO/by_currency，明禁默认跨币种求和，并纳入决策和风险护栏。 |
| 19 | 本地/匿名/用户可见指标边界混淆 | Partially Resolved | §10 已确立“默认仅本地、不上传”和遥测独立决策门，但存储路径、保留天数、大小上限仍只是“需写明”而非已定合约。 |

### Issues

#### Issue 1 (Critical): R1 的 A/B 生产链仍未决策，且选项 B 与强制验收自相矛盾

**Location**: §4.2 “R1 必须二选一”及第 270–277 行；§8 R1 第 493–506 行。

选项 B 的定义是保留 SwiftBar/外部 writer，但无论 A/B 都要通过“禁用 SwiftBar 后 5 分钟内 state 和 UI 变化”，这对 B 在没有另一外部 writer 时不可能成立。A 也不是“启动一个子进程”就能实施：现有 `oneline` 必须接收具体 `session_log`，且重复对同一日志运行会重复累加 month/today/history；R3 才引入的源发现和去重不能被 R1 暗中依赖。

**Suggestion**: 在进入 R1 前删除“二选一”延迟决策。若选 B，将验收改为“指定的外部 writer 运行时，Tauri 在 5 分钟内反映更新”，并在 UI 明示 writer 依赖/最后成功时间；若选 A，将最小的源发现、session-id 去重、失败重试和 exactly-once ledger 前移到 R1，明确是调度 `dsh_autosync.py` 还是 `oneline <path>`，并用已填充 state + 同一 session 连续多 tick 的 fixture 断言不重复记账。

#### Issue 2 (Critical): 档 2 同时承诺零安装 Python 运行时和删除 Python 规则，责任转移不可闭合

**Location**: §0 第 51–58 行；§7.1 三档表的“档 2（R3–R5）”行及第 453–56 行。

档 2 说 Python 仍是便携 Skill 入口与状态写链，纯规则仍做 Python↔Rust 字节锁步；同一行的转移条件却说规则迁入 core 并通过锁步后即“删 Python 侧实现”。在 ClawHub/OpenClaw 尚不能依赖 Rust binary 的档 2，删除 Python cost/budget/behavior/usage 实现会直接使便携入口无法计算；而若 Python 仍保留镜像，则“删除”并未发生。

**Suggestion**: 把每个能力的生命周期明确为 `Python authority → Rust authority + Python mirror → Python wrapper over shipped Rust artifact → Python entry removed`。在档 2 中只允许前两态：Rust core 成为权威，但只要零安装 Python 产品仍要独立运行，Python mirror 就不得删除。“Python wrapper 调 Rust”必须等 ClawHub binary 依赖/打包条件成立后才进入档 3，并通过无 binary/offline 降级验收。

#### Issue 3 (Critical): 唯一 state 写者的 Rust 接管缺少 shadow、fencing、cutover 和 rollback 协议

**Location**: §4.2 第 266–68 行；§7.1 档 3；§7.2 条件 4；§8 R5 第 596–601 行。

“Rust 写链有稳定实现并与 Python 字节锁步”只证明单次输入输出，不证明已填充 state 上的跨调用不变量、崩溃中断、归档/回填和双进程并发。迁移期若 Python CLI 和 Tauri/Rust 都能写，文件锁只能防同时写损坏，不能防同一会话被两个 writer 依次累加两次。计划也没有说接管失败后如何恢复 Python 而不丢或重记已由 Rust 写入的证据。

**Suggestion**: 在档 3 前增加独立的 writer-transfer 里程碑：① Rust 以 shadow mode 在非权威 generation 上重放真实、已填充 state，对比连续多次调用的每个文件；② 写入带 `writer_epoch`/`owner` 的权威 manifest，Python 与 Rust 都必须拒绝非当前 owner 写入；③ 停写、备份、schema 迁移、原子切换后再启动新 writer；④ 保留可测 rollback，用 session ledger 确保回滚后不重放已接管记录。验收必须包含切换中崩溃、旧 Python CLI 误写、回滚和跨月回填。

#### Issue 4 (High): 三档范围与新里程碑编号互相冲突

**Location**: §7.1 表格将档 2 标为“R3–R5”、档 3 标为“R6+”；§8 却只有 R0–R5，且 R5 明确称为“档 3 可选”；R5 又说“不等同于删除 Python Skill 包”。

这不是单纯编号瑕疵：实施者无法确定 R5 到底仍是档 2 的锁步收缩，还是档 3 的 binary/state-writer 接管；“桌面去 Python”与“退役 Python 分发形态”也被压在一个标签下，但两者的影响范围和可回滚性完全不同。

**Suggestion**: 不要用预测性的 R 编号定义档位，改成独立 capability gates。至少拆成“Desktop runtime Python-free”和“Portable Python distribution retired”两个里程碑；前者可以在 Python Skill 仍存时完成，后者必须等 ClawHub binary 依赖、writer transfer 和独立 oracle 到位。然后统一 §7.1、§7.2、§8 和 §12 的编号/映射。

#### Issue 5 (High): Python 退役后“把差分守卫改成 Rust 测试或随 Python 退役”会失去独立 oracle

**Location**: §7.1 档 3 转移条件（“差分守卫改造成 Rust 侧测试或随 Python 一起退役”）；§7.2 条件 4–5；§8 R5。

将预期值改为由同一 Rust 实现生成/验证，只能防回归到已写断言，无法继续提供跨实现独立性。“随 Python 一起退役”更会在风险最高的 writer/发行切换后同时删掉防腐层。退役生产 Python 运行时不等于必须删除语言无关的冻结契约和历史参考输出。

**Suggestion**: 在档 3 出口条件中保留一套不依赖生产 Python 的独立 oracle：签名/审核过的 raw fixtures + 非由当前 Rust 运行时现场生成的 byte goldens + JSON Schema/语义不变量 + 历史 Python 最终版本的只读参考输出。规则变更必须人工确认 oracle diff，并增加反例/变异测试；可以不在用户机器运行 Python，但不得让 Rust 成为自己唯一的判卷人。

#### Issue 6 (High): R2a 只定义 source adapter 接口，没有定义 SessionStore 如何首次被真实数据填充

**Location**: §4.3 来源表；§8 R2a 第 518–28 行；R3 第 564–66 行才引入受控监控和周期 rescan。

R2a 要求 `list_sessions`/`read_session`、去重和冻结报告，却只有“source adapter 接口”而没有初始 discovery/full-scan 的实体范围。如果真正的 Codex 根目录扫描、DSH 历史发现、zstd 降级都留给 R3，R2a Store 只能装 fixture，R2b 就仍无法展示真实会话；如果 R2a 暗中实现这些，其范围和性能影响又未被估算。

**Suggestion**: 在 R2a 增加“initial population”子阶段和按 source 的 capability 表：每个源的根目录发现、支持格式、是否全量读、无权限/损坏行为、输出的 coverage 与资源上限。R2a 验收必须在隔离的仿真 HOME 中用 Codex + DSH 真实格式语料重建索引，重启后能从空 cache 得到稳定、相同的会话列表。R3 只增加 watcher/增量调度，不再首次引入数据发现。

#### Issue 7 (High): HarnessNormalizer 与 core 仍同时声称 coverage/unmetered 所有权

**Location**: §4.2 管线第 217–25 行（HarnessNormalizer “报 coverage / unmetered”，core 又产出 `CanonicalSession + cost + coverage + findings`）；约束 1。

coverage 是用于区分 MeasuredZero 和 Unavailable 的规则语义，不应由 adapter 直接声明结果。但 adapter 又必须报告它观察到了哪些原始信号、哪些 usage-shaped 事件没有被识别；若两者都叫 coverage/unmetered，实施者容易在 normalizer 提前把“读不到”翻译为 0，再让 core 忠实地对假 0 计算。

**Suggestion**: 定义中间类型 `NormalizedEvidence { events, observed_signals, unsupported_signals, usage_shaped_unparsed }`；HarnessNormalizer 只产出观测账本和未解析原始记录，不产出 Coverage/RuleOutcome。core 是将该账本转为 Measured/Unmetered/Unavailable 及 residual sentinel 的唯一地方。用“无原生 turn 边界但有非零事件计数”的 fixture 断言不会落成 MeasuredZero。

#### Issue 8 (High): snapshot_id 写进多个文件仍不构成可恢复的原子 generation

**Location**: §4.2 约束 6 第 252–56 行；R1 “保留最后一次可解析快照”；§9 “多文件快照逻辑不一致”护栏。

共享 id 能检出新旧混用，但 writer 在替换第三个文件时崩溃，磁盘上就只剩一组混合 generation；重启后 Tauri 的内存“最后有效”已丢失。read-before/read-after fingerprint 只能证明每个文件在读取期间没变，不能证明它们来自同一次 oneline。

**Suggestion**: 将快照协议改为可提交 generation：先在新 generation 目录/临时名下写全部文件并计算 hash，最后原子替换一个 `current-snapshot.json` manifest/pointer；读者只读 manifest 指向且 hash 完整的 generation，忽略未提交临时代。为 SwiftBar/旧 CLI 定义双读兼容期，并测试每个文件写入点崩溃、重启、清理孤儿 generation 后仍能回到最后完整快照。

#### Issue 9 (High): “信任带版本的 DSH wasm 投影”没有版本兼容和降级规则

**Location**: §4.2 “对 DSH 明确两种合法路径”第 234–36 行；§5.4 versioned envelope；R2b “Tauri、DSH UI、HTML 消费同一 versioned DTO”。

只有 `contract_version`/`engine_version` 字段不能判定是否可信。用户可以同时运行旧 DSH plugin 投影、新 Tauri 和新 core；若字段增加、规则版本变化或定价表更新，当前计划没有说是拒绝、向下转换、从原始日志重算，还是把旧值当新值。“优先信任”可因此把版本存在误当成兼容证明。

**Suggestion**: 为 `contract_version`、`engine_version`、`pricing_version` 分别定义语义和兼容矩阵，指定最低/最高支持版本与字段进化规则。不兼容时只能：有原始事件则用本地 core 重算，无原始事件则显示 `schema-mismatch/Unavailable`，不得默认为空或沿用旧语义。在 R2a 增加 N-1/N/N+1 投影 fixture 和独立升级顺序测试。

#### Issue 10 (High): SessionKey 中的 machine namespace 和跨源 alias 只有名称，没有可重放的派生算法

**Location**: §4.3 第 291–300 行；R2a “会话身份/去重”和“断线→回退→重连 fixture”。

machine namespace 如果是每次安装随机生成，重装/恢复 cache 后同一日志会变成新会话；如果直接 hash 用户名/路径，又会把可识别信息稳定泄漏到导出。App Server native id 与 rollout 文件 id、DSH projection id 与落盘文件名也未必然相同；“通过可验证 alias 关系归一”没有指定可验证证据。

**Suggestion**: 在 §4.3 增加按 source 的 identity 表，逐个给出 native id 字段、规范化、alias join key、缺场行为和碰撞处理。machine namespace 应是持久在 app-owned config、可备份/迁移但不默认导出的随机 UUID；重装丢失时明示为新 profile。当 alias 无可证据 join key 时，宁可显示“可能重复”也不按时间/路径猜测合并。

#### Issue 11 (High): SourceRevision、session revision 和 store_revision 被混成一个 `revision`

**Location**: §4.3 定义 `SourceRevision / fingerprint`；§5.4 的 `read_session(session_key, revision)`、`store_revision`、`session-updated {session_key, revision}` 和 `expected_revision`。

SourceRevision 是可能不可比较的源 fingerprint，StoreRevision 是整个查询快照的单调序号，而导出所需的 session revision 是单个会话的乐观并发版本。若三者复用同一字段，前端可能用一个文件 hash 做大小比较，或因其他会话更新而错误拒绝当前会话导出。cursor 也无法知道应绑定哪个快照。

**Suggestion**: 定义强类型 `SourceFingerprint`(不透明、仅相等比较)、`SessionRevision`(每 session 单调)、`StoreRevision`(每 Store 快照单调)和 `Schema/EngineVersion`。`session-updated`/`read_session`/export 只用 SessionRevision，分页 cursor 绑定 StoreRevision + filter hash，源截断/替换只替换 SourceFingerprint 并触发新 SessionRevision。说明重启后修订号是持久还是换 epoch，并测试分页期间其他会话更新。

#### Issue 12 (High): 导出的“默认启用既有 redact”没有定义安全保证范围

**Location**: §5.4 第 398–403 行；R2b “save dialog + redact + 冻结版本”；§9 “本地隐私暴露”护栏。

规格要求测试“密钥形态文本”，却没有说 redact 应删除、阻止、警告还是原样导出。“既有 redact”的合约范围也没有被列出：只隐藏 workspace 路径不代表会递归处理 evidence、notes、tool arguments 和不透明 projection 里的 token/密钥。save dialog 返回路径后再做一次符号链接检查也有检查到打开之间的替换窗口。

**Suggestion**: 定义两个显式模式：默认 `safe-share` 使用字段 allowlist + 结构化递归 redact + 敏感形态扫描，命中时阻止或要求二次确认；`raw-local` 明示警告且不得作为默认。为每个导出字段定义 keep/drop/transform 表，cwd 未知时默认不能声称已安全脱敏。安全写入应使用 save-dialog 授权后的文件句柄或 no-follow/create-new + 同目录原子替换，而不是先校验路径后再重新打开。

#### Issue 13 (High): 档 3 只要求“可靠安装和升级”，不足以保护审计工具的 binary 供应链

**Location**: §7.2 条件 1–3；§7.1 档 3 “ClawHub/OpenClaw 支持声明 binary 依赖”。

这个仓库的便携 Skill 当前强调无网络、无扫描时第三方拉取；将 Rust binary 变成 ClawHub/OpenClaw 强依赖后，“能安装”不能证明下载的是正确产物，也不能防自动更新带来不可逆的字节/schema 变化。一个审计供应链的工具在这里需要比普通 CLI 更强的 artifact provenance。

**Suggestion**: 把档 3 发行门扩展为：每 OS/arch 受支持矩阵、不可变版本 pin、发行签名/校验和、SBOM/构建 provenance、下载前验证、离线缓存/手动安装路径、升级失败回滚与最低/最高兼容版本。在取消 Python 零安装路径前，要用发布产物在断网、签名错误、部分下载、旧架构和回滚场景做端到端验收。

#### Issue 14 (Medium): 性能“预算”仍是待填占位符，R3 的通过条件无法测量

**Location**: §5.3 第 368–74 行；R3 验收“达到 §5.3 预算”；§10 只列指标名称。

§5.3 说 R3/R4 将给出可验收预算，而 R3 又引用§5.3 作为已存在的通过门，形成循环占位。没有数值、测量机器基线、语料大小、冷/热 cache 条件和电池/隐藏窗口模式，“P95”可以在任意环境下被解释为通过。

**Suggestion**: 在 R3 开发前将 §5.3 补成数值表，至少包含闲置 CPU、常驻/峰值 RSS、单/多会话 P95 摘要和审计延迟、全量 rescan 上限、隐藏窗口/电池模式频率。指定两类可复现 fixture（普通与大型/多会话）、参考硬件和运行次数；超标时要有降级策略，不能只记录指标。

#### Issue 15 (Medium): i18n 被当作可复用代码，没有被定义为新工作台的产品合约

**Location**: §6 第 418–31 行只说复用 `dsh-client` i18n；§3.2 新增七种页面状态和 CTA；§4.2 Money DTO 与 §5.4 类型化错误码。

新增的 tray 文案、source/error 状态、日期时区、货币格式、数量复数和无障碍通知不会因为抽出了旧 `i18n.ts` 就自动完整。DSH 执行环境语言和 Tauri OS/app locale 的来源也不同，如果不定 fallback，schema mismatch 等关键错误可能回退成英文 key 或空白。

**Suggestion**: 在 R2b 增加 i18n 合约：首发 locale（至少 zh-CN/en）、locale 选择/回退规则、UTC 事件时间与显示时区的分离、`Intl` 货币/数字/日期格式、复数和参数化错误消息、ARIA live 翻译。CI 要检查语言 key 集合对称和缺键，并对两个 locale 的 loading/empty/error、CNY/USD 和跨日边界做渲染验收。

#### Issue 16 (Medium): 各阶段的目标操作系统不明，但桌面生命周期和路径能力默认被当成跨平台

**Location**: §7.2 条件 1 要求 macOS/Linux/Windows；§3.1/§5.1 使用状态栏、隐藏窗口常驻和主屏行为；R1–R4 没有支持平台矩阵。

如果 R1–R4 仅面向 macOS，计划应明说，否则 Linux tray 环境、Windows 登录启动/窗口关闭语义、文件选择/打开目录、HOME 与 app-data 解析、符号链接/权限检查都会在实施中突然变成阻塞项。档 3 的跨平台 binary 门也不自动意味着 Tauri UI 在三个平台有相同支持。

**Suggestion**: 在 §2/§8 增加按阶段的 OS 支持矩阵。如首发是 macOS，把 R1–R4 标为 macOS-only，将 Windows/Linux UI 作为独立里程碑，而 §7.2 仅保留 Rust CLI binary 的三平台门。若首发就跨平台，则为 tray 可用性、自启动、quit/close/hide、app-data 目录、save/open 和文件权限逐项给出平台验收。

### Positive Aspects

- R2a/R2b 拆分已把 SessionStore、会话身份、版本化 DTO 和 IPC 放到 UI 之前，消除了 Round 1 最明显的路线依赖倒置。
- 项目所有者关于渐进弱化 Python 的方向已被写成显式 RFC，且规格与 `CLAUDE.md` 相互引用；“先证明 Rust 可承担”的原则是正确的，问题在于还需要把原则降成每能力的可执行切换门。
- 对 turn-boundary resume 的范围已与现有 core 合约一致，并将中途 checkpoint 的扩展明确放到差分/wasm 验证之后，没有为了延迟目标放宽正确性。
- freshness/health、Money DTO/by_currency、类型化 IPC 错误、只读数据源页和本地默认指标都明显提升了空态诚实性与用户信任。
- 导出改为后端按 session key/revision 冻结、事件只发 key+revision 再重拉完整报告，是比 Round 1 更健全的 SSOT 和 IPC 边界。

### Summary

最需要在下一轮修订的三点是：

1. 在 R1 开始前做出唯一的 writer/调度选择，并为该选择定义真实 session 发现、exactly-once 与不自相矛盾的端到端验收。
2. 修复档 2 “保留零安装 Python 却删 Python 规则”的矛盾，并把桌面去 Python、Python 规则镜像删除、便携分发退役拆成不同 capability gates。
3. 为状态唯一写者接管增加 shadow comparison、writer fencing、原子 cutover、已填充 state 验收和可测 rollback，同时保留 Python 退役后的独立 oracle。

**Consensus Status**: NEEDS_REVISION

---

## Round 3 — 2026-08-30（用户决策收敛，未跑 codex）

**Consensus Status**: 由用户决策收敛为 **CONVERGED-BY-OWNER**（非 codex 盖章）。

用户于 2026-08-30 明确「是不是可以收敛了，进入开发了」，选择不再消耗 ~2.3M token 跑第三轮 codex 评审。
Round 2 的 16 条 issue 已全部折入修订后的规格（§7.1 四态生命周期 + G1/G2 能力门、§4.2 决策 13 Rust 产出链 + 唯一写者接管协议 + exactly-once、§5.4 safe-share/raw-local 两态、§4.3 强类型 revision、§5.3 数值预算表、§6 i18n 契约、§8 R1a–d 子结构 macOS-only）。待办：R1 开发落地后，将「验收是否兑现规格」作为事实性检查，必要时再补一轮 codex 评审（聚焦 R1 产物与规格一致性，而非继续挑规格措辞）。
