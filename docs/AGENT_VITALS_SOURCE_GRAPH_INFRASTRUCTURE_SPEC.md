# Agent Vitals Source Graph & Incremental Ingest Infrastructure Spec

> 状态：**Draft v1（2026-09-21）**——设计经 Vite HMR 源码级研究收敛（vitejs/vite 主干，六项机制逐条以源码行号验证，见 §3）；前置：事件总线 P0–P2 已合入（`AGENT_VITALS_EVENT_BUS_ARCHITECTURE_SPEC.md` v1.5，outbox/FactsIngested/单一 app-event 出口已投产）；
> 目标：把执行环境数据摄取从「定时全量扫描 + 变更文件全量重解析」升级为**注册表驱动的增量基础设施**——监听、检查点、脏集、兜底全部住在 runtime 基础设施层，执行环境适配器只贡献解析器。

---

## 0. 一句话结论

**增量化住在注册表里，不住在监听器里。** Vite 的 HMR 证明：文件事件只是加速器，ModuleGraph（谁依赖谁 + 缓存 + 失效标记）才是增量性的充分条件——Vite 在 watch 被禁用时用 noop watcher 照常工作（`server/index.ts:595` `createNoopWatcher`），靠按需转换 + 图失效。我们的对应物：**SourceGraph（文件检查点注册表）先建，watcher 最后接**；执行环境适配器从"自带扫描"降格为注册一个 `SourceParser`（增量能力由解析器老实申报，基础设施不猜测）。

## 1. 不可变决策

1. **基础设施层归属**：监听、去抖、检查点（byte_offset）、脏集调度、全量兜底、对账——全部住在 `agent-vitals-runtime` 的新模块 `source_graph`；执行环境适配器不启动 watcher、不管理 offset。
2. **增量是申报制**：`SourceParser::can_increment(&FileState) -> bool` 由解析器按文件状态判定（append-only JSONL = 能；zstd / SQLite = 永远不能）。增量/全量两条路径永远并存（Vite 的 HMR 更新与 full-reload 同系统并存），**全量路径不是降级，是同级公民**。
3. **正确性之网不动**：fact_id 幂等去重、`(size, mtime, parser_version)` 指纹、`PARSER_VERSION` 强制重放——全部保留。增量只减少每次送的货，不改变"重复投递必须无害"的语义。
4. **事件面最小化**：基础设施内部（脏集、watch 事件）不进事件总线；对外仍只发既有的 `FactsIngested{harness, …}`。词表不新增。
5. **watcher 可插拔**：无 watcher 时（P0/P1），tick 通过"查图谱找脏文件"获得全部增量收益；watcher（P2）只把发现时延从分钟压到秒。notify crate（macOS FSEvents 后端）为唯一监听实现，不自研。
6. **兜底是对账不是怀疑**：低频全量对账 sweep（小时级）恒在，吸收丢事件/轮转/截断——对应 Vite 的 full-reload 永远在场。

## 2. 现状与动机（代码证据）

| 环节 | 现状 | 证据 | 增量化了吗 |
|---|---|---|---|
| 文件发现 | 每 tick 全量 walk 执行环境目录树逐文件 stat | `sync_service.rs` 的候选枚举 + `sql_sync.rs:373` 指纹查询 | ✗ 全量 |
| 文件级差量 | `(size, mtime, parser_version)` 指纹，未变即跳 | `source_files` 表 + `sync_service.rs:116` 比对 | ✓ 已有 |
| 文件内解析 | 变更文件**从头重读重解析**，fact_id 去重吸收 | claude/codex/DSH emitter 全量 `read_records` | ✗ 全量 |
| 字节锚点 | 事件行带 `source_line`/`source_byte_offset` | V16 富化列 | 半成品（是锚点不是检查点） |

**痛点量化**：会话文件 GB 级（数据留存政策原文）。一个 2GB 的 claude 会话每次活跃 tick 重读 2GB，只为捡出新增几 MB——这是 tick 最重的单项成本。

## 3. 参考实现研究：Vite HMR（源码级，2026-09-21 主干）

| # | Vite 机制 | 源码出处 | 采纳映射 |
|---|---|---|---|
| 1 | **watcher 可选**：watch 禁用时 `createNoopWatcher`，系统照常工作 | `server/index.ts:585-595` | 分期依据：SourceGraph 先建（P0/P1 无 watcher 全获益），notify 最后接（P2） |
| 2 | **事件先过插件再失效缓存**：`onFileChange` → `pluginContainer.watchChange(file)`（每环境）→ `moduleGraph.onFileChange` → HMR | `server/index.ts:944-957` | 我们的反向顺序：先查图谱（检查点/能力）再调解析器——但"执行环境代码在事件路径上是插件位"这一分层照抄 |
| 3 | **ModuleNode = 反向边 + 缓存 + 失效标记**：`importers`/`importedModules`/`transformResult`/`invalidationState` | `server/moduleGraph.ts:28-62` | `SourceGraph` 行 = 文件检查点：`byte_offset`、指纹、执行环境路由、解析器身份、脏标记 |
| 4 | **分级失效（软/硬）**：软失效保留旧 transformResult 供时间戳级刷新；硬失效彻底作废 | `moduleGraph.ts:54-62, 174-179` | 软 = append 增量（从 offset 续读）；硬 = 截断/轮转/parser 升版（全量重读）。**失效等级是检查点比对的结果，不是异常分支** |
| 5 | **边界传播 + 部分接受**：沿 importers 上行，`isSelfAccepting`/`acceptedHmrExports`（按导出粒度）/`acceptedHmrDeps` 三级接受；环检测 | `server/hmr.ts:808-880` | `can_increment` 是文件级接受申报（粒度到文件+状态，不到导出——我们的派生面没有更细粒度）；"未分析节点停止传播"（hmr.ts #7561）对应"图谱外首见文件走全量路径" |
| 6 | **full-reload 永远在场**：`hasDeadEnd` → 整页重载；client 自身变化 → 直接 full-reload | `server/hmr.ts:459,642,766` | 全量重读 + 小时级对账 sweep。增量是快路径，不是唯一路径 |
| 7 | **按需转换（pull）**：失效只清缓存，浏览器请求时才 transform | `server/transformRequest.ts` | 差异声明：我们是 push 摄取（变化即解析入库），脏集由 tick 或 watch 事件排空。理由：执行环境日志不是浏览器——没有"请求"时机，等请求=等 tick；但"失效只作标脏、排空统一调度"的形状照抄 |

**从 Vite 明确不采纳的**：WebSocket/多客户端推送（单用户桌面，app-event 出口已建成）；按导出粒度的部分接受（无对应物）；esbuild 预打包独立管线（无对应物）。

## 4. 架构总图

```
┌─ runtime 基础设施（source_graph 模块）─────────────────────────────┐
│                                                                    │
│  notify watcher（P2，可插拔；P0/P1 为 NoopWatcher）                 │
│    └─ 去抖窗（200ms 合并风暴）→ 路径前缀路由 → 标脏                  │
│                                                                    │
│  SourceGraph（source_files 扩展：+byte_offset, +parser_id, +dirty） │
│    ├─ 脏集：本轮待处理文件（tick 查询或 watch 事件填入）              │
│    └─ 检查点比对：size/mtime/offset/parser_version → 软或硬         │
│                                                                    │
│  调度器（排空脏集）                                                  │
│    ├─ can_increment==true  → parse_increment(from offset)           │
│    ├─ can_increment==false → parse_full                             │
│    └─ 每文件产物仍走既有 emit → authority 事务（fact_id 幂等不变）    │
│                                                                    │
│  兜底：截断(size<offset)/轮转/parser 升版 → 硬失效；小时级对账 sweep   │
└────────────────────────────────────────────────────────────────────┘
          │ 执行环境适配器（插件位：实现 SourceParser，不碰 infra 状态）
          ├─ claude-code：JSONL append 解析器（P1 首个）
          ├─ codex / DSH：JSONL append 解析器（P3 注册）
          ├─ DSH zstd / workbuddy sqlite：can_increment=false（全量路径，与增量同住一套调度）
          └─ trust profile 目录出现/消失：注册为 watch-only 消费者
下游：FactsIngested{harness} → 事件总线（已建成）→ 派生重算/通知/app-event
```

## 5. 数据契约

### 5.1 `source_files` 扩展（下一 authority schema 版本）

```text
byte_offset   INTEGER   -- 上次处理到的换行边界；NULL = 首见/不支持增量
parser_id     TEXT      -- 解析器身份（"claude-jsonl" / "dsh-jsonl" / "sqlite-full" …）
dirty         INTEGER   -- 0/1 脏标记（watch 事件填、调度器清）
```

指纹三列（size/mtime/parser_version）原样保留且语义不变；`byte_offset` 只由**解析成功**的事务推进（解析半途崩溃 = offset 不动 = 下轮重读同一段，fact_id 吸收重复）。

### 5.2 `SourceParser` trait（P3 实施后修订：住 domain，注册表在 harnesses）

> **P3 修订记录（2026-09-21）**：trait 原计划住 runtime（"runtime 层冻结接口"）。
> 实施时发现依赖方向是 runtime → harnesses——harnesses 要实现 trait 就必须依赖 runtime，
> 循环。trait 因此下沉 `agent-vitals-domain::source_graph`（纯策略面），执行环境实现
> 住 `agent-vitals-harnesses`（每执行环境 `sources/parser.rs` 一文件一 impl），调度器经
> `harnesses::sources::parsers::{descriptor_for, parser_for}` 注册表查表——runtime
> 不再持有 harness 字符串特判的解析路由。签名同步重塑：`harness()/parser_id()` 合并为
> `descriptor()`，emitter 必需的 `machine_namespace` 经 `ParseContext` 显式传入
> （旧签名漏了它，是 P1b 生产接线绕开 trait 的原因之一），全量-only 解析器的
> `parse_increment` 走缺省拒绝（「解析器谎报」守卫）。

```rust
// agent-vitals-domain::source_graph（纯策略面，无 I/O）
pub struct ParserDescriptor { pub parser_id: &'static str, pub can_increment: bool }
pub struct ParseContext<'a> { pub machine_namespace: &'a str, pub source_profile: &'a str }

pub trait SourceParser: Send + Sync {
    /// 注册行：解析器身份 + 增量能力申报。
    fn descriptor(&self) -> ParserDescriptor;
    /// 世代号，缺省 = PARSER_VERSION（与 sql_sync 重放纪律同源）。
    fn parser_version(&self) -> i64 { PARSER_VERSION }
    /// 增量能力判定：缺省 = descriptor 申报 **且** 检查点已有起读 offset。
    fn can_increment(&self, state: &FileCheckpoint) -> bool { ... }
    /// 从 offset 读到 EOF、停在最后完整换行；缺省拒绝。
    fn parse_increment(&self, ctx: &ParseContext, path: &Path, from_offset: u64)
        -> Result<ParseOutput, String> { Err("no incremental path") }
    /// 全量路径（首见/硬失效/全量申报执行环境）。
    fn parse_full(&self, ctx: &ParseContext, path: &Path) -> Result<ParseOutput, String>;
}
```

**注册面两类（P3 决议）**：trait 背书 = 逐文件语义（claude-code 增量、dsh/workbuddy
显式全量申报——zstd 帧边界 ≠ 行边界、SQLite 行级差量是 §11 非目标）；仅 descriptor
申报 = 跨批语义。**codex 归第二类**：它是批 emitter（跨文件 seen 去重 + 整批配额
折叠），且有三重全文件前缀依赖——fold `last_total_sig` 连续复读去重（中途起读会把
复读判成新事件：同累计值双计且 fact_id 不同，幂等吸收救不了）、route/provider 状态
时间线（事件时刻路由证据必须来自文件前缀，丢前缀 = 静默误归因，违反计费诚实）、
配额快照是整批折叠产物。emit-gate（全扫状态 + 只 emit 新段）是后续可选项，需差分门
重新验证后才能接管。

禁止：解析器持有或推进 SourceGraph 状态（offset 由 infra 在事务成功后写回）；解析器自行起 watcher；解析器直接调 `insert_outbox`（事件发射是调度器写事务内的职责）。

## 6. 失效语义（软/硬，映射 Vite §3-4）

| 判定（检查点比对） | 失效级 | 动作 |
|---|---|---|
| size ≥ offset 且尾行完整 且 `can_increment` | **软** | `parse_increment`，offset 前进 |
| size < offset（截断/重写） | **硬** | 废 offset，`parse_full`，重建检查点 |
| 路径消失（unlink/轮转） | 硬 | 走既有源清理；同名新路径按首见处理 |
| `parser_version` 变更 | 硬 | 无视 offset 全量重放（既有机制，不动） |
| 首见文件（图谱无行） | — | `parse_full` 建检查点（对应 Vite"未分析节点停止传播"） |

## 7. 兜底与对账

- **per-file 全量重读**（§6 硬失效路径）随轮即时执行；
- **对账 sweep**：小时级（tick 计数触发，与每日 maintenance run 同一挂点族），全量 walk 一次指纹比对——吸收 FSEvents 丢事件/合并/coalescing、watch 集合外写入。频率是**正确性参数**，不是性能参数：丢事件最坏延迟一个 sweep 周期；
- 差分门（验收用）：同一文件"全量解析产出"与"增量解析产出"必须逐条 fact_id 一致——增量实现正确性的硬证明。

## 8. 与事件总线的关系

基础设施不新增事件类型：脏集、watch 事件是进程内状态；对外唯一出口仍是**每执行环境批次完成时的 `FactsIngested{harness, run_id, …}`**（既有）。桌面缓存刷新、派生重算链路零改动——SourceGraph 是 FactsIngested 生产端的实现升级，不是新事件源。

## 9. 分期

- **P0（图谱先行，无 watcher）**：`source_files` 扩展三列；调度器改造——tick 从"全量 walk 目录"变为"查图谱脏集 + 指纹对账"，全量重解析保持（未接增量解析器时所有文件 `can_increment=false`）。**收益：发现层成本归零、watcher 无关的架构落位**。
- **P1（首个增量解析器）**：`SourceParser` trait + claude-code JSONL 实现（offset 检查点 + 差分门验证）。**收益：GB 级会话解析成本从全量降到增量字节**。
- **P2（watcher 接入，2026-09-22 已实施）**：notify + 去抖 + 前缀路由 + skills 安装根的 watch-only 消费者注册。**收益：发现时延分钟→秒**。实施：`ingest/watch.rs`（feature `watcher` 门控，不开 = NoopWatcher）；as-built 与原案的四点偏差见 `P2_WATCHER_PRODUCT_REVIEW.md` §7（事件不直接 mark_dirty、去抖手搓、trust 不监听、FSEvents 规范化别名）。
- **P3（执行环境铺开，2026-09-21 实施）**：SourceParser 注册制——trait 下沉 domain、注册表落 harnesses（见 §5.2 修订记录）。claude-code 经 trait 注册（增量），dsh/workbuddy 经 trait 注册并**显式申报全量**（zstd/sqlite，§11 非目标）；codex **仅 descriptor 申报**——批 emitter 的三重全文件前缀依赖使中途起读不安全（决议记录见 §5.2），sync 批路径原样保留。调度器的 harness 字符串特判删除，解析路由只经注册表查表。

## 10. 验收标准

1. **差分门**：claude-code fixture 上，同一批会话"纯全量摄取"与"增量摄取（多次追加）"产出的 fact 集逐条一致（fact_id 级对照，golden 纪律）；
2. 截断/重写 fixture → offset 作废、全量重读、无重复事实（幂等吸收）；
3. 解析半途崩溃（事务中断）→ offset 未推进，下轮重读同段，零丢失零重复；
4. `parser_version` 升版 → 全量重放（既有测试不回归）；
5. 对账 sweep 在人为丢弃 watch 事件后一个周期内补齐；
6. P0 完成后 tick 无目录全量 walk（以现有 harnesses 文件数为对照的 I/O 计数断言）；
7. 事件总线面零变化：词表、FactsIngested 载荷、golden 输出全部不变。

## 11. 非目标

- 不做 DSH zstd 解压增量（全量路径长期共存）；
- 不做 SQLite 行级差量（workbuddy 停留在 mtime 文件级）；
- 不做跨文件依赖图（Vite 的 importers 边在我们这没有对应物——文件之间无依赖关系，派生面按执行环境粒度已够）；
- 不把 watch 事件暴露给事件总线/MCP/导出面；
- 不在 infra 里做任何执行环境 wire 解释（那是 `SourceParser` 插件位的事）。

## 12. 风险与守卫

| 风险 | 守卫 |
|---|---|
| 增量解析漏行（off-by-one 在换行边界） | 差分门（§10.1）是发布前置；offset 只在解析事务成功后推进 |
| FSEvents 合并/丢事件 | 对账 sweep 兜底（§7）；sweep 频率参数化 |
| in-flight 写入读到半行 | 停在最后完整换行（沿用 read_records 纪律）；半行留给下轮 |
| 解析器谎报 can_increment | trait 文档写死判定条件；差分门 fixture 覆盖软/硬两路 |
| notify 依赖（MSRV 1.74） | notify 6.x MSRV 兼容；P2 才引入，前两期零新依赖 |
| 双写 offset 与事实 | offset 推进与事实写入同事务（沿 outbox §1.2 的教训） |

---

**关联文档**：`AGENT_VITALS_EVENT_BUS_ARCHITECTURE_SPEC.md`（下游出口，零改动复用）、`AGENT_VITALS_V0_9_1_SQL_AUTHORITY_MIGRATION_SPEC.md`（指纹与幂等语义的根基）、`FINDINGS_TRUST_EGRESS_MONITORING_SPEC.md` §6.2（watch-only 消费者：skills 目录与 trust profile 目录）。

**研究材料**：vitejs/vite 主干克隆于 /tmp/vite-research（研究后清理；本文所有 Vite 出处以 2026-09-21 主干行号为准）。
