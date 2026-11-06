
#!/usr/bin/env python3
"""
扫描本机各 Agent 执行环境的 skill 安装目录，输出成本清单（JSON）。

只做确定性统计，不做判断。判断交给调用它的 Agent。

关键设计：**按执行环境隔离「装在磁盘上」和「真的进了上下文」**。
不同执行环境的 skill 绝不能合并计算上下文预算或覆盖冲突。

用法:
    python3 scan.py                    # 扫描默认路径
    python3 scan.py --path <dir> ...   # 追加自定义路径
    python3 scan.py --json out.json    # 写入文件
    python3 scan.py --all              # 预算按磁盘上所有 skill 算（诊断用，默认只算已加载）
"""

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

from agent_vitals import __version__
from agent_vitals import behavior as behavior_module
from agent_vitals import codex_cost as codex_cost_module
from agent_vitals import codex_evidence as codex_evidence_module
from agent_vitals import codex_usage as codex_usage_module
from agent_vitals import cost as cost_module
from agent_vitals.doctor import _doctor_snapshot, diagnose, render_doctor, render_gate
from agent_vitals.explain import render_explain
from agent_vitals import harness_capability as harness_capability_module
from agent_vitals.inventory import build_inventory
from agent_vitals.lifecycle import render_list
from agent_vitals.overlap import DEFAULT_OVERLAP_MIN, render_overlap
from agent_vitals.paths import data_home
from agent_vitals.plan import build_plan
import agent_vitals.redact as redact_module
from agent_vitals.report import build_report
import agent_vitals.security as security_module
from agent_vitals.snapshots import SNAPSHOT_KEEP, diff_against, latest_snapshot, render_diff, render_snapshot
from agent_vitals import state as state_module
from agent_vitals import usage as usage_module
from agent_vitals import budget as budget_module
from agent_vitals import takeover as takeover_module

# Windows services and CI runners may expose cp1252 consoles. Reports and
# diagnostics are bilingual, so make redirected and interactive output stable.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# 输出 JSON 的 schema 版本。**与工具版本无关**：工具可以升版而 schema 不变，
# schema 也可以在工具小版本里升主版本。
#
# 兼容性策略见 ARCHITECTURE §2.3：字段只增不删不改语义，破坏性变更升主版本。
#
# 「1.0」是**第一个带版本号的版本**。在它之前的输出没有版本字段 —— 那段时间
# schema 改过好几次（新增 unreadable_skills、runtime_verified_* 由 0 改为 null、
# WorkBuddy 口径变更），下游无法区分自己拿到的是哪一版。**没有版本号的
# schema 等于没有契约**，这笔账早该还。
SCHEMA_VERSION = "1.0"

# Claude Code 的 skill/命令描述总预算。默认约 15000 字符（≈4000 token）。
# 超出后描述被静默丢弃，无任何告警。可用 SLASH_COMMAND_TOOL_CHAR_BUDGET 调大。
# 不同版本口径不一（另有"上下文窗口 1%"的说法），故做成可配置。
DEFAULT_DESC_BUDGET = int(os.environ.get("SLASH_COMMAND_TOOL_CHAR_BUDGET", 15000))
CODEX_FALLBACK_DESC_BUDGET = 8000

# 判定「僵尸」前至少要装够这么多天。装了一天就说零触发没有意义。
ZOMBIE_MIN_AGE_DAYS = 14

# 各执行环境的常见 skill 目录。找不到的会被静默跳过。
# 同一个 harness 的多个根目录按该执行环境的优先级归类，绝不跨执行环境比较。
DEFAULT_ROOTS = [
    ("claude-code", "./.claude/skills"),
    ("claude-code", "~/.claude/skills"),
    ("claude-code-plugins", "~/.claude/plugins"),
    ("codex", "~/.codex/skills"),
    ("openclaw", "./skills"),
    ("openclaw", "./.agents/skills"),
    # DSH 的 discovery roots（契约 §DSH，层内 rank 越小越优先）。~/.agents/skills
    # 与 OpenClaw 共享，但两边要按各自的 rank 归类，绝不跨执行环境合并判定。
    ("dsh", "./.dsh/skills"),
    ("dsh", "./.agents/skills"),
    ("dsh", "~/.dsh/skills"),
    ("dsh", "~/.agents/skills"),
    ("hermes", "~/.hermes/skills"),
    ("workbuddy", "./.codebuddy/skills"),
    ("workbuddy", "./.workbuddy/skills"),
    ("workbuddy", "~/.workbuddy/skills"),
    ("cc-switch", "~/.cc-switch/skills"),
    ("cursor", "~/.cursor/skills"),
    ("gemini-cli", "~/.gemini/skills"),
    ("opencode", "~/.opencode/skills"),
]

# ── 主流程 ───────────────────────────────────────────────

def _doctor_gate(out, args, auto_snapshot, baseline):
    """doctor 文本流：报告 → 闸门 → 快照，返回退出码。

    顺序有讲究：闸门结论要紧跟报告（读者刚看完发现），存档放最后（它是
    副作用，不是结论）。快照写失败不影响闸门的退出码 —— 一个写不了快照的
    CI runner 不该因此把构建判成通过或失败。
    """
    ds = diagnose(out, args.split_threshold, args.min)

    base_ds = None
    if getattr(args, "new_only", False):
        if not baseline:
            print("--new-only needs a baseline: run `agent-vitals snapshot` first, "
                  "or specify one with --baseline.", file=sys.stderr)
            return 2
        try:
            with open(baseline, encoding="utf-8") as fp:
                prev = json.load(fp)
        except (OSError, ValueError):
            print("--new-only could not read baseline %s" % str(baseline), file=sys.stderr)
            return 2
        # 在基线文档上重跑同一个 diagnose。它是纯函数，这一步不需要任何
        # 额外的「历史诊断」存储，也就不会与快照的内容脱节。
        base_ds = diagnose(prev, args.split_threshold, args.min)

    ignore = [x.strip().upper() for x in args.ignore.split(",") if x.strip()]
    text, code = render_gate(ds, args.fail_on, ignore, base_ds)
    print(text, end="")
    _doctor_snapshot(out, auto_snapshot)
    return code


def _codex_rollout_signature(files):
    """rollout 文件清单 → 折叠缓存签名 `[(path, size, mtime_ns), ...]`。

    排序保证确定性（`codex_rollout_files` 本身有序，但签名是独立契约）。
    `st_mtime_ns` 纳秒级——内容被追加/替换必然改变（用 `touch -r` 伪造同
    mtime 是对抗性的，不在折叠缓存的威胁模型里；真机复读同一文件靠
    `codex_fold_file` 的 total 签名去重兜底，缓存只在文件**没变**时命中）。
    签名用**list 而非 tuple**：JSON 序列化后 tuple 变 list，读回时
    `tuple != list` 恒不等，缓存永远不会命中（上面这个 bug 就是那一步踩的）。
    """
    return [
        [str(p), p.stat().st_size, p.stat().st_mtime_ns]
        for p in sorted(files, key=lambda p: str(p))
    ]


# 折叠缓存算法版本。签名只含 (path, size, mtime_ns)——代码改了折叠算法而
# 源文件没动时，光靠签名命中会把旧算法的 fold 当新结果读出来。2026-08-29
# codex_hour_of 从「UTC 前缀」改成「北京时间（+8）」就把小时键全变了，任何
# v1 缓存的 UTC 键 fold 都是错的——升 v2 强制失效重扫。以后动折叠语义（小时
# 归属、去重、桶字段）记得再升。
_CODEX_FOLD_CACHE_VERSION = 2


def _codex_fold_cache_path():
    """折叠缓存文件路径（`$AGENT_VITALS_HOME/cache/codex-fold.json`）。

    `state.cache_dir()` 建目录失败（只读文件系统）会抛 —— 调用方捕获后
    直接重扫，缓存是性能优化不是正确性依赖。
    """
    return state_module.cache_dir() / "codex-fold.json"


def _read_codex_fold_cache(signature):
    """读缓存：签名全等 + 能解析 → fold；否则 None（当没有缓存）。

    JSON 解析失败（崩溃留下半文件）或字段缺失 → None → 重扫自愈。返回的
    fold 与重扫结果逐字节相同（纯 memo），差分门不受命中与否影响。
    """
    path = _codex_fold_cache_path()
    if not path.is_file():
        return None
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if cached.get("version") != _CODEX_FOLD_CACHE_VERSION or \
            cached.get("signature") != signature:
        return None
    fold = cached.get("fold")
    return fold if isinstance(fold, dict) else None


def _write_codex_fold_cache(signature, merged):
    """原子写折叠缓存：先写 `.tmp` 再 `os.replace`，崩溃留半文件 → 下次读
    JSON 解析失败 → 当没有缓存重扫（自愈）。任何失败都吞掉——缓存写不进去
    只意味着下次重扫，不改变输出。"""
    path = _codex_fold_cache_path()
    payload = json.dumps(
        {"version": _CODEX_FOLD_CACHE_VERSION, "signature": signature,
         "fold": merged},
        ensure_ascii=False)
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


def codex_fold_merged(use_cache=True):
    """扫描所有 codex rollout（live + archived）→ 逐文件折叠 → 合并成一份 fold。

    codex-cost handler 与 `_render_calendar_html`/`_render_codex_cost_html`
    （统一看板）共用同一份——看板要出 3 个视图（today/month/all），折叠只跑
    一遍。两处各写一遍就会有一处忘了「过滤后按模型重算」的 defect
    （`codex_by_model_from_hours`，见 `codex_cost_report` 文档）。

    瓶颈是**解析**不是折叠（真机 51 份 rollout ≈ 600MB JSONL ≈ 38s，单份
    210MB 解析 16s、折叠 0.04s）——日历/oneline 每次刷新都重扫会砸穿 xbar
    tick（`docs/UNIFIED_COST_VIEW.md` 的 `$STATE_DIR` 快照延迟项，现在兑现）。
    这里做**整折叠 memo**：签名 = (path, size, mtime_ns) 全等则命中，不等则
    重扫并原子覆写。纯 memo——命中与否输出逐字节相同，差分门不受影响。
    """
    from agent_vitals.adapters import codex_session
    files = codex_session.codex_rollout_files()
    if use_cache:
        try:
            sig = _codex_rollout_signature(files)
            cached = _read_codex_fold_cache(sig)
            if cached is not None:
                return cached
        except OSError:
            # 目录建不出来/stat 失败 —— 当没有缓存，直接重扫。
            sig = None
    else:
        sig = None
    folds = []
    for path in files:
        parsed = codex_session.read_codex_session_log(path)
        items = parsed["items"] if isinstance(parsed.get("items"), list) else []
        folds.append(codex_usage_module.codex_fold_file(items))
    merged = codex_usage_module.codex_merge_folds(folds)
    if sig is not None:
        _write_codex_fold_cache(sig, merged)
    return merged


def codex_report_from_merged(merged, filter_key, month_out, want_hours):
    """从已折叠合并的 fold 出一个 `--json` 报告 dict（harness/currency/month/today
    外层包装 + report 键）。filter_key=None 不过滤（all 视图）；`--today` 时
    want_hours=True（小时热力图数据）。空折叠给全零结构而不是 None——调用方
    要的是「没有数据」而不是「崩了」，且包装是固定契约（unaccounted/plan
    必须透传，它们无时间归属、不随月过滤）。
    """
    by_hour_model = merged["by_hour_model"]
    by_model = merged["by_model"]
    if filter_key:
        by_hour_model = {h: bm for h, bm in by_hour_model.items()
                         if h.startswith(filter_key)}
        # 重算模型轴：merge 的 by_model 只读 fold 的 by_model 字段，不读
        # by_hour_model——拿 merge 折回去得到的是空模型轴（真实 defect：
        # --month 整份报告静默变全零）。codex_by_model_from_hours 把过滤后
        # 的小时桶求和折回 by_model（守恒：sum(days) == total_cost_usd）。
        by_model = codex_usage_module.codex_by_model_from_hours(by_hour_model)
    pricing = codex_cost_module.load_codex_pricing()
    report = codex_cost_module.codex_cost_report(
        by_hour_model, by_model, merged["unaccounted"], merged["plan"],
        pricing, want_hours=want_hours)
    if report is None:
        report = {
            "total_cost_usd": 0,
            "total_tokens": {f: 0 for f in codex_usage_module.CODEX_TOKEN_FIELDS},
            "per_model": {}, "days": [], "unpriced_tokens": 0,
            "unaccounted_usage": merged["unaccounted"],
            "plan": merged["plan"],
        }
        if want_hours:
            report["hours"] = []
    out = {"harness": "codex", "currency": "USD", "month": month_out,
           "today": codex_cost_module.today_beijing()}
    out.update(report)
    return out


def codex_calendar_blob(merged, month_key, month_out, default):
    """统一看板内联的 codex 规范单块（docs/UNIFIED_COST_VIEW.md 的 1 号执行环境
    契约）：{harness, currency, today, default, views:{today,month,all}}。每个 view
    即 `codex_report_from_merged` 的一个报告。today 视图 want_hours=True；
    month 视图用调用方给的 month_key/month_out（统一看板 = 当前月，codex-cost
    --html = 请求月）；all 视图不过滤。default = 无 `?file=` 时打开的视图。
    """
    today = codex_cost_module.today_beijing()
    views = {
        "today": codex_report_from_merged(merged, today, today[:7], True),
        "month": codex_report_from_merged(merged, month_key, month_out, False),
        "all": codex_report_from_merged(merged, None, None, False),
    }
    return {"harness": "codex", "currency": "USD", "today": today,
            "default": default, "views": views}


def _render_calendar_html(output_path, default_source="month"):
    """把 today.json / month.json 渲染成单文件日历 HTML，写到 output_path。

    `calendar` 子命令与 `oneline`（每次跑完顺手刷新
    `$STATE_DIR/calendar.html`，给 xbar「打开日历」菜单项用）共用同一份
    逻辑——两处各写一份，字段名/转义稍有出入就会一个能打开一个打不开，
    多一份要维护的复制代码。

    两个 tab（today / month）都内联进同一个文件，各自一个
    `<script id="agent-vitals-data-{mode}">` 块——只内联 `--source`
    选中的那一份会导致点另一个 tab 没反应或被误判成另一种 schema 硬渲染
    出一张空图（真实 bug，用户点 today tab 复现过）。**每个 mode 独立
    判断有没有数据**——today.json 不存在就不内联那个块，那个 tab 落到
    JS 的 empty-state，不影响 month 那个块正常渲染，反之亦然。

    `default_source` 决定「没有 `?file=` 时默认显示哪个 tab」，通过注入
    `window.AGENT_VITALS_DEFAULT_MODE` 传给模板 JS。

    内联进 `<script>` 的 JSON 不是 state 文件的原始字节——`_augment_
    calendar_cost` 会先给有 `by_model` 的桶/日子塞一个按真实模型精算的
    `cost` 字段（复用 `cost.py::cost_report`，不是模板自己那份
    deepseek-v4-flash 近似），让日历页的数字能和 `budget show`/xbar
    菜单栏对上，而不是各算各的（这正是之前那次「UI 显示 ¥1.20 但
    behavior --json 报 ¥1.35」类漂移的根因）。写到 sidecar 副本（file
    picker fallback 用）的还是原始字节，不带这个额外字段——那份要跟
    state.py 的 schema 契约保持字面一致。

    返回 `(embedded_modes, output_path)`；`embedded_modes` 为空列表表示
    两份 state 文件都不存在，HTML 仍会写出，JS 会显示空态而不是报错。
    """
    template = Path(__file__).resolve().parents[3] / "assets" / "templates" / "calendar.html"
    if not template.is_file():
        raise FileNotFoundError(
            "calendar template not found at %s (run M4 first)" % template)
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    html = template.read_text(encoding="utf-8")
    pricing = cost_module.load_pricing()
    embedded = []
    for mode, src_name in (("today", "today.json"), ("month", "month.json")):
        src = state_module.state_dir() / src_name
        if not src.is_file():
            continue
        json_text = src.read_text(encoding="utf-8")
        embed_text = json_text
        try:
            data = json.loads(json_text)
        except (json.JSONDecodeError, ValueError):
            data = None
        if isinstance(data, dict):
            # today.json 的 `date` 必须真的是今天——同一个 bug 之前只在
            # budget.compute_today_cost() 修过（菜单栏），这里是**另一个
            # 读者**：`rotate_today()` 只在 merge_today() 开头被调用，今天
            # 一次 DSH 会话都没跑时 today.json 会原封不动停在最后一次有
            # 会话的那天。不校验的话,日历「今天 24 小时」tab 会把昨天的
            # 24 小时桶原样画出来,标成"今天"——真机复现：2026-08-27 当天
            # 没用过 DSH，日历仍在展示 08-26 的热力图。
            #
            # 处理方式与「today.json 不存在」完全一致（见本函数文档：
            # 「today.json 不存在就不内联那个块」）——陈旧数据在这个
            # 意义上就是「没有今天的数据」，跳过 embed，交给 JS 已有的
            # empty-state 分支，不需要新的前端逻辑。sidecar 仍然照写：
            # 那是「原始状态文件的副本」，不是「今天视图该显示什么」的
            # 判断，file picker fallback 场景下把原始文件递给用户没有错。
            if (mode == "today" and data.get("date")
                    and data["date"] != state_module._today_key()):
                sidecar = out.parent / src_name
                if sidecar.resolve() != src.resolve():
                    sidecar.write_text(json_text, encoding="utf-8")
                # 不能就此 continue（跳过整个 inject）——那样 JS 找不到
                # `agent-vitals-data-today` 这个 script 标签，会误判成
                # 「没内联，试试 fetch」，在 file:// 打开时必然撞上 CORS，
                # 弹出一句让人费解的"读取本地文件被 CORS 阻止"（真实
                # 复现：之前 today.json 几乎总有数据可内联，这条 fetch
                # 兜底路径很少被走到，这次改动第一次把它暴露出来）。
                # 改成内联一个显式的 stale 哨兵，让 JS 立刻识别出「这不是
                # 没数据，是数据被判定过期而不展示」，直接给清晰文案，
                # 不再往 fetch/file-picker 那条「不确定有没有文件」的分支走。
                stale_text = json.dumps({"stale": True, "stale_date": data["date"]})
                inject = ("<script id=\"agent-vitals-data-today\" "
                          "type=\"application/json\">" + stale_text + "</script>")
                html = html.replace("</head>", inject + "\n</head>", 1)
                continue
            _augment_calendar_cost(mode, data, pricing)
            embed_text = json.dumps(data)
        # JSON 里可能含 </script> —— 必须转义,否则浏览器解析到这就崩
        json_text_safe = (embed_text
                          .replace("</script", "<\\/script")
                          .replace("<!--", "<\\!--"))
        inject = ("<script id=\"agent-vitals-data-%s\" type=\"application/json\">"
                   % mode + json_text_safe + "</script>")
        html = html.replace("</head>", inject + "\n</head>", 1)
        # 同时把 state 文件 cp 到同目录,作为 fetch fallback 的副本——除非
        # 输出目录本来就是 state 目录本身(oneline 自动刷新的场景),那样
        # 会变成把文件写到自己头上,纯浪费一次 I/O。sidecar 写的是**原始**
        # json_text,不是带精算 cost 字段的 embed_text——见上面文档。
        sidecar = out.parent / src_name
        if sidecar.resolve() != src.resolve():
            sidecar.write_text(json_text, encoding="utf-8")
        embedded.append(mode)
    # ── codex 1 号执行环境内联块（统一看板）─────────────────────────────────
    # 规范化单块 {harness, currency, today, default, views:{today,month,all}}
    #（docs/UNIFIED_COST_VIEW.md）。与 DSH 双块并列内联，让跨执行环境今日总览
    # 一打开就有两张执行环境卡。**扫描失败时降级**：不内联该块，codex harness 落
    # JS 的 empty-state，DSH 渲染不受影响（codex 只是新增执行环境，不能拖垮
    # 既有看板）。default="month"（当前月）——与 DSH 的 default_source 同构。
    try:
        codex_merged = codex_fold_merged()
        codex_blob = codex_calendar_blob(
            codex_merged,
            codex_cost_module.current_month_beijing(),
            codex_cost_module.current_month_beijing(),
            "month")
        codex_json = json.dumps(codex_blob, ensure_ascii=False)
        codex_safe = (codex_json.replace("</script", "<\\/script")
                      .replace("<!--", "<\\!--"))
        codex_inject = ("<script id=\"agent-vitals-data-codex\" "
                        "type=\"application/json\">" + codex_safe + "</script>")
        html = html.replace("</head>", codex_inject + "\n</head>", 1)
    except Exception:
        # 降级路径：不内联 codex 块。不静默吞异常——至少标一句，不然真挂了
        # 会被当成「用户今天没 codex 数据」，和「扫崩了」长得一样（同一原则
        # 见 ARCHITECTURE §6.2 的退出码语义）。
        sys.stderr.write("warning: codex 会话扫描失败，跳过 codex 视图内联\n")
    html = html.replace(
        "</head>",
        "<script>window.AGENT_VITALS_DEFAULT_MODE = %r;</script>\n"
        "<script>window.AGENT_VITALS_DEFAULT_HARNESS = 'dsh';</script>\n</head>"
        % default_source, 1)
    out.write_text(html, encoding="utf-8")
    return embedded, out


def _augment_calendar_cost(mode, data, pricing):
    """给日历模板的内联数据塞一个按真实模型精算的 cost 字段。

    模板自己那份 `costOf()` 是硬编码 deepseek-v4-flash 单价的近似（见
    calendar.html 头部注释），pro 模型的日子会被低估到 1/3——与
    budget.py 之前那个 bug（已在 `_price_by_model` 修过）同一个根因。
    覆盖率校验/补齐的算术在 `cost.py::priced_day`（唯一入口，`budget.py`
    的 month/7d-average 也调它，避免三处各写一份判断，见该函数文档）。

    today.json 的 `by_model` 是**整天一个总量**，没有按小时拆分——没法
    给 24 个小时格子分别精算，所以只在顶层塞一个 `accurate_cost` 供
    summary 卡片用；per-hour 小时格子/tooltip 仍走旧近似，不假装有
    数据实际不具备的精度。today.json 的 by_model 与 (date,hour) 桶永远
    同一次 `merge_today` 调用写入、折自同一份 events（`TestUsageHourBucketsReconcile`
    钉死了这个不变量），结构上不可能出现 `priced_day` 要防的「部分覆盖」
    （若真出现，覆盖多于顶层也只会被 `priced_day` 判成 exact，不会漏算），
    所以这里直接用 `cost_report`，不必再走 `priced_day` 的覆盖率分支。
    month.json 的 `by_model` 是**逐日**的，可以给每一天单独精算。
    """
    if mode == "today":
        by_model = data.get("by_model")
        if by_model:
            report = cost_module.cost_report({"by_model": by_model}, pricing)
            if report is not None:
                data["accurate_cost"] = {
                    "total": report["total"],
                    "peak_total": report["peak_total"],
                }
    else:
        days = data.get("days")
        if isinstance(days, dict):
            for day in days.values():
                if not isinstance(day, dict):
                    continue
                priced = cost_module.priced_day(day, pricing)
                if priced is not None:
                    day["cost"] = priced


def main():
    """入口。**未捕获异常必须以 2 退出，不是 1。**

    ARCHITECTURE §6.2 把退出码定成对外接口：0 = 无达到阈值的发现，
    1 = 有，2 = 工具自身错误。Python 默认让未捕获异常退出 1 —— 于是
    「扫出了 critical」和「工具崩了」在 CI 眼里是同一个码，而这两件事
    要做的处置完全相反。

    验收时这条真的被踩到：`scan.py`（最朴素的调用）第二次运行崩在
    `None - None`，退出 1，看起来像「有发现」。
    """
    try:
        return _main()
    except SystemExit:
        raise
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        traceback.print_exc()
        sys.exit(2)


def _dash(v):
    """`codex-evidence` 人读呈现的空值占位：None / 非字符串 → 长破折号（与
    Rust `render_codex_evidence` 的 `dash` 闭包同一语义——JSON null 和缺键在
    Python 里都读成 None，在 Rust 里都是 `Some(_)` → "—"，结果一致）。"""
    return v if isinstance(v, str) else "—"


def _render_codex_evidence(out):
    """`codex-evidence` 的人读呈现——从 `codex_evidence_json` 输出的同一个
    dict 上读（形状唯一来源），Rust 侧 `main.rs::render_codex_evidence` 逐字节
    对齐这一份。19 个全零的 unavailable 信号不在人读视图里制造噪音，JSON 里
    才是全量。"""
    roots = out.get("workspace_roots")
    roots_text = ", ".join(r for r in roots if isinstance(r, str)) if isinstance(roots, list) else ""
    signals = [s for s in (out.get("signals") or []) if isinstance(s, str)]

    parts = []
    parts.append("harness: codex\n")
    parts.append("session: %s\n" % _dash(out.get("session_id")))
    parts.append("title: %s\n" % _dash(out.get("title")))
    parts.append("history_mode: %s\n" % _dash(out.get("history_mode")))
    parts.append("cli_version: %s\n" % _dash(out.get("cli_version")))
    parts.append("model: %s\n" % _dash(out.get("model")))
    parts.append("workspace_roots: %s\n" % (roots_text or "—"))
    parts.append("signals: %s\n" % ", ".join(signals))
    parts.append("\n")
    cov = out.get("coverage")
    if isinstance(cov, dict):
        for name in signals:
            c = cov.get(name)
            if not isinstance(c, dict):
                continue
            m = c.get("measured")
            m = m if isinstance(m, int) and not isinstance(m, bool) else 0
            d = c.get("derived")
            d = d if isinstance(d, int) and not isinstance(d, bool) else 0
            l = c.get("lossy")
            l = l if isinstance(l, int) and not isinstance(l, bool) else 0
            u = c.get("unmetered")
            u = u if isinstance(u, int) and not isinstance(u, bool) else 0
            parts.append("  %-20s measured=%d derived=%d lossy=%d unmetered=%d\n"
                         % (name, m, d, l, u))
    parts.append("\n")
    attempts = out.get("attempts")
    notes = out.get("notes")
    parts.append("attempts: %d    notes: %d\n" %
                 (len(attempts) if isinstance(attempts, list) else 0,
                  len(notes) if isinstance(notes, list) else 0))
    return "".join(parts)


def _render_codex_roots(report):
    """`codex-evidence --roots` 的人读呈现——从 `codex_session_roots_report` 的
    同一个 dict 上读（形状唯一来源），Rust 侧 `main.rs::render_codex_roots`
    逐字节对齐这一份。缺席的根不猜路径也不报错，只标 `(absent)`。"""
    parts = ["harness: codex\n"]
    roots = report.get("roots")
    if isinstance(roots, list):
        for entry in roots:
            if not isinstance(entry, dict):
                continue
            kind = entry.get("kind")
            path = entry.get("path")
            if not isinstance(kind, str) or not isinstance(path, str):
                continue
            if entry.get("exists"):
                fc = entry.get("file_count")
                tb = entry.get("total_bytes")
                fc = fc if isinstance(fc, int) and not isinstance(fc, bool) else 0
                tb = tb if isinstance(tb, int) and not isinstance(tb, bool) else 0
                parts.append("%-8s %s  (%d rollouts, %d bytes)\n" % (kind, path, fc, tb))
            else:
                parts.append("%-8s %s  (absent)\n" % (kind, path))
    return "".join(parts)


def _render_plan_human(payload):
    """`plan` 的人读呈现——从 `build_plan` 的同一个 dict 上读（形状唯一来源），
    Rust 侧 `main.rs::render_plan` 逐字节对齐这一份。渲染只做呈现：null 一律落
    `—`（没测到就标没测到，不假装 0），summary 不汇总 token（per-startup 与
    per-trigger 单位不可通约）。"""
    parts = []
    parts.append("harness: %s" % (payload.get("harness_selection") or ""))
    startup = payload.get("startup_rate_per_month")
    if startup is None:
        parts.append("startup rate per month: —")
    else:
        parts.append("startup rate per month: %d" % startup)
    refs = payload.get("diagnosis_refs") or []
    if refs:
        parts.append("diagnosis refs: " + ", ".join(refs))
    else:
        parts.append("diagnosis refs: (none)")
    parts.append("")
    summary = payload.get("summary") or {}
    parts.append("%d items · %d with measured savings"
                 % (summary.get("item_count") or 0, summary.get("savings_items") or 0))
    parts.append("")
    for i, it in enumerate(payload.get("items") or [], 1):
        parts.append("%d. %s  %s  [%s]"
                     % (i, it.get("id") or "", it.get("skill") or "", it.get("risk") or ""))
        sav = it.get("savings_per_event")
        if sav is not None:
            parts.append("   savings: %d tokens per %s"
                         % (sav.get("tokens") or 0, sav.get("per") or ""))
        else:
            parts.append("   savings: none measured")
        epm = it.get("events_per_month")
        if epm is None:
            parts.append("   events per month: —")
        else:
            parts.append("   events per month: %d" % epm)
        ltm = it.get("measured_lifetime_triggers")
        if ltm is None:
            parts.append("   lifetime triggers measured: —")
        else:
            parts.append("   lifetime triggers measured: %d" % ltm)
        drefs = it.get("diagnosis_refs") or []
        if drefs:
            parts.append("   diagnosis: " + ", ".join(drefs))
        else:
            parts.append("   diagnosis: (none)")
        parts.append("   %s" % (it.get("rationale") or ""))
        parts.append("")
    return "\n".join(parts) + "\n"


def _main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", action="version",
                    version="agent-vitals %s" % __version__)
    ap.add_argument("--harness", choices=("all", "claude-code", "codex", "openclaw", "hermes", "workbuddy", "dsh"),
                    default="all", help="Analyze one harness; default: scan every supported harness separately")
    ap.add_argument("--path", action="append", default=[],
                    help="Additional scan path; repeatable")
    ap.add_argument("--runtime-json", metavar="FILE",
                    help="DSH registry snapshot (ctx.skills.snapshot() output) for probe evidence")
    ap.add_argument("--json", metavar="FILE",
                    help="Write scan JSON to FILE; use - for stdout. Without this option, run doctor.")
    ap.add_argument("--budget", type=int, default=DEFAULT_DESC_BUDGET,
                    help=f"Description character budget; default: {DEFAULT_DESC_BUDGET}")
    ap.add_argument("--all", action="store_true",
                    help="Calculate budget and conflicts over all on-disk skills (diagnostic; default: loaded only)")
    ap.add_argument("--zombie-age", type=int, default=ZOMBIE_MIN_AGE_DAYS,
                    help=f"Minimum installed age for zombie classification; default: {ZOMBIE_MIN_AGE_DAYS}")
    ap.add_argument("--split-threshold", type=int, default=6000,
                    help="Recommend splitting above this tier2_core_tokens value; default: 6000")
    ap.add_argument("--baseline", help="Previous scan JSON used for change comparison")
    ap.add_argument("--fail-on", choices=("none", "critical", "warning", "info"),
                    default="critical",
                    help="Exit code 1 when a finding at this severity is present (for CI). "
                         "Default: critical; none never fails on findings")
    ap.add_argument("--ignore", default="",
                    help="Diagnostic codes excluded from the gate, comma-separated "
                         "(e.g. SV301,SV302). Ignored codes are still printed")
    ap.add_argument("--new-only", action="store_true",
                    help="Gate only diagnostics that are new relative to the baseline; "
                         "exit code 2 without a baseline")
    ap.add_argument("--no-snapshot", action="store_true",
                    help="Disable doctor's automatic snapshot and comparison")
    ap.add_argument("--redact", action="store_true",
                    help="Redact home directories and user names in absolute paths for safe sharing")
    ap.add_argument("--self-root",
                    help="This tool's own skill directory, excluded from security scanning; inferred when omitted")
    ap.add_argument("--redact-names", action="store_true",
                    help="Also redact skill names to stable skill-001-style IDs and drop descriptions")
    # 子命令建在现有参数**之上**：不带子命令 = 原来的扫描行为。
    # 这条不是洁癖 —— SKILL.md 与全部集成测试都依赖裸调用 `--json`，
    # 把扫描降级成子命令会一次性打断所有调用方。
    sub = ap.add_subparsers(dest="cmd")
    p_list = sub.add_parser("list", help="List discovered skills and their effective state")
    p_list.add_argument("--unused", action="store_true", help="Show dormant / zombie only")
    p_list.add_argument("--shadowed", action="store_true", help="Show shadowed copies only")
    p_list.add_argument("--stale", type=int, help="Dormant threshold in days; default: 30")
    p_list.add_argument("--sort", choices=("usage", "cost", "name"), default="cost")
    p_list.add_argument("--top", type=int, help="Show only the first N rows")
    p_list.add_argument("--json", help="Write JSON instead of a table")
    p_over = sub.add_parser("overlap",
                            help="Lexical filter for skills that may compete for similar requests")
    p_over.add_argument("--min", type=float, default=DEFAULT_OVERLAP_MIN,
                        help="Jaccard threshold; default: %.2f" % DEFAULT_OVERLAP_MIN)
    p_over.add_argument("--top", type=int, help="Show only the first N pairs")
    p_over.add_argument("--json", help="Write JSON instead of a table")
    p_doc = sub.add_parser("doctor",
                           help="Turn scan facts into cause, impact, and action")
    p_doc.add_argument("--min", type=float, default=DEFAULT_OVERLAP_MIN,
                       help="Jaccard threshold for SV401; default: %.2f (shared with overlap)"
                            % DEFAULT_OVERLAP_MIN)
    p_doc.add_argument("--json", help="Write diagnostic JSON instead of a report")
    p_doc.add_argument("--with-report", action="store_true",
                       help="Attach the full scan report to the JSON payload as 'report'. "
                            "A consumer that needs both the SV diagnostics and the harness "
                            "summaries then scans once instead of twice.")
    p_doc.add_argument("--no-snapshot", action="store_true",
                       help="Do not save a snapshot or compare automatically")
    # 省钱方案（诊断 → 治疗方案）：把 scan 报告派生为量化、排序、诚实的动作清单。
    # `--startup-rate` 是用户估算的每月启动次数，是 per-startup 项 events_per_month
    # 的**唯一**来源（估算，不是测量；终身 usage_count 绝不冒充每月数）。
    p_plan = sub.add_parser("plan",
                            help="Turn the scan report into a quantified, ranked, "
                                 "honest savings plan")
    p_plan.add_argument("--startup-rate", type=int, default=None,
                        help="Estimated starts of Claude Code per month; the ONLY source "
                             "for per-startup items' events_per_month (an estimate, "
                             "not a measurement)")
    p_plan.add_argument("--json", help="Write plan JSON to FILE; use - for stdout")
    p_exp = sub.add_parser("explain",
                           help="Explain why one skill is ineffective and how to fix it")
    p_exp.add_argument("name", help="Skill name or <plugin>:<name>")
    p_exp.add_argument("--min", type=float, default=DEFAULT_OVERLAP_MIN,
                       help="Jaccard threshold for neighbors; default: %.2f (shared with overlap)"
                            % DEFAULT_OVERLAP_MIN)
    p_exp.add_argument("--json", help="Write JSON instead of a report")
    p_snap = sub.add_parser("snapshot", help="Save a snapshot to ~/.agent-vitals/snapshots")
    p_snap.add_argument("--keep", type=int, default=SNAPSHOT_KEEP,
                        help="Retain the newest N snapshots; default: %d; 0 means unlimited" % SNAPSHOT_KEEP)
    p_diff = sub.add_parser("diff", help="Compare with the previous snapshot")
    p_diff.add_argument("file", nargs="?",
                        help="Snapshot file to compare; default: latest")
    p_diff.add_argument("--json", help="Write JSON instead of a report")
    p_beh = sub.add_parser("behavior",
                           help="Audit a DSH session log for high-risk behaviors (SV601-SV610)")
    p_beh.add_argument("session_log", help="Path to the DSH session JSONL log (file or directory)")
    p_beh.add_argument("--json", help="Write findings JSON to FILE; use - for stdout")
    # D11：执行时长审计——工具调用/turn/step/审批等待/hook 消费五路耗时数据。
    # 与 skill-audit 同一种结构（Rust 侧同时有独立子命令），Python CLI 只补
    # duration-audit（本次范围），不补 skill-audit——那是 T11 遗留的一个更早、
    # 更大的 Python CLI 缺口（behavior --json 之前一直没输出 skill 键，这次
    # 修 duration 时顺手在 audit_session_log 里补上了，但"独立的 skill-audit
    # 子命令"本身不在这个 backlog 范围内，留给专门处理它的时候再做）。
    p_dur = sub.add_parser("duration-audit",
                           help="Audit a DSH session log for execution duration "
                                "(tool calls / turns / steps / approvals / hooks)")
    p_dur.add_argument("session_log", help="Path to the DSH session JSONL log (file or directory)")
    p_dur.add_argument("--json", help="Write duration audit JSON to FILE; use - for stdout")
    # v0.6 harness-contract spec §5.1/§11-M0：打印 core HarnessProfile 注册表本身
    # （四个 runtime 执行环境声明的结构能力），与 Rust 侧 main.rs 的 Harnesses 子命令
    # 同一种结构，逐字节比对靠 test_cli_matrix 的 G1。
    p_harnesses = sub.add_parser("harnesses",
                             help="Print the HarnessProfile registry (v0.6 harness-"
                                  "contract spec §5.1): the four runtime "
                                  "harnesses' declared structural capabilities")
    p_harnesses.add_argument("--json", help="Write harnesses JSON to FILE; use - for "
                                        "stdout. Without this option, print a "
                                        "human table.")
    # P4（docs/RUNTIME_EVIDENCE_CONTRACT.md §17）：Codex rollout → CanonicalSession
    # 的 "sound" 证明。输出 §13 coverage，不是 findings——Codex 还没有 SV601–614
    # 检测器（detector decoupling 是后置的更大一摊，P4 明确不做）。`--harness
    # codex` 是安装时探针的表面，与这个子命令无关（命名冲突见
    # adapters/codex_session.py 顶部注释）。
    p_codex = sub.add_parser("codex-evidence",
                             help="Audit a Codex rollout log into a CanonicalSession "
                                  "with §13 coverage (P4 'sound' proof)")
    p_codex.add_argument("session_log", nargs="?",
                         help="Path to the Codex rollout JSONL log (or use --roots)")
    p_codex.add_argument("--roots", action="store_true",
                         help="List the Codex session roots (live + archived) instead "
                              "of auditing one log — archived_sessions existence is "
                              "probed, never an error")
    p_codex.add_argument("--json", help="Write coverage JSON to FILE; use - for stdout")
    # `codex-cost` 命令已退役（v0.9.1 Tier B，spec §5.2）：codex 成本报告改从
    # SQL 权威库（`authority_query::codex_by_hour_model`）读，不再全量 fold
    # `~/.codex` rollout。该数据源是 Rust `agent_vitals_data`（rusqlite）——
    # ClawHub in-harness skill 这一份是 stdlib-only、没有权威库，无法迁移，故整
    # 命令只由 Rust 二进制提供。`codex_cost.py` 模块本身保留（`calendar` 命令
    # 与 `codex-session` 仍用其纯函数）。
    # Codex 单会话审计：逐 session 成本 + 出处覆盖并集（套 DSH 审计 tab 版式）。
    # codex-cost 在折叠时把 session 身份聚合掉，codex-evidence 给出处但不含成本；
    # 这里把该 session 的文件们折叠→合并→计价，再把 evidence 覆盖取并集，拼回
    # 一个逻辑 session（跨文件 resume 按 session_id 合并）。`--list` 只是选 id 的
    # 前置（id/标题/模型/文件数/时间跨度）；单会话深挖是 --json/--html/文本三路。
    # 与 Rust main.rs 的 CodexSession 子命令同一种结构。
    p_codex_session = sub.add_parser("codex-session",
                                     help="Audit ONE Codex session: per-session cost "
                                          "(USD) + provenance coverage, in the DSH "
                                          "audit-tab visual language")
    p_codex_session.add_argument("--list", action="store_true",
                                 help="List all Codex sessions (id/title/model/file "
                                      "count/date span) — the id picker")
    p_codex_session.add_argument("--session", metavar="ID", default=None,
                                 help="The logical session_id to audit; default = the "
                                      "most recent session")
    p_codex_session.add_argument("--json", metavar="FILE",
                                 help="Write the audit JSON to FILE; use - for stdout")
    p_codex_session.add_argument("--html", metavar="FILE",
                                 help="Write a self-contained HTML audit report to FILE")
    # Claude Code 单会话审计：coverage（§13 逐信号）+ SV601–614 findings。五段式
    # 流水线 locate→shape→extract（adapters/claude_session.py）→ derive→coverage
    # （agent/claude_evidence.py）→ 组合（agent/claude_session_audit.py）。SV607/608
    # 的 Unavailable 是 harness-capability degradation（§12），在 claude_session_audit
    # 里 override——Claude 的 tool_result 没有原因码词汇，error_code 结构性恒 None，
    # 原因级检测器读了也白读，MeasuredZero 是对「结构上读不到原因」撒谎。SV609/610/
    # 614 不需要 override：approvals/sandbox_modes timeline 恒空，门控已经如实给
    # Unavailable。`--list` 只是选 id 的前置；缺省 --session = 最新。**没有
    # --html**——Claude 侧还没有模板，不硬编（与 codex-session 的 --html 不同）。
    # 与 Rust main.rs 的 ClaudeSession 子命令同一种结构。
    p_claude_session = sub.add_parser(
        "claude-session",
        help="Audit ONE Claude Code session: provenance coverage + SV601-614 "
             "findings (SV607/608 harness-capability Unavailable)")
    p_claude_session.add_argument("--list", action="store_true",
                                  help="List all Claude sessions (id/title/model/"
                                       "cwd/date span) — the id picker")
    p_claude_session.add_argument("--session", metavar="ID", default=None,
                                  help="The session_id to audit; default = the "
                                       "most recent session")
    p_claude_session.add_argument("--json", metavar="FILE",
                                  help="Write the audit JSON to FILE; use - for stdout")
    # Claude Code 会话账 fold（第三数据面）：发现 ~/.claude/projects 里变化的
    # 会话文件 → 尾读折 checkpoint（claude-fold.json，cost-state 基线替换 + 行尾
    # 增量）→ 全量重建 claude-ledger.json / claude-ledger-archive.json（托盘账卡
    # 的 Claude 估列数据源，money 由 core cost.rs 在读取时算——本命令只折 token
    # 桶）。owner fencing 同 oneline（Python 写者纪律：owner=rust 拒绝，--shadow
    # 演练跳过）。与 Rust main.rs 的 ClaudeSync 子命令同一种结构。
    p_claude_sync = sub.add_parser(
        "claude-sync",
        help="Fold Claude Code session files (cost-state baseline + row usage) "
             "into claude-ledger.json; fenced like oneline")
    p_claude_sync.add_argument(
        "--shadow", action="store_true",
        help="Rehearse on a copy: skip writer fencing (like `oneline --shadow`)")
    # Stage 1 commit 2（commit d0ec2f2 R1 拍板）：Claude UsageFact 诊断 CLI
    # ——单份 JSONL → facts + attempts + coverage，**不写盘**（UsageFact
    # 持久化是后续 Data Plane 阶段）。与 Rust 镜像同源字节。
    p_claude_usage_facts = sub.add_parser(
        "claude-usage-facts",
        help="Audit ONE Claude JSONL session into UsageFact rows "
             "(per-message, no state writes; v0.7 spec §3 candidate #3)")
    p_claude_usage_facts.add_argument(
        "session_jsonl",
        help="Path to a Claude session JSONL file "
             "(e.g. ~/.claude/projects/-proj-x/<sid>.jsonl)")
    p_claude_usage_facts.add_argument(
        "--machine-namespace", default=None,
        help="machine_namespace component of SessionKey — REQUIRED (v0.7 spec "
             "§9: caller-provided; missing exits 2). The CLI never reads/writes "
             "state to invent one — a fact's identity fields seed its fact_id, "
             "so a CLI default would destabilize replays AND write machine.json")
    p_claude_usage_facts.add_argument(
        "--source-profile", default="default",
        help="source_profile component of SessionKey (default: 'default')")
    p_claude_usage_facts.add_argument(
        "--json", metavar="FILE",
        help="Write UsageFact JSON to FILE; use - for stdout. Without this, "
             "print human summary.")
    # Stage 2（commit 2，决策 A/D′）：Codex UsageFact 诊断 CLI——一份或多份
    # rollout JSONL → facts + attempts + coverage，**不写盘**（同 claude-usage-facts）。
    # source_event_id 按 rollout **stem** 命名空间（2026-09-03 拍板 D′：byte_offset
    # 只在单文件内唯一，逻辑 session 命名会把两份续接 rollout 的同 offset 同形行
    # 误并）。与 Rust 镜像同源字节。
    # HARNESS_MANIFEST_DSL_SPEC §8.1：generic 插件执行环境 validate 面（只读 dry-run；
    # Python 不长 writer——plugin-ingest --write 是 Rust-only，与
    # workbuddy-usage-facts --write 同一条纪律）。负载与 Rust CLI 同键序。
    p_plugin_validate = sub.add_parser(
        "manifest-validate",
        help="Dry-run a plugin manifest (HARNESS_MANIFEST_DSL_SPEC §6.5): "
             "discovery + extraction + fact_id stability + format guard; "
             "read-only, no writes")
    p_plugin_validate.add_argument(
        "--manifest", required=True,
        help="Path to harnesses.d/<slug>/manifest.json")
    p_plugin_validate.add_argument(
        "--file", action="append", default=None,
        help="Explicit fixture files (repeatable); discovery per manifest "
             "roots otherwise")
    p_plugin_validate.add_argument(
        "--machine-namespace", default="",
        help="machine_namespace for fact identity (fixture mode too)")
    p_plugin_validate.add_argument(
        "--json", action="store_true",
        help="Print the full report as JSON to stdout")

    # spec §9E.5 E4a：WorkBuddy UsageFact 诊断 CLI——traces → facts，不写盘。
    p_wb_usage_facts = sub.add_parser(
        "workbuddy-usage-facts",
        help="Replay a WorkBuddy home (~/.workbuddy) into UsageFact rows — one per "
             "generation span with usage, keyed by trace.sessionId (E4a); in-memory, "
             "read-only")
    p_wb_usage_facts.add_argument(
        "root", help="WorkBuddy home directory (the one containing traces/)")
    p_wb_usage_facts.add_argument(
        "--machine-namespace", default=None,
        help="machine_namespace component of SessionKey — REQUIRED (v0.7 spec "
             "§9: caller-provided; missing exits 2)")
    p_wb_usage_facts.add_argument(
        "--source-profile", default="default",
        help="source_profile component of SessionKey (default: 'default')")
    p_wb_usage_facts.add_argument(
        "--json", metavar="FILE",
        help="Write UsageFact JSON to FILE; use - for stdout. Without this, "
             "print human summary.")
    p_codex_usage_facts = sub.add_parser(
        "codex-usage-facts",
        help="Audit ONE+ Codex rollout JSONL files into UsageFact rows "
             "(per token_count, no state writes; v0.7 spec §3 candidate #3 "
             "Stage 2)")
    p_codex_usage_facts.add_argument(
        "rollouts", nargs="+",
        help="One or more Codex rollout JSONL file paths (e.g. "
             "~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl)")
    p_codex_usage_facts.add_argument(
        "--machine-namespace", default=None,
        help="machine_namespace component of SessionKey — REQUIRED (v0.7 spec "
             "§9: caller-provided; missing exits 2). The CLI never reads/writes "
             "state to invent one — a fact's identity fields seed its fact_id, "
             "so a CLI default would destabilize replays AND write machine.json")
    p_codex_usage_facts.add_argument(
        "--source-profile", default="default",
        help="source_profile component of SessionKey (default: 'default')")
    p_codex_usage_facts.add_argument(
        "--json", metavar="FILE",
        help="Write UsageFact JSON to FILE; use - for stdout. Without this, "
             "print human summary.")
    # v0.7 Stage 3 commit 2（spec §5 字面）：DSH UsageFact 诊断 CLI——单份
    # session 文件（明文 .jsonl 或 .zstd）→ facts + coverage，**不写盘**。
    # source_profile 缺省从 header cwd 派生；cwd 缺失 + 无显式 profile →
    # unattributed（exit 2）。strict 硬错误不输出空成功（§4.1）。与 Rust 镜像
    # `dsh-usage-facts` stdout 字节同源。
    p_dsh_usage_facts = sub.add_parser(
        "dsh-usage-facts",
        help="Audit ONE DSH session file into UsageFact rows "
             "(per observation slot, no state writes; v0.7 spec §3 candidate #3 "
             "Stage 3)")
    p_dsh_usage_facts.add_argument(
        "--path", required=True,
        help="Path to a DSH session file (.jsonl or multi-frame .zstd, e.g. "
             "<DSH_HOME>/sessions/<project>/<id>/session.jsonl.zstd)")
    p_dsh_usage_facts.add_argument(
        "--machine-namespace", default=None,
        help="machine_namespace component of SessionKey — REQUIRED (v0.7 spec "
             "§9: caller-provided; missing exits 2). The CLI never reads/writes "
             "state to invent one — a fact's identity fields seed its fact_id, "
             "so a CLI default would destabilize replays AND write machine.json")
    p_dsh_usage_facts.add_argument(
        "--source-profile", default=None,
        help="source_profile component of SessionKey (default: derive from the "
             "session header cwd; explicit P wins; header cwd missing + no P → "
             "unattributed, exit 2)")
    p_dsh_usage_facts.add_argument(
        "--json", metavar="FILE",
        help="Write UsageFact JSON to FILE; use - for stdout. Without this, "
             "print human summary.")
    # WorkBuddy 单会话审计：coverage（§13 逐信号）+ SV601–614 findings。与
    # claude-session 同构；harness-capability degradation 是 SV604/605（spec §3.1）——
    # 只有 bash（audit-log commandPreview）与 web_fetch（WebFetch target）能 join，
    # write/edit 只在会话匿名的 traces 里，SV604/605 读不到写维度 → Unavailable。
    # 成本直接吃 session_usage.credit_json 执行环境账单（spec §9），pricing.json 零参与
    # （不长第四份价格拷贝）。五段式流水线 locate→shape→extract
    # （adapters/workbuddy_session.py）→ derive→coverage（agent/workbuddy_evidence.py）
    # → 组合（agent/workbuddy_session_audit.py）。`--list` 只是选 id 的前置；缺省
    # --session = 最新；没有 --html（同 claude-session）。与 Rust main.rs 的
    # WorkbuddySession 子命令同一种结构。
    p_workbuddy_session = sub.add_parser(
        "workbuddy-session",
        help="Audit ONE WorkBuddy session: provenance coverage + SV601-614 "
             "findings (SV604/605 harness-capability Unavailable; cost from "
             "harness-billed credit_json)")
    p_workbuddy_session.add_argument("--list", action="store_true",
                                     help="List all WorkBuddy sessions (id/title/"
                                          "model/date span) — the id picker")
    p_workbuddy_session.add_argument("--session", metavar="ID", default=None,
                                     help="The session_id to audit; default = the "
                                          "most recent session")
    p_workbuddy_session.add_argument("--json", metavar="FILE",
                                     help="Write the audit JSON to FILE; use - for stdout")
    # ──── Sessions 查询面（v0.9.1 PR #4.5：切 sessions_sql 直连权威库）──
    # 走 `mcp::sessions_search` / `mcp::session_detail` byte-mirror wrapper
    # （`agent_vitals.agent.sessions_sql`）。CLI 仅是 envelope 搬运工——
    # cursor / arg 全部透传给 wrapper,不在 CLI 侧再解析。
    p_sessions = sub.add_parser("sessions",
                                help="Sessions query surface (SQL authority DB, "
                                     "spec §6 envelope — session_ref HMAChides "
                                     "native id; cost_minor via usage_facts × "
                                     "pricing_snapshots JOIN)")
    sess_sub = p_sessions.add_subparsers(dest="sessions_action")
    p_slist = sess_sub.add_parser(
        "list",
        help="List sessions in a day/month window (Beijing time) — "
             "byte-mirror of mcp::sessions_search",
    )
    p_slist.add_argument("--day", default=None,
                         help="Day window (YYYY-MM-DD, Beijing). Mutually "
                              "exclusive with --month.")
    p_slist.add_argument("--month", default=None,
                         help="Month window (YYYY-MM, Beijing). Mutually "
                              "exclusive with --day.")
    p_slist.add_argument("--hour", type=int, default=None,
                         help="Hour-of-day filter 0..=23 (requires --day, not --month)")
    p_slist.add_argument("--harness-kind", action="append", default=None,
                         help="Filter by harness (repeatable). Wired: claude-code / "
                              "codex / dsh")
    p_slist.add_argument("--min-tokens", type=int, default=0,
                         help="Drop sessions with total tokens < N")
    p_slist.add_argument("--page-size", type=int, default=50,
                         help="Page size; default 50, max 500")
    p_slist.add_argument("--cursor", default=None,
                         help="Opaque cursor from a previous page's next_cursor "
                              "(<total>:<key_len>:<key>)")
    p_slist.add_argument("--as-of-run-id", default=None,
                         help="Strict cross-tool consistency check (drift = "
                              "warning, unknown = invalid_argument)")
    p_slist.add_argument("--json", action="store_true",
                         help="Print the envelope as JSON to stdout")
    p_sread = sess_sub.add_parser(
        "read",
        help="Read one session by HMAC session_ref — byte-mirror of "
             "mcp::session_detail",
    )
    p_sread.add_argument("--session-ref", required=True,
                         help="HMAC session_ref (sr_<32 hex>); from `sessions "
                              "list` envelope data.sessions[].session_ref")
    p_sread.add_argument("--page-size", type=int, default=200,
                         help="Timeline page size; default 200, max 1000")
    p_sread.add_argument("--cursor", default=None,
                         help="Opaque cursor from a previous page's next_cursor "
                              "(<ts>:<fact_id_len>:<fact_id>)")
    p_sread.add_argument("--as-of-run-id", default=None,
                         help="Strict cross-tool consistency check")
    p_sread.add_argument("--json", action="store_true",
                         help="Print the envelope as JSON to stdout")
    p_snav = sess_sub.add_parser(
        "navigation",
        help="Multi-harness navigation projection (Tauri menu bar: today tokens + "
             "today sessions + recent N rows per harness)",
    )
    p_snav.add_argument("--day", default="",
                        help="Day to project (YYYY-MM-DD in the configured statistics timezone; "
                             "defaults to today)")
    p_snav.add_argument("--timezone", default=None,
                        help="Query-local IANA statistics timezone override; defaults to the saved or OS timezone")
    p_snav.add_argument("--recent", type=int, default=5,
                        help="How many recent rows per harness; default 5")
    p_snav.add_argument("--json", action="store_true",
                        help="Print the versioned envelope as JSON to stdout")
    # ──── M3: 跨会话聚合层（v1.x.x）── 三个新子命令 ─────────────────
    # oneline：单次审计 → oneline.json（覆盖）+ today.json / month.json（合并累加）。
    # 与 behavior 复用同一份 audit_session_log，但额外调 hour_buckets 把折叠
    # 结果写进 state 文件。xbar tick 直接读 oneline.json 不重算 cost —— 重算
    # 两份就两份可能不一致（见 cost.py 顶部 peak/off-peak 计价分支）。
    p_oneline = sub.add_parser("oneline",
                               help="Fold one session audit into the persisted state files")
    p_oneline.add_argument("session_log",
                           help="Path to the DSH session JSONL log")
    p_oneline.add_argument("--no-merge", action="store_true",
                           help="Skip today.json / month.json merge (write oneline.json only)")
    # calendar：把 month.json / today.json 渲染成单文件 HTML。模板来自
    # assets/templates/calendar.html（inline CSS/JS，无外链）。
    # 这里只做 copy + （可选）inline JSON，不重做 schema。
    p_cal = sub.add_parser("calendar",
                           help="Render the cost calendar HTML from persisted state")
    p_cal.add_argument("--source", choices=("month", "today"), default="month",
                       help="Which state file to render (default: month)")
    p_cal.add_argument("--output", "-o", required=True,
                       help="Destination HTML path")
    # state：列出 / 清理 state 目录，或列出有数据的自然月。不接受
    # --json/--harness 等扫描期参数。
    p_state = sub.add_parser("state", help="Inspect or clean the persisted state directory")
    p_state.add_argument("action", choices=("list", "clean", "months", "by-source", "by-model",
                                              "uncovered", "savings"),
                         help="list = show files; clean = remove (with --yes); "
                              "months = list months with data (current + archived); "
                              "by-source = per-source breakdown of the current month "
                              "(JSON on stdout); by-model = per-model monthly cost "
                              "breakdown of the current month (JSON on stdout, v0.7 "
                              "spec §3 first output view); uncovered = provider-grain "
                              "subscription-exclusion estimate (v0.7 spec §3 second "
                              "output view); savings = actual-vs-nominal cache-savings "
                              "ratio (v0.7 spec §3 third output view)")
    p_state.add_argument("--yes", action="store_true",
                         help="Skip the confirmation prompt for 'state clean'")
    # ──── M6: 预算告警 ──────────────────────────────────────────
    # show / set / enable / disable / snooze —— 五种动作覆盖 spec §5.5
    p_budget = sub.add_parser("budget",
                              help="Inspect or modify the budget alert thresholds")
    p_budget.add_argument("action", choices=("show", "set", "enable", "disable",
                                             "snooze", "unsnooze"),
                          help="show = current; set = change a field; "
                               "enable/disable = toggle; snooze = silence for Nh")
    p_budget.add_argument("--daily", type=float, default=argparse.SUPPRESS,
                          help="Set daily_cny (元)")
    p_budget.add_argument("--weekly", type=float, default=argparse.SUPPRESS,
                          help="Set weekly_cny")
    p_budget.add_argument("--monthly", type=float, default=argparse.SUPPRESS,
                          help="Set monthly_cny")
    p_budget.add_argument("--peak-share-max", type=float, default=argparse.SUPPRESS,
                          help="Set peak_share_max (0.0–1.0)")
    p_budget.add_argument("--hours", type=float, default=argparse.SUPPRESS,
                          help="snooze duration in hours")
    p_budget.add_argument("--json", action="store_true",
                          help="Emit alert as JSON (for xbar tick)")
    p_budget.add_argument("--month", default=None,
                          help="show only: query a specific month ('YYYY-MM') "
                               "instead of the current one — reads month.json "
                               "for the current month, month-archive.json otherwise")
    # --fail-on / --ignore 对 behavior 同样有意义（闸门），但 --new-only 没有——
    # 一份会话日志是单次取证输入，没有「相对上次的新增发现」。这里显式补上
    # 前两个，让它们在子命令前后两个位置都能解析（对齐 Rust 的 global=true）。
    # 不放进上面的 `for pp in (...)` 循环，是因为那批参数（--harness/--path/--all…）
    # 都是扫描期参数，behavior 不跑扫描，一个都不该收。
    p_beh.add_argument("--fail-on", choices=("none", "critical", "warning", "info"),
                       default=argparse.SUPPRESS)
    p_beh.add_argument("--ignore", default=argparse.SUPPRESS)
    # 子命令要复用扫描参数，故把它们也挂到子解析器上
    for pp in (p_list, p_over, p_doc, p_plan, p_exp, p_snap, p_diff):
        pp.add_argument("--harness", choices=("all", "claude-code", "codex", "openclaw",
                                           "hermes", "workbuddy", "dsh"), default=argparse.SUPPRESS)
        pp.add_argument("--path", action="append", default=argparse.SUPPRESS)
        pp.add_argument("--runtime-json", metavar="FILE", default=argparse.SUPPRESS)
        pp.add_argument("--all", action="store_true", default=argparse.SUPPRESS)
        pp.add_argument("--zombie-age", type=int, default=argparse.SUPPRESS)
        pp.add_argument("--split-threshold", type=int, default=argparse.SUPPRESS)
        pp.add_argument("--budget", type=int, default=argparse.SUPPRESS)
        pp.add_argument("--self-root", default=argparse.SUPPRESS)
        pp.add_argument("--redact", action="store_true", default=argparse.SUPPRESS)
        pp.add_argument("--redact-names", action="store_true", default=argparse.SUPPRESS)
        pp.add_argument("--baseline", default=argparse.SUPPRESS)
        pp.add_argument("--fail-on", choices=("none", "critical", "warning", "info"),
                        default=argparse.SUPPRESS)
        pp.add_argument("--ignore", default=argparse.SUPPRESS)
        pp.add_argument("--new-only", action="store_true", default=argparse.SUPPRESS)

    args = ap.parse_args()
    if getattr(args, "cmd", None):
        # 子命令下这些扫描期参数必须有默认值，下面的主流程要用
        args.baseline = getattr(args, "baseline", None)

    # 负数一律拒绝。**不能静默接受后产出垃圾** —— `--budget -1` 曾经算出
    # `pct_used: -6300.0` 并原样打进摘要行，一个负百分比被当成测量值输出。
    # 拒绝比编一个数好：这是本工具反复申明的那条底线。
    for flag, value in (("--budget", args.budget),
                        ("--zombie-age", args.zombie_age),
                        ("--split-threshold", args.split_threshold),
                        ("--startup-rate", getattr(args, "startup_rate", None))):
        if value is not None and value < 0:
            ap.error("%s cannot be negative (received %d)" % (flag, value))

    # 显式指定「自己」在哪。Python 版本来能靠 __file__ 推断，二进制形态
    # 下那条线断了（二进制装在 npm/cargo 的 bin 目录，与 skill 目录无关），
    # 所以两个实现都提供这个开关，保持命令面一致。
    # **排除是可见的**：被排除的 skill 带着 self_excluded=true 出现在报告里。
    if args.self_root:
        security_module.SELF_SKILL_ROOT = Path(args.self_root).resolve()

    # 行为审计：审计一份 DSH 会话日志的执行轨迹，**不跑 skill 扫描**。
    # 这是独立的取证命令（读会话日志 → 规则引擎 → findings），在扫描之前短路。
    if getattr(args, "cmd", None) == "behavior":
        audit = behavior_module.audit_session_log(args.session_log)
        if audit is None:
            print("session log unavailable: unreadable, malformed, or schema mismatch",
                  file=sys.stderr)
            sys.exit(2)
        (findings, usage, requests, context, compaction, waste, pre_fork, subagents, skill,
         duration, rule_outcomes, usage_coverage, duration_coverage, skill_coverage,
         subagents_coverage, compaction_coverage, waste_coverage) = audit
        if args.json:
            # `--json` 输出十九个键（rule_outcomes/usage_coverage/
            # duration_coverage/skill_coverage/subagents_coverage/
            # compaction_coverage/waste_coverage 是 P3 group①-⑤新加的，都是
            # 纯附加字段——findings/usage/duration 等本身的产出逻辑完全没变，
            # 见 behavior.py 的对应文档）。三份用量数据是同一批事件的三种
            # 分辨率，不是重复：usage 按模型汇总（成本），requests 保留逐
            # 请求时间序列（上下文占用曲线的数据源），context 是常驻前缀的
            # 分类估算。
            #
            # cost 不是 audit 六键之一——它读的是 usage × pricing.json，是 usage
            # 上的一次派生计算（cost.py 顶部注释：纯展示层）。cost_report 是
            # cost_block 和这里唯一算价格的地方，两处不会算出两个数。
            pricing = cost_module.load_pricing()
            cost = cost_module.cost_report(usage, pricing)
            # pre_fork 与 usage 是同一个形状（token_by_model 的输出），所以
            # 定价走同一个 cost_report——**不是**在这里另写一套算法。
            # usage→cost 与 pre_fork→pre_fork_cost 两条路对称：cli.py 就是
            # CLI 的展示层，它给 usage 定价本来就是合法的，给 pre_fork 定价
            # 是补上同一处遗漏的对称性，不是破例。
            #
            # 没分叉时 pre_fork 是 None → pre_fork_cost 也是 None，**不是一个
            # 全零的 cost_report**：「没分叉」和「分叉了但上游没花钱」是两回事。
            pre_fork_cost = (cost_module.cost_report(pre_fork, pricing)
                             if pre_fork is not None else None)
            text = json.dumps({"findings": findings, "usage": usage,
                               "requests": requests, "context": context,
                               "compaction": compaction, "waste": waste,
                               "cost": cost, "pre_fork": pre_fork,
                               "pre_fork_cost": pre_fork_cost,
                               "subagents": subagents,
                               "skill": skill, "duration": duration,
                               "rule_outcomes": rule_outcomes,
                               "usage_coverage": usage_coverage,
                               "duration_coverage": duration_coverage,
                               "skill_coverage": skill_coverage,
                               "subagents_coverage": subagents_coverage,
                               "compaction_coverage": compaction_coverage,
                               "waste_coverage": waste_coverage,
                               "cost_series": cost_module.cost_series(
                                   requests, usage.get("providers", {}), pricing)},
                              ensure_ascii=False, indent=2)
            if args.json == "-":
                print(text)
            else:
                Path(args.json).write_text(text, encoding="utf-8")
                print("Wrote %s: %d findings" % (args.json, len(findings)))
        else:
            glyph = {"critical": "✕", "warning": "⚠", "info": "·"}
            for f in findings:
                print("%s %s %s %s (seq %s)" % (
                    glyph[f["severity"]], f["rule"], f["category"], f["evidence"], f["seq"]))
            # 成本块：findings 之后空行 + 费用估算（纯展示层，见 cost.py）。无
            # 可分桶的桶时 cost_block 返回空列表 → 不打印（与 tab 空态同构）。
            pricing = cost_module.load_pricing()
            block = cost_module.cost_block(usage, pricing)
            if block:
                print()
                for line in block:
                    print(line)
            # 闸门与 doctor 同一套 --fail-on/--ignore 语义（无 --new-only，见
            # behavior_gate 的 docstring）。成本不影响退出码——闸门只看风险。
            sys.exit(behavior_module.behavior_gate(findings, args.fail_on, args.ignore))
        return

    # v0.6 harness-contract spec §5.1/§11-M0：打印 core HarnessProfile 注册表本身，
    # 与 Rust 侧 main.rs 的 Harnesses 子命令同一种结构（G1 byte-parity）。
    if getattr(args, "cmd", None) == "harnesses":
        out = harness_capability_module.harnesses_json()
        if args.json:
            text = json.dumps(out, ensure_ascii=False, indent=2)
            if args.json == "-":
                print(text)
            else:
                Path(args.json).write_text(text, encoding="utf-8")
                print("Wrote %s" % args.json)
            return
        for h in out["harnesses"]:
            print("%s (%s): unmeasured=%d degraded_rules=%d session_store=%s fold=%s" % (
                h["id"], h["display"], len(h["unmeasured_signals"]),
                len(h["degraded_rules"]), str(h["session_store"]).lower(),
                h["fold"] or "none"))
        return

    # D11：执行时长审计——与 Rust 侧 main.rs 的 DurationAudit 子命令同一种结构
    # （独立子命令 + --json 输出同一份 core 结果 + 人读格式加"最慢的几条"）。
    if getattr(args, "cmd", None) == "duration-audit":
        audit = behavior_module.audit_session_log(args.session_log)
        if audit is None:
            print("session log unavailable: unreadable, malformed, or schema mismatch",
                  file=sys.stderr)
            sys.exit(2)
        duration = audit[9]
        if args.json:
            text = json.dumps(duration, ensure_ascii=False, indent=2)
            if args.json == "-":
                print(text)
            else:
                Path(args.json).write_text(text, encoding="utf-8")
                print("Wrote %s" % args.json)
            return
        tool_calls = duration["tool_calls"]
        turns = duration["turns"]
        steps = duration["steps"]
        approvals = duration["approvals"]
        hooks = duration["hooks"]["executions"]
        if not (tool_calls or turns or steps or approvals or hooks):
            print("No duration data found in session log.")
            return
        print("Tool calls: %d · Turns: %d · Steps: %d · Approvals: %d · Hook executions: %d" % (
            len(tool_calls), len(turns), len(steps), len(approvals), len(hooks)))
        # 最慢的几条工具调用——duration_ms 缺失（incomplete/failed 没等到结果）
        # 的排除在外，不是当成 0（那样反而会排到最前，读成"最快"）。
        timed = [r for r in tool_calls if r["duration_ms"] is not None]
        timed.sort(key=lambda r: r["duration_ms"], reverse=True)
        if timed:
            print("\nSlowest tool calls:")
            for row in timed[:5]:
                name = row["tool_name"] or "(unknown)"
                print("  %s — %dms (%s)" % (name, row["duration_ms"], row["load_status"]))
        return

    # P4（docs/RUNTIME_EVIDENCE_CONTRACT.md §17）：Codex rollout → CanonicalSession
    # 的 "sound" 证明。输出 §13 coverage，不是 findings——Codex 还没有 SV601–614
    # 检测器（detector decoupling 是后置的更大一摊，P4 明确不做）。`--harness
    # codex` 是安装时探针的表面，与这个子命令无关（命名冲突见
    # adapters/codex_session.py 顶部注释）。与 Rust 侧 main.rs 的 CodexEvidence
    # 子命令同一种结构（独立子命令 + --json 输出同一份 core 结果 + 人读呈现）。
    if getattr(args, "cmd", None) == "codex-evidence":
        from agent_vitals.adapters import codex_session
        if args.roots:
            report = codex_session.codex_session_roots_report()
            if args.json:
                text = json.dumps(report, ensure_ascii=False, indent=2)
                if args.json == "-":
                    print(text)
                else:
                    try:
                        Path(args.json).write_text(text, encoding="utf-8")
                    except OSError:
                        print("failed to write %s" % args.json, file=sys.stderr)
                        sys.exit(2)
                    print("Wrote %s" % args.json)
            else:
                print(_render_codex_roots(report), end="")
            return
        if not args.session_log:
            # argparse 的 required 表达不了「session_log 或 --roots 二选一」，
            # 只能在 handler 里手动挡。退出码 2 是 usage 错误（clap 的
            # required_unless_present 在 Rust 侧做同一件事）。
            ap.error("session_log is required unless --roots")
        parsed = codex_session.read_codex_session_log(args.session_log)
        if isinstance(parsed.get("degraded"), str):
            print("session log unavailable: unreadable, malformed, or empty",
                  file=sys.stderr)
            sys.exit(2)
        items = parsed["items"] or []
        session_id = parsed.get("session_id")
        if session_id is None:
            # §14.4 back-fill：session_meta 缺席时退回文件名，保证 session 永远
            # 可指认（与 behavior 的 dsh session_id 同款兜底）。
            session_id = Path(args.session_log).stem
        # 标题从 ~/.codex/session_index.jsonl 查（索引缺失/不在索引 → None，存在性
        # 探测，绝不报错——与 read_session_index 的缺席铁律一致）。
        title = codex_session.read_session_index().get(session_id)
        evidence = codex_evidence_module.build_codex_evidence(
            items, session_id, title, parsed.get("history_mode"),
            parsed.get("cli_version"), parsed.get("workspace_roots") or [],
            parsed.get("model"))
        if args.json:
            text = json.dumps(codex_evidence_module.codex_evidence_json(evidence),
                              ensure_ascii=False, indent=2)
            if args.json == "-":
                print(text)
            else:
                try:
                    Path(args.json).write_text(text, encoding="utf-8")
                except OSError:
                    print("failed to write %s" % args.json, file=sys.stderr)
                    sys.exit(2)
                print("Wrote %s: %d signals" % (args.json,
                                                len(evidence["canonical"]["signals"])))
            return
        print(_render_codex_evidence(
            codex_evidence_module.codex_evidence_json(evidence)), end="")
        return

    # Codex 单会话审计：逐 session 成本 + 出处覆盖并集。与 Rust main.rs 的
    # CodexSession handler 同一种结构：--list 只是选 id 的前置（id/标题/模型/
    # 文件数/时间跨度）；缺省 --session = 最新（list 排序首项 = 末行时间戳最晚）；
    # 单会话深挖是 --json/--html/文本三路。HTML 是新模板 codex_session.html
    # （套 DSH 审计 tab 的 .sv-* 视觉约定），JSON 经 </script>/<!-- 转义内联。
    if getattr(args, "cmd", None) == "codex-session":
        from agent_vitals import codex_session_audit as cs
        if args.list:
            if args.html:
                print("--list only supports --json or plain text, not --html",
                      file=sys.stderr)
                sys.exit(2)
            out = cs.codex_session_list()
            if args.json:
                text = json.dumps(out, ensure_ascii=False, indent=2)
                if args.json == "-":
                    print(text)
                else:
                    try:
                        Path(args.json).write_text(text, encoding="utf-8")
                    except OSError:
                        print("failed to write %s" % args.json, file=sys.stderr)
                        sys.exit(2)
                    print("Wrote %s" % args.json)
            else:
                print(cs._render_list(out), end="")
            return
        if args.session is None:
            lst = cs.codex_session_list()
            sessions = lst.get("sessions") or []
            if not sessions:
                print("no codex sessions found", file=sys.stderr)
                sys.exit(2)
            session_id = sessions[0].get("session_id")
        else:
            session_id = args.session
        out = cs.codex_session_audit_json(None, session_id)
        if out is None:
            print("codex session not found: %s" % session_id, file=sys.stderr)
            sys.exit(2)
        wrote = False
        if args.json:
            text = json.dumps(out, ensure_ascii=False, indent=2)
            if args.json == "-":
                print(text)
            else:
                try:
                    Path(args.json).write_text(text, encoding="utf-8")
                except OSError:
                    print("failed to write %s" % args.json, file=sys.stderr)
                    sys.exit(2)
                print("Wrote %s" % args.json)
            wrote = True
        if args.html:
            cs._render_codex_session_html(args.html, out)
            wrote = True
        if not wrote:
            print(cs._render_audit(out), end="")
        return

    # Claude Code 单会话审计：coverage（§13 逐信号）+ SV601–614 findings。与 Rust
    # main.rs 的 ClaudeSession handler 同一种结构：--list 只是选 id 的前置
    # （id/标题/模型/工作目录/时间跨度）；缺省 --session = 最新（list 排序首项 =
    # 末行时间戳最晚）；单会话深挖是 --json/纯 JSON 两路，**没有 --html**——Claude
    # 侧还没有模板，缺省输出就是 pretty JSON（Rust 同款，无 human render）。
    if getattr(args, "cmd", None) == "claude-session":
        from agent_vitals import claude_session_audit as clsa
        if args.list:
            out = clsa.claude_session_list()
            if args.json:
                text = json.dumps(out, ensure_ascii=False, indent=2)
                if args.json == "-":
                    print(text)
                else:
                    try:
                        Path(args.json).write_text(text, encoding="utf-8")
                    except OSError:
                        print("failed to write %s" % args.json, file=sys.stderr)
                        sys.exit(2)
                    print("Wrote %s" % args.json)
            else:
                print(clsa._render_list(out), end="")
            return
        if args.session is None:
            lst = clsa.claude_session_list()
            sessions = lst.get("sessions") or []
            if not sessions:
                print("no claude sessions found", file=sys.stderr)
                sys.exit(2)
            session_id = sessions[0].get("session_id")
        else:
            session_id = args.session
        out = clsa.claude_session_audit_json(None, session_id)
        if out is None:
            print("claude session not found or unreadable: %s" % session_id,
                  file=sys.stderr)
            sys.exit(2)
        text = json.dumps(out, ensure_ascii=False, indent=2)
        if args.json:
            if args.json == "-":
                print(text)
            else:
                try:
                    Path(args.json).write_text(text, encoding="utf-8")
                except OSError:
                    print("failed to write %s" % args.json, file=sys.stderr)
                    sys.exit(2)
                print("Wrote %s" % args.json)
        else:
            print(text)
        return

    # Claude Code 会话账 fold。与 Rust main.rs 的 ClaudeSync handler 同一种结构：
    # home 从 HOME/USERPROFILE 解析（claude_project_files 的根）；fencing 失败
    # 快速 exit 2（同 oneline 写者纪律）；fold 内部单文件坏行只计 failed、不
    # abort——只有 fencing/IO 硬错才到这里。
    if getattr(args, "cmd", None) == "claude-sync":
        from agent_vitals import claude_cost as cc
        home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or ""
        try:
            cc.claude_sync(Path(home), shadow=getattr(args, "shadow", False))
        except ValueError as e:
            print(str(e), file=sys.stderr)
            sys.exit(2)
        return

    # Stage 1 commit 2：Claude UsageFact 诊断 CLI（v0.7 spec §3 候选 #3）。
    # 单份 JSONL → facts + attempts + coverage；不写盘。与 Rust 镜像同源字节。
    if getattr(args, "cmd", None) == "claude-usage-facts":
        from agent_vitals.agent import claude_usage_fact as cuf
        # machine_namespace 必传（spec §9）。绝不让 CLI 读 takeover 身份来补齐：
        # 那是一次隐式 state 写（bootstrap machine.json），而 claude-usage-facts
        # 是只读诊断——缺失即失败（exit 2），与 Rust handler 同款。
        if not args.machine_namespace:
            print(
                "claude-usage-facts: --machine-namespace is required "
                "(v0.7 spec §9: caller-provided; a CLI default would write state)",
                file=sys.stderr)
            sys.exit(2)
        machine_ns = args.machine_namespace
        sid = Path(args.session_jsonl).stem
        try:
            result = cuf.claude_jsonl_to_usage_facts(
                Path(args.session_jsonl),
                machine_namespace=machine_ns,
                source_profile=args.source_profile,
                native_session_id=sid,
            )
        except (OSError, ValueError) as e:
            print("claude-usage-facts failed: %s" % e, file=sys.stderr)
            sys.exit(2)
        # --json: 写文件或 stdout；否则人读摘要。
        facts_out = {
            "native_session_id": sid,
            "machine_namespace": machine_ns,
            "source_profile": args.source_profile,
            "facts": result.facts,
            "attempts": result.attempts,
            "coverage": result.coverage,
            "malformed": result.malformed,
        }
        text = json.dumps(facts_out, ensure_ascii=False, indent=2)
        if args.json:
            if args.json == "-":
                print(text)
            else:
                Path(args.json).write_text(text, encoding="utf-8")
                print("Wrote %s: %d facts" % (args.json, len(result.facts)))
        else:
            print("Source: %s" % args.session_jsonl)
            print("Native session id: %s" % sid)
            print("Machine namespace: %s" % machine_ns)
            print("Source profile: %s" % args.source_profile)
            print("Facts: %d (rows=%s, skip=%s)"
                  % (len(result.facts),
                     result.coverage["total_rows"],
                     result.coverage["skip_rows"]))
            print("Attempts: %s" % result.attempts)
        return

    # HARNESS_MANIFEST_DSL_SPEC §8.1：plugin-validate handler——只读，负载键序
    # 与 Rust `plugin-validate --json` 一致（golden parity 面）。
    if getattr(args, "cmd", None) == "manifest-validate":
        from agent_vitals.agent import generic_plugin
        files = [Path(f) for f in args.file] if args.file else []
        payload = generic_plugin.plugin_validate_payload(
            args.manifest, files, args.machine_namespace,
            os.environ.get("HOME", ""))
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        gate = payload.get("gate")
        if payload.get("error") is not None or gate != "pass":
            sys.exit(2)
        return

    # Stage 2 commit 2：Codex UsageFact 诊断 CLI（v0.7 spec §3 候选 #3，决策
    # A/D′）。一份或多份 rollout JSONL → facts + attempts + coverage；不写盘。
    # 与 Rust 镜像同源字节（parity 在 tests/test_codex_usage_fact.py）。
    if getattr(args, "cmd", None) == "workbuddy-usage-facts":
        from agent_vitals.agent import workbuddy_usage_fact as wuf
        if not args.machine_namespace:
            print(
                "workbuddy-usage-facts: --machine-namespace is required "
                "(v0.7 spec §9: caller-provided; a CLI default would write state)",
                file=sys.stderr)
            sys.exit(2)
        machine_ns = args.machine_namespace
        try:
            result = wuf.workbuddy_traces_to_usage_facts(
                Path(args.root), machine_namespace=machine_ns,
                source_profile=args.source_profile)
        except OSError as e:
            print("workbuddy-usage-facts failed: %s" % e, file=sys.stderr)
            sys.exit(2)
        # 键序与 Rust to_payload_value 一致；attempts 只在 bad_id > 0 时带该键。
        attempts_out = {k: result.attempts.get(k, 0) for k in ("skip", "unreadable", "unattributed")}
        if result.attempts.get("bad_id", 0) > 0:
            attempts_out["bad_id"] = result.attempts["bad_id"]
        facts_out = {
            "machine_namespace": machine_ns,
            "source_profile": args.source_profile,
            "facts": result.facts,
            "attempts": attempts_out,
            "coverage": result.coverage,
            "malformed": result.malformed,
        }
        text = json.dumps(facts_out, ensure_ascii=False, indent=2)
        if args.json:
            if args.json == "-":
                print(text)
            else:
                Path(args.json).write_text(text, encoding="utf-8")
                print("Wrote %s: %d facts" % (args.json, len(result.facts)))
        else:
            print("Source: %s" % args.root)
            print("Machine namespace: %s" % machine_ns)
            print("Source profile: %s" % args.source_profile)
            print("Facts: %d (total_generation_spans=%s, skip=%s)"
                  % (len(result.facts),
                     result.coverage["total_generation_spans"],
                     result.coverage["skip_rows"]))
            print("Attempts: %s" % attempts_out)
        return

    if getattr(args, "cmd", None) == "codex-usage-facts":
        from agent_vitals.agent import codex_usage_fact as cuf
        # machine_namespace 必传（spec §9）。绝不让 CLI 读 takeover 身份来补齐：
        # 那是一次隐式 state 写（bootstrap machine.json），而 codex-usage-facts
        # 是只读诊断——缺失即失败（exit 2），与 Rust handler 同款。
        if not args.machine_namespace:
            print(
                "codex-usage-facts: --machine-namespace is required "
                "(v0.7 spec §9: caller-provided; a CLI default would write state)",
                file=sys.stderr)
            sys.exit(2)
        machine_ns = args.machine_namespace
        rollout_paths = [Path(p) for p in args.rollouts]
        try:
            result = cuf.codex_rollouts_to_usage_facts(
                rollout_paths,
                machine_namespace=machine_ns,
                source_profile=args.source_profile,
            )
        except OSError as e:
            print("codex-usage-facts failed: %s" % e, file=sys.stderr)
            sys.exit(2)
        # --json: 写文件或 stdout；否则人读摘要。键序与 Rust to_payload_value 一致。
        facts_out = {
            "machine_namespace": machine_ns,
            "source_profile": args.source_profile,
            "facts": result.facts,
            "attempts": result.attempts,
            "coverage": result.coverage,
            "malformed": result.malformed,
        }
        text = json.dumps(facts_out, ensure_ascii=False, indent=2)
        if args.json:
            if args.json == "-":
                print(text)
            else:
                Path(args.json).write_text(text, encoding="utf-8")
                print("Wrote %s: %d facts" % (args.json, len(result.facts)))
        else:
            print("Source: %s" % ", ".join(str(p) for p in rollout_paths))
            print("Machine namespace: %s" % machine_ns)
            print("Source profile: %s" % args.source_profile)
            print("Facts: %d (total_token_count_events=%s, skip=%s)"
                  % (len(result.facts),
                     result.coverage["total_token_count_events"],
                     result.coverage["skip_rows"]))
            print("Attempts: %s" % result.attempts)
        return

    if getattr(args, "cmd", None) == "dsh-usage-facts":
        from agent_vitals.agent import dsh_usage_fact as duf
        # machine_namespace 必传（spec §9），同 codex-usage-facts：绝不让 CLI
        # 读 takeover 身份补齐（那是隐式 state 写），缺失即失败（exit 2）。
        if not args.machine_namespace:
            print(
                "dsh-usage-facts: --machine-namespace is required "
                "(v0.7 spec §9: caller-provided; a CLI default would write state)",
                file=sys.stderr)
            sys.exit(2)
        machine_ns = args.machine_namespace
        try:
            result = duf.dsh_session_to_usage_facts(
                args.path,
                machine_namespace=machine_ns,
                source_profile=args.source_profile,  # None → header cwd 派生
            )
        except duf.DshUsageFactError as e:
            # strict 硬错误（读/解码/解析/身份/归属/duplicate）→ exit 2，不出
            # 空成功伪装「没有用量」。Rust handler 输出同一 "code: message"。
            print("dsh-usage-facts failed: %s" % e, file=sys.stderr)
            sys.exit(2)
        # --json payload = spec §5 字面 {facts, coverage}（键序固定，Rust
        # to_payload_value 同款）。facts 是 build_usage_fact 输出、coverage 四键。
        facts_out = {"facts": result.facts, "coverage": result.coverage}
        text = json.dumps(facts_out, ensure_ascii=False, indent=2)
        if args.json:
            if args.json == "-":
                print(text)
            else:
                try:
                    Path(args.json).write_text(text, encoding="utf-8")
                except OSError as e:
                    print("failed to write %s: %s" % (args.json, e),
                          file=sys.stderr)
                    sys.exit(2)
                print("Wrote %s: %d facts" % (args.json, len(result.facts)))
        else:
            print("Source: %s" % args.path)
            print("Machine namespace: %s" % machine_ns)
            print("Facts: %d (observation_rows=%s, unaccounted_events=%s, "
                  "unaccounted_tokens=%s)"
                  % (len(result.facts),
                     result.coverage["observation_rows"],
                     result.coverage["unaccounted_events"],
                     result.coverage["unaccounted_tokens"]))
            print("Coverage: %s" % result.coverage)
        return

    # WorkBuddy 单会话审计：coverage + SV601–614 findings（SV604/605 降级 Unavailable，
    # 成本吃 credit_json 执行环境账单）。与 claude-session 同构：--list 只是选 id 的前置
    # （id/标题/模型/时间跨度，db sessions 表是索引）；缺省 --session = 最新；单会话
    # 深挖是 --json/纯 JSON 两路，无 --html（缺省输出就是 pretty JSON，Rust 同款）。
    if getattr(args, "cmd", None) == "workbuddy-session":
        from agent_vitals import workbuddy_session_audit as wbsa
        if args.list:
            out = wbsa.workbuddy_session_list()
            if args.json:
                text = json.dumps(out, ensure_ascii=False, indent=2)
                if args.json == "-":
                    print(text)
                else:
                    try:
                        Path(args.json).write_text(text, encoding="utf-8")
                    except OSError:
                        print("failed to write %s" % args.json, file=sys.stderr)
                        sys.exit(2)
                    print("Wrote %s" % args.json)
            else:
                print(wbsa._render_list(out), end="")
            return
        if args.session is None:
            lst = wbsa.workbuddy_session_list()
            sessions = lst.get("sessions") or []
            if not sessions:
                print("no workbuddy sessions found", file=sys.stderr)
                sys.exit(2)
            session_id = sessions[0].get("session_id")
        else:
            session_id = args.session
        out = wbsa.workbuddy_session_audit_json(None, session_id)
        if out is None:
            print("workbuddy session not found or unreadable: %s" % session_id,
                  file=sys.stderr)
            sys.exit(2)
        text = json.dumps(out, ensure_ascii=False, indent=2)
        if args.json:
            if args.json == "-":
                print(text)
            else:
                try:
                    Path(args.json).write_text(text, encoding="utf-8")
                except OSError:
                    print("failed to write %s" % args.json, file=sys.stderr)
                    sys.exit(2)
                print("Wrote %s" % args.json)
        else:
            print(text)
        return

    # ──── Sessions handler（v0.9.1 PR #4.5：sessions_sql 直连权威库）──
    # 透传 argparse 结果到 `agent_vitals.agent.sessions_sql.{sessions_search,
    # session_detail, sessions_navigation}`——三个函数都返回 dict,JSON 序列
    # 化后落到 stdout。CLI 仅是 envelope 搬运工,不在此层做字段筛选 / 转换 /
    # 过滤(Rust CLI `apps/cli/src/main.rs` SessionsAction 同款薄壳)。
    if getattr(args, "cmd", None) == "sessions":
        from agent_vitals.agent import sessions_sql
        action = getattr(args, "sessions_action", None)
        home = data_home()
        if action == "list":
            payload = {
                "date": getattr(args, "day", None),
                "month": getattr(args, "month", None),
                "hour": getattr(args, "hour", None),
                "harnesses": getattr(args, "harness_kind", None) or [],
                "min_tokens": getattr(args, "min_tokens", 0) or 0,
                "limit": getattr(args, "page_size", 50) or 50,
                "cursor": getattr(args, "cursor", None),
                "as_of_run_id": getattr(args, "as_of_run_id", None),
            }
            env = sessions_sql.sessions_search(payload, home)
        elif action == "read":
            payload = {
                "session_ref": getattr(args, "session_ref", ""),
                "limit": getattr(args, "page_size", 200) or 200,
                "cursor": getattr(args, "cursor", None),
                "as_of_run_id": getattr(args, "as_of_run_id", None),
            }
            env = sessions_sql.session_detail(payload, home)
        elif action == "navigation":
            day = getattr(args, "day", "")
            timezone_name = getattr(args, "timezone", None)
            if timezone_name is not None and sessions_sql.validate_timezone(timezone_name) is None:
                print("sessions navigation: invalid IANA timezone %s" % timezone_name, file=sys.stderr)
                sys.exit(2)
            nav = sessions_sql.sessions_navigation(
                day, getattr(args, "recent", 5), home, timezone_name=timezone_name,
            )
            # envelope 序列化
            if getattr(args, "json", False):
                print(json.dumps(nav, ensure_ascii=False, indent=2))
            else:
                # 人读 fallback：列 harnesses[] 每 harness 今日 token / 会话数
                # + recent 行;非 workbench 调路径,简单展示即可。
                print("navigation %s" % nav.get("day_key", day))
                for h in nav.get("harnesses", []):
                    tok = h.get("today_tokens", {})
                    val = tok.get("value") if isinstance(tok, dict) else None
                    today = ("—" if val is None else str(val))
                    print("  %-12s [%s] today=%s tokens, %d sessions, %d recent" % (
                        h.get("harness_kind"), h.get("status"), today,
                        h.get("today_sessions", 0), len(h.get("recent", [])),
                    ))
            return
        else:
            print("sessions: unknown action %r" % action, file=sys.stderr)
            sys.exit(2)
        # envelope 路径：list / read 走 JSON 序列化
        if env.get("error") and not env.get("data"):
            # 错误 envelope 也要原样输出(--json),但 exit 码非零
            print(json.dumps(env, ensure_ascii=False, indent=2))
            sys.exit(1)
        if getattr(args, "json", False):
            print(json.dumps(env, ensure_ascii=False, indent=2))
        else:
            # 人读 fallback：sessions[] 表 / timeline 表
            data = env.get("data") or {}
            window = data.get("window") or {}
            print("window: %s" % window.get("label"))
            if "sessions" in data:
                print("%-35s  %-10s  %-10s  %s" % (
                    "session_ref", "harness", "tokens", "events",
                ))
                for s in data["sessions"]:
                    tot = (s["tokens"]["uncached_input_tokens"]
                           + s["tokens"]["cache_read_tokens"]
                           + s["tokens"]["cache_write_tokens"]
                           + s["tokens"]["output_tokens"])
                    print("%-35s  %-10s  %-10d  %d" % (
                        s["session_ref"], s["harness"], tot, s["event_count"],
                    ))
            elif "timeline" in data:
                print("session_ref=%s harness=%s total=%d events=%d" % (
                    data.get("session_ref"),
                    data.get("harness"),
                    data.get("tokens", {}).get("total", 0),
                    data.get("event_count", 0),
                ))
                for f in data["timeline"]:
                    tot = sum(f["tokens"].get(k, 0) for k in (
                        "uncached_input_tokens", "cache_read_tokens",
                        "cache_write_tokens", "output_tokens",
                    ))
                    print("  %s  %-20s  tokens=%d" % (
                        f["event_at"], (f.get("model_id") or "<unknown>")[:20], tot,
                    ))
        return

    # ──── M3 oneline handler ──────────────────────────────────────
    # 与 behavior 同源（同一个 audit_session_log），但**额外**把 hour_buckets
    # 折进 today.json / month.json。审计成本：每会话多跑一次 hour_buckets 折叠
    # （纯函数、与 token_by_model 同采样路径，无额外 I/O）。
    if getattr(args, "cmd", None) == "oneline":
        # R1d: Python 写链退休为 mirror —— writer fencing（§4.2）。owner=rust
        # 时拒绝写（防迁移期双写）；缺 manifest → owner=python → 正常写
        # （R1 之前 Python 是唯一写者）。挡在最前面，省得审计半天才拒。
        if not takeover_module.owner_allows_python():
            print("writer fencing: state owned by rust; python oneline is a "
                  "retired mirror (run `state takeover python` to roll back)",
                  file=sys.stderr)
            sys.exit(2)
        audit = behavior_module.audit_session_log(args.session_log)
        if audit is None:
            print("session log unavailable: unreadable, malformed, or schema mismatch",
                  file=sys.stderr)
            sys.exit(2)
        (findings, usage, requests, ctx, compaction, waste, pre_fork, subagents, skill,
         duration, _rule_outcomes, _usage_coverage, _duration_coverage, _skill_coverage,
         _subagents_coverage, _compaction_coverage, _waste_coverage) = audit
        pricing = cost_module.load_pricing()
        cost = cost_module.cost_report(usage, pricing)
        if cost is None:
            print("warning: cost_report returned None (no usage samples to price)",
                  file=sys.stderr)
            cost = {"total": 0, "peak_total": 0, "unpriced_tokens": 0,
                    "currency": "CNY"}
        # hour_buckets 复用 token_by_model 的同 step 去重 + peak/off-peak 判定。
        # 与 token_by_model 的不变量已由 tests/test_characterization.py::TestHourBuckets
        # 钉死 —— 两边加起来必须字节相等。
        # 这里再读一次 events 列表（audit_session_log 自己内部读了一次）——
        # 双读换「不破坏 audit_session_log 签名」的简洁性，且 oneline 是
        # 5min tick 而非实时路径，多读一次 JSONL 的成本可忽略。
        from agent_vitals.adapters.dsh import read_session_log
        session = read_session_log(args.session_log)
        events = (session or {}).get("usage_events") or []
        hb = usage_module.hour_buckets(events)
        # 把 cost / hb 折成「一行摘要」。**不要**塞 findings / requests 全文——
        # oneline.json 是 xbar 5min tick 读的，塞多了每次都序列化浪费。
        # tokens_total 必须与 hour_buckets 的 4 桶之和**逐字节相等**
        # (tests/test_cli_m3::TestUsageHourBucketsReconcile 钉死)——
        # 所以这里取 4 桶全量,与 token_by_model 同源。
        tokens_total = sum(
            m["uncached_input_tokens"] + m["output_tokens"]
            + m["cache_read_tokens"] + m["cache_write_tokens"]
            for m in usage["by_model"].values())
        tokens_peak = sum(
            m["peak_uncached_input_tokens"] + m["peak_output_tokens"]
            + m["peak_cache_read_tokens"] + m["peak_cache_write_tokens"]
            for m in usage["by_model"].values())
        # session_id / duration_ms：日志 schema 没显式字段时用文件名 + None
        # 兜底 ——「没数据」与「数据为 0」是两回事（CLAUDE.md §缺列不编列）。
        session_id = Path(args.session_log).stem
        # R1d exactly-once（§4.3）：同一 session_log 连续多 tick 只折一次。
        # 已由 Rust / 本 mirror 折过 → 整段跳过（today/month/history 不重复
        # 累加，oneline/alert 本来就是覆盖快照）。日志**增长**也跳过 —— 宁可
        # 少计也不翻倍，增量重 fold 是 R3 watcher 的 `fold_resume` 差事。
        _session_key = takeover_module.session_key(
            "dsh", session_id, takeover_module.machine_namespace())
        if takeover_module.folded(_session_key):
            print("dedup: session %s already folded; skipping (exactly-once, §4.3)"
                  % session_id)
            return
        duration_ms = None
        for ev in events:
            if isinstance(ev, dict) and ev.get("type") == "session/end":
                end = ev.get("time")
                if isinstance(end, int) and isinstance(duration_ms, type(None)):
                    duration_ms = end
                    break
        max_sev = "none"
        sev_rank = {"critical": 4, "warning": 3, "info": 2}
        for f in findings:
            r = sev_rank.get(f.get("severity"), 0)
            if r > sev_rank.get(max_sev, 0):
                max_sev = f["severity"]
        summary = {
            "session_id": session_id,
            "session_log": str(args.session_log),
            "duration_ms": duration_ms,
            "model": (list(usage["by_model"].keys()) or ["unknown"])[0],
            "tokens_total": tokens_total,
            "tokens_peak": tokens_peak,
            "cost_cny": cost["total"],
            "cost_peak_cny": cost["peak_total"],
            "unpriced_tokens": cost["unpriced_tokens"],
            "findings_total": len(findings),
            "findings_max_severity": max_sev,
            "hour_buckets_summary": {
                "bucket_count": len(hb["buckets"]),
                "min_date": (hb["buckets"][0]["date"]
                             if hb["buckets"] else None),
                "max_date": (hb["buckets"][-1]["date"]
                             if hb["buckets"] else None),
                "tz_name": hb["tz_name"],
            },
        }
        p_oneline = state_module.write_oneline(summary)
        if not args.no_merge:
            # **两个状态文件都喂按 (date, model) 折的那一份**，不是整段
            # `usage["by_model"]`。
            #
            # 曾经 today.json 收的是整段 by_model，理由写着"today.json 只
            # 代表今天这一个桶，不需要按日拆"——那个推理有个隐含前提：
            # 「喂进来的 session 整段都发生在今天」。真实数据不满足：一个
            # session 可以跨 08-23/08-26/08-27 三天（长会话 + 中途 compact），
            # 于是 hour 桶被正确过滤成只剩今天的 245,760 token，而 by_model
            # 仍是整段的 17,596,160——同一个 today.json 里两个字段差 70 倍，
            # 「今日估算成本」（读 by_model）因此报出整段会话的钱。
            #
            # 现在 `token_by_date_model` 能给出精确的当日切片，直接取
            # `[今天]` 那一份；没有今天的数据时是 None，`merge_today` 照
            # 既有语义不写 by_model 字段。month.json 拿整份多日 dict，各
            # 日期各自归位（见 state.merge_month 的文档注释）。
            # oneline 是 CLI 喂入路径（tick/手动审计都走这条命令）——标 `cli`。
            # 来源只能来自调用方显式标注：把一次 oneline 喂的会话标成 dsh-live
            # （watcher 增量）或 codex（导入）都是**编造**，诊断「同一批被喂了几
            # 次」时会被一个假来源键污染。
            by_date_model = usage_module.token_by_date_model(
                events, source=usage_module.SOURCE_CLI)
            state_module.merge_today(
                hb, by_model=by_date_model.get(state_module._today_key()))
            state_module.merge_month(hb, by_date_model=by_date_model)
        # 不管 --no-merge 与否都 append 历史 —— xbar「最近 5 次审计」要靠这个
        state_module.append_session_history(summary)
        # 顺手把 budget.evaluate() 落盘成 alert.json —— xbar 之前完全绕开
        # budget.py，自己在 bash 里硬编码阈值重算一遍百分比，用户改的
        # daily_cny / adaptive floor / snooze 全部对菜单栏不生效。
        # today.json / month.json 已经 merge 完，evaluate() 读的是最新状态。
        alert = budget_module.evaluate()
        state_module.write_alert(alert)
        # R1d 提交点：ledger 记 key + manifest epoch+1/last_fold_at（与 Rust
        # fold 驱动同写序：state 文件先折、ledger 记、manifest 最后提交）。
        # 提交后才算「这个会话已经折过」，下次 oneline 同 log 被 dedup 跳过。
        takeover_module.record_fold(
            _session_key, "dsh", session_id, takeover_module.machine_namespace())
        # 顺手把日历 HTML 刷新到 $STATE_DIR/calendar.html —— xbar「打开
        # 日历」菜单项直接 open 这个固定路径,不需要知道 repo 装在哪里
        # （已安装的 xbar 副本本来就跟 repo 断了联系）。渲染失败(模板缺失
        # 之类)只警告,不中断审计主路径——calendar.html 是展示层产物,
        # 不是审计结果的一部分。
        try:
            _render_calendar_html(state_module.state_dir() / "calendar.html",
                                  default_source="month")
        except Exception as e:
            print("warning: failed to refresh calendar.html: %s" % e, file=sys.stderr)
        # 人读输出 —— 让没装 xbar 的用户在终端也能看一眼「这一会话花了多少」。
        print("session:    %s" % summary["session_id"])
        print("duration:   %s ms" % (summary["duration_ms"] or "?"))
        print("model:      %s" % summary["model"])
        print("tokens:     %s (peak %s)" % (summary["tokens_total"], summary["tokens_peak"]))
        print("cost:       ¥%.4f (peak ¥%.4f)" % (summary["cost_cny"], summary["cost_peak_cny"]))
        if summary["unpriced_tokens"]:
            print("unpriced:   %d tokens (model not in pricing.json)"
                  % summary["unpriced_tokens"])
        print("findings:   %d (max severity: %s)"
              % (summary["findings_total"], summary["findings_max_severity"]))
        if alert["level"] != "disabled":
            print("budget:     %s" % alert["level"])
        print("state:      %s" % p_oneline)
        return

    # ──── M3 calendar handler ─────────────────────────────────────
    # 渲染逻辑在 _render_calendar_html()——oneline 每次跑完也会调它把
    # $STATE_DIR/calendar.html 刷新一遍，供 xbar「打开日历」菜单项用，
    # 两处共用同一份逻辑，不各写一份互相不一致。
    if getattr(args, "cmd", None) == "calendar":
        try:
            embedded, out = _render_calendar_html(args.output, default_source=args.source)
        except FileNotFoundError as e:
            print(str(e), file=sys.stderr)
            sys.exit(2)
        if embedded:
            print("rendered: %s (%d bytes, inline: %s, default tab: %s)"
                  % (out, out.stat().st_size, "+".join(embedded), args.source))
        else:
            # 两份都没有：HTML 仍然渲染,JS 检测到内联数据缺失 → 显示
            # 「无数据」empty state,而不是凭空编一个空 calendar。
            print("rendered: %s (no today.json/month.json yet — "
                  "calendar will show empty state)" % out)
        return

    # ──── M3 state list / clean / months / by-source ───────────────
    if getattr(args, "cmd", None) == "state":
        if args.action == "by-source":
            # per-source 拆账：读 month.json 的逐日 by_source，折平成
            # {source: {model: 八桶}}，再按主账单同一套 cost_report 计价。
            # 月份没有 by_source（老数据）→ 两个键都空，不摆全零结构。
            month = state_module._read(state_module.state_dir() / "month.json") or {}
            rollup = state_module.rollup_by_source(month)
            if not rollup:
                print(json.dumps({"by_source": {}, "by_source_cost": None},
                                 ensure_ascii=False))
                return
            report = cost_module.cost_report({"by_source": rollup},
                                             cost_module.load_pricing())
            print(json.dumps({"by_source": rollup, "by_source_cost": report},
                             ensure_ascii=False, indent=2))
            return
        if args.action == "by-model":
            # v0.7 spec §3「按 provider/model 月成本」的首个落地输出面：零新
            # 数据、零新持久化——把 month.json 逐日 by_model 折平成月度粒度
            # （`state.rollup_by_model`），复用既有 `cost_report` 计价，与
            # `by-source` 同一套读法只是折平的键换成模型名。月份没有 by_model
            # （老数据）→ 两个键都空，不摆全零结构。
            month = state_module._read(state_module.state_dir() / "month.json") or {}
            rollup = state_module.rollup_by_model(month)
            if not rollup:
                print(json.dumps({"by_model": {}, "by_model_cost": None},
                                 ensure_ascii=False))
                return
            report = cost_module.cost_report({"by_model": rollup},
                                             cost_module.load_pricing())
            print(json.dumps({"by_model": rollup, "by_model_cost": report},
                             ensure_ascii=False, indent=2))
            return
        if args.action == "uncovered":
            # v0.7 spec §3 第二行：未落入已声明订阅覆盖范围（估算）。DSH 8 桶
            # 形状 → Claude 4 型 snake 形状的薄适配（peak_* 丢弃、其他键按
            # catalog 输入约定改名），然后调
            # `cost.claude_subscription_uncovered_estimate`——core 是单一
            # 定价决策点，不在这里二次改写 pricing_basis。月份没有 by_model
            # → 两个键都空，不摆全零结构（与 by-model 同款诚实降级）。
            month = state_module._read(state_module.state_dir() / "month.json") or {}
            rollup = state_module.rollup_by_model(month)
            if not rollup:
                print(json.dumps({"by_model": {}, "uncovered": None},
                                 ensure_ascii=False))
                return
            claude_models = {}
            for model, buckets in rollup.items():
                if not isinstance(buckets, dict):
                    continue
                claude_models[model] = {
                    "input_tokens": buckets.get("uncached_input_tokens") or 0,
                    "cache_read_input_tokens": buckets.get("cache_read_tokens") or 0,
                    "cache_creation_input_tokens": buckets.get("cache_write_tokens") or 0,
                    "output_tokens": buckets.get("output_tokens") or 0,
                }
            uncovered = cost_module.claude_subscription_uncovered_estimate(
                claude_models, cost_module.load_pricing())
            print(json.dumps({"by_model": claude_models, "uncovered": uncovered},
                             ensure_ascii=False, indent=2))
            return
        if args.action == "savings":
            # v0.7 spec §3 第三行：名义 vs 实际单位成本（节约因子）。月级数据
            # 没有 `providers`（month.json 不存），各家模型自然走 fallback 价
            # 卡——与 priced_day 对同一份 month.json 的处理一致。无缓存命中
            # 的语料下 ratio 恒为 1.0（spec §3 原文引用，2026-09-02 实测值），
            # 不是 bug——这是"当前能表达的节约来源只有缓存"这一事实的忠实反映。
            # 月份没有 by_model → 两个键都空，不摆全零结构。
            month = state_module._read(state_module.state_dir() / "month.json") or {}
            rollup = state_module.rollup_by_model(month)
            if not rollup:
                print(json.dumps({"by_model": {}, "savings": None},
                                 ensure_ascii=False))
                return
            savings = cost_module.cache_counterfactual_cost(
                {"by_model": rollup}, cost_module.load_pricing())
            print(json.dumps({"by_model": rollup, "savings": savings},
                             ensure_ascii=False, indent=2))
            return
        if args.action == "months":
            months = state_module.list_months()
            if not months:
                print("(no data)")
                return
            for m in months:
                print(m)
            return
        files = state_module.list_state_files()
        if args.action == "list":
            if not files:
                print("(empty)")
                return
            for f in files:
                size = f.stat().st_size
                mtime = f.stat().st_mtime
                print("%-40s %6d B  mtime=%d" % (f.name, size, int(mtime)))
            return
        if args.action == "clean":
            # 顺带扫掉 .lock sidecar（_locked 留下的，与 .json 一一对应）
            lock_files = list(state_module.state_dir().glob("*.json.lock"))
            if not args.yes:
                print("refusing without --yes; %d files would be removed" % len(files),
                      file=sys.stderr)
                sys.exit(2)
            for f in files:
                f.unlink()
            for lf in lock_files:
                lf.unlink()
            print("removed %d files" % len(files))
            return

    # ──── M6 budget 子命令 ──────────────────────────────────────
    if getattr(args, "cmd", None) == "budget":
        if args.action == "show" and getattr(args, "month", None):
            # 查历史/指定月份——不是「现在花了多少」，跟阈值/告警无关，
            # 不走 evaluate()（那是当前月+当天的实时判断），直接问
            # compute_month_cost(month)。
            result = budget_module.compute_month_cost(args.month)
            if result is None:
                if args.json:
                    print(json.dumps({"month": args.month, "cost": None},
                                     ensure_ascii=False))
                else:
                    print("(no data for %s)" % args.month)
                return
            if args.json:
                print(json.dumps({"month": args.month, "cost": result},
                                 ensure_ascii=False, indent=2))
            else:
                print("month:      %s" % args.month)
                print("cost:       ¥%.2f (peak ¥%.2f)" %
                      (result["total"], result["peak_total"]))
            return
        if args.action == "show":
            alert = budget_module.evaluate()
            if args.json:
                print(json.dumps(alert, ensure_ascii=False, indent=2,
                                 default=str))
            else:
                cfg = budget_module.load_config()
                print("enabled:           %s" % cfg["enabled"])
                print("daily_cny:         %s" % cfg["daily_cny"])
                print("weekly_cny:        %s" % cfg["weekly_cny"])
                print("monthly_cny:       %s" % cfg["monthly_cny"])
                print("peak_share_max:    %s" % cfg["peak_share_max"])
                print("adaptive_floor:    %s" % cfg["adaptive_floor"])
                print("adaptive_window:   %s days" % cfg["adaptive_window_days"])
                print("adaptive_multiplier: %s" % cfg["adaptive_multiplier"])
                print()
                print("─── today ───")
                print("today_cost:        %s" %
                      ("¥%.2f" % alert["today_cost"] if alert["today_cost"] is not None
                       else "(no data)"))
                print("effective_daily:   ¥%.2f (adaptive_floor_applied=%s)" %
                      (alert["effective_daily_budget"],
                       alert["adaptive_floor_applied"]))
                print("ratio:             %s" %
                      ("%.1f%%" % (alert["ratio"] * 100) if alert["ratio"] is not None
                       else "(no data)"))
                print("peak_share:        %s" %
                      ("%.1f%%" % (alert["peak_share"] * 100)
                       if alert["peak_share"] is not None else "(no data)"))
                print()
                print("─── month ───")
                print("month_cost:        %s" %
                      ("¥%.2f" % alert["month_cost"] if alert["month_cost"] is not None
                       else "(no data)"))
                print("month_ratio:       %s" %
                      ("%.1f%%" % (alert["month_ratio"] * 100)
                       if alert["month_ratio"] is not None else "(no data)"))
                print()
                print("alert level:       %s" % alert["level"])
                if alert["snoozed_until"]:
                    print("snoozed_until:     %s" % alert["snoozed_until"])
                if alert["reasons"]:
                    print()
                    print("reasons:")
                    for r in alert["reasons"]:
                        print("  • %s" % r)
            return
        if args.action == "set":
            changes = {}
            if hasattr(args, "daily"):
                changes["daily_cny"] = args.daily
            if hasattr(args, "weekly"):
                changes["weekly_cny"] = args.weekly
            if hasattr(args, "monthly"):
                changes["monthly_cny"] = args.monthly
            if hasattr(args, "peak_share_max"):
                changes["peak_share_max"] = args.peak_share_max
            if not changes:
                print("no changes specified (use --daily/--weekly/...)", file=sys.stderr)
                sys.exit(2)
            budget_module.write_config(changes)
            print("wrote %s to %s" % (changes, budget_module._config_path()))
            return
        if args.action == "enable":
            budget_module.write_config({"enabled": True})
            print("budget enabled")
            return
        if args.action == "disable":
            budget_module.write_config({"enabled": False})
            print("budget disabled")
            return
        if args.action == "snooze":
            hours = getattr(args, "hours", None)
            if not hours or hours <= 0:
                print("--hours must be positive", file=sys.stderr)
                sys.exit(2)
            from datetime import datetime as _dt, timedelta
            until = (_dt.now(budget_module._BEIJING)
                     + timedelta(hours=hours)).isoformat()
            budget_module.set_snooze(until, reason="cli")
            print("snoozed until %s" % until)
            return
        if args.action == "unsnooze":
            budget_module.clear_snooze()
            print("snooze cleared")
            return

    zombie_age = args.zombie_age
    budget = args.budget
    inventory = build_inventory(
        args.harness, args.path, DEFAULT_ROOTS, env=os.environ,
        home=Path(os.path.expanduser("~")), cwd=Path.cwd(),
        runtime_json=getattr(args, "runtime_json", None))
    skills = inventory["skills"]
    scanned = inventory["scanned_roots"]
    unreadable = inventory["unreadable_skills"]
    roots = inventory["roots"]
    enabled_plugins = inventory["enabled_plugins"]
    usage = inventory["usage"]
    harness_cfg = inventory["harness_config"]
    plugins_known = inventory["plugins_known"]
    workbuddy_mode = inventory["workbuddy_mode"]
    workbuddy_roots = inventory["workbuddy_roots"]
    openclaw_runtime = inventory["openclaw_runtime"]
    codex_runtime = inventory["codex_runtime"]

    out = build_report(
        inventory,
        harness=args.harness,
        include_all=args.all,
        budget=budget,
        codex_fallback_budget=CODEX_FALLBACK_DESC_BUDGET,
        zombie_age=zombie_age,
        split_threshold=args.split_threshold,
        schema_version=SCHEMA_VERSION,
        home_n=str(Path(os.path.expanduser("~")).resolve()).replace("\\", "/"),
    )
    loaded = [skill for skill in skills if skill["loaded"]]
    budget_report = out["description_budget"]
    trigger_report = out["trigger_data"]
    structure_report = out["structure"]
    security_report = out["security"]
    tier1_total = out["tier1_total_tokens"]


    # 快照要在**算完 diff 之后**才写，否则这一次会拿自己当基线，
    # 变化段永远是空的 —— 一个看起来在工作、实际什么都没比的功能。
    cmd = getattr(args, "cmd", None)
    auto_snapshot = cmd in (None, "doctor") and not getattr(args, "no_snapshot", False) \
        and not args.json
    baseline = args.baseline
    if baseline is None and (auto_snapshot or cmd == "diff" or getattr(args, "new_only", False)):
        baseline = getattr(args, "file", None) or latest_snapshot()
    if baseline:
        out["diff_vs_baseline"] = diff_against(baseline, out)

    if args.redact or args.redact_names:
        out = redact_module.redact(
            out, names=args.redact_names, name_map={},
            home_n=str(Path(os.path.expanduser("~")).resolve()).replace("\\", "/"),
            cwd_n=str(Path.cwd()).replace("\\", "/"))
        out["redacted"] = {
            "paths": True,
            "names": bool(args.redact_names),
            "note": "This output is redacted for sharing. Run a new scan to obtain the original data.",
        }

    # `agent-vitals` 无参数等价于 `doctor`（PRODUCT §5 第一行、§183）。
    #
    # 第一次用的人想知道的是「我的 Agent 到底有没有问题」，不该先学 CLI。
    # 但 SKILL.md 与全部集成测试都靠 `--json <file>` 取原始 JSON，所以判据
    # 是**有没有给 --json**，不是「有没有子命令」—— 那条路径原样保留。
    # 想把 JSON 打到 stdout（原来的裸调用行为）用 `--json -`。
    if not getattr(args, "cmd", None) and not args.json:
        args.min = DEFAULT_OVERLAP_MIN
        render_doctor(out, args)
        sys.exit(_doctor_gate(out, args, auto_snapshot, baseline))

    if getattr(args, "cmd", None) == "list":
        render_list(out, args)
        return
    if getattr(args, "cmd", None) == "overlap":
        render_overlap(out, args)
        return
    if getattr(args, "cmd", None) == "doctor":
        render_doctor(out, args)
        if args.json:
            return
        sys.exit(_doctor_gate(out, args, auto_snapshot and not args.json, baseline))
    if getattr(args, "cmd", None) == "plan":
        # 纯派生：build_plan 只读已扫好的 out，不触发 auto_snapshot（plan 是
        # 报告的一个视图，不是一次新扫描）。
        payload = build_plan(out, getattr(args, "startup_rate", None))
        if args.json:
            text = json.dumps(payload, ensure_ascii=False, indent=2)
            if args.json == "-":
                print(text)
            else:
                Path(args.json).write_text(text, encoding="utf-8")
                print("Wrote %s: %d items" % (args.json, payload["summary"]["item_count"]))
            return
        # end=""：render 已以 \n 结尾，print 再加一个会多出一行空行（Rust 侧
        # 用 print! 不加）。codex-roots 同款处理。
        print(_render_plan_human(payload), end="")
        return
    if getattr(args, "cmd", None) == "snapshot":
        sys.exit(render_snapshot(out, args))
    if getattr(args, "cmd", None) == "diff":
        sys.exit(render_diff(out, args))
    if getattr(args, "cmd", None) == "explain":
        # 找不到那个名字要以非零退出：脚本调用方靠退出码判断，
        # 打印一行「没找到」然后返回 0 会被当成「查过了，没问题」。
        sys.exit(render_explain(out, args))

    text = json.dumps(out, ensure_ascii=False, indent=2)
    if args.json == "-":
        print(text)
    elif args.json:
        Path(args.json).write_text(text, encoding="utf-8")
        budget_text = (f"{budget_report['pct_used']}% ({budget_report['scope']})"
                       if budget_report["available"] else
                       "configurable (not set for this instance)" if args.harness == "openclaw" else "unavailable")
        active_text = (f"{len(loaded)} runtime-visible records"
                       if args.harness == "openclaw" else f"{len(loaded)} loaded")
        print(f"Wrote {args.json}: {len(skills)} skills on disk, "
              f"{active_text}, "
              f"approximately {tier1_total} Tier1 tokens, "
              f"description budget {budget_text}, "
              f"trigger data {'available' if trigger_report['available'] else 'unavailable'}, "
              f"{len(structure_report['oversized'])} split candidates, "
              f"{security_report['flagged_count']} security findings "
              f"({security_report['all_cited_count']} contain only citation-like matches and still require review)")

    if unreadable:
        # 也写一份到 stderr：JSON 里那条字段只有解析输出的人会看到，
        # 而直接在终端跑的人同样需要知道清点数字是不完整的。
        print("\nWarning: %d SKILL.md files could not be read and were excluded "
              "(see unreadable_skills):" % len(unreadable), file=sys.stderr)
        for u in unreadable[:10]:
            print("  %s" % u["path"], file=sys.stderr)

    if not skills:
        print("\nNo skills were found. Use --path to specify an installation directory.",
              file=sys.stderr)


if __name__ == "__main__":
    main()
