#!/usr/bin/env python3
"""Agent Vitals 本地数据根目录的兼容选择测试。

品牌从 Skill Vitals 改成 Agent Vitals 后，数据目录改名不能把既有用户的
预算/日历/快照弄丢。`scripts/agent_vitals/paths.py` 是 Python 侧的单一
判定来源，`state.state_dir` / `cache_dir` / `budget._config_path` /
`snapshots.snapshot_dir` 都路由到它；Rust 侧 `agent-vitals-runtime` 的
`home::data_home_from`（v0.8 Phase D7 前在 `src/skills/snapshot.rs`）镜像同一
语义，那边有同名单测。本文件钉的是：

1. **不复制、不移动**——只在进程内选一个根，新装落 `~/.agent-vitals`，
   既有 `~/.skill-vitals` 用户继续用自己的旧目录。
2. **显式覆盖 current-then-legacy**：`AGENT_VITALS_*` 赢 `SKILL_VITALS_*`。
3. **默认目录**：`~/.agent-vitals` 存在或两者都不存在 → 新的；只有
   `~/.skill-vitals` 存在 → 旧的。

HOME 用 mock 钉死，保证测试不碰真实用户目录。
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "packages" / "agent-vitals-python"))

from agent_vitals import budget, paths, snapshots, state


class TestDataHomeCompatibility(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="agent-vitals-paths-")
        self.home = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, **values):
        base = {"HOME": str(self.home), "USERPROFILE": str(self.home)}
        base.update(values)
        return mock.patch.dict(os.environ, base, clear=True)

    def test_current_explicit_variables_win_everywhere(self):
        current = self.home / "custom-current"
        legacy = self.home / "custom-legacy"
        with self.env(AGENT_VITALS_HOME=str(current), SKILL_VITALS_HOME=str(legacy),
                      AGENT_VITALS_SNAPSHOT_DIR=str(current / "snaps"),
                      SKILL_VITALS_SNAPSHOT_DIR=str(legacy / "snaps")):
            self.assertEqual(paths.data_home(), current)
            self.assertEqual(state.state_dir(), current / "state")
            self.assertEqual(state.cache_dir(), current / "cache")
            self.assertEqual(Path(budget._config_path()), current / "config.toml")
            self.assertEqual(snapshots.snapshot_dir(), current / "snaps")

    def test_legacy_explicit_variables_remain_supported(self):
        legacy = self.home / "custom-legacy"
        with self.env(SKILL_VITALS_HOME=str(legacy),
                      SKILL_VITALS_SNAPSHOT_DIR=str(legacy / "snaps")):
            self.assertEqual(paths.data_home(), legacy)
            self.assertEqual(state.state_dir(), legacy / "state")
            self.assertEqual(state.cache_dir(), legacy / "cache")
            self.assertEqual(Path(budget._config_path()), legacy / "config.toml")
            self.assertEqual(snapshots.snapshot_dir(), legacy / "snaps")

    def test_fresh_default_uses_agent_vitals(self):
        with self.env():
            self.assertEqual(paths.data_home(), self.home / ".agent-vitals")
            self.assertEqual(state.state_dir(), self.home / ".agent-vitals" / "state")
            self.assertEqual(snapshots.snapshot_dir(), self.home / ".agent-vitals" / "snapshots")

    def test_only_existing_legacy_directory_is_preserved(self):
        legacy = self.home / ".skill-vitals"
        legacy.mkdir()
        with self.env():
            self.assertEqual(paths.data_home(), legacy)
            self.assertEqual(state.state_dir(), legacy / "state")
            self.assertEqual(Path(budget._config_path()), legacy / "config.toml")
            self.assertEqual(snapshots.snapshot_dir(), legacy / "snapshots")

    def test_current_directory_wins_when_both_defaults_exist(self):
        (self.home / ".agent-vitals").mkdir()
        (self.home / ".skill-vitals").mkdir()
        with self.env():
            self.assertEqual(paths.data_home(), self.home / ".agent-vitals")

    def test_empty_override_is_ignored_like_absent(self):
        # 空字符串覆盖 = 未设置：`paths._env_path` 对空值返回 None（与 Rust
        # `configured_path` 的 filter(!is_empty) 一致）。
        (self.home / ".skill-vitals").mkdir()
        with self.env(AGENT_VITALS_HOME="", SKILL_VITALS_HOME=""):
            self.assertEqual(paths.data_home(), self.home / ".skill-vitals")


if __name__ == "__main__":
    unittest.main()
