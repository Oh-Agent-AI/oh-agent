"""state.py 测试 —— 状态文件 I/O 的 Python 侧锚点。

CLAUDE.md §六测试层把 fixture / golden / invariant / characterization
都分门别类，state.py 是个新模块所以这里用 invariant + characterization
混合：每条「state 文件必须 X」的不变量一个 test method，每条具体行为
也一个 test method。

测试通过临时 `$AGENT_VITALS_HOME` 隔离 —— 不能让真机 `~/.agent-vitals/
state/` 被测试读写污染（与 `tests/golden_runner.py` 同款约定）。
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# 把 scripts/ 加到 sys.path 以便 import agent_vitals —— 与仓库根 `python3
# -m unittest discover` 行为一致（项目里没有 setup.py / pyproject.toml）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "packages" / "agent-vitals-python"))

from agent_vitals import state


class _IsolatedHome:
    """临时 `$AGENT_VITALS_HOME` 隔离 fixture —— 让 state.py 的
    `state_dir()` 落到 tmp 目录，**不污染**真机 `~/.agent-vitals/state/`。

    用 `mock.patch.dict(os.environ, …)` 而非真改 HOME / 真 mkdir，因为
    state.py 自己也会 mkdir，mock 阻止它创建真机目录。
    """

    def __init__(self):
        self.tmpdir = tempfile.mkdtemp(prefix="sv-state-test-")
        self.env = {"AGENT_VITALS_HOME": self.tmpdir}

    def __enter__(self):
        self._patcher = mock.patch.dict(os.environ, self.env, clear=False)
        self._patcher.start()
        return self

    def __exit__(self, *args):
        self._patcher.stop()
        # 不主动删 tmp —— 看 _cleanup 是否有问题留给 CI 收
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)


class TestStateDir(unittest.TestCase):
    def test_state_dir_under_agent_vitals_home(self):
        with _IsolatedHome() as h:
            p = state.state_dir()
            self.assertEqual(p, Path(h.tmpdir) / "state")
            self.assertTrue(p.is_dir())

    def test_state_dir_created_lazily(self):
        """state_dir() 必须自己 mkdir，不让调用方操心。"""
        with _IsolatedHome():
            p = state.state_dir()
            self.assertTrue(p.is_dir())


class TestAtomicWrite(unittest.TestCase):
    def test_atomic_write_creates_file(self):
        with _IsolatedHome() as h:
            target = Path(h.tmpdir) / "sub" / "data.json"
            state._atomic_write(target, {"hello": "world", "n": 1})
            self.assertTrue(target.is_file())
            data = json.loads(target.read_text())
            self.assertEqual(data, {"hello": "world", "n": 1})

    def test_atomic_write_leaves_no_tmp_residue_on_success(self):
        """成功路径下不应留 `.tmp.*` 文件——它们是出错时的兜底。"""
        with _IsolatedHome() as h:
            target = Path(h.tmpdir) / "x.json"
            state._atomic_write(target, {"k": "v"})
            tmps = list(Path(h.tmpdir).glob("x.json.tmp.*"))
            self.assertEqual(tmps, [], "成功路径不应留 tmp")

    def test_atomic_write_cleans_tmp_on_failure(self):
        """失败路径下 tmp 必须被清理——state 目录不能被垃圾塞满。"""
        with _IsolatedHome() as h:
            target = Path(h.tmpdir) / "x.json"

            class _Boom(Exception):
                pass

            # 在 fdopen 之后、replace 之前注入异常
            real_replace = os.replace

            def boom(src, dst):
                os.unlink(src)
                raise _Boom("simulated")

            with mock.patch.object(os, "replace", side_effect=boom):
                with self.assertRaises(_Boom):
                    state._atomic_write(target, {"k": "v"})
            tmps = list(Path(h.tmpdir).glob("x.json.tmp.*"))
            self.assertEqual(tmps, [], "失败后必须清理 tmp")


class TestOneline(unittest.TestCase):
    def test_write_oneline_round_trip(self):
        with _IsolatedHome() as h:
            audit = {
                "session_id": "s-1",
                "tokens_total": 12345,
                "cost_cny": 1.23,
                "findings_total": 3,
                "findings_max_severity": "high",
            }
            p = state.write_oneline(audit)
            self.assertTrue(p.is_file())
            loaded = state.read_oneline()
            self.assertEqual(loaded["session_id"], "s-1")
            self.assertEqual(loaded["tokens_total"], 12345)
            self.assertEqual(loaded["schema_version"], state.SCHEMA_VERSION)
            self.assertIn("generated_at", loaded)

    def test_write_oneline_overwrites_previous(self):
        """oneline.json 永远是「最后一行」——不是历史。xbar 拿最新。"""
        with _IsolatedHome():
            state.write_oneline({"session_id": "a"})
            state.write_oneline({"session_id": "b"})
            loaded = state.read_oneline()
            self.assertEqual(loaded["session_id"], "b",
                             "覆盖语义：后写者赢")

    def test_read_oneline_missing_returns_none(self):
        """文件缺场时返回 None，让调用方走「没数据」分支而非编一个。"""
        with _IsolatedHome():
            self.assertIsNone(state.read_oneline())


class TestMergeToday(unittest.TestCase):
    def test_merge_today_accumulates_across_calls(self):
        """两次 audit 同一小时 → 该小时 8 字段全部累加。

        用 `state._today_key()` 而不是硬编码年月日——`merge_today` 现在
        按 date 过滤（只留真正发生在今天的桶，见该函数文档），硬编码一个
        固定日期迟早会随日历前进变成"不是今天"，那时这条测试会因为桶
        被过滤成空而失败,而不是它本来要测的"同一小时累加"。
        """
        with _IsolatedHome():
            d = state._today_key()
            # 第 1 次：14 点 +1000 input
            state.merge_today({"buckets": [
                {"date": d, "hour": 14, "is_peak": True,
                 "uncached_input_tokens": 1000, "output_tokens": 100,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 1000, "peak_output_tokens": 100,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            ]})
            # 第 2 次：14 点 +500 input，15 点 +200 input
            state.merge_today({"buckets": [
                {"date": d, "hour": 14, "is_peak": True,
                 "uncached_input_tokens": 500, "output_tokens": 50,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 500, "peak_output_tokens": 50,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                {"date": d, "hour": 15, "is_peak": True,
                 "uncached_input_tokens": 200, "output_tokens": 20,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 200, "peak_output_tokens": 20,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            ]})
            today = json.loads((state.state_dir() / "today.json").read_text())
            buckets = today["buckets"]
            # today.json 桶以 hour 字符串为 key —— 同一小时累加、不同小时独立
            self.assertEqual(buckets["14"]["uncached_input_tokens"], 1500)
            self.assertEqual(buckets["14"]["output_tokens"], 150)
            self.assertEqual(buckets["15"]["uncached_input_tokens"], 200)

    def test_merge_today_drops_buckets_from_other_dates(self):
        """`hour_buckets` 里不属于今天的桶必须被滤掉，不能靠 hour 数字
        碰巧撞上就被塞进 today.json。

        回归（真机复现）：`_merge_buckets(..., key_field="hour")` 只看
        几点，完全不看日期——回填/审计任意一份日志时，只要它的事件落在
        21、22 点（不管哪一天的 21、22 点），都会被合并进 today.json 的
        21/22 点格子。真实结果：北京时间下午 3 点查看日历，"今天 24 小时"
        热力图里却有 21 点、22 点的数据——物理上不可能，一天还没过完。
        """
        with _IsolatedHome():
            other_day = "2020-01-01"
            self.assertNotEqual(other_day, state._today_key())
            state.merge_today({"buckets": [
                {"date": other_day, "hour": 21, "is_peak": False,
                 "uncached_input_tokens": 999999, "output_tokens": 0,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            ]})
            today = json.loads((state.state_dir() / "today.json").read_text())
            self.assertEqual(today.get("buckets", {}), {},
                             "不属于今天的桶不该出现在 today.json 里,"
                             "不管它的 hour 数字是几点")

    def test_merge_today_keeps_only_the_matching_hour_when_mixed(self):
        """同一次调用里既有今天的桶又有别的日期的桶——只留今天那部分,
        不是整批全收或整批全丢。"""
        with _IsolatedHome():
            d = state._today_key()
            state.merge_today({"buckets": [
                {"date": d, "hour": 9, "is_peak": False,
                 "uncached_input_tokens": 100, "output_tokens": 0,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                {"date": "2020-01-01", "hour": 21, "is_peak": False,
                 "uncached_input_tokens": 999999, "output_tokens": 0,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            ]})
            today = json.loads((state.state_dir() / "today.json").read_text())
            buckets = today["buckets"]
            self.assertEqual(list(buckets.keys()), ["9"])
            self.assertEqual(buckets["9"]["uncached_input_tokens"], 100)

    def test_merge_today_drops_by_model_when_session_has_no_today_bucket(self):
        """`by_model` 没有逐小时的日期信息，但如果这份 session **确实有**
        带日期的 hour 桶、而且没有一个是今天，就是实锤证据证明这整段
        session 不是今天的，`by_model` 也该跳过——不能只滤桶不滤钱。

        真机复现：一个只在 2026-08-23/08-26 有真实活动的 session 被
        oneline 审计后，today.json 的 `by_model` 整段被记了进去，「今日
        估算成本」显示 ¥1.54，而当天（08-27）一次 DSH 会话都还没跑。
        """
        with _IsolatedHome():
            state.merge_today({"buckets": [
                {"date": "2020-01-01", "hour": 10, "is_peak": False,
                 "uncached_input_tokens": 100, "output_tokens": 0,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            ]}, by_model={
                "deepseek-v4-pro": {
                    "uncached_input_tokens": 999999, "output_tokens": 0,
                    "cache_read_tokens": 0, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            })
            today = json.loads((state.state_dir() / "today.json").read_text())
            self.assertNotIn("by_model", today,
                             "session 没有一个今天的桶时,by_model 不该被计进今天")

    def test_merge_today_keeps_by_model_when_no_dated_evidence_either_way(self):
        """没有任何带日期的桶（比如 hour_buckets 传了空列表）时,不能主动
        认定"这不是今天"——没有实锤证据时保留 by_model,是"heuristics
        sort, they never acquit"同一条纪律：宁可维持旧行为,也不能靠
        缺席的证据去认定一件事。"""
        with _IsolatedHome():
            state.merge_today({"buckets": []}, by_model={
                "deepseek-v4-pro": {
                    "uncached_input_tokens": 100, "output_tokens": 0,
                    "cache_read_tokens": 0, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            })
            today = json.loads((state.state_dir() / "today.json").read_text())
            self.assertIn("by_model", today)
            self.assertEqual(today["by_model"]["deepseek-v4-pro"]["uncached_input_tokens"], 100)

    def test_merge_today_accumulates_by_model_across_calls(self):
        """by_model 是与 (date, hour) 桶并列的新字段——两次 audit 同一
        模型 → 该模型 8 字段累加；不同模型互不影响。"""
        with _IsolatedHome():
            state.merge_today({"buckets": []}, by_model={
                "deepseek-v4-flash": {
                    "uncached_input_tokens": 1000, "output_tokens": 100,
                    "cache_read_tokens": 0, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            })
            state.merge_today({"buckets": []}, by_model={
                "deepseek-v4-flash": {
                    "uncached_input_tokens": 500, "output_tokens": 50,
                    "cache_read_tokens": 0, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                "deepseek-v4-pro": {
                    "uncached_input_tokens": 10, "output_tokens": 1,
                    "cache_read_tokens": 0, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            })
            today = json.loads((state.state_dir() / "today.json").read_text())
            by_model = today["by_model"]
            self.assertEqual(by_model["deepseek-v4-flash"]["uncached_input_tokens"], 1500)
            self.assertEqual(by_model["deepseek-v4-pro"]["uncached_input_tokens"], 10)
            # 旧的 (date, hour) 桶字段不受影响——两个字段并列存在
            self.assertIn("buckets", today)

    def test_merge_today_without_by_model_leaves_field_absent(self):
        """不传 by_model(旧调用方/legacy 数据) 不应凭空造出这个 key——
        budget.py 用 `data.get("by_model")` 判断是否有精确数据。"""
        with _IsolatedHome():
            state.merge_today({"buckets": []})
            today = json.loads((state.state_dir() / "today.json").read_text())
            self.assertNotIn("by_model", today)

    def test_merge_today_skips_unknown_date_buckets(self):
        """time 缺失的 (date=None) 样本不参与日历累计 —— 否则会被算成
        1970-01-01，凭空多出几万 token / 几百块。"""
        with _IsolatedHome():
            state.merge_today({"buckets": [
                {"date": None, "hour": None, "is_peak": None,
                 "uncached_input_tokens": 9999, "output_tokens": 0,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            ]})
            today = json.loads((state.state_dir() / "today.json").read_text())
            self.assertEqual(today.get("buckets", {}), {},
                             "未知时间样本不进日历")


class TestMergeMonth(unittest.TestCase):
    def test_merge_month_groups_by_date(self):
        """month.json 按日期折叠（同一天 0–23 点累加成一个日期桶）。

        用**当前自然月**的第 1/2 天而不是硬编码的历史日期——`merge_month`
        现在只把当前月的日子留在 month.json（见跨月归档设计），硬编码一个
        固定年月的日期迟早会随日历前进而"过期"变成历史月，那时这条测试会
        默默开始走归档分支而不是它本来要测的（date,hour)折叠。第 1/2 天
        保证永远存在、永远同月，不用处理"这个月有没有 30 号"。
        """
        with _IsolatedHome():
            m = state._month_key()
            d1, d2 = f"{m}-01", f"{m}-02"
            state.merge_month({"buckets": [
                {"date": d1, "hour": 14, "is_peak": True,
                 "uncached_input_tokens": 100, "output_tokens": 0,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 100, "peak_output_tokens": 0,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                {"date": d1, "hour": 15, "is_peak": True,
                 "uncached_input_tokens": 200, "output_tokens": 0,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 200, "peak_output_tokens": 0,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                {"date": d2, "hour": 9, "is_peak": True,
                 "uncached_input_tokens": 50, "output_tokens": 0,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 50, "peak_output_tokens": 0,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            ]})
            month = json.loads((state.state_dir() / "month.json").read_text())
            days = month["days"]
            self.assertEqual(days[d1]["uncached_input_tokens"], 300,
                             "同一天两个 hour 累加")
            self.assertEqual(days[d2]["uncached_input_tokens"], 50)

    def test_merge_month_by_date_model_attributed_to_its_own_date(self):
        """`by_date_model` 按自己携带的日期落位——不是 `_today_key()`。

        回归:老实现把 by_model 一律记进「今天」，回填历史日志时会把钱
        记错日子（真实 case：`session-e4b0be69` 横跨 4 天，整段 by_model
        被记成回填当天，月度精算成本因此漏记了没落在该日的部分，2026-08
        账目一度偏差 4 倍）。这里显式用一个**不等于**今天的历史日期，
        证明数据落在它自己的日期上，不受调用时间影响。"""
        with _IsolatedHome():
            historical = "2020-01-01"
            self.assertNotEqual(historical, state._today_key())
            state.merge_month({"buckets": []}, by_date_model={
                historical: {
                    "deepseek-v4-pro": {
                        "uncached_input_tokens": 100, "output_tokens": 10,
                        "cache_read_tokens": 0, "cache_write_tokens": 0,
                        "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                        "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                },
            })
            month = json.loads((state.state_dir() / "month.json").read_text())
            self.assertNotIn(state._today_key(), month["days"],
                              "历史回填不应该凭空造出'今天'这个日期桶")
            # 2020-01 不是当前自然月 → 落进归档而不是 month.json
            # （month.json 只保存当前月，见 merge_month 文档注释）
            self.assertNotIn(historical, month.get("days", {}),
                              "历史月的数据不该留在只保存当前月的 month.json 里")
            day = state.read_month("2020-01")["days"][historical]
            self.assertEqual(day["by_model"]["deepseek-v4-pro"]["uncached_input_tokens"], 100,
                              "按日期归位这条语义不变，只是历史月落到归档里")

    def test_merge_month_by_date_model_spans_multiple_dates(self):
        """一次 `merge_month` 调用可以同时落多个日期的 by_model——跨零点
        的长会话折叠出的 `by_date_model` 天然是多日期的，不需要多次调用。

        用当前自然月的第 1/2 天，原因同 `test_merge_month_groups_by_date`。
        """
        with _IsolatedHome():
            m = state._month_key()
            d1, d2 = f"{m}-01", f"{m}-02"
            state.merge_month({"buckets": []}, by_date_model={
                d1: {
                    "deepseek-v4-pro": {
                        "uncached_input_tokens": 100, "output_tokens": 0,
                        "cache_read_tokens": 0, "cache_write_tokens": 0,
                        "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                        "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                },
                d2: {
                    "deepseek-v4-flash": {
                        "uncached_input_tokens": 200, "output_tokens": 0,
                        "cache_read_tokens": 0, "cache_write_tokens": 0,
                        "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                        "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                },
            })
            month = json.loads((state.state_dir() / "month.json").read_text())
            self.assertEqual(
                month["days"][d1]["by_model"]["deepseek-v4-pro"]["uncached_input_tokens"], 100)
            self.assertEqual(
                month["days"][d2]["by_model"]["deepseek-v4-flash"]["uncached_input_tokens"], 200)


class TestMergeMonthArchive(unittest.TestCase):
    """跨月归档：`month.json` 只留当前自然月，旧月迁进 `month-archive.json`。

    回归：`merge_month` 从不清理旧月份、所有读者也不按月过滤时，跨月后
    "本月成本"会变成"有史以来成本"（真实测算：一个含 8 月两天 + 9 月一天
    的 month.json，被当 9 月账目直接求和，报出 201 倍的金额）。
    """

    @staticmethod
    def _bucket(u):
        return {"uncached_input_tokens": u, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0}

    def test_stale_month_moves_to_archive_on_next_merge(self):
        """month.json 里躺着一个不属于当前月的日子——下一次 merge_month
        （不管这次落的数据是哪天的）必须先把它搬进归档，不能留在
        month.json 里跟当前月的数据混在一起。"""
        with _IsolatedHome():
            stale_month = "2020-01"
            state._atomic_write(state.state_dir() / "month.json", {
                "days": {f"{stale_month}-15": self._bucket(1_000_000)},
                "month": stale_month, "schema_version": "1.0.0",
            })
            m = state._month_key()
            state.merge_month({"buckets": [
                {"date": f"{m}-01", "hour": 0, "is_peak": False,
                 **self._bucket(500)},
            ]})
            month = json.loads((state.state_dir() / "month.json").read_text())
            self.assertNotIn(f"{stale_month}-15", month["days"],
                             "旧月的日子不该继续留在 month.json 里")
            self.assertEqual(month["days"][f"{m}-01"]["uncached_input_tokens"], 500)
            self.assertEqual(month["month"], m)

            archived = state.read_month(stale_month)
            self.assertIsNotNone(archived, "旧月的数据应该能在归档里查到")
            self.assertEqual(
                archived["days"][f"{stale_month}-15"]["uncached_input_tokens"],
                1_000_000, "搬迁不能丢数据")

    def test_migration_to_archive_is_idempotent(self):
        """归档迁移用逐日**替换**，不是累加——多次触发迁移（比如崩溃后重跑）
        同一天的数据必须还是原样，不会被算成两倍。"""
        with _IsolatedHome():
            stale_month = "2020-01"
            state._atomic_write(state.state_dir() / "month.json", {
                "days": {f"{stale_month}-15": self._bucket(1_000_000)},
                "month": stale_month, "schema_version": "1.0.0",
            })
            m = state._month_key()
            hb = {"buckets": [{"date": f"{m}-01", "hour": 0, "is_peak": False,
                               **self._bucket(1)}]}
            state.merge_month(hb)   # 触发第一次迁移
            # 手动把同一个旧月的日子塞回 month.json，模拟"迁移完但没删干净
            # 又跑了一次"的场景
            existing = json.loads((state.state_dir() / "month.json").read_text())
            existing.setdefault("days", {})[f"{stale_month}-15"] = self._bucket(1_000_000)
            state._atomic_write(state.state_dir() / "month.json", existing)
            state.merge_month(hb)   # 触发第二次迁移

            archived = state.read_month(stale_month)
            self.assertEqual(
                archived["days"][f"{stale_month}-15"]["uncached_input_tokens"],
                1_000_000, "重复迁移同一天必须是替换，不是累加成 2,000,000")

    def test_backfill_into_an_already_archived_month_accumulates(self):
        """回填一份历史日志、目标日期在**已经归档**的旧月里——这不是"迁移"
        （迁移是搬运已有数据），是"新证据"，必须累加进归档里那一天已有的
        量，而不是替换掉它（否则回填会抹掉之前搬过去的真实数据）。"""
        with _IsolatedHome():
            stale_month = "2020-01"
            # 先归档一批
            state._atomic_write(state.state_dir() / "month.json", {
                "days": {f"{stale_month}-15": self._bucket(1_000_000)},
                "month": stale_month, "schema_version": "1.0.0",
            })
            m = state._month_key()
            state.merge_month({"buckets": [
                {"date": f"{m}-01", "hour": 0, "is_peak": False, **self._bucket(1)},
            ]})
            # 再对同一个已归档的历史日期做一次回填（比如翻出更早的日志）
            state.merge_month({"buckets": [
                {"date": f"{stale_month}-15", "hour": 5, "is_peak": False,
                 **self._bucket(200_000)},
            ]})
            archived = state.read_month(stale_month)
            self.assertEqual(
                archived["days"][f"{stale_month}-15"]["uncached_input_tokens"],
                1_200_000, "回填历史月应该累加，不是覆盖掉已归档的数据")

    def test_read_month_current_reads_month_json(self):
        with _IsolatedHome():
            m = state._month_key()
            state.merge_month({"buckets": [
                {"date": f"{m}-03", "hour": 0, "is_peak": False, **self._bucket(42)},
            ]})
            result = state.read_month()   # 不传参数 → 当前月
            self.assertEqual(result["month"], m)
            self.assertEqual(result["days"][f"{m}-03"]["uncached_input_tokens"], 42)

    def test_read_month_missing_returns_none(self):
        """查一个完全没有数据的月份——缺列不编列，不返回空壳。"""
        with _IsolatedHome():
            self.assertIsNone(state.read_month("1999-01"))

    def test_list_months_includes_current_and_archived(self):
        with _IsolatedHome():
            m = state._month_key()
            state.merge_month({"buckets": [
                {"date": f"{m}-01", "hour": 0, "is_peak": False, **self._bucket(1)},
            ]})
            state._atomic_write(state.state_dir() / "month-archive.json", {
                "months": {"2020-01": {"days": {"2020-01-15": self._bucket(1)}}},
                "schema_version": "1.0.0",
            })
            self.assertEqual(state.list_months(), sorted(["2020-01", m]))


class TestMergeModelBuckets(unittest.TestCase):
    def test_accumulates_across_calls_per_model(self):
        existing = state._merge_model_buckets(None, {
            "deepseek-v4-flash": {
                "uncached_input_tokens": 100, "output_tokens": 10,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
        })
        existing = state._merge_model_buckets(existing, {
            "deepseek-v4-flash": {
                "uncached_input_tokens": 50, "output_tokens": 5,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            "deepseek-v4-pro": {
                "uncached_input_tokens": 1, "output_tokens": 1,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
        })
        self.assertEqual(existing["deepseek-v4-flash"]["uncached_input_tokens"], 150)
        self.assertEqual(existing["deepseek-v4-pro"]["uncached_input_tokens"], 1)

    def test_empty_by_model_is_noop(self):
        self.assertEqual(state._merge_model_buckets({"a": 1}, {}), {"a": 1})
        self.assertEqual(state._merge_model_buckets(None, None), {})


class TestLock(unittest.TestCase):
    def test_lock_released_on_exit(self):
        """上下文退出后锁必须释放——否则下一次调用会卡死（POSIX flock
        是阻塞的）。"""
        with _IsolatedHome() as h:
            p = state.state_dir() / "x.json"
            with state._locked(p):
                pass
            # 第二次拿锁应该立即成功（如果第一次没释放会卡几秒）
            with state._locked(p):
                pass


class TestListStateFiles(unittest.TestCase):
    def test_list_excludes_lock_and_tmp(self):
        """`list_state_files()` 不返回 `.lock` 和 `.tmp.*` 文件。"""
        with _IsolatedHome():
            state.write_oneline({"k": "v"})
            (state.state_dir() / "stray.tmp.123").write_text("junk")
            (state.state_dir() / "stray.lock").write_text("junk")
            files = state.list_state_files()
            names = [f.name for f in files]
            self.assertIn("oneline.json", names)
            self.assertNotIn("stray.tmp.123", names)
            self.assertNotIn("stray.lock", names)


if __name__ == "__main__":
    unittest.main(verbosity=2)