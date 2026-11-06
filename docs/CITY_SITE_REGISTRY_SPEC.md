# Agent City：城市对象注册表 SPEC（SiteRegistry）——生成器与编辑器的对象契约

日期：2026-10-11。状态：草案待评审，未实施。
本文为城市里**非会话对象**（公共设施、花园、城区地标、背景楼、致敬地标、市政用地、海滨与基础设施装饰）建立一张
**单一来源的对象类注册表**，并把「地图编辑器能对它做什么」从对象定义里拆成一张独立的**编辑策略表**。代码根目录
`apps/agent-city/ui/src/`。基线 = 分支 `worktree-city-plan-repair` @ `6c769853`（含 city-opt 检查点 `8b571016` 与其工作区快照 `0dc3c235`）。

相关：`CITY_PLAN_MANUAL_REPAIR_SPEC.md` §0（两层架构：生成器 / 编辑器）、§14（设施工具）；
`CITY_BUILDING_MODEL_SPEC.md`（致敬地标的 BuildingModel 范式，本文与之**对接不替代**）；
`CITY_MODEL_PHYSICAL_INVARIANTS_SPEC.md`（物理声明）；`CITY_ENGINE_SPLIT_SPEC.md`（systems/ 层）。

**一句话**：生成器声明「城市里有哪些对象、它们叫什么、占多大地、怎么拾取」；编辑器声明「市长能动哪些、怎么动」；
守卫保证两张表永远对得上——生成器新增一类对象，编辑器不做决定就过不了 CI。

---

## 0. 现状（实测，基线分支）

### 0.1 一类对象，七处各写一份

| 关注点 | 现在在哪 | 形式 |
| --- | --- | --- |
| 种类枚举 | `cityLayout.ts` `CivicKind` / `CIVIC_ORDER`；`cityPlan.ts` `LandmarkKind`；`cityLayout.ts` `PublicSite.kind` | TS 联合类型 + 数组 |
| 中文名 | `models/registry.ts` `CIVIC_LABELS` / `LANDMARK_LABELS`；`cityDecor.ts` switch 里的字面量（花园、背景楼、车站…）；`planRepair/controller.ts` `SITE_LABEL`（**我在 §14 加的重复**）；`cityCatalog.ts` 各条 `title` | 四份 |
| 建筑说明目录 | `cityCatalog.ts`（31 条，含会话楼 5 条） | 手写数组 |
| 拾取归类 | `cityDecor.decorKindForName`：网格名**字符串前缀**（`city-civic-`、`city-garden-`、`city-public-sites-`…） | 字符串约定，无守卫 |
| 实例定位 | `systems/uiOverlays.decorAt`：公共设施已能算出实例下标（`piece.civic`），**返回时丢掉**，只给 `decor:civic:<kind>` | 信息丢失 |
| 占地/最小尺寸 | `models/layoutPlacementGeometry.ts`（city-opt 新增）：`civicEnvelopeSize`、`civicMinimumSize`、`GARDEN_MINIMUM_SIZE`、`DISTRICT_LANDMARK_ENVELOPE` | **已是单一来源**，但只有生成器在用 |
| 编辑规则 | `planSites.ts`（编辑器）：自带一套占用/尺寸/拾取高度判断 | 与生成器各写一套 |

致敬地标是唯一的例外：`models/registry.ts` 的 `BUILDING_MODELS` / `LANDMARK_BUILDERS` / `UNPARADIGMED` 有「禁止静默」守卫
（`verify-city-models.mjs`：每个 kind 要么已声明化、要么登记理由，白名单有上限）。本文把同样的治理推广到其余对象。

### 0.2 分散已经造成的缺陷（实测）

| 编号 | 缺陷 | 证据 | 后果 |
| --- | --- | --- | --- |
| **D1** | **城区地标的占用规则两层分叉** | 生成器（同步 city-opt 后）：只放进**整块空街区**，按 `DISTRICT_LANDMARK_ENVELOPE`（17×17）做占地检查，并**预留整个街区**（`cityLayout.ts` 注释：17 m 裙房比一个会话地址大，保住相邻地址）。编辑器：`planGeometry.reservedParcelIds` 只预留 `landmark.parcelId` 一个地块；`planSites` 把它当「地块级」搬到任意空地块 | 编辑器可能把会话楼搬进地标街区的相邻地块，或把地标搬到一块装不下 17 m 裙房的地上——压邻居 |
| **D2** | 公共设施/花园搬家不走生成器的取地 | 生成器用 `findBlockLotCandidate`（在**真实街区面**内取内缩矩形）+ `civicMinimumSize(kind)` / `GARDEN_MINIMUM_SIZE`。编辑器 `applySiteOps` 直接把街区**外接矩形**的宽深赋给设施 | 街区是不规则多边形时设施可能越过路缘；小街区里商场可能放不下 |
| **D3** | 中文名四份 | 见 0.1 | 改一个名字要改四处；已有一处是我新加的重复 |
| **D4** | 拾取靠网格名前缀 + 丢实例 | 见 0.1 | 网格改名拾取静默失效；编辑器只好另写射线-包围盒拾取 |
| **D5** | 编辑器拾取高度写死 | `planSites.PICK_HEIGHT = { civic: 28, garden: 12, "district-landmark": 45 }` | 与真实造型无关，大楼可能点不中、矮楼误中 |
| **D6** | 新增对象类无人提醒 | 无守卫 | 生成器加一类设施，编辑器的设施工具里它是隐形的，也没人知道该不该可编辑 |
| **D7** | 公共设施实例 id 按序号 | `civic:${index}`，数据增长后重排 | 编辑器已用位置校验 `at` 兜底（§14），根治在生成器 |
| **D8** | **城区地标被说明成「致敬地标」** | 城区地标网格名 `city-landmark-district:<城区>`（`systems/landmarkSystem.ts`）撞上致敬地标的前缀 `city-landmark-`，`decorKindForName` 归成 `landmark:district:<城区>`；`describeDecor` 查不到名字，回落成「地标 · 致敬地标 · 装饰」。浏览器实测点到城区地标时看到的正是这行 | 用户看到错误的分类（目录里城区地标是「随规模出现」，不是装饰）；前缀约定在两类对象间已经冲突 |

---

## 1. 目标与非目标

**目标**

1. 一张**对象类注册表**（`SiteClass`，生成器侧，共享）：种类 id、族、中文名、目录条目、拾取网格名、布局来源、实例 id、占地、拾取高度、落位方式——各一处。
2. 一张**编辑策略表**（`SiteEditPolicy`，编辑器侧）：每个对象类「可编辑（怎么编辑）」或「锁定（为什么）」。
3. **编辑器复用生成器的落位谓词**（取地、包络检查、预留整面），不再自写一套。修 D1、D2、D5。
4. 名称、目录、拾取归类从注册表派生。修 D3、D4、D8。
5. 「禁止静默」守卫：两张表、目录、拾取、布局实例之间任何对不上都失败。修 D6。
6. 除修缺陷外**行为零变化**：场景图、规划结果、现有补丁的重放结果逐字节不变。

**非目标**

- 不改造型与渲染（`systems/*`、`models/landmarks/*` 的几何不动）。
- 不重做致敬地标的 BuildingModel 体系：本文的 `landmark:*` 类引用 `models/registry.ts`，不复制它。
- 不做景观工具、分区刷，不放开致敬地标/市政用地的编辑（它们在策略表里登记为锁定）。
- 不改会话楼（数据对象由开发商摆放；它们出现在注册表里只是为了让「全城对象都有归属」可被守卫）。
- 不在本文改公共设施的 id 方案（D7 作为对生成器线的建议，§10 B4）。

---

## 2. 分层与归属

遵循 `CITY_PLAN_MANUAL_REPAIR_SPEC.md` §0 的两层架构：**编辑器依赖生成器，生成器不知道编辑器。**

```
生成器（city-opt 线）                              编辑器（plan-repair 线）
engine/models/siteClasses.ts   ◄──── import ────  engine/planSitePolicy.ts
  SiteClass[]：是什么、叫什么、                      SiteEditPolicy：能不能动、怎么动
  占多大、怎么拾取、怎么落位                          （只引用 classId，不复制任何几何数字）
        ▲                                                   ▲
        │ 派生                                              │ 使用
cityCatalog / cityDecor / uiOverlays             planSites / planGeometry / 设施工具
```

- `siteClasses.ts` 放在 `engine/models/`，与 `registry.ts`、`layoutPlacementGeometry.ts` 同层，**归生成器线维护**。它是纯模块（不 import three、DOM），只引用已有声明。
- `planSitePolicy.ts` **归编辑器线维护**。它 import `siteClasses`，反向不允许（守卫：`siteClasses.ts` 不得出现 `plan` / `edit` / `policy` 字样的 import）。
- **跨层契约测试**放在编辑器线（它是依赖方）：「每个 SiteClass 都有一条策略」。生成器新增类 → 编辑器线 CI 红 → 编辑器必须做决定（可编辑或登记锁定理由）。

---

## 3. SiteClass 契约（生成器侧）

```ts
/** engine/models/siteClasses.ts */
export type SiteFamily =
  | "data"                // 会话楼（开发商摆放，仅为全城归属完整而登记）
  | "civic"               // 学校/商场/医院
  | "garden"              // 城区花园与景观湖
  | "district-landmark"   // 城区地标
  | "context"             // 背景楼
  | "landmark"            // 致敬地标（BuildingModel 体系）
  | "public-site"         // 市政用地：市政厅/车站/体育场/公园/观景塔/港口
  | "scenery";            // 海滨、机场、桥、高架、火山、聚合楼群等装饰与基础设施

export type SiteInstance = { id: string; x: number; z: number; yaw: number; width: number; depth: number; y: number };

export type SiteClass = {
  /** 稳定类 id：`<family>` 或 `<family>:<kind>`，例：civic:school、garden、landmark:ferris-wheel、public:station。 */
  id: string;
  family: SiteFamily;
  /** 中文名——全仓唯一来源；英文仍走 i18n.tsx 的中文原文键（键不变）。 */
  title: string;
  /** cityCatalog 条目 id；没有目录条目的写 null 并在 noCatalogReason 说明。 */
  catalogId: string | null;
  noCatalogReason?: string;
  /** 拾取：渲染网格名（精确名或以 `*` 结尾的前缀），decorKindForName 由此派生。 */
  meshNames: readonly string[];
  /** 实例来源：CityLayout 上哪个数组、怎么筛；装饰类可为 null（无可枚举实例）。 */
  source: { array: "civics" | "gardens" | "districtLandmarks" | "contextBuildings" | "landmarks" | "publicSites"; match?: (raw: unknown) => boolean } | null;
  /** 实例 → 稳定 id 与占地（占地取**渲染包络**，来自 layoutPlacementGeometry 等已有声明，不另写数字）。 */
  instance?: (raw: unknown, layout: CityLayout) => SiteInstance;
  /** 拾取高度（替代 planSites.PICK_HEIGHT 常量；取自渲染几何声明或实例自身 height）。 */
  pickHeight?: (raw: unknown) => number;
  /** 生成器的落位方式——编辑器据此复用同一套谓词（§5）。 */
  placement?: {
    /** face-lot：在一整块空街区的真实面内取内缩矩形；face-reserve：放在一个地址上但预留整面；parcel：占一个地址。 */
    mode: "face-lot" | "face-reserve" | "parcel";
    minimumSize?: () => { width: number; depth: number };
    envelope?: () => { width: number; depth: number };
  };
};

export const SITE_CLASSES: readonly SiteClass[];
export function siteClassOf(decorOrSiteId: string): SiteClass | null;
```

**v1 登记表**（与现有代码一一对应，数值全部引用已有声明）：

| classId | family | title | catalogId | meshNames | source.array | placement |
| --- | --- | --- | --- | --- | --- | --- |
| `civic:school` / `civic:mall` / `civic:hospital` | civic | 学校 / 商场 / 医院 | school / mall / hospital | `city-civic-*` | civics（按 kind） | face-lot，`civicMinimumSize(kind)`，包络 `civicEnvelopeSize` |
| `garden` | garden | 城区花园与景观湖 | garden | `city-garden-*` | gardens | face-lot，`GARDEN_MINIMUM_SIZE` |
| `district-landmark` | district-landmark | 城区地标 | district-landmark | `city-landmark-district:*` | districtLandmarks | **face-reserve**，`DISTRICT_LANDMARK_ENVELOPE` |
| `context` | context | 背景楼 | null（说明：城市氛围，不进目录） | `city-vice-context-facades`、`city-vice-context-rooftops` | contextBuildings | parcel |
| `landmark:<LandmarkKind>` ×10 | landmark | 取 `LANDMARK_LABELS` | 同 kind（villa-complex → villa） | `city-landmark-<kind>` | landmarks（按 kind） | —（站点由规划给定） |
| `public:civic` / `station` / `stadium` / `park` / `tower` / `harbor` | public-site | 市政厅 / 车站 / 体育场 / 城市公园 / 观景塔 / 港口与码头 | civic-hall / station / stadium / park / observation-tower / harbor | `city-public-sites-*` | publicSites（按 kind） | — |
| `scenery:seaside` | scenery | 海滨设施 | beach | 现 `decorKindForName` 的海滨网格名单 | null | — |
| `scenery:airport` / `bridge-truss` / `expressway` / `volcano` / `massing` | scenery | 机场岛 / 桁架桥 / 高架 / 火山 / 聚合楼群 | airport / truss-bridge / expressway / null / null | 现有对应网格名 | null | — |
| `data:session` | data | 会话楼 | session-tower 等 5 条 | 会话楼网格（由 idAt 归类） | districts[].slots | parcel |

> 说明：`landmark:*` 的 `title` 不在 siteClasses 里重写，直接 `LANDMARK_LABELS[kind]`；`civic:*` 的 `title` 以本表为准，`CIVIC_LABELS` 改为从本表派生。

---

## 4. SiteEditPolicy 契约（编辑器侧）

```ts
/** engine/planSitePolicy.ts */
export type SiteEditPolicy =
  | { editable: true; ops: readonly ("move" | "remove")[] }   // 怎么搬由 SiteClass.placement 决定，策略表不重复几何
  | { editable: false; reason: string };                      // 理由 ≥ 10 字，展示给用户

export const SITE_EDIT_POLICY: Readonly<Record<string /* classId 或 `<family>:*` */, SiteEditPolicy>>;
export function policyOf(classId: string): SiteEditPolicy;     // 精确 id 优先，其次 family 通配
```

**v1 策略**（与 §14 的设施工具行为一致，只是从代码搬到表里）：

| 适用 | 策略 | 理由（锁定时展示） |
| --- | --- | --- |
| `civic:*`、`garden`、`district-landmark`、`context` | 可编辑：move、remove | — |
| `landmark:*` | 锁定 | 致敬地标由岛屿规划选址，带路网接入点与海岸约束，移动或拆除会牵连路网 |
| `public-site:*` | 锁定 | 市政用地与路网接入点绑定（车站、体育场、港口等），本期不开放编辑 |
| `scenery:*` | 锁定 | 海滨、机场、桥梁、高架与远景属于城市基础设施与风貌，不是设施 |
| `data:*` | 锁定 | 会话楼由开发商（程序）按规划来盖；生成有误时用「移楼」修复 |

锁定理由**就是**设施工具点到该对象时显示的文案——不再在 `controller.ts` 里另写一份。

---

## 5. 编辑器复用生成器的落位谓词（修 D1、D2）

编辑器搬一座设施时，判断「目标能不能放」必须和生成器摆放它时用**同一个谓词**，否则两层对同一座城的占用理解会分叉（D1 就是这样发生的）。

| placement.mode | 生成器现在怎么放 | 编辑器改为 |
| --- | --- | --- |
| `face-lot` | `findBlockLotCandidate({ block, environment, minimumSize })` 在真实面内取内缩矩形 | 搬家目标 = 整块空街区；用**同一个** `findBlockLotCandidate` 取矩形；设施的 x/z/yaw/width/depth 取它给的 footprint，而不是街区外接矩形 |
| `face-reserve` | 整块空街区 + `inspectLayoutPlacement(footprint = 地址 ⊕ envelope)`；**预留整面** | 搬家目标 = 空街区里的一个地址；用同一个包络检查；`reservedParcelIds` 对该类**预留整面** |
| `parcel` | 地址级 | 维持现状（地块空、可建、坡度、不压路、高架净空） |

**对生成器线的接口请求**（两层碰面处，需 city-opt 线同意）：

- `cityLayout.ts` 里的 `layoutPlacementEnvironment` / `inspectLayoutPlacement` 目前是**模块私有**，编辑器无法复用。请求导出一个纯函数：

  ```ts
  export function checkSitePlacement(layout: CityLayout, footprint: Footprint, occupied: readonly Parcel[]): BlockPlacementResult;
  ```

  入参只用 `CityLayout`（编辑器手里只有布局，没有 plan），语义与生成器摆放时完全一致。
- 在它导出之前，编辑器只能用 `planner/blockPlacement.inspectBlockPlacement`（已导出）自行拼环境——**不推荐**，那就是在复制生成器的环境构造，正是本文要消除的东西。B3 以此接口为前置。

`planGeometry.reservedParcelIds` 改为按 `SiteClass.placement.mode` 决定预留范围（`face-lot` / `face-reserve` 预留整面，`parcel` 预留地址）——与生成器的 `used` 集合一致。

---

## 6. 拾取（修 D4、D5）

1. `cityDecor.decorKindForName` 改为查 `SITE_CLASSES[].meshNames`，不再手写前缀；守卫断言场景里每个带 `city-` 前缀的可拾取网格名都恰好归属一个类。
   致敬地标登记**精确网格名**（`city-landmark-<kind>`），城区地标登记 `city-landmark-district:*`——两者不重叠，D8 随之消失（城区地标显示为「城区地标」）。
   匹配顺序：精确名优先于前缀，前缀之间不允许互为前缀（守卫 §8-4）。
2. `uiOverlays.decorAt` 能定位到实例时（公共设施已能：`piece.civic`），返回 `decor:<classId>#<instanceId>`；定位不到时仍返回 `decor:<classId>`。
   `describeDecor` 按 `#` 前的类 id 取说明，旧格式 `decor:civic:<kind>` 读入兼容一个版本。
3. 编辑器的设施工具**优先**用引擎拾取给出的实例 id；拿不到实例（合并网格）时才退回射线-包围盒，包围盒用 `SiteClass.instance()` 的占地 + `pickHeight()`，`planSites.PICK_HEIGHT` 删除。

---

## 7. 名称与目录（修 D3）

- 中文名只在 `SITE_CLASSES[].title`（致敬地标仍在 `LANDMARK_LABELS`，siteClasses 引用它）。
- `CIVIC_LABELS` 改为 `Object.fromEntries(SITE_CLASSES.filter(civic).map(...))` 派生；`cityDecor` 的标题、`planRepair/controller.ts` 的 `SITE_LABEL` 改为查注册表（删除 `SITE_LABEL`）。
- `cityCatalog` 的 `title` 保持手写（目录还有图片、正文、`source` 字段），由守卫断言与注册表一致；`describeDecor` 的正文（`body`）不动。
- i18n：英文目录按中文原文做键，中文原文不变则 i18n 无需改动。

---

## 8. 守卫：`verify-city-site-registry.mjs`（禁止静默）

**生成器侧**（与 `verify-city-models` 同风格，归生成器线）：

1. `SITE_CLASSES` 的 id 唯一；每条要么有 `catalogId` 且目录里存在、标题一致，要么 `catalogId: null` 且 `noCatalogReason` ≥ 10 字。
2. 目录里每条非会话条目都被恰好一个类引用（会话楼 5 条归 `data:session`）。
3. 真实城市（380 / 1600 楼，`backdrop: "full"`）里，`civics` / `gardens` / `districtLandmarks` / `contextBuildings` / `landmarks` / `publicSites` 的**每个实例**都恰好匹配一个类，`instance()` 给出的 id 在全城唯一。
4. 场景图里每个 `decorKindForName` 能识别的网格名都恰好匹配一个类（不允许两个类的 `meshNames` 重叠，不允许有可拾取网格无归属）。
5. `placement.minimumSize` / `envelope` 只能引用 `layoutPlacementGeometry` 的导出（源码扫描：siteClasses.ts 里不得出现裸数字的宽深常量）。
6. `siteClasses.ts` 不 import 任何 `plan*` 编辑器模块（依赖方向）。

**编辑器侧**（跨层契约，归编辑器线）：

7. 每个 `SiteClass` 在 `SITE_EDIT_POLICY` 里有一条（精确或 family 通配）；锁定理由 ≥ 10 字。
8. 可编辑的类必须带 `placement`；`face-lot` / `face-reserve` 类的搬家必须走 §5 的谓词（用例：把商场搬到一块面积够但形状不规则的街区，footprint 不越过街区面；把城区地标搬到相邻地址被占的街区，被拒）。
9. 源码扫描：「学校」「商场」「医院」「城区花园」「背景楼」等中文名字面量只出现在 siteClasses.ts 与 cityCatalog.ts（及 i18n 键）。

守卫登记进 `verification-manifest.json` 与 planning / sites 组；`verify-city-verification.mjs` 的计数锁同步 +1。

---

## 9. 迁移映射

| 现在 | 之后 |
| --- | --- |
| `cityLayout.CivicKind` / `CIVIC_ORDER` | 保留（生成器内部用）；守卫断言与 `civic:*` 类一一对应 |
| `registry.CIVIC_LABELS` | 由 `SITE_CLASSES` 派生 |
| `registry.LANDMARK_LABELS` | 不动；`landmark:*` 类引用它 |
| `cityDecor.describeDecor` 标题字面量 | 查注册表；正文不动 |
| `cityDecor.decorKindForName` 前缀表 | 查 `meshNames` |
| `uiOverlays.decorAt` 返回 `decor:civic:<kind>` | 返回 `decor:<classId>#<instanceId>`（兼容旧格式一版） |
| `planSites.listSites` 的四段手写 | 遍历 `SITE_CLASSES` 中策略可编辑的类，用 `instance()` |
| `planSites.PICK_HEIGHT` | 删除，用 `pickHeight()` |
| `planSites.siteMoveProblem` 的 block / parcel 分支 | 按 `placement.mode` 走 §5 谓词 |
| `planSites.applySiteOps` 赋街区外接矩形 | 用谓词给出的 footprint |
| `planGeometry.reservedParcelIds` 城区地标只预留地址 | 按 `placement.mode` 预留整面 |
| `controller.SITE_LABEL`、设施工具里的锁定文案 | 删除；查注册表与策略表 |

---

## 10. 实施批次（每批独立可停）

| 批 | 内容 | 动谁的文件 | 行为 | 验收 |
| --- | --- | --- | --- | --- |
| **B0** | 新建 `siteClasses.ts` + 生成器侧守卫（§8 1–6）；**无消费者** | 生成器（新文件） | 零变化 | 守卫绿；场景图前后逐字节一致 |
| **B1** | 名称派生：`CIVIC_LABELS`、`cityDecor` 标题、`controller.SITE_LABEL` 改查注册表 | 两边各一处 | 零变化 | 守卫 §8-9；`verify-city-models`、目录相关测试绿 |
| **B2** | 拾取：`decorKindForName` 查 `meshNames`；`decorAt` 返回实例 | 生成器（cityDecor、uiOverlays） | **修 D8**（城区地标改显示为「城区地标」）；其余零变化（id 格式兼容） | 拾取前后对全城每个可拾取网格结果一致，唯一差异是城区地标的归类；设施工具优先用实例 |
| **B3** | 编辑器：`planSitePolicy.ts` + 跨层守卫（§8 7–8）；`planSites` 改走注册表与 §5 谓词；`reservedParcelIds` 按模式预留；删 `PICK_HEIGHT` | 编辑器；**前置：生成器导出 `checkSitePlacement`** | **修 D1、D2、D5**（有意变化） | `verify-plan-sites` 新增 D1/D2 用例；既有补丁重放结果仅在 D1/D2 触发处不同，并在 stale 里如实上报 |
| **B4** | （建议，生成器线自决）公共设施改用稳定实例 id（如 `civic:<blockId>`），旧 id 读入映射一版 | 生成器 | 有意变化 | 编辑器位置校验 `at` 继续兜底；旧补丁在映射期内不失效 |

B0–B2 是纯整理，可以在生成器线或编辑器线做（文件归生成器线，做之前知会对方）；B3 是编辑器的缺陷修复，依赖一个生成器导出。

---

## 11. 验收

- 新守卫全绿，并已进入 `verification-manifest.json` 与 planning / sites 组。
- B0–B2：`verify-city-scene-baseline` 在本分支检查点上本就是红的（city-opt 在途改动所致），以**改动前后输出逐字节一致**代替绝对通过（同 `CITY_PLAN_MANUAL_REPAIR_SPEC.md` §13 的做法）。
- B3：`verify-plan-sites` 新增两例——D1（城区地标街区的相邻地址不能被会话楼占用；地标不能搬到装不下包络的地方）、D2（不规则街区里设施 footprint 在面内）；真实城市段继续「拆除全部干净、搬到首个候选全部干净」。
- 浏览器实测：设施工具对四类可编辑对象的悬停/选中/搬家/拆除不变；点致敬地标、市政用地、海滨装饰时显示的锁定文案来自策略表。

---

## 12. 风险与开放问题

1. **文件归属**：B0–B2 动的是生成器线的文件（`models/`、`cityDecor`、`uiOverlays`）。两层架构下要先和 city-opt 线对齐，避免它的在途改动与本文冲突；最好由 city-opt 提交其工作区之后再开工。
2. **`checkSitePlacement` 的导出**：是 B3 的硬前置。若生成器线不愿导出，备选是编辑器只做「目标街区整面为空 + 面积 ≥ minimumSize」的保守检查（宁严勿宽），并在 spec 里标注为临时。
3. **既有补丁的行为变化**（B3）：修 D1/D2 后，少数原本合法的设施搬家会被判失效。补丁层的处理是如实 stale 并在体检里显示，不猜替代位置——与 §14 的原则一致，但需要在发布说明里写明。
4. **网格名改动**：B2 之后，渲染层改网格名会被守卫抓住，这是有意的约束，需要在 `CITY_ENGINE_SPLIT_SPEC` 的渲染约定里补一句。
5. **聚合楼群与会话楼**：`scenery:massing` 与 `data:session` 都代表会话数据的显示形态，但不可编辑；把它们登记进注册表只为「全城对象都有归属」可被守卫，不改变它们的语义。
6. **D7 是否做**：公共设施稳定 id 归生成器线决定；不做也不影响本文其余部分（编辑器有 `at` 兜底）。
