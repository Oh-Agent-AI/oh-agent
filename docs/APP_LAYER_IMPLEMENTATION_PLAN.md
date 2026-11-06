# Agent City 插件化 MVP 实施计划

版本：v1.6 · 日期：2026-10-03

2026-10-04 当前规范：原生已有 Rust 本地数据 provider，City 正在升级 v2 并复用通用 harness 身份；App Plugin 不区分来源接入机制。接口见 [APP_PLUGIN_HARNESS_DATA_CONTRACT.md](APP_PLUGIN_HARNESS_DATA_CONTRACT.md)，修复进度见 [HARNESS_INTEGRATION_COMPLETENESS_REPAIR_SPEC.md](HARNESS_INTEGRATION_COMPLETENESS_REPAIR_SPEC.md)。下文早期 fixture 迭代记录不代表当前能力；不能据此宣布本次完整验收通过。

## 目标

按最新目标重新安排三个迭代：City 必须独立构建、隔离运行、通过通用协议请求宿主能力，由宿主管理生命周期和故障恢复。City 仍是同一原生窗口内与 Overview 平级的 tab。当前目录抽离和 React 错误边界是已有基础，不代表该目标完成。

## MVP 完成定义

- City UI 独立构建，宿主只加载预编译产物；双方只共享协议，宿主不 import City 源码/React/store/CSS。
- Rust 核心提供可信投影服务；插件自有可执行逻辑不能编译进核心进程后声称风险已隔离。
- Overview 与 City 在同一导航、同一窗口下平级切换。
- 保留宿主统一顶部工具栏；City 用描述消息声明工具项和状态，宿主渲染，命令经 PluginHost 投递到 City。禁止跨 WebView Portal、组件和回调共享。
- 插件与 Rust 使用通用版本化请求/响应信封；原生通过登记投影读取本地真实数据，浏览器和独立预览只使用合成 fixture。
- 宿主 build/typecheck/Rust 测试通过，City 守卫通过。
- 缺失 City 产物、插件异常、受控死循环和 City 执行环境退出均不阻断 Overview；宿主可独立重建 City。WebGL 不可用时仍显示摘要。

## 三个迭代

| 迭代 | 交付 | 验收 |
| --- | --- | --- |
| 1：运行隔离验证 | 在同一原生窗口嵌入独立 City WebView；验证当前 Tauri 2.11.5 子 WebView 接口与平台执行边界 | 布局/焦点/显隐可用；注入受控死循环、终止测试 City 执行进程后 Overview 可交互；未通过则调整承载方案，不降级为同树组件后宣称完成 |
| 2：构建与协议解耦 | City 独立构建并加载本地产物；宿主 PluginHost 管理实例与路由；提供通用请求/响应信封 | 删除宿主源码对 City 的 import/路径编译；City 独立 build；协议版本、request/instance ID、provider 缺失降级、超时及旧响应丢弃通过 |
| 3：恢复与 MVP 闭环 | City 与 Overview 同级 tab；实例创建/暂停/销毁/重建；转发投影失效事件；局部故障提示 | 正常 City fixture 可见；产物缺失、请求/渲染错误、无响应、执行环境退出均不影响 Overview；重建与事件清理通过；宿主/City 构建及守卫通过 |

每轮按分析 → build → 测试 → 独立验收进行；分别报告通过和未通过证据，不以独立模块 build 代替宿主端到端验收。

### 统一工具栏接入（迭代 2 / 3）

- 迭代 2：定义 `toolbar.update` / `command.execute` / `command.result`，以时间窗选择和重置视角验证消息往返。宿主不 import City 控件或业务处理函数。City 独立开发入口可自行渲染工具栏，但嵌入模式只在宿主统一工具栏显示工具项。
- 迭代 3：迁移原 City 的画质、标签和航拍等操作；列出已恢复与暂未恢复的功能，不以空实现占位。City 发布 enabled/选中值/播放状态，宿主不推测插件业务状态。
- 验收：顶部只存在一套操作工具栏；选择时间窗确实改变投影请求；重置/航拍命令确实由 City 执行；命令超时可见；切换 tab 不残留 City 控件；重建后旧 revision/实例/request 消息不回写；City 挂起或退出时工具项禁用，Overview 导航可用。
- 已接入正式原生链路：时间范围、画质、标签、重置视角及航拍五项操作；忙碌/禁用状态、错误及重试由宿主统一呈现。种子切换、照片/视频导出与下钻未恢复。

## 接口与数据路径

命名边界：`host` 指 Agent Vitals 插件宿主，Agent 执行环境称 `harness`。内部开发阶段直接改名数据字段、来源 ID、crate 与 CLI，不保留兼容别名；Authority schema v31，旧库可重建但不自动删除。见 [HOST_HARNESS_TERMINOLOGY.md](HOST_HARNESS_TERMINOLOGY.md)。

```text
同一个原生窗口
  ├─ 宿主 WebView：导航 / Overview
  └─ City WebView：预编译 UI / CityEngine
           │ 通用 request/response、失效事件
           ▼
       Rust PluginHost → 登记 provider / 通用 harness 查询接口
```

原生由 Rust 读取 authority 并投影，插件不直接读取日志或数据库。请求/响应信封与公开数据类型定义在 app SDK；City fixture 留在前端。provider 遵守仓库 `AGENTS.md` 的本地 serving-face 约束。暂停/复用/明确销毁遵循当前实现，不再将每次离开 tab 等同于 dispose。

## 暂不做

- 独立 `.app`、第二原生窗口和市场安装包规范。
- 第三方市场、动态原生库和复杂接入 SDK；内置插件描述符/预编译产物加载与运行隔离属于本轮范围。
- 真实数据 grant/broker 的生产身份与安装授权流程；这些以后单独设计，不在 MVP 伪称完成。

## 早期 fixture 阶段验收记录（2026-10-03，非当前规范）

- City 独立源码位于 `apps/agent-city/ui`，独立构建资源打包到 `plugins/AgentCity.plugin/ui`；宿主 App 不 import City，正式 bundle 不含 City/Three chunk。City fixture 保留在前端；Rust `PluginHost` 提供通用版本化请求/响应信封，尚无数据 provider 时返回 `provider_unavailable`。
- 正式 `plugin_host.rs` 和通用 `usePlugin` 管理同窗原生子 WebView、布局与消息；展示名称由调用方配置，City 是当前接入实例，原生适配器仍只注册 City。离开 tab 销毁，重试使用新实例。Rust 后台 watchdog 提供 15 秒启动、5 秒心跳/命令期限，独立于宿主 JS 轮询；失败状态不被旧消息或自动重载覆盖。
- 原生完整回归连续三次通过：真实宿主工具栏与通用 IPC、重置/航拍、脚本异常重试、旧实例拒绝、死循环后宿主局部提示与重建、精确终止 City 渲染进程后重建，最后切回 Overview 并清理视图。额外诊断验证源码定位及请求拒绝。见 `APP_LAYER_ISOLATION_VERIFICATION.md`。
- 宿主 `verify:react`、City typecheck、Rust plugin_host 过滤及通用请求信封测试通过。普通发行 `.app` 构建通过，City release 无故障 hooks/source map；诊断版不是发行版。
- 浏览器开发入口已接入 iframe/postMessage transport，并通过完整 UI/数据/故障重试回归。自动测试复用开发入口的适配器，不再维护跨窗口共享对象的专用 mock。真实 Vite 页面验证了 7 天摘要及标签状态往返；Browser 与原生 transport 复用 DTO，但 iframe 不证明独立进程。浏览器心跳仅记录，不使用软件 WebGL 的心跳延迟判定原生卡死。启动方式与边界见 [CITY_BROWSER_PREVIEW.md](CITY_BROWSER_PREVIEW.md)。
- 全部 `verify:city` 守卫通过，包括素材、地理、布局、数据、航拍、基础设施与道路绘制。
- Harness 不兼容改名完成：crate/模块、字段、CLI、manifest、来源 ID、Python/Rust 及守卫统一命名；Authority v31。Rust release workspace、Clippy、启用 Rust 的 Python 1274 项（8 项跳过）、两侧 16 案例 golden、SDK 合约和改名后原生隔离复验通过。普通 `.app` 已重建，旧数据库未删除，需重建后重新导入数据。
- 人工窗口缩放、全屏、焦点/键盘与导航视觉验收仍待完成；自动原生 IPC/故障回归已完成，不等同于人工验收。真实数据授权接入及旧功能恢复不计入本轮 fixture MVP。

### 官方插件通用化补充

本地数据接入已进入实现阶段：官方 City 描述符声明 `city:v1` 权限，Rust 分发到独立读侧模块，返回真实统计与有限用户输入摘录。实时状态及验收边界以 [CITY_LOCAL_DATA_PROJECTION.md](CITY_LOCAL_DATA_PROJECTION.md) 为准；下文早期“无 provider / fixture-only”记录不代表本次接入后的代码状态。

登记入口统一为 `apps/desktop/plugins.json`；导航、原生/浏览器加载、命令空间和构建不再写死 City。共享 UI transport 迁入 app SDK。删除宿主旧内嵌 City 页面与旧 seed IPC，但不删除用户持久化数据。第二个 Metrics fixture 验证浏览器加载、工具栏命令、故障重试、卸载和切回 City；原生第二插件实际加载和新版安装包验收仍待完成。此前原生 City 回归不能替代这两项。

## 浏览器运行回归命令

```sh
npm --prefix apps/desktop/ui-dev ci
npm --prefix apps/desktop/ui-dev run verify:react
# 自动构建前端并打包 City，无需 Rust。
npm --prefix apps/desktop/ui-dev run verify:city-runtime
```

运行脚本将生产 `ui-react-dist` 复制为固定测试快照，自行启动仅绑定 `127.0.0.1` 的静态服务；宿主使用浏览器 fixture facade，City 通过与开发页面相同的 postMessage 适配器通信，外部页面请求被阻止。浏览器缺失时可在 `apps/desktop/ui-dev` 执行 `npx playwright install chromium`。测试失败非零退出，不把跳过测试计作通过。真实 watchdog 期限及进程隔离由 Rust 单测和原生探针验证。

已有错误边界测试不隔离死循环、内存耗尽或原生进程崩溃。新版第一轮以实际运行隔离验证为前置门槛；全系统资源耗尽、共享 GPU 故障等更大范围故障不承诺绝对隔离。
