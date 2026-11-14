# Creator 边界收口记录

日期：2026-11-14  
状态：已实施并验证（本文记录 2026-11-14 的收口改动）  
关联：[Rust/City 边界优化方案](AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION_2026_11_12.md)、[Creator MCP 接入指南](AGENT_CREATOR_MCP_CLIENT_SETUP.md)、[自定义 City MCP 设计](CREATOR_STUDIO_CUSTOM_CITY_MCP_DESIGN_2026_11_14.md)

## 1. 背景

2026-11-12 的边界方案把 City 语义校验从 Rust 搬到 city-sdk，并定义了“描述符驱动 + 生成资产 + validation 信封 + 表驱动分发”的目标形态。到 11-13 主体实现完成，但 §10 的 DoD 仍有四项未满足：

1. `creator_capabilities_list` 仍要 Studio 打开；
2. 新增模板仍要在 Rust 注册表加一行；
3. capture 的编码预算与错误码仍互相矛盾；
4. 皮肤/模板目录与 City 渲染目录没有锁步守卫。

本轮关闭 1–4，并同步文档；独立 City 草稿（`creator_city_*`）作为实验性能力单独标注。

## 2. 改动

### 2.1 能力目录改为描述符投影

- `packages/agent-vitals-city-sdk/src/creatorCapabilities.ts` 新增 `CREATOR_LIMITS_V1` 与
  `CREATOR_CAPABILITIES_PROJECTION_V1`（categories / preview），并把它作为描述符的
  `capabilities` 段；`capabilityVersion` 升到 `2026-11-12.2`。
- 宿主 `creator_capabilities()` 不再自己拼 `MAX_*`，直接返回描述符的 `capabilities` 段。
- MCP `creator_capabilities_list` 不再走插件信箱：直接读 `include_str!` 的同一份
  `assets/creator/capabilities.json`，本地完成 category 过滤与 schemaVersion 校验。
  Studio 关闭时可用；错误码与宿主一致（`invalid_argument`）。
- 守卫：`creator_descriptor_stays_within_rust_hard_caps` 增加逐项断言
  （maxGameBytes/objects/colliders、mount、cityPatch、assets、playtest、project、
  preview TTL/maxActive、skins/templates），防止 SDK 改数字后能力发现虚报。

### 2.2 模板索引去掉 Rust 注册表

- 生成器新增 `assets/creator/templates-index.json`（`{schemaVersion,templates:[{id,label,pack}]}`），
  由 city-sdk 的 `CREATOR_TEMPLATES_V1` 一次导出。
- Rust 删除 `CREATOR_TEMPLATE_JSON` 逐模板 `include_str!` 注册表，改为读取索引；
  `game_template` / `template_label` 从索引查找。
- 新增模板现在只需要改 SDK 常量 + 重新生成资产；不再手工编辑 Rust。
- 守卫 `creator_template_registry_covers_descriptor_and_preserves_checked_invariants`
  改为校验描述符顺序 = 索引顺序、label 非空、pack 通过 `structural_game_check`，
  并保留 checkpoint-race 的完成条件不变量。

### 2.3 capture 预算与错误语义

- `CityEngine.captureFrame` 返回可区分结果：
  `{ok:true,...}` / `{ok:false,code:"creator_capture_unavailable"|"creator_capture_budget_exceeded"}`。
  视口不可用（headless/contextLost/disposed）不再被误报为超预算。
- 默认编码预算从 44K 字符提升到 **330K 字符**：插件描述符给 `creator.scene.capture`
  的 mailbox 响应预算是 512 KiB，MCP 侧帧安全上限是 350K 字符，330K 留出 JSON 信封余量。
- Studio 的 project capture 与 city capture 两处都按 `frame.code` 抛错；删除“64 KiB 邮箱”
  的过期注释。

### 2.4 皮肤目录锁步

- 新增 `apps/agent-city/ui/tests/skin-catalog-parity.test.ts`：断言
  `CREATOR_CAPABILITIES_V1.content.skins` 与 `BUILTIN_CITY_SKINS_V1` 的 ID、顺序完全一致。
- **未做**把 `BUILTIN_CITY_SKINS_V1` 物理上移到 city-sdk：City 渲染器依赖完整 skin pack
  （visuals/renderContract），移动会牵动 City UI 初始化路径与测试；先用锁步测试消除
  “静默分叉”，单一来源化留作后续重构（见 §5）。

### 2.5 文档同步

- `AGENT_CREATOR_MCP_CLIENT_SETUP.md`：工具面 18 → **29**（18 项目 + 11 个
  `creator_city_*` 实验工具），写开关 5 → 8，新增 City 工具表与实验边界说明。
- `CREATOR_STUDIO_CUSTOM_CITY_MCP_DESIGN_2026_11_14.md`：在目标契约表前加入
  2026-11-14 实现状态，明确 `creator_city_open`、`operation_status`、
  按 `operations[]` 编辑、绑定/发布/隔离均未实现。
- `fixtures/creator/README.md`：删除对已移除的 `validate_game`/`validate_mount` 的
  “Rust 侧断言”描述，明确 P2 后 `expectTs` 是唯一可执行期望、`rustNote` 仅为历史。
- 边界方案 §10 DoD 逐项勾选并标注延期项。

## 3. 验证

| 检查 | 命令 | 结果 |
|---|---|---|
| 生成物锁步 | `node --experimental-transform-types scripts/generate-creator-capabilities.mjs --check` | 4 个文件通过 |
| desktop | `cargo test`（apps/desktop/src-tauri） | **358 passed** |
| MCP | `cargo test -p agent-vitals-mcp` | **82 passed** |
| city-sdk | `npm test` | **94 passed** |
| Studio | `npm test` / `npm run typecheck` | **10 passed** / 通过 |
| 皮肤锁步 | `node ... --test tests/skin-catalog-parity.test.ts` | **1 passed** |
| clippy desktop | `cargo clippy --all-targets -- -D warnings` | 通过 |
| clippy MCP | `cargo clippy -p agent-vitals-mcp --all-targets -- -D warnings` | 通过 |

未跑：`vite build`（两套 UI）、Tauri `.app` 真机、clippy 根 workspace 的其它 crate。
本轮改动未触碰这些路径的构建配置；发布前仍应重跑。

## 4. 预算分层（本轮定稿）

| 边界 | 值 | 责任与守卫 |
|---|---|---|
| 内容预算 | descriptor `budgets.*` | Rust 硬上限 clamp；`creator_descriptor_stays_within_rust_hard_caps` |
| 插件 mailbox 请求 | preview 384 KiB；capture 请求 8 KiB | `plugins.json localCallBudgets`；host 校验并执行 |
| 插件 mailbox 响应 | capture 512 KiB；read_chunk 48 KiB；preview 64 KiB | 同上 |
| MCP 帧安全上限 | capture 350K 字符 | MCP 自有内存/帧保护，不是业务预算 |
| 视口编码预算 | 330K 字符 | CityEngine 默认值，落在 mailbox 与 MCP 上限之内 |

这些数字分属不同边界，不合并成单一常量；任何一层变化都必须重新核对上下界，
并由对应的守卫测试/描述符校验阻止越界。

## 5. 仍延期的事项

1. **皮肤目录单一来源**：当前是“SDK 描述符 ID + City UI 完整 pack + 锁步测试”。
   后续把 `BUILTIN_CITY_SKINS_V1` 移入 city-sdk，City UI 改为 re-export。
2. **Rust 语义对照语料**：P2 后 Rust 不再做语义判定，不存在“两侧语义一致”的断言；
   结构侧由 Rust 单元测试覆盖。若未来重新引入 Rust 语义校验，必须同时恢复
   `fixtures/creator` 的 Rust 侧执行。
3. **独立 City**：`creator_city_open`/`operation_status`/`operations[]` 编辑、
   项目绑定/发布、旧迈阿密迁移、城市隔离、只读视口桌面验收均未完成（见自定义
   City 设计文档状态段）。
4. **构建验证**：两套 UI 的 `vite build` 与 Tauri bundle 未在本轮重跑。

## 6. 后续建议

1. 为独立 City 先做“项目绑定”的最小闭环（cityId 贯穿 project/mount/release），
   再谈 `creator_city_open` 与迁移；否则新工具无法产生可玩内容。
2. 把 `BUILTIN_CITY_SKINS_V1` 上移 SDK 时，同时给 skin pack 增加
   `creatorSelectable: true|false`，避免“能渲染但不应被 Agent 选择”的目录混用。
3. 在 CI 增加本文件 §3 的命令组合（生成物 check + 三套测试 + 两个 clippy），
   防止下一轮再次出现“已实现但 DoD 未验证”。
