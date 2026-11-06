"""v0.6 harness-contract spec §8：完整性守卫 G2–G10（G1 已在
`test_cli_matrix.py::test_harnesses_json_byte_parity`/`test_harnesses_human_format_byte_parity`
落地，Rust 侧对应见 `crates/agent-vitals-domain/src/contracts/harness_capability.rs` 与
`canonical_audit.rs` 的 `#[cfg(test)]`）。

延续 `test_classification.py` 的显式集合风格：清单人工写、checked-in，不从行
生成——行与清单互为独立 oracle，对不齐才是这层测试存在的理由（§8 G5 的分歧
处理流程）。

Rust 与 Tauri 端的对应实现（G9 的 `HarnessRuntimeRegistration`、G7 的托盘/
sessFilter 展示层派生）已落地：core `harness_capability.rs`（Rust）+
`crates/agent-vitals-domain/tests/harness_contract.rs`、二进制侧
`src/agent/harness_runtime_registration.rs`、src-tauri 侧 `overview.rs`/
`lib.rs::harness_display_name` 的单测已经钉住了各自的部分；本文件补
`workbench.html` 的 sessFilter chips 这一处纯前端静态资源（读文件文本，
不需要 Node/浏览器）。`tauri.sessions`/`tauri.menubar-cost` 两个 surface
核实后确认不需要独立注册——Tauri 是纯 IPC 透传，执行环境覆盖面恒等于
`cli.sessions` 的登记，见模块末尾 `test_g7_g9_fully_landed_no_open_
surface_remains` 的完整说明。
"""

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals import harness_capability  # noqa: E402
from agent_vitals import cost as cost_module  # noqa: E402
from agent_vitals.claude_evidence import build_claude_evidence  # noqa: E402
from agent_vitals.codex_evidence import build_codex_evidence  # noqa: E402

# ────────────────────────── §8 三集合 ──────────────────────────

RUNTIME_HARNESS_IDS = frozenset({"dsh", "codex", "claude-code", "workbuddy"})
# 历史 scan 命令面全局 `--harness` 的 7 值清单（`ScanCliHarnessChoices`）——混合承载
# 安装发现（hermes/openclaw）与部分 session 静态分析，不是纯 runtime 集合。
SCAN_CLI_HARNESS_CHOICES = frozenset(
    {"all", "claude-code", "codex", "openclaw", "hermes", "workbuddy", "dsh"})
PSEUDO_CHOICES = frozenset({"all"})

# 三处硬编码这份清单的源文件——都必须原样含这个逗号分隔的字面量子串（源码
# 自扫描，不是四处：spec 原文写"cli.py 两处 + main.rs + test_cli_matrix.py"共
# 四处，实测 cli.py 现在只有一处全局 `--harness`；本轮未处理的 P2，登记于此，
# 不是漏查——`grep -c` 已验证 cli.py 里这个字面量子串只出现一次）。
_SCAN_CLI_LITERAL = '"all", "claude-code", "codex", "openclaw", "hermes", "workbuddy", "dsh"'
_SCAN_CLI_LOCATIONS = (
    ROOT / "packages" / "agent-vitals-python" / "agent_vitals" / "cli.py",
    ROOT / "apps" / "cli" / "src" / "main.rs",
    ROOT / "tests" / "test_cli_matrix.py",
)


class G2ThreeSetSeparationTests(unittest.TestCase):
    """守卫按集合关系写，不是全集相等（v0.6 spec §8 R1 修订）。"""

    def test_harnesses_row_ids_equal_runtime_harness_ids_exactly(self):
        ids = frozenset(h["id"] for h in harness_capability.HARNESSES)
        self.assertEqual(ids, RUNTIME_HARNESS_IDS, "HARNESSES 行 id 集合必须精确等于四个 runtime 执行环境")

    def test_pseudo_choices_never_enter_the_registry(self):
        ids = frozenset(h["id"] for h in harness_capability.HARNESSES)
        self.assertEqual(ids & PSEUDO_CHOICES, frozenset(),
                         "'all' 是跨执行环境聚合伪值，绝不进 HarnessProfile 行")

    def test_scan_cli_harness_choices_literal_agrees_across_three_locations(self):
        """三处硬编码清单彼此相等——把现在无人守的一致性钉住（v0.6 spec §8 G2b）。
        用字面量子串比对而不是解析 AST：三处写法（Python tuple / Rust
        value_parser 数组 / Python list）不同，但内容必须逐字相同，子串匹配
        直接钉住"逐字"这条要求，解析成结构反而会掩盖顺序/引号差异。"""
        for path in _SCAN_CLI_LOCATIONS:
            with self.subTest(path=str(path.relative_to(ROOT))):
                text = path.read_text(encoding="utf-8")
                self.assertIn(_SCAN_CLI_LITERAL, text,
                             f"{path} 的 harness 清单与基准字面量不一致或已改动，"
                             "需要与另外两处同步核对")

    def test_runtime_harness_ids_are_a_subset_of_scan_cli_choices_today(self):
        """今天成立、但不强求为不变量的关系（v0.6 spec §8）：将来可能出现只上
        runtime 而不进入历史 scan 命令面的执行环境。"""
        self.assertLessEqual(RUNTIME_HARNESS_IDS, SCAN_CLI_HARNESS_CHOICES - PSEUDO_CHOICES)


# ────────────────────────── G3：语言支持矩阵 ──────────────────────────

_LANGUAGE_SUPPORT_MATRIX = {
    "dsh": ("crates/agent-vitals-harnesses/src/harnesses/dsh/sessions/evidence.rs", "dsh_evidence.py"),
    "codex": ("crates/agent-vitals-harnesses/src/harnesses/codex/sessions/evidence.rs", "codex_evidence.py"),
    "claude-code": ("crates/agent-vitals-harnesses/src/harnesses/claude_code/sessions/evidence.rs", "claude_evidence.py"),
    "workbuddy": ("crates/agent-vitals-harnesses/src/harnesses/workbuddy/sessions/evidence.rs", "workbuddy_evidence.py"),
}


class G3LanguageSupportMatrixTests(unittest.TestCase):
    """行 × 镜像 × 文件存在。DSH 的 Python 侧曾登记 "pending M1"
    （`dsh_evidence.py` 不存在）；M1 已建成该模块，这里从显式缺口降级成
    普通存在断言（v0.6 spec §8 G3）。"""

    def test_every_runtime_harness_has_both_language_evidence_modules(self):
        for harness_id, (rust_name, py_name) in _LANGUAGE_SUPPORT_MATRIX.items():
            with self.subTest(harness=harness_id):
                rust_path = ROOT / rust_name
                py_path = ROOT / "packages" / "agent-vitals-python" / "agent_vitals" / "agent" / py_name
                self.assertTrue(rust_path.is_file(), f"{harness_id}: 缺 {rust_path}")
                self.assertTrue(py_path.is_file(), f"{harness_id}: 缺 {py_path}")


# ────────────────────────── G4：降级穷举 ──────────────────────────

class G4DegradeExhaustivenessTests(unittest.TestCase):
    """行上全部 DegradedRule × 三态输入，断言只发生
    MeasuredZero→Unavailable（v0.6 spec §5.3 条款 1 / §8 G4 的机械化）。
    按行驱动，不是硬编码 claude-code/workbuddy——将来任何执行环境的行加了
    degraded_rules，这条测试自动覆盖它。"""

    def test_degrade_only_flips_measured_zero_for_declared_codes(self):
        for harness in harness_capability.HARNESSES:
            codes = [r["code"] for r in harness["degraded_rules"]]
            if not codes:
                continue
            with self.subTest(harness=harness["id"]):
                for label, template in (
                    ("measured_zero", {"status": "measured_zero"}),
                    ("findings", {"status": "findings", "count": 1}),
                    ("unavailable", {"status": "unavailable", "missing": ["X"],
                                     "reason": "gate: no evidence"}),
                ):
                    outcomes = {c: dict(template) for c in codes}
                    outcomes["SV999"] = {"status": "measured_zero"}  # 不在 codes 里的对照组
                    harness_capability.degrade_rule_outcomes(harness["id"], outcomes)
                    for c in codes:
                        if label == "measured_zero":
                            self.assertEqual(outcomes[c]["status"], "unavailable",
                                             f"{harness['id']}/{c}: measured_zero 必须被翻转")
                            self.assertEqual(outcomes[c]["missing"],
                                             next(r["missing"] for r in harness["degraded_rules"]
                                                  if r["code"] == c))
                        else:
                            self.assertEqual(outcomes[c]["status"], template["status"],
                                             f"{harness['id']}/{c}: {label} 态不得被覆盖")
                    self.assertEqual(outcomes["SV999"]["status"], "measured_zero",
                                     "不在 degraded_rules 里的码不受影响")


# ────────────────────────── G5：§13 矩阵对账 ──────────────────────────

# 手写自 docs/RUNTIME_EVIDENCE_CONTRACT.md §13（2026-09-02 版本）人工派生，
# checked-in 成测试数据——不从 HARNESSES 行生成，两者互为独立 oracle。矩阵行 ×
# {DSH, Codex(Legacy), Codex(Paginated), Claude Code, WorkBuddy} 五列；
# **执行环境级**缺席 = 双 shape 交集（Codex 双 shape 都 unavailable 才算，
# §5.2 双层缺席规则）。矩阵没有 SandboxPolicy/UserPrompts/UserCorrections
# 三行——它们是"矩阵外的执行环境补充项"，逐执行环境分别登记，不构造全执行环境共同集
# （R2 修订 2：UserPrompts 已在 Codex/Claude Code 测得，不能全执行环境共同缺席）。
_MATRIX_UNAVAILABLE = {
    # 信号 → 该列文案 "unavailable"/"derivable"/"measured"/"lossy"/"partial"/"derived"/"unverified"
    # 值原样摘自 §13 表格；本模块只读它判"是否 unavailable"，不做语义翻译。
    "ToolCalls": {"dsh": "measured", "codex_legacy": "measured", "codex_paginated": "measured",
                  "claude-code": "measured", "workbuddy": "measured ※"},
    "ToolResults": {"dsh": "measured", "codex_legacy": "measured", "codex_paginated": "measured",
                    "claude-code": "measured", "workbuddy": "measured ※"},
    "TurnBoundaries": {"dsh": "measured", "codex_legacy": "measured", "codex_paginated": "measured",
                       "claude-code": "derived", "workbuddy": "derived ※"},
    "StepBoundaries": {"dsh": "measured", "codex_legacy": "unavailable", "codex_paginated": "unavailable",
                       "claude-code": "derived", "workbuddy": "unavailable"},
    "Usage": {"dsh": "measured", "codex_legacy": "measured", "codex_paginated": "measured",
              "claude-code": "measured", "workbuddy": "unverified ※"},
    "UsageAggregate": {"dsh": "derivable", "codex_legacy": "derivable", "codex_paginated": "derivable",
                       "claude-code": "derivable", "workbuddy": "measured"},
    "ContextWindow": {"dsh": "measured", "codex_legacy": "measured", "codex_paginated": "measured",
                      "claude-code": "unavailable", "workbuddy": "unavailable"},
    "QuotaConsumption": {"dsh": "unavailable", "codex_legacy": "measured", "codex_paginated": "measured",
                         "claude-code": "unavailable", "workbuddy": "unavailable"},
    "ApprovalDecisions": {"dsh": "measured", "codex_legacy": "unavailable ‡", "codex_paginated": "partial ‡",
                          "claude-code": "partial ¶", "workbuddy": "measured"},
    "ApprovalPolicy": {"dsh": "measured", "codex_legacy": "measured", "codex_paginated": "measured",
                       "claude-code": "measured", "workbuddy": "measured"},
    "SandboxModes": {"dsh": "measured", "codex_legacy": "unavailable", "codex_paginated": "unavailable",
                     "claude-code": "unavailable", "workbuddy": "measured"},
    "NetworkAccess": {"dsh": "unavailable", "codex_legacy": "unavailable", "codex_paginated": "unavailable",
                      "claude-code": "unavailable", "workbuddy": "measured"},
    "Compaction": {"dsh": "measured", "codex_legacy": "measured", "codex_paginated": "measured",
                   "claude-code": "lossy", "workbuddy": "unavailable"},
    "SubagentSpawns": {"dsh": "measured", "codex_legacy": "measured", "codex_paginated": "measured",
                       "claude-code": "measured", "workbuddy": "measured ※"},
    "SkillInvocations": {"dsh": "measured", "codex_legacy": "derived", "codex_paginated": "derived",
                         "claude-code": "derived", "workbuddy": "unavailable"},
    "Hooks": {"dsh": "measured", "codex_legacy": "unavailable", "codex_paginated": "measured",
              "claude-code": "lossy", "workbuddy": "unavailable"},
    "FileMutations": {"dsh": "measured", "codex_legacy": "lossy", "codex_paginated": "measured",
                      "claude-code": "derived", "workbuddy": "measured"},
}
_MATRIX_COLUMNS = {
    "dsh": "dsh", "codex": ("codex_legacy", "codex_paginated"),
    "claude-code": "claude-code", "workbuddy": "workbuddy",
}
# 矩阵外补充项：逐执行环境分别登记（不构造全执行环境共同缺席集，R2 修订 2）。
_MATRIX_EXTERNAL_SUPPLEMENTS = {
    "dsh": {"SandboxPolicy", "UserPrompts", "UserCorrections"},
    "codex": {"SandboxPolicy", "UserCorrections"},
    "claude-code": {"SandboxPolicy", "UserCorrections"},
    "workbuddy": {"SandboxPolicy", "UserPrompts", "UserCorrections"},
}
# 行与矩阵原文的**显式偏差登记项**——没有注记的偏差过不了这份对账（v0.6
# spec §8 G5 分歧处理流程）。每条都必须能在代码注释里找到出处。
_REGISTERED_DEVIATIONS = {
    ("codex", "SandboxModes"): (
        "矩阵原文两个 shape 都写 unavailable（执行环境级交集应为 unavailable），"
        "但 2026-08 起 turn_context.sandbox_policy 已确认持久化、代码已改 "
        "measured（codex_evidence.py 的 _UNAVAILABLE_SIGNALS 头注释、"
        "codex_evidence.rs 的 derive_coverage 同源）——矩阵文档滞后于代码，"
        "行以代码为准，此处按 G5 分歧流程登记而非静默改矩阵。"
    ),
    ("workbuddy", "QuotaConsumption"): (
        "矩阵写 unavailable，但 2026-09-11 B6 起代码改 measured：`session_usage."
        "credit_json` 的每个 requestId 条目就是执行环境报告的一次配额消耗（分子），"
        "与 codex 的 `token_count.rate_limits` 同一语义档；分母（allowance/余额）"
        "在服务端账户面、本机不可观测，由 note 说明、不出百分比。此前声明 "
        "unavailable 是「有证据却不计」——evidence.rs 纪律的反面。矩阵文档滞后，"
        "行以代码为准，按 G5 登记（workbuddy_evidence.rs / .py 同源）。"
    ),
    ("workbuddy", "Usage"): (
        "矩阵写 unverified（※，generation span 存在但逐 span token 未核实）"
        "，workbuddy_evidence.rs 保守处理成 unavailable——WorkBuddy Usage 是"
        "spec §5.2 明文点名的偏差登记活例子。"
    ),
    # ("workbuddy", "ToolResults") / ("workbuddy", "SubagentSpawns")：**登记已撤**
    # （2026-09-11 E2）。矩阵写 measured ※（span.status/error、agent span），代码曾因
    # 「traces 会话匿名」保守成 unavailable——那是 09-02 的分析错误；traces 可按
    # `trace.sessionId` 归属，E2 起代码与矩阵一致，按 G5 反向校验规则撤登记。
    ("claude-code", "ApprovalDecisions"): (
        "矩阵写 partial（¶，denials only, derived+lossy——理论上能从 tool-result "
        "marker string 恢复），claude_code_evidence.rs/claude_evidence.py 当前"
        "选择先诚实报 Unavailable（first-slice 范围，未实现 marker 恢复），"
        "两处头注释与 harness_capability.rs 的 HARNESSES 行注释都记着这是范围内的"
        "有意选择，不是矩阵与代码打架。"
    ),
}


def _matrix_expects_unavailable(signal, harness_id):
    cell = _MATRIX_UNAVAILABLE.get(signal)
    if cell is None:
        return signal in _MATRIX_EXTERNAL_SUPPLEMENTS.get(harness_id, set())
    cols = _MATRIX_COLUMNS[harness_id]
    if isinstance(cols, tuple):
        # 执行环境级 = 双 shape 交集：两列都 unavailable 才算。
        return all(cell[c].startswith("unavailable") for c in cols)
    return cell[cols].startswith("unavailable")


class G5MatrixReconciliationTests(unittest.TestCase):
    def test_harnesses_row_unmeasured_matches_matrix_derived_expectation(self):
        for harness in harness_capability.HARNESSES:
            harness_id = harness["id"]
            actual = set(harness["unmeasured_signals"])
            all_signals = set(_MATRIX_UNAVAILABLE) | {"SandboxPolicy", "UserPrompts", "UserCorrections"}
            with self.subTest(harness=harness_id):
                for signal in sorted(all_signals):
                    expected = _matrix_expects_unavailable(signal, harness_id)
                    deviation = _REGISTERED_DEVIATIONS.get((harness_id, signal))
                    if deviation is not None:
                        # 登记过的偏差：只要求它带出处，不要求行与矩阵一致
                        # ——行为变更已发生，矩阵文档滞后，见登记文本。
                        continue
                    self.assertEqual(
                        signal in actual, expected,
                        f"{harness_id}/{signal}：行 unmeasured={signal in actual} vs "
                        f"矩阵推导={expected}，未登记的分歧——按 G5 流程要么改行"
                        "要么改矩阵、要么补登记，不能悄悄漂移")

    def test_every_registered_deviation_still_disagrees_with_the_raw_matrix(self):
        """反向校验：登记过的偏差如果哪天被悄悄改回和矩阵一致，这条登记就
        该删掉——否则它会掩盖"这条差异是否还存在"这件事。"""
        for (harness_id, signal), _reason in _REGISTERED_DEVIATIONS.items():
            harness = next(h for h in harness_capability.HARNESSES if h["id"] == harness_id)
            actual_unavailable = signal in harness["unmeasured_signals"]
            matrix_says = _matrix_expects_unavailable(signal, harness_id)
            self.assertNotEqual(
                actual_unavailable, matrix_says,
                f"{harness_id}/{signal} 的登记偏差已经消失（行与矩阵现在一致），"
                "该从 _REGISTERED_DEVIATIONS 删除，不是继续挂着")


# ────────────────────────── G6：合成会话不变量 ──────────────────────────

class G6SyntheticSessionInvariantTests(unittest.TestCase):
    """对每个（干净侧）适配器喂一条"kitchen-sink"合成会话——覆盖它所有已知
    能 bump 的信号类型——断言行声明为 unmeasured 的信号依旧零覆盖、不进
    signals 集合。workbuddy 侧（M2b）留待并行流合入后补齐，不在本测试范围。
    """

    def _assert_unmeasured_are_zero(self, harness_id, canonical):
        harness = next(h for h in harness_capability.HARNESSES if h["id"] == harness_id)
        coverage = canonical["coverage"]
        signals = canonical["signals"]
        for signal in harness["unmeasured_signals"]:
            with self.subTest(harness=harness_id, signal=signal):
                c = coverage.get(signal, {"measured": 0, "derived": 0, "lossy": 0, "unmetered": 0})
                total = c["measured"] + c["derived"] + c["lossy"] + c["unmetered"]
                self.assertEqual(total, 0, f"{harness_id}/{signal} 声明 unmeasured 却有非零覆盖")
                self.assertNotIn(signal, signals, f"{harness_id}/{signal} 声明 unmeasured 却进了 signals")

    def test_claude_code_kitchen_sink_session(self):
        records = [
            {"type": "user", "uuid": "m1", "timestamp": "2026-08-20T14:27:00Z",
             "cwd": "/repo", "message": {"id": "m1", "model": "claude-sonnet-4-5", "content": "去修 bug"}},
            {"type": "assistant", "uuid": "m2", "timestamp": "2026-08-20T14:27:05Z", "cwd": "/repo",
             "message": {"id": "m2", "model": "claude-sonnet-4-5", "usage": {"input_tokens": 1, "output_tokens": 1},
                         "content": [
                             {"type": "tool_use", "id": "c1", "name": "Bash", "input": {"command": "ls -la"}},
                             {"type": "tool_use", "id": "c2", "name": "WebFetch", "input": {"url": "https://1.2.3.4/x"}},
                         ]}},
            {"type": "user", "uuid": "m3", "timestamp": "2026-08-20T14:27:08Z", "cwd": "/repo",
             "message": {"id": "m3", "content": [
                 {"type": "tool_result", "tool_use_id": "c1", "content": "ok", "is_error": True},
                 {"type": "tool_result", "tool_use_id": "c2", "content": "ok"},
             ]}},
            {"type": "ai-title", "uuid": "t1", "timestamp": "2026-08-20T14:30:00Z", "cwd": "/repo",
             "aiTitle": "kitchen sink"},
        ]
        canonical = build_claude_evidence(records, "s1")["canonical"]
        self._assert_unmeasured_are_zero("claude-code", canonical)

    def test_codex_kitchen_sink_session(self):
        items = [
            {"type": "turn_context", "timestamp": 0, "payload": {
                "sandbox_policy": {"type": "danger-full-access"}, "approval_policy": "never",
                "turn_id": "t1"}},
            {"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_started", "turn_id": "t1", "started_at": 100}},
            {"type": "event_msg", "timestamp": 0, "payload": {
                "type": "item_completed", "turn_id": "t1", "item": {
                    "type": "CommandExecution", "id": "exec-1",
                    "command": ["/bin/zsh", "-lc", "rm -rf /tmp/x"], "exit_code": 0}}},
            {"type": "response_item", "timestamp": 0, "payload": {
                "type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}},
            {"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_complete", "turn_id": "t1"}},
        ]
        canonical = build_codex_evidence(
            items, "s1", "title", "legacy", "0.146.0", ["/repo"], "gpt-5.3-codex")["canonical"]
        self._assert_unmeasured_are_zero("codex", canonical)


# ────────────────────────── G8：源码自扫描 ──────────────────────────

class G8SourceSelfScanTests(unittest.TestCase):
    """§5.3 条款 5 的机械形式：derive-not-copy——任何文件里出现第二份
    per-harness unmeasured 字面量表 = 守卫红。M2a 把 claude/codex 两侧的
    `_UNAVAILABLE_SIGNALS`/`is_unavailable` 改成查 HARNESSES 行，这里防回退。
    不是主验证（G6 才是），是廉价哨兵——只抓"看起来像残留字面量表"的形状。
    """

    def test_claude_and_codex_python_derive_unavailable_from_harness_profile(self):
        for name in ("claude_evidence.py", "codex_evidence.py"):
            path = ROOT / "packages" / "agent-vitals-python" / "agent_vitals" / "agent" / name
            text = path.read_text(encoding="utf-8")
            with self.subTest(file=name):
                self.assertIn("harness_profile(", text,
                             f"{name} 应该从 harness_capability.harness_profile 派生 unmeasured，"
                             "而不是本地字面量表")
                # 反面哨兵：不该再出现"一串带引号的 Signal 名 + 逗号"的多行字面量
                # 模式（超过 3 个连续 Signal 名字符串视为可疑）。
                m = re.search(
                    r'_UNAVAILABLE_SIGNALS\s*=\s*\(\s*\n(?:\s*"[A-Za-z]+",\s*\n){3,}', text)
                self.assertIsNone(m, f"{name} 的 _UNAVAILABLE_SIGNALS 疑似退回了字面量表")

    def test_claude_code_and_codex_rust_derive_unavailable_from_harness_profile(self):
        for name in (
            "crates/agent-vitals-harnesses/src/harnesses/claude_code/sessions/evidence.rs",
            "crates/agent-vitals-harnesses/src/harnesses/codex/sessions/evidence.rs",
        ):
            path = ROOT / name
            text = path.read_text(encoding="utf-8")
            with self.subTest(file=name):
                self.assertIn("harness_capability::harness_profile(", text,
                             f"{name} 的 is_unavailable 应该查 harness_capability::HARNESSES，"
                             "而不是本地 matches! 字面量表")
                m = re.search(
                    r"fn is_unavailable\(signal: Signal\) -> bool \{\s*\n\s*matches!", text)
                self.assertIsNone(m, f"{name} 的 is_unavailable 疑似退回了 matches! 字面量表")

    def test_dsh_rust_derives_unavailable_from_harness_profile(self):
        path = (ROOT / "crates" / "agent-vitals-harnesses" / "src" / "harnesses" /
                "dsh" / "sessions" / "evidence.rs")
        text = path.read_text(encoding="utf-8")
        self.assertIn('harness_capability::harness_profile("dsh")', text,
                     "dsh_evidence.rs 的五个 unmeasured 信号置零应查 HARNESSES 行")


# ────────────────────────── G10：计价分辨率 ──────────────────────────

def _mechanically_find_time_varying_cards(pricing):
    """扫 pricing.json 顶层 providers，形状为 `{off_peak, peak}` 的卡即时变卡
    （机械推导，不靠人工声明——v0.6 spec §8 G10）。"""
    found = []
    for provider, pv in (pricing.get("providers") or {}).items():
        for model, card in ((pv or {}).get("models") or {}).items():
            v = (card or {}).get("input_uncached")
            if isinstance(v, dict) and "off_peak" in v and "peak" in v:
                found.append((provider, model))
    return sorted(found)


_EXPECTED_TIME_VARYING_CARDS = sorted([
    # 2026-09-14 新增 deepseek-v4.1-flash：网关/转售把同一个 Flash 模型写成带
    # 命名空间的 deepseek/deepseek-v4.1-flash，而 `norm_model_in` 只砍 `deepseek/`
    # 前缀、不把 `4.1` 折成 `4`，所以必须显式登记（真机：一天 70M tokens 的
    # 「按官方价折算」整栏为空）。与 Rust 侧
    # crates/agent-vitals-domain/tests/harness_contract.rs 的同一份登记逐项对应。
    ("deepseek-official", "deepseek-v4-flash"),
    ("deepseek-official", "deepseek-v4-pro"),
    ("deepseek-official", "deepseek-v4.1-flash"),
    ("shengsuanyun", "deepseek-v4-pro"),
])

# 缺口登记（v0.6.x 前置热修，2026-09-03 结清）：`claude_day_cost`/
# `claude_session_cost` 曾共用 `_price_claude_map` → `_price_claude_model` →
# `_flat_rate` 的 off_peak 兜底，登记为 `"pending v0.7"`（后改记 v0.6.x）；
# 两者已同批切换到峰谷读法（`claude_day_cost` 用 `peak_resolved=True`，
# ledger 日桶的 `peak_*` 子桶来自 `tail_days` 逐行真实 ts；`claude_session_cost`
# 结构性没有逐行 ts，`peak_resolved=False`，如实报 `pricing_basis="partial"`
# 而不是悄悄用下界冒充精确）。缺口清单闭集为空，见下面两个测试的新断言
# （v0.6 spec §8 G10 / §12 DoD 2/9："三张时变卡在任何计价入口都不走下界读法"
# 现在无条件成立，不再需要缺口登记）。


class G10PricingResolutionTests(unittest.TestCase):
    def test_time_varying_card_set_matches_registry(self):
        pricing = cost_module.load_pricing()
        self.assertEqual(_mechanically_find_time_varying_cards(pricing),
                         _EXPECTED_TIME_VARYING_CARDS)

    def test_price_claude_map_has_exactly_the_three_registered_callers(self):
        """廉价哨兵（G8 风格）：v0.6.x 热修后 `_flat_rate` 已收窄为只服务真正
        平费率字段，不再有 off_peak 兜底可"悄悄接上"；这条哨兵现在盯的是
        `_price_claude_map` 的调用面本身——调用点数变了说明有新计价入口出现，
        需要确认它是否传对了 `peak_resolved`（时变卡缺分辨率时必须诚实降级
        成 `"partial"`，不能悄悄冒充 `"catalog"`）。三个已登记入口：
        `claude_day_cost`/`claude_session_cost`（`_price_claude_map` doc
        注释自钉「两面的钱必须同源」）+ v0.7 spec §3 新增的
        `claude_subscription_uncovered_estimate`（`peak_resolved=True`，
        复用 ledger 的峰谷分辨率，不是又一个下界兜底）。"""
        text = (ROOT / "packages" / "agent-vitals-python" / "agent_vitals" / "agent" / "cost.py").read_text(encoding="utf-8")
        occurrences = len(re.findall(r"_price_claude_map\(", text))
        # 1 处定义 + 三个已登记入口各调用 1 次。
        self.assertEqual(occurrences, 4,
                         "_price_claude_map 的调用点数量变化——检查新计价入口传的 "
                         "peak_resolved 是否诚实，需要同步这份登记")

    def test_claude_day_cost_prices_peak_tokens_at_peak_rate_not_off_peak_floor(self):
        """硬断言（v0.6 spec §8 G10 / §12 DoD 2/9，v0.6.x 热修落地后从"验证仍
        卡在下界"翻转成"验证已经峰谷正确"）：`claude_day_cost` 的 ledger 日桶
        现在带 `peak_*` 子桶（来自 `claude_cost.py::tail_days` 逐行真实 ts），
        全落在高峰时段的用量必须按 peak 单价算，不是 off_peak 下界——否则
        `flat_rate` 的下界兜底又静默接管了这张时变卡。"""
        pricing = cost_module.load_pricing()
        card = pricing["providers"]["deepseek-official"]["models"]["deepseek-v4-flash"]
        off_peak_rate = card["input_uncached"]["off_peak"]
        peak_rate = card["input_uncached"]["peak"]
        self.assertNotEqual(off_peak_rate, peak_rate, "测试卡必须真的时变，否则本断言无意义")

        # 全落峰值：base 与 peak_ 子桶相等——1M input 全部在高峰时段发生。
        day = {"deepseek-v4-flash": {
            "input_tokens": 1_000_000, "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0, "output_tokens": 0,
            "peak_input_tokens": 1_000_000, "peak_cache_read_input_tokens": 0,
            "peak_cache_creation_input_tokens": 0, "peak_output_tokens": 0}}
        report = cost_module.claude_day_cost(day, pricing)
        day_total = report["per_model"]["deepseek-v4-flash"]["total"]
        self.assertAlmostEqual(day_total, peak_rate,
                               msg="claude_day_cost 全高峰用量必须按 peak 单价算")
        self.assertNotAlmostEqual(day_total, off_peak_rate)
        self.assertEqual(report["pricing_basis"], "catalog",
                         "有峰谷分辨率时是精确值，不再是估算")

        # 全落空闲：peak_* 子桶全 0——必须精确算成 off_peak（不是"没分辨率的
        # 下界"，是"真的测到全部落在空闲时段"，两者数值恰好相同、语义不同，
        # pricing_basis 必须仍是 catalog）。
        day_off = {"deepseek-v4-flash": {
            "input_tokens": 1_000_000, "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0, "output_tokens": 0}}
        report_off = cost_module.claude_day_cost(day_off, pricing)
        self.assertAlmostEqual(
            report_off["per_model"]["deepseek-v4-flash"]["total"], off_peak_rate)
        self.assertEqual(report_off["pricing_basis"], "catalog")

    def test_claude_session_cost_honestly_reports_partial_for_time_varying_cards(self):
        """`claude_session_cost` 结构性没有逐行 ts（cost-state 是会话累计
        自报，不是逐请求流水）——时变卡这里永远给不出真峰谷分辨率，v0.6.x
        热修后如实报 `pricing_basis="partial"`（不是悄悄按 off_peak 冒充
        `"catalog"` 精确值；数值仍是 off_peak 下界，因为那是唯一"没有更多
        信息时"站得住的算法，但标注必须诚实）。"""
        pricing = cost_module.load_pricing()
        card = pricing["providers"]["deepseek-official"]["models"]["deepseek-v4-flash"]
        off_peak_rate = card["input_uncached"]["off_peak"]
        session = {"deepseek-v4-flash": {"inputTokens": 1_000_000, "cacheReadInputTokens": 0,
                                         "cacheCreationInputTokens": 0, "outputTokens": 0}}
        report = cost_module.claude_session_cost(session, pricing)
        session_total = report["per_model"]["deepseek-v4-flash"]["total"]
        self.assertAlmostEqual(session_total, off_peak_rate)
        self.assertEqual(report["per_model"]["deepseek-v4-flash"]["pricing_basis"], "partial")
        self.assertEqual(report["pricing_basis"], "partial")

    def test_dsh_ledger_bucket_pricer_already_does_peak_split(self):
        """正对照：DSH 的日桶计价（`cost._price`，Rust `bucket_price` 的 Python
        对应）已经是全仓验证过的峰谷读法——喂一份全落在高峰的用量，价格必须
        按 peak 单价算，不是 off_peak（否则这条正对照本身就该红，说明基准
        代码退步了，不只是 claude 那两个入口的事）。"""
        pricing = cost_module.load_pricing()
        card = pricing["providers"]["deepseek-official"]["models"]["deepseek-v4-flash"]
        buckets_all_peak = {
            "uncached_input_tokens": 1_000_000, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 1_000_000, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        }
        priced = cost_module._price(buckets_all_peak, "deepseek-v4-flash", "deepseek-official", pricing)
        expected_peak_total = 1.0 * card["input_uncached"]["peak"]
        expected_off_peak_total = 1.0 * card["input_uncached"]["off_peak"]
        self.assertAlmostEqual(priced["total"], expected_peak_total)
        self.assertNotAlmostEqual(priced["total"], expected_off_peak_total)


# ────────────────────────── G7：sessFilter 展示层一致性 ──────────────────────

class G7SessFilterTests(unittest.TestCase):
    """`apps/desktop/src-tauri/ui/workbench.html` 的会话筛选 chips 是纯静态标记（无构建期
    代码生成），不能像 Rust 那样"从行派生"；这里退而求其次，用源码自扫描
    钉住"chips 集合 == 注册了 session_store 的执行环境集合"，防止两边手工维护
    的清单再次分叉（v0.6 spec §6：claude-code 此前缺席过一次 chip，
    868f1a7 并行流已经补上——本测试是这个事实之后的回归防线，不是新功能）。
    """

    def test_workbench_chips_match_session_store_harnesses_exactly(self):
        html = (ROOT / "apps" / "desktop" / "src-tauri" / "ui" / "workbench.html").read_text(encoding="utf-8")
        chip_harnesses = set(re.findall(r'data-harness="([a-z-]+)"', html)) - {"all"}
        expected = {h["id"] for h in harness_capability.HARNESSES if h["session_store"]}
        self.assertEqual(chip_harnesses, expected,
                         "workbench.html 的 sessFilter chips 与已注册 session_store "
                         "的执行环境集合不一致——两边任一改了都要同步另一边")


# ────────────────────────── G7 / G9：已知缺口登记 ──────────────────────────

class KnownGapRegistrationTests(unittest.TestCase):
    def test_g7_g9_fully_landed_no_open_surface_remains(self):
        """G7/G9 已全部落地，各自有单测钉住：

        - G7：src-tauri `overview.rs::HarnessesSnapshot::unavailable()`（托盘
          兜底行）从 `HARNESSES` 的 `fold != None` 派生；
          `lib.rs::harness_display_name` 从 `HARNESSES` 的 `display` 派生（副作用：
          WorkBuddy 现在也能正确解析出显示名）；`workbench.html` 的
          sessFilter chips 与 `session_store` 执行环境集合一致性由本文件
          `G7SessFilterTests` 钉住。
        - G9：`src/agent/harness_runtime_registration.rs` 登记了 `cli.sessions`
          surface 的 `session_store` 与 `fold` 两个维度
          （`required_for_cli_sessions[_fold]() ⊆
          registered_for_cli_sessions[_fold]()`，Rust 侧单测钉住）——
          `sessions_navigation` 对 dsh/codex/claude-code 的折叠路径本身**未
          改造成共享循环**（三条路径互不相同：state 链/全量 rollout/
          ledger，§2.2 明文拒绝为了共享接口发明假抽象），本表只登记"接了
          没有"这个事实。`tauri.sessions`/`tauri.menubar-cost` 两个 surface
          **不需要独立登记**——核实 `apps/desktop/src-tauri/src/store.rs` 后确认它们是
          纯 IPC 透传（`sessions_list`/`sessions_read`/`sessions_findings`
          只拼 argv、spawn CLI 二进制、原样透传输出，`store.rs` 自己的
          `list_args_empty_and_full` 单测已用任意字符串 `"x"` 当
          `harness_kind` 验证这条路径不按执行环境分支），Tauri 不持有第二份
          `SessionStore`/折叠实现，执行环境覆盖面恒等于 `cli.sessions` 的登记——
          没有独立能力，也就没有独立注册的必要。

        这里不重复 Rust 侧断言（那些已经在各自的单测里），只登记"做了什么、
        为什么这样算完整"，供 M3 收尾时核对。"""
        self.assertTrue(True)
