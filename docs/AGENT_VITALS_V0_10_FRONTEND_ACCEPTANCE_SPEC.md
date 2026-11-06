# Agent Vitals v0.10.0 前台验收与发布收口规格

> 状态：R1，待评审（2026-09-09）
>
> 范围：macOS 菜单栏与 Tauri 工作台的 v0.10.0 Trace & Metrics 前台闭环。
>
> 依据：2026-09-09 用户提供的 5 张真机截图、当前 `main` 源码与本地打包产物。

## 1. 结论

当前实现属于“代码候选完成、已安装前台未完成”：

- 源码已有 `Traces` Tab、`session_trace` IPC 和时间线渲染；截图中的已安装应用没有
  `Traces`，说明运行产物早于实现提交。
- 本地 `/Applications/agent-vitals.app` 构建于 2026-09-08 20:49，Trace 前台提交
  `559d855` 完成于 2026-09-09 00:21，二者确定不一致。
- 会话页将 `window_total_tokens` 显示为“会话数”，截图中的超大“会话数”是确定性
  契约错误，不是视觉误差。
- Traces 目前要求用户手工填写不可见的 `session_ref`，主流程无法自然完成。

因此 v0.10.0 在完成本文 P0 门槛前不得标记为前台验收通过或创建正式版本 tag。

## 2. 现状与根因

| 现象 | 根因 | 代码位置 | 级别 |
|---|---|---|---|
| 已安装应用没有 Traces | 桌面包无可见构建身份，安装步骤未纳入发布门禁；桌面版本长期固定为 `0.1.0` | `tauri.conf.json`、桌面 `Cargo.toml` | P0 |
| “共 6361387017 个会话” | UI 把 `data.window_total_tokens` 赋给 `sessState.total`，再拼成“个会话” | `workbench.js::fetchSessionsPage/renderSessions` | P0 |
| Trace 只能手填引用 | 会话详情没有 Trace 动作，也没有把已有 `session_ref` 传给 Traces | `workbench.html`、`workbench.js::showSession` | P0 |
| 窗口右侧内容被裁切 | 主卡固定三列，详情固定四列；grid 子项缺 `min-width: 0`；工具栏不换行；页面只允许纵向滚动 | `workbench.css` | P1 |
| 菜单“今日无数据”但工作台有 tokens | 菜单在金额缺失时丢弃已知 token，只显示总括性的“无数据”；截图还来自旧构建 | `lib.rs::money_rows_text` | P1 |
| 会话详情被“v0.9.1 降级”占据 | 降级说明作为首个大区块展示，且没有通往 v0.10 Trace 的主动作 | `workbench.js::downgradeBanner` | P1 |

## 3. 产品与数据原则

1. **运行产物可识别**：用户必须能从工作台看到桌面版本、内置 CLI 版本、构建提交和 UI
   contract version。截图必须足以判断“看到的是哪一版”。
2. **单位不可混用**：会话数、事件数和 token 数使用独立字段与标签；禁止用 fallback
   把一种单位显示成另一种。
3. **下钻不要求复制内部标识**：`session_ref` 是安全定位符，不是用户输入。正常路径必须是
   菜单栏/Findings → 会话详情 → 查看轨迹。
4. **缺失不等于零，也不等于无活动**：有 token 但无可计价金额时，应显示“有用量，金额
   不可用”，不能显示笼统的“无数据”。
5. **不合并不同成本口径**：名义成本、按量成本、实际支出和订阅费继续分开；界面必须把
   basis 写在数字附近，不以颜色或 `≈` 单独承担解释。

## 4. 目标信息架构

v0.10.0 顶部导航保持六项：

```text
总览 | Token 日历 | 会话 | Traces | Findings | 数据源
```

主任务路径：

```text
菜单栏最近会话 ─┐
Findings 明细 ──┼→ 会话详情 → 查看轨迹 → Traces（自动加载）
会话列表 ───────┘
```

会话详情标题区必须包含：

- 返回列表；
- 会话标题、执行环境、日期；
- 主动作“查看轨迹”；
- 加载、不可用和已删除状态的就地反馈。

Traces Tab 可以保留手工 `session_ref` 输入作为诊断入口，但默认隐藏在“高级定位”折叠区；
从会话进入时自动填入、自动渲染，并保留返回原会话的路径。

## 5. 数据契约改动

### 5.1 Sessions 列表

`sessions_search.data` 新增：

```json
{
  "window_session_count": 24,
  "window_total_tokens": 6361387017,
  "sessions": [],
  "has_more": false,
  "next_cursor": null
}
```

- `window_session_count` 在应用 `harness`、时间窗口、小时和 `min_tokens` 过滤后、分页前计算。
- `window_total_tokens` 保持 token 守恒用途，不得再作为条数 fallback。
- UI 显示：`2026-09 共 24 个会话 · 6.36B tokens`。
- 旧服务缺 `window_session_count` 时显示“已加载 N 个会话”；不得猜测总数。

### 5.2 Trace 导航状态

前端维护：

```text
traceContext = { sessionRef, title?, harness?, origin }
origin = sessions | finding | menubar | manual
```

切换到 Traces 时只传 `session_ref` 给 IPC。标题和执行环境仅用于展示，不参与服务端定位。
盐轮换、会话删除或跨机器引用必须返回明确错误，不回退到原始路径。

`origin` 是可追加的展示层枚举。v0.11.0 增加 `issue`，用于 Issue → Trace 的返回路径和
界面上下文；即使来源是 Issue，服务端仍不得接受 `issue_id` 代替 `session_ref`。

### 5.3 构建身份

新增只读 `app_build_info`：

```json
{
  "desktop_version": "0.10.0",
  "embedded_cli_version": "1.3.0",
  "git_sha": "4afe8cc",
  "ui_contract_version": 2,
  "built_at": "2026-09-09T08:02:04+08:00"
}
```

工作台页脚常驻短格式 `Desktop v0.10.0 · CLI 1.3.0 · 4afe8cc`。桌面
`Cargo.toml`、`tauri.conf.json` 和发布版本必须锁步，禁止继续使用无法对应产品版本的
`0.1.0`。

## 6. 状态与文案

菜单栏今日按量行按以下矩阵渲染：

| token | 金额 | 文案 |
|---|---|---|
| 有 | 有，纯实测 | `今日按量成本：¥12.34 · 75.0M tokens` |
| 有 | 有，含估算 | `今日按量成本（含估算）：≈¥117.73 · 75.0M tokens` |
| 有 | 无 | `今日按量成本：—（有用量，未计价）· 75.0M tokens` |
| 无 | 无 | `今日按量成本：—（尚无用量）` |

工作台统一使用以下状态词：`加载中`、`暂无记录`、`部分覆盖`、`数据过期`、
`金额不可用`、`调用失败`。禁止用一个“无数据”覆盖这些不同原因。

`TraceCoverage.unmetered_nodes` 显示为“非 live 节点”，不得固定翻译为“废弃分支”；
v0.10.0 尚无可靠信号证明节点已被用户放弃。

## 7. 响应式要求

支持的强制窗口为 `640×480`、`760×560`、`1280×720`。

- 页面根节点不得产生横向滚动或静默裁切；宽表只在自己的 `.table-wrap` 内横向滚动。
- KPI grid 使用可收缩轨道，如 `repeat(auto-fit, minmax(220px, 1fr))`；grid/flex
  子项必须允许 `min-width: 0`。
- 会话详情卡使用自适应列，640px 下至少两列；内容过长使用
  `overflow-wrap: anywhere`，不让标识符撑宽页面。
- 顶部 tabs 保持单行且自身可横向滚动；右侧同步和刷新操作始终可达。
- Sessions、Findings 和 Traces 工具栏允许换行；Trace 输入框不得使用不可收缩的内联
  `min-width: 320px`。
- 所有按钮可键盘聚焦；仅靠 hover 提供的信息必须有可点击或可聚焦替代。

## 8. 实施顺序

### Phase 1：正确性与主流程（P0）

1. 增加 `window_session_count`，修正会话页计数和测试。
2. 会话详情增加“查看轨迹”，自动传递 `session_ref` 并渲染。
3. 增加 `app_build_info`，统一桌面版本并在页脚展示。
4. 重建并替换 `/Applications/agent-vitals.app`。

### Phase 2：响应式与诚实状态（P1）

1. 修正 grid、toolbar、header 和长文本收缩规则。
2. 修正菜单栏“有 token、无金额”的状态文案。
3. 将 v0.9.1 降级说明缩为次级状态；Trace 成为会话详情的主动作。
4. 修正 `unmetered_nodes` 的前台术语。

### Phase 3：发布门禁

1. 将桌面 crate 测试、Trace 壳验证和打包验收接入发布流程。
2. 对最终 `.app` 而非源码目录执行资源/版本检查。
3. 完成真机截图验收后再创建 `v0.10.0` tag。

## 9. 验收矩阵

| 编号 | 场景 | 通过标准 |
|---|---|---|
| F1 | 打开已安装 App | 页脚版本、CLI 版本和提交与本次构建一致；导航存在 Traces |
| F2 | 月窗口含 24 会话、6.36B tokens | 标题显示“24 个会话 · 6.36B tokens”，单位不串 |
| F3 | 点击任一会话的“查看轨迹” | 无复制步骤；进入 Traces 并自动请求同一 `session_ref` |
| F4 | 从 Findings/菜单栏进入会话再看轨迹 | 上下文不丢，返回路径可用 |
| F5 | 有 token、无金额 | 菜单和总览都表达“有用量，金额不可用” |
| F6 | 缺 parent/time/status | 六项 coverage 原样显示，不生成单值完整率 |
| F7 | `640×480` | 导航、KPI、工具栏无裁切；表格仅局部滚动 |
| F8 | 空会话、未知引用、源日志已清理 | 三种状态文案不同，页面不崩溃 |
| F9 | 打包产物检查 | `.app` 的版本与 UI contract 正确，内置 CLI 可执行 |
| F10 | 截图回归 | 总览、会话列表、会话详情、Traces、Findings 各一张，无遮挡重叠 |

## 10. 自动化与发布命令

新增或扩展以下守卫：

- Rust：`sessions_search` 断言 `window_session_count` 与分页无关、与过滤一致。
- JS：`verify-workbench-traces.mjs` 覆盖 Session→Trace 自动下钻、错误态和 coverage 文案。
- JS：新增工作台响应式静态守卫，禁止固定三/四列和不可收缩 Trace 输入。
- Package：读取 `.app/Contents/Info.plist`，核对版本；启动最终 `.app` 后截图。

发布前至少执行：

```bash
cargo test --release
python3 -m unittest discover tests -v
node scripts/verify-workbench-traces.mjs
cd apps/desktop/src-tauri
cargo test --release
cargo tauri build --bundles app
```

最终验收对象必须是重新安装并重启后的 `/Applications/agent-vitals.app`，不能用源码
存在、Node DOM 桩通过或旧进程仍存活代替真机前台验收。

## 11. 非目标

- v0.10.0 不实现 Issues、Savings、自动 remedy 或写入用户环境。
- v0.10.0 的六项导航不是永久信息架构冻结：v0.11.0 将 `Findings` 演进为单一
  `Issues` 主入口，具体交接以 Value Loop 架构规格 §4.0 为准。
- 不恢复原始路径作为 Trace 公共入参。
- 不在 UI 重算 token、价格、coverage 或会话身份。
- 不因前台收口升级 Authority schema；本版本继续使用 schema v2。
