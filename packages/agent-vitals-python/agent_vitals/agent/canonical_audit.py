"""Canonical-session SV 审计投影的共享求值器（Python 侧）。

`codex_audit_projection` 与 `claude_audit_projection` 都是同一批 core dispatcher
（Rust `match_behavior_canonical` + `match_trajectory_canonical`）的 Python 镜像
——canonical session 的形状是 harness-neutral 的（`tool_calls`/`tool_results`/
`turns`/`approvals`/`sandbox_modes` 五条 timeline + `meta`），所以求值器本体是
**执行环境无关**的，两个适配器共用这一份。别在这里给某一执行环境开特例（SV607/608 的
Claude harness-capability degradation 是 dispatcher 层的事，在
`claude_session_audit.py` 里做 override，不污染共享求值器）。

与 Rust dispatchers 的对应关系：

- **门控**：`requires` 里任一信号对应的 timeline 空 → `unavailable`；SV613/614
  是"至少一个信号有证据"（OR），两个 requires 都空才 unavailable（
  `trajectory.rs::OR_REQUIRES_CODES`）。
- **family ① findings 排序**：Rust `flatten` 按 `__ord`（事件 entry 下标）稳定
  排序；canonical 的 entry `seq` 就是枚举序数（Claude/Codex 适配器都按
  `seq = ordinal` 构造），所以这里按 `seq` 排序等价，None 排最后。
- **family ④ findings**：Rust `flatten_trajectory` 按码序追加、不 sort；这里
  `SV611→614` 的 `families.extend` 顺序就是码序，追加即同序。
- **SV613(b) lossy 路径**：Claude 的 `is_error → failed` 是唯一失败证据
  （`error_code` 恒 None），失败判据 = `failed is True` **或** `error_code is not
  None`（`trajectory.rs::detect_sv613_legacy` 的 (b) 判定）。DSH/Codex 的
  `failed` 恒 None，布尔式退化成原 `error_code` 判定——golden 字节零漂移。
"""

import re

# §6.5 各规则的 regex（与 core `behavior.rs` 的 pattern 逐字一致——两侧共用同一
# 份判别逻辑，任何一侧改了这里都要改另一边，差分测试会抓）。
_DESTRUCTIVE_RE = re.compile(r"(?i)\brm\s+-[a-z]*r[a-z]*f[a-z]*\b|\brm\s+-[a-z]*f[a-z]*r[a-z]*\b|\bdd\b[^\n]{0,60}\bof=/dev/|\bmkfs\b")
_PRIVILEGE_RE = re.compile(r"(?i)\bsudo\b|\bsu\b|\bchmod\s+[^\n]{0,10}777\b|\bchown\s+-R\b")
_REMOTE_EXEC_RE = re.compile(r"(?i)(curl|wget)[^\n|]{0,200}\|\s*(ba)?sh|\bbash\s*<\s*\(\s*(curl|wget)\b")
_SENSITIVE_PATH_RE = re.compile(r"(?i)~/\.ssh/authorized_keys|/etc/|~/\.bashrc")
_ABS_PATH_RE = re.compile(r"/(?:[A-Za-z0-9_.+-]+/)+[A-Za-z0-9_.+-]*")
_INTERNAL_IP_URL_RE = re.compile(r"(?i)https?://\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?")
_DENIED_CODES = frozenset(("FS_SANDBOX_DENIED", "ABORTED", "ABORTED_BEFORE_DISPATCH", "UNKNOWN_TOOL", "SANDBOX_UNAVAILABLE"))


def _audit_evidence(text):
    """Same evidence normalization as core `behavior::normalize`."""
    return text.replace("\r", " ").replace("\n", " ")[:200]


def _audit_finding(rule, severity, category, entry, evidence, tool_name=None,
                   run_end_seq=None, use_turn_end=False):
    """Build the wire finding shape from a canonical timeline entry."""
    obs = entry["observation"]
    return {
        "rule": rule, "severity": severity, "category": category,
        "tool_name": tool_name, "evidence": _audit_evidence(evidence),
        "seq": obs.get("end_seq") if use_turn_end else entry.get("seq"),
        "time": obs.get("end_time") if use_turn_end else entry.get("time"),
        "turn": entry.get("turn"), "step": entry.get("step"),
        "call_id": entry.get("call_id"), "evidence_recency": "log",
        "run_end_seq": run_end_seq,
    }


def audit_projection(canonical):
    """Evaluate SV601–SV614 on a canonical session's timelines.

    This is a Python mirror of Rust's canonical dispatchers
    (`match_behavior_canonical` + `match_trajectory_canonical`), rather than a
    second rollout parser.  An empty required timeline is `unavailable`; a
    populated timeline with no match is `measured_zero`.  Harness-specific
    degradations (Claude's SV607/608) are applied by the caller, not here.
    """
    # CanonicalSession serializes timelines as top-level fields (the internal
    # Python representation mirrors that layout too).
    tls = canonical
    calls = tls["tool_calls"]["entries"]
    results = tls["tool_results"]["entries"]
    approvals = tls["approvals"]["entries"]
    sandbox = tls["sandbox_modes"]["entries"]
    turns = tls["turns"]["entries"]
    root = (canonical["meta"].get("workspace_roots") or [None])[0]
    root = root.rstrip("/") if isinstance(root, str) and root else None
    families = []

    def match_calls(code, severity, category, regex, names):
        findings = []
        for e in calls:
            obs = e["observation"]
            if obs.get("name") not in names:
                continue
            m = regex.search(obs.get("args_text", ""))
            if m:
                findings.append(_audit_finding(code, severity, category, e, m.group(0), obs["name"]))
        return findings

    families.extend([
        ("SV601", ["ToolCalls"], match_calls("SV601", "critical", "shell", _DESTRUCTIVE_RE, ("bash",))),
        ("SV602", ["ToolCalls"], match_calls("SV602", "warning", "shell", _PRIVILEGE_RE, ("bash",))),
        ("SV603", ["ToolCalls"], match_calls("SV603", "critical", "shell", _REMOTE_EXEC_RE, ("bash",))),
        ("SV604", ["ToolCalls"], match_calls("SV604", "critical", "sensitive-fs", _SENSITIVE_PATH_RE, ("write", "edit"))),
    ])
    fs605, fs606, fs607, fs608, fs609, fs610 = [], [], [], [], [], []
    for e in calls:
        obs, text = e["observation"], e["observation"].get("args_text", "")
        if obs.get("name") in ("write", "edit") and not _SENSITIVE_PATH_RE.search(text):
            m = _ABS_PATH_RE.search(text)
            if m and not (root and (m.group(0) == root or m.group(0).startswith(root + "/"))):
                fs605.append(_audit_finding("SV605", "warning", "sensitive-fs", e, m.group(0), obs["name"]))
        if obs.get("name") == "web_fetch":
            m = _INTERNAL_IP_URL_RE.search(text)
            if m:
                fs606.append(_audit_finding("SV606", "warning", "network", e, m.group(0), "web_fetch"))
    for e in results:
        code = e["observation"].get("error_code")
        if code in _DENIED_CODES:
            fs607.append(_audit_finding("SV607", "warning", "approval", e, code))
        if code == "TOOL_TIMEOUT":
            fs608.append(_audit_finding("SV608", "info", "approval", e, code))
    for e in approvals:
        asked = e["observation"].get("asked")
        if asked:
            fs609.append(_audit_finding("SV609", "info", "approval", e,
                                         asked.get("reason") or asked.get("tool_name") or "",
                                         asked.get("tool_name")))
        decided = e["observation"].get("decided")
        if decided and decided.get("outcome") == "allowed-once":
            fs610.append(_audit_finding("SV610", "warning", "approval", e, "allowed-once"))
    for e in sandbox:
        if e["observation"].get("mode") == "danger-full-access":
            fs610.append(_audit_finding("SV610", "warning", "approval", e, "danger-full-access"))
    families.extend((("SV605", ["ToolCalls"], fs605), ("SV606", ["ToolCalls"], fs606),
                     ("SV607", ["ToolResults"], fs607), ("SV608", ["ToolResults"], fs608),
                     ("SV609", ["ApprovalDecisions"], fs609), ("SV610", ["SandboxModes"], fs610)))

    # Trajectory family.  A harness with no approval lifecycle still gets the
    # evaluation retained here so a future adapter fills it without a new rule
    # path (SV614's a/b then run over empty approvals → MeasuredZero, c over
    # sandbox → runnable).
    fs611, fs612, fs613, fs614 = [], [], [], []
    prev, count, anchor = None, 0, None
    for e in calls:
        obs = e["observation"]; sig = (obs.get("name", ""), obs.get("args_text", ""))
        if sig == prev: count += 1
        else: prev, count, anchor = sig, 1, e
        if count >= 3 and count % 3 == 0:
            fs611.append(_audit_finding("SV611", "warning", "trajectory", anchor,
                                        "%s 连续重复 %d 次" % (anchor["observation"]["name"], count),
                                        anchor["observation"]["name"], e.get("seq")))
    prev_sig, loop_count = None, 0
    for e in turns:
        sig = e["observation"].get("sig") or []
        if not sig: continue
        if sig == prev_sig: loop_count += 1
        else: prev_sig, loop_count = sig, 1
        if loop_count == 2:
            fs612.append(_audit_finding("SV612", "warning", "trajectory", e,
                                        "死循环: turn %s 与上一 turn 动作序列相同" % e["observation"].get("turn"),
                                        run_end_seq=e["observation"].get("last_seq")))
    def flush_turn_run(run, anchor, last):
        if len(run) >= 2:
            code = anchor["observation"].get("end_error_code") or ""
            suffix = "（%s）" % code if code else ""
            fs613.append(_audit_finding("SV613", "warning", "trajectory", anchor,
                "进度停滞: 连续 %d 个 turn 以 error 结束%s" % (len(run), suffix),
                run_end_seq=last, use_turn_end=True))
    run, anchor, last = [], None, None
    for e in turns:
        obs = e["observation"]
        if obs.get("end_seq") is None: continue
        if obs.get("end_reason_kind") == "error":
            if not run: anchor = e
            run.append(e); last = obs.get("end_seq")
        else:
            flush_turn_run(run, anchor, last); run, anchor, last = [], None, None
    flush_turn_run(run, anchor, last)
    run, anchor, last = [], None, None
    def flush_fail_run():
        if len(run) >= 3:
            fs613.append(_audit_finding("SV613", "warning", "trajectory", anchor,
                "进度停滞: 连续 %d 个工具失败（首个 %s）" % (len(run), anchor["observation"].get("error_code") or ""),
                run_end_seq=last))
    for e in results:
        # 失败判据 = 原因码（DSH/Codex）**或** lossy 失败标志（Claude：is_error →
        # failed，error_code 恒 None 时该标志是唯一失败证据）。DSH/Codex 的 failed
        # 恒 None，布尔式退化成原 error_code 判定，golden 字节零漂移。
        if e["observation"].get("error_code") is not None or e["observation"].get("failed") is True:
            if not run: anchor = e
            run.append(e); last = e.get("seq")
        else:
            flush_fail_run(); run, anchor, last = [], None, None
    flush_fail_run()
    by_call = {}
    for e in approvals:
        if e["observation"].get("asked") and e.get("call_id"):
            by_call.setdefault(e["call_id"], []).append(e)
    for call_id in sorted(by_call):
        grouped = by_call[call_id]
        if len(grouped) >= 3:
            fs614.append(_audit_finding("SV614", "warning", "approval", grouped[0],
                "权限异常: 同一调用 %s 请求审批 %d 次" % (call_id, len(grouped))))
    rejected, anchor = 0, None
    for e in approvals:
        decided = e["observation"].get("decided")
        if not decided: continue
        if decided.get("outcome") == "rejected":
            if rejected == 0: anchor = e
            rejected += 1
            if rejected >= 3 and rejected % 3 == 0:
                fs614.append(_audit_finding("SV614", "warning", "approval", anchor,
                                            "权限异常: 连续 %d 次审批被拒" % rejected))
        else: rejected, anchor = 0, None
    danger = [e for e in sandbox if e["observation"].get("mode") == "danger-full-access"]
    if len(danger) >= 2:
        fs614.append(_audit_finding("SV614", "warning", "approval", danger[0],
                                    "权限异常: 危险模式 danger-full-access 授予 %d 次" % len(danger)))
    families.extend((("SV611", ["ToolCalls"], fs611), ("SV612", ["TurnBoundaries"], fs612),
                     ("SV613", ["TurnBoundaries", "ToolResults"], fs613),
                     ("SV614", ["ApprovalDecisions", "SandboxModes"], fs614)))

    timeline_for = {"ToolCalls": calls, "ToolResults": results, "TurnBoundaries": turns,
                    "ApprovalDecisions": approvals, "SandboxModes": sandbox}
    outcomes, findings = {}, []
    for code, requires, matched in families:
        missing = [s for s in requires if not timeline_for[s]]
        unavailable = len(missing) == len(requires) if code in ("SV613", "SV614") else bool(missing)
        if unavailable:
            outcomes[code] = {"status": "unavailable", "missing": missing,
                              "reason": "no evidence for required signal(s) in this session"}
        elif matched:
            outcomes[code] = {"status": "findings", "count": len(matched)}
            findings.extend(matched)
        else:
            outcomes[code] = {"status": "measured_zero"}
    # family ① retains event order; trajectory is rule order after it.
    first, tail = findings[:], []
    family1 = [f for f in first if f["rule"] <= "SV610"]
    trajectory = [f for f in first if f["rule"] > "SV610"]
    family1.sort(key=lambda f: (f["seq"] is None, f["seq"] if f["seq"] is not None else 2**63))
    findings = family1 + trajectory
    summary = {"critical": sum(f["severity"] == "critical" for f in findings),
               "warning": sum(f["severity"] == "warning" for f in findings),
               "info": sum(f["severity"] == "info" for f in findings),
               "findings_total": len(findings),
               "rules_unavailable": sum(v["status"] == "unavailable" for v in outcomes.values())}
    return {"summary": summary, "findings": findings, "rule_outcomes": outcomes}
