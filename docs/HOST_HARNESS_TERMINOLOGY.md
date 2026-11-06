# Host / Harness 术语与命名迁移

日期：2026-10-03。状态：内部开发阶段，执行不兼容改名；不保留旧 host 接口别名。

## 语义边界

| 名称 | 含义 | 示例 |
| --- | --- | --- |
| `harness`（Agent 执行环境） | 被 Agent Vitals 观测的 Agent 执行、工具编排及会话环境 | Codex、Claude Code、DSH、WorkBuddy |
| `host`（插件宿主） | 加载插件、提供服务并管理生命周期的 Agent Vitals 本体 | `PluginHost`、host API、宿主 WebView |
| `plugin`（应用插件） | 由 Agent Vitals 加载的功能应用 | Agent City |
| `provider`（模型服务来源） | 独立的模型路由/计费来源维度 | OpenAI、第三方网关 |

这里的 harness 不限定桌面 GUI，也包含 CLI Agent 的执行环境。Harness 不等于模型 provider；同一 harness 可以使用不同 provider。历史“宿主适配器/宿主日志/跨宿主统计”分别理解为 harness 适配器、harness 日志和跨 harness 统计；插件架构中的“宿主”则专指 Agent Vitals。

数据流：`harness 日志 → 适配/规范化 → Rust 核心 → Agent Vitals host API → City plugin`。

## 不兼容改名范围

尚无外部消费者，直接统一源码、接口、存储及测试，不提供旧字段/CLI/目录的双轨兼容。

| 旧名称 | 新名称 |
| --- | --- |
| `host`、`host_kind`、`hosts` 数据字段 | `harness`、`harness_kind`、`harnesses` |
| `agent-vitals-hosts`、内部 `hosts/` 模块 | `agent-vitals-harnesses`、`harnesses/` |
| `hostName`、`hydrateHostNames`、`host_display_names` | `harnessName`、`hydrateHarnessNames`、`harness_display_names` |
| `HOST_MANIFEST_DSL_SPEC.md`、host manifest / CLI | `HARNESS_MANIFEST_DSL_SPEC.md`、harness manifest / CLI |
| `host:<slug>`、`hosts.d` | `harness:<slug>`、`harnesses.d` |
| `--host`（Agent 过滤） | `--harness` |

City fixture 与 app-local DTO 的 sessions/findings 使用 `harness`；内部协议不保留 `host` 别名。`PluginHost`、`plugin_host.rs`、City `host.ts` 保持不变，因为它们指 Agent Vitals 插件宿主。网络域名的 `endpoint_host`、`destination_host`、hostname 以及 Vite 自身的 `--host` 属于网络语义，不改成 harness。

## 数据库与验收

Authority schema 升至 v31，列名和相关表/视图采用 harness 命名。发现旧 `usage_facts.host` 列时 writer 拒绝打开，不做字段迁移，也不自动删除用户数据库。开发数据可备份后重建并从原日志重新导入；本轮不会直接操作机器上的已有数据。

golden/fixture 只做可审查的命名转换，不能刷新其他差异来掩盖回归。验证 Rust workspace、Python、Python/Rust golden parity、桌面 UI、City fixture 与 SDK 合约。此前原生插件故障验收报告属于改名前版本；改名后需重新运行，不沿用为新产物证据。

## 已取得的验证证据

- Rust workspace release 测试通过，Clippy `--release --all-targets -- -D warnings` 通过。
- Python 全量 1274 项通过：未启用 Rust 二进制时跳过 210 项；启用二进制后的完整套件通过，仅跳过 8 项。补正一个固定九月 fixture 只检查当前月 ledger 的日期假设，日桶从 ledger/归档读取，66.6M / 197.5M 断言及两侧状态字节比较保留，生产计费逻辑未因此修改。
- Python 与 Rust 各 16 个 golden 案例逐字节通过。仅 generic ZCode 的三个 fact ID 因 `harness:zcode` 身份变化有针对性更新，不批量重生快照。
- 桌面 React 守卫、City typecheck、SDK 15 项合约测试通过；`node scripts/verify-harness-terminology.mjs` 验证改名边界及显示名。
- 改名后的原生完整插件故障回归通过，见 [APP_LAYER_ISOLATION_VERIFICATION.md](APP_LAYER_ISOLATION_VERIFICATION.md)。
- 普通发行 `.app` 重建通过，内嵌独立 City JS/CSS 资源；发行产物与 feature-gated 诊断产物区分。
