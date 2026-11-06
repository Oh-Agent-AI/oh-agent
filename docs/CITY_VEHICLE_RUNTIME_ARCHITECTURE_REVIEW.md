# 飞机与汽车运行时架构评估

2026-10-17。依据当前分支实际调用链，包含本轮尚未提交的汽车 UAT 接线。

> 状态更新：本文记录统一前基线。2026-10-17 已完成共同 GameRuntime、时钟、KeyboardInput 和 CityEnvironment 第一阶段；调用链与剩余边界见 `CITY_SHARED_VEHICLE_RUNTIME_NOTES.md`。下文的“当前”指评估时点。

## 结论

已有统一宿主和相近的分层思路，但尚未实现统一载具运行时。当前不能宣称“飞机和汽车已经大量共用 GameRuntime”。值得统一的是宿主所有权、时钟、输入生命周期和通用呈现服务；物理、形状碰撞、出生/恢复规则及任务判定应保持独立。

“共享内核”目前主要指汽车人工驾驶、RoutePilot、无头审计共用 DrivingKernel，并不包括飞机。

## 实际调用链

```text
CityApp
  ├─ useCityGame → GameSession → GameModeController
  │                 ├─ 自有 accumulator / 固定步循环
  │                 ├─ FlightInput / FlightCamera / FlightVisuals
  │                 ├─ FlightWorld → FlightCollision
  │                 └─ stepFlight / RaceMission / 音频 / 档案
  │
  └─ useCityDrivingUat → useCityDriving → createCityCarDiagnosticSession
                    → GameRuntime → FixedStepClock → CarAdapter
                        └─ DrivingKernel → stepDriving
                           → SurfaceDrivingEnvironment / CollisionIndex

共同底座：CityEngine、同一 Three 场景/renderer/宿主 rAF、城市模型与地形来源。
当前两个 hook/会话通过互斥门控协作，非同一个运行时实例。
```

## 复用情况

| 层 | 当前状态 | 建议 |
| --- | --- | --- |
| 场景/渲染/环境资源 | 共用 CityEngine、场景与唯一 rAF | 保持，不再创建 renderer 或独立帧循环 |
| 宿主接管 | 飞机 setCameraOwner/setGameFrameHook；汽车 captureDrivingWorld/setFrameHook，分开实现 | 收敛成统一 token 租约；相机/帧/对象/冻结源按一次 acquire/release 管理 |
| 定步时钟 | 飞机 GameSession 手写 accumulator；汽车用 FixedStepClock | 共用时钟实现，迁移时明确积压处理和倒计时语义 |
| 生命周期 | 飞机 GameModeController + GameSession；汽车 GameRuntime + React 编排 | 统一资源生命周期；任务状态另放活动控制器 |
| 键盘与中断 | FlightInput 与汽车 UAT hook 各自监听 DOM | 共用 attach/detach、焦点/输入法/失焦规则；键位映射和暂停/退出动作可配置 |
| 世界与固体来源 | 飞机从 layout/model 推导保守盒；汽车取真实冻结渲染源、结构体、代理 | 优先共用世界身份与固体来源，形状查询仍各自适配 |
| 物理与碰撞 | 飞机纯运动 + 球体扫掠/采样地形；汽车坡面自行车模型 + 整车 OBB/TOI/滑动 | 保留两套策略，不强行合成一种载具状态或一种碰撞响应 |
| 相机与车模 | FlightCamera/FlightVisuals 独立；汽车 CarVisuals + 引擎内硬编码跟车 | 共用插值呈现协议和 token 校验；镜头策略留在适配器 |
| HUD | 都控制约 10 Hz，但两套快照与调度 | 复用快照通知与通用外壳；飞机高度/赛程和汽车挡位/受阻读数独立 |
| 玩法/审计 | RaceMission 与汽车道路审计各自独立 | 保持独立。飞行比赛通过不能证明道路可通行 |
| 音频/成绩 | 飞机已实现，汽车尚未接入 | 可复用音频生命周期/主音量服务；发动机声和成绩 schema 独立 |

## 主要架构缺口

### 1. GameRuntime 仍绑定汽车

`game/runtime/GameRuntime.ts` 直接 import `DrivingInputState`、`EMPTY_DRIVING_INPUT`、`DRIVING_DT` 和 `CarAdapter`；`enter()` 参数也只接受 CarAdapter。其 Session 和固定步调用都不是通用载具协议。

`game/runtime/GameScenePort.ts` 已定义 GameScenePort、GameSceneLease、VehicleAdapter，但检索当前 src 调用关系，没有实现或消费者。也没有 FlightAdapter。接口存在不能等同于完成接线。

### 2. 两套时钟策略会产生行为分歧

二者均为 1/60 秒、单帧最多 5 步、约 250ms 长帧保护，但积压处置不同：FixedStepClock 达到步数上限后会清除剩余整步；飞机 GameSession 允许一部分积压跨帧，较大积压进入 lag 暂停。飞机还包含“飞机冻结、任务倒计时继续”的分支。

迁移不能直接把 GameSession.frame 替换为 clock.advance 后就宣称等价。先确定积压处理契约，使用记录输入验证倒计时、比赛时钟、罚时和长帧暂停。

### 3. 同一座建筑存在两套碰撞事实推导

FlightWorld 通过 layout/model、builtFractionAt 和按类型估算的尺寸/高度生成盒子；汽车从实际显示的建筑实例、结构描述和白名单代理冻结固体。飞机还把整段桥梁视为保守盒，汽车要保留桥下车道与桥墩空隙。

共同来源应是同一世界版本的事实；两种载具可以对同一事实采用不同保守包络与碰撞响应。不要让 FlightWorld 自己的建筑高度表逐渐成为第二个场景真相源，也不要把汽车道路开放规则强加给飞机。

### 4. 载具编排跨越了多层

飞机的 GameSession 同时负责资源、物理、碰撞、比赛、镜头、音频和 HUD。汽车目前的资源所有权分散在 GameRuntime、createCityCarSession、useCityDrivingUat 和 CityEngine；跟车偏移直接写在引擎门面里。它们可以工作，但第三种载具会继续复制编排。

### 5. 生命周期能力缺少一次性的统一契约

取消准备、迟到异步结果、失焦、宿主挂起、上下文丢失、重复退出、世界失效都需要相似处理。当前汽车和飞机的宿主隐藏、Esc、暂停/退出语义存在刻意差异，应该由明确策略表达，而不是藏在不同事件监听器中。

## 建议目标结构

```text
CityApp / Vehicle HUD
         │ commands / telemetry
         ▼
GameRuntime<Input, State, Telemetry>
  ├─ FixedStepClock
  ├─ lifecycle / cancellation / run identity / cleanup
  ├─ KeyboardInputSession（可配置键位与动作）
  ├─ ActivityController（free / practice / race）
  └─ VehicleAdapter
       ├─ FlightAdapter → 现有 FlightSimulation / FlightCollision / FlightCamera
       └─ CarAdapter    → 现有 DrivingKernel / SurfaceDrivingEnvironment / CarCamera
         │
         ▼
GameSceneLease（token / worldRevision / frameHook / setCamera / attach / release）
         │
         ▼
CityEngine + FrozenWorldSource（一个 renderer / 一个 rAF）
```

- Runtime 不 import FlightSimState、DrivingState 或具体 Adapter。输入、状态与遥测用泛型或具体载具各自的窄接口，避免一个包含所有载具字段的巨大可选类型。
- Adapter 至少提供 prepare、fixedStep(input, dt)、present(alpha)、reset、settle、dispose；相机和模型消费同一插值状态。
- 资源生命周期只用 idle/preparing/paused/running/error/disposed。countdown/racing/result 属于 ActivityController。倒计时可推进任务时钟但不推进载具；不得把这些阶段硬塞进汽车自由驾驶状态机。
- 统一租约提供 setCamera(pose)，只做授权及应用姿态。跟车距离、环绕、倾斜、遮挡处理放载具相机策略；引擎不判断“这是汽车还是飞机”。
- 世界冻结源统一 revision/失效规则，共享固体事实与可用的查询基础设施；汽车额外读取路面索引/portal，飞机额外使用高度和飞行边界。
- 离线汽车审计继续直接喂固定 tick 与 DrivingKernel，不经过 DOM 输入、HUD 或实时屏幕时钟，保证审计和人工驾驶共核。

## 迁移顺序与验收

1. **统一租约**：实现已有 GameScenePort，而非新增第三套同名端口。接管帧循环、相机、挂载对象、冻结源、返回视角；审计只取只读冻结源，不抢相机。
2. **时钟与输入**：先抽可测试的共同行为，记录并决定积压策略；迁移飞机时保持已验收的赛程/焦点规则。键位和 Esc 策略保留配置。
3. **通用 Runtime + FlightAdapter**：迁出飞机的模拟/镜头/模型编排，RaceMission 保留活动控制器；汽车沿用既有 kernel。取消准备与过期结果不复活旧 run。
4. **世界固体来源统一**：飞机切到共同冻结事实前，用现有固定 seed 语料对比碰撞与路线生成。碰撞包络变化按行为变更验收，不能静默替换后刷新结果掩盖差异。
5. **HUD/音频服务收敛**：统一低频通知、暂停/错误/退出外壳，保留各载具读数和任务界面。

共同验收至少覆盖：飞机现有 16 阶段 game 链不回退；汽车连续碰撞与审计同核；30/60/120 Hz 记录输入回放；倒计时/长帧/重试/结算仅一次；准备中取消、世界失效、宿主隐藏、context lost、20 次载具交替进退，无残留监听/对象/租约；最后原生 `.app` 操作与性能验收。

上述为架构评估及迁移建议。本轮没有把飞机迁入汽车 Runtime，不能将本报告视为共享运行时已经完成。
