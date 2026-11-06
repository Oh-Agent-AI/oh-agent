"""Generic filesystem discovery and deterministic SKILL.md inventory records."""

import hashlib
import os
import re
import time
from pathlib import Path

from ..adapters.claude import lookup_usage
from ..adapters.workbuddy import workbuddy_skill_active
from .frontmatter import parse_frontmatter
from .security import security_scan
from ..util import est_tokens, norm, safe_str


DOC_DIRS = {"references", "reference", "refs", "docs", "doc"}
REPO_META = {"readme.md", "license.md", "license", "changelog.md", "contributing.md",
             "code_of_conduct.md", "security.md", "notice.md", "authors.md"}
PLUGIN_PATH_RE = re.compile(r"/plugins/(cache|marketplaces)/([^/]+)/(.+?)/skills/")
PLUGIN_WRAPPER_DIRS = {"plugins", "external_plugins", "unknown", "skills"}
VERSION_SEGMENT_RE = re.compile(r"^v?\d+(?:\.\d+)*$")


def plugin_identity(path_n: str):
    """Extract ``(plugin, marketplace)`` from a plugin Skill path."""
    match = PLUGIN_PATH_RE.search(path_n + "/")
    if not match:
        return None, None
    marketplace = match.group(2)
    middle = [part for part in match.group(3).split("/")
              if part and part not in PLUGIN_WRAPPER_DIRS]
    while len(middle) > 1 and VERSION_SEGMENT_RE.match(middle[-1]):
        middle.pop()
    plugin = middle[-1] if middle else marketplace
    return plugin, marketplace


def classify(skill_dir: Path, harness: str, home_n=None, cwd_n=None):
    """Return the precedence level, namespace, and plugin key for one Skill."""
    home_n = home_n if home_n is not None else norm(Path(os.path.expanduser("~")))
    cwd_n = cwd_n if cwd_n is not None else norm(Path.cwd())
    path_n = norm(skill_dir.resolve())
    plugin, marketplace = plugin_identity(path_n)
    if plugin:
        return "plugin", plugin, f"{plugin}@{marketplace}"
    if harness == "openclaw":
        if "/workspace/skills" in path_n:
            return "workspace", None, None
        if "/plugin-skills/" in path_n:
            return "plugin", None, None
        if path_n.startswith(cwd_n + "/skills"):
            return "workspace", None, None
        if path_n.startswith(cwd_n + "/.agents/skills"):
            return "project", None, None
        if path_n.startswith(home_n + "/.agents/skills"):
            return "personal", None, None
        if path_n.startswith(home_n + "/.openclaw/skills"):
            return "managed", None, None
        if re.match(re.escape(home_n) + r"/\.open[^/]*/skills(?:/|$)", path_n):
            return "managed", None, None
    if harness == "hermes":
        return (("personal", None, None) if
                path_n.startswith(home_n + "/.hermes/skills") else
                ("external", None, None))
    if harness == "codex":
        return "personal", None, None
    if harness == "workbuddy":
        if (path_n.startswith(cwd_n + "/.codebuddy/skills") or
                path_n.startswith(cwd_n + "/.workbuddy/skills")):
            return "project", None, None
        if path_n.startswith(home_n + "/.workbuddy/skills"):
            return "personal", None, None
        if "/.workbuddy/plugins/marketplaces/workbuddy-builtin/" in path_n:
            return "managed", None, None
        return "unknown", None, None
    if harness == "dsh":
        # DSH 的 level 只表示「落在哪条 discovery root」（rank 见 DSH_LEVEL_RANK）。
        # 这里的判定只回答文件系统层；scope 层由 A5 的 conflict_domain 第三段表达。
        # ~/.agents/skills 与 OpenClaw 共享，但 DSH 侧按 user-agents 归类，
        # 不能复用 OpenClaw 的 personal。
        if path_n.startswith(home_n + "/.dsh/skills"):
            return "user-dsh", None, None
        if path_n.startswith(home_n + "/.agents/skills"):
            return "user-agents", None, None
        if (path_n.startswith(cwd_n + "/.dsh/skills") or
                norm(skill_dir).startswith(".dsh/skills")):
            return "project-dsh", None, None
        if (path_n.startswith(cwd_n + "/.agents/skills") or
                norm(skill_dir).startswith(".agents/skills")):
            return "project-agents", None, None
        return "custom", None, None
    if "/managed" in path_n or "/etc/" in path_n or "enterprise" in path_n:
        return "enterprise", None, None
    if path_n.startswith(home_n + "/.claude/skills"):
        return "personal", None, None
    if (path_n.startswith(cwd_n + "/.claude/skills") or
            norm(skill_dir).startswith(".claude/skills")):
        return "project", None, None
    return "unknown", None, None


def days_since(milliseconds, now=None):
    if not milliseconds:
        return None
    current = time.time() if now is None else now
    return round((current - milliseconds / 1000.0) / 86400.0, 1)


def scan_skill_dir(skill_dir: Path, harness: str, enabled_plugins, usage, plugins_known,
                   source_meta=None, home_n=None, cwd_n=None, now=None,
                   dsh_evidence=None, dsh_snapshot=None):
    """Build one stable public Skill record from a directory."""
    skill_file = skill_dir / "SKILL.md"
    if not skill_file.is_file():
        return None
    try:
        raw = skill_file.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    fields, frontmatter_raw, body = parse_frontmatter(raw)
    level, namespace, plugin_key = classify(skill_dir, harness, home_n, cwd_n)
    source_meta = source_meta or {}
    enabled_state, loaded_state, runtime_verified = None, None, False
    # DSH 的运行时证据字段（稀疏，与 openclaw 的 eligible 记录同一约定）：只有
    # catalog-visible 时置值，其余执行环境/其余 dsh 状态都不带这两个键。
    runtime_status = None
    body_loaded_state = None
    # DSH 的证据源（契约「Evidence recency」）：probe（快照，此刻）vs log（会话日志，
    # 当时）vs none（只有文件系统推断）。只有 dsh 才写进记录；其余执行环境不带这个键。
    evidence_recency = "none"
    if harness in ("codex", "openclaw", "hermes", "workbuddy", "custom"):
        loaded, reason = True, level if level != "unknown" else "explicit-root"
        if harness == "workbuddy" and "/plugins/marketplaces/workbuddy-builtin/" in norm(skill_dir):
            reason = "workbuddy-builtin-marketplace-manifest"
    elif harness == "claude-code" and level in ("personal", "project", "enterprise"):
        loaded, reason = True, level
    elif level == "plugin":
        if not plugins_known:
            loaded, reason = False, "plugin-state-unknown"
        elif plugin_key in (enabled_plugins or ()) or namespace in (enabled_plugins or ()):
            loaded, reason = True, "plugin-enabled"
        else:
            loaded, reason = False, "plugin-not-enabled"
    else:
        loaded, reason = False, "unknown-location"

    bundled, bundled_bytes = [], 0
    refs_tokens, refs_files = 0, 0
    corpus_files, corpus_bytes = 0, 0
    for path in sorted(skill_dir.rglob("*"), key=norm):
        if not path.is_file() or path.name == "SKILL.md":
            continue
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        bundled_bytes += size
        relative = norm(path.relative_to(skill_dir))
        bundled.append({"path": relative, "bytes": size})
        if path.suffix.lower() not in (".md", ".markdown"):
            continue
        parts = relative.split("/")
        if len(parts) == 1 and path.name.lower() in REPO_META:
            continue
        if len(parts) == 1 or parts[0].lower() in DOC_DIRS:
            try:
                refs_tokens += est_tokens(path.read_text(encoding="utf-8", errors="replace"))
                refs_files += 1
            except OSError:
                pass
        else:
            corpus_files += 1
            corpus_bytes += size

    name = safe_str(fields.get("name") or skill_dir.name)
    if harness == "openclaw":
        configured = source_meta.get("skill_entries", {}).get(name)
        if isinstance(configured, dict) and configured.get("enabled") is False:
            enabled_state, loaded_state = False, False
            loaded, reason = False, "openclaw-config-disabled"
        elif isinstance(configured, dict) and configured.get("enabled") is True:
            enabled_state, loaded_state = True, None
            loaded, reason = False, "openclaw-config-enabled-runtime-unverified"
        else:
            enabled_state, loaded_state = None, None
            loaded, reason = False, "openclaw-discoverable-runtime-unverified"
    elif harness == "workbuddy" and source_meta.get("workbuddy_package"):
        mode = source_meta.get("workbuddy_welcome_mode")
        if not workbuddy_skill_active(source_meta.get("workbuddy_legacy_name"), mode):
            loaded, reason = False, f"workbuddy-mode-filtered:{mode}"
            enabled_state, loaded_state = False, False
        else:
            reason = (f"workbuddy-builtin-active-mode:{mode}" if mode else
                      "workbuddy-builtin-mode-unknown")
            enabled_state, loaded_state = (True, None) if mode else (None, None)
    elif harness == "dsh":
        # DSH 的 loaded 有两个独立证据源（A4/A11），**先 probe 后 log**：
        #   probe（注册表快照，`--runtime-json`）回答「此刻这个 scope 解析出什么」；
        #   log（会话日志）回答「当时向模型发布了什么」。
        # probe 更新鲜（`evidence_recency` 正是为此区分时间坐标而存在），所以快照
        # 存在且未降级时优先；快照缺失/畸形才退回 log。
        #
        # 映射（契约「Two independent evidence sources」，绝不折叠）：
        #   - complete == true  → 快照成员 = catalog-visible（loaded）
        #   - complete == false → 全部 unknown，不是 false（DSH 发现不完整时整轮
        #     不发布目录，这不是「部分答案」，是「这一轮所有 skill 对模型都不可见」）
        #   - 无快照 → 退回 log（A4）
        #
        # 进了名单只证明**紧凑元数据进了目录**，不证明正文被读过（契约「Precision
        # of loaded」），所以 body_loaded_state 恒为 None、runtime_status 只到
        # catalog-visible。读不到任何证据只能停在「磁盘可发现」，绝不能把「没读
        # 到」当「没加载」——那会凭空判一批 skill 未生效（不变量 12）。
        if dsh_snapshot is not None and not dsh_snapshot.get("degraded"):
            evidence_recency = "probe"
            names = dsh_snapshot.get("catalog_entries") or []
            if dsh_snapshot.get("complete") is True:
                if name in names:
                    loaded, reason = True, "dsh-catalog-visible"
                    runtime_status = "catalog-visible"
                    body_loaded_state = None
                else:
                    loaded, reason = False, "dsh-not-in-catalog"
            else:
                loaded, reason = False, "dsh-discovery-incomplete"
        else:
            catalog = (dsh_evidence.get("catalog_entries") or []) if (
                dsh_evidence and not dsh_evidence.get("degraded")) else None
            if catalog is None:
                loaded, reason = False, "dsh-discoverable-runtime-unverified"
            else:
                evidence_recency = "log"
                if name in catalog:
                    loaded, reason = True, "dsh-catalog-visible"
                    runtime_status = "catalog-visible"
                    body_loaded_state = None
                else:
                    loaded, reason = False, "dsh-not-in-catalog"
    hits, last_ms, matched_key = lookup_usage(usage, name, namespace)
    if harness == "dsh" and dsh_evidence and not dsh_evidence.get("degraded"):
        # DSH 的触发证据不读 claude.json 的 skillUsage——那是另一个执行环境（Claude
        # Code）的使用历史，与 DSH 的会话日志是两套账。日志里的 invoked（用户
        # 显式 `/<name>`）与 selected（模型自主 tool/call 选中）才是本执行环境的真实
        # 触发数。两者都算「用过」：僵尸判定问的是「这个 skill 有没有产生过价值」，
        # 模型自主选中同样说明它在起作用——analysis._build_dsh_trigger 的
        # never_triggered 正是 never_selected ∩ never_invoked，两侧的计数语义
        # 必须一致，否则报告里 trigger_data 说「proj-only 用过一次」、skill 记录
        # 却写「0 次」，explain 漏斗就自相矛盾。
        #
        # invoked/selected 只是名字列表、没有时间戳，所以 last_used_days_ago 保持
        # None——「有触发数但不知新鲜度」由 lifecycle 的 occasional 表达，绝不伪造
        # 一个最近使用时间；usage_key_matched 同理为 None，这里没有匹配 claude.json
        # 的键。
        hits = (dsh_evidence.get("invoked") or []).count(name) \
            + (dsh_evidence.get("selected") or []).count(name)
        last_ms = None
        matched_key = None

    try:
        born = min(skill_dir.stat().st_ctime, skill_file.stat().st_ctime)
    except OSError:
        born = skill_file.stat().st_mtime
    current = time.time() if now is None else now
    age_days = round((current - born) / 86400.0, 1)
    description = fields.get("description", "")
    core_tokens = est_tokens(body)
    # DSH 的冲突域带 scope 层（A5：dsh:<DSH_HOME>:<layer>）。<DSH_HOME> 是 DSH
    # 配置根（默认 ~/.dsh），与其他执行环境的 home 一样用 home_n 做路径归一。
    # 本波只有文件系统根：DSH 的 filesystem provider 只注册在**全局 scope 层**，
    # 所以 <layer> 恒为 "global"（占位）。真正的 preset / agent 层要等运行时证据
    # （后续波 A10），届时这里改从证据里取层，而不是硬编码 "global"。
    dsh_home = (home_n if home_n is not None else norm(Path(os.path.expanduser("~")))) + "/.dsh"
    record = {
        "name": name,
        "dir_name": safe_str(skill_dir.name),
        "harness": harness,
        "harness_family": "claude-code" if harness.startswith("claude-code") else harness,
        "level": level,
        "namespace": namespace,
        "plugin_key": plugin_key,
        "loaded": loaded,
        "loaded_reason": reason,
        "installed": True,
        "discoverable": True if harness == "openclaw" else loaded,
        "enabled_state": enabled_state,
        "loaded_state": loaded_state,
        "runtime_verified": runtime_verified,
        "instance_id": source_meta.get("instance_id"),
        "instance_root": source_meta.get("instance_root"),
        "config_path": source_meta.get("config_path"),
        "root_kind": source_meta.get("root_kind"),
        "conflict_domain": (f"dsh:{dsh_home}:global" if harness == "dsh"
                            else f"openclaw:{source_meta.get('instance_id')}"
                            if harness == "openclaw" and source_meta.get("instance_id") else harness),
        "path": norm(skill_dir),
        "content_hash": hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12],
        "description": description,
        "description_chars": len(description),
        "tier1_tokens": est_tokens(frontmatter_raw),
        "tier2_tokens": core_tokens,
        "tier2_core_tokens": core_tokens,
        "tier2_refs_tokens": refs_tokens,
        "tier2_refs_files": refs_files,
        "tier2_max_tokens": core_tokens + refs_tokens,
        "body_lines": body.count("\n") + 1 if body else 0,
        "bundled_files": len(bundled),
        "bundled_bytes": bundled_bytes,
        "data_corpus_files": corpus_files,
        "data_corpus_bytes": corpus_bytes,
        "mtime": int(skill_file.stat().st_mtime),
        "installed_days_ago": age_days,
        "usage_count": hits,
        "last_used_days_ago": days_since(last_ms, current if now is not None else None),
        "usage_key_matched": matched_key,
        "has_name": bool(fields.get("name")),
        "has_description": bool(description),
        "security": security_scan(skill_dir, raw),
    }
    if runtime_status is not None:
        # 只有 dsh catalog-visible 才带这两个字段（与 openclaw eligible 的
        # 稀疏约定一致）：runtime_status 说「紧凑元数据可见」，body_loaded_state
        # 恒为 null——进了目录不等于正文被读过。
        record["runtime_status"] = runtime_status
        record["body_loaded_state"] = body_loaded_state
    if harness == "dsh":
        # 证据源只对 dsh 有意义（其余执行环境单一隐式 scope，契约不要求逐记录标注）。
        # probe（快照）/ log（会话日志）/ none（文件系统推断）必须显式分开，否则
        # 一个月前的 log 证据与当下的 probe 证据并排渲染，报告就开始在时间上撒谎。
        record["evidence_recency"] = evidence_recency
    return record


def _root_path(root, home=None):
    if home is not None and isinstance(root, str) and root.startswith("~"):
        return Path(home) / root[1:].lstrip("/\\")
    return Path(os.path.expanduser(root))


def collect(roots, enabled_plugins, usage, plugins_known, home=None, cwd=None,
            dsh_evidence=None, dsh_snapshot=None):
    """Traverse roots deterministically and return records, roots, and read failures."""
    found, scanned_roots, unreadable, seen = [], [], [], set()
    home_n = norm(Path(home)) if home is not None else norm(Path(os.path.expanduser("~")))
    cwd_n = norm(Path(cwd)) if cwd is not None else norm(Path.cwd())
    for item in roots:
        harness, root = item[:2]
        source_meta = item[2] if len(item) > 2 else {}
        base = _root_path(root, home)
        try:
            key = norm(base.resolve())
        except OSError:
            key = norm(base)
        dedupe_key = (harness, source_meta.get("instance_id"), key)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        if not base.is_dir():
            continue
        scanned_roots.append({"harness": harness, "path": norm(base),
                              "instance_id": source_meta.get("instance_id"),
                              "root_kind": source_meta.get("root_kind")})
        skill_files = ([base / "SKILL.md"] if source_meta.get("only_direct") else
                       sorted(base.rglob("SKILL.md"), key=norm))
        for skill_file in skill_files:
            if not skill_file.is_file():
                continue
            record = scan_skill_dir(
                skill_file.parent, harness, enabled_plugins, usage, plugins_known,
                source_meta, home_n=home_n, cwd_n=cwd_n, dsh_evidence=dsh_evidence,
                dsh_snapshot=dsh_snapshot)
            if record:
                found.append(record)
            elif skill_file.is_file():
                unreadable.append({
                    "name": skill_file.parent.name,
                    "path": norm(skill_file.parent),
                    "harness": harness,
                    "reason": "SKILL.md exists but cannot be read (permission or I/O error)",
                })
    return found, scanned_roots, unreadable
