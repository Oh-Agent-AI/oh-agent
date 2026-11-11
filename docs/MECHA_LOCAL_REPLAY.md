# v1.5 本机战斗回放

## 范围

v1.5 回放按顺序保存对局开局信息和已接受的命令，再由本机规则重放并校验事件摘要。它不是视频录制，也不保存完整城市投影、建筑物 ID、用户数据或演出帧。回放必须与当前城市战场匹配；格式、战场摘要或命令校验不通过时拒绝播放。

对局中会自动写入单槽恢复检查点；玩家可在“本地回放”面板手动保存已记录的对局、选择播放或删除记录。v1.5 不自动归档、不导入或导出回放文件。单机预览使用当前来源的 IndexedDB；桌面内嵌 City 使用授权的固定 SQLite 操作。两者不会自动同步。桌面回放和检查点使用独立 SQLite 文件，不走 32 KiB 通用插件状态文档限制。

## 容量和校验

回放 archive 上限为 40,000 字节，包含 archive 的记录上限为 41,024 字节；容量按 UTF-8 字节检查。每个存档最多 20 条。超过限制、记录损坏或数据库不可用时，操作失败且不会覆盖其他记录。保存成功以写入后读回一致为准。

恢复检查点使用独立的 compare-and-swap revision；过期窗口不能覆盖较新检查点。未知或旧版 `mecha-local-replay-entry:v1` 记录不会进入 v1.5 回放列表，也不会阻塞启动。

## 验收边界

- `apps/agent-city/ui/tests/mecha-sequential-storage-boundary.browser.mjs` 验证浏览器 IndexedDB 在 31 KiB、33 KiB、40,000 字节 archive，以及 40,001 字节和 41,024 字节记录边界的处理。
- `apps/desktop/src-tauri/src/plugin_state.rs` 的 `sequential_replay_byte_boundaries_use_the_dedicated_sqlite_path` 覆盖桌面原生 SQLite 同一边界；其他 `sequential_*` 测试覆盖格式、隔离、检查点 CAS 和拒绝不带 v1.5 format 的请求。
- 浏览器预览测试不等于桌面生产 `.app` 的端到端验收；真实桌面 UI 和远程 handoff 仍需各自验证。
