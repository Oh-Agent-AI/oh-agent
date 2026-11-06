# DSH 执行环境评估：它和其他执行环境的五处结构性不同

> 日期：2026-09-08
> 语料：本机实测 `~/.dsh/`（1.9 GB，59 会话）。
> 定位：DSH 是**核心产品线执行环境**，不是参考类（spec §2.5.4 已更正）。
>
> 本文只写 DSH 与其他执行环境**结构上不同**的部分；共有的会话/用量面见
> `RUNTIME_EVIDENCE_CONTRACT` §13。

## 0. 一句话

**DSH 是唯一一个我们「跑在里面」的执行环境。** 其余四个核心执行环境（claude-code /
codex / pi / cline）我们都是**事后读它们的日志**；DSH 里 agent-vitals 是注册在
`dsh.profile.bundles` 的两个一等 bundle，与 `@deepseek-ai/dsh-base` 并列。

这带来一个 v0.10 的独有机会和一个当前就存在的故障。

---

## 1. 五处结构性不同

### 1.1 我们是它的插件，不是它的读者（**唯一**）

`~/.dsh/profiles/web/package.json`：

```jsonc
"dependencies": {
  "dsh-skill-vitals":       "file:/Users/Admin/projects/project/skill-vitals/dsh",
  "dsh-skill-vitals-audit": "link:/Users/Admin/projects/project/skill-vitals/dsh-client"
},
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
  "dsh-skill-vitals", "dsh-skill-vitals-audit",   // ← 我们
  "@liustack/modlens", "dsh-free-search", "dsh-playwright-browser"
] } }
```

profile 是 cordis 插件树（`cordis.yml` 是空 `[]` 根，实际由 bundles 逐层 patch 组合）。
**后果**：v0.10 的 Issues / Savings 可以直接在 DSH 内呈现，不必只活在 Tauri 工作台里
——这是其他四个执行环境都没有的分发通道。

### 1.2 它把投影物化到磁盘，代价是 **26×**（**唯一，且是反面教材**）

| 路径 | 大小 |
|---|---|
| `sessions/`（**权威源**，59 个 `session.jsonl.zstd`） | **67 MB** |
| `storages/session_projcache/`（58 个 JSON） | **1.4 GB** |
| `storages/session_projcache.json`（**单文件**） | **362 MB** |
| 合计投影 | **1.76 GB** |

**投影 / 权威源 ≈ 26×。** 单会话投影缓存最大 **183 MB**
（`session-e4b0be69-….json`、`session-284f3cc3-….json` 各 183 MB）。

> **对 v0.10 §10.3 的直接后果**：本 spec 规定派生数据**不入 schema**、走「现算 +
> 60s memo + `Arc`」。DSH 自己的插件走了另一条路（物化到盘），实测代价 26×。
> 而 2026-09-05 的工作台 tab 卡顿事故起因是「锁内深拷贝**几 MB** JSON」——
> 183 MB 是那个量级的 **30 倍以上**。
> **结论：v0.10 的 TraceGraph 既不得物化到盘，命中路径也必须是 `Arc` 不得深拷贝。**
> DSH 就是这条规则的实证依据，不是假设。

### 1.3 压缩增量式会话存储（**唯一**）

`sessions/<encoded-cwd>/<session-id>/session.jsonl.zstd` —— **多帧 zstd 逐事件追加**，
59 个文件全部压缩。其他四个核心执行环境：claude-code / pi / cline 是明文 JSON(L)，
codex 是明文 JSONL。DSH 是唯一需要解压才能读的（`ruzstd` 决策 2026-08-30）。

`<encoded-cwd>` 编码与 claude-code / pi 同形状。

### 1.4 唯一有 `StepBoundaries` 的执行环境

按 `RUNTIME_EVIDENCE_CONTRACT` §13：DSH `StepBoundaries = measured`；
Codex/WorkBuddy `unavailable`，Claude Code `derived`。
turn **与** step 双层粒度只有它有——`TRAJECTORY_TIMELINE_SPEC` §3.3 的粒度层
在 DSH 上是唯一四层齐全的。

### 1.5 唯一实现了 SV-COST 浪费族的执行环境

`crates/agent-vitals-harnesses/src/harnesses/dsh/sessions/waste.rs` ↔
`agent_vitals/agent/waste.py`（字节 parity，wasm 导出 `structural_waste`）。
SV-COST-01（重复相同结果）/ SV-COST-02（失败重试上下文增长）**只在 DSH 下跑**。

> **这条决定了 §2.4.5 的优先级**：整个 v0.10 Savings 的浪费输入目前依赖单一执行环境。
> DSH 留在核心产品线里，让「waste 规则跨执行环境化」保持为**优化项**而非阻塞项——
> 但四个核心执行环境里三个（claude-code/codex/pi/cline）拿不到浪费族，Savings 页面在
> 它们上面会是空的。跨执行环境化仍应排进 v0.10-B。

### 1.6 附：显式的工作区/会话索引

`storages/workspace.json`（`unit.version = 2`）带 `workspaceIds` /
`archivedSessionIds` / `tables.workspaces[].{path, title, sessionIds, createdAt,
updatedAt}`。**归档会话是显式标记的**——其他执行环境要靠扫目录推断。

---

## 2. 故障与修复（**已于 2026-09-08 修复并验证**）

> **修复结果**：`~/.dsh/profiles/web/package.json` 已改为新包名 + `integrations/`
> 新路径，**两个 bundle 都改用 `link:`**（原 `dsh` 用 `file:` 会复制并僵化，正是
> 「1.3.0 有两份不同内容」的根因）；三处残留（旧 `file:` 副本、两条死 symlink）已清；
> `pnpm install` 重装通过。验证：两个 bundle 均可解析、包名/版本/入口/`cordis.patch.yml`
> 齐全、客户端产物（`lib/client.cjs` 222 KB · wasm 2.1 MB · `pricing.json`）就位、
> 无残留死链；插件自带的 `verify.mjs` / `verify-harness.mjs` / `verify-timeline.mjs`
> 三套断言全部通过。备份在 `package.json.bak-20260908-dshfix`。
>
> §2.2 第 2 条（版本↔内容守卫）**仍未做**——那是仓库侧的 CI 工作，不是本次安装修复。

### 2.0 修复前的故障（存档）

Phase E1 把 `dsh/` → `integrations/dsh/`、`dsh-client/` → `integrations/dsh-client/`，
但**已安装的 profile 仍指向旧路径**：

```
~/.dsh/profiles/web/node_modules/
  dsh-skill-vitals-audit  -> ../../../../projects/project/skill-vitals/dsh-client   ✗ 死链
  dsh-agent-vitals-audit  -> .dsh-module-fallback/node_modules/dsh-agent-vitals-audit
                             └─> /Users/Admin/projects/project/skill-vitals/dsh-client ✗ 也是死链
  dsh-skill-vitals/       (真实目录副本，非链接，2026-08-18 冻结)
```

**两条路径都解析不到**（`skill-vitals/dsh-client` 已不存在）→ **审计 tab 在这台机器上
当前是坏的**。

### 2.1 安装态在三个轴上同时陈旧

| 轴 | 已安装 | 仓库现状 |
|---|---|---|
| **包名** | `dsh-skill-vitals` / `dsh-skill-vitals-audit` | `dsh-agent-vitals` / `dsh-agent-vitals-audit` |
| **路径** | `skill-vitals/dsh` · `skill-vitals/dsh-client` | `integrations/dsh` · `integrations/dsh-client` |
| **内容** | `index.js` 与仓库**不同** | — |
| **版本号** | `dsh-skill-vitals` **1.3.0** | `dsh-agent-vitals` **1.3.0** ← **同版本号、不同内容** |

最后一行值得单独记：**版本号没随内容变更递增**。本仓库在 `pricing.json` 三副本、
wasm↔CLI 等处都用锁步测试防漂移，但**插件安装态没有任何守卫**——它是靠人记得重装。

### 2.2 建议

1. **修复安装**：`~/.dsh/profiles/web/package.json` 的 `dependencies` 与
   `dsh.profile.bundles` 改成新包名 + `integrations/` 新路径，重装 profile。
2. **加一条守卫**：`integrations/dsh/package.json` 的 `version` 变更与 `index.js`
   内容变更绑定（同 PR 同改），或在 CI 里断言「已发布版本号对应的内容哈希」。
   现状是 1.3.0 有两份不同内容，这正是本仓库其他地方用锁步测试消灭掉的形态。
3. 清理遗留的 `.dsh-module-fallback` 死链与旧名 `dsh-agent-vitals-audit` 软链。

---

## 3. 三层参与度

| 层 | DSH | 说明 |
|---|---|---|
| **T1 账单级** | ✅ | 已在 `FACT_HARNESSES`，成本走 `pricing.json` 的 deepseek 卡 |
| **T2 证据级** | ✅ **最强** | 唯一四层粒度齐全（turn + step + subagent + task），唯一有 SV-COST |
| **T3 事实级** | ✅ | `harnesses/dsh/sources/usage_fact.rs` 已落地 |

**外加第四层，只有 DSH 有**：**T4 —— 在执行环境内呈现**。v0.10 的 Issues / Savings
可以经既有 dual-face 插件直接进 DSH 的「审计」tab，无需用户切到 Tauri 工作台。
（前提是先修 §2 的安装故障。）

---

## 4. 对 v0.10 spec 的三条输入

| # | 内容 | 落点 |
|---|---|---|
| 1 | **26× 投影放大 + 183 MB 单会话投影**是「派生数据不物化、命中走 Arc」的实证依据，不是假设 | §10.3 / §7 门槛 4 |
| 2 | **T4「执行环境内呈现」是 DSH 独有的分发通道**——v0.10 的 Issues/Savings 不必只活在 Tauri 里 | §5 / §2.5.2 |
| 3 | SV-COST 只在 DSH，四个核心执行环境里另三个 Savings 会是空的 → **waste 跨执行环境化排进 v0.10-B** | §2.4.5 |

> `~/.dsh/.credentials.yaml` 是凭证，审计面永不读取。
> 未展开（不得据此报 unavailable）：`settings.yaml` · `profiles/headless/` ·
> `.anonymous-user-id`。
