# City 运行期性能日志（2026-11-15）

状态：**已实现**。补的是「运行中为什么卡」，不是加载耗时——加载链路见
[CITY_OVERVIEW_LOADING_PERFORMANCE_SPEC.md](CITY_OVERVIEW_LOADING_PERFORMANCE_SPEC.md)。

## 1. 为什么补

旧日志只有 `data-load`、`sync`、`read_overview` 的加载阶段耗时；运行期没有任何
落盘指标。`onStats` 每秒算一次平均 FPS，只喂 debug HUD，既不入日志，也看不出
200ms 的顿挫（1s 平均会把 200ms 摊成 55fps）。同时 `metric=scene` 的维度键用了
驼峰 `windowDays`，被宿主 `valid_performance_metric` 的「只允许小写」规则拒绝，
`invokeHost` 的失败又被 `.catch(() => {})` 吞掉——所以 scene 从未真正进过
`app.log`，日志里那些 `elapsed_ms=5678` 全是单元测试写进去的。

## 2. 事件与字段

全部落在 `<data_home>/logs/app.log`，目标名 `plugin_performance`，格式为
`时间戳 INFO plugin_performance plugin=city metric=... outcome=... elapsed_ms=... dimensions={...}`。

| metric | 触发 | 维度（全部小写） |
|---|---|---|
| `scene` | 每个阶段完成一次 | `stage`（model/planning/mounting/rendering/first_frame）、`window_days`、`load_id`、`since_load_ms` |
| `data-load` | 每次 City 数据加载 | `attempt_count`、`revision_retry_count`、`fallback`、`window_days`、`page_returned`、`load_id` |
| `frame` | 每 15 秒聚合一次 | `fps`、`p50`、`p95`、`max`、`draw_calls`、`triangles`、`quality`、`idle`、`dpr`（×100）、`geometries`、`textures`、`load_id` |
| `stall` | 单帧 ≥100ms，每秒最多一条 | `phase`（surface/pick/replay/render）、`quality`、`activity`（orbit/game/driving/replay/cinematic）、`pointer`、`load_id` |
| `quality` | 自动/手动画质切换 | `from`、`to`、`reason`（user/auto-low/auto-high；capture 被过滤）、`load_id` |

`elapsed_ms` 的语义：

- `scene`：**本阶段耗时**（距上一阶段完成），不是页面绝对时间；
- `frame`：本次窗口的 p95 帧时间；
- `stall`：该帧耗时；
- `quality`：固定 0（切换本身不耗时，看 `from/to/reason`）。

`load_id` 是一次 City 加载的短生命周期关联号（`L<base36 time><seq>`），只用于把
同一次加载的 data-load / scene / frame / stall / quality 串起来，不含 session、
路径、插件实例或设备身份。

## 3. 采样与保留

- `frame`：15s 一次，约 900 个 60fps 样本；排序求 p50/p95/max，约 1.4MB/天。
- `stall`：≥100ms 且距上一条 ≥1s，避免连续慢帧刷屏。
- `quality`：每次切换一条（导出/拍照的临时档位不计）。
- 日志轮转：2MB × 5 份；加入 frame 后约保留 4–5 天，需要更长窗口先加采样间隔。
- 切页/隐藏恢复后的第一个超大帧间隔会被丢弃，不污染 p95。

## 4. 怎么读

```bash
# 最近 15s 窗口的帧统计
grep 'metric=frame' ~/.agent-vitals/logs/app.log | tail -5

# 一次加载的全部事件（把 L... 换成实际 id）
grep 'load_id="Lxyz"' ~/.agent-vitals/logs/app.log

# 卡顿发生在什么阶段
grep 'metric=stall' ~/.agent-vitals/logs/app.log | tail -20

# 自动画质什么时候升的
grep 'metric=quality' ~/.agent-vitals/logs/app.log
```

判读：

- `p95` 明显高于 `p50`、`max` 出现 100ms+ → 有顿挫，结合 `stall` 的 `phase/activity` 定位；
- `quality` 的 `auto-high` 紧挨着 `stall` → 升档重建 composer/阴影图导致；
- `frame` 的 `idle=true` 且 `fps≈20` → 空闲降帧（设计行为，不是 bug）；
- `draw_calls`/`triangles` 随窗口数据量增长 → 场景预算问题，不是单帧逻辑问题；
- `geometries`/`textures` 持续单调上涨 → 资源泄漏，结合 `load_id` 看是哪次加载引入的。

## 5. 边界

- 没有 GPU 计时（`EXT_disjoint_timer_query` 兼容性差），`stall` 是端到端帧时间，
  不是 pass 级耗时；要拆 pass 需另做 WebGL 查询或浏览器 trace。
- `draw_calls`/`triangles` 来自 `renderer.info`，包含阴影/倒影/后处理的绘制，
  不是主 pass 单独值。
- 日志是同步写文件，`frame` 只做聚合，不逐帧写；不要把采样间隔降到 1s 以下。
- 单元测试不再写真实 `app.log`：`plugin_host` 的 performance 日志在 `cfg(test)`
  下是 no-op，避免再出现 `elapsed_ms=5678` 污染。
