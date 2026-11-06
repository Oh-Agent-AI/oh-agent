# C 批次：连续碰撞与坡度动力学

本批次提供 DrivingSimulation、DrivingKernel、连续碰撞与专项守卫，以及冻结宿主的帧循环快检接线。不修改 B 的 SurfaceDrivingWorld、CollisionIndex、恢复、逐路审计或审计结论契约。

## B 的接入方式

1. 从同一冻结世界取 `Solid[]`、surface regions、车辆尺寸与中心高度。B 必须确认固体索引没有 rejected/遗漏，覆盖范围与世界身份真实；本批次不把 renderer triangle soup 变成碰撞体，也不把凸代理当作原始渲染精度。
2. 创建 `ContinuousDrivingEnvironment(regions, {surfaceRevision,worldRevision,solidRevision,solids,dimensions,centerHeight,isCurrent})`。solidRevision 必须等于worldRevision，且isCurrent必须绑定同一捕获句柄。centerHeight 沿车体 up 轴偏移；dimensions 为车体碰撞盒三个半尺寸，不是 wheel footprint。默认预测支撑间距0.1、最多64段，每段调用 B 的 validateMotion；独立验证用同一 surface 事实，不能认证编译器自身。
3. 用 `createContinuousDrivingKernel(environment,{worldRevision,vehicleConfigHash,kernelBuildId})` 校准 physics=2、collision=3、query=3。vehicleConfigHash 必须覆盖实际车辆、动力学、支撑与求解参数；不要把旧审计 key 改几个字段后复用旧结论。collision=2 的旧审计结果不能复用到本版。
4. 为每个审计case创建新的 `ContinuousWorldValidator(environment,corridorProgress)`，传给现有 GateAuditObserver。B 的旧 validator 仍验证直达运动，不能把折线滑动当直线复核。新 verifier 重新检查每段完整 footprint 与 CCD，验证首尾、支撑姿态、速度/角度上限和累计有符号路程。

`KernelStep.motion` 兼容新增可选字段：trajectory、contacts、contact、queryStatus。C 世界始终给出 resolved/unresolved。部分推进可以在 contact=true 时 blocked=false；blocked 继续表示本次没有有效推进。查询失败/过期回滚整个tick，queryStatus=unresolved，独立 verifier 返回 simulation-invalid，不生成物理阻塞证明。单纯接触、恢复失败和道路 blocked 的最终归因仍由 B/D 负责。

## 碰撞与响应

- `sweepBody` 对保持姿态的直线平移使用解析 SAT 区间交，返回接触时刻、向外单位法线。时刻对应数值 skin 边界（默认1e-4），不是声称无限精度下的零间隙物理接触。
- 姿态改变时以所有车体点的速度上界分割时间，按时间顺序证明安全前缀，找到已观察到 skin 接触的上界。返回 [time,timeUpper]，默认宽度不超过1e-7。无法证明的擦边、初始重叠、精度不足或预算耗尽返回 unresolved；不以均匀采样或旋转末态判清空。
- 旋转间隙证明额外使用固定分离平面的端点弦误差界，以及随车体面转动的平面的二阶 Taylor 下界。Euler 角速率绝对值之和为 A、车体半径为 R 时，顶点旋转二阶导数范数不超过 R·A²；转动面到固体顶点的有符号距离二阶导数不超过 D·A²+2·|位移|·A。只在整个区间的下界大于 skin 时跳过，且缓存区间端点的完整 SAT 结果。这避免用大量切向平移速度反复细分几乎不变的法向间隙；未增加预算，也未放宽碰撞体。
- `resolveDrivingCollision` 推进到安全前缀，累计接触平面，只去掉剩余位移朝障碍的分量，随后重新拟合支撑并重新扫掠。最多4次滑动，不注入弹性或随机脱困；首个接触后停止剩余角度运动，不绕接触点转车。
- 双墙角不能通过交替投影穿出；所有最终接受片段再次 CCD。版本在查询中失效则整个事务回滚。初始重叠交给 B 的 SafeRecovery。
- 数据源使用 B 的冻结凸代理。旋转时间区间有数值误差界，不能称解析精确旋转TOI；skin、timeTolerance、预算及代理几何必须留在审计配置/证据中。

## 动力学

speed 是车体前进方向的有符号路面速度；水平位移乘 cos(pitch)，坡向重力为 -6*sin(pitch)，加速/制动/阻力仍在固定1/60 tick积分。无输入且静止时，有限静摩擦保持坡上停车（staticHold=2）；双键主动制动可停车，反向输入先制动再换向。坡度超过支撑策略仍由B拒绝，不放宽阈值。

C 环境测量实际已接受的分段三维支撑路径，按本tick的路程预算截断并重查。distance 是累计有符号路程，继续直接供 CarVisuals 的轮转使用；滑动不把未执行的目标位移计入轮程，速度同时受实际接受比例和接触平面的切向投影约束；正撞墙在接触当tick去掉法向速度，不能把撞前已走距离当作撞后残余速度。旧环境接口继续可用，没有路径度量时使用三维首尾弦长；旧环境不因此获得连续滑动认证。

## 验收

`node scripts/verify-city-continuous-driving.mjs` 覆盖高速薄墙解析时刻/法线、旋转中途碰撞、双墙角与擦墙滑动、初始重叠、预算与失效回滚、倒车脱困、伪造轨迹、坡上制动/停车、正反坡面路程、真实C内核及独立复核、30/60/120Hz固定tick一致。输入变化必须提供相同tick序列；不承诺不同显示帧上采样的键盘事件天然等时。

补充实跑：24组斜墙解析时刻/法线、非正交双墙角、pitch旋转及稳定固体排序通过。新增组合 heading/pitch/roll 的中途碰撞见证、向外运动仍拒绝初始重叠；给定6宽道路、停放盒中心(-40,1,1.2)/半尺寸(1,1,0.6)、起点(-40.18,-0.47)/heading=0 的复现连续运行600 tick，全部 resolved 且逐段独立复核，车辆驶过停放盒。旧版在零基 tick 38 耗尽预算。

`node scripts/verify-city-continuous-driving.mjs --contact-cities` 复测真实冻结场景：500/42 的 `edge:-103.81:-388.59/-59.58:-396.21` 双向均通过；500/65537 的 `-136.97:-232.97` 出发三条边共六向，四向通过、两向仍是 pilot-failed，均无 simulation-invalid。这保留驾驶员失败与模拟失败的区别，不自动放行道路。

`--cities` 的15个结构布局/30次合法出生/1800个tick曾独立复核通过，无查询不确定、无接触；这不是城市接触覆盖证据。复杂非平面路面的预测支撑仍采用有界数值分段，不宣称无限精度轮胎/地形连续接触模型。原生bundle属于后续宿主验收；未接入驾驶HUD，正式入口仍拒绝缺少建筑网格碰撞支持的场景。

contacts 为每tick归一化时间区间、法线、固体id和worldRevision，仍是求解结果，B不能仅凭该标签生成道路阻塞证书。所有滑动片段都在trajectory中；审计观察器若依赖单tick直线门插值，必须结合分段轨迹检查门的顺序/方向，不能把折线终点的直连弦当真实运动。

内核最多接收2048个轨迹点，C世界复制前另有限制100万个几何元素。源码基数/每凸体顶点数/候选/轴数/时间区间/SAT测试均有界；超过限制不分配无限轴组合、不返回clear。source最多2万体、单体256顶点、每对1024轴，SAT每次事务默认20万次；实际C环境在整个tick累计预算。

## 宿主 freshness 与帧循环

`captureDrivingWorld()` 的冻结租约开始时采集精确渲染几何和 scene proxies；时间、增长、snap/reset 写入继续延后到最后一个租约释放。原有 `isCurrent()` 保持深度几何复核语义，`verifyCurrent()` 是显式深检入口，普通读取也深检。新增 `isLeaseCurrent()` 在明确冻结的宿主源上只检查租约身份、代次、存活和已锁存的失败；释放、重建、dispose 或一次深检失败会立即使旧快检失效。

`createCityCarSession` 进入前深检，碰撞绑定、CarAdapter、GameRuntime 和 CityEngine 帧钩子使用快检。审计仍可用原有深检与节流方式；这里没有修改 B 的审计调用。`captureDrivingSurface()` 只返回道路与结构编译事实，scene proxies 由冻结世界捕获负责，避免时间轴增长使道路快照失效。

宿主浏览器守卫覆盖326个网格/1317个实例、1000次快检低于250ms、冻结引用计数、延后时间轴、读取时发现原始矩阵篡改、几何dispose、取消和重建。车辆会话守卫同时确认60 tick内深检次数不增加。此结果仅为合成宿主测试，不代表原生bundle帧率验收。

2026-10-16 几何版本 8 复测：实际地形 192→384，保持原始高度场和 0.06 轮面约束。`--contact-cities` 的 500/42 两向与 500/65537 三边六向现均 passed（8/8），包括先前两向 pilot-failed；没有 simulation-invalid。`--cities` 的 30 次结构试跑/1800 独立复核 tick 通过。这是指定路线和有限用例的证据，仍不自动开放道路，也不替代新版本的 D1 全量审计或原生性能验收。

## 2026-10-21：CCD v7 本地发布复核

OBB 在起始车辆局部坐标系中插值并用中心/三条半轴投影，保留所有 SAT 轴。端点投影已有数值误差包络，弦偏差仅加入随区间平方收敛的曲率余项，避免重复叠加固定误差使接触前区间永远无法认证。未增加查询预算，未把 unresolved 当成 clear。

差分守卫保留历史 v5 的17条已决用例，并加入几何16的4个实际桥板接触复现；均在捕获预算内返回 contact，含平移坐标系检查。连续驾驶守卫（TOI、内部旋转接触、滑动/墙角、坡度、倒车、帧率一致性）及 City typecheck 通过。1000/7 的指定桥端 onto/off 重跑均为 inconclusive:pilot-failed，未再出现 simulation-invalid；这不是通行成功证据。7/2 桥头 closed:no-surface 仍可复现，单独修复，不能宣称全路网已完成。
