"""Claude Code 会话 JSONL 读取器 —— 五段式流水线（locate → shape → extract →
derive → coverage）的"locate → shape → extract"三段，I/O 都在这里；
"derive → coverage"在 `scripts/agent_vitals/agent/claude_evidence.py`（与 Rust
`crates/agent-vitals-harnesses/src/harnesses/claude_code/sessions/evidence.rs` 逐字节对齐），I/O 不进去。

与 Rust `src/agent/claude_session.rs` 逐字节对齐——两条实现产出同一份字典，字节
序（键序）一致，`tests/test_cli_matrix.py::both()` 的差分靠的就是这份一致。

一份 `~/.claude/projects/<slug>/<uuid>.jsonl` 就是完整会话（无 header、无跨文件
resume 的历史模式）。每条记录是 `{type, timestamp, uuid, parentUuid, ...}` 包络，
`type` 已知 14 种；**未知类型原样保留进 `records`**，认识不认识是 core
`claude_evidence.derive_coverage` 的职责（它把未知类型记进 `attempts`，绝不当作
损坏吞掉）。

**没有版本闸。** 与 Codex 同款靠存在性探测降级：空文件 → `empty`，读到非 JSON 行
→ `non-json`，文件不可读 → `file-missing`。**绝不假装读到了 0 条**（降级铁律——
报 0 会直接伪造出假的覆盖结论；degraded 时 `records` 保持 `None`，绝不改成空
数组）。一条坏行毁整份：截断写导致的损坏，拼半截是编造缺失（与 DSH/codex 的
degraded 同款）。
"""

import json

from pathlib import Path

from ..paths import user_home


def _lines(text):
    """Rust `str::lines()` 语义的镜像：`\\n` 与 `\\r\\n` 是行终结符、孤立 `\\r`
    是行内容；字符串以终结符结尾时不产生多余的空元素。不能用 `split_lines`
    （`util.py`）——那个额外认裸 `\\r` 为分隔符，会把 JSON 字符串值里合法的
    `\\r` 拦腰斩断成两行，把一份完整日志误判成 `degraded: non-json`。"""
    if not text:
        return []
    parts = text.split("\n")
    strip_last_r = text[-1] == "\n"
    if strip_last_r:
        parts = parts[:-1]
    out = []
    for i, p in enumerate(parts):
        last = (i == len(parts) - 1) and not strip_last_r
        if not last and p.endswith("\r"):
            p = p[:-1]
        out.append(p)
    return out


def parse_claude_session_log(text):
    """纯解析：整份 Claude 会话 JSONL → 记录数组。与 Rust
    `claude_session.rs::parse_claude_session_log` 逐字节对齐——空文件/首条就非
    JSON → degraded，`records` 保持 `None`（**绝不改成空数组**——空数组会被上层
    当成「读全了但确实 0 条」，那是编造）。"""
    records = []
    seen_any = False
    for line in _lines(text):
        if line.strip() == "":
            continue
        seen_any = True
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            # 一条坏行毁整份——不拼半截会话（与 DSH/codex 的 degraded 同款）。
            return {"degraded": "non-json", "records": None}
    if not seen_any:
        return {"degraded": "empty", "records": None}
    return {"records": records}


def read_claude_session_log(path):
    """读一个会话文件。文件缺失 → degraded("file-missing")；解析降级透传。
    `session_id` 由调用方从文件名兜底（同 codex 的 file_stem 惯例——session 永远
    可指认，绝不把缺席当成 0 条真数据）。与 Rust `read_claude_session_log` 对齐：
    无效 UTF-8 字节用 `errors="replace"` 逐字节替换成 U+FFFD（Rust
    `from_utf8_lossy` 同款）。"""
    try:
        bytes_data = path.read_bytes()
    except OSError:
        return {"degraded": "file-missing", "records": None}
    return parse_claude_session_log(bytes_data.decode("utf-8", errors="replace"))


def claude_project_files(home=None):
    """枚举 `~/.claude/projects/**/*.jsonl`（递归，同 codex_rollout_files 的
    walkdir 做法），**全局按路径字符串排序**。缺失的根 → 空（存在性探测，绝不
    报错）。`home` 默认 `Path.home()`（尊重 `HOME`，测试用 `isolated_home_env`
    注入）。Rust 由 main.rs 解析 `HOME`/`USERPROFILE` 传入同一路径。"""
    if home is None:
        home = user_home()
    home = Path(home)
    root = home / ".claude" / "projects"
    files = []
    if root.is_dir():
        files.extend(root.rglob("*.jsonl"))
    files = [p for p in files if p.is_file()]
    return sorted(files, key=str)


def _record_ts(record):
    if not isinstance(record, dict):
        return None
    ts = record.get("timestamp")
    return ts if isinstance(ts, str) else None


def _file_info(path):
    """一份会话文件对 `claude-session` 有用的全部信息。degraded 文件（不可读/
    非 JSON/空）→ records 空 + 时间戳 None，但**仍按文件名兜底的 session_id
    参与分组**（同 codex 的 filename-stem 惯例——session 永远可指认，绝不把缺席
    当成 0 条真数据）。"""
    parsed = read_claude_session_log(path)
    records = parsed.get("records")
    records = records if isinstance(records, list) else []
    session_id = Path(path).stem
    if not session_id:
        session_id = "unknown"
    first = _record_ts(records[0]) if records else None
    last = _record_ts(records[-1]) if records else None
    return {
        "path": str(path),
        "session_id": session_id,
        "records": records,
        "first": first,
        "last": last,
    }


def _title_of(records):
    """ai-title 记录是 Claude 的会话标题（随会话推进更新，最后看见的赢——与 codex
    的「当前状态」惯例一致）。真机字段是 `aiTitle`（不是 `title`——首版读到
    `title` 恒 None，被 812 条真机 ai-title 当场证伪）；`title` 保留为旧版本兜底。
    与 Rust `title_of` 同款：取**第一条** ai-title 的 aiTitle/title 字符串。"""
    for r in records:
        if not isinstance(r, dict):
            continue
        if r.get("type") != "ai-title":
            continue
        t = r.get("aiTitle")
        if isinstance(t, str):
            return t
        t = r.get("title")
        if isinstance(t, str):
            return t
    return None


def _cwd_of(records):
    """第一条携带 cwd 的记录（会话的起跑目录——同 core 适配器的 first_cwd 惯例）。"""
    for r in records:
        if not isinstance(r, dict):
            continue
        cwd = r.get("cwd")
        if isinstance(cwd, str):
            return cwd
    return None


def _file_bytes(path):
    try:
        return path.stat().st_size
    except OSError:
        # 枚举与 stat 之间文件消失 → 按 0 字节计，不 abort（文件仍算 file_count）。
        return 0


def claude_session_roots_report(home=None):
    """`~/.claude/projects` 根的存在性报告（r2a store 的
    `source_statuses["claude-code"]` 与 menubar 的 `harness_has_source` 都靠它判「该
    执行环境有数据源」——roots 缺席时绝不能报「0 会话」冒充「没有 Claude Code」）。
    镜像 `codex_session_roots_report`：单根 `projects`，exists/file_count/
    total_bytes 同形状、同键序（harness → roots，根对象 kind → path → exists →
    file_count → total_bytes）。键序是字节一致的一部分，不能重排。
    mirror `claude_session.rs::claude_session_roots_report`。"""
    if home is None:
        home = user_home()
    home = Path(home)
    root = home / ".claude" / "projects"
    exists = root.is_dir()
    file_count = 0
    total_bytes = 0
    if exists:
        files = [p for p in sorted(root.rglob("*.jsonl"), key=str) if p.is_file()]
        file_count = len(files)
        total_bytes = sum(_file_bytes(f) for f in files)
    return {
        "harness": "claude-code",
        "roots": [{
            "kind": "projects",
            "path": str(root),
            "exists": exists,
            "file_count": file_count,
            "total_bytes": total_bytes,
        }],
    }
