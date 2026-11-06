# Workbench React 迁移规格：本地响应式工作台，而非联网前后端

**状态：** Draft v1（2026-09-20）
**目标版本：** v1.0.0-beta 后续迭代
**范围：** `apps/desktop/src-tauri` 的 Workbench 前端、其本地 Tauri IPC 适配层及验证链
**关联文档：** [Tauri Runtime Workbench 规格](../TAURI_RUNTIME_WORKBENCH_SPEC.md)、[发现 tab 规格](WORKBENCH_FINDINGS_TAB_SPEC.md)、[本地 Agent 数据访问与出境审计规格](FINDINGS_TRUST_EGRESS_MONITORING_SPEC.md)、[行为签名规格](TRUST_BEHAVIOR_SIGNATURES_SPEC.md)、[Windows Trust Runtime 规格](WINDOWS_TRUST_RUNTIME_SPEC.md)。

---

## 0. 一句话结论

将当前静态 `workbench.html` / `workbench.js` / `workbench.css` 渐进迁移为 **React + TypeScript + Tailwind CSS** 工作台；Rust/Tauri 继续是唯一的本地数据、权限、脱敏和运行时边界。

这里的「前后端分离」是**同一桌面应用进程内的本地 IPC 分层**，不是新增 HTTP 服务、Node 后端或云端 API：

```text
React renderer（仅呈现、交互、查询状态）
                 │ Tauri invoke / event
                 ▼
typed local desktop API（DTO、错误、可见性边界）
                 ▼
Rust runtime / data / harness adapters / SQLite
```

产品仍然离线优先。除既有公开价目和版本检查外，迁移不得新增任何将用户数据、路径、会话、证据或诊断内容发送出设备的网络路径。

---

## 1. 背景与问题

当前 Workbench 已从只读用量页扩展到总览、会话、发现、测试、Skill、设置、执行环境覆盖、Trust 审计、证据链和实时监控。代码层的实际信号是：

| 现状 | 已产生的问题 |
|---|---|
| `workbench.js` 约 9,800 行 | command 调用、DOM 操作、状态、格式化和业务分支相互耦合；局部改动容易影响其他 tab。 |
| `workbench.html` 约 1,150 行 | 页面结构与条件显示散落，难以组件化复用和做渐进披露。 |
| `workbench.css` 约 2,000 行 | 同类状态、按钮和卡片容易形成视觉漂移；窄窗口容易留下无意义留白。 |
| `invoke`、`listen`、定时器和事件绑定分散 | 刷新竞争、监听重复注册、tab 切换后的过期视图不易治理。 |
| Findings / Trust 是证据密集型页面 | 「未生成 Finding」会被压成一行状态文字，用户无法看见证据、置信度和下一步。 |

现有 `apps/desktop/ui-dev` 已有 Vite 开发与 mock 验收基础，但其 Vite root 仍指向旧的 `src-tauri/ui` 静态页面。这是可复用的迁移底座，而不是已经完成的前端应用。

---

## 2. 产品目标、非目标与原则

### 2.1 目标

1. **可维护性：** 页面由 feature、组件和本地 API 模块构成；业务状态不再通过跨文件 DOM 查询隐式共享。
2. **可感知性：** 用户能在 Findings / Trust 看到结论、证据、置信度、时间、范围和可执行的下一步，而不是一条汇总字符串。
3. **响应式更新：** 操作结果、扫描完成、实时监控事件能够局部更新；不要求整页 reload，也不依赖高频全量轮询。
4. **可信边界不退化：** 前端只能取得为该服务面投影后的 DTO；原始路径、文件内容、参数、凭据和 canary 永不进入 React state、浏览器 mock、MCP 或常规导出。
5. **渐进发布：** 任一阶段都能打出可用 macOS `.app`；旧 Workbench 在切换完成前是可运行回退面。
6. **桌面可用性：** 在典型桌面宽度充分利用空间，在窄窗口不遮挡、不失焦、不依赖 hover 才可操作。

### 2.2 非目标

- 不引入远端 BFF、云同步、遥测、崩溃上传或 localhost HTTP server。
- 不在本规格中重写 `agent-vitals-runtime` 的信任判据、计费语义或数据库 schema；前端只消费明确的投影 DTO。
- 不把所有既有 tab 一次性重写，也不把旧 DOM 页面嵌套进 React iframe。
- 不引入未经审计的通用 dashboard 模板或组件库来替代产品信息架构。
- 不承诺移动端成为一等产品；小窗口要诚实退化，但首要场景是桌面 Tauri 窗口。

### 2.3 不可违反的设计纪律

1. **本地优先：** 前端包内置于 app；字体、图标、样式不得运行时从 CDN 拉取。图标用随包 SVG，字体使用系统栈或随包字体。
2. **数据不编造：** `unknown`、`unavailable`、`not scanned`、`no risk finding` 和 `evidence insufficient` 必须是不同状态。
3. **渐进披露：** 首屏优先显示结论、影响和动作；证据链、原始安全引用和明细只按需展开。
4. **可访问性：** 所有可操作项使用原生语义控件或完整 ARIA 语义；键盘顺序与视觉顺序一致；焦点始终可见且不被粘性头部/浮层遮挡。
5. **减少运动：** `prefers-reduced-motion` 下禁用非必要动画；状态变化用文案和视觉标记表达，不能只靠动画或颜色。
6. **稳定边界：** React 组件不能直接访问 `window.__TAURI__`、shell、文件系统或 SQLite；唯一入口是受测试的 `lib/tauri` / feature API。

---

## 3. 目标信息架构与体验

### 3.1 应用壳

顶层采用固定、可收缩的导航与页面级 Header，而不是每个页面自行堆叠工具栏：

```text
AppShell
├── AppNavigation：总览 / 用量 / 会话 / 发现 / 测试 / Skill / 设置
├── PageHeader：标题、数据新鲜度、主操作、全局连接/监控状态
├── PageContent：当前 feature
└── ToastRegion：本地操作回执与错误
```

路由使用 hash 路由或同等的本地 URL 状态，例如 `#/findings`、`#/findings/evidence/<safe-ref>`。这让刷新、返回、深链和测试可复现；路由参数只能是不透明安全引用，不能是原始路径或原生会话 id。

### 3.2 Findings / Trust 目标工作台

Findings 与 Trust 采用一致的「结论 → 证据 → 行动」模型：

```text
页面 Header：安全状态 · 上次扫描 · 实时监控状态 · 主操作
┌ 结论摘要 ─────────────────────────────────────────────┐
│ 可判定风险 / 证据不足 / 未扫描 / 受监控执行环境覆盖         │
└──────────────────────────────────────────────────────┘
分段导航：风险 Finding | 证据链 | 执行环境覆盖 | 实时监控
┌ Finding / Evidence 列表 ─┬─ 详情面板 ─────────────────┐
│ 等级、置信度、时间、执行环境   │ 判定说明、时间线、安全引用 │
│ 筛选、排序、空状态         │ 作用范围、下一步、告警状态 │
└──────────────────────────┴──────────────────────────┘
```

具体规则：

- 「未生成 Finding」必须同时显示：已扫描执行环境、可用证据数量、缺失的判定条件，以及“启动实时监控/再次本地审计”等下一步；它不能伪装成“安全”。
- 一个 Evidence row 至少有执行环境、观测时间、证据等级、来源、范围、大小/计数（如可用）及安全引用；详情面板再显示其与 Finding 的因果关系。
- 时间线默认按最近证据排序，长列表虚拟化或分页，避免一次性渲染完整历史。
- 风险、置信度和来源不能只靠颜色；须有可读标签和 tooltip/说明。
- 空态是一等状态：分别覆盖无执行环境、无证据、尚未扫描、权限不足、来源不可用、扫描失败和确实无风险命中。

### 3.3 数据密集页面

- 桌面宽度下表格可横向展开；窄窗口时保留横向滚动并提供固定首列，或切换为摘要卡 + 详情抽屉，不能压缩成不可读的单行。
- 首屏只请求权威库上的轻量聚合；会话日志扫描、轨迹读取和大证据明细必须由用户显式展开触发。
- 全部刷新控件有 `loading`、成功时间和失败原因；保留旧数据刷新时展示“刷新中”，不清空页面造成跳动。

### 3.4 视觉系统

采用紧凑、可读、偏工具型的桌面风格，而不是营销式 dashboard：

- CSS token 定义语义色：surface、text、muted、border、accent、success、warning、danger、focus；组件中不得散落原始 hex。
- 保留明/暗主题，文字对比度不低于 4.5:1；风险色只做辅助，不承载唯一含义。
- 以系统无衬线字体为正文，等宽字体仅用于哈希、安全引用、数值和代码样式字段；不使用远端 Google Fonts。
- 使用随包 SVG 图标，图标按钮必须有可访问名称。
- 运动仅用于 150–200ms 的状态确认或面板切换；不使用页面进入动画拖慢审计操作。

---

## 4. 技术架构

### 4.1 前端栈

| 层 | 选型 | 责任 |
|---|---|---|
| 构建 | Vite | 本地开发、HMR、生产静态 bundle。复用既有 `apps/desktop/ui-dev`。 |
| UI | React + TypeScript | 声明式渲染、组件边界、错误边界。 |
| 样式 | Tailwind CSS + CSS tokens | 布局/间距/响应式工具类；token 与语义组件维持可读性。 |
| 本地数据查询 | 查询缓存层（例如 TanStack Query 或等价薄封装） | 请求状态、缓存、失效、串行化、可见性驱动刷新。 |
| 本地界面状态 | React Context + reducer；仅在确有跨 feature 状态复杂度时引入轻量 store | 路由、筛选、面板展开、toast；不保存数据真相。 |
| DTO 守卫 | TypeScript 类型 + runtime schema 校验 | 在 IPC 边界拒绝畸形/过期结果，降级为可理解错误。 |

组件库不作为第一阶段依赖。先建立少量受控 primitives；若后续引入组件库，必须满足离线打包、键盘可用、主题 token 兼容、许可审查和包体积预算。

### 4.2 目录契约

```text
apps/desktop/ui-dev/
├── src/
│   ├── app/                    # AppShell、route、providers、error boundary
│   ├── components/ui/          # Button、Badge、Card、Table、Dialog、EmptyState
│   ├── features/
│   │   ├── overview/
│   │   ├── findings/
│   │   ├── trust/
│   │   │   ├── api.ts          # 仅调用受限 local bridge
│   │   │   ├── queries.ts
│   │   │   ├── TrustDashboard.tsx
│   │   │   ├── EvidenceTimeline.tsx
│   │   │   └── EvidenceDetailPanel.tsx
│   │   ├── sessions/
│   │   ├── usage/
│   │   └── settings/
│   ├── lib/
│   │   ├── tauri.ts            # invoke/listen 唯一封装点
│   │   ├── dto.ts              # DTO schema 与安全投影类型
│   │   ├── format.ts
│   │   └── time.ts
│   ├── styles/tokens.css
│   └── main.tsx
├── public/                     # 仅浏览器 mock 和不敏感静态资源
├── vite.config.ts
└── package.json
```

禁止：feature 互相 import 对方内部组件；任何生产数据落入 `public/`；组件内直接调用未封装的 `invoke`/`listen`。

### 4.3 本地 API / DTO 边界

Rust command 是本地 API，而不是 UI 的实现细节。每个 feature 命令必须有：

1. 稳定命令名和显式输入类型；
2. versioned、文档化的输出 DTO；
3. `available` / `unavailable` / `partial` / `error` 的可区分结果；
4. 隐私投影审查；
5. 容忍老 CLI / 新 app 组合的 schema 不匹配提示与恢复 CTA。

建议以 feature namespace 提供前端适配器，而不是让每个组件理解 CLI 输出：

```text
trust.audit()          -> TrustAuditReportDto
trust.findings(filter) -> FindingListDto
trust.subscribe()      -> cleanup function
overview.snapshot()    -> OverviewSnapshotDto
```

前端拿到的 Trust evidence DTO 只能含脱敏后的安全引用、类别、等级、来源、观测时间、范围和聚合大小/计数。不得含原始工作区路径、文件名列表、文件内容、JWT、上传凭证、原始网络请求或可逆 native id。

### 4.4 响应式更新模型

```text
用户 mutation ───────────────┐
Tauri runtime event ─────────┼─> feature query invalidation -> 局部重新查询 -> UI
可见 tab 的低频 fallback ────┘
```

- `listen` 只在 App provider 或 feature 生命周期内注册一次，并在 unmount 时清理。
- runtime event 是“数据可能改变”的 invalidation 信号，不允许把未经 DTO 投影的原始 payload 直接塞进组件状态。
- fallback 轮询只在 tab 可见、窗口聚焦且实时事件不可用时开启；切换 tab、窗口隐藏或 unmount 后必须停止。
- mutation 成功后优先失效相关 query；只有操作可安全预测时才采用 optimistic update。
- 每个 query 显式呈现 `initial loading`、`refreshing with stale data`、`empty`、`partial`、`unavailable` 和 `error`。

### 4.5 错误与恢复

- App 根、每个 feature 页和高风险详情面板设 Error Boundary，局部渲染错误不得使整个工作台白屏。
- IPC 错误映射为用户可理解、可行动的状态，例如“随包 CLI 版本过旧 → 重建投影库 / 升级 app”，而不是裸 command stderr。
- 错误详情默认隐藏；若提供复制诊断，只能是已脱敏文本。
- 任何重建/迁移操作必须先说明影响范围，并只删除/重建 app-owned projection，不能触碰执行环境原始日志。

---

## 5. 迁移策略与阶段

### Phase 0：契约盘点与护栏（不切生产 UI）

**产出**

- 列出当前 Workbench command、事件、定时器、DOM 入口及其调用方。
- 为每个 tab 写 DTO contract fixture；对 Trust/Findings 标明禁止进入前端的字段。
- 为现有静态 UI 固定关键路径 smoke tests 和截图基线。
- 确认生产 `frontendDist`、开发 `devUrl`、Windows 窗口入口与 macOS bundle 链路。

**退出条件**

- 迁移清单能说明每一个现有入口的目标归属或明确废弃理由。
- 旧 UI 的本地 mock 与 `.app` 冒烟路径均可运行。

### Phase 1：React 壳与本地 bridge（旧页面仍为生产默认）

**产出**

- 独立 React/Vite entry、TypeScript、Tailwind、token、AppShell、hash route、Toast、Error Boundary。
- `lib/tauri.ts` 作为唯一桥接点，支持 production Tauri 与浏览器 mock。
- `ui-dev` 从“Vite 代理旧 HTML”调整为可同时服务旧页面和 React 开发入口；不可覆盖旧 `src-tauri/ui`。
- 生产构建输出到新的隔离目录，例如 `ui-react-dist`；此阶段不改 `tauri.conf.json` 的 `frontendDist`。

**退出条件**

- 浏览器 mock 和 Tauri dev 均能打开 React Shell。
- 断开 mock / Tauri 不可用时显示本地、诚实的 unavailable 状态。
- 新包中没有远端字体、遥测或额外网络请求。

### Phase 2：迁移 Trust / Findings（首个业务垂直切片）

**原因：** 此处最需要组件化、证据渐进披露与实时刷新；也是当前用户感知最弱的区域。

**产出**

- Trust dashboard、Finding list、Evidence timeline、Evidence detail、Harness profile / coverage、Monitor control。
- 统一的置信度与证据等级展示组件，以及安全字段投影测试。
- runtime events + 可见性兜底刷新；操作后有明确回执。
- “无 Finding”的可解释空态，按 §3.2 展示已扫描和未满足条件。

**退出条件**

- 同一份审计结果在旧页与 React 页关键数字、结论、证据安全引用一致。
- 证据详情无需原始路径/内容也可解释判定来源。
- 新事件可在一个刷新周期内出现在视图，监听不会因 tab 往返重复注册。

### Phase 3：迁移总览、用量、会话与设置

**优先顺序：** 总览壳与新鲜度 → 用量/会话表 → 设置表单 → 测试/Skill。

- 总览复用 `PageHeader`、新鲜度、metric 卡片和 action feedback。
- 会话、用量和发现中的通用表格复用 `DataTable`，但每一列的业务格式化仍留在 feature 内。
- 设置表单采用本地 mutation、就地验证、回执和撤销/回滚语义；不把配置写入语义藏在 UI 中。

### Phase 4：切换生产入口与移除旧表面

**前提：** 所有 nav tab 已迁移，且回归/真机验收通过。

- 更新 Tauri `frontendDist` 到 React build 产物；Windows `url` 切到 React 的 `index.html`（或与最终 build 相符的入口）。
- 旧 `workbench.html/js/css` 只在明确的短期回退窗口内保留；回退窗口结束后删除，不能永久双维护。
- `ui-dev` 的 verify 脚本替换为 React build、DTO mock、交互与可见性测试；保留对 bundle 的原生验收。

---

## 6. 数据、性能与安全预算

| 项目 | 要求 |
|---|---|
| 首屏 | 不扫描执行环境原始日志；只读 authority 聚合与轻量状态。 |
| 详情 | 会话轨迹、原始执行环境重读和大型证据按用户展开懒加载。 |
| 渲染 | 长列表分页/虚拟化；稳定 key；只对已测得昂贵且 props 稳定的纯列表使用 `React.memo`。 |
| 刷新 | 旧数据刷新时保持可见；禁止全屏闪白和无说明的 layout shift。 |
| 包体 | 每引入一个第三方 UI / chart 包都记录 bundle 增量与替代方案。 |
| 安全 | browser mock 是合成数据；不得复制真实 SQLite、执行环境日志、证据或密钥进入 `public/`。 |
| 观测 | 不加线上 telemetry；本地错误仅以受控、脱敏的 UI 回执或用户主动复制诊断呈现。 |

---

## 7. 测试与发布门禁

### 7.1 前端测试

1. 组件单测：状态 badge、空态、金额/时间格式、安全 evidence projection、筛选/排序。
2. feature 测试：mock local bridge 下的 loading → success、partial、unavailable、error、mutation feedback。
3. 交互测试：键盘导航、焦点不遮挡、dialog focus、tab / route 保持、减少动画。
4. contract 测试：Rust DTO fixture 与 TypeScript runtime schema 双向验证；未知字段可忽略，缺失必需字段诚实降级。
5. 视觉回归：至少覆盖浅/深主题、常规桌面宽度、窄窗口、长证据链、无 Finding 和 schema mismatch。

### 7.2 Rust 与产品回归

- 现有 Rust 单测、Python 单测、golden diff 与 Python/Rust parity 不因 UI 迁移而改变事实载荷。
- Trust evidence 的 serving-face 测试证明 React DTO 不含原始路径、内容、凭据、canary 或 native identifier。
- 必须通过 Tauri production build；macOS 真机只通过打包 `.app` 启动和验收，不能用裸 menubar binary 替代。
- Windows 预留的运行时能力按 Windows Trust SPEC 降级呈现；UI 不得把“不可观察”渲染成“无风险”。

### 7.3 验收标准

1. React 页对现有功能不减少；每个旧 tab 有对应迁移页或明确仍在回退窗口的说明。
2. Trust 审计有证据时，用户在两次点击以内看到时间、执行环境、证据等级、来源、安全引用及其与结论的关系。
3. 没有 Finding 时，用户在首屏知道“已扫描什么、发现了什么证据、还缺什么”，而非只见一行文字。
4. 主操作均有 loading、成功或失败反馈；任何刷新不将已有数据清空。
5. 所有按钮可键盘触达并有可见焦点；图标按钮有 accessible name；颜色不是唯一语义。
6. 生产包在无网络下可打开且完整渲染；网络审计不出现新增用户数据出站。
7. schema 版本不兼容时显示恢复路径（升级或安全重建投影），不会显示伪造的零数据。

---

## 8. 取舍与待决事项

1. **查询缓存库：** 优先采用成熟查询缓存实现；若引入包的体积/兼容性不合格，可实现严格受限的本地 query adapter，但不能退回散落 `setInterval`。
2. **组件库：** 第一阶段不引入；当 primitives 覆盖不足时再按离线、无障碍、许可和包体积评审。
3. **路由策略：** 默认 hash router，避免桌面 file/protocol 路由刷新问题；若 Tauri 最终 protocol 对 history router 有可靠支持，可在独立 RFC 评估。
4. **图表：** 用图表前先定义决策问题与无障碍替代（表格/数值）；不为“看起来像 dashboard”加入不可访问的装饰图。
5. **旧 UI 删除时点：** Phase 4 的明确发布版本确定；在此之前只允许一个生产默认入口，避免长期双逻辑漂移。

---

## 9. 明确不做

- 不将 Trust 的原始 `.enc`、manifest、路径或网络记录交给 React 解析；Rust 只输出安全投影。
- 不因前端重构修改 Finding 置信度、证据分级或执行环境风险加权算法。
- 不把“实时”理解为每秒全库扫描；实时是事件驱动 + 有界 fallback。
- 不以 `localStorage` 缓存用户审计数据；只存无敏感的 UI 偏好，且要有清除入口。
- 不用远端字体、CDN 图标、分析 SDK、错误上报 SDK 或云 feature flag。

---

## 10. 实施起点

实施顺序固定为：**Phase 0 合约盘点 → Phase 1 React Shell → Phase 2 Trust/Findings 垂直切片**。未经 Phase 0 的 DTO 与隐私审查，不开始复制页面代码；未经 Phase 2 的 `.app` 真机验收，不切生产 `frontendDist`。

这保证重构首先改善当前最关键的“证据可见性”，同时不牺牲 Agent Vitals 的离线、脱敏与可验证性承诺。
