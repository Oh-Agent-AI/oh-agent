# 时间线几何锁步测试：`apps/desktop/src-tauri/ui/timeline.js` 是「几何只写一份」的那一份
# （docs/TRAJECTORY_TIMELINE_SPEC.md §6），dsh-client 的 `timeline-shared.cjs`
# 是它的字节锁步副本（交互消费者经它 import 共享几何），codex_session.html 的
# 内联块又是第三份副本（由 scripts/verify-codex-session-timeline.mjs 守，那里
# 需要 node 求值证明内联块不是死代码）。
#
# 本文件只盯 dsh-client 这份副本，纯字节比较、不需要 node、任何环境都跑——
# pricing.json 的三副本锁步（tests/test_pricing_lockstep.py）是它的模板。为什么
# 值得一条 Python 测试：比例尺算错了不报错，只有人眼发现曲线不对；副本一旦
# 与源漂移，dsh-client 的审计 tab 会**静默画一张比例尺不同的图**——没有异常、
# 没有红测试，只有人觉得曲线「看起来不太对」。锁步就是让漂移当天下一个 CI 就红。
#
# 副本为什么叫 `.cjs` 而不是 `.js`：dsh-client 是 `"type": "module"`，esbuild 按
# ESM 解析 `.js`——UMD 的 `module.exports = factory()` 在 ESM 解析下是死代码，
# 模块被当成「没有导出」，命名导入被替换成 void 0（`import-is-undefined` 警告）。
# `.cjs` 后缀让 esbuild 按 CommonJS 解析，UMD 的导出才活过来。源文件本身保持
# UMD（工作台 `<script src>` + node `require` + 内联 eval 三路都要），扩展名只
# 在 dsh-client 这份副本上变，不影响「字节一致」。
#
# **2026-09-22：`dsh-client` 已拆成独立仓库（`dsh-agent-vitals-audit`），不再
# 是本仓库的一部分。** `timeline-shared.cjs` 这份副本连同 dsh-client 一起搬走
# 了，本仓库摸不到它——同步纪律见那个仓库 README「来源与同步义务」一节：
# 改了 `apps/desktop/src-tauri/ui/timeline.js` 之后要手动 `cp` 过去，不再有
# 测试兜底忘记这一步。这条测试原样保留、skip 而不是删除：万一哪天又把
# dsh-client 的某个 fork/副本放回本仓库同一个相对路径下，它立刻原样生效。

import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "apps" / "desktop" / "src-tauri" / "ui" / "timeline.js"
DSH_COPY = REPO / "integrations" / "dsh-client" / "src" / "client" / "timeline-shared.cjs"

# `.is_dir()` 靠不住：`git rm` 只删跟踪文件，跑过 npm install/build 的旧
# checkout 会在这个目录下留 gitignored 的 node_modules/lib/.DS_Store，目录
# 本身还在——同一份判定见 test_pricing_lockstep.py 的注释（同一次拆分当天
# 抓到的同一个坑）。用签入过的 package.json 判定「这个包还在不在」。
_dsh_client_present = (REPO / "integrations" / "dsh-client" / "package.json").is_file()


@unittest.skipUnless(
    _dsh_client_present,
    "integrations/dsh-client/ 已拆成独立仓库 dsh-agent-vitals-audit——"
    "timeline-shared.cjs 副本不在本仓库了，手动同步纪律见那个仓库的 README",
)
class TimelineSharedCopyLockstepTests(unittest.TestCase):
    """dsh-client 的 timeline-shared.cjs 是 apps/desktop/src-tauri/ui/timeline.js 的运行时
    副本（timeline.ts 适配器经它调 buildGeometry/nearestPoint），应逐字节相同——
    不需要 node，任何环境都跑。"""

    def test_dsh_copy_matches_source_byte_for_byte(self):
        if not SRC.exists():
            self.fail("apps/desktop/src-tauri/ui/timeline.js 缺失——几何源文件去哪了？")
        if not DSH_COPY.exists():
            self.fail("integrations/dsh-client/src/client/timeline-shared.cjs 缺失——改了共享"
                      "几何后忘了复制到 dsh-client/，审计 tab 的 buildGeometry "
                      "会 import 到一份旧的/空的副本，曲线静默画错")
        self.assertEqual(
            DSH_COPY.read_bytes(), SRC.read_bytes(),
            "integrations/dsh-client/src/client/timeline-shared.cjs 与 apps/desktop/src-tauri/ui/timeline.js "
            "内容不同——改了共享几何后忘了同步副本，审计 tab 会用旧几何。"
            "改完 apps/desktop/src-tauri/ui/timeline.js 后记得 cp 一份过来，并重新生成 "
            "codex_session.html 的内联块（scripts/verify-codex-session-timeline.mjs 守）")


if __name__ == "__main__":
    unittest.main()
