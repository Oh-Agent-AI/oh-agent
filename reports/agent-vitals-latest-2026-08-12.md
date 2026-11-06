# Agent Vitals 最新报告

扫描时间：2026-08-12（Asia/Shanghai）  
扫描器：当前工作副本 `scripts/scan.py`  
范围：Claude Code、Codex、OpenClaw、Hermes、腾讯 WorkBuddy

## 技术摘要

当前实际发现四套技能库：Claude Code 有 3 个可发现 skill，Codex 通过官方 `app-server skills/list` 验证到 18 个，OpenClaw 两个实例合计有 50 个可发现候选（按实例隔离后去重为 45 个），WorkBuddy 当前 Work 模式有 12 个可用顶层 Skill。Hermes 的已知目录未发现 skill。各运行时的上下文相互独立，不能相加为一个预算。

Codex 不再只靠目录猜测：发现范围、启用状态、scope、interface 和 dependencies 均由本机官方运行时返回。按 OpenAI 官方的“模型上下文 2%，未知时 8,000 字符”规则，当前 18 个 Codex skill 的初始列表估算使用约 89.9%，已接近阈值但尚未超限。Codex 逐 skill 触发次数仍没有公开接口。

## 执行环境盘点

| 执行环境 | 磁盘 skill | 可发现 skill | Tier 1 估算 | 描述预算 | 触发数据 |
|---|---:|---:|---:|---|---|
| Claude Code | 50 | 3 | 约 466 token | 941 / 15,000（6.3%） | 可用 |
| Codex | 18 | 18 | 约 1,725 token | 约 7,192 / 8,000（89.9%，官方 fallback 估算） | 未获取 |
| OpenClaw | 50 | 50 个候选（按实例去重后 45） | 约 3,551 token 候选成本 | 未获取 | 未获取 |
| Hermes | 0 | 0 | 0 | 未获取 | 未获取 |
| WorkBuddy | 18 个顶层缓存包 | Work 模式 12 个 | 约 1,859 token | 未获取 | 未获取 |

“磁盘 skill”包含 Claude Code 未启用插件副本；可发现 skill 才是该执行环境当前会考虑的集合。Codex 预算规则已有官方依据，但 `skills/list` 不返回当前模型上下文窗口，因此本报告采用官方 8,000 字符 fallback，属于可复算估算而非实际提示词遥测。OpenClaw、Hermes 与 WorkBuddy 的预算及非 Claude 执行环境的逐 skill 使用计数仍报告为未获取。

### WorkBuddy：当前 Work 模式为 12 个 Skill

本机存在 `~/.workbuddy`，WorkBuddy 5.3.12 正在运行。运行时使用 `~/.workbuddy/plugins/cache/workbuddy-builtin/skill-*/<version>/SKILL.md`；marketplace manifest 提供顶层包名和版本。manifest 有 18 个 `category=skill` 顶层包，当前会话日志明确显示 `welcomeMode=work`，6 个只在设计模式注入的 `ardot-*` 包被过滤，剩余 12 个与 WorkBuddy 自报列表逐项一致。

此前的 46 来自把 `builtin-plugin` 包内部的 28 个 `SKILL.md` 也当成顶层 Skill，这是错误口径；它们是文档、表格、PPT 等插件的内部实现资源。`.orphaned_at` 在内置种子缓存里也不能直接解释为禁用。当前可以可靠评估缓存安装版本、manifest 成员、welcome mode、frontmatter 和上下文估算；仍没有公开的描述预算阈值或累计触发统计接口。

## 关键发现

### Codex：运行时字段已补齐，预算接近阈值

旧扫描只遍历 `~/.codex/skills`，漏掉插件缓存和系统 skill；官方运行时本次返回 18 个，字段包括 `path`、`scope`、`enabled`，并在存在时返回 `interface` 与 `dependencies`。当前描述清单估算约占 fallback 阈值 89.9%。Codex 的实际策略会先缩短描述，仍超限才省略 skill 并给出警告，因此“接近阈值”不等于已有 skill 丢失。

`design-taste-frontend` 的 `SKILL.md` 正文估算约 21.7k token；新发现的 `documents:documents` 核心正文约 9.7k token、连同 references 最坏约 19.5k token。这些不是常驻成本，而是触发后的读取成本。

### OpenClaw：多实例工作区已纳入扫描

扫描器现从 OpenClaw 实例配置读取工作区，并以实例 ID 隔离冲突域：`.openclaw` 有 22 个候选，Tier 1 候选成本约 2,007 token；`.openclaw-xiongshu` 有 28 个磁盘候选、23 个唯一名称，Tier 1 候选成本约 2,289 token。两实例都没有可调用的运行时 skill list，因此这些记录标记为 discoverable、`loaded_state=unknown`、`runtime_verified=false`，不再伪称已加载。`web-design-engineer` 的核心正文估算约 8.2k token，超过 6k 的拆分阈值。

### Claude Code：预算健康，尚无僵尸结论

Claude Code 3 个可发现 skill 的描述预算为 6.3%，远低于扫描器使用的 15,000 字符阈值。`agent-vitals` 仅安装约 1.1 天且零触发，仍处于 14 天观察期，不应删除或判为僵尸。其余已加载 skill 的累计触发次数为：`web-video-presentation` 37 次、`pm-xiongshu` 7 次。

### 覆盖冲突

Claude Code 与 Codex 未发现覆盖冲突。OpenClaw 按实例隔离后从 11 条候选降为 2 条，均位于 `.openclaw-xiongshu`：`md2wechat` 有多个嵌套副本，其中部分内容相同、部分不同；`web-video-presentation` 同时存在顶层版本和 `garden-skills` 版本。它们是真实的实例内候选冲突，但由于缺少运行时列表，最终采用哪一份仍需在 OpenClaw 内验证。

## 安全复核

扫描器在当前顶层 Skill 口径下发现 3 个 critical 级启发式命中，但不能直接等同于恶意代码：

| 执行环境 | skill | 加载状态 | 复核结果 |
|---|---|---|---|
| Claude Code | `agent-vitals` | 已加载 | 3 条均为安全规则/注入示例的引用语境；建议保留人工复核记录。 |
| Claude Code | `receipts` | 未加载 | 1 条为注入示例的引用语境；当前不进入上下文。 |
| Codex | `plugin-creator` | 已加载 | 1 条 `Do not tell the user` 命中未被引用启发式标记；该句位于技能作者指南，应由维护者人工查看其上下文后决定是否将规则改为更精确的描述。 |
| OpenClaw | `podcast-voice-video` | 可发现候选，运行时未验证 | 1 条 medium 级 `chr(92)+` 命中处于引用语境；需人工确认，但不应直接视为恶意。 |

该扫描是正则启发式：命中不证明恶意，也不能证明未命中的 skill 安全。

## 方法与限制

- Tier 1 / Tier 2 均为估算，不是真实 tokenizer 计数。
- Claude Code 的预算不包括内置 skill，因此实际使用量可能更高。
- Codex 运行时字段来自官方 `skills/list`；逐 skill 触发记录仍不可用，零使用不等于僵尸。
- Codex 预算按官方 8,000 字符 fallback 估算，无法证明某次具体会话实际注入了多少字符。
- 本次 Claude Code 扫描到的是已安装副本；本仓库中刚完成的多执行环境适配尚未复制到该安装目录。

## 建议下一步

1. 优先精简 Codex skill 的 description，使 8,000 字符 fallback 下保留至少 20% 余量；再评估拆分 `design-taste-frontend` 与 `documents:documents` 的正文。
2. 将当前仓库版本安装/同步到目标执行环境目录后再扫描，尤其是 Claude Code 现有的 `agent-vitals` 副本。
3. 对 OpenClaw 的 `web-design-engineer` 做拆分评估，并人工复核 `podcast-voice-video` 的安全命中行。
4. WorkBuddy 报告保持“18 个顶层缓存包 / 当前 Work 模式 12 个 Skill”的双层口径；不要把 builtin-plugin 内部资源或 connectors marketplace 候选算成顶层安装。若准备使用 Hermes，请先安装至少一个 skill 后复扫。
5. 在 2–3 周后对 Claude Code 复扫，并使用本次 JSON 作为基线比较触发增量和新增风险。

## Rust 重构分支影响

已拉取 `origin/refactor/rust-port`（`f406da5`）。该分支当前尚无 `Cargo.toml` 或 Rust 源码，主要新增架构文档、fixtures、golden 与 characterization/invariant/property 测试，是 Rust 移植前的契约固化阶段。重构仍值得继续，但必须先完成契约刷新：加入 Codex app-server capability、WorkBuddy manifest capability、OpenClaw `instance_id` / `conflict_domain` / 三态 enabled-loaded-runtime_verified、按实例汇总，以及各来源的降级错误。然后补三组 fixtures 和 golden，再开始 Rust 等价实现；否则 Rust 会忠实复制旧版“Codex 不可获取、WorkBuddy 为 0、OpenClaw 跨实例冲突”的错误行为。当前工作区有未提交修改，因此未直接 checkout/merge 该分支。

本次已新增可直接并入重构分支的契约文档：[Harness Adapter Contract](../docs/HARNESS_ADAPTER_CONTRACT.md)、[Rust Port Plan](../docs/RUST_PORT_PLAN.md) 和 [Product Capability Matrix](../docs/PRODUCT_CAPABILITY_MATRIX.md)。
