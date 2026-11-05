# Mecha 十种怪物形态：视觉迭代记录（2026-11-04）

本记录是工程侧对本地截图的审阅，不代表用户、美术或目标设备验收。截图使用合成数据，没有联网；视觉内容不决定棋盘占位或技能规则。旧 Boss 图只用于检查兼容回退，并非新物种的造型目标。

## 六组截图、五轮调整

- `artifacts/mecha-monster-preview/iterations/01/`：基线，包括孔洞行者的 Φ-04 风格参数曲面点云原型。
- `iterations/02/`：为十个物种分别增加不同的能量轨迹/空间骨架。总览中线条偏细，仍缺乏复杂度。
- `iterations/03/`：增加每个物种独立形态的有界参数点云，调整中心体透明度和轨道粗细。孔洞行者点云仍被中心壳干扰；小尺寸总览中点云不够明显。
- `iterations/04/`：增强近景点云、收缩光核并降低孔洞行者外壳遮挡；在真实透视战场中再按相机距离衰减点云/光子大小和亮度，修复低分辨率画面过曝。保留覆盖可见轮廓的可点击代理；最终逐种图片、`_grid.png` 和成对审阅图 `_review-1.png` 至 `_review-5.png` 已重新生成。

- `iterations/05/`：参考用户提供的 Superformula × Gyroid 参数点云，为孔洞行者增加青蓝／琥珀分层，并重新生成十种近景与总览；`iterations/05/world-after/porous_shaper.png` 是合成战场中的复核图。近景的点仍较细、总览中轮廓偏弱，需继续调校并等待用户审阅。

- `iterations/06/`：只提高孔洞行者正交近景的点大小，维持青蓝／琥珀分层；透视战场大小和亮度没有变化。`portraits/_grid_new.png` 仅列十种新怪，不包含旧 Boss；其单图及 `world/` 截图均已生成。工程测试覆盖近景可读性和合成战场亮度，尚不等于用户、美术或目标硬件验收。

每个目录包含十张单物种 PNG 和总览。`artifacts/mecha-monster-preview/world-04/` 是真实 `CityMechaWorld`、本地合成棋盘及透视相机下的逐种截图，不是完整城市演练或实际设备画面。

## 单体截图索引

下列图片均为第六组近景；战场图使用合成棋盘与透视相机，并不代表真实设备验收。

| 等级 | 物种 | 近景 | 合成战场 |
| --- | --- | --- | --- |
| L1 | 孢群体 | [近景](../artifacts/mecha-monster-preview/iterations/06/portraits/spore_leaper.png) | [战场](../artifacts/mecha-monster-preview/iterations/06/world/spore_leaper.png) |
| L2 | 流环体 | [近景](../artifacts/mecha-monster-preview/iterations/06/portraits/flux_lancer.png) | [战场](../artifacts/mecha-monster-preview/iterations/06/world/flux_lancer.png) |
| L3 | 孔洞行者 | [近景](../artifacts/mecha-monster-preview/iterations/06/portraits/porous_shaper.png) | [战场](../artifacts/mecha-monster-preview/iterations/06/world/porous_shaper.png) |
| L4 | 晶簇体 | [近景](../artifacts/mecha-monster-preview/iterations/06/portraits/prism_warden.png) | [战场](../artifacts/mecha-monster-preview/iterations/06/world/prism_warden.png) |
| L5 | 群构体 | [近景](../artifacts/mecha-monster-preview/iterations/06/portraits/swarm_mantle.png) | [战场](../artifacts/mecha-monster-preview/iterations/06/world/swarm_mantle.png) |
| L6 | 相位体 | [近景](../artifacts/mecha-monster-preview/iterations/06/portraits/phase_stalker.png) | [战场](../artifacts/mecha-monster-preview/iterations/06/world/phase_stalker.png) |
| L7 | 引力核 | [近景](../artifacts/mecha-monster-preview/iterations/06/portraits/gravity_core.png) | [战场](../artifacts/mecha-monster-preview/iterations/06/world/gravity_core.png) |
| L8 | 织网体 | [近景](../artifacts/mecha-monster-preview/iterations/06/portraits/neural_weaver.png) | [战场](../artifacts/mecha-monster-preview/iterations/06/world/neural_weaver.png) |
| L9 | 多核生命 | [近景](../artifacts/mecha-monster-preview/iterations/06/portraits/many_core.png) | [战场](../artifacts/mecha-monster-preview/iterations/06/world/many_core.png) |
| L10 | 场域生命 | [近景](../artifacts/mecha-monster-preview/iterations/06/portraits/field_sovereign.png) | [战场](../artifacts/mecha-monster-preview/iterations/06/world/field_sovereign.png) |

## 最终近景人工审阅

| 物种 | 当前轮廓及粒子 | 需要继续关注 |
| --- | --- | --- |
| 孢群体 | 多球芽体、绿色点云 | 外层球体仍偏实心，需提高生命体感 |
| 流环体 | 双翼折线、橙色流线 | 避免与机械翼造型混淆 |
| 孔洞行者 | 青蓝／琥珀分层参数点云与半透明核心 | 距离较远时细节弱，孔洞语义还不够明确 |
| 晶簇体 | 八面体框架与内部晶格点云 | 框线偏粗，需保持护盾/危险格辨识 |
| 群构体 | 环绕碎片和独立粒子团 | 子体形态与技能出生格还需对应 |
| 相位体 | 双螺旋粒子、交叉轨迹 | 交换方向必须由战斗提示明确表达 |
| 引力核 | 汇聚点云、交错轨道 | 远景避免误认为普通发光球 |
| 织网体 | 节点、连接线与信号粒子 | 连线应与真实链接对象区分 |
| 多核生命 | 多个发光节点和外环 | 各阶段激活的核心需和规则同步 |
| 场域生命 | 嵌套空间框架和坐标粒子 | 网格不能与战场格线混淆 |

均属几何模型和参数化点云；玻璃为近似半透明材质，不是物理折射；孔洞体并非 SDF 光线步进或递归分形。没有目标 GPU 的帧率/能耗数据，不能判定正式性能门禁通过。

## 当前局限

- 独立形态可渲染不等于专属技能已进入战斗；L5 已开放本地演练场，L8/L9/L10 仍不能从本地演练场开始。L5 动态子体暂不支持内置 AI 建议与自动对战，只能手动规划。
- 这些轮次是工程师视觉改动和审阅，最终艺术效果仍需用户确认；现有形态仍有低多边形和粗轨道特征，不能声称已达到参考图的复杂分形品质。
- 距离衰减属于表现降级；需在目标设备、城市遮挡、各种摄像机距离、低画质与实际战斗中继续验证。

## M3 战场表现复核

- 蚀格使用单独的棋盘地标，只显示已提交的场；宣告目标和草稿预测不会伪装成已生效地块。创建与过期标记跟随经过验证的演出事件结算，停止播放后恢复显示对应快照。
- `artifacts/mecha-monster-preview/corrode-world/corrode-committed.png` 是规则生成的已提交蚀格在合成 `CityMechaWorld` 场景中的截图，不是完整城市 UI 或 Tauri 画面。
- 合成浏览器测试覆盖蚀格地标的真实规则事件、重叠层、点击、播放/暂停、低动态效果和资源释放。另有近距离非落空的相位交换与引力牵引测试，验证实际规则到世界位置播放的起点、中点、暂停、落点和最终快照；两者均非交互式 UI 或目标设备验收。

## L5 群构体演练复核

- 群构体可在本地演练场选择：固定候选格、草稿重投影、子体出生与死亡均来自同一套预览/回合规则。控制器回归覆盖本地回放；合成城市浏览器测试检查真实回合与 WebGL 演出。
- 运行浏览器回归前，先启动 `cd apps/agent-city/ui && npm run dev -- --port 5179`，再运行 `npm run verify:mecha-swarm-browser`。测试使用合成城市并阻断外网；不能替代 Tauri、目标 GPU 或人工艺术验收。
