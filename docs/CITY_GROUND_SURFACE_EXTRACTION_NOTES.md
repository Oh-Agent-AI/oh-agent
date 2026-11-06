# A1：普通路面共享几何提取

日期：2026-10-15；实施位于当前main工作树。本轮是A批次的第一部分，不代表A批次或真实城市验路已完成。

## 已完成

- `engine/surface/terrainSampling.ts`：从terrainSystem提取相同的192格地形顶点缓存与三角插值；旧出口保留。
- `engine/surface/groundRoadCompiler.ts`：从roadSurfaceSystem提取普通路段带、路口圆角/中心填充/换宽渐变、人行道的原有几何计算，不依赖THREE、DOM、host或CityLayout运行时。
- `compileGroundRoadSurface(layout)`：输出原有5层attribute/index数组与逐片段来源/range。道路片段携带组成edgeIds及两端node，路口填充携带junction身份；每个实际渲染三角形恰有一个片段owner。5层是绘制分组，绝不是5个高度层。
- `groundPieceTriangles(compiled,piece)`：按同一索引抽取Float32顶点、局部Uint32索引，精度与GPU提交相同；拒绝外来piece对象。
- 渲染仍在原roadSurfaceSystem中创建mesh/material/shader，改为消费纯编译器；保留原函数、常量和类型的导出。调用方可显式传入同一份compilation复用，输入引用/extent不匹配时拒绝，不默认建立全城缓存。
- `roadPaintPlan`只增加组成edgeIds元数据，不改变遍历顺序、宽度或原有中心线。

编译结果标记 `readiness=geometry-only`，显式列出未解决的boundary union/portals、渠化岛/路缘、桥/高架和尽端铺面；没有构造虚假的SurfacePortal、可驾驶边界或审计passed。

## 验证与基线来源

`fixtures/city-driving/ground-surface-baseline.json`首次记录自**重构前**744f926a的roadSurfaceSystem独立bundle，之后再与新编译器比较；未使用新实现自产期望值，没有修改既有golden。摘要覆盖全部position/normal/color/UV/标线属性与indices（Float32属性、Uint32索引）。

- 九个专项：空路网、直路、折弯、T口、斜交、换宽、桥头截断、闭环、起伏地形T口。
- 十五个规划布局：seed 1/7/42/2026/65537 × planning tier 1/2/3，比较旧/新渲染缓冲，并检查所有三角形的来源range和CPU/GPU精度一致。
- 这十五个是规划层几何夹具，不是0/90/500会话的最终显示剪枝布局，不能当作完整产品验收矩阵。
- 纯模块依赖守卫禁止引入THREE、engine/systems、host、data及cityPlan/cityLayout运行时模块。
- 既有road-paint守卫覆盖朝向、贴地、路缘、标线参数与规划城市；terrain-height守卫覆盖13005个原高度样本。

命令：

```sh
node scripts/verify-city-ground-surface.mjs
node scripts/verify-city-ground-surface.mjs --cities
node scripts/verify-react-city-road-paint.mjs
node scripts/verify-city-terrain-height.mjs
node scripts/verify-city-driving-architecture.mjs
npm --prefix apps/agent-city/ui run typecheck
npm --prefix apps/agent-city/ui run build
```

现有构建的大chunk提示保留。没有Rust变动、没有自动格式化，也未开启真实城市驾驶或新增数据面。

## 接续工作

1. 从同源几何构造边界union、孔洞/渠化岛排除与真实连接portal；绘制层不能充当layerId。
2. 提取桥梁、高架实际BOX矩阵顶面；路缘/护栏/桥墩独立静态障碍；尽端铺面也要纳入。
3. SurfaceStore负责immutable buffer所有权、内容身份及与显示layout revision的关联，再把编译结果稳定提供给驾驶snapshot。当前原始数组仍为兼容renderer的可变数组，禁止消费者原地改写；输入引用检查不能代替内容hash，也不检测原地修改terrain/roads。
4. 加入最终显示剪枝/修复后的0/90/500会话矩阵、预算与性能证据，再接世界查询和自动试跑。当前不能据此判定任何真实道路已通畅。

## A5修订（2026-10-15）

坡地路面贴地与折点折叠已修复，见 [A5贴地记录](CITY_GROUND_SURFACE_TERRAIN_FIT_NOTES.md)。上文的「重构前基线」仍保留在 `fixtures` / `generatedPlans`，七个平地夹具继续与之逐字节一致；closed-loop、wavy-tee与十五城改为对照 `corrected` 段，附原因说明。接续工作第1、2项中的「边界union」和「路缘语义」已由 surfaceRegions 承担；桥/高架、渠化岛、尽端铺面、portal仍待做。
