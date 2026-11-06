# Agent City 目标架构

日期：2026-10-08。状态：提案。基线 = `merge-test-landmarks`。
整合 CITY_ENGINE_SPLIT_SPEC（渲染拆分）、CITY_BUILDING_MODEL_SPEC v2（建筑范式）、CITY_ROAD_F1_ALGORITHM_SPEC（路网），
解决现状三个结构问题：规划是「一次生成 + 层层补丁」、渲染是 4425 行单体、守卫靠源码正则。

## 1. 分层（单向依赖，上层只读下层产物）

```
L0 输入      CityModel（会话 → 楼）· seed · tier · theme              纯数据
L1 规划      planner/  地形 → 骨架 → 选址 → 路网 → 街区地块          纯函数，确定性，无 three
L2 布局      layout/   会话 → 地块分配、生长、空地绿化                 纯函数
L3 场景描述  scene/    Plan+Layout → SceneSpec（建筑 Part 流、路面、灯）纯数据，可哈希
L4 渲染      render/   SceneSpec → three 对象（编译器、批次、材质缓存）只认 SceneSpec
L5 运行时    runtime/  相机、日夜、回放游标、拾取、动画                 只改 uniforms / 矩阵
```

规则：
- L1–L3 **不依赖 three**，可在 Node 里跑、可哈希比较，守卫测这三层的数据而不是源码文本。
- L4 不做任何「决定」（不选址、不判断是否发光），只把 SceneSpec 翻译成 three。
- 依赖方向由 `tests/` 里的 import 边界守卫钉住（同 Rust 侧 dependency_budget 的做法）。

## 2. L1 规划：从「补丁链」改成「约束 + 修复循环」

现状问题：十几道修补步骤各修各的，后一步破坏前一步（广场偏离环岛、车流回路丢失、庄园贴桥头都是此类）。

目标结构：

```
planner/
  terrain.ts      地形、海岸、河流（现 cityPlan 前 200 行）
  skeleton.ts     核心点 + 广场 + 放射主干 + 桥 + 高架环线（核心点与广场一体决定）
  siting.ts       全部用地/地标的候选位置（条件式候选表），只产候选，不落位
  network.ts      沿岸路、河岸路、街网、接入路生成
  constraints.ts  约束集合：每条 = { id, measure(plan): Violation[], repair?(plan, v): boolean }
  solve.ts        循环：生成 → measure 全部约束 → 按优先级 repair → 重测，直到无违例或 N 轮
  parcels.ts      街区切分与地块（最后一步，读最终路网与用地）
```

- **约束即守卫**：路穿用地、门前有路、广场在环岛中心、正面贴路、不在水里、不贴桥头、断头路、
  平行重叠路、锐角路口……每条约束同一份 `measure` 既给 solve 用，也给 CI 守卫用——
  「规划器认为合格」与「守卫认为合格」不可能再分叉。
- **选址后置**：地标先出候选，路网生成后再在候选里挑满足约束的位置（根治「地标先放、路后绕」）。
- **修复手段有限且明确**：移动用地（在候选内）、补/删一条路段、绕行。禁止修复步骤再生成新骨架。
- F1 完整版（需求点寻路、随回放长路）作为 `network.ts` 的可替换实现，不影响其他模块。

## 3. L3 场景描述 SceneSpec

```ts
type SceneSpec = {
  buildings: Array<{ modelId: string; instance: string; at: Vec3; yaw: number; input: GeometryInput }>;
  sessionTowers: SessionTowerSpec[];     // 会话楼单独通道：高度=数据，形态=策略
  roads: RoadSurfaceSpec[];              // 路面 runs、接缝、路口
  lights: LightSpec[];                   // 每个光源带预算类别（cityLightBudget）
  decor: DecorSpec[];                    // 树、海滨设施等散布物
};
```

- 建筑走 BuildingModel（v2）：`geometry(input) → Part[]`，纯数据。
- 「这盏灯亮多少」「这扇窗亮不亮」在 L3 用预算决定，L4 只照做——夜景调参一处生效。
- SceneSpec 可整体哈希：重构渲染层时，用「同 seed 的 SceneSpec 哈希 + 编译后场景图哈希」证明零视觉变化，
  不需要 GPU 截图。

## 4. L4 渲染

```
render/
  compiler.ts       Part[] → Group（单体）；材质按 (role,color,side,light) 缓存
  batchRegistry.ts  实例批次唯一所有者：batch / claim / seal（漏 seal 守卫报错）
  facadeMaterial.ts 会话楼立面 shader
  systems/          terrain / buildings / landmarks / roads / civic / seaside / nature / ambient
  cityParts.ts      ~350 行编排器（对外 API 不变）
```

即 CITY_ENGINE_SPLIT_SPEC 的结构，区别是 systems 的输入改为 SceneSpec 片段，不再直接读 layout 自己做决定。

## 5. L5 运行时

只负责随时间变化的东西：日夜（读预算曲线）、回放游标（生长进度）、相机/航拍、拾取映射、spinner。
不重建几何；需要重建时回到 L1–L3 重新产出 SceneSpec（按 activityKey 缓存）。

## 6. 测试分层

| 层 | 测什么 | 方式 | 速度目标 |
| --- | --- | --- | --- |
| 约束 | 规划/布局结果 | `constraints.ts` 的 measure 直接复用 | 30 岛 < 2 分钟（原生 Node，不进 vm） |
| 场景 | SceneSpec 确定性、模型契约 | registry 驱动的 verify-city-models | < 30 秒 |
| 等价 | 重构零视觉变化 | SceneSpec 哈希 + 场景图哈希 | < 1 分钟 |
| 端到端 | 真渲染 | 少量真 GPU 截图，人工抽查 | 手动 |

现状 `verify:city` 25–30 分钟的主因是 vm 沙箱里重复生成大岛；改为原生 Node + 每个 (seed, tier) 只生成一次、各守卫共享。
源码正则类守卫全部退役，改为对数据断言。

## 7. 迁移路径（每步可独立停、视觉零变化）

| 步 | 内容 | 前置 |
| --- | --- | --- |
| 0 | 合并 `merge-test-landmarks` 进 main | — |
| 1 | 测试提速：共享岛缓存、原生 Node 运行器 | 0 |
| 2 | 建立基线：19 栋建筑场景图哈希 + 30 岛 Plan 哈希 | 1 |
| 3 | 渲染拆分（CITY_ENGINE_SPLIT_SPEC 步骤 1–6） | 2 |
| 4 | 建筑范式 v2 批 0a/0b/2/1 | 2（可与 3 并行，不同文件） |
| 5 | 约束抽取：把现有守卫与修补步骤改写成 `constraints.ts`，solve 循环替代补丁链 | 2 |
| 6 | 选址后置（候选表 + 路网后落位） | 5 |
| 7 | SceneSpec 层落地，systems 改读 SceneSpec | 3、4 |
| 8 | 可选：F1 完整版路网 | 5 |

步 1–2 是其余所有步骤的安全网，优先级最高；步 5–6 解决最近反复出现的规划问题，收益最大。

## 8. 不做

- 不换渲染技术（three 实例化保留）、不迁 Rust、不做内容包分发。
- 不改会话楼「token → 高度」语义。
