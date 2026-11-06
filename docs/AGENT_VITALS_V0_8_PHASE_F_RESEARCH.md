# v0.8 Phase F —— MCP Surface（首刀）

> Phase D（结构重构）与 Phase E（目录搬迁）已全部完成。Phase F 与前两者**不同类**：
> 它是 spec §0/§1.6/§13 定义的**第三条证据面**（Skill / Session / **MCP**），是
> **净新功能**，不是把已有代码挪个地方——没有"唯一正确形状"可以机械照抄，需要
> 先摸清真实数据长什么样，再决定第一刀切多大。本文档记录调研发现 + 分步计划。

## 1. spec 对 Phase F 的原文约束（§13）

```
### Phase F：再启用 MCP Surface
- 先接被动配置与现有 session 中的 MCP tool-call/result 证据；
- 主动 health probe 必须有用户授权、超时、速率限制和敏感信息边界；
- MCP 健康进入独立 coverage，不用 Skill 或 Session 的空数组代替 unavailable。
```

§1.6 的三面表格把 MCP Surface 定义为「外部工具是否配置正确、可用、可靠」，典型
输入「MCP config、handshake、tool call/result」，输出「`McpServerRecord`、MCP
Finding」。§14 守卫 #11：「Skill/Session/MCP 的 capability 和 coverage 分开，
scanner 不跨 surface 读取」——MCP 结果不能塞进现有的 `tool_calls` 桶假装是 Skill
或 Session 的事。

## 2. 调研发现（本机真实数据 + 现有语料库）

### 2.1 Claude Code 的 MCP 配置——`~/.claude.json`

```
顶层 "mcpServers": {name: {type, url, headers?}}                    # 全局服务器
projects."<path>".mcpServers                                        # 项目级覆盖，同形状
projects."<path>".mcpContextUris                                    # 数组，与服务器名无直接关联，未深入
projects."<path>".enabledMcpjsonServers / disabledMcpjsonServers    # 数组，项目级 .mcp.json 里定义的服务器的启停开关
```

**⚠️ 关键发现（安全边界）**：本机真实配置里，一个项目的 `mcpServers` 携带
`"headers": {"Authorization": "Basic <base64 编码的真实 API key pair>"}`——
**MCP 服务器配置本身就是凭证容器**，与 skill 描述、路径这类"敏感但非机密"的
信息不是一个风险级别。这直接印证了 spec §14 守卫 #14「配置与导出中不得保存
凭证」和本仓库既有教训（`.gitignore` 里 `reports/*.json` 那条注释：
"openclaw-latest.json 曾经被提交进公开仓库，里面有 491 处绝对路径"——同类事故
换成 API key 后果严重得多）。**任何读 `mcpServers` 的代码，`headers`/`env`/
`args`/`url` 里的查询参数/`command` 的参数值都必须视为默认不可扫描导出**，
只能报告"配置了几个服务器、什么 transport 类型（stdio/http/sse）、启用/禁用
状态"这类不可能携带凭证的元信息。这条边界目前**没有先例**——现有 `skills/
redact.py`/`redact.rs` 处理的是路径和人名，不是 API key/token 形态的机密，
需要一份新的、更保守的默认策略（"选择性透出"而不是"选择性隐藏"）。

### 2.2 Session 证据——`mcp__` 命名约定已经在两个执行环境的 wire 里出现

- **Claude Code**：工具调用在 `tool_use.name` 里用 `mcp__<server>__<tool>` 命名
  （三段式，`__` 分隔）——这是笔者所在运行环境自身的 MCP 工具命名约定，可
  100% 确认，但**本仓库现有的 Claude Code fixture 语料库里还没有一条这种
  样本**（`grep mcp__ fixtures/` 只命中 Codex 语料，Claude Code 语料为空）。
  `crates/agent-vitals-harnesses/src/harnesses/claude_code/sessions/evidence.rs`
  的 `normalize_tool_name()` 目前对未知名字走 `other => other` 透传分支——
  `mcp__` 前缀的名字今天原样进 `tool_calls` 桶，**没有被拆成"哪个服务器"**，
  和内置工具（Bash/Read/…）混在同一个计数里。
- **Codex**：`item.type == "McpToolCall"` 是已经存在的 wire 类型（`evidence.rs:109,443`
  已经识别它、计进 `Signal::ToolCalls`），但**只有一条本仓库自己合成的测试
  fixture**（`fixtures/codex/paginated.jsonl:7`，`name:"mcp__github"`——两段式，
  没有第三段 `__<tool>`）——这是 `build_codex_fixture.py` 手写的合成值，不是
  真机 rollout 抓下来的，**Codex 的真实 MCP 工具命名约定尚未验证**，不能假设
  它与 Claude Code 同构（本仓库的既有教训——Codex 一节屡次因为"假设 wire 格式
  与 DSH 同构"被真机证据推翻，见 CLAUDE.md「Codex 行为检测：2026-08 起原生填
  timeline」那段历史）。
- **DSH / WorkBuddy**：未调研，本刀不碰。

### 2.3 现状：MCP 证据"有数据、无面"

MCP 相关的原始事件今天**已经被读到、已经被计数**，只是没有独立身份——
它们混进了 Session Surface 既有的 `tool_calls`/SV611 通用桶。Phase F 第一刀
的价值不是"新增一种探测能力"，是"把已经在读的数据拆出一个新维度"，这也是
为什么 F1（下面）刻意选了风险最低、确定性最高的切面先做。

## 3. 分步计划

```
F1a  Session 证据：从 Claude Code tool_use.name 按 `mcp__<server>__<tool>` 拆出
     服务器维度的调用计数——零新文件读取，只是在已经读的 session 日志里多剥
     一层。Codex 暂不做（命名约定未证实，做了也是编数据）。
     ✅ 完成（`4dc0312`）：`domain/mcp.rs` + `agent/mcp.py` 两个纯函数 +
     `tests/test_mcp.py` 钉死，门禁全绿，已推 origin。
F1b  被动配置：读 `~/.claude.json` 的 mcpServers（全局 + 项目级），只报出
     {name, transport_type, enabled}——headers/env/args/url 等一律不透出。
     **⏸️ 用户 2026-09-04 拍板暂停在 F1a，F1b 留给用户专门评审再定**——问的
     是 §3.1 那张"透出边界"表该按什么口径写（我的方案 vs 更保守只报数量不报
     服务器名 vs 现在就按我的方案写），用户选了"先不做，我来看"，不是选边界
     方案本身。**在用户明确拍板边界之前，不要写读 `~/.claude.json` 的代码**
     ——这是本仓库第一次要读一份确认携带明文凭证的文件，写错默认透出值不像
     其他 Phase E 那种路径改动一样容易补救（报告一旦生成、被复制转发，泄漏
     就已经发生）。
F2   MCP Finding + 独立 coverage（`McpServerRecord`、`doctor`/`behavior` 报告
     新增 MCP 小节，不进 Skill/Session 现有 SV 码空间，走 §14 守卫 #11）。
     依赖 F1b（配置面）才有完整数据可报，本刀不做。
F3+  主动 health probe——spec 原文即要求"用户授权、超时、速率限制、敏感信息
     边界"，本刀不做，留独立授权流程。
```

**Phase F 现状（2026-09-04 收工点）**：F1a 完成，F1b/F2/F3+ 全部暂停，等用户
review。这与 Phase D/E「一路做完」不同——不是规模问题，是这一刀真的踩到了
"读一份携带凭证的文件"这条线，默认值写错的后果和目录搬迁改错路径不是一个
量级，值得为它单独停一次。

### F1b 透出边界（初稿，供确认）

| 字段 | 透出？ | 理由 |
|---|---|---|
| server name（配置里的 key） | ✅ | 用户自己起的名字，不是机密 |
| `type`（stdio/http/sse） | ✅ | 传输方式，不是机密 |
| enabled/disabled（来自 `enabledMcpjsonServers`/`disabledMcpjsonServers`） | ✅ | 布尔状态 |
| 服务器数量、per-project 分布 | ✅ | 聚合统计 |
| `url` | ❌ 默认不透出（可能含 token query 参数或内网地址） | 宁可保守 |
| `headers`/`env`/`args`/`command` 的值 | ❌ 绝不透出 | 已确认真实携带凭证 |
| `command` 的**程序名**（不含 args） | 待定 | 例如 `npx`/`node`——本身低风险，但看是否有必要 |

## 4. 本刀不做

- Codex/DSH/WorkBuddy 的 MCP 证据（命名约定未证实的执行环境不编数据）。
- `~/.claude.json` 之外的 MCP 配置源（例如项目根 `.mcp.json` 文件本身——
  `enabledMcpjsonServers`/`disabledMcpjsonServers` 暗示它存在但本刀未直接读取，
  `~/.claude.json` 里的镜像字段已经够 F1b 用）。
- 主动 handshake/probe（spec 明确要求独立授权）。
- Tauri/CLI 展示层的 MCP 小节 UI（等 F2 数据面稳定后再排）。
