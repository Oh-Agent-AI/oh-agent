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

每个 (principal_kind, principal_id) 收件箱**按需有界**（每主体 pending ≤16，超出拒收或丢最旧按 kind 定义）。

### 2.3 投递类型（kind 词表，首期）

| kind | 生产者 | 消费者 | 语义 |
|---|---|---|---|
| `actor.turn` | City Runtime（玩家对绑定 NPC 说话/动作时） | 外部 Actor 会话 | 唤醒回合：含触发来源、residentId、bound run 摘要 |
| `studio.task.update` | 任务账本（ST-07 已有 creator_job） | Studio / Agent | 任务状态变化通知（先投影，账本仍是权威） |
| `story.beat.ready` | 宿主（因果就绪判定） | Actor 会话 | eligibleBeats 变化推送（每轮拉取的补充） |

首期只实现 `actor.turn`（W7 核心需求）；词表开放注册，新 kind 需登记生产者与消费者契约。

### 2.4 wait 原语（长轮询）

```rust
pub(crate) fn wait(home, principal: &Value, timeout_ms: u64) -> Result<Value, &'static str>
// 阻塞至该主体出现 pending 投递或超时；返回投递数组（≤16，取走即标记 delivered）
```

- 骑在**调用方自己的既有连接**上（data-mcp stdio / City WebView / Studio 信箱）——**零新传输**；
- 超时返回空数组（不挂死）；断线重连后重新 wait 即可（投递行在 SQLite，不丢）；
- 实现限制：等待期间持锁不可接受——用有界轮询循环（200ms 间隔 + 超时上限 30s），不做真正的跨线程唤醒（SQLite 面的既有纪律）。

### 2.5 统一预算（预留面）

首期不合并 Actor 预算与信箱字节预算（语义不同：次数 vs 字节）；只统一**表达**——预算违规错误码与 `next` 恢复建议走同一映射。合并留后续 ADR。

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
| D-5 | 测试：说话→投递→wait 唤醒→intent 提交→timeline 可读 全链；TTL 过期；多 actor 隔离；幂等 | 各文件 tests |

## 5. 验收标准

| ID | 场景 | 必须成立 |
|---|---|---|
| HB-01 | 玩家对绑定 NPC 说话 | 投递行落库（principal=绑定 actor，kind=actor.turn） |
| HB-02 | 外部会话 wait | 阻塞至投递出现或超时；取走即 delivered（不重复投递） |
| HB-03 | 多 actor 隔离 | 各收件箱互不可见；未绑定 NPC 的说话不产生投递 |
| HB-04 | TTL | 过期投递惰性回收（照 expire_runs 模式），不复活 |
| HB-05 | Studio 关闭 | wait/headless 全链不受 Studio 在场影响（headless 臂语义） |
| HB-06 | 幂等 | 同 dedupe_key 重放只产生一行 |

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
