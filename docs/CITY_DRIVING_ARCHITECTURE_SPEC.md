# Agent City 驾驶代码架构设计

日期：2026-10-15。修订：加入道路通行自动审计与真实模拟试跑闭环。状态：待实施架构设计；未声明城市驾驶通过验收。
基线：`1fecf7d7`（含 `d98c5aa5` 合成试驾）；上位：[驾驶产品 SPEC](CITY_GAME_VEHICLE_MODE_SPEC.md)。现状证据：[合成试驾记录](CITY_DRIVING_SPIKE_NOTES.md)；调研纠错见本文 §2。本文收敛技术实现，不增加首版玩法范围。

## 1. 核心决策

1. 保留轻量 bicycle/arcade 动力学；首版不引入 Ammo、Rapier 或 cannon-es。是否使用刚体与是否使用三角路面是两个独立决定。
2. 新增共享 `RoadSurfaceCompiler`：渲染与驾驶消费同一份有身份的路面三角形和拓扑语义。查询采用三角面重心插值，边界采用有语义的多边形/线段。不维护第二套按中心线推测的高程。
3. 驾驶世界是纯 CPU、不可变的局部快照；无 THREE、DOM、React、数据库、Rust IPC。空间索引与道路图是进程内数据，不持久化，不通过插件端口发送。
4. 将当前飞机 `GameSession` 渐进拆成共同的 `GameRuntime`、兼容飞机适配器和汽车适配器；CityEngine 继续拥有唯一 renderer、rAF 与相机所有权。
5. 坡度来自支撑面法线；擦碰来自连续检测的接触法线。侧倾动画与左右探针不作为动力学证据。
6. 道路开放依赖版本绑定的三层审计（拓扑、几何、真实模拟试跑）；控制器失败与道路阻塞分开报告。未覆盖、取消、超预算或过期结果不能算通过。
7. 首版仅自由驾驶；成绩档案、配送、漂移、手刹、驾驶员、翻车和悬挂不进入本轮。城市路网可玩性验证优先于音效和手感扩展。

## 2. 调研复核及取舍

固定上游证据（2026-10-15 重新拉取源码；只读研究，本次未移植）：

| 来源 | 核对结论 | 架构取舍 |
| --- | --- | --- |
| [Three.js-City Car.js @ c656784](https://github.com/mauriciopoppe/Three.js-City/blob/c65678445ffc23a3de777607720a8decdd58c2a5/T3/js/model/Car.js) | `tilt()` 用 speed × 前轮转角生成转弯侧倾；`move()` 把其绝对值送入 computeSpeed，减速项未乘 delta。不是道路纵坡；旧调研 §2.1 的等价判断错误 | 不照搬该项。按当前支撑面计算有符号纵坡和固定步重力；梯形距离积分可独立评估，不视为必然更稳定 |
| [HexGL ShipControls.js @ 6addc95](https://github.com/BKcore/HexGL/blob/6addc95a2fce3bf05f4d751823cc054c61a16d68/bkcore/hexgl/ShipControls.js) | 速度平方项用于 shield；实际速度衰减另算；左右掩膜探针产生启发式排斥 | 可借反馈强弱思想，不替代连续碰撞/法线求解。首版无护盾语义 |
| [web-racing track.js @ 49d3db2](https://github.com/MankyDanky/web-racing/blob/49d3db2b11585ab3ab4dc0e424f58d50256a8a27/frontend/src/modules/track.js) | 世界空间顶点、索引偏移、非索引 mesh 转为 Ammo triangle mesh | 借同源面和坐标校验；不遍历全城可见 mesh 当路面，不因需要三角面而引入 Ammo |
| [web-racing car.js @ 49d3db2](https://github.com/MankyDanky/web-racing/blob/49d3db2b11585ab3ab4dc0e424f58d50256a8a27/frontend/src/modules/car.js) | 回正/换向与打入采用不同速率 | 作为后续版本化参数 A/B，不在道路接入批次顺手改默认手感 |
| [web-racing gates.js @ 49d3db2](https://github.com/MankyDanky/web-racing/blob/49d3db2b11585ab3ab4dc0e424f58d50256a8a27/frontend/src/modules/gates.js) | 下一门淡入、距离触发、Date.now 计淡入；通过分支未实现旧门渐隐 | V3 只借聚焦提示；继续采用连续穿越判定，动画用模拟/展示时钟，不搬墙钟计时 |

掩膜可以确定性测试，解析几何不天然“确定性最高/内存最小”。本方案按同源性、层级语义、维护与可诊断性选择 CPU 三角面+拓扑；性能由固定夹具测量。覆盖热力图是验收辅助，不能证明轮胎覆盖、桥头可达或无碰撞。

Three.js 官方 [BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html) 区分 indexed/non-indexed triangles 与 attributes；编译数据只向渲染适配器提供数组。官方 [Raycaster](https://threejs.org/docs/pages/Raycaster.html) 按对象 raycast 实现检测，且受面朝向影响，因此它可用于有限相机遮挡，不作为权威道路支撑查询。固定时钟参考作者原文 [Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/)，仍以现有 1/60、每帧最多 5 步、长帧暂停契约为准。

许可表沿用本次固定版本根目录记录（Three.js-City Apache-2.0；HexGL/web-racing MIT），不覆盖第三方模型/声音/贴图的单独授权。真正移植前登记具体文件、commit、改动与适用通知，不以仓库总许可证替代资产核查。

## 3. 源码现状与接入点

| 当前文件/接口 | 已有事实 | 要做的最小变化 |
| --- | --- | --- |
| `engine/systems/roadSurfaceSystem.ts::roadSurfaceGeometry` | 输出普通道路、填充与人行道层的顶点/属性；调用 renderRoadEdges、roadPaintPlan、roadJunctionPlan；内部仍依赖 THREE.Color 与渲染 system | 抽纯编译器，保留旧函数转接；将路面语义绑定到三角形，不能把五个绘制层当五个高度层 |
| `engine/systems/terrainSystem.ts::terrainSurfaceHeight` | 按渲染地形网格三角形插值，不等于直接读 terrain.height | 提取纯地形采样/缓存；道路支撑最终仍取路面三角形插值，因为路面自适应细分后不必精确等于连续地形函数 |
| `engine/systems/roadSystem.ts::buildInfrastructure` | 桥面单独用底面为原点的 BOX 构造；当前取 edge.points 前两个点，桥面顶由端点地形最大值决定 | 抽 bridge deck descriptor 和连接证据，先保持可视几何；多点桥或无合法落地连接须拒绝开放 |
| `engine/render/shared.ts::expresswayDeckHeights` | 返回桥面板底高，不能直接作为汽车支撑高度 | 抽纯剖面/结构常量；实际行车面按 BOX 顶面和实例缩放、YZX 旋转、平移变换得到 |
| `roadSystem.ts::buildDistrictExpressways` | 短于 6 的段跳过绘制；板厚 0.9，存在倾斜 BOX 与重叠长度 | 支撑只采用实际生成的顶面；不能凭 highways 折线补造可通行段。梁底/护栏/桥墩分别归类 |
| `CityEngine` | currentLayout 是已套修复补丁的显示布局；有唯一 gameFrame hook、相机接管和挂载接口 | 新增专用游戏场景 lease 门面；取得同版本显示/物理快照，释放时重放最新待更新投影 |
| `GameSession / useCityGame` | 运行时与飞机对象绑定；React 已有 Esc 捕获、context lost 退出、档案端口 | 先包飞机适配器，逐步移动共同逻辑；输入命令只能有一个所有者，不能叠加 DrivingInput 的 Esc 处理 |
| `DrivingWorld / DrivingSimulation / drivingPreview` | 矩形 patch、小世界线性查询、碰撞整步拒绝、开发独立 rAF | 保留合成夹具；实现可替换 Query/Contact 接口。开发 rAF 留在 dev shell，不进入生产运行时 |

重点核查：相机 owner=game 并不自动证明所有布局更新、手工修复、天气/海平面、宿主投影都冻结。进入前必须建立统一 lease；不能只冻结碰撞对象而让可视城市重建。

## 4. 目标模块与依赖方向

建议目录（模块都是新增目标，非宣称已存在）：

```text
engine/surface/
  types.ts                 CPU buffers、语义、连接、身份版本
  terrainSampling.ts       原地形三角采样纯逻辑
  groundRoadCompiler.ts    普通路带、路口、尽端、人行区域分类
  structureCompiler.ts     桥/高架实际实例顶面与结构障碍
  compileSurface.ts        聚合可视几何与驾驶语义；一次编译
engine/systems/
  roadSurfaceSystem.ts     接收 compiled buffers，创建 GPU 对象
  roadSystem.ts            接收结构 descriptor，创建 GPU 对象
engine/gameSceneLease.ts   CityEngine 内部协调，不暴露为插件消息

game/runtime/
  GameRuntime.ts           状态机、固定时钟、暂停退出事务
  GameScenePort.ts         窄宿主能力；不返回整个 CityEngine
  VehicleAdapter.ts        准备、步进、插值显示、资源释放
  FlightAdapter.ts         兼容现有飞机/任务/成绩
  CarAdapter.ts            编排驾驶 world/sim/visual/camera
  GameInputRouter.ts       命令键统一路由；载具只消费自己的持续输入

game/driving/
  types.ts                 支撑/接触/快照契约，纯数据
  buildDrivingSnapshot.ts  路面准入、障碍、开放图、预算诊断
  SurfaceIndex.ts          XZ 网格 + 局部 triangle bins
  SurfaceQuery.ts          分层、重心插值、覆盖与连接验证
  CollisionIndex.ts        建筑/护栏等 broad phase
  DrivingCollision.ts      swept OBB、TOI、接触法线和滑动
  DrivingSimulation.ts     固定步纵向速度/转向/坡度动力学
  SafeRecovery.ts          出生、最后安全点、复位候选验证
  DrivingCamera.ts         有限场景遮挡、近裁面约束
  drivingParams.ts         物理参数/规则版本；无单位混用
  DrivingKernel.ts         手动驾驶与无渲染试跑共用的一步模拟入口

game/driving/audit/
  contracts.ts             用例、覆盖、证据、版本与状态契约
  RoadAuditPlanner.ts      冻结候选图、双向路段/转向/桥坡用例清单
  RoadPassabilityAudit.ts  拓扑与独立几何可通过性检查
  RoutePilot.ts            路径跟踪/速度规划，仅输出归一化驾驶输入
  DrivingRouteRunner.ts    固定步调用同一个 DrivingKernel，不移动位姿
  AuditObserver.ts         无进展、越层、违规接触、完成和预算检查
  AuditAttribution.ts      分类道路阻塞、控制失败、模拟失败、未确认
  AuditScheduler.ts        分块执行/取消/过期丢弃；不占用游戏相机
  AuditEvidenceStore.ts    进程内结果/有界失败片段；生产不持久化轨迹
  AuditReleasePolicy.ts    按当前 key 与覆盖清单生成正式开放图
  auditFixtures.ts         CI 合成夹具与已知坏路注入定义

game/CarVisuals.ts          保留当前模型 API
  carDimensions.ts         保留共享尺寸
```

依赖方向：规划/显示布局 → surface 编译 → 纯驾驶 world/query/collision → simulation；runtime 通过 adapter 编排；视觉消费插值状态，React 消费低频快照。纯模块不得 import engine/system、three、React、host.ts 或 data provider。编译器可以 type-only import CityLayout；底层几何叶子不能反向运行时 import cityLayout/cityPlan，避免现有 planner 环循环。

审计编排只依赖冻结 snapshot、纯 DrivingKernel 和参数，不 import CarAdapter/GameRuntime/THREE；审计 UI 只读结果。可视试跑是该 runner 的播放适配器，不是另一套模拟。

不创建新的 Rust crate、第二个 CityEngine、通用插件总线或通用 ECS。迁移初期旧路径用 re-export/包装保持调用点稳定，最终移除双实现。

## 5. 共享 Surface 数据契约

```ts
type SurfaceKind = 'carriageway' | 'junction' | 'bridge-deck' | 'ramp'
  | 'expressway-deck' | 'sidewalk' | 'island' | 'decor';
type SurfaceRevision = string; // 进程内版本身份，不对外发布
interface SurfacePatch {
  id: string;
  kind: SurfaceKind;
  layerId: string;             // 几何高度层，不是 shader/material 分组
  vertices: Float32Array;     // XYZ，世界坐标；与渲染共享相同量化值
  indices: Uint32Array;       // 向上顶面的三角形；无材质组含义
  boundaryLoops: readonly BoundaryLoop[]; // 外环/孔洞、driveable/curb/closed 标记
  source: SurfaceSource;      // 内部 road edge / junction / structure 身份
}
interface SurfacePortal {
  id: string;
  fromPatch: string; toPatch: string;
  fromBoundary: BoundarySpan; toBoundary: BoundarySpan;
  permittedDirection: 'both' | 'forward';
  clearance: number;
  maxHeightMismatch: number;
  validated: boolean;
}
interface CompiledCitySurface {
  revision: SurfaceRevision;
  geometryVersion: number;
  patches: readonly SurfacePatch[];
  portals: readonly SurfacePortal[];
  renderBatches: readonly RoadRenderBatch[];
  report: SurfaceCompileReport;
}
```

`BoundaryLoop/BoundarySpan/SurfaceSource/RoadRenderBatch/SurfaceCompileReport` 为后续 contracts.ts 中的具名类型，不能以 `any` 落地。Report 至少有候选/开放路长、结构排除原因、未闭合边界、退化三角形、非法高差、预算耗尽和共享几何校验结果。

编译器按稳定 road/structure ID 排序；生成连接而非凭 XZ 相交连边。路口来自已接受路网与真实填充形状，不取交叉道路宽度之和。着色重叠面按明确优先级去重或保留等高 alias，不能让几何重叠随机决定 surfaceId。岛、人行道不进入驾驶支撑候选；结构缺乏基础几何/连接证据时标为 unsupported。编译器只输出候选图及几何排除原因，不自行认证通行。正式关闭入口由 §11 的开放策略产生可见护栏/提示与同源碰撞边界。

TypedArray 的 readonly 接口不等于字节不可改。编译产物由 SurfaceStore 单一拥有，仅发布只读视图约定；禁止 simulation/renderer 原地修改共享数组。worker 如后续使用，transfer 的所有权和取消结果必须明确，不能 transfer 后让活跃 renderer 读 detached buffer。首版不要求 worker。

### 5.1 普通路与结构的采样规则

- 普通路带、路口、换宽、圆角、尽端回车区都通过相同编译器生成；路缘/渠化岛有物理边界，人行道不作为额外车道。
- 路面高度查真实三角平面，动力学法线取几何法线，不能用平滑光照法线代替；视觉平滑可独立进行。
- 高架 BOX 底面为局部 y=0，顶面 y=1；对顶面顶点应用现有实例矩阵，不能仅 `deckHeights + thickness` 猜整条曲面。拼接处检测几何缝、重叠与坡变；未通过则关闭。
- 同一 layerId 只表示层归属，不自动允许互通；不同 layerId 可以通过已验证 ramp portal 连接。桥上/桥下平面投影重合不会自动切换。
- 驾驶所需碰撞与支撑不能随渲染质量档、视锥裁剪、灯光或隐藏 mesh 改变；显示规划裁剪/修复会改变 revision，必须同帧重编或延迟更新。

## 6. DrivingWorld 查询与空间索引

```ts
interface SupportRequest {
  pose: GroundPose;             // XZ + heading + 上一支撑高度
  previous: SupportHandle | null;
  footprint: VehicleFootprint;
  travel: SweptMotion | null;   // 正常移动必须给出，出生走单独入口
}
type SupportResult =
  | { ok: true; center: SurfaceSample; wheels: WheelSupport4;
      support: SupportHandle; geometricNormal: Vec3; pitch: number; roll: number }
  | { ok: false; reason: 'no-surface' | 'ambiguous-layer' | 'unsupported-footprint'
      | 'closed-portal' | 'excessive-step' | 'excessive-slope' | 'query-budget';
      lastValidFraction: number };
```

Handle 含 surfaceRevision、patchId、triangleId、最近 portal 身份；旧 revision handle 立即失效。出生由显式 patchId 开始；不在多层候选里“选最高/最近”掩盖歧义。

查询先查上一 triangle 的邻接，再查 portal 和空间索引局部候选。重心插值对共边设置固定 epsilon 和稳定 ID tie-break；退化三角、NaN、预算溢出失败关闭。网格大小先以道路宽度和夹具分布调试，不承诺统一 O(1)；超长三角不得展开到无限格，索引构建和候选查询均有上限，报告实际最大/P95 候选数。

四轮接地用于姿态，但“四轮+车体角点都在路上”不足以证明覆盖：车体可能跨过三角孔洞或窄岛。完整准入需将车体投影与该层合法多边形 union 做覆盖/禁区相交检测，并约束运动跨越的 portal。首版不允许未经定义的路肩；几何缝的容差不得成为跳过真实缺口的许可。

支撑姿态以四轮高度拟合，残差过大/轮距高差超限时拒绝，不强行把车贴到异层。支撑函数查询不执行 GPU raycast，不读取可见 mesh 或全城扫描。

## 7. 碰撞与滑动

障碍源为当前显示建筑的实际朝向 footprint 和冻结显示高度、地标、护栏、桥墩、封闭入口；用垂直区间先筛选，避免同层标签不足以表达桥墩穿越多个高度层。优先有向凸包/OBB，AABB 只作 broad phase；不复用飞行世界的大包络盒堵住街道。

```ts
interface Contact {
  obstacleId: string;
  toi: number;                // [0,1] 归一化命中时刻
  point: Vec3;
  normal: Vec3;               // 指向自由空间，几何法线
  kind: 'solid' | 'curb' | 'closed-boundary';
}
interface MotionResolution {
  accepted: VehiclePose;
  support: SupportHandle;
  contacts: readonly Contact[];
  actualSignedDistance: number;
  residual: Vec2;
  outcome: 'clear' | 'sliding' | 'stopped' | 'recovery-needed';
}
```

流程：候选 swept bounds → 连续检测 → 移至 TOI 前 skin → 对剩余位移去掉入射法线分量 → 再扫掠/校验支撑；最多 3 次接触迭代，处理两墙夹角后仍有残余则停止。三角/边界命中同时发生按 TOI + 稳定 ID 排序。旋转用有上限的角度分段与保守包络，不能只测末态；时间/候选预算耗尽停在最后合法位置。

支撑边界与固体接触统一进入求解：每次滑动后重新验层/portal/完整覆盖，不能“沿墙滑”滑出桥面。速度反馈按实际位移和被消除的法向速度计算，切线分量保留；正撞停住。不要在任何 blocked 状态一律 speed=0；也不要靠最小排斥量把车瞬移到另一侧。初始重叠不随机推出，交给 SafeRecovery。

## 8. 模拟、坡度与车辆状态

保留单一 scalar longitudinalSpeed + heading/steering；首版无漂移横向自由度。碰撞滑动产生实际位移，但不引入可持续的漂移速度状态。渲染 wheelDistance 仅累计实际有符号行驶距离，复位不累计瞬移距离。

每一固定步：

1. 读取已归一化输入，W+S 制动、A+D 回正。
2. 从当前几何支撑算沿车头的坡角，计算 `aSlope = -gravityGame * sin(pitch)`；坡角为车头方向定义，倒车不再乘一次 speed 符号。
3. 动力、制动、滚阻与坡度按 `dt` 积分；制动只抵抗运动，不在零速制造反向速度。W/S 先刹停再换向规则保持。
4. 静止且明确制动时提供有上限的 holding brake；松键允许受版本化滚阻/重力规则影响。是否自然溜坡通过验收，不使用动画 bodyPitch 参与重力。
5. 用有界速度/转角计算期望 heading 与平面位移，再调用支撑+碰撞求解；跨坡面需预测当前步支撑，避免始终用上一帧坡度。
6. 用 accepted pose 和实际位移更新状态，拟合四轮支撑姿态；分离 `supportPitch/roll` 与 `visualBodyPitch/roll`。

速度定义统一为沿路面切向的游戏单位/秒；在坡角非零时，平面位移按 cos(pitch) 投影，轮滚动按真实支撑路径长度累计。禁止一处以 XZ 长度当速度、另一处又按三维路程计速。对 pitch 大跳/支撑断开拒绝移动，不模拟飞跃。

`physicsVersion / surfaceGeometryVersion / collisionRulesVersion` 独立；动力学变化更新自己的版本，不改飞机版本。回正不对称、音调和漂移放后续校准批次；音频是状态消费者，不能影响时钟或物理。

## 9. 生命周期、快照与输入所有权

### 9.1 场景 lease

`GameScenePort.acquire(request, signal)` 获取统一 revision 的生效布局、可视 building 高度、回放游标、surface 快照与返回状态；这是进程内专用能力，不暴露数据端口。返回 `GameSceneLease`：

- `revision`、只读 snapshot、挂载/卸载游戏对象、帧 hook 注册、camera pose 提交、环境车可见性覆盖。
- 显式 `release()`：清 hook → 清输入/资源 → 恢复环境状态与相机 → 解冻/应用最新 pending 投影 → 按仍存在的选择恢复 UI → 发一次刷新。
- 内部以 lease token 校验当前活跃拥有者；旧会话不得清掉新会话 hook 或归还它的相机。进入准备时捕获 ReturnState，准备失败/取消同样释放。
- pending 只保存最新合法 revision，不积累每次全城副本。资源编译完成后再次检查 runId、signal、revision；过期结果只释放不挂载。

天空/灯光可持续动画，建筑生长/规划修复/路面水位等影响支撑或障碍的变更冻结到退出。官方内置插件仍走原来的授权与投影；lease 不赋予日志、DB 或新敏感字段访问权。

### 9.2 GameRuntime 和适配器

使用辨识联合：`plane/practice`、`plane/race`、`car/free`；不要让 `car/race` 在任务未实现时可构造。旧 `enterGame(mode)` 保留飞机包装器，再新增 `enterDriving()`；飞机 profile 格式保持。

Runtime 唯一拥有 GameModeController、runId、固定累加器、输入命令、相机 lease、退出事务。适配器只提供 `prepare / fixedStep / present(alpha) / reset / dispose`，不拥有 rAF、状态机或插件存档。准备可取消，dispose 幂等；adapter 不反向调用 runtime 状态迁移，而返回 typed events/error。迁移中的 FlightAdapter 可短期包旧会话作为兼容外观，但不得同时启用新旧两个控制器/固定步循环；只有共同生命周期抽出后才切换 GameRuntime 为实际所有者。

Esc/R/暂停/恢复由统一 GameInputRouter 路由一次；持续 WASD 由载具映射。现有 useCityGame 捕获 Esc 与 DrivingInput 的 Esc 不能并存。canvas 失焦、宿主隐藏、组合输入、菜单与长帧都清键；长帧丢弃累加时间并暂停。context lost 按现有实现退出回数据模式，不宣称无损继续。

Runtime 每固定步输出模拟状态，每渲染帧插值姿态；HUD 最多 10Hz。相机只读插值状态，其遮挡查询使用不可变障碍和近裁面体积裕量，不能只用一根中心 ray 当防穿墙保证。reduced-motion 禁止 shake/FOV 冲击，基础跟车仍必须可用。

## 10. 安全出生、复位与诊断

SafeRecovery 对审计后的正式开放图按稳定 ID 生成候选：足够路宽、坡度、曲率、净空和可玩连通长度；复用完整 footprint/support/collision 查询，不能仅保证车中心净空。车位与相机候选都要检查。

仅连续多个固定步合法支撑/无碰撞/非封闭端口时更新 lastSafe；保存 pose + handle + revision，不记录历史轨迹。R 优先 lastSafe → 当前分量安全候选 → 初始 spawn。每次重新校验，无候选则暂停错误面板，可退出，不制造合成道路。

合成夹具可输出结构化诊断与回放；真实本机场景的诊断仅在当前 City 本地展示并暂存在内存，不自动写文件。候选/开放长度、拒绝原因、查询候选数、接触迭代、帧 CPU、版本按场景分面；内部 source 身份、定位句柄及 revision 不出 MCP/export。真实城市截图与性能证据遵循现有 serving-face 策略，不默认采集业务标识。

## 11. 道路自动通行审计与试跑（首版必需）

### 11.1 目标、范围与三层职责

回答“指定车辆、版本和测试条件下，哪些道路和转向能实际驶通”。不承诺任意车速/走法，不以图上相连或一次试跑通过推断全城无问题。

| 层 | 执行者 | 输出与边界 |
| --- | --- | --- |
| 拓扑 | RoadPassabilityAudit | 有向候选边、合法转向、连接分量、从候选出生区的可达性；不把共享节点或 XZ 交叉视为可通行证明 |
| 几何 | RoadPassabilityAudit | 车辆配置空间净空、完整支撑覆盖、桥头高差/坡变、转向包络、静态障碍；输出可行路径见证或可定位阻塞证据 |
| 动态 | DrivingRouteRunner + AuditObserver | 油门/刹车/转向通过真实 DrivingKernel 完成用例；记录是否符合路线、方向、支撑层、接触与性能条件 |

几何检查使用独立的走廊/配置空间规则而非跟车控制器，区别于对同一失败重跑；两者仍共享 surface 事实，所以 A 批次必须另做渲染几何对照以防共同输入错误。没有找到路径只是 inconclusive，只有明确净空违规/断接或经完整保守检查证明不存在合法通道，才能标 geometric-blocked。

### 11.2 候选图、试跑图与正式开放图分离

1. SurfaceCompiler 生成 `CandidateRoadGraph`，保留不可支持结构及原因；RoadAuditPlanner 在任何自动关闭前冻结 mandatory manifest 和统计分母。
2. 静态检查生成 `ProvisionalAuditGraph`，供动态试跑使用；SafeRecovery 的纯候选校验函数可在此产生审计用起点，但不将它宣称为正式玩家出生区。它只拥有通过基础几何规则的候选。不能把尚待试跑的路提前当作正式开放道路。
3. Runner 采用真实世界的固体/路缘和本用例允许的候选通道。审计关闭标记是策略层边界，不生成阻挡被测路段的自证失败护栏；真实已存在护栏不得忽略。
4. AuditReleasePolicy 在三层证据满足要求后构造 `ReleasedDrivingGraph`，再添加可见关闭标识、游戏碰撞边界并复核出生区可达性；带最终边界重跑所有将被开放单位及关键端到端路线，防止关闭护栏挡住相邻好路。最终策略与边界摘要也绑定到 release 证据，失败不正式开放。该策略边界有独立版本，不能改写基础几何哈希造成无限审计循环。
5. 关闭某个路口转向不必关闭整个路口或道路；开放策略必须表达 `(incomingDirectedEdge, outgoingDirectedEdge)` 转向约束。无法在交互/碰撞中可靠限制单个转向时，保守关闭相关入口并说明实际范围。

必须同时报告：候选总量、编译排除、静态阻塞、动态通过、未确认、关闭后开放量与可达分量。不能先删坏路再显示“全城100%通过”。原始 mandatory 失败会使本轮城市验收失败；有意排除需更新 manifest/策略版本，保留排除理由和最小可玩门槛，不能由 runner 自动豁免。

### 11.3 用例规划与覆盖单位

覆盖分母以冻结 mandatory manifest 为准，route list 不是分母。一个长路线可覆盖多个单位，但只有 observer 记录了各单位的有效进入/离开条件才计数。

- `directed-edge`：每个允许方向独立验证起止、完整车体通过和合法支撑；双向道路必须双向跑。
- `turn`：每个声明合法的入边→出边动作；包括左/右/直行、换宽、急弯，U-turn 仅在明确允许处生成。几何相接不表示车辆能转过去。
- `structure-transition`：桥头/坡道的每个允许方向与层转换；桥下通行单独用例，不与桥面合并统计。
- `spawn-access`：出生姿态起步、离开与返回；候选出生点到每个正式开放可达分量/跨区目标的端到端路线。一个出生点到不了的孤立区域不能被宣称可探索。
- `recovery`：道路安全点复位后的净空/支撑与重新起步；这属于独立测试，不作为其他路线的补救成功。

局部试跑可在已验证姿态初始化，但局部通过不能替代端到端从 spawn 出发的连续路线。端到端中禁止为了覆盖不足而在路口重新出生。预算内优先按稳定顺序覆盖桥坡、窄口、急弯，再选择减少重复的组合路线；组合优化不改变必须测试的单位。

每个用例带入口/出口门、目标 layer/portal 序列、允许走廊、速度策略和容差；完成需整车有向穿越出口且按序通过入口/转向/portal。靠近出口、反向擦过、绕行另一条道路、沿桥下经过均不算。普通通过采用版本化安全巡航策略；高速薄墙、低速急转、坡停起步等是独立压力夹具，不能要求任意道路以最高车速过弯。

### 11.4 契约与证据身份

```ts
type AuditVerdict = 'passed' | 'blocked' | 'inconclusive';
type AuditRunState = 'queued' | 'running' | 'complete' | 'cancelled' | 'stale';
interface AuditKey {
  baseSnapshotHash: string;   // 实际路面+障碍+连接；含显示剪枝/修复/冻结楼高
  vehicleConfigHash: string; // 车体、轮距、转向包络、净空余量
  surfaceVersion: number;
  queryVersion: number;
  snapshotCompilerVersion: number;
  kernelBuildId: string;      // 固定构建/代码身份，防漏改版本复用旧证据
  physicsVersion: number;
  collisionVersion: number;
  controllerVersion: number;
  plannerVersion: number;
  observerVersion: number;
  manifestHash: string;      // 覆盖清单、条件、容差和策略配置
  releasePolicyVersion: number;
  releaseBoundaryHash: string | null; // 基础审计为null；最终开放复跑绑定实际策略边界
}
interface RoadAuditCase {
  id: string;
  units: readonly string[];
  start: ValidatedPose;
  corridor: DirectedCorridor;
  exit: DirectedExitGate;
  policy: SpeedAndStopPolicy;
  maxTicks: number;
  maxNoProgressTicks: number;
}
interface RoadAuditCaseResult {
  key: AuditKey;
  caseId: string;
  verdict: AuditVerdict;
  cause: 'none' | 'topology-disconnected' | 'geometry-blocked'
    | 'pilot-failed' | 'simulation-invalid' | 'route-deviation'
    | 'budget-exhausted' | 'cancelled' | 'unconfirmed';
  coveredUnits: readonly string[];
  simulatedTicks: number;
  evidence: LocalEvidenceHandle | null;
}
```

以上 ValidatedPose/DirectedCorridor/Gate/Policy 为具名纯数据契约，必须定义层、方向与单位，禁止 any。单例结果不直接给整条道路贴绿；聚合器要求全部 mandatory 单位满足相同 key 的三层要求。runState 是执行状态，verdict 是已结束用例结论（取消可形成 inconclusive 原因）；queued/running/cancelled/stale 永不等价于 passed。inconclusive/cancelled 的 coveredUnits 仅作观测记录，不能覆盖正式验收单位。

baseSnapshotHash 使用规范排序与实际量化后的几何、障碍、连接数据，不只依赖 seed 或会话数；由 SurfaceStore 在编译时生成。颜色、音量、相机角度不失效通行证据；修改车尺寸、楼体占地/高度、路网裁剪、修复补丁、物理/控制器、容差或用例清单均失效。哈希和 source 句柄保持本地内部用途，不成为 MCP 可访问的新数据字段。

### 11.5 同核试跑与失败归因

DrivingKernel 提供纯 `step(state, input, snapshot, params)`；CarAdapter 与 Runner 必须调用同一个入口、参数和碰撞/支撑实现。RoutePilot 只输出归一化 WASD 等价输入，可按曲率/坡度/停车距离调目标速度；不得写入 pose/speed/层句柄、扩大道路、关掉碰撞、自动复位或读出口后直接完成。

每 tick 顺序：pilot 输出输入 → kernel 推进 → observer 独立检查实际轨迹/门/层/接触/进展 → 更新覆盖与完成状态。observer 的完成检测独立于 pilot 的路径索引；pilot 宣称到达不构成成功。发现 NaN、越层、穿透、非法复位立即终止；“能从错误碰撞盒穿过去”不能变成绿灯。

无进展按沿合法走廊的有符号进度累计，排除 speed policy 中允许的停车窗口；不能仅凭车轮转了或位置抖动算进展。时限由长度/安全速度/计划停车+固定裕量生成，稳定写入用例；不以真实机器耗时判定道路阻塞。

失败归因顺序：

1. 原始图无合法连接 → topology-disconnected。
2. 几何独立检查有明确阻塞见证 → geometry-blocked，定位道路/portal/障碍及净空缺口。
3. 几何可行且 pilot 偏航/振荡/未到达 → pilot-failed 或 route-deviation，判 inconclusive；不能据此断言路坏。
4. 非有限状态、连续检测漏穿或不合法层跳 → simulation-invalid，判 inconclusive，阻止开放并作为代码缺陷处理。
5. 预算、取消、未知失败 → inconclusive；几何本身也不确定时保持 unconfirmed。

可用更低巡航速度/不同确定性跟踪参数做有界诊断复跑，但条件变化必须产生独立 case/manifest key，保留首次失败。诊断复跑不能悄悄替代 mandatory 标准用例。blocked 证据不足时一律退到 inconclusive。

### 11.6 执行、取消、回放与隐私

- 无渲染 runner 按固定模拟 tick 推进，不受屏幕刷新率影响；每个调度批按 tick/计算预算 yield，墙钟仅限调度/性能记录，不决定物理结果。单帧最多5步的限制属于交互 Runtime，离线 runner 可跨多个小批次加速，不新增 renderer/rAF。
- 默认用户主动“检查道路”触发，CI 对合成夹具自动执行。用户正在驾驶时不自动争用 CPU/相机；暂停审计调度、取消或延后均显式显示未完成。场景更新/切种子/退出可取消；旧 key 的迟到结果只回收资源，不更新当前颜色或开放图。
- 后续可把纯 runner 放 dedicated Worker；首版允许主线程分块。Worker 输入只含收敛后的几何/障碍/参数，不传 CityModel、业务标识和宿主权限；不能 transfer renderer 正在使用的 buffer。
- AuditEvidenceStore 在内存持有计数、失败前后有界 tick/input/state 环形缓冲（单例默认上限600 ticks、全局32个失败片段；可配置但必须有总字节预算）。通过用例仅保留摘要；不记录人工驾驶轨迹，不累积无限自动试跑路径。
- 合成 CI 可保存完整可复现夹具、输入序列、key 和结构化报告；真实本机场景不自动落盘/导出/MCP。其失败定位仅通过当前宿主实例的 opaque handle 在本地打开，取消/换 revision 后失效。
- 可视回放复用保存输入与同 key 的 kernel 重算，必要时对 checkpoint state hash；它是本地展示，不是新的通过判据。用户主动查看失败时才经 lease 接管相机，退出归还；普通后台审计通过 SurfaceStore 专用只读快照端口原子捕获 revision，不拿相机、不冻结活跃 UI；snapshot 变化就取消并标 stale，不继续拿旧结果着色。该端口只向当前官方 City 实例的审计模块开放，不是任意插件 IPC。

### 11.7 展示与道路开放门槛

| 本地显示 | 条件 | 是否正式开放 |
| --- | --- | --- |
| 绿色 / 已验证 | 当前 key 下 mandatory 拓扑/几何/模拟证据齐全 | 是，还须处于出生区可达的开放图 |
| 红色 / 已确认阻塞 | topology 或 geometry 明确证据；显示具体原因 | 否 |
| 黄色 / 待验证 | 未跑、控制/模拟失败、预算、过期、取消或结构不支持 | 否；显示原因，不能归为已确认路坏 |

颜色必须配文字与定位，不把黄色静默隐藏。运行期间可以显示进度，但部分完成不生成全城绿灯；UI 显示“已验 X/Y 个方向、A/B 个转向、C/D 个结构连接”，而不只显示路线条数。报告标明车辆配置、速度条件、版本与排除范围。

发布验收同时要求：冻结 mandatory 清单无未解释失败；所有实际开放方向/转向/跨层连接完成同 key 验证；spawn 到目标区域的端到端通过；关闭边界不会让玩家困住；最小可玩区域满足产品 SPEC。只开放一条安全短路可以作为明确标注的局部开发预览，不能据此宣称该城市已验收。

### 11.8 审计本身的回归测试

已知好路与故障注入都必须有夹具：窄口小于转向轮包络、细墙、桥头台阶、缺一段路、桥面/桥下同XZ、仅一个转向受阻、尽端不可调头、出生被堵、同seed改障碍、render surface整体偏移、控制器故意不转弯、无进展抖动、预算耗尽、取消/迟到结果、物理NaN/穿透和隐式复位。

断言故障被正确定位且不产生假绿；控制器坏时输出 inconclusive 而不是道路阻塞；门顺序、方向和层错误不累计覆盖。对同 key 比较不同调度批大小的 tick/input/state 摘要一致。对构建预算/runner 资源限制做负例，确认结果是未完成而非成功。不得只测试审计器与模拟器共享的成功路径。

## 12. 迁移批次与验收

| 批次 | 修改范围 | 必须交付/通过 | 暂不做 |
| --- | --- | --- | --- |
| A：路面契约提取 | surface types/compiler + 原 road/terrain 渲染包装 | 同输入旧/新渲染几何一致；普通路/路口/尽端分类；15 城市夹具报告；高架/桥准确顶面专项 | 不改飞行、不调手感、不开放驾驶 |
| B：世界查询与静态审计 | SurfaceIndex/Query、障碍索引、候选图、RoadAuditPlanner/PassabilityAudit、SafeRecovery | 固定 mandatory 清单；分层/坡道/完整覆盖/出生净空；几何阻塞与未确认分开；预算失败关闭 | 无任务/成绩 |
| C：接触与坡度 | TOI/法线/滑动、当前模拟接口升级 | 高速薄墙、擦墙两角、倒车脱困、坡上坡下/松键/制动/倒车、帧率一致性、复位不增滚动距离 | 无漂移/音频扩展 |
| C2：自动试跑与开放策略 | DrivingKernel、RoutePilot/Runner/Observer/Attribution、Scheduler、ReleasePolicy | 双向/转向/桥坡/端到端与负例；同核无瞬移；取消/版本失效；不缩分母；假绿为0 | 不因控制失败判定路坏 |
| D：共同运行时 | 飞机包装、lease、输入router、CarAdapter、驾驶HUD | 飞机全部现有守卫不回退；准备取消/错误/异步过期；单 rAF/hook/相机；20次进退恢复 | 不迁移飞机成绩 schema |
| E：发布验收 | feature flag + 原生 bundle | 实际连续驾驶、CPU P95/内存/资源预算、原生5分钟、宿主切换/重启不影响既有数据功能；证据绑定 revision | 未达门槛不默认开放 |

B/C 可在合成预览 shell 迭代，但城市入口只能在 C2/D/E 过关后开放。先做 A，避免把未定义道路契约固化进 session。

性能目标沿用产品 SPEC：60Hz 下模拟+查询 CPU P95 ≤2ms/帧、总帧 CPU P95 增量 ≤4ms，均为目标而非本次实测。报告包含 index 构建耗时/字节、候选数、预算拒绝数、冷/热状态、硬件、DPR、质量档，不能只报告平均 FPS。城市数据增长时不得每帧全图扫描或重建 index。

验证建议新增 `verify-city-driving-audit`（覆盖/失败归因/故障注入）、`verify-city-driving-runner`（同核/定步/无瞬移）、`verify-city-driving-release`（版本失效/开放图/迟到结果）、`verify-city-surface-contract`、`verify-city-driving-surface`、`verify-city-driving-collision`、`verify-city-game-runtime`；复用现有 model/driving/browser 守卫而非重写重复断言。提取共享路面后运行相关 road-paint/terrain/camera/planner 守卫、UI typecheck/build。Rust 无改动不额外改协议；原生验收通过 `.app` + open，不运行裸 menubar。

## 13. 实施时需先锁定的数值

A/B 输出并锁定：坐标/量纲、几何epsilon、轮距净空、最大坡度/台阶、索引cell/候选预算、三角退化阈值、portal连续性/坡变阈值。C 输出：skin、TOI容差、最大角度分段、gravityGame、holding brake、滑动摩擦与接触迭代预算。C2 输出并锁定：跟踪误差、出口门容差、速度策略、无进展/停车窗口、单例/全局tick预算、调度批大小、证据字节上限。任何阈值必须有专项夹具与版本，不直接复制上游世界单位。

本设计无需为了这些调参值再次询问产品许可；按夹具证据作工程选择并记录。改变首版玩法、数据面或引入刚体依赖需先更新对应决策与验收范围。

## 14. 核心代码落地与分工入口（2026-10-15）

已实现共享CPU surface类型、DrivingKernel兼容内核、审计contracts/key/case验证、有向整车GateAuditObserver、定步DrivingRouteRunner、可取消/过期/总预算AuditScheduler、缺证据关闭的AuditReleasePolicy、FixedStepClock和GameScenePort接口。合成试驾已使用同一DrivingKernel。

真实路面编译/查询、静态几何证明、自动驾驶pilot和宿主lease仍待实现。完整目录、限制、Agent文件所有权与可直接接续的任务见 [CITY_DRIVING_AGENT_HANDOFF.md](CITY_DRIVING_AGENT_HANDOFF.md)。落地接口以代码contracts为准；需要调整时由集成人统一维护，禁止并行Agent各造一套协议。

A1增量：普通路带/路口/人行道编译与地形采样已提取为纯CPU模块，renderer共用原几何算法；三角片段来源和Float32视图可供后续查询使用。仍未解决边界union、岛排除、桥/高架及SurfaceStore，输出明确为geometry-only。证据与后续边界见 [普通路面提取记录](CITY_GROUND_SURFACE_EXTRACTION_NOTES.md)。

A2增量：已实现单片段闭环/孔洞提取、边界故障/预算诊断、独立patch快照、本地SHA256与防御性复制SurfaceStore；迟到异步发布、clear与旧revision均有明确失效语义。跨片段union/portal及宿主Store接入尚未完成，且路面revision不能代替完整障碍世界身份。验收范围与限制见 [SurfaceStore记录](CITY_SURFACE_STORE_NOTES.md)。

A3增量：`engine/surface/SurfaceIndex.ts` 已提供复制快照、有界XZ三角索引和显式layerId点采样；跨patch重叠返回ambiguous，构建/查询超预算失败关闭。该索引只产出点级几何候选，不能代替全车覆盖、连续运动、portal、碰撞或正式通行审计，尚未连接CityEngine运行时。

2026-10-16任务1/2增量：宿主端口现以generation租约读取surface与结构实体副本，worldRevision覆盖板体/桥墩/护栏等结构数据，并提供绑定该版本的坡度/异层板底净空诊断。完整建筑/地标障碍、合法图与跨层portal仍待闭合，见 [实施记录](CITY_DRIVING_STRUCTURE_HOST_PROGRESS.md)。

A4/B1增量：同层alias合并（精确叠置顶点高差 ≤0.1）、唯一点分类器、按两侧分类切分的curb/closed/step区域边界、整车矩形覆盖（侧向余量0.2）与细分扫掠凸包连续运动验证已实现，并通过 `SurfaceDrivingEnvironment`/`SurfaceWorldValidator` 接入现有kernel/runner/observer。十五城直路同核试跑每个tick独立复核均合法。SurfaceIndex法线错误已修。仍无portal、固体障碍、桥/高架和渠化岛编译，不认证通行。见 [区域与整车覆盖记录](CITY_SURFACE_REGIONS_NOTES.md)。

A5增量：普通路面改为精确贴地（不贴地处按渲染地形三角网保形裁剪，无T形接点），并修复折点自折叠与闭合环线接缝。十五城贴地偏差 ≤0.02，车行片段边界全部是流形；驾驶区域高差冲突与排除片段均为0。平地渲染几何与重构前逐字节一致，坡地变化有新基线和原因记录。见 [A5贴地记录](CITY_GROUND_SURFACE_TERRAIN_FIT_NOTES.md)。

A6增量：结构几何（桥面/高架/桁架/尽端/渠化口）抽成纯描述符，渲染与驾驶同源，结构渲染与改动前逐字节一致；`compileCitySurface` 聚合整城驾驶路面、静态障碍与桥头诊断。跨河桥面放进地面层，以alias规则判同层落地；立交与高架单独成层，跨层portal未实现。十五城规划布局与0/90/500会话显示布局的片段边界全部是流形。CityEngine增加按需、revision校验的驾驶路面快照端口。现有桥面平板与有坡引道在渲染上就不连续，桥梁全部关闭并上报，需另立视觉修复。见 [结构与聚合记录](CITY_STRUCTURE_SURFACE_NOTES.md)。

A7增量（2026-10-16）：桥面改为贴合两端桥头路面的斜板（经产品确认的可视变更），区域规则 v3 让桥面遮挡下方更低的地面。十五城 10 座桥两端连通、桥跨可整段行驶（修复前 0 座），剩余不通的桥头上报原因。见 [结构与聚合记录](CITY_STRUCTURE_SURFACE_NOTES.md) A7 一节。
