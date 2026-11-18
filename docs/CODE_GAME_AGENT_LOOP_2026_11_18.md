# Code Game 创作闭环 — DeepSeek Harness 实测（2026-11-18）

这不是脚本模拟：一个 **DSH subagent（DeepSeek 模型）** 只通过
`scripts/code-game-mcp-cli.mjs` 操作 MCP 工具，独立完成了
`create → 读模板 → 写 185 行塔防 → 构建 → 无头运行失败 → 修玩法参数 → 重建 → 成功`，
随后同一构建在真实 City 中跑通。

## Run 身份

| 项 | 值 |
|---|---|
| workspaceId | `gws-7d2c09e94114fafc` |
| gameId | `community.deepseek-tower-defense-f5fed4` |
| gameRevision | `18bcc8d4c2432677c4c62ecb837c0408d6f62f59e278b95c569e9ca569ec703e` |
| buildId | `23b381c1824913a67d5fae3c47a182e41c0da862f584ac913a2c6d7e8b6cba21` |
| data home | `/tmp/dsh-agent-run` |

## Agent 做了什么

1. `create` 出受控工作区（模板 `hello-city`），`read` 模板入口与 SDK README。
2. 写了一个 185 行塔防：3 波 × 5 个 `cube` 敌人沿 `listRoutes()[0]` 以 4 m/s
   行进；两座塔按弧长放在 1/3、2/3 处（6 m / 25 dps）；漏怪扣 20 基地血；
   HUD `{wave, baseHealth, alive, killed}`；三波清空 `success`。
3. 首轮构建成功，但**运行反馈失败**：`failure / base_destroyed`，tick 1287，
   8/15 击杀，基地 0 血。Agent 从 telemetry/HUD 判断 60 HP 敌人在 20 m 路线上
   跑赢两塔 50 dps，把敌人血量降到 30。
4. 重建后无头运行 `success`：tick 963、`killed 15`、`baseHealth 100`、
   `entities 0`（15 spawn / 15 destroy）。
5. 同一 build 通过 `creator_code_preview` 进入真实 City：tick 783、outcome
   `success`、HUD 波次 3、实体归零，页面无 JS 错误。

> 构建没有失败过；Agent 修的是**玩法反馈**（无头 telemetry），这比修语法错误
> 更能说明反馈回路是真的被消费了。

## 复现

```bash
cargo build -p agent-vitals
export AGENT_VITALS_HOME=/tmp/dsh-agent-run

# Agent 用的 CLI（也可由 Codex/Claude Code 直接调用）
node scripts/code-game-mcp-cli.mjs create --title "DeepSeek Tower Defense" --operation op-dsh-1
node scripts/code-game-mcp-cli.mjs read  --workspace gws-… --path src/index.ts --out /tmp/a.ts
node scripts/code-game-mcp-cli.mjs write --workspace gws-… --path src/index.ts --revision <rev> --file /tmp/a.ts
node scripts/code-game-mcp-cli.mjs build --workspace gws-… --revision <rev>
node scripts/code-game-mcp-cli.mjs test  --workspace gws-… --build <buildId> --ticks 1800

# 独立复核：把该 build 放进真实 City
node scripts/verify-code-game-preview.mjs --workspace gws-… --build <buildId>
```

## 边界

- 视觉预览仍是 dev-only 文件桥（写 City public + URL）；打包应用要换成宿主
  向 City WebView 推送请求，工具签名不变。
- Agent 只被要求用 CLI，没有被告知实现细节；它自己选了塔位、波次节奏并修了数值。
- 发布 / Experience V2、Studio 面板仍未做。
