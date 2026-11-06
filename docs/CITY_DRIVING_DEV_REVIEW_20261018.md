# dev 驾驶成果并行审核

日期：2026-10-18。审核基线：`dev@82a1dc1a` 加当前未提交的驾驶改动。三个 GPT-6 Luna 子代理分别审核碰撞/动力学、编译/身份、真实回归/UX，主代理复核证据。审核未修改被审核的驾驶规则。

共享游戏基础设施 S2 的静态捕获提取正在同一工作区实施，属于另一批次；其快照契约与测试夹具尚在迁移，不能将该迁移造成的会话测试失败归因于本次越障成果。本文行号为本次审核时的位置。

结论：已有修复能通过所附两个守卫，但还存在需要修复的碰撞漏判及审计策略隔离问题；现有证据不足以宣布“两端引道到对岸道路全跨”和“任何人打开都是同一座演示城”。

后续复核状态：下列发现记录的是审核时的代码，不表示修复中的工作区仍逐项保持原状。R1/R2/R4 的策略隔离和高度下界修复、R5 的独立 demo 种子以及 R6 的强化回归正在同一工作区复核，尚未作为整批验收。R3 已补 canonical v2 和只改可越高度的身份/失效负例，`verify-city-surface-port.mjs` 通过。强化后的梁桥双向入口至对岸测试已通过；悬索断头桥完整入口至封闭端也已通过。此前悬索失败为守卫要求速度精确等于零的误报，现以物理 zeroSpeed 阈值、接触原因、未越端点及末态支撑共同断言。当前 UI typecheck、car-session、preparation 和 mountable 守卫通过；这些局部结果不替代完整城市和原生验收。

## 发现

### R1 / P1：倾斜车身的低边漏算，真实重叠可返回 clear

位置：`game/driving/DrivingCollision.ts:79–80`，同式也在 `game/driving/CollisionIndex.ts:155–157`。

`sweepBottom = min(from.y,to.y) - halfHeight*cos(maxPitch)` 没有计入车长的俯仰投影和车宽的横滚投影。该值不是车身扫掠的高度下界；用它跳过整个可越固体会错误放行倾斜车身。

可复现条件：curb prism 为 x=[−2.2,−1.3]、y=[−0.18,0.22]、mountableHeight=0.25；车辆中心 y=0.29、halfLength=2、halfHeight=0.29、pitch=0.3。车身在路缘处与其高度范围相交，后缘车底约为 −0.578，`sweepBody(p,p)` 却返回 `{status:"clear",tests:3}`。

主代理还使用当前城市汽车尺寸复核：halfLength=1.4、halfWidth=.7、halfHeight=.575、centerHeight=.55、pitch=.3；按实际 body 变换得到中心 x=−.55·sin(.3)、y=.55·cos(.3)。同一 curb 下，静态完整车体查询为 `hit`，连续 `sweepBody(p,p)` 为 `clear`，实际最低点约 −.438。因此此问题不只存在于另造的车身尺寸。

复现：`node /tmp/city-mountable-review-repro.mjs`。本地证据为几何数据，不包含真实用户数据。

建议：以整车 OBB 和整个角度区间的保守高度下界判断可越，不只看车心减半高；补俯仰、横滚、旋转中途最低点及桥板侧面/底面的负例。

### R2 / P1：默认严格连续环境也会启用越障，和独立复核不一致

位置：`game/driving/ContinuousDrivingEnvironment.ts:35,45`；严格审计接入在 `game/driving/audit/RoadPassabilityAudit.ts:368`，其静态支撑检查在 `:163`。

连续环境构造器无条件执行 `mountableQueryOf(this.solids)`，并把它传给支撑和 motion 检查。它不受 `boundarySlide` 或默认严格 footprint 参数控制；低层 sweep 同样无条件按 solid 注解跳过碰撞。审计动态世界现在带有这些注解，因此“审计保持原来触线即拒”尚不成立。

复现：同一带 0.22 岛顶/.25 注解的合成世界，默认连续环境的岛顶放置成功，携带该查询的默认 `validateMotion(-8→8)` 返回 `ok`；独立静态 `footprintSupport` 对同位置返回 `no-surface:island`。该反例的默认逐帧 move 在边缘停止，**没有证明完整审计车辆已经穿岛或错误发布道路**；已证明的是严格参数不能禁用该策略，以及内核与独立复核的规则不一致。

建议：把越障作为显式、有版本的 gameplay policy；严格审计和相机净空查询默认禁用，内核与独立复核消费同一政策。补真实严格审计路径负例，不能只验证静态 helper。

### R3 / P2：mountableHeight 不参与汽车世界摘要

位置：`engine/surface/citySurfacePort.ts:103–104`（结构），`:75–83`（scene proxy canonical values）。

box/prism canonical 字节不包含 `mountableHeight`。主代理用相同几何、预算分别为 .25 和 0 的 descriptor 调用 `canonicalCityWorldBytes`，得到 `sameBytes:true`。因此几何相同而越障语义不同仍能复用 `city-world` 身份。版本字段更新能废除旧版本证据，但不能替代当前快照中参数值的身份绑定。

建议：所有影响碰撞的注解进入规范化字节及源深检；补“只改预算也必须变 revision/失效 lease”的回归。进行中的 S2 静态摘要已部分包含结构预算，汽车道路世界和 scene proxy 路径仍需统一。

### R4 / P2：非法可越预算让坏输入放行

位置：`game/driving/CollisionIndex.ts:118,155`，`engine/surface/compileCitySolidInputs.ts:30–35`。

新增字段未校验有限性。有效 box 加 `mountableHeight: Infinity` 时索引仍为 ready，车体完全处于盒内的 overlap 查询返回 clear；去掉该字段则返回 contact/initial-overlap。当前生成算法预期产生有限值，但公开编译/索引入口的坏输入边界已经失守。

建议：在编译与索引入口拒绝非有限、负数和不符合政策上限的预算；不可将非法预算当成无穷爬升能力。

### R5 / P2：demo 只固定会话，不固定城市种子

位置：`CityExperience.tsx:87–93`、`data/seed.ts:4–12`；桥梁守卫的固定布局在 `scripts/verify-city-driving-bridge-crossing.mjs:46`。

`?demo=1` 确定性生成 280 个会话，但 CityExperience 仍读取持久化 seed，无保存值时生成随机 seed。两台机器或两个干净浏览器可以显示不同岛屿/道路。守卫强制使用 74031，浏览器入口没有同样固定它，因此该测试城市不能代表任意 demo 页面。

建议：为 demo 明确固定独立 seed，或把 seed 作为可分享 URL 契约；正常本地城市的用户种子独立保存。

### R6 / P2：过桥测试跳过桥头，并提前在远端前结束

位置：`scripts/verify-city-driving-bridge-crossing.mjs:94–109`。

测试在桥轴起点向内 1.5 单位处直接放车，成功条件是径向距离大于 `span−7`。这证明了桥面内一段的物理推进，尚未证明从近岸道路上桥、通过远岸接缝、驶出到对岸道路。径向距离也不能代替沿桥轴进度与横向误差断言。

建议：梁桥两方向从桥外真实道路起步，驶出远端至少整车长度，校验有符号沿程、横向范围、层/region 连续性、独立轨迹复核及末态支撑。悬索断头端应单独验证到达护栏后安全停止，不称其对岸道路已通过。桥下补实际运动内核的倾斜/横向进入用例；现有静态 hit 负例保留。

### R7 / P2：两个新回归没有进入公共验证链

位置：`scripts/city-kit/verification.mjs:11–14` 及 `verification-manifest.json`。

主代理直接检查：`verify-city-driving-mountable` 和 `verify-city-driving-bridge-crossing` 在 manifest、game 组中均为 false。手动执行通过不能保证以后常规 game/full 验证继续保护该修复。

建议：登记 manifest、game 组和计数/成员守卫，并证明一次公共命令实际选择、执行了两个脚本。

## 证据与限定

- 主代理本轮重跑 `verify-city-driving-mountable.mjs`、`verify-city-driving-bridge-crossing.mjs`，均通过；桥梁输出为 1 个 island、22 个 bridge-deck、1 个断头端护栏固体。
- 编译/身份审查代理额外验证 structure-surface、surface-port 及 UI typecheck 通过。渲染与碰撞均消费 `bridgeDeckParts`；当前未发现断头横栏在两边不一致。
- 当前高架桥下静态 slab 阻挡用例通过；不据此扩大到所有姿态和连续运动。
- time-drop 的汽车 runtime 回归通过。飞机会话中 30/60/120 与过载集成用例主要是 practice；race 在这些帧率/丢帧条件下的倒计时、过环、超时及一次结算覆盖仍需补齐。此次没有确认 race 的实际计时错误，不将覆盖缺口写成已复现功能回归。
- `CITY_DRIVING_MOUNTABLE_OBSTACLES.md` 仍写未实施以及约 .144 的低路缘边界，与已实现岛缘 .25、桥板 .3–.9 不一致，需同步实际政策、版本及审计隔离规则。
- 共享基础设施的 `invalid-static-solid-geometry` 属于 T6 独立问题；已增加薄旋转构件/实际微小实例回归并修复，不归咎于用户本批次。
- 本报告没有认证所有 worktree 的功能性合并、所有城市道路可通行或原生长时性能。测试与合并历史不能替代这些范围的实证。

## 修复复核追加

R1/R2/R4 已加入整车旋转垂直包络、默认禁用且显式 gameplay 越障、非法注解拒绝以及同策略独立复核。子代理重跑 continuous-driving、driving-collision、road-passability、mountable 均通过；主代理重跑 mountable、bridge-crossing、surface-port、car-session、preparation 与 UI typecheck 通过。R5 已固定独立 demo seed 74031，正常城市存储不变；data 守卫通过。R7 已将 mountable、bridge-crossing 及共享静态世界守卫登记公共 manifest/game，当前 102/26 项，verification harness 通过。这些变更仍在工作区，整批和最终原生验收尚未完成，不能据此宣布所有驾驶/共享架构功能完成。
