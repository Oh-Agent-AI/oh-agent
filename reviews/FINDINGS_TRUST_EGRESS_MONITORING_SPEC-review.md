# Design Review: Findings Trust / Egress Monitoring（FINDINGS_TRUST_EGRESS_MONITORING_SPEC.md）

**Spec 文件**: `docs/v1.0.0/FINDINGS_TRUST_EGRESS_MONITORING_SPEC.md`（Draft v1，2026-09-19）
**评审对象**: 规格文本 + `~/.codex/worktrees/finding-trust-v18/skill-vitals` 未提交实现
（`crates/agent-vitals-data/src/{trust,trust_correlator}.rs`、`crates/agent-vitals-domain/src/domain/trust.rs`、
`crates/agent-vitals-runtime/src/{trust_audit,trust_runtime_monitor}.rs`、authority v18 迁移、
CLI `trust` 子命令、桌面 `trust_audit/trust_discover/trust_runtime_snapshot` IPC）
**评审方式**: 只读检查（未在对方工作区执行任何 cargo 命令；结论基于源码阅读与规格逐条对照）
**评审日期**: 2026-09-20

---

## 总评

规格的威胁模型意识是这套设计最强的部分：证据分级（E0–E5）、"读取/打包/尝试/已发送/远端接受"分阶段表达、
"未取得服务端证据不得声称数据被训练/转卖"、severity 与 confidence 分离、默认不阻断——这些边界声明成熟且自洽。
写入端契约校验（路径/URL 入库前拒绝）是 enforce 而非 test-only，metadata 白名单防身份泄漏有测试钉住，
`delete_imported_harness_data` 的 trust 级联有实现有测试。这些是合格甚至优秀的部分。

但存在一个**阻断级设计-实现落差**（V-1：关联器没有实现关联）、一个**高误报成本直达系统弹窗的判定错误**
（V-4），以及若干威胁模型自身的绕过面与流程风险。按严重度列于下。

**Rating**: 6/10（规格文档 8/10，当前实现 5/10；P1 不可按现状发布）

---

## V-1（Critical，发布阻断）：关联器没有实现"关联"——逐行判定取代多信号链

**位置**: `trust_correlator.rs::candidates()` / `correlate_selected()`
**规格承诺**: §6.3 关联键 `(harness, actor_id, workspace_ref, time_window)`，判定为多信号链
（大范围读取/打包 → 取凭证 → 连对象存储 → consent 偏差合成**一个** Finding）；§12.6 验收要求
ZCode fixture 形成"完整或缺环时间线"。

**实现现状**:
- `candidates()` 对**每条 observation 独立**产出 Finding：`package_observed`+`git_history` → SV702；
  `consent=disabled`+E2 → SV705；`object_storage`+E3 → SV709。没有任何跨行聚合、没有时间窗概念；
- `observation_count` 恒为 1，`first_observed_at_ms == last_observed_at_ms`，字段形同虚设；
- §7.2 "同 actor 后台重试跨 30 分钟" 的报警判定没有输入可用。

**后果**:
1. 一次完整外传被拆成 SV702 + SV705 + SV709 三条散警报，用户无法看到"这是一次仓库外传事件"——
   而合成时间线正是本规格相对 SV6xx 的核心增值；
2. 单信号误报面放大：SV709 只看单行"E3 + destination_class=object_storage"即 warning、E4+ 即 critical，
   无"先有打包/凭证前置信号"的链式要求。用户自己的合法对象存储备份若被归为 sidecar actor，
   直接产 critical；
3. 阶段升级（package → credential → attempted → transmitted → accepted）无处发生，
   §7.2 "阶段首次升级到 E4/E5 才弹通知" 的门槛机制失去载体。

**修复方向**:
- 判定输入从单行改为**按 `(harness, actor_id, workspace_ref, 时间窗)` 聚合的观测集**；
  窗口建议滚动 30–60 分钟或按事件间隙切分（规格可拍板）；
- 规则改写为对窗口内**阶段序列**的判定：链完整（package+credential+egress）→ 一个 Finding、
  critical、confidence high；链有缺环 → 同一 Finding 按已达最远阶段定级，缺环事实进
  "缺失事实"字段（§6.3 本来就要求输出）；
- `observation_count` / `first/last_observed_at_ms` 从窗口聚合填真值；
- 验收：ZCode fixture 的多 observation 必须产出**恰好一个** SV709（或按阶段降级的单条），
  而不是三条独立 Finding。

---

## V-2（High）：SV705 证据强度提前——E2 即 critical 且直达系统通知

**位置**: `candidates()` SV705 分支；与 §7.1 示例表、§7.2 通知门槛的对照
**规格基准**: §7.1 的示例是"关闭开关后仍取凭证**并 POST 失败**（attempted / E3）→ critical"；
E2（credential_observed）未列任何 critical 示例。

**实现现状**: `consent_state == "disabled" && evidence_rank >= 2` → **critical**；
`confidence(E2) = medium` → 命中 §7.2 "critical + medium/high confidence" → **系统级通知弹窗**。

**后果**: 一条未证实任何外发尝试的凭证类观测即触发 critical 弹窗。误报一次就透支通知渠道信任
（狼来了效应），而通知信任是这个产品面最贵的资产。

**修复方向**: SV705 的 critical 从 E3 起；E2 降为 warning（进 Findings 不弹通知）。
若保留 E2 critical，须有独立于 consent 快照的第二信号。

---

## V-3（High）：清单外客户端零覆盖——检测面 = 被点名清单，规避平凡

**位置**: §2.3 Profile 边界设计 + `trust_audit.rs` discovery 实现
**现状**: 整条历史审计链以 `TrustAuditProfile` 为前提；`discover` 对未建档客户端只记 coverage、
规格明文禁止产生 Finding。规避方式：装在非 profile 目录 / 改目录名 / 用任何未建档工具外传。
P2 运行时快照是唯一兜底，但默认关、非驻留、且要求**同进程同时**出现 git 读取 + 归档写入 + TCP——
打包与上传分进程即断链。

**这不是要放弃"不编数"纪律**，而是该纪律在这一点上过严："本机存在未建档的 agent 客户端"是可验证事实，
不是推断。

**修复方向**（需规格评审通过）:
- `detected_unprofiled` 产出 **info 级 coverage Finding**（不弹通知、文案为覆盖缺口陈述），
  把静默缺口变成可见状态；
- P2 快照的三同进程信号放宽为"同 actor 或父子进程组"；
- 长期：§11 P3 的 OS 级证据（Endpoint Security / Network Extension）才是真正的检测面扩展，
  本条只是把"看不见"改为"看见并如实标注"。

---

## V-4（High）：规则注册表 10 条只实现 3 条，且"未实现"对用户不可见

**位置**: `candidates()` 只覆盖 SV702/705/709；SV701/703/704/707/708/710 缺席
**对照**: 分类图谱的覆盖状态纪律（`AGENT_EXECUTION_PROBLEM_TAXONOMY.md` 覆盖列）——
本项目对"没报"与"没实现"的区分有既定纪律。另：P0 要求的 SV701–710 登记进分类图谱尚未完成
（taxonomy 无 SV70 行）。

**后果**: 用户无法区分「没有 SV703 二次上报」和「SV703 还没实现」——把覆盖缺口读成清白，
与本仓库"缺一列的报告有价值，编一列的没有"的原则冲突。

**修复方向**:
- 信任面暴露"支持的规则/覆盖状态"清单（哪些码已接线、哪些缺席及原因）；
- P0 收尾：SV701–710 登记进分类图谱（含覆盖状态列），再谈 P1 发布。

---

## V-5（Medium）：已"解决"的 Finding 被新观测无限拉起；"忽略该规则"无持久化出口

**位置**: `correlate_selected()` 的 `evidence_fingerprint = f(issue_type, observation_id, evidence_level)`；
§7.3 承诺的动作集含"忽略该规则"
**现状**: 每条新 observation 产生新指纹 → upsert 以 open 状态重建。用户对误报点了"已解决"，
下一个同类 observation 又把它拉回 open。规格承诺的"忽略该规则"在实现中没有持久化机制。

**后果**: 误报场景下用户唯一自保途径失效，最终只会关掉整个信任面。

**修复方向**: 忽略动作写抑制记录（`actor+rule` 或 `harness+rule` 粒度，入 authority）；
correlate 时命中抑制的降为 info 或跳过，且抑制状态在 Findings UI 可见、可撤销。

---

## V-6（Medium）：consent 多维状态被压缩成单字符串

**位置**: `TrustObservation.consent_state`（enabled/disabled/unavailable/ambiguous）
**现状**: 隐私 / 索引 / 体验优化是不同开关，适配器把它们压成一个值。"disabled" 指哪个开关
由适配器内部决定且不可审计；§7.2 说"用户明确关闭**相关** consent"，但"相关"的映射没有数据表达。
读错开关 → V-2 的 critical 直接冤枉一个客户端。

**修复方向**: `consent_state` 伴随维度标签（枚举白名单，如 `telemetry/indexing/improvement`，
可入 provenance 的受限字段）；Finding metadata 列出具体开关类别；适配器必须声明读取的是哪个开关。

---

## V-7（Medium）：destination_class 封闭清单可绕过

**位置**: SV709 依赖 `destination_class == "object_storage"`，分类由适配器按 hostname 判
**绕过方式**: 自定义域名 / CloudFront / 自建网关 → `unknown` → 不触发。域名→类别封闭清单是
外传检测的经典绕过点。

**修复方向**:
- 类别清单外置可更新（本地文件，随版本发布 + 用户可补充）；
- 增加"destination_class=unknown + 显著 outbound bytes"的低置信规则（info/warning，
  文案为"未归类的大流量"，不冒充分类）——宁可标记为异常待查，不可静默归为无关。

---

## V-8（Medium）：workspace_ref 的 HMAC 密钥来源未落地，"不可逆"承诺有条件

**位置**: §5.1 "workspace_ref HMAC，不存原路径"；domain/trust.rs 只有结构校验
**风险**: 若密钥从机器名 / 固定值派生：工作区路径熵很低（`~/projects/<name>` 结构高度可枚举），
持有 HMAC 值的一方做字典攻击可还原路径。届时"不可逆"承诺落空，且 HMAC 值可能已随
issue 分组/导出离开本地呈现边界。

**修复方向**: 密钥为本机随机文件（`.mcp-session-salt` 已有同款先例），永不入库、永不进导出；
规格补一段 key 管理与轮换说明（轮换策略：宁可全部 workspace_ref 失效重算，不做可链接的弱密钥）。

---

## 流程级风险（非代码缺陷）

**P-1 schema 超前打真机库（已是本机第三次）**: 设计仍是 Draft v1、代码未提交，v18 迁移已把
真机权威库升到 v18（`schema_meta` 实测 =18）。若评审（含本评审 V-1/V-2 的改动）导致表结构变化，
真机库已固化草稿形状。此前 v15→v17（2026-09-19 深夜）、今晨我方分支构建对 v17 库的 schema_too_new
事故均为同型。**建议**: schema-bearing 工作在 worktree 内用独立 `AGENT_VITALS_HOME` 自测迁移，
设计冻结（评审通过）后才碰真机库；规格 §5.4 自己写的"不能从混合脏工作区直接复制平行迁移"
应同样约束"不能从草稿直接打真机库"。

**P-2 fixtures 缺失阻塞验收**: §12.6/12.7 要求 ZCode / MiniMax 脱敏 fixtures，`fixtures/` 下
无对应条目。V-1 的修复（时间线合成）没有 fixture 就无法验收。当前 12 个单测主题选得好
（幂等 / 不输出"已上传" / 原始路径入库前拒绝 / 关联不泄漏身份），但都是单点行为，
无一覆盖"多 observation → 单 Finding"的关联语义。

**P-3 建议补 golden/lockstep**: trust audit 输出、correlate 的 Finding 投影目前只有单测。
与本仓库 skills golden 同纪律建一份 fixture→golden（完全确定语料 + 归一化），
防止后续合并（尤其与 findings/skill 分支并行演进时）语义漂移。

---

## 做得好的（评审应保留的既定决策）

1. **证据分级与克制声明**: E0–E5、六阶段、"不得声称训练/转卖/留存"——边界意识贯穿规格与实现；
2. **写入端 enforce 校验**: `insert_observations` 对路径/URL/provenance 自由文本的拒绝在入库路径上，
   不只是测试；`raw_path_is_rejected_before_insert` 钉住；
3. **metadata 白名单 + 身份不落 Issue**: correlator 测试断言 actor/workspace/hostname 不进
   `issue_instances.metadata_json`——§5.5 的呈现边界被测试钉死；
4. **删除级联**: `delete_imported_harness_data` 先删 evidence 关联再删 observations，有测试；
5. **severity / confidence 分离**（§7.1）在数据结构层面成立；
6. **P1 不进 MCP / 默认导出**（§9）与数据留存政策的分面纪律一致。

---

## 修复优先级与发布门槛

| 序 | 项 | 级别 | 发布门槛 |
|---|---|---|---|
| V-1 | 时间窗关联（多信号链合成单 Finding） | Critical | **P1 发布阻断** |
| V-2 | SV705 证据强度（E3 起 critical） | High | **P1 发布阻断** |
| V-4 | 规则覆盖可见性 + taxonomy 登记 | High | P1 发布前 |
| V-5 | 忽略/抑制持久化 | High | P1 发布前（误报自保出口） |
| P-2 | ZCode/MiniMax fixtures + 关联验收 | High | 与 V-1 同批 |
| V-3 | 未建档客户端 coverage Finding | Medium | 需规格评审（措辞修订） |
| V-6 | consent 维度标签 | Medium | P2 前 |
| V-7 | destination 类别外置 + unknown 大流量规则 | Medium | P2 前 |
| V-8 | HMAC key 管理 | Medium | P1 文档补齐即可 |
| P-1 | schema 落库流程纪律 | 流程 | 立即（本机已三次） |
| P-3 | trust golden/lockstep | Medium | P1 后、P2 前 |

---

## 评审人备注

本评审为只读：未修改对方工作区任何文件、未在其工作区执行构建或测试（避免与在途会话的
构建锁冲突）。所有行号/函数名以 2026-09-20 11:30 的工作区快照为准；若对方已迭代，
以最新代码对照本清单逐条复核后再定论。

---

## 2026-09-20 follow-up（实现复核）

上述初评中的 V-1/V-2/P-2 已在当前 worktree 迭代中落地：关联器现在按
`(machine, harness, actor, workspace, 60m window)` 聚合，30 分钟无相邻观测即断链；SV709 需要上传准备与独立对象存储观测，SV705 在 E2 为 warning、E3+ 才可 critical；ZCode/MiniMax 脱敏链路 fixture 与 Python/Rust lockstep 已加入。Trust actor/workspace/event 引用已统一到本机随机密钥 HMAC，拒绝宽权限、符号链接和半写 key，并有并发初始化测试。

当前验收证据：Rust 全量 363 tests 通过，Python 1233 tests（8 skipped）通过，golden 16/16 字节一致，clippy 与 desktop release check 通过。剩余发布范围明确为：IntentHint bridge 尚未实现（轨迹只能作辅助上下文）、无主动 key rotation；macOS 提供可选 `lsof` runtime，Linux 仅历史审计，Windows Trust 侧标记 unavailable。
