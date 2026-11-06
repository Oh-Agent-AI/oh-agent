# Agent Vitals — 工程设计

配套文档：[PRODUCT.md](./PRODUCT.md)（问题 / 定位 / 命令 / 指标） · [ARCHITECTURE.md](./ARCHITECTURE.md)（漏斗模型 / 数据契约 / 诊断引擎）

本文是 ADR 与实现约束，**不是产品文档**。新人应先读 PRODUCT.md。

---

# 1. ADR-001：Python → Rust

## 1.1 结论

> **Rust is preferred for distribution, Python is retained.**

倾向现在就迁 Rust，但**带 timebox 与停止规则**（§1.5）。语言选择不得凌驾于产品验证之上。

**2026-08 修订（双实现永久并行，不删 Python）。** Rust 二进制服务 npm / brew / cargo / Release 等「装一个二进制」的渠道；Python 保留，服务 ClawHub 的 in-harness skill 形态，也便于不同语言的开发者阅读与贡献。两者靠差分护栏（同一份 golden、逐字节一致）同步维护——§6.8 因此从「临时并行、终将合并」改为「永久并行」。

## 1.2 为什么是现在而不是 Phase 2

v0.1 的排期是「Phase 1 Python，稳定后迁 Rust」。改变倾向的是成本对比：

| | 现在做 | Phase 2 做 |
|---|---|---|
| 代码量 | 883 行 | 数千行 |
| 回归测试 | 15 个 | 更多，但隐性约定也更多 |
| Python oracle | **在** | 已被改造得面目全非 |
| Golden fixtures | 可立即生成 | 事后无法重建 |

这个项目真正沉淀在**代码**里的资产只有 §2 那 12 条不变量——每条都对应一次真实事故，也正是重写最容易丢的东西。

> **重写是项目生命周期里风险最高的动作，要做就在代码量最小的时候做一次。**

## 1.3 Rust 带来的实际产品价值

不是性能。883 行扫几百个 skill，Python 已经够快。**现在这句话有实测支撑了**：

| 600 个 skill（含 references/、中英混排正文） | 中位 | 最慢 |
|---|---|---|
| Python | 1.19s | 1.93s |
| Rust | 0.10s | 0.11s |

Rust 快 12 倍，但**关键是 Python 没越线**：§1.5 把「500+ skill 的 P95 > 3 秒」
定为重新考虑实现语言的触发条件，Python 的最慢一次是 1.93s。

这条数据的意义不在于「Rust 更快」，而在于它**取消了一个可能被误用的理由**：
如果当初 timebox 超时、按停止规则退回 Python，性能上一分都不会损失。
移植的正当性完全落在下面三条上，与速度无关。

（两个实现在这份 600 个 skill 的语料上输出 33411 行**逐字节相同**。
常驻测试见 `tests/test_hostile_filesystem.py`，那里用 300 个 skill 做
「没有指数级退化」的哨兵，不做性能基准。）

三条真实收益：

1. **单二进制 → npm 分发 → `npx` 零安装**（§5）。这是「运行一次型」工具的转化率瓶颈，直接打在 Activation 指标上。
2. **`Capability<T>` 把 `Unknown ≠ Zero` 从约定升级成编译期保证**（[ARCHITECTURE.md §3](./ARCHITECTURE.md)）。调用方无法把「拿不到」意外当成空集合用。这是有产品价值的语言选择。
3. **配置格式回到 TOML**，不必为 `tomllib` 抬高 Python 下限。

## 1.4 让这次 port 异常廉价的一个事实

现有测试套件是**语言无关**的。`tests/test_regressions.py:39`：

```python
r = subprocess.run([sys.executable, str(SCAN), "--json", out] + list(extra), ...)
```

15 个用例里只有 `sys.executable, str(SCAN)` 与 Python 绑定，其余全是「往 tempdir 写 fixture → 跑命令 → 解析 JSON → 断言 key」。改一行：

```python
SCAN_CMD = [str(BINARY)]
```

全套原样复用，**这部分测试不需要用 Rust 重写**。这把「重写」降级成「有绿灯保护的移植」。

> **但绿灯范围有限。**这 15 个是回归测试而非特征测试——12 条不变量里只有 6 条被覆盖。必须另配 golden、单元与属性测试，见 §4。

## 1.5 Timebox 与停止规则

```text
┌────────────────────────────────────────────────┐
│  3–5 个开发日内必须达成 golden equivalence      │
└────────────────────────────────────────────────┘
                      │
        ┌─────────────┴─────────────┐
        ↓                           ↓
     达成                        超时
        │                           │
        ↓                           ↓
   继续 §1.6 步骤 4–6         STOP PORTING
                                    ↓
                              回到 Python
                                    ↓
                               继续做产品
```

**不要让「我要打造一个漂亮的 Rust CLI」取代「我要证明有人真的需要 Agent Vitals」。**

超时不是失败，是信息——它说明 §2 的不变量比看上去更纠缠，那么在 Python 里把它们理清、补上测试，本身就是更值钱的工作。

### 若走 Python 路线，重新迁移的触发条件

1. 扫描 500+ skill 的 P95 > 3 秒，或 `watch` 资源占用被实际抱怨
2. JSON schema 稳定至少两个发布周期
3. 可复现构建 + 签名已就位（§6）

语言换不来 Activation / Discovery / Actionability 上的任何一分，而护城河（Diagnostic Knowledge：诊断规则与文案）跨语言可移植。

## 1.6 执行顺序（不得跳步）

```text
1. 建 fixture 语料，用 Python 生成 golden JSON 并提交进仓库   ← §4.2
2. 测试套件指向二进制，保持红灯
3. 逐个点亮，只做 port 不做重设计 —— --json 与 golden 逐字节可比
   ├─ 达成 → 继续
   └─ 超过 timebox → 停止规则（§1.5）
4. 补齐 §4 的单元与属性测试，使 12 条不变量条条有测试
5. 全绿后双实现定型：SKILL.md 主调二进制（不存在则 `npm i -g agent-vitals`）；Python 保留，继续服务 ClawHub skill 形态与开发者
6. 之后才开始加 explain / 诊断引擎等新能力
```

**第 1 步不能省。**`scan.py` 是这次移植唯一的 oracle，Python 不再是唯一运行时之后，等价性只能靠 golden 验证——**先固化 oracle，再让 golden 成为持久化的 oracle**（golden 仍由 Python 与 Rust 两个实现共同比对，见 §6.8）。

**第 3 步是纪律所在。**移植和重设计同时做，绿灯就失去意义了。

## 1.7 关于可审计性

原顾虑：「几百行纯标准库 Python，运行前可以自己读完」是安全工具的资产，二进制会削弱它。

**这个顾虑的适用范围比它看起来窄**——它只对 `git clone` 到 `~/.claude/skills/` 的 skill 形态成立。`pipx install` 从 PyPI 装同样是不透明供应链：信的是 PyPI 与维护者，与信 GitHub Release 的二进制没有本质差别。

补偿路径（写进 README 安装章节）：

- `cargo install agent-vitals` —— 从源码构建
- npm provenance（§6）—— tarball 绑定到具体 workflow + commit

---

# 2. 12 条必须保留的不变量

以下每条现在都由回归测试或代码注释钉着，**且都对应一个真实发生过的缺陷**。模块化重写最容易在这里出问题。

| # | 不变量 | 丢失后果 |
|---|---|---|
| 1 | **磁盘 ≠ 上下文。**预算/冲突/僵尸只按 `loaded` 算 | 「预算超支 143%」假警报，诱导用户改一个根本不需要改的环境变量 |
| 2 | 插件 skill 按 `<plugin>:<name>` 命名空间去重 | 三个插件各带一个 `access` 被报成冲突 |
| 3 | `plugins/cache/` 与 `plugins/marketplaces/` 是同一份 | 每个插件都报一次「重复副本」 |
| 4 | **cited 只排序，永不抑制上报**，`max_severity` 含 cited | 加一句 `For example,` 就能让 critical 静默 |
| 5 | 扫描器自身排除安全扫描 | 自己的规则正则命中自己 |
| 6 | 拆分判据是 `core_tokens` 不是行数 | 结论反向 |
| 7 | `REPO_META`（README/LICENSE/CHANGELOG）不计入 tier2 | 开源 skill 全被算成超大 |
| 8 | 子目录 `.md` 算数据语料，只记字节 | 带文章库的 skill 报 30 万 token |
| 9 | **零触发必须先过年龄闸**，不够天数进 `too_new_to_judge` | 用户删掉昨天刚装的 skill |
| 10 | 覆盖优先级 `enterprise > personal > project > plugin` | 诊断方向完全搞反 |
| 11 | 脱敏必须覆盖 path，且 description 整体丢弃 | 两次真实泄露 |
| 12 | 执行环境拿不到就报 unavailable，**绝不用装机时间或 mtime 代替触发数** | 缺一列的报告有价值，编一列的没有 |

---

# 3. 移植检查清单（Python → Rust）

以下六处**照着直译会静默改变行为**，其中三处直接破坏上表的不变量。

| # | Python 现状 | 直译后果 | 正确做法 |
|---|---|---|---|
| 1 | `redact()` 用了 `(?<=[/\\])` 与 `(?=[/\\]\|$)` | `regex` crate **不支持** lookbehind / lookahead，编译失败 | 改捕获组 `([/\\])user([/\\]\|$)` → `$1<user>$2`，或引入 `fancy-regex`。**影响不变量 11** |
| 2 | `read_text(errors="replace")` 永不失败 | `fs::read_to_string` 遇非 UTF-8 直接 `Err` | 必须 `String::from_utf8_lossy(&fs::read(..))`。否则编码异常的 skill 被**跳过而非扫描**——安全工具里这是静默漏报 |
| 3 | `st_ctime`（Linux 上是 inode 变更时间） | `Metadata::created()` 取 birthtime，老内核 ext4 上还会 `Err` | unix 下用 `MetadataExt::ctime()` 对齐。否则 `installed_days_ago` 变化 → 僵尸 / too-new 分类跟着变。**影响不变量 9** |
| 4 | dict 保持插入顺序 | `serde_json::Map` 默认按 key 重排 | 开启 `preserve_order` feature。否则输出 diff 不可读、快照对比全是噪声 |
| 5 | `"一" <= ch <= "鿿"` 做 CJK 计数 | 语义相同但边界易写错 | `('\u{4e00}'..='\u{9fff}').contains(&ch)`，用测试钉住 token 估算值 |
| 6 | `norm()` 手动把 `\` 换 `/` | 依赖 `Path::display()` 在 Windows 上产出反斜杠 | 保留显式 normalize，所有路径判断走 normalized string |
| 7 | `rglob()` 遍历顺序未排序 | `walkdir` 同样不保证顺序，且与 `rglob` **不一致** | 遍历后显式排序。`findings`、`exec_scripts`、`bundled` 的次序都跟着它走 |

**第 2 条不会报错，只会少扫**——是七条里最危险的一条。

第 7 条是建 golden 语料时发现的：`security_scan()` 与 `scan_skill_dir()` 都直接
枚举 `rglob("*")`，排序键相同的元素之间次序随文件系统而变。**Python 版本已经有
这个问题**，只是没人比对过两次输出。它让快照对比出现无意义的 diff——正好打在
第 4 条（`preserve_order`）想解决的同一个痛点上。`golden_runner.canonicalize()`
目前在测试侧兜底，但**正确的修法是在扫描器里排序**，移植时一并做掉。

技术栈：`clap`(derive) · `walkdir` / `ignore` · `serde_json`（松散配置用 `Value`） · `regex` · `sha2` · `toml`。

---

# 4. 移植期测试策略

## 4.1 现有测试的性质

**15 个用例是回归测试，不是特征测试（characterization test）。**它们证明「没有重新引入 15 个已知缺陷」，**不证明「移植与原实现等价」**。

每个用例都对应一次真实事故——这是优点，也决定了覆盖形状：**只覆盖出过事的地方**。而移植会均匀地打击所有地方。

### 覆盖现状

原有 15 个回归用例只覆盖 12 条里的 6 条。`tests/test_invariants.py`（读 golden 快照）
把缺的补齐，是 §1.6 第 1 步的产物。

| # | 不变量 | 回归用例 | 验收门 |
|---|---|---|---|
| 1 | 磁盘≠上下文，只按 loaded 算 | 无 | ✓ `default` vs `--all` 的预算口径差 |
| 2 | 插件按 `<plugin>:<name>` 去重 | 无 | ✓ 两个插件各一个 `access` |
| 3 | `cache/` 与 `marketplaces/` 是同一份 | 无 | ✓ 同 `plugin_key` → redundant/low |
| 4 | cited 只排序不抑制 | ✓ ×5 | ✓ |
| 5 | 扫描器自身排除 | ✓ ×1（环境相关） | 反向：其余 skill 不得带标记 |
| 6 | 拆分判据是 token 不是行数 | ✓ ×2 | ✓ 901 行/450 tok vs 201 行/20050 tok |
| 7 | `REPO_META` 不计 tier2 | ✓ ×1 | ✓ |
| 8 | 子目录 `.md` 算数据语料 | 无 | ✓ 1.2MB 语料，refs_tokens=0 |
| 9 | 零触发过年龄闸 | ✓ ×2 | ✓ 两个 case 的分类互补 |
| 10 | 覆盖优先级 | 无 | ✓ 三种 kind + effective 层级 |
| 11 | 脱敏覆盖 path | ✓ ×4 | ✓ 含统计量逐一相同 |
| 12 | 拿不到报 unavailable | 无 | ✓ ×2（正向与降级） |

> **验收门（替代覆盖率指标）：12 条不变量，每一条都必须有一个「违反即失败」的测试。**这比百分比可检查，也更贴合本项目的风险形状。

**验收门只读 golden，不跑扫描器**，所以对 Python 与 Rust 两个实现同样有效。它与
golden 全文比对分工不同：**全文比对回答「有没有变」，验收门回答「变的是不是要紧的
那个数」**。移植期前者会因无关差异狂响，后者指出哪条不变量真的破了。

仍然完全无测试的：`est_tokens` 具体数值、`plugin_identity` 三种路径形态的返回值、
`lookup_usage` 裸名回退、`diff_against` 整个函数。这些属于 §4.4 的单元测试层，
移植时在 Rust 侧就地写。

### 第 1 步实际抓到的缺陷

建语料的第一次运行就打出一个真实缺陷，而它正落在当时标着「无测试」的第 12 条上：

> **机器上没有 `~/.claude.json`、且磁盘上有任何插件 skill → 整次扫描 `TypeError` 崩溃。**

`read_harness_config()` 读不到时返回 `(None, {}, {})`，第三个值是 `{}` 不是 `None`，
于是 `plugins_known = harness_cfg is not None` 判成 True，插件分支照常执行，而
`enabled_plugins` 是 `None`。降级分支 `plugin-state-unknown` 早就写好了，只是永远
走不到。真机上 `~/.claude.json` 必然存在，所以它只伤害「其他执行环境」用户——正是
不变量 12 本该保护的那批人。

两点值得记住：

1. **`None` 当「未知」标记会泄漏到每一个消费点。**修的时候发现第二处
   `sorted(enabled_plugins)` 同样会崩。这恰好是 `Capability<T>`
   （[ARCHITECTURE.md §3](./ARCHITECTURE.md)）要解决的问题——在 Rust 里这两处
   都是编译错误，不是运行时崩溃。这条 ADR 因此有了一个具体的、已发生的证据。
2. **语料的价值在写完它之前就兑现了。**缺陷不是 golden 比对发现的，是「为了能
   生成 golden 而必须构造出无执行环境配置的环境」这个动作发现的。

## 4.2 有时间窗口的 oracle

差分测试是移植最强的手段——参考实现就在手边：

```bash
python3 tests/golden_runner.py --update                        # 用 Python 固化
AGENT_VITALS_BIN=target/release/agent-vitals \
    python3 tests/golden_runner.py                             # 二进制比对
```

一次跑通即覆盖上表全部条目，无须逐条写用例。指向哪个实现只差一个环境变量。

> **不能写成 `scan.py --path fixtures`。**`scan.py:650` 是
> `roots = list(DEFAULT_ROOTS) + [("custom", p) ...]`——`--path` 是**追加不是替换**，
> 扫出来的结果里混着开发者本机的 skill，随机器而变，做不了 golden。
> 隔离靠 `HOME=<语料根>` + `cwd=<语料根>/workdir`（project-local 根是相对 cwd 的
> `./.claude/skills`），细节见 [fixtures/README.md](../fixtures/README.md)。

**但它在 `scan.py` 不再是唯一运行时之后不再能靠「再跑一次」验证。**故 golden 文件是它的持久化形态：先用 Python 生成、提交进仓库，之后等价性证据靠「两个实现都比对同一份 golden」持续存在。

> **先固化 oracle，再删除 oracle。**顺序写死在 §1.6 第 1 步。

## 4.3 fixture 语料

移植期最值钱的产出，须覆盖：

- **三种插件路径形态**：`cache/<mkt>/<plugin>/unknown/`、`marketplaces/<mkt>/plugins/<plugin>/`、`marketplaces/<mkt>/external_plugins/<plugin>/`
- **四个层级**各一份，含同名跨层级副本——内容相同 / 内容不同 / 被盖者更新，对应三种 conflict kind
- **frontmatter 边界**：多行 description、值含冒号、引号包裹、缺 `name`、缺 `description`、CRLF
- **畸形输入**：非 UTF-8 字节、截断的 frontmatter、不可读权限
- **附带资源**：带 `references/`、带 `docs/`、带子目录数据语料、带 `README` + `LICENSE`
- **构造的 `~/.claude.json`**：`enabledPlugins` 的 dict 与 list 两种形态；`skillUsage` 的裸名键与 `<plugin>:<name>` 键

## 4.4 四层测试

| 层 | 内容 | 优先级 |
|---|---|---|
| **Golden / 差分** | 上述语料的完整 JSON 快照 | **P0，必须在删 `scan.py` 前完成** ✓ 已完成 |
| **纯函数特征测试** | `est_tokens` · `parse_frontmatter` · `plugin_identity` · `lookup_usage` · `is_cited` · `days_since` · `redact` · `diff_against` | **P0** ✓ 已完成，见下 |
| **Rust 单元测试** | 同上，逐条译成 `#[cfg(test)]` | 移植时对齐上一层的期望值 |
| **属性测试** | 仅两处，见下 | P1 ✓ 已完成（Python 侧用 hypothesis；Rust 侧换 proptest） |
| **降级测试** | 畸形语料不中断扫描（§4.5） | P0 ✓ 已完成 |
| **Fuzz**（cargo-fuzz） | frontmatter 解析器；安全规则应用于任意字节 | P2 |

`tests/test_characterization.py` 直接 import `scripts/scan.py` 把这批纯函数的行为
原样钉住。**它断言具体数值而非范围**——`est_tokens("hello") == 1`，不是 `> 0`；
范围断言在移植时毫无用处。Rust 侧的 `#[cfg(test)]` 就照着这些值写。

写的过程中钉出两处直译会偏的行为：

- **`FRONTMATTER_RE` 尾部的 `\s*\n?` 会吃掉闭合 `---` 之后的所有空行。**
  `body` 从正文首字符开始，不是从 `\n` 开始。`body_lines` 与
  `tier2_core_tokens` 都由 `body` 算出，这段正则写松或写紧，两个数都跟着偏。
- **`days_since(0)` 返回 `None`**（`if not ms` 把 0 当缺失）。移植时容易只判
  null 而放行 0，于是「从未使用」变成「1970 年用过」。

属性测试只做两件事：

1. **脱敏**：任意生成的 skill 名称集合下，输出中不得出现任何真名——**任何字段、任何嵌套层级**
2. `est_tokens` 对任意 Unicode 输入不 panic 且非负

第 1 条值得单列理由：脱敏的三次真实泄露**都是「没想到还有这个字段」**——这正是用例测试覆盖不到、而属性测试专门覆盖的失效模式。**用例只能测你想到的字段。**

`tests/test_properties.py` 用 hypothesis 实现，**是可选依赖**：装了就跑，没装就跳过，
仓库的零依赖性质不变（那条约束针对被分发的扫描器，不是开发期工具）。

```bash
python3 -m venv .venv && .venv/bin/python -m pip install hypothesis
.venv/bin/python -m unittest discover tests
```

写这条属性测试时打出了第三次泄露，一次两处：

| 泄露字段 | 内容 | 为什么白名单接不住 |
|---|---|---|
| `diff_vs_baseline.removed_skills` | skill 名 | 只存在于**基线**，当前 `skills[]` 里根本没有 |
| `namespace` · `plugin_key` · `enabled_plugins` | **插件名与 marketplace 名** | 从来不在 `name`/`dir_name`/`skill` 三个键里 |

`usage_key_matched: "plug-one:skill-023"` 是最直观的证据——skill 名换掉了，插件名原样留着。
内部 marketplace 往往直接就是公司名或团队名。

连带修掉一处更深的问题：替换原本是 `for real, alias: s.replace(real, alias)` 的**顺序**
替换，只要有一个真名是别名的子串（skill 名叫 `in`，别名 `plugin-001`），就会把已脱敏
的部分再改一次。现在改成交替正则**一次扫过、不回头**。

> 白名单 `SKILL_NAME_KEYS` / `PLUGIN_NAME_KEYS` / `PLUGIN_KEY_KEYS` 仍在 `scan.py` 里，
> 但**指望不上它写全**——三次泄露都证明了这点。兜底是属性测试，不是清单。

## 4.5 panic vs 优雅降级

`scan.py` 里到处是 `errors="replace"`、`except OSError`、`.get(k, default)`——**单个 skill 出问题只跳过它，扫描继续**。Rust 的默认姿态相反：一个 `unwrap()` 撞上畸形文件，整次扫描直接终止。

对扫描 200 个 skill 的工具，「死在第 47 个」远比「跳过第 47 个并标注」糟糕。故立硬规矩：

> **扫描路径上不得出现 `unwrap()` / `expect()` / 可能越界的索引。**单个 skill 的任何失败降级为该 skill 的一条 `SV902`，不影响其余。

配套测试：语料中放入畸形 skill（截断 frontmatter + 非 UTF-8 + 不可读权限），断言**其余 skill 全部正常出现在输出里**，且畸形项以诊断形式出现而非静默消失。

这条在 Python 版**几乎**是免费的，在 Rust 版必须显式买——**移植中最容易漏掉的一类差异，因为它在正常语料上永远不显形。**

`tests/test_degradation.py` 立起这套断言。写的时候发现「几乎」二字是必要的：

> **SKILL.md 读不了时，该 skill 从报告里彻底消失，且毫无迹象。**

`scan_skill_dir()` 遇到 `OSError` 返回 `None`，`collect()` 直接跳过。「不影响其余」
这半成立，「畸形项必须现身」这半不成立——用户看到的清点数字是错的，而报告里没有
任何东西表明少了一项。对一个做清点的工具，**静默丢项就是错误答案**。

已加 `unreadable_skills` 顶层字段（含 `name` / `path` / `harness` / `reason`），并同时
写一份到 stderr——只写进 JSON 不够，直接在终端跑的人同样需要知道清点不完整。

> 该字段的 `name` 来自目录名，且这批 skill 不在 `skills[]` 里，**与
> `removed_skills` 是同一个脱敏失效模式**。白名单已覆盖，属性测试兜底。

---

# 5. 模块结构

## 5.1 Python 主线：渐进提取，不改入口

Python 主线采用单向流水线：

```text
CLI options → harness roots → disk inventory → runtime probes → reconciliation
            → pure report → diff → redaction → rendering
```

实现从 `scripts/scan.py` 分阶段提取到标准库包 `scripts/agent_vitals/`。执行环境适配、
发现与 I/O 在边缘；报告计算与诊断保持纯函数；`cli.py` 只负责编排、输出和退出码。
完整模块边界与迁移门见 [PYTHON_REFACTOR_SPEC.md](./PYTHON_REFACTOR_SPEC.md)。

对用户而言，`python3 scripts/scan.py ...` 始终是兼容入口。迁移不要求安装包或改用
`python -m`，每一阶段都必须保持 flags、JSON schema、排序、降级行为与退出码。
最终 `scan.py` 只保留兼容导出和 `agent_vitals.cli.main()` 调用；达到最终阶段前，
架构门禁只约束已经存在的模块，不用未完成的目录清单制造假失败。

ClawHub 产物必须递归包含整个 `scripts/agent_vitals/`，同时排除
`__pycache__`、`.pyc` 与 `.pyo`。打包 CI 必须切换到 `dist/agent-vitals`，在仓库源码
不进入 `PYTHONPATH` 的条件下执行 `--version` 与 `--help`；只有源码树能运行、产物
缺模块时必须在发布前失败。

## 5.2 Rust 目标结构

```text
src/
├── main.rs
├── cli.rs             clap derive
├── harnesses/             mod(trait) · claude · codex · cursor · generic
├── model/             skill · capability · diagnostic · snapshot
├── scan/              discovery · frontmatter · context · security
├── analyze/           usage · overlap · cost · lifecycle
├── diagnostics/       engine · rules
├── commands/          doctor · list · explain · overlap · diff · cost · snapshot · plan
├── output/            terminal · json
└── redact.rs

tests/                 现有 Python 集成套件，SCAN_CMD 指向二进制（§1.4）
fixtures/              §4.3 语料
golden/                §4.2 快照
npm/                   主包 shim.cjs + 各平台包模板（§6）
```

模块划分与 v0.1 的 Python 结构一致，**仅换语言**——保持概念映射不变，让移植是逐文件的机械操作而非重设计。

---

# 6. npm 分发

## 6.1 为什么 npm 是主推渠道

**渠道与受众高度重合**：agent-vitals 的用户按定义就是 Agent CLI 的用户，而 Claude Code 自身即 `npm install -g @anthropic-ai/claude-code`，Codex CLI、Gemini CLI 同理。**Node 在目标用户中具有极高覆盖率。**

> 不是 100%——存在 standalone binary 安装路径与其他执行环境的用户。npm 是**覆盖率最高的单一渠道**，不是唯一渠道；§6.6 的其余四条并存正是为了这部分人。

```bash
npx agent-vitals                              # 零安装试用
npx agent-vitals doctor --fail-on critical    # CI，无需 setup-rust / setup-python
```

对「运行一次型」诊断工具，`npx` 是转化率的天花板——用户不需要决定「要不要装一个工具」，只需要决定「要不要跑一条命令」。

> `agent-vitals` 与 `@agent-vitals` scope 在 npm 上均未被占用（2026-08 核实），应尽早占名。

## 6.2 打包方式：optionalDependencies，禁止 postinstall 下载

| 方案 | 结论 |
|---|---|
| postinstall 从 GitHub Releases 下载 | **禁用** |
| optionalDependencies + 每平台一个包 | **采用**（esbuild / biome / swc / oxlint 同款） |

禁用 postinstall 的三条理由：

1. `npm install --ignore-scripts` 直接失效——该 flag 在安全意识强的组织和部分 CI 里是默认开启的
2. 离线 / 内网环境装不了
3. **一个扫描供应链风险的工具，自己要求装机时联网执行脚本拉二进制**——观感自毁

optionalDependencies 方案下二进制**在 tarball 里**，被 npm 的 integrity hash 与 provenance 证明一并覆盖。

```text
agent-vitals                    主包，只含一个 JS shim
├── @agent-vitals/darwin-arm64
├── @agent-vitals/darwin-x64
├── @agent-vitals/linux-x64      静态 musl，兼容 glibc 与 Alpine
├── @agent-vitals/linux-arm64
└── @agent-vitals/win32-x64
```

平台包用 `os` / `cpu` 让 npm **只装匹配的那一个**：

```json
{ "name": "@agent-vitals/darwin-arm64", "os": ["darwin"], "cpu": ["arm64"], "files": ["bin/"] }
```

## 6.3 shim：退出码必须原样透传

```js
#!/usr/bin/env node
"use strict";
const { spawnSync } = require("child_process");

const TARGETS = {
  "darwin arm64": "@agent-vitals/darwin-arm64",
  "darwin x64":   "@agent-vitals/darwin-x64",
  "linux x64":    "@agent-vitals/linux-x64",
  "linux arm64":  "@agent-vitals/linux-arm64",
  "win32 x64":    "@agent-vitals/win32-x64",
};

const key = `${process.platform} ${process.arch}`;
const pkg = TARGETS[key];
if (!pkg) {
  console.error(`agent-vitals: unsupported platform ${key}`);
  process.exit(2);                                  // 2 = 工具自身错误
}

const exe = process.platform === "win32" ? "agent-vitals.exe" : "agent-vitals";
let bin;
try {
  bin = require.resolve(`${pkg}/bin/${exe}`);
} catch {
  console.error(`agent-vitals: ${pkg} 未安装（optionalDependencies 可能被跳过）`);
  process.exit(2);
}

const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (r.error)  { console.error(r.error.message); process.exit(2); }
if (r.signal) { process.exit(2); }
process.exit(r.status);                             // 原样透传 0 / 1 / 2
```

**最后一行是契约。**[ARCHITECTURE.md §6.2](./ARCHITECTURE.md) 把退出码定义成 CI 的正式接口；shim 随手写成 `process.exit(0)` 或忘了透传，整个 `--fail-on` 机制就废了。**这一条要有独立测试。**

## 6.4 四个打包陷阱

1. **Linux 只发一个静态 musl 包。**`x86_64-unknown-linux-musl` 全静态二进制在 glibc 系统上照样跑，一个包覆盖 Alpine 与 Ubuntu，绕开 npm 对 libc 检测支持不一致的整个问题。静态 musl 最常见的坑是 DNS/NSS——**而本工具不联网**，天然不受影响。
2. **可执行位。**npm tarball 保留文件 mode，`chmod +x` 要在 `npm pack` 之前完成，并用 `npm pack --dry-run` 核对一次。这个错误只在别人机器上暴露。
3. **shim 用 CJS（`.cjs`）。**`require.resolve` 在 ESM 下要走 `import.meta.resolve`，平白增加 Node 版本兼容面。shim 是最不该出问题的一环，保持最笨的写法。
4. **平台包不要自己声明 `bin`**，只有主包声明，否则产生冲突的符号链接。

## 6.5 签名：npm provenance

```yaml
permissions:
  id-token: write
- run: npm publish --provenance --access public
```

生成 sigstore 证明，把 tarball 绑定到具体 workflow + commit + 源码仓库。**这是「可复现构建 + 签名」里成本最低的实现**，比 brew tap 或裸 GitHub Release 都省事。要求 `package.json` 含正确的 `repository` 字段。

> 若改用 `dist`（原 cargo-dist）自动生成 npm installer：**发布前确认其产物是「二进制打进 tarball」还是「装机时下载」**。若为后者，落回 §6.2 禁用的那条路。手写这套约 40 行加一份 CI matrix，可控性更高。

## 6.6 渠道矩阵

| 渠道 | 场景 | 优先级 |
|---|---|---|
| `npx agent-vitals` | 首次试用、CI | **主推** |
| `npm i -g agent-vitals` | 重复使用 | **主推** |
| `brew install` | macOS 习惯用户 | P1 |
| `cargo install` | Rust 用户；**从源码构建的可审计路径** | P1 |
| GitHub Release 裸二进制 | 内网 / 离线 | P1 |
| **dsh bundle** | DSH 用户；形态与上面五条都不同，见 §6.6.1 | DSH-1 |

## 6.6.1 dsh bundle：profile layer，不是包也不是目录

上面五条渠道分两类：**装一个二进制**（npx / npm / brew / cargo / Release），
或**放一个 skill 目录**（§6.7）。DSH 是第三类：装一个 **profile layer**。

识别它的只有 `package.json` 里的一个字段：

```json
{
  "name": "dsh-agent-vitals",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

没有这个字段的包照样能装，但只是普通依赖，不激活任何层。安装：

```sh
dsh plugin --profile web add dsh-agent-vitals
```

### 三条硬约束

**一、只发 npm 预构建，绝不走 git 安装。** `dsh plugin` 转发给 pnpm，从 git 装
只下源码不跑构建，因此包要靠 `prepare` 脚本在安装期自建；而 pnpm ≥10 会拒绝
执行它，直到用户在 profile 的 `pnpm-workspace.yaml` 里写 `allowBuilds`。DSH 官方
文档对这个授权的定性是：**「permission to execute the package's code on your
machine at install time, outside any sandbox the agent runs under」**。

一个审计供应链风险的工具要求用户开这个口子，是自相矛盾的。这与 §6.2 禁用
postinstall 下载是同一条原则的同一次应用，不是新增约束。

**二、bundle 里不得有扫描器副本。** 它只是约 20 行 JS：向 `ctx.skills` 注册一个
provider，`resourceBase` 指向 skill 正文，扫描仍由 PATH 上的 `agent-vitals` 二进制
执行。vendored 一份 `scan.py` 进去会造出第三个扫描器消费者——差分护栏（§6.8）
只对齐 Python 与 Rust 两个实现，第三个副本不在护栏内，会静默发散。

> 2026-08 曾按「monorepo 内建包 + vendored 全套 `scan.py`」的形态搭过一次原型，
> 两条都违反了。留档是为了记住失败原因：把分发问题当成了集成问题。

**三、不做构建步骤。** 纯 JS 直接发布，连 `prepare` 都不需要存在——约束一就
自动成立，用户零授权。20 行胶水不值得为它引入一条构建链。

### 与 skill 形态的关系

一个仓库同时提供两种形态是生态里的常见做法（`liustack/modlens` 的说法是
「on the skill harnesses it is exactly one skill folder, on dsh exactly one
plugin」）。对本仓库意味着：根目录的 `SKILL.md` 与 `scripts/` 服务前五个执行环境，
`dsh/` 子目录是第六个执行环境的 bundle，**两者共用同一个二进制，没有第二份实现**。

发布后给仓库打上 GitHub `dsh-plugin` topic（DSH README 明确要求，是该生态的
发现入口）。

## 6.7 In-harness Skill 形态的安装

双实现并行下，in-harness skill 形态**继续以 Python 为主**（`python3 scripts/scan.py`，`git clone` 完就能用，ClawHub 打包走这条）。二进制形态（`agent-vitals`）服务 npm / brew / cargo / Release，SKILL.md 第 1 步写成「检测二进制，不存在则 `npm i -g agent-vitals`」，Agent 自己会执行。

> **双维护的可行性建立在差分护栏上（§6.8）。**「两套实现必然发散」曾经是「绝对不做两套」的理由；现在 `differential` 在当天抓出任何发散，而不是让它静默累积，所以「同时维护两套」从禁令变成「在护栏内做」。护栏失效的那天，本节退回单实现。

## 6.8 永久并行维护，靠差分护栏兜住

两套实现并行，发散是必然趋势——§6.7 的警告不是空话。本仓库的答案不是
「避免两套」，而是「让发散活不过一次 CI」：`main` 上 Python 与 Rust
**永久并行**，差分护栏从「移植期的临时脚手架」升级成**永久契约**。

- Rust 二进制（`agent-vitals`）服务 npm / brew / cargo / Release 这些「装一个
  二进制」的渠道；
- Python（`scripts/scan.py`）服务 ClawHub 的 in-harness skill 形态，也便于不同
  语言的开发者阅读与贡献。

**发散被当天发现是这条路的全部前提。**代价已经演示过一次：`main` 一次合并
加了 656 行，Rust 立刻落后约 50 个输出键——那时护栏还没就位，发散静默累积。
现在护栏在，任何一次 `differential` 变红都必须当天处理：

| 护栏 | 位置 |
|---|---|
| 双实现跑同一份 golden，任一不一致即红 | `verify.yml` 的 `differential` job |
| 集成套件指向二进制再跑一遍 | 同上，靠 `AGENT_VITALS_BIN` |
| 假执行环境验运行时适配器的成功路径 | `tests/test_harness_stubs.py` |
| 跨平台复现（macOS + Linux） | `reproducible` job |
| `clippy -D warnings` 守 §4.5 的「扫描路径不得有 unwrap」 | `rust` job |

**本节永久生效（2026-08 修订，双实现永久并行）。**不再有「删除 Python」的
退出点：Rust 二进制服务 npm / brew / cargo / Release，Python 服务 ClawHub
skill 形态与开发者。任何一次 `differential` 变红都必须当天处理 —— 放着不管，
这一节就退化成 §6.7 警告的那种情形。

---

# 7. CI

> 排期 **P1**，依赖 P0.5 的 `--json` 与退出码（[PRODUCT.md §5.0](./PRODUCT.md)）。

```text
Developer → 改 SKILL.md → PR → Agent Vitals CI
```

```text
✕ SV402  新增 routing overlap
         github ↔ github-tools
         相似度 0.61 → 0.86

✕ SV002  描述预算将溢出
         14,102 → 15,318 chars
         约 2 个 skill 可能变得不可发现
```

**CI 场景对 `diff` 的依赖高于 `doctor`**：关键不是「现在有几个问题」，而是「**这个 PR 新增了什么问题**」。

## 7.2 本仓库自身的 CI

移植期必须在 CI 里跑的：

```text
1. cargo test                        单元 + 属性测试
2. python3 tests/test_regressions.py 集成套件（指向二进制）
3. golden diff                       与 §4.2 快照逐字节比对
4. 畸形语料不中断扫描                 §4.5
5. shim 退出码透传                    §6.3
6. npm pack --dry-run                可执行位与文件清单
```

第 3、4、5 条是本项目特有的，通用模板不会包含。

---

# 8. Release

```text
tag v1.0.0
   ↓
GitHub Actions matrix build
   ├─ aarch64-apple-darwin
   ├─ x86_64-apple-darwin
   ├─ x86_64-unknown-linux-musl      静态
   ├─ aarch64-unknown-linux-musl     静态
   └─ x86_64-pc-windows-msvc
   ↓
npm publish --provenance   （平台包先发，主包后发）
   ↓
GitHub Release 附裸二进制
   ↓
Homebrew tap 更新
```

**发布顺序不能反**：平台包必须先于主包发布，否则主包的 `optionalDependencies` 指向不存在的版本，`npx` 在窗口期内会失败。

---

# 9. ADR-002：中文分词（jieba）与双实现的取舍

## 9.1 结论

> **先不加。但拒绝的理由不是「没用」，而是「它会逼出一个还没做的决定」。**

`overlap` 的分词现在是「英文词 + CJK 字符二元组」。换成 jieba **确实能改善中文
语料的召回**（实测见 §9.2），但它只能进 Rust 侧，而 Python 侧没有标准库等价物 ——
所以这不是算法题，是「双实现逐字节一致」的约束题：加进去要么打破差分护栏，
要么在 Python 侧重写一遍分词器。2026-08 修订后双实现永久并行（§6.8），这条约束
是长期的，不再是「等 Rust 唯一化」的临时题。

复现实验：`experiments/jieba-overlap/`。它是带自己 `Cargo.toml` 的嵌套包，
cargo 会自动把它排除在主包之外（实测 `cargo package --list` 里没有它的文件），
所以 **jieba-rs 不会进扫描器的依赖树** —— 只有主动跑实验时才拉取。

## 9.2 实测：收益是真的，但全在中文那一侧

真机语料 137 个已加载 skill，其中 35 个以中文为主（67% 是纯英文）。

| 配方 | 空集 | 均词数 | ≥0.25 的对数 |
|---|---|---|---|
| 当前实现（字符 bigram） | 0 | 34.0 | 13 |
| **提案原版（只留 v/vn/n/nz）** | **98** | 8.2 | 2 |
| jieba + 保留 `eng` | 0 | 20.8 | 16 |

**提案原版不可用**：jieba 把每个英文词标成 `eng`，词性过滤会把 137 个 skill 里的
98 个变成空集。`apple-notes ↔ obsidian` 这类真竞争直接消失。必须保留 `eng`。

只看那 35 个中文 skill，差距才显出来：

| skill 对 | 字符 bigram | jieba |
|---|---|---|
| tencent-docs ↔ tencent-saas-docs | 0.860 | 0.849 |
| design-token ↔ doc-typeset | 0.199 | **0.269** |
| weixinpay-feedback ↔ weixinpay-register | 0.120 | **0.262** |
| recommend-connectors ↔ recommend-experts | 0.216 | **0.250** |
| **≥0.25** | **1 对** | **4 对** |

原因是字符 bigram 会切出大量跨词边界的碎片：

```
万物 · 下意 · 不处 · 于模 · 于用 · 仅支 · 以下 · 出以      ← 一半是碎片
专家 · 仓库 · 修改 · 创建 · 合规 · 审查 · 导入            ← jieba
```

碎片几乎不会在两个 skill 之间相交，但**每一个都进并集** —— 于是系统性地压低了
所有中文对的 Jaccard。这是一个结构性漏报源，不是噪声。

## 9.3 成本：词典加载比整次扫描还贵

| | 现在 | 加 jieba |
|---|---|---|
| 二进制 | 3.0 MB | 5.5 MB |
| `Jieba::new()` 加载词典 | — | **~100 ms** |
| 整次扫描总耗时 | **30–70 ms** | — |

对一个短命 CLI，词典加载是主导成本，直接加上去就是整体慢 2–4 倍。
缓解办法是**语料里没有 CJK 就不初始化** —— 纯英文用户零成本。

顺带否掉提案的另一半：**重叠系数（min 作分母）不是漏报修复，是误报发生器**。
`重叠 ≥0.5 且 Jaccard <0.25` 筛出 3 对，其中 `mmx-minimax-cli (6 词) ↔
web-video-presentation (187 词)` 这种是「短描述写得笼统」而非路由竞争。
另外两对（同厂商的 minimax、同族的 github-releases）倒是真的 ——
所以它值得作为**单独标注的第二信号**，但不能替换 Jaccard。

## 9.4 什么时候该翻案

这条 ADR 会过期。满足任一条就重跑 `experiments/jieba-overlap/` 并改结论：

1. **双实现约束消失**（曾以「Rust 成为唯一实现」为 §6.8 的退出条件）—— 双实现
   约束消失，jieba 的唯一代价就只剩启动耗时，而那有 lazy-init 可解。2026-08
   修订后双实现**永久并行**，这一条不再可能触发，仅作历史留存。
2. **语料的中文占比显著上升** —— 本次是 26%（35/137）。如果某个执行环境的 skill
   以中文为主，§9.2 那 4 倍差距会直接作用在主路径上。
3. **扫描器变成常驻进程**（watch / LSP 形态）—— 词典加载只付一次，§9.3 的
   主要成本消失。

反过来，**不构成翻案理由**的：「jieba 分词质量更好」。它确实更好，但 §9.2 已经
量化过收益边界 —— 在当前语料上是 3 对中文漏报，不是普遍性提升。

## 9.5 记一次判断失误

第一轮我没有跑实验就下了结论：「67% 是英文，所以 jieba 对这个语料没用」。
前半句是事实，后半句是**从事实跳到结论**时漏掉了「剩下 33% 里发生了什么」。
实测出来中文那侧的漏报是 4 倍差距。

留下 `experiments/jieba-overlap/` 的直接原因就是这个：**一个靠推理得出的否定
结论，必须附带推翻它的方法。**
