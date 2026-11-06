# Three.js 赛车/驾驶游戏源码调研（驾驶模式参考补充）

日期：2026-10-15。状态：已按源码复核纠错；原临时 clone 路径不作为长期证据。固定 commit 与代码架构见 [驾驶架构设计 §2](CITY_DRIVING_ARCHITECTURE_SPEC.md)。上位文档：[CITY_GAME_VEHICLE_MODE_SPEC.md](CITY_GAME_VEHICLE_MODE_SPEC.md)（本调研补充其 §3 参考表，针对 V1 剩余缺口：坡度动力学、路面提取、擦碰响应、V3 检查点体验）。许可纪律同台账：只借概念按 City 世界单位重写；逐段移植须固定 commit 并登记许可。

## 1. 调研对象总表

| 仓库 | 许可（已核） | 技术栈 | 对我们的价值 |
| --- | --- | --- | --- |
| [BKcore/HexGL](https://github.com/BKcore/HexGL) | MIT（2015 改版；早期 CC） | three.js r60s + 自研悬浮艇物理 | 路面掩膜碰撞/助推区/擦碰排斥；漂移横向通道 |
| [MankyDanky/web-racing](https://github.com/MankyDanky/web-racing) | MIT | three.js + Ammo.js RaycastVehicle + GLB 赛道 | 现代 Ammo 车辆接线全貌；转向回正速率不对称；门渐显 UX |
| [mauriciopoppe/Three.js-City](https://github.com/mauriciopoppe/Three.js-City) | Apache-2.0 | 老版 three.js + 纯街机模型 | **坡度减速项**（tilt 进速度方程）；引擎音调随速度 |
| （SPEC §3 已录）icurtis1/raycast-vehicle、cannon-es 示例、gta7、mini-gta-3d | MIT/MIT/MIT/未确认 | — | 见 SPEC §3，不重复 |

旧 API（r50–60s）意味着 HexGL/Three.js-City 代码不可直接运行，全部为概念级借鉴。

## 2. 关键发现（按我们的缺口映射）

### 2.1 坡度动力学（原结论纠错）

Three.js-City 的 `tiltAmount` 由车速与前轮转角计算，是转弯侧倾，不是道路纵坡。`computeSpeed` 中减去的绝对倾斜项未乘 delta，不等价于 `g·sin(pitch)`，不可作为坡度动力学参考。梯形距离积分可独立评估，不能据此宣称整个模型更稳定。

我们的坡度项应由当前几何支撑面取得有符号纵坡，按固定步长积分，明确前进/倒车、制动驻车和松键溜坡规则；详见架构设计 §8。

### 2.2 路面表达的三种流派（对照我们的解析 patch 方案）

1. **图像掩膜**（HexGL `collisionCheck`）：赛道可行驶性编码成一张 collision.png，每帧 `getPixelBilinear(x,z)` 查墙、查助推区（按像素颜色），墙内侧以左右探针采样决定排斥方向。优点是美术可控、查询 O(1)；缺点是有采样分辨率和坐标映射限制，内存随覆盖面积与分辨率变化；固定像素与采样规则仍可确定性测试。**对我们的价值**：RoadSurface 提取后的"可行驶热力图"可视化调试工具（把 DrivingWorld 覆盖率画成图片供 §13.4 验收看），而不是替代解析查询。
2. **网格碰撞体**（web-racing `track.js`）：GLB 赛道 → 遍历 mesh 合并世界空间顶点/索引 → `btBvhTriangleMeshShape`。这是"从渲染网格构造物理面"的接线参考代码（顶点变换、索引偏移、非索引展开都处理了）。但全 mesh 合并不能提供道路层、合法连接、人行道或桥底语义。我们采用共享编译器输出的语义三角面，不因使用三角面就引入 Ammo；复杂路口的几何提取与物理引擎选型是独立决定。
3. **解析几何**（我们现状）：当前仅矩形平面 patch + 显式同层连接。目标采用同源三角面 + 多边形边界 + portal；不作未经测量的确定性或内存排名。

### 2.3 擦碰响应（SPEC §13.2"轻擦沿切线滑动"尚未实现）

HexGL 的速度平方项扣减护盾，并非速度衰减本身；速度衰减另由 collisionSpeedDecrease 与掩膜值计算。左右探针与有界排斥是启发式反馈，不保证连续碰撞、角落稳定性或无穿透。

本项目保留 swept OBB 检测，补接触 TOI 与法线，再消除剩余位移中的入射法向分量并重新扫掠/验证支撑；左右探针只可作为辅助脱困。不得把护盾损失或最小排斥量直接移植为汽车滑动规则。

### 2.4 手感参数（V2 调参素材）

- **转向回正快于打入**（web-racing `updateSteering`）：回正速率 > 施加速率，且换向时用回正速率——我们是对称指数平滑，值得一档对照试验。
- **速度相关最大转角**（web-racing 按 km/h 分档 `calculateMaxSteeringAngle`）：我们已有 `1/(1+0.07|v|)` 连续版，两者对照。
- **漂移横向通道**（HexGL `movement.x += speed·drift·dt`，drift 由按键与 lerp 驱动）：未来"路肩降抓地/漂移"的最低成本实现形状——横向速度分量独立于航向。
- **引擎音调**（Three.js-City：`playbackRate = |speed|·4/maxSpeed`）：可参考归一化速度驱动音调的映射；实际需怠速下限、平滑、静音/暂停和本地音源生命周期，不直接照用零速 playbackRate=0。

### 2.5 检查点体验（V3）

web-racing `gates.js`：仅当前门可见、下一门**淡入**（1s 透明度过渡）；通过分支未实现旧门渐隐——比"12 环全显"更聚焦；但其判定是**距离触发**（`checkGateProximity` 平方距离），弱于我们 RaceMission 的连续环面扫掠判定——**UX 借、判定不借**。上游淡入用 Date.now，接入时改为遵循暂停的游戏时钟。

### 2.6 不借清单

- HexGL 的 CoffeeScript 时代 API（`addSelf`/`rotateByAxis` 已删除）、Leap/重力感应控制器（非目标）、护盾/武器语义；
- web-racing 的 Peer.js 多人后端、Ammo 全家桶（SPEC §5.3 决策门未触发不引入）、GLB 资产管线；
- Three.js-City 的 dat.gui 调参面板（我们用版本化配置）、城市生成（自有 cityPlan 更强）。

## 3. 落地建议（并入现有批次计划）

1. **V1 首先**：共享路面编译器、实际三角面支撑、分层 portal、城市夹具覆盖与安全出生/恢复。
2. **随后**：连续接触 TOI/法线/切线滑动，以及由路面几何驱动的坡度动力学；各自做专项回归，不作为“顺手项”。
3. **调试证据**：覆盖率热力图加结构化计数；图像不能替代 footprint 覆盖、连接与桥头可达性验证。
4. **V2 校准后续**：回正不对称与音效，在版本化参数和校准回放中对照。
5. **V3**：检查点淡入 UX；保留连续穿越判定与模拟时钟。

模块边界、数据契约、迁移批次和验收见 [CITY_DRIVING_ARCHITECTURE_SPEC.md](CITY_DRIVING_ARCHITECTURE_SPEC.md)。
