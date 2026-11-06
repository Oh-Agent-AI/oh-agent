"""Pure report-to-report comparison."""

from .overlap import DEFAULT_OVERLAP_MIN, overlap_pairs


def _sorted_keys(keys):
    return sorted(keys, key=lambda key: tuple("" if item is None else item for item in key))


def _diff_entry(key):
    harness, instance_id, namespace, name = key
    return {"harness": harness, "instance_id": instance_id,
            "namespace": namespace, "name": name}


def _overlap_keys(report, minimum):
    output = set()
    for pair in overlap_pairs(report, minimum):
        output.add(tuple(sorted((pair["a"], pair["b"]))))
    return output


def _budget_delta(previous_budget, now_budget):
    """预算字符数的增量。任一侧拿不到就返回 None —— 见调用处的注释。"""
    before = previous_budget.get("used_chars")
    after = now_budget.get("used_chars")
    if before is None or after is None:
        return None
    return after - before


def compare_reports(previous, now, overlap_min=DEFAULT_OVERLAP_MIN,
                    baseline_file=None):
    """Compare two already-loaded reports without external reads or writes."""
    def loaded_map(document):
        return {(skill.get("harness_family") or skill.get("harness"), skill.get("instance_id"),
                 skill.get("namespace") or "", skill["name"]): skill
                for skill in document.get("skills", []) if skill.get("loaded")}

    before, after = loaded_map(previous), loaded_map(now)
    previous_budget = previous.get("description_budget", {}) or {}
    now_budget = now.get("description_budget", {}) or {}
    usage_delta = []
    for key in _sorted_keys(set(before) & set(after)):
        delta = (after[key].get("usage_count", 0) -
                 before[key].get("usage_count", 0))
        if delta:
            usage_delta.append({"name": key[-1], "harness": key[0],
                                "instance_id": key[1], "namespace": key[2],
                                "delta": delta,
                                "now": after[key].get("usage_count", 0)})
    usage_delta.sort(key=lambda item: -item["delta"])

    newly_judgeable = [
        {"name": key[-1], "harness": key[0], "instance_id": key[1],
         "namespace": key[2], "usage_count": after[key].get("usage_count", 0),
         "installed_days_ago": after[key].get("installed_days_ago"),
         "verdict": "zombie" if after[key].get("usage_count", 0) == 0 else "alive"}
        for key in _sorted_keys(set(before) & set(after))
        if (before[key].get("installed_days_ago", 0) < previous.get("trigger_data", {})
            .get("zombie_min_age_days", 14)
            <= after[key].get("installed_days_ago", 0))
    ]

    def security_keys(document):
        output = set()
        for skill in document.get("security", {}).get("flagged", []):
            for finding in skill.get("findings", []):
                output.add((skill["name"], finding.get("rule"),
                            finding.get("where"), finding.get("line")))
        return output

    new_security = sorted(security_keys(now) - security_keys(previous))
    try:
        new_pairs = sorted(_overlap_keys(now, overlap_min) -
                           _overlap_keys(previous, overlap_min))
    except (KeyError, TypeError):
        new_pairs = []

    return {
        "baseline_file": str(baseline_file) if baseline_file is not None else None,
        "added_skills": [_diff_entry(key) for key in
                         _sorted_keys(set(after) - set(before))],
        "removed_skills": [_diff_entry(key) for key in
                           _sorted_keys(set(before) - set(after))],
        "usage_delta": usage_delta,
        "newly_judgeable": newly_judgeable,
        # **两边都没有预算数据时是 null，不是 0。**`.get(k, 0)` 对「键存在但
        # 值为 None」拿不到默认值 —— Python 因此在 `--harness all`（默认执行环境！）
        # 下 `None - None` 崩溃，Rust 则把它当成 0，报出一个「预算没变化」的
        # 结论，而真相是「这个执行环境根本没有预算这个概念」。
        "budget_delta_chars": _budget_delta(previous_budget, now_budget),
        "budget_pct_then_now": [previous_budget.get("pct_used"),
                                now_budget.get("pct_used")],
        "loaded_then_now": [len(before), len(after)],
        "new_overlap_candidates": [list(key) for key in new_pairs],
        "new_security_findings": [
            {"skill": key[0], "rule": key[1], "where": key[2], "line": key[3]}
            for key in new_security],
        "note": "usage_delta is the trigger-count change between scans. newly_judgeable contains "
                "skills that were too new before but now meet the age gate.",
    }
