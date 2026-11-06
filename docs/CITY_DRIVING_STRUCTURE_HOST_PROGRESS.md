# 驾驶任务1/2：结构闭合与宿主冻结实施记录

日期：2026-10-16。任务范围来自“结构路面闭合”和“宿主接入与版本冻结”。本记录列出当前增量与仍需完成的工作，不把独立几何诊断当成道路开放认证。

## 已有基线

`77828bf` 已包含 A6/A7：地面、桥、高架、渠化口和尽端圆盘聚合；桥面按落地引道倾斜；CityParts保留实际静态城的layout/ground编译，CityEngine在模型/seed/修复补丁重建及dispose时使快照失效。跨层portal、完整碰撞和驾驶运行时仍未完成。

## 本轮增量

1. `compileSurface.ts` 将桥板/高架板的真实八角点实体加入obstacles，并通过surfacePatchId关联其支撑顶面；现有桥墩、护栏、桁架、岛障碍继续保留。几何版本提升为3。这样下层净空检查能够看到板底，未来CollisionIndex也能消费实际实体。
2. `citySurfacePort.ts` 取消直接暴露可变compilation的入口。`readWorld()`按当前宿主generation读取surface、obstacles、landings、counts的防御性副本；typed arrays修改不会污染存储。所有元数据在第一个await之前复制。
3. `worldRevision`同时覆盖已发布的surfaceRevision、实体几何、接缝诊断、计数与覆盖声明。仍明确标记`obstacleCoverage: structures-only`：建筑、地标及合法图未纳入，**不可用作完整AuditKey.baseSnapshotHash**。
4. 同一源的并发capture复用同一次编译与两个hash；单个调用者取消不会取消其他调用者。源替换、unavailable、invalidate均使旧read/readWorld/checkStructures失效；即使重建内容相同，旧handle也不会复活。
5. `structureChecks.ts` 计算桥/高架顶面的最大几何坡度；用板实体的朝下表面与其他高度层的道路三角面做完整投影相交，在相交多边形顶点处求板底与道路平面的最小间距。斜板的朝下侧面也包括在内；高于板体的道路被排除，穿进板体的道路保留负间距见证。
6. `capture.checkStructures({requiredClearance,maxSlopeRadians})` 是实际端口上的只读消费方，报告绑定worldRevision；参数由车辆/审计策略提供，不在此处认证阈值。预算或非法输入返回unresolved。源ground与layout不匹配时编译直接拒绝。
7. `capture.querySurface()`按需建立索引并绑定同一worldRevision；源失效后返回stale，同时释放端口持有的旧索引缓存。它保留跨patch歧义和高度层显式选择规则。0/90/500合成会话×5种子的修复矩阵覆盖接受的长路改宽、删路、恢复，以及旧读取句柄失效。
8. `landingSeams.ts` 与 `capture.checkLandings()` 检查实际桥板/高架顶面端边的整个横截面。landings现带patchId及Float32实际端边两端点，均参与worldRevision。检查器将所有地面三角与端边的交点排序，逐区间证明地面覆盖、排除岛、比较重叠面高差，并检查端点最大台阶和三角面坡变；返回连续宽度区间。它不创建portal，也不证明接缝前后的二维进出走廊。
9. 横截面切分使用Float32坐标的精确dyadic整数和有理数比较，避免共享边产生虚假微小区间；没有吸附点或填缝epsilon。高度比较保留既有1e-6数值余量。若真实区间不能用返回格式区分则报告precision/unresolved；预算耗尽同样不给完整结论。

## 端口使用

```ts
const capture = await engine.captureDrivingSurface(signal);
if (capture.status === "ready") {
  const world = capture.readWorld();
  const query = capture.querySurface({x: pose.x, z: pose.z, layerId: support.layerId});
  const diagnostics = capture.checkStructures({
    requiredClearance: vehicle.height + policy.headroomMargin,
    maxSlopeRadians: policy.maxSlopeRadians,
  });
  const seams = capture.checkLandings({
    maxStep: policy.maxSeamStep,
    maxSlopeChange: policy.maxSlopeChange,
    aliasTolerance: policy.aliasTolerance,
  });
  // 异步分析/试跑每次yield之后、提交结果之前都必须重新检查。
  if (!capture.isCurrent()) return;
  // diagnostics.complete仅表示检查做完，仍须检查lowClearances/slopes。
}
```

## 验证范围

- 端口守卫：输入/读取所有权、障碍内容身份、稳定排序、同源并发、调用者取消、源切换、unavailable、错配源、第二次hash期间失效。
- 净空守卫：平板、斜板最低点、20组复合旋转、穿板负间距、板上道路排除、层分离、非法输入、预算。`--cities`将诊断扩展到15个规划布局；每个低净空保留数值和几何位置，不把它当作驾驶全路段阻塞结论。
- 现有结构渲染/同核试跑、地表存储、架构守卫和TypeScript检查继续适用。
- 接缝新增合成负例：偏离中心的5厘米缺口、1厘米岛、中心等高但边缘抬高、坡变、异层叠置、非法端边、未解决网格、预算；20组旋转共享Float32端边验证精确切分。十五个规划布局70个结构端边均完成检查，26个全宽连续；其余保留区间证据。26个不是道路开放数量，也不代表整车可进出。
- 浏览器宿主集成：用90个合成会话创建实际CityEngine/CityParts并执行WebGL绘制；将当前道路mesh的Float32位置和索引逐项对照冻结快照，在初始和修复后均一致。验证实际静态缓存复用、合法道路修复、hash在途换seed、销毁，以及旧read/query/checkLandings失效。该测试使用headless调度模式而非实时rAF，不是原生WebView或性能验收。

本轮实跑：15个规划布局的结构渲染摘要保持原基线；净空诊断完成15布局、512组板体/道路片段投影重叠，其中77组低于测试中显式给定的1.5单位阈值。这里的“组”不是道路数量或封路结论。修复矩阵15显示布局/30次合法路面修改全部通过。UI typecheck/build、端口/存储/架构守卫通过；生产构建仍有已有的大chunk提示。没有刷新golden，也没有原生bundle验收。

```sh
node scripts/verify-city-surface-port.mjs
node scripts/verify-city-landing-seams.mjs --cities
node scripts/verify-city-surface-host-browser.mjs http://127.0.0.1:5179
node scripts/verify-city-structure-checks.mjs --cities
node scripts/verify-city-surface-patches.mjs --matrix
node scripts/verify-city-structure-surface.mjs --cities
node scripts/verify-city-surface-store.mjs
node scripts/verify-city-driving-architecture.mjs
npm --prefix apps/agent-city/ui run typecheck
npm --prefix apps/agent-city/ui run build
```

## 任务尚未完成的部分

- 显式跨层portal、匝道末端台阶、接缝前后二维走廊连续性。全宽横截面和坡变已有独立检查，landings的旧中心诊断仍保留作对照；无法连接的入口保持关闭。
- 低净空报告目前覆盖桥板/高架板对异层道路；桥墩/护栏等实体已冻结，完整车辆碰撞仍由后续CollisionIndex实现。
- 建筑/地标障碍、当前显示高度冻结和合法道路图还未纳入完整审计世界身份。
- 修复矩阵目前覆盖改宽与删路；新增桥/高架、移楼、跨档重定位、实时rAF/原生WebView生命周期及原生性能/内存验证仍需补齐。
- GameRuntime/CarAdapter尚无正式城市驾驶消费方。需要将索引、区域和驾驶环境绑定同一handle，在重建时一并丢弃。

这些缺口仍属于原任务1/2及其依赖，不能以现有守卫通过为完成依据。

## 入口 portal 与精确切分增量

`landingPortals.ts` 新增显式入口候选构建：只连接实际相向边界，全宽横截面通过后再检查重叠走廊的两个高度层覆盖、内部边界、最大高差及坡变。共享边判断与走廊内部边界相交使用精确 binary64 dyadic 谓词；真实缺口不会因距离容差被自动连接。预算耗尽不发布部分连接，重复传入已生成的 landing portal 被拒绝。

`verify-city-landing-portals.mjs` 已验证共享边、重叠入口、偏离横截面的内部岛、微小真实缺口、入口过窄、走廊内部坡变、预算和重复发布。类型检查通过。回归还补齐了 seam 必须来自实际边界及顶面顶点的校验，并使局部 boundary-unresolved 正确传播到整体报告。

复核后已补齐 `landingSeams.ts` 的精确 dyadic 整数半平面裁剪和有理数排序/覆盖判定；高度插值仍使用数值计算。检测版本升为2。二十组旋转共享 Float32 边及可表示的微小真缺口通过，十五布局重新实跑全部 complete，仍为26/70全宽横截面连续。无法在数值输出格式表示的精确区间返回 precision/unresolved，不做填缝。

编译器已接入入口构建，几何版本升为4。发现实际渲染边界为顺时针后补齐双绕序处理与共线边界链检查；合成跨线桥两端均产生显式 portal，Store 接受其边界跨度，桥下路保持独立高度层。关闭或未解决的跨层入口仍记录 unsupported。portal 目前仍未被 SurfaceRegions/驾驶运行时消费，不能据此宣称已可跨层驾驶。浏览器旧守卫重新通过真实 WebGL 绘制、道路mesh/快照缓冲一致、修复和旧句柄失效；未修改渲染几何或刷新golden。

新增验证：

```sh
node scripts/verify-city-landing-portals.mjs
```

## 并行开发整合

- 结构碰撞模块及同版本绑定见 [CollisionIndex说明](CITY_DRIVING_COLLISION_INDEX_NOTES.md)。查询已接入 SurfaceDrivingEnvironment 的出生/移动和 SurfaceWorldValidator 独立复核；覆盖仍为结构盒体/岛棱柱，不包含建筑网格，不实现滑动或恢复。
- 固定步长汽车生命周期及真实宿主租约桥接见 [运行时说明](CITY_CAR_RUNTIME_NOTES.md)。工厂遇到已捕获的建筑网格而缺少对应碰撞实现时明确拒绝启动并释放租约，不把结构测试当作整城已开放。
- 独立入口审查发现并修正了三角索引顺序依赖：接缝坡变现在使用实际接缝边的唯一邻接三角面法线。新增远端平面/入口45度坡变的两种索引顺序负例，均保持关闭。共享边 portal 仅证明接缝几何连续，仍需独立二维驶入走廊和整车通行验证；重叠入口则额外检查整个重叠带。
