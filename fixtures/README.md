# Fixture 语料

移植期最值钱的产出（[ENGINEERING.md](../docs/ENGINEERING.md) §4.3）。
`golden/` 下的快照全部由这份语料生成，它是 Python → Rust 等价性的唯一凭据。

```bash
python3 fixtures/generate.py --into /tmp/fx --clean   # 建树
python3 tests/golden_runner.py --update               # 生成 golden
python3 tests/golden_runner.py                        # 比对
python3 -m unittest tests.test_invariants             # 12 条验收门
```

## 为什么不能用 `--path`

`scan.py:650` 是 `roots = list(DEFAULT_ROOTS) + [("custom", p) for p in args.path]`
—— **`--path` 是追加，不是替换**。`scan.py --path fixtures` 扫出来的东西里混着
开发者本机的 skill，输出随机器而变，做不了 golden。

正确做法是 **HOME 隔离**：语料构造成一棵完整的 home 树，用 `HOME=<root>` 跑，
`DEFAULT_ROOTS` 里那些 `~/...` 整体落进语料。project-local 根是 `./.claude/skills`
（相对 cwd），所以还要 `cwd=<root>/workdir`。两者都由 `tests/golden_runner.py` 处理。

> 路径必须先 `resolve()`。macOS 上 `/tmp` 是 `/private/tmp` 的软链，而 `classify()`
> 拿未 resolve 的 `HOME_N` 与 `skill_dir.resolve()` 做前缀比较——根路径没 resolve
> 的话，personal 层会被误判成 unknown，整份 golden 静默错位。

## 语料 → 不变量对照

| 目录 | 覆盖 | 判别点 |
|---|---|---|
| `alpha` `beta` | 基线 | `skillUsage` 的 dict 形态与裸整数形态 |
| `sparse-long` / `dense-core` | **6** 拆分判据 | 901 行 450 tok vs 201 行 20050 tok——按行数判会反 |
| `with-readme` | **7** REPO_META | 20k 字符 README，`tier2_refs_tokens` 必须为 0 |
| `with-refs` | 参考文档 | `references/` + `docs/` + 与 SKILL.md 同级，三处都计入 |
| `with-corpus` | **8** 数据语料 | `articles/` 下 1.2MB，只记字节不计 token |
| `ev-plain` `ev-example` `ev-quote` | **4** cited 不豁免 | 后两者 `max_severity=critical` 而 `uncited=none` |
| `with-scripts` | 安全 | 可执行位、`scripts/` 扫描、外部 URL（`example.com` 需被排除） |
| `fm-edge` | frontmatter | 引号包裹、值含冒号、续行 |
| `fm-no-name` `fm-no-desc` | frontmatter | `has_name` / `has_description` 为 false 的分支 |
| `fm-crlf` | frontmatter | CRLF 行尾 |
| `fm-truncated` | 畸形 | 只有开头 `---`，没有闭合 |
| `fm-binary` | **畸形（最危险）** | 非 UTF-8 字节。Python `errors="replace"` 照常扫描；Rust 直译成 `fs::read_to_string` 会 `Err`，**整个 skill 静默消失**（移植清单第 2 条） |
| `dup-identical` ×3 | **10** 优先级 | enterprise + personal + project，同内容 → `redundant`/low，effective=enterprise |
| `dup-shadowed` ×2 | **10** | project 更新但不生效 → `shadowed_newer`/**high** |
| `dup-override` ×2 | **10** | personal 更新且生效 → `intentional_override`/medium |
| `plug-one` `plug-two` `plug-three` | 插件三形态 | `cache/*/unknown/`、`marketplaces/*/plugins/`、`marketplaces/*/external_plugins/` |
| `access` ×2 | **2** 命名空间 | 两个插件各一个，**不得**报成冲突 |
| `dup-tool` ×2 | **3** cache/marketplaces | 同插件两份拷贝 → 同 `plugin_key` → `redundant`/low |
| `plug-off` | **1** 磁盘≠上下文 | `enabledPlugins` 里显式 false，在磁盘上不进预算 |
| `codex-only` `cursor-only` | **1** | 其他执行环境，`loaded_reason=other-harness:*` |
| `.claude.json` | **12** 执行环境数据 | `enabledPlugins` 的 dict 与 list（`projects` 下）两种形态；`skillUsage` 的裸名键与 `<plugin>:<name>` 键；`ghost-skill` 是有用量记录但磁盘上不存在的孤儿 |

`managed-enterprise/` 放在 `~/.claude/skills` **之下**是有意的：`DEFAULT_ROOTS` 里没有
`/etc/claude/skills` 这类系统路径，所以 enterprise 级别只有在 skill 恰好落在某个被扫根
下、且路径含 `enterprise` / `/managed` / `/etc/` 字样时才会被识别。语料照实反映这个限制。

## 两处覆盖不到的地方

**不变量 5（扫描器自身排除）**——语料里的 skill 按定义不是扫描器自身，构造不出来。
真正的覆盖在 `test_regressions.TestScannerExcludesItself`，而那条依赖本仓库被装在
扫描根下（见 CLAUDE.md）。`test_invariants` 只能反向钉住字段契约：其余 skill 一律
不得带 `self_excluded`，防止移植时把它默认成 `true` 而静默关掉全部安全扫描。

**不可读权限（§4.5）**——`chmod 000` 的行为取决于跑测试的是不是 root，进 golden 会
让 CI 与本地结论不同。故不放进语料，留给专门的降级测试并在 root 下跳过。

## 三处不可消除的不确定性

1. **`installed_days_ago` / `last_used_days_ago`** 由 `time.time()` 参与计算，
   而 `st_ctime` 无法设定——新生成的文件永远是「今天装的」。`golden_runner.py`
   把这两个字段抹成 `<VOLATILE>`。年龄闸改由 `default` 与 `zombie-age-0` 两个
   case 的分类差异覆盖（0 僵尸/26 too_new ↔ 26 僵尸/0 too_new）。
2. **目录遍历顺序**。`rglob` 不保证顺序（Rust 的 `walkdir` 同样不保证），
   排序键相同的元素之间会抖。`canonicalize()` 按 `scan.py` 自己的排序键重排、
   再拿 name/path 兜底——**不是整体按名字排序**，那会把排序语义一起抹掉，
   golden 就测不出排序错误了。
3. **绝对路径**。语料根替换为 `<FIXTURES>`。

## 改了 scan.py 之后

golden 会红。**先确认差异是不是预期的**，再 `--update`。
盲目 `--update` 等于把 oracle 改成「当前行为」，这条测试就失去全部意义了。

## DSH 会话库（触发证据，独立于上面的扫描语料）

`dsh/` 目录是另一类 fixture：手写的 DSH 会话日志（JSONL，DSH 默认的
`session-persistence-jsonl` 后端），供 `adapters/dsh.py` 离线读「触发证据」用，
**不进入扫描器的 golden**。`dsh/build_dsh_session_fixture.py`（纯标准库）生成
`dsh/complete.jsonl` 与 `dsh/incomplete.jsonl`；格式逐字段对应关系见 `dsh/README.md`。

## DSH 目录树（skill 目录，C1，独立于上面的扫描语料）

`dsh/skills/` 是 C1 的语料：一棵确定性的 dsh 执行环境 skill 目录树，供未来的
`harness-dsh` golden 与 A7（跨 scope 层重名不算冲突）判定用。
`dsh/skills/build_dsh_skills_fixture.py`（纯标准库）生成这棵树；它**不进
`fixtures/generate.py` 的主树**——`~/.agents/skills` 与 OpenClaw 共享，放进主树
会改掉现有 `harness-openclaw` 等 golden。每一处重名的「同层/跨层」、root、rank 与
预期冲突见 `dsh/skills/README.md`。
