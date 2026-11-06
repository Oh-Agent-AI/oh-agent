# City 验证运行器

在 apps/desktop/ui-dev 执行：

```sh
npm run verify:city:fast
npm run verify:city:module -- network
npm run verify:city:module -- sites
npm run verify:city:module -- planning
npm run verify:city:module -- display
npm run verify:city:full -- --report /tmp/city-full-report.json
npm run verify:city:full -- --no-cache --report /tmp/city-full-cold.json
```

verify:city 仍表示完整验收。full 保留迁移前32个阶段（含seaside tier10），并增加
typecheck、验证基础设施守卫及生产build。失败立即结束，返回非零；报告标明未运行阶段，
不能把fast/module通过当成full通过。不提供golden更新选项。

模块范围由 scripts/city-kit/verification.mjs 显式维护；未知模块拒绝执行。
共享数学、加载器、基础设施或不确定影响范围的修改须跑full。
fast包含五组合成守卫与一座真实岛的独立生成对照；它不是缩小版普查。

仅审计过的纯只读规划守卫在同一进程运行，其余独立子进程。跨引擎与求解确定性守卫
不共享计划缓存。地理/布局守卫使用原生加载器，原种子和断言保留，跨引擎仍单独检查。
新增守卫更新manifest与对应模块范围；新环境变量必须显式登记，运行后恢复。

规划缓存为有界64项进程内LRU，键包含所有City源码、加载器、依赖锁、Node环境、
工厂来源、配置内容、seed/tier和options。配置顺序不影响键，配置原地改变使键失效。
失败不缓存；无缓存模式仍运行全部检查。重复生成的确定性测试调用原工厂。
复用前后检查已有缓存对象未被只读守卫修改，需要修改的守卫须独立生成。

报告逐阶段耗时、状态、总墙钟时间及共享kit的生成数/命中数、慢seed、半径重试和RSS。
共享kit统计只覆盖cachedPlan调用，不等于整个套件所有原始生成次数；RSS不是全子进程
峰值内存。当前不作持久化缓存或默认并行，也不宣称固定倍数提速。

首次落实分层入口、进程内复用及耗时定位；跨进程统计/分片并行在测量后再实施。

## 本轮验收（2026-10-09）

隔离分支 codex/city-verification-speed，以0bbc284d为基础；无生产City算法改动、无golden更新。
fast全部通过，最终一次2.172秒；no-cache fast全部通过，2.291秒。
full全部35阶段通过，总计1144.353秒（约19.1分钟），共享缓存命中176次、实际cachedPlan生成115次。
该计数不包括独立子进程中的原始生成。现场有其它测试进程并行运行，这些数据是验收记录，
不是受控的新旧版本速度对照，不据此宣称完整套件固定倍数提速。

已定位重型阶段：survey 445.741秒（独立集120岛+回归集120岛），
seaside tier10 258.624秒，geography 68.837秒，layout 49.967秒。
共享30岛后，context 1.640秒、baseline 1.405秒；所有断言仍执行。
后续优先测量普查分片与海滨阶段重复布局成本，不先降低种子覆盖。

报告由--report输出JSON；测试集合、每阶段状态与耗时可审阅。
本轮报告：/tmp/city-fast-final.json、/tmp/city-fast-no-cache.json、
/tmp/city-full-verification-native.json（临时路径不作为长期证据仓库）。
