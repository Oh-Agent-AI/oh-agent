# App Plugin 通用 Harness 数据契约 v1

2026-10-04：代码接入；完整安装包与真实来源验收尚未完成。

所有官方内置 App Plugin 通过通用 `plugin_request` 信封调用以下方法。描述符必须声明 `harnesses:v1`；权限不是由 harness 前缀或插件自报身份决定。Rust 校验活动 WebView/instance，查询后再次校验实例。宿主管理清单、安装机制和来源路径不进入这些响应。

| 方法 | payload | 响应 |
| --- | --- | --- |
| `harnesses.list` | `{version:1}` | `{protocol:"harnesses:v1",data_revision,harnesses:[{id,display_name,capabilities}]}` |
| `harnesses.sessions` | `{version:1,harness_id,windowDays,data_revision}` | `{protocol:"harness-sessions:v1",data_revision,harness_id,window,status,coverage,sessions}` |

`id` 是不透明身份，插件不能据此区分 compiled/manifest。`capabilities.session_statistics.available` 表示统计能力；`capabilities.findings` 明确是否支持与公开原因。目前 manifest 不获得内置行为审计能力。列表包括内置、已安装动态来源与保留事实的合法历史来源，不包含仅在候选目录中发现的来源。

会话窗口允许 7/30/90/366 天，滚动 UTC；每个来源最多 500 个 session。token 是窗口内未删除 facts 的累计，input 包含 uncached/cache-read/cache-write。时间字段是毫秒；会话标识使用安装盐和宿主确认的插件 ID 作用域，不返回原生 session ID。此通用接口不提供 task excerpts、成本、模型、raw anchors、路径、原始错误或 SQL。City 的已授权摘录仍仅通过其单独场景投影获取。

列表与数据读取各在只读 snapshot 中完成。sessions 必须带列表 revision；revision 已变返回 `revision_changed`，可重试，不返回混合快照。没有数据库返回 `data_unavailable`，未知身份返回 `harness_unavailable`，窗口为空返回 `status:"empty"`；错误不会替换成 fixture。

SDK `createHarnessDataClient(instanceId, send)` 提供 list/sessions/snapshot；snapshot 在并发 revision 变化时最多重试三轮。send 必须来自插件 transport，不提供任意 IPC 权限。活动插件在宿主 `invalidate` 或 `resume` 信号后重新读取，不依赖收到完整事件历史。该 helper 不自行创建后台网络或全局订阅。

CLI `harness-inventory --window-days 30` 为宿主只读管理入口，区分 candidate/active/inactive_history/invalid 与 ready/empty_window/not_ingested；返回公开诊断，不输出候选文件路径或日志正文。未接入健康观测时明确标记 `health_state:"not_observed"`，不把它解释为“源健康”。桌面另注册 `harness_inventory` IPC；完整可视化安装/诊断面仍待实施。

验证：Rust `app_harnesses` integration test，SDK runtime `scripts/verify-app-harness-data.mjs`。两者分别证明读侧与消费协议；不等同于真实第二插件原生 WebView 或本机 ZCode 接入验收。
