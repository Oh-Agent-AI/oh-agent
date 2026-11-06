"""state.py 的 sessions.jsonl / rotate_today 回归测试。

拆自 test_xbar_integration.py（2026-09，xbar/SwiftBar 菜单栏形态整体退役，
见 docs/MENUBAR_MIGRATION.md——菜单栏主形态已迁到 Tauri app，contrib/xbar/
与 scripts/install_swiftbar.sh 一并删除）。这两组 invariant 本来就与 xbar
无关——它们钉的是 `state.py` 自己的行为（sessions.jsonl 追加、today→month
跨日 rotate），历史上只是恰好被 xbar 菜单栏第一个暴露出来，Tauri 菜单栏
tick（`apps/desktop/src-tauri/src/lib.rs`，同样调用 `oneline` → `state.py`/`state.rs`
写链）依赖的是完全相同的两条 invariant，所以测试本身继续留着，只是改名去
掉「xbar 回归测试」这层不再准确的框架：
1. sessions.jsonl 行数 ≥ oneline 调用次数
2. 每行 sessions.jsonl 含 generated_at 字段
3. rotate_today() 跨日自动清零（防 M8 那次「本地没更新」、8 月三倍虚增两次
   事故重演）
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "packages" / "agent-vitals-python"))

from agent_vitals import state, budget  # noqa


class _IsolatedHome:
    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="sv-state-test-")
        self.env = {"AGENT_VITALS_HOME": self.tmp}
        self._p = mock.patch.dict(os.environ, self.env, clear=False)
        self._p.start()
        return self
    def __exit__(self, *args):
        self._p.stop()
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestSessionsJsonl(unittest.TestCase):
    """session 历史日志 invariant(防 M8: 菜单栏看不到历史 bug)。"""

    def test_append_adds_generated_at(self):
        """append_session_history 必须自动补 generated_at — 菜单栏解析 hhmm 靠它。"""
        with _IsolatedHome():
            summary = {"session_id": "s1", "tokens_total": 100, "cost_cny": 1.0,
                       "model": "m"}
            state.append_session_history(summary)
            path = state.state_dir() / "sessions.jsonl"
            self.assertTrue(path.is_file())
            lines = path.read_text().strip().split("\n")
            self.assertEqual(len(lines), 1)
            row = json.loads(lines[0])
            self.assertIn("generated_at", row,
                          "append_session_history 必须自动补 generated_at")
            self.assertEqual(row["session_id"], "s1")

    def test_does_not_overwrite_existing_generated_at(self):
        """调用方已塞 generated_at 时不覆盖 — 保留调用方语义。"""
        with _IsolatedHome():
            summary = {"session_id": "s2", "generated_at": "1999-01-01T00:00:00+00:00"}
            state.append_session_history(summary)
            row = json.loads(
                (state.state_dir() / "sessions.jsonl").read_text().strip())
            self.assertEqual(row["generated_at"], "1999-01-01T00:00:00+00:00")


class TestRotateToday(unittest.TestCase):
    """today.json 跨日清零 invariant(防 M8: 累积 ¥1172 假告警)。"""

    def test_rotate_clears_today_without_touching_month(self):
        """**rotate 只清空 today.json，绝不往 month.json 里加东西。**

        回归（真实事故）：rotate 过去会把旧 today.json 的桶累加进
        `month.days[<旧日期>]`，但唯一的生产调用方 `cli.py` 的 oneline
        对同一份 hour_buckets **同时**调 merge_today 和 merge_month，
        月账早就由 merge_month 记过一遍了。于是每跨一天就重复计一次——
        实测 2026-08 的 month.json 每天正好是真实值的 3 倍，月度成本从
        ¥1733 虚增到 ¥2386。

        旧测试写死 today.json 后直接 rotate、month.json 是空的，重复相加
        看起来正好等于正确值,所以一直没红。**这条测试专门先把 month.json
        预置成「merge_month 已经记过」的真实状态**，rotate 之后数字必须
        纹丝不动。
        """
        with _IsolatedHome():
            sd = state.state_dir()
            bucket = {
                "uncached_input_tokens": 1_000_000,
                "output_tokens": 0, "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0,
                "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0,
                "peak_cache_write_tokens": 0,
            }
            state._atomic_write(sd / "today.json", {
                "date": "2026-08-25",
                "buckets": {"14": dict(bucket)},
                "by_model": {"deepseek-v4-pro": dict(bucket)},
                "schema_version": "1.0.0",
                "generated_at": "2026-08-25T14:00:00Z",
            })
            # 关键：预置 month.json —— 模拟 oneline 当天已经调过 merge_month，
            # 这 1M token 已经记在账上了（旧测试缺的就是这一步）。
            state._atomic_write(sd / "month.json", {
                "days": {"2026-08-25": dict(bucket,
                                            by_model={"deepseek-v4-pro": dict(bucket)})},
                "schema_version": "1.0.0",
                "month": "2026-08",
                "generated_at": "2026-08-25T14:00:00Z",
            })

            from datetime import datetime, timezone, timedelta
            fake_now = datetime(2026, 8, 26, 0, 30, 0, tzinfo=timezone(timedelta(hours=8)))
            result = state.rotate_today(now=fake_now)
            self.assertEqual(result, "2026-08-25", "rotate 应该返回旧日期")

            # today.json 被清空,date 更新
            today = json.loads((sd / "today.json").read_text())
            self.assertEqual(today["date"], "2026-08-26")
            self.assertEqual(today["buckets"], {})
            self.assertEqual(today.get("rotated_from"), "2026-08-25")

            # month.json 必须**完全不变**——1M 就是 1M，不是 2M
            month = json.loads((sd / "month.json").read_text())
            self.assertEqual(
                month["days"]["2026-08-25"]["uncached_input_tokens"], 1_000_000,
                "rotate 不能把 merge_month 已经记过的量再加一遍（3 倍虚增的根因）")
            self.assertEqual(
                month["days"]["2026-08-25"]["by_model"]["deepseek-v4-pro"]["uncached_input_tokens"],
                1_000_000, "by_model 同样不能被 rotate 重复累加")

    def test_oneline_style_merge_then_rotate_counts_each_token_once(self):
        """端到端不变量：**month.json 里每个 token 只能被记一次。**

        走真实调用顺序（merge_today + merge_month，然后跨日 rotate），
        而不是手写状态文件——上一条测试证明「rotate 不加」，这条证明
        真实路径下总量确实等于真实发生量。"""
        with _IsolatedHome():
            sd = state.state_dir()
            hb = {"buckets": [{
                "date": "2026-08-25", "hour": 14, "is_peak": False,
                "uncached_input_tokens": 1_000_000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            }]}
            # `_month_key` 必须与 `_today_key` 同月份：merge_month 的「当前月」
            # 走真实时钟（state.py `_month_key`），只 mock 今天不 mock 月份的话，
            # 固定日期 2026-08-25 在 9 月会被迁进 month-archive.json（「month.json
            # 只存当前自然月」是 201 倍事故后的定论）——8 月写测试时真时钟还在
            # 当月所以碰巧全绿，跨月即腐坏（2026-09-01 真实失败）。
            with mock.patch.object(state, "_today_key", return_value="2026-08-25"), \
                 mock.patch.object(state, "_month_key", return_value="2026-08"):
                state.merge_today(hb)          # cli.py oneline 的调用顺序
                state.merge_month(hb)
            state.rotate_today(now="2026-08-26")   # 第二天，触发 rotate

            month = json.loads((sd / "month.json").read_text())
            self.assertEqual(
                month["days"]["2026-08-25"]["uncached_input_tokens"], 1_000_000,
                "真实只发生 1M token，跨日之后 month.json 里也必须只有 1M")

    def test_no_rotate_when_same_date(self):
        """同一天再次 rotate → 不动数据(返回 None)。"""
        with _IsolatedHome():
            sd = state.state_dir()
            from datetime import datetime, timezone, timedelta
            fake_now = datetime(2026, 8, 25, 14, 0, 0, tzinfo=timezone(timedelta(hours=8)))
            state._atomic_write(sd / "today.json", {
                "date": "2026-08-25",
                "buckets": {"14": {"uncached_input_tokens": 100}},
                "schema_version": "1.0.0",
                "generated_at": "2026-08-25T14:00:00Z",
            })
            result = state.rotate_today(now=fake_now)
            self.assertIsNone(result, "同一天不 rotate")
            today = json.loads((sd / "today.json").read_text())
            self.assertEqual(today["buckets"]["14"]["uncached_input_tokens"],
                             100, "数据保持不动")

    def test_rotate_accepts_string_now(self):
        """rotate_today(now=<'YYYY-MM-DD' str>) 不应 AttributeError。

        之前把 `.isoformat()` 套在整个三元表达式外层——str 分支下对字符串
        调 `.isoformat()` 直接崩；此前测试只喂过 datetime,没测到这条路径。
        """
        with _IsolatedHome():
            sd = state.state_dir()
            state._atomic_write(sd / "today.json", {
                "date": "2026-08-25",
                "buckets": {"14": {"uncached_input_tokens": 100}},
                "schema_version": "1.0.0",
                "generated_at": "2026-08-25T14:00:00Z",
            })
            result = state.rotate_today(now="2026-08-26")
            self.assertEqual(result, "2026-08-25")
            today = json.loads((sd / "today.json").read_text())
            self.assertEqual(today["date"], "2026-08-26")

    def test_merge_today_triggers_rotate_first(self):
        """merge_today 入口应自动 rotate(无 --no-rotate flag)。"""
        with _IsolatedHome():
            sd = state.state_dir()
            state._atomic_write(sd / "today.json", {
                "date": "2026-08-25",
                "buckets": {}, "schema_version": "1.0.0",
                "generated_at": "2026-08-25T00:00:00Z",
            })
            from datetime import datetime, timezone, timedelta
            fake_now = datetime(2026, 8, 26, 0, 30, 0, tzinfo=timezone(timedelta(hours=8)))
            # 直接调 merge_today,但 env 的 today key 已变 — 用 fake 时间模拟
            import os
            os.environ["AGENT_VITALS_HOME"] = str(sd.parent)  # 但这不是 fake 时间
            # 用 monkey-patch _today_key 返回 8/26
            with mock.patch.object(state, "_today_key",
                                  return_value="2026-08-26"):
                state.merge_today({"buckets": [{"date": "2026-08-26",
                                                  "hour": 10, "is_peak": False,
                                                  "uncached_input_tokens": 100}]})
            today = json.loads((sd / "today.json").read_text())
            self.assertEqual(today["date"], "2026-08-26",
                             "merge_today 必须先 rotate 到新日期")
            self.assertIn("10", today["buckets"])
            self.assertEqual(today["buckets"]["10"]["uncached_input_tokens"], 100)


if __name__ == "__main__":
    unittest.main(verbosity=2)
