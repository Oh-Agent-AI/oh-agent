# City 本地数据接入（官方内置插件 MVP）

## 边界与路径

适用更新后的 `AGENTS.md` 第 6 条：生产内置 City 可以读取声明的本地投影；浏览器和独立预览仍只使用 fixture。插件不连接数据库，不接触任意 SQL 或宿主任意 IPC。

`City → app SDK plugin_request → Rust PluginHost → plugin_projections → query::app_local → readonly AuthorityDb`

`apps/desktop/plugins.json` 的 `dataProjections: ["city:v2", "city-settings:v1", "harnesses:v1"]` 声明允许的投影及私有设置接口。PluginHost 校验发送 WebView、活动实例与请求信封；查询在阻塞任务中执行，不持有实例锁；响应交付前重新检查实例是否仍有效。业务分发在 `plugin_projections.rs`，通用 PluginHost 不解释 City 的参数。

## MVP 契约

请求：`method: "data.read"`，`payload: { projection: "city", version: 2, windowDays: 7 | 30 | 90 | 366 }`。

共享类型：SDK `CityUiProjectionV2`，`protocol: "city:v2"`。v2 使用通用 `HarnessPublicIdentityV1`，不再限制为四个内置来源；内部同批升级，没有 v1 回退。它不是旧独立应用设计中的分页 `CityDataProjectionV1`。

- 时间窗为滚动 UTC `[now - days, now]`，token 仅累计窗口内、未删除的 facts；输入包含 uncached/cache-read/cache-write。
- 最多 500 个会话，按最近事件排序；覆盖字段报告窗口会话总数、实际返回数、截断状态，以及未定时 facts 涉及的会话数（后者无法归属时间窗）。不分页。
- 会话 ID 使用安装盐、City 作用域的单向标识，不返回原生 ID、机器标识或数据库主键。`harnesses` 返回统一身份、名称和统计/findings 能力，内置与动态来源使用同一结构；插件不得解析 id 前缀。卸载来源的历史统计继续可见；元数据不可用时由宿主以合法 slug 降级名称，不回退可变候选。无法验证的身份才归为 `unknown`。
- 每个会话最多 2 条已有用户输入摘录（优先首次输入，再取最近后续输入），重新执行 scrub/长度限制；首次最多 200 字符，后续最多 120 字符。附 `role / provenance / is_excerpt`，不提供原始事件锚点。摘录是会话上下文，不保证发生在本次统计窗口内。
- `source: "local"` 与 `data_revision` 标识真实库快照；只读事务确保覆盖和会话来自同一快照。不新建缺失数据库，不执行迁移。
- 费用尚未投影，在模型中标为 unavailable。Findings 只包含窗口内创建、状态为 open/later 的 issue_instances，按官方执行环境与 severity 汇总；不含异常文本、来源健康和探针结果，`findings_state: "partial"`，空数组不是“没有异常”的证明。当前没有独立的来源新鲜度认证。
- 真实数据失败显示不可用，不自动回退到合成数据。Standalone 与明确的隔离测试 fixture 模式除外。

## 验证与当前限制

`cargo test -p agent-vitals-query --test app_local --release` 验证窗口、token、摘录、标识与删除退化；桌面 `cargo test --lib plugin_ --release` 验证接口授权及现有实例协议。可显式运行 `local_installation_projection_smoke --ignored --nocapture`，只输出状态/数量/revision，不输出用户文本。

City 建筑详情展示这些摘录，并明确标记“非完整提示词”。费用、模型和完整执行轨迹在 City 投影内仍不可用。

## 私有设置、宿主详情与本地导出

- `data.read` 的 `{projection:"city-settings",version:1,action:"read"|"write",seed?:number}` 只读写 `state/plugins/city.json` 中的非零 uint32 种子。首次读取兼容旧 `state/city-seed.json`，不删除旧文件；插件不提供文件路径。浏览器 fixture 使用合成状态，standalone 使用 localStorage。
- 声明 `navigationTargets:["session"]` 后，City 可请求 `ui.open-session`，payload 只含 City 的 opaque handle。Rust 内部解析到宿主会话目标并导航 Sessions，响应只含 `{opened:true}`，插件不获得宿主标识或轨迹内容。
- `allowLocalExports:true` 只允许活动插件的 blob 下载，通过原生保存对话框由用户选择目的地；不开放 HTTP 下载或任意文件写入。照片/影片只叠加统计，不把用户摘录写入成片。

浏览器回归仍为合成数据，不能证明原生真实数据端到端。功能迁移与验收状态见 [City 插件功能迁移](CITY_PLUGIN_FEATURE_MIGRATION.md)。

## 远程机甲战的独立网络边界

上述 `city:v2` 本地投影和 MCP/export 权限不因远程机甲战而扩大。仅在桌面用户主动开启远程或批准好友时，`mecha.remote.*` 可以通过 Cloudflare 传输当前比赛的 `RemoteArenaV1`、命令、快照与战斗事件；不包含本文件中的会话摘录、统计、opaque handle、设置或其他 City 数据。中继只持久化短期授权元数据，不持久化比赛正文。详细设计与验收限制见 [远程机甲战与好友对战设计计划](MECHA_REMOTE_MULTIPLAYER_DESIGN_PLAN.md)。
