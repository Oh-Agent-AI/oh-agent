# 审计 tab 优化设计（dsh-client UX）

> 状态：设计稿（2026-08-19）。基于第一次真实会话跑通后贴出的数据，逐条分析、按优先级排期。
> 关联：[AGENT_BEHAVIOR_AUDIT.md](./AGENT_BEHAVIOR_AUDIT.md)（行为审计需求/规则引擎）、[DSH_INTEGRATION.md](./DSH_INTEGRATION.md)（DSH 接入）。

## 0. 背景：这条链已经通了

执行环境（Node）把原始 session 事件喂给 Rust 行为规则（wasm），算出 SV601–SV614 findings（单事件规则 + 轨迹级检测器），经
`behaviorFindings` projection 推给浏览器，`dsh-client` 的「审计」tab 用 `useProjection` 渲染。

第一份真实数据已经能看出两个真问题（一个误报、一个真命中），说明**链路正确、规则引擎有效**；
剩下的是「把噪声压下去、把信号提上来」。

---

## 1. 数据揭示了什么

样本（节选，session cwd = `/Users/Admin/projects/project/agent-vitals`）：

```
Token 用量：input 226423948 · output 680368 · cache-read 49296256 · cache-write 0
⚠ SV605 ×14  write/edit — /Users/Admin/projects/project/agent-vitals/...   ← 全是工作区内
✕ SV601      bash — rm -rf                                       seq 56668
· SV609 / ⚠ SV610  escalate → allowed-once                       seq 68547/68548
```

五个结论：

1. **SV605 大面积误报（14/14）**：cwd 是工作区根，但那 14 条 `write`/`edit` 全落在
   `/Users/Admin/projects/project/agent-vitals/...` ——**都在工作区内**，却被标成「工作区外写」。
   这是 v1 已知局限（AGENT_BEHAVIOR_AUDIT §10.5：「v1 先做绝对路径启发式，无 workspace 根」），
   但现在是最大噪音：**14 条 finding 里 14 条是误报，用户会直接失去信任**。
2. **SV601 `rm -rf` 是真命中**（critical，正确）——agent 确实跑过危险命令。
3. **SV609/SV610 审批对正确**（escalate → allowed-once）。
4. **Token 数字裸奔**：`input 226423948`（2.26 亿）不可读，且这个量级本身就是重要信号
   （会话上下文极大、input 主导成本），值得单独凸显。
5. **排序/分组缺失**：findings 按 seq 时间序，唯一的 critical 被 14 条 warning 淹没。

---

## 2. 优化清单（F 功能 / S 样式）

### 功能

| # | 优化 | 做法 | 优先级 |
|---|---|---|---|
| **F1** | **SV605 工作区感知（修误报）** | 把 session 的 `cwd` 传进规则引擎，SV605 只对「绝对路径**且不在 cwd 下**」报警。需改 Python / Rust core / wasm 三处 | ✅ 已完成 |
| F2 | 点击 seq 跳转 | finding 的 seq 做成可点，跳到「轨迹」tab 对应事件 | ✅ 已降级实现（见下） |
| F3 | 三态标记 | 每条 finding 加 open / 确认安全 / 忽略 / 标记高危（复用 AGENT_BEHAVIOR_AUDIT §7 治理记录） | ✅ 已实现（localStorage，见下） |
| F4 | 同类合并 | 相同 rule + evidence 的重复项折叠成「×N」 | ✅ 已完成 |

### 样式

| # | 优化 | 做法 | 优先级 |
|---|---|---|---|
| **S1** | **Token 格式 + 凸显** | `226423948 → 226.4M`；加「input 占成本 99%+」一句话洞察 | 🔴 |
| **S2** | **严重度汇总头** | tab 顶部「✕ 1 critical · ⚠ 15 warning · · 2 info」 | 🔴 |
| S3 | 颜色编码 | critical 红 / warning 琥珀 / info 灰 | 🟡 |
| S4 | 排序 | critical 优先，同严重度按 seq 降序（最新在前） | 🟡 |
| S5 | 长路径截断 | 长路径截断 + hover/点击展开 | 🟢 |
| **S6** | **按模型分桶报价** | usage 事件按当时活跃的模型（`request/header`）分桶，每桶 × 该模型官方报价（flash/pro × 空闲/高峰）求和；各桶之和与 DSH `tokenUsage` 累计严格相等（已对账）。未知模型段标「未计价」不臆造 | 🟢 |

---

## 3. 分两批实施

### 第一批（纯客户端，不动规则引擎）

**S1 + S2 + S3 + S4 + S5**（后补 **S6 价格估算**），全部在 `dsh-client/client.js` 里改，加几个纯函数 helper
（`formatTokens`、`groupByRule`、`summarize`、`ruleLabel` 码→中文名映射），重构 `AuditView`。
风险低、半天能完，把 18 行噪声压成 4 个区块。

### 第二批（修真 bug，动规则引擎）

**F1（SV605 工作区感知）**——唯一需要动 Python / Rust / wasm 的，但它把 14 条误报归零，价值最高。
F2 / F3 / F4 随后。

**关键判断**：F1 是根，样式是叶。F1 不修，第一批做完「14 条里 14 条噪音」依然在，只是被折叠起来
显得干净——那不是干净，是掩盖。所以**先 F1 再第一批**是更稳的顺序，但 F1 要动三处 + 重编译 wasm，
周期比第一批长。两批可并行：F1 由规则引擎侧做，第一批由客户端侧做，互不阻塞。

---

## 4. F1 详细设计（SV605 工作区感知）

### 4.1 现状

`crates/agent-vitals-core/src/domain/behavior.rs` 的 `detect_sv605`：

```rust
fn detect_sv605(event: &Value) -> Option<String> {
    let (name, text) = tool_invocation(event)?;
    if name != "write" && name != "edit" { return None; }
    if sensitive_path_re().is_match(&text) { return None; }  // /etc/ 等由 SV604 管
    first_match(abs_path_re(), &text)                        // ← 只判「是绝对路径」
}
```

只判「是绝对路径」，不判「是否在工作区内」。

### 4.2 改法

给 `match_behavior` 增加 `workspace_root` 参数，SV605 的判定从「绝对路径」收紧为
「绝对路径 **且不在 workspace_root 前缀下**」。工作区根来自 session 的 `cwd`。

改动面（三处 + 接线）：

| 层 | 文件 | 改动 |
|---|---|---|
| Rust core | `crates/agent-vitals-core/src/domain/behavior.rs` | `match_behavior(events, workspace_root)`；`detect_sv605` 加前缀判定 |
| Rust wasm | `crates/agent-vitals-wasm/src/lib.rs` | `audit_events(events_json, workspace_root)` 透传 |
| Python | `scripts/agent_vitals/agent/behavior.py` | `match_behavior(events, workspace_root)` 双维护同步 |
| 二进制 CLI | `src/behavior.rs`（薄封装） | `audit_session_log` 从 session log 头取 cwd 传入 |
| 执行环境插件 | `dsh-client/index.js` | 从 session header 取 `cwd`，透传给 wasm `audit_events` |

### 4.3 工作区根从哪来（待实现时验证）

两个候选，实现时择一：

- **A. session 事件里带 cwd**：若 DSH 有 `session/start` 或 `workspace` 类事件携带 `cwd`，
  则在 projection 的 `apply` 里捕获进 `state.cwd`，`view` 时传给 wasm。
- **B. 执行环境插件直接从 session 对象读**：`ctx.on('session/event', (session) => session.header.cwd)`
  （token-meter 同款钩子），把 cwd 存进投影 state。

倾向 A（cwd 随事件流走，fold 保持纯函数），若 DSH 无此类事件则退 B。

### 4.4 边界语义（要写进测试）

- `workspace_root` 为空/未知时：SV605 **退化为当前行为**（只判绝对路径），绝不因拿不到
  cwd 而漏报——宁可多报不误放（与「harness 能力缺失时不伪造、缺列仍有价值」同一条纪律）。
- 前缀判定必须按**路径段**边界，不能裸 `startsWith`（`/proj` 不应匹配 `/projects`）。
- `/etc/`、`~/.ssh/authorized_keys` 等仍由 SV604 负责，SV605 不重复报（现有注释已约定）。

### 4.5 验证

- 用真实数据回归：那 14 条 `/Users/Admin/projects/project/agent-vitals/...` 的 write/edit
  应在 cwd 下、**不再报 SV605**；`rm -rf` 仍报 SV601。
- 加一条「工作区外绝对路径」用例，确认 SV605 仍能命中（`/Users/other/...` 或 `/tmp/...`）。
- wasm 重编译后，`audit_events` 与 Python `match_behavior` 在 workspace 参数下逐字节对齐。

---

## 5. 样式细则（第一批）

### S1 Token 格式

`226423948 → 226.4M`、`680368 → 680.4K`，字段名改中文：输入 / 输出 / 缓存读 / 缓存写。
加一句洞察：`input 占 99%+`（input / total 超阈值时显式标出「上下文主导成本」）。

### S2 汇总头

`✕ 1 critical · ⚠ 15 warning · · 2 info`，一行，颜色与 S3 一致。后续可点成过滤器（F3 之后）。

### S3 颜色编码

critical 红 / warning 琥珀 / info 灰。用 CSS 类或内联 style，与 DSH 主题 token 对齐。

### S4 排序

critical → warning → info；同级按 seq 降序（最新在前，用户最关心刚发生的）。

### S5 长路径截断

超过 N 字符（建议 40）截断为「前缀…后缀」，hover 显示全文（`title`），点击展开。

### S6 按模型分桶报价

token 行下方：

```
费用（估算）≈ ¥774.7（空闲）· ¥1549.3（高峰）· 中途切换模型（deepseek-v4-pro → deepseek-v4-flash）
  deepseek-v4-pro   ¥752.3 / ¥1504.6
  deepseek-v4-flash ¥22.4 / ¥44.7
```

- **为什么按模型分桶**：`request/header` 的 `config.model` 会在会话中途变化（真实日志出现过
  pro → flash → pro）。DSH 的 `tokenUsage` 投影只有全会话累计、没有模型维度——拿一个模型价算
  整段账会错 3 倍（flash 与 pro 输入价差 3 倍）。折叠的**单一真相源是 core 的
  `usage::token_by_model`**（`crates/agent-vitals-core/src/domain/usage.rs` ↔ `usage.py` ↔ wasm
  `token_by_model` ↔ dsh 适配器 `usage_events` 四方锁步）：CLI 的 `behavior` 命令与 tab 的
  `tokenByModel` 投影共用这一份引擎（tab 的 `view` 把 usage 事件喂 wasm），JS 折叠已删——
  never a second copy。折叠语义复刻 token-meter（同 turn/step 只计最后一份 sample，替换时
  从原归属模型减掉旧值），因此**各桶之和与 `tokenUsage` 严格相等**（真实日志对账：
  180577354/498735/712320/0 逐字节一致）。
- **单价表**（元 / 百万 tokens，用户提供的 DeepSeek 官方报价）单一真相源是
  `scripts/agent_vitals/pricing.json`（CLI 两侧读它；`dsh-client/client.js` 因浏览器限制
  内嵌 PRICING 副本，由 `tests/test_pricing_lockstep.py` 守）。**缓存写入报价表没有行 →
  按 0 计**（注释标注假设）。费用 = `uncached × 未命中价 + cacheRead × 命中价 + output ×
  输出价`（各自 /1e6）。CLI 的 `behavior` 人读模式在 findings 后打印成本块（`cost.rs` ↔
  `cost.py`，`both()` 差分守），`--json` 输出 `{findings, usage}`。
- **模型切换**：`sequence` 是相邻去重的激活序列（pro → flash → pro 保留两次 pro，不抹掉
  「切回」信息）；长度 > 1 时标注「中途切换模型」并列出逐模型明细。
- **未知模型**：无 `request/header`（老日志）的 usage 落进 `unknown` 桶，client 标
  「另有 N tokens 模型未知未计价」——不臆造单价。
- **估算性质**：分桶仍无法重建每笔请求的时刻（空闲价 = 高峰价一半，高峰为北京 9–12、
  14–18 点），所以每个价格同时给空闲/高峰两个值，由读者按实际时段取值——宁给两个数，
  不给一个假数。

---

## 6. 开放问题（已解决，2026-08-20）

1. **cwd 的准确来源**（§4.3 A/B）——走 A：`dsh-client/src/harness/index.ts` 监听
   `session/created`（首次 + 冷重放）和 `session/event`（活事件流）两个钩子，
   把 `session.header.cwd` 记进 `cwdBySession`，`behaviorFindings` 投影的
   `view()` 把它传给 wasm `audit_events(events_json, cwd)`。
2. **F2 seq 跳转的联动面**——核实过 `@deepseek-ai/dsh-client-ui-conversation`
   的 `ConvViewProps`（`slots.d.ts`）：`conversation.view` 契约只暴露
   `forkAt(seq)`（派生新会话）和只读 `scrollTop`，**没有 jump-to-seq 或跨
   tab 导航接口**。按预案降级为「复制 seq」——`AuditView.tsx` 的
   `copySeq()`，每行一个「复制」按钮，合并行（F4）复制该组全部 seq
   （逗号分隔）。等执行环境契约补上跳转能力后再升级。
3. **F3 三态标记的持久化**——先做纯前端方案：`localStorage`
   （`agent-vitals-audit:marks:v1`），键为 `JSON.stringify([rule, evidence])`
   ——与 F4 的合并键一致，标记一次即对整组「×N」生效。三态：
   `安全`（该行淡化，排到组内末尾）/ `高危`（组内置顶，glyph 变 ▲ 标红）/
   `忽略`（移出主分组，落进底部折叠的「已忽略 N 条」区）。未来若要接入
   AGENT_BEHAVIOR_AUDIT §7 的治理 registry（跨设备同步、审计留痕），
   把 `loadMarks`/`persistMarks` 换成走 registry 的读写即可，UI 层不用改。
