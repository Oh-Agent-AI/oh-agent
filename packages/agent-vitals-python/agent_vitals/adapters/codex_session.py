"""Codex 会话日志（rollout JSONL）读取器 —— P4 适配器的 "locate → shape →
extract" 三段（五段式流水线 locate → shape → extract → derive → coverage，
见 `docs/RUNTIME_EVIDENCE_CONTRACT.md` §4.2）。"derive → coverage" 两段在
`scripts/agent_vitals/agent/codex_evidence.py`（与 Rust
`crates/agent-vitals-harnesses/src/harnesses/codex/sessions/evidence.rs` 逐字节对齐），I/O 不进去。

与 Rust `src/codex_session.rs` 逐字节对齐——两条实现产出同一份字典，字节序
（键序）一致，`tests/test_cli_matrix.py::both()` 的差分靠的就是这份一致。

Codex 的 rollout 落盘在 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`
或 Zstandard 压缩的 `rollout-*.jsonl.zst`，
明文 append-only JSONL，每行一个 `{type, timestamp, payload}` 包络。会话被
归档时会移到 `~/.codex/archived_sessions/`——两个根都在
`codex_session_roots_report` 里报告，只认识 live 就是 cc-trace 研究 §B 的漏读
（漏扫归档会话 = 漏成本）。**命名冲突警告**：
`scripts/agent_vitals/adapters/codex.py` 是安装时的运行时探针适配器，跟这里
完全无关；本模块是会话日志审计，叫 `codex_session`，不要互相复用。

**没有版本闸。** DSH 的 `SESSION_FORMAT_VERSION` 是 adapter-private（`dsh.py`
里那个 `EXPECTED_SESSION_FORMAT_VERSION`），§14.4 明确说 Codex 格式无版本、
靠兼容 shim 演进——照搬版本闸会把「新 cli 多写了一种记录类型」误判成「日志
损坏」。这里只靠存在性探测降级：空文件 → `missing-header`，读到非 JSON 行 →
`non-json`，文件不可读 → `file-missing`。**绝不假装读到了 0 条**（同
`dsh.py` 的降级铁律——报 0 会直接伪造出假的覆盖结论）。

未知的记录类型**原样保留进 `items`**，不在这里判「损坏」也不丢——认识不
认识是 core `codex_evidence.derive_coverage` 的职责（它把未知类型记进
`attempts`，§14.4 "skipped and recorded in attempts, never treated as
corruption"）。解析器只负责「把 JSONL 逐行读进来 + 抽出 provenance 字段」。
"""

import json
from pathlib import Path

from ..paths import user_home
from ..util import split_lines


def _empty_result():
    """与 Rust `codex_session.rs::empty_result` 同一个键序：items 先行、
    degraded 收尾。键序是字节一致的一部分，不能重排。"""
    return {
        "items": None,
        "session_id": None,
        "history_mode": None,
        "cli_version": None,
        "model": None,
        "workspace_roots": [],
        "degraded": False,
    }


def _degraded(reason):
    result = _empty_result()
    result["degraded"] = reason
    # 降级时 items 必须保持 None，**绝不改成空列表**——空列表会被上层当成
    # 「读全了但确实 0 条」，那是编造。
    result["items"] = None
    return result


def parse_codex_session_log(text):
    """纯解析：把整个 rollout JSONL 文本折成 provenance 字段 + 原始条目数组。
    与 Rust `codex_session.rs::parse_codex_session_log` 逐字节对齐。

    抽取的 provenance 字段（实测 field path，见 `codex-corpus-facts` 记忆与
    `fixtures/codex/README.md`）：

    | 输出字段 | 来源 | 说明 |
    |---|---|---|
    | `session_id` | `session_meta.payload.session_id`（缺时退回 `.id`） | §14.4 back-fill |
    | `history_mode` | `session_meta.payload.history_mode` | 形状探针，只作 provenance |
    | `cli_version` | `session_meta.payload.cli_version` | 同上 |
    | `model` | `turn_context.payload.model`（**最新**一条） | session_meta.payload.model 实测恒为 null |
    | `workspace_roots` | `turn_context.payload.workspace_roots`（**最新**非空一条） | 与 dsh 的 last_catalog_wins 同一「当前状态」惯例 |

    其余所有行（event_msg / response_item / world_state / compacted / …）原样
    收进 `items`，解析器不挑拣。
    """
    lines = split_lines(text)
    if not lines:
        return _degraded("missing-header")

    items = []
    session_id = None
    history_mode = None
    cli_version = None
    model = None
    workspace_roots = []

    for line in lines:
        if not line.strip():
            # 空白行不是事件（真实 writer 只在文件尾补一个换行），跳过。
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            return _degraded("non-json")
        ttype = item.get("type") if isinstance(item, dict) else ""
        if ttype == "session_meta":
            payload = item.get("payload") if isinstance(item, dict) else None
            if isinstance(payload, dict):
                # Rust 是 `.get("session_id").or_else(|| .get("id"))`：键存在
                # （即便值是 null）就不退回 id，只有键整个缺席才退回。Python
                # 的 `.get()` 对「键缺席」和「键存在但值 null」都返回 None，
                # 必须用 `not in` 区分，否则会错误地退回 id。
                sid = payload.get("session_id")
                if sid is None and "session_id" not in payload:
                    sid = payload.get("id")
                if isinstance(sid, str):
                    session_id = sid
                # 这三个字段是「以最后一条 session_meta 为准」的整体替换：
                # 后一条缺字段会把前一条的值重置成 None（Rust 的同款行为）。
                hm = payload.get("history_mode")
                history_mode = hm if isinstance(hm, str) else None
                cv = payload.get("cli_version")
                cli_version = cv if isinstance(cv, str) else None
        elif ttype == "turn_context":
            payload = item.get("payload") if isinstance(item, dict) else None
            if isinstance(payload, dict):
                # 模型：取最新一条 turn_context 的非空值。真实语料里
                # session_meta.payload.model 恒为 null，model 只在
                # turn_context 里（实测 `gpt-5.6-sol`）。只在是字符串时覆盖，
                # 否则保留前一条（与 workspace_roots 的「最新非空」一致）。
                m = payload.get("model")
                if isinstance(m, str):
                    model = m
                # workspace_roots：最新一条非空列表覆盖成「当前」。
                roots = payload.get("workspace_roots")
                if isinstance(roots, list):
                    names = [r for r in roots if isinstance(r, str)]
                else:
                    names = []
                if names:
                    workspace_roots = names
        # 其它记录类型只进 items，provenance 不从这里取。

        items.append(item)

    result = _empty_result()
    result["items"] = items
    result["session_id"] = session_id
    result["history_mode"] = history_mode
    result["cli_version"] = cli_version
    result["model"] = model
    result["workspace_roots"] = workspace_roots
    return result


def read_codex_session_log(path):
    """读 JSONL 或 `.jsonl.zst` 文件，再交给纯解析。

    Zstandard 读取复用 DSH 的多帧解码器。Python 环境未安装可选的
    `zstandard` 时明确降级为 `unsupported-compression`，绝不把压缩字节误报为
    `non-json`。文件缺失/不可读时降级为 `file-missing`。
    """
    try:
        path = Path(path)
        data = path.read_bytes()
    except OSError:
        return _degraded("file-missing")
    if str(path).endswith(".jsonl.zst"):
        from .dsh import _zstd, decode_zstd_multi_frame

        if _zstd() is None:
            return _degraded("unsupported-compression")
        data = decode_zstd_multi_frame(data)
        if data is None:
            return _degraded("zstd-decode-error")
    text = data.decode("utf-8", errors="replace")
    return parse_codex_session_log(text)


# Codex 会话根集合的单一事实来源。**必须两个一起报告**——只列 live 就是
# cc-trace 研究 §B 的漏读：Codex 把会话归档进 archived_sessions 后，只扫 live
# 会静默漏掉归档会话的用量/成本（漏扫=漏成本，同一类「静默少算」事故）。
# `~/.codex/history` 不在这里（probe_logs.py 的 legacy 诊断里才有，且真实语料
# 里该目录不存在）；`session_index.jsonl` 在上层、不在任何根里，标题索引由
# `parse_session_index`/`read_session_index` 单独读——它不属于任何会话根。
CODEX_SESSION_ROOTS = (
    ("live", "sessions"),
    ("archived", "archived_sessions"),
)


def _file_bytes(path):
    try:
        return path.stat().st_size
    except OSError:
        # 与 Rust 的 `metadata().ok().unwrap_or(0)` 同款：文件在枚举与 stat
        # 之间消失时按 0 字节计，**不 abort 整个报告**。文件仍算进
        # file_count（它确实被枚举到了）。
        return 0


def codex_session_roots_report(home=None):
    """列出 Codex 会话根集合的确定性状形：每个根是否存在、rollout 数量、字节
    总量。与 Rust `codex_session.rs::codex_session_roots_report` 逐字节对齐。

    **存在性探测，绝不报错**：根目录不存在 → `exists=false` 且
    file_count/total_bytes 归零，不猜路径、也不把缺席当成 0 条真数据（同
    `parse_codex_session_log` 的降级铁律）。`home` 默认 `Path.home()`（尊重
    `HOME` 环境变量，测试用 `isolated_home_env` 注入）。

    键序是字节一致的一部分，不能重排：根对象 kind → path → exists →
    file_count → total_bytes；外层 harness → roots。
    """
    if home is None:
        home = user_home()
    home = Path(home)
    roots = []
    for kind, rel in CODEX_SESSION_ROOTS:
        root = home / ".codex" / rel
        exists = root.is_dir()
        file_count = 0
        total_bytes = 0
        if exists:
            files = sorted(
                (p for p in root.rglob("*") if p.is_file() and _is_session_log_file(p.name)),
                key=str,
            )
            file_count = len(files)
            total_bytes = sum(_file_bytes(f) for f in files)
        roots.append({
            "kind": kind,
            "path": str(root),
            "exists": exists,
            "file_count": file_count,
            "total_bytes": total_bytes,
        })
    return {"harness": "codex", "roots": roots}


def codex_rollout_files(home=None):
    """枚举两个会话根下所有未压缩及 Zstandard 压缩 rollout（live + archived）。

    与 `codex_session_roots_report` 同一套根集合，但那是存在性报告（统计数量/
    字节），这里给出**实际要折叠的文件**。**全局按路径字符串排序**（不是按根
    分开排）：Rust 侧 `walkdir` 收集后 `to_string_lossy().cmp()` 也是全局排——
    `archived_sessions/…` 按字母序排在 `sessions/…` 前，两侧保持一致，折叠的
    merge 顺序（决定模型/速度首现序）才不会漂移。缺失的根 → 跳过（存在性探测，
    绝不报错）。`home` 默认 `Path.home()`（尊重 `HOME`，测试用 `isolated_home_env`
    注入）。"""
    if home is None:
        home = user_home()
    home = Path(home)
    files = []
    for _kind, rel in CODEX_SESSION_ROOTS:
        root = home / ".codex" / rel
        if root.is_dir():
            files.extend(p for p in root.rglob("*") if p.is_file() and _is_rollout_file(p.name))
    return sorted((p for p in files if p.is_file()), key=str)


def _is_rollout_file(name):
    return name.startswith("rollout-") and (name.endswith(".jsonl") or name.endswith(".jsonl.zst"))


def _is_session_log_file(name):
    return name.endswith(".jsonl") or name.endswith(".jsonl.zst")


def parse_session_index(text):
    """纯解析：把 `session_index.jsonl` 折成 `{id: thread_name}` 映射。与 Rust
    `codex_session.rs::parse_session_index` 对齐（同一份 dict，键序是插入序，
    字节一致靠两次实现按同一次遍历填充）。

    索引的 `id` 键 = **逻辑 `payload.session_id`**（不是 rollout 文件名 UUID
    `payload.id`）——实测本机 51 份 rollout：`payload.session_id` 命中索引
    47/51，`payload.id` 只命中 21/51（恰是「主会话 id==session_id」那 21 份）。
    `parse_codex_session_log` 抽出的 `session_id` 字段就是标题 join 键。

    **只读、单行失败跳过、升级失败不报错**（cc-trace 的 `title_index.rs` 同款）：
    malformed / 缺 id 或 thread_name / 非 string / trim 后为空的标题行直接跳过，
    **绝不 abort 整个索引**。同一 id 可有多条（rename 后带 `(2)` 后缀），
    后写覆盖前写（last-write-wins）——append-only，后写=更新。
    """
    index = {}
    for line in split_lines(text):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue
        sid = entry.get("id")
        title = entry.get("thread_name")
        if not isinstance(sid, str) or not isinstance(title, str):
            continue
        title = title.strip()
        if not title:
            continue
        index[sid] = title
    return index


def read_session_index(home=None):
    """读 `home/.codex/session_index.jsonl`，交给纯解析。文件缺失/不可读 →
    空映射（**存在性探测，绝不报错**——标题是加分项，不是准入项，同
    `codex_session_roots_report` 的缺席铁律）。`home` 默认 `Path.home()`（尊重
    `HOME`，测试用 `isolated_home_env` 注入）。Rust 由 main.rs 解析
    `HOME`/`USERPROFILE` 传入同一路径。
    """
    if home is None:
        home = user_home()
    home = Path(home)
    path = home / ".codex" / "session_index.jsonl"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    return parse_session_index(text)
