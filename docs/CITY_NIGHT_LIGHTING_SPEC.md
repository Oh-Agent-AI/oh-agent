# City 夜景光照优化 SPEC（2026-10-07）

用户反馈：「现在夜景建筑物的灯光很不真实，感觉建筑物是发着荧光的玩具。」本文分析成因并给出分期方案。

## 1. 问题分析（对照现有代码）

| # | 现象 | 根因（代码位置） | 为什么像荧光玩具 |
|---|---|---|---|
| P1 | 墙面整体微亮 | `cityParts.ts` 立面 shader：`totalEmissiveRadiance += diffuseColor.rgb * uSelfLit`，`uSelfLit` 基线 0.24 **昼夜恒定** | 真实夜里墙面只是被路灯、窗光反射着微亮；这里墙面按自身颜色发光，薄荷/粉/青的区色在夜里依然饱和，像塑料 |
| P2 | 窗户亮度一致、颜色只有两种 | 同一 shader：`lamp * facadeWindow * on * uWindowGlow * 2.3`，亮度只由 `uWindowGlow` 决定，色只在两个 vec3（暖黄/冷白）间 `step` 切换 | 真实窗光亮度跨度大（电视蓝光、台灯、走廊灯、空窗），色温连续分布；这里是一块块等亮度的「LED 点阵」 |
| P3 | 窗户开/关是硬开关且与时间无关 | `on = step(hash, (0.28+0.5·seed)·smoothstep(uWindowGlow))`：整座城同一时刻同步亮起，亮灯比例只由楼的 seed 决定 | 真实城市亮灯率随时段（19–23 点高、凌晨低）、楼用途（办公楼夜里整层亮灭、住宅零星）变化；这里没有「活的」感觉 |
| P4 | 每栋楼顶一圈彩色轮廓 | `neonMesh`（`palette.accent × 3.2`，MeshBasic、`toneMapped:false`）给**每栋**楼顶描边；bloom 阈值 `UnrealBloomPass(…, 1.0, 0.6, 2.0)` 把它放大成光晕 | 彩色描边是玩具/赛博风的最强信号；真实城市只有少数地标/商业招牌才有霓虹 |
| P5 | 光没有层次 | 路灯光斑是固定半径加色圆片（`pools`），所有灯同亮度；窗光不照亮外部；楼与楼之间没有暗部 | 夜景真实感来自「暗 → 亮」的层级：路灯照亮地面与墙脚，窗光很弱地漏到邻近表面，天际线顶部渐暗 |
| P6 | 天空/海/地面不够暗 | 夜间天空是紫色渐变、地面主题色未随夜压暗，曝光 `activeTheme().exposure` 昼夜相同 | 周围越亮，建筑上的自发光越显得「贴上去的」；真实夜景的主体是深色环境里的光源 |
| P7 | 地标材质各自为政 | 地标/配套用 `emissive` 常量（0.25、1.6、`neon ? 1.4 : …`）和 `glow()` 方块，亮度手填 | 同一画面里的灯具强度、色温不一致，没有统一的「光照预算」 |

结论：问题不是「灯不够多」，而是**光源类型单一（全是自发光贴图）、强度/色温缺少分布、墙面与轮廓也在发光、环境不够暗**，所以读成「会发光的玩具」，而不是「有灯的建筑」。

## 2. 设计原则

1. **暗是底色**：夜里环境（天空、海、地面、墙面）先压暗，亮的东西才有意义。
2. **只有光源在发光**：窗、路灯、招牌、地标泛光是光源；墙面、屋顶边、楼体轮廓不是。
3. **光有分布**：强度近似对数正态（多数暗、少数亮），色温连续（2400K–5500K）。
4. **光有来由**：亮窗比例与楼用途、时段、会话活跃度相关，而不是纯随机。
5. **克制的彩光**：霓虹只给招牌、酒店冠、少数地标；区色不再用于夜间立面发光。
6. **预算统一**：所有自发光按同一张「灯光预算表」取强度。

## 3. 方案

### N1 去荧光（最便宜、收益最大）
- `uSelfLit` 夜里降为 0（现 0.24 → 随 `night` 线性降到 0.02）；墙面只被环境光与外部灯光照亮。
- 屋顶 `neonMesh` 描边夜里仅对：酒店冠、商业高楼（≥24）、地标保留；普通会话楼关闭（实例颜色置黑或 `count` 过滤）。
- Bloom 阈值 2.0 → 2.6，强度 1.0 → 0.55；半径 0.6 → 0.4，只让真正的光源起晕。
- 夜间曝光 −0.35 EV，天空渐变压暗 30%、海面与地面主题色 ×0.7。

### N2 窗光分布
- 窗亮度：`lamp *= 0.25 + 1.6 · hash²`（多数暗、少数亮）；色温在 2400K–5500K 连续取，按 hash 插值而非二选一。
- 亮灯率随时间：`on = hash < rate(t, 用途)`；住宅 19–23 点 55%→35%，凌晨 8%；办公/商业整层同亮同灭（按楼层 hash 而不是按窗）。
- 活跃会话（`building.active`）亮灯率 +25%，让「今天在工作的楼」夜里更亮——数据与光产生关系。
- 每层加极弱的内部漏光（窗下 0.3 层高的渐变，强度 ×0.15），避免窗是孤立的亮块。

### N3 外部光照
- 路灯光斑按灯高/功率分档（主干 1.0、支路 0.6、步道 0.45），半径与亮度随之变化；光斑颜色统一 2700K。
- 用 8–12 盏全城共享的 `PointLight` 不可行（性能）——改为：地面贴图烘一张「夜间光照」叠层（灯位 + 窗光外溢的低分辨率高斯），只乘到地面与低层墙脚。
  - **范围注记（2026-10-18，N5 引入）**：本条否决的是「全城常驻 THREE.Light 对象」。N5 的开车模式解析街灯不创建任何 Light 对象（shader uniform 内解析求值），且只在游戏相机周边激活，不在本条否决范围内。
- 水面加窗光倒影：沿岸线采样最近楼的亮灯率，生成低频亮带贴到水面反射。

### N4 光照预算与一致性
- 新增 `cityLightBudget.ts`：定义 `window / street / sign / landmark / hazard` 五类光源的强度、色温范围，所有 `emissive` 常量与 `glow()` 调用从这里取。
- 守卫 `verify-city-night.mjs`：渲染夜景（forced night）后统计画面——发光像素占比 ≤ 12%；饱和度 > 0.8 的发光像素占比 ≤ 3%；最亮 1% 像素中来自「非光源」网格的比例 = 0。

### N5 开车模式解析街灯（2026-10-18）
低角度追尾相机下，N3 的贴纸光斑（正圆径向渐变 + 加色混合）最穿帮：不参与照明、无遮挡、形状与光度学无关。开车模式换解析引擎，普通/飞行模式维持贴纸：

- **解析式光源（night-street 架构，MIT）**：灯不是 `THREE.Light`，是共享 uniform 数组里的数据（`uCarLampP/D/C[16]`：位置+坎德拉 / 发射轴+横路压缩 / 色度），在受光材质（地形、路面、车身）shader 的 `lights_fragment_end` 注入解析求值，加进 `reflectedLight.directDiffuse`——与 three 光照管线同构，吃反照率/法线，与其他光正确相加。
- **光度学分布**：蝙蝠翼 `1/cos³`（nadir 角）+ 横路压缩 k=2.2 + 截止余弦带 [0.18, 0.32] + 平方反比（200mm 下限）。余弦幂是收窄函数（灯下最亮四周衰掉）——正是贴纸圆片的病根；均匀路面照度要求强度 ∝ 1/cos³。
- **选灯**：每帧相机最近 16 盏（`updateCarStreetLamps`），灯位来自 `planStreetLamps`（与实例矩阵同源同序的纯函数表，scene-baseline golden 守住不漂移）。
- **交叉淡化**：解析光按「相机到灯」在 40–70m 带内淡出，贴纸光斑按「片元到相机」同带淡入——互补，总量近似守恒；换出名单的灯在带外权重为 0，无爆闪。
- **warm-up**：每盏灯的钠灯启辉进度由灯位种子确定性哈希（`lampWarmth`），输出 `w^0.55`、色度 `w^0.75`（暗红粉→工作橙，颜色先于亮度稳定）——4600 盏同色温同步亮灭的直接解药。
- **预算**：天底坎德拉 `LIGHT_BUDGET.street.analyticCd`（换算推导见该处注释），色度端点 `warmStrike/warmWorking`，下限 `warmthFloor`；守卫断言新代码读预算。
- **门控**：`uCarLampCount = 0` 时所有注入块早退——普通/飞行/导片 worker/白天行为零变化；退出驾驶（`detachFrame`）清零并放开贴纸。
- **不做（后续可选）**：楼立面/路缘受光、bloom 阈值修复、灯头 halo sprite、车灯体积锥、环境车流受光。

## 4. 验收

- 同一视角昼夜对照截图（真 GPU，Chrome + Metal）：墙面不再有区色发光；窗光明暗/色温有明显分布；屋顶无彩色描边（除酒店冠、地标）。
- 数值：发光像素占比、饱和发光占比（见 N4 守卫）。
- 用户主观验收：夜景「像有灯的城市」而不是「发光的积木」。

## 5. 风险

- 压暗环境会让低质量档（无 bloom）的夜景过黑：设下限，并在省电档保留 N1 之外的原亮度。
- 亮灯率随时间需要时钟：回放时用游标时间，实时用本地时间；时区取 `tz`（已有 `cityTz`）。
- `uSelfLit` 在日落主题里有「防灰化」作用（见注释）：夜里降到 0.02 后需看黄昏过渡是否出现突变，过渡用 `smoothstep(night)`。

## 6. 实施状态（2026-10-07）

全部已落地（真 GPU 22:00 截图验收；守卫 `scripts/verify-city-night.mjs` 并入 `verify:city`）：
- **N1**：墙面 `uSelfLit` 夜里压到 ~10%；屋顶霓虹仅高楼（≥24）与酒店冠；bloom 0.55/0.4/2.6；夜间曝光 −22%；地面主题色夜里 ×0.62（`uNightDim`），夜海与天空沿用 `uNight`/`uSkyDim`。
- **N2**：窗光亮度平方分布、色温连续；亮灯率随本地小时（`windowRate`）与用途（办公按楼层整层亮灭、住宅零星）；活跃会话 `activeBoost`；窗下漏光。
- **N3**：路灯按道路等级分档（`lampTier`：灯头/光斑亮度、光斑半径、间距）；地面夜间光照叠层（`buildGroundSpill`，窗光外溢，随亮灯率）；水面窗光倒影（同一张叠层图进水面 shader）。
- **N4**：`cityLightBudget.ts` 统一预算；桥塔霓虹降饱和并走预算；守卫校验预算自检、亮灯率曲线、路灯分档、无手填倍率。
- **N5**（2026-10-18）：开车模式解析街灯落地——`drivingStreetLights.ts`（uniform 数组 + 蝙蝠翼求值 + 交叉淡化 + warm-up 哈希）；`planStreetLamps` 灯位表与实例矩阵同源；地形/路面/车身三处注入；`presentDrivingCamera` 每帧选灯、`detachFrame` 清零。
- 不做：渲染像素统计守卫（swiftshader 在 CI 过慢，改为预算/代码守卫 + 人工 GPU 截图验收）。

## 7. 排期（已完成）

N1（半天，立刻见效）→ N2（1 天）→ N3（1–2 天，地面叠层）→ N4（守卫 + 预算表，贯穿）。

## 附录 A：参数对照表（现值 → 目标；2026-10-07 源码定位）

| 参数 | 位置 | 现值 | 目标（对应正文条目） |
| --- | --- | --- | --- |
| 墙自发光 uSelfLit | cityParts applySelfLit（themeBase 恒 0.24） | 0.24 | 随 night 线性 → 0.02（N1） |
| 屋顶霓虹描边 | neonMesh accent × 3.2（每楼） | 全楼 | 仅酒店冠/≥24 商业楼/地标（N1） |
| bloom | CityEngine UnrealBloomPass(1.0, 0.6, 2.0) | 强度 1.0/半径 0.6/阈值 2.0 | 0.55 / 0.4 / 2.6（N1） |
| 夜间曝光 | activeTheme().exposure 昼夜同值 | — | −0.35 EV；天空 −30%、地面/海 ×0.7（N1） |
| 窗亮度 | lamp × on × uWindowGlow × 2.3（等亮） | ×2.3 | ×(0.25 + 1.6·hash²)（N2） |
| 窗色温 | 两色 step 切换 | 暖黄/冷白 | 2400K–5500K 连续插值（N2） |
| 亮灯率 | 0.28 + 0.5×seed（与时间无关） | 28–78% | rate(t, 用途) + 活跃会话 +25%（N2） |

## 附录 B：取证机位协议（截图验收用）

固定 seed 74031、30 天窗。四个机位各拍 夜/黄昏/白天 三态，合并前后同机位对比：

1. **楼群近景**（downtown 簇 30–45° 俯角）——窗密度/亮度方差/色温分布的主证据位；
2. **全城中距全景**——发光像素占比、黑街/光环境的主证据位；
3. **正午同角度对照**——墙体昼夜亮度差必须肉眼可辨（夜墙 ≠ 昼墙是 N1 的验收线）；
4. **地标霓虹近景**——N1 收 bloom 后霓虹仍醒目的反证位（防「矫枉过正熄灯」）。

机位复现方式：时间游标（30 天窗，滑标值 = 1000 − (now−目标时刻)/窗长×1000）+ 画布滚轮/拖拽；
禁用生成式概念图，只认真 GPU 截图。

## 2026-10-22：光斑贴地修复与基线

地面光斑不再用原始地形高度的单张切平面圆片，而是沿渲染地形的三角剖分裁剪，使用与道路一致的 `terrainSurfaceHeight`。接收面高于道路 0.08 单位，保留深度测试、不写深度，并使用有界 polygon offset；建筑、路缘和上层桥面仍可遮挡光斑。高架光斑保留桥面高度，不采样桥下地形。灯位、半径、强度预算和驾驶近景解析灯的交叉淡化未改变。

`verify-city-night` 已覆盖曲面三角形内部的净空、朝上绕序、UV 和高架层隔离。光斑从实例圆片变为一个合并网格，场景基线的预期变化为 `street-light-pools` 新节点、原 `unnamed:Mesh` 减少一个，以及原实例所属 `city-infrastructure-decorative` 的哈希变化；380/1600 会话、昼/夜四种场景均核对同一差异范围后更新基线。此基线检查不代替所有机位的 GPU 动态闪烁验收。

### GTAO 覆盖材质回归修复

贴地网格属于发光装饰，不是实体表面。GTAO 的 `scene.overrideMaterial` 会忽略其透明渐变、加法混合和深度写入设置，用不透明法线/深度材质重画整个圆面，造成道路上周期性的黑色圆斑。`street-light-pools` 现在通过绘制回调在覆盖材质期间将 drawRange 设为 0，完成后恢复；正常颜色绘制前再次恢复，防止中断留下隐藏状态。不关闭全城 AO，不改变正常光斑的深度测试。`verify-city-night` 使用实际建出的网格检查覆盖绘制为零、正常绘制恢复、昼夜切换和中断恢复；浏览器近景已确认白天黑圆斑消失。

### Civic signs and glass: daytime receiver correction (2026-10-22)

Civic window/sign glow boxes previously reused the opaque landmark neon material.
When night intensity fell toward zero, their black faces covered the solid red
hospital cross and blue window bands. Civic overlays now use a dedicated additive,
non-depth-writing material sharing the live night color. They emit no instances
in override-material passes, so GTAO cannot turn the overlay into a dark occluder.
The shared landmark neon material is unchanged.

Explicitly marked civic window/door instances sample the same sky panorama and
live time/weather grade uniforms as session-building glass. Walls, mullions and
red crosses retain their diffuse materials. This is sky environment reflection,
not a reflection of neighboring geometry or vehicle interiors; the existing three
civic instance batches, growth transforms and geometry stay unchanged.

Acceptance: `verify-city-night.mjs` exercises a real hospital mesh, glass masks,
solid red cross arms, off/on/off intensity, interrupted override restoration and
shared environment uniform identity. Layout envelopes and 380/1600 day/night site
registry checks pass. The scene baseline changes only `city-civic-glow` material
transparency in four scenes. Browser demo acceptance shows a red cross and blue
reflective windows with no shader errors (`/tmp/ohagent-hospital-daylight-fixed.png`).
