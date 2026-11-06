# tinyskies 源码分析与移植台账（2026-10-04）

对象：[tinyskies](https://github.com/dannylimanseta/tinyskies)（游戏本体为 GlobeFly——绕球飞行/收集/多人的休闲飞行游戏）。本机分析副本：`/tmp/tinyskies`（commit `2659a5c`）。
许可状态：仓库无 LICENSE 文件；作者已明确授权参考与移植（2026-10 会话中确认）。**纪律：所有移植在对应模块头注释与提交信息中标注出处**（先例：`cityAmbient.ts` 模块头、各 feat 提交信息）。
本文是完整的移植决策记录：已移植、可移植未移植、不移植，以及移植中沉淀的方法论教训。

2026-10-04 范围更新：用户已明确增加可选的飞机任务游戏模式，详见 [CITY_GAME_MODE_IMPLEMENTATION_PLAN.md](CITY_GAME_MODE_IMPLEMENTATION_PLAN.md)。下文原“不移植玩法”结论针对数据展示模式；现在选择性借鉴 Plane/CameraRig/RaceManager，并将 PackageQuest 留作第二阶段。Game 总控、多人后端及整套成长/战斗体系仍不整体迁入。FlightControls 的“零增量”估算不适用于完整游戏模式。

## 1. 源码结构总览

```text
client/src/game/   78 个模块 · 43,565 行 TypeScript（three.js WebGL 渲染）
  ├─ 世界与渲染   Globe(5803 行：地形球体+海洋注入 shader)、TerrainSurface、SkyPresets、
  │               DayNightCycle、Starfield、Aurora、RainOverlay、RainbowArch、LensFlare、GodRays
  ├─ 生物与生命感 BirdFlock、OceanFish、SkyJellyfish、FireflyCluster、FloatingLanterns、
  │               WaterSpouts、Volcano、NpcBoats、NpcPlanes
  ├─ 玩法系统     Game.ts(7042 行总控)、Carpet 系(魔毯)、SkyGremlins/Void 系(敌怪)、
  │               Package/Race/Rings/Paintball(任务与竞速)、Upgrade/Progression、Campsite 系
  └─ 操控与工具   FlightControls、TouchControls、CameraRig、Trail、Contrails、SphericalMath
client/src/       audio / network / ui / runtime / utils
server/src/       Node + Prisma 多人后端（rooms、routes、paintball、terrain 同步）
```

对 Agent City 数据模式有价值的是**世界/渲染/生命感/操控**四类；新增游戏模式可选择性借鉴穿环与配送，按独立存档和任务状态机实施。多人系统仍不进入范围。

## 2. 已移植台账（14 项）

| tinyskies 模块 | 我们的实现 | 提交 | 移植时的关键适配 |
| --- | --- | --- | --- |
| Aurora.ts | `engine/cityAurora.ts` | `eee87fda` | 8 幕帘顶点波动 + 三段配色，随 stars 淡入 |
| WaterSpouts.ts | `engine/cityAmbient.ts` SeaSpout | `4fda6c75` | twist/sway 顶点注入照搬，锚点改城外海面 |
| （气球意象） | HotAirBalloon | `4fda6c75` | 低模自建（球+筐+绳） |
| FloatingLanterns.ts | NightLanterns | `4fda6c75` | instanced 暖光点，随 stars 升起 |
| （山体植被意象） | `cityPlan.ts` 山坡林区 | `4fda6c75` | h∈(3.2,60) 且 slope<1.5 采样 |
| BirdFlock.ts | `cityWildlife.ts` BirdFlocks | `ba63f309` → `3bbaf21f` | V 位照搬；第二版改 3D 身体+独立扇翼+扇/滑翔交替（扁平剪影多数角度读不出鸟形） |
| MeteorShower.ts | MeteorShower | `ba63f309` → `52a8bf0f` | 对象池节奏；第二版换装它的熔岩头/火转烟尾迹 shader |
| （萤火虫意象） | Fireflies | `ba63f309` | 闪烁点阵 shader 化，宿主是布局层公园/林位 |
| Volcano.ts buildVolcanoGeometry | `cityParts.ts` volcanoGeometry | `564c6726` | 3D simplex 换本库 fbm（值域 −1..1→0..1 修正）；lathe 点序翻转；billboard 烟 |
| RainOverlay.ts | `cityWeather.ts` RainOverlay | `28159abd` | 三层程序化斜雨 shader 化；玻璃水珠折射（需读帧缓冲）未搬 |
| RainbowArch.ts | RainbowArch | `28159abd` | 出现条件从玩法奖励改为「昨日降雨+当日哈希」 |
| WakeTrail/CarpetWake | 船尾迹泡沫池 | `7433b4c0` | 径向渐变贴图 + 128 实例池 |
| FlagSystem.ts | 布料旗帜 | `06e589b8` | 顶点摆动 + per-instance 相位；挂各区花园（host 色）与观测塔 |
| Globe.ts 海洋注入 | 岸线涟漪带 + 碎波光场 | `3dba29c8` 等 | oceanDepth 顶点属性 → 384² 深度纹理（水面是 1×1 段平面）；频率按世界尺度 ÷100 |

## 3. 可移植未移植（按价值排序）

| # | 模块 | 用途 | 对接点 | 成本 |
| --- | --- | --- | --- | --- |
| 1 | **FlightControls + Plane + CameraRig** | 飞机输入、运动和追尾手感；参数需按城市尺度重调 | 游戏模式 G1，见实施方案 | 非零：输入生命周期、平面运动、碰撞、相机与暂停恢复 |
| 2 | **NpcPlanes + BiplaneMesh** | 水上飞机班线 / 渡轮进港 | 生机方向清单第 5 项 | 低模三件套 + 航线循环 |
| 3 | **Trail.ts + Contrails.ts** | 飞机凝结尾迹；船尾迹升级为连续航迹 | 与 #2 同批 | ribbon 工具类 |
| 4 | **OceanFishMesh 跃出弧线** | 鲸/海豚跃（远海偶发，日期+时段 seed） | 生机方向第 6 项 | 翻滚弧线 + 水花 |
| 5 | LensFlare.ts | 黄昏太阳光斑 | 与现有 bloom 重叠，效果不够再上 | 低 |

## 4. 不移植清单（一句理由）

- **整套玩法系统**（Game 总控/Carpet 系/SkyGremlins/Void 系/MoonThreat/CosmicPortal/Paintball/Upgrade/Campsite 系）：不整体移植。Race/Rings 和 Plane 作为独立游戏模式参考，Package 留第二阶段；Progression 只借鉴存档思路。游戏成绩不改写真实工作数据或解释为真实任务完成度。
- **SkyJellyfish**：视觉出色但属幻想生物，Miami 数据城市语境突兀。
- **Braziers/EternalFlame 系**：火盆/永恒之火与海滨基调不合（火山口微光已覆盖「火」）。
- **GodRays**：体积光后处理，现有 bloom+GTAO 预算外。
- **server/ + client/network**：多人后端——离线产品红线（数据不出机）。
- **SphericalMath/TerrainSurface/SkyPresets/Starfield**：球面数学与它们的地形/天空体系绑定；我们的 fbm/关键帧天空/程序星点已是等价或更强实现。

## 5. 移植方法论教训（真实事故沉淀，后续移植照此检查）

1. **频率必须按世界尺度换算**：游戏球半径 5，城市尺度 ~千。第一版涟漪把 sin 频率原样搬入 → 远处高频场混叠成像素网格 + 时间滚动闪烁。规则：移植任何空间频率先 ÷ 世界尺度比，再目检远距。
2. **混叠用「频率 LOD」治，不用幅度淡出**：浪花/碎光在远距交叉淡入 1/5–1/6 频率八度——细节全距离在场、屏幕空间频率始终低于采样极限（`fwidth` 守卫做分辨率兜底）。
3. **确定性纪律**：一切环境事件按日期（或日期+时段）哈希，日期先过 Knuth 混淆再入 FNV——顺序整数直接哈希会强相关（天气曾因此 72 天无雨、阴天连跑两周）。
4. **「游戏效果好看」常绑定它的相机尺度**：判断可移植性先问「我们的相机会不会以它假设的距离/角度看到这个东西」。
5. **贴图/后处理类先问预算**：玻璃水珠（读帧缓冲）、体积光在集显预算外，明确记录「未搬 + 原因」，不静默丢弃。
6. **借思想优先于借代码**：onBeforeCompile 注入、径向渐变抗「沙盘贴纸感」、flatShading 体积感等手法可迁移；具体数值几乎总要重调。

## 6. 建议排期

当前优先执行游戏模式方案的 G1 飞行练习、G2 穿环任务、G3 存档与原生验收。原有环境增强候选保留为后续：班机/渡轮航线与尾迹（§3 #2#3）、鲸跃（§3 #4）、LensFlare。它们不作为第一版游戏模式的前置条件。

## 附录：78 个 game/ 模块分类索引

| 类 | 模块 |
| --- | --- |
| 已移植（14） | Aurora, WaterSpouts, FloatingLanterns, BirdFlock, MeteorShower, FireflyCluster*, Volcano, RainOverlay, RainbowArch, WakeTrail*, FlagSystem*, Globe(海洋部分), (气球/山植/萤火虫为意象级) |
| 可移植（5） | FlightControls, CameraRig, NpcPlanes, BiplaneMesh, Trail, Contrails, OceanFishMesh, LensFlare |
| 不移植（59） | Game, Globe(其余), Terrain 系, Sky 系其余, Carpet 系(8), Gremlin/Void 系(7), 任务/竞速/成长系(7), Campsite 系(3), 多人/输入其余, 工具其余 |

\* 标注为意象级 = 借设计意图自建实现，未逐行参考。
