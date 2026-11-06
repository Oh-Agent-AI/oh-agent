#!/usr/bin/env python3
"""端到端 smoke 测试：跑一遍 M1–M6 的全流程，用 fixture 里的真实 DSH 日志。

不依赖 unittest —— 直接 `python3 tests/e2e_smoke.py` 跑。失败会 print
具体的失败点（哪个文件不存在、哪个数字不对），便于手工排查。

用法：
    python3 tests/e2e_smoke.py                       # 全跑（Python + Rust）
    python3 tests/e2e_smoke.py --skip-rust           # 只测 Python
    AGENT_VITALS_HOME=/tmp/sv-e2e python3 tests/e2e_smoke.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "scan.py"
FIXTURE = ROOT / "fixtures" / "dsh" / "behavior.jsonl"
RUST_BIN = ROOT / "target" / "release" / "agent-vitals"


def _home():
    """每个 run 使用隔离的 HOME 和 $AGENT_VITALS_HOME。"""
    tmp = tempfile.mkdtemp(prefix="sv-e2e-")
    # `calendar`/`oneline` 会通过 harness adapter 读取默认执行环境目录。
    # 仅隔离 AGENT_VITALS_HOME 不够：真实 HOME 下的大型 Codex 日志仍会被
    # 扫描，导致 smoke 在开发机上超时并制造与 fixture 无关的内存压力。
    isolated_home = Path(tmp) / "home"
    isolated_home.mkdir()
    os.environ["HOME"] = str(isolated_home)
    os.environ["AGENT_VITALS_HOME"] = tmp
    return Path(tmp)


def _run(args, env=None):
    """跑 scan.py 子命令。"""
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, str(SCRIPT)] + list(args),
        capture_output=True, text=True, env=full_env, timeout=60,
    )


def _step(name):
    """打印步骤 + 失败时抛。"""
    print(f"\n=== {name} ===")


def _assert(cond, msg):
    if not cond:
        print(f"  FAIL: {msg}")
        sys.exit(1)
    print(f"  OK:   {msg}")


def m1_behavior_usage():
    _step("M1: behavior --json 用量折叠")
    # v0.9.1 Stage 5b：`hour_buckets` 已从 behavior 输出移除（它是退役的
    # merge_today 写盘链的输入）；用量按 model 折叠仍在 `usage.by_model`。
    r = _run(["behavior", "--json", "-", str(FIXTURE)])
    _assert(r.returncode == 0, "behavior --json 跑通")
    data = json.loads(r.stdout)
    _assert("usage" in data, "usage 字段存在")
    by_model = data["usage"]["by_model"]
    _assert(isinstance(by_model, dict) and by_model, "usage.by_model 非空")
    model_total = sum(
        m["uncached_input_tokens"] + m["output_tokens"]
        + m["cache_read_tokens"] + m["cache_write_tokens"]
        for m in by_model.values())
    _assert(model_total > 0, f"by_model 4 桶累加 > 0（{model_total}）")
    _assert(isinstance(data["cost"]["total"], (int, float)),
            "cost.total 是数值")


def m2_state_files(home):
    _step("M2: state 文件写入")
    r = _run(["oneline", str(FIXTURE)])
    _assert(r.returncode == 0, "oneline 跑通")
    sd = home / "state"
    for name in ("oneline.json", "today.json", "month.json"):
        p = sd / name
        _assert(p.is_file(), f"{name} 存在")
        _assert(p.stat().st_size > 0, f"{name} 非空")
    oneline = json.loads((sd / "oneline.json").read_text())
    _assert(oneline["schema_version"] == "1.0.0", "oneline schema_version")


def m3_cli(home):
    _step("M3: state list / calendar")
    r = _run(["state", "list"])
    _assert(r.returncode == 0, "state list 跑通")
    _assert("oneline.json" in r.stdout, "state list 含 oneline.json")

    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "cal.html"
        r = _run(["calendar", "--source", "today", "-o", str(out)])
        _assert(r.returncode == 0, "calendar --source today 跑通")
        _assert(out.is_file(), "calendar 输出文件存在")
        _assert(out.stat().st_size > 1000, "calendar 输出 > 1KB")
        # 同目录应 cp 状态文件
        _assert((Path(td) / "today.json").is_file(),
                "calendar 同目录 cp today.json")


def m4_html_renderable(home):
    _step("M4: HTML 模板可在浏览器渲染（语法检查）")
    tpl = ROOT / "assets" / "templates" / "calendar.html"
    _assert(tpl.is_file(), "templates/calendar.html 存在")
    raw = tpl.read_text()
    # 顶部有一大段 <!-- ... --> 说明「本模板无 <link rel=stylesheet>」等——
    # 零外链检查扫的是真实标记，不是文档注释，先把 HTML 注释剥掉。
    import re as _re
    text = _re.sub(r"<!--.*?-->", "", raw, flags=_re.DOTALL)
    # 零外链（CLAUDE.md §no third-party supply chain）
    for bad in ("<link rel=\"stylesheet\"", "<script src=", "@import",
                "@font-face"):
        _assert(bad not in text, f"HTML 不含外链 {bad!r}")
    # 必含关键元素
    for good in ("<style>", "<script>", "fetch("):
        _assert(good in text, f"HTML 含 {good}")


def m5_rust_parity(home):
    _step("M5: Python ↔ Rust byte-for-byte 锁步")
    if not RUST_BIN.is_file():
        print("  SKIP: Rust binary 未编译 (cargo build --release)")
        return
    # Python 跑一次
    r = _run(["behavior", "--json", "-", str(FIXTURE)])
    py_out = r.stdout

    # Rust 跑一次（注意：二进制行为子命令在 .args 里直接给 session_log）
    r = subprocess.run(
        [str(RUST_BIN), "behavior", str(FIXTURE), "--json", "-"],
        capture_output=True, text=True, env=os.environ.copy(), timeout=60)
    _assert(r.returncode == 0, "Rust behavior --json 跑通")
    rust_out = r.stdout

    # 同一份输入 → 同一份 usage 折叠（by_model / sequence / providers）
    py_usage = json.loads(py_out)["usage"]
    rust_usage = json.loads(rust_out)["usage"]
    _assert(py_usage == rust_usage,
            "Python ↔ Rust usage 折叠字节相等")


def m6_budget(home):
    _step("M6: 预算告警")
    # show 不带数据 → ok + 一条 reason
    r = _run(["budget", "show"])
    _assert(r.returncode == 0, "budget show 跑通")
    _assert("alert level:" in r.stdout, "show 输出含 level")

    # set + 改 daily → 读回
    r = _run(["budget", "set", "--daily", "55"])
    _assert(r.returncode == 0, "budget set --daily 跑通")
    r = _run(["budget", "show"])
    _assert("55.0" in r.stdout, "新值写入并读回")

    # snooze + show --json → snoozed_until 应在场
    r = _run(["budget", "snooze", "--hours", "2"])
    _assert(r.returncode == 0, "budget snooze 跑通")
    r = _run(["budget", "show", "--json"])
    out = json.loads(r.stdout)
    _assert("snoozed_until" in out and out["snoozed_until"],
            "snoozed_until 已写入")

    # unsnooze → 清掉
    r = _run(["budget", "unsnooze"])
    _assert(r.returncode == 0, "budget unsnooze 跑通")
    r = _run(["budget", "show", "--json"])
    out = json.loads(r.stdout)
    _assert(out["snoozed_until"] is None, "snoozed_until 已清")

    # disable → level = 'disabled'
    r = _run(["budget", "disable"])
    _assert(r.returncode == 0, "budget disable 跑通")
    r = _run(["budget", "show", "--json"])
    out = json.loads(r.stdout)
    _assert(out["level"] == "disabled", "disable 后 level = disabled")


def main():
    skip_rust = "--skip-rust" in sys.argv
    print(f"e2e smoke test (skip_rust={skip_rust})")
    home = _home()
    print(f"  AGENT_VITALS_HOME = {home}")

    try:
        m1_behavior_usage()
        m2_state_files(home)
        m3_cli(home)
        m4_html_renderable(home)
        if not skip_rust:
            m5_rust_parity(home)
        m6_budget(home)

        print("\n=== ALL OK ===")
        print(f"state dir: {home}/state (cleaned up on exit)")
    finally:
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    main()
