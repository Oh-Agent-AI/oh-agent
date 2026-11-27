# Studio ACP 执行器桥接脚本

Creator Studio 的 Agent 执行器支持 ACP（Agent Client Protocol v1，stdio JSON-RPC）。
这两个脚本把本机 CLI 包装成最小 ACP agent，供宿主 `creator_task_execute` 驱动：

- `zcode-acp` — 把 `zcode -p`（无头单发）包成 ACP：`initialize` / `session/new` /
  `session/prompt` / `session/update` 流 / permission 拒绝。每轮以 `--mode plan`
  运行（只分析不落盘），诚实闸由宿主 Preview 面把守。会话在独立临时工作区中运行，
  只注入宿主提供的 creator MCP，不继承用户其它 MCP 工具。
- `acp-claude` — 补齐 GUI 进程受限的 PATH 后调用 `claude-code-acp` 适配器。

## 安装

宿主从 `~/.agent-vitals/acp-agents.json` 注册表解析 `acp:<agentId>`，未登记的 id
会按内置发现表在 PATH 上查找（`zcode-acp` / `claude-code-acp` / `acp-claude`）。
推荐把脚本安装到固定位置并显式登记：

```sh
mkdir -p ~/.agent-vitals/bin
cp scripts/acp/zcode-acp scripts/acp/acp-claude ~/.agent-vitals/bin/
chmod +x ~/.agent-vitals/bin/zcode-acp ~/.agent-vitals/bin/acp-claude
cat > ~/.agent-vitals/acp-agents.json <<'EOF'
{
  "agents": [
    { "id": "claude-code", "name": "Claude Code (ACP)", "command": "/Users/你/.agent-vitals/bin/acp-claude", "args": [] },
    { "id": "zcode", "name": "ZCode CLI (ACP)", "command": "/Users/你/.agent-vitals/bin/zcode-acp", "args": [] }
  ]
}
EOF
```

## 已知的模型路由边界（2026-11-27 实测）

- **zcode**：无头 `-p` 的模型目录只来自 `~/.zcode/v2/provider_config.json` 的
  个人 provider（`providerOrder` 首项）。桌面端的订阅 provider
  （`account:*-coding-plan`）是桌面运行时状态，独立 CLI 进程不可见——CLI 侧
  需要个人 provider 的 key 有余额，或等待 ZCode 桌面暴露本地会话通道。
- **claude**：走 `claude-code-acp` 自身登录，额度随 Claude 账户余额。
- 失败原因会优先取子进程 stderr 的 `Cause:` 行上报（如 402/429 的余额信息），
  Studio 失败卡直接显示原因。
