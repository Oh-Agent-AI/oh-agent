# agent-vitals-pet 前置工作计划 — Phase 0a

> 本文档聚焦 Phase 0a（DSH Pet 端到端）开工前必须做的事。每条都是 actionable，不做就不能动 Phase 0a。

---

## 0. 背景

`docs/PET_REQUIREMENTS.md` 已经定下 Phase 0a 的范围（DSH 端到端 Pet 跑通）。本文档回答：**在写第一行 Phase 0a 代码之前，要做什么准备？**

---

## 1. P0 阻塞（4 项，全部必做）

### 1.1 装 Tauri CLI

```bash
cargo install tauri-cli --version "^2.0"
```

**验证**：
```bash
cargo tauri --version
# 期望：tauri-cli 2.x.x
```

**不做的后果**：src-tauri 工程无法创建。

### 1.2 决策 Tauri 主版本（1 还是 2）

| 维度 | Tauri 1 | Tauri 2 |
|---|---|---|
| 现状 | koi-pond / EcoPaste 等参考实现 | petdex 不用；vercel-labs/native 才是新选择 |
| API 文档 | 成熟、参考多 | 新、文档覆盖略薄 |
| IPC | `tauri::command` + `invoke` | 同上，但权限模型改了 |
| 系统托盘 | 内置 | 内置 |
| chromeless floating window | 需手工调 objc | 需手工调 objc（没变）|

**推荐**：**Tauri 2**
- 新项目没理由用 1
- agent-vitals 现在要长期维护，跟新版更省事
- API 差异主要是权限模型，1-2 天能上手

**决策**：Tauri 2（写入 ADR-005 之前确认）

**验证动作**：Tauri 2 跑通最小 hello-world（参考 tauri.app/start/）

### 1.3 决策前端栈

**三个候选**：

| 候选 | 优点 | 代价 |
|---|---|---|
| **A. 纯 HTML/CSS/TypeScript** | 零依赖、打包小、启动快 | 状态管理靠手写 |
| **B. Svelte** | 编译期优化、体积小、Pet 那种简单 UI 友好 | 多一个构建链 |
| **C. React** | 生态成熟 | 体积大（petdex 也嫌大）|

**推荐**：**A. 纯 HTML/CSS/TypeScript**
- Pet UI 只渲染一个 sprite + 状态气泡 + 偶尔的拖动交互
- 框架优势用不上
- 体积最小，对 menu bar app 关键

**决策**：纯 HTML/CSS/TypeScript

**验证动作**：手写一个最小浮窗（chromeless + transparent + 一个 sprite div），跑通「加载 sprite、切帧」

### 1.4 抓一个真实 pet 包

**目的**：Phase 0a 集成测试必须有 sprite 才能验证渲染。

**行动**：
```bash
# 方案 A: 从 Petdex npm 装
npx petdex install boba
# 装到 ~/.petdex/pets/boba/ 和 ~/.codex/pets/boba/

# 方案 B: 直接 curl 下载（如果方案 A 失败）
# Petdex manifest endpoint:
curl https://petdex.dev/api/manifest
# 取一个 slug 的 pet.zip
```

**期望产出**：
```
~/.agent-vitals/pets/boba/
├── pet.json         # { displayName, description, spritesheetPath, spriteVersionNumber }
└── spritesheet.webp # 1536×1872 或 1536×2288
```

**验证**：
```bash
# 1. 文件存在
ls ~/.agent-vitals/pets/boba/

# 2. pet.json schema 合法（用 Phase 0a 写的 schema.rs 验证）
cargo run --bin agent-vitals -- pet validate boba

# 3. spritesheet 尺寸正确（v1 或 v2）
file ~/.agent-vitals/pets/boba/spritesheet.webp
# 或用 Python:
python3 -c "from PIL import Image; im=Image.open('$HOME/.agent-vitals/pets/boba/spritesheet.webp'); print(im.size)"
# 期望: (1536, 1872) 或 (1536, 2288)
```

---

## 2. P1 阻塞（开工前最好定，不阻塞开第一行代码）

### 2.1 EventBus 实现选择

**两个候选**：

| 方案 | 优点 | 代价 |
|---|---|---|
| **`tokio::sync::broadcast`** | async 原生、支持多消费者 | 需要引入 tokio runtime |
| **`crossbeam::channel`** + 手动 fan-out | 同步、性能好 | Tauri 里要转 async，多写一层 |

**推荐**：**`tokio::sync::broadcast`**
- Tauri 本身基于 tokio runtime，零额外引入
- 多个消费者（Pet Tauri、watch CLI、未来 menu bar）天然支持

**决策**：`tokio::sync::broadcast<Event>`

### 2.2 去抖窗口默认值

**两个候选**：

| 窗口 | UX 表现 | CPU |
|---|---|---|
| **100ms** | 状态切换跟手，几乎无延迟 | 高频事件下 IPC 多 |
| **500ms** | 略滞后但稳定，肉眼无感 | 中等 |
| **1s** | 明显滞后 | 低 |

**推荐**：**500ms**
- 用户肉眼难感知 <500ms 延迟
- 抑制"闪动"足够
- IPC 频率降一档

**决策**：默认 500ms，配置项 `PET_DEBOUNCE_MS` env var 可调

### 2.3 Event 时间戳字段

**两个候选**：

| 类型 | 含义 | 影响 |
|---|---|---|
| **`Instant`（单调）** | 进程启动后的相对时间 | 不挂钟、不能持久化为绝对时间 |
| **`SystemTime`（挂钟）** | UTC 真实时间 | 可持久化、跨进程可比 |

**推荐**：**双字段**
- `Instant at: Instant` —— 用于去抖、状态机（相对时间）
- `observed_at: SystemTime` —— 用于持久化、跨调用比对（绝对时间）

**决策**：`observed_at: SystemTime` 作为持久化字段，内存态用 `Instant`

### 2.4 tail offset 持久化策略

**候选**：
- **A. 每次 append 立即写盘** —— 安全，但高频 IO
- **B. 每 N 秒写盘** —— 平衡
- **C. 优雅退出时写盘** —— 简单，但崩溃会丢事件

**推荐**：**B. 每 5 秒写盘**
- 崩溃最多丢 5 秒事件，对 Pet UX 无影响
- IO 频率可接受

**决策**：默认 5s 写盘间隔，配置项 `PET_OFFSET_FLUSH_MS`

### 2.5 EventBus 背压策略

**问题**：广播 channel 默认 buffer 是 1。慢消费者会丢事件。

**推荐**：**buffer 1024 + 慢消费者警告日志**
- 1024 个未消费 Event 占内存可忽略
- 慢到 1024 都堆满的情况极少见（意味着消费者卡死 1s+）
- 这种情况应该日志告警而不是丢事件

**决策**：`broadcast::channel(1024)` + `RecvError::Lagged` 处理

---

## 3. P2 阻塞（Phase 0a 推进中决定也行）

### 3.1 Tauri 浮窗位置 / 拖动策略
- 默认屏幕右上角
- 用户可拖动
- 拖动状态持久化到 `pet-state.json`

**决策时机**：Phase 0a 实现浮窗时

### 3.2 pet 包安装入口
- **CLI**：`agent-vitals pet install <slug>`
- **Tauri 内 UI**：菜单里点 "Install pet from URL"
- **拖拽**：从浏览器拖 .zip 到浮窗

**决策时机**：Phase 0a 末段 / 0b 初

### 3.3 多个 pet 同养
- Phase 0a 只养一只
- 切 pet 是 P2 功能

---

## 4. 样本与 fixture 准备

### 4.1 DSH fixture 复用

**已存在的样本**（无需新建）：
```
fixtures/dsh/
├── complete.jsonl       # 完整 session
├── behavior.jsonl       # 行为审计样本
├── golden.jsonl         # 黄金测试样本
├── build_dsh_behavior_fixture.py  # 生成器
└── build_dsh_session_fixture.py   # 生成器
```

**验证**：Phase 0a 的 `sources/dsh.rs` 直接 wrap `core::dsh::parse_session_log`，用这些 fixture 跑回归。

### 4.2 实时 tail 测试 fixture

**需求**：Phase 0a 要测"中途 append 一行 → tail 立即收到事件"。

**方案**：写一个 `tests/integration_tail.rs`
```rust
#[tokio::test]
async fn tail_receives_appended_event() {
    // 1. 创建临时目录，写一个 fixture.jsonl（5 行）
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("session.jsonl");
    std::fs::write(&file, SAMPLE_5_LINES).unwrap();

    // 2. 启动 DshSource::tail
    let source = DshSource::new(dir.path().to_path_buf());
    let mut stream = source.tail(0);

    // 3. 异步 append 第 6 行
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        writeln!(f, r#"{"type":"tool/call","seq":6,...}"#).unwrap();
    });

    // 4. 收到事件，断言
    let event = timeout(Duration::from_secs(2), stream.next()).await.unwrap().unwrap();
    assert_eq!(event.seq, 6);
}
```

**生成器**：在 `crates/agent-vitals-harness-events/tests/` 下现写。

### 4.3 Pet 包 sprite 测试 fixture

**需求**：Phase 0a 测 sprite 渲染要至少一个真实 .webp。

**来源**：步骤 1.4 抓的 `boba`。

**放置**：`fixtures/pets/boba/` 提交进仓库
```
fixtures/pets/boba/
├── pet.json
└── spritesheet.webp   # 注：webp 二进制不进 git？用 LFS？还是仅文档？
```

**决策**：**.webp 不进 git**，只放 pet.json。CI/开发机自己装。

---

## 5. 依赖添加清单

### 5.1 新增 workspace crate

**修改** `Cargo.toml`：
```toml
[workspace]
members = [
    ".",
    "crates/agent-vitals-core",
    "crates/agent-vitals-wasm",
    "crates/agent-vitals-harness-events",  # ← 新增
]
default-members = [".", "crates/agent-vitals-core", "crates/agent-vitals-harness-events"]
# wasm 仍然不进 default-members
```

### 5.2 crates/agent-vitals-harness-events/Cargo.toml

```toml
[package]
name = "agent-vitals-harness-events"
version = "0.1.0"
edition = "2021"
rust-version = "1.74"
description = "Harness event sourcing for agent-vitals — file watching and JSONL parsing across coding-agent CLIs."

[lib]
name = "agent_vitals_harness_events"
path = "src/lib.rs"

[dependencies]
agent-vitals-core = { path = "../agent-vitals-core" }
serde_json = { version = "1", features = ["preserve_order"] }
# notify: 文件 append 监听
notify = "6"
# tokio: async runtime
tokio = { version = "1", features = ["rt-multi-thread", "macros", "fs", "sync", "time"] }
tokio-stream = "0.1"
async-stream = "0.3"
thiserror = "1"

[dev-dependencies]
tempfile = "3"
```

### 5.3 src-tauri/Cargo.toml（Tauri 2 引入时）

```toml
[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon", "image-png"] }
agent-vitals-core = { path = "../crates/agent-vitals-core" }
agent-vitals-harness-events = { path = "../crates/agent-vitals-harness-events" }
serde = { version = "1", features = ["derive"] }
serde_json = { version = "1", features = ["preserve_order"] }
tokio = { version = "1", features = ["sync", "rt-multi-thread", "macros"] }
```

---

## 6. 文档与决策

### 6.1 ADR 更新
写完 4 个 P0 阻塞的决策后，更新 `docs/PET_REQUIREMENTS.md` 的 ADR：
- **ADR-009**：Tauri 2（不是 1）
- **ADR-010**：前端栈 = 纯 HTML/CSS/TypeScript（不是框架）
- **ADR-011**：EventBus = tokio::broadcast(1024)
- **ADR-012**：去抖窗口默认 500ms
- **ADR-013**：Event 时间戳双字段（observed_at + at）
- **ADR-014**：tail offset 5s 写盘

### 6.2 文件清单

Phase 0a 开工时新建的文件：
```
crates/agent-vitals-harness-events/
├── Cargo.toml
├── src/
│   ├── lib.rs              # EventSource trait
│   ├── tail.rs             # notify 文件监听
│   ├── offset_store.rs     # offset 持久化
│   └── sources/
│       ├── mod.rs
│       └── dsh.rs          # wrap core::dsh
└── tests/
    ├── integration_tail.rs
    └── fixtures/
        └── appended_event.jsonl

crates/agent-vitals-core/src/pet/
├── mod.rs
├── normalize.rs            # Event enum
└── diagnose.rs             # 诊断器

src/watch.rs                # watch dsh 子命令
src/pet.rs                  # pet 相关子命令（install/validate/list）
```

---

## 7. 开工检查清单（执行时打钩）

### 阶段 A：环境准备（半日）
- [x] 装 Tauri CLI（步骤 1.1）—— `cargo install tauri-cli --version "^2.0"` → **tauri-cli 2.11.4**
- [x] 跑通 Tauri 2 hello-world（步骤 1.2 验证）—— tauri-cli 2.11.4 就位；**菜单栏工程脚手架即 hello-world 验证**（2026-08-30 已跑通：`src-tauri/` 托盘 + 弹出面板，`cargo tauri build` 出 .app/.dmg，启动冒烟 6s 存活）
- [x] 抓 `boba` pet 包到 `~/.agent-vitals/pets/boba/`（步骤 1.4）—— 实测 `pet.json` 含 `id` 字段（schema 多出的），`spritesheet.webp` 1536×2288 与 `spriteVersionNumber: 2` 吻合
- [x] 写 ADR-009 / 010 / 011 / 012 / 013 / 014 —— 已进 `PET_REQUIREMENTS.md` §5

> **dmg 打包的环境怪癖**：create-dmg 的 Finder AppleScript 美化步骤在本机
> （无活动 GUI 会话/自动化权限）报 AppleEvent 超时 (-1712)。绕过：手动跑
> `bundle_dmg.sh --skip-jenkins`（跳过 Finder 排版，产物仍含 app + Applications
> 链接），或 `CI=true cargo tauri build` 让 tauri 自动加 `--skip-jenkins`。

### 阶段 B：harness-events crate 起架（1 天）
- [ ] 修改 workspace `Cargo.toml` 加新 crate
- [ ] 新建 `crates/agent-vitals-harness-events/Cargo.toml`
- [ ] 写 `lib.rs`：定义 `EventSource` trait + `Harness` enum
- [ ] 写 `tail.rs`：notify-based 文件监听（offset-based）
- [ ] 写 `offset_store.rs`：5s 持久化
- [ ] 编译通过

### 阶段 C：sources/dsh.rs（1 天）
- [ ] wrap `core::dsh::parse_session_log`
- [ ] 写 fixture 测试（用 `fixtures/dsh/complete.jsonl`）
- [ ] 写实时 append 测试（步骤 4.2）
- [ ] **黄金测试**：跑现有 DSH 黄金，新路径 byte-for-byte 一致

### 阶段 D：core::pet normalize（半天）
- [ ] 写 `crates/agent-vitals-core/src/pet/mod.rs`
- [ ] 写 `Event` enum（双时间戳字段）
- [ ] sources/dsh.rs 把解析结果归一化到 Event

### 阶段 E：watch dsh CLI（半天）
- [ ] 写 `src/watch.rs`
- [ ] 加 `Watch` 子命令到 `src/main.rs`
- [ ] 跑通：手动 append fixture 行，watch 输出 JSON

### 阶段 F：Tauri 浮窗 + Pet 渲染（1.5 天）
- [ ] 装 Tauri CLI（已在前置）
- [ ] `cargo tauri init`（独立 src-tauri 工程，**不入 workspace default-members**）
- [ ] 浮窗配置
- [ ] 写前端：sprite 渲染
- [ ] 接 EventBus → sprite 切帧

### 阶段 G：整合验证（半天）
- [ ] 跑 `tests/test_pet_takeover.py`（symlink 接管）
- [ ] 跑 DSH 黄金回归
- [ ] 肉眼验证：DSH 跑任务，pet 跟着切状态

**总预计**：5-6 天（10 个工作日 / 2 周含 review）