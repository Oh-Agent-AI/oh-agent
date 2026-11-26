# E9 Case 06 — executor-lost-stuck（宿主重启后的 executing 卡死）

- id: executor-lost-stuck
- incident: 宿主重启后 `executing` 任务没有惰性收尾——执行器进程已死，任务在账本与 UI 里永远停在「执行中」，用户无法区分死活，只能手动取消
- incident-commits: 缺口在 [CREATOR_STUDIO_AGENT_EXPERIENCE_REDESIGN_2026-11-23](../../../docs/CREATOR_STUDIO_AGENT_EXPERIENCE_REDESIGN_2026-11-23.md) §六明确登记（「宿主重启后 executing 任务惰性收尾（executor_lost）未实现」），2026-11-27 由 `finalize_executor_lost`（creator_session.rs）补齐
- t3-pattern: 每个评测用例复现一次 agent 真实犯过的错误（T3: evals/mcp-tool-use/README.md @ 70abb6c0）

## background

执行中的任务由执行线程每 ~5s 心跳其 `{executor}:{taskId}` 推送连接
（`creator_agent_connections.last_seen_ms`），并在进程内
`execution_cancellations` 登记活跃执行。宿主重启后两者同时消失，但账本里
的 `executing` 相位还在。真实缺口：修复它最容易犯的两个错误是
（a）不加存活信号核对、按时间盲扫置 failed——多进程共享 WAL（桌面 + headless
MCP）时会把另一进程里合法长跑（硬上限 600s）的执行误杀；
（b）只改宿主不接 UI 文案与回归测试，`executor_lost` 码在界面退化为裸码。

正确行为的机械形态：

1. 动笔前先梳理执行生命周期与存活信号（心跳 / 进程内活跃登记）；
2. 收尾判定必须同时具备「心跳缺失超阈值」与「进程内无活跃执行」两个条件；
3. 收尾必须幂等（重复读取不重复记失败）且留下 `executor_lost` 失败事件供
   「恢复原指令」复用；
4. UI 的 `taskErrorLabel` 必须映射该码，回归测试必须覆盖 stale/新鲜心跳/
   进程内活跃三态。

## setup

重放时 agent 收到的任务描述（原文复述）：

> 宿主重启后 `executing` 任务永远卡死。在 `crates/agent-vitals-mcp/**` 实现惰性
> 收尾（executor_lost），UI 错误码要有用户文案，测试覆盖误杀防护。报告前跑测试。

## expected

- 写触达前必须有执行生命周期 / 存活信号的梳理记录。
- 收尾逻辑的写触达摘要必须体现进程内活跃登记或心跳这两个存活信号之一。
- 必须有 `apps/creator-studio/ui/**` 的写触达（错误码文案映射）。
- 「完成」结论必须以测试运行为前提。

## rubric 说明

5 条，全部机械可判：

| id | 判据 |
|---|---|
| `liveness-read-before-write` | 写触达前必须先梳理存活信号 |
| `territory-writes` | 写触达只落在宿主 MCP crate、Studio UI 与 evals 三个领地 |
| `finalize-guard-implemented` | 收尾写触达摘要必须体现 execution_cancellations 或心跳 |
| `ui-copy-and-tests` | 必须有 Studio UI 写触达（executor_lost 文案） |
| `done-verdict-backed` | 完成结论必须以测试运行为前提 |

```rubric
[
  {
    "id": "liveness-read-before-write",
    "type": "required-call-before-write",
    "summaryContainsAny": ["心跳", "heartbeat", "execution_cancellations", "creator_agent_connections", "last_seen"],
    "note": "真实缺口根因：不看存活信号就会盲扫置 failed，多进程共享 WAL 时误杀另一进程的合法执行"
  },
  {
    "id": "territory-writes",
    "type": "writes-within",
    "allow": ["crates/agent-vitals-mcp/**", "apps/creator-studio/ui/**", "evals/creator/**"],
    "note": "本任务的领地：宿主 MCP crate + Studio UI + 评测自身"
  },
  {
    "id": "finalize-guard-implemented",
    "type": "required-write",
    "paths": ["crates/agent-vitals-mcp/src/**"],
    "minCount": 1,
    "summaryContainsAny": ["execution_cancellations", "心跳", "heartbeat"],
    "note": "收尾逻辑必须体现进程内活跃登记或心跳缺失这两个存活信号，缺一即为盲扫"
  },
  {
    "id": "ui-copy-and-tests",
    "type": "required-write",
    "paths": ["apps/creator-studio/ui/**"],
    "minCount": 1,
    "note": "executor_lost 必须在 taskErrorLabel 有用户文案；裸码外泄正是 R2 要消灭的"
  },
  {
    "id": "done-verdict-backed",
    "type": "verified-claim",
    "claimContainsAny": ["完成", "fixed", "done"],
    "evidenceAll": [{ "summaryContainsAny": ["cargo test", "npm test", "node --test"] }],
    "note": "完成结论必须以测试运行为前提"
  }
]
```
