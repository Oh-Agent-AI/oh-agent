# Agent City 远程布局一致性 SPEC

**日期：** 2026-11-08  
**状态：** 本地实现中（核心快照链路已接入；真机画面对比与生产部署未完成）
**关联方案：** [Agent City 3D 场景远程控制方案](./AGENT_CITY_REMOTE_3D_PROPOSAL_2026_11_08.md)

## 1. 目标

远程手机页打开时，城市中的建筑、道路、城区和镜头应与桌面端开启远程时的城市布局一致。手机继续使用现有 Agent City 3D 资源和渲染器；桌面继续持有本机城市数据和机甲对局权威。

本 SPEC 采用一次性、对局范围内的布局快照，不要求桌面与手机持续同步城市数据。机甲移动、攻击、技能和回合命令继续通过现有 v1.5 对局通道同步。

## 2. 当前差异来源

当前远程投影包含 `CityModel`、seed 和战场场地信息，手机端创建新的 `CityEngine` 并重新计算城市布局。该过程不等同于复制桌面已经渲染的布局：

1. 远程投影把本地建筑与城区 ID 换成 `building-N`、`district-N` 等临时 ID。布局算法会把城区 ID 用于哈希排布，因此相同 seed 和相同城市统计仍可能得到不同位置。
2. 远程端没有收到桌面当前生效的规划修改、背景楼设置和镜头参数。`CityEngine.applyModel()` 会使用远端引擎的当前选项重新生成布局。
3. `city.snapshot` 在远程会话建立时保存一份副本，手机初始化时读取一次；本地城市后续变化不会自动反映到该快照。

相关实现：`cityDisplayProjection.ts`、`RemoteCityScene.tsx`、`SequentialRemoteHost.ts`、`CityEngine.ts` 和 `cityLayout.ts`。

## 3. 设计决策

### 3.1 同步最终布局，不同步原始 session ID

桌面在开启远程时从当前生效的城市引擎导出一个版本化、脱敏的布局 DTO。DTO 使用本次快照内的临时别名维护实体关联，但布局计算已经在桌面完成，手机不再使用这些别名重新排布，因此别名不承担布局随机种子的作用。

不把本机原始 session ID、资产 ID、路径、日志锚点、成本、finding 或其他未授权字段放入 DTO。

### 3.2 复用现有 3D 渲染器

DTO 保存渲染所需的最终几何与显示字段，不保存 Three.js 对象或 GPU 缓冲区。手机端复用现有城市资产与材质，按 DTO 放置建筑和道路，避免复制一套城市布局算法。

### 3.3 快照具有明确时点

快照对应创建链接时的城市修订。链接期间发生的本地城市变化不隐式传播。需要更新时，由用户显式刷新远程城市快照；该刷新只替换城市显示快照，不重置或覆盖机甲对局状态。

## 4. 数据合同

新增版本化合同 `RemoteCityLayoutSnapshotV1`，由桌面端生成并经宿主验证后随现有 `cityScene` 数据传输。

```ts
type RemoteCityLayoutSnapshotV1 = {
  schema: "remote-city-layout:v1";
  revision: number;
  generatorVersion: number;
  seed: number;
  backdrop: "off" | "auto" | "full";
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fov: number;
  };
  // Current TypeScript DTO also carries the world generator identity and its
  // validated options; old coastal snapshots without these fields remain readable.
  geographyGeneratorId?: "coastal-islands-v1" | "arid-dunes-v1";
  geographyOptions?: Record<string, unknown>;
  biome?: "tropical" | "temperate" | "boreal" | "savanna" | "eastasian" | "arid";
  features?: { coastline: boolean; ocean: boolean; river: boolean; islets: boolean };
  worldProfileKey?: string;
  districts: RemoteDistrict[];
  buildings: RemoteBuilding[];
  roads: RemoteRoad[];
  civics: RemoteCivic[];
  // 必要的岛屿、海岸、桥梁及背景几何参数
};
```

具体字段以当前 renderer 实际需要为准，并遵守以下约束：

- `districts`、`buildings`、`roads`、`civics` 的 ID 均为快照内别名；所有引用只指向别名。
- 建筑展示名称、session 数与 token 用量沿用已授权的展示字段，并与几何实体通过别名关联。
- 建筑位置、地面高度、朝向、占地、外观参数必须取自桌面最终生效布局；不得由手机重新推导。
- 道路和规划修改采用桌面最终生效的可视几何，不能只传未经应用的修复补丁。
- `camera` 从桌面当前城市返回视角导出；它只控制初始视角，手机仍可自行旋转和缩放。
- `generatorVersion` 用于识别基础岛屿或资源布局规则变化。DTO 字段不兼容时递增 schema 版本。
- 新快照须成对携带 `geographyGeneratorId` 与该生成器专属 `geographyOptions`，同时携带 `biome`、生成器能力一致的 `features` 和长度不超过 512 的 `worldProfileKey`。`arid-dunes-v1` 必须使用 `biome: "arid"`、全 false 地理 features，且不携带海岸配置；校验器拒绝未知 options 字段、部分字段和 generator/biome/features 不匹配。仅旧海岸快照可缺省这些参数并走兼容重建。

战棋棋盘场地和单位状态继续使用现有 `RemoteArenaV1` 与 v1.5 对局快照；城市布局 DTO 不成为战斗规则数据源。

## 5. 实施方案

### M0：导出边界

- 在 `CityEngine` 增加只读的远程布局导出入口，导出当前模型、已生效布局、规划结果、背景楼档位、seed 和返回镜头。
- DTO 投影负责 ID 别名化；不得把内部 `CityLayout` 原对象或原始 ID 直接交给 relay。
- 确认远程开始期间不会读取半成品布局；无可用布局时，禁用生成链接并显示明确原因。

### M1：宿主投影与验证

- 将当前 `RemoteCityDisplay` 扩展为包含 `RemoteCityLayoutSnapshotV1` 的新版本合同。
- Rust 网关和 UI 宿主分别校验 schema、版本、数值范围、数组容量、别名引用和允许字段。
- 保留现有 RemoteArena 与对局校验，不扩大 relay 方法白名单或增加城市任意查询能力。

### M2：手机端应用快照

- 远程场景使用桌面快照的最终几何直接构建可视城市。
- 不再对远程模型调用 `layoutCity()` 重新分配建筑位置。
- 首次显示时应用快照中的镜头；手机用户之后的镜头操作只留在手机本地。
- 城市快照刷新只更新 City 画面，不影响当前对局 revision、单位选择或玩家权限。

### M3：尺寸与降级

- 保持当前场景投影 230 KiB、开局数据与场景合计 256 KiB 的上限，不直接放宽 Worker/网关上限。
- 优先用紧凑坐标数组、共享道路点和整型量化减少重复 JSON 字段；不要传输模型网格或纹理。
- 导出前计算序列化大小。超限时拒绝创建/刷新快照并给出可理解提示；禁止静默删楼、删路或切换为重新排布。
- 分片、增量同步或超大城市专用压缩协议不属于本次最小版本；若真实数据超过上限，再单独评估。

## 6. 隐私与授权边界

- 仅在桌面用户明确启动远程对局后生成和发送 DTO。
- DTO 只包含本次远程会话需要显示的城市布局、已授权的会话名称/用量展示字段和当前战场场地。
- 原始 session ID、主机本机 ID、文件路径、日志、提示内容、成本、finding、凭据和任意宿主 IPC 均不进入 DTO。
- 临时别名仅在当前快照内有效，不用于跨对局关联。
- relay 仅在内存中转发 DTO；不持久化城市或对局 payload。停止远程后按现有房间生命周期撤销访问。
- 传输使用 HTTPS/WSS；不宣称端到端加密。

## 7. 验收标准

1. 使用同一桌面快照，在桌面导出结果与手机实际应用结果之间比较规范化几何摘要：建筑、道路、城区和配套设施位置、朝向及占地一致。
2. 手机首次打开时采用桌面导出的镜头位置、目标点和 FOV；之后允许手机独立操作镜头。
3. 对有规划修改、背景楼设置 `off/auto/full` 的场景分别核对远程画面和桌面当前画面。
4. 随机抽样检查原始本机 ID 不出现在 DTO、relay 消息和手机 DOM 中；仅存在快照别名及获准显示字段。
5. 验证快照大小在上限内可创建；超限时清楚失败且不生成布局不一致的远程链接。
6. 验证生成链接、手机查看/操作、显式刷新城市快照、停止远程和桌面恢复流程；城市刷新不重置战斗状态。
7. 截取同一开局、同一时点的桌面与手机画面对比图，并记录 snapshot schema、layout revision、规范化几何摘要和实际 payload 大小。

## 8. 不在本次范围

- 将桌面屏幕编码成视频流或同步鼠标、窗口等任意桌面操作。
- 城市模型的逐帧/后台实时云同步。
- 修改机甲战斗数值、协议规则、回放格式或敌人 AI。
- 放宽 relay 的持久化策略、传输范围或用户数据授权。
- 远程编辑城市布局；手机端只浏览城市，并按现有规则操作当前机甲对局。

## 9. 实施记录（2026-11-08）

- 远程显示合同升级为 `remote-city-display:v2` / `remote-city-layout:v1`。桌面从当前已生效的 `CityLayout` 导出最终几何、背景档位与返回镜头；实体 ID 在快照内替换为别名。
- 远程 `CityEngine` 直接挂载恢复后的布局，不再调用 `layoutCity()` 根据匿名模型重新分配地块。地形高度场从同一 seed 与海岸配置恢复，并按快照最终道路重建桥头地形。
- 原场景 230 KiB、对局与场景合计 256 KiB 上限保持不变；超限时拒绝建链并显示原因，不裁切几何。
- 快照在远程对局创建时固定。显式刷新/运行期间推送城市快照尚未实现；它需要本地对局 WebView 与桌面引擎之间新增一个受限更新通道。本轮先交付一次性对局快照，避免扩展 relay 命令面。
- 本地验证：`npm run typecheck`、`npm run build`、`cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` 均通过。尚未做同场景桌面/手机截图差异验收，也未部署生产 Worker。

