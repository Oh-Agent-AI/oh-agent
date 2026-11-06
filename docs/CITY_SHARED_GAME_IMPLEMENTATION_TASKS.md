# 共享游戏基础设施：实施任务与验收

2026-10-18。基线 `dev@82a1dc1a`。依据 [SPEC](CITY_SHARED_GAME_FOUNDATION_SPEC.md)。所有实现先在当前工作区集成，验收结果以本表与实际命令输出为准，不把子代理声明当成验收通过。

## 分工

| 工作包 | 执行者 | 主要文件与责任 | 集成约束 |
| --- | --- | --- | --- |
| T1：宿主租约与飞行迁移 | `scene_lease`，GPT-6 Luna | `HostGameScenePort`、`GameScenePort`、`CityEngine`、`GameSession`、`FlightWorld` 和会话守卫 | 独占宿主/飞行编排；两种载具真实消费同一事务；旧 token 不能干扰新会话 |
| T2：静态事实与出生验证 | `static_world_spawn`，GPT-6 Luna | `compileCitySolidInputs`、`spawnPoints`、`createCityCarSession`、图几何证据与相关守卫 | 共用三源固体；正式入口必须有有效凭据；诊断入口独立；未产出的开放证据不得伪造 |
| T3：共享 UX/UI | `vehicle_ui`，GPT-6 Luna | HUD 外壳/状态面板/操作提示/声音控件、输入焦点、两种 hooks 和相关样式/文案 | 只消费 view model；保留载具专属遥测；Esc/声音控件不产生重复驾驶命令 |
| T4：相机安全查询 | T2 算法与查询适配，T1 接入真实宿主 | `VehicleChaseCamera`、载具镜头壳、冻结固体查询 | 检查阻尼后实际位置、近裁面体积；不能仅有 mock 或未被调用的接口 |
| T5：音频、环境与性能诊断 | 主代理 | `GameAudioService`、两种 SFX、`CityEnvironment`、`FixedStepClock`、`RuntimeDiagnostics` | 公共设备/独立通道、异步代际清理；保留物理规则；诊断有界且不采集输入轨迹 |
| T6：集成与验收 | 主代理 | 公共 manifest、跨模块回归、浏览器真实交互、文档与最终报告 | 修复真实接线问题；普通构建不开放 UAT；未完成项显式保留 |

## 依赖与集成顺序

T1 和 T2 共同确定 lease.snapshot 与固体编译接口；T3 可先独立提取飞机 HUD，随后消费 T1 的异步入口和 T5 的音频能力。T4 在 T2 有冻结固体后接入 T1 的实际相机呈现。T6 在单模块守卫通过后执行全链。

共享工作区以文件归属避免覆盖；公共 manifest 与计数锁由主代理统一维护。子代理不自行提交或推送。主代理需复核所有实质 diff，补接口契约/错误路径测试，不为消除失败刷新 golden。

## 验收台账

实施与最终验收进行中，结果将在本表续记。

- 音频初验：真实 `GameSfx`/`DrivingSfx` 共享一个惰性设备；旧挂起 timer、native suspend 迟到完成、20 次启动停止、全部 loop/transient 清理的合成守卫通过。
- 时钟与环境初验：区分 invalid-delta/frame-gap/catch-up-budget；有界 CPU/帧时聚合；固定 offset 回放与宿主本地时区策略守卫通过。
- 宿主/出生/UI 的最终状态须以 T6 的集成结果为准。

### 主代理集成复核（2026-10-18）

- T1：真实 `CityEngine` 独占租约、取消/迟到结果/旧 token 隔离、审计只读捕获、相机/controls/near 恢复已接线。飞机准备现在异步；原有练习完成准备即飞行的活动规则保留，汽车仍先显示准备面板。
- T2：共用 `compileCitySolidInputs`，编译版本 3；正式入场检查 sealed 出生凭据、世界/车辆/碰撞尺寸身份；整表逐点验证覆盖边界、方向、层、整车与三源固体。审计动态世界也迁到共同编译器，精确 blocked 证据继续只用真正的结构事实，代理不冒充精确阻塞证明。开放图明确记录 `surfaceRegionIds`，不再将 region ID 称作 patch ID。
- T3/T4：飞机/汽车复用 HUD 外壳、状态面板、声音和操作提示；保留各自遥测。汽车 km/h 按统一尺度换算。近裁面体积及阻尼实际路径均查询；未解析相机结果暂停且不应用不安全 scratch pose。窄屏工具栏/摘要重叠已修，仍需最终响应式复测。
- T5：单个惰性 AudioContext、会话独立通道和真实汽车音效已接线；20 次重启的源/节点清理及异步 suspend 竞争守卫通过。环境显式 host-local/fixed-offset 策略。性能环形记录有界、不采集位置/按键/业务标识、不上传。
- 集成实测发现两类几何精度问题并修复：薄型旋转构件不能从 world corners 反推原半轴；实际渲染池的微小正体积实例不能用固定体积阈值误判退化。直接保留 affine 半轴并使用相对退化检查；新增原值、远坐标 sweep/overlap 与零轴/共面/NaN 拒绝回归，保留所有有效固体。
- 完整 `node scripts/verify-city-suite.mjs module game --no-cache --report /tmp/city-shared-foundation-game-verification.json` 24 阶段通过，耗时约 435 秒。之后精度/相机错误处置等集成修正需以追加单项结果为准，不能把较早的完整链当作最终工作区已全部通过。
- Web build 与原生 `cargo tauri build --bundles app` 已构建通过；最新补丁后的 bundle 正在复建。构建通过不等于原生操作或长时性能通过。
- Chrome 实际默认 3 会话演示城：汽车准备→启动→W 700ms（27.9 km/h）→Esc 暂停→声音 slider 70→69→Esc 返回 summary→退出→进入飞机→W 加速→Esc 暂停。汽车声音面板键盘不触发驾驶。证据 `/tmp/city-shared-game-car-acceptance.png`。浏览器检查额外发现飞机暂停时重复声音入口，已修正渲染条件，待复测。

追加复核：上述声音入口修复已在 Chrome 的真实飞机暂停面板验证，只有一个声音入口，证据 `/tmp/city-shared-game-plane-acceptance.png`。446px 内嵌浏览器中，飞机按钮范围 y=50..82、摘要范围 y=120..152，无重叠；鼠标点击飞机后成功进入飞机暂停面板，再退出恢复城市。最终定点回归已通过 typecheck、rendered-collision（含实值微小实例）、camera-collision-query、continuous-driving、car-runtime、game-session、shared-runtime、road-passability、spawn、scene-lease、audio-service、runtime-diagnostics、shared-game-ux、verification harness 及真实 CityEngine 浏览器守卫。后者验证 839 个注册网格/2131 实例、独立冻结及两种载具的相机/帧/释放接线。

### 原生验收：未通过（必须修复）

最新 UAT bundle 再构建成功，日志 `/tmp/city-shared-game-native-build.log`；退出旧进程后通过 `open .../bundle/macos/agent-vitals.app` 启动，未裸跑二进制。实际 City 首次加载出现 `plugin_boot_timeout`；点击 Retry City 后可达到 `City ready`，点击宿主“试驾汽车 · UAT”后约 9 秒出现 `plugin_unresponsive`。证据 `/tmp/city-shared-game-native-watchdog-failure.png`。当前不能宣称原生驾驶入口可用或性能通过，需拆分并测量准备阶段的同步主线程工作，提供可取消、能响应宿主心跳的准备实现；不得单纯增大 watchdog 或跳过碰撞。

实际 CityParts 三档追加检查已完成：0/1（1119 rendered instances）、90/42（3169）、500/7（8448），各 120 runtime tick，三源 coverage；这是内核/冻结源回归，不能替代上述 native watchdog 问题的修复。子代理追加审查在模型额度耗尽时终止，主代理已接手并记录未完成项，不能据其初验声明整个任务完成。

### 当前未完成的必需项（不得标整份 SPEC 完成）

1. S2：独立静态事实/道路能力捕获，以及独立 `staticContentRevision`；当前飞机仍依赖道路 ready，内容身份暂沿用 worldRevision。
2. S3：生产最终护栏/关闭边界的生成、碰撞执行、最终重放证据生产者，以及 derived→validated→confirmed 的实际确认流程。新增 evidence 类型与负例校验不代表上述生产流程已存在；正式入口继续不可发布，UAT 继续明确诊断。
3. S1/S4：端口外部 typed acquire result 和进一步的镜头策略归属清理仍需对照 SPEC 复查，不能把所有异常字符串都等同于已完成结构化契约。
4. S5：最终原生交互、每种载具 10 分钟/20 次交替、失焦/seek/切日/resize/context-lost 和资源/性能记录。现有 20 次合成音频/运行时切换不能替代原生要求。诊断目前覆盖帧/tick/呈现；查询/准备/渲染细分仍未齐备。
5. “快速接第三种载具”目前可复用 adapter/runtime/lease/相机/音频/UI 基础；尚无统一注册表驱动真实工厂与工具栏，新增载具仍需接专属物理、查询与入口。不得以空注册表声称游艇已能快速插入。

工作区同期出现路缘越障与交互时钟 time-drop 变更，须单独保留并验收。诊断已区分超限计数与实际暂停：frame-gap 被限为最多五步、catch-up-budget 丢弃余量时仍记录原始 cause，只有 invalid-delta 按现实现暂停。此行为与本文最初冻结的暂停基线不同，最终验收需明确说明，不能将超限静默计为零。

## 明确未包含的开放世界功能

持续世界时钟/实体存储、角色上下车、双运动体碰撞、交通 AI、水上动力学、区域流送与游戏存档继续按开放世界 P1–P4 跟踪。本轮不以空壳模块代替实际接入，也不宣称新增摩托或游艇的专属物理已经实现。

## 2026-10-18 集成状态补记

`HostGameScenePort` 已在真实 `CityEngine` 上提供单一活动槽；飞机与汽车入口都通过该 port 获取 token 化 lease。真实浏览器守卫覆盖了汽车与飞机入场、帧回调互斥、相机近裁面临时调整及恢复、旧 lease 清理隔离、静态快照释放和 CityEngine dispose。飞机将 lease 的 `snapshot.worldRevision` 作为 `staticContentRevision`，共享固体编译版本与内容身份参与航线身份；汽车相机与飞行相机均消费冻结固体派生的有界 sweep，未解析结果按不安全处理。

**仍未完成的 S2 能力拆分：** `CityEngine.gameScenePort` 当前通过 `captureDrivingWorld` 获取租约快照；该捕获把道路/地表能力与静态固体能力作为一个 ready 结果返回。若道路编译不可用，即使固体快照本可用，飞机入口也会拒绝准备。因此目前不能声称飞机已独立于汽车道路能力；错误会显式失败，不会回退到猜测式城市碰撞体。后续需将静态固体捕获与道路查询能力拆开，并为“道路不可用、固体可用”的飞机入场补真实宿主守卫，再更新此状态。

### 本轮推进（审核修复及 S2/S3）

- 驾驶成果 R1–R7 修复见 `CITY_DRIVING_DEV_REVIEW_20261018.md` 的追加复核；mountable/bridge-crossing/static-world 进入公共验证链，manifest 102、game 26。更强过桥回归已由主代理重跑通过，不再跳过桥头或提前结束。
- S2 已改为 `GameSceneSnapshot { staticWorld, drivingWorld? }`；飞机仅取静态能力，汽车额外取道路能力。独立静态摘要、typed acquisition result、真实宿主道路不可用的飞机入场守卫已由执行代理报告通过，待主代理整批复跑。这里替代上文“尚未实现静态能力拆分”的代码状态，尚不替代最终验收。
- S3 的内存确认服务与正式 hook 门控正在实施；最终边界 producer/同源护栏与碰撞/最终重放/密封发布正在实施。当前仍不能宣布正式驾驶发布闭环完成。
- 原生重新启动及一次 Retry 均再次复现 `plugin_boot_timeout`；因此旧“协作驾驶准备”bundle 还不能证明原生可用。宿主诊断最后一条心跳后约 13.7 秒没有响应；根侧将首屏 `createCityPlan` 迁到已有 local planning Worker，结果通过校验后复用原 LRU，取消不写缓存、失败不回退同步规划。UI shell ready 与 scene-ready 分开，所有场景命令仍等第一帧。未更改宿主 watchdog 时限。Web build/typecheck 通过，Worker/cache 回归与新 bundle 尚在验证。
