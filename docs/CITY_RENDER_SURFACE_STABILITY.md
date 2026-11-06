# City 绘制表面稳定性修复（2026-10-03）

## 问题与原因

用户报告独立旧 City 与内嵌 City 均出现周期性闪黑，窗口连续缩放时也闪黑。
共同渲染路径存在两个确定的时序缺陷：ResizeObserver 的独立 rAF 可能在绘制 rAF 之后重设 Canvas 尺寸；自动画质统计在绘制之后修改 DPR 和 Canvas 尺寸。二者均可能在浏览器提交画面前清除刚绘制的缓冲。

此外，原生宿主分开设置 child Webview 的位置/尺寸，并在拖动时堆积异步布局请求，会增加中间布局状态。该问题不意味着插件被重新加载，也不等于宿主崩溃。

## 修复约束

- ResizeObserver 只标记 surface dirty，不修改 Canvas；画质选择只提交待应用状态。
- `renderFrame()` 先统一应用质量和表面尺寸，然后立即绘制，在同一同步回调内完成。dirty 状态绕过空闲帧率节流。
- 宽、高、DPR 相同不重设 drawing buffer；宽高/DPR 使用一次 `setDrawingBufferSize` 更新。
- 自动切档要求连续低/高帧率样本、12 秒切档间隔；降档后至少 60 秒不升档，缩放后 2 秒不作画质决策。
- WebGL context lost 时暂停循环；恢复后重新应用表面/画质并恢复可见页面绘制。不启用 `preserveDrawingBuffer`，不以保留旧帧掩盖时序问题。
- 宿主布局请求串行合并到最新尺寸，跳过重复 bounds；原生 Webview 用一次 `set_bounds` 更新位置和尺寸。
- 原有照片/视频的固定导出尺寸仍由 renderFrame 同步应用，恢复后重新使用窗口尺寸。

## 验证

`node scripts/verify-city-frame-surface.mjs` 执行真实引擎方法，使用可控 renderer/clock 验证同调用重设后绘制、尺寸去重、延迟画质、导出尺寸/DPR 恢复以及防抖策略。

`npm --prefix apps/desktop/ui-dev run verify:city-runtime` 增加 Canvas 尺寸 setter 与 rAF/draw 插桩，连续改变 iframe 宿主尺寸，要求实际发生 buffer reset 且没有重设后未绘制就结束的 rAF。此检查不等于原生 macOS compositor 的逐帧像素验证。

原生人工测试必须用新编译宿主 `.app`。旧 `AgentCity.app` 是已退休独立 spike；不会自动获得新插件 UI 的修复，不应作为发行入口。

### 本轮结果

- 引擎方法回归、City 类型检查、宿主类型检查、既有 City 七项测试、插件依赖隔离检查均通过。
- 浏览器完整回归通过；追加 WebGL loss/restore 后以 `--recovery-only` 复跑也通过，绘制恢复。
- 普通 `cargo tauri build --bundles app` 成功。2026-10-03 17:05 构建产物已安装到 `/Applications/agent-vitals.app`，本机 ad-hoc 重签并验证；原安装包保留在 `/Applications/.agent-vitals-render-fix.GqiVSd/previous-agent-vitals.app`。分析数据未改变。
- Computer Use 对新安装进程执行三次实际边缘拖动（缩小/放大/缩小）、自动画质状态检查、手动节能切换及 Overview/City 返回。各动作后的场景正常，导航可用，未发生持续黑屏或插件失败。
- 原生动作后的截图不是拖动期间的逐帧录像，不据此宣称 macOS compositor 在所有设备上完全不存在单帧闪动；确定修复的是上述已复现的缓冲重置时序缺陷。
- 旧独立 `AgentCity.app` 在原构建路径及 `/Applications` 均已不存在，旧进程也已退出，本轮没有再次删除文件。
