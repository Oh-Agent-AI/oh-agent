# Creator flight E2E 验收运行记录（spec E6，2026-11-16）

状态：E6 首次验收运行记录。脚本：`scripts/verify-creator-flight-e2e.mjs`（纯 node、零第三方依赖）。
规格：[Studio Agent 优先编辑器规格](STUDIO_AGENT_FIRST_EDITOR_SPEC_2026_11_15.md) §8.7 / 切片 E6（消灭 G5「闭环从未跑通留证」）。

## 运行环境与结论

- 分支 `feat/creator-e2e`（基 6ad19eab + merge dev b7e1d9b8 + 一处 build-only 修复，见下）；
  CLI `agent-vitals 1.4.0`，`data-mcp serve --enable-city-tools --allow-local-writes`（74 个工具）。
- 数据根 `~/.agent-vitals`；桌面宿主在运行，但 Creator Studio 插件页未打开——按 §8.4 诚实分档，
  本轮是 **headless-partial** 验收：headless 面全部通过、轨迹分叉留证，Studio 信箱面如实延迟。
- 证据文件：`evidence.json`（`--out` 目录；本轮写入机器本地目录，未入库）。
  verdict `headless-partial`：pass 8 / deferred 3 / not-run 7 / failed 0。

## 七步场景实测

| # | 步骤 | 结果 |
|---|---|---|
| ① | `creator_project_create`（flight-checkpoint + cityId） | **not-run** — 宿主信箱 `plugin_unavailable`（稳定码，~15 s TTL 后） |
| ② | `creator_vehicle_define` ×2 | 结构子集 **deferred**：`creator_vehicle_preview` 双双返回 `validation:"structural"` + `commitBlocked:"deferred-semantic"`（E5 首片）；define 本体 not-run（`plugin_unavailable`） |
| ③ | `creator_city_anchor_upsert`（1 fly spawn + 3 fly gates，自带空域几何/radius） | **not-run**（`plugin_unavailable`；锚点几何语义需 v3 快照，快照需要 Studio 视口） |
| ④ | `creator_mount_bind`（entry=fly spawn，gates 槽位=3 门） | **not-run**（`plugin_unavailable`） |
| ⑤ | `creator_project_publish`（冻结 gameType/vehicleId/runtimeContractVersion） | **not-run**（`plugin_unavailable`） |
| ⑥ | `creator_playtest_start`（`gameType:"flight"` 断言） | **not-run**（`plugin_unavailable`） |
| ⑦ | `creator_playtest_result` + `creator_job_*` + 会话时间线 | 作业/会话面 **pass**（jobs 空、时间线如实不含本轮 commit/playtest）；信箱结果查询 not-run |

Headless 面全部通过：协议握手与工具清单（74 工具含全部七步所需）、`creator_game_type_list`
（6 个类型中 1 个 flight 运行时为 builtin-adapter/playtestSupported——「模板存在 ≠ 可试玩」投影生效）、
`creator_session_open`（幂等重连恢复同一 sessionId）、`creator_vehicle_list`（双 preset + physicsBounds/
physicsRatios 契约）、两架受限调整后的飞行器（flapping mass 300/thrust 6000 vs fixed-wing mass 700/thrust
14000，推重比同为 20 m/s²、翼载不同，全部落在目录范围内）。

## 轨迹分叉证据（消灭 G5 的核心）

`apps/agent-city/mcp/city-game-mcp.mjs`（headless game-control，独立 stdio 进程）对两架飞行器喂
**完全相同的输入脚本**（900 ticks：油门直飞 → 左转爬升 → 回直；同一 spawn(0,40,0)、seed、creator pack
与三门几何）：

| 会话 | vehicle | traceDigest (fnv1a) | 结局 |
|---|---|---|---|
| flap | vehicle-e2e-flap（flapping） | `91663131b58b358b` | 900 ticks 预算耗尽，过门 2/3 |
| fixed | vehicle-e2e-fixed（fixed-wing） | `e6d5201ab9db9e69` | **322 ticks `success`，过门 3/3** |
| flap-replay | vehicle-e2e-flap（重放） | `91663131b58b358b` | 与首跑逐位一致 |

结论：同输入下两份 vehicle profile 产生**不同轨迹且不同比赛结局**（fixed-wing 完赛、flapping 差一门）
——profile 真实参与物理而非换皮；同机重放摘要一致——固定步长确定性成立。这补上了
[flight pipeline 阶段记录](CREATOR_FLIGHT_PIPELINE_2026_11_15.md)里「MCP 运行未留轨迹分叉证据」的缺口。

## 已发现问题（记录，不在本切片修）

1. **dev tip（b7e1d9b8）不编译**：E5 首片（401bf6b8）的 `headless_world_operations(&Value)` 被
   98962420 的 `Vec<Value>` 局部变量打破，`cargo build --release` 全工作区失败。本分支以
   **build-only** 一行修正（调用点包一层 `&Value::Array(...)`，无行为变化）放行本次运行。
2. **E2 试玩作业注册是死代码**：`crates/agent-vitals-mcp/src/mcp/mod.rs` 里 `creator_playtest_start`
   已被前面的 creator_studio 大臂匹配，专设的注册 `register_playtest_job` 分支不可达
   （rustc `unreachable_patterns` 警告可证）。后果：试玩成功启动后 `creator_job_list` 看不到对应
   playtest 作业；E2 的统一作业面在本切片实测中只能靠会话聚合面间接可见。
3. **worktree 依赖缺失**：`apps/agent-city/ui` 无 node_modules 时 game-control MCP 无法解析
   `@agent-vitals/city-sdk`（需要 `packages/agent-vitals-city-sdk` 先 `npm ci && npm run build`
   产出 dist，再在 ui 侧建 workspace 链接）。主 checkout 不受影响；脚本已把该失败如实记为
   trajectory not-run + stderr 摘录。
4. 无作用域会话的时间线聚合是**宿主全局**的（`creator_session_status` 的 playtest 条目来自全部项目，
   非仅 scope 项目）——如实呈现但值得留意：把 scope 传给 open 即可收敛。

## 复跑方式

```bash
cargo build --release
node scripts/verify-creator-flight-e2e.mjs --self-test
node scripts/verify-creator-flight-e2e.mjs --out <目录>   # Studio 打开时自动走完整七步闭环
```

Studio 打开（或 headless 宿主面补齐 E5/E1 后）重跑同一脚本即得 pipeline-complete 全闭环证据；
脚本的 deferred/not-run 判定只认稳定错误码（`plugin_unavailable` / `deferred-semantic` /
viewport 类），不会把降级美化成成功。

## Studio MCP 回归脚本（2026-11-18 增补）

`scripts/verify-studio-mcp-loop.mjs`：Studio 路径（studio-envelope）的**回归断言**，与
本文的 E6 验收记录器分工不同——后者按诚实阶梯记录 headless/deferred/pending，前者每一步
都要求 Studio 真的作答，任何一步被 headless 臂接手（`validation: embedded-sdk`）或形状
不符即失败。

- 覆盖：session → city.create → city.view/status → layout.save → anchor.list/prune/upsert
  → project.create → vehicle.list/define×2 → mount.bind → project.publish → playtest.start
  → playtest.result（City 接走 run 后 result 可能不可读，脚本按 deferred 记录，不当作完成）。
- 前置：Oh Agent 在跑，Creator Studio 是**当前活跃视图**（脚本读 presence，`hidden`/`suspended`
  直接失败），`--data-home` 指向该 app 的数据根。
- 副作用：会新建临时 City / flight-checkpoint 项目 / 两架载具 / 一个 release，并启动一次
  playtest；App 没有删除 City/项目的 MCP 工具，脚本默认不清理，结束时打印全部 id。
- CI 只跑 `--self-test`（helpers 与断言的自检）；live 模式需人工在桌面环境执行。

```bash
node scripts/verify-studio-mcp-loop.mjs --self-test
node scripts/verify-studio-mcp-loop.mjs --bin ./target/release/agent-vitals --data-home ~/.agent-vitals
```
