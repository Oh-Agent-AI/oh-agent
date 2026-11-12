# Creator Rust / City 边界优化方案

日期：2026-11-12  
状态：提案，待评审（不改代码，仅定义改造路径）  
关联文档：[Creator Studio Agent 接入代码设计](AGENT_CREATOR_AGENT_INTEGRATION_CODE_DESIGN_2026_11_12.md)、[Creator Studio 代码架构](AGENT_CITY_CREATOR_STUDIO_CODE_ARCHITECTURE_2026_11_11.md)、[Creator MCP 多客户端接入指南](AGENT_CREATOR_MCP_CLIENT_SETUP.md)

> 行号基准：`2bd47aae` + 2026-11-12 工作树。实现时以**函数名**为准，行号只用于定位。

## 1. 摘要

### 1.1 问题

`apps/desktop/src-tauri/src/creator_projects.rs` 目前不只是 Creator 宿主服务，它还是**第二套 City 内容规则实现**：

- 小游戏 DSL 校验（`validate_game`）
- 场景对象 schema 校验（`validate_scene_object`）
- 挂载与可达性校验（`validate_mount` 内的 BFS）
- 城市补丁 schema 校验（`validate_city_patch`）
- 模板目录（`game_template`）、皮肤白名单（`valid_skin_id`）
- 能力目录（`creator_capabilities`）
- 场景操作应用与差异（`apply_scene_operations` / `changedObjects`）

这些规则在 `packages/agent-vitals-city-sdk/src/content.ts`、`validate.ts` 和 City 引擎里已经存在一份。两套实现没有对等测试，已经出现漂移（§3.4），并且让“加一种皮肤/模板/工具”必须改 Rust（§3.5）。

### 1.2 目标

按以下边界收敛：

| 层 | 负责 | 不负责 |
|---|---|---|
| Rust 宿主 | 插件身份与授权、请求路由、项目存储、revision/事务、幂等、资产字节与摘要、预算硬上限、试玩生命周期、**通用结构/安全检查** | City 内容语义、模板/皮肤目录、可达性、差异语义 |
| City SDK / 可信 TS 适配器 | City 内容模型、操作语义、模板/皮肤目录、挂载与锚点规则、场景差异、可达性与运行时校验、能力描述 | 落盘、权限决定、revision/事务 |
| MCP | 稳定工具协议、传输边界校验、转发 | City 规则、内容枚举、二次预算 |
| Studio UI | 可视预览、用户确认、编辑交互、调用 SDK 校验 | 绕过项目服务直接落盘 |

### 1.3 预期结果

- 新增皮肤/模板：只改 SDK 内容定义 + 生成的资产 JSON，**Rust 零改动**（皮肤要求 City 渲染按 skin pack 的 `themeId` 工作；复用现有操作的新模板不需要 City 代码）。
- 规则单一来源：SDK 定义 → 构建期生成 JSON → Rust/MCP 消费；新增对等 fixture 与锁步测试。
- 预算单一来源：内容预算在描述符，传输预算在宿主通道；MCP 不再自建上限。
- 每次 preview/commit 记录 `capabilityVersion`，版本偏斜可诊断。

---

## 2. 边界原则

1. **写权威只有 Rust**：任何内容写入都必须经过宿主的结构校验、分预算、revision CAS 与幂等记录。
2. **SDK 决定“内容对不对”，不决定“能不能写”**：SDK 的诊断是内容语义结论；权限、大小、存储路径、事务、字节完整性永远由 Rust 判定。
3. **描述符来自构建产物**：能力/内容目录由 SDK 在构建期生成并编进二进制/包，运行时不接受客户端上传的描述符。
4. **通用优先**：Rust 的逻辑以操作 `kind`（upsert/remove/bind/set/patch）和字段白名单驱动，不按具体模板/皮肤/游戏分支。
5. **可版本化**：描述符有 `schemaVersion`（主版本）与 `capabilityVersion`（内容版本），preview/operation/release 记录后者。
6. **诚实降级**：SDK 缺失或版本不匹配时拒绝写入（可诊断错误），不假装验证过。

### 非目标

- 不在 Rust 里嵌入 JS 引擎或运行 TS。
- 不让 SDK 决定项目路径、权限、revision 或预算上限。
- 不把 MCP 变成能力注册中心；MCP 只暴露稳定协议。
- 不改变“Studio 是官方可信插件、由 PluginHost 校验活动实例”的既有模型。

---

## 3. 现状分析

### 3.1 调用链

```
MCP client
  │ tools/call
  ▼
creator_studio.rs  ── 入参 schema/类型校验 ──► plugin mailbox（默认单条 64 KiB）
  │
  ▼
Studio WebView（官方插件，活动实例）
  │ creatorRequest("creator.*")
  ▼
PluginHost（localCalls allowlist）
  │
  ▼
creator_projects.rs
  ├─ 结构校验（应为宿主职责）
  ├─ City 语义校验（应属 SDK，当前在 Rust）
  ├─ 通用/语义混在一起的应用逻辑
  └─ SQLite + revision + 幂等 + 预览 + 发布 + 试玩
```

### 3.2 责任对照

| 责任 | 期望归属 | 现有实现 | 判定 |
|---|---|---|---|
| 插件身份/授权/路由 | Rust 宿主 | `plugin_host.rs` descriptor + `localCalls` | ✅ |
| 项目存储、revision/事务、幂等 | Rust 宿主 | `creator_projects.rs`：`create/commit/operation_status` | ✅ |
| 资产字节、SHA-256、GLB 结构 | Rust 宿主 | `verify_scene_asset_bytes`（[:1023](apps/desktop/src-tauri/src/creator_projects.rs:1023)） | ✅ |
| 试玩生命周期 | Rust 宿主 | `start/claim/finish/expire_playtest` | ✅ |
| 预算硬上限 | Rust 宿主 | `MAX_*` 常量（[:9-33](apps/desktop/src-tauri/src/creator_projects.rs:9)） | ⚠️ 与 MCP/SDK 重复 |
| 小游戏 DSL 语义 | City SDK | `validate_game`（[:184](apps/desktop/src-tauri/src/creator_projects.rs:184)） | ❌ 第二套 |
| 场景对象 schema | City SDK | `validate_scene_object`（[:960](apps/desktop/src-tauri/src/creator_projects.rs:960)） | ❌ 第二套 |
| 挂载/锚点/可达性 | City SDK | `validate_mount` + BFS（[:1058-1143](apps/desktop/src-tauri/src/creator_projects.rs:1058)） | ❌ 第二套 |
| 城市补丁 schema | City SDK / City 引擎 | `validate_city_patch` + op 校验（[:362-501](apps/desktop/src-tauri/src/creator_projects.rs:362)） | ❌ 部分重复 |
| 模板目录 | City SDK | `game_template`（[:155](apps/desktop/src-tauri/src/creator_projects.rs:155)） | ❌ 硬编码 |
| 皮肤目录 | City SDK | `valid_skin_id`（[:90](apps/desktop/src-tauri/src/creator_projects.rs:90)）、`"skins":[...]`（[:1707](apps/desktop/src-tauri/src/creator_projects.rs:1707)） | ❌ 硬编码 |
| 能力目录 | City SDK 声明 | `creator_capabilities`（[:1698](apps/desktop/src-tauri/src/creator_projects.rs:1698)） | ❌ 无 SDK 来源 |
| 场景操作应用/差异 | 通用宿主应用 + SDK 语义差异 | `apply_scene_operations`（[:1178](apps/desktop/src-tauri/src/creator_projects.rs:1178)）、`changedObjects` | ❌ 语义混入 |
| MCP 传输边界 | MCP | `creator_studio.rs` 类型校验 | ✅ |
| MCP 内容枚举/二次预算 | 不应存在 | `template` enum（[creator_studio.rs:40](crates/agent-vitals-mcp/src/mcp/creator_studio.rs:40)）、48 KiB 上限（[:242](crates/agent-vitals-mcp/src/mcp/creator_studio.rs:242)） | ❌ |
| Studio 可视交互 | Studio | 只调 `creatorRequest`，capture 本地出帧 | ✅ |

### 3.3 重复量化

| 规则族 | Rust | TS（city-sdk / City） | 关系 |
|---|---|---|---|
| 小游戏 DSL | `validate_game`，约 89 行 | `validateMiniGamePack`（[content.ts:35](packages/agent-vitals-city-sdk/src/content.ts:35)），约 134 行 | 近似 1:1 |
| 场景对象 | `validate_scene_object`，约 41 行 | `validateSceneDraft`（[validate.ts:203](packages/agent-vitals-city-sdk/src/validate.ts:203)） | 近似 1:1 |
| 挂载 + 可达性 | `validate_mount`，约 86 行 | `validateMount`（[validate.ts:262](packages/agent-vitals-city-sdk/src/validate.ts:262)），含同构 BFS | 近似 1:1 |
| 城市补丁 | `validate_city_patch` + 道路/设施 op，约 140 行 | `planPatch` 类型 + City 修复会话 | 部分重复 |
| 模板 | `game_template` | `checkpointRace.ts` 组包 | 5 处（含 MCP 枚举、Studio 选项、mock） |
| 皮肤 | 3 处 | City UI 目录 + 引擎映射 + 加载校验 | 共 9 处 |
| 能力目录 | `creator_capabilities` | 无 | Rust 单点 |

`creator_projects.rs` 约 2600 行，其中 City 语义相关约 **700–800 行**；`validate.ts` + `content.ts` 合计 658 行覆盖同一批规则。

### 3.4 已发生的漂移

1. **预算口径矛盾**：capabilities 广告 `maxGameBytes: 262144`（[creator_projects.rs:1702](apps/desktop/src-tauri/src/creator_projects.rs:1702)），MCP 预览却在入参层拒绝 >48 KiB（[creator_studio.rs:242](crates/agent-vitals-mcp/src/mcp/creator_studio.rs:242)），文档也写 ≤48 KiB（[接入指南:72](docs/AGENT_CREATOR_MCP_CLIENT_SETUP.md:72)）。
2. **诊断质量反向**：SDK 返回带 `code/severity/path/objectId` 的 `DiagnosticV1`；Rust 先返回单一粗码，`validate_scene` 再拼出泛化 message（[creator_projects.rs:1799](apps/desktop/src-tauri/src/creator_projects.rs:1799)）。权威路径给 Agent 的信息比 SDK 预检更少。
3. **版本只活在字面量里**：`schemaVersion/rulesVersion = 1` 在 Rust 与 TS 各写一遍；升级 v2 需要同时改两处且无协商字段。
4. **无 RS↔TS 对等测试**：仓库对 Python↔Rust 有 differential/lockstep 纪律，这条线没有；两套实现已经分叉而无人发现。
5. **能力发现被绑在 UI 上**：`creator.capabilities.list` 走插件信箱（[creator_studio.rs:209](crates/agent-vitals-mcp/src/mcp/creator_studio.rs:209)），Studio 没开就查不到静态目录。

### 3.5 变更成本（用户判断的实证）

**新增一种皮肤**（否则 `skin.select` 被拒、capabilities 不列、发布校验失败）：

1. `creator_projects.rs::valid_skin_id`（[:90](apps/desktop/src-tauri/src/creator_projects.rs:90)）
2. `creator_projects.rs::apply_mount_skin_operation`（[:1170](apps/desktop/src-tauri/src/creator_projects.rs:1170)）
3. `creator_projects.rs::creator_capabilities`（[:1707](apps/desktop/src-tauri/src/creator_projects.rs:1707)）
4. `CityEngine.ts` 类型 + 主题映射（[:64](apps/agent-city/ui/src/engine/CityEngine.ts:64)、[:724](apps/agent-city/ui/src/engine/CityEngine.ts:724)）
5. `cityWorldProfile.ts::BUILTIN_CITY_SKINS_V1`（[:57](apps/agent-city/ui/src/engine/cityWorldProfile.ts:57)）
6. `loadCreatorExperiences.ts` 字面量判断（[:36](apps/agent-city/ui/src/game/activity/loadCreatorExperiences.ts:36)、[:93](apps/agent-city/ui/src/game/activity/loadCreatorExperiences.ts:93)）
7. `CityExperience.tsx` 标签（[:609](apps/agent-city/ui/src/CityExperience.tsx:609)）
8. `creator-studio/ui/main.tsx` 默认值（[:55](apps/creator-studio/ui/src/main.tsx:55)）

**共 8 处引用、6 个文件、3 个包，其中 3 处必须改 Rust。**

**新增一个模板**：Rust `game_template`、MCP `template` 枚举 + `run` 守卫（[creator_studio.rs:40](crates/agent-vitals-mcp/src/mcp/creator_studio.rs:40)、[:233](crates/agent-vitals-mcp/src/mcp/creator_studio.rs:233)）、Studio 下拉（[main.tsx:499](apps/creator-studio/ui/src/main.tsx:499)）、City 活动组包（[checkpointRace.ts:29](apps/agent-city/ui/src/game/activity/checkpointRace.ts:29)）、browser mock（[tauri-mock.js:1296](apps/desktop/ui-dev/public/tauri-mock.js:1296)）——5 处、3 种语言。

**新增一个工具**：`specs()`、`run()`、`mod.rs` 路由、`plugins.json localCalls`、Studio `methods`、Rust `dispatch_as`、测试/文档——7 处。

### 3.6 可复用的现有机制

- **描述符声明能力**：`RemoteCapability`（[remote_protocol.rs:8](apps/desktop/src-tauri/src/remote_protocol.rs:8)）已验证“插件声明、宿主校验形状”的模式。
- **跨语言资产**：`assets/pricing.json` 通过 `include_str!` 编进二进制（[price_overrides.rs:3](crates/agent-vitals-runtime-core/src/pricing/price_overrides.rs:3)），适合放生成的能力/模板 JSON。
- **生成与字节校验**：`scripts/generate-app-contracts.mjs` + `verifyArtifact` 的“生成物漂移即失败”模式可直接复用。
- **描述符整体校验测试**：`plugin_host.rs` 对 `localCalls/remoteCapabilities` 已有断言（[:236](apps/desktop/src-tauri/src/plugin_host.rs:236)）。

---

## 4. 目标架构

### 4.1 分层

```
┌────────────────────────────────────────────────────────────┐
│ MCP tool adapter（crates/agent-vitals-mcp）                 │
│ 稳定 JSON Schema、类型校验、转发；无 City 内容知识           │
└───────────────┬────────────────────────────────────────────┘
                │ plugin mailbox（按方法预算）
┌───────────────▼────────────────────────────────────────────┐
│ Rust Creator 服务（creator_projects.rs + capabilities.rs）   │
│ 权限、存储、revision/事务、幂等、预算硬上限、资产字节、        │
│ 通用结构检查、operation kind 应用                             │
│ 只读：assets/creator/capabilities.json（构建期、来自 SDK）     │
└───────────────┬────────────────────────────────────────────┘
                │ preview / commit（带 validation 信封）
┌───────────────▼────────────────────────────────────────────┐
│ Studio WebView（可信适配器）                                 │
│ city-sdk：validateMiniGamePack / validateSceneDraft /        │
│ validateMount / 语义差异 / diagnostics                       │
└────────────────────────────────────────────────────────────┘
```

### 4.2 职责矩阵（目标态）

| 能力 | Rust | SDK | MCP | Studio |
|---|---|---|---|---|
| 工具 schema/传输 | — | — | ✅ | — |
| 权限/实例/allowlist | ✅ | — | — | — |
| 项目/事务/幂等 | ✅ | — | — | — |
| 预算硬上限 | ✅ | 声明内容预算 | 只做传输 | 显示 |
| 结构/字段白名单 | ✅（描述符驱动） | — | — | — |
| 游戏 DSL 语义 | — | ✅ | — | 调用 |
| 场景对象语义 | — | ✅ | — | 调用 |
| 挂载/可达性 | — | ✅ | — | 调用 |
| 城市补丁语义 | — | ✅ | — | 调用 |
| 模板/皮肤目录 | 读取生成资产 | ✅ 声明 | — | 展示 |
| 能力描述 | 投影 | ✅ 声明 | 暴露 | 展示 |
| 场景差异 | 通用兜底 | ✅ 语义差异 | — | 渲染 |
| 资产字节/摘要 | ✅ | — | — | — |
| 试玩生命周期 | ✅ | — | — | 展示/交接 |

### 4.3 不变量

1. 只有宿主能写 SQLite；Studio 不得直接落盘。
2. 内容语义未通过 SDK 校验的 preview 不可 commit。
3. 描述符只从构建产物读取；运行时不接受上传。
4. 所有 preview/commit/operation/release 记录 `capabilityVersion`。
5. Rust 结构校验失败时明确拒绝；不因为 SDK 说 ok 就跳过。
6. 任何新增内容不得要求修改 Rust 的 match 分支（操作 `kind` 除外）。

---

## 5. 关键设计

### 5.1 能力描述符 v1

#### 5.1.1 内容

```json
{
  "schemaVersion": 1,
  "capabilityVersion": "2026-11-12.1",
  "operations": [
    {"id": "scene.object.upsert", "kind": "upsert", "target": "scene.objects", "idField": "id"},
    {"id": "scene.object.remove", "kind": "remove", "target": "scene.objects", "idField": "id"},
    {"id": "anchor.upsert",       "kind": "upsert", "target": "scene.objects", "idField": "id"},
    {"id": "anchor.remove",       "kind": "remove", "target": "scene.objects", "idField": "id"},
    {"id": "mount.bind",          "kind": "bind",   "target": "mounts",       "idField": "mountId"},
    {"id": "mount.remove",        "kind": "remove", "target": "mounts",       "idField": "mountId"},
    {"id": "skin.select",         "kind": "set",    "target": "skinId"},
    {"id": "city.patch.upsert",   "kind": "set",    "target": "cityPatch"},
    {"id": "city.patch.remove",   "kind": "remove", "target": "cityPatch"}
  ],
  "content": {
    "templates": ["checkpoint-race", "collect-one"],
    "skins": ["miami-vice", "desert-evening"]
  },
  "budgets": {
    "gameBytes": 262144,
    "sceneObjects": 10000,
    "sceneColliders": 256,
    "mountBindings": 64,
    "cityPatchBytes": 262144
  }
}
```

- `kind` 是**协议级**概念，只有 `upsert/remove/bind/set` 四种；新增模板/皮肤不新增 kind。
- `operations` 之外的字段/语义由 SDK 校验；Rust 不解释 `target` 的领域含义，只做路径存在性与类型检查。
- `budgets` 是内容预算；Rust 保留硬上限并 clamp（描述符不能把上限调高）。

#### 5.1.2 单一来源与生成

| 产物 | 生产者 | 消费者 |
|---|---|---|
| `packages/agent-vitals-city-sdk/src/creatorCapabilities.ts` | SDK（人工维护） | 生成脚本、SDK 测试 |
| `assets/creator/capabilities.json` | `scripts/generate-creator-capabilities.mjs` | Rust `include_str!`、MCP `include_str!`、Studio（可选） |
| `assets/creator/templates/<id>.json` | 同上（由 SDK 模板定义导出） | Rust 创建项目、MCP 展示 |
| `packages/agent-vitals-city-sdk/src/creatorTemplates.ts` | SDK | City 活动、Studio、生成脚本 |

生成脚本用仓库现有 TS 加载方式：

```bash
node --experimental-transform-types \
  --import ./scripts/mecha-ts-register.mjs \
  scripts/generate-creator-capabilities.mjs --check
```

`--check` 模式字节比较，CI 与 `npm run generate:contracts` 同类；漂移即失败。

#### 5.1.3 Rust 加载与校验

新增 `apps/desktop/src-tauri/src/creator/capabilities.rs`（或 `creator_capabilities.rs`）：

- `load() -> &'static Descriptor`：`OnceLock` + `include_str!("../../../../assets/creator/capabilities.json")`。
- `validate_descriptor(&Value) -> Result<Descriptor, DescriptorError>`：
  - `schemaVersion == 1`
  - `capabilityVersion`：`[A-Za-z0-9._:-]{1,64}`
  - 操作/模板/皮肤条目数 ≤ 64/32/32，ID 唯一且合法
  - `kind` ∈ `{upsert, remove, bind, set}`（`bind/set` 的 target 必须存在）
  - 预算 ≤ Rust 硬上限（`MAX_GAME_BYTES` 等），否则加载失败
- 加载失败的行为：**fail closed**——内容写入请求返回 `creator_capabilities_invalid`，只读工具仍可用；启动时测试断言内置 JSON 合法（避免运行期崩溃）。
- `creator.capabilities.list` 直接投影描述符，不经过 Studio（解决 §3.4-5）。

#### 5.1.4 模板与皮肤

- 创建项目：`create_project_internal` 从 `assets/creator/templates/<id>.json` 读取 pack，校验 `template` 在描述符内；把 `templateVersion`/`capabilityVersion` 写入项目文档。
- `skin.select`：校验 ID 在描述符 `content.skins`；应用为通用 `set`（不再有 `matches!` 字面量）。
- 删除：`game_template`、`valid_skin_id`、`creator_capabilities` 里的字面量。

> 注：皮肤目录目前住在 `agent-city/ui/src/engine/cityWorldProfile.ts`，不在 city-sdk。P1 需要把 `BUILTIN_CITY_SKINS_V1` 上移到 city-sdk（或由 SDK 重新导出），否则“SDK 声明”仍缺主。

### 5.2 校验分层

| 检查 | 归属 | 说明 |
|---|---|---|
| JSON 大小/深度/数量 | Rust | 描述符预算 + 硬上限 |
| ID 形状/唯一性 | Rust | 存储完整性 |
| 数值有限、范围 | Rust | 安全 |
| 字段白名单 | Rust | 描述符 `fields`（可选） |
| 引用 ID 形状 | Rust | 不判断“该引用是否可达” |
| 游戏 DSL 语义 | SDK | slots/events/guards/actions |
| 场景对象 kind/字段语义 | SDK | 与 City 渲染一致 |
| 挂载拓扑/可达性 | SDK | 与 `validateMount` 同源 |
| 皮肤兼容性 | SDK | geography/theme |
| 资产字节/摘要/GLB | Rust | 磁盘事实 |
| revision/幂等/preview 绑定 | Rust | 事务 |

**提交流程（目标态）**

```
MCP creator_scene_preview
  → 宿主投递到 Studio
  → Studio：city-sdk 校验 + 计算语义 diff
  → Studio：creatorRequest("creator.scene.preview", {…, validation})
  → 宿主：
       1) 描述符/结构/预算校验（失败即拒绝）
       2) 通用应用 operations，得到候选文档 + 摘要
       3) 存 Preview{ document, operationHash, semanticOk, validationDigest, capabilityVersion }
       4) 返回 previewId、diagnostics、changedObjects
  → Studio 回传结果 → MCP
```

`validation` 信封：

```json
{
  "capabilityVersion": "2026-11-12.1",
  "validatorVersion": 1,
  "ok": false,
  "diagnostics": [{"code": "anchor_unreachable", "severity": "error", "path": "bindings.points", "objectId": "road-checkpoint:bc", "message": "..."}],
  "diff": {"changedObjects": [{"id": "villa.01", "path": "scene.objects.villa.01", "kind": "sceneObject", "action": "added"}]}
}
```

约束：

- `diagnostics` ≤ 200 条、`diff.changedObjects` ≤ 500 条、信封 ≤ 32 KiB；超出则截断并置 `truncated: true`。
- `semanticOk=false` 的 preview 仍返回 `previewId` 与诊断，但 commit 返回 `creator_preview_invalid` + 诊断摘要（让 Agent 能改）。
- commit 不重新跑语义校验，只复核结构/预算/版本，并消费 `semanticOk=true` 的 preview。
- 响应中的 `changedObjects` 优先用 SDK 的 diff；缺失/被截断时 Rust 用通用规则（描述符 target + 存在性）兜底。diff 只用于展示，不参与提交判定。

**信任模型**：Studio 是官方可信插件，因此接受其 validation 结论；但这只是内容语义的信任，不是安全边界。Rust 的结构/预算/字节/revision 检查不可省略。若未来出现第三方 Studio，必须换成签名描述符或独立校验进程。

### 5.3 `creator.scene.validate` 拆分

目标态由 Studio 合并三方结果：

1. Studio 调宿主内部只读方法 `creator.scene.structure_check`（结构 + 预算 + 资产字节/摘要）。
2. Studio 用 SDK 校验 game/scene/mount/可达性，生成 `static-schema` 诊断。
3. Studio 合并：SDK 项 + 结构项 + 资产项 + `unchecked`（drive/collision/visual），排序、截断。
4. 返回给 MCP。

这样 Rust 的 `validate_scene`（[:1773](apps/desktop/src-tauri/src/creator_projects.rs:1773)）缩成 `structure_check`，`validate_scene_object`/`validate_mount` 删除。`creator.scene.structure_check` 加入 `plugins.json localCalls`，MCP 工具表不暴露它。

### 5.4 MCP 薄层

| 现状 | 目标 |
|---|---|
| `template` enum 写死两个模板（[creator_studio.rs:40](crates/agent-vitals-mcp/src/mcp/creator_studio.rs:40)、[:233](crates/agent-vitals-mcp/src/mcp/creator_studio.rs:233)） | 改为 `string`，由宿主按描述符校验并返回 `creator_template_not_found` |
| 工具描述枚举 City 操作词表 | 指向 `creator_capabilities_list`，描述只讲语义与边界 |
| 48 KiB 预览上限（[:242](crates/agent-vitals-mcp/src/mcp/creator_studio.rs:242)） | 删除；宿主按通道/方法预算统一拒绝 |
| capabilities 经插件信箱 | 直接从编译进 MCP 的 `capabilities.json` 回答 |
| 入参类型严格校验（`optional_u64` 等） | 保留 |

MCP 仍负责：JSON-RPC 帧、`tool_specs` 的 `additionalProperties: false`、必填/类型、错误映射。它不再知道任何 City 模板/皮肤/操作细节。

### 5.5 传输预算统一（capture 案例）

当前 capture 有 **3 份预算**：

1. `CityEngine.captureFrame`：`dataUrl.length > 300_000` 返回 null（[CityEngine.ts:1162](apps/agent-city/ui/src/engine/CityEngine.ts:1162)）
2. MCP：`MAX_CAPTURE_ENCODED_CHARS = 350_000`（当前 `creator_studio.rs`）
3. 插件信箱：`MAX_CALL_BYTES = 64 * 1024`，且 `respond` 对**响应**同样限制（[plugin_calls.rs:9](crates/agent-vitals-query/src/query/plugin_calls.rs:9)、[:130](crates/agent-vitals-query/src/query/plugin_calls.rs:130)）

结果：帧稍大就会在 `respond` 被拒，状态停在 `claimed`，MCP 等到超时并报 `plugin_unavailable`（“打开 Studio 重试”），三份预算谁都没说对。

目标：

- 在插件描述符声明**按方法的响应预算**，默认 64 KiB，上限 1 MiB：

```json
"localCallResponseBudgets": {
  "creator.scene.capture": 524288
}
```

- `plugin_calls::respond` 接受宿主传入的预算（硬上限 clamp），超限返回 `plugin_call_too_large`。
- MCP 不再自建 capture 预算，只映射错误；UI 只做质量/尺寸自适应，最终预算由宿主判定，不再在 UI 里维护第二个硬编码上限。
- 错误语义：超预算 → `creator_capture_budget_exceeded`（可诊断），不再伪装成 unavailable。

### 5.6 版本与兼容

- `schemaVersion`：描述符结构主版本；Rust 只认 1，未知主版本 fail closed。
- `capabilityVersion`：内容版本（日期+序号），写入 preview/operation/release；版本不匹配的 preview 不可 commit。
- Studio 打开时读取 capabilities 并协商；不匹配返回 `creator_capability_version_mismatch`。
- 迁移期：宿主 flag `requireSdkValidation`（默认 P2 关闭、P2 收尾开启）；关闭时 preview 标记 `validation: "legacy"`，审计可见。
- 数据库迁移：`creator_operations` 增加 `capability_version TEXT NOT NULL DEFAULT ''`；`creator_projects`/releases 文档内已有字段则随文档走。迁移测试覆盖旧库。

---

## 6. 改造清单

### 6.1 新增

| 文件 | 内容 |
|---|---|
| `packages/agent-vitals-city-sdk/src/creatorCapabilities.ts` | 描述符类型 + 常量（operations/content/budgets） |
| `packages/agent-vitals-city-sdk/src/creatorTemplates.ts` | 静态模板 pack（从 City 活动抽出） |
| `scripts/generate-creator-capabilities.mjs` | 生成 `assets/creator/*`，支持 `--check` |
| `assets/creator/capabilities.json` | 构建期生成，入库 |
| `assets/creator/templates/*.json` | 构建期生成，入库 |
| `apps/desktop/src-tauri/src/creator_capabilities.rs` | 描述符加载/校验/查询 |
| `fixtures/creator/*.json` | 对等语料（game/scene/mount/patch） |
| `packages/agent-vitals-city-sdk/tests/creator-conformance.test.ts` | SDK 侧语料断言 |
| `apps/desktop/src-tauri/tests/creator_conformance.rs` | Rust 结构侧语料断言（P0 阶段含语义对等） |

### 6.2 修改

| 文件 | 改动 |
|---|---|
| `creator_projects.rs` | 删除 `game_template`、`validate_game`、`validate_scene_object`、`validate_mount` 的语义部分、`valid_skin_id`；`apply_scene_operations` 改为 kind 驱动；`preview_*` 接收 validation 信封；`Preview` 增 `semantic_ok/validation_digest/capability_version`；`commit_preview_as` 增加闸门；`validate_scene` 缩为 `structure_check`；`creator_capabilities` 改为描述符投影 |
| `plugin_host.rs` | `PluginDefinition` 增加 `localCallResponseBudgets`（无 `deny_unknown_fields`，漏改会静默忽略）；`respond` 传预算；启动校验预算表 |
| `plugin_calls.rs` | `respond(home, …, max_bytes)`；默认/硬上限常量 |
| `creator_studio.rs` | 删 `template` enum 与 48 KiB 上限；capabilities 直接读嵌入 JSON；capture 只做响应信封；错误映射补新码 |
| `mod.rs` | 路由新增内部方法（不新增 MCP 工具） |
| `plugins.json` | `localCallResponseBudgets`；`creator.scene.structure_check` 加入 `localCalls` |
| `creator-studio/ui/main.tsx` | preview 前跑 SDK 校验并附 validation；`creator.scene.validate` 改为 Studio 合并；capabilities 展示 |
| `agent-city/ui/src/engine/cityWorldProfile.ts` | 皮肤目录改由 city-sdk 导出（或生成） |
| `agent-city/ui/src/game/activity/checkpointRace.ts` | 模板 pack 改用 `creatorTemplates.ts` |
| `docs/AGENT_CREATOR_AGENT_INTEGRATION_CODE_DESIGN_2026_11_12.md` | §4 职责表、§6.4 状态、§11 验收更新 |
| `docs/AGENT_CREATOR_MCP_CLIENT_SETUP.md` | 工具数、预算、capabilities 参数 |

### 6.3 删除/降级

- `game_template`、`validate_game`、`validate_scene_object`、`validate_mount`、`valid_skin_id`、`creator_capabilities` 手写目录。
- MCP `template` enum、MCP 48 KiB 上限、MCP capture 预算常量。
- `Preview.kind/summary` 这类未使用字段不再新增。

---

## 7. 分阶段实施

### P0：护栏与单一来源（不改变行为）

**范围**

1. 生成脚本 + `assets/creator/capabilities.json`（先只含 operations/content/budgets，不接消费方）。
2. 对等语料 `fixtures/creator/` 与两侧测试；先钉住**当前**两套实现的一致/不一致。
3. 预算对账：把 `maxGameBytes`、preview 48 KiB、capture 三份预算写成一张表并修正文档/常量。
4. 传输预算机制（`respond` 带预算）与 capture 错误语义。

**退出条件**

- CI 有 `--check` 生成物锁步。
- 语料在 TS 与 Rust 两侧跑通；已知差异被显式标注（xfail 列表）。
- capture 大帧返回 `creator_capture_budget_exceeded`，不再超时。

**回滚**：全部为新增/独立改动，可单独回退。

### P1：去硬编码

**范围**

1. Rust 加载描述符；`creator.capabilities.list` 由描述符投影，且不需要 Studio。
2. 模板/皮肤从生成资产读取；删除三处 Rust 字面量；皮肤目录上移到 city-sdk。
3. MCP `template` 去枚举；删 MCP 48 KiB 上限。
4. 守卫测试：Rust 源码不得出现模板/皮肤字面量。

**退出条件**

- 新增一种皮肤的 PR 只改 SDK 内容 + 生成资产（附演示）。
- `grep` 守卫通过。
- 全部现有测试 + 新锁步测试通过。

**回滚**：保留旧路径到 P2（描述符未命中时回退旧表），但默认走新路径。

### P2：搬运语义

**范围**

1. Studio 在 preview/validate 前调用 SDK，构造 validation 信封。
2. `Preview` 记录 `semantic_ok/validation_digest/capability_version`；commit 闸门。
3. `validate` 改为 Studio 合并（SDK + 结构 + 资产）。
4. 删除 Rust 的 game/scene/mount 语义校验；`apply_scene_operations` 只保留 kind 驱动。
5. 数据库迁移与版本协商；`requireSdkValidation` 默认开启。

**退出条件**

- 语料中所有语义拒绝只由 SDK 产生；Rust 结构侧不再拒绝合法内容。
- 现有测试（desktop 342+、mcp 77+）与新增测试通过；手动端到端（Studio 预览→commit）通过。
- 旧库迁移测试通过。

**回滚**：`requireSdkValidation=false` + 保留旧校验函数一个版本；不删代码直到 P3。

### P3：表驱动收尾

**范围**

1. `dispatch_as` 的每个工具参数解析抽成声明式表单（字段名/类型/默认值），减少 match 分支。
2. 删除过渡期旧校验与 flag。
3. 文档/验收更新。

**退出条件**

- 新增操作只改描述符 + SDK；Rust `match` 不再按内容增长。
- 全量测试与 clippy 双工作区通过。

---

## 8. 测试与守卫

| 测试 | 位置 | 断言 |
|---|---|---|
| 生成物锁步 | `scripts/generate-creator-capabilities.mjs --check` | `assets/creator/*` 与 SDK 源字节一致 |
| 描述符形状 | Rust 单测 | 非法 ID/超预算/未知 kind/重复项被拒 |
| 对等语料 | `fixtures/creator/*` + TS/Rust 测试 | 同一输入两实现结论一致（P0）；P2 后语义只归 SDK |
| 字面量守卫 | Rust 测试读 `include_str!("creator_projects.rs")` | 不含 `"miami-vice"`、`"checkpoint-race"`、`"zone.entered"` 等内容字面量 |
| 版本协商 | Rust 单测 | preview 的 capabilityVersion 与当前不符 → commit 拒绝 |
| 迁移 | Rust 单测 | 旧 `creator_operations` 表升级后读写正常 |
| 传输预算 | `plugin_calls` 单测 | 超预算 `respond` 返回 `plugin_call_too_large`，不会超时 |
| 能力可用性 | MCP 单测 | Studio 未开时 `creator_capabilities_list` 仍返回 schemaVersion 1 |
| capture 信封 | MCP 单测 | dataUrl 不进 structuredContent；超预算返回专用码 |
| 端到端冒烟 | 手工/脚本 | Studio 预览→commit→revision 前进；无效预览被 commit 拒绝 |

CI 需要跑：根 workspace `cargo test` + clippy、`apps/desktop/src-tauri` `cargo test`、city-sdk `npm test`、creator-studio `npm run typecheck`、生成物 `--check`。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 削弱权威：SDK 说 ok 就放行 | 高 | Rust 结构/预算/字节/revision 永远独立校验；SDK 只影响 `semantic_ok` |
| Studio 被篡改/伪造 validation | 中 | 官方插件+实例绑定；未来第三方 Studio 需签名描述符或独立校验进程 |
| 版本偏斜（旧 Studio/新宿主） | 中 | capabilityVersion 协商 + `requireSdkValidation` 灰度 + 明确错误码 |
| 语义校验搬到 Studio 增加延迟 | 低 | preview 本来就走 Studio；validate 结果按 revision 缓存 |
| 诊断顺序/文案不稳定 | 中 | SDK 诊断排序规范 + 快照测试 |
| 迁移期两套路径并存 | 中 | 限定一个版本内删除旧路径；守卫测试防回潮 |
| 描述符生成链复杂 | 低 | 复用 `generate-app-contracts` 模式；`--check` 进 CI |
| 删除 Rust 校验后旧库脏数据 | 中 | 读取时结构校验 + `creator.scene.validate` 可诊断；不自动修复 |

---

## 10. 验收标准（DoD）

- [ ] `assets/creator/capabilities.json` 由 SDK 生成，`--check` 在 CI 通过。
- [ ] 新增皮肤/模板的演示 PR **不修改 Rust**（守卫测试通过）。
- [ ] `creator_capabilities_list` 在 Studio 关闭时可用。
- [ ] 语义非法内容：preview 返回带 code/path 的诊断，commit 拒绝；合法内容端到端通过。
- [ ] 每次 commit 记录 `capabilityVersion`，可由 `creator_operations`/审计读到。
- [ ] 预算只有两处：内容（描述符，Rust clamp）、传输（插件描述符，宿主执行）；MCP 无自建上限。
- [ ] capture 超预算返回 `creator_capture_budget_exceeded`，不再超时/伪装 unavailable。
- [ ] 根 workspace 与 desktop workspace 的测试、clippy、两套 UI typecheck/build 全绿。
- [ ] 设计文档 §4/§6.4/§11 与接入指南同步更新。

---

## 11. 工作量估算

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 | 生成链、语料、预算对账、传输预算 | 4–6 人日 |
| P1 | 描述符消费、去硬编码、MCP 清理 | 4–6 人日 |
| P2 | SDK 校验接入、commit 闸门、删语义校验、迁移 | 7–10 人日 |
| P3 | 表驱动、清旧路径、文档 | 2–4 人日 |
| 合计 | | **17–26 人日**（不含评审与真机验证） |

估算假设：一名熟悉该链路的工程师；P2 的主要不确定性在 Studio 与宿主之间的 validation 信封、旧库迁移和端到端验证。

---

## 12. 附录

### A. 新增错误码

| 码 | 场景 | MCP 映射 |
|---|---|---|
| `creator_capabilities_invalid` | 内置描述符非法 | `data_unavailable` |
| `creator_capability_version_mismatch` | preview/Studio 与当前描述符不符 | `revision_conflict` 或 `invalid_argument` |
| `creator_validation_required` | preview 缺 validation 信封 | `invalid_argument` |
| `creator_preview_invalid` | preview 语义未通过却尝试 commit | `invalid_argument` + 诊断摘要 |
| `creator_structure_invalid` | 结构/预算失败 | `invalid_argument` |
| `creator_capture_budget_exceeded` | 帧超传输预算 | `invalid_argument` |

### B. 旧函数 → 新归属

| 旧函数 | 新归属 | 动作 |
|---|---|---|
| `game_template` | `assets/creator/templates/*` + SDK | 删除 |
| `validate_game` | SDK `validateMiniGamePack` | 删除 |
| `validate_scene_object` | SDK `validateSceneDraft` | 删除 |
| `validate_mount` | SDK `validateMount` | 删除 |
| `validate_city_patch` | SDK/City planPatch 校验 | 保留结构上限，语义移走 |
| `apply_scene_operations` | Rust 通用 kind 应用 | 保留，去语义 |
| `validate_scene` | Rust `structure_check` + Studio 合并 | 拆分 |
| `creator_capabilities` | 描述符投影 | 重写 |
| `describe_scene` / `inspect_scene_object` | Rust 只读投影 | 保留 |
| 试玩生命周期 | Rust | 保留 |

### C. 皮肤字面量清单（P1 删除目标）

`creator_projects.rs:90`、`:812`、`:1170`、`:1707`；`CityEngine.ts:64/724`；`cityWorldProfile.ts:57`；`loadCreatorExperiences.ts:36/93`；`CityExperience.tsx:609`；`creator-studio/ui/main.tsx:55/83`。

### D. 开放问题

1. 描述符放 `assets/` 还是 `plugins.json`？本文建议 `assets/`（跨 Rust/MCP/TS，复用 `include_str!` 先例）；`plugins.json` 只放传输预算等宿主策略。
2. 模板 pack 是否允许用户在运行时安装/覆盖？MVP 只支持内置；运行时内容包需要独立的签名与注册机制，另立设计。
3. 是否引入 JSON Schema 库？本文建议**不引入**，用字段级描述符 + 通用检查；完整 schema 引擎会引入依赖与攻击面，且语义本来归 SDK。
4. Rust 是否需要保存 SDK 诊断原文？建议只保存摘要/摘要哈希，完整诊断随 preview 返回并受大小限制，避免审计面膨胀。
5. `creator.scene.validate` 是否允许在 Studio 未开时返回结构+资产结果？建议返回明确 `plugin_unavailable`，避免“半个校验”被误读为通过。
