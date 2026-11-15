# City 世界多样化能力：SDK 契约与 MCP 调用（2026-11-15）

状态：设计提案，待实施与验收。本文定义世界参数能力目录、SDK 校验契约与 MCP 预览/提交调用，
不表示列出的参数或工具已经实现。所有新增参数默认值必须**逐位复现现有生成器行为**，
未显式设置的参数不改变任何既有世界的布局。

关联：[自定义 City MCP 设计](CREATOR_STUDIO_CUSTOM_CITY_MCP_DESIGN_2026_11_14.md)（`world.set`/`style.set`
目标契约、能力目录、失效语义）、现状边界实现 `apps/agent-city/ui/src/engine/planner/geography.ts`
（`buildAridDunesGeography`）、[资产管理规格](CITY_ASSET_MANAGEMENT_SPEC_2026_11_15.md)、
[边界收口记录 §4 预算分层](CREATOR_BOUNDARY_CLOSEOUT_2026_11_14.md)、
`apps/agent-city/ui/src/engine/generatorVersion.ts` 的版本递增规则。

## 1. 现状与根因

| 层 | 现状 |
|---|---|
| 用户可调参数 | arid 仅 3 个（`duneScale 96–600`、`duneAmplitude 1–36`、`orientationDeg ±180`），只影响沙丘纹理场 |
| 宏观形状 | arid 边界硬编码为圆形：`boundaryRadius = R·(1 + 0.035·fbm)`（planner/geography.ts）——任何 seed 都是「略不规则的圆」 |
| coastal 参数 | `MIAMI_COASTAL` 约 20 个参数冻结在代码里，profile 只接受已注册整体配置 |
| 编辑面 | `creator_city_edit_preview` 只做 name/seed/profile 配置替换，不接受 `operations[]` |
| 丰富性来源 | seed 空间 × 生成器（2 个）× 用户参数（3 个）× 皮肤（2 个） |

结论：丰富性瓶颈在「形状族 + 参数白名单」，不在 seed。

## 2. 变量分层与能力目录（SDK 契约）

变量按失效语义分两层，分别走 `world.set` 与 `style.set`：

### 2.1 `world.set` — 地理参数（layoutAffecting，产生新 worldRevision）

```ts
// city-sdk 新增：世界参数能力描述（生成链单一来源）
type WorldParameterDescriptorV1 = Readonly<{
  group: "shape" | "landform" | "water" | "vegetation" | "skeleton";
  id: string;                       // 组内参数 id，如 "shape.cores"
  kind: "number" | "integer" | "enum";
  range?: { min: number; max: number; step?: number };
  values?: readonly string[];       // enum
  default: number | string;         // 必须等于现行生成器行为
  unit?: string;
}>;

type WorldPresetV1 = Readonly<{
  id: string;                       // "disc" | "lobed" | "dumbbell" | "coastal" | ...
  label: string;
  parameters: Readonly<Record<string, number | string>>;   // 预设展开后的参数
}>;

// 能力投影新增段（进 creator_capabilities 生成链，Rust/MCP 只读生成产物）
worlds: {
  [generatorId: string]: {
    contractVersion: number;        // 参数 schema 版本；旧 profile 恒定有效
    parameters: readonly WorldParameterDescriptorV1[];
    presets: readonly WorldPresetV1[];
  };
};
```

首批参数（arid-dunes-v1，全部有界、seed 键控确定性）：

| group | id | 范围 | 默认（= 现行为） |
|---|---|---|---|
| shape | `shape.family` | `disc` \| `lobed` \| `dumbbell` \| `coastal` | `disc` |
| shape | `shape.cores` | 1–3 | 1 |
| shape | `shape.aspectRatio` | 1.0–1.8 | 1.0 |
| shape | `shape.corridorPull` | 0–0.4 | 0 |
| shape | `shape.coastFractal` | 0–0.25 | 0.035（现行值） |
| shape | `radiusClass` | `small` \| `medium` \| `large` | `medium`（现行校准） |
| landform | `landform.duneFrequency` | 0.5–2.0 | 1.0 |
| landform | `landform.ridgeSecondary` | 0–1 | 0 |
| water | `water.oasisCount` | 0–3 | 0 |
| vegetation | `vegetation.greenbeltWidth` | 0–80 m | 现行值 |
| skeleton | `skeleton.ringCount` | 1–3 | 现行值 |
| skeleton | `skeleton.blockScale` | 0.8–1.25 | 1.0 |

coastal-islands-v1 首批仅解冻已实现字段：`bayHalfWidth`、`bayShift`（`BayOptions` 已存在）。

### 2.2 `style.set` — 视觉参数（不影响布局，不改 worldRevision）

```ts
style: {
  timeOfDay: "dawn" | "noon" | "dusk" | "night";   // 默认 dusk（现行）
  fogDensity: 0–0.5;  dustIntensity: 0–0.5;
  floraDensity: 0.5–2.0;  floraTintShift: -30..30 deg;
  waterTint: string;                               // 受限色板
  themeVariant: string;                            // 已注册变体，如 "miami-neon"
}
```

皮肤兼容规则沿用自定义 City 设计：声明为不影响布局/碰撞的视觉参数不改变 worldRevision；
`visuals.themeId` 语义不变。

## 3. 形状算法（W1 的数学内核，供实现参考）

占地 = 可达性场的等值线（城市经济学：圆是交通各向同性的退化特例）：

```text
A(x) = max_s  w_s · exp(−d_s(x)·(1 − κ·cosⁿ(θ_s)) / λ_s)     // 多核心 + 走廊各向异性
footprint = morphologicalClosing({ A ≥ τ }, ρ)                 // 阈值 + 形态学平滑
τ 由二分求得：area{A≥τ} = A_target(radiusClass)                // 面积归一化，挂接既有 radiusAttempts 校准
边界细节 = 轮廓法向 fBm（H ≈ 0.7，分形维数 D≈1.2–1.3）+ domain warp
验收带：Polsby–Popper 4πA/P² ∈ [0.25, 0.95]
```

工程对接：把 `coastDistance(x,z)` 从极坐标公式替换为「足迹轮廓预烘焙距离网格（512²，
双线性插值）」，`field(x,z)` 接口、`exactFieldCache` 记忆化与 `spendPlanningUnit` 预算
不变；路网/街区/滨水带代码零改动。

## 4. 失效与版本语义

1. **默认值锁死现行为**：未显式设置的参数按现行行为计算；对固定 seed 集合做
   「显式 v1 参数 vs v2 全默认」地理哈希锁步测试，任何漂移即失败。
2. **`world.set` 必然产生新 worldRevision**；旧布局/挂载按既有规则标 `needs_rebind`，
   plan-patch 因 seed 与生成器版本绑定而保留、可重放失败时明确报告。
3. **`CITY_GENERATOR_VERSION` 递增规则不变**：凡改变既有默认布局行为的实现变更，
   同一提交递增并更新 `verify-city-baseline` 基线；新增参数（默认不动行为）不递增。
4. `contractVersion` 递增只表示参数 schema 演进，旧 profile 恒定有效；未知字段
   一律拒绝（`city_world_options_invalid`），不做静默升级。
5. 活动城市偏好路径维持 P0-1 规则：跨 generator 应用被拒；多样化参数只作用于
   独立 City 草稿与项目固定城市版本。

## 5. MCP 契约（调用面）

工具数量克制：扩展既有工具，不新增独立方法。

### 5.1 `creator_capabilities_list`（扩展）

输出新增 `worlds` 段（§2 的投影），本地完成 category 过滤与 schemaVersion 校验，
Studio 关闭时离线可用（与现行能力投影同模式）。Agent 由此发现可用参数、范围、
默认值与预设，**不得**由此推断参数已被实现验证之外的语义。

### 5.2 `creator_city_edit_preview`（扩展 operations）

```jsonc
// 请求（在现有 name/seed/profile 之外新增 operations）
{ "cityId": "city-…", "baseRevision": 7, "operationId": "…",
  "operations": [
    { "op": "world.set", "params": { "shape.family": "lobed", "shape.cores": 2,
                                     "shape.corridorPull": 0.2 } },
    { "op": "style.set", "params": { "timeOfDay": "dawn", "floraDensity": 1.4 } }
  ] }
// 响应（沿用既有信封）
{ "ok": true, "data": { "previewId": "…", "expiresAtMs": 0,
  "diff": { "world": {…}, "style": {…} },
  "checks": { "layoutInvalidation": "new-world-revision" | "none",
              "patchReplay": "intact" | "needs-review", "budgets": {…} },
  "diagnostics": [] } }
```

- 提交复用现有 `creator_city_edit_commit`（previewId + expectedRevision + operationId
  幂等）；实例、授权、基线 revision、预览有效期校验不变。
- **世界重建是独立阶段**：提交返回 `committed`，布局生成与渲染以 `pending/ready/failed`
  另行报告（沿用自定义 City 设计 §5 的语义），不得以事务成功宣称画面就绪。
- 错误码沿用 + 新增：`world_params_unknown`、`world_params_out_of_range`、
  `world_params_budget_exceeded`、`style_params_unknown`、`world_preset_unknown`。
- 预算：单次 preview ≤ 16 operations、≤ 32 参数、请求 ≤ 8 KiB（走 mailbox 请求预算
  分层，由 Rust 硬上限 clamp 并由守卫测试钉住）。
- Rust 只做信封/身份/预算/原子事务；参数语义校验全部在 city-sdk（`validateWorldParameters`
  + 能力目录投影），符合「Rust 负责身份授权与结构约束，可信 TS 适配器负责 City 业务」的边界。

### 5.3 试玩/发布联动

release 快照继续冻结完整 profile（含新参数）；`validateWorldPlanPatch` 语义不变
（patch 绑定 seed + generatorVersion）。发布前预检沿用「城市及布局匹配」校验，
不新增放行条件。

## 6. 实施切片与验收门槛

| 切片 | 交付 | 验收 |
|---|---|---|
| S1 | SDK 契约：`WorldParameterDescriptorV1`、`validateWorldParameters`、预设与能力投影类型 | 严格校验测试；**无漂移锁步测试**（v2 全默认 == v1 现行为，多 seed 地理哈希一致） |
| S2 | 生成器实现：形状场（§3）+ 距离网格替换 `boundaryRadius`；参数显式设置才生效 | `verify-city-baseline` 基线不漂移（默认行为）；形状参数扫描通过紧凑度验收带；确定性（同 seed 同参数哈希一致） |
| S3 | 能力生成链：`worlds` 段进 `creator_capabilities` 生成产物 + Rust 硬上限守卫 | 生成物 check；SDK 改数字后守卫拒绝虚报（皮肤锁步同模式） |
| S4 | MCP：edit_preview 接受 `world.set`/`style.set`，diff 与失效报告；commit 联通 | MCP 契约测试（未知字段/越界/预算/幂等/过期）；独立草稿端到端预览→提交→新布局 |
| S5 | 预设与样例：arid-dunes 内容源码项目收录预设；`validate-world` 覆盖新字段 | CLI 回环；样例打包 validate/pack/verify 通过 |

真机验收（S2/S4 后）：桌面 bundle 上对同一独立草稿做「改变形状族 → 新 worldRevision →
旧布局 needs_rebind → 重新 layout_save → 视口 ready」全链路，并复核 Miami 未受影响。
纯 schema 测试不能替代真机结果。

## 7. 明确不做

- 不接受自定义生成器代码、着色器、任意 URL/路径（沿用风格层现行禁令）。
- 不做脚本化/程序化资产注入；场景差异走既有 plan-patch 与创作者 GLB 链路。
- 不把多样化参数开放到活动城市（Miami）偏好——官方世界迁移按 §7.2 单独推进。
- 本规格不承诺 LLM 语义：参数是数值与枚举，"风格描述文字"只能作为设计意图，
  不是运行时配置（沿用自定义 City 设计 §4）。
