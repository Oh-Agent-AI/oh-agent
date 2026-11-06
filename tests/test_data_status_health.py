"""v0.9.1 Phase 4.4「人工故障验收」的可自动化部分 + Phase 1.7「损坏恢复
文档化」的消费面。

`data-status` 是 spec §9「data doctor」的权威库部分。这里钉的是**它在坏
状态下不许静默端出 facts=0**：

  · 库损坏（`PRAGMA integrity_check` != ok）→ health=critical、退出 1；
  · `sql_authority_enabled` 下库被删/从没同步（旧 JSON 写入已冻结，零绝不
    是「没花钱」）→ health=critical、退出 1、hints 指向 `sync-facts` /
    `data authority disable`；
  · 正常库 → health=ok、退出 0。

`AuthorityDb::open` 对缺文件会建库——所以「删库」这条必须在 open 之前判
文件存在，本测试正是钉住那条路径不回退成「新空库 = 一切正常」。
"""

import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from tests.env_helpers import isolated_home_env, seed_authority_facts

ROOT = Path(__file__).resolve().parent.parent
_BIN = os.environ.get("AGENT_VITALS_BIN")
if _BIN:
    _BIN = str(Path(_BIN).resolve())


def _beijing_today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() + 8 * 3600))


@unittest.skipUnless(_BIN, "未设 AGENT_VITALS_BIN，跳过 Rust 二进制用例")
class DataStatusHealthTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name)
        self.data_home = self.home / "data"
        self.db_path = self.data_home / "agent-vitals.sqlite3"

    def _env(self):
        env = isolated_home_env(self.home)
        env["AGENT_VITALS_HOME"] = str(self.data_home)
        return env

    def run_cli(self, *argv):
        return subprocess.run(
            [_BIN, *argv], env=self._env(), cwd=str(ROOT),
            capture_output=True, text=True,
        )

    def status_json(self):
        proc = self.run_cli("data-status", "--json")
        return proc, json.loads(proc.stdout)

    def test_seeded_db_with_unresolved_route_evidence_reports_warn(self):
        seed_authority_facts(_BIN, self.home, _beijing_today())
        proc, v = self.status_json()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(v["health"], "warn")
        self.assertEqual(v["integrity"], "ok")
        self.assertGreater(v["facts"], 0)
        self.assertTrue(v["hints"])

    def test_deleted_db_while_authority_enabled_is_critical_not_silent_zero(self):
        seed_authority_facts(_BIN, self.home, _beijing_today())
        enabled = self.run_cli("data", "authority", "enable", "--force")
        self.assertEqual(enabled.returncode, 0, enabled.stderr)
        self.assertTrue(self.db_path.exists())
        self.db_path.unlink()
        for suffix in ("-wal", "-shm"):
            p = Path(str(self.db_path) + suffix)
            if p.exists():
                p.unlink()

        proc, v = self.status_json()
        # 明确告警：非零退出 + critical + 可执行的恢复入口。
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertEqual(v["health"], "critical")
        self.assertTrue(v["hints"], "critical 必须带恢复提示")
        joined = " ".join(v["hints"]).lower()
        self.assertIn("sync-facts", joined)
        self.assertIn("disable", joined)
        # 绝不把「刚建的空库」端成正常。
        self.assertEqual(v["facts"], 0)

    def test_unopenable_db_fails_loudly_not_silently(self):
        seed_authority_facts(_BIN, self.home, _beijing_today())
        # 覆写成非 SQLite 内容 → open 直接失败。
        self.db_path.write_bytes(b"not a sqlite database at all" * 8)

        proc = self.run_cli("data-status", "--json")
        # 明确告警：非零退出 + stderr 说明，绝不 exit 0 端空 JSON。
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("data-status failed", proc.stderr)

    def test_truncated_db_integrity_check_is_critical(self):
        seed_authority_facts(_BIN, self.home, _beijing_today())
        # 截断到只剩 header：SQLite 仍能 open，但 integrity_check 必失败。
        raw = self.db_path.read_bytes()
        self.db_path.write_bytes(raw[:512])
        for suffix in ("-wal", "-shm"):
            p = Path(str(self.db_path) + suffix)
            if p.exists():
                p.unlink()

        proc = self.run_cli("data-status", "--json")
        if proc.returncode == 2:
            # open 本身就失败（也是可接受的「明确告警」）——stderr 说明。
            self.assertIn("data-status failed", proc.stderr)
            return
        v = json.loads(proc.stdout)
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertEqual(v["health"], "critical")
        self.assertNotEqual(v["integrity"], "ok")

    def test_authority_enabled_then_state_json_deleted_still_served_from_sql(self):
        """删旧 JSON 继续查询（Phase 4.4）：权威启用后事实在 SQL，
        删掉 state 投影文件不影响 `data coverage`——因为读路径本就不碰它们。"""
        today = _beijing_today()
        seed_authority_facts(_BIN, self.home, today)
        self.run_cli("data", "authority", "enable", "--force")
        state_dir = self.data_home / "state"
        for name in ("month.json", "today.json", "month-archive.json",
                     "claude-ledger.json", "claude-ledger-archive.json"):
            p = state_dir / name
            if p.exists():
                p.unlink()

        proc = self.run_cli("data", "coverage", "--month", today[:7], "--json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        d = json.loads(proc.stdout)
        self.assertGreater(d["by_harness"]["dsh"]["amounts_by_basis"]["metered_actual"], 0.0)


if __name__ == "__main__":
    unittest.main()
