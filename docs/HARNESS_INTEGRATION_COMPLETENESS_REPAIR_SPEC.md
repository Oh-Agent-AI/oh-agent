# Harness 接入完整性与 App 插件投影修复 SPEC

状态：R1 核心代码、合成接入链路及动态 harness 本地健康诊断闭环已交付并通过自动化回归；本机动态插件恢复、第二原生插件与 R3 正式安装/UAT 未完成。不是全量已验收声明。
日期：2026-10-04。审查基线：`main@8ac38e99`。

## 1. 结论与证据边界

存在跨层契约与验收遗漏，但不能把所有缺项归为架构实现故障。
当前分层方向仍成立：harness 负责来源适配，Rust 负责数据与受控投影，Agent Vitals 是宿主，City 是独立前端插件。需要补齐的是动态 harness 从注册到展示的贯通契约，而不是重新把 City 放回宿主，也不是创建独立 City App。

| 环节 | 已核实状态 | 判断 |
| --- | --- | --- |
| 本机 ZCode | 当前数据目录没有 manifest 候选、激活 revision/slot；数据库未找到 ZCode usage；原始 rollout 目录仍存在 | 接入状态缺失；尚无证据确认发生时间或是否由此次安装导致 |
| MiniMax Code | 仓库有 `minimax-code` Trust builtin profile、`MiniMaxWorkspaceIndexV1` 本地证据扫描与合成测试；但不在四个 compiled usage harness 中，没有随包的 `minimax-code` harness manifest，App Plugin descriptor 也只注册 City | Trust/风险信号支持存在；usage/session ingest 不是已交付的专用 harness。若本机有经激活的通用 manifest 才可能走动态接入；本机 active 状态本轮未检查 |
| 激活注册 | `harness_registry.rs` 从 authority 激活 generation 与不可变对象加载；坏对象不回退候选 | 正确边界，应保留 |
| 注册诊断 | `plugin_ingest.rs::plugin_list` 只扫描候选目录；桌面名称命令丢弃 active scan 的错误列表 | 候选、激活、失败、历史来源缺少统一可观测状态 |
| City 数据身份 | `query/app_local.rs:69` 将非四个内置 harness 的 session 身份改为 `unknown` | 与动态 harness 接入目标存在契约缺口；当前投影文档也需一起修订 |
| 名称 | City 的 DSH 名称为 `Agent Vitals`，宿主为 `DeepSeek Harness` | 分散维护产生实际漂移 |
| Findings | City 只返回内置 harness findings，整体标记 partial | 不可直接放开行为审计；应按来源明确能力与覆盖范围 |
| 桌面 manifest 安装 | Rust 有 catalog 命令，但 React 没有调用这些安装命令；官方 index entries 为空 | E09 等原计划延期内容，不是已完成能力的回归 |
| 本地预算/账单 | 当前相关表为空；旧备份有预算配置 | 待人工核对，不能据此认定升级丢失或自动恢复旧值 |
| 文档与验收 | App 计划同时保留 fixture-only 与真实数据状态；部分生命周期记录过时 | 当前规范与历史记录未有效分离，端到端验收不足 |

证据来自源码与本机只读检查，不读取原始日志正文、不导出用户数据。四个内置 harness 均有事实记录，只证明当前有数据，不证明历史完整。候选列表为空不等价于激活列表为空，必须分别查询。

主要代码：`crates/agent-vitals-query/src/sources/harness_registry.rs`、`crates/agent-vitals-ingest/src/ingest/plugin_ingest.rs`、`crates/agent-vitals-query/src/query/app_local.rs`、`apps/desktop/src-tauri/src/lib.rs`、`apps/agent-city/ui/src/cityModel.ts`、`packages/agent-vitals-app-sdk/src/city-ui-projection.ts`。

## 2. 根因与目标

现有设计分别约束了 manifest 激活和插件数据访问，却没有为它们之间的组合定义完整验收条件。支持一种 recipe、测试通过、成功打包，不等于该机器已激活该 harness，也不等于每个数据消费面正确显示它。City 沿用了内置来源词表，安装验收又主要使用内置来源，因此这个缺口没有被覆盖。

本次目标：

1. 为所有 harness 建立统一的 App Plugin 数据契约；内置与热插拔是宿主实现细节，插件不按来源类型分支，禁止 ZCode 或 City 特判。
2. 让 Overview、会话与所有获授权 App Plugin 对同一来源保持身份、名称和窗口统计一致；City 只是首个验收实例，不是契约的定义中心。
3. 缺失或故障有明确原因与恢复路径，不能用空列表、`unknown` 或 fixture 掩盖。
4. 经明确确认恢复本机 ZCode，再通过真实安装包验证；保持现有事实、账单与插件隔离边界。

## 3. 宿主管理清单与状态契约

在 Rust query 层提供宿主可调用的只读来源清单，复用现有注册、校验、生命周期与统计逻辑，不创建第二个授权注册中心。

每项包含稳定 `id`、有长度限制的 `display_name`、来源类型（compiled/manifest）、注册状态、数据状态、稳定诊断码及消费面能力。类型、信任与 billing basis 是独立维度，不能由 `harness:` 前缀推导官方信任。

本节是宿主管理面，不是 App Plugin 数据接口。compiled/manifest、候选、revision、激活 generation 等只用于宿主安装、授权、摄入与排障，不要求插件理解或处理。

注册状态至少区分：`candidate`、`active`、`inactive_history`、`invalid`。数据状态至少区分：`not_ingested`、`ready`、`empty_window`、`source_unavailable`、`ingest_failed`；无法判定时返回 `unknown`，不编造成功或缺失原因。状态应有观测时间，来源故障与窗口为空不可混同。

清单合并候选、激活与历史身份时：

- 候选不授权读取或摄入；仅有效激活 revision 可以触发正常 manifest 摄入。
- active 对象损坏必须显式报告，不得退回可变候选。
- 卸载后历史事实仍可查询，不能因“不活跃”从 UI 消失。历史名称优先取可验证 revision；缺失时使用校验后的 slug 展示并标记元数据不可用。
- 任意事实中的自由文本不能直接变为受信任身份或显示名；无法验证的身份保留统计并进入明确未知来源分组。
- 输出公开诊断码与数量；日志路径、工作目录、raw anchors、原始错误、凭据不得进入插件投影。详细本地排障仍由宿主控制。
- authority 读取失败与“零来源”必须是不同结果；读取过程不自动迁移、修复或重建数据库。

最小宿主入口展示来源名称、注册/数据状态、窗口与诊断建议即可。CLI 可承担本轮安装 preview/confirm；完整市场、远程目录与 E09 向导不作为本次前置条件。

## 4. 与接入机制无关的 App Plugin 数据契约

定义共享 `HarnessPublicIdentityV1`，由 Rust 按声明的数据范围投影。City 与未来官方插件消费同一身份结构，不导入宿主 UI 源码、不访问数据库或 harness 日志。

公开身份建议字段仅为 `id`、`display_name`、`capabilities`，不包含 `origin`、compiled/manifest 或安装/激活状态。插件把 `id` 当作不透明标识，禁止解析其前缀来判断接入机制。capabilities 明确 session statistics、task excerpts、findings 是否可用及公开不可用原因；插件按数据能力渲染，不按 harness 实现类型分支。宿主内部仍执行对应信任、授权与 billing 规则，不把这些决策委托给插件。

统一提供版本化的 `harnesses.list` 与按 `harness_id`、时间窗口请求数据的入口（最终 wire 命名在 R1 定稿）。清单只包括当前插件声明范围内可见的来源，包含可查询的历史来源；未授权候选不进入数据清单。列表与数据响应携带一致性 revision，明确区分请求失败、窗口为空与能力未提供。

热插拔后宿主通过通用失效事件通知活动插件重新获取列表与数据：激活新增来源、卸载停止新摄入但保留历史可查询来源、回滚或摄入更新均不得要求重启插件或重新编译 App。事件只传必要 revision/失效信息；暂停实例恢复时重新校验，不依赖它接收过所有事件。并发列表/数据请求检测 revision 变化并显式重试或返回失效状态，不能拼接不一致快照。注册变化不是独立上传或外部网络通知。

业务投影如 City 场景数据可以继续存在，但必须复用统一 harness 身份与查询规则，不能再私有维护来源白名单。所有官方 App Plugin 均应通过相同宿主接口获得授权数据；不得把宿主管理清单或详细诊断自动授权给插件。

City session 保留经过验证的 manifest harness 身份，引用对应公开身份元数据。两个 manifest harness 不得折叠到同一个 unknown 来源。真正无法验证的身份才降级。DSH 名称统一为 `DeepSeek Harness`，不再由多个组件各自维护动态来源名称。

修改当前 `city:v1` 的身份语义需要显式版本升级：建议登记 `city:v2`，同步更新 Rust handler、SDK 类型、插件 descriptor 与 City consumer；内部开发允许同批替换，不要求保留旧 host 字面量兼容层。通用 IPC 信封仍保持与具体 City DTO 解耦；不把 Rust 代码放进 City 前端目录。

Findings 不因 manifest 激活而开放行为分析。继续保持 compiled 官方行为审计边界；不支持时显示“行为分析未提供”，不能将无返回项解释成“无问题”。成本与模型当前未投影属于已声明 MVP 范围，不在此次自动扩充。

原生独立 WebView、浏览器 iframe 及故障恢复继续保留。新增投影仍检查插件 descriptor、活动实例、method allowlist 与 scope，并在响应交付前复核实例。浏览器预览继续使用 synthetic/redacted fixtures。

## 5. 本机恢复流程

必须先获取用户对实施与本地激活的确认，按现有生命周期执行：

1. 只读核对当前数据目录选择、schema 元数据、激活对象、source availability、现有事实与旧备份差异；确认不同数据目录没有混用。
2. 找回或依据已审查 DSL 提供 ZCode manifest，校验 recipe、字段、时间、去重与来源重叠。不得仅凭原始目录存在自动安装。
3. 执行 preview，展示目标身份、捕获范围、预计新增/重复/拒绝计数、billing 降级及冲突；confirm 必须绑定该 preview 的 revision 与捕获输入，沿用现有闸门。
4. 通过正常激活与 sync 摄入，不绕过 lifecycle 直接写事实表。保留原 machine namespace 与去重规则；重复 sync 不双计。
5. 检查事实、会话、Overview 与 City。没有窗口内事件时验证历史窗口或受支持历史查询，不能伪造当前活动。

禁止全库清空、整份覆盖旧数据库、自动恢复旧预算或订阅声明。预算/账单单独列出待用户确认的差异，凭据与第三方路由配置不作为恢复材料。manifest 使用现有 metered-estimate 和 unresolved 规则，不把接入成功视为官方订阅证据。

## 6. 三轮交付

| 轮次 | 交付 | 完成门槛 |
| --- | --- | --- |
| R1：契约与诊断 | 通用 App Plugin 来源列表/数据接口、热插拔失效事件、宿主管理状态查询；City 适配与名称统一 | 不区分接入机制的合成插件测试通过；权限、错误与未支持能力明确；更新投影规范 |
| R2：接入闭环 | 通用 manifest lifecycle 验证；经用户确认恢复本机 ZCode | preview/confirm、正常 sync、重复摄入、卸载/回滚与历史可见性有证据；不改旧账单 |
| R3：安装验收 | 最新 main 构建安装、真实来源 UAT、故障回归、文档状态整理 | 安装包真实显示来源；City 故障不影响 Overview；证据矩阵与未完成项明确 |

实施前检查工作区现有修改，避免覆盖并行 City UX 工作。本 SPEC 不要求新建 worktree，也不授权直接推送或发布。

## 7. 必须通过的测试矩阵

- 使用非 ZCode 的合成 slug，验证候选 → preview → 激活 → sync → usage/session → Overview/City；再验证第二个 manifest 来源不被合并。
- 用最小测试 App Plugin 验证同一列表/数据接口消费内置和动态来源，不依赖 City DTO、不判断 id 前缀；插件保持运行时激活、卸载、回滚与摄入更新，列表/数据自动刷新且历史仍可查询。测试实例不得仅靠源码中没有分支来代替运行证据。
- 列表与数据 revision 变化、事件遗漏、暂停恢复和失效实例均有回归测试；不把事件收到视为数据已刷新。
- 候选未激活、active 对象损坏、数据库不可用、源缺失、零事件、窗口外数据各有不同结果；坏对象不得回退候选。
- rollback/uninstall 后历史事实仍可见，名称降级可解释；重新安装与重复 sync 不双计；已有来源重叠闸门仍拒绝冲突。
- manifest 统计可见但不自动获得 compiled 行为审计；provider 不确定性、metered-estimate 与账单保持规则不变。
- 投影字段脱敏、身份长度/字符校验、公开名称安全渲染、失效实例响应拒绝；MCP/export 权限不扩大。
- City 独立实例超时、渲染错误、进程异常后 Overview 可操作，重建成功；浏览器 fixture 与原生真实数据分别验收。
- Rust 受影响测试与 release/clippy、Python/Rust golden parity、SDK/宿主/City 类型检查和隔离守卫通过。不为消除失败随意更新 golden。
- 安装包由 `.app` 启动，记录 commit、构建/安装路径、CLI/schema 信息、签名验证与 UAT 结果；只记录必要本地证据，不上传用户数据。

现有 500-session 截断与 findings partial 继续诚实显示。本轮不承诺无限历史、完整 E15、远程发布、第三方插件市场或新的安全沙盒。

## 8. 文档与最终验收原则

修订 `CITY_LOCAL_DATA_PROJECTION.md` 的身份范围与版本；整理两份 App 架构/实施文档，把“当前规范”和“历史 fixture 阶段”分开，更新 suspend/reuse/dispose 语义。Extension 计划保留 E09–E15 的真实延期状态，不把本次修复等同于整体扩展架构完成。

最终验收必须分别回答：代码是否支持、该机器是否激活、是否成功摄入、每个消费面是否正确呈现、安装包是否实测。任何一项缺证据只能写“未验证”，不能用打包成功或单元测试替代。

### 实施记录（2026-10-04）

- 新增 query `app_harnesses`、通用 `harnesses.list/sessions`、SDK 身份/统计类型与客户端。数据 revision 不一致拒绝并有界重试；会话句柄按实际插件 ID 隔离。
- City 升级 `city:v2`，复用同一身份清单和名称，不再将合法动态来源折叠为 unknown；宿主显示名也复用同一清单，并在 invalidation 后刷新。
- 新增只读 CLI `harness-inventory` 与宿主 IPC；候选、历史与坏对象可诊断。来源健康尚无统一观测，明确 not_observed，未声称完整诊断面交付。
- 新增动态双来源、激活/卸载、历史保留、坏对象与 revision 回归；SDK 使用非 City、无机制前缀的身份验证动态刷新。
- 具体契约见 [APP_PLUGIN_HARNESS_DATA_CONTRACT.md](APP_PLUGIN_HARNESS_DATA_CONTRACT.md)。正常 preview/install/ingest/重复 sync/uninstall 到插件统计/City 投影的临时合成链路已通过；第二插件原生实际运行、安装包与真实 ZCode 验收尚待补齐。
- 已通过：Rust 新增 2 个 harness integration tests，原 app_local 脱敏/窗口测试；桌面 plugin 过滤 9 tests；CLI release check；query/CLI release clippy（all-targets，warnings denied）；SDK/宿主/City 类型检查；通用客户端、City provider、命名、布局、浏览器适配器和插件架构守卫；宿主与 City 浏览器构建。显式本机 smoke 未运行，不计为通过。
- 收尾通过：query release 全套 116 项（另 1 项本机 smoke 明确 skipped）、桌面插件过滤复跑 9 项、CLI release build、Python 16/Rust 16 golden byte parity、工作区 diff whitespace check。本机 `harness-inventory` 已只读运行，DSH 区分为有历史但窗口为空；没有自动安装缺失的 ZCode。
- 并行 City UX 涉及 CityApp、CityExperience、CSS、工具栏 placement 与 ui-host 类型，已保留；本批不提交混合改动，不据合成构建声明最新 UI/安装包验收完成。
- 插件创建诊断复核发现原生 `add_child` 失败仍会折叠到通用码。已补稳定的资产缺失、实例冲突、父窗口不可用、WebView 创建失败分类；平台异常细节只记入本地宿主日志，UI 只显示稳定错误码与排查路径。
- 项目验收续测：新增 invalid manifest 候选逐项 host inventory 诊断（仅安全 slug、`invalid` 状态、稳定 `manifest_invalid` 码；不含路径/解析原文）；`app_harnesses` integration tests 2/2、query release clippy (`--all-targets -- -D warnings`)、query release 全套 116 passed + 1 ignored、桌面插件 Rust 过滤测试 10/10 通过。
- 桌面 crate clippy 曾发现 5 项 lint；已通过局部 API allow、移除不必要借用、标注 test-only helper 与现代 `Option` 谓词处理，当前 `cargo clippy --release --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings` 通过。
- 验收发现并修复三项实现/测试问题：City 嵌入式 UI 重构后 browser test 仍依赖旧 `.city-header/.city-stats`；不可用投影曾把 unknown 统计显示成 0；插件 runtime 错误后关闭实例却保留 opened 缓存，切回标签无法重建。另修 SDK：Chromium 非致命 ResizeObserver 延迟通知不再触发 runtime crash；其它 Error 与 unhandled rejection 仍会触发隔离。
- 已通过：City typecheck、`verify:city`、桌面 React production build + tsc、React 全量 contract suite、SDK contracts 15/15、插件诊断/SDK/架构守卫、完整 `verify:city-runtime`（合成/空/过期/失败/竞态、错误隔离与重试、第二 browser 插件、renderer/resize/context、MP4/PNG 等）、browser adapter；`git diff --check` 通过。
- 原生隔离 probe 通过：构建并打开 feature-gated fixture `.app`，报告 `status:passed`；宿主/City/重启后的 City 的 WKWebView renderer PID 两两不同，host 在挂起/renderer termination 后继续存活，正式插件挂起/复用/处置、错误隔离与重启检查均通过。此为合成 fixture 隔离 probe，不等同于正式应用包安装/UAT。
- 只读实机 `harness-inventory --window-days 30` 选定的数据目录列出 Claude Code、Codex、DeepSeek Harness、WorkBuddy 四个编译来源，没有动态候选/激活项；不得据此声称 MiniMax Code、ZCode 或其他动态来源已在此机器接入。
- 自动化代码已提供动态 harness source health/ingest failure 观测；仍未完成本机 ZCode 的授权核对、preview、恢复与真实数据复核；第二种插件的原生 WebView 实际运行；正式 Agent Vitals `.app` 安装与真实数据 UAT。此前发出的“只读核对 ZCode manifest 并 preview（不安装/激活/写 facts）”授权问题尚未收到答复，本记录及工作均未触碰该数据。

### 项目验收续记（2026-10-05）

- 当前工作树基线为 `main@187d1294`；该提交在 `origin/main@8ac38e99` 之上包含用户正在进行的 City UX 修改。本验收保留这些修改，不清理、不提交、不重写其范围。
- 当前复跑通过：`cargo test --release -p agent-vitals-query`（116 passed，1 个显式本机安装 smoke ignored）；`cargo clippy --release -p agent-vitals-query --all-targets -- -D warnings`；`apps/desktop/ui-dev` 下 `npm run verify:plugin-architecture`（诊断契约、通用 harness SDK 与架构检查全部通过）；`node scripts/verify-plugin-diagnostics.mjs`；`git diff --check`。
- 本次再复跑通过：`apps/desktop/ui-dev` 下 `npm run verify:react`（React production build、TypeScript 与全套宿主 contract）；`packages/agent-vitals-app-sdk` 下 `npm run verify:contracts`（15/15）；`npm run verify:city-runtime`（City migration/frame/film/locale、browser adapter 与完整 Chromium runtime regression，包括第二 browser 插件、错误/空/过期/不可用数据、重试、宿主保活、PNG/film、挂起恢复）。React 与 City bundle build 有 >500 kB chunk 提示但命令成功。以上均为浏览器合成/fixture 验证，不替代原生第二插件和正式应用真实数据 UAT。
- 跨语言和仓库级复验通过：`AGENT_VITALS_BIN="$PWD/target/release/agent-vitals" python3 -m unittest discover tests -v`：1284 tests，8 skipped，0 failures；16 个 Rust/Python golden case 全部字节一致；`cargo test --release` 整个 Rust workspace 成功；`cargo clippy --release --all-targets -- -D warnings` 成功。上述仅测试命令写入临时目录/build artifacts，无实际用户数据迁移。
- Tauri 宿主 crate 完整单测复跑通过：`cargo test --release --manifest-path apps/desktop/src-tauri/Cargo.toml --lib`，165 passed，0 failed，0 ignored；含 plugin host diagnostics、projection scope、source-health failure mapping、动态 harness 回执与 Overview 等回归。
- 动态 harness 诊断闭环实现与复验（2026-10-05）：`SyncStatus` 在旧 JSON 可兼容读取的前提下持久化闭集错误码、时间与导入计数；活跃 manifest 的失败/零事件/成功产生逐 harness 回执，inactive candidate 不作为 source failure；暂停、整轮失败及 compiled-only light sync 不会清除动态回执。桌面 source-health 投影合并 active registry、不可变 revision history 与 source/fact history，Settings 展示具体稳定错误类别，不包含原始错误文本或路径；重试成功以当前成功回执覆盖旧失败，零事件成功明确记为 `empty`。MCP 与 App Plugin 投影不扩展。
- 本轮新增验证通过：`cargo test --release --manifest-path apps/desktop/src-tauri/Cargo.toml --lib`（165 passed）；`cargo test --release -p agent-vitals-ingest`（118 unit + 5 integration passed）；Tauri 与 ingest 各自 `cargo clippy --release ... -- -D warnings`；`apps/desktop/ui-dev` 下 `npm run verify:react`（production build、tsc 与全部 React contract）；`git diff --check`。React build 仍有 >500 kB chunk 警告，不影响成功结果。
- 最终项目复验（当前工作树）：重建 `cargo build --release` 后再跑 Python suite（1284 passed，8 skipped）与 golden diff（16/16 字节相同）；完整 `cargo test --release`、workspace 与 Tauri `--all-targets` 的 `cargo clippy --release ... -- -D warnings` 通过；Tauri 当前为 165 tests。`npm run verify:plugin-architecture`、SDK `npm run verify:contracts`（15/15）及 `npm run verify:city-runtime` 均通过，后者包含第二 browser 插件及错误/恢复/切换链路。首次全仓测试曾被本轮新增的 4 个旧 facade 路径引用触发 import-budget 门禁（287 > 284）；改用 `agent_vitals_runtime::sources::harness_registry` 后计数降至 283，完整重跑通过。Tauri all-targets Clippy 初次发现的两个旧测试 lint 已收敛后复跑通过。browser/React bundle 有 >500 kB chunk 提示；没有执行 formatter。
- 原生隔离 fixture 当前工作树复验通过：`node scripts/verify-native-plugin-isolation.mjs` 构建并从独立 `.app` bundle 启动 feature-gated probe，报告 `status: passed`；Host、City、重启后 City renderer PID 各自独立，挂起/renderer termination 后 Host 存活，并通过重启、toolbar、恢复和 stale-message 拒绝检查。这是合成 City fixture，不代表第二种原生插件或正式 Agent Vitals `.app` 已验收。
- MiniMax Code 范围核对：源码提供 `TrustAuditProfile`（`.minimax` / `.minimax-agent-cn` / Application Support/MiniMax）与 `MiniMaxWorkspaceIndexV1` scanner/runtime-monitor；`cargo test --release -p agent-vitals-trust minimax_` 当前工作树通过 2 项合成测试。该 profile 是 Trust/egress 风险证据，不等于 usage/session harness adapter。`FACT_HARNESSES` 仍是四个编译来源，仓库内没有 `minimax-code` manifest 文件，`apps/desktop/plugins.json` 目前只注册 City。故不能声称 MiniMax Code 用量接入或本机 activation 已验收；前者没有专用 repo manifest，后者本轮未读本机数据库。
- Source-health 回归追加：覆盖 active 来源、source/fact 历史和仅在不可变 `extension_revisions` 中存在的已卸载来源；`cargo test --release --manifest-path apps/desktop/src-tauri/Cargo.toml --lib dynamic_harness_source_projection_combines_active_history_and_receipt` 与 Tauri `--all-targets` Clippy 通过。revision-only 历史来源诚实显示为 `not_detected`，不伪装已接入或故障。
- 格式检查记录：按仓库约定只读运行 `cargo fmt --all -- --check`，因 workspace 多处既有格式差异返回 1，输出涉及大量非本次修改文件；没有运行 formatter，也没有批量改写。`git diff --check` 仍通过。该格式差异不等同于本轮测试失败，但需在后续有针对性的格式治理中单独处理。
- 健康诊断根因现已修复：MCP 的通用 `source_status_report` 保持既有 compiled-source 范围；桌面本地 `data_source_status` 额外合并动态 active registry 与 SQL 内的 source/fact history，避免扩大 MCP/App Plugin 数据面。`plugin_ingest` 的 active slug 由 authority registry 校验，unactivated candidate 不进入健康失败；`last-sync.json` 保存安全的 per-harness 回执，Tauri 将其与健康聚合关联，React 通过闭集错误类型本地化展示。CLI `harness-inventory` 的 `health_state: not_observed` 仍保留，因为该命令是独立 inventory 契约，未被本次改成诊断 API。
- 原生隔离的通过证据只针对 City；`apps/desktop/plugins.json` 当前仅注册 City。浏览器 runtime 的第二插件验证与原生第二插件不是同一验收项，故第二种插件 native WebView 运行仍未验证。
- 验收状态：动态来源健康诊断的实现与合成回归通过；本机 ZCode 恢复/真实数据核验、第二插件原生运行、正式 `.app` 安装及真实数据 UAT 均未完成。不得将当前工作树的构建/测试结果表述为完整项目验收通过。
- 追加闭环回归：扩展 `preview_install_normal_ingest_and_uninstall_preserve_plugin_statistics`，真实调用 `ingest_installed` 验证合成源文件暂时缺失时失败、恢复文件后重试成功、事实不重复计数且卸载后历史仍可见；`cargo test --release -p agent-vitals-query`（113 unit + 2 integration passed，1 个本机 smoke ignored）及 query all-targets Clippy 通过。诊断分类回归增加六类错误码，并抓到 `.jsonl` 路径中的 `json` 误触发 manifest 分类；分类现按解析/校验语义而非文件名判断。修复后 Tauri lib 全量 165 项、all-targets Clippy 通过，`git diff --check` 通过。
- Sync→Settings 组合验收回归：将合成失败 `SyncReport` 经过 `status_from_run`、`last-sync.json` 写读，再投影到动态 source-health，确认具体安全错误码与 `needs_attention` 可见；再将成功重试回执持久化并复投影，确认错误清空、状态恢复 `connected`、attempt 记录为 `empty`。定向用例、Tauri lib 全量 165 项、all-targets Clippy 与 `git diff --check` 均通过。该项验证本地同步状态/Settings 数据投影组合，不冒称已打开 UI 或跑过正式 `.app`。
- React Settings contract 追加守卫：确保 `SyncStatusChanged` 刷新 source health、五种动态 harness 稳定错误码均由前端桥接接受且有中英文文案，并由 Settings 来源行渲染诊断标签。`node scripts/verify-react-settings-contract.mjs` 通过。
- 全仓收尾复验：当前工作树 `cargo test --release` 完成（workspace 全部 crate、集成测试与 doc-tests 通过），`cargo clippy --release --all-targets -- -D warnings` 通过；React `npm run verify:react` 含新增 Settings contract 全部通过，`git diff --check` 通过。全仓格式 check 既有差异不在本轮改写范围，未运行 formatter。
- macOS 候选包构建 smoke：执行 `cargo tauri build --bundles app --no-sign --ci` 并覆盖 `productName/identifier` 为 acceptance flavor，成功生成 `apps/desktop/src-tauri/target/release/bundle/macos/agent-vitals-acceptance.app`，不覆盖 2026-10-04 的 `agent-vitals.app`。前置 React/AgentCity 插件资源构建成功，打包 CLI `--build-info` 返回 schema v31；Info.plist Bundle ID 为 `com.mixlabpro.agent-vitals.acceptance`，宿主与 CLI 均为 arm64。候选包未签名、未安装、未启动；因此只证明当前工作树可产出 flavor bundle，不替代签名验证、正式安装、托盘呈现或真实数据 UAT。构建有 bundle >500 kB 提示及 mp4-muxer npm deprecation 警告，npm audit 报 0 vulnerabilities。

未激活本机 ZCode、未恢复预算、未重建用户数据库。并行 City UX 修改不属于本 SPEC 修复交付。
