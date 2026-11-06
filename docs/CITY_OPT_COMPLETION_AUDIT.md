# City 优化完成审计

目标：完成 `CITY_NETWORK_FIRST_OPTIMIZATION_PLAN.md` 的剩余任务，包括提升优先级的 J；
不能把某一小批提交、相关单测通过或截图变好替代整个目标。实施分支 `worktree-city-opt`。
本表是未完成项台账，不修改原 SPEC 的范围和合并标准。

## 2026-10-13 U5 作业账本接入生产热点（默认政策/UI取消仍待）

`createCityPlan` 可接收 `workLedger`；同一同步作业及其所有半径尝试共享作用域，
嵌套操作不得换新账本，异步回调明确拒绝并恢复作用域。收费接入半径尝试、模型候选硬检查、
连接策略/A*扩展、地形场查询、修复及网络克隆、事务和派生地块。
这里的 terrainSample 统计工作事件（解析场调用及地块采样检查），不是互不重复的空间点数量；
cloneRow 统计已接入复制器的对象行，不冒充所有分配字节或全入口复制覆盖。
已完成的拒绝草稿费用不退回；模型基础与派生捕获器对终态中止重新抛出，
提交前检查取消状态。中止不返回整城半成品，验证回调取消不发布网络/版本；
跨打包终态错误按稳定 code/detail 识别，不依赖同一个 Error 构造器。

生产专项通过：原始/计量结果全部可序列化字段相等、地形查询相等；真实半径重试不重置、
真实A*扩展累计、生成中途取消、基础检查器不吞中止、补丁取消零副作用、复用账本跨请求累计。
单个命名样本 `4005969553/t1` 记录 candidate=1063、terrainSample=1102340、cloneRow=154697、
transaction=156、radiusAttempt=1、derivedRow=547；其自身无A*扩展，A*另用合成真实连接验证。
这些数字只作为计量见证，不构成四档默认限额或性能p95标定。最终冻结后的28项快速检查均通过，
报告 `/tmp/city-opt-budget-wiring-frozen-fast.json`；typecheck/build通过。
没有把旧完整套件/普查结果继承成这次源码的最终門禁。

未完成：所有手写复制/生成入口累计覆盖、默认操作数限额与预算耗尽策略标定、
PlanningWorld共享账本投影、worker分批/取消及CityExperience错误传播、最终同源码联合验收。
普通UI生产调用尚未传账本，原Outcome的全图预算pending原因保留；不宣称U5或全目标完成。

## 2026-10-13 U5 累计操作账本原语（生产接入尚未完成）

新增 `planner/operationBudget.ts`，明确七种工作量（candidate/terrainSample/expandedState/cloneRow/
transaction/radiusAttempt/derivedRow）的非负安全整数限额和累计消耗。一个作业复用同一账本，
拒绝草稿不退款；多维收费原子检查，耗尽或取消锁定为终态，后续 publication 检查不能通过。
快照、限额和接口只读；输入 getter 只读一次，拒绝继承属性收费、负数/非整数/未知维度与溢出。
固定维度顺序保证首个耗尽原因不依赖 charge 属性枚举顺序，无墙钟参与候选结果。

新增守卫已通过并登记 fast/planning/full；typecheck 与 diff 检查通过。
该原语尚未接入生产生成、连接、地形、克隆、半径重试、worker/UI取消或默认限额标定，
因此 U5 和全目标仍未完成，不能把原语单测当作整城预算验收。
正在运行的全套件/四档普查继续保留其启动时生产版本 `a86a4f89` 的证据范围；
新增原语未被这些生产入口消费，当前分支新增文件/manifest 的最终整体验收仍须另行绑定。

## 2026-10-13 全目标续作：完整套件归因修复与场景差异导出

在生产源码 `a86a4f89` 上启动完整无缓存套件。前五项通过（含四态真实场景注册表），
第六项 `verify-city-villa-placement` 因仅允许 `resiteWetShoreSites` 归因失败；
该项最终模型基础、全部注册约束、逐道路/高架实体净距、必要需求、容量与终态检查均已通过。
只读复现确认 `1703310796/t2` 的未求解庄园存在 467 个基础规划水下样点，
求解后基础水下/间隙/埋入均为零；实际接受策略为 `roadThroughSite/nudgeSitesOffRoads`，
它在候选阶段查基础后同时消除了道路冲突与基础失败。
归因守卫现按相关物理约束接受记录检查，并新增未修复基础失败见证与 owner 姿态改变断言；
没有移除或降低任何终态物理/网络/容量断言。该守卫重跑通过，完整套件重启；未跑项不记通过。

场景只导出当前描述到本机 `/tmp`，未改仓库 golden。main `11ac496a` 相对旧基线
380 昼/夜各 54 个分区改变、1600 昼/夜各 47 个分区改变；city-opt 相对 main
380 昼/夜各 11 个分区、1600 昼/夜各 8 个分区改变，涉及道路、堤道/设施和邻近装饰。
“main 也失配”不等于分支没有变化；这些分区仍须结合生成语义与实际图像审阅后才能更新基线。
四档原普查独立运行中；原目标 U0–U5、A–F/J、物理/入口、预算/取消及最终消费者覆盖仍逐项保留。

## 2026-10-13 声明通行开口与路口阻塞修复

`4000104729/t3` 的两个路端相距约 0.5197，但接合前后的 12 宽主干距拱墩均约 8.2454；
旧终筛按外侧净距要求 6+3=9，故拒绝接合。原跨路选址及骑路约束没有执行相同的全路幅检测，
而模型声明的 16 宽车辆通道本来就是穿过两墩空洞；外侧退距与声明通行空间被混为一类关系。

新增共享 `siteRoadClear`：普通外侧净距保持 3；只对两处必需车辆入口声明构成的对向通道检查入口轴、
整段全宽横向容纳及全部地面实体路肩正间隙。超宽、横穿、偏移碰墩、未知模型和畸形数据拒绝，
不以建筑名或种子豁免实体检查。生产选址/搬迁传实际道路宽度，骑路约束与走廊终筛消费同源判据。
改变的是声明通道内的关系合同，不是将普通净距或吸附距离调小；全模型竖向/基础证据仍 pending。

目标样本已通过真实节点接合（`snapNearEdgeJunctions` 接受 1 项，拒绝 0），全部注册约束归零。
十岛具名回归、四种朝向的通道反例/宽宿主拒绝、原修复安全守卫、27 项快速套件、SiteSpec、
UI typecheck/build 已通过。三档原验收集 30 岛复跑通过原上限：`unjoinedGroundJunctions` 为零，
除 `crowdedArterials` 1 岛（`4002722954`，原上限 2）外，全部注册约束零违例。
此批使用原种子公式 `4_000_000_000 + i*104_729`、所有注册 measure 与原 ACCEPT_CEILING，
没有增大容差。目标样本另经 `CITY_CROSS_ENGINE_PASSAGE=1 node scripts/verify-city-cross-engine.mjs`
确认 V8/JavaScriptCore 摘要一致（仅 1 岛，不是默认 30 岛跨引擎验收）；编辑器 patch/sites 守卫通过。
该原验收样本已用于定位，本次属于回归证据，不冒充新的盲测。尚未复验最新源代码完整四档及默认跨引擎批次，
场景 golden 未刷新，main 未合入本次修复。

## 2026-10-13 当前关键任务收尾（最终批次验收中）

按用户最新要求，先完成当前关键故障再同步 main；完整优化路线图的能力覆盖仍单独保留。
本批回退了未起效的 `networkRepairs.ts` 弯支路实验，改修联合绕行源头：两腿连续路也检查固定端点方向，
拒绝把主干道折回到来向。`2003037141/t1` 原锐角三岔已恢复，原注册约束均为零。

名义圆与真实占地的分歧通过共享带符号实体间隔解决：联合邻居保留模型身份和姿态，重叠度量检查完整俯视投影、
同类实例与稳定 pair id；最终入口姿态重查地形及路幅。未知模型/海上岛保留圆代理，不改 renderer 尺寸或缩小预留数据。
让位候选现在包含邻居主网接入的隔离路网提案，共用 64 次终筛预算；因此原被“离旧路太远”拒绝的 park 候选可连路后接受，
而不是丢掉体育场。岸线候选先查基础，干燥道路冲突也进入联合改路；桥头补完整路幅干地内移候选。

具名守卫已扩至 `2003037141`、`2005655366` 及六个已报告验收失败样本；八岛均通过所有注册约束、
两项必需设施唯一落位/入口挂主网、无未满足需求、真实容量及世界终态一致性。该已知问题回归不冒充新的盲测。
快速套件 27 项通过，UI typecheck/build 与编辑器 patch/controller/sites/bulldozer/remap 通过。
主批 30 岛的五项原统计均为零；后续具名断言发现 `2005655366/t1` 仍用名义圆判实体重叠，
已改用同源真实投影间隔，未放宽间隔。另在 `1703342472/t5` 发现港口与庄园投影冲突，
补登记沿岸重叠联合修复；该样本所有注册约束归零，纳入具名守卫（共九岛）。
最终源代码修订的九岛具名守卫、typecheck/build 及快速套件 27 项均再次通过；
快速报告为 `/tmp/city-opt-closeout-fast-final.json`（本机证据，不是可长期依赖的仓库附件）。

完整四档 survey 尚未通过：前一修订的 t1 60 岛通过原上限（松弛断头 1、锐角 1、主干扎堆 2），
t3 30 岛失败于 `4000104729` 的一处未接地面路口，零违例上限保留。
相同几何失败已在未修改的 main `11ac496a` 独立复现；不是本批新增，但仍是验收阻塞项。
拒绝证据为接合路幅与设施包络冲突，不能通过扩大吸附或略过包络校验处理。
上述 t1/t3 批结果早于最新重叠修复，不冒充最终修订整批验收。
跨引擎复验因源代码修改终止，未取得最终等价结论。
场景基线四态失配也在未修改的 main 独立复现，原 golden 保留；尚未完成新的基线契约审查。
因此本批仍不记作可合并，main 未合入这些修复。

原路线图的全模型/入口物理覆盖、整城累计预算/取消、冷启动性能预算与注册表完整实例覆盖尚不在上述成功证据内。
本批产物仍为 `degraded`，没有把 pending 改成 success，没有放宽验收上限或按种子修改生产规则。

## 2026-10-13 实际楼体高架净距与当前续作状态（整体未完成）

`planBulldozer` 的会话楼搬迁候选此前只用地块代理通过 `validateBuildingMove` 的高架净距，
在真实跨河高架复验中，`session:213`、`session:129` 虽已搬迁，实际楼体矩形仍与新桥面冲突。
现候选还须用 `buildingRect(building, parcel)` 对本次新建高架几何执行 0.5 净距检查；
不放宽净距，也不删除/隐藏会话楼。`verify-plan-bulldozer.mjs` 通过，真实380城跨河高架
推平1处设施、搬迁12栋会话楼，终态没有楼体落在新桥面下；地面桥、普通新路及滨海大道
情形也通过。`verify-plan-repair-controller.mjs`、UI typecheck 与 `git diff --check` 通过。

本次验证仅闭合该编辑器高架搬迁回归，不代表规划生成/全档完成。此前完整planning批次
因tier5长耗时中止；独立档位、跨引擎、视觉、性能预算与全局约束仍未验收。B0–B4仍有
登记表记录的未完成项；本工作树仍有未提交文件，本条不记作整体完成或main合并门禁通过。

### 规划主批复跑实况

本轮在 `68cd5be1` 源码重跑 `CITY_VERIFY_PROGRESS=1 node scripts/verify-city-planning.mjs`：
10/10个tier1、10/10个tier2与3/10个tier5样本完成；tier5的
`1703294958`、`1703302877`、`1703310796`分别约181s、182s、245s。第四个
`1703318715/t5`持续满CPU超过10分钟且没有完成输出，手动中止（exit130），因此该运行
不是通过；累计23/30，未到批次汇总断言。用户级性能问题得到明确复现种子，但仍没有生产
阶段归因或性能预算通过证据。不能把前三个大岛完成视作tier5通过。

### 2026-10-13 纯几何热点优化与半径实验结论（整批仍未完成）

新增两项不改变规划准入判定的优化：`planFootprint.fromProjection` 对确定性投影结果做有界64项LRU；
`roadBlocks` 用32单位网格筛选候选包围盒，再执行原精确SAT，避免对全部既有地块做O(n²)全扫描。
验证新增投影重复调用复用断言与窄面相向地块真实重叠拒绝；UI typecheck、city-radius、
road-blocks、parcel-frontage、plan-bulldozer及diff-check通过。尚无完整30岛重跑和稳定冷启动
性能预算证据，因此只算局部热点修复，不声称tier5阻塞已解除。

提交`23021d9c`后单独重跑该tier5种子，145029ms终态成功，16项注册约束全为0、容量满足、
groundFailures为空；但仍需13939/2700地块、4286条道路、1716个街区，规划状态为degraded。
与此前相同种子约153s相比仅约5%改善（不同单次运行不能当成稳定基准），证明空间索引/投影
缓存不是6倍耗时主因，也不能证明性能预算通过。

后续热点收口将`corridorViolation`内每样点临时`{x,z}`分配改为标量坐标，仅在返回失败诊断时
创建对象；坐标表达式、纵横采样、判定顺序和阈值不变。UI typecheck、connect、road-rules、
diff-check通过。尚未在固定环境做前后A/B，也未重跑慢tier5样本，因此只记作降低热循环分配的
局部优化，不声称端到端性能收益或约束批次通过。

半径校准试验发现目标样本`1703318715/t5`在maxAreaGrowth=2下由2360/2700跳至13939地块，
运行约153秒；1.1设置在约34秒到2718地块，但出现siteInWater约束违例。为保持规划正确性，
已撤销1.1生产调参及其只检查容量/过建比例的样本特例断言，不把局部更快作为可接受结果。
根因仍是道路骨架/面生成随半径变化而非单调，后续应实现并验证有界候选半径搜索，按容量、
全约束与质量共同选择，而非仅收紧乘数。该方案尚未实现，原30岛/多档/跨引擎/视觉/性能
门禁、B0–B4与main合并要求均仍未闭合。

随后根因核实：`tier5`样本的central-station绑定入口已保护其移动；规划准入对精确renderer地面外廓判干，
但`siteInWater`仍按较大的名义圆判湿，两个阶段对同一对象用了不同占地能力。现将精确内陆footprint
的水约束改为同一4单位地面外廓采样，proxy及岸边规则不变；sitespec反例守卫证明名义圆外、实体外的湿点
不再拒绝干燥实体，同时未知模型仍保留圆形保护。`verify-city-planning.mjs` 30岛批次终态exit0：急角0、
路穿用地4、缺入口0、拥挤主干0、松弛断头0，既有批次阈值通过。相同tier5慢样本用1.1面积步长重测：
32682ms、2718/2700地块、1127道路、340街区、required unmet0、groundFailures空、16项约束全0，
状态degraded仅因整图物理覆盖与预算取消能力仍pending。这个定点证据证明新口径消除了原水约束冲突，
但尚不证明全 seed/tier 半径策略安全；生产参数暂未调整，仍需多档普查、跨引擎与性能验收。

同轮`verify-city-survey.mjs`在tier1独立验收集（60 seeds）处exit1，尚未进入调优集与后续tier。
失败计数：siteWithoutDoorRoad 2/60（上限1）、roadThroughSite 5/60（上限0）、sitesOverlap 2/60
（上限1）。将六个报告种子在提交前`ecb988fe`基线的临时只读worktree重跑，三类约束逐种子结果一致；
因此这是分支已有独立样本残留，不是本次水度量变更引入。未提高上限；door-road样本分别为sail-opera
离路gap43和east-stadium候选/邻居阻挡；道路穿越与重叠样本集中于villa-complex基础/走廊及stadium
联动，须作为后续独立验收修复。该全survey因首个集合失败而中止，不能宣称四档独立验收通过。

## 2026-10-12 对象注册表协作接口（B3前置，非整批完成）

生成器现导出cityLayout.checkSitePlacement(layout, footprint, occupied, options?)。
footprint须带真实blockId，缺失或重复宿主拒绝，不猜最近街区；尺寸由消费者提供实际renderer
外廓，occupied须排除移动对象自身。生成器与接口共用同一layoutPlacementEnvironment，
检查真实面/洞、完整道路、高架及原site/occupied圆代理，显式返回原partial scope。
默认采样上限沿用500000，支持调用者剩余采样预算和取消；不是全城全操作预算完成。
专项验证纯函数、真实洞、后段弯路、occupied/site、高架、未知/重复宿主及预算/取消；
typecheck通过。生成器选择逻辑未改，编辑器尚未消费这个接口，不能记作B3完成。
B0完整siteClasses、B1全部名称派生、B2实例拾取及B4配套稳定id/旧补丁映射均仍未完成；
学校/商场/医院仍civic:index，不因市政用地已有固定id而记作B4完成。

### B0准备层：类别/目录与布局来源登记

新增纯siteClasses模块，登记8个族、30个类；31个目录条目恰有一个类归属，五个会话目录
共享data:session。六个布局数组按kind/来源分类；致敬模型标题引用原纯模型叶声明。
face-lot/face-reserve/parcel模式及minimumSize引用既有renderer声明，未硬写宽深常量。
未知类保持unknown；支持class#instance与旧decor:site:kind查询，不改既有生产拾取返回值。
实际实例包络/高度尚缺，pendingCapabilities显式保留，不把plot圆或旧PICK_HEIGHT冒充实体。
合并city-civic-*及city-public-sites-*在同族多个类共享：目前只登记元数据，不能将此当作
唯一网格实例归属证明；B2须根据piece/实例映射区分类别，仍待接入。
守卫验证目录/标题、唯一类id、合成六数组分类、未知类、原minimumSize及生成器依赖方向，
登记manifest66项、fast/planning/sites。typecheck与专项通过；真实380/1600全实例唯一id、
renderer外廓/拾取高度、场景逐字节前后对照、全场景网格归属及编辑器跨层守卫尚未执行/实现。
该准备层检查点a67dbfe6没有生产消费者导入siteClasses，未改生产规划/渲染逻辑；
仍不记作B0完整验收通过。

### B1生成器名称消费者接入（编辑器部分仍待）

registry.CIVIC_LABELS改从SITE_CLASSES派生；cityDecor的市政设施、背景楼、花园、海滨、
聚合与火山标题读取注册类，正文/通用fallback与市政厅原总览语义保持。
相对a67dbfe6的33个完整describeDecor输出（含未知/通用id）JSON逐字节一致，
未改生产选址、场景几何、decorKindForName或uiOverlays返回id。
typecheck、site-registry、models（1110parts）及i18n-catalog（302entries）通过。
site-registry新增运行时名称派生/fallback断言；编辑器controller.SITE_LABEL仍未迁移，
真实场景前后逐字节对照仍待，因此不是B1全项或B0–B2整批验收通过。

### B2声明驱动拾取与已知实例（合并市政网格仍待）

decorKindForName现查siteClasses.meshNames，精确名优先；未知地标不再静默继承宽前缀。
同族合并网格仅返回共同decorKind，不声称已定位具体类；异路由匹配failclosed。
civicPieces已知mesh/index现返回decor:civic:kind#civic:id，不再丢实际实例id；
城区地标仅在layout中恰有一个district实例时返回class#instance，缺失/重复退为类级。
describeDecor忽略实例尾部后读取类文案，城区地标修正为随规模出现，不再致敬地标。
CityExperience城区数据面板同时接受新旧id，并保留含冒号的district身份；市政总览仍保留
decor:site:civic。没有将市政合并网格的nearest-point/radius推测升级为精确实例id。
新增实际THREE mesh/parent-chain专项、错误instanceIndex、缺失/重复district与旧id兼容；
typecheck、registry、models及i18n通过，新增英文分类键；production build session25094
exit0（254modules、3.69s），仍有大chunk警告，不作为性能预算通过证据。
重复civicPieces拒绝及旧district类查找补齐后，build session9318再次exit0（3.54s）。
真实380/1600全城网格归属/拾取前后对比、浏览器交互、编辑器优先消费实例与PICK_HEIGHT
删除、未知模型外廓和稳定id迁移仍待，因此B0–B4未整体完成。UIUX检索未匹配本问题，
采用通用一致性检查保留市政/城区功能面板、关闭和聚焦操作；不增加无关视觉/交互变化。

### B2真实场景拾取回归与子造型别名

新增独立scene守卫：380/1600合成会话、full背景、昼夜，实际CityParts遍历与旧52faeefe
分类器独立对照，不更新golden。首跑session81114 exit1捕获真实子网格
city-landmark-twisting-deco-tower未注册，被父级twist-tower接管的回归。
现由原twist-tower类登记exact meshRoutes别名，保留旧子造型route/标题，不新增假layout
对象或重复目录归属；siteClassOf把唯一展示别名回读到原类，合并族仍不猜具体类。
修复后session78985 exit0：380档136实例（civic8/garden4/district4/context107/landmark7/public6）、
422可拾取mesh、853civic部件；1600档332实例（30/4/4/280/8/6）、459mesh、3392部件。
两档昼夜均有32个城区地标mesh。六数组每实例恰归一类，当前layout身份全局唯一；
与旧逻辑实际可拾取集合逐对象相同，非城区地标route不变，配套部件读取真实实例id。
守卫进入manifest67项及planning/sites（不塞fast）；harness session33682、typecheck、
models、i18n及metadata专项通过。此证据不是独立前后完整场景图哈希或GPU/浏览器验收，
也不证明模型instance外廓/高度、所有市政设施精确身份、稳定id迁移或B3已接入。

### 基础失败的初始道路快照与联合定线证据

diagnose-city-ground-stages在初始shore前私有深拷贝network实际边/宽度，不使用trunk名义
中心线假定路幅；全部边（含桥）按实际width/2+3保守XY检查，高架10.5全宽+1保持。
仍只检查原264位置；不发布候选，不改生产朝向、路网、owner、预算或阈值。
1703350391/t2 session10657 exit0：55初始边，69基础合格位置中65实际全宽冲突、
4原owner-spacing拒绝，零直接可准入；2003037141/t1 session85985 exit0：72边、
32基础合格位置中2原湿/中心拒绝、28实际路幅冲突、2owner-spacing拒绝，仍零直接可准入。
这否定“只取消初始圆筛即可修复”的假设，不能把ground-only合格位置当实际空地。
联合定线线索：前者16位置只剩道路阻挡，报告前5均为同一12宽主干两相邻段
24.97:307.5/29.82:343.17与29.82:343.17/34.67:378.84；后者3位置只被12宽
119.35:-406.59/137.53:-437.66阻挡。示例均在原搬迁岸线界限内、无桥头近接、
原名义邻居预留及高架清净。必须联合修改这些道路与owner并通过事务/最终网络/入口检查，
不能删除道路或把上述counterfactual记录为已修复。操作尚未实施，完整规划验收仍失败。

### 联合改线原语及曲线lineage（选址操作仍待接入）

NetworkPatch新增relineEdges：仅ground-road，保留同一edge id、原两端及所有宽度/等级/
purpose属性；非法/退化/自交/折返/重复操作或与拆边混用拒绝。预览/校验失败零副作用。
同id但points已变现在进入paths journal，不再把保留身份误当成保留几何。
remapRoadPath按完整旧曲线的显式有序span替换（含反向/外接前后段），丢失旧折点的局部
引用不能靠空间猜测；冲突lineage拒绝。车流、岸路与街区边界消费同一journal。
新增4旋转×9/12路幅、preview/stale/validator、双向曲线、含前后段、街区引用、局部缺失
与lineage置换拒绝守卫，network-patch/connect/repair-safety及typecheck通过。
新自交检查有16edge/patch、256point/edge输入上限，明确预算拒绝；不宣称U5全局账本完成。

求解守卫揭示旧测试输入缺polygon/parcel尺寸/主网，并沿用旧“任意修改都加网络版本”断言。
ea8750c8源码确认初始化同样直接读取block.polygon.length；现在初始化/源校验失败在候选
枚举前返回planning-world-initialization-refused，生产不合成几何或主网。旧不完整输入保留
为拒绝负例；正常测试明确提供测试面/尺寸/主网，容量/异常零副作用断言保持，新增site-only
只加site域、不虚增network域验证。初始两次solve测试因旧输入终态exit1，修复后session17777
终态exit0：28策略/10目标约束、6岛after<=before与双次确定性通过；不是完整30岛或基础
全覆盖验收。随后新操作输入边/点上限、原路幅合法性与无曲线span时的空集合分配快路
经network-patch专项复验。道路/owner联合搜索与两个命名样本恢复仍待。

### 联合落位/保端点改线接入（原失败样本尚未恢复）

jointSiteRoad操作接入原resiteWetShore的400位置之内；未增加位置/搬迁半径。
只有可搬迁、未绑定且具有complete-conservative-renderer-xy声明的owner参与；实际基础
合格、原岸线/湿圈/邻居/地块/服务/高架条件不变，tentative以外或immutable预留拒绝。
六节点visibility图（两端+四个外扩外廓角）仅用于提案；每条弧检查真实实体并集与全路幅+3，
不把AABB作为实体占地、不堵塞声明空洞；复用原700/160/chord×2.5路线长度限制。
原等级/宽度/两端/身份/lineage保留，桥/引道和未注册deck高程碰撞拒绝，新地面接触拒绝。
道路与owner仅在同一求解草稿内修改，最终拒绝两者都不发布。

专项首次失败捕获roadThroughSite仍用0.7r圆代理，误拒实体全宽已经清净的路线。
现该约束与nudgeSitesOffRoads共用declaredGroundRoadClear：只有完整XY能力走实际实体，
沿用道路半幅+3；未知/仅局部声明仍保留0.7r/0.85r圆规则，已登记但失效的模型拒绝。
trunkRuns也消费journal并随接受事务发布，避免新图与后续主干查询分叉。
新专项涵盖真实注册模型基础恢复、原12宽主干、network/site两域同时加版、双向car/trunk
引用、晚期拒绝零副作用、旧圆误拒消除、未知模型原圆保护、绑定/桥/端点/地块/未知拒绝。
typecheck/joint-site-road/envelope/network-patch/connect/repair-safety及harness通过，
manifest68项，新增专项进入fast与network/planning/sites。

现有恢复样本1703310796/t2 session6469 exit0保持全部原验收。1703350391/t2
session52947与2003037141/t1 session83278均exit0诊断，但最终Outcome仍failed，不能当修复成功。
拒绝细分session19246/31105：前者126基础合格位置中45占地策略、60邻居、21道路端点位于
未来实体包络；后者63位置中26占地、33邻居、4道路端点位于包络。没有可保端点的联合提案。
下一层必须把路口节点/关联边纳入权限与依赖闭包，或在容量预留前联合布局；不能删除端点、
降主干等级、跳过已有地块/固定owner或把它们当吸附缺口。全局预算/取消/完整模型仍待。
前次6岛回归session51285结果句柄已失效，进程检查确认不再运行，未取得终态，不能计为通过。当前源重新运行session32580，待终态；本轮联合道路、网络补丁、模型包络专项均exit0。无缓存full/独立集/跨引擎/视觉门禁未闭合。

## 2026-10-12 声明驱动实际走廊准入：一个庄园阻断恢复（最新，整体未完成）

- 本批已提交为8881f482（基于bb76bc87）。完整渲染XY外廓与局部ground-only声明现在分别登记；
  只有明确声明schema1/complete-conservative-renderer-xy的模型才能在迁移候选中使用实际并集
  road/highway净距。未知或仅ground声明仍走原圆保护；无新增模型名分支。
  原3单位道路setback、10.5高架全宽与1单位sidewalk、岸线68界限、circle湿预算、邻居plot、
  原400候选/120搜索半径、服务距离与既有地块预留均保持，不删owner/路、不缩小模型。
- 实际renderer守卫覆盖6个id×4个yaw×昼夜，每个mesh的所有顶点都须在同一凸外廓片内，
  防止仅分散顶点落入并集却有未覆盖跨度；另验证capability alias、缺XY声明的legacy保护及
  实体压路拒绝。外廓不是完整基础/门/高程通行证明，wholeModelReady仍false。
- 1703310796/t2真实恢复：R583.4109452474155、容量1546/1080，庄园仍r34、同yaw，
  从(358.808185,-297.703930)迁到原候选(472.418959,-288.291595)。基础实际海面下478→0、
  gap6.85→0，groundFailures清零，25项required unmet0，Outcome.failed→degraded。
  命名独立guard session13229 exit0：全部registered约束0、完整道路/高架XY净距、必要需求、
  owner保留、容量、派生发布及修复归因通过。不是通过删除庄园或把失败期望改为容忍。
- 2003037141/t1仍失败，required-placement session43434 exit1保持原degraded期望不降低。
  4个XY暂清候选都超岸线68限制（70.78–71.18）并与working-harbor名义plot重叠，
  没有直接取消岸线/固定港口保护。后续需联合姿态/道路/预留修复，不能把4候选当合法位置。
- 两样本诊断增加remainingPolicyCandidates，逐项列wet/coast界限、owner/parcel引用、
  主网距离、nominal高架与实际投影区别。1703310796原12候选中只有两个满足原岸线等条件，
  它们真实高架外廓清净但旧circumscribed-circle拒绝，提供本次准入迁移的证据。
  类型检查、envelope/ground/repair-safety专项通过；manifest65项登记新的命名回归。
  最新完整planning/无缓存full/跨引擎/独立集/视觉/性能仍未完成，不能合并main。

### 单位置岸线朝向反事实与回归重跑

诊断脚本新增原400位置逐项局部岸线朝向反事实：只对私有诊断owner临时改yaw，finally恢复，
不改生产策略、名义位置或搜索预算。2003037141/t1 session87364 exit0：345占地/岸线、
9道路、46邻接拒绝，仍无预筛通过；1703310796/t2 session97550 exit0：347占地/岸线、
5道路、31邻接、17高架拒绝，仍无预筛通过。第二样本已修复的旧朝向候选不能被
更差的自动朝向替代；没有据此接入生产yaw改写，也不能声称穷尽所有可行姿态。
完整planning session17602终态exit1，止于2000000000/t1的1处未接近接关系，未执行30岛主批。
同源码仅禁用新XY capability对照session10872：R390、293边及同一关系完全一致，
证明该失败不是8881f482的庄园走廊权限造成。不得把旧30岛通过代替当前默认围合版本。

### 共享走廊节点联合定线（2026-10-12）

近接拆边后的exact straight-ground重复子段原未启用严格coalescing，现调用既有权限：
同形状/结构/purpose、保留双lineage和较宽等级；不删独立支路。新增已知答案验证12宽宿主、
8宽支路、车流与宿主折线引用均保留。只有开启该权限仍不能解决生产样本的锐角，未放宽35度。
endpointRelineCandidates现覆盖与更宽宿主共享stem的degree2弯点：仅原0.5近接范围识别，
在原24定线范围/16候选上限接向既有宿主路口；固定/绑定入口、桥、结构或purpose不兼容拒绝。
四旋转合成成功/拒绝、网络补丁、connect、repair-safety及typecheck通过。
2000000000/t1 session78908：未接关系1→0，联合定线与锐角修复有归因，R390不变；
体育场仍未满足，Outcome.failed保持，不称全岛完成。较早13941仅开启coalescing仍exit1。
本批已提交为6a86232b。新版完整planning session20252终态exit1：通过全部10个t1样本，
随后在1703350391/t2因villa-complex的foundation-gap、foundation-water、foundation-relief
失败；不是30岛通过，尚未完成t2/t5主批。保持原基础准入断言，不以已修命名样本替代主批。

### 冻结源码游戏回归终态及新增基础阻断

6a86232b源码的game模块session95642终态exit0：8/8阶段通过（含typecheck与harness），
总时383951ms；race生成80、fallback0、unavailable0，world覆盖12布局2013障碍盒。
这是游戏模块证据，不证明完整planning、无缓存full、物理模型全覆盖或跨引擎验收通过。

新增1703350391/t2诊断session17220 exit0：R551.5432893255071，原400位置预筛拒绝
299占地、39道路、62邻接。实际XY暂清的5个位置均仍与observation-tower及working-harbor
名义预留重叠；其中仅3个主网距离满足原54上限。其岸线满足原104.205853界限，
高架实际外廓清净，但邻居尚无实际实体声明，不能直接忽略其plot保护。
同位置局部岸线yaw反事实未改善预筛分布；未改生产yaw、候选数、岸线或邻居保护。
6a86232b重新诊断session62642 exit0确认同一画像：26项required unmet0，但solve前后
庄园位置不变，实际海面下250个基础样点、maxGap4.9334435514642685，Outcome.failed。
初始岸线264候选有63个基础可行位置被旧圆道路筛拒绝，另6个被owner-spacing拒绝；
这只证明阶段合同不一致的排查方向，不证明63个位置满足完整实际路幅或其它约束。
后续修复须统一初始选址/后置迁移/最终约束的已声明实体净距合同，并完成未知邻居的
真实声明或联合预留修复；不能将这些暂清候选标作合法落位或把基础失败改为容忍。

## 2026-10-12 全折线消费者与实体外廓检查（最新，整体未完成）

- 背景建筑仍沿用原半对角线+路幅/2+0.5净距，只把首段查询改为整折线；地价查询同样
  读取真实全部段，不扩大净距或候选预算。酒店布局守卫过去从不包含酒店的layout.blocks取样，
  现改为真实使用的酒店地址；背景净距与配套朝路守卫也核查全部段。
  完整layout session87133 exit0，8酒店实际地址检查通过，背景auto700为218（此前221/旧源码），
  全落位/增量/配套/车流保持；不能将背景减少解释为已解决全城性能问题。
- 子agent额度中止后root接手其未完成modelEnvelope，补齐独立守卫、错误几何拒绝与
  零额外间距下重叠/接触不能算clear的修正。真实footprint及overhang并集按renderer rotationY
  投影，与名义plot circle分别输出；未知邻居只能proxy/unsupported，不伪造实体证明。
  模型部分数/凸顶点数沿用物理声明上限；这不是完整操作/全城预算闭环。
- 类型检查、model-envelope独立专项通过；manifest64项并加入full/fast/sites/planning，
  harness coverage session43526 exit0，diffcheck通过。模块未替换生产circle硬筛，
  XY空间事实始终partial，缺入口、高度通行和完整物理；不得宣称庄园落位已修复。
- 原400候选只读联合事实复现：2003037141/t1 session52315 exit0，63干基础候选中50与真实
  全路幅冲突、9与未知owner代理冲突/缺失，4处XY事实暂清；1703310796/t2 session24504
  exit0，106干基础候选中72与真实全路幅冲突、22与未知owner代理冲突/缺失，12处XY事实暂清。
  相邻实体额外间距只按0核查；plot、高架、入口、服务及已用地块合同仍待验证，无候选发布。
  4/12不是合法位置数或最终可解证据；两样本仍Outcome.failed，不符合main合并门禁。

## 用户编辑修复接入（2026-10-11，未实现）

新增 `CITY_PLAN_REPAIR_HANDOFF.md`，登记当前阻断样本、分支未提交改动迁移边界、
选择/预览/依赖闭包/验证/原子接受/撤销/派生合同及新增门禁。
没有创建新worktree、提交或合并。用户参与编辑不取消A–F/J、U0–U5或已有合并要求；
“快速收敛”目前为工作方向，不能把未实现编辑器当成已修复庄园或全目标完成的证据。

### 预留后地址容量核算（2026-10-11）

生产layout新增sessionCapacity，按最终实际地址、used预留和会话绑定计量，不复用规划的
预留前capacity。输出reservedParcelIds、availableForSessions、assigned/free、unassigned及
未表示的overflow；重复身份、未知引用、未标occupied的分配或非法aggregate count明确invalid。
aggregate只能核算总数，缺少逐会话来源仍显式count-only；不声称物理/服务容量通过。
类型检查、独立capacity守卫及500→780生产layout-placement session92115 exit0；
原4花园/4地标、11→17配套及原工作预算不变。加强旧地址检查为完整位置/尺寸而非仅id。
新守卫登记manifest63项/full/fast/planning/display；新版完整full、跨引擎和视觉尚未重跑。
manifest coverage session81019 exit0；完整地址几何保留加强后的layout-placement session11837 exit0。
此前冻结布局源码指纹不适用于本次新增报告字段，两个真实庄园阻断仍未解决。

## 2026-10-11 真实道路围合与模型基础准入（最新，整体未完成）

- 默认生产地块已改由最终接受道路围合面派生；旧网格仅保留显式诊断开关，无静默回退。
  凹面、孔洞保留真实边界，路幅耗尽的凸面必须给出空面证书；未支持面仍在覆盖分母中。
  铺地消费者在隔离图层裁剪真实面/孔洞，扣除道路、高架与设施圆代理。
  block-surface命令级守卫通过，但不是像素/视觉验收；新增2048²临时RGBA图层约16MiB尚待实测。
- 2003037141/t1默认路径所测R536.1861435942972、容量1146/540；2005445908/t1
  同原R551.5432893255071及原港口姿态、容量1075/540。两者必需设施落位、registered约束0、
  unmet0、派生发布ok，结果仍degraded。此前1615容量及旧半径不适用于最新默认路径。
- 港口复用原40宿主候选层，声明shore-plot-boundary代理gate，原位置合法地面接入通过；
  未挪owner、未扩大吸附、未新增桥。代理gate不是实体模型门/完整通道证明。
- 车站真实外门沿局部+z，原-z穿入大厅；共享渲染参数及实际mesh方向守卫已修正并通过。
  仍不代表整个平台、轨道、基础与车辆通道物理覆盖完成。
- 展示裁剪现在按使用中地块的当前版本frontage宿主和有序主网路径保留接受边；失效引用显式
  列入unresolvedParcelFrontage，不重新吸附到附近道路。布局守卫新增相应检查及全折线净距。
- block-placement、block-lot-candidates、model-ground、villa-physical、block-surface五项
  独立专项本轮exit0；前三者验证有界采样、累计预算/取消、失败不发布及真实包络，不宣称完整物理。
  庄园原坏位置三处真实基础1441采样中479低于实际海面，541低于规划干地阈值；
  ground注册目前仅villa的partial声明，未知/零占地模型仍unsupported，不能缩减15模型分母。
- 五项新守卫纳入manifest（59项），其中road-derived-plan为生产planning门禁，其余四项另纳fast。
  花园/配套/城区地标的实际占地消费者和基础准入正在集成；最新完整布局、planning及
  独立四档、跨引擎、视觉、CPU/内存、U0–U5全局预算尚未完成，不符合合并条件。
- 本轮fast session18028在connect阶段因模块循环初始化失败exit1，不能报告套件通过。
  connect入口经cityPlan/shorePlotAccess回读未初始化CONNECTOR_CONFIG；共享40候选上限现提取
  至无依赖connectionBudget，参数不变。新增connector-first冷启动/共享值一致守卫；
  connect、loop、landing、shore专项及typecheck随后exit0，完整fast仍需稳定源码重跑。
- manifest coverage独立session92222 exit0；road-derived-plan独立session18400 exit0。
- 布局session58817终态exit0：真实host/主网路径保留及当前版本检查、逐段折线净距、
  全落位/增量稳定/配套生长通过。该进程加载早于本轮新配套选址与ground生产准入，
  不作为这些后续改动的集成验收证据。
- fast session80872终态exit0，21阶段（含typecheck/harness）约52.9s；加载早于最终配套接入。
  当前另增parcel-frontage守卫并注册manifest60项，核对当前实际宿主段、法向、路肩半宽、
  地块前沿、版本/路径，专项exit0；仅核对冻结证据几何一致，不替代重新采样/实体门证明。
- model-ground已接入岸边siting/solve及事务接受，Outcome增加完整实例分母与groundFailures；
  未注册/零占地对象仍unsupported，注册失败不能只报degraded。合成“16圆采样干、真实基础入水”
  场景能按原候选预算搬干，网络版本保持、site版本推进，独立守卫通过。
  真实1703310796/t2 session46688仍失败：R583.410945、容量1546/1080，villa基础478点低于
  实际海面，groundCoverage13=0partial+1violation+12unsupported，unmet0也必须failed；
  原湿岸候选耗尽未找到合法位，不算修复。2003037141新required-placement session96110也因
  Outcome.failed未通过，正在定位，绝不把期望改成容忍failed。
- 酒店lotClearOfRoads原只核查首段并1.5间距采样，已替换通用旋转矩形与所有折线段精确
  capsule净距；弯折后段穿楼、四朝向与边界专项通过。酒店入口尚未声明，所有使用中的酒店
  单列unsupportedAuxiliaryFrontage，displayOutcome明确failed，不能从普通frontage通过推导酒店接通。
- 配套消费者新增模型叶声明、真实包络筛查和共享layout采样预算v1（500000），不是新增route
  搜索或snap放宽；花园最小26.55×13.13、裙楼17.02²，不靠缩小到模型不能容纳尺寸放行。
  初500会话样本session69728：全落位、无massing、4花园/11配套/4地标、19项placed。
  尚待计量版完整layout session43157终态；也不替代实际模型mesh全覆盖、视觉或总建城预算。
  同地址id在道路/模型版本改变时并不保证坐标不变，旧地址重用及整面预留后会话容量仍待闭环。
- 最终consumer完整layout session72978 exit0；加载及结束engine指纹均
  `86a83e6acaaaaf54c84bac0fc67c6a69789b91399918721600ceca49ea91ce22`。
  最新500→780专项session3322同版通过：4/4花园、4/4地标、11→17配套，19/25项应有对象全placed；
  旧session地址及旧11配套完整姿态/城区均保留。共享采样49969→52367/500000。
  actual layout-envelopes逐真实渲染顶点与旗布风极值专项通过，但仍无基础/实体门/视觉验收。
  两项layout新守卫纳入manifest62项；最终fast session1883全部23阶段exit0，build session82546
  exit0（存在大chunk警告，未改变阈值），diffcheck通过。历史43157不是最终版本证据。
- required庄园根因诊断51080/57093 exit0：所有阶段名义基础始终违规，非后置yaw忘检。
  初始原264候选被circle-wet222、circle-trunk34、owner-spacing8拒；其中32处基础采样已干。
  solve原400候选被owner-footprint-unsafe345、road-envelope9、owner-spacing46拒，
  其中63处基础采样已干但仍被旧代理挡住。干基础不等于路/其他owner实体安全，不能跳过硬筛。
  可复现：`node scripts/diagnose-city-ground-stages.mjs 2003037141 1`，仅内存插桩及合成City数据。
  下一批须统一已注册真实footprint并集/全路幅准入或联合道路重定线，未注册仍proxy/pending，
  不扩大原候选/吸附范围。本轮未修复这两个真实庄园失败，仍不能合并main或宣称P0清零。
- 历史完整planning session98164已终态exit0，源码2a9182804ce4723bd44baaade3c185bfadd1e4bf20a81ddbd069a219a9510653；
  该证据早于本节默认围合/门方向/基础检查修改，不可当作最新源码完整回归。

## 2026-10-11 后增长联合落位与30岛终态（历史阶段，整体未完成）

- 完整planning session31247终态exit0，加载此前aec6634源码：30岛主批及五个named
  回归通过，acute/inside/far/crowded/loose均0。此结果不是后续世界桥接、候选宿主恢复及
  后增长落位改动的完整回归证据，也不替代独立四档、跨引擎、模型/视觉/golden门禁。
- 2003037141/t1的必需体育场并非必须起桥：初始25边骨架无合法接路，但接受后的增长网络
  提供合法宿主。生产在断头收尾后、landing/solve及实际parcel接受之前，仅对既有未落位
  obligation再调用原联合求解。保留原需求id/原单轮候选与route上限，不迁移bound owner，
  不增桥/放宽角度/扩大吸附；新owner及网络整体通过已有owner、接触、扎堆、桥头约束后发布。
  旧失败finding不能被新的owner失败替代；失败草稿不发布。树仍属展示草稿，移除新用地/路内的树。
- 新verify-city-required-placement独立进程session12563 exit0：该种子同R551.5432893255071，
  station/stadium各一次、placed obligation各一次、原required目录保留、全部registered约束0、
  unmet0、capacity1615/540。单一命名样本恢复不是60岛成功率证明。后增长是额外有界阶段，
  整体跨阶段候选/地形/半径重建累计预算仍未闭环，不能声称每城累计最多1457。
- frontage candidate保留真实宿主/投影；只有旧候选层耗尽后的rescue可恢复其方向，当前
  网络宿主失效即拒绝，不重排旧成功或放宽单轮1457上限。合成旋转/障碍与repair-safety通过。
- 新roadBlocks由真实接受道路围合面产生固定7.2×8地块与主网frontage路径，保留单双排/净距，
  凸面真实路幅内缩、矩形/设施/高架/一单位地形采样核查；非凸/当前展示不支持holes明确
  unsupported，预算耗尽/取消零发布。模块专项通过，尚未接入生产，不宣称U3完成。
- 世界桥接已接入repair事务，读取六域版本及源几何、保护需求目录，接受时原子发布；只有实际
  网络/site/reservation变化推进对应版本。未实现的高程/实体模型只能unknown/pending/tentative。
  cityPlan最终地块/车流/零占地桥模型走runRepairDerivedFinalization私有草稿，真实道路折线逐段
  核查，失败零发布并保留旧一致状态/容量。最终输出planningOutcome与derivedFinalization，
  不存在success分支；没有完整模型及总预算即使全部需求满足仍为degraded。
  required-placement session31492 exit0确认真实2003037141/t1最终发布ok、无stale、degraded、unmet0。
  2000837832/t1实际及skipSolve两路径finalization ok且无stale，但体育场仍未满足故failed，
  不能把旧acute-only命名回归或足够容量当必要服务通过。
- roadBlocks固定同R/同道路只读诊断：2003037141/t1 220面/207支持/13非凸，1577地块（旧1615）；
  1703294958/t1 96面/85支持/10非凸+1路幅耗尽，702地块（旧744）；两者超过540但均unsupported。
  面提取45/25ms、生成714/214ms仅此次诊断；一百万候选上限仅诊断，非生产预算。
  全面polygon尚未扣除面内固定设施/高架的地表，不能从地块安全推导整面安全，不默认替换。
- 新required-placement、road-blocks、joint-frontage已纳入manifest（51项），前者为sites/planning/full门禁，
  后两者另纳fast。manifest session18028 exit0，roadBlocks/四旋转frontage/typecheck/diff通过。
  港口gap22、villa wet6、样本外独立岸线、性能、全局预算及完整U0–U5仍未完成。
- root session98817 exit0：repair-safety、含真实solve/skipSolve两路径的world守卫、typecheck通过；
  其它通过的冻结证据不可自动归属于后续修改。最新City源码SHA-256
  `2a9182804ce4723bd44baaade3c185bfadd1e4bf20a81ddbd069a219a9510653`，
  完整planning新session98164已启动，尚无终态。不以此前31247替代本次最新生产集成验收。

## 2026-10-11 新道路共享扎堆准入（历史阶段，整体未完成）

City源码SHA-256：`aec6634e473d02880a1b68df427a5bfee165562c04a64891d1988cb47bbc4c5d`。

- 新roadAdmission使用最终crowdedPolylinePair判据，读取当前全部8/12宽accepted干道的真实
  折线、双向投影和同节点豁免；批内候选也相互核查。场景中有冲突的整个未发布街区草稿被拒绝，
  不删已接受必要道路/地块，不降级路幅、不扩大25/15°阈值。roadGenerationDiagnostics记数量
  及至多4例。此为生成准入深化，仍不是道路生成街区的完整U3迁移。
- 五个定向样本的六个原扎堆关系现为0，必要需求均0且容量足够：1703366229/t1及t2
  R551.5432893255071、1213地块；1703310796/t2 R579.2644041008882、1487；
  1703326634/t2 R551.5432893255071、1491；1703366229/t5 R872.066511224918、3107。
- 1703310796/t2另有villa-complex wet6。只读内存esbuild对照（唯一禁用roadAdmission，
  未改生产文件）同R、同owner坐标、同wet6，容量1501且两对扎堆；确认入水是已有问题，
  不归因于新准入。该入水仍需修复，不能用必要需求0掩盖。
- 新湿岸对象联合搬迁复用原6..120/20方向400个局部候选，并保护完整路幅/地块/主网服务及
  移动后暴露端点。旧路径不重复耗费湿岸对象的局部层或以弱准入兜底。合成回归湿违例清零、
  原道路及服务保持、bound对象不动；真实villa样本候选0仍未修复。
- road-admission、repair-safety、connect、network-patch、road-faces、typecheck及diff通过。
  新守卫纳入manifest/full/fast/相关module，manifest48项，verification session38023 exit0。
  完整planning session31247已启动，尚无终态；不宣称30岛、独立集或跨引擎通过。
- 性能仍未解决，未启用逐点缓存或未经证明的解析早判；P0体育场/港口/独立岸线、全世界状态、
  实体物理/多入口、完整事务/road-first、预算/取消/Outcome与冻结视觉/golden仍未闭环。

## 2026-10-11 精确缓存反证与最新完整规划终态（最新，整体未完成）

- 完整planning session59253加载88cb4e源码，终态exit1。30岛主批全部必要需求/容量通过，
  acute0/inside0/far0/loose0；crowded仍6。五个后续named设施/路口样本通过，最终6>5失败。
  这不能替代样本外、独立集、跨引擎或真实模型准入，P0体育场/港口与岸线分量仍未闭环。
- 新exactFieldCache只缓存完整精确坐标的原始标量，区分signed zero、不做插值/取整、
  每字段2048项及有界FIFO。九个seed/radius世界字段逐值Object.is比对、淘汰、false、异常、
  非有限输入及禁用合同通过；producer固定stretch标量以避免依赖调用方后置修改。
- 实测反证否决生产默认启用：初版Map起点迭代FIFO的1703294958/t1为118250ms vs10192ms，
  改环形FIFO后的两样本为57126 vs10612ms、37094 vs8341ms，完整plan JSON逐字一致。
  同时有其它验证进程/JIT，时间仅供定位，不作为稳定速度比；但没有加速证据，不能宣称P1解决。
- 生产默认memoizeTerrain关闭；缓存仅可显式诊断启用。缓存维护与逐点key开销过高，后续应
  评估段级地形证据复用或经profile证明的热查询，不直接投入密集插值栅格。
- 两个已确认负收益的benchmark进程（session72944/95998，PID54566/55080）已停止，
  均终态143；第三个tier5配对未完成，不作为相等/性能证据。没有删除任何数据。
- 当前typecheck、精确字段、connect/safety、入口专项及diff检查通过。完整U0–U5和目标仍未完成。

## 2026-10-11 新入口起向搜索完整性（最新，整体未完成）

City源码SHA-256：`88cb4e9f43d40585b8b2500bf9a00cdc74db8c21d40c283dc5dd338117f57a30`。

- 新合成反例：无入射道路的入口，朝最近目标的三个首步均不可建，但存在合法北向绕行；
  原A*只扩展1状态即no-target。修复后该同场景通过，并保持所有最终路幅/地形/角度验证。
- Connector config v3保留参数；仅无任何既有入射边的源，在原方向堆耗尽后才惰性补其它
  7个方向，同一个扩展计数/堆状态表，不重置预算。已有道路/桥端仍保留原入射切线规则。
  8组平移/旋转及searchBudget1负例证明替代起向也受原预算约束且失败零副作用；现有曲线源
  10状态回归通过。
- connect、安全、8变换端点专项、typecheck及diff检查通过。named/海上端到端复跑尚待终态，
  不将此前源码通过沿用到现版。session69593已exit0，两岛真实海上服务恢复及两个named端点
  检查通过；最新完整planning session59253在跑，尚无终态。causeway-primary纳入full及
  network/sites/planning模块，manifest47项；verification session4007已exit0。
- 当前2003037141/t1体育场仍未落位：8个剩余重试中样本A*由1→8状态仍无目标候选，
  说明不是仅一个起向造成该实例失败。R551.5432893255071、1615/540容量足够，必要需求
  site:east-stadium保留未满足；需继续联合骨架通行空间/选址/入口，不能把新合成修复称为P0解决。
- 全目标U0–U5仍未完成，无提交/合并/golden修改。

## 2026-10-11 接入拒绝证据与精确可达预筛（最新，整体未完成）

- 上一批session37630已exit0：两岛causeway-primary真实入口服务恢复，以及两named端点
  回归通过，不代表所有街区/岸线/港口需求通过。
- 桥候选原reason仅保留最后一次拒绝，不能解释全部40个候选。现保留每类数量和首个宿主/落点
  及source/target角度或终筛详情。2005445908/t1当前40个为角度18、用地11、水域11；
  不能再描述为“所有候选只差角度”。候选顺序、数量和准入均未变化。
- 必需设施路线失败增加有界首例证据（centre/gate/host/distance及具体策略原因），每个原因
  至多保留一例。2003037141/t1有35个候选距主网过远，原始43次重试并非都具可行距离。
- jointSite在克隆/搜索前采用三角不等式下界，使用实际量化gate位移，保留浮点保守余量；
  只排除必然超过原r+30路线界限的候选。新合成负例证明routeRetries0且网络不变；专项通过。
  实测同样本每阶段routeRetries43→8，仍未落位。单次计时约8.24s，不作为明确性能提升证明。
- 体育场剩余8个候选仍有水域/坡度和A*初始格不可通行问题，港口及独立岸线分量仍未服务。
  全目标、U0–U5及联合冻结验收仍未完成；无合并、提交或golden更新。

## 2026-10-11 完整折线接入与主网阶段前移（最新，整体未完成）

- bridge-candidate及一般岸边门路的最近点原只取edge.points前两个点，遗漏真实折线后段；
  现使用closestPolylineSegment，每宿主仍一个投影，40宿主候选和全部净距/角度预算不变。
  新U形宿主回归证明：150长度界限内找到后段100距离落点，并保留宿主实际形状。专项通过。
- 原设施门路先提交，之后才做地面交点收口与主网分量接通；主网接入合同因此面对尚未完成的
  生成网络。现将原交点和分量接通阶段前移到设施接入之前；阶段仅执行一次，没有重复加预算。
- 当前复核2002827683/t1的海上设施已服务，siteWithoutDoorRoad0；仍有独立街区分量与
  coastal:1未连主网，不能称整岛修复。R551.5432893255071、934/540。
- 2005445908/t1海上设施已服务；港口仍gap22未服务、R551.5432893255071、989/540。
  体育场失败及6对扎堆、完整world/物理/road-first/全局预算/冻结联合门禁仍未闭环。
- typecheck、connect/safety及diff检查通过；causeway-primary守卫改为要求真实服务恢复，
  与named端点守卫复跑session37630尚待终态，不将合成通过冒充全量。

## 2026-10-11 海上接驳主网接受合同（最新，服务仍未完成）

- 复现2002827683/t1：原owner坐标/朝向与绑定一致，gate存在但在非主网分量；不能归因为
  已证实的remap丢失。生产causeway-access原以任意地面边为目标，错误发布了孤立堤道。
- 现目标改为预声明骨架锚点所属主网；提交前再次检查岛缘gate与主网同分量。不扩大原15个
  岸点、40个桥投影、1000路线界限或坡度/路口角度。整条堤道与岸侧路径仅共同接受。
- typecheck与connect/safety通过。该样本复跑仍未服务：15个候选的主网接入受到坡度、
  水域、路口角度拒绝，现无access绑定且有具名causeway失败及required未满足需求。
  这是阻止unsafe success，不是设施服务已修复；下一步需联合接通岸侧分量与重建引道。
- 2005445908/t1港口gate失败原因确认junction-angle，非简单差2单位；距离阈值20保留。
  2003037141/t1体育场仍未落位、43次路线重试no-target。三项保持未完成。
- 新causeway-primary独立守卫检查“接受必须挂主网；失败保留需求”，不当作全面成功证明。

## 2026-10-11 搜索候选与外层扎堆准入一致性（最新，未完成）

City源码SHA-256：`24cdd1d78d681985d069c6198b6523f55bb89ed9fe2df939020c512d6bc128fd`。

- 新1703326634/t5端点并非只因几何阻碍：node-merge产生4个扎堆冲突，collector A*产生1个，
  连接器先返回路线后，外层单调事务拒绝整条路线；搜索未消费这个拒绝，合法替代候选未继续。
- ConnectorWorld新增只读draftAcceptance合同，在每次最终候选和提交时复核；端点接入按
  当前crowdedPolylinePair/共享节点口径拒绝新增扎堆，再在同一A*堆和既有预算内继续。
  外层事务和原25/15°、吸附、路宽、长度及预算均保留，不把外层拒绝改为接受。
- 新合成回归证明：调用方拒绝首条物理合法路线后，10状态耗尽零副作用，原完整预算找到
  另一条路线；connect、安全、8变换端点守卫及typecheck通过。
- 1703326634/t5现场复核全部注册约束和required需求0；R仍872.066511224918、4885/2700，
  与前版同半径。named守卫扩展到该样本，session61118在跑；完整planning session23950
  已启动，不能提前称通过。全局预算/生产world/road-first与完整冻结门禁仍未完成。

## 2026-10-11 并行整合后联合门禁（整体仍未完成）

源码指纹：`266b177af7737a8411bd8b6ffda32d4926cb3afe5ce0512447137f117810298e`。

- 新入口消费者按显式ground-frontage/island-causeway合同区分；仅带海上依赖且具名causeway
  合同的对象不进入地面门朝向约束，没有模型名称豁免。伪装陆地或缺合同负例仍拒绝。
- 2005655366/t1完整named endpoint专项通过：全部注册约束、required需求、必要设施及容量；
  R450.8728742577211。8组平移/旋转、原必要12宽道路保持、全胶囊和失败零副作用通过。
- world及roadFaces纯模块实现与专项已通过，尚未接入生产，不当作U0/U3完成。
  四个新守卫注册manifest/full/fast/相关module，manifest为46项；覆盖守卫通过。
- 当前typecheck/build、入口、world、道路面、connect/safety和8岛intent通过；build仍有
  大chunk警告。完整planning session43540终态exit1：30主批仅1703326634/t5必要端点
  endpoint:-17.46:281.74未满足，contacts为空且4885/2700容量足够。后续named/汇总门未执行。
- 旧fa77完整planning session77254终态exit1，最后汇总crowded为6>5；不代表新源码的
  扎堆总数。当前仍需查新端点根因、扎堆与完整U0–U5门禁，无合并/提交/golden更新。
- 后续端点代理遇到使用额度限制，主代理继续安全实施，不反复重启或将此当作技术无解。

## 2026-10-11 完整回归复核与必要需求门禁补齐（进行中）

- 用户授权三个subagent并行推进：剩余端点根因回归、入口能力消费者解耦、世界版本/预留
  状态合同基础。主代理统一整合；共享源码仍在变化，专项通过不是冻结联合验收。
- A*胞元避让与现有终筛统一为radius+margin+roadWidth/2；增加最终候选拒绝原因全计数与
  失败段坐标，不扩大原搜索预算/吸附/角度。新增完整路幅绕行回归和拒绝分类分母核对通过。
- solve入口转向消费声明，保护固定/绑定对象，扫描真实polyline而非端点弦线；入口能力
  专项已通过。世界合同仍在并行实施，尚未完成生产接入，不宣称U0闭环。
- endpoint代理最新现场复核2005655366/t1得到unmet为空，R450.8728742577211；半径与旧
  样本不同，不作为同世界因果证明，也尚不替代全部约束/容量/引用与冻结回归验收。

- planning session77254加载的是下述fa77f5版本；前四个定向断点/交叉样本通过，
  正在执行30岛主批，尚无终态，不作为完整通过证据。
- 修补planning后三个设施恢复样本的验收盲区：除落位、间距、道路穿用地检查外，必须有
  主网络且diagnoseNetwork的保留需求unmet为空。必要端点不得因设施恢复而豁免。
  node --check和git diff --check通过；当前已启动进程读取的是补充断言前脚本，不能证明
  新门禁通过，待该进程结束后需单独验证新增断言及再次完整执行。
- 下述2005655366/t1已知未满足端点意味着新门禁预期暴露真实失败，而非调整阈值放行。
  没有合并、提交或刷新golden；U0–U5仍未全部完成。

## 2026-10-11 U1 声明驱动入口与搬迁默认策略（最新批，整体未完成）

City源码SHA-256：`fa77f5c6505b15b219ad850e9fc6e62981f2fb460de1521b4f4df7f46cd8a8dc`。

- jointSite不再限定station/stadium，也不按station决定朝向和门位置；读取版本化
  PlanarAccessDeclaration。局部入口、朝外向量及缩放参数为数据，缺失/非法能力零副作用拒绝。
  车站渲染和规划共用一份入口参数；PlotAccess附带entranceId和model-position/plot-proxy证据等级。
  体育场未声明实际门洞，仍明确为plot-proxy，不宣称基础/通道完成。
- 单入口ground-frontage支持非中心入口：gate沿声明门的朝外射线落在现有r+8预留边界上。
  现有居中入口保持原gate位置、路线/候选预算不扩大；超出当前plot envelope的入口拒绝。
- SiteSpec v2登记mobility和shoreTargetRadiusFactor；通用避路、近接让位、未服务岸线重选、
  部分后置选址及岸线软偏好不再写死civic/harbor/arch类型名单。未知能力不能默认为可搬迁，
  入口已绑定/海上依赖保持保护。此为旧placement默认策略迁移，尚不是完整实例预留状态机。
- 合成回归覆盖模型换名不改变位置/道路、r20/r32/r46入口同步、四向入口朝向、偏置门沿其
  朝外接入、非法/缺失声明拒绝；mobility数据变更生效、bound/shore依赖保护、未知默认拒绝。
  名字/半径/偏置入口/缺失能力案例在V8/JSC输出一致，仅证明这些合成案例。
- 修复另一个通用漏分支：显式岸线让位对象即使干燥、已贴岸，也会按新owner的声明净距进入
  原有6–70/24方向局部候选，而不是仅wet>3时搜索。owner额外净距按ID传入；候选读取当前
  candidateNetwork实际干地道路及完整路幅，保持海岸语义、原水域/桥头/高架条件。
  未指定让位、已绑定对象、全宽道路阻挡均有不搬迁回归。不含seed或模型特例。
- 当前源码定向2005655366/t1：R433.3754003541679、552/540，两required设施已放置；仍有
  endpoint:109.87:-384.75未满足、looseInlandRoadEnds1。2005864824/t1：1005/540；
  2005969553/t1：1077/540，均R551.5432893255071、两required放置、注册约束0/unmet0。
  端点未接不因设施恢复而豁免；当前连接日志有site-clearance/角度拒绝，仍需联合定线/实体合同。
- 通过：当前typecheck、build（仍有>500KB chunk警告）、repair-safety、connect、network-patch、
  radius与git diff --check；当前源码sitespec/assign复跑session37766已终态exit0，覆盖15类
  声明、5岛半径一致性、确定性及合成assign准入，不作为完整规划或全模型物理验收。
- 更早a0ed13的planning session77837已终态exit1：30岛主批的contact/required/capacity硬门
  通过，随后命名2005655366回归因仅一required落位失败。因此该完整测试不通过，也不证明后续
  软阈值汇总已执行。本批恢复该设施，但该命名测试原未严查unmet端点，不能代替整城验收。
- 未完成：其它kind分支、市政需求programme迁移、全模型物理/多入口/通道、世界版本/实例状态、
  道路生成街区、整图预算/取消、完整Outcome、冻结独立集与视觉/golden。无新full/30岛跨引擎
  或合并证据；U0–U5及总目标保持未完成。本轮技能委托仍不可用，主代理直接实施和审查。

## 2026-10-11 U0 持续目录与岸线接入补齐（历史批，整体未完成）

City源码SHA-256：`a0ed13eaf657f7b6403310fccea62b81cfa443deb41ecd6caf9a2dd9b92d55ac`。

- 六个市政owner在骨架前登记必要用地/接入需求，选中的地标也在道路生成前登记；失败的
  station/stadium不依赖落位对象存在才能进入分母。endpoint/district/coastal仍从求解边界登记，
  尚不是街区/必要走廊/冗余在生成前的完整需求目录。
- solve持续保留demandCatalogue，最终plan显式输出，diagnose消费旧承诺再追加新观测；
  old id与originAnchor保持，绑定anchor仅经显式remap更新。同分量的新代表和重绑后的端点
  不生成重复需求。旧已满足/未满足需求不能因后验分类改变而消失。
- 受保护目录由dispatcher管理；策略替换、删项、改required/anchor或修改原型均拒绝。
  嵌套事务进入前刷新父草稿待应用引用；子事务已消费journal保留给父验收，但不会重复应用。
  父事务撤销时，子事务路网/需求目录不会发布到权威状态。新增合成回归覆盖合法嵌套合并、
  原端点需求ID重绑、后续删除绑定节点拒绝，以及目录篡改和父撤销零副作用。
- 修正RepairContext海岸输入口径：生产coastRoadRuns包含河岸后缀，意图视图以coastalRunCount
  切出真正海岸，再与riverRoadRuns合并；不重复派生河岸需求。跨引擎摘要纳入完整目录。
- 前批30岛规划回归session73525终态exit1，仅余1703334553/t1摩天轮门路不足：26半径，
  最近路中心距离58.76，大于r+20。原gate的bridge-candidate因junction-angle失败，而后置
  选址只处理入水/重叠，因此该干燥、无重叠的未服务owner不被重试。此旧失败不作为现版结果。
- 新resiteUnservedShoreSites按未满足site-access调度未绑定岸线owner，复用原400岸点×4退距
  候选，不放宽snap/净距。与路口联合让位复用完整道路净距/地形/间距检查，保护现有地块；
  只接受距主网地面道路r+20以内的位置，暴露的旧端点也在同一事务处理。固定gate/海上owner、
  入水位置、占用已有地块或只邻接孤立道路均不准入。仍属于兼容接入证明，不冒充真实模型door通道。
- 通过：UI typecheck、build（仍有>500KB chunk警告）、repair-safety、connect、network-patch、
  radius、git diff --check；8岛intent检查全部unmet0、目录分母保留、只读且确定。
  新嵌套事务/目录篡改合成案例在V8/JSC输出一致，仅证明该案例，不替代30岛跨引擎门禁。
- 当前源码定向复核1703334553/t1：R510.40819269204076、954/540、目录22项，注册约束0、
  unmet0，resiteUnservedShoreSites接受1次；不是删掉摩天轮或从需求分母省略它。
- 同源码完整planning回归session77837最终exit1：30岛主批硬门通过后，2005655366命名回归
  因required只放置1/2失败；不记完整测试通过。未跑本源码无缓存full、
  四档冻结独立集或视觉/golden验收。已知1703366229/t1的crowdedArterials1仍保留：12宽
  waterfront走廊与8宽街区次干并排，后者两端都有支路；不能降低宽度或删除必要街区边界隐藏。
- 世界/预留状态机、真实模型/入口覆盖、道路生成街区、全部写入口迁移、Outcome/失败率与
  累计预算/取消仍未完成。U0–U5及总目标保持未完成；本批不更新golden、提交或合并分支。

## 2026-10-11 U0 首批：事务级旧需求保留（历史批，未完成 U0）

City源码SHA-256：`0f7255913aae64fe9c3e8abb8a453cea9f4e1a7b61801d860fbe67371f8192da`。

- repairAcceptance不再只从修复后重新派生的需求中寻找原已满足项，而是将事务前的全部required
  需求保留到验收中重新评价，包括未满足项。删除未落位owner/其obligation、必要端点/分量锚点
  或岸路run会拒绝；显式节点remap可以更新锚点证据，但不改变旧需求ID。
- 分量合并后原district需求即使不再由deriveDemands生成，仍以原锚点在新主网中的归属评价。
  已满足需求不得退化；旧未满足需求变为满足才可计为需求改善。主网锚点和节点继承同样消费remap。
- 最终生产primaryAnchorNodeId消费repairCtx的已接受锚点，而不是重新从旧骨架集合任选一个。
- 新合成回归覆盖删除未满足owner的事务零副作用、删除孤立分量、合并分量、端点移除、显式及
  连续节点映射、null删除映射、旧需求ID保留与只读性。
- 通过：UI `npm run typecheck`、`verify-city-repair-safety.mjs`、`verify-city-network-patch.mjs`、
  `verify-city-connect.mjs`及`git diff --check`。
- 同源码定向生成1703326634/t1：R435.684289365591、592/540，注册约束0、unmet0；
  1703350391/t1：R390、559/540，注册约束0、unmet0；1703366229/t1：R551.5432893255071、
  1220/540、unmet0，仍有crowdedArterials1。没有扩大吸附/净距/容量门限，也没有刷新golden。
- 本批只保护单次事务边界，**不是先验需求目录实现**。跨事务/生成前登记、稳定owner与岸路身份、
  嵌套事务的受保护目录更新授权、预留状态/世界版本、真实入口证明仍未完成。
  将目录直接加入现有嵌套事务的试实现会拒绝合法内部更新，已撤回该试实现，未列入交付。
  当前仍不能用final diagnose的后验需求分母证明先验需求全部保留。
- 未执行本源码全量/跨引擎/冻结独立集与视觉验收；历史其他源码测试不得代替。本轮仅启动U0，
  U0–U5及总目标保持未完成。编码委托脚本启动失败，本批由主代理直接修改并验证。

## 2026-10-11 定向让位、后置凯旋门与受阻路口联调（历史批）

City源码SHA-256：`a81dd8d075390fcec8a95742cab33f1237b30190ae69b80a378cfd03e7cc53c8`。

- 2ec1930的完整30岛硬门退出1，收集到4个失败样本：1703326634/t1未接关系1；
  1703350391/t1、1703366229/t1与t2必需east-stadium未落位。全部实际容量达标，
  不能用旧软容忍汇总或跨引擎一致性将其记为合格。b216f92的30布局V8/JSC检查最终通过，
  仅属于该旧源码，不能当作本批通过。
- required搬迁的真正漏分支：frontSitesOnTrunks若所有临街候选失败，只在旧对象已被主干
  穿过时才调用snap，故给必需对象让位的合法旧对象会原地留下。现显式relocateSiteIds
  也触发既有有界snap，并限制新位置仍在r+20的临街范围；正常未指定搬迁范围的行为不变。
  搬迁提案消费候选实际道路，并用现有共享设施约束按owner身份禁止新问题，不只看重叠总数。
- 此让位修正先恢复体育场，却暴露1703366229的凯旋门原占位本就入水且没有真实宽路，
  不能把必需设施成功当成全部安全。真实宽路被分为短边时，连续直线frontage不能隐形：
  新只读索引在度2节点合并同宽/结构/用途的直线段，保留真实曲线子段，绝不跨路口/桥，
  仅容纳centigrid的0.02几何偏差，不创建道路。顺序/端点反转及无效输入有回归。
- 未绑定的坏凯旋门在最终道路上后置重选：原中点优先，再有界试1/4、3/4位置，保持干地、
  高架、间距和真实12宽道路条件。首次独立接受被正确拒绝，因为旧位置的近接豁免消失，
  looseInlandRoadEnds增加0->1。已复用共同的repairExposedSiteEnds，将端点接入/安全可选
  修剪与owner重选一起接受。合成回归保留所有原道路，并确认暴露端点实际接通；湿地负例不变。
- 当前1703350391/t1在R390：两个required owner均已放置，容量559/540，所有注册约束0、
  unmet0。1703366229/t2在R551.5432893255071：两个required owner均已放置，容量1220/1080，
  unmet0，入水/凯旋门骑路已归零，仍有crowdedArterials1。t1已在本批相同半径复验：
  容量1220/540，两项凯旋门问题归零而留扎堆1；不得把此三样本推广为最新完整30岛合格。
- 1703326634/t1当前接触距离0.1883，涉8/12两条道路。按实际宽度逐owner核对，阻挡者
  是villa-complex，不是广场：12宽道路侵入其圆形预留包络。局部owner让位+路口同事务
  原型仅移动实际阻挡且未绑定的可选对象，保留地形、道路全包络、固定owner/桥/广场和预算。
  合成正例可消除接触；真实该样本40个局部候选仍因owner-footprint-unsafe或road-envelope
  被拒，未接1依然存在，不能记为已修。该庄园距海岸约219.71，旧后置移动还暴露更广的
  shore意图/实体合同缺口；试读原8个shore候选均有占地/地形/道路拒绝，需要联合重选或走廊
  重整，不以扩大吸附距离或放松包络解决。
- 本批typecheck、connect/repair-safety、network-patch、radius、sitespec、生产build通过（既有chunk
  警告）。没有最新完整planning/cross-engine/独立冻结及视觉通过。
  三个必需设施样本的硬门已针对复验，但原目标、P1及A–F/J矩阵的其他未完成项继续保留；
  全部生成物理入口、先验需求/lineage、桥/owner联合方案、道路生成街块、模型物理与累计
  预算仍未完成。未提交、合并或更新golden。

## 2026-10-11 局部切向与必需设施路线续试（历史批）

City源码SHA-256：`2ec1930cfee6d833930cbbb848e46b1e6d4bc999755b33bac2b52d93386428a3`。

- 半径修正版db4012的planning整批确实退出1：30岛生成完成后，额外必需设施样本
  2000628374/t1只有1个required owner，原断言期望2。并非该版全批通过；不得降低要求。
- 复现该缺口：R450.8728742577211、容量809/540已满足，但east-stadium未落位。
  主候选192、fallback353、outer29，拒绝含地形/占地/高架硬门和12个no-target；
  可选搬迁retry也未解决。此样本证明容量达标不等于必需设施达标，不用无条件增岛掩盖。
- jointSite原先只在每个位置尝试direct/node-merge，直接路线失败即丢弃该位置。
  现只有所有原候选层均失败后，才对其中已通过硬选址/道路占地检查的失败路线位置
  续试detour/A*；再次复验同一硬条件与事务终筛。原成功选址优先不变，maxLength仍r+30，
  maxCandidateEvaluations仍1457，重复位置去重，续试计入剩余候选预算，不增加区域半径。
  近路方向、外圈可达预筛改为真实折线，不再以道路端点弦线判断。
- 当前同一2000628374/t1、同一R450.8728742577211：两个required owner均已放置，
  east-stadium记录13次routeRetries，容量793/540，所有注册约束0、unmet0，约11116ms。
  原809到793是新增合法接入与最终地块过滤的变化；需求和容量并未降标。
- 新曲线源回归先复现A*起始方向仍按端点弦线的问题：10扩展预算提前耗尽，0个目标候选。
  修为源旁实际线段切向后，同预算找到120长安全直线延续，未接关系0。
  typecheck、connect/repair-safety、radius、network-patch、sitespec、生产build（既有chunk警告）通过。
  最新完整planning仍在运行，尚未证明所有必需设施与接触均合格。
- b216f92的30岛V8影子诊断（不是本批当前数字）已观察到1703326634/t1未接关系1、
  1703294958/t5与1703366229/t5各扎堆1，以及部分必需体育场未满足；JSC还在运行。
  新cross-engine摘要纳入约束计数、unmet、容量/校正历史，并修正stderr进度即时显示。
  原10岛调参零接触不代表30岛安全；等引擎只证明一致，不证明产物合格。
- planning现将30岛的真实未接关系、required unmet/主网缺失和容量不足作为硬门，
  先收集所有样本证据再失败，避免首个问题掩盖其它样本。旧软形态容忍阈值未扩大，
  不以调参结果新设阈值。原目标/P1仍未完成；全部生成入口统一、先验需求/lineage、
  联合桥/owner、道路生成街块、模型物理、累计预算和独立全档视觉验收仍待继续。

## 2026-10-11 桥头统一诊断与半径失控修正（历史批）

City源码SHA-256：`db4012e2c06ebff887cf8cd166c6b5f07e6c055d2cdbb9a9fce7e49a05c523fd`。

- 桥报告与正式bridgeheadContinuity此前口径分叉：报告只认相邻地面边，正式约束还识别
  声明且owner位置/朝向仍匹配的岛侧plot-gate。现共用isOwnedIslandGate，且先确认节点
  存在；加入缺节点、错角色、过期owner与无效shore负例。此为已有入口合同统一，不添加
  空间邻近豁免。半径改动前显示专项的桥报告由1变0；仍有11个未分类端点和无支撑窄路。
- 对已确认持续运算的旧planning和cross-engine主动SIGINT，分别终止为130和子进程
  SIGINT错误；没有把取消列为通过。加入逐样本进度后，进一步定位1703358310/t1。
  最新进度版也在该样本持续高CPU，随后因已定位病因而主动取消，退出130。
- 对该自有测试进程做3秒V8 CPU剖析（2003采样）：commitFixedLink自采样507、GC404、
  commitNetworkPatch223、classifyRoadSegments207、clone182；只是该时段热点分布，
  不是全批性能归因。只读调试栈证实当时buildPlan seed1703358310/t1、R9425.292271330369、
  23371边、9542街块。实际主因是容量比例校正把初始极低容量外推成巨大面积；不能按
  泛化“求解/A*慢”继续增加修复策略。
- 新版本化校正保留4次重试和原容量目标/1.04余量，但单轮面积增长上限2；始终记录
  radiusHistory中的每轮R、生成/最终容量、道路和街块数。parcelGeneration记录道路终筛前
  的生成量及剔除量；不存墙钟进生产产物。此不是全图累计计算预算或全域不可行证明。
- 当前同一1703358310/t1完成约9820ms（非受控基准）：390时0街块/0容量，下一轮
  R551.5432893255071时生成1069、终筛1047/540、572边/112街块。全部注册约束0、unmet0。
  该结果没有删减容量要求；也不等于所有档位布局、半径或面积预算均达标。
- 半径纯回归覆盖0/近0容量、4档、每轮面积与累计上界、满足时不变、非法输入；已纳入
  fast、planning module和full。保留原41项，增加为42项，不刷新golden。typecheck、connect/
  repair-safety、radius、network-patch、验证基础设施和生产build通过（既有大chunk警告）。
  最新30岛planning仍在运行，完整road-report、跨引擎、独立冻结/视觉未复验。
- 原目标和P1仍未完成：生成的实体/用途合同、真实入口与预先需求、lineage、道路生成街块、
  多层结构、累计预算/取消/阶段p50/p95、独立全档验收均继续保留。未提交或合并。

## 2026-10-10 骨架准入、阶段预留与 A* 候选续试（历史批）

City源码SHA-256：`55f888dc7d8512e312a5602dc5c77b4b9bd616bcd8ca2a63cccb04b070ca6fec`。

- 上一骨架修正源码 `150bd2f9022b90d5f291513c115fe8526c73f8770461be882e36dd22e796d6b0`
  的6岛solve已通过，8岛intent已通过；30岛planning和跨引擎进程仍在运行，不能列为通过。
  它们在本轮检查时已运行超过12分钟；这是需继续定位的性能证据，不是性能验收。
- 详细物理探针将泛化slope拆成实际原因：1703302877/t1旧半径的主干是路幅侧缘
  building-setback，并非已证明的陡坡；1703366229/t1旧133.86:803.72终段是
  water-envelope。1703294958/t1一组接触为site-envelope。此前泛化原因记录只代表历史日志。
- 骨架射线先量化并在NetworkPatch草稿中全幅检查；桥段与两端真实地面接驳联合准入。
  拒绝桥段后的保留前缀再次检查，不能残留桥头豁免。只发布安全前缀；该局部规则不证明
  截短后的规划需求、容量、累计半径/面积与整图预算全部满足。
- 骨架阶段预留仅消费civic、harbor和已有access的对象，其余名义选址交给既有后续frontage/
  shore流程。曾把所有临时选址当硬预留，导致过早截断骨架并放大半径重试；该中间版本
  已修正。当前仍不是完整的预留状态机，也不能宣称所有后续选址及真实实体终筛已统一。
  环线出口改用原子splits保留曲线/宽度/属性，不再删宿主后重建为8宽。
- A*首个目标附近状态的重构失败不再结束搜索：逐候选做全幅/角度/交叉与补丁草稿终筛，
  拒绝后继续原堆，在原12000或请求指定扩展预算内续试；目标排序仍稳定。
  耗尽返回search-budget并保留拒绝数量/最后原因；无正式网络修改。连接阶梯保留详细拒绝
  文本，不再只留下enum。该实现不等于已支持每种来源的所有替代路线或整图累计预算。
- 新合成回归的格心均可通过，但5宽道路侧缘在52:2.5不可建：10次扩展已拒绝至少一个
  目标候选并返回search-budget，正式网络不变；正常预算找到安全折线，重复结果一致。
  当前connect（含repair-safety）、network-patch、typecheck、diff检查和生产build通过；
  build保留既有大chunk警告。
- 已注册只读定位入口 `node scripts/diagnose-city-residuals.mjs SEED/TIER [...]`，输出源码
  指纹、环境、实际半径/重试、容量、全部约束证据、需求、骨架预留/拒绝与有界连接失败日志。
  `--compare-solve`显式记录半径是否相同，且不自动允许因果归因；不同半径不可作求解前后
  对照。当前1703342472/t1为R489.99761279065484、容量542/540，全部注册约束0、unmet0。
  单次耗时6864ms发生于其它测试并发期间，不作为性能预算达标或全岛零残留证据。
- road-report原固定显示样本失败于历史精确坐标的三岔断言，不是当前图的交叉或裁剪缺口。
  核对发现原节点已不在当前布局；近接距离、原广场实体和安全三条腿迁入独立合成回归，
  完整显示检查改为所有当前广场周边规划三岔节点均仍保留至少三腿。
  当前 `--display-only` 通过：交叉0、裁剪缺口0、单一分量、门路12/12。
  未分类终点11、report桥连续诊断1及无活动支撑窄路2318.09仍保留为诊断；桥诊断与
  正式约束的声明岛侧入口合同需要进一步核对，不能据邻近位置直接豁免。
- 旧30岛的18个接触属于旧源码，不是本批当前计数。未刷新golden、提交或合并；全部生成
  入口统一、完整lineage/预先需求生命周期、桥/site联合重选、道路生成街块、模型物理覆盖、
  性能/视觉及冻结独立验收继续待完成。P1和总目标仍未完成。

## 2026-10-10 实际折线、滨水预留与搬迁联合接受（历史批）

City源码SHA-256：`de335d788f826f9c86033666d8b532d9a7381acd3b0177ce627046392a234fc4`。

- 上一批统一实际折线及双向扎堆检查后，planning暴露7对而超过原上限5。未调高上限，
  也未将直线反例/不安全场景改为豁免。U形弦线误报穿路、漏报门路、车站垂足、凯旋门
  局部切向、端点角及曲线扎堆已加入回归；关系证据键仍不是完整语义lineage。
- 断头延伸不再只扫首段/直接删建宿主：按末段切向扫描全部宿主子段，35°/3单位检查、
  全幅统一终筛和NetworkPatch原子拆分，保留曲线弯点、原宽度和双向引用；逐端单独接受。
  宿主width9第三段接入、逆向路径、阻挡拒绝及旧33.69°绕过路径有合成守卫。
- 7对原扎堆均是12宽滨海/河岸重复规划：河岸生成只看已发布edges，而此前滨海走廊
  尚未发布，故预留漏检。现同时消费已规划滨海折线预留，保持原28间距；弦段≤4采样及
  原28对25的余量用于覆盖几何净距，不声称已完成连续地形/完整地面生成物理证明。
  原1703302877/t1、t2及1703310796/t2的7对已消除，不通过删已接受主干或降级来清零。
- villa-complex穿路搬迁原被loose端点增加拒绝；新owner候选将搬迁与旧支路端点接入/安全
  可选修剪联合接受。必要路径、边界与仅端点曲线引用增加保护；不可修复的12宽主干负例
  拒绝搬迁且上下文不变。当前30岛roadThroughSite为0，主干扎堆1而不是原7。
- 最新30岛planning通过：acute0/roadThroughSite0/siteWithoutDoorRoad0/crowded1/loose1。
  6岛solve八约束无恶化、重复一致，8岛intent的unmet均0；10+1road-report调参图均一主网、
  未接关系0，显示交叉/裁剪缺口0。connect、安全/引用负例、network-patch、typecheck、
  build及30岛V8/JavaScriptCore一致性通过；build有既有大chunk警告。未刷新golden、提交或合并。
- 扩大为同一30岛的只读定位仍发现12岛18个未接边对（不同于上面的10岛调参集），不能
  把调参10岛清零推广到全体。1703302877/t1、t2两类接触同组含主干走廊slope拒绝，
  当前日志尚不能区分它们的building-setback与实际陡坡；需补详细物理证据及联合重整。
  当前还残留1703342472/t1一项扎堆（R494.01954848539583），以及1703366229/t1的
  133.86:803.72断头（R811.2，slope/water-span/no-target拒绝）。生成与引用保护改变了
  若干产物/半径，不作单因素数量归因；未完成项和冻结独立验收继续保留，P1仍未全部完成。

## 2026-10-10 孤立滨水分量主网接入（最新批）

City源码SHA-256：`ae536af1d7032d2f79f60b51debb941e384e7ace9ec6cecffd443b4ec8312a47`。

- 根因：1703461257/t3灯塔支路已接入一个独立滨水分量，但该岸路整体未并入主网；
  district、lighthouse、coastal三个unmet是同一拓扑缺口。合法岸路终点不等于整段可孤立，
  旧solve没有disconnectedComponents策略，内陆端点修复无法主动覆盖这些合法岸端。
- 新增有界主网接入：每非主分量按真实折线距离取至多12源节点，逐源/逐策略单独接受，
  沿用320路线长度预算；只连共享主锚点分量，已并网节点不重复提议，失败零副作用。
  不移动原道路/owner、不自动加桥、不放宽普通道路物理校验。此为局部分量修复，
  不等于主干桥/歌剧院与岸端整组候选或累计整图预算已经完成。
- 真实样本1703461257/t3保持R675.499814951862，新增合法地面接路一次，三个unmet全部满足；
  灯塔仍是兼容门路距离需求，不能据此声称模型真实door/通道验证完成。
  intent新增定向守卫：岸路及灯塔需求必须仍存在并满足、修复归因必须记录，禁止隐藏需求过关。
- 当前connect、typecheck、6岛solve、旧8岛intent和10+1road-report通过；solve覆盖增加到8约束，
  逐约束无恶化并重复生成一致。road-report十个样本均为一主网分量、未接关系0，
  展示交叉/裁剪缺口0；2000837832/t3另一个孤立分量也已接通。
  build通过但仍有既有大chunk警告。新增定向intent通过，8岛unmet均0；30岛planning通过：
  acute 0、roadThroughSite 1、siteWithoutDoorRoad 0、crowded 4、loose 0。
  30岛跨引擎通过V8/JavaScriptCore摘要一致；network-patch及diff --check通过。
  未冻结独立验收、刷新golden、提交或合并。
- 原表中的真实模型入口、桥头物理、道路生成街区、完整lineage、预算/性能及视觉等目标保留。
  另发现site-access/部分用地约束仍用首尾弦线代理折线路径，下一批须统一实际折线，
  不得用代理检测通过冒充道路实际形状安全。
  只读合成反例已复现：U形道路(0,0)→(0,100)→(100,100)→(100,0)，park位于(50,0)、r5，
  实际最近道路距离50，却被roadThroughSite计作d0、siteWithoutDoorRoad不报错、site-access判满足。
  该证据与上述当前回归结果分开记录；下一批须同时修正误报穿路与漏报门路，不隐藏反例。

## 2026-10-10 兼容走廊合流与滨水用途（最新批）

City源码SHA-256：`9a3db41dcdf76ae80384564c85cbe53bb88d938fd06bfc06d42b22a8d417ed16`。
按本文关联残留SPEC的路径/NUL/原字节规则计算，不含测试与运行环境。

- NetworkPatch节点重绑可显式合流同端点的兼容直线ground-road，继承最大宽度、更高等级及
  两条原路径的有序lineage。默认ID碰撞、曲线、桥面、引道和用途不同继续零副作用拒绝。
  1703350391/t1原206.41:313.75已接通，未将12宽主干直接删除或降级；双向路径映射有守卫。
- 环岛/河岸生成道路标记显式waterfront用途，普通道路不继承。路口和联合修复消费同一
  全路幅用途合同：陆地净距>4（原中心>10减12宽半幅）、山脚退界>12、高度<6、坡度≤0.9，
  水域/用地/地块仍检查。这是建筑/道路用途的语义分离，非关闭buildable或抬高坡度阈值；
  旧生成的全幅终筛和全部搜索调用尚未迁移，不能声称R0用途合同已全面完成。
- 真交叉末段重建接入复用24单位、16候选预算，保留等级和远端、保护owner及主锚点，
  与宿主拆分/路径更新原子接受。2000733103/t1末段已接入登记滨水宿主，实测未接关系0。
- 最新10+1 road-report通过，十个调参样本未接关系全部0；展示交叉/裁剪缺口0，
  未分类端点10。六岛solve逐约束无恶化、重复生成一致，全部未接关系和内陆断头为0。
  八岛intent通过只读、需求引用及确定性，但1703461257/t3仍有district/lighthouse/coastal
  三个未满足需求。connect（含普通/滨水、全幅干地/坡度/山脚/用地/缺失地理反例）、
  network-patch、typecheck及build通过；build仍有既有大chunk警告。
- 30岛planning已通过（另加入两个断头、两个真交叉的定向回归）：acute 0、roadThroughSite 1、
  siteWithoutDoorRoad 0、crowded 4、loose 0。30岛跨引擎通过V8与JavaScriptCore逐字节摘要一致，
  摘要已包含新purpose字段；尚未冻结独立验收、更新
  golden、提交或合并。原重点3处未接关系和8个断头已逐批取得修复证据，整项目下表的
  广泛未完成项继续保留，不以重点样本清零冒充完整目标达成。

## 2026-10-10 联合定线接入（最新批）

- NetworkPatch 新增原端点保留的 relineSplits：新形状与联合拆边原子提交，继承任意原宽度、
  等级与结构，输出有序双向路径 remap。桥、非 ground-road、曲线宿主、重复操作、非有限点拒绝。
  校验失败零副作用；预演与正式几何一致。原普通 splits 的离线拒绝合同没有放宽。
- 四岔候选在原交点周围2–12单位有限邻域联合定线，不修改外端点；中心与受影响远端继续检查
  35°/3单位路口条件，全路幅、用地和地块检查，禁止新增关系，并经过逐候选整城接受门禁。
  seed2000000000/t1原32°两条12宽道路交叉已接通；合成回归同时覆盖路径引用更新与不安全地形拒绝。
- 内陆末段定线沿用24单位局部预算，每端最多16候选；重建现有末段而非添加平行短连接。
  保护主锚点及owner gate，拆宿主/重绑/路径同步在同一接受事务。0.5吸附规则不变。
  seed1703342472/t1的276.85:126.11已修复且不新增扎堆。
- 最新30岛planning：acute 1、roadThroughSite 1、siteWithoutDoorRoad 0、crowded 4、loose 1。
  10岛road-report未接关系为 `0/0/0/0/0/0/0/1/0/0`；显示交叉0、裁剪缺口0。
  typecheck、connect含新增安全回归、network-patch、6岛solve、8岛intent、road-report及build通过。
  build有既有大chunk警告；跨引擎和冻结独立验收未重跑；未改golden、阈值、未提交或合并。
- 尚余本轮重点样本2项：206.41:313.75末段接入其共同邻点的宿主会产生规范边ID碰撞，
  必须显式处理兼容走廊合流及宽度/路径lineage，不可直接覆盖或删掉12宽主干；
  seed2000733103/t1交叉仍受普通道路building-setback限制，需落实用途合同及联合定线。
  8岛intent中的1703461257/t3仍有district/lighthouse/coastal三个未满足需求。
  本文下表原目标继续有效，不能以重点样本从4项降至2项宣称全部优化完成。

## 2026-10-10 必连端点与逐候选修复（当前批）

- 新增 endpoint-access 需求：主网内未完成端点不再引用不存在的 district:<primary>。
  每个 must-connect 的 demandId 必须解析到实际需求，未完成端点进入 unmet。该需求仍是
  当前图派生的诊断，不等于完整先验意图/跨版本节点 lineage 已完成。
- 岸路角色改按 run 索引引用 coastal 需求，不再错误使用首尾点展开后的索引。
- solve 新增逐候选事务：独立失败不撤回后续合法候选；近接端点逐点按 direct-projection、
  node-merge、detour、grid-astar 分别接受。近接距离仍为24，绕行长度预算沿用既有320；
  各策略仍使用原有安全校验和有界搜索，不增大0.5吸附诊断范围或放宽角度/地形阈值。
- 近接T增加反向联合候选：保持宽接入腿，调整宿主两腿；按单关系、两种方向独立接受。
  合成测试覆盖移动接入腿产生远端锐角、调整宿主合法且主干几何完全保留的情况。
- 未引用的12宽地面主干可进入端点保留的重新定线候选，新增段保持primary与12宽，
  必须严格减少未接关系且不新增关系；桥、引用路径和不可精确重建的宽度仍拒绝。
  此为替换走廊，不授予删主干/降级权限；合成守卫验证宽度、端点及引用保护。
- 中间复测：30岛断头由8降至2，原0.2766近接接通；尚余1703342472/t1的276.85:126.11
  与1703350391/t1的206.41:313.75，均显式记录endpoint需求。两处规划真交叉尚未清零。
  最新主干重新定线批的connect/network-patch/typecheck、intent、road-report和build通过。
  调优10岛未接关系为 `1/0/0/0/0/0/0/1/0/0`，从3降至2；显示交叉0、裁剪缺口0。
  2000000000/t1两条12宽道路现进入搜索，但角度/交叉/退界检查仍拒绝候选；2000733103/t1
  的普通走廊退界仍失败。两者不能写作已修复或靠删除/隐藏道路清零。
  最终planning通过：acute 1、roadThroughSite 1、siteWithoutDoorRoad 0、crowded 5、loose 2；
  6岛solve逐约束无恶化并重复生成一致；8岛intent通过必连需求引用、只读与确定性检查。
  原8个断头中的6个消除，原3个调优样本未接关系中的1个接通，尚余上述4项。
  跨引擎和冻结独立验收未运行。build仍有既有大chunk警告。
  没有改golden、阈值，没有提交或合并；不得称所有残留已修复。

## 2026-10-10 P1 基础修复（当前批，尚未完成全部验收）

- NetworkPatch 返回原节点/边到新对象的显式映射、按原方向排列的拆边路径及位置证据。
  solve 在隔离草稿里消费事务日志，同步设施 gate、主锚点、岸路/河路/车流、街块边界和桥登记；
  引用删除但无替代路径即拒绝。曲线拆边双向路径、预演无副作用、引用删除拒绝已加入事务守卫。
  这不是违例身份的完整 lineage：P0 的保守接触身份仍保留，不能宣布 R0 全部完成。
- 搜索与提交使用同一线段关系分类器，近接/精确 T/重叠不再仅凭不严格相交放行。
  分类先识别精确共享端点，避免浮点交点参数将真实共享节点误判为 interior T；重叠优先于
  平行共享端点。新增判据批曾使30岛断头升至82，排查确认存在数值误拒；修正后重新测量，
  尚不将全部82项归因为此单一原因，也不抬高10的上限。
  桥候选在包含宿主拆分的补丁预演网络上预筛，合法桥头 T 不会在拆分前被误拒。
  某策略提交失败可继续尝试后续策略；尚未实现所有策略内部候选的提交失败续搜。
- corridorViolation 记录 building-setback / road-slope / water-envelope / site-envelope，
  兼容旧汇总枚举，不改变坡度阈值或宣称改名改善。提交日志带详细原因；全部旧搜索日志尚未迁移。
- 地块和车流延迟到道路/设施 solve 之后生成。最终地块净空遍历道路的全部折线段；
  车流使用最终过滤后的地块，并补全曲线边几何。输出 derivedNetworkVersion 与真实终筛容量
  capacity(required/available/satisfied)，重试耗尽不再只有隐式容量不足。
  街块仍由格网导出，不是图面/走廊优先生成，不能将此批称为 B 完成。
- 桥端缺失节点明确违规；岛侧豁免须有精确 gate 节点及当前 owner 位置、朝向和 plot-gate 角色。
  不能凭附近海上地标豁免。主干桥远端联合接入、结构支撑/高程与真实模型门仍未完成。
- 展示裁剪恢复补齐树状支路的原终点路径及单接点闭环；只恢复已有规划边，不另造几何。
  合成回归覆盖树支路和单接点环。完整样本先暴露2处裁剪缺口，补树支路后1处，补闭环后
  缺口为0但显示了1项原规划未接关系；不能以隐藏原道路来宣布安全，须随规划回归继续核验。
- 固定锐角样本现在可能被生成期终筛提前预防；测试仍要求最终锐角0、交叉/分量不增加，
  仅在原草案确有锐角时要求 solve 的修复归因，不再强迫生成器先制造一个坏路口。
- 本批已通过 typecheck、connect（含新增 repair-safety）、network-patch、6岛solve和 City build。
  6岛逐约束无恶化并验证重复生成一致，仍有1项未接关系与1个内陆断头，不能算清零。
  数值修正后的10+1 road-report通过：规划未接关系逐样本 `1/0/1/0/0/0/0/1/0/0` 共3项；
  固定显示交叉0、裁剪缺口0、未分类端点10，门路距离代理均通过（不等于真实模型入口）。
  与P0的2项相比不能宣称规划交叉改善；后置产物/半径重试和引用约束改变了生成，不作单因素归因。
  30岛planning通过：acute 1、roadThroughSite 1、siteWithoutDoorRoad 0、crowded 5、loose 8，
  保持既有上限不变。相比P0的crowded 4、loose 3仍有小幅残留增长，不能称全部P1闭环或质量清零。
  8岛intent通过分类完整、只读及确定性守卫；其中1703461257/t3仍有3个未满足需求，守卫通过
  不等于需求满足。build仍有既有大chunk警告。跨引擎、冻结独立验收
  和 golden 对照未完成，未更新基线、阈值，也未提交或合并。

## 2026-10-10 P0 正确性修正（当前批）

- 未接关系的事务比较改用参与边 ID + 折线证据，兼容违例的空身份改为包含 detail 的键。
  同数量或更少数量的新位置冲突不再冒充旧问题；尚未实现完整 lineage/remap，保守拒绝仍可能
  阻挡保留既有接触的合法细分，不能写作 R0 已完成。
- 海岸截短须有原终点的显式岸路终点声明，保护主网锚点、设施 gate、路径和地块引用，验证
  原走廊地形/水域拒绝并同步更新终点声明。之前只靠近岸/近设施推断合法的行为被收紧。
- 普通路口恢复残留 SPEC 的35°要求，snap共用同一配置。旧connect测试曾要求32°交叉直接
  拆边；现改为零副作用拒绝，另测40°正常通过。此为合同修正，不沿用旧十样本交叉为零的结论。
- 新增 `verify-city-repair-safety.mjs`，由现有connect守卫自动执行：交叉从2减至1但转移位置
  的事务拒绝；合法声明的海岸截短正例；无声明/有owner/有锚点/有路径/无地形问题的拒绝；
  32°/40°路口边界。类型检查、该专项守卫、connect、6岛solve及30岛planning通过；planning
  仍报告acute 1、roadThroughSite 1、siteWithoutDoorRoad 0、crowded 4、loose 3，未清零。
  City生产build通过（既有>500KB chunk警告）；当前批未运行跨引擎/冻结独立验收，不能继承旧结果。
- 修改后的10+1 road-report通过报告确定性/顺序无关/无副作用检查：规划交叉逐样本
  `1/0/0/0/0/0/0/1/0/0`，共2项；显示交叉0、未分类端点6、门路距离代理11/12。
  旧十样本全零不再适用。当前只修正了接受条件，未证明这些残留已有合法替代路线；不得将
  报告测试通过等同路网质量验收通过。未对各规则变化做单因素归因或更新golden。
2026-10-10 新增待实施的 [残留闭环 SPEC](CITY_PLANNER_RESIDUAL_RESOLUTION_SPEC.md)，
将剩余接合、必需设施、桥头与求解门禁落实为 R0–R5；下表状态不因文档修订而改变。

| 范围 | 必须证明的最终状态 | 当前状态 / 验证入口 |
| --- | --- | --- |
| 0 诊断/回放 | 完整/显示图分开测量；路径直达率、变换/顺序/重复生成；同版本多相机截图可重建 | 部分：road-report 与套件接线已完成；截图、路径直达率、全部变换门禁未完成 |
| J 路口 | 严格交叉、近接 T、共线/多岔/折线统一真实图节点；共享几何与车流；禁止跨层误并网 | 部分：同交点多岔/精确 T/折线联合拆边、近接 T 事务连接器已接入；通用共线/重叠、分层及车流拆边映射未完成 |
| J 环路/意图 | civic/service/junction/landing 角色、入口、需求引用；实际入口路径驱动接受 | 部分：骨架锚点与 district-demand 接线；设施仍有距离代理，完整环路契约未完成 |
| A 安全 | 全路幅与模型实际占地、地形误差界、桥头支撑/净空；当前版本终筛；失败续试有预算 | 部分：宽度/交叉/引道守卫已有；本轮补动态预留及桥水段路幅；非圆/入口/支撑与连续误差界未完成 |
| B 道路优先 | 核心与滨水/港区均先生成并接受道路，随后生成街区/地块；共同事务、独立形态指标 | 部分：每个街块边界道路候选现先整体过安全终筛，再发布对应街块/地块；道路形状仍由旧格网顶点推导，不是走廊/图面优先生成 |
| C 展示/车流 | 共享主网、真实 owner/入口；必要路径按长度恢复；裁剪终验及有向 edge 路径/拆边映射 | 部分：锚点已共用，本轮补长度保路；真实入口引用、终验与有向车流契约未完成 |
| D 联合落位 | 车站/体育场在骨架后，实际 footprint/foundation/entrance 与接入补丁一起接受；候选拒绝诚实 | 部分：车站/体育场在骨架后经 `assignSite` 与地面道路接入草稿联合选候选，失败保留显式 obligation；当前 gate 是规划代理点，不等于模型门/真实通道，模型 footprint/foundation 未由规划器消费 |
| E 事务求解 | 策略草稿运行；按稳定安全/必要需求接受，拒绝零副作用；产物后置与错误/取消传播 | 部分：逐策略隔离草稿、稳定对象/分量接受、容量和地址身份保护、拒绝诊断已接入；断头 +1 松弛已移除；产物后置/取消/完整物理守卫未完成 |
| F 预算/性能 | 各阶段候选/拒绝/克隆/A*、累计预算、p50/p95/内存；版本化索引/缓存/取消及半径记录 | 未完成：不得以有限单次搜索或提交数声称整图预算已完成 |
| 整体验收 | 相同源码相关套件、四档独立验收、审阅后 baseline、跨引擎与视觉全部通过 | 未完成：2B调参普查仍有广泛残留；4B曾在源码未冻结时误跑并失败，结果不作最终验收也不得据此调参；规划/场景 baseline 待人工审阅，完整套件/最终视觉仍缺；未刷新golden，未合main |

证据纪律：每次记录提交或源码指纹、具体命令、样本与失败项；未运行的档位/阶段明确列出。
独立验收 seed 只用于验收，不能成为规则分支或阈值调优材料。新能力与已有兼容路径分开记录。
只有上述每项均有直接生产调用与对应范围的验证证据，才允许标记目标 complete。

## 根因分析前的 2B 调参基线与验收边界（2026-10-10）

当前源码尚未冻结，因此这轮只运行允许调参的 `node scripts/city-kit/survey.mjs 60 1`，未再次触碰
独立验收集。2B tier 1（60 seeds，152s，平均 score 3.523；score 仅供规划器对比）结果：
`unjoinedGroundJunctions` 32/60 岛、71 处；`siteWithoutDoorRoad` 13/60、20 处；
`looseInlandRoadEnds` 14/60、15 处；`crowdedArterials` 5/60、14 处；
`disconnectedComponents` 6/60、6 处；`bridgeheadContinuity` 7/60、7 处。
另有 `siteInWater` 1 岛、`sitesOverlap` 1 岛、`acuteJunctions` 2 岛；道路穿设施、地块侵入、
车站净距/朝向、市政广场、悬索桥净距等本轮为 0。该分布说明 30 岛固定规划门槛通过不能代表样本外稳健，
路口接合与设施入口尤其未泛化。接下来应按修复前后 2B 统计验证通用根因，不按单个 seed 加特判，
也不放宽硬安全门槛。

4B（`ACCEPT_BASE`）此前曾在源码未冻结时提前执行，tier 1 即因多项指标超限退出；这是无效的最终验收
尝试，只作为“当时构建尚不合格”的历史信号。不得用其样本/失败种子作为调参依据；只有源码冻结并完成
审阅后，才重新执行独立验收。场景 baseline 对比也曾因本轮规划输出变化而失败，变化尚未经过视觉审阅，
不得刷新 golden 来消除失败。

## 交叉兼容字段复核与归因纠正（2026-10-10）

`cityPlan.ts` 的地标门路桥候选、海滨端点合并、隔离分量跨河候选三处兼容字段已由
`crossings:false` 改为 `crossings:true`。后续读取 `validation.ts::validateCandidate` 确认：
终筛原本已无条件检查严格交叉，该字段不授予豁免。此前“消除安全绕过”的归因有误，
这三处修改没有行为收益，不计作已完成的安全修复。相关运行记录仍保留：connect、30 岛 planning、
31-seed geography、30 布局 V8/JSC cross-engine、
solve 和 2B 10-seed 小样均通过，`git diff --check` 通过；然而 2B 小样的全部问题计数与变更前相同
（未接交叉 4/10、站点无门路 3/10、重叠 1/10、锐角 1/10，其余列出的断头/扎堆/断连/桥头为 0）。
不得在报告中把固定规划通过或兼容字段修改写成样本外路网质量已达标。

## 残留根因分解与后续契约（2026-10-10）

同一 2B/t1 60 岛的只读细分：71 个未接边对中 47 个近接、24 个真交叉；真交叉中 17 个
具有不足 3 的短腿、5 个夹角不足 35°，两组可能重叠。20 项门路不足包含车站未落位 6、
体育场未落位 13、已落位摩天轮离路过远 1。6 个非主网分量都含歌剧院堤道，其中 4 个仅有
桥、2 个包含局部地面路。7 处桥头不连续分成 4 处堤道岸端及 3 处宽 12 的普通主干桥端。
两个主干桥头分别深入港口/庄园圆预留约 22.7/13.5 单位。候选/阶段日志尚不完备，
不能把这些终态证据声称为全部生成阶段原因的精确占比。

已确认的结构缺口：严格交叉终筛与近接诊断覆盖不同；节点重绑碰到重复边拒绝；生成/修复
道路可建条件不同且 `slope` 原因混合；必需设施候选全拒后未重新指派；堤道先发布后补岸路；
求解目录缺少未落位/断连/桥头闭环；部分关系违例没有 site/at，当前接受身份不足以识别问题转移。
固定 planning 门禁缺少未接关系/断连/桥头检查，intent 的“需求已判定”也不等于“需求已满足”。

新 SPEC 明确 R0–R5 的生产入口、原子补丁、预算、失败传播和测试矩阵，所有条目仍为待实施。
源码证据指纹及诊断方法见新 SPEC §1；本次仅更新文档，未执行新生产实现、未刷新 golden。

## R0/R1 共享关系与重复边消解检查点（2026-10-10）

City 源码内容指纹（算法同残留 SPEC §1）：
`efedfffd3a10ed8c741da2ca224acab089b4f8fb0460e19cbe52711dc7b28b6f`。
新增 `planner/relations.ts`，集中严格交叉原语、最短线段参数与关系分类。报告增加 relation/distance，
可区分端点接触/T、真交叉、共线区间、近邻节点、端点贴边与近似平行；footprint 与终筛复用严格
交叉原语。终筛仍仅对原先的严格交叉执行拒绝，尚未消费全部关系做规范化/联合提交，R0 未完成。
报告仍按边对聚合、部分共享端点关系仍沿用旧豁免，接触身份/lineage、全部阶段拒绝追踪还待实施。

R1 将近邻节点的共同邻点重复直边消解接入 `commitSnap`：保留兼容较宽边，节点重绑、边移除、
入口/车流/岸路引用在同一接受流程中完成。结构不兼容、桥域或全宽/角度/地块校验失败仍拒绝。
不要求共同邻点已成为三岔/锐角节点，因此补上了旧锐角策略不能触发的近接形态。

验证：typecheck、connect（新增已知答案/置换/反转/90°旋转平移、重复边与零副作用负例）、
road-report、solve、planning、30 岛 V8/JSC 一致性，Agent City UI 与 workbench build、diff-check 通过。
30 岛 planning 仍为锐角 0、穿设施 1、无门路 3、扎堆 4、断头 3；road-report 的十个规划样本
仍有 9 个未接边对，显示样本 0，不能把报告测试通过称为地面关系已归零。

`node scripts/city-kit/survey.mjs 60 1`：155s、平均分 3.524（仅诊断，不是受控性能比较）。
相对根因分析基线，未接关系 32 岛/71 处 → 31 岛/69 处；非法断头 14 岛/15 处 → 13 岛/14 处；
锐角 2 岛/2 处 → 1 岛/1 处。其它指标未增：门路不足 13 岛/20 项，断连 6 岛/6 处，
桥头不连续 7 岛/7 处，扎堆 5 岛/14 处，入水 1 岛、重叠 1 岛；道路穿设施与地块侵入保持 0。
本轮未再运行 4B，未更新 golden，未做最终视觉或全套验收，未合 main。R2/R3 与剩余目标继续实施。

### 规范化路口拒绝原因贯通（2026-10-10）

`connectGroundJunctions` 现在保留拒绝交点的节点坐标和原因（例如桥端保护、短腿、参与路廊不安全、
parcel 净距、NetworkPatch 拒绝），并报告预算耗尽。`normalizeGroundJunctions` 将这些数据回传给
事务求解报告；当部分交点接受、部分拒绝时，接受数和拒绝样例同时保留，不再只显示 changes。拒绝样例
最多输出 8 个，避免单岛报告无界增长。相关合成断言覆盖不安全 T 接的确切节点和走廊原因；typecheck、
connect、solve、diff-check 通过。此项只改善阶段归因，不改变道路几何，也不代表 R0 诊断完备。
本检查点之后只贯通路口拒绝诊断，当前 UI 源码指纹为
`c817e519be949cad1cd23d66640b498ba00f7bfd377fce0db7c4fbaf71a2a03a`；对应回归确认求解结果保持一致，
但没有对该指纹重新跑 60 岛普查或生产构建。

临街偏移试验曾把候选中心偏移从 `radius+12` 增为两个偏移值。60 个 2B 岛用时从历史 155 秒增至
168 秒，未落位仍为 13 岛/20 项，未接交叉升至 87 项、断连升至 7 岛；该候选扩展已撤回，保留原
候选预算与既有 frontage 分散采样。该试验不是当前版本验收结果。

堤道原子化试验进一步要求岸侧地面引道在同一草稿连到主网。命名三个 1 档种子分别被 site-clearance、
water-span/slope、以及入口 owner 校验拒绝；30 岛门前无路由 3 项升到 33 项。因为当前歌剧院落位
没有试岸点可达性候选，此原子化提交已撤回。下次应先生成/试算替代岸点和设施位置，再启用整组发布；
不能靠放松全宽、水体或坡度约束恢复通过。

### 歌剧院岸点与堤道接入联合候选（2026-10-10）

歌剧院海上选址现在保留通过深水、设施间距及陆侧粗筛的岸点候选（最多 40 个）；在道路主干与街网
生成后，按稳定顺序逐个试算“岛侧堤道 + 岸侧到现有地面路网”的完整私有草稿。两个连接都成功才发布
网络及桥注册，失败候选无副作用并继续下一个。岸侧阶段按当时现存地面路段接入，后续全岛连通阶段
再接入主网；最终仍须以 `disconnectedComponents` / `bridgeheadContinuity` 检验拓扑。失败样例写入
causeway connection log。求解规划门禁增加了断言：岸点必须有堤道和地面引道，或有明确失败记录。

验证：30 岛规划门禁通过（无门路 3、穿设施 1、拥挤 4、断头 3、锐角 0）；8 岛意图诊断通过；
30 个 V8/JSC 布局逐字段相同；typecheck、diff-check 通过。60 个 2B/tier1 种子、160 秒：
未接交叉 33 岛/75 处，缺门路 14 岛/21 项，断连 1/60，桥头不连续 3/60，非法断头 13/60，
锐角 1/60，拥挤 5/60，道路穿设施 0。对照此前同种子批，断连 6→1、桥头 7→3、断头 14→13；
缺门路 13→14、未接交叉 31/69→33/75，显示岸点重选改善桥路连续，但引入少量其它几何变化。
源码指纹：`1aae5ca5c3f4624c4a10d44f408bda18412e37a604de07ed0533a143fb41dbe8`。tier2/3/5 全档、
4B 冻结验收、完整构建及视觉/golden 仍未完成；不把当前局部通过视为整批完成。

补充当前 R2 区域候选后的 2B 样本外规模档（tier 3/5/10，分别 30/20/10 个种子）：tier3 未接交叉 34 项、缺门路 5 项、
断头 2、断连 2、桥头失败 4；tier5 未接交叉 20、缺门路 3、桥头失败 1，其余上述指标 0；tier10
未接交叉 5、断头 2、锐角 1、拥挤 1、桥头失败 1，其余上述指标 0。跨档数据说明 R1 的关系修复
与终筛仍未达零未接关系门槛，设施/桥路改善也没有闭合所有档位。

### 必需设施两级 frontage 与服务区候选（2026-10-10）

车站/体育场联合指派在原有 64 段 frontage 及四个探点全部失败后，才进入第二级：同一分散 frontage
上的密集探点，加上名义锚点周边 8 个半径档、最多 113 个区域候选。每个区域候选仍经过 buildable、
干地、主干/高架净空、设施间距与实际 connector 接入校验；入口路事务失败时不发布设施。候选顺序、
区域半径和最大候选数固定，失败原因同时记录主/后备阶段的候选数与拒绝直方图。此级只在主级穷尽
时运行，当前没有容量驱动的半径扩张，也没有低优先级设施交换。

回归：30 岛 planning 门禁通过，缺门路 1（此前 3），其它指标未越门槛；named 2B/tier1 60 岛批为
159s，缺门路由 14 岛/21 项降至 13 岛/15 项，未接交叉 33/75 降至 32/73；其它指标与加入 R3
岸点候选后的上一批相同。平均 score 3.523→3.448 仅作诊断，设施重新选址改变局部形态，不作为
门禁。候选重试行为版本通过 build、typecheck、30 岛 V8/JSC 一致性、8 岛 intent、diff-check；随后只把
歌剧院 40 岸点预算从字面量提取到同值配置，当前通过 typecheck、diff-check。行为版本源码指纹：
`361b29e6b99c2da3a9fa71c97054fbdc253dae02b72bf2bd045ad53e287ffe61`；当前源码指纹：
`c5d07a9d1c21d22e0b3586cb48c902d94e8b9e217a199a4fe025011ee0758066`。tier 3/5/10 在
本级接入后尚未复测，冻结版 4B 未运行；目前仍有 15 项门路不足与 73 项未接路口，目标未完成。

历史检查点 `ae48a7e6`：独立集 tier 1 缺门路 2/60、主干扎堆 3/60、断连 7/60、桥头连续失败 6/60，仍失败。
后续验收档位、完整套件、规划/场景基线与视觉未运行，不继承旧通过记录。新增相关回归、
typecheck/build、布局及跨引擎通过，只证明本轮能力，不证明上表全部完成。

## 生产联合选址与街块发布检查点（2026-10-09）

相对 `71c542a7`：车站/体育场改在骨架与滨水设施调整之后选址。候选从可达主网的非桥干道
上限 64 段采样，至多 8 个沿边探点；按既有软分排序后逐个联合尝试，只有实际 connector
草稿满足安全检查且能到主网时才发布 site 与网络。每个未成功的必需设施以 `siteObligations`
留在需求和守卫中，不能靠省略 site 降低需求数。`access` owner pose 与 gate 一起记录，显示
短边修复会保护 gate 节点。gate 是模型外的地块接入代理，尚未连接模型真实门、步行通道或基础。

街块生成仍沿用旧格网顶点/多边形。新逻辑先把一组边界道路候选作为整体交安全终筛，再发布
街块和地块，避免被拒的道路仍被当成边界；这只是原生成器上的原子发布，不是走廊优先或图面
围合生成，B 的形态目标仍未达成。道路终筛在 0.01 网络坐标规范化后匹配实际存储边，检查实际
宽度、结构与端点；跨端引擎差异测试此前发现的两 ulp 站点偏差因此得到修正。

本检查点实际通过：typecheck、connect、network-patch、sitespec、intent、solve、layout、build；
30 个 V8/JavaScriptCore 布局逐字段一致。独立普查 tier 1 仍失败（其余档位及调优线未运行）：
缺门路 6/60（上限 1）、道路穿越设施 3/60（0）、内陆松散端点 20/60（16）、锐角路口 5/60（4）、
断连 7/60（2）、桥头连续失败 6/60（5）。未更新 golden。失败项仍是生产问题，不能视为门禁通过。

## 事务求解接入检查点（2026-10-09）

相对 `ae48a7e6` 继续实施 E：修复在深复制草稿内运行，地形函数保持只读；接受后保留官方
Map/数组容器引用并提升网络版本。所有注册约束禁止计数增加及新对象违例，主网锚点与原分量
继承关系不能失联/拆分，已满足 required 需求不能失去。地块容量和既有 parcel id 不得丢弃。
至少有约束/需求实际改善才接受，禁止靠“策略返回了变化数”认定进展。

回归已覆盖草稿嵌套数据/日志零泄漏、异常零泄漏、容量拒绝、无改善拒绝及安全改善发布；
六个规划样本的全部目标约束单调，移除断头 +1 松弛。加入独立车站朝向候选及路口/删枝组合草稿，
避免不合法的批量落位或中间断头被单独提交。

仍有失败：显示布局守卫在默认 `1927/t1` 的空城样本上，255/257 节点连通；实际保路报告
列出两个不可达桥节点，不能删掉报告或放宽连接断言。最终源码 diff SHA-256（相对 `ae48a7e6`）：
`7f7f768dde2343437088dd20054cb39e1781a1945a736ae8ba23172355f94e97`。
独立集 tier 1 仍有缺门路 2/60（上限 1）、断连 8/60（2）、桥头连续失败 6/60（5）；
车站朝向/锐角/主干扎堆不再超限。失败后未运行其余验收档位，不继承旧通过记录。
typecheck、事务/单调求解与意图回归、build 通过，30 个 V8/JSC 布局一致；布局守卫仍失败，
完整套件和规划/场景 golden 未运行。代码检查点为 `feabf8df`，未合 main。
本检查点不是 E 或整个目标完成；完整入口落位、桥头与道路生成继续实施。

## 系统复盘与调参基线（车站入口方向修正前，2026-10-09）

复盘后将缺陷分为三组，避免把同一座岛的“缺门路”与“桥头/断连”混成一个症状：

1. 设施合同不完整：production 只给 station/stadium 规划圆半径和虚拟 `plot-gate`；它不消费
   模型入口/基础形状。站房渲染入口在局部 `z=-0.62r+3.55`，而规划门向守卫使用局部 `+z`，
   且 gate 和 yaw 由同一个方向生成，存在自证通过、门面反向的风险。需从共享模型几何声明取
   实际门位/正面方向，再联合验证门到道路节点的接入；圆形保留仍是临时兼容近似。
2. 路网落地不完整：`disconnectedComponents` 按图分量计数，`bridgeheadContinuity` 单独检测
   桥端是否有非桥地面边，两者相关但不等价。独立样本诊断 `3000523645/t1` 曾同时显示两项
   设施未落位，另有一个桥端无地面边；这只用来发现症状。随后该独立样本被用于候选参数试验，
   因此相关 3B 运行不作为最终门禁。此处不据它调阈值或写 seed 特例。
3. 形态生成仍未改根因：街块的边界候选虽整体验收成功后才发布，但候选形状仍来自原规则格网；
   这能避免“无边界路的街块”，不能解决重复尺度、港区过渡和骨架穿越街格。

允许调参的 2B tier 1 当前运行（源码/脚本 diff `9b3d3ea0fc27d16a0a7462ed6e1d7b3d1ee7a6bd67c3ff2995e99840533f3f11`）：
`node scripts/city-kit/survey.mjs 60 1`，60/60 完成，用时 162 秒，平均规划分 3.959（仅比较值）。
计数：缺门路 13/60、道路穿越设施 0/60、内陆松散端点 22/60、锐角路口 5/60、主干扎堆 7/60、
断连 7/60、桥头连续失败 7/60；其余列出的约束均在该档阈值内。相对先前调参检查点，路穿用地
从 1 降到 0，松散端点与主干扎堆各增加 1，断连与桥头各减少 1；仍有多项超限，不能调高阈值。

历史注：上述证据及问题状态以该段标题的“修正前”时间点为准。后续修正与当前证据见下节。

## 系统复盘更新（共享入口几何修正后，2026-10-09）

代码复核发现车站局部门面位置确为 `z=-0.62r+3.55`，之前规划曾把朝向按局部 `+z` 计算，且入口守卫只验证由同一向量生成的 gate/yaw，存在自证通过。现新增共享 `publicSiteGeometry.ts`，渲染与 planner/constraint 共用门位定义；联合选址将门位置变换到世界坐标，入口方向按门到 gate 检查。此修正消除方向定义不一致，但不是完整无障碍路径/站房基础占地证明；stadium 仍没有模型门声明，`plot-gate` 仍是地块接入代理。

当前代码/脚本差异指纹（相对 HEAD `71c542a7`，不含文档）为
`8b3c252a70ed4da914bc35d6ca9a9e724cccde74bc5bccef0c9dfbb7f27e15a9`。该指纹下已通过 typecheck、sitespec、intent、solve、生产 build、布局验证（`verify-react-city-layout.mjs`）及 `git diff --check`。cross-engine 曾在该入口修正后启动，但截至本复盘未取得可确认的完成输出；因此不列为通过。完整套件、同指纹独立多档普查、规划/场景 golden 和视觉截图未完成，未更新 golden、未合 main。

多 seed 数字仍只引用上一节 hash `9b3d3e…` 的 2B 调参集，不可外推为当前指纹结果：缺门路 13/60、松散端点 22/60、锐角 5/60、主干扎堆 7/60、断连 7/60、桥头连续失败 7/60。按已知门槛，至少缺门路、松散端点、主干扎堆、断连和桥头项不满足；需在当前源码冻结后重跑调参集，再使用从未用于调参的 3B 独立集验收。此前曾用 3B 样本观察后尝试候选参数，后续扩大偏移/降宽尝试已回退；那次 3B 数字永久作废为验收证据。

### 问题树与当前根因边界

| 层次 | 症状/根因 | 当前判断与下一步 |
| --- | --- | --- |
| 规划输入与落点 | 站/场馆在骨架后才联合选址；可用 frontage 只取主网已达、非桥且宽度≥8的地面边；候选受圆形 footprint/路幅 clearance、地块与水岸等约束 | 无可行候选就诚实记 `siteObligations`，但 2B 曾 13/60 缺门路。先用拒绝原因直方图复盘地形/岸线/前沿覆盖，不能放松安全约束或把未放置当成功 |
| 设施物理接入 | gate 与道路草稿事务连接，网络成功才一起发布；站门世界坐标现在引用共享局部几何 | 尚无从真实门洞穿过自有用地到公共路的 walk/path 几何、基础/非圆并集占地；stadium 门仍无模型声明。后续需要 footprint+entry corridor 的物理合同与生产守卫 |
| 网络生成 | 完整图上的断连、桥头是两种独立指标；样本可出现桥端无地面边，也有非桥组件未连主网 | 历史 2B 分别 7/60、7/60，远超门槛；必须定位骨架/桥梁落地/修复哪一阶段生成，并对完整最终图验收，不得通过错误直连掩盖 |
| 几何拓扑 | 锐角/拥挤交叉与“图分量已连通”不同；节点连通不保证平面相交处共享 junction，也不保证道路形状可驾驶 | 历史 2B 锐角 5/60（达上限）、主干扎堆 7/60（超限）。J 仍需多岔、近接 T、共线、折线和层级合同，当前局部连接器并非通用路口化 |
| 最终展示图 | 活动裁剪/建成增长会删改部分道路，原完整规划图的连通/交叉门禁不能代表渲染图 | 对 grown/display graph 重跑相同路口/端点/桥头检查；把合法尽端、可接近缺口、未连接交叉分别报告 |
| 城市形态 | 原子发布减少街块与边界路不一致，但道路仍由格网面派生 | 这是“规划好看”的结构性缺口，不会被 junction/连通修复自动解决；需要走廊/图面优先生成与核心/港区等形态指标 |
| 预算与证据 | 60 个 tier1 用时 162 秒；没有阶段候选/拒绝/克隆/A*预算、p50/p95/内存数据 | 当前缺少可归因性能指标；最终前应按阶段记账，并绑定源码指纹、配置与 seed 集 |

因此，近期优先顺序建议为：①修复最终显示图拓扑终筛（避免“完整图通过、显示图断头/假路口”）；②把设施入口从点 gate 升级为真实门位+通道+基础 footprint 联合事务；③按阶段诊断 bridgehead 与 disconnected，再针对生成阶段修复；④完成通用 junction 几何与需求环路；⑤再推进走廊/图面优先形态和预算。每一步都以安全零副作用和多 seed 分类验收为门槛；当前不能合 main。

### 显示图必要接驳保留（2026-10-09）

`growWithBuildings` 现在把已声明 `PublicSite.access.nodeId` 加入路径需求，不再只用活动区/设施附近的道路端点代替设施 gate。新增 `retainBridgeLandings`：对每座保留桥的每个端点，至少保留一条已存在的地面接驳边；已有保留地面边时不增加第二条，否则按实际折线长度和稳定 id 选择。桥与桥相接不满足地面接驳条件。所有恢复均只使用原规划边，无新路线；不存在接驳边的端点进入 `retentionReport.missingBridgeLandings`。该字段是原始缺失记录，包含可能合法的海上设施堤道尽端，尚未完成角色豁免投影，不等于全部物理桥头违例。

意图回归已覆盖相接桥无地面边、gate 不在活动边选择内、顺序置换与输入无副作用；typecheck、intent、build、完整布局回归（包含新增 gate 保留及桥头接驳保留/缺失诊断断言）及差异检查均通过。本批只防止裁剪删除已存在的设施接驳和桥头地面边；最终交叉、端点角色、车流有向路径与完整图原有缺陷仍未完成。

### 同交点联合路口与实际折线拆分（2026-10-09）

事务原语此前只按宿主首尾弦线定位拆点，并把两半重建成直线；现在按每个实际折线段定位，保留全部弯点和宿主属性，拒绝首尾弦线上的离线点。拆分产生的 id 与既有边冲突时拒绝，防止覆盖不同宽度/形状道路。`connectGroundJunctions` 从逐对四岔拆分改成按规范化交点分组，一次提交所有宿主拆分，兼容精确端点 T、六岔等多岔和折线内部交点。最小支路长度、所有支路方向夹角及参与路段实际路幅/地形/用地净距共同验收；交点已有桥端点时拒绝地面并入。

合成回归已验证六岔原子单次发布、顺序无关/重复执行无新增、精确 T、实际折线弯点保留、不安全既有 T 支路零副作用拒绝、离线弦拆点拒绝以及拆边 id 冲突拒绝。typecheck、network-patch、connect、完整 layout 与 build 通过。30 岛 planning 在松散端点 21>10 处失败；以 esbuild 只读替换 junctions/network 为 HEAD 版本、保持其他生产源码一致的前后对照，全部约束总数相同：松散端点21、断连8、桥头失败5、道路穿用地1、主干扎堆4、缺门路3、锐角2。因此此次路口原语扩展没有造成该批回归岛的指标退化，但未修复原有超限。共线重叠、通用近接 T、层级高程、交通拆边引用以及最终显示图统一终筛仍未完成。

### 连续桥头角色纠正（2026-10-09）

松散端点诊断暴露另一处合同缺口：约束只数非桥子图的度，一处桥边与地面边共享的真实节点在该子图内度1，但在完整路网内连续。现在 `bridgeLandingNodes` 只识别同一节点 id 同时接地面边和桥边的关系，constraints、repairs、networkRepairs 复用该合同；intent 增加 `bridge-landing` 角色并附桥 id，roadReport 的地面度1节点增加独立 bridgeLandings 分类，不把它画成 cul-de-sac。原有 bridgeheadContinuity、disconnectedComponents 门禁仍独立执行，空间近邻没有豁免。

合成反例断言两个真正的道路尽端仍计松断头；连续桥头有独立角色；相距0.01但节点不同的地面路不能满足桥头连续，仍计桥头中断及孤立分量。typecheck、network-patch、connect、intent、road-report、30岛 planning、最终分类源码的完整 layout、生产 build 及差异检查均通过；planning 最新值为松散端点4、锐角2、道路穿用地1、缺门路3、主干扎堆4。角色修正前21个松散端点中17个为实际连续桥头；没有调整阈值。此次未运行新的2B全量调参普查、3B独立验收、完整套件、cross-engine或golden，不继承旧运行的通过状态。

road-report 的10个2B规划样本与1个显示样本仍只做诊断，其交叉质量断言尚未启用。显示样本 `523001688/t2` 为1个分量，但仍有3处平面未共享节点的交叉、16个可接近裁剪缺口、6个未分类地面度1节点及11/12设施邻近主网道路；该报告的设施口径还是距离代理，不含未落位义务分母。这些数字不能当成显示图质量完成证据，也不能替代真实入口/独立验收。

### 活动裁剪后的必要路径闭合（2026-10-09）

具体路段复核发现上述3处交叉报告包含1处真实交叉与2处约0.02–0.16单位的近接缺口；不能仅按严格交点拆边消解全部问题。裁剪缺口则是独立问题：原保路只确保节点到主网可达，未要求裁剪产生的非合法尽端保持道路延续。

新增 `preserveDisplayJunctions` 在设施/桥头保路及主网路径恢复后执行：对完整规划非桥度>1、显示度1且没有合法终点角色的节点，只沿未保留的原规划地面边寻找另一已保留节点，按实际折线长度恢复最短闭合路径。已声明的设施入口、连续桥头、合法尽端保留原角色；不存在闭合路径时写入 `retentionReport.unresolvedPruningEnds`。没有新建走廊，也不以任意补画回车圈掩盖缺口。此批合成回归包含环路被裁成两断头、长短备选路径、输入无副作用、边顺序置换、重复执行、合法端点不扩路及无环无法闭合的显式失败。typecheck/intent、road-report 与完整 layout 正在验证；交叉合并及最终完整拓扑门禁仍待实施。

本批验证结果：typecheck、intent（新增闭合合成反例）、完整 layout、build、road-report（新增固定显示样本裁剪缺口为0以及只保留原规划边的断言）与差异检查通过。固定样本 `523001688/t2` 的裁剪缺口16→0、地面度1节点30→12、保留道路547→583、图分量仍为1、锐角仍为0、未分类端点仍为6、交叉仍为3。代价是空置区窄路总长1587.26→2845.44，其中原报告的无活动支撑路径长度988.79→2246.97；恢复36条原规划边，性能及形态门禁仍需评估，不能只按缺口清零宣称C完成。

### 亚单位近接节点事务合并（2026-10-09）

新增 NetworkPatch.rebindNodes：将源节点全部关联边重绑至在册目标，保留实际折线和自定义宽度；边身份冲突或自环拒绝且无副作用。生产 snapNearJunctions 在求解草稿中处理≤0.5单位的地面近接，保护骨架锚点，拒绝桥端跨层合并，检查各支路全宽走廊、地块净距、最短支路及35°夹角；按重绑后的边身份检查不能引入新的交叉关系。设施 gate、车流、岸路 runs/端点引用与道路一同接受。repairAcceptance 和 solveReport 已消费新增 unjoinedGroundJunctions 约束（与道路报告复用相同交叉口径），无接受候选时把草稿拒绝原因返回诊断，不发布草稿。

合成回归通过：0.16单位近接合并为真实T且不增加微小边，gate/车流/岸段引用重绑，重复执行无变化、用地挡路拒绝、折线和宽9完整继承以及自环拒绝零副作用。typecheck、connect、network-patch通过；早期接线快照的solve、road-report、layout/build通过，但那次固定显示样本交叉仍为3。随后增加了逐交叉身份保护和失败诊断，solve复验6岛通过，不能继承早期build/layout为最终源码验收。

具体固定样本的生产拒绝已通过只读bundle插桩核实：`-26.91:-458.33 → -26.8:-458.44` 合并关联路段 `-26.8:-458.44/-40.9:-472.62` 触发 site-clearance，另一个早期候选还曾触发边ID冲突。两处近接报告不是“加边距离太小”这一个原因；现已存在合并能力，仍需要识别并修复原用地/路幅冲突。剩余真实交叉的拆分短腿约1单位，小于3单位守卫，仍需联合端点调整。此处不放宽净距或最短支路阈值；三处尚未解决，整体验收仍未完成。

### 市政实体占地接入与近接缺口消解（2026-10-09）

后续定位纠正上节冲突归属：被圆盘阻挡的是 civic-square，而非其他建筑。现有广场环路中心线距中心约52.004；圆预留44 + 道路半幅6 + 安全余量3 = 53，导致既有环路也被圆盘守卫拒绝。圆预留包含开放广场，不能替代实体轮廓。新增共享 `civicGroundFootprint` 的六矩形保守并集覆盖基座、增长翼、塔带、两种台阶及旗杆/旗帜带；渲染消费共享基座和旗杆位置，数据相关旗杆数量过多时缩小间距使其始终位于声明内。生产 civic radius=44 下基座和四旗位置保持原样。snap 对这些实体执行旋转局部空间中的精确线段到矩形距离，与道路半幅及同样3单位余量比较，其他用地保留原圆盘守卫。

回归覆盖广场环外廓净距、道路穿基座拒绝、高档台阶/旗带全路幅拒绝与1/4/30旗声明覆盖。typecheck/connect、solve6岛、build及道路报告通过。固定显示样本近接报告2处已通过共享节点消解，未接入交叉3→1、裁剪缺口仍0、图分量仍1、锐角仍0、道路582、节点465、地面度1节点11、未分类端点5。新增固定样本重复节点移除与至少三条路共用 canonical 节点的生产回归、完整layout均通过。新增unjoinedGroundJunctions在独立普查中显式要求0，不放宽原门槛；独立普查/其余档位尚未运行。仍有1处短残段真实交叉，市政其他生产连接器的实际占地消费、完整物理基础及最终拓扑门禁未完成，不能宣称所有任务完成。

### 短残段交叉转真实T（2026-10-09）

具体剩余交叉的尽端 `454.18:-55` 只接一条路，严格交点为约`453.41:-55.63`，原四岔拆边会产生约1单位残段。新增 snapShortCrossings：交点距道路端点<3单位时，将该端点移动到规范化交点，并在同一 NetworkPatch 中拆分另一宿主及重绑全部关联边。共用 commitSnap 的路幅/地形/用地/地块/35°夹角守卫；新T的每条实际支路仍需≥3单位。原骨架锚点不移，桥端不参与，不能新增既有交叉集合以外的关系。拆分后的边身份映射与原交叉关系一同检查，避免把原宿主拆分误报成新交叉。

车流与岸路路径在同一草稿中重绑移动端点，并插入宿主拆分节点，拒绝时保留原路径。合成反例验证1单位短残段转三条真实边的T、单次发布、宽12继承、宿主路径插入节点、移动路径同步、重复执行无新增及用地阻挡时网络和路径零副作用。typecheck/connect、solve6岛通过；其中1个求解样本的未接入交叉1→0。固定显示样本road-report、完整layout/build仍在复验，不先宣称该样本清零或整体验收完成。

本批最终验证：上述固定显示样本交叉1→0、裁剪缺口0、分量1、锐角0；道路581、节点464、地面度1节点10（连续桥头2、合法尽端3、未分类5）。固定显示图交叉为0的断言已启用并复验通过，完整layout、build及差异检查通过。显示门路距离代理仍11/12，桥缺失报告仍1，未分类端点仍5；10个2B规划样本仍有0–8处未接入交叉。这些未被固定显示样本通过覆盖，独立全档、完整物理/入口/形态/性能与golden仍未完成。此次road-report复验耗时163448ms（与layout并行）；不能把运行时长变化直接归因为算法，需按阶段和资源另作测量。

当前源码内容指纹 `2bad7b0130b1360091b5bb9e1dcd80c4ffdf117b57876f21e83326e352bd198a`：递归遍历`apps/agent-city/ui/src`和`scripts`，各目录按文件名排序，纳入`.ts/.tsx/.mjs/.js/.json`的相对路径、NUL、内容、NUL；再纳入两份UI依赖锁，最后纳入Node版本/平台/架构。共217个源码/脚本文件，环境v22.23.1/darwin/arm64。包含未跟踪的新几何/净距/合并模块；先前单纯`git diff`指纹不包含未跟踪文件，不能作为完整源码指纹。文档不在本指纹内。

### 逐段度量、后置规范化及近接路段（2026-10-09）

groundJunctionFindings 改为逐个真实折线段检测，按原道路边对去重；共用某个远端节点不再免除别处的第二次未建模交叉，只豁免两段都实际接在共享节点的局部交汇。合成反例覆盖首尾弦线假交点、实际折线交点、共端后远处再交和边序置换。一般 connectGroundJunctions 接入求解草稿（normalizeGroundJunctions），后续接入/修复产生的严格交叉也能继续规范化；精化车流和岸路路径，并在量化后的实际支路上复查走廊与既有parcel净距。市政实体并集净距与普通圆预留净距合成一个共享入口，snap与一般路口复用，桥端层级保护保持。

最差2B样本2000628374/t1的8处剩余报告中，多数是端点到路段约0.15–0.19单位近接，但相邻注册端点相距1–2单位；原“节点对≤0.5”及“严格相交”两路均覆盖不到。新增snapNearEdgeJunctions：按实际宿主段投影，内段拆T，投影距宿主端点<3则在最多3单位移动范围内合并该端点，完整净距/角度/路径合同不变。连续两路的合法折角也可合并，不要求所有连接都必须三岔；角度和每条支路≥3单位保持。合成回归验证内段拆T、近宿主端合并以及旧节点距离门不应误接受；connect和solve6岛通过，多个求解样本的交叉数进一步下降，其他约束不恶化。当前road-report、完整layout与build正在复验；旧指纹与旧整体验收记录不继承。

独立验收修正：旧3B曾用于候选参数试验，永久不作为独立验收。verify-city-survey 的 ACCEPT_BASE 改为4_000_000_000，步长、档位、样本数和全部约束门槛不变；4B只在源码冻结后验收，不查看其样本调参。当前可见源码和审计台账未见既往4B调参记录。4B尚未运行，不能声明独立通过。

本批复验结果：typecheck、connect（新增逐段/共享远端再交/后置路径精化/近接宿主合成反例）、network-patch、solve6岛、road-report、完整layout、build、独立脚本语法与差异检查通过。相同10个2B报告样本的交叉合计19→10，逐样本为1/0/2/0/0/0/5/0/0/2；其中最差2000628374/t1为8→5，2000733103/t1为3→0，2000418916/t1为1→0。固定显示样本交叉0/裁剪缺口0/分量1/锐角0保持。新度量不以首尾弦或共用远端节点掩盖折线关系，反例独立验证；不能因生产样本恰为直线而省略这项要求。剩余近共线重叠和安全条件拒绝继续处理，全图交叉为0尚不满足，4B/完整套件/当前跨引擎/视觉/golden未运行。

本检查点内容指纹（沿用上一节217文件、依赖锁和环境的算法）为`2ab641314df7bcecc5491919a206f4d6e4ed0ff55adb751bd8526106040d15a0`，环境v22.23.1/darwin/arm64；不含文档，包含未跟踪源码。此指纹不能继承旧版本的独立/跨引擎/视觉/golden记录。

### 宿主结构类别继承（2026-10-09）

最差2B样本的残留诊断进一步定位两类独立拒绝：桥头引道被普通地面路口守卫的buildable/坡度0.9条件拒绝，以及近乎平行的重复走廊在合并后违反35°夹角。前者是类别合同不一致，不能靠放宽普通道路阈值解决。groundJunctionCorridorFailure 现在接收实际原宿主；已注册桥头引道使用现有VALIDATION_CONFIG.roadApproachMaxSlope=6且不套建筑可建判据，仍查全路幅水域、有限坡度、实体占地和同样3单位余量。端点水线未增加新豁免。拆分后的两半均按原宿主检查，不能因其中一半不再直接碰桥而降成普通路。

RoadEdge 新增可选structure（ground-road/ground-approach/deck），由addNetworkEdge根据已在册桥关系生成：桥先建/后建均标记对应地面引道，deck自身明确标记；事务拆边/重绑保留原字段。丢弃的重复桥提案不得把已有地面路误标为引道。标记不等于完整layer/高程或基础证明，也不意味着其他连接器已全部消费该字段。

合成反例验证同一坡度2的路线作为普通路仍拒绝，作为真实桥头引道可接受；引道远半段继承宿主，坡度7仍拒绝。network-patch验证结构继承、桥先/后创建、自环及重复桥无伪证据；typecheck/connect/network-patch/solve6岛通过。类别参数接线阶段的10样本报告仍合计10处交叉，说明类别修正尚未解决近平行几何本身。结构字段持久化后的road-report、完整layout和build正在复验，独立4B及其他最终门禁未运行。原碎边收缩仍有直接改表路径、跨层/支撑合同仍不完整，后续必须继续收口。

结构字段持久化后的road-report、完整layout、build及差异检查均通过，10样本交叉仍为10，固定显示样本交叉和裁剪缺口仍0。跨引擎摘要已增加structure列以覆盖新增结构合同；尚无该源码的跨引擎完成结果，独立4B和完整套件/视觉/golden仍未运行。该批是结构证据与验证类别修正，不能写成交叉已进一步减少。

### 终端重复走廊整合与受保护连接诊断（2026-10-09）

新增consolidateTerminalCorridors接入事务求解：两条直地面路角差≤15°，较短终端段落在更宽/同宽长宿主内、中心偏移≤0.5，并通过≤3单位短连接接在同一走廊，才提出整合；有独立入口/交通/岸路引用的终端不删除。保留长宿主和桥体原坐标，移除冗余终端段及短连接，重绑独立支路、gate、交通/岸路坐标。接到已注册桥端的地面支路标记为ground-approach；不移动桥体，也不让拒绝的提案制造结构证据。新几何必须满足原交叉关系集合、全路幅/地形/用地/parcel净距及35°/3单位支路规则，并经过外层所有约束、需求和容量的接受检查。整合不得把一整条路径压成单点，别名合并后的连续重复坐标去重。

合成反例覆盖桥体不变、一次提交、独立支路/gate/路径保留、地面引道结构、重复执行无变化；终端有owner、被交通使用或触碰保留parcel时零副作用拒绝。typecheck/connect、solve6岛、road-report、完整layout/build通过；10样本交叉仍为10，实际候选尚未成功提交，不能把合成用例通过写成生产残留已消解。

生产2B候选明确被接收桥头已有支路`-31.56:236.24 → -23.01:250.69`的water-span拒绝。采样显示其终点/靠近终点的侧缘低于0.5道路干地阈值；正高度不等于实际海面以下，本台账仅按既定验证阈值分类。只读插桩核实该中间节点度2、连到`-37.28:259.54`，不是可任意删除的孤立尾段。试验性的辅助叶链清理未解决候选，已从生产代码回退；当前整合不删除这条连接。后续应保留连通并重定线该未被owner/路径/街块顶点引用的控制点，而不是删除必要连接或降低阈值。

为安全重定线，NetworkPatch.rebindNodes增加targetAt，允许在同一草稿中创建规范化新坐标并重绑全部关联边；目标ID与坐标不符、非有限坐标、碰撞、自环或校验拒绝均不发布。新增原语回归覆盖宽9/折线保持、旧节点清除及失败不遗留新节点；实际重定线候选生成尚未接入。最终新增原语的typecheck/network-patch/connect与差异检查通过，不继承整合阶段的广泛测试为新增功能验收。独立4B/完整套件/当前跨引擎/视觉/golden仍未运行，目标未完成。

重定线/事务边界更新（2026-10-09）：候选节点移动能力保留为仅适用于未被入口、车流或街块边界引用的二度地面节点的有限方案；半径至多16、每节点至多96候选，所有受移动道路仍需通过水域/地形全路幅、实体/parcel净距、交叉、夹角和最短支路检查。真实失败的原因进一步澄清：该整合动作只删除重复终端段和短接边，桥头旁低于现行干地阈值的既有引道并未被几何修改。原验证错误地要求所有相邻既有边重新通过水域检查，导致无关的既有违例阻止了删除。现改为只对真正重绑或移动的边做物理终筛；仍对目标节点所有连接边检查交叉集合和夹角，未改变的引道留给独立A安全策略处理。合成回归证明该操作保留既有低地引道及另一支路，不产生副作用。实际2B候选现提交`changes:1`。完整road-report显示交叉从10降至9，逐样本`1/0/2/0/0/0/4/0/0/2`；最差样本5→4，连通分量仍为1，未分类度1端点从8降至7；显示样本维持0交叉。typecheck、connect、road-report、完整layout、生产build及30岛跨引擎一致性通过。剩余9处交叉及未分类端点仍未满足；4B、完整套件、截图/视觉基线、golden审阅与合并仍未完成。

## 亚单位相邻路口的坍缩连接边（2026-10-10）

当前代码重新生成 `2000418916/t1` 后，2处交叉均来自同一几何关系：主干端点`529.39:18.97`与另一路口`529.43:18.8`相距0.1746；两节点间已存在一条同样短的道路边。普通 rebind 会把该边变成自环而拒绝；删除整段邻接支路则会损失拓扑。该相邻路口另有一个原有约2.3单位支路，不能把短支路阈值全局降到该值。

`commitSnap` 现在仅在≤0.5节点间隙且连接边本身为非桥、两点、长度≤0.5时，将这条坍缩边与节点合并置于一个事务；桥或更长直连仍拒绝。仅对此类亚单位合并，允许既有<3单位支路原样保留，要求合并后非零、角度仍满足、且长度缩短不超过原节点间隙；新产生的短支路仍拒绝。全幅道路净距、实体/parcel净距、交叉关系及网络事务校验不变。新增合成回归复现已有短连接 + 原有短支路，验证零交叉、属性边保留与3单位合同未普遍放宽。

当前指纹下`npm --prefix apps/agent-city/ui run typecheck`及`node scripts/verify-city-connect.mjs`通过；精确规划样本`2000418916/t1`交叉由2降至0。该样本仍有6个未分类度1端点和1个缺地面接驳桥头，故只证明本关系修复；10样本 road-report 是修改前输出，尚未复验。全档独立普查、跨引擎、生产 build、视觉/golden 及其他R0–R5门禁仍未完成。

随后完成修改后同10样本road-report复验：crossing逐样本`0/0/0/0/0/0/4/0/0/0`，总数4（紧邻修改前同组为`0/0/0/0/2/0/4/0/0/2`，总数8）；变化集中于本修复作用的`2000418916`（2→0）及同类`2000942561`（2→0），其余不变。显示图crossing维持0；`2000628374/t1`仍有4处crossing、最小路口角0.97°，而10个规划样本各仍报1处桥连续违例。typecheck、connect、network-patch和road-report均通过。此为调优线局部诊断，不构成独立普查、全桥接/路网/形态闭环或最终验收。

修改后2B tier1 60-seed survey（`node scripts/city-kit/survey.mjs 60 1`，约149秒，平均score 3.449仅诊断）结果：unjoined关系29/60岛、66 findings；修改前同一连续工作线调查为31/60、72 findings，方向一致地减少2岛/6项，但这不是独立验收集。其余：siteWithoutDoorRoad 13/60(15)、looseInlandRoadEnds 13/60(14)、crowdedArterials 5/60(14)、disconnected 1/60(1)、bridgeheadContinuity 3/60(3)，siteInWater与sitesOverlap各1/60；acuteJunctions现为0/60（原1/60）；roadThroughSite、parcelInsideSite、门朝向、设置退距、拱门跨路、广场中心、高架/悬索净距均0。下一问题树应转向未接关系中成簇的端点近接/部分共线走廊及其余跨路关系，不得把新桥隧形态当成这些平面拓扑症状的默认修复。

### 受保护锐角支路的几何修复与测量口径（2026-10-10）

`2000628374/t1`的`219.1:305.59`锐角三岔不能通过删路解决：局部路是地面网络的必要连接；mini-roundabout受电视塔实体净距阻挡，重定线也未通过物理/地块检查。现仅在小型普通地面路满足条件时尝试端点固定的平滑弯曲：每段长度≥3、端点夹角≥30°、局部转角≤15°，全路幅走廊及parcel净距合格，且不新增未接交叉；特殊结构、被路径/地块边界引用或无法安全弯曲时拒绝并保留诊断。精确样本角度由0.97°修至≥30°，道路仍在、分量仍为1、交叉仍为4，未声称解决交叉本身。道路报告角度改用折线实际端点切线而非端到端弦线，并加入曲线路径合成回归，保证报告与规划约束采用相同口径。

验证：typecheck、connect、30岛planning、10样本road-report和`git diff --check`通过；planning报告锐角0，road-report对该样本报告最小角33.24°、cross=4。修改后60-seed 2B普查的acute为0/60。跨引擎、独立4B、全套件、视觉/golden仍需验证；其它残留及最终验收未完成。

### 必需设施候选拒绝的 2B 细分（2026-10-10）

对同一 60-seed/tier1 调优集重新读取每个站点约束和 `siteObligations`（不改变源码），结果仍为 `siteWithoutDoorRoad` 13/60 岛、15 项。15 项中有 13 项是必需车站/体育场未联合落位（2 个 central-station、11 个 east-stadium），另有 2 个既有非必需岸边地标距离违例（摩天轮和歌剧院各 1）；因此不得将兼容汇总值 15 解读为 15 个必需设施失败。

必需设施拒绝直方图的首要原因：`buildable-center` 6 项、`dry-footprint` 4 项、`site-spacing(+10)` 2 项、`clear-of-highways` 1 项。每个失败对象已枚举 192–523 个 frontage/region 候选，但候选仍未满足硬约束；该次数只是有限候选集耗尽，不证明全岛无可行解。地形/干地及环线净距占 11/13 首因，当前并非单纯“门路太远”，也不能通过放松物理门槛修复。R2 下一步应检查候选生成覆盖/重选高优先级必需设施与可选预留的交易，并保持显式失败和分母；同时把候选集合完成与预算耗尽分开报告。该诊断没有带来生产代码变化，也没有验证 4B。

### 必需设施外圈候选作为失败后追加层（2026-10-10）

原 2B 调优诊断显示 13 个必需设施拒绝中，buildable/dry 是主要硬约束；扩大候选能补足搜索覆盖，但不能改变硬门槛。首次将192/353个既有frontage/区域候选与外圈一起排序，虽把门路缺陷降到11/60岛、12项，却把旧可行布局重新排序，导致未接关系29/60、66项→30/60、67项且运行增至1471秒，已撤销该排序方式。

现将外圈作为严格追加的第三级：主frontage和既有半径0–168的候选完全失败后，才枚举192/216/240半径的24方位；只预筛数学上无法满足连接器半径（gate偏移`r+8`、最大接路`r+30`，故中心距主网须≤`2r+38`）的点。硬选址、全路幅、用地、地形、门路和原子连接校验均不变。每个owner总候选数上界1337，并由sitespec守卫按配置公式校验。

生产回归`2000628374/t1`由central-station未落位改为central-station/east-stadium均落位且带`plot-gate`，该样本旧`siteWithoutDoorRoad`从1降至0。三级版60-seed调优普查（159秒，score仅诊断）：siteWithoutDoorRoad 11/60岛、12项（相对原13岛、15项改善2岛/3项）；unjoinedGroundJunctions维持29岛/66项；siteInWater 1/1、sitesOverlap 1/1、loose ends 13/14、crowded 5/14、disconnected 1/1、bridgehead 3/3、acute 0/60，其他列出项仍为0。耗时159秒，相对原版152秒约+4.6%，而非首次外圈方案的1471秒。

当前源码typecheck、sitespec、30岛planning、10样本road-report及`git diff --check`通过；planning锐角1（门槛2）、roadThroughSite 1、无门路1、拥挤4、断头3；完整图交叉仍在`2000628374/t1`有4处。独立4B、完整跨引擎、全套件、视觉/golden及所有剩余约束闭环仍未完成。

### 外圈延伸至360与独立验收预检（2026-10-10）

为检查失败后追加搜索的有效范围，外圈扩为192/216/240/264/288/312/336/360、每圈24方位；上界随之由1337修正为1457，sitespec公式守卫通过。相较前一版240外圈的2B 60岛结果（unjoined 29/60、66项，siteWithoutDoorRoad 11/60、12项，159秒），当前360外圈复测为unjoined 28/60、62项，siteWithoutDoorRoad仍为11/60、12项，149秒，score 3.437（仅诊断）。因此扩大半径没有改善门路汇总，未接路口计数小幅降低；需要固定候选外的原因分析，不能宣称解决 R2。其余当前2B残留：siteInWater 1/60、sitesOverlap 1/60、loose ends 13/60/14、acute 0/60、crowded 5/60/14、disconnected 1/60/1、bridgehead 3/60/3。

在源码尚未冻结、baseline 未审阅时误运行了 `verify-city-survey.mjs` 的独立集预检；其 t1 在完成60岛后因门槛失败退出：unjoinedGroundJunctions 27/60（门槛0）、siteWithoutDoorRoad 5/60（门槛1）、crowdedArterials 4/60（门槛2）。该结果证明当前构建未达独立验收门槛，不得用于调参、不能称为冻结版最终4B验收；没有据此改生产规则，后续须冻结/审阅后用未暴露的新独立样本完成验收。t3/t5/t10未运行。

360 外圈当前指纹后续复验通过：typecheck、sitespec预算守卫、30岛planning、10+1 road-report、30布局跨引擎（V8/JSC逐字节一致）、完整layout、connect/network-patch/intent/solve/geography合成/样本守卫、City生产build及 `git diff --check`。road-report仍显示固定规划样本 `2000628374/t1` 有4处完整图交叉；显示样本交叉0、door代理11/12、unclassified degree-1 6、vacant narrow-road长度2845.44，均不能等同于真实门口/展示图质量已完成。build有>500KB chunk警告。t3/t5/t10独立验收、全部未完成R0–R5契约、完整仓库套件、人工视觉/golden审阅与合并仍未闭环。

### 必需设施失败后的可选预留原子让位（2026-10-10）

直接把必需站点指派提前至骨架后、令后续可选地标避让，曾将2B站点重叠推至8/60、未接交叉32/77、主干拥挤8/14，虽门路10/10却不接受；该顺序实验已撤销。保留既有设施/道路流水线顺序，只在完整 required-site 搜索失败且存在 `site-spacing` 拒绝后，启动局部交易候选：固定 civic/harbor/已有入口，暂时释放tower/park及landmarks；逐个候选草稿重排普通地标、跨路地标、岸边设施与歌剧院，检查 required owner 至少 `r_owner+r_other+10`、全体占地重叠数不增、全图道路穿地约束不增。每个提案拒绝零副作用并继续下一个，只有站点、入口道路和可选设施搬迁共同通过才提交。合成守卫新增“首个重排方案失败后继续评估后续候选”。

事务候选第一次2B 60岛复测曾报告`siteWithoutDoorRoad` 8/60/9项、`sitesOverlap` 1/60/1、roadThroughSite 0；随后新增具名回归发现成功搬迁patch中的required owner被外层重复push。这批数字受重复站点对象影响，判为**无效、不可用于比较或验收**，已修复并重跑；最终数字见下方后续验证记录。该 bug 也可能扭曲候选收益，故之前的改善结论撤回。

当前版本已通过typecheck、sitespec（包含proposal拒绝后继续搜索）、30岛planning（acute1、roadThroughSite1、siteWithoutDoorRoad0、crowded4、loose3）；60岛调查仍有地面关系/站点/桥头等残留。刚修改后的cross-engine、road-report、build、整套件、四档冻结独立验收尚未复验；R0–R5其余生产合同、视觉/golden与合并仍在未完成台账中。

### 去重修正后的事务让位验证（2026-10-10）

### 后续复验补充：事务让位范围与桥隧范围（2026-10-10；下方旧记录为范围收窄前状态）

候选让位现在仅移动与必需地块间距冲突或被候选接入路穿过的可选对象，避免重排无关地标。当前2B tier1 60-seed复测（153秒，score 3.455仅诊断）：未接地面关系29/60岛、60项；设施无门路8/60岛、9项；道路穿设施0；用地重叠1/60；内陆松散端点13/60岛、14项；锐角0；主干拥挤5/60岛、14项；断连1/60、桥头连续失败3/60；水上设施1/60；其它列出的parcel、门朝向、站距、拱门、广场与高架净距项0。相较紧邻的去重修正版2B（未接28岛/59项、松散端点12岛/13项），两项轻微回退；候选范围收窄没有证明改善整体规划质量。City生产 build、正确目录执行的typecheck、sitespec、30岛planning、30布局V8/JSC跨引擎和10+1 road-report均通过；build有Vite既有 >500KB chunk 警告，`git diff --check`待本次文档落盘后复核。road-report在10个规划样本测得平面交叉逐样本0/0/0/0/0/0/4/1/0/0，总计5；每样本均有1项桥连续诊断，显示图交叉0但未分类度1端点仍有6。此为当前调优线诊断，不是独立验收。

结构能力边界：生产已有显式跨水桥候选、桥头接地/落地处理和独立环线高架布局；但 `RoadEdge.bridge` 与 `highwayRuns` 仍是分离消费域，不是统一多层道路图，layer/structure/纵断面合同未完成。当前未发现生产隧道规划类型。基于残留症状，本轮不把新增短高架或隧道当作默认断路修复：近接节点、未接平面交叉、设施门路失败及桥头不连续优先由既有平面拓扑、候选搜索/容量与桥头接地合同解决。短高架须等地面候选均因硬约束失败且有可复现样本证明绕行质量不可接受后，另立含连接层、纵断面、净空、墩柱占地、坡道及规划/渲染/车流一致性的结构批；隧道只对山体阻隔且地面绕行不可行或代价过高的样本评估，并要求洞口、坡度、埋深/地下包络、水域冲突及车辆路径合同。桥型美术扩充与路网根因修复分开验收。

交叉残留的阶段因果已用固定样本求解日志复核：`2000628374/t1` 最终4项均为 endpoint-near-edge（距离约0.18、0.19、0.19、0.45）；`snapNearEdgeJunctions` 成功3次、拒绝1次，日志原因为“snap introduced a new crossing”及重复出现的“snap junction angle”。`2000733103/t1` 的剩余项为两条 ground arterial 的真正 interior-crossing；接近合并成功3次、短交叉修复1次后，`normalizeGroundJunctions` 拒绝的路口位于`-150.37:1021.06`，其当前详细日志定位为参与边`-140.78:989.73/-151.32:1024.15`的走廊`slope`失败。早期报告只打印泛化的“participant corridor unsafe”；现已改为记录具体物理约束类别和边 ID，且合成用地阻挡测试确认报告`site-clearance`而不改变零副作用拒绝。不能据中心线坡度推断全路幅安全；该样本横向路幅的坡度判据正是被拒原因。故当前是局部拓扑修复的候选生成/冲突解决缺口：拒绝危险路口化是正确安全行为，缺的是转向另一路径或重定线的后续安全提案。不得放宽走廊/角度或将地面边改标桥来清零报告。剩余路口工作应输出受阻原因分层，并为可重路由的道路对生成带完整物理复核的候选；硬约束无解时保留显式未满足，不以新结构类型伪装完成。

规划前后差异进一步界定修复位置：同一 `2000733103/t1` 在 `skipSolve:true`（仍完成正常道路生成，只跳过求解修复）时共有5处关系交叉；标准求解后剩1处。五处涉边均为8/12宽 arterial，不是单一绘制伪影；现有终筛能接纳4处，剩余处被全路幅坡度硬门拒绝。因此剩余优先级不是重复运行路口合并，而是向道路生成/需求连接候选提供交叉预判和替代走廊，特别是骨干/次骨干交汇；同时需要在 plan 阶段记录边的生成意图/来源，否则仅靠最终 `RoadEdge` 无法把失败关系可靠映射回产生它的规划需求。该 provenance 设计及安全 reroute 仍未实施，五处原始数也只是一枚调优回归样本，不代表跨种子覆盖率。

### unsafe crossing 的有限端点保留重布线原型（2026-10-10）

新增 `rerouteUnsafeGroundCrossings` 作为求解器最后一个平面关系策略：仅尝试未桥接、`ground-road`、宽度<12、两点直线且不被车流/街块边界直接引用的支路；移除旧边后用连接器在同一端点间按 direct/node-merge/detour/A* 搜索，正式提交仍经过事务接受器（需求、分量、安全约束不得回退）。A* 格点查询新增既有道路全宽障碍及 source/goal 小范围接驳口，避免路径仅擦过道路端部形成 `endpoint-near-edge`。合成坡地交叉回归可安全绕过垂直道路端部，确认零未接关系且保持原局部路宽；typecheck、connect 回归和30岛 planning通过。

真实固定样本 `2000733103/t1` 仍保留1处交叉：尝试对象的两端均不能用既有走廊合同离开，连接器各阶梯报告 slope，故端点不动的重布线不能解此例；不得放松坡度门。当前同口径2B tier1 60岛调查为未接关系28/60岛、53项（前一 scoped 版本29/60岛、60项），耗时155秒（前版153秒）；无法把计数变化归因于新末端策略，且调优集非独立验收。前8个 road-report 样本的重布线 changes 均为0，其中其余7样本本来也cross=0；第9个`2000733103`changes=0/declined=2。当前统计变化更可能受连接器A*避让既有道路影响，但尚未证实。A*变更后的City生产build和30布局V8/JSC跨引擎逐字节一致均通过；性能单次60岛调查仅由153秒变为155秒，但仍需非调优独立集和视觉/全档验证后才能评估是否全面采纳。独立验收未运行。

追加检查：针对 `2000733103/t1` 的坡地受阻终端新增海岸截短候选，但仅允许未被路径/街块边界引用、非桥且宽度小于12的度1地面支段；新终点必须命中已有合法海岸/水岸端点语义，并完整重验坡度、路幅净距、重复关系及道路包络。不能仅凭“接近海岸”剪短，也不能剪断有交通/设施/街块拓扑职责的边。typecheck、connect、30岛 planning 和10+1 road-report均通过；该轮 road-report 调优十样本的 plan crossings 为 `0/0/0/0/0/0/0/0/0/0`，固定显示图仍为0。相比上一记录的5项交叉，这是新的候选集合结果，但没有逐样本策略归因，且60岛普查仍有53项未接关系（含近接诊断口径）；因此不得宣称整体断路问题已解决。road-report同时仍显示每个规划样本1项桥连续失败、9个未分类度1端点等残留。此策略与更广泛的桥/隧道/高架形态扩充无关：默认先修正生成意图、地面路口化与合法端点合同；只有独立样本证明地面路线受硬约束不可行后，才按隧道或高架的纵断面、净空、接坡、占地和渲染/车流一致性合同单独立项。

`verify-city-planning` 具名样本一度发现 patch 已含 owner、外层又 push 一次的重复对象；已改成按 owner id 唯一提交，network map/version 只在统一提交点更新。修复后的同口径2B 60/t1复测（score 仅诊断，161秒）：`siteWithoutDoorRoad` 8/60岛、9项；`sitesOverlap` 1/60/1；`roadThroughSite` 0；unjoined ground junction 28/60、59项；acute 0/60；loose ends 12/60、13项；crowded 5/60、14项；disconnected 1/60、bridgehead 3/60、3项；siteInWater 1/60，其余列出约束0。与只扩360外圈版的11岛/12项门路相比减少3岛/3项；以原细分13岛/15项相比减少5岛/6项。2B仍有大量路口未接及门路失败，不能据此判定完成。

具名回归 `2005655366`、`2005864824`、`2005969553` 的两项 required owner 均只出现一次，均有 `plot-gate` 且无用地重叠/道路穿地；`2000837832`、`2002199309`仍保留因buildable/dry/必要间距无法满足的显式失败。typecheck、sitespec候选续试、planning 30岛和60岛2B普查通过。去重后一行network version更新的最后微调还需复验；跨引擎、road-report、build及完整套件/四档独立验收尚未复验。此前未冻结4B预检只作为其旧构建失败记录，不据其调参。

### 联合修复续：迁移道路端点与全部关联边（2026-10-12）

在 `192d721a` 的端点保留折线修复上，真实断点仍是实体包络内的路口端点。现允许最多两个非主锚点、非桥接、非已声明岛门节点在同一 NetworkPatch 中迁移；受影响节点的所有关联地面边必须完整重定线，端点/edge lineage/remap 随事务提交。超过节点/边预算、存在保护状态或任何关联边无法通过道路净距、地形、地块与桥面检查则拒绝。未扩大吸附阈值。

原两个失败种子 `1703350391/t2`、`2003037141/t1` 均已从 ground violation 1、规划 failed 恢复为 ground violation 0、无 groundFailures、规划 degraded；剩余 degraded 原因是完整模型覆盖与全局预算/取消尚未实现。`verify-city-joint-site-road.mjs` 加入这两项真实种子回归及综合网络/地面专项断言；typecheck与该专项通过。节点迁移后的 `verify-city-solve.mjs` 终态exit0：28策略、10约束、6岛均未恶化且重复确定。30岛主批、独立四档、跨引擎/场景视觉与完整预算门禁仍未完成；不据具名样本恢复宣称整体完成。

### 联合重定线补充：禁止组合路由制造新地面关系（2026-10-13）

联合站点/道路迁移此前只在每条新路径搜索时避开未迁移道路；同一补丁中的两条迁移路径可能分别通过单边检查、组合后仍产生新的未接地面关系。现增加两层检查：路径搜索对静止地面路提前拒绝近接/交叉；完整候选补丁预览时只对本次共同重定线的道路对复核新关系，避免将全图扫描放入每个候选循环。已有共享图节点的端点接触及既存关系按原口径保留。合成回归覆盖组合候选产生新关系时拒绝，原子事务/线路属性和既有具名失败种子回归继续通过。

当前指纹验证：typecheck、`verify-city-joint-site-road.mjs`、`verify-city-planning.mjs`（30岛，锐角0、道路穿地4、缺门路0、拥挤0、断头0）和 `git diff --check` 通过。但具名 `4001256748/t1` 仍为 `failed`，villa-complex 的 `foundation-gap,foundation-water,foundation-relief` 未修复；本改动是拒绝不安全联合路由，不是该失败的恢复方案。最近一次独立普查仍在 tier1 有超限项，tier3/tier5/tier10 未验证；全局预算/取消、R0–R5余项、完整构建/套件、跨引擎、视觉/golden及合并门禁仍未闭环，不能宣称分支完成或可合并。

同一提交后的独立验收复跑（`node scripts/verify-city-survey.mjs`）在tier1仍失败，指标与此前相同：缺门路2/60（上限1，`4001047290`,`4004503347`）、道路穿地5/60（要求0，例`4001256748`,`4001989851`）、用地重叠2/60（上限1，`4003037141`,`4003456057`）；因首档失败，t3/t5/t10及调优集未执行。具名 `4004503347/t1` 仍未落位体育场，拒绝主因是`site-spacing(+10)`；所试移动 park 的联合候选仍在最终站点间距复核被拒，局部候选过滤实验未改变结果，已撤回，不能当作修复。当前 `verify-city-required-placement.mjs` 的旧具名种子 `2003037141/t1` 在“所有约束零违例”断言处报告1处锐角（`254.98:-110.12`）。现已定位为两条被街块边界引用的主/支路与一条短 local 路的锐角三岔；`resolveAcuteJunctions` 尝试删边后被事务以“referenced road removed without a replacement path”拒绝，而局部弯线候选要求边长≥40（该 local 边长32.74），因此尚无安全替代方案。当前代码确实未通过该回归；尚未对 `6b72d429` 做前后对照，故不把它归因于 `011aecc8`。
