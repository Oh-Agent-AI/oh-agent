"""Cross-platform subprocess environment helpers for isolated-home tests."""

import datetime
import json
import os
import subprocess
from pathlib import Path


def isolated_home_env(home):
    """Return an environment where POSIX and Windows agree on the home path."""
    root = str(Path(home).resolve())
    env = dict(os.environ)
    env["HOME"] = root
    env["USERPROFILE"] = root
    drive, tail = os.path.splitdrive(root)
    if drive:
        env["HOMEDRIVE"] = drive
        env["HOMEPATH"] = tail or os.sep
    # 子进程的 HOME 被改到夹具路径后，Python 的 user site 会跟着漂到
    # `<夹具>/Library/Python/…`，丢掉对装在真实 user site 的包的可见性——最典型
    # 的是 zstandard（DSH 多帧 zstd 解码，R2a `SessionStore::dsh` 的 Python 侧
    # population 需要它）。隔离的目标是 **HOME 目录**（~/.codex、~/.dsh…），
    # 不是 Python 包；用 PYTHONUSERBASE 钉住真实 user base，子进程与套件进程
    # 看到同一批包。差分测试（tests/test_r2a.py）在夹具 HOME 下跑两侧，少了这
    # 一档 Python 会诚实报 `unsupported-compression`、Rust 却正常解码 → 逐字节
    # 对账红掉。
    if "PYTHONUSERBASE" not in env:
        try:
            import site
            env["PYTHONUSERBASE"] = site.getuserbase()
        except Exception:
            pass
    for adapter in ("CODEX_RUNTIME", "OPENCLAW_RUNTIME", "WORKBUDDY_BUILTINS"):
        env["AGENT_VITALS_DISABLE_" + adapter] = "1"
    env["AGENT_VITALS_DISABLE_OPENCLAW_BUNDLED"] = "1"
    return env


def beijing_day_to_utc_iso(day):
    """北京日历日 `YYYY-MM-DD` 的零点 → UTC ISO 时间戳（事件落进该北京日）。"""
    wall = datetime.datetime.strptime(day, "%Y-%m-%d")
    return (wall - datetime.timedelta(hours=8)).strftime("%Y-%m-%dT%H:%M:%SZ")


def seed_authority_facts(binary, home, day, uncached_input=1_000_000, output=100_000):
    """把三执行环境各一条实时事实经公开迁移入口种进隔离 SQL 权威库。

    v0.9.1 Phase 3.5 Tier A 起 `data coverage` / `data daily` 经
    `SummaryRepository` 读 `SqlSummaryRepository`（权威库），不再读 state 投影
    文件——所以测试种子从「手写 month.json / claude-ledger.json / rollout」
    换成「facts JSONL + `data-migrate`」（spec 6.2.1 的公开迁移入口，
    same-fact_id 幂等）。行形状与
    `crates/agent-vitals-data/tests/legacy_import_wiring.rs` 的 `live_fact`
    一致（fact_id 由契约层派生，不信任外部 id）。模型名都在价目表内：
    deepseek-v4-flash 出 DSH 实测账单档与 claude CNY 估算档，gpt-5.6-sol 出
    codex 缺少官方订阅 scope 证据时保持 metered_estimate + unresolved；
    三执行环境 basis 各就各位的断言按当前 billing fallback 规则执行。
    """
    facts_dir = Path(home) / "data" / "facts"
    facts_dir.mkdir(parents=True, exist_ok=True)
    ts = beijing_day_to_utc_iso(day)
    for harness, session, model in (
        ("claude-code", "sess-seed-claude", "deepseek-v4-flash"),
        ("codex", "sess-seed-codex", "gpt-5.6-sol"),
        ("dsh", "sess-seed-dsh", "deepseek-v4-flash"),
    ):
        fact = {
            "harness": harness,
            "machine_namespace": "default",
            "source_profile": "default",
            "native_session_id": session,
            "source_event_id": session + "-e1",
            "observation_kind": "token_count",
            "event_ts_utc": ts,
            "model_id": model,
            "uncached_input_tokens": uncached_input,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "output_tokens": output,
        }
        (facts_dir / (harness + ".jsonl")).write_text(json.dumps(fact) + "\n")
    env = isolated_home_env(home)
    env["AGENT_VITALS_HOME"] = str(Path(home) / "data")
    proc = subprocess.run(
        [str(binary), "data-migrate"], env=env, capture_output=True, text=True
    )
    if proc.returncode != 0:
        raise AssertionError("data-migrate failed: " + proc.stderr)
