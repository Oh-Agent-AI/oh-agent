# Agent City：渲染质感 SPEC（2026-10-02，v2 宏观修订）

状态：草案，待评审。v2 修订：按产品方向收敛为**宏观真实感**——删除 v1 的 interior-mapping 微观夜窗（移入非目标），F1 改为夜间街道亮网 + 楼间亮窗异质性两项宏观特性。范围：只动渲染层（cityParts.ts / CityEngine.ts / citySky.ts / cityTextures.ts），不改 cityModel / cityLayout 契约、不动数据面与 golden。

现状分层见 `docs/CITY_MODULE.md`；本文是它的一期质感增量，不重写布局与昼夜既有行为。

## 1. 背景与来源

来源：three.js 官方示例 `examples/webgpu_generator_city.html`（mrdoob）及其依赖 `examples/jsm/generators/CityGenerator.js`、`generators/city/SkyscraperGenerator.js`（2026-10 master）。已逐文件分析。three.js 为 MIT 许可，可参考与移植，模块头与提交信息注明出处（同 tinyskies 先例）。

该示例跑在 WebGPURenderer + TSL 节点材质上；我们是 WebGLRenderer + onBeforeCompile GLSL 注入。**本 SPEC 只借思想，用 GLSL 在现有管线上重写，不迁移渲染器**。

## 2. 问题 / 动机（宏观视角）

| # | 现状 | 宏观差距 | 来源技术 |
| --- | --- | --- | --- |
| P1a | 夜间 = 全城立面均匀发光（`uSelfLit` 全局抬升，cityParts.ts:94-119）；地面/道路夜间无光 | 航拍夜城读作「发光方块群」，缺真实城市第一夜相特征：**亮着的街道网格**（路灯把路网描成暖黄光带、街区内部暗） | 街灯沿路缘按间距布点（CityGenerator.js buildFurniture）；路面湿面反光（createRoadMaterial） |
| P1b | 所有楼共享同一 lit 窗纹理 + 同一 uSelfLit | 城市肌理均匀得假；真实夜城有热闹楼 / 普通楼 / 暗楼的**亮窗密度分布** | 每楼独立哈希决定色调与明度（buildingColorNode 的 common-tone 重复思想） |
| P2 | 太阳色/强度 = 手调关键帧线性插值（citySky.ts KEYFRAMES） | 日出日落中间段过渡生硬，色温跳变 | 透射率连续模型：`t=√sin(elev)`（示例 html:202-257） |
| P3 | 阴影正交盒固定对称（`shadowBox = bounds*0.85+24`，CityEngine.ts:384-389） | 低太阳角长影时贴图分辨率摊薄，影子糊——长影是最显眼的宏观立体线索 | 光源空间投影收紧（示例 html:231-257） |
| P4 | 车色 6 色均匀分布（cityParts.ts:1467） | 车队读起来像调色板循环 | 累积权重色表（CityGenerator.js:406-416） |
| P5 | 玻璃/水面无天空反射 | 黄昏航拍时玻璃楼群不映晚霞，与天空脱节 | 天空 → PMREM → scene.environment（示例 html:259-268） |

## 3. 目标与非目标

**目标（宏观真实感）**
- 夜相近景质变 → 改为：**夜相宏观质变**——航拍高度读出「路网亮、街区暗、楼有明暗差」的真实城市夜相。
- 昼夜太阳连续：关键帧端点（DAY/DUSK/NIGHT 艺术方向）不变，端点之间由物理曲线驱动。
- 低太阳角阴影贴图利用率提升，无新增 draw call（F1a 的灯点除外，见 §5.1）。
- 车队色彩分布读起来「像真的」。
- 全部特性在集显 30-60fps 预算内。

**非目标**
- **Interior mapping / 窗内房间细节（v1 的 F1，明确降级）**：微距特性，只在夜间街边视角可见，产品相机（航拍/巡航）几乎到不了；即使门控下成本可控，也为低价值场景增加 shader 复杂度与维护面。若将来产品增加街景模式再立新 SPEC。
- 迁移 WebGPURenderer / TSL；LightProbeGrid 全局光照；合并几何楼体（理由同 v1）。
- 改变城市数据语义、布局确定性、时间轴行为、18/19 点亮灯时刻表语义（F1 只换「亮什么、怎么亮」，不换亮的时序）。
- 行人 / 红绿灯 / 消防栓等街道家具（后续另立）。

## 4. 不变契约

同 v1：布局确定性 / 刷新不搬家 / 输入顺序无关（`verify-react-city-layout.mjs` 守卫）；昼夜节流与休眠渲染行为不变；golden / Python / Rust 零影响；verify:city 六项、verify:react 全项继续绿。

## 5. F1 夜相宏观：街道亮网 + 亮窗异质性

### 5.1 F1a 夜间街道亮网

- **路灯点阵**：沿现有道路图（roadEdges，arterial 8 宽 / local 5 宽）路缘按间距布灯——arterial 每 ~30 单位双侧、local 每 ~40 单位单侧，位置在构建期一次性算好（确定性：`hashSeed(edgeId:index)`），一个 instanced 灯点 mesh（小球或十字 sprite，`toneMapped:false` 暖白 #ffd9a0，additive），实例数 ~200-600。显隐/亮度由 `nightGlow` uniform 驱动，**18:00 渐亮、19:00 全亮**沿用现有时刻表。
- **路面夜光**：地面图集 shader 加 uniform `uStreetGlow = nightGlow × 路面遮罩`，夜间路面（沥青）微亮 + 路缘线略强，让路网从空中连成光带，而不只是离散灯点。地面已有道路绘制，遮罩从图集通道取（实现期定：复用现有标线层或加一版夜间 mask 通道，≤256²）。
- 不做：真实点光源（集显不可行）、灯锥体积光、单灯开关随机（宏观读的是「网」，不是灯）。

### 5.2 F1b 楼间亮窗异质性

- 每楼一个**亮窗密度因子**：`litDensity = 0.2 + hash(building.seed) × 0.75`（即 0.2–0.95，少数楼近全亮、少数楼近全暗），新增 instanced attribute `aLitDensity`（float）。立面 shader 里窗格 lit 判定由「纹理固定图案」改为「纹理图案 × per-window 哈希 < litDensity」——窗级哈希用现有 `vPhotoUv` 格点坐标，零纹理改动。
- 少量楼（~8%，hash 决定）标记为「夜班楼」：`litDensity ≥ 0.9`，商业区比例更高——城区氛围差异（可选，实现期看效果决定去留）。
- 全城整体亮度基线不变：`uSelfLit` 语义保持，litDensity 只重分配「哪些窗亮」，总发光量近似守恒（litDensity 平均 ~0.57 ≈ 现纹理点亮率）。

### 5.3 验收（F1a + F1b）

- 航拍高度 21:00 截图：路网读成连续光带、街区暗、楼群有明显明暗分布——与修订前对照评审。
- 灯点实例 ≤600、1 个新增 draw call；地面 shader +1 uniform mix。
- 白天画面逐像素无差异（门控全关回归）；18:00–19:00 渐亮节奏不变。
- 1400 栋 + 夜间航拍：cityDebug 帧率不低于当前基线 −5%。

## 6. F2 太阳透射率连续模型

同 v1：KEYFRAMES 与端点不变，端点之间 sunColor/sunIntensity 用 `t = √max(sin(elev), 0)`、`sunColor = lerp(#ffb072, #fff4e8, t)`、`sunIntensity = K × t`（K 用现行 DAY 档标定）；NIGHT 端点不走公式。验收：6:30 / 17:45 / 18:30 无色温跳变；正午与现行 DAY 档一致；cinematic 契约绿。

## 7. F3 阴影正交盒收紧

同 v1：城市包围盒 8 角投光源空间拟合正交盒（pad 2），挂 updateDaylight 节流；`normalBias = 0.6` 已在（CityEngine.ts:152），不引入 depth bias。验收：黄昏长影清晰度提升、无 acne、正午无回归。

## 8. F4 车色权重表

同 v1：cityParts.ts:1467 均匀 6 色 → 累积权重表（灰阶 ~70%、白 ~12%、点缀色 ~18%，不照搬纽约黄出租）；确定性色 = `hashSeed('carc:'+index)`。验收：车队读出「多数灰、偶尔彩」。

## 9. F5（可选，实验开关）天空 PMREM 环境反射

同 v1：`scene.environment` = 天空 PMREM（128px），挂昼夜节流与主题切换重烘，**复用同一 render target**；默认关，cityDebug 加开关。宏观动机：黄昏航拍时玻璃楼群映晚霞。退出标准：集显中位帧成本增量 > 1.5ms → 不转正。

## 10. 性能预算（汇总）

| 项 | 预算 |
| --- | --- |
| F1a | +1 instanced mesh（≤600 灯点，小几何）+1 draw call；地面 +1 uniform mix |
| F1b | +1 float/楼 实例属性 + 窗级哈希 ~10 ALU/像素（仅立面片元） |
| F2/F3/F4 | 0 运行时成本（F3 每节流 tick 一次 CPU 拟合） |
| F5 | 重烘 ≤ 每 0.02h 一次；中位帧增量 ≤1.5ms |
| draw calls | F1b-F4 不增；F1a +1；F5 不增 |
| 帧率底线 | 集显 30fps（1400 栋 + 夜间航拍） |

## 11. 分期与提交

- **批次 A**：F1a + F1b + F2（同一夜相/昼夜链路，一次视觉验收）。提交 `feat(city): macro night realism — lit street grid, window heterogeneity, continuous sun`。
- **批次 B**：F3 + F4。
- **批次 C**：F5 实验开关，默认关。
- 每批次：tsc + verify:city + verify:react 全绿 + 浏览器视觉评审（对照 §5.3/§6/§7 验收）后提交；不与并行流文件混提。

## 12. 署名

借鉴代码段（透射率公式、阴影盒拟合、车色权重结构、街灯沿路布点思想）在对应模块头注释标注：adapted from three.js examples/webgpu_generator_city.html（MIT, © mrdoob & contributors），提交信息同注。
