# Creator flight pipeline 阶段 2-4（2026-11-15）

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

## MCP 真机端到端进度

已完成：

1. `creator_city_anchor_list` 读取 City 64 个锚点；
2. `creator_city_anchor_remove` 释放 3 个锚点 → revision 1；
3. `creator_city_anchor_upsert` 添加 3 个 fly gates → revision 2；
4. `creator_project_create` 用 `flight-checkpoint` + cityId 创建项目
   `project-976c1fce4eb6da4acb60c6dfb7c39e8f`。

未完成：

5. `creator_vehicle_define` 返回 `data_unavailable`（Studio request failed），
   两架飞行器未能通过 MCP 定义；
6. 因此 typed mount、publish、两次 flight playtest 和轨迹分叉尚未通过 MCP 链路。

`data_unavailable` 不是 Rust 结构错误码；需要继续定位 Studio `creator.vehicle.*`
handler 的异常。后端同路径已由 `flight_pipeline_tests` 证明可走通，所以问题在
Studio/MCP 传输层，而不是锚点/绑定/发布逻辑。

## 结论

阶段 2/3/4 的代码与后端测试已落地；MCP 最小双飞行器链路还差 vehicle define
的 Studio 传输修复，不能宣称端到端完成。
