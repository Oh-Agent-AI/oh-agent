"""M3 CLI 子命令（oneline / calendar / state list / state clean）测试。

不走 golden —— oneline / state 写的是**时间戳 + 内容**,无法 byte-for-byte
对账（每次跑 generated_at 都变）。改用 invariant 风格：跑 CLI → 检查
state 文件存在 + 关键字段存在 + 数字与单 session 审计可对账。
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "scan.py"

sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))
from agent_vitals import budget as budget_module  # noqa: E402
from agent_vitals import cli as cli_module  # noqa: E402
from agent_vitals import cost as cost_module  # noqa: E402


def _run(args, env=None):
    """跑一次 scan.py 子命令，返回 (returncode, stdout, stderr)。"""
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, str(SCRIPT)] + list(args),
        capture_output=True, text=True, env=full_env, timeout=60,
    )


class _TmpHome:
    """每次测试一个临时 AGENT_VITALS_HOME + HOME —— 不污染真机 ~/.agent-vitals，
    也不让 codex 会话扫描碰到真机 ~/.codex。

    必须两个都隔离：`state_dir()` 走 `$AGENT_VITALS_HOME`，而
    `codex_session.codex_rollout_files()` 走 `Path.home()`——之前只设
    AGENT_VITALS_HOME，日历/oneline 每次刷新都去折叠真机全部 rollout
    （≈600MB JSONL ≈38s），测试直接挂死（真实事故，2026-08-29）。设 HOME
    后折叠落在空目录，秒回；codex 适配器注释明说「测试用 isolated_home_env
    注入」。"""

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="sv-cli-m3-")
        self.env = {"AGENT_VITALS_HOME": self.tmp,
                    "HOME": self.tmp,
                    "USERPROFILE": self.tmp}
        return self

    def __exit__(self, *args):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)


def _write_today_dated_log(path, input_tokens=1700000, output_tokens=100,
                           model="deepseek-v4-flash"):
    """写一份事件时间戳为**真实当前时刻**的最小 DSH 会话日志。

    `fixtures/dsh/behavior.jsonl` 是固定历史日期（2025-06-15，为了
    golden/差分测试可复现）——`merge_today` 现在会把不属于今天的桶滤掉
    （见 state.py::merge_today 的文档：真机复现过"下午 3 点看到 21、22
    点数据"的重复计费类 bug），用那份固定夹具测"today.json 是否正确
    累加今天的数据"这件事本身就不成立了，需要一份时间戳货真价实是
    "现在"的日志。
    """
    _write_today_dated_multi_model_log(path, [(model, input_tokens, output_tokens)])


def _write_today_dated_multi_model_log(path, models):
    """同 `_write_today_dated_log`，但 `models` 是
    `[(model, input_tokens, output_tokens), ...]`——用于需要验证"混了
    多个模型、按模型精确定价"这类场景（`fixtures/dsh/behavior.jsonl`
    原本就是为此设计的，但它固定在 2025-06-15，不能再用来测
    today.json 的路径,见上面 `_write_today_dated_log` 的说明）。
    """
    import time
    now_ms = int(time.time() * 1000)
    lines = [
        {"type": "session", "version": 0, "id": "sess-today-dated",
         "createdAt": now_ms, "cwd": "/tmp", "delegationDepth": 0},
    ]
    seq = 1
    for model, input_tokens, output_tokens in models:
        lines.append({"type": "request/header", "seq": seq, "time": now_ms,
                      "data": {"header": {"config": {"model": model}}}})
        seq += 1
        lines.append({"type": "assistant/chunk", "seq": seq, "time": now_ms,
                      "data": {"turn": seq, "step": 1, "chunk": {"type": "usage",
                               "usage": {"inputTokens": input_tokens,
                                         "outputTokens": output_tokens}}}})
        seq += 1
    with open(path, "w", encoding="utf-8") as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")


class TestOnelineCli(unittest.TestCase):
    def test_oneline_writes_three_state_files(self):
        """一次 oneline 应该产生 oneline.json + today.json + month.json。"""
        with _TmpHome() as h:
            r = _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            sd = Path(h.tmp) / "state"
            for name in ("oneline.json", "today.json", "month.json"):
                self.assertTrue((sd / name).is_file(), "%s should exist" % name)

    def test_oneline_json_shape(self):
        """oneline.json 必须含 schema_version + 关键摘要字段。"""
        with _TmpHome() as h:
            r = _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            data = json.loads((Path(h.tmp) / "state" / "oneline.json").read_text())
            self.assertEqual(data["schema_version"], "1.0.0")
            self.assertIn("generated_at", data)
            self.assertIn("tokens_total", data)
            self.assertIn("cost_cny", data)
            self.assertIn("hour_buckets_summary", data)

    def test_oneline_no_merge_skips_today_and_month(self):
        """--no-merge 应该只写 oneline.json,不写 today.json / month.json。"""
        with _TmpHome() as h:
            r = _run(["oneline", "--no-merge", "fixtures/dsh/behavior.jsonl"],
                     env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            sd = Path(h.tmp) / "state"
            self.assertTrue((sd / "oneline.json").is_file())
            self.assertFalse((sd / "today.json").is_file())
            self.assertFalse((sd / "month.json").is_file())

    def test_oneline_today_accumulates_across_runs(self):
        """两个**不同**会话的 oneline → today.json 桶内累加。

        2026-08 起（R1d §4.3）同一 session_log 重复 oneline 会被 dedup 跳过
        （exactly-once，见 test_oneline_same_log_twice_is_exactly_once）——
        累加语义只能用**不同会话**测，同一 log 跑两遍不再是「两个会话」的
        代理。"""
        with _TmpHome() as h:
            log1 = Path(h.tmp) / "today-1.jsonl"
            log2 = Path(h.tmp) / "today-2.jsonl"
            _write_today_dated_log(log1)
            _write_today_dated_log(log2)
            for log in (log1, log2):
                r = _run(["oneline", str(log)], env=h.env)
                self.assertEqual(r.returncode, 0, r.stderr)
            today = json.loads((Path(h.tmp) / "state" / "today.json").read_text())
            # 累加后某个 hour 桶的非零 token 数 = 单次的两倍（两个会话）
            bucket_values = [v for v in today["buckets"].values()]
            self.assertEqual(len(bucket_values), 1, "同一时间只应有 1 个 hour 桶")
            # 单次 input_tokens 是 1.7M,累加后应是 3.4M
            self.assertEqual(bucket_values[0]["uncached_input_tokens"], 1700000 * 2)

    def test_oneline_same_log_twice_is_exactly_once(self):
        """R1d §4.3：同一 session_log 连续多 tick 不重复累加。

        第二次 oneline 同 log 被 dedup 跳过，today/month/sessions.jsonl 一字
        不动 —— 这就是 §4.2 验收里「已填充 state + 同一 session 多 tick
        fixture 断言」的 Python 侧。2026-08 之前同一 log 跑两遍会把桶翻倍
        （正是 R1d 修的 bug）。"""
        with _TmpHome() as h:
            log = Path(h.tmp) / "today.jsonl"
            _write_today_dated_log(log)
            r1 = _run(["oneline", str(log)], env=h.env)
            self.assertEqual(r1.returncode, 0, r1.stderr)
            sd = Path(h.tmp) / "state"
            today1 = json.loads((sd / "today.json").read_text())
            month1 = json.loads((sd / "month.json").read_text())
            lines1 = (sd / "sessions.jsonl").read_text().count("\n")
            r2 = _run(["oneline", str(log)], env=h.env)
            self.assertEqual(r2.returncode, 0, r2.stderr)
            # 第二次同 log 打印 dedup 跳过（stdout 不再是完整 oneline 报告）
            self.assertIn("already folded", r2.stdout, "重跑应打印 dedup 跳过")
            self.assertNotIn("session:    today", r2.stdout)
            today2 = json.loads((sd / "today.json").read_text())
            month2 = json.loads((sd / "month.json").read_text())
            lines2 = (sd / "sessions.jsonl").read_text().count("\n")
            self.assertEqual(today1, today2, "同 session 重跑不得重复累加 today")
            self.assertEqual(month1, month2, "同 session 重跑不得重复累加 month")
            self.assertEqual(lines1, lines2, "同 session 重跑不得重复追加 history")

    def test_oneline_today_by_model_is_sliced_to_today_not_whole_session(self):
        """跨天的长会话：today.json 的 `by_model` 必须只含**今天那一片**，
        不能是整段会话的量。

        真机回归：一个跨 2026-08-23/08-26/08-27 三天的会话（中途 compact）
        被审计后，hour 桶被 `merge_today` 正确过滤成只剩今天的 245,760
        token，而 `by_model` 收的是整段 `token_by_model` 的 17,596,160——
        同一个 today.json 里两个字段差 70 倍，「今日估算成本」（读
        by_model）于是报出整段会话的钱。修法是调用方改传
        `token_by_date_model(events)[今天]` 的精确切片。

        不变量：**by_model 四桶之和 == hour 桶四桶之和**（两个字段都只
        代表今天，必须对得上）。
        """
        with _TmpHome() as h:
            log = Path(h.tmp) / "spanning.jsonl"
            now_ms = int(__import__("time").time() * 1000)
            day_ms = 86_400_000
            lines = [
                {"type": "session", "version": 0, "id": "s",
                 "createdAt": now_ms - 2 * day_ms, "cwd": "/tmp", "delegationDepth": 0},
                {"type": "request/header", "seq": 1, "time": now_ms - 2 * day_ms,
                 "data": {"header": {"config": {"model": "deepseek-v4-flash"}}}},
                # 两天前的一大笔——不该出现在 today.json 的任何字段里
                {"type": "assistant/chunk", "seq": 2, "time": now_ms - 2 * day_ms,
                 "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                          "usage": {"inputTokens": 9_000_000, "outputTokens": 1000}}}},
                # 今天的一小笔
                {"type": "assistant/chunk", "seq": 3, "time": now_ms,
                 "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
                          "usage": {"inputTokens": 462, "outputTokens": 3520}}}},
            ]
            log.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")

            r = _run(["oneline", str(log)], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            today = json.loads((Path(h.tmp) / "state" / "today.json").read_text())

            F = ("uncached_input_tokens", "output_tokens",
                 "cache_read_tokens", "cache_write_tokens")
            hour_total = sum(b[f] for b in today["buckets"].values() for f in F)
            model_total = sum(m[f] for m in today["by_model"].values() for f in F)
            self.assertEqual(hour_total, 462 + 3520,
                             "hour 桶应该只有今天那一笔")
            self.assertEqual(model_total, hour_total,
                             "by_model 必须与 hour 桶对得上——两个字段都只代表今天，"
                             "不能一个是今天、另一个是整段会话")

    def test_oneline_on_historical_log_does_not_pollute_todays_hour_buckets(self):
        """回归：审计一份**历史日期**的日志（`fixtures/dsh/behavior.jsonl`
        固定在 2025-06-15）不该往 today.json 的 (hour) 桶里塞任何数据——
        真机复现过的 bug：`merge_today` 曾经只按"几点"合并、完全不看
        日期，回填任意一份日志只要事件落在 21、22 点就会被塞进
        today.json 的 21/22 点格子，北京时间下午查看却看到"今天"有
        21、22 点的数据（一天还没过完，物理上不可能）。"""
        with _TmpHome() as h:
            r = _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            today = json.loads((Path(h.tmp) / "state" / "today.json").read_text())
            self.assertEqual(today.get("buckets", {}), {},
                             "2025-06-15 的日志不该出现在 today.json 的任何 hour 桶里")


class TestOnelinePerModelPricing(unittest.TestCase):
    """端到端:oneline 落盘的 by_model 要真的驱动 budget.py 的定价——
    不是写了字段但没人读。用今天日期的日志混两个模型（不能再用
    `fixtures/dsh/behavior.jsonl`——它固定在 2025-06-15，`merge_today`
    现在会把没有今天证据的 session 的 by_model 一并跳过,见
    state.py::merge_today 的文档）。"""

    def test_today_by_model_populated_and_alert_uses_accurate_price(self):
        with _TmpHome() as h:
            log = Path(h.tmp) / "today.jsonl"
            _write_today_dated_multi_model_log(log, [
                ("deepseek/deepseek-v4-flash", 500000, 100),
                ("deepseek/deepseek-v4-pro-0813", 300000, 50),
            ])
            r = _run(["oneline", str(log)], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            sd = Path(h.tmp) / "state"
            today = json.loads((sd / "today.json").read_text())
            by_model = today.get("by_model")
            self.assertTrue(by_model, "oneline 应该把 usage['by_model'] 写进 today.json")
            self.assertIn("deepseek/deepseek-v4-flash", by_model)
            self.assertIn("deepseek/deepseek-v4-pro-0813", by_model)

            with mock.patch.dict(os.environ, h.env, clear=False):
                accurate = budget_module.compute_today_cost()
                pricing = cost_module.load_pricing()
                # 旧近似:把同样的桶(不分模型)硬按 fallback 模型算一遍——
                # 应该跟精确定价的结果不一样,证明确实在用 by_model 路径,
                # 不是悄悄退回了 fallback。
                flat_bucket = {
                    "uncached_input_tokens": sum(
                        m["uncached_input_tokens"] for m in by_model.values()),
                    "output_tokens": sum(m["output_tokens"] for m in by_model.values()),
                    "cache_read_tokens": sum(m["cache_read_tokens"] for m in by_model.values()),
                    "cache_write_tokens": sum(m["cache_write_tokens"] for m in by_model.values()),
                    "peak_uncached_input_tokens": sum(
                        m["peak_uncached_input_tokens"] for m in by_model.values()),
                    "peak_output_tokens": sum(
                        m["peak_output_tokens"] for m in by_model.values()),
                    "peak_cache_read_tokens": sum(
                        m["peak_cache_read_tokens"] for m in by_model.values()),
                    "peak_cache_write_tokens": sum(
                        m["peak_cache_write_tokens"] for m in by_model.values()),
                }
                old_approx = budget_module._bucket_cost(flat_bucket, pricing)
            self.assertNotAlmostEqual(
                accurate["total"], old_approx["total"], places=4,
                msg="behavior.jsonl 混了 pro,精确定价不应等于旧的 flash-only 近似")

    def test_month_by_model_attributed_to_the_log_own_date_not_today(self):
        """回归：`fixtures/dsh/behavior.jsonl` 的事件全部发生在 2025-06-15
        （固定历史日期，永远不等于跑测试那天，也永远不等于当前自然月）。
        老实现把 `oneline` 喂进的 `by_model` 一律记进 `_today_key()`，回填
        这份历史日志会把 by_model 错记成"今天"——真实 2026-08 的 month.json
        因此漏记了没有落到回填当天的部分（月度精算成本一度偏差 4 倍）。

        2025-06 不是当前自然月，`merge_month` 会把它迁进
        `month-archive.json`（见 state.py 的跨月归档设计）——这条测试因此
        直接检查归档文件，而不是 month.json。"""
        with _TmpHome() as h:
            r = _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            month = json.loads((Path(h.tmp) / "state" / "month.json").read_text())
            self.assertNotIn("2025-06-15", month.get("days", {}),
                             "历史月的数据不该留在只保存当前月的 month.json 里")

            archive = json.loads(
                (Path(h.tmp) / "state" / "month-archive.json").read_text())
            day = archive["months"]["2025-06"]["days"]["2025-06-15"]
            by_model = day.get("by_model")
            self.assertTrue(by_model, "历史日期桶应该带 by_model,不是只有 4 基础桶")
            self.assertIn("deepseek/deepseek-v4-flash", by_model)
            self.assertIn("deepseek/deepseek-v4-pro-0813", by_model)

            import datetime
            today_str = datetime.datetime.now(
                datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d")
            if today_str in month["days"]:
                self.assertNotIn(
                    "by_model", month["days"][today_str],
                    "2025-06-15 的历史日志不应该把 by_model 记到'今天'头上")


class TestStateCli(unittest.TestCase):
    def test_state_list_empty(self):
        with _TmpHome() as h:
            r = _run(["state", "list"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout.strip(), "(empty)")

    def test_state_list_after_oneline(self):
        """oneline 后 state list 应该列出三个文件。"""
        with _TmpHome() as h:
            _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            r = _run(["state", "list"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            for name in ("oneline.json", "today.json", "month.json"):
                self.assertIn(name, r.stdout)

    def test_state_clean_refuses_without_yes(self):
        with _TmpHome() as h:
            _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            r = _run(["state", "clean"], env=h.env)
            self.assertEqual(r.returncode, 2, "refusing without --yes 应 exit 2")
            self.assertIn("refusing without --yes", r.stderr)

    def test_state_clean_with_yes_removes_files(self):
        with _TmpHome() as h:
            _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            r = _run(["state", "clean", "--yes"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            r2 = _run(["state", "list"], env=h.env)
            self.assertEqual(r2.stdout.strip(), "(empty)")

    def test_state_months_lists_current_and_archived(self):
        """`fixtures/dsh/behavior.jsonl` 的事件全在 2025-06-15——不是当前
        自然月，`oneline` 之后应该被归档，`state months` 能查到它。"""
        with _TmpHome() as h:
            r = _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            r = _run(["state", "months"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("2025-06", r.stdout.split())

    def test_state_months_empty_says_no_data(self):
        with _TmpHome() as h:
            r = _run(["state", "months"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout.strip(), "(no data)")


class TestBudgetShowMonth(unittest.TestCase):
    """`budget show --month YYYY-MM` —— 查询特定月份，不受当前月限制。"""

    def test_query_archived_month_by_flag(self):
        with _TmpHome() as h:
            r = _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            r = _run(["budget", "show", "--month", "2025-06", "--json"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(out["month"], "2025-06")
            self.assertIsNotNone(out["cost"])
            self.assertGreater(out["cost"]["total"], 0)

    def test_query_month_with_no_data_reports_none_not_zero(self):
        """缺数据必须报 None（缺列不编列），不能编一个 0 出来。"""
        with _TmpHome() as h:
            r = _run(["budget", "show", "--month", "1999-01", "--json"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertIsNone(out["cost"])


class TestCalendarCli(unittest.TestCase):
    def test_calendar_renders_template(self):
        """calendar 应 cp 模板 + 同目录 cp 状态文件 —— 双击 HTML 即可打开。"""
        with _TmpHome() as h:
            _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            with tempfile.TemporaryDirectory() as td:
                out = Path(td) / "cal.html"
                r = _run(["calendar", "--source", "today", "-o", str(out)],
                         env=h.env)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertTrue(out.is_file())
                self.assertGreater(out.stat().st_size, 1000,
                                   "模板应该有几 KB,不是空文件")
                # 同目录应 cp 一份 today.json
                self.assertTrue((Path(td) / "today.json").is_file())

    def test_calendar_inlines_accurate_per_model_cost(self):
        """日历页内联数据必须带上按真实模型精算的 cost/accurate_cost 字段——
        不能只让 budget show/xbar 菜单栏精确、日历页还留在 flash-only 近似
        （混了 flash 和 pro,两者价差 3 倍,足以暴露这个字段缺失）。用今天
        日期的日志（不能再用 `fixtures/dsh/behavior.jsonl`——它固定在
        2025-06-15，`merge_today` 现在会把没有今天证据的 session 的
        by_model 一并跳过，见 state.py::merge_today 的文档）。sidecar
        副本（file picker fallback 用）必须保持 state 文件原始字节，
        不带这个额外字段——那份要跟 state.py 的 schema 契约字面一致。"""
        with _TmpHome() as h:
            log = Path(h.tmp) / "today.jsonl"
            _write_today_dated_multi_model_log(log, [
                ("deepseek/deepseek-v4-flash", 500000, 100),
                ("deepseek/deepseek-v4-pro-0813", 300000, 50),
            ])
            r = _run(["oneline", str(log)], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            with tempfile.TemporaryDirectory() as td:
                out = Path(td) / "cal.html"
                r = _run(["calendar", "--source", "today", "-o", str(out)], env=h.env)
                self.assertEqual(r.returncode, 0, r.stderr)
                html = out.read_text(encoding="utf-8")

                m = re.search(
                    r'<script id="agent-vitals-data-today"[^>]*>(.*?)</script>',
                    html, re.DOTALL)
                self.assertIsNotNone(m, "today 内联数据块必须存在")
                inlined = json.loads(m.group(1))
                self.assertIn("accurate_cost", inlined,
                              "today 视图应该有顶层 accurate_cost 字段")
                self.assertGreater(inlined["accurate_cost"]["total"], 0)

                pricing = cost_module.load_pricing()
                expected = cost_module.cost_report(
                    {"by_model": inlined["by_model"]}, pricing)
                self.assertAlmostEqual(
                    inlined["accurate_cost"]["total"], expected["total"], places=6,
                    msg="日历内联的精算总价必须与 cost_report 直接算出来的一致")

                # sidecar 副本必须是原始字节——不带 accurate_cost
                sidecar = json.loads((Path(td) / "today.json").read_text())
                self.assertNotIn("accurate_cost", sidecar,
                                  "sidecar 是 state.py 契约文件，不该带展示层附加字段")

    def test_calendar_does_not_embed_stale_today_as_todays_data(self):
        """`today.json` 的 `date` 字段一旦落后于真实当前日期,日历「今天」
        tab 必须当成没有数据处理,不能把陈旧的一整天热力图画出来标成"今天"。

        真机回归链条（两轮才修完）：
        1. `rotate_today()` 只在 `merge_today()` 开头被调用——今天一次 DSH
           会话都没跑时 today.json 会原封不动停在最后一次有会话的那天。
           之前只在 `budget.compute_today_cost()`（菜单栏）修过这个校验,
           日历渲染是另一个读者，同一个 bug 换个入口又出现了一次：
           2026-08-27 当天没用过 DSH，日历「今天 24 小时」tab 仍然画出
           08-26 的完整 24 小时热力图（真正的"今天"不可能有 24 小时数据，
           一天还没过完，这个矛盾本身就是发现这个 bug 的线索）。
        2. 第一版修法是「陈旧就整个不内联」——但 JS 找不到
           `agent-vitals-data-today` 这个 script 标签时,会当成"不确定
           有没有文件"走 fetch() 兜底,在 file:// 打开时必然撞 CORS,
           弹出一句让人费解的"读取本地文件被 CORS 阻止"（真实复现：之前
           today.json 几乎总有数据可内联，这条 fetch 分支很少被走到，这
           次改动第一次把它暴露出来）。现在改成内联一个显式的
           `{"stale": true, "stale_date": ...}` 哨兵，JS 认出它就直接
           显示"今天还没有数据"，不再往 fetch/file-picker 那条分支走。
        """
        with _TmpHome() as h:
            r = _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            today_path = Path(h.tmp) / "state" / "today.json"
            today = json.loads(today_path.read_text())
            # 手动把 date 改成"昨天"，模拟"今天还没跑过任何 DSH 会话"
            today["date"] = "2020-01-01"
            today_path.write_text(json.dumps(today))

            with tempfile.TemporaryDirectory() as td:
                out = Path(td) / "cal.html"
                r = _run(["calendar", "--source", "today", "-o", str(out)], env=h.env)
                self.assertEqual(r.returncode, 0, r.stderr)
                html = out.read_text(encoding="utf-8")
                m = re.search(
                    r'<script id="agent-vitals-data-today"[^>]*>(.*?)</script>',
                    html, re.DOTALL)
                self.assertIsNotNone(
                    m, "必须内联一个哨兵——不能让 JS 落入'找不到 script 标签'"
                       "那条会触发 fetch()/CORS 报错的分支")
                sentinel = json.loads(m.group(1))
                self.assertTrue(sentinel.get("stale"),
                                "陈旧数据必须显式标 stale,不能悄悄传成真数据")
                self.assertEqual(sentinel.get("stale_date"), "2020-01-01")
                # sidecar 仍然照写真实原始字节——那是原始文件的副本，
                # 不是"今天该显示什么"的判断，跟哨兵是两回事
                sidecar = json.loads((Path(td) / "today.json").read_text())
                self.assertEqual(sidecar["date"], "2020-01-01")

    def test_calendar_embeds_codex_three_view_blob(self):
        """统一看板（docs/UNIFIED_COST_VIEW.md 的 1 号执行环境契约）：calendar
        生成的文件必须内联 `agent-vitals-data-codex` 规范单块 =
        {harness, currency, today, default, views:{today,month,all}}。每个 view
        即一份 codex 成本报告（harness/currency/month/total_cost_usd/per_model/
        days/unaccounted_usage/plan；today 视图额外带 hours）。用**当前月**
        打戳的 rollout 保证 month/all 非空；today 视图无数据但契约键不能缺
        （JS 渲染按键存在性分派，缺键和空数据是两个分支）。
        """
        with _TmpHome() as h:
            from datetime import datetime, timedelta, timezone
            beijing = timezone(timedelta(hours=8))
            month01 = datetime.now(beijing).strftime("%Y-%m-01")
            ts = month01 + "T12:00:00Z"
            live = Path(h.tmp) / ".codex" / "sessions" / "2026" / "08"
            live.mkdir(parents=True)
            events = [
                {"timestamp": ts, "type": "turn_context",
                 "payload": {"model": "gpt-5.6-sol"}},
                {"timestamp": ts, "type": "event_msg", "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 100000, "output_tokens": 50000,
                            "cached_input_tokens": 0,
                            "cache_write_input_tokens": 0,
                            "reasoning_output_tokens": 0, "total_tokens": 150000},
                        "last_token_usage": {
                            "input_tokens": 100000, "output_tokens": 50000,
                            "cached_input_tokens": 0,
                            "cache_write_input_tokens": 0,
                            "reasoning_output_tokens": 0}}}},
            ]
            (live / "rollout-blob.jsonl").write_text(
                "".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")

            r = _run(["oneline", "fixtures/dsh/behavior.jsonl"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            with tempfile.TemporaryDirectory() as td:
                out = Path(td) / "cal.html"
                r = _run(["calendar", "-o", str(out)], env=h.env)
                self.assertEqual(r.returncode, 0, r.stderr)
                html = out.read_text(encoding="utf-8")
                m = re.search(
                    r'<script id="agent-vitals-data-codex"[^>]*>(.*?)</script>',
                    html, re.DOTALL)
                self.assertIsNotNone(m, "统一看板必须内联 codex 1 号执行环境数据块")
                blob = json.loads(m.group(1))
                self.assertEqual(blob["harness"], "codex")
                self.assertEqual(blob["currency"], "USD")
                self.assertEqual(blob["default"], "month")
                self.assertEqual(set(blob["views"].keys()), {"today", "month", "all"})
                month_view = blob["views"]["month"]
                for key in ("harness", "currency", "month", "total_cost_usd",
                            "total_tokens", "per_model", "days",
                            "unpriced_tokens", "unaccounted_usage", "plan"):
                    self.assertIn(key, month_view,
                                  "month 视图缺契约键 %s" % key)
                self.assertEqual(month_view["harness"], "codex")
                self.assertTrue(month_view["per_model"],
                                "当前月打戳的 rollout 应产出非空模型轴")
                self.assertTrue(month_view["days"],
                                "当前月打戳的 rollout 应产出非空日轴")
                # today 视图契约：want_hours=True → hours 键必须存在
                #（无今天数据时为空列表，但键不能缺）。
                self.assertIn("hours", blob["views"]["today"])


class TestAugmentCalendarCostCoverage(unittest.TestCase):
    """`_augment_calendar_cost` 必须校验 `by_model` 覆盖率,不能只看「存不存在」。

    回归：8 月账目里,`by_model` 只覆盖了当天 0.7%~32.5% 的 token（跨零点
    会话只把切到那一天的一部分记了下来），老实现只要 `by_model` 存在就
    整天标「精算」、用它算出的总价直接报出去——剩下 67%~99% 的 token
    静默消失，月度成本因此漏算了 4 倍。"""

    def _flat_bucket(self, **overrides):
        b = {f: 0 for f in cost_module.DAY_BUCKET_FIELDS}
        b.update(overrides)
        return b

    def test_full_coverage_is_marked_exact(self):
        """by_model 之和 == 当天总量 → pricing_basis 'exact',coverage 1.0,
        total 与直接调用 cost_report 一致（不含任何 fallback 补齐）。"""
        pricing = cost_module.load_pricing()
        by_model = {"deepseek-v4-flash": self._flat_bucket(
            uncached_input_tokens=1_000_000, output_tokens=100_000)}
        day = self._flat_bucket(uncached_input_tokens=1_000_000, output_tokens=100_000)
        day["by_model"] = by_model
        data = {"days": {"2026-08-17": day}}

        cli_module._augment_calendar_cost("month", data, pricing)

        cost = data["days"]["2026-08-17"]["cost"]
        self.assertEqual(cost["pricing_basis"], "exact")
        self.assertEqual(cost["coverage"], 1.0)
        expected = cost_module.cost_report({"by_model": by_model}, pricing)
        self.assertAlmostEqual(cost["total"], expected["total"], places=9)

    def test_partial_coverage_tops_up_with_fallback_price_not_silently_dropped(self):
        """by_model 只覆盖当天一部分 token → pricing_basis 'partial',
        coverage < 1,total 必须严格大于「只按覆盖部分算」的价格——证明
        没覆盖的那部分token 真的被计价了,不是凭空消失。"""
        pricing = cost_module.load_pricing()
        covered = 1_000_000       # by_model 里记着的（比如 pro）
        uncovered = 9_000_000     # 当天总量比 by_model 多出来的部分（未归属）
        by_model = {"deepseek-v4-pro": self._flat_bucket(uncached_input_tokens=covered)}
        day = self._flat_bucket(uncached_input_tokens=covered + uncovered)
        day["by_model"] = by_model
        data = {"days": {"2026-08-17": day}}

        cli_module._augment_calendar_cost("month", data, pricing)

        cost = data["days"]["2026-08-17"]["cost"]
        self.assertEqual(cost["pricing_basis"], "partial")
        self.assertAlmostEqual(cost["coverage"], covered / (covered + uncovered), places=9)

        covered_only = cost_module.cost_report({"by_model": by_model}, pricing)
        self.assertGreater(
            cost["total"], covered_only["total"],
            "未覆盖的 9M token 必须被 fallback 价补齐进 total,不能悄悄消失")

        top_up = cost_module.fallback_price(
            self._flat_bucket(uncached_input_tokens=uncovered), pricing)
        self.assertAlmostEqual(
            cost["total"], covered_only["total"] + top_up["total"], places=9,
            msg="total 必须恰好等于「精算部分 + fallback 补齐部分」,不多不少")

    def test_zero_by_model_leaves_day_untouched(self):
        """没有 by_model 的日子（老数据/纯近似日）不该被这个函数动——
        continue 分支,不产生 cost 字段,calendar.html 走 JS 近似兜底。"""
        pricing = cost_module.load_pricing()
        day = self._flat_bucket(uncached_input_tokens=100)
        data = {"days": {"2026-08-01": day}}
        cli_module._augment_calendar_cost("month", data, pricing)
        self.assertNotIn("cost", data["days"]["2026-08-01"])


class TestUsageHourBucketsReconcile(unittest.TestCase):
    """oneline 的 hour_buckets_summary 与 token_by_model 数字必须对得上。

    与 token_by_model / hour_buckets 的不变量是同一回事 —— M3 通过 oneline
    把 hour_buckets 暴露到 state 文件,这条对账必须仍然成立。

    **前提是这份日志的事件真的发生在今天**——`merge_today` 现在会把不
    属于今天的桶滤掉（见 state.py::merge_today 的文档），所以这里不能再
    用固定历史日期的 `fixtures/dsh/behavior.jsonl`，得用一份时间戳是
    "现在"的日志，见 `_write_today_dated_log`。
    """

    def test_oneline_hour_buckets_match_token_by_model(self):
        with _TmpHome() as h:
            log = Path(h.tmp) / "today.jsonl"
            _write_today_dated_log(log)
            r = _run(["oneline", str(log)], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            today = json.loads((Path(h.tmp) / "state" / "today.json").read_text())
            oneline = json.loads((Path(h.tmp) / "state" / "oneline.json").read_text())
            # today.json 所有 hour 桶的 4 基础桶（input + output + cache_read
            # + cache_write）累加 = oneline tokens_total
            # —— 与 token_by_model 的同源不变量一致：两边 4 桶之和必须相等
            hour_total = sum(
                b["uncached_input_tokens"] + b["output_tokens"]
                + b["cache_read_tokens"] + b["cache_write_tokens"]
                for b in today["buckets"].values())
            self.assertEqual(hour_total, oneline["tokens_total"],
                             "hour_buckets 4 桶累加 == oneline tokens_total")


class TestCodexSessionHtml(unittest.TestCase):
    """`codex-session --html` 的独立模板（DSH 审计 tab 版式）渲染 sanity。

    HTML 是 presentation，不进 byte 差分（同 calendar）——这里断言**结构**：
    单块 `agent-vitals-data-codex-session` JSON 已转义内联、5 个区块标题 +
    4 张 KPI 卡 + topbar 齐全、JSON 与 `--json` 同源。用真实 rollout 夹具喂
    固定 HOME，断言的是模板对真实数据的呈现，不是对假数据的容忍。
    """

    def test_codex_session_html_inlines_blob_and_sections(self):
        with _TmpHome() as h:
            import shutil
            live = Path(h.tmp) / ".codex" / "sessions" / "2026" / "08"
            live.mkdir(parents=True)
            shutil.copy2(ROOT / "fixtures" / "codex" / "cost" / "rollout-sol.jsonl",
                         live / "rollout-sol.jsonl")
            with tempfile.TemporaryDirectory() as td:
                out = Path(td) / "codex-session.html"
                r = _run(["codex-session", "--session", "rollout-sol",
                          "--html", str(out)], env=h.env)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertTrue(out.is_file())
                html = out.read_text(encoding="utf-8")

                # 单块 JSON：转义后内联（`</script`→`<\/script`），可逆解析。
                m = re.search(
                    r'<script id="agent-vitals-data-codex-session"[^>]*>(.*?)</script>',
                    html, re.DOTALL)
                self.assertIsNotNone(m, "codex-session --html 必须内联审计数据块")
                blob = json.loads(m.group(1))
                self.assertEqual(blob["harness"], "codex")
                self.assertEqual(blob["session_id"], "rollout-sol")
                self.assertEqual(blob["currency"], "USD")

                # JSON 与 `--json` 输出同源（同一份 codex_session_audit_json）。
                r2 = _run(["codex-session", "--session", "rollout-sol",
                           "--json", "-"], env=h.env)
                self.assertEqual(r2.returncode, 0, r2.stderr)
                self.assertEqual(json.loads(r2.stdout), blob,
                                 "HTML 内联 JSON 必须等于 --json 输出")

                # 5 个区块标题（会话资源概览 / 时间线 / 出处与覆盖 / 计划 / Finding）。
                for title in ("会话资源概览", "会话时间线", "出处与覆盖",
                              "计划与额度", "Finding 队列"):
                    self.assertIn(title, html, "缺区块标题 %s" % title)
                # 4 张 KPI 卡标签。
                for label in ("基础成本估算", "Token 用量", "上下文上限", "异常"):
                    self.assertIn(label, html, "缺 KPI 标签 %s" % label)
                # topbar 锚点。
                for anchor in ("sv-title", "sv-sid", "sv-chips"):
                    self.assertIn('id="%s"' % anchor, html)

    def test_codex_session_html_escapes_closing_script(self):
        """JSON 里若含 `</script` / `<!--` 必须转义——否则浏览器解析 HTML 时
        提前截断。构造一条带恶意串的 session，断言转义后无裸 `</script>`。"""
        with _TmpHome() as h:
            import shutil
            live = Path(h.tmp) / ".codex" / "sessions" / "2026" / "08"
            live.mkdir(parents=True)
            # 标题（session_index 查表）注入 `</script>`。
            index_dir = Path(h.tmp) / ".codex"
            index_dir.mkdir(parents=True, exist_ok=True)
            (index_dir / "session_index.jsonl").write_text(
                '{"id": "rollout-sol", "thread_name": "</script><script>alert(1)"}\n',
                encoding="utf-8")
            shutil.copy2(ROOT / "fixtures" / "codex" / "cost" / "rollout-sol.jsonl",
                         live / "rollout-sol.jsonl")
            with tempfile.TemporaryDirectory() as td:
                out = Path(td) / "codex-session.html"
                r = _run(["codex-session", "--session", "rollout-sol",
                          "--html", str(out)], env=h.env)
                self.assertEqual(r.returncode, 0, r.stderr)
                html = out.read_text(encoding="utf-8")
                # 数据块内不得出现裸 `</script>`（唯一合法的 `</script>` 是块闭合）。
                body = re.search(
                    r'<script id="agent-vitals-data-codex-session"[^>]*>(.*?)</script>',
                    html, re.DOTALL).group(1)
                self.assertNotIn("</script>", body,
                                 "数据块内不得有未转义的 </script>")
                # 转义后仍可解析成原串。
                self.assertEqual(json.loads(body)["title"], "</script><script>alert(1)")


class TestCodexFoldCache(unittest.TestCase):
    """codex 整折叠 memo（`$AGENT_VITALS_HOME/cache/codex-fold.json`）。

    背景：codex 折叠的瓶颈是**解析**不是折叠（真机 51 份 rollout ≈600MB
    JSONL ≈38s）——日历/oneline 每次刷新都重扫会砸穿 xbar tick（2026-08-29
    测试挂死的根因之一）。缓存是纯 memo：签名 (path, size, mtime_ns) 全等则
    命中、不等则重扫，命中与否输出逐字节相同（差分门不受影响）。
    """

    def test_cache_hit_skips_rescan_and_invalidation_rescans(self):
        with _TmpHome() as h:
            import shutil
            from agent_vitals.adapters import codex_session
            with mock.patch.dict(os.environ, h.env, clear=False):
                live = Path(h.tmp) / ".codex" / "sessions" / "2026" / "08"
                live.mkdir(parents=True)
                shutil.copy2(ROOT / "fixtures" / "codex" / "cost" / "rollout-sol.jsonl",
                             live / "rollout-sol.jsonl")

                fold1 = cli_module.codex_fold_merged()
                self.assertTrue(cli_module._codex_fold_cache_path().is_file(),
                                "第一次折叠应写缓存")

                # 命中：不再解析任何 rollout 文件
                with mock.patch.object(
                        codex_session, "read_codex_session_log",
                        wraps=codex_session.read_codex_session_log) as read:
                    fold2 = cli_module.codex_fold_merged()
                    read.assert_not_called()
                self.assertEqual(fold1, fold2, "缓存命中应返回同一份 fold")

                # 签名失效（mtime 变）→ 重扫一次，结果不变
                os.utime(live / "rollout-sol.jsonl", (1, 1))
                with mock.patch.object(
                        codex_session, "read_codex_session_log",
                        wraps=codex_session.read_codex_session_log) as read:
                    fold3 = cli_module.codex_fold_merged()
                    self.assertEqual(read.call_count, 1,
                                     "签名失效后必须重扫一次")
                self.assertEqual(fold1, fold3)

    def test_broken_cache_degrades_to_rescan(self):
        """缓存文件写坏（崩溃留半文件）→ 读不出 → 当没有缓存重扫，不崩。"""
        with _TmpHome() as h:
            import shutil
            with mock.patch.dict(os.environ, h.env, clear=False):
                live = Path(h.tmp) / ".codex" / "sessions" / "2026" / "08"
                live.mkdir(parents=True)
                shutil.copy2(ROOT / "fixtures" / "codex" / "cost" / "rollout-sol.jsonl",
                             live / "rollout-sol.jsonl")
                fold1 = cli_module.codex_fold_merged()
                # 把缓存写成非法 JSON（模拟崩溃残留）
                cli_module._codex_fold_cache_path().write_text(
                    '{"version": 1, "signature": ', encoding="utf-8")
                fold2 = cli_module.codex_fold_merged()
                self.assertEqual(fold1, fold2, "坏缓存应降级为重扫，结果一致")

    def test_cache_outside_state_dir_does_not_pollute_state(self):
        """缓存进 `$AGENT_VITALS_HOME/cache/`，不进 `state/`——state 目录的
        读者（list_state_files / list_months / doctor）不该被缓存文件污染。"""
        with _TmpHome() as h:
            import shutil
            with mock.patch.dict(os.environ, h.env, clear=False):
                live = Path(h.tmp) / ".codex" / "sessions" / "2026" / "08"
                live.mkdir(parents=True)
                shutil.copy2(ROOT / "fixtures" / "codex" / "cost" / "rollout-sol.jsonl",
                             live / "rollout-sol.jsonl")
                cli_module.codex_fold_merged()
                state_files = {p.name for p in Path(h.tmp).glob("state/*.json")}
                self.assertNotIn("codex-fold.json", state_files)
                self.assertTrue(cli_module._codex_fold_cache_path().is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
