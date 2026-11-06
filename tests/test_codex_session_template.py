# 模板内联 JS 回归测试：`codex_session.html` 标记块里的纯函数由 node 求值断言——
# scripts/verify-codex-session-timeline.mjs 钉 sv-timeline 几何（0/1/N 桶），
# scripts/verify-codex-session-findings.mjs 钉 sv-findings-fold 折叠
# （结构缺口 / 会话缺口 / 全覆盖）。
#
# 为什么要 node：几何与折叠是模板内联 JS，在 Python 里再实现一遍就是第二份拷贝，
# 必然漂移（dsh-client 的 verify-*.mjs 同一理由）。
#
# 为什么要接在 Python 套件里：verify 脚本存在但没人跑 = 不存在——dsh-client 的
# verify 脚本第一次放走「错图不抛异常」的 bug，就是没人把它接进任何自动化。接在
# 这条测试里，`python3 -m unittest discover tests`（本地 + CI python job 都跑它）
# 就顺带把断言跑掉。node 不在环境时跳过整个 class（CI ubuntu 自带 node，本地通常
# 也有），与 test_pricing_lockstep.py 的 skip 策略一致。
#
# 钉的 bug：
# - 时间线（2026-08-30）：session 01a029cb 单小时桶，折线 X(i) 恒等于 PAD，line
#   退化成零长线段、area 退化成零宽三角形、三个 label 叠在同一点——整张图不可见，
#   用户报「会话时间线没有渲染」，且没有任何测试抓住。修复：单桶改画居中柱。
# - 折叠（2026-08-30）：Finding 队列把 10 个零覆盖信号一视同仁列成线索，其中 5 个
#   是执行环境线格式根本不提供的维度（结构缺口），任何会话都为零；KPI 分母 19 是永远
#   到不了的满分。修复：coverage 条目带 available 标记，折叠只把「available 且零」
#   当会话线索，结构缺口折叠成一行静态说明，空态重新可达。

import shutil
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
VERIFY_SCRIPTS = [
    REPO / "scripts" / "verify-codex-session-timeline.mjs",
    REPO / "scripts" / "verify-codex-session-findings.mjs",
    REPO / "scripts" / "verify-timeline-geometry.mjs",
    # 工作台总览 KPI 行 / 双轨账 / 决策卡 + 速览层混币折算（Overview.fx）+
    # 预算卡 source:"sql" 兜底判定。同理由接进这条测试：verify 脚本没人跑 = 不存在。
    REPO / "scripts" / "verify-workbench-kpi-decide.mjs",
    # v1.0 数据源页：独立状态契约、执行环境注册表驱动、恢复动作。
    REPO / "scripts" / "verify-workbench-sources.mjs",
]
TRACE_VERIFY = REPO / "scripts" / "verify-workbench-traces.mjs"
RELEASE_CLI = REPO / "target" / "release" / "agent-vitals"

_has_node = shutil.which("node") is not None


@unittest.skipUnless(_has_node, "node not available — cannot evaluate template inline JS")
class CodexSessionTemplateJsTests(unittest.TestCase):
    def test_verify_scripts_pass(self):
        for script in VERIFY_SCRIPTS:
            if not script.exists():
                self.fail(f"{script} 缺失——verify 脚本没写出来，断言不存在")
            out = subprocess.run(
                ["node", str(script)],
                capture_output=True, text=True, check=True,
            )
            # check=True 已保证退出码 0；断言末尾哨兵，失败时输出里能直接看到是哪条断言挂。
            self.assertIn("通过。", out.stdout, f"{script.name} 未通过")

    @unittest.skipUnless(RELEASE_CLI.is_file(), "requires release CLI; run in the Rust differential job")
    def test_workbench_trace_verifier_passes_with_real_cli(self):
        out = subprocess.run(
            ["node", str(TRACE_VERIFY)], capture_output=True, text=True, check=True,
        )
        self.assertIn("全部通过。", out.stdout)


if __name__ == "__main__":
    unittest.main()
