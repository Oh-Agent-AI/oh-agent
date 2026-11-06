# City 插件隔离与本地诊断验收

日期：2026-10-03。适用分支：`codex/app-layer-city`。

## 结论与边界

原生探针初轮确认：同一个 Agent Vitals 原生窗口中的宿主和 City 子 WebView，在当前 macOS / Tauri 2.11.5 上具有不同渲染进程。终止测试 City 渲染进程后宿主继续运行；销毁旧实例后，新 City 实例可以重建。该早期记录中的 Rust 合成投影链路已由下述通用插件请求接口替代。

**严格复跑曾未通过：`plugin_hang_not_observed`。** 初轮仅检查宿主在死循环注入后存活，未检查 City 心跳确实停止，因此初轮的无响应隔离结论撤回。已确认根因：构建器将无副作用的 `while (true) {}` 删除，产物中的 `hang()` 是空函数。修复使用可观察的 `Reflect.set` 操作保留死循环，构建步骤检查故障标记存在，原生测试继续要求 City 心跳停止且宿主心跳保持，不放宽验收条件。

**修复后严格原生测试通过。** 确认 City 心跳停止、约 1.8 秒后识别无响应、宿主心跳及导航继续响应、终止 City 渲染进程后宿主存活、新实例就绪。脚本同时断言异常映射到原始源文件及关键生命周期事件完整。

重复测试还曾发现单点宿主心跳检查失败（`host_blocked_by_plugin_hang`），不能跳过或按偶发忽略。探针改为在现有阶段超时（20 秒）内要求新鲜心跳，并仍要求实际导航操作成功；超过期限仍失败。这个超时是测试观察期限，不是生产 PluginHost 恢复 SLA。报告当前提供阶段时间戳；更细的心跳年龄诊断尚未交付。

以上记录属于早期承载实验。**现在正式入口已接入 Rust PluginHost，静态架构三项检查全部通过。** 宿主不再 import City 源码或路径编译插件后端；City 独立产物由同窗原生子 WebView 加载。展示 fixture 属于 City 前端；Rust 插件 API 使用通用请求/响应信封，当前未注册数据 provider。宿主运行 bundle 不含 City/Three chunk。

早期完整原生回归连续三次通过，包含正式宿主 tab/工具栏 → Rust → City 的真实链路：窗口选择改变摘要、重置视角、航拍开始/停止；插件异常后局部重试；旧实例消息拒绝；真实死循环后 Rust watchdog 触发宿主提示及新实例恢复；终止精确 City 渲染进程后自动重载被识别为故障并可重建；切回 Overview 销毁 City。通用请求信封重构后，这些记录仍证明 UI/进程隔离，不代表当前已接入真实数据 provider。

最新三轮诊断的宿主/测试 City/重建 City 渲染 PID 分别为 30237/30255/30259、30287/30310/30314、30326/30337/30345。这些属于额外诊断视图的 PID，正式 PluginHost 流程另有实例标识和阶段事件；仅为本机测试记录，不是配置或身份凭据。正式 watchdog 启动期限 15 秒、心跳和命令期限 5 秒，每 500ms 在 Rust 后台检查。早期探针约 1.8 秒观察点不是生产恢复 SLA。

接入浏览器 postMessage transport 并修复 ResizeObserver 缩放循环后，原生完整探针再次通过（宿主 54160、测试 City 54250、重建 54308；`probe_complete`），全部正式工具栏、运行错误、旧实例拒绝、死循环及渲染进程退出恢复检查为 true。浏览器适配器没有替换原生 IPC。

不承诺隔离系统级内存耗尽、共享 GPU 故障或 Rust 主进程崩溃。原生渲染进程强制退出测试不等同于所有真实崩溃类型。当前平台证据不推广到 Windows/Linux。

### Harness 改名后的复验

2026-10-03 将 Agent 执行环境字段统一为 `harness`，Authority schema v31 后，重新构建原生诊断 bundle 并通过完整测试。报告 `agent-vitals-plugin-probe-A9lW9G/native-isolation.json` 的全部检查通过；宿主/诊断 City/重建 City 渲染 PID 为 43086/43475/43523。工具栏实际通信、异常重试、旧实例拒绝、死循环隔离和渲染进程退出恢复均通过。此前三次记录属于改名前版本，不能替代本次复验。

## 可重复执行

在仓库根目录执行：

```sh
node scripts/verify-plugin-architecture.mjs
node scripts/verify-native-plugin-isolation.mjs
```

第一个命令应通过三项静态检查。第二个命令构建独立诊断版宿主 `.app`，通过 `open -n` 启动；没有独立 City `.app`，City 加载预编译 `plugins/AgentCity.plugin/ui/index.html`。仅在 bundle 与 City debug source map 都未被普通构建覆盖时使用 `--skip-build`；否则重新构建。

探针通过 `plugin-isolation-probe` feature 显式启用。普通启动路径不变；探针不启动日志监听、不打开 authority DB，宿主使用合成 preview，City 的通用请求经过实际 Tauri IPC 并在 provider 未注册时明确降级。故障注入 hooks 和 source map 仅存在于 City debug 构建。

## 故障定位

脚本输出本机临时目录内 `native-isolation.json` 路径，包含最多 200 条探针阶段事件，以及正式 PluginHost 的 `plugin_diagnostics`。正式运行仅保存最多 100 条内存事件，含时间、稳定代码及命令 requestId：

| 证据 | 用途 |
| --- | --- |
| instance_id、创建/加载/UI 就绪阶段 | 区分资源加载、脚本执行和页面就绪问题 |
| request-N、request_started/succeeded/rejected | 关联通用 Rust 请求及拒绝阶段，不记录 payload |
| runtime_error、unhandled_rejection、脚本行列号与本地 source map | 定位到原始源码位置，不记录原始错误正文 |
| 心跳、unresponsive_detected、host_navigation_alive | 区分插件无响应与宿主受影响 |
| 渲染进程 PID、renderer_terminated、instance_disposed、restart_succeeded | 验证运行隔离和实例恢复 |

诊断只在本机保存，不上传。报告不包含日志路径、prompt、调用参数、凭证或投影数据。进程 PID 查询使用 WKWebView 的私有诊断 selector，仅限 feature-gated 探针，不作为生产插件身份授权方式。普通 City release 独立构建已检查：无故障 hooks、无故障 chunk、无 source map。

首次实测：宿主渲染 PID 5726，City 5748，重建 City 5764；旧版探针 `status=passed`，但无响应断言不充分。错误定位映射到 `src/debug/isolationFaults.ts` 第 13/14 行。严格复跑 `status=failed` / `plugin_hang_not_observed`，在约 1.8 秒检查点拒绝放行，未继续进程终止和重建阶段。

修复后实测：宿主渲染 PID 14076，City 14085，重建 City 14091；`status=passed`。报告中注入时间 4465ms、识别无响应 6267ms、宿主导航响应 6324ms、终止 City 6369ms、重建成功 7247ms。随后复跑同一 bundle 也通过（宿主 14164、City 14166、重建 14172）。这些 PID 仅是本次测试记录，不是生产配置或授权凭据。

## 剩余验收

1. 原生隔离/恢复以 `.app` 原生探针为验收依据。浏览器开发入口已使用独立 iframe/postMessage transport，完整数据/UI/故障重试回归通过；先前共享对象 mock 的重试失败不再沿用该实现。浏览器无法嵌入 Tauri 原生 WebView，仍不提供原生进程隔离保证。见 [CITY_BROWSER_PREVIEW.md](CITY_BROWSER_PREVIEW.md)。
2. 人工检查缩放、全屏、焦点/键盘、顶部工具栏与同窗切换并保存截图；自动诊断不证明所有可视布局场景。
3. 真实数据授权及旧种子/照片/视频导出/下钻另列后续需求；本轮只有 fixture，无第三方安装或真实数据授权保证。

正式原生插件链路和故障恢复自动验证已通过，但仍不标记全部 MVP 验收完成。普通发行 `.app` 构建通过；发布前必须与 feature-gated 诊断版区分。
