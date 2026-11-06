"""省钱方案 —— 把 scan 报告派生为量化、排序、诚实的动作清单（`agent-vitals plan`）。

与 `crates/agent-vitals-domain/src/domain/plan.rs` 的 `build_plan` **逐字节一致**（含 JSON
key 顺序与 rationale 文案），由 `tests/test_cli_matrix.py` 的 `both()` 差分看守，
同一 fixture 下同数字由 `tests/test_plan_lockstep.py` 交叉锁定。

诚实性规则（naive 实现为什么是错的）：
1. `savings_per_event` 永远是测量值（token，直接抄报告字段），不是估算。
2. `events_per_month` 只在真有"每月"数字时填 —— 只有用户 `--startup-rate` 提供
   （估算，不是测量）。`usage_count` 是**终身累计**（trigger_data 的 `counts_are`
   明写 lifetime cumulative），**绝不**冒充每月数 —— 拿终身数当成"每月"正是
   CLAUDE.md「缺列有用、编造有害」要拦的误标。终身数单独暴露为
   `measured_lifetime_triggers`。
3. `diagnosis_refs` 只引用 doctor 真实会发的 SV 码；量不到的维度给 `[]`。
4. 方案是提案：risk 排序只是建议阅读顺序，决定权留给人。

镜像语义注释：Rust 侧所有取数都走 `serde_json::Value::as_i64`/`as_bool`/`as_f64`
——**只认真正的 JSON 整数 / JSON true / JSON 数字**，float/bool/string/null 一律
按缺值处理（不 truthy 短路）。Python 侧 `json.loads` 给出 int/float/bool，下面
`_as_i64`/`_as_bool`/`_as_f64` 逐条复刻，避免中位数集合、loaded 判定、usage_count
取值在边缘类型上分叉。
"""

DEFAULT_SPLIT_THRESHOLD = 6000


def _as_i64(v):
    """镜像 Rust `Value::as_i64`：只有真正的 JSON 整数才返回；float/bool/str/None → None。"""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    return None


def _as_bool(v):
    """镜像 Rust `Value::as_bool`：只有 JSON true 为 True，其余全 False。"""
    return v is True


def _as_f64(v):
    """镜像 Rust `Value::as_f64`：JSON 数字（int 或 float）→ float；其余 → 0.0。"""
    if isinstance(v, bool):
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    return 0.0


def _skill_lookup(skills):
    """按 name 查 skills[]，**优先 loaded 副本**（同名在影子场景会出现多份）。
    两趟：先收 loaded，再补非 loaded。查不到返回 None —— 调用方把「查不到」与
    「测到 0」区分开：查不到 → null（没测到，不假装 0），测到 0 → 0。"""
    m = {}
    for sk in skills:
        name = sk.get("name") or ""
        if name and name not in m and _as_bool(sk.get("loaded")):
            m[name] = sk
    for sk in skills:
        name = sk.get("name") or ""
        if name and name not in m:
            m[name] = sk
    return m


def build_plan(report, startup_rate=None):
    """把 scan 报告派生为省钱方案。`startup_rate` 是用户估算的每月启动次数
    （`--startup-rate`），只有它能让 per-startup 项填上 `events_per_month`。"""
    harness = report.get("harness_selection") or ""

    # —— 各源区块（缺区一律当 unavailable / 空，绝不给假数据）——
    trigger = report.get("trigger_data") or {}
    trigger_available = _as_bool(trigger.get("available"))
    zombie_min_age = _as_i64(trigger.get("zombie_min_age_days")) or 0
    zombie_candidates = trigger.get("zombie_candidates") or []

    structure = report.get("structure") or {}
    split_threshold = _as_i64(structure.get("split_threshold_tokens")) or 0
    split_threshold = split_threshold if split_threshold > 0 else DEFAULT_SPLIT_THRESHOLD
    oversized = structure.get("oversized") or []

    # budget 状态只看 over_by_chars / pct_used 两个数：unavailable 时二者缺席归 0 →
    # trim 项 diagnosis_refs 空，正好不编码。
    description_budget = report.get("description_budget") or {}
    over_by = _as_i64(description_budget.get("over_by_chars")) or 0
    pct_used = _as_f64(description_budget.get("pct_used"))
    if over_by > 0:
        budget_refs = ["SV002"]
    elif pct_used >= 85.0:
        budget_refs = ["SV001"]
    else:
        budget_refs = []

    conflicts = report.get("conflicts") or []
    skills = report.get("skills") or []
    by_name = _skill_lookup(skills)

    items = []

    # —— disable-zombie：零触发的已装 skill，删掉每个启动都省 tier1 ——
    # 只有 trigger 证据 available 才生成；unavailable 报不了 0 次，宁可不生成。
    if trigger_available:
        for idx, z in enumerate(zombie_candidates):
            name = z.get("name") or ""
            tier1 = _as_i64(z.get("tier1_tokens")) or 0
            items.append({
                "id": "disable-zombie:%d" % idx,
                "kind": "disable-zombie",
                "skill": name,
                "risk": "low",
                "savings_per_event": {"tokens": tier1, "unit": "tokens", "per": "startup"},
                "events_per_month": startup_rate,
                "measured_lifetime_triggers": 0,
                "diagnosis_refs": ["SV201"],
                "rationale": ("0 lifetime triggers and >= %d days installed; disabling "
                              "removes %d resident tokens per startup."
                              % (zombie_min_age, tier1)),
            })

    # —— split-oversized：SKILL.md 主体超阈值，拆进 references 每次触发省差价 ——
    for idx, o in enumerate(oversized):
        name = o.get("name") or ""
        core = _as_i64(o.get("tier2_core_tokens")) or 0
        saved = max(core - split_threshold, 0)
        rec = by_name.get(name)
        lifetime = _as_i64(rec.get("usage_count")) if rec is not None else None
        items.append({
            "id": "split-oversized:%d" % idx,
            "kind": "split-oversized",
            "skill": name,
            "risk": "medium",
            "savings_per_event": {"tokens": saved, "unit": "tokens", "per": "trigger"},
            # usage_count 是终身数，绝不填进 events_per_month —— 那是月数。
            "events_per_month": None,
            "measured_lifetime_triggers": lifetime,
            "diagnosis_refs": ["SV301"],
            "rationale": ("SKILL.md is %d tokens (split threshold %d); moving non-essential "
                          "body to on-demand references saves %d tokens per trigger."
                          % (core, split_threshold, saved)),
        })

    # —— trim-description：loaded skill 的 tier1 高于 loaded 中位数，压到中位数 ——
    # 中位数是**测量锚**（不是拍脑袋的目标）；无 loaded skill 时中位数无定义 → 整块跳过。
    # 中位数集合只收"有真整数 tier1_tokens 的 loaded skill"（镜像 Rust filter_map + as_i64）。
    loaded_tier1 = sorted(
        t for sk in skills
        if _as_bool(sk.get("loaded"))
        for t in [_as_i64(sk.get("tier1_tokens"))] if t is not None
    )
    if loaded_tier1:
        median = loaded_tier1[(len(loaded_tier1) - 1) // 2]
        idx = 0
        for sk in skills:
            if not _as_bool(sk.get("loaded")):
                continue
            tier1 = _as_i64(sk.get("tier1_tokens")) or 0
            if tier1 <= median:
                continue
            saved = tier1 - median
            items.append({
                "id": "trim-description:%d" % idx,
                "kind": "trim-description",
                "skill": sk.get("name") or "",
                "risk": "low",
                "savings_per_event": {"tokens": saved, "unit": "tokens", "per": "startup"},
                "events_per_month": startup_rate,
                "measured_lifetime_triggers": None,
                "diagnosis_refs": list(budget_refs),
                "rationale": ("Description is %d tokens, above the median %d of your loaded "
                              "skills; shortening to the median saves %d resident tokens per "
                              "startup." % (tier1, median, saved)),
            })
            idx += 1

    # —— resolve-shadow：conflict 一致性项，没有可测的 token 收益，诚实不给 savings ——
    for idx, c in enumerate(conflicts):
        name = c.get("name") or ""
        kind = c.get("kind") or ""
        if kind == "shadowed_newer":
            refs = ["SV101"]
            rationale = ("A newer copy is shadowed by an older effective copy (SV101); "
                         "resolve which is authoritative. No measured token saving.")
        elif kind == "redundant":
            refs = ["SV102"]
            rationale = ("Two copies have identical content (SV102); remove the duplicate. "
                         "No measured token saving.")
        elif kind == "intentional_override":
            refs = ["SV103"]
            rationale = ("A deliberate override is in effect (SV103); listed for visibility, "
                         "no action required. No measured token saving.")
        else:
            refs = []
            rationale = "Conflict kind %s; no standard action. No measured token saving." % kind
        items.append({
            "id": "resolve-shadow:%d" % idx,
            "kind": "resolve-shadow",
            "skill": name,
            "risk": "medium",
            "savings_per_event": None,
            "events_per_month": None,
            "measured_lifetime_triggers": None,
            "diagnosis_refs": refs,
            "rationale": rationale,
        })

    # —— 确定性排序：risk 升序 → savings 降序（null 殿后）→ skill 名升序 ——
    # 镜像 Rust comparator 的语义：savings 维上 Some(x) 先于 None，Some 之间降序；
    # 全 None（无 savings 声称）只在 risk 之后用 skill 名决胜。list.sort 稳定，
    # 同 key 回到构造顺序，与 Rust `sort_by`（稳定）一致。
    risk_rank = {"low": 0, "medium": 1}

    def _key(it):
        sav = it["savings_per_event"]
        tokens = _as_i64(sav.get("tokens")) if sav is not None else None
        return (risk_rank.get(it["risk"], 2),
                tokens is None,
                -(tokens if tokens is not None else 0),
                it["skill"])

    items.sort(key=_key)

    # —— summary：只给 item 数与 top 3，绝不汇总 token —— per-startup 与 per-trigger
    #    单位不可通约，相加就是拿不同度量拼一个假总数。
    item_count = len(items)
    savings_items = sum(1 for it in items if it["savings_per_event"] is not None)
    top_3 = [it["id"] for it in items[:3]]

    # 顶层 diagnosis_refs：全 items 的并集，排序去重。
    all_refs = sorted({r for it in items for r in it["diagnosis_refs"]})

    return {
        "schema_version": "plan/1.0",
        "harness_selection": harness,
        "startup_rate_per_month": startup_rate,
        "diagnosis_refs": all_refs,
        "items": items,
        "summary": {
            "item_count": item_count,
            "savings_items": savings_items,
            "top_3_moves": top_3,
        },
    }
