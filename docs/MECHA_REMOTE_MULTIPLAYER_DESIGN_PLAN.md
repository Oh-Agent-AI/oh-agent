# Agent City 远程机甲战与好友对战设计计划

日期：2026-10-31

状态：首版代码已实现，待部署和真实设备验收

范围：手机远程游玩本机机甲战棋；邀请好友进入本机 Agent City 战场进行 1v1 对战

## 0. 首版实施状态

### 通用远程通道改造进度

网络信封现使用 `app-remote:v1`，按应用、会话和能力限制方法及事件；Worker 从已认证连接注入身份，机甲适配器再核对业务身份。Rust 的 HTTPS/WSS 连接、重试和消息收发已抽到 `remote_transport.rs`，请求校验提供 `RemoteAdapter` 入口。桌面有显式受信任适配器注册表，并按应用和能力存放活动会话；合成岛屿能力覆盖通用路由和会话键隔离测试，未注册为生产适配器。机甲业务内部仍使用 `mecha-net:v1`。

**尚未完成通用插件接入：**当前受信任注册表只有机甲；会话值、启动与停止流程、窗口回调和配对逻辑仍由机甲网关实现，通用会话存储不是完整的跨插件生命周期服务，也不支持仅通过描述符自动接入。中继席位目前固定为宿主、房主和一位好友，不能视为通用多人房间。其他插件需要实现受信任的适配器并获得单独的产品和数据出口授权，不能因注册自动开放。真实手机与公网中继的完整链路仍须验收。

**上线前安全缺口：**Rust 启动时仅检查战场和状态的少数字段及大小，并未对嵌套对象执行完整字段白名单投影；当前依赖 City 前端生成受限数据。必须在可信宿主侧实施严格的版本化结构校验与投影，并验证返回消息不包含额外字段，才能把这一数据出口视为可安全部署的边界。

远程功能代码已合入 `feature/mecha`，尚未部署。已实现 `MatchSession`、版本化消息协议、Cloudflare Worker + Durable Object 中继、Rust 出站桥接、独立远程 React/Three.js 页面，以及对称 1v1 规则。

- 权威 TypeScript 运行在桌面创建的独立隐藏 WebView `MatchSession` 中，不是独立 Worker 线程；生命周期不依赖当前 City 标签页。
- 房主链接生成后即可由持链接设备配对，链接秘密放在 URL fragment；首版没有二维码和系统安全存储中的长期设备密钥。
- 好友邀请在 10 分钟内只能绑定一个浏览器会话生成的随机设备秘密；只有同时持有邀请秘密与同一设备秘密才能安全重试，重连只使用设备秘密，不再使用邀请秘密。秘密存于 `sessionStorage`，不是硬件身份认证。登记后仍需桌面批准，且同一时间仅允许一名获批好友。批准前先创建双方满编的新对称 PvP 战局，不延续 PvE 血量、回合或进度。
- 房主、好友通过同一 `app-remote:v1` 网络信封获取完整快照，桌面业务内部使用 `mecha-net:v1`。PvP 使用 `mecha-pvp:v1`，30 个双方回合后按剩余总 HP 裁定，支持全歼、认输和平局。
- 重连通过设备凭证换取一次性 WebSocket ticket；浏览器凭证只存于 `sessionStorage`。撤销、停止远程和房主离线会使远程服务不可用。
- 当前没有云端比赛持久化、房主离线恢复、端到端加密、自动回合计时或生产服务 SLA。TLS 不意味着 Cloudflare 无法读取中继正文。
- 自动化检查覆盖规则、协议、鉴权和中继路由；Cloudflare dry-run 不等于部署，单元测试不等于 iOS Safari/Android Chrome 或完整桌面到真实中继的验收。实际结果在第 14 节持续记录。

## 1. 决策摘要

采用 **桌面权威比赛 + 浏览器客户端 + Cloudflare WebSocket 中继**：

- 电脑保存城市、战场和唯一权威比赛状态，执行回合结算与胜负判定。
- 手机直接渲染机甲战场，本地编辑回合草稿、计算预览，只上传正式回合计划。
- 自己远程游玩和好友对战共用 `MatchSession`、命令协议、快照及断线恢复机制。
- Cloudflare Pages 托管远程网页，Worker 负责认证与接入，Durable Object 按房间路由连接和消息。
- 回合制战棋使用 WSS 即可；视频串流、WebRTC、TURN、SFU 不属于本方案。
- 每回合广播完整比赛快照和战斗事件，不以增量状态作为恢复依据。
- 保留 TypeScript 规则为唯一战斗实现，不新增 Rust 规则副本。
- 远程单机继续使用现有 PvE 规则；好友 PvP 使用单独版本化规则集，不静默改变现有玩法。

一句话数据流：

```text
客户端提交“我计划如何行动” → 电脑校验并结算 → 双方收到同一快照与事件 → 各自渲染和播放动画
```

## 2. 用户场景

### 2.1 自己远程游玩

1. 用户在桌面设置中开启「远程机甲战」。
2. 桌面生成链接和二维码；手机首次打开后完成一次性配对，桌面确认设备。
3. 手机选择可用城市战场，新建或继续一场对 Boss 的比赛。
4. 手机本地规划移动、行动和目标，使用同一套规则预览结果。
5. 用户提交整包计划，电脑结算，手机播放战斗事件。
6. 关闭手机页面不结束比赛；重新进入后可恢复最新状态。

### 2.2 邀请好友对战

1. 房主在自己的 City 中选择战场并创建好友房。
2. 系统生成短时、一次性的邀请链接或二维码。
3. 好友打开链接，房主在桌面确认后加入。
4. 双方各控制一支三台机甲的小队，准备后开始 1v1 对战。
5. 双方只收到本比赛所需战场和状态，不能访问房主的会话、日志、完整 City 投影或其他远程方法。
6. 房主关闭比赛或撤销邀请后，房间和现有连接失效。

### 2.3 在线前提

电脑必须保持 Agent Vitals 运行、联网且不休眠。离线时客户端显示明确状态，不使用合成数据冒充比赛。房主进程退出后，第一版比赛不可继续；云端托管比赛和专用服务器不在本期范围。

## 3. 目标与非目标

### 3.1 目标

- 手机浏览器通过链接远程玩本机机甲战棋。
- 支持邀请一名好友进入房主 City 派生的战场进行 1v1 对战。
- 规则只在权威端结算，拒绝越权、过期、非法和重复命令。
- 手机断线、切换网络或 Cloudflare 连接重建后可以恢复比赛。
- 复用现有规则、回合计划、战斗事件和分阶段动画契约。
- 好友权限严格限于当前比赛，远程投影不包含本地分析数据。
- 同一协议支持本地桌面客户端、房主远程客户端和好友客户端。

### 3.2 非目标

- 驾驶、飞行或其他实时玩法的远程串流。
- 公开匹配、排行榜、积分、锦标赛后反作弊保证。
- 多人观战、超过两名玩家的房间。
- 云端长期保存比赛、房主离线继续比赛。
- WebRTC 视频串流、TURN、SFU 或 Cloudflare Tunnel 暴露整个本地服务。
- 将任意 `plugin_request`、宿主 IPC、SQL、文件或日志能力开放给远程端。

## 4. 现有基础与差距

### 4.1 可复用基础

现有代码已经形成适合联网的单向数据流：

```text
CityEngine → CityMechaSite → MatchState ↔ ArenaPlan
                                  ↓
                       playTurn / previewPlan
                                  ↓
                 TurnEvent + PresentationStages
                                  ↓
                        React HUD + Three.js
```

关键契约：

- `game/mecha/rules.ts`：`playTurn` 在克隆上校验并结算；失败不改原状态，成功返回新状态、日志及分阶段表现。
- `game/mecha/board.ts`：`MatchState` 和 `ArenaPlan` 带 `revision`；拒绝原因包括 `STALE_REVISION`。
- `game/mecha/controller.ts`：草稿编辑、合法格、目标、预览、提交与订阅接口不依赖 React、Three 或 CityEngine。
- `game/mecha/matchFromSite.ts`：城市战场复制到比赛状态，后续 City 更新不暗中改变已开比赛。
- `game/CityMechaWorld.tsx`：表现由视图、战斗提示和演出数据驱动。

### 4.2 必须补齐的差距

- 当前是玩家小队对 Boss，没有双阵营、玩家归属和 PvP 胜负状态。
- Controller 同时持有草稿和权威 MatchState，不能直接作为多客户端网络会话。
- `CityMechaWorld` 依赖完整 `CityEngine`，远程客户端无法仅凭战场快照挂载。
- 现有 `revision` 可检查过期计划，但没有 `matchId/playerId/commandId`、命令去重和会话恢复。
- 当前远程接口、房间、邀请、设备撤销及网络输入校验尚不存在。

## 5. 总体架构

```text
房主手机                  好友手机/浏览器
   │                           │
   └────────── WSS ────────────┘
                  │
                  ▼
       Cloudflare Worker（HTTPS/WSS 入口）
       - 配对/邀请票据交换
       - 房间与连接鉴权
       - 方法、尺寸、频率限制
                  │
                  ▼
       Durable Object（每个房间一个）
       - 桌面与客户端连接配对
       - 在线状态与消息路由
       - 短暂会话元数据
                  │
                  ▼
桌面 Rust RemoteGateway（主动出站 WSS）
       - 桌面身份和设备授权
       - 方法白名单与信封校验
       - 不解释战斗规则
                  │
                  ▼
桌面持久 MatchSession 隐藏 WebView（TypeScript）
       - 玩家、阵营和回合权限
       - commandId 去重与 revision 检查
       - playTurn 唯一权威结算
       - 完整快照、事件和比赛恢复
                  │
                  ▼
本地桌面 Controller / 远程 Controller
       - 各自草稿、选择和预览
       - 不直接修改权威 MatchState
```

远程开启时，桌面创建独立隐藏 WebView 承载 MatchSession；其生命周期不依赖用户正在查看 City 标签页。首版没有独立 Worker 线程；WebView 不可用时远程端明确显示不可用，Rust 不接管规则结算。

## 6. 客户端与权威端职责

### 6.1 客户端

- 选择机甲、编辑移动与行动、撤销本地草稿。
- 使用相同 TypeScript 规则做合法格和受击预览。
- 提交完整 `ArenaPlan`，不上传逐格点击或客户端计算的伤害。
- 根据权威快照更新棋盘，根据事件和 `PresentationStages` 播放动画。
- 保存 `lastRevision`；发现断档时请求完整快照。

客户端预览不是权威结果。提交后即使与预览不同，也以权威端响应为准。

### 6.2 权威 MatchSession

每场比赛只有一个 MatchSession，负责：

- 保存 `matchId`、规则版本、玩家、阵营、战场和完整 MatchState。
- 校验玩家是否属于比赛、是否拥有当前回合权限。
- 校验 `baseRevision` 和完整计划；非法计划原子拒绝。
- 按 `commandId` 去重，重复请求返回首次结果，不再次结算。
- 成功后递增 revision，保存并广播完整快照、日志和表现数据。
- 处理认输、房间关闭和比赛结束。
- 在本机保留活动比赛及必要的已处理命令结果，支持进程内重连。

## 7. 协议设计

### 7.1 版本

- 网络信封：`app-remote:v1`，包含 `appId`、`sessionId`、`capability`，以及请求 ID、方法和业务 payload。
- 机甲会话内部协议：`mecha-net:v1`。
- 现有 PvE 规则：保持当前 `mecha-v1.4`。
- 好友 PvP：新规则集单独命名和评审，不复用 `mecha-v1.4` 名义改变规则。
- 客户端与权威端版本不兼容时拒绝加入并提示更新，不尝试静默兼容。

### 7.2 主要消息

```ts
type SubmitPlan = {
  type: "plan.submit";
  protocol: "mecha-net:v1";
  matchId: string;
  playerId: string;
  commandId: string;
  baseRevision: number;
  plan: ArenaPlan;
};

type TurnResolved = {
  type: "turn.resolved";
  protocol: "mecha-net:v1";
  matchId: string;
  commandId: string;
  revision: number;
  state: MatchState;
  log: TurnEvent[];
  presentationStages: PresentationStages | null;
};

type ResyncRequest = {
  type: "match.resync";
  matchId: string;
  playerId: string;
  lastRevision: number | null;
};
```

另定义 `match.create`、`match.join`、`match.ready`、`match.snapshot`、`match.leave`、`match.concede`、`match.closed` 和结构化错误。具体 schema 在实施前冻结并纳入契约测试。

### 7.3 错误语义

至少包括：

```text
unauthenticated / forbidden / not_your_turn
stale_revision / duplicate_command
invalid_plan / invalid_message / message_too_large
match_not_found / match_finished / room_closed
host_offline / ruleset_mismatch / rate_limited / unavailable
```

错误响应不携带堆栈、路径、原始日志或宿主错误正文。

### 7.4 同步策略

- 每回合发送完整 MatchState，避免回合制小数据场景引入增量修复复杂度。
- `TurnEvent[]` 用于事件语义，`PresentationStages` 用于一致的阶段动画。
- 客户端不以收到事件的数量推断权威状态；状态只以最新完整快照为准。
- 动画播放不阻塞权威比赛状态保存；是否允许下一回合由阶段和权限决定。
- 对迟到、重复和乱序消息按 matchId、commandId、revision 处理。

## 8. PvP 规则扩展

PvP 与现有 PvE 分开演进，建议首个版本：

- 双方各三台机甲，单位 ID 包含阵营，不能继续只用一组全局 `MechId` 标识双方。
- 轮流提交整队计划，每方在自己的计划阶段编辑草稿。
- 保留同方三台机甲同时移动、统一校验和规范结算顺序的语义。
- 目标校验覆盖双方机甲及 PvP 目标，不再默认 Boss/raiders。
- 结果至少包含胜方、全歼、认输、达到回合上限后的裁定或平局。
- 城市战场使用公平出生区；优先对称部署，非对称地图需交换阵营再赛或经过专门评审。
- 回合时限、断线计时和是否允许暂停属于 PvP 规则评审项，未决定前不加入自动判负。

建议状态：

```text
waiting → ready → side_a_plan → resolving → side_b_plan → resolving → ... → finished
```

具体数值、地图平衡和胜负规则必须在 PvP 玩法契约中单独冻结，本计划不擅自修改现有机甲数值。

## 9. 远程战场与隐私投影

远程端只接收 `RemoteArenaV1`：规则版本、战场指纹、地形、高度、道路、障碍、建筑比赛 ID、渲染所需几何、出生区和部署信息。

不得包含：

- 会话标题、用户输入摘录、Token 明细、模型和费用。
- 原生会话 ID、数据库主键、日志路径、工作目录和原始事件锚点。
- 完整 City 投影、完整提示词、原始 JSONL 和宿主导航能力。

建筑只使用比赛内不透明 ID。好友看到的是受邀战场，不等于获得本机 City 数据访问权。

这是新的网络 serving face。实施前必须明确修订当前“不上传用户数据”的产品边界：仅在用户主动开启或邀请后，把受限战场与比赛投影传输到授权设备；Cloudflare 不持久保存城市或比赛正文。相应政策、文档和出口测试需同步更新。

## 10. 配对、邀请与安全

### 10.1 房主设备配对

- 默认关闭远程功能，由桌面用户主动开启。
- 配对链接短期有效且只能使用一次；秘密放在 URL fragment，避免进入 HTTP 访问日志。
- 手机通过 HTTPS 交换会话，再获取一次性 WebSocket 接入票据。
- 桌面显示设备名称并完成确认；支持单独撤销和全部断开。
- 长期密钥只放系统安全存储；浏览器长期令牌不放在链接中。

### 10.2 好友邀请

- 邀请绑定 `roomId/matchId`，短时有效、一次性兑换。
- 好友加入仍需房主批准；批准只授予当前比赛权限。
- 重连令牌可轮换，撤销后不能重新加入。
- 房间链接不是永久密码，也不能访问房主设备管理接口。

### 10.3 服务边界

- Worker、Rust 和 MatchSession 分别验证自己负责的字段，不信任上游自报身份。
- WebSocket 鉴权通过一次性票据，不依赖浏览器自定义 Header。
- 限制消息大小、计划单位数、字符串长度、创建房间频率和命令频率。
- 远程方法使用独立白名单，不转发任意宿主 IPC。
- Cloudflare 日志不得记录配对秘密、邀请秘密、令牌或比赛正文。
- TLS 保护传输；若要求 Cloudflare 无法读取比赛正文，再增加端到端加密，不把它作为首版隐含的已实现保证。

## 11. Cloudflare 设计

### 11.1 组件

- Pages/静态资产：远程 React/Three.js 客户端、机甲模型和版本信息。
- Worker：HTTPS API、WebSocket Upgrade、鉴权、限流和 Durable Object 路由。
- Durable Object：按 `deviceId` 或 `roomId` 建实例，保存短暂连接元数据并转发消息。
- WebSocket Hibernation：空闲时降低持续时间消耗；休眠后从 attachment 恢复最小连接信息。

### 11.2 免费额度适配

回合提交、快照和在线心跳属于低频消息，适合个人免费原型。不得用 Worker WebSocket 转发视频或同步逐帧相机。静态资源与消息版本应缓存友好；心跳使用协议自动响应或低频应用消息，避免无意义唤醒。

免费额度耗尽会导致服务失败，客户端必须显示不可用并支持恢复，不能承诺免费方案具备生产 SLA。Cloudflare 的账户、认证和反作弊能力不会因使用中继自动获得。

## 12. 手机交互

- 竖屏可完成全部回合操作；城市欣赏可横屏，非首版硬性要求。
- 单指旋转、双指缩放和平移、点击格子选择或移动。
- 底部面板显示选中机甲、行动、目标、受击预测和提交按钮。
- 提交前显示整包计划摘要；提交后显示等待权威确认。
- 使用省电画质、限制像素密度，后台暂停渲染但不丢弃比赛会话。
- 所有操作不依赖 hover；点击区域至少 44×44px，适配安全区。
- WebGL 不可用时提供可读棋盘和状态列表，不伪造 3D 成功。

## 13. 实施计划

以下人日仅用于排期讨论，不是承诺工期。

| 阶段 | 内容 | 产出与验收 | 粗估 |
| --- | --- | --- | --- |
| P0 决策与契约 | 隐私出口评审；冻结 RemoteArena、消息信封、错误码和 PvP 规则决策项 | 可评审 schema；明确哪些数据允许离机；不改现有 PvE 规则 | 1–2 人日 |
| P1 权威会话拆分 | 新建 MatchSession；拆分草稿 Controller 与权威状态；保留本地适配器 | 现有本地玩法行为不变；规则单测和层级守卫通过 | 3–5 人日 |
| P2 远程单机 | Worker/DO、Rust 出站连接、房主配对、远程快照和 plan.submit | 手机远程完成一场现有对 Boss 比赛；重复命令不重复结算 | 4–6 人日 |
| P3 远程渲染与移动体验 | 解除战场视图对完整 CityEngine 的依赖；手机布局、重连和离线状态 | iOS Safari/Android Chrome 可操作；切网后恢复同一 revision | 3–5 人日 |
| P4 好友房与 PvP | 邀请、批准、双阵营、回合权限、PvP 结果和公平出生区 | 两名真实客户端完成 1v1；越权/越回合提交被拒 | 5–8 人日 |
| P5 加固与发布 | 限流、撤销、休眠恢复、故障注入、隐私扫描和真机验收 | 安全与异常矩阵通过；文档、政策和发布开关完整 | 3–4 人日 |

P2/P3 可有部分并行，但远程渲染不能通过虚构战场数据绕过真实快照验收。

## 14. 测试与验收矩阵

### 14.1 规则与协议

- 现有机甲规则、表现和分层守卫全部保持通过。
- 同一 `commandId` 重试多次只推进一次 revision。
- 过期 revision、非当前玩家、伪造 playerId、非法计划均原子拒绝。
- 双方收到相同快照和事件；旧快照不能覆盖新快照。
- 断线重连返回完整状态；休眠后的 Durable Object 不丢失路由所需最小元数据。
- 不兼容协议或规则版本明确拒绝。

### 14.2 权限与隐私

- 未配对、过期邀请、已撤销设备和非房员均无法读取快照或提交命令。
- 好友不能调用设备管理、宿主导航、任意 `plugin_request` 或其他 matchId。
- RemoteArena 契约扫描不包含会话文本、路径、原生 ID、Token 和费用字段。
- 日志和 URL 查询参数不泄露长期令牌或配对秘密。

### 14.3 真实端到端

- 桌面 → Cloudflare → iOS Safari 完成远程 PvE 回合。
- 桌面 + 两个独立浏览器完成好友 PvP 整场比赛。
- Wi-Fi/蜂窝切换、锁屏恢复、Cloudflare 重连和桌面短暂断网后状态一致。
- 桌面睡眠、退出、MatchSession 崩溃时显示不可用，不回退到 fixture。
- 重复进入和退出比赛不累积连接、Worker、渲染资源或模式 lease。

实施阶段按改动范围运行 City typecheck、`verify:mecha`、桌面 Rust 测试及相关构建；不能用纯单元测试替代上述真实链路。

### 14.4 首版本地验收记录（2026-10-31）

- `verify:mecha` 的 165 项检查通过，包含 PvP、网络协议和原有机甲回归；远程 UI typecheck/build、relay typecheck/7 项测试、Rust `remote_gateway` 3 项测试与 desktop clippy 均单独运行。
- 本地 Wrangler 运行真实 Worker 和 Durable Object，测试权威 `MatchSession` 通过实际 WebSocket 完成邀请批准、双方相同 PvP 快照、回合鉴权、命令去重、重连、认输及撤销。
- 两个独立 iPhone 14 Pro 模拟浏览器页面使用真实本地中继和同一测试权威会话，完成双方整队 skip 的交替提交；双方同步到相同 revision。好友认输后双方均显示 A 获胜及结束状态；房主刷新后使用 `sessionStorage` 凭证恢复到该结束状态。
- 上述结果不是 Cloudflare 生产部署、物理 iOS/Android 真机或完整桌面 `.app` 验收。Wi-Fi/蜂窝切换、锁屏、真实网络中断、完整桌面控制面板链路和生产环境仍待验收。
- 通用协议改造后的本地检查：桌面 Rust 202 项测试和 clippy 通过；City typecheck、170 项机甲测试和 UI 构建通过，包含会话握手 token 测试。真实本地 Worker 的跨应用路由和 WebSocket 验证通过，但尚未用 Rust 桌面客户端贯通此链路。

## 15. 后续演进

- 观战、比赛回放、更多玩家和合作对 Boss。
- 独立权威服务、云端活动比赛和房主离线恢复。
- 陌生玩家匹配、排行榜和更强反作弊。
- 驾驶/飞行的 WebRTC 输入、预测和视频串流，作为独立技术方案评审。

## 16. 参考

- 现有架构：`MECHA_CITY_FIGHT_ARCHITECTURE_SPEC.md`
- 本地数据边界：`CITY_LOCAL_DATA_PROJECTION.md`
- Kimi Code Remote Control：https://www.kimi.com/code/docs/en/kimi-code-cli/guides/remote-control.html
- Cloudflare Workers 定价：https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Durable Objects WebSocket：https://developers.cloudflare.com/durable-objects/best-practices/websockets/
