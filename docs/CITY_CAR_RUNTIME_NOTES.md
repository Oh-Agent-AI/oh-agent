# 汽车运行时生命周期基础

`game/runtime/GameRuntime.ts` 与 `CarAdapter.ts` 提供可独立验证的汽车运行时接入基础。它们不创建 renderer、rAF、相机、网络连接或插件存档；不修改现有飞机 GameSession。真实城市启用必须由宿主独占场景 lease，不能同时挂载飞机和汽车帧循环。

- Runtime 唯一持有固定时钟、输入快照、prepare 取消信号、runId 和退出事务。`enter` 取得 lease/adapter 的所有权；准备成功停在 paused，显式 resume 清空输入后启动。长帧、失焦调用 pause 清键且丢弃累加时间。
- CarAdapter 只调用共享 DrivingKernel，保存前后状态并插值位置、高度、朝向、坡度、转向与轮程。展示回调可直接驱动 CarVisuals；它没有第二套物理积分。
- 世界 binding 和宿主 lease 均提供 `isCurrent`。Runtime 每帧及每固定步前校验；Adapter 在 kernel 返回后再次校验，避免失效查询结果被提交或展示。失效即 error，清 hook、dispose、release，不自动把车辆挪到新世界。
- 重试需要重新取得完整世界 lease、kernel 和合法出生位姿；reset 仅在当前世界重新验证原出生点，尚不替代 SafeRecovery。
- prepare 取消、旧回调、prepare 完成较晚及 dispose 重复调用均不能操作新会话。资源清理依次尝试清 hook、dispose adapter、release lease，一个环节失败仍尝试后续环节。

`CarWorldBinding.validateSpawn` 必须验证整车支撑和碰撞，并核对实际 y/pitch/roll；仅验证中心点不符合契约。真实城市桥接应绑定同一冻结世界的 surface、collision、kernel identity 和 scene lease。SurfaceDrivingEnvironment 已支持可选结构碰撞绑定；不传绑定时仍只有支撑检查，传入后也不包含建筑网格，不能单独宣称完整城市安全驾驶。跨层 portal、正式开放图、SafeRecovery、相机防穿墙、统一飞机迁移和 HUD 不由这两个基础模块实现。

验证：`node scripts/verify-city-car-runtime.mjs`。覆盖 30/60/120 Hz 的共享核结果一致、长帧清键暂停、步前和步中失效拒绝、异步准备取消后重入、旧回调隔离、reset 清键和 20 次进退资源释放。`npm --prefix apps/agent-city/ui run typecheck` 验证类型。

`createCityCarSession.ts` 已直接消费 `CityEngine.captureDrivingWorld` 的冻结租约。surface revision用于索引/区域，worldRevision用于障碍索引、kernel和runtime。它显式接收车辆碰撞尺寸、中心高度与配置hash，构建同一快照的支撑和结构碰撞环境后验证整车出生。成功停在paused，并将租约释放责任移交runtime；准备拒绝、出生失败和取消均释放冻结。

**正式城市仍不可驾驶：** 一旦快照包含任意 `renderedSolids`，工厂返回 `unavailable-rendered-collision`，释放租约且不安装帧hook。精确建筑/地标网格已被捕获不等于已支持其碰撞。本工厂的ready结果仅允许无这类建筑网格的结构夹具，coverage明确为structures-only；也不证明树木、交通或道路已通过正式审计。

桥接验证：`node scripts/verify-city-car-session.mjs`，覆盖同版本索引/内核完整结构夹具流程、建筑未支持时拒绝与释放、整车越界出生拒绝、运行后取消释放。
