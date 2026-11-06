# App-layer WIP 验收（2026-10-04）

基线：`codex/app-layer-city-wip` 的 `fee2efbb`，本轮另有回归守卫修复和影片字幕语言修复。用户要求执行剩余任务 2–5，明确暂不执行黑闪根因和连续验收（任务 1）。本报告不批准合并或发布。

## 回归及修复

- `cargo test --release`：首次失败于旧根 facade import 预算（285 > 284）。新插件投影改用 `agent_vitals_runtime::core::clock::now_ms`，未提高预算；完整重跑通过，61 个测试汇总行，1,872 项通过，1 项本机安装检查显式忽略。
- `cargo clippy --release --all-targets -- -D warnings`：通过。指根 workspace 默认成员，不是独立桌面 workspace 的严格 lint。
- `cargo build --release`：通过。
- Python 全量：1,274 项，首次未传 Rust CLI 路径，210 项跳过。设置 `AGENT_VITALS_BIN` 完整重跑后无失败，8 项跳过。
- Hypothesis 缺依赖的属性测试在 `/tmp/city-ci-python.KgNHgW` 临时虚拟环境补依赖后单独执行：9 项通过。未改变全局 Python。其余跳过主要为明确的未抽取架构检查及已拆到外部 DSH 仓库的锁步检查，不能视为通过。
- Python/Rust golden：两种实现各 16 个 case 逐字节一致，未更新快照。Rust 构建后再次执行 golden 并通过。
- `npm run verify:react`、`npm run verify:city`：通过。
- SDK `npm run verify:contracts`：15 项通过，生成类型及 typecheck 通过。
- 发布工作流守卫通过。harness 术语守卫初次因 DTO 已迁入 SDK 而失败；改为检查共享 `CityUiProjectionV1` 定义、provider 别名及禁止旧 `host` 字段，复测通过。
- `git diff --check`：通过。

以上是本机运行 CI 对应命令，不是 GitHub CI 状态证明，也不覆盖其他操作系统。

## 原生任务状态

最新提交的宿主双语辅助标签和返回 Tab 刷新代码已包含在本轮打包源中。`cargo tauri build --bundles app` 初次成功；修复 facade 路径后再次构建成功（2m22s）。最终 bundle 位于 `apps/desktop/src-tauri/target/release/bundle/macos/agent-vitals.app`，主程序 SHA-256 `81e7853fd4ae03f6e5d011d653e8caf464e3f7524aba3c94175ef6f1980daac1`；领域路径引用改为同一函数的正式出口，不改变成品二进制。现存桌面 dead_code 和前端 chunk 大小警告仍可见，未描述为零警告。

用户解锁后用 Computer Use 验收上述 `81e785…` 包：宿主及 City 中英文同步；种子从 `1703294958` 改为 `20261004` 后场景更新，退出并重新打开 bundle 后仍为新值，随后恢复原种子；City 会话详情通过 opaque handle 导航到宿主 Sessions 并成功加载详情。视频取消后按钮恢复；Escape 仅关闭设置，不取消导出。发现英文 UI 下 Worker 影片字幕仍硬编码中文。

修复：前台与 Worker 共用纯 `cinematicCopy` 函数，导出启动时捕获语言，避免运行中字幕语言漂移。新增英文/中文标题、时间范围、数字、城区和片尾测试及 Worker 任务语言传递断言；City typecheck、locale、film job/muxer 测试通过。

字幕修复后再次 `cargo tauri build --bundles app` 成功，最终二进制 SHA-256 `1a57b6d2be7d1d31215075cf21808864cea1aeb42048da1d930eecb8c3484314`。冷启动新 bundle 后原生完整导出通过：真实 264 条会话，英文实际输出帧预览，后台生成过程中标签切换、设置打开/关闭可响应；拍照按设计禁用。完成后原生 Save 按钮保存到 `/tmp/city-final-uat-20261004.P4lHF0/city-final-en.webm`，Photo/Export video 恢复可用。

成片容器检查：71,810,608 bytes，VP9，1920×1080，1,451 帧，25 个关键帧，时间戳 0–48,333 ms、单调递增，约 30.0002 FPS，duration 48,338 ms。这是实际原生文件的容器/时间戳检查，不冒充完整解码或逐帧画质验收。截图 `english-film-preview.png` 同目录。

补充解码检查：通过仅监听 127.0.0.1 的临时文件服务，在无头 Chromium 中解码上述原生文件，并在 5、24、44 秒 seek 后采样画面，三个样本均有非黑像素，分辨率 1920×1080、时长 48.338354 秒。初次采样 0 秒为影片淡入黑帧，不能作为成片异常结论，后改为明确时间点；首轮跨源 canvas 检查缺 CORS 亦已修正测试服务配置。此为三点解码抽样，仍不是完整逐帧验收。

最新生产 Worker `node scripts/verify-react-city-runtime.mjs --film-only` 通过实际 WebM 编码/解码与导出期间 UI 响应检查：76 帧、75 次预览、320×180。软件小尺寸 fixture 与上述真实原生 1080p 文件是两组独立证据，不混用帧数或分辨率。

最终包 City→Overview→City 返回仍保留隐藏标签状态，诊断实例仍为 `plugin-city-1`，记录 suspended/resumed，恢复后本地统计更新；随后恢复标签显示。最终包下钻再次成功，宿主加载对应 Codex 会话统计与时间线。种子重启持久化及取消操作在前一 `81e785…` 包验证，最终包另核对原种子；不将其描述为最终 hash 的重复完整测试。

未替换 `/Applications`、未推送、未合并、未自动提交本轮修复。黑闪任务按用户要求排除，不宣称通过。

## 本机日志

`/tmp/city-wip-{python-tests,python-rust-tests,python-golden,rust-tests,rust-golden,clippy,react-tests,city-tests,properties,app-build,cli-build}-20261004.log`。后续同名重跑会替换日志，因此本报告明确记录首轮失败和修正内容。

字幕修复及补验日志：`/tmp/city-wip-film-locale-build-20261004.log`、`/tmp/city-wip-final-film-browser-20261004.log`、`/tmp/city-wip-native-video-decode-20261004.log`。
