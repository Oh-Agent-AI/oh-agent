# City 首屏统计加载性能验收 — 2026-10-31

状态：**P0 SQL 门槛和点击 City 到首次有效数据投影的冷/暖门槛通过；后台写入行为受控。场景首帧是独立未闭环瓶颈，本报告不据此宣称整体视觉首屏达标。**

## 1. 结论

- `usage_facts_event_time` 索引后，366 天每日 activity 在 Rust bundled SQLite 上 p95 **195.152 ms**，低于 SPEC 预算 1 s；p50 相对无索引快 **51.92×**，高于 5× 门槛。
- 索引前后 20 组样本的 366 行结果逐行相同；查询计划命中 `SEARCH ... USING INDEX usage_facts_event_time`。
- 受控打包端到端样本为 5 次冷启动和 20 次暖态 City 加载，全部成功。点击 City 到首次有效数据投影：冷启动 p95 **1,022 ms**；暖态 p95 **1,313 ms**，低于 2 秒门槛。host IPC 暖态 p95 为 **1,222 ms**。
- 场景首帧仍需独立优化：本轮冷启动观察到一次 `first_frame` 为 **5,078 ms**；更早冒烟为 **9,302 ms**。数据阶段达标不表示“首次可见城市”达标。
- 后台写入受控场景中，6 次 City 加载全部成功；其中 2 次遇到 `revision_changed` 并各重试一次（最多 `attempt_count=2`），没有 v2 降级、无限等待或跨快照展示的证据。
- 未发现性能日志输出路径、session、标题、令牌或错误原文；日志只包含受控枚举、档位和计数/耗时。

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

## 4. 受控打包端到端验收

使用隔离 `AGENT_VITALS_HOME`、合成 100k 权威库和 `.app` bundle。应用通过 `open` 启动，未裸运行 `agent-vitals-menubar`；未触碰用户生产库。

### 4.1 冷/暖样本

按 SPEC 采集 5 次重新打开应用的冷启动和 20 次已启动后的暖态 City 加载。所有 25 个基线样本均为 `city_load_finished outcome=success`。以下百分位使用 nearest-rank。

| 指标 | 冷启动 p50/p95/max | 暖态 p50/p95/max |
| --- | ---: | ---: |
| `city_ipc_finished` | 894 / 1,009 / 1,009 ms | 890 / 1,222 / 1,309 ms |
| `city_load_finished` | 907 / 1,022 / 1,022 ms | 894 / 1,313 / 2,252 ms |

原始样本：

```text
city_ipc_finished cold = [1009, 910, 894, 877, 817]
city_ipc_finished warm = [
  793, 875, 1309, 884, 853, 865, 873, 830, 1222, 985,
  1097, 855, 1009, 890, 846, 917, 1069, 1169, 997, 1037
]
city_load_finished cold = [1022, 923, 907, 889, 830]
city_load_finished warm = [
  798, 880, 1313, 888, 857, 869, 877, 833, 2252, 989,
  1101, 858, 1012, 894, 849, 922, 1077, 1172, 1002, 1041
]
```

样本解释：

- 自动化流程另外产生 1 次 `fallback_v2` 失败和 1 次 `cancelled` 事件；两者不是基线成功样本，已排除。
- 一个暖态成功样本包含 `attempt_count=2, revision_retry_count=1`（2,252 ms）；它是有效数据投影成功，因此保留在基线内。
- 没有缺失统计或静默降级；基线样本的 `fallback=none` 且 `page_returned=299`。

### 4.2 场景观察

冷启动样本中一次有效场景链路为：

```text
city_scene_stage stage=model       outcome=success elapsed_ms=1115 window_days=366
city_scene_stage stage=planning    outcome=success elapsed_ms=1127 window_days=366
city_scene_stage stage=mounting    outcome=success elapsed_ms=3904 window_days=366
city_scene_stage stage=rendering   outcome=success elapsed_ms=5030 window_days=366
city_scene_stage stage=first_frame outcome=success elapsed_ms=5078 window_days=366
```

`elapsed_ms` 是该 WebView 页面内的单调时钟绝对值。更早打包冒烟的 `first_frame` 为 9,302 ms。两项都说明场景挂载/渲染是数据完成后的主要瓶颈，应作为独立 P1/场景性能问题处理；本 P0 数据门槛不掩盖该问题。

## 5. 后台写入场景

在另一个隔离 `AGENT_VITALS_HOME` 中复用同一合成 100k 库，并在 `state/source-controls.json` 排除全部四个内置执行环境，避免自动化数据目录继续扫描本机日志。应用只通过 `.app` + `open` 启动一次；同一应用内完成 1 次基线 City 加载和 5 次暖态重载。

写入器向 `usage_facts` 插入合成 fact 并推进 authority revision：8 次事务提交，约 40 秒；最终 `authority_revision=9`，库内 facts 为 100,098（新增 8 条）。所有 City 查询期间应用只读打开隔离库，不修改用户生产库。

结果：

- 6 次 City 加载全部成功，`page_returned=299`。
- 2 次 host IPC 返回 `revision_changed`；前端各执行一次 revision retry，最终 `attempt_count=2, revision_retry_count=1, fallback=none`。
- 最大 UI 数据完成时间为 1,706 ms；没有无限等待、v2 降级或把 pending 当成空结果的日志证据。
- 场景首个 `first_frame` 为 3,006 ms，仍单独归入场景渲染瓶颈，不用于数据投影预算。

背景写入样本：

```text
city_ipc_finished = [
  787, 867, 841(error:revision_changed), 829,
  841, 860(error:revision_changed), 841, 844
]
city_load_finished = [
  799/attempt=1, 873/attempt=1, 1676/attempt=2, 844/attempt=1,
  1706/attempt=2, 848/attempt=1
]
```

## 6. 隐私检查

对受控冷/暖、后台写入和早期冒烟的隔离 `logs/app.log` 中的 `city_v3` 与 `city_perf` 行执行敏感模式检查：

```text
/Users/|/var/folders|title|session_key|token|api|password|secret|Admin|machine_namespace|fact_id|native_session|working_dir|cwd
```

三轮均无命中。`error:revision_changed` 是受控稳定错误码，允许保留。实际日志仅包含：

- `city_overview_stage`：stage、elapsed_ms。
- `city_overview_finished`：operation、window_days、outcome、elapsed_ms。
- `city_ipc_finished`：operation、window_days、outcome、elapsed_ms。
- `city_load_finished`：outcome、elapsed_ms、attempt_count、revision_retry_count、fallback、window_days、page_returned。
- `city_scene_stage`：stage、outcome、elapsed_ms、window_days。

host 单测覆盖 `performance.city_scene` 只接受有限 stage/outcome/数值档位，且要求活动 City 插件身份。

## 7. 回归与构建

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

## 8. 发布与回滚风险

- schema v32 → v33 为加性 partial index 迁移；中断后可重试。旧二进制可能声明不认识 v33 或忽略新索引，不建议直接删除索引作为应用回滚方案；应按既有 schema 兼容矩阵评估。
- 索引增加约 1.42 MiB 和约 54% 的 1000 条顺序写入耗时；对写入密集场景需保留观察。
- 数据投影 P0 已达标，但场景首帧仍显著高于数据阶段；后续应单独评估场景资产/构建流程或 P1 渐进展示，不能通过缩短 366 天窗口或静默缺失统计解决。
