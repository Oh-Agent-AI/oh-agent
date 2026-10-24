# 官方插件接入指南

适用范围：Agent Vitals 当前的官方内置 UI 插件 MVP（2026-10-03）。接入结果是在工作台增加与 Overview 平级的 Tab，内容运行于同窗独立 Webview；浏览器预览使用 iframe。不是独立 `.app`，不支持用户动态安装第三方包。

## 1. 目录和职责

以新插件 Metrics 为例：

```text
apps/agent-metrics/ui/                 # 插件自己的源码、依赖、package-lock.json
  index.html
  package.json
  vite.config.js
  src/main.ts
  dist/                              # 构建产物，不手工维护
apps/desktop/plugins.json             # 官方插件注册表
packages/agent-vitals-app-sdk/         # 共享协议和 UI transport
apps/desktop/src-tauri/src/
  plugin_host.rs                     # 通用生命周期、消息、实例校验
  plugin_projections.rs              # 官方数据投影处理器分发
```

打包后入口为 `plugins/AgentMetrics.plugin/ui/index.html`。`.plugin` 是资源目录命名，不是可执行文件或独立 macOS 应用；当前没有额外的目录内 manifest。

插件自己的 React、状态、DOM、CSS 与依赖留在插件项目中。宿主只消费描述表和预编译资源，不 import 插件源码。不需要为每个插件新增 `useMetricsPlugin`、宿主页组件或另一份 iframe/Webview 通信实现。

## 2. 注册插件

在 `apps/desktop/plugins.json` 的 `plugins` 数组追加（保留已有 City）：

```json
{
  "id": "metrics",
  "name": "Metrics",
  "entry": "plugins/AgentMetrics.plugin/ui/index.html",
  "commandNamespace": "metrics",
  "source": "apps/agent-metrics/ui",
  "dataProjections": []
}
```

| 字段 | 用途与约束 |
| --- | --- |
| `id` | 唯一标识，也是导航 hash；小写字母开头，后续小写字母/数字/连字符。不得与 overview、usage、sessions、findings、test、trust、skills、settings 等宿主栏目冲突。 |
| `name` | Tab、窗口工具栏标题、加载与重试文案的展示名。 |
| `entry` | 相对资源入口，当前格式 `plugins/<Name>.plugin/ui/index.html`；Name 使用英文字母开头的字母/数字/连字符。不同插件使用不同目录。 |
| `commandNamespace` | 命令前缀，例如工具项 `metrics.refresh`；格式同 id，建议每个插件独立命名。 |
| `source` | 当前构建脚本支持的源码位置：`apps/<lowercase-name>/ui`。 |
| `dataProjections` | 允许读取的投影键，例如 `metrics:v1`；默认无数据权限。登记权限不等于实现处理器。 |
| `allowLocalExports` | 可选，默认 false；允许活动插件 blob 下载，原生通过保存对话框确认，不允许网络下载。 |
| `navigationTargets` | 可选，默认空。声明 `["session"]` 后，宿主用活动插件的 id 解析本插件自己的 opaque handle（`app:{pluginId}:{session_key}`）。不按插件名字再写一套解析器。 |

`debugProbeMarker` 是可选的诊断构建检查标记，仅有故障注入需求时设置；普通插件不必复制 City 的标记。

注册表由导航、原生加载器、浏览器资源路由和构建脚本共同消费。原生以 `include_str!` 编译嵌入，修改后需要重新编译 APP；开发服务器修改注册表后建议重启。当前一次只运行一个活动插件，不支持多个插件并排常驻。

## 3. 最小 UI 项目

插件可以不用 React。`package.json` 至少提供 `build` 脚本并依赖共享 SDK：

```json
{
  "name": "@agent-vitals/agent-metrics-ui",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build", "dev": "vite --host 127.0.0.1" },
  "dependencies": { "@agent-vitals/app-sdk": "file:../../../packages/agent-vitals-app-sdk" },
  "devDependencies": { "vite": "^6.1.0", "typescript": "^7.0.2" }
}
```

执行 `npm --prefix apps/agent-metrics/ui install` 生成并提交 lockfile；发行构建使用 `npm ci`，不能缺少它。版本可对齐仓库当前工具链。

`vite.config.js`：

```js
import { defineConfig } from "vite";
export default defineConfig({ base: "./", build: { outDir: "dist", emptyOutDir: true } });
```

`index.html`：

```html
<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>Metrics</title></head>
<body><main id="app"></main><script type="module" src="/src/main.ts"></script></body></html>
```

`src/main.ts`：

```ts
import { connect, observeHealth, publishToolbar } from "@agent-vitals/app-sdk/ui-host";

const app = document.querySelector<HTMLElement>("#app")!;
let count = 0;
const render = () => { app.textContent = `Metrics count: ${count}`; };
render();

const stopHealth = observeHealth();
const stopCommands = connect((command) => {
  if (command.commandId !== "metrics.increment") throw new Error("unsupported_command");
  count += 1;
  render();
});
publishToolbar([
  { id: "increment", commandId: "metrics.increment", label: "增加", kind: "button", enabled: true },
]);
window.addEventListener("pagehide", () => { stopCommands(); stopHealth(); }, { once: true });
```

重要细节：当前成功发布首个 `toolbar.update` 就是 ready 握手。即使没有按钮，也要调用 `publishToolbar([])`，否则原生会在 15 秒后判为启动超时。初始化完成并安装命令处理器后再发布工具栏。

SDK 自动选择 native IPC 或 iframe/postMessage，插件业务无需判断承载类型。Standalone 没有宿主接口，只能显式使用合成数据，不要尝试连接真实数据库。

## 4. 工具栏和生命周期

- 工具栏目前支持 `button` 和 `select`。命令必须属于登记的命名空间；select 的 `value` 必须在 `options` 中。宿主渲染控件，插件执行业务。
- `publishToolbar` 自动增加 revision；每次状态变化发布完整工具项快照。不要自行操作宿主 DOM。
- `connect` 当前处理器是**同步回调**，不会 await Promise：启动异步任务后返回只表示命令已接受，不表示任务完成。异步失败需显式处理，完成后发布新工具栏/页面状态；不要依赖 async throw 被自动转换为命令失败。
- `observeHealth` 每 500ms 发送心跳并报告脚本异常。原生独立 watchdog 检测启动 15 秒、心跳/命令 5 秒期限。浏览器计时器不能证明进程隔离，不注入同步死循环。
- 离开普通 Tab 时隐藏并暂停当前插件，返回时恢复同一实例及 UI 状态。SDK 发送 `__AV_PLUGIN_SUSPENDED__` / `__AV_PLUGIN_RESUMED__`：插件应暂停重绘、取消不允许后台继续的任务，并在恢复时继续工作。故障/显式重试/换另一插件仍销毁旧实例；当前单插槽最多保留一个插件，不是多插件常驻池。最终销毁仍须清理自身订阅、定时器与渲染资源。
- 宿主通过相同 transport 传入解析后的语言 `en` / `zh-Hans`。插件使用 SDK `pluginLocale()` 读取、`observeLocale(callback)` 订阅，自己维护翻译目录并更新工具栏/内容。语言切换不重建实例；插件不读取宿主 DOM 或宿主私有存储。用户输入和任务摘录保持原文。
- 数据失效通知是插件窗口上的 `__AV_PLUGIN_INVALIDATED__` 事件：订阅后重新请求投影，不读取原始 runtime payload。异步请求须防止旧结果覆盖新请求或卸载后的状态。

## 5. 可选：接入真实数据

插件注册表决定“加载谁”，投影处理器登记决定“读取什么”。只有静态 UI 时跳过本节。

1. 定义版本化 DTO、字段范围、窗口/数量限制和降级语义；共享类型放 SDK，查询放读侧 crate，不放插件 UI 或通用 PluginHost。
2. 在 `apps/desktop/src-tauri/src/plugin_projections.rs` 的处理器分发中登记 `metrics:v1`，参数校验后调用读侧查询。当前是很小的代码注册表，不是动态注册 API。
3. 在该插件描述符中加入 `"dataProjections": ["metrics:v1"]`。不要为了方便授予其他插件的投影。
4. 插件通过 SDK 请求（只有处理器实现后才能成功）：

```ts
import { invokeHost } from "@agent-vitals/app-sdk/ui-host";
import type { PluginResponseV1 } from "@agent-vitals/app-sdk";

let sequence = 0;
async function readMetrics() {
  const requestId = `metrics-data-${++sequence}`;
  const response = await invokeHost<PluginResponseV1<{ count: number }>>("plugin_request", {
    request: {
      version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId,
      method: "data.read", payload: { projection: "metrics", version: 1 },
    },
  });
  if (response.version !== 1 || response.requestId !== requestId) throw new Error("invalid_response");
  if (!response.ok || !response.result) throw new Error(response.error?.code ?? "data_unavailable");
  return response.result; // 生产消费方还应校验领域 DTO，而不是只依赖 TS 类型。
}
```

PluginHost 校验活动 Webview/实例、请求协议和声明权限，查询在阻塞任务中执行，响应前重新检查实例。插件可调用的原生 IPC 仅 `plugin_message`、`plugin_request`，不能直接调用宿主 `sessions_*` 等命令。

私有设置也必须有单独的版本化处理器和权限声明；例如 City 的 `city-settings:v1` 仅接受 seed，不接受任意路径或 JSON 文件。`data.read` 是当前请求分发名，不代表其所有投影一定只读，设置写入须在契约中明确。

需要完整会话详情时，使用 `plugin_request` 信封中的 `method:"ui.open-session",payload:{handle:<插件会话句柄>}`。它要求 `navigationTargets:["session"]`。宿主用活动插件 id 作作用域，解析 `harnesses.sessions` 签发的 `app:{pluginId}:{session_key}`，然后自己导航。插件只收到 `{opened:true}`，不返回原始标识或日志。另一个插件的句柄对不上这个作用域，解析结果是 `session_unavailable`。投影能不能读，只看 `dataProjections` 里有没有对应的键；分发不再写 `plugin_id == "city"`。

按照 `AGENTS.md` 第 6 条：官方内置插件可读取受控本地统计及明确声明的清理/截断摘录；数据库、日志、完整提示词及凭据没有因此开放。真实读取失败必须显示不可用，不能静默换成 fixture。MCP、导出和无上传规则不变。

浏览器预览不开放真实数据。需要模拟数据时，可在**开发/测试宿主环境**设置 `window.__AV_BROWSER_PROVIDERS__.metrics = async (request) => fixtureResult`；它接收完整请求、返回投影结果。默认没有 provider 时返回 `provider_unavailable`。不要把真实数据或这样的 fixture 注入脚本写进生产入口，也不要在插件中访问父窗口 provider 对象。

参考实际实现：[City 本地投影](CITY_LOCAL_DATA_PROJECTION.md)、`apps/agent-city/ui/src/data/provider.ts`、`crates/agent-vitals-query/src/query/app_local.rs`。旧独立应用分页契约与当前 City 同窗 MVP 契约不同，不可混用。

## 6. 构建与验收

从仓库根目录执行：

```sh
npm --prefix apps/agent-metrics/ui ci
npm --prefix apps/desktop/ui-dev run dev:browser
# 在输出的开发地址打开 #metrics；默认启动会构建所有已登记插件。

npm --prefix apps/desktop/ui-dev run build:browser
npm --prefix apps/desktop/ui-dev run verify:react
npm --prefix apps/desktop/ui-dev run verify:plugin-architecture
npm --prefix apps/desktop/ui-dev run verify:browser-plugin
```

新插件必须添加自己的第二消费者测试，不是运行现有 City 测试就自动得到覆盖。可参考 `fixtures/plugins/metrics/main.ts` 和 `scripts/verify-react-city-runtime.mjs`；现有 Metrics 是测试专用，不在生产注册表中。

原生测试通过 bundle，禁止裸运行 menubar 二进制：

```sh
cd apps/desktop/src-tauri
cargo test --lib plugin_ --release
cargo tauri build --bundles app
open target/release/bundle/macos/agent-vitals.app
```

最低验收：新 Tab 加载；工具栏命令与命名空间校验；离开/返回产生新实例；错误可局部重试且 Overview 可用；旧实例消息被拒绝；投影越权/缺库/空数据/截断有明确结果；插件不使用宿主源码、数据库、外部网络。

`verify:plugin-isolation` 当前是 **City 专用**原生故障注入探针，可用于共享宿主回归，但不能代替新插件的原生验收。原生实际故障测试需分别确认执行上下文/进程边界；iframe 通过不等于 Webview 的进程隔离已通过。

## 7. 常见问题

| 现象 | 检查 |
| --- | --- |
| 新 Tab 没出现 | 注册数组、id 冲突、开发服务器重启；原生 APP 是否重新编译并运行正确 bundle。 |
| 入口 404 / 加载失败 | source 的 dist/index.html、entry 目录、`base: "./"`、依赖 lockfile及打包产物。 |
| 启动超时 | 是否调用 `publishToolbar`，工具描述/命令前缀是否合法；不能只发送心跳而不握手。 |
| 按钮不出现或无法执行 | 命名空间、重复工具 id、select 值、实例是否已失败或存在待完成命令。 |
| 数据拒绝 | `dataProjections`、投影版本、data.read 的 Rust 处理器与参数；导航另查 navigationTargets 和领域解析器。 |
| 浏览器有界面但没数据 | 默认无 provider，需显式的合成 fixture provider；不应连接本机真实库。 |
| 更改代码后原生还是旧界面 | 静态资源与 Rust 注册表都进入 bundle；重新构建并确认正在运行的 APP 路径。 |
