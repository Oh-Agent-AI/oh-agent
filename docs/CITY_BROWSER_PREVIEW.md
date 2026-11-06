# City 浏览器测试入口

浏览器预览使用独立 iframe 加载 City 预编译产物，通过 `postMessage` 复用桌面版的工具栏/命令/投影 DTO。桌面版继续使用原生 WebView；浏览器模式不是原生进程隔离的证明。全部数据为合成 fixture，不读取日志或 authority DB。

## 启动

在 `codex/app-layer-city` worktree 的 `apps/desktop/ui-dev` 目录执行：

```sh
npm ci
npm --prefix ../../agent-city/ui ci
npm run dev:browser
```

访问 `http://127.0.0.1:5174`，点击 City。启动命令会先独立构建 City，然后启动宿主 Vite；修改 City 源码后执行 `npm --prefix ../../agent-city/ui run build` 并重试 City/刷新页面。宿主 React 修改由 Vite 热更新。

端口占用时不终止已有服务，改用 `npm run dev:react -- --port 5178`。City 与 Overview 位于同一页面；顶部五项控件由 City 声明、宿主渲染。离开 tab 销毁 iframe，再次进入创建新实例并恢复默认状态。

## 自动回归

```sh
npm run verify:city-runtime
```

命令只构建前端，不构建 Rust；重新打包独立 City 资源后，加载固定产物快照并使用与开发页面相同的 `browser-plugin-host.js`。缺少 Chromium 时先执行 `npx playwright install chromium`。

覆盖 CSS/真实 WebGL 绘制、五项工具栏命令、视图缩放、消息来源校验、四种窗口、数据状态/请求竞态、渲染/effect 故障、局部重试、tab 清理、WebGL 不可用及资源加载失败。故障数据通过测试专用投影函数注入；普通开发页使用固定合成 fixture。

2026-10-03 完整回归通过，包含上述全部检查及投影失效刷新。已修复缩放时 ResizeObserver 同帧修改尺寸引发的循环通知：宿主视图布局和 City canvas 更新合并到下一动画帧执行，销毁时取消待执行回调；没有屏蔽运行异常。City typecheck、宿主 React 合约守卫及 City 素材/布局/数据/航拍守卫通过。

`npm run verify:browser-plugin` 可单独快速验证浏览器适配器：工具栏 DTO、消息 origin/source、无效布局、过期 revision/request/实例、失败状态保持、启动/命令超时及原生 IPC 不被替换。该检查也包含在完整回归命令中。接入后的原生 `.app` 隔离探针已再次通过，桌面路径未回退为 iframe。

## 通信与边界

- City 不读取父页面 DOM/store，不复用 React 或回调。浏览器 transport 使用异步 request/response 和有界超时。
- 宿主验证 origin、实际 iframe Window、版本与 instanceId；旧 revision/request 不能回写当前状态，失败保持直到新实例重试。
- 浏览器只模拟投影接口与控制消息，不连接 Rust，也不具备桌面进程隔离保证。心跳仅记录；不使用浏览器心跳期限判断 renderer 卡死，软件 WebGL 可能延迟整个页面。禁止在此注入持续死循环。
- 浏览器启动观察期限为 15 秒、命令结果观察期限为 30 秒、投影/RPC 期限为 10 秒；这些是预览用期限，不替代原生 Rust 的 5 秒心跳/命令期限。
- 原生 renderer 终止、死循环隔离和 Rust watchdog 期限由 `.app` 原生探针验收。浏览器资源故障及命令超时仍显示局部提示/重试。
- native 构建不注入浏览器脚本，City 在 Tauri 中优先走原生 IPC。生产包构建仍使用 `prepare-desktop-bundle.mjs`，不能用浏览器预览宣称真实数据授权已完成。
