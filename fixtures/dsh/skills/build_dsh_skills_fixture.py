#!/usr/bin/env python3
"""生成 DSH-2 的目录树 fixture（C1：dsh 执行环境的 skill 目录树）。

这份语料与 `fixtures/generate.py` 同源、同约束：它必须**完全确定**，因为它是
未来 `harness-dsh` golden 的输入。确定性靠两件事（与 generate.py 相同）：

1. **HOME 隔离**。语料构造成一棵完整的 home 树，将来用 `HOME=<root>` +
   `cwd=<root>/workdir` 跑 `--harness dsh`。dsh 的 DEFAULT_ROOTS（`~/.dsh/skills`、
   `~/.agents/skills`、`./.dsh/skills`、`./.agents/skills`）整体落进语料，不碰真机。
2. **mtime 显式设定**。冲突判定（shadowed_newer / intentional_override）靠
   mtime 比大小，不钉死就随生成时间变。

与 generate.py 的区别：**这份树只给 dsh 执行环境用，不进入现有扫描器的 golden**。
`~/.agents/skills` 与 OpenClaw 共享（HARNESS_ADAPTER_CONTRACT §DSH），把它放进
generate.py 的主树，OpenClaw 适配器会把它当 `shared-user` 根扫走，现有的
`harness-openclaw` 等 golden 就会变。所以单独一个脚本、单独一棵 home 树；将来
C2（golden_runner 加 `harness-dsh` case）再把它接进去。

根表（HARNESS_ADAPTER_CONTRACT §DSH，**层内** rank 越小越优先）：

    100  <project>/.dsh/skills     project-dsh
    200  <project>/.agents/skills  project-agents
    300  customSkillDirs           custom        （配置 / --path，不在本树）
    400  $DSH_HOME/skills          user-dsh
    500  $DSH_AGENTS_HOME/skills   user-agents
    600  packaged providers        bundled       （运行时证据，不在本树）

用法：
    python3 fixtures/dsh/skills/build_dsh_skills_fixture.py --into /tmp/dshfx
    python3 fixtures/dsh/skills/build_dsh_skills_fixture.py --into /tmp/dshfx --clean
"""

import argparse
import os
import shutil
from pathlib import Path

# 与 generate.py 相同的固定时间戳。绝对值不重要，相对顺序才重要。
BASE = 1700000000          # 2023-11-14T22:13:20Z
OLD = BASE
MID = BASE + 86400 * 10
NEW = BASE + 86400 * 30

# dsh 的四个默认 root 相对 HOME 的路径，以及层内 rank。cwd = <home>/workdir
# （project root）。custom / bundled 不在默认 root 里，见模块 docstring。
ROOTS = {
    "project-dsh": ("workdir/.dsh/skills", 100),
    "project-agents": ("workdir/.agents/skills", 200),
    "user-dsh": (".dsh/skills", 400),
    "user-agents": (".agents/skills", 500),
}

# 每个 skill 一条：name / 相对 HOME 的目录 / 源（level）/ rank / mtime / body / description。
# SKILLS 同时也是自校验的清单 —— build 与 verify 共用这一份，避免清单与产物脱节。
SKILLS = [
    # ── 跨 rank 重名（同 scope 层内，rank 决定谁赢）──────────────────────
    # `shared-tool` 三份：project-dsh(100) 赢，user-dsh(400) 与 user-agents(500)
    # 被盖。被盖的 user-agents 最新 → shadowed_newer / high（rank 压过了更新的副本）。
    ("shared-tool", "workdir/.dsh/skills/shared-tool", "project-dsh", 100,
     OLD, "project-dsh body\n", "Shared tool from project-dsh (rank 100)"),
    ("shared-tool", ".dsh/skills/shared-tool", "user-dsh", 400,
     MID, "user-dsh body\n", "Shared tool from user-dsh (rank 400)"),
    ("shared-tool", ".agents/skills/shared-tool", "user-agents", 500,
     NEW, "user-agents body\n", "Shared tool from user-agents (rank 500)"),

    # ── 同 root 重名（rank 相同，两个目录的 frontmatter name 相同）────────
    # `dup-user` 两份都在 user-dsh(400)：rank 并列，靠目录名排序（dup-user-a
    # < dup-user-b）稳定取胜。b 更新 → shadowed_newer / high。
    ("dup-user", ".dsh/skills/dup-user-a", "user-dsh", 400,
     OLD, "dup-user old copy\n", "Dup-user copy A (older)"),
    ("dup-user", ".dsh/skills/dup-user-b", "user-dsh", 400,
     NEW, "dup-user new copy\n", "Dup-user copy B (newer)"),

    # ── 每个 root 一个独有 skill，证明该 root 被扫到 ─────────────────────
    ("proj-only", "workdir/.dsh/skills/proj-only", "project-dsh", 100,
     MID, "project-dsh unique body\n", "Unique skill in project-dsh (rank 100)"),
    ("proj-agents-only", "workdir/.agents/skills/proj-agents-only", "project-agents", 200,
     MID, "project-agents unique body\n", "Unique skill in project-agents (rank 200)"),
    ("user-only", ".dsh/skills/user-only", "user-dsh", 400,
     MID, "user-dsh unique body\n", "Unique skill in user-dsh (rank 400)"),
    ("agents-only", ".agents/skills/agents-only", "user-agents", 500,
     MID, "user-agents unique body\n", "Unique skill in user-agents (rank 500)"),
]


def write(path: Path, content: str, mtime=MID):
    """写文件并钉死 mtime。与 generate.py 的 write 同款（保留换行字节）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    # Preserve fixture bytes across platforms. Text-mode newline translation
    # turns explicit CRLF into CRCRLF on Windows and changes token counts.
    with path.open("w", encoding="utf-8", newline="") as stream:
        stream.write(content)
    os.utime(path, (mtime, mtime))
    return path


def skill(root: Path, rel: str, *, name: str, desc: str, body: str, mtime=MID):
    """写一个 skill 目录。frontmatter 与 generate.py 的 skill() 同款格式。"""
    d = root / rel
    fm = ["---", "name: %s" % name, "description: %s" % desc, "---"]
    write(d / "SKILL.md", "\n".join(fm) + "\n\n" + body, mtime=mtime)
    # 目录 mtime 也钉一下，避免个别文件系统把它带进输出
    os.utime(d, (mtime, mtime))
    return d


def build(root: Path):
    (root / "workdir").mkdir(parents=True, exist_ok=True)
    os.utime(root / "workdir", (MID, MID))
    for name, rel, source, rank, mtime, body, desc in SKILLS:
        skill(root, rel, name=name, desc=desc, body=body, mtime=mtime)
    return root


def verify(root: Path):
    """重读产物，断言结构、frontmatter 与 mtime 与清单一致。"""
    by_name = {}
    for name, rel, source, rank, mtime, body, desc in SKILLS:
        md = root / rel / "SKILL.md"
        assert md.is_file(), "missing %s" % md
        raw = md.read_text(encoding="utf-8")
        assert "name: %s\n" % name in raw, "name mismatch in %s" % md
        assert "description: %s\n" % desc in raw, "desc mismatch in %s" % md
        got_mtime = int(md.stat().st_mtime)
        assert got_mtime == mtime, "mtime mismatch in %s: %d != %d" % (md, got_mtime, mtime)
        by_name.setdefault(name, []).append((source, rank, rel))

    # 跨 rank 重名：shared-tool 恰好三份，落在三个不同 rank。
    shared = by_name["shared-tool"]
    assert {r for (_, r, _) in shared} == {100, 400, 500}, shared
    # 同 root 重名：dup-user 恰好两份，rank 相同（400）。
    dup = by_name["dup-user"]
    assert {r for (_, r, _) in dup} == {400} and len(dup) == 2, dup
    # 其余四个独有 skill 各在正确的源里。
    for name, (source, rank, rel) in {
        "proj-only": ("project-dsh", 100, "workdir/.dsh/skills/proj-only"),
        "proj-agents-only": ("project-agents", 200, "workdir/.agents/skills/proj-agents-only"),
        "user-only": ("user-dsh", 400, ".dsh/skills/user-only"),
        "agents-only": ("user-agents", 500, ".agents/skills/agents-only"),
    }.items():
        assert by_name[name] == [(source, rank, rel)], (name, by_name[name])
    print("self-verification passed")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--into", required=True)
    ap.add_argument("--clean", action="store_true", help="先删掉已存在的目标目录")
    args = ap.parse_args()

    # resolve() 很重要：macOS 上 /tmp 是 /private/tmp 的软链，而 classify()
    # 拿未 resolve 的 HOME_N 与 skill_dir.resolve() 做前缀比较，根路径没
    # resolve 的话层级会被误判成 unknown（与 generate.py 同一条教训）。
    root = Path(args.into).resolve()
    if args.clean and root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    build(root)
    verify(root)
    print("dsh 目录树已生成：%s" % root)


if __name__ == "__main__":
    main()
