# 插件嵌入架构：统一 iframe + 按需升级 WebView SPEC（2026-10-07）

状态：已确认方向，待实施。决策来源：窗口 resize 时原生 WebView 位置/尺寸与主进程对齐存在可感知延迟（2–5 帧），用户体验不可接受。

## 1. 问题诊断

当前架构用 Tauri `WebviewBuilder` 创建原生 WKWebView 子视图。每次布局变化（窗口 resize、侧栏切换、面板折叠）都要走完整同步链：

```
React 渲染 → DOM 布局 → getBoundingClientRect()
  → IPC invoke("plugin_open", boundsOnly) → Rust → WKWebView.set_bounds()
  → WebKit 重新布局/合成
```

跨进程边界（JS→Rust→Native→WebKit）决定了延迟下限。`usePlugin.tsx` 的 `useLayoutEffect` 优化和 `syncLayout` 去抖已将 IPC 次数压到最低，但**每帧至少一跳 IPC + 主线程调度**不可消除。结果：resize 时插件内容比宿主 UI 晚 2–5 帧到达新位置，肉眼可见"追着跑"。

## 2. 决策

**普通模式统一 iframe，按需升级 WebView。** 参考 VSCode 的做法（[Webview API](https://code.visualstudio.com/api/extension-guides/webview)）：所有插件面板用 iframe 渲染，CSS 布局引擎直接排位（零 IPC、零跨进程同步），通过专用 origin + CSP + postMessage 解决安全隔离。不静态分离"普通=iframe / 全屏=WebView"，而是默认 iframe、在明确需要时升级。

| 模式 | 载体 | 通信 | 理由 |
|---|---|---|---|
| 普通（tab 内嵌） | iframe | postMessage（复用 browser-plugin-host.js 信封） | CSS 布局零延迟；一套代码路径（浏览器预览已验证） |
| 全屏/独占 | WebView（保留现有 `plugin_open`） | Tauri IPC | 进程隔离 + 独占 GPU；全屏 bounds 固定，无同步问题 |
| 自动升级（可选后续） | iframe → WebView | 按需 | WebGL context lost 或持续低帧率时 |

## 3. 架构

### 3.1 iframe 路径（普通模式）

```text
宿主（workbench WebView）
  └─ <div className="native-plugin-slot">
       └─ <iframe src="plugins/AgentCity.plugin/ui/index.html?instanceId=..."
                  sandbox="allow-scripts allow-same-origin"
                  style={{ width: "100%", height: "100%", border: "none" }} />
```

- **定位**：iframe 由 CSS 排——`100%×100%` 填满 slot 容器。宿主 DOM 布局变化在同一帧内完成，**零延迟**。
- **通信**：postMessage 双向信封（`av-plugin-rpc` 协议），复用已有的 `browser-plugin-host.js` 消息路由（toolbar.update / command / heartbeat / runtime.error / data.read）。
- **数据**：宿主在 `window.__AV_BROWSER_PROVIDERS__` 注册 provider——与浏览器预览共用同一套 fixture/real-data 路由。
- **生命周期**：iframe 加载/卸载由 React 挂载/卸载控制；tab 切换用 CSS `display:none`（保留实例、暂停 rAF）。

### 3.2 WebView 路径（全屏模式，保留现有）

用户显式请求全屏时：
1. 销毁 iframe（React 卸载）
2. 调用 `plugin_open` 创建原生 WebView（bounds = 全窗口）
3. 状态迁移：postMessage → Tauri IPC（SDK 的 `ui-host.ts` 自动检测通道）
4. 退出全屏：销毁 WebView → 重新挂载 iframe

全屏 bounds 固定（`0,0,window.width,window.height`），**不存在 resize 同步问题**。

### 3.3 SDK 双通道

现有 `@agent-vitals/app-sdk/ui-host.ts` 已支持：
- Tauri IPC（`window.__TAURI__.core.invoke`）
- postMessage（`window.parent.postMessage`）

无需修改——插件代码自动检测所在环境。

## 4. 改动范围

| 文件 | 改动 |
|---|---|
| `usePlugin.tsx` | 渲染 `<iframe>` 替代 `plugin_open` 调用；删除 `syncLayout` / `ResizeObserver` / bounds IPC |
| `usePlugin.tsx` | 通信适配：在宿主 window 注册 `__AV_BROWSER_PROVIDERS__`（复用 browser-plugin-host 的消息路由） |
| `App.tsx` | iframe slot 容器样式（`100%` 填满，无 border/padding） |
| `plugin_host.rs` | 新增 `plugin_fullscreen` 命令（全屏模式创建 WebView）；`plugin_open` 保留但仅在显式请求 WebView 时调用 |
| `browser-plugin-host.js` | 从 `public/` 提升为宿主生产路径（不限于浏览器预览） |

**不改的**：
- SDK（已双通道）
- 插件代码（AgentCity 不感知载体变化）
- Rust 投影/查询（数据路径不变）

## 5. 隔离与安全

| 风险 | 缓解 |
|---|---|
| 插件崩溃影响宿主 | iframe `sandbox` 属性 + 独立 origin（Tauri 自定义协议 `tauri://plugins/...`） |
| 数据泄露 | postMessage 信封校验（origin + instanceId + version）；CSP 限制插件内网络请求 |
| DOM 操作越界 | `sandbox="allow-scripts allow-same-origin"` 禁止 top-level navigation、form submission |
| GPU 竞争 | Overview/Workbench 无 WebGL——实际竞争极小；City WebGL 独立上下文在 iframe sandbox 内 |

## 6. 性能预算

| 指标 | iframe（新） | WebView（旧） |
|---|---|---|
| 布局同步延迟 | 0 帧（同帧 CSS） | 2–5 帧（IPC 链） |
| tab 切换 | <1 帧（CSS display） | ~200ms（原生 view visibility + WebKit rAF 恢复） |
| 通信延迟 | ~0.1ms（同进程 postMessage） | ~1-3ms（跨进程 IPC） |
| 内存 | 共享渲染进程（~50MB 节省 vs 独立进程） | 独立 WKWebView 进程 |
| WebGL | 共享 GPU 上下文（可能竞争） | 独立 GPU 上下文 |

## 7. 验收

- [ ] 窗口 resize：插件内容与宿主 UI **同帧**到达新位置（录屏逐帧确认）
- [ ] tab 切换：City 插件暂停/恢复，无白屏闪烁
- [ ] 全屏模式：进入/退出流畅（<500ms），状态迁移无数据丢失
- [ ] verify:city 7 门 + verify:city-runtime（migration/frame/film/locale）全绿
- [ ] 浏览器预览与原生行为一致（同一套 iframe 路径）
- [ ] 通信：toolbar 命令、数据投影、心跳全通

## 8. 分期

| 阶段 | 交付 | 量级 |
|---|---|---|
| P1 | 普通模式切 iframe（usePlugin.tsx + 通信路由） | 1 天 |
| P2 | 全屏 WebView 保留（plugin_fullscreen 命令 + 状态迁移） | 0.5 天 |
| P3 | 性能监控自动升级（可选后续） | 0.5 天 |
