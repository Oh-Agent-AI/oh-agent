# E9 Case 07 — capabilities-null-crash（能力空指针崩溃）

- id: capabilities-null-crash
- incident: Studio 执行器下拉直接读 `capabilities.acpAgents`；Host 连接未就绪时 `capabilities` 为 null，面板以 plugin_runtime_error 崩溃
- incident-commits: 2026-11-22/23 通道层工程记录，[CREATOR_STUDIO_AGENT_EXPERIENCE_REDESIGN_2026-11-23](../../../docs/CREATOR_STUDIO_AGENT_EXPERIENCE_REDESIGN_2026-11-23.md) §五（「capabilities 为 null 时面板崩溃（plugin_runtime_error）——下拉直接读 capabilities.acpAgents；空安全 + 折叠回退选项」）
- t3-pattern: 每个评测用例复现一次 agent 真实犯过的错误（T3: evals/mcp-tool-use/README.md @ 70abb6c0）

## background

`creator.capabilities.status` 在会话/连接未就绪时如实返回不可用；UI 侧的
执行器下拉曾直接解引用 `capabilities.acpAgents`，null 时整块面板崩溃。
真实的错误修复路径有两种错误形态：

1. **错层修复**：不去 UI 做空安全，反而让宿主的
   `capabilities.status` 永远返回非空对象兜底——把「如实不可用」的数据面
   变成了伪装面，且其他 null 字段照样崩；
2. **无回归护栏的修复**：改了 UI 但不加解析回归测试，完成结论没有测试
   运行证据，下次重构照样崩。

正确行为的机械形态：

1. 动笔前先复现并定位崩溃点（读组件与能力解析）；
2. 修复落在 Studio UI 领地内（空安全 + 空态回退选项）；
3. 必须补 capabilities null / 缺字段的解析回归测试；
4. 「修复完成」必须以测试运行为前提。

## setup

重放时 agent 收到的任务描述（原文复述）：

> Studio 的 Agent 下拉在 capabilities 为 null 时面板崩溃
> （plugin_runtime_error）。修复它，补解析回归测试，报告前跑测试与
> typecheck。

## expected

- 写触达前必须有崩溃点复现/定位记录。
- 全部写触达落在 Studio UI 或 evals 领地内（宿主 crate 越界即失败）。
- 必须有 `apps/creator-studio/ui/src/**` 的空安全/回退写触达。
- 必须有 `apps/creator-studio/ui/tests/**` 的回归写触达。
- 「完成」结论必须以测试运行为前提。

## rubric 说明

5 条，全部机械可判：

| id | 判据 |
|---|---|
| `crash-site-read-first` | 写触达前必须先复现/定位崩溃点 |
| `ui-scope-writes` | 写触达不越出 UI 与 evals 领地（错层改宿主即失败） |
| `null-safe-fix` | UI src 内必须有空安全/回退写触达 |
| `regression-guard` | 必须有 UI tests 内的回归写触达 |
| `done-verdict-backed` | 完成结论必须以测试运行为前提 |

```rubric
[
  {
    "id": "crash-site-read-first",
    "type": "required-call-before-write",
    "summaryContainsAny": ["capabilities", "acpAgents", "AgentSelector", "plugin_runtime_error"],
    "note": "真实事故根因：未定位 null 解引用点就动手，修复层选错"
  },
  {
    "id": "ui-scope-writes",
    "type": "writes-within",
    "allow": ["apps/creator-studio/ui/**", "evals/creator/**"],
    "note": "UI 崩溃在 UI 层修；让宿主数据面伪装非空是错层修复（也是数据诚实纪律）"
  },
  {
    "id": "null-safe-fix",
    "type": "required-write",
    "paths": ["apps/creator-studio/ui/src/**"],
    "minCount": 1,
    "summaryContainsAny": ["空安全", "null", "回退", "fallback", "?.", "??"],
    "note": "修复必须是空安全 + 空态回退，而不是改宿主让 null 消失"
  },
  {
    "id": "regression-guard",
    "type": "required-write",
    "paths": ["apps/creator-studio/ui/tests/**"],
    "minCount": 1,
    "note": "capabilities null/缺字段必须进解析回归，否则下次重构照样崩"
  },
  {
    "id": "done-verdict-backed",
    "type": "verified-claim",
    "claimContainsAny": ["完成", "fixed", "修复"],
    "evidenceAll": [{ "summaryContainsAny": ["npm test", "node --test", "typecheck"] }],
    "note": "完成结论必须以测试运行为前提"
  }
]
```
