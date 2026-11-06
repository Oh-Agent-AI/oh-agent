# Agent City 插件化与 Rust/UI 分层架构

版本：v1.6 · 日期：2026-10-03
状态：原生 City 已接入 Rust 本地数据投影；通用 harness 数据接口修复推进中；完整安装/布局/焦点验收不由单元测试代替。

当前数据规范见 [APP_PLUGIN_HARNESS_DATA_CONTRACT.md](APP_PLUGIN_HARNESS_DATA_CONTRACT.md) 与 [CITY_LOCAL_DATA_PROJECTION.md](CITY_LOCAL_DATA_PROJECTION.md)。后文 fixture 阶段的测试记录属于历史证据，不能视为当前数据限制。

## 1. 目标

术语：本文 `host` / 宿主指 Agent Vitals 本体；Codex、Claude Code 等 Agent 执行环境统一称 `harness`，DTO 使用 `harness` 字段，不保留旧 `host` 别名。完整边界见 [HOST_HARNESS_TERMINOLOGY.md](HOST_HARNESS_TERMINOLOGY.md)。

Agent City 是 Agent Vitals 工作台中的一个可独立维护的功能插件，以与 Overview 平级的 City tab 呈现。插件化必须同时成立：独立代码/构建边界、独立 UI 执行边界、版本化消息协议、由宿主管理的故障恢复。City 的错误或无响应不得替换工作台导航或阻断 Overview。City 在同一原生窗口的内容区呈现。

目标方案是独立预编译 UI 产物，由宿主的插件容器加载到单独的嵌入式 WebView；宿主不直接 import City 的 React 组件、引擎或 CSS。具体进程隔离能力必须先在本机 Tauri/WebKit 上验证。目录抽离、React ErrorBoundary、iframe 或创建两个 WebView 本身均不能作为独立进程隔离的证据。

MVP 接入官方 City 插件：原生读取声明的真实本地投影，浏览器预览使用合成 fixture。通用 App Plugin 只关心有哪些 harness 及可用数据能力，不区分内置或热插拔。独立应用发行、动态原生库、第三方安装器和市场不属于本轮目标。

浏览器开发/测试使用独立 iframe 加载同一预编译 City UI，transport 改为 postMessage，复用版本、实例、工具栏与命令 DTO；桌面版继续使用原生 IPC/WebView。浏览器只提供 UI 与消息链路测试，不保证独立进程或死循环隔离。该开发入口只提供合成 fixture，见 [CITY_BROWSER_PREVIEW.md](CITY_BROWSER_PREVIEW.md)。

## 2. 目录边界

```text
apps/
  agent-city/
    ui/                 City React 页面、领域模型、3D 引擎、专属素材
  desktop/
    ui-dev/react/src/app/               宿主导航与 tab 挂载
      plugins/                         通用插件视图插槽与故障提示
    src-tauri/src/plugin_host.rs        实例生命周期、视图布局、消息路由、后台 watchdog
    src-tauri/src/plugin_projections.rs 已登记投影与通用 harness 数据服务分发
    src-tauri/src/lib.rs                注册宿主服务
```

允许共享协议类型，不共享 React 实例、store、DOM、CSS 或数据库连接。City 的构建只依赖自己的源码/依赖和稳定协议；宿主构建只消费 City 的预编译产物和描述符。宿主 shell 的启动不能依赖 City 产物存在或 City 初始化成功。

源码位于 `apps/agent-city`；当前预编译资源目录为 `plugins/AgentCity.plugin/ui/{index.html,assets/}`，`.plugin` 仅为普通目录命名。固定官方插槽的 ID、标题、入口和版本由宿主定义；本轮没有独立 manifest 文件或市场安装规范。

插件前后端通过通用 `PluginRequestV1` / `PluginResponseV1` 信封通信（版本、实例、请求 ID、方法、JSON payload/result、稳定错误码）。公开投影类型放在 SDK；通用 PluginHost 不解释 City DTO，Rust 独立 handler 提供已登记的本地数据服务。未知 provider 明确返回 unavailable，不使用 fixture 冒充本机数据。若插件包含自有 Rust 可执行业务，需放入可独立终止的子进程，通过 IPC 消费核心服务；不能把插件代码经 `#[path] mod` 或动态原生库装入核心后声称故障已隔离。插件 UI 的错误边界也不能保护 Rust 核心进程。

## 3. 运行与依赖关系

```text
Agent Vitals：同一个原生窗口
  ├─ 宿主 WebView：导航、Overview、其他内建页面
  └─ 插件内容区：City 独立 WebView、独立 React/DOM/CSS
                      │ 版本化请求 / 响应 / 事件
                      ▼
             Rust PluginHost：生命周期 / 路由 / 超时
                      │
                      ▼
             Rust 核心 provider → 通用 JSON result
```

独立运行环境嵌入同一个窗口；窗口数量、应用数量和进程数量是不同的设计维度。首次进入创建实例，离开 tab 暂停并清理宿主订阅，返回时复用并重新校验/刷新数据；失败重试或明确 dispose 才销毁重建。插件不得依赖暂停期间收到所有失效事件。

插件通过独立 transport 调用小型 host API。控制消息携带 `version: 1`、`instanceId`、类型及命令的 `requestId`；工具栏快照携带递增 revision。数据请求使用通用信封传递 `method` 和 JSON `payload`，响应按 requestId 对应；City 自行解释其领域数据。宿主控制超时和恢复，不能依赖已卡死插件中的计时器。

Runtime 的 Invalidated/SourceDataDeleted 只转发为当前实例的失效信号，City 通过通用请求接口重新读取，不携带原始 Runtime payload。失效事件目前不含 revision watermark；工具栏 revision 与此是不同机制。

## 4. 故障隔离与当前实现差距

新官方插件的具体接入步骤、SDK 示例及测试要求见 [官方插件接入指南](OFFICIAL_PLUGIN_INTEGRATION_GUIDE.md)。

目标中 City 拥有独立 React 根节点、DOM、CSS 和脚本执行上下文；宿主保持导航与 Overview。插件容器在载入失败、握手超时、无响应或执行环境退出时，销毁 City 实例、显示故障提示并支持局部重建，不重新加载工作台。

正式入口使用通用 `usePlugin(active, { id, name })` 和 Rust `PluginHost`，不再 import City React 源码或路径编译插件后端。`apps/desktop/plugins.json` 是官方内置插件的单一描述表：ID、名称、入口、命令空间和构建源码路径供导航、Rust、浏览器适配器和构建脚本消费。生产目前登记 City；Metrics 仅为第二插件测试 fixture，不随发行包安装。共享 UI transport 位于 `packages/agent-vitals-app-sdk/src/ui-host.ts`；City 的命令、DTO 和窗口参数解释留在插件侧。浏览器通过第二插件验证多插件切换，原生第二插件的实际 WebView 验证尚未完成。Rust 通用请求接口在尚无 provider 时返回 `provider_unavailable`。Rust 后台 watchdog 独立于宿主 JS 轮询：启动期限 15 秒，心跳及命令期限 5 秒；失败状态保持，宿主关闭旧视图并提供局部重试。WebKit 自动重载已就绪页面也视为失败，不能静默沿用旧实例。此前 City 原生完整故障回归连续三次通过，人工布局/焦点验收仍待完成。

旧独立应用方案中的职责分离、描述文件单一真源、版本化数据投影和插件私有状态可继续参考；独立 `.app`、安装授权、更新回滚和市场规范不作为本轮同窗官方插件 MVP 的验收要求。真实数据开放仍须满足仓库 serving-face 约束，不能因简化插件加载而跳过。

Tauri 锁定版本 2.11.5 的 `Window::add_child` 依赖 `unstable` feature。第一轮必须验证同窗子 WebView 的布局/焦点/显隐，以及宿主和 City 的实际执行/进程故障边界。对 City 注入受控死循环、终止属于测试 City 的执行进程后，Overview 仍必须可交互；若平台复用进程使该要求失败，必须调整隔离承载方案并记录阻塞，不能默默退回 iframe 或同树 React。全系统资源耗尽、共享 GPU 故障等更大范围故障不承诺绝对隔离。

参考：[VS Code Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)、[Webview 的独立上下文和消息通信](https://code.visualstudio.com/api/extension-guides/webview)、[Tauri 进程模型](https://v2.tauri.app/concept/process-model/)。借鉴故障边界、host API 和生命周期，不把 VS Code 的机制直接当作当前 Tauri 实现已获得的保证。

## 5. City MVP 本地演示数据

2026-10-03 接入更新：官方内置插件已增加 Rust 只读真实数据投影，详见 [CITY_LOCAL_DATA_PROJECTION.md](CITY_LOCAL_DATA_PROJECTION.md)。此前 fixture-only 与 provider 未注册的段落为早期验收记录；当前浏览器/Standalone/隔离探针仍使用 fixture，原生生产 City 使用注册投影。该更新依据修订后的 `AGENTS.md` 第 6 条，不等于完成旧独立应用方案的 broker、签名和安装生命周期。任务摘录已包含在接口中，尚未实现展示面板。

City UI 内部演示 DTO 使用窗口 `{ windowDays: 7 | 30 | 90 | 366 }`，它不是 Rust PluginHost 的通用协议：

| 字段 | 用途 |
| --- | --- |
| `protocol` | 固定 `city:v1`，便于契约演进 |
| `generated_at` | 投影更新时间 |
| `window` | 窗口天数、显示标签、起止时间 |
| `sessions` | 合成/后端会话摘要、`harness`、首末时间与 token 计数 |
| `findings` | `harness` 粒度的类型/级别/计数摘要，不包含原文 |
| `coverage` | 总数、返回数、截断和未知时间计数 |
| `status` | `ready` / `empty` / `stale` / `unavailable` |

该 fixture 只用于渲染与交互验收，使用合成 ID。真实数据接入不得绕过通用请求信封，并须按仓库 serving-face 与授权规则实现。

### 统一顶部工具栏

保留原工作台布局：左侧 Overview / City 导航和顶部工具栏均属于宿主，City 独立 WebView 只覆盖内容区，不覆盖宿主导航或工具栏。原 City 航拍等操作仍显示在宿主顶部，不因为执行隔离增加第二套操作栏。

City 定义工具项及业务状态；宿主渲染通用按钮/选择器；执行逻辑留在 City。独立 WebView 不使用 React Portal、不向宿主传 React 组件或回调、不直接操作宿主 DOM。现有 `ToolbarActions` 仅可继续用于宿主自有页面。

最小通信约定：

| 消息 | 方向 | 内容 |
| --- | --- | --- |
| `toolbar.update` | City → PluginHost → 宿主 | 当前实例、递增 revision、工具项描述（id、commandId、label、button/select 类型、enabled、选中值/选项） |
| `command.execute` | 宿主 → PluginHost → City | 当前实例、requestId、commandId、受限参数 |
| `command.result` | City → PluginHost → 宿主 | instanceId、requestId、成功/失败状态及稳定错误码；不传原始错误正文 |

宿主只渲染描述数据，文本不作为 HTML 或脚本执行。MVP 只提供官方 City 所需的按钮和选择器，不引入第三方自定义组件框架。时间窗、画质、标签、重置视角和航拍等命令归属 City；没有恢复的旧功能必须明确标为未实现，不能显示无效按钮。

Rust 从实际 IPC 来源绑定实例，不信任自报 instanceId；仅将命令投递到当前活动实例。工具项 id 必须唯一，选择器值必须属于已声明选项；过期 revision、旧实例状态和旧请求结果不得覆盖当前工具栏。状态发布是完整快照，不以丢失一个增量导致永久状态不同步。

点击按钮不等待插件渲染。命令有超时，执行结果与后续工具栏状态分别处理；例如“航拍已启动”不等于整段播放已经结束，停止/恢复按钮由 City 发布新状态。插件未就绪、无响应或退出时，宿主禁用插件工具项并显示局部故障/重试入口；Overview 导航和宿主窗口操作保持可用。离开 City tab 隐藏其工具项，销毁/重建清除旧状态，新实例重新发布描述。

上述协议已接入正式入口。嵌入模式由宿主统一工具栏呈现时间范围、画质、标签、重置视角和航拍；独立开发入口才显示 City 本地操作栏。种子切换、照片/视频导出和下钻暂未恢复，没有无效占位按钮。旧 CityPage/Portal 仅作为未激活的历史代码保留，不进入正式宿主 bundle。

## 6. MVP 交付和验收

1. City UI 独立构建；宿主运行 bundle 无 City 源码、React/store/CSS 或 three.js；仅加载预编译产物和协议。宿主 npm 依赖及历史守卫仍保留 three，不等于运行时耦合。
2. 工作台导航中 City 与 Overview 平级，点击 City 在同一工作台窗口切换 tab。
3. UI 通过通用插件请求信封请求数据；provider 未接入时使用 City 自带合成 fixture 并明确标示，不读本机数据。
4. 7 天/30 天窗口过滤符合 DTO 的起止范围；无数据、请求错误状态对用户可见。
5. 宿主 React 构建和 Rust 编译/测试通过；City 相关守卫继续通过。
6. 缺失 City 产物时宿主照常启动；对插件加载、渲染、effect、WebGL、请求、受控死循环和执行环境退出做故障注入，Overview 保持可交互，City 可独立重建。只验证 throw/ErrorBoundary 不算完成运行隔离。
7. City 消息按实例、工具栏 revision 和命令 requestId 校验；Runtime 失效信号只路由到当前实例，销毁后清理订阅，旧响应不能影响新实例。

## 7. 明确不做

独立 `AgentCity.app`、第二原生窗口、市场安装包规范、第三方规范、动态原生库、签名市场、安装更新/回滚和多平台发行不属于本 MVP。City 预编译目录随 Agent Vitals 分发；独立运行与故障恢复属于 MVP 的必要范围。

真实数据 provider 必须由 Rust 侧按 AGENTS.md 的本地 serving-face 和授权规则提供；MVP 前端合成 fixture 不构成真实数据接入。
