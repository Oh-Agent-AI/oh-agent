# City 原生 App UAT（2026-10-03）

## 2026-10-04 WIP 最新原生验收（不含黑闪任务）

用户解锁后完成原生语言同步、种子修改及冷启动持久化、取消导出和会话下钻。发现 Worker 字幕仍硬编码中文，改为前台/Worker 共用纯字幕函数并在任务启动时固定语言。最终 bundle SHA-256 `1a57b6d2be7d1d31215075cf21808864cea1aeb42048da1d930eecb8c3484314`：英文实际帧预览、导出中设置及标签交互、完整原生 Save 保存、按钮恢复、City→Overview→City 保留同一实例及标签状态、Rust opaque handle 到宿主 Sessions 详情加载均通过。种子重启持久化和取消测试来自字幕修复前 `81e785…` 包，最终包核对原种子，未混称同一 hash。

实际原生成片 `/tmp/city-final-uat-20261004.P4lHF0/city-final-en.webm`：VP9、1920×1080、1,451 帧、约 48.34 秒、时间戳约 30 FPS。容器检查不等于完整解码/画质验证；英文预览截图同目录。完整命令、限制及版本证据见 `APP_LAYER_WIP_ACCEPTANCE_2026-10-04.md`。本轮明确排除连续黑闪根因任务，不能据此批准合并或发布；未安装到 `/Applications`、未自动提交、推送或合并。下方为历史记录，旧“原生待打包”不代表当前状态。

## 2026-10-04 后续修复：浏览器验证通过，原生待重打包

宿主 usePlugin 的工具栏/内容 aria-label、加载/就绪、故障重试与本地诊断改用共享英中文案，保留插件提供的工具文案和原始诊断码；新增 City/Metrics 两种名称的插值及无硬编码中文测试。普通 Tab 返回复用实例后显式 plugin_invalidate，补齐隐藏期间取消事件订阅可能遗漏的权威数据变更，不重建 UI。新增浏览器断言确认返回发生刷新，同时场景标记、实例及标签设置保留。

类型检查、i18n 合同、City locale 与插件架构检查通过。串行 --recovery-only 重跑通过：交互/种子/键盘选择/摘录/PNG/视频取消、Tab 保留及返回刷新、语言同步、第二插件故障/重试/切换、resize/context 恢复和数据/sender 校验。首轮故障提示断言因统一使用共享“暂不可用”译文而超时，调整旧“暂时不可用”断言后完整重跑成功。此修复尚未重打包进当前运行的原生 bundle；原生完整导出、下钻与连续黑闪验收仍未闭合。

## 2026-10-04 解锁后最新候选：部分通过

通过 Computer Use 冷启动 worktree bundle，SHA-256 `e0510962407a22f4bb3908c38bd1815e99a54d70cbac0bf547d971d152e05706`。真实 264 条会话正常显示；持续帧采样 hidden=false、contextLost=false，frameAgeMs 约 2–34 ms。航拍两次截图镜头不同，前台航拍实际运动。City→Overview→City 保留 plugin-city-1 与隐藏标签状态：离开 loopScheduled=false，恢复 loopScheduled=true、hidden=false，未发生 reload。窗口 zoom 后 canvas 从 1365×1068 变为 1983×1275，继续绘制；回放游标可到 0 并返回实时。

原生挂载记录 attached=true、repaired=false、hiddenAncestor=false、windowVisible=true。因此本轮没有触发条件性挂载修正，**不能把恢复归因于该修正，也不能证明此前 hidden=true 的确切原因**。不主动锁定用户机器做实验。宿主 AX 仍有中文“City 工具栏/插件内容/已就绪”，虽然可见工具栏与内容为英文，语言验收并非完全闭合。窗口变化抽样未见整屏黑闪，但不是连续帧级黑闪验收。最新完整导出、种子、下钻仍需验证，不沿用旧 hash 的产物作为最新证据。

证据目录 `/tmp/city-native-uat-20261004-cdTjFT`：continuous-render.png、attachment-resume.json。未安装到 /Applications、未提交或合并。

## 2026-10-04 Computer Use 复测：未通过

后续候选：新增 macOS 原生挂载检查（创建及恢复时），仅在子 WKWebView 不属于工作台 NSWindow 时挂回实际 contentView；诊断记录 attached/repaired/hiddenAncestor/windowVisible，不采集用户数据。此为针对底层挂载差异的待验证候选，不是已确认根因。`cargo check --release` 与通用插件架构检查通过；Computer Use 再次报告 Mac 锁屏，按技能要求暂停原生操作，等待手动解锁。不能以构建成功替代持续渲染验收。

用户解锁后通过指定 worktree 的 bundle 冷启动，不使用 `/Applications` 或裸二进制。`616ee314…` 候选真实加载 264 条会话、英文界面，但 15 秒后 `plugin_boot_timeout`。本地日志显示心跳正常、modelApplied=true、contextLost=false、hidden=true、canvas=300×150、firstFrame=false；不能归因于数据库加载失败或 WebGL 上下文丢失。

首帧候选 SHA-256：`e6ae80b57e3ce8791683f85cc8853a5b4dd248a3e2d7373f5f18263d9a5dcb0a`。模型就绪同步绘制后，原生显示英文工具栏与真实 3D 场景并进入 City ready。然而日志持续 hidden=true，frameAgeMs 从 1563 增至 12615；航拍按钮可进入/退出，但动画未持续执行。**这只是首帧改善，不是根因闭合，候选不得记为原生验收通过。** 类型、帧及迁移测试通过，bundle 构建通过；仍需解决 WKWebView 可见性/动画调度，再验收种子、导出、下钻、Tab 和黑闪。

证据目录：`/tmp/city-native-uat-20261004-cdTjFT`（含基线 boot-timeout.json）。Computer Use 后续一次截图出现 ScreenCaptureKit -3811，这是捕捉工具错误，不作为应用崩溃证据。未替换安装版本、未提交/合并。

## 测试对象

分支 `codex/app-layer-city`，worktree `/Users/Admin/.codex/worktrees/app-layer-city/skill-vitals`。
通过 `cargo tauri build --bundles app` 构建，并使用 `open -n <bundle> --args --show-workbench` 启动；没有运行裸 menubar 二进制，也没有替换 `/Applications` 的旧安装。

新包路径：`apps/desktop/src-tauri/target/release/bundle/macos/agent-vitals.app`。
主程序 SHA-256：`8919885adf44c869fd4eb5405ddef8a7d5d1fd78f78bf19fd69b8e84784ea6bb`。
环境：macOS 26.5.2（25F84）。使用 computer-use / Sky 的真实点击、键盘、拖拽、原生保存对话框和窗口截图，不用浏览器回归替代原生验收。

## 已验证

| 项目 | 结果 / 证据 |
| --- | --- |
| Release 构建 | 成功生成 `.app`，Rust 构建约 3 分钟；已有未使用函数警告和 JS chunk 体积提示，不是编译失败。 |
| 新包启动与 Overview | 正常显示本机数据；进程路径确认来自上述 worktree bundle。 |
| City 内嵌与导航 | 与 Overview 平级，主导航保持可见；不是独立 AgentCity.app。 |
| 真实数据 | 30 天显示 266 个会话；切换 7 天显示 33 个会话，统计随本机同步变化。 |
| 原生后台视频任务 | 成功启动，显示 1920×1080，进度持续推进，未走软件渲染降级。 |
| 导出期间交互 | 标签切换、重置视角、播放回放、回到实时、时间范围、设置和前台航拍启动/停止均能操作。 |
| 取消与重新启动 | 插件内取消按钮恢复“导出视频”，重新启动正常；Escape 也取消任务。 |
| 导出中离开 City | Overview 正常显示；返回 City 为新实例，无残留导出进度。该 UI 证据不是 Worker 内存/进程审计。 |
| 尺寸变化 | 最大化及实际拖拽右下边框缩小窗口后，City 仍有场景画面。 |
| PNG 保存 | 原生保存对话框可操作；保存的 `city-uat.png` 为有效 2560×1440 PNG，约 4.2 MiB。 |
| 独立完整视频导出与保存 | 重启后单独运行短片导出，进度 0→45→72→98→保存对话框；保存 `city-uat.webm`，文件 67,367,296 字节（约 64.25 MiB）。 |
| 视频容器内容 | 解析实际落盘 EBML：VP9、1920×1080、1,362 个视频块，声明时长 45,367.41ms，首/尾时间戳 0/45,367ms，平均帧率 29.99978fps。这里是容器与时间戳验证，不是逐帧解码/画质验证。 |
| 视频保存后恢复 | City 工具栏恢复“导出视频”，场景和 AX 窗口正常；切换 Overview 继续显示本机统计。 |

自动检查：City TypeScript 检查、帧渲染回归、导出任务握手/取消/超时/失败/清理、WebM 拼装字节兼容、插件架构检查均通过。

## 尚未通过 / 待确认

- 城区图例：会话和活跃统计在较窄列中被逐字换行，高度过大；多个截图可复现。
- 导出状态条遮挡图例标题，与其他浮层缺少布局协调。
- 打开/关闭设置后，屏幕可见的导出进度在后续无障碍树中缺失，工具栏取消按钮仍可操作；需复核 WebKit AX 刷新和插件状态标记。
- 在后台视频运行时保存 PNG 后，computer-use 多次读取窗口出现 `timeoutReached`。PNG 文件已落盘；App 进程仍存活，1 秒采样显示主线程主要等待事件循环，没有主线程死锁证据。Finder 能正常读取；同名旧安装被工具按名称定位时启动，已退出旧进程。重启新包后恢复可读取。不能把该现象直接判定为 App 崩溃或已解决。
- 没有逐帧屏幕录制，离散截图未见整页黑屏，不足以证明短暂闪黑完全消失。
- 没有做全部宿主栏目、全量数据、长片、低端硬件、不支持编码器、真实 WebView 崩溃注入的 UAT。

本地测试文件与截图：`/tmp/agent-vitals-city-uat-zMECx8`（可能被系统临时目录清理；不上传）。

## 修复前结论

核心后台视频路径完成了原生启动、交互、取消、导航、完整生成和保存验收；不能宣称全部 UAT 通过。图例/浮层布局问题已复现，后台视频与 PNG 同时运行时保存后的窗口读取异常待定位。单独视频保存未复现该异常；需追加 PNG 单独保存与并发导出的可重复对照测试。短暂闪黑仍需连续录像或逐帧采样验收。

## A 方案修复与复测

上述记录保留为修复前基线。本轮新增实际影片帧预览：后台保持 30 FPS 固定时间步长编码；前台最多 640×360 / 2 FPS，不运行第二套航拍镜头。一次仅一个 ImageBitmap 在途，绘制后释放并确认，取消后的迟到位图也释放。

修复：城区统计移到完整第二列；预览与图例分区，建筑详情出现时让出信息区；设置 Escape 优先关闭对话框，不取消影片；视频期间禁用拍照，原生选择目标后复核发起实例。自动画质从节能档启动，首分钟不升级。软件 WebGL 的 UI 限制实际 640×360 / 15 FPS、PNG 限制实际 640×360，硬件 PNG 维持 2560×1440，影片输出时间戳不变。宿主取消按钮同步百分比，作为独立于插件 WebView 无障碍缓存的状态入口。

验证证据：

- TypeScript、导出任务握手/超时/位图确认与释放/回调和传输异常/迟到帧、WebM 字节兼容、帧表面及软件像素预算、插件架构七项检查通过；City 数据、地形、布局、镜头、设施、素材回归通过。
- 最终资源的真实 Worker 测试通过：76 帧影片编码并解码，75 张非空预览，896 次 UI rAF / 455 次计时器回调，实际 UI 按钮可点击；320×180 / 1 FPS 测试影片 1,074,370 字节。此测试不替代原生 1080p 验收。
- 软件 WebGL 的 `--features-only` 回归通过原有 5 秒交互门槛；此前未限制 UI/PNG 实际像素时失败，未通过放宽门槛处理。覆盖 PNG、录制期间交互、设置 Escape、取消等。
- 原生 computer-use 看到实际航拍预览从标题镜头推进到城区及全景，图例不再逐字换行，拍照按钮禁用；Escape 关闭设置后进度继续推进。截图：`/tmp/agent-vitals-city-uat-a-19NDF3`。
- 原生自动画质初版出现 `plugin_unresponsive`，节能对照恢复；采用节能启动后本轮正常加载。宿主导航始终可用，不将这一观察当成任意设备无故障保证。

仍保留的边界：

- 关闭设置后 WebKit AX 树仍可能漏报插件内预览/进度；重建节点未解决，已撤回。插件内可见预览与编码继续，改由宿主取消按钮同步百分比提供状态入口，不宣称 WebKit 缓存问题消失。
- 尝试绑定保存对话框父窗口时，rfd 0.15 同步实现同时调用 `beginSheetModalForWindow` 和 `runModal`，实测保存按钮禁用；已撤回，保留非 sheet 路径。该候选影片生成成功但取消保存，不能计为落盘成功。
- 原并发 PNG 保存后的窗口读取超时根因尚未确证；禁止并发属于风险收敛，不等于确认死锁根因。
- 短暂黑闪尚未获得连续帧级验收。computer-use 本轮出现 ScreenCaptureKit −3811/−3812 及 `noWindowsAvailable`，重试恢复；工具错误不能直接等同 App 崩溃。
- 与 Rust release 链接并行的浏览器软件渲染复测仍出现 5 秒点击超时；单独交互回归通过，不等于高 CPU 负载下响应保证。旧尺寸断言也曾错误要求软件画布与 CSS 尺寸一致，现按降分辨率预算验证实际 buffer 和同帧重绘，不能把该断言超时当成渲染引擎故障。

串行 `--recovery-only` 回归通过：新增宿主百分比入口、软件 PNG 尺寸断言、设置 Escape、原有 5 秒交互门槛、连续尺寸变化同帧重绘、上下文恢复、第二插件接入/失败重试/销毁切换，以及 iframe sender 检查均通过。该轮候选 `.app` 主程序 SHA-256 为 `bf7549fa56c20885f2becfc78157e5242137c1a3c0eae4c65956c28e284915d9`，没有替换 `/Applications` 旧安装。

该候选原生冷启动仍出现 `plugin_unresponsive`，不能宣称仅靠节能启动已彻底解决。代码复查确认：首次 `toolbar.update` 即被宿主当作 ready，而 City 在模型首帧之前发布，启动阶段过早使用运行期 5 秒心跳判断。修正为数据已加载且模型首帧完成后才首次发布；空场景首帧不算就绪，空数据/不可用/WebGL 失败有明确降级握手。维持宿主原有 15 秒启动和 5 秒运行期超时。

首帧握手候选（`68168dcaa0a46dd8959e6cbd773f6e13b26eec008a3c9613b64fbf5fecf6bb4e`）冷启动出现 `plugin_boot_timeout`，进一步说明首次绘制缺失不能只靠握手阶段修复。新增活动原生子 WebView 的 `BackgroundThrottlingPolicy::Disabled` 和初始焦点设置，验证 WebKit inactive scheduling 假设；切出 Tab 仍销毁实例，超时规则不放宽。不能在复测前认定这一假设为已确认根因。

## 本地日志与 Tab 保留修正

本地诊断只保留最近 100 条技术事件，心跳每 2 秒采样一次：可见性、焦点、模型/首帧、循环状态、上下文丢失、帧龄和画布尺寸。宿主按字段和类型白名单接收，不记录业务 DTO、提示词或异常原文，不上传。诊断输出为系统临时目录中的 `agent-vitals-plugin-diagnostics.json`（最后一个实例的有界快照）。

原生冷启动日志：2172ms 时 hidden=true、modelApplied=true、firstFrame=false、contextLost=false、buffer=300×150；4730ms 时 hidden=false；5148ms 发布首个工具栏；6740ms 时 firstFrame=true、frameAgeMs=8、buffer=910×712。说明这次启动的绘制延迟与可见性转换相关，没有记录到 WebGL context 丢失；不能据此概括所有黑闪的根因。

此前普通 Tab 切换确实执行 close/restart，导致相机、回放和设置丢失。新生命周期区分暂停与销毁：切到 Overview 隐藏当前实例并暂停 City 渲染/取消导出；返回 City 使用原实例及状态，刷新布局并恢复绘制。宿主跳过已暂停实例的心跳/启动超时，不放宽活动实例超时。故障、显式重试或替换为另一插件仍销毁旧实例。当前为单插槽、最多保留一个插件实例，不是所有插件常驻缓存。

浏览器使用相同 suspend/resume 语义，经 SDK postMessage 传递，不由宿主访问插件内部 DOM。新增测试检查同实例、场景标记和标签状态保留、隐藏时停止 draw、返回后继续 draw；原生及完整浏览器复测结果待补。

首轮真实浏览器验证中，Tab 保留/暂停/恢复和第二插件失败重试均通过。测试结尾仍假设重新进入必定重查数据，导致旧的错误状态断言超时；按新生命周期改为显式 invalidation 触发重查，不能通过恢复旧的重建行为消除该失败。

新增共享语言上下文，宿主传入已解析的 en/zh-Hans；City 自己的展示目录覆盖工具栏、摘要、城区、回放、设置、详情、导出提示和可访问性标签。语言变化更新现有实例，不加载宿主源码。用户摘录的 blockquote 不参与翻译。文案/可访问性/动态标签和摘录保留单测通过；真实英中切换验证待补。

最终串行 `--recovery-only` 浏览器回归通过：正常交互/PNG/导出取消，连续 resize 同帧绘制和 context 恢复，Tab 同实例/场景/设置保留、隐藏停止绘制与恢复，宿主英中切换同步工具栏/内容且不重建实例，第二插件接入/失败重试，以及数据拒绝的显式 invalidation 降级。文案单测、帧表面测试、导出任务测试、通用插件架构检查、浏览器 transport 测试和前端类型检查通过。该参数不执行全部故意注入的渲染异常用例，不能概括为全测试套件通过。

最终 bundle 构建成功，主程序 SHA-256：`2d9acdbb44ebded208ace1ad8cd48ace71e8a9c10df4c8a646f8e818b1c06262`。原生窗口中的视频已生成并进入保存对话框；为避免丢失正在进行的用户导出，没有强制重启。随后 Computer Use 报告 Mac 锁屏，因此本次原生 Tab 保留/英中同步尚未完成验收，需用户手动解锁并处理保存对话框。`/Applications` 未替换，运行中的旧候选不等同最终 bundle。黑闪的连续帧级原生验收仍未完成，不宣称已彻底消除。
