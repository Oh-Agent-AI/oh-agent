#!/usr/bin/env python3
"""R1d 接管协议（§4.2/§4.3 最小可测子集）的差分 + 字符化锁步测试。

纯规则单一真相源在 `crates/agent-vitals-domain/src/domain/takeover.rs`；Python
`agent/takeover.py` 是 mirror，`agent-vitals-runtime/src/takeover.rs`（Phase D6 前 `src/agent/`）是 I/O + fold 驱动。
本文件三层钉死三者不漂移：

1. `TakeoverCharacterization`（恒跑）—— 把 mirror 的纯函数输出钉到具体数值，
   与 core/takeover.rs 的单测期望值逐一对应（test_cost_priced_day 同款交叉
   锁定）：Python 与 Rust 各自断言同一组数字，docstring 互相指认。
2. `TakeoverShadowDiff`（需 AGENT_VITALS_BIN）—— 同一份 fold-req，Python
   `fold_session_req(shadow=True)` 进程内折进 py-home、Rust `state
   fold-session --shadow` 子进程折进 rs-home，打码 `folded_at`/`last_fold_at`/
   `generated_at`/`archived_at` 后**逐文件字节相等** + 文件集合相等。这就是
   §4.2 shadow replay 的物证：Rust 写者与（接管前的）Python 写者产出同构 ——
   两边一旦漂移这里就红。v0.9.1 Stage 5b 后 fold 是闭合的导航快照协议，只落
   `oneline.json` / `sessions.jsonl`；today/month/alert 的账由 SQL 权威库管理。
3. `TakeoverFencingExactlyOnce`（需 AGENT_VITALS_BIN）—— 四件套走真实 Rust
   驱动：fencing（接管前拒绝、Python CLI 退休门）、cutover（`state takeover
   rust` 后放行）、exactly-once（同 session 多 tick 只折一次，去重物证落在
   sessions.jsonl + ledger）、rollback（切回 python 再切回 rust，ledger 原
   epoch 证明没重放）。

跑法（差分部分需要 AGENT_VITALS_BIN，与 test_cli_matrix 同款注入）：
    AGENT_VITALS_BIN=target/release/agent-vitals python3 -m unittest tests.test_takeover_lockstep -v
"""

import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "scan.py"
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from tests.env_helpers import isolated_home_env  # noqa: E402
from agent_vitals.agent import takeover  # noqa: E402
from agent_vitals.agent import state as state_mod  # noqa: E402

# `AGENT_VITALS_BIN=target/release/agent-vitals`（相对路径）在测试的临时 cwd 里
# 不可用 —— 与 test_cli_matrix 同款：解析成绝对路径再进子进程。
_BIN = os.environ.get("AGENT_VITALS_BIN")
if _BIN:
    _BIN = str(Path(_BIN).resolve())
_BJ = timezone(timedelta(hours=8))


def bj_now():
    return datetime.now(_BJ)


def today_str():
    return bj_now().strftime("%Y-%m-%d")


def _mask_ts(text):
    """打码 fold 驱动自己盖的时间戳：Python 与 Rust 各自写各自的 now，必然不同。
    `date`/`month`/`hour`/`epoch` 是确定性输入/输出，不打码。"""
    return re.sub(r'"(generated_at|archived_at|folded_at|last_fold_at)": "[^"]*"',
                  r'"\1": "<TS>"', text)


def _fold_req(session_id, tokens):
    """一份 fold-req：与 `agent-vitals-runtime/src/takeover.rs` 测试里 `req()` 同形状同键序
    （sessions.jsonl 保序追加，键序不同字节就不同）。

    v0.9.1 Stage 5b 后是一个闭合的导航快照协议——只带 `oneline`。旧的
    `hour_buckets` / `by_model_today` / `by_date_model` / `alert` 字段即使附上
    也一律被忽略（业务账由 SQL 权威库管理），这里索性不再构造。日期只用于
    导航摘要展示。"""
    today = today_str()
    model = "deepseek-v4-flash"
    oneline = {
        "session_id": session_id,
        "session_log": "/logs/%s.jsonl" % session_id,
        "duration_ms": 100,
        "model": model,
        "tokens_total": tokens,
        "tokens_peak": tokens,
        "cost_cny": 0.1,
        "cost_peak_cny": 0.0,
        "unpriced_tokens": 0,
        "findings_total": 0,
        "findings_max_severity": "none",
        "hour_buckets_summary": {
            "bucket_count": 1, "min_date": today, "max_date": today,
            "tz_name": "Asia/Shanghai",
        },
    }
    return {
        "session_id": session_id,
        "session_log": "/logs/%s.jsonl" % session_id,
        "harness_kind": "dsh",
        "machine_namespace": "ns-abc",
        "oneline": oneline,
    }


def _write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2,
                               sort_keys=True, default=str),
                    encoding="utf-8")


def _state_files(state_dir: Path):
    """state 目录内已写出的文件集合。

    排掉三样非状态残留：隐藏文件、`.tmp`（原子写未 rename 的残留）、`.lock`
    （Python `fcntl.flock` 在 `<file>.lock` 上留下的空壳 —— fd 关了文件还在，
    Rust 不产生这种文件，比文件集合时不该算进去）。
    """
    if not state_dir.exists():
        return set()
    return {p.name for p in state_dir.iterdir()
            if not p.name.startswith(".")
            and not p.name.endswith(".tmp")
            and not p.name.endswith(".lock")}


# ── 1. 纯规则字符化（恒跑，与 core/takeover.rs 单测交叉锁定）─────────────


class TakeoverCharacterization(unittest.TestCase):
    """Python mirror 纯函数的**具体数值** —— 与 core/takeover.rs 的单测期望值
    对守。同一份夹具、同一组数字，Python 这里断言、Rust `#[cfg(test)]` 断言，
    docstring 互相指认。改数字 = 两边一起改，任何一边单独漂移都会让另一侧
    失去参照。"""

    def test_session_key_is_self_delimiting(self):
        """↔ core `session_key_is_self_delimiting`。"""
        self.assertEqual(takeover.session_key("dsh", "s1", "ns-abc"),
                         "3:dsh|2:s1|6:ns-abc")
        self.assertNotEqual(takeover.session_key("ab", "c", "d"),
                            takeover.session_key("a", "bc", "d"))
        self.assertEqual(takeover.session_key("", "", ""), "0:|0:|0:")
        self.assertNotEqual(takeover.session_key("a|b", "c", "d"),
                            takeover.session_key("a", "b|c", "d"))

    def test_default_manifest_is_python_owned(self):
        """↔ core `default_manifest_is_python_owned`。"""
        m = takeover.default_manifest()
        self.assertEqual(takeover.manifest_owner(m), "python")
        self.assertEqual(takeover.manifest_epoch(m), 0)
        self.assertTrue(takeover.owner_allows(m, "python"))
        self.assertFalse(takeover.owner_allows(m, "rust"))

    def test_owner_allows_is_owner_equality(self):
        """↔ core `owner_allows_is_owner_equality`。"""
        m = takeover.default_manifest()
        self.assertFalse(takeover.owner_allows(m, "rust"))
        c = takeover.cutover(m, "rust", "2026-08-30T12:00:00+00:00")
        self.assertTrue(takeover.owner_allows(c, "rust"))
        self.assertFalse(takeover.owner_allows(c, "python"))

    def test_cutover_bumps_epoch_and_records_since(self):
        """↔ core `cutover_bumps_epoch_and_records_since`。"""
        m = takeover.default_manifest()
        c = takeover.cutover(m, "rust", "2026-08-30T12:00:00+00:00")
        self.assertEqual(takeover.manifest_epoch(c), 1)
        self.assertEqual(c["since"], "2026-08-30T12:00:00+00:00")
        self.assertEqual(c["owner"], "rust")
        back = takeover.cutover(c, "python", "2026-08-30T13:00:00+00:00")
        self.assertEqual(takeover.manifest_epoch(back), 2)
        self.assertEqual(back["owner"], "python")
        self.assertIsNone(back["last_fold_at"])

    def test_mark_fold_bumps_epoch_and_stamps_time_keeping_owner(self):
        """↔ core `mark_fold_bumps_epoch_and_stamps_time_keeping_owner`。"""
        m = takeover.cutover(takeover.default_manifest(), "rust",
                             "2026-08-30T12:00:00+00:00")
        f = takeover.mark_fold(m, "2026-08-30T12:05:00+00:00")
        self.assertEqual(takeover.manifest_epoch(f), 2)  # cutover(1) 之后再折 → 2
        self.assertEqual(f["last_fold_at"], "2026-08-30T12:05:00+00:00")
        self.assertEqual(f["owner"], "rust")
        self.assertEqual(f["since"], "2026-08-30T12:00:00+00:00")
        self.assertTrue(takeover.owner_allows(f, "rust"))

    def test_ledger_roundtrip_is_pure(self):
        """↔ core `record_then_folded_roundtrip`。"""
        l = takeover.empty_ledger()
        key = takeover.session_key("dsh", "s1", "ns-abc")
        e = takeover.ledger_entry("dsh", "s1", "ns-abc",
                                  "2026-08-30T12:05:00+00:00", 2)
        l2 = takeover.ledger_record(l, key, e)
        self.assertTrue(takeover.ledger_folded(l2, key))
        self.assertFalse(takeover.ledger_folded(l, key))  # 纯函数：不改入参
        entry = l2["entries"][key]
        self.assertEqual(entry["epoch"], 2)
        self.assertEqual(entry["folded_at"], "2026-08-30T12:05:00+00:00")
        self.assertEqual(entry["native_id"], "s1")

    def test_ledger_survives_rollback_epoch_unchanged(self):
        """↔ core `ledger_survives_rollback_epoch_unchanged`。

        回滚的物证：Rust 在代际 2 fold 了 s1，切回 python 再切回 rust，ledger
        里 s1 的 epoch 仍是 2 —— 这条记录没有被重放改写。
        """
        key = takeover.session_key("dsh", "s1", "ns-abc")
        e = takeover.ledger_entry("dsh", "s1", "ns-abc",
                                  "2026-08-30T12:05:00+00:00", 2)
        l = takeover.ledger_record(takeover.empty_ledger(), key, e)
        self.assertEqual(l["entries"][key]["epoch"], 2)
        l2 = takeover.ledger_record(l, key, e)
        self.assertEqual(l2["entries"][key]["epoch"], 2)
        self.assertEqual(len(l2["entries"]), 1)


# ── 2. shadow replay 差分（同一 fold-req → 双实现 → 逐字节一致）───────────


@unittest.skipUnless(_BIN, "未设 AGENT_VITALS_BIN，跳过双实现差分")
class TakeoverShadowDiff(unittest.TestCase):
    """同一 fold-req → Python mirror in-process vs Rust 驱动子进程 → 写出的
    state 文件逐字节一致（打码四类时间戳）。§4.2 shadow replay 的机器版。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        (self.tmp / "workdir").mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _py_fold_shadow(self, req):
        """进程内 Python mirror 影子折进 py-home。返回 (outcome, detail)。"""
        home = self.tmp / "py-home"
        home.mkdir(parents=True, exist_ok=True)
        prev = os.environ.get("AGENT_VITALS_HOME")
        os.environ["AGENT_VITALS_HOME"] = str(home)
        try:
            return takeover.fold_session_req(req, shadow=True)
        finally:
            if prev is None:
                os.environ.pop("AGENT_VITALS_HOME", None)
            else:
                os.environ["AGENT_VITALS_HOME"] = prev

    def _rs_fold_shadow(self, req_path):
        """Rust 驱动影子折进 rs-home。返回退出码，并断言 fold 成功。"""
        home = self.tmp / "rs-home"
        env = isolated_home_env(self.tmp)
        env["AGENT_VITALS_HOME"] = str(home)
        r = subprocess.run([_BIN, "state", "fold-session", str(req_path),
                            "--shadow"],
                           cwd=str(self.tmp / "workdir"),
                           env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, "Rust fold-session 失败:\n%s" % r.stderr)
        return r

    def test_shadow_fold_matches_python_mirror(self):
        """同一份 req 折进 py-home / rs-home → 导航快照文件集合 + 打码后字节全等。"""
        req = _fold_req("s1", 10)

        outcome, detail = self._py_fold_shadow(req)
        self.assertEqual(outcome, "folded", detail)

        req_path = self.tmp / "req.json"
        # 不 sort_keys —— 保插入序，sessions.jsonl 的键序必须两边一致
        req_path.write_text(json.dumps(req, ensure_ascii=False), encoding="utf-8")
        self._rs_fold_shadow(req_path)

        py_state = self.tmp / "py-home" / "state"
        rs_state = self.tmp / "rs-home" / "state"
        # 文件集合相等（谁多写/漏写都红），再逐文件打码比字节
        self.assertEqual(_state_files(py_state), _state_files(rs_state))
        for name in sorted(_state_files(py_state)):
            a = (py_state / name).read_text(encoding="utf-8")
            b = (rs_state / name).read_text(encoding="utf-8")
            self.assertEqual(
                _mask_ts(a), _mask_ts(b),
                "%s 字节不一致（打码 folded_at/last_fold_at/generated_at/"
                "archived_at 后）" % name)

    def test_machine_namespace_in_req_not_materialized_to_disk(self):
        """req 自带 machine_namespace → 两边都不该在数据根写 machine.json。"""
        req = _fold_req("s1", 10)
        self._py_fold_shadow(req)
        req_path = self.tmp / "req.json"
        req_path.write_text(json.dumps(req, ensure_ascii=False), encoding="utf-8")
        self._rs_fold_shadow(req_path)
        for side in ("py-home", "rs-home"):
            self.assertFalse(
                (self.tmp / side / "machine.json").exists(),
                "%s 不应写出 machine.json：ns 由 req 显式提供" % side,
            )


# ── 3. fencing / cutover / exactly-once / rollback（真实 Rust 驱动）────────


@unittest.skipUnless(_BIN, "未设 AGENT_VITALS_BIN，跳过 Rust 驱动用例")
class TakeoverFencingExactlyOnce(unittest.TestCase):
    """§4.2 四件套 + §4.3 验收 fixture，全走 `state` 子命令真实驱动。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        (self.tmp / "workdir").mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ── 子进程 helper ────────────────────────────────────────────
    def _run(self, *argv, home_rel="rs-home"):
        home = self.tmp / home_rel
        env = isolated_home_env(self.tmp)
        env["AGENT_VITALS_HOME"] = str(home)
        return subprocess.run([_BIN, *argv], cwd=str(self.tmp / "workdir"),
                              env=env, capture_output=True, text=True)

    def _state_dir(self, home_rel="rs-home"):
        return self.tmp / home_rel / "state"

    def _fold(self, session_id, tokens, shadow=False):
        req = self.tmp / ("req-%s.json" % session_id)
        req.write_text(json.dumps(_fold_req(session_id, tokens),
                                  ensure_ascii=False), encoding="utf-8")
        args = ["state", "fold-session", str(req)]
        if shadow:
            args.append("--shadow")
        r = self._run(*args)
        self.assertEqual(r.returncode, 0, "fold %s 失败:\n%s" % (session_id, r.stderr))
        return json.loads(r.stdout)

    def _read_json(self, rel, home_rel="rs-home"):
        p = self._state_dir(home_rel) / rel
        return json.loads(p.read_text(encoding="utf-8"))

    # ── 用例 ────────────────────────────────────────────────────
    def test_fencing_refuses_before_cutover(self):
        """无 manifest（默认 owner=python）→ Rust 驱动拒绝，exit 2，什么都不落盘。"""
        req = self.tmp / "req.json"
        req.write_text(json.dumps(_fold_req("s1", 10), ensure_ascii=False),
                       encoding="utf-8")
        r = self._run("state", "fold-session", str(req))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("writer fencing", r.stderr)
        self.assertFalse(self._state_dir().exists(),
                         "被拒的 fold 不得创建 state 目录")

    def test_python_mirror_refuses_when_not_rust_owned(self):
        """默认 owner=python → Python mirror 的 fold 拒绝（§4.2 双写防护的
        mirror 面：与 Rust 驱动 `rust_fold_refused_before_cutover` 对称 —— 双方
        都拒非当前 owner）。

        `fold_session_req` 是 **mirror-of-Rust 驱动**（差分 A/B 用）：它要求
        owner 允许 rust，所以在 owner=python 时拒。Python CLI 自己的退休门
        （`owner_allows_python`，owner=rust 时拒）是另一面，见下条用例。
        """
        prev = os.environ.get("AGENT_VITALS_HOME")
        os.environ["AGENT_VITALS_HOME"] = str(self.tmp / "py-refuse-home")
        try:
            outcome, detail = takeover.fold_session_req(_fold_req("s1", 10))
            self.assertEqual(outcome, "refused", detail)
            self.assertIn("not rust", detail)
        finally:
            if prev is None:
                os.environ.pop("AGENT_VITALS_HOME", None)
            else:
                os.environ["AGENT_VITALS_HOME"] = prev
        # 拒绝即不落盘
        self.assertFalse((self.tmp / "py-refuse-home" / "state" / "today.json").exists())

    def test_python_cli_oneline_is_retired_under_rust_owner(self):
        """旧 Python oneline 在 owner=rust 下被 writer fencing 挡掉（§4.2
        退休轨）：exit 2 + 明说 retired mirror，审计都没开始，状态一字不写。"""
        self._run("state", "takeover", "rust")
        env = isolated_home_env(self.tmp)
        env["AGENT_VITALS_HOME"] = str(self._state_dir().parent)
        r = subprocess.run(
            [sys.executable, str(SCRIPT), "oneline", "/nonexistent/log.jsonl"],
            cwd=str(self.tmp / "workdir"), env=env,
            capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("writer fencing", r.stderr)
        self.assertIn("retired mirror", r.stderr)
        # state 目录本身是 `takeover rust` 建出来的（里有 manifest）；被挡的
        # oneline 一个审计输出都不许写 —— 文件集合只能有 writer-manifest.json。
        self.assertEqual(_state_files(self._state_dir()),
                         {"writer-manifest.json"},
                         "被挡的 oneline 不得写任何审计输出")

    def _history_lines(self, home_rel="rs-home"):
        p = self._state_dir(home_rel) / "sessions.jsonl"
        return p.read_text(encoding="utf-8").strip().splitlines()

    def test_cutover_then_fold_and_exactly_once(self):
        """`takeover rust` 后 fold 成功；同 session 再 tick 两次 → 全 skipped，
        导航快照只折一次（§4.2 验收：不重复累加）。Stage 5b 后 tick 不写
        today.json / month.json，去重物证落在 sessions.jsonl + ledger。"""
        self._run("state", "takeover", "rust")
        self.assertEqual(self._fold("s1", 10)["outcome"], "folded")
        self.assertEqual(self._fold("s1", 10)["outcome"], "skipped")
        self.assertEqual(self._fold("s1", 10)["outcome"], "skipped")
        # 导航历史只追加一行（不是三行）
        self.assertEqual(len(self._history_lines()), 1)
        ledger = self._read_json("session-ledger.json")
        self.assertEqual(len(ledger["entries"]), 1)
        # 旧业务账不得被 tick 复活
        for f in ("today.json", "month.json", "month-archive.json", "alert.json"):
            self.assertFalse((self._state_dir() / f).exists(),
                             "tick 不应写 %s（已由 SQL 权威库取代）" % f)

    def test_distinct_sessions_fold_separately(self):
        """两个不同 session 各自折，导航历史两行、ledger 两条。"""
        self._run("state", "takeover", "rust")
        self.assertEqual(self._fold("s1", 10)["outcome"], "folded")
        self.assertEqual(self._fold("s2", 5)["outcome"], "folded")
        self.assertEqual(len(self._history_lines()), 2)
        ledger = self._read_json("session-ledger.json")
        self.assertEqual(len(ledger["entries"]), 2)

    def test_rollback_then_rereplay_does_not_double_count(self):
        """cutover → fold s1（代际 2）→ 接管失败切回 python → 再切回 rust →
        fold s1 被 ledger 挡掉（skipped），导航快照一字未动，s1 的 epoch
        仍是 2 —— 可测 rollback（§4.2）的机器证据。"""
        self._run("state", "takeover", "rust")
        self.assertEqual(self._fold("s1", 10)["outcome"], "folded")
        oneline_before = self._read_json("oneline.json")
        history_before = self._history_lines()
        ledger_before = self._read_json("session-ledger.json")
        key = takeover.session_key("dsh", "s1", "ns-abc")
        s1_epoch = ledger_before["entries"][key]["epoch"]

        self._run("state", "takeover", "python")
        self.assertEqual(self._read_json("writer-manifest.json")["owner"],
                         "python")
        self._run("state", "takeover", "rust")
        self.assertEqual(self._fold("s1", 10)["outcome"], "skipped")
        self.assertEqual(self._read_json("oneline.json"), oneline_before)
        self.assertEqual(self._history_lines(), history_before)
        ledger_after = self._read_json("session-ledger.json")
        self.assertEqual(ledger_after["entries"][key]["epoch"], s1_epoch)
        self.assertEqual(len(ledger_after["entries"]), 1)

    def test_machine_namespace_is_persistent_and_32_hex(self):
        """`state machine-namespace` 幂等：同 home 两次一致、32 hex、落 machine.json。"""
        a = self._run("state", "machine-namespace").stdout.strip()
        b = self._run("state", "machine-namespace").stdout.strip()
        self.assertEqual(a, b, "machine namespace 必须持久（重装才换，§4.3）")
        self.assertEqual(len(a), 32)
        m = (self.tmp / "rs-home" / "machine.json")
        self.assertEqual(json.loads(m.read_text(encoding="utf-8"))["machine_namespace"], a)


if __name__ == "__main__":
    unittest.main()
