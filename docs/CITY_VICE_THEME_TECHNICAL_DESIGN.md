# Vice City 海滨强化：技术设计（2026-10-05）

状态：修订设计稿，对应 [CITY_VICE_THEME_SPEC.md](CITY_VICE_THEME_SPEC.md) 的 B1–B5。以下接口为拟议设计，不是现有 API；实现前通过样板与测试确认。

范围：City 插件规划、渲染、主题与镜头；不修改 Rust/SDK 数据投影，不改变会话、token 或活跃状态语义，不实施游戏模式。

## 0. 源码基线与已知事实

实施前记录 Git commit、dirty diff 和插件构建版本；引用函数而非依赖易变行号。

- cityPlan.ts 的 coastDistance 使用 721 项 radiusTable，经过形状变换和保守缩放；是 O(1) 近似净空计算，不是到实际岸线的最短距离。
- createCityPlan 当前由 cityLayout.ts 以 (seed, tier) 调用；新增配置不能丢失规模等级。
- 当前有随机生态带、waterfront 分区及地形净空规则，但没有直接可用的公开沙带契约。
- cityParts.ts 的 installGroundDetail 使用 vCityWorld、RGB 分类及海拔湿度启发式。
- facadeFor 对 waterfront、高度 ≤36、非 landmark 使用 Deco；实施前测实际命中率。
- flora 加载后使用 floraMeshes，并隐藏基础 treeMesh；列植必须接入真实 flora 与回退路径。
- 建筑 neonMesh 已按 palette.accent 着色；公共设施 nightLights.neon 是另一条需独立核对的灯光路径。
- citySky.ts 与主题存在独立配方；主场景、天空图、水面、生态带和天气叠加顺序需一起核对。
- cityLayout.ts 有 plans 缓存，cityParts.ts 有 staticCityCache；两层都需要配置身份与失效策略。

## 1. B1 海滨规划契约

### 1.1 配置与坐标

保留 createCityPlan(seed, tier, config?)，或迁移为含 seed/tier 的 options；所有调用方统一。由插件装配层传入 miami-coastal 配置，规划纯函数不读取活动主题或 UI 状态。

拟议类型：

```ts
type CoastalConfig = {
  profile: "miami-coastal";
  version: number;
  biome: "tropical";
  maxUrbanSlope: number;
  maxCoastalTerrainHeight: number;
  targetSegmentCount: number;
};
type CoastalSample = {
  id: string;
  segmentId: string;
  shoreline: Vec2;
  tangent: Vec2;       // 沿海岸的单位切线
  inlandNormal: Vec2;  // 朝陆地的单位法线
};
type CoastalPlacement = {
  id: string;
  sampleId: string;
  role: "beach" | "walkway" | "boulevard" | "hotel";
  position: Vec2;
  groundY: number;
  yaw: number;
  clearance: number;
};
```

全局 x/z、yaw 与现有布局约定一致；世界单位沿用现有引擎。法线由岸线相邻采样点计算并用陆海测试校正方向，不用径向替代不规则岸线法线。对重复点、闭合接缝、尖角及偏移线自交提供检测。

每条偏移线分别采样地形高度和坡度；不复用单个 groundY。距离取值在样板中确定，不能用 +10/+14/+26 的含糊偏移代替明确宽度。

### 1.2 规划顺序与容量

1. 生成海岸、运河和基础地形。
2. 按稳定采样 ID/hash 选择合法连续街段；南向是候选偏好，不是所有 seed 的硬假设。
3. 生成沙带、棕榈步道、大道及酒店地块，并保留连接与公共设施净空。
4. 生成其余街区、道路及公共设施，统一检查占地冲突。
5. 按现有稳定分配规则放入数据建筑；装饰仅使用明确预留区域。

排除沙带不等于形成酒店街：必须输出带入口方向的酒店地块，验证其宽深适配及与大道的步行联系。

面积预留会减少可用会话地块；测试大量会话的容量、聚合/溢出行为和计数守恒，不得静默丢数据。新配置首次启用可以重建视觉布局，但同配置增量更新须保持已有建筑落位；两种场景分别定义并验收。

无合法街段时确定性缩短或减少段数并输出诊断，不允许无限重试或强行穿模。至少 20 seed 测净空、接缝、自交、坡度、容量与降级。

## 2. B2 地表纹理编码与沙滩 shader

### 2.1 数据契约

不把规划的近似净空直接当作真实岸线距离。为选定海滨街段计算有符号距离 d：陆侧正、海侧负；烘焙范围有明确世界 AABB，距离编码范围独立。

第一版采用一张 RGBA8 数据纹理：

| 通道 | 含义 |
| --- | --- |
| R | clamp(d / distanceRange, -1, 1) × 0.5 + 0.5 |
| G | 海滨沙地允许权重；排除道路、人行道、酒店与非目标岸线 |
| B | 陆地覆盖权重，来自实际陆海分类 |
| A | 样本有效性；边界外/无合法采样为 0 |

初始分辨率 512²，是否足够由世界范围对应的 texel 尺寸判断；RGBA8 CPU 原始数据约 1 MiB，显存实际开销需测量。量化误差、过滤误差必须小于可接受岸线过渡宽度，否则调整格式/范围/分辨率。

使用 NoColorSpace、关闭 mipmap、ClampToEdgeWrapping。距离可线性过滤；分类采用保守权重并检查边界渗漏。创建格式与材质采样在浏览器和原生 GPU 分别验证。

### 2.2 采样与分层

以下示意需接入现有 vCityWorld 与 uniform；不可照搬成完整 shader：

```glsl
vec2 uv = (vCityWorld.xz - uCoastMin) / uCoastSize;
float inside = step(0.0, uv.x) * step(uv.x, 1.0)
             * step(0.0, uv.y) * step(uv.y, 1.0);
vec4 coast = texture2D(uCoast, clamp(uv, 0.0, 1.0));
float d = (coast.r * 2.0 - 1.0) * uCoastDistanceRange;
float allowed = inside * coast.g * coast.b * coast.a;
float wet = allowed * (1.0 - smoothstep(uWetInner, uWetOuter, d));
float dry = allowed - wet;
```

湿沙靠水，干沙靠内陆。浅水颜色/泡沫由水面路径消费对应海岸数据，不把海侧地面染成沙滩。G/B/A 的生成与滤波必须保证海侧不会因 clamp 或边缘混合变成沙地。

海滨内替换原沙/泥权重，与其他地表权重归一化；过渡外保留 RGB 回退路径，不叠加两套沙材质。uDetail 尚未就绪时保留基本色，确保无照片纹理也可辨干湿层次。

程序噪声使用世界尺度与导数 LOD；近景颗粒、中景沙纹、远景岸线分级，具体尺度通过截图决定。不默认扩张地面图集。检查黑缝、z-fighting、摩尔纹、运动闪烁及纹理方向。

## 3. B3 大道、步道与棕榈

大道与步道是不同对象：

- 海滨大道：沿用可通车道路语义，包含标线、路缘、路口与连接线，进入车辆路径。
- 棕榈步道：独立 pedestrian path/polygon 契约，铺装与树列，不进入 carPaths。第一版优先不扩展 RoadEdge.kind，避免将步道误当机动车道路。
- 若确需新增道路种类，列出并更新 roadPaint 链合并、路口、桥梁、carPaths、公共设施、行人与所有测试消费者，不假定自然兼容。

连接线须落在合法陆地、满足坡度与宽度，不只是节点拓扑连通。检查酒店入口、过街位置和步道断点。

棕榈候选记录稳定 ID、物种、位置、根部高度、yaw、scale。整合到 floraMeshes 的真实实例管线，同时支持 treeMesh 回退；每种几何/材质通道分别统计容量与 draw calls，不承诺零新增开销。

树列间距和视线净空随世界尺度定义，避免固定 30 单位禁植吞掉小街段。树根、树冠、入口和道路分别检查；节能档降低密度但保留主要树列。

## 4. B4 酒店原型与附件生命周期

- 数据建筑继续使用原 token 高度；街区决定酒店/公寓/办公原型，Harness 色保持可辨。
- 低中层海滨楼强化圆角、阶梯檐口和水平遮阳；高楼强化裙房，不截断数据高度。
- 每种附件先输出 attachmentPlan，记录类型、实例数量、挂点与目标尺寸。容量按所有建筑计划求和，不使用“命中楼数 ×2”代替楼层附件数量。
- 给每楼遮阳带/阳台设置上限，超过上限使用立面纹理；满容量时确定性降级，不写越界实例。
- 纯装饰酒店使用独立 DecorativeHotel 记录和实例批次，不伪造 CityBuilding，不进入 BuildingRuntime 数据拾取、统计与会话下钻。
- 数据建筑附件需分别定义 display=0、施工中、封顶的显隐和位置，挂点依据当前施工高度；不能仅把最终附件统一缩放。
- 配套 apply/hide/instanceMatrix 更新、颜色更新、增量刷新和 dispose；主场景与后台导出使用同一原型及附件计划。

## 5. B5 分时主题、天气与镜头

主题提供 day/dusk/night 各自的天空、水面、光照和窗光参数，或提供完整端点推导规则；不把同一套主题色灌入所有时段。

由 skyStateAt(hour, theme) 插值明确端点，保留当前关键帧时间与昼夜语义。依赖类型可抽到独立类型模块，避免 theme/sky 循环导入。

应用顺序固定并测试：

1. 根据实时、回放或航拍时钟选取小时。
2. 分时主题生成基础天空、水面和光照。
3. 按明确定义的范围叠加生态带色彩。
4. 幂等天气调制；夜灯门控用未受天气误判的时段状态。
5. 上传天空贴图调色、水面、雾、灯光等 uniforms。

白天/日落/夜晚不能因主题统一失去区别。天空贴图与 shader 调色需联调，不宣称一处调用修改即可自动一致。后台导出审计所有调用入口及 worker 可用性。

默认镜头从选定海滨段生成目标、视线与距离，兼顾酒店街和城市包围范围。仅初始化/明确重置时使用，resize 与增量刷新不覆盖用户镜头。对窄窗口、建筑遮挡、无合法街段提供回退镜头；航拍路线消费相同海滨锚点但保持现有时间可复现规则。

## 6. 缓存、资源与契约

- plans 缓存键包含 seed、tier、profile、配置版本及影响几何的规范化参数。
- staticCityCache 校验规划身份、海滨配置、材质版本与现有影响项；动态建筑附件不错误缓存为静态景观。
- shader 注入结构变化检查 customProgramCacheKey；仅 uniform 变化不无谓重编译。
- 数据纹理、附件几何/材质、flora、导出资源明确拥有者与释放时机，共享资源不重复 dispose。
- 配置切换清理旧规划缓存或采用有界缓存，防止无限增长。配置对象属性顺序不能影响规范化键。
- 测同 seed 不同配置版本不复用旧结果，相同配置增量更新不重建静态城，返回旧配置不使用已释放资源。
- no config 路径如需兼容旧规划，保留单独测试；兼容默认函数签名不代表生产视觉布局完全不变。

## 7. 实施顺序与验收

| 阶段 | 交付 | 完成条件 |
| --- | --- | --- |
| T0 | 海岸坐标、地表编码、道路/步道纯函数与契约 | 单测含方向、归一化、海陆边界、净空及降级 |
| T1 | 单段海滨样板：酒店—大道—棕榈—沙滩 | 实际近/中/全景截图，基础空间关系成立 |
| T2 | 昼夜与默认镜头、规模/多 seed 扩展 | 不依赖 bloom、容量守恒、布局稳定 |
| T3 | 浏览器/原生/照片/视频及资源验收 | 按主题 spec §7 提交完整证据 |

B5 可在契约明确后独立试验，但不能仅凭水色改动宣布主题完成。不承诺固定“一周”；各阶段依据实际原型、消费者数量、性能和验收安排更新估算。

回归包含 City typecheck、verify:city、verify:react 及新契约测试。至少 20 seed、少量/大量会话、输入重排、增量更新、附件容量、昼夜门控、缓存失效与资源释放均须验证。

截图固定 commit/dirty diff、构建、设备、窗口/DPR、数据、seed、时间、天气、画质与镜头；覆盖白天/日落/夜晚、普通/节能、宽/窄、中英文以及近/中/全景。原生测试正式 bundle，浏览器不读取真实用户数据。

性能按主题 spec §6 记录前后 FPS、p50/p95 帧时间、draw calls、triangles 和资源数量；测反射/阴影/后处理，不以 instancing 推断开销。10 次 seed 重建及至少 3 次导出/取消后检查资源稳定。

识别测试保持至少 5 位未参与开发者，每个时段目标至少 4 位识别迈阿密/80 年代热带海滨。人员不可得标记未完成，不降低到 3 人。静态图不能证明没有瞬时闪白，resize/侧栏需交互或录屏独立验收。

## 8. 风险与停止条件

- 不规则岸线偏移自交或无空间：缩短/减少街段，保留明确诊断，不强行摆放。
- 预留导致地块不足：检查现有聚合/溢出，保持计数诚实，不能丢会话。
- 纹理精度不足、海侧渗漏或 shader 平台不兼容：调整编码或回退基本材质，记录未完成项。
- 装饰影响识别数据建筑：改独立样式/位置，不混进 Session 数量。
- 多层缓存或资源生命周期失败：先修复再扩展全城。
- 原生、导出、盲测或性能证据缺失：不得标记整体完成。
