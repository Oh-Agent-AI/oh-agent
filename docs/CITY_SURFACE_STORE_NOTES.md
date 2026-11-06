# A2：逐片段边界与SurfaceStore

日期：2026-10-15。继 [A1普通路面提取](CITY_GROUND_SURFACE_EXTRACTION_NOTES.md) 的下一步。本轮不完成跨片段union、岛裁剪、桥坡portal或城市开放认证。

## 代码入口

- `engine/surface/meshBoundaries.ts`：针对单个Float32三角网格，精确XYZ焊接、共享边抵消、闭合外环/孔洞提取；三角朝向、退化、重复面、非流形、边界交叉与预算检查。相近顶点不自动合并，跨片段不自动焊接。
- `engine/surface/buildGroundSnapshot.ts`：把A1结果转成独立SurfacePatch和渲染几何buffers；每个patch携带来源及边界诊断。人行道仍是sidewalk。返回空portals、全部closed边界、eligibleLength=0，原A1未解决项继续列出。
- `engine/surface/SurfaceStore.ts`：捕获/校验/复制快照、SHA256内容身份、按预期revision读取、单当前版本所有权、异步过期结果丢弃和clear失效。
- `engine/surface/surfaceDigest.ts`：本地Web Crypto SHA256；没有网络请求或弱哈希fallback。Node/测试可注入本地hash函数；缺少Web Crypto则明确失败。
- `scripts/verify-city-surface-store.mjs`：负例与存储身份测试；`--cities`扩展为十五个规划布局。

## 约束

1. 单片段闭环不代表全城边界union，更不代表整车能通过。所有返回边界暂为closed，不能凭“边界complete”自行生成validated portal。
2. 同XZ但不同Y不会焊接。mesh的hole为该片段环的投影朝向分类；本轮只接受朝上的、投影无边界交叉的单片段网格，不作为通用任意3D网格拓扑库。
3. 三角/边界数量和交叉测试次数有限；退化、非流形、自交或预算超限返回unresolved且不给部分可信环。极小数值几何仍需后续鲁棒union模块处理，不能把预算失败视作道路已阻塞。
4. Store在await hash之前复制数组与元数据；publish后修改输入或read返回的数组不会更改内部快照。read必须带expectedRevision，旧句柄返回null。更新请求或clear使迟到hash结果stale，不能覆盖新版本。
5. 内容编码有长度前缀与显式little-endian，patch/portal按ID排序；几何、层、来源、边界、portal及诊断变化参与身份；调用方自填revision与材质名不参与。它不是语义等价网格归一化器：同一几何的不同三角划分可以保守地产生不同revision。
6. 默认buffer总量与规范编码payload分别受32MiB上限约束。publication返回bufferBytes/encodedBytes；这不是进程RSS峰值限制，复制、hash编码和read会产生临时额外内存。实际宿主性能/峰值预算仍待验证。
7. **Store revision只代表路面几何快照，不是完整AuditKey.baseSnapshotHash。** 后者必须合并建筑/路缘/桥墩等障碍、合法路网连接及冻结显示状态的身份；不能只用seed或本revision替代。
8. 当前Store由纯测试调用，尚未安装到CityParts静态缓存或CityEngine lease；不会改变现有真实城市行为。后续宿主接入需处理静态cache/显示剪枝/补丁/数据更新，与renderer同版本读取。

## 验证

已覆盖：正方形外环、带孔方环、非索引重复顶点焊接、重复/退化/反向三角、非法索引/NaN、重叠边界、三类预算；内容身份变化、patch排列稳定、材质名变化不失效、输入/读取副本不污染、hash等待期间输入变更、并发发布乱序、clear期间hash、旧revision、非法portal span及本地Web Crypto/Node SHA256一致。

十五个规划布局（seed 1/7/42/2026/65537 × tier 1/2/3）均可构建并发布快照。测试观察到每布局1–7个片段的边界未解决，均保留原因/来源，未提高eligibleLength或生成portal。seed 1/tier 1的4个片段已定位为non-manifold。它们是待诊断几何，不直接判道路阻塞。编码payload约1.2–4.7MB；不是运行时峰值内存或CPU性能验收。

这些是规划布局，仍不代替最终0/90/500会话显示/修复布局矩阵。A1九组旧渲染buffer基线、road-paint、architecture守卫、UI typecheck/build继续保留。

```sh
node scripts/verify-city-surface-store.mjs
node scripts/verify-city-surface-store.mjs --cities
node scripts/verify-city-ground-surface.mjs
node scripts/verify-react-city-road-paint.mjs
node scripts/verify-city-driving-architecture.mjs
npm --prefix apps/agent-city/ui run typecheck
npm --prefix apps/agent-city/ui run build
```

## 下一步

先定位现有片段的unresolved原因；再实现按同层实际几何的片段union、渠化岛/禁区裁剪、显式portal；补桥/高架矩阵顶面与固体障碍。只有完整footprint查询、独立静态审计和同核试跑均通过后，才能产生正式开放图。
