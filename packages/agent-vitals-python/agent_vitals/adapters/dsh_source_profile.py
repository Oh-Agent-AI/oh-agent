"""DSH 的 source_profile 派生（§1.3 / §2.5）—— v0.9.1 PR #4.5 抽离。

`session_key = harness_kind:native_id:source_profile:machine_namespace` 里的
`source_profile` 字段（DSH 专属，claude/codex 不填）：会话头 `cwd` 清洗后的项目
路径形式 `--{cwd.replace("/", "-")}--`，cwd 缺失 → 空串（诚实缺失；native_id
全局唯一，空 source_profile 不会撞键）。

mirror `crates/agent-vitals-harnesses/src/harnesses/dsh/sessions/header.rs::dsh_source_profile`。
之前住在 `agent/r2a.py` 里——r2a.py v0.9.3 PR #5 整文件删除，本模块先抽出来
让 `tests/test_dsh_usage_fact.py:54` 与 `agent/dsh_usage_fact.py:35` 不依赖
r2a.py 也能跑（删除 r2a.py 时 `__legacy_r2a__` 标记仍可以保留作为审计痕迹，
但不允许有运行期 import 依赖它）。

W8（2026-09-24）：r2a.py 删除，`dsh_header` 也搬来——与 Rust
`agent-vitals-harnesses/src/harnesses/dsh/sessions/header.rs` 同居（那里同样是
`dsh_header` + `dsh_source_profile` 两个函数）。
"""

import json

from ..util import split_lines


def dsh_header(text):
    """从**已解压文本**读会话头：`id` + `cwd`。`id` 缺失 → None（无法建
    SessionKey）。只读头行。mirror `agent_vitals_harnesses::harnesses::dsh::sessions::header::dsh_header`。"""
    line = next((l for l in split_lines(text) if l.strip()), None)
    if line is None:
        return None
    try:
        v = json.loads(line.strip())
    except json.JSONDecodeError:
        return None
    if not isinstance(v, dict):
        return None
    id_ = v.get("id")
    if not isinstance(id_, str):
        return None
    cwd = v.get("cwd")
    return (id_, cwd if isinstance(cwd, str) else None)


def dsh_source_profile(cwd):
    """DSH 的 source_profile：`--{cwd.replace("/", "-")}--`。cwd=None/空 → 空串。"""
    if cwd is None:
        return ""
    if not isinstance(cwd, str):
        return ""
    return "--%s--" % cwd.replace("/", "-")