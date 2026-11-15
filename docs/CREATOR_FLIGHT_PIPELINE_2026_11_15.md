# Creator flight pipeline 阶段 2-5（2026-11-15）

## 已实现

### 阶段 2：fly 空域锚点

MCP：

- `creator_city_anchor_list`
- `creator_city_anchor_upsert`
- `creator_city_anchor_remove`

行为：

- 每次写入创建新的不可变 City revision 和 scoped layout；
- 新锚点只能复用该 City 已有的 `geometryRef`，不接受任意坐标；
- capabilities 必须包含 `fly`，且不重复；
- 操作走 revision CAS + operationId 幂等；
- 旧 revision 保持可读。

### 阶段 3：typed mount / bind preview

MCP：

- `creator_mount_list`
- `creator_mount_bind`
- `creator_mount_unbind`
- `creator_game_bind_preview`

宿主构造 layout/game digest，校验 slot 的 min/max 与 anchor capability；不接收调用方 digest。预览如实把 reachability/visual 标为 unchecked。

### 阶段 4：发布冻结与 flight 试玩

- project 创建记录 `gameType`；
- flight release 冻结 `gameType`、`vehicleId`、完整 vehicle profile、`runtimeContractVersion=1`；
- flight 发布要求唯一 vehicle（或显式 `vehicleId`）与至少一个 mount；
- `creator_playtest_start` 支持可选 `gameType` 断言，路由权威仍是 release 冻结值；
- City 插件已有 flight handoff（`creatorPlaytest.gameType === "flight"`）。

### 阶段 5：飞行试玩的闸门与证据（2026-11-15 续）

- 门来自 release：`createCreatorGateCourse` 按 mount 绑定的 fly 锚点生成环，
  **可见环半径 = SDK 触发半径**（画得比判定大就是谎报"我穿过了"）；
  内置生成路线与 `RaceMission` 在 Creator 试玩里不参与判定。
- 判定复用共享规则执行器：`GameSession` 把飞行器的米制机位逐帧喂给
  `CreatorMiniGameRuntimeControllerV1`（与驾驶同一份 SDK runner），结局只收敛一次
  （相位/暂停/emit）后回调宿主。
- 结果如实上报：试玩结束按 pack 规则给出 `completed`/`failed` 与
  `VisualPlaytestEvidenceV1`（releaseId/revision/snapshotDigest/worldRevision/seed/
  tick/counters/outcome/reasonCode），不再是"退出即 cancelled"；受理失败（计划不成立）
  以计划诊断码收口，不占用唯一活跃试玩槽。
- 能力不再写死 `drive`：plan 入口与槽位按 `drive`/`fly` 参数化，驾驶路径逐字不变。

尚未验证 / 未做：

- 未在真机 UI 里目检空域门环与 HUD 进度（本轮验证是 typecheck + 单测 + 构建）；
- 飞行试玩仍用默认出生逻辑（首个门后方安全位），没有从 mount 的入口锚点起飞；
- 真机试玩仍未采集 telemetry 曲线；**无头**的确定性 trace 已可用
  （`docs/CITY_GAME_MCP.md` 的 `city-game-control` MCP，用显式门跑同一套规则执行器）。

### 配套：通用游戏操控 MCP（2026-11-15）

`apps/agent-city/mcp/city-game-mcp.mjs`（`game_open/step/script/state/trace/close`）让
Agent 用**同一套输入词表**无头跑 flight 与 driving：门由参数给出，规则走
`createMountedMiniGamePlan` + `MountedMiniGameControllerV1`（与 UI 试玩同一份），固定
1/60 s 步长、同参数同轨迹并带 `traceDigest`。它不读 release、不解析 City 布局、不写证据、
不带城市碰撞——真机发布链路仍走 creator MCP。

## 验证

- city-sdk：127/127；
- MCP：88/88；
- desktop lib：除 overview 两个并行 flaky 用例外通过；单独复跑通过；
- Rust 新增测试：
  - fly anchor revision/list/remove；
  - typed mount fly capability/slot count/unknown vehicle；
  - flight publish freeze；
  - airspace → project → vehicle → mount → publish → playtest 后端端到端。
- Studio build/typecheck 通过。

## MCP 真机端到端

已完成完整最小链路：

```text
city       city-4375314413d0862154a055384c01c1d4
layout     city-layout-v1:42:100:501b17412264f858145a94bbcefccb5a
revision   2 (64 anchors，含 air-gate:0..2)
project    project-bb75108542ab6a4e43ee0ddf4a462f44
vehicles   vehicle-flap (flapping) / vehicle-fixed (fixed-wing)
mounts     mount-flap / mount-fixed
release 1  release-87b8775c6b8e5d52afa57a0cb49c2cb2 (vehicle-flap)
release 2  release-d7fa8f5e3e4589d069fd2de4d2008b88 (vehicle-fixed)
playtests  playtest-eb7c8664a453c7bd7ffdc6192aea2d0f
           playtest-2e0fc87d22d0fb0317e023a85bdce37a
```

MCP 调用序列：

1. `creator_city_anchor_list`；
2. `creator_city_anchor_remove` 释放 3 个锚点；
3. `creator_city_anchor_upsert` 加 3 个 fly gates；
4. `creator_project_create`（`flight-checkpoint` + cityId）；
5. `creator_vehicle_define` 两次；
6. `creator_mount_bind` 两次（不同 vehicle）；
7. `creator_project_publish` 两次（冻结 vehicle/gameType/runtime）；
8. `creator_playtest_start` 两次，均为 `gameType:"flight"`。

修复的真实传输 bug：Studio `vehicle.define/preview` handler 把展平的 MCP 字段
（label/physics/bounds/...）原样回传，Rust dispatch 的 exact-key 校验因此返回
`creator_request_invalid`。现在 handler 只回传宿主契约字段
（projectId/baseRevision/vehicleId/vehicle/operationId/validation）。

### 轨迹分叉

SDK/运行时测试已证明两个 vehicle preset 在同一 420-tick 输入下轨迹分叉且重放
一致（phase 1 的 vehicle-profile 测试）。本次 MCP 运行验证的是
创建→绑定→发布→两次 flight 试玩启动；没有从 City 实机抓取两次完整飞行的
telemetry 曲线，因此不把“实机轨迹分叉”作为本轮 MCP 证据。

## 结论

阶段 2/3/4 代码、后端测试和 MCP 最小双飞行器链路均已完成。剩余的非本阶段项是
City 实机完整飞行 telemetry 采集与扑翼气动/动画深化。
