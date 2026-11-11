# Agent City：连续城市（2026-10-01）

将真实 Agent 工作数据映射为可浏览的 3D 城市。业务状态由本地 authority 提供，地形、道路、分区、港口和车辆都是程序化视觉表达，不代表真实地理、交通或业务关系。无外部地图、运行时素材请求或用户数据上传。贴图素材（HDR 天空、地面、立面、水面法线）为 CC0/MIT，随应用离线打包，见 `apps/desktop/ui-dev/react/src/features/city/assets/LICENSES.md`；目录总量 ≤ 5 MB 由 `scripts/verify-react-city-assets.mjs` 守住。素材加载失败时城市退回纯程序化外观，照常可用。

## 本轮设计范围

可选飞机游戏模式的范围、模块和三轮实施计划见 [CITY_GAME_MODE_IMPLEMENTATION_PLAN.md](CITY_GAME_MODE_IMPLEMENTATION_PLAN.md)。该功能尚待实现，复用城市渲染与布局，任务及成绩独立于真实分析数据。

2026-10-04 UI/UX 新目标见 [场景优先与渐进式 HUD SPEC](CITY_UX_SPEC.md)。以下为原有城市空间方案记录；其中“HUD 沿用现有产品”的呈现约定已被新 SPEC 取代，数据与布局契约不变。新版默认采用少量 HUD、按需统计与回放，不以旧版仪表盘式布局作为最终目标。

城市画布采用 redesign-overhaul：从独立圆岛改为共享沿海平原、街区和地块。HUD、主导航、Harness 配色、SessionDetail、数据接口、时间轴语义沿用现有产品。

设计校准：视觉变化 7（重构空间布局）；动效 4（相机聚焦、有限交通与施工）；信息密度 8（全部可见会话有地址）；外部素材依赖 3（程序化几何 + 入库的 CC0 贴图，运行时零请求）；品牌保持 9（现有工作台控件与文字令牌）。街道使用深灰沥青、浅石色人行道，低饱和绿地和 Harness 建筑色。布局矩形与直线优先；圆角、字体、控件阴影继承工作台。相机聚焦约 850–900ms，首屏不自动旋转。

## 分层

```text
readSessions / readFindings / revision 失效事件
  → cityData.ts：分页、终页发布、加载上限、轮询
  → cityModel.ts：Session / Harness / Token / Finding 的视觉模型
  → cityLayout.ts：连续地形、街区、地块、道路图与地址分配
  → cityTextures.ts：共享地面图集、路面标线、立面、标签
  → cityParts.ts：渲染编排器（构造器、update 主循环、游标/动画；各系统见下节「引擎目录结构」）
  → CityEngine.ts：相机、生命周期、画质、上一版布局
  → CityPage.tsx：HUD、Replay、SessionDetail
```

## 引擎目录结构（`apps/agent-city/ui/src/engine/`）

2026-10-08 起 `cityParts.ts` 由 4430 行单体拆成编排器（约 1000 行）+ 下列模块；拆分是纯搬迁，行为不变
（整座城场景图哈希在每一步前后相等）。设计见 `CITY_ARCHITECTURE.md`、`CITY_ENGINE_SPLIT_SPEC.md`、`CITY_BUILDING_MODEL_SPEC.md`。

```text
engine/
├── CityEngine.ts           相机、生命周期、画质（对外 API 不变）
├── cityParts.ts            编排器：构造器、update 主循环、applyCursor、动画状态；其余方法是一行转发
├── cityPlan.ts             规划：地形 → 骨架 → 选址 → 路网 → 街区地块（纯函数、确定性，不依赖 three）
├── planner/
│   ├── constraints.ts      13 条规划约束的 measure（守卫与规划器共用）
│   ├── context.ts          RepairContext：修复步骤用到的规划闭包成员
│   ├── repairs.ts          修复手段（推开用地、车站贴路、绕行、断头延伸、岸边换位）
│   └── solve.ts            REPAIR_STRATEGIES 表 + solvePlan（目前按原顺序跑一遍）
├── systems/                按领域拆的渲染系统（host 接口 + 函数，cityParts 里留转发）
│   ├── terrainSystem / natureSystem / ambientSystem
│   ├── roadSystem / seasideSystem / civicSystem / landmarkSystem
│   └── buildingSystem（会话楼施工、屋顶件、皇冠、聚合楼、牌、背景楼）/ uiOverlays（标签、选中圈、拾取）
├── render/
│   ├── shared.ts           共享常量与几何辅助（BOX、CYLINDER、高架尺寸、mergeGeometries …）
│   ├── types.ts            BuildingRuntime / Car / NightLights 等共享类型
│   ├── facadeMaterial.ts   立面材质与窗光 shader
│   ├── nightLighting.ts    夜灯、日夜切换、夜间光照叠层
│   └── buildingCompiler.ts 声明式建筑（Part[]）→ THREE.Group，材质按 (role,color,side) 缓存
├── models/
│   ├── model.ts            BuildingModel / Part 类型
│   ├── registry.ts         LANDMARK_BUILDERS、BUILDING_MODELS（声明式）、UNPARADIGMED（白名单，上限 6）
│   ├── landmarkMaterials.ts 地标材质缓存工厂
│   └── landmarks/*.ts      每个地标一个文件（已声明式：tv-tower、pagoda、arch、sail-opera、lighthouse、ferris-wheel）
└── cityLightBudget.ts      灯光预算（窗光、路灯、霓虹、地标、环境、叠层）
```

依赖方向：`systems/`、`render/`、`models/` 不得 import `cityParts.ts`（cityParts 向下依赖它们）。

### 验证（`apps/desktop/ui-dev` 下 `npm run verify:city`，约 4 分钟）

- 守卫用 `scripts/city-kit/` 原生加载并在进程内缓存规划结果（原先 vm 沙箱约 25–30 分钟）。
- 三条基线哈希（`golden/city-{plan,landmark,scene}-baseline.json`）是重构的「零行为变化」证明：规划 30 岛、地标 21 个造型、
  整座城场景图（380/1600 会话 × 日/夜）。有意改规划/造型时才 `--update`，且先 `--diff` 审阅（反射性 `--update` 会让基线失去意义）。
- `verify-city-constraints / -solve / -models` 分别守卫约束模块、修复循环不劣化、声明式模型契约与白名单上限。

## 城市空间

- 全城共享一个高度场：平坦建设区、北侧山脊、西南向海岸。Harness 不再各自生成地形或圆形边界。
- 街区为 50 × 40 单位，分成两侧各 4 个沿街地块，中间保留院落绿带。建筑、裙房、屋顶使用地块朝向，不再朝向中心广场。
- 路网宽度只从 `engine/roadStandard.ts` 取：支路 / 次干道 / 主干道分别为 5 / 8 / 12 世界单位，高架桥面为 10.5；相邻街区共享节点和边。Harness 之间的空隙补齐路网，形成连通的道路图，空地保留绿地。
- 地面为全城单张 2048² 图集：地块硬化、街道、中心标线、斑马线、港区停车线。实体路缘、路灯、高架桥柱、港口仓库、集装箱和龙门吊合为一个 instanced mesh。
- 高楼优先分配到靠近中心的空地块，中低层沿街展开。分区含 downtown / commercial / residential / waterfront，目前影响铺地和建筑宽度；尚未实现完整的分区建筑资产库。
- 北侧高架及其两端下坡道、南侧码头提供城市方向感。高架和港口为装饰，不进入 Session 统计和拾取；高架暂未加入车辆道路图。
- 车辆沿道路图中的闭合街区回路行驶并偏置到车道，不再沿不可见的穿越线行驶。暂不模拟路口优先权、红绿灯或车辆避碰。

## 数据语义与稳定性

| 数据 | 表达 |
| --- | --- |
| Session | 一个主要建筑；超出模型独立渲染配额的会话仍按现有模型聚合 |
| Harness | 连续城市中的城区、标签和建筑色 |
| Token | 全局一致的对数高度映射：1e3≈3.4、1e5≈15.8、1e7≈38.6，最大 48；地标另沿用 1.12 倍强调。真实 token 统计不变 |
| Active | 施工估算和塔吊；不是实际任务完成度 |
| Finding | Harness 级信标，不能据此定位具体 Session |
| Time | 按 first_event 出现和线性插值施工；不再映射为中心向外的日环带 |

首次完整输入的布局不依赖数组顺序。引擎在当前页面生命周期内传入 previous layout，保留仍存在的 Session 地块；分页新增会话填充剩余地块，再向外扩建。Token 高度变化不移动建筑。

稳定性边界：地址缓存仅在内存中，不写 authority。重新打开页面与另一种分页到达顺序可以产生不同地址；不承诺跨窗口、跨启动地址一致。城区边界扩建时海岸、高架和港区会随城市外缘调整。旧街区在本次页面生命周期内保留空地，避免刷新时重排；这也意味着缩小时间窗后可能保留较大的街道范围。

布局容量由实际可渲染建筑数计算；每栋楼必须分配一个唯一地块，不再允许落位失败后静默跳过。地块大小对最大建筑轮廓预留道路间距。

CityLoader 每页都发布模型，包括无 next_cursor 的最后一页；达到 LOAD_CAP 且仍有后续页时发布 truncated 状态。第一帧可交互后仍会继续加载；使用者操作相机前自动适配扩建范围，操作后保持浏览位置。

## 成本与交互

- three.js 保持 React.lazy 独立分块。本轮构建 City JS gzip 约 160KB（含 three）。
- 建筑立面、屋顶、施工部件、树与基础设施批量实例化；单张 192² 分段地形替代多个岛屿高度场。
- 保留隐藏页面停 rAF、切页 dispose、约 12 秒空闲后 20fps、自适应画质与用户钉死档位。
- 700 栋浏览器合成数据预览观测到约 27 次绘制、交互期间 120fps；这是当前机器上的预览读数，不是跨设备性能保证或真机测试结果。
- 顶部控件保持单行自适应宽度，标签为屏幕尺度；城区聚焦、建筑拾取和 SessionDetail 沿用原交互。

## 验证

在 apps/desktop/ui-dev 运行：

```sh
npm run verify:city
npm run build:react
npx tsc -p react/tsconfig.json --noEmit
```

verify-react-city-layout.mjs 直接执行生产布局：空场景、单栋、700 / 1400 / 1480 栋、多 Harness；全量落位、地块唯一性、道路间距、路网连通、车辆循路、输入乱序确定性、500→1400 增量稳定性、Token 增长不搬楼。

verify-react-city-data.mjs 使用本地 authority 替身执行生产 CityLoader，覆盖 0 / 1 / 500 / 501 / 700 / 4500 / 5000 会话的终页发布、Token 合计和截断状态。

## 后续边界

当前已有弯曲网格、河道桥梁、公共设施和日落主题；完整立交寻路、更丰富的街区拓扑、住宅/工业建筑族和街面步行导航仍待完善。无需为这些装饰伪造业务数据；继续从 RoadGraph / Block / Parcel 演进即可。

## 2026-10-02：道路与自然地表优化

- 完整规划图 `roadEdges` 与展示图 `visibleRoadEdges` 分离：主干道、桥梁、公共预留街区和已占用街区周边道路可见，空置街区的支路与地块铺装暂不显示。纹理、路缘石、路灯、行道树和车辆共用展示图；不新增虚构会话楼。
- `developedBlockIds` 从当前已分配会话地块计算，不随回放游标变化。增量加载只扩展展示路网，不改变已有地址；切换时间窗可以收缩展示范围。完整图仍用于地块预留和布局连通性验证。
- 路缘石使用道路切线、法线和 yaw；共享道路等级按边界编号确定，不受相邻街区遍历顺序影响。转角地块按道路退距收紧宽深，保留中心和 ID。
- 平原草地不再误用沙滩高度阈值；公园、河岸植被按陆地退距、坡度、道路和建筑预留避让生成，额外的确定性公园采样避免小公园随机空缺。仍复用实例化植被，无新增下载或网络请求。
- 布局验证增加旋转矩形退距、多种种子的公园/河岸树木、道路局部坐标系、展示路网增量稳定性，以及车辆沿可见道路行驶检查。

### 公共设施补充

- 西侧住宅区预留社区学校：低层教学楼、球场、体育馆、围墙及校门，校园内部不允许城市道路穿行，校门步道接入周边道路。
- 货运港口统一使用规划港区位置，移除旧矩形边界外孤立的重复码头；双栈桥长度按种子海岸线计算，泊位设吊机、系船柱与落到海床的支柱，陆侧保留仓库、集装箱与道路入口。
- 学校和港口标签支持中英双语及现有隐藏标签开关，注明环境景观；它们不进入 CityModel，不计入会话数、token、回放生长或拾取详情。
- 新增公共预留用地会改变初次规划的可用楼址；后续同一规划内的分页地址仍保持稳定。测试覆盖 5 个种子的入口接路、校园避路和双泊位入水。

## 世界比例尺

1 世界单位 = 2 米（`apps/agent-city/ui/src/engine/worldScale.ts`）。凡有真实尺寸的物体（人、车、层高、树、路灯、船、沙滩小品、房子）
一律写成 `m(真实米数)` 或取 `REAL` 表里的参考值；按 1:1 米建模的几何整体乘 `METER_MODEL_SCALE`。不要再手写世界单位的魔数。
评估与对照见 `docs/CITY_SCALE_AUDIT.md`。
