# A3：地表点查询索引

日期：2026-10-15。基于 [A2 SurfaceStore](CITY_SURFACE_STORE_NOTES.md) 的几何快照，增加 CPU-only XZ 三角候选索引。此层用于后续独立验证器与道路审计，不会改变当前城市运行时。

## 接口与行为

- `engine/surface/SurfaceIndex.ts` 的 `buildSurfaceIndex(snapshot, budget)` 先复制每个patch的Float32顶点和Uint32索引，再建立以 `cellSize` 分格的三角AABB索引。复制后，原快照缓冲变化不会污染索引。
- `query({x,z,layerId})` 必须指定高度层。默认仅查询车行道、路口和结构顶面，排除人行道、岛屿和装饰；也可显式传入kind集合。结果为 `hit`、`miss`、`ambiguous`、`budget` 或 `invalid-input`；不同patch在同一投影点重叠时返回全部稳定排序的候选，不选“最高/最近”的面。
- 同一patch的共边命中以patch ID、triangle ID稳定排序；命中三角按重心坐标插值得到高度，并从几何叉积计算法线。
- 默认限制：100万三角、100万桶、400万桶项、单三角最多256格、单次查询最多512候选。超界时构建返回具体unresolved原因，查询超过候选限制返回budget。
- 当前索引接受向上的非退化三角面。它不会自动连接相交面，也不检查boundary loop、portal、车体覆盖或障碍净空。

## 使用边界

这个模块只回答“给定层上的这个点，哪些候选三角覆盖它”。它不回答道路是否可开、不验证相邻三角间的连续行驶，也不把同高的跨patch重叠当成无歧义。所有输出都带surface revision，消费者必须丢弃与当前快照版本不一致的结果。

尚未接入SurfaceStore/CityEngine；正式驾驶仍受A2的`geometricallyEligibleLength=0`和无portal约束。后续要增加连续轨迹支持、坡度/台阶、整车投影覆盖与禁区相交检测，并与union后的边界和连接图共享同一revision。

## A4修订（2026-10-15）

- 入桶改为三角形与格子的闭区间2D SAT精确覆盖；`maxCellsPerTriangle` 按真实触及格数计，另设 `maxScanCellsPerTriangle`（默认65536）限制单三角扫描成本。原先按AABB计格，seed 42 tier 2 一条斜向长平路超出256格，整城索引构建失败。
- 修正命中法线：A3草稿的叉积分量错位，平路返回水平法线 (0,0,±1)，现在为 (b−a)×(c−a)，y分量与构建时的朝上检查一致。
- 新增 `trianglesInBox`（宽相引用，有结果上限）、`triangle`（捕获后的坐标）、`patches`（元数据），供区域合并使用。点查询语义不变：跨patch重叠仍返回ambiguous，消解只在 [surfaceRegions](CITY_SURFACE_REGIONS_NOTES.md) 中按显式规则进行。
