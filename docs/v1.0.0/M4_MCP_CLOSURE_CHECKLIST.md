# M4 收口清单 —— MCP workflow 洞察 6 项 PARTIAL

> 撰写：2026-09-13
> 依据：`docs/AGENT_VITALS_DATA_MCP_SMOKE_TEST_SPEC.md` §8/§9 + 本人复跑冒烟 + 代码核对
> 复跑基线（本机，`target/release/agent-vitals`）：
> 公开构建 **19 EXACT / 6 PARTIAL / 0 BLOCKED / 0 MISMATCH**；
> internal 构建（`--features agent-vitals-runtime/mcp-internal`）**21 / 6 / 0 / 0**。
> 两版 6 项 PARTIAL 完全相同。
> **本文只写「怎么收口」；不改变任何 PRD 勾选状态。**

---

## 0. 先厘清一件事：这 6 项是发布门槛，不是可选优化

spec §9 的 M5（v1.0.0）通过门槛原文：

> Q01–Q15 全部 `EXACT` 或 `EXPLAINED`；无未关闭 `mismatch`

而冒烟的判定词汇表里 **PARTIAL 与 EXPLAINED 是两个不同档位**（`tests/mcp_smoke.py:19-21`）：

```
EXACT（MCP 值与 CLI 逐值相等）· EXPLAINED（差异有书面原因）
MISMATCH（未解释差异，必须开 issue 或修）· PARTIAL（工具在但只覆盖一部分）· BLOCKED（目标工具未实现）
```

因此按 spec 自己的字面口径：**当前 6 项 PARTIAL 意味着 M5 的 MCP DoD 未达成。**
出路只有两条，需要显式选一条（见 §4）。

---

## 1. 根因：一条结构性闸门，卡住其中 4 项

`crates/agent-vitals-runtime/src/mcp/workflow_summary.rs:513`

```rust
let status = if observed == 0 { "unavailable" } else { "partial" };
```

**`coverage()` 根本没有 `complete` 分支。** 无论证据多完整，`issues_summary` /
`skills_summary` 的 `coverage.status` 只能是 `unavailable` 或 `partial`。

配套的第二处：`run_issues`（`:652`）把缺项**写死**为字面量——

```rust
let mut issue_missing = vec!["unique token/cost linkage".to_string()];
if /* 重试配对不全 */ { issue_missing.push("complete retry baseline".to_string()); }
```

也就是说：即使某一窗口的证据链已经完整、`missing` 本应为空，这两个工具**依然会报
`partial`**。Q06 / Q08 / Q10 的 coverage 面因此**在结构上无法毕业**，与真实数据质量无关。

> **M4-1（P0）** 给 `coverage()` 增加 `complete` 路径，判据为「本次请求范围内
> `missing` 为空且 `observed > 0`」；`missing` 的每一项都必须由**实际证据**算出
> （可复算的 SQL 条件），不得保留任何固定字面量。
> **验收**：构造一个证据完整的夹具窗口，断言 `coverage.status == "complete"`；
> 构造缺 token/cost 关联的窗口，断言回到 `partial` 且 `missing` 指明具体缺项。
> **不修这一条，下面 5 条即使全部做完，冒烟输出也不会从 PARTIAL 变 EXACT。**

---

## 2. 逐项清单

### M4-2 · Q06 重复错误指纹聚为问题卡（`issues_summary`）

| 项 | 内容 |
|---|---|
| 现状（实测） | `coverage=partial rows=44` —— 按脱敏错误指纹/重复调用聚合**已经能出组** |
| 缺什么 | spec §4.2 原文：「趋势与 token/cost 归因仍不完整」 |
| 代码位置 | `workflow_summary.rs:528 run_issues`、`:652 issue_missing` |
| 收口动作 | ① 组级时间趋势（明确窗口口径，如按北京日桶）；② 组与 `usage_facts` 的 token/cost 关联——**若无法唯一归因，必须显式标注不可归因，不得按比例分摊** |
| 验收 | 新窗口返回的趋势可复算；token/cost 关联要么有唯一键、要么字段显式为 null + reason |

### M4-3 · Q07 连续失败后成功 = 一组重试链（`issues_summary`）

| 项 | 内容 |
|---|---|
| 现状（实测） | `retry_evidence=partial chains=74` |
| 缺什么 | `complete retry baseline`（`run_issues:654` 条件性追加）；部分生命周期缺失导致配对不全 |
| 代码位置 | `:234 retry_chain_rows`、`:290 load_retry_events` |
| 收口动作 | 补「配对所需事件」的稳定供给（`skill_invoked` 45 vs `skill_finished` 39 的 6 条缺口即此类）；为 recovered / unrecovered 两种终态各建稳定 fixture |
| 验收 | 同一 fixture 连跑三次，`chains` 计数与配对结果逐值恒等；`retry_evidence` 在配对完整时给出非 partial 的确定值 |

### M4-4 · Q08 Skill 成功率 + 样本不足判定（`skills_summary`）

| 项 | 内容 |
|---|---|
| 现状（实测） | `coverage=partial rows=1` |
| 代码位置 | `:811 success_rate`（有值，`unknown>0` 时降 partial）<br>`:812 retry_rate` —— **恒 `unknown`**，reason 写死「skill invocation fingerprints are not yet paired with a retry lifecycle」<br>`:815 tokens` —— **恒 `null`**，reason「workflow-to-usage attribution is not unique」 |
| 缺什么 | 样本门槛 + token/cost 关联。`:812`/`:815` 两条 reason 就是待消除的缺口本身 |
| 收口动作 | 让 `retry_rate` 与 `tokens` 具备真实计算路径（依赖 M4-1 与 M4-6 的归因），或把它们正式改写为「本版不提供」并同步冒烟判定 |
| 验收 | `:812`/`:815` 的固定 reason 消失，或该字段按新契约被判定为 EXPLAINED 而不是 PARTIAL |

### M4-5 · Q09 Skill 版本回归识别（`skills_summary`）

| 项 | 内容 |
|---|---|
| 现状（实测） | `version_rows=1 comparable=0` |
| 代码位置 | `:160 skill_version_regression`，四道 `unavailable` 闸（对应 5 个 reason 码）：<br>①版本数 `<2` → `fewer_than_two_versions` / `fewer_than_two_known_versions`；②样本 `< MIN_VERSION_COMPARISON_CALLS`（`=3`，`:61`）→ `sample_below_minimum`；③`unknown>0` 或结束事件不全 → `incomplete_skill_lifecycle`；④耗时证据不全 → `incomplete_duration_evidence` |
| 缺什么 | **真机只有 1 个可比较版本** → 当前是**证据缺口，不是代码缺口** |
| 收口动作 | ① 确认四道闸的判据是否都必要（防止闸门过严导致永远 unavailable）；② 语料侧等待 ≥2 个版本各 ≥3 次调用且生命周期与耗时完整；③ 为此写一个**合成的**双版本 fixture，把比较器本身钉住 |
| 边界 | 这一条**可能无法靠改代码"做完"**——若真实语料长期只有一个版本，正确做法是走 §4 的第二条路（改判 EXPLAINED），而不是删闸 |

### M4-6 · Q10 会话时间线关联失败/峰值（`session_detail`）

| 项 | 内容 |
|---|---|
| 现状（实测） | `issues_summary 提供安全错误/会话聚合；usage timeline 与 workflow 关联仍为 PARTIAL` |
| 缺什么 | **workflow 事件与 token/cost 的唯一归因** —— 与 Q06、Q08 的 `tokens` 缺口**同一个根因** |
| 代码位置 | `:815` 的 reason 即此项的定义 |
| 收口动作 | spec 明令「**不与 usage/cost 做不可靠的一对一硬归因**」。所以正确解法是**证明关联的唯一性**（例如靠 `capability_id` + 会话内序号），而不是强行 join |
| 验收 | 要么给出唯一键并钉住守恒，要么把「不可唯一归因」写进契约并据此改判 EXPLAINED |

### M4-7 · Q14 同 raw 模型名跨执行环境（`usage_hourly`）

| 项 | 内容 |
|---|---|
| 现状（实测） | `identity_kind = {'harness_raw'}` 每序列在场，key 带 harness 消歧 ✅ |
| 缺什么 | spec §8 F8：「`provider_id` 归一表 §3.4 未建」；canonical 归一标注为 **v0.9.2+** |
| 收口动作 | 建 `provider_id` 归一表；让 `usage_hourly group_by=provider` 与 `group_by=model` 在归一后等价 |
| 边界 | spec 已把它挂到 **v0.9.2+**，不是 v1.0.0 —— 若维持该排期，此项应按 EXPLAINED 收口（引用 spec 的书面原因） |

---

## 3. 建议执行顺序

| 序 | 项 | 理由 |
|---|---|---|
| 1 | **M4-1** `coverage()` 的 `complete` 路径 | 其余 5 项的**共同闸门**；不修则做完也毕业不了 |
| 2 | **M4-6** workflow→token/cost 唯一归因 | Q06 / Q08(`tokens`) / Q10 三处的**共同根因**，一次修三处 |
| 3 | **M4-3** 重试链配对 + 稳定 fixture | 补事件供给，为 Q07 提供可复算基线 |
| 4 | **M4-2** Q06 趋势 | 依赖 2 |
| 5 | **M4-4** Q08 `retry_rate`/`tokens` | 依赖 1 与 2 |
| 6 | **M4-5 / M4-7** | 证据/排期受限，优先考虑改判 EXPLAINED |

---

## 4. 唯一的决策点（需要人定）

spec §9 只认 `EXACT` 或 `EXPLAINED`。当前 6 项是 `PARTIAL`。两条路：

| 路 | 做法 | 代价 |
|---|---|---|
| **A. 收口** | 按 §3 顺序逐项做到能判 `EXACT` | M4-5 / M4-7 受真实语料与 v0.9.2 排期约束，短期内不一定能做到 |
| **B. 改判** | 为每项给出**书面原因**并把冒烟判定从 `PARTIAL` 改为 `EXPLAINED` | 需要改 `tests/mcp_smoke.py` 的判据——**属于放宽判定，必须留下与 spec 同步的书面依据**，否则就是「改测试冒充通过」 |

**我的建议：1、2、3 走 A（它们是代码问题，可解）；5、7 走 B 并把原因写进 spec §8 的缺口表。**
理由：M4-5 缺的是语料、M4-7 排期在本就写着 v0.9.2+，把这两条做成硬门槛等于用一个已知不可控的输入卡住整条发布门。

**但**——按仓库纪律（「不得更新 snapshot 或删除断言来掩盖行为变化」），走 B 必须由你确认，我不擅自改判。

---

## 5. 本次未做（诚实边界）

- 未逐行验证 §2 中每项「收口动作」的可行性——那些是**建议方向**，落地时仍需按产生方代码复核；
- 未评估 M4 的**工作量**（未估时）；
- 未触碰 `issues_summary` / `skills_summary` 之外的 MCP 面（其余 21 项本次复跑均 EXACT）；
- 未验证 internal 构建与公开构建在**未来版本**是否继续保持 6 项一致。
