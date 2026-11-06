# 棋盘标记层级优化与验收 — 2026-11-02

## 范围与设计决策

本轮为既有 UI 的局部 Extension，承接上一轮图例精简，不重做 HUD、地形、模型、相机或战斗规则。沿用原有绿色移动、红色当前敌意、蓝色草稿预测、浅黄推挤与浅色箭头描边。保留字号、面板、头像、回合标题及远程权限边界。

观察依据是上一轮真实 synthetic 开局截图，以及此前已分析的用户 PDF 第 6–9 页和 ModLoader 展示生命周期；本轮没有重新克隆、运行参考仓库代码或复制游戏素材。

| 部分 | 修改前 | 本轮调整 |
| --- | --- | --- |
| 合法移动范围 | 绿色格面叠加每格四个三角，方向符号铺满区域 | 单个矩形透明铺色，去掉四向三角；只在真实查看移动路线时绘制逐格箭头 |
| 地形与移动范围 | reach 会参与地形 pad 角色选择，且建筑角色优先 | reach 是独立 InstancedMesh 层，地面/道路/建筑 pad 不再为移动范围换材质 |
| 敌方攻击来源 | 和受击格使用同一完整红色方框 | 四个红色开放角框，包围实际 1×1 / 2×2 攻击单位；图例来源符号同步为角框 |
| 受击格 | 完整红框较粗，并叠加预测内框 | 保留全部红色实框、透明底和斜纹，适当收细外框；当前风险仍为主层 |
| 蓝色预测 | 较粗虚线放在格面中央，与斜纹抢注意力 | 较细虚线靠近格缘；红蓝重叠时蓝色降至 .58，未删除任何预测格 |
| 攻击路线 | 默认路线仅裁剪起点，选中路线从模型中心到受击格中心 | 两种攻击路线共用 board-local footprint/landing insets；尾部从脚边起，头部停在目标格内，少穿过模型和斜纹 |
| 空地警告 | 威胁较少时，空格也叠加 screen-facing `!` | 空地使用地面危险图案；单位/建筑/障碍格保留不测深警告，作为模型遮挡补充 |

### 受保护行为

- 不改变 `reach`、`targets`、当前声明、预测、攻击落点、路径查找或战斗结算。危险格依旧压过绿色移动铺色，但合法集合不被删改。
- 当前红色攻击依旧独立于草稿预测；预测为 `null` 或 `[]` 都不会消除红色声明。
- 选中敌人的来源/落点被强化，其他敌人的来源和危险格仍保留。
- 攻击按真实起点与落点的同一条射线裁剪，仅改变绘制长度；面积攻击不造折线路径，默认总览仍为最多三条真实边界/中央射线。
- 机甲逐格移动路线不执行攻击 insets，路线段保持真实端点和原长度。
- 预览落点菱形、合法目标角框、选中格框与已验证推挤仍按原交互快照绘制。
- 保留透明绘制队列、`fog:false`、`toneMapped:false`、浅色描边和屏幕宽度下限，防止箭头变黑的旧问题复发。
- 不新增生产全局测试钩子。专项浏览器探针只通过独立 headless 页面的 Vite route interception 注入。

## 实现文件

- `apps/agent-city/ui/src/game/CityMechaWorld.tsx`：范围矩形、来源角框、层级、警告触发条件、路线裁剪及资源释放。
- `apps/agent-city/ui/src/render/mecha/tacticalMarkers.ts`：纯展示函数 `tacticalAttackTrims`，支持矩形棋格、对角方向、多格来源、邻接短路线及非法/溢出输入退化。
- `apps/agent-city/ui/src/game/MechaBattleLegend.tsx`：来源 SVG 改为开放角框；仍使用同一上下文图例。
- `apps/agent-city/ui/tests/mecha-tactical-markers.test.ts`：新增四项路线裁剪回归，保留透明队列与宽度测试。
- `scripts/verify-city-mecha-board-browser.mjs`：实际棋盘/相机/选中敌人/移动规划/模型拾取与独立展示层专项。
- `scripts/verify-city-mecha-enemy-intent-browser.mjs`：在原 11 个资源释放断言上增加来源角框 geometry，第 12 个资源。

## 验收

全部浏览器使用独立 headless Chromium / Metal 和 `?fixtureSessions=30`，不操作用户的浏览器页面、不访问真人对局或本地分析数据。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run verify:mecha-clarity` | 63/63；包含新增四项裁剪测试 |
| `npm run verify:mecha` | 274/274；规则/控制器/路径/远程契约等既有回归 |
| `node scripts/verify-city-mecha-ux.mjs` | PASS；原输入、HUD、图例与红色声明检查保留 |
| `npm run build` | PASS；保留既有 >500kB chunk 提示 |
| 棋盘专项 | 中英 × 1768×748 / 1100×700 / 640×480，6 个真实 synthetic 开局视口；另有 2 个中英选择/移动/展示层组合案例，全通过 |
| 棋盘覆盖断言 | green geometry 恰好 6 顶点、无内向三角顶点；实例数等于非危险合法移动格数；全部危险格的实框/底保留；全部预测格保留；来源角框 48 顶点；棋盘拟合点未出屏 |
| 实际交互 | 真实敌人选择保留其他危险；真实列表移动后，通过真实画布模型拾取查看逐格路线；移动段长度未被攻击裁剪逻辑改变 |
| 展示层 fixture | 只移除 reach 不改变地形 pad 材质；30 个无模型的危险/预测空格不生成重复浮动警告，危险层覆盖全部格；fixture 不代表规则有效攻击 |
| 资源释放 | 新棋盘测试 5 个相关资源；敌意专项 12 个原有/新增资源，均收到 dispose |
| 敌意专项 | 中英 2/2；当前声明归属、风险覆盖、预测 null/empty、选中其他敌意保留、GPU 颜色及旧黑箭头故障复现 |
| 战术箭头专项 | 中英 2/2；每种箭头两种 exposure 的 GPU 颜色、浅色描边和旧队列错误复现 |
| 图例专项 | 14/14；6 个真实 synthetic 视口 + 8 个明确展示 fixture |
| 格子检查专项 | 640×480 中英子集 2/2；实际 terrain / unit / enemy / route / touch target 拾取和状态保持 |
| Reference HUD | 640×480 中英子集；0 app assertion / 0 inconclusive / 0 harness failure，确认/取消/移动/预测恢复等原检查保留 |
| `git diff --check` | PASS |

### 截图与日志

完整证据目录：`artifacts/mecha-clarity-p0/board-refinement/`。

- `board/actual-1768x748-zh.png`：本轮真实 synthetic 棋盘，图例展开。
- `board/selected-enemy-1768x748-zh.png`：查看敌人，当前攻击被强化，其他危险继续显示。
- `board/planned-movement-1768x748-zh.png`：真实列表规划移动 + 模型拾取后，显示未执行的逐格路线。
- `board/field-640x480-zh.png`：小窗口查看战场，棋盘全部拟合在视口内。
- `board/display-fixture-empty-danger-1768x748-zh.png`：明确展示 fixture，检查危险层与浮动警告去重，非规则合法对局证明。
- `board-before-after.png`：同 seed、同 1768×748 视角的棋盘局部并排。Before 来自上一轮 `legend-refinement/final-browser/actual-zh-1768x748.png`，不是本轮重新运行旧版本；After 来自本轮 actual 截图。背景漂浮物/模型动画相位可能不同。
- `board/results.json`、`enemy-intent/results.json`、`legend/results.json` 等为浏览器输出；各项命令日志保存在 `logs/`。

人工查看了中文大视口默认棋盘、选中敌人、移动路线，以及 640×480 默认 HUD / 查看战场截图。绿色范围不再出现散落方向符号，移动路径与范围可区分，红色来源角框和受击格实框/斜纹可区分。

## 限制与 Git 状态

- 本次未重建城市棋盘或使建筑透明化，建筑仍可能遮挡少量地面斜纹；不测深外框和 screen-facing 警告作为补充，并不等于所有角度完全无遮挡。
- 小窗口的棋盘拟合与原交互子集已验收，不代表全部小屏 HUD、390px 设备、原生 Tauri、物理触摸、完整无障碍或真人 PvP 验收通过。
- 推挤覆盖沿用现有测试；本轮空地/铺色 override 只证明渲染层，不证明战斗规则。
- 改动保留于独立 worktree 的 `feature/mecha`，不修改 `/Users/Admin/projects/project/skill-vitals` 主 checkout。
- 原待提交合并现场保留：`MERGE_HEAD=50af65e4dd6432cbe017a2d8d62ef7a2e430b503`，未暂存、提交或推送。无 unmerged index entries 不代表 merge 已提交。
- 操作前后 cached diff SHA256 均为 `d5a4b77b9d1d18d0efe2bfe14942e968640685313d91904bf8912cea3a389ed3`。

## 2026-11-03 补充：危险格与可达范围叠加

上文“危险格隐藏绿色移动范围”的处理已被本节取代：在保留红色声明攻击框和斜纹的同时，对合法移动范围内的危险格绘制一对浅绿色实心菱形及深色描边；不更改移动合法性、目标选择或战斗规则。普通合法格仍是绿色底色，黄色空心菱形仍表示尚未执行的计划落点。图例在出现交集时说明“双菱形：可移动但有危险”，英文和部署区描述同步调整；预测未知不代表安全。

- `npm run verify:mecha-clarity`：83/83；`npm run verify:mecha`：373/373；`npm run typecheck` / `npm run build`：PASS（保留大 chunk 提示）。
- 独立 Chromium 浏览器棋盘测试：中英文实际 synthetic 开局及 1768×748、1100×700、640×480 视口通过；另以明确标注的展示 fixture 检查红色危险、蓝色预测、目标框和可达标记重叠，逐实例核对对应格子；同格在危险可达、普通可达、仅危险、无标记间切换，检查残留；11 项资源 dispose 已触发。
- 图例专项：中英文实际 synthetic 视口和包括危险可达的 5 类展示 fixture 通过；截图目录 `/tmp/mecha-overlap-final-20261103/` 与 `/tmp/mecha-overlap-legend-20261103/` 为临时本机证据，不保证长期保留。
- 已人工查看中等和小视口展示 fixture：小屏标记和棋盘仍较小，建筑或单位也可能遮挡地面，不宣称所有缩放、颜色视觉能力或完整小屏 HUD 均已验收。展示 fixture 不构成规则有效性或真人 PvP 验收。

### 回放控制面板底部定位

面板固定于战场容器底部并保留安全区间距；在空间不足时换行、必要时允许垂直滚动。通过独立 Chromium 检查中英文的本局回放及已保存历史回放，在 1100×700、640×480、390×844 中默认收起和展开记录的面板位置、导航和退出控件；截图 `/tmp/mecha-replay-bottom-current-zh-1100.png`。测试为了加速结算暂停了场景绘制，只验证面板布局及回放控制状态，不作为实时棋盘画面或原生 Tauri 的视觉验收。
