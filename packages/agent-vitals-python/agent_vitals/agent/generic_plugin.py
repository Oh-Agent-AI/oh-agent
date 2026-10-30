"""generic 插件执行环境 validate 编排（HARNESS_MANIFEST_DSL_SPEC §5-§6）。

`agent_vitals_runtime::plugin_ingest` 的 Python twin——**只读 validate 面**
（Python 不长 writer，与 workbuddy-usage-facts 的 --write 同一条纪律；
Rust-only 的 plugin-ingest --write 是唯一的落盘路径）。

负载键序 = Rust serde 字段声明序（golden parity 的字节前提）：
mode/gate/gate_problem/report/facts，report 内 slug→harness→recipe→…
"""

import hashlib
import json
import os

from .generic_manifest import load_manifest
from .generic_recipe import (SLOT_EVENT_TS, check_overrides, dotted_get,
                             effective_path, extract_line, glob_match,
                             recipe_def)
from .usage_fact import build_usage_fact


def _sha256_hex16(data):
    return hashlib.sha256(data).hexdigest()[:16]


def _source_profile_for_root(slug, root_declared):
    digest = hashlib.sha256(("%s|%s" % (slug, root_declared)).encode("utf-8")).hexdigest()
    return "harness-%s" % digest[:8]


def _expand_tilde_home(path, home):
    if path.startswith("~/"):
        return os.path.join(str(home), path[2:])
    if path == "~":
        return str(home)
    return path


def _read_source_text(manifest, path):
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        raise OSError("文件 `%s` 不可读：%s" % (path, exc))
    if manifest.compression == "zstd":
        from ..adapters.dsh import _zstd, decode_zstd_multi_frame
        if _zstd() is None:
            raise Exception("文件 `%s` 需要可选 Python zstandard 包" % path)
        data = decode_zstd_multi_frame(data)
        if data is None:
            raise Exception("文件 `%s` zstd 解压失败" % path)
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise Exception("文件 `%s` 不是 UTF-8" % path)


def _discover_files(manifest, home):
    """discovery twin：walkdir 排序去重 + symlink 内外判 + session 提取。"""
    files = []
    session_unmatched = 0
    symlink_outside = 0
    seen = set()
    for root_raw in manifest.roots:
        root = _expand_tilde_home(root_raw, home)
        root_canon = os.path.realpath(root)
        if not os.path.isdir(root_canon):
            raise Exception("discovery 失败：discovery.roots `%s` 不可访问" % root_raw)
        for dirpath, dirnames, filenames in os.walk(root_canon, followlinks=False):
            # 排序保证确定性（Rust walkdir 顺序不进契约——排序键是 rel_path）。
            dirnames.sort()
            for name in sorted(filenames):
                abs_path = os.path.join(dirpath, name)
                rel = os.path.relpath(abs_path, root_canon).replace(os.sep, "/")
                if not manifest.include or not any(
                        glob_match(g, rel) for g in manifest.include):
                    continue
                if os.path.islink(abs_path):
                    canon = os.path.realpath(abs_path)
                    if not canon.startswith(root_canon + os.sep) and canon != root_canon:
                        symlink_outside += 1
                        continue
                    if not os.path.isfile(canon):
                        continue
                else:
                    canon = abs_path
                caps = manifest.session_pattern.search(name)
                # Rust `captures` 与 Python `search` 在同一受限子集下等价：
                # 锚定 pattern 由安装期校验者自己写，引擎语义在该子集内一致。
                if caps is None or "id" not in caps.groupdict():
                    session_unmatched += 1
                    continue
                canon_key = os.path.realpath(canon)
                if canon_key in seen:
                    continue
                seen.add(canon_key)
                files.append((rel, canon, caps.group("id")))
    files.sort()
    return files, session_unmatched, symlink_outside


def _candidate_to_fact_fields(ctx, source_profile, native_session_id,
                              candidate, event_ts_raw):
    defn, manifest, revision, machine_namespace = (
        ctx["def"], ctx["manifest"], ctx["revision"], ctx["machine_namespace"])
    fields = {
        "machine_namespace": machine_namespace,
        "harness": manifest.facts_harness,
        "source_profile": source_profile,
        "native_session_id": native_session_id,
        "source_event_id": candidate["source_event_id"],
        "observation_kind": defn.observation_kind,
        "identity_basis": "native",
        "event_ts_utc": event_ts_raw,
        "event_tz_basis": None,
        "time_basis": "native",
        "source_usage_semantics": defn.source_usage_semantics,
        "source_revision": revision,
        "adapter_version": defn.id,
        "model_raw": candidate["model_raw"],
        "provider_raw": candidate["provider_raw"],
        "provider_request_id": candidate["provider_request_id"],
        "uncached_input_tokens": candidate["uncached_input_tokens"],
        "cache_read_tokens": candidate["cache_read_tokens"],
        "cache_write_tokens": candidate["cache_write_tokens"],
        "output_tokens": candidate["output_tokens"],
        "billing_source": None,
        "billing_mode": "metered",
        "pricing_basis": "metered_estimate",
        "evidence_basis": ("session-native" if candidate["provider_raw"] is not None
                           else "missing"),
    }
    return fields


def _extract_file(ctx, source_profile, rel_path, abs_path, session_id, content):
    manifest = ctx["manifest"]
    defn = ctx["def"]
    report = {
        "rel_path": rel_path,
        "abs_path": abs_path,
        "session_id": session_id,
        "emitted": 0,
        "skipped": 0,
        "invalid": 0,
        "invalid_problems": [],
        "zero_target": False,
        "failed": False,
        "problems": [],
    }
    facts = []
    for line in content.splitlines():
        line = line.strip()
        if line == "":
            continue
        try:
            record = json.loads(line)
        except ValueError:
            report["invalid"] += 1
            if len(report["invalid_problems"]) < 8:
                report["invalid_problems"].append(
                    "bad_json: %s" % line[:120])
            continue
        ts_raw = dotted_get(
            record, effective_path(defn, manifest, SLOT_EVENT_TS))
        ts_raw = ts_raw if isinstance(ts_raw, str) else ""
        verdict = extract_line(defn, manifest, record)
        if verdict[0] == "emit":
            fields = _candidate_to_fact_fields(
                ctx, source_profile, session_id, verdict[1], ts_raw)
            try:
                built = build_usage_fact(fields)
            except ValueError as e:
                # contract 层拒绝如实计数（与 Rust 同款，问题样例 ≤8 条）。
                report["invalid"] += 1
                if len(report["invalid_problems"]) < 8:
                    report["invalid_problems"].append(
                        "contract: %s" % "; ".join(e.args[0]))
            else:
                facts.append(built)
                report["emitted"] += 1
        elif verdict[0] == "skip":
            report["skipped"] += 1
        else:
            report["invalid"] += 1
            if len(report["invalid_problems"]) < 8:
                report["invalid_problems"].append(
                    "%s: %s" % (verdict[1], verdict[2]))
    if report["emitted"] == 0 and report["invalid"] == 0:
        report["zero_target"] = True
    if report["emitted"] > manifest.max_rows_per_file:
        report["failed"] = True
        report["problems"].append(
            "行数超限：%d > %d（§6.4 整文件失败，不提交部分事实）"
            % (report["emitted"], manifest.max_rows_per_file))
        facts = []
        report["emitted"] = 0
    return report, facts


def run_plugin(manifest_path, files, machine_namespace, home):
    manifest, revision = load_manifest(manifest_path)
    defn = recipe_def(manifest.recipe)
    if defn is None:
        raise Exception("未知 recipe `%s`" % manifest.recipe)
    problem = check_overrides(defn, manifest)
    if problem is not None:
        raise Exception("overrides 校验失败：%s" % problem)

    if files:
        units = []
        for path in files:
            abs_path = os.path.realpath(str(path))
            name = os.path.basename(abs_path)
            caps = manifest.session_pattern.search(name)
            if caps is None or "id" not in caps.groupdict():
                raise Exception("文件 `%s` 不匹配 session.pattern" % name)
            # fixture 模式 profile 固定（跨机 golden 可复现）。
            profile = _source_profile_for_root(manifest.slug, "<fixture>")
            units.append((name, abs_path, caps.group("id"), profile))
    else:
        units = []
        found, _unmatched, _outside = _discover_files(manifest, home)
        for rel, abs_path, session_id in found:
            root_declared = ""
            for r in manifest.roots:
                expanded = _expand_tilde_home(r, home)
                if abs_path.startswith(os.path.realpath(expanded) + os.sep):
                    root_declared = r
                    break
            profile = _source_profile_for_root(manifest.slug, root_declared)
            units.append((rel, abs_path, session_id, profile))
    units.sort(key=lambda u: u[0])

    ctx = {"def": defn, "manifest": manifest, "revision": revision,
           "machine_namespace": machine_namespace}

    report = {
        "slug": manifest.slug,
        "harness": manifest.facts_harness,
        "recipe": defn.id,
        "manifest_revision": revision,
        "files": [],
        "emitted": 0,
        "skipped": 0,
        "invalid": 0,
        "failed_files": 0,
        "fact_id_stable": False,
        "date_min_utc_ms": None,
        "date_max_utc_ms": None,
        "models": [],
        "corpus_has_emit": False,
        "warnings": [],
    }
    facts_out = []
    for rel, abs_path, session_id, profile in units:
        content = _read_source_text(manifest, abs_path)
        file_report, file_facts = _extract_file(
            ctx, profile, rel, abs_path, session_id, content)
        report["emitted"] += file_report["emitted"]
        report["skipped"] += file_report["skipped"]
        report["invalid"] += file_report["invalid"]
        report["failed_files"] += 1 if file_report["failed"] else 0
        report["corpus_has_emit"] = report["corpus_has_emit"] or file_report["emitted"] > 0
        report["files"].append(file_report)
        facts_out.extend(file_facts)

    # 跨 root 同 session 多 profile 警示（与 Rust 同语序/同文案）。
    by_session = {}
    for _rel, _abs, session_id, profile in units:
        by_session.setdefault(session_id, set()).add(profile)
    for session_id in sorted(by_session.keys()):
        profiles = by_session[session_id]
        if len(profiles) > 1:
            report["warnings"].append(
                "session `%s` 出现在 %d 个 source_profile 下（跨 root）——"
                "facts JSONL 按 profile 分行，authority 按 harness+session 身份去重合并"
                % (session_id, len(profiles)))

    # 汇总：日期范围 + 模型清单。
    models = set()
    for f in facts_out:
        ts = f.get("event_ts_utc")
        if isinstance(ts, str):
            parsed = _parse_iso_safe(ts)
            if parsed is not None:
                ms = parsed * 1000
                report["date_min_utc_ms"] = (ms if report["date_min_utc_ms"] is None
                                             else min(report["date_min_utc_ms"], ms))
                report["date_max_utc_ms"] = (ms if report["date_max_utc_ms"] is None
                                             else max(report["date_max_utc_ms"], ms))
        if isinstance(f.get("model_raw"), str):
            models.add(f["model_raw"])
    report["models"] = sorted(models)

    # fact_id 稳定性（§6.5）：重放两遍 id 序列比对。
    ids_once = [f["fact_id"] for f in facts_out]
    ids_again = []
    for rel, abs_path, session_id, profile in units:
        try:
            content = _read_source_text(manifest, abs_path)
        except OSError:
            continue
        _, facts2 = _extract_file(ctx, profile, rel, abs_path, session_id, content)
        ids_again.extend(f["fact_id"] for f in facts2)
    report["fact_id_stable"] = ids_once == ids_again

    # 负载里不含 abs_path（§6.3 redacted 面纪律）。
    for file_report in report["files"]:
        file_report.pop("abs_path", None)
    return report, facts_out


def _parse_iso_safe(ts):
    from .claude_evidence import parse_iso
    parsed = parse_iso(ts)
    return None if parsed is None else parsed[0]


def validate_gate(report):
    if not report["fact_id_stable"]:
        return ("fact_id 稳定性检查失败：同文件重放两遍 id 序列不一致——"
                "检查 event_key 是否稳定（§6.5）")
    if report["failed_files"] > 0:
        return "%d 个文件行数超限整文件失败（§6.4）——调低 limits 或修 recipe" \
               % report["failed_files"]
    if not report["corpus_has_emit"]:
        return ("首装 format guard：整个 corpus 零 emit（§4.3）——include 或 "
                "recipe discriminator 与数据不匹配")
    return None


def plugin_validate_payload(manifest_path, files, machine_namespace, home):
    """plugin-validate 的完整 JSON 负载（与 Rust CLI 同键序）。"""
    try:
        report, facts = run_plugin(manifest_path, files, machine_namespace, home)
    except Exception as e:  # noqa: BLE001 —— 错误串是 payload 的一部分
        return {"mode": "validate", "error": str(e)}
    gate = validate_gate(report)
    return {
        "mode": "validate",
        "gate": "pass" if gate is None else "refuse",
        "gate_problem": gate,
        "report": report,
        "facts": facts,
    }
