# Agent City 3D 场景远程控制方案

## 目标

桌面用户主动开启远程后，手机通过 `relay.ohagent.ai` 进入同一座 Agent City：可浏览、旋转和缩放城市，并在桌面开启机甲 v1.5 对局时操作机甲。桌面是唯一权威；停止、断线或撤销授权后手机不可继续操作。移动端适配触屏、竖屏和网络波动。

## 已实施的首轮方案

- 桌面保持唯一数据与战斗权威。用户开始远程访问时，桌面生成 `remote-city-display:v1` 白名单投影并验证大小、字段与对象边界，再写入当前内存态 MatchSession。
- 手机从同一个现有 Worker 的授权房间读取 City 投影；使用 Agent City `CityEngine` 与 `CityMechaWorld` 渲染，不再以 10×10 DOM 棋盘代替城市。手机触屏点友方机甲切换单位，点可达地块移动，动作面板提交攻击/技能/回合命令。
- 投影包含真实 City 几何所需的模型、标签、会话名称和 token 用量，以及当前战场窗口。会话和建筑 ID 按源 ID 顺序替换成房间内临时 ID；时间戳换成布局排序序号；不传输模型 ID、成本、finding、原生日志锚点、路径、凭据或原始 session id。
- `city.snapshot` 加入 v4 capability 方法白名单。relay 只转发内存中的场景与对局内容；Worker 不保存其业务 payload。HTTPS/WSS 有传输加密，但没有端到端加密，手机页面会明确告知。
- `npm run typecheck`、Agent City UI `npm run build`、桌面 `cargo check --release` 与 `cargo tauri build --bundles app` 已通过。beta.4 桌面包已复制到 `/Users/Admin/Applications/Oh Agent City Remote 1.5.app`。
- 生产 Worker `agent-city-mecha-relay` 已更新至 `relay.ohagent.ai`；`/remote.html` 重定向到 `/remote`，静态页面与 JS 资源均返回 200。
- 尚未通过 GUI 打开安装包，也未生成本次真实的一次性手机链接、完成手机连入和对局往返验收。当前 Mac 处于锁屏状态；需要解锁后完成桌面端联调。iPhone/Android 真机及停止/断线重连验收也尚未完成。

## 架构与安全边界

1. 手机复用 City Engine/CityMechaWorld 的三维渲染与触屏拾取，不复制桌面 host IPC，也不接收桌面屏幕流。
2. `RemoteCityDisplay` 是只显示投影；原生网关用严格 allowlist 验证，手机也只按 JSON 作为数据消费。当前战斗命令复用 v1.5 版本化命令流。
3. relay 是命令中继，不做端到端加密；任何 relay 侧对 payload 的可见性均按明文可读风险对待。只发送用户已经明确同意的城市、会话名称、标签、token 总量和当前对局。
4. 场景投影受 230 KiB 上限，opening 与场景合计受 256 KiB 上限，符合现有 Worker 消息上限；大型城市需后续做分片/增量方案，而不是放宽边界。
5. 停止远程访问关闭设备访问；房间关闭/过期按 relay 当前生命周期处理。完整 iOS Safari/Android 性能、断线重连、终止/过期需要真机验收。

此方向重用 3D 场景代码，但手机端是同一场景的远程渲染，不保证与桌面逐像素同步。若要求传输桌面实际画面、桌面光标或任意桌面操作，需要另行评估屏幕采集和实时媒体传输；仅有现有 Worker 不能证明该路径可用。

## 数据决策

用户已决定在获授权的手机端展示真实 City、会话名称和用量/标签。`AGENTS.md` 第 8 条记录了此项场景限定例外。字段 allowlist 在 `cityDisplayProjection.ts` 与 `valid_remote_city_display` 中双侧定义，并由每次会话的临时 ID 隔离。凭据、session 原 ID、路径、成本、finding、原始日志与提示内容仍不可远程访问。

## 验收

- 真机实测同一份桌面真实 City，核对地形、道路、建筑、名称、用量与战场坐标。
- 完成桌面开启、手机选机甲/移动/攻击/结束回合、桌面状态更新和结束后接管恢复；再验证断线、重复命令和过期 revision。
- 验证停止、撤销设备和过期后旧链接无法重新授权；确认 relay 不持久化场景与战斗内容。
- iPhone Safari 与 Android Chromium 分别记录触屏、适配、WebGL、性能与可用性结果。
