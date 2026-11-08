# Oh Agent Creator & Community Store — 产品设计

- 状态：建议稿（未实施）
- 日期：2026-11-09
- 范围：创作者工具、体验包、社区商店、授权与审核
- 关联：
  - `CITY_ACTIVITY_PLATFORM_ARCH_2026_11_07.md`
  - `AGENT_CITY_DREAM_CITY_DESIGN_2026_11_08.md`
  - `AGENT_CITY_REMOTE_3D_PROPOSAL_2026_11_08.md`
  - `MECHA_MCP.md`

## 0. 摘要

Oh Agent 不应该先做一个“素材商店”。它应该先建立一个 **Experience（体验）平台**：
创作者用 Oh Agent Creator 做出可进入的城市、数据故事、角色体验；玩家在橱窗里预览、试玩、购买；
运行时由 Rust 内核托管，内容在受限能力内运行。

商店卖的是 **体验包 + 授权**，不是 DLL、不是任意 JS、不是零散模型。

第一版只做：

1. 官方精选体验（3–5 个）；
2. 数据包（城市风格 / 模型 / 场景 / 角色外观）；
3. 本地安装、签名校验、买断授权；
4. 不开放社区代码，不做推荐算法，不做自建支付。

## 1. 背景与问题

当前仓库里：

- `apps/desktop` 是 Tauri/Rust 宿主，`plugins.json` 把 City 作为插件加载；
- `apps/agent-city/ui` 是 React + Three.js 的 City App，包含城市世界、session 可视化和多个活动；
- `CITY_ACTIVITY_PLATFORM_ARCH` 提出 Host / Lease / Registry，但仍是建议稿；
- 没有内容目录、体验包、安装器、授权、商店、角色存档；
- 城市风格接近硬编码，主题没有 Registry；
- session 数据本地优先，没有“体验可读取哪些数据”的合同。

因此商店的难点不是 UI，而是：

- 没有统一的“体验”单位；
- 没有内容发布/安装/版本；
- 没有授权与支付；
- 没有社区代码的沙箱与审核；
- 没有数据 scope 的隐私合同。

## 2. 产品定位

一句话：

> **Oh Agent 是一个本地优先的体验平台：City World 是第一个世界，数据故事和角色是更多体验。**

三层定位：

| 层 | 产品 | 职责 |
|---|---|---|
| 平台 | Oh Agent | 宿主、数据、内容、商店、授权、安全、远程 |
| 世界 | City World | 可复用的城市/场景运行时与风格 |
| 体验 | Agent City / Data Story / Character | 玩家真正进入、游玩、付费的单位 |

非目标：

- 不做通用 3D 引擎；
- 不做 Roblox 规模；
- 不开放原生插件；
- 第一版不做开放 UGC 代码；
- 不做自建货币与收单；
- 不做社交网络/直播。

## 3. 用户与角色

| 角色 | 目标 | 关键动作 |
|---|---|---|
| 玩家 | 发现、试玩、购买、进入 | 浏览橱窗、试玩、购买、已购库、恢复购买 |
| 创作者 | 做出并发布体验 | 新建项目、预览、校验、打包、提交、更新 |
| 策展/审核 | 保证质量与安全 | 审核、分级、上架、下架、回滚 |
| 平台运营 | 商业化与生态 | 定价、分成、退款、活动、数据 |
| 平台工程 | 运行时与安全 | Host、Content、Entitlement、Sandbox |

## 4. 内容形态

| 形态 | 例子 | 执行代码 | 首发 |
|---|---|---|---|
| WorldStyle | 海岸 Miami、梦境城市、赛博城市 | 否（数据+资产） | 是 |
| Model Pack | 机甲皮肤、车辆、建筑、角色模型 | 否 | 是 |
| Scenario | 关卡、敌人波次、规则参数 | 否（Host 解释） | 第二阶段 |
| Data Story | 用 sessions 生成城市/关卡/剧情 | 否（SessionProjection） | 第二阶段 |
| Character | 角色、外观、成长线、剧情 | 否（Profile + 数据） | 第二阶段 |
| Activity Code | 社区自带逻辑的小游戏 | 是（WASM/Worker） | 最后 |

体验可以是组合：

```text
Experience = WorldStyle + Activity + DataAdapter + CharacterProfile + Assets
```

## 5. 核心流程

### 5.1 玩家

```text
打开 Explore
  → 看精选/分类/搜索
  → 体验详情页（封面、视频、时长、数据声明、评分）
  → 试玩（合成数据 / 官方 demo）
  → 购买或领取
  → 下载 → 校验 → 安装
  → 进入体验
  → 已购库 / 更新 / 退款 / 恢复购买
```

### 5.2 创作者

```text
安装 Oh Agent Creator
  → 新建项目（World / Data Story / Character）
  → 编辑场景/规则/数据映射
  → 本地预览（真实 Host，合成数据）
  → 校验（schema、性能、权限、资产、版权声明）
  → 打包 .oap
  → 提交审核
  → 上架 / 更新 / 回滚
```

### 5.3 策展/审核

```text
提交 → 自动检查 → 人工审核 → 分级 → 签名 → 上架
                  ↘ 拒绝/整改
```

## 6. 创作者工具

### 6.1 形态

建议双形态，共用同一套 schema 和校验器：

1. **Oh Agent Creator（桌面 App）**：可视化编辑器，面向非程序员；
2. **`oac` CLI**：面向程序员/CI，负责 `init / validate / preview / pack / submit`。

第一版可以只做 CLI + 本地预览，把 GUI 留给第二阶段。

### 6.2 项目结构

```text
my-experience/
  experience.json          # ExperienceManifest
  world/
    style.json             # WorldStyle
    layout.json            # 可选布局
  assets/
    models/ textures/ audio/
  activity/
    config.json            # 声明式活动或入口
  data/
    adapter.ts             # 仅受信任/沙箱体验
  profile/
    schema.json
  preview/
    cover.png trailer.mp4
  LICENSE-ASSETS.md
```

### 6.3 CLI

```bash
oac init --kind world
oac dev                 # 本地 Host + 热更新 + 合成数据
oac validate            # schema/资产/权限/性能/版权
oac preview --data synthetic
oac pack                # 生成 .oap（zip + manifest + hash）
oac submit              # 上传到 Creator Portal
oac status              # 审核/上架/版本
```

### 6.4 校验器必须检查

- `ExperienceManifest` schema；
- `engineRange` 兼容性；
- 资产 sha256、尺寸、格式、总大小；
- 贴图/模型/音频的授权声明；
- 活动权限（读哪些 Host API、是否申请网络）；
- 性能预算（draw calls、纹理内存、加载时间）；
- 数据 scope 是否与声明一致；
- 不允许的 API/网络/文件访问；
- 预览素材是否包含真实用户数据。

### 6.5 本地预览

- 用真实 Host + 真实 WorldStyle；
- 数据体验默认合成数据；
- 显示“如果上架，玩家会看到什么”；
- 支持 390×844 / 1280×800 两种布局；
- 预览失败不产生半安装状态。

## 7. 体验包合同

### 7.1 ExperienceManifest

```ts
type ExperienceManifest = {
  schema: "oh-agent-experience:v1";
  id: string;                 // creator.namespace/slug
  version: string;
  kind: "world" | "data-story" | "character" | "hybrid";
  title: { zh: string; en: string };
  description: { zh: string; en: string };
  engineRange: string;        // 兼容的 Host/City 版本
  world?: { styleId: string; layoutId?: string };
  activity?: { moduleId: string; mode: "declarative" | "sandbox" };
  data?: DataScope[];
  profile?: { schema: string; persistent: boolean };
  assets: AssetRef[];
  preview: { cover: string; screenshots: string[]; video?: string; demo?: string };
  permissions: Permission[];
  price: { currency: string; amount: number } | { free: true };
  creatorId: string;
  signature: string;
};
```

### 7.2 WorldStyle

```ts
type WorldStyle = {
  schema: "oh-agent-world-style:v1";
  id: string;
  layout: { generator: string; seed?: number; params: Record<string, unknown> };
  visuals: { sky: string; ground: string; materials: Record<string, string>; lighting: string };
  audio?: { ambient?: string; music?: string };
  activities: string[];
};
```

WorldStyle 必须能完整描述“为什么这座城市看起来不同”，而不是散落在 `CityEngine` 的 if/else 里。

### 7.3 Activity

```ts
type ActivityModule = {
  id: string;
  mode: "declarative" | "sandbox";
  entry?: string;             // sandbox only
  hostApi: string[];          // 申请的能力
  config?: unknown;
};
```

第一方活动与社区活动共用同一 Host 契约，但信任级别不同。

### 7.4 DataScope

```ts
type DataScope = {
  scope: "session.summary" | "session.timeline" | "aggregate";
  redaction: "summary" | "anonymous";
  mode: "local-only" | "aggregate-upload";
  purpose: string;            // 展示给用户
};
```

规则：

- 默认 `local-only`；
- 原始 prompt、路径、代码内容永远不进体验；
- 每个 scope 进入前单独确认；
- 预览/试玩只用合成数据；
- 用户可随时断开数据，退回 demo。

### 7.5 CharacterProfile

```ts
type CharacterProfile = {
  schema: "oh-agent-character:v1";
  characterId: string;
  owner: "local";
  appearance: Record<string, unknown>;
  progression: Record<string, unknown>;
  unlocked: string[];
  createdAt: number;
  updatedAt: number;
};
```

- 角色属于用户，不属于体验；
- 成长规则由体验声明，数值不售卖；
- 存档本地优先，云备份单独授权；
- 跨体验字段最小化，避免体验读到自己不需要的数据。

## 8. 商店 / 橱窗

### 8.1 信息架构

```text
Explore
├─ Featured（人工精选）
├─ Worlds（城市风格）
├─ Data Stories（数据体验）
├─ Characters（角色）
├─ Activities（玩法包）
├─ Owned（已购）
└─ Search
```

### 8.2 体验卡片

每张卡必须有：

- 封面/短视频；
- 一句话价值；
- 类型（World / Data Story / Character）；
- 预计时长；
- 数据声明（本地 / 需要哪些 scope）；
- 兼容性；
- 价格；
- 创作者；
- `试玩` / `进入`。

### 8.3 详情页

- Hero 预览；
- 截图/视频；
- “你将进入什么”；
- 数据使用说明；
- 已购/未购状态；
- 版本与更新日志；
- 评分/举报；
- 退款政策。

### 8.4 试玩

- 用合成数据/官方 demo；
- 限时 5–10 分钟；
- 不写真实存档；
- 不申请真实 session 权限；
- 试玩结束引导购买/领取。

### 8.5 已购库

- 安装状态、版本、更新；
- 恢复购买；
- 卸载；
- 退款入口；
- 离线可用标记。

## 9. 信任分级与审核

| 级别 | 内容 | 审核 | 运行时 |
|---|---|---|---|
| T0 | 主题/模型/场景数据 | 自动 + 抽查 | Host 解释 |
| T1 | 声明式活动 | 自动 + 人工 | Host 解释 |
| T2 | WASM/Worker 代码 | 自动 + 人工 + 签名 | 沙箱 |
| T3 | 原生插件 | 不允许社区 | — |

审核清单：

- 版权/资产授权；
- 数据 scope 与声明一致；
- 无网络/文件/宿主越权；
- 无真实用户数据；
- 内容分级；
- 性能预算；
- 崩溃/卡死风险。

## 10. 数据与隐私

这是 Oh Agent 的差异化，也是红线：

- sessions 原始数据默认不出本机；
- 体验只拿 `SessionProjection`；
- 商店服务端不接收 session 内容；
- 预览/试玩不读真实 sessions；
- 每个体验单独 consent；
- 用户可导出/删除本地数据；
- 商店账号与 session 数据分离。

建议在 UI 上直接写：

> “这个体验只读取你本机的聚合统计，不上传会话内容。”

## 11. 商业与授权

| 项 | 建议 |
|---|---|
| 支付 | 平台 IAP 或 Paddle/MoR，不自建收单 |
| 货币 | 不建虚拟币；直接标价 |
| 授权 | 签名收据 + 本地缓存 + 恢复购买 |
| 退款 | 平台规则，商店提供入口 |
| 分成 | 首发 70/30，具体以财务/法务为准 |
| 角色 | 外观/剧情/槽位可卖，数值不卖 |
| 订阅 | 第一阶段不做 |

授权检查在 Host 启动体验时执行，不在 UI 渲染层执行。

## 12. 架构映射

```text
Oh Agent Kernel (Rust)
├─ Host / Plugin lifecycle
├─ ContentManager (Catalog/Installer/Entitlement)
├─ Data Plane (sessions/projections)
├─ Sandbox Supervisor
├─ Remote Gateway
└─ ExperienceRegistry
        │ HostApi
        ▼
Experiences (Web/WASM)
├─ Agent City
│   ├─ City World (WorldStyle)
│   ├─ Mecha
│   ├─ Driving
│   └─ Flight
├─ Data Story
├─ Character
└─ Community (sandboxed)
```

原则：

- Rust 负责信任边界、持久化、安装、授权、支付、沙箱；
- TS 负责 UI、Three.js、玩法迭代；
- 社区代码只进 WASM/Worker；
- City 是 Experience，不是 Kernel。

## 13. 数据模型（本地）

```text
content.sqlite
├─ installs(pack_id, version, path, hash, status, installed_at)
├─ entitlements(pack_id, receipt, license, issued_at, expires_at)
├─ catalog_cache(listing_json, fetched_at)
└─ profiles(character_id, schema, json, updated_at)
```

不要把这些塞进 `plugin.state` 的大 JSON。

## 14. 路线图

### P0：平台地基（无商店）
- Activity Host / Lease / Router；
- WorldStyle Registry；
- Mecha 迁入 Host；
- 本地官方内容包安装（目录导入）。
- 验收：删除 CityApp 9 处互斥布尔；两个活动切换无相机/输入冲突。

### P1：官方精选橱窗
- ExperienceManifest / Registry；
- 3–5 个官方体验；
- 详情页、试玩、已购库；
- 无支付。
- 验收：从橱窗进入 World / Data Story / Character 各一次；试玩不读真实数据。

### P2：授权与付费
- 平台 IAP/MoR；
- 签名收据、恢复购买、退款入口；
- 隐私政策更新。
- 验收：购买→安装→离线启动→恢复购买全链路。

### P3：创作者工具
- `oac` CLI + 本地预览；
- 自动校验、打包、提交；
- 官方/受邀创作者数据包。
- 验收：创作者只改项目文件，不碰 Host 代码即可上架。

### P4：社区数据包
- Creator Portal、审核、上架/下架/回滚；
- 分成结算。
- 验收：一个社区 WorldStyle/Scenario 从提交到上架。

### P5：社区代码
- WASM/Worker 沙箱、权限、配额；
- 举报/DMCA/年龄分级；
- 邀请制。
- 验收：沙箱代码无法访问网络/文件/宿主 DOM。

## 15. 成功指标

- 创作者：创建→预览成功率、提交→上架时长、次周留存；
- 玩家：详情页→试玩率、试玩→购买率、退款率、崩溃率；
- 内容：体验平均时长、复用率、评分；
- 平台：审核成本/体验、授权恢复成功率、离线启动率；
- 隐私：数据 scope 同意率、拒绝后 demo 转化率。

## 16. 风险与非目标

风险：

- 社区代码安全（最大）；
- 内容版权/模型授权；
- 审核成本；
- 支付/税务/退款；
- 隐私政策冲突；
- 版本兼容与旧包失效；
- 性能预算。

非目标：

- 不做通用游戏引擎；
- 不开放原生插件；
- 不做自建支付；
- 不做推荐算法（内容少时人工策展）；
- 不做社交网络；
- 不卖数值。

## 17. 待决策

1. 账号体系：平台账号 / 匿名 license / 两者并存？
2. 支付：Mac App Store IAP 还是 Paddle？
3. 社区代码是否永远限制在 WASM？
4. 角色是否跨体验统一？
5. 分成比例与创作者 KYC 方案？
6. 旧包兼容承诺多久？

## 附录 A：最小 ExperienceManifest 示例

```json
{
  "schema": "oh-agent-experience:v1",
  "id": "official/dream-city",
  "version": "1.0.0",
  "kind": "world",
  "title": { "zh": "梦境城市", "en": "Dream City" },
  "description": { "zh": "漂浮岛与数据云构成的城市。", "en": "A city of floating islands and data clouds." },
  "engineRange": ">=1.5 <2",
  "world": { "styleId": "dream-city" },
  "data": [{ "scope": "aggregate", "redaction": "anonymous", "mode": "local-only", "purpose": "生成街区密度" }],
  "assets": [{ "path": "assets/sky.hdr", "sha256": "…", "bytes": 12345 }],
  "preview": { "cover": "preview/cover.png", "screenshots": ["preview/1.png"] },
  "permissions": ["host.snapshot", "host.lease", "host.hud"],
  "price": { "currency": "USD", "amount": 9.99 },
  "creatorId": "official",
  "signature": "…"
}
```

## 附录 B：Creator CLI 输出示例

```text
$ oac validate
✔ experience.json schema
✔ engineRange >=1.5 <2
✔ assets 14 files, 38.2 MB
✔ permissions: host.snapshot, host.lease, host.hud
✔ data scope: aggregate/local-only
✖ preview/cover.png missing
  → add preview/cover.png (1280×720)
```
