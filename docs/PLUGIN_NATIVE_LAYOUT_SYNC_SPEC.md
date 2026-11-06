# 插件原生 WebView 布局同步优化 SPEC（2026-10-07）

状态：草案，待评审。取代对 `PLUGIN_IFRAME_ARCHITECTURE_SPEC.md` 的"统一 iframe"方案（该方案的评审结论见 §9）。

## 1. 目标与非目标

**目标**：窗口 resize、侧栏折叠等布局变化时，原生子 WebView 与宿主 UI 的错位（spec 称 2–5 帧，**待 P0 实测确认**）降到肉眼不可感知，且**不削弱**现有隔离。

**非目标**：
- 不改变载体（保持原生子 WebView，`add_child`）。
- 不改 SDK、插件代码、投影/查询路径。
- 不引入 iframe 路径（见 §9）。

## 2. 为什么保持原生 WebView

现有方案的优势都在隔离与韧性，布局同步只是其中一处可优化的缺点：

| 能力 | 现有实现 | iframe 能否保持 |
|---|---|---|
| 挂死隔离 | 独立 WebContent 进程 + Rust 侧 `start_watchdog`（500ms） | 否：共用主线程，插件卡死会冻住宿主及其重试入口 |
| 存储隔离 | `.incognito(true)` | 否：同源共享 localStorage/IndexedDB |
| 发送方鉴权 | `webview.label()` 校验（`host_only`、`plugin_request`） | 否：所有调用都来自 `workbench` |
| 导出管控 | `on_download` + `allow_local_exports` | 需重做 |
| GPU/渲染独立 | 独立上下文，`background_throttling(Disabled)` | 否 |

## 3. 现状与成因（代码事实）

窗口或宿主布局变化的路径：

```
React 渲染 → useLayoutEffect/ResizeObserver → getBoundingClientRect()
  → invoke("plugin_open", {boundsOnly:true})          # usePlugin.tsx syncLayout
  → plugin_host.rs::plugin_open（async 命令）
       host_only → state.1 锁 → start_watchdog
       → asset_resolver().iter().any(entry)            # 每帧遍历内嵌资源
       → bounds 校验 → current_id 校验
       → view.set_bounds()（再转主线程）
```

可优化点：

1. `bounds_only` 与创建/恢复共用 `plugin_open`，每帧重复做资源遍历、watchdog 启动检查、operation 锁。
2. bounds 来源是前端 DOM 测量，必然晚于原生窗口 resize 事件。
3. `syncLayout` 用 `await invoke` 链串行，延迟叠加。
4. `plugin_open` 同时承担创建/重启/恢复/改 locale/改 bounds 五种语义（已需 `#[allow(clippy::too_many_arguments)]`）。
5. locale 变化走完整 `plugin_open`，触发 `show()`、`ensure_native_attachment`、`resumed` 事件。
6. 400ms `plugin_snapshot` 轮询，与事件推送（`__AV_PLUGIN_STATUS__`）并存。
7. `view.eval` / `initialization_script` 用 `format!` 拼 JS。
8. 没有布局延迟指标，"2–5 帧"无数据来源。

## 4. 设计

### 4.1 P0：量化（先于一切优化）

在 bounds 路径加三个时间戳，写入实例 `events`（沿用 100 条上限），经 `plugin_snapshot` 暴露：

| 打点 | 位置 |
|---|---|
| `t_js` | 前端 `syncLayout` 调 invoke 前（`performance.now()` + `performance.timeOrigin`） |
| `t_rx` | Rust 命令入口 |
| `t_set` | `set_bounds` 返回后 |

事件码：`layout_sync`，字段 `{jsToRxMs, rxToSetMs, seq}`。另提供一个手动脚本：以固定步长程序化 resize 窗口 N 次，输出 p50/p95，并配合录屏逐帧确认视觉错位。

**门槛**：P0 的数据决定后续是否做 P2/P3。若 p95 已 < 1 帧（16.7ms）则止步于 P1 清理。

### 4.2 P1：拆出轻量 `plugin_set_bounds`（低风险）

新增命令，仅做：实例 ID 匹配 → 非 suspended/failed → bounds 校验 → `set_bounds`。

- 不取 `state.1` operation 锁（该锁保护创建/销毁，`set_bounds` 只需短持 `state.0` 读状态）。
- 不遍历资源、不 `start_watchdog`、不 `show()`、不 `ensure_native_attachment`、不 `eval`。
- 同步命令（非 `async`），减少调度跳数。
- 校验规则与 `plugin_open` 一致（有限数、`x,y >= 0`、`width,height >= 1`），抽成共用函数，避免两份。
- `plugin_open` 删除 `bounds_only` 分支；前端 `syncLayout` 改调新命令。

同时拆分其余语义（均为纯重构，行为不变）：

| 新命令 | 职责 |
|---|---|
| `plugin_create` | 创建/重启（含资源检查、watchdog、WebviewBuilder） |
| `plugin_resume` | 恢复 suspended 实例（`show`、attachment 检查、`resumed` 事件、locale） |
| `plugin_set_bounds` | 只改几何 |
| `plugin_set_locale` | 只 `eval` locale 事件，不 show/resume |

`plugin_open` 保留一个版本周期作为兼容入口（内部转发），随后删除。

### 4.3 P1：前端同步策略

- `syncLayout` 改为"最新值覆盖 + rAF 对齐"：新 bounds 到达时覆盖待发值，同一帧内只发一次；不再用 `await` 链叠加延迟。
- 保留"in-flight 时合并为最后一次"的语义（避免旧值覆盖新值），用 `seq` 单调递增，Rust 侧丢弃 `seq` 倒退的请求。
- `useLayoutEffect` 触发保持不变（宿主内部布局变化仍需前端上报）。

### 4.4 P2：窗口 resize 由 Rust 直接驱动（视 P0 数据决定）

窗口拖拽 resize 时，不经前端：

1. 前端在布局稳定后上报 **slot 相对窗口四边的 inset**（`left/top/right/bottom`），而非绝对 bounds；Rust 缓存于 `Instance`。
2. Rust 监听 `WindowEvent::Resized`（`workbench` 窗口），用缓存 inset + 新窗口 inner size 直接计算并 `set_bounds`。
3. 宿主内部布局变化（侧栏折叠、面板展开）仍走 `plugin_set_bounds`，并更新 inset。

备选：对子 view 设置 `autoresizingMask`（宽高随父视图）。需原型验证 wry 子 view 附着在 `contentView` 上时的行为（`ensure_native_attachment` 已有 contentView 被替换后的修复逻辑，注意与之协同）。**P2 开工前做 1 天原型，二选一。**

约束：inset 与 DOM 不一致的窗口（如标题栏 Overlay 的顶部偏移）必须以前端上报的实际 inset 为准，不得在 Rust 里硬编码。

### 4.5 P3：清理与加固（可独立提交）

1. **轮询降级**：`plugin_snapshot` 400ms 轮询改为事件驱动（`notify_host` 已存在），保留 5s 兜底。
2. **locale 路径**：`useEffect([locale])` 改调 `plugin_set_locale`。
3. **JS 拼接加固**：`initialization_script` / `eval` 中的动态值一律 `serde_json::to_string` 后嵌入，不依赖"locale 只可能是两个字面量"的隐含前提。
4. **`ensure_native_attachment` 瘦身**：`setUnderPageBackgroundColor` 只在创建时设一次；resume 时仅在 `hiddenAncestor`/`attached != window` 异常时再做修复，其余只记录。
5. **`unstable` 风险登记**：`tauri` 的 `unstable` feature（子 WebView 依赖）写入 `docs/ENGINEERING.md` 的升级清单，升级 Tauri 前必须跑 §6 的隔离与布局探针。

## 5. 改动范围

| 文件 | 改动 |
|---|---|
| `apps/desktop/src-tauri/src/plugin_host.rs` | 拆分命令；`plugin_set_bounds` 轻量路径；`seq` 校验；`layout_sync` 事件；P2 的 Resized 监听 |
| `apps/desktop/src-tauri/src/lib.rs`/`main.rs` | 注册新命令（以实际注册位置为准） |
| `apps/desktop/ui-dev/react/src/app/plugins/usePlugin.tsx` | `syncLayout` 改 rAF + 覆盖；locale/snapshot 路径调整；P2 上报 inset |
| `apps/desktop/ui-dev/public/browser-plugin-host.js` | 同步支持新命令名（浏览器预览 shim，行为不变） |
| `scripts/verify-browser-plugin-host.mjs` | 随命令拆分更新 |

**不改**：SDK（`packages/agent-vitals-app-sdk`）、`capabilities/default.json` 的权限范围（新命令沿用同一 `host_only` 约束，不放宽）、插件注册表 `plugins.json`、Rust 投影/查询。

## 6. 安全与韧性不退化（硬约束）

所有新命令必须：
- 以 `host_only(&webview)` 起手，仅 `workbench` 可调；
- 校验 `instance_id` 与当前实例一致、实例未 failed、（`set_bounds`/`resume` 之外）未 suspended；
- 不新增任何对插件 WebView 可见的 IPC 面。

验收需包含（沿用并扩展现有测试与 `plugin_isolation_probe`）：
- 插件主线程死循环：宿主 UI 仍可交互，watchdog 在预期时限内置 failed，重试可用。
- 插件 WebView 内无法调用 `plugin_set_bounds` / `plugin_create` 等新命令（label 校验拒绝）。
- 旧实例/过期 `seq`/`failed`/`suspended` 的 bounds 请求被拒绝且无副作用。

## 7. 验收

- [ ] P0：给出 resize 前后 `jsToRxMs`/`rxToSetMs` 的 p50/p95 数据，并附录屏逐帧结论
- [ ] P1：同一 resize 脚本下 `plugin_set_bounds` 的 p95 较 `plugin_open(boundsOnly)` 有可测下降
- [ ] P1：命令拆分后 `cargo test` 与现有插件宿主测试全绿；`clippy -D warnings` 无 `too_many_arguments` 豁免新增
- [ ] P2（若实施）：窗口拖拽时插件内容与宿主同帧到位（录屏确认）；侧栏折叠仍正确
- [ ] §6 全部韧性与安全用例通过
- [ ] verify:city 与 verify:city-runtime 全绿；浏览器预览行为不变（`verify-browser-plugin-host`）
- [ ] tab 切换保持现有 suspend/resume 语义，无白屏

## 8. 分期

| 阶段 | 交付 | 说明 |
|---|---|---|
| P0 | 打点 + resize 脚本 + 基线数据 | 决定后续范围，半天 |
| P1 | `plugin_set_bounds` + 命令拆分 + 前端 rAF 覆盖 | 1–1.5 天，纯重构 + 一个新轻量命令 |
| P2 | Rust 侧 Resized 驱动 | 原型 1 天 + 实施 1 天，**仅当 P1 后数据仍不达标** |
| P3 | 轮询降级、locale、JS 拼接、attachment 瘦身、unstable 登记 | 可并行，各自独立提交 |

## 9. 与 `PLUGIN_IFRAME_ARCHITECTURE_SPEC.md` 的关系

该 spec 的评审意见（不建议按现稿实施）要点：
- 同源 iframe + `allow-same-origin` 不构成隔离；iframe 与宿主共用主线程，丢失挂死隔离与发送方鉴权。
- 延迟诊断无测量数据，且未比较在原生侧解决布局同步的方案。
- 与代码不符：`browser-plugin-host.js` 声明仅用于浏览器预览且用 `position:fixed` + bounds 定位；`__AV_BROWSER_PROVIDERS__` 不存在；SDK 的通道判定在 iframe 内可能误走 IPC。

若 P0–P2 之后仍有必要提供 iframe 载体（例如轻量、无 WebGL 的插件），应作为**按插件声明的可选载体**（`plugins.json` 增加 `isolation` 字段），使用不带 `allow-same-origin` 的沙箱与独立 origin，并另立 spec，不在本 spec 范围。

## 10. 开放问题

1. Tauri 的 `WindowEvent::Resized` 与 AppKit 实际 live-resize 的时序：回调是否在拖拽过程中持续触发，还是仅在结束时？（P2 原型第一项验证。）
2. `autoresizingMask` 在 wry 子 view 上是否被其内部 layout 覆盖？
3. `set_bounds` 在非主线程调用时 Tauri 内部是否阻塞等待主线程？（决定 P1 同步命令的实际收益。）
4. 多实例（当前为单槽）扩展时，inset 缓存与 resize 监听如何按实例分发。
