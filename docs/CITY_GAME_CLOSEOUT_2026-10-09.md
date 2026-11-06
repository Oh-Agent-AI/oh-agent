# City 游戏分支收尾记录

基线：`worktree-city-game-mode` 已合入本地 `main @ 0ead24bf`，最新合并提交 `e0a39c0e`。当前代码与基线收尾提交截至 `64316571`。此记录是验收进展，尚不是合并批准。

## 已修复

- `384e472b`：档案 revision 冲突后的重读也执行损坏/未来版本只读保护；浏览器未来版本档案读取不再写回空档案。新增危险冲突、正常合并与本地只读回归。
- `384e472b`：浏览器 mock 保留显式注入的 provider。原脚本的 seed 检查实际被默认演示 provider 绕过；不能继续把失败简单归因为消息队列饥饿。
- `384e472b`：修复中英文初始化、折叠面板与 overflow 菜单、恢复后画质选择、无 WebGL 降级等旧 UI 定位器；摘要验证恢复为会话数及 token 数实值断言；不可用数据不显示为零用量。
- `4e4858a5`：地形山体权重严格为零时跳过不影响结果的噪声计算；13,005 个采样点与原公式高度精确相等。
- `9e065e29`：原生验收构建可显式设置 `AGENT_VITALS_CITY_GAME_UAT=1` 开启已有开发入口。普通构建入口仍关闭。
- `4a269bd0`：救生塔每塔写入 8 个结构实例，却只分配 6 个实例的缓冲区；修正容量。真实 MP4 验收同时检查前台 GL 错误与 Worker 控制台缓冲错误。
- `daadd65a`：接入 main 的分层验证器，完整链包含地形等价检查和六个游戏守卫；单独进程执行，基础设施守卫断言成员完整。
- `f8316da8`：游戏世界与路线守卫使用原生模块加载器，未减少 12 个世界布局和 80 个路线布局的覆盖。
- `64316571`：审阅救生塔修复的 golden 差异后更新场景基线，仅改变四组救生塔结构缓冲摘要及其整体哈希，不修改其他场景片段。

## 本次已取得的验证证据

| 检查 | 结果 |
| --- | --- |
| 根工作区 `cargo test --release` | 退出码 0 |
| 根工作区 `cargo clippy --release --all-targets -- -D warnings` | 退出码 0 |
| 桌面 Rust `cargo test --release -p agent-vitals-menubar` | 167 通过；localhost HTTP 用例需要 `NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost`，防止本机代理接管 |
| 桌面 Rust clippy | 退出码 0；此后无 Rust 源码改动 |
| City typecheck / 飞行校准 / 控制器 / 档案回归 | 通过 |
| `verify:plugin-architecture` | 通过 |
| `verify-react-city-runtime.mjs` 完整运行 | 退出码 0；包括数据状态/竞态、故障恢复、Tab 保留、语言、第二插件、resize、PNG 与导出取消 |
| `verify-react-city-runtime.mjs --film-only` | 退出码 0；122 帧、320×180 MP4 可解码，前台仍响应，`renderErrors=0`，无 Worker 缓冲错误。该小尺寸测试使用 1 FPS；它不代替生产 30 FPS 性能验收 |
| UAT 原生 bundle 构建 | `AGENT_VITALS_CITY_GAME_UAT=1 cargo tauri build --bundles app` 退出码 0 |
| `verify:city` 全链 | session `42779` 退出码 0，42 阶段全部通过；JSON 报告 `/tmp/city-game-closeout-full.json`。包括新增键盘→物理→12 环成功结算及一次保存回调守卫 |

## 原生验收进展与剩余门槛

通过 `open .app --args --show-workbench` 启动工作树 bundle，用 Computer Use 验证实际原生工作台、City 场景、开发游戏入口、自由飞行画面与暂停面板。AX 点击画布没有可靠转交原生键盘焦点；真实指针点击画布后 Esc 成功打开暂停面板，因此该段采用截图和坐标操作验证。

旧一次运行出现 `plugin_unresponsive`；地形优化后的重新启动已进入 City 和自由飞行。仍需要最终 bundle 的系统复测，不能仅凭一次成功宣布健康超时完全解决。

解锁后通过 Computer Use 继续验证：挑战实际穿过首环（`1 / 12`），等待后出现 `Timed out` 结果（时间 `2:32.2`、32 次碰撞、96 秒惩罚）；点击 Retry 回到倒计时并重新飞行；Esc 打开 Paused，点击 Resume 后倒计时继续推进；再次暂停并点击 Exit game 后恢复数据模式城市视角、标签与工具栏；点击 Overview 后真实本地概览正常显示。上述是失败路径证据，不是成功通关证据。

为避免多份同 bundle id 的 App 被 Computer Use 错认，这段使用临时副本 `/tmp/agent-vitals-city-uat.jyB1Hh/agent-vitals-game-uat.app`，仅 Info.plist 的名称与 bundle id 改为 `Agent Vitals Game UAT` / `com.mixlabpro.agent-vitals.city-game-uat` 后 ad-hoc 签名。前端与可执行代码来自已构建的工作树 UAT bundle；OS 身份和签名与正式包不同，因此不能替代正式身份相关验收。未覆盖项仍需使用最终包补齐。

原生挑战成功、换路线、重启成绩持久化，以及性能分档、布局矩阵仍待完成。后台全量验证的 session `42779` 已退出 0；`4e8af385` 的新增成功路径守卫在这次全链执行到该阶段之前提交，并被该次执行覆盖。该逻辑守卫不替代原生落盘和重启验证。现有瞬时闪白状态未在本次宣称解决。
