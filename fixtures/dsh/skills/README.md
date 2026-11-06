# DSH 目录树 fixture（skill 目录，C1）

DSH-2 的测试语料 C1：一棵确定性的 dsh 执行环境 skill 目录树，供未来的
`harness-dsh` golden（C2）与冲突判定（A7）用。它是**纯语料**——DSH 的扫描逻辑
（A1–A10）还没写，本目录只造数据、不改扫描器、不进现有 golden。

```bash
python3 fixtures/dsh/skills/build_dsh_skills_fixture.py --into /tmp/dshfx --clean
```

> 这份树**不进 `fixtures/generate.py` 的主树**，理由是 `~/.agents/skills` 与
> OpenClaw 共享（[HARNESS_ADAPTER_CONTRACT §DSH](../../docs/HARNESS_ADAPTER_CONTRACT.md)）：
> 放进主树，OpenClaw 适配器会把它当 `shared-user` 根扫走，现有的
> `harness-openclaw` 等 golden 当场变红。所以单独一棵 home 树、单独一个脚本；
> C2 再接进 `tests/golden_runner.py`。

---

## 目录树

`--into <root>` 就是 HOME，`<root>/workdir` 是扫描时的 cwd（project root）。
四条默认 root 全部覆盖：

```
<root>/                                   # HOME；$DSH_HOME=$HOME/.dsh、$DSH_AGENTS_HOME=$HOME/.agents
├── .dsh/skills/                          # user-dsh，rank 400
│   ├── shared-tool/SKILL.md              #   name: shared-tool（跨 rank 重名）
│   ├── dup-user-a/SKILL.md               #   name: dup-user（同 root 重名）
│   ├── dup-user-b/SKILL.md               #   name: dup-user（同 root 重名）
│   └── user-only/SKILL.md                #   独有
├── .agents/skills/                       # user-agents，rank 500
│   ├── shared-tool/SKILL.md              #   name: shared-tool（跨 rank 重名）
│   └── agents-only/SKILL.md              #   独有
└── workdir/                              # project root（扫描时的 cwd）
    ├── .dsh/skills/                      # project-dsh，rank 100
    │   ├── shared-tool/SKILL.md          #   name: shared-tool（跨 rank 重名）
    │   └── proj-only/SKILL.md            #   独有
    └── .agents/skills/                   # project-agents，rank 200
        └── proj-agents-only/SKILL.md     #   独有
```

根表（契约 §DSH，**层内** rank 越小越优先）与语料落点的对应：

| rank | root | source（`level`） | 语料落点 |
|---|---|---|---|
| 100 | `<project>/.dsh/skills` | `project-dsh` | `workdir/.dsh/skills` |
| 200 | `<project>/.agents/skills` | `project-agents` | `workdir/.agents/skills` |
| 300 | `customSkillDirs` | `custom` | —（配置 / `--path`，不在本树） |
| 400 | `$DSH_HOME/skills` | `user-dsh` | `.dsh/skills` |
| 500 | `$DSH_AGENTS_HOME/skills` | `user-agents` | `.agents/skills` |
| 600 | packaged providers | `bundled` | —（运行时证据，不在本树） |

---

## 「同层」与「跨层」到底指什么（A7 语义）

DSH 的解析是**二维**的，rank 单独不够：

1. **scope 层**（`conflict_domain` 第三段，`dsh:<DSH_HOME>:<layer>`）：读取时把
   全局层与观察者的 scope 链合并，**近层同名直接赢**。
2. **rank**（根表 100–600）：**只在同一个 scope 层内**裁决同名副本。

A7（「跨层重名不算冲突」）里的「层」是第 1 维的 **scope 层**。冲突键是
`(conflict_domain, layer, namespace, name)`（`analysis.py::select_scope`），
只有**同 scope 层 + 同名**才进冲突判定；跨 scope 层同名是设计，不是冲突。

DSH 的 filesystem provider 只注册在**全局 scope 层**，所以 `project-dsh`、
`project-agents`、`user-dsh`、`user-agents` 这四条根里的 skill 全在**同一个
scope 层**。因此：**本语料里每一处同名都是「同层」（同 scope 层）**，靠 rank
裁决 —— 这正是 C1 能覆盖、也必须覆盖的那一维。「跨 scope 层」需要 preset /
agent scope（运行时/会话证据），一棵目录树表达不了，留给 C2/C3（运行时证据）
与 A3/A5/A10（适配器把 scope 层写进 `conflict_domain`）。

> 因此任务里「同层 = 同 root（user-dsh 里两个目录同名）」「跨层 = 不同 root
> （project-dsh vs user-dsh）」的例子，按 A7 代码语义其实**都是同 scope 层**
> （一个 rank 并列、一个 rank 差 400），都进冲突判定；区别只在于 rank 是否并列。
> 本 README 按 A7 代码语义标注，避免误导 A7 的实现者。

---

## 每一处重名

### 1. `shared-tool` — 跨 rank 重名（同 scope 层内，rank 决定谁赢）

三份同名、落在三个不同 rank：

| 目录 | root | source | rank | mtime | 结局 |
|---|---|---|---|---|---|
| `workdir/.dsh/skills/shared-tool` | `<project>/.dsh/skills` | `project-dsh` | **100** | OLD | **赢**（rank 最小） |
| `.dsh/skills/shared-tool` | `~/.dsh/skills` | `user-dsh` | 400 | MID | 被盖 |
| `.agents/skills/shared-tool` | `~/.agents/skills` | `user-agents` | 500 | NEW | 被盖（最新） |

预期冲突：winner = `project-dsh`（rank 100），shadowed = `user-dsh` + `user-agents`。
被盖的 `user-agents` mtime 比 winner 新 → **`shadowed_newer` / high**（rank 压过
了更新的用户副本，与 Claude Code 的 personal-vs-project 是同一类「覆盖优先级」）。

### 2. `dup-user` — 同 root 重名（rank 并列）

两份同名、都在 `user-dsh`（rank 400），目录名不同、frontmatter `name` 相同：

| 目录 | root | source | rank | mtime | 结局 |
|---|---|---|---|---|---|
| `.dsh/skills/dup-user-a` | `~/.dsh/skills` | `user-dsh` | 400 | OLD | **赢**（目录名排序在前） |
| `.dsh/skills/dup-user-b` | `~/.dsh/skills` | `user-dsh` | 400 | NEW | 被盖（最新） |

预期冲突：rank 并列（`(99, 400)` == `(99, 400)`，因为 `DSH_LAYER_ORDER` 尚为空、
所有 DSH 层都算最远 99），`sorted(..., key=level_rank)` 稳定 → 目录名排序在前的
`dup-user-a` 胜出。`dup-user-b` 更新 → **`shadowed_newer` / high**。

> 这一处刻意钉住「同 rank 并列时靠稳定排序取目录名在前者」这条边界 —— 移植时
> 最容易在 `walkdir`/`rglob` 的顺序差异里静默改变 winner。

---

## 其余四个独有 skill

每个 root 各有一个非重名 skill，证明该 root 被扫到、且 rank/层可以单独对齐：

| 目录 | source | rank |
|---|---|---|
| `workdir/.dsh/skills/proj-only` | `project-dsh` | 100 |
| `workdir/.agents/skills/proj-agents-only` | `project-agents` | 200 |
| `.dsh/skills/user-only` | `user-dsh` | 400 |
| `.agents/skills/agents-only` | `user-agents` | 500 |

---

## frontmatter 格式

与 `fixtures/generate.py` 的 `skill()` 同款（DSH 要求 `name` + `description`
两个字段都非空）：

```markdown
---
name: shared-tool
description: Shared tool from project-dsh (rank 100)
---

project-dsh body
```

每个 skill 的 description 都不同（源 + rank 拼出），避免 `tier1_tokens` 撞车
导致 golden 排序抖动（与 generate.py 的「描述长度全互不相同」是同一原则）。

## 确定性

- **mtime 显式设定**（OLD / MID / NEW，与 generate.py 同值）：冲突 kind 靠 mtime
  比大小，不钉死就随生成时间变。
- **HOME 隔离**：整棵 home 树都在 `--into` 目标里，扫描时 `HOME=<root>`、
  `cwd=<root>/workdir`，不碰真机。
- **ctime 无法设定**：与 generate.py 相同的不可消除一处（`installed_days_ago`），
  留给 golden_runner 抹哨兵。
- 脚本幂等（固定 mtime），写完重读自校验：结构、frontmatter `name`/`description`、
  mtime、以及两处重名各自的 rank 集合。

## 不在本语料范围（诚实边界）

- **`custom`（rank 300）**：来自 `customSkillDirs` 配置或 `--path`，不是固定根。
- **`bundled`（rank 600）**：来自 packaged providers，只在运行时证据里出现，磁盘
  上没有一个固定根（见 [DSH_INTEGRATION §8](../../docs/DSH_INTEGRATION.md) 的未决口径）。
- **跨 scope 层重名**：需要 preset / agent scope（运行时/会话证据），见上文「同层与
  跨层到底指什么」。这一维由 C3（`../complete.jsonl` / `../incomplete.jsonl`）与未来的
  适配器（A3/A5/A10）覆盖，不是一棵目录树能表达的。
