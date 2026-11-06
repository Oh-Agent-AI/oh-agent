# Agent City：建筑物统一范式 SPEC（BuildingModel）v2

日期：2026-10-08（v2，按 `CITY_BUILDING_MODEL_SPEC_REVIEW.md` 修订）。状态：修订稿待评审，未实施。
本文定义城市里「建模建筑」的统一声明范式（BuildingModel）、件字母表（Part）与**单体编译器**，并给出
迁移映射与实施批次。代码根目录 `apps/agent-city/ui/src/`。基线 = 分支 `merge-test-landmarks`（a0966f15）。
相关：CITY_ENGINE_SPLIT_SPEC.md（render/ 层宿主）、CITY_NIGHT_LIGHTING_SPEC.md（灯光预算）、
CITY_LANDMARK_BACKLOG.md（§1 合规边界）。

**v2 相对 v1 的变化**：现状数字按实测重写；补全件字母（旋转、部分球/环、开口、双面、共享夜灯）；
删除批量编译器与会话楼附件批（另立项）；验收由「截图逐像素」改为「场景图哈希等价」；发光取灯光预算类别；
验证层缩为 L1+L3；明确悬索桥归属；增加材质缓存子步；前置条件写明「先合并基线分支」。

## 0. 现状（实测，基线分支）

| 路径 | 位置 | 造型方式 | 生命周期 | 拾取 |
| --- | --- | --- | --- | --- |
| 会话楼 | `cityParts.buildRuntimes`（3410）+ 施工矩阵 | 28 个 instanced 批次 + 手写矩阵 | 施工动画 + 立面 shader 夜窗 | 会话详情 |
| 致敬地标 10 种 | `engine/models/landmarks/*.ts` + `models/registry.ts`（`LANDMARK_BUILDERS`、`LANDMARK_LABELS`） | 每种一个 `drawX(ctx)`，手写 THREE.Mesh | 少数 spinner + `landmarkWindows` 日夜贴图 | `decor:landmark:<kind>` |
| 城区地标 / 全城之最 | `buildDistrictLandmarks`（1929）/ `buildHeroCrown`（1844） | 手写 Group + renderCanvas 亮窗 | 随会话生长 + 夜窗 | 城区说明 |
| 公共用地 / 配套 / 花园 | `buildPublicSites`（1110）/ `buildCivics`（1663）/ `buildGardens`（1399） | **件数组**（box/cylinder/glow，`Piece` 类型） | 配套按落成进度生长（`writeCivic`） | `decor:site` / `decor:civic` / `decor:garden` |
| 纯函数模块 | `cityLandmarkVilla` / `cityHotelCrown` / `citySkylineProps` / `cityAirport` | 件数组或 Group 返回值 | 借宿主 | 借宿主 |

- `cityParts.ts` 4425 行（main 工作区 4670 行，结构已分叉）；`cityCatalog.ts` **31 条**；city 守卫脚本 21 个
  （含 `verify-city-night`，它对 cityParts + `models/landmarks/*` 做源码断言）。
- 材质：地标造型里 `material(color, emissive)` **每次调用都 new 一个 MeshLambertMaterial**，无缓存。
- 发光：统一走 `cityLightBudget.ts`（window / street / neon / landmark / ambient / overlay 六类预算）。

## 1. 目标与非目标

**目标**：新增一类非会话建筑 = 一个自包含 model 文件 + 注册一行（catalog / decor / i18n 自动一致）；
守卫可 import、registry 驱动；造型可序列化（为将来内容包留地基，但本期不做内容包）。

**非目标**：不改任何建筑的视觉；不把选址搬进 model；**不碰会话楼**（主体与附件都不迁，另立项）；
不实现批量编译器（批量走拆分 SPEC 的 `BatchRegistry`）；桥与高架的路径依赖造型不迁。

## 2. 范式总览

```
cityPlan（选址，现状保留） ──下发 Siting（位置/朝向/半径/landmark.shore 等）+ seed──▶
BuildingModel（声明：identity / geometry / lifecycle / picking）
        │ geometry() → BuildingPlan = Part[]（纯数据）
        ▼
单体编译器 render/buildingCompiler.ts
  · 材质表按 (role, color, light) 缓存   · dispose 登记   · spinner / blink / 夜灯按 lifecycle 注册
        ▼
scene group（名字 city-landmark-* / city-civic-* / city-public-sites-*，拾取映射不变）
```

## 3. BuildingModel 契约

```ts
export type BuildingSemantics = "data" | "scale" | "decor";   // = CatalogKind

export interface BuildingModel {
  /** ① 身份：与 CITY_CATALOG 的 id 一一对应（迁移期不改 id）。 */
  id: string;
  group: "地标" | "公共建筑" | "海滨与港口";          // 会话楼、桥与道路不进本范式
  semantics: Exclude<BuildingSemantics, "data">;
  title: string;                                      // i18n 扫描源
  body: string;                                       // i18n 扫描源

  /** ② 选址引用（不是选址实现），仅供守卫交叉校验。 */
  sitingKey?: string;                                 // "landmark:pagoda" / "civic:hospital" / "site:station"

  /** ③ 造型：纯函数，seed → 件流；禁 Math.random/Date，随机走 hashSeed。 */
  geometry: (input: GeometryInput) => BuildingPlan;

  /** ④ 生命周期（编译器解释）。 */
  lifecycle: {
    grow?: { mode: "civic-pace" };                    // 配套：件自 baseY 按落成进度升起（writeCivic 现行为）
    /** 夜景缺省 = 不发光。windows: "canvas" = 日/夜两张 renderCanvas 贴图按夜色切换（双子塔/扭转塔/城区地标）。 */
    night?: { windows: "none" | "canvas"; litParts?: string[] };
    spin?: Array<{ parts: string[]; axis: "x" | "y" | "z"; speed: number }>;   // 摩天轮转盘、灯塔光束
    blink?: { parts: string[]; periodMs: number };
  };

  /** ⑤ 拾取：decorId 沿用现命名，describe 直出 DecorInfo。 */
  picking: { decorId: string; category: string; describe: string };
}

export type GeometryInput = {
  seed: number;                                       // hashSeed(落地实例 id)
  radius?: number;                                    // 规划下发的用地半径（守卫断言占地不超）
  district?: { wall: string; roof: string; accent: string };
  sizing?: Record<string, number>;                    // 形态参数（配套种类、塔高上限 cap 等）
  siting?: { shore?: [number, number] };              // 海上岛地标的堤道岸点（歌剧院岛平台用）
};
```

## 4. Part 字母表

Part 是**判别联合**，非法组合在 tsc 期不可表示（L1）。v2 按实测补齐了现用几何：

```ts
type PartCommon = {
  id?: string;                                        // lifecycle 引用名；同 plan 内唯一
  at: [number, number, number];
  anchor?: "base" | "center";                         // base = y 为底面（缺省）
  rot?: [number, number, number];                     // 欧拉角 xyz；替代 v1 的 yaw/pitchZ（摩天轮辐条、塔基支撑腿要 x/z 旋转）
  role: "wall" | "trim" | "roof" | "glass" | "structure" | "water" | "lit";
  color?: string;                                     // hex 或令牌 "theme:accent" / "district:wall" …
  side?: "front" | "double";                          // 壳体内壁可见（歌剧院壳、航站楼壳）
  /** 发光取灯光预算类别，不接受自由倍率（防止重新长出手填强度）。仅 role:"lit" 生效。 */
  light?: "landmark" | "neon" | "street-head" | "beacon";
};

export type Part =
  | (PartCommon & { kind: "box"; size: [number, number, number] })
  | (PartCommon & { kind: "cylinder"; size: [number, number, number]; radiusTop?: number; open?: boolean; segments?: number })
  | (PartCommon & { kind: "cone"; size: [number, number, number]; segments?: number })
  | (PartCommon & { kind: "sphere"; size: [number, number, number]; phi?: [number, number]; theta?: [number, number] })  // 半球壳、穹顶
  | (PartCommon & { kind: "torus"; radius: number; tube: number; arc?: number })                                        // 半环拱圈
  | (PartCommon & { kind: "tube"; radius: number; points: Array<[number, number, number]> })                            // CatmullRom 缆索
  | (PartCommon & { kind: "instanced"; base: "box" | "cylinder"; pieces: Array<{ at: [number, number, number]; size: [number, number, number]; rot?: [number, number, number]; color?: string }> })
  | (PartCommon & { kind: "panel"; size: [number, number, number]; texture: "windows:canvas" })                        // 贴图由 lifecycle.night.windows 生成日/夜两张
  | (PartCommon & { kind: "bulbs"; batch: "heads" | "neon"; pieces: Array<[number, number, number]>; tint?: "budget-desaturated" }); // 引用引擎共享夜灯批次（悬索桥灯串）
```

- **材质角色表**（编译器持有）：wall / trim / roof / glass / structure / water = Lambert，按 `(role, color, side)` 缓存；
  `lit` = 夜门控自发光，强度来自 `LIGHT_BUDGET[light]`；`bulbs` 直接复用 `NightLights.heads/neon`。
  新增角色需改本表并过守卫清单断言。
- **字母覆盖核对**（基线 10 个地标文件）：Box 45、Cylinder 20、Torus 4（1 处带 arc）、Sphere 4（2 处部分角）、
  Cone 3、Tube 1；开口圆柱 2 处；x/z 轴旋转 7 处；renderCanvas 贴图 2 种楼。以上全部有对应件。
  仍表达不了的（几何烘焙非均匀缩放，如歌剧院壳 `scale(0.75,1.6,0.9)`）用 `sphere.size` 三轴近似，
  若场景图哈希不等价则该件登记进豁免白名单（§6.3）。

## 5. 单体编译器

`render/buildingCompiler.ts`：一份 plan → Group。职责：按材质表缓存材质（**批 0 的第一子步，先于 DSL 独立落地**）、
登记 dispose、按 lifecycle 注册 spinner / blink / 夜窗贴图切换 / 夜门控、给 Group 命名以保持拾取映射。
不做批量归并；配套的 civic-pace 生长由编译器把件写入现有 `civicPieces` 结构（`writeCivic` 不变）。

## 6. 与现有体系的对接

1. **registry 合并**：现 `models/registry.ts` 的 `LANDMARK_BUILDERS` 演进为 `MODEL_REGISTRY: BuildingModel[]`；
   `LANDMARK_LABELS` 由 registry 的 title 派生。`cityDecor` 已从 registry 取名，不用再改。
2. **catalog 派生化**：`CITY_CATALOG` 中本范式覆盖的条目由 registry 派生 id/group/kind/title/body；image 留注册侧。
3. **守卫 `verify-city-models.mjs`**（L3）：确定性（同输入两次 JSON 相等）、占地不超 radius、Part.id 唯一、
   角色/颜色/灯光类别合法、lifecycle 引用的 parts 存在、catalog 有条目与缩略图、sitingKey 存在、
   **场景图哈希等价**（§6.4）。豁免白名单显式登记，禁止静默。
4. **场景图哈希等价（验收方式）**：对同一 (kind, seed, input)，旧路径 `drawX(ctx)` 与新路径编译各建一个 Group；
   遍历网格，对 (几何顶点缓冲, 世界矩阵, 材质 color/emissive/side) 取哈希、排序比较。确定性、无 GPU、可进 CI。
   迁移前先给 10 个地标 + 9 个公共/配套建立**基线哈希**；真 GPU 截图只做人工抽查。
5. **验证分层**：L1 类型（判别联合）+ L3 CI 守卫。v1 的 L2（dev 注册期执行）与 L4（运行时夹取计数）暂不做，
   出现真实缺陷再加。
6. **夜景衔接**：`verify-city-night` 的源码断言（桥塔霓虹走预算、无手填倍率）迁移后改为对 Part 字段断言
   （`light` 必须是预算类别、`bulbs.tint` 为 budget-desaturated），同批完成，不留空窗。
7. **i18n**：title/body 进 i18n 扫描清单（已支持）。

## 7. 迁移映射（31 条 catalog）

| 去向 | 条目 | 数 |
| --- | --- | --- |
| 不迁：会话楼（另立项） | session-tower / session-slab / session-deco / session-hotel / hero-tower | 5 |
| 不迁：路径依赖造型 | **suspension-bridge**（随过河桥与路网高度定形）/ truss-bridge / expressway | 3 |
| 不迁：散布装饰集合 | signs（citySkylineProps）/ beach（多个 build* 方法的集合，不是一栋楼） | 2 |
| 批 2：公共用地 + 配套 + 花园 | civic-hall / station / stadium / observation-tower / harbor / park / hospital / school / mall / garden | 10 |
| 批 1：致敬地标 | tv-tower / twin-towers / twist-tower / arch / sail-opera / lighthouse / ferris-wheel / pagoda / villa / airport | 10 |
| 批 3：城区地标 | district-landmark | 1 |

悬索桥：v1 自相矛盾（既算地标又「不迁」）。v2 定为**不迁**，造型文件留在 `render/landmarks/suspensionBridge.ts`，
从 `LANDMARK_BUILDERS` 移到 roadSystem 侧注册，避免 registry 里出现一个不遵守契约的条目。

## 8. 实施批次（每批独立可停，视觉零变化）

前置条件：**基线分支 `merge-test-landmarks` 先合并进 main**（它已改动 cityParts 结构、地标文件、夜景），
否则本 SPEC 写在 main 旧结构上会与之全面冲突。

| 批 | 内容 | 验收 | 估算 |
| --- | --- | --- | --- |
| 0a | 材质缓存：地标造型的 `material()` 按 (color, emissive, side) 复用 | 场景图哈希（材质身份除外）不变；材质对象数下降（实测记录） | 0.5 天 |
| 0b | 单体编译器 + 场景图哈希守卫 + 19 栋基线哈希 + pagoda 走通 model→编译→守卫→catalog | verify-city-models 全绿、pagoda 哈希等价 | 1 天 |
| 2 | 公共用地 6 种 + 配套 3 种 + 花园 → model（件数组直译，civic-pace 接入） | 哈希等价 + civic 生长守卫 | 1.5–2 天 |
| 1 | 其余 9 个地标 → model（含 villa、airport 模块收编） | 哈希等价；豁免白名单 ≤ 2 件 | 3–4 天 |
| 3 | 城区地标 → model（canvas 夜窗 + district 取色） | 哈希等价 + 夜窗切换守卫 | 1.5 天 |
| 5 | catalog 派生化 + verify-city-catalog 并入 verify-city-models + verify-city-night 断言迁移 | 守卫清单更新 | 1 天 |

合计约 8–10 天；建议 0a → 0b → 2 → 1 之后复盘，再决定是否做 3、5。会话楼（v1 批 4）不在本 SPEC。

## 9. 风险与不统一项

| 项 | 处置 |
| --- | --- |
| 声明表达力不足（烘焙缩放、特殊贴图） | 先用件近似，哈希不等价则进豁免白名单（显式登记、守卫计数上限） |
| 材质缓存改变材质身份（共享后改色会串） | 编译器产出的材质只读；需要随夜变化的走 `lit` 角色由预算统一驱动 |
| 夜灯门控 × 静态城缓存 | lifecycle 注册进现有 `setNightGlow` 分发（已过缓存回归），不另起路径 |
| 与拆分 SPEC 的顺序 | 本 SPEC 只新增 `render/buildingCompiler.ts` 与 `models/*`，不移动 cityParts 方法，可先于拆分 SPEC |
| 内容包（皮肤）无当前需求 | 只保证 Part 可序列化，不做分发格式 |

## 10. 战略衔接

- **CITY_ENGINE_SPLIT_SPEC**：编译器落在其 `render/` 层；批量通道属其 `BatchRegistry`，本 SPEC 不重复实现。
- **CITY_NIGHT_LIGHTING_SPEC**：`light` 取预算类别，夜景调参一处生效于全部 model。
- **content pack**：Part 纯数据，为将来留口子；不在本期范围。
