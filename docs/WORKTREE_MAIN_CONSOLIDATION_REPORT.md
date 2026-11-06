# Worktree 归并执行报告

日期：2026-10-04。范围是收齐已有工作，不是宣称扩展规格所有阶段完成。

## 来源与恢复

- 原 main 备份：`codex/backup-main-20261004`，执行基线 `735f6fa3`。
- 主工作区全部源码检查点：`codex/snapshot-primary-20261004` / `94d3579a`。
- City dirty 工作区检查点：`codex/snapshot-city-20261004` / `0e01b207`。
- 清理前发现 City 新增 UX 文档，另保存为 `f7378f89` 并合入；`CITY_UX_SPEC.md` 的场景优先/HUD 目标仍是待实现、待验收。
- wildlife 未跟踪旧版检查脚本：`codex/snapshot-wildlife-20261004` / `805eea17`；较完整的新版本已归并，不用旧脚本覆盖。
- 复用 E08 checkout，在 `codex/main-consolidation` 整合最新 main、City 唯一变化与主工作区源码；保留原提交历史和备份分支，不 force push。

## 保留的变化

1. E08 与 harness 命名基线；旧 host 文件没有覆盖现行注册和 authority v31。
2. City 高架出口/空间索引/植被避让，以及 resize UAT 原始证据。
3. 桌面官方 catalog opt-in、payload 预览/确认、序号下限恢复和流式大小限制；使用新 harness API。
4. catalog 价卡兼容镜像、发布门、CI、官网 City iframe 与当前独立插件的生产预编译资源；保留素材许可证。
5. 修正架构文档：City 是与 Overview 平级的官方前端插件，不是独立 macOS City App。Rust 查询及版本化 projection 属于 Agent Vitals 本体。

## 本轮发现的回归

City 出口变化使 seed 42 航拍相对加速度超过原断言。原因是距离映射到曲线时弧长采样过稀；`cityCinematic.ts` 将采样数从 4,000 提高至 16,000 后，5 个 seed 的 full/short 原检查全部通过，未放宽阈值。

官网旧 City debug bundle 已用当前生产 bundle 重建。生成 JS 中的 GLSL 保留空白，`.gitattributes` 仅对生成目录禁用对应空白检查；源码仍通过 diff 检查。

浏览器截图又发现官网切换 iframe 后舞台高度折叠：mock canvas 同时脱离文档流。保留 canvas 的正常布局后，ready 状态舞台高度实测 476.3px，截图显示 3D 城市。补充仅驻留内存的 `city-settings` 示例种子接口，消除官网预览的无意义保存告警。

原生探针首次在 `formal_instance_not_disposed` 失败，原因是旧断言要求离开 City 即销毁，与当前挂起复用生命周期不符。更新探针分别检查挂起、返回复用/resume 与显式销毁；错误、卡死、渲染进程退出和恢复检查保留。

## 验证

- `cargo test --release`：通过。
- `cargo clippy --release --all-targets -- -D warnings`：通过。
- `cargo build --release`：通过，authority schema v31。
- 桌面 `cargo test --release --lib`：160 项通过，含 catalog 新增 3 项。
- catalog/价卡专项 Python：25 项通过；`verify_catalog.py` 镜像逐字节一致。
- Python 与 Rust 各 16 项 golden：通过，无 golden 更新。
- City typecheck、宿主 `verify:react`、`verify:city`、插件架构与布局 source guard：通过。
- 全量 Python：1,284 项通过；指定新 Rust CLI 后再跑完整套件同样通过，8 项按测试条件跳过。
- 官网浏览器检查：Agent City 导航、滚入视口懒加载 iframe、实际 3D 画面及 ready 状态非零舞台高度已观察到；此证据不等于逐帧视觉验收。
- 原生 `.app` 故障注入：通过；独立渲染 PID、runtime error / rejection 源码定位、卡死/进程退出后宿主存活、恢复、过期消息拒绝、正式插件挂起/复用/显式销毁均通过。机器本地报告：`/var/folders/_b/g4fllrs95g3bgmcb1v8_0mh00000gp/T/agent-vitals-plugin-probe-VCtrQH/native-isolation.json`。
- 正式（非 probe）bundle：`bash scripts/build-macos-react-app.sh` 通过，应用与 CLI 均为 arm64，CLI 1.4.0 / authority v31；本地诊断构建未做 Developer ID 签名，不是已签名发行包。

## 保留的边界

- catalog 目前是空 harness index：验证了 0 个 commit-pinned payload，不能声称真实发行 payload 安装验收完成。
- resize UAT 的约 0.43 秒捕获间隔不能排除单帧闪黑，不能写成已彻底修复。
- E00/E09–E15 和 E08 全规格剩余矩阵不因分支归并标记完成。
- 官网仅使用示例数据；插件不得直读 authority DB / harness 日志，不增加任何用户数据上传路径。

## 主分支与清理

主工作区已 fast-forward 到整合提交 `133becbf`，并普通 push 同步远端；此后本报告的收尾提交不改变已验收源码。执行结束仅保留主工作区，worktree 从 20 个降至 1 个。

- 17 个旧 `.claude/worktrees` 已核对后正常移除，保留历史分支及 wildlife 源码快照；11 个共享 node_modules 仅解除符号链接本身，共享目标仍存在。
- 两个 Codex worktree 已完成可恢复归档，任务附件中可恢复；没有删除其分支或源码检查点。
- 停止了待移除 checkout 的两个旧 Vite 服务及本轮临时 HTTP 服务，关闭临时浏览器标签。
- 最新非 probe bundle 已放到主工作区 `apps/desktop/src-tauri/target/release/bundle/macos/agent-vitals.app`，复制后再次验证通过；旧 bundle 保存在同目录 `agent-vitals.pre-consolidation-20261004.app`。
- 本轮 native 隔离报告另存同目录 `native-isolation-20261004.json`。以上是被忽略的本地构建/验证产物，不是源码发布内容。
- `/Applications/agent-vitals.app` 未替换，正在运行的安装版本未更改。未使用 force push、hard reset 或强制 worktree remove。
