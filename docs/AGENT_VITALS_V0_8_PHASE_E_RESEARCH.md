# v0.8 Phase E —— 目录搬迁（apps/ packages/ integrations/ assets/）

> Phase D 的 crate 骨架（`vitals-core` ← `agent-vitals-domain` ← `agent-vitals-harnesses`
> ← `agent-vitals-runtime` ← binary/wasm/src-tauri）已到位。Phase E 是**纯目录搬迁**，
> 零逻辑改动——但触到测试 harness 本身（每个 test 的路径、CI workflow、ClawHub 打包
> 清单、golden runner、Python import），所以每步必须一次性搬完（不能半新半旧）。
>
> 与 Phase C/D 同纪律：每 sub-step 独立小提交，全量门禁零漂移。

## Sub-step 分解

```
E1  dsh/ + dsh-client/ → integrations/       ✅ 完成（commit b2738ab）
E2  src-tauri/ → apps/desktop/src-tauri/     ✅ 完成（commit 6335d29）
E3  src/（binary）→ apps/cli/                ✅ 完成（本提交）
E4  scripts/agent_vitals/ → packages/agent-vitals-python/agent_vitals/   ✅ 完成（本提交）
E5  pricing/templates → assets/（跨语言共享资产出包）           ✅ 完成（本提交，范围收窄见完成记录）
E6  CI workflows 路径同步（verify.yml / release.yml / package-clawhub.yml） ✅ 完成（本提交）
```

### E1 完成记录（2026-09-04）

`git mv dsh integrations/dsh` + `git mv dsh-client integrations/dsh-client`。

- `.gitignore`：`dsh-client/node_modules/` → `integrations/dsh-client/node_modules/`（+ dsh 同）。
- `tests/test_pricing_lockstep.py` / `test_timeline_lockstep.py`：`REPO / "dsh-client"` →
  `REPO / "integrations" / "dsh-client"`；内嵌路径字符串 `dsh-client/pricing.json` /
  `dsh-client/src/…` 同步。
- `tests/test_dsh_bundle.py`：`DSH = ROOT / "dsh"` → `ROOT / "integrations" / "dsh"`；
  `"dsh/SKILL.md"` 字面量 → `"integrations/dsh/SKILL.md"`。
- `.github/workflows/verify-dsh-client.yml`：`dsh-client/**` path filter +
  `working-directory` + `dsh-client/scripts/` → `integrations/dsh-client/…`。
- `README.md`：`[dsh/README.md]` 链接 → `integrations/dsh/README.md`。
- **wasm 拷贝目标**：`wasm-pack build` 后的 `.js`/`.wasm`/`.d.ts` 现在拷进
  `integrations/dsh-client/`（committed build artifact，执行环境 `readFileSync` 用）。
- **门禁全绿**：cargo test 32 binary（Rust 无 `dsh-client/` 硬引用）、
  `integrations/dsh-client/scripts/verify{,-harness,-timeline}.mjs`、
  python 1145/226 skip、golden 15+15。

### E2 完成记录（2026-09-04）

`git mv src-tauri apps/desktop/src-tauri`（spec §11：`src-tauri` → `apps/desktop/src-tauri`）。

- `apps/desktop/src-tauri/Cargo.toml`：`path = "../crates/…"` → `"../../../crates/…"`（深两级）。
- `tauri.conf.json`：`resources` 里的 `"../target/release/agent-vitals"` →
  `"../../../target/release/agent-vitals"`（CLI 二进制 bundle 成资源，根 `target/` 现在深两级）。
- `crates/vitals-core/tests/dependency_boundary.rs`：跨 workspace 边界检查
  `../../src-tauri/Cargo.toml` → `../../apps/desktop/src-tauri/Cargo.toml`。
- ~8 处 test/script 路径：`tests/test_{harness_contract,timeline_lockstep,state_history_rotate}.py`、
  `scripts/{make_menubar_icon,verify-timeline-geometry,verify-codex-session-timeline,
  verify-workbench-fold-bridge}.mjs` 的 `src-tauri/` / `../src-tauri/` → `apps/desktop/src-tauri/`。
- `src-tauri/.gitignore`（`target/` + `gen/`）随目录一起走，无需改。
- **门禁全绿**：cargo test 32 binary、clippy -D warnings、`apps/desktop/src-tauri cargo check`、
  `scripts/verify-*.mjs` 3 个、python 1145/226 skip、golden 15+15。

### E3 完成记录（2026-09-04）

`git mv src apps/cli/src`（spec §11：`src/` → `apps/cli`）。二进制包从根
`[package]` 拆成独立 crate `apps/cli`；根 `Cargo.toml` 退成纯 `[workspace]`
manifest（`[profile.release]` 仍只能在 workspace 根声明，留在根）。

- `apps/cli/Cargo.toml`：新文件，承接根原来的 `[package]`+`[[bin]]`+`[dependencies]`+
  `[dev-dependencies]`；`path = "crates/…"` → `"../../crates/…"`（深两级）。
- `include_str!` 深度 +1（`src/` → `apps/cli/src/`）：`main.rs` 的 calendar 模板
  （`../scripts/…` → `../../scripts/…`）、`codex_cost.rs`/`codex_session_audit.rs`
  的 `../../scripts/…` → `../../../scripts/…`（这两个在 `src/agent/`，深度 +1 更多）。
- `r2a_store.rs` 6 处 `env!("CARGO_MANIFEST_DIR")).join("fixtures")`（fixture 路径）
  插 `.join("../..")`——`CARGO_MANIFEST_DIR` 现在是 `apps/cli/`，仓库根 `fixtures/`
  深两级。
- `crates/agent-vitals-domain/tests/harness_contract.rs`：G2 三处源码自扫描的
  `"src/main.rs"` → `"apps/cli/src/main.rs"`。
- Python：`test_classification.py::RS_SRC` = `ROOT / "apps" / "cli" / "src"`；
  `test_harness_contract.py::_SCAN_CLI_LOCATIONS` 同款路径。
- **未迁**：`r2a_store.rs`（2708 行）+ `discovery.rs`（733 行）仍在 `apps/cli/src/agent/`
  ——spec §11 说它们该进 `agent-vitals-runtime/state/`，但两者与 CLI 成本/审计
  handler（`codex_session_audit`/`codex_cost`/`claude_cost`）深度交织，强行现在拆
  只会多造 re-export 层。留在 `apps/cli` 是合法终态（它们本来就是 CLI 用的
  「读证据 → 调纯计算 → 出报告」handler），不是欠债——D6 已把真正的**纯 state/ledger**
  层（state/budget/takeover/session_sources）迁进 runtime。
- **门禁全绿**：cargo build/test 32 binary、clippy -D warnings、wasm check、
  `apps/desktop/src-tauri` check、python 1145/226 skip、golden 15+15（workspace
  `target/` 目录不变，golden runner 的 `AGENT_VITALS_BIN=./target/release/agent-vitals`
  路径零改动）。

### E4 完成记录（2026-09-04）

`mkdir -p packages/agent-vitals-python && git mv scripts/agent_vitals
packages/agent-vitals-python/agent_vitals`。核心设计张力：打包产物给用户的命令
必须留 `python3 scripts/scan.py`（SKILL.md/README 已文档化，ClawHub 也在
`scripts/scan.py` 起步），但包本体要挪走——解法是让 **源仓库和打包产物走同一份
相对结构**：`scan.py` 留在 `scripts/`，用
`Path(__file__).resolve().parent.parent / "packages" / "agent-vitals-python"` 找包；
打包工作流现在也在产物里建出同一层 `packages/agent-vitals-python/agent_vitals/`
——一份 `sys.path` 公式两个语境都成立，不必分源码态/打包态两套逻辑。

- `scripts/scan.py`：新增 4 行 `sys.path` 前缀（找 `packages/agent-vitals-python/`），
  其余 `import agent_vitals.cli`/`compat` 调用点不变。
- `.github/workflows/package-clawhub.yml`：`cp -R scripts/agent_vitals` →
  `cp -R packages/agent-vitals-python/agent_vitals`；`python_package=` 变量、
  `required=` 清单里的 `scripts/agent_vitals/__init__.py` 同步为
  `packages/agent-vitals-python/agent_vitals/__init__.py`；版本不匹配报错文案里的
  路径提示同步。
- 33 个 `tests/*.py` + `scripts/*.py` 的 `sys.path.insert(0, ROOT / "scripts")` 批量
  改成 `ROOT / "packages" / "agent-vitals-python"`——但 `test_doctor.py`（`import scan`）
  和 `test_cc_trace_oracle.py`（`import cc_trace_oracle`）这两个文件导入的是**留在
  `scripts/` 的模块**，不是 `agent_vitals` 包，批量 sed 误改后被两个 `ModuleNotFoundError`
  当场抓住，改回 `ROOT / "scripts"`。教训：批量替换 `sys.path.insert` 之前先确认该文件
  import 的是不是 `agent_vitals` 本体。
- `tests/test_catalog_pricing.py`：`from scripts.agent_vitals.agent.cost import
  _resolve_card_catalog`（点号导入，不是 sys.path 依赖）漏改，`ModuleNotFoundError:
  No module named 'scripts.agent_vitals'`——改成 `from agent_vitals.agent.cost import
  _resolve_card_catalog`（吃文件顶部已插的 sys.path）。
- `tests/test_clawhub_packaging.py`：`ALLOWED_PACKAGE_FILES`/工作流断言/
  `test_minimal_artifact_contains_all_modules_and_runs`（模拟打包产物的构造逻辑本身）
  三处一起改，镜像新的相对结构。
- Rust `include_str!` 4 处目录名变了（不只是深度）：`apps/cli/src/agent/codex_cost.rs`
  （codex_pricing.json）、`apps/cli/src/main.rs`（calendar.html）、
  `apps/cli/src/agent/codex_session_audit.rs`（codex_session.html）、
  `crates/agent-vitals-domain/src/domain/cost/mod.rs`（pricing.json）——
  `scripts/agent_vitals/` 段替换成 `packages/agent-vitals-python/agent_vitals/`，
  层数（`../..` 前缀）不变。
- `crates/agent-vitals-domain/tests/harness_contract.rs`：G2/G3 两处源码自扫描基准路径
  （`cli.py`、`agent/dsh_evidence.py` 等）同步，之前漏改导致 `cargo test` 两个 G2/G3
  断言直接报文件不存在。
- 2 个 `.mjs`（`scripts/verify-codex-session-{timeline,findings}.mjs`）：
  `readFileSync(join(here, "agent_vitals", "templates", …))` → 插一层
  `"..", "packages", "agent-vitals-python"`。
- `.gitguardian.yaml`：顺手发现 `src/doctor.rs`/`scripts/agent_vitals/doctor.py`
  两条 ignored-paths 早就因为 E3（`src/` → `apps/cli/src/`）和本步都过期了（doctor.py
  实际在 `agent_vitals/skills/` 子树，不是包顶层）——两条一起修成
  `apps/cli/src/skills/doctor.rs` / `packages/agent-vitals-python/agent_vitals/skills/doctor.py`。
- CLAUDE.md：repo-layout 块、"两套实现"开篇段、~7 处正文里的 `scripts/agent_vitals/…`
  路径引用（价格表单源、`behavior.py`/`source_identity.py`/`cost.py` 平行实现指路）
  同步；顺手把一处更早就该改的 `src/behavior.rs`（应为 `apps/cli/src/agent/behavior.rs`）
  也修了。
- **门禁全绿**：`cargo build/test/clippy --release` 全绿（包括修复后的
  `harness_contract.rs` G2/G3）、`cargo check -p agent-vitals-wasm`、
  `apps/desktop/src-tauri cargo check`、5 个 `scripts/*.mjs` + `integrations/
  dsh-client/scripts/verify-harness.mjs`、python 1145 跑通两遍（纯 Python 与
  `AGENT_VITALS_BIN=./target/release/agent-vitals` 差分各一遍，后者 skip=4）、
  golden 15+15 两实现字节一致。

### E5 完成记录（2026-09-04）

`git mv packages/agent-vitals-python/agent_vitals/{pricing.json,codex_pricing.json,
templates/} assets/`。范围比 spec §11 的完整 `assets/{catalog/{models,pricing,
subscriptions},templates,icons}` 树收窄——原因是这棵完整树连着**未建的功能**
（catalog loader、模型/订阅注册表、`~/.agent-vitals/billing.toml`），跟本文档
开篇那句「Phase E 是纯目录搬迁，零逻辑改动」直接冲突，也正是「明确不做」那条
早就划的线（v0.7 延期写盘/migration 框架属于功能，不是目录搬迁——同一条线这里
适用）。E5 只做其中**已经有真实跨语言 lockstep 测试撑腰**的那部分：

- `assets/pricing.json` + `assets/codex_pricing.json`——Rust `include_str!`、
  Python `_PRICING_PATH`/`_CODEX_PRICING_PATH`、`integrations/dsh-client/
  pricing.json`（build 时复制）三方共读的同一份文件，搬出 Python 包只是把
  「这其实不是 Python 私有数据」的事实显式化。
- `assets/templates/{calendar.html,codex_session.html}`——Rust `include_str!`
  与 Python 两边共读同一份模板，同样的道理。
- **不做**：`assets/catalog/{models,pricing,subscriptions}/` 子目录结构、
  catalog loader、模型/订阅注册表、`billing.toml`——这些是 v0.9+ 的功能范畴。
- **不做**：`apps/desktop/src-tauri/icons/` 不动。Tauri 工具链按约定在
  `src-tauri/icons/` 找图标（`tauri.conf.json` 的 bundle 配置、`tauri icon`
  命令都假设这个相对位置），且图标不参与任何跨语言 lockstep 测试——挪出去唯一
  的收益是"目录名好看"，代价是打包配置漂移只有真跑 `tauri build` 才能发现（现有
  门禁只到 `cargo check`）。与 E3 的 `r2a_store.rs`/`discovery.rs` 同款判断：
  工具需要它在那，不是欠债。

改动内容：

- Python 5 处路径常量/字面量：`cost.py::_PRICING_PATH`、
  `codex_cost.py::_CODEX_PRICING_PATH`、`cli.py` 两处 calendar 模板路径、
  `codex_session_audit.py` 的 codex_session 模板路径——全部从 `Path(__file__).
  parent(.parent)` 改成 `Path(__file__).resolve().parents[N]`（N=3 给 cli.py，
  N=4 给 agent/ 子目录下的模块）爬回仓库根找 `assets/`。
- Rust `include_str!` 4 处——目录段从 `packages/agent-vitals-python/agent_vitals/`
  换成 `assets/`，`../` 深度不变（assets/ 与 packages/ 同在仓库根）。
- `.github/workflows/package-clawhub.yml`：新增 `assets/` 打包步骤（`mkdir -p
  .../assets/templates` + `cp`），Python 包 allowlist 里删掉
  `pricing.json|codex_pricing.json|templates/*.html`（它们不再是包内容），
  `required=` 清单加 4 个 `assets/...` 路径。
- `tests/test_clawhub_packaging.py`：新增 `ALLOWED_ASSETS_FILES`/
  `ALLOWED_ASSETS_DIRS` + `test_assets_dir_has_only_the_shared_files`，
  `_unexpected_package_entries` 加 `allowed_files`/`allowed_dirs` 形参（默认值
  = 原 Python 包清单，向后兼容）；模拟打包产物的构造逻辑加一步拷贝 `assets/`。
- `tests/test_pricing_lockstep.py`/`tests/test_catalog_pricing.py`/
  `tests/e2e_smoke.py`：`PRICING_JSON` 常量与直读路径同步到 `assets/`。
- 2 个 `.mjs`（同 E4 改过的那两个）：模板路径从
  `packages/agent-vitals-python/agent_vitals/templates` 改成 `assets/templates`；
  `integrations/dsh-client/scripts/verify-harness.mjs` 的注释同步。
- 顺手抓到几处 E3/E4 遗留的过期路径注释（`cost.py`/`codex_cost.py`/
  `codex_session_audit.py` 里指向 `src/codex_cost.rs`/`scripts/agent_vitals/…`
  的旧路径），一起改掉。
- **门禁全绿**：`cargo build/test/clippy --release`、wasm check、
  `apps/desktop/src-tauri` check、`scripts/verify-codex-session-{timeline,
  findings}.mjs`、`integrations/dsh-client/scripts/verify-harness.mjs`、python
  1146 跑两遍（纯 Python + `AGENT_VITALS_BIN` 差分，后者 skip=4）、golden
  15+15 两实现字节一致。（`tests/e2e_smoke.py` 的 M1 `hour_buckets` 失败在改动
  前后一致复现——真机会话数据依赖，与本步无关，不在 `unittest discover tests`
  的门禁范围内。）

### E6 完成记录（2026-09-04）

`verify.yml`/`release.yml`/`verify-dsh-client.yml` 检查后**没有硬编码路径需要
改**——三个 workflow 的 `run:` 步骤全是 workspace-root-relative 命令
（`cargo build/test/clippy`、`python -m unittest discover tests`、
`python tests/golden_runner.py`），不依赖 crate 内部目录布局；`verify-
dsh-client.yml` 的 `paths:` 触发过滤器在 E1 就已经改成 `integrations/
dsh-client/**`。`package-clawhub.yml` 的路径已经在 E4/E5 里随打包内容变化同步
过，这一步等于是回头核实：确认无遗漏。

真正找到并修的，是 E1-E5 各步散落的**注释里的过期路径**（功能不受影响，但
读者会被带偏）——顺手在这一步一起清：

- `crates/vitals-core/src/lib.rs` / `apps/cli/src/agent/harness_runtime_
  registration.rs`：裸 `src-tauri` → `apps/desktop/src-tauri`（E2 遗留）。
- `crates/agent-vitals-domain/src/domain/cost/mod.rs`：裸 `src/agent/cost.rs`
  → `apps/cli/src/agent/cost.rs`（E3 遗留）；6 处裸 `dsh-client/...` →
  `integrations/dsh-client/...`（E1 遗留，含本次 E5 提交里我自己刚写进去的
  一处 `dsh-client/pricing.json`）。
- `crates/agent-vitals-runtime/src/home.rs`、`apps/cli/src/agent/discovery.rs`、
  `crates/agent-vitals-domain/src/domain/duration.rs`、`packages/agent-vitals-
  python/agent_vitals/agent/{duration,cost}.py`：同款裸 `dsh-client/src/harness/
  index.ts` → `integrations/dsh-client/src/harness/index.ts`。
- `packages/agent-vitals-python/agent_vitals/agent/cost.py`：顺带发现的
  二次错误——E5 提交里我把价格表单源注释指向了 `dsh-client/client.js`（缺
  `integrations/` 前缀，且这个文件早在 tsup 迁移后就不存在了，真正的展示层
  副本在 `src/client/styles/index.ts`），改成
  `integrations/dsh-client/src/client/styles/index.ts`。

**门禁重跑**：`cargo build/test/clippy --release`（全绿）、golden 15/15（纯
Python）、python 全量 1146（`OK skipped=228`）。纯注释改动，未重跑
wasm/tauri check 与 `AGENT_VITALS_BIN` 差分——E5 完成记录里的那一轮已经覆盖
过一次，这里的改动不碰任何代码路径，只碰落在文档注释里的字符串字面量。

至此 Phase E（E1-E6）全部完成。

## 明确不做（同 D 的边界）

v0.7 延期写盘 / migration 框架 / watcher —— 那是功能，不是目录搬迁。
