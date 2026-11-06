# P2 Watcher 产品评审：是否引入 `notify` 依赖

> 状态：**已拍板（2026-09-22）**——产品所有者选**方案 A**（引入 notify 6.x，feature `watcher` 门控）。实施记录见文末决策记录与 as-built 注记。
>
> 请求者：SourceGraph 基础设施迭代（`feat/source-graph` 分支）
> 决策者：产品所有者
> 关联：`AGENT_VITALS_SOURCE_GRAPH_INFRASTRUCTURE_SPEC.md` §9-P2 / §3-P2、`FINDINGS_TRUST_EGRESS_MONITORING_SPEC.md` §6.2

---

## 0. 一句话问题

**runtime crate 的 Cargo.toml 明文禁 `notify`（纪律禁项）——是否放开，让桌面 app 的文件发现从"5 分钟 tick 全量目录 walk"升级为"写事件即时触发"？**

## 1. 禁令的来历（不是随意）

Cargo.toml 注释原文：
```
# **不加** `notify`/watcher/`tokio`/`chrono`（那是 feature 或纪律禁项，不是结构重构）。
```

三类东西放在一起禁——共同点是**每个都是"引一个生态就长出一片"的入口**：
- `tokio`：引了就要 async 化，全 crate 的函数签名连锁改动；
- `chrono`：时间处理已有自己的纯函数实现（`clock.rs`），引 chrono 会造出两套时间口径；
- `notify`：引了就开启"事件驱动 vs 轮询"的架构分裂面——每个新功能都会争论"该走哪个通道"。

禁令的精神是**防依赖蠕变**，不是"文件事件监听本身有害"。

## 2. 引入的量化收益

### 2.1 时延（唯一的增量收益）

| 场景 | 现状（5min tick） | watcher 后 | 增量 |
|---|---|---|---|
| 新 skill 装入 → Skill tab 可见 | ≤5 分钟 | ≤2 秒（去抖窗） | 分钟→秒 |
| 新会话文件出现 → 首条事实入库 | ≤5 分钟 | ≤2 秒 | 分钟→秒 |
| 会话追加一行 → FactsIngested 事件 | ≤5 分钟 | ≤2 秒 | 分钟→秒 |
| Skill 描述修改 → 体检缓存失效 | ≤5 分钟（下一次手动扫描） | ≤2 秒（自动失效） | 手动→自动 |

### 2.2 发现层成本（次要收益）

| 场景 | 现状 | watcher 后 |
|---|---|---|
| 每 tick walk 目录树 | `~/.claude/projects` 几百文件 + `~/.codex` + `~/.dsh` 各一轮 stat | 零（事件驱动） |
| 每 tick 逐文件指纹比对 | 全量 stat + classify | 零（只处理事件到达的文件） |

实际成本估算：~/.claude/projects 约 300 个文件 × stat 耗时（微秒级）≈ **每 tick 约 3ms**。watcher 归零这 3ms——真实影响**可以忽略**。

### 2.3 不引入不会丢失的功能（诚实声明）

以下功能**在 5min tick 下已经完整可用**，watcher 只是加速：
- 增量摄取（GB→增量字节）——P0/P1a 的核心收益，来自 SourceGraph 检查点，不依赖 watcher；
- 事件总线（FactsIngested → 派生重算 → UI 刷新）——已建成，与发现机制正交；
- trust 传感（30s 轮询）——信任面已有自己的轮询循环，不共用文件 watcher。

## 3. 引入的量化成本

### 3.1 依赖足迹

| 项 | 值 | 影响 |
|---|---|---|
| notify 6.x 直接依赖 | 1 crate | 低 |
| 传递依赖（macOS） | fsevent-sys + libc + bitflags + walkdir（已有）| **+3 个新 crate** |
| MSRV | 6.x 支持 Rust 1.72（[notify-rs](https://github.com/notify-rs/notify) 官方保证） | **✓ 兼容本项目 1.74** |
| 代码量 | ~2000 行 Rust + FFI 绑定 | 编译时间微增 |
| 维护活跃度 | [notify-rs](https://github.com/notify-rs/notify) 社区维护，下载量 >40M | 高（rust-analyzer/ra-mold 等在用） |

当前 runtime crate 12 个直接依赖、全部是 workspace 内部 crate + rusqlite + serde。加 notify 是**第一个"纯平台基础设施"型外部依赖**。

### 3.2 架构分裂面（禁令真正防的东西）

引入后，文件发现存在两条路径：
```
路径 A（watcher）：事件到达 → mark_dirty → 下次 classify → 处理
路径 B（tick 兜底）：5min walk → stat → classify → 处理
```

两条路径**必须永远并存**（watcher 丢事件需要兜底），每个新执行环境接入都要决定"哪些目录走 A、哪些走 B"。这个决策面**每个功能都会遇到**——它就是依赖蠕变的入口。

缓解方案（spec §3 已设计）：
- SourceGraph 是唯一状态注册表，两条路径都写同一个 dirty 标记；
- watcher 是**可选层**（`NoopWatcher` 模式，Vite 同款），无 watcher 时 tick 照常工作；
- 新增目录监听 = `watch_registry.register(path, harness)` 一行，不选边。

### 3.3 平台差异

| 平台 | 后端 | 注意事项 |
|---|---|---|
| macOS（本项目主平台） | FSEvents | ✓ 原生、延迟 ~1s、有事件合并 |
| Linux | inotify | ✓ CLI 用户可能用 |
| Windows | ReadDirectoryChangesW | ✓ 本项目不正式支持但 notify 覆盖 |

FSEvents 的 [安全模型注意事项](https://developer.apple.com/documentation/coreservices/file_system_event_security)：不属于自己的文件事件可能受限——对本项目影响极低（我们监听的就是用户自己的 `~/.claude`/`~/.codex` 目录）。

### 3.4 能耗与资源

| 项 | 影响 |
|---|---|
| 常驻线程 | 1 个（watcher 的事件循环） |
| CPU 空闲时 | 零（FSEvents 是内核推送，非轮询） |
| 内存 | watch descriptor 每目录约 100 bytes |
| 电池影响 | 正面（替代每 5 分钟的目录 walk） |

## 4. 替代方案对比

| 方案 | 时延 | 依赖成本 | 架构分裂 | 推荐 |
|---|---|---|---|---|
| **A. 引入 notify 6.x** | 秒级 | +3 crate | 有（但可控） | ✓ 如果"实时"是产品需求 |
| B. 缩短 tick 周期（5min→30s） | 30 秒 | 零 | 零 | ✓ 如果"准实时"够用 |
| C. 维持 5min tick（现状） | 分钟 | 零 | 零 | ✓ 如果延迟不痛 |

**方案 B 的诚实评估**：把 tick 从 5 分钟缩到 30 秒，发现层成本从 3ms×12次/小时 变为 3ms×120次/小时 = 360ms/小时 ≈ **每小时代价 0.36 秒 CPU**——几乎免费。时延从"最坏 5 分钟"变为"最坏 30 秒"，已覆盖大多数"新会话/新 skill 装入"场景。这是**零依赖的准实时方案**。

## 5. 决策建议

### 如果选 A（引入 notify）

1. 放开 Cargo.toml 注释（改为"notify 允许，feature = `watcher` 门控"）
2. SourceGraph spec §9-P2 激活（watcher 接入迭代开工）
3. 首批监听目录：`~/.claude/projects/` + `~/.codex/sessions/` + `~/.dsh/sessions/` + 六个 skills 根
4. 永远保留 tick 兜底（watcher 丢事件自愈）

### 如果选 B（缩短 tick）

1. `TICK_PERIOD` 从 300s 改为 30s
2. 观察真机能耗与用户感知
3. 如果仍不够实时，回来重新评审 A

### 如果选 C（维持现状）

1. 更新 spec §9-P2 标注"评审决议：维持轮询"
2. 依赖纪律保持不变

## 6. 我的倾向（供参考，不是决定）

**倾向 B（先缩短 tick 到 30 秒），观察一个月再决定是否引入 A**。理由：
- B 的成本几乎为零（每小时代价 0.36 秒 CPU）
- B 能覆盖 A 的 80% 使用场景（"新 skill/新会话及时可见"）
- A 的架构分裂面是**永久的**——一旦引入就无法退回（watcher 路径的消费者会形成依赖）
- 如果 B 一个月后用户反馈"30 秒还是太慢"，那时 A 的收益论证会更有力

---

**决策记录**（拍板后填写）：

| 决策 | 签字 | 日期 | 备注 |
|---|---|---|---|
| 方案 A：引入 notify 6.x，feature `watcher` 门控，tick 兜底保留 | 产品所有者（会话内拍板） | 2026-09-22 | runtime `optional = true`；desktop 显式启用；CLI/wasm 默认构建零该依赖 |

## 7. As-built 注记（实施与原案的四点偏差，2026-09-22）

实施位置：`crates/agent-vitals-runtime/src/ingest/watch.rs`（注册表/路由/去抖核 +
notify 适配器）、`apps/desktop/src-tauri/src/lib.rs::start_source_watcher`（接线）。

1. **watch 事件不直接 `mark_dirty`、watcher 线程不碰权威库**（对 spec §3-P2
   原案的简化）：tick 的目录 walk + 指纹对账每轮本来就全量 stat（实测 ~3ms），
   是失效判定的唯一权威；事件只负责「早点唤醒那趟对账」。省掉 watcher 线程
   开权威库写连接引入的 SQLITE_BUSY 争用面。
2. **去抖手搓，不引 notify-debouncer-full**：超时驱动单线程（最后一个事件
   落定后等 `DEBOUNCE=1.2s` 派发一批）。依赖足迹实测（workspace lock）：
   +5 包（notify、crossbeam-channel、crossbeam-utils、filetime、
   fsevent-sys）——评审表低估为 +3，验收 L2 订正（libc/bitflags/walkdir
   为既有依赖）。
3. **trust profile 目录不监听**：trust 传感自身 2s 轮询已是亚秒级时延，
   watcher 无增量。spec §9-P2 的 watch-only 清单收敛为 skills 安装根
   （`scanner::DEFAULT_ROOTS` 的 home 相对部分，变更 → 失效桌面 Skill 体检
   的进程内报告缓存 `SkillsScanState::invalidate`）。
4. **FSEvents 规范化路径别名**：macOS 把 `/var/…` 上报为 `/private/var/…`
   （`std::env::temp_dir` 一类符号链接路径必然发生）。挂载成功后为每个根
   补 canonicalize 别名，别名映射回同一执行环境/回调下标（路由器显式回调索引，
   追加别名不移动既有下标）。

真机验证（macOS 26 / arm64）：写入被监听目录 → **1.62s 收到 tick 唤醒**
（`cargo test -p agent-vitals-runtime --features watcher -- --ignored`，
真实 FS 事件测试因平台时序不进常规门禁，spec §12 允许）。

Sources: [notify-rs GitHub](https://github.com/notify-rs/notify) · [notify on crates.io](https://crates.io/crates/notify/6.1.1) · [docs.rs/notify](https://docs.rs/notify) · [FSEvents security model](https://developer.apple.com/documentation/coreservices/file_system_event_security) · [notify-debouncer-full](https://crates.io/crates/notify-debouncer-full)
