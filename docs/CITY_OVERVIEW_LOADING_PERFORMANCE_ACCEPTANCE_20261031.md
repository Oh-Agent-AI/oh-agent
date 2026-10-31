# City 首屏统计加载性能验收 — 2026-10-31

状态：**P0 SQL 门槛通过；完整端到端验收未完成**。本报告记录可复现的合成 SQL 验收和一次打包应用诊断链路冒烟，不宣称完整端到端预算已经通过。

## 1. 结论

- `usage_facts_event_time` 索引后，366 天每日 activity 在 Rust bundled SQLite 上 p95 **195.152 ms**，低于 SPEC 预算 1 s；p50 相对无索引快 **51.92×**，高于 5× 门槛。
- 索引前后 20 组样本的 366 行结果逐行相同；查询计划命中 `SEARCH ... USING INDEX usage_facts_event_time`。
- 1000 条 fact 顺序写入从 20.850 ms 增至 32.168 ms（约 54% 额外开销），索引一次性构建 3.965 s，索引占用 1,486,848 bytes。
- 打包应用诊断链路可区分 host SQL、IPC、UI 数据完成、场景阶段；10 个启动后的成功样本中 IPC p95 为 1,441 ms。样本数仍低于 SPEC 要求的 20，因此该项只作为冒烟证据。
- 场景 `first_frame` 一次有效样本为 9,302 ms，明显慢于数据阶段，应作为独立 P1/场景性能问题处理；不得用数据阶段达标掩盖。
- 未发现性能日志输出路径、session、标题、token 或错误原文；日志只包含受控枚举、档位和计数/耗时。

## 2. 环境与构建

| 项目 | 值 |
| --- | --- |
| 参考机 | Mac15,6, Apple M3 Pro |
| 内存 | 19,327,352,832 bytes（约 18 GiB） |
| 磁盘可用空间 | 35,239,936 KiB（约 33.6 GiB，验收时 APFS 数据卷 93% 已用） |
| OS / 架构 | macOS 26.5.2 (25F84), arm64 |
| 代码 commit | `fada5d00ed432a8c584b6e075b5a4231f53177b6` |
| 分支 | `codex/city-overview-performance` |
| SQLite | 3.45.0（Rust bundled SQLite 路径） |
| 数据生成 seed | `20261031`（可用 `CITY_PERF_SEED` 复现） |
| 后台写入 | SQL 基准无后台写入；打包冒烟使用隔离 `AGENT_VITALS_HOME`，无用户生产库 |

打包遵守仓库规则：通过 `cargo tauri build --bundles app` 构建并用 `open` 启动 `.app`，没有裸运行 `agent-vitals-menubar`。

## 3. SQL 验收

命令：

```bash
CITY_KEEP_DB=1 cargo test -p agent-vitals-query --release \
  --test city_v3 synthetic_city_activity_sql_acceptance_100k -- --ignored --nocapture
```

数据集：

- 总 facts：100,090；active / non-null time facts：100,070；sessions：300。
- 分布覆盖 366 个本地日；包含空时间和删除样本。
- 请求：rolling 366 天，时区 `Asia/Shanghai`；预热后 20 次独立请求。
- 结果行数：366。

聚合结果：

| 指标 | 无索引 | 索引 |
| --- | ---: | ---: |
| p50 nearest-rank | 9,728.074 ms | 187.382 ms |
| p95 nearest-rank | 10,562.977 ms | 195.152 ms |
| max | 11,359.103 ms | 195.457 ms |
| p50 speedup | — | **51.916×** |

其他成本：

- 索引构建：3,964.722 ms。
- 索引大小：1,486,848 bytes。
- 数据库文件：44,142,592 bytes。
- 1000 条写入：无索引 20.850 ms；有索引 32.168 ms。

查询计划：

```text
SEARCH f USING INDEX usage_facts_event_time (event_ts_ms>? AND event_ts_ms<?)
```

原始样本：

```text
unindexed_ms = [
  9801.750041, 9823.109917, 9834.920875, 9728.074166, 9777.902833,
  10356.934750, 10562.976833, 11359.103459, 10371.248250, 10099.599958,
  9446.968958, 9123.118167, 9581.624417, 8971.755667, 8878.997500,
  8831.056000, 8846.408833, 9633.777583, 10051.173750, 9558.062833
]
indexed_ms = [
  187.893458, 189.765333, 187.156416, 186.366250, 185.579750,
  190.052917, 187.391750, 184.626167, 185.773792, 186.343666,
  186.992833, 187.501000, 187.410750, 187.308166, 186.728083,
  192.404042, 195.151958, 191.461291, 187.381792, 195.457166
]
```

## 4. 打包应用冒烟与诊断

使用隔离合成库启动 `.app`。本轮收集到 12 个 `city_load_finished outcome=success` 样本，其中前两个靠近启动/首次打开，后 10 个用于启动后的观察性子集：

- `city_ipc_finished`（host IPC 返回）：n=10，p50 1,229 ms，p95 1,441 ms，max 1,441 ms。
- `city_load_finished`（UI 收到有效投影）：n=10，p50 1,551 ms，p95 2,016 ms，max 2,016 ms。
- 原始 IPC 后 10 样本：`1375, 1229, 1441, 1395, 1196, 1349, 1164, 1153, 1192, 1242` ms。
- 原始 UI load 后 10 样本：`2016, 1551, 1804, 1760, 1495, 1670, 1471, 1476, 1499, 1552` ms。

场景样本：

```text
city_scene_stage stage=model       outcome=success elapsed_ms=1787 window_days=366
city_scene_stage stage=planning    outcome=success elapsed_ms=1808 window_days=366
city_scene_stage stage=mounting    outcome=success elapsed_ms=6596 window_days=366
city_scene_stage stage=rendering   outcome=success elapsed_ms=9117 window_days=366
city_scene_stage stage=first_frame outcome=success elapsed_ms=9302 window_days=366
```

`elapsed_ms` 是该 WebView 页面内的单调时钟绝对值；`first_frame` 到达时间约 9.3 s。该项证明首帧瓶颈已从 SQL 转到场景挂载/渲染，必须单独优化，不纳入本 P0 SQL 结论。

样本数与口径限制：

- SPEC 要求 5 次冷启动和 20 次暖态端到端；本节只有打包诊断冒烟，未按受控冷/暖流程补足，因此不判定端到端门槛通过。
- 本轮观测到少量自动化操作引起的 `cancelled` 或 `fallback_v2` 日志；这些不是性能基线样本。没有发现 revision retry。

## 5. 隐私检查

检查隔离 `logs/app.log` 中的 `city_v3` 与 `city_perf` 行，匹配以下敏感模式无命中：

```text
/Users/|/var/folders|title|session_key|token|api|password|secret
```

实际日志仅包含：

- `city_overview_stage`：stage、elapsed_ms。
- `city_overview_finished`：operation、window_days、outcome、elapsed_ms。
- `city_ipc_finished`：operation、window_days、outcome、elapsed_ms。
- `city_load_finished`：outcome、elapsed_ms、attempt_count、revision_retry_count、fallback、window_days、page_returned。
- `city_scene_stage`：stage、outcome、elapsed_ms、window_days。

host 单测覆盖 `performance.city_scene` 只接受有限 stage/outcome/数值档位，且要求活动 City 插件身份。

## 6. 回归与构建

已执行：

```bash
git diff --check
cargo test -p agent-vitals-query --release --test city_v3
cargo test --release --lib city_scene --manifest-path apps/desktop/src-tauri/Cargo.toml
cd apps/agent-city/ui && npm run typecheck && npm run build
cargo clippy --release --all-targets -- -D warnings
cd apps/desktop/src-tauri && cargo tauri build --bundles app
```

结果：

- query `city_v3`：15 passed，3 ignored。
- desktop `city_scene`：2 passed。
- City UI typecheck/build：通过。
- clippy：通过。
- Tauri `.app` bundle：通过。
- 先前分支验证已通过 `cargo test -p agent-vitals-data --release`、query lib tests、root workspace tests、Python suite（1289 tests OK，209 skipped）和打包冒烟。

已知 desktop 测试失败在 base 与分支一致，属于预先存在问题：`read_calendar_month_is_cross_harness_not_dsh_only`、`read_hourly_distribution_matches_authority_facts_day`、`manifest_catalog_http_enforces_stream_limits_and_refuses_redirects`。

## 7. 发布与回滚风险

- schema v32 → v33 为加性 partial index 迁移；中断后可重试。旧二进制可能声明不认识 v33 或忽略新索引，不建议直接删除索引作为应用回滚方案；应按既有 schema 兼容矩阵评估。
- 索引增加约 1.42 MiB 和约 54% 的 1000 条顺序写入耗时；对写入密集场景需保留观察。
- 首帧耗时 9.3 s 说明后续应评估场景资产/构建流程或 P1 渐进展示；不能通过缩短 366 天窗口或静默缺失统计来解决。
- 本轮端到端样本不足；发布前必须补足 SPEC 第 8 节要求的冷/暖样本和一次后台写入场景。
