# R2a initial population 子阶段 · per-source capability 表

> 状态：调研文档（只读，2026-08-30）。为 `docs/TAURI_RUNTIME_WORKBENCH_SPEC.md`
> §8 R2a 的 initial population 子阶段服务。所有数字来自本机真实语料实测（命令与
> 路径均可复现，见 §6）；「推断」字样表示无直接实测、基于代码/既有结论的推论。
>
> 结论先行：
> 1. **Codex 是 R2a 的首个可信源**——55 会话 / 544.4MB 明文 JSONL，Python+Rust
>    adapter 已全量支持（live + archived + session_index 三件套），0 损坏、0 降级。
>    首次全量扫（读 + 解析 + 证据派生）Python 实测 ~75s；roots 发现（stat-only）
>    1ms。
> 2. **DSH 是第二大源，但当前 Python/Rust 读适配器一个文件都读不了**——本机全部
>    58 份会话都是 `.jsonl.zstd`，而 `dsh.py`/`dsh.rs` 只认裸文本 `.jsonl`
>    （对 `.zstd` 路径实测降级为 `non-json`）。多帧 zstd 解压只在
>    `scripts/dsh_autosync.py`（Python state 写者）与 `dsh-client/src/harness/index.ts`
>    （Node 执行环境插件）里存在，**Rust 二进制/核心 crate 没有 zstd 依赖**。R2a 若
>    要让 DSH 进 initial population，必须先给 Rust 侧补多帧 zstd 读取。
> 3. **「zstd 日志并不天然适合简单 offset tail」被实测坐实**：58/58 份都是多帧
>    zstd，单帧解压只出 15.5KB（丢 ~99.99%）；对压缩文件尾部 2MB 做 naive tail
>    直接报 frame header 错误。
> 4. **记忆文件里「Codex 漏读 archived_sessions / session_index」已被修复**
>    （commit `f35f377`/`2f860ec`），不是当前差距。真差距是：DSH zstd 读取、
>    DSH 根目录发现（adapter 只有 env 单文件注入）、以及 §4.3 的 machine
>    namespace（两源都还没派生）。

---

## 1. 实测语料

### 1.1 Codex（`~/.codex/sessions`）

| 项 | 实测值 | 数据来源 |
|---|---|---|
| 根路径 | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`（live）+ `~/.codex/archived_sessions/`（archived，本机不存在）+ `~/.codex/session_index.jsonl`（标题索引） | `ls ~/.codex/`；`codex_session.py::CODEX_SESSION_ROOTS` |
| rollout 文件数 | 55（2026-07：11，2026-08：44；全部在 `YYYY/MM/DD/` 第 4 层） | `find ~/.codex/sessions -name 'rollout-*.jsonl'` |
| 字节总量 | 544.4MB；min 78KB，max **210.6MB**，mean 9.9MB，median 1.19MB；分布 <100KB:4 / 100K–1M:20 / 1M–10M:18 / ≥10M:13 | 实测 stat 汇总 |
| 格式占比 | legacy **46** / paginated **9**（按 `session_meta.payload.history_mode`） | 逐文件解析实测 |
| cli_version 映射 | legacy = 0.146.x（7+4）、0.147.x（23+11）；paginated = 0.149.x（4+2）、0.150.x（1）、0.151.x（3） | 逐文件实测 top 8 |
| 损坏/不可读 | **0**：55/55 都解析出 `session_meta`，0 条 `non-json`/`missing-header`/`file-missing` | 逐文件解析实测 |
| 每事件包络 | `{timestamp, type, payload}`——**每条事件都带 ISO 时间戳**（revision 信号） | 实测首条 item keys |
| 逻辑会话 | 28/55（51%）文件名 UUID ≠ `session_meta.payload.session_id`（续接会话写新文件、保留原逻辑 id）；adapter 按 §14.4 优先取 `session_id` | 实测比对 |
| 标题覆盖 | `session_index.jsonl` 当前 22 条有效；48/55（87%）的 `session_id` 命中索引 | `read_session_index` 实测 |
| 全量读时间 | roots 发现（stat）1ms；读 + 解析 55 文件 **37.2s**（per-file median 78ms / p90 1.6s / max 14.4s）；+ 证据派生（build_codex_evidence）**37.9s** → 一轮全量 ~75s（**Python**，Rust 应更快） | `time` 实测 |

### 1.2 DSH（`~/.dsh/sessions`）

| 项 | 实测值 | 数据来源 |
|---|---|---|
| 根路径 | `$DSH_HOME/sessions/<project-slug>/<session-id>/session.jsonl[.zstd]`；本机 `$DSH_HOME` 未设 → `~/.dsh/sessions`（与 `dsh-client/src/harness/index.ts::sessionsRoot` 同默认） | `echo $DSH_HOME`；`ls ~/.dsh/` |
| 会话文件数 | 58 个 `session.jsonl.zstd`，跨 4 个 project：skill-vitals 32 / investment-research-team 20 / deepseek-harness 3 / dsh-article 3；**0 个裸 `.jsonl`** | `find ~/.dsh/sessions -name 'session.jsonl*'` |
| 压缩 | 70.0MB → **215.8MB** 明文，ratio **3.1x**；min 399B / max 8.9MB | `zstandard` 解压实测 |
| 行数 | 224,958 行（明文） | 解压后逐行实测 |
| 多帧结构 | **58/58 全部是多帧 zstd**；单帧解压（`decompress()` 不带 `read_across_frames`）只出 15.5KB 总和（即丢 ~99.99%） | 实测逐文件数 frame magic |
| offset tail | 对最大文件（8.9MB）尾部 2MB 做 naive 解压 → `error determining content size from frame header` | 实测 |
| 全量读时间 | 解压 0.4s；解压 + `read_session_log` 解析 **18.2s**（per-file median 167ms / p90 875ms / max 1.97s）；0 降级 | `time` 实测 |
| 覆盖产出 | 25,510 条 execution_events、10,894 条 usage_events | 逐文件 `read_session_log` 实测汇总 |
| 头行 | `{type:"session", version:0, id:"session-<uuid>", cwd, createdAt, delegationDepth, agentPreset}`；**目录名 == header `id`（全部 58 份一致）** | 逐文件实测 |
| seq | 单调不减；样本会话 first=0 / last=16201（带 seq 的事件 341 条） | 样本实测 |
| 当前 adapter 对 `.zstd` | `read_session_log("<...>/session.jsonl.zstd")` → `degraded="non-json"`（把 zstd 原始字节当 UTF-8 读） | 实测 |

---

## 2. Per-source capability 表

| 维度 | Codex | DSH |
|---|---|---|
| 根发现路径 | `~/.codex/sessions/YYYY/MM/DD/`（`rglob("rollout-*.jsonl")`）+ `~/.codex/archived_sessions/`；**adapter 已实现** `codex_session_roots_report`（Python+Rust 锁步） | `$DSH_HOME/sessions/*/*/session.jsonl[.zstd]`；**adapter 只有 env 单文件注入**（`AGENT_VITALS_DSH_SESSION_LOG`），根发现只存在于 `dsh_autosync.py`/Node 执行环境 |
| 支持格式 | 明文 append-only JSONL（无版本闸，按 §14.4 靠兼容 shim 演进） | 裸文本 `.jsonl`（`dsh.rs`/`dsh.py` 仅此）；`.zstd` 多帧**只有 `dsh_autosync.py`(Python) 和 `dsh-client`(Node) 能解** |
| 是否全量读 | 是（adapter 按文件读全文，然后 core 折叠） | 是（当前只能全量；多帧 zstd 不支持增量 tail） |
| 无权限/损坏行为 | 存在性探测：根缺席 → `exists=false` 零填充；空文件 → `missing-header`；坏行 → `non-json`；不可读 → `file-missing`；未知记录类型**保留进 items**（判损坏是 core 的事，进 `attempts`） | 同上（另多一个 `schema-version-mismatch`，`version` 必须整数 0，bool 被显式排除）；对 `.zstd` 路径目前**误判为 `non-json`**（不诚实——不是日志坏了，是 reader 不支持） |
| coverage（实测一轮） | 55 会话；signals 见 §3；0 attempts、0 降级 | 58 会话；25,510 exec + 10,894 usage 事件；0 降级 |
| 资源上限估计 | 544.4MB / 60,947 items；Python 全量 ~75s，Rust 更快；**单文件最坏 210.6MB（p90 1.6s）** | 215.8MB 明文 / 224,958 行；解压 + 解析 18.2s |
| SessionKey 分量 | harness=`codex`；native id=`session_meta.payload.session_id`（**逻辑会话，非文件名**——51% 续接）；source profile=`workspace_roots`（turn_context 最新非空）；machine namespace=**缺（未派生）** | harness=`dsh`；native id=header `id`=`session-<uuid>`（全局唯一，=目录名）；source profile=project 目录（cwd slug）；machine namespace=**缺（未派生）** |
| version/revision 信号 | 每条事件带 `timestamp`（ISO）；新文件=新会话或续接；append=新事件。`SessionRevision`=文件内最大 `timestamp`（或 file size/mtime） | `seq` 单调 + `time`；新帧=追加。`SessionRevision`=最大 seq/time（或末帧字节偏移） |
| 增量 tail 可行性 | **可行**：明文 append-only，字节偏移 tail（cc-trace `ScanFileState.offset_bytes` 模型） | **不可行**：58/58 多帧 zstd，无帧索引；naive tail 实测报错。只能全量重解 + 按 seq 差分，或按帧边界跟踪（扫描压缩字节找 frame magic，只解新帧），或依赖 DSH 原生投影做 live（§4.3 已如此定） |

---

## 3. 现在已覆盖 vs R2a 需要新增的差距

### 3.1 已覆盖（不是差距）

- **Codex archived_sessions + session_index**：记忆 `cc-trace-research` 说「漏读」，但
  commit `f35f377`（补 archived_sessions 根集合）与 `2f860ec`（session_index 标题索引）
  已修复。当前 `codex_session.py`/`codex_session.rs` 的 `CODEX_SESSION_ROOTS` 同时
  报告 live + archived，`read_session_index` 独立读标题。**R2a 直接复用，无新增。**
  注意本机 `archived_sessions` 目录不存在 → 走已实现的存在性探测（`exists=false`
  零填充），不能当错误。
- **Codex 全量读 + 证据派生**：adapter 层已锁步（Python ↔ Rust），core 的
  `derive_coverage` 对未知记录记 `attempts`。实测 55 会话 0 attempts。

### 3.2 R2a 需要新增的差距

1. **DSH zstd 多帧读取（阻断项）**：当前 Python/Rust 读适配器对 `.zstd` 一律
   `non-json` 降级（实测），本机 58/58 都是 zstd → **DSH 源目前一个会话都进不了
   SessionStore**。`dsh_autosync.py::_decompress_zstd`（Python `zstandard`,
   `read_across_frames=True`）与 Node `readZstdFrames` 已有多帧实现可参照；Rust
   侧需新增 zstd 依赖（注意 §7.1 G1 的「不依赖 zstandard」指的是**分发出去的
   宿内 Python skill** 不拉第三方库；Tauri/Rust 桌面运行时加一个 zstd crate 是另一
   条约束，需在 R2a 决策时确认——备选 `zstd`（C 绑定）/`ruzstd`（纯 Rust）/调用
   Node 执行环境路径）。
2. **DSH 根目录发现**：`dsh.py`/`dsh.rs` 的 `read_session_evidence` 只吃
   `AGENT_VITALS_DSH_SESSION_LOG` 单文件/目录注入（注释明说「真机自动从
   `$DSH_HOME/sessions/` 发现留后续」）。R2a 需要给 DSH 补一个与
   `codex_session_roots_report` 同级的根发现（存在性 + 计数 + 字节量，绝不报错），
   才能做 initial population 的目录扫描。
3. **SessionKey 的 machine namespace**（两源都缺）：§4.3 要求「可重放派生、持久在
   app 自有 config 的随机 UUID」。目前没有任何地方派生它；R2a 需在 Tauri app config
   落一个 `machine_namespace`，Codex/DSH 的 SessionKey 都拼上它。Dedup 键：
   Codex 按**逻辑 `session_id`**（51% 文件名≠session_id，按文件名去重会把续接会话
   数成两笔）；DSH 按 header `id`（=目录名，天然唯一）。
4. **DSH 降级语义修正**：`.zstd` 路径当前报 `non-json`，这是「reader 不认识格式」
   却被说成「日志坏了」。R2a 应让 adapter 显式识别 `.zstd` 后缀并给
   `unsupported-compression` 之类的诚实状态（或直接实现解压），不能沿用 `non-json`。
5. **Codex 标题覆盖是 87% 不是 100%**（22 条索引 / 48 命中）：R2a 的 `list_sessions`
   展示 title 时要允许 null（诚实缺失），不能因为 13% 会话没标题就当数据坏了。

### 3.3 关于 `scripts/probe_logs.py` 的更正

任务简报把 `probe_logs.py` 列为「DSH 会话读取（zstd 日志）」——**不符**。它
`CANDIDATE_DIRS` 只含 claude-code / codex / openclaw / cc-switch，**没有 DSH，也不
解 zstd**；是 legacy 通用 JSONL 字段探测器（非默认流程）。DSH 的读取在
`dsh.py`/`dsh.rs`（裸 jsonl）、`dsh_autosync.py`（zstd，state 写者）、
`dsh-client/src/harness/index.ts`（Node 执行环境插件，zstd）三处。

---

## 4. initial population 建议切法

1. **先扫 Codex**：adapter 全量就绪，55 会话 / 544MB，一轮 Python 全量 ~75s（Rust
   侧作为 R2a 的首次实现，预计 ≤10–20s，落在 §5.3 全量 rescan 预算附近）。顺序：
   `codex_session_roots_report`（stat，1ms）→ 逐文件 `read_codex_session_log` →
   core `build_codex_evidence` → 按逻辑 `session_id` 去重 + `session_index` 拼标题。
   资源上限建议：per-file 单飞，单文件最大 210.6MB / p90 1.6s 可接受；对 >50MB 的
   大文件可先 size/mtime 快照，避免每 tick 重读。
2. **DSH 排在 zstd 落地之后**：当前 adapter 读不了任何文件，先做 §3.2-1/2（zstd
   多帧 + 根发现）。落点后：58 会话 / 215.8MB 明文，全量 18.2s（解压 0.4s 是
   大头之外的快速部分），coverage 25,510 exec + 10,894 usage。**zstd 落地前，DSH
   源必须显示为 `source-unavailable`（诚实降级），不能显示 0 会话。**
3. **无权限/损坏的降级路径**：逐文件降级原样透传（missing-header / non-json /
   file-missing / schema-version-mismatch / unsupported-compression），汇总为
   source_statuses 进入 versioned envelope（§5.4），**绝不把单个文件降级当 0 条
   真数据**。Codex 的 archived 根缺席、DSH 的 project 目录缺席都走存在性探测。
4. **Dedup / revision**：
   - Codex SessionKey = `(codex, session_id, machine_namespace)`；DSH =
     `(dsh, header.id, machine_namespace)`。
   - `SessionRevision`：Codex 用文件内最大事件 `timestamp`；DSH 用最大 seq/time。
     增量场景（R3）：Codex 字节偏移 tail 可行；DSH 走「全量重解 + 按 seq 差分」或
     「帧边界跟踪」，**不承诺未证明的 offset tail**（§4.3 原话）。
   - 断线→回退→重连的 exactly-once：Codex 续接会话（新文件同 `session_id`）必须
     并进同一 SessionKey，token/cost 不重计——这正是 51% 续接文件存在的意义。

---

## 5. SessionKey / revision 分量实测对照

| 分量 | Codex | DSH |
|---|---|---|
| harness kind | `codex`（`canonical.meta.harness_id` 实测 = `codex`） | `dsh` |
| native id | `session_meta.payload.session_id`（实测 55/55 都有；缺时退回 `payload.id`） | 头行 `id` = `session-<uuid>`（实测 = 目录名，58/58） |
| source profile | `workspace_roots`（turn_context 最新非空；sample 实测含本机路径） | project 目录名（cwd slug，如 `--Users-Admin-projects-project-skill-vitals--`）；头行 `cwd` 亦可 |
| machine namespace | **缺**（推断：需按 §4.3 在 app config 落随机 UUID，禁止 hash 用户名/路径） | **缺**（同上） |
| revision（新判定） | 新文件出现 / 文件增长；事件最大 `timestamp` | 新 zstd 帧追加；最大 seq/time |
| 去重陷阱 | 文件名 UUID ≠ 逻辑 session_id（51%）——**必须按 session_id 去重** | 目录名 = header id，无别名陷阱；父子会话靠 `subagentSpawns` 的 `call_id`↔`agent_id` join（非本表范围） |

---

## 6. 复现命令

本表所有数字可复现（只读，不产生副作用）：

```bash
# Codex
ls ~/.codex/ && find ~/.codex/sessions -name 'rollout-*.jsonl' | wc -l
find ~/.codex/sessions -name 'rollout-*.jsonl' -exec stat -f%z {} \; | \
  awk '{s+=$1; if($1>m)m=$1} END{print "total="s, "max="m}'
python3 - <<'PY'
# 格式占比 / 损坏 / session_id 与文件名比对 / 标题命中
import sys; sys.path.insert(0, "scripts")
from agent_vitals.adapters.codex_session import parse_codex_session_log, read_session_index
from pathlib import Path
rs = [p for p in Path.home().joinpath(".codex","sessions").rglob("rollout-*.jsonl")]
idx = read_session_index(); n=hit=leg=pag=mis=0
for p in rs:
    r = parse_codex_session_log(p.read_text(encoding="utf-8",errors="replace"))
    n+=1
    if r["history_mode"]=="legacy": leg+=1
    elif r["history_mode"]=="paginated": pag+=1
    if r["degraded"]: print("degraded", p, r["degraded"])
    if r["session_id"] and r["session_id"] in idx: hit+=1
    fu="-".join(p.stem.split("-")[-5:])
    if r["session_id"] and r["session_id"]!=fu: mis+=1
print(n, "legacy", leg, "paginated", pag, "title-hit", hit, "fname!=sid", mis)
PY

# DSH
find ~/.dsh/sessions -name 'session.jsonl.zstd' | wc -l
python3 - <<'PY'
# 多帧确认 + naive tail 证据 + adapter 对 .zstd 的降级
import sys, zstandard; sys.path.insert(0, "scripts")
from pathlib import Path
from agent_vitals.adapters.dsh import read_session_log
fs = sorted(Path.home().joinpath(".dsh","sessions").rglob("session.jsonl.zstd"))
mf = 0
for f in fs:
    raw = f.read_bytes()
    if raw.count(b"\x28\xb5\x2f\xfd") > 1: mf += 1
print("multi-frame", mf, "/", len(fs))
big = max(fs, key=lambda p:p.stat().st_size)
tail = big.read_bytes()[-2_000_000:]
try:
    zstandard.ZstdDecompressor().decompress(tail, max_output_size=500_000_000)
    print("tail OK (unexpected)")
except Exception as e:
    print("naive tail FAILED:", str(e)[:80])
print("adapter on .zstd ->", read_session_log(str(fs[0]))["degraded"])
PY
```
