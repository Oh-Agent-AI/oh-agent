#!/usr/bin/env python3
"""畸形语料不中断扫描（ENGINEERING.md §4.5）。

    对扫描 200 个 skill 的工具，「死在第 47 个」远比「跳过第 47 个并标注」糟糕。

这条在 Python 版**几乎**是免费的（到处是 `errors="replace"`、`except OSError`、
`.get(k, default)`），在 Rust 版必须显式买回来——一个 `unwrap()` 撞上畸形文件，
整次扫描直接终止。**这是移植中最容易漏掉的一类差异，因为它在正常语料上永远
不显形。**所以这套断言必须在 Python 版先立起来，移植后原样再跑一遍。

「不影响其余」只是要求的一半。另一半是**畸形项必须现身**：

    缺一项的报告有价值，少一项却不说的报告会误导清点。

跑法：
    python3 -m unittest tests.test_degradation -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from tests.env_helpers import isolated_home_env

ROOT = Path(__file__).resolve().parent.parent
SCAN = ROOT / "scripts" / "scan.py"
_BIN = os.environ.get("AGENT_VITALS_BIN")
# 与 golden_runner.py / test_cli_matrix.py 同款：解析成绝对路径。差分用例以
# tmp/workdir 为 cwd 跑子进程，相对路径在这里会 FileNotFoundError（CI 传绝对
# 路径所以没暴露；本机按 CLAUDE.md 的 `AGENT_VITALS_BIN=target/release/...`
# 跑就炸）。
if _BIN:
    _BIN = str(Path(_BIN).resolve())
SCAN_CMD = [_BIN] if _BIN else [sys.executable, str(SCAN)]

sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))
from agent_vitals.skill import skill_invocations  # noqa: E402
from agent_vitals.duration import (  # noqa: E402
    tool_call_durations, turn_durations, step_durations, approval_latencies, hook_executions,
)

# 正常 skill 的名字。断言「其余全部幸存」时逐个核对这批。
HEALTHY = ["healthy-a", "healthy-b", "healthy-c"]


def write(path: Path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")


class TestMalformedCorpusDoesNotAbortScan(unittest.TestCase):
    """畸形项与正常项混在一起，扫描必须跑完。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp()).resolve()
        sk = cls.tmp / ".claude" / "skills"

        for n in HEALTHY:
            write(sk / n / "SKILL.md",
                  "---\nname: %s\ndescription: healthy\n---\n\nbody\n" % n)

        # 1. 截断的 frontmatter —— 只有开头的 ---，没有闭合
        write(sk / "bad-truncated" / "SKILL.md",
              "---\nname: bad-truncated\ndescription: never closed\n\nbody\n")

        # 2. 非 UTF-8 字节。Python errors="replace" 照常扫描；
        #    Rust 直译成 fs::read_to_string 会 Err → 整个 skill 静默消失
        write(sk / "bad-binary" / "SKILL.md",
              b"---\nname: bad-binary\ndescription: \xff\xfe\xfd bytes\n---\n\nbody\n")

        # 3. 空文件
        write(sk / "bad-empty" / "SKILL.md", "")

        # 4. 只有分隔符
        write(sk / "bad-only-fence" / "SKILL.md", "---\n---\n")

        # 5. 附带资源里混了非 UTF-8 与畸形脚本
        write(sk / "bad-bundled" / "SKILL.md",
              "---\nname: bad-bundled\ndescription: d\n---\n\nbody\n")
        write(sk / "bad-bundled" / "references" / "broken.md",
              b"\xff\xfe not valid utf-8 at all\n")
        write(sk / "bad-bundled" / "scripts" / "broken.sh", b"\x00\x01\xff\n")

        # 6. 深层嵌套 + 超长文件名段
        write(sk / "bad-deep" / "a" / "b" / "c" / "d" / "e" / "notes.md", "x\n")
        write(sk / "bad-deep" / "SKILL.md",
              "---\nname: bad-deep\ndescription: d\n---\n\nbody\n")

        cls.tmp_workdir = cls.tmp / "workdir"
        cls.tmp_workdir.mkdir(parents=True, exist_ok=True)
        cls.data = cls._scan()

    @classmethod
    def _scan(cls, extra=()):
        out = cls.tmp / "out.json"
        env = isolated_home_env(cls.tmp)
        r = subprocess.run(SCAN_CMD + ["--json", str(out)] + list(extra),
                           cwd=str(cls.tmp_workdir), env=env,
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise AssertionError("畸形语料不得让扫描失败\nstderr: %s" % r.stderr)
        return json.loads(out.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_scan_exits_successfully(self):
        self.assertGreater(self.data["total_skills_on_disk"], 0)

    def test_all_healthy_skills_survive(self):
        """核心断言：畸形项旁边的正常项，一个都不能少。"""
        names = {s["name"] for s in self.data["skills"]}
        for n in HEALTHY:
            self.assertIn(n, names, "%s 被畸形邻居带没了" % n)

    def test_malformed_skills_still_appear(self):
        """畸形但可读的项必须照常出现，不能被跳过。"""
        names = {s["name"] for s in self.data["skills"]}
        for n in ("bad-binary", "bad-bundled", "bad-deep"):
            self.assertIn(n, names, "%s 可读，不该被跳过" % n)

    def test_truncated_frontmatter_falls_back_to_dir_name(self):
        """没有合法 frontmatter 时用目录名兜底，并如实标注缺字段。"""
        by = {s["dir_name"]: s for s in self.data["skills"]}
        s = by["bad-truncated"]
        self.assertEqual(s["name"], "bad-truncated")
        self.assertFalse(s["has_name"])
        self.assertFalse(s["has_description"])

    def test_empty_and_fence_only_files_are_recorded(self):
        by = {s["dir_name"]: s for s in self.data["skills"]}
        for d in ("bad-empty", "bad-only-fence"):
            self.assertIn(d, by, "%s 必须出现在输出里" % d)
            self.assertFalse(by[d]["has_description"])

    def test_non_utf8_is_scanned_not_skipped(self):
        """非 UTF-8 必须**被扫描**而不是被跳过 —— 安全工具里跳过就是漏报。"""
        by = {s["dir_name"]: s for s in self.data["skills"]}
        s = by["bad-binary"]
        self.assertIn("security", s)
        self.assertIsNotNone(s["content_hash"])
        self.assertGreater(len(s["content_hash"]), 0)

    def test_non_utf8_bundled_files_do_not_break_token_accounting(self):
        by = {s["dir_name"]: s for s in self.data["skills"]}
        s = by["bad-bundled"]
        self.assertGreaterEqual(s["tier2_refs_tokens"], 0)
        self.assertGreater(s["bundled_files"], 0)

    def test_aggregates_are_consistent_with_skill_list(self):
        """畸形项不得让汇总数字与明细对不上。"""
        d = self.data
        self.assertEqual(d["total_skills_on_disk"], len(d["skills"]))
        self.assertEqual(d["loaded_skills"],
                         sum(1 for s in d["skills"] if s["loaded"]))

    def test_redaction_still_works_on_malformed_corpus(self):
        """畸形语料 + 脱敏是两条容易互相踩的路径，要一起走一遍。"""
        red = self._scan(("--redact", "--redact-names"))
        raw = json.dumps(red, ensure_ascii=False)
        for n in HEALTHY + ["bad-binary", "bad-truncated"]:
            self.assertNotIn(n, raw, "%s 在畸形语料下泄露了" % n)


@unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0,
                 "以 root 运行时 chmod 000 仍可读，这条测不出东西")
class TestUnreadableSkillIsReportedNotDropped(unittest.TestCase):
    """曾经：SKILL.md 读不了 → 该 skill **从报告里彻底消失**，且毫无迹象。

    `scan_skill_dir()` 遇到 OSError 返回 None，`collect()` 直接跳过。
    用户看到的清点数字是错的，而报告里没有任何东西表明少了一项。

    §4.5 的要求是两半，「不影响其余」只是其中一半：

        单个 skill 的任何失败降级为该 skill 的一条诊断，不影响其余。

    对一个做清点的工具，静默丢项就是错误答案。
    """

    @classmethod
    def setUpClass(cls):
        if os.name == "nt":
            raise unittest.SkipTest("Windows chmod cannot make a file unreadable")
        cls.tmp = Path(tempfile.mkdtemp()).resolve()
        sk = cls.tmp / ".claude" / "skills"
        for n in HEALTHY:
            write(sk / n / "SKILL.md",
                  "---\nname: %s\ndescription: healthy\n---\n\nbody\n" % n)
        write(sk / "locked-away" / "SKILL.md",
              "---\nname: locked-away\ndescription: d\n---\n\nbody\n")
        os.chmod(sk / "locked-away" / "SKILL.md", 0o000)

        (cls.tmp / "workdir").mkdir(parents=True, exist_ok=True)
        out = cls.tmp / "out.json"
        env = isolated_home_env(cls.tmp)
        r = subprocess.run(SCAN_CMD + ["--json", str(out)],
                           cwd=str(cls.tmp / "workdir"), env=env,
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise AssertionError("读不了的 skill 不得让扫描失败\n%s" % r.stderr)
        cls.stderr = r.stderr
        cls.data = json.loads(out.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        try:
            os.chmod(cls.tmp / ".claude" / "skills" / "locked-away" / "SKILL.md", 0o644)
        except OSError:
            pass
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_other_skills_unaffected(self):
        names = {s["name"] for s in self.data["skills"]}
        for n in HEALTHY:
            self.assertIn(n, names)

    def test_unreadable_skill_is_listed_not_silently_dropped(self):
        entries = self.data.get("unreadable_skills")
        self.assertIsNotNone(entries, "输出必须有 unreadable_skills 字段")
        paths = [e["path"] for e in entries]
        self.assertTrue(any(p.endswith("locked-away") for p in paths),
                        "读不了的 skill 必须显式列出：%r" % entries)

    def test_entry_carries_a_reason(self):
        e = [x for x in self.data["unreadable_skills"]
             if x["path"].endswith("locked-away")][0]
        self.assertTrue(e.get("reason"), "必须说明为什么读不了")
        self.assertTrue(e.get("harness"), "必须说明是哪个执行环境的根下发现的")

    def test_warning_also_goes_to_stderr(self):
        """只写进 JSON 不够 —— 直接在终端跑的人同样需要知道清点不完整。"""
        self.assertIn("unreadable_skills", self.stderr)

    def test_unreadable_skill_not_counted_in_totals(self):
        """它没被扫描，就不能算进统计 —— 但也不能因此从报告里消失。"""
        self.assertEqual(self.data["total_skills_on_disk"], len(HEALTHY))
        names = {s["name"] for s in self.data["skills"]}
        self.assertNotIn("locked-away", names)

    def test_redaction_covers_unreadable_entries(self):
        """`unreadable_skills` 里的名字来自目录名，同样要脱敏。

        这批 skill 不在 `skills[]` 里，所以只从那里收集名字的实现会漏掉它们
        —— 与 `removed_skills` 是同一个失效模式。
        """
        out = self.tmp / "red.json"
        env = isolated_home_env(self.tmp)
        subprocess.run(SCAN_CMD + ["--json", str(out), "--redact", "--redact-names"],
                       cwd=str(self.tmp / "workdir"), env=env,
                       capture_output=True, text=True, check=True)
        raw = out.read_text(encoding="utf-8")
        self.assertNotIn("locked-away", raw,
                         "读不了的 skill 的名字也不得残留在脱敏输出里")


class TestSkillInvocationsMalformedEventsDoNotAbort(unittest.TestCase):
    """`skill_invocations`（Skill 执行审计 T3）残缺日志不能崩，缺的要浮出来。

    同一条纪律，换了主体：`scan.py` 对畸形 SKILL.md 语料的容错，这里是
    `skill_invocations` 对畸形/残缺 DSH 事件的容错——「死在第 N 条事件」远比
    「跳过第 N 条并在 missing_fields 里说清楚」糟糕。这层是纯函数，不走
    subprocess/文件系统，直接灌畸形事件数组进去断言。
    """

    def test_non_dict_events_are_skipped_not_fatal(self):
        events = [None, "garbage", 42, [1, 2, 3],
                  {"type": "user/message", "seq": 1, "time": 1,
                   "data": {"source": {"kind": "skill-invocation", "name": "ok"}}}]
        out = skill_invocations(events, [])
        self.assertEqual(len(out), 1, "非 dict 条目必须被跳过而不是让整个调用崩溃")
        self.assertEqual(out[0]["name"], "ok")

    def test_tool_call_with_non_string_arguments_yields_missing_name_not_crash(self):
        """`arguments` 该是字符串却给了别的类型（对象/数字/None）：不能崩，
        也不能猜一个名字——name 进 missing_fields。"""
        for bad_args in [{"name": "x"}, 42, None, []]:
            events = [{"type": "tool/call", "seq": 1, "time": 1,
                       "data": {"turn": 1, "step": 1, "callId": "c1", "name": "skill",
                                "arguments": bad_args}}]
            out = skill_invocations(events, [])
            self.assertEqual(len(out), 1, "call_id 在，行必须留着：%r" % (bad_args,))
            self.assertIsNone(out[0]["name"])
            self.assertIn("name", out[0]["missing_fields"])

    def test_tool_result_with_non_dict_data_is_ignored_not_fatal(self):
        """`tool/result.data` 畸形（非 dict）：配对失败，行仍留着报 incomplete，
        不因为一条坏结果就丢了整次调用的证据。"""
        events = [
            {"type": "tool/call", "seq": 1, "time": 1000,
             "data": {"turn": 1, "step": 1, "callId": "c1", "name": "skill",
                      "arguments": '{"name":"x"}'}},
            {"type": "tool/result", "seq": 2, "time": 1010, "data": "not-a-dict"},
        ]
        out = skill_invocations(events, [])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["load_status"], "incomplete")

    def test_missing_source_name_on_invocation_is_dropped_not_guessed(self):
        """`skill-invocation` 载体没有 `name`：这一行没法识别是哪个技能，
        宁可整行不出，也不能编一个——不是"崩"也不是"当成别的技能"。"""
        events = [{"type": "user/message", "seq": 1, "time": 1,
                   "data": {"source": {"kind": "skill-invocation"}}}]
        self.assertEqual(skill_invocations(events, []), [])

    def test_requests_with_wrong_shaped_rows_do_not_crash_lookup(self):
        """`requests` 里混进不是 dict 的行（比如上游某处报了 None）：
        `(turn, step)` 查找必须跳过它们，不能因为一行畸形就整体崩溃。"""
        events = [
            {"type": "tool/call", "seq": 1, "time": 1000,
             "data": {"turn": 4, "step": 1, "callId": "c1", "name": "skill",
                      "arguments": '{"name":"x"}'}},
            {"type": "tool/result", "seq": 2, "time": 1010,
             "data": {"message": {"source": {"kind": "tool", "callId": "c1"},
                                   "content": [{"type": "tool-result", "isError": False}]}}},
        ]
        requests = [None, "garbage", {"turn": 4, "step": 1, "request_seq": 3}]
        out = skill_invocations(events, requests)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["request_seq"], 3, "跳过畸形行之后仍要找到那条真的匹配")

    def test_empty_events_gives_empty_output_not_error(self):
        self.assertEqual(skill_invocations([], []), [])


class TestToolCallDurationsMalformedEventsDoNotAbort(unittest.TestCase):
    """`tool_call_durations`（执行时长审计 D1）残缺日志不能崩，缺的要浮出来。

    同一条纪律，换了主体——见 `TestSkillInvocationsMalformedEventsDoNotAbort`
    的类文档串。这层也是纯函数，不走 subprocess/文件系统，直接灌畸形事件
    数组进去断言。
    """

    def test_non_dict_events_are_skipped_not_fatal(self):
        events = [None, "garbage", 42, [1, 2, 3],
                  {"type": "tool/call", "seq": 1, "time": 1000,
                   "data": {"callId": "c1", "name": "bash"}}]
        out = tool_call_durations(events)
        self.assertEqual(len(out), 1, "非 dict 条目必须被跳过而不是让整个调用崩溃")
        self.assertEqual(out[0]["call_id"], "c1")

    def test_tool_call_with_non_dict_data_is_skipped_not_fatal(self):
        events = [{"type": "tool/call", "seq": 1, "time": 1000, "data": "not-a-dict"}]
        self.assertEqual(tool_call_durations(events), [])

    def test_call_id_wrong_type_is_treated_as_missing_not_crash(self):
        """`callId` 该是字符串却给了别的类型（数字/对象/None）：不能崩，也不能
        当成一个字符串强凑——整条跳过（结构上配不了对）。"""
        for bad_cid in [42, {"x": 1}, None, []]:
            events = [{"type": "tool/call", "seq": 1, "time": 1000,
                       "data": {"callId": bad_cid, "name": "bash"}}]
            self.assertEqual(tool_call_durations(events), [], "callId=%r" % (bad_cid,))

    def test_tool_name_wrong_type_yields_missing_field_not_crash(self):
        """`data.name` 该是字符串却给了别的类型：不能崩，也不能猜一个名字——
        `tool_name` 进 `missing_fields`。"""
        for bad_name in [{"x": 1}, 42, None, []]:
            events = [{"type": "tool/call", "seq": 1, "time": 1000,
                       "data": {"callId": "c1", "name": bad_name}}]
            out = tool_call_durations(events)
            self.assertEqual(len(out), 1, "callId 在，行必须留着：%r" % (bad_name,))
            self.assertIsNone(out[0]["tool_name"])
            self.assertIn("tool_name", out[0]["missing_fields"])

    def test_tool_result_with_non_dict_data_is_ignored_not_fatal(self):
        """`tool/result.data` 畸形（非 dict）：配对失败，行仍留着报
        `incomplete`，不因为一条坏结果就丢了整次调用的证据。"""
        events = [
            {"type": "tool/call", "seq": 1, "time": 1000, "data": {"callId": "c1", "name": "bash"}},
            {"type": "tool/result", "seq": 2, "time": 1010, "data": "not-a-dict"},
        ]
        out = tool_call_durations(events)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["load_status"], "incomplete")

    def test_result_time_wrong_type_yields_missing_duration_not_crash(self):
        """`tool/result.time` 该是数字却给了字符串：不能崩，也不能拿字符串
        直接相减——`duration_ms` 进 `missing_fields`，`load_status` 仍按有没有
        回执判定（这里回执到了，只是时间戳不可用，不是 incomplete）。"""
        events = [
            {"type": "tool/call", "seq": 1, "time": 1000, "data": {"callId": "c1", "name": "bash"}},
            {"type": "tool/result", "seq": 2, "time": "not-a-number",
             "data": {"message": {"source": {"kind": "tool", "callId": "c1"},
                                   "content": [{"type": "tool-result", "isError": False}]}}},
        ]
        out = tool_call_durations(events)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["load_status"], "loaded", "回执确实到了，不是 incomplete")
        self.assertIsNone(out[0]["duration_ms"])
        self.assertIn("duration_ms", out[0]["missing_fields"])

    def test_empty_events_gives_empty_output_not_error(self):
        self.assertEqual(tool_call_durations([]), [])


class TestTurnStepApprovalDurationsMalformedEventsDoNotAbort(unittest.TestCase):
    """`turn_durations`/`step_durations`/`approval_latencies`（D2/D3）残缺日志
    不能崩，缺的要浮出来——同一条纪律，换了主体。"""

    def test_non_dict_events_are_skipped_not_fatal(self):
        events = [None, "garbage", 42, [1, 2, 3],
                  {"type": "turn/start", "seq": 1, "time": 1000, "data": {"turn": 1}}]
        out = turn_durations(events)
        self.assertEqual(len(out), 1, "非 dict 条目必须被跳过而不是让整个调用崩溃")
        self.assertEqual(out[0]["turn"], 1)

    def test_turn_wrong_type_is_skipped_not_fatal(self):
        for bad_turn in ["3", None, {"x": 1}, []]:
            events = [{"type": "turn/start", "seq": 1, "time": 1000, "data": {"turn": bad_turn}}]
            self.assertEqual(turn_durations(events), [], "turn=%r" % (bad_turn,))

    def test_turn_end_with_non_dict_data_is_ignored_not_fatal(self):
        events = [
            {"type": "turn/start", "seq": 1, "time": 1000, "data": {"turn": 1}},
            {"type": "turn/end", "seq": 2, "time": 1010, "data": "not-a-dict"},
        ]
        out = turn_durations(events)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["load_status"], "incomplete")

    def test_step_missing_turn_or_step_is_skipped_not_fatal(self):
        events = [
            {"type": "step/start", "seq": 1, "time": 1000, "data": {"turn": 1}},  # 缺 step
            {"type": "step/start", "seq": 2, "time": 1000, "data": {"step": 1}},  # 缺 turn
            {"type": "step/start", "seq": 3, "time": 1000, "data": {}},  # 两个都缺
        ]
        self.assertEqual(step_durations(events), [])

    def test_approval_asked_missing_id_is_skipped_not_fatal(self):
        events = [{"type": "approval/asked", "seq": 1, "time": 1000,
                   "data": {"toolName": "bash", "reason": "x"}}]
        self.assertEqual(approval_latencies(events), [])

    def test_approval_decided_with_non_dict_data_is_ignored_not_fatal(self):
        events = [
            {"type": "approval/asked", "seq": 1, "time": 1000,
             "data": {"id": "a1", "toolName": "bash", "reason": "x"}},
            {"type": "approval/decided", "seq": 2, "time": 1010, "data": "not-a-dict"},
        ]
        out = approval_latencies(events)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["status"], "pending", "配不上对的 decided 不能让这行凭空变成已决定")

    def test_empty_events_give_empty_output_not_error(self):
        self.assertEqual(turn_durations([]), [])
        self.assertEqual(step_durations([]), [])
        self.assertEqual(approval_latencies([]), [])


class TestHookExecutionsMalformedEventsDoNotAbort(unittest.TestCase):
    """`hook_executions`（D4）残缺日志不能崩，缺的要浮出来。"""

    def test_non_dict_events_are_skipped_not_fatal(self):
        events = [None, "garbage", 42, [1, 2, 3],
                  {"type": "hook/result", "seq": 1, "time": 1000, "data": {"handlerId": "h1"}}]
        out = hook_executions(events)
        self.assertEqual(len(out["executions"]), 1)

    def test_non_dict_data_is_skipped_not_fatal(self):
        events = [{"type": "hook/result", "seq": 1, "time": 1000, "data": "not-a-dict"}]
        self.assertEqual(hook_executions(events)["executions"], [])

    def test_handler_id_wrong_type_is_skipped_not_fatal(self):
        for bad_id in [42, {"x": 1}, None, []]:
            events = [{"type": "hook/result", "seq": 1, "time": 1000, "data": {"handlerId": bad_id}}]
            self.assertEqual(hook_executions(events)["executions"], [], "handlerId=%r" % (bad_id,))

    def test_duration_ms_wrong_type_yields_missing_field_not_crash(self):
        events = [{"type": "hook/result", "seq": 1, "time": 1000,
                   "data": {"handlerId": "h1", "durationMs": "not-a-number"}}]
        out = hook_executions(events)
        self.assertEqual(len(out["executions"]), 1)
        self.assertIsNone(out["executions"][0]["duration_ms"])
        self.assertIn("duration_ms", out["executions"][0]["missing_fields"])

    def test_empty_events_give_empty_output_not_error(self):
        out = hook_executions([])
        self.assertEqual(out["executions"], [])
        self.assertEqual(out["decision_counts"], {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
