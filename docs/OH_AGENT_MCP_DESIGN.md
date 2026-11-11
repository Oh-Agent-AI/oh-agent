# Oh Agent MCP 与 App Plugin 交互设计

版本：v1.2 · 日期：2026-10-24  
状态：架构设计稿；本文不代表其中所有接口均已实现。

v1.1 修订：建筑写入只有一条 Rust 函数；MCP 写入会通知已经打开的 City，这不是静默写，也不是 MCP 去控 UI；第 7 节把「今天」和「目标」分开；City 只订阅它要画的宿主窄通道。

v1.2 修订：插件请求按描述符分发。解析器和投影不再写 `plugin_id == "city"`。

已按第 9 节落地：`serverInfo.name` 是 `Oh Agent MCP`；设置页与 SKILL.md 的连接键样例是 `oh-agent`。命令仍是 `agent-vitals data-mcp serve`。旧连接键不用改。工具名、SQLite 和建筑存储格式未改。`city.building.*` 仍是示例，没有登记成插件方法。

## 1. 目标

定义 Oh Agent 对外 MCP 服务的产品名称、职责边界，以及它与应用内 App Plugin 的关系。设计目标是让外部 Agent 能通过一个本地 MCP 连接查询本机 Agent 使用数据；同时让 Oh Agent 内的 City 等官方插件通过 App Plugin 宿主接口读取获准的数据并操作自己的界面。

核心原则：**MCP 面向外部 Agent；App Plugin API 面向 Oh Agent 内的官方插件。两者可访问受控的本机能力，但不互相充当 UI 控制通道。**

## 2. 名称

| 名称 | 建议值 | 说明 |
| --- | --- | --- |
| 产品展示名 | `Oh Agent MCP` | 设置页、配置说明与面向用户的名称 |
| 客户端连接名 | `oh-agent` | Codex、Claude 或通用 MCP 配置中的连接键，可由用户自定义 |
| MCP 服务端名称 | `Oh Agent MCP` | MCP `serverInfo.name`，用于客户端展示、日志和调试 |
| 本地可执行文件 | `agent-vitals` | CLI 程序名；本设计不要求改名 |
| 启动子命令 | `data-mcp serve` | 本地 MCP 服务入口 |

客户端连接名和 MCP 服务端名称是不同字段，不要求相同。服务端名称是自报元数据，不是鉴权凭据或安全边界。

## 3. 总体架构

```text
外部 Agent
    │ stdio / MCP
    ▼
Oh Agent MCP (`agent-vitals data-mcp serve`)
    │ 类型化工具 → 受控的 Rust 查询/写入 handler
    ▼
本机 authority 数据、价格/预算状态、City 建筑状态

Oh Agent App
    ├─ 宿主 WebView / PluginHost
    │      ▲ 版本化 PluginRequest / PluginResponse
    │      │
    └─ City App Plugin
           │ 已登记、限 allowlist 的宿主方法
           ▼
       Rust projection / action handlers → 本机状态
```

MCP 和 App Plugin 可以调用共享的 Rust 领域逻辑与 repository，但不得让插件直接访问数据库、MCP stdio、任意 SQL 或通用 IPC。

## 4. Oh Agent MCP 职责

### 4.1 面向对象

MCP 提供给 Codex、Claude 等外部 Agent 使用，用于在用户请求下查询或执行受限的本机操作。它不是应用内插件总线，不负责启动 City 页面、控制 Three.js 场景或操作宿主 DOM。

「不控制 UI」不等于写入是静默的。建筑写入（`preview_building` / `set_building_model` / `reset_building`）和 `im_publish` 仍由服务端向**已经打开**的 City 窗口扇出 `CityEntityChanged` 与小队信封：施工、幽灵预览、失败闪烁、小队侧栏、地块着色。这是状态通知。Agent 不得再调用 `im_publish` 去汇报 preview / set / reject / reset；这些 kind 由写入函数自己扇出。见 [CITY_SQUAD_IM.md](CITY_SQUAD_IM.md)。

### 4.2 工具分区

沿用一个 MCP server，按领域提供工具：

- **Usage & Cost**：用量、成本估算、预算与价卡。
- **Sessions & Insights**：会话搜索、会话统计、工作流摘要和数据质量。
- **City Building**：按会话或建筑引用读取、预览、应用和重置建筑模型。

已有工具名保持稳定，避免无必要的兼容性破坏。新工具按领域命名；如需批量更名旧工具，另行做兼容与迁移设计。

### 4.3 本地运行与写入

- 使用本地 `stdio` transport，不新增远程监听服务。
- 默认只读。
- 写操作需显式启用 `--allow-local-writes`，且只能调用类型化、范围明确的本机动作。
- 不开放任意 SQL、任意文件/路径访问、任意 URL 请求或凭据读取。
- 建筑修改使用 `get → preview → set → get`；set 使用 `expected_revision` 乐观并发控制。

现有建筑 MCP 契约见 [CITY_BUILDING_MCP.md](CITY_BUILDING_MCP.md)。

## 5. App Plugin 交互：以 City 为例

本节描述 **City App Plugin 与 Oh Agent 宿主的交互**，不是外部 MCP Agent 控制 City 的流程。

### 5.1 请求链路

1. City 插件通过 SDK 的版本化 `plugin_request` 信封调用宿主方法。
2. PluginHost 校验插件描述符、活动 WebView/instance、方法 allowlist 和声明的数据范围。
3. Rust handler 查询或修改本机状态，并只返回该方法声明的类型化投影。
4. 写操作调用与 MCP 相同的领域函数（§5.2）。校验与持久化发生在该函数内，并向已打开的 City 扇出带 revision 的建造事件与小队信封（§5.5）。
5. City 作为这条通道的订阅者重读投影并更新自己的场景。它不直接读取数据库，也不依赖接收完整历史事件；窗口关闭时，末态留在邮箱里。

### 5.2 City 能力边界

City 插件可按功能声明并请求：

- 会话建筑所需的统计摘要、稳定 opaque building reference 和当前建筑模型；
- 建筑模型预览结果及结构化校验错误；
- 用户发起的建筑模型应用/重置动作；
- revision 变化通知，以刷新场景并避免覆盖并发更新。

建议的领域动作可表达为 `city.building.get`、`city.building.preview`、`city.building.set`、`city.building.reset`；具体方法名、DTO 和授权 scope 必须在单独的版本化 App Plugin 契约中冻结，本文不把这些示例视为已注册接口。

MCP 已存在的 `get_building` / `preview_building` / `set_building_model` / `reset_building` 属于外部 Agent 工具面。App Plugin 不应通过调用 MCP server 来实现内部交互；宿主应复用领域与 repository 层，在 PluginHost 注册专用 handler。

这些方法一旦登记，`city.building.preview` / `city.building.set` / `city.building.reset` 必须调用与 `preview_building` / `set_building_model` / `reset_building` **相同的 Rust 函数**。CAS、设计门、施工通知和小队信封都从这条函数出来。不得再写第二套校验，也不得再写第二条落盘路径。插件侧的 set 仍须用户在 City 内确认；页面脚本不得自行持久化。

### 5.3 插件身份与响应交付

- 只允许官方描述符注册的内置插件调用相应本地 projection/action handler。
- 分发看描述符里的投影键、`navigationTargets`、`stateKeys`，不在解析器里比较插件 id 是不是 `"city"`。会话句柄的作用域就是签发它的插件 id：`app:{pluginId}:{session_key}`。声明了 `session` 的插件能打开自己的句柄，打不开别人的。
- 每个请求绑定当前活动插件身份和 WebView instance；查询前校验，返回响应前再次校验。
- 浏览器预览或未授权实例使用合成数据，不返回真实本机数据。
- 插件停用、instance 失效或数据能力不可用时，返回显式错误/不可用状态，不以 fixture 冒充真实结果。

### 5.4 数据最小化

- 插件只获得完成 City 功能需要的投影字段。
- 会话标识使用 opaque handle；不暴露原生 session ID、文件路径、工作目录或 raw anchor。
- 不返回完整提示词、会话原文、原始工具参数、原始错误、凭证或 canary 内容。
- 若某项功能确需任务上下文，只能使用已有的、经脱敏和长度限制的摘要投影，并明确角色、来源和截断状态；新增敏感字段须先评审契约。
- App Plugin 不新增后台网络，不上传用户数据。

### 5.5 City 是宿主窄通道的订阅者

City 订阅的是它要画出来的那几类宿主通知，不是一条开放的领域总线，也不是所有领域事件的总消费者。订阅写在描述符的 `hostEvents`（`building`、`squad`）里。当前打开的插件声明了哪一项，宿主就把那一项投递给它，不看插件 id 是不是 `city`。

| 领域 | City 怎么拿到 | 推送内容 |
| --- | --- | --- |
| 建筑 | 订阅 `CityEntityChanged` | `set` / `reset` / `preview` / `reject` |
| 小队 | 订阅信封 v:1 | Agent 经 `im_publish` 的 `chat` / `claim` / `release`，加上写入函数扇出的 `preview` / `reject` / `set` / `reset` |
| 用量、会话、预算 | `plugin_request` 拉取 `city:v3` | 失效只触发重读，不推完整历史 |

传输是 `host.sock` 加上三个**末态邮箱**，不是队列：

| 邮箱 | 内容 |
| --- | --- |
| `state/plugins/city-buildings/notify.json` | 已持久化的 `set` / `reset`（`CityEntityChanged`） |
| `state/plugins/city-buildings/edit.json` | `preview` / `reject` |
| `state/plugins/city-buildings/squad.json` | 小队信封 v:1 |

后写覆盖前写。窗口没开时，事件停在邮箱里，下次打开再读末态。用量、会话、预算不走这条推送；City 需要时自己拉投影。

## 6. 权限模型

| 消费面 | 身份边界 | 数据/动作边界 |
| --- | --- | --- |
| 外部 MCP client | 客户端配置的本地 server connection；写操作还要求服务启动时开启写入能力 | MCP tool allowlist、类型化参数、每工具校验；响应按 MCP serving-face 规则脱敏 |
| 官方 App Plugin | 官方插件描述符、活动 WebView instance、已登记方法与声明 scope | Rust 注册的 projection/action handler；每次请求及响应交付时都校验授权状态 |

这两个边界不能互相替代。MCP 的 `serverInfo.name` 不授予权限；客户端连接别名也不授予数据访问。App Plugin 的 `pluginId`、方法 allowlist 与 scope 才构成内置插件本地访问边界。

## 7. City 场景完整流程

### 7.1 今天：外部 Agent 写入，已打开的 City 重绘

今天的 set 由外部 Agent 经 MCP 发起。City 不发起 set。打开着的窗口只是这条写入的订阅者。

```text
外部 Agent → Oh Agent MCP
    preview_building / set_building_model / reset_building
    （与未来插件 handler 是同一条 Rust 函数）
        ↓
函数内：CAS + 设计门 → 持久化
        ↓
扇出 CityEntityChanged + 小队信封（host.sock + 末态邮箱）
        ↓
已经打开的 City 更新场景
（施工、幽灵预览、失败闪烁、小队侧栏、地块着色）
```

Agent 不要再发一条 `im_publish` 去汇报这次写入。

### 7.2 目标：用户在 City 内确认，插件调用同一条函数

```text
用户在 City 选择一栋会话建筑
    ↓
City Plugin → PluginHost → city building projection handler
    ↓                           ↓
显示当前模型/建筑引用 ← 类型化、最小化投影
    ↓
用户或插件提出模型修改
    ↓
PluginHost → preview handler → 同一条 Rust preview 函数
    ↓
展示预览与校验结果
    ↓ 用户确认
同一条 set 函数（expected_revision）→ 持久化 → revision/build event
    ↓
City Plugin 收到失效通知并重读模型 → 更新场景
```

页面脚本不得绕过这条函数自行落盘。插件不得另开 MCP 连接来完成同一次写入。

设计校验应不止覆盖 AABB、占地或高度，还需确认修改没有不合理地破坏主体形态、用途和构件连接关系。机器可验证规则负责拦截可形式化的问题；无法自动判断的设计质量必须标注为未验证，不能以“预览通过”宣称审美合格。

## 8. 是否拆分 City MCP

当前建议保持一个 **Oh Agent MCP**，不新建独立 City MCP。外部 Agent 的 City 建筑工具已经属于 MCP 工具面；应用内部 City 页面通过 App Plugin API 与宿主交互，这是两个不同调用面，不应因为插件交互就额外启动一条 MCP 连接。

只有出现独立安装/生命周期、不同用户授权边界、需要单独启停或明确的隔离要求时，才重新评估拆分独立 MCP server。App Plugin 能力应继续沿用统一 PluginHost 协议。

## 9. 迁移与兼容

1. MCP 服务端 `serverInfo.name` 改为 `Oh Agent MCP`。
2. 设置页生成的客户端配置默认使用 `oh-agent`，命令和程序路径保持不变。
3. 不要求旧客户端连接键同步重命名；用户可自行迁移，变更连接别名后重启对应 MCP client。
4. 首轮不重命名既有工具名、不改 SQLite schema、不更改建筑存储格式。
5. App Plugin 的 City building 方法作为独立版本化契约实施，不依赖 MCP transport。登记之后必须调用第 5.2 节那条既有写入函数，而不是复制一套。

## 10. 验收标准

- MCP 握手显示 `Oh Agent MCP`；设置页配置样例连接键为 `oh-agent`，旧配置仍可独立工作。
- MCP 只使用本地 stdio；写入在未授权启动时被拒绝。
- City 插件只通过 SDK/PluginHost 调用注册的方法；没有 DB、任意 SQL、原始日志或路径访问，也不自己去开 MCP 连接。
- 新官方插件的投影、会话跳转和已登记状态键由描述符授权。Rust 分发不硬编码 `plugin_id == "city"`。
- 请求身份、活动 instance、方法 allowlist 与声明 scope 在 handler 查询前和响应交付前均校验。
- 建筑写入只有一条 Rust 函数。MCP 的 `preview_building` / `set_building_model` / `reset_building` 与未来的 `city.building.preview` / `set` / `reset` 都调用它。CAS、设计门、施工通知、小队信封不存在第二份实现。
- 该函数的扇出能到达已经打开的 City。窗口关闭时，末态留在 `notify.json` / `edit.json` / `squad.json`，下次打开再读。
- City 建筑预览可展示结构化限制；通过校验不等于自动认证建筑审美质量。
- City set 使用 revision CAS，持久化成功后场景可收到通知并重读；失效时显式降级。
- MCP 与 App Plugin 契约有各自的自动化测试；真实桌面 WebView/City 场景仍需集成验收，浏览器 fixture 不能替代该证据。

## 11. 相关规范

- [Agent Vitals Data MCP 规范](AGENT_VITALS_DATA_MCP_SPEC.md)
- [City Building MCP 工具契约](CITY_BUILDING_MCP.md)
- [City 小队 IM](CITY_SQUAD_IM.md)
- [App Plugin 通用 Harness 数据契约](APP_PLUGIN_HARNESS_DATA_CONTRACT.md)
- [Agent Vitals App Layer 架构](AGENT_VITALS_APP_LAYER_ARCHITECTURE_SPEC.md)
- [官方插件接入指南](OFFICIAL_PLUGIN_INTEGRATION_GUIDE.md)
