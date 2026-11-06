# Vitals Core v0.6 —— Harness 接入契约与完整性守卫（方案）

> 状态：**提案 v0.1.2**（草案，未立项；审核轮次 R1/R2/R3 修订记录见 §14——R3 是对
> R1/R2 之后新增的计价分辨率轴的更正轮，不要按标题只读到 R2 就止步）。调研与状态
> 基准：2026-09-02；**M0–M3 已于 2026-09-02 夜至 09-03 落地**（见 §11 落地记录，
> commit `e13dafa`…`3d06f15`）——本文档的"提案/未立项"状态描述的是 v0.6 spec 这份
> 契约的**评审地位**，不代表代码未动工，读者不应按纯草案状态理解现在的仓库。并行
> claude-sync/cost 流**部分合入**（868f1a7 menubar 账卡分列、9464d30 docs），
> `workbuddy_evidence.rs/.py`、workbuddy fixtures、相关 tests **仍打开未提交**
> （截至 2026-09-03 早晨仍无变化）——落地方案为它保留顺序约束（M2b/M4）。
>
> 一句话：v0.6 把散落在四个证据适配器、三个 dispatcher、四个 CLI/前端入口里的
> **执行环境能力声明收拢成注册表**（Rust core 与 Python 各一份 parity 双实现），本语言
> 的适配器与展示层一律从本侧注册表 **derive**（语言内不再带第二份拷贝）；完整性
> 守卫从注册表行出发，逐个断言「行上声明为真的能力，实现必须存在」——接入新执行环境
> 时照注册表逐行补齐，
> 缺失环节变红而不是沉默。

## 0. 结论

1. **契约的载体是每种语言内的一张注册表**，不是 trait，也不是一份文档。Rust
   `harness_capability.rs`
   里的降级表已经是它的雏形——v0.6 把它放宽成完整的 `HarnessProfile` 行 +
   `static HARNESSES`，`degrade_rule_outcomes` 从 match 臂改成行查找。注册表回答一个
   窄问题：「这个执行环境**结构上**读不到哪些信号、哪几条规则因此语义不可判、有没有
   会话存储、有没有日/月折叠、展示叫什么」。会话级的 derive 结果、fidelity 高低、
   shape 内差异（Codex Legacy/Paginated）**不是**注册表的内容——那是每会话的事实，
   注册表一旦声明它们就变成了会漂移的文档。
2. **能力契约分三层，守卫方式各不相同**（§3）：声明类 → 注册表 + derive（消灭
   拷贝）；实现类 → 完整性守卫测试从行出发双向断言「一个不多一个不少」；语义类
   （某条规则在该执行环境上到底准不准）→ 注册表**无法**验证真值，留给差分/golden/
   真值表，注册表只负责把「语义上不可判」的规则显式登记成降级行。
3. **「遗漏环节」在 v0.6 有五种具体形态**，每一种都有对应机制：注册漏执行环境（守卫
   的 harness 清单互锁）；声明了能力但实现缺失（守卫红）；没声明能力于是静默缺失
   （托盘 workbuddy 行——现在是"漏了不红"，将来注册表行 `fold: None` 让缺失成为
   一等状态）；执行环境词表漂移（2026-09-02 workbuddy 事件词表事故 → P4.5 哨兵条款
   收进契约，§5.3）；**字段读到了但聚合时丢分辨率**（2026-09-02 claude 日桶全谷价
   事故 → 计价分辨率条款 §5.3 条款 7 + 守卫 G10）。**第五种与前四种正交**：前四
   种全在问"信号有没有被读到"，第五种问"读到的信号聚合后还够不够精确"——现有守卫
   无一条覆盖它，这是本轮新增的轴。
4. **收口顺序**（R1 修订，内容吸收审核建议的收缩，编号保留以免正文交叉引用
   全动）：M0 注册表骨架（行为零变化；含双语言来源策略 §5.1bis 与 G1 parity）→
   M1 三份 dispatcher 组装塌缩成共享投影 + Python 侧**新建 DSH canonical 适配器**
   （G3 的 dsh 行在此转绿）→ M2 缺席分层 derive——执行环境级缺席从行读、shape/会话级
   缺席留在适配器解析分支（§5.2 双层规则；**`workbuddy_evidence.rs` 正被并行流
   修改，M2b 排到该流合入之后**）→ M3 完整性守卫（三集分离 G2）+ 应用层实现注册
   （G9）+ `harnesses` CLI 表面 + 托盘/工作台执行环境行 derive → M4（可选演练）workbuddy
   日/月折叠 demo（`fold: None → Some(HarnessBillTotals)`），完整走一遍「翻行字段 →
   补实现 → 守卫由红转绿」流程。
5. **不做什么**（§2.2）：不建 trait、不动静态形态契约（HARNESS_ADAPTER_CONTRACT）、不
   动 pricing/timeline.js/wasm、不做 P4.5 的全量 rollout（只把哨兵**条款**写进契
   约）、不把 v0.5 §22 预留的 State/deterministic-diff 带进来——§22 原文写明路线
   由真实需求决定，本次修订是它的第一次行使（§10）。
6. **数据重构独立成版**（§2.3）：数据平面（§5.4）的机制落地**不随 v0.6 走**——v0.6
   的验收是字节零漂移（golden 不许动），v0.7 数据平面版（`docs/VITALS_CORE_V0_7_
   DATA_PLANE_SPEC.md`）是唯一受评审的 `--update` 窗口；演进候选 #1/#2（v0.7 spec
   §4）不入版本、随时可进。**计价分辨率（§5.3 条款 7 / G10）按"条款与守卫先行、
   实现后随"拆**：条款与守卫落 v0.6（加断言不改输出，零漂移相容），让它转绿的
   **峰谷子桶**落 v0.7 窗口；空档期违规的**计价入口**以显式缺口 `"pending v0.7"`
   逐条登记且缺口清单闭集受断言——理由是防止空档期新接入的执行环境又静默长出一份
   下界计价的折叠（§8 G10）。**判据钉在计价读法上，不钉在"有没有 hour 键"**
   （R3 修订）：DSH 的日桶同样没有 hour 键，它靠 fold 时预拆的 `peak_*` 子桶保住
   分辨率——拿 hour 当判据会误红全仓唯一计价正确的那条路。

## 1. 背景与动因

运行时证据世界（`docs/ARCHITECTURE.md` §10）已经接了四个执行环境：DSH、Codex（两条
shape：Legacy/Paginated）、Claude Code、WorkBuddy。四家的证据适配器（L1）都收敛
到同一份 harness-neutral 的 `CanonicalSession`（L2），再喂给 core 里同一批规则求值器
（L3）。这个「数据收口成功」的架构有一个没被收口的尾巴：**关于执行环境自己长什么样的
声明**——哪些信号结构上读不到、哪几条 SV 规则在该执行环境上语义不可判、日/月折叠是
哪种机制——散落在至少 6 份 per-harness 拷贝和 4 个互不关联的硬编码清单里。

### 1.1 复制点清单（形状相同、数据不同）

| # | 复制点 | 份数 | 证据位置 |
|---|---|---|---|
| A | `is_unavailable` 结构性缺席声明 | Rust 4 + Python 镜像 | `claude_code_evidence.rs:104`（7 信号，注释自认"一份漂移"）、`codex_evidence.rs:279`（4）、`workbuddy_evidence.rs:130`（12）、`dsh_evidence.rs` 内联 ~483（5）；`claude_evidence.py` / `codex_evidence.py` / `workbuddy_evidence.py` 同形状镜像 |
| B | `ALL_SIGNALS` / 覆盖键表 | ≥6 | `claude_code_evidence.rs:74`、`codex_evidence.rs:475`、`workbuddy_evidence.rs:71` 等 |
| C | dispatcher 组装（family① → degrade → family④ → flatten → summary） | Rust 3 | `claude_session.rs:249`、`workbuddy_session.rs:300`、`codex_session_audit.rs:79`；**Python 已塌缩成 1 份共享** `canonical_audit.py:60` `audit_projection(canonical)`——执行环境无关，降级由调用方 override。Rust 侧的三份拷贝各自只差一行 degrade 参数 |
| D | `evidence_json` 序列化器 | ~6 | 各证据适配器内部 |
| E | `derive_coverage` 骨架 | ~8 | 同源 |
| F | `SessionStore` 三段式构造（cache 快路径 → 增量重建 → 冷全量） | 3 | `r2a_store.rs:494/569/648` |
| G | 源指纹/statuses 表 | 3 | `r2a_store.rs` |

**Tier 分法**（回答"有哪些可复用的代码"）：
- **Tier 1 真正共享（按设计）**：`evidence.rs` 全部共享类型与门控、`behavior.rs` /
  `trajectory.rs` 共享求值器（零 `harness_id` 引用）、`harness_capability.rs` 降级表、
  Python 共享投影 `canonical_audit.py`、cost 核心数学。**这些是 0.6 要保护的
  资产**——任何新执行环境都免费得到它们。
- **Tier 2 假共享（复制粘贴，候选塌缩）**：上表 A–G。每一份都是"同一形状、换了
  harness 专属数据"，塌缩方向就是注册表行（A/B）与共享函数带 `harness_id` 参数（C/D/E/F）。
- **Tier 3 不可约**：per-harness 存储格式解析——DSH 增量多帧 zstd、Codex 日期分区
  Legacy+Paginated、Claude 项目 hash 消息树 → 流、WorkBuddy SQLite+hash 链+blob+
  文件历史。解析器之间没有可复用面，0.6 不做任何合并尝试。

### 1.2 守卫不对称（agent 37 调研节选，0.6 要补的洞）

- harness 清单硬编码 **4 处互不关联**：`cli.py:658`、`cli.py:986`、`src/main.rs:164`、
  `test_cli_matrix.py:51` 的 `HARNESSES`——没有一把测试断言它们相等，加第五家时只改其
  中两三处不会红。
- adapters/ 目录与 `--harness` 选择项之间没有双向 equality 断言（test_classification
  守的是子树归属，不守执行环境集合）。
- 会话侧 3 家 store 硬编码（`r2a_store.rs:1465` `harness_has_source` 等）。
- 工作台 `workbench.js` 的 `sessFilter` 只有 `"all"|"dsh"|"codex"`——**有 store 的
  claude-code 没有 filter**，前端不对称（workbuddy 无 store，缺席反而是"正确"的，
  但没有任何东西在解释为什么）。
- 表征深度极不均：codex 101 处测试引用 vs claude 16 vs dsh 7 vs workbuddy 2 vs
  hermes 1——「每个执行环境的语义真值钉在哪」没有预算概念。
- §17.1 的 coverage-matrix golden 从未以表格形态落地（见 §10）。
- Codex findings 聚合 Rust-only（`test_cli_matrix.py:2125-2145` 明写无 Python
  镜像）。
- **DSH 的 Python 路径不产 canonical**：`behavior.py` 的 `match_behavior_gated`
  走的是自家门控，而 Rust 侧 dsh 走 canonical——第四家执行环境在 Python 侧是历史绕行
  路径。v0.6 的统一目标是让 dsh 的 Python 路径与另外三家一样经共享投影求值
  （§7）。

### 1.3 托盘/表面的"漏了不红"

菜单栏固定三行 dsh→codex→claude-code（`MENUBAR_MULTIHARNESS_NAVIGATION_SPEC.md`
L9-11/162-176 等 ~8 处 + `overview.rs:243-252` 兜底三行），WorkBuddy 不在其中——
这不是 bug，是**没有日/月折叠机制**的必然结果；但它目前是不可解释的缺席：没有任何
一份声明说"workbuddy 无折叠所以无行"。等价的：`workbench.js` 的会话筛选缺
claude-code。两处的修复方向相同——**展示层执行环境行从注册表派生**（`fold != None`
出成本行、`session_store` 出会话行），今天派生结果与硬编码恰好一致（字节不变），
将来加 WorkBuddy 折叠 = 翻一行字段 + 补实现 + 守卫转红再转绿（§6、§11-M4）。

## 2. 目标与非目标

### 2.1 目标

- **声明收口**：证据人格（unmeasured 信号集、降级规则与原因）在每种语言内部
  单一化进注册表；Rust/Python 是 parity 守护的双实现契约（§5.1bis）；
  适配器/降级/展示一律 derive，仓库里不再出现 per-harness 的能力声明拷贝。
- **实现有守卫**：注册表行上每个 `true` 字段都对应一处必须存在的实现；完整性测试
  从行出发双向断言，清单（CLI choices、test_cli_matrix HARNESSES、分类家族、前端
  filter）与注册表 ids 互锁。
- **缺失成为一等状态**：折叠/存储能力为 `None`/`false` 的执行环境在展示层要么显式缺席
  （行声明过），要么渲染「无此能力」，绝不静默。
- **共享投影塌缩**：Rust 侧 3 份 dispatcher 组装收成 `canonical_audit.rs` 一份
  共享函数（镜像 Python），行为字节不变（golden + differential 验收）。
- **接入 playbook 化**：新执行环境 = 一张注册表行 + 守卫的一次迭代，必选项可枚举
  （§9）。

### 2.2 非目标

- **不做 trait**。`ARCHITECTURE.md` §4.2 的理由在证据侧同样成立：执行环境之间差异在
  "哪些阶段存在"，不是接口形状——注册表 + 行查找比 trait 对象诚实（§5.2）。
- **不动静态形态**：`HARNESS_ADAPTER_CONTRACT.md`（session 分析**静态形态**的执行环境契约
  ——7 执行环境的 adapters/会话读取 + 方向 A 跨执行环境安装发现面）不在本方案内；本方案的
  `HarnessProfile` 注册表只覆盖 session 分析 **runtime 形态**（4 执行环境，REC §13 矩阵）。
  两个形态的文档边界在 v0.5 已划清（§10）。
- **不动 P4.5 全量 rollout**：schema-drift 哨兵的逐执行环境落地是 v0.6 后续项；本次
  只把哨兵**条款**写进契约 §5.3（extract 必须上报无法归类的记录），workbuddy 的
  `attempts`/`KNOWN_EVENT_TYPES` 模式是现成样板。
- **不把 v0.5 §22 预留的 State/deterministic-diff 带进来**（§10 修订说明）。
- 不动 `pricing.json`/`timeline.js`/wasm/SKILL.md/README；不改信封线协议
  schema_version "1"。
- **不做 per-shape 注册表行**：Codex 的 Legacy/Paginated 双列是 shape 级差异，行里
  只放两列结构性缺席的**交集**（§5.2）。

### 2.3 版本边界：v0.7 数据平面独立成版（2026-09-02）

§5.4 数据平面的**机制落地不随 v0.6 走**——两者验收纪律互斥：v0.6 的验收是字节零漂移
（golden 原样、differential 全绿、`--update` 不许动），数据重构则是「主动改持久格式 +
受控 `--update`」。同版本时 golden 变红无法归属（是 harness-contract 还是 schema 演进引
起），reflexive `--update` 的诱惑会让 golden 失去意义；独立成版 = 给 schema 演进一个
**唯一的、受评审的 --update 窗口**。拆分表：

| 内容 | 归处 | 理由 |
|---|---|---|
| §5.4 全节的表达修订（视图目录/统一事实行/列化语义/演进候选） | 不入任何版本 | 非机制变更；v0.6 与 v0.7 的公共设计声明 |
| 演进候选 #1（I/O 类型壳）、#2（键词表收敛） | 不占版本，随时可进 | 字节不变（字面量→常量、加壳不换输出），golden 不红，不与并行流文件相交 |
| 候选 #3（事实行契约 + 每执行环境一物化视图）、#4（schema_version 迁移函数表）、§5.4.2 未来例中零新数据视图的输出面 | **v0.7 数据平面版**——独立 spec（如 `VITALS_CORE_V0_7_DATA_PLANE_SPEC.md`） | 动持久格式、动跨调用状态、动双语言 lockstep——「数据重构」的真身 |
| §5.4.3 HarnessProfile 列化 | 留 v0.6 | 注册表行 = 列填充能力卡，是 harness-contract 自身的语义，不随数据面走 |
| §5.3 条款 7（计价分辨率）+ §8 G10 守卫（含 `"pending v0.7"` 缺口登记） | **留 v0.6** | 契约不变量 + 断言；加断言不改输出、golden 零漂移，与 v0.6 验收相容。缺口清单闭集受断言 = 空档期的防回退面 |
| ledger 日桶加 `peak_*` 子桶（照 DSH 既有日形状）、`price_claude_map` 的**两个**计价入口改走峰谷读法、事实行的时变维列 | **v0.7** | 动持久格式与跨调用状态，属受评审 `--update` 窗口；落地后 G10 的两条缺口由红转绿、条目删除。**不新造 hour 桶**（R3 修订）——DSH 的 `peak_*` 子桶（`usage.rs::add_buckets` 预拆 → `cost.rs::bucket_price` 用「全量 − peak_*」还原空闲份额）已是全仓验证过的日形状，claude ledger 照它做即可直接复用 `bucket_price`/`priced_day`，与 `token_by_date_model` 同形；hour 信息更多（峰窗规则改了能重算）但要新造第四种日形状，是个该显式做的取舍，v0.7 若选它须在该 spec §5 写明理由 |

顺序约束：v0.6（registry，字节冻结）先行落地 → v0.7 后开，重叠即互相污染；两者都排
在并行 claude-sync/workbuddy 流合入之后（`r2a.py`/`r2a_store.rs` 仍在修改清单）。
（2026-09-02 已执行：§5.4.1/5.4.2/5.4.4 主体随迁 `VITALS_CORE_V0_7_DATA_PLANE_SPEC.md`，本 spec §5.4 留指针；§5.4.3 留守。）

v0.7 验收（先写死，防它退化成第二场零散 --update）：

- **迁移函数表落地**：schema_version 从写时 stamp 升级为显式「读旧版 → 迁移 → 新版」
  链；迁移每步幂等（merge/rotate「每 token 恰好一次」分工照旧，per-day 替换不重不丢）。
- **唯一一次受评审的大 `--update`**：逐条评审 diff，不是 reflexive（CLAUDE.md 纪律）。
- **双语言 parity 与不变式全绿**：golden/differential；每 token 恰好一次、
  token_by_model ≡ token_by_date_model 月全等、partial 只标不价、月文档只含当月
  （merge_month 归档先行）。

## 3. 三层次契约模型

「让 adapter 按契约实现能力」这句话里，"契约"必须拆成三种、守卫机制各不相同，
混在一起任何单一机制都会失灵：

| 层次 | 契约内容 | 载体 | 守卫机制 |
|---|---|---|---|
| ① 声明类 | 哪些信号结构上读不到、哪几条规则降级、折叠/存储能力、展示名 | **注册表行**（每种语言内部的唯一声明源；跨语言 parity） | 本语言消费方 derive；残留第二份声明的文件被守卫抓（§12 的源码自扫描先例可复用） |
| ② 实现类 | 行上声明为真的能力对应哪份实现（模块/命令/折叠生产器） | 注册表行字段 | **完整性守卫**：行 × 双语言镜像 × 清单互锁，双向"一个不多一个不少"（借用 test_classification 的显式集合风格） |
| ③ 语义类 | 某条规则在该执行环境语料上真的准（真值表、误报率） | fixture + 真值表单测 + 差分/golden | 注册表**不验证真值**；它只登记"语义不可判 → 降级行"，语义本身由每执行环境的语料级测试钉住 |

②与③的差别是这次设计里最容易搞混的地方：完整性守卫能抓「注册了 `session_store:
true` 但没有 store 实现」，抓不了「workbuddy 的 Usage 其实是"未复核"而不是结构性
缺席」——后者是语义判断，注册表只能通过**出处纪律**（每条 unmeasured 注明矩阵格
或适配器注记，§5.3）逼人显式决策，决策对错由真值表负责。

## 4. 现状事实（四个执行环境的当前人格）

| | DSH | Codex | Claude Code | WorkBuddy |
|---|---|---|---|---|
| 证据适配器 | `dsh_evidence.rs` | `codex_evidence.rs`（Legacy/Paginated 两 shape） | `claude_code_evidence.rs` | `workbuddy_evidence.rs` |
| structural-unavailable 声明 | 5 信号（内联 ~483） | 4（:279） | 7（:104，注释自认漂移） | 12（:130） |
| 降级行（family① post-rule） | 无 | 无 | SV607/608 → ToolResults | SV604/605 → ToolCalls |
| canonical 求值 | Rust 走 canonical；**Python 绕行**（`behavior.py match_behavior_gated`） | 共享投影 | 共享投影 | 共享投影 |
| 日/月折叠机制 | DSH state 链（today.json/month.json） | CLI 静态 scan（codex_cost/usage fold，不进 state 链） | 独立 ledger（claude-ledger.json 增量，读时计价，不碰 month.json） | **无**（会话审计的成本块是执行环境已计费 credit 求和，不重计价） |
| SessionStore（sessions list/read/导航） | ✓ | ✓ | ✓ | ✗（envelope 未知执行环境 → StoreError） |
| 托盘成本行 | ✓（state） | ✓（events-scan） | ✓（ledger） | 缺席（不可解释，§1.3） |
| **记账机制**（钱怎么进 vitals，与折叠轴正交） | 自算：state 链 × pricing.json `providers`（峰谷卡） | 自算：独立 USD 表，静态 | 自算：catalog_2026_09，读时（独立 ledger） | **执行环境已计费**：会话成本块 = `used`/`credit_json` 求和，不重计价 |
| pricing 来源 | pricing.json（provider 组织，非 harness 组织） | 独立 USD 表 | catalog_2026_09 | credit_json 执行环境账单 |

展示列：菜单短名 `harness_display_name`（`lib.rs:207-214`）unknown → passthrough（测试
钉 "future-harness" 不 panic）——这个 fail-open 决策保留：注册表行的 display 只约束
已知执行环境。

## 5. 契约设计：HarnessProfile 注册表

### 5.1 载体与行结构

**落点**：放宽 `crates/agent-vitals-core/src/contracts/harness_capability.rs`（**不改名**——模块
名被 test_classification 家族清单、imports、Python 镜像引用，改名是纯 churn；行数
超 ~300 行再考虑拆出 `harness_registry.rs`，届时改分类清单 + 两侧 import 一次过）。
Python 镜像 `harness_capability.py` 同步成同一行集。Rust core 是 Rust 消费方的唯一声明
源，binary/Tauri/wasm 全部经 core 读；Python 注册表是 Python 消费方的唯一声明源，
两种语言由 G1 byte-parity 保持一致（§5.1bis）。

```rust
/// 一个执行环境在 session 分析 runtime 形态（REC §10 四执行环境）下的完整人格声明。
/// 只回答「结构上读不到什么、哪些规则语义不可判、有什么数据层能力」；
/// 不回答「derive 出什么、fidelity 多高」（那是每会话事实）。
pub struct HarnessProfile {
    pub id: &'static str,                       // "dsh" | "codex" | "claude-code" | "workbuddy"
    pub display: &'static str,                  // 菜单/报告短名（harness_display_name 的真相源）
    /// 结构性缺席信号（**执行环境级**，全 shape 交集）：执行环境记录里该信号不存在可读形态，
    /// 任何会话都不可能 bump。排序约定：按 Signal 枚举序。每一行只取**该执行环境**
    /// 当前 is_unavailable 集合，并与 §13 矩阵逐项校验；矩阵未覆盖的信号也按执行环境
    /// 分别登记，绝不构造“全执行环境共同缺席集”（UserPrompts 已在 Codex/Claude Code
    /// measured）。**shape/会话级缺席不在此列**——那是该 shape 解析器的产出
    /// （双层缺席规则，§5.2）。
    pub unmeasured_signals: &'static [Signal],
    /// 语义降级（逐条声明）。与 unmeasured 的区别：信号**有**形态、规则能跑出零命中，
    /// 但零命中不可信——claude 的 ToolResults 无 denied/error 词表所以 SV607/608 的
    /// 命中无意义。结构缺席走 canonical 门控自然报 Unavailable；语义不达才需要降级行。
    pub degraded_rules: &'static [DegradedRule],
    /// 能力**声明**（只声明不证明；实现存在性由 binary/Tauri 侧 HarnessRuntimeRegistration
    /// + 守卫 G9 保证，§5.1bis——core 不依赖任何文件系统实现）。
    pub session_store: bool,                    // 进 SessionStore（sessions/导航/信封）
    pub fold: Option<FoldOutput>,               // 日/月折叠产出能力；None = 声明缺席
}

/// 降级逐条声明——reason 挂在规则上而非执行环境上（R1 修订；执行环境级一条 reason 盖全部
/// 规则撑不过第二家降级执行环境）。reason 文本沿用现有常量并继续与 Python 镜像逐字
/// 锁步（G1 parity 覆盖）。
pub struct DegradedRule {
    pub code: &'static str,           // "SV607" | "SV608" | …
    pub missing: &'static [Signal],   // 该码语义不可判所缺的信号（支持多个）
    pub reason: &'static str,
}

/// 日/月折叠的**产出能力**（R1 修订：砍掉以实现策略命名的枚举——DshState/
/// EventsScan/Ledger 是应用层策略，core 行不声明；策略与函数入口住在消费方
/// 二进制的 HarnessRuntimeRegistration，§5.1bis）。
pub enum FoldOutput { TokenBuckets, HarnessBillTotals }
// dsh/codex/claude-code = TokenBuckets（各自价目自算）；workbuddy 未来 =
// HarnessBillTotals（累计执行环境积分账单；billing 仍 HarnessBilled，绝不冒充逐模型 token
// 重计价，§5.2bis）。

pub static HARNESSES: &[HarnessProfile] = &[ /* 四行，顺序即展示顺序 */ ];
```

`degrade_rule_outcomes(harness_id, outcomes)` 从 match 臂改成 `HARNESSES` 行查找
（保持现有签名与语义：只在 MeasuredZero→Unavailable 方向翻转，绝不吞 Findings 或
既有 Unavailable；未知执行环境 no-op——fail-open 的兼容口，同时未知执行环境没有行可查 =
**fail-closed 的注册口**，两件事不冲突：查询旧行为 no-op，注册新行为必须加行）。

### 5.1bis 双语言来源策略与实现注册（R1 修订）

**双语言不是"零拷贝"，是双实现契约。** core `static HARNESSES` 与 Python 镜像
`harness_capability.py` 是两份**人工维护、parity 守护**的行集——这与仓库既定的双实现
规范一致（behavior/usage/cost 的规则全部如此，differential/golden 守护；
`pricing.json` 是**数据**例外：单一源码在 scripts/ 侧、Rust 侧 `include_str!`，但
注册表是带 `Signal` 引用的**类型化规则**，JSON 数据化会丢类型、且 Python ClawHub
分发拿不到 core crate 文件，共享数据文件只会变成第三份拷贝）。因此本文的"零拷贝"
范围是**语言内消费**：适配器/降级/展示从本侧注册表 derive，不留第二张 per-harness
表；语言间由 G1 byte-parity 保一致。将来若行集膨胀到手工维护不可控，再议
checked-in 数据表 + 代码生成——目前不是。

**能力声明与实现注册分居两侧。** core 行只声明执行环境级结构能力
（`session_store`/`fold`，供展示与派生）；binary CLI 与 src-tauri 各自持有一张
`HarnessRuntimeRegistration`——harness_id → 该执行环境**在这个二进制里**的 store 构造器 /
fold reader / 会话命令函数入口。core 不依赖任何文件系统实现；守卫 G9 断言
「某消费表面要求的能力 ⊆ 该表面的实现注册集」，而不是要求每个二进制实现全部
能力；托盘/会话表面从各自**注册集**派生而非直接遍历行（§6）。

### 5.2 注册表回答什么、不回答什么

回答：一个窄问题——**该执行环境结构上读不到哪些信号**（§3 ① 的声明层）。

不回答（一旦声明就变成会漂移的文档，全部留给会话级事实）：
- **derive 结果**：measured/derived/lossy 是每会话由 raw 事件算出来的，注册表只管
  "哪些信号 bump 了也白 bump"（unmeasured）与"规则跑了也白跑"（degraded）。
- **per-shape 差异（双层缺席规则，R1 修订）**：Codex Legacy/Paginated 在 §13 矩阵
  是两列，缺席分两层。**执行环境级**（两列结构性都缺席）→ 注册表行 unmeasured，是 M2
  的 derive 目标；**shape/会话级**（只在一列缺席，如 approvals）→ 该 shape 解析器
  的**产出**——它按线格式分支、知道自己在解析哪个 shape，直接不 bump 并报
  unavailable。那是解析结果，不是能力声明，不构成第二张表。现存的
  `is_unavailable` 表全部是执行环境级（shape 无关），删之无损；0.6 不做 per-shape 行。
- **fidelity / 未复核格**：§13 用 ※ 标的"unverified"格不是结构性事实。WorkBuddy
  Usage 是活例子：§13 格 = unverified(※)，`workbuddy_evidence.rs:130` 把它保守
  处理成 unavailable。这个张力注册表消解不了，只能**逼出显式决策**——出处纪律
  （§5.3）要求该条目带注记，矩阵格与代码行由守卫对账（§8.4），哪边改哪边红。
- 展示细节（图标/布局/颜色）——留在 Tauri。

### 5.2bis 执行环境×模型为什么不成矩阵（计价关系的代码切分）

问「执行环境×模型（不同模型不同计费模式）是不是一个矩阵」时，代码里的答案是否定的——
没有一个执行环境×模型的交叉表，关系被切在**四条独立轴上**，各自有单一真相源，执行环境行
与价目表都只是其中一段：

1. **数据轴（执行环境无关、事件级）**：token 折叠按 **model** 键累计
   （`token_by_model`/`token_by_date_model`）。(model, provider) 是**事件自带**的
   属性而非执行环境属性——compaction 反例已证明：`data.usage` 自带的 model/provider
   与会话活跃模型不同，归因必须挂事件。执行环境只是语料来源；(session|date)×model 的
   二维累计是 fold 的**产物（数据）**，不是契约。
2. **价目轴（model → 单价，provider 组织）**：`pricing.json` 顶层
   `providers`（deepseek-official/shengsuanyun，卡片 = 嵌套 `{peak, off_peak}`
   逐字段峰谷）+ `catalog_2026_09`（anthropic USD 平卡、minimax/moonshot）。
   **「不同计费模式」的落点是价目卡片形状**：嵌套峰谷卡 → `bucket_price` 做时段
   拆分（`rate("/input_uncached/off_peak")` 等路径）；平值卡 → 单一费率无时段；
   `is_peak` 未上报（执行环境没给时间戳）→ 该笔不计价、累计 carry。同一执行环境内的不同
   模型就是不同卡片形状——所以"模型×计费模式"活在价目表里，不在执行环境行里。
3. **模式判定轴（这笔用量按什么付：订阅 vs 按量）**：判定链显式写在
   `catalog_2026_09.subscriptions._doc`（2026-09-02）：①账户层
   `~/.claude.json::oauthAccount.billingType` 有订阅值 → 套餐候选；②路由层
   `ANTHROPIC_BASE_URL`/key 非官方端点 → 按量；③事件层 `quotaLimits`
   five_hour/seven_day 拒绝史确认订阅窗在跑。订阅覆盖该提供商全部用量、**没有边际
   token 账单**，摊销单价仅供感知层、不得冒充 confirmed waste（ATTRIBUTABLE_WASTE
   §6）。判定维度是 (账户, 路由, 拒绝史)，逐 session 逐提供商——既不是执行环境也不是
   裸模型。同轴还有差分 oracle：`lastModelUsage.costUSD` 对 claude 系模型逐分吻合
   可当账单证据，第三方模型按默认卡计价**不可**当证据。
4. **记账轴（钱怎么进 vitals，usage/session 级事实）**：Harness 只说明语料从哪里来，
   不决定谁收费。同一个 Claude Code 会话可以经官方订阅、Anthropic API 或第三方
   provider 路由；每笔 usage 必须分别产出 `billing_source`、`billing_mode` 与
   `pricing_basis`，无法判定就明确为 unknown（`ATTRIBUTABLE_WASTE.md` §6.3）。

**对注册表的意义**：不引入 model/provider/billing 维；`HarnessProfile` 也不保存唯一的
`BillingKind`。价目真相源仍是 `pricing.json` + core cost 数学，实际计费归属由
usage/session 证据判定。WorkBuddy 当前会话成本块只读 `used`/`credit_json`
（`workbuddy_evidence.py:390`），这是该适配器当前产出的 `harness-billed` 证据，不是
WorkBuddy 这个 Harness 永久且唯一的计费人格。折叠能力只声明输出形态 `FoldOutput`。

### 5.3 安全条款（契约的不变量）

1. **降级单向性**：degrade 只在 MeasuredZero→Unavailable 翻转；测试对行上全部
   (code, signal) 对穷举三态输入断言（现有 4 个 Rust 测试扩展成行驱动的全量 +
   Python 镜像同断言）。
2. **unknown harness fail-open 查询 + fail-closed 注册**：查询路径无行 = no-op（现状
   保持，向后兼容）；注册路径无行 = 进不了 `HARNESSES`，任何消费方查不到它。机制是
   **守卫期 fail-closed**（R1 修订，撤回"编译期"表述——id 是 `&str`，打字面量拦
   不住；要编译期保证需 `RegisteredHarnessId` 新类型，代价是信封/会话存储全线 string
   面改造，不值）：行查找返回 `Option<&HarnessProfile>`，消费方必须处理 None；G2/G4
   断言任何运行时 surface 的合法 id 集与行集相等、`all` 等伪执行环境绝不进注册表。
3. **unmeasured 出处纪律**：行里每条 unmeasured 必须能被追溯——要么对应 §13 矩阵
   该执行环境 unavailable 格，要么属矩阵外的**该执行环境补充项**，要么带适配器注记
   （如 workbuddy Usage ※）。无来源注记的条目过不了守卫的对账测试（§8 G5）。
4. **extract 哨兵条款（P4.5 泛化，收进契约）**：每个证据适配器必须上报它读不懂的
   记录——workbuddy 的 `attempts`/`KNOWN_EVENT_TYPES` 模式是样板（2026-09-02 事故：
   2,471/2,563 条记录因词表漂移未知仍静默通过）。条款：**extract 阶段遇到
   harness 词表外的形态 → 计入 unmetered/attempts，规则侧照常报 Unavailable，不许
   静默归零**。全量 rollout（给 codex RolloutItem 等补哨兵）是 v0.6 后续项，但新
   接入的执行环境从第一天起遵守本条。
5. **derive-not-copy（语言内）**：注册表字段的唯一读法是查找函数；任何文件里出现
   第二份 per-harness unmeasured 字面量表 = 守卫红（§8 G8 源码自扫描，`evidence.rs`
   §12 自检先例；语言间的行集重复是双实现契约，见 §5.1bis）。
6. **声明缺席 ≠ 遗漏**：`fold: None`/`session_store: false` 是合法状态。守卫锁死
   展示层从行派生（§6），所以缺席永远是"被声明过的缺席"——它和"注册了却没实现"
   是两种不同的红，前者不红。
7. **计价分辨率条款（2026-09-02 新增；判据经 R3 修订，实证来源见下）**：若某模型
   的价目卡是 `{off_peak, peak}` 形状（**单价随时间变**），则任何按该卡计价的事实
   行与物化视图**必须保住足以做峰谷拆分的分辨率，并以峰谷读法计价**；做不到时只能
   报 `partial`/不精确并走哨兵条款（条款 4 同族），**不得取时间维下界（全
   `off_peak`）冒充"保守估算"**。合法取平费率的前提是**卡本身是平费率**（catalog
   的 anthropic/moonshot USD 卡、MiniMax 档位卡），不是时变卡的兜底。

   **"保住分辨率" ≠ "留 hour 键"（R3 修订，此前写反过一版）**：DSH 的日桶里
   **没有** hour 键——它在 fold 时就按 `is_peak_slot` 把 `peak_*` 子桶拆出来
   （`usage.rs::add_buckets`），计价侧用「全量 − `peak_*`」还原空闲份额分别计价
   （`cost.rs::bucket_price`）。分辨率是靠**折叠时预拆**保住的，不是靠留一根时间轴。
   因此本条约束的是**计价读法**：时变卡必须经峰谷读法（`bucket_price` 族），不得经
   下界读法（`cost.rs::flat_rate` 的 `/{key}/off_peak` 兜底、`cost.py::_flat_rate`
   同形）。把"有没有 hour 键"当判据会误红 DSH——全仓唯一计价正确的那条路。

   **适用面按计价入口算，不按执行环境算（R3 修订，2026-09-03 复核订正引用行号）**：
   `flat_rate` 本体（`cost.rs:710-718`）是下界兜底所在，经 `price_claude_model`
   （`cost.rs:756-759` 是调用它的行，不是兜底本体自身）被 `price_claude_map` 共用，
   而 `price_claude_map` 的 doc 注释自己钉死「两面的钱必须同源」——它同时服务
   `claude_day_cost`（日桶/托盘）与 `claude_session_cost`（会话账）。同一执行环境的这两
   个入口各算一格：只改其中一个既不算修完，还会让两面从此**不同源**，正好违反那条
   注释钉住的纪律。

   **为什么它是一条新条款而不是既有条款的推论**：条款 1/3/4 与 `evidence.rs`
   的全部纪律都约束**"某个信号有没有被读到"**（证据轴的 presence/absence）。
   本条约束的是另一件事——**一个已经读到的字段，聚合之后是否还保留了足以计价的
   分辨率**。小时不是缺失信号：`claude_cost` 的行自带 ts（实测 104,809 条全部带
   `Z`），是 `_rebuild_days` 归日成日桶时把它**丢掉了**，于是 `cost.rs::flat_rate`
   只能取 `off_peak`。现有守卫无一条会因此转红——这是 §1.2「守卫不对称」在**计价
   轴**上的同构：DSH 路径逐事件带 `is_peak_slot`、claude 路径退化成日桶全谷价，
   两者分辨率差一个量级而没有任何东西红。本条是 `evidence.rs`「适配器不得用读不
   到的东西刷覆盖」的对偶：**不得用丢掉分辨率的聚合冒充精确计价**。

   实证（`docs/CLAUDE_COST_DAY_ATTRIBUTION_ANALYSIS.md` §2.2/§3.1/§6，2026-09-02
   真机）：托盘 claude 今日 ¥45.40 vs DeepSeek 后台账单 ¥74.3797，差额 89%
   （¥25.68）来自本条被违反——当日 69% 消费落在峰窗，全谷价即砍半。同日证明
   价卡与峰谷窗口本身无误：**本仓价卡 × 官方 token 量 × 每行真实小时 = ¥74.3797
   = 账单，分毫不差**，缺的只有小时轴。该低估幅度随当天峰段占比浮动（今天 35%），
   既不稳定也无法标注，因此不构成合法的"已知方向低估"。

### 5.4 数据平面：统一基本表 + 视图（2026-09-02 新增）

会话"身份"的统一已有先行实现——**R2a SessionStore**（`docs/R2A_CONTRACT_DESIGN.md`；
`core::r2a` 纯规则 + `r2a_store.rs`/`r2a.py` I/O；cache v2 按源指纹增量失效、载荷复
用既有审计输出"不发明新字段名"）。它统一的是**会话是什么**（SessionKey：
harness_kind→native_id→source_profile→machine_namespace + filter/cursor/版本闸）。

本节的缺口在**事实层**：usage/token/账单行分存各家账（dsh state 链 / codex 静态
fold / claude ledger / workbuddy credit_json），消费端（menubar 六行、日历、工作台
tab、dsh-client 投影）各自手工 join、每处一个 basis——§1.2"漏了不红"在**结果侧**
的重演。本方案把数据平面定成两层：**基本事实行（逻辑 schema）+ 视图（纯查询）**；
消费端只许查视图，不许直读各家账。扫描报告（方向 A）不在本表内——它消费执行环境安装
语料而非会话事实，两个方向的数据平面不相交（§8 方向轴）。

**5.4.1（统一事实行）/ 5.4.2（视图目录）/ 5.4.4（数据结构演进）设计主体已于
2026-09-02 随迁 v0.7 数据平面版**：`docs/VITALS_CORE_V0_7_DATA_PLANE_SPEC.md`——
统一事实行、视图目录（含四个未来例视图行与本版交付矩阵）、ORM/NoSQL 定位与四条
演进候选、验收（唯一受评审的 `--update` 窗口）见彼处；版本边界与拆分表见 §2.3、
§0.6。下列 §5.4.3 是 harness-contract 语义，留本 spec。

#### 5.4.3 HarnessProfile 列化（契约语义不变，表达换成表模型）

- `unmeasured_signals` ↔ 该执行环境在事实行留下哪些列 **NULL/absent**（表级缺席；
  shape/会话级缺席仍是解析结果——双层缺席规则 §5.2 原样）；
- `degraded_rules` ↔ 视图遇 NULL 列的处理：MeasuredZero = 列读了全空，Unavailable
  = 列不可读（harness_capability 三态语义平移到列）；
- `fold: Option<FoldOutput>` ↔ 该执行环境当前可产出的折叠列族：TokenBuckets 填 token
  buckets，HarnessBillTotals 填 `harness_amount`。它不决定实际 `billing_source`/
  `billing_mode`；这些仍由每条 usage/session 事实携带，Harness ≠ BillingSource；
- `session_store` ↔ 身份行可填（R2a 会话来源）。注册表行 = 一张**列填充能力卡**；
  §8 守卫照旧断言行集与卡同源（G2/G4/G9），测试开销不变。

## 6. 消费方 derive 改造

| 消费方 | 现状 | 改后 | 验收（字节不变） |
|---|---|---|---|
| `harness_capability.rs` degrade | match 臂 | `HARNESSES` 行查找 | 现有单测 + Python 镜像 parity |
| 执行环境级 unmeasured 声明（复制点 A） | 每文件一份 | **执行环境级**从行读，文件里不再有字面量表；shape/会话级缺席留在适配器解析分支（§5.2 双层规则） | golden 全绿；合成会话属性测试：raw 试图 bump unmeasured 信号 → 产出仍 unavailable/零 |
| `ALL_SIGNALS`（复制点 B） | 每文件一份 | 完整枚举上收为共享 Canonical Schema（Rust `Signal::ALL` 或等价常量；Python schema 常量）；所有适配器统一遍历，不再保留 per-harness 完整信号表。“能 bump 什么”由 derive 代码与会话 coverage 表达，不另建声明表 | schema 顺序测试 + golden 全绿 |
| dispatcher 组装（复制点 C） | Rust 3 份拷贝 | 新 `crates/agent-vitals-core/src/domain/canonical_audit.rs`（或 binary 侧 `src/agent/canonical_audit.rs`）：`audit_projection(canonical, harness_id)` 一份共享，内部做 family①→degrade(行)→family④→flatten→summary | **golden 15 例字节零漂移 + differential**（Python 侧已是共享的，`canonical_audit.py:60` 就是模板）；Python 的 DSH 绕行路径（`behavior.py match_behavior_gated`）并入共享求值器 |
| `evidence_json` 序列化（D）/ `derive_coverage` 骨架（E） | 各一份 | 共享骨架 + harness 参数（unmeasured 从行取） | 同上 |
| `SessionStore` 三段式（F）、源指纹（G） | 3 份 | 行 `session_store: true` 决定 store 集合；构造器骨架共享 | `sessions` 命令输出不变；envelope v1 不变 |
| `harness_display_name` | `lib.rs:207` match | 从行 `display` 读；unknown → passthrough 保留 | "future-harness" 测试原样 |
| 托盘成本行枚举 | ~8 处硬编码三行 | 遍历**本二进制注册集**里 `fold != None` 的执行环境（今天恰好 = 三行，行为零变化）；UI 可自行排序/分组——行数组顺序只是默认展示序，不是 UI 契约（R1） | 菜单快照/DTO 测试原样；`workbuddy` 加折叠（M4）后注册进集即出现 |
| 工作台 `sessFilter` | `"all"|"dsh"|"codex"` 硬编码 | 从 IPC 执行环境列表（`session_store` 行）派生 | jsdom 验证（memory: workbench-frontend-verify 配方）；claude-code 从此出现在筛选里 |
| `sessions_list/read` 未知执行环境 | StoreError | 行集合决定合法 id（未知仍 StoreError，语义不变） | 原测试原样 |
| 二进制实现注册（R1 新增，G9） | 能力与实现混在声明里、无注册面 | core 行只声明；binary CLI / src-tauri 各持按 surface 划分的 `HarnessRuntimeRegistration`（harness_id → store 构造器 / fold reader / 会话命令入口）；守卫分别断言 `required_capabilities(surface) ⊆ registrations(surface)` | G9 绿；菜单/sessions 从各自注册集派生 |

## 7. 共享骨架塌缩清单（M1/M2 的工程面）

以复制点编号引用：

- **C（优先，先做）**：Rust `canonical_audit.rs` 共享投影。三份 dispatcher 的差异
  实测只有一行 degrade 参数，塌缩后 `build_<harness>_evidence` 只负责"适配器 →
  CanonicalSession"，求值统一走共享函数。**Python 的 DSH 绕行路径一并并入**——
  Python 侧从此四家同构（DSH 是唯一不共享的，这是 v0.5 §14.4 遗留的历史不对称）。
  （**新增交付（R1）：Python 侧新建 DSH canonical 适配器模块 `dsh_evidence.py`**
  ——自 `behavior.py` 的直判路径拆出、镜像 Rust `dsh_evidence.rs` 的 canonical
  构造；test_classification 家族清单与 `__init__.py` 同步。不建它，G3 的 dsh
  Python 行永远红。）
- **A/B（M2）**：执行环境级 unmeasured 声明从行 derive；完整信号序上收为共享
  Canonical Schema，适配器不保留 per-harness `ALL_SIGNALS`。语义："我能 bump 什么"
  由 derive 代码与会话 coverage 表达，执行环境级 unmeasured 全部来自行；shape/会话级
  缺席留在适配器按 shape 的解析分支——现 is_unavailable 表全是执行环境级，删之无损
  （§5.2 双层规则）。
- **D/E（M2 伴随）**：序列化与 coverage 骨架共享——跟 C 同一批文件的同一次重构。
- **F/G（M3，触 r2a_store.rs，与并行流无交集但量大）**：store 构造器骨架 + 行驱动
  的 store 集合。

顺序约束：C 不碰任何并行流打开的文件（claude_session/workbuddy_session/
codex_session_audit 均不在 git status 修改清单）；A/B 触碰 `workbuddy_evidence.rs`
（core，**并行流已修改**）→ M2 的 workbuddy 部分排在该流合入后（§11 拆分 M2a/M2b）。

## 8. 完整性守卫测试设计

执行环境集合先按仓库的**两个核心方向**与 session 分析的**两种形态**定位（R1 修订——
旧 G2 把运行时注册表与静态命令面清单当同一集合要求全集相等，从第一天就红）：

- **方向轴**：`skill 分析`（`skills/` 体检，对象 = SKILL.md 安装语料/触发数据）与
  `session 分析`（对象 = 执行环境会话证据与成本）是两个核心方向。session 分析又分两种
  **形态**：**静态形态**——scan/CLI 一次性批量读落盘证据（`adapters/*_session.py`
  会话读取、probe、runtime-json、codex-cost 静态 fold、claude/workbuddy 的 CLI
  session audit 等；契约文档 `HARNESS_ADAPTER_CONTRACT.md`）；**runtime 形态**——
  增量/常驻（canonical 管线、state 链、watcher、claude-sync ledger、menubar、
  dsh-client 投影；契约文档 `RUNTIME_EVIDENCE_CONTRACT.md`）。scan 命令同时承载
  方向 A 全部与方向 B 的静态形态；agent/ + core 承载方向 B 的两种形态。本节三组
  集合只属于**方向 B（session 分析）**——skill 分析没有执行环境注册表，它只有
  scan 的跨执行环境安装发现面（见 ScanCliHarnessChoices 的 hermes/openclaw）。
- `RuntimeHarnessIds = {dsh, codex, claude-code, workbuddy}`：core `HARNESSES` 行 id（唯一
  真相源；语义 = session 分析 **runtime 形态**的执行环境——REC §13 矩阵的四列）。
- `ScanCliHarnessChoices`（R1 曾名 ScannerHarnessChoices/StaticHarnessChoices）：历史 scan
  命令面全局 `--harness` 的
  7 值清单（`all`/`claude-code`/`codex`/`openclaw`/`hermes`/`workbuddy`/`dsh`——
  `cli.py:658`、`cli.py:986`、`main.rs:164`、`test_cli_matrix.py:51` 四处硬编码同一
  份）。它是同时承载 skill 安装发现与部分 session 静态分析的**历史混合 CLI 集**，
  不是纯 session 执行环境集合；hermes/openclaw 当前只有安装/配置发现能力。与 runtime
  集重叠的四个名字可参与 session 分析，但不得据此推导其 runtime 能力。
- `PseudoChoices = {all}`：跨执行环境聚合伪值，**绝不进 HarnessProfile**。

守卫断言按集合关系写（G2），不是全集相等。今天成立、但不强求为不变量的关系：
`RuntimeHarnessIds ⊆ (ScanCliHarnessChoices \ PseudoChoices)` 只是今日现状，不作为永久
不变量——将来可能出现只上 runtime 而不进入历史 scan 命令面的执行环境。

新增 `tests/test_harness_contract.py`（Python 侧，延续 test_classification 的显式
集合风格）+ Rust 侧对应 `#[cfg(test)]`。守卫清单（编号 G1–G10）：

- **G1 双语言注册表 parity**：新增 CLI 表面 `agent-vitals harnesses --json`（§6/§11-M0），
  `test_cli_matrix.both()` 字节对比 Python/Rust 输出（行、字段、顺序全等）。
- **G2 三集分离与清单互锁**：(a) `HARNESSES` 行 ids == `RuntimeHarnessIds`（精确枚举，
  双向）；(b) 静态形态命令面四处硬编码清单彼此相等（把现在无人守的四处一致性钉
  住），且清单内容 == `ScanCliHarnessChoices`（写死在测试里当基准）；(c)
  `PseudoChoices` ∩ 行 = ∅（`all` 绝不进注册表）；(d) scan CLI 是历史混合命令面，
  与 runtime 注册表只比较明确重叠的执行环境名，不从一方推导另一方能力；纪律只有“行里
  不出现伪值与纯安装发现执行环境”（由 (a) 的精确枚举保证）。
- **G3 行 × 镜像 × 文件存在**：对每个运行时 id 按**显式语言支持矩阵**断言存在的
  证据模块（执行环境→`<id>_evidence.rs` ↔ `<id>_evidence.py` 对表；**DSH 的 Python 侧
  在 M1 建成 `dsh_evidence.py` 之前登记为显式缺口** "pending M1"，建成后改为存在
  断言）、适配器/fixture 语料存在。
- **G4 降级穷举**：行上全部 `DegradedRule` × 三态输入，断言只发生
  MeasuredZero→Unavailable，Python 镜像同断言（§5.3 条款 1 的机械化）。
- **G5 §13 矩阵对账**：手写期望表（从 `RUNTIME_EVIDENCE_CONTRACT.md` §13 结构性
  列**人工**派生、checked-in 成测试数据——禁止从行生成，它和行互为独立 oracle）
  vs 行 unmeasured，双向集合相等；矩阵外信号按执行环境分别列期望；workbuddy Usage（※ 未
  复核 vs unavailable）作为**显式偏差登记项**存在——没有注记的偏差过不了。
  **分歧处理流程**：行与期望表分歧 = 行为变更，两侧同改并过 golden；§13 文档与
  期望表分歧 = 契约变更，先改文档（注明"结构性列已由 HARNESSES 派生"的交叉引用）再
  动表——不允许"为过测试顺手改两份"而不留记录。
- **G6 合成会话不变量**：对每个适配器喂一条"raw 事件试图 bump 行声明 unmeasured
  的信号"的合成会话 → 产出仍是 unavailable/零覆盖（消费方 derive 的行为级验证，
  不依赖源码扫描）。
- **G7 展示层一致性**：托盘行/`overview.rs` 兜底行/sessFilter 与**注册集派生**的
  期望集合一致（Rust 侧单测 + jsdom，见 §6 表格）。
- **G8 源码自扫描**（§5.3 条款 5 的机械形式）：沿用 `evidence.rs` §12 的先例，对
  `*_evidence.rs/.py` 做模式扫描，抓 per-harness unmeasured 字面量表残留——不是主
  验证（G6 才是），是防回退的廉价哨兵。
- **G9 按 surface 的需求 ⊆ 注册**：先为 `cli.sessions`、`tauri.sessions`、
  `tauri.menubar-cost` 等消费表面显式列出 `required_capabilities(surface)`，再分别
  断言它是该表面 `HarnessRuntimeRegistration` 的子集。core 不碰文件系统实现；一个
  二进制不消费某项能力时不要求注册，避免把 CLI 与 Tauri 强制做成同构产品（§5.1bis）。
- **G10 计价分辨率**（§5.3 条款 7 的机械形式，**自 v0.6 起带显式缺口登记**；判据
  经 R3 修订）：断言**没有任何时变卡经下界读法被计价**。
  - **时变卡集**（机械推导，扫 `pricing.json` 的 `{off_peak, peak}` 形状）：今天
    三张 = `providers.deepseek-official.deepseek-v4-flash`、
    `providers.deepseek-official.deepseek-v4-pro`、
    `providers.shengsuanyun.deepseek-v4-pro`。catalog 平费率卡与 M3 档位卡不在集内。
  - **判据（钉计价读法，不钉 schema 键）**：对每张时变卡，喂给每个计价入口一份该卡
    的合成用量，断言结果 **≠ 全 `off_peak` 单价 × 用量**——即该入口没有落进
    `flat_rate` 的 `/{key}/off_peak` 兜底。这是**行为级**断言，不依赖视图长什么形状：
    DSH 的 `peak_*` 子桶、将来任何别的保真形态都自然通过，缺分辨率的入口自然红。
    廉价哨兵补一条源码扫描（G8 风格）：`flat_rate`/`_flat_rate` 的 off_peak 兜底
    分支若被时变卡命中、而调用点不在缺口清单里 → 红。
  - **为什么不写成 `时变卡集 × 计价视图集` 的叉积（R3 撤回原判据）**：叉积里有真空
    格——codex 的折叠读的是自家 `codex_pricing.json`（`src/agent/codex_cost.rs:39`
    `include_str!` 的独立 USD 表），结构上永远碰不到 deepseek 卡；而"某视图会不会
    见到某张卡"取决于它实际遇到哪些 model，**推不出来**（`pricing.json` 与注册表行
    都不含这个关系，它是运行期事实）。钉读取函数就不需要这个关系：见不到该卡的入口
    根本不触发断言。原判据「时间键无 hour → 红」还会**误红 DSH**（其日桶无 hour 键
    却计价正确，§5.3 条款 7）——两个方向都错，故整体替换。
  - **注册表在这里只做排除，不做枚举**：按 usage/session 事实判定为
    `pricing_basis=harness-billed` 的记录不进入价目卡折算，条款 7 不适用；不按
    HarnessProfile 排除整个执行环境。

  **缺口登记（方案 b，沿用 G3 "pending M1" 惯例；R3 补齐为两条；2026-09-03
  v0.6.x 前置热修落地后结清，见下）**：本守卫落 v0.6 时以下**两个计价入口即刻
  为红**，且必须**同批**修——`price_claude_map` 的 doc 注释钉死「两面的钱必须
  同源」，只修一个会让两面分叉：

  | 缺口条目（已结清） | 计价入口 | 命中的时变卡 |
  |---|---|---|
  | ~~`claude-ledger-day: pending v0.7`~~ | `cost.rs::claude_day_cost` → `price_claude_map` → `price_claude_model` → `priced_field` | deepseek-official flash/pro **与 shengsuanyun pro**——`resolve_card_catalog` 第二段遍历顶层 `providers`，三张卡命中的是同一处兜底 |
  | ~~`claude-session: pending v0.7`~~ | `cost.rs::claude_session_cost` → 同一条链 | 同上 |

  （Python 侧 `cost.py::_priced_field` 是同形镜像，两条缺口双语言各结清一次。）

  **2026-09-03 结清（v0.6.x 前置热修，非 v0.7）**：让它们转绿的实现被重新定级为
  **v0.6.x**（不是原计划的 v0.7）——`claude_cost.rs`/`.py` 的 `tail_days` 改为
  永不清空、逐行真实 ts 精确标记 `peak_*` 子桶，`cost-state` 的 `baseline` 改为
  纯粹的**对账锚点**而非日面转储；这一步是修复"归日转正"（day-misattribution）
  bug 的直接副产品，日形状因此原生带上峰谷分辨率，不需要等到 v0.7 的
  UsageFact/迁移表落地。两个入口现分别改走 `peak_resolved` 参数：
  `claude_day_cost`（`peak_resolved=true`，ledger 日桶原生带 `peak_*` 子桶）
  已转硬断言（`pricing_basis="catalog"`，不是估算）；`claude_session_cost`
  （`peak_resolved=false`，cost-state 会话累计口径结构性没有逐行 ts、永远给不出
  峰谷分辨率）如实报 `pricing_basis="partial"`——这不是残留缺口，是这个入口
  能达到的诚实上限。`crates/agent-vitals-core/tests/harness_contract.rs` 与
  `tests/test_harness_contract.py` 的 `G10PricingResolutionTests` 已从"验证仍卡在
  下界"翻转为"验证已经峰谷正确 / 已经诚实降级"两条硬断言，缺口清单闭集现在
  为**空**——不再需要缺口登记这个机制本身对这两条目生效，但机制保留给未来任何
  新计价入口静默复用下界读法的情形。所有 15 个 golden 快照字节不变
  （`claude-sync`/`claude-cost` 命令不在 golden 覆盖范围内）。

## 9. 新执行环境接入流程（playbook）

「避免遗漏环节」的直接答案——接入 = 一次注册表迭代，按序执行，G2/G3 在每一步
拦住漏项：

1. **拿真实语料**：建 `fixtures/<harness>/` + builder 脚本（照 codex/claude/workbuddy
   的 fixture 惯例），不许用手工编的假数据立项。
2. **写证据适配器**：抄形状最接近的模板（locate→shape→extract→derive→coverage），
   但**不抄 is_unavailable 表**——unmeasured 留给注册表，适配器只表达它能 bump 的
   信号；extract 从第一天遵守哨兵条款（§5.3 条款 4）。
3. **注册**：`HARNESSES` 加一行（id/display/unmeasured/degraded/fold/store，
   每条 unmeasured 带出处）。未知执行环境在注册前所有查询 no-op，注册后所有守卫开始
   对它生效。
4. **接线清单**（守卫会红的每一项）：core `lib.rs` pub mod ↔ Python
   `__init__.py` import+`_FLAT_MODULE_NAMES`；test_classification 家族集合；
   `cli.py` / `main.rs` 的 choices；`test_cli_matrix.py` HARNESSES；`r2a_store.rs`
   store 注册（仅当 `session_store: true`）；前端 sessFilter（仅当 store）；展示
   短名（从行自动获得）。
5. **求值零新代码**：canonical 共享投影（§7-C）不按执行环境分支——适配器产出
   CanonicalSession 即完成，降级自动从行生效。若共享求值器要开特例，那是回归。
6. **钉语义真值**：真值表单测上 fixture（行为层 + timeline 形状，照 codex 的
   `test_populated_timelines_are_native_and_structured` 风格）+ characterization
   预算 ≥ 每执行环境 3 条（把 §1.2 的深度不均写进预算约束，不许新执行环境以 1 条过门）。
7. **跑全套**：`python3 -m unittest discover tests` + golden_runner +
   `cargo test` + clippy + differential 全绿才算接入完成。

**必选项与可选面的分界**：必选 = 1–7 全部（行为/成本审计可运行、诚实降级、守卫
绿）；可选 = 托盘行、日/月折叠、SessionStore（行字段先声明为 None/false，展示层
显式缺席是合法状态）。

## 10. 文档关系与路线图修订

- **v0.5 §22 修订**：`VITALS_CORE_V0_5_IMPLEMENTATION_SPEC.md` §22 预留 v0.6 =
  通用 State / deterministic diff，并写明"路线由真实需求决定"。本次行使该决定权：
  v0.6 = 执行环境接入契约；State/diff 继续挂起（无真实需求驱动前不动）。修订以
  v0.6 spec 落地方案获批为准，两文档互引。
- **RUNTIME_EVIDENCE_CONTRACT.md §13/§17**：§13 矩阵仍是叙事权威，其结构性
  unavailable 列由 `HARNESSES` 行派生后，§13 加一句交叉引用；§17 的 **P4.5
  （schema-drift 哨兵，❌ 未完成）** 被本方案 §5.3 条款 4 承接——P4.5 从"孤立未办
  项"升级为"契约条款 + 后续 rollout"。§17.1 的 coverage-matrix golden 以 G5 的
  期望表形态落地（§8）。
- **HARNESS_ADAPTER_CONTRACT.md**：边界不变（静态形态 vs runtime 形态），本方案零触碰。
- **MENUBAR_MULTIHARNESS_NAVIGATION_SPEC.md**：三行固定枚举的硬编码处随 §6 改为
  派生后，规范加一句"行集来自 core 注册表 fold!=None"。

## 11. 分阶段落地

并行工作流约束先行声明：claude-sync/cost 流已**部分合入**（868f1a7/9464d30，含
src-tauri menubar 改动）；工作区**当前仍打开**：core `workbuddy_evidence.rs`、
`workbuddy_evidence.py`、workbuddy fixtures、相关 tests 与 docs。**落地顺序以不
触碰打开中的并行流文件为硬约束**；M2b（及并行流继续合入后与 M0–M3 撞车的任何
一步）以工作区干净为闸。

| 里程碑 | 内容 | 触碰文件 | 验收 |
|---|---|---|---|
| **M0 注册表骨架**（additive） | `HarnessProfile`/`DegradedRule`/`FoldOutput`/`HARNESSES` 四行入 core `harness_capability.rs`；共享 Canonical Signal 全序入 evidence/schema 层；degrade 改行查找；Python 镜像同步行集；双语言来源策略成文（§5.1bis）；`harnesses --json` surface 先行，G1 parity 在此落地 | core `harness_capability.rs`、`evidence.rs`、`harness_capability.py`、Python schema 常量、`cli.py`/`main.rs` 的 harnesses 子命令（均不在打开清单） | `cargo test` + Python 套件全绿，**golden 字节零漂移**（行为不变是硬要求）；G1 绿 |
| **M1 共享投影塌缩** | Rust `canonical_audit` 共享求值器（镜像 `canonical_audit.py`）；三 dispatcher 调共享 fn；**Python 侧新建 `dsh_evidence.py`**（自 `behavior.py` 直判路径拆出 DSH canonical 适配器、镜像 `dsh_evidence.rs`；test_classification 家族清单与 `__init__.py` 同步）——DSH Python 从此与三家同构，G3 的 dsh 缺口在此关闭 | `src/agent/` dispatcher 三文件、core/binary 新模块、`behavior.py` 拆出 + 新 `dsh_evidence.py` | golden 15 例字节零漂移 + differential；DSH `behavior` 输出不变；**G3 dsh 行转绿** |
| **M2a evidence derive（干净侧）** | 按双层缺席规则（§5.2）：dsh/codex/claude-code 适配器的**执行环境级** unmeasured 改从行读，per-harness `ALL_SIGNALS` 改用 M0 共享 Canonical Signal 全序，shape/会话级缺席留在解析分支不动；D/E 骨架共享 | `dsh_evidence.rs`、`codex_evidence.rs`、`claude_code_evidence.rs` + Python 镜像（`claude_evidence.py`/`codex_evidence.py`/新 `dsh_evidence.py`） | G6 合成会话不变量绿；golden 零漂移 |
| **M2b evidence derive（workbuddy 侧）** | 同 M2a 但 workbuddy —— **闸：`workbuddy_evidence.rs/.py` 仍在并行流工作区打开，必须等其合入** | `workbuddy_evidence.rs`、`workbuddy_evidence.py` | G6 绿；golden 零漂移 |
| **M3 守卫 + surface** | 守卫全量落地：三集分离 G2、语言支持矩阵 G3、矩阵对账 G5、源码自扫描 G8、按 surface 的需求⊆注册 G9、**计价分辨率 G10（带 `"pending v0.7"` 缺口登记，方案 b）**（§8）；binary/Tauri 侧建 `HarnessRuntimeRegistration`（§5.1bis）；托盘/overview/sessFilter 从注册集派生 | `tests/test_harness_contract.py`、binary 注册新模块、`r2a_store.rs`、src-tauri（其 menubar 改动已随 868f1a7 合入；并行流继续 commit 若再触碰则排后） | G1–G10 全绿（G10 以缺口清单闭集断言的形态绿，缺口条目 = `claude-ledger-day` 与 `claude-session` 两条，双语言各一次）；托盘三行与今日逐像素一致（快照）；claude-code 进 sessFilter |
| **M4 workbuddy 折叠 demo（可选演练）** | 走完整契约迭代：行字段 `fold: None → Some(HarnessBillTotals)`；当前适配器继续累计 `used`/`credit_json` 的 harness-billed 证据，绝不冒充逐模型 token 重计价；注册集补 fold reader，守卫红→绿 | workbuddy 折叠新面 | 托盘出现第四行成本；全程不碰 DSH state 链与 pricing.json |

每个里程碑独立可合入（M0 先行合入不阻塞并行流）；M2b（及并行流继续合入后与
M0–M3 撞车的任何步骤）以工作区干净为闸。**任何里程碑的验收若出现字节漂移，回退
该里程碑而不是 --update golden。**

**落地记录（2026-09-02）**：**M0 已完成**——`HarnessProfile`/`DegradedRule`/
`FoldOutput`/`HARNESSES` 四行落 core `harness_capability.rs`，Python 镜像
`harness_capability.py` 同步同一份行集（`unmeasured_signals` 手工镜像各适配器现有
`is_unavailable`/`_UNAVAILABLE_SIGNALS`，dsh 一份镜像 `dsh_evidence.rs` 内联声明
——M2 才让适配器改从行 derive，M0 本身行为零变化）；`degrade_rule_outcomes` 从
match 臂改成行查找（现有 4 个单测原样通过）；新增 `harnesses --json`/`harnesses` 子命令
（Rust `main.rs::Cmd::Harnesses` + Python `cli.py`），`tests/test_cli_matrix.py` 新增
`test_harnesses_json_byte_parity`/`test_harnesses_human_format_byte_parity` 落地 G1；
`cargo test --release`（732 用例）、`cargo clippy --release --all-targets -- -D
warnings`、`AGENT_VITALS_BIN=… python3 -m unittest discover tests`（1015 用例，
全差分）、`tests/golden_runner.py`（15 例）全绿，golden 字节零漂移，符合 M0 验收
纪律。

**M1 已完成**（Rust 侧 + Python 侧）：Rust 新增 core
`canonical_audit::audit_projection(canonical, harness_id)`，三份 dispatcher
（`claude_session.rs`/`workbuddy_session.rs`/`codex_session_audit.rs`）的
`<harness>_audit_projection` 拷贝塌缩成薄封装。Python 侧新建
`dsh_evidence.py`（镜像 `dsh_evidence.rs::populate_timelines`，`Coords` 等复用
`behavior.py` 现成实现），`behavior.py::audit_session_log` 改经
`dsh_evidence.build_dsh_canonical` → `canonical_audit.audit_projection` 求值
SV601–614，不再自拼 `match_behavior_gated`+`match_trajectory`+
`trajectory_rule_outcomes` 三路（三者本身连同 `match_behavior` 原样保留，供
各自单测/characterization pin/公共 API 使用）——DSH Python 从此与另外三家
同构，G3 的 dsh Python 侧缺口关闭。切换前先对 `fixtures/dsh/` 全部 5 份真实
语料做等价性检查（旧三路拼接 vs 新路径逐字节相等）才动 `audit_session_log`。
两批改动分别验证：`cargo test --release`（core 455 + binary 279）、
`cargo clippy --release --all-targets -D warnings` 零警告、
`AGENT_VITALS_BIN=… python3 -m unittest discover tests`（1015 例全差分）、
`tests/golden_runner.py`（15 例）均字节零漂移。

**M2a 已完成**：`claude_code_evidence.rs`/`codex_evidence.rs` 的 `is_unavailable`
改查 `harness_capability::harness_profile(harness_id).unmeasured_signals`（值原样从原
字面量表搬过去）；`ALL_SIGNALS` 改指向 core 新增的共享 `Signal::ALL`（复制点
B）；`dsh_evidence.rs::derive_coverage` 末尾五行显式置零改循环
`harness_profile("dsh").unmeasured_signals`；Python 镜像 `claude_evidence.py`/
`codex_evidence.py` 的 `_UNAVAILABLE_SIGNALS` 同样改派生。**workbuddy 侧
（M2b）仍以并行流工作区干净为闸**——`workbuddy_evidence.rs/.py` 与
`fixtures/workbuddy/` 截至本次记录（2026-09-03）仍持续处于未提交状态，未见
清空迹象，本轮全程未触碰。

**M3 已全部完成（G1–G10）**：
- G2（三集分离）/G3（语言支持矩阵，DSH Python "pending M1" 缺口在 M1 关闭后
  降级为存在断言）/G4（降级穷举，行驱动）/G5（§13 矩阵人工对账 + 4 处显式
  偏差登记）/G6（合成会话不变量，dsh/codex/claude-code 三家）/G8（源码自
  扫描）/G10（计价分辨率，行为断言 + 缺口登记闭集）：Python
  `tests/test_harness_contract.py`（19 例）+ Rust
  `crates/agent-vitals-core/tests/harness_contract.rs`（11 例）全绿。**2026-09-03
  追记**：v0.6.x 前置热修（见 §8 G10 一节末尾）把 G10 的两条缺口条目从
  `"pending v0.7"` 结清为硬断言，替换测试从"验证仍卡在下界"翻转为"验证已经
  峰谷正确 / 已经诚实降级"，例数各 +1（Python 20 例、Rust 12 例）；`cargo
  test --release`/clippy/差分套件/golden_runner 全绿，无字节漂移。
- G7（展示层一致性）：src-tauri `overview.rs::HarnessesSnapshot::unavailable()`
  （托盘兜底行）从 `HARNESSES` 的 `fold != None` 派生；`lib.rs::harness_display_name`
  从 `HARNESSES` 的 `display` 派生（副作用：WorkBuddy 现在也能正确解析出显示名，
  此前的本地字面量表没收它是因为它没有托盘行——展示名与折叠能力是两件事）；
  `workbench.html` 的 sessFilter chips（实测 all/claude-code/dsh/codex 四个，
  claude-code 缺席问题已被并行 claude-sync 流 868f1a7 补上，本 spec 此前的
  记录滞后于代码）与 `session_store` 执行环境集合一致性由
  `G7SessFilterTests` 源码自扫描钉住。
- G9（按 surface 的需求 ⊆ 注册）：新建 `src/agent/harness_runtime_registration.rs`，
  登记 `cli.sessions` surface 的 `session_store` 与 `fold` 两个维度——核实
  `sessions_navigation` 对 dsh/codex/claude-code 当日 token 折叠（state 链/
  全量 rollout/ledger）与 `HARNESSES.fold` 精确对应后直接登记"接了/没接"这个
  事实，**没有**为三条互不相同的折叠路径发明共享 trait/循环（§2.2 明文
  拒绝的假抽象）。`tauri.sessions`/`tauri.menubar-cost` 核实后确认**不需要
  独立登记**：`src-tauri/src/store.rs` 的 `sessions_list`/`sessions_read`/
  `sessions_findings` 是纯 IPC 透传（spawn CLI 二进制、原样转发输出，不按
  执行环境分支任何逻辑），Tauri 不持有第二份 SessionStore/折叠实现，执行环境覆盖面
  恒等于本二进制已登记的 `cli.sessions`——没有独立能力，也就没有独立注册的
  必要。G9 至此没有遗留的开放 surface。

**M4**（workbuddy 折叠 demo，spec 原文标注"可选演练"）依赖 M2b 的 workbuddy
侧先落地，未开始。

每步验证：`cargo test --release`、`cargo clippy --release --all-targets -D
warnings` 零警告（含 src-tauri 独立 workspace）、
`AGENT_VITALS_BIN=… python3 -m unittest discover tests` 全差分、
`tests/golden_runner.py` 全部字节零漂移，逐 commit 未破。

## 12. Definition of Done

1. Rust/Python 的 `HARNESSES` 四行齐全，分别是本语言内部唯一的 per-harness 能力声明；
   G1 parity 绿（双语言字节相等）。
2. G1–G10 全绿——含三集分离（G2：行 == RuntimeHarnessIds、静态命令面四处清单互锁、
   `all` 不进注册表）、语言支持矩阵（G3）、按 surface 的需求⊆注册（G9）、
   计价分辨率（G10：
   三张时变卡在**任何**计价入口都不走下界读法；`claude-ledger-day` 与
   `claude-session` 两条曾以显式缺口 `"pending v0.7"` 登记，**2026-09-03
   v0.6.x 前置热修已结清**——`claude_day_cost` 转硬断言
   `pricing_basis="catalog"`，`claude_session_cost` 转硬断言
   `pricing_basis="partial"`（结构性没有逐行 ts 的诚实上限，非残留缺口）；
   缺口清单闭集为空，机制保留给未来入口）。
3. Rust/Python 两侧无 per-harness unmeasured 字面量表残留（G8 源码自扫描过 + G6
   行为验证过）。
4. 三份 dispatcher 组装消失，`canonical_audit` 共享求值器双侧存在；DSH Python
   路径并入；golden 15 例 + differential 字节零漂移。
5. 托盘行/sessFilter/sessions 表面从注册集派生（§5.1bis）；M4 若做，workbuddy
   行以完整契约路径出现（声明 → 实现 → 守卫转绿），不出现任何硬编码第四行。
6. 接入 playbook（§9）经一次演练修订过（M4 即演练）；P4.5 条款在 REC §17 状态
   更新为"已入契约，rollout 进行中"。
7. 全套测试绿：`python3 -m unittest discover tests`、`cargo test`、clippy -D
   warnings、differential、golden_runner。
8. 无 SKILL.md/README/pricing.json/timeline.js 改动；信封 v1 不变。**G10 只读
   `pricing.json` 推导时变卡集，不改它**——价目是业务数据，条款 7 约束的是消费
   它的视图分辨率，不是卡本身。
9. §5.3 条款 7 的缺口登记有到期归属：两条 `"pending v0.7"` 条目**已于
   2026-09-03 随 v0.6.x 前置热修同批结清**（`peak_*` 子桶落地 + 两入口改峰谷
   读法 → 删条目 → 改硬断言），未出现半修（两面同批切换、同源纪律未破）——
   提前于原计划的 v0.7 窗口，因为修复它所需的日形状变更是"归日转正"
   bug-fix 的直接副产品，不需要等待 UsageFact 迁移。

## 13. 风险与失败条件

- **M1 字节漂移**：塌缩改的是求值主路径，风险最高。失败条件 = 任何 golden 字节
  差——回退而不是改 golden。防护：M1 单独合入、差分 job 盯死。
- **注册表过度声明**（把 derive/fidelity/shape 塞进行）：衰退成会漂移的文档。防护：
  §5.2 的"不回答"清单进模块 doc + 评审检查项。
- **守卫变文档**（期望表只镜像代码、失去独立性）：G5 的期望表必须手写自 §13 并
  checked-in，禁止用代码生成——它和行互相独立，对不齐才是它的价值。workbuddy
  Usage ※ 偏差登记项是它存在的第一个理由。
- **并行流合入冲突**：M2b 以工作区干净为闸；M0/M1/M2a 先行不碰打开中的并行文件
  （`harness_capability.rs` 不在其打开清单，目前无冲突面）。并行流继续合入若与
  M0–M3 撞同一文件，以合入方为准重排。
- **新执行环境以"没注册也跑得动"绕过契约**：unknown harness no-op 是查询路径的兼容口，
  注册路径无行 = surface 进不去（§5.3 条款 2）——playbook 步骤 3 若跳过，G2/G3
  在接线处红。

## 14. 审核处理记录（R1，2026-09-02）

外部审核轮次 R1 的逐条裁决与落点。裁决分三档：**成立**（已修订）/ **部分成立**
（修订措辞或补机制）/ **不采纳**（有理由，见下）。

| # | 意见 | 裁决 | 修订落点 |
|---|---|---|---|
| 1 | [P0] G2 比较了两个不同执行环境集合（运行时 4 家 vs 扫描层 7 值含 all/openclaw/hermes） | **成立**——已实证：`test_cli_matrix.py:51`/`cli.py:658/986`/`main.rs:164` 是全局 `--harness`（"scan every supported harness"），指涉对象与运行时契约不同 | §8 重写：定义 `RuntimeHarnessIds`/`ScannerHarnessChoices`/`PseudoChoices` 三集，G2 只按集合关系断言；`all` 不进注册表。2026-09-02 按「两个核心方向 × session 分析两种形态」轴再改述：ScannerHarnessChoices → `StaticHarnessChoices`（静态形态命令面），两集同属 session 分析方向 |
| 2 | [P1] per-shape 与 M2 矛盾 | **部分成立**——现存 is_unavailable 表全是执行环境级（shape 无关），shape 级缺席本就在解析分支里；但原文"unmeasured 全部来自行"会误导，双层规则必须写清 | §5.1 字段注释 + §5.2 双层缺席规则 + §7/M2a/b 措辞（执行环境级从行、shape 级留解析分支） |
| 3 | [P1] 双语言镜像不是单一真相源 | **部分成立**——"零拷贝"措辞过强；但仓库先例（behavior/usage/cost 双实现 + differential；pricing.json 是**数据**例外且分发上只有它能单源）说明 typed 规则就该走双实现契约，JSON 化丢类型且 Python ClawHub 拿不到 core 文件 | 新增 §5.1bis：双语言 = 双实现契约 + parity；"零拷贝"限定为语言内消费；行集膨胀到不可控再议代码生成 |
| 4 | [P1] fail-closed 无实现机制 | **成立**——`&str` id 拦不住字面量，"编译期"是过度承诺 | §5.3 条款 2：撤回编译期表述，改为行查找返回 Option + G2/G4 断言"守卫期 fail-closed"；RegisteredHarnessId 新类型因信封/存储 string 面改造代价明确否决 |
| 5 | [P1] G3 要求了不存在的 Python DSH 镜像 | **成立**——已实证：agent/ 下无 dsh_evidence.py，`behavior.py:357` 注释自认只镜像 dsh_evidence.rs 四信号 | §8 G3 语言支持矩阵化：dsh Python 侧登记 "pending M1"；M1 新增交付 `dsh_evidence.py`（拆出 + 镜像），合入后转绿 |
| 6 | degraded_rules reason 执行环境级一条盖全部 | **成立** | §5.1 `DegradedRule { code, missing: &[Signal], reason }` 逐条声明；reason 文本沿用常量，仍被 G1 锁步 |
| 7 | session_store bool 证明不了实现 | **部分成立**——声明与实现分层本在 §3 ②，但实现注册的落点没写死 | §5.1bis + §6 新行 + G9：core 行只声明；binary/Tauri 各持 `HarnessRuntimeRegistration`；守卫断言声明 ⊆ 注册 |
| 8 | FoldKind 用实现策略命名（DshState/EventsScan/Ledger） | **成立**——机制会增殖，行里该放产出能力 | §5.1：`FoldKind` → `fold: Option<FoldOutput>`，`FoldOutput { TokenBuckets, HarnessBillTotals }`；机制与函数入口进应用层注册表；§4 表格机制列标注为"当前策略" |
| 9 | HARNESSES 顺序 = UI 排序契约 | **不采纳**加字段——G1 字节 parity 本来就锁数组顺序（协议事实），`sort_order` 只是数组下标的重复事实（新漂移面）；UI 可自行排序/分组 | §6 托盘行注记：行数组顺序 = 默认展示序，不是 UI 契约；Tauri 可本地重排 |
| 10 | G5 手写矩阵与文档矩阵重复事实、无分歧流程 | **成立** | §8 G5 补分歧处理流程：行 vs 期望表 = 行为变更（两侧同改过 golden）；文档 vs 期望表 = 契约变更（先改文档再动表，留记录） |
| 11 | DoD 第 3 条 "G7 源码自扫描" 编号错 | **成立** | 源码自扫描独立成 G8；DoD/§5.3 交叉引用修正 |
| 12 | M4 workbuddy 切 Ledger 语义错（claude Ledger = token 重计价） | **成立** | M4 行改为 `fold: None → Some(HarnessBillTotals)`，billing 保持 HarnessBilled——累计积分账单，不冒充逐模型计价（§5.1 注释同步） |
| 13 | 文档基准 HEAD/测试数易漂移 | **成立**——HEAD 已移（868f1a7/9464d30 合入），44 个测试文件 | 文档头更新状态基准；playbook 删"（352）"；DoD 只留命令不固定数字 |
| 14 | 建议收缩里程碑 | **部分成立**——内容吸收：守卫独立成面（G9/注册集）、集合守卫分层；编号保留 M0–M4 以免全文交叉引用重排 | §0 结论 4、§11 表按 R1 语义重写 |

### R2 修订（2026-09-02）

| # | 意见 | 裁决 | 修订落点 |
|---|---|---|---|
| 1 | [P0] `BillingKind` 绑定 Harness，违反 Harness ≠ BillingSource | **成立** | 从 `HarnessProfile` 删除 `billing`/`BillingKind`；§5.2bis 改为 usage/session 级 `billing_source`、`billing_mode`、`pricing_basis`；WorkBuddy harness-billed 只描述当前证据，不成为永久执行环境人格 |
| 2 | [P1] “全执行环境共同缺席集”与 Codex/Claude Code 已 measured 的 UserPrompts 冲突 | **成立** | §5.1、§5.3、G5 改成按执行环境分别登记矩阵外信号，禁止构造全执行环境共同集 |
| 3 | [P1] G9 要求每个二进制实现全部能力过强 | **成立** | §5.1bis、§6、G9 改为 `required_capabilities(surface) ⊆ registrations(surface)`，CLI/Tauri 可按消费面不同构 |
| 4 | [P2] “core 唯一真相源”仍与双实现契约矛盾 | **成立** | §2/§3/§5.1 统一为“每种语言内部唯一声明源，跨语言 byte-parity” |
| 5 | `ALL_SIGNALS` 应属于 Canonical Schema，而非执行环境人格 | **成立** | M0 上收共享 Signal 全序；M2 删除 per-harness `ALL_SIGNALS`，适配器能力由 derive + coverage 表达 |
| 6 | StaticHarnessChoices 对 hermes/openclaw 的 session 语义牵强 | **成立** | 改名 `ScanCliHarnessChoices`，明确其为混合承载安装发现与部分 session 分析的历史 CLI 集，不从它推导 runtime 能力 |

**本轮修订后仍留的设计决断**（非缺陷，明示待议）：R1 建议"以 checked-in 数据表
生成两侧代码"作为单一真相源的替代方案——因 typed-rule 特性与 Python 分发约束
（§5.1bis）不采纳，若行集膨胀或第三语言出现再复议；"shape 级缺席 = 解析结果"
的表述依赖适配器按 shape 分支的既有事实（Codex 两 shape 是唯一实例），若未来
shape 数增殖、解析结果不再一目了然，升格 per-shape 行（§5.2 已留口）。

**2026-09-02 追加修订（非 R1 轮次）**：数据平面（§5.4）的机制落地独立成 v0.7——验
收纪律互斥（v0.6 字节零漂移 vs 数据重构的受控 `--update`；reflexive update 会让
golden 失去意义）→ §0.6 + §2.3 版本边界拆分表 + v0.7 验收条款；§5.4.1/5.4.2/5.4.4
主体随迁新文档 `docs/VITALS_CORE_V0_7_DATA_PLANE_SPEC.md`，本 spec §5.4 留指针，
§5.4.3（HarnessProfile 列化卡）留守。

**2026-09-02 追加修订之二（计价分辨率轴，非 R1 轮次）**：真机对账
（`docs/CLAUDE_COST_DAY_ATTRIBUTION_ANALYSIS.md`）暴露一类现有守卫**结构上覆盖不到**
的遗漏——托盘 claude 今日 ¥45.40 vs 账单 ¥74.3797，89% 的差额来自 ledger 日桶丢掉
小时后只能全按 `off_peak` 计价。它不是缺信号（行自带 ts）、不是词表漂移、不是声明
缺席，因此条款 1-6 与 G1-G9 无一转红。落点：

- 新增 **§5.3 条款 7（计价分辨率）**——时变卡（`{off_peak, peak}`）计价必须带小时，
  否则报 partial 走哨兵，不得取时间维下界冒充保守；平费率只对平费率卡合法。
  （**"必须带小时"这半句已被下方 R3 修订推翻**——正确的是"必须保住足以峰谷拆分的
  分辨率"，DSH 用 `peak_*` 子桶做到了而没有小时。）
- 新增 **§8 G10** 守卫——`时变卡集 × 计价视图集` 每格断言时间轴含小时，两集皆从
  `pricing.json` 与注册表行机械推导，不靠人工声明。（**判据与叉积形态均已被 R3
  撤回**，见下。）
- **按方案 b 落地**（用户 2026-09-02 裁定）：守卫提前到 v0.6 并对
  `claude-code × deepseek-official` 一格登记显式缺口 `"pending v0.7"`（沿用 G3 的
  "pending M1" 惯例），缺口清单闭集受断言；实现（hour 轴）走 v0.7 窗口后删条目转硬
  断言。选 b 而非"v0.6 只加条款、守卫随 v0.7"的理由：空档期若新接入执行环境，方案 a
  拦不住它再长一份无小时日桶。
- **§0.3 由"四种形态"扩为"五种"**，第五种（读到了但聚合丢分辨率）与前四种正交。
- v0.7 侧同步修订（该 spec §2 时间行、§3 `cost_report` 行、§5 验收、§7 记录）：
  原 §2 时间行写「基线按会话 startTime 归日近似**与 claude_cost 同款**」——等于把
  本次证伪的近似写进统一事实行契约，必须改。

**2026-09-02 追加修订之三（R3：G10 判据与缺口面，对"之二"的更正）**：对"之二"的
落地面做代码级复核，发现 G10 的判据与缺口登记两处都写错，落地前更正（条款 7 的
**意图**不变，错的是它的机械形式与适用面）：

| # | 问题 | 证据 | 修订落点 |
|---|---|---|---|
| 1 | [P0] 判据「时间键无 hour → 红」会**误红 DSH**——全仓唯一计价正确的那条路 | DSH 日桶**没有** hour 键：`usage.rs::add_buckets` 在 fold 时按 `is_peak_slot` 预拆 `peak_*` 子桶，`cost.rs::bucket_price`（:145-157）用「全量 − peak_*」还原空闲份额分别计价。分辨率靠折叠时预拆保住，不靠时间轴 | §5.3 条款 7 增「"保住分辨率" ≠ "留 hour 键"」段；§8 G10 判据整体换成**计价读法的行为级断言**（时变卡合成用量的结果 ≠ 全 off_peak 价）+ G8 风格源码哨兵 |
| 2 | [P0 连带] v0.7 把转绿项写成"ledger 日桶加 hour 桶" = 造第四种日形状 | DSH 的 `peak_*` 日形状已被 `priced_day`/`token_by_date_model` 全线消费并有测试 | §2.3 拆分表末行改为「加 `peak_*` 子桶，照 DSH 既有日形状」，并注明 hour 若真要选须在 v0.7 §5 写明理由；v0.7 §0.1bis/§2/§3/§5 同步 |
| 3 | [P1] 叉积 `时变卡集 × 计价视图集` 有真空格，且适用关系不可静态推导 | codex 折叠读自家 `codex_pricing.json`（`src/agent/codex_cost.rs:39` include_str 的独立 USD 表），永远碰不到 deepseek 卡；"哪个视图见得到哪张卡"取决于运行期遇到的 model | §8 G10 撤回叉积形态——钉读取函数则不需要这个关系 |
| 4 | [P1] 缺口只登记一格，漏了 claude 的**会话面**与 **shengsuanyun 卡** | `flat_rate` 的兜底在 `price_claude_model`（`cost.rs:756-759`），被 `claude_day_cost` 与 `claude_session_cost` 共用，`price_claude_map` doc 注释自钉「两面同源」；`resolve_card_catalog`（:684-694）第二段遍历顶层 providers，shengsuanyun 的 deepseek-v4-pro 同样是 `{off_peak, peak}` 卡、走同一兜底 | §5.3 条款 7 增「适用面按计价入口算」段；§8 G10 缺口表拆成 `claude-ledger-day` / `claude-session` 两条（双语言各一次）并注明必须同批修；§11-M3、§12 DoD 2/9 同步 |

**本轮未处理（P2，另计）**：§4 表把 claude 的 pricing 来源写成 `catalog_2026_09`
（实际 `resolve_card_catalog` 是两段搜索，catalog 无 deepseek，claude 的 deepseek
用量落在**顶层 providers**）；§5.1 的 Python 镜像路径实际是
`scripts/agent_vitals/agent/harness_capability.py`；§1.1 复制点 A/B 把 dsh 也算作一份
（`dsh_evidence.rs` 既无 `is_unavailable` 也无 `ALL_SIGNALS`，份数是 3 不是 4）；
条款 7 排除 M3 档位卡的理由写错了——`first_tier` 取首档与 off_peak 兜底是同一动作，
真正的差别是前者在输出留了 `tier` 标签而后者 `pricing_basis` 恒 `"catalog"`、与真
平费率卡不可区分。

**2026-09-03 追加修订之四（R4：G10 缺口结清，落点重定级为 v0.6.x）**：R3 登记
的两条缺口（`claude-ledger-day`/`claude-session` 的 `"pending v0.7"`）在
`docs/CLAUDE_COST_DAY_ATTRIBUTION_ANALYSIS.md` 的"归日转正"根因排查后，与那个
bug 共享同一处修复点——`claude_cost.rs`/`.py` 的 `tail_days` 从"遇 cost-state
即清空、baseline 转储成单日无分辨率数字"改为"永不清空、逐行真实 ts 精确标记
`peak_*` 子桶，baseline 降级为对账锚点"，日形状因此**原生**带上峰谷分辨率，
无需等待 v0.7 的 UsageFact/迁移表：

- 落点重定级：R3 曾把转绿项记在 v0.7（"ledger 日桶加 `peak_*` 子桶"属 §2.3 的
  受评审 `--update` 窗口），实际落地证明这一步是 day-misattribution 修复的直接
  副产品，**提前到 v0.6.x**（一个新引入的、介于冻结 v0.6 与完整 v0.7 数据平面
  迁移之间的热修版本层级）完成，不依赖 v0.7 的任何一张迁移表。
- `claude_day_cost`（`peak_resolved=true`）转硬断言：三张时变卡全落峰值/全落
  空闲两种合成用量都按真实单价算，`pricing_basis="catalog"`。
- `claude_session_cost`（`peak_resolved=false`）转硬断言，但断言的是**诚实
  降级**而非"精确"：cost-state 会话累计口径结构性没有逐行 ts，时变卡永远给
  不出峰谷分辨率，如实报 `pricing_basis="partial"`（数值仍是 off_peak 下界——
  唯一在"没有更多信息"时站得住的算法，但标注不再冒充 `"catalog"`）。
- §8 G10 缺口表两条目从 `"pending v0.7"` 改标删除线、`crates/agent-vitals-core/
  tests/harness_contract.rs` 与 `tests/test_harness_contract.py::G10PricingResolutionTests`
  的对应测试从"验证仍卡在下界"翻转为上述两条硬断言（例数从 11/19 增至
  12/20）；缺口清单闭集现为空，机制保留给未来任何新入口静默复用下界读法。
- 无 schema 变更需要 `--update`：`claude-fold.json` 新增
  `schema_version`（=2）触发一次性全量重折（`tail_days` 的历史分辨率已在旧
  算法下永久丢失，不可迁移，只能从源 JSONL 重读——"事实 cache 可重建"原则的
  直接应用，非正式迁移函数）；`claude-ledger.json` 新增 `unaccounted`
  顶层键（dateless 残差池，取代此前把 baseline 悄悄摊到 `baseline_day` 单日
  的旧行为）。15 个 golden 快照与全部 `cargo test --release`/clippy/差分套件
  验证零漂移（`claude-sync`/`claude-cost` 不在 golden 覆盖范围内）。
