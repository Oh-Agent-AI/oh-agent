# Agent 行为审计与安全治理 — 需求分析与设计（agent-vitals × DSH）

> 状态：草案（待评审）
> 归属：agent-vitals 文档库（本仓库是主项目）
> 前置阅读：[DSH_INTEGRATION.md](./DSH_INTEGRATION.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [HARNESS_ADAPTER_CONTRACT.md](./HARNESS_ADAPTER_CONTRACT.md) · [PRODUCT.md](./PRODUCT.md §8)
> 本文件取代此前误放入 `deepseek-harness` 仓库 `docs/design/agent-behavior-audit.md` 的版本。那份把功能设计成「在 DSH 内部新增客户端包、改 `bundle/web-app`」，方向错误；正确形态是 **agent-vitals 作为审计/治理工具，以插件（bundle + harness adapter）接入 DSH，不改 deepseek-harness 核心**。

---

## 1. 定位与范围修正

两句话把关系钉死：

1. **agent-vitals 是主工具**——「审计并优化 Agent 的 Skill 行为」的专业工具；DSH 是它接入的**第六个执行环境**。
2. **DSH 接入是插件形态，不是改 DSH 代码**。DSH_INTEGRATION.md 早已把这件事拆成互不依赖的两件：
   - **DSH-1 分发**：`dsh-agent-vitals` bundle（profile layer，约 20 行 JS，注册 `ctx.skills` provider，扫描仍调 PATH 上的 `agent-vitals` 二进制）。
   - **DSH-2 能力**：`dsh` harness adapter，读 DSH 会话日志 + 注册表快照，让 DSH 自己被体检。

本功能属于 **Phase 3 / Phase 4**（PRODUCT §8.2）：对象从「Skill」扩展到「Agent 行为」，首发执行环境是 dsh——因为 DSH 是第一个**无需执行环境在跑、就能离线读到权威执行历史**的执行环境。

## 2. 背景与目标

agent-vitals 现在的安全能力（SV501–SV508）扫的是 **SKILL.md 的静态内容**：一条 skill 指令里写了 `curl | sh`、`base64 -d`、明文密钥，扫得出来。但用户真正会问的另一个问题是：

> **「这个 Agent 刚才到底做了什么危险的事？」**

这不是「skill 内容里有什么」，而是「执行轨迹里发生了什么」——Agent 有没有真的跑过 `rm -rf`、有没有真的读过 `~/.ssh/id_rsa`、有没有把数据发到内网地址、哪一次操作被沙箱拒绝或被审批拦下。

DSH 把 Agent 的每一步执行都落进了会话日志（append-only 的 `SessionEvent` 流），这正是回答这个问题的**权威证据源**。本功能把 agent-vitals 的安全审计从「skill 内容」扩展到「agent 行为」：

1. **行为检测**：对 DSH 会话日志里的执行事件（工具调用/命令/文件访问/网络/审批/沙箱）做规则化高危行为检测，产出带严重度分级的发现（Behavior Finding）。
2. **安全监控**：复用 agent-vitals 的 `snapshot`/`diff` 基线机制，跟踪行为随时间的变化。
3. **研判标记**：对每条发现做三态处置（确认安全 / 忽略 / 标记高危，附备注），留下可追溯的治理记录。

## 3. 现状盘点

### 3.1 agent-vitals 已有（直接复用）

| 能力 | 说明 | 复用方式 |
|---|---|---|
| Skill Execution Funnel（ARCHITECTURE §1） | Installed→Enabled→Loaded→Discoverable→Selected→Triggered | 行为审计在 Triggered 之后追加「Followed→行为」维度 |
| Diagnostic Engine（ARCHITECTURE §5） | SV 码 + severity + evidence + impact + recommendation + caveats | 行为发现复用同一诊断对象形态 |
| 安全规则 SV501–SV508 | PIPE_TO_SHELL / BASE64_EXEC / RAW_IP_FETCH / HARDCODED_SECRET / CREDENTIAL_READ / OBFUSCATED_EXEC / PASSWORD_PROTECTED_ARCHIVE / PROMPT_INJECTION_PATTERN | 分类学直接平移到运行时信号 |
| Harness Adapter 四阶段（ARCHITECTURE §4） | roots → probe → reconcile → facts | `dsh` 适配器补齐后，行为证据挂在 `dsh_runtime` 事实下 |
| `evidence_recency`（HARNESS_ADAPTER_CONTRACT） | probe / log / none | 行为证据天然是 `log`（带 session_id + seq + ts） |
| 隐私/脱敏（ARCHITECTURE §8） | Local First，NO upload；`--redact --redact-names` | 行为发现含命令/路径/凭据片段，脱敏是硬要求 |
| `snapshot`/`diff` 基线 | 两次扫描的差异 | 「安全监控」的时间维度 |

### 3.2 DSH 已有（作为证据源，不改它）

| DSH 能力 | 对行为审计的价值 |
|---|---|
| 会话日志（append-only `SessionEvent`，`session-persistence-jsonl`，默认 JSONL） | **主证据源**：离线可查，Agent 退出了答案还在库 |
| `tool/call`（`{turn, step, callId, name, arguments}`，arguments 为原始 JSON 字符串） | 检测「Agent 调了什么工具、带了什么参数」 |
| `tool/result`（`{message, error?: {name, code}, meta?}`） | 检测「被拒/超时/失败」，`error.code` ∈ {`FS_SANDBOX_DENIED`, `TOOL_TIMEOUT`, `ABORTED`, `ABORTED_BEFORE_DISPATCH`, `UNKNOWN_TOOL`, `SANDBOX_UNAVAILABLE`} |
| `approval/asked` + `approval/decided`（log-only 审计对） | 检测「哪次操作需要审批、结果是什么」 |
| `sandbox/mode`、`permission/preset`、`hook/invoked` + `hook/result` | 检测「沙箱模式切换、权限预设、hook 拦截决策」 |
| `tool/code-dispatch-start` + `tool/code-dispatch` | `run_code`（Code-Mode）桥接出的嵌套子调用，危险命令可能藏在这里 |

关键事实（来自 DSH 源码调研）：**审批/权限信息不挂在 `tool/call` 上**，而是独立 log-only 事件，需按 `callId` 关联；**拒绝/超时体现在 `tool/result.error.code`**。

### 3.3 缺口

- agent-vitals 的 `dsh` harness adapter 是 **specified, not implemented**（HARNESS_ADAPTER_CONTRACT「DSH」一节、DSH_INTEGRATION §5）。
- agent-vitals 的安全扫描只扫 SKILL.md **内容**，**没有**「扫执行轨迹」的能力。
- **没有**「行为发现」的数据对象、规则表、三态治理记录。

本功能就是补这三个缺口。

## 4. 需求分析

### 4.1 角色与场景

| 角色 | 场景 |
|---|---|
| 普通用户 | 跑完一个 dsh Agent 任务后，想确认它有没有做过危险操作 |
| 安全/合规 | 复盘某个会话，筛查高危行为，留下研判结论 |
| 开发者 | 定位「Agent 为什么执行了那条危险命令 / 为什么被沙箱拒绝」 |

### 4.2 功能需求

- **FR-1 行为检测**：对 DSH 会话日志里的执行事件运行规则引擎，匹配高危行为，产出 Behavior Finding。
- **FR-2 严重度分级**：沿用 agent-vitals 的 `critical / warning / info`（ARCHITECTURE §5.3），**不引入第二套严重度**。
- **FR-3 分类**：Shell 危险命令、敏感文件访问、网络外联、凭据/密钥、数据外传、审批/沙箱事件。
- **FR-4 证据呈现**：每条 Finding 展示工具名、命中规则（SV 码）、证据片段（命令/路径/URL）、turn/step/seq/时间、`evidence_recency=log` 的时间坐标。
- **FR-5 监控摘要**：按严重度/类别/工具聚合计数 + `snapshot`/`diff` 时间基线。
- **FR-6 研判标记**：三态（确认安全 / 忽略 / 标记高危）+ 可选备注，本地持久化、可脱敏。
- **FR-7 离线可查**：无需 DSH 在跑，逐行读 JSONL 会话日志即可出报告。

### 4.3 非功能需求

- **NFR-1 不改 DSH 核心**：所有 DSH 侧产物都是 bundle（DSH-1）+ adapter（DSH-2），DSH 仓库零改动。
- **NFR-2 确定性**：规则引擎是纯函数，同一事件流重放得到相同 Finding。
- **NFR-3 证据诚实**：拿不到的行为证据报 `unavailable`/`null`，**绝不报 0 次**（会变成假结论）。
- **NFR-4 脱敏**：命令/路径/凭据片段进 `--redact` 管线，所有统计脱敏后一致。
- **NFR-5 可扩展**：规则表驱动，新增规则不改核心。
- **NFR-6 双实现对齐**：Python + Rust 永久并行，行为审计规则进差分护栏（ENGINEERING §6.8）。

### 4.4 边界（不做什么）

- 不改 DSH 的 agent-loop、不往 DSH 会话日志里写东西（v1 纯读）。
- 不做自动阻断/拦截（只检测与展示）。
- 不做跨会话的云端聚合/告警推送（隐私模型：Local First）。
- 不把「行为审计」伪装成 Phase 1 的「静默预算溢出」卖点（DSH 无全局预算，PRODUCT §8.2）。

## 5. 总体设计

### 5.1 形态：插件接入，不改 DSH 核心

落地在 agent-vitals 仓库内，两个既有形态各司其职：

```text
agent-vitals/
├── SKILL.md                  # 前五个执行环境，不动
├── scripts/  src/            # 扫描器 + 诊断引擎，行为审计作为新能力并入
└── dsh/                      # 第六个执行环境（DSH-1 bundle，新增）
    ├── package.json          # name: dsh-agent-vitals；dsh.bundle.patch → cordis.patch.yml
    ├── cordis.patch.yml      # 一行 insert：注册 ctx.skills provider
    └── index.js              # ~20 行，resourceBase → ../，调 PATH 上的二进制
```

- **DSH-1 bundle** 只是「把 agent-vitals 装进 DSH」的分发层，不带扫描器副本、不做构建（ENGINEERING §6.6.1 三条硬约束）。
- **DSH-2 adapter** 是「让 DSH 自己被体检」的取证层：读会话日志（JSONL）+ 注册表快照（`--runtime-json`），把行为证据喂给诊断引擎。
- **行为审计规则** 住在 agent-vitals 的扫描器/诊断引擎里（`security.rs` / `adapters/dsh.py` 方向），**不在 DSH 里**。

### 5.2 证据源：会话日志是主路径

DSH_INTEGRATION §2.1 已经定论：会话日志是主路径，注册表快照是补充。

| 证据源 | 回答 | `evidence_recency` | 需要 DSH 在跑 |
|---|---|---|---|
| 会话日志 | 当时那一轮 Agent 实际调了什么、被拒/超时/审批了什么 | `log`（带坐标） | **否** |
| 注册表快照 | 此刻这个 scope 拥有什么能力 | `probe` | 是 |

行为审计的证据**几乎全部来自会话日志**：`tool/call`、`tool/result`、`approval/*`、`sandbox/mode`、`hook/*`、`tool/code-dispatch*` 都是会话事件流里的持久记录。这条路径纯读、离线可查，正是「Agent 退出了答案还在库」的价值。

### 5.3 新数据对象：Behavior Finding（区别于 Skill Vital Record）

Skill Vital Record 的对象是 **skill**（一台机器上的一个能力条目）。行为审计的对象是**一次高危行为**，需要一个新的、并列的对象：

```json
{
  "schema_version": "1.0",

  "id": "dsh:behavior:<session_id>:<seq>:<rule_id>",
  "harness": "dsh",
  "observer": "<agent/preset scope>",

  "finding": {
    "rule": "SV6xx",
    "severity": "critical",
    "category": "shell",
    "tool_name": "bash",
    "evidence": "rm -rf /tmp/build",
    "turn": 12,
    "step": 3,
    "seq": 8421,
    "time": "2026-08-14T09:12:03Z",
    "evidence_recency": "log",
    "observed_at": { "session_id": "…", "seq": 8421, "ts": "2026-08-14T09:12:03Z" }
  },

  "disposition": {
    "state": "open",
    "note": null,
    "decided_at": null
  }
}
```

沿用 ARCHITECTURE §2.1 三条数据约束：**`Unknown ≠ Zero`**（证据缺失报 `null`）、**估算自标注**（无估算字段则无）、**`reason` 一等公民**（每个降级/缺失带 reason）。

### 5.4 数据流

```text
DSH 会话日志（JSONL，离线可读）
        │  逐行解析 SessionEvent
        ▼
dsh adapter（DSH-2）
        │  提取执行事件流 → 喂给规则引擎
        ▼
行为规则引擎（agent-vitals，纯函数）
        │  match(tool/call, tool/result, approval/*, sandbox/mode, hook/*, code-dispatch*)
        ▼
Behavior Finding[] ──► 诊断引擎（SV 码 + severity + caveats）
        │
        ├─► doctor / report / --json / --markdown
        └─► 治理层：三态标记 + snapshot/diff 基线（本地、可脱敏）
```

## 6. 规则引擎：从「skill 内容」到「agent 行为」

### 6.1 复用 SV501–SV508 的分类学

静态安全规则与运行时行为规则是**同一套分类学、两个证据源**，不是两套安全观：

| 静态规则（扫 SKILL.md） | 运行时对应（扫会话日志） |
|---|---|
| SV502 PIPE_TO_SHELL | `bash` 参数含 `… \| sh` / `… \| bash` |
| SV503 BASE64_EXEC | `bash` 参数含 `base64 -d` + 执行 |
| SV504 RAW_IP_FETCH | `web_fetch` URL 为裸 IP / 内网地址 |
| SV505 HARDCODED_SECRET | 工具参数含 `sk-…`、`AKIA…`、`BEGIN PRIVATE KEY` |
| SV506 CREDENTIAL_READ | `read`/`bash` 访问 `~/.ssh`、`.env`、`~/.aws/credentials` |
| SV507 OBFUSCATED_EXEC | `bash` 参数含 `eval`、`xxd -r`、混淆解码执行 |

**约束**（沿用 ARCHITECTURE §5.2）：安全规则与诊断码**必须一一对应**，加一条规则就加一个码；`cited`/上下文启发式**只排序、永不裁决**。

### 6.2 新增运行时信号（静态扫描拿不到、只有执行轨迹里有的）

| 规则（新码） | 类别 | 严重度 | 证据 |
|---|---|---|---|
| 破坏性命令 | shell | critical | `rm -rf`、`dd … of=/dev/…`、`mkfs` |
| 提权操作 | shell | warning | `sudo`、`su`、`chmod 777`、`chown -R` |
| 远程执行 | shell | critical | `curl … \| sh`、`bash <(curl …)` |
| 敏感文件写 | sensitive-fs | critical | `write`/`edit` 指向 `~/.ssh/authorized_keys`、`/etc/`、`~/.bashrc` |
| 工作区外写 | sensitive-fs | warning | `write`/`edit` 绝对路径在 workspace 根之外 |
| 内网外联 | network | warning | `web_fetch` 内网/裸 IP |
| 被沙箱拒绝 | approval | warning | `tool/result.error.code = FS_SANDBOX_DENIED` 等 |
| 工具超时 | approval | info | `tool/result.error.code = TOOL_TIMEOUT` |
| 审批请求 | approval | info | `approval/asked`（按 `callId` 关联） |
| 提权授权 | approval | warning | `sandbox/mode = danger-full-access` / `approval/decided = allowed-once` |
| 重复工具调用 | trajectory | warning | 连续 ≥3 次相同 (tool, arguments) 签名（对齐 harness `repeat-tool-reminder` 的连续语义） |
| 死循环 | trajectory | warning | 连续 ≥2 个动作序列相同的 turn |
| 进度停滞 | trajectory | warning | 连续 `turn/end`=error / 连续 `tool/result` 带 error.code |
| 权限异常 | approval | warning | 同一调用反复审批 / 连续拒绝 / 危险模式反复授予 |

> 后四类是**轨迹级检测器**（SV611–614，`trajectory.rs` ↔ `trajectory.py`）：与前十类
> 「单事件静态匹配」不同，它们看跨事件窗口、计数、连续段。阈值常量在 core 单一真相源，
> 选值避开 `fixtures/dsh/behavior.jsonl` 的既有命中，让「全部规则都命中」的 fixture 干净。

> 嵌套：`run_code`（Code-Mode）会把工具桥接成 `tool/code-dispatch*` 子调用，危险命令可能藏在里面，规则引擎必须一并匹配。

### 6.3 严重度对齐

沿用 agent-vitals 三级（ARCHITECTURE §5.3），**不新造五级**：

```text
critical   已经造成损害或高危动作已发生（rm -rf、远程执行、敏感文件写、凭据外泄）
warning    会造成损害或值得关注（提权、工作区外写、内网外联、被拒/审批）
info       仅供参考（超时、能力不可用、审批请求）
```

### 6.4 确定性 / 可扩展 / 可测试

- 规则是纯函数 `(event) => finding[]`，同一事件流重放结果一致（特征化测试钉死精确值）。
- 规则表驱动，新增规则 = 加 `{ rule, severity, category, match }` + 对应 SV 码。
- 会话库 fixture 手写（complete / incomplete 两版），CI 不依赖真跑 DSH（DSH_INTEGRATION §3.2 C3）。

### 6.5 规则引擎的具体设计（v3 起步）

**第一步：证据读取器扩展。** Wave3a 的 `read_session_log` 目前只抽三类 skill 证据
（目录/调用/选中）。行为审计要的是**执行事件**——同一份 JSONL、不改读取器框架，
只加提取分支：

- `tool/call`（`arguments` 是 JSON 串，须容错解析）
- `tool/result`（`error.code`：被拒/超时/中止，按 `callId` 关联 `tool/call`）
- `approval/asked` + `approval/decided`（log-only 审计对）
- `sandbox/mode`、`hook/invoked`+`hook/result`、`tool/code-dispatch*`（`run_code` 嵌套）

**第二步：规则表 + 匹配函数。** 数据驱动，Python/Rust 双写、进差分护栏：

```text
rule = { rule_id, severity, category, match }
match(event) -> bool                 # 纯函数谓词：只判「是否命中」，不裁决
match_behavior(events) -> Finding[]  # 遍历事件，命中即产出一条 finding
```

`match` 只判命中、不裁决——与静态安全规则同一条纪律（启发式只排序、永不裁决）。

**第三步：SV6xx 码表（§6.2 的规则落码，SV501–SV508 之后顺延）**：

| 码 | 规则 | 严重度 | 类别 | 命中信号 |
|---|---|---|---|---|
| SV601 | 破坏性命令 | critical | shell | `tool/call` bash 参数含 `rm -rf`/`dd … of=/dev/`/`mkfs` |
| SV602 | 提权操作 | warning | shell | 参数含 `sudo`/`su`/`chmod 777`/`chown -R` |
| SV603 | 远程执行 | critical | shell | `curl … \| sh` / `bash <(curl …)` |
| SV604 | 敏感文件写 | critical | sensitive-fs | `write`/`edit` 指向 `~/.ssh/authorized_keys`、`/etc/`、`~/.bashrc` |
| SV605 | 工作区外写 | warning | sensitive-fs | `write`/`edit` 绝对路径在 workspace 根之外 |
| SV606 | 内网外联 | warning | network | `web_fetch` 内网/裸 IP |
| SV607 | 被沙箱拒绝 | warning | approval | `tool/result.error.code = FS_SANDBOX_DENIED` 等 |
| SV608 | 工具超时 | info | approval | `tool/result.error.code = TOOL_TIMEOUT` |
| SV609 | 审批请求 | info | approval | `approval/asked`（按 callId 关联） |
| SV610 | 提权授权 | warning | approval | `sandbox/mode = danger-full-access` / `approval/decided = allowed-once` |
| SV611 | 重复工具调用 | warning | trajectory | 连续 ≥3 次相同 (tool, arguments) 签名 |
| SV612 | 死循环 | warning | trajectory | 连续 ≥2 个动作序列相同的 turn（turn 签名 = 该 turn 内工具调用序列） |
| SV613 | 进度停滞 | warning | trajectory | 连续 `turn/end.reason.kind=error` ≥2 / 连续带 `error.code` 的 `tool/result` ≥3 |
| SV614 | 权限异常 | warning | approval | 同一 callId ≥3 次 `approval/asked` / 连续 ≥3 次 `rejected` / `danger-full-access` ≥2 次 |

**第四步：一条规则作范式（SV603）**：

```text
match(event) = event.type == "tool/call"
             ∧ event.data.name == "bash"
             ∧ 正则命中 arguments 里的 "curl … | sh" / "bash <(curl …)"
→ finding = { rule: "SV603", severity: "critical", category: "shell",
             tool_name: "bash", evidence: "<截断命令片段>",
             seq, time, evidence_recency: "log" }
```

**第五步：测试计划**（对齐 §3.2 C-list 的 C4/C5 思路）：

- fixture：手写执行事件流，每 category 一条「危险」+ 一条「安全对照」（避免规则恒真）。
- characterization：每条规则「给定事件 → 精确 finding 或空」钉死。
- 属性：`match` 纯函数、重放一致；`match_behavior` 对任意事件流不 panic。

## 7. 安全治理：标记与监控

### 7.1 三态标记

| 状态 | 含义 |
|---|---|
| open（默认） | 尚未研判 |
| confirmed-safe | 研判为误报 / 可接受 |
| dismissed | 已阅、不再关注 |
| flagged | 人工升级为高危 |

- 备注为可选自由文本。
- 持久化：本地快照（沿用 `snapshot` 机制），按 session/observer 分 key；脱敏后可与报告一起分发。
- 标记**只影响展示/排序/过滤**，不改变规则引擎判定（与「启发式只排序不裁决」同一条纪律）。

### 7.2 监控 = 行为基线

「安全监控」复用 agent-vitals 已有的 `snapshot`/`diff`：每次扫描落基线，下次对比出「新增/消失/严重度变化」的行为发现。时间坐标由 `evidence_recency=log` 的 `observed_at` 承载——一条行为发现**必须**带它发生在哪个 session、哪个 seq、什么时刻，否则报告就在时间上撒谎。

## 8. 接入点（对应 DSH-1 / DSH-2，不改 DSH 代码）

| # | 产物 | 位置 | 说明 |
|---|---|---|---|
| 1 | `dsh/` bundle | agent-vitals 仓库根 | `package.json` 声明 `dsh.bundle.patch`，`index.js` 注册 `ctx.skills` provider |
| 2 | `--harness dsh` | `cli.py` / `src/harness.rs` 两处 + `--runtime-json` 摄入 | DSH-2 adapter，读会话库 + 快照 |
| 3 | 行为规则引擎 | `security` 模块 + `adapters/dsh.py` | 新能力，纯函数 |
| 4 | 三态治理记录 | `snapshot` / 本地 store | 复用现有基线机制 |

DSH 仓库本身**零改动**。bundle 只发 npm 预构建、不带扫描器副本、不做构建（ENGINEERING §6.6.1）。

## 9. 分期与里程碑

对齐 PRODUCT §8.2 的 Phase 3/4：

- **v1（能力打通）**：`--harness dsh` 的静态扫描 + funnel 观察者维度落地（DSH_INTEGRATION §3.1 A1–A12）——先让 DSH 的 skill 被正确体检。
- **v2（DSH-2 adapter）**：会话日志取证（`historical` reconcile）+ `trigger` 区分「用户显式调用 vs 模型自主选中」——这是行为审计的证据地基。
- **v3（行为审计，本功能）**：行为规则引擎 + Behavior Finding + 三态标记 + snapshot/diff 监控。
- **v4（治理，Phase 4 方向）**：Capability Registry / Approved Skills / Policy 的治理层。

## 10. 风险与开放问题

1. **UI/面板落点（已定：方向 B）**。在 DSH Web GUI 会话视图加一个「审计」tab，与「对话」「轨迹」并列，呈现行为审计 findings。具体设计见 §10.1；CLI 的 `doctor/report/--json/--markdown` 仍是数据主路径，GUI 是展示层。
2. **SESSION_FORMAT_VERSION=0 不作兼容承诺**：schema 不符时行为证据一律降级 `unavailable`，绝不报 0 次（会变假发现）。
3. **误报率**：正则对自然语言命令有误报；以「排序/提示」定位，不阻断。
4. **`arguments` 是原始 JSON 字符串**：需容错解析，非 JSON 时降级为字符串匹配。
5. **工作区外路径判定**：需要 session cwd / workspace 根，v1 先做「绝对路径 + 敏感前缀」启发式。
6. **双实现永久并行**：行为规则 Python + Rust 写两遍，进差分护栏，是永久成本（DSH_INTEGRATION §5）。
7. **数据外传等组合规则**：跨事件的「读敏感文件 → 外发」关联 v1 仅提示级，完整关联留 v4。

### 10.1 「审计」tab：客户端插件设计（方向 B）

**形态**：一个**客户端插件 bundle**（浏览器侧），与 DSH-1 的 harness bundle **分开**。参考
`ui-trajectory`（DSH 里「轨迹」tab 的实现，`packages/client/ui-trajectory`）：

- 包声明 `dsh.client`、导出 `/client` 浏览器入口，tsdown 打成浏览器 bundle。
- 在 `conversation.view` 的 slot ring 里注册一个「审计」tab——`ui-trajectory` 正是这样
  在「对话」旁注册「轨迹」tab 的。
- UI 只通过 `ctx.slots.register({ name, children, store, inject }, Component)` 组合，
  不碰 DSH 的 agent-loop、不改 DSH 核心。

**数据流（关键架构决策）**：行为审计 findings 由**执行环境侧**产出（harness bundle 读会话日志 →
规则引擎 → findings），再以 **log-only session 事件**落库 + 广播，客户端插件像
`ui-trajectory` 一样从 `session/event` 流渲染——与「轨迹」共用同一条数据通路，不另建 API：

```text
harness bundle（DSH-1 + 审计）
  │  读会话日志 → 规则引擎 → findings
  │  findings 写成 log-only session 事件（如 type: "agent-vitals/finding"）
  ▼
session/event 流 ──► 客户端「审计」tab 渲染
                       （严重度排序 + 三态标记 + 跳转 seq）
```

**tab 内容（v1）**：

- findings 列表：`rule` / `severity` / `category` / `evidence`（截断）/ `seq` / `time`。
- 按严重度排序（critical > warning > info）；三态标记（open / confirmed-safe / dismissed / flagged）。
- 点击 finding 跳到对应 `seq`（复用「轨迹」的时间线锚点）。

**依赖链（何时能在 GUI 看到）**：

1. 行为审计端到端：规则引擎 ✅ → 证据读取器扩展 → findings 产出。
2. harness bundle 扩展：findings → log-only session 事件。
3. 客户端插件 bundle：「审计」tab。
4. DSH web 构建 + `dsh plugin add` + 重启。

**独立工作项提醒**：客户端插件是**浏览器端 TS/React 开发**，与现有的 Python / Rust /
harness-bundle JS 是不同技术栈，且要遵守 DSH 的 client 纪律（slot 体系、`dsh.client` 清单、
`/client` 导出、100% 覆盖门槛，见 `packages/client/AGENTS.md`）。这块需单独排期，
与扫描器/规则引擎的 Python+Rust 双实现是并行的两条线。

## 11. 附录：文件索引

- agent-vitals 架构：[docs/ARCHITECTURE.md](./ARCHITECTURE.md)、[docs/HARNESS_ADAPTER_CONTRACT.md](./HARNESS_ADAPTER_CONTRACT.md)
- DSH 接入：[docs/DSH_INTEGRATION.md](./DSH_INTEGRATION.md)、[docs/PRODUCT.md](./PRODUCT.md)、[docs/ENGINEERING.md](./ENGINEERING.md)
- 扫描器/诊断：`scripts/scan.py`、`scripts/agent_vitals/`、`src/security.rs`、`src/discovery.rs`、`src/analysis.rs`、`src/dsh.rs`（拟）
- DSH 会话日志/事件：`packages/core/session/src/types.ts`、`packages/session/session-persistence-jsonl/`、`packages/interaction/user-approval/`、`packages/sandbox/sandbox-policy/`
