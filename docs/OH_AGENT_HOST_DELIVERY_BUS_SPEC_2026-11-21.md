# Oh Agent Host Delivery Bus Spec — 宿主统一身份、投递与预算机制

> 日期：2026-11-21
> 状态：Proposed → 实施中（本文档即实施依据）
> 用户指令：Rust 宿主与其他 desktop agent 的数据通信**用一套机制**，方便维护
> 适用范围：桌面宿主内的所有会话主体——Studio、City WebView、外部 Actor 会话（data-mcp）、未来执行器
> 上游：City SDK V3 Integration RFC（r3）§3.2/§12.2、Actor Adapter Spec、Isolation Spec §8

## 1. 问题：通道碎片化

宿主目前有七条通信通道（Studio 信箱、headless 臂、City WebView 分类器、data-mcp stdio、文件交接、Tauri commands、SQLite pending 行），handler 最终收敛到同一批函数，但三层表达不一致：

1. **身份**：player_id（City 面）/ studio_instance（Creator 面）/ actor_id（Actor 面）/ owner（dispatch_as）——各自独立，无统一模型；
2. **投递**：Studio 信箱（WebView 轮询 state/plugin-calls）、preview-control.json 文件交接、story_outbox 事件行、pending 回合（W7 规划中）——四种"宿主→会话"投递形态；
3. **预算**：Actor 1h 窗口（actors 表）、信箱字节数（per-method）、playtest TTL——语义相似但各自实现。

后果：每加一种会话主体（如 Actor）就要为新面重做一遍身份/投递/预算；隔离测试并行抖动、文件交接与 SQLite 双轨并存，都是碎片化的症状。

## 2. 目标：一套机制 = 一个 Principal 模型 + 一条投递队列 + 一个 wait 原语

### 2.1 PrincipalV1（统一身份）

```ts
interface PrincipalV1 {
  kind: "player" | "actor" | "studio" | "external-session" | "city-webview";
  id: string;            // 各 face 现有 ID 原样（player_id / actor_id / studio_instance…）
  home: string;          // data_home（多宿主隔离）
}
```

- 现有 ID **原样保留**：player_id、actor_id、studio_instance 不改名不改值——Principal 是它们的**统一包装**，不是新 ID 体系；
- 信任与预算按 kind 分派：player 走玩家 Run 权限；actor 走预算闸 + 租约；studio 走任务账本权限；
- 未知 kind fail-closed。

### 2.2 DeliveryV1（统一投递队列）

```sql
CREATE TABLE host_deliveries (
    delivery_id TEXT PRIMARY KEY,        -- 宿主铸造
    principal_kind TEXT NOT NULL,        -- 收件主体 kind
    principal_id TEXT NOT NULL,          -- 收件主体 id（actor_id / studio_instance / player_id）
    kind TEXT NOT NULL,                  -- 投递类型（见 2.3）
    payload_json TEXT NOT NULL,          -- 有界负载（≤16KiB）
    dedupe_key TEXT,                     -- 幂等键（可选）
    status TEXT NOT NULL,                -- pending / delivered / expired
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL       -- TTL 惰性过期（照 expire_runs 模式）
);
CREATE INDEX host_deliveries_inbox ON host_deliveries(principal_kind, principal_id, status, created_at_ms);
```

每个 (principal_kind, principal_id) 收件箱**按需有界**（每主体 pending ≤16）。满箱策略按 kind 定死（2026-11-21 评审 G1，实施前不得留白）：

- `actor.turn`：**一律拒收**——生产动作收到 `host_delivery_backpressure` 错误原样上抛（玩家说话可重试）。承载玩家发言的投递绝不静默丢弃；
- 通知类（`studio.task.update` / `story.beat.ready`）：**丢最旧**——通知可由账本/事件面重新推导，丢弃不损事实。

### 2.3 投递类型（kind 词表，首期）

| kind | 生产者 | 消费者 | 语义 |
|---|---|---|---|
| `actor.turn` | City Runtime（玩家对绑定 NPC 说话/动作时） | 外部 Actor 会话 | 唤醒回合：含触发来源、residentId、bound run 摘要 |
| `studio.task.update` | 任务账本（ST-07 已有 creator_job） | Studio / Agent | 任务状态变化的**推送投影**（账本仍是权威）；认领/提交仍走 pull 面（`creator_task_claim` / `creator_task_submit_result`，2026-11-21 已并 dev）——通知与认领互补，不重叠 |
| `story.beat.ready` | 宿主（因果就绪判定） | Actor 会话 | eligibleBeats 变化推送（每轮拉取的补充） |

首期只实现 `actor.turn`（W7 核心需求）；词表开放注册，新 kind 需登记生产者与消费者契约。

### 2.4 wait 原语（长轮询）

```rust
pub(crate) fn wait(home, principal: &Value, timeout_ms: u64) -> Result<Value, &'static str>
// 阻塞至该主体出现 pending 投递或超时；返回投递数组（≤16，取走即标记 delivered）
```

- 骑在**调用方自己的既有连接**上（data-mcp stdio / City WebView / Studio 信箱）——**零新传输**；
- 超时返回空数组（不挂死）；断线重连后重新 wait 即可（投递行在 SQLite，不丢）；
- **取走即确认的原子性**（评审 G3）：「读 pending + 标记 delivered」必须在同一个 `IMMEDIATE` 事务内完成（照 `claim_pending` 模式）——两个并发 wait 同主体不重复投递；
- 实现限制：等待期间持锁不可接受——用有界轮询循环（200ms 间隔 + 超时上限 30s），不做真正的跨线程唤醒（SQLite 面的既有纪律）。

### 2.5 统一预算（预留面）

首期不合并 Actor 预算与信箱字节预算（语义不同：次数 vs 字节）；只统一**表达**——预算违规错误码与 `next` 恢复建议走同一映射。合并留后续 ADR。

## 2.6 终局关系：统一的是「投递类」，RPC 类不迁移（评审 G2）

`plugin_calls` 信箱的语义是 **request/response（RPC）**——调用方等待某个方法的应答；`host_deliveries` 的语义是**单向投递**——事实通知，无应答。两者是不同语义类，不属于碎片化：本 spec 统一的对象是后者。因此：

- Studio 信箱（RPC 类）**不迁移**，继续承载 creator 方法的调用-应答；
- `host_deliveries` 是「宿主→会话」**投递类**的终局通道：今后新的投递需求一律入队登记 kind，不再新造第四种投递形态；
- `preview-control.json`（Isolation Spec 专用）与 story_outbox 事件的迁移与否，W8 后按同一判据评估。

## 3. 传输面纪律：协议复用、传输分层（维持既有隔离）

| 传输 | 载荷 | 变化 |
|---|---|---|
| data-mcp stdio | MCP tools/call | `creator_actor_turn_wait` 新工具（外部 Actor 会话长轮询） |
| Studio 信箱 / headless 臂 | mailbox call | 不变（Studio 类操作继续走信箱；headless 名单已含 actor 三工具） |
| City WebView | classify_local_call | `city.story.commit` 落库时宿主**内部**投递 actor.turn（不经 WebView） |
| 文件交接 | preview-control.json | **不动**（Isolation Spec 专用，W8 后评估迁移） |

**铁律不变**：Actor 回合不依赖 Studio 在场；玩家侧不经外部会话；信箱预算与投递队列互不接管。

## 4. W7 实施切片（Actor 回合闭环）

| # | 内容 | 文件 |
|---|---|---|
| D-1 | host_deliveries 表 + post/wait/ack + 惰性过期 | host_delivery.rs（新建）+ lib.rs + creator_store 挂接 |
| D-2 | City 说话面挂接：commit_story 命中 residentId 且存在绑定 actor → post(actor.turn) | story_store.rs 最小增量 |
| D-3 | `creator_actor_turn_wait` 工具（外部会话长轮询）| actor_adapter.rs + creator_projects.rs + MCP + plugins.json |
| D-4 | NPC 回复面（已有）：actor intent submit（speak）→ 玩家经 city.story.read / timeline 读到 | 无新增 |
| D-5 | 测试：说话→投递→领取唤醒→intent 提交→confirm→玩家同 Run 可读 全链；TTL 过期；多 actor 隔离；幂等；重排队 | 各文件 tests |
| D-6 ✅ | 回合确认状态机（pending→in_flight→confirmed）+ replyTTL 重排队 + `creator_actor_turn_confirm` 工具 | host_delivery.rs 增量 + MCP 面 |
| D-7 | 玩家同 Run 读取接口（G-READ 缺口）：按 run 作用域读已提交回复（HB-08 前置） | story_store / city_runtime |

## 5. 验收标准

| ID | 场景 | 必须成立 |
|---|---|---|
| HB-01 | 玩家对绑定 NPC 说话 | 投递行落库（principal=绑定 actor，kind=actor.turn） |
| HB-02 | 外部会话领取 | 阻塞至投递出现或超时；领取即 in_flight（并发不重复领取） |
| HB-03 | 多 actor 隔离 | 各收件箱互不可见；未绑定 NPC 的说话不产生投递 |
| HB-04 | TTL | 过期投递惰性回收（照 expire_runs 模式），不复活 |
| HB-05 | Studio 关闭 | wait/headless 全链不受 Studio 在场影响（headless 臂语义） |
| HB-06 | 幂等 | 同 dedupe_key 重放只产生一行；同 delivery_id 重投由 Agent 按 eventId 去重 |
| HB-07 | 回合确认 | Actor 回复绑定同 storyRunId + 触发 eventId 并 commit 成功后回合才 confirmed；**剧情拒绝（accepted:false，如 Run/版本/租约冲突）不得确认回合**；replyTTL 超时未确认 → 重排队（redelivered 标注），不静默丢失 |
| HB-08 | 玩家可见回复 | 玩家经同 Run 读取接口看到 Actor 已提交回复（当前缺口：city.story.read 走 legacy gameId 映射，需新增按 run 作用域的读取面——实施 HB-08 前必须先落地）；**另一个玩家的 Run 不会收到该回复**（turn_context 已按 player/run 作用域隔离，2026-11-21 评审 P1-b 修复） |

## 6. 非目标

- 不做跨机/远程投递（远程经既有 Remote 通道，policy items 7–8）；
- 不做真正的跨线程唤醒（SQLite 面用有界轮询）；
- 不合并 Actor 预算与信箱字节预算（表达统一即可，合并留 ADR）；
- 不迁移 preview-control.json 文件交接与 Studio 信箱的既有工具路由（渐进，Isolation Spec 语义不动）；
- MCP 通知推送（server-initiated）不做——stdio 面用 wait 长轮询替代。

## 7. 与既有 RFC 的关系

- §3.2 执行链的"广播已提交事实"：总线投递是它的**投递面实现**（事实仍在 story_events，投递只发通知不搬事实）；
- §12.2 仲裁：租约仍是公共动作唯一闸门，投递不替代租约；
- Isolation Spec §8：清理路径对投递行同样适用（终态即忘，幂等清理）；
- ST-07 任务账本：`studio.task.update` 投递只是账本的**通知投影**，账本仍是权威。
