"""接管协议的 **Python mirror**（R1d，§4.2/§4.3 最小可测子集）。

`agent_vitals_domain::takeover` 的 Python 镜像：session_key / manifest+ledger 读写 /
owner_allows / cutover / mark_fold / record_fold / machine_namespace。

R1d 起 Python 写链退休为 mirror —— 这个模块的作用是让 mirror 还能
（1）owner=python 时正常写（回退路径）、（2）owner=rust 时拒绝写（writer
fencing，§4.2：Python 与 Rust **都**拒绝非当前 owner）、（3）读 session
ledger，不重放已由 Rust 记过的会话（§4.3 exactly-once / 可测 rollback）。

纯规则（session_key 等）逐字节锁 Rust core；由
`tests/test_takeover_lockstep.py` 差分钉死（同一 fold-req 折进同源两份 state，
打码时间戳后逐文件字节相等）。**不在这里长第二份规则** —— 判断在 core，
这里只做「读文件 → 调镜像纯函数 → 原子写回」。
"""

from . import state as state_mod
from agent_vitals.paths import data_home

MANIFEST_SCHEMA_VERSION = "1.0.0"
LEDGER_SCHEMA_VERSION = "1.0.0"
PY_OWNER = "python"
RS_OWNER = "rust"
DEFAULT_OWNER = PY_OWNER


def session_key(harness_kind, native_id, machine_namespace):
    """自定界会话 key —— 与 core `session_key` 逐字节一致。

    长度前缀：`("ab","c")` 与 `("a","bc")` 不得同 key。例：
    `session_key("dsh", "s1", "ns-abc")` → `"3:dsh|2:s1|6:ns-abc"`。
    """
    def seg(s):
        return "%d:%s" % (len(s), s)

    return "%s|%s|%s" % (seg(harness_kind), seg(native_id), seg(machine_namespace))


def default_manifest():
    """缺 manifest 时的默认 —— owner=python、epoch=0（None → JSON null）。"""
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "owner": DEFAULT_OWNER,
        "epoch": 0,
        "since": None,
        "last_fold_at": None,
    }


def empty_ledger():
    return {"schema_version": LEDGER_SCHEMA_VERSION, "entries": {}}


def manifest_owner(manifest):
    return manifest.get("owner") or DEFAULT_OWNER


def manifest_epoch(manifest):
    return manifest.get("epoch") if isinstance(manifest.get("epoch"), int) else 0


def owner_allows(manifest, candidate):
    return manifest_owner(manifest) == candidate


def cutover(manifest, new_owner, now_iso):
    """owner 换人 + epoch+1 + since=now。last_fold_at 原样保留。"""
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "owner": new_owner,
        "epoch": manifest_epoch(manifest) + 1,
        "since": now_iso,
        "last_fold_at": manifest.get("last_fold_at"),
    }


def mark_fold(manifest, now_iso):
    """成功 fold 后推进：epoch+1 + last_fold_at=now。owner/since 不变。"""
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "owner": manifest_owner(manifest),
        "epoch": manifest_epoch(manifest) + 1,
        "since": manifest.get("since"),
        "last_fold_at": now_iso,
    }


def ledger_entry(harness_kind, native_id, machine_namespace, folded_at, epoch):
    return {
        "harness_kind": harness_kind,
        "native_id": native_id,
        "machine_namespace": machine_namespace,
        "folded_at": folded_at,
        "epoch": epoch,
    }


def ledger_folded(ledger, key):
    return key in (ledger.get("entries") or {})


def ledger_record(ledger, key, entry):
    """把 entry 插进 entries[key]。纯函数：不改入参 ledger。"""
    out = {"schema_version": LEDGER_SCHEMA_VERSION,
           "entries": dict(ledger.get("entries") or {})}
    out["entries"][key] = entry
    return out


# ── I/O（复用 state 的原子写 / 读，保证字节一致）────────────────────

def manifest_path():
    return data_home() / "state" / "writer-manifest.json"


def ledger_path():
    return data_home() / "state" / "session-ledger.json"


def machine_path():
    return data_home() / "machine.json"


def read_manifest():
    m = state_mod._read(manifest_path())
    return m if isinstance(m, dict) else default_manifest()


def write_manifest(value):
    state_mod._atomic_write(manifest_path(), value)


def read_ledger():
    l = state_mod._read(ledger_path())
    return l if isinstance(l, dict) else empty_ledger()


def write_ledger(value):
    state_mod._atomic_write(ledger_path(), value)


def machine_namespace():
    """读（必要时创建）本机命名空间 —— §4.3：可重放派生、持久在 app 自有
    config 的随机 UUID。**不许 hash 用户名/路径**（会把可识别信息稳定泄漏到
    导出）；每次重装随机生成则重装后同一日志变新会话。持久化解决后者，
    重装丢失时明示「新 profile」。
    """
    m = state_mod._read(machine_path())
    if isinstance(m, dict) and isinstance(m.get("machine_namespace"), str):
        return m["machine_namespace"]
    import secrets
    ns = secrets.token_hex(16)  # 32 hex，与 Rust 16 字节 urandom 同长
    state_mod._atomic_write(machine_path(),
                            {"schema_version": "1.0.0",
                             "machine_namespace": ns})
    return ns


def takeover(new_owner, now=None):
    """原子 cutover —— mirror 侧的 I/O 接线。返回写出的 manifest 路径。"""
    manifest = read_manifest()
    write_manifest(cutover(manifest, new_owner, now or state_mod._now_iso()))
    return manifest_path()


def fold_session_req(req, shadow=False):
    """Rust `fold_session` 驱动的 Python 镜像（差分 A/B 用）。

    返回 `(outcome, detail)`，outcome ∈ {"folded", "skipped", "refused"}。
    写序与 Rust 一致：导航快照 → ledger 记 key → manifest 提交（提交点）。
    影子模式跳过 owner 检查（§4.2 shadow replay：在非权威副本上排练）。

    v0.9.1 Stage 5b 后这是一个**闭合的导航快照协议**：只落
    `oneline.json` / `sessions.jsonl`。旧调用方即使仍附带 `hour_buckets` /
    `by_model_today` / `by_date_model` / `alert`，也一律忽略——`today.json` /
    `month.json` / `month-archive.json` / `alert.json` 的业务账已由 SQL 权威库
    取代，不能被 tick 重新写活（Rust `takeover.rs::fold_session` 同款边界）。
    """
    manifest = read_manifest()
    if not shadow and not owner_allows(manifest, RS_OWNER):
        return ("refused",
                "owner is %r, not rust" % manifest_owner(manifest))
    harness_kind = req.get("harness_kind") or "cli"
    native_id = req.get("session_id") or ""
    if not native_id:
        return ("refused", "session_id required (producer derives it, §4.3)")
    ns = req.get("machine_namespace")
    if not ns:
        return ("refused", "machine_namespace required (state machine-namespace)")
    key = session_key(harness_kind, native_id, ns)
    ledger = read_ledger()
    if ledger_folded(ledger, key):
        return ("skipped", key)
    now = state_mod._now_iso()
    epoch = manifest_epoch(manifest)
    oneline = req.get("oneline")
    if isinstance(oneline, dict):
        state_mod.write_oneline(oneline)
        state_mod.append_session_history(oneline)
    entry = ledger_entry(harness_kind, native_id, ns, now, epoch + 1)
    write_ledger(ledger_record(ledger, key, entry))
    write_manifest(mark_fold(manifest, now))
    return ("folded", key)


# ── cli.py oneline 接的 retire 侧门（fencing + dedup）──────────────

def owner_allows_python():
    """Python mirror 的写门：owner=rust 时拒绝（§4.2 双写防护）。"""
    return owner_allows(read_manifest(), PY_OWNER)


def folded(session_key):
    """这个会话已经折过？（读 ledger；缺文件 → 空 → False）"""
    return ledger_folded(read_ledger(), session_key)


def record_fold(session_key, harness_kind, native_id, machine_namespace):
    """oneline 折完后的提交：ledger 记 key + manifest epoch+1/last_fold_at。

    写序与 Rust 驱动一致（ledger 先、manifest 后）。epoch 取当前 manifest 代际
    +1 —— 即这次 fold 落账的代际。
    """
    manifest = read_manifest()
    now = state_mod._now_iso()
    entry = ledger_entry(harness_kind, native_id, machine_namespace, now,
                         manifest_epoch(manifest) + 1)
    write_ledger(ledger_record(read_ledger(), session_key, entry))
    write_manifest(mark_fold(manifest, now))
