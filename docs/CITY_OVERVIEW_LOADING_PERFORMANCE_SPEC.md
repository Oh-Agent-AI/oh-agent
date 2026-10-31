# City 首屏统计加载性能与诊断 SPEC

版本：1.2 · 日期：2026-10-31 · 状态：P0 数据门槛通过；P1 暂不实施，场景首帧作为独立优化跟踪。验收证据见 `CITY_OVERVIEW_LOADING_PERFORMANCE_ACCEPTANCE_20261031.md`。

## 1. 背景与目标

用户进入 City 后，界面长时间停留在“正在读取全窗口统计…”。本规格针对 **数据读取阶段**，不把后续的 City 场景规划、资源加载或渲染耗时算作同一问题。后者需单独计时和优化。

目标：

1. 消除默认 366 天窗口下每日活跃统计对首屏请求的明显阻塞，保留完整统计口径。
2. 为本地排障提供分阶段耗时、重试和降级证据，能够区分数据库、IPC、场景规划和渲染。
3. 在索引优化仍不足时，允许逐步展示首屏并异步补齐非首屏模块；不得混用不同数据快照或把未加载当作零。
4. 所有优化保持官方内置插件的权限、离线隐私和现有投影语义。

不在范围内：改变默认时间窗口、删减用户数据、修改计费归因、改造场景生成算法、引入远程服务或遥测。性能优化不改变 MCP、export 的权限和脱敏规则。

## 2. 已确认事实与证据边界

### 2.1 调用链

- `apps/agent-city/ui/src/CityApp.tsx`：原生 City 默认使用 366 天；`reading_summary` 对应用户看到的提示。
- `apps/agent-city/ui/src/data/provider.ts`：发送 `city:v3 overview`，首页 `page_size=500`，等待响应后才发布第一批 City 投影。
- `crates/agent-vitals-query/src/query/city_v3.rs`：overview 同一次响应中组装会话首页、全窗口模型与概览统计、每日 activity 和 findings。`module.read` 已支持 findings，但目前**不支持 activity**。
- `crates/agent-vitals-query/src/query/app_local.rs`：按请求时区构造每个当地日期与窗口的半开区间，再执行每日统计。
- `crates/agent-vitals-data/src/session_statistics.rs`：每日统计将日期边界与 `usage_facts` 按 `event_ts_ms` 范围关联。
- `crates/agent-vitals-data/src/authority.rs`：现有时间相关索引以 `harness`、`session_key` 或 `provider_id, model_id` 为前导列，没有以 `event_ts_ms` 为前导列的活跃记录索引。
- `apps/desktop/src-tauri/src/plugin_host.rs`：查询在阻塞线程执行，并在响应前重新验证插件实例；不是在 UI 主线程上直接执行 SQL，但 UI 仍需等待结果。

### 2.2 2026-10-31 本机只读调查

权威库约 9.6 万条 usage facts；366 天滚动窗口跨 367 个当地日期。原 SQL 在真实库的只读测试约 **14.4 秒**。查询计划为按日期扫描 `usage_facts_session_time`，而非对事件时间做范围搜索。

在包含相同查询所需数据的**同一内存副本**中，原计划耗时约 **11.8 秒**；添加 `event_ts_ms` 部分索引后约 **0.13 秒**，查询计划改为时间范围搜索，两次结果完全相同。这是一次单项 SQL 实验，不是打包应用端到端测量；实验所用 Python SQLite 3.51.0 也可能不同于 Rust 打包版本。数字用于确定优化方向，不是所有机器的性能承诺。

现有 `~/.agent-vitals/logs/app.log` 可见 City WebView 创建事件，但未记录此次 overview 的起止、各阶段耗时或重试。因此不能仅凭日志断定用户那一次的完整耗时，也不能证明其发生了重试。源码中的 revision 检查和前端重试可能放大慢查询，是否发生须靠新增日志确认。

## 3. 交付分期与优先级

- **P0，必交付：**事件时间索引、可恢复的正式迁移、正确性/计划回归、无敏感信息的本地性能诊断、打包版复测。先验证此阶段是否已解决用户问题。
- **P1，条件交付：**若 P0 后首屏仍未满足第 8 节预算，或产品明确需要更快的首屏，则实现第 6 节的兼容式渐进加载。P1 不以牺牲统计完整性或一致性为代价。若 P0 已达标，可将 P1 留待后续版本；验收报告要记录决定和证据。
- **不作为本次修复：**偷偷缩短 366 天窗口、以缓存掩盖错误、放宽 revision/权限检查、回退到合成数据、删库重建。

## 4. P0：索引与迁移

### 4.1 目标索引

在权威库中增加下面的候选索引，供包含 `deleted_at_ms IS NULL` 的跨 harness 时间范围查询使用：

```sql
CREATE INDEX usage_facts_event_time
  ON usage_facts(event_ts_ms) WHERE deleted_at_ms IS NULL;
```

实现应先在 Rust 自带 SQLite 及代表性数据分布下验证 `daily_activity` 计划；不能仅因为索引存在就认定生效。空时间不匹配范围条件，仍遵守现有 unknown-time 分类；已删除的 session 和 fact 仍按原查询排除。不得为追求命中而改动范围、分桶、去重或 token 求和语义。

### 4.2 数据库生命周期与兼容

1. 依据仓库权威库 DDL 管理规则更新 `crates/agent-vitals-data/src/authority.rs`、其规范镜像和受影响的测试 fixture；当前 `SCHEMA_VERSION` 为 32，落地时以实际主线版本为准，按仓库约定递增并增加从前一版本的加性迁移。检查历史可升级版本到新版本的全部迁移路径，不只测最新版本。`tests/test_sessions_sql.py` 等镜像是否需要同步须按其用途核对；保持相关 Python/Rust 契约和 golden 一致，不擅自更新 golden。
2. 新建库和已有库都必须有同一索引。索引创建和版本更新处于保证原子性的迁移路径中；中断、磁盘不足、锁冲突或错误时不能宣告迁移完成。再次启动可安全重试，不损坏或删除分析事实。
3. `open_readonly` 不执行 DDL：迁移必须由产品现有的可写初始化/迁移路径完成，City 查询只读打开。实现需确认启动时序；如果迁移失败或只读路径先于迁移发生，显示明确的迁移/数据不可用状态，不将空库或合成数据当真实结果。
4. 评估索引首次构建耗时、额外磁盘空间、WAL/锁及后续增量写入成本。不得在用户真实数据库上做未授权的试验性 DDL；先用合成或用户明确同意的副本测试。评估发布回滚：旧二进制对新 schema 的只读/写入兼容不能假设成立，按实际 schema 版本策略给出恢复步骤，不建议直接删库。
5. 不修改 fact 的数据、schema 字段、billing 分类或 JSON 输出顺序；索引不构成重算历史数据的理由。

### 4.3 查询计划要求

在有代表性规模和分布的真实 Rust SQLite 测试库上，`EXPLAIN QUERY PLAN` 必须证明每日活动关联使用 `event_ts_ms` 的范围搜索，而不是每个日期都全扫描 facts。测试允许 SQLite 文案的非语义差异，但必须检查访问路径；另记录 SQLite 版本。对小样本优化器可能选择其他等价计划的情况，不把小 fixture 的计划当作大数据集的证据。

## 5. P0：本地性能诊断

### 5.1 最小事件与计时

使用单调时钟计算 elapsed；现有本地日志保存生命周期和查询阶段的受控结构化事件。建议固定字段如下：

| 事件 | 必需字段 | 目的 |
| --- | --- | --- |
| `city_overview_finished` | operation、window_days、outcome、elapsed_ms、page_returned | 一次 host 查询的总耗时和结果 |
| `city_overview_stage` | stage、elapsed_ms、outcome | 区分 session 排序/首页、模型、资产发布、overview、time coverage、activity、findings 和响应组装等阶段 |
| `city_load_finished` | outcome、ipc_elapsed_ms、attempt_count、revision_retry_count、fallback_kind | 端侧看到的完整数据阶段、重试及协议降级 |
| `city_scene_stage` | stage、elapsed_ms、outcome | 区分 data ready 后的 model/planning/mounting/rendering；实现时复用现有阶段，无需改变算法 |

每次请求完成或失败均须有终态；失败用稳定、受控的错误码或枚举，不记录异常原文。重试计数在客户端统计；同一次逻辑加载的各次请求与阶段可通过**进程内随机、短生命周期的诊断关联号**关联，不复用 session、asset、snapshot、context 或插件实例 ID。关闭页面、切换窗口和失效重启应可区分 outcome。

前端若要向本地日志上报耗时，必须通过 host 为官方 City 注册的专用受控接口或已有同等能力：只接受上述有限枚举及有界数值，不接受任意消息字符串、payload 或任意插件日志；由 host 再校验活动实例与授权。不得仅用 WebView console 就声称已写入 `app.log`。P0 必须交付端侧和 host 计时；若受权限或实现限制无法安全接入，标记 P0 未完成并在报告中明确缺失，不能只使用 console 或伪造指标。

### 5.2 隐私和日志量

仅存本机，不上传、不新增遥测或外网连接。禁止记录请求/响应 payload、SQL 参数、session ID、标题、摘要、日期明细、路径、工作目录、token 值、错误原文、设备标识或任何原始日志。`window_days` 仅允许既有档位，计数仅使用返回数量等必要聚合。默认每次逻辑加载一条终态和少量阶段事件；高频刷新需受控去重或仅在慢请求/调试级输出阶段明细，遵守现有日志轮转。

## 6. P1：渐进式首屏（条件交付）

### 6.1 协议与兼容决策

保留原 `city:v3 overview` 的默认响应：旧客户端不传新参数时，activity 和 findings 仍同步返回，语义不变。新增受校验的可选参数，例如 `defer_modules: ["activity", "findings"]`，只允许这两个固定值、不允许重复或其他值；请求方显式选择后，overview 返回首屏必要数据，并对每个被延迟模块返回 `{ "state": "pending", "supported": true, "reason": "deferred" }`，不返回该模块 `data`，**不计算或伪造结果**。`pending` 是仅在显式请求延迟时出现的新增枚举，须同步更新 SDK 类型、运行时 validator、注册投影契约和测试；这是受审查的协议扩展，不得仅改 UI 类型绕过校验。

新增 `module.read` 的 `activity`，基于 overview 响应中的 `expected_revision`、`snapshot`、`context`、`query_semantics` 和完整 `window` 读取；复用现有 `app_local::activity` 的时区、半开区间和聚合语义。findings 使用现有 `module.read`。activity 仅支持全局范围，请求包含 `harness` 时明确返回参数错误；findings 保留其现有范围语义。这两个模块的延迟读取，与同一快照下原 overview 的结果必须一致；不新增任意 SQL、越权数据字段或插件直接访问数据库能力。

若新 UI 遇到旧 host 对新增参数返回 `invalid_parameter`，最多一次退回**不带新参数的原 v3 overview**；仅当该明确的能力兼容检查失败时执行，不把其他错误统统认作“不支持”。旧 UI 对新 host 使用原请求不变。v3 失败再进入既有 v2 降级时须记录原因，不能用 v2 掩盖授权失败或数据损坏；任何修订需明确并测试错误分类与用户可见状态。

### 6.2 用户体验与状态

- overview 中保留真实的全窗口 summary、模型统计、首 500 条会话及覆盖声明；不从当前页面的会话子集推算全窗口合计，也不改变 366 天默认值。
- 活动和 findings 在独立位置展示“加载中”；收到有效结果后分别更新为 ready/empty；实际失败显示 unavailable/reason。`pending` 不等于 `empty`、0 或不支持。需扩展 `CityProjectionV3`、`adaptV3` 和现有 `CityProjectionV2` 兼容投影/UI 状态；当前 `findings` 是数组且 activity 可选，不能简单传空数组让界面误以为零。
- 分页和模块加载仅在首屏可用后有界调度，避免无上限并发或每次刷新重复查询；加载中允许用户操作，窗口变更、卸载或新请求代次开始时丢弃旧结果。前端 abort 不等于后台 SQLite 一定中断；必须限制在途任务与排队，避免关闭/切换造成阻塞任务积压。
- 如果已经展示城市，数据刷新期间可保留并明确标识旧画面为更新中/过期，不能把旧模块与新页面合成同一“新快照”；禁用依赖尚未匹配数据的交互或显示其不可用原因。

### 6.3 一致性、重试与回退

每个补充响应必须与首屏的 revision、snapshot、context、query semantics、window 和当前请求代次一致；不一致或 `revision_changed` 时不得合并。重新获取新 overview 后重新加载模块；限制自动重试（沿用现有上限或经测试定义更严格上限），超过上限显示可恢复的更新中/数据变化状态并提供重试，不无限循环，也不伪装为空数据。后台事务不是跨请求持久快照，不能仅复用 token 却忽略 host 的 revision 和交付前实例校验。

## 7. 正确性与回归测试

1. **索引/迁移：**新库、当前库、各受支持历史迁移路径；重复打开、模拟失败/中断后恢复、并发只读/写入、磁盘不足或权限错误；检查 schema 版本与索引一致且原始数据不变。
2. **统计等价：**索引前后、P1 的同步/延迟结果一致；覆盖 7/30/90/366 天、滚动窗口首尾截断、当地午夜、跨日及 DST、空结果、多个 harness、重复 session、删除的 fact/session、空时间、稀疏/密集数据、数字边界和溢出失败。结果按现有契约区分 `empty` / `unavailable` / `unsupported`。
3. **计划与规模：**使用 Rust bundled SQLite 和第 8 节数据集检查大窗口走事件时间范围索引；记录无索引/有索引对照、查询计划和写入开销；不得对用户数据生成可泄露内容的测试报告。
4. **协议兼容：**旧 UI/新 host，旧请求响应不变；新 UI/旧 host，新增参数被拒后回退旧 v3；新 UI/新 host 测试 deferred 模块、可选参数校验、SDK/validator、模块错误、v2 明确降级、插件身份/响应前校验。
5. **竞态：**延迟模块与分页交错、revision 在首屏后推进、请求尚在执行时切换窗口/关闭页面、重复刷新、模块错误、取消后的迟到响应；断言不混合快照、不重复无限重试、不将 pending 表示为零。
6. **隐私：**测试日志字段 allowlist、异常路径和关联号生命周期；构造包含路径、标题和令牌的输入，断言这些内容不出现在性能日志。浏览器预览仍使用合成数据。
7. **现有回归：**运行受影响的 data/query Rust 测试、City UI/SDK 类型与契约测试；涉及 Python 或 golden 共用行为时运行相应回归。现有 `crates/agent-vitals-query/tests/city_v3.rs` 的 ignored `synthetic_projection_performance` 只覆盖 30 天等现有条件，需扩展/新增 **366 天多日边界**基准，不能用当前基准代替验收。

## 8. 性能验收与测量口径

### 8.1 固定基准

测试开始前固定参考机器和合成数据生成种子，不在看到结果后挑选；在报告中记录机器型号、CPU、内存、磁盘、OS、构建 commit、SQLite 版本、日志级别和是否有后台写入。使用可复现的合成权威库：至少 **10 万条有效 usage facts、至少 300 个会话、数据分布覆盖 366 天**，另含删除/空时间样本；首页 500、时区 `Asia/Shanghai`、rolling 366 天。额外以 100 万条测量扩展趋势并报告，但不据此调整统计语义。相同数据、相同硬件分别运行优化前后版本。

- SQL：在打包版本使用的 Rust SQLite 路径测 activity；先预热，再至少 20 次独立请求，报告 p50、p95 和最大值（p95 使用 nearest-rank，第 `ceil(0.95 × 样本数)` 个有序样本）。记录查询计划；同时测索引大小、一次性构建时间及同负载下 fact 写入耗时。
- 端到端：使用实际 `.app` bundle，从点击 City 到 IPC 首次可用投影、再到首次可见城市分别计时；至少 5 次重新打开应用的冷启动样本和 20 次已启动应用的暖态样本，报告中位数/p95/最大值。冷启动不等于清空 OS 文件缓存，除非明确记录。另做一次后台持续写入/刷新场景，记录 retry/fallback 与用户可见状态；先在无后台写入基线上评估。
- 不使用裸 `agent-vitals-menubar` 运行；遵守仓库要求，经 Tauri bundle 和 `open` 启动。不得擅自关闭用户现有应用或修改其数据库；在隔离数据目录中测量。

### 8.2 发布门槛

在上述 10 万条、参考机器、无后台写入的暖态基准下：

- activity SQL **p95 ≤ 1 秒**，并相对同机无新索引基线至少快 5 倍；结果必须与原查询一致。
- 点击 City 到首次有效数据投影 **p95 ≤ 2 秒**；从点击到首次可见城市分别报告，不因数据阶段达标就掩盖场景规划耗时。
- 无异常 revision retry、静默 v2 降级或缺失统计；后台写入情况下可重试，但不得无限等待或展示跨快照数据。
- 若参考机器/环境无法达到阈值，记录原始样本和瓶颈，优先完成 P1 或重新评审预算；不得仅改变测试数据规模、时间窗口或统计内容来宣称通过。100 万条和冷启动为趋势与风险报告，不假设也能满足以上固定预算。

## 9. 实施与验收清单

- [x] 核对主线 schema、规范镜像、兼容矩阵；完成原子索引迁移与失败恢复测试。
- [x] 在 Rust bundled SQLite 上验证查询计划、结果等价及索引的建立/写入成本。
- [x] 增加 host 分阶段日志；安全接入端侧计时，或明确列出尚不可用指标。
- [x] 补全 366 天、大数据量合成基准及相关 Rust/UI/SDK 回归。
- [x] 使用隔离数据目录打包 `.app`，完成冷/暖及后台写入实测，汇总原始样本、隐私检查和是否满足预算。2026-10-31 受控样本为 5 冷 + 20 暖；暖态数据投影 p95 1.313 s，后台写入有界重试且无 v2 降级。
- [x] 根据 P0 实测决定是否实施 P1：数据投影暖态 p95 已低于 2 s，P1 暂不实施；`first_frame` 是独立的场景渲染/资产瓶颈，不通过本 P1 隐藏。
- [x] 记录发布/回滚风险；不更新 golden 除非存在经审查的真实契约变更。
