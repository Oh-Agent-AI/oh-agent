# 官方 Miami 内容迁移基线（规范 §7.2 第 1–2 步）

日期：2026-11-15。对应规范：[City 项目目录与内容交付规范 §7](../../../../../docs/CITY_PROJECT_DIRECTORY_SPEC_2026_11_14.md)。
本文件记录迁移第 1 步「盘点基线」与第 2 步「并行建立内容源码」；第 3–5 步（运行接入和隔离、
真实用户升级验证、切换构建权威）未开始，不得因本目录存在而声称迁移完成。

## 1. 盘点基线（第 1 步）

### 源码与构建

| 项 | 值 | 位置 |
|---|---|---|
| 官方应用 | Agent City WebView + 引擎 + 玩法运行时 | `apps/agent-city/ui`（另有 `mcp/`、`relay/`） |
| 世界配方权威 | `MIAMI_CITY_WORLD_V1`（`miami-islands` v1） | `apps/agent-city/ui/src/engine/cityWorldProfile.ts` |
| 海湾地理参数 | `MIAMI_COASTAL`（`miami-coastal` 配方 v3） | `apps/agent-city/ui/src/engine/citySeaside.ts` |
| 生成器版本 | `CITY_GENERATOR_VERSION = 7` | `apps/agent-city/ui/src/engine/generatorVersion.ts` |
| 发行默认 seed | **74031**（`CityExperience` 初始值；用户偏好可覆盖——不把用户当前值当官方默认） | `apps/agent-city/ui/src/CityExperience.tsx` |
| 皮肤目录 | `miami-vice`（themeId `miami`）、`desert-evening`（themeId `desert`） | `BUILTIN_CITY_SKINS_V1` + SDK 描述符锁步测试 |
| SDK 内容模板 | `init --generator coastal-islands-v1` → `miami-islands` 配方 | `packages/agent-vitals-city-sdk/bin/oh-agent-sdk.mjs` |

### 资源与数据归属（规范 §7.1 边界）

| 层 | 内容 | 说明 |
|---|---|---|
| 世界配方（已 v2 化） | `world/world.json`（本目录） | 与应用权威逐字段一致，由对照测试钉住 |
| 应用代码生成/加载资源 | 沙滩带/步道/酒店线、路网与地标、停放机甲（骨骼 GLB 延迟升级）、植被与市政设施 | 代码生成或动画/蒙皮资源，不在静态 GLB v2 子集内，不能进 world 包 |
| 官方玩法 | checkpoint-race、区域寻宝等应用内模板；运行时绑定布局锚点 | v2 game 包未实现 |
| 会话楼/动态高度/统计 | descriptor 授权 typed DTO + 可信 City TS 适配器生成 | 用户实例层，永不进入 world 包 |
| 用户本机数据 | seed/皮肤偏好、城市补丁、会话建筑移动、书签、玩法存档 | 本机实例层；迁移需版本化适配与回滚（第 3–4 步门槛） |

## 2. 并行内容源码与对照（第 2 步）

- 本目录由 `oh-agent-sdk init city-project --generator coastal-islands-v1` 生成，不替换任何现有权威。
- 对照测试 `apps/agent-city/ui/tests/miami-content-source.test.ts` 钉住：
  1. `world/world.json` 与 `MIAMI_CITY_WORLD_V1` 深度一致；
  2. 通过 SDK `validateCityWorldProfile` 内容契约；
  3. 内置 ID 经自定义导入路径被正确拒绝（`world_profile_reserved_id`）——官方内容只能
     走内置权威，不能被用户导入覆盖；
  4. `CITY_GENERATOR_VERSION === 6` 与本基线一致——生成器有意变更时必须重新核对本目录并更新基线。
- 固定合成输入的布局对比由既有生成器基线（`scripts/verify-city-baseline.mjs`，版本 7）覆盖，
  本目录不重复生成。

## 3. 缺口登记（规范要求：不能悄然丢弃）

1. **应用代码生成资源不可 v2 化**：机甲骨骼 GLB、程序化地标/植被等在静态 GLB 子集之外；
   须先明确资源归属与运行支持，再决定转换或保留为应用资源（§7.1）。
2. **v2 game 包缺失**：官方玩法无法作为内容包表达；`games/` 目录暂无内容项目。
3. **宿主内置/安装内容统一身份与 digest 解析未实现**：第 3 步门槛，未开始。
4. **用户 Miami 本机数据的版本化迁移未实现**：旧补丁/偏好/会话建筑移动的适配与回滚（第 3–4 步门槛）。
5. **导出目录 `games/game/` 与本规范 `games/<game-id>/` 命名未统一**（Studio 导出侧单挂载约束）。
6. **物理仓库路径决策**：本次把内容源码定在 `apps/agent-city/worlds/miami/`（§7 示意位置）；
   仓库拆分与 `runtime/` 重组待发行规格实施时另行决定。

## 4. 门槛状态

| §7.2 步骤 | 状态 |
|---|---|
| 1 盘点基线 | ✅ 本文件 |
| 2 并行建立内容源码 + 对照 | ✅ 本目录 + 对照测试 |
| 3 运行接入和隔离 | ❌ 未开始 |
| 4 真实用户升级验证 | ❌ 未开始（需真机与隔离测试数据） |
| 5 切换构建权威 | ❌ 未开始（官方 bundle 仍消费应用内常量） |
