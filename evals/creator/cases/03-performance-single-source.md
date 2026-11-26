# E9 Case 03 — performance-single-source（语义重复实现漂移）

- id: performance-single-source
- incident: 同一飞行语义（巡航速度推导 = maxSpeed/1.8）在宿主 Rust 与引擎 TS 各实现一份，从第一天起就漂移，且没有任何东西比较它们
- incident-commits: bba644b7（fix(creator): single-source flight performance derivation in the SDK——修复）、8859ff9d（refactor(creator): 把投影彻底移出宿主——终态）
- t3-pattern: 每个评测用例复现一次 agent 真实犯过的错误（T3: evals/mcp-tool-use/README.md @ 70abb6c0）

## background

事故形态（bba644b7 提交描述原文摘要）：

- 宿主 Rust 把巡航速度推导为 `maxSpeed / 1.8`；
- 引擎 TS 从同一 profile 推导 `Math.max(6, maxSpeed / 1.8)`；
- 同一飞行语义从第一天起就有两份实现，**且没有任何测试比较它们**。

修复后的单源结构（bba644b7 → 8859ff9d 的终态）：

- city-sdk 拥有推导：`packages/agent-vitals-city-sdk/src/vehicleProfile.ts` 定义
  `VEHICLE_PERFORMANCE_DERIVATION_V1`（cruise divisor）与 `estimateVehiclePerformanceV1()`，
  经 `packages/agent-vitals-city-sdk/src/index.ts` 导出，并投影进生成目录
  （`performanceDerivation` + 每 preset 一个 `performanceVector`）；
- 引擎 `apps/agent-city/ui/src/game/FlightSimulation.ts` 的 `vehicleFlightParams` **消费** SDK
  常量，剩余自由度只有米→世界单位换算与操控增益（UI lockstep 测试钉住）；
- 宿主不再持有飞行启发式：`apps/desktop/src-tauri/src/creator_projects.rs` 只按生成目录里
  **声明**的推导求值，共享向量测试钉住与 SDK 逐位相等；8859ff9d 进一步把宿主投影整个移除
  （`creator.vehicle.preview`/`inspect` 不再返回该字段，由 Studio 适配器从 SDK 注入）。

## setup

重放时 agent 收到的任务描述（原文复述；**故意不指定实现位置**——陷阱是宿主与引擎各写一份）：

> 给 creator_vehicle_preview 增加 estimatedPerformance 巡航速度投影，要求长期不漂移。

## expected

- 推导的唯一实现位置是 city-sdk（`vehicleProfile.ts`，`index.ts` 导出）；SDK 写触达描述必须
  点名单源符号（`estimateVehiclePerformanceV1` / `VEHICLE_PERFORMANCE_DERIVATION_V1`）。
- 引擎必须有写触达（接线），且只能**消费** SDK 符号——引擎写触达描述必须出现 SDK 符号或
  「消费 SDK」表述，不得出现本地重推导描述。
- 宿主不得持有公式：`creator_projects.rs` / `creator_studio.rs` 的写触达描述不得出现
  公式文本（`maxSpeed / 1.8` 等）。
- 修复必须带比较测试（`performanceVector` / 共享向量 / 锁步）——事故根因正是「没有任何
  东西比较两份实现」。
- 「单源 / 不再漂移」结论必须以 SDK 写触达 + 比较测试双证据为前提。

## rubric 说明

7 条，全部机械可判：

| id | 判据 |
|---|---|
| `sdk-owns-derivation` | 推导必须落在 city-sdk 且点名单源符号 |
| `sdk-export-named` | SDK 写触达描述必须点名导出符号 |
| `engine-touch-required` | 引擎必须有接线写触达 |
| `engine-consumes-sdk` | 引擎写触达只能以消费 SDK 符号的形态描述 |
| `host-holds-no-formula` | 宿主写触达不得出现公式文本 |
| `shared-vector-test` | 必须新增共享向量/锁步比较测试 |
| `single-source-verdict-backed` | 单源结论需要 SDK 写触达与比较测试双证据 |

```rubric
[
  {
    "id": "sdk-owns-derivation",
    "type": "required-write",
    "paths": ["packages/agent-vitals-city-sdk/src/vehicleProfile.ts"],
    "minCount": 1,
    "summaryContainsAny": [
      "estimatevehicleperformancev1",
      "vehicle_performance_derivation_v1",
      "巡航推导",
      "性能推导"
    ],
    "note": "推导的唯一实现位置是 city-sdk 的 vehicleProfile.ts"
  },
  {
    "id": "sdk-export-named",
    "type": "write-summary-must-contain",
    "paths": ["packages/agent-vitals-city-sdk/src/vehicleProfile.ts"],
    "anyOf": ["estimatevehicleperformancev1", "vehicle_performance_derivation_v1"],
    "note": "SDK 写触达描述必须点名单源符号，便于跨会话锚定"
  },
  {
    "id": "engine-touch-required",
    "type": "required-write",
    "paths": [
      "apps/agent-city/ui/src/game/FlightSimulation.ts",
      "apps/agent-city/ui/src/game/GameSession.ts"
    ],
    "minCount": 1,
    "note": "引擎消费接线必须有真实写触达"
  },
  {
    "id": "engine-consumes-sdk",
    "type": "write-summary-must-contain",
    "paths": [
      "apps/agent-city/ui/src/game/FlightSimulation.ts",
      "apps/agent-city/ui/src/game/GameSession.ts"
    ],
    "anyOf": [
      "estimatevehicleperformancev1",
      "vehicle_performance_derivation_v1",
      "消费 sdk",
      "consume sdk"
    ],
    "note": "引擎只能消费 SDK 符号；真实事故是本地重推导 Math.max(6, maxSpeed / 1.8) 第二实现"
  },
  {
    "id": "host-holds-no-formula",
    "type": "write-summary-must-not-contain",
    "paths": [
      "apps/desktop/src-tauri/src/creator_projects.rs",
      "crates/agent-vitals-mcp/src/mcp/creator_studio.rs"
    ],
    "literals": [
      "maxspeed / 1.8",
      "maxspeed/1.8",
      "math.max(6",
      "cruise = maxspeed",
      "巡航公式"
    ],
    "note": "宿主不得出现公式文本（真实事故：Rust 侧 maxSpeed / 1.8 与引擎漂移）"
  },
  {
    "id": "shared-vector-test",
    "type": "required-write",
    "paths": [
      "packages/agent-vitals-city-sdk/tests/**",
      "apps/agent-city/ui/tests/**",
      "apps/desktop/src-tauri/src/**"
    ],
    "minCount": 1,
    "summaryContainsAny": ["performancevector", "共享向量", "锁步", "lockstep", "shared-vector"],
    "note": "事故根因是「没有任何东西比较两份实现」——修复必须带比较测试"
  },
  {
    "id": "single-source-verdict-backed",
    "type": "verified-claim",
    "claimContainsAny": ["单源", "single-source", "不再漂移", "no drift"],
    "evidenceAll": [
      { "isWrite": true, "pathGlob": "packages/agent-vitals-city-sdk/src/vehicleProfile.ts" },
      {
        "summaryContainsAny": ["performancevector", "共享向量", "锁步", "lockstep", "shared-vector"]
      }
    ],
    "note": "单源结论需要 SDK 写触达与比较测试双证据，缺一即失败"
  }
]
```
