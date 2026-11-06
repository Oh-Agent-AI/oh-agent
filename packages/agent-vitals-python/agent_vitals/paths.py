"""Resolve Agent Vitals' local data home without splitting existing users' data.

The product name changed from Skill Vitals to Agent Vitals.  A directory rename
must not silently make a user's budgets, calendars, or snapshots disappear, so
the resolver deliberately does not copy or move files.  It selects exactly one
root for a process:

1. ``AGENT_VITALS_HOME`` — the current explicit override.
2. ``SKILL_VITALS_HOME`` — the legacy explicit override.
3. ``~/.agent-vitals`` when it already exists, or when neither default exists.
4. ``~/.skill-vitals`` when it is the only existing default directory.

This makes fresh installs write the new name while existing installations keep
using their complete legacy state until an explicit migration is introduced.
The same current-then-legacy precedence applies to the snapshot override.

本模块是 `state.state_dir` / `cache_dir`、`budget._config_path`、`snapshots.
snapshot_dir` 与 Rust 侧 `src/snapshot.rs::data_home_from` 的唯一判定来源；
两端对同一套 env 名的语义必须逐字一致（见 tests/test_paths.py 与
snapshot.rs 的 `data_home_from` 单测）。
"""

import os
from pathlib import Path


def _env_path(name: str):
    value = os.environ.get(name)
    return Path(value).expanduser() if value else None


def user_home() -> Path:
    """Resolve home consistently across POSIX and Windows."""
    configured = os.environ.get("HOME") or os.environ.get("USERPROFILE")
    return Path(configured).expanduser() if configured else Path.home()


def data_home() -> Path:
    """Return the single local data root selected for this process.

    This function intentionally does not create the directory: callers that
    write state or snapshots retain responsibility for surfacing I/O failures.
    """
    explicit = _env_path("AGENT_VITALS_HOME")
    if explicit is not None:
        return explicit
    legacy_explicit = _env_path("SKILL_VITALS_HOME")
    if legacy_explicit is not None:
        return legacy_explicit

    home = user_home()
    current = home / ".agent-vitals"
    legacy = home / ".skill-vitals"
    if current.exists() or not legacy.exists():
        return current
    return legacy


def snapshot_dir() -> Path:
    """Return the snapshot directory, honoring current then legacy overrides."""
    explicit = _env_path("AGENT_VITALS_SNAPSHOT_DIR")
    if explicit is not None:
        return explicit
    legacy_explicit = _env_path("SKILL_VITALS_SNAPSHOT_DIR")
    if legacy_explicit is not None:
        return legacy_explicit
    return data_home() / "snapshots"
