# 飞行车（VTOL）实施 — 在新 worktree `feat/flying-car` 中执行已确认的 M1+M2 计划

1. `git worktree add ../skill-vitals-flyingcar -b feat/flying-car dev`，把当前 dev 工作区（含本轮桥/相机/内核未提交修复与并行批次现状）按 `git status` 清单复制进 worktree 并提交为基线快照；symlink node_modules 保持 typecheck/verify 可跑；基线验证（bridge-crossing + typecheck）。
2. M1 物理内核：`DrivingInputState + thruster`、`DrivingMotion + y?`；新 `game/driving/vtolDriving.ts`（VTOL_PARAMS/版本/状态/stepVtolDriving，地面段委托现有 stepDriving）与新 `game/driving/VtolDrivingEnvironment.ts`（地面=组合 ContinuousDrivingEnvironment gameplay 策略；空中=严格策略 3D 扫掠+悬停地板+天花板；落地用 footprintSupport 验证）；新 `scripts/verify-city-driving-vtol.mjs`（起飞/撞墙/落地/水面悬停/天花板/内核界/审计不变式）。
3. M2 UAT 接入：Space=推进器（暂停留 Esc）、`request.vtol` 会话选项、CarAdapter 插值键扩展、HUD 高度/助推/FLY 档位、CityEngine 相机 y 直采、gameCopy 双语。
4. 全量回归（新 vtol + 既有驾驶 verify + typecheck），在 worktree 起 vite（AGENT_VITALS_CITY_GAME_UAT=1，新端口），给出 `?demo=1` 试飞地址。
5. 物理参数按已确认参数表（liftAccel 6 / liftMax 8 / gravity 5 / boost 4s·1s⁻¹·0.5s⁻¹ / 空中 max 15 等）；审计路径不动 VTOL。主 dev 树不做任何修改。