---
draft: true
title: 怎么给 Oh Agent 添加一个新的 Agent 数据源？
description: 给 Oh Agent 的数据层 Agent Vitals 添加新 Agent 的贡献者指南：可以写 manifest 不用写代码，也可以用 Rust 做成内置数据源，包括解析器、注册表条目、Python 对等实现和 golden 测试。
head:
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
          {"@type": "ListItem", "position": 1, "name": "Oh Agent", "item": "https://ohagent.ai/"},
          {"@type": "ListItem", "position": 2, "name": "文档", "item": "https://ohagent.ai/docs/zh"},
          {"@type": "ListItem", "position": 3, "name": "添加数据源", "item": "https://ohagent.ai/docs/zh/contributing/adding-a-data-source"}
        ]
      }
---

给 Agent Vitals 添加新 Agent 有两条路。**manifest**：不用写代码，在一个 JSON 文件里描述这个 Agent 的 JSONL 日志，就能导入它的 Token 用量，费用标为估算。**内置数据源**：要改 Rust 代码。在 `crates/agent-vitals-harnesses` 下写解析器，在数据源注册表里加一行，同步更新几个列表，再补上 Python 对等实现和 golden 测试。只有内置数据源才有行为检查和会话轨迹。不管走哪条路，新数据源都会自动出现在 Agent City 里。

## 该走哪条路？

| | manifest | 内置 |
| --- | --- | --- |
| 代码 | 不用（JSON） | Rust + Python 对等实现 |
| 日志格式 | 每行一条用量记录的 JSONL，且符合 3 个配方之一 | 不限（SQLite、zstd、多文件关联……） |
| 用量、Token、费用估算 | 有（始终是 `metered_estimate`） | 有；能证明的话可以按订阅计价 |
| 行为发现、轨迹、标题 | 没有 | 有，前提是你实现了 |
| 审核 | 只在本地（官方目录以后再说） | PR 审核 |

能用 manifest 就先用 manifest：[其他目录与 manifest 数据源](/docs/zh/integrations/custom-sources-and-manifests)。

<!-- source: docs/HARNESS_MANIFEST_DSL_SPEC.md §0–§1 ("账面可自助，行为须官方"); crates/agent-vitals-harnesses/src/harnesses/generic/manifest.rs (RECIPE_IDS) -->

## 内置数据源：分步骤

注册表自己的文档注释说得很直接：加一个数据源就是“在这里加一行，并在 `harnesses/<h>/sources/` 写实现；运行时不变”。实际上还要同步更新几个封闭列表。

### 1. 写解析器

参照现有数据源，新建 `crates/agent-vitals-harnesses/src/harnesses/<name>/`：

- `sessions/`：纯会话证据，不做 I/O，因此也能编译到 wasm。
- `sources/`：定位、读取和解析文件，放在 crate 的 `sources` feature 后面。常见文件有 `usage_fact.rs`（日志行 → 用量事实）、`findings.rs` 和一个发现模块。
- 在 `src/harnesses/mod.rs` 里注册这个模块。

特定 Agent 的 I/O 放在这里，纯规则放在 `agent-vitals-domain`。

<!-- source: crates/agent-vitals-harnesses/src/harnesses/mod.rs; harnesses/dsh/mod.rs ("sessions/ = 会话证据（纯，wasm 可链）。sources/ = 定位 / 读取 …#[cfg(feature = "sources")]"); harnesses/codex/sources/ (usage_fact.rs, findings.rs, …); AGENTS.md (Coding Style) -->

### 2. 在数据源注册表里加一行

在 `crates/agent-vitals-harnesses/src/sources/session_harnesses.rs` 的 `SESSION_HARNESSES` 末尾追加一个 `SessionHarness`：

| 字段 | 填什么 |
| --- | --- |
| `id` | 数据源 id，比如 `"my-agent"`，必须和用量事实上的 `harness` 标记一致 |
| `default_root` | 这个 Agent 在本机的位置，从 `HarnessRoots` 取。找不到就返回 `None`，这不算错误 |
| `files_under` | 列出某个根目录下的会话文件，返回文件和遍历错误 |
| `accepts_custom_roots` | 是否允许用户为这个数据源添加其他目录 |
| `findings` | 有行为发现就填 `Some(evaluate)`，否则 `None` |
| `session_sources` | 按原生 id 找某个会话的源文件（只用于本地下钻） |
| `title_index` | 可选的会话标题索引，只读、容错 |

顺序有意义：注册表顺序就是同步顺序，也是同步报告里的顺序，所以加在末尾。还要把你的目录加进 `usage_source_roots`（manifest 不能重复认领的具体用量目录），并更新同一文件里的注册表测试。

<!-- source: crates/agent-vitals-harnesses/src/sources/session_harnesses.rs (struct SessionHarness fields and docs; "顺序即契约"; usage_source_roots; registry tests) -->

### 3. 更新封闭列表

这些列表列出了所有内置数据源，靠手工保持一致：

| 列表 | 文件 |
| --- | --- |
| `FACT_HARNESSES` | `crates/agent-vitals-runtime-core/src/core/fact_harnesses.rs` |
| `TRACE_HARNESSES` | `crates/agent-vitals-query/src/query/trace_service.rs` |
| `WIRED_HARNESSES` | `crates/agent-vitals-query/src/query/summary/mod.rs` |
| `HARNESSES`（重新导入） | `crates/agent-vitals-ingest/src/ingest/reimport_verify.rs`，跟随 `FACT_HARNESSES` |
| `RESERVED_SLUGS` | `crates/agent-vitals-harnesses/src/harnesses/generic/manifest.rs`，防止 manifest 占用你的 id |
| 其他目录白名单 | `crates/agent-vitals-query/src/sources/custom_sources.rs` 里的 `valid_harness`（仅当 `accepts_custom_roots` 为真） |
| 显示名 | `agent-vitals-domain` 里的 `harness_profile`（`harness_capability`），桌面的 `harness_display_name` 会用到 |
| 文件监听 | `crates/agent-vitals-query/src/sources/watch_topology.rs` |

<!-- source: fact_harnesses.rs ("…加执行环境四处一起改"); trace_service.rs:40; summary/mod.rs:33; reimport_verify.rs:23; manifest.rs RESERVED_SLUGS; custom_sources.rs valid_harness; apps/desktop/src-tauri/src/lib.rs harness_display_name; watch_topology.rs -->

**待确认**：完整的改动清单。`docs/HARNESS_MANIFEST_DSL_SPEC.md` 附录 C 列了 16 个耦合点（命令行 `--harness` 枚举、Python 命令行选项、界面名称映射、golden 用例，以及下游的计价、汇总、导出和 MCP），但里面的文件路径早于 crate 拆分。提 PR 前，用 `rg` 搜一个现有 id（比如 `"workbuddy"`）重新核对一遍。

### 4. 补 Python 对等实现和 golden 测试

Agent Vitals 在 `packages/agent-vitals-python/agent_vitals/` 维护一套 Python 兼容实现（适配器如 `codex_session.py`、`dsh.py`、`workbuddy.py`），输出必须逐字节一致：

- 添加 Python 适配器，并在 `golden/` 下添加 golden 用例（比如 `golden/harness-workbuddy.json`），fixtures 放在 `fixtures/`。
- 添加坏输入测试：根目录不存在表示“没有这个数据源”，而不是“0 个会话”；坏掉的一行只影响这一行。
- 新的问题类别要先登记到 `docs/AGENT_EXECUTION_PROBLEM_TAXONOMY.md`，再写产出它的代码。

<!-- source: AGENTS.md (Project Structure; Testing Guidelines; policy item 5); packages/agent-vitals-python/agent_vitals/adapters/; golden/harness-workbuddy.json -->

### 5. 遵守数据规则

- **计费**：没有官方订阅线路的明确证据时，用量记为 `metered_estimate` 并带 `has_unresolved = true`，不能丢掉，也不能记成 0。
- **隐私**：只存派生字段和短摘录，不存完整对话，永远不保存凭据。
- **格式**：不要对文件跑 `rustfmt`，每次修改后看一下 `git diff`。

<!-- source: AGENTS.md (Billing fallback rule; Data Retention & Serving-Face Policy; Coding Style: "Do not run rustfmt") -->

### 6. 跑检查

```sh
cargo test --release
cargo clippy --release --all-targets -- -D warnings
python3 -m unittest discover tests -v
python3 tests/golden_runner.py --diff
AGENT_VITALS_BIN="$PWD/target/release/agent-vitals" python3 tests/golden_runner.py --diff
```

不要为了让测试通过就刷新 golden 文件。PR 里要说明契约变化，并列出你跑过的命令。

<!-- source: AGENTS.md (Build, Test, and Development Commands; Commit & Pull Request Guidelines) -->

## 新数据源会出现在 Agent City 里吗？

会。City 通过通用身份读取数据源，而不是固定列表，所以新数据源会有自己的城区。没有加调色板条目时用兜底颜色。**待确认**：每个数据源的 City 调色板放在哪里（fixture 代码提到未知 id 会用兜底调色板）。

<!-- source: docs/CITY_LOCAL_DATA_PROJECTION.md ("v2 使用通用 HarnessPublicIdentityV1，不再限制为四个内置来源"); apps/agent-city/ui/src/data/provider.ts -->

## 相关

- [数据管线](/docs/zh/architecture/data-pipeline)
- [其他目录与 manifest 数据源](/docs/zh/integrations/custom-sources-and-manifests)
- [架构总览](/docs/zh/architecture/overview)
- [GitHub 源码](https://github.com/Oh-Agent-AI/oh-agent)
