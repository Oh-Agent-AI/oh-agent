# 飞机与汽车共享运行时：第一阶段实现

2026-10-17。范围：共同生命周期、时钟、输入和环境事实；保留已验收载具物理、碰撞与玩法。此实现不等于开放世界 WorldRuntime 或完整 GameScenePort 已完成。

2026-10-18 代码复核与下一阶段实施契约见 [共享游戏基础设施 SPEC](CITY_SHARED_GAME_FOUNDATION_SPEC.md)。其中补充了正式出生点整表校验未执行逐点检查、场景 token 与音频生命周期等具体缺口；下文保留本阶段实现和验收记录。

**2026-10-18 当前实现状态：** 两种入口已消费真实 `HostGameScenePort`；统一三源固体编译、相机近裁面扫掠、共享音频通道和 HUD 组件已接线，出生整表逐点校验及凭据也已实现。下文的“后续仍独立跟踪”是 10-17 历史状态，最新事实以 [实施与验收台账](CITY_SHARED_GAME_IMPLEMENTATION_TASKS.md) 为准。飞机道路能力拆分、正式边界发布/执行/确认流程、长时原生性能验收仍未完成。

## 实际调用链

```text
useCityGame → GameSession（飞行/比赛活动）
           → GameRuntime<FlightInputState> → FlightAdapter
             → 既有 stepFlight / FlightCollision / RaceMission / FlightCamera

useCityDriving → createCityCarSession / createCityCarDiagnosticSession
              → GameRuntime<DrivingInputState> → CarAdapter
                → 既有 DrivingKernel / SurfaceDrivingEnvironment / CollisionIndex

两种输入：KeyboardInput<Input> ← 各自键位、焦点和中断动作
两种场景：CityEngine → CityEnvironment → 不可变环境快照
                               ├─ 昼夜、雨、雾、彩虹与环境动画
                               └─ GameSession 音效遥测（雨强）
```

两种玩法使用同一套 GameRuntime 类及 VehicleAdapter/RuntimeSceneLease 契约。当前各玩法仍持有自己的运行时实例，CityEngine 的相机/帧互斥保证只能有一个运行；后续持续世界将由 WorldRuntime 统一拥有实体与时钟，不能把此实现描述为已经存在全局世界模拟器。

## 关键代码

- `game/runtime/GameRuntime.ts`：不依赖飞机/汽车输入、物理或具体 Adapter。泛型输入按值拷贝；统一入场、准备取消、迟到结果、暂停、失效、重置和幂等清理。
- `GameScenePort.ts`：共用 RuntimeSceneLease 和 VehicleAdapter<Input>。CarAdapter 显式实现该接口；FlightAdapter 提供同步的既有飞行活动桥。
- `enter()` 支持汽车异步准备，`enterSync()` 保留飞机现有同步入场 API；二者经过同一 begin/finish/cleanup。同步入口遇到 Promise 明确拒绝，不把未准备完成的对象激活。
- `GameSession` 删除自有 accumulator/帧追赶循环，GameRuntime 定步调用飞行活动；倒计时/比赛/结果仍由 GameModeController/RaceMission 管理。世界布局或模型替换后停止并释放当前局，显式重试重新准备。
- `KeyboardInput.ts`：共用监听器生命周期、输入法/修饰键过滤、画布焦点、无条件 key-up、失焦清键、宿主隐藏。支持同一动作多个按键同时按住，释放一个不会错误清除另一个。飞机和汽车保留各自键位、Esc 和宿主挂起策略。
- `engine/environment/WeatherState.ts`：从渲染模块提取确定性天气函数，无 Three/DOM 依赖；旧 cityWeather 导出保持兼容。
- `CityEnvironment.ts`：宿主显式时间驱动、500ms 确定性采样、只读天气/小时/真实降雨强度；航拍显式晴天。GameSession 不再为天气单独读取 Date.now 或独立计算天气；阴天不再被当成雨声。
- `CityEngine` 在汽车帧回调前更新共同环境事实，汽车模式继续更新雨/天空/环境装饰。天气变化也参与呈现节流，回放跨日期但同小时不会保留旧天气。
- 发光装饰（救生塔灯/招牌霓虹）不属于建筑固体；昼夜可见性切换不改变冻结建筑碰撞内容。驾驶中建筑位置/路面仍被冻结，动态交通未实现。
- CityApp 对两种玩法都延后应用新投影和画质设置，退出后再处理，避免在载具运行中整体换城。

## 共同时间策略与行为变化

固定 dt = 1/60 秒；每个宿主帧最多 5 个物理 tick。单帧间隔超过 0.25 秒时不补跑，暂停。补跑 5 步后仍有完整 tick 积压时，也暂停并清输入/积压；不静默丢弃未模拟的时间。

这是有意统一的行为：原汽车时钟会直接丢弃部分积压，原飞机允许部分积压跨帧。新的统一策略更保守，飞机 UI 显示 lag 暂停，汽车显示 long-frame 暂停。

倒计时结束可返回 false 结束当前帧剩余追赶，但不暂停活动，保持“下一帧开始飞行”；任务结算暂停运行时，避免一个大帧中的剩余 tick 再推进终态。离线道路审计继续直接按 tick 调相同 DrivingKernel，不使用交互时钟，不改变其物理规则或既有证据身份。

## 验证

- 新 `verify-city-shared-runtime.mjs`：同一运行时实例交替适配器 20 次；异步取消后接飞机、迟到结果不能复活旧局；同步误用异步适配器拒绝；失效、倒计时边界、5 步过载暂停；环境确定性/回放/晴天覆盖；输入焦点/IME/修饰键/双键别名/清理。已登记完整 manifest（88 项）和 game 模块（15 项）。
- 飞机会话守卫新增完整会话的 30/60/120 Hz 状态比对、过载暂停、世界失效释放及重新准备；既有比赛、变体、重试和实际 UAT pilot 仍验证。
- 汽车 runtime/continuous-driving 守卫通过；入场 `--cities` 的 0/1、90/42、500/7 各推进 120 tick，且日夜切换后冻结固体深检保持 current。
- 浏览器实际 City 页面：飞机进入/加速/暂停/退出 → 汽车进入/加速/暂停/退出。无需新 renderer 或第二个 rAF。
- 完整 game 链 17/17 阶段通过（约 331 秒），报告 `/tmp/city-shared-runtime-verification.json`；最终增补用例再次通过飞机会话、汽车入口/建筑碰撞和 import 边界守卫，typecheck 通过。

- 默认关闭 UAT 的 Web build 通过；最终开启 UAT 的原生 `.app` 构建通过，并经 `open` 启动。日志 `/tmp/city-shared-runtime-web-build.log`、`/tmp/city-shared-runtime-native-build-final.log`。解锁后已退出旧进程并重新打开最新 bundle，完成下述原生功能冒烟；持续性能验收仍待执行。

### 原生功能冒烟（2026-10-17）

在本机最新 UAT bundle 的实际 548 会话城市中，通过飞机入场、继续、W 输入、Esc 暂停、退出；切换汽车后确认入场暂停、Space 继续、W 起步（HUD 4.6 世界单位/秒）、Space 暂停，碰撞覆盖为 `structures-and-buildings-and-scene-proxies`。汽车 Esc 退出后可再次进入飞机，最终退出恢复城市总览，互斥按钮恢复。证据截图：`/tmp/city-native-shared-plane.png`、`/tmp/city-native-shared-car.png`。第二轮原生验收复现了旧出生朝向问题后，`diagnosticSpawn` 已改用顶点 XZ 协方差主轴估算道路方向，沿路段多点尝试，并要求候选通过前进/倒车各 2.5 世界单位的连续支撑与碰撞扫掠；双向畅通优先。方向受阻的合成回归通过，0/1、90/42、500/7 CityParts 三档各推进 120 tick。修复后最新原生包的出生画面已与车道对齐，首次 800ms 前进 HUD 达到 4.2 世界单位/秒，车辆可推进到路口。继续重复输入时又出现“帧间隔过长，已自动暂停”，其来源尚未区分为场景负载或自动化交互；稳定帧率/长时性能仍未通过验收。新出生画面：`/tmp/city-native-shared-spawn-aligned.png`；旧问题复现：`/tmp/city-native-shared-spawn-blocked.png`。

飞机与汽车入口、互斥、暂停/继续、退出恢复已通过原生功能验收。UAT 出生朝向已修复并通过短程扫掠回归，原生车能沿车道起步并到达路口；长程城市道路驾驶仍未通过验收，因为重复交互触发自动长帧暂停。暂停触发来源不确定；稳定帧率/长时资源增长、全部道路及跨日天气仍未验收。

## 后续仍独立跟踪

1. 完整 GameScenePort 的宿主 token 租约实现及飞机/汽车统一的场景获取门面。
2. 统一静态固体事实来源：FlightWorld 仍有布局估算盒，汽车仍使用真实冻结结构/建筑/代理。
3. 相机策略从 CityEngine 门面迁出；共同音频服务与载具独立声学映射。
4. 持续 WorldRuntime、EntityStore、PossessionController、动态碰撞和区域流送。
5. 正式出生点流程与原生长时性能、完整城市实驾验收。UAT 候选不能替代正式开放证据。

详细开放世界迁移目标见 `CITY_OPEN_WORLD_ARCHITECTURE_PLAN.md`。纯代码与浏览器回归不能替代原生 `.app` 交互验收。
