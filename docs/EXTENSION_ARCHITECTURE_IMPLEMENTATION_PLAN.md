# 扩展架构实施任务与验收台账

依据：`AGENT_VITALS_EXTENSION_ARCHITECTURE_SPEC.md` v1.1 与
`HARNESS_MANIFEST_DSL_SPEC.md` v0.4.2。任务范围覆盖两份规格的承诺路线；
P1.5 脚本开发者模式、P2 DSL、P3 社区目录均为条件触发，不自动启用。

## 迭代协议

每轮按分析 → build → 测试 → 独立 subAgent 验收推进。分析记录实际调用链、
数据契约与失败边界；实现保留未相关用户改动；测试针对真实入口与失败恢复；
验收 agent 读当前 diff 和测试证据，提出问题后修复并复验。只有证据齐全才
将任务标为完成。进度不等于整个扩展架构已经完成。

## 任务分解

### 当前优先级（2026-10-03）

主线转到APP_LAYER_IMPLEMENTATION_PLAN.md的C0–C13（官方内置 City 前端插件）。
保留本表完成证据和欠账；已启动批次仅作必要修复、测试与阶段合并准备。
E00及尚未开始的执行环境/DSL/其他数据插槽扩容后移，E15全范围验收仍未完成。
City 按需复用已有校验/来源/事务原语，按官方内置前端插件场景建设。
2026-10-04 归并正在收齐原工作区的 E06–E08、catalog 发布与官网内容；
最终实现状态与测试结果以 WORKTREE_MAIN_CONSOLIDATION_REPORT.md 为准。

| ID | 任务 | 依赖 | 完成证据 | 状态 |
|---|---|---|---|---|
| E00 | P-1 真实执行环境 feasibility 与 recipe 覆盖率调查 | 无 | 至少十真实执行环境或明确报告折算；两个分母、脱敏样本与真实来源 | 待调查 |
| E01 | CAP-1：schema、Rust/Python 能力与版本门，接入加载入口 | 无 | 旧 manifest 正常、未知能力/格式拒绝、双语言错误与输出对拍 | 本轮验收通过 |
| E02 | typed index、固定 commit/hash、路径与资源限制、依赖闭包 | E01 | 共用合法/恶意 fixture、循环/冲突/超限测试 | 本轮纯校验层验收通过 |
| E03 | authority 扩展台账 migration、revision/origin、generation、历史关联 | E02 | 旧库迁移、事务回滚、事实关联及读写兼容测试 | 本轮验收通过 |
| E04 | 不可变对象、校验加载、staging、预览绑定、事务激活/回滚 | E03 | 各崩溃边界、对象损坏、并发预览失效测试 | 本轮验收通过 |
| E05 | harness 前缀迁移及完整消费面守卫、billing 估算锁 | E03 | 迁移预览/备份/恢复、SQL/MCP/行为面拒绝、受控 golden parity | 本轮验收通过（一项测试欠账登记） |
| E06 | 官方目录 opt-in 客户端、CLI/MCP、更新与确认、来源状态 | E04,E05 | 禁网无请求、同源约束、离线加载/回滚、来源不可伪造 | 索引与桌面 payload 预览/确认接线已归并；真实发布 payload 验收仍待 |
| E07 | catalog 仓库布局、价卡兼容镜像与发布 CI | E02 | 旧 URL/schema 兼容、镜像漂移检查、客户端缺价降级 | 仓库/镜像/本地发布门已验收；远端发布及缺价降级专项仍待 |
| E08 | 应急旁名互斥、升级漂移、退出与显式重算 | E05,E06 | 同源范围重叠拒绝、重放不双计、账单/封账保持测试 | 本轮实施与验收通过；E15 全规格矩阵仍待 |
| E09 | P1 桌面导入向导、徽标、KPI/矩阵、卸载与状态呈现 | E06,E08 | UI 截图/交互验证、脱敏与历史来源保留 | 待实施 |
| E10 | MAN-3/4 会话身份、时基与 provider 证据槽 | E01,E05 | 原始 provider 优先、时间未知降级、身份稳定与 parity | 待实施 |
| E11 | MAN-1 多源 join、MAN-2 json/rotated | E10 | join 缺失/重复、轮转重放、差分/树形 recipe fixture | 待实施 |
| E11R | 真实树形/累计快照证据驱动的本体 recipe 新族 | E00,E10 | 分支去重、差分/重置/乱序回放及双语言 golden；覆盖缺口报告 | 待实施 |
| E12 | provider、price_card、model_alias 数据插槽 | E02,E04,E07 | local 不升级订阅/官方路由、估算影响预览及冲突 pin | 待实施 |
| E13 | vendor taxonomy、behavior_patterns、trust_profile 权限 | E04,E05 | 分类/finding 影响回放、来源权限及行为资格守卫 | 待实施 |
| E14 | subscription_scope、FX、quota_window 与阈值插槽 | E12,E13 | 路由证据门、封账绑定、DST/时间窗口与影响预览 | 待实施 |
| E15 | 发布验收与全量 parity、clippy、故障矩阵核对 | E00–E14（含 E11R） | 对架构 §12 每项逐一登记测试/实现证据与 subAgent 结论 | 待实施 |

SQLite 源扩容另行立项评审。P-1 的至少十执行环境覆盖率调查须记录真实样本来源、
执行环境与 usage 行两个分母；缺少样本时明确缺口，不能以合成数据冒充真实覆盖率。
harness 前缀迁移会变更外部身份，E05 实现时必须检查 source 控制、retention、
导出/封账引用及 fact_id，不以纯文本替换视为完成。

## 当前轮

### E08 阶段收尾（2026-10-04）

新增编译适配器实际源目录清单（Claude、Codex、DSH、WorkBuddy）及用户
custom roots 的保守互斥门。安装、官方安装共用的候选校验、回滚、manifest
运行均执行检查；normal sync 在任何维护写入前检查已有 active manifest，
防止后来添加的 compiled custom root 直接开启重叠读取。目录相同、嵌套或
canonical symlink alias 拒绝；尚未出现的编译源根也保留，悬空 symlink 拒绝。
暂停编译适配器不是互斥证明，因为历史事实仍保留。
卸载后的源范围仍按历史 provenance 保留，另一 manifest 不可重新认领；
同 slug 的历史 discovery/session/event-key/recipe 变化保守拒绝。历史对象
丢失时不能证明互斥，阻止 compiled sync；没有历史事实的坏候选仍由其自身
ingest 报错隔离。旧 schema 尚无扩展激活时，预检不写库且不阻断正常迁移。
不支持自动应急接管或
跨 host 合并；需要显式源迁移的请求保持拒绝，文件系统/配置并发 TOCTOU
尚未全面解决，不能宣称任意文件与事件时间范围的互斥证明已完成。

新增 CLI `manifest-recompute --slug … --revision … --machine-namespace …`
（可选 `--file`、`--confirm <preview_sha256>`）。只重放历史激活过的不可变
revision；输入按有界捕获固定，确认绑定 corpus、namespace、generation、
engine 与结果内容。生成独立 `state/extension-recomputations/objects/<sha>/payload.json`
结果，按 fact_id 去重并拒绝冲突，重复确认复用同一对象。结果只覆盖本次
captured corpus，不宣称完整历史覆盖；超过对象大小限制明确拒绝。不会修改
usage ledger、账单、价卡快照或 provenance，也不会自动回写查询汇总。
这不是跨 host 身份迁移命令，也不是覆盖原历史结果的重新入账。

升级身份漂移拒绝、卸载保留事实/来源与 replay exactly-once 沿用已有测试。
新增测试覆盖缺失根保留、真实 symlink/悬空 symlink、custom-root 后加冲突、
重算只读预览、重复确认、输入变化拒绝、结果保持及全部 authority 表内容保持
（包含已有用量、来源、历史账单和 pricing snapshot）。现有 billing 代码明确
注明历史月封账冻结尚未实现，因此这里只能证明不写账单/快照，不能以合成
测试冒充真实封账联动完成。完整 E08 仍有该验收及显式源迁移欠账。

本轮验证与阶段合并检查结果记录于 `E08_MERGE_READINESS.md`。

### E07 仓库目录、价卡镜像及发布门（2026-10-02）

`catalog/pricing/{pricing.json,codex_pricing.json,pricing-sync.json}`成为三件
现有价卡权威副本，初始内容与对应assets逐字节一致。保留旧URL、Rust编译
引用、Python读取与ClawHub打包路径；价格、schema及报表契约没有变化。聚合
底表暂保留，按provider拆分与typed price slot随E12实现；FX仍用原路径。

`scripts/catalog_mirror.py`默认只读检查，显式`--write`单向复制catalog→assets；
源/镜像符号链接或缺失权威拒绝，不反向重建。每件以临时文件+rename替换，
三件不承诺整体原子写；CI在发布前再次检查全组一致，失败不发布。
每日`pricing_sync.py`改读catalog底表、默认写catalog overlay并同步兼容镜像，
写之前预检两侧路径；自定义`--overlay`为独立输出。无变化不修改updated_at。

`scripts/verify_catalog.py`离线发布检查读取实际Git commit中的普通blob，先
核对对象类型/大小，再读原始bytes并验证SHA256、host schema/slug/能力/version
对账和依赖闭包64件/32MiB上限。固定host布局为`catalog/harnesses/<slug>.json`。
payload先提交，后续index提交引用该真实commit；工作区新内容不能套旧commit。
严格UTF-8及JSON常量解析与Rust客户端一致。正常校验、binary/desktop release、
ClawHub打包均加目录门，取完整Git历史。每日价卡CI同时检测/提交catalog与
assets overlay，提交前校验镜像；修正原单条cargo test带两个filter的写法，
分别执行pricing_catalog和fx_settings测试。
生成步骤显式bash/pipefail，失败不会被tee日志管道掩盖；FX仍按原策略允许
同步失败但不能错误显示生成成功。

验证：Python3.9.6专项51项通过（含10项新增发布/镜像测试）；Rust价卡/FX各9项通过；
Python及本轮release构建的Rust golden各16/16逐字节一致；workflow YAML解析、
桌面发布静态契约检查及本地目录门通过。临时Git/价格源均为合成fixture，未联网
取价、未修改现有assets价格、未推送或发布。真实catalog仍空，线上可达commit及
客户端更新失败保留最后有效卡的专项尚未验收，E07和整体目标不扩记完成。
独立subAgent读当前实现与测试证据，本轮E07仓库/镜像/本地发布门限定验收通过。

### E08 激活源根互斥门（2026-10-03，部分实现）

本轮补上本地 manifest 安装与官方依赖组的宿主源范围互斥检查：候选宿主与
同一预览代际的所有其他 active host manifest 比较；依赖组内部两两比较；
单宿主回滚则在目标映射上重新校验。根目录 canonicalize 失败、根目录相同或
彼此嵌套时 fail closed。不同 glob 不能作为互斥证明，因为根内 symlink 可使
不同文件名映射到同一 canonical source。激活代际变化由现有 ticket CAS 拒绝。

定向验证：`cargo test --release -p agent-vitals-ingest --lib`、本地安装/官方
依赖组/宿主生命周期测试及 `cargo clippy --release -p agent-vitals-ingest
--all-targets -- -D warnings`。包含真实 symlink alias 与本地 active-host 冲突
回归用例；全量 ingest 114/114、Clippy 通过，独立 subAgent 对此子批次限定验收
通过。文件系统仍存在预览至确认之间的 TOCTOU；同根但实际文件互不相交的
宿主也会被保守拒绝。E08 的升级漂移、退出、显式重算及重放不双计/封账保持
联动并未在本轮实现，因此 E08 仅部分完成，不能据此认定整体目标完成。

### 单宿主回滚与卸载 CLI（2026-10-02，host slot 子批次）

新增 `manifest-rollback` / `manifest-uninstall` 只读预览与显式确认。它们从
authority 固定当前 generation 与完整 slot map，只替换或移除目标
`harness_manifest`，其他 host 和 price_card 原样保留。回滚目标必须是该宿主
历史激活过的 revision；校验不可变对象及 schema，再以同份输入运行旧版/
目标版影响比较，身份漂移拒绝。卸载不删历史事实、revision 或 provenance。
确认重算 ticket 并以 generation CAS 激活；快照失败报告已提交警告。

独立 agent 发现最后一个宿主卸载时对象目录丢失会卡住；新增仅限空目标映射的
`commit_empty_uninstall`，仍走台账事务/CAS，其他情况继续校验全部保留对象。
专项 4 tests 通过，覆盖单宿主映射、价格插槽保留、历史版本、不重复卸载、
未知目标拒绝、坏对象目录可卸载、过期确认、快照失败后已提交，以及实际
摄入 1 条事实和 provenance 后卸载仍保留两者。CLI 两个子命令的 release
`--help` 实跑通过；ingest/CLI all-targets Clippy 严格门通过；独立静态复验
未见新阻断问题。

限制：缺 authority DB 的卸载当前报未安装读错，不生成新 DB；回滚要求当前
对象可解析且输入可捕获，源日志过期或当前对象损坏时尚需显式“未验证恢复”
流程。完整事实/provenance 故障矩阵、vendor 依赖与全部对象 I/O 边界
未在本批验收，不扩记 E04/E06/E15 全量完成。

### 本地 manifest 安装入口（2026-10-02，host slot 子批次）

CLI 新增 `manifest-install`：默认只读预览；显式 `--confirm` 时重新读取候选
原始字节、当前 generation、不可变旧对象和选定日志范围，再比较完整 ticket
哈希。ticket 绑定 namespace、候选完整 SHA、corpus 与影响哈希、引擎版本及
完整 slot map。匹配后 stage/install 不可变对象，通过台账 CAS 激活；
`origin` 强制 local，快照写失败只作已激活警告。没有网络和事实写入。

旧 `manifest-ingest --write` 改为明确拒绝，测试专用直接 writer 不再暴露为
正式接口。独立 agent 初审发现该绕过与候选无界读取；已改为最多读取
`MAX_PAYLOAD_BYTES+1`，并修正文案。重复安装回报前复核 generation。

证据：本地安装 4 项专项测试通过，覆盖只读首装预览、namespace/日志 token/
候选字节变化导致确认过期、历史更新、并发 generation 过期、保留 price_card、
坏 active 对象拒绝更新预览与重复确认不切指针。`cargo run --release -p
agent-vitals -- manifest-install --help` 成功；旧 `manifest-ingest --write`
实跑 exit 2；ingest/CLI all-targets Clippy 严格门通过。独立 agent 限定静态
验收通过，未将这批证明扩展为全量架构验收。

此批尚非 E04/E06 全量验收：官方 payload 下载、所有 slot handler、
更新/回滚/卸载 UI、源过期与完整崩溃矩阵等仍待实施。

### 同份输入捕获 API（2026-10-02）

将文件发现与提取分离。普通 `run_manifest` 仍逐文件读取和释放内容；预览
`preview_captured_manifest_change` 在 64 MiB 有界内存中捕获一次选定文件集，
旧版与候选版从相同字节提取并比较，且 roots/include/session.pattern/slug
声明变化直接拒绝，避免沿用候选身份掩盖迁移。读取采用最多
`remaining+1` 字节，文件增长也不会造成无界分配。

独立 agent 对首次实现发现无界读取及旧版身份复用问题；已按复核意见修正。
修正后独立静态复验未见阻断问题；`plugin_ingest` 18 tests 全通过，
ingest all-targets Clippy 严格门通过（修复一处 needless borrow）。
这仍只是预览计算 API：多文件不是同一瞬间的原子快照，超过上限需显式
有界样本，尚未提供 CLI 样本参数及 confirm 安装链路。

### 本地 host 影响预览（2026-10-02，未接安装确认）

新增纯内存 old/new manifest 影响比较：要求同一内部 corpus 指纹、宿主身份与
事实 ID 集合一致；重复 ID 内容冲突和身份漂移拒绝。返回脱敏的事实、token、
model、时间变化计数，以及捕获文件数、`captured-files-only` 覆盖声明和
emit/skip/invalid 前后计数；内部影响哈希绑定上述计数与规范化事实内容。
此摘要不写 authority，不输出事实 ID、模型原文或源文本。

独立 agent 静态复核此纯函数范围通过，并指出需覆盖“仅计数或文件数变化也
改变哈希”；专项断言已补且通过。`plugin_ingest` 15 tests 通过，新增断言后
影响计数专项 1 test 再通过；ingest all-targets Clippy 严格门通过。尚需全 corpus 冻结、确认时重读
指纹与范围、ticket 绑定和 CLI 入口。当前分支是 `feat/agent-city`；这些改动
尚未提交到 `main`，不能称为主分支功能完成。

### 实际摄入闭环补齐（2026-10-02，authority-first 子批次）

分析确认 `plugin_ingest_write` 原先先写 JSONL 再写 SQL，实际消费还未固定
active generation，事实也未接入 provenance 事务。此批仅修正写入顺序：
validate → authority → JSONL 镜像；SQL helper 返回错误或输入被拒收时不写
镜像，镜像失败则如实提示 authority 已提交。新增三个回归测试覆盖 SQL
打开失败、SQL 成功但拒收输入，以及固定源内容下镜像失败后两次重放不双计。

测试：`cargo test --release -p agent-vitals-ingest plugin_ingest` 8 passed，
0 failed；`git diff --check` 通过。architecture_analysis 独立静态复验了
顺序、拒收 guard 与故障测试；此次不是全量发布验收。

限制与下一批：恢复依赖源内容仍可重放；duplicate payload conflict 尚未
按 authority 已接受事实读回镜像，源变化可能造成镜像与 SQL 不一致。
还须完成 active generation 固定、不可变 payload 消费、事实来源同事务
关联及混合拒收/运行中激活/源过期故障矩阵。E04/E06 与 E15 不因此扩记完成。

### 来源事务接线（2026-10-02，SQL 写入器子批次）

新增 `ExtensionFactContext` 与 `insert_facts_with_extension`；旧 API 委托
空上下文保持契约。扩展上下文必须在事务中使用；只有新插入成功的事实
绑定 generation/revision/engine，关联失败传播并由外层整批回滚。
重复事实不改原来源，也不为历史无来源事实追认 vendor。SQL sync 新增
兼容包装入口，在事实、source/checkpoint/outbox 原事务中传递上下文。

证据：旧 writer 16 tests、sql_sync 19 tests、新集成 5 tests 全部通过；
data/ingest `clippy --release --lib -- -D warnings` 通过，`git diff --check`
通过。独立 agent 编写四项集成测试并静态复验实现；主线程另补事务外调用
前置拒绝测试。clippy 暴露旧 authority 文档列表分段问题，仅加注释空行修复。

此批证明底层及 SQL 批次入口可安全绑定来源，不证明实际 installed loader
已经传入上下文。下一批必须将 active generation 与不可变对象加载接到
实际运行入口，测试运行中激活变化仍使用原 generation，并补 SQL sync
层 checkpoint/outbox 回滚专项证据。整体任务仍未完成。

### 激活版本实际消费（2026-10-02，周期摄入子批次）

`ingest_installed` 已改为单条 SQL 快照读取激活的 harness_manifest 集合，固定
generation/revision/hash，加载 `state/extensions` 不可变对象并校验 slug，
将来源上下文传入事实事务。可变 `.d` 不再用于周期摄入；未激活候选明确
报告需要预览/激活，坏对象不回退候选。增加宿主 lease 与停止读取门；
source-controls 注册表识别安装历史，候选删除或运行中卸载不使排除规则失效。

专项测试 10 passed：真实 candidate 改坏后仍消费对象；SELECT 固定后卸载
切换 generation，本轮仍按原 generation 写来源；回滚后重放不追加；
排除宿主返回跳过；对象损坏即使存在合法候选也报错、不新增事实；未激活
候选不写事实。独立 architecture_analysis 静态复验上述实际接线。
query/source-controls 专项另 4 tests 通过；本批不是全量 workspace 验收。
ingest/query `clippy --release --lib -- -D warnings` 通过（新结果类型以
类型别名消除 complexity lint），`git diff --check` 通过。

尚未完成：查询/展示完整 registry 改为 active 消费、显式 CLI 摄入统一
生命周期、vendor 原因码与 schema/capabilities 元数据对账、payload 下载与
预览确认入口、镜像内容漂移恢复、SQL sync checkpoint/outbox 专项回滚测试。
本批不将 E04/E06/E15 或整体架构标记为完成。

### 激活 registry 的显示查询（2026-10-02）

新增 query `scan_active_plugin_hosts`：单 SELECT 固定激活集合，校验不可变
对象与 slug，逐件隔离错误且不回退 `.d`。`plugin_display_name` 与桌面
`host_display_names` 改为此入口。新增 ObjectStore 只读打开方法，查询不
创建 authority、state 或 staging；候选扫描仍是独立接口。

验收证据：registry 6 tests 全通过（含独立 agent 新增的候选隔离、双宿主
对象坏件隔离与无 staging 写入测试）；query/runtime-core lib Clippy 严格门
通过；desktop `cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib`
通过，另有既存 `money_rows_text_localized` dead_code 警告；diff check 通过。
本轮未运行桌面 app，不能宣称视觉/交互验收。

余项：CLI list/显式 ingest 生命周期、历史名称与账面统计不能按 active
过滤（卸载不得丢信号）、其他 registry 消费面、origin/schema 元数据对账。
这里只完成显示名查询切换，未声明完整 registry 迁移或发布验收完成。

### 历史宿主处理量保持（2026-10-02）

`plugin_tokens_by_host` 的宿主集合改从 authority 窗口内有效事实查询，
不依赖 `.d` 或当前 active。保留合法 `harness:` 事实的全部四桶与真零行，
软删与窗口外事实不计入，候选文件无事实不产生虚构行。金额口径未改。

独立 agent 增加四项专项测试，主线程将历史测试增强为真实 activate1 →
uninstall2 空槽后查询仍保留历史 165 tokens；修复增强测试导入后最终
`cargo test --release -p agent-vitals-query manifest_history_tests` 4 passed。
现有 host_amounts FX 回归 1 passed，query lib Clippy 严格门与 diff check
通过；独立 agent 已复核最终差异。没有刷新 golden。

本批仅证明此 summary 处理量路径；历史金额、名称/provenance 对账、CLI
生命周期与其他 registry 消费面仍待实施，不扩记整体架构完成。

### SQL 故障补证与确认哈希修复（2026-10-02）

新增真实 `write_flat_facts_with_sources_and_extension` 故障回归：先存
checkpoint/source=10，坏 generation 导致来源 FK 失败后，事实、关联、
会话、outbox 均未留下，checkpoint/source 仍为10，revision 不动；正确
generation 重试后四表与 checkpoint=99 同时提交。此为 SQL 批次证明，
不等于宿主发现/解码或“已写 outbox 后失败”的故障注入。

CLI 分析发现 ticket 旧哈希遗漏 vendor 元数据与 capabilities，并用字段
分隔符拼接。修复为 v2 域标记、逐字段长度前缀、vendor source/commit/index
及递归规范化 capabilities；installed_at 为操作时间，不纳入确认语义。
补回归证明字段分隔不别名、元数据变化改哈希、对象键重排保持哈希。

证据：ingest 全 crate 89 unit + 5 integration 通过；增强 vendor commit/index
断言后 installer 5 再次通过；ingest all-targets Clippy 严格门通过，diff
check 通过；独立 agent 限定验收通过。没有修改 golden。

下一批完整 CLI 安装仍须 FrozenCorpus：同一冻结输入运行 old/new 影响
预览，确认时重发现/重 hash，绑定 machine namespace、corpus fingerprint
与影响摘要，默认拒绝身份漂移；新增离线 Local manifest-install，并限制
显式 ingest 只消费 active。当前 ticket 仍缺输入/影响绑定，不宣称确认
安装闭环已完成，也不将 E04/E06/E15 扩记为全量完成。

### 同字节重放与内部输入指纹（2026-10-02）

`run_manifest` 每文件仅读取一次，并用同一份 content 做两遍身份稳定性
检查；不再用两次 live-log 读取冒充纯函数校验。增加内部 opaque SHA256
指纹，长度前缀绑定 machine namespace、捕获文件路径精确字节、相对路径、
session/profile 与全部内容。只作为后续 preview 输入，不进入 serde 报告。

证据：plugin_ingest 12 tests 全通过，独立 agent 新增两项测试证明同输入
稳定、token 变化但 fact ID 不变仍改变指纹、文件集合/namespace 变化，
以及序列化不泄露指纹；diff check 和 ingest all-targets Clippy 严格门通过。
独立 agent 限定验收通过。没有更新 golden。

限制：这是逐文件捕获，不是全 corpus 同一时刻的原子快照；仍只比较
fact IDs，未宣称完整输出纯度。尚须把 old/new 影响比较约束到同一输入，
confirm 时重发现/重 hash，并将 corpus/影响摘要绑定 ticket 与实际 CLI
安装提交。不能据此将完整冻结输入或确认生命周期标为完成。

E01 分析发现：现有 parser 仅具有固定 recipe 词表及未来字段拒绝，未接受
requires/min_app_version；Rust 与 Python 分别解析，必须同步。现有 facts
仍使用 plugin 前缀，本轮能力门不改变事实身份，迁移由 E05 完整处理。
实现与测试结果、独立验收结论将在实际完成后登记。

### E02 独立验收记录（2026-10-01）

交付范围为纯 typed index 校验、schema 与共享 fixtures；网络获取、内容哈希
计算、最高序号持久化、payload 对账与激活由 E03/E04/E06 接入，不能把纯
校验层通过解释为目录安装已经可用。

architecture_analysis subAgent 独立重跑：Rust
`cargo test --release -p agent-vitals-domain --test catalog_index` 4 tests 通过；
Python catalog suite 最终 7 tests 通过，覆盖 schema search 语义下末尾换行
拒绝、u32 边界、日期、diamond DAG/环、大小上限与共享错误码。
独立额外输入验证 NaN/正负 Infinity 均为 `index_json`；反序依赖错误条目
与正序均优先报告 `dependency_duplicate`；非 ASCII 日期数字及 2026 闰日
拒绝，2024 闰日接受；5000 位版本返回稳定 `version`；128 个 Unicode
字符能力名按字符计数接受，Rust 已用 `chars().count()` 对齐。
依赖阶段与 DFS 的 Python `sorted(nodes)` 与 Rust BTreeMap 排序一致。
`git diff --check` 通过，既有 golden 无改动。后续发布仍须完成全量门与
事务、来源、离线及故障恢复验收。

### E01 验收记录（2026-10-01）

实现：Rust harnesses manifest 和 Python twin 的真实 parser 入口能力门，公开
CapabilitySet/协商接口、schema 与共享 `harness-manifest-capabilities.json`。
旧 local manifest 缺声明仍按实际 recipe 校验；当前公告三种内置 recipe、
零 feature，尚未消除的 trust 双语言差异不能成为已支持 feature。

build/test：`cargo build --release -p agent-vitals` 通过；
`cargo test --release -p agent-vitals-harnesses harnesses::generic` 29 tests 通过；
Python generic suite 22 tests 通过，包含文件加载拒绝与共享错误串。
独立 architecture_analysis subAgent 使用新 release CLI 与 `scripts/scan.py`
对同输入 unknown-feature、非法 u32 版本、未知键顺序三个拒绝案例：均 exit 2，
stdout 逐字一致；另核查 registry/ingest 加载必经 parser、schema 数字边界和
末尾换行拒绝。没有更新既有 golden。

全量首次 Python suite：1259 tests，6 failures、2 errors、210 skipped。
运行中新增 catalog 模块导致分类/包装白名单三项失败，已登记并针对复验。
另有月聚合/by-source 日期测试失败，fixture 固定 2026-09 而本轮日期为
2026-10-01；已复现，尚待完整区分基线问题与本次变化。全量重新运行中，
因此此记录只证明 E01 本轮门通过，不代表发布全量检查通过。

后续补充：Python 与新 release Rust 二进制各 16 golden cases 全部逐字一致。
harnesses/domain 的 `clippy --release --all-targets -- -D warnings` 通过；检查遇到
既有 FX 文档/迭代器 lint，以手工小改修正（last/filter 改等价反向查找），
FX 回归测试随后运行。workspace 全量 gate 仍待后续实施及完整验证。

### E00 样本初查（2026-10-01）

已检查 tracked fixtures 和 README：DSH README 明确为按源码格式生成的手写
语料，golden_runner 的 zcode case 也由 `_plugin_fixture_row` 生成。这些可用
作回归测试，不能计入“十个真实执行环境”调查分母。仓库有 Claude、Codex、DSH、
WorkBuddy 格式夹具与 trust/minimax 元数据，但尚无覆盖十执行环境的真实用量样本
来源台账。E00 保持未完成；后续可以完成合成回归、收集已提供的脱敏样本并
明确覆盖缺口，不能宣称 recipe-only 80% 目标已满足。

### E03–E06 迭代记录（2026-10-01，第二轮）

**E03 验收通过**：`extension_authority.rs` 五张表 + CAS 激活 + 事实关联，
schema v28 迁移（旧分支 v27 边界保留、失败不推进版本戳）。data crate
196+7 测试通过；`EXTENSION_AUTHORITY_SCHEMA_V28.md` 明确「本轮仅 SQL 基础，
不宣称文件/网络安装生命周期完成」。

**E04 验收通过**：`runtime-core` ObjectStore 增补 stage/discard（Python twin
同步，错误码逐字一致）；ingest 新增 `extension_installer`（PreviewTicket
预览绑定 generation+候选集+引擎版本、commit 前 §8.3.3 对象存在性校验、
rollback_to/uninstall_all、registry.json 派生快照可删可重建）。测试覆盖：
陈旧 ticket CAS 拒绝、对象篡改/缺失阻断提交且 generation 不动、回滚不重复
登记 revision、卸载保留历史、未知 revision/空引擎版本拒绝。ingest 542+14
测试通过。

**E05 验收通过（一项欠账）**：`plugin:` → `harness:` 全量迁移——
`facts_harness`/`facts_file_stem`/source_profile 前缀、`plugin_facts_stem`（旧
`plugin:` 值折算新 stem）、source_controls 锁与排除项（旧值读取时原地规范
化，未注册 manifest 执行环境仍按既有 stale 语义清扫）、session_insights/summary
谓词、retention 磁盘发现（新旧文件名双认）、CLI 三命令改名 `manifest-*`、
Python twin（`generic_manifest.py`/`generic_plugin.py`/cli.py，slug 错误串
两侧逐字一致）、desktop 显示/徽标双前缀、attribution 签名表键位。数据迁移
三件套：authority **v29**（`usage_facts` harness 列幂等 UPDATE，重开即迁）、
facts 文件改名 `migrate_manifest_facts_prefix`（幂等、目标存在即跳过如实
上报，retention 前置执行）、source-controls 就地规范化。**受控 golden 更
新**：仅 `harness-generic-zcode.json` 10 行（前缀 ×7；fact_id ×3——harness 参与
身份哈希，属契约变更预期后果），16 case 双实现逐字节一致。欠账：E05 证据
项中「declarations 不得把 `harness:%` 改 subscription」的**专项 SQL 回归测试**
未写（现有 attribution 测试已覆盖 harness: 行的声明路径，负向断言待补）。

**E06 索引面验收通过；payload 面待下批次**：桌面 `update_manifest_catalog`
（opt-in 策略默认关、10s/4MiB 限、UA 固定、index sha256 + E02
`validate_catalog` 含最高序号单调性、缓存 `cache/catalog/index.json`、状态
文件含 supported_entries 并如实标注「激活需显式确认」）、
`manifest_catalog_status`/`save_manifest_catalog_policy` 命令；MCP
control_plane 增 `manifest_catalog_status`（只读）与
`manifest_catalog_policy_set`（MUTATIONS）；CLI 增 `manifest-catalog-status`
（本地只读，无网络——HTTP 归桌面层，与价卡同构，规格 §13.2 的 CLI update
预期按此修正）。仓库播种 `catalog/index.json`（空 entries，sequence 1）。
capability 词表经桌面直依 harnesses 的 `CapabilitySet::default()` 单一来源。
**待办**：payload 下载 → ObjectStore staging → preview ticket → 显式确认激
活的完整链路、E08 互斥门联动、以及禁网/离线加载的故障注入测试（§12 对应
行）。本批次未写桌面/MCP 专项单测（沿用价卡同构面，构建+CLI 冒烟验证）。

**全量门（第二轮收尾）**：workspace `cargo test --release` 64 套件零失败；
Python 1274 tests OK（210 skip）；golden 16/16 双实现逐字节一致；workspace
`cargo clippy --release --all-targets -- -D warnings` 通过（修正 6 处：本轮
3 处 manual_contains/char-comparison、预存 WIP 3 处——billing_preview 未用
导入、authority 8 参函数 allow、price_overrides 文档缩进）。本轮全部改动
未提交。

### E06 索引读取加固（2026-10-02）

桌面官方目录索引请求禁用 HTTP 重定向，响应以分块方式读取并按实际累计字节
执行 4 MiB 上限；即使服务端没有或错误声明 `Content-Length` 也不无限读取。
最高已接受序号现在同时从状态文件与已缓存索引恢复；同序号不同哈希会拒绝，
缓存损坏也会显式失败。同一桌面进程中的并发检查已串行化，避免旧响应覆盖新
序号。新增限额与缓存恢复/冲突单测。此处只是本地持久化状态的回退保护，不是
签名或防篡改证明：状态和缓存同时丢失仍无法恢复远端历史最高序号；跨进程并发、
状态与缓存的双文件原子提交仍待解决。此批尚未完成 payload 面，后续进展见下。

### E06 host payload 后端（2026-10-02）

新增桌面 `install_manifest_catalog_host(slug, release_local_pins, confirm)`：默认
禁网，显式许可后从固定官方 HTTPS 地址新取索引（本地缓存不能授予 vendor
来源），按完整 commit 和验证过的相对路径下载 payload。索引 4 MiB、每件
payload 8 MiB、依赖闭包最多 64 件和内容总量 32 MiB；顺序下载，单请求
10s，整个下载阶段 30s；禁重定向，并在每次 payload 请求前复核网络许可。
索引最高序号同时核对状态/缓存；状态损坏明确拒绝更新，不默认重置后覆盖。

runtime `vendor_manifest_install` 检查完整 index、依赖集合、原始 bytes 哈希、
slot/slug/schema，以及 payload/index 的 requires 和 min_app_version 对账；
实际 recipe 必须出现在 requires。当前仅有 host handler，其他 slot 依赖仍
明确拒绝。每个宿主复用冻结输入/影响计算；确认摘要绑定 index bytes、完整
依赖组、机器身份、影响结果、精确解钉宿主集合和 active generation。local pin
默认阻止 vendor 更新，解除依赖宿主 pin 也须逐项列出并重新确认。

所有对象发布成功后，单个 authority CAS 激活完整映射；保留组外 slot，不写
已有事实。修复共用 handler 的不可变 revision 元数据复核，local/vendor
记录保持不同身份。安装失败写明失败原因和退避状态；快照失败为已提交后的
warning。索引接受状态不表示 payload 已通过本地影响预览或已激活。

当前验证覆盖只读 core 预览、两个宿主依赖组、显式确认、日志/索引/generation
变化失效、local及依赖宿主pin、组外price_card保留、坏依赖payload、契约不一致、
commit URL及恶意路径、发布失败不部分激活；桌面本地HTTP测试验证无长度声明的
chunked超限及302不跟随。32 MiB是payload内容总量，不是RSS保证；64 MiB冻结
额度逐宿主计算，依赖组不承诺全体源日志的同一时刻快照。

来源边界仍是本体调用通道：公开Rust服务只供固定桌面获取入口调用，不能在
CLI/MCP把用户路径或任意bytes映射为vendor。它不提供密码学发布者证明。
`catalog/index.json`仍为空，真实官方payload端到端发布证据尚缺；UI、跨进程
高水位、双文件原子性、完整禁网/离线/故障矩阵以及E08互斥门仍待后续。
E06、E15及整个架构不因此标记完成。

验证：`cargo test --release -p agent-vitals-ingest --lib manifest_install` 11 项
通过（vendor 7 / local 4）；桌面 `cargo test --release --manifest-path
apps/desktop/src-tauri/Cargo.toml --lib manifest_catalog_` 3 项通过；ingest
`cargo clippy --release -p agent-vitals-ingest --all-targets -- -D warnings` 通过。
独立 subAgent 已读实现与最终测试证据，host payload 子批次限定验收通过。

### 真机测试记录（2026-10-01，bundle 通道）

**发现并修复一个升级 bug**：v29 bump 把幂等升级带写成「27 或 29」，漏掉
上一发布版本 28——现网 28 库 open 时掉进 `__unsupported_legacy_version__`
防御分支被拒开（data-migrate 实测复现）。修复为区间判断
`(27..=SCHEMA_VERSION).contains(v)`，并补 `v28_stamped_database_upgrades_
through_the_idempotent_band` 回归（28/27 双向钉死）。

**迁移时序缝（已收口，登记成因）**：首个 bundle 带着上述 bug，其同步 tick
在 retention 改名迁移**之前**就写了新路径 `harness-zcode.jsonl`（当时 authority
写连接被 brick，双写半失败）；改名迁移按「目标存在即跳过」如实保留旧件。
修复后重导 + 精确对账收口：DB 2141 行（2015 个 v29 保留旧 id + 126 个新
id；**事件级 exactly-once 证明与 harness 无关**，无重复计数），facts 文件合并
为 2141 行、id 与 DB 逐一对应；旧文件备份于 /tmp。**E05 遗留决定项——已拍板并实施（2026-10-01）**：产品未正式发布、无老数据
兼容包袱，**一次性重 stamp 到新 fact_id**。实现为 authority **v30**（标记 =
`source_profile LIKE 'plugin-%'`；`PRAGMA defer_foreign_keys=ON` 下同批改
`extension_fact_provenance` / `billing_fact_attributions` 子表与父行；事件级
UNIQUE(harness,ns,session,event,kind) 保证新旧 id 不可能由常规摄入共存——UPDATE
即足够，异事件哈希碰撞交由事务整体回滚响亮报错）+ ingest 文件侧重写
`restamp_manifest_fact_files`（同 `fact_id()` 重算、文件内按新 id 全量去重、
原子替换、幂等）。**接线教训**：迁移不能只挂在 retention 链路上——CLI 调用
图会把不可达代码链接裁掉（实测二进制无 `cutoff_month`），故显式挂进
`data-migrate` 维护命令确定性触发。真机终态：schema 30；zcode 2378 行全部
新 id；facts 文件 2378 行与 DB **1:1 零重复**；145 行 tick 重发重复行已合并。
过程中另修复：v29 幂等带漏掉 v28（已回归钉死）、v30 首版 FK 顺序违约
（deferred FK 解决）。**并行会话警告**：本轮多次与另一会话在同一工作区/
target 目录竞态（18:40 提交 63583b58、18:43 清空 bundle 目录、共享 rlib 被
陈旧复用），曾触发一次误判与一次过重的 `cargo clean -p`（清掉 26.6GB 共享
构建缓存）；后续构建请避免双会话同时 cargo。

### E08 收尾记录（2026-10-04，最新 City/harness 基线）

本轮在 City 最近代码 `3a9ae0a3`（含 harness 重命名）上先合入本地 `main`
并保留 City 的最新插件布局同步改动，再移植 E08；没有改动原始工作区。
E08 的实际身份统一为 `harness_manifest` / `harness:` / `harness`，DNS
字段 `endpoint_host` 保持其网络语义，不属于 harness 命名迁移。

实现范围：

- 对已编译 harness、已安装 manifest、新候选及丢失/符号链接路径按 canonical
  source roots 检查范围冲突；拒绝会造成同一来源被两个 manifest 声明的激活。
- local/vendor manifest 安装、确认、撤销/卸载都经同一 revision/object 与
  activation ledger 路径；卸载只撤销当前激活，不删除历史来源和 facts。
- 新增 `manifest-recompute` 显式历史回放：只允许指定当前激活的
  `harness_manifest` revision；预览绑定固定语料、命名空间和结果哈希，确认后
  输出隔离的不可变结果对象。重复确认幂等，既有 facts、官方账单归因与封账
  数据保持不变。它不自动重写 billing 或迁移封账。
- CLI 暴露 `--harness`，使用当前注册表枚举；city plugin 继续是前端项目，
  本轮没有把 Rust 扩展功能放进 City 插件。

验证（在 `codex/e08-city-closeout`）：workspace `cargo test --release` 通过；
`cargo clippy --release --all-targets -- -D warnings` 通过；`cargo build --release`
通过；Python 与 release CLI 的 16 个 golden cases 逐字节一致。Python 全量
`unittest discover` 最终 1274 项通过（210 项按测试条件跳过）。第一次运行有
1 项 `verify-workbench-traces.mjs` 失败，当时桌面 bundle 正并行重建；打包完成后
脚本及对应单测独立复跑通过，随后全量顺序复跑无失败。
带 release CLI 的 `test_harness_contract.py` 20 项和 `test_ci_gate.py` 19 项
均通过。City 侧 desktop React build、City package build/typecheck、7 项
`verify:city` 检查、City 布局检查、插件架构检查与 native isolation 检查通过；
第一次插件架构检查读到重建前的旧 bundle（误含 City chunk），由最新源码重建后
复验通过。`git diff --check` 通过。

边界：这些证据完成 E08 的本分支实现，不代表 P1.5、E00、E07、E09–E15 或
整个扩展架构已完成；E15 仍需逐项对照 §12 做整体验收。本地 `main` 尚未被
合并或推送。
