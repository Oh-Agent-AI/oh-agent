#!/usr/bin/env python3
"""Golden / 差分测试（ENGINEERING.md §4.2、§1.6 第 1 步）。

作用：把 `scan.py` 当前的行为**冻结**成可提交的快照。移植期用它做差分，
`scan.py` 删掉之后，等价性证据仍然留在仓库里。

    先固化 oracle，再删除 oracle。

跑法：
    python3 tests/golden_runner.py              # 与 golden/ 比对
    python3 tests/golden_runner.py --update     # 重新生成 golden（改了 scan.py 才用）
    python3 tests/golden_runner.py --diff       # 失败时打印首个差异的上下文

指向 Rust 二进制（§1.6 第 2 步之后）：
    AGENT_VITALS_BIN=target/release/agent-vitals python3 tests/golden_runner.py

被扫描器指向哪个实现，唯一区别就是这一个环境变量——测试本身不需要改。
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from env_helpers import isolated_home_env

ROOT = Path(__file__).resolve().parent.parent
GEN = ROOT / "fixtures" / "generate.py"
GOLDEN_DIR = ROOT / "golden"

# DSH 的语料与主树分开建（fixtures/dsh/skills/build_dsh_skills_fixture.py）：
# ~/.agents/skills 与 OpenClaw 共享，放进主树会把 harness-openclaw 等 golden 改掉。
DSH_GEN = ROOT / "fixtures" / "dsh" / "skills" / "build_dsh_skills_fixture.py"
# DSH 触发证据（log）与 probe 快照。golden.jsonl 的目录名与 dsh 目录树**对齐**，
# 这样 log 证据下 skill 会 loaded=true、never_triggered 非空 —— 空列表钉不住
# 交集的判别语义（空交集 == 并集 == 任一个为空，全都能通过）。
DSH_SESSION_LOG = ROOT / "fixtures" / "dsh" / "golden.jsonl"
# probe 快照（A11）：schema_version / producer 必须过 dsh.py 的版本闸。
DSH_SNAPSHOT = {
    "schema_version": "1.0",
    "producer": "dsh-agent-vitals",
    "observer": None,
    "skills": [
        {"name": "shared-tool", "description": "Shared tool from project-dsh (rank 100)"},
        {"name": "user-only", "description": "Unique skill in user-dsh (rank 400)"},
    ],
    "complete": True,
    "written_at": "2024-01-01T00:00:00Z",
}

FIXTURE_GEN_BY_CASE = {
    "harness-dsh": DSH_GEN,
    "harness-dsh-log": DSH_GEN,
    "harness-dsh-probe": DSH_GEN,
}

# 扫描器命令。默认 Python oracle；设 AGENT_VITALS_BIN 即切到二进制。
# 必须解析成绝对路径：下面把扫描器的 cwd 设成语料目录，相对路径在那里
# 解析不到。CI 上就是这么挂的（本地一直传 $PWD/... 所以没显形）。
BIN = os.environ.get("AGENT_VITALS_BIN")
if BIN:
    BIN = str(Path(BIN).resolve())
SCAN_CMD = [BIN] if BIN else [sys.executable, str(ROOT / "scripts" / "scan.py")]

# 每个 case 是 (golden 文件名, 额外参数, 是否需要执行环境配置)
#
# 描述预算与触发数据是 **Claude Code 专有**的：默认的 --harness all 下两者都报
# not-available，因为把多个执行环境的预算加总起来没有意义（见输出里的
# cross_harness_note）。所以凡是验这两块的 case 都必须显式 --harness claude-code，
# 否则测的是「多执行环境模式下正确地拒绝回答」，而不是那两块本身。
CASES = [
    ("default",       [],                              True),
    ("all",           ["--all"],                       True),
    ("claude-code",     ["--harness", "claude-code"],          True),
    ("claude-code-all", ["--harness", "claude-code", "--all"], True),
    ("zombie-age-0",  ["--harness", "claude-code", "--zombie-age", "0"], True),
    ("redacted",      ["--redact", "--redact-names"],  True),
    # 执行环境配置缺失 —— 不变量 12：拿不到就报 unavailable，绝不编造
    ("no-harness-config", [],                             False),
    # cwd 就是语料根 —— 此时 `./.claude/skills` 与 `~/.claude/skills` 指向
    # **同一个目录**。不按 resolve 后的路径去重的话，同一批 skill 会被扫两遍，
    # 进而被当成「内容相同的两份副本」而**凭空报出一个不存在的冲突**。
    # 这个 case 是真机上踩出来的：从 home 跑才会显形，从 workdir 跑永远不会。
    ("cwd-is-home",   ["--harness", "claude-code"],       True),
    # 单执行环境分支各自有独立的预算口径与文案。没有这两个 case 时，
    # `--harness codex` 的 policy 文案在移植中悄悄漂移了一句都没人发现 ——
    # golden 只覆盖跑过的分支。
    ("harness-codex",    ["--harness", "codex"],             True),
    ("harness-openclaw", ["--harness", "openclaw"],          True),
    ("harness-workbuddy", ["--harness", "workbuddy"],        True),
    # DSH 三态证据源（evidence_recency）：none（文件系统推断）/ log（会话日志）/
    # probe（注册表快照）。三个 case 各钉一种 —— golden 只覆盖跑过的分支。
    #   harness-dsh       无证据 → 全 unknown，evidence_recency="none"
    #   harness-dsh-log   会话日志 → 目录名对齐，loaded=true，never_triggered 非空
    #   harness-dsh-probe 快照 → catalog-visible / not-in-catalog 分流，recency="probe"
    ("harness-dsh",       ["--harness", "dsh"],              False),
    ("harness-dsh-log",   ["--harness", "dsh"],              False),
    ("harness-dsh-probe", ["--harness", "dsh", "--runtime-json", "{root}/snapshot.json"], False),
    # **diff_vs_baseline 此前 0/11 覆盖。**验收时在这个洞里一次找出三处双实现
    # 分歧：added_skills 的形状、比对键只按 name（同名不同命名空间被并成一条）、
    # usage_delta 少三个字段。golden 只覆盖跑过的分支 —— 这一条把 diff 也钉住。
    # 基线是手写的 fixtures/diff-baseline.json，刻意造出新增 / 消失 /
    # 触发增量 / 同名不同命名空间四种情况。
    ("diff-baseline", ["--harness", "claude-code", "--baseline", "{root}/baseline.json"], True),
]

# 个别 case 需要放开某个探测。
#
# WorkBuddy 的 builtin 发现读的是 `~/.workbuddy/plugins/...` —— 在 HOME 隔离
# 下它**本来就是确定的**，语料里放什么就读到什么，不碰真机。默认关掉只是
# 因为 main 的回归套件用真实 HOME 跑。这个 case 要验的正是它，故单独打开。
#
# 对比 Codex / OpenClaw：那两个要起子进程问 PATH 上的可执行文件，HOME
# 隔离拦不住，**永远不能在 golden 里打开**。
ENV_BY_CASE = {
    "harness-workbuddy": {"AGENT_VITALS_DISABLE_WORKBUDDY_BUILTINS": "0"},
    # OpenClaw 的**根发现**读的是语料里的 ~/.open*，在 HOME 隔离下确定；
    # 运行时探测（起子进程问 PATH 上的 openclaw）**仍然关着** ——
    # 那个 HOME 隔离拦不住，永远不能在 golden 里打开。
    "harness-openclaw": {"AGENT_VITALS_DISABLE_OPENCLAW_RUNTIME": "1"},
    # DSH 会话日志证据来自环境变量（真机自动发现留后续）。指向语料根内的副本，
    # scrub 会把路径抹成 <FIXTURES>，不泄漏真机路径。
    "harness-dsh-log": {"AGENT_VITALS_DSH_SESSION_LOG": "{root}/session.jsonl"},
}

# HARNESS_MANIFEST_DSL_SPEC §8.1：generic 插件执行环境 case——**不走** scan.py 的
# `--json FILE` 扫描器契约，走 `manifest-validate` 的 stdout JSON 契约（Rust /
# Python 两侧各自实现同一负载，本 runner 负责钉字节）。fixture 文件内联在
# 这里（语料生成器 generate.py 不掺和），写入隔离 HOME 后 discovery 走
# manifest 的 `~/data`。
PLUGIN_FIXTURE_MANIFEST = {
    "manifest_version": 1,
    "slug": "zcode",
    "display": {"name": "ZCode"},
    "discovery": {"roots": ["~/data"], "include": ["model-io-sess_*.jsonl"]},
    "source": {"format": "jsonl"},
    "session": {"from": "filename", "pattern": "^model-io-sess_(?P<id>.+)\\.jsonl$"},
    "recipe": "request-usage-anthropic-v1",
    "overrides": {
        "event_ts": "completedAt",
        "model_raw": "model.modelId",
        "provider_raw": "model.providerId",
        "uncached_input_tokens": "response.providerMetadata.anthropic.usage.input_tokens",
        "cache_read_tokens": "response.providerMetadata.anthropic.usage.cache_read_input_tokens",
        "output_tokens": "response.providerMetadata.anthropic.usage.output_tokens",
        "provider_request_id": "requestId"
    },
    "event_key": {"paths": ["requestId", "attempt"]},
    "billing": {"policy": "lock:metered_estimate"},
}


def _plugin_fixture_row(request_id, attempt, input_tokens):
    import json as _json
    return _json.dumps({
        "requestId": request_id, "attempt": attempt,
        "completedAt": "2026-09-19T15:18:41.337Z",
        "model": {"modelId": "GLM-5.3", "providerId": "builtin:bigmodel-coding-plan"},
        "response": {
            "usage": {"inputTokens": input_tokens + 5},
            "providerMetadata": {"anthropic": {"usage": {
                "input_tokens": input_tokens, "cache_read_input_tokens": 5,
                "output_tokens": 99,
            }}},
        },
    }, ensure_ascii=False, separators=(",", ":"))


PLUGIN_CASES = {
    "harness-generic-zcode": {
        "args": ["manifest-validate",
                 "--manifest", "{root}/harnesses.d/zcode/manifest.json",
                 "--machine-namespace", "golden",
                 "--json"],
        "files": {
            "harnesses.d/zcode/manifest.json": PLUGIN_FIXTURE_MANIFEST,
            "data/model-io-sess_aaa.jsonl": "\n".join([
                _plugin_fixture_row("r1", 1, 100),
                _plugin_fixture_row("r2", 1, 200),
                # 无 usage 块（中止请求行）→ skip(not_target_record)。
                '{"requestId":"x9","attempt":1,"completedAt":"2026-09-19T15:18:41Z"}',
                # drift：usage 容器在而主数量缺 → invalid（不许伪装成 skip）。
                '{"requestId":"d1","attempt":1,"completedAt":"2026-09-19T15:18:41.337Z",'
                '"model":{"modelId":"GLM-5.3"},"response":{"providerMetadata":{"anthropic":{"usage":{"cache_read_input_tokens":5}}}}}',
                # 坏 JSON 行 → invalid(bad_json)。
                '{"requestId":"broken"',
            ]) + "\n",
            "data/model-io-sess_bbb.jsonl": _plugin_fixture_row("r3", 1, 300) + "\n",
            # 零 target 文件 → 标黄不失败（§4.3）。
            "data/model-io-sess_empty.jsonl": '{"foo": 1}\n',
        },
    },
}

# 需要在语料根本身（而不是 workdir）里跑的 case
CWD_IS_ROOT = {"cwd-is-home"}

SEV = {"critical": 0, "high": 1, "medium": 2, "none": 3}
CONFLICT_SEV = {"high": 0, "medium": 1, "low": 2}

# 由 time.time() 参与计算、无法在语料里钉死的字段。
# ctime 不可设定，所以这两个字段每天都在变，只能抹成哨兵。
# 代价：年龄闸（不变量 9）不由 golden 覆盖，改由 zombie-age-0 与 default
# 两个 case 的分类差异覆盖 —— 全部进 zombie_candidates vs 全部进 too_new_to_judge。
VOLATILE = {"installed_days_ago", "last_used_days_ago"}

# 个别 case 还有额外的易变字段。
#
# Codex 的预算口径把 **path 的长度**算进字符数（它的 skill 列表里带路径），
# 而语料根是临时目录 —— 绝对路径长度随机器而变。归一化只能改输出里的字符串，
# used_chars 是归一化**之前**就算好的数，已经把临时路径长度烘进去了。
#
# 这不是缺陷：路径越长确实越占 Codex 的列表预算。是 golden 不该记这个数。
# 覆盖不能白丢 —— 「path 计入字符数」由
# tests/test_regressions.py::TestCodexBudgetCountsPathLength 用行为测试保住，
# 那条通过「把同一份语料放到更深的目录」验证增量，与绝对路径无关。
VOLATILE_BY_CASE = {
    "harness-codex": {"used_chars", "pct_used", "over_by_chars",
                   "skills_possibly_dropped"},
}


def run_case(root: Path, extra, out: Path, cwd_is_root=False, env_extra=None):
    """在隔离的 HOME 下跑一次扫描。

    HOME=<语料根> 让 scan.py 的 DEFAULT_ROOTS（全是 ~/...）整体落进语料。
    cwd=<语料根>/workdir 让 project-local 根 ./.claude/skills 也落进语料。
    **不能用 --path**：它是往 DEFAULT_ROOTS 追加而非替换，会把开发者本机的
    skill 混进来，输出随机器而变。
    """
    env = isolated_home_env(root)
    # DSH 会话日志证据来自环境变量；isolated_home_env 是 os.environ 的拷贝，
    # 开发者本机设过 AGENT_VITALS_DSH_SESSION_LOG 会泄漏进来，输出随机器而变。
    # 先清掉，需要证据的 case 再通过 env_extra 显式注入（见 harness-dsh-log）。
    env.pop("AGENT_VITALS_DSH_SESSION_LOG", None)
    # 预算默认值取自环境变量，必须钉死，否则开发者本地设过就对不上
    env["SLASH_COMMAND_TOOL_CHAR_BUDGET"] = "15000"
    # 执行环境运行时探测必须关掉。它们会去问本机真实装着的 Codex / OpenClaw /
    # WorkBuddy —— HOME 隔离拦不住这些（Codex 走的是 PATH 上的可执行文件，
    # 不是 home 下的目录）。开着的话快照取决于「这台机器装没装 Codex」，
    # 刚建立起来的确定性当场失效。
    env["AGENT_VITALS_DISABLE_CODEX_RUNTIME"] = "1"
    env["AGENT_VITALS_DISABLE_OPENCLAW_RUNTIME"] = "1"
    env["AGENT_VITALS_DISABLE_WORKBUDDY_BUILTINS"] = "1"
    env.update(env_extra or {})
    r = subprocess.run(SCAN_CMD + ["--json", str(out)] + extra,
                       cwd=str(root if cwd_is_root else root / "workdir"), env=env,
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError("扫描器退出码 %d\nstdout: %s\nstderr: %s"
                             % (r.returncode, r.stdout, r.stderr))
    return json.loads(out.read_text(encoding="utf-8"))


def scrub(obj, root_str, volatile):
    """路径归一 + 易变字段抹成哨兵。递归处理任意嵌套。"""
    if isinstance(obj, dict):
        return {k: ("<VOLATILE>" if k in volatile and v is not None
                    else scrub(v, root_str, volatile))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub(x, root_str, volatile) for x in obj]
    if isinstance(obj, str):
        return obj.replace(root_str, "<FIXTURES>")
    return obj


def canonicalize(data, root_str, case=None):
    """归一化：抹掉环境噪声，但**保留排序语义**。

    scan.py 多处按 `rglob` 的返回顺序枚举文件，而 rglob 不保证顺序
    （Rust 的 walkdir 同样不保证）。key 值相同的元素之间因此会抖。
    做法不是「整体按名字排序」——那会把 scan.py 真正的排序规则（比如
    flagged 先按未引用严重度排）一起抹掉，golden 就测不出排序错误了。
    做法是**按 scan.py 自己的排序键重排，再拿 name/path 兜底**：
    语义保住，抖动消掉。
    """
    d = scrub(data, root_str, VOLATILE | VOLATILE_BY_CASE.get(case or "", set()))

    if isinstance(d.get("skills"), list):
        for s in d["skills"]:
            sec = s.get("security") or {}
            if isinstance(sec.get("findings"), list):
                sec["findings"].sort(key=lambda f: (f.get("where", ""),
                                                    f.get("rule", ""),
                                                    f.get("line", 0)))
            if isinstance(sec.get("exec_scripts"), list):
                # Windows has no POSIX execute bits: chmod(0o755) cannot survive
                # fixture creation there. Preserve the fixture's declared mode
                # so golden tests compare scanner semantics, not NTFS metadata.
                if os.name == "nt":
                    for script in sec["exec_scripts"]:
                        if script.get("path") == "scripts/run.sh":
                            script["executable"] = True
                sec["exec_scripts"].sort(key=lambda x: x.get("path", ""))
        # scan.py: sorted(skills, key=(not loaded, -tier1_tokens))，path 兜底
        d["skills"].sort(key=lambda s: (not s.get("loaded"),
                                        -s.get("tier1_tokens", 0),
                                        s.get("path", "")))

    sec = d.get("security") or {}
    if isinstance(sec.get("flagged"), list):
        # scan.py: (未引用严重度, 严重度, 未加载在后)，name 兜底
        sec["flagged"].sort(key=lambda s: (SEV.get(s.get("severity_uncited"), 9),
                                           SEV.get(s.get("severity"), 9),
                                           not s.get("loaded"),
                                           s.get("name", "")))
        for f in sec["flagged"]:
            if isinstance(f.get("findings"), list):
                f["findings"].sort(key=lambda x: (x.get("where", ""),
                                                  x.get("rule", ""),
                                                  x.get("line", 0)))

    if isinstance(d.get("conflicts"), list):
        d["conflicts"].sort(key=lambda c: (CONFLICT_SEV.get(c.get("severity"), 9),
                                           c.get("name", "")))
        for c in d["conflicts"]:
            if isinstance(c.get("shadowed"), list):
                c["shadowed"].sort(key=lambda x: x.get("path", ""))

    td = d.get("trigger_data") or {}
    if isinstance(td.get("zombie_candidates"), list):
        td["zombie_candidates"].sort(key=lambda z: (-z.get("tier1_tokens", 0),
                                                    z.get("name", "")))
    if isinstance(td.get("too_new_to_judge"), list):
        # 原排序键是 installed_days_ago —— 全部相同且已被抹掉，只能靠 name
        td["too_new_to_judge"].sort(key=lambda z: z.get("name", ""))

    st = d.get("structure") or {}
    for key, sk in (("oversized", lambda x: (-x.get("tier2_core_tokens", 0),
                                             x.get("name", ""))),
                    ("already_split", lambda x: (-x.get("refs", 0),
                                                 x.get("name", ""))),
                    ("large_data_corpus", lambda x: (-x.get("mb", 0),
                                                     x.get("name", ""))),
                    ("missing_frontmatter", lambda x: x.get("name", ""))):
        if isinstance(st.get(key), list):
            st[key].sort(key=sk)

    bd = d.get("description_budget") or {}
    if isinstance(bd.get("longest_descriptions"), list):
        bd["longest_descriptions"].sort(key=lambda x: (-x.get("chars", 0),
                                                       x.get("name", "")))
    return d


def _run_plugin_case(root: Path, name: str):
    """generic 插件执行环境 case：写内联 fixture → 跑 manifest-validate（stdout
    JSON 契约）→ scrub。退出码非 0 = case 失败（gate refuse / 硬错误）。"""
    import json as _json
    root = root.resolve()
    case = PLUGIN_CASES[name]
    for rel, content in case["files"].items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, (dict, list)):
            payload = (_json.dumps(content, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        else:
            payload = content.encode("utf-8") if isinstance(content, str) else content
        target.write_bytes(payload)
    root_s = str(root).replace("\\", "/")
    args = [a.replace("{root}", root_s) for a in case["args"]]
    env = isolated_home_env(root)
    r = subprocess.run(SCAN_CMD + args, cwd=str(root), env=env,
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(
            "manifest-validate 退出码 %d\nstdout: %s\nstderr: %s"
            % (r.returncode, r.stdout, r.stderr))
    data = _json.loads(r.stdout)
    return scrub(data, root_s, set())


def produce(tmp: Path):
    """建语料 → 跑全部 case → 返回 {case 名: 归一化后的 JSON}。"""
    results = {}
    all_case_names = [c[0] for c in CASES] + list(PLUGIN_CASES.keys())
    for name in all_case_names:
        if name in PLUGIN_CASES:
            results[name] = _run_plugin_case(tmp / name, name)
            continue
        extra, with_cfg = next((e, w) for n, e, w in CASES if n == name)
        root = (tmp / name).resolve()
        gen = FIXTURE_GEN_BY_CASE.get(name, GEN)
        subprocess.run([sys.executable, str(gen), "--into", str(root), "--clean"],
                       check=True, capture_output=True)
        # 主树造 .claude.json；DSH 树没有它（.dsh/.agents，不是 .claude）。
        # 不 guard 直接 unlink 会在 DSH case 上 FileNotFoundError。
        if not with_cfg and (root / ".claude.json").exists():
            (root / ".claude.json").unlink()
        # 基线 / DSH 会话日志 / probe 快照都要落在语料根里，scrub 才能把
        # 绝对路径抹成 <FIXTURES>。原来用 `any("{root}" in a for a in extra)`
        # 判断是否拷基线，但那会把 harness-dsh-probe 的 `--runtime-json
        # {root}/snapshot.json` 也误判成要拷 baseline.json。改成按 case 名
        # 精确分发。
        if name == "diff-baseline":
            shutil.copyfile(ROOT / "fixtures" / "diff-baseline.json",
                            root / "baseline.json")
        elif name == "harness-dsh-log":
            shutil.copyfile(DSH_SESSION_LOG, root / "session.jsonl")
        elif name == "harness-dsh-probe":
            (root / "snapshot.json").write_text(json.dumps(DSH_SNAPSHOT),
                                                encoding="utf-8")
        root_s = str(root).replace("\\", "/")
        extra = [a.replace("{root}", root_s) for a in extra]
        env_extra = ENV_BY_CASE.get(name)
        if env_extra:
            env_extra = {k: v.replace("{root}", root_s)
                         for k, v in env_extra.items()}
        data = run_case(root, extra, tmp / ("%s.raw.json" % name),
                        cwd_is_root=name in CWD_IS_ROOT,
                        env_extra=env_extra)
        # Scanner paths are normalized to forward slashes on every platform.
        results[name] = canonicalize(data, root_s, name)
    return results


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def first_diff(a: str, b: str, ctx=3):
    la, lb = a.splitlines(), b.splitlines()
    for i in range(max(len(la), len(lb))):
        x = la[i] if i < len(la) else "<缺行>"
        y = lb[i] if i < len(lb) else "<缺行>"
        if x != y:
            lo = max(0, i - ctx)
            out = ["  第 %d 行起：" % (i + 1)]
            for j in range(lo, i):
                out.append("    %s" % la[j])
            out.append("  - golden: %s" % x)
            out.append("  + 实际  : %s" % y)
            return "\n".join(out)
    return "（逐行相同，差异在行尾空白或结尾换行）"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true", help="重新生成 golden")
    ap.add_argument("--diff", action="store_true", help="打印首个差异")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="sv-golden-")).resolve()
    try:
        results = produce(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    GOLDEN_DIR.mkdir(exist_ok=True)
    if args.update:
        for name, data in results.items():
            (GOLDEN_DIR / ("%s.json" % name)).write_text(dump(data),
                                                         encoding="utf-8")
        print("已更新 %d 份 golden → %s" % (len(results), GOLDEN_DIR))
        print("实现：%s" % " ".join(SCAN_CMD))
        return 0

    failed = []
    for name, data in results.items():
        gp = GOLDEN_DIR / ("%s.json" % name)
        if not gp.is_file():
            failed.append((name, "golden 不存在，先跑 --update"))
            continue
        want, got = gp.read_text(encoding="utf-8"), dump(data)
        if want != got:
            msg = "与 golden 不一致"
            if args.diff:
                msg += "\n" + first_diff(want, got)
            failed.append((name, msg))

    all_names = [c[0] for c in CASES] + list(PLUGIN_CASES.keys())
    for name in all_names:
        mark = "✕" if any(f[0] == name for f in failed) else "✓"
        print("%s %s" % (mark, name))
    if failed:
        print("\n%d/%d 个 case 不一致：" % (len(failed), len(all_names)))
        for name, msg in failed:
            print("  %s: %s" % (name, msg))
        print("\n实现：%s" % " ".join(SCAN_CMD))
        return 1
    print("\n%d 个 case 全部与 golden 逐字节一致（实现：%s）"
          % (len(all_names), " ".join(SCAN_CMD)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
